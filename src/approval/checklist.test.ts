/**
 * Tests for the checklist UI module.
 *
 * renderChecklist is pure (no I/O) — tested directly.
 * showChecklist wraps checkbox() from @inquirer/prompts — tested via mock.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @inquirer/prompts before importing the module under test
vi.mock("@inquirer/prompts", () => ({
  checkbox: vi.fn(),
}));

import { checkbox } from "@inquirer/prompts";
import { renderChecklist, showChecklist, type ChecklistItem } from "./checklist.js";

const mockCheckbox = vi.mocked(checkbox);

// ---------------------------------------------------------------------------
// renderChecklist (pure function)
// ---------------------------------------------------------------------------

describe("renderChecklist", () => {
  const items: readonly ChecklistItem[] = [
    { label: "vendor_id: VARCHAR(50) → VARCHAR(50, DICT)", description: "Add DICT encoding" },
    { label: "trip_type: VARCHAR(30) → VARCHAR(30, TEXT_SEARCH)", description: "Add TEXT_SEARCH" },
  ];

  it("includes the header text", () => {
    const result = renderChecklist("ALTER TABLE Column Changes", "optimize columns", items);
    expect(result).toContain("ALTER TABLE Column Changes");
  });

  it("includes the summary text", () => {
    const result = renderChecklist("Header", "Reduce memory footprint", items);
    expect(result).toContain("Reduce memory footprint");
  });

  it("includes numbered items with labels", () => {
    const result = renderChecklist("Header", "summary", items);
    expect(result).toContain("1.");
    expect(result).toContain("vendor_id: VARCHAR(50) → VARCHAR(50, DICT)");
    expect(result).toContain("2.");
    expect(result).toContain("trip_type: VARCHAR(30) → VARCHAR(30, TEXT_SEARCH)");
  });

  it("includes item descriptions", () => {
    const result = renderChecklist("Header", "summary", items);
    expect(result).toContain("Add DICT encoding");
    expect(result).toContain("Add TEXT_SEARCH");
  });

  it("shows item count", () => {
    const result = renderChecklist("Header", "summary", items);
    expect(result).toContain("2 proposed column change(s)");
  });

  it("returns a non-empty string for single item", () => {
    const single: readonly ChecklistItem[] = [
      { label: "col1: INT → INT(DICT)", description: "reason" },
    ];
    const result = renderChecklist("Header", "summary", single);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("1 proposed column change(s)");
  });

  it("returns a string type", () => {
    const result = renderChecklist("Header", "summary", items);
    expect(typeof result).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// showChecklist (I/O — mocked checkbox)
// ---------------------------------------------------------------------------

describe("showChecklist", () => {
  const items: readonly ChecklistItem[] = [
    { label: "col1: VARCHAR(50) → VARCHAR(50, DICT)", description: "Add DICT" },
    { label: "col2: VARCHAR(30) → VARCHAR(30, DICT)", description: "Add DICT" },
    { label: "col3: INT → INT(DICT)", description: "Add DICT" },
  ];

  beforeEach(() => {
    mockCheckbox.mockReset();
    // Suppress stderr output in tests
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  it("returns confirmed with all indices when all selected", async () => {
    mockCheckbox.mockResolvedValueOnce([0, 1, 2]);
    const result = await showChecklist("Header", "summary", items);
    expect(result).toEqual({ action: "confirmed", selectedIndices: [0, 1, 2] });
  });

  it("returns confirmed with partial selection", async () => {
    mockCheckbox.mockResolvedValueOnce([0, 2]);
    const result = await showChecklist("Header", "summary", items);
    expect(result).toEqual({ action: "confirmed", selectedIndices: [0, 2] });
  });

  it("returns cancelled when no items selected (empty array)", async () => {
    mockCheckbox.mockResolvedValueOnce([]);
    const result = await showChecklist("Header", "summary", items);
    expect(result).toEqual({ action: "cancelled" });
  });

  it("returns cancelled when checkbox throws (e.g. abort/escape)", async () => {
    mockCheckbox.mockRejectedValueOnce(new Error("User force closed"));
    const result = await showChecklist("Header", "summary", items);
    expect(result).toEqual({ action: "cancelled" });
  });

  it("passes correct choices to checkbox with all items checked by default", async () => {
    mockCheckbox.mockResolvedValueOnce([0]);
    await showChecklist("Header", "summary", items);

    expect(mockCheckbox).toHaveBeenCalledOnce();
    const callArgs = mockCheckbox.mock.calls[0][0] as unknown as {
      choices: ReadonlyArray<{ checked: boolean }>;
    };
    expect(callArgs.choices).toHaveLength(3);

    // Verify all items are checked by default
    for (const choice of callArgs.choices) {
      expect(choice.checked).toBe(true);
    }
  });

  it("renders panel to stderr before showing checkbox", async () => {
    mockCheckbox.mockResolvedValueOnce([0]);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await showChecklist("My Header", "my summary", items);

    // stderr.write should have been called with the panel content
    expect(stderrSpy).toHaveBeenCalled();
    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("My Header");
  });
});
