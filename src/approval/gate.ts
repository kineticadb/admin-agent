/**
 * canUseTool approval gate implementing the three-response protocol (y/n/explain).
 *
 * Design choices:
 * 1. Factory pattern (createApprovalGate) — accepts isReadOnly function for
 *    dependency injection, enabling clean unit tests without module-level mocks.
 *
 * 2. The while(true) loop exits ONLY on "y" or "n". The "explain" response
 *    displays decisionReason (or fallback) and re-prompts. Unrecognized input
 *    also re-prompts silently. This prevents accidental confirmation.
 *
 * 3. On denial: the message explicitly tells the agent to "skip and continue" —
 *    preventing the agent from getting stuck or retrying the same denied action.
 *
 * 4. All UI output (panel, reasoning) goes to console.error — stdout is
 *    reserved for agent data output.
 *
 * 5. Matches the CanUseTool callback signature from @anthropic-ai/claude-agent-sdk.
 */
import { input } from "@inquirer/prompts";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { renderApprovalPanel } from "./display.js";

type IsReadOnlyFn = (toolName: string) => boolean;

const DENY_MESSAGE = "User denied this mutation. Skip and continue with the investigation.";

const REASONING_FALLBACK =
  "Reasoning not available. Review the action details above before proceeding.";

/**
 * Creates an approval gate function that implements the three-response protocol.
 *
 * @param isReadOnly - Predicate that returns true for tools that bypass approval
 * @returns A canUseTool-compatible callback function
 */
export function createApprovalGate(isReadOnly: IsReadOnlyFn): CanUseTool {
  return async (toolName, toolInput, options): Promise<PermissionResult> => {
    // Allow-list check: read-only tools pass without prompting
    if (isReadOnly(toolName)) {
      return {
        behavior: "allow",
        updatedInput: toolInput,
        toolUseID: options.toolUseID,
      };
    }

    // Mutation tool — render the approval panel on stderr
    const impact = options.decisionReason;
    const panel = renderApprovalPanel(toolName, toolInput, impact);
    console.error(panel);

    // Three-response loop: only "y" or "n" exits; "explain" and unknown re-prompt
    while (true) {
      try {
        const raw = await input({ message: "Proceed? (y/n/explain):" }, { signal: options.signal });
        const normalized = raw.trim().toLowerCase();

        if (normalized === "y") {
          process.stderr.write("\n");
          return {
            behavior: "allow",
            updatedInput: toolInput,
            toolUseID: options.toolUseID,
          };
        }

        if (normalized === "n") {
          process.stderr.write("\n");
          return {
            behavior: "deny",
            message: DENY_MESSAGE,
            toolUseID: options.toolUseID,
          };
        }

        if (normalized === "explain") {
          const reasoning = options.decisionReason;
          if (reasoning) {
            console.error(`\nAgent reasoning: ${reasoning}\n`);
          } else {
            console.error(`\n${REASONING_FALLBACK}\n`);
          }
          // Loop continues — re-prompt without exiting
        }
        // Unrecognized input: loop continues silently
      } catch {
        // Signal aborted — deny gracefully so the agent doesn't hang
        return {
          behavior: "deny",
          message: DENY_MESSAGE,
          toolUseID: options.toolUseID,
        };
      }
    }
  };
}
