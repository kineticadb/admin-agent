/**
 * Redaction tests for bundleReadConfig.
 *
 * The bundle's gpudb.conf is the real on-disk file, so it carries live secrets:
 * license_key, LDAP binds, TLS material, cloud-tier storage credentials. This
 * tool returned them verbatim into the agent's context while the live
 * equivalent (kinetica_show_configuration) has always redacted at source.
 */
import { describe, it, expect } from "vitest";
import { bundleReadConfig } from "./read-config.js";
import type { BundleSource } from "../../bundle/BundleSource.js";

type Entry = { section: string; key: string; value: string };

/** Minimal BundleSource exposing only the readConfig this tool calls. */
function sourceWith(entries: readonly Entry[]): BundleSource {
  return {
    readConfig: () => Promise.resolve({ entries, file: "gpudb.conf" }),
  } as unknown as BundleSource;
}

function payload(result: Awaited<ReturnType<typeof bundleReadConfig>>): string {
  return JSON.stringify(result.ok ? result.data : result);
}

describe("bundleReadConfig — secret values are masked", () => {
  it("masks credential values while keeping key names", async () => {
    const result = await bundleReadConfig(
      sourceWith([
        { section: "", key: "license_key", value: "TRIAL-9F3A-22BC" },
        { section: "", key: "ai.api.key", value: "sk-live-abc123" },
        { section: "", key: "tier.cold0.default.s3_aws_secret_access_key", value: "wJalrXU" },
        { section: "", key: "security.ldap_bind_password", value: "hunter2" },
      ]),
    );

    expect(result.ok).toBe(true);
    const text = payload(result);
    expect(text).not.toMatch(/TRIAL-9F3A|sk-live|wJalrXU|hunter2/);
    // key names survive so drift detection still works
    expect(text).toContain("license_key");
    expect(text).toContain("s3_aws_secret_access_key");
    expect(text).toContain("[REDACTED]");
  });

  it("leaves non-secret values readable for drift detection", async () => {
    const result = await bundleReadConfig(
      sourceWith([
        { section: "", key: "tps_per_tom", value: "4" },
        { section: "", key: "min_password_length", value: "0" },
        { section: "", key: "tier.cold0.default.use_managed_credentials", value: "false" },
        { section: "", key: "postgres_proxy.ssl_key_file", value: "/etc/pg.key" },
      ]),
    );

    expect(result.ok).toBe(true);
    const text = payload(result);
    expect(text).not.toContain("[REDACTED]");
    expect(text).toContain("/etc/pg.key");
    expect(text).toContain("false");
  });

  it("leaves an empty secret value empty rather than implying one exists", async () => {
    const result = await bundleReadConfig(
      sourceWith([{ section: "", key: "ai.api.key", value: "" }]),
    );

    expect(result.ok).toBe(true);
    expect(payload(result)).not.toContain("[REDACTED]");
  });

  it("notes when values were masked so the agent does not read [REDACTED] as the value", async () => {
    const result = await bundleReadConfig(
      sourceWith([{ section: "", key: "license_key", value: "TRIAL-9F3A" }]),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.note).toMatch(/redact/i);
  });

  it("adds no note when nothing was masked", async () => {
    const result = await bundleReadConfig(
      sourceWith([{ section: "", key: "tps_per_tom", value: "4" }]),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.note).not.toMatch(/redact/i);
  });
});
