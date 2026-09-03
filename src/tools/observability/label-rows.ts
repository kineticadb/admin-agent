/**
 * label-rows — the label-reduction primitives shared by every metric renderer.
 *
 * Labels shared by every row describe the QUERY's context rather than distinguishing its
 * results, so both renderers hoist them into a one-line note instead of repeating them.
 *
 * Their own module, not an export from whichever renderer needed them first:
 * `series-rows.ts` and `alert-rows.ts` are peers, and the invariants here (separator,
 * sort, redundancy set, number precision) must read identically in both tables or the
 * operator sees two vocabularies for one cluster.
 *
 * Pure. Never throws.
 */

/**
 * Render a non-byte number compactly without destroying small magnitudes.
 *
 * Prometheus returns full float precision: measured `ki_host_cpu{what="idle"}` values
 * arrive as `75.20576380460521`, 18 characters where 6 carry the meaning, on every cell
 * of every row. Integers pass through untouched; values at or above 1 get 3 decimals;
 * below 1 uses 3 significant digits so a watermark fraction (0.9) and a sub-millisecond
 * duration (0.00012) both survive, where a flat toFixed(3) would round the latter to 0.
 */
export function renderNumber(value: number): string {
  if (!Number.isFinite(value) || Number.isInteger(value)) return String(value);
  const fixed = Math.abs(value) >= 1 ? value.toFixed(3) : value.toPrecision(3);
  // Trim trailing zeros (and a bare trailing dot) so 0.900 reads as 0.9.
  return fixed.replace(/\.?0+$/, "");
}

/**
 * Labels that are pure restatements of others and only cost width.
 *
 * Measured job-name format is `ki_db_ring_<ring>_cluster_<cluster>_rank_<N>` — it encodes
 * ring, cluster and rank, all of which appear as their own labels, at ~48 characters per
 * row. `instance` is `<host>:<port>`, where `host` is its own label and the port only
 * restates which rank this is. Both are dropped ONLY when `source` is present to carry
 * the rank identity, so a non-Kinetica metric keeps them.
 *
 * Alert instances inherit the labels of the series that tripped them, so they carry this
 * same redundancy — and unlike `alertname`, these two DIFFER per rank, so they escape
 * common-label hoisting and would otherwise land on every row.
 */
export const REDUNDANT_WHEN_SOURCE_PRESENT: ReadonlySet<string> = new Set(["job", "instance"]);

/** Render labels as sorted `k=v` pairs. */
export function renderPairs(entries: readonly (readonly [string, string])[]): string {
  return [...entries]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

/** Anything carrying a label map: a summarized series, or a live alert instance. */
export type Labelled = { readonly labels: Readonly<Record<string, string>> };

/**
 * Label keys whose value is identical across every item.
 *
 * With a single item that is every label, which is the correct and most compact
 * rendering of one series.
 *
 * @param items  - the rows about to be rendered
 * @param ignore - keys that are never hoisted because the caller renders them elsewhere
 *   (`__name__` becomes its own column; `alertname` restates the `alert` column)
 */
export function commonLabelKeys(
  items: readonly Labelled[],
  ignore: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const [head, ...rest] = items;
  if (!head) return new Set();
  return new Set(
    Object.keys(head.labels).filter(
      (k) => !ignore.has(k) && rest.every((i) => i.labels[k] === head.labels[k]),
    ),
  );
}

/** Render the hoisted labels themselves, read off the first item. */
export function renderCommon(items: readonly Labelled[], common: ReadonlySet<string>): string {
  const head = items[0];
  if (!head) return "";
  return renderPairs([...common].map((k) => [k, head.labels[k]] as const));
}
