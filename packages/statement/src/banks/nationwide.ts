import { hasAll, type BankDefinition } from "./format";

/**
 * Nationwide. 2014 sample (Graham Haley): a 3-line preamble
 *   Account Name:,Flexaccount ****12345 / Account Balance:,£0.00 / Available Balance: £0.00
 * then a blank line, then
 *   Date,Transaction type,Description,Paid out,Paid in,Balance
 * Dates `29-Dec-14`; newer exports reportedly use `29 Dec 2024` (UNCONFIRMED — both parse).
 * Amounts carry a £ prefix and are split into Paid out / Paid in. Often Windows-1252 encoded.
 */
export const nationwide: BankDefinition = {
  id: "nationwide",
  name: "Nationwide",
  confidence: "confirmed",
  source: "grahamhaley.co.uk Account Tracker CSV tutorial (2015); JoelLefkowitz/nationwide README",
  match: (h, lines) =>
    hasAll(h, ["date", "description", "paid out", "paid in"]) &&
    (hasAll(h, ["transaction type"]) || lines.some((l) => /^\W*account name:/i.test(l))),
  columns: {
    date: "Date",
    description: "Description",
    paidOut: "Paid out",
    paidIn: "Paid in",
    balance: "Balance",
    type: "Transaction type",
  },
  dateOrder: "DMY",
  defaultCurrency: "GBP",
};
