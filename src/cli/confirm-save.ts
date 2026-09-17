/**
 * confirm-save — the Y/n widget the operator answers to save a diagnostic report.
 *
 * Fired by the confirm_save_report tool (and, as a backstop, by save_report itself)
 * once the agent has presented a finished report. It replaces the old conversational
 * question, which ended the agent's turn and waited for free text in the `You:`
 * prompt — a full extra turn, plus the model re-composing the entire report as the
 * tool argument after the yes.
 *
 * Two behaviors worth stating, because they are the ones a widget gets wrong:
 *
 * 1. A NON-INTERACTIVE run (piped output, CI, `npm run eval`) never prompts — there
 *    is nobody to answer, and blocking there would hang the session. It assumes yes
 *    and says so on stderr: losing a finished diagnostic is worse than an extra file
 *    in reports/, but an assumed consent must never be indistinguishable from a
 *    given one in the transcript. Mirrors pick-bundle-path.ts, which likewise checks
 *    `process.stdin.isTTY` inside the module rather than making every caller do it.
 *
 * 2. An ABORTED prompt (Ctrl-C) resolves to false instead of throwing, so a tool
 *    handler never has to defend against it. Declining is the safe direction here:
 *    the report is still in the agent's context and the operator can ask for it.
 *
 * Deliberately NOT responsible for stopping the spinner — run-agent.ts owns that,
 * exactly as it does for the bundle picker (`promptForPath`).
 */

import pc from "picocolors";

import { confirm } from "../output/themed-prompts.js";

/** Shown when consent is assumed because no operator could be asked. */
const NON_INTERACTIVE_NOTE = "Non-interactive terminal — saving the report without asking.";

/**
 * Asks the operator whether to write the finished report to disk.
 *
 * Never throws. Returns true to save, false to skip.
 */
export async function promptSaveReport(): Promise<boolean> {
  if (!process.stdin.isTTY) {
    process.stderr.write(pc.dim(`\n${NON_INTERACTIVE_NOTE}\n`));
    return true;
  }

  try {
    return await confirm({ message: "Save this report to disk?", default: true });
  } catch {
    // Prompt aborted (Ctrl-C / closed stdin) — decline rather than propagate.
    return false;
  }
}
