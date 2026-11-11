import {
  addOpenBrands, allEntries, checkedEntries, countries, createResolver, badgeFor, isPublishable, openBrands,
  type OpenBrandsFile, type OwnershipEntry, type Resolver,
} from "@kys/ownership";

/**
 * The built-in ownership list and its resolvers. On the web the 6,600 generated brands aren't bundled:
 * the app calls configureOpenBrandsLoader() with a fetcher, and ensureOpenBrands() adds them before
 * anything is matched. Everything that holds a resolver keeps working: `resolver` always points at the
 * newest index, and onOwnershipChange() tells screens to re-match what they show.
 */
let statementResolver = createResolver(allEntries);
/** Statement payees: the full list (hand-built + open brands), with run-together / near-miss / web-address matching. */
export const resolver: Resolver = {
  resolve: (payee, where) => statementResolver.resolve(payee, where),
  resolveProduct: (line) => statementResolver.resolveProduct(line),
  size: () => statementResolver.size(),
};
/** Receipt photos: OCR noise ("TOTAL", "SAVE") would hit generated everyday-word brands, so only the hand-built list, exact matches. */
export const receiptResolver = createResolver(checkedEntries, { fuzzy: false });
const byId = new Map(allEntries.map((e) => [e.id, e]));
/** Entries learned at run time (online lookup answers), kept apart from the built-in list. */
const extraById = new Map<string, OwnershipEntry>();

export function entryById(id: string | undefined): OwnershipEntry | undefined {
  return id ? byId.get(id) ?? extraById.get(id) : undefined;
}

/** Make online lookup answers findable by id (they are stored on the device, keyed by payee). */
export function registerEntries(entries: Iterable<OwnershipEntry>): void {
  for (const e of entries) if (!byId.has(e.id)) extraById.set(e.id, e);
}

// ── Loading the generated list where it isn't bundled (web) ─────────────────────────────────
let version = 0;
let loader: (() => Promise<OpenBrandsFile>) | null = null;
let loading: Promise<void> | null = null;
let failed = false;
const listeners = new Set<() => void>();

/** Bumped when the list grows; anything cached against the old list should be recomputed. */
export function ownershipVersion(): number {
  return version;
}
export function onOwnershipChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function openBrandsLoaded(): boolean {
  return openBrands.length > 0;
}
/** True while the web app is still fetching the list (so screens with data can wait instead of flickering). */
export function openBrandsPending(): boolean {
  return !!loader && openBrands.length === 0 && !failed;
}
export function configureOpenBrandsLoader(fetchFile: () => Promise<OpenBrandsFile>): void {
  loader = fetchFile;
}

/** Resolves once the full list is in (at once where it's bundled). Retries on the next call after a failure. */
export function ensureOpenBrands(): Promise<void> {
  if (openBrands.length || !loader) return Promise.resolve();
  if (!loading) failed = false;
  loading ??= loader()
    .then((file) => {
      const added = addOpenBrands(file);
      for (const e of added) if (!byId.has(e.id)) byId.set(e.id, e);
      statementResolver = createResolver(allEntries);
      version++;
      listeners.forEach((l) => l());
    })
    .catch((e) => {
      loading = null;
      failed = true; // show results with the hand-built list rather than wait forever; a later call retries
      version++;
      listeners.forEach((l) => l());
      throw e;
    });
  return loading;
}

export { badgeFor, isPublishable, countries, allEntries, checkedEntries };
export type { OwnershipEntry };
