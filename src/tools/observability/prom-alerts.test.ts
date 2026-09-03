import { describe, it, expect, vi } from "vitest";

import { promAlerts, PromAlertsSchema } from "./prom-alerts.js";
import type { ObservabilityClient } from "../../observability/ObservabilityClient.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A /api/v1/rules body wrapping the given rule objects in one group. */
function rulesBody(rules: readonly unknown[]) {
  return { status: "success", data: { groups: [{ name: "kinetica", rules }] } };
}

function alertingRule(over: Record<string, unknown> = {}) {
  return {
    name: "TierRamHigh",
    type: "alerting",
    query: 'ki_db_tier{tier="ram",what="used_bytes"} > 0.9',
    duration: 300,
    labels: { severity: "warning" },
    health: "ok",
    alerts: [],
    ...over,
  };
}

function instance(over: Record<string, unknown> = {}) {
  return {
    state: "firing",
    labels: { alertname: "TierRamHigh", severity: "warning", source: "rank1" },
    value: "0.94",
    activeAt: new Date(Date.now() - 600_000).toISOString(),
    ...over,
  };
}

/** Minimal client stub; only promRules is expected to be used. */
function stubClient(over: Partial<ObservabilityClient> = {}): ObservabilityClient {
  return {
    promUrl: "http://statshost:9090",
    promInstant: vi.fn(),
    promRange: vi.fn(),
    promRules: vi.fn().mockResolvedValue(jsonResponse(rulesBody([]))),
    promAlerts: vi.fn(),
    promConfig: vi.fn(),
    lokiRange: vi.fn(),
    lokiLabels: vi.fn(),
    ...over,
  };
}

const fn = (client: ObservabilityClient, key: keyof ObservabilityClient) =>
  client[key] as unknown as ReturnType<typeof vi.fn>;

describe("PromAlertsSchema", () => {
  it("accepts an empty input", () => {
    expect(PromAlertsSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a name filter", () => {
    expect(PromAlertsSchema.safeParse({ contains: "memory" }).success).toBe(true);
  });

  it("rejects a non-string filter", () => {
    expect(PromAlertsSchema.safeParse({ contains: 5 }).success).toBe(false);
  });
});

describe("promAlerts", () => {
  it("reads the rules endpoint only, never the alerts endpoint", async () => {
    // /api/v1/rules already embeds each rule's live instances, so /api/v1/alerts adds
    // nothing but a second round-trip.
    const client = stubClient();
    await promAlerts(client, {});
    expect(fn(client, "promRules")).toHaveBeenCalledOnce();
    expect(fn(client, "promAlerts")).not.toHaveBeenCalled();
  });

  describe("zero configured rules", () => {
    it("reads as absent monitoring, not as health", async () => {
      const result = await promAlerts(stubClient(), {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.rule_count).toBe(0);
      expect(result.note).toMatch(/no alerting rules/i);
      expect(result.note).toMatch(/absence of monitoring|not evidence of health/i);
    });

    it("points at the tools that DO carry the database's own thresholds", async () => {
      const result = await promAlerts(stubClient(), {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Kinetica pushes alert_memory_percentage et al. straight to Alertmanager.
      expect(result.note).toContain("kinetica_cluster_status");
      expect(result.note).toContain("kinetica_tier_snapshot");
    });

    it("mentions recording rules when only those are configured", async () => {
      const client = stubClient({
        promRules: vi
          .fn()
          .mockResolvedValue(
            jsonResponse(
              rulesBody([{ name: "job:x:rate5m", type: "recording", query: "rate(x[5m])" }]),
            ),
          ),
      });
      const result = await promAlerts(client, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.note).toMatch(/1 recording rule/i);
    });
  });

  describe("rules configured", () => {
    it("reads a quiet stack as good news and names expr as the site's threshold", async () => {
      const client = stubClient({
        promRules: vi.fn().mockResolvedValue(jsonResponse(rulesBody([alertingRule()]))),
      });
      const result = await promAlerts(client, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.rule_count).toBe(1);
      expect(result.data.firing).toBe(0);
      expect(result.note).toMatch(/none firing or pending/i);
      expect(result.note).toMatch(/expr/);
    });

    it("counts firing and pending instances separately", async () => {
      const client = stubClient({
        promRules: vi.fn().mockResolvedValue(
          jsonResponse(
            rulesBody([
              alertingRule({ state: "firing", alerts: [instance()] }),
              alertingRule({
                name: "DiskHigh",
                state: "pending",
                alerts: [instance({ state: "pending" })],
              }),
            ]),
          ),
        ),
      });
      const result = await promAlerts(client, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.firing).toBe(1);
      expect(result.data.pending).toBe(1);
      expect(result.data.active_alerts).toHaveLength(2);
    });

    it("sorts firing rules ahead of inactive ones so truncation cannot hide them", async () => {
      const client = stubClient({
        promRules: vi
          .fn()
          .mockResolvedValue(
            jsonResponse(
              rulesBody([
                alertingRule({ name: "AaaQuiet" }),
                alertingRule({ name: "ZzzFiring", state: "firing", alerts: [instance()] }),
              ]),
            ),
          ),
      });
      const result = await promAlerts(client, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.rules.map((r) => r.alert)).toEqual(["ZzzFiring", "AaaQuiet"]);
    });

    it("hoists labels shared by every active alert into the note", async () => {
      const client = stubClient({
        promRules: vi.fn().mockResolvedValue(
          jsonResponse(
            rulesBody([
              alertingRule({
                state: "firing",
                alerts: [
                  instance(),
                  instance({
                    labels: { alertname: "TierRamHigh", severity: "warning", source: "rank2" },
                  }),
                ],
              }),
            ]),
          ),
        ),
      });
      const result = await promAlerts(client, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.note).toContain("severity=warning");
      expect(result.data.active_alerts.map((a) => a.labels)).toEqual([
        "source=rank1",
        "source=rank2",
      ]);
    });

    it("reports a rule that cannot evaluate, because it can never fire", async () => {
      const client = stubClient({
        promRules: vi
          .fn()
          .mockResolvedValue(
            jsonResponse(
              rulesBody([alertingRule({ health: "err", lastError: "parse error at char 12" })]),
            ),
          ),
      });
      const result = await promAlerts(client, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.note).toMatch(/unable to fire|failing to evaluate/i);
      expect(result.note).toContain("parse error at char 12");
    });
  });

  describe("contains filter", () => {
    const client = () =>
      stubClient({
        promRules: vi
          .fn()
          .mockResolvedValue(
            jsonResponse(
              rulesBody([
                alertingRule({ name: "TierRamHigh" }),
                alertingRule({ name: "DiskFull" }),
              ]),
            ),
          ),
      });

    it("narrows by rule name, case-insensitively", async () => {
      const result = await promAlerts(client(), { contains: "ram" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.rules.map((r) => r.alert)).toEqual(["TierRamHigh"]);
      expect(result.data.rule_count).toBe(1);
    });

    it("does NOT claim the site has no alerting when the filter simply matched nothing", async () => {
      const result = await promAlerts(client(), { contains: "zzz" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.rules).toEqual([]);
      expect(result.note).not.toMatch(/absence of monitoring/i);
      expect(result.note).toContain("zzz");
      expect(result.note).toMatch(/2 rules configured/i);
    });
  });

  describe("failures", () => {
    it("fails on a non-JSON body", async () => {
      const client = stubClient({
        promRules: vi.fn().mockResolvedValue(new Response("<html>502</html>", { status: 502 })),
      });
      const result = await promAlerts(client, {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/non-JSON/i);
      expect(result.status).toBe(502);
    });

    it("fails on an HTTP error and keeps the status", async () => {
      const client = stubClient({
        promRules: vi.fn().mockResolvedValue(jsonResponse({ status: "success" }, 500)),
      });
      const result = await promAlerts(client, {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(500);
    });

    it("surfaces Prometheus' own error text verbatim", async () => {
      const client = stubClient({
        promRules: vi
          .fn()
          .mockResolvedValue(
            jsonResponse({ status: "error", errorType: "internal", error: "boom" }),
          ),
      });
      const result = await promAlerts(client, {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("boom");
    });

    it("fails when the transport rejects", async () => {
      const client = stubClient({
        promRules: vi.fn().mockRejectedValue(new Error("connect ETIMEDOUT")),
      });
      const result = await promAlerts(client, {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("ETIMEDOUT");
    });

    it("fails on a well-formed response of the wrong shape rather than reporting zero rules", async () => {
      const client = stubClient({
        promRules: vi.fn().mockResolvedValue(jsonResponse({ status: "success", data: {} })),
      });
      const result = await promAlerts(client, {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/shape|groups/i);
    });
  });
});
