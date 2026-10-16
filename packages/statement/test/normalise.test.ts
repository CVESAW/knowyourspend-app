import { describe, expect, it } from "vitest";
import { MAX_PAYEE_LENGTH, normalisePayee } from "../src/index";
import golden from "./fixtures/normalise-golden.json";

const cases = golden as { raw: string; expected: string }[];

describe("normalisePayee golden cases (shared with backend/services/normalise.py)", () => {
  it("has at least 60 cases", () => expect(cases.length).toBeGreaterThanOrEqual(60));
  it.each(cases.map((c) => [c.raw, c.expected]))("%j → %j", (raw, expected) => {
    expect(normalisePayee(raw)).toBe(expected);
  });
});

describe("normalisePayee invariants", () => {
  it("is idempotent on every golden case", () => {
    for (const { raw } of cases) {
      const once = normalisePayee(raw);
      expect(normalisePayee(once), raw).toBe(once);
    }
  });

  it("is idempotent, bounded and uppercase on generated descriptors", () => {
    // Deterministic pseudo-random combinations of real-world fragments.
    const parts = [
      "CARD PAYMENT TO", "DD", "SQ *", "PAYPAL *", "TESCO STORES", "3456", "LONDON", "GB", "ON 12 MAR", "*1234",
      "AMAZON.CO.UK*AB12CD34E", "UBER *TRIP", "HELP.UBER.COM", "18MAY19", "REF 123456789", "SE10 9AA", "UNITED KINGDOM",
      ",4.40 GBP, RATE 1.00/GBP ON 01-03-2018", ")))", "COSTA COFFEE", "  ", "\t", "CAFÉ", "O'NEILLS", "12.50", "&", "-",
      "AIR", "FRANCE", "BANK OF", "IRELAND", "7-ELEVEN", "EC1A", "X", "A VERY LONG MERCHANT NAME INDEED FOR TRUNCATION",
    ];
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 3000; i++) {
      const n = 1 + Math.floor(rand() * 6);
      const raw = Array.from({ length: n }, () => parts[Math.floor(rand() * parts.length)]).join(" ");
      const once = normalisePayee(raw);
      expect(normalisePayee(once), raw).toBe(once);
      expect(once.length).toBeLessThanOrEqual(MAX_PAYEE_LENGTH);
      expect(once).toBe(once.toUpperCase());
      expect(once).not.toMatch(/\s{2}|^\s|\s$/);
    }
  });

  it("never returns empty for non-blank input, and '' for blank input", () => {
    expect(normalisePayee("LONDON GB")).not.toBe("");
    expect(normalisePayee("   ")).toBe("");
  });

  it("maps store-number variants of one chain to one key (the cache-miss problem)", () => {
    expect(normalisePayee("TESCO STORES 3456 LONDON")).toBe(normalisePayee("TESCO STORES 8901 MANCHESTER GB"));
  });
});
