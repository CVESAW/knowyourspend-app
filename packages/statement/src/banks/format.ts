/**
 * The fingerprint object each supported bank export is described by.
 *
 * A bank is (mostly) data: which header names identify it, which columns hold what, how to read
 * its dates and amounts. Two escape hatches exist for genuinely odd formats: `parseText` (for a
 * non-CSV file such as Santander's key:value .txt) and `transform` (per-row fix-ups).
 */
import type { BankFormat, TransactionKind } from "../types";
import type { DateOrder } from "../values";
import { headerKey } from "../values";

/** A column reference: header name(s) (case-insensitive) or a 0-based index for headerless files. */
export type ColumnRef = string | number | ReadonlyArray<string | number>;

export interface ColumnSpec {
  date: ColumnRef;
  /** The raw descriptor. Always required. */
  description: ColumnRef;
  /**
   * Bank-cleaned counterparty/merchant name columns, tried in order. The first non-empty one
   * becomes `rawPayee`; otherwise `description` is used.
   */
  payee?: ColumnRef;
  amount?: ColumnRef;
  paidOut?: ColumnRef;
  paidIn?: ColumnRef;
  balance?: ColumnRef;
  currency?: ColumnRef;
  type?: ColumnRef;
  category?: ColumnRef;
  /** Bank's own transaction ID (Monzo, Wise). Stored as `sourceId`; not used for dedupe. */
  sourceId?: ColumnRef;
  /** Row status (Revolut `State`); rows whose status is not in `acceptStates` are skipped. */
  state?: ColumnRef;
  /** Separate fee column (Revolut). A non-zero fee is emitted as its own "fee" transaction. */
  fee?: ColumnRef;
}

/** Context available to `match`. */
export interface MatchContext {
  filename?: string;
}

/** One row after column resolution, before it becomes a LocalTransaction. */
export interface RawRecord {
  date: string;
  description: string;
  payee: string;
  amount: number;
  currency?: string;
  balance?: number;
  typeLabel?: string;
  category?: string;
  sourceId?: string;
  /** Force a kind (used sparingly by `transform`). */
  kind?: TransactionKind;
}

export interface BankDefinition extends BankFormat {
  /** Where the confidence claim comes from (shown in README / debug UI). */
  source: string;
  /**
   * Fingerprint. `headers` is a candidate header row (raw cells), `firstLines` are the first ~20
   * raw text lines of the file (for preamble checks).
   */
  match(headers: string[], firstLines: string[], ctx: MatchContext): boolean;
  /** Column mapping. "auto" = use `guessMapping` on the file (generic-ish unconfirmed formats). */
  columns: ColumnSpec | "auto";
  /** Numeric date order, bound to the bank — never guessed from the data. */
  dateOrder: DateOrder;
  defaultCurrency: string;
  /** Charges exported as positive numbers (card issuers such as Amex). */
  invertSign?: boolean;
  /** File has no header row; the matched row is data and `displayHeaders` is shown instead. */
  headerless?: boolean;
  displayHeaders?: string[];
  /** Accepted values of the `state` column (uppercase). */
  acceptStates?: string[];
  /** Non-CSV formats: turn the whole text into a header + rows table. */
  parseText?(text: string): { headers: string[]; rows: string[][] };
  /**
   * Per-row fix-up. `get(header)` returns that column's trimmed cell ("" if absent).
   * Return a string to skip the row with that reason.
   */
  transform?(rec: RawRecord, get: (header: string) => string): RawRecord | string;
}

/** Helpers for writing `match` functions. */
export function headerSet(headers: string[]): Set<string> {
  return new Set(headers.map(headerKey).filter(Boolean));
}

export function hasAll(headers: string[], names: string[]): boolean {
  const set = headerSet(headers);
  return names.every((n) => set.has(n.toLowerCase()));
}

export function hasAny(headers: string[], names: string[]): boolean {
  const set = headerSet(headers);
  return names.some((n) => set.has(n.toLowerCase()));
}

/** Strip function members so the result can cross a Web Worker boundary (structured clone). */
export function toBankFormat(def: BankDefinition): BankFormat {
  return { id: def.id, name: def.name, confidence: def.confidence };
}
