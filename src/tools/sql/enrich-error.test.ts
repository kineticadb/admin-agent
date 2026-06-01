/**
 * Tests for enrichSqlError — appends verified column names to SQL error messages
 * when a matching ki_catalog table is found in the statement.
 */

import { describe, it, expect } from "vitest";
import { enrichSqlError } from "./enrich-error.js";
import type { CatalogSchemas } from "../../agent/discover-schemas.js";

// ---------------------------------------------------------------------------
// Test schemas fixture
// ---------------------------------------------------------------------------

const schemas: CatalogSchemas = {
  tables: new Map([
    ["ki_tiered_objects", ["object_name", "tier", "rank_id", "owner_resource_group"]],
    ["ki_obj_stat", ["object_name", "total_bytes", "row_count"]],
    ["ki_query_history", ["request_id", "submitter", "sql_text", "start_time", "stop_time"]],
  ]),
};

// ---------------------------------------------------------------------------
// enrichSqlError
// ---------------------------------------------------------------------------

describe("enrichSqlError", () => {
  it("appends verified columns when table matches", () => {
    const error = "Column 'data_type' not found";
    const statement = "SELECT data_type FROM ki_catalog.ki_tiered_objects LIMIT 10";
    const result = enrichSqlError(error, statement, schemas);
    expect(result).toContain("Column 'data_type' not found");
    expect(result).toContain("Verified columns for ki_tiered_objects:");
    expect(result).toContain("object_name");
    expect(result).toContain("tier");
    expect(result).toContain("rank_id");
    expect(result).toContain("owner_resource_group");
  });

  it("returns original error when table not in schemas", () => {
    const error = "Column 'foo' not found";
    const statement = "SELECT foo FROM ki_catalog.ki_unknown_table LIMIT 10";
    const result = enrichSqlError(error, statement, schemas);
    expect(result).toBe(error);
  });

  it("returns original error when no FROM ki_catalog. in statement", () => {
    const error = "Some SQL error";
    const statement = "SELECT * FROM user_table";
    const result = enrichSqlError(error, statement, schemas);
    expect(result).toBe(error);
  });

  it("returns original error when schemas is undefined", () => {
    const error = "Column 'data_type' not found";
    const statement = "SELECT data_type FROM ki_catalog.ki_tiered_objects LIMIT 10";
    const result = enrichSqlError(error, statement, undefined);
    expect(result).toBe(error);
  });

  it("handles aliased table refs (e.g., FROM ki_catalog.ki_tiered_objects t)", () => {
    const error = "Column 'bad_col' not found";
    const statement = "SELECT t.bad_col FROM ki_catalog.ki_tiered_objects t WHERE t.tier = 'GPU'";
    const result = enrichSqlError(error, statement, schemas);
    expect(result).toContain("Verified columns for ki_tiered_objects:");
    expect(result).toContain("object_name");
  });

  it("handles case-insensitive FROM keyword", () => {
    const error = "Column not found";
    const statement = "select x from ki_catalog.ki_obj_stat limit 10";
    const result = enrichSqlError(error, statement, schemas);
    expect(result).toContain("Verified columns for ki_obj_stat:");
    expect(result).toContain("total_bytes");
  });

  it("matches JOIN ki_catalog. references too", () => {
    const error = "Column 'bad_col' not found";
    const statement =
      "SELECT a.x FROM ki_catalog.ki_query_history a JOIN ki_catalog.ki_obj_stat b ON a.id = b.id";
    const result = enrichSqlError(error, statement, schemas);
    // Should find at least one table — picks the first match
    expect(result).toContain("Verified columns for ki_query_history:");
  });

  it("does not mutate the original error string", () => {
    const error = "Column 'data_type' not found";
    const original = error;
    const statement = "SELECT data_type FROM ki_catalog.ki_tiered_objects LIMIT 10";
    enrichSqlError(error, statement, schemas);
    expect(error).toBe(original);
  });
});
