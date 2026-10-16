import { hasAll, hasAny, type BankDefinition } from "./format";

/**
 * American Express UK — UNCONFIRMED. The documented headers are US-oriented (jmcameron/amex2qif):
 * Date, Description, Amount, Extended Details, Appears On Your Statement As, Address, City/State,
 * Zip Code, Country, Reference, Category — a UK variant with Town/City and Postcode is assumed.
 * Charges are exported POSITIVE and payments negative, so the sign is inverted. Dates assumed
 * day-first for UK accounts. No currency column (foreign charges are pre-converted).
 */
export const amex: BankDefinition = {
  id: "amex",
  name: "American Express (UK)",
  confidence: "unconfirmed",
  source: "jmcameron/amex2qif README (US layout); beancount.io Amex preset",
  match: (h) =>
    hasAll(h, ["date", "description", "amount"]) &&
    hasAny(h, ["appears on your statement as", "extended details", "card member"]),
  columns: {
    date: "Date",
    description: ["Appears On Your Statement As", "Description"],
    payee: "Description",
    amount: "Amount",
    category: "Category",
  },
  invertSign: true,
  dateOrder: "DMY",
  defaultCurrency: "GBP",
  transform(rec) {
    // Everything on a card statement is a card transaction except repayments of the card itself.
    const text = `${rec.payee} ${rec.description}`.toUpperCase();
    if (/PAYMENT RECEIVED|THANK YOU|DIRECT DEBIT PAYMENT/.test(text)) return { ...rec, typeLabel: "PAYMENT RECEIVED", kind: "internal" };
    return { ...rec, typeLabel: rec.typeLabel ?? "CARD" };
  },
};
