/**
 * discoverObservability — best-effort resolution of a cluster's Prometheus and Loki
 * endpoints. Like probeHostManager()/connectBestEffort(): never throws, never prompts,
 * returns only what answered.
 *
 * Two facts measured against a live 7.2.3.20 kagent install shape this:
 *   - The stats stack is NOT on the database host, and the address gpudb.conf declares is
 *     usually INTERNAL — so a declared host is one candidate among several, and
 *     declared-but-unreachable is reported distinctly from absent.
 *   - Prometheus is not declared anywhere (it scrapes the ranks, so the database never
 *     needs its address), hence probing rather than reading.
 */

import { lookupProperty } from "../tools/mutation/alter-system-properties.js";
import type { ObservabilityEndpoints } from "./ObservabilityClient.js";

/** Conventional Prometheus port on the event-server host. Never declared in gpudb.conf. */
export const DEFAULT_PROM_PORT = 9090;
/** Default `gaia.event_server_port` (Loki HTTP). */
export const DEFAULT_LOKI_PORT = 9080;
// Alertmanager is deliberately NOT discovered: no tool reads it (Prometheus serves its
// rules and firing state), and probing it added ~3s to every startup.

/** How long to wait for a service to answer before calling it absent. */
const PROBE_TIMEOUT_MS = 3_000;

/** Which service a candidate URL is supposed to be. */
export type ObservabilityService = "prometheus" | "loki";

/** Probes a base URL, resolving true when THAT service is listening there. */
export type EndpointProbe = (url: string, service: ObservabilityService) => Promise<boolean>;

/** Inputs for discovery. Every field is optional; absent inputs simply narrow the result. */
/** Environment variable naming a reachable stats host, overriding config. */
export const STATS_HOST_ENV_VAR = "KINETICA_STATS_HOST";

/**
 * Read the stats host from an environment, treating blank as unset. Shared by credential
 * collection, the connect path and startup wiring so the blank rule lives in one place.
 */
export function readStatsHostEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return nonEmpty(env[STATS_HOST_ENV_VAR]);
}

export type DiscoverOptions = {
  /** Environment to read the override from. Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Property map from `/show/system/properties` (conf.-prefixed), a full gpudb.conf, or
   * a bundle. Either spelling works — `lookupProperty` reconciles them.
   */
  readonly properties?: Readonly<Record<string, string>>;
  /** Liveness probe. Injectable for tests; defaults to a short-timeout GET. */
  readonly probe?: EndpointProbe;
  /** The database host, used when `event_server_internal` is true. */
  readonly dbHost?: string;
};

/**
 * Per-service identity check. "Something answered" is not evidence: on RHEL/CentOS
 * Cockpit owns 9090 by default, the same port guessed for Prometheus, so a liveness-only
 * check reports Prometheus on a cluster that has none.
 *
 * Loki's `data` is optional — that endpoint defaults to a 6-hour window and a quiet
 * cluster answers a bare {"status":"success"}. Requiring the array rejects a healthy Loki.
 *
 * Never throws; any transport, status, parse or shape failure means "not here".
 */
const IDENTITY_PATHS: Readonly<Record<ObservabilityService, string>> = {
  prometheus: "/api/v1/status/buildinfo",
  loki: "/loki/api/v1/labels",
};

async function defaultProbe(url: string, service: ObservabilityService): Promise<boolean> {
  try {
    const response = await fetch(`${url}${IDENTITY_PATHS[service]}`, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    if (body === null || typeof body !== "object") return false;
    const { status, data } = body as { status?: unknown; data?: unknown };
    if (status !== "success") return false;
    if (service === "loki") return data === undefined || Array.isArray(data);
    // Prometheus buildinfo always carries a version; requiring it rules out a lookalike
    // that happens to answer "success" on this path.
    return typeof (data as { version?: unknown } | undefined)?.version === "string";
  } catch {
    return false;
  }
}

/**
 * Collapse absent-or-blank to undefined.
 *
 * Note this is deliberately NOT `??`: gpudb.conf and the environment both express "unset"
 * as an empty string (`alert_exe =`, `KINETICA_STATS_HOST=`), and `??` would pass those
 * through as a valid value, yielding a probe against `http://:9090`.
 */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/** Read a config value by bare key, tolerating the `conf.` prefix and dot-sectioned spellings. */
function conf(
  properties: Readonly<Record<string, string>> | undefined,
  key: string,
): string | undefined {
  if (!properties) return undefined;
  // lookupProperty is the project's single definition of resolving a name across both
  // /show and /alter spellings; duplicating it here is how read-backs drift.
  return nonEmpty(lookupProperty({ ...properties }, key));
}

/** Parse gpudb.conf's boolean spellings. Returns undefined when the key is absent. */
function confBool(
  properties: Readonly<Record<string, string>> | undefined,
  key: string,
): boolean | undefined {
  const raw = conf(properties, key)?.toLowerCase();
  if (raw === undefined) return undefined;
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Resolve a `${gaia.some_key}` interpolation. gpudb.conf uses them for addresses and
 * bundle/parse-ini.ts surfaces them verbatim, so without this a read could yield a host
 * literally named `${gaia.…}`.
 */
function resolveInterpolation(
  value: string | undefined,
  properties: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (!value) return undefined;
  const match = /^\$\{(?:gaia\.)?(.+)\}$/.exec(value.trim());
  if (!match) return value;
  return conf(properties, match[1]);
}

/**
 * Map an internal host address to its declared `hostN.public_address`, turning an
 * unroutable address into a reachable one when the event server is co-located with a
 * database host. A declared translation, not an inference: no `hostN` entry yields nothing.
 */
function publicAddressFor(
  properties: Readonly<Record<string, string>> | undefined,
  internalHost: string | undefined,
): string | undefined {
  if (!properties || !internalHost) return undefined;
  const hostPrefix = Object.entries(properties).reduce<string | undefined>(
    (found, [key, value]) => {
      if (found !== undefined) return found;
      const m = /^(?:conf\.)?(host\d+)\.(?:ha_)?address$/.exec(key);
      return m !== null && value.trim() === internalHost ? m[1] : undefined;
    },
    undefined,
  );
  return hostPrefix ? conf(properties, `${hostPrefix}.public_address`) : undefined;
}

/**
 * Build a base URL, defaulting to http (the stats stack is plain HTTP on kagent).
 *
 * SECURITY: normalizes through hostOnly() rather than concatenating, so a value carrying
 * a path, query, fragment or userinfo cannot steer the probe. Done HERE, not at call
 * sites, so a future caller cannot reintroduce the hole. Undefined for an unparseable
 * host, so junk yields no candidate.
 */
function toUrl(host: string, port: number): string | undefined {
  const base = hostOnly(host);
  return base === undefined ? undefined : `${base}:${port}`;
}

/** Parse a declared port, falling back when absent or nonsensical. */
function portOr(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : fallback;
}

/**
 * One candidate URL and whether config actually named it. A declared endpoint that fails
 * means "deployed but unroutable" (actionable); a failed fallback guess just means "not
 * here" — reporting the latter as declared sends the operator hunting for nothing.
 */
type Candidate = {
  readonly url: string;
  readonly declared: boolean;
  readonly service: ObservabilityService;
};

/** Ordered candidates for one service, most authoritative first. */
type CandidateSet = Readonly<Record<keyof ObservabilityEndpoints, readonly Candidate[]>>;

/** Outcome of discovery. */
export type DiscoveryResult = {
  /** Endpoints that were overridden or answered a probe. */
  readonly endpoints: ObservabilityEndpoints;
  /**
   * DECLARED URLs that did not answer. Non-empty here means the stack is DEPLOYED but not
   * reachable from where the agent runs — usually because the config declares an internal
   * address. Fallback guesses that failed are deliberately excluded: they carry no such
   * claim, and reporting them would invent a deployment that was never configured.
   */
  readonly unreachable: readonly string[];
};

/**
 * Discover the observability endpoints reachable for this session.
 *
 * Host resolution order, every entry verified by an identity probe:
 *   1. KINETICA_STATS_HOST (operator override)
 *   2. gaia.event_server_public_address
 *   3. gaia.event_server_address
 *   4. that address's declared hostN.public_address translation
 *   5. the database host the operator actually reached
 *
 * Ports are per service, never per host: Prometheus at 9090, Loki at gaia.event_server_port
 * (default 9080). This mirrors gpudb.conf, which declares one address and several ports.
 *
 * @returns only the endpoints that answered; `{}` when none did
 */
export async function discoverObservability(opts?: DiscoverOptions): Promise<DiscoveryResult> {
  const env = opts?.env ?? process.env;
  const probe = opts?.probe ?? defaultProbe;
  const properties = opts?.properties;

  const candidates = buildCandidates(properties, opts?.dbHost, hostOnly(env[STATS_HOST_ENV_VAR]));

  const outcomes = await Promise.all(
    (Object.keys(candidates) as (keyof ObservabilityEndpoints)[]).map((key) =>
      firstReachable(key, candidates[key], probe),
    ),
  );

  return outcomes.reduce<DiscoveryResult>(
    (acc, o) => ({
      endpoints: o.url ? { ...acc.endpoints, [o.key]: o.url } : acc.endpoints,
      unreachable: [...acc.unreachable, ...o.missed],
    }),
    { endpoints: {}, unreachable: [] },
  );
}

/**
 * Reduce a value to `scheme://host`. Path, query, fragment, userinfo and port are dropped
 * — rebuilding from the parsed URL is what makes an untrusted config value safe to fetch.
 * Scheme is kept (a TLS stack must not be downgraded); port is not, since ports are per
 * service and one here would be ambiguous about which.
 */
function hostOnly(raw: string | undefined): string | undefined {
  const value = nonEmpty(raw);
  if (!value) return undefined;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`);
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return undefined;
  }
}

/**
 * Probe an ordered candidate list, stopping at the first that answers.
 *
 * Sequential rather than parallel on purpose: the first candidate is the declared one and
 * usually correct, so the common path costs a single probe. Candidates tried and missed
 * are returned so the caller can tell "deployed but unreachable" from "not deployed".
 */
async function firstReachable(
  key: keyof ObservabilityEndpoints,
  candidates: readonly Candidate[],
  probe: EndpointProbe,
): Promise<{ key: keyof ObservabilityEndpoints; url?: string; missed: readonly string[] }> {
  const missed: string[] = [];
  for (const candidate of candidates) {
    try {
      if (await probe(candidate.url, candidate.service)) return { key, url: candidate.url, missed };
    } catch {
      // A throwing probe is a miss, never a crash.
    }
    // Only a declared miss is reportable — see the Candidate docstring.
    if (candidate.declared) missed.push(candidate.url);
  }
  return { key, missed };
}

/** Derive ordered candidates per service. Empty lists when the stack is absent or off. */
function buildCandidates(
  properties: Readonly<Record<string, string>> | undefined,
  dbHost: string | undefined,
  envHost: string | undefined,
): CandidateSet {
  const empty: CandidateSet = { promUrl: [], lokiUrl: [] };

  // An explicit `false` means the stack is off — don't spend probes proving it. An
  // operator override outranks that: they know it is there.
  if (!envHost && confBool(properties, "enable_stats_server") === false) return empty;

  const internal = confBool(properties, "event_server_internal") === true;
  const reachableHost = dbHost?.trim();
  // `_public_address` first, following gpudb.conf's own `hostN.address` /
  // `hostN.public_address` convention. Interpolation-resolved: a literal `${gaia.…}` from
  // a bundle-sourced read must not become a hostname.
  const declaredHost = internal
    ? reachableHost
    : (resolveInterpolation(conf(properties, "event_server_public_address"), properties) ??
      resolveInterpolation(conf(properties, "event_server_address"), properties));
  if (!envHost && !declaredHost && !reachableHost) return empty;

  const lokiPort = portOr(conf(properties, "event_server_port"), DEFAULT_LOKI_PORT);

  /**
   * Ordered hosts to try for one service: the declared address, its declared public
   * translation, then the database host as the operator actually reached it. Deduped so a
   * single-host deployment costs exactly one probe.
   */
  const tiers = (
    primary: string | undefined,
    port: number,
    service: ObservabilityService,
  ): readonly Candidate[] => {
    // envHost first: an operator naming a host has better information than the file.
    const declaredHosts = [envHost, primary, publicAddressFor(properties, primary)].filter(
      (h): h is string => Boolean(h),
    );
    const seen = new Set<string>();
    return [
      ...declaredHosts.map((h) => ({ host: h, declared: true })),
      ...(reachableHost ? [{ host: reachableHost, declared: false }] : []),
    ]
      .filter(({ host }) => (seen.has(host) ? false : (seen.add(host), true)))
      .flatMap(({ host, declared }) => {
        // toUrl returns undefined for anything that is not a parseable host; such a value
        // produces no candidate at all rather than a malformed request.
        const url = toUrl(host, port);
        return url === undefined ? [] : [{ url, declared, service }];
      });
  };

  return {
    promUrl: tiers(declaredHost, DEFAULT_PROM_PORT, "prometheus"),
    lokiUrl: tiers(declaredHost, lokiPort, "loki"),
  };
}
