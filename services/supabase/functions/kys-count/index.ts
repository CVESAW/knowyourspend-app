// KnowYourSpend — anonymous usage counts (Supabase Edge Function "kys-count", verify_jwt on).
// The app only calls this if the user switched "Send anonymous counts" on. One number per event per day
// is incremented; no IP address, ID, cookie or anything about the user is stored.
import { createClient } from "npm:@supabase/supabase-js@2";
import { cors, json } from "../_shared/cors.ts";

const EVENTS = new Set(["statement_added", "receipt_added", "demo_opened", "account_created", "results_emailed"]);
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json(405, { error: "POST only" }, origin);
  const body = await req.json().catch(() => ({}));
  if (!EVENTS.has(body?.event)) return json(400, { error: "unknown event" }, origin);
  const { error } = await db.rpc("kys_count", { p_event: body.event });
  return error ? json(500, { error: "not counted" }, origin) : json(200, { counted: true }, origin);
});
