/**
 * Builds the KnowYourSpend website into dist/: the landing page, the privacy notice and terms (from
 * legal/*.md at the repo root, so there is one copy of each), a help page, and the sample statement.
 * Plain Node, no dependencies:  node build.mjs
 *
 * Settings come from site.config.json; these environment variables override them on Vercel:
 *   SITE_APP_STORE_ID   numeric App Store id once the iPhone app is live
 *   SITE_APPLE_PT       App Store Connect provider token, for campaign links
 *   SITE_PLAY_LIVE      "1" once the Android app is live on Google Play
 *   SITE_META_PIXEL_ID  Meta Pixel id; without it there is no cookie banner and no pixel
 */
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const out = join(here, "dist");
const cfg = JSON.parse(readFileSync(join(here, "site.config.json"), "utf8"));
const env = process.env;
if (env.SITE_APP_STORE_ID) cfg.appStoreId = env.SITE_APP_STORE_ID;
if (env.SITE_APPLE_PT) cfg.appleProviderToken = env.SITE_APPLE_PT;
if (env.SITE_PLAY_LIVE) cfg.playLive = env.SITE_PLAY_LIVE === "1";
if (env.SITE_META_PIXEL_ID) cfg.metaPixelId = env.SITE_META_PIXEL_ID;
if (cfg.metaPixelId && !/^\d{6,20}$/.test(String(cfg.metaPixelId))) throw new Error("Meta Pixel id must be digits");
if (cfg.appStoreId && !/^\d{6,12}$/.test(String(cfg.appStoreId))) throw new Error("App Store id must be digits");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "assets"), { recursive: true });

// ── Assets with content hashes, so they can be cached for a year ─────────────────────────────
const asset = (file) => {
  const buf = readFileSync(join(here, "src", file));
  const h = createHash("sha256").update(buf).digest("hex").slice(0, 10);
  const name = file.replace(/(\.\w+)$/, `.${h}$1`);
  writeFileSync(join(out, "assets", name), buf);
  return `/assets/${name}`;
};
const CSS = asset("site.css");
const JS = asset("site.js");
const JS_FLAG = asset("js.js");
cpSync(join(here, "public"), out, { recursive: true });

// ── Tiny Markdown renderer for our own legal pages (headings, lists, tables, links, bold) ────
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const inline = (s) =>
  esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*|mailto:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s(])(https:\/\/[^\s<)]+[^\s<).,;:])/g, '$1<a href="$2">$2</a>')
    .replace(/(^|[\s(])([a-z0-9.]+@knowyourspend\.org)/g, '$1<a href="mailto:$2">$2</a>')
    .replace(/(^|[\s(])(ico\.org\.uk\/make-a-complaint)/g, '$1<a href="https://$2">$2</a>');

function markdown(src) {
  const meta = {};
  const fm = src.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m) meta[m[1]] = m[2];
    }
    src = src.slice(fm[0].length);
  }
  const lines = src.split("\n");
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const h = l.match(/^(#{1,3}) (.*)$/);
    if (h) { html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const [head, , ...bodyRows] = rows;
      html.push(`<table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${bodyRows
        .map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`);
      continue;
    }
    const list = l.match(/^(\s*)(- |\d+\. )/);
    if (list) {
      const ordered = /\d/.test(list[2]);
      const items = [];
      while (i < lines.length && (/^(- |\d+\. )/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (/^(- |\d+\. )/.test(lines[i])) items.push(lines[i].replace(/^(- |\d+\. )/, ""));
        else items[items.length - 1] += " " + lines[i].trim();
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      html.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${tag}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#|\||- |\d+\. )/.test(lines[i])) para.push(lines[i++].trim());
    html.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return { meta, html: html.join("\n") };
}

// ── Facts shown on the page, read from the data the app ships with ────────────────────────────
const ownData = join(repo, "packages", "ownership", "data");
const brandCount =
  JSON.parse(readFileSync(join(ownData, "merchants.json"), "utf8")).length +
  JSON.parse(readFileSync(join(ownData, "open-brands.json"), "utf8")).brands.length;
const BRANDS = (Math.floor(brandCount / 500) * 500).toLocaleString("en-GB"); // "over 6,500"

// ── Calls to action ───────────────────────────────────────────────────────────────────────────
const ios = cfg.appStoreId
  ? `https://apps.apple.com/gb/app/id${cfg.appStoreId}?mt=8${cfg.appleProviderToken ? `&pt=${cfg.appleProviderToken}` : ""}&ct=website`
  : null;
const android = cfg.playLive ? `https://play.google.com/store/apps/details?id=${cfg.playPackage}` : null;
const storesLive = !!(ios || android);
// Web-first: "Add my statement" goes straight to the statement screen in the web app, and "Try a
// sample statement" opens the demo (made-up data) in one tap — neither needs an account. Store
// buttons appear only once a store app is live.
const ctas = `<div class="ctas">
  ${ios ? `<a class="btn primary" data-store="ios" href="${ios}">Get the iPhone app</a>` : ""}
  ${android ? `<a class="btn primary" data-store="android" href="${android}">Get the Android app</a>` : ""}
  <a class="btn ${storesLive ? "" : "primary"}" data-store="web" data-cta="add" href="${cfg.webAppUrl}/add-statement">${storesLive ? "Add a statement in your browser" : "Add my statement"}</a>
  <a class="btn" data-store="web" data-cta="demo" href="${cfg.webAppUrl}/?demo=1">Try a sample statement</a>
</div>`;

// ── Page shell ────────────────────────────────────────────────────────────────────────────────
const year = new Date().getFullYear();
const page = ({ title, description, path, main, bodyClass = "" }) => `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${cfg.origin}${path}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="KnowYourSpend">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${cfg.origin}${path}">
<meta property="og:image" content="${cfg.origin}/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#8c2f39">
<link rel="icon" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="${cfg.webAppUrl}">
<link rel="stylesheet" href="${CSS}">
<script src="${JS_FLAG}"></script>
<script src="${JS}" defer></script>
</head>
<body class="${bodyClass}"${cfg.metaPixelId ? ` data-pixel="${cfg.metaPixelId}"` : ""}>
<header class="top"><div class="wrap"><a class="wordmark" href="/">KnowYourSpend</a><a class="open" data-store="web" data-cta="header" href="${cfg.webAppUrl}/">Open the app</a></div></header>
<main class="wrap">
${main}
</main>
<footer><div class="wrap">
<nav aria-label="Site">
  <a href="/privacy">Privacy notice</a>
  <a href="/terms">Terms of use</a>
  <a href="/support">Help and contact</a>
  <a href="/#transparency">Where your data goes</a>
  <a href="${cfg.sourceUrl}">Source code</a>
  ${cfg.metaPixelId ? `<button class="linkish" type="button" data-cookie-settings>Cookie settings</button>` : ""}
</nav>
<p>Estimates based on published ownership data; may contain errors. <a href="mailto:${cfg.contactEmail}?subject=Ownership%20mistake">Report a mistake</a>. Brand names are used for identification only; no affiliation or endorsement. KnowYourSpend doesn't give financial advice.</p>
<p>© ${year} ${esc(cfg.company)}. ${esc(cfg.contactEmail)}</p>
</div></footer>
${cfg.metaPixelId ? `<div class="consent" id="consent" role="dialog" aria-label="Cookie choice" hidden>
  <p>Can we use a Meta cookie to see which of our ads brought you here? It's only on this website, never in the app. Say no and nothing is loaded.</p>
  <div class="row"><button type="button" data-yes>Accept</button><button type="button" data-no>Reject</button></div>
</div>` : ""}
</body>
</html>
`;

const write = (path, html) => {
  const file = path === "/" ? "index.html" : `${path.slice(1)}.html`;
  writeFileSync(join(out, file), html);
};

// Landing page
const landing = readFileSync(join(here, "src", "index.html"), "utf8")
  .replaceAll("{{CTAS}}", ctas)
  .replaceAll("{{BRANDS}}", BRANDS)
  .replaceAll("{{EMAIL}}", cfg.contactEmail)
  .replaceAll("{{APP}}", cfg.webAppUrl)
  .replaceAll("{{SOURCE}}", cfg.sourceUrl)
  .replaceAll("{{SOURCE_LABEL}}", cfg.sourceUrl.replace(/^https:\/\//, ""));
if (/\{\{\w+\}\}/.test(landing)) throw new Error("landing page has an unfilled {{placeholder}}");
write("/", page({
  title: "KnowYourSpend: see which countries own the shops you pay",
  description: "Add a bank statement and see your spending by the country that owns each business. Free, no account, read on your phone: amounts, dates and balances never leave it.",
  path: "/",
  main: landing,
  bodyClass: "home",
}));

// Legal pages from the one copy in legal/
for (const [path, file, description] of [
  ["/privacy", "privacy-notice.md", "What KnowYourSpend keeps on your phone, the little that leaves it, and your rights."],
  ["/terms", "terms.md", "The terms for using the KnowYourSpend app and website."],
]) {
  const { meta, html } = markdown(readFileSync(join(repo, "legal", file), "utf8"));
  const draft = /^draft/i.test(meta.status ?? "") ? `<p class="draft">${esc(meta.status)}</p>` : "";
  const body = html.replace(/<h1>(.*?)<\/h1>/, `<h1>$1</h1>\n<p class="updated">Last updated ${esc(meta.updated ?? "")}</p>\n${draft}`);
  write(path, page({ title: `${meta.title} | KnowYourSpend`, description, path, main: `<article class="doc">${body}</article>` }));
}

// Help page
const help = markdown(`# Help and contact

## Does my statement get uploaded?

No. KnowYourSpend reads it on your phone, or in your browser if you use the web version. Amounts, dates,
balances and account numbers stay on your device. What can leave is the name of a shop the app doesn't
know, so it can look up the owner; filters hold back names that look like a person or something
sensitive. You can switch look-ups off in Settings → Shops we don't know.

## How do I get a statement from my bank?

In your banking app or online banking, look for Statements, choose a month, and save it as a PDF, or
export your transactions as a CSV. The app's + button has step-by-step guides for 13 banks, including
Monzo, Starling, Revolut, Barclays, Lloyds, NatWest, Nationwide and Santander.

## A shop has the wrong country. What can I do?

Tap the shop in the report and choose "Which country is this?" to set it yourself; your choice stays on
your phone. Please also tell us at hello@knowyourspend.org so we can look into it and fix it for
everyone.

## What does "Estimated" mean?

For a shop we can't link to an owner, the app counts it under the country where you paid, read from the
country code, town or web address your bank prints. A small café in Lewisham is almost always UK-owned.
You can switch estimates off in Settings.

## What do "Checked", "Matched" and "Unverified" mean?

How sure we are about the owner. Checked: a person verified each step. Matched: worked out from
official company identifiers that agree, or found by name in an open dataset. Unverified: a best guess,
often from AI, labelled so you can tell.

## Do I need to install anything?

No. KnowYourSpend runs in your phone's browser. To open it like an app, add it to your home screen: in
Safari tap Share, then "Add to Home Screen"; in Chrome choose "Install app" or "Add to Home screen".
That also helps your browser keep your data, which lives on your phone. Saving an encrypted backup
(Settings → Back up or move your data) or an encrypted copy in an optional account (Settings → Your
account) gives you a copy you control.

## Can I keep my results?

Yes. Tap "Email me my results" to send yourself the percentages and the well-known shops you pay most
(never amounts, dates or balances). No account needed; we use your address to send that email and
don't keep it unless you ask for updates. To open your data on another phone or computer, sign in with
your email in Settings → Your account and choose a passphrase. Your data is encrypted with it on your
device before it's saved, so we can't read it, and if you forget the passphrase we can't recover it.

## How do I delete my data?

Settings → Delete all my data. Your data is on your device, so that deletes the app's copy of it,
including any temporary copies of files you picked. Deleting the app, or clearing the site's data in
your browser, does the same. Backups you saved elsewhere stay where you put them. If you made an
account, Settings → Delete my account deletes it and its encrypted copy.

## Is it free?

Yes. There are no ads and no in-app purchases, and you don't need an account.

## Contact

Email hello@knowyourspend.org. We aim to reply within two working days.
`);
write("/support", page({ title: "Help and contact | KnowYourSpend", description: "Answers to common questions about KnowYourSpend, and how to contact us.", path: "/support", main: `<article class="doc">${help.html}</article>` }));

write("/404", page({ title: "Page not found | KnowYourSpend", description: "This page doesn't exist.", path: "/404", main: `<article class="doc"><h1>This page doesn't exist</h1><p><a href="/">Go to the home page</a></p></article>` }));

writeFileSync(join(out, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${cfg.origin}/sitemap.xml\n`);
writeFileSync(join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${["/", "/privacy", "/terms", "/support"].map((p) => `<url><loc>${cfg.origin}${p}</loc></url>`).join("")}</urlset>\n`);

console.log(`Built ${readdirSync(out).length} entries in dist/ (pixel: ${cfg.metaPixelId ? "on, behind consent" : "off"}; iPhone: ${ios ? "live" : "not yet"}; Android: ${android ? "live" : "not yet"})`);
