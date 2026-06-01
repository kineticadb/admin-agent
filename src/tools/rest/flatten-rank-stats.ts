/**
 * Flatten Kinetica rank statistics into tabular rows.
 *
 * After `decodeNestedJsonStrings`, the statistics_map has structure:
 *   { ranks: { "0": { tiers: { RAM: { overall: {...} }, ... }, resource_groups: {...} }, ... } }
 *
 * `flattenRanksSummary` produces one summary row per rank for the metrics overview.
 * `flattenRankDetail` produces detailed tier + resource-group breakdown for a single rank.
 *
 * Pure functions — never throw, never mutate inputs.
 */

import { stringifyValue } from "../../output/stringify.js";

export interface RankSummaryRow {
  readonly rank: string;
  readonly ram_used: string;
  readonly ram_limit: string;
  readonly ram_percent: string;
  readonly persist_used: string;
  readonly disk_used: string;
  readonly vram_used: string;
}

export interface RankDetail {
  readonly tiers: readonly Record<string, string>[];
  readonly resource_groups: readonly Record<string, string>[];
}

/**
 * Find the first tier whose name equals or starts with the given prefix.
 */
function findTier(
  tiers: Record<string, unknown>,
  prefix: string,
): Record<string, unknown> | undefined {
  for (const [name, data] of Object.entries(tiers)) {
    if (
      name === prefix ||
      name.startsWith(`${prefix}.`) ||
      name.startsWith(`${prefix}_`) ||
      (name.startsWith(prefix) && /^\d/.test(name.slice(prefix.length)))
    ) {
      if (typeof data === "object" && data !== null && !Array.isArray(data)) {
        return data as Record<string, unknown>;
      }
    }
  }
  return undefined;
}

/**
 * Extract a field from a tier's "overall" sub-object.
 */
function overallField(tier: Record<string, unknown> | undefined, field: string): string {
  if (!tier) return "";
  const overall = tier.overall;
  if (typeof overall !== "object" || overall === null) return "";
  const value = (overall as Record<string, unknown>)[field];
  return stringifyValue(value);
}

/**
 * Compute percentage from used/available byte strings.
 */
function computePercent(used: string, limit: string): string {
  if (!used || !limit) return "";
  const usedN = Number(used);
  const limitN = Number(limit);
  if (!Number.isFinite(usedN) || !Number.isFinite(limitN) || limitN === 0) return "";
  return `${((usedN / limitN) * 100).toFixed(1)}%`;
}

/**
 * Produce one summary row per rank.
 *
 * Navigates into `decoded.ranks` when present, otherwise treats the entire
 * decoded object as a ranks map.
 */
export function flattenRanksSummary(decoded: Record<string, unknown>): readonly RankSummaryRow[] {
  const ranksRaw =
    typeof decoded.ranks === "object" && decoded.ranks !== null
      ? (decoded.ranks as Record<string, unknown>)
      : decoded;

  return Object.entries(ranksRaw)
    .filter(([, v]) => typeof v === "object" && v !== null && !Array.isArray(v))
    .map(([rankId, rankData]) => {
      const rank = rankData as Record<string, unknown>;
      const tiers =
        typeof rank.tiers === "object" && rank.tiers !== null
          ? (rank.tiers as Record<string, unknown>)
          : {};

      const ramUsed = overallField(findTier(tiers, "RAM"), "used");
      const ramLimit = overallField(findTier(tiers, "RAM"), "limit");

      return {
        rank: rankId,
        ram_used: ramUsed,
        ram_limit: ramLimit,
        ram_percent: computePercent(ramUsed, ramLimit),
        persist_used: overallField(findTier(tiers, "PERSIST"), "used"),
        disk_used: overallField(findTier(tiers, "DISK"), "used"),
        vram_used: overallField(findTier(tiers, "VRAM"), "used"),
      };
    });
}

/**
 * Produce detailed breakdown for a single rank.
 *
 * Returns `{ tiers: [...], resource_groups: [...] }` suitable for
 * `formatOutput()` which renders nested objects as labeled subsections.
 */
export function flattenRankDetail(rankData: Record<string, unknown>): RankDetail {
  const tiersRaw =
    typeof rankData.tiers === "object" && rankData.tiers !== null
      ? (rankData.tiers as Record<string, unknown>)
      : {};

  const tiers = Object.entries(tiersRaw)
    .filter(([, v]) => typeof v === "object" && v !== null && !Array.isArray(v))
    .map(([tierName, tierData]) => {
      const tier = tierData as Record<string, unknown>;
      const overall =
        typeof tier.overall === "object" && tier.overall !== null
          ? (tier.overall as Record<string, unknown>)
          : {};
      const stats =
        typeof tier.stats === "object" && tier.stats !== null
          ? (tier.stats as Record<string, unknown>)
          : {};

      const row: Record<string, string> = { tier: tierName };
      for (const [k, v] of Object.entries(overall)) {
        row[k] = stringifyValue(v);
      }
      for (const [k, v] of Object.entries(stats)) {
        row[k] = stringifyValue(v);
      }
      return row;
    });

  const rgRaw =
    typeof rankData.resource_groups === "object" && rankData.resource_groups !== null
      ? (rankData.resource_groups as Record<string, unknown>)
      : {};

  const resource_groups = Object.entries(rgRaw)
    .filter(([, v]) => typeof v === "object" && v !== null && !Array.isArray(v))
    .map(([rgName, rgData]) => {
      const rg = rgData as Record<string, unknown>;
      const row: Record<string, string> = { name: rgName };
      for (const [k, v] of Object.entries(rg)) {
        row[k] = stringifyValue(v);
      }
      return row;
    });

  return { tiers, resource_groups };
}
