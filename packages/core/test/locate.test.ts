import { describe, expect, it } from "vitest";
import { locate } from "../src/locate";
import { attribute, DEFAULT_CONTEXT } from "../src/attribute";
import { breakdown, contributions } from "../src/aggregate";
import type { Disclosure, Item, StoredTransaction } from "../src/types";

const where = (s: string, home = "GB") => locate([s], home);

describe("locate()", () => {
  it.each([
    ["CARD PAYMENT TO LE PETIT BISTRO PARIS FR", "FR", "country_code"],
    ["CAFE DE FLORE PARIS FRA", "FR", "country_code"],
    ["TAVERNA SOFIA MALAGA", "ES", "place"],
    ["TRATTORIA DA MARIO ROMA", "IT", "place"],
    ["TACO LOCO SAN DIEGO CA", "US", "place"],
    ["SOME SHOP          NEW YORK     US", "US", "country_code"],
    ["SHOP NAME UNITED STATES", "US", "country_name"],
    ["WWW.EXAMPLE.DE", "DE", "web_domain"],
    ["THE ROYAL OAK", "GB", "home"],
    ["JOES CAFE LONDON GB", "GB", "country_code"],
    ["PERTH SHOP PERTH", "GB", "place"],
    ["TOYS R US", "GB", "home"],
    ["WWW.ZALANDO.CO.UK", "GB", "web_domain"],
    // since 18 Oct 2026: a town after a web address, a town before the currency it was charged in, and the currency
    // alone when it's one country's own
    ["WWW.EXAMPLETAXI.COM BANGKOK", "TH", "place"],
    ["NOODLE CORNER BANGKOK THB 80.00", "TH", "place"],
    ["EXAMPLE STALL THB 250.00", "TH", "currency"],
    ["Sp Example Games USD 160.80", "US", "currency"],
    ["SUSHI BAR JPY 1,200", "JP", "currency"],
    ["CAFE EXEMPLO EUR 6.50", "GB", "home"],
    ["EXAMPLE PEN SHOP", "GB", "home"],
    // currency codes that are also words, or numbers that aren't money, aren't clues
    ["STORE 1234 PEN-Y-BONT", "GB", "home"],
    ["TRY 100 DAYS", "GB", "home"],
    ["MAD123456 SHOP", "GB", "home"],
    ["STORE 12.50 PEN-Y-BONT", "GB", "home"],
    ["EXAMPLE STALL THB250.00", "TH", "currency"],
    // two letters after a web address: CA is California here, IN just a word; padding makes it a terminal's country field
    ["NETFLIX.COM CA", "GB", "home"],
    ["WWW.EXAMPLE.CO.UK IN", "GB", "web_domain"],
    ["WWW.EXAMPLE.COM FR", "FR", "country_code"],
    ["WWW.EXAMPLE.COM        IT", "IT", "country_code"],
  ])("%s → %s", (raw, country, evidence) => {
    expect(where(raw)).toMatchObject({ country, evidence });
  });
});

describe("attribute()", () => {
  const t = (raw: string) => ({ rawPayee: raw, normPayee: raw, kind: "spend" as const, currency: "GBP" });
  it("named owner, then user fix, then estimate", () => {
    expect(attribute(t("TESCO STORES 2041"), DEFAULT_CONTEXT)).toMatchObject({ basis: "owner", country: "GB" });
    expect(attribute(t("THE ROYAL OAK"), DEFAULT_CONTEXT)).toMatchObject({ basis: "estimated", country: "GB", evidence: "home" });
    expect(attribute(t("THE ROYAL OAK"), { ...DEFAULT_CONTEXT, overrides: { "THE ROYAL OAK": "IE" } })).toMatchObject({ basis: "you", country: "IE" });
    expect(attribute(t("THE ROYAL OAK"), { ...DEFAULT_CONTEXT, estimate: false })).toEqual({});
  });
  it("uses online lookup answers saved on the device", () => {
    const entry = { id: "lookup-zz", display_name: "ZZ Shop", kind: "merchant" as const, aliases: ["ZZ SHOP"], chain: [], owner_country: "NL", tier: "NAME_MATCH" as const, technique: "t", sources: [], as_of: "2026-10-07", reviewed_by: null, reviewed_at: null };
    expect(attribute(t("ZZ SHOP"), { ...DEFAULT_CONTEXT, lookups: { "ZZ SHOP": entry } })).toMatchObject({ basis: "owner", country: "NL", method: "lookup" });
  });
});

describe("breakdown with estimates", () => {
  const off: Disclosure = { mode: "off", sent: [], notSent: [], sensitiveHeld: [], recognisedLocally: 0, transfersExcluded: 0, rowsRead: 0 };
  const item: Item = { id: "s1", kind: "statement", title: "s", createdAt: "2026-09-20T00:00:00Z", disclosure: off };
  const tx = (id: string, raw: string, amount: number, kind: StoredTransaction["kind"] = "spend"): StoredTransaction => ({ id, itemId: "s1", date: "2026-09-10", amount, currency: "GBP", rawPayee: raw, normPayee: raw, kind, sensitive: false, resolution: "UNRESOLVED" });
  it("counts unknown shops by where they were paid, apart from named owners", () => {
    const txns = [tx("1", "TESCO STORES", -40), tx("2", "THE ROYAL OAK", -20), tx("3", "TAVERNA SOFIA MALAGA", -30), tx("4", "J SMITH", -100, "transfer")];
    const b = breakdown(contributions([item], txns, [], DEFAULT_CONTEXT).list);
    expect(b.totalSpend).toBeCloseTo(90);
    expect(b.matchedSpend).toBeCloseTo(40);
    expect(b.estimatedSpend).toBeCloseTo(50);
    expect(b.scores.withCountry).toBeCloseTo(1);
    expect(b.scores.identified).toBeCloseTo(40 / 90);
    expect(b.countries.find((c) => c.iso === "ES")?.estimated).toBeCloseTo(30);
    expect(b.countries.find((c) => c.iso === "GB")?.entries.some((e) => e.entryId === "est:THE ROYAL OAK")).toBe(true);
  });
});
