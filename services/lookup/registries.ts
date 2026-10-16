// @ts-nocheck — recovered bundle code (plain JavaScript), split out of kys-lookup on 14 Oct 2026.
// Public registers used by the ownership look-up: Wikidata, GLEIF and Companies House, plus name helpers.
// Letters that don't come apart into a plain letter and an accent (14 Oct 2026, for banks in Europe): without this,
// "\u00d8STERGAARD" lost its first letter.
var TRANSLIT = { "\u00d8": "O", "\u00c6": "AE", "\u0152": "OE", "\u0141": "L", "\u0110": "D", "\u00de": "TH", "\u00d0": "D", "\u1e9e": "SS" };
export function normaliseName(input) {
  return input.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[\u00d8\u00c6\u0152\u0141\u0110\u00de\u00d0\u1e9e]/g, (c) => TRANSLIT[c]).replace(/['\u2018\u2019`]/g, "").replace(/[^A-Z0-9&]+/g, " ").replace(/\s+/g, " ").trim();
}
export var LEGAL_TAIL = new Set(["LIMITED", "LTD", "PLC", "LLP", "LLC", "INC", "INCORPORATED", "CORP", "CORPORATION", "GMBH", "AG", "SA", "SAS", "SARL", "SPA", "BV", "NV", "AB", "AS", "OY", "SE", "PTY", "CO", "COMPANY", "HOLDING", "HOLDINGS", "UK", "GB", "GROUP"]);
// 14 Oct 2026, for banks outside the UK only: legal forms used in Europe and Canada, and the "&" left over from "& CO".
// (UK names keep the rules above, so their cache keys and searches don't change.)
export var LEGAL_TAIL_ABROAD = new Set([...LEGAL_TAIL, "APS", "ASA", "OYJ", "PUBL", "KG", "KGAA", "OHG", "UG", "SRL", "SL", "SLU", "SAU", "SRO", "SNC", "SASU", "EURL", "SPRL", "BVBA", "CVBA", "VOF", "LDA", "LTDA", "SGPS", "DAC", "CLG", "TEORANTA", "LTEE", "ULC", "KFT", "ZRT", "NYRT", "UAB", "SIA", "&"]);
// Legal forms written with dots or slashes ("S.A.", "A/S", "S.p.A.", "Sp. z o.o.") come out of normaliseName as
// single letters ("S A"); a run of them at the end is dropped when it spells one. Only for banks outside the UK, and
// for company names: on a UK statement two letters at the end are more often someone's initials ("EVANS S L").
export var LETTER_FORMS = new Set(["AS", "SA", "SPA", "SRL", "SL", "BV", "NV", "SARL", "SAS", "SASU", "SRO", "DOO", "AG", "KG", "EK", "EV", "EG", "AB", "OY", "PLC", "LLC", "LLP", "INC", "SNC", "SCS", "SCA", "SAU", "SLU", "LDA", "CV", "SC"]);
export function dropLetterForm(words) {
  let k = 0;
  while (k < words.length - 1 && words[words.length - 1 - k].length === 1) k++;
  for (let n = Math.min(k, 5); n >= 2; n--) {
    let tail = words.slice(-n).join("");
    if (LETTER_FORMS.has(tail)) return words.slice(0, -n);
    if (tail === "ZOO" && words.length - n >= 2 && words[words.length - n - 1] === "SP") return words.slice(0, -n - 1);
  }
  return words;
}
/** The name without a leading "THE" and legal forms at the end; abroad = the wider rules for banks outside the UK. */
export function stripLegalSuffix(input, abroad = false) {
  let words = normaliseName(input).split(" ").filter(Boolean), orig = words.join(" "), tail = abroad ? LEGAL_TAIL_ABROAD : LEGAL_TAIL;
  for (words[0] === "THE" && words.length > 1 && words.shift(); ; ) {
    let shorter = abroad ? dropLetterForm(words) : words;
    if (shorter !== words) words = shorter;
    else if (words.length > 1 && tail.has(words[words.length - 1])) words.pop();
    else break;
  }
  let out = words.join(" ");
  return out.length >= 2 ? out : orig;
}
export function slug(input) {
  return normaliseName(input).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}
export var WIKIDATA_API = "https://www.wikidata.org/w/api.php", UA = "KnowYourSpend/0.2 (ownership lookup; https://github.com/CVESAW/knowyourspend)", PASSIVE_HOLDERS = new Set([
  "Q849363",
  "Q219635",
  "Q2037125",
  "Q11992019",
  "Q970769",
  "Q505275",
  "Q1411292",
  "Q522617",
  "Q2844522",
  "Q1142797",
  "Q3511946",
  "Q2557807",
  "Q105773164"
]), NOT_A_BUSINESS = new Set([
  "Q5",
  "Q4167410",
  "Q515",
  "Q1549591",
  "Q3957",
  "Q532",
  "Q6256",
  "Q3624078",
  "Q202444",
  "Q101352",
  "Q11424",
  "Q7366",
  "Q482994",
  "Q5398426",
  "Q7725634",
  "Q13442814",
  "Q4022",
  "Q23397",
  "Q8502"
]);
export function itemId(c) {
  return c.mainsnak?.datavalue?.value?.id;
}
export function strValue(c) {
  let v = c.mainsnak?.datavalue?.value;
  return typeof v == "string" ? v : void 0;
}
export function ended(c, now = Date.now()) {
  let end = c.qualifiers?.P582?.[0]?.datavalue?.value;
  if (!end?.time) return !1;
  let t = Date.parse(end.time.replace(/^\+/, "").replace(/-00/g, "-01"));
  return Number.isNaN(t) ? !0 : t < now;
}
export function share(c) {
  let q = c.qualifiers?.P1107?.[0]?.datavalue?.value;
  if (!q?.amount) return;
  let n = Number(q.amount);
  if (Number.isFinite(n))
    return n <= 1 ? n * 100 : n;
}
export function current(claims) {
  let live = (claims ?? []).filter((c) => c.rank !== "deprecated" && !ended(c)), pref = live.filter((c) => c.rank === "preferred");
  return pref.length ? pref : live;
}
export function parseEntity(raw) {
  let id = raw.id;
  if (!id || raw.missing !== void 0) return;
  let labels = raw.labels, descs = raw.descriptions, al = raw.aliases, claims = raw.claims ?? {}, label = labels?.en?.value ?? labels?.["en-gb"]?.value ?? Object.values(labels ?? {})[0]?.value ?? id, parents = [];
  for (let c of current(claims.P749)) {
    let p = itemId(c);
    p && p !== id && parents.push({ id: p, via: "P749" });
  }
  let ignoredOwners = 0, owners = current(claims.P127).map((c) => ({ id: itemId(c), share: share(c) })).filter((o) => !!o.id && o.id !== id), controlling = owners.filter((o) => !PASSIVE_HOLDERS.has(o.id) && (o.share === void 0 || o.share > 50));
  ignoredOwners = owners.length - controlling.length;
  let unshared = controlling.filter((o) => o.share === void 0), usable = controlling.filter((o) => o.share !== void 0).concat(unshared.length === 1 ? unshared : []);
  unshared.length > 1 && (ignoredOwners += unshared.length);
  for (let o of usable.sort((a, b) => (b.share ?? 0) - (a.share ?? 0)))
    parents.some((p) => p.id === o.id) || parents.push({ id: o.id, via: "P127", share: o.share });
  let has = (p) => (claims[p]?.length ?? 0) > 0;
  return {
    id,
    label,
    description: descs?.en?.value,
    aliases: (al?.en ?? []).map((a) => a.value),
    instanceOf: current(claims.P31).map(itemId).filter((x) => !!x),
    parents,
    ignoredOwners,
    countryIds: current(claims.P17).map(itemId).filter((x) => !!x),
    hqIds: current(claims.P159).map(itemId).filter((x) => !!x),
    placeIds: current(claims.P131).map(itemId).filter((x) => !!x),
    lei: current(claims.P1278).map(strValue).find((x) => !!x && /^[A-Z0-9]{20}$/.test(x)),
    iso2: current(claims.P297).map(strValue).find((x) => !!x && /^[A-Z]{2}$/.test(x)),
    website: current(claims.P856).map(strValue).find((x) => !!x),
    hasBusinessFacts: ["P749", "P127", "P1278", "P452", "P159", "P1454", "P414", "P355", "P1128", "P2139", "P1056"].some(has)
  };
}
export var Wikidata = class {
  constructor(fetch2, opts = {}) {
    this.fetch = fetch2;
    this.opts = opts;
  }
  fetch;
  opts;
  cache = new Map();
  last = 0;
  async get(url) {
    let tries = (this.opts.retries ?? 4) + 1;
    for (let attempt = 0; attempt < tries; attempt++) {
      let wait = (this.opts.minIntervalMs ?? 0) - (Date.now() - this.last);
      wait > 0 && await new Promise((r) => setTimeout(r, wait)), this.last = Date.now();
      let res = await this.fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1) ** 2));
        continue;
      }
      if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
      return res.json();
    }
    throw new Error("Wikidata is busy (rate limited)");
  }
  async entities(ids) {
    let need = [...new Set(ids)].filter((id) => /^Q\d+$/.test(id) && !this.cache.has(id));
    for (let i = 0; i < need.length; i += 50) {
      let batch = need.slice(i, i + 50), url = `${WIKIDATA_API}?action=wbgetentities&format=json&props=labels|descriptions|aliases|claims&languages=en|en-gb&ids=${batch.join("|")}`, data = await this.get(url);
      for (let id of batch) {
        let raw = data.entities?.[id];
        this.cache.set(id, raw ? parseEntity(raw) ?? null : null);
      }
    }
    let out = new Map();
    for (let id of ids) {
      let e = this.cache.get(id);
      e && out.set(id, e);
    }
    return out;
  }
  async entity(id) {
    return (await this.entities([id])).get(id);
  }
  async countryOf(e) {
    if (e.iso2) return e.iso2;
    for (let hq of (await this.entities(e.hqIds)).values()) {
      if (hq.iso2) return hq.iso2;
      for (let c of (await this.entities(hq.countryIds)).values())
        if (c.iso2) return c.iso2 === "CN" ? await this.specialRegion(hq, e) ?? "CN" : c.iso2;
    }
    for (let c of (await this.entities(e.countryIds)).values()) if (c.iso2) return c.iso2;
  }
  // Added 14 Oct 2026: places in Hong Kong and Macau have China as their country on Wikidata, so a head office
  // there came out as CN. Look for Hong Kong or Macau in the place's "located in" chain, or as the company's own
  // country.
  async specialRegion(place, company) {
    let own = [...(await this.entities(company?.countryIds ?? [])).values()].map((c) => c.iso2).find((c) => c === "HK" || c === "MO");
    if (own) return own;
    let ids = place.placeIds ?? [], seen = new Set();
    for (let d = 0; d < 4 && ids.length; d++) {
      let next = [];
      for (let p of (await this.entities(ids)).values()) {
        if (p.iso2 === "HK" || p.iso2 === "MO") return p.iso2;
        for (let q of p.placeIds ?? []) seen.has(q) || (seen.add(q), next.push(q));
      }
      ids = next;
    }
  }
  async searchBusiness(name, abroad = false) {
    let q = stripLegalSuffix(name, abroad);
    if (q.length < 2) return [];
    let url = `${WIKIDATA_API}?action=wbsearchentities&format=json&language=en&uselang=en&type=item&limit=10&search=${encodeURIComponent(q)}`, ids = ((await this.get(url)).search ?? []).map((s) => s.id), ents = await this.entities(ids), want = normaliseName(q), out = [];
    for (let id of ids) {
      let e = ents.get(id);
      !e || e.instanceOf.some((c) => NOT_A_BUSINESS.has(c)) || !e.hasBusinessFacts || ![e.label, ...e.aliases].map((n) => normaliseName(stripLegalSuffix(n, abroad))).includes(want) || out.push(e);
    }
    return out;
  }
};
export async function walkOwnership(wd, startId, maxDepth = 8) {
  let hops = [], seen = new Set(), id = startId, via, share2, ignoredOwners = 0;
  for (let d = 0; id && d <= maxDepth; d++) {
    if (seen.has(id)) return { hops, stop: "cycle", ignoredOwners };
    seen.add(id);
    let e = await wd.entity(id);
    if (!e) return { hops, stop: "missing", ignoredOwners };
    if (e.instanceOf.includes("Q5") || e.instanceOf.includes("Q8436"))
      return { hops, stop: "person_or_family", ignoredOwners };
    hops.push({ id: e.id, label: e.label, country: await wd.countryOf(e), lei: e.lei, via, share: share2 }), ignoredOwners += e.ignoredOwners;
    let next = e.parents[0];
    if (!next) return { hops, stop: "top", ignoredOwners };
    id = next.id, via = next.via, share2 = next.share;
  }
  return { hops, stop: "depth", ignoredOwners };
}
export var wikidataUrl = (id) => `https://www.wikidata.org/wiki/${id}`;
export var GLEIF_API = "https://api.gleif.org/api/v1", gleifUrl = (lei) => `${GLEIF_API}/lei-records/${lei}`;
export function toRecord(d) {
  let data = d, e = data?.attributes?.entity;
  if (!(!data?.id || !e))
    return {
      lei: data.id,
      name: e.legalName?.name ?? data.id,
      legalCountry: e.legalAddress?.country,
      hqCountry: e.headquartersAddress?.country,
      active: e.status !== "INACTIVE"
    };
}
export var Gleif = class {
  constructor(fetch2) {
    this.fetch = fetch2;
  }
  fetch;
  cache = new Map();
  async get(path) {
    if (this.cache.has(path)) return this.cache.get(path);
    for (let attempt = 0; attempt < 4; attempt++) {
      let res = await this.fetch(`${GLEIF_API}${path}`, { headers: { Accept: "application/vnd.api+json" } });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1e3 * (attempt + 1) ** 2));
        continue;
      }
      let out = { status: res.status, body: res.ok ? await res.json() : void 0 };
      return this.cache.set(path, out), out;
    }
    throw new Error("GLEIF is busy");
  }
  async record(lei) {
    let r = await this.get(`/lei-records/${lei}`);
    return r.status === 200 ? toRecord(r.body.data) : void 0;
  }
  async ultimateParent(lei) {
    let r = await this.get(`/lei-records/${lei}/ultimate-parent`);
    if (r.status === 200) {
      let rec = toRecord(r.body.data);
      return rec && rec.lei !== lei ? { kind: "parent", record: rec } : { kind: "top", reason: "is its own ultimate parent" };
    }
    if (r.status === 404) {
      let ex = await this.get(`/lei-records/${lei}/ultimate-parent-reporting-exception`);
      return ex.status === 200 ? { kind: "top", reason: (ex.body.data?.attributes?.reason ?? "exception").toString().toLowerCase().replace(/_/g, " ") } : { kind: "top", reason: "no parent filed" };
    }
    return { kind: "unknown" };
  }
};
export function readable(name, fallback) {
  return /[^\u0000-\u024f\u2019]/.test(name) ? fallback : name;
}
export async function ownershipFromWikidata(wd, gleif, qid) {
  let walk = await walkOwnership(wd, qid);
  if (!walk.hops.length) return;
  let hops = walk.hops.map((h, i) => ({
    name: h.label,
    relation: i === 0 ? walk.hops.length > 1 ? "brand_of" : "ultimate_parent" : i === walk.hops.length - 1 ? "ultimate_parent" : "owned_by",
    country: h.country ?? "",
    source: "wikidata",
    source_id: h.id,
    source_url: wikidataUrl(h.id)
  })), sources = walk.hops.map((h) => ({ label: `Wikidata ${h.id} (${h.label})`, url: wikidataUrl(h.id) })), top = walk.hops[walk.hops.length - 1], tier = "NAME_MATCH", summary = `Wikidata: ${walk.hops.map((h) => h.label).join(" → ")}`, technique = "Wikidata ownership statements (parent organisation / owned by, current, controlling stakes only); not confirmed by GLEIF.", legal;
  if (gleif && top.lei) {
    let up = await gleif.ultimateParent(top.lei), self = await gleif.record(top.lei);
    if (up.kind === "top" && self) {
      tier = "EXACT_ID", legal = self.legalCountry;
      let last2 = hops[hops.length - 1];
      hops[hops.length - 1] = { ...last2, relation: hops.length === 1 ? "brand_of" : "owned_by" };
      let country = last2.country || self.hqCountry || self.legalCountry || "";
      hops.push({
        name: readable(self.name, last2.name),
        relation: "ultimate_parent",
        country,
        ...self.legalCountry && self.legalCountry !== country ? { legal_country: self.legalCountry } : {},
        source: "gleif",
        source_id: top.lei,
        source_url: gleifUrl(top.lei)
      }), sources.push({ label: `GLEIF ${top.lei} (${self.name})`, url: gleifUrl(top.lei) }), summary += `; GLEIF confirms ${self.name} has no parent above it (${up.reason})`, technique = `Wikidata ownership chain, and GLEIF (LEI ${top.lei}) agrees the top company has no parent above it (${up.reason}).`;
    } else if (up.kind === "parent") {
      tier = "EXACT_ID";
      let p = up.record;
      hops[hops.length - 1] = { ...hops[hops.length - 1], relation: hops.length === 1 ? "operator" : "owned_by" }, hops.push({
        name: readable(p.name, p.name),
        relation: "ultimate_parent",
        country: p.hqCountry ?? p.legalCountry ?? "",
        legal_country: p.legalCountry && p.legalCountry !== p.hqCountry ? p.legalCountry : void 0,
        source: "gleif",
        source_id: p.lei,
        source_url: gleifUrl(p.lei)
      }), legal = p.legalCountry, sources.push({ label: `GLEIF ${p.lei} (${p.name})`, url: gleifUrl(p.lei) }), summary += `; GLEIF names ${p.name} as the ultimate parent`, technique = `Wikidata ownership chain to LEI ${top.lei}; GLEIF's filed ultimate parent (${p.name}, LEI ${p.lei}) completes it.`;
    }
  }
  let last = hops[hops.length - 1];
  if (last.country) {
    for (let h of hops) h.country || (h.country = last.country);
    return {
      chain: hops,
      owner_country: last.country,
      legal_country: legal && /^[A-Z]{2}$/.test(legal) ? legal : void 0,
      tier,
      technique,
      sources,
      walk,
      summary
    };
  }
}
export var CH_API = "https://api.company-information.service.gov.uk", chUrl = (n) => `https://find-and-update.company-information.service.gov.uk/company/${n}`, COUNTRY = {
  "UNITED KINGDOM": "GB",
  ENGLAND: "GB",
  "ENGLAND AND WALES": "GB",
  "ENGLAND & WALES": "GB",
  WALES: "GB",
  SCOTLAND: "GB",
  "NORTHERN IRELAND": "GB",
  UK: "GB",
  "GREAT BRITAIN": "GB",
  "UNITED STATES": "US",
  USA: "US",
  "UNITED STATES OF AMERICA": "US",
  DELAWARE: "US",
  "NEW YORK": "US",
  CALIFORNIA: "US",
  WASHINGTON: "US",
  IRELAND: "IE",
  "REPUBLIC OF IRELAND": "IE",
  NETHERLANDS: "NL",
  "THE NETHERLANDS": "NL",
  LUXEMBOURG: "LU",
  GERMANY: "DE",
  FRANCE: "FR",
  SPAIN: "ES",
  ITALY: "IT",
  SWEDEN: "SE",
  DENMARK: "DK",
  NORWAY: "NO",
  FINLAND: "FI",
  SWITZERLAND: "CH",
  BELGIUM: "BE",
  AUSTRIA: "AT",
  JERSEY: "JE",
  GUERNSEY: "GG",
  "ISLE OF MAN": "IM",
  GIBRALTAR: "GI",
  BERMUDA: "BM",
  "CAYMAN ISLANDS": "KY",
  "BRITISH VIRGIN ISLANDS": "VG",
  CANADA: "CA",
  AUSTRALIA: "AU",
  JAPAN: "JP",
  CHINA: "CN",
  "HONG KONG": "HK",
  SINGAPORE: "SG",
  INDIA: "IN",
  "UNITED ARAB EMIRATES": "AE",
  "SAUDI ARABIA": "SA",
  QATAR: "QA",
  "SOUTH AFRICA": "ZA",
  CYPRUS: "CY",
  MALTA: "MT",
  POLAND: "PL",
  "SOUTH KOREA": "KR",
  "KOREA, REPUBLIC OF": "KR",
  MEXICO: "MX",
  BRAZIL: "BR",
  ISRAEL: "IL",
  TURKEY: "TR"
};
export function countryFromText(t) {
  if (!t) return;
  let n = normaliseName(t);
  if (COUNTRY[n]) return COUNTRY[n];
  for (let [k, v] of Object.entries(COUNTRY)) if (n.includes(k)) return v;
}
export var CompaniesHouse = class {
  constructor(fetch2, apiKey) {
    this.fetch = fetch2;
    this.apiKey = apiKey;
  }
  fetch;
  apiKey;
  async get(path) {
    let auth = typeof btoa == "function" ? btoa(`${this.apiKey}:`) : "", res = await this.fetch(`${CH_API}${path}`, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } });
    if (res.status !== 404) {
      if (!res.ok) throw new Error(`Companies House HTTP ${res.status}`);
      return res.json();
    }
  }
  async findActive(name) {
    let want = stripLegalSuffix(name);
    if (want.length < 3) return;
    let hits = ((await this.get(`/search/companies?items_per_page=20&q=${encodeURIComponent(want)}`))?.items ?? []).filter((i) => i.company_status === "active" && i.company_number && i.title && stripLegalSuffix(i.title) === want);
    if (hits.length === 1)
      return { number: hits[0].company_number, title: hits[0].title };
  }
  async controller(number) {
    let live = ((await this.get(`/company/${number}/persons-with-significant-control?items_per_page=50`))?.items ?? []).filter((p) => !p.ceased_on), corporate = live.filter(
      (p) => p.kind === "corporate-entity-person-with-significant-control" && (p.natures_of_control ?? []).some((n) => /ownership-of-shares-(50|75)/.test(n))
    );
    if (corporate.length) return corporate.sort((a, b) => (b.natures_of_control ?? []).join().localeCompare((a.natures_of_control ?? []).join()))[0];
    if (live.some((p) => p.kind === "individual-person-with-significant-control")) return "people";
  }
  async chainFrom(start, maxDepth = 6) {
    let chain = [{ name: start.title, relation: "operator", country: "GB", source: "companies_house", source_id: start.number, source_url: chUrl(start.number) }], sources = [{ label: `Companies House ${start.number} (${start.title})`, url: chUrl(start.number) }], number = start.number, seen = new Set();
    for (let d = 0; number && d < maxDepth && !seen.has(number); d++) {
      seen.add(number);
      let c = await this.controller(number);
      if (!c || c === "people") break;
      let id = c.identification ?? {}, regUk = /companies house|england|wales|scotland|united kingdom/i.test(`${id.place_registered ?? ""} ${id.country_registered ?? ""}`), country = regUk ? "GB" : countryFromText(id.country_registered) ?? countryFromText(id.place_registered) ?? countryFromText(id.legal_authority);
      if (!country) break;
      let ukNumber = regUk && id.registration_number && /^[A-Z0-9]{6,8}$/i.test(id.registration_number.replace(/\s/g, "")) ? id.registration_number.replace(/\s/g, "").toUpperCase().padStart(8, "0") : void 0;
      chain.push({
        name: c.name ?? "Unnamed controller",
        relation: "owned_by",
        country,
        source: "companies_house",
        ...ukNumber ? { source_id: ukNumber, source_url: chUrl(ukNumber) } : {}
      }), ukNumber && sources.push({ label: `Companies House ${ukNumber} (${c.name})`, url: chUrl(ukNumber) }), number = ukNumber;
    }
    chain[chain.length - 1] = { ...chain[chain.length - 1], relation: "ultimate_parent" }, chain.length > 1 && (chain[0] = { ...chain[0], relation: "operator" });
    let top = chain[chain.length - 1];
    return { chain, owner_country: top.country, sources, summary: chain.map((h) => h.name).join(" → ") };
  }
};
export var COUNTRIES = new Set("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW".split(" "));

// Added 14 Oct 2026 for the AI step (ai.ts): searches are remembered within one request (the Companies House
// step and the AI step's evidence run the same company search), Companies House calls are counted for the
// daily cap, and two looser searches feed the AI step's evidence.
var wdGetRaw = Wikidata.prototype.get;
Wikidata.prototype.get = function (url) {
  if (!/wbsearchentities/.test(url)) return wdGetRaw.call(this, url);
  this.memo ??= new Map();
  if (!this.memo.has(url)) {
    let p = wdGetRaw.call(this, url);
    this.memo.set(url, p);
    p.catch(() => this.memo.delete(url));
  }
  return this.memo.get(url);
};
/** Wikidata items for a name, best first, without the exact-name filter of searchBusiness. */
Wikidata.prototype.searchIds = async function (name, limit = 10, raw = false) {
  let q = raw ? String(name).trim().slice(0, 100) : stripLegalSuffix(name);
  if (q.length < 2) return [];
  let url = `${WIKIDATA_API}?action=wbsearchentities&format=json&language=en&uselang=en&type=item&limit=${limit}&search=${encodeURIComponent(q)}`;
  return ((await this.get(url)).search ?? []).map((s) => s.id);
};
var chGetRaw = CompaniesHouse.prototype.get;
CompaniesHouse.prototype.get = function (path) {
  this.memo ??= new Map();
  if (!this.memo.has(path)) {
    this.calls = (this.calls ?? 0) + 1;
    let p = chGetRaw.call(this, path);
    this.memo.set(path, p);
    p.catch(() => this.memo.delete(path));
  }
  return this.memo.get(path);
};
/** Every company the register's search returns for a name (same request as findActive, so it's shared). */
CompaniesHouse.prototype.searchAll = async function (name) {
  let want = stripLegalSuffix(name);
  if (want.length < 3) return [];
  return (await this.get(`/search/companies?items_per_page=20&q=${encodeURIComponent(want)}`))?.items ?? [];
};
