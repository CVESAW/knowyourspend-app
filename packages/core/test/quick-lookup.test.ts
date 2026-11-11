import { describe, expect, it } from "vitest";
import type { OwnershipEntry } from "@kys/ownership";
import { lookUpLocally, lookupUnavailable, MAX_QUERY, pageWording, readQuery, withAnswer, type QuickResult } from "../src/quick-lookup";

const local = (text: string, home = "GB") => lookUpLocally(readQuery(text, home));
const allLines = (r: QuickResult) => [r.why?.headline ?? "", ...(r.why?.sections ?? []).flatMap((s) => [s.heading, ...s.lines])];
/** Words that only make sense inside the app: the search page must never show them. */
const APP_WORDS = /\bthe app\b|\bSettings\b|your bank's text|Your bank printed|Counted as|add a statement/i;

const entry = (over: Partial<OwnershipEntry> = {}): OwnershipEntry => ({
  id: "lookup-obscure-widgets",
  display_name: "Obscure Widgets",
  kind: "merchant",
  aliases: [],
  chain: [
    { name: "Obscure Widgets Ltd", relation: "brand_of", country: "GB", source: "companies_house" },
    { name: "Widget Holdings SE", relation: "ultimate_parent", country: "DE", source: "gleif" },
  ],
  owner_country: "DE",
  tier: "EXACT_ID",
  technique: "Found in Wikidata and GLEIF",
  sources: [{ label: "GLEIF record", url: "https://search.gleif.org/" }],
  as_of: "2026-10-20",
  reviewed_by: null,
  reviewed_at: null,
  ...over,
});

describe("readQuery", () => {
  it("tidies spaces, cuts long text and cleans the name like a statement payee", () => {
    const q = readQuery("  CARD PAYMENT TO   TESCO STORES 2041 ON 12 OCT ");
    expect(q.text).toBe("CARD PAYMENT TO TESCO STORES 2041 ON 12 OCT");
    expect(q.name).toBe("TESCO STORES");
    expect(q.home).toBe("GB");
    expect(readQuery("x".repeat(500)).text).toHaveLength(MAX_QUERY);
  });
  it("only accepts a two-letter country", () => {
    expect(readQuery("Lidl", "de").home).toBe("DE");
    expect(readQuery("Lidl", "Germany").home).toBe("GB");
    expect(readQuery("", "GB").name).toBe("");
  });
});

describe("lookUpLocally (built-in list, nothing sent)", () => {
  it("names the owner of a statement line, with the chain and sources", () => {
    const r = local("COSTA COFFEE 43012 LONDON GB");
    expect(r.status).toBe("owner");
    expect(r.canAsk).toBe(false);
    expect(r.why?.headline).toBe("Costa Coffee is owned by The Coca-Cola Company, run from the United States.");
    expect(r.why?.chain.map((h) => h.country)).toEqual(["GB", "US"]);
    expect(r.why?.sources.length).toBeGreaterThan(0);
    expect(r.why?.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("looks through payment services to the shop", () => {
    expect(local("PAYPAL *NETFLIX").why?.name).toBe("Netflix");
    expect(local("VIS KLARNA*ZARA").why?.chain.at(-1)?.country).toBe("ES");
    expect(allLines(local("PAYPAL *NETFLIX")).join(" ")).toContain("PayPal puts its name before the shop's.");
  });
  it("reads bank shorthand and run-together names", () => {
    expect(local("AMZN MKTP UK*2X4AB12C3").why?.name).toBe("Amazon");
    expect(local("JDSPORTS").why?.name).toBe("JD Sports");
  });
  it("treats a card-reader payment to an unknown name as a local independent, and never sends it", () => {
    const r = local("SQ *THE BEAN HOUSE");
    expect(r.status).toBe("local");
    expect(r.canAsk).toBe(false);
    expect(r.why?.chain).toEqual([]);
    expect(r.why?.headline).toBe("This looks like a local independent business.");
  });
  it("holds back names that look like a person, but lets the searcher choose", () => {
    const r = local("J SMITH");
    expect(r).toMatchObject({ status: "person", canAsk: false, askAnyway: true });
  });
  it("holds back a PayPal payment or bill payment that could be to a person, as the statement reader does", () => {
    expect(local("PAYPAL *JOHNSMITH")).toMatchObject({ status: "person", canAsk: false, askAnyway: true });
    expect(local("CARD PAYMENT TO PAYPAL *SARAHJONES 35314369001 GBR")).toMatchObject({ status: "person", canAsk: false });
    expect(local("BP PIPPA")).toMatchObject({ status: "person", canAsk: false, askAnyway: true }); // BP = bill payment, not the fuel company
    expect(local("BP CONNECT LEEDS").status).toBe("owner");
    expect(local("VIS BP WESTWAY").status).toBe("owner");
    expect(local("BP 1234 LEEDS").status).toBe("owner");
    expect(local("PAYPAL *NETFLIX").status).toBe("owner");
  });
  it("never sends a transfer, cash or a move between your own accounts, and says what it looks like", () => {
    for (const line of ["FASTER PAYMENT TO JOHN SMITH REF RENT", "STO JANE DOE RENT", "BGC J BLOGGS", "MONZO.ME/JOHNSMITH", "CASH WITHDRAWAL", "LINK ATM 12", "VANGUARD ISA", "TRANSFER FROM SAVINGS", "INTEREST PAID"]) {
      const r = local(line);
      expect(r.canAsk, line).toBe(false);
      expect(["not_shop", "person"], line).toContain(r.status);
    }
    expect(local("CASH WITHDRAWAL").why?.sections[0]?.lines[0]).toContain("cash withdrawal");
  });
  it("holds back a person's name after words like TRANSFER TO that the reader doesn't know", () => {
    expect(local("BANK TRANSFER TO DAVID JONES")).toMatchObject({ status: "person", canAsk: false });
    expect(local("ONLINE PAYMENT TO J SMITH")).toMatchObject({ canAsk: false });
  });
  it("matcher slips found on the site (11 Nov 2026)", () => {
    expect(local("LLOYDS PHARMACY").why?.headline ?? "").not.toContain("Lloyds Bank");
    expect(local("MOSS AND STONE INTERIORS")).toMatchObject({ status: "unknown", canAsk: true });
    expect(local("MUELLER HANDELS GMBH")).toMatchObject({ status: "unknown", canAsk: true });
  });
  it("holds back sensitive names before the person rule", () => {
    const r = local("MARIE STOPES");
    expect(r).toMatchObject({ status: "sensitive", canAsk: false, askAnyway: true });
  });
  it("offers the online look-up for a business name it doesn't know", () => {
    const r = local("WWW.ZALANDO.CO.UK");
    expect(r).toMatchObject({ status: "unknown", canAsk: true });
    expect(r.query.name).toBe("ZALANDO");
  });
  it("returns nothing to show for empty text", () => {
    expect(local("   ")).toMatchObject({ status: "empty", canAsk: false });
  });
});

describe("withAnswer (after the online look-up)", () => {
  const q = readQuery("OBSCURE WIDGETS LTD");
  it("explains an owner the look-up found, saying exactly what was sent", () => {
    const r = withAnswer(q, { query: q.name, status: "RESOLVED", entry: entry(), trace: [{ step: "wikidata+gleif", status: "found", detail: "Found." }] });
    expect(r.status).toBe("owner");
    expect(r.why?.headline).toBe("Obscure Widgets is owned by Widget Holdings SE, run from Germany.");
    expect(allLines(r).join(" ")).toContain(`this page sent just the name “${q.name}” to our online look-up (nothing else about you)`);
    expect(r.steps).toHaveLength(1);
  });
  it("says when an answer hasn't had its full check", () => {
    const r = withAnswer(q, { query: q.name, status: "RESOLVED", entry: entry({ tier: "LLM_GUESS", technique: "AI vote" }), trace: [], recheck_after: "2026-10-25" });
    expect(r.status).toBe("owner");
    expect(allLines(r).some((l) => /That full check runs when someone asks about this name again, from/.test(l))).toBe(true);
  });
  it("shows a local business the look-up found", () => {
    const lq = readQuery("HAWTHORN AND RYE BAKEHOUSE");
    const r = withAnswer(lq, { query: lq.name, status: "LOCAL_BUSINESS", trace: [], checked: "web" });
    expect(r.status).toBe("local");
    expect(allLines(r).join(" ")).toContain("A web search was part of that check.");
  });
  it("says when it isn't a business, or when nothing was found", () => {
    expect(withAnswer(q, { query: q.name, status: "NOT_A_BUSINESS", trace: [] }).status).toBe("not_business");
    const miss = withAnswer(q, { query: q.name, status: "UNRESOLVED", trace: [{ step: "ai", status: "not_found", detail: "No owner." }] });
    expect(miss).toMatchObject({ status: "unknown", canAsk: false });
    expect(miss.retry).toBeUndefined();
    expect(miss.why?.headline).toBe("We couldn't find who owns this.");
  });
  it("marks a look-up that failed part-way as worth trying again", () => {
    const r = withAnswer(q, { query: q.name, status: "UNRESOLVED", trace: [{ step: "ai", status: "error", detail: "Paused." }] });
    expect(r).toMatchObject({ status: "unknown", retry: true });
  });
  it("still lets the built-in list win", () => {
    const tq = readQuery("TESCO STORES 2041");
    expect(withAnswer(tq, { query: tq.name, status: "UNRESOLVED", trace: [] }).why?.name).toBe("Tesco");
  });
});

describe("page wording", () => {
  const samples = [
    "COSTA COFFEE 43012 LONDON GB", "PAYPAL *NETFLIX", "AMZN MKTP UK*2X4AB12C3", "SQ *THE BEAN HOUSE", "SUMUP *MARKET STALL",
    "Boots", "J SMITH", "MARIE STOPES", "VIS KLARNA*ZARA", "CARD PAYMENT TO TESCO STORES 2041 ON 12 OCT", "SAINSBURRYS",
    "JDSPORTS", "WWW.ZALANDO.CO.UK", "APPLE.COM/BILL", "Pret A Manger", "Cadbury", "Lidl", "ALDI 123 LEEDS", "THE CORNER CAFE",
  ];
  it("never shows app-only wording, whatever the answer", () => {
    const results = [
      ...samples.map((s) => local(s)),
      withAnswer(readQuery("OBSCURE WIDGETS"), { query: "OBSCURE WIDGETS", status: "RESOLVED", entry: entry(), trace: [], recheck_after: "2026-10-25" }),
      withAnswer(readQuery("HAWTHORN AND RYE"), { query: "HAWTHORN AND RYE", status: "LOCAL_BUSINESS", trace: [], recheck_after: "2026-10-25" }),
      withAnswer(readQuery("SOMETHING"), { query: "SOMETHING", status: "NOT_A_BUSINESS", trace: [] }),
      ...(["offline", "paused", "busy", "error"] as const).map((r) => lookupUnavailable(readQuery("ZALANDO"), r)),
    ];
    for (const r of results) for (const line of allLines(r)) expect(line, `${r.query.text}: ${line}`).not.toMatch(APP_WORDS);
  });
  it("rewrites each app phrase it knows", () => {
    expect(pageWording("Your bank printed “JDSPORTS” with the spaces missing, as banks often do.")).toBe("“JDSPORTS” is written with the spaces missing, as banks often do.");
    expect(pageWording("You paid through Klarna, which puts its name before the shop's. We looked through it to the shop you paid.")).toBe("Klarna puts its name before the shop's. We looked through it to the shop.");
  });
});
