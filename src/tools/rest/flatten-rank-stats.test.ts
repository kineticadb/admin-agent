import { describe, it, expect } from "vitest";
import { flattenRanksSummary, flattenRankDetail } from "./flatten-rank-stats.js";

/** Realistic decoded Kinetica data (after decodeNestedJsonStrings). */
function makeDecodedStats() {
  return {
    ranks: {
      "0": {
        tiers: {
          RAM: {
            overall: {
              used: 1073741824,
              limit: 8589934592,
              free: 7516192768,
              percent_used: 12.5,
              num_evictable_objs: 10,
              num_unevictable_objs: 2,
            },
          },
          PERSIST: {
            overall: { used: 5368709120 },
          },
          DISK0: {
            overall: { used: 10737418240 },
          },
          "VRAM.GPU0": {
            overall: { used: 2147483648 },
          },
        },
        resource_groups: {
          default: { thread_running_count: 4, data: {} },
        },
      },
      "1": {
        tiers: {
          RAM: {
            overall: {
              used: 2147483648,
              limit: 8589934592,
            },
          },
          PERSIST: {
            overall: { used: 3221225472 },
          },
        },
        resource_groups: {},
      },
    },
  };
}

describe("flattenRanksSummary", () => {
  it("produces one summary row per rank", () => {
    const result = flattenRanksSummary(makeDecodedStats());
    expect(result).toHaveLength(2);
    expect(result[0].rank).toBe("0");
    expect(result[1].rank).toBe("1");
  });

  it("extracts RAM used/limit/percent from tier data", () => {
    const result = flattenRanksSummary(makeDecodedStats());
    expect(result[0].ram_used).toBe("1073741824");
    expect(result[0].ram_limit).toBe("8589934592");
    expect(result[0].ram_percent).toBe("12.5%");
  });

  it("extracts PERSIST, DISK, VRAM used bytes", () => {
    const result = flattenRanksSummary(makeDecodedStats());
    expect(result[0].persist_used).toBe("5368709120");
    expect(result[0].disk_used).toBe("10737418240");
    expect(result[0].vram_used).toBe("2147483648");
  });

  it("matches VRAM prefix for tier names like VRAM.GPU0", () => {
    const result = flattenRanksSummary(makeDecodedStats());
    expect(result[0].vram_used).toBe("2147483648");
  });

  it("matches DISK prefix for tier names like DISK0", () => {
    const result = flattenRanksSummary(makeDecodedStats());
    expect(result[0].disk_used).toBe("10737418240");
  });

  it("returns empty string for missing tiers", () => {
    const result = flattenRanksSummary(makeDecodedStats());
    // Rank 1 has no DISK or VRAM tier
    expect(result[1].disk_used).toBe("");
    expect(result[1].vram_used).toBe("");
  });

  it("returns empty array for empty ranks", () => {
    expect(flattenRanksSummary({ ranks: {} })).toEqual([]);
  });

  it("falls back to treating decoded as ranks map when no ranks key", () => {
    const decoded = {
      "0": {
        tiers: {
          RAM: {
            overall: {
              used: 100,
              limit: 200,
            },
          },
        },
      },
    };
    const result = flattenRanksSummary(decoded);
    expect(result).toHaveLength(1);
    expect(result[0].rank).toBe("0");
    expect(result[0].ram_used).toBe("100");
  });

  it("does not mutate the input", () => {
    const input = makeDecodedStats();
    const copy = JSON.stringify(input);
    flattenRanksSummary(input);
    expect(JSON.stringify(input)).toBe(copy);
  });
});

describe("flattenRankDetail", () => {
  it("returns tiers as rows with overall fields", () => {
    const rankData = makeDecodedStats().ranks["0"];
    const result = flattenRankDetail(rankData);
    expect(result.tiers).toHaveLength(4);
    expect(result.tiers[0].tier).toBe("RAM");
    expect(result.tiers[0].used).toBe("1073741824");
    expect(result.tiers[0].limit).toBe("8589934592");
  });

  it("returns resource_groups as rows with thread_running_count", () => {
    const rankData = makeDecodedStats().ranks["0"];
    const result = flattenRankDetail(rankData);
    expect(result.resource_groups).toHaveLength(1);
    expect(result.resource_groups[0].name).toBe("default");
    expect(result.resource_groups[0].thread_running_count).toBe("4");
  });

  it("returns empty arrays when tiers/resource_groups are missing", () => {
    const result = flattenRankDetail({});
    expect(result.tiers).toEqual([]);
    expect(result.resource_groups).toEqual([]);
  });

  it("does not mutate the input", () => {
    const input = makeDecodedStats().ranks["0"];
    const copy = JSON.stringify(input);
    flattenRankDetail(input);
    expect(JSON.stringify(input)).toBe(copy);
  });
});
