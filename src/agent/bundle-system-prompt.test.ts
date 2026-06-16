import { describe, it, expect } from "vitest";
import { buildBundleSystemPrompt } from "./bundle-system-prompt.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { BUNDLE_TOOL_NAMES } from "../tools/bundle/index.js";
import type { Playbook, Reference } from "../types/index.js";

describe("buildBundleSystemPrompt", () => {
  it("declares offline bundle mode and read-only posture", () => {
    const prompt = buildBundleSystemPrompt("7.2.3.17");
    expect(prompt).toContain("OFFLINE BUNDLE MODE");
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("7.2.3.17");
  });

  it("renders the bundle evidence checklist (all bundle tools, no live tools)", () => {
    const prompt = buildBundleSystemPrompt();
    for (const name of BUNDLE_TOOL_NAMES) expect(prompt).toContain(name);
    expect(prompt).not.toContain("kinetica_health_check");
    expect(prompt).not.toContain("kinetica_execute_sql");
  });

  it("drops the mutation protocol and tools (read-only)", () => {
    const prompt = buildBundleSystemPrompt();
    // No mutation-proposal / verification rounds in the protocol. (The shared report
    // template placeholder may still mention "Round 5"; the protocol itself must not.)
    expect(prompt).not.toContain("Mutation Proposal");
    expect(prompt).not.toContain("Post-Mutation Verification");
    expect(prompt).not.toContain("kinetica_admin_rebalance");
    expect(prompt).not.toContain("kinetica_alter_configuration");
    expect(prompt).not.toContain("ki_catalog");
  });

  it("includes the report template", () => {
    expect(buildBundleSystemPrompt()).toContain("REPORT TEMPLATE");
  });

  it("injects playbooks and references when provided", () => {
    const playbooks: Playbook[] = [
      {
        title: "Memory Pressure",
        category: "memory",
        severity: "high",
        keywords: [],
        body: "BODY-MP",
        filename: "mp.md",
      },
    ];
    const references: Reference[] = [
      {
        title: "gpudb.conf",
        category: "config",
        keywords: [],
        body: "BODY-REF",
        filename: "conf.md",
      },
    ];
    const prompt = buildBundleSystemPrompt(undefined, playbooks, references);
    expect(prompt).toContain("Memory Pressure");
    expect(prompt).toContain("BODY-MP");
    expect(prompt).toContain("gpudb.conf");
    expect(prompt).toContain("BODY-REF");
  });

  it("falls back to a detect-the-version instruction when version is unknown", () => {
    expect(buildBundleSystemPrompt()).toContain("Unknown");
  });

  it("renders bundle-scoped references (bundle domain knowledge) when provided", () => {
    const bundleReferences: Reference[] = [
      {
        title: "Support Bundle Layout & Parsing",
        category: "bundle",
        keywords: [],
        body: "BUNDLE-DOMAIN-KNOWLEDGE",
        filename: "support-bundle.md",
      },
    ];
    const prompt = buildBundleSystemPrompt(undefined, [], [], bundleReferences);
    expect(prompt).toContain("Support Bundle Layout & Parsing");
    expect(prompt).toContain("BUNDLE-DOMAIN-KNOWLEDGE");
  });
});

describe("live system prompt is unaffected by bundle work", () => {
  it("still contains the live mutation rounds and live tools", () => {
    const live = buildSystemPrompt("7.2.3.17");
    expect(live).toContain("Round 4");
    expect(live).toContain("Round 5");
    expect(live).toContain("kinetica_health_check");
    expect(live).not.toContain("OFFLINE BUNDLE MODE");
  });

  it("omits the Support Bundle Capability section when no capability is given", () => {
    expect(buildSystemPrompt("7.2.3.17")).not.toContain("Support Bundle Capability");
  });
});

describe("live system prompt — Support Bundle Capability section", () => {
  it("describes loading a bundle when capability is 'available'", () => {
    const p = buildSystemPrompt("7.2.3.17", undefined, [], [], false, "available");
    expect(p).toContain("Support Bundle Capability");
    expect(p).toContain("kinetica_load_bundle");
    expect(p).toContain("Correlate the two");
    // Still a full live prompt (mutation rounds intact).
    expect(p).toContain("Round 4");
  });

  it("tells the agent NOT to auto-investigate after attaching a bundle", () => {
    const p = buildSystemPrompt("7.2.3.17", undefined, [], [], false, "available");
    expect(p).toContain("SETUP, not an investigation");
    expect(p).toContain("do NOT start gathering evidence");
  });

  it("describes correlating against the live system when capability is 'attached'", () => {
    const p = buildSystemPrompt("7.2.3.17", undefined, [], [], false, "attached");
    expect(p).toContain("Support Bundle Capability");
    expect(p).toContain("IS attached");
    expect(p).toContain("kinetica_bundle_list_files");
    expect(p).toContain("Round 4");
  });

  it("injects bundle-scoped references into the live prompt (parsing knowledge parity)", () => {
    // A live session with a bundle attached must receive the same bundle parsing
    // knowledge bundle-only mode gets (e.g. that min_severity=ERROR drops UERR),
    // otherwise it drives the bundle tools blind.
    const bundleReferences: Reference[] = [
      {
        title: "Support Bundle Layout & Parsing",
        category: "bundle",
        keywords: [],
        body: "SEVERITY-ORDER-UERR-NOTE",
        filename: "support-bundle.md",
      },
    ];
    const p = buildSystemPrompt("7.2.3.17", undefined, [], [], false, "attached", bundleReferences);
    expect(p).toContain("Support Bundle Layout & Parsing");
    expect(p).toContain("SEVERITY-ORDER-UERR-NOTE");
  });

  it("omits the bundle reference block when no bundle references are provided", () => {
    const p = buildSystemPrompt("7.2.3.17", undefined, [], [], false, "available", []);
    expect(p).not.toContain("Support Bundle Layout & Parsing");
  });
});
