import { hasAll, type BankDefinition } from "./format";

/**
 * Lloyds Banking Group: Lloyds, Halifax, Bank of Scotland (same online platform; the Halifax/BoS
 * header being byte-identical is UNCONFIRMED, so they share this one fingerprint and cannot be
 * told apart). Header verbatim (firefly-iii #2290):
 * Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance
 * Unsigned split debit/credit amounts; `Transaction Type` is the LBG code (DEB, DD, FPO, TFR, CPT…).
 * Sort code and account number are never read.
 */
export const lloyds: BankDefinition = {
  id: "lloyds",
  name: "Lloyds / Halifax / Bank of Scotland",
  confidence: "confirmed",
  source: "firefly-iii issue #2290; ggirtsou/lloyds README; Bank of Scotland payment codes",
  match: (h) =>
    hasAll(h, ["transaction date", "transaction type", "transaction description", "debit amount", "credit amount"]),
  columns: {
    date: "Transaction Date",
    description: "Transaction Description",
    paidOut: "Debit Amount",
    paidIn: "Credit Amount",
    balance: "Balance",
    type: "Transaction Type",
  },
  dateOrder: "DMY",
  defaultCurrency: "GBP",
};
