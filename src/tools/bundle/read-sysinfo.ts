/**
 * kinetica_bundle_read_sysinfo — read an OS-diagnostic / process / version file.
 *
 * Bundle .txt artifacts (mem.txt, cpu.txt, disk.txt, gpu.txt, net.txt, ps.txt,
 * gpudb-exe-*.txt, gpudb.txt, …) wrap one or more shell commands in the sysinfo
 * EXEC_CMD/EXEC_END format. This returns those command blocks so the agent can
 * inspect host-level facts (memory pressure, GPU presence, disk, THP) the live
 * endpoints never expose.
 */

import { z } from "zod";
import type { BundleSource } from "../../bundle/BundleSource.js";
import type { ToolResult } from "../../types/index.js";

export const BundleReadSysinfoSchema = z.object({
  name: z.string().min(1),
});

export type BundleReadSysinfoInput = z.infer<typeof BundleReadSysinfoSchema>;

export async function bundleReadSysinfo(
  source: BundleSource,
  args: BundleReadSysinfoInput,
): Promise<ToolResult<unknown>> {
  const result = await source.readSysinfo(args.name);

  if ("error" in result) {
    return { ok: false, status: 0, error: result.error, raw: "" };
  }

  return {
    ok: true,
    data: {
      ...(result.header !== undefined ? { source_file: result.header } : {}),
      blocks: result.blocks.map((b) => ({
        command: b.command,
        ...(b.exitCode !== undefined ? { exit_code: b.exitCode } : {}),
        output: b.output,
      })),
    },
  };
}
