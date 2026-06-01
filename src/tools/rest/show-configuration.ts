/**
 * showConfiguration — retrieves the full gpudb.conf from the host manager.
 *
 * Endpoint: POST /admin/show/configuration on host manager port (default 9300)
 * Returns: data_str double-encoded response with config_string (INI-format gpudb.conf)
 *
 * Security: gpudb.conf carries high-value secrets (license_key, LDAP bind
 * passwords, TLS keystore/truststore passwords). Secret values are masked at the
 * source via redactConfigSecrets() before config_string is returned, so they
 * never enter the agent context, a saved report, or the streamed output. Keys
 * and non-secret values are preserved for drift detection.
 *
 * Never throws — all error paths return ToolResult with ok:false.
 * Never mutates session or response objects.
 */
import { z } from "zod";
import type { KineticaSession, ToolResult } from "../../types/index.js";
import { redactConfigSecrets } from "../../report/scrub.js";
import { parseDataStr } from "./parse-data-str.js";
import { discoverHmPort } from "./discover-hm-port.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for showConfiguration input parameters.
 * Currently empty — no parameters required.
 * Exported for MCP tool registration.
 */
export const ShowConfigurationSchema = z.object({});

/** Input type inferred from ShowConfigurationSchema. */
export type ShowConfigurationInput = z.infer<typeof ShowConfigurationSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed response data from /admin/show/configuration. */
export type ShowConfigurationData = {
  readonly config_string: string;
  readonly info: Record<string, string>;
};

/** Shape of the inner data_str payload. */
type ShowConfigurationInner = {
  config_string?: string;
  info?: Record<string, string>;
};

/** Outer Kinetica REST response wrapper. */
type KineticaRestResponse = {
  data_str?: string;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Retrieves the full gpudb.conf configuration from the Kinetica host manager.
 *
 * @param session - Pre-authenticated Kinetica session
 * @param _input  - Currently unused (no parameters); reserved for future filters
 * @returns ToolResult with config_string and info on success, or error details on failure
 */
export async function showConfiguration(
  session: KineticaSession,
  _input: ShowConfigurationInput,
): Promise<ToolResult<ShowConfigurationData>> {
  if (!session.makeRequestToPort) {
    return {
      ok: false,
      status: 0,
      error: "makeRequestToPort not available on this session",
      raw: "",
    };
  }

  const hmPort = await discoverHmPort(session);

  let response: Response;
  let rawText: string;

  try {
    response = await session.makeRequestToPort(hmPort, "/admin/show/configuration", {});
    rawText = await response.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, error: message, raw: "" };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: `HTTP ${response.status}`,
      raw: rawText,
    };
  }

  let outer: KineticaRestResponse;
  try {
    outer = JSON.parse(rawText) as KineticaRestResponse;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 200,
      error: `JSON parse error: ${message}`,
      raw: rawText,
    };
  }

  const inner = parseDataStr<ShowConfigurationInner>(outer.data_str, rawText);
  if (!inner.ok) return inner;

  // Mask secret values (license keys, LDAP/TLS passwords) before the config
  // enters the agent context — defense at the source, ahead of report scrubbing.
  return {
    ok: true,
    data: {
      config_string: redactConfigSecrets(inner.data?.config_string ?? ""),
      info: inner.data?.info ?? {},
    },
  };
}
