import { describe, it, expect } from "vitest";
import { OBSERVABILITY_TOOL_CATALOG, buildObservabilityEvidenceChecklist } from "./catalog.js";
import { OBSERVABILITY_TOOL_NAMES } from "./index.js";

describe("OBSERVABILITY_TOOL_CATALOG", () => {
  it("has an entry for every tool", () => {
    for (const name of OBSERVABILITY_TOOL_NAMES) {
      expect(OBSERVABILITY_TOOL_CATALOG[name].reveals.length).toBeGreaterThan(0);
      expect(OBSERVABILITY_TOOL_CATALOG[name].whenToUse.length).toBeGreaterThan(0);
    }
  });
});

describe("the Loki entry advertises BOTH populations", () => {
  // The checklist is the agent's map of what evidence exists. Describing only events
  // there is why a health check reported every dimension OK without ever reading a rank
  // log line — logs were not on the map, so there was nothing to skip.
  const entry = OBSERVABILITY_TOOL_CATALOG.kinetica_loki_query;

  it("names rank log lines in what it reveals, not just structured events", () => {
    expect(entry.reveals).toMatch(/log line/i);
    expect(entry.reveals).toMatch(/event/i);
  });

  it("makes reading logs part of when to use it, not a conditional aside", () => {
    expect(entry.whenToUse).toMatch(/log/i);
  });

  it("renders both populations into the checklist row", () => {
    const table = buildObservabilityEvidenceChecklist(["kinetica_loki_query"]);
    expect(table).toMatch(/log line/i);
  });
});
