/**
 * kinetica_load_bundle — attach (or replace) the support bundle mid-session.
 *
 * Lets a live investigation pull in an offline bundle on demand: the operator
 * says "I want to analyze a support bundle", the agent asks for the extracted
 * directory path and calls this tool. On success the BundleHolder is populated
 * and the kinetica_bundle_* tools start working against it.
 *
 * Read-only: it validates and indexes files; it never writes. Returns the same
 * inventory shape as list_files so the agent can orient immediately.
 */

import { z } from "zod";
import type { BundleHolder } from "../../bundle/bundle-holder.js";
import { verifyBundle } from "../../bundle/verify-bundle.js";
import type { ToolResult } from "../../types/index.js";

export const BundleLoadSchema = z.object({
  path: z.string().min(1).optional(),
});

export type BundleLoadInput = z.infer<typeof BundleLoadSchema>;

/** Resolves a bundle directory interactively when the agent supplies none. */
export type PromptForPath = () => Promise<string | undefined>;

/** Operator y/n confirmation for a model-supplied bundle path. Returns true to allow. */
export type ConfirmPath = (path: string) => Promise<boolean>;

export async function bundleLoad(
  holder: BundleHolder,
  args: BundleLoadInput,
  promptForPath?: PromptForPath,
  confirmPath?: ConfirmPath,
): Promise<ToolResult<unknown>> {
  // Resolve the bundle directory. Two consent models:
  // - args.path present → the MODEL chose the directory, which widens the agent's
  //   filesystem read surface to that tree, so the operator must confirm it (when a
  //   confirmer is wired). Declining aborts without loading.
  // - no args.path → fall back to the interactive picker; the operator picking IS the
  //   consent, so no second confirmation is needed.
  let path: string | undefined;
  if (args.path !== undefined) {
    if (confirmPath && !(await confirmPath(args.path))) {
      return {
        ok: false,
        status: 0,
        error: `Operator declined to load a bundle from "${args.path}".`,
        raw: args.path,
      };
    }
    path = args.path;
  } else {
    path = promptForPath ? await promptForPath() : undefined;
  }
  if (!path) {
    return {
      ok: false,
      status: 0,
      error:
        "No bundle path provided and no directory picker is available. Ask the operator for the extracted bundle directory path and pass it as `path`.",
      raw: "",
    };
  }

  const result = await verifyBundle(path);
  if (!result.ok) {
    return { ok: false, status: 0, error: result.error, raw: path };
  }

  holder.set(result.bundleSource);

  const missingNote =
    result.missingExpected.length > 0
      ? ` Missing expected artifact(s): ${result.missingExpected.join(", ")} (treat as Evidence Gaps).`
      : "";

  return {
    ok: true,
    // Loading a bundle is SETUP, not an investigation. Do not auto-proceed — the
    // operator hasn't said what they want yet. End the turn and ask.
    note: `Bundle attached. Do NOT start investigating yet — ask the operator what they want to investigate, then proceed.${missingNote}`,
    data: {
      loaded: true,
      path,
      detected_version: result.kineticaVersion ?? "unknown",
      total_files: result.inventory.totalFiles,
      ranks_present: result.inventory.ranks.join(", ") || "none",
      counts_by_kind: result.inventory.byKind,
      missing_expected: result.missingExpected.join(", ") || "none",
    },
  };
}
