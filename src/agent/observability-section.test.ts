import { describe, it, expect } from "vitest";

import { buildObservabilitySection } from "./observability-section.js";
import { TOOL_ENDPOINT } from "../tools/observability/index.js";
import { OBSERVABILITY_TOOL_NAMES } from "../tools/observability/index.js";
import type { ObservabilityClient } from "../observability/ObservabilityClient.js";

const client = (over: Partial<ObservabilityClient>) => over as ObservabilityClient;

const PROM_ONLY = client({ promUrl: "http://statshost:9090" });
const LOKI_ONLY = client({ lokiUrl: "http://statshost:9080" });
const BOTH = client({ promUrl: "http://statshost:9090", lokiUrl: "http://statshost:9080" });

describe("TOOL_ENDPOINT", () => {
  it("classifies every observability tool, so none can be silently unadvertised", () => {
    // The compile-time Record guarantees presence; this pins the values are usable.
    for (const name of OBSERVABILITY_TOOL_NAMES) {
      expect(["prom", "loki"]).toContain(TOOL_ENDPOINT[name]);
    }
  });
});

describe("buildObservabilitySection", () => {
  it("returns nothing when no endpoint is reachable", () => {
    expect(buildObservabilitySection(undefined)).toBe("");
    expect(buildObservabilitySection(client({}))).toBe("");
  });

  it("advertises every tool when the whole stack is reachable", () => {
    const section = buildObservabilitySection(BOTH);
    for (const name of OBSERVABILITY_TOOL_NAMES) {
      expect(section).toContain(name);
    }
  });

  describe("endpoint gating", () => {
    it("advertises the Prometheus tools but not the Loki one on a Prom-only stack", () => {
      const section = buildObservabilitySection(PROM_ONLY);
      expect(section).toContain("kinetica_prom_alerts");
      expect(section).toContain("kinetica_tier_snapshot");
      expect(section).not.toContain("| kinetica_loki_query |");
    });

    it("never advertises a Prometheus tool on a Loki-only stack", () => {
      // Advertising it would cost the agent a turn to learn it returns "not configured".
      const section = buildObservabilitySection(LOKI_ONLY);
      expect(section).not.toContain("kinetica_prom_alerts");
      expect(section).not.toContain("| kinetica_tier_snapshot |");
      expect(section).toContain("kinetica_loki_query");
    });

    it("omits the metric traps when Prometheus is absent", () => {
      expect(buildObservabilitySection(LOKI_ONLY)).not.toContain("high_watermark");
      expect(buildObservabilitySection(PROM_ONLY)).toContain("high_watermark");
    });

    it("omits the Loki traps when Loki is absent", () => {
      expect(buildObservabilitySection(PROM_ONLY)).not.toContain("enable_promtail");
      expect(buildObservabilitySection(LOKI_ONLY)).toContain("enable_promtail");
    });
  });

  describe("Round 1 guidance", () => {
    it("names the alerts tool first when Prometheus is reachable", () => {
      const section = buildObservabilitySection(PROM_ONLY);
      expect(section).toMatch(/Round 1/);
      expect(section).toContain("kinetica_prom_alerts");
    });

    it("warns that zero configured rules is not evidence of health", () => {
      expect(buildObservabilitySection(PROM_ONLY)).toMatch(/absence of monitoring/i);
    });

    it("says plainly that there are no metrics when Prometheus is missing", () => {
      expect(buildObservabilitySection(LOKI_ONLY)).toMatch(/not reachable/i);
    });
  });

  describe("framing", () => {
    it("frames a live session around the stack outliving the database", () => {
      expect(buildObservabilitySection(BOTH, "live")).toMatch(/separate host/);
    });

    it("frames a bundle session around the incident the bundle captured", () => {
      expect(buildObservabilitySection(BOTH, "bundle")).toMatch(/unreachable/);
    });
  });
});
