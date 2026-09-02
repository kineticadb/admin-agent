import { describe, it, expect } from "vitest";

// series-rows.ts does not exist yet — these tests define the expected contract.
// They MUST fail on first run (RED phase).

import { toSeriesRows, isByteMetric, hhmmss, describeWindow } from "./series-rows.js";
import type { SeriesSummary } from "../rest/summarize-timeseries.js";

function summary(over: Partial<SeriesSummary> = {}): SeriesSummary {
  return {
    labels: { __name__: "ki_db_tier", source: "rank1", tier: "ram", what: "used_bytes" },
    min: 399_556_792,
    minAt: 1_788_289_096,
    max: 401_666_796,
    maxAt: 1_788_292_696,
    first: 399_556_792,
    last: 401_666_796,
    firstTs: 1_788_289_096,
    lastTs: 1_788_292_696,
    delta: 2_110_004,
    points: 61,
    ...over,
  };
}

describe("isByteMetric", () => {
  it("detects a byte metric from the what label", () => {
    expect(isByteMetric({ what: "used_bytes" })).toBe(true);
    expect(isByteMetric({ what: "unevictable_bytes" })).toBe(true);
  });

  it("does not treat counters or fractions as bytes", () => {
    // Measured: high_watermark is a FRACTION (0.9), evictions_total a counter.
    expect(isByteMetric({ what: "high_watermark" })).toBe(false);
    expect(isByteMetric({ what: "evictions_total" })).toBe(false);
    expect(isByteMetric({ what: "evictable_count" })).toBe(false);
  });

  it("falls back to the metric name when there is no what label", () => {
    expect(isByteMetric({ __name__: "ki_db_request_received_bytes_sum" })).toBe(true);
    expect(isByteMetric({ __name__: "ki_host_cpu" })).toBe(false);
  });

  it("recognizes host metrics whose byte-valued what labels lack the _bytes suffix", () => {
    // Measured: ki_host_mem{what="used"} is bytes, but the bare label misses the suffix
    // rule and a multi-gigabyte figure would render as a raw integer.
    expect(isByteMetric({ __name__: "ki_host_mem", what: "used" })).toBe(true);
    expect(isByteMetric({ __name__: "ki_host_disk", what: "free" })).toBe(true);
    expect(isByteMetric({ __name__: "ki_host_swap", what: "total" })).toBe(true);
  });

  it("does not treat the same metrics' non-byte what values as bytes", () => {
    expect(isByteMetric({ __name__: "ki_host_disk", what: "io_time" })).toBe(false);
    expect(isByteMetric({ __name__: "ki_host_disk", what: "reads" })).toBe(false);
    expect(isByteMetric({ __name__: "ki_host_cpu", what: "idle" })).toBe(false);
  });

  it("handles an empty label set", () => {
    expect(isByteMetric({})).toBe(false);
  });
});

describe("hhmmss", () => {
  it("renders a second epoch as UTC clock time", () => {
    expect(hhmmss(1_788_289_096)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("degrades rather than throwing on junk", () => {
    expect(hhmmss(Number.NaN)).toBe("?");
  });

  it("degrades on a finite value outside Date's range instead of throwing", () => {
    // Date spans only +/-8.64e15 ms; toISOString() throws RangeError beyond it, and this
    // is called per row — one bad value would abort a whole snapshot.
    expect(() => hhmmss(1e300)).not.toThrow();
    expect(hhmmss(1e300)).toBe("?");
  });
});

describe("describeWindow", () => {
  it("states the absolute window and step so the clock times are interpretable", () => {
    const note = describeWindow(1_788_289_096, 1_788_292_696, 60);
    expect(note).toContain("60s step");
    expect(note).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(note).toContain("UTC");
  });
});

describe("toSeriesRows", () => {
  it("hoists labels shared by every series out of the table", () => {
    const two = toSeriesRows([
      summary(),
      summary({
        labels: { __name__: "ki_db_tier", source: "rank0", tier: "ram", what: "used_bytes" },
      }),
    ]);
    expect(two.rows[0].metric).toBe("ki_db_tier");
    // tier and what are identical across both series -> context, not discriminators.
    expect(two.common).toBe("tier=ram what=used_bytes");
    expect(two.rows[0].series).toBe("source=rank1");
    expect(two.rows[1].series).toBe("source=rank0");
    expect(two.common).not.toContain("__name__");
  });

  it("drops the derived job label when source identifies the rank", () => {
    // Measured job format: ki_db_ring_<ring>_cluster_<cluster>_rank_<N> — 48 chars
    // restating ring, cluster and rank, all present as their own labels.
    const { rows } = toSeriesRows([
      summary({
        labels: {
          __name__: "ki_db_tier",
          source: "rank1",
          job: "ki_db_ring_default_cluster_dev_rank_1",
          what: "used_bytes",
        },
      }),
      summary({
        labels: {
          __name__: "ki_db_tier",
          source: "rank0",
          job: "ki_db_ring_default_cluster_dev_rank_0",
          what: "used_bytes",
        },
      }),
    ]);
    expect(rows[0].series).toBe("source=rank1");
    expect(rows.some((r) => r.series.includes("job="))).toBe(false);
  });

  it("drops the redundant instance label alongside job when source is present", () => {
    const { rows } = toSeriesRows([
      summary({ labels: { __name__: "ki_db_tier", source: "rank1", instance: "192.0.2.12:9192" } }),
      summary({ labels: { __name__: "ki_db_tier", source: "rank0", instance: "192.0.2.12:9191" } }),
    ]);
    expect(rows[0].series).toBe("source=rank1");
  });

  it("keeps job when there is no source label to carry rank identity", () => {
    const { rows } = toSeriesRows([
      summary({ labels: { __name__: "up", job: "a", instance: "x:1" } }),
      summary({ labels: { __name__: "up", job: "b", instance: "y:2" } }),
    ]);
    expect(rows[0].series).toBe("instance=x:1 job=a");
  });

  it("hoists every label for a single series, leaving the column empty", () => {
    const one = toSeriesRows([summary()]);
    expect(one.common).toBe("source=rank1 tier=ram what=used_bytes");
    expect(one.rows[0].series).toBe("");
  });

  it("formats byte metrics base-1000 and carries min/max clock times", () => {
    const {
      rows: [row],
    } = toSeriesRows([summary()]);
    expect(row.last).toBe("401.67 MB");
    expect(row.min).toBe("399.56 MB");
    expect(row.delta).toBe("+2.11 MB");
    expect(row.min_at).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(row.points).toBe(61);
  });

  it("leaves non-byte metrics unformatted", () => {
    const {
      rows: [row],
    } = toSeriesRows([
      summary({
        labels: { __name__: "ki_db_tier", what: "high_watermark" },
        last: 0.9,
        min: 0.9,
        max: 0.9,
        delta: 0,
      }),
    ]);
    expect(row.last).toBe("0.9");
    expect(row.delta).toBe("0");
  });

  it("compacts full-precision floats without flattening small magnitudes", () => {
    // Measured: ki_host_cpu{what="idle"} arrives as 75.20576380460521.
    const cpu = toSeriesRows([
      summary({
        labels: { __name__: "ki_host_cpu", what: "idle" },
        last: 75.20576380460521,
        min: 0.9,
        max: 0.00012,
        delta: 0,
      }),
    ]).rows[0];
    expect(cpu.last).toBe("75.206");
    expect(cpu.min).toBe("0.9");
    expect(cpu.max).toBe("0.00012");
  });

  it("leaves integers exactly as they are", () => {
    const oom = toSeriesRows([
      summary({
        labels: { __name__: "ki_exe_mem", what: "oom_score" },
        last: 684,
        min: 684,
        max: 684,
        delta: 0,
      }),
    ]).rows[0];
    expect(oom.last).toBe("684");
  });

  it("signs a negative delta", () => {
    const {
      rows: [row],
    } = toSeriesRows([summary({ delta: -2_110_004 })]);
    expect(row.delta).toBe("-2.11 MB");
  });

  it("honours an explicit format override", () => {
    const {
      rows: [raw],
    } = toSeriesRows([summary()], { format: "raw" });
    expect(raw.last).toBe("401666796");
    const {
      rows: [bytes],
    } = toSeriesRows([summary({ labels: { what: "evictions_total" }, last: 1000 })], {
      format: "bytes",
    });
    expect(bytes.last).toBe("1.00 KB");
  });

  it("returns [] for no series", () => {
    expect(toSeriesRows([])).toEqual({ rows: [], common: "" });
  });
});
