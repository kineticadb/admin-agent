/**
 * Reusable checklist UI for batch mutation approval.
 *
 * Two exports:
 *   renderChecklist()  — pure function, returns styled panel string (testable, no I/O)
 *   showChecklist()    — renders panel to stderr, shows interactive checkbox, returns selection
 *
 * Uses @inquirer/prompts checkbox() (already in dependencies) and picocolors for styling.
 * Follows the same visual pattern as display.ts (approval panel).
 */
import { checkbox } from "../output/themed-prompts.js";
import pc from "picocolors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single item displayed in the checklist. */
export type ChecklistItem = {
  readonly label: string;
  readonly description: string;
};

/** Result of the checklist interaction. */
export type ChecklistResult =
  | { readonly action: "confirmed"; readonly selectedIndices: readonly number[] }
  | { readonly action: "cancelled" };

// ---------------------------------------------------------------------------
// renderChecklist (pure)
// ---------------------------------------------------------------------------

const DIVIDER = pc.dim("─".repeat(60));

/**
 * Renders a styled panel string for the checklist header.
 * Pure function — no I/O. Exported for direct testing.
 *
 * @param header  - Panel title (e.g. "ALTER TABLE Column Changes")
 * @param summary - Rationale text from the agent
 * @param items   - Array of checklist items to display
 * @returns Formatted multi-line string ready for stderr
 */
export function renderChecklist(
  header: string,
  summary: string,
  items: readonly ChecklistItem[],
): string {
  const lines: string[] = [
    "",
    DIVIDER,
    `  ${pc.bold(pc.yellow(header))}`,
    "",
    `  ${pc.dim("Summary:")} ${summary}`,
    "",
    `  ${pc.bold(`${items.length} proposed column change(s):`)}`,
    "",
  ];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    lines.push(`  ${pc.bold(`${i + 1}.`)} ${item.label}`, `     ${pc.dim(item.description)}`);
  }

  lines.push("", DIVIDER, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// showChecklist (I/O)
// ---------------------------------------------------------------------------

/**
 * Renders the checklist panel to stderr and shows an interactive checkbox prompt.
 *
 * All items are checked by default (opt-out model). The operator toggles items
 * with space and confirms with enter. Empty selection or escape returns cancelled.
 *
 * @param header  - Panel title
 * @param summary - Rationale text
 * @param items   - Array of checklist items
 * @returns ChecklistResult with selected indices or cancellation
 */
export async function showChecklist(
  header: string,
  summary: string,
  items: readonly ChecklistItem[],
): Promise<ChecklistResult> {
  // Render the panel header on stderr
  const panel = renderChecklist(header, summary, items);
  process.stderr.write(panel);

  try {
    const selected = await checkbox<number>({
      message: "Select columns to alter (space to toggle, enter to confirm):",
      choices: items.map((item, i) => ({
        value: i,
        name: item.label,
        description: item.description,
        checked: true,
      })),
      loop: false,
    });

    if (selected.length === 0) {
      return { action: "cancelled" };
    }

    return { action: "confirmed", selectedIndices: selected };
  } catch {
    // AbortSignal or user escape — treat as cancellation
    return { action: "cancelled" };
  }
}
