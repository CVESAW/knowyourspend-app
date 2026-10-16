import type { OwnershipEntry } from "@kys/ownership";
import type { RequestLogEntry } from "./types";

/**
 * How unknown shops are handled. Kept on the device with the rest of the user's data (and in backups).
 *  - estimate: count shops we can't name an owner for under the country they were paid in ("Estimated")
 *  - lookup:   "auto" sends unrecognised shop names (names that look like people or sensitive shops are held back) to our lookup service
 *              when a statement is added; "ask" waits for a tap on the report; "off" never sends anything
 */
export type LookupMode = "auto" | "ask" | "off";

export interface Prefs {
  home: string;
  estimate: boolean;
  lookup: LookupMode;
  /** normalised payee → ISO2 the user picked */
  overrides: Record<string, string>;
  /** normalised payee → owner found online */
  lookups: Record<string, OwnershipEntry>;
  /** normalised payees already looked up with no answer (not re-sent for 30 days) */
  lookupMisses: Record<string, string>;
  requestLog: RequestLogEntry[];
  /** send anonymous counts ("a statement was added") — no IP, ID or cookie kept; see lib/usage.ts */
  shareCounts: boolean;
}

/** Whether anonymous counts start switched on. Off until the product owner decides (launch plan). */
export const DEFAULT_SHARE_COUNTS = false;

export const DEFAULT_PREFS: Prefs = {
  home: "GB",
  estimate: true,
  lookup: "auto",
  overrides: {},
  lookups: {},
  lookupMisses: {},
  requestLog: [],
  shareCounts: DEFAULT_SHARE_COUNTS,
};
