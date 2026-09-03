/**
 * response-body — decode a Prometheus or Loki HTTP response into a body or a ToolFailure.
 *
 * Every stats-stack tool needs the same refusals before it can look at data: a non-JSON
 * body, and an HTTP error. Prometheus adds a third that is easy to miss — a `200`
 * carrying `{"status":"error","error":"…"}`, which is how it answers a malformed query.
 * A tool checking only `response.ok` reports a rejected query as a successful EMPTY
 * result, which reads as "the metric has no data" and is the worst available inference.
 *
 * This is the stats-stack analogue of `tools/rest/parse-data-str.ts`: a shared decoder
 * returning a discriminated union, never throwing, kept OUT of the client so
 * `ObservabilityClient` stays transport-only.
 *
 * Loki differs in two ways, declared once in LOKI below: a LogQL hint on HTTP failure,
 * and no body-level error check — a deliberate absence, since no 200-level JSON error
 * envelope is known for it here.
 */

import type { ToolFailure } from "../../types/index.js";

/**
 * A decoded body, or the failure explaining why there isn't one.
 *
 * `raw` and `status` ride along on success because a body can be valid JSON and still
 * be the wrong SHAPE — a caller rejecting it needs the same evidence the failures carry.
 */
export type DecodedBody =
  | { readonly ok: true; readonly body: unknown; readonly raw: string; readonly status: number }
  | ToolFailure;

/**
 * Extract Prometheus' `error` field from a response body, if present.
 *
 * `errorType` is prefixed when present because it names the class of failure
 * (`bad_data`, `timeout`), which is what tells the agent whether to fix the query
 * or narrow the window.
 */
export function promError(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const { error, errorType } = body as { error?: unknown; errorType?: unknown };
  if (typeof error !== "string") return undefined;
  return typeof errorType === "string" ? `${errorType}: ${error}` : error;
}

/** How one service reports failure. */
type ServiceDecoder = {
  readonly service: string;
  /** Appended to the HTTP-failure message; must lead with a space. */
  readonly httpHint?: string;
  /** Check for an error reported inside a 200-level body. Prometheus only. */
  readonly bodyError?: (body: unknown) => string | undefined;
};

const PROMETHEUS: ServiceDecoder = { service: "Prometheus", bodyError: promError };

const LOKI: ServiceDecoder = {
  service: "Loki",
  httpHint: " Check the LogQL selector syntax.",
};

/**
 * Read and decode a response.
 *
 * The raw text is always carried into the failure so the agent can see what actually
 * came back — an HTML error page from a reverse proxy is a different problem from a
 * service-level rejection, and only the body distinguishes them.
 */
async function readBody(response: Response, decoder: ServiceDecoder): Promise<DecodedBody> {
  const { service, httpHint = "", bodyError } = decoder;
  const raw = await response.text();

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      status: response.status,
      error: `${service} returned a non-JSON body (HTTP ${response.status}).`,
      raw,
    };
  }

  const detail = bodyError?.(body);
  if (!response.ok || detail !== undefined) {
    return {
      ok: false,
      status: response.status,
      error: detail ?? `${service} request failed with HTTP ${response.status}.${httpHint}`,
      raw,
    };
  }

  return { ok: true, body, raw, status: response.status };
}

/** Decode a Prometheus response, including its 200-level error envelope. */
export function readPromBody(response: Response): Promise<DecodedBody> {
  return readBody(response, PROMETHEUS);
}

/** Decode a Loki response. */
export function readLokiBody(response: Response): Promise<DecodedBody> {
  return readBody(response, LOKI);
}
