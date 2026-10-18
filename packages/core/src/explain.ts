import type { OwnershipEntry, Source } from "@kys/ownership";
import { FACILITATOR, type Attribution } from "./attribute";
import { countryName } from "./countries";
import { shortDate } from "./format";

/**
 * "Why this country?" — turns an Attribution into the plain words the app shows under every shop: what the bank
 * wrote, how we recognised it, who owns it, how we know, and any rule we applied (franchises, holding companies,
 * marketplaces, local independents). Runs on the device; the bank text it quotes is never sent to the look-up (an account
 * copy, if the user keeps one, is encrypted on the device first).
 */

export type WhyLevel = "you" | "checked" | "registers" | "company_register" | "open_data" | "ai" | "research" | "local" | "estimate" | "none";

export interface WhySection {
  heading: string;
  lines: string[];
}

export interface WhyHop {
  name: string;
  /** ISO2 where it's run from ("" when unknown) */
  country: string;
  /** plain role: "Brand", "Run in the UK by", "Owned by", "Top owner" */
  role: string;
  /** ISO2 where it's legally registered, when that's different */
  legal?: string;
}

export interface Why {
  /** what we call the shop */
  name: string;
  /** ISO2 it counts towards, if any */
  country?: string;
  level: WhyLevel;
  /** short label for the badge in the sheet */
  label: string;
  /** one sentence */
  headline: string;
  /** what the bank wrote (only ever shown on this device) */
  bankText?: string;
  sections: WhySection[];
  chain: WhyHop[];
  sources: Source[];
  /** ISO date the answer was last checked */
  asOf?: string;
  /** our research notes as written, for anyone who wants every detail */
  notes?: string;
  /** an online look-up could find the owner (nothing has been looked up for it yet) */
  canLookUp: boolean;
}

export interface ExplainInput {
  /** how this payment was attributed (attribute()) */
  a: Attribution;
  /** the normalised payee (what a look-up would send) */
  payee: string;
  /** what the bank wrote, when we have a payment to quote */
  bankText?: string;
  /** the user's home country */
  home: string;
  /** our look-up was asked about this name and couldn't name an owner */
  lookupMissed?: boolean;
  /** about the look-up's answer, when it gave one (since 18 Oct 2026): a web search checked a "small local business"
   *  answer, or the answer hasn't had its full check yet and the app asks again on `recheck` (ISO date) */
  lookupCheck?: { web?: boolean; recheck?: string };
  /** a receipt the user added, with no statement payment behind it (so no bank text, and nothing to look up) */
  receipt?: boolean;
}

const THE = /^(United |Netherlands$|Philippines$|Bahamas$|Gambia$|Maldives$|Comoros$|Dominican Republic$|Central African Republic$|Isle of Man$|Holy See|Vatican)|Islands$/;
/** "the United Kingdom", "Germany", "the Isle of Man" — a country name that reads well inside a sentence. */
export function theCountry(iso: string): string {
  const n = countryName(iso);
  return THE.test(n) ? `the ${n}` : n;
}

const ROLE: Record<string, string> = { brand_of: "Brand", operator: "Run in the UK by", owned_by: "Owned by", ultimate_parent: "Top owner" };

/** Names for the payment services that put their name before the shop's ("PAYPAL *STEAMGAMES"). */
const PAID_THROUGH: Record<string, string> = {
  PAYPAL: "PayPal", PP: "PayPal", GOOGLE: "Google Play", CRV: "Curve", SQ: "Square", SUMUP: "SumUp", ZETTLE: "Zettle", ZETTLE_: "Zettle",
  IZETTLE: "Zettle", IZ: "Zettle", SP: "an online shop's payment service", TST: "Toast", KLARNA: "Klarna", CLEARPAY: "Clearpay",
};

/** A company known only by its Wikidata id (no English name there): words, not "Q2836957". Used wherever a name shows. */
export const readableName = (name: string) => (/^Q\d+$/.test(name) ? "a company Wikidata lists without an English name" : name);
const nice = readableName;

const isOpenBrand = (e: OwnershipEntry) => e.id.startsWith("osm-");
const isLookup = (e: OwnershipEntry) => e.id.startsWith("lookup-");
const top = (e: OwnershipEntry) => e.chain[e.chain.length - 1];

function whereSentence(a: Attribution, home: string): string {
  const c = a.clue ?? "";
  switch (a.evidence) {
    case "country_code":
      return `Your bank printed the country code “${c}”, so it was paid in ${theCountry(a.country!)}.`;
    case "country_name":
      return `Your bank printed “${c}”, so it was paid in ${theCountry(a.country!)}.`;
    case "place":
      return `Your bank printed the town “${c}”, which is in ${theCountry(a.country!)}.`;
    case "web_domain":
      return `Its web address ends in ${c}, which is ${theCountry(a.country!)}'s.`;
    default:
      return `Your bank didn't print another country, so it was paid at home in ${theCountry(a.country ?? home)}.`;
  }
}

function chainOf(e: OwnershipEntry): WhyHop[] {
  return e.chain.map((h, i) => ({
    name: nice(h.name),
    country: h.country ?? "",
    role: e.chain.length === 1 ? "Top owner" : (ROLE[h.relation] ?? (i === e.chain.length - 1 ? "Top owner" : "Owned by")),
    ...(h.legal_country && h.legal_country !== h.country ? { legal: h.legal_country } : {}),
  }));
}

function recognisedOwner(a: Attribution, e: OwnershipEntry, payee: string): string {
  const name = e.display_name;
  switch (a.method) {
    case "domain":
      return `Your bank's text contains the web address ${(a.alias ?? "").toLowerCase()}, which belongs to ${name}.`;
    case "joined":
      return `Your bank printed “${a.alias}” with the spaces missing, as banks often do. It's a name ${name} uses.`;
    case "near":
      return `Your bank's text is one letter different from “${a.alias}”, a name ${name} uses. We only allow that for long names, and it can be wrong.`;
    case "lookup":
      return `${name} isn't in the app's built-in list, so the app sent just the name “${payee}” to our look-up service (nothing else about you or the payment), which found it.`;
    default:
      return a.alias
        ? `Your bank's text contains “${a.alias}”, a name ${name} uses on bank statements.`
        : `We recognised the name as ${name}.`;
  }
}

/** The answer hasn't had its full check yet: when the app asks again. */
// (Not "once someone else has asked": when the day's web searches ran out, someone else may have asked already.)
const recheckLine = (recheck: string) => `It hasn't been checked with a web search yet. From ${shortDate(recheck)}, the app asks again when you add a statement with this shop; if nobody else has asked about it by then, the full check waits until someone does.`;

/** How we know who owns it, by where the answer came from. */
function howWeKnow(e: OwnershipEntry, check?: ExplainInput["lookupCheck"]): { level: WhyLevel; label: string; lines: string[] } {
  const technique = e.technique ?? "";
  const hasSources = (e.sources ?? []).length > 0;
  if (e.tier === "CURATED") {
    return {
      level: "checked",
      label: "Checked by a person",
      lines: [`A person checked each step against company filings and official registers${e.reviewed_at ? ` on ${shortDate(e.reviewed_at)}` : ""}.`],
    };
  }
  if (isOpenBrand(e)) {
    if (e.tier === "LLM_GUESS") {
      const reason = technique.split(/\):\s*/)[1];
      return {
        level: "ai",
        label: "AI-corrected open data",
        lines: [
          "This brand is in OpenStreetMap's list of shop brands, linked to Wikidata (an open database anyone can edit).",
          `Wikidata's owner looked out of date, so an AI review replaced it${reason ? `: ${reason}` : "."}`,
          "A person hasn't checked this yet.",
        ],
      };
    }
    return {
      level: "open_data",
      label: "Open data",
      lines: [
        "This brand is in OpenStreetMap's list of shop brands, linked to Wikidata (an open database anyone can edit).",
        "We follow Wikidata's “owned by” records up to the top company. No official register confirmed it, and a person hasn't checked it.",
      ],
    };
  }
  if (isLookup(e)) {
    if (e.tier === "EXACT_ID") {
      // What GLEIF said, from the look-up's notes: it named the company at the top, records that none sits above, or
      // has no parent filed (18 Oct 2026: every case read "confirms nothing sits above").
      // A reporting exception (owned by people, accounts not consolidated, not public…) means a parent may exist but
      // isn't reported.
      const reason = technique.match(/no parent above it \(([^)]*)\)/i)?.[1] ?? "";
      const gleif = /GLEIF's filed ultimate parent/i.test(technique)
        ? "names the company at the top, which completes the chain"
        : reason === "no parent filed"
          ? "has no parent filed for the company at the top"
          : reason === "natural persons"
            ? "records that the company at the top is owned by people, not by another company"
            : reason && reason !== "is its own ultimate parent"
              ? `doesn't name a parent for the company at the top: it records an exception (“${reason}”), so one may exist but isn't reported`
              : "records that no other company sits above the company at the top";
      return {
        level: "registers",
        label: "From official registers",
        lines: [
          "Our look-up found it in Wikidata (an open database of companies) and followed its owners up.",
          `The Global LEI register (GLEIF), where companies file their parent company for financial regulators, ${gleif}.`,
        ],
      };
    }
    if (/companies house/i.test(technique)) {
      return {
        level: "company_register",
        label: "From the UK company register",
        lines: [
          "Companies House, the UK's official register of companies, has one active company with exactly this name.",
          "Its filings of who controls it name each owner in turn, and we followed them to the top.",
        ],
      };
    }
    if (e.tier === "LLM_GUESS") {
      const web = /checked with a web search/i.test(technique);
      const webTried = /web search couldn't confirm/i.test(technique);
      const agree = technique.match(/(\d) of (\d) answers agree/);
      const matches = /matches Wikidata\/GLEIF|taken from Wikidata\/GLEIF/i.test(technique);
      return {
        level: "ai",
        label: "AI estimate",
        lines: [
          web
            ? "An AI (Mistral, a French AI company) looked the business up with a web search and named its owner."
            : `An AI (Mistral, a French AI company) was asked who owns it${agree ? ` ${agree[2]} times, and ${agree[1]} of the answers agreed` : ""}.`,
          ...(matches ? ["The owner it named matches the public registers (Wikidata and GLEIF)."] : []),
          ...(web
            ? []
            : webTried
              ? ["A web search couldn't confirm it, so this is the owner most of the answers named."]
              : check?.recheck
                ? [recheckLine(check.recheck)]
                : agree && agree[1] === agree[2] && matches
                  ? ["There was no web search: all the answers agreed, and the registers confirm the owner."]
                  : ["It wasn't checked with a web search."]),
          "A person hasn't checked it, so treat it as a good guess.",
        ],
      };
    }
    return {
      level: "open_data",
      label: "Open data",
      lines: ["Our look-up found it by name in Wikidata, an open database anyone can edit, and followed its owners up. No official register confirmed it."],
    };
  }
  // Our own hand-built list: researched one entry at a time, with an AI's help, from the registers and published reports.
  const notChecked = "A person hasn't checked it yet.";
  if (e.tier === "EXACT_ID") {
    return {
      level: "registers",
      label: "From official registers",
      lines: [
        "Two public records agree on the top company: Wikidata (an open database of companies) and the Global LEI register (GLEIF), where companies file their parent for financial regulators.",
        ...(/2023-2026/.test(technique) ? ["An AI check for takeovers since 2023 found none."] : []),
        notChecked,
      ],
    };
  }
  if (e.tier === "NAME_MATCH") {
    return {
      level: "open_data",
      label: "From public records",
      lines: ["Public records (Wikidata and GLEIF) support it, but they don't confirm each other, so it isn't settled.", notChecked],
    };
  }
  const reports = (e.sources ?? []).filter((s) => !/wikidata\.org|gleif\.org/.test(s.url));
  return {
    level: "research",
    label: "AI-assisted research",
    lines: [
      reports.length
        ? "Researched with an AI's help. The public registers were out of date or incomplete (often after a takeover), so the answer is based on the reports linked below."
        : hasSources
          ? "Researched with an AI's help. The public registers linked below don't confirm it (they can lag behind takeovers), so it rests on what was publicly reported up to mid-2026."
          : "Researched with an AI's help, from what was publicly reported up to mid-2026. No public register confirms it, and we don't have a report to link to yet.",
      notChecked,
    ],
  };
}

/** Rules we applied, in plain words: franchises, holding companies, shared owners, marketplaces, payment services. */
function rules(a: Attribution, e: OwnershipEntry, bankText: string | undefined): string[] {
  const out: string[] = [];
  const t = top(e);
  const text = `${e.notes ?? ""} ${e.technique ?? ""} ${e.chain.map((h) => h.name).join(" ")}`;
  if (/franchis/i.test(text)) {
    out.push(`Franchise: the outlet you paid may be run by a local company (a franchisee). We count the brand owner, ${nice(t?.name ?? e.display_name)}, because it owns the brand and is paid for its use.`);
  }
  const legal = e.legal_country ?? t?.legal_country;
  if (legal && legal !== e.owner_country && t) {
    out.push(`${nice(t.name)} is registered in ${theCountry(legal)} but run from ${theCountry(e.owner_country)}. We count where a company is run from, not where it's registered.`);
  }
  if (e.shared_ownership || e.co_owners?.length) {
    const who = e.co_owners?.map((c) => `${c.name} (${countryName(c.country)}${c.share != null ? `, ${c.share}%` : ""})`).join(", ");
    out.push(`No single company controls it${who ? `: ${who}` : ""}. Showing ${theCountry(e.owner_country)} is a simplification.`);
  }
  if (/private[- ]equity/i.test(text)) {
    out.push("Owned by a private-equity firm: we count the country the firm is run from, not where its funds are registered.");
  }
  if (e.intermediary === "marketplace" || /\bmarketplace\b/i.test(e.notes ?? "")) {
    out.push(`${e.display_name} also sells for other businesses (a marketplace or app store). Your statement doesn't show the seller behind the payment, so we count ${e.display_name} itself.`);
  } else if (e.intermediary === "psp") {
    out.push(`${e.display_name} is a payment service. When your bank shows the shop behind it, we count the shop instead.`);
  }
  const via = bankText?.trim().match(FACILITATOR);
  if (via && !e.intermediary) {
    const svc = PAID_THROUGH[via[1]!.toUpperCase()] ?? via[1]!;
    out.push(`You paid through ${svc}, which puts its name before the shop's. We looked through it to the shop you paid.`);
  }
  return out;
}

/** How a local independent was recognised. */
function localLines(ind: NonNullable<Attribution["independent"]>, check: ExplainInput["lookupCheck"]): string[] {
  if (ind.kind === "card_reader") {
    return [
      `“${ind.prefix} *” in your bank's text means you paid with a ${ind.provider} card reader. They're mostly used by small businesses: cafés, market stalls, salons and tradespeople.`,
      "It isn't a chain we know, so we treat it as a local independent business.",
    ];
  }
  if (ind.kind === "keyword") return [`The name contains “${ind.word}”, which usually means a single local business rather than a chain. It isn't a chain we know.`];
  return [
    "It isn't in the app's built-in list. Our online look-up's AI step (Mistral) found a small local business rather than a chain, and no owner that a register or a web search confirms.",
    check?.web ? "A web search was part of that check." : check?.recheck ? recheckLine(check.recheck) : "It wasn't checked with a web search.",
  ];
}

export function explain({ a, payee, bankText, home, lookupMissed, lookupCheck, receipt }: ExplainInput): Why {
  const e = a.entry;
  const base = { bankText, chain: [] as WhyHop[], sources: [] as Source[], canLookUp: false };

  if (a.basis === "you") {
    const lines = ["You chose this country. It's used for every payment to this shop, and kept with the rest of your data, which only you can read."];
    if (e && e.owner_country !== a.country) {
      lines.push(`Our own answer was ${theCountry(e.owner_country)}: ${e.display_name} → ${nice(top(e)?.name ?? e.display_name)}.`);
    }
    return { ...base, name: e?.display_name ?? payee, country: a.country, level: "you", label: "You set this", headline: `Counted as ${theCountry(a.country!)}, because you set it.`, sections: [{ heading: "Your choice", lines }] };
  }

  if (a.basis === "owner" && e) {
    const t = top(e);
    const owner = nice(t?.name ?? e.display_name);
    const how = howWeKnow(e, lookupCheck);
    const headline =
      owner === e.display_name || e.chain.length <= 1
        ? `${e.display_name} is its own top company, run from ${theCountry(e.owner_country)}.`
        : `${e.display_name} is owned by ${owner}, run from ${theCountry(e.owner_country)}.`;
    const sections: WhySection[] = [
      { heading: "How we recognised it", lines: [recognisedOwner(a, e, payee)] },
      { heading: "Who owns it", lines: [`We follow who controls the business up to the company at the top, and count the country that company is run from: ${theCountry(e.owner_country)}.`] },
      { heading: "How we know", lines: [...how.lines, ...(e.as_of ? [`Last checked ${shortDate(e.as_of)}.`] : [])] },
    ];
    const r = rules(a, e, bankText);
    if (r.length) sections.push({ heading: "Rules we applied", lines: r });
    const notes = [e.technique, e.notes].filter((x) => x && x.trim()).join("\n\n") || undefined;
    return { ...base, name: e.display_name, country: e.owner_country, level: how.level, label: how.label, headline, sections, chain: chainOf(e), sources: e.sources ?? [], asOf: e.as_of, notes };
  }

  if (a.basis === "independent" && a.independent) {
    const why = localLines(a.independent, lookupCheck);
    return {
      ...base,
      name: payee,
      country: a.country,
      level: "local",
      label: "Local independent",
      headline: `Counted as ${theCountry(a.country!)}: a local independent business, counted where you paid.`,
      sections: [
        { heading: "How we recognised it", lines: why },
        { heading: "Where we count it", lines: ["Local independents are counted in the country where you paid them, because almost all are owned there.", whereSentence(a, home)] },
        { heading: "If that's wrong", lines: ["If it's part of a bigger company, set the country yourself. Your answer is used for every payment to it."] },
      ],
    };
  }

  if (a.basis === "estimated" && receipt) {
    return {
      ...base,
      name: payee,
      country: a.country,
      level: "estimate",
      label: "Estimated",
      headline: `Counted as ${theCountry(a.country!)}: estimated from where you paid.`,
      sections: [
        { heading: "Why it's an estimate", lines: ["It's from a receipt you added, for a shop that isn't in the app's built-in list.", "Shops we can't name an owner for are counted in the country where you paid them."] },
        { heading: "Where you paid", lines: [`No statement payment matches the receipt, so it's counted in your home country, ${theCountry(a.country ?? home)}.`] },
      ],
    };
  }

  if (a.basis === "estimated") {
    return {
      ...base,
      name: payee,
      country: a.country,
      level: "estimate",
      label: "Estimated",
      headline: `Counted as ${theCountry(a.country!)}: estimated from where you paid.`,
      canLookUp: !lookupMissed,
      sections: [
        {
          heading: "Why it's an estimate",
          lines: [
            lookupMissed
              ? "It isn't in the app's built-in list, and our look-up couldn't find who owns it."
              : "It isn't in the app's built-in list, and it hasn't been looked up online.",
            "Shops we can't name an owner for are counted in the country where you paid them. A small café in Lewisham is almost always owned in the UK; a taverna in Málaga, in Spain.",
          ],
        },
        { heading: "Where you paid", lines: [whereSentence(a, home)] },
      ],
    };
  }

  // Estimates off (Settings → Shops we don't know): a local independent isn't counted, and isn't looked up either.
  if (a.independent) {
    return {
      ...base,
      name: payee,
      level: "none",
      label: "Not counted",
      headline: "Not counted: it looks like a local independent business, and estimates are switched off in Settings.",
      sections: [
        { heading: "How we recognised it", lines: localLines(a.independent, lookupCheck) },
        { heading: "Why it isn't counted", lines: ["Local independents are counted in the country where you paid them, and that's switched off in Settings → Shops we don't know."] },
      ],
    };
  }
  return {
    ...base,
    name: payee,
    level: "none",
    label: "Not counted",
    headline: "Not counted: we don't know who owns it, and estimates are switched off in Settings.",
    canLookUp: !lookupMissed,
    sections: [{ heading: "Why", lines: ["It isn't in the app's built-in list, and estimating from where you paid is switched off."] }],
  };
}
