/**
 * setupObservability — resolve this session's Prometheus/Loki access at startup.
 *
 * Owns the one question discovery cannot answer for itself: where the property map comes
 * from. A live session reads /show/system/properties; a bundle reads its captured
 * gpudb.conf. When both are present they are MERGED with live winning per key — /show
 * omits `event_server_port` entirely, so the bundle is its only source.
 *
 * Bundle support matters because the stats stack runs on a different host and commonly
 * outlives the cluster a bundle came from.
 *
 * Never throws, never blocks startup: any failure degrades to "no observability".
 */

import type { KineticaSession } from "../types/index.js";
import type { BundleSource } from "../bundle/BundleSource.js";
import { getSystemProperties } from "../tools/rest/system-properties.js";
import {
  discoverObservability,
  STATS_HOST_ENV_VAR,
  readStatsHostEnv,
  type EndpointProbe,
} from "../observability/discover.js";

/** Trim an operator-supplied host, treating blank as absent. */
function nonEmptyHost(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
import {
  createObservabilityClient,
  type ObservabilityClient,
} from "../observability/ObservabilityClient.js";

export type SetupObservabilityOptions = {
  readonly session?: KineticaSession;
  readonly bundleSource?: BundleSource;
  /** Injectable probe; defaults to discovery's own short-timeout GET. */
  readonly probe?: EndpointProbe;
  /** Injectable environment; defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Prometheus/Loki base URL the operator supplied at startup (collectCredentials asks
   * for it right after the password). Outranks anything gpudb.conf declares, because
   * that file names the cluster's internal address.
   */
  readonly statsHost?: string;
};

/** Prefix `/show/system/properties` adds to most property names. */
const SHOW_PREFIX = "conf.";

export type SetupObservabilityResult = {
  /** Undefined when nothing was reachable. */
  readonly client?: ObservabilityClient;
  /** One dim startup line for stderr. */
  readonly line: string;
};

/**
 * Property map from a live cluster. Returns {} on any failure.
 *
 * Keys are normalized to the BARE spelling by stripping the `conf.` prefix, so the merge
 * below means what it says: leaving them prefixed puts the two maps in different
 * namespaces where they never collide, and lookupProperty's exact-match-first order then
 * silently prefers the bundle value.
 */
async function propsFromSession(
  session: KineticaSession,
): Promise<Readonly<Record<string, string>>> {
  try {
    const result = await getSystemProperties(session, {});
    if (!result.ok) return {};
    const rows = result.data as ReadonlyArray<{ property?: string; value?: string }>;
    return rows.reduce<Record<string, string>>((acc, r) => {
      if (!r.property) return acc;
      const bare = r.property.startsWith(SHOW_PREFIX)
        ? r.property.slice(SHOW_PREFIX.length)
        : r.property;
      return { ...acc, [bare]: r.value ?? "" };
    }, {});
  } catch {
    return {};
  }
}

/**
 * Keys accepted FROM A BUNDLE.
 *
 * SECURITY: a bundle is untrusted input (see bundle/bundle-index.ts), so no value in it
 * may become the HOST of an outbound request — a crafted `event_server_address` would
 * otherwise make `--bundle=` fire a GET at an attacker-chosen host before the operator
 * interacts with anything. Ports are safe and are why a bundle is consulted at all:
 * /show omits `event_server_port`. Hosts come from the operator, the live cluster, or the
 * database host already reached.
 *
 * An allow-list, not a deny-list: the latter readmits the hole the moment a new key
 * becomes a network target. Cost is near zero — the declared address is internal anyway.
 */
const BUNDLE_TRUSTED_KEYS: ReadonlySet<string> = new Set([
  "enable_stats_server",
  "event_server_port",
]);

/**
 * Property map from a bundle's gpudb.conf. Returns {} on any failure.
 *
 * gpudb.conf is a SECTIONED ini where the same bare key can recur, so a naive flatten
 * lets a later section overwrite an earlier one. Discovery's keys live in `[gaia]`, so
 * gaia wins and other sections fill only what it did not define.
 */
const PREFERRED_SECTION = "gaia";

async function propsFromBundle(source: BundleSource): Promise<Readonly<Record<string, string>>> {
  try {
    const result = await source.readConfig({});
    if ("error" in result) return {};
    // Filtered to BUNDLE_TRUSTED_KEYS before anything else — see the note above.
    const trusted = result.entries.filter((e) => BUNDLE_TRUSTED_KEYS.has(e.key));
    const others = trusted
      .filter((e) => e.section !== PREFERRED_SECTION)
      .reduce<Record<string, string>>((acc, e) => ({ ...acc, [e.key]: e.value }), {});
    const preferred = trusted
      .filter((e) => e.section === PREFERRED_SECTION)
      .reduce<Record<string, string>>((acc, e) => ({ ...acc, [e.key]: e.value }), {});
    return { ...others, ...preferred };
  } catch {
    return {};
  }
}

/** Hostname of the database as the operator actually reached it. */
function hostOf(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

/** Compose the startup line from what was found and what was tried. */
function statusLine(
  client: ObservabilityClient | undefined,
  unreachable: readonly string[],
  envHost: string | undefined,
): string {
  const found = [
    client?.promUrl ? "Prometheus" : undefined,
    client?.lokiUrl ? "Loki" : undefined,
  ].filter(Boolean);

  if (found.length > 0) return `Observability: ${found.join(", ")}`;

  // Three distinct situations, three distinct messages. Blaming gpudb.conf for an
  // operator's typo would send them to the wrong file, so the override is reported as
  // its own failure.
  if (envHost && unreachable.some((u) => u.includes(envHost))) {
    return (
      `Observability: ${STATS_HOST_ENV_VAR}=${envHost} did not answer as Prometheus or Loki ` +
      `(tried ${unreachable[0]}). Check the hostname, or unset it to fall back to gpudb.conf`
    );
  }
  if (unreachable.length > 0) {
    return (
      `Observability: declared at ${unreachable[0]} but unreachable from here — ` +
      `gpudb.conf names the stats host on the cluster's internal network. Run the agent ` +
      `from a host that routes it, or set ${STATS_HOST_ENV_VAR} to a reachable hostname`
    );
  }
  return "Observability: none detected";
}

/**
 * Discover and construct this session's observability client.
 *
 * @param opts - live session and/or bundle to source config from
 */
export async function setupObservability(
  opts: SetupObservabilityOptions,
): Promise<SetupObservabilityResult> {
  // Merge rather than choose: the bundle is the only source of event_server_port, and a
  // --bundle run with a reachable cluster has both.
  const [live, bundle] = await Promise.all([
    opts.session ? propsFromSession(opts.session) : Promise.resolve({}),
    opts.bundleSource ? propsFromBundle(opts.bundleSource) : Promise.resolve({}),
  ]);
  const properties = { ...bundle, ...live };

  const { endpoints, unreachable } = await discoverObservability({
    properties,
    dbHost: hostOf(opts.session?.baseUrl),
    probe: opts.probe,
    // The operator's answer takes precedence; the env var remains for non-interactive runs.
    env: opts.statsHost ? { [STATS_HOST_ENV_VAR]: opts.statsHost } : opts.env,
  });

  const envHost = nonEmptyHost(opts.statsHost) ?? readStatsHostEnv(opts.env);
  const anyFound = Object.values(endpoints).some(Boolean);
  const client = anyFound ? createObservabilityClient(endpoints) : undefined;

  return { client, line: statusLine(client, unreachable, envHost) };
}
