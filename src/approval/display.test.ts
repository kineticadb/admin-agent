import { describe, it, expect } from "vitest";
import { renderApprovalPanel } from "./display.js";

describe("renderApprovalPanel", () => {
  it("returns a string containing the formatted tool name", () => {
    const result = renderApprovalPanel("apply_config", { key: "val" });
    expect(result).toContain("apply config");
  });

  it("returns a string containing parameter keys and values", () => {
    const result = renderApprovalPanel("apply_config", { key: "val", count: 3 });
    expect(result).toContain("key");
    expect(result).toContain("val");
    expect(result).toContain("count");
    expect(result).toContain("3");
  });

  it("handles empty parameters object gracefully", () => {
    const result = renderApprovalPanel("apply_config", {});
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("apply config");
    // Should indicate no parameters
    expect(result).toContain("(no parameters)");
  });

  it("handles nested parameter values by stringifying them", () => {
    const nested = { server: { host: "localhost", port: 8080 } };
    const result = renderApprovalPanel("configure_server", nested);
    expect(result).toContain("server");
    expect(result).toContain("localhost");
  });

  it("renders the provided impact string in output", () => {
    const impact = "This will restart the worker processes";
    const result = renderApprovalPanel("restart_workers", { count: 2 }, impact);
    expect(result).toContain(impact);
  });

  it("renders fallback impact message when impact is undefined", () => {
    const result = renderApprovalPanel("some_tool", { key: "val" });
    expect(result).toContain("Impact unknown — review parameters carefully");
  });

  it("renders fallback impact message when impact is explicitly undefined", () => {
    const result = renderApprovalPanel("some_tool", { key: "val" }, undefined);
    expect(result).toContain("Impact unknown — review parameters carefully");
  });

  it("panel contains response options prompt", () => {
    const result = renderApprovalPanel("any_tool", {});
    // Should mention the three valid responses
    expect(result).toContain("y");
    expect(result).toContain("n");
    expect(result).toContain("explain");
  });

  // ---- New tests for enhanced approval panel ----

  it("renders 'Changes:' section with 'Current' and 'Proposed' values when beforeAfter is provided", () => {
    const beforeAfter = [{ key: "sm_omp_threads", current: "4", proposed: "8" }];
    const result = renderApprovalPanel("apply_config", { param: "val" }, undefined, beforeAfter);
    expect(result).toContain("sm_omp_threads");
    expect(result).toContain("4");
    expect(result).toContain("8");
    expect(result).toContain("->");
  });

  it("renders multiple before/after entries when provided", () => {
    const beforeAfter = [
      { key: "sm_omp_threads", current: "4", proposed: "8" },
      { key: "request_timeout", current: "20", proposed: "30" },
    ];
    const result = renderApprovalPanel("apply_config", {}, undefined, beforeAfter);
    expect(result).toContain("sm_omp_threads");
    expect(result).toContain("request_timeout");
    expect(result).toContain("20");
    expect(result).toContain("30");
  });

  it("renders reasoning summary when reasoningSummary is provided", () => {
    const reasoning = "Recommended because thread_count=4 is below minimum";
    const result = renderApprovalPanel(
      "apply_config",
      { param: "val" },
      undefined,
      undefined,
      reasoning,
    );
    expect(result).toContain("Reason");
    expect(result).toContain("Recommended because thread_count=4 is below minimum");
  });

  it("renders both before/after section and reasoning section when both are provided", () => {
    const beforeAfter = [{ key: "sm_omp_threads", current: "4", proposed: "8" }];
    const reasoning = "Thread count is below the 2-rank minimum";
    const result = renderApprovalPanel(
      "apply_config",
      { param: "val" },
      "High impact",
      beforeAfter,
      reasoning,
    );
    expect(result).toContain("sm_omp_threads");
    expect(result).toContain("->");
    expect(result).toContain("Reason");
    expect(result).toContain("Thread count is below");
    expect(result).toContain("High impact");
  });

  it("does not render before/after section when beforeAfter is empty array", () => {
    const result = renderApprovalPanel("apply_config", { param: "val" }, undefined, []);
    expect(result).not.toContain("->");
    expect(result).not.toContain("Changes:");
  });

  it("backward compatible — omitting new params renders same as 3-arg call", () => {
    const threeArg = renderApprovalPanel("apply_config", { key: "val" }, "some impact");
    const fiveArg = renderApprovalPanel(
      "apply_config",
      { key: "val" },
      "some impact",
      undefined,
      undefined,
    );
    expect(fiveArg).toBe(threeArg);
  });

  it("backward compatible — undefined for new params renders same as 3-arg call", () => {
    const threeArg = renderApprovalPanel("apply_config", {});
    const withUndefined = renderApprovalPanel("apply_config", {}, undefined, undefined, undefined);
    expect(withUndefined).toBe(threeArg);
  });

  it("has leading blank line before divider for visual separation", () => {
    const result = renderApprovalPanel("some_tool", { key: "val" });
    expect(result.startsWith("\n")).toBe(true);
  });

  it("has trailing blank line after bottom divider for visual separation", () => {
    const result = renderApprovalPanel("some_tool", { key: "val" });
    expect(result.endsWith("\n")).toBe(true);
  });

  it("aligns labels at consistent column width", () => {
    const result = renderApprovalPanel("some_tool", { key: "val" });
    // All labels should use the same padding format: "  Label   : "
    expect(result).toContain("  Action  : ");
    expect(result).toContain("  Impact  : ");
    expect(result).toContain("  Respond : ");
  });
});
