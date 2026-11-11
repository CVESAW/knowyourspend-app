import { headerSet, type BankDefinition } from "./format";

/**
 * Starling. Header verbatim (business sample, Oct 2019, starling2kashflow):
 * Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP)
 * Personal exports reportedly append `Spending Category,Notes` (UNCONFIRMED) — extra columns are
 * ignored. Some files carry a `,Opening Balance,,,,0.00` row, which the parser skips.
 * `Counter Party` is Starling's enriched merchant name.
 */
export const starling: BankDefinition = {
  id: "starling",
  name: "Starling",
  confidence: "confirmed",
  source: "awemous/starling2kashflow README; mafonso/starling2freeagent README",
  match: (h) => {
    const s = headerSet(h);
    return s.has("counter party") && (s.has("amount (gbp)") || s.has("amount")) && s.has("date");
  },
  columns: {
    date: "Date",
    description: "Reference",
    payee: "Counter Party",
    amount: ["Amount (GBP)", "Amount"],
    balance: ["Balance (GBP)", "Balance"],
    type: "Type",
    category: "Spending Category",
  },
  dateOrder: "DMY",
  defaultCurrency: "GBP",
};
