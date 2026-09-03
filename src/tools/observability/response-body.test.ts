import { describe, it, expect } from "vitest";

import { promError, readLokiBody, readPromBody } from "./response-body.js";

const response = (body: string, status = 200) => new Response(body, { status });

describe("promError", () => {
  it("returns undefined for a body with no error field", () => {
    expect(promError({ status: "success", data: {} })).toBeUndefined();
  });

  it("returns undefined for non-object bodies", () => {
    // The null case matters: `typeof null === "object"`, so a bare typeof check would
    // read through it and throw on destructuring.
    expect(promError(null)).toBeUndefined();
    expect(promError("nope")).toBeUndefined();
    expect(promError(undefined)).toBeUndefined();
  });

  it("prefixes errorType, which names the class of failure", () => {
    expect(promError({ error: "bad query", errorType: "bad_data" })).toBe("bad_data: bad query");
  });

  it("returns a bare error when errorType is absent or not a string", () => {
    expect(promError({ error: "boom" })).toBe("boom");
    expect(promError({ error: "boom", errorType: 7 })).toBe("boom");
  });
});

describe("readPromBody", () => {
  it("decodes a healthy body and carries raw + status for shape-level rejection", () => {
    const raw = '{"status":"success","data":{"groups":[]}}';
    return readPromBody(response(raw)).then((decoded) => {
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.body).toEqual({ status: "success", data: { groups: [] } });
      expect(decoded.raw).toBe(raw);
      expect(decoded.status).toBe(200);
    });
  });

  it("rejects a non-JSON body and keeps it for inspection", async () => {
    const decoded = await readPromBody(response("<html>502</html>", 502));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error).toContain("non-JSON body");
    expect(decoded.status).toBe(502);
    expect(decoded.raw).toBe("<html>502</html>");
  });

  it("reports an HTTP failure with no body-level error", async () => {
    const decoded = await readPromBody(response('{"status":"error"}', 503));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error).toContain("HTTP 503");
  });

  it("rejects a 200 that carries a body-level error", async () => {
    // The load-bearing case: HTTP 200 + status "error" is how Prometheus rejects a query.
    const decoded = await readPromBody(
      response('{"status":"error","errorType":"bad_data","error":"parse error"}', 200),
    );
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.status).toBe(200);
    expect(decoded.error).toBe("bad_data: parse error");
  });

  it("prefers the body-level error over the HTTP status when both are present", async () => {
    const decoded = await readPromBody(response('{"error":"too many samples"}', 422));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error).toBe("too many samples");
  });
});

describe("readLokiBody", () => {
  it("decodes a healthy body", async () => {
    const decoded = await readLokiBody(response('{"status":"success","data":{"result":[]}}'));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.body).toEqual({ status: "success", data: { result: [] } });
  });

  it("names Loki, not Prometheus, in a non-JSON refusal", async () => {
    // Loki's LogQL parse errors arrive as a plain-text body, so this branch is the one a
    // bad selector actually lands in — naming the wrong service would misdirect the fix.
    const decoded = await readLokiBody(response("parse error at line 1", 400));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error).toBe("Loki returned a non-JSON body (HTTP 400).");
  });

  it("appends the LogQL hint to an HTTP failure", async () => {
    const decoded = await readLokiBody(response('{"status":"error"}', 400));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error).toBe(
      "Loki request failed with HTTP 400. Check the LogQL selector syntax.",
    );
  });

  it("does NOT apply the Prometheus 200-level error check", async () => {
    // Deliberate, not an oversight: applying Prometheus' check here would reject a
    // healthy Loki response whose payload happens to carry an `error` field.
    const decoded = await readLokiBody(response('{"status":"error","error":"nope"}', 200));
    expect(decoded.ok).toBe(true);
  });
});
