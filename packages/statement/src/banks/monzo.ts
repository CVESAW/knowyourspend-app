import { hasAll, hasAny, type BankDefinition } from "./format";

/**
 * Monzo (personal). Header verbatim from rustledger#2387:
 * Transaction ID,Date,Time,Type,Name,Emoji,Category,Amount,Currency,Local amount,Local currency,
 * Notes and #tags,Address,Receipt,Description,Category split,Money Out,Money In
 * `Name` is Monzo's cleaned merchant name; `Description` is the padded raw descriptor.
 * `Amount` is signed, in account currency. Dates day-first.
 */
export const monzo: BankDefinition = {
  id: "monzo",
  name: "Monzo",
  confidence: "confirmed",
  source: "rustledger issue #2387; beancount.io Monzo preset",
  // Some exports (and older ones) have no Emoji column; Transaction ID + Name + Amount + Local amount or
  // Category is still Monzo's layout.
  match: (h) => hasAll(h, ["transaction id", "name", "amount"]) && hasAny(h, ["emoji", "local amount", "category"]),
  columns: {
    date: "Date",
    description: "Description",
    payee: "Name",
    amount: "Amount",
    currency: "Currency",
    type: "Type",
    category: "Category",
    sourceId: "Transaction ID",
  },
  dateOrder: "DMY",
  defaultCurrency: "GBP",
};
