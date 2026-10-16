// KnowYourSpend — "Email me my results" (Supabase Edge Function "kys-email", verify_jwt on: the app sends
// the public anon key, or the user's own token when signed in).
//
// POST { to, headline, period, countries: [{ name, share }], shops: [{ name, owner, country }], updates }
//   Sends one email with percentages by country and the shops paid most, never amounts. The address is
//   used to send it and then forgotten — unless the person ticked "send me occasional updates", in which
//   case it is kept in kys_subscribers with the consent wording and an unsubscribe token.
//   Signed in: the email goes to the account's own address, whatever `to` says.
//   Limits (salted hashes only, kept 30 days): 3 a day per address, 10 a day per connection, and a daily
//   cap for the whole service (EMAIL_DAILY_CAP, default 300 — Brevo's free tier).
// Unsubscribe links point to the separate kys-unsubscribe function (no sign-in needed to open them).
//
// Secrets: BREVO_API_KEY (or RESEND_API_KEY), EMAIL_FROM ("KnowYourSpend <hello@knowyourspend.org>").
import { createClient } from "npm:@supabase/supabase-js@2";
import { cors, json, sha256 } from "../_shared/cors.ts";

const env = (k: string) => Deno.env.get(k) ?? "";
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const APP_URL = env("APP_URL") || "https://app.knowyourspend.org";
const UNSUBSCRIBE_URL = `${env("SUPABASE_URL")}/functions/v1/kys-unsubscribe`;
const CONSENT = "Send me occasional updates from KnowYourSpend. I can unsubscribe at any time.";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "");
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/;

interface Body {
  to?: string;
  headline?: string;
  period?: string;
  countries?: { name: string; share: number }[];
  shops?: { name: string; owner?: string; country?: string }[];
  updates?: boolean;
}

function render(b: Required<Pick<Body, "countries" | "shops">> & { headline: string; period: string }, unsubscribe?: string) {
  const bars = b.countries
    .map((c) => {
      const pct = Math.round(c.share * 100);
      return `<tr><td style="padding:6px 0;font:15px/1.3 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1c1b19">${esc(c.name)}</td><td style="padding:6px 0;text-align:right;font:600 15px/1.3 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1c1b19">${pct}%</td></tr>
<tr><td colspan="2" style="padding:0 0 6px"><div style="height:8px;border-radius:4px;background:#efe8da"><div style="height:8px;border-radius:4px;background:#8c2f39;width:${Math.max(2, pct)}%"></div></div></td></tr>`;
    })
    .join("");
  const shops = b.shops
    .map((s) => `<tr><td style="padding:7px 0;border-top:1px solid #d9d1c0;font:15px/1.3 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1c1b19">${esc(s.name)}</td><td style="padding:7px 0;border-top:1px solid #d9d1c0;text-align:right;font:13px/1.3 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#4a463f">${esc([s.owner, s.country].filter(Boolean).join(" · "))}</td></tr>`)
    .join("");
  const html = `<!doctype html><html><body style="margin:0;background:#f6f1e7"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f1e7"><tr><td align="center" style="padding:28px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="font:700 20px Georgia,serif;color:#1c1b19;padding-bottom:18px">KnowYourSpend</td></tr>
<tr><td style="font:400 28px/1.15 Georgia,serif;color:#1c1b19;padding-bottom:6px">${esc(b.headline)}</td></tr>
<tr><td style="font:14px -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#6e685d;padding-bottom:20px">${esc(b.period)}</td></tr>
<tr><td style="background:#fbf8f2;border:1px solid #d9d1c0;border-radius:12px;padding:16px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${bars}</table></td></tr>
${shops ? `<tr><td style="font:400 20px Georgia,serif;color:#1c1b19;padding:24px 0 8px">Who you pay most</td></tr><tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${shops}</table></td></tr>` : ""}
<tr><td style="padding:26px 0"><a href="${APP_URL}" style="display:inline-block;background:#8c2f39;color:#fff;text-decoration:none;font:600 15px -apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:13px 22px;border-radius:999px">Open KnowYourSpend</a></td></tr>
<tr><td style="font:12px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#6e685d">Percentages only: your amounts, dates and balances stayed on your device. Estimates based on published ownership data; may contain errors. Brand names are used for identification only; no affiliation or endorsement.<br><br>You got this email because you asked KnowYourSpend to send your results to this address. ${unsubscribe ? `You also asked for occasional updates — <a href="${unsubscribe}" style="color:#6e685d">unsubscribe</a>.` : "We don't keep your address."}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    b.headline,
    b.period,
    "",
    ...b.countries.map((c) => `${c.name}: ${Math.round(c.share * 100)}%`),
    ...(b.shops.length ? ["", "Who you pay most:", ...b.shops.map((s) => `- ${s.name}${s.owner || s.country ? ` (${[s.owner, s.country].filter(Boolean).join(", ")})` : ""}`)] : []),
    "",
    `Open KnowYourSpend: ${APP_URL}`,
    "",
    "Percentages only. Estimates based on published ownership data; may contain errors.",
    unsubscribe ? `Unsubscribe from updates: ${unsubscribe}` : "We don't keep your address.",
  ].join("\n");
  return { html, text };
}

async function send(to: string, subject: string, html: string, text: string, unsubscribe?: string): Promise<boolean> {
  const from = env("EMAIL_FROM") || "KnowYourSpend <hello@knowyourspend.org>";
  const m = from.match(/^(.*)<(.+)>$/);
  const fromName = (m?.[1] ?? "KnowYourSpend").trim(), fromEmail = (m?.[2] ?? from).trim();
  const listHeaders = unsubscribe ? { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined;
  if (env("BREVO_API_KEY")) {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env("BREVO_API_KEY"), "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { name: fromName, email: fromEmail }, to: [{ email: to }], subject, htmlContent: html, textContent: text, ...(listHeaders ? { headers: listHeaders } : {}) }),
    });
    // Log why a send failed (status and Brevo's reason, with any address blanked out) so it can be fixed.
    if (!r.ok) console.error("brevo send failed", r.status, (await r.text()).replace(/[^\s"'<>]+@[^\s"'<>]+/g, "<address>").slice(0, 200));
    return r.ok;
  }
  if (env("RESEND_API_KEY")) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env("RESEND_API_KEY")}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text, ...(listHeaders ? { headers: listHeaders } : {}) }),
    });
    return r.ok;
  }
  return false;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json(405, { error: "POST only" }, origin);
  if (!env("BREVO_API_KEY") && !env("RESEND_API_KEY")) return json(503, { error: "Emailing results isn't switched on yet." }, origin);

  const b = (await req.json().catch(() => ({}))) as Body;
  // Signed in? Then it goes to the account's own (verified) address.
  let to = clean(b.to, 254).toLowerCase();
  let verified = false;
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (token && token.split(".").length === 3) {
    const { data } = await db.auth.getUser(token).catch(() => ({ data: { user: null } }));
    if (data?.user?.email) {
      to = data.user.email.toLowerCase();
      verified = true;
    }
  }
  if (!EMAIL.test(to)) return json(400, { error: "Please enter a valid email address." }, origin);
  const countries = (Array.isArray(b.countries) ? b.countries : [])
    .slice(0, 12)
    .map((c) => ({ name: clean(c?.name, 40), share: Math.min(1, Math.max(0, Number(c?.share) || 0)) }))
    .filter((c) => c.name);
  const shops = (Array.isArray(b.shops) ? b.shops : []).slice(0, 10).map((s) => ({ name: clean(s?.name, 60), owner: clean(s?.owner, 80), country: clean(s?.country, 40) })).filter((s) => s.name);
  if (!countries.length) return json(400, { error: "Nothing to send yet — add a statement first." }, origin);
  const headline = clean(b.headline, 120) || "Your spending by owner's country";
  const period = clean(b.period, 60);

  const salt = await sha256("kys-email:" + env("SUPABASE_SERVICE_ROLE_KEY"));
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]!.trim();
  const keys = [`to:${await sha256(salt + to)}`, `ip:${await sha256(salt + ip)}`, "all"];
  const limits = [verified ? 10 : 3, 10, Number(env("EMAIL_DAILY_CAP") || 300)];
  const { data: ok, error: limErr } = await db.rpc("kys_email_bump", { p_keys: keys, p_limits: limits });
  if (limErr) return json(500, { error: "Couldn't send right now. Please try again later." }, origin);
  if (!ok) return json(429, { error: "You've sent a few already today. Please try again tomorrow." }, origin);

  let unsubscribeUrl: string | undefined;
  if (b.updates === true) {
    const { data: row } = await db.from("kys_subscribers").upsert({ email: to, consent_text: CONSENT, source: "email-results" }, { onConflict: "email" }).select("unsubscribe_token").single();
    if (row?.unsubscribe_token) unsubscribeUrl = `${UNSUBSCRIBE_URL}?token=${row.unsubscribe_token}`;
  }
  const { html, text } = render({ countries, shops, headline, period }, unsubscribeUrl);
  const sent = await send(to, `Your KnowYourSpend results: ${headline}`.slice(0, 150), html, text, unsubscribeUrl);
  return sent ? json(200, { sent: true }, origin) : json(502, { error: "Couldn't send right now. Please try again later." }, origin);
});
