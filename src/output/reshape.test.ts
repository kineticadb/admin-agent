import { describe, it, expect } from "vitest";
import { flatObjectToRows, nestedObjectToRows } from "./reshape.js";

describe("flatObjectToRows", () => {
  it("converts flat object to array of key-value rows", () => {
    const input = { a: "x", b: "y" };
    expect(flatObjectToRows(input)).toEqual([
      { key: "a", value: "x" },
      { key: "b", value: "y" },
    ]);
  });

  it("uses custom labels when provided", () => {
    const input = { head: "running", worker: "stopped" };
    expect(flatObjectToRows(input, "component", "status")).toEqual([
      { component: "head", status: "running" },
      { component: "worker", status: "stopped" },
    ]);
  });

  it("returns empty array for empty object", () => {
    expect(flatObjectToRows({})).toEqual([]);
  });

  it("coerces non-string values to strings", () => {
    const input = { count: 42, active: true };
    expect(flatObjectToRows(input)).toEqual([
      { key: "count", value: "42" },
      { key: "active", value: "true" },
    ]);
  });

  it("JSON-stringifies nested object values instead of [object Object]", () => {
    const input = { nested: { a: 1 } };
    expect(flatObjectToRows(input)).toEqual([{ key: "nested", value: '{"a":1}' }]);
  });

  it("does not mutate the input object", () => {
    const input = { a: "x" };
    const copy = JSON.stringify(input);
    flatObjectToRows(input);
    expect(JSON.stringify(input)).toBe(copy);
  });
});

describe("nestedObjectToRows", () => {
  it("converts nested object to array of flattened rows", () => {
    const input = {
      node_0: { cpu: "50%", mem: "8GB" },
      node_1: { cpu: "60%", mem: "12GB" },
    };
    expect(nestedObjectToRows(input)).toEqual([
      { name: "node_0", cpu: "50%", mem: "8GB" },
      { name: "node_1", cpu: "60%", mem: "12GB" },
    ]);
  });

  it("uses custom key label when provided", () => {
    const input = {
      node_0: { cpu: "50%" },
    };
    expect(nestedObjectToRows(input, "node")).toEqual([{ node: "node_0", cpu: "50%" }]);
  });

  it("handles union of sub-object keys with missing values as empty string", () => {
    const input = {
      node_0: { cpu: "50%" },
      node_1: { cpu: "60%", gpu: "80%" },
    };
    expect(nestedObjectToRows(input)).toEqual([
      { name: "node_0", cpu: "50%", gpu: "" },
      { name: "node_1", cpu: "60%", gpu: "80%" },
    ]);
  });

  it("JSON-stringifies deeply nested sub-object values instead of [object Object]", () => {
    const input = {
      n: { info: { deep: true }, status: "ok" },
    };
    const result = nestedObjectToRows(input);
    expect(result).toEqual([{ name: "n", info: '{"deep":true}', status: "ok" }]);
  });

  it("skips entries whose values are not plain objects", () => {
    const input = {
      node_0: { cpu: "50%" },
      version: "7.2.1" as unknown,
      count: 42 as unknown,
    } as Record<string, Record<string, unknown>>;
    expect(nestedObjectToRows(input)).toEqual([{ name: "node_0", cpu: "50%" }]);
  });

  it("returns empty array for empty object", () => {
    expect(nestedObjectToRows({})).toEqual([]);
  });

  it("does not mutate the input object", () => {
    const input = { node_0: { cpu: "50%" } };
    const copy = JSON.stringify(input);
    nestedObjectToRows(input);
    expect(JSON.stringify(input)).toBe(copy);
  });
});
