import { hasAll, headerSet, type BankDefinition } from "./format";

/**
 * N26 — two English header generations (siddhantgoel/beancount-n26):
 * Old: Date, Payee, Account number, Transaction type, Payment reference, [Category], Amount (EUR),
 *      Amount (Foreign Currency), Type Foreign Currency, Exchange Rate
 * New: Booking Date, Value Date, Partner Name, Partner Iban, Type, Payment Reference, [Category],
 *      Account Name, Amount (EUR), Original Amount, Original Currency, Exchange Rate
 * ISO dates. German/French localised headers exist but are not fingerprinted (generic mapper).
 * EU bank: see report §12.9 (Art 27 representative) before promoting.
 */
export const n26New: BankDefinition = {
  id: "n26",
  name: "N26",
  confidence: "confirmed",
  source: "siddhantgoel/beancount-n26 __init__.py",
  match: (h) => hasAll(h, ["booking date", "partner name", "type"]) && hasAmountEur(h),
  columns: {
    date: "Booking Date",
    description: "Payment Reference",
    payee: "Partner Name",
    amount: ["Amount (EUR)", "Amount (GBP)", "Amount"],
    type: "Type",
    category: "Category",
  },
  dateOrder: "YMD",
  defaultCurrency: "EUR",
};

export const n26Old: BankDefinition = {
  id: "n26-legacy",
  name: "N26 (legacy export)",
  confidence: "confirmed",
  source: "siddhantgoel/beancount-n26 __init__.py",
  match: (h) => hasAll(h, ["date", "payee", "transaction type"]) && hasAmountEur(h),
  columns: {
    date: "Date",
    description: "Payment reference",
    payee: "Payee",
    amount: ["Amount (EUR)", "Amount"],
    type: "Transaction type",
    category: "Category",
  },
  dateOrder: "YMD",
  defaultCurrency: "EUR",
};

function hasAmountEur(h: string[]): boolean {
  const s = headerSet(h);
  return s.has("amount (eur)") || s.has("amount (gbp)");
}
