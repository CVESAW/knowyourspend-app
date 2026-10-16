// @ts-nocheck — Deno (Supabase Edge Functions).
// KnowYourSpend — test bench for the look-up's AI step (Supabase Edge Function "kys-llm-eval", verify_jwt off).
// Runs the AI step the live look-up uses (ai.ts) on test names and returns every detail. Stores nothing.
// Deploy this file as index.ts with registries.ts and ai.ts. Called with an x-eval-token header whose SHA-256 is
// below (the token itself is not in the repo); to rotate it, make a new random token, put its hash here, redeploy.
// Secrets used: MISTRAL_API_KEY, COMPANIES_HOUSE_API_KEY.
import { CompaniesHouse, Gleif, Wikidata, normaliseName, stripLegalSuffix } from "./registries.ts";
import {
  AI_DEFAULTS, ANSWER_SCHEMA, PROMPT_VERSION, aiEstimate, askWithWebSearch, coreName, mistralModels, mistralProbe, parseAnswer, systemPrompt, userPrompt,
} from "./ai.ts";

const TOKEN_SHA256 = "35fc4d7805533ea035cec08a3446b62c83bd0bc373359c3e5d6671d782f53596";

async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Runs f at most n at a time (web checks: Mistral's web search allows fewer requests at once than chat).
function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { f, res, rej } = queue.shift();
    Promise.resolve().then(f).then(res, rej).finally(() => {
      active--;
      next();
    });
  };
  return (f) => new Promise((res, rej) => {
    queue.push({ f, res, rej });
    next();
  });
}

async function mapLimit(items, n, f) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await f(items[k]);
    }
  }));
  return out;
}

// Everything the bench needs to grade a row and to re-run the vote offline with other settings.
function brief(r) {
  return {
    decision: r.decision,
    country: r.country ?? null,
    owner: r.owner ?? null,
    brand: r.brand ?? null,
    agree: r.agree ?? r.vote?.agree ?? null,
    split: r.vote?.split ?? null,
    verified: !!r.verified,
    conflict: r.conflict ?? null,
    registry: r.registry ?? null,
    match: r.match ?? null,
    reconcile: r.reconcile ?? null,
    resolved: r.resolved ?? null,
    checked: r.checked ?? null,
    webMissed: !!r.webMissed,
    reason: r.reason ?? null,
    samples: r.samples.map((s) => ({ b: s.is_business, o: s.owner, c: s.country, k: s.confidence, m: s.match, t: s.owner_type, br: s.brand })),
    evidence: r.evidence.map((e) => `${e.id} ${e.text}`),
    web: r.web ?? null,
    usage: r.usage,
    ms: r.ms,
    notes: r.notes,
  };
}

// Hashes of the prompt, schema and settings, and the name helpers' output on awkward names: compare them with
// eval/fingerprint.mjs run on the repo's files to check that a deploy matches the repo.
export async function fingerprint() {
  const h = async (x) => (await sha256(typeof x === "string" ? x : JSON.stringify(x))).slice(0, 16);
  const names = ["Caf\u00e9 Nero Ltd", "THE BODY SHOP UK", "McDonald\u2019s", "SQ *THE BEAN HOUSE", "Marks & Spencer Group plc", "\u00d8stergaard A/S", "Zara Espa\u00f1a, S.A."];
  return {
    prompt_version: PROMPT_VERSION,
    system_gb: await h(systemPrompt("2026-10-14", "GB")),
    system_de: await h(systemPrompt("2026-10-14", "DE")),
    user: await h(userPrompt("X\"Y", [{ id: "W1", text: "t" }])),
    schema: await h(ANSWER_SCHEMA),
    defaults: await h(AI_DEFAULTS),
    names: names.map((n) => [normaliseName(n), stripLegalSuffix(n), stripLegalSuffix(n, true), coreName(n)]),
    parse: parseAnswer('x {"is_business":true,"brand":"B","ultimate_owner":"O","owner_type":"listed_company","owner_country":"uk","confidence":"high","match":null,"reason":"r"} y'),
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  if ((await sha256(req.headers.get("x-eval-token") ?? "")) !== TOKEN_SHA256) return new Response("forbidden", { status: 403 });
  const body = await req.json().catch(() => ({}));
  const key = Deno.env.get("MISTRAL_API_KEY") ?? "";
  const chKey = Deno.env.get("COMPANIES_HOUSE_API_KEY") ?? "";
  if (body.action === "fingerprint") return Response.json(await fingerprint());
  if (body.action === "keys") {
    return Response.json({ keys: { mistral: !!key, companies_house: !!chKey, anthropic: !!Deno.env.get("ANTHROPIC_API_KEY") } });
  }
  if (!key) return Response.json({ error: "MISTRAL_API_KEY not set" }, { status: 412 });
  if (body.action === "mistral-models") return Response.json(await mistralModels(fetch, key));
  if (body.action === "mistral-probe") return Response.json(await mistralProbe(fetch, key, String(body.model ?? "mistral-small-latest")));
  const opts = { ...AI_DEFAULTS, ...(body.options ?? {}) };
  const today = body.today ?? new Date().toISOString().slice(0, 10);
  const country = typeof body.country === "string" ? body.country.toUpperCase() : "GB";
  const ctx = { fetch, apiKey: key, wikidata: new Wikidata(fetch, { retries: 2 }), gleif: new Gleif(fetch), ch: chKey && country === "GB" ? new CompaniesHouse(fetch, chKey) : undefined, today, country, webQueue: limiter(2) };
  if (body.action === "web") {
    const out = [];
    for (const name of (body.names ?? []).slice(0, 5)) {
      const t0 = Date.now();
      try {
        out.push({ name, ...(await askWithWebSearch(name, ctx, opts, today)), ms: Date.now() - t0 });
      } catch (e) {
        out.push({ name, error: e.message, ms: Date.now() - t0 });
      }
    }
    return Response.json({ results: out });
  }
  if (body.action === "run") {
    const cases = Array.isArray(body.cases) ? body.cases.slice(0, 60) : [];
    if (!cases.length) return Response.json({ error: "need 1–60 cases" }, { status: 400 });
    const t0 = Date.now();
    const rows = await mapLimit(cases, Math.min(Number(body.concurrency) || 4, 8), async (c) => {
      try {
        return { ...c, ...brief(await aiEstimate(c.name, ctx, opts)) };
      } catch (e) {
        return { ...c, decision: "error", error: e.message };
      }
    });
    return Response.json({ seconds: Math.round((Date.now() - t0) / 1000), ch_calls: ctx.ch?.calls ?? 0, rows });
  }
  return Response.json({ error: "unknown action" }, { status: 400 });
});
