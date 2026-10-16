/**
 * @kys/statement — browser-only bank statement parser, normaliser and classifier.
 *
 * Privacy boundary: of everything this package produces, only `normPayee` of rows the user
 * approves (spend, not sensitive) may leave the device. `sendablePayees` computes that list.
 */
export type {
  BankFormat,
  ColumnMapping,
  LocalTransaction,
  ParseResult,
  TransactionKind,
} from "./types";

export { decodeFile, detectBank, guessMapping, parseStatement, parseWithMapping, sniffDelimiter } from "./parse";
export type { ParseOptions } from "./parse";

export { normalisePayee, BANK_PREFIXES, PLACE_NAMES, MAX_PAYEE_LENGTH } from "./normalise";

export { classify, looksLikePerson, typeHint, UK_TYPE_CODES, COMMON_BRANDS } from "./classify";
export type { ClassifyInput, TypeCodeInfo, TypeHint } from "./classify";

export {
  isSensitive,
  sensitiveCategory,
  SENSITIVE_KEYWORDS,
  SENSITIVE_EXACT,
  SENSITIVE_CATEGORY_LABELS,
} from "./sensitive";
export type { SensitiveCategory } from "./sensitive";

export { transactionId, mergeTransactions, fnv1a64, OccurrenceCounter } from "./dedupe";
export type { MergeResult } from "./dedupe";

export { BANKS, SUPPORTED_BANKS, getBank } from "./registry";
export type { BankDefinition, ColumnSpec, ColumnRef, RawRecord, MatchContext } from "./banks/format";

export { parseAmount, parseDate, guessDateOrder } from "./values";
export type { DateOrder, ParsedAmount } from "./values";

import type { LocalTransaction } from "./types";

/**
 * The exact, deduplicated list of strings that may be sent to `/api/resolve`: normalised payees
 * of spend/refund rows that are not sensitive and not excluded by the user. Sorted, so request
 * order reveals nothing about transaction order.
 */
export function sendablePayees(transactions: readonly LocalTransaction[], excluded: ReadonlySet<string> = new Set()): string[] {
  const out = new Set<string>();
  for (const t of transactions) {
    if ((t.kind === "spend" || t.kind === "refund") && !t.sensitive && t.normPayee && !excluded.has(t.normPayee)) {
      out.add(t.normPayee);
    }
  }
  return [...out].sort();
}
