/**
 * End-to-end smoke test of the exported web app, at phone size, under the production security
 * headers. Run after `pnpm build:web`:  node e2e/smoke.mjs
 * Fails (exit 1) on any broken step, console error, or request to another site — except the shop-name
 * lookup service, which is answered by a stand-in here and must only ever receive {"merchants": [names]}.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium, devices } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const PORT = 8391;
const BASE = process.env.BASE ?? `http://localhost:${PORT}`;
const server = process.env.BASE ? null : spawn(process.execPath, [join(here, "serve.mjs"), join(here, "..", "dist"), String(PORT)], { stdio: "inherit" });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ ...devices["iPhone 13"], acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
const external = new Set();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.location()?.url ? `${m.text()} (${m.location().url})` : m.text()));
const LOOKUP_HOST = "cxvwngmnkxtweuwaxfmz.supabase.co";
const lookupBodies = [];
const emailBodies = [];
const countBodies = [];
const unsubscribes = [];
const userLookups = [];
const vault = { row: null, puts: [] };
const UNSUB_TOKEN = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" };
const reply = (route, status, body) => route.fulfill({ status, contentType: "application/json", headers: CORS, body: JSON.stringify(body) });
await page.route(`https://${LOOKUP_HOST}/**`, async (route) => {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
  const path = new URL(req.url()).pathname;
  const body = JSON.parse(req.postData() ?? "{}");
  // Stand-ins for Supabase Auth (email code), the encrypted account copy and our Edge Functions.
  if (path === "/auth/v1/otp") return reply(route, 200, {});
  if (path === "/auth/v1/verify") return body.token === "123456" ? reply(route, 200, { access_token: "test-token", refresh_token: "test-refresh", expires_in: 3600, user: { id: "user-1", email: body.email } }) : reply(route, 403, { msg: "Token has expired or is invalid" });
  if (path === "/auth/v1/logout") return route.fulfill({ status: 204, headers: CORS });
  // a sign-in link's session is checked here: "token-user-2" belongs to a second account
  if (path === "/auth/v1/user") {
    userLookups.push(req.headers().authorization);
    return req.headers().authorization === "Bearer token-user-2" ? reply(route, 200, { id: "user-2", email: "other@example.com" }) : reply(route, 401, { msg: "invalid JWT" });
  }
  if (path === "/functions/v1/kys-unsubscribe") {
    unsubscribes.push({ body, headers: req.headers() });
    return body.token === UNSUB_TOKEN ? reply(route, 200, { unsubscribed: true }) : reply(route, 404, { error: "not found" });
  }
  if (path === "/rest/v1/kys_vault") {
    if (req.method() === "GET") return reply(route, 200, vault.row ? [vault.row] : []);
    if (req.method() === "DELETE") return (vault.row = null), reply(route, 204, null);
    vault.row = { user_id: body.user_id, blob: body.blob, updated_at: new Date(Date.now() + vault.puts.length).toISOString() };
    vault.puts.push({ ...body, auth: req.headers().authorization });
    return reply(route, 201, [vault.row]);
  }
  if (path === "/functions/v1/kys-email") return emailBodies.push(body), reply(route, 200, { sent: true });
  if (path === "/functions/v1/kys-count") return countBodies.push(body), reply(route, 200, { ok: true });
  if (path === "/functions/v1/kys-account") return (vault.row = null), reply(route, 200, { deleted: true });
  lookupBodies.push(body);
  const results = (body.merchants ?? []).map((q, i) => i === 0
    ? { query: q, status: "RESOLVED", via: "wikidata", trace: [], entry: { id: `lookup-${i}`, display_name: "Test Owner Shop", kind: "merchant", aliases: [q], chain: [{ name: "Test Owner AG", relation: "ultimate_parent", country: "CH", source: "wikidata" }], owner_country: "CH", tier: "NAME_MATCH", technique: "test", sources: [], as_of: "2026-10-07", reviewed_by: null, reviewed_at: null } }
    : { query: q, status: "UNRESOLVED", trace: [] });
  return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ results }) });
});
page.on("request", (r) => {
  const u = new URL(r.url());
  if (u.host === LOOKUP_HOST) return;
  if (!BASE.includes(u.host) && !["data:", "blob:"].includes(u.protocol)) external.add(u.host);
});
const tid = (id) => page.getByTestId(id).filter({ visible: true }).first();
const vis = (sel) => page.locator(sel).filter({ visible: true });
const step = (s) => console.log("✓", s);
let failed = false;

try {
  const first = await page.goto(BASE);
  const csp = first?.headers()["content-security-policy"] ?? "";
  if (!/script-src 'self'/.test(csp) || /script-src[^;]*'unsafe-inline'/.test(csp)) throw new Error(`production CSP not applied, or allows inline scripts: "${csp}"`);
  await tid("empty-home").waitFor();
  step("empty home (production headers; no inline scripts allowed)");

  await tid("try-demo").click();
  await tid("score-tiles").waitFor({ timeout: 30000 });
  for (const v of ["bars", "map", "time", "pie"]) await tid(`chart-tab-${v}`).click();
  step("demo + all four charts");
  // "Who you pay most": tapping a shop says why it counts where it does
  await vis('[data-testid^="top-"]').first().click();
  await tid("why-sheet").waitFor();
  if (!(await tid("why-headline").textContent())?.trim()) throw new Error("why sheet without a headline");
  await tid("why-close").click();
  await tid("why-sheet").waitFor({ state: "hidden" });
  step("tap a top shop → why it counts there");
  await tid("exit-demo").click();
  await tid("empty-home").waitFor();
  // the website's "Try a sample statement" button
  await page.goto(`${BASE}/?demo=1`);
  await tid("demo-banner").waitFor({ timeout: 30000 });
  if (page.url().includes("demo=1")) throw new Error(`demo link left in the address: ${page.url()}`);
  await tid("exit-demo").click();
  await tid("empty-home").waitFor();
  step("website's sample-statement link opens the demo");

  // CSV statement: no bank to choose first; the bank is read from the file (18 Oct 2026), and the download help is optional
  await tid("add-button").click();
  await tid("choose-statement").click();
  await tid("statement-help").click();
  await tid("bank-monzo").click();
  await tid("guide-monzo").waitFor();
  step("statement help shows a bank's download steps");
  let [fc] = await Promise.all([page.waitForEvent("filechooser"), tid("choose-file").click()]);
  await fc.setFiles(join(repo, "packages/statement/test/fixtures/monzo.csv"));
  await tid("statement-check").waitFor();
  const detected = (await tid("statement-bank").textContent()) ?? "";
  if (!detected.startsWith("Monzo")) throw new Error(`bank not read from the file: "${detected}"`);
  const willLookUp = await tid("lookup-toggle").isVisible();
  await tid("confirm-statement").click();
  await tid("report-summary").waitFor();
  if (lookupBodies.length !== (willLookUp ? 1 : 0)) throw new Error(`expected ${willLookUp ? 1 : 0} lookup request(s), got ${lookupBodies.length}`);
  for (const b of lookupBodies) {
    // names only: "merchants", and optionally "again" (a subset of them the app asked about before)
    const keys = Object.keys(b).join();
    if ((keys !== "merchants" && keys !== "merchants,again") || !b.merchants.every((n) => typeof n === "string" && !/\d+\.\d{2}/.test(n)) || (b.again ?? []).some((n) => !b.merchants.includes(n))) throw new Error(`lookup body carried more than names: ${JSON.stringify(b)}`);
  }
  step(`CSV statement, bank read from the file → report (${willLookUp ? `looked up ${lookupBodies[0].merchants.length} unknown shop names, names only` : "every shop recognised, nothing sent"})`);
  // Tap a shop: "Why this country?" explains the answer, and the country can be set by hand from there
  const shopRow = page.locator('[data-testid^="shop-"]').filter({ visible: true }).first();
  await shopRow.click();
  await tid("why-sheet").waitFor();
  const whyLabel = (await tid("why-label").textContent())?.trim();
  if (!whyLabel || !(await tid("why-headline").textContent())?.trim()) throw new Error("why sheet without a label or headline");
  await tid("why-set-country").click();
  await tid("country-picker").waitFor();
  await tid("country-search").fill("Ice");
  await tid("pick-IS").click();
  await page.getByText("your choice").first().waitFor();
  step(`tap a shop → why it counts there ("${whyLabel}") → set its country by hand`);

  // web only: once there's real data, suggest the home screen and a backup; "Not now" hides it
  await page.goto(BASE);
  await tid("keep-safe-card").waitFor();
  await tid("keep-safe-dismiss").click();
  await tid("keep-safe-card").waitFor({ state: "detached" });
  step("home-screen / backup card shows, and 'Not now' hides it");
  // the shop just set by hand: its row in "Who you pay most" opens "Why this country?" too (it opened nothing before 18 Oct)
  await vis('[data-testid^="top-you:"]').first().click();
  await tid("why-sheet").waitFor();
  if ((await tid("why-label").textContent())?.trim() !== "You set this") throw new Error("a row you set opened the wrong explanation");
  await tid("why-close").click();
  await tid("why-sheet").waitFor({ state: "hidden" });
  step("a row you set yourself opens why it counts there");

  // PDF statement
  await page.goto(`${BASE}/add-statement`);
  await tid("add-statement").waitFor();
  [fc] = await Promise.all([page.waitForEvent("filechooser"), tid("choose-file").click()]);
  await fc.setFiles(join(repo, "packages/core/test/fixtures/revolut-2026.pdf"));
  await tid("statement-check").waitFor({ timeout: 30000 });
  if (!((await tid("statement-bank").textContent()) ?? "").startsWith("Revolut")) throw new Error("PDF statement: bank not read from the file");
  await tid("confirm-statement").click();
  await tid("report-summary").waitFor();
  step("PDF statement, bank read from the file → report");

  // receipt photo (on-device OCR)
  await page.goto(`${BASE}/add-receipt`);
  [fc] = await Promise.all([page.waitForEvent("filechooser"), tid("receipt-library").click()]);
  await fc.setFiles(join(here, "fixtures/receipt-tesco.jpg"));
  await tid("receipt-confirm").waitFor({ timeout: 120000 });
  const brands = (await vis('[data-testid="receipt-line-brand"]').allInnerTexts()).filter((t) => !t.startsWith("Own-brand"));
  if (brands.length < 4) throw new Error(`receipt: only ${brands.length} brands recognised`);
  await tid("confirm-receipt").click();
  await tid("report-summary").waitFor();
  step(`receipt OCR → ${brands.length} brands`);

  // share card
  await tid("share-open").click();
  const [dl] = await Promise.all([page.waitForEvent("download"), tid("share-now").click()]);
  if (!dl.suggestedFilename().endsWith(".png")) throw new Error("share card download");
  step("share card image");

  // encrypted backup round trip
  await page.goto(`${BASE}/settings`);
  await tid("backup-pass").fill("correct horse battery");
  const [bk] = await Promise.all([page.waitForEvent("download"), tid("backup-save").click()]);
  const bpath = join(here, ".backup-test.json");
  await bk.saveAs(bpath);
  if (readFileSync(bpath, "utf8").includes("TESCO")) throw new Error("backup is not encrypted");
  await tid("wipe").click();
  await tid("confirm-wipe").click();
  await tid("empty-home").waitFor();
  await page.goto(`${BASE}/settings`);
  await tid("backup-pass").fill("correct horse battery");
  [fc] = await Promise.all([page.waitForEvent("filechooser"), tid("backup-restore").click()]);
  await fc.setFiles(bpath);
  await page.waitForFunction(() => /Restored 3 items/.test(document.body.innerText), null, { timeout: 60000 });
  step("encrypted backup → wipe → restore (3 items)");

  // anonymous counts (off by default) and "Email me my results" — no account needed
  await page.goto(`${BASE}/settings`);
  if (countBodies.length) throw new Error("counts were sent while switched off");
  await tid("share-counts").click();
  // the setting is saved to IndexedDB asynchronously: give it a moment before the full page load below
  await page.waitForTimeout(800);
  await page.goto(BASE);
  await tid("email-results").click();
  await tid("email-preview").waitFor();
  await tid("email-to").fill("test@example.com");
  // updates can only be asked for when signed in
  if (await page.getByTestId("email-updates").count()) throw new Error("updates offered without an account");
  await tid("email-updates-sign-in").waitFor();
  await tid("email-send").click();
  await tid("email-sent").waitFor();
  const eb = emailBodies[0];
  if (emailBodies.length !== 1 || Object.keys(eb).sort().join() !== "countries,headline,period,shops,to,updates" || eb.updates !== false) throw new Error(`email request: ${JSON.stringify(eb)}`);
  if (/£|amount|balance|\d{2}\/\d{2}/i.test(JSON.stringify(eb))) throw new Error(`email carried more than percentages and shop names: ${JSON.stringify(eb)}`);
  if (!eb.countries.every((c) => (c.name === "Other countries" ? c.iso === undefined : /^[A-Z]{2}$/.test(c.iso)))) throw new Error(`email countries without ISO codes: ${JSON.stringify(eb.countries)}`);
  // the count is sent in the background after the email, so allow it a few seconds to arrive
  for (let i = 0; i < 50 && !countBodies.length; i++) await page.waitForTimeout(100);
  if (countBodies.map((b) => JSON.stringify(b)).join() !== '{"event":"results_emailed"}') throw new Error(`counts: ${JSON.stringify(countBodies)}`);
  await tid("email-done").click();
  step(`results emailed (${eb.countries.length} countries, ${eb.shops.length} shops, no amounts); one anonymous count`);

  // optional account: sign in with a code, choose a passphrase, encrypted copy saved
  await page.goto(`${BASE}/settings`);
  await tid("open-account").click();
  await tid("account-email").fill("test@example.com");
  await tid("account-send-code").click();
  await tid("account-code").fill("123456");
  await tid("account-verify").click();
  await tid("account-pass").fill("a long passphrase");
  await tid("account-pass2").fill("a long passphrase");
  await tid("account-understood").click();
  await tid("account-create").click();
  await tid("account-done").waitFor({ timeout: 30000 });
  const blob = vault.row?.blob ?? "";
  if (!blob.includes("kys-vault-v1") || /TESCO|MONZO|Tesco|items|transactions/.test(blob)) throw new Error("account copy is not encrypted");
  step("account: email code → passphrase → encrypted copy saved");

  // signed in: the results email can now ask for updates
  await page.goto(BASE);
  await tid("email-results").click();
  await tid("email-updates").click();
  await tid("email-send").click();
  await tid("email-sent").waitFor();
  if (emailBodies.length !== 2 || emailBodies[1].updates !== true) throw new Error(`signed-in email with updates: ${JSON.stringify(emailBodies[1])}`);
  await tid("email-done").click();
  step("signed in: results emailed with updates");

  // a sign-in link this device didn't ask for is ignored, and taken out of the address
  await page.goto(`${BASE}/settings#access_token=token-user-2&refresh_token=r2&expires_in=3600&token_type=bearer&type=magiclink`);
  await tid("account-status").waitFor();
  if (page.url().includes("access_token")) throw new Error(`sign-in tokens left in the address: ${page.url()}`);
  if (userLookups.length) throw new Error("an unrequested sign-in link was used");
  if (!(await page.getByText("test@example.com").count())) throw new Error("an unrequested sign-in link changed the account");
  step("a sign-in link this device didn't ask for is ignored");

  // a link for a different account (after this device asked for one): the first account's key is dropped
  await page.waitForLoadState("networkidle"); // let this page's own save to the first account finish
  const putsBefore = vault.puts.length;
  await page.evaluate(() => new Promise((resolve, reject) => {
    const r = indexedDB.open("kys-expo", 1);
    r.onsuccess = () => {
      const tx = r.result.transaction("kv", "readwrite");
      tx.objectStore("kv").put(String(Date.now()), "kys.account.pending");
      tx.oncomplete = () => (r.result.close(), resolve(null));
      tx.onerror = () => reject(tx.error);
    };
    r.onerror = () => reject(r.error);
  }));
  await page.goto(`${BASE}/settings#access_token=token-user-2&refresh_token=r2&expires_in=3600&token_type=bearer&type=magiclink`);
  await page.getByText("other@example.com").first().waitFor();
  await tid("open-account").waitFor(); // signed in, but no copy open
  if (await page.getByTestId("account-status").count()) throw new Error("the first account's copy is still open for the second account");
  await page.waitForTimeout(3000); // longer than the autosave delay
  if (vault.puts.slice(putsBefore).length || vault.puts.some((p) => p.user_id !== "user-1" || p.auth !== "Bearer test-token")) throw new Error(`data pushed after another account signed in: ${JSON.stringify(vault.puts.slice(putsBefore).map((p) => [p.user_id, p.auth]))}`);
  step("another account's sign-in link: the first account's key is forgotten, nothing pushed to it");

  // a second "device": sign out, wipe this one, sign in again and open the copy
  await page.goto(`${BASE}/settings`);
  await tid("sign-out").click();
  await tid("wipe").click();
  await tid("confirm-wipe").click();
  await tid("empty-home").waitFor();
  await page.goto(`${BASE}/settings`);
  await tid("open-account").click();
  await tid("account-email").fill("test@example.com");
  await tid("account-send-code").click();
  await tid("account-code").fill("123456");
  await tid("account-verify").click();
  await tid("account-unlock-pass").fill("not the passphrase");
  await tid("account-unlock").click();
  await page.getByText("Wrong passphrase").first().waitFor();
  await tid("account-unlock-pass").fill("a long passphrase");
  await tid("account-unlock").click();
  await tid("account-done").waitFor({ timeout: 30000 });
  await page.goto(BASE);
  await tid("items-list").waitFor();
  const n = await vis('[data-testid^="item-statement"], [data-testid^="item-receipt"]').count();
  if (n !== 3) throw new Error(`after opening the account copy: ${n} items, expected 3`);
  step("account copy opened on a wiped device (3 items; wrong passphrase refused)");

  await page.goto(`${BASE}/settings`);
  await tid("delete-account").click();
  await tid("confirm-delete-account").click();
  await tid("open-account").waitFor();
  if (vault.row) throw new Error("account copy not deleted");
  step("account deleted; this device's data kept");

  // unsubscribe link from an update email: nothing is sent until the button is pressed
  await page.goto(`${BASE}/unsubscribe?token=not-a-token`);
  await tid("unsubscribe-invalid").waitFor();
  if (await page.getByTestId("unsubscribe-button").count()) throw new Error("unsubscribe offered for a malformed token");
  await page.goto(`${BASE}/unsubscribe?token=00000000-0000-4000-8000-000000000000`);
  await tid("unsubscribe-button").click();
  await tid("unsubscribe-error").waitFor();
  await page.goto(`${BASE}/unsubscribe?token=${UNSUB_TOKEN}`);
  await tid("unsubscribe-button").waitFor();
  await page.waitForTimeout(1000);
  if (unsubscribes.length !== 1) throw new Error(`unsubscribe sent without a tap (${unsubscribes.length} requests)`);
  await tid("unsubscribe-button").click();
  await tid("unsubscribe-done").waitFor();
  const u = unsubscribes[1];
  if (unsubscribes.length !== 2 || JSON.stringify(u.body) !== JSON.stringify({ token: UNSUB_TOKEN }) || u.headers["content-type"] !== "application/json" || u.headers.authorization || u.headers.apikey) throw new Error(`unsubscribe request: ${JSON.stringify(unsubscribes)}`);
  await tid("unsubscribe-home").click();
  await tid("items-list").waitFor();
  step("unsubscribe page: checks the token, sends only it, and only on a tap");

  // offline
  await page.goto(BASE);
  await tid("items-list").waitFor();
  await page.evaluate(async () => navigator.serviceWorker && (await navigator.serviceWorker.ready));
  await ctx.setOffline(true);
  await page.reload();
  await tid("items-list").waitFor({ timeout: 20000 });
  await ctx.setOffline(false);
  step("works offline");

  // "Delete all my data" from inside the demo deletes the real data too
  await page.goto(`${BASE}/?demo=1`);
  await tid("demo-banner").waitFor({ timeout: 30000 });
  await page.goto(`${BASE}/settings`);
  await tid("wipe").click();
  await tid("confirm-wipe").click();
  await tid("empty-home").waitFor();
  await page.reload();
  await tid("empty-home").waitFor();
  if (await page.getByTestId("demo-banner").count()) throw new Error("still in the demo after deleting everything");
  const left = await page.evaluate(() => new Promise((resolve, reject) => {
    const r = indexedDB.open("kys-expo", 1);
    r.onsuccess = () => {
      const tx = r.result.transaction("kv", "readonly");
      const all = tx.objectStore("kv").getAllKeys();
      tx.oncomplete = () => (r.result.close(), resolve(all.result));
      tx.onerror = () => reject(tx.error);
    };
    r.onerror = () => reject(r.error);
  }));
  const kept = left.filter((k) => /^kys\.(demo\.|mode$|bank$|account\.)/.test(k) || (/^kys\.real\.(items|txns|lines)$/.test(k)));
  if (kept.length) throw new Error(`left on the device after deleting everything: ${kept.join(", ")}`);
  step("delete everything from the demo: real and demo data, mode and bank all gone");
} catch (e) {
  failed = true;
  console.error("✗", e.message);
  await page.screenshot({ path: join(here, "failure.png") }).catch(() => {});
}

// expected: offline reloads, and the unsubscribe step's deliberately unknown token (answered 404)
const realErrors = errors.filter((e) => !/ERR_INTERNET_DISCONNECTED/.test(e) && !/status of 404 .*\/functions\/v1\/kys-unsubscribe\)$/.test(e));
if (external.size) (failed = true), console.error("✗ requests to other sites:", [...external].join(", "));
if (realErrors.length) (failed = true), console.error("✗ console errors:", realErrors.join(" / "));
if (!failed) console.log("All smoke checks passed — no requests to other sites, no errors.");
await browser.close();
server?.kill();
process.exit(failed ? 1 : 0);
