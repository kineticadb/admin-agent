/**
 * alterSystemProperties -- runtime config mutation with before/after verification.
 *
 * Endpoint: POST /alter/system/properties
 * Three-phase lifecycle:
 *   1. Capture before-state by reading /show/system/properties for requested keys.
 *      On failure, before_state is empty -- mutation still proceeds.
 *   2. Apply changes via /alter/system/properties.
 *   3. Re-read /show/system/properties to verify changes took effect.
 *      Sets verification to "confirmed" | "failed" | "unavailable".
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
// ---------------------------------------------------------------------------

/**
 * The 43 properties documented as supported by /alter/system/properties.
 * Any property not in this set will be rejected before making a network call.
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
  readonly verification: "confirmed" | "failed" | "unavailable";
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

    // Extract only the keys the caller wants to change
    return Object.fromEntries(
      requestedKeys
        .filter((key) => Object.prototype.hasOwnProperty.call(propertyMap, key))
        .map((key) => [key, propertyMap[key]]),
    );
  } catch {
    return {};
  }
}

/**
 * Compares after-state values against the requested update map.
 * Returns "confirmed" if all values match, "failed" if any differ.
 */
function computeVerification(
  requestedMap: Record<string, string>,
  afterState: Record<string, string>,
): "confirmed" | "failed" {
  for (const [key, expectedValue] of Object.entries(requestedMap)) {
    if (afterState[key] !== expectedValue) {
      return "failed";
    }
  }
  return "confirmed";
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

  // Pre-flight: reject properties not in the allow-list or in the block-list
  const disallowed = findDisallowedProperties(requestedKeys);
  if (disallowed.length > 0) {
    return {
      ok: false,
      status: 400,
      error: `Property rejected: ${disallowed.map((k) => `'${k}'`).join(", ")} not supported by /alter/system/properties`,
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
  let verification: "confirmed" | "failed" | "unavailable";

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
        };
        return { ok: true, data };
      }

      const innerVerify = parseDataStr<ShowSystemPropertiesInner>(parsedVerify.data_str, verifyRaw);
      if (!innerVerify.ok) {
        afterState = {};
        verification = "unavailable";
      } else {
        const verifyPropertyMap: Record<string, string> = innerVerify.data?.property_map ?? {};

        afterState = Object.fromEntries(
          requestedKeys
            .filter((key) => Object.prototype.hasOwnProperty.call(verifyPropertyMap, key))
            .map((key) => [key, verifyPropertyMap[key]]),
        );

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
  };

  return { ok: true, data };
}
