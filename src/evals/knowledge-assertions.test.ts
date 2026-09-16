/**
 * Tests for the knowledge-retrieval validators. Keeps the eval's assertion logic
 * covered by the fast suite, per src/evals/README.md.
 */

import { describe, it, expect } from "vitest";

import {
  bareToolName,
  idsRead,
  validateRetrievalCalls,
  validateKnowledgeRetrieval,
  remediationTouchesService,
  gadminCommandLines,
  type ToolCall,
} from "./knowledge-assertions.js";

const read = (id: string): ToolCall => ({
  name: "mcp__kinetica-diagnostics__kinetica_knowledge_read",
  input: { id },
});
const save: ToolCall = { name: "mcp__kinetica-diagnostics__save_report", input: {} };
const health: ToolCall = {
  name: "mcp__kinetica-diagnostics__kinetica_health_check",
  input: {},
};

const REPORT = "## Evidence Collected\n\nknowledge: memory-pressure\n";

/**
 * The Remediation that failed this assertion on 2026-09-13, trimmed to the shape that
 * mattered: sanctioned commands in a fence, the forbidden one named in prose to rule it
 * out. The agent had read `service-management` and was passing its never-emit table on to
 * the operator — the corpus working, and the old whole-report test called it a regression.
 */
const CITED_NOT_EMITTED = [
  // Names the ids it read, as every measured report does — assertion 4 checks for that.
  "## Evidence Collected\n\nknowledge: stale-rank, service-management\n",
  "## Remediation",
  "",
  "**Step 2 — Restart the database service on host2 (as root, in this order):**",
  "",
  "```bash",
  "systemctl stop gpudb",
  "systemctl start gpudb",
  "```",
  "",
  "This is the only sanctioned method — `gadmin restart rank 2` and `systemctl restart " +
    "rank2` are **wrong and must not be used**.",
].join("\n");

describe("bareToolName", () => {
  it("strips an MCP server prefix", () => {
    expect(bareToolName("mcp__kinetica-diagnostics__kinetica_knowledge_read")).toBe(
      "kinetica_knowledge_read",
    );
  });

  it("leaves an unprefixed name alone", () => {
    expect(bareToolName("save_report")).toBe("save_report");
  });
});

describe("idsRead", () => {
  it("collects ids in order, deduplicated", () => {
    expect(idsRead([read("a"), health, read("b"), read("a")])).toEqual(["a", "b"]);
  });

  it("tolerates a '.md' suffix the agent may copy from a document body", () => {
    expect(idsRead([read("service-management.md")])).toEqual(["service-management"]);
  });

  it("returns nothing when no document was read", () => {
    expect(idsRead([health, save])).toEqual([]);
  });
});

describe("validateKnowledgeRetrieval", () => {
  it("passes when the expected document was read before the report", () => {
    const result = validateKnowledgeRetrieval([health, read("memory-pressure"), save], REPORT, [
      "memory-pressure",
      "tiered-objects",
    ]);
    expect(result).toEqual({ passed: true, errors: [] });
  });

  it("fails when no document was read at all", () => {
    const result = validateKnowledgeRetrieval([health, save], "## Evidence Collected", [
      "memory-pressure",
    ]);
    expect(result.passed).toBe(false);
    expect(result.errors[0]).toMatch(/without.*reading/i);
  });

  it("fails when the read happened only AFTER the report was saved", () => {
    const result = validateKnowledgeRetrieval([save, read("memory-pressure")], REPORT, [
      "memory-pressure",
    ]);
    expect(result.passed).toBe(false);
    expect(result.errors.join(" ")).toMatch(/before save_report/);
  });

  it("fails when the agent read something, but not the matching document", () => {
    const result = validateKnowledgeRetrieval(
      [read("catalog-enums"), save],
      "## Evidence Collected\n\nknowledge: catalog-enums",
      ["memory-pressure"],
    );
    expect(result.passed).toBe(false);
    expect(result.errors.join(" ")).toMatch(/none of the expected ids/);
  });

  it("ignores 'restart' outside the Remediation section", () => {
    // A Timeline or Root Cause that NARRATES a restart ("rank 2 restarted at 14:23")
    // is not a remediation step. Testing the whole report made any incident involving
    // a restart demand a service-management read the protocol never required.
    const result = validateKnowledgeRetrieval(
      [read("memory-pressure"), save],
      `${REPORT}\n## Timeline\n\n| 14:23 | operator issued a restart of rank 2 |\n\n## Remediation\n\n1. Raise the RAM tier limit.`,
      ["memory-pressure"],
    );
    expect(result.passed).toBe(true);
  });

  it("still fires when the Remediation section itself touches a service", () => {
    const result = validateKnowledgeRetrieval(
      [read("memory-pressure"), save],
      `${REPORT}\n## Remediation\n\n1. Raise the limit, then restart the database.\n\n## Evidence Gaps\n\nNone.`,
      ["memory-pressure"],
    );
    expect(result.passed).toBe(false);
    expect(result.errors.join(" ")).toMatch(/service-management was never read/);
  });

  it("passes a config remediation whose only 'restart' is the required caveat", () => {
    // The memory-pressure report of 2026-09-15, abridged: tier-limit edits, no command
    // named anywhere, and no service-management read. It failed on the parenthetical.
    const result = validateKnowledgeRetrieval(
      [read("memory-pressure"), read("tiered-objects"), save],
      [
        REPORT,
        "## Remediation",
        "",
        "3. **Config change — Raise the RAM tier limit** *(requires DBA approval and a DB " +
          "restart to take effect)*: propose an increase via `kinetica_alter_system_properties`.",
        "4. **Config change — Tune eviction watermarks:** lower `conf.tier.ram.high_watermark` " +
          "to start background eviction earlier.",
      ].join("\n"),
      ["memory-pressure"],
    );
    expect(result.errors).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("fails a restart remediation that never read service-management", () => {
    const result = validateKnowledgeRetrieval(
      [read("memory-pressure"), save],
      `${REPORT}\n## Remediation\n\n1. Restart the database on node2.`,
      ["memory-pressure"],
    );
    expect(result.passed).toBe(false);
    expect(result.errors.join(" ")).toMatch(/service-management was never read/);
  });

  it("passes a restart remediation that did read service-management", () => {
    const result = validateKnowledgeRetrieval(
      [read("memory-pressure"), read("service-management"), save],
      `${REPORT}\n## Remediation\n\n1. Restart the database: systemctl restart gpudb.`,
      ["memory-pressure"],
    );
    expect(result.passed).toBe(true);
  });

  it("fails a report that emits a gadmin service command", () => {
    const result = validateKnowledgeRetrieval(
      [read("memory-pressure"), read("service-management"), save],
      `${REPORT}\n## Remediation\n\n1. Run gadmin restart rank 2.`,
      ["memory-pressure"],
    );
    expect(result.passed).toBe(false);
    expect(result.errors.join(" ")).toMatch(/gadmin/);
  });

  it("names the offending line so the failure is diagnosable without the report", () => {
    const result = validateKnowledgeRetrieval(
      [read("memory-pressure"), read("service-management"), save],
      `${REPORT}\n## Remediation\n\n1. Run gadmin restart rank 2.`,
      ["memory-pressure"],
    );
    expect(result.errors.join(" ")).toMatch(/1\. Run gadmin restart rank 2\./);
  });

  it("passes a report that cites gadmin as the anti-pattern rather than emitting it", () => {
    const result = validateKnowledgeRetrieval(
      [read("stale-rank"), read("service-management"), save],
      CITED_NOT_EMITTED,
      ["stale-rank"],
    );
    expect(result.errors).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("fails a gadmin command inside a fence even when the prose around it disowns it", () => {
    const result = validateKnowledgeRetrieval(
      [read("stale-rank"), read("service-management"), save],
      `${REPORT}\n## Remediation\n\nThis is not optional:\n\n\`\`\`bash\ngadmin restart rank 2\n\`\`\`\n`,
      ["stale-rank"],
    );
    expect(result.passed).toBe(false);
    expect(result.errors.join(" ")).toMatch(/gadmin restart rank 2/);
  });

  it("accepts per-finding attribution, not just a `knowledge:` summary line", () => {
    // The shape that failed on 2026-09-16 — and it is MORE auditable than one summary
    // line, since each finding carries the document it came from. `kinetica_knowledge_read`
    // has an underscore where the old /knowledge:/ regex wanted a colon.
    const result = validateKnowledgeRetrieval(
      [read("gpudb-conf"), read("service-management"), save],
      "## Evidence Collected\n\n" +
        "| Finding | Source |\n|---|---|\n" +
        "| `tps_per_tom` stores but needs a restart | `kinetica_knowledge_read` (id: `gpudb-conf`) |\n" +
        "| Correct restart commands | `kinetica_knowledge_read` (id: `service-management`) |\n\n" +
        "## Remediation\n\n1. Restart the database: `systemctl stop gpudb` then `systemctl start gpudb`.",
      ["gpudb-conf"],
    );
    expect(result.errors).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("fails when the report does not name the ids it read", () => {
    const result = validateKnowledgeRetrieval(
      [read("memory-pressure"), save],
      "## Evidence Collected\n\nHealth check was clean.",
      ["memory-pressure"],
    );
    expect(result.passed).toBe(false);
    expect(result.errors.join(" ")).toMatch(/not auditable/);
  });
});

// ---------------------------------------------------------------------------
// validateRetrievalCalls — the transcript-only half
// ---------------------------------------------------------------------------

describe("validateRetrievalCalls", () => {
  // These are the assertions this eval is NAMED for, and they need only the tool-call
  // transcript. Splitting them out means a run whose report was never saved can still
  // report whether retrieval worked, instead of collapsing to a bare save failure.
  it("passes when the expected document was read before the report", () => {
    const result = validateRetrievalCalls(
      [health, read("memory-pressure"), save],
      ["memory-pressure"],
    );
    expect(result).toEqual({ passed: true, errors: [] });
  });

  it("needs no report — it is assertable even when nothing was ever saved", () => {
    const result = validateRetrievalCalls([read("memory-pressure")], ["memory-pressure"]);
    expect(result.passed).toBe(true);
  });

  it("fails when no document was read at all", () => {
    const result = validateRetrievalCalls([health, save], ["memory-pressure"]);
    expect(result.passed).toBe(false);
    expect(result.errors[0]).toMatch(/without.*reading/i);
  });

  it("fails when the read was not the matching document", () => {
    const result = validateRetrievalCalls([read("catalog-enums"), save], ["memory-pressure"]);
    expect(result.passed).toBe(false);
    expect(result.errors.join(" ")).toMatch(/none of the expected ids/);
  });

  it("is a strict subset of the full validator's errors", () => {
    // The full check must never CONTRADICT the transcript-only one.
    const calls = [read("catalog-enums"), save];
    const partial = validateRetrievalCalls(calls, ["memory-pressure"]);
    const full = validateKnowledgeRetrieval(calls, REPORT, ["memory-pressure"]);
    for (const err of partial.errors) expect(full.errors).toContain(err);
  });
});

describe("remediationTouchesService", () => {
  // Lets a scenario prove it actually exercised the service-management trigger, rather
  // than passing assertion 3 vacuously on a remediation that touches nothing.
  it("is true for a remediation that restarts something", () => {
    expect(remediationTouchesService("## Remediation\n\n1. Restart the database on node2.")).toBe(
      true,
    );
  });

  it("is true for a systemctl instruction", () => {
    expect(
      remediationTouchesService("## Remediation\n\n1. Run `systemctl start gpudb` as root."),
    ).toBe(true);
  });

  it("is false for a remediation that only changes configuration", () => {
    expect(
      remediationTouchesService("## Remediation\n\n1. Raise the RAM tier limit to 12 GB."),
    ).toBe(false);
  });

  it("is false when a restart is only narrated elsewhere in the report", () => {
    expect(
      remediationTouchesService(
        "## Timeline\n\n| 14:23 | operator issued a restart |\n\n## Remediation\n\n1. Raise the limit.",
      ),
    ).toBe(false);
  });

  it("is false when the report has no Remediation section", () => {
    expect(remediationTouchesService("## Summary\n\nRestart everything.")).toBe(false);
  });

  it("is false for the restart CAVEAT the corpus requires on every config change", () => {
    // Measured 2026-09-15: this exact parenthetical failed assertion 3 on the word
    // "restart" alone. mutation-safety.md — always inline — obliges the agent to write it.
    expect(
      remediationTouchesService(
        "## Remediation\n\n3. **Raise the RAM tier limit** " +
          "*(requires DBA approval and a DB restart to take effect)*: propose an increase " +
          "via `kinetica_alter_system_properties`.",
      ),
    ).toBe(false);
  });

  it("is false for the other ways a caveat phrases itself", () => {
    const caveats = [
      "1. Set the value; a database restart is required to realise it.",
      "1. Raise the limit — the change survives restarts.",
      "1. Lower the watermark to start background eviction earlier.",
      "1. The new value takes effect on restart.",
    ];
    for (const step of caveats) {
      expect(remediationTouchesService(`## Remediation\n\n${step}`)).toBe(false);
    }
  });

  it("is true for a `service gpudb` command", () => {
    expect(remediationTouchesService("## Remediation\n\n1. Run `service gpudb status`.")).toBe(
      true,
    );
  });

  it("is true for bringing a rank back online", () => {
    expect(remediationTouchesService("## Remediation\n\n1. Bring rank 2 back online.")).toBe(true);
  });

  it("is true for an imperative aimed at any Kinetica service object", () => {
    const instructions = [
      "1. Restart the database on host2.",
      "1. Restart gpudb as root.",
      "1. Stop the cluster, then start it again.",
      "1. Restart rank2's host.",
    ];
    for (const step of instructions) {
      expect(remediationTouchesService(`## Remediation\n\n${step}`)).toBe(true);
    }
  });
});

describe("gadminCommandLines", () => {
  it("reports a prose instruction", () => {
    expect(gadminCommandLines("1. Run gadmin restart rank 2.")).toEqual([
      "1. Run gadmin restart rank 2.",
    ]);
  });

  it("ignores a never-emit table row, which disowns itself in the row", () => {
    const row =
      "| `gadmin restart rank 2` | `gadmin` is not a service-control CLI | `systemctl restart gpudb` |";
    expect(gadminCommandLines(row)).toEqual([]);
  });

  it("ignores an explicit prohibition however it is phrased", () => {
    expect(gadminCommandLines("Never use `gadmin status`.")).toEqual([]);
    expect(gadminCommandLines("Do not run `gadmin stop`.")).toEqual([]);
    expect(gadminCommandLines("`gadmin start` cannot control the service.")).toEqual([]);
    expect(
      gadminCommandLines("Use `systemctl restart gpudb` instead of `gadmin restart`."),
    ).toEqual([]);
    expect(gadminCommandLines("❌ `gadmin start`")).toEqual([]);
  });

  it("reports a fenced command whatever the surrounding prose says", () => {
    expect(gadminCommandLines("Not recommended:\n\n```bash\ngadmin restart\n```\n")).toEqual([
      "gadmin restart",
    ]);
  });

  it("returns every offending line", () => {
    expect(gadminCommandLines("Run gadmin stop.\nThen run gadmin start.")).toHaveLength(2);
  });

  it("returns nothing for a report that never mentions gadmin", () => {
    expect(gadminCommandLines(CITED_NOT_EMITTED.replace(/gadmin[^`]*/g, "systemctl "))).toEqual([]);
  });
});
