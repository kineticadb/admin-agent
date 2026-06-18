/**
 * pick-bundle-path — interactive directory picker for the support bundle.
 *
 * Fired by the kinetica_load_bundle tool when the agent attaches a bundle without
 * a path: the operator gets a search-as-you-type directory chooser (via the
 * @inquirer/prompts `search` prompt — already a dependency, no new install)
 * instead of typing a long path into the chat.
 *
 * The completion source lists subdirectories of the deepest existing parent of
 * whatever the operator has typed, so typing incrementally drills into the tree.
 * Pure listing logic (`listDirectoryCandidates`) is separated from the prompt so
 * it can be unit-tested without a TTY. Never throws — returns undefined on cancel
 * or in a non-interactive terminal.
 *
 * Permission distinction: a directory the process may not read (EACCES/EPERM —
 * notably macOS TCC on ~/Downloads, ~/Desktop, ~/Documents) is reported as a
 * distinct `denied` listing, NOT silently flattened to "empty". The prompt renders
 * it as a non-selectable hint telling the operator to grant access, instead of a
 * mute "No results found" that's indistinguishable from a genuinely empty folder.
 */

import { search } from "../output/themed-prompts.js";
import { readdir } from "node:fs/promises";
import { resolve, dirname, basename, join } from "node:path";

export interface DirCandidate {
  /** Display label (directory path with a trailing slash). */
  readonly name: string;
  /** Value returned when selected (the directory path). */
  readonly value: string;
}

/**
 * Outcome of listing a directory for the picker.
 * - `ok`    — the directory was read; `candidates` may be empty (genuinely nothing).
 * - `denied`— the process is not permitted to read `dir` (EACCES/EPERM, e.g. macOS
 *             TCC); surfaced distinctly so the operator learns WHY it's empty.
 */
export type DirListing =
  | { readonly kind: "ok"; readonly candidates: readonly DirCandidate[] }
  | { readonly kind: "denied"; readonly dir: string };

/** A search-prompt choice (subset of @inquirer's Choice that this module emits). */
export interface SearchChoice {
  readonly name: string;
  readonly value: string;
  /** When set, the choice is rendered but cannot be selected (used for hints). */
  readonly disabled?: boolean;
}

/**
 * True for the fs error codes that mean "you may not read this directory":
 * EACCES (classic permission denied) and EPERM (what macOS TCC raises). Tolerant of
 * non-error inputs so the caller can pass an unknown caught value directly.
 */
export function isPermissionError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  const code = (err as { code?: unknown }).code;
  return code === "EACCES" || code === "EPERM";
}

/**
 * List directory candidates for a typed term. Splits the term into a parent
 * directory + a name prefix, then returns the parent's subdirectories whose names
 * start with that prefix. A permission error yields `kind: "denied"`; every other
 * read failure (ENOENT, ENOTDIR, …) is a genuinely-empty `kind: "ok"`. Never throws.
 */
export async function listDirectoryCandidates(term: string): Promise<DirListing> {
  const input = term.trim() === "" ? "." : term;
  const endsWithSep = input.endsWith("/");
  const baseDir = endsWithSep ? input : dirname(input) || ".";
  const prefix = endsWithSep ? "" : basename(input);
  const resolved = resolve(baseDir);

  let entries;
  try {
    entries = await readdir(resolved, { withFileTypes: true });
  } catch (err) {
    if (isPermissionError(err)) return { kind: "denied", dir: resolved };
    return { kind: "ok", candidates: [] };
  }

  const candidates = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => {
      const value = join(baseDir, e.name);
      return { name: `${value}/`, value };
    })
    .sort((a, b) => a.value.localeCompare(b.value));
  return { kind: "ok", candidates };
}

/**
 * Convert a listing into search-prompt choices. An `ok` listing maps to selectable
 * directory choices; a `denied` listing maps to a single NON-selectable hint that
 * names the directory and tells the operator how to grant access — so a permission
 * problem reads as such instead of a silent empty list. Pure, never throws.
 */
export function listingToChoices(listing: DirListing): SearchChoice[] {
  if (listing.kind === "denied") {
    return [
      {
        name:
          `Permission denied reading ${listing.dir} — grant your terminal access in ` +
          "System Settings › Privacy & Security › Files & Folders (or Full Disk Access), then retry",
        value: "",
        disabled: true,
      },
    ];
  }
  return listing.candidates.map((c) => ({ name: c.name, value: c.value }));
}

/**
 * Prompt the operator to choose the support bundle directory. As they type a
 * path, matching subdirectories are listed for selection (typing incrementally
 * drills into the tree). A permission-denied directory shows a non-selectable hint
 * rather than an empty list. Returns the selected path, or undefined if cancelled
 * or the terminal is non-interactive.
 */
export async function promptBundleDirectory(): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined;
  try {
    return await search<string>({
      message: "Select the support bundle directory (type to filter):",
      source: async (term) => listingToChoices(await listDirectoryCandidates(term ?? "")),
    });
  } catch {
    return undefined; // Esc / Ctrl+C
  }
}
