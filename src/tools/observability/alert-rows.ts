/**
 * alert-rows — parse Prometheus `/api/v1/rules` into flat table rows.
 *
 * The shape of that endpoint is what makes a single tool possible: each ALERTING rule
 * embeds its own live instances in an `alerts[]` array, right beside the `query` that
 * defines the threshold. So "what is firing, and what does this site consider too high"
 * is one response with no join — `/api/v1/alerts` is only those same arrays flattened,
 * and is deliberately not read.
 *
 * Two reductions, both drawn from `label-rows.ts` so this table and the metric tables
 * speak one vocabulary: labels identical across every active instance are hoisted into
 * `common` rather than repeated per row, and `alertname` is dropped outright because it
 * restates the `alert` column.
 *
 * Recording rules are counted but not listed — a diagnostician wants thresholds, not
 * derived-series definitions. Their count is still reported, because an alert `expr` may
 * reference one by name.
 *
 * Rules are classified strictly on `type`, which Prometheus has emitted since 2.0. A rule
 * with neither `type` is skipped rather than guessed at; the zero-rules note tells the
 * agent to verify rather than concluding absence.
 *
 * Pure. Never throws.
 */

import {
  commonLabelKeys,
  renderCommon,
  renderNumber,
  renderPairs,
  REDUNDANT_WHEN_SOURCE_PRESENT,
} from "./label-rows.js";

/** Longest `expr` kept before eliding — enough for a real threshold, not a whole subquery. */
const MAX_EXPR_CHARS = 200;

/** Chars preserved from the tail, where the comparison and threshold live. */
const EXPR_TAIL_CHARS = 40;

/** Label that only restates the `alert` column. */
const REDUNDANT_LABEL = "alertname";

/** One configured alerting rule. */
export type AlertRuleRow = {
  readonly alert: string;
  /** `inactive` | `pending` | `firing`, as Prometheus reports it. */
  readonly state: string;
  readonly severity: string;
  /** `for` duration — how long the condition must hold before firing. */
  readonly for: string;
  /** The rule expression: this site's own definition of "too high". */
  readonly expr: string;
  /** Number of live instances of this rule. */
  readonly active: number;
  /** `ok` | `err` | `unknown`. A rule with `err` can never fire. */
  readonly health: string;
};

/** One live (firing or pending) alert instance. */
export type ActiveAlertRow = {
  readonly alert: string;
  readonly state: string;
  /** Distinguishing labels only — shared ones are hoisted into `common`. */
  readonly labels: string;
  /** The evaluated value that tripped the rule. */
  readonly value: string;
  /** How long this instance has been active. */
  readonly active_for: string;
};

/** A rule that cannot evaluate, and therefore cannot ever fire. */
export type FailingRule = {
  readonly alert: string;
  readonly error: string;
};

export type ParsedRules = {
  /** Alerting rules in source order; the caller sorts. */
  readonly rules: readonly AlertRuleRow[];
  readonly active: readonly ActiveAlertRow[];
  readonly recordingCount: number;
  /** `k=v` pairs shared by every active instance, or "" when there are none. */
  readonly common: string;
  readonly failing: readonly FailingRule[];
  /**
   * Alerting rules the site has configured, BEFORE any name filter.
   *
   * Keeps "your filter matched nothing" distinguishable from "this site configured no
   * alerting" — two findings a diagnostician must never see conflated.
   */
  readonly totalAlerting: number;
};

/** Seconds per unit, largest first. */
const UNITS: readonly (readonly [string, number])[] = [
  ["d", 86400],
  ["h", 3600],
  ["m", 60],
  ["s", 1],
];

/**
 * Render a duration as its two most significant units (`1m30s`, `1d1h`, `5m`).
 *
 * Negative and non-finite inputs render `?` rather than throwing — a malformed
 * `duration` must degrade one cell, not abort the parse.
 */
export function renderDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "?";
  const whole = Math.floor(seconds);
  if (whole === 0) return "0s";

  const index = UNITS.findIndex(([, size]) => whole >= size);
  const [label, size] = UNITS[index];
  const count = Math.floor(whole / size);
  const next = UNITS[index + 1];
  if (!next) return `${count}${label}`;

  const remainder = Math.floor((whole % size) / next[1]);
  return remainder > 0 ? `${count}${label}${remainder}${next[0]}` : `${count}${label}`;
}

/**
 * Age of an alert instance, from its ISO `activeAt`.
 *
 * "How long has this been firing" is usually the finding, and an ISO timestamp forces
 * the agent to do the subtraction itself. A future `activeAt` (clock skew between the
 * Prometheus host and this one) clamps to `0s` rather than rendering a negative age.
 */
export function ageOf(activeAt: unknown, nowMs: number): string {
  if (typeof activeAt !== "string") return "?";
  const started = Date.parse(activeAt);
  if (Number.isNaN(started)) return "?";
  return renderDuration(Math.max(0, (nowMs - started) / 1000));
}

/**
 * Make an expression safe for one markdown table cell.
 *
 * A rule `expr` is frequently multi-line, and a raw newline terminates a table row while
 * an unescaped pipe splits a cell — either one corrupts the whole table.
 *
 * Over-long exprs elide the MIDDLE, never the tail. The threshold comparison lives at the
 * END (`… * 100 > 70`) and is the one part the tool exists to show, so head-only clipping
 * discards the finding and keeps the plumbing. Measured on a live kagent install: the
 * `mem*for5m` rules are 214 chars, just over the cap, and tail-clipping hid every
 * threshold on them.
 */
export function clampExpr(expr: string): string {
  const flat = expr.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_EXPR_CHARS) return flat.replace(/\|/g, "\\|");
  const head = flat.slice(0, MAX_EXPR_CHARS - EXPR_TAIL_CHARS);
  const tail = flat.slice(-EXPR_TAIL_CHARS);
  return `${head}… (elided) …${tail}`.replace(/\|/g, "\\|");
}

/** Read a string property, or "" when absent or the wrong type. */
function str(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

/** Read a plain label map, ignoring non-object and non-string values. */
function labelsOf(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === "string") as [
      string,
      string,
    ][],
  );
}

/** Every object entry of an array-valued property. */
function objectsIn(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object",
  );
}

/** An alert instance paired with the labels it was reported under. */
type Instance = {
  readonly alert: string;
  readonly state: string;
  readonly value: string;
  readonly active_for: string;
  readonly labels: Readonly<Record<string, string>>;
};

/** Render one instance's numeric value compactly; "?" when it is not a number. */
function renderInstanceValue(value: unknown): string {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? renderNumber(parsed) : "?";
}

function toInstance(
  raw: Record<string, unknown>,
  alert: string,
  nowMs: number,
): Instance | undefined {
  const state = str(raw, "state");
  if (!state) return undefined;

  // `alertname` restates the `alert` column; the rest is the shared redundancy documented
  // on REDUNDANT_WHEN_SOURCE_PRESENT.
  const all = labelsOf(raw.labels);
  const hasSource = all.source !== undefined;
  const labels = Object.fromEntries(
    Object.entries(all).filter(
      ([k]) => k !== REDUNDANT_LABEL && !(hasSource && REDUNDANT_WHEN_SOURCE_PRESENT.has(k)),
    ),
  );

  return {
    alert,
    state,
    value: renderInstanceValue(raw.value),
    active_for: ageOf(raw.activeAt, nowMs),
    labels,
  };
}

/** Split instances into rows plus the labels they all shared. */
function hoistLabels(instances: readonly Instance[]): {
  rows: readonly ActiveAlertRow[];
  common: string;
} {
  const shared = commonLabelKeys(instances);
  const rows = instances.map(({ labels, ...rest }) => ({
    ...rest,
    labels: renderPairs(Object.entries(labels).filter(([k]) => !shared.has(k))),
  }));
  return { rows, common: renderCommon(instances, shared) };
}

/** The live instances of one rule, in the order Prometheus reported them. */
function instancesOf(
  raw: Record<string, unknown>,
  alert: string,
  nowMs: number,
): readonly Instance[] {
  return objectsIn(raw.alerts)
    .map((entry) => toInstance(entry, alert, nowMs))
    .filter((instance): instance is Instance => instance !== undefined);
}

/** Render one rule, given the instance count already computed for it. */
function toRuleRow(raw: Record<string, unknown>, alert: string, active: number): AlertRuleRow {
  const duration = typeof raw.duration === "number" ? raw.duration : Number.NaN;
  return {
    alert,
    state: str(raw, "state") || "inactive",
    severity: labelsOf(raw.labels).severity ?? "",
    for: renderDuration(duration),
    expr: clampExpr(str(raw, "query")),
    active,
    health: str(raw, "health"),
  };
}

/**
 * Whether a rule is failing to evaluate, and therefore unable to fire.
 *
 * Only a POSITIVE non-ok health counts. An absent field means this Prometheus does not
 * report health, which is not evidence the rule is broken.
 */
function isFailing(raw: Record<string, unknown>): boolean {
  const health = str(raw, "health");
  return health !== "" && health !== "ok";
}

/**
 * Parse a `/api/v1/rules` response body.
 *
 * @param body    - the decoded JSON body
 * @param nowMs   - reference time for instance ages, injected for testability
 * @param matches - optional predicate on the rule name. Applied BEFORE label hoisting so
 *   `common` describes the rules that survived, and never leaks a label from an excluded
 *   one. `totalAlerting` still counts every rule the site configured.
 * @returns parsed rules, or `undefined` when `data.groups` is not an array.
 *
 * That `undefined` is load-bearing: "this site has configured no alerting" is a real
 * diagnostic claim, so a malformed body must be reported as malformed rather than be
 * allowed to impersonate an empty rule set.
 */
export function parseRuleGroups(
  body: unknown,
  nowMs: number,
  matches: (alert: string) => boolean = () => true,
): ParsedRules | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const { data } = body as { data?: unknown };
  if (data === null || typeof data !== "object") return undefined;
  const { groups } = data as { groups?: unknown };
  if (!Array.isArray(groups)) return undefined;

  // Rule counts are dozens, so a pass per output beats one fold threading five counters.
  const all = objectsIn(groups).flatMap((group) => objectsIn(group.rules));
  const recordingCount = all.filter((raw) => str(raw, "type") === "recording").length;

  // Counted before the name filter: the total is a fact about the site, not the query.
  const alerting = all.filter((raw) => str(raw, "type") === "alerting" && str(raw, "name") !== "");
  const kept = alerting.filter((raw) => matches(str(raw, "name")));

  const paired = kept.map((raw) => {
    const alert = str(raw, "name");
    return { raw, alert, instances: instancesOf(raw, alert, nowMs) };
  });

  const { rows, common } = hoistLabels(paired.flatMap(({ instances }) => instances));

  return {
    rules: paired.map(({ raw, alert, instances }) => toRuleRow(raw, alert, instances.length)),
    active: rows,
    recordingCount,
    common,
    failing: paired
      .filter(({ raw }) => isFailing(raw))
      .map(({ raw, alert }) => ({ alert, error: str(raw, "lastError") })),
    totalAlerting: alerting.length,
  };
}
