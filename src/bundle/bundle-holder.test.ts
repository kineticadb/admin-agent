import { describe, it, expect } from "vitest";
import { createBundleHolder } from "./bundle-holder.js";
import type { BundleSource } from "./BundleSource.js";

// A minimal stand-in; the holder only stores/returns the reference.
const fakeSource = { root: "/x" } as unknown as BundleSource;

describe("createBundleHolder", () => {
  it("starts empty when no initial source is given", () => {
    const holder = createBundleHolder();
    expect(holder.isLoaded()).toBe(false);
    expect(holder.get()).toBeUndefined();
  });

  it("starts loaded when an initial source is given", () => {
    const holder = createBundleHolder(fakeSource);
    expect(holder.isLoaded()).toBe(true);
    expect(holder.get()).toBe(fakeSource);
  });

  it("attaches a source via set()", () => {
    const holder = createBundleHolder();
    holder.set(fakeSource);
    expect(holder.isLoaded()).toBe(true);
    expect(holder.get()).toBe(fakeSource);
  });

  it("replaces an existing source", () => {
    const holder = createBundleHolder(fakeSource);
    const other = { root: "/y" } as unknown as BundleSource;
    holder.set(other);
    expect(holder.get()).toBe(other);
  });
});
