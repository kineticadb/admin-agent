import { describe, it, expect, vi } from "vitest";

// prom-query.ts does not exist yet — these tests define the expected contract.
// They MUST fail on first run (RED phase).

import { promQuery, PromQuerySchema } from "./prom-query.js";
import type { ObservabilityClient } from "../../observability/ObservabilityClient.js";

const LABELS = {
  __name__: "ki_db_tier",
  source: "rank1",
  tier: "ram",
  what: "used_bytes",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Minimal client stub; only the methods under test are populated. */
function stubClient(over: Partial<ObservabilityClient> = {}): ObservabilityClient {
  return {
    promUrl: "http://statshost:9090",
    promInstant: vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ status: "success", data: { resultType: "vector", result: [] } }),
      ),
    promRange: vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ status: "success", data: { resultType: "matrix", result: [] } }),
      ),
    promRules: vi.fn(),
    promAlerts: vi.fn(),
    promConfig: vi.fn(),
    lokiRange: vi.fn(),
    lokiLabels: vi.fn(),
    ...over,
  };
}

const rangeBody = {
  status: "success",
  data: {
    resultType: "matrix",
    result: [
      {
        metric: LABELS,
        values: [
          [1788289096, "399556792"],
          [1788292696, "401666796"],
        ],
      },
    ],
  },
};

describe("PromQuerySchema", () => {
  it("requires a non-empty query", () => {
    expect(PromQuerySchema.safeParse({}).success).toBe(false);
    expect(PromQuerySchema.safeParse({ query: "" }).success).toBe(false);
    expect(PromQuerySchema.safeParse({ query: "up" }).success).toBe(true);
  });
});

describe("promQuery", () => {
  it("runs a range query by default and returns summarized rows", async () => {
    const promRange = vi.fn().mockResolvedValue(jsonResponse(rangeBody));
    const result = await promQuery(stubClient({ promRange }), { query: 'ki_db_tier{tier="ram"}' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.series_count).toBe(1);
    expect(result.data.series[0].last).toBe("401.67 MB");
    // A single series shares every label with itself, so they are hoisted into the note
    // rather than repeated in the table — see series-rows.ts.
    expect(result.data.series[0].series).toBe("");
    expect(result.note).toContain("All series: source=rank1 tier=ram what=used_bytes");
    expect(result.note).toContain("UTC");
    expect(promRange).toHaveBeenCalledOnce();
  });

  it("uses the instant endpoint when asked", async () => {
    const promInstant = vi.fn().mockResolvedValue(
      jsonResponse({
        status: "success",
        data: {
          resultType: "vector",
          result: [{ metric: LABELS, value: [1788298581, "793900000"] }],
        },
      }),
    );
    const promRange = vi.fn();
    const result = await promQuery(stubClient({ promInstant, promRange }), {
      query: "ki_db_tier",
      instant: true,
    });

    expect(result.ok).toBe(true);
    expect(promInstant).toHaveBeenCalledOnce();
    expect(promRange).not.toHaveBeenCalled();
  });

  it("derives a step that bounds the returned point count regardless of window", async () => {
    const promRange = vi.fn().mockResolvedValue(jsonResponse(rangeBody));
    await promQuery(stubClient({ promRange }), { query: "up", minutes_back: 10080 });

    const [, start, end, step] = promRange.mock.calls[0];
    expect((end - start) / step).toBeLessThanOrEqual(200);
    expect(step).toBeGreaterThan(0);
  });

  it("honours an explicit step", async () => {
    const promRange = vi.fn().mockResolvedValue(jsonResponse(rangeBody));
    await promQuery(stubClient({ promRange }), { query: "up", step_seconds: 15, minutes_back: 10 });
    expect(promRange.mock.calls[0][3]).toBe(15);
  });

  describe("failures", () => {
    it("surfaces Prometheus' own parse error rather than a bare HTTP status", async () => {
      const promRange = vi.fn().mockResolvedValue(
        jsonResponse(
          {
            status: "error",
            errorType: "bad_data",
            error: `invalid parameter "query": 1:12: parse error: unexpected left brace '{'`,
          },
          400,
        ),
      );
      const result = await promQuery(stubClient({ promRange }), { query: "ki_db_tier{{{" });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(400);
      expect(result.error).toContain("parse error");
      expect(result.error).toContain("unexpected left brace");
    });

    it("treats a 200 carrying status:error as a failure", async () => {
      const promRange = vi
        .fn()
        .mockResolvedValue(jsonResponse({ status: "error", error: "something went wrong" }));
      const result = await promQuery(stubClient({ promRange }), { query: "up" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("something went wrong");
    });

    it("does not throw on malformed JSON", async () => {
      const promRange = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));
      const result = await promQuery(stubClient({ promRange }), { query: "up" });
      expect(result.ok).toBe(false);
    });

    it("converts an unconfigured-endpoint throw into a failure", async () => {
      const promRange = vi
        .fn()
        .mockRejectedValue(new Error("Prometheus endpoint is not configured"));
      const result = await promQuery(stubClient({ promRange }), { query: "up" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/prometheus/i);
    });

    it("rejects a path-shaped query without contacting the server", async () => {
      // Defensive: the API is read-only, but a caller passing "/-/reload" is confused
      // about what this tool does and should be told, not silently URL-encoded.
      const promRange = vi.fn();
      const result = await promQuery(stubClient({ promRange }), { query: "/-/reload" });
      expect(result.ok).toBe(false);
      expect(promRange).not.toHaveBeenCalled();
    });
  });

  describe("empty results", () => {
    it("reports zero matches as success, and says a wrong metric name looks identical", async () => {
      // Measured: a nonexistent metric returns HTTP 200 with an empty result array.
      const result = await promQuery(stubClient(), { query: "no_such_metric_xyz" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.series_count).toBe(0);
      expect(result.note).toMatch(/no series|0 series/i);
      expect(result.note).toMatch(/name/i);
    });
  });
});
