import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("@inquirer/prompts", () => ({
  confirm: vi.fn(),
}));

vi.mock("picocolors", () => ({
  default: {
    dim: (s: string) => `DIM(${s})`,
    yellow: (s: string) => `YELLOW(${s})`,
  },
}));

import { readFileSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { confirm } from "@inquirer/prompts";
import {
  parseEnvContent,
  buildEnvContent,
  escapeEnvValue,
  loadEnvFile,
  offerSaveCredentials,
} from "./env-file.js";

const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;
const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockWriteFile = writeFile as ReturnType<typeof vi.fn>;
const mockConfirm = confirm as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// parseEnvContent — pure function tests (no mocks needed)
// ---------------------------------------------------------------------------

describe("parseEnvContent", () => {
  it("parses simple KEY=VALUE pairs", () => {
    const result = parseEnvContent("FOO=bar\nBAZ=qux");
    expect(result.get("FOO")).toBe("bar");
    expect(result.get("BAZ")).toBe("qux");
  });

  it("skips blank lines", () => {
    const result = parseEnvContent("FOO=bar\n\n\nBAZ=qux");
    expect(result.size).toBe(2);
  });

  it("skips comment lines", () => {
    const result = parseEnvContent("# This is a comment\nFOO=bar\n  # indented comment");
    expect(result.size).toBe(1);
    expect(result.get("FOO")).toBe("bar");
  });

  it("strips surrounding double quotes from values", () => {
    const result = parseEnvContent('FOO="hello world"');
    expect(result.get("FOO")).toBe("hello world");
  });

  it("strips surrounding single quotes from values", () => {
    const result = parseEnvContent("FOO='hello world'");
    expect(result.get("FOO")).toBe("hello world");
  });

  it("preserves values with internal quotes", () => {
    const result = parseEnvContent('FOO=it\'s "fine"');
    expect(result.get("FOO")).toBe('it\'s "fine"');
  });

  it("handles empty values", () => {
    const result = parseEnvContent("FOO=");
    expect(result.get("FOO")).toBe("");
  });

  it("handles values containing equals signs", () => {
    const result = parseEnvContent("FOO=bar=baz");
    expect(result.get("FOO")).toBe("bar=baz");
  });

  it("handles URL values with special characters", () => {
    const result = parseEnvContent("KINETICA_URL=http://host1:9191");
    expect(result.get("KINETICA_URL")).toBe("http://host1:9191");
  });

  it("returns empty map for empty content", () => {
    expect(parseEnvContent("").size).toBe(0);
  });

  it("returns empty map for content with only comments", () => {
    expect(parseEnvContent("# comment\n# another").size).toBe(0);
  });

  it("skips lines that are not valid KEY=VALUE", () => {
    const result = parseEnvContent("not a valid line\nFOO=bar");
    expect(result.size).toBe(1);
    expect(result.get("FOO")).toBe("bar");
  });

  it("returns a ReadonlyMap", () => {
    const result = parseEnvContent("FOO=bar");
    // Verify it's a Map (ReadonlyMap is just the type — runtime is Map)
    expect(result).toBeInstanceOf(Map);
  });
});

// ---------------------------------------------------------------------------
// buildEnvContent — pure function tests
// ---------------------------------------------------------------------------

describe("buildEnvContent", () => {
  it("generates content from template when no existing content", () => {
    const result = buildEnvContent("http://host1:9191", "admin");
    expect(result).toContain("KINETICA_URL=http://host1:9191");
    expect(result).toContain("KINETICA_USER=admin");
    expect(result).toContain("KINETICA_PASS=");
    expect(result).toContain("ANTHROPIC_API_KEY=");
  });

  it("generates from template when existing content is empty string", () => {
    const result = buildEnvContent("http://host1:9191", "admin", "");
    expect(result).toContain("KINETICA_URL=http://host1:9191");
    expect(result).toContain("KINETICA_USER=admin");
  });

  it("generates from template when existing content is whitespace only", () => {
    const result = buildEnvContent("http://host1:9191", "admin", "   \n  ");
    expect(result).toContain("KINETICA_URL=http://host1:9191");
  });

  it("replaces existing KINETICA_URL and KINETICA_USER lines", () => {
    const existing = [
      "ANTHROPIC_API_KEY=sk-test",
      "KINETICA_URL=http://old:9191",
      "KINETICA_USER=old-user",
      "KINETICA_PASS=secret",
    ].join("\n");

    const result = buildEnvContent("http://new:9191", "new-admin", existing);
    expect(result).toContain("KINETICA_URL=http://new:9191");
    expect(result).toContain("KINETICA_USER=new-admin");
    // Preserved lines:
    expect(result).toContain("ANTHROPIC_API_KEY=sk-test");
    expect(result).toContain("KINETICA_PASS=secret");
  });

  it("preserves comments in existing content", () => {
    const existing = ["# My config", "KINETICA_URL=http://old:9191", "KINETICA_USER=old"].join(
      "\n",
    );

    const result = buildEnvContent("http://new:9191", "admin", existing);
    expect(result).toContain("# My config");
  });

  it("does not replace commented-out KINETICA_URL lines", () => {
    const existing = [
      "# KINETICA_URL=http://commented-out:9191",
      "KINETICA_URL=http://active:9191",
      "KINETICA_USER=admin",
    ].join("\n");

    const result = buildEnvContent("http://new:9191", "new-admin", existing);
    expect(result).toContain("# KINETICA_URL=http://commented-out:9191");
    expect(result).toContain("KINETICA_URL=http://new:9191");
    expect(result).not.toContain("KINETICA_URL=http://active:9191");
  });

  it("appends KINETICA_URL if not present in existing content", () => {
    const existing = "KINETICA_USER=admin\nKINETICA_PASS=secret";
    const result = buildEnvContent("http://new:9191", "admin", existing);
    expect(result).toContain("KINETICA_URL=http://new:9191");
  });

  it("appends KINETICA_USER if not present in existing content", () => {
    const existing = "KINETICA_URL=http://old:9191\nKINETICA_PASS=secret";
    const result = buildEnvContent("http://old:9191", "new-admin", existing);
    expect(result).toContain("KINETICA_USER=new-admin");
  });

  it("never modifies KINETICA_PASS line", () => {
    const existing = "KINETICA_URL=http://old:9191\nKINETICA_USER=admin\nKINETICA_PASS=mysecret";
    const result = buildEnvContent("http://new:9191", "admin", existing);
    expect(result).toContain("KINETICA_PASS=mysecret");
  });

  it("preserves other env vars in existing content", () => {
    const existing = "DEBUG=1\nKINETICA_URL=http://old:9191\nKINETICA_USER=old\nCUSTOM_VAR=foo";
    const result = buildEnvContent("http://new:9191", "admin", existing);
    expect(result).toContain("DEBUG=1");
    expect(result).toContain("CUSTOM_VAR=foo");
  });

  // M-2: escape & validation
  it("throws when url contains a newline", () => {
    expect(() => buildEnvContent("http://host\nANTHROPIC_API_KEY=evil", "admin")).toThrow(
      /forbidden character/,
    );
  });

  it("throws when user contains a carriage return", () => {
    expect(() => buildEnvContent("http://host:9191", "admin\rinjected")).toThrow(
      /forbidden character/,
    );
  });

  it("throws when user contains a null byte", () => {
    expect(() => buildEnvContent("http://host:9191", "admin\0hidden")).toThrow(
      /forbidden character/,
    );
  });

  it("quotes values containing whitespace", () => {
    const result = buildEnvContent("http://host:9191", "admin user");
    expect(result).toContain('KINETICA_USER="admin user"');
  });

  it("escapes embedded double-quotes in user", () => {
    const result = buildEnvContent("http://host:9191", 'he said "hi"');
    expect(result).toContain('KINETICA_USER="he said \\"hi\\""');
  });

  it("round-trips escaped values through parseEnvContent", () => {
    const content = buildEnvContent("http://host:9191", "weird user#with quotes'and\"stuff");
    const parsed = parseEnvContent(content);
    expect(parsed.get("KINETICA_URL")).toBe("http://host:9191");
    expect(parsed.get("KINETICA_USER")).toBe("weird user#with quotes'and\"stuff");
  });
});

describe("escapeEnvValue", () => {
  it("returns simple URLs unquoted (backward compat)", () => {
    expect(escapeEnvValue("http://host1:9191")).toBe("http://host1:9191");
  });

  it("quotes values containing #", () => {
    expect(escapeEnvValue("pass#word")).toBe('"pass#word"');
  });

  it("escapes backslashes before double quotes", () => {
    expect(escapeEnvValue('a\\b"c')).toBe('"a\\\\b\\"c"');
  });

  it("throws on newline", () => {
    expect(() => escapeEnvValue("a\nb")).toThrow(/forbidden character/);
  });
});

// ---------------------------------------------------------------------------
// loadEnvFile — I/O function tests (mocked fs)
// ---------------------------------------------------------------------------

describe("loadEnvFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("populates env for keys not already set", () => {
    const envContent = "KINETICA_URL=http://test:9191\nKINETICA_USER=admin";
    mockReadFileSync.mockReturnValue(envContent);

    const env: NodeJS.ProcessEnv = {};
    loadEnvFile("/test/dir", env);

    expect(env.KINETICA_URL).toBe("http://test:9191");
    expect(env.KINETICA_USER).toBe("admin");
    expect(mockReadFileSync).toHaveBeenCalledWith(join("/test/dir", ".env"), "utf8");
  });

  it("skips empty values so interactive prompts still trigger", () => {
    const envContent = "KINETICA_URL=http://test:9191\nKINETICA_USER=admin\nKINETICA_PASS=";
    mockReadFileSync.mockReturnValue(envContent);

    const env: NodeJS.ProcessEnv = {};
    loadEnvFile("/test/dir", env);

    expect(env.KINETICA_URL).toBe("http://test:9191");
    expect(env.KINETICA_USER).toBe("admin");
    expect(env.KINETICA_PASS).toBeUndefined();
  });

  it("does not overwrite existing env vars", () => {
    const envContent = "KINETICA_URL=http://file:9191\nKINETICA_USER=file-user";
    mockReadFileSync.mockReturnValue(envContent);

    const env: NodeJS.ProcessEnv = { KINETICA_URL: "http://shell:9191" };
    loadEnvFile("/test/dir", env);

    expect(env.KINETICA_URL).toBe("http://shell:9191");
    expect(env.KINETICA_USER).toBe("file-user");
  });

  it("handles missing .env file gracefully", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const env: NodeJS.ProcessEnv = {};
    loadEnvFile("/test/dir", env);

    expect(Object.keys(env)).toHaveLength(0);
  });

  it("handles parse errors gracefully", () => {
    mockReadFileSync.mockReturnValue(null);

    const env: NodeJS.ProcessEnv = {};
    // Should not throw
    expect(() => loadEnvFile("/test/dir", env)).not.toThrow();
  });

  it("uses cwd when no dir specified", () => {
    mockReadFileSync.mockReturnValue("");
    const env: NodeJS.ProcessEnv = {};

    loadEnvFile(undefined, env);

    expect(mockReadFileSync).toHaveBeenCalledWith(join(process.cwd(), ".env"), "utf8");
  });
});

// ---------------------------------------------------------------------------
// offerSaveCredentials — I/O function tests (mocked prompts + fs)
// ---------------------------------------------------------------------------

describe("offerSaveCredentials", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.stdin.isTTY = true;
    mockWriteFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    process.stdin.isTTY = originalIsTTY;
  });

  it("writes .env file when user confirms", async () => {
    mockConfirm.mockResolvedValue(true);
    mockReadFile.mockRejectedValue(new Error("ENOENT")); // No existing file

    await offerSaveCredentials("http://host1:9191", "admin", "/test/dir");

    expect(mockConfirm).toHaveBeenCalledOnce();
    expect(mockWriteFile).toHaveBeenCalledOnce();
    const [filePath, content] = mockWriteFile.mock.calls[0];
    expect(filePath).toBe(join("/test/dir", ".env"));
    expect(content).toContain("KINETICA_URL=http://host1:9191");
    expect(content).toContain("KINETICA_USER=admin");
    expect(content).toContain("KINETICA_PASS=");
  });

  it("does not write file when user declines", async () => {
    mockConfirm.mockResolvedValue(false);

    await offerSaveCredentials("http://host1:9191", "admin", "/test/dir");

    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("updates existing .env file preserving other values", async () => {
    mockConfirm.mockResolvedValue(true);
    const existing =
      "ANTHROPIC_API_KEY=sk-test\nKINETICA_URL=http://old:9191\nKINETICA_USER=old\nKINETICA_PASS=secret";
    mockReadFile.mockResolvedValue(existing);

    await offerSaveCredentials("http://new:9191", "new-admin", "/test/dir");

    const written = mockWriteFile.mock.calls[0][1] as string;
    expect(written).toContain("ANTHROPIC_API_KEY=sk-test");
    expect(written).toContain("KINETICA_URL=http://new:9191");
    expect(written).toContain("KINETICA_USER=new-admin");
    expect(written).toContain("KINETICA_PASS=secret");
  });

  it("prints confirmation message after saving", async () => {
    mockConfirm.mockResolvedValue(true);
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await offerSaveCredentials("http://host1:9191", "admin", "/test/dir");

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Saved to .env"));
  });

  it("skips silently in non-interactive terminals", async () => {
    process.stdin.isTTY = false;

    await offerSaveCredentials("http://host1:9191", "admin", "/test/dir");

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("skips when isTTY is undefined", async () => {
    process.stdin.isTTY = undefined as unknown as true;

    await offerSaveCredentials("http://host1:9191", "admin", "/test/dir");

    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("never throws — catches and warns on error", async () => {
    mockConfirm.mockRejectedValue(new Error("prompt failed"));

    await expect(
      offerSaveCredentials("http://host1:9191", "admin", "/test/dir"),
    ).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Could not save"));
  });

  it("never throws on write error", async () => {
    mockConfirm.mockResolvedValue(true);
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockWriteFile.mockRejectedValue(new Error("EACCES"));

    await expect(
      offerSaveCredentials("http://host1:9191", "admin", "/test/dir"),
    ).resolves.toBeUndefined();
  });

  it("asks with correct message and default", async () => {
    mockConfirm.mockResolvedValue(false);

    await offerSaveCredentials("http://host1:9191", "admin", "/test/dir");

    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("password is never saved"),
        default: true,
      }),
    );
  });
});
