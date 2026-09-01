/**
 * kinetica_bundle_read_config — read gpudb.conf from the bundle.
 *
 * Returns INI entries, optionally filtered by section and/or key substring.
 * The bundle's gpudb.conf is the real on-disk config (better than the live
 * host-manager endpoint), so this feeds config-drift and misconfiguration
 * analysis directly.
 *
 * Because it IS the real file, it carries live secrets -- license_key, LDAP bind
 * passwords, TLS material, cloud-tier storage credentials. Values of
 * credential-bearing keys are masked here, matching what
 * kinetica_show_configuration does for the live endpoint. Key names are always
 * preserved so drift detection still works.
 */

import { z } from "zod";
import type { BundleSource } from "../../bundle/BundleSource.js";
import { isSecretConfigKey } from "../../report/scrub.js";
import type { ToolResult } from "../../types/index.js";

export const BundleReadConfigSchema = z.object({
  section: z.string().optional(),
  key: z.string().optional(),
});

export type BundleReadConfigInput = z.infer<typeof BundleReadConfigSchema>;

export async function bundleReadConfig(
  source: BundleSource,
  args: BundleReadConfigInput = {},
): Promise<ToolResult<unknown>> {
  const result = await source.readConfig({
    ...(args.section !== undefined ? { section: args.section } : {}),
    ...(args.key !== undefined ? { key: args.key } : {}),
  });

  if ("error" in result) {
    return { ok: false, status: 0, error: result.error, raw: "" };
  }

  // A section filter that matches nothing is a common footgun: gpudb.conf is
  // largely flat (top-level keys carry an empty section), so guessing a section
  // name silently returns no entries — reading as "parameter absent" when it is
  // actually defined as a flat key. Surface the sections that DO exist and steer
  // the agent toward key-substring filtering instead of concluding config drift.
  if (result.entries.length === 0 && args.section !== undefined) {
    const all = await source.readConfig(args.key !== undefined ? { key: args.key } : {});
    const sections = "error" in all ? [] : [...new Set(all.entries.map((e) => e.section))].sort();
    const sectionList = sections.map((s) => (s === "" ? "(flat/top-level)" : s)).join(", ");
    return {
      ok: true,
      note:
        `No entries in section "${args.section}" of ${result.file}. ` +
        `gpudb.conf is largely flat — retry filtering by key only. ` +
        `Sections present: ${sectionList || "(none)"}.`,
      data: { section_not_found: args.section, available_sections: sections },
    };
  }

  // Mask credential values. An empty value stays empty: "[REDACTED]" on an unset
  // key would tell the agent a credential is configured when none is.
  const redactedKeys: string[] = [];
  const entries = result.entries.map((e) => {
    const qualified = e.section === "" ? e.key : `${e.section}.${e.key}`;
    if (e.value !== "" && isSecretConfigKey(qualified)) {
      redactedKeys.push(e.key);
      return { section: e.section, key: e.key, value: "[REDACTED]" };
    }
    return { section: e.section, key: e.key, value: e.value };
  });

  const redactionNote =
    redactedKeys.length > 0
      ? ` ${redactedKeys.length} credential value(s) redacted (key names kept): ${redactedKeys.join(", ")}.`
      : "";

  return {
    ok: true,
    note: `${result.entries.length} entr(y/ies) from ${result.file}.${redactionNote}`,
    data: entries,
  };
}
