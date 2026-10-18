import { describe, expect, it } from "vitest";
import { breakdown, contributions } from "../src/aggregate";
import { DEFAULT_CONTEXT } from "../src/attribute";
import { entryById } from "../src/ownership";
import type { Disclosure, Item, ReceiptLine, StoredTransaction } from "../src/types";

const off: Disclosure = { mode: "off", sent: [], notSent: [], sensitiveHeld: [], recognisedLocally: 0, transfersExcluded: 0, rowsRead: 0 };
const tx = (id: string, amount: number, entryId: string | undefined, date = "2026-09-10", kind: StoredTransaction["kind"] = amount < 0 ? "spend" : "refund"): StoredTransaction => ({
  id, itemId: "s1", date, amount, currency: "GBP", rawPayee: entryId ?? "LOCAL CAFE", normPayee: entryId ?? "LOCAL CAFE", kind, sensitive: false, entryId, resolution: entryId ? "RESOLVED" : "UNRESOLVED",
});
const statement: Item = { id: "s1", kind: "statement", title: "Monzo statement", createdAt: "2026-09-20T00:00:00Z", disclosure: off };
const receipt = (total: number, date = "2026-09-11"): Item => ({ id: "r1", kind: "receipt", title: "Tesco receipt", createdAt: "2026-09-20T00:00:00Z", disclosure: off, receipt: { storeEntryId: "tesco", storeText: "Tesco", date, total } });
const line = (id: string, price: number | undefined, entryId?: string): ReceiptLine => ({ id, itemId: "r1", text: id, price, entryId, included: true });

describe("contributions", () => {
  it("counts a statement payment under the shop's owner", () => {
    const { list } = contributions([statement], [tx("t1", -20, "tesco")], []);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ entryId: "tesco", country: entryById("tesco")!.owner_country, amount: 20 });
  });

  it("splits a matched card payment into brands instead of counting the receipt twice", () => {
    const { list } = contributions([statement, receipt(10)], [tx("t1", -10, "tesco")], [line("COKE", 2, "coca-cola"), line("MILK", 1)]);
    const total = list.reduce((s, c) => s + c.amount, 0);
    expect(total).toBeCloseTo(10);
    expect(list.find((c) => c.entryId === "coca-cola")?.amount).toBeCloseTo(2);
    expect(list.find((c) => c.entryId === "tesco")?.amount).toBeCloseTo(8);
  });

  it("does not match a receipt more than 3 days from the payment", () => {
    const { list } = contributions([statement, receipt(10, "2026-09-20")], [tx("t1", -10, "tesco")], [line("COKE", 2, "coca-cola")]);
    expect(list.reduce((s, c) => s + c.amount, 0)).toBeCloseTo(20);
  });

  it("gives unpriced brand lines a fair share of what's unaccounted for", () => {
    const { list } = contributions([receipt(9)], [], [line("COKE", 3, "coca-cola"), line("BEANZ", undefined, "heinz")]);
    // 6 unaccounted, one unpriced brand line → it gets 6 / 2 = 3; the rest (3) stays with the shop
    expect(list.find((c) => c.entryId === "heinz")?.amount).toBeCloseTo(3);
    expect(list.find((c) => c.entryId === "tesco")?.amount).toBeCloseTo(3);
  });

  it("scales line prices down when they add up to more than the total", () => {
    const { list } = contributions([receipt(5)], [], [line("COKE", 4, "coca-cola"), line("BEANZ", 6, "heinz")]);
    expect(list.reduce((s, c) => s + c.amount, 0)).toBeCloseTo(5);
    expect(list.find((c) => c.entryId === "coca-cola")?.amount).toBeCloseTo(2);
  });

  it("nets refunds and leaves other currencies out", () => {
    const eur = { ...tx("t3", -50, "tesco"), currency: "EUR" };
    const { list, otherCurrency } = contributions([statement], [tx("t1", -30, "tesco"), tx("t2", 10, "tesco"), eur], []);
    expect(otherCurrency).toBe(1);
    expect(list.reduce((s, c) => s + c.amount, 0)).toBeCloseTo(20);
  });
});

describe("breakdown", () => {
  it("shares add up to 1 and unmatched spend is kept out of them", () => {
    const { list } = contributions([statement], [tx("t1", -40, "tesco"), tx("t2", -60, "coca-cola"), tx("t3", -25, undefined)], []);
    const b = breakdown(list);
    expect(b.countries.reduce((s, c) => s + c.share, 0)).toBeCloseTo(1);
    expect(b.unmatchedSpend).toBeCloseTo(25);
    expect(b.scores.identified).toBeCloseTo(100 / 125);
  });

  it("each row keeps a payee behind it, so 'Why this country?' can open for rows you set yourself (18 Oct 2026)", () => {
    const tesco = { ...tx("t1", -40, "tesco"), normPayee: "TESCO STORES", rawPayee: "TESCO STORES 3142" };
    const ctx = { ...DEFAULT_CONTEXT, overrides: { "TESCO STORES": "IE" } };
    const { list } = contributions([statement], [tesco, tx("t2", -10, undefined)], [], ctx);
    const rows = breakdown(list).countries.flatMap((c) => c.entries);
    // the row is keyed by the brand's name ("you:Tesco"), but carries the payee to explain it with
    expect(rows.find((r) => r.basis === "you")).toMatchObject({ entryId: "you:Tesco", payee: "TESCO STORES" });
    expect(rows.find((r) => r.name === "LOCAL CAFE")).toMatchObject({ basis: "independent", payee: "LOCAL CAFE" });
  });

  it("a receipt matched to a payment carries that payment's payee for the shop part", () => {
    const unknown: Item = { ...receipt(10), receipt: { storeText: "ZZQ DELI", date: "2026-09-11", total: 10 } };
    const { list } = contributions([statement, unknown], [tx("t1", -10, undefined)], [line("COKE", 2, "coca-cola")], DEFAULT_CONTEXT);
    // not matched (no known store), so it's counted on its own, with no payee
    expect(list.filter((c) => c.source === "receipt" && !c.entryId?.startsWith("coca")).every((c) => !c.payee)).toBe(true);
    const { list: matched } = contributions([statement, receipt(10)], [tx("t1", -10, "tesco")], [line("COKE", 2, "coca-cola")], DEFAULT_CONTEXT);
    expect(matched.find((c) => c.entryId === "tesco")?.payee).toBe("tesco");
  });
});
