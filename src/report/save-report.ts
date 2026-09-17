/**
 * Save report MCP tool factory.
 *
 * Provides makeSaveReportTool() which returns a SdkMcpToolDefinition for the
 * "save_report" MCP tool. The tool handles:
 * - Credential scrubbing via scrubCredentials()
 * - Partial report labeling with the (PARTIAL -- investigation interrupted) marker
 * - Auto-creation of reports/ directory
 * - Timestamped filename: kinetica-diag-YYYY-MM-DD-HHmmss.md
 * - UTF-8 file write via node:fs/promises
 *
 * Consent is a TOKEN this handler takes, not a prompt rule the model is trusted to
 * follow: confirm_save_report shows the operator a Y/n widget and records the answer
 * in the shared SaveConsent (see save-consent.ts), and no grant means no file.
 *
 * It was conversational until 2026-09-16 — the prompt told the agent to ask in prose,
 * end its turn, and wait for free text. The objection to moving the question in here
 * was real and still stands: this handler receives the whole report as an argument,
 * so by the time it runs the model has already paid to compose it, and asking here
 * would leave the operator watching a spinner through an entire silent report before
 * the question arrived. The fix was to ask from a tool that carries NO content
 * (confirm_save_report), which lands the question at the same moment the prose
 * version did while keeping the answer inside the turn. What remains here is the
 * backstop for a model that skips the ask tool: prompt inline rather than fail, since
 * failing would make it re-emit the entire report to try again.
 *
 * Two paths deliberately bypass consent:
 *   - `partial: true` — an emergency checkpoint under budget pressure. Preserving
 *     findings outranks the prompt, and the operator asked for neither.
 *   - a non-interactive terminal — handled inside cli/confirm-save.ts, which assumes
 *     yes rather than hanging on a prompt nobody can answer.
 *
 * Exports:
 *   formatTimestamp(date) — pure function for UTC YYYY-MM-DD-HHmmss formatting (exported for testing)
 *   SaveReportDeps        — injected consent token + inline fallback prompt
 *   makeSaveReportTool(deps) — factory returning SdkMcpToolDefinition
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { scrubCredentials } from "./scrub.js";
import type { SaveConsent } from "./save-consent.js";

/** Marker prepended to partial reports when the investigation was interrupted. */
const PARTIAL_MARKER = "(PARTIAL -- investigation interrupted)\n\n";

/**
 * What the model is told when no file was written. It must forbid the retry
 * explicitly: a plain "not saved" reads as a transient failure, and the model's
 * reflex on those is to try again — which would ask the operator a second time.
 */
const DECLINED_TEXT =
  "Report NOT saved — the operator declined. Do not retry this save; acknowledge in one line, mention they can ask you to save it later, and continue.";

/** Collaborators injected by run-agent (and by tests, which supply stubs). */
export interface SaveReportDeps {
  /** Shared token confirm_save_report writes and this handler takes. */
  readonly consent: SaveConsent;
  /** Inline fallback prompt, used only when the ask tool was skipped. Must not throw. */
  readonly confirm: () => Promise<boolean>;
}

/**
 * True when this save may proceed.
 *
 * `take()` is destructive, so one grant authorizes exactly one save. The three
 * states map to three different behaviors, which is the whole reason SaveConsent
 * is not a boolean:
 *   granted — write.
 *   denied  — do not write, and do NOT ask again; the operator just answered.
 *   unasked — the model skipped confirm_save_report, so ask here instead of failing.
 */
async function consentGranted(deps: SaveReportDeps): Promise<boolean> {
  const state = deps.consent.take();
  if (state === "granted") return true;
  if (state === "denied") return false;
  return deps.confirm();
}

/**
 * Formats a Date to YYYY-MM-DD-HHmmss in UTC.
 *
 * Pure function — exported for testing.
 *
 * @param date - The date to format
 * @returns Formatted string like "2024-06-15-143045"
 */
export function formatTimestamp(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}-${hours}${minutes}${seconds}`;
}

/**
 * Creates the save_report MCP tool definition.
 *
 * The tool saves diagnostic reports to disk with:
 * - Automatic credential scrubbing (defense-in-depth on top of Phase 1 isolation)
 * - Auto-creation of the reports/ directory if it does not exist
 * - Timestamped filename: kinetica-diag-YYYY-MM-DD-HHmmss.md (UTC)
 * - Optional partial marker when investigation was interrupted
 *
 * Annotated readOnlyHint: true so the approval gate auto-approves this tool — the
 * consent check below is the real gate, and routing it through the approval prompt
 * as well would ask the operator twice for one action.
 *
 * @param deps - Consent token and the inline fallback prompt
 * @returns SdkMcpToolDefinition for the save_report tool
 */
export function makeSaveReportTool(deps: SaveReportDeps) {
  return tool(
    "save_report",
    "Save a diagnostic report to disk. Call this ONLY after confirm_save_report returned 'yes' — or, with partial set to true, when checkpointing under budget pressure, which needs no confirmation. Never ask about saving in prose: use confirm_save_report, which returns the operator's answer in the same turn. Automatically scrubs credentials, creates a timestamped filename in reports/, and auto-creates the directory.",
    {
      content: z.string().describe("The full markdown diagnostic report content"),
      partial: z
        .boolean()
        .optional()
        .describe(
          "Set to true if the investigation was interrupted (e.g., Ctrl+C). Prepends a PARTIAL marker to the report.",
        ),
    },
    async (args: { content: string; partial?: boolean }) => {
      // A partial report is an emergency checkpoint under budget pressure — it
      // bypasses consent (and must not consume a pending grant, which still belongs
      // to the final report the operator was asked about).
      if (!args.partial && !(await consentGranted(deps))) {
        return { content: [{ type: "text" as const, text: DECLINED_TEXT }] };
      }

      // Optionally prepend partial marker before credential scrubbing
      const rawContent = args.partial ? `${PARTIAL_MARKER}${args.content}` : args.content;

      // Scrub credentials as defense-in-depth
      const scrubbed = scrubCredentials(rawContent);

      // Build timestamped filename
      const timestamp = formatTimestamp(new Date());
      const filename = `kinetica-diag-${timestamp}.md`;

      // Resolve reports/ directory relative to CWD
      const dir = resolve(process.cwd(), "reports");
      await mkdir(dir, { recursive: true });

      const filepath = join(dir, filename);
      await writeFile(filepath, scrubbed, "utf-8");

      return {
        content: [{ type: "text" as const, text: `Report saved: ${filepath}` }],
      };
    },
    { annotations: { readOnlyHint: true } },
  );
}
