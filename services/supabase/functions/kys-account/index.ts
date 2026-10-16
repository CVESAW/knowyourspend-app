// KnowYourSpend — delete my account (Supabase Edge Function "kys-account", verify_jwt on).
// DELETE with the user's access token: removes their encrypted copy and the account itself.
import { createClient } from "npm:@supabase/supabase-js@2";
import { cors, json } from "../_shared/cors.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin, "DELETE, OPTIONS") });
  if (req.method !== "DELETE") return json(405, { error: "DELETE only" }, origin, "DELETE, OPTIONS");
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return json(401, { error: "Sign in again, then try once more." }, origin, "DELETE, OPTIONS");
  const id = data.user.id;
  await admin.from("kys_vault").delete().eq("user_id", id);
  await admin.from("kys_subscribers").delete().eq("email", (data.user.email ?? "").toLowerCase());
  const del = await admin.auth.admin.deleteUser(id);
  if (del.error) return json(500, { error: "Couldn't delete the account. Email hello@knowyourspend.org and we'll do it." }, origin, "DELETE, OPTIONS");
  return json(200, { deleted: true }, origin, "DELETE, OPTIONS");
});
