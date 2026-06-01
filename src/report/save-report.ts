/**
 * Save report MCP tool factory.
 *
 * Provides makeSaveReportTool() which returns a SdkMcpToolDefinition for the
 * "save_report" MCP tool. The tool handles:
 * - Credential scrubbing via scrubCredentials()
 * - Partial report labeling with the (PARTIAL -- investigation interrupted) marker
 * - Auto-creation of reports/ directory
 * - Timestamped filename: kinetica-diag-YYYY-MM-DD-HHmmss.md
 * - UTF-8 file write via node:fs/promises
 *
 * Registered as readOnly: true — saving reports is non-destructive and safe,
 * requiring no user approval gate.
 *
 * Exports:
 *   formatTimestamp(date) — pure function for UTC YYYY-MM-DD-HHmmss formatting (exported for testing)
 *   makeSaveReportTool()  — factory returning SdkMcpToolDefinition
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { scrubCredentials } from "./scrub.js";

/** Marker prepended to partial reports when the investigation was interrupted. */
const PARTIAL_MARKER = "(PARTIAL -- investigation interrupted)\n\n";

/**
 * Formats a Date to YYYY-MM-DD-HHmmss in UTC.
 *
 * Pure function — exported for testing.
 *
 * @param date - The date to format
 * @returns Formatted string like "2024-06-15-143045"
 */
export function formatTimestamp(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}-${hours}${minutes}${seconds}`;
}

/**
 * Creates the save_report MCP tool definition.
 *
 * The tool saves diagnostic reports to disk with:
 * - Automatic credential scrubbing (defense-in-depth on top of Phase 1 isolation)
 * - Auto-creation of the reports/ directory if it does not exist
 * - Timestamped filename: kinetica-diag-YYYY-MM-DD-HHmmss.md (UTC)
 * - Optional partial marker when investigation was interrupted
 *
 * Annotated readOnly: true so the approval gate auto-approves this tool.
 *
 * @returns SdkMcpToolDefinition for the save_report tool
 */
export function makeSaveReportTool() {
  return tool(
    "save_report",
    "Save a diagnostic report to disk. Automatically scrubs credentials, creates a timestamped filename in reports/, and auto-creates the directory. Use at the end of each investigation or when interrupted.",
    {
      content: z.string().describe("The full markdown diagnostic report content"),
      partial: z
        .boolean()
        .optional()
        .describe(
          "Set to true if the investigation was interrupted (e.g., Ctrl+C). Prepends a PARTIAL marker to the report.",
        ),
    },
    async (args: { content: string; partial?: boolean }) => {
      // Optionally prepend partial marker before credential scrubbing
      const rawContent = args.partial ? `${PARTIAL_MARKER}${args.content}` : args.content;

      // Scrub credentials as defense-in-depth
      const scrubbed = scrubCredentials(rawContent);

      // Build timestamped filename
      const timestamp = formatTimestamp(new Date());
      const filename = `kinetica-diag-${timestamp}.md`;

      // Resolve reports/ directory relative to CWD
      const dir = resolve(process.cwd(), "reports");
      await mkdir(dir, { recursive: true });

      const filepath = join(dir, filename);
      await writeFile(filepath, scrubbed, "utf-8");

      return {
        content: [{ type: "text" as const, text: `Report saved: ${filepath}` }],
      };
    },
    { annotations: { readOnly: true } },
  );
}
