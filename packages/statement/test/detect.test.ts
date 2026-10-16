import { describe, expect, it } from "vitest";
import { detectBank, SUPPORTED_BANKS } from "../src/index";
import { fixtureText, parseFixture } from "./helpers";

const CASES: [file: string, id: string, confidence: "confirmed" | "unconfirmed", count: number][] = [
  ["monzo.csv", "monzo", "confirmed", 14],
  ["starling.csv", "starling", "confirmed", 10],
  ["revolut.csv", "revolut", "confirmed", 9], // 8 completed rows + 1 fee row
  ["lloyds.csv", "lloyds", "confirmed", 12],
  ["barclays.csv", "barclays", "confirmed", 8],
  ["nationwide.csv", "nationwide", "confirmed", 8],
  ["nationwide-2014.csv", "nationwide", "confirmed", 2],
  ["natwest.csv", "natwest", "confirmed", 6],
  ["santander.txt", "santander", "confirmed", 5],
  ["hsbc.csv", "hsbc", "unconfirmed", 8],
  ["wise.csv", "wise", "confirmed", 5],
  ["n26-new.csv", "n26", "confirmed", 5],
  ["n26-old.csv", "n26-legacy", "confirmed", 3],
  ["amex.csv", "amex", "unconfirmed", 5],
  ["chase-uk-statement.csv", "chase-uk", "unconfirmed", 3],
];

describe("bank detection", () => {
  it.each(CASES)("%s → %s (%s)", async (file, id, confidence, count) => {
    const r = await parseFixture(file);
    expect(r.needsMapping).toBe(false);
    expect(r.bank).toEqual({ id, name: expect.any(String), confidence });
    expect(r.transactions).toHaveLength(count);
    expect(detectBank(fixtureText(file), file)?.id).toBe(id);
  });

  it("returns a structured-cloneable bank object (no functions) for Web Worker postMessage", async () => {
    const r = await parseFixture("monzo.csv");
    expect(() => structuredClone(r)).not.toThrow();
    expect(Object.keys(r.bank!).sort()).toEqual(["confidence", "id", "name"]);
  });

  it("does not detect Chase UK without the filename hint", async () => {
    expect(detectBank(fixtureText("chase-uk-statement.csv"))).toBeNull();
  });

  it("lists every supported bank with a confidence level", () => {
    const ids = SUPPORTED_BANKS.map((b) => b.id);
    expect(ids).toEqual(
      expect.arrayContaining(["monzo", "starling", "revolut", "lloyds", "barclays", "nationwide", "natwest", "santander", "hsbc", "wise", "chase-uk", "amex", "n26", "n26-legacy"]),
    );
    for (const b of SUPPORTED_BANKS) expect(["confirmed", "unconfirmed"]).toContain(b.confidence);
    expect(SUPPORTED_BANKS.find((b) => b.id === "hsbc")!.confidence).toBe("unconfirmed");
  });

  it("unknown formats need a mapping", async () => {
    for (const f of ["unknown-semicolon.csv", "unknown-ambiguous.csv", "unknown-headerless-tab.tsv"]) {
      const r = await parseFixture(f);
      expect(r.bank).toBeNull();
      expect(r.needsMapping).toBe(true);
      expect(r.transactions).toEqual([]);
    }
  });
});
