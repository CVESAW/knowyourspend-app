import { describe, expect, it } from "vitest";
import { classify, looksLikePerson, mayBePerson, typeHint, UK_TYPE_CODES } from "../src/index";

describe("UK_TYPE_CODES", () => {
  it("includes the full Lloyds Banking Group list with meanings", () => {
    const lbg = ["BGC", "BNS", "BP", "CHG", "CHQ", "COM", "COR", "CPT", "CSH", "CSQ", "DD", "DEB", "DEP", "EFT", "EUR", "FE", "FEE", "FPC", "FPI", "FPO", "IB", "INT", "MPI", "MPO", "MTG", "NS", "NSC", "OTH", "PAY", "PSB", "PSV", "SAL", "SPB", "SO", "STK", "TD", "TDG", "TDI", "TDN", "TFR", "UT", "SUR"];
    for (const c of lbg) expect(UK_TYPE_CODES[c], c).toMatchObject({ meaning: expect.any(String), source: "LBG" });
    expect(UK_TYPE_CODES.CPT!.meaning).toBe("Cashpoint");
    expect(UK_TYPE_CODES["S/O"]!.hint).toBe("bill");
  });
  it("maps spelled-out labels from neobanks", () => {
    expect(typeHint("Card payment")).toBe("card");
    expect(typeHint("CARD_PAYMENT")).toBe("card");
    expect(typeHint("CARD_REFUND")).toBe("refund");
    expect(typeHint("Pot transfer")).toBe("internal");
    expect(typeHint("Faster payment")).toBe("transfer");
    expect(typeHint("Direct debit")).toBe("dd");
    expect(typeHint("Contactless Card Purchase")).toBe("card");
    expect(typeHint("TOPUP")).toBe("internal");
    expect(typeHint("INTEREST PAYMENT")).toBe("income");
  });
});

describe("looksLikePerson", () => {
  it.each(["D STEPHENS 18MAY19", "J SMITH", "Jane Smith", "MR J A SMITH", "To JOHN SMITH", "Max Mustermann"])("%s → person", (s) => {
    expect(looksLikePerson(s)).toBe(true);
  });
  it.each(["COSTA COFFEE", "OCTOPUS ENERGY LTD", "PRET A MANGER", "NETFLIX", "THAMES WATER", "TESCO STORES", "ACME WIDGETS LTD"])("%s → not a person", (s) => {
    expect(looksLikePerson(s)).toBe(false);
  });
});

describe("classify", () => {
  const c = (amount: number, rawPayee: string, typeLabel?: string, rawDescription?: string) => classify({ amount, rawPayee, typeLabel, rawDescription });

  it("card payments are spend, positive card rows are refunds", () => {
    expect(c(-3.4, "COSTA COFFEE", "DEB")).toBe("spend");
    expect(c(-3.4, "COSTA COFFEE", "Card payment")).toBe("spend");
    expect(c(12, "AMAZON", "CARD_PAYMENT")).toBe("refund");
    expect(c(12, "AMAZON", "REV")).toBe("refund");
  });
  it("direct debits and bill payments to organisations are spend", () => {
    expect(c(-35, "THAMES WATER", "DD")).toBe("spend");
    expect(c(-60, "BRITISH GAS", "Direct debit")).toBe("spend");
    expect(c(-20, "COUNCIL TAX", "SO")).toBe("spend");
  });
  it("payments to people are transfers (never sent)", () => {
    expect(c(-50, "D STEPHENS 18MAY19", "TFR")).toBe("transfer");
    expect(c(-100, "J SMITH", "FPO")).toBe("transfer");
    expect(c(-650, "M JONES RENT", "SO")).toBe("transfer");
    expect(c(-25, "Jane Smith", "Faster payment")).toBe("transfer");
    expect(c(-30, "To JOHN SMITH", "TRANSFER")).toBe("transfer");
    expect(c(-500, "STANDING ORDER VIA FASTER PAYMENT TO J SMITH REFERENCE RENT")).toBe("transfer");
    expect(c(-50, "J SMITH")).toBe("transfer"); // no type column at all
  });
  it("is conservative about Faster Payments: spend only with an organisation marker", () => {
    expect(c(-20, "OCTOPUS ENERGY LTD", "FPO")).toBe("spend");
    expect(c(-20, "GREENFIELD", "FPO")).toBe("transfer");
    expect(c(-20, "RIVERSIDE LETTINGS", "FPO")).toBe("spend");
  });
  it("cash, income, internal and fees", () => {
    expect(c(-40, "LINK ATM", "CPT")).toBe("cash");
    expect(c(-40, "Cash withdrawal", "Card payment")).toBe("cash");
    expect(c(-40, "HSBC ATM 08MAR")).toBe("cash");
    expect(c(2500, "ACME WIDGETS LTD", "BGC")).toBe("income");
    expect(c(2500, "ACME WIDGETS LTD", "SAL")).toBe("income");
    expect(c(20, "J SMITH", "FPI")).toBe("income");
    expect(c(-100, "Holiday", "Pot transfer")).toBe("internal");
    expect(c(-100, "To Savings")).toBe("internal");
    expect(c(200, "Top-Up by *1234", "TOPUP")).toBe("internal");
    expect(c(-50, "REVOLUT**1234*", "DEB")).toBe("spend"); // card-typed stays spend…
    expect(c(-50, "REVOLUT", "FPO")).toBe("internal"); // …but a transfer to an e-money wallet is own money
    expect(c(-250, "BARCLAYCARD", "DD")).toBe("internal"); // credit card repayment
    expect(c(-3, "ACCOUNT FEE", "CHG")).toBe("fee");
    expect(c(-1, "Revolut fee", "FEE")).toBe("fee");
    expect(c(-5, "NON-STERLING TRANSACTION FEE")).toBe("fee");
  });
  it("uses descriptor prefixes when there is no type column", () => {
    expect(c(-4.4, "CARD PAYMENT TO STAGECOACH BUS,4.40 GBP")).toBe("spend");
    expect(c(-30, "DIRECT DEBIT PAYMENT TO VODAFONE LTD")).toBe("spend");
    expect(c(-12.3, "TESCO STORES 3456 )))")).toBe("spend");
    expect(c(-9.99, "NETFLIX")).toBe("spend");
    expect(c(-9.99, "UNKNOWN THING")).toBe("transfer");
  });
  it("zero amounts are unknown", () => expect(c(0, "TESCO", "DEB")).toBe("unknown"));

  it("reads first direct and HSBC PDF codes (18 Oct 2026)", () => {
    expect(typeHint("MAS")).toBe("card");
    expect(typeHint("OBP")).toBe("bill");
    expect(c(-23.45, "TESCO STORES 3456", "MAS")).toBe("spend");
    expect(c(50, "EXAMPLE OUTDOORS", "MAS")).toBe("refund");
    expect(c(-120, "EXAMPLE COUNCIL", "OBP", "EXAMPLE COUNCIL COUNCIL TAX")).toBe("spend");
  });

  it("money paid to yourself is not spending: savers and investment platforms (18 Oct 2026)", () => {
    expect(c(-200, "MONTHLY SAVER", "TFR")).toBe("internal");
    expect(c(-200, "REGULAR SAVER", "BP")).toBe("internal");
    expect(c(-500, "FREETRADE", "MOS")).toBe("internal");
    expect(c(-500, "To Nutmeg", "BP")).toBe("internal");
    expect(c(-100, "VANGUARD", "DD")).toBe("internal");
    expect(c(-100, "VANGUARD ISA 12345678", "DD")).toBe("internal");
    expect(c(-50, "Trading 212 UK Ltd", "Card payment")).toBe("internal"); // a card top-up is still your own money
    // bank words, codes, dates, towns and references round the platform's name
    expect(c(-100, "VANGUARD ISA DDR", "DD")).toBe("internal");
    expect(c(-100, "HARGREAVES LANSDOWN DDR", "DD")).toBe("internal");
    expect(c(-100, "FREETRADE ON 01 AUG BCC", "DEB")).toBe("internal");
    expect(c(-100, "DIRECT DEBIT PAYMENT TO VANGUARD REF 12345678")).toBe("internal");
    expect(c(-4.4, "CARD PAYMENT TO FREETRADE,4.40 GBP, RATE 1.00/GBP ON 01-03-2018")).toBe("internal");
    expect(c(-50, "FREETRADE LONDON GB", "DEB")).toBe("internal");
    expect(c(-50, "ETORO MONEY", "FPO")).toBe("internal");
  });
  it("…but not a shop whose name starts the same, or a shop called a saver", () => {
    expect(c(-30, "NUTMEG INDIAN RESTAURANT", "DEB")).toBe("spend");
    expect(c(-40, "VANGUARD SELF STORAGE", "DD")).toBe("spend");
    expect(c(-5, "EASY SAVER", "DEB")).toBe("spend");
    expect(c(-5, "EASY SAVER")).not.toBe("internal"); // no type column: can't tell it's a savings account
    expect(c(-40, "VANGUARD SERVICES LTD", "DD")).toBe("spend");
  });

  it("a card payment through someone's monzo.me link goes to a person (18 Oct 2026)", () => {
    expect(c(-12, "MONZO* ME A FRIEND", "MAS", "MONZO* ME A FRIEND LONDON")).toBe("transfer");
    expect(c(-12, "MONZO.ME/AFRIEND", "Card payment")).toBe("transfer");
    expect(c(-12, "MONZO", "DEB")).toBe("spend"); // a card payment to Monzo itself is still a payment
  });
});

describe("mayBePerson", () => {
  const p = (rawPayee: string, typeLabel?: string, rawDescription?: string) => mayBePerson({ amount: -20, rawPayee, typeLabel, rawDescription });
  it("one plain word paid by bill payment or transfer may be a person: held back from the look-up", () => {
    expect(p("PIPPA", "BP")).toBe(true);
    // the name as it would be sent: a date or a number after it doesn't make it a business
    expect(p("PIPPA 18AUG26", "BP")).toBe(true);
    expect(p("PIPPA 1234", "BP")).toBe(true);
    expect(p("PIPPA 12/08/26", "BP")).toBe(true);
    expect(p("PIPPA 12/08", "SO")).toBe(true);
    expect(p("PIPPA 1234/5678", "BP")).toBe(true);
    expect(p("PIPPA REF: RENT/JULY", "BP")).toBe(true);
    expect(p("PIPPA.", "BP")).toBe(true);
    expect(p("MRS. SMITH", "SO")).toBe(true);
    expect(p("DR. PATEL", "BP")).toBe(true);
    expect(p("To BOB", "MOS")).toBe(true);
    expect(p("ZENOTEC", "BP")).toBe(true); // may be a business, but nothing says so: held back to be safe
  });
  it("card payments, direct debits, brands, organisation words and names with digits are businesses", () => {
    expect(p("PIPPA", "MAS")).toBe(false);
    expect(p("NETFLIX", "DD")).toBe(false);
    expect(p("TESCO", "BP")).toBe(false);
    expect(p("ACME LTD", "BP")).toBe(false);
    expect(p("SHOP24", "BP")).toBe(false);
    expect(p("SHOP.COM", "BP")).toBe(false);
    expect(p("EXAMPLE SUPPLIES", "BP")).toBe(false); // two words: looksLikePerson decides those
  });
});
