/**
 * Tests the phone app's PDF engine page (src/lib/pdf-engine.ts) in Chromium — the same engine
 * Android's WebView is built on. The page is served at the same fake origin the app gives it, and
 * the test fails if the page makes any network request or if a fixture statement doesn't come out
 * with the expected rows and totals.
 *
 *   pnpm --filter mobile test:pdf-engine            (fixtures from packages/core/test/fixtures)
 *   PDF_EXTRA=/path/to/statement.pdf pnpm ...       (also read a private statement; prints totals only)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { parseWithMapping } from "@kys/statement";
import { readPdfStatement, type PdfJsLike } from "@kys/core/pdf-statement";
import { toB64 } from "@kys/core/backup";
import { PDFJS_MAIN, PDFJS_WORKER } from "../src/lib/pdf-engine.generated";
import { pdfBridge, readStatementPdf } from "../src/lib/pdf";
import { buildPdfEngineHtml, docFromRawPages, PDF_ENGINE_BASE_URL, type EngineMessage, type RawPdfPage } from "../src/lib/pdf-engine";

const fixtures = join(import.meta.dirname, "..", "..", "..", "packages", "core", "test", "fixtures");
const truth = JSON.parse(readFileSync(join(fixtures, "truth.json"), "utf8")) as Record<string, { rows: number; out: number; in: number }>;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage();
const outside: string[] = [];
const messages: EngineMessage[] = [];
await page.exposeFunction("__kysPost", (s: string) => {
  messages.push(JSON.parse(s));
  pdfBridge.onMessage(s); // the phone app's side of the bridge (lib/pdf.ts)
});
const html = buildPdfEngineHtml(PDFJS_MAIN, PDFJS_WORKER);
await page.route("**/*", (route) => {
  const url = route.request().url();
  if (url === PDF_ENGINE_BASE_URL) return route.fulfill({ status: 200, contentType: "text/html", body: html });
  outside.push(url);
  return route.abort();
});
page.on("console", (m) => m.type() === "error" && console.log("[page error]", m.text()));

const waitFor = async <T extends EngineMessage>(pred: (m: EngineMessage) => m is T, ms = 30000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const hit = messages.find(pred);
    if (hit) return hit;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for the engine");
    await new Promise((r) => setTimeout(r, 50));
  }
};

const t0 = Date.now();
await page.goto(PDF_ENGINE_BASE_URL);
const boot = await waitFor((m): m is EngineMessage => m.type === "ready" || m.type === "boot-error");
if (boot.type !== "ready") throw new Error("engine failed to start: " + JSON.stringify(boot));
console.log(`engine ready in ${Date.now() - t0} ms`);

async function read(bytes: Uint8Array, id: string): Promise<RawPdfPage[]> {
  await page.evaluate(([i, b]) => (window as unknown as { __kysReadPdf: (a: string, b: string) => void }).__kysReadPdf(i, b), [id, toB64(bytes)] as const);
  const m = await waitFor((x): x is Extract<EngineMessage, { id: string }> => "id" in x && x.id === id);
  if (m.type === "error") throw new Error(m.message);
  return (m as Extract<EngineMessage, { type: "result" }>).pages;
}

async function statement(bytes: Uint8Array, id: string) {
  const pages = await read(bytes, id);
  const fake: PdfJsLike = { getDocument: () => ({ promise: Promise.resolve(docFromRawPages(pages)) }) };
  const { result } = await readPdfStatement(fake, new ArrayBuffer(0), parseWithMapping);
  const out = result.transactions.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0);
  const inn = result.transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  return { rows: result.transactions.length, out: Math.round(out * 100) / 100, in: Math.round(inn * 100) / 100 };
}

let failed = 0;
for (const f of readdirSync(fixtures).filter((x) => x.endsWith(".pdf"))) {
  const name = f.replace(/\.pdf$/, "");
  const got = await statement(new Uint8Array(readFileSync(join(fixtures, f))), name);
  const want = truth[name];
  const ok = !!want && got.rows === want.rows && got.out === want.out && got.in === want.in;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(got)}${ok ? "" : " want " + JSON.stringify(want)}`);
}

// The phone app's path: readStatementPdf() → bridge → page → bridge → packages/core.
let wantedCalls = 0;
pdfBridge.attach({
  run: (id, b64) => void page.evaluate(([i, b]) => (window as unknown as { __kysReadPdf: (a: string, b: string) => void }).__kysReadPdf(i, b), [id, b64] as const),
  setWanted: () => void wantedCalls++,
});
{
  const bytes = new Uint8Array(readFileSync(join(fixtures, "revolut.pdf")));
  const [a, b] = await Promise.all([readStatementPdf(bytes.slice().buffer), readStatementPdf(bytes.slice().buffer)]);
  const ok = a.transactions.length === truth.revolut.rows && b.transactions.length === truth.revolut.rows && a.bank?.id === "revolut";
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} app bridge: two PDFs at once → ${a.transactions.length} + ${b.transactions.length} rows, bank ${a.bank?.id}`);
  try {
    await readStatementPdf(new TextEncoder().encode("hello").buffer as ArrayBuffer);
    failed++;
    console.log("FAIL app bridge: bad file not rejected");
  } catch (e) {
    const ok2 = (e as Error).message === "pdf-unreadable";
    if (!ok2) failed++;
    console.log(`${ok2 ? "ok  " : "FAIL"} app bridge: bad file → ${(e as Error).message}`);
  }
}

// A file that isn't a PDF comes back as an error, not a hang.
try {
  await read(new TextEncoder().encode("Date,Description,Amount\n"), "not-a-pdf");
  console.log("FAIL not-a-pdf: no error");
  failed++;
} catch {
  console.log("ok   not-a-pdf rejected");
}

if (process.env.PDF_EXTRA) {
  const t1 = Date.now();
  const got = await statement(new Uint8Array(readFileSync(process.env.PDF_EXTRA)), "extra");
  console.log(`extra: ${JSON.stringify(got)} in ${Date.now() - t1} ms`);
}

await browser.close();
if (outside.length) {
  console.log("FAIL outside requests:", outside);
  failed++;
}
console.log(failed ? `${failed} failure(s)` : "pdf engine: all good, no network");
process.exit(failed ? 1 : 0);
