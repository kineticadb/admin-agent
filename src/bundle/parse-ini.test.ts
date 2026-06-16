import { describe, it, expect } from "vitest";
import { parseIni, filterIni } from "./parse-ini.js";

const CONF = `# ==============================================================================
# Kinetica configuration file.
[gaia]

# The current version of this configuration.
file_version = 7.2.3.17.20260610181158
ring_name = default
cluster_name = dev-cluster
head_ip_address = \${gaia.host0.address}
use_https = false
https_key_file =

[textsearch]
text_searcher_port = 9080
`;

describe("parseIni", () => {
  it("parses key=value pairs tagged with their section", () => {
    const entries = parseIni(CONF);
    expect(entries).toContainEqual({
      section: "gaia",
      key: "file_version",
      value: "7.2.3.17.20260610181158",
    });
    expect(entries).toContainEqual({
      section: "textsearch",
      key: "text_searcher_port",
      value: "9080",
    });
  });

  it("skips comments and blank lines", () => {
    const entries = parseIni(CONF);
    expect(entries.some((e) => e.key.startsWith("#"))).toBe(false);
  });

  it("surfaces interpolation references verbatim", () => {
    const entries = parseIni(CONF);
    const head = entries.find((e) => e.key === "head_ip_address");
    expect(head?.value).toBe("${gaia.host0.address}");
  });

  it("preserves an empty value (key present, value blank)", () => {
    const entries = parseIni(CONF);
    const keyFile = entries.find((e) => e.key === "https_key_file");
    expect(keyFile).toBeDefined();
    expect(keyFile?.value).toBe("");
  });

  it("returns an empty list for empty input", () => {
    expect(parseIni("")).toEqual([]);
  });
});

describe("filterIni", () => {
  const entries = parseIni(CONF);

  it("returns all entries when no filter is given", () => {
    expect(filterIni(entries).length).toBe(entries.length);
  });

  it("filters by section (case-insensitive)", () => {
    const result = filterIni(entries, { section: "GAIA" });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((e) => e.section === "gaia")).toBe(true);
  });

  it("filters by key substring (case-insensitive)", () => {
    const result = filterIni(entries, { key: "HTTPS" });
    expect(result.map((e) => e.key).sort()).toEqual(["https_key_file", "use_https"]);
  });

  it("combines section and key filters", () => {
    const result = filterIni(entries, { section: "gaia", key: "version" });
    expect(result).toEqual([
      { section: "gaia", key: "file_version", value: "7.2.3.17.20260610181158" },
    ]);
  });
});
