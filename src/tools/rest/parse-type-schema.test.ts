/**
 * Tests for parseTypeSchema() — extracts column names and Kinetica-native
 * types from the Avro-like type_schemas JSON returned by /show/table
 * when get_column_info is enabled.
 */

import { describe, it, expect } from "vitest";
import { parseTypeSchema } from "./parse-type-schema.js";
import type { ColumnInfo } from "./parse-type-schema.js";

describe("parseTypeSchema", () => {
  it("parses a valid schema with string/int/float types", () => {
    const schema = JSON.stringify({
      type: "record",
      name: "test_type",
      fields: [
        { name: "col_str", type: "string" },
        { name: "col_int", type: "int" },
        { name: "col_float", type: "float" },
      ],
    });

    const result = parseTypeSchema(schema);

    expect(result).toEqual([
      { name: "col_str", type: "string" },
      { name: "col_int", type: "int" },
      { name: "col_float", type: "float" },
    ]);
  });

  it("extracts non-null type from union types ['type', 'null']", () => {
    const schema = JSON.stringify({
      type: "record",
      name: "nullable_type",
      fields: [
        { name: "id", type: "long" },
        { name: "name", type: ["string", "null"] },
        { name: "value", type: ["double", "null"] },
      ],
    });

    const result = parseTypeSchema(schema);

    expect(result).toEqual([
      { name: "id", type: "long" },
      { name: "name", type: "string" },
      { name: "value", type: "double" },
    ]);
  });

  it("extracts non-null type from union types ['null', 'type']", () => {
    const schema = JSON.stringify({
      type: "record",
      name: "nullable_type",
      fields: [{ name: "nullable_first", type: ["null", "bytes"] }],
    });

    const result = parseTypeSchema(schema);

    expect(result).toEqual([{ name: "nullable_first", type: "bytes" }]);
  });

  it("returns empty array on invalid JSON", () => {
    const result = parseTypeSchema("not-valid-json");
    expect(result).toEqual([]);
  });

  it("returns empty array when fields is missing", () => {
    const schema = JSON.stringify({
      type: "record",
      name: "no_fields",
    });

    const result = parseTypeSchema(schema);
    expect(result).toEqual([]);
  });

  it("returns empty array when type is not 'record'", () => {
    const schema = JSON.stringify({
      type: "enum",
      name: "not_record",
      symbols: ["A", "B"],
    });

    const result = parseTypeSchema(schema);
    expect(result).toEqual([]);
  });

  it("returns empty array when fields is not an array", () => {
    const schema = JSON.stringify({
      type: "record",
      name: "bad_fields",
      fields: "not-an-array",
    });

    const result = parseTypeSchema(schema);
    expect(result).toEqual([]);
  });

  it("skips fields with missing name or type", () => {
    const schema = JSON.stringify({
      type: "record",
      name: "partial_fields",
      fields: [
        { name: "good_col", type: "string" },
        { type: "int" }, // missing name
        { name: "no_type" }, // missing type
        { name: "also_good", type: "long" },
      ],
    });

    const result = parseTypeSchema(schema);

    expect(result).toEqual([
      { name: "good_col", type: "string" },
      { name: "also_good", type: "long" },
    ]);
  });

  it("handles empty fields array", () => {
    const schema = JSON.stringify({
      type: "record",
      name: "empty_fields",
      fields: [],
    });

    const result = parseTypeSchema(schema);
    expect(result).toEqual([]);
  });

  it("returns readonly array", () => {
    const schema = JSON.stringify({
      type: "record",
      name: "test",
      fields: [{ name: "col", type: "string" }],
    });

    const result = parseTypeSchema(schema);

    // TypeScript compile-time check — runtime we just verify it's an array
    expect(Array.isArray(result)).toBe(true);
    const item: ColumnInfo = result[0];
    expect(item.name).toBe("col");
    expect(item.type).toBe("string");
  });

  it("handles union with more than two types by taking first non-null", () => {
    const schema = JSON.stringify({
      type: "record",
      name: "multi_union",
      fields: [{ name: "multi", type: ["null", "string", "int"] }],
    });

    const result = parseTypeSchema(schema);

    expect(result).toEqual([{ name: "multi", type: "string" }]);
  });
});
