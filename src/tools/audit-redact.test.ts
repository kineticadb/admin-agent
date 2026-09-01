/**
 * Tests for mutation-audit redaction.
 *
 * Covers inline credential scrubbing, length-based fingerprinting, and the
 * always-fingerprint rule for known sensitive keys (config_string).
 */
import { describe, expect, it } from "vitest";
import { redactAuditInput, redactValue, scrubCredentialPatterns } from "./audit-redact.js";

describe("scrubCredentialPatterns", () => {
  it("redacts password='...' in SQL", () => {
    const out = scrubCredentialPatterns("CREATE USER alice WITH PASSWORD = 'hunter2'");
    expect(out).not.toContain("hunter2");
    expect(out).toMatch(/\[REDACTED\]/);
  });

  it("redacts IDENTIFIED BY '...'", () => {
    const out = scrubCredentialPatterns("ALTER USER alice IDENTIFIED BY 'hunter2'");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("IDENTIFIED BY");
  });

  it("redacts apiKey=... in a URL-ish string", () => {
    const out = scrubCredentialPatterns("CREATE SOURCE url=... apiKey=sk-12345");
    expect(out).not.toContain("sk-12345");
    expect(out.toLowerCase()).toContain("apikey");
  });

  it("redacts access_token: ...", () => {
    const out = scrubCredentialPatterns(`{ "access_token": "abcdef" }`);
    expect(out).not.toContain("abcdef");
  });

  it("leaves a clean SELECT unchanged", () => {
    const out = scrubCredentialPatterns("SELECT count(*) FROM ki_objects");
    expect(out).toBe("SELECT count(*) FROM ki_objects");
  });
});

describe("redactValue", () => {
  it("returns short strings after pattern scrubbing", () => {
    expect(redactValue("CREATE INDEX idx ON t(col)")).toBe("CREATE INDEX idx ON t(col)");
  });

  it("fingerprints strings longer than the threshold", () => {
    const big = "x".repeat(500);
    const result = redactValue(big);
    expect(result).toMatch(/^<500 bytes, sha256:[0-9a-f]+…>$/);
  });

  it("recurses into objects", () => {
    const out = redactValue({
      property_updates_map: { subtask_concurrency_limit: "8" },
    });
    expect(out).toEqual({
      property_updates_map: { subtask_concurrency_limit: "8" },
    });
  });

  it("passes non-string primitives through unchanged", () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(true)).toBe(true);
    expect(redactValue(null)).toBe(null);
  });

  it("recurses into arrays", () => {
    const out = redactValue(["SELECT 1", "PASSWORD = 'x'"]);
    expect(out).toEqual(["SELECT 1", "PASSWORD = '[REDACTED]'"]);
  });
});

describe("redactAuditInput", () => {
  it("always fingerprints config_string regardless of length", () => {
    const out = redactAuditInput({ config_string: "rank_count = 2" });
    expect(out.config_string).toMatch(/^<\d+ bytes, sha256:[0-9a-f]+…>$/);
  });

  it("scrubs credentials inside a statement field", () => {
    const out = redactAuditInput({
      statement: "CREATE USER alice WITH PASSWORD = 'hunter2'",
      limit: 100,
    });
    expect(String(out.statement)).not.toContain("hunter2");
    expect(out.limit).toBe(100);
  });

  it("fingerprints long statement strings", () => {
    const out = redactAuditInput({
      statement: "SELECT " + "x".repeat(500),
    });
    expect(String(out.statement)).toMatch(/^<\d+ bytes, sha256:[0-9a-f]+…>$/);
  });

  it("preserves structural keys and scrubs nested values", () => {
    const out = redactAuditInput({
      property_updates_map: {
        ldap_bind_password: "secret-val-12345",
        subtask_concurrency_limit: "8",
      },
    });
    expect(out.property_updates_map).toBeDefined();
    // The raw value here doesn't match the credential pattern (no "password="),
    // but it also isn't long enough to trigger the length-based fingerprint —
    // this test pins the fact that redactAuditInput does NOT try to heuristically
    // detect every sensitive key. Operators relying on property names alone
    // must add them to ALWAYS_FINGERPRINT_KEYS.
    const map = out.property_updates_map as Record<string, string>;
    expect(map.subtask_concurrency_limit).toBe("8");
  });

  it("does not mutate the input object", () => {
    const input = { config_string: "rank_count = 2" };
    redactAuditInput(input);
    expect(input.config_string).toBe("rank_count = 2");
  });
});

// ---------------------------------------------------------------------------
// Inline credential forms found in bundle artifacts
//
// scrubCredentialPatterns is now also the redactor for kinetica_bundle_read_sysinfo
// (ps.txt process args, env dumps) and kinetica_bundle_search_logs (logged SQL).
// Logs are the primary diagnostic evidence, so these patterns must stay targeted:
// a log line that merely mentions "password" must survive intact.
// ---------------------------------------------------------------------------

describe("scrubCredentialPatterns — bundle artifact forms", () => {
  it.each([
    [
      "--password=hunter2 in a process arg",
      "tool --user=admin --password=hunter2 --host=n2",
      "hunter2",
    ],
    ["--password with a space", "python3 load.py --password hunter2 --url http://x", "hunter2"],
    ["env dump KINETICA_PASS", "KINETICA_PASS=hunter2", "hunter2"],
    ["env dump PGPASSWORD", "PGPASSWORD=hunter2", "hunter2"],
    ["env dump AWS_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI", "wJalrXUtnFEMI"],
    ["URL userinfo", "psql 'postgresql://admin:hunter2@dbhost.example:5432/db'", "hunter2"],
    ["SQL SET PASSWORD", "ALTER USER bob SET PASSWORD 'hunter2'", "hunter2"],
    ["SQL IDENTIFIED BY", "CREATE USER bob IDENTIFIED BY 'hunter2'", "hunter2"],
  ])("redacts %s", (_label, input, secret) => {
    expect(scrubCredentialPatterns(input)).not.toContain(secret);
  });

  // Deliberately NOT redacted: single-letter flags are ambiguous. `-p` means a
  // PID to ps, a port to many tools, and a password to mysql. ps.txt is full of
  // `-p <pid>`, and gutting process listings costs more than this covers.
  // A dash inside a word is not a flag: `base-passwd 3.5.47` in dpkg -l output
  // matched "-passwd " and redacted the version. Found against a real bundle.
  it.each([
    "ii  base-passwd     3.5.47     amd64   Debian base system master password",
    "ii  libpam-passwdqc 1.3.1      amd64   password strength checker",
    "my-secret-service.conf loaded",
  ])("does not treat a dash inside a word as a flag: %s", (line) => {
    expect(scrubCredentialPatterns(line)).toBe(line);
  });

  it("leaves ambiguous single-letter flags alone", () => {
    const line = "gpudb 74100 ps -p 74100 -o comm=";
    expect(scrubCredentialPatterns(line)).toBe(line);
  });

  it.each([
    "2026-08-31 12:00:00.000 ERROR (1,2,r0/x) n2 Rank0RamPool::acquire failed: Avail 793900000",
    "2026-08-31 12:00:00.000 WARN password policy check failed for user bob",
    "2026-08-31 12:00:00.000 INFO tps_per_tom = 4 threads started",
    "2026-08-31 12:00:00.000 INFO min_password_length = 0",
    "2026-08-31 12:00:00.000 INFO Executing SQL: SELECT count(*) FROM nyctaxi",
  ])("leaves diagnostic evidence intact: %s", (line) => {
    expect(scrubCredentialPatterns(line)).toBe(line);
  });
});
