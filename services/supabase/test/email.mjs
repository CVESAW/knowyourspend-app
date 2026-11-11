// kys-email and kys-unsubscribe with a stand-in database and email provider: the subject and headline are written by
// the function, text that isn't name-like is left out, updates are only for signed-in addresses, limits use the
// mailbox and the connection the proxy saw, and unsubscribing never happens on a GET.
// Run: node --experimental-strip-types services/supabase/test/email.mjs   (Node 22.6 or later)
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fns = join(here, "..", "functions");
const dir = mkdtempSync(join(tmpdir(), "kys-email-"));
for (const f of ["kys-email", "kys-unsubscribe", "_shared"]) cpSync(join(fns, f), join(dir, f), { recursive: true });
for (const f of ["kys-email/index.ts", "kys-unsubscribe/index.ts"]) writeFileSync(join(dir, f), readFileSync(join(dir, f), "utf8").replace("npm:@supabase/supabase-js@2", "../fake-db.mjs"));
writeFileSync(join(dir, "fake-db.mjs"), `export const log = [];
export const state = { user: null, allow: true };
export const createClient = () => ({
  auth: { getUser: async () => ({ data: { user: state.user } }) },
  rpc: async (fn, args) => { log.push(["rpc", fn, args]); return { data: state.allow }; },
  from: (table) => ({
    upsert: (row) => { log.push(["upsert", table, row]); return { select: () => ({ single: async () => ({ data: { unsubscribe_token: "11111111-2222-3333-4444-555555555555" } }) }) }; },
    delete: () => ({ eq: async (c, v) => { log.push(["delete", table, c, v]); return {}; } }),
  }),
});
`);

const ok = (c, m) => { if (!c) process.exitCode = 1; console.log(c ? "ok  " : "FAIL", m); };
const env = { BREVO_API_KEY: "x", SUPABASE_URL: "https://p.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "s" };
const handlers = [];
globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => handlers.push(h) };
const sent = [];
globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return new Response("{}", { status: 201 }); };
const { log, state } = await import(pathToFileURL(join(dir, "fake-db.mjs")).href);
const mod = await import(pathToFileURL(join(dir, "kys-email", "index.ts")).href);
await import(pathToFileURL(join(dir, "kys-unsubscribe", "index.ts")).href);
const [email, unsub] = handlers;
const post = (body, headers = {}) => email(new Request("https://x/", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
const results = {
  to: "victim@example.com",
  headline: "Your card is blocked: verify at evil.example now",
  period: "1 Jun – 30 Jun 2026",
  countries: [{ iso: "US", name: "United States", share: 0.4 }, { iso: "GB", name: "United Kingdom", share: 0.5 }, { name: "Call 0800 123 4567", share: 0.1 }],
  shops: [{ name: "Tesco", owner: "Tesco PLC", country: "United Kingdom" }, { name: "Booking.com", owner: "Booking Holdings", country: "United States" }, { name: "Visit evil.example", owner: "x" }, { name: "Support", owner: "help@evil.example" }],
};

// 1. Not signed in: our subject and headline, link-like text left out, updates ignored.
let r = await post({ ...results, updates: true }, { "x-forwarded-for": "9.9.9.9, 203.0.113.5" });
let m = sent.at(-1)?.body;
ok(r.status === 200 && m.subject === "Your KnowYourSpend results: 50% went to companies owned outside the UK", `subject: ${m?.subject}`);
ok(!/evil|0800|blocked/.test(m.htmlContent + m.textContent + m.subject), "nothing link-like or phone-like from the request reaches the email");
ok(/Booking</.test(m.htmlContent) && /Tesco PLC/.test(m.htmlContent), "real names kept (Booking.com shown as Booking)");
ok(!log.some((l) => l[0] === "upsert") && !m.headers, "updates ignored when not signed in (no subscriber row, no unsubscribe header)");
const bump = log.find((l) => l[1] === "kys_email_bump")[2];
ok(bump.p_keys.length === 4 && bump.p_keys.includes("anon") && bump.p_limits[2] === 250, `limits: ${bump.p_keys.map((k) => k.replace(/:.{10}.*/, ":…")).join(", ")} / ${bump.p_limits.join(", ")}`);

// 2. The same mailbox written differently, and the same connection with a different forged first hop, share limits.
log.length = 0;
await post({ ...results, to: "Vic.Tim+1@googlemail.com" }, { "x-forwarded-for": "1.2.3.4, 203.0.113.5" });
await post({ ...results, to: "victim+2@gmail.com" }, { "x-forwarded-for": "5.6.7.8, 203.0.113.5" });
const [a, b] = log.filter((l) => l[1] === "kys_email_bump").map((l) => l[2].p_keys);
ok(a[0] === b[0] && a[1] === b[1] && a[1] === bump.p_keys[1], "same mailbox and same connection → same limit keys");
ok(mod.mailbox("Jo.Bloggs+news@GoogleMail.com") === "jobloggs@gmail.com" && mod.mailbox("jo.bloggs+x@example.com") === "jo.bloggs@example.com", "mailbox()");

// 3. Signed in: goes to the account's address, updates kept, unsubscribe link to the app page, one-click to the function.
log.length = 0; state.user = { email: "Me@Example.com" };
r = await post({ ...results, to: "someone@else.com", updates: true }, { authorization: "Bearer a.b.c" });
m = sent.at(-1).body;
ok(m.to[0].email === "me@example.com" && log.some((l) => l[0] === "upsert" && l[2].email === "me@example.com"), "signed in: own address, subscriber kept");
ok(m.htmlContent.includes("https://app.knowyourspend.org/unsubscribe?token=11111111-2222-3333-4444-555555555555") && m.headers?.["List-Unsubscribe"] === "<https://p.supabase.co/functions/v1/kys-unsubscribe?token=11111111-2222-3333-4444-555555555555>", "unsubscribe: page link in the email, one-click header to the function");
state.user = null;

// 4. An older app (no country codes): a plain headline.
r = await post({ ...results, countries: results.countries.map(({ iso, ...c }) => c) });
ok(sent.at(-1).body.subject === "Your KnowYourSpend results: Your spending by owner's country", `older app: ${sent.at(-1).body.subject}`);

// 5. Limit reached → 429, nothing sent.
state.allow = false; const before = sent.length;
r = await post(results);
ok(r.status === 429 && sent.length === before, "limit reached → 429, nothing sent");
state.allow = true;

// 6. Unsubscribe: a GET only redirects to the app's page; a POST (one-click or the page) deletes.
log.length = 0;
const t = "11111111-2222-3333-4444-555555555555";
r = await unsub(new Request(`https://x/?token=${t}`));
ok(r.status === 302 && r.headers.get("location") === `https://app.knowyourspend.org/unsubscribe?token=${t}` && !log.length, `GET → ${r.status} ${r.headers.get("location")}, nothing deleted`);
r = await unsub(new Request(`https://x/?token=${t}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }));
ok(r.status === 200 && log.some((l) => l[0] === "delete" && l[3] === t), "one-click POST deletes");
log.length = 0;
r = await unsub(new Request("https://x/", { method: "POST", headers: { "content-type": "application/json", origin: "https://app.knowyourspend.org" }, body: JSON.stringify({ token: t }) }));
ok(r.status === 200 && r.headers.get("access-control-allow-origin") === "https://app.knowyourspend.org" && log.length === 1, "the app's page POST deletes (CORS for the app)");
r = await unsub(new Request("https://x/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "nope" }) }));
ok(r.status === 400, "a bad token → 400");
