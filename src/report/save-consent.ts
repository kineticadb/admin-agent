/**
 * One-shot consent token for saving a diagnostic report.
 *
 * Consent used to be a PROMPT rule: both system prompts told the agent to ask
 * "save this report? (yes/no)", end its turn, and call save_report only after the
 * operator answered in free text. That worked, but it made the guarantee only as
 * strong as the model's obedience — the same coupling that shipped a report with a
 * missing Timeline section when the `sonnet` alias moved (see CLAUDE.md, System
 * Prompt). It also cost a full conversational turn and a SECOND composition of the
 * whole report, since the model had to re-emit it as the tool argument after the yes.
 *
 * Now `confirm_save_report` shows the operator a Y/n widget mid-turn and records the
 * answer HERE; `save_report` takes it before writing. The guarantee is structural:
 * no grant, no write.
 *
 * Three states, not a boolean, because "declined" and "never asked" must lead to
 * different handler behavior:
 *   - `granted`  — write.
 *   - `denied`   — do NOT write and do NOT ask again. Re-prompting an operator who
 *                  just said no is how a confirmation degrades into a reflex.
 *   - `unasked`  — the model skipped the ask tool. Fall back to prompting inline:
 *                  the content is already composed, so asking costs nothing, whereas
 *                  failing the call would make the model re-emit the entire report.
 *
 * `take()` is deliberately destructive — one grant authorizes exactly one save, so a
 * second investigation in the same session must ask again. The bounded edge: if the
 * model asks, gets a yes, then abandons the save, that grant survives until the next
 * save consumes it. One save, at most, on a path the model does not take today.
 *
 * Exports:
 *   ConsentState      — "unasked" | "granted" | "denied"
 *   SaveConsent       — the token interface
 *   createSaveConsent — factory
 */

/** What the operator last said about saving, as seen by the save handler. */
export type ConsentState = "unasked" | "granted" | "denied";

/** A one-shot record of the operator's answer to the save question. */
export interface SaveConsent {
  /** Record the operator's answer. The latest answer wins until it is taken. */
  readonly record: (granted: boolean) => void;
  /** Read the answer and reset to `unasked` — one grant authorizes one save. */
  readonly take: () => ConsentState;
}

/**
 * Creates a save-consent token.
 *
 * Closure-based and frozen, matching the project's other stateful primitives
 * (createTurnGate, createSpinner, createBudgetTracker).
 */
export function createSaveConsent(): SaveConsent {
  let state: ConsentState = "unasked";

  return Object.freeze({
    record: (granted: boolean): void => {
      state = granted ? "granted" : "denied";
    },
    take: (): ConsentState => {
      const current = state;
      state = "unasked";
      return current;
    },
  });
}
