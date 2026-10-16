import { useSyncExternalStore } from "react";
import { kv } from "./kv";
import type { Item, ReceiptLine, StoredTransaction } from "./types";
import { DEFAULT_PREFS, type Prefs } from "./prefs";

/**
 * Everything the user adds lives in this store, persisted only on this device (IndexedDB on web,
 * AsyncStorage on phones). There is no server copy. The demo uses its own namespace so it never
 * mixes with real data.
 */
export type Mode = "real" | "demo";

export interface Snapshot {
  loaded: boolean;
  mode: Mode;
  items: Item[];
  txns: StoredTransaction[];
  lines: ReceiptLine[];
  /** matching settings, the user's own country fixes and online lookup answers — also on this device only */
  prefs: Prefs;
}

type Data = Pick<Snapshot, "items" | "txns" | "lines" | "prefs">;
const EMPTY: Data = { items: [], txns: [], lines: [], prefs: DEFAULT_PREFS };
const KEYS = ["items", "txns", "lines", "prefs"] as const;
const MODE_KEY = "kys.mode";

let snap: Snapshot = { loaded: false, mode: "real", ...EMPTY };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

function emit() {
  for (const l of listeners) l();
}

const key = (mode: Mode, k: string) => `kys.${mode}.${k}`;

async function loadMode(mode: Mode): Promise<Data> {
  const out: Data = { ...EMPTY };
  for (const k of KEYS) {
    try {
      const raw = await kv.get(key(mode, k));
      if (raw) (out as Record<string, unknown>)[k] = k === "prefs" ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : JSON.parse(raw);
    } catch {
      /* unreadable data is treated as empty rather than crashing the app */
    }
  }
  return out;
}

async function persist(mode: Mode, data: Data) {
  await Promise.all(KEYS.map((k) => kv.set(key(mode, k), JSON.stringify(data[k]))));
}

export const store = {
  get: () => snap,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** Load the given mode's data from the device (no mode = the one used last time). The mode is remembered across reloads. */
  load(mode?: Mode): Promise<void> {
    loading = (async () => {
      if (!mode) mode = ((await kv.get(MODE_KEY).catch(() => null)) === "demo" ? "demo" : "real") as Mode;
      else await kv.set(MODE_KEY, mode).catch(() => {});
      const data = await loadMode(mode);
      snap = { loaded: true, mode: mode!, ...data };
      emit();
    })();
    return loading;
  },
  async ready(): Promise<Snapshot> {
    if (!snap.loaded) await (loading ?? store.load());
    return snap;
  },
  /** Apply a change and save it on the device. Keys the change leaves out are kept as they are. */
  async update(fn: (d: Data) => Partial<Data>): Promise<void> {
    await store.ready();
    const cur: Data = { items: snap.items, txns: snap.txns, lines: snap.lines, prefs: snap.prefs };
    const next: Data = { ...cur, ...fn(cur) };
    snap = { ...snap, ...next };
    emit();
    await persist(snap.mode, next);
  },
  async wipe(mode: Mode = snap.mode): Promise<void> {
    await Promise.all(KEYS.map((k) => kv.remove(key(mode, k))));
    if (mode === snap.mode) {
      snap = { ...snap, ...EMPTY };
      emit();
    }
  },
};

export function useStore(): Snapshot {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
