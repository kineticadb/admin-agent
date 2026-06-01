import { describe, it, expect } from "vitest";
import { parseDataStr } from "./parse-data-str.js";

describe("parseDataStr", () => {
  it("parses valid JSON string into typed object", () => {
    const inner = { status_map: { head: "running" } };
    const result = parseDataStr<typeof inner>(JSON.stringify(inner), "raw");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(inner);
    }
  });

  it("returns ok:true with data:undefined when input is undefined", () => {
    const result = parseDataStr<unknown>(undefined, "raw");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeUndefined();
    }
  });

  it("returns ok:true with data:undefined when input is null", () => {
    const result = parseDataStr<unknown>(null, "raw");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeUndefined();
    }
  });

  it("returns ok:true with data:undefined when input is a number", () => {
    const result = parseDataStr<unknown>(42, "raw");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeUndefined();
    }
  });

  it("returns ok:false with error message on malformed JSON string", () => {
    const result = parseDataStr<unknown>("not-valid-json", "raw-body");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(200);
      expect(result.error).toMatch(/data_str parse error/);
      expect(result.raw).toBe("raw-body");
    }
  });

  it("preserves the raw body in error result", () => {
    const rawBody = '{"data_str": "bad"}';
    const result = parseDataStr<unknown>("{broken", rawBody);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.raw).toBe(rawBody);
    }
  });

  it("handles empty JSON string (valid JSON)", () => {
    const result = parseDataStr<Record<string, unknown>>("{}", "raw");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({});
    }
  });

  it("handles JSON array string", () => {
    const result = parseDataStr<string[]>('["a","b"]', "raw");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(["a", "b"]);
    }
  });
});
