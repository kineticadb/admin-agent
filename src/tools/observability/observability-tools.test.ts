import { describe, it, expect, vi } from "vitest";

import {
  makeObservabilityTools,
  OBSERVABILITY_TOOL_NAMES,
  createObservabilityRegistry,
} from "./index.js";
import { OBSERVABILITY_TOOL_CATALOG } from "./catalog.js";
import type { ObservabilityClient } from "../../observability/ObservabilityClient.js";

type Handler = (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>;
type ToolObject = { name: string; handler: Handler };

function toolsFor(client: ObservabilityClient | undefined): Map<string, ToolObject> {
  return new Map(
    (makeObservabilityTools(client) as unknown as ToolObject[]).map((t) => [t.name, t]),
  );
}

async function run(client: ObservabilityClient | undefined, name: string, args: unknown = {}) {
  const t = toolsFor(client).get(name);
  if (!t) throw new Error(`no tool named ${name}`);
  return (await t.handler(args, {})).content[0].text;
}

describe("makeObservabilityTools", () => {
  it("registers every declared tool name", () => {
    const names = [...toolsFor(undefined).keys()];
    expect(names.sort()).toEqual([...OBSERVABILITY_TOOL_NAMES].sort());
  });

  it("registers tools even with no client, since the SDK fixes the tool set at startup", () => {
    expect(toolsFor(undefined).size).toBe(OBSERVABILITY_TOOL_NAMES.length);
  });

  describe("missing endpoints", () => {
    it("names the env var to set when there is no client at all", async () => {
      const out = await run(undefined, "kinetica_tier_snapshot");
      expect(out).toContain("KINETICA_STATS_HOST");
      expect(out).toContain("event_server_address");
    });

    it("gives the same actionable message when only SOME of the stack was found", async () => {
      // A partial stack is common: discovery can reach Loki but not Prometheus. The tool
      // must not degrade to the client's terse internal error just because a client object
      // happens to exist.
      const lokiOnly = {
        lokiUrl: "http://statshost:9080",
        promRange: vi.fn(),
      } as unknown as ObservabilityClient;

      const out = await run(lokiOnly, "kinetica_tier_snapshot");
      expect(out).toContain("KINETICA_STATS_HOST");
      expect(out).toContain("event_server_address");
      // And it must not have attempted the call.
      expect(
        (lokiOnly as unknown as { promRange: ReturnType<typeof vi.fn> }).promRange,
      ).not.toHaveBeenCalled();
    });

    it("names the missing SERVICE, since one variable now covers both", async () => {
      const promOnly = {
        promUrl: "http://statshost:9090",
        lokiRange: vi.fn(),
      } as unknown as ObservabilityClient;

      const out = await run(promOnly, "kinetica_loki_query");
      expect(out).toContain("Loki");
      expect(out).toContain("KINETICA_STATS_HOST");
    });

    it("gates the alerts tool on Prometheus, without touching the client", async () => {
      const lokiOnly = {
        lokiUrl: "http://statshost:9080",
        promRules: vi.fn(),
        promAlerts: vi.fn(),
      } as unknown as ObservabilityClient;

      const out = await run(lokiOnly, "kinetica_prom_alerts");
      expect(out).toContain("Prometheus");
      expect(out).toContain("KINETICA_STATS_HOST");
      const calls = lokiOnly as unknown as Record<string, ReturnType<typeof vi.fn>>;
      expect(calls.promRules).not.toHaveBeenCalled();
      // /api/v1/rules already embeds live instances, so the alerts endpoint is never read.
      expect(calls.promAlerts).not.toHaveBeenCalled();
    });

    it("still runs a tool whose endpoint IS present on a partial client", async () => {
      const lokiOnly = {
        lokiUrl: "http://statshost:9080",
        lokiRange: vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ status: "success", data: { result: [] } })),
          ),
      } as unknown as ObservabilityClient;

      const out = await run(lokiOnly, "kinetica_loki_query");
      expect(out).not.toContain("KINETICA_STATS_HOST");
      expect(out).toMatch(/no entries/i);
    });
  });
});

describe("createObservabilityRegistry", () => {
  it("registers every tool as read-only — they are all unauthenticated GETs", () => {
    const registry = createObservabilityRegistry();
    for (const name of OBSERVABILITY_TOOL_NAMES) {
      expect(registry.isReadOnlyTool(name)).toBe(true);
    }
  });

  it("does not vouch for anything it was not given", () => {
    expect(createObservabilityRegistry().isReadOnlyTool("kinetica_admin_rebalance")).toBe(false);
  });
});

describe("OBSERVABILITY_TOOL_CATALOG", () => {
  it("has a non-empty entry for every tool (the typecheck guard covers presence only)", () => {
    for (const name of OBSERVABILITY_TOOL_NAMES) {
      const entry = OBSERVABILITY_TOOL_CATALOG[name];
      expect(entry.reveals.length).toBeGreaterThan(20);
      expect(entry.whenToUse.length).toBeGreaterThan(10);
    }
  });
});
