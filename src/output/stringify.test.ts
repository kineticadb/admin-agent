import { describe, it, expect } from "vitest";
import { stringifyValue } from "./stringify.js";

describe("stringifyValue", () => {
  it("returns empty string for null", () => {
    expect(stringifyValue(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(stringifyValue(undefined)).toBe("");
  });

  it("returns string values unchanged", () => {
    expect(stringifyValue("hello")).toBe("hello");
    expect(stringifyValue("")).toBe("");
  });

  it("stringifies numbers", () => {
    expect(stringifyValue(42)).toBe("42");
    expect(stringifyValue(3.14)).toBe("3.14");
    expect(stringifyValue(0)).toBe("0");
  });

  it("stringifies booleans", () => {
    expect(stringifyValue(true)).toBe("true");
    expect(stringifyValue(false)).toBe("false");
  });

  it("stringifies bigints", () => {
    expect(stringifyValue(9007199254740993n)).toBe("9007199254740993");
  });

  it("JSON-stringifies objects rather than rendering [object Object]", () => {
    expect(stringifyValue({ a: 1 })).toBe('{"a":1}');
    expect(stringifyValue({ nested: { b: true } })).toBe('{"nested":{"b":true}}');
  });

  it("JSON-stringifies arrays", () => {
    expect(stringifyValue([1, 2, 3])).toBe("[1,2,3]");
    expect(stringifyValue([])).toBe("[]");
  });

  it("stringifies symbols via Symbol.prototype.toString", () => {
    expect(stringifyValue(Symbol("x"))).toBe("Symbol(x)");
  });
});
