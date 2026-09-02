import { describe, it, expect, vi } from "vitest";

// observability-setup.ts does not exist yet — these tests define the expected contract.
// They MUST fail on first run (RED phase).

import { setupObservability } from "./observability-setup.js";
import type { KineticaSession } from "../types/index.js";
import type { BundleSource } from "../bundle/BundleSource.js";

/** /show/system/properties response envelope, conf.-prefixed as measured. */
function propsResponse(map: Record<string, string>): Response {
  return new Response(
    JSON.stringify({
      status: "OK",
      data_str: JSON.stringify({ property_map: map, info: {} }),
    }),
  );
}

const LIVE_PROPS = {
  "conf.enable_stats_server": "TRUE",
  "conf.event_server_address": "192.0.2.11",
  "conf.event_server_internal": "FALSE",
};

function sessionWith(map: Record<string, string>): KineticaSession {
  return {
    baseUrl: "http://dbhost:9191",
    makeRequest: vi.fn().mockResolvedValue(propsResponse(map)),
  };
}

function bundleWith(entries: { section: string; key: string; value: string }[]): BundleSource {
  return {
    readConfig: vi.fn().mockResolvedValue({ entries, file: "gpudb.conf" }),
  } as unknown as BundleSource;
}

const allUp = () => Promise.resolve(true);
const allDown = () => Promise.resolve(false);

describe("bundle config is not trusted to name a network target", () => {
  // The repo's own position (bundle-index.ts): "a support bundle is untrusted input".
  // A bundle arrives as a customer artifact via ticket or email, so a value inside it
  // must never become the host of an outbound request.
  it("ignores a host named by a bundle, while still taking its port", async () => {
    const probe = vi.fn((_url: string, _s: string) => Promise.resolve(false));
    const bundle = bundleWith([
      { section: "gaia", key: "enable_stats_server", value: "true" },
      { section: "gaia", key: "event_server_address", value: "attacker.example" },
      { section: "gaia", key: "event_server_public_address", value: "attacker.example" },
      { section: "gaia", key: "event_server_port", value: "19080" },
    ]);

    await setupObservability({
      session: sessionWith(LIVE_PROPS),
      bundleSource: bundle,
      probe,
      env: {},
    });

    const probed = probe.mock.calls.map((c) => String(c[0]));
    expect(probed.some((u) => u.includes("attacker.example"))).toBe(false);
    // The live-session host is still used, and the bundle's PORT still applies to Loki.
    expect(probed).toContain("http://192.0.2.11:9090");
    expect(probed).toContain("http://192.0.2.11:19080");
  });

  it("does not let a bundle poison the hostN.public_address translation", async () => {
    const probe = vi.fn((_url: string, _s: string) => Promise.resolve(false));
    const bundle = bundleWith([
      { section: "gaia", key: "enable_stats_server", value: "true" },
      { section: "gaia", key: "host0.address", value: "192.0.2.11" },
      { section: "gaia", key: "host0.public_address", value: "attacker.example" },
    ]);

    await setupObservability({
      session: sessionWith(LIVE_PROPS),
      bundleSource: bundle,
      probe,
      env: {},
    });

    expect(probe.mock.calls.map((c) => String(c[0])).some((u) => u.includes("attacker"))).toBe(
      false,
    );
  });

  it("falls back to no observability rather than probing a bundle-named host", async () => {
    const probe = vi.fn((_url: string, _s: string) => Promise.resolve(false));
    const bundle = bundleWith([
      { section: "gaia", key: "enable_stats_server", value: "true" },
      { section: "gaia", key: "event_server_address", value: "attacker.example" },
    ]);

    const r = await setupObservability({ bundleSource: bundle, probe, env: {} });

    expect(probe).not.toHaveBeenCalled();
    expect(r.client).toBeUndefined();
  });
});

describe("operator-supplied stats host", () => {
  it("uses the host collected at startup, outranking gpudb.conf", async () => {
    // collectCredentials asks for this right after the password, because the address in
    // gpudb.conf is the cluster's internal one and rarely routes from the agent.
    const probe = (url: string) => Promise.resolve(url.includes("statshost"));
    const r = await setupObservability({
      session: sessionWith(LIVE_PROPS),
      statsHost: "http://statshost",
      probe,
      env: {},
    });
    expect(r.client?.promUrl).toBe("http://statshost:9090");
    expect(r.client?.lokiUrl).toBe("http://statshost:9080");
  });

  it("keeps a declared non-default Loki port alongside the supplied host", async () => {
    const bundle = bundleWith([
      { section: "gaia", key: "event_server_address", value: "192.0.2.11" },
      { section: "gaia", key: "event_server_port", value: "19080" },
    ]);
    const r = await setupObservability({
      bundleSource: bundle,
      statsHost: "statshost",
      probe: (url: string) => Promise.resolve(url.includes("statshost")),
      env: {},
    });
    expect(r.client?.lokiUrl).toBe("http://statshost:19080");
  });

  it("blames the supplied host, not gpudb.conf, when it does not answer", async () => {
    const r = await setupObservability({
      session: sessionWith(LIVE_PROPS),
      statsHost: "typoed",
      probe: allDown,
      env: {},
    });
    expect(r.line).toContain("KINETICA_STATS_HOST=typoed");
    expect(r.line).not.toContain("gpudb.conf names the stats host");
  });

  it("falls back to gpudb.conf when the operator supplied nothing", async () => {
    // Still correct for an agent running on the cluster network.
    const r = await setupObservability({
      session: sessionWith(LIVE_PROPS),
      probe: allUp,
      env: {},
    });
    expect(r.client?.promUrl).toBe("http://192.0.2.11:9090");
  });
});

describe("setupObservability", () => {
  describe("property sources", () => {
    it("reads event_server_address from a live session's system properties", async () => {
      const r = await setupObservability({
        session: sessionWith(LIVE_PROPS),
        probe: allUp,
        env: {},
      });
      expect(r.client?.promUrl).toBe("http://192.0.2.11:9090");
      expect(r.client?.lokiUrl).toBe("http://192.0.2.11:9080");
    });

    it("takes a bundle's PORT but requires the host from a trusted source", async () => {
      // Changed deliberately: a bundle is untrusted input, so it may not name the host of
      // an outbound request. It remains the only source of event_server_port, and that is
      // still honoured — here against the operator-supplied host.
      const bundle = bundleWith([
        { section: "gaia", key: "enable_stats_server", value: "true" },
        { section: "gaia", key: "event_server_address", value: "192.0.2.11" },
        { section: "gaia", key: "event_server_port", value: "19080" },
      ]);
      const r = await setupObservability({
        bundleSource: bundle,
        statsHost: "statshost",
        probe: allUp,
        env: {},
      });
      expect(r.client?.lokiUrl).toBe("http://statshost:19080");
      expect(r.client?.promUrl).toBe("http://statshost:9090");
    });

    it("prefers the live value when both name the same key", async () => {
      const bundle = bundleWith([
        { section: "gaia", key: "event_server_address", value: "192.0.2.99" },
      ]);
      const r = await setupObservability({
        session: sessionWith(LIVE_PROPS),
        bundleSource: bundle,
        probe: allUp,
        env: {},
      });
      // Live wins only because both maps are normalized to the bare spelling first —
      // otherwise conf.event_server_address and event_server_address never collide and
      // lookupProperty's exact-match-first order silently prefers the bundle.
      expect(r.client?.promUrl).toContain("192.0.2.11");
    });

    it("fills a live gap from the bundle — /show omits event_server_port entirely", async () => {
      // A --bundle run against a reachable cluster: the live map has the address but
      // never the port, and the bundle is the only place the port exists.
      const bundle = bundleWith([{ section: "gaia", key: "event_server_port", value: "19080" }]);
      const r = await setupObservability({
        session: sessionWith(LIVE_PROPS),
        bundleSource: bundle,
        probe: allUp,
        env: {},
      });
      expect(r.client?.lokiUrl).toBe("http://192.0.2.11:19080");
    });

    it("lets the gaia section win when another section reuses a bare key", async () => {
      // gpudb.conf is a sectioned ini; the same bare key can recur legitimately. Asserted
      // on a port, since host keys are no longer accepted from a bundle at all.
      const bundle = bundleWith([
        { section: "sql", key: "event_server_port", value: "17777" },
        { section: "gaia", key: "event_server_port", value: "19080" },
        { section: "text", key: "event_server_port", value: "18888" },
      ]);
      const r = await setupObservability({
        bundleSource: bundle,
        statsHost: "statshost",
        probe: allUp,
        env: {},
      });
      expect(r.client?.lokiUrl).toBe("http://statshost:19080");
    });

    it("passes the session's hostname as the fallback probe target", async () => {
      const probe = vi.fn((url: string) => Promise.resolve(url.includes("dbhost")));
      const r = await setupObservability({ session: sessionWith(LIVE_PROPS), probe, env: {} });
      expect(r.client?.promUrl).toBe("http://dbhost:9090");
    });
  });

  describe("status line", () => {
    it("names each service that answered", async () => {
      const r = await setupObservability({
        session: sessionWith(LIVE_PROPS),
        probe: allUp,
        env: {},
      });
      expect(r.line).toContain("Prometheus");
      expect(r.line).toContain("Loki");
    });

    it("distinguishes declared-but-unreachable from absent, and names the fix", async () => {
      const r = await setupObservability({
        session: sessionWith(LIVE_PROPS),
        probe: allDown,
        env: {},
      });
      expect(r.client).toBeUndefined();
      expect(r.line).toMatch(/unreachable/i);
      expect(r.line).toContain("KINETICA_STATS_HOST");
    });

    it("blames the override, not gpudb.conf, when KINETICA_STATS_HOST is wrong", async () => {
      const r = await setupObservability({
        session: sessionWith(LIVE_PROPS),
        env: { KINETICA_STATS_HOST: "typoed" },
        probe: allDown,
      });
      expect(r.line).toContain("KINETICA_STATS_HOST=typoed");
      // gpudb.conf may be mentioned as the FALLBACK, but must not be blamed for the
      // failure — that would send the operator to the wrong file.
      expect(r.line).not.toContain("gpudb.conf names the stats host");
      expect(r.line).toContain("Check the hostname");
    });

    it("says none detected when nothing was even declared", async () => {
      const r = await setupObservability({ session: sessionWith({}), probe: allDown, env: {} });
      expect(r.client).toBeUndefined();
      expect(r.line).toMatch(/none detected/i);
      expect(r.line).not.toMatch(/unreachable/i);
    });
  });

  describe("never blocks startup", () => {
    it("degrades when the properties call fails", async () => {
      const session: KineticaSession = {
        baseUrl: "http://dbhost:9191",
        makeRequest: vi.fn().mockRejectedValue(new Error("boom")),
      };
      const r = await setupObservability({ session, probe: allDown, env: {} });
      expect(r.client).toBeUndefined();
      // Nothing was declared (the properties read failed), so this is absence,
      // not an unreachable deployment.
      expect(r.line).toMatch(/none detected/i);
    });

    it("degrades when the bundle config read errors", async () => {
      const bundle = { readConfig: vi.fn().mockResolvedValue({ error: "no config" }) };
      const r = await setupObservability({
        bundleSource: bundle as unknown as BundleSource,
        probe: allUp,
        env: {},
      });
      expect(r.client).toBeUndefined();
    });

    it("still honours KINETICA_STATS_HOST with no session and no bundle", async () => {
      const r = await setupObservability({
        env: { KINETICA_STATS_HOST: "statshost" },
        probe: allUp,
      });
      expect(r.client?.promUrl).toBe("http://statshost:9090");
    });
  });
});
