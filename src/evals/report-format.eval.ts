/**
 * Runs the agent end-to-end against a mocked Kinetica session and asserts
 * the model's report conforms to knowledge/templates/report.md. Unit tests
 * cover the inputs (prompt, template); this covers the output. Cost per run
 * is typically under $0.10.
 *
 * Exit codes: 0 pass, 1 assertion failed, 2 harness failure.
 */

import { query, createSdkMcpServer, AbortError } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKUserMessage,
  CanUseTool,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";

import { buildSystemPrompt } from "../agent/system-prompt.js";
import { loadPlaybooks } from "../agent/load-playbooks.js";
import { loadReferences } from "../agent/load-references.js";
import { MCP_SERVER_NAME, ALLOWED_TOOL_NAMES, makeUserMessage } from "../agent/run-agent.js";
import {
  makeDiagnosticTools,
  makeMutationTools,
  makeAlterTableColumnsToolWithDeps,
} from "../tools/index.js";
import { createMockSession } from "./mock-session.js";
import { makeCapturingSaveReportTool } from "./capturing-save-report.js";
import { validateReportStructure } from "./report-assertions.js";

const ISSUE =
  "Run a quick health sanity check of the cluster and produce a baseline report. The system appears to be operating normally — I just want a routine snapshot.";

// `async` required so the return type matches AsyncIterable<SDKUserMessage>;
// a plain generator (`function*`) produces Iterable which query() rejects.
// eslint-disable-next-line @typescript-eslint/require-await
async function* singleIssuePrompt(issue: string): AsyncGenerator<SDKUserMessage> {
  yield makeUserMessage(issue);
}

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

  const capture = makeCapturingSaveReportTool();
  const diagnosticTools = makeDiagnosticTools(session, undefined);
  const mutationTools = makeMutationTools(session);
  const alterTableColumnsTool = makeAlterTableColumnsToolWithDeps(session);

  const server = createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [...diagnosticTools, ...mutationTools, capture.tool, alterTableColumnsTool],
  });

  const abortController = new AbortController();

  const agentQuery = query({
    prompt: singleIssuePrompt(ISSUE),
    options: {
      mcpServers: { [MCP_SERVER_NAME]: server },
      allowedTools: ALLOWED_TOOL_NAMES,
      disallowedTools: ["Bash", "Edit", "Write", "MultiEdit"],
      canUseTool: autoAllow,
      systemPrompt,
      model: "sonnet" as const,
      fallbackModel: "haiku" as const,
      thinking: { type: "adaptive" as const },
      maxTurns: 30,
      maxBudgetUsd: 2.0,
      persistSession: false,
      includePartialMessages: false,
      abortController,
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "admin-agent-eval" },
    },
  });

  console.error(`[eval:report-format] Issue: ${ISSUE}`);
  console.error("[eval:report-format] Running agent loop...");

  let totalCostUsd = 0;
  let numTurns = 0;

  try {
    for await (const message of agentQuery as AsyncIterable<SDKMessage>) {
      if (message.type === "result") {
        totalCostUsd = message.total_cost_usd;
        numTurns = message.num_turns;
        break;
      }
    }
  } catch (error: unknown) {
    if (!(error instanceof AbortError)) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[eval:report-format] Agent error: ${msg}`);
      return 2;
    }
  }

  console.error(
    `[eval:report-format] Agent finished. Turns: ${numTurns}. Cost: $${totalCostUsd.toFixed(4)}.`,
  );

  const report = capture.getCapture();
  if (report === undefined) {
    console.error("FAIL: Agent never called save_report.");
    return 1;
  }

  const result = validateReportStructure(report);
  if (result.passed) {
    console.error("PASS: Report conforms to the template structure.");
    return 0;
  }

  console.error("FAIL: Report structure violations:");
  for (const err of result.errors) {
    console.error(`  - ${err}`);
  }
  console.error("\n--- Captured report ---\n");
  console.error(report);
  return 1;
}

runEval()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[eval:report-format] Harness crash: ${msg}`);
    process.exit(2);
  });
