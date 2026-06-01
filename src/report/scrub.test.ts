/**
 * Tests for credential scrubbing utility.
 *
 * Verifies that scrubCredentials() removes all credential patterns
 * and returns new strings without mutating the original.
 */

import { describe, it, expect } from "vitest";
import {
  scrubCredentials,
  redactConfigSecrets,
  DEFAULT_SCRUB_PATTERNS,
  CONFIG_SECRET_PATTERN,
} from "./scrub.js";

describe("scrubCredentials", () => {
  describe("HTTP/HTTPS URL scrubbing", () => {
    it("scrubs https URLs", () => {
      const input = "Connected to https://kinetica.example.com:9191/api";
      const result = scrubCredentials(input);
      expect(result).toBe("Connected to [REDACTED]");
      expect(result).not.toContain("kinetica.example.com");
    });

    it("scrubs http URLs", () => {
      const input = "Connecting to http://localhost:9191/show/system/status";
      const result = scrubCredentials(input);
      expect(result).toBe("Connecting to [REDACTED]");
      expect(result).not.toContain("localhost");
    });

    it("scrubs URLs with path components", () => {
      const input = "Error fetching https://db.company.com:8080/api/v2/health";
      const result = scrubCredentials(input);
      expect(result).not.toContain("db.company.com");
      expect(result).toContain("[REDACTED]");
    });
  });

  describe("Basic auth header scrubbing", () => {
    it("scrubs Basic auth tokens", () => {
      const input = "Authorization header: Basic dXNlcjpwYXNz";
      const result = scrubCredentials(input);
      expect(result).not.toContain("dXNlcjpwYXNz");
      expect(result).toContain("[REDACTED]");
    });

    it("scrubs Basic auth with padding", () => {
      const input = "Using Basic dXNlcjpwYXNzd29yZA==";
      const result = scrubCredentials(input);
      expect(result).not.toContain("dXNlcjpwYXNzd29yZA==");
      expect(result).toContain("[REDACTED]");
    });
  });

  describe("Bearer token scrubbing", () => {
    it("scrubs Bearer tokens", () => {
      const input = "Token: Bearer abc123.xyz.token";
      const result = scrubCredentials(input);
      expect(result).not.toContain("abc123.xyz.token");
      expect(result).toContain("[REDACTED]");
    });

    it("scrubs Bearer tokens with hyphens", () => {
      const input = "Authorization: Bearer my-secret-token-value";
      const result = scrubCredentials(input);
      expect(result).not.toContain("my-secret-token-value");
      expect(result).toContain("[REDACTED]");
    });
  });

  describe("Password value scrubbing", () => {
    it("scrubs password: values", () => {
      const input = "password: mysecret123";
      const result = scrubCredentials(input);
      expect(result).not.toContain("mysecret123");
      expect(result).toContain("[REDACTED]");
    });

    it("scrubs password with colon and space", () => {
      const input = "Using password: hunter2";
      const result = scrubCredentials(input);
      expect(result).not.toContain("hunter2");
      expect(result).toContain("[REDACTED]");
    });
  });

  describe("Authorization header scrubbing", () => {
    it("scrubs Authorization header values", () => {
      const input = "Authorization: Basic abc123";
      const result = scrubCredentials(input);
      expect(result).not.toContain("abc123");
      expect(result).toContain("[REDACTED]");
    });

    it("scrubs Authorization header with multiple parts", () => {
      const input = "Set Authorization: Bearer token.value.here";
      const result = scrubCredentials(input);
      expect(result).not.toContain("token.value.here");
      expect(result).toContain("[REDACTED]");
    });
  });

  describe("Content preservation", () => {
    it("preserves non-credential content unchanged", () => {
      const input = "## Summary\nThe query was slow";
      const result = scrubCredentials(input);
      expect(result).toBe("## Summary\nThe query was slow");
    });

    it("handles empty string", () => {
      const result = scrubCredentials("");
      expect(result).toBe("");
    });

    it("handles content with no credentials", () => {
      const input = "Root cause: GPU memory exhaustion detected in rank 2";
      const result = scrubCredentials(input);
      expect(result).toBe("Root cause: GPU memory exhaustion detected in rank 2");
    });

    it("preserves plain text report content", () => {
      const report = `## Root Cause Analysis
The system experienced high GPU memory pressure.

## Evidence Collected
- Memory usage: 98% on rank 2
- Error count: 47 OOM errors in last hour`;
      const result = scrubCredentials(report);
      expect(result).toBe(report);
    });
  });

  describe("Multiple credentials in one string", () => {
    it("scrubs all credential occurrences", () => {
      const input = "Connect to https://kinetica.example.com:9191 with Basic dXNlcjpwYXNz";
      const result = scrubCredentials(input);
      expect(result).not.toContain("kinetica.example.com");
      expect(result).not.toContain("dXNlcjpwYXNz");
    });

    it("scrubs multiple URLs", () => {
      const input = "Primary: https://host1.com:9191/api, Secondary: https://host2.com:9191/api";
      const result = scrubCredentials(input);
      expect(result).not.toContain("host1.com");
      expect(result).not.toContain("host2.com");
    });
  });

  describe("Immutability", () => {
    it("returns a new string, not the original", () => {
      const input = "Connected to https://kinetica.example.com:9191/api";
      const result = scrubCredentials(input);
      // Input with credentials should still be unchanged
      expect(input).toContain("kinetica.example.com");
      // Result should have credentials removed
      expect(result).not.toContain("kinetica.example.com");
    });

    it("does not mutate input when no credentials found", () => {
      const input = "No credentials here";
      const result = scrubCredentials(input);
      expect(result).toBe(input);
      expect(input).toBe("No credentials here");
    });
  });

  describe("Custom patterns", () => {
    it("accepts custom patterns array", () => {
      const customPatterns = [/secret-\w+/gi];
      const input = "Token: secret-abc123";
      const result = scrubCredentials(input, customPatterns);
      expect(result).not.toContain("secret-abc123");
      expect(result).toContain("[REDACTED]");
    });

    it("uses only custom patterns when provided (not defaults)", () => {
      const customPatterns = [/CUSTOM_PATTERN/g];
      const input = "https://kinetica.example.com/api";
      // Custom patterns don't include URL scrubbing, so URL should remain
      const result = scrubCredentials(input, customPatterns);
      // URL not scrubbed since custom patterns don't include URL pattern
      expect(result).toContain("kinetica.example.com");
    });
  });

  describe("Expanded credential patterns (M-1)", () => {
    it("scrubs JSON-quoted password values", () => {
      const input = `{"username":"alice","password":"hunter2"}`;
      const result = scrubCredentials(input);
      expect(result).not.toContain("hunter2");
      expect(result).toContain("[REDACTED]");
    });

    it("scrubs api_key=... form", () => {
      const input = "Connecting with api_key=sk-proj-abc123xyz";
      const result = scrubCredentials(input);
      expect(result).not.toContain("sk-proj-abc123xyz");
      expect(result).toContain("[REDACTED]");
    });

    it("scrubs access-token: JSON form", () => {
      const input = `{ "access-token": "eyJhbGciOiJIUzI1NiJ9.payload" }`;
      const result = scrubCredentials(input);
      expect(result).not.toContain("eyJhbGciOiJIUzI1NiJ9.payload");
    });

    it("scrubs Cookie header", () => {
      const input = "Cookie: sessionid=abc123; theme=dark";
      const result = scrubCredentials(input);
      expect(result).not.toContain("abc123");
      expect(result).toContain("[REDACTED]");
    });

    it("scrubs Set-Cookie header", () => {
      const input = "Set-Cookie: auth=jwt.token.here; HttpOnly";
      const result = scrubCredentials(input);
      expect(result).not.toContain("jwt.token.here");
    });

    it("scrubs secret=... assignment", () => {
      const input = "Using secret = 'my-deploy-secret'";
      const result = scrubCredentials(input);
      expect(result).not.toContain("my-deploy-secret");
    });
  });

  describe("DEFAULT_SCRUB_PATTERNS", () => {
    it("exports DEFAULT_SCRUB_PATTERNS as a readonly array", () => {
      expect(Array.isArray(DEFAULT_SCRUB_PATTERNS)).toBe(true);
      expect(DEFAULT_SCRUB_PATTERNS.length).toBeGreaterThan(0);
    });

    it("contains RegExp instances", () => {
      for (const pattern of DEFAULT_SCRUB_PATTERNS) {
        expect(pattern).toBeInstanceOf(RegExp);
      }
    });
  });

  // Regression suite for the gpudb.conf INI secret-exposure finding.
  // gpudb.conf uses `key = value` lines; the original patterns either matched
  // no pattern (license_key) or matched only the keyword and left the value
  // (security.ldap_bind_password = secret -> the value survived).
  describe("gpudb.conf INI secret scrubbing", () => {
    // Each row: [description, single config line, the secret value that must vanish].
    // license_key previously matched no pattern; prefixed/dotted keys like
    // security.ldap_bind_password matched only the keyword and left the value.
    it.each([
      [
        "license_key (previously matched no pattern)",
        "license_key = TRIAL-9F3A-22BC-7E10-PROD-LICENSE-KEY",
        "TRIAL-9F3A-22BC-7E10-PROD-LICENSE-KEY",
      ],
      [
        "the value of a prefixed password key, not just the keyword",
        "security.ldap_bind_password = MyDirectoryPassw0rd",
        "MyDirectoryPassw0rd",
      ],
      ["ssl_keystore_password", "ssl_keystore_password = keystorePass!", "keystorePass!"],
      ["ssl_truststore_password", "ssl_truststore_password = trustPass123", "trustPass123"],
      ["private_key", "private_key = -----BEGIN-KEY-----abcdef", "abcdef"],
      ["passphrase", "ssl_key_passphrase = sup3rSecretPhrase", "sup3rSecretPhrase"],
      ["colon-separated INI values", "password: hunter2", "hunter2"],
    ])("redacts %s", (_label, input, secret) => {
      const result = scrubCredentials(input);
      expect(result).not.toContain(secret);
      expect(result).toContain("[REDACTED]");
    });

    it("scrubs every secret in a multi-line gpudb.conf excerpt", () => {
      const conf = [
        "[gpudb]",
        "license_key = TRIAL-9F3A-22BC-7E10",
        "security.ldap_bind_password = MyDirectoryPassw0rd",
        "ssl_keystore_password = keystorePass!",
      ].join("\n");
      const result = scrubCredentials(conf);
      expect(result).not.toContain("TRIAL-9F3A-22BC-7E10");
      expect(result).not.toContain("MyDirectoryPassw0rd");
      expect(result).not.toContain("keystorePass!");
    });

    it("preserves non-secret config lines unchanged", () => {
      const input = "worker_endpoint_threads = 8";
      const result = scrubCredentials(input);
      expect(result).toBe("worker_endpoint_threads = 8");
    });
  });

  describe("redactConfigSecrets", () => {
    it("preserves the key name while masking the value", () => {
      const result = redactConfigSecrets("security.ldap_bind_password = MyDirectoryPassw0rd");
      expect(result).toBe("security.ldap_bind_password = [REDACTED]");
    });

    it("masks license_key value while keeping the key", () => {
      const result = redactConfigSecrets("license_key = TRIAL-9F3A-22BC");
      expect(result).toBe("license_key = [REDACTED]");
    });

    it("leaves non-secret keys untouched (preserves diagnostic utility)", () => {
      const conf = "[gpudb]\nenable_audit = false\nworker_endpoint_threads = 8\n";
      expect(redactConfigSecrets(conf)).toBe(conf);
    });

    it("only masks the secret line in a mixed config", () => {
      const conf = "max_concurrent = 10\nadmin_password = topsecret\ntier_strategy = default";
      const result = redactConfigSecrets(conf);
      expect(result).toContain("max_concurrent = 10");
      expect(result).toContain("tier_strategy = default");
      expect(result).toContain("admin_password = [REDACTED]");
      expect(result).not.toContain("topsecret");
    });

    it("is a pure function — does not mutate input", () => {
      const input = "license_key = SECRET123";
      const result = redactConfigSecrets(input);
      expect(input).toBe("license_key = SECRET123");
      expect(result).not.toBe(input);
    });

    it("returns empty string unchanged", () => {
      expect(redactConfigSecrets("")).toBe("");
    });

    it("exports CONFIG_SECRET_PATTERN as a global RegExp", () => {
      expect(CONFIG_SECRET_PATTERN).toBeInstanceOf(RegExp);
      expect(CONFIG_SECRET_PATTERN.flags).toContain("g");
    });
  });
});
