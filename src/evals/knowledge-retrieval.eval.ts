/**
 * Knowledge-retrieval eval — does the agent actually READ what the cards oblige?
 *
 * Progressive disclosure traded a guarantee for a trigger. When every document body
 * was inlined the agent could not fail to have the rules in context; with cards it
 * must choose to fetch them, and this repo has measured the agent declining exactly
 * that kind of invitation before (it skipped the whole Loki log dimension because the
 * prompt framed it as probably-available). Unit tests can prove the card is rendered;
 * only a real model run can prove the card is acted on.
 *
 * Runs the full agent loop against the mocked Kinetica session with an issue whose
 * symptoms match the memory-pressure playbook card, then asserts on the transcript.
 *
 * Exit codes: 0 pass, 1 assertion failed, 2 harness failure.
 */

import { query, createSdkMcpServer, AbortError } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

import type { KineticaSession } from "../types/index.js";

import { buildSystemPrompt } from "../agent/system-prompt.js";
import { loadPlaybooks } from "../agent/load-playbooks.js";
import { loadReferences, loadBundleReferences } from "../agent/load-references.js";
import {
  MCP_SERVER_NAME,
  ALLOWED_TOOL_NAMES,
  KNOWLEDGE_ALLOWED_TOOL_NAMES,
} from "../agent/run-agent.js";
import {
  makeDiagnosticTools,
  makeMutationTools,
  makeAlterTableColumnsToolWithDeps,
} from "../tools/index.js";
import { makeKnowledgeTools } from "../tools/knowledge/index.js";
import { createKnowledgeStore } from "../knowledge/KnowledgeStore.js";
import {
  createMockSession,
  createStaleRankSession,
  createUnappliedConfigSession,
} from "./mock-session.js";
import { makeCapturingSaveReportTool } from "./capturing-save-report.js";
import { validateReportStructure } from "./report-assertions.js";
import {
  validateKnowledgeRetrieval,
  validateRetrievalCalls,
  remediationTouchesService,
  idsRead,
} from "./knowledge-assertions.js";
import { scriptedOperator, SAVE_REPLIES } from "./scripted-operator.js";
import { createTurnGate } from "../agent/turn-gate.js";
import { consumeTranscript, diagnoseEmptyRun } from "./transcript.js";
import { preserveRunArtifact, type EvalRunMeta } from "./dump-report.js";

/** One issue put to the agent, plus what its cards oblige it to read. */
type Scenario = {
  readonly id: string;
  readonly issue: string;
  /** Ids that satisfy this issue's Round-1 trigger; at least one must be read. */
  readonly expectAnyOf: readonly string[];
  readonly session: () => KineticaSession;
  /**
   * When true, the Remediation is expected to start/stop/restart something, so the
   * service-management trigger MUST fire. A run whose remediation touches nothing has
   * not exercised it, and the eval says so rather than passing vacuously.
   */
  readonly mustExerciseServiceTrigger?: boolean;
};

/**
 * Three scenarios, deliberately different in shape.
 *
 * The first matches a playbook card's symptoms almost verbatim — it measures whether a
 * MATCHED card is acted on. The second exists because four runs of the first never once
 * retrieved `service-management`: that document exists BECAUSE the agent invented
 * `gadmin restart rank 2`, it moved from always-inline to a card behind a MANDATORY
 * trigger, and until a remediation actually touches a service there is no evidence the
 * trigger works. It also tests a different card (`stale-rank`), so trigger generality
 * stops resting on a single playbook.
 *
 * The third exists because the second turned out to probe only the OBVIOUS case, where a
 * restart IS the investigation. The failure measured on 2026-09-16 was the incidental one:
 * the agent wrote `systemctl stop gpudb` inside a memory-pressure investigation and never
 * read `service-management`. `memory-pressure` cannot be relied on to reproduce that — over
 * three live runs its remediation instructed a service action exactly once, depending on
 * which root-cause hypothesis the agent chased. So, as with `stale-rank`, closing the gap
 * needed a changed WORLD rather than a changed question: a config value that is written but
 * unapplied has exactly one correct remediation, and it is a restart.
 */
const SCENARIOS: readonly Scenario[] = [
  {
    id: "memory-pressure",
    issue:
      "Queries have become slow over the last hour and we are seeing eviction warnings. Please investigate and produce a report.",
    expectAnyOf: ["memory-pressure", "tiered-objects"],
    session: () => createMockSession(),
  },
  {
    id: "stale-rank",
    issue:
      "Rank 2 has gone offline and is not responding. The cluster is degraded. Please investigate and tell us exactly how to bring it back.",
    expectAnyOf: ["stale-rank"],
    session: createStaleRankSession,
    mustExerciseServiceTrigger: true,
  },
  {
    id: "unapplied-config",
    // States the uptime an operator would volunteer, because no endpoint can report it —
    // /show and /admin/show/configuration both read the FILE. It stops short of naming a
    // restart: the diagnosis has to come from the corpus, or the scenario leads the witness.
    issue:
      "Two hours ago we raised `tps_per_tom` from 4 to 8 to improve ingest throughput. " +
      "The property read-back confirms the new value, but throughput is completely " +
      "unchanged and the database has not been restarted since last Tuesday. Please " +
      "investigate and tell us exactly what to do about it.",
    // service-management is listed FIRST because it is the document this scenario is
    // actually about, and measured 2026-09-16 it is the only one that adds anything: the
    // restart-required mechanism (including `tps_per_tom` and the measured 4→8 result) is
    // already in the prompt verbatim, because `mutation-safety` is `disclosure: inline`.
    // An agent that reads `gpudb-conf` here spends a turn re-reading what it was handed at
    // startup. What is NOT inline is the full-stack ordering — `gpudb_host_manager` appears
    // only in `service-management.md` — and the agent produced it, so the read earned its
    // place. Card ROUTING is covered by the other two scenarios; this one's guarantee is
    // `mustExerciseServiceTrigger`, which cannot pass vacuously.
    expectAnyOf: ["service-management", "config-drift", "gpudb-conf"],
    session: createUnappliedConfigSession,
    mustExerciseServiceTrigger: true,
  },
];

const autoAllow: CanUseTool = (_toolName, toolInput, options): Promise<PermissionResult> =>
  Promise.resolve({
    behavior: "allow",
    updatedInput: toolInput,
    toolUseID: options.toolUseID,
  });

type Corpus = {
  readonly playbooks: Awaited<ReturnType<typeof loadPlaybooks>>;
  readonly references: Awaited<ReturnType<typeof loadReferences>>;
  readonly bundleReferences: Awaited<ReturnType<typeof loadBundleReferences>>;
};

/** Run one scenario end to end. 0 pass, 1 assertion failed, 2 harness failure. */
async function runScenario(scenario: Scenario, corpus: Corpus): Promise<number> {
  const tag = `[eval:knowledge-retrieval:${scenario.id}]`;
  const session = scenario.session();
  const { playbooks, references, bundleReferences } = corpus;

  // "available" mirrors what run-agent passes for a live session with no bundle —
  // the configuration this eval is meant to measure.
  const systemPrompt = buildSystemPrompt(
    "7.2.3.11 (eval-mock)",
    undefined,
    playbooks,
    references,
    false,
    "available",
    bundleReferences,
  );

  const knowledgeStore = createKnowledgeStore([...playbooks, ...references, ...bundleReferences]);
  const capture = makeCapturingSaveReportTool();

  const server = createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [
      ...makeDiagnosticTools(session, undefined),
      ...makeMutationTools(session),
      ...makeKnowledgeTools(knowledgeStore),
      capture.tool,
      makeAlterTableColumnsToolWithDeps(session),
    ],
  });

  const abortController = new AbortController();
  // Same primitive prod uses: the output loop opens it on end_turn, the operator
  // generator awaits it. Without an operator the save question is never answered.
  const turnGate = createTurnGate();

  const agentQuery = query({
    prompt: scriptedOperator(
      scenario.issue,
      SAVE_REPLIES,
      turnGate,
      () => capture.getCapture() !== undefined,
    ),
    options: {
      mcpServers: { [MCP_SERVER_NAME]: server },
      allowedTools: [...ALLOWED_TOOL_NAMES, ...KNOWLEDGE_ALLOWED_TOOL_NAMES],
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

  console.error(`${tag} Issue: ${scenario.issue}`);
  console.error(`${tag} Running agent loop...`);

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
    console.error(`${tag} Agent error: ${msg}`);
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

  const ids = idsRead(calls);
  console.error(
    `${tag} Result: ${outcome?.subtype ?? "none"}. ` +
      `Turns: ${totalTurns}. Cost: $${totalCostUsd.toFixed(4)}. ` +
      `Cache reads: ${cacheReads} tokens. Tool calls: ${calls.length}. ` +
      // Turn groups > 1 proves the scripted operator's reply was delivered and the
      // conversation continued — the fact whose absence hid two harness bugs.
      `Turn groups: ${resultCount}. ` +
      `Knowledge reads: ${ids.length} [${ids.join(", ") || "none"}].`,
  );

  // Distinguish "the run never happened" from "the model misbehaved" BEFORE asserting.
  // Without this an invalid API key reads as a behavioural regression.
  const blocked = diagnoseEmptyRun(outcome, calls, initFailures);
  if (blocked) {
    console.error(`${tag} HARNESS FAILURE: ${blocked}`);
    if (lastText) console.error(`\nAgent's last words:\n${lastText}\n`);
    return 2;
  }

  // Report the transcript-only verdict FIRST, and unconditionally. These are the
  // assertions this eval is named for, and they hold whether or not a report was saved —
  // three consecutive runs of correct retrieval were previously reported as a bare save
  // failure, which gave no credit for the behaviour actually under test.
  const retrievalOnly = validateRetrievalCalls(calls, scenario.expectAnyOf);
  console.error(
    retrievalOnly.passed
      ? `${tag} Retrieval assertions PASSED (read before reporting, and read a matching document).`
      : `${tag} Retrieval assertions FAILED:`,
  );
  for (const err of retrievalOnly.errors) console.error(`  - ${err}`);

  // Every artifact records the run that produced it, so a green run can later answer
  // "did the trigger actually fire?" without its log line beside it.
  const runMeta = (outcome: EvalRunMeta["outcome"]): EvalRunMeta => ({
    outcome,
    turns: totalTurns,
    costUsd: totalCostUsd,
    toolCalls: calls.length,
    knowledgeReads: ids,
  });

  const report = capture.getCapture();
  if (report === undefined) {
    // Still a FAIL, and still exit 1: the report is the artifact the remaining three
    // assertions examine, and saving on consent is real behaviour worth verifying.
    console.error(
      "FAIL: Agent never called save_report, so the report-dependent assertions " +
        "(service-management trigger, report structure, knowledge-id citation) could not run.",
    );
    if (lastText) console.error(`\nAgent's last words:\n${lastText}\n`);
    return 1;
  }

  const retrieval = validateKnowledgeRetrieval(calls, report, scenario.expectAnyOf);
  const structure = validateReportStructure(report);
  const errors = [...retrieval.errors, ...structure.errors];

  // A scenario written to exercise the service-management trigger must actually do so.
  // Assertion 3 is conditional, so a benign remediation passes it vacuously and leaves
  // the trigger untested — which is the whole gap this scenario exists to close.
  if (scenario.mustExerciseServiceTrigger && !remediationTouchesService(report)) {
    console.error(
      `${tag} FAIL (scenario coverage): the Remediation starts/stops/restarts nothing, so ` +
        `the mandatory service-management trigger was never exercised. This is a weakness in ` +
        `the scenario, NOT a model regression — strengthen the issue or the mocked cluster ` +
        `state until a restart is the obvious fix.`,
    );
    await preserveRunArtifact(tag, scenario.id, report, runMeta("FAIL"));
    return 1;
  }

  if (errors.length === 0) {
    console.error(
      `${tag} PASS: read the matching documents before reporting, and the report conforms.` +
        (scenario.mustExerciseServiceTrigger
          ? " The service-management trigger fired and was honoured."
          : ""),
    );
    await preserveRunArtifact(tag, scenario.id, report, runMeta("PASS"));
    return 0;
  }

  console.error(`${tag} FAIL:`);
  for (const err of errors) console.error(`  - ${err}`);
  await preserveRunArtifact(tag, scenario.id, report, runMeta("FAIL"));
  return 1;
}

async function runEval(): Promise<number> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ERROR: ANTHROPIC_API_KEY not set. Evals require API access.\n" +
        "Export ANTHROPIC_API_KEY or run `npm run dev -- --login` first.",
    );
    return 2;
  }

  const [playbooks, references, bundleReferences] = await Promise.all([
    loadPlaybooks(),
    loadReferences(),
    loadBundleReferences(),
  ]);
  const corpus: Corpus = { playbooks, references, bundleReferences };

  // Sequential, not parallel: each run is a separate billed conversation and the output
  // is read by a human, so interleaved logs would be worse than the wall-clock saving.
  const codes: number[] = [];
  for (const scenario of SCENARIOS) {
    codes.push(await runScenario(scenario, corpus));
  }

  const failed = SCENARIOS.filter((_, i) => codes[i] !== 0).map((s) => s.id);
  if (failed.length === 0) {
    console.error(`\nPASS: all ${SCENARIOS.length} scenarios passed.`);
    return 0;
  }
  console.error(
    `\nFAIL: ${failed.length}/${SCENARIOS.length} scenarios failed: ${failed.join(", ")}`,
  );
  // A harness failure anywhere dominates: it means a verdict could not be reached.
  return codes.includes(2) ? 2 : 1;
}

runEval()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[eval:knowledge-retrieval] Harness crash: ${msg}`);
    process.exit(2);
  });
