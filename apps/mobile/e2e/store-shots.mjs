/**
 * Store screenshots and the Play feature graphic, made from the exported web app's demo data.
 * Run after `pnpm build:web`:  node e2e/store-shots.mjs
 * Writes store/screenshots/{ios,android}/raw-*.png (the app alone) and NN-*.png (with a caption),
 * plus store/screenshots/play-feature-graphic.png.
 *
 * Brand names are kept out of the store images: only country-level views are used, so nothing
 * here is a brand-level statement (COPY-GUIDE.md, publication gate).
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "store", "screenshots");
const PORT = 8394;
const BASE = `http://localhost:${PORT}`;
const server = spawn(process.execPath, [join(here, "serve.mjs"), join(here, "..", "dist"), String(PORT)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

const SHOTS = [
  { id: "pie", caption: "See which countries own the shops you pay" },
  { id: "ranked", caption: "Every country, ranked by your spending" },
  { id: "map", caption: "Your spending on the map, by owner" },
  { id: "report", caption: "Each statement gets its own report" },
  { id: "privacy", caption: "Amounts, dates and balances stay on your phone" },
];

/** Device sizes: Apple 6.9" (1290×2796) and a 9:16 Android phone (1080×1920). */
const DEVICES = [
  { name: "ios", viewport: { width: 430, height: 932 }, scale: 3 },
  { name: "android", viewport: { width: 360, height: 640 }, scale: 3 },
];

async function capture(device) {
  const dir = join(OUT, device.name);
  mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: device.viewport, deviceScaleFactor: device.scale, isMobile: true, hasTouch: true, colorScheme: "light", locale: "en-GB" });
  const page = await ctx.newPage();
  const tid = (id) => page.getByTestId(id).filter({ visible: true }).first();
  const hideBanner = () => page.addStyleTag({ content: '[data-testid="demo-banner"]{display:none!important}' });
  const snap = async (id) => { await page.waitForTimeout(900); await page.screenshot({ path: join(dir, `raw-${id}.png`) }); };

  await page.goto(BASE);
  await tid("try-demo").click();
  await tid("score-tiles").waitFor({ timeout: 30000 });
  await hideBanner();
  await snap("pie");
  await tid("chart-tab-bars").click();
  await snap("ranked");
  await tid("chart-tab-map").click();
  await snap("map");
  await tid("chart-tab-pie").click();
  await tid("item-statement").click();
  await tid("report-summary").waitFor();
  await snap("report");
  await page.goto(`${BASE}/privacy`);
  await page.getByText("What we can see").first().waitFor();
  await snap("privacy");
  await ctx.close();
}

const PAPER = "#f6f1e7", OXBLOOD = "#8c2f39", INK = "#1c1b19";

/** A caption above the app screen, which runs off the bottom edge like a phone held up. */
function framed(w, h, caption, png) {
  const pad = Math.round(w * 0.085);
  const capH = Math.round(h * 0.22);
  const shotW = w - pad * 2;
  const font = Math.round(w * 0.072);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${OXBLOOD}}
    h1{position:absolute;left:${pad}px;right:${pad}px;top:0;height:${capH}px;margin:0;display:flex;align-items:flex-end;padding-bottom:${Math.round(h * 0.03)}px;box-sizing:border-box;
       font:400 ${font}px/1.12 Georgia,'Times New Roman',serif;color:${PAPER};letter-spacing:-0.01em;text-wrap:balance}
    .phone{position:absolute;left:${pad - 14}px;top:${capH}px;width:${shotW + 28}px;border-radius:${Math.round(w * 0.06)}px ${Math.round(w * 0.06)}px 0 0;background:${INK};padding:14px 14px 0;box-sizing:border-box}
    .phone img{display:block;width:${shotW}px;border-radius:${Math.round(w * 0.05)}px ${Math.round(w * 0.05)}px 0 0}
  </style></head><body><h1>${caption}</h1><div class="phone"><img src="data:image/png;base64,${png.toString("base64")}"></div></body></html>`;
}

async function frame(device) {
  const dir = join(OUT, device.name);
  const w = device.viewport.width * device.scale, h = device.viewport.height * device.scale;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  let n = 1;
  for (const s of SHOTS) {
    await page.setContent(framed(w, h, s.caption, readFileSync(join(dir, `raw-${s.id}.png`))));
    await page.screenshot({ path: join(dir, `${String(n++).padStart(2, "0")}-${s.id}.png`) });
  }
  await ctx.close();
}

/** Google Play feature graphic, 1024×500. */
async function featureGraphic() {
  const rows = [["United Kingdom", 55], ["United States", 24], ["Germany", 6], ["Netherlands", 3], ["Ireland", 3]];
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:1024px;height:500px;overflow:hidden;background:${OXBLOOD};color:${PAPER};font-family:Georgia,'Times New Roman',serif}
    .l{position:absolute;left:64px;top:0;bottom:0;width:470px;display:flex;flex-direction:column;justify-content:center;gap:18px}
    .name{font-size:34px;letter-spacing:-0.01em;opacity:.9}
    .line{font-size:50px;line-height:1.08;letter-spacing:-0.015em}
    .r{position:absolute;right:64px;top:92px;width:360px;font:500 19px/1 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
    .row{margin-bottom:22px}.row div:first-child{display:flex;justify-content:space-between;margin-bottom:8px}
    .bar{height:10px;border-radius:5px;background:rgba(246,241,231,.18)}.bar i{display:block;height:10px;border-radius:5px;background:${PAPER}}
  </style></head><body><div class="l"><div class="name">KnowYourSpend</div><div class="line">See which countries own the shops you pay</div></div>
  <div class="r">${rows.map(([c, p]) => `<div class="row"><div><span>${c}</span><span>${p}%</span></div><div class="bar"><i style="width:${(p / 55) * 100}%"></i></div></div>`).join("")}</div></body></html>`;
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 500 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.setContent(html);
  await page.screenshot({ path: join(OUT, "play-feature-graphic.png") });
  await ctx.close();
}

try {
  for (const d of DEVICES) { await capture(d); await frame(d); console.log("✓", d.name); }
  await featureGraphic();
  console.log("✓ feature graphic");
} finally {
  await browser.close();
  server.kill();
}
