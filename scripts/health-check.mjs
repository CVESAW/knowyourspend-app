/**
 * Daily health check of what's live (run by .github/workflows/health.yml, or by hand:
 * `node scripts/health-check.mjs`). Exits 1 if anything is down, so GitHub emails the repo owner.
 * It only reads public pages and sends one well-known shop name ("Tesco") to the look-up service.
 *
 * APP_URL   the web app            (default https://app.knowyourspend.org)
 * SITE_URL  the website            (default https://knowyourspend.org)
 * OLD_URL   the retired web app, which must redirect to the new one (default https://knowyourspend.vercel.app)
 */
const APP = (process.env.APP_URL || "https://app.knowyourspend.org").replace(/\/$/, "");
const SITE = (process.env.SITE_URL || "https://knowyourspend.org").replace(/\/$/, "");
const OLD = (process.env.OLD_URL || "https://knowyourspend.vercel.app").replace(/\/$/, "");
const SUPABASE = "https://cxvwngmnkxtweuwaxfmz.supabase.co";

// The public (anon) key the app ships with; it only allows what the app itself can do.
const src = await fetch(`${APP}/`).then((r) => r.text()).catch(() => "");
const bundle = src.match(/\/_expo\/static\/js\/web\/[^"]+\.js/)?.[0];
const js = bundle ? await fetch(APP + bundle).then((r) => r.text()).catch(() => "") : "";
const ANON = js.match(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/)?.[0];

const checks = [
  ["web app home page", async () => {
    if (!src.includes("<title")) throw new Error("no HTML");
    if (!bundle || js.length < 100_000) throw new Error("app bundle missing or tiny");
  }],
  ["web app deep links (/add-statement, /settings)", async () => {
    for (const p of ["/add-statement", "/settings"]) {
      const r = await fetch(APP + p);
      if (r.status !== 200) throw new Error(`${p}: HTTP ${r.status}`);
    }
  }],
  ["offline support (service worker)", async () => {
    const r = await fetch(`${APP}/sw.js`);
    if (r.status !== 200 || !(await r.text()).includes("caches")) throw new Error(`HTTP ${r.status}`);
  }],
  ["full brand list downloads", async () => {
    const name = js.match(/\/data\/open-brands\.[0-9a-f]{12}\.json/)?.[0];
    if (!name) throw new Error("brand list address not found in the app");
    const r = await fetch(APP + name);
    const j = r.ok ? await r.json() : null;
    if (!j?.brands?.length || j.brands.length < 5000) throw new Error(`HTTP ${r.status}, ${j?.brands?.length ?? 0} brands`);
  }],
  ["shop look-up service", async () => {
    if (!ANON) throw new Error("public key not found in the app");
    const r = await fetch(`${SUPABASE}/functions/v1/kys-lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${ANON}`, Origin: APP },
      // "again": the check isn't someone paying Tesco, so it isn't added to the per-name request count (18 Oct 2026)
      body: JSON.stringify({ merchants: ["Tesco"], again: ["Tesco"] }),
    });
    const j = r.ok ? await r.json() : null;
    if (!Array.isArray(j?.results) || j.results.length !== 1) throw new Error(`HTTP ${r.status}`);
  }],
  ["retired web app redirects to the new one", async () => {
    const r = await fetch(`${OLD}/`, { redirect: "manual" });
    const to = r.headers.get("location") ?? "";
    if (![301, 302, 307, 308].includes(r.status) || !to.startsWith(APP)) throw new Error(`HTTP ${r.status} → ${to || "nowhere"}`);
  }],
  ...(SITE
    ? [["website pages", async () => {
        for (const p of ["/", "/privacy", "/terms", "/support"]) {
          const r = await fetch(SITE + p);
          if (r.status !== 200) throw new Error(`${p}: HTTP ${r.status}`);
          if (p === "/" && !(await r.text()).includes(APP)) throw new Error("home page doesn't link to the app");
        }
      }]]
    : []),
];

let failed = 0;
for (const [name, run] of checks) {
  try {
    await run();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}: ${e.message}`);
  }
}
if (!SITE) console.log("• website skipped (set the SITE_URL repository variable once it's live)");
process.exit(failed ? 1 : 0);
