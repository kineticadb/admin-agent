import { describe, it, expect } from "vitest";
import { zoneLabel, isMixedZones } from "./timestamp-zone.js";

describe("zoneLabel", () => {
  it("names the single clock a result came from", () => {
    expect(zoneLabel(["local"])).toMatch(/^local/);
    expect(zoneLabel(["local"])).toMatch(/no zone/i);
    expect(zoneLabel(["utc"])).toMatch(/^utc/);
  });

  it("flags a mixed result", () => {
    expect(zoneLabel(["local", "utc"])).toMatch(/^MIXED/);
  });

  it("says none when nothing timestamped was found", () => {
    expect(zoneLabel([])).toBe("none");
  });
});

describe("isMixedZones", () => {
  it("is true only when more than one clock is present", () => {
    expect(isMixedZones([])).toBe(false);
    expect(isMixedZones(["utc"])).toBe(false);
    expect(isMixedZones(["local", "utc"])).toBe(true);
  });
});
