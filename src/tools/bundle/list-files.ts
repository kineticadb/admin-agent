/**
 * kinetica_bundle_list_files — orientation tool for offline bundle mode.
 *
 * The agent's first call: inventories the extracted bundle so it knows what
 * evidence exists (which ranks, which logs, the detected version) and what is
 * missing (failed collections). Analogous to a Round-1 health sweep.
 *
 * It also reports HOW the bundle was understood: a `layout_match` verdict plus
 * per-file `confidence`/`reason`, so when a bundle doesn't match the canonical
 * gpudb_sysinfo shape the agent can see which classifications were inferred and
 * which files are still unknown — and read them directly rather than trusting a
 * silent best-guess.
 */

import { z } from "zod";
import { assessLayout, type BundleSource } from "../../bundle/BundleSource.js";
import { describeBundleFile } from "../../bundle/known-files.js";
import type { ToolResult } from "../../types/index.js";

export const BundleListFilesSchema = z.object({
  kind: z.string().optional(),
});

/** Cap on the unknown-file path list so an odd bundle can't flood the context. */
const MAX_UNKNOWN_LISTED = 40;

export async function bundleListFiles(
  source: BundleSource,
  args: { kind?: string } = {},
): Promise<ToolResult<unknown>> {
  const all = source.listFiles();
  const filtered = args.kind ? all.filter((e) => e.kind === args.kind) : all;

  const inventory = source.inventory();
  const {
    totalFiles,
    totalBytes,
    byKind,
    ranks,
    inferredRanks,
    services,
    inferredFiles,
    unknownFiles,
  } = inventory;
  const { layout, layoutWarning } = assessLayout(inventory);
  const version = await source.detectVersion();
  const errors = await source.collectionErrors();

  const files = filtered.map((e) => ({
    file: e.relPath,
    kind: e.kind,
    // How sure the classification is: exact (canonical name) | inferred (heuristic) | weak.
    confidence: e.confidence,
    ...(e.reason !== undefined ? { why: e.reason } : {}),
    rank: e.rank ?? "",
    size_kb: Math.round(e.sizeBytes / 1024),
    // What the file contains — so the agent can pick the right one without reading it.
    description: describeBundleFile(e),
  }));

  // Unknown files are the agent's "go look at these by hand" list — surface their paths
  // (capped) so an unfamiliar bundle's unclassified evidence isn't silently ignored.
  const unknownPaths = all.filter((e) => e.kind === "unknown").map((e) => e.relPath);

  return {
    ok: true,
    data: {
      detected_version: version ?? "unknown",
      // How well the bundle matches the canonical gpudb_sysinfo layout.
      layout_match: layout,
      ...(layoutWarning !== undefined ? { layout_note: layoutWarning } : {}),
      ranks_present: ranks.join(", ") || "none",
      ...(inferredRanks.length > 0 ? { inferred_ranks_unconfirmed: inferredRanks.join(", ") } : {}),
      services_present: services.join(", ") || "none",
      total_files: totalFiles,
      total_size_mb: Number((totalBytes / 1e6).toFixed(1)),
      counts_by_kind: byKind,
      inferred_files: inferredFiles,
      unknown_files: unknownFiles,
      ...(unknownPaths.length > 0
        ? {
            unknown_file_paths: unknownPaths.slice(0, MAX_UNKNOWN_LISTED),
            ...(unknownPaths.length > MAX_UNKNOWN_LISTED
              ? { unknown_file_paths_truncated: unknownPaths.length - MAX_UNKNOWN_LISTED }
              : {}),
          }
        : {}),
      failed_collections: errors.length,
      files,
    },
  };
}
