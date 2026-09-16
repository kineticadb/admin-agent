/**
 * Tests for the eval mock session.
 *
 * The mock had no tests because it was only ever consumed by `*.eval.ts` files, which
 * vitest excludes — so a wrong endpoint key or response shape could only be discovered
 * by paying for a live run. That is exactly the loop this repo decided not to debug
 * through the API (see README, "never debug the harness through the API").
 */

import { describe, it, expect } from "vitest";

import {
  createMockSession,
  createStaleRankSession,
  createUnappliedConfigSession,
} from "./mock-session.js";

/** Unwrap Kinetica's double-encoded data_str envelope. */
async function readDataStr(response: Response): Promise<Record<string, unknown>> {
  const outer = (await response.json()) as { data_str: string };
  return JSON.parse(outer.data_str) as Record<string, unknown>;
}

describe("createMockSession", () => {
  it("reports a healthy two-rank cluster by default", async () => {
    const session = createMockSession();
    const body = await readDataStr(await session.makeRequest("/show/system/status"));
    const statusMap = body.status_map as Record<string, string>;
    expect(statusMap.system_status).toBe("running");
    expect(statusMap["rank1.state"]).toBe("running");
  });

  it("returns an empty success for an endpoint nobody mocked", async () => {
    const session = createMockSession();
    const body = await readDataStr(await session.makeRequest("/some/unmocked/endpoint"));
    expect(body).toEqual({});
  });

  it("routes host-manager requests to port 9300", async () => {
    const session = createMockSession();
    const body = (await (await session.makeRequestToPort!(9300, "/")).json()) as {
      ranks: { rank: number; status: string }[];
    };
    expect(body.ranks.map((r) => r.status)).toEqual(["running", "running"]);
  });
});

describe("createStaleRankSession", () => {
  // Without a genuinely down rank the agent has nothing to restart, the remediation
  // touches no service, and the service-management trigger is never exercised.
  it("reports rank 2 as not responding", async () => {
    const session = createStaleRankSession();
    const body = await readDataStr(await session.makeRequest("/show/system/status"));
    const statusMap = body.status_map as Record<string, string>;
    expect(statusMap.system_status).toBe("degraded");
    expect(statusMap["rank2.state"]).toBe("not_responding");
  });

  it("shows rank 2 stopped in the host manager, on the endpoint the tool actually calls", async () => {
    const session = createStaleRankSession();
    const body = (await (await session.makeRequestToPort!(9300, "/")).json()) as {
      system_status: string;
      ranks: { rank: number; status: string }[];
    };
    expect(body.system_status).toBe("degraded");
    expect(body.ranks.find((r) => r.rank === 2)?.status).toBe("stopped");
  });

  it("keeps the other default endpoints intact", async () => {
    const session = createStaleRankSession();
    const body = await readDataStr(await session.makeRequest("/show/system/properties"));
    expect(body.property_map).toBeDefined();
  });

  it("leaves the default session untouched — no shared mutable state", async () => {
    createStaleRankSession();
    const healthy = await readDataStr(await createMockSession().makeRequest("/show/system/status"));
    expect((healthy.status_map as Record<string, string>).system_status).toBe("running");
  });
});

describe("createUnappliedConfigSession", () => {
  // Probes the INCIDENTAL-restart case: the investigation is about throughput, but the
  // only correct remediation is a service restart. See the factory's doc comment.
  it("reports the FILE value, which is what /show/system/properties actually returns", async () => {
    const session = createUnappliedConfigSession();
    const body = await readDataStr(await session.makeRequest("/show/system/properties"));
    const props = body.property_map as Record<string, string>;
    expect(props["conf.tps_per_tom"]).toBe("8");
  });

  it("keeps conf.hm_http_port, which discoverHmPort() needs for the 9300 tools", async () => {
    const session = createUnappliedConfigSession();
    const body = await readDataStr(await session.makeRequest("/show/system/properties"));
    const props = body.property_map as Record<string, string>;
    expect(props["conf.hm_http_port"]).toBe("9300");
  });

  it("has the host-manager config agree with /show — both read the file, neither the process", async () => {
    const session = createUnappliedConfigSession();
    const body = await readDataStr(
      await session.makeRequestToPort!(9300, "/admin/show/configuration"),
    );
    expect(body.config_string).toContain("tps_per_tom = 8");
  });

  it("is otherwise a healthy cluster, so nothing derails the investigation", async () => {
    const session = createUnappliedConfigSession();
    const body = await readDataStr(await session.makeRequest("/show/system/status"));
    const statusMap = body.status_map as Record<string, string>;
    expect(statusMap.system_status).toBe("running");
  });
});
