import { useSyncExternalStore } from "react";
import type { InstallState } from "./install";

/**
 * Web: helps people add KnowYourSpend to their home screen and asks the browser to keep its data.
 * Browsers can clear a site's storage when space runs low or the site hasn't been used for a while;
 * home-screen web apps and sites granted persistent storage are much less likely to lose it.
 */
type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

let deferred: BeforeInstallPromptEvent | null = null;
let snap: InstallState = compute();
const listeners = new Set<() => void>();

function compute(): InstallState {
  if (typeof window === "undefined") return { inBrowserTab: false, canPrompt: false, ios: false };
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return { inBrowserTab: !standalone, canPrompt: !!deferred, ios };
}
function emit() {
  snap = compute();
  listeners.forEach((l) => l());
}

export function initInstall(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // we offer it from our own card instead of the browser's mini-bar
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    emit();
  });
  window.matchMedia?.("(display-mode: standalone)").addEventListener?.("change", emit);
}

export function useInstall(): InstallState {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => snap,
    () => snap,
  );
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const d = deferred;
  deferred = null;
  await d.prompt();
  const { outcome } = await d.userChoice;
  emit();
  return outcome === "accepted";
}

/**
 * Asks for persistent storage. Chrome and Safari decide silently (installed apps and sites people use
 * often get it); Firefox would show a permission prompt, so there we only ask when installed.
 */
export async function keepData(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    if (/Firefox\//.test(navigator.userAgent) && snap.inBrowserTab) return false;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

const SNOOZE_KEY = "kys-install-card-snoozed";
const SNOOZE_DAYS = 30;
/** "Not now" on the home-screen card hides it for 30 days (kept in this browser only). */
export function snoozed(): boolean {
  try {
    const at = Number(localStorage.getItem(SNOOZE_KEY) ?? 0);
    return Date.now() - at < SNOOZE_DAYS * 864e5;
  } catch {
    return false;
  }
}
export function snooze(): void {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now()));
  } catch {
    // private mode: the card simply comes back next time
  }
}
