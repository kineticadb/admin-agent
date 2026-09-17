/**
 * End-to-end check of the approval decision, against the REAL registry and gate.
 *
 * Context (2026-09-16). `allowedTools` used to list the same tools the approval
 * registry marks read-only. That was a second, independent copy of the decision —
 * and the SDK applies it FIRST, auto-approving the tool before `canUseTool` runs
 * (SDK 0.3.x reports this as CLAUDE_SDK_CAN_USE_TOOL_SHADOWED). Two effects:
 *
 *   1. The gate's read-only path was effectively dead for live tools, so a latent
 *      bug hid there — the registry is keyed on BARE names while the gate is handed
 *      QUALIFIED ones, so every lookup missed. Trimming the allow-list without
 *      fixing that would have prompted the operator for 16 read-only diagnostics.
 *   2. The registry's default-deny was not a real backstop: a mutation tool added
 *      to `allowedTools` would never have reached the gate at all.
 *
 * `allowedTools` is now empty and the registry is the single declaration. These
 * tests assert the PROPERTY that matters — reads never prompt, writes always do —
 * through the same composition `runAgent` builds, so they cannot pass against a
 * reimplementation that drifted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../output/themed-prompts.js", () => ({ input: vi.fn() }));

import { input } from "../output/themed-prompts.js";
import { createApprovalGate } from "../approval/gate.js";
import { buildApprovalRegistry, unqualifyToolName, MCP_SERVER_NAME } from "./run-agent.js";
import {
  DIAGNOSTIC_TOOL_NAMES,
  MUTATION_TOOL_NAMES,
  ALTER_TABLE_COLUMNS_TOOL_NAME,
} from "../tools/index.js";

const mockInput = vi.mocked(input);
const qualify = (name: string): string => `mcp__${MCP_SERVER_NAME}__${name}`;

/** The gate exactly as runAgent composes it. */
const registry = buildApprovalRegistry(true);
const gate = createApprovalGate((name) => registry.isReadOnlyTool(unqualifyToolName(name)));

const options = {
  signal: new AbortController().signal,
  toolUseID: "tu_1",
  agentID: "agent",
  requestId: "req_1",
};

describe("unqualifyToolName", () => {
  it("strips the MCP prefix the SDK adds", () => {
    expect(unqualifyToolName(qualify("kinetica_health_check"))).toBe("kinetica_health_check");
  });

  it("leaves an already-bare name alone", () => {
    expect(unqualifyToolName("save_report")).toBe("save_report");
  });

  it("does not mangle the name the way formatToolName would", () => {
    // formatToolName also strips `kinetica_` and rewrites underscores, which would
    // never match a registry key.
    expect(unqualifyToolName(qualify("kinetica_get_metrics"))).toBe("kinetica_get_metrics");
  });
});

describe("read-only tools are approved without prompting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  const readOnly = [
    ...DIAGNOSTIC_TOOL_NAMES,
    "save_report",
    // confirm_save_report IS the operator's save question. Gating it would prompt
    // for permission to ask a question, and save_report gates itself on the consent
    // token that answer records (report/save-consent.ts).
    "confirm_save_report",
    "kinetica_knowledge_read",
    ALTER_TABLE_COLUMNS_TOOL_NAME,
  ];

  it.each(readOnly)("%s is auto-allowed and never prompts", async (name) => {
    const result = await gate(qualify(name), {}, options);
    expect(result.behavior).toBe("allow");
    expect(mockInput).not.toHaveBeenCalled();
  });
});

describe("mutation tools still reach the operator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it.each(MUTATION_TOOL_NAMES)("%s prompts before running", async (name) => {
    mockInput.mockResolvedValueOnce("n");
    const result = await gate(qualify(name), {}, options);
    expect(mockInput).toHaveBeenCalledTimes(1);
    expect(result.behavior).toBe("deny");
  });

  it("denies an unknown tool by default", async () => {
    mockInput.mockResolvedValueOnce("n");
    const result = await gate(qualify("kinetica_some_future_write"), {}, options);
    expect(result.behavior).toBe("deny");
  });

  it("never marks a mutation tool read-only in the registry", () => {
    expect(MUTATION_TOOL_NAMES.filter((n) => registry.isReadOnlyTool(n))).toEqual([]);
  });
});
