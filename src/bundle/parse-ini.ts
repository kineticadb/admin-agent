/**
 * parse-ini — minimal parser for the gpudb.conf INI format.
 *
 * gpudb.conf is a flat INI: `[section]` headers, `key = value` pairs, `#`/`;`
 * comments, and `${gaia.host0.address}`-style interpolation references that we
 * surface verbatim (resolving them would require the full runtime context the
 * bundle doesn't carry). Values are returned exactly as written.
 *
 * Returns a flat list of entries tagged with their section so callers can
 * filter by section and/or key without walking a nested structure.
 *
 * Pure, never throws.
 */

export interface IniEntry {
  /** Section name; "" for entries that appear before any `[section]` header. */
  readonly section: string;
  readonly key: string;
  readonly value: string;
}

/** An INI `[section]` header. Exported so the content sniffer detects a config file
 *  with the same grammar this parser uses. */
export const SECTION_RE = /^\[(.+)\]$/;

export function parseIni(content: string): readonly IniEntry[] {
  const entries: IniEntry[] = [];
  let section = "";

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;

    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) entries.push({ section, key, value });
  }

  return entries;
}

/**
 * Filter INI entries by section (exact, case-insensitive) and/or a key
 * substring (case-insensitive). Both filters are optional; omitting both
 * returns every entry.
 */
export function filterIni(
  entries: readonly IniEntry[],
  opts: { readonly section?: string; readonly key?: string } = {},
): readonly IniEntry[] {
  const section = opts.section?.toLowerCase();
  const key = opts.key?.toLowerCase();
  return entries.filter((e) => {
    if (section !== undefined && e.section.toLowerCase() !== section) return false;
    if (key !== undefined && !e.key.toLowerCase().includes(key)) return false;
    return true;
  });
}
