import { useMemo } from "react";
import { breakdown, contributions, type Breakdown, type Contribution, type Period } from "./aggregate";
import { useStore } from "./store";
import { useOwnershipVersion } from "./brand-data";
import type { AttributionContext } from "@kys/core/attribute";
import type { Item, ReceiptLine, StoredTransaction } from "./types";

export interface AppData {
  loaded: boolean;
  demo: boolean;
  items: Item[];
  txns: StoredTransaction[];
  lines: ReceiptLine[];
  contribs: Contribution[];
  otherCurrency: number;
}

export function useAppData(): AppData {
  const s = useStore();
  const listVersion = useOwnershipVersion(); // re-match when the built-in list grows (web)
  return useMemo(() => {
    const items = [...s.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    // Every payment is re-matched against today's list, online answers and the user's own fixes.
    const ctx: AttributionContext = { home: s.prefs.home, estimate: s.prefs.estimate, overrides: s.prefs.overrides, lookups: s.prefs.lookups };
    const { list, otherCurrency } = s.loaded ? contributions(items, s.txns, s.lines, ctx) : { list: [], otherCurrency: 0 };
    return { loaded: s.loaded, demo: s.mode === "demo", items, txns: s.txns, lines: s.lines, contribs: list, otherCurrency };
  }, [s, listVersion]);
}

export function useBreakdown(data: AppData, period: Period, filter?: (c: Contribution) => boolean): Breakdown {
  return useMemo(() => breakdown(filter ? data.contribs.filter(filter) : data.contribs, data.otherCurrency, period), [data, period, filter]);
}
