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
- Timestamps are plain local strings without a timezone; compare them lexically and treat cross-rank timing cautiously.
- **Ranks vs. the host manager:** `rank` selects a numeric rank (`r0`, `r1`, …) only. The host manager (`core-gpudb-rolling-hm.log`) is a singleton service, NOT a rank — search or timeline it with `host_manager: true`, never `rank: "hm"`. By default both `log_timeline` and `search_logs` already cover the host manager along with the numeric ranks; `kinetica_bundle_list_files` lists it under `services_present`.

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

Rolling core logs under `logs-local/` are the primary source. The small last-2h Loki tails under `logs/` are searched only when no rolling core logs were collected. Each `*.txt` artifact records the exact shell command that produced it in its `EXEC_CMD:` header, so `kinetica_bundle_read_sysinfo` always shows you precisely what ran.
