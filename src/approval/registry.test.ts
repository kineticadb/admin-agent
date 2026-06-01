import { describe, it, expect } from "vitest";
import { createRegistry, isReadOnlyTool, READ_ONLY_TOOLS } from "./registry.js";

describe("createRegistry", () => {
  it("default registry is empty — no tools pre-approved in Phase 1", () => {
    const registry = createRegistry();
    expect(registry.tools.size).toBe(0);
  });

  it("isReadOnlyTool returns false for unknown tools (default-deny)", () => {
    const registry = createRegistry();
    expect(registry.isReadOnlyTool("unknown_new_tool")).toBe(false);
  });

  it("isReadOnlyTool returns false for known mutation tools", () => {
    const registry = createRegistry();
    expect(registry.isReadOnlyTool("kinetica_apply_config")).toBe(false);
  });

  it("registerReadOnlyTool returns a NEW registry with the added tool", () => {
    const registry = createRegistry();
    const updated = registry.registerReadOnlyTool("kinetica_health_check");
    expect(updated.isReadOnlyTool("kinetica_health_check")).toBe(true);
  });

  it("original registry is NOT mutated after registerReadOnlyTool", () => {
    const registry = createRegistry();
    registry.registerReadOnlyTool("kinetica_health_check");
    // Original registry must still not contain the tool
    expect(registry.isReadOnlyTool("kinetica_health_check")).toBe(false);
    expect(registry.tools.size).toBe(0);
  });

  it("registerReadOnlyTool preserves previously-registered tools", () => {
    const registry = createRegistry().registerReadOnlyTool("tool_a").registerReadOnlyTool("tool_b");
    expect(registry.isReadOnlyTool("tool_a")).toBe(true);
    expect(registry.isReadOnlyTool("tool_b")).toBe(true);
    expect(registry.isReadOnlyTool("tool_c")).toBe(false);
  });

  it("createRegistry accepts an initial set and respects it", () => {
    const initial: ReadonlySet<string> = new Set(["kinetica_health_check"]);
    const registry = createRegistry(initial);
    expect(registry.isReadOnlyTool("kinetica_health_check")).toBe(true);
    expect(registry.isReadOnlyTool("other_tool")).toBe(false);
  });
});

describe("module-level convenience exports", () => {
  it("isReadOnlyTool returns false for unknown tools (default-deny)", () => {
    expect(isReadOnlyTool("kinetica_health_check")).toBe(false);
    expect(isReadOnlyTool("any_unregistered_tool")).toBe(false);
  });

  it("READ_ONLY_TOOLS is an empty ReadonlySet in Phase 1", () => {
    expect(READ_ONLY_TOOLS.size).toBe(0);
  });
});
