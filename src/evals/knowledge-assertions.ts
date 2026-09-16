/**
 * Structural validators for knowledge RETRIEVAL — did the agent read what the
 * prompt obliged it to read, before it wrote the report?
 *
 * Deliberately not an LLM-as-judge, and deliberately not about wording: these check
 * that a read HAPPENED and that a known-bad command is ABSENT, both of which are
 * stable across model non-determinism. Wording assertions would flake.
 *
 * This exists because progressive disclosure trades a guarantee for a trigger. With
 * every document inlined, the agent could not fail to have the rules in context; with
 * cards, it must choose to fetch them. That choice is the thing worth measuring, and
 * this repo has already measured the opposite outcome once — the agent skipped the
 * entire Loki log dimension because the prompt framed it as probably-unavailable.
 *
 * Pure, dependency-free. Sibling .test.ts keeps it covered by the fast suite.
 */

import type { ToolCall } from "./transcript.js";

export type { ToolCall };

export type AssertionResult = {
  readonly passed: boolean;
  readonly errors: readonly string[];
};

/** Unqualified tool names — MCP prefixes vary with the server name. */
const KNOWLEDGE_READ = "kinetica_knowledge_read";
const SAVE_REPORT = "save_report";

/** `gadmin` used as a service-control command — the regression this corpus exists to stop. */
const GADMIN_AS_COMMAND = /gadmin\s+(restart|start|stop|status)/i;

/**
 * Markers that turn a gadmin mention into a WARNING rather than an instruction.
 *
 * Measured 2026-09-13: the best report this eval has yet produced failed the old
 * whole-report `GADMIN_AS_COMMAND.test(report)`. It read `service-management`, prescribed
 * `systemctl stop gpudb` / `systemctl start gpudb` in a fenced block, and then handed the
 * never-emit table on to the operator — "`gadmin restart rank 2` and `systemctl restart
 * rank2` are **wrong and must not be used**". Failing that is backwards: it is the single
 * most correct outcome available, and it is precisely the wording flake this module's
 * header promises not to have. Every never-emit row in `service-management.md` disowns
 * itself within the row ("not a service-control CLI", "no such CLI"), so a report that
 * mirrors that table is covered by the same line-scoped rule.
 */
const DISOWNED =
  /\b(cannot|not|never|avoid|wrong|invalid|incorrect|instead|rather than|no such|unsupported|forbidden|prohibited)\b|don['\u2019]?t|\u274c|\ud83d\udeab/i;

/** Opening or closing fence of a Markdown code block. */
const CODE_FENCE = /^\s*```/;

/** Kinetica things an operator is told to start, stop or restart. */
const SERVICE_OBJECT = String.raw`(?:the\s+|a\s+|an\s+)?(?:database|db|gpudb|kinetica|service|cluster|rank|node|host[\s-]?manager|host|instance)`;

/**
 * A remediation step that TELLS THE OPERATOR to start, stop or restart a service.
 *
 * Word ORDER is the discriminator, and it has to be. A bare `\brestart\b` cannot tell an
 * instruction from the caveat this corpus REQUIRES on every config change, and measured
 * 2026-09-15 it did not: the memory-pressure remediation proposed tier-limit edits, named
 * no command at all, and still failed assertion 3 on the one word inside "(requires DBA
 * approval and a DB restart to take effect)". That note is not the agent freelancing — it
 * is `mutation-safety.md`, the single always-inline document, instructing it to "tell the
 * operator the value is written and a restart is required to realise it". Failing a report
 * for obeying the one document guaranteed to be in its context is backwards.
 *
 * Verb-then-object is an instruction ("restart the database"); a noun compound is a
 * property of the change ("a DB restart to take effect", "the change survives restarts").
 * An actual service command counts whatever prose surrounds it, because
 * `service-management.md` is where those commands are sanctioned in the first place.
 */
const TOUCHES_A_SERVICE = new RegExp(
  [
    String.raw`systemctl`,
    String.raw`\bservice\s+gpudb`,
    String.raw`/opt/gpudb/core/bin/gpudb`,
    String.raw`\b(?:re)?start\w*\s+${SERVICE_OBJECT}`,
    String.raw`\bstop\w*\s+${SERVICE_OBJECT}`,
    String.raw`\bbring\b.{0,20}\bback\s+(?:up|online)`,
  ].join("|"),
  "i",
);

/**
 * Does the report's Remediation ask the operator to start, stop or restart something?
 *
 * Exported because a scenario written to exercise the `service-management` trigger needs
 * to know whether it actually DID. Assertion 3 is conditional by design — it cannot fire
 * on a remediation that touches no service — so a scenario whose remediation came out
 * benign passes vacuously and leaves the trigger untested. That is a gap in the scenario,
 * not in the agent, and the eval reports it as such.
 */
export function remediationTouchesService(report: string): boolean {
  return TOUCHES_A_SERVICE.test(remediationSection(report));
}

/**
 * Extract the report's Remediation section.
 *
 * The service-management trigger is about what the agent TELLS the operator to do, not
 * about what the incident involved. Tested against the whole report, an investigation
 * that merely narrates a restart — "14:23 operator issued a restart of rank 2" in the
 * Timeline, or a Root Cause describing one — would demand a read the protocol never
 * required, producing a false failure on exactly the incidents these playbooks cover.
 *
 * Returns "" when the section is absent, which correctly disables the check: a report
 * with no Remediation section has no remediation step to gate.
 */
function remediationSection(report: string): string {
  const heading = /^##\s+Remediation\s*$/m.exec(report);
  if (!heading) return "";
  const rest = report.slice(heading.index + heading[0].length);
  const next = /^##\s/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/**
 * Lines where the report tells the operator to RUN a gadmin command.
 *
 * A match counts as an emission when it sits inside a fenced code block — a copy-paste
 * surface, where a forbidden command has no business appearing at all — or on a prose line
 * that does not disown it. A line that names gadmin only to rule it out is the corpus
 * working rather than failing, and must not fail this eval.
 *
 * Line-scoped, not whole-report: `remediationSection` above already learned that a check
 * about what the agent TELLS the operator cannot be run against every sentence in the
 * document, and this is the same shape. Returning the offending lines rather than a
 * boolean also puts the evidence in the failure message, so the next run does not need the
 * report fished out of a terminal to be diagnosed.
 *
 * Known limit: an instruction carrying a prohibitive word on its own line ("rank 2 is not
 * responding, so run `gadmin restart rank 2`") reads as disowned. It stays flagged inside
 * a fence, which is where a prescribed command belongs.
 */
export function gadminCommandLines(report: string): readonly string[] {
  let inFence = false;
  const offenders: string[] = [];
  for (const line of report.split("\n")) {
    if (CODE_FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!GADMIN_AS_COMMAND.test(line)) continue;
    if (inFence || !DISOWNED.test(line)) offenders.push(line.trim());
  }
  return offenders;
}

/** Strip any `mcp__<server>__` prefix so assertions read on plain tool names. */
export function bareToolName(name: string): string {
  return name.replace(/^mcp__[^_]*(?:_[^_]+)*?__/, "").replace(/^mcp__.*__/, "");
}

/** Knowledge ids the agent read, in call order, deduplicated. */
export function idsRead(calls: readonly ToolCall[]): readonly string[] {
  const ids = calls
    .filter((c) => bareToolName(c.name) === KNOWLEDGE_READ)
    // The transcript is untyped JSON — take `id` only when it really is a string.
    .map((c) => (typeof c.input.id === "string" ? c.input.id.replace(/\.md$/, "") : ""))
    .filter(Boolean);
  return [...new Set(ids)];
}

/** Index of the first save_report call, or -1. */
function saveReportIndex(calls: readonly ToolCall[]): number {
  return calls.findIndex((c) => bareToolName(c.name) === SAVE_REPORT);
}

/**
 * Validate that retrieval happened where the protocol requires it.
 *
 * @param calls  every tool_use block from the transcript, in order
 * @param report the saved report markdown
 * @param expectAnyOf ids that would satisfy the issue's Round-1 trigger
 */
/**
 * The transcript-only half: did the agent read, and read the RIGHT thing?
 *
 * Separated because these are the assertions this eval is named for, and they need only
 * the tool calls — no report. A run whose report was never saved (the agent asks for
 * consent before saving, so any harness hiccup loses it) can therefore still report
 * whether retrieval worked, instead of collapsing to a bare "never called save_report"
 * that gives no credit for six correct reads.
 */
export function validateRetrievalCalls(
  calls: readonly ToolCall[],
  expectAnyOf: readonly string[],
): AssertionResult {
  const errors: string[] = [];
  const ids = idsRead(calls);
  const saveIdx = saveReportIndex(calls);

  // 1. A read must precede the report — reading after writing is not retrieval.
  const readBeforeReport = calls.some(
    (c, i) => bareToolName(c.name) === KNOWLEDGE_READ && (saveIdx === -1 || i < saveIdx),
  );
  if (!readBeforeReport) {
    errors.push(
      `No ${KNOWLEDGE_READ} call before ${SAVE_REPORT}. The agent wrote the report without ` +
        `reading any knowledge document.`,
    );
  }

  // 2. The read must be the RELEVANT one, not merely any read.
  if (ids.length > 0 && !expectAnyOf.some((id) => ids.includes(id))) {
    errors.push(
      `Read [${ids.join(", ")}] but none of the expected ids [${expectAnyOf.join(", ")}]. ` +
        `The cards' triggers did not route the agent to the matching document.`,
    );
  }

  return { passed: errors.length === 0, errors };
}

export function validateKnowledgeRetrieval(
  calls: readonly ToolCall[],
  report: string,
  expectAnyOf: readonly string[],
): AssertionResult {
  // Report-dependent checks build ON the transcript-only ones, never beside them, so
  // the two can never disagree about whether retrieval happened.
  const errors: string[] = [...validateRetrievalCalls(calls, expectAnyOf).errors];
  const ids = idsRead(calls);

  // 3. A service-touching remediation obliges reading service-management, and must
  //    never emit a gadmin service command. The document exists because it did.
  if (TOUCHES_A_SERVICE.test(remediationSection(report)) && !ids.includes("service-management")) {
    errors.push(
      "Remediation starts/stops/restarts something but service-management was never read — " +
        "the mandatory pre-Remediation trigger did not fire.",
    );
  }
  const gadminLines = gadminCommandLines(report);
  if (gadminLines.length > 0) {
    errors.push(
      "Report emits a `gadmin` service-control command; gadmin is a GUI, not a CLI. " +
        `Offending line(s): ${gadminLines.join(" | ")}`,
    );
  }

  // 4. Retrieval must be auditable from the report itself.
  //
  // Checks that the ids are NAMED, not that they appear under a particular label. The
  // prompt offers `knowledge: memory-pressure, tiered-objects` as an EXAMPLE of how to do
  // it, and this assertion used to require that literal string — so it failed the
  // best-cited report of the whole series (measured 2026-09-16), which attributed each
  // finding to its source in the Evidence Collected table: "| Correct restart commands …
  // | `kinetica_knowledge_read` (id: `service-management`) |". That is strictly MORE
  // auditable than one summary line, and `kinetica_knowledge_read` carries an underscore
  // where the old regex wanted a colon. Same error as the gadmin and restart checks before
  // it: keying off a label rather than the property the label was standing in for.
  //
  // Threshold is "at least one", matching the old check's strength rather than raising it.
  // Measured across the three artifacts of 2026-09-16: every report named EVERY id it read
  // (8 of 8), so tightening this to "every" is available if it is ever worth the flake
  // risk — but n=3 does not justify a stricter assertion than the one being replaced.
  if (ids.length > 0 && !ids.some((id) => report.includes(id))) {
    errors.push(
      `Report never names any of the knowledge documents it read [${ids.join(", ")}], so ` +
        `retrieval is not auditable by the operator.`,
    );
  }

  return { passed: errors.length === 0, errors };
}
