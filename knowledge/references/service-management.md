---
title: Kinetica Service Management — Correct Start/Stop/Restart Commands
category: operations
keywords:
  [
    service-management,
    systemctl,
    gadmin,
    restart,
    start,
    stop,
    gpudb,
    gpudb_host_manager,
    kinetica_stats,
    gpudb-mq,
    rank-restart,
    host-manager,
    remediation,
    operator-instructions,
  ]
summary: "The ONLY sanctioned start/stop/restart commands (systemctl units, the `/opt/gpudb/core/bin/gpudb` script), full-stack ordering, and the never-emit table. `gadmin` is a GUI, not a CLI; there is NO per-rank restart."
read_when: "MANDATORY before any remediation step that starts, stops, or restarts anything."
---

## Scope

Every remediation step that tells the operator to restart, start, or stop a
Kinetica service MUST use a command from this reference. Service control is
**out of band** — the agent has no tool for it (no REST API, and `Bash` is
disallowed), so these commands are always given to the operator to run, never
executed.

Source: Kinetica documentation, _Admin → Services_.

## The Two Correct Command Families

### 1. `systemctl` — whole services, run as **root**

| Service                | Start                                | Stop                                |
| ---------------------- | ------------------------------------ | ----------------------------------- |
| Database               | `systemctl start gpudb`              | `systemctl stop gpudb`              |
| Host Manager           | `systemctl start gpudb_host_manager` | `systemctl stop gpudb_host_manager` |
| Stats/metrics (KAgent) | `systemctl start kinetica_stats`     | `systemctl stop kinetica_stats`     |
| RabbitMQ (HA only)     | `systemctl start gpudb-mq`           | `systemctl stop gpudb-mq`           |

Status: `service gpudb status`.

**Restart the database** = stop then start:
`systemctl stop gpudb` followed by `systemctl start gpudb`.

**Full-stack ordering matters.** Start in this order:

```
systemctl start kinetica_stats
systemctl start gpudb-mq            # HA clusters only
systemctl start gpudb_host_manager
systemctl start gpudb
```

Stop in the exact reverse order (`gpudb` → `gpudb_host_manager` → `gpudb-mq` →
`kinetica_stats`). Stopping the Host Manager also stops the database services.

On a multi-host cluster, the system management processes (Host Manager, GAdmin)
run on **every** node — say so explicitly when recommending a cluster-wide
action, and name the hosts involved.

### 2. `/opt/gpudb/core/bin/gpudb` — individual components, run as **gpudb**

Form: `/opt/gpudb/core/bin/gpudb <component>-<directive>`

- Directives: `start`, `stop`, `restart`, `status`, `pids`, `enabled`,
  `installed`
- Components: `host-manager`, `gpudb`, `graph`, `httpd`, `query-planner`,
  `reveal`, `stats`, `text-search`, `tomcat`

Examples:

```
/opt/gpudb/core/bin/gpudb stats-restart
/opt/gpudb/core/bin/gpudb host-manager-status
/opt/gpudb/core/bin/gpudb graph-pids
```

This script must always be run as the `gpudb` user, never as root. Note that
when `external_text_search = false`, the text search server cannot be managed
individually — the Host Manager owns it (as it does HTTPD and ODBC).

## WRONG — Never Emit These

| Wrong command                                     | Why it is wrong                                                           | Say instead                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `gadmin restart rank 2`                           | `gadmin` is not a service-control CLI, AND no per-rank restart exists     | Restart the database on the affected host (see "Restarting a rank") |
| `gadmin restart` / `gadmin start` / `gadmin stop` | GAdmin is the **web admin GUI**, not a command-line service manager       | `systemctl stop gpudb` + `systemctl start gpudb`                    |
| `gadmin status`                                   | Same — no such CLI                                                        | `service gpudb status`, or `/opt/gpudb/core/bin/gpudb gpudb-status` |
| `systemctl restart rank2`                         | Ranks are not systemd units                                               | `systemctl stop gpudb` + `systemctl start gpudb` on that host       |
| `systemctl start hostmanager`                     | Wrong unit name                                                           | `systemctl start gpudb_host_manager`                                |
| `gpudb restart`                                   | The script requires a `<component>-<directive>` pair and an absolute path | `/opt/gpudb/core/bin/gpudb gpudb-restart`                           |

## There Is No Per-Rank Restart

Kinetica exposes **no** documented mechanism to start, stop, or restart an
individual rank. All service control is at the **host** or **component** level.
Individual rank processes are supervised by the **Host Manager**, which restarts
failed ranks according to `np1.rank_restart_attempts` (see `gpudb-conf.md`).

### Restarting a rank — what to actually tell the operator

1. Identify the **host** the rank runs on (`kinetica_host_manager_status` or
   `kinetica_cluster_status` gives the rank → host mapping) — name that host in
   the remediation.
2. Check whether the Host Manager has already tried to recover it (rank process
   status and PIDs in `kinetica_host_manager_status`).
3. If a restart is genuinely required, the operator restarts the **database
   service on that host** as root: `systemctl stop gpudb` then
   `systemctl start gpudb`. State plainly that this affects the whole database
   on that host, not just the one rank — it is not a surgical action, and the
   operator needs to know that before choosing a window.
4. Verify recovery with `kinetica_health_check` and `kinetica_cluster_status`.

## Reporting Rules

- Give the **exact command string**, the **user** it runs as (root vs `gpudb`),
  and the **host** it runs on. A bare "restart the database" is not actionable.
- Never invent a flag, subcommand, or service name that does not appear above.
  If the action you want has no documented command, say so explicitly rather
  than approximating one.
- Config changes made via `kinetica_alter_configuration` require a database
  restart to take effect — pair that remediation with the `systemctl` stop/start
  pair above.
- KAgent can start all services from its UI; mention it as an alternative when
  the operator is working through KAgent rather than a shell.
