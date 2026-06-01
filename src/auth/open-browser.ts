/**
 * Cross-platform browser opener.
 *
 * Spawns the platform-appropriate command to open a URL in the default browser.
 * The child process is detached and unreferenced so it doesn't block the parent.
 * Never throws — returns false on failure for graceful degradation.
 */

import { spawn } from "child_process";

/**
 * Opens the given URL in the system's default browser.
 *
 * @returns true if the browser process was spawned successfully, false otherwise
 */
export function openBrowser(url: string): boolean {
  try {
    const platform = process.platform;

    const { command, args } =
      platform === "darwin"
        ? { command: "open", args: [url] }
        : platform === "win32"
          ? { command: "cmd", args: ["/c", "start", "", url] }
          : { command: "xdg-open", args: [url] }; // linux and others

    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
