/**
 * Eval-only save_report: captures the report content in memory instead of
 * writing it to disk. Drop-in replacement for makeSaveReportTool() when
 * running evals, so the model's prompted behavior fires unchanged.
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export type CapturingSaveReport = ReturnType<typeof makeCapturingSaveReportTool>;

export function makeCapturingSaveReportTool() {
  let captured: string | undefined;

  const toolDef = tool(
    "save_report",
    "Save a diagnostic report to disk. Automatically scrubs credentials, creates a timestamped filename in reports/, and auto-creates the directory. Use at the end of each investigation or when interrupted.",
    {
      content: z.string().describe("The full markdown diagnostic report content"),
      partial: z.boolean().optional().describe("Set to true if the investigation was interrupted."),
    },
    (args: { content: string; partial?: boolean }) => {
      captured = args.content;
      return Promise.resolve({
        content: [{ type: "text" as const, text: "Report saved." }],
      });
    },
  );

  return {
    tool: toolDef,
    getCapture: () => captured,
  };
}
