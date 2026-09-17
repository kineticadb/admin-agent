/**
 * Runs the agent end-to-end against a mocked Kinetica session and asserts
 * the model's report conforms to knowledge/templates/report.md. Unit tests
 * cover the inputs (prompt, template); this covers the output. Cost per run
 * is typically under $0.10.
 *
 * Exit codes: 0 pass, 1 assertion failed, 2 harness failure.
 */

import { query, createSdkMcpServer, AbortError } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

import { buildSystemPrompt } from "../agent/system-prompt.js";
import { loadPlaybooks } from "../agent/load-playbooks.js";
import { loadReferences } from "../agent/load-references.js";
import { MCP_SERVER_NAME } from "../agent/run-agent.js";
import {
  makeDiagnosticTools,
  makeMutationTools,
  makeAlterTableColumnsToolWithDeps,
} from "../tools/index.js";
import { createMockSession } from "./mock-session.js";
import { makeCapturingSaveReportTool } from "./capturing-save-report.js";
import { makeConfirmSaveReportTool } from "../report/confirm-save-report.js";
import { createSaveConsent } from "../report/save-consent.js";
import { makeKnowledgeTools } from "../tools/knowledge/index.js";
import { createKnowledgeStore } from "../knowledge/KnowledgeStore.js";
import { validateReportStructure } from "./report-assertions.js";
import { scriptedOperator, SAVE_REPLIES } from "./scripted-operator.js";
import { createTurnGate } from "../agent/turn-gate.js";
import { consumeTranscript, diagnoseEmptyRun } from "./transcript.js";
import { preserveRunArtifact, type EvalRunMeta } from "./dump-report.js";

const ISSUE =
  "Run a quick health sanity check of the cluster and produce a baseline report. The system appears to be operating normally — I just want a routine snapshot.";

const autoAllow: CanUseTool = (_toolName, toolInput, options): Promise<PermissionResult> =>
  Promise.resolve({
    behavior: "allow",
    updatedInput: toolInput,
    toolUseID: options.toolUseID,
  });

async function runEval(): Promise<number> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ERROR: ANTHROPIC_API_KEY not set. Evals require API access.\n" +
        "Export ANTHROPIC_API_KEY or run `npm run dev -- --login` first.",
    );
    return 2;
  }

  const session = createMockSession();
  const [playbooks, references] = await Promise.all([loadPlaybooks(), loadReferences()]);
  const systemPrompt = buildSystemPrompt("7.2.3.11 (eval-mock)", undefined, playbooks, references);

  // The prompt advertises kinetica_knowledge_read, so the eval server must expose it —
  // otherwise the eval measures a prompt whose Knowledge Library points at nothing.
  const knowledgeStore = createKnowledgeStore([...playbooks, ...references]);

  const capture = makeCapturingSaveReportTool();
  const diagnosticTools = makeDiagnosticTools(session, undefined);
  const mutationTools = makeMutationTools(session);
  const alterTableColumnsTool = makeAlterTableColumnsToolWithDeps(session);

  const server = createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [
      ...diagnosticTools,
      ...mutationTools,
      ...makeKnowledgeTools(knowledgeStore),
      // The prompt tells the agent to ask via confirm_save_report, so the eval server
      // must expose it — otherwise the instruction points at nothing and the run
      // measures a protocol the model cannot follow. Real tool, scripted operator:
      // consent is granted without a TTY, the same way a non-interactive run does it.
      makeConfirmSaveReportTool({
        consent: createSaveConsent(),
        confirm: () => Promise.resolve(true),
      }),
      capture.tool,
      alterTableColumnsTool,
    ],
  });

  const abortController = new AbortController();
  // Same primitive prod uses: the output loop opens it on end_turn, the operator
  // generator awaits it. Without an operator the save question is never answered.
  const turnGate = createTurnGate();

  const agentQuery = query({
    prompt: scriptedOperator(
      ISSUE,
      SAVE_REPLIES,
      turnGate,
      () => capture.getCapture() !== undefined,
    ),
    options: {
      mcpServers: { [MCP_SERVER_NAME]: server },
      // No allowedTools: `autoAllow` below already approves everything, so listing
      // them would only duplicate the decision — and a bare entry auto-approves
      // inside the SDK before the callback runs (CLAUDE_SDK_CAN_USE_TOOL_SHADOWED),
      // which is exactly the shadowing prod now avoids. Routing through the callback
      // keeps the eval's permission path the same shape as production's.
      disallowedTools: ["Bash", "Edit", "Write", "MultiEdit"],
      canUseTool: autoAllow,
      systemPrompt,
      model: "sonnet" as const,
      fallbackModel: "haiku" as const,
      thinking: { type: "adaptive" as const },
      // 50, not 30: a measured investigation took 29 turns before even reaching the
      // save question, so 30 left no room for the operator exchange that follows it.
      // maxBudgetUsd below is the real cost guard (that run billed $0.26 against $2).
      maxTurns: 50,
      maxBudgetUsd: 2.0,
      persistSession: false,
      includePartialMessages: false,
      abortController,
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "admin-agent-eval" },
    },
  });

  console.error(`[eval:report-format] Issue: ${ISSUE}`);
  console.error("[eval:report-format] Running agent loop...");

  // Consume the WHOLE stream — see consumeTranscript: a result message arrives at
  // the end of each agent turn, so stopping at the first one abandons the
  // conversation exactly when the agent has asked whether to save.
  let summary;
  try {
    summary = await consumeTranscript(
      agentQuery as AsyncIterable<SDKMessage>,
      () => {
        turnGate.open();
      },
      // Only OUR in-process server matters. The init message also lists the operator's
      // ambient claude.ai connectors, which normally sit at needs-auth.
      MCP_SERVER_NAME,
    );
  } catch (error: unknown) {
    if (error instanceof AbortError) return 2;
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[eval:report-format] Agent error: ${msg}`);
    return 2;
  }

  const {
    calls,
    initFailures,
    cacheReads,
    lastText,
    outcome,
    resultCount,
    totalTurns,
    totalCostUsd,
  } = summary;

  console.error(
    `[eval:report-format] Result: ${outcome?.subtype ?? "none"}. ` +
      `Turns: ${totalTurns}. Cost: $${totalCostUsd.toFixed(4)}. ` +
      `Cache reads: ${cacheReads} tokens. Tool calls: ${calls.length}. ` +
      `Turn groups: ${resultCount}.`,
  );

  // Separate "the run never happened" from "the model misbehaved" before asserting —
  // an unreachable API otherwise reads as a report-format regression.
  const blocked = diagnoseEmptyRun(outcome, calls, initFailures);
  if (blocked) {
    console.error(`HARNESS FAILURE: ${blocked}`);
    if (lastText) console.error(`\nAgent's last words:\n${lastText}\n`);
    return 2;
  }

  const report = capture.getCapture();
  if (report === undefined) {
    console.error("FAIL: Agent never called save_report.");
    if (lastText) console.error(`\nAgent's last words:\n${lastText}\n`);
    return 1;
  }

  const runMeta = (outcome: EvalRunMeta["outcome"]): EvalRunMeta => ({
    outcome,
    turns: totalTurns,
    costUsd: totalCostUsd,
    toolCalls: calls.length,
  });

  const result = validateReportStructure(report);
  if (result.passed) {
    console.error("PASS: Report conforms to the template structure.");
    await preserveRunArtifact("[eval:report-format]", "report-format", report, runMeta("PASS"));
    return 0;
  }

  console.error("FAIL: Report structure violations:");
  for (const err of result.errors) {
    console.error(`  - ${err}`);
  }
  await preserveRunArtifact("[eval:report-format]", "report-format", report, runMeta("FAIL"));
  return 1;
}

runEval()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[eval:report-format] Harness crash: ${msg}`);
    process.exit(2);
  });
