/**
 * Mutation-audit input redaction.
 *
 * Defense-in-depth for the stderr audit line emitted by logMutationAudit after
 * every mutation tool executes. Raw tool inputs can contain secrets:
 *   - CREATE USER ... PASSWORD '...'
 *   - ALTER USER ... IDENTIFIED BY '...'
 *   - alter_configuration's config_string (a full gpudb.conf, contains license
 *     keys, LDAP bind passwords, external DB credentials, TLS material)
 *
 * Two redaction strategies:
 *   1) Pattern-based: replace inline credentials inside SQL-like strings.
 *   2) Fingerprint: for known-sensitive keys, or any string longer than
 *      FINGERPRINT_THRESHOLD chars, emit `<N bytes, sha256:abcdef123456…>`.
 *
 * Pure functions — no I/O, no side effects. Never mutates the input.
 */

import { createHash } from "node:crypto";

/** String values longer than this are fingerprinted (not printed verbatim). */
const FINGERPRINT_THRESHOLD = 300;

/** Fingerprint prefix length (first N hex chars of sha256). */
const FINGERPRINT_HEX_LEN = 12;

/**
 * Keys whose string value is ALWAYS fingerprinted, regardless of length.
 * A tiny config can still contain secrets, so length thresholds aren't safe here.
 */
const ALWAYS_FINGERPRINT_KEYS: ReadonlySet<string> = new Set(["config_string"]);

/**
 * Inline credential patterns. Each entry preserves the key phrase and redacts
 * the value so the audit log still shows structural context.
 */
const CREDENTIAL_PATTERNS: readonly { regex: RegExp; replacement: string }[] = [
  // password = '...' or password='...'
  {
    regex: /(password\s*=\s*)['"][^'"]*['"]/gi,
    replacement: "$1'[REDACTED]'",
  },
  // IDENTIFIED BY '...'  (Kinetica CREATE/ALTER USER)
  {
    regex: /(identified\s+by\s+)['"][^'"]*['"]/gi,
    replacement: "$1'[REDACTED]'",
  },
  // apiKey=... / api_key: ... / access_token=... / secret = '...' / "access_token": "..."
  {
    regex: /(api[_-]?key|access[_-]?token|secret)['"]?(\s*[:=]\s*)['"]?([^\s'"`,;)]+)['"]?/gi,
    replacement: "$1$2'[REDACTED]'",
  },
];

/** Produce a stable `<N bytes, sha256:abc123def456…>` fingerprint for a value. */
function fingerprint(value: string): string {
  const sha = createHash("sha256").update(value).digest("hex").slice(0, FINGERPRINT_HEX_LEN);
  return `<${value.length} bytes, sha256:${sha}…>`;
}

/**
 * Apply credential-pattern scrubbing to a string. Pure.
 * Does NOT apply the length-based fingerprint — callers decide when to
 * upgrade to fingerprint (e.g. via redactValue).
 */
export function scrubCredentialPatterns(value: string): string {
  return CREDENTIAL_PATTERNS.reduce(
    (text, { regex, replacement }) => text.replace(regex, replacement),
    value,
  );
}

/**
 * Redact a single unknown value. For strings: apply credential scrubbing,
 * then fingerprint if the scrubbed result is still long. Objects and arrays
 * are recursed into. Other types pass through unchanged.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    const scrubbed = scrubCredentialPatterns(value);
    return scrubbed.length > FINGERPRINT_THRESHOLD ? fingerprint(scrubbed) : scrubbed;
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactNamedField(k, v)]),
    );
  }
  return value;
}

/**
 * Redact a named field, honoring ALWAYS_FINGERPRINT_KEYS. Pure.
 */
function redactNamedField(key: string, value: unknown): unknown {
  if (ALWAYS_FINGERPRINT_KEYS.has(key) && typeof value === "string") {
    return fingerprint(value);
  }
  return redactValue(value);
}

/**
 * Redact a full mutation-tool input object for audit logging.
 *
 * - config_string and similar always-sensitive fields are fingerprinted
 *   regardless of length.
 * - All string values are scrubbed against CREDENTIAL_PATTERNS.
 * - Long strings (>300 chars) collapse to a sha256 fingerprint.
 * - Nested objects/arrays are recursed.
 *
 * Returns a new object. Never mutates the input.
 */
export function redactAuditInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, redactNamedField(k, v)]));
}
