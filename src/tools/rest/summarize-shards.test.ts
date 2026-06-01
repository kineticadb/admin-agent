import { describe, it, expect } from "vitest";
import { summarizeShards } from "./summarize-shards.js";

/** Helper: build a shard_map with `count` shards distributed round-robin across `ranks`. */
function makeShardsRoundRobin(ranks: readonly string[], count: number) {
  const shard_map: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    shard_map[String(i)] = ranks[i % ranks.length];
  }
  return shard_map;
}

describe("summarizeShards", () => {
  it("summarizes a balanced 2-rank distribution", () => {
    const shard_map = makeShardsRoundRobin(["rank_1", "rank_2"], 16384);
    const result = summarizeShards({ shard_array_version: 5, shard_map });

    expect(result.shard_array_version).toBe(5);
    expect(result.total_shards).toBe(16384);
    expect(result.rank_count).toBe(2);
    expect(result.balanced).toBe(true);
    expect(result.distribution).toEqual([
      { rank: "rank_1", shard_count: 8192, percent: "50.0%" },
      { rank: "rank_2", shard_count: 8192, percent: "50.0%" },
    ]);
  });

  it("detects an unbalanced 3-rank distribution", () => {
    const shard_map: Record<string, string> = {};
    for (let i = 0; i < 8000; i++) shard_map[String(i)] = "rank_1";
    for (let i = 8000; i < 13000; i++) shard_map[String(i)] = "rank_2";
    for (let i = 13000; i < 16384; i++) shard_map[String(i)] = "rank_3";

    const result = summarizeShards({ shard_map });

    expect(result.total_shards).toBe(16384);
    expect(result.rank_count).toBe(3);
    expect(result.balanced).toBe(false);
    expect(result.distribution).toEqual([
      { rank: "rank_1", shard_count: 8000, percent: "48.8%" },
      { rank: "rank_2", shard_count: 5000, percent: "30.5%" },
      { rank: "rank_3", shard_count: 3384, percent: "20.7%" },
    ]);
  });

  it("handles a single rank", () => {
    const shard_map = makeShardsRoundRobin(["rank_1"], 16384);
    const result = summarizeShards({ shard_map });

    expect(result.rank_count).toBe(1);
    expect(result.balanced).toBe(true);
    expect(result.distribution).toEqual([
      { rank: "rank_1", shard_count: 16384, percent: "100.0%" },
    ]);
  });

  it("handles an empty shard_map", () => {
    const result = summarizeShards({ shard_map: {} });

    expect(result.total_shards).toBe(0);
    expect(result.rank_count).toBe(0);
    expect(result.distribution).toEqual([]);
    expect(result.balanced).toBe(true);
  });

  it("handles missing shard_map property", () => {
    const result = summarizeShards({ shard_array_version: 3 });

    expect(result.shard_array_version).toBe(3);
    expect(result.total_shards).toBe(0);
    expect(result.rank_count).toBe(0);
    expect(result.distribution).toEqual([]);
    expect(result.balanced).toBe(true);
  });

  it("handles null input gracefully", () => {
    const result = summarizeShards(null);

    expect(result.total_shards).toBe(0);
    expect(result.rank_count).toBe(0);
    expect(result.distribution).toEqual([]);
    expect(result.balanced).toBe(true);
    expect(result.shard_array_version).toBeUndefined();
  });

  it("handles undefined input gracefully", () => {
    const result = summarizeShards(undefined);

    expect(result.total_shards).toBe(0);
    expect(result.distribution).toEqual([]);
    expect(result.balanced).toBe(true);
  });

  it("preserves shard_array_version when present", () => {
    const result = summarizeShards({ shard_array_version: 42, shard_map: { "0": "rank_1" } });
    expect(result.shard_array_version).toBe(42);
  });

  it("returns undefined shard_array_version when absent", () => {
    const result = summarizeShards({ shard_map: { "0": "rank_1" } });
    expect(result.shard_array_version).toBeUndefined();
  });

  it("considers near-balanced distribution (off by 1) as balanced", () => {
    // 16384 / 3 = 5461.33... → two ranks get 5461, one gets 5462
    const shard_map = makeShardsRoundRobin(["rank_1", "rank_2", "rank_3"], 16384);
    const result = summarizeShards({ shard_map });

    expect(result.balanced).toBe(true);
    const counts = result.distribution.map((d) => d.shard_count);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("does not mutate the input object", () => {
    const shard_map = { "0": "rank_1", "1": "rank_2" };
    const input = { shard_array_version: 1, shard_map };
    const inputCopy = JSON.parse(JSON.stringify(input));

    summarizeShards(input);

    expect(input).toEqual(inputCopy);
  });

  it("sorts distribution by rank name", () => {
    const shard_map: Record<string, string> = {
      "0": "rank_3",
      "1": "rank_1",
      "2": "rank_2",
    };
    const result = summarizeShards({ shard_map });

    const rankNames = result.distribution.map((d) => d.rank);
    expect(rankNames).toEqual(["rank_1", "rank_2", "rank_3"]);
  });
});
