import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageRoot } from "./load-playbooks.js";

function loadReportTemplateSync(): string {
  try {
    const root = findPackageRoot(__dirname);
    const path = join(root, "knowledge", "templates", "report.md");
    return readFileSync(path, "utf-8");
  } catch (err) {
    console.warn(`[report-template] failed to load knowledge/templates/report.md: ${String(err)}`);
    return "";
  }
}

// Sync at import keeps buildSystemPrompt() a pure function: by the time any
// caller runs, REPORT_TEMPLATE is a plain string constant.
export const REPORT_TEMPLATE: string = loadReportTemplateSync();
