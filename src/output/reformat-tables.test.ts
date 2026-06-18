import { describe, it, expect } from "vitest";
import pc from "picocolors";
import { reformatTables } from "./reformat-tables.js";
import { purple } from "./brand-colors.js";

/** Strip ANSI escape codes for visual width comparison. */
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

describe("reformatTables", () => {
  describe("no tables — passthrough", () => {
    it("returns empty string unchanged", () => {
      expect(reformatTables("")).toBe("");
    });

    it("returns plain text unchanged", () => {
      const text = "Hello world\nNo tables here.";
      expect(reformatTables(text)).toBe(text);
    });

    it("returns text with pipe characters that are not tables unchanged", () => {
      const text = "Use cmd | grep foo to filter.";
      expect(reformatTables(text)).toBe(text);
    });
  });

  describe("single table — column alignment", () => {
    it("re-pads columns to uniform width", () => {
      const input = ["| Name | Age |", "| --- | --- |", "| Alice | 30 |", "| Bob | 25 |"].join(
        "\n",
      );

      const result = reformatTables(input);
      const lines = result.split("\n");

      // Top border
      expect(lines[0]).toBe("+-------+-----+");
      // Header
      expect(lines[1]).toBe("| Name  | Age |");
      // Separator
      expect(lines[2]).toBe("+-------+-----+");
      // Data rows
      expect(lines[3]).toBe("| Alice | 30  |");
      expect(lines[4]).toBe("| Bob   | 25  |");
      // Bottom border
      expect(lines[5]).toBe("+-------+-----+");
    });

    it("produces lines of equal visual length for all rows in a table", () => {
      const input = [
        "| Node | CPU | Memory | Status |",
        "| --- | --- | --- | --- |",
        "| **node_0** | 45% | 12 GB | OK |",
        "| **node_1** | 92% | 15 GB | WARN |",
      ].join("\n");

      const result = reformatTables(input);
      const lines = result.split("\n");
      const lengths = new Set(lines.map((l) => stripAnsi(l).length));
      expect(lengths.size).toBe(1);
    });
  });

  describe("top and bottom borders", () => {
    it("adds a border row before the header and after the last data row", () => {
      const input = ["| A | B |", "| --- | --- |", "| x | y |"].join("\n");

      const result = reformatTables(input);
      const lines = result.split("\n");

      expect(lines).toHaveLength(5); // border + header + sep + data + border
      expect(lines[0]).toBe(lines[lines.length - 1]); // top === bottom
      expect(lines[0]).toMatch(/^\+-+\+-+\+$/);
    });

    it("border matches the separator width", () => {
      const input = ["| LongHeader | Short |", "| --- | --- |", "| val | v |"].join("\n");

      const result = reformatTables(input);
      const lines = result.split("\n");

      // Top and bottom borders should equal the separator row (all use +---+ format)
      expect(lines[0]).toBe(lines[2]); // top border === separator
      expect(lines[0]).toBe(lines[lines.length - 1]); // top === bottom
      expect(lines[0]).toMatch(/^\+-+\+-+\+$/);
    });
  });

  describe("separator alignment markers", () => {
    it("renders separator as +---+ regardless of :--- marker", () => {
      const input = ["| Col |", "| :--- |", "| val |"].join("\n");

      const result = reformatTables(input);
      const sepLine = result.split("\n")[2];
      expect(sepLine).toMatch(/^\+-+\+$/);
    });

    it("renders separator as +---+ regardless of ---: marker", () => {
      const input = ["| Col |", "| ---: |", "| val |"].join("\n");

      const result = reformatTables(input);
      const sepLine = result.split("\n")[2];
      expect(sepLine).toMatch(/^\+-+\+$/);
    });

    it("renders separator as +---+ regardless of :---: marker", () => {
      const input = ["| Col |", "| :---: |", "| val |"].join("\n");

      const result = reformatTables(input);
      const sepLine = result.split("\n")[2];
      expect(sepLine).toMatch(/^\+-+\+$/);
    });

    it("renders separator as +---+ regardless of mixed alignment markers", () => {
      const input = ["| Left | Center | Right |", "| :--- | :---: | ---: |", "| a | b | c |"].join(
        "\n",
      );

      const result = reformatTables(input);
      const sepLine = result.split("\n")[2];
      expect(sepLine).toMatch(/^\+-+\+-+\+-+\+$/);
      expect(sepLine).not.toMatch(/:/);
    });

    it("all border and separator rows use plain dashes with + corners", () => {
      const input = ["| Left | Right |", "| :--- | ---: |", "| a | b |"].join("\n");

      const result = reformatTables(input);
      const lines = result.split("\n");
      // Top border, separator, and bottom border all use +---+ format
      expect(lines[0]).toMatch(/^\+-+\+-+\+$/);
      expect(lines[0]).not.toMatch(/:/);
      expect(lines[2]).toBe(lines[0]);
      expect(lines[lines.length - 1]).toBe(lines[0]);
    });
  });

  describe("special cell content", () => {
    it("handles empty cells", () => {
      const input = ["| A | B |", "| --- | --- |", "| | val |", "| x | |"].join("\n");

      const result = reformatTables(input);
      const lines = result.split("\n");
      const lengths = new Set(lines.map((l) => l.length));
      expect(lengths.size).toBe(1);
    });

    it("renders bold markers in cells as terminal bold", () => {
      const input = ["| Node | Status |", "| --- | --- |", "| **node_0** | OK |"].join("\n");

      const result = reformatTables(input);
      const lines = result.split("\n");
      // **node_0** renders as bold, visual width = 6, padded to column width
      expect(lines[3]).toContain(pc.bold("node_0"));
      expect(lines[3]).toContain("OK");
    });

    it("aligns columns correctly when bold markers are present", () => {
      const input = [
        "| **Field** | **Value** |",
        "| --- | --- |",
        "| Version | 7.2.3.11 |",
        "| Host | host1 |",
      ].join("\n");

      const result = reformatTables(input);
      const lines = result.split("\n");
      // Column widths should be based on visual width (without **)
      // "Version" (7 chars) is wider than "Field" (5 chars), so col 1 = 7
      // "7.2.3.11" (8 chars) is wider than "Value" (5 chars), so col 2 = 8
      expect(lines[0]).toBe("+---------+----------+");
      expect(lines[3]).toBe("| Version | 7.2.3.11 |");
      expect(lines[4]).toBe("| Host    | host1    |");
    });

    it("handles inline code in cells (backticks stripped, width matches rendered text)", () => {
      const input = ["| Tool | Description |", "| --- | --- |", "| `health` | Check health |"].join(
        "\n",
      );

      const result = reformatTables(input);
      const lines = result.split("\n");
      // `health` renders as health (6 visible chars), so col 0 widens to 6, not 8.
      // The cell is styled with purple() — build the expectation from the same helper
      // so it tracks picocolors' color state (CI enables color, local vitest does not).
      expect(lines[1]).toBe("| Tool   | Description  |");
      expect(lines[3]).toBe(`| ${purple("health")} | Check health |`);
    });
  });

  describe("table embedded in prose", () => {
    it("reformats the table while preserving surrounding text", () => {
      const input = [
        "Here is a summary:",
        "",
        "| Key | Value |",
        "| --- | --- |",
        "| host | node1 |",
        "",
        "That's all.",
      ].join("\n");

      const result = reformatTables(input);
      const lines = result.split("\n");
      expect(lines[0]).toBe("Here is a summary:");
      expect(lines[1]).toBe("");
      // Top border
      expect(lines[2]).toBe("+------+-------+");
      // Header
      expect(lines[3]).toBe("| Key  | Value |");
      // Separator
      expect(lines[4]).toBe("+------+-------+");
      // Data
      expect(lines[5]).toBe("| host | node1 |");
      // Bottom border
      expect(lines[6]).toBe("+------+-------+");
      expect(lines[7]).toBe("");
      expect(lines[8]).toBe("That's all.");
    });
  });

  describe("multiple tables separated by prose", () => {
    it("reformats each table independently", () => {
      const input = [
        "Table 1:",
        "| A | B |",
        "| --- | --- |",
        "| longvalue | x |",
        "",
        "Table 2:",
        "| C | D |",
        "| --- | --- |",
        "| y | anotherlongvalue |",
      ].join("\n");

      const result = reformatTables(input);
      const lines = result.split("\n");
      // Table 1: top border, header, sep, data, bottom border
      expect(lines[1]).toBe("+-----------+-----+"); // top border
      expect(lines[2]).toBe("| A         | B   |");
      expect(lines[3]).toBe("+-----------+-----+"); // separator
      expect(lines[4]).toBe("| longvalue | x   |");
      expect(lines[5]).toBe("+-----------+-----+"); // bottom border
      // Table 2: top border, header, sep, data, bottom border
      expect(lines[8]).toBe("+-----+------------------+"); // top border
      expect(lines[9]).toBe("| C   | D                |");
      expect(lines[10]).toBe("+-----+------------------+"); // separator
      expect(lines[11]).toBe("| y   | anotherlongvalue |");
      expect(lines[12]).toBe("+-----+------------------+"); // bottom border
    });
  });

  describe("inconsistent column counts across rows", () => {
    it("handles rows with fewer columns by padding with empty cells", () => {
      const input = ["| A | B | C |", "| --- | --- | --- |", "| x | y |", "| a | b | c |"].join(
        "\n",
      );

      const result = reformatTables(input);
      const lines = result.split("\n");
      const lengths = new Set(lines.map((l) => l.length));
      expect(lengths.size).toBe(1);
    });

    it("handles rows with more columns by expanding all rows", () => {
      const input = ["| A | B |", "| --- | --- |", "| x | y | z |", "| a | b |"].join("\n");

      const result = reformatTables(input);
      const lines = result.split("\n");
      const lengths = new Set(lines.map((l) => l.length));
      expect(lengths.size).toBe(1);
    });
  });

  describe("equal-length line assertion", () => {
    it("all lines in reformatted table have the same visual length", () => {
      const input = [
        "| **Investigation Date/Time (UTC)** | 2025-01-15 14:23:00 UTC |",
        "| --- | --- |",
        "| **Kinetica Version** | 7.2.1.0 |",
        "| **Investigation Duration** | 3 minutes |",
        "| **Tool Calls** | 8 |",
        "| **Rounds** | 3 |",
      ].join("\n");

      const result = reformatTables(input);
      const lines = result.split("\n");
      const lengths = new Set(lines.map((l) => stripAnsi(l).length));
      expect(lengths.size).toBe(1);
    });
  });

  describe("immutability", () => {
    it("does not mutate the input string", () => {
      const input = "| A | B |\n| --- | --- |\n| x | y |";
      const copy = input;
      reformatTables(input);
      expect(input).toBe(copy);
    });
  });
});
