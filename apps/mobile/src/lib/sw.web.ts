/**
 * Offline support for the web version: the service worker (public/sw.js, generated at build time)
 * caches the app itself so it opens without a connection. It never caches or sees your data —
 * that lives in IndexedDB on this device.
 */
export function registerServiceWorker(): void {
  if (process.env.NODE_ENV !== "production" || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const register = () =>
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline support is a bonus; the app works without it */
    });
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
