/**
 * bundle-holder — a lazy, mutable reference to the active BundleSource.
 *
 * Why a holder rather than passing a BundleSource directly: the Agent SDK fixes
 * the tool set at query() creation, so to let a *live* session attach a bundle
 * mid-conversation (via kinetica_load_bundle), the bundle tools must already be
 * registered — bound to this holder — before any bundle exists. load_bundle then
 * populates the holder, and the previously-registered tools start working.
 *
 * This is a deliberate, encapsulated ref cell (one private `current`), not the
 * kind of data mutation the immutability rule targets. Nothing reads the field
 * directly; access goes through get()/isLoaded().
 */

import type { BundleSource } from "./BundleSource.js";

export interface BundleHolder {
  /** The active bundle source, or undefined if none is attached yet. */
  get(): BundleSource | undefined;
  /** Attach (or replace) the active bundle source. */
  set(source: BundleSource): void;
  isLoaded(): boolean;
}

export function createBundleHolder(initial?: BundleSource): BundleHolder {
  let current = initial;
  return {
    get: () => current,
    set: (source: BundleSource) => {
      current = source;
    },
    isLoaded: () => current !== undefined,
  };
}
