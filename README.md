# Kinetica Admin Agent

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)

AI-powered diagnostic agent for [Kinetica](https://www.kinetica.com/) GPU databases. Connects to a live instance — or analyzes an extracted offline support bundle, or both at once — autonomously investigates issues across 31 tools, and produces structured markdown reports with evidence-backed findings and actionable remediation.

Built with the [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-and-tools/claude-agent-sdk).

## Table of Contents

- [🚀 Quick Start](#quick-start)
- [🔍 How It Works](#how-it-works)
  - [📄 Example Report Output](#example-report-output)
- [📋 Prerequisites](#prerequisites)
- [⚙️ Configuration](#configuration)
  - [📈 Observability (Prometheus / Loki)](#observability-prometheus--loki)
  - [🔑 Authentication](#authentication)
  - [💰 Session Budget](#session-budget)
  - [⚠️ Degraded Mode](#degraded-mode)
  - [📦 Offline Bundle Mode](#offline-bundle-mode)
- [🖥️ CLI Flags](#cli-flags)
- [🧰 Tools](#tools)
  - [💓 System Health & Monitoring](#system-health--monitoring)
  - [📊 Resource & Performance](#resource--performance)
  - [📝 Configuration & Logs](#configuration--logs)
  - [🛡️ Data & Security](#data--security)
  - [🗃️ SQL Execution (read-only)](#sql-execution-read-only)
  - [✏️ Administrative Mutations (require approval)](#administrative-mutations-require-approval)
  - [🔀 Batch Column Alter (self-approving)](#batch-column-alter-self-approving)
  - [📈 Observability (read-only)](#observability-read-only-when-a-stats-stack-is-reachable)
  - [📦 Offline Bundle Analysis (read-only)](#offline-bundle-analysis-read-only)
  - [📑 Reporting](#reporting)
- [🔒 Security](#security)
- [📚 Contributing Diagnostic Knowledge](#contributing-diagnostic-knowledge)
  - [📖 Adding a Playbook](#adding-a-playbook)
  - [📘 Adding a Reference](#adding-a-reference)
  - [🧠 Current Knowledge](#current-knowledge)
- [🛠️ Development](#development)
  - [💻 Commands](#commands)
  - [🧪 Evals](#evals)
  - [📂 Project Structure](#project-structure)
  - [🏗️ Architecture](#architecture)
- [🤝 Contributing](#contributing)
- [🌐 Global Install](#global-install)
- [🔧 Troubleshooting](#troubleshooting)
- [📜 License](#license)

**Key capabilities:**

- Autonomous multi-round investigation with parallel tool calls
- 16 read-only diagnostic tools + 4 mutation tools with interactive approval + 2 self-managing tools (reporting, batch-column alter) = **22 live tools**, plus 6 offline bundle-analysis tools and 4 Prometheus/Loki observability tools = **32 total**
- **Offline support-bundle analysis** — diagnose from an extracted `gpudb_sysinfo` bundle (per-rank logs, `gpudb.conf`, host diagnostics) with no live connection, or attach a bundle alongside a live session to cross-check captured history against current state — even bundles that don't match the standard layout, via file-name and content inference
- Expert knowledge via pluggable playbooks and references, disclosed progressively — the agent reads what the investigation needs (no code required to add new ones)
- Schema-aware SQL — discovers actual column names at startup, never guesses
- HTTPS-first URL resolution with explicit consent required before any HTTP fallback
- Credential masking at every boundary — config secrets masked before leaving the tool (live and bundle), inline credentials masked in logs and process args, saved reports scrubbed
- Degraded mode — useful diagnostics even when the DB engine is down

## Quick Start

Run the latest published release straight from npm — no clone, no build:

```bash
npx @kinetica/admin-agent
```

Or install it globally and run the `admin-agent` command anywhere:

```bash
npm install -g @kinetica/admin-agent
admin-agent
```

To run the latest unreleased code from the default branch instead, point `npx` at GitHub:

```bash
npx github:kineticadb/admin-agent
```

The agent loads connection details from `.env` if present, or prompts interactively. On repeat runs, it confirms the saved connection before proceeding.

> To run locally from source instead, see [Development](#development).

## How It Works

The agent follows a structured **5-round investigation protocol**:

```
Round 1 — Initial Sweep
  Health check, metrics, logs, host manager status (parallel)

Round 2 — Targeted Deep Dive
  Follow anomalies from Round 1 (SQL queries, config checks, table details)

Round 3 — Correlation & Root Cause
  Cross-reference evidence, test hypotheses, fill gaps

Round 4 — Remediation (requires approval)
  Apply fixes: config changes, CREATE INDEX, ALTER TABLE, rebalance

Round 5 — Verification
  Confirm mutations took effect, document before/after state
```

Each round uses multiple tools in parallel where possible. The agent names specific hypotheses, ties every conclusion to evidence, and never gives vague or generic advice.

In [offline bundle mode](#offline-bundle-mode) (no live connection) the protocol shortens to read-only **diagnose → report**: the agent has no DB engine to mutate against or re-query, so Rounds 4–5 (remediation and verification) are dropped. When a bundle is attached _alongside_ a live connection, the full 5-round protocol applies and the agent can correlate the bundle's frozen evidence (what happened) against current live state (what's true now).

### Example Report Output

After investigation, the agent produces a structured markdown report saved to `reports/`:

```
reports/kinetica-diag-2026-03-26-040414.md
```

<details>
<summary>Example report excerpt</summary>

```markdown
# Kinetica Diagnostic Report

| Field                             | Value                   |
| --------------------------------- | ----------------------- |
| **Investigation Date/Time (UTC)** | 2026-03-26 00:00:00 UTC |
| **Kinetica Version**              | 7.2.3.11.20260322135954 |
| **Tool Calls**                    | 11                      |
| **Rounds**                        | 5                       |

## Summary

`ki_home.taxi_data_historical` (478,843 rows, 52.97 MB) had no DICT encoding
on any of its 19 columns and no indexes. Five low-cardinality columns were
wasting ~28.7 MB as raw storage. Both issues have been remediated.

## Remediation

1. **DICT encoding applied** to 5 columns in a single batch ALTER TABLE
2. **Column index created** on `pickup_datetime`
3. **Manual review recommended** for `cab_type` (cardinality=1)

## Root Cause Analysis

Root cause: the table was created without column properties, so five
low-cardinality string columns were stored raw. Not a fault — a default. The
5 columns account for 28.7 MB of the table's 52.97 MB uncompressed footprint
(`ki_columns`), and DICT encoding is the direct remedy.

## Evidence Collected

| Finding                  | Source                | Detail                                 |
| ------------------------ | --------------------- | -------------------------------------- |
| 0 DICT-encoded columns   | `kinetica_show_table` | All 19 columns showed no properties    |
| store_and_fwd_flag waste | `ki_columns`          | 15.8 MB on disk, cardinality=5, char32 |
| Combined DICT savings    | `ki_columns`          | 5 columns = 28.7 MB uncompressed       |

## Timeline

None — this was a storage-configuration finding with no time-ordered events to
establish. (The section is mandatory; when there is a chronology, every row
names its source and the stamp exactly as observed, on one UTC axis.)

## Evidence Gaps

None. All 11 tool calls returned complete data.

## Mutations Applied

| Tool                            | Parameters                      | Approval | Verified  |
| ------------------------------- | ------------------------------- | -------- | --------- |
| `kinetica_alter_table_columns`  | DICT on 5 columns               | APPROVED | confirmed |
| `kinetica_execute_mutation_sql` | CREATE INDEX on pickup_datetime | APPROVED | confirmed |

## Post-Remediation Verification

Re-read after both mutations: 5 of 19 columns now report DICT, and
`ki_catalog.ki_indexes` shows the `pickup_datetime` column index present.
Uncompressed footprint fell from 52.97 MB to 24.3 MB.
```

</details>

## Prerequisites

- **Node.js 20+**
- **Kinetica 7.2.x or later** — network-accessible URL (default port 9191); _not required for offline [`--bundle`](#offline-bundle-mode) analysis_
- **Anthropic API key** or **OAuth login** (Claude Pro/Max or Console account)

## Configuration

Set environment variables or use a `.env` file. The agent loads `.env` automatically at startup (shell-set variables always take precedence). Any missing values are prompted interactively.

| Variable                 | Description                                                                                      | Required                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `ANTHROPIC_API_KEY`      | Anthropic API key for Claude                                                                     | No — OAuth login used if unset                  |
| `ADMIN_AGENT_MAX_BUDGET` | Per-session budget cap in USD for API-key billing (overridden by `--max-budget`; default `5.00`) | No                                              |
| `KINETICA_URL`           | Kinetica instance URL (e.g. `http://host:9191` or bare `host:9191`)                              | Prompted if unset                               |
| `KINETICA_USER`          | Kinetica username                                                                                | Prompted if unset                               |
| `KINETICA_PASS`          | Kinetica password                                                                                | Prompted if unset (masked, never saved to .env) |
| `KINETICA_HTTPS_ONLY`    | Set to `1` to refuse plaintext HTTP fallback entirely — strict mode for production clusters      | No                                              |
| `KINETICA_STATS_HOST`    | Prometheus/Loki host, e.g. `http://statshost` — prompted after the password and saved here       | Prompted if unset                               |
| `DEBUG`                  | Set to `1` to log HTTP requests and the assembled system-prompt token size to stderr             | No                                              |

```bash
cp .env.example .env   # fill in values — or let the agent create it for you
```

On first interactive connection, the agent offers to save `KINETICA_URL` and `KINETICA_USER` to `.env` (password is never saved). On subsequent runs with saved values, the agent shows the saved connection and asks to confirm before proceeding.

If you enter a URL without a protocol (e.g., `host:9191`), the agent auto-detects by probing HTTPS first. If HTTPS fails and HTTP succeeds, the agent displays a red warning (credentials would travel in cleartext) and asks for explicit y/n confirmation before falling back. Set `KINETICA_HTTPS_ONLY=1` to refuse the fallback outright — recommended for production. In non-interactive environments (CI, piped input), the fallback is always refused; pass an explicit `http://` prefix if you really want HTTP. On authentication failure (401/403), the agent offers to re-enter credentials instead of retrying with the same values.

### Observability (Prometheus / Loki)

When the cluster runs Kinetica's stats stack, the agent gains four extra tools: `kinetica_prom_alerts` (every alert rule this site configured, with its expression — the site's own threshold for "too high" — plus what is firing right now), `kinetica_tier_snapshot` (per-rank storage utilization with an eviction verdict), `kinetica_prom_query` (arbitrary PromQL, including host CPU/memory/disk and per-process OOM scores), and `kinetica_loki_query` (Loki's two populations: the structured events the database pushes about itself, and the actual rank log lines).

**Events are telemetry, not logs.** The event stream carries per-statement SQL telemetry, request failures and rank status changes, but no log line, stack trace or component output. Rank log lines are a separate population that arrives only when the cluster runs promtail (`enable_promtail` in `gpudb.conf`, which does nothing until the stats stack is restarted). So "no error events" is not "the logs are clean", and the agent is instructed to read both. It never infers whether promtail is on: an empty logs result carries a verdict measured from Loki's own label set — shipping, absent, or could-not-verify — because an empty _filtered_ query says nothing about the capability.

Endpoints are discovered automatically from `gpudb.conf`'s `gaia.event_server_address`. **Discovery often needs help**, because a `kagent` install declares an _internal_ address for the stats host and the agent usually runs outside that network. Startup tells you which case you are in:

```
Observability: Prometheus, Loki
Observability: declared at http://10.x.x.x:9090 but unreachable from here — ... set KINETICA_STATS_HOST
Observability: none detected
```

**You are asked for this at startup**, right after the password, alongside the other connection details:

```
? Kinetica endpoint URL (e.g. http://dbhost:9191): http://dbhost:9191
? Admin username: admin
? Admin password: ********
? Prometheus/Loki host URL (e.g. http://statshost, blank if none): http://statshost
? Save KINETICA_URL, KINETICA_USER and KINETICA_STATS_HOST to .env? (Y/n)
```

Blank is a first-class answer — the session simply runs without metrics. The value is saved to `.env` with the rest of the connection, so you are asked once; confirming a saved connection on later runs asks nothing at all. A non-interactive run (CI, piped input) never prompts and uses `KINETICA_STATS_HOST` if set.

Enter a host or a URL (`statshost`, `http://statshost`, `https://statshost`). The scheme is honoured; any port is ignored, because the ports are per service — Prometheus at `:9090`, Loki at `gaia.event_server_port` (default `:9080`). If you leave it blank the agent still falls back to `gpudb.conf`'s `gaia.event_server_address`, which works when the agent runs on the cluster's own network. One host covers both services: Prometheus is derived at `:9090` and Loki at `gaia.event_server_port` (default `:9080`), which mirrors how `gpudb.conf` models them. Nothing else changes: without a stats stack the agent behaves exactly as before.

### Authentication

Anthropic authentication runs **before** Kinetica credential collection — the agent verifies it can reach the Claude API first, then asks for database credentials.

The agent supports two Anthropic authentication methods:

1. **API key** — set `ANTHROPIC_API_KEY` in environment or `.env` file. Get one at [console.anthropic.com](https://console.anthropic.com/).
2. **OAuth login** — if no API key is set, the agent opens a browser for Anthropic OAuth login (same flow as `claude login`). OAuth tokens are cached across sessions — subsequent runs reuse the cached credentials without reopening the browser. Use `--login` to force a fresh OAuth login, or `--logout` to clear cached credentials.

In non-interactive environments (CI, Docker without `-it`, piped input), an `ANTHROPIC_API_KEY` is required — OAuth needs a browser and will fail immediately with a clear error.

```bash
# API key (traditional)
ANTHROPIC_API_KEY=sk-... npm run dev

# OAuth login (opens browser on first run, reuses cached token after)
npm run dev

# Force OAuth login (ignore existing API key or cached token)
npm run dev -- --login

# OAuth with Console billing (instead of Claude Pro/Max)
npm run dev -- --login --login-method=console

# Log out (clear cached OAuth credentials)
npm run dev -- --logout
```

### Session Budget

Each session has a **budget guard** to prevent runaway spend. Its form depends on how you authenticate with Anthropic:

- **API-key billing** — the session enforces a dollar cap (default **$5.00**). Raise it with the `--max-budget=<USD>` flag or the `ADMIN_AGENT_MAX_BUDGET` environment variable (the flag wins when both are set). When estimated spend crosses ~80% of the cap, the agent warns on stderr and is instructed to save a partial report and wind down. If the cap is reached, the session ends with a message showing how to re-run with more headroom — and any report saved up to that point remains in `reports/`.
- **OAuth (Claude Pro/Max subscription)** — no dollar cap is imposed (you are not billed per token). The session is bounded by the **turn limit** (100 turns) instead.

The active guard is printed at startup, and the session summary reports per-investigation and total spend (API-key billing only). The dollar cap is enforced precisely by the Claude Agent SDK; the ~80% warning is an estimate from per-turn token usage, so it is approximate by design.

### Degraded Mode

If the DB engine on port 9191 is unreachable after 3 retries, the agent probes the host manager on port 9300. If it responds, the agent starts in **degraded mode** — only `kinetica_host_manager_status` provides useful data (version, license, per-rank process status). If both ports are unreachable, the agent exits with code 1.

### Offline Bundle Mode

When a cluster is down (or you're diagnosing after the fact), the live endpoints can't tell you what happened — but a `gpudb_sysinfo` **support bundle** can. It captures the evidence the live API never exposes: per-rank logs, the real on-disk `gpudb.conf`, and host-level diagnostics (memory, GPU, disk, process args). Point the agent at an **extracted** bundle directory to diagnose entirely offline:

```bash
admin-agent --bundle=/path/to/extracted-gpudb_sysinfo
```

The bundle must be **extracted first** — passing a `.tgz`/`.tar.gz` fails fast with an extract-first message. At startup the agent validates the directory, detects the Kinetica version, and prints an inventory (files by kind, ranks present); missing expected artifacts (e.g. no config, no core logs) are a non-fatal warning, mirroring degraded mode's "diagnose with what's present" philosophy.

A bundle and a live connection are **composable capabilities, not exclusive modes**:

- **Bundle only** (cluster unreachable) — the agent runs read-only and is bounded to 40 turns. Mutation tools are never even constructed, so offline analysis is read-only _by construction_.
- **Bundle + live** — when `--bundle` is given, the agent still attempts a best-effort, env-only live connection (no prompts, no exit). If the cluster answers, you get both tool sets and the agent correlates the bundle's frozen history against current live state. If not, it continues bundle-only.
- **Attach mid-session** — in any live session you can ask the agent to analyze a support bundle. It calls `kinetica_load_bundle` _without a path_, which opens an interactive directory picker for you to select the extracted bundle; the offline tools light up immediately. (If the agent instead proposes a specific path, you're asked to confirm it first — loading a directory lets the agent read files under it.)

**Every rank, however its logs were captured.** A bundle can carry per-rank logs in two forms: full rolling logs for the ranks on the collector's own host (`logs-local/`, including rotated history like `….log.1`), and centralized Loki/promtail exports for the entire cluster (`logs/rank0.log` … `rankN.log`, plus `hostmanager.log` and per-component tails). The agent reads both transparently — it identifies each rank from either source, prefers the richer rolling log when a rank has both, and falls back to the centralized export for ranks that live on other hosts. So on a multi-node cluster you can investigate **all** ranks (and the host manager), not just the ones local to where the bundle was collected. The centralized exports are JSON-wrapped on disk; the tools unwrap them automatically, so severity filters and timelines behave identically across both formats. `kinetica_bundle_list_files` reports the true rank count under `ranks_present` — trust it rather than guessing from `logs-local/`.

**Bundles that don't match the expected shape.** Not every bundle is a clean `gpudb_sysinfo` capture — a customer may hand over a flat logs-only dump, a differently-named collector's output, or a partial directory. The agent infers each file's type from its name, and for files whose names give nothing away it sniffs a bounded slice of their content against the same log/config/sysinfo parsers. So a rolling log shipped without the canonical `core-` prefix, or a host-manager `.out` capture, is still recognized, searchable, and rank-attributed rather than silently dropped. `kinetica_bundle_list_files` reports a `layout_match` verdict (`canonical` / `partial` / `unfamiliar`), a per-file confidence (`exact` / `inferred` / `weak`), and any files it couldn't place — and the operator gets a startup warning when a bundle is off-shape — so an inference is never passed off as certainty. Classification depends only on file names and contents, never on what the bundle directory itself is named.

Anthropic authentication still runs in bundle mode; only the interactive Kinetica credential collection is skipped (there may be no live DB to connect to). See [Offline Bundle Analysis](#offline-bundle-analysis-read-only) for the tools, and [CLAUDE.md](CLAUDE.md) for the parser/architecture details.

## CLI Flags

```bash
admin-agent --help                # Show usage
admin-agent --version             # Print version
admin-agent --verbose             # Enable debug logging (stack traces on error)
admin-agent --login               # Force OAuth login (even if API key is set)
admin-agent --login-method=TYPE   # Login method: claudeai (Pro/Max) or console
admin-agent --login-org=UUID      # Target organization UUID for OAuth
admin-agent --logout              # Log out from Anthropic account and exit
admin-agent --model=NAME          # Override agent model (sonnet | haiku | opus | fable); default: sonnet
admin-agent --max-budget=USD      # Per-session budget cap in USD (API-key billing only); default: 5.00
admin-agent --bundle=PATH         # Offline mode: diagnose from an extracted support-bundle directory
```

The `--model` flag swaps the primary model for a single session. `haiku` is cheaper and faster for simple triage; `opus` is slower and more expensive but produces deeper reasoning on complex investigations. The fallback model remains `haiku` regardless of the primary choice, so availability is unchanged. When you omit `--model` in an interactive terminal, the agent shows a startup picker (defaulting to `sonnet`); non-interactive runs use the default without prompting.

The `--max-budget` flag sets the per-session dollar cap for API-key billing (see [Session Budget](#session-budget)). It overrides `ADMIN_AGENT_MAX_BUDGET` and has no effect under OAuth subscription billing, which is turn-limited instead.

The `--bundle` flag points the agent at an **extracted** support-bundle directory for [offline analysis](#offline-bundle-mode) (pass the directory, not a `.tgz`). It composes with a live connection — the agent attempts a best-effort live connection at startup so it can cross-check bundle evidence against current state — and skips interactive Kinetica credential collection (Anthropic auth still runs).

## Tools

33 tools organized into categories: **22 live tools** (used when connected to a running instance), **6 offline bundle-analysis tools** (used against an extracted support bundle), **4 observability tools** (used when a Prometheus/Loki stats stack is reachable), and **`kinetica_knowledge_read`**, which serves the agent's own knowledge corpus on demand in every session. Diagnostic, SQL, and all bundle tools execute without approval — they are read-only. Mutation tools require explicit user confirmation via an interactive y/n/explain prompt. The batch column alter tool is self-approving via its own checklist + SQL preview flow. Before saving a report, the agent asks the operator (in conversation) whether to save and waits for a yes — so `save_report` only writes once you've agreed.

### System Health & Monitoring

| Tool                           | Description                                                             |
| ------------------------------ | ----------------------------------------------------------------------- |
| `kinetica_health_check`        | 11-component health status: system, ranks, hosts, HTTP server, HA, etc. |
| `kinetica_cluster_status`      | Rebalance progress, shard distribution, alerts, active async jobs       |
| `kinetica_verify_db`           | Database integrity: null checks, persistence issues, orphaned tables    |
| `kinetica_system_timing`       | Last ~100 API calls with endpoint name and response time (ms)           |
| `kinetica_host_manager_status` | Host manager cluster status, per-rank process info (no auth required)   |

### Resource & Performance

| Tool                        | Description                                                                     |
| --------------------------- | ------------------------------------------------------------------------------- |
| `kinetica_get_metrics`      | Per-rank storage tier summary: RAM/persist/disk/VRAM used and limits            |
| `kinetica_node_details`     | Detailed per-rank breakdown: per-tier limits/usage, per-resource-group threads  |
| `kinetica_resource_groups`  | Resource group definitions: memory limits, CPU concurrency, scheduling priority |
| `kinetica_resource_objects` | Per-rank object placement: sizes, tier, priority, eviction stats, lock status   |

### Configuration & Logs

| Tool                             | Description                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `kinetica_get_system_properties` | 306 config properties with optional category/key filtering (names are `conf.`-prefixed and dot-sectioned — filter by `conf.sql`, not `sql`) |
| `kinetica_show_configuration`    | Full `gpudb.conf` from host manager (port 9300)                                                                                             |
| `kinetica_get_logs`              | Application logs by source/severity/time range (_7.2.x: use SQL fallback_)                                                                  |

### Data & Security

| Tool                     | Description                                                         |
| ------------------------ | ------------------------------------------------------------------- |
| `kinetica_show_table`    | Column names, Kinetica-native types, per-column properties, indexes |
| `kinetica_show_security` | Users, roles, permissions, resource group assignments               |

### SQL Execution (read-only)

| Tool                     | Description                                                |
| ------------------------ | ---------------------------------------------------------- |
| `kinetica_execute_sql`   | SELECT/WITH queries against system catalog tables          |
| `kinetica_explain_query` | Execution plan: step IDs, internal endpoints, dependencies |

### Administrative Mutations (require approval)

| Tool                               | Description                                                                                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kinetica_alter_system_properties` | Config changes via `/alter/system/properties` — **edits `gpudb.conf` in place**, so it persists and may need a restart to take effect; returns a `verification` state |
| `kinetica_execute_mutation_sql`    | DDL/DML (CREATE INDEX, ALTER TABLE, etc.) — DROP/TRUNCATE/DELETE blocked                                                                                              |
| `kinetica_admin_rebalance`         | Shard rebalancing with aggressiveness cap and before/after capture                                                                                                    |
| `kinetica_alter_configuration`     | Replace `gpudb.conf` via the host manager — the **same file** the tool above writes, so don't use both in one investigation                                           |

### Batch Column Alter (self-approving)

| Tool                           | Description                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `kinetica_alter_table_columns` | Batch 2+ column changes into one ALTER TABLE. Two-step approval: interactive checklist then SQL preview |

### Observability (read-only, when a stats stack is reachable)

Available when Prometheus/Loki are reachable (see [Observability](#observability-prometheus--loki)). All read-only, unauthenticated HTTP GETs. Metrics are reduced to per-series statistics before reaching the agent — min and max carry the timestamps they occurred at, since when a peak happened is usually the finding.

| Tool                     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kinetica_prom_alerts`   | Every alerting rule this site configured, with its `expr` (the site's OWN threshold for "too high"), for-duration, severity and health, plus every firing or pending instance with the value that tripped it and its age. Zero rules is reported as the **absence of monitoring**, not health — Kinetica's own `alert_*` thresholds go straight to Alertmanager and are read via `kinetica_cluster_status`                                                                                                                                          |
| `kinetica_tier_snapshot` | Every rank+tier in one call: used vs limit, windowed peak and when, unevictable bytes, bytes remaining before eviction begins, cumulative evictions, and a verdict (ok / pressure / over high-watermark / uncapped)                                                                                                                                                                                                                                                                                                                                 |
| `kinetica_prom_query`    | Arbitrary PromQL, summarized. Includes host and process telemetry no other tool can reach — `ki_host_cpu` / `ki_host_mem` / `ki_host_disk` / `ki_host_numa` / `ki_host_swap`, and `ki_exe_mem{what="oom_score"}` per process                                                                                                                                                                                                                                                                                                                        |
| `kinetica_loki_query`    | Two populations, chosen with `stream`. `stream="events"` (default) is telemetry the database pushes about itself — `class="sql"` (per-statement jobid, user, resource group, elapsed, full statement text), `job` (request failures with attribution), `status` (rank transitions), `config`, `mode`. `stream="logs"` is the actual rank log lines, plus the SQL-engine, graph, tomcat and workbench logs no other live tool can reach. **Events are not logs** — an empty logs result reports a measured promtail verdict rather than an inference |

### Offline Bundle Analysis (read-only)

Available against an extracted `gpudb_sysinfo` support bundle (see [Offline Bundle Mode](#offline-bundle-mode)). All read-only; the search/timeline tools stream and bound their output so a large rank log (tens of MB, hundreds of thousands of lines) never blows up the context.

| Tool                           | Description                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kinetica_load_bundle`         | Attach an extracted bundle directory; without a path it opens a directory picker (a model-supplied path needs operator confirmation)                                                                                                                                                                                                     |
| `kinetica_bundle_list_files`   | Inventory: detected version, ranks + services present, file counts/sizes by kind, plus a layout-match verdict + per-file confidence for off-shape bundles — call this first                                                                                                                                                              |
| `kinetica_bundle_log_timeline` | Per-time-bucket severity counts across ranks (the incident shape) — call before searching                                                                                                                                                                                                                                                |
| `kinetica_bundle_search_logs`  | Bounded log search by regex, min-severity, time window, and rank / host-manager / component (reads both rolling and Loki-export logs); `include_multiline` stitches a multi-line record — e.g. a full `Executing SQL:` query whose embedded newlines span many lines — back onto each match; inline credentials in logged SQL are masked |
| `kinetica_bundle_read_config`  | Read the bundle's real on-disk `gpudb.conf`, with optional section/key filter — credential values are masked, key names kept                                                                                                                                                                                                             |
| `kinetica_bundle_read_sysinfo` | OS/process/version diagnostic files (memory, CPU, disk, GPU, network, process args) — credentials in process args and env dumps are masked                                                                                                                                                                                               |

### Reporting

| Tool          | Description                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `save_report` | Timestamped markdown report to `reports/` with credential scrubbing — agent asks before saving |

## Security

The agent is designed with defense-in-depth for database administration:

- **Credential isolation** — Kinetica credentials are captured in a closure and never exposed to the agent or logged
- **HTTPS enforcement** — URL resolution probes HTTPS first; any fallback to plaintext HTTP requires explicit interactive confirmation, is refused in non-interactive environments, and can be disabled entirely via `KINETICA_HTTPS_ONLY=1`
- **Read-only by default** — 16 read-only diagnostic tools (including SQL execute/explain) run without approval; the agent has no access to `Bash`, `Edit`, `Write`, or `MultiEdit` and cannot run arbitrary shell commands
- **Offline analysis is read-only by construction** — in bundle-only mode the mutation tools are never instantiated; the 6 bundle tools only read files, and every read is confined to the bundle root (path-escape attempts via `..` are rejected). Attaching a bundle the _model_ chose (an explicit `path` passed to `kinetica_load_bundle`) requires operator confirmation, since loading widens the readable directory — a path you pick from the interactive picker is already your consent
- **Mutation approval gate** — the 4 administrative mutation tools each trigger an interactive y/n/explain prompt before execution; DROP/TRUNCATE/DELETE/UPDATE SQL is always blocked (with CTE-bypass protection)
- **Two-step approval for batch column alter** — `kinetica_alter_table_columns` requires the operator to select columns via a checklist, then confirm the exact SQL preview
- **Audit trail** — every mutation logs a redacted audit line to stderr (EXECUTED/FAILED + fingerprinted input summary) and appears in the report's "Mutations Applied" table with before/after state
- **Config secrets masked at the source** — `gpudb.conf` carries license keys, LDAP binds, TLS material and cloud-storage credentials. Values of credential-bearing keys are masked before the config leaves the tool, on both the live path (`kinetica_show_configuration`) and the bundle path (`kinetica_bundle_read_config`), so they never enter the agent's context. Key names and non-secret values are preserved, so drift detection and policy checks (e.g. `min_password_length`) still work
- **Inline credential masking in bundle artifacts** — process args, environment dumps and credentials inside logged SQL (`IDENTIFIED BY`, `SET PASSWORD`) are masked in `kinetica_bundle_read_sysinfo` and `kinetica_bundle_search_logs`. Deliberately narrow: log lines and host diagnostics are the evidence these tools exist to surface, so a line that merely mentions a password is left intact
- **Report scrubbing** — saved reports are scrubbed of URLs, auth headers, Basic/Bearer credentials, cookies, passwords, API keys and cloud-storage credentials before writing to disk, in prose and table form as well as bare `key = value`
- **Confirmed report writes** — the agent asks the operator (in conversation) whether to save before composing the report, and writes only after a yes; the one exception is an automatic partial-report checkpoint when the budget guard is about to cut the session off, so findings are never lost
- **Budget guard** — a per-session dollar cap (default $5.00, configurable via `--max-budget` or `ADMIN_AGENT_MAX_BUDGET`) prevents runaway spend on API-key billing; OAuth subscription sessions are bounded by the turn limit instead

To report a security vulnerability, please see [SECURITY.md](SECURITY.md). Do not open a public GitHub issue for security issues.

## Contributing Diagnostic Knowledge

The agent's expert troubleshooting knowledge lives in `knowledge/` as Markdown files — no TypeScript required.

### Adding a Playbook

Playbooks are diagnostic runbooks in `knowledge/playbooks/`. Create a new `.md` file:

```markdown
---
title: Shard Imbalance
category: cluster
severity: warning
keywords: [shard, imbalance, skew, distribution]
---

## Symptoms

- Uneven query response times across ranks
- One rank consistently at higher CPU/memory than others

## Detection

- `kinetica_get_metrics` -> compare `ram_percent` across worker ranks
- `kinetica_cluster_status` -> check shard distribution

## Root Cause

Data skew from poor shard key choice or post-rebalance drift.

## Remediation

1. Check shard key distribution via `kinetica_execute_sql`
2. Use `kinetica_admin_rebalance` with aggressiveness 1-3
```

| Field      | Required | Description                                                |
| ---------- | -------- | ---------------------------------------------------------- |
| `title`    | Yes      | Pattern name shown in agent's diagnostic knowledge         |
| `category` | No       | Grouping (e.g., `performance`, `cluster`, `configuration`) |
| `severity` | No       | `critical`, `warning`, or `info` (default: `info`)         |
| `keywords` | No       | Search terms: `[term1, term2]`                             |

Playbooks are loaded automatically at startup — no build step needed.

A playbook reaches the agent as a **card**: its id, severity and `## Symptoms` bullets go into the system prompt, and the rest of the document (Detection, Root Cause, Remediation) arrives when the agent calls `kinetica_knowledge_read` because those symptoms matched. So write `## Symptoms` as the thing an operator would actually report — it is the retrieval trigger, not decoration. A `## Symptoms` section is required; `src/knowledge/corpus.test.ts` fails the build without one.

### Adding a Reference

References provide domain knowledge (not diagnostic runbooks). Create a `.md` file in `knowledge/references/` with the same frontmatter format but without `severity`, plus two **required** disclosure fields:

```markdown
---
title: Kinetica SQL Dialect — PostgreSQL Baseline & False Friends
category: sql-syntax
keywords: [sql-dialect, postgresql, false-friends]
summary: "PostgreSQL-baseline mental model plus the false-friends table: SQL that looks valid but FAILS in Kinetica (TRY_CAST, backticks, timestamp arithmetic, NUMERIC)."
read_when: "Before writing ANY SQL you hand to the operator or run as a mutation."
---
```

| Field        | Required        | Description                                                                                                                           |
| ------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `summary`    | Yes (on-demand) | ≤ 220 chars, one line. WHAT the document contains. This is the card's "covers" column.                                                |
| `read_when`  | Yes (on-demand) | ≤ 160 chars. An **unconditional** trigger anchored to an action or protocol phase — "Before …", "When … fails". Never "If you need…". |
| `disclosure` | No              | `inline` or `on-demand` (default). `inline` renders the full body into every prompt — reserve it for policy, see below.               |

Quote any value containing `: ` — it is invalid unquoted YAML, and Prettier will keep the quotes.

**Why `read_when` must be unconditional.** This repo has measured the failure: on a live cluster the agent skipped an entire evidence dimension because the prompt described it conditionally, which reads as permission to skip. A card that says "useful for SQL questions" is a card the agent will not act on; one that says "Before writing ANY SQL" hangs off a step it is already executing. Write triggers, not topics.

**When to use `disclosure: inline`.** Only for policy the agent must obey _without knowing to look it up_. Today only `mutation-safety.md` qualifies: an agent that has not read it does not know that it should. Everything else is a card. Flipping a document to `inline` is a one-line, reversible edit — that is the escape hatch if a document turns out to be skipped when it shouldn't be.

### Current Knowledge

All of these reach the agent as cards unless noted otherwise.

**Playbooks** (6): memory-pressure, gpu-out-of-memory, query-contention, resource-group-exhaustion, stale-rank, config-drift

**References** (11):

- `gpudb-conf` — master config file structure, section index, tiered storage semantics
- `tiered-objects` — `ki_tiered_objects` schema, ID format, diagnostic queries
- `catalog-enums` — enum value decoders for `ki_catalog` integer columns
- `catalog-joins` — safe join paths between `ki_catalog` tables (oid compatibility, naming caveats)
- `rank-architecture` — rank 0 vs worker ranks, head-node resource profile, shard ownership, and where queries are logged (rank 0 only — crash forensics)
- `mutation-safety` — pre-execution checklist for rebalance, alter-config, and DDL paths. **The one `disclosure: inline` document**: it is policy an agent that hasn't read it doesn't know to go and read
- `sql-alter-table` — Kinetica 7.2 ALTER TABLE grammar, column property flags, shard-key immutability
- `sql-create-index` — column index syntax, chunk skip index, when to use which
- `sql-dialect` — PostgreSQL-baseline mental model + a "false friends" table of cross-dialect SQL that looks valid but fails in Kinetica (e.g. `TRY_CAST`/`SAFE_CAST`, backtick quoting, `NUMERIC` vs `DECIMAL`); steers remediation SQL away from SQL Server/Snowflake/Oracle idioms
- `service-management` — the only sanctioned start/stop/restart commands: `systemctl` unit names (`gpudb`, `gpudb_host_manager`, `kinetica_stats`, `gpudb-mq`) as root, the `/opt/gpudb/core/bin/gpudb <component>-<directive>` script as the `gpudb` user, full-stack ordering, and a "never emit" table. Notably: `gadmin` is the web GUI, **not** a service-control CLI, and there is **no per-rank restart** — ranks are Host-Manager-supervised
- `version-quirks-7.2` — endpoint/property differences between 7.2.x and earlier releases

Plus a **bundle-scoped reference** (`support-bundle` — bundle layout, the two per-rank log families, raw + Loki-JSONL log-line formats, severity ordering, file parsing, crash-SQL forensics, and how to work an off-shape bundle via the `layout_match`/confidence signals) that lives in `knowledge/references/bundle/`. It loads in **every** session — even a pure live one — because the prompt is built once, before anyone knows whether a bundle will be attached. How it renders depends on the session: **in full** in bundle-only mode and once a bundle is attached (it is then the session's subject, and every bundle tool call depends on it), and as a **card** when no bundle is loaded. The deferred read is not lost — `kinetica_load_bundle`'s result note tells the agent to read it at the moment of attach.

> **Heads up — prompt budget:** documents are **not** front-loaded into the system prompt. Each contributes one ~60-90 token card, and its body reaches the agent only when `kinetica_knowledge_read` fetches it — so adding a reference costs the prompt a row, not a document. A startup tripwire (`agent/prompt-budget.ts`) prints the assembled prompt size under `DEBUG` and warns on stderr above ~18,000 estimated tokens. Current baselines: **~9.3k** for a live session, **~11.5k** with a stats stack, ~13.8k with a bundle attached as well, ~8.4k bundle-only (before progressive disclosure these were 22.7k / 24.9k / 24.8k / 19.6k). If you trip that warning, the cue is to check for documents marked `disclosure: inline` that could be on-demand, and for card summaries that have grown into paragraphs.

## Development

```bash
git clone https://github.com/kineticadb/admin-agent.git
cd admin-agent
npm install
cp .env.example .env   # optional — all values are prompted on first run (OAuth login opens in browser if no API key)
```

### Commands

| Command                    | Description                                      |
| -------------------------- | ------------------------------------------------ |
| `npm run dev`              | Run from source via tsx                          |
| `npm run dev -- --verbose` | Run with debug logging                           |
| `npm run build`            | Bundle with tsup -> `dist/admin-agent.js`        |
| `npm run typecheck`        | Type-check without emitting                      |
| `npm test`                 | Run all tests (vitest)                           |
| `npm run test:watch`       | Tests in watch mode                              |
| `npm run test:coverage`    | Coverage report (80% line threshold)             |
| `npm run eval`             | Run the report-format eval against the real API  |
| `npm run lint`             | Run ESLint (typescript-eslint, type-aware rules) |
| `npm run lint:fix`         | Run ESLint and auto-fix what it can              |
| `npm run format`           | Run Prettier to format all supported files       |
| `npm run format:check`     | Run Prettier in check-only mode (no writes)      |

Run a single test file:

```bash
npx vitest run src/agent/turn-gate.test.ts
```

### Evals

Unit tests in `src/**/*.test.ts` verify the inputs to the model (system prompt, template files, tool catalog). Evals under `src/evals/` verify the outputs — they run the full agent loop against a mocked Kinetica session and assert the model's generated report conforms to the template. Evals are deliberately **not** part of `npm test` (they hit the real Anthropic API, cost money, and are non-deterministic).

```bash
# Requires ANTHROPIC_API_KEY (or a prior OAuth login)
npm run eval
```

Exit codes: `0` pass, `1` assertion failed, `2` harness failure (e.g., missing API key). See [`src/evals/README.md`](src/evals/README.md) for the design rationale and how to add new evals.

### Project Structure

```
src/
  cli/          # Entry point, banner, arg parsing, bundle directory picker
  auth/         # Anthropic authentication — API key or browser OAuth
  agent/        # Agent loop, system prompts (live + bundle), schema discovery
  session/      # Kinetica connection, credentials, .env management, URL resolution
  bundle/       # Offline support-bundle parsers + BundleSource facade
  observability/ # Prometheus/Loki client and endpoint discovery
  tools/        # 32 MCP tools (rest/, sql/, mutation/, bundle/, observability/)
  output/       # Formatting, truncation, table alignment
  approval/     # Mutation approval gate and checklist UI
  report/       # Report generation and credential scrubbing
  evals/        # Model-output eval harness (separate from unit tests)
  types/        # Shared type contracts
knowledge/
  playbooks/    # Diagnostic runbooks (Markdown + YAML frontmatter)
  references/   # Domain knowledge documents (bundle/ subdir = offline-only refs)
docs/           # Architecture reference (open architecture.html in a browser)
reports/        # Generated diagnostic reports (git-ignored)
```

Tests are co-located: every `*.ts` source file has a sibling `*.test.ts` in the same directory.

CI (`.github/workflows/ci.yml`) runs type-check, test, and bundle build against Node 20.x and 22.x on every pull request and push to `main`. A separate `lint` job runs linting via ESLint + typescript-eslint (`npm run lint`) and formatting checks via Prettier (`npm run format:check`) once on Node 20.x — both gate every PR. Run them locally (or `npm run format` to auto-fix) before opening a PR.

### Architecture

Two complementary references:

- **[docs/architecture.html](docs/architecture.html)** — visual walkthrough. Four diagrams: the process boundary and its tool groups, the startup sequence and its live/bundle fork, the two nested loops a user prompt travels through (turn loop and tool loop, joined by the `TurnGate`), and the 5-round investigation protocol with its approval and save-consent pauses. Closes with a table mapping each guardrail to the file that enforces it. Open it in a browser — no build step.
- **[CLAUDE.md](CLAUDE.md)** — prose reference. Startup flow, tool internals, output pipeline, type contracts, and Kinetica API quirks.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development workflow, commit conventions, code style, and how to add new tools.

## Global Install

```bash
npm install -g @kinetica/admin-agent
admin-agent
```

## Troubleshooting

**Agent can't connect to Kinetica**

- Verify the URL is reachable: `curl http://host:9191/show/system/status`
- Check firewall rules for ports 9191 (DB engine) and 9300 (host manager)
- If only port 9300 responds, the agent will start in [degraded mode](#degraded-mode)

**"Unknown URI" errors from tools**

- Some endpoints (e.g., `/admin/show/logs`) don't exist in Kinetica 7.2.x — the agent falls back to SQL queries automatically

**`--bundle` won't start / "expects an extracted directory"**

- The bundle must be **extracted first**: `tar xzf gpudb_sysinfo*.tgz`, then pass the resulting directory to `--bundle`. Passing the archive itself fails fast by design.
- `--bundle=` with an empty value (e.g. an unset shell variable) is rejected — supply a real path.
- A missing-artifact warning (no config / no core logs) is non-fatal; the agent diagnoses with whatever is present, just as in degraded mode.

**Agent hits budget cap**

- Applies to API-key billing only (default $5.00 per session). Raise it for the next run with `--max-budget=10` or `export ADMIN_AGENT_MAX_BUDGET=10`. The agent warns at ~80% so it can save a partial report before the cap is reached. For complex multi-table investigations, consider running focused sessions per table. OAuth (Pro/Max) sessions are turn-limited rather than dollar-capped.

**Empty or missing report**

- Reports save to `reports/` in the working directory. If the session is interrupted, a partial report may be saved with a `(partial)` flag

**Agent refuses HTTP connection**

- If HTTPS probing fails and you want to allow HTTP, pass an explicit `http://` prefix in `KINETICA_URL` (not just a bare hostname)
- Production deployments should keep `KINETICA_HTTPS_ONLY=1` set to prevent any plaintext credential transmission

## License

[Apache-2.0](LICENSE)
