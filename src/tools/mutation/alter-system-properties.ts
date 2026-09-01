/**
 * alterSystemProperties -- runtime config mutation with before/after verification.
 *
 * Endpoint: POST /alter/system/properties
 * Three-phase lifecycle:
 *   1. Capture before-state by reading /show/system/properties for requested keys.
 *      On failure, before_state is empty -- mutation still proceeds.
 *   2. Apply changes via /alter/system/properties.
 *   3. Re-read /show/system/properties to verify. Sets verification to
 *      "confirmed" | "failed" | "not_reported" | "unavailable".
 *
 * The endpoint is NOT an in-memory change -- it edits
 * /opt/gpudb/core/etc/gpudb.conf in place, so "confirmed" means PERSISTED, not
 * applied. See knowledge/references/gpudb-conf.md for the measurement.
 *
 * Never throws -- all error paths return ToolResult with ok:false.
 * Never mutates session or response objects.
 */
import { z } from "zod";
import type { KineticaSession, ToolResult } from "../../types/index.js";
import { parseDataStr } from "../rest/parse-data-str.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const AlterSystemPropertiesSchema = z.object({
  /**
   * Map of property key -> new value to apply at runtime.
   * At least one entry is required.
   */
  property_updates_map: z
    .record(z.string(), z.string())
    .refine((map) => Object.keys(map).length >= 1, {
      message: "property_updates_map must have at least one entry",
    }),
});

export type AlterSystemPropertiesInput = z.infer<typeof AlterSystemPropertiesSchema>;

// ---------------------------------------------------------------------------
// Allow-list: properties supported by /alter/system/properties (7.2.x)
// Source: https://docs.kinetica.com/7.2/api/rest/alter_system_properties_rest
//
// The endpoint rejects enable_procs and worker_endpoint_threads ("is not a valid
// parameter"), so their absence here is correct; every other testable name was
// accepted.
// ---------------------------------------------------------------------------

/**
 * The 43 property names the 7.2 REST docs list; anything else is rejected before
 * a network call. Membership means the endpoint STORES the value, not that the
 * running system acts on it -- see verification and restart_note for that.
 */
const ALTERABLE_PROPERTIES: ReadonlySet<string> = new Set([
  "concurrent_kernel_execution",
  "subtask_concurrency_limit",
  "chunk_size",
  "chunk_column_max_memory",
  "chunk_max_memory",
  "execution_mode",
  "external_files_directory",
  "request_timeout",
  "max_get_records_size",
  "enable_audit",
  "audit_headers",
  "audit_body",
  "audit_data",
  "audit_response",
  "shadow_agg_size",
  "shadow_filter_size",
  "enable_overlapped_equi_join",
  "enable_one_step_compound_equi_join",
  "kafka_batch_size",
  "kafka_poll_timeout",
  "kafka_wait_time",
  "egress_parquet_compression",
  "egress_single_file_max_size",
  "max_concurrent_kernels",
  "system_metadata_retention_period",
  "tcs_per_tom",
  "tps_per_tom",
  "background_worker_threads",
  "log_debug_job_info",
  "enable_thread_hang_logging",
  "ai_enable_rag",
  "ai_api_provider",
  "ai_api_url",
  "ai_api_key",
  "ai_api_connection_timeout",
  "ai_api_embeddings_model",
  "telm_persist_query_metrics",
  "postgres_proxy_idle_connection_timeout",
  "postgres_proxy_keep_alive",
  "kifs_directory_data_limit",
  "compression_codec",
  "disk_auto_optimize_timeout",
  "ha_consumer_replay_offset",
]);

/**
 * Properties the endpoint stores but the running process ignores until restart.
 *
 * Measured: tps_per_tom 4->8 changed zero threads on either rank, and
 * enable_audit=TRUE (content flags on) produced no audit output -- yet both read
 * back changed. So report the value as stored, never as in effect.
 *
 * See knowledge/references/gpudb-conf.md for provenance and its limits.
 */
const RESTART_SUSPECT_PROPERTIES: ReadonlySet<string> = new Set([
  "tps_per_tom",
  "tcs_per_tom",
  "subtask_concurrency_limit",
  "enable_audit",
]);

/** Requested keys whose runtime effect is unverified, in request order. */
export function findRestartSuspectProperties(requestedKeys: readonly string[]): readonly string[] {
  return requestedKeys.filter((key) => RESTART_SUSPECT_PROPERTIES.has(key));
}

/** Prefix /show/system/properties uses that /alter/system/properties does not. */
const SHOW_PROPERTIES_PREFIX = "conf.";

/** conf.ai.api.url -> ai_api_url, the spelling /alter uses. */
function normalizeShowKey(showKey: string): string {
  const bare = showKey.startsWith(SHOW_PROPERTIES_PREFIX)
    ? showKey.slice(SHOW_PROPERTIES_PREFIX.length)
    : showKey;
  return bare.replaceAll(".", "_");
}

/**
 * Reads one property from a /show/system/properties property_map.
 *
 * The endpoints disagree on spelling two ways: /show prefixes with "conf.", and
 * dot-sections what /alter flattens with underscores
 * (conf.ai.api.url vs ai_api_url). The section boundary is not derivable from
 * the flat name -- postgres_proxy.keep_alive keeps an underscore inside the
 * section -- so this normalises RESPONSE keys down rather than guessing dots.
 *
 * Order: exact, conf.<exact>, then normalised scan. Ambiguous normalisation
 * yields undefined. Never a substring match: conf.request_timeout_ms must not
 * answer request_timeout.
 */
export function lookupProperty(
  propertyMap: Record<string, string>,
  key: string,
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(propertyMap, key)) return propertyMap[key];
  const prefixed = `${SHOW_PROPERTIES_PREFIX}${key}`;
  if (Object.prototype.hasOwnProperty.call(propertyMap, prefixed)) return propertyMap[prefixed];

  const matches = Object.keys(propertyMap).filter((k) => normalizeShowKey(k) === key);
  return matches.length === 1 ? propertyMap[matches[0]] : undefined;
}

/**
 * Extracts requested keys, always keyed by the BARE name the caller asked for
 * regardless of wire spelling, so before_state, after_state and the requested
 * map stay comparable. Unmatched keys are omitted.
 */
function extractProperties(
  propertyMap: Record<string, string>,
  requestedKeys: readonly string[],
): Record<string, string> {
  return requestedKeys.reduce<Record<string, string>>((acc, key) => {
    const value = lookupProperty(propertyMap, key);
    return value === undefined ? acc : { ...acc, [key]: value };
  }, {});
}

/**
 * Properties that the API supports but the agent must never set.
 * Defense-in-depth: the system prompt also warns against these.
 */
const BLOCKED_PROPERTIES: ReadonlySet<string> = new Set([
  "ai_api_key", // credential — would appear in audit logs
  "external_files_directory", // filesystem path — potential path traversal
]);

/**
 * Returns the list of property names that are not allowed.
 * Checks both the allow-list (must be in ALTERABLE_PROPERTIES) and
 * the block-list (must not be in BLOCKED_PROPERTIES).
 *
 * Returns an empty array when all properties are valid.
 * Never throws.
 */
export function findDisallowedProperties(requestedKeys: readonly string[]): readonly string[] {
  return requestedKeys.filter(
    (key) => !ALTERABLE_PROPERTIES.has(key) || BLOCKED_PROPERTIES.has(key),
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AlterSystemPropertiesData = {
  readonly updated_properties_map: Record<string, string>;
  readonly before_state: Record<string, string>;
  readonly after_state: Record<string, string>;
  readonly verification: "confirmed" | "failed" | "not_reported" | "unavailable";
  /** Present only when a requested key has an unverified runtime effect. */
  readonly restart_note?: string;
};

/** Shape of /alter/system/properties inner data_str payload. */
type AlterSystemPropertiesInner = {
  updated_properties_map?: Record<string, string>;
};

/** Shape of /show/system/properties inner data_str payload. */
type ShowSystemPropertiesInner = {
  property_map?: Record<string, string>;
};

/** Outer Kinetica REST response wrapper. */
type KineticaRestResponse = {
  data_str?: string;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Reads /show/system/properties and extracts only the requested keys.
 * Returns empty object on any failure -- never throws.
 */
async function readRequestedProperties(
  session: KineticaSession,
  requestedKeys: readonly string[],
): Promise<Record<string, string>> {
  try {
    const response = await session.makeRequest("/show/system/properties", {
      options: {},
    });
    if (!response.ok) return {};

    const raw = await response.text();
    let parsed: KineticaRestResponse;
    try {
      parsed = JSON.parse(raw) as KineticaRestResponse;
    } catch {
      return {};
    }

    const inner = parseDataStr<ShowSystemPropertiesInner>(parsed.data_str, raw);
    if (!inner.ok) return {};

    const propertyMap: Record<string, string> = inner.data?.property_map ?? {};

    return extractProperties(propertyMap, requestedKeys);
  } catch {
    return {};
  }
}

/**
 * Compares after-state against the requested map.
 *
 * "not_reported" exists because 7 of the 43 properties are absent from
 * /show/system/properties (e.g. execution_mode, which /alter accepts and
 * echoes): an unreadable property is not a failed mutation. A genuine mismatch
 * outranks an unreadable one.
 */
function computeVerification(
  requestedMap: Record<string, string>,
  afterState: Record<string, string>,
): "confirmed" | "failed" | "not_reported" {
  const entries = Object.entries(requestedMap);
  const mismatched = entries.some(
    ([key, expected]) =>
      Object.prototype.hasOwnProperty.call(afterState, key) && afterState[key] !== expected,
  );
  if (mismatched) return "failed";

  const unreadable = entries.some(
    ([key]) => !Object.prototype.hasOwnProperty.call(afterState, key),
  );
  return unreadable ? "not_reported" : "confirmed";
}

/**
 * restart_note for a RESTART_SUSPECT_PROPERTIES write. Warns about EFFECT, never
 * acceptance -- acceptance is measured, effect is not. undefined when none hit.
 */
function buildRestartNote(
  requestedKeys: readonly string[],
  verification: "confirmed" | "failed" | "not_reported" | "unavailable",
): string | undefined {
  const suspects = findRestartSuspectProperties(requestedKeys);
  if (suspects.length === 0) return undefined;

  const names = suspects.map((k) => `'${k}'`).join(", ");

  if (verification === "confirmed") {
    return (
      `${names} stored successfully — /show/system/properties reports the new value. ` +
      `That confirms the property store accepted it; it does NOT confirm the running ` +
      `system picked it up. No endpoint exposes a live thread-pool size, and there is a ` +
      `field report of 'enable_audit' needing a full 'stop all' + 'start' because a plain ` +
      `restart kept the cached config. Report the value as stored, not as in effect, and ` +
      `say a restart may be required to realise it.`
    );
  }

  if (verification === "failed") {
    return (
      `${names} did not store — the value read back unchanged. On this cluster the ` +
      `runtime route is closed for it: use kinetica_alter_configuration to edit ` +
      `gpudb.conf, then tell the operator the database must be restarted. This agent ` +
      `cannot restart services. (These normally DO store via the runtime route, so ` +
      `this cluster differs — worth recording with its version.)`
    );
  }

  if (verification === "not_reported") {
    return (
      `${names} was accepted by the endpoint but is not exposed by ` +
      `/show/system/properties, so neither the store nor the effect could be re-read. ` +
      `Report it as attempted, not applied.`
    );
  }

  return (
    `${names} — verification was unavailable, so it is unknown whether the value was ` +
    `even stored, let alone taken into effect. Re-read /show/system/properties before ` +
    `reporting any outcome.`
  );
}

/** Spreads restart_note into the result only when there is one to add. */
function maybeNote(
  requestedKeys: readonly string[],
  verification: "confirmed" | "failed" | "not_reported" | "unavailable",
): { restart_note?: string } {
  const note = buildRestartNote(requestedKeys, verification);
  return note === undefined ? {} : { restart_note: note };
}

/**
 * Mutates Kinetica runtime configuration properties.
 *
 * Captures before-state, applies changes, and verifies after-state.
 * Before-state read failure does NOT block the mutation.
 *
 * @param session - Pre-authenticated Kinetica session
 * @param input   - Map of property key -> new value (at least 1 entry required)
 * @returns ToolResult with before_state, after_state, updated_properties_map,
 *          and verification status
 */
export async function alterSystemProperties(
  session: KineticaSession,
  input: AlterSystemPropertiesInput,
): Promise<ToolResult<unknown>> {
  const requestedKeys = Object.keys(input.property_updates_map);

  // Pre-flight: reject properties not in the allow-list or in the block-list.
  // Restart-suspect keys are NOT rejected here -- they are attempted and the
  // result annotated (restart_note), since the endpoint does store them.
  // (enable_procs still falls out below: the docs never listed it as alterable.)
  const disallowed = findDisallowedProperties(requestedKeys);
  if (disallowed.length > 0) {
    return {
      ok: false,
      status: 400,
      error:
        `Property rejected: ${disallowed.map((k) => `'${k}'`).join(", ")} not supported by ` +
        `/alter/system/properties. If it is a gpudb.conf parameter it must be changed in the ` +
        `file and the database restarted.`,
      raw: "",
    };
  }

  // Phase 1: Before-state capture (non-blocking on failure)
  const beforeState = await readRequestedProperties(session, requestedKeys);

  // Phase 2: Apply mutation
  let mutationResponse: Response;
  let rawText: string;
  try {
    mutationResponse = await session.makeRequest("/alter/system/properties", {
      property_updates_map: input.property_updates_map,
    });
    rawText = await mutationResponse.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, error: message, raw: "" };
  }

  if (!mutationResponse.ok) {
    return {
      ok: false,
      status: mutationResponse.status,
      error: `HTTP ${mutationResponse.status}`,
      raw: rawText,
    };
  }

  // Parse mutation response
  let parsedMutation: KineticaRestResponse;
  try {
    parsedMutation = JSON.parse(rawText) as KineticaRestResponse;
  } catch (parseError) {
    const message = parseError instanceof Error ? parseError.message : String(parseError);
    return {
      ok: false,
      status: 200,
      error: `JSON parse error: ${message}`,
      raw: rawText,
    };
  }

  const innerMutation = parseDataStr<AlterSystemPropertiesInner>(parsedMutation.data_str, rawText);
  if (!innerMutation.ok) return innerMutation;

  const updatedPropertiesMap: Record<string, string> =
    innerMutation.data?.updated_properties_map ?? {};

  // Phase 3: Post-mutation verification (non-blocking on failure)
  let afterState: Record<string, string>;
  let verification: "confirmed" | "failed" | "not_reported" | "unavailable";

  try {
    const verifyResponse = await session.makeRequest("/show/system/properties", { options: {} });

    if (!verifyResponse.ok) {
      afterState = {};
      verification = "unavailable";
    } else {
      const verifyRaw = await verifyResponse.text();
      let parsedVerify: KineticaRestResponse;
      try {
        parsedVerify = JSON.parse(verifyRaw) as KineticaRestResponse;
      } catch {
        afterState = {};
        verification = "unavailable";
        const data: AlterSystemPropertiesData = {
          updated_properties_map: updatedPropertiesMap,
          before_state: beforeState,
          after_state: afterState,
          verification,
          ...maybeNote(requestedKeys, verification),
        };
        return { ok: true, data };
      }

      const innerVerify = parseDataStr<ShowSystemPropertiesInner>(parsedVerify.data_str, verifyRaw);
      if (!innerVerify.ok) {
        afterState = {};
        verification = "unavailable";
      } else {
        const verifyPropertyMap: Record<string, string> = innerVerify.data?.property_map ?? {};

        afterState = extractProperties(verifyPropertyMap, requestedKeys);

        verification = computeVerification(input.property_updates_map, afterState);
      }
    }
  } catch {
    afterState = {};
    verification = "unavailable";
  }

  const data: AlterSystemPropertiesData = {
    updated_properties_map: updatedPropertiesMap,
    before_state: beforeState,
    after_state: afterState,
    verification,
    ...maybeNote(requestedKeys, verification),
  };

  return { ok: true, data };
}
