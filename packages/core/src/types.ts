import type { LocalTransaction } from "@kys/statement";

export type ItemKind = "statement" | "receipt";
export type LocalResolution = "RESOLVED" | "LIKELY_INDEPENDENT" | "UNRESOLVED";

/** A statement or receipt the user added. Lives only in IndexedDB on this device. */
export interface Item {
  id: string;
  kind: ItemKind;
  title: string;
  createdAt: string; // ISO datetime
  dateFrom?: string;
  dateTo?: string;
  bankId?: string;
  bankName?: string;
  fileName?: string;
  /** The data-disclosure record for this submission (drives the "What data leaves your phone" panel). */
  disclosure: Disclosure;
  receipt?: ReceiptMeta;
}

export interface ReceiptMeta {
  storeText?: string;
  storeEntryId?: string;
  date?: string;
  total?: number;
  /** id of a statement transaction this receipt describes (same shop, amount, ±3 days) */
  matchedTransactionId?: string;
}

export interface StoredTransaction extends LocalTransaction {
  itemId: string;
  entryId?: string;
  resolution: LocalResolution;
}

export interface ReceiptLine {
  id: string;
  itemId: string;
  text: string;
  price?: number;
  entryId?: string;
  ownBrandRetailerId?: string;
  included: boolean;
}

/**
 * What was — and wasn't — sent for one submission. Recorded at submission time so the panel
 * on the report shows exactly what happened, not what would happen now.
 */
export interface Disclosure {
  mode: "off" | "remote";
  /** normalised names actually sent (empty when mode is off) */
  sent: string[];
  /** names that would need an online lookup but were not sent (lookup off, or user unticked) */
  notSent: string[];
  /** sensitive names held back by default */
  sensitiveHeld: string[];
  recognisedLocally: number;
  transfersExcluded: number;
  rowsRead: number;
  destination?: string;
  sentAt?: string;
  /**
   * The phone app's receipt reader (Google ML Kit) was used. It reads the photo on the device and
   * never sends the image or text, but Google's library reports usage/performance metrics.
   */
  ocrMetrics?: boolean;
}

export interface RequestLogEntry {
  id: string;
  at: string;
  endpoint: string;
  purpose: string;
  payload: string; // exact JSON body sent
  itemId?: string;
}
