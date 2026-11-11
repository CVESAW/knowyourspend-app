/**
 * Transaction identity and merging across overlapping uploads.
 *
 * id = hash(date, amount, rawPayee, balance ?? occurrenceIndex)
 * - With a running balance, two identical coffees on the same day differ by balance.
 * - Without one, `occurrenceIndex` (0, 1, 2… for the Nth identical date+amount+payee triple
 *   within ONE file) keeps them apart, and re-importing an overlapping file reproduces the same
 *   indices for any day the file fully covers. (A day cut in half by an export boundary can still
 *   mis-merge; exports are whole days in practice.)
 *
 * The hash is FNV-1a 64-bit over UTF-8 — pure JS, synchronous, identical in browser, Worker and
 * Node, with no Web Crypto dependency. It is a dedupe key, not a security primitive.
 */
import type { LocalTransaction } from "./types";

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;
const encoder = new TextEncoder();

/** FNV-1a 64-bit hash of a string, as 16 lowercase hex chars. */
export function fnv1a64(input: string): string {
  let h = FNV_OFFSET;
  for (const byte of encoder.encode(input)) {
    h ^= BigInt(byte);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
}

/** Canonical key for the (date, amount, rawPayee) triple used to count occurrences. */
export function occurrenceKey(date: string, amount: number, rawPayee: string): string {
  return `${date}|${amount.toFixed(2)}|${canonicalPayee(rawPayee)}`;
}

function canonicalPayee(rawPayee: string): string {
  return rawPayee.replace(/\s+/g, " ").trim().toUpperCase();
}

/**
 * Stable transaction id. `occurrenceIndex` is only used when `balance` is missing.
 */
export function transactionId(
  date: string,
  amount: number,
  rawPayee: string,
  balance: number | undefined | null,
  occurrenceIndex: number,
): string {
  const tail = balance !== undefined && balance !== null && Number.isFinite(balance)
    ? `b:${balance.toFixed(2)}`
    : `n:${occurrenceIndex}`;
  return `t_${fnv1a64(`${occurrenceKey(date, amount, rawPayee)}|${tail}`)}`;
}

/** Counts occurrences of identical triples while a file is being parsed. */
export class OccurrenceCounter {
  private readonly seen = new Map<string, number>();
  next(date: string, amount: number, rawPayee: string): number {
    const key = occurrenceKey(date, amount, rawPayee);
    const n = this.seen.get(key) ?? 0;
    this.seen.set(key, n + 1);
    return n;
  }
}

export interface MergeResult {
  transactions: LocalTransaction[];
  added: number;
  duplicates: number;
}

/**
 * Merge a newly parsed file into the stored history. Existing rows win (they may carry user
 * edits); incoming rows with an id already present are counted as duplicates. Output is sorted
 * by date (stable, so same-day order is preserved).
 */
export function mergeTransactions(existing: LocalTransaction[], incoming: LocalTransaction[]): MergeResult {
  const byId = new Map<string, LocalTransaction>();
  for (const t of existing) if (!byId.has(t.id)) byId.set(t.id, t);
  let added = 0;
  let duplicates = 0;
  for (const t of incoming) {
    if (byId.has(t.id)) {
      duplicates++;
    } else {
      byId.set(t.id, t);
      added++;
    }
  }
  const transactions = [...byId.values()]
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.date < b.t.date ? -1 : a.t.date > b.t.date ? 1 : a.i - b.i))
    .map(({ t }) => t);
  return { transactions, added, duplicates };
}
