import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listDirectoryCandidates,
  listingToChoices,
  isPermissionError,
  promptBundleDirectory,
  type DirListing,
} from "./pick-bundle-path.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pick-path-"));
  await mkdir(join(dir, "bundle-alpha"), { recursive: true });
  await mkdir(join(dir, "bundle-beta"), { recursive: true });
  await mkdir(join(dir, "other"), { recursive: true });
  await writeFile(join(dir, "afile.txt"), "x"); // a file — must not appear
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Narrow an "ok" listing to its candidate values' basenames (test convenience). */
function basenames(listing: DirListing): string[] {
  if (listing.kind !== "ok") throw new Error(`expected ok listing, got ${listing.kind}`);
  return listing.candidates.map((e) => e.value.split("/").pop() ?? "");
}

describe("listDirectoryCandidates", () => {
  it("lists only subdirectories of a trailing-slash directory term", async () => {
    const listing = await listDirectoryCandidates(`${dir}/`);
    expect(listing.kind).toBe("ok");
    expect(basenames(listing)).toEqual(["bundle-alpha", "bundle-beta", "other"]);
    expect(basenames(listing)).not.toContain("afile.txt");
  });

  it("filters by the trailing name prefix", async () => {
    const listing = await listDirectoryCandidates(`${dir}/bundle-`);
    expect(basenames(listing)).toEqual(["bundle-alpha", "bundle-beta"]);
  });

  it("labels candidates with a trailing slash", async () => {
    const listing = await listDirectoryCandidates(`${dir}/other`);
    if (listing.kind !== "ok") throw new Error("expected ok");
    expect(listing.candidates[0].name.endsWith("/")).toBe(true);
  });

  it("returns an empty ok listing for a non-existent directory (ENOENT, not denial)", async () => {
    const listing = await listDirectoryCandidates(`${dir}/does-not-exist/`);
    expect(listing).toEqual({ kind: "ok", candidates: [] });
  });
});

describe("listDirectoryCandidates — incremental drill-down", () => {
  it("surfaces a fully-typed directory as a selectable child of its parent", async () => {
    const listing = await listDirectoryCandidates(`${dir}/bundle-alpha`);
    if (listing.kind !== "ok") throw new Error("expected ok");
    expect(listing.candidates.some((e) => e.value === `${dir}/bundle-alpha`)).toBe(true);
  });
});

describe("listDirectoryCandidates — permission denial (EACCES/EPERM)", () => {
  // root bypasses unix permission bits, so chmod 000 wouldn't deny — skip only then.
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  it.skipIf(isRoot)(
    "reports kind:'denied' with the resolved dir when readdir is forbidden",
    async () => {
      const locked = await mkdtemp(join(tmpdir(), "pick-locked-"));
      await mkdir(join(locked, "hidden-child"), { recursive: true });
      await chmod(locked, 0o000);
      try {
        const listing = await listDirectoryCandidates(`${locked}/`);
        expect(listing.kind).toBe("denied");
        if (listing.kind === "denied") expect(listing.dir).toBe(locked);
      } finally {
        await chmod(locked, 0o755); // restore so cleanup can recurse
        await rm(locked, { recursive: true, force: true });
      }
    },
  );
});

describe("isPermissionError", () => {
  it("is true for EACCES and EPERM", () => {
    expect(isPermissionError({ code: "EACCES" })).toBe(true);
    expect(isPermissionError({ code: "EPERM" })).toBe(true);
  });

  it("is false for other fs errors and non-errors", () => {
    expect(isPermissionError({ code: "ENOENT" })).toBe(false);
    expect(isPermissionError({ code: "ENOTDIR" })).toBe(false);
    expect(isPermissionError(new Error("boom"))).toBe(false);
    expect(isPermissionError(undefined)).toBe(false);
    expect(isPermissionError(null)).toBe(false);
    expect(isPermissionError("EACCES")).toBe(false);
  });
});

describe("listingToChoices", () => {
  it("maps an ok listing to selectable directory choices", () => {
    const choices = listingToChoices({
      kind: "ok",
      candidates: [{ name: "/x/a/", value: "/x/a" }],
    });
    expect(choices).toEqual([{ name: "/x/a/", value: "/x/a" }]);
  });

  it("returns one non-selectable hint that names the dir for a denied listing", () => {
    const choices = listingToChoices({ kind: "denied", dir: "/Users/me/Downloads" });
    expect(choices).toHaveLength(1);
    expect(choices[0].disabled).toBe(true);
    expect(choices[0].name).toContain("Permission denied");
    expect(choices[0].name).toContain("/Users/me/Downloads");
    expect(choices[0].name).toContain("Privacy & Security");
  });
});

describe("promptBundleDirectory", () => {
  it("returns undefined in a non-interactive terminal (no TTY)", async () => {
    const original = process.stdin.isTTY;
    try {
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      expect(await promptBundleDirectory()).toBeUndefined();
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: original, configurable: true });
    }
  });
});
