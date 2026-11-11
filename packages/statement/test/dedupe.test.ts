import { describe, expect, it } from "vitest";
import { fnv1a64, mergeTransactions, parseStatement, transactionId } from "../src/index";
import { fixtureText, parseFixture } from "./helpers";

describe("transactionId", () => {
  it("is deterministic and namespaced", () => {
    const a = transactionId("2025-03-01", -3.4, "Costa Coffee", undefined, 0);
    expect(a).toMatch(/^t_[0-9a-f]{16}$/);
    expect(transactionId("2025-03-01", -3.4, "Costa Coffee", undefined, 0)).toBe(a);
  });
  it("uses occurrenceIndex only when balance is missing", () => {
    expect(transactionId("2025-03-01", -3.4, "X", 10, 0)).toBe(transactionId("2025-03-01", -3.4, "X", 10, 5));
    expect(transactionId("2025-03-01", -3.4, "X", undefined, 0)).not.toBe(transactionId("2025-03-01", -3.4, "X", undefined, 1));
  });
  it("is insensitive to whitespace/case noise in rawPayee but not to amount", () => {
    expect(transactionId("2025-03-01", -3.4, "Costa  Coffee ", undefined, 0)).toBe(transactionId("2025-03-01", -3.4, "COSTA COFFEE", undefined, 0));
    expect(transactionId("2025-03-01", -3.4, "X", undefined, 0)).not.toBe(transactionId("2025-03-01", -3.41, "X", undefined, 0));
  });
  it("FNV-1a 64 matches the reference vectors", () => {
    expect(fnv1a64("")).toBe("cbf29ce484222325");
    expect(fnv1a64("a")).toBe("af63dc4c8601ec8c");
    expect(fnv1a64("foobar")).toBe("85944171f73967e8");
  });
});

describe("identical transactions and re-imports", () => {
  it("two identical coffees on one day stay two rows (no balance: Monzo)", async () => {
    const t = (await parseFixture("monzo.csv")).transactions.filter((x) => x.rawPayee === "Costa Coffee");
    expect(t).toHaveLength(2);
    expect(t[0]!.id).not.toBe(t[1]!.id);
  });
  it("two identical coffees on one day stay two rows (with balance: Starling)", async () => {
    const t = (await parseFixture("starling.csv")).transactions.filter((x) => x.rawPayee === "Costa Coffee");
    expect(new Set(t.map((x) => x.id)).size).toBe(2);
  });
  it("same-date same-amount same-payee on different days in Lloyds stay distinct", async () => {
    const t = (await parseFixture("lloyds.csv")).transactions.filter((x) => x.rawPayee === "TESCO STORES 3456");
    expect(new Set(t.map((x) => x.id)).size).toBe(2);
  });
  it("every id in every fixture is unique", async () => {
    for (const f of ["monzo.csv", "starling.csv", "revolut.csv", "lloyds.csv", "barclays.csv", "nationwide.csv", "natwest.csv", "santander.txt", "hsbc.csv", "wise.csv", "amex.csv"]) {
      const t = (await parseFixture(f)).transactions;
      expect(new Set(t.map((x) => x.id)).size, f).toBe(t.length);
    }
  });
});

describe("mergeTransactions", () => {
  it("re-importing the same file adds nothing", async () => {
    const first = (await parseFixture("monzo.csv")).transactions;
    const again = (await parseFixture("monzo.csv")).transactions;
    const m = mergeTransactions(first, again);
    expect(m).toMatchObject({ added: 0, duplicates: first.length });
    expect(m.transactions).toHaveLength(first.length);
  });

  it("an overlapping export only adds the new days, keeping both coffees once", async () => {
    const full = fixtureText("monzo.csv").split("\n");
    const header = full[0]!;
    const body = full.slice(1).filter(Boolean);
    const fileA = [header, ...body.slice(0, 8)].join("\n"); // 01/03 – 06/03
    const fileB = [header, ...body.slice(0, 3), ...body.slice(8)].join("\n"); // 01/03 again + 09/03 onwards
    const a = (await parseStatement(fileA)).transactions;
    const b = (await parseStatement(fileB)).transactions;
    const m = mergeTransactions(a, b);
    expect(m.duplicates).toBe(3); // two coffees + Pret on 01/03
    expect(m.added).toBe(body.length - 8);
    expect(m.transactions).toHaveLength(body.length);
    expect(m.transactions.filter((t) => t.rawPayee === "Costa Coffee")).toHaveLength(2);
  });

  it("an overlapping Starling export (balances) merges cleanly", async () => {
    const lines = fixtureText("starling.csv").split(/\r?\n/).filter(Boolean);
    const a = (await parseStatement(lines.slice(0, 7).join("\n"))).transactions;
    const b = (await parseStatement([lines[0], ...lines.slice(4)].join("\n"))).transactions;
    const m = mergeTransactions(a, b);
    expect(m.transactions).toHaveLength(10);
    expect(m.duplicates).toBe(3);
  });

  it("returns rows sorted by date and keeps existing rows (user edits) on conflict", () => {
    const base = { currency: "GBP", rawPayee: "X", normPayee: "X", kind: "spend" as const, sensitive: false };
    const existing = [{ ...base, id: "t_2", date: "2025-03-02", amount: -1, normPayee: "EDITED" }];
    const incoming = [
      { ...base, id: "t_2", date: "2025-03-02", amount: -1 },
      { ...base, id: "t_1", date: "2025-03-01", amount: -2 },
    ];
    const m = mergeTransactions(existing, incoming);
    expect(m.transactions.map((t) => t.id)).toEqual(["t_1", "t_2"]);
    expect(m.transactions[1]!.normPayee).toBe("EDITED");
    expect(m).toMatchObject({ added: 1, duplicates: 1 });
  });
});
