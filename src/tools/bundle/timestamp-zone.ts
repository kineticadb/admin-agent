/**
 * timestamp-zone — how the bundle log tools report which clock a result's stamps came from.
 *
 * When a result spans both log families the tools say so rather than let the agent order
 * across them: a confident wrong ordering is worse than a stated unknown, which is what
 * Evidence Gaps is for. See TimestampZone for the two clocks and why no offset exists.
 *
 * Bundle-scoped — every string here names the bundle's own directories.
 */

import type { TimestampZone } from "../../bundle/parse-log-line.js";

const ZONE_DESCRIPTION: Readonly<Record<TimestampZone, string>> = {
  local: "local (host wall clock as Kinetica wrote it, no zone marker)",
  utc: "utc (Loki export, stamped by Loki)",
};

/** More than one clock in one result. */
export function isMixedZones(zones: readonly TimestampZone[]): boolean {
  return zones.length > 1;
}

/** Value for a result's `timestamp_zone` field. */
export function zoneLabel(zones: readonly TimestampZone[]): string {
  if (zones.length === 0) return "none";
  if (isMixedZones(zones)) return `MIXED: ${zones.join(" + ")} — see note`;
  return ZONE_DESCRIPTION[zones[0]];
}

const MIXED_ZONE_BASE =
  "Timestamps MIX two clocks: rolling logs (logs-local/) are host-local wall time with no " +
  "zone marker; Loki tails (logs/) are UTC. The bundle does not record the host's UTC " +
  "offset, so do not order or align lines across the two families unless that offset is known.";

/** Appended to a search note when the matches mix clocks. */
export const MIXED_ZONE_SEARCH_NOTE = `${MIXED_ZONE_BASE} Cite each timestamp with its zone column.`;

/** Appended to a timeline note when the counted lines mix clocks. */
export const MIXED_ZONE_TIMELINE_NOTE =
  `${MIXED_ZONE_BASE} Buckets here merge both clocks, so one spike can appear split or ` +
  "doubled across buckets by that offset — re-run with rank= or host_manager= to isolate one family.";
