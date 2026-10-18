import type { OwnershipEntry } from "@kys/ownership";
import type { LookupCheck } from "@kys/core/lookup-plan";
import type { RequestLogEntry } from "./types";

/**
 * How unknown shops are handled. Kept on the device with the rest of the user's data (and in backups).
 *  - estimate: count shops we can't name an owner for under the country they were paid in ("Estimated")
 *  - lookup:   "auto" sends unrecognised shop names (names that look like people or sensitive shops are held back) to our lookup service
 *              when a statement is added; "ask" waits for a tap on the report; "off" never sends anything
 */
export type LookupMode = "auto" | "ask" | "off";

export type { LookupCheck } from "@kys/core/lookup-plan";

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
  /** normalised payees our look-up said are small local businesses (date it said so); counted as local independents */
  lookupLocal: Record<string, string>;
  /** more about the look-up's answers (since 18 Oct 2026): `recheck`, an answer still to get its full check, asked again
   *  on or after that day; `web`, a web search checked a "small local business" answer */
  lookupChecks: Record<string, LookupCheck>;
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
  lookupLocal: {},
  lookupChecks: {},
  requestLog: [],
  shareCounts: DEFAULT_SHARE_COUNTS,
};
