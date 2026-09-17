/**
 * confirm_save_report MCP tool factory — the Y/n widget that replaces the
 * conversational save question.
 *
 * Why a SEPARATE tool rather than a confirmation inside save_report's handler:
 * save_report's argument IS the report, so by the time its handler runs the model
 * has already spent a full second composition emitting several thousand tokens the
 * operator cannot see. Asking there would leave them watching the "Investigating"
 * spinner for the length of a whole report before the question arrived. This tool
 * carries no content at all, so the question lands the instant the report finishes
 * streaming — the same moment it did when the prompt asked in prose — and a decline
 * costs nothing, because the second composition never happens.
 *
 * The answer comes back as a TOOL RESULT, so the agent keeps its turn: no end_turn,
 * no free-text `You:` prompt, no model guessing whether "sure, go ahead" meant yes.
 *
 * The answer is recorded in the shared SaveConsent token rather than only returned,
 * so save_report can verify it. That makes consent a runtime fact instead of a
 * prompt rule the model is trusted to follow — see save-consent.ts.
 *
 * Annotated readOnlyHint and registered read-only in buildApprovalRegistry(): it
 * writes nothing, and routing it through the approval gate would prompt the
 * operator for permission to ask the operator a question.
 *
 * Exports:
 *   ConfirmSaveReportDeps    — injected consent token + operator prompt
 *   makeConfirmSaveReportTool — factory returning SdkMcpToolDefinition
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";

import type { SaveConsent } from "./save-consent.js";

/** What the model is told after a yes — an instruction, not an acknowledgement. */
const GRANTED_TEXT =
  "yes — the operator approved saving. Call save_report now with the complete report markdown content.";

/**
 * What the model is told after a no. Phrased as a directive because a bare "no"
 * reads as a data point the model may weigh against its own judgement.
 */
const DENIED_TEXT =
  "no — the operator declined. Do NOT call save_report for this report. Acknowledge in one line, mention they can ask you to save it later, and continue.";

/** Collaborators injected by run-agent (and by the evals, which auto-approve). */
export interface ConfirmSaveReportDeps {
  /** Shared token save_report reads before writing. */
  readonly consent: SaveConsent;
  /** Asks the operator. Must not throw — see cli/confirm-save.ts. */
  readonly confirm: () => Promise<boolean>;
}

/**
 * Creates the confirm_save_report MCP tool definition.
 *
 * @param deps - Consent token and the operator prompt
 * @returns SdkMcpToolDefinition for the confirm_save_report tool
 */
export function makeConfirmSaveReportTool(deps: ConfirmSaveReportDeps) {
  return tool(
    "confirm_save_report",
    "Ask the operator whether to save the finished diagnostic report to disk. Call this immediately AFTER presenting the report in your response and BEFORE calling save_report. It takes no arguments and shows the operator a Y/n prompt, returning their answer to you in the same turn — so never ask about saving in prose and never end your turn to wait for an answer. Returns 'yes' (then call save_report) or 'no' (then do not save). Skip this tool only when checkpointing under budget pressure with save_report's partial flag.",
    {},
    async (_args: Record<string, never>) => {
      const granted = await deps.confirm();
      deps.consent.record(granted);

      return {
        content: [{ type: "text" as const, text: granted ? GRANTED_TEXT : DENIED_TEXT }],
      };
    },
    { annotations: { readOnlyHint: true } },
  );
}
