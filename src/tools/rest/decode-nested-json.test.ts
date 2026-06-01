import { describe, it, expect } from "vitest";
import { decodeNestedJsonStrings } from "./decode-nested-json.js";

describe("decodeNestedJsonStrings", () => {
  it("passes through flat objects with non-JSON string values", () => {
    const input = { name: "node_0", status: "running" };
    expect(decodeNestedJsonStrings(input)).toEqual(input);
  });

  it("passes through non-string values unchanged", () => {
    const input = { count: 42, active: true, data: null };
    expect(decodeNestedJsonStrings(input)).toEqual(input);
  });

  it("recursively decodes JSON string values into objects", () => {
    const inner = { cpu: "50%", memory: "8GB" };
    const input = { rank_0: JSON.stringify(inner) };
    expect(decodeNestedJsonStrings(input)).toEqual({ rank_0: inner });
  });

  it("preserves non-JSON strings", () => {
    const input = { name: "not-json", value: "also not json {" };
    expect(decodeNestedJsonStrings(input)).toEqual(input);
  });

  it("decodes triple-encoded values", () => {
    const deep = { used_bytes: 1024 };
    const mid = { tier: JSON.stringify(deep) };
    const input = { rank: JSON.stringify(mid) };

    expect(decodeNestedJsonStrings(input)).toEqual({
      rank: { tier: deep },
    });
  });

  it("parses JSON string values that decode to primitives", () => {
    const input = { count: JSON.stringify(42), flag: JSON.stringify(true) };
    expect(decodeNestedJsonStrings(input)).toEqual({ count: 42, flag: true });
  });

  it("does not recurse into JSON arrays", () => {
    const input = { items: JSON.stringify([1, 2, 3]) };
    expect(decodeNestedJsonStrings(input)).toEqual({ items: [1, 2, 3] });
  });

  it("does not mutate the input object", () => {
    const inner = { cpu: "50%" };
    const input = { rank: JSON.stringify(inner) };
    const copy = JSON.stringify(input);
    decodeNestedJsonStrings(input);
    expect(JSON.stringify(input)).toBe(copy);
  });
});
