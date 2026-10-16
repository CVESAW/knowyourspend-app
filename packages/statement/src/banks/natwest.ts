import { hasAll, type BankDefinition } from "./format";

/**
 * NatWest Group (NatWest, RBS, Ulster). Column names from MSE forum (2021, 2023):
 * Date, Type, Description, Value, Balance, Account Name, Account Number
 * (exact spelling/leading spaces not confirmed — headers are matched trimmed and case-insensitively).
 * One signed `Value` column. Account name/number are never read.
 * Descriptions are commonly like `'4298 11JAN19 , TESCO STORES 2468 , LONDON GB` — the normaliser
 * strips the leading apostrophe and card/date prefix.
 */
export const natwest: BankDefinition = {
  id: "natwest",
  name: "NatWest / RBS",
  confidence: "confirmed",
  source: "MoneySavingExpert forum threads 6297815 (2021) and 6477826 (2023)",
  match: (h) => hasAll(h, ["date", "type", "description", "value", "balance", "account number"]),
  columns: {
    date: "Date",
    description: "Description",
    amount: "Value",
    balance: "Balance",
    type: "Type",
  },
  dateOrder: "DMY",
  defaultCurrency: "GBP",
};
