/**
 * kinetica_bundle_list_files — orientation tool for offline bundle mode.
 *
 * The agent's first call: inventories the extracted bundle so it knows what
 * evidence exists (which ranks, which logs, the detected version) and what is
 * missing (failed collections). Analogous to a Round-1 health sweep.
 */

import { z } from "zod";
import type { BundleSource } from "../../bundle/BundleSource.js";
import { describeBundleFile } from "../../bundle/known-files.js";
import type { ToolResult } from "../../types/index.js";

export const BundleListFilesSchema = z.object({
  kind: z.string().optional(),
});

export async function bundleListFiles(
  source: BundleSource,
  args: { kind?: string } = {},
): Promise<ToolResult<unknown>> {
  const all = source.listFiles();
  const filtered = args.kind ? all.filter((e) => e.kind === args.kind) : all;

  const { totalFiles, totalBytes, byKind, ranks, services } = source.inventory();
  const version = await source.detectVersion();
  const errors = await source.collectionErrors();

  const files = filtered.map((e) => ({
    file: e.relPath,
    kind: e.kind,
    rank: e.rank ?? "",
    size_kb: Math.round(e.sizeBytes / 1024),
    // What the file contains — so the agent can pick the right one without reading it.
    description: describeBundleFile(e),
  }));

  return {
    ok: true,
    data: {
      detected_version: version ?? "unknown",
      ranks_present: ranks.join(", ") || "none",
      services_present: services.join(", ") || "none",
      total_files: totalFiles,
      total_size_mb: Number((totalBytes / 1e6).toFixed(1)),
      counts_by_kind: byKind,
      failed_collections: errors.length,
      files,
    },
  };
}
