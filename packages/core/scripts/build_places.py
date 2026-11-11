#!/usr/bin/env python3
"""
Build packages/core/data/places.json — town/city names that card terminals print after the shop
name, mapped to the countries that have a place by that name. Used on the device only, to tell
where a payment was made when the shop isn't in our list.

Source: GeoNames (CC BY 4.0, https://www.geonames.org) — cities5000.txt and cities15000.txt from
https://download.geonames.org/export/dump/.

Usage: python3 -I packages/core/scripts/build_places.py <dir-with-unzipped-geonames-files>

Rules:
  * UK, Ireland, Channel Islands, Isle of Man: every place with 5,000+ people.
  * Everywhere else: 50,000+ people (enough for holidays and billing seats).
  * Names that are everyday English words (top 15k, via wordfreq) or shorter than 4 letters are
    dropped, unless the place has 300,000+ people — "NICE", "BATH", "READING" and "SALE" would cause false matches.
  * A name in several countries lists them all; the app treats a place in the user's own country
    as home, so "PERTH" on a UK card is not taken as Australia.
"""
import json
import re
import sys
import unicodedata
from datetime import date
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "places.json"
HOME_LIKE = {"GB", "IE", "JE", "GG", "IM"}
KEEP_SHORT = {"YORK", "ROME", "BONN", "OSLO", "NICE", "LYON", "BARI", "GENT", "LODZ", "LIMA", "BAKU", "DOHA", "RIGA"}
# Common words / brands that are also places (beyond the word list).
BLOCK = {"MOBILE", "ORANGE", "VICTORIA", "SPLIT", "CHESTER", "BRANDON", "DEAL", "SALE", "MARCH", "BATH", "READING",
         "WELLS", "STREET", "HALIFAX", "BARCLAY", "SPRINGFIELD", "COLUMBIA", "PHOENIX", "GENERAL", "SANTANDER",
         "MONZO", "BOOTS", "NEXT", "BUY", "PAYPAL", "ALBANY", "AURORA", "ATLAS", "DELTA", "ESSEX", "KENT",
         "HOVE", "SUTTON", "RICHMOND", "KINGSTON", "LINCOLN", "JACKSON", "MADISON", "AUSTIN", "BURTON", "BOSTON",
         "WARWICK", "HAMILTON", "CAMBRIDGE", "WINDSOR", "DOVER", "PRESTON", "CLIFTON", "MORLEY", "HUNTER",
         "MILTON", "SHELL", "AMAZON", "APPLE", "ZARA", "TESCO", "SPAR", "LIDL", "ALDI", "EBAY", "UBER"}


def norm(s: str) -> str:
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn").upper()
    s = re.sub(r"['‘’`]", "", s)
    s = re.sub(r"[^A-Z0-9&]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def main() -> None:
    src = Path(sys.argv[1])
    from wordfreq import top_n_list
    common = {norm(w) for w in top_n_list("en", 15000)}
    places: dict[str, set[str]] = {}

    def add(name: str, cc: str, pop: int) -> None:
        n = norm(name)
        if not n or not re.fullmatch(r"[A-Z][A-Z ]*[A-Z]", n):
            return
        # Big cities are kept even when their name is a frequent word (LONDON, PARIS, DUBLIN).
        # Places in the home countries skip the word filter: a home-country match only ever says "home".
        if n in BLOCK or (cc not in HOME_LIKE and n in common and n not in KEEP_SHORT and pop < 300_000):
            return
        if len(n) < 4 and n not in KEEP_SHORT:
            return
        places.setdefault(n, set()).add(cc)

    for fname, min_pop, only in (("cities5000.txt", 5000, HOME_LIKE), ("cities15000.txt", 50000, None)):
        for line in (src / fname).read_text(encoding="utf-8").splitlines():
            f = line.split("\t")
            name, ascii_name, cc, pop = f[1], f[2], f[8], int(f[14] or 0)
            if pop < min_pop or (only and cc not in only):
                continue
            add(ascii_name or name, cc, pop)
            if name != ascii_name:
                add(name, cc, pop)
            if (ascii_name or name).endswith(" City") and pop >= 300_000:
                add((ascii_name or name)[:-5], cc, pop)  # "New York City" is printed as NEW YORK
    # Local names terminals print for big European cities (GeoNames' ascii names are the English ones).
    for local, cc in {
        "ROMA": "IT", "FIRENZE": "IT", "MILANO": "IT", "NAPOLI": "IT", "VENEZIA": "IT", "TORINO": "IT", "GENOVA": "IT",
        "LISBOA": "PT", "SEVILLA": "ES", "ZARAGOZA": "ES", "MUNCHEN": "DE", "MUENCHEN": "DE", "KOLN": "DE", "KOELN": "DE",
        "NURNBERG": "DE", "WIEN": "AT", "PRAHA": "CZ", "BRUXELLES": "BE", "BRUSSEL": "BE", "ANTWERPEN": "BE",
        "KOBENHAVN": "DK", "GOTEBORG": "SE", "GENEVE": "CH", "ZUERICH": "CH", "ATHINA": "GR", "WARSZAWA": "PL",
        "KRAKOW": "PL", "DEN HAAG": "NL", "S GRAVENHAGE": "NL", "BRUGGE": "BE", "GENT": "BE", "LUZERN": "CH",
    }.items():
        places.setdefault(local, set()).add(cc)
    out = {k: sorted(v) for k, v in sorted(places.items())}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "version": 1,
        "generated": date.today().isoformat(),
        "source": "GeoNames (CC BY 4.0) cities5000/cities15000",
        "places": out,
    }, separators=(",", ":")))
    print(f"wrote {len(out)} place names ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
