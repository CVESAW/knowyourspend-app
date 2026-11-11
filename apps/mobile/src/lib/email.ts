import type { Breakdown } from "@kys/core/aggregate";
import { countryName } from "./countries";
import { entryById } from "./ownership";
import { accessToken, SUPABASE_URL } from "./account";
import { LOOKUP_KEY } from "./lookup";
import { track } from "./usage";

/**
 * "Email me my results": percentages by owner country and the shops paid most — never amounts, dates,
 * balances or account details. The address is used to send the email and then forgotten, unless the
 * person is signed in and ticks "occasional updates". Sent by our Edge Function kys-email (Supabase)
 * through our email provider; the function writes the email's headline and subject itself, and counts
 * sends against a daily limit by a salted hash of the IP address (deleted within two days).
 */
export interface ResultsSummary {
  headline: string;
  period: string;
  /** `iso` is the country's ISO 3166-1 alpha-2 code; left out for "Other countries" */
  countries: { iso?: string; name: string; share: number }[];
  shops: { name: string; owner?: string; country?: string }[];
}

export const UPDATES_CONSENT = "Send me occasional updates from KnowYourSpend. I can unsubscribe at any time.";

export function summarise(b: Breakdown, period: string): ResultsSummary {
  const top = b.countries.slice(0, 7);
  const rest = b.countries.slice(7).reduce((s, c) => s + c.share, 0);
  const countries: ResultsSummary["countries"] = [
    ...top.map((c) => ({ iso: c.iso, name: countryName(c.iso), share: c.share })),
    ...(rest > 0.0049 ? [{ name: "Other countries", share: rest }] : []),
  ];
  // Only shops on our list of known brands: a name the app doesn't recognise is raw statement text
  // (it could be a small business named after a person), so it never goes into the email.
  const shops = b.countries
    .flatMap((c) => c.entries.map((e) => ({ ...e, iso: c.iso, entry: e.basis === "owner" ? entryById(e.entryId) : undefined })))
    .filter((e) => e.entry)
    .sort((a, z) => z.amount - a.amount)
    .slice(0, 8)
    .map(({ entry, iso }) => {
      // an owner known only by its Wikidata id is left out of the email, rather than sent as "Q…"
      const top = entry!.chain[entry!.chain.length - 1]?.name;
      const owner = top && !/^Q\d+$/.test(top) ? top : undefined;
      return { name: entry!.display_name, owner: owner && owner !== entry!.display_name ? owner : undefined, country: countryName(iso) };
    });
  const outside = 1 - b.scores.ukShare;
  return { headline: `${Math.round(outside * 100)}% went to companies owned outside the UK`, period, countries, shops };
}

/** `updates` only counts when signed in: the server ignores it otherwise. */
export async function emailResults(to: string, updates: boolean, s: ResultsSummary): Promise<void> {
  const signedIn = await accessToken();
  const token = signedIn ?? LOOKUP_KEY;
  updates = updates && !!signedIn;
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/kys-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: LOOKUP_KEY, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, updates, ...s }),
    });
  } catch {
    throw new Error("You seem to be offline. Try again when you're connected.");
  }
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? "Couldn't send right now. Please try again later.");
  }
  track("results_emailed");
}
