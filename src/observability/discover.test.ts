import { describe, it, expect, vi } from "vitest";

// discover.ts does not exist yet — these tests define the expected contract.
// They MUST fail on first run (RED phase).

import { discoverObservability, DEFAULT_PROM_PORT, DEFAULT_LOKI_PORT } from "./discover.js";

/** Property map as /show/system/properties returns it — `conf.`-prefixed. */
const SHOW_PROPS = {
  "conf.enable_stats_server": "TRUE",
  "conf.event_server_address": "192.0.2.11",
  "conf.event_server_internal": "FALSE",
};

/** Full gpudb.conf as /admin/show/configuration or a bundle returns it — bare keys, with ports. */
const FILE_PROPS = {
  enable_stats_server: "true",
  event_server_internal: "false",
  event_server_address: "192.0.2.11",
  event_server_port: "9080",
  alertmanager_address: "${gaia.event_server_address}",
  alertmanager_port: "9089",
};

/** A probe that says yes to everything. */
const allUp = () => Promise.resolve(true);
/** A probe that says no to everything. */
const allDown = () => Promise.resolve(false);

describe("discoverObservability", () => {
  describe("operator override", () => {
    it("takes a single stats host and derives both service ports from it", async () => {
      // gpudb.conf models one address plus per-service ports, and Prometheus scrapes Loki
      // at localhost — they are one host, so the override is one host.
      const found = await discoverObservability({
        env: { KINETICA_STATS_HOST: "statshost" },
        properties: SHOW_PROPS,
        probe: allUp,
      });
      expect(found.endpoints.promUrl).toBe(`http://statshost:${DEFAULT_PROM_PORT}`);
      expect(found.endpoints.lokiUrl).toBe(`http://statshost:${DEFAULT_LOKI_PORT}`);
    });

    it("still verifies the override by probe rather than trusting it blind", async () => {
      // A typo must surface at startup with a clear message, not on every tool call.
      const probe = vi.fn((_url: string, _s: string) => Promise.resolve(false));
      const found = await discoverObservability({
        env: { KINETICA_STATS_HOST: "typoed-host" },
        probe,
      });
      expect(found.endpoints).toEqual({});
      expect(probe).toHaveBeenCalled();
      expect(found.unreachable.some((u) => u.includes("typoed-host"))).toBe(true);
    });

    it("outranks the config-declared address", async () => {
      const probe = (url: string) => Promise.resolve(url.includes("statshost"));
      const found = await discoverObservability({
        env: { KINETICA_STATS_HOST: "statshost" },
        properties: FILE_PROPS,
        probe,
      });
      expect(found.endpoints.promUrl).toBe(`http://statshost:${DEFAULT_PROM_PORT}`);
    });

    it("honours a declared non-default Loki port alongside the override", async () => {
      const found = await discoverObservability({
        env: { KINETICA_STATS_HOST: "statshost" },
        properties: { ...FILE_PROPS, event_server_port: "19080" },
        probe: allUp,
      });
      expect(found.endpoints.lokiUrl).toBe("http://statshost:19080");
    });

    it.each([
      ["a bare host", "statshost"],
      ["a URL", "http://statshost"],
      ["a host:port (port discarded — ports are per service)", "statshost:9999"],
    ])("accepts %s", async (_label, value) => {
      const found = await discoverObservability({
        env: { KINETICA_STATS_HOST: value },
        probe: allUp,
      });
      expect(found.endpoints.promUrl).toBe(`http://statshost:${DEFAULT_PROM_PORT}`);
    });

    it("preserves an https scheme rather than downgrading a TLS stats stack", async () => {
      const found = await discoverObservability({
        env: { KINETICA_STATS_HOST: "https://statshost" },
        probe: allUp,
      });
      expect(found.endpoints.promUrl).toBe(`https://statshost:${DEFAULT_PROM_PORT}`);
      expect(found.endpoints.lokiUrl).toBe(`https://statshost:${DEFAULT_LOKI_PORT}`);
    });

    it("works with no config at all — the override alone is enough", async () => {
      const found = await discoverObservability({
        env: { KINETICA_STATS_HOST: "statshost" },
        probe: allUp,
      });
      expect(found.endpoints.promUrl).toBeDefined();
      expect(found.endpoints.lokiUrl).toBeDefined();
    });

    it("honours the override even when config says the stats server is disabled", async () => {
      const found = await discoverObservability({
        env: { KINETICA_STATS_HOST: "statshost" },
        properties: { ...FILE_PROPS, enable_stats_server: "false" },
        probe: allUp,
      });
      expect(found.endpoints.promUrl).toBeDefined();
    });
  });

  describe("config-derived endpoints", () => {
    it("uses event_server_address as the observability host", async () => {
      const found = await discoverObservability({ properties: FILE_PROPS, probe: allUp });
      expect(found.endpoints.lokiUrl).toBe(`http://192.0.2.11:${DEFAULT_LOKI_PORT}`);
      expect(found.endpoints.promUrl).toBe(`http://192.0.2.11:${DEFAULT_PROM_PORT}`);
    });

    it("does not probe Alertmanager — nothing reads it and the probe taxed every startup", async () => {
      const probe = vi.fn((_url: string) => Promise.resolve(true));
      await discoverObservability({ properties: FILE_PROPS, probe });
      const probed = probe.mock.calls.map((c) => String(c[0]));
      expect(probed.some((u) => u.includes("9089"))).toBe(false);
    });

    it("probes Prometheus on the event-server host — it is never declared in config", async () => {
      const probe = vi.fn((_url: string) => Promise.resolve(true));
      const found = await discoverObservability({ properties: FILE_PROPS, probe });
      expect(found.endpoints.promUrl).toBe(`http://192.0.2.11:${DEFAULT_PROM_PORT}`);
      expect(probe).toHaveBeenCalledWith(
        expect.stringContaining(String(DEFAULT_PROM_PORT)),
        "prometheus",
      );
    });

    it("reads the conf.-prefixed spelling from /show/system/properties", async () => {
      // That endpoint omits event_server_port entirely, so the defaults must carry it.
      const found = await discoverObservability({ properties: SHOW_PROPS, probe: allUp });
      expect(found.endpoints.lokiUrl).toBe(`http://192.0.2.11:${DEFAULT_LOKI_PORT}`);
    });

    it("prefers event_server_public_address when a site records one", async () => {
      // Not observed on the measured cluster, but it follows gpudb.conf's own convention
      // for database hosts (host0.address / host0.public_address).
      const found = await discoverObservability({
        properties: {
          ...FILE_PROPS,
          event_server_public_address: "203.0.113.11",
        },
        probe: allUp,
      });
      expect(found.endpoints.promUrl).toBe("http://203.0.113.11:9090");
    });

    it("honours a non-default declared port over the default", async () => {
      const found = await discoverObservability({
        properties: { ...FILE_PROPS, event_server_port: "19080" },
        probe: allUp,
      });
      expect(found.endpoints.lokiUrl).toBe("http://192.0.2.11:19080");
    });

    it("uses the database host when the event server is internal", async () => {
      const found = await discoverObservability({
        properties: { ...FILE_PROPS, event_server_internal: "true", event_server_address: "" },
        dbHost: "dbnode",
        probe: allUp,
      });
      expect(found.endpoints.lokiUrl).toBe(`http://dbnode:${DEFAULT_LOKI_PORT}`);
    });
  });

  describe("untrusted config hosts (SSRF)", () => {
    // gpudb.conf reaches this code from a SUPPORT BUNDLE on the --bundle path, and the
    // repo's own position is that bundle content is untrusted (bundle-index.ts: "SECURITY:
    // a support bundle is untrusted input"). A config-supplied address must therefore not
    // be able to steer an outbound request anywhere the URL grammar allows.
    const probedUrls = async (props: Record<string, string>) => {
      const probe = vi.fn((_url: string, _s: string) => Promise.resolve(false));
      await discoverObservability({ properties: props, env: {}, probe });
      return probe.mock.calls.map((c) => String(c[0]));
    };

    it("strips path, query and fragment from event_server_address", async () => {
      const urls = await probedUrls({
        enable_stats_server: "true",
        event_server_address: "attacker.example:18099/beacon?leak=1#",
      });
      expect(urls.length).toBeGreaterThan(0);
      for (const u of urls) {
        expect(u).not.toContain("/beacon");
        expect(u).not.toContain("leak=1");
        expect(u).not.toContain("#");
        expect(u).not.toContain("18099");
      }
      expect(urls).toContain(`http://attacker.example:${DEFAULT_PROM_PORT}`);
    });

    it("strips them from event_server_public_address, the highest-priority config key", async () => {
      const urls = await probedUrls({
        enable_stats_server: "true",
        event_server_public_address: "attacker.example/beacon?leak=1#",
        event_server_address: "192.0.2.11",
      });
      for (const u of urls) expect(u).not.toMatch(/beacon|leak|#/);
    });

    it("strips them from a hostN.public_address translation", async () => {
      const urls = await probedUrls({
        enable_stats_server: "true",
        event_server_address: "192.0.2.12",
        "host0.address": "192.0.2.12",
        "host0.public_address": "attacker.example/beacon?leak=1#",
      });
      for (const u of urls) expect(u).not.toMatch(/beacon|leak|#/);
    });

    it("drops userinfo rather than sending it to a third party", async () => {
      const urls = await probedUrls({
        enable_stats_server: "true",
        event_server_address: "user:secret@attacker.example",
      });
      for (const u of urls) {
        expect(u).not.toContain("secret");
        expect(u).not.toContain("@");
      }
    });

    it("yields no candidate for an unparseable host instead of concatenating it", async () => {
      const urls = await probedUrls({
        enable_stats_server: "true",
        event_server_address: "http://[not a host",
      });
      expect(urls).toEqual([]);
    });

    it("still honours an https scheme declared in config", async () => {
      const urls = await probedUrls({
        enable_stats_server: "true",
        event_server_address: "https://statshost",
      });
      expect(urls).toContain(`https://statshost:${DEFAULT_PROM_PORT}`);
    });
  });

  describe("service identity", () => {
    it("tells the probe which service each candidate is supposed to be", async () => {
      // "Something answered on 9090" is not evidence of Prometheus: on RHEL/CentOS
      // Cockpit owns that port by default, including on the database host this falls
      // back to. The probe must be able to reject a lookalike.
      const probe = vi.fn((_url: string, _service: string) => Promise.resolve(true));
      await discoverObservability({ properties: FILE_PROPS, probe });
      const services = probe.mock.calls.map((c) => c[1]);
      expect(services).toContain("prometheus");
      expect(services).toContain("loki");
    });

    it("omits an endpoint whose port answers as the wrong service", async () => {
      const cockpitOn9090 = (_url: string, service: string) =>
        Promise.resolve(service !== "prometheus");
      const found = await discoverObservability({ properties: FILE_PROPS, probe: cockpitOn9090 });
      expect(found.endpoints.promUrl).toBeUndefined();
      expect(found.endpoints.lokiUrl).toBeDefined();
    });
  });

  describe("default probe body checks", () => {
    // These exercise defaultProbe by leaving `probe` unset and stubbing fetch.
    const withFetch = async (handler: (url: string) => Response) => {
      const spy = vi.fn((url: string) => Promise.resolve(handler(url)));
      vi.stubGlobal("fetch", spy);
      try {
        return await discoverObservability({
          properties: { enable_stats_server: "true", event_server_address: "statshost" },
          env: {},
        });
      } finally {
        vi.unstubAllGlobals();
      }
    };

    it("accepts a Loki whose labels window is empty — data is optional there", async () => {
      // Measured live: /loki/api/v1/labels defaults to 6 hours and a quiet cluster
      // answers a bare {"status":"success"} with no data key.
      const found = await withFetch((url) =>
        url.includes("/loki/")
          ? new Response(JSON.stringify({ status: "success" }))
          : new Response("nope", { status: 404 }),
      );
      expect(found.endpoints.lokiUrl).toBe("http://statshost:9080");
    });

    it("rejects a port that answers but is not the service (e.g. Cockpit on 9090)", async () => {
      const found = await withFetch(() => new Response("<html>Cockpit</html>", { status: 200 }));
      expect(found.endpoints.promUrl).toBeUndefined();
      expect(found.endpoints.lokiUrl).toBeUndefined();
    });

    it("requires a version in Prometheus buildinfo", async () => {
      const found = await withFetch((url) =>
        url.includes("/api/v1/status/buildinfo")
          ? new Response(JSON.stringify({ status: "success", data: {} }))
          : new Response("nope", { status: 404 }),
      );
      expect(found.endpoints.promUrl).toBeUndefined();
    });

    it("accepts a real Prometheus buildinfo response", async () => {
      const found = await withFetch((url) =>
        url.includes("/api/v1/status/buildinfo")
          ? new Response(JSON.stringify({ status: "success", data: { version: "3.5.5" } }))
          : new Response("nope", { status: 404 }),
      );
      expect(found.endpoints.promUrl).toBe("http://statshost:9090");
    });
  });

  describe("probing", () => {
    it("omits endpoints that do not answer", async () => {
      const found = await discoverObservability({ properties: FILE_PROPS, probe: allDown });
      expect(found.endpoints).toEqual({});
    });

    it("reports a partial stack — Prometheus up, Loki down", async () => {
      const probe = (url: string) => Promise.resolve(url.includes(String(DEFAULT_PROM_PORT)));
      const found = await discoverObservability({ properties: FILE_PROPS, probe });
      expect(found.endpoints.promUrl).toBe(`http://192.0.2.11:${DEFAULT_PROM_PORT}`);
      expect(found.endpoints.lokiUrl).toBeUndefined();
    });
  });

  describe("unroutable declared address", () => {
    it("falls back to the database host the operator actually reached", async () => {
      // Measured: event_server_address is 192.0.2.11, a host-only network that does
      // not route from where the agent runs. The operator reached the cluster as "dbhost".
      const probe = (url: string) => Promise.resolve(url.includes("dbhost"));
      const found = await discoverObservability({
        properties: FILE_PROPS,
        dbHost: "dbhost",
        probe,
      });
      expect(found.endpoints.promUrl).toBe(`http://dbhost:${DEFAULT_PROM_PORT}`);
      expect(found.endpoints.lokiUrl).toBe(`http://dbhost:${DEFAULT_LOKI_PORT}`);
    });

    it("translates an internal address via its declared hostN.public_address", async () => {
      // gpudb.conf pairs host0.address 192.0.2.12 with host0.public_address
      // 203.0.113.12. An event server co-located with host0 is therefore reachable.
      const probe = (url: string) => Promise.resolve(url.includes("203.0.113.12"));
      const found = await discoverObservability({
        properties: {
          ...FILE_PROPS,
          event_server_address: "192.0.2.12",
          "host0.address": "192.0.2.12",
          "host0.public_address": "203.0.113.12",
        },
        probe,
      });
      expect(found.endpoints.promUrl).toBe(`http://203.0.113.12:${DEFAULT_PROM_PORT}`);
    });

    it("prefers the declared host when it does answer", async () => {
      const found = await discoverObservability({
        properties: FILE_PROPS,
        dbHost: "dbhost",
        probe: allUp,
      });
      expect(found.endpoints.promUrl).toBe(`http://192.0.2.11:${DEFAULT_PROM_PORT}`);
      expect(found.unreachable).toEqual([]);
    });

    it("reports declared-but-dead URLs so 'deployed' is distinguishable from 'absent'", async () => {
      const found = await discoverObservability({ properties: FILE_PROPS, probe: allDown });
      expect(found.endpoints).toEqual({});
      expect(found.unreachable).toContain(`http://192.0.2.11:${DEFAULT_PROM_PORT}`);
      expect(found.unreachable).toContain("http://192.0.2.11:9080");
    });

    it("reports nothing unreachable when there was nothing to try", async () => {
      const found = await discoverObservability({ probe: allDown });
      expect(found.unreachable).toEqual([]);
    });
  });

  describe("never throws", () => {
    it("returns {} with no config and no env", async () => {
      await expect(discoverObservability({ probe: allUp })).resolves.toMatchObject({
        endpoints: {},
      });
    });

    it("returns {} when the stats server is explicitly disabled, without probing", async () => {
      const probe = vi.fn((_url: string) => Promise.resolve(true));
      const found = await discoverObservability({
        properties: { ...FILE_PROPS, enable_stats_server: "false" },
        probe,
      });
      expect(found.endpoints).toEqual({});
      expect(probe).not.toHaveBeenCalled();
    });

    it("treats a throwing probe as a miss", async () => {
      const probe = () => Promise.reject(new Error("ECONNREFUSED"));
      await expect(discoverObservability({ properties: FILE_PROPS, probe })).resolves.toMatchObject(
        { endpoints: {} },
      );
    });

    it("survives a junk property map", async () => {
      await expect(
        discoverObservability({
          properties: { event_server_address: "  ", enable_stats_server: "TRUE" },
          probe: allUp,
        }),
      ).resolves.toMatchObject({ endpoints: {} });
    });
  });
});
