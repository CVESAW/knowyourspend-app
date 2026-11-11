#!/usr/bin/env python3
"""
Build packages/ownership/data/open-brands.json — the large, generated part of the built-in list.

Sources (both open data):
  * OpenStreetMap's name-suggestion-index (NSI, BSD-3) — brand names, the spellings people use,
    where each brand trades, its category and its Wikidata ID.
  * Wikidata (CC0) — who owns each brand (parent organisation / owned by) and where the top owner
    is run from (headquarters country, else country).

Usage:
  pip install wordfreq
  python3 -I packages/ownership/scripts/build_open_brands.py <path-to-unpacked-nsi-package> [--max 10000]

The NSI package is `npm pack name-suggestion-index` unpacked. Network: query.wikidata.org only.
The ownership walk mirrors the online lookup (services/lookup): current, non-deprecated statements;
"parent organisation" first; "owned by" only when one controlling (>50% or unspecified) holder;
index funds/asset managers ignored; the walk stops at people and families.
"""
from __future__ import annotations

import json
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "data" / "open-brands.json"
CACHE = HERE / ".wikidata-cache.json"  # gitignored; speeds up re-runs
SPARQL = "https://query.wikidata.org/sparql"
UA = "KnowYourSpend-list-builder/1.0 (https://github.com/CVESAW/knowyourspend)"

# Where our users spend: UK and Ireland first, then places UK people shop online or on holiday.
RELEVANT = {
    "gb", "ie", "001", "150", "154", "155", "039", "us", "de", "fr", "fx", "es", "it", "nl", "be",
    "at", "ch", "pt", "se", "no", "dk", "fi", "pl", "lu", "gr", "cz", "mt", "cy", "is",
}
PRIORITY = {"gb": 0, "ie": 0, "001": 1, "150": 1, "154": 1, "us": 2}
PASSIVE_HOLDERS = {
    "Q849363", "Q219635", "Q2037125", "Q11992019", "Q970769", "Q505275", "Q1411292", "Q522617",
    "Q2844522", "Q1142797", "Q3511946", "Q2557807", "Q105773164",
}
PERSON_OR_FAMILY = {"Q5", "Q8436"}
# Categories that are not places people pay (or that would only add noise).
SKIP_CATEGORIES = re.compile(r"^brands/(?:man_made|office/government|amenity/(?:post_box|atm|bicycle_rental|charging_station|vending_machine|parcel_locker|letter_box|townhall|police|school|kindergarten|library|grave_yard|place_of_worship|social_facility|recycling|waste|toilets|drinking_water|post_depot|car_sharing|motorcycle_parking|parking_entrance|bench|shelter|clock|telephone|bus_station|courthouse|prison|ranger_station|fire_station|community_centre|public_bookcase))")


def norm(s: str) -> str:
    """Same rules as packages/ownership/src/resolve.ts normalise()."""
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = s.upper()
    s = re.sub(r"['‘’`]", "", s)
    s = re.sub(r"[^A-Z0-9&]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def latin_only(s: str) -> bool:
    return all(ord(c) < 0x250 or c in "’‘" for c in s)


def slug(s: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", norm(s).lower().replace("&", " and "))).strip("-") or "x"


def domain_of(url: str) -> str | None:
    try:
        host = urllib.parse.urlparse(url if "//" in url else "https://" + url).hostname or ""
    except ValueError:
        return None
    host = host.lower()
    if host.startswith("www."):
        host = host[4:]
    if not host or "." not in host:
        return None
    # Keep the registrable part: last two labels, or three for co.uk-style suffixes.
    parts = host.split(".")
    if len(parts) >= 3 and parts[-2] in {"co", "com", "org", "net", "ac", "gov", "ltd", "me"} and len(parts[-1]) == 2:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


# Hosts that belong to platforms, not the brand.
SHARED_HOSTS = {
    "facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com", "google.com", "wikipedia.org",
    "youtube.com", "tiktok.com", "linktr.ee", "squarespace.com", "wixsite.com", "wordpress.com",
    "blogspot.com", "shopify.com", "apple.com", "github.io", "co.uk", "com", "bit.ly", "gov.uk",
}


# --------------------------------------------------------------------------------------------- Wikidata
def sparql(query: str, tries: int = 6) -> list[dict]:
    body = urllib.parse.urlencode({"query": query, "format": "json"}).encode()
    for attempt in range(tries):
        req = urllib.request.Request(SPARQL, data=body, headers={
            "User-Agent": UA, "Accept": "application/sparql-results+json",
            "Content-Type": "application/x-www-form-urlencoded",
        })
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)["results"]["bindings"]
        except Exception as e:  # 429 / 5xx / timeouts
            wait = 3 * (attempt + 1) ** 2
            print(f"  sparql retry {attempt + 1} after {e!s:.80} (wait {wait}s)", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError("Wikidata SPARQL kept failing")


def _num(v: str) -> float | None:
    try:
        return float(v)
    except ValueError:  # "unknown value" placeholders
        return None


def qid(uri: str) -> str:
    return uri.rsplit("/", 1)[-1]


CLAIMS_Q = """
SELECT ?item ?prop ?val ?rank ?share ?end WHERE {
  VALUES ?item { %s }
  VALUES (?prop ?ps) { (p:P749 ps:P749) (p:P127 ps:P127) (p:P17 ps:P17) (p:P159 ps:P159) (p:P31 ps:P31) (p:P297 ps:P297) }
  ?item ?prop ?st . ?st ?ps ?val ; wikibase:rank ?rank .
  FILTER(?rank != wikibase:DeprecatedRank)
  OPTIONAL { ?st pq:P1107 ?share }
  OPTIONAL { ?st pq:P582 ?end }
}"""
# 18 Oct 2026: English first, then "mul" (one name for every language) and other languages written in Latin letters,
# as newer companies often have no English label (the list had 242 owners named only by their id).
LABEL_ORDER = ["en", "en-gb", "mul", "fr", "de", "es", "it", "nl", "pt", "sv", "da", "nb", "fi", "pl"]
LABEL_Q = """
SELECT ?item ?label ?lang WHERE {
  VALUES ?item { %s }
  ?item rdfs:label ?label . BIND(LANG(?label) AS ?lang)
  FILTER(?lang IN ("en", "en-gb", "mul", "fr", "de", "es", "it", "nl", "pt", "sv", "da", "nb", "fi", "pl"))
}"""


class Wd:
    def __init__(self) -> None:
        self.ent: dict[str, dict] = {}
        if CACHE.exists():
            try:
                self.ent = json.loads(CACHE.read_text())
            except ValueError:
                self.ent = {}

    def save(self) -> None:
        CACHE.write_text(json.dumps(self.ent))

    def load(self, ids: set[str], batch: int = 250) -> None:
        need = sorted(i for i in ids if re.fullmatch(r"Q\d+", i) and (i not in self.ent or not self.ent[i].get("label")))
        for i in range(0, len(need), batch):
            chunk = need[i:i + batch]
            values = " ".join(f"wd:{x}" for x in chunk)
            rows = sparql(CLAIMS_Q % values)
            labels = sparql(LABEL_Q % values)
            ents = {x: {"claims": defaultdict(list), "label": None} for x in chunk}
            for r in rows:
                e = ents[qid(r["item"]["value"])]
                prop = r["prop"]["value"].rsplit("/", 1)[-1]
                v = r["val"]["value"]
                e["claims"][prop].append({
                    "v": qid(v) if v.startswith("http://www.wikidata.org/entity/") else v,
                    "pref": r["rank"]["value"].endswith("PreferredRank"),
                    "share": _num(r["share"]["value"]) if "share" in r else None,
                    "end": r["end"]["value"] if "end" in r else None,
                })
            rank: dict[str, int] = {}
            for r in labels:
                k, v, lang = qid(r["item"]["value"]), r["label"]["value"], r["lang"]["value"]
                at = LABEL_ORDER.index(lang) if lang in LABEL_ORDER else len(LABEL_ORDER)
                if latin_only(v) and at < rank.get(k, len(LABEL_ORDER) + 1):
                    rank[k] = at
                    ents[k]["label"] = v
            for k, e in ents.items():
                e["claims"] = dict(e["claims"])
                self.ent[k] = e
            print(f"  wikidata {min(i + batch, len(need))}/{len(need)}", file=sys.stderr)
            if (i // batch) % 10 == 9:
                self.save()
            time.sleep(0.5)
        self.save()

    @staticmethod
    def current(claims: list[dict]) -> list[dict]:
        today = date.today().isoformat()
        live = [c for c in claims if not (c["end"] and c["end"][:10] < today)]
        pref = [c for c in live if c["pref"]]
        return pref or live

    def parents(self, i: str) -> list[str]:
        e = self.ent.get(i)
        if not e:
            return []
        c = e["claims"]
        out = [x["v"] for x in self.current(c.get("P749", [])) if x["v"] != i]
        owners = [x for x in self.current(c.get("P127", [])) if x["v"] != i]
        controlling = [o for o in owners if o["v"] not in PASSIVE_HOLDERS and (o["share"] is None or (o["share"] * 100 if o["share"] <= 1 else o["share"]) > 50)]
        unshared = [o for o in controlling if o["share"] is None]
        usable = [o for o in controlling if o["share"] is not None] + (unshared if len(unshared) == 1 else [])
        for o in usable:
            if o["v"] not in out:
                out.append(o["v"])
        return out

    def is_person_or_family(self, i: str) -> bool:
        e = self.ent.get(i)
        return bool(e) and any(x["v"] in PERSON_OR_FAMILY for x in e["claims"].get("P31", []))

    def iso(self, i: str) -> str | None:
        e = self.ent.get(i)
        if not e:
            return None
        for x in self.current(e["claims"].get("P297", [])):
            if re.fullmatch(r"[A-Z]{2}", x["v"]):
                return x["v"]
        return None

    def refs(self, i: str) -> set[str]:
        """Entities whose claims we need to answer country/parent questions about i."""
        e = self.ent.get(i)
        if not e:
            return set()
        c = e["claims"]
        out = set(self.parents(i))
        for p in ("P17", "P159"):
            out |= {x["v"] for x in self.current(c.get(p, []))}
        return out

    def country(self, i: str) -> str | None:
        e = self.ent.get(i)
        if not e:
            return None
        c = e["claims"]
        own = self.iso(i)
        if own:
            return own
        for hq in self.current(c.get("P159", [])):
            iso = self.iso(hq["v"])
            if iso:
                return iso
            he = self.ent.get(hq["v"])
            if he:
                for cc in self.current(he["claims"].get("P17", [])):
                    iso = self.iso(cc["v"])
                    if iso:
                        return iso
        for cc in self.current(c.get("P17", [])):
            iso = self.iso(cc["v"])
            if iso:
                return iso
        return None


def walk(wd: Wd, start: str, depth: int = 8) -> list[str]:
    hops: list[str] = []
    cur: str | None = start
    while cur and len(hops) <= depth and cur not in hops:
        if cur not in wd.ent or wd.is_person_or_family(cur):
            break
        hops.append(cur)
        ps = wd.parents(cur)
        cur = ps[0] if ps else None
    return hops


# --------------------------------------------------------------------------------------------- main
def main() -> None:
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    nsi_dir = Path(args[0])
    max_n = int(args[args.index("--max") + 1]) if "--max" in args else 10000

    from wordfreq import top_n_list  # only needed at build time
    common = {norm(w) for w in top_n_list("en", 15000)}

    nsi = json.loads((nsi_dir / "dist/json/nsi.json").read_text())["nsi"]
    wdinfo = json.loads((nsi_dir / "dist/wikidata/wikidata.json").read_text())["wikidata"]
    dissolved = set(json.loads((nsi_dir / "dist/wikidata/dissolved.json").read_text()).get("dissolved", {}).keys())
    generic = {norm(w) for w in json.loads((nsi_dir / "dist/json/genericWords.json").read_text()).get("genericWords", [])}
    nsi_version = json.loads((nsi_dir / "package.json").read_text())["version"]

    brands: dict[str, dict] = {}
    for key, block in nsi.items():
        if not key.startswith("brands/") or SKIP_CATEGORIES.match(key):
            continue
        cat = key.split("/", 1)[1]
        for it in block["items"]:
            tags = it.get("tags", {})
            q = tags.get("brand:wikidata")
            if not q or q in dissolved:
                continue
            locs = {str(x).lower() for x in it.get("locationSet", {}).get("include", [])}
            locs = {("gb" if l.startswith("gb-") else l) for l in locs if isinstance(l, str)}
            if not locs & RELEVANT:
                continue
            b = brands.setdefault(q, {"qid": q, "names": [], "cats": set(), "locs": set()})
            for n in [it.get("displayName"), tags.get("brand"), tags.get("brand:en"), tags.get("name"), tags.get("name:en"), *it.get("matchNames", [])]:
                if n and n not in b["names"]:
                    b["names"].append(n)
            b["cats"].add(cat)
            b["locs"] |= locs
    print(f"NSI {nsi_version}: {len(brands)} relevant brands with a Wikidata ID", file=sys.stderr)

    wd = Wd()
    frontier = set(brands)
    for round_ in range(10):
        wd.load(frontier)
        nxt: set[str] = set()
        for i in frontier:
            nxt |= wd.refs(i)
        nxt -= set(wd.ent)
        print(f"round {round_}: {len(nxt)} more entities", file=sys.stderr)
        if not nxt:
            break
        frontier = nxt

    out = []
    no_country = 0
    for q, b in brands.items():
        hops = walk(wd, q)
        if not hops:
            continue
        countries = [wd.country(h) for h in hops]
        top_country = next((c for c in reversed(countries) if c), None)
        if not top_country:
            no_country += 1
            continue
        filled = []
        last = top_country
        for h, c in zip(reversed(hops), reversed(countries)):
            last = c or last
            filled.append(last)
        filled.reverse()
        info = wdinfo.get(q, {})
        label = (wd.ent.get(q) or {}).get("label") or info.get("label") or b["names"][0]
        names = [n for n in [label, *b["names"]] if latin_only(n)]
        aliases, strict = [], []
        for n in names:
            a = norm(n)
            if len(a) < 3 or not re.search(r"[A-Z]", a) or a in aliases or a in generic:
                continue
            aliases.append(a)
            if (" " not in a and (a in common or len(a) <= 4)):
                strict.append(a)
        if not aliases:
            continue
        doms = []
        for u in [info.get("identities", {}).get("website"), *info.get("officialWebsites", [])]:
            d = domain_of(u) if u else None
            if d and d not in SHARED_HOSTS and d not in doms:
                doms.append(d)
        chain = [[(wd.ent.get(h) or {}).get("label") or (label if h == q else h), h, c] for h, c in zip(hops, filled)]
        prio = min((PRIORITY.get(l, 3) for l in b["locs"]), default=3)
        out.append({
            "id": f"osm-{slug(label)}-{q.lower()}",
            "name": label,
            "qid": q,
            "aliases": aliases,
            **({"strict": strict} if strict else {}),
            "cat": sorted(b["cats"])[0],
            "oc": top_country,
            "chain": chain,
            **({"dom": doms[:3]} if doms else {}),
            "loc": sorted(b["locs"]),
            "_p": prio,
        })
    out.sort(key=lambda e: (e["_p"], e["name"].lower()))
    out = out[:max_n]
    for e in out:
        del e["_p"]
    out.sort(key=lambda e: e["id"])
    OUT.write_text(json.dumps({
        "version": 1,
        "generated": date.today().isoformat(),
        "sources": [f"name-suggestion-index {nsi_version} (BSD-3-Clause)", "Wikidata (CC0)"],
        "brands": out,
    }, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {len(out)} brands to {OUT} ({OUT.stat().st_size // 1024} KB); {no_country} skipped with no country", file=sys.stderr)


if __name__ == "__main__":
    main()
