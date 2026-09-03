import { describe, it, expect } from "vitest";
import { buildTimeAxisSection } from "./time-axis-section.js";
import type { ObservabilityClient } from "../observability/ObservabilityClient.js";

const client = (promUrl?: string, lokiUrl?: string) =>
  ({ promUrl, lokiUrl }) as unknown as ObservabilityClient;

describe("buildTimeAxisSection", () => {
  it("states the invariant identically in both contexts", () => {
    const live = buildTimeAxisSection("live");
    const bundle = buildTimeAxisSection("bundle");
    for (const prompt of [live, bundle]) {
      expect(prompt).toContain("### One Time Axis");
      expect(prompt).toMatch(/unless both are UTC or the offset between those clocks is known/i);
      expect(prompt).toMatch(/Evidence Gap/);
      expect(prompt).toMatch(/do not guess/i);
      expect(prompt).toMatch(/Timeline section/);
    }
  });

  it("names the bundle's two log families and its missing offset in both contexts", () => {
    for (const ctx of ["live", "bundle"] as const) {
      const prompt = buildTimeAxisSection(ctx);
      expect(prompt).toContain("logs-local/");
      expect(prompt).toContain("timestamp_zone");
      // The fact that makes "the offset is unknown" actionable rather than a puzzle.
      expect(prompt).toMatch(/does not record the host's UTC offset/);
    }
  });

  it("names the live alert clock only in the live context", () => {
    expect(buildTimeAxisSection("live")).toContain("kinetica_cluster_status");
    expect(buildTimeAxisSection("bundle")).not.toContain("kinetica_cluster_status");
  });

  it("claims a stats stack renders UTC only for the endpoints actually reached", () => {
    expect(buildTimeAxisSection("live", client("http://p:9090", "http://l:9080"))).toContain(
      "Prometheus and Loki tool output is rendered in UTC",
    );
    expect(buildTimeAxisSection("live", client("http://p:9090"))).toContain(
      "Prometheus tool output is rendered in UTC",
    );
    expect(buildTimeAxisSection("live", client(undefined, "http://l:9080"))).toContain(
      "Loki tool output is rendered in UTC",
    );
    // No endpoint reached — advertising a UTC renderer the agent cannot call.
    expect(buildTimeAxisSection("live")).not.toMatch(/rendered in UTC/);
    expect(buildTimeAxisSection("live", client())).not.toMatch(/rendered in UTC/);
  });
});
