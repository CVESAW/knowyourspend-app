/** A transaction as stored on the device. Nothing in here is ever sent to a server except `normPayee`. */
export interface LocalTransaction {
  /** hash(date, amount, rawPayee, runningBalance ?? occurrenceIndex) — dedupe key on re-upload (DESIGN-pivot §4.2, §10 #1) */
  id: string;
  date: string;          // ISO yyyy-mm-dd
  amount: number;        // negative = money out
  currency: string;      // ISO 4217
  rawPayee: string;      // never sent
  normPayee: string;     // the only thing that may be sent for lookup
  /** Bank-provided type code or label, e.g. "DEB", "Card payment" */
  typeLabel?: string;
  kind: TransactionKind;
  /** true when the payee looks like a sensitive category (health, gambling, dating, politics, payday) — pre-unticked for lookup and excluded from sharing */
  sensitive: boolean;
  balance?: number;
  /**
   * Added: the bank's raw descriptor when `rawPayee` was taken from a bank-cleaned name
   * field (Monzo `Name`, Starling `Counter Party`, N26 `Partner Name`, Wise `Merchant`).
   * Never sent.
   */
  rawDescription?: string;
  /** Added: the bank's own transaction ID when the export has one (Monzo, Wise). Never sent. */
  sourceId?: string;
}

/** Only "spend" rows count towards the ownership breakdown. Transfers to people are never sent anywhere. */
export type TransactionKind = "spend" | "refund" | "income" | "transfer" | "cash" | "internal" | "fee" | "unknown";

export interface BankFormat {
  id: string;            // "monzo"
  name: string;          // "Monzo"
  confidence: "confirmed" | "unconfirmed";
}

export interface ParseResult {
  bank: BankFormat | null;
  transactions: LocalTransaction[];
  /** rows skipped with reason (headers, opening balance, unparseable) */
  skipped: { row: number; reason: string }[];
  dateRange: { from: string; to: string } | null;
  currencies: string[];
  /** When bank is null the caller must supply a ColumnMapping */
  needsMapping: boolean;
  headers: string[];
  previewRows: string[][];
  /** Added: non-fatal notes for the UI, e.g. "date order ambiguous, assumed day-first". */
  warnings?: string[];
}

export interface ColumnMapping {
  date: number;
  description: number;
  amount?: number;       // single signed column
  paidOut?: number;      // split columns
  paidIn?: number;
  balance?: number;
  currency?: number;
  type?: number;
  /**
   * Added: a bank-cleaned counterparty/merchant name column. When set and non-empty it is
   * used as `rawPayee`, and `description` is kept as `rawDescription`.
   */
  payee?: number;
  dateOrder?: "DMY" | "MDY" | "YMD";
}
