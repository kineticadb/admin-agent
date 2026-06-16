/**
 * known-files — one-line descriptions of the canonical files a gpudb_sysinfo
 * bundle collects, so orientation tools can tell the agent WHAT a file contains
 * without reading it.
 *
 * Source of truth: the collector script gpudb_sysinfo.sh maps each output file to
 * the shell command(s) that produce it (`run_cmd "<file>" "<command>"`). These
 * descriptions are distilled from that mapping. The filenames are stable,
 * long-standing conventions, so this is pinned by basename; an unrecognized file
 * simply falls back to a per-kind description, then to "" (graceful — never wrong,
 * just absent). On read, the EXEC_CMD header inside each artifact still carries the
 * exact command, so this map is an orientation aid, not the authority.
 *
 * Pure, never throws.
 */

import type { BundleFileKind } from "./classify-file.js";

/** Canonical OS-diagnostic / version / config filenames → what the collector captures. */
export const KNOWN_BUNDLE_FILES: Readonly<Record<string, string>> = {
  // Host resources
  "cpu.txt": "CPU topology, NUMA, and interrupts (lscpu, numactl, /proc/cpuinfo, /proc/interrupts)",
  "mem.txt": "Memory usage, /proc/meminfo, and transparent-hugepage setting (free -m -t)",
  "disk.txt":
    "Filesystems, mounts, block devices, and disk stats (df, mount, lsblk, fdisk, /etc/fstab, /proc/diskstats)",
  "gpu.txt": "NVIDIA GPU inventory and state (nvidia-smi -L/-q, modinfo nvidia)",
  "net.txt": "Network interfaces, sockets, and DNS (hostname, ifconfig, netstat, /etc/resolv.conf)",
  // Processes
  "ps.txt": "Full process list (ps -auxww, ps -ejHlfww)",
  "gpudb-exe.txt": "Running gpudb processes (ps auxfwww | grep gpudb)",
  // Hardware / firmware
  "dmidecode.txt": "BIOS / DMI hardware inventory (dmidecode)",
  "lshw.txt": "Hardware listing (lshw -short -numeric)",
  "pci.txt": "PCI devices and I/O resources (lspci, /proc/ioports, /proc/iomem)",
  // Kernel / OS
  "dmesg.txt": "Kernel ring buffer — boot and runtime kernel messages (dmesg -T)",
  "dmesg-timestamp.txt": "Kernel ring buffer with human-readable timestamps",
  "sysctl.txt": "Kernel tunables (sysctl -a)",
  "sys.txt":
    "OS identity, uptime, ulimits, kernel cmdline, clocksource, and loaded modules (uname, ulimit, /proc/cmdline, lsmod)",
  "lsof.txt": "Open files and network sockets (lsof -n -P)",
  "lslocks.txt": "Held file locks (lslocks)",
  // Packages / linker / accounts
  "deb.txt": "Installed Debian packages and verification (dpkg -l, dpkg -V)",
  "rpm.txt": "Installed RPM packages (rpm -qa)",
  "ld.so.conf.txt": "Dynamic-linker library search paths (/etc/ld.so.conf)",
  "user.txt": "Users, groups, and the gpudb service account (whoami, id, /etc/passwd, /etc/group)",
  "sudoers.txt": "Sudo configuration (/etc/sudoers)",
  "etc_profile.txt": "Login shell profile (/etc/profile)",
  "etc_bashrc.txt": "System bashrc (/etc/bashrc)",
  "etc_host.txt": "Static hostname resolution (/etc/hosts)",
  // Kinetica-specific
  "gpudb.txt":
    "GPUdb version/build, binary md5 + ldd, and the captured gpudb.conf / gpudb_logger.conf ($GPUDB_EXE -v)",
  "gpudb_core_etc_gpudb.conf": "The live gpudb.conf at capture time (the database's main config)",
  "gpudb_core_etc_gpudb_logger.conf": "The logging configuration (gpudb_logger.conf)",
  "loki-info.txt": "Loki log-index stats: labels, series, and per-class volume (logcli)",
  "sql-queries.txt": "SQL query log extracted from Loki (logcli)",
  "tables.txt": "Table schemas and column types (gadmin --schema), when collected",
  "logfiles.txt": "Manifest: the log directories/files the collector enumerated",
  "errors.txt": "Collection commands that FAILED during capture (Evidence Gaps)",
  "proc-logs-erros.txt": "Per-process log-collection failures during capture (Evidence Gaps)",
};

/** Per-kind fallback description for files not matched by a canonical filename. */
const KIND_DESCRIPTIONS: Partial<Record<BundleFileKind, string>> = {
  "core-log": "Per-rank rolling Kinetica core log (the primary incident narrative)",
  "component-log": "Component service log (sql-engine, httpd, reveal, tomcat, stats, …)",
  "loki-tail": "Last-2h Loki tail for a service (small; searched only when no core logs exist)",
  "process-info":
    "Per-rank process snapshot: command line, PID, and environment (/proc/<pid>/environ)",
  config: "Kinetica configuration file",
  "version-info": "GPUdb version/build information",
  "collection-errors": "Collection commands that FAILED during capture (Evidence Gaps)",
  manifest: "Manifest of log directories/files the collector enumerated",
};

/** Basename of a bundle-relative path (index stores POSIX-normalized relPaths). */
function basename(relPath: string): string {
  const parts = relPath.split("/");
  return parts[parts.length - 1] ?? relPath;
}

/**
 * One-line description of what a bundle file contains, for orientation. Prefers an
 * exact canonical-filename match (distilled from the collector script), then falls
 * back to a per-kind description. Returns "" when nothing is known (graceful).
 */
export function describeBundleFile(entry: { relPath: string; kind: BundleFileKind }): string {
  return KNOWN_BUNDLE_FILES[basename(entry.relPath)] ?? KIND_DESCRIPTIONS[entry.kind] ?? "";
}
