import type { ParseResult } from "@kys/statement";
import type { LookupPlan } from "./lookup-plan";
import { matchLocal } from "./attribute";
import type { StoredTransaction } from "./types";

export interface PreparedStatement {
  parse: ParseResult;
  txns: StoredTransaction[];
  plan: LookupPlan;
}

/** Match every payee against the list built into the app (on the device) and work out what an online lookup would need. */
export function prepareStatement(parse: ParseResult, itemId: string): PreparedStatement {
  const txns: StoredTransaction[] = parse.transactions.map((t) => {
    if ((t.kind === "spend" || t.kind === "refund") && t.normPayee) {
      // Try the privacy-normalised name first, then the raw bank text (on-device only) — the raw
      // form keeps domain cues like "APPLE.COM/BILL" or "BOOKING.COM" that normalising strips.
      const r = matchLocal(t);
      return { ...t, itemId, entryId: r.entry?.id, resolution: r.status };
    }
    return { ...t, itemId, resolution: "UNRESOLVED" };
  });
  const recognised = new Set<string>();
  const candidates = new Set<string>();
  const sensitive = new Set<string>();
  let transfers = 0;
  for (const t of txns) {
    if (t.kind === "transfer") transfers++;
    if (!(t.kind === "spend" || t.kind === "refund") || !t.normPayee) continue;
    if (t.resolution === "RESOLVED") recognised.add(t.normPayee);
    else if (t.resolution === "UNRESOLVED") (t.sensitive ? sensitive : candidates).add(t.normPayee);
  }
  // A name held back on any row is held back everywhere: one row can look like a person and another not (18 Oct 2026).
  for (const n of sensitive) candidates.delete(n);
  return {
    parse,
    txns,
    plan: {
      rowsRead: parse.transactions.length,
      recognisedLocally: recognised.size,
      transfersExcluded: transfers,
      candidates: [...candidates].sort(),
      sensitive: [...sensitive].sort(),
    },
  };
}
