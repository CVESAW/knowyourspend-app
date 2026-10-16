import { describe, expect, it } from "vitest";
import { mapLayout } from "../src/map-layout";
import { shareColour, shareSvg } from "../src/share-card";

describe("share card", () => {
  const svg = shareSvg({ ukShare: 0.55, periodLabel: "Last 3 months", slices: [{ iso: "GB", share: 0.55 }, { iso: "US", share: 0.3 }, { iso: "OTHER", share: 0.15 }] });
  it("shows whole-number percentages and country names only", () => {
    expect(svg).toContain("55%");
    expect(svg).toContain("United States");
    const visible = [...svg.matchAll(/>([^<]+)</g)].map((m) => m[1]).join(" ");
    expect(visible).not.toMatch(/£|\d+\.\d{2}/);
  });
  it("gives Denmark and Luxembourg different colours", () => {
    expect(shareColour("DK")).not.toBe(shareColour("LU"));
  });
});

describe("map layout", () => {
  it("draws land and one bubble per known country, bigger for bigger shares", () => {
    const m = mapLayout([{ iso: "GB", share: 0.6 }, { iso: "US", share: 0.3 }, { iso: "LU", share: 0.1 }]);
    expect(m.path.length).toBeGreaterThan(1000);
    expect(m.bubbles).toHaveLength(3);
    expect(m.bubbles[0]!.iso).toBe("GB");
    for (const b of m.bubbles) {
      expect(b.x).toBeGreaterThan(0);
      expect(b.x).toBeLessThan(340);
    }
  });
});
