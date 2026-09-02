import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ObservabilityClient.ts does not exist yet — these tests define the expected contract.
// They MUST fail on first run (RED phase).

const mockFetch = vi.fn();

async function getFactory() {
  const mod = await import("./ObservabilityClient.js");
  return mod.createObservabilityClient;
}

/** Last fetch call as [url, init]. */
function lastCall(): [string, RequestInit] {
  const call = mockFetch.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  return [String(call[0]), (call[1] ?? {}) as RequestInit];
}

function lastUrl(): URL {
  return new URL(lastCall()[0]);
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DEBUG;
});

describe("createObservabilityClient", () => {
  describe("endpoint normalization", () => {
    it("defaults a bare host:port to http, not the database's scheme", async () => {
      const create = await getFactory();
      const client = create({ promUrl: "statshost:9090" });
      expect(client.promUrl).toBe("http://statshost:9090");
    });

    it("preserves an explicit https URL", async () => {
      const create = await getFactory();
      const client = create({ promUrl: "https://statshost:9090" });
      expect(client.promUrl).toBe("https://statshost:9090");
    });

    it("strips a trailing slash so path joins never double up", async () => {
      const create = await getFactory();
      const client = create({ lokiUrl: "http://statshost:9080/" });
      expect(client.lokiUrl).toBe("http://statshost:9080");
    });

    it("leaves an unconfigured endpoint undefined", async () => {
      const create = await getFactory();
      const client = create({ promUrl: "http://statshost:9090" });
      expect(client.lokiUrl).toBeUndefined();
    });
  });

  describe("credential isolation", () => {
    it("never sends an Authorization header", async () => {
      const create = await getFactory();
      const client = create({ promUrl: "http://statshost:9090", lokiUrl: "http://statshost:9080" });

      await client.promInstant('ki_db_tier{tier="ram"}');
      await client.promRange("up", 100, 200, 10);
      await client.promRules();
      await client.promConfig();
      await client.lokiRange('{class="job"}', "1000", "2000", 5);

      for (const [, init] of mockFetch.mock.calls) {
        const headers = new Headers((init as RequestInit)?.headers ?? {});
        expect(headers.has("authorization")).toBe(false);
      }
    });

    it("issues GET, never POST", async () => {
      const create = await getFactory();
      const client = create({ promUrl: "http://statshost:9090" });
      await client.promInstant("up");
      const [, init] = lastCall();
      expect(init.method ?? "GET").toBe("GET");
      expect(init.body).toBeUndefined();
    });
  });

  describe("promInstant", () => {
    it("URL-encodes braced PromQL rather than interpolating it raw", async () => {
      const create = await getFactory();
      const client = create({ promUrl: "http://statshost:9090" });
      const q = 'ki_db_tier{tier="ram",what="used_bytes"}';

      await client.promInstant(q);

      const [rawUrl] = lastCall();
      expect(rawUrl).not.toContain("{");
      expect(rawUrl).toContain("%7B");
      expect(lastUrl().pathname).toBe("/api/v1/query");
      expect(lastUrl().searchParams.get("query")).toBe(q);
    });
  });

  describe("promRange", () => {
    it("sends second-epoch bounds on the range endpoint", async () => {
      const create = await getFactory();
      const client = create({ promUrl: "http://statshost:9090" });

      await client.promRange('ki_db_tier{tier="ram"}', 1788289096, 1788292696, 60);

      const url = lastUrl();
      expect(url.pathname).toBe("/api/v1/query_range");
      expect(url.searchParams.get("start")).toBe("1788289096");
      expect(url.searchParams.get("end")).toBe("1788292696");
      expect(url.searchParams.get("step")).toBe("60");
    });
  });

  describe("promRules and promConfig", () => {
    it("reads alert rules from /api/v1/rules", async () => {
      const create = await getFactory();
      await (await getFactory())({ promUrl: "http://statshost:9090" }).promRules();
      expect(lastUrl().pathname).toBe("/api/v1/rules");
      expect(create).toBeTypeOf("function");
    });

    it("reads the scrape topology from /api/v1/status/config", async () => {
      const create = await getFactory();
      await create({ promUrl: "http://statshost:9090" }).promConfig();
      expect(lastUrl().pathname).toBe("/api/v1/status/config");
    });
  });

  describe("lokiRange", () => {
    it("sends nanosecond-epoch bounds as strings, un-truncated", async () => {
      const create = await getFactory();
      const client = create({ lokiUrl: "http://statshost:9080" });
      const startNs = "1788289096000000000";
      const endNs = "1788292696000000000";

      await client.lokiRange('{class="job"}', startNs, endNs, 25);

      const url = lastUrl();
      expect(url.pathname).toBe("/loki/api/v1/query_range");
      // Nanosecond epochs exceed Number.MAX_SAFE_INTEGER — they must survive as strings.
      expect(url.searchParams.get("start")).toBe(startNs);
      expect(url.searchParams.get("end")).toBe(endNs);
      expect(url.searchParams.get("limit")).toBe("25");
      expect(url.searchParams.get("query")).toBe('{class="job"}');
    });
  });

  describe("unconfigured endpoints", () => {
    it("rejects a Prometheus call when no Prometheus URL is configured", async () => {
      const create = await getFactory();
      const client = create({ lokiUrl: "http://statshost:9080" });
      await expect(client.promInstant("up")).rejects.toThrow(/prometheus/i);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects a Loki call when no Loki URL is configured", async () => {
      const create = await getFactory();
      const client = create({ promUrl: "http://statshost:9090" });
      await expect(client.lokiRange("{}", "1", "2", 1)).rejects.toThrow(/loki/i);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("timeout", () => {
    it("attaches an abort signal to every request", async () => {
      const create = await getFactory();
      await create({ promUrl: "http://statshost:9090" }).promInstant("up");
      expect(lastCall()[1].signal).toBeInstanceOf(AbortSignal);
    });

    it("honours an overridden timeout", async () => {
      const create = await getFactory();
      const spy = vi.spyOn(AbortSignal, "timeout");
      await create({ promUrl: "http://statshost:9090" }, { timeoutMs: 1234 }).promInstant("up");
      expect(spy).toHaveBeenCalledWith(1234);
      spy.mockRestore();
    });
  });
});
