import { describe, expect, it } from "vitest";
import type { OwnershipEntry } from "@kys/ownership";
import { askedBefore, keepAnswers, mayLookUp, requestBody, type LookupAnswer, type LookupMemory } from "../src/lookup-plan";

// What the phone keeps about the online look-up's answers (18 Oct 2026): an answer given before its full check is
// asked about again once its day comes, and the newest answer replaces the old one. Names are made up.
const empty = (): LookupMemory => ({ overrides: {}, lookups: {}, lookupMisses: {}, lookupLocal: {}, lookupChecks: {} });
const entry = (id: string, country: string): OwnershipEntry => ({
  id, display_name: "Zzq Shop", kind: "merchant", aliases: [], chain: [{ name: "Zzq Holdings", relation: "ultimate_parent", country, source: "llm" }],
  owner_country: country, tier: "LLM_GUESS", technique: "t", sources: [], as_of: "2026-10-18", reviewed_by: null, reviewed_at: null,
});
const ok = (step = "llm") => [{ step, status: "found", detail: "" }];
const now = Date.parse("2026-10-18T12:00:00Z");

describe("mayLookUp", () => {
  it("never sends a name the user set themselves", () => {
    expect(mayLookUp("ZZQ SHOP", { ...empty(), overrides: { "ZZQ SHOP": "GB" }, lookupChecks: { "ZZQ SHOP": { recheck: "2026-10-01" } } }, now)).toBe(false);
  });
  it("doesn't ask again about an answer, unless it came before its full check and its day has come", () => {
    const m = { ...empty(), lookupLocal: { "ZZQ CAFE": "2026-10-15" }, lookups: { "ZZQ SHOP": entry("lookup-zzq", "IE") } };
    expect(mayLookUp("ZZQ CAFE", m, now)).toBe(false);
    expect(mayLookUp("ZZQ SHOP", m, now)).toBe(false);
    expect(mayLookUp("ZZQ CAFE", { ...m, lookupChecks: { "ZZQ CAFE": { recheck: "2026-10-22" } } }, now)).toBe(false);
    expect(mayLookUp("ZZQ CAFE", { ...m, lookupChecks: { "ZZQ CAFE": { recheck: "2026-10-18" } } }, now)).toBe(true);
    expect(mayLookUp("ZZQ SHOP", { ...m, lookupChecks: { "ZZQ SHOP": { recheck: "2026-10-17" } } }, now)).toBe(true);
  });
  it("waits 30 days after no answer, unless that answer is due its full check sooner", () => {
    const m = { ...empty(), lookupMisses: { "ZZQ SHOP": "2026-10-10T00:00:00Z" } };
    expect(mayLookUp("ZZQ SHOP", m, now)).toBe(false);
    expect(mayLookUp("ZZQ SHOP", m, Date.parse("2026-11-10T00:00:00Z"))).toBe(true);
    expect(mayLookUp("ZZQ SHOP", { ...m, lookupChecks: { "ZZQ SHOP": { recheck: "2026-10-13" } } }, now)).toBe(true);
  });
});

describe("keepAnswers", () => {
  const at = new Date(now);
  it("keeps an owner, a local business and a miss, with when to ask again and whether the web checked it", () => {
    const answers: [string, LookupAnswer | undefined][] = [
      ["ZZQ SHOP", { query: "ZZQ SHOP", status: "RESOLVED", entry: entry("lookup-zzq", "IE"), trace: ok(), recheck_after: "2026-10-22" }],
      ["ZZQ CAFE", { query: "ZZQ CAFE", status: "LOCAL_BUSINESS", trace: ok(), checked: "web" }],
      ["ZZQ MAYBE", { query: "ZZQ MAYBE", status: "UNRESOLVED", trace: [{ step: "llm", status: "rejected", detail: "" }] }],
    ];
    const k = keepAnswers(empty(), answers, at);
    expect(k.found).toBe(1);
    expect(k.lookups["ZZQ SHOP"]).toMatchObject({ owner_country: "IE", aliases: ["ZZQ SHOP"] });
    expect(k.lookupChecks).toEqual({ "ZZQ SHOP": { recheck: "2026-10-22" }, "ZZQ CAFE": { web: true } });
    expect(k.lookupLocal).toEqual({ "ZZQ CAFE": "2026-10-18" });
    expect(Object.keys(k.lookupMisses)).toEqual(["ZZQ MAYBE"]);
  });
  it("the newest answer replaces the old one: a first-request local answer that turns out to be a chain", () => {
    const m = { ...empty(), lookupLocal: { "ZZQ ELECTRICAL": "2026-10-15" }, lookupChecks: { "ZZQ ELECTRICAL": { recheck: "2026-10-18" } } };
    const k = keepAnswers(m, [["ZZQ ELECTRICAL", { query: "ZZQ ELECTRICAL", status: "RESOLVED", entry: entry("lookup-zzq-electrical", "FR"), trace: ok() }]], at);
    expect(k.lookups["ZZQ ELECTRICAL"]?.owner_country).toBe("FR");
    expect(k.lookupLocal["ZZQ ELECTRICAL"]).toBeUndefined();
    expect(k.lookupChecks?.["ZZQ ELECTRICAL"]).toBeUndefined();
  });
  it("an AI estimate the full check couldn't confirm is dropped for the miss", () => {
    const m = { ...empty(), lookups: { "ZZQ SHOP": entry("lookup-zzq", "IE") }, lookupChecks: { "ZZQ SHOP": { recheck: "2026-10-17" } } };
    const k = keepAnswers(m, [["ZZQ SHOP", { query: "ZZQ SHOP", status: "UNRESOLVED", trace: [{ step: "llm", status: "rejected", detail: "" }] }]], at);
    expect(k.lookups["ZZQ SHOP"]).toBeUndefined();
    expect(k.lookupMisses["ZZQ SHOP"]).toBe(at.toISOString());
  });
  it("a name that failed part-way keeps what it had, and other names are untouched", () => {
    const m = { ...empty(), lookupLocal: { "ZZQ CAFE": "2026-10-15", "ZZQ OTHER": "2026-10-01" }, lookupChecks: { "ZZQ CAFE": { recheck: "2026-10-18" } } };
    const k = keepAnswers(m, [["ZZQ CAFE", { query: "ZZQ CAFE", status: "UNRESOLVED", trace: [{ step: "llm", status: "error", detail: "out of credit" }] }], ["ZZQ GONE", undefined]], at);
    expect(k.lookupLocal).toEqual(m.lookupLocal);
    expect(k.lookupChecks).toEqual(m.lookupChecks);
    expect(k.lookupMisses).toEqual({});
  });
});

describe("asking again (18 Oct 2026)", () => {
  const at = new Date(now);
  it("the request lists names asked about before, so the look-up doesn't count this phone as someone else", () => {
    expect(JSON.parse(requestBody(["ZZQ B", "ZZQ A"]))).toEqual({ merchants: ["ZZQ A", "ZZQ B"] });
    expect(JSON.parse(requestBody(["ZZQ B", "ZZQ A"], ["ZZQ B", "NOT SENT"]))).toEqual({ merchants: ["ZZQ A", "ZZQ B"], again: ["ZZQ B"] });
    const m = { ...empty(), lookupChecks: { "ZZQ CAFE": { recheck: "2026-10-18" }, "ZZQ SHOP": { recheck: "2026-10-18", retry: true } } };
    // a retry after a failed look-up is a fresh ask, not "again"
    expect(askedBefore(["ZZQ CAFE", "ZZQ SHOP", "ZZQ NEW"], m)).toEqual(["ZZQ CAFE"]);
  });
  it("an answer asked for again that still hasn't had its full check waits 30 days before the next try", () => {
    const m = { ...empty(), lookupLocal: { "ZZQ CAFE": "2026-10-15" }, lookupChecks: { "ZZQ CAFE": { recheck: "2026-10-18" } } };
    const r: LookupAnswer = { query: "ZZQ CAFE", status: "LOCAL_BUSINESS", trace: ok(), recheck_after: "2026-10-21" };
    expect(keepAnswers(m, [["ZZQ CAFE", r]], at, ["ZZQ CAFE"]).lookupChecks?.["ZZQ CAFE"]).toEqual({ recheck: "2026-11-17" });
    // asked the first time, the look-up's own day stands
    expect(keepAnswers(empty(), [["ZZQ CAFE", r]], at).lookupChecks?.["ZZQ CAFE"]).toEqual({ recheck: "2026-10-21" });
  });
  it("an answer from a look-up that failed part-way is marked as a retry", () => {
    const r: LookupAnswer = { query: "ZZQ SHOP", status: "RESOLVED", entry: entry("lookup-zzq", "GB"), trace: [{ step: "llm", status: "error", detail: "out of credit" }], recheck_after: "2026-10-21" };
    const k = keepAnswers(empty(), [["ZZQ SHOP", r]], at);
    expect(k.lookups["ZZQ SHOP"]?.owner_country).toBe("GB");
    expect(k.lookupChecks?.["ZZQ SHOP"]).toEqual({ recheck: "2026-10-21", retry: true });
  });
});
