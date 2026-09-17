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

  /**
   * Both prompts carry the save-consent protocol, so both are pinned. Written inline
   * in two builders, a shared rule drifts on the commit that adds it -- that is
   * exactly what happened to the One Time Axis section (see CLAUDE.md, System Prompt),
   * where two tests each pinned a different variant and locked the divergence in.
   */
  describe("post-report save consent", () => {
    const postReport = (): string => {
      const prompt = buildBundleSystemPrompt();
      const start = prompt.indexOf("## Post-Report Behavior");
      expect(start).toBeGreaterThan(-1);
      const end = prompt.indexOf("\n---", start);
      return prompt.slice(start, end === -1 ? undefined : end);
    };

    it("routes the save question through confirm_save_report", () => {
      expect(postReport()).toContain("confirm_save_report");
    });

    it("forbids asking about saving in prose or ending the turn to wait", () => {
      expect(postReport()).toMatch(/never ask .{0,40}in prose|do not ask .{0,40}in prose/i);
      expect(postReport()).toMatch(/never end your turn|do not end your turn/i);
    });

    it("keeps the partial-checkpoint exception", () => {
      expect(postReport()).toMatch(/partial/i);
    });

    it("no longer tells the agent to ask a yes/no question and stop", () => {
      expect(postReport()).not.toMatch(/\(yes\/no\)/i);
    });
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
    // Playbooks and general references are on-demand here: the prompt carries a card
    // for each and the body arrives through kinetica_knowledge_read. Bundle-scoped
    // references are the exception and stay inline — see the test below.
    expect(prompt).toContain("Memory Pressure");
    expect(prompt).toContain("gpudb.conf");
    expect(prompt).toContain("kinetica_knowledge_read");
    expect(prompt).not.toContain("BODY-MP");
    expect(prompt).not.toContain("BODY-REF");
  });

  it("renders playbooks and general references in full when marked inline", () => {
    const playbooks: Playbook[] = [
      {
        title: "Memory Pressure",
        category: "memory",
        severity: "high",
        keywords: [],
        body: "BODY-MP",
        filename: "mp.md",
        disclosure: "inline",
      },
    ];
    const references: Reference[] = [
      {
        title: "gpudb.conf",
        category: "config",
        keywords: [],
        body: "BODY-REF",
        filename: "conf.md",
        disclosure: "inline",
      },
    ];
    const prompt = buildBundleSystemPrompt(undefined, playbooks, references);
    expect(prompt).toContain("BODY-MP");
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

  it("keeps bundle parsing knowledge to a CARD when a bundle is merely 'available'", () => {
    // The mirror of the parity test above, and the reason the two differ: with a bundle
    // attached the document is the session's subject, so a guaranteed read is pure
    // latency; with none attached those same ~2.6k tokens are dead weight. The read is
    // not lost — kinetica_load_bundle's result note instructs it at the moment of attach.
    const bundleReferences: Reference[] = [
      {
        title: "Support Bundle Layout & Parsing",
        category: "bundle",
        keywords: [],
        summary: "Bundle layout and log-line formats.",
        readWhen: "Immediately after a bundle is attached.",
        body: "SEVERITY-ORDER-UERR-NOTE",
        filename: "support-bundle.md",
      },
    ];
    const p = buildSystemPrompt(
      "7.2.3.17",
      undefined,
      [],
      [],
      false,
      "available",
      bundleReferences,
    );
    expect(p).toContain("| support-bundle |");
    expect(p).not.toContain("SEVERITY-ORDER-UERR-NOTE");
    expect(p).toContain("read `support-bundle` with `kinetica_knowledge_read`");
  });

  it("omits the bundle reference block when no bundle references are provided", () => {
    const p = buildSystemPrompt("7.2.3.17", undefined, [], [], false, "available", []);
    expect(p).not.toContain("Support Bundle Layout & Parsing");
  });
});

describe("bundle prompt — one time axis rule", () => {
  it("wires in the shared One Time Axis section, scoped to the bundle's clocks", () => {
    const prompt = buildBundleSystemPrompt();
    expect(prompt).toContain("### One Time Axis");
    expect(prompt).toMatch(/logs-local/);
    // No live connection here, so the live-alert clock must not be advertised.
    expect(prompt).not.toContain("kinetica_cluster_status");
  });
});

describe("bundle-only prompt — reference sections are distinguishable", () => {
  it("gives bundle parsing knowledge its own heading, separate from the card table", () => {
    // The two blocks take different tiers here: bundle references inline (the bundle is
    // the session's subject), general references as cards. One shared heading would read
    // as the second superseding the first.
    const bundleReferences: Reference[] = [
      {
        title: "Support Bundle Layout & Parsing",
        category: "bundle",
        keywords: [],
        body: "BUNDLE-DOMAIN-KNOWLEDGE",
        filename: "support-bundle.md",
      },
    ];
    const references: Reference[] = [
      {
        title: "gpudb.conf",
        category: "config",
        keywords: [],
        summary: "Master config file.",
        readWhen: "Before interpreting any property.",
        body: "BODY-REF",
        filename: "gpudb-conf.md",
      },
    ];
    const prompt = buildBundleSystemPrompt(undefined, [], references, bundleReferences);
    expect(prompt).toContain("### Bundle Parsing Knowledge");
    expect(prompt).toContain("BUNDLE-DOMAIN-KNOWLEDGE");
    expect(prompt).toContain("### Reference Knowledge");
    expect(prompt).toContain("| gpudb-conf |");
    expect(prompt).not.toContain("BODY-REF");
    expect(prompt.indexOf("### Bundle Parsing Knowledge")).toBeLessThan(
      prompt.indexOf("### Reference Knowledge"),
    );
  });
});
