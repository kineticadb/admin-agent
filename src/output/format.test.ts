import { describe, it, expect } from "vitest";
import { formatOutput } from "./format.js";
import { flatObjectToRows, nestedObjectToRows } from "./reshape.js";

describe("formatOutput", () => {
  describe("null and undefined inputs", () => {
    it("returns (empty) for null", () => {
      expect(formatOutput(null)).toBe("(empty)");
    });

    it("returns (empty) for undefined", () => {
      expect(formatOutput(undefined)).toBe("(empty)");
    });
  });

  describe("empty array", () => {
    it("returns (no results) for empty array", () => {
      expect(formatOutput([])).toBe("(no results)");
    });
  });

  describe("array of objects", () => {
    it("produces a markdown table with header, separator, and data rows", () => {
      const input = [
        { name: "Alice", age: 30 },
        { name: "Bob", age: 25 },
      ];
      const result = formatOutput(input);
      const lines = result.split("\n");
      expect(lines[0]).toBe("| name  | age |");
      expect(lines[1]).toBe("| ----- | --- |");
      expect(lines[2]).toBe("| Alice | 30  |");
      expect(lines[3]).toBe("| Bob   | 25  |");
    });

    it("derives column headers from Object.keys() of first element", () => {
      const input = [{ id: 1, status: "ok", host: "node1" }];
      const result = formatOutput(input);
      expect(result.startsWith("| id  | status | host  |")).toBe(true);
    });

    it("coerces null and undefined cell values to empty string", () => {
      const input = [{ a: null, b: undefined, c: "valid" }];
      const result = formatOutput(input);
      const dataRow = result.split("\n")[2];
      expect(dataRow).toBe("|     |     | valid |");
    });

    it("coerces number and boolean cell values to string", () => {
      const input = [{ flag: true, count: 42 }];
      const result = formatOutput(input);
      const dataRow = result.split("\n")[2];
      expect(dataRow).toBe("| true | 42    |");
    });

    it("aligns columns with uniform padding", () => {
      const input = [
        { name: "very_long_name", status: "ok", host: "short" },
        { name: "x", status: "running_status_long", host: "another_long_host" },
      ];
      const result = formatOutput(input);
      const lines = result.split("\n");
      expect(lines[0]).toBe("| name           | status              | host              |");
      expect(lines[1]).toBe("| -------------- | ------------------- | ----------------- |");
      expect(lines[2]).toBe("| very_long_name | ok                  | short             |");
      expect(lines[3]).toBe("| x              | running_status_long | another_long_host |");
    });

    it("produces lines of equal length for any table", () => {
      const input = [
        { a: "short", b: "x" },
        { a: "y", b: "much_longer_value" },
      ];
      const result = formatOutput(input);
      const lines = result.split("\n");
      const lengths = new Set(lines.map((l) => l.length));
      expect(lengths.size).toBe(1);
    });

    it("pads a single column to the widest cell", () => {
      const input = [{ col: "hi" }, { col: "hello_world" }];
      const result = formatOutput(input);
      const lines = result.split("\n");
      expect(lines[0]).toBe("| col         |");
      expect(lines[1]).toBe("| ----------- |");
      expect(lines[2]).toBe("| hi          |");
      expect(lines[3]).toBe("| hello_world |");
    });

    it("JSON-stringifies nested object cell values instead of [object Object]", () => {
      const input = [{ name: "x", config: { nested: true } }];
      const result = formatOutput(input);
      const dataRow = result.split("\n")[2];
      expect(dataRow).toContain('{"nested":true}');
      expect(dataRow).not.toContain("[object Object]");
    });

    it("handles mixed types with correct padding", () => {
      const input = [{ flag: true, count: 42, label: "done" }];
      const result = formatOutput(input);
      const lines = result.split("\n");
      expect(lines[0]).toBe("| flag | count | label |");
      expect(lines[2]).toBe("| true | 42    | done  |");
    });

    it("handles a single-element array", () => {
      const input = [{ key: "val" }];
      const result = formatOutput(input);
      const lines = result.split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe("| key |");
      expect(lines[1]).toBe("| --- |");
      expect(lines[2]).toBe("| val |");
    });
  });

  describe("array of primitives", () => {
    it("renders each string element on its own line", () => {
      const input = ["alpha", "beta", "gamma"];
      expect(formatOutput(input)).toBe("alpha\nbeta\ngamma");
    });

    it("renders each number element on its own line", () => {
      const input = [1, 2, 3];
      expect(formatOutput(input)).toBe("1\n2\n3");
    });
  });

  describe("flat object", () => {
    it("renders each key-value pair as **key:** value lines", () => {
      const input = { host: "node1", port: "8080" };
      const result = formatOutput(input);
      expect(result).toBe("**host:** node1\n**port:** 8080");
    });

    it("handles an object with a single key", () => {
      const input = { status: "healthy" };
      expect(formatOutput(input)).toBe("**status:** healthy");
    });
  });

  describe("nested object", () => {
    it("renders nested object value recursively as subsection", () => {
      const input = { meta: { rows: 5, source: "ki_catalog" } };
      const result = formatOutput(input);
      expect(result).toBe("**meta:**\n**rows:** 5\n**source:** ki_catalog");
    });

    it("renders nested array value recursively", () => {
      const input = { items: ["x", "y"] };
      const result = formatOutput(input);
      expect(result).toBe("**items:**\nx\ny");
    });
  });

  describe("primitives", () => {
    it("returns string representation of a string primitive", () => {
      expect(formatOutput("hello")).toBe("hello");
    });

    it("returns string representation of a number primitive", () => {
      expect(formatOutput(42)).toBe("42");
    });

    it("returns string representation of a boolean primitive", () => {
      expect(formatOutput(true)).toBe("true");
    });
  });

  describe("integration: reshaped objects render as tables", () => {
    it("renders reshaped flat object as table (health.ts shape)", () => {
      const statusMap = { head: "running", worker_1: "running", worker_2: "stopped" };
      const rows = flatObjectToRows(statusMap, "component", "status");
      const result = formatOutput(rows);
      const lines = result.split("\n");
      expect(lines[0]).toBe("| component | status  |");
      expect(lines[1]).toBe("| --------- | ------- |");
      expect(lines[2]).toBe("| head      | running |");
      expect(lines[3]).toBe("| worker_1  | running |");
      expect(lines[4]).toBe("| worker_2  | stopped |");
    });

    it("renders reshaped nested object as table (metrics.ts shape)", () => {
      const statsMap = {
        node_0: { cpu: "50%", memory: "8GB" },
        node_1: { cpu: "60%", memory: "12GB" },
      };
      const rows = nestedObjectToRows(statsMap, "node");
      const result = formatOutput(rows);
      const lines = result.split("\n");
      expect(lines[0]).toBe("| node   | cpu | memory |");
      expect(lines[1]).toBe("| ------ | --- | ------ |");
      expect(lines[2]).toBe("| node_0 | 50% | 8GB    |");
      expect(lines[3]).toBe("| node_1 | 60% | 12GB   |");
    });
  });

  describe("immutability", () => {
    it("does not mutate the input array", () => {
      const input = [{ a: 1 }];
      const copy = JSON.stringify(input);
      formatOutput(input);
      expect(JSON.stringify(input)).toBe(copy);
    });

    it("does not mutate the input object", () => {
      const input = { a: "b" };
      const copy = JSON.stringify(input);
      formatOutput(input);
      expect(JSON.stringify(input)).toBe(copy);
    });
  });
});
