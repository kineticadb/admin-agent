import { describe, it, expect } from "vitest";

import { parseRuleGroups, renderDuration, ageOf, clampExpr } from "./alert-rows.js";

/** Fixed "now" so age assertions are deterministic without fake timers. */
const NOW = Date.parse("2026-09-02T12:00:00Z");

/** Build a /api/v1/rules body from bare rule objects. */
function body(rules: readonly unknown[]) {
  return { status: "success", data: { groups: [{ name: "kinetica", rules }] } };
}

function alertingRule(over: Record<string, unknown> = {}) {
  return {
    name: "TierRamHigh",
    type: "alerting",
    query:
      'ki_db_tier{tier="ram",what="used_bytes"} / ki_db_tier{tier="ram",what="size_bytes"} > 0.9',
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
    labels: { alertname: "TierRamHigh", severity: "warning", source: "rank1", tier: "ram" },
    value: "9.3e-01",
    activeAt: "2026-09-02T11:37:30Z",
    ...over,
  };
}

describe("renderDuration", () => {
  it("renders whole units without noise", () => {
    expect(renderDuration(0)).toBe("0s");
    expect(renderDuration(300)).toBe("5m");
    expect(renderDuration(3600)).toBe("1h");
  });

  it("keeps the second-largest unit when it is non-zero", () => {
    expect(renderDuration(90)).toBe("1m30s");
    expect(renderDuration(90000)).toBe("1d1h");
  });

  it("degrades to ? rather than throwing on junk", () => {
    expect(renderDuration(Number.NaN)).toBe("?");
    expect(renderDuration(-1)).toBe("?");
    expect(renderDuration(Number.POSITIVE_INFINITY)).toBe("?");
  });
});

describe("ageOf", () => {
  it("renders how long an alert has been active", () => {
    expect(ageOf("2026-09-02T11:37:30Z", NOW)).toBe("22m30s");
  });

  it("degrades to ? for an unparseable timestamp", () => {
    expect(ageOf("not-a-time", NOW)).toBe("?");
    expect(ageOf(undefined, NOW)).toBe("?");
    expect(ageOf(42, NOW)).toBe("?");
  });

  it("clamps a future activeAt to 0s instead of a negative age", () => {
    expect(ageOf("2026-09-02T12:05:00Z", NOW)).toBe("0s");
  });
});

describe("clampExpr", () => {
  it("elides the middle so the threshold at the tail survives", () => {
    // Measured live: the kagent `mem*for5m` rules are 214 chars and end in `* 100 > 70`.
    // Head-only clipping hid the threshold — the one thing the expr column exists to show.
    const expr = `ki_host_mem{what="used"} / ignoring (what) (${"x".repeat(200)}) * 100 > 70`;
    const out = clampExpr(expr);
    expect(out).toContain("> 70");
    expect(out).toContain("(elided)");
    expect(out.startsWith('ki_host_mem{what="used"}')).toBe(true);
  });

  it("collapses whitespace so a multi-line expr cannot break a table row", () => {
    expect(clampExpr("sum(\n  rate(x[5m])\n)")).toBe("sum( rate(x[5m]) )");
  });

  it("escapes pipes, which would otherwise split a markdown cell", () => {
    expect(clampExpr("a > 1 or b|c")).toContain("b\\|c");
  });

  it("shortens a very long expression with a marker", () => {
    const out = clampExpr("x".repeat(400));
    expect(out.length).toBeLessThan(400);
    expect(out).toContain("elided");
  });
});

describe("parseRuleGroups", () => {
  it("returns undefined for a malformed body, which is NOT the same as zero rules", () => {
    // Load-bearing: "this site configured no alerting" is a diagnostic claim, so junk
    // must never be able to impersonate it.
    expect(parseRuleGroups(null, NOW)).toBeUndefined();
    expect(parseRuleGroups({}, NOW)).toBeUndefined();
    expect(parseRuleGroups({ data: {} }, NOW)).toBeUndefined();
    expect(parseRuleGroups({ data: { groups: "nope" } }, NOW)).toBeUndefined();
  });

  it("reads empty groups as zero rules", () => {
    const parsed = parseRuleGroups({ data: { groups: [] } }, NOW);
    expect(parsed).toBeDefined();
    expect(parsed?.rules).toEqual([]);
    expect(parsed?.active).toEqual([]);
    expect(parsed?.recordingCount).toBe(0);
  });

  it("counts recording rules without listing them", () => {
    const parsed = parseRuleGroups(
      body([{ name: "job:x:rate5m", type: "recording", query: "rate(x[5m])", health: "ok" }]),
      NOW,
    );
    expect(parsed?.rules).toEqual([]);
    expect(parsed?.recordingCount).toBe(1);
  });

  it("renders an inactive alerting rule with its threshold and for-duration", () => {
    const parsed = parseRuleGroups(body([alertingRule()]), NOW);
    expect(parsed?.rules).toHaveLength(1);
    const [row] = parsed?.rules ?? [];
    expect(row.alert).toBe("TierRamHigh");
    expect(row.state).toBe("inactive");
    expect(row.severity).toBe("warning");
    expect(row.for).toBe("5m");
    expect(row.active).toBe(0);
    expect(row.health).toBe("ok");
    expect(row.expr).toContain("0.9");
  });

  it("hoists labels shared by every active instance and drops alertname", () => {
    const parsed = parseRuleGroups(
      body([
        alertingRule({
          state: "firing",
          alerts: [instance(), instance({ labels: { ...instance().labels, source: "rank2" } })],
        }),
      ]),
      NOW,
    );
    expect(parsed?.active).toHaveLength(2);
    expect(parsed?.active.map((a) => a.labels)).toEqual(["source=rank1", "source=rank2"]);
    // alertname restates the `alert` column; severity/tier are identical across both.
    expect(parsed?.common).toBe("severity=warning tier=ram");
    expect(parsed?.common).not.toContain("alertname");
  });

  it("drops job and instance labels, which only restate the rank", () => {
    // Same rule as series-rows.ts: `job` is ki_db_ring_<ring>_cluster_<cluster>_rank_<N>
    // and `instance` is <host>:<port> — both re-encode labels already present. They differ
    // per rank, so they are NOT hoisted as common and would cost ~48 chars on every row.
    const parsed = parseRuleGroups(
      body([
        alertingRule({
          alerts: [
            instance({
              labels: {
                source: "rank1",
                job: "ki_db_ring_r0_cluster_k1_rank_1",
                instance: "host1:9191",
              },
            }),
            instance({
              labels: {
                source: "rank2",
                job: "ki_db_ring_r0_cluster_k1_rank_2",
                instance: "host2:9191",
              },
            }),
          ],
        }),
      ]),
      NOW,
    );
    expect(parsed?.active.map((a) => a.labels)).toEqual(["source=rank1", "source=rank2"]);
    expect(parsed?.common).toBe("");
  });

  it("keeps job and instance when there is no source label to carry rank identity", () => {
    const parsed = parseRuleGroups(
      body([alertingRule({ alerts: [instance({ labels: { job: "node", instance: "h:9100" } })] })]),
      NOW,
    );
    expect(parsed?.common).toBe("instance=h:9100 job=node");
  });

  it("keeps a pending instance distinct from a firing one", () => {
    const parsed = parseRuleGroups(
      body([alertingRule({ state: "pending", alerts: [instance({ state: "pending" })] })]),
      NOW,
    );
    expect(parsed?.active[0].state).toBe("pending");
  });

  it("renders the tripping value compactly", () => {
    const parsed = parseRuleGroups(body([alertingRule({ alerts: [instance()] })]), NOW);
    expect(parsed?.active[0].value).toBe("0.93");
  });

  it("reports a rule that cannot evaluate, because it can never fire", () => {
    const parsed = parseRuleGroups(
      body([alertingRule({ health: "err", lastError: "vector selector must contain..." })]),
      NOW,
    );
    expect(parsed?.failing).toEqual([
      { alert: "TierRamHigh", error: "vector selector must contain..." },
    ]);
    expect(parsed?.rules[0].health).toBe("err");
  });

  it("never throws on junk rule entries", () => {
    const parsed = parseRuleGroups(
      body([
        null,
        "string",
        { type: "alerting" },
        alertingRule({ alerts: "bad" }),
        alertingRule({ labels: 3, duration: "nope" }),
      ]),
      NOW,
    );
    expect(parsed).toBeDefined();
    expect(parsed?.active).toEqual([]);
  });

  it("tolerates a group whose rules array is missing", () => {
    const parsed = parseRuleGroups({ data: { groups: [{ name: "empty" }, null] } }, NOW);
    expect(parsed?.rules).toEqual([]);
  });

  it("counts every alerting rule, so a filtered view still knows the site total", () => {
    const parsed = parseRuleGroups(
      body([alertingRule({ name: "TierRamHigh" }), alertingRule({ name: "DiskFull" })]),
      NOW,
      (alert) => alert === "DiskFull",
    );
    expect(parsed?.rules.map((r) => r.alert)).toEqual(["DiskFull"]);
    expect(parsed?.totalAlerting).toBe(2);
  });

  it("hoists only labels shared by the instances that survive the filter", () => {
    // Filtering before hoisting keeps `common` accurate: a label shared only within the
    // surviving subset must still be hoisted, and one from an excluded rule must not leak.
    const parsed = parseRuleGroups(
      body([
        alertingRule({ name: "DiskFull", alerts: [instance({ labels: { tier: "disk0" } })] }),
        alertingRule({ name: "TierRamHigh", alerts: [instance({ labels: { tier: "ram" } })] }),
      ]),
      NOW,
      (alert) => alert === "TierRamHigh",
    );
    expect(parsed?.active).toHaveLength(1);
    expect(parsed?.common).toBe("tier=ram");
  });
});
