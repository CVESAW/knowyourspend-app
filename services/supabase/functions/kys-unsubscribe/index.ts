// KnowYourSpend — unsubscribe from updates (Supabase Edge Function "kys-unsubscribe", verify_jwt OFF:
// it's opened from a link in an email, and mail apps send one-click unsubscribes with no sign-in).
// GET or POST ?token=<uuid>: deletes that address from kys_subscribers. The token is a random UUID that
// only appears in emails sent to that address, so it can't be guessed; nothing else is reachable here.
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const APP_URL = Deno.env.get("APP_URL") || "https://app.knowyourspend.org";

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "POST") return new Response("GET or POST only", { status: 405 });
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    await db.from("kys_subscribers").delete().eq("unsubscribe_token", token);
  }
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed</title><body style="font:17px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f6f1e7;color:#1c1b19;padding:40px 20px;max-width:520px;margin:auto"><h1 style="font:400 28px Georgia,serif">You're unsubscribed</h1><p>We won't send you updates any more, and we've deleted your email address from our list.</p><p><a href="${APP_URL}">Open KnowYourSpend</a></p></body>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
});
