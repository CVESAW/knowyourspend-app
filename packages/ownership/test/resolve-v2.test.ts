import { describe, expect, it } from "vitest";
import { allEntries, checkedEntries, cleanPayee, createResolver, domainsIn, openBrands, tradesIn } from "../src/index";

const r = createResolver(allEntries);
const id = (s: string, country?: string) => r.resolve(s, country ? { country } : undefined).entry?.id;

describe("clean-up", () => {
  it("drops store numbers and references, expands bank shorthand", () => {
    expect(cleanPayee("TESCO STORES 2041")).toBe("TESCO");
    expect(cleanPayee("AMZN MKTP UK AB12CD34E")).toBe("AMAZON MARKETPLACE");
    expect(cleanPayee("SAINSBURY S MKT")).toBe("SAINSBURYS S MKT");
    expect(cleanPayee("7 ELEVEN 1234")).toBe("7 ELEVEN");
  });
  it("finds web domains in raw text", () => {
    expect(domainsIn("WWW.ZALANDO.CO.UK")).toEqual(["zalando.co.uk"]);
    expect(domainsIn("UBER *TRIP HELP.UBER.COM")).toEqual(["uber.com"]);
    expect(domainsIn("TESCO STORES 2041")).toEqual([]);
  });
});

describe("matching v2", () => {
  it("run-together names", () => {
    expect(r.resolve("TOBYCARVERY BEXLEY").method).toBe("joined");
    expect(r.resolve("TOBYCARVERY BEXLEY").matched_alias).toBe("TOBY CARVERY");
  });
  it("one letter off, long names only, first letter must agree", () => {
    const res = r.resolve("WAITROSSE 812");
    expect(res.entry?.id).toBe("waitrose");
    expect(res.method).toBe("near");
    expect(id("XAITROSE")).toBeUndefined();
  });
  it("a near-miss never beats a real match", () => {
    expect(r.resolve("TESCO STORES").method).toBe("exact");
  });
  it("records alias, method and cleaned text", () => {
    const res = r.resolve("TESCO STORES 2041");
    expect(res).toMatchObject({ status: "RESOLVED", matched_alias: "TESCO STORES", method: "exact" });
  });
  it("finds many more chains from the open brand list", () => {
    expect(openBrands.length).toBeGreaterThan(5000);
    for (const s of ["GREGGS PLC 3301", "SCREWFIX DIRECT", "HOBBYCRAFT 0042", "TOOLSTATION 0211", "ZIZZI GREENWICH"]) expect(id(s), s).toBeDefined();
  });
  it("everyday-word brand names only match at the start", () => {
    const strictOnes = openBrands.filter((e) => e.strict_aliases?.length);
    expect(strictOnes.length).toBeGreaterThan(50);
  });
  it("brands that only trade abroad only match payments made there", () => {
    expect(tradesIn(["fi"])).toEqual(["FI"]);
    expect(tradesIn(["gb", "fi"])).toBeNull();
    expect(tradesIn(["001"])).toBeNull();
    expect(id("ABC NEWSAGENTS")).toBeUndefined();
    expect(r.resolve("ABC HELSINKI", { country: "FI" }).entry?.owner_country).toBe("FI");
  });
  it("the hand-checked list wins over generated brands", () => {
    const ids = new Set(checkedEntries.map((e) => e.id));
    expect(ids.has(r.resolve("TESCO").entry!.id)).toBe(true);
    expect(ids.has(r.resolve("COSTA COFFEE").entry!.id)).toBe(true);
  });
  it("reviewed corrections replace stale Wikidata owners", () => {
    const schuh = openBrands.find((e) => e.display_name === "Schuh");
    expect(schuh?.owner_country).toBe("US");
    expect(schuh?.tier).toBe("LLM_GUESS");
  });
  it("receipt-style resolver can be exact-only", () => {
    const strict = createResolver(checkedEntries, { fuzzy: false });
    expect(strict.resolve("WAITROSSE 812").entry).toBeUndefined();
  });
  it("drops generated brands that matched the wrong business on real statements (18 Oct 2026)", () => {
    // PUMA is the sportswear brand, not Puma Energy (no UK fuel stations), which won the tie by name before
    expect(r.resolve("PUMA 1234 LONDON").entry?.display_name).toBe("Puma");
    expect(r.resolve("PUMA 1234 LONDON").entry?.owner_country).toBe("DE");
    // METRO, CASA and EL RINCON start the names of railways, restaurants and bars more often than these chains
    expect(r.resolve("METRO DE LISBOA", { country: "PT" }).entry).toBeUndefined();
    // …but their full names still match where they trade
    expect(r.resolve("PUMA ENERGY 1234", { country: "ZA" }).entry?.display_name).toBe("Puma Energy");
    expect(r.resolve("METRO CASH & CARRY", { country: "DE" }).entry?.display_name).toBe("Metro Cash & Carry");
    expect(r.resolve("CASA LUCIA", { country: "ES" }).entry).toBeUndefined();
    expect(r.resolve("EL RINCON DE PEPE", { country: "ES" }).entry).toBeUndefined();
    expect(openBrands.some((e) => e.display_name === "Casa")).toBe(false);
  });
  it("after a word like RESTAURANTE the rest is the place's own name, not a chain (18 Oct 2026)", () => {
    expect(r.resolve("RESTAURANTE ICELAND", { country: "ES" }).entry).toBeUndefined();
    expect(r.resolve("TRATTORIA DA TESCO").entry).toBeUndefined();
    expect(r.resolve("ARGOS LTD").entry?.id).toBe("argos");
    // not after CAFE or HOTEL, which chains print before their own names
    expect(r.resolve("HOTEL IBIS LONDON").entry).toBeDefined();
    // and a chain that is itself a restaurant, café or bar still matches
    expect(r.resolve("PIZZERIA TELEPIZZA", { country: "ES" }).entry?.display_name).toBe("Telepizza");
    expect(r.resolve("RESTAURANTE FOSTERS HOLLYWOOD", { country: "ES" }).entry?.display_name).toBe("Foster's Hollywood");
    expect(r.resolve("RESTAURANT MCDONALDS").entry?.display_name).toBe("McDonald's");
    // …unless its name is an everyday phrase: this is a restaurant called La Romana, not the ice-cream chain
    expect(r.resolve("RESTAURANTE LA ROMANA", { country: "ES" }).entry).toBeUndefined();
  });
  it("reads FACEBK as Facebook (Meta)", () => {
    expect(r.resolve("FACEBK").entry?.owner_country).toBe("US");
    expect(r.resolve("FACEBK").entry?.display_name).toMatch(/Meta|Facebook/);
  });
});
