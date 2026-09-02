import { describe, it, expect } from "vitest";

// summarize-timeseries.ts does not exist yet — these tests define the expected contract.
// They MUST fail on first run (RED phase).

import {
  summarizeSeries,
  formatBytesBase1000,
  MAX_INCLUDED_POINTS,
} from "./summarize-timeseries.js";

/**
 * Label sets below are verbatim from a live 7.2.3.20 cluster's
 * /api/v1/query_range?query=ki_db_tier{tier="ram",what="used_bytes"} response.
 * The real capture is flat (an idle cluster), so most cases vary the values to
 * exercise min/max; `real capture` below keeps the actual constant series.
 */
const RANK0_LABELS = {
  __name__: "ki_db_tier",
  cluster: "example-cluster",
  host: "dbhost",
  instance: "192.0.2.12:9191",
  job: "ki_db_ring_default_cluster_example-cluster_rank_0",
  ring: "default",
  source: "rank0",
  tier: "ram",
  what: "used_bytes",
} as const;

const RANK1_LABELS = { ...RANK0_LABELS, source: "rank1", instance: "192.0.2.12:9192" };

function body(result: unknown) {
  return { status: "success", data: { resultType: "matrix", result } };
}

describe("summarizeSeries", () => {
  describe("graceful degradation", () => {
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["a string", "nope"],
      ["an empty object", {}],
      ["a body with no result array", body(undefined)],
      ["a body with an empty result", body([])],
    ])("returns [] for %s", (_label, input) => {
      expect(summarizeSeries(input)).toEqual([]);
    });

    it("never throws on a malformed series entry", () => {
      expect(() => summarizeSeries(body([{ metric: null, values: "bad" }]))).not.toThrow();
      expect(summarizeSeries(body([{ metric: null, values: "bad" }]))).toEqual([]);
    });

    it("skips non-numeric samples rather than poisoning min/max with NaN", () => {
      const s = summarizeSeries(
        body([
          {
            metric: RANK0_LABELS,
            values: [
              [100, "10"],
              [160, "NaN"],
              [220, "30"],
            ],
          },
        ]),
      );
      expect(s[0].points).toBe(2);
      expect(s[0].min).toBe(10);
      expect(s[0].max).toBe(30);
    });
  });

  describe("per-series reduction", () => {
    const twoSeries = body([
      {
        metric: RANK0_LABELS,
        values: [
          [100, "50"],
          [160, "10"],
          [220, "90"],
          [280, "70"],
        ],
      },
      {
        metric: RANK1_LABELS,
        values: [
          [100, "5"],
          [160, "5"],
        ],
      },
    ]);

    it("reduces each series to one summary and preserves its labels", () => {
      const s = summarizeSeries(twoSeries);
      expect(s).toHaveLength(2);
      expect(s[0].labels).toEqual(RANK0_LABELS);
      expect(s[1].labels.source).toBe("rank1");
    });

    it("carries the timestamp of the min and the max, not just the values", () => {
      const [first] = summarizeSeries(twoSeries);
      expect(first.min).toBe(10);
      expect(first.minAt).toBe(160);
      expect(first.max).toBe(90);
      expect(first.maxAt).toBe(220);
    });

    it("reports first, last, delta and the window bounds", () => {
      const [first] = summarizeSeries(twoSeries);
      expect(first.first).toBe(50);
      expect(first.last).toBe(70);
      expect(first.delta).toBe(20);
      expect(first.firstTs).toBe(100);
      expect(first.lastTs).toBe(280);
      expect(first.points).toBe(4);
    });

    it("handles a single-point series without special-casing at the call site", () => {
      const [only] = summarizeSeries(body([{ metric: RANK0_LABELS, values: [[100, "42"]] }]));
      expect(only).toMatchObject({
        min: 42,
        max: 42,
        first: 42,
        last: 42,
        delta: 0,
        points: 1,
        minAt: 100,
        maxAt: 100,
      });
    });

    it("omits raw points by default — the whole reason this module exists", () => {
      const [first] = summarizeSeries(twoSeries);
      expect(first.values).toBeUndefined();
    });
  });

  describe("instant (vector) results", () => {
    it("summarizes a singular `value` the same as a one-point `values`", () => {
      // Measured: /api/v1/query returns resultType "vector" with value: [ts, "n"],
      // NOT the plural `values` that query_range returns.
      const [only] = summarizeSeries({
        status: "success",
        data: {
          resultType: "vector",
          result: [{ metric: RANK0_LABELS, value: [1788298581.206, "793900000"] }],
        },
      });
      expect(only).toMatchObject({ min: 793900000, max: 793900000, points: 1, delta: 0 });
      expect(only.firstTs).toBeCloseTo(1788298581.206);
    });

    it("still returns [] for a vector entry with no value at all", () => {
      expect(summarizeSeries(body([{ metric: RANK0_LABELS }]))).toEqual([]);
    });
  });

  describe("real capture", () => {
    it("summarizes the constant idle-cluster series without reporting a false delta", () => {
      const flat = Array.from({ length: 61 }, (_, i) => [1788289096 + i * 60, "4194304"]);
      const [rank0] = summarizeSeries(body([{ metric: RANK0_LABELS, values: flat }]));
      expect(rank0.points).toBe(61);
      expect(rank0.min).toBe(4194304);
      expect(rank0.max).toBe(4194304);
      expect(rank0.delta).toBe(0);
      expect(rank0.firstTs).toBe(1788289096);
      expect(rank0.lastTs).toBe(1788292696);
    });
  });

  describe("include_points escape hatch", () => {
    it("returns raw points when asked", () => {
      const [first] = summarizeSeries(
        body([
          {
            metric: RANK0_LABELS,
            values: [
              [100, "1"],
              [160, "2"],
            ],
          },
        ]),
        { includePoints: true },
      );
      expect(first.values).toEqual([
        [100, 1],
        [160, 2],
      ]);
    });

    it("caps included points so the escape hatch cannot blow the context budget", () => {
      const many = Array.from({ length: MAX_INCLUDED_POINTS + 50 }, (_, i) => [i, String(i)]);
      const [first] = summarizeSeries(body([{ metric: RANK0_LABELS, values: many }]), {
        includePoints: true,
      });
      expect(first.values).toHaveLength(MAX_INCLUDED_POINTS);
      expect(first.pointsTruncated).toBe(true);
      // The summary still describes the FULL series, not just the returned window.
      expect(first.points).toBe(MAX_INCLUDED_POINTS + 50);
    });
  });
});

describe("formatBytesBase1000", () => {
  it("uses base-1000 units, matching how tier limits are configured", () => {
    expect(formatBytesBase1000(1_000)).toBe("1.00 KB");
    expect(formatBytesBase1000(1_500_000)).toBe("1.50 MB");
    expect(formatBytesBase1000(4_194_304)).toBe("4.19 MB");
    expect(formatBytesBase1000(399_556_792)).toBe("399.56 MB");
  });

  it("does not fall back to base-1024 at the boundary", () => {
    // 1024 bytes is 1.02 KB base-1000, not "1.00 KiB". Mixing bases corrupts every
    // headroom judgment against a configured tier limit.
    expect(formatBytesBase1000(1_024)).toBe("1.02 KB");
  });

  it("leaves sub-kilobyte values unscaled and handles junk", () => {
    expect(formatBytesBase1000(0)).toBe("0 B");
    expect(formatBytesBase1000(512)).toBe("512 B");
    expect(formatBytesBase1000(Number.NaN)).toBe("n/a");
  });
});
