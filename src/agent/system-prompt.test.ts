/**
 * Tests for buildSystemPrompt() — verifies that the system prompt contains
 * all investigation checklists, Kinetica domain knowledge, analysis instructions,
 * and report template required by ANLZ-01, ANLZ-02, ANLZ-03, REPT-01, REPT-02.
 */

import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./system-prompt.js";
import { loadReferences } from "./load-references.js";
import type { CatalogSchemas } from "./discover-schemas.js";
import type { Playbook, Reference } from "../types/index.js";

/** Test playbooks matching the 6 production playbook files. */
const TEST_PLAYBOOKS: readonly Playbook[] = [
  {
    title: "GPU Out-of-Memory",
    category: "performance",
    severity: "critical",
    keywords: ["VRAM", "GPU", "OOM"],
    body: '## Symptoms\n- ERROR logs with "out_of_memory" or GPU OOM, query failures',
    filename: "gpu-out-of-memory.md",
  },
  {
    title: "Stale Rank (Rank Not Responding)",
    category: "cluster",
    severity: "critical",
    keywords: ["rank", "stale", "offline"],
    body: "## Symptoms\n- Health check shows unhealthy rank",
    filename: "stale-rank.md",
  },
  {
    title: "Config Drift / Configuration Pitfalls",
    category: "configuration",
    severity: "warning",
    keywords: ["config", "drift"],
    body: "## Symptoms\n- Unexpected behavior after upgrade or config change",
    filename: "config-drift.md",
  },
  {
    title: "Query Contention",
    category: "performance",
    severity: "warning",
    keywords: ["query", "contention"],
    body: "## Symptoms\n- Long-running queries in `ki_query_history` (large elapsed time between start and completion)\n- Active queries blocking each other",
    filename: "query-contention.md",
  },
];

describe("buildSystemPrompt", () => {
  describe("basic function contract", () => {
    it("returns a non-empty string", () => {
      const result = buildSystemPrompt();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("is a pure function — successive calls return equal strings", () => {
      const a = buildSystemPrompt();
      const b = buildSystemPrompt();
      expect(a).toBe(b);
    });

    it("accepts optional kineticaVersion parameter", () => {
      expect(() => buildSystemPrompt("7.2.1.0")).not.toThrow();
      expect(() => buildSystemPrompt()).not.toThrow();
    });

    it("includes the version string when provided", () => {
      const result = buildSystemPrompt("7.2.1.0");
      expect(result).toContain("7.2.1.0");
    });

    it("instructs agent to detect version when omitted", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/detect|health.?check|kinetica_health_check/i);
    });
  });

  describe("investigation checklist — all 8 diagnostic tools", () => {
    const toolNames = [
      "kinetica_health_check",
      "kinetica_get_metrics",
      "kinetica_cluster_status",
      "kinetica_node_details",
      "kinetica_get_logs",
      "kinetica_show_configuration",
      "kinetica_execute_sql",
      "kinetica_explain_query",
    ] as const;

    for (const toolName of toolNames) {
      it(`contains tool reference: ${toolName}`, () => {
        const result = buildSystemPrompt();
        expect(result).toContain(toolName);
      });
    }
  });

  describe("Kinetica domain knowledge — system tables", () => {
    it("references ki_catalog.ki_query_history", () => {
      const result = buildSystemPrompt();
      expect(result).toContain("ki_catalog.ki_query_history");
    });

    it("references ki_catalog.ki_query_active_all", () => {
      const result = buildSystemPrompt();
      expect(result).toContain("ki_catalog.ki_query_active_all");
    });

    it("references ki_catalog.ki_tiered_objects", () => {
      const result = buildSystemPrompt();
      expect(result).toContain("ki_catalog.ki_tiered_objects");
    });

    it("references ki_catalog.ki_obj_stat", () => {
      const result = buildSystemPrompt();
      expect(result).toContain("ki_catalog.ki_obj_stat");
    });
  });

  describe("Kinetica domain knowledge — common failure patterns (playbooks)", () => {
    it("contains GPU OOM failure pattern when playbooks are provided", () => {
      const result = buildSystemPrompt(undefined, undefined, TEST_PLAYBOOKS);
      expect(result).toMatch(/GPU.{0,20}OOM|OOM.{0,20}GPU|out.of.memory|out_of_memory/i);
    });

    it("contains stale rank failure pattern when playbooks are provided", () => {
      const result = buildSystemPrompt(undefined, undefined, TEST_PLAYBOOKS);
      expect(result).toMatch(/stale.rank|rank.stale|stale rank/i);
    });

    it("contains config pitfalls / config drift pattern when playbooks are provided", () => {
      const result = buildSystemPrompt(undefined, undefined, TEST_PLAYBOOKS);
      expect(result).toMatch(/config.{0,30}drift|config.{0,30}pitfall|configuration.{0,30}issue/i);
    });

    it("omits Common Failure Patterns section when no playbooks are provided", () => {
      const result = buildSystemPrompt();
      expect(result).not.toContain("Common Failure Patterns");
    });

    it("includes Common Failure Patterns heading when playbooks are provided", () => {
      const result = buildSystemPrompt(undefined, undefined, TEST_PLAYBOOKS);
      expect(result).toContain("### Common Failure Patterns");
    });

    it("formats each playbook with bold title heading", () => {
      const result = buildSystemPrompt(undefined, undefined, TEST_PLAYBOOKS);
      expect(result).toContain("**GPU Out-of-Memory:**");
      expect(result).toContain("**Stale Rank (Rank Not Responding):**");
    });
  });

  describe("investigation protocol", () => {
    it("defines 5-round investigation protocol with rounds 1-3", () => {
      const result = buildSystemPrompt();
      // Should mention rounds explicitly
      expect(result).toMatch(
        /5.round|five.round|round.1.*round.2.*round.3|Round 1|Round 2|Round 3/i,
      );
    });

    it("instructs agent to announce investigation plan before gathering evidence", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/announce|brief.plan|2.3.line|investigation.plan/i);
    });

    it("instructs parallel tool calls for efficiency", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/parallel|simultaneous/i);
    });

    it("describes Round 1 as initial sweep", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/round.1.{0,50}(initial|sweep|broad)|initial.sweep/i);
    });

    it("describes Round 2 as targeted drill-down", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/round.2.{0,50}(targeted|drill.down)|targeted.drill/i);
    });

    it("describes Round 3 as confirmation pass", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/round.3.{0,50}confirm|confirm.{0,50}round.3/i);
    });
  });

  describe("ANLZ-02: analysis instructions — named hypotheses, no hedging", () => {
    it("instructs agent to commit to best hypothesis", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/commit.to|best.hypothesis|most.likely.root.cause/i);
    });

    it("instructs agent to name specific root causes", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(
        /name.{0,30}root.cause|specific.{0,30}root.cause|root.cause.{0,30}name/i,
      );
    });

    it("explicitly forbids generic hedging", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(
        /no.generic.hedging|never.hedge|avoid.hedging|no hedging|not.generic/i,
      );
    });

    it("instructs ranking when multiple hypotheses present", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/rank.{0,30}likelihood|top.2|top.3|ranked.by.likelihood/i);
    });
  });

  describe("ANLZ-03: remediation instructions", () => {
    it("instructs specific actionable remediation steps", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/actionable.remediation|specific.remediation|remediation.steps/i);
    });

    it("instructs agent-assisted mutation capabilities", () => {
      const result = buildSystemPrompt();
      expect(result).toContain("agent-assisted");
    });
  });

  describe("REPT-01 / REPT-02: report template with exact section order", () => {
    it("defines report template", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/report.template|## report format|report format/i);
    });

    it("includes Metadata section in report template", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/metadata|investigation.date|investigation.time/i);
    });

    it("includes Summary section in report template", () => {
      const result = buildSystemPrompt();
      expect(result).toContain("Summary");
    });

    it("includes Remediation section in report template", () => {
      const result = buildSystemPrompt();
      expect(result).toContain("Remediation");
    });

    it("includes Root Cause Analysis section in report template", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/Root Cause Analysis|root cause analysis/i);
    });

    it("includes Evidence Collected section in report template", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/Evidence Collected|evidence collected/i);
    });

    it("includes Evidence Gaps section in report template", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/Evidence Gaps|evidence gaps/i);
    });

    it("orders sections: Summary before Remediation before Root Cause Analysis", () => {
      const result = buildSystemPrompt();
      const summaryIdx = result.indexOf("Summary");
      const remediationIdx = result.indexOf("Remediation");
      const rootCauseIdx = result.toLowerCase().indexOf("root cause analysis");
      expect(summaryIdx).toBeLessThan(remediationIdx);
      expect(remediationIdx).toBeLessThan(rootCauseIdx);
    });

    it("orders sections: Root Cause Analysis before Evidence Collected", () => {
      const result = buildSystemPrompt();
      const rootCauseIdx = result.toLowerCase().indexOf("root cause analysis");
      const evidenceCollectedIdx = result.toLowerCase().indexOf("evidence collected");
      expect(rootCauseIdx).toBeLessThan(evidenceCollectedIdx);
    });

    it("orders sections: Evidence Collected before Evidence Gaps", () => {
      const result = buildSystemPrompt();
      const evidenceCollectedIdx = result.toLowerCase().indexOf("evidence collected");
      const evidenceGapsIdx = result.toLowerCase().indexOf("evidence gaps");
      expect(evidenceCollectedIdx).toBeLessThan(evidenceGapsIdx);
    });
  });

  describe("report metadata instructions", () => {
    it("instructs metadata header content: investigation date/time (UTC)", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/UTC|date.*time|investigation.*date/i);
    });

    it("instructs investigation duration in metadata", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/duration|investigation.*duration/i);
    });

    it("instructs number of tool calls in metadata", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/tool.calls|number.*tool/i);
    });

    it("instructs number of rounds in metadata", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/number.*round|rounds/i);
    });
  });

  describe("evidence and gap instructions", () => {
    it("instructs key findings only in evidence section — not raw tool dumps", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/key.finding|relevant.data|not.raw|extracted.*data|avoid.*raw/i);
    });

    it("instructs noting evidence gaps with HTTP status codes on tool failure", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/HTTP.status|status.code|\d{3}/i);
    });
  });

  describe("post-report behavior", () => {
    it("instructs agent to call save_report tool at end of investigation", () => {
      const result = buildSystemPrompt();
      expect(result).toContain("save_report");
    });

    it("instructs agent to ask the operator BEFORE saving the report", () => {
      const result = buildSystemPrompt();
      // The ask must precede the save: the prompt mandates a yes/no question and
      // ending the turn before save_report is called.
      expect(result).toMatch(/ask BEFORE saving|save this report to disk\? \(yes\/no\)/i);
    });

    it("instructs agent to ask about next issue or end session after report", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/another.issue|next.issue|end.the.session|end session/i);
    });
  });

  describe("context window awareness", () => {
    it("instructs agent to warn when context is getting full", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/context.{0,30}full|context.window|fresh.session/i);
    });
  });

  describe("discovered catalog schemas", () => {
    const schemas: CatalogSchemas = {
      tables: new Map([
        ["ki_query_history", ["query_id", "user_name", "query_text", "start_time", "stop_time"]],
        ["ki_obj_stat", ["object_name", "total_bytes", "row_count"]],
      ]),
    };

    it("includes verified column names directive when catalogSchemas is provided", () => {
      const result = buildSystemPrompt(undefined, schemas);
      expect(result).toMatch(/Verified Column Names/i);
    });

    it("lists column names for each discovered table", () => {
      const result = buildSystemPrompt(undefined, schemas);
      expect(result).toContain("ki_query_history");
      expect(result).toContain("query_id");
      expect(result).toContain("user_name");
      expect(result).toContain("ki_obj_stat");
      expect(result).toContain("total_bytes");
    });

    it("does not include verified column names directive when catalogSchemas is omitted", () => {
      const result = buildSystemPrompt();
      // The directive block starts with "> **Verified Column Names**" — should not appear
      expect(result).not.toContain("> **Verified Column Names**");
    });

    it("does not include verified column names directive when catalogSchemas is undefined", () => {
      const result = buildSystemPrompt(undefined, undefined);
      expect(result).not.toContain("> **Verified Column Names**");
    });

    it("still works with both version and schemas provided", () => {
      const result = buildSystemPrompt("7.2.3.9", schemas);
      expect(result).toContain("7.2.3.9");
      expect(result).toMatch(/Verified Column Names/i);
    });
  });

  describe("schema-aware SQL generation — integration", () => {
    it("uses discovered columns in SQL when schemas provide ki_query_history", () => {
      const schemas: CatalogSchemas = {
        tables: new Map([
          ["ki_query_history", ["request_id", "submitter", "sql_text", "start_time", "stop_time"]],
        ]),
      };
      const result = buildSystemPrompt(undefined, schemas);
      expect(result).toContain("request_id");
      expect(result).toContain("submitter");
      expect(result).toContain("ki_catalog.ki_query_history");
    });

    it("falls back to hardcoded SQL when schemas lack a specific table", () => {
      const schemas: CatalogSchemas = {
        tables: new Map([
          ["ki_query_history", ["query_id", "user_name", "query_text", "start_time", "stop_time"]],
        ]),
      };
      const result = buildSystemPrompt(undefined, schemas);
      // Tiered objects should use fallback columns
      expect(result).toContain("owner_resource_group");
      // Query history should use discovered columns
      expect(result).toContain("ki_catalog.ki_query_history");
    });

    it("ki_columns and ki_datatypes appear in verified column names directive", () => {
      const schemas: CatalogSchemas = {
        tables: new Map([
          ["ki_columns", ["table_name", "column_name"]],
          ["ki_datatypes", ["oid", "name", "sql_typename"]],
        ]),
      };
      const result = buildSystemPrompt(undefined, schemas);
      expect(result).toMatch(/Verified Column Names/i);
      expect(result).toMatch(/\*\*ki_columns\*\*/);
      expect(result).toMatch(/\*\*ki_datatypes\*\*/);
    });

    it("falls back to conservative SQL when schemas lack ki_columns", () => {
      const schemas: CatalogSchemas = {
        tables: new Map([
          ["ki_query_history", ["query_id", "user_name", "start_time", "stop_time"]],
        ]),
      };
      const result = buildSystemPrompt(undefined, schemas);
      expect(result).toContain("c.table_name, c.column_name, c.column_position");
    });
  });

  describe("diagnostic SQL section headings — 6 sections in order", () => {
    const result = buildSystemPrompt();

    it("contains all 6 section headings", () => {
      const sections = [
        "Query History and Performance",
        "Memory and Storage Tiers",
        "Object Registry and Metadata",
        "Security and Access Control",
        "Data Ingestion and Operations",
        "Schema Inspection",
      ];
      for (const section of sections) {
        expect(result).toContain(`**${section}:**`);
      }
    });

    it("orders Query History before Memory and Storage", () => {
      expect(result.indexOf("Query History and Performance")).toBeLessThan(
        result.indexOf("Memory and Storage Tiers"),
      );
    });

    it("orders Memory and Storage before Object Registry", () => {
      expect(result.indexOf("Memory and Storage Tiers")).toBeLessThan(
        result.indexOf("Object Registry and Metadata"),
      );
    });

    it("orders Object Registry before Security", () => {
      expect(result.indexOf("Object Registry and Metadata")).toBeLessThan(
        result.indexOf("Security and Access Control"),
      );
    });

    it("orders Security before Data Ingestion", () => {
      expect(result.indexOf("Security and Access Control")).toBeLessThan(
        result.indexOf("Data Ingestion and Operations"),
      );
    });

    it("orders Data Ingestion before Schema Inspection", () => {
      expect(result.indexOf("Data Ingestion and Operations")).toBeLessThan(
        result.indexOf("Schema Inspection"),
      );
    });
  });

  describe("new diagnostic tables appear in fallback prompt", () => {
    const result = buildSystemPrompt();

    it("contains ki_query_span_metrics_all fallback SQL", () => {
      expect(result).toContain("ki_catalog.ki_query_span_metrics_all");
    });

    it("contains ki_query_workers fallback SQL", () => {
      expect(result).toContain("ki_catalog.ki_query_workers");
    });

    it("contains ki_objects fallback SQL", () => {
      expect(result).toContain("ki_catalog.ki_objects");
    });

    it("contains ki_partitions fallback SQL", () => {
      expect(result).toContain("ki_catalog.ki_partitions");
    });

    it("contains ki_indexes fallback SQL", () => {
      expect(result).toContain("ki_catalog.ki_indexes");
    });

    it("contains ki_periodic_objects fallback SQL", () => {
      expect(result).toContain("ki_catalog.ki_periodic_objects");
    });

    it("contains ki_users_and_roles fallback SQL", () => {
      expect(result).toContain("ki_catalog.ki_users_and_roles");
    });

    it("contains ki_object_permissions fallback SQL", () => {
      expect(result).toContain("ki_catalog.ki_object_permissions");
    });

    it("contains ki_depend fallback SQL", () => {
      expect(result).toContain("ki_catalog.ki_depend");
    });

    it("contains ki_load_history fallback SQL", () => {
      expect(result).toContain("ki_catalog.ki_load_history");
    });

    it("contains ki_backup_history fallback SQL", () => {
      expect(result).toContain("ki_catalog.ki_backup_history");
    });

    it("contains ki_kafka_lag_info fallback SQL", () => {
      expect(result).toContain("ki_catalog.ki_kafka_lag_info");
    });
  });

  describe("Column Type Inspection guidance", () => {
    it("contains Column Type Inspection section", () => {
      const result = buildSystemPrompt();
      expect(result).toContain("Column Type Inspection");
    });

    it("recommends kinetica_show_table for Kinetica-native types", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/kinetica_show_table.*Kinetica.native/i);
    });

    it("recommends ki_columns only for structural metadata", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/ki_columns.*structural/i);
    });

    it("evidence checklist mentions column types for kinetica_show_table", () => {
      const result = buildSystemPrompt();
      // Find the kinetica_show_table row in the evidence checklist
      const showTableLine = result
        .split("\n")
        .find((line) => line.includes("kinetica_show_table") && line.includes("|"));
      expect(showTableLine).toBeDefined();
      expect(showTableLine).toMatch(/column.type/i);
    });

    it("appears before Common Failure Patterns when playbooks are loaded", () => {
      const result = buildSystemPrompt(undefined, undefined, TEST_PLAYBOOKS);
      const columnTypeIdx = result.indexOf("Column Type Inspection");
      const failurePatternsIdx = result.indexOf("Common Failure Patterns");
      expect(columnTypeIdx).toBeGreaterThan(-1);
      expect(failurePatternsIdx).toBeGreaterThan(-1);
      expect(columnTypeIdx).toBeLessThan(failurePatternsIdx);
    });
  });

  describe("output formatting guidance", () => {
    it("contains an Output Formatting section", () => {
      const result = buildSystemPrompt();
      expect(result).toContain("## Output Formatting");
    });

    it("appears before the report template", () => {
      const result = buildSystemPrompt();
      const formattingIdx = result.indexOf("## Output Formatting");
      const reportTemplateIdx = result.indexOf("## REPORT TEMPLATE");
      expect(formattingIdx).toBeGreaterThan(-1);
      expect(reportTemplateIdx).toBeGreaterThan(-1);
      expect(formattingIdx).toBeLessThan(reportTemplateIdx);
    });

    it("instructs markdown table syntax", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/markdown table/i);
    });

    it("instructs not to dump raw tool output", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/do not dump raw tool output/i);
    });

    it("includes an example table", () => {
      const result = buildSystemPrompt();
      // The example table has a header separator row
      const formattingStart = result.indexOf("## Output Formatting");
      const formattingEnd = result.indexOf("## REPORT TEMPLATE");
      const section = result.slice(formattingStart, formattingEnd);
      expect(section).toContain("| ---------- |");
    });
  });

  describe("error recovery instructions", () => {
    it("distinguishes SQL column errors as recoverable", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/SQL column error|column.error.*recoverable/i);
    });

    it("instructs checking Verified Column Names on SQL column failure", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/Verified Column Names/i);
      // Should appear in the recovery instructions section, not just the directive
      const gapSection = result.slice(result.indexOf("Evidence Gap"));
      expect(gapSection).toMatch(/Verified Column Names/i);
    });

    it("provides SELECT * fallback for column errors", () => {
      const result = buildSystemPrompt();
      expect(result).toContain("SELECT * FROM ki_catalog.");
    });

    it("caps retry at one attempt", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/retry once|one retry|retry.{0,20}once/i);
    });

    it("preserves existing HTTP error examples (503, 401)", () => {
      const result = buildSystemPrompt();
      expect(result).toContain("503");
      expect(result).toContain("401");
    });

    it("still instructs not to halt on a single tool failure", () => {
      const result = buildSystemPrompt();
      expect(result).toMatch(/never halt|do not halt/i);
    });
  });

  describe("query contention prose is column-name-agnostic", () => {
    it("uses generic elapsed time wording instead of specific column names", () => {
      const result = buildSystemPrompt(undefined, undefined, TEST_PLAYBOOKS);
      expect(result).toContain("large elapsed time between start and completion");
      expect(result).not.toContain("large stop_time");
    });
  });

  // ALTER TABLE and CREATE INDEX guidance lives in knowledge/references/
  // (sql-alter-table.md and sql-create-index.md). These tests verify the
  // real reference files on disk still carry the syntax rules and that the
  // text reaches the final prompt via the reference loader pipeline.

  describe("ALTER TABLE column property guidance (via real references)", () => {
    it("contains ALTER TABLE column property syntax", async () => {
      const refs = await loadReferences();
      const prompt = buildSystemPrompt(undefined, undefined, undefined, refs);
      expect(prompt).toContain("ALTER TABLE");
      expect(prompt).toContain("ALTER COLUMN");
      expect(prompt).toContain("DICT");
    });

    it("shows correct DICT syntax inside parentheses", async () => {
      const refs = await loadReferences();
      const prompt = buildSystemPrompt(undefined, undefined, undefined, refs);
      expect(prompt).toContain("VARCHAR(size, DICT)");
    });

    it("shows MODIFY COLUMN as equivalent syntax", async () => {
      const refs = await loadReferences();
      const prompt = buildSystemPrompt(undefined, undefined, undefined, refs);
      expect(prompt).toContain("MODIFY COLUMN");
    });

    it("lists available column properties", async () => {
      const refs = await loadReferences();
      const prompt = buildSystemPrompt(undefined, undefined, undefined, refs);
      expect(prompt).toContain("TEXT_SEARCH");
      expect(prompt).toContain("COMPRESS");
    });

    it("warns about dependent views being dropped", async () => {
      const refs = await loadReferences();
      const prompt = buildSystemPrompt(undefined, undefined, undefined, refs);
      expect(prompt).toMatch(/dependent.{0,30}(views|materialized)/i);
    });
  });

  describe("CREATE INDEX syntax guidance (via real references)", () => {
    it("contains CREATE INDEX syntax", async () => {
      const refs = await loadReferences();
      const prompt = buildSystemPrompt(undefined, undefined, undefined, refs);
      expect(prompt).toContain("CREATE INDEX");
      expect(prompt).toContain("index_name ON");
    });

    it("shows correct syntax with index name before ON", async () => {
      const refs = await loadReferences();
      const prompt = buildSystemPrompt(undefined, undefined, undefined, refs);
      expect(prompt).toContain("CREATE INDEX index_name ON");
    });

    it("warns that index name is required before ON", async () => {
      const refs = await loadReferences();
      const prompt = buildSystemPrompt(undefined, undefined, undefined, refs);
      expect(prompt).toMatch(/index name.{0,30}REQUIRED/i);
    });

    it("shows DROP INDEX syntax", async () => {
      const refs = await loadReferences();
      const prompt = buildSystemPrompt(undefined, undefined, undefined, refs);
      expect(prompt).toContain("DROP INDEX");
    });

    it("recommends checking ki_indexes before creation", async () => {
      const refs = await loadReferences();
      const prompt = buildSystemPrompt(undefined, undefined, undefined, refs);
      expect(prompt).toContain("ki_catalog.ki_indexes");
    });
  });

  describe("mutation tools — evidence checklist", () => {
    it("includes mutation tool descriptions in evidence checklist", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("kinetica_alter_system_properties");
      expect(prompt).toContain("kinetica_execute_mutation_sql");
      expect(prompt).toContain("kinetica_admin_rebalance");
    });
  });

  describe("mutation safety rules (via real references)", () => {
    // Mutation Safety Rules live in knowledge/references/mutation-safety.md
    // and reach the prompt through the reference loader.

    it("includes Mutation Safety Rules section", async () => {
      const refs = await loadReferences();
      const prompt = buildSystemPrompt(undefined, undefined, undefined, refs);
      expect(prompt).toContain("Mutation Safety Rules");
      expect(prompt).toContain("NEVER");
      expect(prompt).toContain("/clear/table");
      expect(prompt).toContain("ai_api_key");
    });

    it("documents worker restart as unavailable (no REST API)", async () => {
      const refs = await loadReferences();
      const prompt = buildSystemPrompt(undefined, undefined, undefined, refs);
      expect(prompt).toContain("Worker restart");
      expect(prompt).toContain("gadmin restart rank");
    });

    it("documents cache clearing as unavailable", async () => {
      const refs = await loadReferences();
      const prompt = buildSystemPrompt(undefined, undefined, undefined, refs);
      expect(prompt).toContain("Cache clearing");
      expect(prompt).toContain("no safe API exists in Kinetica 7.2");
    });
  });

  describe("5-round investigation protocol", () => {
    it("includes 5-round investigation protocol heading", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("5-Round");
    });

    it("includes Round 4 Mutation Proposal", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("Round 4");
      expect(prompt).toContain("Mutation Proposal");
    });

    it("includes Round 5 Post-Mutation Verification", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("Round 5");
      expect(prompt).toContain("Post-Mutation Verification");
    });
  });

  describe("future version labels removed", () => {
    it("does not contain future version labels", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).not.toContain("(agent-assisted: coming in future version)");
    });
  });

  describe("report template — mutation audit trail sections", () => {
    it("includes Mutations Applied section in report template", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("## Mutations Applied");
    });

    it("includes Post-Remediation Verification section in report template", () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain("## Post-Remediation Verification");
    });

    it("report template section order: Summary -> Remediation -> Mutations Applied -> Post-Remediation Verification", () => {
      const prompt = buildSystemPrompt();
      const summaryIdx = prompt.indexOf("## Summary");
      const remediationIdx = prompt.indexOf("## Remediation");
      const mutationsIdx = prompt.indexOf("## Mutations Applied");
      const postRemIdx = prompt.indexOf("## Post-Remediation Verification");
      expect(summaryIdx).toBeLessThan(remediationIdx);
      expect(remediationIdx).toBeLessThan(mutationsIdx);
      expect(mutationsIdx).toBeLessThan(postRemIdx);
    });
  });

  // -------------------------------------------------------------------------
  // Reference knowledge
  // -------------------------------------------------------------------------

  const TEST_REFERENCES: readonly Reference[] = [
    {
      title: "gpudb.conf Configuration Reference",
      category: "configuration",
      keywords: ["gpudb.conf", "config"],
      body: "## Overview\n\n`gpudb.conf` is the master config.\n\n## Key Gotchas\n\n- `-1` means different things",
      filename: "gpudb-conf.md",
    },
  ];

  describe("reference knowledge section", () => {
    it("omits Reference Knowledge section when no references are provided", () => {
      const result = buildSystemPrompt();
      expect(result).not.toContain("Reference Knowledge");
    });

    it("includes Reference Knowledge heading when references are provided", () => {
      const result = buildSystemPrompt(undefined, undefined, undefined, TEST_REFERENCES);
      expect(result).toContain("### Reference Knowledge");
    });

    it("formats each reference with bold title heading", () => {
      const result = buildSystemPrompt(undefined, undefined, undefined, TEST_REFERENCES);
      expect(result).toContain("**gpudb.conf Configuration Reference:**");
    });

    it("includes reference body content", () => {
      const result = buildSystemPrompt(undefined, undefined, undefined, TEST_REFERENCES);
      expect(result).toContain("master config");
      expect(result).toContain("Key Gotchas");
    });

    it("places Reference Knowledge after Common Failure Patterns", () => {
      const result = buildSystemPrompt(undefined, undefined, TEST_PLAYBOOKS, TEST_REFERENCES);
      const failurePatternsIdx = result.indexOf("Common Failure Patterns");
      const referenceIdx = result.indexOf("Reference Knowledge");
      expect(failurePatternsIdx).toBeGreaterThan(-1);
      expect(referenceIdx).toBeGreaterThan(-1);
      expect(failurePatternsIdx).toBeLessThan(referenceIdx);
    });

    it("places Reference Knowledge before Analysis Instructions", () => {
      const result = buildSystemPrompt(undefined, undefined, undefined, TEST_REFERENCES);
      const referenceIdx = result.indexOf("Reference Knowledge");
      const analysisIdx = result.indexOf("## Analysis Instructions");
      expect(referenceIdx).toBeGreaterThan(-1);
      expect(analysisIdx).toBeGreaterThan(-1);
      expect(referenceIdx).toBeLessThan(analysisIdx);
    });
  });

  // -------------------------------------------------------------------------
  // Degraded mode
  // -------------------------------------------------------------------------

  describe("degraded mode prompt section", () => {
    it("includes DEGRADED MODE heading when degraded is true", () => {
      const prompt = buildSystemPrompt("7.2.3.11", undefined, undefined, undefined, true);
      expect(prompt).toContain("## DEGRADED MODE");
      expect(prompt).toContain("DB Engine Unreachable");
    });

    it("mentions kinetica_host_manager_status as primary tool when degraded", () => {
      const prompt = buildSystemPrompt(undefined, undefined, undefined, undefined, true);
      expect(prompt).toContain("kinetica_host_manager_status");
      expect(prompt).toContain("USE THIS FIRST");
    });

    it("warns that other diagnostic tools will fail when degraded", () => {
      const prompt = buildSystemPrompt(undefined, undefined, undefined, undefined, true);
      expect(prompt).toContain("kinetica_health_check");
      expect(prompt).toContain("will return errors");
    });

    it("includes investigation strategy for degraded mode", () => {
      const prompt = buildSystemPrompt(undefined, undefined, undefined, undefined, true);
      expect(prompt).toContain("gadmin status");
      expect(prompt).toContain("rank process statuses");
    });

    it("does not include DEGRADED MODE section when degraded is false", () => {
      const prompt = buildSystemPrompt("7.2.3.11", undefined, undefined, undefined, false);
      expect(prompt).not.toContain("## DEGRADED MODE");
    });

    it("does not include DEGRADED MODE section when degraded is undefined", () => {
      const prompt = buildSystemPrompt("7.2.3.11");
      expect(prompt).not.toContain("## DEGRADED MODE");
    });

    it("preserves all existing sections alongside degraded mode section", () => {
      const prompt = buildSystemPrompt("7.2.3.11", undefined, undefined, undefined, true);
      expect(prompt).toContain("## Role and Mandate");
      expect(prompt).toContain("## Investigation Protocol");
      expect(prompt).toContain("## REPORT TEMPLATE");
    });

    it("places degraded section before Role and Mandate", () => {
      const prompt = buildSystemPrompt("7.2.3.11", undefined, undefined, undefined, true);
      const degradedIdx = prompt.indexOf("## DEGRADED MODE");
      const roleIdx = prompt.indexOf("## Role and Mandate");
      expect(degradedIdx).toBeLessThan(roleIdx);
    });
  });

  describe("ki_tiered_objects.id format warning", () => {
    // These warnings now live in knowledge/references/catalog-joins.md and
    // knowledge/references/catalog-enums.md. The tests verify the warnings
    // reach the prompt when references are plumbed through.
    const TIERED_OBJECTS_REFERENCES: readonly Reference[] = [
      {
        title: "ki_catalog Cross-Table Correlation Paths",
        category: "catalog-schema",
        keywords: ["ki_tiered_objects", "oid"],
        body: "`ki_tiered_objects.id` is a **string identifier**, NOT a numeric OID. For per-table tier placement, prefer `kinetica_resource_objects` with `table_names` filter.",
        filename: "catalog-joins.md",
      },
    ];

    it("warns that ki_tiered_objects.id is not a numeric OID when references are loaded", () => {
      const result = buildSystemPrompt(undefined, undefined, undefined, TIERED_OBJECTS_REFERENCES);
      expect(result).toMatch(/ki_tiered_objects\.id.*NOT.*numeric.*OID/i);
    });

    it("recommends kinetica_resource_objects for per-table tier lookup when references are loaded", () => {
      const result = buildSystemPrompt(undefined, undefined, undefined, TIERED_OBJECTS_REFERENCES);
      expect(result).toMatch(/kinetica_resource_objects.*table_names/i);
    });

    it("ki_tiered_objects.id warning survives end-to-end via real references on disk", async () => {
      const refs = await loadReferences();
      const result = buildSystemPrompt(undefined, undefined, undefined, refs);
      // `s` flag — warnings wrap across lines in the reference markdown
      expect(result).toMatch(/ki_tiered_objects\.id.*NOT.*numeric.*OID/is);
      expect(result).toMatch(/kinetica_resource_objects.*table_names/is);
    });

    it("rank 0 asymmetry warning survives end-to-end via real references on disk", async () => {
      const refs = await loadReferences();
      const result = buildSystemPrompt(undefined, undefined, undefined, refs);
      expect(result).toMatch(/rank 0.*(head|coordinator)/is);
      expect(result).toMatch(/rank 0.*low.*(usage|idle).*normal/is);
    });
  });
});
