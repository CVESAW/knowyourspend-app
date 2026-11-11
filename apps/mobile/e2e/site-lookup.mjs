/**
 * The website's search box (apps/site), in a real browser against the built site (run `pnpm --filter site build`
 * first). The online look-up is stubbed. Checks what the page sends: nothing for names in the built-in list or for
 * local independents, only the cleaned name for one it doesn't know, nothing for a person's name until asked, and
 * no request to any other site. Lives here because Playwright is installed for the app's tests.
 *   node apps/mobile/e2e/site-lookup.mjs [--shots <dir>]
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "site", "dist");
const cfg = JSON.parse(readFileSync(join(here, "..", "..", "site", "site.config.json"), "utf8"));
const shotsAt = process.argv.indexOf("--shots");
const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".csv": "text/csv", ".py": "text/x-python" };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const candidates = path === "/" ? ["index.html"] : [path.slice(1), `${path.slice(1)}.html`];
  const file = candidates.map((c) => join(dist, c)).find((f) => f.startsWith(dist) && existsSync(f) && !f.endsWith("/"));
  if (!file) return res.writeHead(404).end("not found");
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures++;
};

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
async function run(contextOptions, label) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const sent = [];
  const outside = [];
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE)) return route.continue();
    if (url === cfg.lookupUrl) {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" } });
      const body = JSON.parse(route.request().postData() ?? "{}");
      sent.push(body);
      const name = body.merchants?.[0];
      const results = name === "ZALANDO"
        ? [{ query: name, status: "RESOLVED", via: "wikidata+gleif", trace: [{ step: "cache", status: "miss", detail: "Not asked about before." }, { step: "wikidata+gleif", status: "found", detail: "Wikidata and GLEIF agree on the top company." }],
            entry: { id: "lookup-zalando", display_name: "Zalando", kind: "merchant", aliases: ["ZALANDO"], chain: [{ name: "Zalando", relation: "brand_of", country: "DE", source: "wikidata", source_id: "Q157101", source_url: "https://www.wikidata.org/wiki/Q157101" }, { name: "Zalando SE", relation: "ultimate_parent", country: "DE", source: "gleif" }], owner_country: "DE", tier: "EXACT_ID", technique: "Wikidata + GLEIF", sources: [{ label: "Wikidata Q157101", url: "https://www.wikidata.org/wiki/Q157101" }, { label: "Bad link", url: "javascript:alert(1)" }], as_of: "2026-10-22", reviewed_by: null, reviewed_at: null } }]
        : [{ query: name, status: "NOT_A_BUSINESS", trace: [{ step: "ai", status: "not_found", detail: "Five AI answers took it for a person's name." }] }];
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ results, sources: { ai: true } }) });
    }
    outside.push(url);
    return route.abort();
  });

  const search = async (text) => {
    await page.fill("#q", text);
    await page.click(".box button[type=submit]");
    await page.waitForSelector(".answer:not(.is-waiting)", { timeout: 20_000 });
    return (await page.textContent(".answer")) ?? "";
  };

  await page.goto(`${BASE}/`);
  check((await page.title()).includes("who owns the shops you pay"), `${label}: home page title`);
  await page.fill("#q", "COSTA COFFEE 43012 LONDON GB");
  check((await page.textContent("#sends"))?.includes("“COSTA COFFEE”"), `${label}: shows exactly what a look-up would send`);
  let text = await search("COSTA COFFEE 43012 LONDON GB");
  check(text.includes("The Coca-Cola Company") && text.includes("How we got there") && text.includes("United States"), `${label}: names the owner of a statement line, with how we got there`);
  check(sent.length === 0, `${label}: a name in the built-in list isn't sent`);
  check(page.url().endsWith("#q=COSTA+COFFEE+43012+LONDON+GB"), `${label}: the address keeps the search (after #, so the server never sees it)`);
  if (shots) await page.screenshot({ path: join(shots, `${label}-1-owner.png`), fullPage: true });

  text = await search("SQ *THE BEAN HOUSE");
  check(text.includes("local independent") && sent.length === 0, `${label}: a card-reader name is a local independent and isn't sent`);

  text = await search("WWW.ZALANDO.CO.UK");
  check(sent.length === 1 && JSON.stringify(sent[0]) === JSON.stringify({ merchants: ["ZALANDO"] }), `${label}: an unknown name is sent alone, cleaned: ${JSON.stringify(sent[0])}`);
  check(text.includes("Zalando SE") && text.includes("this page sent just the name"), `${label}: shows the look-up's answer and says what was sent`);
  await page.click("summary:has-text('Sources')");
  const hrefs = await page.$$eval(".sources a", (as) => as.map((a) => a.getAttribute("href")));
  check(hrefs.length === 1 && hrefs[0].startsWith("https://"), `${label}: only https source links are shown`);
  if (shots) await page.screenshot({ path: join(shots, `${label}-2-looked-up.png`), fullPage: true });

  text = await search("BANK TRANSFER TO DAVID JONES");
  check(text.includes("person's name") && sent.length === 1, `${label}: a transfer to a person isn't sent`);
  text = await search("CASH WITHDRAWAL");
  check(text.includes("doesn't look like a payment to a shop") && sent.length === 1, `${label}: cash and own-account lines aren't sent`);

  text = await search("J SMITH");
  check(text.includes("person's name") && sent.length === 1, `${label}: a person's name isn't sent`);
  await page.click("text=It's a business: look it up");
  await page.waitForSelector(".answer.is-not_business", { timeout: 20_000 });
  check(sent.length === 2 && sent[1].merchants[0] === "J SMITH", `${label}: …until the person searching asks`);

  await page.selectOption("#country", "DE");
  await page.click("button[data-q='Boots']");
  await page.waitForSelector(".answer.is-owner");
  check(page.url().includes("c=DE") && (await page.textContent(".answer")).includes("Sycamore Partners"), `${label}: example buttons search, with the country in the address`);

  await page.goto(`${BASE}/#q=PAYPAL+*NETFLIX`);
  await page.waitForSelector(".answer.is-owner");
  check((await page.textContent(".answer")).includes("Netflix, Inc."), `${label}: a shared address runs its search`);

  check((await page.$("a.btn[href$='/add-receipt']")) && (await page.$(".services a[href='/api']")) && (await page.$(".service a[href='/api']")), `${label}: home names the API and has an Add a receipt button`);
  await page.goto(`${BASE}/api`);
  check((await page.textContent("h1")) === "The KnowYourSpend API" && (await page.$("a[href='/data/manifest.json']")) && (await page.$$("pre")).length >= 2, `${label}: API page with examples and the open data`);

  await page.goto(`${BASE}/statements`);
  check((await page.textContent("h1")) === "Check a whole statement or receipt" && (await page.$("#run-it-yourself")) && (await page.$("#privacy")) && (await page.$("#transparency")), `${label}: statements page has try-it-live, run-it-yourself and privacy`);
  check(await page.$("a.btn[href$='/add-receipt']"), `${label}: statements page has an Add a receipt button`);
  // the SHA-256 of the download stays inside its card (it overflowed on 24 Oct)
  const fits = await page.$eval("#run-it-yourself", (card) => {
    const c = card.getBoundingClientRect();
    // inline code only: the command box (pre) scrolls sideways by design
    return [...card.querySelectorAll("p code")].every((e) => { const r = e.getBoundingClientRect(); return r.right <= c.right + 0.5 && r.left >= c.left - 0.5; });
  });
  check(fits, `${label}: the download's SHA-256 stays inside its card`);
  if (shots) await page.screenshot({ path: join(shots, `${label}-3-statements.png`), fullPage: true });

  check(outside.length === 0, `${label}: no requests to other sites${outside.length ? `: ${outside.join(", ")}` : ""}`);
  check(errors.length === 0, `${label}: no console errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  await context.close();
}

try {
  await run({ viewport: { width: 1280, height: 900 } }, "desktop");
  await run({ ...devices["iPhone 13"] }, "phone");
} finally {
  await browser.close();
  server.close();
}
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("All search-box checks passed");
