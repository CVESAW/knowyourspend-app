import { hasAll, type BankDefinition } from "./format";

/**
 * Revolut (post-Oct-2021 format). Columns from ofxstatement-revolut:
 * Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
 * Dates `YYYY-MM-DD HH:MM:SS`. Only COMPLETED rows are kept. `Fee` is emitted as its own row.
 * Type values: TRANSFER, CARD_PAYMENT, CARD_REFUND, TOPUP, EXCHANGE, ATM, FEE.
 * `Description` is already a clean merchant name for card payments.
 */
export const revolut: BankDefinition = {
  id: "revolut",
  name: "Revolut",
  confidence: "confirmed",
  source: "mlaitinen/ofxstatement-revolut revolut.py",
  match: (h) => hasAll(h, ["started date", "completed date", "state", "description", "amount"]),
  columns: {
    // Completed date is when money moved; fall back to started date.
    date: ["Completed Date", "Started Date"],
    description: "Description",
    amount: "Amount",
    fee: "Fee",
    currency: "Currency",
    balance: "Balance",
    type: "Type",
    state: "State",
  },
  acceptStates: ["COMPLETED"],
  dateOrder: "YMD",
  defaultCurrency: "GBP",
};
