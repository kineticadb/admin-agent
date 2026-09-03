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
    it("defaults to every EVENT stream when nothing is specified", async () => {
      // Was `cluster=~".+"` — correct only while events were the sole occupants of Loki.
      // With promtail enabled that also matches rank log lines, which outnumber events by
      // orders of magnitude and would consume the whole limit. See stream=all to opt in.
      const client = clientFor([]);
      await lokiQuery(client, {});
      const [selector] = (client.lokiRange as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(selector).toBe('{cluster=~".+",job=""}');
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

// --- promtail (enable_promtail=true) -------------------------------------------------
// Label schema and body shape measured against a live 7.2.3.20 kagent cluster after
// enabling promtail. Promtail streams share cluster/host/ring with the event streams and
// add app/filename/job/level; bodies are plain-text core-dialect log lines.

const RANK_LOG_LABELS = {
  app: "rank-0",
  cluster: "dev-cluster",
  filename: "/opt/gpudb/core/logs/gpudb-rolling-r0.log",
  host: "node2",
  job: "gpudb_log",
  level: "info",
  ring: "default",
};

/** Verbatim shape of a promtail-shipped rank log line. */
const RANK_LOG_LINE =
  "2026-09-02 18:24:04.792 INFO  (204732,206427,r0/gpudb_ep_6     ) node2 " +
  "Endpoint/Endpoint.cpp:277 - JobId:96; Request URI: /execute/sql completed in 0.07464 s bytes: 172";

const logStream = {
  stream: RANK_LOG_LABELS,
  values: [["1788373444792000000", RANK_LOG_LINE]],
};

function selectorOf(client: ObservabilityClient): string {
  return (client.lokiRange as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
}

describe("promtail log lines", () => {
  describe("renderEntry", () => {
    it("strips the timestamp/pid boilerplate from a core-dialect log line", () => {
      const rendered = renderEntry(RANK_LOG_LINE);
      // time and severity already have their own columns; the pid/tid tuple is noise.
      expect(rendered).not.toContain("2026-09-02 18:24:04.792");
      expect(rendered).not.toContain("(204732,206427");
      // the source location is diagnostic gold and must survive
      expect(rendered).toContain("Endpoint/Endpoint.cpp:277");
      expect(rendered).toContain("JobId:96");
    });

    it("still passes a line that is not a Kinetica log record straight through", () => {
      expect(renderEntry("LIMIT 20")).toBe("LIMIT 20");
    });
  });

  describe("stream selection", () => {
    it("defaults to events only, so log lines cannot bury them", async () => {
      // Measured: ~60k log lines/hour against a few hundred events over days. A
      // cluster-wide match would spend the whole limit on log lines.
      const client = clientFor([]);
      await lokiQuery(client, {});
      expect(selectorOf(client)).toBe('{cluster=~".+",job=""}');
    });

    it("defines events by EXCLUDING promtail, not by requiring a class label", async () => {
      // On a cluster that never ran promtail no stream carries `job`, so this base is
      // identical to the pre-promtail default `{cluster=~".+"}` BY CONSTRUCTION — the
      // back-compat guarantee needs no measurement of any particular cluster. Requiring
      // `class=~".+"` instead would silently drop any event stream that lacked the label.
      const client = clientFor([]);
      await lokiQuery(client, { stream: "events" });
      const selector = selectorOf(client);
      expect(selector).toContain('cluster=~".+"');
      expect(selector).toContain('job=""');
      expect(selector).not.toContain("class=");
    });

    it("selects promtail streams for stream=logs", async () => {
      const client = clientFor([]);
      await lokiQuery(client, { stream: "logs" });
      expect(selectorOf(client)).toContain('job=~".+"');
    });

    it("selects both for stream=all", async () => {
      const client = clientFor([]);
      await lokiQuery(client, { stream: "all" });
      expect(selectorOf(client)).toContain('cluster=~".+"');
    });
  });

  describe("label vocabulary translation", () => {
    it("maps source to the hyphenated app label for logs", async () => {
      // Events say source="rank0"; promtail says app="rank-0". Same rank, two spellings.
      const client = clientFor([]);
      await lokiQuery(client, { stream: "logs", source: "rank0" });
      expect(selectorOf(client)).toContain('app="rank-0"');
    });

    it("maps the host manager, which drops its ordinal in the app label", async () => {
      const client = clientFor([]);
      await lokiQuery(client, { stream: "logs", source: "hostmanager0" });
      expect(selectorOf(client)).toContain('app="hostmanager"');
    });

    it("leaves an already-hyphenated app name alone", async () => {
      const client = clientFor([]);
      await lokiQuery(client, { stream: "logs", source: "graph-0" });
      expect(selectorOf(client)).toContain('app="graph-0"');
    });

    it("maps severity to the level label for logs, lowercased", async () => {
      // level values are info|warn|error|uerr; an agent reading log text sees "ERROR".
      const client = clientFor([]);
      await lokiQuery(client, { stream: "logs", severity: "ERROR" });
      expect(selectorOf(client)).toContain('level="error"');
      expect(selectorOf(client)).not.toContain("severity=");
    });

    it("keeps the severity label for events", async () => {
      const client = clientFor([]);
      await lokiQuery(client, { severity: "uerr" });
      expect(selectorOf(client)).toContain('severity="uerr"');
      expect(selectorOf(client)).not.toContain("level=");
    });

    it("filters by job, the only route to the sql/graph/tomcat logs", async () => {
      const client = clientFor([]);
      await lokiQuery(client, { stream: "logs", job: "gpudb_sql_log" });
      expect(selectorOf(client)).toContain('job="gpudb_sql_log"');
    });
  });

  describe("row shape", () => {
    it("fills source from app, severity from level, and carries job", async () => {
      const r = await lokiQuery(clientFor([logStream]), { stream: "logs" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.entries[0]).toMatchObject({
        source: "rank-0",
        severity: "info",
        job: "gpudb_log",
        class: "",
      });
    });

    it("leaves job blank on an event row, so the two kinds stay distinguishable", async () => {
      const r = await lokiQuery(clientFor([{ stream: JOB_LABELS, values: [["1", LOG_BODY]] }]), {});
      if (!r.ok) return;
      expect(r.data.entries[0].job).toBe("");
      expect(r.data.entries[0].class).toBe("job");
    });
  });

  describe("empty results", () => {
    it("does not blame promtail for an empty stream=all result", async () => {
      // An "all" query matches events too, so emptiness says nothing about promtail —
      // a mistyped `contains` is at least as likely. Naming promtail here would send
      // the agent chasing a configuration problem that does not exist.
      const r = await lokiQuery(clientFor([]), { stream: "all", contains: "nope" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.note).not.toMatch(/enable_promtail/i);
      expect(r.note).toMatch(/selector|window|widen/i);
    });

    it("does not blame promtail for an empty logs result it could not verify", async () => {
      // clientFor's label probe answers nothing, so presence is unknown. Asserting the
      // prerequisite here is the bug this replaced: it read as "promtail is off".
      // The verified cases live in "promtail presence on an empty logs result" below.
      const r = await lokiQuery(clientFor([]), { stream: "logs" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.note).toMatch(/could not verify/i);
      expect(r.note).not.toMatch(/promtail is enabled and shipping/i);
    });
  });
});

describe("promtail presence on an empty logs result", () => {
  /** A logs client whose range query is empty and whose label probe is scripted. */
  function emptyLogsClient(labels?: unknown, labelStatus = 200): ObservabilityClient {
    return {
      lokiUrl: "http://statshost:9080",
      lokiRange: vi.fn().mockResolvedValue(new Response(JSON.stringify(streams([])))),
      lokiLabels: vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(labels), { status: labelStatus })),
      promInstant: vi.fn(),
      promRange: vi.fn(),
      promRules: vi.fn(),
      promAlerts: vi.fn(),
      promConfig: vi.fn(),
    };
  }

  const shipping = { status: "success", data: ["cluster", "job", "app", "level"] };
  const noPromtail = { status: "success", data: ["cluster", "class", "source"] };

  it("reports promtail as SHIPPING when Loki holds the job label, and never blames config", async () => {
    const r = await lokiQuery(emptyLogsClient(shipping), { stream: "logs", severity: "error" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.note).toMatch(/promtail is enabled and shipping/i);
    // The whole bug: an empty FILTERED result was reported as promtail being off.
    expect(r.note).not.toMatch(/enable_promtail/);
    expect(r.note).not.toMatch(/off by default/i);
  });

  it("names the filters to drop when a narrowed logs query comes back empty", async () => {
    const r = await lokiQuery(emptyLogsClient(shipping), {
      stream: "logs",
      severity: "error",
      job: "gpudb_log",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.note).toMatch(/severity/);
    expect(r.note).toMatch(/job/);
  });

  it("says an exact severity match is not a threshold, so worse levels are excluded", async () => {
    const r = await lokiQuery(emptyLogsClient(shipping), { stream: "logs", severity: "error" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.note).toMatch(/exact|not a threshold/i);
  });

  it("recommends the config fix ONLY when no promtail stream exists at all", async () => {
    const r = await lokiQuery(emptyLogsClient(noPromtail), { stream: "logs" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.note).toMatch(/enable_promtail/);
    expect(r.note).toMatch(/restart/i);
  });

  it("refuses to conclude either way when the label probe cannot answer", async () => {
    for (const client of [
      emptyLogsClient(noPromtail, 500),
      emptyLogsClient({ status: "success" }), // quiet Loki: success with no data array
      emptyLogsClient("not json"),
    ]) {
      const r = await lokiQuery(client, { stream: "logs" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.note).toMatch(/could not verify/i);
      expect(r.note).not.toMatch(/promtail is enabled and shipping/i);
    }
  });

  it("survives a label probe that throws", async () => {
    const client = {
      lokiUrl: "http://statshost:9080",
      lokiRange: vi.fn().mockResolvedValue(new Response(JSON.stringify(streams([])))),
      lokiLabels: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as ObservabilityClient;
    const r = await lokiQuery(client, { stream: "logs" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.note).toMatch(/could not verify/i);
  });

  it("probes only for an empty LOGS result — not for events, all, or a non-empty one", async () => {
    const events = emptyLogsClient(shipping);
    await lokiQuery(events, {});
    expect(events.lokiLabels).not.toHaveBeenCalled();

    const all = emptyLogsClient(shipping);
    await lokiQuery(all, { stream: "all" });
    expect(all.lokiLabels).not.toHaveBeenCalled();

    const nonEmpty = {
      lokiUrl: "http://statshost:9080",
      lokiRange: vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify(
              streams([{ stream: RANK_LOG_LABELS, values: [["1788293757196198000", "x"]] }]),
            ),
          ),
        ),
      lokiLabels: vi.fn(),
    } as unknown as ObservabilityClient;
    await lokiQuery(nonEmpty, { stream: "logs" });
    expect(nonEmpty.lokiLabels).not.toHaveBeenCalled();
  });
});

describe("the events note points at the logs the agent has not read", () => {
  const stream = {
    stream: SQL_LABELS,
    values: [["1788293741835027000", SQL_BODY]],
  };

  it("states plainly that rank log lines were NOT read", async () => {
    const r = await lokiQuery(clientFor([stream]), {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.note).toMatch(/have not/i);
    expect(r.note).toMatch(/stream="logs"/);
  });

  it("does not make the logs read conditional on promtail, which it cannot know here", async () => {
    const r = await lokiQuery(clientFor([stream]), {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.note).not.toMatch(/If the cluster has promtail enabled/i);
  });
});
