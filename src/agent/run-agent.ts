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
import { loadReferences } from "./load-references.js";
import { checkPromptBudget } from "./prompt-budget.js";
import {
  makeDiagnosticTools,
  createDiagnosticRegistry,
  makeMutationTools,
  makeAlterTableColumnsToolWithDeps,
  DIAGNOSTIC_TOOL_NAMES,
  ALTER_TABLE_COLUMNS_TOOL_NAME,
} from "../tools/index.js";
import { makeSaveReportTool } from "../report/save-report.js";
import { createApprovalGate } from "../approval/gate.js";
import { createTurnGate } from "./turn-gate.js";
import type { TurnGate } from "./turn-gate.js";
import type { KineticaSession } from "../types/index.js";
import { createStreamingTableAligner } from "../output/streaming-table-aligner.js";
import { createSpinner } from "../output/spinner.js";
import type { Spinner } from "../output/spinner.js";
import { hostManagerStatus, hostManagerAlerts } from "../tools/rest/host-manager.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** MCP server name used to prefix tool calls (exported for testing). */
export const MCP_SERVER_NAME = "kinetica-diagnostics";

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

/** Default maximum budget in USD per session. */
const DEFAULT_MAX_BUDGET_USD = 5.0;

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
  `mcp__${MCP_SERVER_NAME}__save_report`,
  `mcp__${MCP_SERVER_NAME}__${ALTER_TABLE_COLUMNS_TOOL_NAME}`,
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
 */
export async function runAgent(
  session: KineticaSession,
  kineticaVersion?: string,
  degraded?: boolean,
  model?: AgentModel,
): Promise<void> {
  // Pre-flight: discover schemas, load playbooks, and load references in parallel (all independent)
  // In degraded mode, schema discovery is skipped (requires DB engine on port 9191)
  const [catalogSchemas, playbooks, references] = await Promise.all([
    degraded ? Promise.resolve(undefined) : discoverCatalogSchemas(session),
    loadPlaybooks(),
    loadReferences(),
  ]);

  // Build system prompt with Kinetica domain knowledge, discovered schemas, playbooks, and references
  const systemPrompt = buildSystemPrompt(
    kineticaVersion,
    catalogSchemas,
    playbooks,
    references,
    degraded,
  );

  // Token-budget tripwire: the whole knowledge corpus is front-loaded into the
  // system prompt, so its cost grows with the corpus. Surface the size (DEBUG only)
  // and warn unconditionally if it crosses the threshold — a cue to add keyword-based
  // playbook selection before the prompt gets expensive. See IMPROVEMENTS.md item 1.
  const budget = checkPromptBudget(systemPrompt);
  if (process.env.DEBUG) {
    process.stderr.write(
      pc.dim(`system prompt: ~${budget.tokens} tokens (${budget.chars} chars)\n`),
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

  // Create all diagnostic tools bound to the current session
  const diagnosticTools = makeDiagnosticTools(session, catalogSchemas);

  // Create mutation tools bound to the current session
  const mutationTools = makeMutationTools(session);

  // Create the save_report tool
  const saveReportTool = makeSaveReportTool();

  // Create the alter_table_columns batch tool (self-approving via checklist)
  const alterTableColumnsTool = makeAlterTableColumnsToolWithDeps(session);

  // Create the in-process MCP server with all 22 tools
  // (16 diagnostic + 4 mutation + save_report + alter_table_columns)
  const server = createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [...diagnosticTools, ...mutationTools, saveReportTool, alterTableColumnsTool],
  });

  // Activity spinner — signals the agent is working between user input and first response
  const spinner = createSpinner();

  // Defense-in-depth: wire canUseTool callback for any tool NOT matched by wildcard.
  // Wrap the approval gate to stop the spinner before showing interactive prompts.
  const registry = createDiagnosticRegistry();
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
    allowedTools: ALLOWED_TOOL_NAMES,
    disallowedTools: [...DISALLOWED_TOOLS],
    canUseTool,
    systemPrompt,
    model: effectiveModel,
    fallbackModel: "haiku" as const,
    thinking: { type: "adaptive" as const },
    maxTurns: 100,
    maxBudgetUsd: DEFAULT_MAX_BUDGET_USD,
    persistSession: false,
    includePartialMessages: true,
    abortController,
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "admin-agent" },
  };

  // Welcome message — printed once before the interactive loop begins.
  // Model identity lives in the startup banner (see src/cli/banner.ts) so it's
  // not repeated here.
  if (degraded) {
    process.stderr.write("\nKinetica Diagnostic Session Ready (DEGRADED MODE)\n");
    process.stderr.write(
      "DB engine (port 9191) is unreachable. Only host manager tools are available.\n\n",
    );
    await displayDegradedStatus(session);
    process.stderr.write("Type 'exit' to end the session.\n\n");
  } else {
    process.stderr.write("\nKinetica Diagnostic Session Ready\n");
    process.stderr.write("Type 'exit' to end the session.\n\n");
  }

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
  let lastStreamCharWasNewline = true;

  // Line-buffering adapter: buffers markdown table blocks for alignment,
  // passes non-table content through line-by-line with minimal latency.
  const tableAligner = createStreamingTableAligner();

  let hadNonAbortError = false;

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

        if (resultMsg.subtype === "error_max_turns") {
          process.stderr.write(
            "\nInvestigation hit turn limit. Partial report may be available.\n",
          );
        } else if (resultMsg.subtype === "error_max_budget_usd") {
          process.stderr.write("\nBudget limit reached.\n");
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

    // Session summary — durations from SDK (more precise than manual timer)
    const durationSec = Math.round(durationMs / 1000);
    const apiPct = durationMs > 0 ? Math.round((durationApiMs / durationMs) * 100) : 0;
    const costStr = totalCostUsd > 0 ? ` Cost: $${totalCostUsd.toFixed(4)}.` : "";
    if (hadNonAbortError) {
      process.stderr.write(`\nSession ended due to error. Turns: ${numTurns}.${costStr}\n`);
    } else {
      process.stderr.write(
        `\nSession ended. Turns: ${numTurns}. Duration: ${durationSec}s (${apiPct}% API).${costStr}\n`,
      );
    }
  }
}
