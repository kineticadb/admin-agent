/**
 * TurnGate — promise-based synchronization primitive for the interactive loop.
 *
 * Prevents the "You:" prompt from appearing before the agent finishes its turn.
 * The async generator awaits the gate; the output loop opens it on `end_turn`.
 *
 * Semantics:
 * - Starts **closed** (pending promise)
 * - `open()` resolves the current promise (idempotent)
 * - `close()` replaces with a fresh pending promise
 * - `wait()` returns the current promise
 */

export interface TurnGate {
  /** Returns the current gate promise. Resolves when the gate is open. */
  readonly wait: () => Promise<void>;
  /** Resolves the current gate promise (idempotent — safe to call twice). */
  readonly open: () => void;
  /** Creates a new pending promise, blocking future wait() calls. */
  readonly close: () => void;
}

/**
 * Creates a new TurnGate that starts in the closed (blocked) state.
 *
 * @returns A frozen TurnGate object
 */
export function createTurnGate(): TurnGate {
  let resolve: () => void = () => {};
  let promise: Promise<void> = new Promise<void>((r) => {
    resolve = r;
  });

  return Object.freeze({
    wait: () => promise,
    open: () => {
      resolve();
    },
    close: () => {
      promise = new Promise<void>((r) => {
        resolve = r;
      });
    },
  });
}
