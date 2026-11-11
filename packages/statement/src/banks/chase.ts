import { hasAll, hasAny, type BankDefinition } from "./format";

/**
 * Chase UK — UNCONFIRMED. Chase UK support says statements can be exported as CSV. The header below
 * comes from two open-source importers' samples, not from a file we exported (beancount.io's "Chase"
 * preset is US Chase and must not be used). Columns are guessed by `guessMapping`, day-first dates.
 */
export const chaseUk: BankDefinition = {
  id: "chase-uk",
  name: "Chase UK",
  confidence: "unconfirmed",
  source: "chase.co.uk statements support page; header from two open-source importers' samples (Oct 2026)",
  // Header seen in two open-source importers' Chase UK samples (Oct 2026):
  //   Date,Time,Transaction Type,(Transaction) Description,Amount,Currency,Balance
  // Otherwise only when the file name says "chase".
  match: (h, _lines, ctx) =>
    (hasAll(h, ["date", "time", "transaction type", "amount", "currency", "balance"]) && hasAny(h, ["description", "transaction description"])) ||
    (/chase/i.test(ctx.filename ?? "") && h.filter((x) => x.trim()).length >= 3),
  columns: "auto",
  dateOrder: "DMY",
  defaultCurrency: "GBP",
};
