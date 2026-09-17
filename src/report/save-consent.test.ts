/**
 * Tests for the one-shot save-consent token.
 *
 * The token is what turns "the operator agreed to this save" into a fact the RUNTIME
 * holds, rather than a rule the system prompt asks the model to follow. Three states,
 * not two, because "declined" and "never asked" must produce DIFFERENT handler
 * behavior: a decline is final (never re-prompt — that is how a confirmation becomes
 * a reflex), while an unasked save falls back to prompting inline.
 */
import { describe, it, expect } from "vitest";

import { createSaveConsent } from "./save-consent.js";

describe("createSaveConsent", () => {
  it("starts unasked", () => {
    expect(createSaveConsent().take()).toBe("unasked");
  });

  it("reports a granted answer", () => {
    const consent = createSaveConsent();
    consent.record(true);
    expect(consent.take()).toBe("granted");
  });

  it("distinguishes a decline from never having asked", () => {
    const consent = createSaveConsent();
    consent.record(false);
    expect(consent.take()).toBe("denied");
  });

  it("is one-shot: a second take() sees unasked again", () => {
    const consent = createSaveConsent();
    consent.record(true);
    expect(consent.take()).toBe("granted");
    expect(consent.take()).toBe("unasked");
  });

  it("serves a second investigation in the same session", () => {
    const consent = createSaveConsent();
    consent.record(true);
    consent.take();
    consent.record(false);
    expect(consent.take()).toBe("denied");
  });

  it("lets the latest answer win when asked twice before a save", () => {
    const consent = createSaveConsent();
    consent.record(false);
    consent.record(true);
    expect(consent.take()).toBe("granted");
  });

  it("returns a frozen object", () => {
    expect(Object.isFrozen(createSaveConsent())).toBe(true);
  });
});
