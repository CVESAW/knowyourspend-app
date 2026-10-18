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

  it("looks through pay-later services to the shop, like PayPal (18 Oct 2026)", () => {
    expect(normalisePayee("KLARNA*ASOS")).toBe("ASOS");
    expect(normalisePayee("Klarna*ASOS.com")).toBe(normalisePayee("KLARNA *ASOS"));
    expect(normalisePayee("CLEARPAY*ASOS")).toBe("ASOS");
    expect(normalisePayee("KLARNA")).toBe("KLARNA");
    expect(normalisePayee("CLEARPAY UK")).toBe("CLEARPAY");
  });

  it("tidies forms seen on real first direct and Revolut statements (18 Oct 2026)", () => {
    // a receipt number that changes every visit: one shop, not one per visit
    expect(normalisePayee("ALDI 12345 Receipt")).toBe("ALDI");
    expect(normalisePayee("ALDI 67890 Receipt")).toBe(normalisePayee("ALDI 12345 Receipt"));
    // the name twice (the shop's own, then the card network's), but not short doubled names
    expect(normalisePayee("Hotelnet HOTELNET 55")).toBe("HOTELNET");
    expect(normalisePayee("NOM NOM")).toBe("NOM NOM");
    // a number run into the name, and zeros in front of it; a number that is the name stays
    expect(normalisePayee("HIRECO1234567890")).toBe("HIRECO");
    expect(normalisePayee("PARCELCO12345678")).toBe("PARCELCO");
    expect(normalisePayee("000*RAILFINDER")).toBe("RAILFINDER");
    expect(normalisePayee("123*REG LTD")).toBe("123 REG LTD");
    expect(normalisePayee("7-ELEVEN")).toBe("7-ELEVEN");
    // web addresses with newer endings
    expect(normalisePayee("EXAMPLE.FM")).toBe("EXAMPLE");
    expect(normalisePayee("NOTEWISE.AI")).toBe("NOTEWISE");
    // Braintree (PayPal's card payments) in front of the shop, but BT's own bills stay BT
    expect(normalisePayee("BT *THE EXAMPLE SHOP")).toBe("THE EXAMPLE SHOP");
    expect(normalisePayee("BT *MOBILE")).toBe("BT MOBILE");
    // a reference's letters don't stay behind
    expect(normalisePayee("REF1234567 TESCO")).toBe("TESCO");
    expect(normalisePayee("REFX1234567 TESCO")).toBe("TESCO");
    expect(normalisePayee("INV1234567 ACME LTD")).toBe("ACME LTD");
    expect(normalisePayee("ORDER1234567 TESCO")).toBe("TESCO");
    expect(normalisePayee("MEMBERSHIP1234567 EXAMPLE GYM")).toBe("EXAMPLE GYM");
    // "To" in front of money sent to a business, but not a name that starts with it
    expect(normalisePayee("To Example Supplies Ltd")).toBe("EXAMPLE SUPPLIES LTD");
    expect(normalisePayee("TO GO")).toBe("TO GO");
    expect(normalisePayee("TO-GO SUSHI")).toBe("TO-GO SUSHI");
    expect(normalisePayee("TOPSHOP")).toBe("TOPSHOP");
    // a day and month with no year is a date, "24/7" isn't
    expect(normalisePayee("PIPPA 12/08")).toBe("PIPPA");
    expect(normalisePayee("24/7 FITNESS")).toBe("24/7 FITNESS");
  });
});
