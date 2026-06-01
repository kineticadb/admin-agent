/**
 * discoverHmPort — discovers the Kinetica host manager HTTP port.
 *
 * Reads conf.hm_http_port from /show/system/properties.
 * Falls back to DEFAULT_HM_PORT (9300) if the property is missing, unparseable,
 * or the lookup fails entirely.
 *
 * Never throws — all error paths return the default port.
 */
import type { KineticaSession } from "../../types/index.js";
import { getSystemProperties } from "./system-properties.js";

/** Default Kinetica host manager port. */
export const DEFAULT_HM_PORT = 9300;

/**
 * Discover the host manager HTTP port from system properties.
 * Falls back to DEFAULT_HM_PORT (9300) if the property is missing or unparseable.
 */
export async function discoverHmPort(session: KineticaSession): Promise<number> {
  const result = await getSystemProperties(session, { key_pattern: "hm_http_port" });
  if (!result.ok) return DEFAULT_HM_PORT;

  const rows = result.data as ReadonlyArray<Record<string, string>>;
  const entry = rows.find((r) => r.property?.includes("hm_http_port"));
  if (!entry?.value) return DEFAULT_HM_PORT;

  const port = parseInt(entry.value, 10);
  return Number.isFinite(port) ? port : DEFAULT_HM_PORT;
}
