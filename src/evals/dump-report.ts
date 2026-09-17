/**
 * Preserve an eval run's captured report, pass or fail.
 *
 * Failures were the original motive: a failing CONTENT assertion cannot be diagnosed from
 * the log alone, and three times — 2026-09-13 (`gadmin` cited rather than emitted),
 * 2026-09-15 (a restart caveat read as a restart instruction) and 2026-09-16 (a genuine
 * missed trigger) — the verdict turned entirely on report text that existed only in
 * terminal scrollback.
 *
 * Passes are preserved for the mirror-image reason. A green run is the evidence that a fix
 * WORKED, and discarding it means the next question ("did the trigger actually fire, or did
 * the scenario just pass vacuously?") has no artifact to answer it — which is exactly where
 * this landed on 2026-09-16. Each run costs real money and is non-deterministic, so the
 * spread across runs is the real evidence, not any single verdict.
 *
 * Files land in `reports/` beside real diagnostic reports (already gitignored), named
 * `eval-<scenario>-<outcome>-<UTC timestamp>.md` so a directory listing tells the story
 * without opening anything, and carry a frontmatter block so the artifact is
 * self-describing rather than needing its log line beside it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { formatTimestamp } from "../report/save-report.js";
import { scrubCredentials } from "../report/scrub.js";

/** Gitignored, and the same directory the real save_report tool writes to. */
const REPORTS_DIR = "reports";

/** What the run did, recorded alongside the report it produced. */
export type EvalRunMeta = {
  readonly outcome: "PASS" | "FAIL";
  readonly turns?: number;
  readonly costUsd?: number;
  readonly toolCalls?: number;
  /** Knowledge ids read, in call order. An EMPTY array is a finding, so it is recorded. */
  readonly knowledgeReads?: readonly string[];
  /**
   * Did `confirm_save_report` precede the save (see consent-assertions.ts)?
   *
   * Recorded because a PASS alone cannot answer it: the capturing save tool writes
   * whether or not the widget fired, so without this the artifact leaves "was the
   * consent path taken, or did it pass through the fallback?" unanswerable after the
   * run's log has scrolled away. `undefined` means no consent-requiring save happened.
   */
  readonly askedFirst?: boolean;
};

/**
 * Frontmatter describing the run, in the same `---` convention the knowledge corpus uses —
 * trivially strippable, and readable by `parseFrontmatter()` if anything ever wants it back.
 *
 * Pure; exported for its test.
 */
export function buildRunFrontmatter(scenarioId: string, meta: EvalRunMeta, now: Date): string {
  const lines = [
    `scenario: ${scenarioId}`,
    `outcome: ${meta.outcome}`,
    `run_at: ${now.toISOString()}`,
  ];
  if (meta.turns !== undefined) lines.push(`turns: ${meta.turns}`);
  if (meta.costUsd !== undefined) lines.push(`cost_usd: ${meta.costUsd.toFixed(4)}`);
  if (meta.toolCalls !== undefined) lines.push(`tool_calls: ${meta.toolCalls}`);
  if (meta.knowledgeReads !== undefined) {
    lines.push(`knowledge_reads: [${meta.knowledgeReads.join(", ")}]`);
  }
  // Explicitly not `if (meta.askedFirst)` — false is the finding, not an absent value.
  if (meta.askedFirst !== undefined) lines.push(`asked_first: ${String(meta.askedFirst)}`);
  return `---\n${lines.join("\n")}\n---\n\n`;
}

/**
 * Write one captured report to `reports/eval-<scenario>-<outcome>-<UTC timestamp>.md`.
 *
 * Returns the path written, or `undefined` if anything went wrong. It never throws: an
 * artifact is diagnostic convenience, and a read-only filesystem must not turn an assertion
 * failure (exit 1) into a harness failure (exit 2) — the distinction this harness already
 * spent four live runs learning to keep.
 *
 * The report is scrubbed like a real one. The session is mocked, so there is nothing to
 * leak today, but it quotes whatever the tools returned and defence in depth is the house
 * rule. The frontmatter is written after scrubbing so the metadata cannot be mangled.
 */
export async function dumpEvalReport(
  scenarioId: string,
  report: string,
  meta: EvalRunMeta,
  now: Date = new Date(),
): Promise<string | undefined> {
  try {
    // Scenario ids are repo literals, but they land in a path — keep them incapable of
    // escaping the directory however they are spelled later.
    const safeId = scenarioId.replace(/[^a-z0-9-]/gi, "-");
    const dir = resolve(process.cwd(), REPORTS_DIR);
    await mkdir(dir, { recursive: true });
    const outcome = meta.outcome.toLowerCase();
    const filepath = join(dir, `eval-${safeId}-${outcome}-${formatTimestamp(now)}.md`);
    await writeFile(
      filepath,
      buildRunFrontmatter(scenarioId, meta, now) + scrubCredentials(report),
      "utf-8",
    );
    return filepath;
  } catch {
    return undefined;
  }
}

/**
 * Preserve the run's report and say where it went.
 *
 * The fallback differs by outcome, because the stakes do: a FAILING run's report is the
 * evidence a human is about to reason over, so it is printed in full when the write fails;
 * a PASSING run's is reference material, so a failed write is worth one warning line and
 * nothing more. Printing a passing report would put a wall of text on screen every green
 * run, which is how the stderr copy stopped being read in the first place.
 */
export async function preserveRunArtifact(
  tag: string,
  scenarioId: string,
  report: string,
  meta: EvalRunMeta,
): Promise<void> {
  const filepath = await dumpEvalReport(scenarioId, report, meta);
  if (filepath !== undefined) {
    console.error(`${tag} ${meta.outcome} report written to ${filepath}`);
    return;
  }
  if (meta.outcome === "PASS") {
    console.error(`${tag} Could not write the captured report to disk.`);
    return;
  }
  console.error(`${tag} Could not write the captured report to disk — printing it instead.`);
  console.error("\n--- Captured report ---\n");
  console.error(report);
}
