import { useSyncExternalStore } from "react";
import { onOwnershipChange, openBrandsPending, ownershipVersion } from "@kys/core/ownership";

/** Phones: the full brand list is bundled, so there's nothing to load. */
export function startBrandData(): void {}

/** Re-render when the built-in list grows (web loads it after the first screen). */
export function useOwnershipVersion(): number {
  return useSyncExternalStore(onOwnershipChange, ownershipVersion, ownershipVersion);
}

/** Phones: always ready. Web: false while the brand list is still loading. */
export function useBrandListReady(): boolean {
  return useSyncExternalStore(onOwnershipChange, listReady, listReady);
}
const listReady = () => !openBrandsPending();
