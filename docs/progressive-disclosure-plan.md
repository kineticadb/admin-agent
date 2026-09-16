# Progressive Disclosure for the Knowledge Corpus — Implementation Plan

**Status:** **IMPLEMENTED AND VERIFIED** 2026-09-12 (Phases 0-2). Written 2026-09-12
against v0.2.6 (`2ed7f2e`). **Both evals PASS** — `knowledge-retrieval` on all five
assertions (including the three that read the report), and `report-format` on the
template structure. Phase 3 is deliberately unbuilt — each item there waits on its
recorded trigger.
Outstanding: the `knowledge-retrieval` eval gained a **second scenario** (`stale-rank`)
after the first four runs never once retrieved `service-management` — the highest-risk
document in the corpus, moved from always-inline to a card behind a MANDATORY trigger, and
therefore entirely unevidenced. It needs one run to confirm the trigger fires. Everything
else is done.

Historical note on how the evals got to green: `npm run eval:knowledge-retrieval`
was attempted once and the run never reached the model (1 turn, $0.00 billed, no tool
calls) — an environment failure, not a model one. The harness has since been taught to
say so (see below); re-run both evals and fill the eval rows of Appendix B.

**Harness fix that came out of that attempt** (`src/evals/transcript.ts`): the eval
reported an unreachable API as `FAIL: Agent never called save_report` and exited 1
(assertion failed), which is indistinguishable from a genuine behavioural regression.
Reproduced locally with an invalid `ANTHROPIC_API_KEY` — byte-identical output. Both
evals now read the result message's `subtype`/`is_error`, watch the init message for MCP
servers that never connected, recognise the signature of a run that never happened, print
`HARNESS FAILURE: <why>` and exit **2**. They also print the agent's last words on any
failure, so a model that asked a question instead of investigating is visible rather than
merely absent. If a future run of this eval prints `HARNESS FAILURE`, fix the environment
— do not record it in Appendix B as a result.
**Audience:** the agent or engineer who implements this. Every path and line number below was verified on that commit; re-verify before editing, the numbers drift.

**Deviations from this plan, and why** (each was a decision the plan left open, or a
place the plan disagreed with itself):

1. **Section splitting** splits at the SHALLOWEST heading level a document uses, not at
   a fixed `^#{2,3} ` (§5.1). `service-management.md` nests `###` under `##`, so the
   literal rule tore "The Two Correct Command Families" into three fragments — a
   `section` fetch would have returned a piece of an argument instead of the argument.
   `support-bundle.md` (all `###`) still splits correctly.
2. **Threshold is 18,000, not the recommended 15,000** (§11.3). That figure came from an
   estimated ~11k live-with-observability prompt, before the attached-bundle case was
   measured. The measured maximum real configuration is **13,815** (bundle attached +
   stats stack, where §4 mandates `support-bundle` stays inline), leaving 15,000 only
   ~8% of headroom above an ordinary session. A tripwire that fires on the expected
   state teaches the operator to ignore it. 18,000 is ~1.5x the typical live figure and
   ~1.3x the measured max.
3. **Bundle-only landed at ~8,359, not the TL;DR's ~4,800.** §0's projection assumed
   every document became a card; §4 of the same plan requires `support-bundle` to be
   inline when a bundle is the session's subject. §4 is right — every bundle tool call
   depends on that document, so deferring a certain read buys nothing — so the §0
   projection was the error, not the outcome.
4. **Loaders populate `id` and `kind` only**, not `sections` (§5.1). Sections are a pure
   function of the body, so deriving them in `normalizeDoc()` keeps ONE code path for
   loader output and hand-written fixtures alike.
5. **Two report-template ordering tests were re-anchored** on `## <heading>` rather than
   a bare phrase. The new protocol text legitimately says "name the ids you read under
   Evidence Collected", which a bare `indexOf` scored instead of the template section.
   The tests now assert what they always meant.

---

## 0. TL;DR

Today every playbook, reference and bundle reference is rendered **in full** into the system prompt at startup. Measured on the current corpus (6 playbooks, 11 references, 1 bundle reference):

| Prompt                                 | Tokens (est.) | Of which corpus bodies |
| -------------------------------------- | ------------- | ---------------------- |
| Live session, bundle "available"       | **22,657**    | 16,350 (72%)           |
| Live session, no corpus at all (floor) | 6,109         | —                      |
| Bundle-only session                    | 19,599        | 16,350 (83%)           |
| Bundle-only, no corpus (floor)         | 3,057         | —                      |

The plan replaces the full bodies with a **one-row-per-document index** ("cards") in the prompt and a single read-only tool, `kinetica_knowledge_read`, that returns a document (or one section of it) on demand. A small set of **policy** documents stays inline because the agent must obey them without knowing to look them up.

Projected after implementation (same estimator, see Appendix A):

| Prompt                   | Today  | Projected | Change |
| ------------------------ | ------ | --------- | ------ |
| Live, bundle "available" | 22,657 | ~9,100    | −60%   |
| Bundle-only              | 19,599 | ~4,800    | −75%   |

The primary win is **context headroom and instruction focus**, not dollars. The SDK already caches the system prompt (`cacheReadTokens` telemetry in `run-agent.ts` confirms it), so corpus tokens cost ~0.1× per turn. What they DO cost is: a fixed 16k-token tax on every turn's context window, earlier compaction, prefill latency, and attention diluted across material irrelevant to the investigation at hand. The corpus grew from ~13.4k prompt tokens (2026-06-03 baseline in `prompt-budget.ts`) to 22.7k in three months and more imports are planned, so the current "load everything" design has a short runway.

**A prerequisite bug was found during this analysis** (§3): 7 of the 12 references currently load with **zero keywords**, because Prettier reflowed their `keywords:` arrays onto multiple lines and `parseFrontmatter()` reads only single-line values. Any retrieval design keyed on frontmatter must fix this first.

---

## 1. How the corpus reaches the model today

```
knowledge/playbooks/*.md ──▶ loadPlaybooks()          ─┐
knowledge/references/*.md ─▶ loadReferences()          ├─▶ buildSystemPrompt() / buildBundleSystemPrompt()
knowledge/references/bundle/*.md ─▶ loadBundleReferences() ┘        │
                                                                    ▼
                                            buildFailurePatternsSection(playbooks)   ── "### Common Failure Patterns" + every body
                                            buildReferenceSection(references)        ── "### Reference Knowledge"      + every body
                                            buildReferenceSection(bundleReferences)  ── inside "## Support Bundle Capability"
                                                                    │
                                                                    ▼
                                            query({ systemPrompt })  — fixed for the whole session
```

Key facts an implementer needs:

- **Loaders:** `src/agent/load-playbooks.ts` (`parseFrontmatter` :65-99, `extractBody` :110-113, `loadPlaybooks` :130-156) and `src/agent/load-references.ts` (`loadReferencesFrom` :38-64; `loadReferences` skips `bundle/`, `loadBundleReferences` reads only `bundle/`). Both resolve `knowledge/` via `findPackageRoot(__dirname)`, which works in dev (`tsx`) and in the tsup CJS bundle because `package.json` ships `knowledge/` alongside `dist/`. Nothing about shipping changes.
- **Types:** `src/types/index.ts:79-97` — `Playbook` (title, category, severity, keywords, body, filename) and `Reference` (same minus severity). All `readonly`.
- **Renderers:** `src/agent/prompt-sections.ts` (37 lines) — the two section builders above, shared by both prompt builders so they never import each other.
- **Live prompt:** `src/agent/system-prompt.ts` — sections rendered at :298-301; bundle refs rendered inside the bundle section at :160-164; the degraded-mode line at :131 tells the agent to "use only the commands in the service-management reference".
- **Bundle-only prompt:** `src/agent/bundle-system-prompt.ts` — sections at :109-111 (bundle refs rendered FIRST, then general refs); Round 1 at :80 says "See the support-bundle reference".
- **Wiring:** `src/agent/run-agent.ts` — loaders run in `Promise.all` at :437-442; prompt selection at :452-469; prompt-budget tripwire at :475-488; tool composition at :529-541; `allowedTools` union at :545-551; approval registry union at :559-567.
- **Budget tripwire:** `src/agent/prompt-budget.ts` — `DEFAULT_PROMPT_BUDGET_TOKENS = 30_000`, with a doc comment recording every re-baseline. Its stderr warning text (run-agent.ts:484-486) still says "consider keyword-based playbook selection".
- **Eval harness:** `src/evals/report-format.eval.ts:58-70` loads playbooks + references, builds its own prompt and its OWN tool list (diagnostic + mutation + capturing save_report + alter_table_columns). It must register the new tool too, or the prompt will advertise a tool that does not exist in the eval.
- **SDK constraints (`@anthropic-ai/claude-agent-sdk` 0.2.80):** `systemPrompt` is a plain string (or the `claude_code` preset). It is fixed at `query()` creation — there is no per-turn rebuild, and rebuilding would invalidate the prompt cache anyway. `createSdkMcpServer` accepts `tools` only (no MCP resources). The bundled CLI caps a single MCP tool result at `MAX_MCP_OUTPUT_TOKENS` (default 25,000).

### Cross-references that break the moment bodies leave the prompt

These are places where prompt text or one document points at another document _by name_, assuming it is present in context. Each needs to become a "read it with `kinetica_knowledge_read`" pointer, or the id resolver must accept the existing spelling (§5.4 recommends both):

| Where                                                                                                | Points at                          |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `system-prompt.ts:131` (degraded mode)                                                               | "the service-management reference" |
| `bundle-system-prompt.ts:80` (Round 1)                                                               | "the support-bundle reference"     |
| `knowledge/references/mutation-safety.md:50,116`                                                     | `service-management.md`            |
| `knowledge/playbooks/stale-rank.md:24`                                                               | `service-management.md`            |
| `knowledge/references/catalog-enums.md:48`                                                           | `catalog-joins.md`                 |
| `knowledge/references/service-management.md:102`                                                     | `gpudb-conf.md`                    |
| `knowledge/references/bundle/support-bundle.md:39`                                                   | `rank-architecture.md`             |
| `sql-dialect.md:28,50`, `sql-create-index.md:46`, `sql-alter-table.md:77`, `rank-architecture.md:75` | `version-quirks-7.2.md`            |

### Tests that pin the current behaviour (will change)

| File                                     | Lines                       | What it asserts                                                                                                                  |
| ---------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/agent/system-prompt.test.ts`        | 121-150                     | playbook bodies + "### Common Failure Patterns" heading present                                                                  |
|                                          | 563-567                     | Evidence Checklist appears before Common Failure Patterns (ordering — keep)                                                      |
|                                          | 652-800                     | "via real references": ALTER TABLE / CREATE INDEX / sql-dialect / mutation-safety / service-management **text is in the prompt** |
|                                          | 854-890                     | `TEST_REFERENCES` fixture: heading, bold title, **body content** in prompt                                                       |
| `src/agent/bundle-system-prompt.test.ts` | 37-145                      | playbooks/references/bundle refs injected in full                                                                                |
| `src/agent/run-agent.test.ts`            | 338, 1272                   | `allowedTools` has length **27** (live)                                                                                          |
|                                          | 499                         | `allowedTools` has length **11** (bundle-only)                                                                                   |
|                                          | 1111                        | MCP server `tools` has length **30**                                                                                             |
|                                          | 405-421, 550-566, 1147-1200 | positional args to `buildSystemPrompt` — the plan keeps the signature, so these stay                                             |

---

## 2. What "progressive disclosure" means here — three levels

| Level | Where it lives               | Cost                      | Contents                                                        |
| ----- | ---------------------------- | ------------------------- | --------------------------------------------------------------- |
| 0     | System prompt, full body     | always                    | Policy the agent must obey **without knowing to look** (see §4) |
| 1     | System prompt, one card each | always, ~60-90 tokens/doc | id, what it covers, and **when it must be read**                |
| 2     | Tool result, on demand       | only when read            | The full body, or one `##` section of it                        |

This mirrors how Claude Code's own skills work (name + description always present, body loaded on invoke), and it is the same pattern this repo already uses for tools: the Evidence Checklist is a card table (`reveals` / `whenToUse`) and the tool description is the body.

The one lesson from this repo's own history that shapes every detail below (from `CLAUDE.md`, Observability section): **"a capability described conditionally in the checklist is a capability the agent will not use, and an unevaluatable condition in a tool note is read as permission, not as a prompt to check."** Measured on a live cluster, the agent skipped the entire log dimension because the prompt framed it as probably-unavailable. Applied here: every card must state an **unconditional, phase-anchored trigger** ("before writing ANY SQL, read `sql-dialect`"), never a topical hint ("useful for SQL questions"). Retrieval that depends on the model _noticing relevance_ will be skipped; retrieval tied to a protocol step it is already executing will happen.

---

## 3. Prerequisite: fix `parseFrontmatter` (latent bug)

Measured with the real loaders (Appendix A script):

| File                                                                                           | keywords parsed   | Why                                                           |
| ---------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------- |
| catalog-enums.md                                                                               | **0** (9 in file) | Prettier reflowed `keywords: [a, b, …]` to a multi-line array |
| catalog-joins.md                                                                               | **0** (9)         | same                                                          |
| mutation-safety.md                                                                             | **0** (10)        | same                                                          |
| service-management.md                                                                          | **0** (14)        | same                                                          |
| sql-alter-table.md                                                                             | **0** (9)         | same                                                          |
| sql-dialect.md                                                                                 | **0** (15)        | same                                                          |
| version-quirks-7.2.md                                                                          | **0** (10)        | same                                                          |
| all playbooks, gpudb-conf, rank-architecture, sql-create-index, tiered-objects, support-bundle | correct           | arrays fit on one line                                        |

`parseFrontmatter` (`load-playbooks.ts:72-78`) walks the YAML block line by line and takes `key: value` pairs. For `keywords:` followed by `  [`, `    ki_catalog,` … the value is `""`, so `keywords` becomes `[]`, and the continuation lines (no colon) are skipped. `npm run format` runs `prettier --write .` and `.prettierignore` does not exclude `knowledge/`, so this recurs every time a keyword list exceeds `printWidth: 100`. Today nothing consumes keywords at runtime, which is why it went unnoticed; the moment cards or a search tool key on them it matters.

**Fix (Phase 0):** before the key/value loop, fold continuation lines into the preceding key: a line that does not match `/^\S[^:]*:/` is appended (space-joined) to the previous line. Then the existing bracket-array branch works unchanged. Do NOT solve it by adding `knowledge/` to `.prettierignore` — multi-line arrays are valid YAML and hand-authored ones would still break.

**Guard:** add a **corpus lint test** (§7, Phase 0) that loads the real `knowledge/` directory and asserts every document has ≥1 keyword. It would have caught this.

---

## 4. Disclosure tier per document

The tier is declared in frontmatter (`disclosure: inline | on-demand`, default `on-demand`) so the decision is a one-line, code-free, reversible edit — the same reason playbooks are Markdown in the first place. Recommended assignment, with the reasoning that matters:

| Document (id)        | Tokens                     | Tier                                                                                           | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | -------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mutation-safety`    | 1,275                      | **inline**                                                                                     | Policy: "NEVER propose /clear/table, ai_api_key, flush_to_disk…". It replaced an inline prompt block (see CLAUDE.md) and governs Round 4. An agent that has not read it does not know it should; the human approval gate is a backstop, not a substitute.                                                                                                                                                                                                            |
| `service-management` | 1,490                      | on-demand, **mandatory-read trigger**                                                          | Its "never emit" table exists because the agent DID emit `gadmin restart rank 2` (commit `fix(knowledge): correct service management commands`). Mitigation is a protocol hook, not a topical hint: "Before writing Remediation, read `service-management` if any step starts/stops/restarts anything." The card also carries the hard rule in one line. If the eval (§9) shows regressions, flip the frontmatter to `inline` — that is the whole point of the flag. |
| `sql-dialect`        | 1,246                      | on-demand, mandatory before any SQL                                                            | Same shape: "before composing ANY SQL you hand to the operator or run as a mutation".                                                                                                                                                                                                                                                                                                                                                                                |
| `gpudb-conf`         | 3,306                      | on-demand                                                                                      | Largest doc. Card lists its `##` sections so the agent can fetch one (`section: "Tiered Storage"`).                                                                                                                                                                                                                                                                                                                                                                  |
| `support-bundle`     | 2,619                      | **conditional**: inline when a bundle is attached or bundle-only; card when merely "available" | When a bundle is the session's subject, a guaranteed read is wasted latency; when no bundle is loaded, 2.6k tokens of parsing detail are dead weight. Mid-session attach is covered by a tool-result trigger (§5.6).                                                                                                                                                                                                                                                 |
| `tiered-objects`     | 1,323                      | on-demand                                                                                      | "before querying ki_tiered_objects".                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `version-quirks-7.2` | 993                        | on-demand                                                                                      | Much of it is already duplicated in tool descriptions and the prompt (ANALYZE TABLE, ki_tables). Trigger: "when a tool or SQL call fails unexpectedly, before retrying".                                                                                                                                                                                                                                                                                             |
| `rank-architecture`  | 969                        | on-demand                                                                                      | The one interpretive rule that prevents false positives (rank 0 is the head, minimal resources) is already stated in the `kinetica_get_metrics`, `kinetica_node_details`, `kinetica_resource_groups` descriptions at the point of use.                                                                                                                                                                                                                               |
| `sql-alter-table`    | 551                        | on-demand                                                                                      | trigger: before any ALTER TABLE / `kinetica_alter_table_columns`.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `catalog-enums`      | 549                        | on-demand                                                                                      | trigger: when a ki_catalog query returns coded values.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `catalog-joins`      | 513                        | on-demand                                                                                      | trigger: before joining two ki_catalog tables.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `sql-create-index`   | 398                        | on-demand                                                                                      | trigger: before proposing an index.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 6 playbooks          | 153-276 each (1,172 total) | on-demand, card = **Symptoms**                                                                 | Small individually, but uniform treatment matters more than the ~800 tokens saved today: the card IS the Symptoms section (the natural retrieval trigger), the body is Detection/Root Cause/Remediation. When symptoms match, the read runs in parallel with the Round-1 sweep. The playbook set is the part of the corpus most likely to grow.                                                                                                                      |

The report template (`knowledge/templates/report.md`, ~660 tokens) is not part of this: it is an output contract, deliberately placed last for recency, and stays.

---

## 5. Design

### 5.1 Document model (`src/types/index.ts`)

Extend `Playbook` and `Reference` with **optional** fields so every existing test fixture that builds a literal still compiles; the store normalises defaults (§5.3).

```ts
export type Disclosure = "inline" | "on-demand";
export type KnowledgeKind = "playbook" | "reference" | "bundle-reference";
export type KnowledgeSection = { readonly heading: string; readonly body: string };

// Shared shape. Playbook = this + severity (+ kind "playbook"); Reference = this (+ kind reference | bundle-reference).
type KnowledgeDocBase = {
  readonly title: string;
  readonly category: string;
  readonly keywords: readonly string[];
  readonly body: string;
  readonly filename: string;
  /** Filename stem, e.g. "gpudb-conf". The id the tool takes. */
  readonly id?: string;
  readonly kind?: KnowledgeKind;
  /** Frontmatter `summary` — one line, what the doc covers. */
  readonly summary?: string;
  /** Frontmatter `read_when` — the unconditional trigger. */
  readonly readWhen?: string;
  /** Frontmatter `disclosure`; default "on-demand". */
  readonly disclosure?: Disclosure;
  /** Split on `^#{2,3} ` headings; preamble before the first heading is "(intro)". */
  readonly sections?: readonly KnowledgeSection[];
};
```

`parseFrontmatter` gains `summary`, `read_when`, `disclosure` (validated to the two literals; anything else → default + `DEBUG` warning). `loadPlaybooks` / `loadReferencesFrom` populate `id` (`filename` minus `.md`), `kind`, and `sections`. Section splitting must handle `###` as well as `##`: `support-bundle.md` uses only `###`.

### 5.2 New frontmatter fields (corpus edits)

| Field        | Required for              | Rules                                                                                                                                   |
| ------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `summary`    | every on-demand reference | ≤ 220 chars, one line, states WHAT the doc contains. Not needed for playbooks (derived from Symptoms).                                  |
| `read_when`  | every on-demand reference | ≤ 160 chars, an **unconditional** trigger anchored to a protocol phase or an action ("before …", "when … fails"). Never "if you need…". |
| `disclosure` | optional                  | `inline` or `on-demand`. Only `mutation-safety.md` sets `inline` today.                                                                 |

Proposed text (the implementer may tighten wording; keep the imperative form):

| id                 | summary                                                                                                                                                                                                           | read_when                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| gpudb-conf         | Master config file: section index, performance-critical parameters, how a change actually takes effect (file edit + restart), tiered-storage limits/watermarks, WAL, alert thresholds, gotchas.                   | Before interpreting any gpudb.conf / `conf.*` property, proposing a config change, or claiming a change "took effect".                |
| tiered-objects     | `ki_tiered_objects` schema, the string `id` format (NOT a numeric OID — no join to `ki_objects`), tier hierarchy, ready-made diagnostic queries, gotchas.                                                         | Before querying `ki_tiered_objects` or reasoning about which objects sit in which tier.                                               |
| catalog-enums      | Decoders for `ki_catalog` coded columns: obj_kind, shard_kind, persistence, partition_type, tier, priority.                                                                                                       | When a `ki_catalog` query returns coded values you need to interpret.                                                                 |
| catalog-joins      | Safe join paths between `ki_catalog` tables (objects ↔ columns ↔ partitions ↔ query history ↔ tiered objects), oid compatibility, naming caveats.                                                                 | Before writing a join across two or more `ki_catalog` tables.                                                                         |
| rank-architecture  | Rank 0 is the head/coordinator (minimal resources, no data tiers); workers hold data; shard ownership; queries are logged on rank 0 only.                                                                         | Before judging any per-rank metric abnormal, and for crash forensics (which rank's log holds the SQL).                                |
| mutation-safety    | (inline — summary optional, used only by a future search tool)                                                                                                                                                    | —                                                                                                                                     |
| sql-alter-table    | Kinetica 7.2 ALTER TABLE grammar: ALTER/MODIFY COLUMN, property flags (DICT, TEXT_SEARCH, COMPRESS), shard-key immutability, dependent views are dropped.                                                         | Before composing any ALTER TABLE or calling `kinetica_alter_table_columns`.                                                           |
| sql-create-index   | CREATE INDEX / DROP INDEX syntax, column index vs chunk-skip index, IF NOT EXISTS, verifying with EXPLAIN.                                                                                                        | Before proposing or creating an index.                                                                                                |
| sql-dialect        | PostgreSQL-baseline mental model plus the false-friends table: SQL that looks valid but FAILS in Kinetica (TRY_CAST, backticks, timestamp arithmetic, NUMERIC).                                                   | Before writing ANY SQL you will hand to the operator or run as a mutation.                                                            |
| service-management | The ONLY sanctioned start/stop/restart commands (systemctl units, `/opt/gpudb/core/bin/gpudb` script), full-stack ordering, and the never-emit table. `gadmin` is a GUI, not a CLI; there is NO per-rank restart. | MANDATORY before any remediation step that starts, stops, or restarts anything.                                                       |
| version-quirks-7.2 | What fails on 7.2.x: unsupported commands (ANALYZE TABLE), missing tables (`ki_tables`, `ki_version`), correct `ki_columns` names, sentinel values (-1), endpoint preconditions.                                  | When a tool or SQL call fails unexpectedly (before retrying), and before proposing any command you have not verified on this version. |
| support-bundle     | Bundle layout, the two per-rank log families and their clocks, raw + Loki-JSONL line formats, severity order (`min_severity=ERROR` drops UERR), crash-SQL forensics, off-shape bundles.                           | Immediately after a bundle is attached, before the first `kinetica_bundle_*` call.                                                    |

### 5.3 The store — `src/knowledge/KnowledgeStore.ts` (new)

The in-memory analogue of `bundle/BundleSource.ts` / `observability/ObservabilityClient.ts`: a closure-based factory over the arrays the loaders already produce. (Naming caveat: `knowledge/` at the repo root is the corpus; `src/knowledge/` is code. Mirror `src/tools/knowledge/` so the pair reads consistently.)

```ts
export type KnowledgeStore = {
  /** All docs, normalised (id/kind/disclosure/sections/summary filled in). */
  readonly list: () => readonly KnowledgeDoc[];
  /** Resolve by id; tolerant of ".md" suffix and case ("service-management.md" works). */
  readonly get: (id: string) => KnowledgeDoc | undefined;
  /** Case-insensitive substring match on heading; undefined when no section matches. */
  readonly getSection: (id: string, heading: string) => KnowledgeSection | undefined;
  /** Docs whose effective disclosure is "inline" (after any forced overrides). */
  readonly inline: () => readonly KnowledgeDoc[];
  /** Docs rendered as cards. */
  readonly onDemand: () => readonly KnowledgeDoc[];
};
export function createKnowledgeStore(docs: readonly (Playbook | Reference)[]): KnowledgeStore;
```

Normalisation rules (pure, in `src/knowledge/normalize-doc.ts`):

- `id ??= filename.replace(/\.md$/, "")`; `disclosure ??= "on-demand"`; `sections ??= splitSections(body)`.
- `summary` for a playbook = the bullets of its `## Symptoms` section joined with `; `, clipped to ~200 chars; for a reference = frontmatter `summary`, else the first sentence of `## Overview`, else the title. A missing `summary` on an on-demand reference is a **corpus-lint failure** (§7), not a runtime error — the fallback only exists so a hand-written test fixture renders.
- Tolerant id resolution means the existing `service-management.md` mentions inside other documents keep working with no corpus edits.
- `MAX_DOC_TOKENS = 6_000`: a doc above this logs one stderr warning at load (`estimateTokens(body)`), naming the `section` parameter as the remedy. Largest today is 3,306; the MCP layer's hard cap is 25,000.

### 5.4 The tool — `kinetica_knowledge_read` (`src/tools/knowledge/`)

Follow `src/tools/observability/index.ts` as the template (tuple of names, `make*Tools(dep)`, `create*Registry()`, `readOnly: true`, failure objects that name the fix).

```ts
export const KNOWLEDGE_TOOL_NAMES = ["kinetica_knowledge_read"] as const;

export const KnowledgeReadSchema = z.object({
  id: z.string().min(1), // filename stem, e.g. "gpudb-conf"; ".md" tolerated
  section: z.string().optional(), // case-insensitive substring of a "##"/"###" heading
});
```

Behaviour:

- **Unknown id** → `{ ok: false, status: 0, error: "No knowledge document '<id>'. Available ids: …" }` (list every id, grouped by kind).
- **Section miss** → `{ ok: false, status: 0, error: "No section matching '<s>' in <id>. Sections: a; b; c" }`. Do not return the whole body on a miss: the agent asked for less, so give it the list and let it choose.
- **Success** → `note` first, then the markdown body: `"<title> — <kind>, ~<N> tokens. Sections: a; b; c. Cite this document by id in Evidence Collected."` The note goes first so it survives any truncation, matching `applyOutputPipeline`'s contract.
- **Output pipeline:** do NOT route the body through `applyOutputPipeline()`. `formatOutput` passes a string through unchanged (`stringifyValue`), but `truncateOutput` keeps head 150 + tail 50 lines and would **silently cut the middle** of any document over 200 lines — `gpudb-conf.md` is already 165. The body is authored markdown that needs no reshaping; compose `note + "\n\n" + body` directly and say so in the module header. Size is bounded by `MAX_DOC_TOKENS` at load.
- **Registration:** always, in every session (knowledge is capability-agnostic), bound to the store. `KNOWLEDGE_ALLOWED_TOOL_NAMES` joins the `allowedTools` union in `run-agent.ts:545-551` for both live and bundle-only; `createKnowledgeRegistry()` joins the registry union at :559-561. It never touches `ALLOWED_TOOL_NAMES` itself (that constant is the live diagnostic list the eval reuses) — export a separate constant, like `BUNDLE_ALLOWED_TOOL_NAMES`.
- **Tool description** (draft): "Read one document from the Kinetica knowledge library by id — a diagnostic playbook (symptoms → detection → root cause → remediation) or a reference (gpudb.conf, ki_catalog schemas, SQL dialect, service commands, version quirks, support-bundle parsing). The Knowledge Library section of your instructions lists every id with WHEN it must be read. Pass `section` to fetch one heading of a long document. Cheap and read-only: prefer reading to guessing, and call it in parallel with other tool calls."
- **Not needed now:** a `catalog.ts` typecheck guard. That pattern exists to render the Evidence Checklist; the knowledge tool's prompt surface is the Knowledge Library section itself. Add a catalog only when a second knowledge tool appears (§10, search).

### 5.5 Prompt rendering — `src/agent/prompt-sections.ts`

Keep both builders' **signatures unchanged** (they already take the arrays; `run-agent.test.ts` pins them positionally). Make the two section builders disclosure-aware and add one shared intro:

```ts
// Renders inline playbooks in full (today's format) and on-demand ones as a card table.
export function buildFailurePatternsSection(playbooks?: readonly Playbook[]): string;

// Same for references. `forceInline` is how the builders inline bundle refs when a bundle is attached.
export function buildReferenceSection(
  references?: readonly Reference[],
  opts?: { readonly forceInline?: boolean },
): string;

// "## Knowledge Library" — how the tool works and the mandatory-read rules. Rendered once per prompt,
// immediately before the two sections above. "" when there is nothing on-demand.
export function buildKnowledgeLibraryIntro(store: KnowledgeStore): string;
```

Card tables:

```
### Failure-Pattern Playbooks (read the matching one with kinetica_knowledge_read)

| id | severity | symptoms |
|----|----------|----------|
| memory-pressure | warning | Slow queries with no obvious cause; eviction warnings in logs; ki_tiered_objects showing data in PERSIST/DISK |
…

### Reference Library (read BEFORE acting — see "read when")

| id | covers | read when |
|----|--------|-----------|
| service-management | The ONLY sanctioned start/stop/restart commands … `gadmin` is a GUI, not a CLI; there is NO per-rank restart. | MANDATORY before any remediation step that starts, stops, or restarts anything. |
…
```

For documents over ~2,000 tokens (today: `gpudb-conf`, `support-bundle`) append the section list to the card (`sections: Section Index; Performance-Critical Parameters; …`) so the agent can request one section. Inline documents keep exactly today's `**Title:**\n\n<body>` format, so the mutation-safety assertions in `system-prompt.test.ts:757-800` continue to pass unchanged.

Section headings stay `### Common Failure Patterns` and `### Reference Knowledge` (as the outer wrappers) so the ordering test at `system-prompt.test.ts:563` and the heading tests keep passing; the card tables sit inside them.

### 5.6 Where the triggers go — protocol hooks, not hints

Edit the protocol text in both builders so every mandatory read hangs off a step the agent is already executing:

| Location                                  | Add                                                                                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system-prompt.ts` Round 1 (:197-204)     | bullet: "`kinetica_knowledge_read` — for every playbook whose symptoms match the report, in parallel with the sweep."                                                                                         |
| Round 2 (:206-213)                        | "Before querying `ki_tiered_objects`, joining `ki_catalog` tables, or decoding coded columns, read the reference the library names."                                                                          |
| Round 4 step 1 (:220-223)                 | "Before proposing: read `sql-dialect` plus `sql-alter-table` / `sql-create-index` for any SQL; `gpudb-conf` for any property change. Mutation Safety Rules are below."                                        |
| Evidence Gap Handling (:329-342)          | "On an unexpected tool or SQL error, read `version-quirks-7.2` before retrying."                                                                                                                              |
| Fix Instructions (:348-355)               | "Before writing the Remediation list: read `service-management` if any step starts, stops or restarts anything; read `sql-dialect` if any step contains SQL. Cite the ids you read under Evidence Collected." |
| Degraded mode (:131)                      | "…in `service-management` — read it with `kinetica_knowledge_read` before writing them; there is no `gadmin` service-control CLI."                                                                            |
| Bundle section, "available" branch (:154) | after `kinetica_load_bundle` succeeds: "read `support-bundle` before the first `kinetica_bundle_*` call."                                                                                                     |
| `bundle-system-prompt.ts` Round 1 (:80)   | unchanged — `support-bundle` is inline in this prompt.                                                                                                                                                        |
| Both prompts, Evidence Collected guidance | "Name the knowledge ids you read (`knowledge: memory-pressure, tiered-objects`)." Makes retrieval auditable in the eval and in saved reports.                                                                 |

Tool-result triggers (the most reliable channel this repo has found):

- `src/tools/bundle/load-bundle.ts:82` — extend the note: "…Then read `support-bundle` with `kinetica_knowledge_read` before calling any `kinetica_bundle_*` tool." This is what replaces today's justification for loading bundle refs into every live prompt.
- _(Optional, Phase 3)_ `src/tools/sql/enrich-error.ts` — append "If this is a syntax/unsupported error, read `version-quirks-7.2` and `sql-dialect`." to the enriched message.

Conditional inline for bundle references:

- `buildSystemPrompt(… bundleCapability === "attached" …)` → `buildReferenceSection(bundleReferences, { forceInline: true })`; `"available"` → cards.
- `buildBundleSystemPrompt` → `forceInline: true` for `bundleReferences`; general references as cards.

Budget tripwire text (`run-agent.ts:484-486`): replace "consider keyword-based playbook selection" with "check for documents marked `disclosure: inline` that could be on-demand, and for cards whose summaries have grown."

### 5.7 Wiring — `src/agent/run-agent.ts`

After the existing `Promise.all` at :437-442:

```ts
const knowledgeStore = createKnowledgeStore([...playbooks, ...references, ...bundleReferences]);
```

Then: pass nothing new to the prompt builders (they receive the same arrays; the renderer derives cards from `disclosure`), register `...makeKnowledgeTools(knowledgeStore)` in `serverTools` (:541), add `...KNOWLEDGE_ALLOWED_TOOL_NAMES` to the `allowedTools` set (:545-551), and union `createKnowledgeRegistry().tools` into the registry (:559-561). Update the header comment tool counts. Test pins move: `allowedTools` 27 → **28** (live), 11 → **12** (bundle-only); server tools 30 → **31**.

`src/evals/report-format.eval.ts:58-70`: build the same store from its loaded arrays, add `...makeKnowledgeTools(store)` to the server `tools`, and `...KNOWLEDGE_ALLOWED_TOOL_NAMES` to `allowedTools`. Without this the eval prompt advertises a tool the eval server lacks.

---

## 6. Alternatives considered

| Option                                                                                                   | Verdict                   | Why                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent SDK skills** (`SKILL.md` dirs, `settingSources`, `skills` opt)                                   | reject                    | It IS progressive disclosure, but it requires the `claude_code` preset prompt or filesystem settings sources, discovers skills relative to the _operator's_ cwd (not the npm package), bypasses the typed `Reference` pipeline and its tests, and this agent deliberately disallows the file tools skills lean on. Portability of `npx admin-agent` from any directory is non-negotiable. |
| **MCP resources** (`resources/list` + `resources/read`)                                                  | reject                    | Semantically the right primitive, but `createSdkMcpServer` accepts `tools` only, and the built-in `ReadMcpResourceTool` would have to be allow-listed and cannot carry this repo's failure/note conventions.                                                                                                                                                                              |
| **Rebuild the system prompt per turn** with only relevant docs                                           | reject                    | `systemPrompt` is fixed at `query()`; even if it were not, every change invalidates the cached prefix, which is the one thing that makes the corpus cheap today.                                                                                                                                                                                                                          |
| **Keyword pre-selection on the first user message** (RAG-lite: append matching bodies to the issue text) | defer (Phase 3, optional) | Zero extra turns, but keyword overlap on a one-line issue is weak, it duplicates what the agent will read anyway, and it cannot cover Rounds 2-5. Worth adding only if the eval shows Round-1 reads are consistently late.                                                                                                                                                                |
| **Split large docs into more, smaller docs**                                                             | partial                   | The `section` parameter gives the same benefit without fragmenting authorship. Revisit if a doc exceeds `MAX_DOC_TOKENS`.                                                                                                                                                                                                                                                                 |
| **Keep everything inline, raise the threshold again**                                                    | reject                    | That is the status quo; `DEFAULT_PROMPT_BUDGET_TOKENS` has already been raised twice (15k → 20k → 30k) and the threshold's own doc comment says each raise is a re-baseline, not a fix.                                                                                                                                                                                                   |

---

## 7. Implementation phases

Each phase is independently shippable and leaves `npm run typecheck && npm test && npm run lint && npm run format:check` green. TDD per repo rules: write the failing test first.

### Phase 0 — Groundwork (no behaviour change; prompt byte-for-byte identical)

1. **Fix `parseFrontmatter`** for multi-line bracket arrays (§3). Test: `load-playbooks.test.ts` — a fixture with Prettier's exact multi-line layout parses all items; also `disclosure: nonsense` falls back to default.
2. **Extend types** (§5.1) with optional fields; parse `summary`, `read_when`, `disclosure`; populate `id`, `kind`, `sections` in both loaders. Tests: `load-references.test.ts` — `kind` is `bundle-reference` from `loadBundleReferences`; `sections` split on `##` AND `###`; `(intro)` preamble.
3. **Author frontmatter** for all 12 references (`summary`, `read_when`; `disclosure: inline` on `mutation-safety.md`) per §5.2.
4. **Corpus lint test** — `src/knowledge/corpus.test.ts`, reads the REAL `knowledge/` tree (it is the one place the repo tests real corpus files, so keep it small and deterministic):
   - every doc has ≥ 1 keyword (catches §3 forever);
   - every on-demand reference has `summary` ≤ 220 chars and `read_when` ≤ 160 chars;
   - ids unique across playbooks + references + bundle;
   - every `<name>.md` mentioned inside a doc body resolves to an existing id (catches dangling cross-references — there are 13 today, §1);
   - no doc exceeds `MAX_DOC_TOKENS`;
   - every playbook has a `## Symptoms` section (the card depends on it).
5. **Acceptance:** `npm test` green; Appendix A script reports the same 22,657 / 19,599 as today (renderers untouched), and 0 → correct keyword counts for the 7 affected files.

### Phase 1 — The store and the tool (additive; prompt still inline)

1. `src/knowledge/normalize-doc.ts` + `KnowledgeStore.ts` (§5.3) with tests: id resolution (`x`, `x.md`, case), section match, inline/on-demand partition, playbook summary derivation, `MAX_DOC_TOKENS` warning.
2. `src/tools/knowledge/{index.ts, read-knowledge.ts}` (§5.4) with tests: success note-first + body verbatim (assert a 250-line synthetic doc is NOT truncated); unknown id lists ids; section miss lists sections; `readOnly: true` annotation; registry contains the name.
3. Wire into `run-agent.ts` and the eval harness (§5.7). Update the three count pins in `run-agent.test.ts`.
4. **Acceptance:** run `npm run dev` against any cluster (or `--bundle`) and ask "read the gpudb-conf reference, WAL section" — the tool returns that section. Tool count in `CLAUDE.md`/`README.md` headers: 32 → 33.

### Phase 2 — Flip to cards (the behaviour change)

1. `prompt-sections.ts` disclosure-aware rendering + `buildKnowledgeLibraryIntro` (§5.5), with `prompt-sections.test.ts` (new — the file has no tests today per CodeGraph): inline doc renders body; on-demand renders one row with id/summary/read_when; `forceInline`; section list appears only for docs > 2,000 tokens; empty input → `""`.
2. Protocol hooks and cross-reference rewrites in both builders (§5.6); `load-bundle.ts` note; budget-warning text.
3. Conditional inline for bundle refs in both builders.
4. **Migrate tests** (§8).
5. **Re-baseline** `DEFAULT_PROMPT_BUDGET_TOKENS`: measure with Appendix A, then set the threshold to roughly 1.5× the new live-with-observability figure (expected ~11k → threshold **15,000**), and add the dated line to the constant's doc comment as its history demands. Update the three measured-baseline tables in `CLAUDE.md` (Prompt Budget Tripwire) and the stale README paragraph (`README.md:503` still says ~20,000 / ~17.2k).
6. **Docs:** `README.md:438-503` (new frontmatter fields, the "Heads up — prompt budget" paragraph, the bundle-reference paragraph that justifies loading it everywhere), `CLAUDE.md` (Knowledge Playbooks / Knowledge References / System Prompt / Agent Loop tool counts / Offline Bundle Mode "Prompt" paragraph), `docs/architecture.html` (tool and reference counts), `src/evals/README.md` (new eval row).
7. **Eval** (§9) before merging; record turns/cost/tokens before vs after in this file's Appendix B.
8. **Acceptance:** live prompt ≤ ~9.5k tokens without observability; both evals pass; `kinetica_knowledge_read` appears in the eval transcript before `save_report`.

### Phase 3 — Only when a trigger fires (do not build speculatively)

| Trigger                                                              | Add                                                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Card tables exceed ~3,000 tokens, or the corpus passes ~30 documents | `kinetica_knowledge_search(query)` over title/keywords/summary (+ body term overlap) returning top-N cards; add `src/tools/knowledge/catalog.ts` then. |
| Eval shows Round-1 playbook reads consistently arrive after Round 2  | First-message keyword pre-selection in `makeInteractivePrompt`, appending matched **cards** (not bodies) to the issue text.                            |
| Agents retry failed SQL without reading quirks                       | The `enrich-error.ts` hint (§5.6).                                                                                                                     |
| A rollback switch is wanted for a release                            | `ADMIN_AGENT_DISCLOSURE=inline` env override honoured by `normalize-doc.ts` (forces every doc inline). Record it in `.env.example` and `CLAUDE.md`.    |

---

## 8. Test migration map

| Existing test                                                                  | Change                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `system-prompt.test.ts:121-150` playbook bodies present                        | Fixtures default to on-demand → assert the **card** (title/id + symptoms) is present and the Detection/Remediation text is NOT. Add one fixture with `disclosure: "inline"` asserting today's body format.                                                                                                                           |
| `:563-567` ordering                                                            | Keep as is.                                                                                                                                                                                                                                                                                                                          |
| `:652-755` ALTER TABLE / CREATE INDEX / sql-dialect text "via real references" | These verify the real files still carry the rules. Move them to `src/knowledge/KnowledgeStore.test.ts` (or a `real-corpus` block in `corpus.test.ts`): `store.get("sql-alter-table").body` contains `VARCHAR(size, DICT)`, etc. Keep one prompt-level assertion per doc: its card row is present.                                    |
| `:757-800` mutation-safety + service-management                                | mutation-safety stays inline → **unchanged**. The two service-management assertions (`systemctl start gpudb_host_manager`, `There Is No Per-Rank Restart`) move to the store test; keep `not.toMatch(/run \`gadmin/)` at prompt level, and add: prompt contains the service-management card with "NOT a CLI" and "MANDATORY before". |
| `:854-890` `TEST_REFERENCES` body content                                      | Split: on-demand fixture → card row; inline fixture → body.                                                                                                                                                                                                                                                                          |
| `bundle-system-prompt.test.ts:37-145`                                          | Bundle refs remain inline in this prompt → those assertions stay. General references → card assertions. `system-prompt` "attached" parity test (:122-138) still expects the body; add an "available → card only" case.                                                                                                               |
| `run-agent.test.ts:338, 499, 1111, 1272`                                       | 27 → 28, 11 → 12, 30 → 31, 27 → 28.                                                                                                                                                                                                                                                                                                  |
| `run-agent.test.ts` positional `buildSystemPrompt` assertions                  | Unchanged (signature kept).                                                                                                                                                                                                                                                                                                          |

New test files: `load-playbooks.test.ts` (extend), `load-references.test.ts` (extend), `src/knowledge/normalize-doc.test.ts`, `src/knowledge/KnowledgeStore.test.ts`, `src/knowledge/corpus.test.ts`, `src/tools/knowledge/knowledge-tools.test.ts`, `src/agent/prompt-sections.test.ts`. Coverage threshold is 80% lines; all of the above are pure and cheap to cover.

---

## 9. Eval — prove the agent actually reads

Add `src/evals/knowledge-retrieval.eval.ts` (+ `"eval:knowledge-retrieval"` script), following `report-format.eval.ts` and its README:

- **Issue:** "Queries have become slow over the last hour and we are seeing eviction warnings." (matches the `memory-pressure` playbook card).
- **Collect** every `tool_use` block from assistant messages (name + input) in order, plus the captured report.
- **Assert:**
  1. at least one `kinetica_knowledge_read` occurs **before** `save_report`;
  2. the ids read include `memory-pressure` or `tiered-objects`;
  3. if the report's Remediation mentions restart/start/stop/`systemctl`, then `service-management` was read AND the report contains no `gadmin` used as a command (`/gadmin (restart|start|stop|status)/` absent);
  4. the report still passes `validateReportStructure`;
  5. the report's Evidence Collected names the knowledge ids read (the §5.6 instruction).
- **Record** turns, cost and `cacheReadTokens` for `report-format` before and after Phase 2 in Appendix B. Expect a small turn increase (1-3 reads) and a large drop in per-turn input tokens.

Pure assertion helpers (`knowledge-assertions.ts`) get a sibling `.test.ts` so the validator is covered by the fast suite, per the eval README's rule.

---

## 10. Risks and mitigations

| Risk                                                                          | Mitigation                                                                                                                                                                       |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent skips a read it needed (the failure mode this repo has measured before) | Phase-anchored mandatory triggers (§5.6), the hard rule repeated in the card, tool-result notes, the eval in §9, and `disclosure: inline` as a one-line escalation per document. |
| Agent reads every document every time (turn cost, no benefit)                 | Cards say WHEN, the intro says "read what the phase requires"; the eval counts reads. If reads exceed ~5 per investigation, tighten `read_when` wording before adding mechanism. |
| Remediation regresses to `gadmin` commands                                    | The mandatory pre-Remediation read of `service-management`; eval assertion 3; flip to `inline` if it still regresses.                                                            |
| Compaction (`compact_boundary`) drops an earlier read from context            | Expected and harmless — the agent re-reads (cheap). Note it in the intro: "if you no longer see a document you read, read it again."                                             |
| Document longer than 200 lines gets middle-truncated                          | The tool bypasses `truncateOutput` by design (§5.4); `MAX_DOC_TOKENS` warns at load.                                                                                             |
| Card table itself grows unbounded                                             | It is inside the measured system prompt, so the existing tripwire catches it; Phase 3's search tool is the next step, with a recorded trigger.                                   |
| Prettier reflows a new long `keywords:` array again                           | Fixed parser + corpus lint (§3).                                                                                                                                                 |
| Eval flakiness (model non-determinism)                                        | Assertions are structural (did a read happen, is `gadmin` absent), not wording; run twice before concluding a regression.                                                        |

---

## 11. Decisions for the owner (each has a recommendation; proceed with it unless overruled)

1. **Playbooks: cards or inline?** Recommend **cards** (uniform mechanism, card = Symptoms). Saves only ~800 tokens today, but the playbook set is the part of the corpus expected to grow.
2. **`service-management`: inline or mandatory-read?** Recommend **mandatory-read** with the card carrying the hard rule, escalating to `inline` if §9 assertion 3 fails twice.
3. **Threshold after re-baseline:** recommend **15,000**, recorded in the constant's doc comment.
4. **Search tool now or later?** **Later** — 18 cards fit in ~1.4k tokens; the trigger is recorded in Phase 3.

---

## Appendix A — Measurement script (re-run before and after each phase)

Save as a scratch file outside the repo (it imports from `src/` directly) and run with `npx tsx <file>`. Uses the repo's own `estimateTokens` (chars/4) so the numbers are comparable with `CLAUDE.md`'s tables. Wrapped in `main()` because tsx compiles to CJS here and rejects top-level `await`.

```ts
import { loadReferences, loadBundleReferences } from "<repo>/src/agent/load-references.ts";
import { loadPlaybooks } from "<repo>/src/agent/load-playbooks.ts";
import { estimateTokens } from "<repo>/src/agent/prompt-budget.ts";
import { buildSystemPrompt } from "<repo>/src/agent/system-prompt.ts";
import { buildBundleSystemPrompt } from "<repo>/src/agent/bundle-system-prompt.ts";
import {
  buildReferenceSection,
  buildFailurePatternsSection,
} from "<repo>/src/agent/prompt-sections.ts";

async function main() {
  const [refs, brefs, pbs] = await Promise.all([
    loadReferences(),
    loadBundleReferences(),
    loadPlaybooks(),
  ]);
  for (const d of [...pbs, ...refs, ...brefs]) {
    console.log(
      `${d.filename} | keywords=${d.keywords.length} | ~${estimateTokens(d.body)} tokens`,
    );
  }
  const live = buildSystemPrompt(
    "7.2.3.20",
    undefined,
    pbs,
    refs,
    false,
    "available",
    brefs,
    undefined,
  );
  const liveFloor = buildSystemPrompt(
    "7.2.3.20",
    undefined,
    [],
    [],
    false,
    "available",
    [],
    undefined,
  );
  const bundle = buildBundleSystemPrompt("7.2.3.20", pbs, refs, brefs, undefined);
  const bundleFloor = buildBundleSystemPrompt("7.2.3.20", [], [], [], undefined);
  console.log("live available      :", estimateTokens(live));
  console.log("live floor          :", estimateTokens(liveFloor));
  console.log("bundle-only         :", estimateTokens(bundle));
  console.log("bundle-only floor   :", estimateTokens(bundleFloor));
  console.log("playbooks section   :", estimateTokens(buildFailurePatternsSection(pbs)));
  console.log("references section  :", estimateTokens(buildReferenceSection(refs)));
  console.log("bundle refs section :", estimateTokens(buildReferenceSection(brefs)));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Per-document baseline, 2026-09-12 (`estimateTokens(body)`):

| id                        | kind             | tokens     | keywords parsed today |
| ------------------------- | ---------------- | ---------- | --------------------- |
| config-drift              | playbook         | 159        | 5                     |
| gpu-out-of-memory         | playbook         | 158        | 5                     |
| memory-pressure           | playbook         | 191        | 6                     |
| query-contention          | playbook         | 181        | 6                     |
| resource-group-exhaustion | playbook         | 153        | 6                     |
| stale-rank                | playbook         | 276        | 5                     |
| catalog-enums             | reference        | 549        | **0**                 |
| catalog-joins             | reference        | 513        | **0**                 |
| gpudb-conf                | reference        | 3,306      | 7                     |
| mutation-safety           | reference        | 1,275      | **0**                 |
| rank-architecture         | reference        | 969        | 8                     |
| service-management        | reference        | 1,490      | **0**                 |
| sql-alter-table           | reference        | 551        | **0**                 |
| sql-create-index          | reference        | 398        | 7                     |
| sql-dialect               | reference        | 1,246      | **0**                 |
| tiered-objects            | reference        | 1,323      | 9                     |
| version-quirks-7.2        | reference        | 993        | **0**                 |
| support-bundle            | bundle-reference | 2,619      | 9                     |
| **total**                 |                  | **16,350** |                       |

Sections as rendered today: playbooks 1,172; references 12,742; bundle references 2,635. Card projection (title + category + keywords + 160-char summary + 60-char trigger, 18 docs): ~1,430 tokens.

## Appendix B — Before/after

Prompt figures measured 2026-09-12 with the Appendix A script (same `estimateTokens`
heuristic on both sides, so the columns are comparable).

| Metric                                     | Before (2026-09-12) | After      | Change   |
| ------------------------------------------ | ------------------- | ---------- | -------- |
| Live prompt, "available", no observability | 22,657              | **9,290**  | **−59%** |
| Live prompt, "available", + observability  | ~24,854             | **11,487** | **−54%** |
| Live prompt, "attached", + observability   | ~24,780             | 13,815     | −44%     |
| Degraded prompt, + observability           | —                   | 11,988     | —        |
| Bundle-only prompt                         | 19,599              | **8,359**  | **−57%** |
| Bundle-only prompt, + observability        | —                   | 10,571     | —        |
| Corpus bodies rendered into the prompt     | 16,350 tokens       | 3,894      | −76%     |
| `DEFAULT_PROMPT_BUDGET_TOKENS`             | 30,000              | **18,000** | −40%     |
| Unit tests                                 | 2,258               | **2,368**  | +110     |
| `report-format` eval                       | not run             | **PASS**   | —        |
| `report-format` eval: turns / cost         | not run             | 17 / $0.37 | —        |
| `knowledge-retrieval` eval (2 scenarios)   | n/a                 | **PASS**   | —        |
| `knowledge-retrieval`: reads before report | n/a                 | **2-6**    | —        |
| `knowledge-retrieval`: turns / cost        | n/a                 | 46 / $0.99 | —        |
| `service-management` trigger fires         | always inline       | **proven** | —        |

The 3,894 tokens of bodies still in the "attached" prompt are the two deliberate inline
documents: `mutation-safety` (1,275) and `support-bundle` (2,619). In the "available"
prompt only `mutation-safety` is inlined.

### `knowledge-retrieval`: PASS, 2026-09-12

```
Result: success. Turns: 30. Cost: $0.6658. Cache reads: 812311 tokens.
Tool calls: 28. Turn groups: 2.
Knowledge reads: 4 [memory-pressure, tiered-objects, rank-architecture, version-quirks-7.2]
Retrieval assertions PASSED (read before reporting, and read a matching document).
PASS: Agent read the matching documents before reporting, and the report conforms.
```

All five assertions hold: a read preceded `save_report`; the ids include the document
matching the issue; the Remediation's service-management obligation was satisfied; the
report passes `validateReportStructure`; and it names the knowledge ids it read.

**The stronger evidence is the spread across four valid runs**, not this single green one.
Retrieval was measured every time, even on the runs that failed for harness reasons:

| Run | Reads | Documents                                                                                             |
| --- | ----- | ----------------------------------------------------------------------------------------------------- |
| 1   | 4     | memory-pressure, tiered-objects, sql-dialect, version-quirks-7.2                                      |
| 2   | 6     | memory-pressure, query-contention, tiered-objects, rank-architecture, sql-dialect, version-quirks-7.2 |
| 3   | 4     | memory-pressure, tiered-objects, rank-architecture, gpudb-conf                                        |
| 4   | 4     | memory-pressure, tiered-objects, rank-architecture, version-quirks-7.2                                |

`memory-pressure` and `tiered-objects` appear in **all four** — the Round-1 symptom match
and the Round-2 "before you query `ki_tiered_objects`" hook fire reliably. Everything else
varies with what that investigation actually encountered, which is the correct shape: a
document read on every run regardless of evidence would mean the agent was grazing the
library rather than answering a trigger. Reads stayed in the 4-6 band across every run,
inside §10's "tighten `read_when` if it exceeds ~5" guard, and the agent never read all 17
cards. Cache reads of 0.8-1.0M tokens per run confirm the system prompt is served from
cache throughout, so the disclosure saving is context headroom rather than spend — the
claim §0 made, now measured.

### `report-format`: PASS, 2026-09-12

```
Result: success. Turns: 17. Cost: $0.3724. Cache reads: 330382 tokens.
Tool calls: 15. Turn groups: 2.
PASS: Report conforms to the template structure.
```

Worth noting what this run actually proves. `report-format` is the PRE-EXISTING eval, and
it carried the same missing-operator flaw: it too yielded one user message against a
prompt that asks for consent before saving, so it could never have captured a report
either — its Appendix B row read "not run" for a reason. The harness work therefore
repaired an eval that was already broken, rather than only enabling the new one, and
`Turn groups: 2` is the same handshake completing here.

It also confirms the shared harness changes (scripted operator, `consumeTranscript`,
`maxTurns` 50) did not disturb what it was written to measure: the report still conforms
to `knowledge/templates/report.md` with the corpus bodies no longer in the prompt.

### How these evals got to green — four harness bugs, no model bugs

Recorded because the cost was real: four live runs (~$0.29-$0.67 each) were spent on
harness defects, every one of which presented as a model failure.

#### Earlier runs, for provenance

```
Result: success. Turns: 29. Cost: $0.2631. Cache reads: 840582 tokens.
Tool calls: 28. Knowledge reads: 4 [memory-pressure, tiered-objects, sql-dialect, version-quirks-7.2]
```

**This is the measurement the whole design rests on, and it is the good outcome.** The
four reads land on four DIFFERENT protocol hooks, which is exactly what §5.6 set out to
achieve and what §2 warned would not happen if the cards described topics instead of
triggers:

| id                   | Hook that fired                                                     |
| -------------------- | ------------------------------------------------------------------- |
| `memory-pressure`    | Round 1 — the playbook card's symptoms matched the reported issue   |
| `tiered-objects`     | Round 2 — "before you query `ki_tiered_objects`"                    |
| `sql-dialect`        | Round 4 / Fix Instructions — "before writing ANY SQL"               |
| `version-quirks-7.2` | Evidence Gap Handling — "on an unexpected failure, before retrying" |

Four reads sits inside §10's guard ("if reads exceed ~5 per investigation, tighten
`read_when` wording before adding mechanism"), so no tightening is indicated. The agent
did NOT read the whole library — the thing a card table makes tempting and the intro
explicitly forbids. `Cache reads: 840,582` confirms the system prompt is served from
cache across all 29 turns, which is why the disclosure saving is context headroom rather
than spend, exactly as §0 claimed.

`service-management` was NOT read, which is correct only if the report's Remediation
contained no step that starts, stops or restarts anything. Assertion 3 is what decides
that, and reviewing it after this run exposed a defect in the assertion itself: it tested
the WHOLE report, so an investigation that merely narrates a restart (a Timeline row, a
Root Cause) would have demanded a read the protocol never required. Now scoped to the
`## Remediation` section — `knowledge-assertions.ts`, two tests pin both directions.

**Verdict on that run: `FAIL: Agent never called save_report` — and it was the HARNESS,
not the agent.** Both prompts gate saving behind a conversational turn (`system-prompt.ts`,
Post-Report Behavior): present the report, ask "save? (yes/no)", then STOP and wait. The
eval yielded ONE user message, so the agent asked and nobody answered. A 29-turn,
28-tool-call investigation with four correct knowledge reads therefore reported a save
failure. Nothing in it indicts progressive disclosure — the retrieval assertions never
even ran, because the report they assert on was never captured.

Two harness fixes followed, both mirroring prod:

- `src/evals/scripted-operator.ts` — yields the issue, then answers each time the agent
  ends its turn, awaiting the same `TurnGate` on the same `stop_reason === "end_turn"`
  signal `run-agent.ts` uses. Two replies rather than one (an early end-of-turn would
  otherwise consume the only answer at the wrong moment), and it stops once the report is
  captured so a spare reply never buys another billed turn.
- `maxTurns` 30 → 50 in both evals. That run reached turn 29 BEFORE the save question, so
  30 left no room for the exchange that follows it. `maxBudgetUsd: 2.0` stays the real
  cost guard — the run billed $0.26.

That fix was necessary but NOT sufficient. A second run — 30 turns, 29 tool calls, **6**
correct knowledge reads (`memory-pressure`, `query-contention`, `tiered-objects`,
`rank-architecture`, `sql-dialect`, `version-quirks-7.2`) — reported the same failure,
because the eval's consuming loop `break`s on the first `result` message. A result arrives
at the end of **each agent turn**, not once per session: `run-agent.ts` handles one and
keeps iterating, opening its turn gate so the generator "can exit cleanly". Breaking there
abandons the stream exactly when the agent has asked whether to save, so the scripted
operator's answer is yielded into a stream nobody is reading.

Third fix: `consumeTranscript()` in `src/evals/transcript.ts` — one tested function that
consumes the stream to completion and signals the caller on end-of-turn AND on a result,
now shared by both evals instead of being written inline in each. Both evals also print
**`Turn groups: N`** (the result-message count); `N > 1` is the direct evidence the
operator's reply landed, and its absence is what hid this bug across two runs.

**Lessons worth keeping:**

1. This eval asserts on an artifact the agent only produces after a conversational
   handshake. Any future eval that does must script the operator, or it measures the
   harness rather than the model.
2. The consuming loop is not boilerplate. It carried two separate bugs, both of which
   presented identically as a model failure. It belongs in a tested function, and its
   telemetry must include enough to tell a one-turn run from a multi-turn one.

**Still to record:** a verdict from a re-run of both evals with the operator wired in, and
`report-format`'s turns/cost. Until then Phase 2 is behaviourally _evidenced_ (the four
reads above) but not _signed off_. Run each twice before treating a failure as a
regression (§10).
