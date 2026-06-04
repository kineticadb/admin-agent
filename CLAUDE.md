# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An autonomous diagnostic agent for Kinetica databases, built with the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). The agent connects to a live Kinetica instance, investigates issues using 22 MCP tools (16 diagnostic + 4 mutation + save_report + alter_table_columns), and produces structured markdown reports.

## Commands

```bash
npm run build          # Bundle with tsup → dist/admin-agent.js (CJS, node20)
npm run typecheck      # tsc --noEmit
npm test               # vitest run (all src/**/*.test.ts)
npm run test:watch     # vitest in watch mode
npm run test:coverage  # vitest with v8 coverage (80% line threshold)
npm run dev            # Run from source via tsx src/cli/index.ts
npm run eval           # Run the report-format eval against the real Anthropic API (requires ANTHROPIC_API_KEY)
```

CLI flags:

```bash
npm run dev -- --verbose             # Enable debug logging
npm run dev -- --version             # Print version and exit
npm run dev -- --help                # Show usage
npm run dev -- --login               # Force OAuth login (even if API key is set)
npm run dev -- --login-method=TYPE   # Login method: claudeai (Pro/Max) or console
npm run dev -- --login-org=UUID      # Target organization UUID for OAuth
npm run dev -- --logout              # Log out from Anthropic account and exit
npm run dev -- --model=NAME          # Override agent model (sonnet | haiku | opus); default: sonnet
npm run dev -- --max-budget=USD      # Per-session budget cap in USD (API-key billing only); default: 5.00
```

Run a single test file:

```bash
npx vitest run src/agent/turn-gate.test.ts
```

Environment variables (see `.env.example`):

```bash
ANTHROPIC_API_KEY=sk-...       # Optional — OAuth login via browser if unset
KINETICA_URL=http://host:9191  # Prompted interactively if not set
KINETICA_USER=admin            # Prompted interactively if not set
KINETICA_PASS=secret           # Prompted interactively if not set (masked)
KINETICA_HTTPS_ONLY=1          # Optional: refuse plaintext HTTP fallback after a failed HTTPS probe
ADMIN_AGENT_MAX_BUDGET=10      # Optional: per-session budget cap in USD (overridden by --max-budget); default 5.00
DEBUG=1                        # Optional: logs HTTP requests + system-prompt token size to stderr
NODE_ENV=test                  # Set automatically by vitest; skips main() execution
```

Linting and formatting:

```bash
npm run lint            # ESLint with typescript-eslint recommendedTypeChecked + stylisticTypeChecked
npm run lint:fix        # Auto-fix what ESLint can
npm run format          # Prettier — format all supported files
npm run format:check    # Prettier — check formatting without writing
```

CI (`.github/workflows/ci.yml`) runs `typecheck`, `test`, and `build` on Node 20.x and 22.x for every PR and push to `main`. A separate `lint` job runs `npm run lint` (ESLint) and `npm run format:check` (Prettier) once on Node 20.x. Neither ESLint nor Prettier is wired into `prepublishOnly` — but both gate every PR via CI, so run `npm run lint` and `npm run format:check` (or `npm run format` to auto-fix) before opening a PR.

## Architecture

### Startup Flow

`cli/index.ts` → `--logout` early exit via `auth/logout.ts` (if flag) → `--version` early exit via `cli/version.ts` `getVersion()` (walks up to `package.json`, works in both dev and bundled mode) → `--model=<name>` parsed and validated against `SUPPORTED_MODELS` (unknown values exit with code 1 before any side effects) → `session/env-file.ts` `loadEnvFile()` (`.env` → `process.env`, shell vars win, empty values skipped) → `cli/banner.ts` `printBanner()` (gradient logo + version to stderr) → `cli/select-model.ts` `selectModel()` (interactive model picker — shown **only** when no `--model` flag was given and the terminal is interactive; non-interactive runs and an explicit `--model` both skip it; the choice is never persisted, so the picker reappears every interactive launch) → resolve `effectiveModel = model ?? DEFAULT_AGENT_MODEL` and write the dim `model: <name>` line to stderr → `auth/preflight.ts` `authenticateAnthropic()` (Anthropic auth — API key check or OAuth login via lightweight SDK query; fails fast if non-interactive with no API key) → `session/verify.ts` `connectWithRetry()` orchestrates: `session/collect.ts` `collectCredentials()` (Kinetica credentials from env with saved-connection confirmation, or interactive prompt) → `session/resolve-url.ts` `resolveUrl()` (adds `https://` or `http://` if missing, probing the host) → `session/KineticaSession.ts` (closure-based session, 30s request timeout) → verify connectivity + extract Kinetica version (up to 3 retries; 401/403 triggers credential re-prompt via `repromptCredentials()`, up to 2 cycles) → on success, `offerSaveCredentials()` writes URL/user to `.env` if any field was interactively prompted → `agent/run-agent.ts` (agent loop with version + model override)

**Degraded mode fallback:** After 3 failed attempts to reach port 9191, `connectWithRetry()` probes the host manager on port 9300 via `probeHostManager()`. If 9300 responds, the agent starts in degraded mode (`degraded: true`) — schema discovery is skipped, the system prompt includes a DEGRADED MODE section guiding the agent to use only `kinetica_host_manager_status`, and the welcome message warns the operator. Version is extracted from the HM response. If both 9191 and 9300 are unreachable, exits with code 1.

### Authentication (`auth/`)

Two Anthropic authentication methods: API key (via `ANTHROPIC_API_KEY` env var) and OAuth login (browser-based, same flow as `claude login`). Authentication runs **before** Kinetica credential collection — fail fast if no plausible auth path.

- **`preflight.ts`**: `authenticateAnthropic()` determines the auth method early in `main()`. API key path returns immediately. OAuth path creates a lightweight SDK query (never iterated — no API tokens consumed), probes for cached credentials via `accountInfo()` (reuses tokens from previous sessions), and only runs the full browser-based OAuth handshake if no cached credentials are found. Non-interactive terminals with no API key throw immediately with a clear error. The `--login` flag bypasses the cache probe and always triggers fresh OAuth.
- **`oauth-flow.ts`**: `resolveAuthentication()` drives the 3-step OAuth handshake via undeclared SDK methods (`claudeAuthenticate`, `claudeOAuthWaitForCompletion`). The `OAuthCapableQuery` interface type-asserts these runtime methods. Called by `preflight.ts` only when the cache probe fails. Graceful degradation on error — warns to stderr, returns result so the SDK can retry.
- **`open-browser.ts`**: Cross-platform browser opener (`open` on macOS, `xdg-open` on Linux, `cmd /c start` on Windows). Detached child process, never throws.
- **`logout.ts`**: `logout()` clears cached OAuth credentials by delegating to `claude auth logout`. Returns a `LogoutResult` with success/message. Never throws.

### Session Management (`session/`)

- **`env-file.ts`**: `.env` file loading and saving. `loadEnvFile()` synchronously reads `.env` at startup, populates `process.env` for keys not already set (shell vars always win), skips empty values so interactive prompts still trigger. `offerSaveCredentials()` offers to write `KINETICA_URL` and `KINETICA_USER` to `.env` after a successful interactive connection — password is never saved. Updates existing `.env` in-place (preserving comments and other vars) or creates from template. Pure helpers: `parseEnvContent()` (parses `.env` content to `ReadonlyMap`) and `buildEnvContent()` (generates/updates `.env` content). Never throws.
- **`resolve-url.ts`**: URL protocol resolution. `resolveUrl()` normalizes bare hostnames (e.g., `host1:9191`) by probing HTTPS first (3s timeout). If HTTPS fails and HTTP succeeds, the user is shown a red warning that credentials would travel in cleartext and asked to confirm interactively; declining returns `ok: false`. Non-interactive terminals refuse the fallback unconditionally. Setting `KINETICA_HTTPS_ONLY=1` refuses any fallback without prompting. Returns a discriminated union `ResolveUrlResult` (`ok: true` with resolved URL, or `ok: false` with error). Rejects unsupported schemes (ftp, ws). `hasProtocol()` is a pure helper for checking `http://`/`https://` prefix. Called by `connectWithRetry()` before creating the session.
- **`collect.ts`**: Credential collection. `collectCredentials()` returns `CollectResult` (`{ credentials, prompted }`) — the `prompted` set tracks which fields were interactively entered (`"url"` | `"user"`), used downstream to decide whether to offer `.env` save. When both URL and user are available from env and the terminal is interactive, displays the saved connection and asks "Use saved connection?" (defaults to yes); declining re-prompts for all fields. `repromptCredentials()` always prompts for user + pass (ignores env), used on 401/403 auth failure.
- **`verify.ts`**: `connectWithRetry()` orchestrates the full connection flow. On credential errors (401/403), detected by `isCredentialError()`, offers to re-prompt instead of blind retry — new credentials get a fresh retry counter. Limited to `MAX_REPROMPTS` (2) cycles. After successful connection (normal or degraded), calls `offerSaveCredentials()` if any field was interactively prompted or re-prompted.

### Agent Loop (`agent/run-agent.ts`)

Creates an in-process MCP server via `createSdkMcpServer()` with all 22 tools, then streams a `query()` call. Uses `makeInteractivePrompt()` — an async generator that yields user messages between agent turns, synchronized by a `TurnGate` (`agent/turn-gate.ts` — promise-based gate that prevents the prompt from appearing before the agent finishes its turn).

**Exports for eval reuse:** `MCP_SERVER_NAME`, `ALLOWED_TOOL_NAMES` (the shared tool allow-list), and `makeUserMessage()` (the `SDKUserMessage` envelope helper) are exported from this module so `src/evals/report-format.eval.ts` can reuse them verbatim — the eval's allow-list and prompt-envelope construction can never drift from prod.

Agent configuration:

- **Model**: defaults to `"sonnet"` (SDK resolves shorthand to latest version); operator can override via `--model=<sonnet|haiku|opus>` on the CLI, or — when no flag is given and the terminal is interactive — via the startup model picker (`cli/select-model.ts`, an `@inquirer/prompts` `select` defaulting to `sonnet`). Valid values come from `SUPPORTED_MODELS` in `agent/run-agent.ts` — both the CLI flag validator and the picker render from that tuple, so neither can drift. `MODEL_LABELS` in `select-model.ts` is typed `Record<AgentModel, string>`, so adding a model without a picker label is a typecheck error.
- **Fallback model**: `"haiku"` — automatic failover if primary model is unavailable
- **Thinking**: `{ type: "adaptive" }` — SDK decides when to use extended thinking
- **Allowed tools**: explicit list of 16 diagnostic + save_report + alter_table_columns tools (no wildcards — mutation tools intentionally excluded so they fall through to `canUseTool` callback for approval; alter_table_columns is allowed because it implements its own checklist + SQL preview approval)
- **Disallowed tools**: `Bash`, `Edit`, `Write`, `MultiEdit` — agent cannot modify files or run shell commands
- **`canUseTool` callback**: wires `createApprovalGate()` — mutation tools not in the allow-list trigger interactive y/n/explain approval prompt
- **Budget**: configurable per-session cap, resolved `--max-budget` flag > `ADMIN_AGENT_MAX_BUDGET` env > `DEFAULT_MAX_BUDGET_USD` ($5.00) via `resolveMaxBudgetUsd()`. **Billing-aware**: the dollar cap is passed to the SDK as `maxBudgetUsd` only under API-key billing (`dollarCapped`); OAuth/subscription (Pro/Max) sessions are turn-limited instead (no dollar figure). A running-cost tripwire warns once at 80% (`DEFAULT_WARN_FRACTION`) — see Session Budget Guard.
- **Max turns**: 100
- **Streaming**: `includePartialMessages: true` — text deltas stream to stderr in real-time
- **Session**: `persistSession: false` — no state between sessions
- **Client ID**: `env.CLAUDE_AGENT_SDK_CLIENT_APP = "admin-agent"` — identifies app in API headers

After `buildSystemPrompt()`, `runAgent()` runs `checkPromptBudget()` (see Prompt Budget Tripwire) to surface the assembled prompt's token cost.

The loop handles `SDKCompactBoundaryMessage` (logs pre-compaction token count), `SDKRateLimitEvent` (warns on throttling/rejection), `SDKSystemMessage` init (warns on MCP server connection failures), and `control_request` (logs mid-session re-authentication requests). Anthropic authentication is handled earlier by `auth/preflight.ts` in `main()`, before Kinetica credentials are collected. Session summary uses SDK-provided `duration_ms`, `duration_api_ms`, `total_cost_usd`, and `permission_denials`.

### Tool Architecture (`tools/`)

Each tool takes `KineticaSession` and returns `ToolResult<T>` — a discriminated union (`ok: true` with data, or `ok: false` with status/error/raw).

**Shared REST utility** (`tools/rest/parse-data-str.ts`): `parseDataStr<T>()` safely double-decodes Kinetica's `data_str` JSON responses. Returns a discriminated union (`ok: true` with parsed data, or `ok: false` with error details). Never throws. Used by most REST tool implementations.

**Type schema parser** (`tools/rest/parse-type-schema.ts`): `parseTypeSchema(schemaJson)` extracts column names and Kinetica-native types from the Avro-like `type_schemas` JSON returned by `/show/table` with `get_column_info`. Handles union types (`["type", "null"]`). Returns empty array on parse failure (never throws). Used by `show-table.ts`.

**Nested JSON decoder** (`tools/rest/decode-nested-json.ts`): `decodeNestedJsonStrings()` recursively decodes JSON-encoded string values in Kinetica responses. Handles triple-encoding (e.g., `statistics_map.ranks` → per-rank JSON strings → inner objects). Pure, never throws. Used by `metrics.ts` and `node.ts`.

**Rank stats flattener** (`tools/rest/flatten-rank-stats.ts`): `flattenRanksSummary()` and `flattenRankDetail()` convert decoded rank statistics into tabular rows. Safely handles missing `tier.stats` objects. Used by `metrics.ts` and `node.ts`.

**Host manager port discovery** (`tools/rest/discover-hm-port.ts`): `discoverHmPort(session)` reads `conf.hm_http_port` from system properties and falls back to `DEFAULT_HM_PORT` (9300). Never throws. Shared by `cluster.ts`, `host-manager.ts`, `show-configuration.ts`, and `alter-configuration.ts`.

**Shard summarizer** (`tools/rest/summarize-shards.ts`): `summarizeShards()` reduces the raw 16,384-entry shard array from `/admin/show/shards` into a compact per-rank distribution summary with a `balanced` flag. Without this, the shard map overwhelms the truncation budget. Used by `cluster.ts`.

**REST tools** (`tools/rest/`) — 14 tools calling Kinetica REST endpoints via `session.makeRequest()`:

| Tool                 | Endpoint                                   | Notes                                                                                           |
| -------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `health`             | `/show/system/status`                      | Full status_map with all health indicators                                                      |
| `metrics`            | `/show/resource/statistics`                | CPU/memory/GPU per rank, optional node_id filter                                                |
| `cluster`            | `/show/system/status`                      | Rebalance ops, shard map, alerts, jobs                                                          |
| `node`               | `/show/resource/statistics`                | Per-node resource details                                                                       |
| `logs`               | `/admin/show/logs`                         | Not available on all versions — use SQL fallback                                                |
| `show-configuration` | `/admin/show/configuration` (HM port 9300) | Full gpudb.conf via host manager                                                                |
| `system-properties`  | `/show/system/properties`                  | Runtime config with category/key filtering                                                      |
| `system-timing`      | `/show/system/timing`                      | Per-endpoint response times                                                                     |
| `resource-groups`    | `/show/resourcegroups`                     | Resource group config + tier usage per rank                                                     |
| `verify-db`          | `/admin/verifydb`                          | Always concurrent_safe mode, never exposes destructive options                                  |
| `security`           | `/show/security`                           | User/role/permission maps                                                                       |
| `show-table`         | `/show/table` + SQL                        | Table metadata, sizes, properties, column types, indexes (from `ki_catalog.ki_indexes` via SQL) |
| `resource-objects`   | `/show/resource/objects`                   | Tier placement data (RAM/DISK/PERSIST)                                                          |
| `host-manager`       | port 9300 `/`                              | Host manager cluster status (no auth required)                                                  |

**SQL tools** (`tools/sql/`) — 2 tools + 1 error enricher:

- `execute` — read-only guard via `isReadOnlySql`, on failure calls `enrichSqlError()` to replace raw errors with column-aware suggestions
- `explain` — wraps statement with EXPLAIN automatically
- `enrich-error` — enriches SQL errors with verified column names from discovered schemas

**Mutation tools** (`tools/mutation/`) — 4 tools requiring user approval before execution:

| Tool                      | Endpoint                                    | Notes                                                                      |
| ------------------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| `alter-system-properties` | `/alter/system/properties`                  | Runtime config changes with before/after verification                      |
| `execute-mutation-sql`    | `/execute/sql`                              | DDL/DML (CREATE INDEX, ALTER TABLE, etc.); rejects DROP/TRUNCATE/DELETE    |
| `admin-rebalance`         | `/admin/rebalance`                          | Shard rebalancing with aggressiveness cap; before/after shard distribution |
| `alter-configuration`     | `/admin/alter/configuration` (HM port 9300) | Replace full gpudb.conf with before/after verification                     |

Mutation tools are annotated `{ destructive: true, readOnly: false }` — not in the diagnostic allow-list, so they trigger the `canUseTool` approval gate. Each mutation logs an audit line to stderr (EXECUTED/FAILED + input summary) via `logMutationAudit()`.

**Batch column tool** (`tools/mutation/alter-table-columns.ts`): `kinetica_alter_table_columns` batches 2+ column type/property changes on a single table into one efficient ALTER TABLE statement. Added to `ALLOWED_TOOL_NAMES` (bypasses approval gate) because it implements its own two-step approval: interactive checkbox for column selection + SQL preview with y/n confirmation. Uses `showChecklist()` from `approval/checklist.ts` for the checkbox UI and `executeMutationSql()` for execution.

**Report tool** (`report/save-report.ts`): saves timestamped markdown (`kinetica-diag-YYYY-MM-DD-HHmmss.md`) to `reports/` with credential scrubbing. Supports `partial` flag for interrupted investigations.

The barrel `tools/index.ts` wraps each tool with the SDK's `tool()` helper and applies the output pipeline: `formatOutput()` → `truncateOutput()`. Exports `DIAGNOSTIC_TOOL_NAMES` (16-element `as const` tuple), `makeDiagnosticTools()` (16 MCP tool objects), `MUTATION_TOOL_NAMES` (4-element `as const` tuple), `makeMutationTools()` (4 MCP tool objects), `ALTER_TABLE_COLUMNS_TOOL_NAME`, and `makeAlterTableColumnsToolWithDeps()`. The save_report tool is created separately via `makeSaveReportTool()`.

### Types (`types/index.ts`)

Centralized type contracts: `Credentials`, `KineticaSession`, `ApprovalResponse`, `ToolAnnotation`, `TruncationOptions`, `ToolResult<T>` (discriminated union with `ToolSuccess<T>` / `ToolFailure`), `Playbook` (title, category, severity, keywords, body, filename), `Reference` (title, category, keywords, body, filename — no severity). All properties are `readonly`. Exports `DEFAULT_TRUNCATION` constant (head 150 + tail 50 lines). Additional types in their respective modules: `CollectResult` (credentials + prompted fields set) in `session/collect.ts`, `ResolveUrlResult` (discriminated union) in `session/resolve-url.ts`, `LogoutResult` in `auth/logout.ts`.

`KineticaSession` exposes `makeRequest(endpoint, body?)` for the default Kinetica port and an optional `makeRequestToPort(port, endpoint, body?)` for cross-port requests (e.g., host manager on 9300).

### Output Pipeline (`output/`)

Tool results flow through: raw data → `reshape.ts` (objects → row arrays) → `format.ts` (JSON → markdown tables/key-value pairs) → `truncate.ts` (head 150 + tail 50 lines). Agent text output goes through `streaming-table-aligner.ts` (line-buffered adapter that detects markdown table blocks in streamed deltas, reformats with aligned columns via `reformat-tables.ts`, and passes non-table content through immediately). `render-markdown.ts` handles terminal rendering of markdown content. `format-tool-name.ts` strips `mcp__<server>__kinetica_` prefixes for human-readable tool names in logs and audit output. `spinner.ts` provides a braille-dot terminal spinner (`createSpinner()` factory) that animates on stderr during agent thinking and tool execution gaps — auto-suppressed in non-interactive terminals and test environments.

### Schema Discovery (`agent/discover-schemas.ts`)

At startup, queries `ki_catalog.ki_columns` to discover actual column names for 18 system tables. Results feed into `diagnostic-sql.ts` builder functions that generate version-correct SQL examples for the system prompt. Falls back to hardcoded SQL when discovery fails (graceful degradation — never throws).

### Knowledge Playbooks (`knowledge/playbooks/`)

Expert diagnostic runbooks loaded at startup by `agent/load-playbooks.ts`. Each playbook is a Markdown file with YAML frontmatter (title, category, severity, keywords) and a body containing symptoms, detection steps, root cause, and remediation. Playbooks are injected into the system prompt to give the agent domain-specific troubleshooting knowledge.

Current playbooks: `memory-pressure`, `gpu-out-of-memory`, `query-contention`, `resource-group-exhaustion`, `stale-rank`, `config-drift`. The loader resolves the playbooks directory relative to package root (works in both dev/tsx and bundled/CJS), returns empty array on any error (graceful degradation).

### Knowledge References (`knowledge/references/`)

Domain knowledge documents loaded at startup by `agent/load-references.ts`. Each reference is a Markdown file with YAML frontmatter (title, category, keywords) and a body containing structured reference material. Unlike playbooks (which are diagnostic runbooks with severity), references are informational — they give the agent deep knowledge of Kinetica internals.

Current references (9): `gpudb-conf` (master config file, section index, admin parameters, tiered storage semantics), `tiered-objects` (`ki_tiered_objects` schema + diagnostic queries), `catalog-enums` (enum decoders for `ki_catalog` integer columns), `catalog-joins` (safe join paths between `ki_catalog` tables, oid compatibility, naming caveats), `rank-architecture` (rank 0 vs worker ranks, head-node profile, shard ownership), `mutation-safety` (pre-execution checklist for rebalance, alter-config, and DDL — injected into the system prompt by the reference loader, replacing the previously inline Mutation Safety Rules block), `sql-alter-table` (7.2 ALTER TABLE grammar, column property flags, shard-key immutability), `sql-create-index` (column index vs chunk skip index), `version-quirks-7.2` (endpoint/property differences between 7.2.x and earlier releases). The loader reuses `parseFrontmatter()`, `extractBody()`, and `findPackageRoot()` from `load-playbooks.ts`.

### Evals (`src/evals/`)

Model-output eval harness, deliberately separate from unit tests. Runs the full agent loop (real Anthropic API) against a mocked `KineticaSession` and asserts the model's generated report conforms to `knowledge/templates/report.md`.

- **`mock-session.ts`** — `createMockSession()` returns a `KineticaSession` backed by canned `Response` objects. DB-engine endpoints use the double-encoded `data_str` envelope (port 9191); host-manager endpoints return plain JSON (port 9300). Unknown endpoints return empty success so the agent doesn't crash on unmocked probes. The `/admin/show/shards` response uses the real `{shard_array_version, shard_map}` schema consumed by `summarizeShards()` — not the raw 16k array.
- **`capturing-save-report.ts`** — Drop-in replacement for `makeSaveReportTool()` that captures report content in memory instead of writing to disk.
- **`report-assertions.ts`** — Pure validators for the report markdown: top-level heading, required sections in canonical order, metadata labels. Tested in `report-assertions.test.ts`.
- **`report-format.eval.ts`** — Entry point. Reuses `MCP_SERVER_NAME`, `ALLOWED_TOOL_NAMES`, and `makeUserMessage` exported from `agent/run-agent.ts` so the eval can't drift from prod config. Exit codes: `0` pass, `1` assertion failed, `2` harness failure.

**Important conventions:** Eval files use the `*.eval.ts` suffix so vitest's `src/**/*.test.ts` glob skips them. `npm test` never runs evals; use `npm run eval`. See `src/evals/README.md` for the design rationale and how to add scenarios.

### System Prompt (`agent/system-prompt.ts`)

Pure function `buildSystemPrompt()` constructs the agent's instructions including: 5-round investigation protocol (3 diagnostic rounds + Round 4 mutation proposal + Round 5 post-mutation verification), diagnostic tool descriptions, Kinetica domain knowledge (system tables, failure patterns), loaded playbooks, loaded references (including `mutation-safety`, which supplies the Mutation Safety Rules block that used to live inline), analysis rules (named hypotheses, evidence-tied conclusions), and a report template placed at the end (recency bias).

The prompt composes three extracted sources, each owned by a separate module so the builder does not grow with tool count:

- `src/tools/catalog.ts` — `TOOL_CATALOG: Record<ToolName, CatalogEntry>` plus `buildEvidenceChecklist()` which renders the prompt's Evidence Checklist table. Because the catalog is typed as a full record over `DIAGNOSTIC_TOOL_NAMES ∪ MUTATION_TOOL_NAMES`, **adding a tool to either tuple without a corresponding catalog entry is a typecheck error** — new tools cannot ship invisible to the agent.
- `src/agent/report-template.ts` — loads `knowledge/templates/report.md` at import time and exports it as a string. `console.warn` surfaces load failures rather than silently shipping an empty template. Keeps `buildSystemPrompt()` pure.
- `knowledge/templates/report.md` — the diagnostic report Markdown skeleton injected at the end of the system prompt. Edit this file to reshape the report format; no code change needed.

### Prompt Budget Tripwire (`agent/prompt-budget.ts`)

The entire knowledge corpus (all playbooks + all references + SQL examples + tool catalog) is front-loaded into a single system prompt at startup, so its cost grows linearly with the corpus. This module makes that cost _visible_ before it gets expensive. Pure, dependency-free, never throws:

- `estimateTokens(text)` — `chars / 4` heuristic, rounded up (a tripwire needs to be _present_, not _precise_; swap for a real tokenizer behind the same signature if exact counts ever matter)
- `checkPromptBudget(prompt, opts?)` — returns an immutable `BudgetReport` (`tokens`, `chars`, `threshold`, `overBudget`); comparison is strictly-greater, so a prompt exactly at the threshold is not flagged
- `DEFAULT_PROMPT_BUDGET_TOKENS = 20_000` — warn threshold (a tripwire, not a hard limit; raised from 15_000 on 2026-06-03 since the cached system prompt makes corpus token cost near-zero)

Wired into `runAgent()` immediately after `buildSystemPrompt()`: a `DEBUG`-gated size line plus an **unconditional** over-budget warning to stderr cueing keyword-based playbook selection. Measured baseline (2026-05-31): the assembled prompt is **~13,422 tokens** with 6 playbooks + 9 references — ~33% under the 20,000 threshold. Note the system prompt is **cached** by the Agent SDK (built once at startup, re-read on every turn), so corpus token cost is near-zero in practice — `runAgent()` emits a `DEBUG`-gated cache-token line in the session summary (`cacheReadTokens > 0` confirms reuse).

### Session Budget Guard (`agent/session-budget.ts`)

Caps per-session spend. The SDK's `maxBudgetUsd` is the source of truth for the hard cutoff, but it only reports the true dollar figure on the _final_ result message — so this module estimates running cost from per-turn token `usage` to warn the operator _before_ the cap fires. Like `prompt-budget.ts`, it's a tripwire, not an accountant. Pure functions + closure-based factory; never throws (bad token counts degrade to 0).

- `resolveMaxBudgetUsd(flag?, env?)` — resolves the cap: `--max-budget` flag > `ADMIN_AGENT_MAX_BUDGET` env > `DEFAULT_MAX_BUDGET_USD` ($5.00). Invalid values (≤ 0, non-finite, non-numeric) are ignored so a bad env var degrades to the default.
- `createBudgetTracker({ maxUsd, warnFraction? })` — accumulates estimated spend; `shouldWarn()` fires once when spend strictly exceeds `warnFraction * maxUsd` (default `DEFAULT_WARN_FRACTION` = 0.8), `markWarned()` makes it one-shot.
- `estimateTurnCostUsd()` + `MODEL_PRICING` — price one turn's usage from a per-model, per-MTok table (estimate only).
- `fromSdkUsage()` — normalizes the SDK's snake_case `usage` shape into `TokenUsage`.

Wired into `runAgent()`: the budget is resolved in `cli/index.ts` and threaded through `RunAgentOptions.maxBudgetUsd`. A startup line shows the guard (`Budget guard: $X.XX (raise with --max-budget)` for API-key billing, or `subscription (Pro/Max) — turn-limited` for OAuth). On hitting the cap the session ends with `error_max_budget_usd` framed as a safety limit, not a crash.

### Credential Security

- `KineticaSession.ts`: credentials captured in closure, unreachable from outside; 30s request timeout (`REQUEST_TIMEOUT_MS`) via `AbortSignal.timeout()`
- `session/env-file.ts`: `.env` save offer writes only `KINETICA_URL` and `KINETICA_USER` — password is never persisted to disk
- `report/scrub.ts`: defense-in-depth scrubbing of URLs, auth headers, passwords from saved reports
- `tools/audit-redact.ts`: redacts mutation-tool inputs in the stderr audit log. Pattern-based stripping for inline SQL credentials (`PASSWORD '...'`, `IDENTIFIED BY '...'`) plus sha256 fingerprinting for known-sensitive keys and any string >300 chars. Prevents `config_string` payloads (full gpudb.conf with license keys, LDAP binds, TLS material) from leaking to logs.
- `approval/gate.ts`: three-response approval protocol (y/n/explain) wired as `canUseTool` callback — triggers for mutation tools not in the diagnostic allow-list
- `approval/registry.ts`: per-tool approval policy registry; diagnostic tools registered read-only, mutation tools default-deny
- `approval/display.ts`: terminal formatting for approval prompts

## Key Patterns

- **Immutable data**: `readonly` on all type fields, `ReadonlyMap`, frozen objects (`TurnGate`), reduce-based construction
- **Discriminated unions**: `ToolResult<T>` narrows on `ok` field; `ResolveUrlResult` narrows on `ok`; `ApprovalResponse` is `"allow" | "deny" | "explain"`
- **Factory functions over classes**: `createSession()`, `createRegistry()`, `createTurnGate()`, `createApprovalGate()`
- **Graceful degradation**: `discoverCatalogSchemas()` returns `undefined` on any error; `diagnostic-sql.ts` builders have `fallback` constants
- **Co-located tests**: every `.ts` has a sibling `.test.ts` in the same directory
- **`BUILDER_REGISTRY`**: data-driven registry in `diagnostic-sql.ts` mapping 18 system tables to SQL builder functions + fallbacks + prompt section headings

## Kinetica API Quirks

- `/execute/sql` returns double-encoded JSON: outer `data_str` contains `json_encoded_response` as a string that must be parsed again — the SQL `executeSql()` handles this; REST tools use `parseDataStr()` from `tools/rest/parse-data-str.ts`
- Column names come from `column_headers` array, not from the JSON keys (which are `column_1`, `column_2`, etc.)
- `ki_catalog.ki_columns` uses `column_type_oid` (not `data_type`), `is_dict_encoded` (not `dict_encoding`), `bytes_on_disk_compressed`/`bytes_on_disk_uncompressed` (not `compression_type`)
- REST endpoints also return double-encoded `data_str` — always use `parseDataStr<T>()` rather than raw `JSON.parse()` to handle edge cases safely
- Shard key columns cannot be altered in-place — once designated at table creation, the shard key column definition is immutable (Kinetica 7.2 limitation)
- `ki_catalog.ki_tables` and `ki_catalog.ki_version` do NOT exist in Kinetica 7.2.x — use `ki_objects` and `/show/system/status` respectively
- `/admin/show/logs` is not implemented in 7.2.x — returns 404 "Unknown URI"
- `/admin/show/configuration` and `/admin/alter/configuration` are host manager endpoints (port 9300) — use `makeRequestToPort()` with `data_str` double-encoding; response contains `config_string` (full gpudb.conf)
- `sm_omp_threads` and `kernel_omp_threads` properties do NOT exist in 7.2.x — use `worker_endpoint_threads`, `subtask_concurrency_limit`, `tcs_per_tom` instead. `execution_mode` IS a valid runtime-alterable property (values: `host` | `device` | `default` | `<rows>`) — see `knowledge/references/gpudb-conf.md`
- `/show/table` with empty `table_name` returns schema-level collections (not individual tables) with empty `sizes` array — use `ki_catalog.ki_objects` for table listing
- `/show/table` requires `<schema>.<table>` format — three-part names (e.g., `ki_home.ki_catalog.ki_objects`) return 400 error
- `/admin/rebalance` returns "Database must be offline" on single-worker-rank clusters — rebalance requires 2+ worker ranks
- `/admin/verifydb` returns `orphaned_tables_total_size: -1` on healthy systems (not 0) — -1 means "not checked"
- `/show/resource/objects` rank JSON structure is `{"objects": [...]}` — array nested under `objects` key, each with `locked` field (boolean)
- `/show/resourcegroups` default groups: `kinetica_system_resource_group` (priority 100), `kinetica_default_resource_group` (priority 50); includes `max_tier_priority` field
- Rank 0 is the head/coordinator node with minimal resources and no data tiers; worker ranks (1+) hold all data
- Host manager root endpoint (`/` on port 9300) returns plain JSON (no `data_str` encoding, no authentication required) — do NOT use `parseDataStr()`
- `ki_tiered_objects.id` is a string identifier (e.g., `@nyctaxi@365[col][0]`), NOT a numeric OID — cannot be joined with `ki_objects.oid`. For per-table tier placement, use `kinetica_resource_objects` with `table_names` filter
- `ANALYZE TABLE` is NOT supported by Kinetica — `/execute/sql` returns a syntax error. Kinetica does not maintain cost-based optimizer statistics the way PostgreSQL or Oracle do; query planning uses shard/column metadata already tracked by the storage layer. Do not suggest `ANALYZE TABLE` as a remediation or propose it via `kinetica_execute_mutation_sql` — there is no equivalent "refresh table stats" command to substitute.
