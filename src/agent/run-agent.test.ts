/**
 * Tests for the agent loop orchestration (run-agent.ts).
 *
 * All Agent SDK and dependency calls are mocked so no real Kinetica or
 * Anthropic connections are made during these unit tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks must be declared before imports
// ---------------------------------------------------------------------------

const { MockAbortError } = vi.hoisted(() => {
  /** Minimal AbortError stub matching the SDK's exported class. */
  class MockAbortError extends Error {
    constructor(message = "aborted") {
      super(message);
      this.name = "AbortError";
    }
  }
  return { MockAbortError };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(),
  AbortError: MockAbortError,
}));

vi.mock("@inquirer/prompts", () => ({
  input: vi.fn(),
}));

vi.mock("./system-prompt.js", () => ({
  buildSystemPrompt: vi.fn().mockReturnValue("mock system prompt"),
}));

vi.mock("./discover-schemas.js", () => ({
  discoverCatalogSchemas: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./load-playbooks.js", () => ({
  loadPlaybooks: vi.fn().mockResolvedValue([]),
}));

vi.mock("./load-references.js", () => ({
  loadReferences: vi.fn().mockResolvedValue([]),
}));

const { MOCK_DIAGNOSTIC_TOOL_NAMES } = vi.hoisted(() => ({
  MOCK_DIAGNOSTIC_TOOL_NAMES: [
    "kinetica_health_check",
    "kinetica_get_metrics",
    "kinetica_cluster_status",
    "kinetica_node_details",
    "kinetica_get_logs",
    "kinetica_get_config",
    "kinetica_get_system_properties",
    "kinetica_execute_sql",
    "kinetica_explain_query",
    "kinetica_system_timing",
    "kinetica_resource_groups",
    "kinetica_verify_db",
    "kinetica_show_security",
    "kinetica_show_table",
    "kinetica_resource_objects",
  ] as const,
}));

vi.mock("../tools/index.js", () => ({
  DIAGNOSTIC_TOOL_NAMES: MOCK_DIAGNOSTIC_TOOL_NAMES,
  ALTER_TABLE_COLUMNS_TOOL_NAME: "kinetica_alter_table_columns",
  makeDiagnosticTools: vi
    .fn()
    .mockReturnValue(MOCK_DIAGNOSTIC_TOOL_NAMES.map((name: string) => ({ name }))),
  makeMutationTools: vi
    .fn()
    .mockReturnValue([
      { name: "kinetica_alter_system_properties" },
      { name: "kinetica_execute_mutation_sql" },
      { name: "kinetica_admin_rebalance" },
    ]),
  makeAlterTableColumnsToolWithDeps: vi
    .fn()
    .mockReturnValue({ name: "kinetica_alter_table_columns" }),
  createDiagnosticRegistry: vi.fn().mockReturnValue({
    isReadOnlyTool: vi.fn().mockReturnValue(true),
    tools: new Set(["kinetica_health_check"]),
  }),
}));

const { mockCanUseTool } = vi.hoisted(() => ({
  mockCanUseTool: vi.fn(),
}));
vi.mock("../approval/gate.js", () => ({
  createApprovalGate: vi.fn().mockReturnValue(mockCanUseTool),
}));

vi.mock("../report/save-report.js", () => ({
  makeSaveReportTool: vi.fn().mockReturnValue({ name: "save_report" }),
}));

const { mockHostManagerStatus, mockHostManagerAlerts } = vi.hoisted(() => ({
  mockHostManagerStatus: vi.fn().mockResolvedValue({
    ok: true,
    data: [
      { key: "version", value: "7.2.3.11" },
      { key: "system_mode", value: "run" },
    ],
  }),
  mockHostManagerAlerts: vi.fn().mockResolvedValue({
    ok: true,
    data: [],
  }),
}));
vi.mock("../tools/rest/host-manager.js", () => ({
  hostManagerStatus: mockHostManagerStatus,
  hostManagerAlerts: mockHostManagerAlerts,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { input } from "@inquirer/prompts";
import { buildSystemPrompt } from "./system-prompt.js";
import { discoverCatalogSchemas } from "./discover-schemas.js";
import {
  makeDiagnosticTools,
  createDiagnosticRegistry,
  makeMutationTools,
  DIAGNOSTIC_TOOL_NAMES,
} from "../tools/index.js";
import { makeSaveReportTool } from "../report/save-report.js";
import { createApprovalGate } from "../approval/gate.js";

import {
  runAgent,
  displayDegradedStatus,
  MCP_SERVER_NAME,
  isExitCommand,
  makeInteractivePrompt,
} from "./run-agent.js";
import { createTurnGate } from "./turn-gate.js";
import type { TurnGate } from "./turn-gate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession() {
  return {
    baseUrl: "http://localhost:9191",
    makeRequest: vi.fn(),
  } as const;
}

/** Create a mock query result (async generator) that yields given messages. */
function makeQueryResult(messages: object[]) {
  async function* gen() {
    for (const msg of messages) {
      yield msg;
    }
  }
  return gen();
}

/**
 * Build a mock SDK result message with sensible defaults.
 * Overrides are shallow-merged so tests only specify the fields they care about.
 */
function makeResultMsg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    result: "Done.",
    num_turns: 1,
    duration_ms: 5000,
    duration_api_ms: 3200,
    session_id: "sess-123",
    is_error: false,
    stop_reason: "end_turn",
    total_cost_usd: 0.01,
    permission_denials: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared runAgent test setup — used by multiple describe blocks
// ---------------------------------------------------------------------------

/**
 * Common mock wiring for any test that calls runAgent().
 * Returns captured stderr output and the mocked query function.
 */
function setupRunAgentMocks(): { stderrOutput: string[]; mockQuery: ReturnType<typeof vi.fn> } {
  vi.clearAllMocks();
  const stderrOutput: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderrOutput.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });

  const mockInput = input as ReturnType<typeof vi.fn>;
  mockInput.mockResolvedValueOnce("test issue").mockResolvedValueOnce("exit");

  vi.spyOn(process, "once").mockImplementation(() => process);

  vi.mocked(createSdkMcpServer).mockReturnValue({
    type: "sdk",
    server: {},
    name: MCP_SERVER_NAME,
  } as unknown as ReturnType<typeof createSdkMcpServer>);

  const mockQuery = query as ReturnType<typeof vi.fn>;
  mockQuery.mockReturnValue(makeQueryResult([makeResultMsg()]));

  return { stderrOutput, mockQuery };
}

// ---------------------------------------------------------------------------
// Gate helper — pre-opened gate for tests that don't test gating behavior
// ---------------------------------------------------------------------------

/** No-op spinner for tests that don't test spinner behavior. */
function makeNoOpSpinner() {
  return Object.freeze({ start: () => {}, stop: () => {}, isRunning: () => false });
}

/** Gate with no-op close — stays permanently open for non-gating tests. */
function makeOpenGate(): TurnGate {
  const gate = createTurnGate();
  gate.open();
  return Object.freeze({
    wait: gate.wait,
    open: gate.open,
    close: () => {},
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("MCP_SERVER_NAME", () => {
  it("equals kinetica-diagnostics", () => {
    expect(MCP_SERVER_NAME).toBe("kinetica-diagnostics");
  });
});

// ---------------------------------------------------------------------------
// Explicit allowedTools (diagnostic + save_report only, no mutation tools)
// ---------------------------------------------------------------------------

describe("explicit allowedTools", () => {
  it("lists diagnostic and save_report tools explicitly (no wildcard)", async () => {
    const session = makeSession();
    const mockQueryFn = query as ReturnType<typeof vi.fn>;
    mockQueryFn.mockReturnValue(makeQueryResult([makeResultMsg()]));
    const mockInputFn = input as ReturnType<typeof vi.fn>;
    mockInputFn.mockReset();
    mockInputFn.mockResolvedValueOnce("test issue").mockResolvedValueOnce("exit");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "once").mockImplementation(() => process);

    await runAgent(session);

    const options = mockQueryFn.mock.calls[0][0].options as { allowedTools: string[] };
    // Should have 15 diagnostic + 1 save_report + 1 alter_table_columns = 17 entries
    expect(options.allowedTools).toHaveLength(17);
    // All diagnostic tools must be prefixed with MCP server name
    for (const name of DIAGNOSTIC_TOOL_NAMES) {
      expect(options.allowedTools).toContain(`mcp__kinetica-diagnostics__${name}`);
    }
    // save_report must be included
    expect(options.allowedTools).toContain("mcp__kinetica-diagnostics__save_report");
    // alter_table_columns must be included (self-approving via checklist)
    expect(options.allowedTools).toContain(
      "mcp__kinetica-diagnostics__kinetica_alter_table_columns",
    );
  });

  it("does NOT include mutation tools in allowedTools", async () => {
    const session = makeSession();
    const mockQueryFn = query as ReturnType<typeof vi.fn>;
    mockQueryFn.mockReturnValue(makeQueryResult([makeResultMsg()]));
    const mockInputFn = input as ReturnType<typeof vi.fn>;
    mockInputFn.mockReset();
    mockInputFn.mockResolvedValueOnce("test issue").mockResolvedValueOnce("exit");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "once").mockImplementation(() => process);

    await runAgent(session);

    const options = mockQueryFn.mock.calls[0][0].options as { allowedTools: string[] };
    // Mutation tools must NOT appear — they must go through canUseTool approval gate
    expect(options.allowedTools).not.toContain(
      "mcp__kinetica-diagnostics__kinetica_alter_system_properties",
    );
    expect(options.allowedTools).not.toContain(
      "mcp__kinetica-diagnostics__kinetica_execute_mutation_sql",
    );
    expect(options.allowedTools).not.toContain(
      "mcp__kinetica-diagnostics__kinetica_admin_rebalance",
    );
  });

  it("does NOT use a wildcard pattern", async () => {
    const session = makeSession();
    const mockQueryFn = query as ReturnType<typeof vi.fn>;
    mockQueryFn.mockReturnValue(makeQueryResult([makeResultMsg()]));
    const mockInputFn = input as ReturnType<typeof vi.fn>;
    mockInputFn.mockReset();
    mockInputFn.mockResolvedValueOnce("test issue").mockResolvedValueOnce("exit");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "once").mockImplementation(() => process);

    await runAgent(session);

    const options = mockQueryFn.mock.calls[0][0].options as { allowedTools: string[] };
    // No wildcards — each entry must be a fully-qualified tool name
    for (const entry of options.allowedTools) {
      expect(entry).not.toContain("*");
    }
  });
});

// ---------------------------------------------------------------------------
// isExitCommand
// ---------------------------------------------------------------------------

describe("isExitCommand", () => {
  it.each(["exit", "quit", "end", "q"])('returns true for "%s"', (cmd) => {
    expect(isExitCommand(cmd)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isExitCommand("EXIT")).toBe(true);
    expect(isExitCommand("Quit")).toBe(true);
    expect(isExitCommand("Q")).toBe(true);
  });

  it("trims whitespace", () => {
    expect(isExitCommand("  exit  ")).toBe(true);
  });

  it("returns false for non-exit strings", () => {
    expect(isExitCommand("help")).toBe(false);
    expect(isExitCommand("investigate")).toBe(false);
    expect(isExitCommand("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// makeInteractivePrompt
// ---------------------------------------------------------------------------

describe("makeInteractivePrompt", () => {
  const mockInput = input as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // mockReset clears the once-queue (mockResolvedValueOnce, etc.)
    // vi.clearAllMocks only clears call history, not the queue
    mockInput.mockReset();
  });

  it("yields first user message from input", async () => {
    mockInput.mockResolvedValueOnce("slow queries on table foo");
    mockInput.mockResolvedValueOnce("exit");

    const gen = makeInteractivePrompt(new AbortController(), makeOpenGate(), makeNoOpSpinner());
    const first = await gen.next();

    expect(first.done).toBe(false);
    expect(first.value).toEqual({
      type: "user",
      message: { role: "user", content: "slow queries on table foo" },
      parent_tool_use_id: null,
      session_id: "",
    });
  });

  it.each(["exit", "quit", "end", "q"])(
    'returns done on exit command "%s" at first prompt',
    async (cmd) => {
      mockInput.mockResolvedValueOnce(cmd);

      const gen = makeInteractivePrompt(new AbortController(), makeOpenGate(), makeNoOpSpinner());
      const result = await gen.next();

      expect(result.done).toBe(true);
    },
  );

  it("exit commands are case-insensitive", async () => {
    mockInput.mockResolvedValueOnce("EXIT");

    const gen = makeInteractivePrompt(new AbortController(), makeOpenGate(), makeNoOpSpinner());
    const result = await gen.next();

    expect(result.done).toBe(true);
  });

  it("skips empty input and re-prompts", async () => {
    mockInput
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("   ")
      .mockResolvedValueOnce("actual issue");
    mockInput.mockResolvedValueOnce("exit");

    const gen = makeInteractivePrompt(new AbortController(), makeOpenGate(), makeNoOpSpinner());
    const first = await gen.next();

    expect(first.value.message.content).toBe("actual issue");
    expect(mockInput).toHaveBeenCalledTimes(3);
  });

  it("yields multiple messages before exit in subsequent turns", async () => {
    mockInput
      .mockResolvedValueOnce("first issue")
      .mockResolvedValueOnce("follow up")
      .mockResolvedValueOnce("exit");

    const gen = makeInteractivePrompt(new AbortController(), makeOpenGate(), makeNoOpSpinner());
    const first = await gen.next();
    const second = await gen.next();
    const third = await gen.next();

    expect(first.value.message.content).toBe("first issue");
    expect(second.value.message.content).toBe("follow up");
    expect(third.done).toBe(true);
  });

  it("catches input error (Ctrl+C) and returns cleanly", async () => {
    mockInput.mockRejectedValueOnce(new Error("User force closed the prompt"));

    const gen = makeInteractivePrompt(new AbortController(), makeOpenGate(), makeNoOpSpinner());
    const result = await gen.next();

    expect(result.done).toBe(true);
  });

  it("returns when abort controller is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();

    const gen = makeInteractivePrompt(ac, makeOpenGate(), makeNoOpSpinner());
    const result = await gen.next();

    expect(result.done).toBe(true);
  });

  it("uses different prompt messages for first vs subsequent turns", async () => {
    mockInput
      .mockResolvedValueOnce("issue description")
      .mockResolvedValueOnce("follow up")
      .mockResolvedValueOnce("exit");

    const gen = makeInteractivePrompt(new AbortController(), makeOpenGate(), makeNoOpSpinner());
    await gen.next(); // first turn
    await gen.next(); // second turn
    await gen.next(); // exit

    expect(mockInput).toHaveBeenNthCalledWith(1, {
      message: "Describe the issue to investigate:",
    });
    expect(mockInput).toHaveBeenNthCalledWith(2, { message: "You:" });
  });

  it("blocks subsequent turn until gate opens", async () => {
    mockInput
      .mockResolvedValueOnce("first issue")
      .mockResolvedValueOnce("follow up")
      .mockResolvedValueOnce("exit");

    const gate = createTurnGate();
    // Gate starts closed — first turn doesn't need gate (first while loop)
    const gen = makeInteractivePrompt(new AbortController(), gate, makeNoOpSpinner());

    // First yield works (first-turn loop doesn't await gate)
    const first = await gen.next();
    expect(first.value.message.content).toBe("first issue");

    // Second .next() should block because gate is closed
    let secondResolved = false;
    const secondPromise = gen.next().then((val) => {
      secondResolved = true;
      return val;
    });

    // Flush microtasks — should still be blocked
    await Promise.resolve();
    await Promise.resolve();
    expect(secondResolved).toBe(false);

    // Open gate — generator should unblock and prompt user
    gate.open();
    const second = await secondPromise;
    expect(secondResolved).toBe(true);
    expect(second.value.message.content).toBe("follow up");
  });

  it("closes gate before yielding subsequent messages", async () => {
    mockInput
      .mockResolvedValueOnce("first issue")
      .mockResolvedValueOnce("follow up")
      .mockResolvedValueOnce("exit");

    const gate = createTurnGate();
    const gen = makeInteractivePrompt(new AbortController(), gate, makeNoOpSpinner());

    // First turn
    await gen.next();

    // Open gate for second turn
    gate.open();
    await gen.next(); // "follow up"

    // Gate should be closed again after yield (generator closes before yield)
    let resolved = false;
    const waitPromise = gate.wait().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Clean up
    gate.open();
    await waitPromise;
    await gen.next(); // "exit" → done
  });

  it("exits when abort fires while waiting on gate", async () => {
    mockInput.mockResolvedValueOnce("first issue");

    const ac = new AbortController();
    const gate = createTurnGate();
    const gen = makeInteractivePrompt(ac, gate, makeNoOpSpinner());

    // First turn
    await gen.next();

    // Second .next() blocks on gate
    const resultPromise = gen.next();

    // Abort and open gate to unblock
    ac.abort();
    gate.open();

    const result = await resultPromise;
    expect(result.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runAgent
// ---------------------------------------------------------------------------

describe("runAgent", () => {
  let mockQuery: ReturnType<typeof vi.fn>;
  let mockCreateSdkMcpServer: ReturnType<typeof vi.fn>;
  let stderrOutput: string[];
  let capturedSigintHandler: (() => void) | undefined;

  beforeEach(() => {
    ({ stderrOutput, mockQuery } = setupRunAgentMocks());

    // Override default query result with richer defaults for this describe block
    mockQuery.mockReturnValue(
      makeQueryResult([makeResultMsg({ result: "Investigation complete.", num_turns: 3 })]),
    );

    // Expose mockCreateSdkMcpServer for tests that need it
    mockCreateSdkMcpServer = createSdkMcpServer as ReturnType<typeof vi.fn>;

    // Capture SIGINT handler registration — override the simple mock from setupRunAgentMocks
    capturedSigintHandler = undefined;
    vi.spyOn(process, "once").mockImplementation(
      (event: string | symbol, handler: (...args: unknown[]) => void) => {
        if (event === "SIGINT") {
          capturedSigintHandler = handler;
        }
        return process;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates MCP server with correct name", async () => {
    const session = makeSession();
    await runAgent(session);
    expect(mockCreateSdkMcpServer).toHaveBeenCalledOnce();
    const callArgs = mockCreateSdkMcpServer.mock.calls[0][0] as {
      name: string;
      version: string;
      tools: unknown[];
    };
    expect(callArgs.name).toBe("kinetica-diagnostics");
  });

  it("creates MCP server with 20 tools (15 diagnostic + 3 mutation + save_report + alter_table_columns)", async () => {
    const session = makeSession();
    await runAgent(session);
    const callArgs = mockCreateSdkMcpServer.mock.calls[0][0] as {
      name: string;
      version: string;
      tools: unknown[];
    };
    expect(callArgs.tools).toHaveLength(20);
  });

  it("calls makeMutationTools with the session", async () => {
    const session = makeSession();
    await runAgent(session);
    expect(makeMutationTools).toHaveBeenCalledWith(session);
  });

  it("calls makeDiagnosticTools with the session and catalogSchemas", async () => {
    const session = makeSession();
    await runAgent(session);
    // Called with session and undefined (default discoverCatalogSchemas mock returns undefined)
    expect(makeDiagnosticTools).toHaveBeenCalledWith(session, undefined);
  });

  it("passes discovered catalogSchemas to makeDiagnosticTools", async () => {
    const mockSchemas = { tables: new Map([["ki_query_history", ["query_id"]]]) };
    vi.mocked(discoverCatalogSchemas).mockResolvedValueOnce(mockSchemas);
    const session = makeSession();
    await runAgent(session);
    expect(makeDiagnosticTools).toHaveBeenCalledWith(session, mockSchemas);
  });

  it("calls makeSaveReportTool once", async () => {
    const session = makeSession();
    await runAgent(session);
    expect(makeSaveReportTool).toHaveBeenCalledOnce();
  });

  it("calls discoverCatalogSchemas with the session before building system prompt", async () => {
    const session = makeSession();
    await runAgent(session);
    expect(discoverCatalogSchemas).toHaveBeenCalledWith(session);
  });

  it("passes discoverCatalogSchemas result to buildSystemPrompt", async () => {
    const mockSchemas = { tables: new Map([["ki_query_history", ["query_id"]]]) };
    vi.mocked(discoverCatalogSchemas).mockResolvedValueOnce(mockSchemas);
    const session = makeSession();
    await runAgent(session);
    expect(buildSystemPrompt).toHaveBeenCalledWith(undefined, mockSchemas, [], [], undefined);
  });

  it("calls buildSystemPrompt with undefined schemas when discovery fails", async () => {
    vi.mocked(discoverCatalogSchemas).mockResolvedValueOnce(undefined);
    const session = makeSession();
    await runAgent(session);
    expect(buildSystemPrompt).toHaveBeenCalledWith(undefined, undefined, [], [], undefined);
  });

  it("passes kineticaVersion to buildSystemPrompt when provided", async () => {
    const session = makeSession();
    await runAgent(session, "7.2.3.11");
    expect(buildSystemPrompt).toHaveBeenCalledWith("7.2.3.11", undefined, [], [], undefined);
  });

  it("skips discoverCatalogSchemas when degraded is true", async () => {
    const session = makeSession();
    await runAgent(session, "7.2.3.11", true);
    expect(discoverCatalogSchemas).not.toHaveBeenCalled();
    expect(buildSystemPrompt).toHaveBeenCalledWith("7.2.3.11", undefined, [], [], true);
  });

  it("prints DEGRADED MODE welcome message with HM status when degraded", async () => {
    const stderrOutput: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrOutput.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    const session = makeSession();
    await runAgent(session, undefined, true);
    const output = stderrOutput.join("");
    expect(output).toContain("DEGRADED MODE");
    expect(output).toContain("port 9191");
    // Verify HM data was fetched and displayed
    expect(mockHostManagerStatus).toHaveBeenCalledWith(session);
    expect(mockHostManagerAlerts).toHaveBeenCalledWith(session);
    expect(output).toContain("Host Manager Status");
    expect(output).toContain("Recent Alerts");
    expect(output).toContain("system_mode");
  });

  it("does not call displayDegradedStatus when not in degraded mode", async () => {
    const session = makeSession();
    await runAgent(session);
    expect(mockHostManagerStatus).not.toHaveBeenCalled();
    expect(mockHostManagerAlerts).not.toHaveBeenCalled();
  });

  it("calls query() with systemPrompt from buildSystemPrompt", async () => {
    const session = makeSession();
    await runAgent(session);
    expect(mockQuery).toHaveBeenCalledOnce();
    const options = mockQuery.mock.calls[0][0].options as { systemPrompt: string };
    expect(options.systemPrompt).toBe("mock system prompt");
  });

  it("passes canUseTool wrapper that delegates to approval gate", async () => {
    const session = makeSession();
    await runAgent(session);
    const options = mockQuery.mock.calls[0][0].options as {
      canUseTool: (...args: unknown[]) => unknown;
    };
    // canUseTool is a wrapper (stops spinner before approval) — verify it's a function
    expect(typeof options.canUseTool).toBe("function");
    // The wrapper should delegate to the approval gate created by createApprovalGate
    expect(createApprovalGate).toHaveBeenCalledOnce();
  });

  it("creates canUseTool from diagnostic registry", async () => {
    const session = makeSession();
    await runAgent(session);
    expect(createDiagnosticRegistry).toHaveBeenCalledOnce();
    expect(createApprovalGate).toHaveBeenCalledOnce();
  });

  it("calls query() with explicit allowedTools excluding mutation tools", async () => {
    const session = makeSession();
    await runAgent(session);
    const options = mockQuery.mock.calls[0][0].options as { allowedTools: string[] };
    // 15 diagnostic + 1 save_report + 1 alter_table_columns = 17, no wildcards
    expect(options.allowedTools).toHaveLength(17);
    expect(options.allowedTools.some((t: string) => t.includes("*"))).toBe(false);
    expect(options.allowedTools.some((t: string) => t.includes("mutation"))).toBe(false);
  });

  it("calls query() with disallowedTools blocking dangerous built-in tools", async () => {
    const session = makeSession();
    await runAgent(session);
    const options = mockQuery.mock.calls[0][0].options as { disallowedTools: string[] };
    expect(options.disallowedTools).toEqual(["Bash", "Edit", "Write", "MultiEdit"]);
  });

  it("calls query() with mcpServers containing the kinetica-diagnostics server", async () => {
    const session = makeSession();
    await runAgent(session);
    const options = mockQuery.mock.calls[0][0].options as {
      mcpServers: Record<string, unknown>;
    };
    expect(options.mcpServers).toHaveProperty("kinetica-diagnostics");
  });

  it("calls query() with maxTurns set to a positive value", async () => {
    const session = makeSession();
    await runAgent(session);
    const options = mockQuery.mock.calls[0][0].options as { maxTurns: number };
    expect(options.maxTurns).toBeGreaterThan(0);
  });

  it("streams text deltas to stderr line-by-line via stream_event and aligner", async () => {
    const session = makeSession();
    mockQuery.mockReturnValue(
      makeQueryResult([
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Investigating " },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "the issue...\n" },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Checking metrics.\n" },
          },
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Investigating the issue...\nChecking metrics.\n" }],
            stop_reason: "end_turn",
          },
          session_id: "sess-123",
        },
        makeResultMsg(),
      ]),
    );
    await runAgent(session);
    const output = stderrOutput.join("");
    // Line-buffered: partial "Investigating " is held until "\n" arrives
    expect(output).toContain("Investigating the issue...");
    expect(output).toContain("Checking metrics.");
  });

  it("aligns markdown tables in streamed agent output", async () => {
    const session = makeSession();
    mockQuery.mockReturnValue(
      makeQueryResult([
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Results:\n" },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "| Name | Age |\n" },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "| --- | --- |\n" },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "| Alice | 30 |\n" },
          },
        },
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Results:\n| Name | Age |\n| --- | --- |\n| Alice | 30 |\n" },
            ],
            stop_reason: "end_turn",
          },
          session_id: "sess-123",
        },
        makeResultMsg(),
      ]),
    );
    await runAgent(session);
    const output = stderrOutput.join("");
    // Table should be aligned with box-drawing borders
    expect(output).toContain("+-------+-----+");
    expect(output).toContain("| Name  | Age |");
    expect(output).toContain("| Alice | 30  |");
  });

  it("does not re-write streamed text from assistant message blocks", async () => {
    const session = makeSession();
    mockQuery.mockReturnValue(
      makeQueryResult([
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Unique marker text" },
          },
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Unique marker text" }],
            stop_reason: "end_turn",
          },
          session_id: "sess-123",
        },
        makeResultMsg(),
      ]),
    );
    await runAgent(session);
    const output = stderrOutput.join("");
    const matches = output.match(/Unique marker text/g);
    expect(matches).toHaveLength(1);
  });

  it("adds trailing newline when streamed text does not end with one", async () => {
    const session = makeSession();
    mockQuery.mockReturnValue(
      makeQueryResult([
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "no trailing newline" },
          },
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "no trailing newline" }],
            stop_reason: "end_turn",
          },
          session_id: "sess-123",
        },
        makeResultMsg(),
      ]),
    );
    await runAgent(session);
    const output = stderrOutput.join("");
    expect(output).toContain("no trailing newline\n");
  });

  it("ignores non-text stream events (e.g. tool_use deltas)", async () => {
    const session = makeSession();
    mockQuery.mockReturnValue(
      makeQueryResult([
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "input_json_delta", partial_json: '{"key":' },
          },
        },
        makeResultMsg(),
      ]),
    );
    await runAgent(session);
    const output = stderrOutput.join("");
    expect(output).not.toContain('{"key":');
  });

  it("does not write result text on success (avoids duplicate output)", async () => {
    const session = makeSession();
    mockQuery.mockReturnValue(
      makeQueryResult([makeResultMsg({ result: "Root cause identified.", num_turns: 2 })]),
    );
    await runAgent(session);
    const output = stderrOutput.join("");
    // The result text should NOT be written separately — it's already
    // streamed via assistant message text blocks
    expect(output).not.toContain("Root cause identified.");
  });

  it("writes specific message for error_during_execution subtype", async () => {
    const session = makeSession();
    mockQuery.mockReturnValue(
      makeQueryResult([
        makeResultMsg({
          subtype: "error_during_execution",
          errors: ["Something went wrong"],
          num_turns: 5,
          is_error: true,
          stop_reason: "error",
          total_cost_usd: 0.02,
        }),
      ]),
    );
    await runAgent(session);
    const output = stderrOutput.join("");
    expect(output).toContain("Execution error");
    expect(output).toContain("unrecoverable failure");
  });

  it("writes error result to stderr for unknown error subtypes", async () => {
    const session = makeSession();
    mockQuery.mockReturnValue(
      makeQueryResult([
        makeResultMsg({
          subtype: "error_unknown_xyz",
          errors: ["Something unexpected"],
          num_turns: 5,
          is_error: true,
          stop_reason: "error",
          total_cost_usd: 0.02,
        }),
      ]),
    );
    await runAgent(session);
    const output = stderrOutput.join("");
    expect(output).toMatch(/error/i);
    expect(output).toContain("error_unknown_xyz");
  });

  it("writes specific message for error_max_turns subtype", async () => {
    const session = makeSession();
    mockQuery.mockReturnValue(
      makeQueryResult([
        makeResultMsg({
          subtype: "error_max_turns",
          errors: ["Max turns exceeded"],
          num_turns: 100,
          is_error: true,
          stop_reason: "max_turns",
          total_cost_usd: 0.05,
        }),
      ]),
    );
    await runAgent(session);
    const output = stderrOutput.join("");
    expect(output).toMatch(/turn limit/i);
  });

  it("writes specific message for error_max_budget_usd subtype", async () => {
    const session = makeSession();
    mockQuery.mockReturnValue(
      makeQueryResult([
        makeResultMsg({
          subtype: "error_max_budget_usd",
          errors: ["Budget exceeded"],
          num_turns: 50,
          is_error: true,
          stop_reason: "max_budget",
          total_cost_usd: 5.0,
        }),
      ]),
    );
    await runAgent(session);
    const output = stderrOutput.join("");
    expect(output).toMatch(/budget/i);
  });

  it("registers a SIGINT handler", async () => {
    const session = makeSession();
    await runAgent(session);
    expect(capturedSigintHandler).toBeDefined();
  });

  it("writes session summary to stderr after query completes", async () => {
    const session = makeSession();
    await runAgent(session);
    const output = stderrOutput.join("");
    expect(output).toMatch(/session|Session/i);
  });

  it("passes prompt as async iterable to query()", async () => {
    const session = makeSession();
    await runAgent(session);
    const callArgs = mockQuery.mock.calls[0][0] as { prompt: unknown };
    // The prompt must be an async iterable (has Symbol.asyncIterator)
    expect(callArgs.prompt).toBeDefined();
    expect(typeof (callArgs.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe(
      "function",
    );
  });

  it("prints welcome message before query", async () => {
    const session = makeSession();
    await runAgent(session);
    const output = stderrOutput.join("");
    expect(output).toContain("Kinetica Diagnostic Session Ready");
    expect(output).toContain("Type 'exit' to end the session.");
  });

  it("prints welcome message exactly once", async () => {
    const session = makeSession();
    await runAgent(session);
    const output = stderrOutput.join("");
    const matches = output.match(/Kinetica Diagnostic Session Ready/g);
    expect(matches).toHaveLength(1);
  });

  it("does not repeat the model name in the welcome message (banner owns it)", async () => {
    const session = makeSession();
    await runAgent(session, "7.2.3.11", false, "haiku");
    const output = stderrOutput.join("");
    // Model identity is displayed by the startup banner (cli/banner.ts),
    // not in the Session Ready block — keeps the info in one place.
    expect(output).not.toContain("Model: haiku");
    expect(output).not.toContain("Model: sonnet");
  });

  it("calls query() with persistSession: false", async () => {
    const session = makeSession();
    await runAgent(session);
    const options = mockQuery.mock.calls[0][0].options as { persistSession: boolean };
    expect(options.persistSession).toBe(false);
  });

  it("calls query() with maxBudgetUsd set to a positive number", async () => {
    const session = makeSession();
    await runAgent(session);
    const options = mockQuery.mock.calls[0][0].options as { maxBudgetUsd: number };
    expect(options.maxBudgetUsd).toBeGreaterThan(0);
  });

  it("includes cost in session summary when available", async () => {
    const session = makeSession();
    mockQuery.mockReturnValue(
      makeQueryResult([makeResultMsg({ num_turns: 3, total_cost_usd: 0.0234 })]),
    );
    await runAgent(session);
    const output = stderrOutput.join("");
    expect(output).toMatch(/\$0\.0234/);
  });

  it("warns on stderr when system init reports a failed MCP server", async () => {
    const session = makeSession();
    mockQuery.mockReturnValue(
      makeQueryResult([
        {
          type: "system",
          subtype: "init",
          mcp_servers: [
            { name: "kinetica-diagnostics", status: "error" },
            { name: "other-server", status: "connected" },
          ],
        },
        makeResultMsg(),
      ]),
    );
    await runAgent(session);
    const output = stderrOutput.join("");
    expect(output).toContain(
      'Warning: MCP server "kinetica-diagnostics" failed to connect (error)',
    );
  });

  it("does not warn when an unrelated MCP server fails to connect", async () => {
    const session = makeSession();
    mockQuery.mockReturnValue(
      makeQueryResult([
        {
          type: "system",
          subtype: "init",
          mcp_servers: [
            { name: "kinetica-diagnostics", status: "connected" },
            { name: "claude.ai Slack", status: "error" },
            { name: "claude.ai Gmail", status: "error" },
          ],
        },
        makeResultMsg(),
      ]),
    );
    await runAgent(session);
    const output = stderrOutput.join("");
    expect(output).not.toContain("Warning: MCP server");
  });

  it("does not warn when all MCP servers are connected", async () => {
    const session = makeSession();
    mockQuery.mockReturnValue(
      makeQueryResult([
        {
          type: "system",
          subtype: "init",
          mcp_servers: [{ name: "kinetica-diagnostics", status: "connected" }],
        },
        makeResultMsg(),
      ]),
    );
    await runAgent(session);
    const output = stderrOutput.join("");
    expect(output).not.toContain("Warning: MCP server");
  });

  it("handles system init with no mcp_servers field gracefully", async () => {
    const session = makeSession();
    mockQuery.mockReturnValue(
      makeQueryResult([
        {
          type: "system",
          subtype: "init",
          // no mcp_servers field
        },
        makeResultMsg(),
      ]),
    );
    await runAgent(session);
    const output = stderrOutput.join("");
    expect(output).not.toContain("Warning: MCP server");
  });

  it("uses model shorthand 'sonnet' instead of full model ID", async () => {
    const session = makeSession();
    await runAgent(session);
    const options = mockQuery.mock.calls[0][0].options as { model: string };
    expect(options.model).toBe("sonnet");
  });

  it("overrides the default model when the model argument is provided", async () => {
    const session = makeSession();
    await runAgent(session, "7.2.3.11", false, "haiku");
    const options = mockQuery.mock.calls[0][0].options as { model: string };
    expect(options.model).toBe("haiku");
  });

  it("falls back to the default model when the model argument is undefined", async () => {
    const session = makeSession();
    await runAgent(session, "7.2.3.11", false, undefined);
    const options = mockQuery.mock.calls[0][0].options as { model: string };
    expect(options.model).toBe("sonnet");
  });

  it("calls query() with thinking: adaptive for improved diagnostic reasoning", async () => {
    const session = makeSession();
    await runAgent(session);
    const options = mockQuery.mock.calls[0][0].options as { thinking: { type: string } };
    expect(options.thinking).toEqual({ type: "adaptive" });
  });

  it("calls query() with fallbackModel set to haiku", async () => {
    const session = makeSession();
    await runAgent(session);
    const options = mockQuery.mock.calls[0][0].options as { fallbackModel: string };
    expect(options.fallbackModel).toBe("haiku");
  });

  it("calls query() with CLAUDE_AGENT_SDK_CLIENT_APP in env", async () => {
    const session = makeSession();
    await runAgent(session);
    const options = mockQuery.mock.calls[0][0].options as {
      env: Record<string, string | undefined>;
    };
    expect(options.env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("admin-agent");
  });

  it("uses SDK duration_ms instead of manual timer in session summary", async () => {
    const session = makeSession();
    mockQuery.mockReturnValue(
      makeQueryResult([makeResultMsg({ duration_ms: 12345, duration_api_ms: 8000 })]),
    );
    await runAgent(session);
    const output = stderrOutput.join("");
    // 12345ms → 12s, API percentage = 8000/12345 ≈ 65%
    expect(output).toContain("Duration: 12s");
    expect(output).toContain("65% API");
  });

  it("logs permission denials from SDK result when present", async () => {
    const session = makeSession();
    mockQuery.mockReturnValue(
      makeQueryResult([
        makeResultMsg({
          permission_denials: [
            { tool_name: "Bash", tool_use_id: "tu-1", tool_input: {} },
            { tool_name: "Edit", tool_use_id: "tu-2", tool_input: {} },
          ],
        }),
      ]),
    );
    await runAgent(session);
    const output = stderrOutput.join("");
    expect(output).toContain("Permission denials: Bash, Edit");
  });

  it("logs cache-token telemetry in DEBUG mode, summed across models", async () => {
    const prevDebug = process.env.DEBUG;
    process.env.DEBUG = "1";
    try {
      const session = makeSession();
      mockQuery.mockReturnValue(
        makeQueryResult([
          makeResultMsg({
            modelUsage: {
              "claude-sonnet": { cacheReadInputTokens: 1000, cacheCreationInputTokens: 500 },
              "claude-haiku": { cacheReadInputTokens: 234, cacheCreationInputTokens: 67 },
            },
          }),
        ]),
      );
      await runAgent(session);
      const output = stderrOutput.join("");
      // 1000 + 234 read, 500 + 67 created — a non-zero read count confirms caching.
      expect(output).toContain("cache: 1234 read / 567 created");
    } finally {
      if (prevDebug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = prevDebug;
    }
  });

  it("omits cache telemetry when DEBUG is unset even if cache reads occurred", async () => {
    const prevDebug = process.env.DEBUG;
    delete process.env.DEBUG;
    try {
      const session = makeSession();
      mockQuery.mockReturnValue(
        makeQueryResult([
          makeResultMsg({
            modelUsage: {
              "claude-sonnet": { cacheReadInputTokens: 1000, cacheCreationInputTokens: 500 },
            },
          }),
        ]),
      );
      await runAgent(session);
      const output = stderrOutput.join("");
      expect(output).not.toContain("cache:");
    } finally {
      if (prevDebug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = prevDebug;
    }
  });

  it("does not throw and still writes the summary when modelUsage is absent", async () => {
    const session = makeSession();
    // makeResultMsg omits modelUsage by default — the guard must degrade to zero tokens.
    mockQuery.mockReturnValue(makeQueryResult([makeResultMsg({ num_turns: 7 })]));
    await expect(runAgent(session)).resolves.not.toThrow();
    expect(stderrOutput.join("")).toContain("Turns: 7");
  });

  it("does not log permission denials when none occurred", async () => {
    const session = makeSession();
    mockQuery.mockReturnValue(makeQueryResult([makeResultMsg({ permission_denials: [] })]));
    await runAgent(session);
    const output = stderrOutput.join("");
    expect(output).not.toContain("Permission denials");
  });

  it("includes token count in compact_boundary message from SDK metadata", async () => {
    const session = makeSession();
    mockQuery.mockReturnValue(
      makeQueryResult([
        {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 95000 },
        },
        makeResultMsg(),
      ]),
    );
    await runAgent(session);
    const output = stderrOutput.join("");
    expect(output).toContain("95000 tokens before compaction");
    expect(output).toContain("investigation continues");
  });

  it("warns on stderr when rate limit status is allowed_warning", async () => {
    const session = makeSession();
    mockQuery.mockReturnValue(
      makeQueryResult([
        {
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed_warning" },
          uuid: "uuid-1",
          session_id: "sess-123",
        },
        makeResultMsg(),
      ]),
    );
    await runAgent(session);
    const output = stderrOutput.join("");
    expect(output).toContain("Approaching rate limit");
  });

  it("warns on stderr when rate limit status is rejected", async () => {
    const session = makeSession();
    mockQuery.mockReturnValue(
      makeQueryResult([
        {
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", resetsAt: 1711000000 },
          uuid: "uuid-2",
          session_id: "sess-123",
        },
        makeResultMsg(),
      ]),
    );
    await runAgent(session);
    const output = stderrOutput.join("");
    expect(output).toContain("Rate limited");
    expect(output).toContain("Resets at");
  });

  it("does not warn when rate limit status is allowed", async () => {
    const session = makeSession();
    mockQuery.mockReturnValue(
      makeQueryResult([
        {
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed" },
          uuid: "uuid-3",
          session_id: "sess-123",
        },
        makeResultMsg(),
      ]),
    );
    await runAgent(session);
    const output = stderrOutput.join("");
    expect(output).not.toContain("rate limit");
    expect(output).not.toContain("Rate limited");
  });
});

// ---------------------------------------------------------------------------
// displayDegradedStatus
// ---------------------------------------------------------------------------

describe("displayDegradedStatus", () => {
  let stderrOutput: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    stderrOutput = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrOutput.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("displays host manager status key-value pairs", async () => {
    mockHostManagerStatus.mockResolvedValueOnce({
      ok: true,
      data: [
        { key: "version", value: "7.2.3.11" },
        { key: "system_mode", value: "run" },
        { key: "hostname", value: "host1" },
      ],
    });
    mockHostManagerAlerts.mockResolvedValueOnce({ ok: true, data: [] });

    await displayDegradedStatus(makeSession());
    const output = stderrOutput.join("");

    expect(output).toContain("Host Manager Status");
    expect(output).toContain("version");
    expect(output).toContain("7.2.3.11");
    expect(output).toContain("system_mode");
    expect(output).toContain("run");
    expect(output).toContain("hostname");
    expect(output).toContain("host1");
  });

  it("displays 'No recent alerts' when alerts array is empty", async () => {
    mockHostManagerStatus.mockResolvedValueOnce({ ok: true, data: [] });
    mockHostManagerAlerts.mockResolvedValueOnce({ ok: true, data: [] });

    await displayDegradedStatus(makeSession());
    const output = stderrOutput.join("");

    expect(output).toContain("Recent Alerts");
    expect(output).toContain("No recent alerts");
  });

  it("displays alert entries when alerts exist", async () => {
    mockHostManagerStatus.mockResolvedValueOnce({ ok: true, data: [] });
    mockHostManagerAlerts.mockResolvedValueOnce({
      ok: true,
      data: [{ timestamp: "2026-03-24 10:00:00", type: "System", params: "CPU high" }],
    });

    await displayDegradedStatus(makeSession());
    const output = stderrOutput.join("");

    expect(output).toContain("2026-03-24 10:00:00");
    expect(output).toContain("System");
    expect(output).toContain("CPU high");
  });

  it("shows error message when status fetch fails", async () => {
    mockHostManagerStatus.mockResolvedValueOnce({
      ok: false,
      status: 0,
      error: "Connection refused",
      raw: "",
    });
    mockHostManagerAlerts.mockResolvedValueOnce({ ok: true, data: [] });

    await displayDegradedStatus(makeSession());
    const output = stderrOutput.join("");

    expect(output).toContain("Connection refused");
  });

  it("shows unavailable message when alerts fetch fails", async () => {
    mockHostManagerStatus.mockResolvedValueOnce({ ok: true, data: [] });
    mockHostManagerAlerts.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "HTTP 404",
      raw: "",
    });

    await displayDegradedStatus(makeSession());
    const output = stderrOutput.join("");

    expect(output).toContain("Unavailable");
    expect(output).toContain("HTTP 404");
  });

  it("calls both HM endpoints in parallel", async () => {
    const callOrder: string[] = [];
    mockHostManagerStatus.mockImplementation(async () => {
      callOrder.push("status-start");
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push("status-end");
      return { ok: true, data: [] };
    });
    mockHostManagerAlerts.mockImplementation(async () => {
      callOrder.push("alerts-start");
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push("alerts-end");
      return { ok: true, data: [] };
    });

    await displayDegradedStatus(makeSession());

    // Both should start before either finishes (parallel via Promise.all)
    expect(callOrder[0]).toBe("status-start");
    expect(callOrder[1]).toBe("alerts-start");
  });
});

// ---------------------------------------------------------------------------
// OAuth integration
// ---------------------------------------------------------------------------

describe("runAgent — OAuth integration", () => {
  let stderrOutput: string[];
  let mockQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ stderrOutput, mockQuery } = setupRunAgentMocks());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs control_request with claude_authenticate subtype", async () => {
    mockQuery.mockReturnValue(
      makeQueryResult([
        {
          type: "control_request",
          request_id: "req-1",
          request: { subtype: "claude_authenticate" },
        },
        makeResultMsg(),
      ]),
    );
    await runAgent(makeSession());
    const output = stderrOutput.join("");
    expect(output).toContain("Re-authentication requested");
  });
});

// ---------------------------------------------------------------------------
// Error handling — try/catch/finally around the for-await loop
// ---------------------------------------------------------------------------

describe("runAgent — error handling", () => {
  let mockQuery: ReturnType<typeof vi.fn>;
  let stderrOutput: string[];

  beforeEach(() => {
    ({ stderrOutput, mockQuery } = setupRunAgentMocks());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("displays error message when iterator throws a generic Error", async () => {
    async function* throwingGen() {
      throw new Error("Connection refused");
    }
    mockQuery.mockReturnValue(throwingGen());
    await runAgent(makeSession());
    const output = stderrOutput.join("");
    expect(output).toContain("Agent error: Connection refused");
  });

  it("prints session summary even when iterator throws", async () => {
    async function* throwingGen() {
      throw new Error("Network timeout");
    }
    mockQuery.mockReturnValue(throwingGen());
    await runAgent(makeSession());
    const output = stderrOutput.join("");
    expect(output).toContain("Session ended due to error");
  });

  it("suppresses error message when AbortError is thrown (Ctrl+C)", async () => {
    async function* abortGen() {
      throw new MockAbortError("aborted");
    }
    mockQuery.mockReturnValue(abortGen());
    await runAgent(makeSession());
    const output = stderrOutput.join("");
    expect(output).not.toContain("Agent error");
    // Session summary should use normal format (not "due to error")
    expect(output).toContain("Session ended.");
    expect(output).not.toContain("Session ended due to error");
  });

  it("flushes partial streamed content when iterator throws mid-stream", async () => {
    async function* streamThenThrow() {
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "partial diagnostic" },
        },
      };
      throw new Error("Interrupted");
    }
    mockQuery.mockReturnValue(streamThenThrow());
    await runAgent(makeSession());
    const output = stderrOutput.join("");
    expect(output).toContain("partial diagnostic");
    expect(output).toContain("Interrupted");
  });

  it("does not hang — resolves even when iterator throws (turnGate unblocked)", async () => {
    async function* throwingGen() {
      throw new Error("API error");
    }
    mockQuery.mockReturnValue(throwingGen());
    // If turnGate is not opened in finally, this would hang forever
    await runAgent(makeSession());
    // Reaching here proves the gate was unblocked
  });

  it("displays yellow warning when SDKAssistantMessage has error field", async () => {
    mockQuery.mockReturnValue(
      makeQueryResult([
        {
          type: "assistant",
          message: { content: [], stop_reason: null },
          error: "server_error",
          uuid: "uuid-1",
          session_id: "sess-123",
        },
        makeResultMsg(),
      ]),
    );
    await runAgent(makeSession());
    const output = stderrOutput.join("");
    expect(output).toContain("API error: Anthropic API server error");
  });

  it("displays user-friendly label for authentication_failed error", async () => {
    mockQuery.mockReturnValue(
      makeQueryResult([
        {
          type: "assistant",
          message: { content: [], stop_reason: null },
          error: "authentication_failed",
          uuid: "uuid-1",
          session_id: "sess-123",
        },
        makeResultMsg(),
      ]),
    );
    await runAgent(makeSession());
    const output = stderrOutput.join("");
    expect(output).toContain("Authentication failed");
    expect(output).toContain("--login");
  });

  it("displays api_retry system message with HTTP status and attempt count", async () => {
    mockQuery.mockReturnValue(
      makeQueryResult([
        {
          type: "system",
          subtype: "api_retry",
          attempt: 2,
          max_retries: 3,
          retry_delay_ms: 5000,
          error_status: 529,
          error: "server_error",
          uuid: "uuid-1",
          session_id: "sess-123",
        },
        makeResultMsg(),
      ]),
    );
    await runAgent(makeSession());
    const output = stderrOutput.join("");
    expect(output).toContain("HTTP 529");
    expect(output).toContain("attempt 2/3");
    expect(output).toContain("5s");
  });

  it("displays api_retry without HTTP status when error_status is null", async () => {
    mockQuery.mockReturnValue(
      makeQueryResult([
        {
          type: "system",
          subtype: "api_retry",
          attempt: 1,
          max_retries: 3,
          retry_delay_ms: 2000,
          error_status: null,
          error: "server_error",
          uuid: "uuid-2",
          session_id: "sess-123",
        },
        makeResultMsg(),
      ]),
    );
    await runAgent(makeSession());
    const output = stderrOutput.join("");
    expect(output).toContain("attempt 1/3");
    expect(output).not.toContain("HTTP");
  });
});
