import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApprovalGate } from "./gate.js";

// Mock @inquirer/prompts to control user responses
vi.mock("@inquirer/prompts", () => ({
  input: vi.fn(),
}));

// Mock ./display.js to verify it's called with correct args
vi.mock("./display.js", () => ({
  renderApprovalPanel: vi.fn(
    (_toolName: string, _toolInput: Record<string, unknown>, _impact?: string) => "MOCK_PANEL",
  ),
}));

import { input } from "@inquirer/prompts";
import { renderApprovalPanel } from "./display.js";

const mockInput = vi.mocked(input);
const mockRenderPanel = vi.mocked(renderApprovalPanel);

// Read-only predicate — tools named "read_*" are read-only, others are not
const isReadOnlyMock = (toolName: string): boolean => toolName.startsWith("read_");

const TOOL_USE_ID = "tu_test_001";
const AGENT_ID = "agent_test";

function makeOptions(
  overrides: Partial<{
    signal: AbortSignal;
    decisionReason: string;
    toolUseID: string;
    agentID: string;
  }> = {},
) {
  return {
    signal: new AbortController().signal,
    toolUseID: TOOL_USE_ID,
    agentID: AGENT_ID,
    ...overrides,
  };
}

describe("createApprovalGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  // Test 1: Read-only tool bypasses approval prompt entirely
  it("allows read-only tool immediately without prompting", async () => {
    const gate = createApprovalGate(isReadOnlyMock);
    const result = await gate("read_health_check", { target: "all" }, makeOptions());

    expect(result.behavior).toBe("allow");
    expect(mockInput).not.toHaveBeenCalled();
    expect(mockRenderPanel).not.toHaveBeenCalled();
  });

  // Test 2: Read-only tool — toolUseID passes through
  it("passes toolUseID through for read-only tools", async () => {
    const gate = createApprovalGate(isReadOnlyMock);
    const result = await gate("read_metrics", {}, makeOptions({ toolUseID: "tu_xyz" }));

    expect(result.toolUseID).toBe("tu_xyz");
  });

  // Test 3: Mutation tool + "y" — allow with original input
  it("mutation tool: renders panel and returns allow on 'y'", async () => {
    mockInput.mockResolvedValueOnce("y");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const gate = createApprovalGate(isReadOnlyMock);
    const toolInput = { key: "value" };
    const result = await gate("apply_config", toolInput, makeOptions());

    expect(mockRenderPanel).toHaveBeenCalledOnce();
    expect(mockRenderPanel).toHaveBeenCalledWith("apply_config", toolInput, undefined);
    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.updatedInput).toEqual(toolInput);
    }
    // Verify post-response spacing
    expect(stderrSpy).toHaveBeenCalledWith("\n");
    stderrSpy.mockRestore();
  });

  // Test 4: Mutation tool + "n" — deny with skip message
  it("mutation tool: returns deny with skip-and-continue message on 'n'", async () => {
    mockInput.mockResolvedValueOnce("n");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const gate = createApprovalGate(isReadOnlyMock);
    const result = await gate("restart_workers", { count: 3 }, makeOptions());

    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toContain("denied");
      expect(result.message).toContain("Skip");
    }
    // Verify post-response spacing
    expect(stderrSpy).toHaveBeenCalledWith("\n");
    stderrSpy.mockRestore();
  });

  // Test 5: Mutation tool + "n" — toolUseID passes through
  it("mutation tool: passes toolUseID through on deny", async () => {
    mockInput.mockResolvedValueOnce("n");
    const gate = createApprovalGate(isReadOnlyMock);
    const result = await gate("some_mutation", {}, makeOptions({ toolUseID: "tu_abc" }));

    expect(result.toolUseID).toBe("tu_abc");
  });

  // Test 6: mutation + "explain" then "y"
  it("mutation tool: shows reasoning on explain, re-prompts, returns allow on y", async () => {
    mockInput.mockResolvedValueOnce("explain").mockResolvedValueOnce("y");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const gate = createApprovalGate(isReadOnlyMock);
    const result = await gate(
      "apply_config",
      { key: "val" },
      makeOptions({ decisionReason: "Applying updated config to fix memory issue" }),
    );

    expect(result.behavior).toBe("allow");
    // console.error called at least twice: panel + reasoning
    expect(consoleSpy).toHaveBeenCalled();
    // Reasoning text should appear in one of the calls
    const allErrorCalls = consoleSpy.mock.calls.map((c) => String(c[0]));
    const hasReasoning = allErrorCalls.some((msg) =>
      msg.includes("Applying updated config to fix memory issue"),
    );
    expect(hasReasoning).toBe(true);
  });

  // Test 7: mutation + "explain" then "n"
  it("mutation tool: shows reasoning on explain, re-prompts, returns deny on n", async () => {
    mockInput.mockResolvedValueOnce("explain").mockResolvedValueOnce("n");

    const gate = createApprovalGate(isReadOnlyMock);
    const result = await gate(
      "drop_table",
      { table: "ki_data" },
      makeOptions({ decisionReason: "Cleaning up stale data" }),
    );

    expect(result.behavior).toBe("deny");
  });

  // Test 8: explain with no decisionReason — shows fallback message
  it("mutation tool: shows fallback on explain when no decisionReason", async () => {
    mockInput.mockResolvedValueOnce("explain").mockResolvedValueOnce("y");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const gate = createApprovalGate(isReadOnlyMock);
    await gate("some_mutation", {}, makeOptions({ decisionReason: undefined }));

    const allErrorCalls = consoleSpy.mock.calls.map((c) => String(c[0]));
    const hasFallback = allErrorCalls.some((msg) => msg.includes("Reasoning not available"));
    expect(hasFallback).toBe(true);
  });

  // Test 9: toolUseID passed through in allow result
  it("passes toolUseID through in allow result", async () => {
    mockInput.mockResolvedValueOnce("y");
    const gate = createApprovalGate(isReadOnlyMock);
    const result = await gate("mutate_x", {}, makeOptions({ toolUseID: "tu_special" }));

    expect(result.toolUseID).toBe("tu_special");
  });

  // Test 10: decisionReason passed as impact to renderApprovalPanel
  it("passes decisionReason as impact to renderApprovalPanel", async () => {
    mockInput.mockResolvedValueOnce("y");
    const gate = createApprovalGate(isReadOnlyMock);
    const reason = "Clearing GPU cache to reclaim memory";

    await gate("clear_cache", { type: "gpu" }, makeOptions({ decisionReason: reason }));

    expect(mockRenderPanel).toHaveBeenCalledWith("clear_cache", { type: "gpu" }, reason);
  });

  // Test 11: undefined decisionReason passed as undefined impact to renderApprovalPanel
  it("passes undefined impact to renderApprovalPanel when decisionReason is absent", async () => {
    mockInput.mockResolvedValueOnce("y");
    const gate = createApprovalGate(isReadOnlyMock);

    await gate("mutate_y", { param: "value" }, makeOptions({ decisionReason: undefined }));

    expect(mockRenderPanel).toHaveBeenCalledWith("mutate_y", { param: "value" }, undefined);
  });

  // Test 12: Unrecognized input re-prompts without exiting
  it("re-prompts silently on unrecognized input", async () => {
    mockInput
      .mockResolvedValueOnce("maybe") // unrecognized
      .mockResolvedValueOnce("yes") // unrecognized
      .mockResolvedValueOnce("n"); // final deny

    const gate = createApprovalGate(isReadOnlyMock);
    const result = await gate("some_tool", {}, makeOptions());

    expect(result.behavior).toBe("deny");
    expect(mockInput).toHaveBeenCalledTimes(3);
  });

  // Test 13: signal is passed to input() as second argument
  it("passes signal to input() as second arg context", async () => {
    mockInput.mockResolvedValueOnce("y");
    const ac = new AbortController();
    const gate = createApprovalGate(isReadOnlyMock);

    await gate("mutate_z", {}, makeOptions({ signal: ac.signal }));

    expect(mockInput).toHaveBeenCalledWith(
      { message: "Proceed? (y/n/explain):" },
      { signal: ac.signal },
    );
  });

  // Test 14: signal abort rejects input() — gate returns deny gracefully
  it("returns deny when signal aborts during input", async () => {
    const ac = new AbortController();
    mockInput.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));

    const gate = createApprovalGate(isReadOnlyMock);
    const result = await gate("mutate_w", {}, makeOptions({ signal: ac.signal }));

    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toContain("denied");
    }
  });
});
