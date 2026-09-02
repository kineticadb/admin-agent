import { describe, it, expect, vi } from "vitest";

// tier-snapshot.ts does not exist yet — these tests define the expected contract.
// They MUST fail on first run (RED phase).

import { tierSnapshot, TierSnapshotSchema } from "./tier-snapshot.js";
import type { ObservabilityClient } from "../../observability/ObservabilityClient.js";

/** Build one ki_db_tier series with a flat value, matching the live label shape. */
function series(source: string, tier: string, what: string, value: number, peak = value) {
  return {
    metric: {
      __name__: "ki_db_tier",
      cluster: "example-cluster",
      host: "dbhost",
      source,
      tier,
      what,
    },
    values: [
      [1788289096, String(value)],
      [1788290000, String(peak)],
      [1788292696, String(value)],
    ],
  };
}

function body(result: unknown[]) {
  return { status: "success", data: { resultType: "matrix", result } };
}

function clientFor(result: unknown[]): ObservabilityClient {
  return {
    promUrl: "http://statshost:9090",
    promRange: vi.fn().mockResolvedValue(new Response(JSON.stringify(body(result)))),
    promInstant: vi.fn(),
    promRules: vi.fn(),
    promAlerts: vi.fn(),
    promConfig: vi.fn(),
    lokiRange: vi.fn(),
    lokiLabels: vi.fn(),
  };
}

/** rank1/ram as measured live: 5.56 GB limit, 401 MB used, 137 MB unevictable, 0.9/0.8 marks. */
const RANK1_RAM = [
  series("rank1", "ram", "size_bytes", 5_557_299_999),
  series("rank1", "ram", "used_bytes", 401_666_796, 500_000_000),
  series("rank1", "ram", "unevictable_bytes", 137_858_560),
  series("rank1", "ram", "evictable_count", 587),
  series("rank1", "ram", "evictions_total", 0),
  series("rank1", "ram", "watermark_cycles_total", 0),
  series("rank1", "ram", "high_watermark", 0.9),
  series("rank1", "ram", "low_watermark", 0.8),
];

async function rowsFor(result: unknown[], input = {}) {
  const r = await tierSnapshot(clientFor(result), input);
  if (!r.ok) throw new Error(`expected success, got: ${r.error}`);
  return r;
}

describe("TierSnapshotSchema", () => {
  it("accepts no arguments and a tier filter", () => {
    expect(TierSnapshotSchema.safeParse({}).success).toBe(true);
    expect(TierSnapshotSchema.safeParse({ tier: "ram" }).success).toBe(true);
  });
});

describe("tierSnapshot", () => {
  it("groups the flat ki_db_tier series into one row per rank and tier", async () => {
    const r = await rowsFor([
      ...RANK1_RAM,
      series("rank0", "ram", "size_bytes", 793_900_000),
      series("rank0", "ram", "used_bytes", 4_194_304),
    ]);
    expect(r.data.tiers).toHaveLength(2);
    expect(r.data.tiers.map((t) => t.rank).sort()).toEqual(["rank0", "rank1"]);
  });

  it("computes utilization against size_bytes, which is the LIMIT not the current size", async () => {
    const r = await rowsFor(RANK1_RAM);
    const [row] = r.data.tiers;
    expect(row.limit).toBe("5.56 GB");
    expect(row.used).toBe("401.67 MB");
    expect(row.used_pct).toBe("7.2%");
  });

  it("reports headroom to the eviction trigger, treating watermarks as fractions", async () => {
    // Measured: high_watermark is 0.9 — a FRACTION of size_bytes, not a byte count.
    // Trigger = 0.9 * 5_557_299_999 = 5_001_570_000; headroom = trigger - used.
    const r = await rowsFor(RANK1_RAM);
    const [row] = r.data.tiers;
    expect(row.to_eviction).toBe("4.60 GB");
    expect(row.status).toBe("ok");
  });

  it("surfaces the windowed peak and when it happened", async () => {
    const r = await rowsFor(RANK1_RAM);
    const [row] = r.data.tiers;
    expect(row.peak).toBe("500.00 MB");
    expect(row.peak_at).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("marks an uncapped tier rather than computing a negative percentage", async () => {
    // Measured: disk0 and persist report size_bytes = -1.
    const r = await rowsFor([
      series("rank1", "persist", "size_bytes", -1),
      series("rank1", "persist", "used_bytes", 42_690_080),
      series("rank1", "persist", "high_watermark", 0.9),
    ]);
    const [row] = r.data.tiers;
    expect(row.limit).toBe("uncapped");
    expect(row.used_pct).toBe("—");
    expect(row.to_eviction).toBe("—");
    expect(row.status).toBe("uncapped");
  });

  it("handles rank0, which reports only size_bytes and used_bytes", async () => {
    const r = await rowsFor([
      series("rank0", "ram", "size_bytes", 793_900_000),
      series("rank0", "ram", "used_bytes", 4_194_304),
    ]);
    const [row] = r.data.tiers;
    expect(row.used_pct).toBe("0.5%");
    expect(row.to_eviction).toBe("—");
    expect(row.unevictable).toBe("—");
    expect(row.status).toBe("ok");
  });

  describe("status verdicts", () => {
    it("flags a tier past its high watermark", async () => {
      const r = await rowsFor([
        series("rank1", "ram", "size_bytes", 1_000_000_000),
        series("rank1", "ram", "used_bytes", 950_000_000),
        series("rank1", "ram", "high_watermark", 0.9),
      ]);
      expect(r.data.tiers[0].status).toBe("over high-watermark");
    });

    it("flags approaching pressure before the watermark is reached", async () => {
      const r = await rowsFor([
        series("rank1", "ram", "size_bytes", 1_000_000_000),
        series("rank1", "ram", "used_bytes", 800_000_000),
        series("rank1", "ram", "high_watermark", 0.9),
      ]);
      expect(r.data.tiers[0].status).toBe("pressure");
    });

    it("says unknown, not uncapped, when the size_bytes series is missing entirely", async () => {
      // A scrape gap must not read as "unlimited, not a problem".
      const r = await rowsFor([series("rank1", "ram", "used_bytes", 100)]);
      const [row] = r.data.tiers;
      expect(row.limit).toBe("—");
      expect(row.status).toBe("unknown");
    });

    it("reports eviction history distinctly from current state", async () => {
      const r = await rowsFor([
        series("rank1", "ram", "size_bytes", 1_000_000_000),
        series("rank1", "ram", "used_bytes", 100_000_000),
        series("rank1", "ram", "high_watermark", 0.9),
        series("rank1", "ram", "evictions_total", 42),
      ]);
      const [row] = r.data.tiers;
      expect(row.evictions).toBe("42");
      // Currently fine, but it HAS evicted — the note must not let that pass silently.
      expect(row.status).toBe("ok");
      expect(r.note).toMatch(/evict/i);
    });
  });

  describe("filtering and failure", () => {
    it("passes a tier filter into the PromQL selector", async () => {
      const client = clientFor(RANK1_RAM);
      await tierSnapshot(client, { tier: "ram" });
      const [query] = (client.promRange as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(query).toContain('tier="ram"');
    });

    it("escapes a quote in a filter value instead of emitting invalid PromQL", async () => {
      const client = clientFor(RANK1_RAM);
      await tierSnapshot(client, { tier: 'ram"' });
      const [query] = (client.promRange as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(query).toBe('ki_db_tier{tier="ram\\""}');
    });

    it("does not throw when an error body parses to null", async () => {
      const client = {
        promRange: vi.fn().mockResolvedValue(new Response("null", { status: 500 })),
      } as unknown as ObservabilityClient;
      const r = await tierSnapshot(client, {});
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.status).toBe(500);
    });

    it("returns a failure, not a throw, when Prometheus is unreachable", async () => {
      const client = {
        promRange: vi.fn().mockRejectedValue(new Error("Prometheus endpoint is not configured")),
      } as unknown as ObservabilityClient;
      const r = await tierSnapshot(client, {});
      expect(r.ok).toBe(false);
    });

    it("reports no data as an explicit empty result", async () => {
      const r = await rowsFor([]);
      expect(r.data.tiers).toHaveLength(0);
      expect(r.note).toMatch(/no .*tier/i);
    });
  });
});
