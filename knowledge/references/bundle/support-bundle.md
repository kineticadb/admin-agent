---
title: Support Bundle Layout & Parsing
category: bundle
keywords: [bundle, sysinfo, gpudb_sysinfo, logs, rank, gpudb.conf, host-diagnostics, offline, loki]
---

### Log line format

Core rank logs (`core-gpudb-rolling-r0.log`) look like:

```
2026-06-11 15:18:52.786 FATAL (55114,55114,r0/gpudb_cluster_i) node2 Job.cpp:9 - Segmentation fault, signal: 11
```

That is: `timestamp severity (pid,tid,rank/ctx) host source:line - message`. Severities seen: INFO, WARN, UERR (user error), ERROR, FATAL. Component logs (sql-engine, reveal, tomcat) use a similar prefix without the `source:line` field.

Severity order for filtering is `WARN < UERR < ERROR < FATAL`, so `min_severity=ERROR` EXCLUDES UERR (user-error) lines — use `WARN` or `UERR` to include them.

### How to read logs efficiently

- The logs are large (a rank log can exceed 100k lines). NEVER ask for a whole file. Use `kinetica_bundle_log_timeline` to localize, then `kinetica_bundle_search_logs` with a tight time window + severity to extract only relevant lines. The match cap is shared across files — if you see "capped", narrow the query rather than asking for more.
- You can pass a timeline bucket label straight into `from_ts`/`to_ts` (e.g. `2026-06-11 15` searches that whole hour) — partial timestamps are widened to cover the full period.
- A single log record can span multiple physical lines when a logged value (notably a SQL statement) contains embedded newlines — the continuation lines have no timestamp. A plain search returns only the first line. Pass `include_multiline: true` to stitch the continuation lines back onto each match and recover the whole record. See "Finding a crash's triggering SQL".
- Timestamps are plain local strings without a timezone; compare them lexically and treat cross-rank timing cautiously.
- **Ranks vs. the host manager:** `rank` selects a numeric rank (`r0`, `r1`, …) only. The host manager (`core-gpudb-rolling-hm.log`) is a singleton service, NOT a rank — search or timeline it with `host_manager: true`, never `rank: "hm"`. By default both `log_timeline` and `search_logs` already cover the host manager along with the numeric ranks; `kinetica_bundle_list_files` lists it under `services_present`.

### Finding a crash's triggering SQL

When a worker rank segfaults mid-query, that rank's log holds the **backtrace** but NOT the **SQL** — the query text and predicates are logged on **rank 0** (the coordinator), never on workers. Do not conclude the SQL is "only in `ki_query_history`" (a live table, unavailable offline) just because it is absent from the crashing rank.

Workflow, given a `JobId` from a worker's crash stack:

1. `kinetica_bundle_search_logs` with `rank: "r0"`, `regex` = the JobId, **and `include_multiline: true`**. r0 logs the `/execute/sql` receipt (submitting user), the `Sql/SqlDriver.cpp … Executing SQL:` line, and per-operation endpoint lines.
2. **Read the full statement straight from the `Executing SQL:` line — do not reconstruct it.** Kinetica logs the SQL verbatim, so a real query spans MANY physical lines: `FROM …`, `JOIN …`, `WHERE …` each land on their own line with no timestamp prefix. Those continuation lines belong to the same log record; `include_multiline: true` stitches them back onto the match so you see the WHOLE query. WITHOUT it, a match is only the first physical line (e.g. `… Executing SQL: SELECT c."circuitId", c."circuitRef"`) and you would wrongly report the query as "truncated." Quote the statement verbatim from this single (now multi-line) match.
3. **Cache-hit fallback only:** if `Found plan for the SQL in cache` precedes the job, Kinetica logs `Executing SQL:` as just the statement keyword (e.g. a bare `SELECT` or `EXECUTE PROCEDURE …`) with no continuation lines to stitch. ONLY then fall back to the per-operation endpoint lines (`Endpoint_aggregate_group_by.cpp`, filter/join endpoints): they carry `table:`, `column_names:`/`aliases:` (the SELECT list), and `expr:` (the full WHERE predicate), whose values survive a cache hit. A `datetime()`/timestamp filter showing up here often _is_ the input that triggered a parser segfault.

**Where the full multi-line query actually lives:** `include_multiline` recovers the whole statement only from the **rolling core logs** (`logs-local/core-gpudb-rolling-r0.log`), where the SQL's embedded newlines are preserved as continuation lines. The **Loki per-rank tail** (`logs/rank0.log`) keeps only the statement's first physical line — promtail captures each line as its own record, so the `FROM`/`JOIN`/`WHERE` lines are simply not in that export, and nothing can stitch them. So this workflow depends on r0 being present under `logs-local/`. If r0 exists only as a Loki tail (rare for the coordinator, but possible for a Loki-only bundle), the complete query may not be in the bundle at all — say so rather than reporting the first line as the whole query, and fall back to step 3's endpoint lines.

See `rank-architecture.md` (Where queries are logged) for why this locality holds, and "Two log families" below for rolling-vs-Loki precedence.

### Files of interest

`kinetica_bundle_list_files` annotates every file with a `description` of what it contains, so consult that first. The canonical OS-diagnostic / host files (each is `EXEC_CMD`-wrapped — read with `kinetica_bundle_read_sysinfo`):

- **Kinetica:** `gpudb.txt` (version/build, binary md5+ldd, captured config), `gpudb-exe-r{N}-*.txt` (per-rank process: command line, PID, environment — memory limits, LD_PRELOAD/jemalloc), `gpudb-exe.txt` (all gpudb processes), `loki-info.txt` (Loki log-index stats), `tables.txt` (schemas, when collected).
- **Memory / CPU / GPU:** `mem.txt` (free + /proc/meminfo + transparent hugepage), `cpu.txt` (lscpu, NUMA, interrupts), `gpu.txt` (nvidia-smi -L/-q, modinfo nvidia).
- **Disk / storage:** `disk.txt` (df, mount, lsblk, fdisk, /proc/diskstats), `lsof.txt` (open files + sockets), `lslocks.txt` (file locks).
- **Network:** `net.txt` (ifconfig, netstat, resolv.conf).
- **Kernel / OS:** `dmesg.txt` (kernel ring buffer — OOM killer, segfaults, hardware errors), `sys.txt` (uname, uptime, ulimits, kernel cmdline, clocksource, lsmod), `sysctl.txt` (kernel tunables).
- **Hardware / firmware:** `dmidecode.txt` (BIOS/DMI), `lshw.txt` (hardware listing), `pci.txt` (lspci, I/O resources).
- **Processes:** `ps.txt` (full process list).
- **Packages / accounts:** `deb.txt` / `rpm.txt` (installed packages), `user.txt` (users/groups, gpudb account), `ld.so.conf.txt`, `etc_*.txt` (system shell/host config).
- **Evidence Gaps:** `errors.txt` / `proc-logs-erros.txt` — collection commands that FAILED. `logfiles.txt` — manifest of log dirs the collector enumerated.

### When the bundle doesn't match the expected layout

Not every bundle is a full `gpudb_sysinfo` capture. A customer may hand over a bare logs-only dump, a differently-named collector's output, or a flat directory. `kinetica_bundle_list_files` tells you how well it matched, so you never reason blindly over an unfamiliar shape:

- **`layout_match`** — `canonical` (a normal gpudb_sysinfo bundle), `partial`, or `unfamiliar` (none of the expected config/version/host-diagnostic anchors were found, e.g. a logs-only dump). When it is not `canonical`, a `layout_note` summarizes what was inferred.
- **Per-file `confidence`** — `exact` (matched a canonical name/location), `inferred` (recognized by a name or content heuristic — e.g. a rolling log shipped WITHOUT the `core-` prefix, or a `.out` whose first lines parsed as log lines), or `weak`. The `why` field states how each file was classified.
- **`inferred_ranks_unconfirmed`** — ranks seen only via a loose name guess, never confirmed by a canonical pattern or by log content. Treat these as "possible — verify," distinct from `ranks_present`, which stays trustworthy.
- **`unknown_file_paths`** — files that could not be classified at all. Do NOT ignore them: they may be evidence under an unfamiliar name. Read one with `kinetica_bundle_read_sysinfo` (it returns the raw content / EXEC_CMD blocks) to decide what it holds.

Inference does not make a file second-class: a rolling log recognized without its `core-` prefix is treated exactly like a canonical core log — it appears in `ranks_present` and `kinetica_bundle_search_logs`/`log_timeline` search it normally. The parsers have already been applied for you. Your job: trust `ranks_present` / `services_present`, sanity-check anything marked `inferred` or `unknown`, and state plainly in the report when the evidence came from an off-shape bundle (note the `layout_match`).

### Two log families — and why every rank is reachable

A bundle carries per-rank logs in up to two places, and the collector host usually holds only a couple of the cluster's ranks:

- **`logs-local/` — rolling core logs** (`core-gpudb-rolling-r{N}.log`, plus rotations `…​.log.1`): the full local history, but ONLY for the ranks running on the host the collector ran on (often just r0/r1). These are the primary, richest source for those ranks.
- **`logs/` — Loki/promtail exports** (`rank{N}.log` for every rank cluster-wide, `hostmanager.log`, and per-component tails like `sql.log`, `graph.log`): pulled from centralized logging, so these are the ONLY evidence for ranks on hosts the collector didn't run on (e.g. r2…r8). They are JSON-wrapped on disk, but the tools unwrap them transparently — you still filter by `min_severity`, `from_ts`/`to_ts`, and get clean messages.

You do not choose between families. `rank: "r{N}"` resolves to that rank's rolling log if present, else its Loki tail — so **all** ranks reported under `ranks_present` are searchable the same way, and a default (no-rank) search/timeline spans the whole cluster. `host_manager: true` likewise prefers `core-gpudb-rolling-hm.log`, falling back to `logs/hostmanager.log`. Trust `ranks_present` from `kinetica_bundle_list_files` for the true rank count; don't infer it from `logs-local/` alone.

Each `*.txt` artifact records the exact shell command that produced it in its `EXEC_CMD:` header, so `kinetica_bundle_read_sysinfo` always shows you precisely what ran.
