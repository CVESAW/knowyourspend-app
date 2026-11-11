// KnowYourSpend — unsubscribe from updates (Supabase Edge Function "kys-unsubscribe", verify_jwt OFF: it's
// reached from a link in an email, and mail apps send one-click unsubscribes with no sign-in).
//
// POST ?token=<uuid> (RFC 8058 one-click, from the List-Unsubscribe header) or POST { "token": "<uuid>" } (the
//   app's /unsubscribe page): deletes that address from kys_subscribers. The token is a random UUID that only
//   appears in emails sent to that address, so it can't be guessed; nothing else is reachable here. The answer is
//   the same whether or not the token was on the list.
// GET ?token=<uuid> (links in emails sent before the app had its page): redirects to the app's page, which asks
//   before unsubscribing — a GET never deletes, since mail scanners open links.
import { createClient } from "npm:@supabase/supabase-js@2";
import { cors, json } from "../_shared/cors.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const APP_URL = Deno.env.get("APP_URL") || "https://app.knowyourspend.org";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = "POST, OPTIONS";

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin, METHODS) });
  if (req.method === "GET") {
    const t = url.searchParams.get("token") ?? "";
    const to = `${APP_URL}/unsubscribe${UUID.test(t) ? `?token=${t}` : ""}`;
    return new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store" } });
  }
  if (req.method !== "POST") return json(405, { error: "POST only" }, origin, METHODS);
  let token = url.searchParams.get("token") ?? "";
  if (!token && (req.headers.get("content-type") ?? "").includes("application/json")) {
    const b = await req.json().catch(() => ({}));
    token = typeof b?.token === "string" ? b.token : "";
  }
  if (!UUID.test(token)) return json(400, { error: "That unsubscribe link isn't complete. Please open it from the email again." }, origin, METHODS);
  const { error } = await db.from("kys_subscribers").delete().eq("unsubscribe_token", token);
  if (error) return json(500, { error: "Couldn't unsubscribe right now. Please try again in a minute." }, origin, METHODS);
  return json(200, { unsubscribed: true }, origin, METHODS);
});
