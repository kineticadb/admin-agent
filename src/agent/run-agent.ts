/**
 * Agent loop orchestration for the Kinetica diagnostic agent.
 *
 * Responsibilities:
 * - Creates the in-process MCP server exposing all 22 tools (16 diagnostic + 4 mutation + save_report + alter_table_columns)
 * - Uses explicit allowedTools list for diagnostic tools (mutation tools excluded for approval gate)
 * - Wires canUseTool callback for defense-in-depth approval on non-allowed tools
 * - Starts a streaming query with the system prompt and async-iterable prompt
 * - Streams text deltas to stderr in real-time via includePartialMessages
 * - Handles SDKResultMessage (success or error) for session end
 * - Handles system init messages to warn about MCP server connection failures
 * - Handles compact_boundary events with token count from SDK metadata
 * - Handles rate_limit_event messages to warn on throttling or rejection
 * - Logs permission denials from the SDK result for operator visibility
 * - Registers a SIGINT handler that triggers graceful abort via AbortController
 * - Logs a session summary (with SDK-provided duration/API time) when the query completes
 *
 * Exports:
 *   MCP_SERVER_NAME    - constant "kinetica-diagnostics" (exported for testing)
 *   runAgent           - main entry point called from CLI
 */

import { query, createSdkMcpServer, AbortError } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKAPIRetryMessage,
  SDKAssistantMessageError,
  SDKCompactBoundaryMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { input } from "@inquirer/prompts";

import pc from "picocolors";

import { buildSystemPrompt } from "./system-prompt.js";
import { discoverCatalogSchemas } from "./discover-schemas.js";
import { loadPlaybooks } from "./load-playbooks.js";
import { loadReferences, loadBundleReferences } from "./load-references.js";
import { checkPromptBudget } from "./prompt-budget.js";
import { createBudgetTracker, fromSdkUsage, DEFAULT_MAX_BUDGET_USD } from "./session-budget.js";
import type { BudgetTracker } from "./session-budget.js";
import {
  makeDiagnosticTools,
  makeMutationTools,
  makeAlterTableColumnsToolWithDeps,
  DIAGNOSTIC_TOOL_NAMES,
  ALTER_TABLE_COLUMNS_TOOL_NAME,
} from "../tools/index.js";
import { makeSaveReportTool } from "../report/save-report.js";
import { buildBundleSystemPrompt } from "./bundle-system-prompt.js";
import { makeBundleTools, createBundleRegistry, BUNDLE_TOOL_NAMES } from "../tools/bundle/index.js";
import { createBundleHolder } from "../bundle/bundle-holder.js";
import { promptBundleDirectory } from "../cli/pick-bundle-path.js";
import type { BundleSource } from "../bundle/BundleSource.js";
import { createApprovalGate } from "../approval/gate.js";
import { createTurnGate } from "./turn-gate.js";
import type { TurnGate } from "./turn-gate.js";
import type { KineticaSession } from "../types/index.js";
import type { AuthResult } from "../auth/oauth-flow.js";
import { createStreamingTableAligner } from "../output/streaming-table-aligner.js";
import { createSpinner } from "../output/spinner.js";
import type { Spinner } from "../output/spinner.js";
import { hostManagerStatus, hostManagerAlerts } from "../tools/rest/host-manager.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** MCP server name used to prefix tool calls (exported for testing). */
export const MCP_SERVER_NAME = "kinetica-diagnostics";

/**
 * Fully-qualified name of the save_report tool. Detecting this tool call in the message
 * stream marks the end of an investigation (the system prompt mandates a save per issue),
 * which is the boundary at which the per-investigation summary is printed.
 */
const SAVE_REPORT_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__save_report`;

/**
 * True if an assistant message's content contains a tool_use block invoking save_report.
 * Takes the loosely-typed SDK content array as `unknown` so this stays a pure, testable
 * predicate decoupled from SDK types. Never throws — non-array or malformed content → false.
 */
export function contentCallsSaveReport(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (typeof block !== "object" || block === null) return false;
    const { type, name } = block as { type?: unknown; name?: unknown };
    return type === "tool_use" && name === SAVE_REPORT_TOOL_NAME;
  });
}

/**
 * Format the trailing " Cost: $Z." segment, or "" when there is nothing to show.
 * The segment is omitted when `costUsd` is undefined or zero — `undefined` suppresses the
 * dollar figure for OAuth/subscription users, mirroring the budget guard. Single source of
 * truth for the cost-format rule so the metrics line and the error-path summary can't drift.
 */
export function formatCostSuffix(costUsd?: number): string {
  return costUsd !== undefined && costUsd > 0 ? ` Cost: $${costUsd.toFixed(4)}.` : "";
}

/**
 * Format a one-line metrics summary: "Turns: N. Duration: Xs (Y% API). Cost: $Z.".
 * The Cost segment is omitted when `costUsd` is undefined or zero (see formatCostSuffix).
 * Shared by the per-investigation line and the session-end line so they can't drift.
 */
export function formatMetricsLine(
  turns: number,
  durationMs: number,
  durationApiMs: number,
  costUsd?: number,
): string {
  const durationSec = Math.round(durationMs / 1000);
  const apiPct = durationMs > 0 ? Math.round((durationApiMs / durationMs) * 100) : 0;
  return `Turns: ${turns}. Duration: ${durationSec}s (${apiPct}% API).${formatCostSuffix(costUsd)}`;
}

/** Commands that end the interactive session. */
const EXIT_COMMANDS = new Set(["exit", "quit", "end", "q"]);

/**
 * Agent model shorthands accepted by the SDK (SDK resolves to the latest version).
 * Exported so the CLI can validate `--model` input against the same source of truth
 * that `runAgent` consumes — no drift between parser and runtime.
 */
export const SUPPORTED_MODELS = ["sonnet", "haiku", "opus"] as const;
export type AgentModel = (typeof SUPPORTED_MODELS)[number];

/**
 * Default model when the operator does not override via CLI.
 * Exported so the CLI banner can display the same default without duplicating the string.
 */
export const DEFAULT_AGENT_MODEL: AgentModel = "sonnet";

/**
 * Anthropic authentication method, surfaced from the CLI so the agent can frame the
 * budget guard correctly: a dollar cap only means something when the user is billed
 * per token (api_key). OAuth (Pro/Max subscription) users are not, so we do not impose
 * a dollar cap on them — the turn limit is their guard.
 *
 * Derived from `AuthResult["method"]` (the auth domain owns the canonical set) so the CLI
 * can pass `authResult.method` straight through and a new auth method can't silently diverge.
 */
export type AuthMethod = AuthResult["method"];

/** Optional knobs passed from the CLI into runAgent. */
export type RunAgentOptions = {
  readonly authMethod?: AuthMethod;
  readonly maxBudgetUsd?: number;
  /**
   * Attach an extracted support bundle. Composable with a live `session`:
   * - with a session → live tools + bundle tools (correlate history vs. current state)
   * - without a session → bundle-only (read-only, offline)
   * The bundle's file-backed tools are added on top of whatever the session provides;
   * a bundle can also be attached later at runtime via the kinetica_load_bundle tool.
   */
  readonly bundleSource?: BundleSource;
};

/** Turn limits per mode. Bundle investigations are bounded (no mutation/verify rounds). */
const LIVE_MAX_TURNS = 100;
const BUNDLE_MAX_TURNS = 40;

/**
 * Explicit allow-list for diagnostic + report + self-approving tools.
 * Mutation tools are intentionally excluded so they fall through to the
 * canUseTool callback (approval gate) for user confirmation.
 *
 * alter_table_columns is in the allow-list because it implements its own
 * two-step approval: interactive checklist + SQL preview with y/n confirmation.
 *
 * IMPORTANT: Do NOT use a wildcard like `mcp__${MCP_SERVER_NAME}__*` here —
 * that would auto-approve mutation tools and bypass the approval gate entirely.
 */
export const ALLOWED_TOOL_NAMES = [
  ...DIAGNOSTIC_TOOL_NAMES.map((name) => `mcp__${MCP_SERVER_NAME}__${name}`),
  SAVE_REPORT_TOOL_NAME,
  `mcp__${MCP_SERVER_NAME}__${ALTER_TABLE_COLUMNS_TOOL_NAME}`,
];

/**
 * Allow-list for offline bundle mode: the 5 read-only bundle tools + save_report.
 * No mutation/diagnostic live tools — they aren't even constructed in bundle mode.
 */
export const BUNDLE_ALLOWED_TOOL_NAMES = [
  ...BUNDLE_TOOL_NAMES.map((name) => `mcp__${MCP_SERVER_NAME}__${name}`),
  SAVE_REPORT_TOOL_NAME,
];

/**
 * Explicit deny list — built-in tools the diagnostic agent should never use.
 * SDK docs: deny rules override everything including bypassPermissions.
 */
const DISALLOWED_TOOLS = ["Bash", "Edit", "Write", "MultiEdit"] as const;

/**
 * Human-readable labels for SDK assistant message error codes.
 * Used when the SDK signals an API error on an assistant message without throwing.
 */
const ERROR_LABELS: Readonly<Record<SDKAssistantMessageError, string>> = {
  authentication_failed: "Authentication failed — check your API key or re-run with --login",
  billing_error: "Billing error — check your Anthropic account",
  rate_limit: "Rate limit exceeded",
  server_error: "Anthropic API server error",
  invalid_request: "Invalid API request",
  max_output_tokens: "Response exceeded maximum output length",
  unknown: "Unknown API error",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the text is an exit command (exit, quit, end, q).
 * Case-insensitive, trims whitespace.
 */
export function isExitCommand(text: string): boolean {
  return EXIT_COMMANDS.has(text.trim().toLowerCase());
}

/**
 * Constructs an SDKUserMessage envelope from plain text content.
 *
 * Centralizes the boilerplate fields (`type`, `parent_tool_use_id`, `session_id`)
 * so the interactive prompt generator only needs to provide the user's text.
 */
export function makeUserMessage(content: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: "",
  };
}

/**
 * Interactive async generator that reads user input between agent turns.
 *
 * The SDK's query() pulls from this generator after each agent end_turn.
 * The TurnGate blocks subsequent prompts until the agent finishes its turn,
 * preventing the "You:" prompt from appearing twice in succession.
 *
 * First turn: prompts the user to describe the issue to investigate.
 * Subsequent turns: waits for gate, then prompts for follow-up responses.
 *
 * @param abortController - Abort controller for graceful shutdown
 * @param turnGate - Gate that blocks until the agent's turn completes
 * @param spinner - Activity spinner to start after each user submission
 */
export async function* makeInteractivePrompt(
  abortController: AbortController,
  turnGate: TurnGate,
  spinner: Spinner,
): AsyncGenerator<SDKUserMessage> {
  // First turn: collect the issue
  while (!abortController.signal.aborted) {
    try {
      process.stderr.write("\n");
      const issue = await input({ message: "Describe the issue to investigate:" });
      process.stderr.write("\n");
      const trimmed = issue.trim();
      if (!trimmed) continue;
      if (isExitCommand(trimmed)) return;
      spinner.start();
      yield makeUserMessage(trimmed);
      break;
    } catch {
      return;
    }
  }

  // Subsequent turns: block on gate until agent end_turn, then prompt user
  while (!abortController.signal.aborted) {
    try {
      await turnGate.wait();
      if (abortController.signal.aborted) break;
      process.stderr.write("\n");
      const response = await input({ message: "You:" });
      process.stderr.write("\n");
      const trimmed = response.trim();
      if (!trimmed) continue; // gate stays open, wait() resolves immediately
      if (isExitCommand(trimmed)) return;
      turnGate.close();
      spinner.start();
      yield makeUserMessage(trimmed);
    } catch {
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Degraded mode — auto-display host manager data at startup
// ---------------------------------------------------------------------------

/**
 * Fetches and displays host manager status and recent alerts in degraded mode.
 * Called once at startup when the DB engine (port 9191) is unreachable so the
 * operator immediately sees all available diagnostic data.
 *
 * Never throws — gracefully handles errors from either endpoint.
 */
export async function displayDegradedStatus(session: KineticaSession): Promise<void> {
  const [statusResult, alertsResult] = await Promise.all([
    hostManagerStatus(session),
    hostManagerAlerts(session),
  ]);

  // --- Host Manager Status ---
  process.stderr.write(pc.bold("── Host Manager Status ──────────────────────────────────\n"));
  if (statusResult.ok) {
    const rows = statusResult.data as ReadonlyArray<{ key: string; value: string | number }>;
    const maxKeyLen = rows.reduce((max, r) => Math.max(max, r.key.length), 0);
    for (const row of rows) {
      process.stderr.write(`  ${pc.dim(row.key.padEnd(maxKeyLen))}  ${row.value}\n`);
    }
  } else {
    process.stderr.write(`  ${pc.red(`Error: ${statusResult.error}`)}\n`);
  }
  process.stderr.write("\n");

  // --- Recent Alerts ---
  process.stderr.write(pc.bold("── Recent Alerts ───────────────────────────────────────\n"));
  if (alertsResult.ok) {
    const alerts = alertsResult.data;
    if (alerts.length === 0) {
      process.stderr.write(`  ${pc.dim("No recent alerts.")}\n`);
    } else {
      for (const alert of alerts) {
        process.stderr.write(`  ${pc.dim(alert.timestamp)}  ${alert.type}  ${alert.params}\n`);
      }
    }
  } else {
    process.stderr.write(`  ${pc.dim(`Unavailable: ${alertsResult.error}`)}\n`);
  }
  process.stderr.write("\n");
}

// ---------------------------------------------------------------------------
// Main agent loop
// ---------------------------------------------------------------------------

/**
 * Runs the full Kinetica diagnostic agent session.
 *
 * Creates an in-process MCP server with all 22 tools (16 diagnostic + 4 mutation + save_report + alter_table_columns),
 * then starts a streaming query. The system prompt instructs the agent to:
 * 1. Investigate the user's reported issue using a 5-round protocol
 * 2. Propose mutations (with user approval) when evidence supports remediation
 * 3. Verify post-mutation changes
 * 4. Generate and save a diagnostic report
 * 5. Ask whether to investigate another issue or end the session
 *
 * The function returns when the agent session ends (either by user request
 * or by SIGINT triggering the abort controller).
 *
 * @param session - The authenticated Kinetica session
 * @param kineticaVersion - Optional version string detected during connectivity check
 * @param degraded - When true, DB engine is unreachable; skip schema discovery, use degraded prompt
 * @param model - Optional agent model override
 * @param options - Optional auth method + resolved budget from the CLI. A single
 *   trailing options object keeps the signature stable for the many existing
 *   `runAgent(session)` call sites (notably the test suite).
 */
export async function runAgent(
  session: KineticaSession | undefined,
  kineticaVersion?: string,
  degraded?: boolean,
  model?: AgentModel,
  runOptions?: RunAgentOptions,
): Promise<void> {
  // Offline bundle mode swaps the data source: file-backed tools, bundle prompt,
  // read-only by construction. `session` is ignored when a bundle source is given.
  const bundleSource = runOptions?.bundleSource;
  // Frame the budget guard by how the user is billed. A dollar cap is only meaningful
  // for per-token (api_key) billing; OAuth subscription users rely on the turn limit.
  const authMethod: AuthMethod = runOptions?.authMethod ?? "api_key";
  // Single source of truth for "this billing model has a real dollar cap" — used to gate
  // the SDK cap, the startup line, and the running-cost warning so they can't drift apart.
  const dollarCapped = authMethod === "api_key";
  // The CLI always passes a fully-resolved budget; this `??` only defaults for non-CLI
  // callers (e.g. tests), mirroring how `model` re-defaults in cli/index.ts so the two never drift.
  const resolvedBudgetUsd = runOptions?.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD;
  // Pre-flight: discover schemas, load playbooks, and load references in parallel (all independent)
  // In degraded mode, schema discovery is skipped (requires DB engine on port 9191)
  // Schema discovery needs the live DB engine — skipped in degraded and bundle modes.
  // Bundle-scoped references (log-line format, severity ordering, file catalog) load
  // UNCONDITIONALLY: the bundle tools are always registered (a bundle can be attached
  // mid-session via kinetica_load_bundle) and the system prompt is built once, so even a
  // pure live session needs this knowledge ready — otherwise a late attach drives the
  // bundle tools blind (e.g. unaware that min_severity=ERROR silently drops UERR lines).
  // The corpus is cached by the SDK, so the cost to a never-attaches session is ~nil.
  const [catalogSchemas, playbooks, references, bundleReferences] = await Promise.all([
    degraded || !session ? Promise.resolve(undefined) : discoverCatalogSchemas(session),
    loadPlaybooks(),
    loadReferences(),
    loadBundleReferences(),
  ]);

  // Bundle tools bind to a holder (lazy ref) so a live session can attach a bundle
  // mid-conversation via kinetica_load_bundle. Seeded with the startup bundle, if any.
  const bundleHolder = createBundleHolder(bundleSource);

  // Capabilities, not modes: a session may have a live connection, an attached
  // bundle, or both. Prompt selection follows what's present.
  // - Live (with or without a bundle): full prompt + a Support Bundle Capability section.
  // - Bundle-only (no live connection — e.g. cluster down): the dedicated read-only prompt.
  const systemPrompt = session
    ? buildSystemPrompt(
        kineticaVersion,
        catalogSchemas,
        playbooks,
        references,
        degraded,
        bundleHolder.isLoaded() ? "attached" : "available",
        bundleReferences,
      )
    : buildBundleSystemPrompt(kineticaVersion, playbooks, references, bundleReferences);

  // Token-budget tripwire: the whole knowledge corpus is front-loaded into the
  // system prompt, so its cost grows with the corpus. Surface the size (DEBUG only)
  // and warn unconditionally if it crosses the threshold — a cue to add keyword-based
  // playbook selection before the prompt gets expensive.
  const budget = checkPromptBudget(systemPrompt);
  if (process.env.DEBUG) {
    process.stderr.write(
      pc.dim(`System prompt: ~${budget.tokens} tokens (${budget.chars} chars)\n`),
    );
  }
  if (budget.overBudget) {
    process.stderr.write(
      pc.yellow(
        `⚠ system prompt is ~${budget.tokens} tokens (threshold ${budget.threshold}) — ` +
          `knowledge corpus is getting expensive; consider keyword-based playbook selection.\n`,
      ),
    );
  }

  // The save_report tool is available in every session.
  const saveReportTool = makeSaveReportTool();

  if (!session && !bundleSource) {
    throw new Error("runAgent requires a Kinetica session, a bundleSource, or both.");
  }

  // Activity spinner — signals the agent is working between user input and first
  // response. Created before the tools so the bundle directory picker can pause it.
  const spinner = createSpinner();

  // Directory picker for kinetica_load_bundle when the agent attaches a bundle
  // without a path: pause the spinner so the interactive prompt renders cleanly.
  const promptForPath = async (): Promise<string | undefined> => {
    spinner.stop();
    return promptBundleDirectory();
  };

  // Operator confirmation when the MODEL supplies an explicit bundle path: loading
  // indexes that directory and lets the bundle tools read files under it, so the
  // operator must consent to the specific path. A path the operator chose via the
  // picker (no model path) needs no second confirmation. Deny on any prompt failure
  // (e.g. non-interactive terminal) so an unconfirmed model path is never loaded.
  const confirmPath = async (path: string): Promise<boolean> => {
    spinner.stop();
    try {
      const answer = await input({
        message: `Load support bundle from "${path}"? The agent will be able to read files under that directory. (y/n):`,
      });
      return answer.trim().toLowerCase() === "y";
    } catch {
      return false;
    }
  };

  // Bundle tools are ALWAYS registered (bound to the holder) so a bundle can be
  // attached mid-session. Live tools are added only when a connection exists.
  // Read-only BY CONSTRUCTION: mutation tools are created only in a live session,
  // and never in a bundle-only one.
  const bundleTools = makeBundleTools(bundleHolder, { promptForPath, confirmPath });
  const liveTools = session
    ? [
        ...makeDiagnosticTools(session, catalogSchemas),
        ...makeMutationTools(session),
        makeAlterTableColumnsToolWithDeps(session),
      ]
    : [];
  const serverTools = [...liveTools, ...bundleTools, saveReportTool];

  // Allow-list = union (deduped — save_report appears in both base lists). Live
  // mutation tools are intentionally absent so they hit the approval gate.
  const allowedTools = [
    ...new Set([...(session ? ALLOWED_TOOL_NAMES : []), ...BUNDLE_ALLOWED_TOOL_NAMES]),
  ];

  // Approval registry: every read-only tool that should bypass the gate. Bundle
  // tools are all read-only; diagnostic tools too (only when a live session exists).
  let registry = createBundleRegistry();
  if (session) {
    registry = DIAGNOSTIC_TOOL_NAMES.reduce(
      (reg, name) => reg.registerReadOnlyTool(name),
      registry,
    );
  }

  // Live investigations can be long (diagnose + mutate + verify); bundle-only is bounded.
  const maxTurns = session ? LIVE_MAX_TURNS : BUNDLE_MAX_TURNS;

  // Create the in-process MCP server with the composed tool set.
  const server = createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "1.0.0",
    tools: serverTools,
  });

  // Defense-in-depth: wire canUseTool callback for any tool NOT matched by wildcard.
  // Wrap the approval gate to stop the spinner before showing interactive prompts.
  // `registry` is the mode's read-only registry (diagnostic or bundle).
  const approvalGate = createApprovalGate(registry.isReadOnlyTool);
  const canUseTool: typeof approvalGate = async (toolName, toolInput, options) => {
    spinner.stop();
    return approvalGate(toolName, toolInput, options);
  };

  // Abort controller for graceful SIGINT handling
  const abortController = new AbortController();

  // Resolve the effective model once so both the query options and the welcome
  // message print the exact same value — no drift between what the SDK receives
  // and what the operator sees.
  const effectiveModel: AgentModel = model ?? DEFAULT_AGENT_MODEL;

  // Build query options
  const options = {
    mcpServers: { [MCP_SERVER_NAME]: server },
    allowedTools,
    disallowedTools: [...DISALLOWED_TOOLS],
    canUseTool,
    systemPrompt,
    model: effectiveModel,
    fallbackModel: "haiku" as const,
    thinking: { type: "adaptive" as const },
    maxTurns,
    // Only impose a dollar cap for per-token billing. For OAuth subscription users
    // the SDK would otherwise cut them off at a notional dollar figure they never pay;
    // omitting it leaves the turn limit (maxTurns) as their guard.
    ...(dollarCapped ? { maxBudgetUsd: resolvedBudgetUsd } : {}),
    persistSession: false,
    includePartialMessages: true,
    abortController,
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "admin-agent" },
  };

  // Budget guard line — make the safety rail visible up front so hitting it is never
  // a surprise. Framed by billing model: a dollar amount for api_key, a turn-limit note
  // for OAuth subscription users (where dollars are meaningless).
  const guardLine = dollarCapped
    ? pc.dim(`Budget guard: $${resolvedBudgetUsd.toFixed(2)} (raise with --max-budget)\n`)
    : pc.dim("Budget guard: subscription (Pro/Max) — turn-limited\n");

  // Welcome message — printed once before the interactive loop begins.
  // Model identity lives in the startup banner (see src/cli/banner.ts) so it's
  // not repeated here.
  // Summarize an attached bundle for the welcome line.
  const bundleSummary = (): string => {
    const src = bundleHolder.get();
    if (!src) return "";
    const { totalFiles, ranks } = src.inventory();
    const versionStr = kineticaVersion ? ` (version ${kineticaVersion})` : "";
    return `${totalFiles} files, ranks: ${ranks.join(", ") || "none"}${versionStr}`;
  };

  if (session) {
    // A live connection exists (full or degraded), optionally with a bundle attached.
    if (degraded) {
      process.stderr.write("\nKinetica Diagnostic Session Ready (DEGRADED MODE)\n");
      process.stderr.write(
        "DB engine (port 9191) is unreachable. Only host manager tools are available.\n\n",
      );
      await displayDegradedStatus(session);
    } else {
      process.stderr.write("\nKinetica Diagnostic Session Ready\n");
    }
    if (bundleHolder.isLoaded()) {
      process.stderr.write(
        `Support bundle attached: ${bundleSummary()}. Live + bundle tools available.\n`,
      );
    } else {
      process.stderr.write(
        pc.dim("Tip: ask me to analyze a support bundle to add offline log/config analysis.\n"),
      );
    }
  } else {
    // Bundle-only: no live connection (e.g. the cluster is down).
    process.stderr.write("\nKinetica Diagnostic Session Ready (OFFLINE BUNDLE MODE)\n");
    process.stderr.write(`Analyzing extracted support bundle: ${bundleSummary()}.\n`);
    process.stderr.write(
      "Read-only — diagnoses from captured logs/config; live verification unavailable (no DB connection).\n",
    );
  }
  process.stderr.write(guardLine);
  process.stderr.write("Type 'exit' to end the session.\n\n");

  // Turn gate — blocks the prompt generator until the agent finishes its turn
  const turnGate = createTurnGate();

  // Run the query with the interactive prompt generator
  const agentQuery = query({
    prompt: makeInteractivePrompt(abortController, turnGate, spinner),
    options,
  });

  // Register SIGINT handler AFTER query creation so we can call close()
  process.once("SIGINT", () => {
    spinner.stop();
    process.stderr.write("\nInterrupted — aborting investigation...\n");
    abortController.abort();
    agentQuery.close();
  });

  let numTurns = 0;
  let totalCostUsd = 0;
  let durationMs = 0;
  let durationApiMs = 0;
  // Cache-token telemetry — confirms the SDK is reusing the static system prompt across
  // turns rather than re-billing the full knowledge corpus each turn.
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let lastStreamCharWasNewline = true;

  // Line-buffering adapter: buffers markdown table blocks for alignment,
  // passes non-table content through line-by-line with minimal latency.
  const tableAligner = createStreamingTableAligner();

  let hadNonAbortError = false;

  // Per-investigation summary state. The SDK's result metrics are CUMULATIVE from session
  // start, so we snapshot them at each investigation boundary and print the delta. An
  // investigation boundary = a run in which the agent called save_report (the system prompt
  // mandates that at the end of each investigation), detected via `reportSavedThisRun`.
  // The four cumulative metrics travel together, so a single snapshot object (replaced
  // wholesale at each boundary) keeps them in lockstep and adding a 5th metric is one edit.
  let reportSavedThisRun = false;
  let invBase = { turns: 0, duration: 0, api: 0, cost: 0 };

  // Running-cost tripwire (api_key only). The SDK enforces the true cap via maxBudgetUsd;
  // this estimates spend from per-turn token usage so we can warn the operator *before*
  // the hard cutoff. Deliberately absent for OAuth — there is no dollar spend to warn about.
  const budgetTracker: BudgetTracker | undefined = dollarCapped
    ? createBudgetTracker({ maxUsd: resolvedBudgetUsd })
    : undefined;

  try {
    for await (const message of agentQuery as AsyncIterable<SDKMessage>) {
      if (message.type === "stream_event") {
        // Real-time streaming: write text deltas to stderr as they arrive.
        // Thinking deltas (type "thinking_delta") are naturally excluded.
        // SDK event union types are narrowed at runtime but too loose for ESLint to prove safe.
        /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
        const { event: evt } = message;
        if (evt.type === "content_block_delta" && evt.delta.type === "text_delta") {
          const text = evt.delta.text ?? "";
          if (text) {
            spinner.stop();
            const output = tableAligner.push(text);
            if (output) {
              process.stderr.write(output);
              lastStreamCharWasNewline = output.endsWith("\n");
            }
          }
        }
        /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
      } else if (message.type === "assistant") {
        const assistantMsg = message;
        // Flush any buffered table lines or partial line from the aligner
        const remaining = tableAligner.flush();
        if (remaining) {
          process.stderr.write(remaining);
          lastStreamCharWasNewline = remaining.endsWith("\n");
        }
        // Text was already streamed via stream_event — just ensure trailing newline
        if (!lastStreamCharWasNewline) {
          process.stderr.write("\n");
          lastStreamCharWasNewline = true;
        }
        // Running-cost estimate: accumulate this turn's usage (fromSdkUsage normalizes the
        // SDK's snake_case shape) and warn once at ~80% of the cap.
        if (budgetTracker) {
          /* eslint-disable-next-line @typescript-eslint/no-unsafe-member-access */
          budgetTracker.add(fromSdkUsage(assistantMsg.message.usage), effectiveModel);
          if (budgetTracker.shouldWarn()) {
            spinner.stop();
            process.stderr.write(
              pc.yellow(
                `\n⚠ Approaching budget guard (~$${budgetTracker.spentUsd().toFixed(2)} / ` +
                  `$${resolvedBudgetUsd.toFixed(2)}) — wrapping up soon. ` +
                  `Save a partial report now if you want to preserve findings.\n`,
              ),
            );
            budgetTracker.markWarned();
          }
        }
        // Investigation boundary: note when the agent saves a report this run, so the
        // matching result message can print a per-investigation summary.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (contentCallsSaveReport(assistantMsg.message.content)) {
          reportSavedThisRun = true;
        }
        // Signal the generator to prompt the user after the agent finishes.
        // Only on end_turn — NOT tool_use (agent continues after tool calls).
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (assistantMsg.message.stop_reason === "end_turn") {
          spinner.stop();
          turnGate.open();
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        } else if (assistantMsg.message.stop_reason === "tool_use") {
          // Agent is calling tools — restart spinner for the execution gap
          spinner.start("Investigating");
        } else {
          // Unexpected stop reason (max_tokens, etc.) — stop spinner defensively.
          // Don't open the gate: the SDK may continue internally with a follow-up
          // assistant message, or a result message will open the gate.
          spinner.stop();
        }
        // SDK may signal an API error on the assistant message without throwing.
        if (assistantMsg.error) {
          spinner.stop();
          const label = ERROR_LABELS[assistantMsg.error] ?? assistantMsg.error;
          process.stderr.write(pc.yellow(`\nAPI error: ${label}\n`));
          turnGate.open();
        }
      } else if (message.type === "result") {
        spinner.stop();
        const resultMsg = message;
        numTurns = resultMsg.num_turns;
        totalCostUsd = resultMsg.total_cost_usd;
        durationMs = resultMsg.duration_ms;
        durationApiMs = resultMsg.duration_api_ms;

        // Sum cache tokens from per-model usage. Deliberately NOT the top-level
        // resultMsg.usage: its BetaUsage-derived fields resolve to `any` here (tripping
        // no-unsafe-assignment), whereas ModelUsage declares these as concrete `number`,
        // keeping this read type-safe. A non-zero cacheReadTokens proves the system prompt
        // is served from cache. Guard the field: it crosses a process boundary, so
        // telemetry must never break the session.
        const usages = Object.values(resultMsg.modelUsage ?? {});
        cacheReadTokens = usages.reduce((sum, u) => sum + (u.cacheReadInputTokens ?? 0), 0);
        cacheCreationTokens = usages.reduce((sum, u) => sum + (u.cacheCreationInputTokens ?? 0), 0);

        if (resultMsg.subtype === "error_max_turns") {
          process.stderr.write(
            pc.yellow(
              `\nReached the turn limit (${numTurns} turns) — a safety guard, not an error. ` +
                `Any report the agent saved is in reports/. Start a fresh session to continue.\n`,
            ),
          );
        } else if (resultMsg.subtype === "error_max_budget_usd") {
          const spentStr = totalCostUsd > 0 ? ` ($${totalCostUsd.toFixed(2)} spent)` : "";
          process.stderr.write(
            pc.yellow(
              `\nReached the $${resolvedBudgetUsd.toFixed(2)} budget guard${spentStr} — ` +
                `a safety limit, not an error. Re-run with --max-budget=<amount> ` +
                `(or set ADMIN_AGENT_MAX_BUDGET) for more headroom. ` +
                `Any report the agent saved is in reports/.\n`,
            ),
          );
        } else if (resultMsg.subtype === "error_during_execution") {
          process.stderr.write(
            "\nExecution error — the agent encountered an unrecoverable failure.\n",
          );
        } else if (resultMsg.subtype !== "success") {
          process.stderr.write(`\nAgent session ended with error: ${resultMsg.subtype}\n`);
        }

        // Log permission denials so operator knows which tools were blocked
        if (resultMsg.permission_denials.length > 0) {
          const denied = resultMsg.permission_denials.map((d) => d.tool_name).join(", ");
          process.stderr.write(`\nPermission denials: ${denied}\n`);
        }

        // Per-investigation summary: if the agent saved a report this run, print the delta
        // since the previous investigation. SDK metrics are cumulative from session start,
        // so we subtract the snapshot taken at the last boundary. Cost is shown only when
        // the user is dollar-billed (api_key), mirroring the budget guard.
        if (reportSavedThisRun) {
          const line = formatMetricsLine(
            numTurns - invBase.turns,
            durationMs - invBase.duration,
            durationApiMs - invBase.api,
            dollarCapped ? totalCostUsd - invBase.cost : undefined,
          );
          process.stderr.write(`\nInvestigation complete — ${line}\n`);
          invBase = {
            turns: numTurns,
            duration: durationMs,
            api: durationApiMs,
            cost: totalCostUsd,
          };
          reportSavedThisRun = false;
        }

        // Unblock generator so it can exit cleanly
        turnGate.open();
      } else if (message.type === "system") {
        const sysMsg = message as SDKSystemMessage | { subtype: string };
        if (sysMsg.subtype === "init") {
          // Check for MCP server connection failures and warn on stderr
          const initMsg = message as SDKSystemMessage;
          const failed = (initMsg.mcp_servers ?? []).filter(
            (s) => s.name === MCP_SERVER_NAME && s.status !== "connected",
          );
          for (const s of failed) {
            process.stderr.write(
              `\nWarning: MCP server "${s.name}" failed to connect (${s.status})\n`,
            );
          }
        } else if (sysMsg.subtype === "api_retry") {
          // SDK is retrying an API request after a transient failure — surface to operator
          const retryMsg = message as SDKAPIRetryMessage;
          const statusStr =
            retryMsg.error_status !== null ? ` (HTTP ${retryMsg.error_status})` : "";
          const delaySec = Math.round(retryMsg.retry_delay_ms / 1000);
          process.stderr.write(
            pc.yellow(
              `\nAPI error${statusStr}. Retrying (attempt ${retryMsg.attempt}/${retryMsg.max_retries}) in ${delaySec}s...\n`,
            ),
          );
        } else if (sysMsg.subtype === "compact_boundary") {
          // SDK compressed conversation history — log token count for diagnostics
          const compactMsg = message as SDKCompactBoundaryMessage;
          const preTokens = compactMsg.compact_metadata.pre_tokens;
          process.stderr.write(
            `\n[Context compressed (${preTokens} tokens before compaction) — investigation continues]\n`,
          );
        }
      } else if (message.type === "rate_limit_event") {
        // Surface rate limit warnings so the operator knows the investigation may slow
        const rateMsg = message;
        const { status, resetsAt } = rateMsg.rate_limit_info;
        if (status === "rejected") {
          const resetStr = resetsAt ? ` Resets at ${new Date(resetsAt * 1000).toISOString()}.` : "";
          process.stderr.write(`\nRate limited — requests rejected.${resetStr}\n`);
        } else if (status === "allowed_warning") {
          process.stderr.write("\nApproaching rate limit — investigation may slow.\n");
        }
      } else if ((message as { type: string }).type === "control_request") {
        // SDK may send control requests for mid-session re-authentication.
        // control_request is part of StdoutMessage but not SDKMessage — widen the type check.
        // The Query object handles the control protocol internally — log for observability.
        const controlMsg = message as unknown as { request: { subtype: string } };
        if (controlMsg.request.subtype === "claude_authenticate") {
          process.stderr.write(pc.yellow("\nRe-authentication requested by SDK...\n"));
        }
      }
    }
  } catch (error: unknown) {
    spinner.stop();
    // AbortError is expected when the user presses Ctrl+C — suppress it
    if (error instanceof AbortError) {
      hadNonAbortError = false;
    } else {
      hadNonAbortError = true;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(pc.red(`\nAgent error: ${message}\n`));
    }
  } finally {
    // Safety net: stop the spinner on ANY exit path (normal, error, abort).
    // Idempotent — no-op if the spinner was already stopped earlier.
    spinner.stop();

    // No-op if the assistant branch already flushed; safety net for throw paths
    const remaining = tableAligner.flush();
    if (remaining) {
      process.stderr.write(remaining);
    }

    // Safety net for throw/abort paths where no result message was received
    turnGate.open();

    // Session summary — cumulative metrics from SDK (more precise than a manual timer).
    // Cost is gated on dollar billing, mirroring the per-investigation line and budget guard.
    const sessionCost = dollarCapped ? totalCostUsd : undefined;
    // Verify the static system prompt is cached: cacheReadTokens > 0 means it was reused
    // across turns (re-read at ~10% input cost) instead of re-billed in full each turn.
    if (process.env.DEBUG && (cacheReadTokens > 0 || cacheCreationTokens > 0)) {
      process.stderr.write(
        pc.dim(
          `Cache: ${cacheReadTokens} read / ${cacheCreationTokens} created input tokens` +
            ` (read > 0 confirms the system prompt is served from cache)\n`,
        ),
      );
    }
    if (hadNonAbortError) {
      process.stderr.write(
        `\nSession ended due to error. Turns: ${numTurns}.${formatCostSuffix(sessionCost)}\n`,
      );
    } else {
      const line = formatMetricsLine(numTurns, durationMs, durationApiMs, sessionCost);
      process.stderr.write(`\nSession ended. ${line}\n`);
    }
  }
}
