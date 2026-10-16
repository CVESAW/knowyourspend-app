import { hasAll, type BankDefinition } from "./format";

/**
 * Wise (formerly TransferWise). Columns (Dativery):
 * TransferWise ID, Date, Amount, Currency, Description, Payment Reference, Running Balance,
 * Exchange From, Exchange To, Exchange Rate, Payer Name, Payee Name, Payee Account Number,
 * Merchant, Card Last Four Digits, Card Holder Full Name, Attachment, Note, Total fees
 * One file per currency balance; dates `DD-MM-YYYY`; `Amount` signed.
 * The ID prefix (CARD-, TRANSFER-, BALANCE-, …) is used as the type label (prefix convention is
 * widely seen but UNCONFIRMED). Payee preference: Merchant, then the counterparty name.
 */
export const wise: BankDefinition = {
  id: "wise",
  name: "Wise",
  confidence: "confirmed",
  source: "dativery.com Wise CSV integration; beancount.io Wise preset",
  match: (h) => hasAll(h, ["transferwise id", "amount", "currency", "description"]),
  columns: {
    date: "Date",
    description: "Description",
    payee: "Merchant",
    amount: "Amount",
    currency: "Currency",
    balance: "Running Balance",
    sourceId: "TransferWise ID",
  },
  dateOrder: "DMY",
  defaultCurrency: "GBP",
  transform(rec, get) {
    const prefix = /^([A-Z_]+)-/.exec(get("TransferWise ID").toUpperCase())?.[1];
    const out = { ...rec };
    if (prefix) out.typeLabel = prefix;
    if (!get("Merchant")) {
      // Counterparty: who we paid, or who paid us. Never the account holder themselves.
      const other = rec.amount < 0 ? get("Payee Name") : get("Payer Name");
      if (other) out.payee = other;
    }
    return out;
  },
};
