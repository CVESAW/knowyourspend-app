import { hasAll, hasAny, headerSet, type BankDefinition } from "./format";

/**
 * UK credit cards. Card exports list charges as POSITIVE numbers and repayments as negative, so these
 * all set `invertSign`. All UNCONFIRMED: the headers come from open-source importers' sample files
 * (October 2026), not from files we exported ourselves.
 */

/**
 * Barclaycard. Two layouts seen in importers' samples:
 *   Transaction Date,Posting Date,Card Number,Description,Category,Amount
 *   Card Holder Name,Account Number,Transaction Date,Merchant Name,Transaction Amount,Currency,…
 * The older headerless layout goes to the mapper.
 */
export const barclaycard: BankDefinition = {
  id: "barclaycard",
  name: "Barclaycard",
  confidence: "unconfirmed",
  source: "Open-source importers' Barclaycard sample exports (tuppence, finance-app), Oct 2026",
  match: (h) =>
    (hasAll(h, ["transaction date", "posting date", "card number", "description", "amount"]) && !hasAny(h, ["billing amount"])) ||
    (hasAny(h, ["card holder name", "cardholder name"]) && hasAll(h, ["transaction date", "merchant name"]) && hasAny(h, ["transaction amount", "amount"])),
  columns: {
    date: "Transaction Date",
    description: ["Merchant Name", "Description"],
    amount: ["Transaction Amount", "Amount"],
    currency: "Currency",
    category: "Category",
  },
  dateOrder: "DMY",
  defaultCurrency: "GBP",
  invertSign: true,
};

/** MBNA: "Transaction Date","Transaction Cleared Date","Transaction Type","Transaction Description","Transaction Amount". */
export const mbna: BankDefinition = {
  id: "mbna",
  name: "MBNA",
  confidence: "unconfirmed",
  source: "Open-source importer's MBNA sample export (finance-app), Oct 2026",
  match: (h) => hasAll(h, ["transaction date", "transaction cleared date", "transaction description", "transaction amount"]),
  columns: { date: "Transaction Date", description: "Transaction Description", amount: "Transaction Amount", type: "Transaction Type" },
  dateOrder: "DMY",
  defaultCurrency: "GBP",
  invertSign: true,
};

/**
 * Tesco Bank credit card: Transaction Date,Posting Date,Billing Amount,Merchant,Merchant City,…,
 * Debit/Credit Flag. Amounts carry a £ sign; charges are positive.
 */
export const tescoBankCard: BankDefinition = {
  id: "tesco-bank",
  name: "Tesco Bank credit card",
  confidence: "unconfirmed",
  source: "Open-source importer's Tesco Bank card sample export (countinghouse), Oct 2026",
  match: (h) => hasAll(h, ["transaction date", "billing amount", "merchant"]),
  columns: { date: "Transaction Date", description: "Merchant", amount: "Billing Amount" },
  dateOrder: "DMY",
  defaultCurrency: "GBP",
  invertSign: true,
};

/** Aqua: Date,Description,Note,Amount(GBP) — charges positive; the Note column holds the raw descriptor. */
export const aqua: BankDefinition = {
  id: "aqua",
  name: "Aqua",
  confidence: "unconfirmed",
  source: "Open-source importer's Aqua sample export (countinghouse), Oct 2026",
  match: (h) => hasAll(h, ["date", "description", "note"]) && headerSet(h).has("amount(gbp)"),
  columns: { date: "Date", description: ["Note", "Description"], payee: "Description", amount: "Amount(GBP)" },
  dateOrder: "DMY",
  defaultCurrency: "GBP",
  invertSign: true,
};

/**
 * American Express (UK) short export: Date,Description,Amount, charges positive. That header could be
 * any bank's, so it's only treated as Amex when the file is named like Amex's download ("activity.csv")
 * or mentions Amex.
 */
export const amexShort: BankDefinition = {
  id: "amex-short",
  name: "American Express (UK)",
  confidence: "unconfirmed",
  source: "Amex UK download (activity.csv) as described by open-source importers, Oct 2026",
  match: (h, _lines, ctx) => {
    const set = headerSet(h);
    return set.size === 3 && hasAll(h, ["date", "description", "amount"]) && /amex|american.?express|^activity/i.test(ctx.filename ?? "");
  },
  columns: { date: "Date", description: "Description", amount: "Amount" },
  dateOrder: "DMY",
  defaultCurrency: "GBP",
  invertSign: true,
};

/**
 * Curve's app export: Date (YYYY-MM-DD as UTC),…,Merchant,Txn Amount (Funding Card),… — spending is
 * positive. (Curve's simpler Date,Description,Amount export has signed amounts and is read by its
 * column names.)
 */
export const curve: BankDefinition = {
  id: "curve",
  name: "Curve",
  confidence: "unconfirmed",
  source: "Open-source importer's Curve app sample export (HomeAssistant-expenses-analytics), Oct 2026",
  match: (h) => hasAll(h, ["merchant", "txn amount (funding card)"]),
  columns: {
    date: "Date (YYYY-MM-DD as UTC)",
    description: "Merchant",
    amount: "Txn Amount (Funding Card)",
    currency: "Txn Currency (Funding Card)",
    category: "Category",
  },
  dateOrder: "YMD",
  defaultCurrency: "GBP",
  invertSign: true,
  // Curve Cash rewards (currency CPT) aren't money spent.
  transform: (rec, get) => (/^cpt$/i.test(get("Txn Currency (Funding Card)")) || /^curve cash\b/i.test(get("Merchant")) ? "Curve Cash reward" : rec),
};
