import { describe, expect, it } from "vitest";
import { attribute, cardReader, DEFAULT_CONTEXT, matchLocal, _resetAttributionCache } from "../src/attribute";
import { explain, theCountry } from "../src/explain";
import { prepareStatement } from "../src/prepare";
import type { OwnershipEntry } from "@kys/ownership";
import type { ParseResult } from "@kys/statement";

// Made-up payments; shop names are real chains only where the built-in list is being tested.
const t = (raw: string, norm = raw) => ({ rawPayee: raw, rawDescription: raw, normPayee: norm, kind: "spend" as const, currency: "GBP" });
const why = (raw: string, norm = raw, ctx = DEFAULT_CONTEXT) => {
  _resetAttributionCache();
  const a = attribute(t(raw, norm), ctx);
  return { a, w: explain({ a, payee: norm, bankText: raw, home: "GB" }) };
};
const text = (w: ReturnType<typeof explain>) => [w.headline, ...w.sections.flatMap((s) => s.lines)].join(" ");

describe("card readers small businesses use", () => {
  it.each([
    ["SQ *THE BEAN HOUSE", "SQ", "Square"],
    ["CARD PAYMENT TO SQ *THE BEAN HOUSE ON 12 MAR", "SQ", "Square"],
    ["SUMUP *JOES VAN", "SUMUP", "SumUp"],
    ["ZETTLE_*FARMERS MARKET", "ZETTLE", "Zettle by PayPal"],
    ["IZ *MARKET STALL", "IZ", "Zettle by PayPal"],
  ])("%s → %s", (raw, prefix, provider) => {
    expect(cardReader(raw)).toEqual({ prefix, provider });
  });
  it("isn't fooled by ordinary words", () => {
    for (const raw of ["SQUARE MILE CAFE", "TESCO STORES 3142", "MISQUOTE LTD", "SUMMIT OUTDOOR"]) expect(cardReader(raw)).toBeUndefined();
  });
});

describe("where it was paid, from the currency (18 Oct 2026)", () => {
  it("an unknown shop charged in baht is counted in Thailand, and says why", () => {
    const { a, w } = why("EXAMPLE STALL THB 250.00", "EXAMPLE STALL");
    expect(a).toMatchObject({ basis: "estimated", country: "TH", evidence: "currency", clue: "THB" });
    expect(text(w)).toMatch(/amount in Thai baht, Thailand's currency/);
  });
  it("reads well for countries whose names end in s", () => {
    const { w } = why("EXAMPLE DINER USD 18.00", "EXAMPLE DINER");
    expect(text(w)).toMatch(/US dollars, the United States' currency/);
  });
});

describe("attribute(): local independents", () => {
  it("a card-reader payment to a name we don't know is a local independent, counted where it was paid", () => {
    const { a, w } = why("SQ *THE BEAN HOUSE", "THE BEAN HOUSE");
    expect(a).toMatchObject({ basis: "independent", country: "GB", independent: { kind: "card_reader", prefix: "SQ", provider: "Square" } });
    expect(w.label).toBe("Local independent");
    expect(text(w)).toMatch(/Square card reader/);
    expect(text(w)).toMatch(/paid at home in the United Kingdom/);
  });
  it("a chain paid through a card reader is still the chain", () => {
    const { a } = why("SQ *TESCO STORES 3142", "TESCO STORES");
    expect(a).toMatchObject({ basis: "owner", country: "GB" });
  });
  it("named like a local business (CAFE, BARBERS)", () => {
    const { a, w } = why("MARIOS CAFE");
    expect(a).toMatchObject({ basis: "independent", independent: { kind: "keyword", word: "CAFE" } });
    expect(text(w)).toMatch(/contains “CAFE”/);
  });
  it("our look-up said it's a small local business", () => {
    const { a, w } = why("THE BEAN HOUSE", "THE BEAN HOUSE", { ...DEFAULT_CONTEXT, locals: { "THE BEAN HOUSE": "2026-10-17" } });
    expect(a).toMatchObject({ basis: "independent", independent: { kind: "lookup" } });
    expect(text(w)).toMatch(/AI step \(Mistral\) found a small local business rather than a chain, and no owner that a register or a web search confirms/);
    // whether a web search checked it, or when the app asks again
    const web = explain({ a, payee: "THE BEAN HOUSE", home: "GB", lookupCheck: { web: true } });
    expect(text(web)).toMatch(/A web search was part of that check/);
    const later = explain({ a, payee: "THE BEAN HOUSE", home: "GB", lookupCheck: { recheck: "2026-10-21" } });
    expect(text(later)).toMatch(/hasn't been checked with a web search yet\. From 21 Oct 2026, the app asks again when you add a statement with this shop; if nobody else has asked about it by then, the full check waits until someone does\./);
    expect(text(w)).toMatch(/It wasn't checked with a web search\./);
  });
  it("paid abroad: counted where it was paid", () => {
    const { a, w } = why("SUMUP *TAVERNA SOFIA MALAGA", "TAVERNA SOFIA");
    expect(a).toMatchObject({ basis: "independent", country: "ES", evidence: "place" });
    expect(text(w)).toMatch(/town “MALAGA”, which is in Spain/);
  });
  it("estimates switched off: not counted, and not offered for the online look-up", () => {
    const { a, w } = why("SQ *THE BEAN HOUSE", "THE BEAN HOUSE", { ...DEFAULT_CONTEXT, estimate: false });
    expect(a.basis).toBeUndefined();
    expect(a.country).toBeUndefined();
    expect(a.independent).toMatchObject({ kind: "card_reader", prefix: "SQ" });
    expect(w.label).toBe("Not counted");
    expect(w.canLookUp).toBe(false);
    expect(text(w)).toMatch(/Square card reader/);
    // an unknown shop that isn't a local independent can still be looked up
    const other = why("ZZQ MADE UP TRADING", "ZZQ MADE UP TRADING", { ...DEFAULT_CONTEXT, estimate: false });
    expect(other.a).toEqual({});
    expect(other.w.canLookUp).toBe(true);
  });
  it("isn't sent to the online look-up", () => {
    const parse = {
      transactions: [
        { id: "1", date: "2026-10-01", amount: -3.2, currency: "GBP", rawPayee: "SQ *THE BEAN HOUSE", normPayee: "THE BEAN HOUSE", kind: "spend", sensitive: false },
        { id: "2", date: "2026-10-02", amount: -9, currency: "GBP", rawPayee: "ZZQ MADE UP TRADING", normPayee: "ZZQ MADE UP TRADING", kind: "spend", sensitive: false },
      ],
    } as unknown as ParseResult;
    _resetAttributionCache();
    expect(prepareStatement(parse, "i").plan.candidates).toEqual(["ZZQ MADE UP TRADING"]);
  });
  it("a name held back on one row is held back on all of them (18 Oct 2026)", () => {
    const parse = {
      transactions: [
        { id: "1", date: "2026-10-01", amount: -40, currency: "GBP", rawPayee: "PIPPA", normPayee: "PIPPA", kind: "spend", sensitive: true },
        { id: "2", date: "2026-10-08", amount: -40, currency: "GBP", rawPayee: "PIPPA 2", normPayee: "PIPPA", kind: "spend", sensitive: false },
      ],
    } as unknown as ParseResult;
    _resetAttributionCache();
    const { plan } = prepareStatement(parse, "i");
    expect(plan.candidates).toEqual([]);
    expect(plan.sensitive).toEqual(["PIPPA"]);
  });
});

describe("explain(): owners", () => {
  it("built-in list: what matched, who owns it, how we know, sources and date", () => {
    const { w } = why("TESCO STORES 3142 DARTFORD", "TESCO STORES");
    expect(w.headline).toBe("Tesco is owned by Tesco PLC, run from the United Kingdom.");
    expect(w.label).toBe("From official registers");
    expect(text(w)).toMatch(/contains “TESCO STORES”, a name Tesco uses/);
    expect(text(w)).toMatch(/Global LEI register/);
    expect(w.chain.map((h) => h.role)).toEqual(["Brand", "Top owner"]);
    expect(w.sources.length).toBeGreaterThan(0);
    expect(w.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("our own research says an AI helped, and whether a report backs it", () => {
    let { w } = why("ASDA SUPERSTORE 4123", "ASDA SUPERSTORE");
    expect(w.label).toBe("AI-assisted research");
    expect(text(w)).toMatch(/Researched with an AI's help.*reports linked below/);
    expect(text(w)).toMatch(/A person hasn't checked it yet/);
    ({ w } = why("CO-OP FOOD 2211", "CO-OP FOOD"));
    expect(w.label).toBe("AI-assisted research");
    expect(text(w)).toMatch(/don't have a report to link to yet/);
  });
  it("franchises say we count the brand owner", () => {
    const { w } = why("MCDONALDS 1234 LEWISHAM", "MCDONALDS");
    expect(w.country).toBe("US");
    expect(text(w)).toMatch(/Franchise: .*McDonald's Corporation/);
  });
  it("marketplaces count the platform", () => {
    const { w } = why("AMZNMKTPLACE AMAZON.CO.UK", "AMZNMKTPLACE AMAZON CO UK");
    expect(w.name).toBe("Amazon");
    expect(text(w)).toMatch(/also sells for other businesses.*we count Amazon itself/);
  });
  it("a payment service in front of the shop is looked through", () => {
    const { w } = why("PAYPAL *STEAMGAMES", "STEAMGAMES");
    expect(w.name).toBe("Steam");
    expect(text(w)).toMatch(/You paid through PayPal/);
  });
  it("pay-later services and Google Play are looked through too", () => {
    let { w } = why("KLARNA*ASOS", "ASOS");
    expect(w.name).toBe("ASOS");
    expect(text(w)).toMatch(/You paid through Klarna/);
    ({ w } = why("CLEARPAY*ASOS", "ASOS"));
    expect(text(w)).toMatch(/You paid through Clearpay/);
    ({ w } = why("GOOGLE *YOUTUBE", "YOUTUBE"));
    expect(text(w)).toMatch(/You paid through Google Play/);
    // …also when the bank prints words first: the shop isn't taken for the payment service
    _resetAttributionCache();
    expect(matchLocal(t("VIS KLARNA*ZZQ SHOP", "ZZQ SHOP")).status).toBe("UNRESOLVED");
    expect(matchLocal(t("CARD PAYMENT TO PAYPAL *ZZQSHOP", "ZZQSHOP")).status).toBe("UNRESOLVED");
    ({ w } = why("CARD PAYMENT TO PAYPAL *NETFLIX", "NETFLIX"));
    expect(w.name).toBe("Netflix");
    expect(text(w)).toMatch(/You paid through PayPal/);
  });
  it("online look-up answers say which source found them", () => {
    const base = { kind: "merchant" as const, aliases: ["ZZQ SHOP"], as_of: "2026-10-16", reviewed_by: null, reviewed_at: null, sources: [{ label: "Companies House 00000000", url: "https://find-and-update.company-information.service.gov.uk/company/00000000" }] };
    const ch: OwnershipEntry = { ...base, id: "lookup-zzq-shop", display_name: "Zzq Shop", chain: [{ name: "ZZQ SHOP LIMITED", relation: "operator", country: "GB", source: "companies_house" }, { name: "Zzq Holdings Inc", relation: "ultimate_parent", country: "US", source: "companies_house" }], owner_country: "US", tier: "NAME_MATCH", technique: "Found by exact name in the UK company register (Companies House); owner from its 'persons with significant control' filings." };
    const ctx = { ...DEFAULT_CONTEXT, lookups: { "ZZQ SHOP": ch } };
    let { w } = why("ZZQ SHOP", "ZZQ SHOP", ctx);
    expect(w.label).toBe("From the UK company register");
    expect(text(w)).toMatch(/sent just the name “ZZQ SHOP”/);
    expect(w.chain.map((h) => h.role)).toEqual(["Run in the UK by", "Top owner"]);
    const ai: OwnershipEntry = { ...ch, tier: "LLM_GUESS", technique: "AI estimate by Mistral (mistral-medium-latest), checked with a web search; the owner's country matches Wikidata/GLEIF. Not checked by a person." };
    ({ w } = why("ZZQ SHOP", "ZZQ SHOP", { ...DEFAULT_CONTEXT, lookups: { "ZZQ SHOP": ai } }));
    expect(w.label).toBe("AI estimate");
    expect(text(w)).toMatch(/web search/);
    expect(text(w)).toMatch(/matches the public registers/);
  });
  it("register answers say what GLEIF found: the company at the top, nothing above it, or nothing filed", () => {
    const e = (technique: string): OwnershipEntry => ({ id: "lookup-zzq", display_name: "Zzq", kind: "merchant", aliases: ["ZZQ"], chain: [{ name: "Zzq", relation: "brand_of", country: "FR", source: "wikidata" }, { name: "Zzq Group", relation: "ultimate_parent", country: "FR", source: "gleif" }], owner_country: "FR", tier: "EXACT_ID", technique, sources: [], as_of: "2026-10-16", reviewed_by: null, reviewed_at: null });
    const say = (technique: string) => text(why("ZZQ", "ZZQ", { ...DEFAULT_CONTEXT, lookups: { ZZQ: e(technique) } }).w);
    expect(say("Wikidata ownership chain to LEI 1; GLEIF's filed ultimate parent (Zzq Group, LEI 2) completes it.")).toMatch(/names the company at the top, which completes the chain/);
    expect(say("Wikidata ownership chain, and GLEIF (LEI 1) agrees the top company has no parent above it (no parent filed).")).toMatch(/has no parent filed for the company at the top/);
    expect(say("Wikidata ownership chain, and GLEIF (LEI 1) agrees the top company has no parent above it (is its own ultimate parent).")).toMatch(/records that no other company sits above the company at the top/);
    expect(say("Wikidata ownership chain, and GLEIF (LEI 1) agrees the top company has no parent above it (natural persons).")).toMatch(/owned by people, not by another company/);
    expect(say("Wikidata ownership chain, and GLEIF (LEI 1) agrees the top company has no parent above it (non consolidating).")).toMatch(/records an exception \(“non consolidating”\), so one may exist but isn't reported/);
  });
  it("an owner Wikidata has no English name for reads as words, not an id", () => {
    const e: OwnershipEntry = { id: "lookup-zzq", display_name: "Zzq Tea", kind: "merchant", aliases: ["ZZQ TEA"], chain: [{ name: "Zzq Tea", relation: "brand_of", country: "TW", source: "wikidata" }, { name: "Q66196430", relation: "ultimate_parent", country: "TW", source: "wikidata" }], owner_country: "TW", tier: "NAME_MATCH", technique: "t", sources: [], as_of: "2026-10-16", reviewed_by: null, reviewed_at: null };
    const { w } = why("ZZQ TEA", "ZZQ TEA", { ...DEFAULT_CONTEXT, lookups: { "ZZQ TEA": e } });
    expect(w.headline).toBe("Zzq Tea is owned by a company Wikidata lists without an English name, run from Taiwan.");
    expect(w.chain[1]!.name).not.toMatch(/^Q\d+$/);
  });
  it("an AI answer still to get its web check says when the app asks again", () => {
    const e: OwnershipEntry = { id: "lookup-zzq", display_name: "Zzq", kind: "merchant", aliases: ["ZZQ"], chain: [{ name: "Zzq Holdings", relation: "ultimate_parent", country: "IE", source: "llm" }], owner_country: "IE", tier: "LLM_GUESS", technique: "AI estimate by Mistral (mistral-large-4): 4 of 5 answers agree. Not checked by a person.", sources: [], as_of: "2026-10-18", reviewed_by: null, reviewed_at: null };
    const a = attribute(t("ZZQ"), { ...DEFAULT_CONTEXT, lookups: { ZZQ: e } });
    expect(text(explain({ a, payee: "ZZQ", home: "GB", lookupCheck: { recheck: "2026-10-22" } }))).toMatch(/From 22 Oct 2026, the app asks again when you add a statement with this shop/);
    expect(text(explain({ a, payee: "ZZQ", home: "GB" }))).not.toMatch(/ask again/);
    expect(text(explain({ a, payee: "ZZQ", home: "GB" }))).toMatch(/It wasn't checked with a web search\./);
    const sure = { ...e, technique: "AI estimate by Mistral (mistral-large-4): 5 of 5 answers agree; the owner's country matches Wikidata/GLEIF. Not checked by a person." };
    const a2 = attribute(t("ZZQ"), { ...DEFAULT_CONTEXT, lookups: { ZZQ: sure } });
    expect(text(explain({ a: a2, payee: "ZZQ", home: "GB" }))).toMatch(/no web search: all the answers agreed, and the registers confirm the owner/);
    // a web search ran but couldn't confirm it: said so, not "wasn't checked"
    const tried = { ...e, technique: "AI estimate by Mistral (mistral-large-4): 4 of 5 answers agree; a web search couldn't confirm it. Not checked by a person." };
    const a3 = attribute(t("ZZQ"), { ...DEFAULT_CONTEXT, lookups: { ZZQ: tried } });
    const w3 = text(explain({ a: a3, payee: "ZZQ", home: "GB" }));
    expect(w3).toMatch(/A web search couldn't confirm it/);
    expect(w3).not.toMatch(/wasn't checked with a web search|looked the business up with a web search/);
  });
  it("holding companies: registered in one place, run from another", () => {
    const e: OwnershipEntry = { id: "lookup-zzq", display_name: "Zzq", kind: "merchant", aliases: ["ZZQ"], chain: [{ name: "Zzq", relation: "brand_of", country: "US", source: "wikidata" }, { name: "Zzq Group Ltd", relation: "ultimate_parent", country: "US", legal_country: "BM", source: "gleif" }], owner_country: "US", legal_country: "BM", tier: "EXACT_ID", technique: "t", sources: [], as_of: "2026-10-16", reviewed_by: null, reviewed_at: null };
    const { w } = why("ZZQ", "ZZQ", { ...DEFAULT_CONTEXT, lookups: { ZZQ: e } });
    expect(text(w)).toMatch(/registered in Bermuda but run from the United States/);
    expect(w.chain[1]).toMatchObject({ legal: "BM" });
  });
});

describe("explain(): estimates and your own choices", () => {
  it("estimated: says why and where", () => {
    const { w } = why("ZZQ MADE UP TRADING");
    expect(w.label).toBe("Estimated");
    expect(w.canLookUp).toBe(true);
    expect(text(w)).toMatch(/hasn't been looked up online/);
    const missed = explain({ a: attribute(t("ZZQ MADE UP TRADING"), DEFAULT_CONTEXT), payee: "ZZQ MADE UP TRADING", home: "GB", lookupMissed: true });
    expect(missed.canLookUp).toBe(false);
    expect(text(missed)).toMatch(/couldn't find who owns it/);
  });
  it("your choice wins, and shows what we'd have said", () => {
    const { w } = why("TESCO STORES", "TESCO STORES", { ...DEFAULT_CONTEXT, overrides: { "TESCO STORES": "IE" } });
    expect(w).toMatchObject({ level: "you", country: "IE" });
    expect(text(w)).toMatch(/Our own answer was the United Kingdom/);
  });
  it("country names read well in a sentence", () => {
    expect(["GB", "US", "NL", "IM", "KY", "DE"].map(theCountry)).toEqual(["the United Kingdom", "the United States", "the Netherlands", "the Isle of Man", "the Cayman Islands", "Germany"]);
  });
});
