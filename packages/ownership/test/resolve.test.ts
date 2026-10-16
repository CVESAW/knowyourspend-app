import { describe, expect, it } from "vitest";
import {
  allEntries, badgeFor, countries, createResolver, isPublishable, merchants, normalise, productBrands, tierRank,
} from "../src/index";
import type { OwnershipEntry } from "../src/types";

const r = createResolver(allEntries);
const id = (s: string) => r.resolve(s).entry?.id;
const pid = (s: string) => r.resolveProduct(s).entry?.id;

describe("normalise", () => {
  it("upper-cases, drops apostrophes, keeps &, collapses punctuation", () => {
    expect(normalise("Sainsbury's  S/Mkts")).toBe("SAINSBURYS S MKTS");
    expect(normalise("M&S Simply-Food")).toBe("M&S SIMPLY FOOD");
    expect(normalise("Müller Corner")).toBe("MULLER CORNER");
    expect(normalise("UBER *EATS")).toBe("UBER EATS");
  });
});

describe("resolve() statement payees", () => {
  const cases: [string, string][] = [
    ["TESCO STORES", "tesco"],
    ["TESCO STORES 2041", "tesco"],
    ["TESCO PFS 3342", "tesco"],
    ["TESCO.COM", "tesco"],
    ["SAINSBURYS S/MKTS", "sainsburys"],
    ["JS ONLINE GROCERY", "sainsburys"],
    ["AMAZON", "amazon"],
    ["AMZNMKTPLACE", "amazon"],
    ["AMZN MKTP UK*AB12CD34E", "amazon"],
    ["AMAZON.CO.UK*1A2B3C", "amazon"],
    ["UBER EATS", "uber-eats"],
    ["UBER *EATS PENDING", "uber-eats"],
    ["UBER", "uber"],
    ["UBER *TRIP HELP.UBER.COM", "uber"],
    ["COSTA COFFEE", "costa"],
    ["PRET A MANGER", "pret"],
    ["M&S SIMPLY FOOD", "marks-and-spencer"],
    ["MARKS & SPENCER PLC", "marks-and-spencer"],
    ["TFL TRAVEL CH TFL.GOV.UK/CP", "tfl"],
    ["SKY DIGITAL", "sky"],
    ["SKY BET", "paddy-power"],
    ["NETFLIX.COM", "netflix"],
    ["APPLE.COM/BILL", "apple"],
    ["THREE.CO.UK", "three"],
    ["DOMINOS PIZZA", "dominos"],
    ["MCDONALDS 1234", "mcdonalds"],
    ["TESCO MOBILE", "tesco-mobile"],
    ["SOUTHERN CO-OP", "co-op-societies"],
    ["CO-OP GROUP 470", "co-op"],
    ["DVLA VEHICLE TAX", "dvla"],
    ["ROYAL BOROUGH OF GREENWICH COUNCIL TAX", "local-council"],
  ];
  it.each(cases)("%s -> %s", (input, expected) => {
    const res = r.resolve(input);
    expect(res.status).toBe("RESOLVED");
    expect(res.via).toBe("local_list");
    expect(res.entry?.id).toBe(expected);
    expect(res.matched_alias).toBeTruthy();
  });

  it("longest alias wins (UBER EATS beats UBER)", () => {
    expect(r.resolve("UBER EATS").matched_alias).toBe("UBER EATS");
  });

  it("PSP prefix loses to the real merchant", () => {
    expect(id("PAYPAL *NETFLIX")).toBe("netflix");
    expect(id("PAYPAL *EBAY")).toBe("ebay");
    expect(id("PAYPAL")).toBe("paypal");
  });

  it("independent businesses are not forced onto a chain", () => {
    const joes = r.resolve("JOE'S CAFE");
    expect(["LIKELY_INDEPENDENT", "UNRESOLVED"]).toContain(joes.status);
    expect(joes.entry).toBeUndefined();
    expect(r.resolve("JOE'S CAFE").status).toBe("LIKELY_INDEPENDENT");
    expect(r.resolve("SQ *THE LITTLE PLACE").status).toBe("LIKELY_INDEPENDENT");
    expect(r.resolve("PAYPAL *ROSES FLORIST").status).toBe("LIKELY_INDEPENDENT");
    expect(r.resolve("XYZ LTD 0000").status).toBe("UNRESOLVED");
    expect(r.resolve("").status).toBe("UNRESOLVED");
  });

  it("matches at word boundaries only", () => {
    expect(id("ICELANDAIR")).toBeUndefined();
    expect(id("BPX HOLDINGS")).toBeUndefined();
    expect(id("SKYLINE TAXIS")).toBeUndefined();
  });

  it("chain rules are sensible for known corrections", () => {
    const e = (k: string) => merchants.find((m) => m.id === k)!;
    expect(e("asda").owner_country).toBe("GB");
    expect(e("boots").owner_country).toBe("US");
    expect(e("three").owner_country).toBe("GB");
    expect(e("b-and-m").legal_country).toBe("JE");
    expect(e("deliveroo").owner_country).toBe("US");
    expect(e("just-eat").owner_country).toBe("NL");
    expect(e("morrisons").owner_country).toBe("US");
    expect(e("superdrug").legal_country).toBe("KY");
  });
});

describe("resolveProduct() receipt lines", () => {
  const cases: [string, string][] = [
    ["CADBURY DAIRY MILK 200G", "cadbury"],
    ["CDM BUTTONS 4PK", "cadbury"],
    ["HNZ BEANZ 415G", "heinz"],
    ["HEINZ TOMATO KETCHUP", "heinz"],
    ["COCA COLA ZERO 2L", "coca-cola"],
    ["DIET COKE 8X330ML", "coca-cola"],
    ["WALKERS CRISPS 6PK", "walkers"],
    ["PG TIPS 80S", "pg-tips"],
    ["YORKSHIRE TEA 160", "yorkshire-tea"],
    ["BEN & JERRY'S COOKIE DOUGH", "ben-and-jerrys"],
    ["MÜLLER CORNER STRAWBERRY", "muller"],
    ["LURPAK SPREADABLE 500G", "lurpak"],
    ["KELLOGGS CORN FLAKES", "kelloggs"],
    ["ANDREX 9 ROLL", "andrex"],
  ];
  it.each(cases)("%s -> %s", (input, expected) => {
    const res = r.resolveProduct(input);
    expect(res.status).toBe("RESOLVED");
    expect(res.entry?.kind).toBe("product_brand");
    expect(res.entry?.id).toBe(expected);
  });

  it("retailer own-brand lines stay UNRESOLVED and flag the retailer", () => {
    const res = r.resolveProduct("TESCO BAKED BEANS");
    expect(res.status).toBe("UNRESOLVED");
    expect(res.entry).toBeUndefined();
    expect(res.own_brand_retailer?.id).toBe("tesco");
    expect(r.resolveProduct("BY SAINSBURYS BANANAS").own_brand_retailer?.id).toBe("sainsburys");
  });

  it("unknown lines are UNRESOLVED", () => {
    expect(r.resolveProduct("LOOSE CARROTS 0.5KG").status).toBe("UNRESOLVED");
    expect(pid("BAG FOR LIFE")).toBeUndefined();
  });

  it("brand beats retailer on the same line", () => {
    expect(pid("TESCO HEINZ BEANS")).toBe("heinz");
  });
});

describe("tiers, badges, publishability", () => {
  const base: OwnershipEntry = {
    id: "x", display_name: "X", kind: "merchant", aliases: ["X CO"], owner_country: "GB", tier: "CURATED",
    chain: [{ name: "X plc", relation: "ultimate_parent", country: "GB", source: "company_filing", source_url: "https://example.org" }],
    technique: "t", sources: [{ label: "s", url: "https://example.org" }], as_of: "2026-09-01",
    reviewed_by: "A Reviewer", reviewed_at: "2026-09-01",
  };

  it("tierRank orders the ladder", () => {
    expect(tierRank("CURATED")).toBeGreaterThan(tierRank("EXACT_ID"));
    expect(tierRank("EXACT_ID")).toBeGreaterThan(tierRank("NAME_MATCH"));
    expect(tierRank("NAME_MATCH")).toBeGreaterThan(tierRank("LLM_GUESS"));
  });

  it("badgeFor maps tiers to user-facing labels", () => {
    expect(badgeFor("CURATED").label).toBe("Checked");
    expect(badgeFor("EXACT_ID").label).toBe("Matched");
    expect(badgeFor("NAME_MATCH").label).toBe("Matched");
    expect(badgeFor("LLM_GUESS").label).toBe("Unverified");
  });

  it("only fresh, reviewed CURATED entries are publishable", () => {
    expect(isPublishable(base, "2026-10-01")).toBe(true);
    expect(isPublishable(base, "2027-06-01")).toBe(false); // > 180 days
    expect(isPublishable({ ...base, reviewed_by: null, reviewed_at: null }, "2026-10-01")).toBe(false);
    expect(isPublishable({ ...base, tier: "EXACT_ID" }, "2026-10-01")).toBe(false);
  });

  it("the starter list has no CURATED entries and nothing is publishable yet", () => {
    expect(allEntries.some((e) => e.tier === "CURATED")).toBe(false);
    expect(allEntries.every((e) => e.reviewed_by === null && e.reviewed_at === null)).toBe(true);
    expect(allEntries.filter((e) => isPublishable(e, "2026-09-28"))).toHaveLength(0);
  });

  it("every owner_country has a flag", () => {
    for (const e of allEntries) expect(countries[e.owner_country]?.flag, e.id).toBeTruthy();
    expect(productBrands.length).toBeGreaterThanOrEqual(40);
    expect(merchants.length).toBeGreaterThanOrEqual(100);
  });
});
