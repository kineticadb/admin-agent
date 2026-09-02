import { describe, it, expect, vi } from "vitest";

// loki-query.ts does not exist yet — these tests define the expected contract.
// They MUST fail on first run (RED phase).

import { lokiQuery, LokiQuerySchema, renderEntry } from "./loki-query.js";
import type { ObservabilityClient } from "../../observability/ObservabilityClient.js";

const JOB_LABELS = {
  class: "job",
  cluster: "example-cluster",
  code: "03.090800.25",
  component: "rank",
  host: "dbhost",
  ring: "default",
  runid: "20260901020800",
  severity: "uerr",
  source: "rank0",
  what: "error",
  who: "admin",
};

const SQL_LABELS = { ...JOB_LABELS, class: "sql", severity: "info", what: "info" };

/** A real class="sql" body, verbatim in shape from a live cluster. */
const SQL_BODY = JSON.stringify({
  start_time: "2026-09-01 20:15:41.697",
  end_time: "2026-09-01 20:15:41.833",
  start_time_ms: 1788293741697,
  end_time_ms: 1788293741833,
  elapsed: 0.136,
  jobid: 6715,
  user: "admin",
  resource_group: "kinetica_system_resource_group",
  statement: "SELECT 1",
});

const LOG_BODY = JSON.stringify({
  log: "Invalid or missing credentials for endpoint: /admin/show/configuration",
});

function streams(result: unknown[]) {
  return { status: "success", data: { resultType: "streams", result } };
}

function clientFor(result: unknown[], status = 200): ObservabilityClient {
  return {
    lokiUrl: "http://statshost:9080",
    lokiRange: vi.fn().mockResolvedValue(new Response(JSON.stringify(streams(result)), { status })),
    lokiLabels: vi.fn(),
    promInstant: vi.fn(),
    promRange: vi.fn(),
    promRules: vi.fn(),
    promAlerts: vi.fn(),
    promConfig: vi.fn(),
  };
}

describe("LokiQuerySchema", () => {
  it("accepts an empty call — every argument is optional", () => {
    expect(LokiQuerySchema.safeParse({}).success).toBe(true);
  });
});

describe("renderEntry", () => {
  it("unwraps the {log: string} envelope used by job/status events", () => {
    expect(renderEntry(LOG_BODY)).toBe(
      "Invalid or missing credentials for endpoint: /admin/show/configuration",
    );
  });

  it("renders a sql telemetry record with timing, job, group and statement", () => {
    const rendered = renderEntry(SQL_BODY);
    expect(rendered).toContain("0.136s");
    expect(rendered).toContain("job=6715");
    expect(rendered).toContain("kinetica_system_resource_group");
    expect(rendered).toContain("SELECT 1");
    // The redundant ms twins of start_time/end_time must not be echoed.
    expect(rendered).not.toContain("start_time_ms");
  });

  it("falls back to compact key=value for an unrecognized object", () => {
    const rendered = renderEntry(JSON.stringify({ alpha: 1, beta: "two" }));
    expect(rendered).toContain("alpha=1");
    expect(rendered).toContain("beta=two");
  });

  it("passes a non-JSON body straight through", () => {
    expect(renderEntry("plain text line")).toBe("plain text line");
  });

  it("unwraps a log envelope whose message contains unescaped quotes", () => {
    // Measured on a live cluster: Kinetica does NOT escape quotes inside the log
    // string, so the envelope is invalid JSON and JSON.parse throws. This affects
    // precisely the messages worth reading — SQL errors quote the offending token.
    const malformed =
      '{"log":"Request failed with JobId: to: execute_sql. SqlEngine: Syntax error near "nonexistent_table_xyz" at line 1, column 9. (S/SDc:1602)"}';
    const rendered = renderEntry(malformed);
    expect(rendered).not.toContain('{"log"');
    expect(rendered).toContain("Syntax error near");
    expect(rendered).toContain('"nonexistent_table_xyz"');
  });
});

describe("lokiQuery", () => {
  const jobStream = {
    stream: JOB_LABELS,
    values: [["1788293757196198000", LOG_BODY]],
  };
  const sqlStream = {
    stream: SQL_LABELS,
    values: [["1788293741835027000", SQL_BODY]],
  };

  it("flattens streams into rows, newest first", async () => {
    const r = await lokiQuery(clientFor([sqlStream, jobStream]), {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.entries).toHaveLength(2);
    // 1788293757… is later than 1788293741…
    expect(r.data.entries[0].class).toBe("job");
    expect(r.data.entries[1].class).toBe("sql");
  });

  it("renders a readable UTC timestamp from the nanosecond epoch", async () => {
    const r = await lokiQuery(clientFor([jobStream]), {});
    if (!r.ok) return;
    expect(r.data.entries[0].time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("collapses embedded newlines so one record cannot break the table", async () => {
    // Measured: class="sql" statements arrive multi-line, which escapes the markdown cell.
    const multiline = {
      stream: SQL_LABELS,
      values: [
        [
          "1788293741835027000",
          JSON.stringify({ jobid: 1, statement: "SELECT a,\n  b\nFROM t\nORDER BY a" }),
        ],
      ],
    };
    const r = await lokiQuery(clientFor([multiline]), {});
    if (!r.ok) return;
    expect(r.data.entries[0].message).not.toContain("\n");
    expect(r.data.entries[0].message).toContain("SELECT a, b FROM t ORDER BY a");
  });

  it("escapes pipes so SQL string concatenation cannot inject table cells", async () => {
    // `||` is Postgres/Kinetica string concatenation and appears in real queries.
    const concat = {
      stream: SQL_LABELS,
      values: [
        ["1788293741835027000", JSON.stringify({ jobid: 1, statement: "SELECT a || b FROM t" })],
      ],
    };
    const r = await lokiQuery(clientFor([concat]), {});
    if (!r.ok) return;
    expect(r.data.entries[0].message).toContain("\\|\\|");
    expect(r.data.entries[0].message).not.toMatch(/[^\\]\|/);
  });

  it("does not throw when the body parses to null", async () => {
    const client = {
      lokiRange: vi.fn().mockResolvedValue(new Response("null")),
    } as unknown as ObservabilityClient;
    const r = await lokiQuery(client, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.entries).toHaveLength(0);
  });

  it("carries the discriminating labels as columns", async () => {
    const r = await lokiQuery(clientFor([jobStream]), {});
    if (!r.ok) return;
    const [row] = r.data.entries;
    expect(row).toMatchObject({ severity: "uerr", source: "rank0", who: "admin", what: "error" });
    expect(row.message).toContain("Invalid or missing credentials");
  });

  describe("selector construction", () => {
    it("defaults to every stream when nothing is specified", async () => {
      const client = clientFor([]);
      await lokiQuery(client, {});
      const [selector] = (client.lokiRange as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(selector).toContain("cluster=~");
    });

    it("builds a selector from the class and severity conveniences", async () => {
      const client = clientFor([]);
      await lokiQuery(client, { class: "sql", severity: "uerr" });
      const [selector] = (client.lokiRange as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(selector).toContain('class="sql"');
      expect(selector).toContain('severity="uerr"');
    });

    it("appends a line filter for contains", async () => {
      const client = clientFor([]);
      await lokiQuery(client, { contains: "credentials" });
      const [selector] = (client.lokiRange as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(selector).toContain(`|= \`credentials\``);
    });

    it("applies contains to a raw selector too, not just the built one", async () => {
      const client = clientFor([]);
      await lokiQuery(client, { selector: '{class="sql"}', contains: "OutOfMemory" });
      const [selector] = (client.lokiRange as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(selector).toContain('{class="sql"}');
      expect(selector).toContain("OutOfMemory");
    });

    it("passes an explicit selector through untouched", async () => {
      const client = clientFor([]);
      await lokiQuery(client, { selector: '{class="status"}' });
      const [selector] = (client.lokiRange as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(selector).toBe('{class="status"}');
    });

    it("sends nanosecond bounds as strings", async () => {
      const client = clientFor([]);
      await lokiQuery(client, { minutes_back: 60 });
      const [, startNs, endNs] = (client.lokiRange as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(typeof startNs).toBe("string");
      expect(startNs).toMatch(/^\d{19}$/);
      expect(BigInt(endNs) - BigInt(startNs)).toBe(3600000000000n);
    });
  });

  describe("failure and emptiness", () => {
    it("reports an empty result with guidance about retention", async () => {
      const r = await lokiQuery(clientFor([]), {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.entries).toHaveLength(0);
      expect(r.note).toMatch(/retention|widen|no entries/i);
    });

    it("returns a failure on a non-OK response", async () => {
      const r = await lokiQuery(clientFor([], 400), {});
      expect(r.ok).toBe(false);
    });

    it("converts an unconfigured-endpoint throw into a failure", async () => {
      const client = {
        lokiRange: vi.fn().mockRejectedValue(new Error("Loki endpoint is not configured")),
      } as unknown as ObservabilityClient;
      const r = await lokiQuery(client, {});
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(/loki/i);
    });

    it("does not throw on malformed JSON", async () => {
      const client = {
        lokiRange: vi.fn().mockResolvedValue(new Response("not json")),
      } as unknown as ObservabilityClient;
      const r = await lokiQuery(client, {});
      expect(r.ok).toBe(false);
    });
  });
});
