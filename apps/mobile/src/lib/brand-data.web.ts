import { useSyncExternalStore } from "react";
import type { OpenBrandsFile } from "@kys/ownership";
import { configureOpenBrandsLoader, ensureOpenBrands, onOwnershipChange, openBrandsPending, ownershipVersion } from "@kys/core/ownership";
import { OPEN_BRANDS_URL } from "./open-brands-url.generated";

/**
 * Web: the 6,600 generated brands (1.6 MB) are a separate file, fetched from our own site once the first
 * screen is up, so the app opens fast from an ad. Anything that matches payments awaits ensureOpenBrands().
 */
configureOpenBrandsLoader(async () => {
  const res = await fetch(OPEN_BRANDS_URL);
  if (!res.ok) throw new Error(`Couldn't load the brand list (HTTP ${res.status})`);
  return (await res.json()) as OpenBrandsFile;
});

export function startBrandData(): void {
  const go = () => ensureOpenBrands().catch(() => {
    /* offline on first visit: matching uses the hand-built list until the next try */
  });
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(go, { timeout: 1500 });
  else setTimeout(go, 300);
}

export function useOwnershipVersion(): number {
  return useSyncExternalStore(onOwnershipChange, ownershipVersion, ownershipVersion);
}

/** False while the brand list is still loading, so screens with saved data wait instead of flickering. */
export function useBrandListReady(): boolean {
  // Read through the store snapshot, not a plain call: the React Compiler would cache a plain call.
  return useSyncExternalStore(onOwnershipChange, listReady, listReady);
}
const listReady = () => !openBrandsPending();
