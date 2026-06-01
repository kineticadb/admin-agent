import { describe, it, expect, vi } from "vitest";
import { VerifyDbSchema, verifyDb } from "./verify-db.js";
import type { KineticaSession } from "../../types/index.js";

// verify-db.ts does not exist yet — these tests define the expected contract
// They MUST fail on first run (RED phase)

function makeSession(body: unknown, statusCode = 200): KineticaSession {
  if (statusCode !== 200) {
    return {
      baseUrl: "http://localhost:9191",
      makeRequest: vi
        .fn()
        .mockResolvedValue(new Response(`HTTP error ${statusCode}`, { status: statusCode })),
    };
  }

  return {
    baseUrl: "http://localhost:9191",
    makeRequest: vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
  };
}

const SAMPLE_RESPONSE = {
  status: "OK",
  data_str: JSON.stringify({
    verified_ok: true,
    error_list: [],
    orphaned_tables_total_size: 0,
  }),
};

// ---- Schema validation ----

describe("VerifyDbSchema", () => {
  it("accepts empty object", () => {
    const result = VerifyDbSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts all optional boolean params", () => {
    const result = VerifyDbSchema.safeParse({
      verify_nulls: true,
      verify_persist: false,
      verify_rank0: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-boolean values", () => {
    const result = VerifyDbSchema.safeParse({ verify_nulls: "yes" });
    expect(result.success).toBe(false);
  });
});

// ---- verifyDb function ----

describe("verifyDb", () => {
  it("returns ok:true with verified_ok/error_list/orphaned_tables_total_size on 200 response", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = VerifyDbSchema.parse({});
    const result = await verifyDb(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as {
        verified_ok: boolean;
        error_list: unknown[];
        orphaned_tables_total_size: number;
      };
      expect(data.verified_ok).toBe(true);
      expect(data.error_list).toEqual([]);
      expect(data.orphaned_tables_total_size).toBe(0);
    }
  });

  it("SAFETY: always includes concurrent_safe:true in request body", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = VerifyDbSchema.parse({});
    await verifyDb(session, input);

    const callArgs = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls[0];
    const requestBody = callArgs[1] as { options: Record<string, string> };
    expect(requestBody.options.concurrent_safe).toBe("true");
  });

  it("SAFETY: never includes delete_orphaned_tables in request body", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = VerifyDbSchema.parse({});
    await verifyDb(session, input);

    const callArgs = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls[0];
    const requestBody = callArgs[1] as { options: Record<string, string> };
    expect(requestBody.options).not.toHaveProperty("delete_orphaned_tables");
  });

  it("SAFETY: never includes rebuild_on_error in request body", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = VerifyDbSchema.parse({});
    await verifyDb(session, input);

    const callArgs = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls[0];
    const requestBody = callArgs[1] as { options: Record<string, string> };
    expect(requestBody.options).not.toHaveProperty("rebuild_on_error");
  });

  it("maps verify_nulls/verify_persist/verify_rank0 to string options when set", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = VerifyDbSchema.parse({
      verify_nulls: true,
      verify_persist: false,
      verify_rank0: true,
    });
    await verifyDb(session, input);

    const callArgs = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls[0];
    const requestBody = callArgs[1] as { options: Record<string, string> };
    expect(requestBody.options.verify_nulls).toBe("true");
    expect(requestBody.options.verify_persist).toBe("false");
    expect(requestBody.options.verify_rank0).toBe("true");
  });

  it("calls /admin/verifydb endpoint", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = VerifyDbSchema.parse({});
    await verifyDb(session, input);

    expect(session.makeRequest).toHaveBeenCalledWith("/admin/verifydb", expect.any(Object));
  });

  it("returns ok:false with status on non-200 response", async () => {
    const session = makeSession(null, 503);
    const input = VerifyDbSchema.parse({});
    const result = await verifyDb(session, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.error).toBe("HTTP 503");
    }
  });

  it("returns ok:false with parse error on invalid JSON", async () => {
    const session: KineticaSession = {
      baseUrl: "http://localhost:9191",
      makeRequest: vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })),
    };

    const input = VerifyDbSchema.parse({});
    const result = await verifyDb(session, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(200);
      expect(result.error).toMatch(/JSON parse error/);
    }
  });

  it("returns ok:false when data_str is a malformed JSON string", async () => {
    const session = makeSession({
      status: "OK",
      data_str: "not-valid-json",
    });

    const input = VerifyDbSchema.parse({});
    const result = await verifyDb(session, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/data_str parse error/);
    }
  });

  it("never throws — network errors return ok:false", async () => {
    const session: KineticaSession = {
      baseUrl: "http://localhost:9191",
      makeRequest: vi.fn().mockRejectedValue(new Error("Connection refused")),
    };

    const input = VerifyDbSchema.parse({});
    await expect(verifyDb(session, input)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Connection refused"),
    });
  });
});
