/**
 * Multi-line approval panel renderer for mutation tool confirmations.
 *
 * Output goes to stderr — stdout is reserved for agent data.
 * Uses picocolors for terminal styling (box-drawing characters + color).
 *
 * Panel sections:
 *   - Header: "Mutation Approval Required"
 *   - Action: tool name
 *   - Parameters: key-value pairs (nested values JSON-stringified)
 *   - Changes: before/after values (optional — only if beforeAfter is provided and non-empty)
 *   - Reason: reasoning summary (optional — only if reasoningSummary is provided and non-empty)
 *   - Impact: provided impact text, or fallback warning
 *   - Prompt: valid response options (y / n / explain)
 */
import pc from "picocolors";
import { formatToolName } from "../output/format-tool-name.js";

const IMPACT_FALLBACK = "Impact unknown — review parameters carefully";
const DIVIDER = pc.dim("─".repeat(50));

const LABEL_WIDTH = 8;
function formatLabel(label: string): string {
  return `  ${label.padEnd(LABEL_WIDTH)}: `;
}

type BeforeAfterEntry = {
  readonly key: string;
  readonly current: string;
  readonly proposed: string;
};

/**
 * Renders a formatted approval panel string for a mutation tool.
 *
 * @param toolName        - The name of the tool requiring approval
 * @param toolInput       - The tool input parameters (key-value pairs)
 * @param impact          - Optional description of the expected impact
 * @param beforeAfter     - Optional array of before/after value pairs for changed settings
 * @param reasoningSummary - Optional reasoning text explaining why the change is recommended
 * @returns A formatted multi-line string ready for display on stderr
 */
export function renderApprovalPanel(
  toolName: string,
  toolInput: Record<string, unknown>,
  impact?: string,
  beforeAfter?: ReadonlyArray<BeforeAfterEntry>,
  reasoningSummary?: string,
): string {
  const header = pc.bold(pc.yellow("  Mutation Approval Required"));
  const action = `${formatLabel("Action")}${pc.bold(formatToolName(toolName))}`;

  const paramEntries = Object.entries(toolInput);
  const paramSection =
    paramEntries.length === 0
      ? "  (no parameters)"
      : paramEntries
          .map(([key, value]) => {
            const formatted = typeof value === "string" ? value : JSON.stringify(value, null, 2);
            return `  ${pc.dim(key)}: ${formatted}`;
          })
          .join("\n");

  const impactLine = `${formatLabel("Impact")}${impact ?? IMPACT_FALLBACK}`;
  const prompt = pc.dim(
    `${formatLabel("Respond")}y (proceed) | n (abort) | explain (show reasoning)`,
  );

  // Build optional before/after section
  const hasBeforeAfter = beforeAfter !== undefined && beforeAfter.length > 0;
  const beforeAfterSection = hasBeforeAfter
    ? beforeAfter
        .map(
          (entry) =>
            `  ${pc.dim(entry.key)}: ${entry.current} ${pc.yellow("->")} ${entry.proposed}`,
        )
        .join("\n")
    : null;

  // Build optional reasoning section
  const hasReasoning = reasoningSummary !== undefined && reasoningSummary.length > 0;
  const reasoningSection = hasReasoning ? `${formatLabel("Reason")}${reasoningSummary}` : null;

  // Assemble panel sections — leading blank line separates from preceding agent text
  const sections: string[] = ["", DIVIDER, header, "", action, paramSection, ""];

  if (beforeAfterSection !== null) {
    sections.push(beforeAfterSection, "");
  }

  if (reasoningSection !== null) {
    sections.push(reasoningSection, "");
  }

  sections.push(impactLine, "", prompt, DIVIDER, "");

  return sections.join("\n");
}
