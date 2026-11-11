import { describe, expect, it } from "vitest";
import { parseWithMapping } from "@kys/statement";
import { _resetAttributionCache } from "../src/attribute";
import { prepareStatement } from "../src/prepare";

// Made-up people; the shops are real brands only where the built-in list is being tested.
const statement = async (rows: [string, number][]) => {
  const csv = ["Date,Type,Description,Amount", ...rows.map(([d, a], i) => `2026-07-${String(i + 1).padStart(2, "0")},DEB,${d},${a.toFixed(2)}`)].join("\n");
  _resetAttributionCache();
  return prepareStatement(await parseWithMapping(csv, { date: 0, type: 1, description: 2, amount: 3 }), "s1");
};

describe("names paid through PayPal", () => {
  const people: [string, number][] = [
    ["PAYPAL *JOHNSMITH 35314369001 GBR", -20],
    ["PP*SARAHJONES", -15],
    ["PAYPAL *JANEDOE", -12],
    ["PAYPAL *JOHN SMITH", -30],
    ["PAYPAL *J SMITH", -8],
    ["CARD PAYMENT TO PAYPAL *JOHNSMITH ON 12 MAR", -9],
    ["PAYPAL *JANEDOE", 12], // a refund
  ];
  const brands: [string, number][] = [
    ["PAYPAL *NETFLIX", -10.99],
    ["PAYPAL *STEAM", -19.99],
    ["PAYPAL *EBAY", -24.5],
    ["PAYPAL *MICROSOFT", -5.99],
    ["KLARNA*ASOS", -60],
  ];

  it("a name that could be a person's is held back, never among the names the look-up would get", async () => {
    const { plan } = await statement([...people, ...brands]);
    for (const n of ["JOHNSMITH", "SARAHJONES", "JANEDOE", "JOHN SMITH", "J SMITH"]) {
      expect(plan.candidates).not.toContain(n);
      expect(plan.sensitive).toContain(n);
    }
    expect(plan.candidates).toEqual([]);
  });

  it("known brands are still recognised on the device", async () => {
    const { txns, plan } = await statement(brands);
    expect(txns.map((t) => [t.normPayee, t.resolution, t.entryId])).toEqual([
      ["NETFLIX", "RESOLVED", "netflix"],
      ["STEAM", "RESOLVED", "steam"],
      ["EBAY", "RESOLVED", "ebay"],
      ["MICROSOFT", "RESOLVED", "microsoft"],
      ["ASOS", "RESOLVED", "asos"],
    ]);
    expect(plan.recognisedLocally).toBe(5);
    expect(plan.candidates).toEqual([]);
    expect(plan.sensitive).toEqual([]);
  });

  it("an unknown shop paid through a pay-later service is looked up (they only pay shops)", async () => {
    const { plan } = await statement([["KLARNA*ZZQSHOP", -40], ["CLEARPAY*ZZQSTORE", -25]]);
    expect(plan.candidates).toEqual(["ZZQSHOP", "ZZQSTORE"]);
  });

  it("a shop name with an organisation word is still looked up", async () => {
    const { plan } = await statement([["PAYPAL *ZZQ EXAMPLE TRADING LTD", -14], ...people]);
    expect(plan.candidates).toEqual(["ZZQ EXAMPLE TRADING LTD"]);
  });
});
