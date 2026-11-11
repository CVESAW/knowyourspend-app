import { LOOKUP_KEY } from "./lookup";
import { store } from "./store";

/**
 * Anonymous usage counts, only if the person has "Send anonymous counts" switched on (Settings).
 * Each call adds 1 to a daily total for one event on our server — no IP address, ID, cookie, device
 * details or anything about what was added is stored. Never sent from the demo.
 */
export type UsageEvent = "statement_added" | "receipt_added" | "demo_opened" | "account_created" | "results_emailed";
const URL = `${(process.env.EXPO_PUBLIC_SUPABASE_URL ?? "https://cxvwngmnkxtweuwaxfmz.supabase.co").replace(/\/$/, "")}/functions/v1/kys-count`;

export function track(event: UsageEvent): void {
  const s = store.get();
  if (!s.prefs.shareCounts || (s.mode === "demo" && event !== "demo_opened")) return;
  fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: LOOKUP_KEY, Authorization: `Bearer ${LOOKUP_KEY}` },
    body: JSON.stringify({ event }),
    keepalive: true,
  }).catch(() => {});
}
