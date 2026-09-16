/**
 * Tests for the transcript readers. These keep the eval harness's own diagnostics
 * covered by the fast suite, per src/evals/README.md.
 */

import { describe, it, expect } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  isEndTurn,
  consumeTranscript,
  collectToolCalls,
  assistantText,
  cacheReadTokens,
  mcpInitFailures,
  readOutcome,
  diagnoseEmptyRun,
} from "./transcript.js";

const assistant = (content: unknown): SDKMessage =>
  ({ type: "assistant", message: { content } }) as unknown as SDKMessage;

const result = (over: Record<string, unknown> = {}): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 6,
    total_cost_usd: 0.04,
    ...over,
  }) as unknown as SDKMessage;

describe("collectToolCalls", () => {
  it("collects tool_use blocks in order", () => {
    const msg = assistant([
      { type: "text", text: "thinking" },
      { type: "tool_use", name: "a", input: { x: 1 } },
      { type: "tool_use", name: "b", input: {} },
    ]);
    expect(collectToolCalls(msg)).toEqual([
      { name: "a", input: { x: 1 } },
      { name: "b", input: {} },
    ]);
  });

  it("returns nothing for a non-assistant message", () => {
    expect(collectToolCalls(result())).toEqual([]);
  });

  it("tolerates a missing or non-array content field", () => {
    expect(collectToolCalls(assistant(undefined))).toEqual([]);
    expect(collectToolCalls(assistant("not an array"))).toEqual([]);
  });

  it("tolerates a tool_use block with no input", () => {
    expect(collectToolCalls(assistant([{ type: "tool_use", name: "a" }]))).toEqual([
      { name: "a", input: {} },
    ]);
  });
});

describe("assistantText", () => {
  it("joins the text blocks", () => {
    expect(assistantText(assistant([{ type: "text", text: "hello" }]))).toBe("hello");
  });

  it("returns an empty string when the message is all tool calls", () => {
    expect(assistantText(assistant([{ type: "tool_use", name: "a", input: {} }]))).toBe("");
  });
});

describe("cacheReadTokens", () => {
  it("reads the SDK's cache_read_input_tokens", () => {
    const msg = {
      type: "assistant",
      message: { content: [], usage: { cache_read_input_tokens: 900 } },
    } as unknown as SDKMessage;
    expect(cacheReadTokens(msg)).toBe(900);
  });

  it("degrades to 0 when usage is absent", () => {
    expect(cacheReadTokens(assistant([]))).toBe(0);
  });
});

/** An assistant message that stopped for a given reason. */
const stopped = (stopReason: string): SDKMessage =>
  ({
    type: "assistant",
    message: { content: [], stop_reason: stopReason },
  }) as unknown as SDKMessage;

describe("isEndTurn", () => {
  it("is true only for an assistant message that ended its turn", () => {
    expect(isEndTurn(stopped("end_turn"))).toBe(true);
    expect(isEndTurn(stopped("tool_use"))).toBe(false);
    expect(isEndTurn(stopped("max_tokens"))).toBe(false);
  });

  it("is false for non-assistant messages", () => {
    expect(isEndTurn({ type: "result" } as unknown as SDKMessage)).toBe(false);
    expect(isEndTurn({ type: "system" } as unknown as SDKMessage)).toBe(false);
  });

  it("tolerates a malformed message", () => {
    expect(isEndTurn({ type: "assistant" } as unknown as SDKMessage)).toBe(false);
    expect(isEndTurn({ type: "assistant", message: null } as unknown as SDKMessage)).toBe(false);
  });
});

describe("mcpInitFailures", () => {
  const init = (servers: unknown): SDKMessage =>
    ({ type: "system", subtype: "init", mcp_servers: servers }) as unknown as SDKMessage;

  const OURS = "kinetica-diagnostics";

  it("names OUR server when it fails to connect", () => {
    expect(mcpInitFailures(init([{ name: OURS, status: "failed" }]), OURS)).toEqual([
      "kinetica-diagnostics (failed)",
    ]);
  });

  it("ignores servers that are not ours", () => {
    // The init message lists the OPERATOR's ambient claude.ai connectors, which sit at
    // needs-auth as their normal resting state and have nothing to do with the eval.
    // Reporting them turned a healthy run into a HARNESS FAILURE — run-agent.ts filters
    // on its own server name for exactly this reason.
    expect(
      mcpInitFailures(
        init([
          { name: OURS, status: "connected" },
          { name: "claude.ai Gmail", status: "needs-auth" },
          { name: "claude.ai Slack", status: "needs-auth" },
          { name: "claude.ai Docusign", status: "failed" },
        ]),
        OURS,
      ),
    ).toEqual([]);
  });

  it("reports ours even when ambient connectors are also unhealthy", () => {
    expect(
      mcpInitFailures(
        init([
          { name: OURS, status: "failed" },
          { name: "claude.ai Gmail", status: "needs-auth" },
        ]),
        OURS,
      ),
    ).toEqual(["kinetica-diagnostics (failed)"]);
  });

  it("returns nothing when our server connected", () => {
    expect(mcpInitFailures(init([{ name: OURS, status: "connected" }]), OURS)).toEqual([]);
  });

  it("ignores non-init system messages", () => {
    const msg = { type: "system", subtype: "api_retry" } as unknown as SDKMessage;
    expect(mcpInitFailures(msg, OURS)).toEqual([]);
  });
});

describe("readOutcome", () => {
  it("reads a successful result", () => {
    expect(readOutcome(result())).toEqual({
      subtype: "success",
      isError: false,
      numTurns: 6,
      costUsd: 0.04,
      detail: "",
    });
  });

  it("reads an error result with its detail", () => {
    const outcome = readOutcome(
      result({ subtype: "error_during_execution", is_error: true, result: "401 unauthorized" }),
    );
    expect(outcome?.isError).toBe(true);
    expect(outcome?.detail).toBe("401 unauthorized");
  });

  it("treats a non-success subtype as an error when is_error is absent", () => {
    const outcome = readOutcome(result({ subtype: "error_max_turns", is_error: undefined }));
    expect(outcome?.isError).toBe(true);
  });

  it("returns undefined for a non-result message", () => {
    expect(readOutcome(assistant([]))).toBeUndefined();
  });
});

describe("diagnoseEmptyRun", () => {
  const ok = { subtype: "success", isError: false, numTurns: 6, costUsd: 0.04, detail: "" };

  it("says nothing when the run looks assertable", () => {
    expect(diagnoseEmptyRun(ok, [{ name: "a", input: {} }], [])).toBe("");
  });

  it("reports a missing result message", () => {
    expect(diagnoseEmptyRun(undefined, [], [])).toMatch(/without a result message/);
  });

  it("reports an error result as a harness failure, not a regression", () => {
    const msg = diagnoseEmptyRun(
      { ...ok, subtype: "error_during_execution", isError: true, detail: "boom" },
      [],
      [],
    );
    expect(msg).toMatch(/error_during_execution/);
    expect(msg).toMatch(/boom/);
    expect(msg).toMatch(/not a model regression/);
  });

  it("reports an MCP server that never connected", () => {
    expect(diagnoseEmptyRun(ok, [], ["kinetica-diagnostics (failed)"])).toMatch(/did not connect/);
  });

  it("reports the shape an unreachable API produces: 1 turn, no tools, $0", () => {
    // Measured with an invalid ANTHROPIC_API_KEY — previously indistinguishable from
    // "the model chose not to use its tools".
    const msg = diagnoseEmptyRun({ ...ok, numTurns: 1, costUsd: 0 }, [], []);
    expect(msg).toMatch(/never reached the model/);
    expect(msg).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("does NOT blame the API when the agent really did work and used no tools", () => {
    expect(diagnoseEmptyRun({ ...ok, numTurns: 4, costUsd: 0.02 }, [], [])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// consumeTranscript — the loop that had two bugs
// ---------------------------------------------------------------------------

describe("consumeTranscript", () => {
  const stream = (messages: readonly SDKMessage[]): AsyncIterable<SDKMessage> => ({
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m;
    },
  });

  const toolCall = (name: string): SDKMessage => assistant([{ type: "tool_use", name, input: {} }]);

  it("does NOT stop at the first result — the conversation continues after one", async () => {
    // The bug this pins: a result arrives at the end of EACH agent turn. Breaking there
    // abandoned the stream exactly when the agent had asked whether to save, so the
    // operator's answer went to a stream nobody was reading.
    const summary = await consumeTranscript(
      stream([
        toolCall("first_turn_tool"),
        result({ num_turns: 10 }),
        toolCall("save_report"),
        result({ num_turns: 12, total_cost_usd: 0.09 }),
      ]),
      () => {},
      "srv",
    );
    expect(summary.calls.map((c) => c.name)).toEqual(["first_turn_tool", "save_report"]);
    expect(summary.resultCount).toBe(2);
    expect(summary.outcome?.numTurns).toBe(12);
    expect(summary.outcome?.costUsd).toBe(0.09);
  });

  it("sums turns and cost across turn groups, not just the last one", async () => {
    // `outcome` carries only the FINAL group's figures. A live run that investigated for
    // 30 turns and then saved in 4 reported "Turns: 4", which badly understates the work.
    const summary = await consumeTranscript(
      stream([
        toolCall("a"),
        result({ num_turns: 30, total_cost_usd: 0.4 }),
        toolCall("save_report"),
        result({ num_turns: 4, total_cost_usd: 0.05 }),
      ]),
      () => {},
      "srv",
    );
    expect(summary.totalTurns).toBe(34);
    expect(summary.totalCostUsd).toBeCloseTo(0.45);
    expect(summary.outcome?.numTurns).toBe(4);
  });

  it("signals the caller on end_turn AND on a result, as run-agent does", async () => {
    let opened = 0;
    await consumeTranscript(
      stream([toolCall("t"), stopped("end_turn"), result()]),
      () => {
        opened += 1;
      },
      "srv",
    );
    // A tool_use message must not release the generator — the agent is still working.
    expect(opened).toBe(2);
  });

  it("collects failures, cache reads and the agent's last words", async () => {
    const init = {
      type: "system",
      subtype: "init",
      mcp_servers: [{ name: "srv", status: "failed" }],
    } as unknown as SDKMessage;
    const usage = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "all done" }],
        usage: { cache_read_input_tokens: 5 },
      },
    } as unknown as SDKMessage;

    const summary = await consumeTranscript(stream([init, usage, result()]), () => {}, "srv");
    expect(summary.initFailures).toEqual(["srv (failed)"]);
    expect(summary.cacheReads).toBe(5);
    expect(summary.lastText).toBe("all done");
  });

  it("reports no outcome when the stream carried no result", async () => {
    const summary = await consumeTranscript(stream([toolCall("t")]), () => {}, "srv");
    expect(summary.outcome).toBeUndefined();
    expect(summary.resultCount).toBe(0);
  });
});
