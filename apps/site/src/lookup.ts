/**
 * The search box on the home page. Names in the built-in list are matched here in the browser; a name the list
 * doesn't know is sent, on its own, to our online look-up (the same one the app uses), and only if it doesn't look
 * like a person's name or something sensitive, unless the person searching asks. Everything shown is written with
 * textContent, never as HTML. Settings come from data attributes on the form (the page allows no inline scripts).
 */
import { configureOpenBrandsLoader, ensureOpenBrands } from "@kys/core/ownership";
import { shortDate } from "@kys/core/format";
import type { LookupAnswer } from "@kys/core/lookup-plan";
import { lookUpLocally, lookupUnavailable, readQuery, withAnswer, type QuickQuery, type QuickResult } from "@kys/core/quick-lookup";
import { countries } from "@kys/ownership";

type Child = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const k of kids) if (k) n.append(k);
  return n;
}
const countryLabel = (iso: string | undefined) => {
  const c = iso ? countries[iso] : undefined;
  return c ? `${c.flag} ${c.name}` : iso ?? "";
};
const safeUrl = (u: string) => (/^https:\/\/[^\s"<>]+$/i.test(u) ? u : null);

const form = document.getElementById("lookup") as HTMLFormElement | null;
if (form) start(form);

function start(form: HTMLFormElement): void {
  const input = form.querySelector<HTMLInputElement>("#q")!;
  const select = form.querySelector<HTMLSelectElement>("#country")!;
  const sends = document.getElementById("sends")!;
  const slot = document.getElementById("answer")!;
  const cfg = form.dataset as { openBrands?: string; lookupUrl?: string; lookupKey?: string; report?: string };
  const sendsDefault = sends.textContent ?? "";

  configureOpenBrandsLoader(async () => {
    const res = await fetch(cfg.openBrands!, { credentials: "omit" });
    if (!res.ok) throw new Error(`brand list: HTTP ${res.status}`);
    return res.json();
  });
  // If the generated list can't be fetched, the hand-built list still answers (and a later search tries again).
  const warm = () => ensureOpenBrands().catch(() => undefined);
  input.addEventListener("focus", warm, { once: true });
  setTimeout(warm, 1500);

  const preview = () => {
    const q = readQuery(input.value, select.value);
    sends.textContent = q.name ? `If our built-in list doesn't know it, we send just “${q.name}” to our online look-up. Nothing else.` : sendsDefault;
  };
  input.addEventListener("input", preview);
  select.addEventListener("change", preview);

  let seq = 0;
  const search = async (text: string, anyway = false) => {
    const my = ++seq;
    const q = readQuery(text, select.value);
    if (!q.name) {
      slot.replaceChildren();
      return;
    }
    history.replaceState(null, "", `#${new URLSearchParams({ q: q.text, ...(q.home !== "GB" ? { c: q.home } : {}) })}`);
    slot.replaceChildren(statusCard("Checking our built-in list…"));
    await warm();
    if (my !== seq) return;
    let r = lookUpLocally(q);
    if (r.canAsk || (anyway && r.askAnyway)) {
      slot.replaceChildren(statusCard(`“${q.name}” isn't in our built-in list, so we're asking our online look-up. It checks company registers, then asks an AI to research it. For a name nobody has asked about before, this can take up to two minutes.`, true));
      r = await ask(q);
      if (my !== seq) return;
    }
    slot.replaceChildren(resultCard(r, () => search(text, true), () => search(text)));
  };

  async function ask(q: QuickQuery): Promise<QuickResult> {
    if (!cfg.lookupUrl || !cfg.lookupKey) return lookupUnavailable(q, "error");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 150_000);
    try {
      const res = await fetch(cfg.lookupUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.lookupKey}`, apikey: cfg.lookupKey },
        body: JSON.stringify({ merchants: [q.name], ...(q.home !== "GB" ? { country: q.home } : {}) }),
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: ctl.signal,
      });
      if (res.status === 429) return lookupUnavailable(q, "busy");
      if (!res.ok) return lookupUnavailable(q, "error");
      const body = (await res.json()) as { results?: LookupAnswer[]; sources?: { ai?: boolean } };
      const answer = body.results?.[0];
      if (!answer) return lookupUnavailable(q, "error");
      const r = withAnswer(q, answer);
      return r.retry && body.sources?.ai === false ? lookupUnavailable(q, "paused") : r;
    } catch {
      return lookupUnavailable(q, "offline");
    } finally {
      clearTimeout(timer);
    }
  }

  function resultCard(r: QuickResult, anyway: () => void, again: () => void): HTMLElement {
    const w = r.why!;
    const card = el("article", { class: `answer is-${r.status}` });
    card.append(el("p", { class: "tag" }, [w.label, w.asOf ? `last checked ${shortDate(w.asOf)}` : ""].filter(Boolean).join(" · ")));
    if (r.status === "owner") {
      const top = w.chain[w.chain.length - 1];
      card.append(el("h2", { class: "owner" }, top?.name ?? w.name));
      if (w.country) card.append(el("p", { class: "where" }, countryLabel(w.country)));
      card.append(el("p", { class: "headline" }, w.headline));
    } else {
      card.append(el("h2", { class: "owner quiet" }, w.headline));
    }
    if (w.chain.length > 1) {
      card.append(el("ol", { class: "chain", "aria-label": "Who owns whom, from the brand to the company at the top" },
        ...w.chain.map((h) => el("li", {}, el("b", {}, h.name), el("span", {}, `${h.role} · ${countryLabel(h.country)}${h.legal ? ` (registered in ${countries[h.legal]?.name ?? h.legal})` : ""}`)))));
    }
    const how = el("section", { class: "how-got", "aria-label": "How we got there" }, el("h3", {}, "How we got there"));
    for (const s of w.sections) how.append(el("div", { class: "step" }, el("h4", {}, s.heading), ...s.lines.map((l) => el("p", {}, l))));
    card.append(how);
    if (r.steps?.length) {
      card.append(el("details", {}, el("summary", {}, "What our online look-up checked"), el("ol", { class: "trace" }, ...r.steps.map((s) => el("li", {}, s.detail)))));
    }
    const links = w.sources.map((s) => ({ ...s, url: safeUrl(s.url) })).filter((s) => s.url);
    if (links.length) {
      card.append(el("details", {}, el("summary", {}, `Sources (${links.length})`),
        el("ul", { class: "sources" }, ...links.map((s) => el("li", {}, el("a", { href: s.url!, rel: "noopener noreferrer nofollow", target: "_blank" }, s.label))))));
    }
    if (w.notes) card.append(el("details", {}, el("summary", {}, "Our research notes"), el("p", { class: "notes" }, w.notes)));
    const actions = el("p", { class: "actions" });
    if (r.askAnyway) actions.append(button(r.status === "person" ? "It's a business: look it up" : "Look it up anyway", anyway, true));
    if (r.retry) actions.append(button("Try again", again, true));
    if (cfg.report) {
      const body = `I searched for: ${r.query.text}\nYou said: ${w.headline}\n\nWhat's wrong (and a link that shows it, if you have one):\n`;
      actions.append(el("a", { href: `mailto:${cfg.report}?subject=${encodeURIComponent("Ownership mistake")}&body=${encodeURIComponent(body)}` }, "Report a mistake"));
    }
    card.append(actions);
    return card;
  }

  const button = (label: string, onClick: () => void, primary = false) => {
    const b = el("button", { type: "button", class: primary ? "btn primary small" : "btn small" }, label);
    b.addEventListener("click", onClick);
    return b;
  };
  const statusCard = (text: string, busy = false) => el("article", { class: `answer is-waiting${busy ? " busy" : ""}`, "aria-busy": "true" }, el("p", {}, text));

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void search(input.value);
  });
  for (const b of document.querySelectorAll<HTMLButtonElement>("button[data-q]")) {
    b.addEventListener("click", () => {
      input.value = b.dataset.q ?? "";
      preview();
      void search(input.value);
    });
  }
  const fromHash = () => {
    const h = new URLSearchParams(location.hash.slice(1));
    const text = h.get("q");
    if (!text) return;
    const c = (h.get("c") ?? "GB").toUpperCase();
    if ([...select.options].some((o) => o.value === c)) select.value = c;
    input.value = text;
    preview();
    void search(text);
  };
  window.addEventListener("hashchange", () => {
    const text = new URLSearchParams(location.hash.slice(1)).get("q");
    if (text && text !== readQuery(input.value).text) fromHash();
  });
  fromHash();
}
