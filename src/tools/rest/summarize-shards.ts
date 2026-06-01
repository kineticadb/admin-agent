/**
 * summarizeShards — converts the raw /admin/show/shards response into a compact
 * distribution summary suitable for agent consumption.
 *
 * The raw shard map contains 16,384 individual shard-to-rank entries. Passing this
 * through formatOutput() produces ~16,390 lines of useless noise that overwhelms
 * the truncation budget and buries alerts/jobs data. This function reduces it to
 * a handful of rows showing per-rank shard counts and a balanced flag.
 *
 * Pure function — never throws, never mutates input.
 */

export type ShardRankDistribution = {
  readonly rank: string;
  readonly shard_count: number;
  readonly percent: string;
};

export type ShardSummary = {
  readonly shard_array_version: number | undefined;
  readonly total_shards: number;
  readonly rank_count: number;
  readonly distribution: ReadonlyArray<ShardRankDistribution>;
  readonly balanced: boolean;
};

const EMPTY_SUMMARY: ShardSummary = {
  shard_array_version: undefined,
  total_shards: 0,
  rank_count: 0,
  distribution: [],
  balanced: true,
};

/**
 * Summarize a raw /admin/show/shards response into a compact distribution.
 *
 * @param raw - Parsed JSON from /admin/show/shards (or null/undefined for graceful degradation)
 * @returns ShardSummary with per-rank distribution, total count, and balanced flag
 */
export function summarizeShards(raw: unknown): ShardSummary {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return EMPTY_SUMMARY;
  }

  const obj = raw as Record<string, unknown>;
  const version = typeof obj.shard_array_version === "number" ? obj.shard_array_version : undefined;

  const shardMap = obj.shard_map;
  if (
    shardMap === null ||
    shardMap === undefined ||
    typeof shardMap !== "object" ||
    Array.isArray(shardMap)
  ) {
    return { ...EMPTY_SUMMARY, shard_array_version: version };
  }

  const entries = Object.values(shardMap as Record<string, string>);
  if (entries.length === 0) {
    return { ...EMPTY_SUMMARY, shard_array_version: version };
  }

  // Count shards per rank (immutable reduce)
  const counts = entries.reduce<ReadonlyMap<string, number>>((acc, rank) => {
    const map = new Map(acc);
    map.set(rank, (acc.get(rank) ?? 0) + 1);
    return map;
  }, new Map());

  const totalShards = entries.length;

  // Build distribution sorted by rank name
  const distribution: ReadonlyArray<ShardRankDistribution> = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rank, count]) => ({
      rank,
      shard_count: count,
      percent: `${((count / totalShards) * 100).toFixed(1)}%`,
    }));

  // Balanced when max - min shard count across ranks is <= 1
  const shardCounts = distribution.map((d) => d.shard_count);
  const balanced = Math.max(...shardCounts) - Math.min(...shardCounts) <= 1;

  return {
    shard_array_version: version,
    total_shards: totalShards,
    rank_count: counts.size,
    distribution,
    balanced,
  };
}
