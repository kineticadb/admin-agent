/**
 * alterConfiguration — replaces the gpudb.conf on the host manager.
 *
 * Endpoint: POST /admin/alter/configuration on host manager port (default 9300)
 * Three-phase lifecycle:
 *   1. Capture before-state by reading /admin/show/configuration.
 *      On failure, before_summary is empty — mutation still proceeds.
 *   2. Apply changes via /admin/alter/configuration with full config_string.
 *   3. Re-read /admin/show/configuration to verify changes took effect.
 *      Sets verification to "confirmed" | "failed" | "unavailable".
 *
 * Never throws — all error paths return ToolResult with ok:false.
 * Never mutates session or response objects.
 */
import { z } from "zod";
import type { KineticaSession, ToolResult } from "../../types/index.js";
import { parseDataStr } from "../rest/parse-data-str.js";
import { discoverHmPort } from "../rest/discover-hm-port.js";
import { showConfiguration } from "../rest/show-configuration.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const AlterConfigurationSchema = z.object({
  /**
   * The full replacement content for the gpudb.conf configuration file.
   * Must be non-empty.
   */
  config_string: z.string().min(1, { message: "config_string must not be empty" }),
});

export type AlterConfigurationInput = z.infer<typeof AlterConfigurationSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConfigSummary = {
  readonly line_count: number;
  readonly preview: string;
};

type AlterConfigurationData = {
  readonly before_summary: ConfigSummary;
  readonly after_summary: ConfigSummary;
  readonly verification: "confirmed" | "failed" | "unavailable";
  readonly info: Record<string, string>;
};

/** Shape of the inner data_str payload from /admin/alter/configuration. */
type AlterConfigurationInner = {
  config_string?: string;
  info?: Record<string, string>;
};

/** Outer Kinetica REST response wrapper. */
type KineticaRestResponse = {
  data_str?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PREVIEW_LINES = 20;

const EMPTY_SUMMARY: ConfigSummary = { line_count: 0, preview: "" };

/**
 * Summarize a config string into a compact representation.
 * Returns line count and the first PREVIEW_LINES lines.
 */
function summarizeConfig(configString: string): ConfigSummary {
  const lines = configString.split("\n");
  const preview = lines.slice(0, PREVIEW_LINES).join("\n");
  return { line_count: lines.length, preview };
}

/**
 * Read the current configuration via showConfiguration.
 * Returns the config_string on success, or undefined on any failure.
 * Never throws.
 */
async function readCurrentConfig(session: KineticaSession): Promise<string | undefined> {
  try {
    const result = await showConfiguration(session, {});
    return result.ok ? result.data.config_string : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Replaces the full gpudb.conf configuration on the Kinetica host manager.
 *
 * Captures before-state, applies the new config, and verifies after-state.
 * Before-state read failure does NOT block the mutation.
 *
 * @param session - Pre-authenticated Kinetica session
 * @param input   - The full replacement config_string (non-empty)
 * @returns ToolResult with before_summary, after_summary, and verification status
 */
export async function alterConfiguration(
  session: KineticaSession,
  input: AlterConfigurationInput,
): Promise<ToolResult<AlterConfigurationData>> {
  if (!session.makeRequestToPort) {
    return {
      ok: false,
      status: 0,
      error: "makeRequestToPort not available on this session",
      raw: "",
    };
  }

  // Phase 1: Before-state capture (non-blocking on failure)
  const beforeConfig = await readCurrentConfig(session);
  const beforeSummary = beforeConfig !== undefined ? summarizeConfig(beforeConfig) : EMPTY_SUMMARY;

  // Phase 2: Apply mutation
  const hmPort = await discoverHmPort(session);

  let mutationResponse: Response;
  let rawText: string;
  try {
    mutationResponse = await session.makeRequestToPort(hmPort, "/admin/alter/configuration", {
      config_string: input.config_string,
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

  const innerMutation = parseDataStr<AlterConfigurationInner>(parsedMutation.data_str, rawText);
  if (!innerMutation.ok) return innerMutation;

  const responseInfo: Record<string, string> = innerMutation.data?.info ?? {};

  // Phase 3: Post-mutation verification (non-blocking on failure)
  const afterConfig = await readCurrentConfig(session);

  let afterSummary: ConfigSummary;
  let verification: "confirmed" | "failed" | "unavailable";

  if (afterConfig === undefined) {
    afterSummary = EMPTY_SUMMARY;
    verification = "unavailable";
  } else {
    afterSummary = summarizeConfig(afterConfig);
    // If before-state was also unavailable, we can't compare — mark unavailable
    if (beforeConfig === undefined) {
      verification = "unavailable";
    } else {
      verification = afterConfig !== beforeConfig ? "confirmed" : "failed";
    }
  }

  const data: AlterConfigurationData = {
    before_summary: beforeSummary,
    after_summary: afterSummary,
    verification,
    info: responseInfo,
  };

  return { ok: true, data };
}
