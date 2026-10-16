/**
 * Checks the built site (run after build.mjs): every page exists and has a title, there are no inline
 * scripts (the CSP forbids them), and nothing loads from another site. Links out are allowed only to
 * the stores, the web app, our source code on GitHub, and the sources the privacy notice cites.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "dist");
const cfg = JSON.parse(readFileSync(join(dist, "..", "site.config.json"), "utf8"));
const LINK_OK = [cfg.webAppUrl, cfg.sourceUrl, "https://apps.apple.com/", "https://play.google.com/", "https://developers.google.com/ml-kit/", "https://ico.org.uk/", `mailto:${cfg.contactEmail}`];
let bad = 0;
const fail = (m) => { console.error("✗", m); bad++; };

for (const p of ["index", "privacy", "terms", "support", "404"]) {
  let html;
  try { html = readFileSync(join(dist, `${p}.html`), "utf8"); } catch { fail(`${p}.html missing`); continue; }
  if (!/<title>[^<]{10,}<\/title>/.test(html)) fail(`${p}: no title`);
  if (/<script(?![^>]*\ssrc=)[^>]*>/.test(html)) fail(`${p}: inline script`);
  if (/\sstyle="/.test(html)) fail(`${p}: inline style attribute`);
  for (const [, url] of html.matchAll(/\s(?:src|href)="([^"]+)"/g)) {
    if (url.startsWith("/") || url.startsWith("#")) continue;
    if (url.startsWith(cfg.origin)) continue;
    if (!LINK_OK.some((ok) => url.startsWith(ok))) fail(`${p}: unexpected link or resource ${url}`);
  }
  for (const [, url] of html.matchAll(/\ssrc="([^"]+)"/g)) if (!url.startsWith("/")) fail(`${p}: loads ${url} from another site`);
  if (/\[to (follow|confirm)\]|\[company number/.test(html)) console.log(`• ${p}: has placeholders to fill before launch`);
}
if (!readdirSync(dist).includes("sample-statement.csv")) fail("sample statement missing");
if (bad) process.exit(1);
console.log("✓ site checks passed");
