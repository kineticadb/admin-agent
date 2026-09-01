/**
 * Tests for credential scrubbing utility.
 *
 * Verifies that scrubCredentials() removes all credential patterns
 * and returns new strings without mutating the original.
 */

import { describe, it, expect } from "vitest";
import {
  isSecretConfigKey,
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

// ---------------------------------------------------------------------------
// Credential-bearing key names from a real gpudb.conf
//
// The old enumerated set (license_key|private_key|password|secret) was inverted
// both ways: a bare `.key` suffix fell through (ai.api.key,
// external_authentication_handshake_key -- live credentials), while `password`
// matched anywhere and hid min_password_length. The rule is now position.
// ---------------------------------------------------------------------------

describe("redactConfigSecrets — real gpudb.conf key names", () => {
  it.each([
    "license_key = ABC-SECRET-123",
    "ai.api.key = sk-live-abcdef123456",
    "external_authentication_handshake_key = hs-secret-xyz",
    "ldap.bind_password = hunter2",
    "some_private_key = MIIEvQIBADAN",
    "tls.keystore.passphrase = storepass",
    "oauth.access_token = ya29.abc",
    "svc.credentials = user:pass",
  ])("redacts the value of %s", (line) => {
    const out = redactConfigSecrets(line);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toMatch(/SECRET-123|sk-live|hs-secret|hunter2|MIIEvQ|storepass|ya29|user:pass/);
    // key name preserved for drift detection
    expect(out.split(/[:=]/)[0]).toBe(line.split(/[:=]/)[0]);
  });

  it.each([
    ["min_password_length = 0", "0"],
    ["postgres_proxy.ssl_key_file = /etc/ssl/private/pg.key", "/etc/ssl/private/pg.key"],
    ["https_cert_file = /etc/ssl/certs/kinetica.pem", "/etc/ssl/certs/kinetica.pem"],
    ["postgres_proxy.ssl_ciphers = HIGH:!aNULL", "HIGH:!aNULL"],
    ["enable_audit = FALSE", "FALSE"],
  ])("leaves %s intact (non-secret, needed for diagnosis)", (line, value) => {
    const out = redactConfigSecrets(line);
    expect(out).toContain(value);
    expect(out).not.toContain("[REDACTED]");
  });

  it.each(["ai.api.key =", "ai.api.key = ", "license_key ="])(
    "leaves an EMPTY sensitive value unredacted: %j",
    (line) => {
      // "[REDACTED]" on an empty field would imply a credential is configured
      // when none is -- a different diagnostic fact from "redacted".
      expect(redactConfigSecrets(line)).not.toContain("[REDACTED]");
    },
  );

  // A position-only rule lost these: a credential word mid-name followed by a
  // qualifier. In a redaction pattern a false negative leaks; a false positive
  // only costs a diagnostic. Both must hold at once.
  it.each([
    "private_key_pem = MIIEvQIBADAN",
    "password_for_admin = hunter2",
    "bind_password_value = hunter2",
    "keystore_password_hint = abc",
    "license_key_data = XYZ",
    "truststore_passphrase_b64 = zzz",
  ])("redacts a credential word mid-key: %s", (line) => {
    expect(redactConfigSecrets(line)).toContain("[REDACTED]");
  });

  it.each([
    "min_password_length = 0",
    "password_policy = strict",
    "private_key_file = /etc/ssl/pk.pem",
    "api_key_path = /etc/keys",
    "password_max_age = 90",
  ])("still leaves policy and path keys visible: %s", (line) => {
    expect(redactConfigSecrets(line)).not.toContain("[REDACTED]");
  });

  // Reports carry prose, tool error text and JSON -- not just clean INI lines.
  // Line-anchoring the pattern silently stopped redacting all three.
  it.each([
    "Error: startup failed, license_key = TRIAL-ABC-123",
    "  config drift detected: ldap.bind_password = hunter2",
    "The operator set private_key = MIIEvQIBADAN in the file",
    '{"license_key": "ABC-123"}',
    "tail: api.secret=zzz",
  ])("redacts a sensitive assignment that is not at line start: %s", (line) => {
    const out = redactConfigSecrets(line);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toMatch(/TRIAL-ABC|hunter2|MIIEvQ|ABC-123|zzz/);
  });

  // Boolean-flag prefixes: `use_managed_credentials` is on/off, not a secret,
  // and hiding it costs cloud-tier diagnosis.
  it.each([
    "use_managed_credentials = true",
    "tier.cold0.default.use_managed_credentials = false",
    "enable_secret_rotation = true",
    "require_password = TRUE",
  ])("leaves boolean flags visible: %s", (line) => {
    expect(redactConfigSecrets(line)).not.toContain("[REDACTED]");
  });

  it.each([
    "tier.cold0.default.s3_aws_access_key_id = AKIA123",
    "tier.cold0.default.s3_aws_secret_access_key = abc/def",
    "tier.cold0.default.azure_storage_account_key = zzz==",
    "tier.cold0.default.azure_sas_token = sv=2020",
    "tier.cold0.default.gcs_service_account_keys = {...}",
  ])("redacts cloud-tier credentials: %s", (line) => {
    expect(redactConfigSecrets(line)).toContain("[REDACTED]");
  });

  it("does not match starting mid-key", () => {
    // "password_length" inside "min_password_length" must not become a match
    expect(redactConfigSecrets("min_password_length = 0")).not.toContain("[REDACTED]");
  });

  it("still redacts a token appearing mid-key when it is unambiguous", () => {
    // `secret` is never a benign config token, wherever it sits
    expect(redactConfigSecrets("client_secret_id = abc123")).toContain("[REDACTED]");
  });

  it("redacts every sensitive line in a multi-line block, leaving others", () => {
    const block = [
      "license_key = SECRET1",
      "enable_audit = FALSE",
      "ai.api.key = SECRET2",
      "min_password_length = 0",
    ].join("\n");
    const out = redactConfigSecrets(block);
    expect(out).not.toMatch(/SECRET1|SECRET2/);
    expect(out).toContain("enable_audit = FALSE");
    expect(out).toContain("min_password_length = 0");
  });
});

// ---------------------------------------------------------------------------
// Prose forms — scrubCredentials must not lose coverage the old pattern had
//
// redactConfigSecrets is deliberately precise: it runs over gpudb.conf, where
// over-redaction hides diagnostics. Report text has the opposite requirement —
// a miss leaks a credential, over-redaction costs nothing — and the agent's
// native idiom is `**key**:` / `` `key` = `` / `(key):`, not bare INI.
// ---------------------------------------------------------------------------

describe("scrubCredentials — decorated prose forms", () => {
  it.each([
    ["**license_key**: LICENSE-ABC-123", "LICENSE-ABC-123"],
    ["The current `license_key` = LICENSE-ABC-123", "LICENSE-ABC-123"],
    ["- LDAP bind password (security.ldap_bind_password): S3cr3tBindPw", "S3cr3tBindPw"],
    [
      "1. Rotate `tier.cold1.default.s3_aws_secret_access_key` (currently: wJalrXUtnFEMI)",
      "wJalrXUtnFEMI",
    ],
    ["Evidence: the license_key in gpudb.conf = LICENSE-ABC-123", "LICENSE-ABC-123"],
    ["| `ai.api.key` | sk-live-abc123 | changed |", "sk-live-abc123"],
    ["azure_storage_account_key (current): zzz==", "zzz=="],
  ])("redacts %s", (line, secret) => {
    const out = scrubCredentials(line);
    expect(out).not.toContain(secret);
  });

  it("never loses coverage the pre-change pattern had", () => {
    // The old pattern's vocabulary, in decorated form. Every one of these was
    // redacted before the rewrite and must stay redacted.
    const OLD_WORDS = ["password", "passwd", "passphrase", "license_key", "private_key", "secret"];
    for (const w of OLD_WORDS) {
      for (const form of [`**${w}**: SEKRIT`, `\`${w}\` = SEKRIT`, `note (${w}): SEKRIT`]) {
        expect(scrubCredentials(form)).not.toContain("SEKRIT");
      }
    }
  });

  // Known limit, unchanged from before the rewrite: a credential conveyed with
  // no ":"/"="/"|" separator ("the key was set to hunter2") is not reachable by
  // pattern matching. The prompt tells the agent never to quote secret values;
  // this scrubber is defence-in-depth behind that, not a substitute for it.
  it("documents the no-separator limit rather than claiming to cover it", () => {
    expect(scrubCredentials("the license_key was set to hunter2")).toContain("hunter2");
  });

  it("leaves an ordinary diagnostic line alone", () => {
    const out = scrubCredentials("| `tps_per_tom` | 4 | 8 | confirmed |");
    expect(out).toContain("tps_per_tom");
    expect(out).toContain("8");
  });
});

describe("redactConfigSecrets stays precise (config path is unchanged)", () => {
  it.each([
    "min_password_length = 0",
    "use_managed_credentials = false",
    "postgres_proxy.ssl_key_file = /etc/pg.key",
    "tps_per_tom = 4",
  ])("leaves %s visible for drift detection", (line) => {
    expect(redactConfigSecrets(line)).not.toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// isSecretConfigKey — the structured counterpart to CONFIG_SECRET_PATTERN
//
// The bundle path returns parsed {section, key, value} entries rather than text,
// so it can decide per key name instead of pattern-matching a line. Both share
// the token sets so the two paths cannot drift apart.
// ---------------------------------------------------------------------------

describe("isSecretConfigKey", () => {
  it.each([
    "license_key",
    "ai.api.key",
    "external_authentication_handshake_key",
    "security.ldap_bind_password",
    "tier.cold0.default.s3_aws_secret_access_key",
    "tier.cold0.default.s3_aws_access_key_id",
    "tier.cold0.default.azure_storage_account_key",
    "tier.cold0.default.azure_sas_token",
    "tier.cold0.default.azure_client_secret",
    "tier.cold0.default.gcs_service_account_private_key",
    "tier.cold0.default.s3_encryption_customer_key",
    "keystore_passphrase",
    "svc.credentials",
  ])("treats %s as a secret", (key) => {
    expect(isSecretConfigKey(key)).toBe(true);
  });

  it.each([
    "min_password_length",
    "password_policy",
    "use_managed_credentials",
    "tier.cold0.default.use_managed_credentials",
    "postgres_proxy.ssl_key_file",
    "https_cert_file",
    "postgres_proxy.ssl_ciphers",
    "tps_per_tom",
    "enable_audit",
    "chunk_size",
    "require_authentication",
  ])("treats %s as safe to show", (key) => {
    expect(isSecretConfigKey(key)).toBe(false);
  });

  it("agrees with CONFIG_SECRET_PATTERN on the same key names", () => {
    const keys = [
      "license_key",
      "ai.api.key",
      "security.ldap_bind_password",
      "tier.cold0.default.s3_aws_secret_access_key",
      "min_password_length",
      "use_managed_credentials",
      "postgres_proxy.ssl_key_file",
      "tps_per_tom",
    ];
    for (const k of keys) {
      const viaPattern = redactConfigSecrets(`${k} = SOMEVALUE`).includes("[REDACTED]");
      expect(isSecretConfigKey(k)).toBe(viaPattern);
    }
  });
});
