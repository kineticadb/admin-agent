/**
 * Terminal spinner — braille-dot animation that signals the agent is working.
 *
 * Writes to stderr so it doesn't interfere with agent data on stdout.
 * Uses carriage-return + ANSI erase-line to update in place without scrolling.
 *
 * Design choices:
 * 1. Factory pattern (createSpinner) — matches project convention (createTurnGate,
 *    createStreamingTableAligner, etc.) and returns a frozen object.
 * 2. Idempotent start/stop — calling start() while running or stop() while stopped
 *    is a no-op, simplifying callsite logic in the event loop.
 * 3. Label parameter on start() — allows contextual messages ("Thinking" vs
 *    "Investigating") without creating multiple spinner instances.
 */

import pc from "picocolors";

/** Braille-dot animation frames — cycles smoothly at 80ms intervals. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Animation interval in milliseconds. */
const FRAME_INTERVAL_MS = 80;

/** Default label displayed alongside the spinner. */
const DEFAULT_LABEL = "Thinking";

export interface Spinner {
  /** Start the spinner animation with an optional label. No-op if already running. */
  readonly start: (label?: string) => void;
  /** Stop the spinner and clear the line. No-op if not running. */
  readonly stop: () => void;
  /** Returns true if the spinner is currently animating. */
  readonly isRunning: () => boolean;
}

/**
 * Creates a terminal spinner that writes to stderr.
 *
 * Displays a braille animation with a label (e.g., "⠋ Thinking...").
 * Call stop() before writing other content to stderr — it clears the
 * spinner line via carriage-return + ANSI erase-line.
 */
export function createSpinner(): Spinner {
  let timer: ReturnType<typeof setInterval> | null = null;
  let frameIndex = 0;

  const start = (label: string = DEFAULT_LABEL): void => {
    if (timer !== null) return;
    frameIndex = 0;
    timer = setInterval(() => {
      const frame = FRAMES[frameIndex % FRAMES.length];
      process.stderr.write(`\r${pc.dim(`${frame} ${label}...`)}`);
      frameIndex += 1;
    }, FRAME_INTERVAL_MS);
    // Unref so the timer alone won't keep the Node.js event loop alive —
    // if all other work is done, the process should exit cleanly even if
    // stop() was missed on some code path.
    timer.unref();
  };

  const stop = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    // Carriage return + ANSI erase line — removes spinner text completely
    process.stderr.write("\r\x1b[K");
  };

  const isRunning = (): boolean => timer !== null;

  return Object.freeze({ start, stop, isRunning });
}
