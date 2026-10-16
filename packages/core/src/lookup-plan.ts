/** What an online ownership lookup would need for one submission. */
export interface LookupPlan {
  rowsRead: number;
  recognisedLocally: number;
  transfersExcluded: number;
  /** unrecognised, non-sensitive names that an online lookup would need */
  candidates: string[];
  /** unrecognised names held back because they look sensitive (unticked by default) */
  sensitive: string[];
}

/** The exact request body we would send. Shown to the user before anything is sent. */
export function requestBody(names: string[]): string {
  return JSON.stringify({ merchants: [...names].sort() }, null, 2);
}
