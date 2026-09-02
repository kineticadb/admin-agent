/**
 * ObservabilityClient — read-only HTTP access to a cluster's Prometheus and Loki.
 *
 * Deliberately NOT built on KineticaSession: that POSTs with a Basic header from
 * closure-captured database credentials, and reusing it would send them to third-party
 * services. This client sends no headers at all, asserted per method in its test.
 *
 * Prometheus bounds are SECOND epochs, Loki's are NANOSECOND epochs exceeding
 * Number.MAX_SAFE_INTEGER — hence `number` vs `string`, so swapping them is a typecheck
 * error rather than a silent wrong-window query.
 */

/** Default per-request timeout, matching KineticaSession's 30s. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Endpoints for one cluster's observability stack. Any may be absent. */
export interface ObservabilityEndpoints {
  /** Prometheus base URL, e.g. `http://statshost:9090`. */
  readonly promUrl?: string;
  /** Loki base URL, e.g. `http://statshost:9080` (`gaia.event_server_port`). */
  readonly lokiUrl?: string;
}

/** Optional client tuning. */
export interface ObservabilityClientOptions {
  /** Per-request timeout in milliseconds. Defaults to 30s. */
  readonly timeoutMs?: number;
}

/** Read-only HTTP client over a cluster's observability stack. */
export interface ObservabilityClient {
  /** Normalized Prometheus base URL, or undefined when not configured. */
  readonly promUrl?: string;
  /** Normalized Loki base URL, or undefined when not configured. */
  readonly lokiUrl?: string;
  /** Instant PromQL query at the current time. */
  readonly promInstant: (query: string) => Promise<Response>;
  /** Range PromQL query. `start`/`end` are SECOND epochs; `step` is seconds. */
  readonly promRange: (
    query: string,
    start: number,
    end: number,
    step: number,
  ) => Promise<Response>;
  /** Configured alerting rules, including each site's own thresholds. */
  readonly promRules: () => Promise<Response>;
  /** Currently firing/pending alerts. */
  readonly promAlerts: () => Promise<Response>;
  /**
   * Prometheus' own runtime config. Its `scrape_configs` name every rank as
   * `ki_db_ring_<ring>_cluster_<cluster>_rank_<N>` with the target host:port, so this
   * is a cluster topology read that works while the database is down.
   */
  readonly promConfig: () => Promise<Response>;
  /** LogQL range query. `startNs`/`endNs` are NANOSECOND epochs, as strings. */
  readonly lokiRange: (
    selector: string,
    startNs: string,
    endNs: string,
    limit: number,
  ) => Promise<Response>;
  /** Label names present in Loki — the cheapest test of whether it holds anything. */
  readonly lokiLabels: () => Promise<Response>;
}

/**
 * Normalize a user-supplied endpoint into a scheme-qualified base URL with no trailing
 * slash. Defaults to `http` — a database on `https` says nothing about the stats stack,
 * which kagent deploys on plain HTTP. Returns undefined for absent or unparseable input.
 */
function normalizeUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const parsed = new URL(withScheme);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${path}`;
  } catch {
    return undefined;
  }
}

/** Narrow an optional endpoint to a definite one, naming the service in the error. */
function requireEndpoint(url: string | undefined, service: string): string {
  if (!url) {
    throw new Error(
      `${service} endpoint is not configured for this session — no URL was discovered or supplied.`,
    );
  }
  return url;
}

/**
 * Create a read-only observability client.
 *
 * @param endpoints - base URLs; each is normalized and any may be omitted
 * @param options   - optional timeout override
 */
export function createObservabilityClient(
  endpoints: ObservabilityEndpoints,
  options?: ObservabilityClientOptions,
): ObservabilityClient {
  const promUrl = normalizeUrl(endpoints.promUrl);
  const lokiUrl = normalizeUrl(endpoints.lokiUrl);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // No headers object is passed at all — the absence of `Authorization` is structural,
  // not a value someone could later append to.
  const doGet = async (base: string, path: string, params?: URLSearchParams): Promise<Response> => {
    const qs = params?.toString() ?? "";
    const fullUrl = qs ? `${base}${path}?${qs}` : `${base}${path}`;
    if (process.env.DEBUG) {
      console.error(`[DEBUG] GET ${fullUrl}`);
    }
    return fetch(fullUrl, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
  };

  // `async` is load-bearing: requireEndpoint throws, and an async wrapper turns that
  // into a rejected promise rather than a synchronous throw at the call site. Tool
  // handlers await these inside try/catch, so a sync throw would escape uncaught.
  const prom = async (path: string, params?: URLSearchParams): Promise<Response> =>
    doGet(requireEndpoint(promUrl, "Prometheus"), path, params);

  const loki = async (path: string, params?: URLSearchParams): Promise<Response> =>
    doGet(requireEndpoint(lokiUrl, "Loki"), path, params);

  return {
    promUrl,
    lokiUrl,

    promInstant: (query) => prom("/api/v1/query", new URLSearchParams({ query })),

    promRange: (query, start, end, step) =>
      prom(
        "/api/v1/query_range",
        new URLSearchParams({
          query,
          start: String(start),
          end: String(end),
          step: String(step),
        }),
      ),

    promRules: () => prom("/api/v1/rules"),

    promAlerts: () => prom("/api/v1/alerts"),

    promConfig: () => prom("/api/v1/status/config"),

    lokiRange: (selector, startNs, endNs, limit) =>
      loki(
        "/loki/api/v1/query_range",
        // startNs/endNs stay strings end-to-end: a nanosecond epoch is larger than
        // Number.MAX_SAFE_INTEGER, so any numeric round-trip silently shifts the window.
        new URLSearchParams({
          query: selector,
          start: startNs,
          end: endNs,
          limit: String(limit),
        }),
      ),

    lokiLabels: () => loki("/loki/api/v1/labels"),
  };
}
