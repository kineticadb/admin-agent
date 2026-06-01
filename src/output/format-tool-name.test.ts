import { describe, it, expect } from "vitest";
import { formatToolName } from "./format-tool-name.js";

describe("formatToolName", () => {
  it("strips mcp server prefix and kinetica prefix", () => {
    expect(formatToolName("mcp__kinetica-diagnostics__kinetica_execute_mutation_sql")).toBe(
      "execute mutation sql",
    );
  });

  it("strips kinetica_ prefix without mcp prefix", () => {
    expect(formatToolName("kinetica_health_check")).toBe("health check");
  });

  it("replaces underscores with spaces for unknown prefixes", () => {
    expect(formatToolName("some_other_tool")).toBe("some other tool");
  });

  it("passes through simple names unchanged", () => {
    expect(formatToolName("restart")).toBe("restart");
  });

  it("handles mcp prefix with different server names", () => {
    expect(formatToolName("mcp__other-server__kinetica_get_metrics")).toBe("get metrics");
  });

  it("handles mcp prefix without kinetica_ prefix on inner name", () => {
    expect(formatToolName("mcp__kinetica-diagnostics__custom_tool_name")).toBe("custom tool name");
  });

  it("handles empty string", () => {
    expect(formatToolName("")).toBe("");
  });
});
