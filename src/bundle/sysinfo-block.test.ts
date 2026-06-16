import { describe, it, expect } from "vitest";
import { parseSysinfo } from "./sysinfo-block.js";

// Real shape from mem.txt (three commands in one file).
const MEM_TXT = `gpudb-sysinfo-node2-20260613_030952/mem.txt

----------------------------------------------------
EXEC_CMD: free -m -t
               total        used        free
Mem:            7939        3023         636
EXEC_END with exit code 0 : ok

----------------------------------------------------
EXEC_CMD: cat /sys/kernel/mm/transparent_hugepage/enabled
always madvise [never]
EXEC_END with exit code 0 : ok

----------------------------------------------------
EXEC_CMD: cat /proc/meminfo
MemTotal:        8129828 kB
MemFree:          652524 kB
EXEC_END with exit code 0 : ok
`;

describe("parseSysinfo", () => {
  it("captures the relative-path header", () => {
    expect(parseSysinfo(MEM_TXT).header).toBe("gpudb-sysinfo-node2-20260613_030952/mem.txt");
  });

  it("splits a multi-command file into one block per EXEC_CMD", () => {
    const { blocks } = parseSysinfo(MEM_TXT);
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => b.command)).toEqual([
      "free -m -t",
      "cat /sys/kernel/mm/transparent_hugepage/enabled",
      "cat /proc/meminfo",
    ]);
  });

  it("captures output between command and EXEC_END, trimming blank edges", () => {
    const { blocks } = parseSysinfo(MEM_TXT);
    expect(blocks[0].output).toBe(
      "               total        used        free\nMem:            7939        3023         636",
    );
    expect(blocks[1].output).toBe("always madvise [never]");
  });

  it("parses exit code and message", () => {
    const { blocks } = parseSysinfo(MEM_TXT);
    expect(blocks[0].exitCode).toBe(0);
    expect(blocks[0].exitMessage).toBe("ok");
  });

  it("parses a non-zero exit code", () => {
    const { blocks } = parseSysinfo(
      "EXEC_CMD: nvidia-smi\ncommand not found\nEXEC_END with exit code 127 : error",
    );
    expect(blocks[0].exitCode).toBe(127);
    expect(blocks[0].exitMessage).toBe("error");
  });

  it("closes a trailing block that has no EXEC_END", () => {
    const { blocks } = parseSysinfo("EXEC_CMD: echo\nhello world");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].command).toBe("echo");
    expect(blocks[0].output).toBe("hello world");
    expect(blocks[0].exitCode).toBeUndefined();
  });

  it("starts a new block when EXEC_CMD appears without a preceding EXEC_END", () => {
    const { blocks } = parseSysinfo("EXEC_CMD: a\nout-a\nEXEC_CMD: b\nout-b");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].output).toBe("out-a");
    expect(blocks[1].output).toBe("out-b");
  });

  it("drops the '### Showing whole log file' marker from output", () => {
    const { blocks } = parseSysinfo(
      "EXEC_CMD: local_log_file x\n### Showing whole log file : /opt/gpudb/x.log\nactual line\nEXEC_END with exit code 0 : ok",
    );
    expect(blocks[0].output).toBe("actual line");
  });

  it("returns an empty block list and no header for empty input", () => {
    const parsed = parseSysinfo("");
    expect(parsed.blocks).toEqual([]);
    expect(parsed.header).toBeUndefined();
  });
});
