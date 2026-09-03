/**
 * promAlerts — the site's own alert thresholds and what is tripping them.
 *
 * Reads `/api/v1/rules` and ONLY that. Prometheus embeds each alerting rule's live
 * instances inside the rule object, beside the `query` that defines the threshold, so one
 * call answers both "what is firing" and "what does this site consider too high" with no
 * join and no chance of a mismatch. `/api/v1/alerts` is those same arrays flattened, and
 * `client.promAlerts()` is therefore deliberately never called — a test pins that.
 *
 * This is the tool that supplies per-site thresholds. The knowledge corpus deliberately
 * carries read paths rather than numbers, because limits are per-customer; `expr` here is
 * that read path.
 *
 * Three outcomes are kept strictly distinct, because collapsing them misleads:
 *   - Prometheus unreachable        -> handled upstream by withClient()
 *   - reachable, zero rules         -> the ABSENCE of monitoring, not health
 *   - rules present, none firing    -> genuinely quiet
 *
 * Never throws.
 */

import { z } from "zod";

import type { ToolFailure, ToolResult } from "../../types/index.js";
import type { ObservabilityClient } from "../../observability/ObservabilityClient.js";
import {
  parseRuleGroups,
  type AlertRuleRow,
  type ActiveAlertRow,
  type ParsedRules,
} from "./alert-rows.js";
import { readPromBody } from "./response-body.js";

export const PromAlertsSchema = z.object({
  contains: z
    .string()
    .optional()
    .describe(
      'Case-insensitive substring matched against alert rule NAMES, e.g. "memory" or "tier". Omit to list every rule.',
    ),
});

export type PromAlertsInput = z.infer<typeof PromAlertsSchema>;

export type PromAlertsData = {
  /** Alerting rules after any name filter. */
  readonly rule_count: number;
  /** Live instance counts, not rule counts — one rule can fire per rank. */
  readonly firing: number;
  readonly pending: number;
  /** Sorted firing, then pending, then inactive; alphabetical within each. */
  readonly rules: readonly AlertRuleRow[];
  readonly active_alerts: readonly ActiveAlertRow[];
};

/** Sort weight per rule state — active rules first, so truncation cannot hide them. */
const STATE_ORDER: Readonly<Record<string, number>> = { firing: 0, pending: 1, inactive: 2 };

function stateWeight(state: string): number {
  return STATE_ORDER[state] ?? 3;
}

/** Order rules by state, then name, without mutating the input. */
function sortRules(rules: readonly AlertRuleRow[]): readonly AlertRuleRow[] {
  return [...rules].sort(
    (a, b) => stateWeight(a.state) - stateWeight(b.state) || a.alert.localeCompare(b.alert),
  );
}

/**
 * The note for a site with no alerting rules at all.
 *
 * Blocks two wrong inferences, both spelled out in the returned text: that silence here
 * says anything about the DATABASE's own alerting, and that zero is normal.
 *
 * Evidence for the second: measured on a live 7.2.3.20 kagent install, Prometheus held
 * 16 alerting rules shipped in `/opt/gpudb/kagent/stats/prometheus/alert_rules.yml`.
 */
function noRulesNote(recordingCount: number): string {
  const recording =
    recordingCount > 0
      ? ` It has ${recordingCount} recording rule${recordingCount === 1 ? "" : "s"}, which derive series but never alert.`
      : "";
  return (
    `Prometheus is reachable but this site has configured NO alerting rules.${recording} ` +
    `Nothing here can fire, so an empty alert list is the ABSENCE of monitoring — not evidence of health. ` +
    `This is also NOT the kagent default: a measured kagent stack ships a rule file covering host load, ` +
    `memory, disk, request concurrency and RabbitMQ HA queue depth, so an empty list on such an install ` +
    `means those rules are missing or failed to load — report it as a monitoring gap. ` +
    `Kinetica's own alerts (gpudb.conf alert_memory_percentage, alert_disk_percentage, heartbeat) go from ` +
    `the database straight to Alertmanager and never appear here: read those with kinetica_cluster_status. ` +
    `For limits actually being enforced right now, use kinetica_tier_snapshot.`
  );
}

/** The note when a filter, not the site, is why the list is empty. */
function filteredEmptyNote(contains: string, total: number): string {
  return (
    `No alerting rule name contains "${contains}" — but this site has ${total} ` +
    `rules configured. Call without \`contains\` to list them.`
  );
}

/** The note for a site with rules that are all quiet. */
function quietNote(count: number): string {
  return (
    `${count} alerting rule${count === 1 ? "" : "s"} configured, none firing or pending — the site's own ` +
    `monitoring is quiet. \`expr\` is this site's OWN definition of abnormal; prefer those thresholds to any generic figure.`
  );
}

/** The note when something is firing or pending. */
function activeNote(
  firing: number,
  pending: number,
  count: number,
  common: string,
  nowIso: string,
): string {
  const shared = common ? ` All active alerts: ${common}.` : "";
  return (
    `${firing} firing and ${pending} pending instance(s) across ${count} alerting rule(s); active rules sort first. ` +
    `\`expr\` is the site's own threshold, \`value\` the evaluation that tripped it, \`active_for\` its age ` +
    `(now = ${nowIso}).${shared}`
  );
}

/** Appended whenever a rule cannot evaluate — such a rule can never fire. */
function failingNote(failing: readonly { alert: string; error: string }[]): string {
  if (failing.length === 0) return "";
  const detail = failing.map((f) => `${f.alert}${f.error ? ` (${f.error})` : ""}`).join("; ");
  return ` WARNING: ${failing.length} rule(s) are failing to evaluate and are therefore unable to fire: ${detail}.`;
}

/**
 * The failure for a body that parsed as JSON but is not a rules payload.
 *
 * Kept distinct from "zero configured rules": that is a real diagnostic claim about the
 * site, and a malformed body must never be allowed to impersonate it.
 */
function malformedBody(status: number, raw: string): ToolFailure {
  return {
    ok: false,
    status,
    error:
      "Prometheus answered but the body had an unexpected shape — `data.groups` was missing " +
      "or not an array. Treating this as malformed rather than as zero configured rules.",
    raw,
  };
}

/** Live instance counts, in one pass over the instances. */
function countStates(active: readonly ActiveAlertRow[]): {
  readonly firing: number;
  readonly pending: number;
} {
  return active.reduce(
    (acc, a) => ({
      firing: acc.firing + (a.state === "firing" ? 1 : 0),
      pending: acc.pending + (a.state === "pending" ? 1 : 0),
    }),
    { firing: 0, pending: 0 },
  );
}

/**
 * Pick the note that describes this result.
 *
 * Guard clauses rather than a nested conditional: the four outcomes are mutually
 * exclusive diagnostic claims, and their ORDER is the logic — "the site configured
 * none" must be tested before "your filter matched none", or a filtered query against
 * an unmonitored site reports the filter as the reason.
 */
function chooseNote(
  parsed: ParsedRules,
  shown: number,
  firing: number,
  pending: number,
  contains: string | undefined,
  nowIso: string,
): string {
  if (parsed.totalAlerting === 0) return noRulesNote(parsed.recordingCount);
  if (shown === 0 && contains) return filteredEmptyNote(contains, parsed.totalAlerting);
  if (firing + pending === 0) return quietNote(shown);
  return activeNote(firing, pending, shown, parsed.common, nowIso);
}

/**
 * Read the configured alerting rules and their live state.
 *
 * @param client - configured observability client
 * @param input  - validated tool input
 */
export async function promAlerts(
  client: ObservabilityClient,
  input: PromAlertsInput,
): Promise<ToolResult<PromAlertsData>> {
  const needle = input.contains?.toLowerCase();
  const matches = needle ? (alert: string) => alert.toLowerCase().includes(needle) : undefined;

  try {
    const decoded = await readPromBody(await client.promRules());
    if (!decoded.ok) return decoded;

    const now = Date.now();
    const parsed = parseRuleGroups(decoded.body, now, matches);
    if (!parsed) return malformedBody(decoded.status, decoded.raw);

    const rules = sortRules(parsed.rules);
    const { firing, pending } = countStates(parsed.active);
    const nowIso = `${new Date(now).toISOString().slice(0, 19)}Z`;

    const base = chooseNote(parsed, rules.length, firing, pending, input.contains, nowIso);

    return {
      ok: true,
      data: {
        rule_count: rules.length,
        firing,
        pending,
        rules,
        active_alerts: parsed.active,
      },
      rowCount: rules.length,
      note: `${base}${failingNote(parsed.failing)}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
      raw: "",
    };
  }
}
