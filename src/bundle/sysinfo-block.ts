/**
 * sysinfo-block — parser for the gpudb_sysinfo.sh wrapper format.
 *
 * Almost every text artifact in a support bundle (cpu.txt, mem.txt, gpudb.txt,
 * gpudb-exe-*.txt, the log captures, …) shares one structure: an optional
 * relative-path header line, then one or more command blocks of the form
 *
 *     ----------------------------------------------------
 *     EXEC_CMD: free -m -t
 *     <command output, zero or more lines>
 *     EXEC_END with exit code 0 : ok
 *
 * A single file may contain many such blocks (e.g. mem.txt runs `free`,
 * reads THP, then dumps /proc/meminfo). This one parser unwraps them all so
 * downstream tools never re-implement the format.
 *
 * Pure, never throws.
 */

export interface SysinfoBlock {
  /** The command after `EXEC_CMD:`. */
  readonly command: string;
  /** Output lines between the command and its `EXEC_END` (or the next command/EOF), joined. */
  readonly output: string;
  /** Exit code parsed from `EXEC_END with exit code N`, when present. */
  readonly exitCode?: number;
  /** Trailing message after the exit code, e.g. "ok". */
  readonly exitMessage?: string;
}

export interface ParsedSysinfo {
  /** First non-separator line before any command — usually the bundle-relative path. */
  readonly header?: string;
  readonly blocks: readonly SysinfoBlock[];
}

const SEPARATOR_RE = /^-{3,}$/;
const EXEC_CMD_RE = /^EXEC_CMD:\s?(.*)$/;
const EXEC_END_RE = /^EXEC_END with exit code (\d+)\s*:?\s*(.*)$/;
// Log-capture marker that sits between EXEC_CMD and the log body; not output.
const SHOWING_RE = /^### Showing whole log file\s*:/;

function trimBlankEdges(lines: readonly string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end).join("\n");
}

export function parseSysinfo(content: string): ParsedSysinfo {
  const lines = content.split("\n");

  let header: string | undefined;
  const blocks: SysinfoBlock[] = [];

  let current: { command: string; output: string[] } | undefined;
  let sawCommand = false;

  const closeBlock = (exitCode?: number, exitMessage?: string): void => {
    if (!current) return;
    blocks.push({
      command: current.command,
      output: trimBlankEdges(current.output),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(exitMessage !== undefined && exitMessage !== "" ? { exitMessage } : {}),
    });
    current = undefined;
  };

  for (const line of lines) {
    if (SEPARATOR_RE.test(line)) continue;

    const cmdMatch = EXEC_CMD_RE.exec(line);
    if (cmdMatch) {
      closeBlock(); // a new command implicitly ends the previous block (no EXEC_END seen)
      current = { command: cmdMatch[1].trim(), output: [] };
      sawCommand = true;
      continue;
    }

    const endMatch = EXEC_END_RE.exec(line);
    if (endMatch && current) {
      closeBlock(Number(endMatch[1]), endMatch[2].trim());
      continue;
    }

    if (current) {
      if (SHOWING_RE.test(line)) continue; // drop the log-capture marker line
      current.output.push(line);
      continue;
    }

    // Pre-command lines: the first non-blank one is the header (bundle-relative path).
    if (header === undefined && !sawCommand && line.trim() !== "") {
      header = line.trim();
    }
  }

  closeBlock(); // flush a trailing block with no EXEC_END

  return { ...(header !== undefined ? { header } : {}), blocks };
}
