import type { BankDefinition } from "./format";

/**
 * Chase UK — UNCONFIRMED. Chase UK support says statements can be exported as CSV, but no header
 * was sourced (beancount.io's "Chase" preset is US Chase and must not be used). Matched only when
 * the file name says "chase"; columns are then guessed by `guessMapping` with day-first dates.
 */
export const chaseUk: BankDefinition = {
  id: "chase-uk",
  name: "Chase UK",
  confidence: "unconfirmed",
  source: "chase.co.uk statements support page (no header sourced)",
  match: (h, _lines, ctx) => /chase/i.test(ctx.filename ?? "") && h.filter((x) => x.trim()).length >= 3,
  columns: "auto",
  dateOrder: "DMY",
  defaultCurrency: "GBP",
};
