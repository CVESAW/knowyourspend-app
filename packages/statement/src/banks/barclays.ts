import { hasAll, type BankDefinition } from "./format";

/**
 * Barclays. Header verbatim (natalian.org 2010; still described identically by beancount.io 2026):
 * Number,Date,Account,Amount,Subcategory,Memo
 * Quirks handled by the generic parser: Memo is padded with spaces/tabs, commas inside Memo are
 * NOT quoted (row has 7+ fields — the extras are re-joined into Memo), whole-pound amounts have
 * no decimal point. `Subcategory` is the type (Direct Debit, Contactless Card Purchase, OTH…).
 * `Account` (sort code + account number) is never read.
 */
export const barclays: BankDefinition = {
  id: "barclays",
  name: "Barclays",
  confidence: "confirmed",
  source: "natalian.org Barclays CSV export; beancount.io Barclays preset",
  match: (h) => hasAll(h, ["number", "date", "account", "amount", "subcategory", "memo"]),
  columns: {
    date: "Date",
    description: "Memo",
    amount: "Amount",
    type: "Subcategory",
  },
  dateOrder: "DMY",
  defaultCurrency: "GBP",
};
