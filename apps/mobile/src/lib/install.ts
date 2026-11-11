/** Phones: the app is already installed and its storage is the app's own, so there is nothing to do. */
export interface InstallState {
  /** running as a web page in a browser tab (not installed to the home screen) */
  inBrowserTab: boolean;
  /** the browser can show its own install prompt (Chrome, Edge, Samsung Internet on Android) */
  canPrompt: boolean;
  /** iPhone or iPad: install is Share → Add to Home Screen */
  ios: boolean;
}
const NATIVE: InstallState = { inBrowserTab: false, canPrompt: false, ios: false };
export function useInstall(): InstallState {
  return NATIVE;
}
export async function promptInstall(): Promise<boolean> {
  return false;
}
/** Ask the browser to keep this site's data even when space runs low or the site goes unused. */
export async function keepData(): Promise<boolean | null> {
  return true;
}
export function initInstall(): void {}
export function snoozed(): boolean {
  return true;
}
export function snooze(): void {}
