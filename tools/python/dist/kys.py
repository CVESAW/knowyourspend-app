#!/usr/bin/env python3
"""kys.py: who owns the shops on your bank statement.

KnowYourSpend's matching, in one file you can read. Give it a line of bank text or a statement saved as CSV, and it
recognises each shop and tells you which company owns it and the country that company is run from.

Privacy
  * Offline by default: nothing from your statement leaves your computer.
  * The one download is our open ownership list (about 2 MB), checked against its SHA-256 before it's used.
  * --online is up to you. It sends only the names of shops our list doesn't know to our look-up service (run on
    Supabase in Ireland), and only after showing you the list. Names that look like a person's, sensitive names,
    local independents and payments that aren't to a shop are never sent.

Usage
  python3 kys.py data update                          download the ownership list (once, then now and again)
  python3 kys.py lookup "COSTA COFFEE 43012 LONDON GB"
  python3 kys.py statement my-statement.csv           writes my-statement.owners.csv and prints a summary
  python3 kys.py statement my-statement.csv --online  also asks our online look-up about shops we don't know

Python 3.9 or newer, standard library only. MIT licence (the text is at the end). https://knowyourspend.org

This file is built by tools/python/build.mjs from tools/python/kys.template.py and the app's TypeScript code. The
matching follows the app's code function by function (the comments name the TypeScript each part comes from), and
the tables at the end are copied from it by the build, so the answers are the same as the app's.
"""

import argparse
import csv
import email.utils
import hashlib
import http.client
import io
import json
import math
import os
import re
import socket
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from functools import cmp_to_key, lru_cache

__version__ = "1.0.0"

DATA_URL = "https://knowyourspend.org/data/manifest.json"
DATA_FILES = ("merchants.json", "product-brands.json", "open-brands.json", "open-brand-corrections.json", "countries.json")
USER_AGENT = "kys.py/%s (+https://knowyourspend.org)" % __version__

A = re.ASCII  # so \b, \d and \w mean what they mean in JavaScript


# =====================================================================================================================
# Behaving like JavaScript
# The app is written in TypeScript. These few helpers give Python the same idea of whitespace and string length.
# =====================================================================================================================

# What JavaScript's \s and trim() count as whitespace (Python's own list differs slightly).
JS_SPACE = (
    "\t\n\x0b\x0c\r \xa0\N{OGHAM SPACE MARK}"
    + "".join(map(chr, range(0x2000, 0x200B)))  # en quad ... hair space
    + "\N{LINE SEPARATOR}\N{PARAGRAPH SEPARATOR}\N{NARROW NO-BREAK SPACE}\N{MEDIUM MATHEMATICAL SPACE}"
    + "\N{IDEOGRAPHIC SPACE}\N{ZERO WIDTH NO-BREAK SPACE}"
)
_JS_SPACES = re.compile("[" + JS_SPACE + "]+")
# What JavaScript's "." matches: anything but a line break.
JS_DOT = "[^\n\r\N{LINE SEPARATOR}\N{PARAGRAPH SEPARATOR}]"


def js_trim(s):
    """String.prototype.trim()"""
    return s.strip(JS_SPACE)


def js_collapse(s):
    """s.replace(/\\s+/g, " ")"""
    return _JS_SPACES.sub(" ", s)


def js_len(s):
    """JavaScript's .length: characters outside the Basic Multilingual Plane count twice (UTF-16)."""
    return len(s) + sum(1 for c in s if ord(c) > 0xFFFF)


def js_slice(s, n):
    """s.slice(0, n), counting in UTF-16 code units as JavaScript does."""
    if js_len(s) <= n:
        return s
    return s.encode("utf-16-le", "surrogatepass")[: 2 * n].decode("utf-16-le", "surrogatepass")


def js_round(x):
    """Math.round: halves go up (towards +infinity)."""
    r = math.floor(x)
    return r + 1 if x - r >= 0.5 else r


# =====================================================================================================================
# 1. Bank text -> the shop's name                      packages/statement/src/normalise.ts  normalisePayee
# The normalised name is the only thing --online ever sends. Everything that is a place, a time, an amount, a card,
# a reference or the bank's own words is removed: "CARD PAYMENT TO TESCO STORES 3456 LONDON GB" -> "TESCO STORES".
# =====================================================================================================================

_COMBINING = re.compile("[\N{COMBINING GRAVE ACCENT}-\N{COMBINING LATIN SMALL LETTER X}]")
_NOT_PRINTABLE = re.compile(r"[^\x20-\x7e]")


def _spaces(m):
    # JavaScript replaces each UTF-16 unit, so a character beyond the Basic Multilingual Plane becomes two spaces
    return "  " if ord(m.group()) > 0xFFFF else " "


def _keep(prev, nxt):
    """Apply a rule only if it leaves a letter: never normalise a payee to nothing."""
    t = re.sub(r"\s+", " ", nxt, flags=A).strip()
    return t if re.search(r"[A-Z]", t) else prev


def _strip_more_places(s):
    """A town from the longer list comes off only when a word of the shop's name is left before it."""
    nxt = MORE_PLACE_RE.sub("", s, count=1).strip()
    if nxt == s or not re.search(r"[A-Z].*[A-Z]|[A-Z]&[A-Z]", nxt) or CONNECTOR_BEFORE.search(nxt):
        return s
    return nxt


def _strip_trailing(s, rx, guard_connector=False):
    """Repeatedly apply a trailing-strip regex until it stops matching."""
    while True:
        nxt = rx.sub("", s, count=1).strip()
        if nxt == s:
            return s
        if guard_connector and CONNECTOR_BEFORE.search(nxt):
            return s
        kept = _keep(s, nxt)
        if kept == s:
            return s
        s = kept


_TRAILING_PUNCT = re.compile(r"[\s\-&/.*+#]+$", A)
_OUTWARD_POSTCODE = re.compile(r"\s(?:[BEGLMNSW]|[A-Z]{2})\d[A-Z\d]?$", A)  # LS6, M1, EC1A
_STORE_NUMBER = re.compile(r"\s#?\d+$", A)


def _apply_known_forms(s):
    for rx, canonical in KNOWN_FORMS:
        if rx.search(s):
            return canonical
    return s


def _domain_label(tok):
    m = DOMAIN_TOKEN_RE.search(tok)
    return m.group(1) if m else tok


def _pass(text):
    """One pass of every rule, in order. normalise_payee repeats it until nothing changes."""
    s = unicodedata.normalize("NFKD", text)
    s = _COMBINING.sub("", s)  # strip accents: CAFE with an accent -> CAFE
    s = s.upper()
    s = re.sub("[\xa0\N{FIGURE SPACE}\N{NARROW NO-BREAK SPACE}\t\r\n]", " ", s)
    s = re.sub("[\N{LEFT SINGLE QUOTATION MARK}\N{RIGHT SINGLE QUOTATION MARK}`']", "", s)  # SAINSBURY'S -> SAINSBURYS
    s = _NOT_PRINTABLE.sub(_spaces, s)  # anything else outside printable ASCII (pound and euro signs...)
    # From here on the text is printable ASCII, where Python's \s and $ mean what JavaScript's do.

    # Padded trailing country (Barclays "DREAMHOST.COM         UNITED STATES"): the padding makes even
    # ambiguous two-letter codes safe to drop.
    s = _keep(s, PADDED_COUNTRY_RE.sub("", s, count=1))
    s = re.sub(r"\s+", " ", s, flags=A).strip()

    # Santander FX clause: ",4.40 GBP, RATE 1.00/GBP ON 01-03-2018"
    s = _keep(s, re.sub(r"\s*,\s*[\d.,]+\s*[A-Z]{3}\s*,\s*RATE\s+[\d.]+\s*/\s*[A-Z]{3}(?:\s+ON\s+\S+)?.*$", "", s, count=1, flags=A))
    # "ON 12 MAR", "ON 12MAR24", "ON 01-03-2018" and everything after (Barclays memo tail codes)
    s = _keep(s, re.sub(
        r"\s+ON\s+(?:\d{1,2}\s?(?:" + MONTHS + r")(?:\s?\d{2,4})?|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\b.*$", "", s, count=1, flags=A))
    # NatWest card+date prefix: "4298 11JAN19 C , TESCO ..." / "4321 01SEP26 TESCO ..."
    s = _keep(s, re.sub(r"^\d{4}\s+\d{1,2}(?:" + MONTHS + r")\d{2}(?:\s+[A-Z]{1,2}\s*,|\s*,|\s+)", "", s, count=1, flags=A))

    # Punctuation that is never part of a merchant key.
    s = re.sub(r"[\",;:!?()\[\]{}<>|=~^]", " ", s)
    s = s.replace(")))", " ")
    s = re.sub(r"\s+", " ", s, flags=A).strip()

    # Bank prefixes (may be stacked: "DD DIRECT DEBIT ...").
    for _ in range(4):
        nxt = _keep(s, PREFIX_RE.sub("", s, count=1))
        if nxt == s:
            break
        s = nxt
    # "To" in front of money sent to a business ("To Example Supplies Ltd"), when two words or more follow
    s = re.sub(r"^TO\s+(?=\S+\s+\S)", "", s, count=1, flags=A)

    s = _apply_known_forms(s)

    # Card suffixes and markers.
    s = _keep(s, re.sub(r"\*+\s?\d{4}\b", " ", s, flags=A))
    s = _keep(s, re.sub(r"\bX{3,}\d{4}\b", " ", s, flags=A))
    s = _keep(s, re.sub(r"\b(?:CARD\s+)?ENDING\s*(?:IN\s*)?\d{4}\b", " ", s, flags=A))
    s = _keep(s, re.sub(r"\bCD\s?\d{4}\b", " ", s, flags=A))

    # Facilitator prefix: keep the merchant after it, or the facilitator itself if nothing follows.
    fac = FACILITATOR_RE.search(s)
    if fac:
        rest = s[fac.end():].strip()
        name = FACILITATOR_NAME.get(fac.group(1), fac.group(1))
        if not re.search(r"[A-Z]", rest):
            s = name
        elif fac.group(1) == "BT" and BT_OWN.search(rest):  # "BT *MOBILE" is BT's own bill
            s = "BT " + rest
        else:
            s = rest
    s = _apply_known_forms(s)

    # "MERCHANT*DETAIL" -> MERCHANT (a star that isn't a facilitator's: the left side is the merchant).
    if "*" in s:
        left = s[: s.index("*")].strip()
        s = left if re.search(r"[A-Z]", left) else s.replace("*", " ")
    # A run of zeros before the name is a terminal field: "000*RAILFINDER".
    s = _keep(s, re.sub(r"^0+\s+", "", s, count=1, flags=A))
    # A long number run into the name when that's all the payee is: "HIRECO1234567890" -> HIRECO.
    s = re.sub(
        r"^(?!(?:ORDER|INVOICE|POLICY|ACCOUNT|ACCT|MANDATE|MEMBER|TICKET|BOOKING|CUSTOMER|CUST|TRANS|PAYMENT|REFUND|BILL)\d)"
        r"([A-Z]{4,})\d{6,}$", r"\1", s, count=1, flags=A)

    # Domains -> brand label: NETFLIX.COM -> NETFLIX, HELP.UBER.COM -> UBER.
    s = " ".join(_domain_label(tok) for tok in s.split(" "))
    s = _apply_known_forms(s)

    # Dates, times, amounts anywhere.
    s = _keep(s, re.sub(r"\b\d{1,2}\s?(?:" + MONTHS + r")\s?\d{2}(?:\d{2})?\b", " ", s, flags=A))
    s = _keep(s, re.sub(r"\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b", " ", s, flags=A))
    s = _keep(s, re.sub(r"\b(?:0[1-9]|[12]\d|3[01])/(?:0[1-9]|1[0-2])\b(?!/)", " ", s, flags=A))  # "PIPPA 12/08"
    s = _keep(s, re.sub(r"\b\d{4}-\d{2}-\d{2}\b", " ", s, flags=A))
    s = _keep(s, re.sub(r"\b\d{1,2}:\d{2}(?::\d{2})?\b", " ", s, flags=A))
    s = _keep(s, re.sub(r"(?:GBP|EUR|USD)\s?\d[\d,]*(?:\.\d{1,2})?\b", " ", s, flags=A))
    s = _keep(s, re.sub(r"\b\d[\d,]*\.\d{2}\b(?:\s?(?:GBP|EUR|USD)\b)?", " ", s, flags=A))
    s = _keep(s, re.sub(r"\bRATE\s+[\d.]+\S*", " ", s, flags=A))

    # References: "REF 12345", "REF:ABC", and any word of 8 or more characters with at least two digits.
    s = _keep(s, re.sub(r"\bREF(?:ERENCE)?\b\.?\s*#?\s*\S*", " ", s, flags=A))
    s = _keep(s, re.sub(r"\bMANDATE\s+(?:NO|NUMBER)\b\.?\s*\S*", " ", s, flags=A))
    s = _keep(s, re.sub(r"(?<![A-Z0-9])(?=(?:[A-Z/-]*\d){2})[A-Z0-9/-]{8,}(?![A-Z0-9/-])", " ", s, flags=A))
    s = _keep(s, re.sub(r"#\s*\d+", " ", s, flags=A))

    # Full UK postcodes anywhere.
    s = _keep(s, re.sub(r"\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b", " ", s, flags=A))
    s = re.sub(r"\s+", " ", s, flags=A).strip()

    # Trailing noise, repeated until stable: countries, places, outward postcodes, store numbers, codes.
    for _ in range(8):
        before = s
        s = _strip_trailing(s, _TRAILING_PUNCT)
        s = _strip_trailing(s, TRAILING_COUNTRY_RE, True)
        s = _strip_trailing(s, TRAILING_PLACE_RE, True)
        s = _strip_more_places(s)
        s = _strip_trailing(s, _OUTWARD_POSTCODE)
        s = _strip_trailing(s, _STORE_NUMBER)
        s = _strip_trailing(s, TRAILING_CODE_RE)
        if s == before:
            break
    s = re.sub(r"^[\s\-&/.*+#]+", "", s, count=1, flags=A).strip()
    # The name printed twice ("Hotelnet HOTELNET 55"), five letters or more.
    s = re.sub(r"^([A-Z][A-Z&-]{4,}) \1(?= |$)", r"\1", s, count=1, flags=A)

    s = _apply_known_forms(s)
    if len(s) > MAX_PAYEE_LENGTH:
        s = s[:MAX_PAYEE_LENGTH].strip()
    return s


@lru_cache(maxsize=1 << 16)  # statements repeat the same text many times
def normalise_payee(raw):
    """The shop's name from raw bank text: what a look-up would send. Returns "" only for blank text."""
    s = raw or ""
    if not js_trim(s):
        return ""
    for _ in range(10):
        nxt = _pass(s)
        if nxt == s:
            return nxt
        s = nxt
    return s


# =====================================================================================================================
# 2. What kind of payment, and could it be a person?   packages/statement/src/classify.ts
# A person's name must never be sent anywhere, so anything that might be a payment to a person is held back.
# =====================================================================================================================

def type_hint(type_label):
    """typeHint: what a bank's type code or label ("DEB", "Card payment", "FASTER PAYMENT") says about a row."""
    if not type_label:
        return None
    t = js_collapse(js_trim(type_label).upper())
    if not t:
        return None
    code = UK_TYPE_CODES.get(t)
    if code:
        return code
    words = t.replace("_", " ")  # CARD_PAYMENT -> CARD PAYMENT
    for rx, hint in TYPE_LABEL_RULES:
        if rx.search(words):
            return hint
    return None


def _prefix_hint(text):
    for rx, hint in DESCRIPTION_PREFIX_RULES:
        if rx.search(text):
            return hint
    return None


def own_money_platform(payee):
    """ownMoneyPlatform: the payee is an investment platform on its own (money to your own account there)."""
    m = PLATFORM.search(normalise_payee(payee))
    if not m:
        return False
    rest = FINANCE_WORDS.sub(" ", m.group(1))
    rest = re.sub(r"\b[A-Z]*\d[A-Z0-9]*\b", " ", rest, flags=A)
    return not re.search(r"[A-Z]{2,}", rest)


def looks_like_person(raw):
    """looksLikePerson: "J SMITH", "D STEPHENS 18MAY19", "Jane Smith", "MR J A SMITH"."""
    s = raw.upper()
    s = re.sub("[\N{LEFT SINGLE QUOTATION MARK}\N{RIGHT SINGLE QUOTATION MARK}']", "", s)
    s = re.sub(r"\b\d{1,2}(?:" + CLASSIFY_MONTHS + r")\d{2,4}\b", " ", s, flags=A)  # 18MAY19
    s = re.sub(r"\b(?:REF|REFERENCE)\b" + JS_DOT + r"*\Z", " ", s, count=1, flags=A)
    s = re.sub("[^A-Z&" + JS_SPACE + "-]", " ", s)
    s = js_trim(js_collapse(s))
    s = re.sub(r"^(?:TO|FROM)\s+", "", s, count=1, flags=A)
    s = HONORIFICS.sub("", s, count=1)
    if not s:
        return False
    if ORG_WORDS.search(s) or BRAND_RE.search(s):
        return False
    tokens = s.split(" ")
    if len(tokens) < 2 or len(tokens) > 4:
        return False
    if not all(re.match(r"[A-Z][A-Z-]{0,19}\Z", t) for t in tokens):
        return False
    return any(len(t) >= 2 for t in tokens)  # at least one plausible surname


def _person_after_facilitator(payee, desc):
    """PayPal pays people too: "PAYPAL *JOHNSMITH", "PP*SARAHJONES" may be a person's name."""
    after = [m for m in (PAYEE_AFTER_FACILITATOR.search(x) for x in (payee, desc)) if m]
    if not after:
        return False
    if any(WEB_ADDRESS.search(m.group(1)) for m in after):
        return False
    name = HONORIFICS.sub("", normalise_payee(payee) or normalise_payee(desc), count=1)
    if not name or name in BRAND_NAMES or ORG_WORDS.search(name):
        return False
    tokens = name.split(" ")
    return (
        len(tokens) <= 4
        and all(re.match(r"[A-Z][A-Z'.-]{0,39}\Z", t) for t in tokens)
        and any(re.search(r"[A-Z].*[A-Z]", t) for t in tokens)
    )


def may_be_person(raw_payee, raw_description=None, type_label=None):
    """mayBePerson: a one-word name paid by bill payment or transfer ("PIPPA"), or a person-like name after PayPal."""
    payee = js_trim(js_collapse((raw_payee or "").upper()))
    desc = js_trim(js_collapse((raw_description or "").upper()))
    if _person_after_facilitator(payee, desc):
        return True
    hint = type_hint(type_label)
    if not hint or hint == "other":
        found = _prefix_hint(desc or payee)
        hint = found if found is not None else hint
    if hint not in ("bill", "transfer", "income"):
        return False
    name = re.sub(r"^(?:TO|FROM)\s+", "", normalise_payee(payee), count=1, flags=A)
    name = HONORIFICS.sub("", name, count=1)
    if not re.match(r"[A-Z][A-Z'-]{1,24}\Z", name):
        return False
    return not ORG_WORDS.search(name) and not BRAND_RE.search(name)


def _has_org_marker(s):
    return bool(ORG_WORDS.search(s) or BRAND_RE.search(s))


def classify(amount, raw_payee, raw_description=None, type_label=None, category=None):
    """classify: "spend", "refund", "transfer", "cash", "fee", "internal", "income" or "unknown". Conservative: a
    payment that might be to a person is a transfer."""
    payee = js_trim(js_collapse((raw_payee or "").upper()))
    desc = js_trim(js_collapse((raw_description or "").upper()))
    text = js_trim(payee + " " + desc)
    cat = js_trim((category or "").upper())
    hint = type_hint(type_label)
    if not hint or hint == "other":
        found = _prefix_hint(desc or payee)
        hint = found if found is not None else hint

    if amount is None or not math.isfinite(amount) or amount == 0:
        return "unknown"
    if hint in (None, "other", "bill", "income") and TRANSFER_TEXT.search(text):
        hint = "transfer"

    # Own-money movements first, for both signs (pots, savings, top-ups, conversions, card repayments).
    if hint == "internal" or INTERNAL_TEXT.search(text) or cat == "SAVINGS":
        return "internal"
    if own_money_platform(payee) or (hint and hint not in ("card", "refund") and SAVINGS_ACCOUNT.search(text)):
        return "internal"

    if amount > 0:
        if hint in ("refund", "card") or REFUND_TEXT.search(text):
            return "refund"
        return "income"

    personish = looks_like_person(payee) or looks_like_person(normalise_payee(payee))
    # Cash beats card: some banks report cash machine withdrawals as card payments.
    if hint == "cash" or cat == "CASH" or (hint != "dd" and CASH_TEXT.search(text)):
        return "cash"
    if hint == "fee" or FEE_TEXT.search(text):
        return "fee"
    if hint in ("dd", "transfer", "bill") and CARD_REPAYMENT.search(payee):
        return "internal"
    if PERSON_LINK.search(payee):
        return "transfer"
    if hint not in ("card", "dd") and OWN_WALLET.search(payee):
        return "internal"

    if hint in ("card", "refund", "dd"):
        return "spend"  # Direct Debits can only be set up by organisations
    if hint == "bill":
        return "transfer" if personish else "spend"
    if hint == "transfer":
        return "spend" if _has_org_marker(payee) and not personish else "transfer"
    if hint == "income":
        return "transfer" if personish else "spend"

    # No usable type information: fall back to the text.
    if cat == "TRANSFERS":
        return "transfer"
    if CASH_TEXT.search(text):
        return "cash"
    if CARD_MARKERS.search(desc or payee):
        return "spend"
    if personish:
        return "transfer"
    if _has_org_marker(payee):
        return "spend"
    tokens = [t for t in payee.split(" ") if re.search(r"[A-Z]", t)]
    return "spend" if len(tokens) <= 1 else "transfer"


# =====================================================================================================================
# 3. Sensitive names                                   packages/statement/src/sensitive.ts
# Health, gambling, dating, politics, unions, religion, debt and adult names are never sent anywhere.
# =====================================================================================================================

def sensitive_category(norm_payee):
    """Which sensitive category (if any) a normalised payee falls into."""
    s = js_trim(js_collapse((norm_payee or "").upper().replace(".", " ")))
    if not s:
        return None
    exact = SENSITIVE_EXACT.get(s)
    if exact:
        return exact
    for cat, rx in CATEGORY_RES:
        if rx.search(s):
            return cat
    return None


def is_sensitive(norm_payee):
    return sensitive_category(norm_payee) is not None


# =====================================================================================================================
# 4. The ownership list and the matcher                packages/ownership/src/resolve.ts and open-brands.ts
# =====================================================================================================================

def normalise(text):
    """Text for matching: no accents, upper case, no apostrophes, anything but A-Z 0-9 & becomes a space."""
    s = unicodedata.normalize("NFD", text)
    s = _COMBINING.sub("", s)
    s = s.upper()
    s = re.sub("['\N{LEFT SINGLE QUOTATION MARK}\N{RIGHT SINGLE QUOTATION MARK}`]", "", s)
    s = re.sub(r"[^A-Z0-9&]+", " ", s)
    return re.sub(r"\s+", " ", s, flags=A).strip()


def clean_payee(text):
    """cleanPayee: drop store numbers and references, expand bank shorthand (AMZN -> AMAZON)."""
    toks = [t for t in normalise(text).split(" ") if t]
    out = []
    for i, t in enumerate(toks):
        if i > 0 and re.match(r"\d{3,}\Z", t, A):
            continue  # store / terminal numbers
        if re.search(r"\d", t, A) and re.search(r"[A-Z]", t) and len(re.sub(r"[^0-9]", "", t)) >= 3 and len(t) >= 6:
            continue  # references like AB12CD34E
        short = SHORTHAND.get(t)
        if short:
            out.extend(short.split(" "))
        else:
            out.append(t)
    while len(out) > 1 and out[-1] in NOISE_TAIL:
        out.pop()
    return " ".join(out)


def edit_distance(a, b, limit=1):
    """Optimal string alignment distance, giving up (limit + 1) as soon as it is certain to be over the limit."""
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    m, n = len(a), len(b)
    prev2 = []
    prev = list(range(n + 1))
    for i in range(1, m + 1):
        cur = [i]
        row_min = i
        for j in range(1, n + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            v = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                v = min(v, prev2[j - 2] + 1)
            cur.append(v)
            if v < row_min:
                row_min = v
        if row_min > limit:
            return limit + 1
        prev2 = prev
        prev = cur
    return prev[n]


def domains_in(raw):
    """Web addresses in raw bank text, as the registrable part ("help.uber.com" -> "uber.com")."""
    up = re.sub("[" + JS_SPACE + r"]*\.[" + JS_SPACE + r"]*(?=(?:CO\.UK|COM|NET|ORG)\b)", ".", raw.upper(), flags=A)
    out = {}
    for m in DOMAIN_RE.finditer(up):
        host = re.sub(r"^www\.", "", m.group(1).lower(), count=1)
        parts = host.split(".")
        if len(parts) >= 3 and parts[-2] in ("co", "com", "org", "net", "ac", "gov", "ltd", "me") and len(parts[-1]) == 2:
            host = ".".join(parts[-3:])
        else:
            host = ".".join(parts[-2:])
        if re.search(r"[a-z]", host.split(".")[0]):
            out[host] = True
    return list(out)


class Match:
    __slots__ = ("alias", "entry", "method")

    def __init__(self, alias, entry, method):
        self.alias, self.entry, self.method = alias, entry, method


def _compare(prefer_kind):
    def cmp(a, b):
        mr = METHOD_RANK[b.method] - METHOD_RANK[a.method]
        if mr != 0 and (a.method == "near" or b.method == "near"):
            return mr  # a near miss never beats a real match
        if len(b.alias) != len(a.alias):
            return len(b.alias) - len(a.alias)  # longest alias wins
        if mr != 0:
            return mr
        ka = 1 if a.entry["kind"] == prefer_kind else 0
        kb = 1 if b.entry["kind"] == prefer_kind else 0
        if kb != ka:
            return kb - ka
        ta, tb = TIER_RANK.get(a.entry.get("tier")), TIER_RANK.get(b.entry.get("tier"))
        if ta is None or tb is None:
            return 0  # as JavaScript's sort treats NaN
        if tb != ta:
            return tb - ta
        ia, ib = a.entry["id"], b.entry["id"]  # ids are lower-case slugs, where localeCompare is plain order
        return (ia > ib) - (ia < ib)
    return cmp


def pick_best(matches, prefer_kind):
    """Longest alias wins; ties go by how it matched, the kind preferred, the stronger tier, then the id."""
    if not matches:
        return None
    return sorted(matches, key=cmp_to_key(_compare(prefer_kind)))[0]


def _strip_acquirer(text):
    for p in ACQUIRER_PREFIXES:
        if text == p:
            return "", p
        if text.startswith(p + " "):
            return text[len(p) + 1:], p
    return text, None


def _independent_keyword(text):
    padded = " " + text + " "
    for k in INDEPENDENT_KEYWORDS:
        if " " + k + " " in padded:
            return k
    return None


class _Alias:
    __slots__ = ("key", "tokens", "entry", "strict")

    def __init__(self, key, entry, strict):
        self.key, self.tokens, self.entry, self.strict = key, key.split(" "), entry, strict


class AliasIndex:
    def __init__(self):
        self.by_first = {}  # first word -> aliases starting with it
        self.joined = {}  # multi-word aliases with the spaces removed (6+ letters), for "JDSPORTS"
        self.long = {}  # one-word aliases of 7+ letters by first letter, for one-letter-off matching
        self.single = {}  # every one-word alias, for run-together pairs ("PAY PAL" -> PAYPAL)
        self.count = 0

    def add(self, a):
        self.count += 1
        self.by_first.setdefault(a.tokens[0], []).append(a)
        if len(a.tokens) > 1:
            j = "".join(a.tokens)
            if len(j) >= 6:
                self.joined.setdefault(j, []).append(a)
        else:
            self.single.setdefault(a.key, []).append(a)
            if len(a.key) >= 7 and not a.strict and re.match(r"[A-Z]+\Z", a.key):
                self.long.setdefault(a.key[0], []).append(a)

    def find(self, text, fuzzy, keep=None):
        toks = [t for t in text.split(" ") if t]
        out = []

        def add(m):
            if keep is None or keep(m):
                out.append(m)

        # "RESTAURANTE ICELAND" is a restaurant called Iceland: after a word like that, a later name only matches a
        # chain that is itself a place to eat or drink, and not one whose name starts with LA, EL, THE...
        venue = len(toks) > 1 and toks[0] in VENUE_FIRST

        def fits(i, a):
            return not venue or i == 0 or (bool(FOOD_AND_DRINK.search(a.entry.get("category") or "")) and not ARTICLE.search(a.tokens[0]))

        for i, tok in enumerate(toks):
            for a in self.by_first.get(tok, ()):
                if a.strict and i != 0:
                    continue
                if not fits(i, a):
                    continue
                if len(a.tokens) > len(toks) - i:
                    continue
                if all(toks[i + k] == a.tokens[k] for k in range(1, len(a.tokens))):
                    add(Match(a.key, a.entry, "exact"))
        if not fuzzy or out:
            return out
        # Run-together words: "JDSPORTS" (a multi-word alias without its spaces), or "PAY PAL" (two words that
        # together make a one-word alias).
        for i, tok in enumerate(toks):
            for a in self.joined.get(tok, ()):
                if fits(i, a):
                    add(Match(a.key, a.entry, "joined"))
            if i + 1 < len(toks):
                pair = tok + toks[i + 1]
                for a in self.joined.get(pair, ()):
                    if fits(i, a):
                        add(Match(a.key, a.entry, "joined"))
                if len(pair) >= 6:
                    for a in self.single.get(pair, ()):
                        if (not a.strict or i == 0) and fits(i, a):
                            add(Match(a.key, a.entry, "joined"))
        if out:
            return out
        # One letter off, long names only, first letter must agree: "SAINSBURRYS", "WAITROSSE".
        for i, t in enumerate(toks):
            if len(t) < 7 or not re.match(r"[A-Z]+\Z", t):
                continue
            for a in self.long.get(t[0], ()):
                if abs(len(a.key) - len(t)) > 1 or not fits(i, a):
                    continue
                if edit_distance(a.key, t, 1) <= 1:
                    add(Match(a.key, a.entry, "near"))
        return out


class Resolver:
    """createResolver: bank text -> an entry of the ownership list. Pure: nothing here touches the network."""

    def __init__(self, entries, home="GB", fuzzy=True):
        self.entries = entries
        self.home = home
        self.fuzzy = fuzzy
        self.merchant_index = AliasIndex()
        self.product_index = AliasIndex()
        self.all_index = AliasIndex()
        self.by_domain = {}
        for entry in entries:
            seen = set()
            strict = {normalise(a) for a in (entry.get("strict_aliases") or [])}
            for alias in entry["aliases"]:
                key = normalise(alias)
                if not key or key in seen:
                    continue
                seen.add(key)
                ia = _Alias(key, entry, key in strict)
                (self.product_index if entry["kind"] == "product_brand" else self.merchant_index).add(ia)
                self.all_index.add(ia)
            if entry["kind"] == "merchant":
                for d in entry.get("domains") or []:
                    if d not in self.by_domain:
                        self.by_domain[d.lower()] = entry

    def _resolve_text(self, text, raw, where):
        def here(m):
            t = m.entry.get("trades_in")
            return t is None or where in t

        rest, acquirer = _strip_acquirer(text)
        body = rest or text
        cleaned = clean_payee(body)
        matches = self.all_index.find(body, False, here)
        if not matches and cleaned != body:
            matches = self.all_index.find(cleaned, False, here)
        if not matches and self.fuzzy:
            for d in domains_in(raw):
                e = self.by_domain.get(d)
                if e:
                    matches.append(Match(d.upper(), e, "domain"))
        if not matches and self.fuzzy:
            matches = self.all_index.find(cleaned, True, here)
        # Payment services (PayPal, Klarna...) lose to any real shop in the same text: "PAYPAL *NETFLIX" -> Netflix.
        direct = [m for m in matches if not m.entry.get("intermediary")]
        best = pick_best(direct or matches, "merchant")
        if best and not (best.entry.get("intermediary") and rest and _independent_keyword(rest)):
            return {"status": "RESOLVED", "entry": best.entry, "via": "local_list", "matched_alias": best.alias, "method": best.method, "cleaned": cleaned}
        kw = _independent_keyword(body)
        if kw:
            return {"status": "LIKELY_INDEPENDENT", "via": "local_list", "reason": "keyword:" + kw, "cleaned": cleaned}
        if acquirer and rest:
            return {"status": "LIKELY_INDEPENDENT", "via": "local_list", "reason": "acquirer:" + acquirer, "cleaned": cleaned}
        return {"status": "UNRESOLVED", "via": "none", "cleaned": cleaned}

    def resolve(self, payee, country=None):
        """A normalised payee, or raw bank text. country: ISO2 of where it was paid (default: home)."""
        text = normalise(payee)
        if not text:
            return {"status": "UNRESOLVED", "via": "none"}
        return self._resolve_text(text, payee, country or self.home)

    def size(self):
        return {"entries": len(self.entries), "aliases": self.all_index.count}


def trades_in(loc):
    """None for brands that trade in the UK, Ireland or broadly; otherwise the ISO2 countries they trade in."""
    if any(l in BROAD or l.startswith("gb-") for l in loc):
        return None
    out = {}
    for l in loc:
        c = "fr" if l == "fx" else l.split("-")[0]
        if re.match(r"[a-z]{2}\Z", c):
            out[c.upper()] = True
    return list(out) or None


def _wikidata(q):
    return "https://www.wikidata.org/wiki/" + q


def _hop_name(name, q, r):
    """A company known only by its Wikidata id: the brand's own name for the brand, otherwise words."""
    if not re.match(r"Q\d+\Z", name):
        return name
    return r["name"] if q == r["qid"] else "a company Wikidata lists without an English name (" + q + ")"


def expand_open_brand(r, as_of):
    """expandOpenBrand: a slim record from open-brands.json -> a full entry."""
    n = len(r["chain"])
    chain = []
    for i, (name, q, country) in enumerate(r["chain"]):
        relation = "ultimate_parent" if n == 1 else "brand_of" if i == 0 else "ultimate_parent" if i == n - 1 else "owned_by"
        chain.append({"name": _hop_name(name, q, r), "relation": relation, "country": country, "source": "wikidata", "source_id": q, "source_url": _wikidata(q)})
    e = {"id": r["id"], "display_name": r["name"], "kind": "merchant", "aliases": r["aliases"]}
    if r.get("strict"):
        e["strict_aliases"] = r["strict"]
    e["chain"] = chain
    e["owner_country"] = r["oc"]
    e["tier"] = "NAME_MATCH"
    e["technique"] = OPEN_BRANDS_TECHNIQUE
    e["sources"] = [
        {"label": ("Wikidata " + q) if re.match(r"Q\d+\Z", name) else "Wikidata %s (%s)" % (q, name), "url": _wikidata(q)}
        for name, q, _country in r["chain"]
    ] + [{"label": "OpenStreetMap name-suggestion-index", "url": "https://nsi.guide/"}]
    e["as_of"] = as_of
    e["reviewed_by"] = None
    e["reviewed_at"] = None
    e["category"] = r["cat"]
    e["qid"] = r["qid"]
    if r.get("dom"):
        e["domains"] = r["dom"]
    t = trades_in(r["loc"])
    if t:
        e["trades_in"] = t
    return e


def _apply_correction(e, c, reviewed):
    """A reviewed correction: the brand keeps its names; the owner and country are replaced and marked unverified."""
    country = c["owner_country"]
    brand_hop = dict(e["chain"][0])
    brand_hop["relation"] = "brand_of"
    brand_hop["country"] = e["chain"][0].get("country") or country
    out = dict(e)
    out["chain"] = [brand_hop, {"name": c["owner"], "relation": "ultimate_parent", "country": country, "source": "llm"}]
    out["owner_country"] = country
    out["tier"] = "LLM_GUESS"
    out["technique"] = "Wikidata's owner looked out of date and was replaced after an AI review (%s): %s" % (reviewed, c.get("reason"))
    out["notes"] = "Wikidata said: " + " \N{RIGHTWARDS ARROW} ".join("%s (%s)" % (h["name"], h["country"]) for h in e["chain"])
    out["as_of"] = reviewed
    return out


def open_brand_entries(file, hand_checked, corrections=None):
    """openBrandEntries: the generated brands, minus any the hand-built list covers (the hand-checked answer wins)."""
    fixes = {c["qid"]: c for c in ((corrections or {}).get("corrections") or [])}
    qids, aliases = set(), set()
    for e in hand_checked:
        for h in e["chain"]:
            if h.get("source") == "wikidata" and h.get("source_id"):
                qids.add(h["source_id"])
        if e.get("qid"):
            qids.add(e["qid"])
        for a in e["aliases"]:
            aliases.add(normalise(a))
    out = []
    for brand in file["brands"]:
        c = fixes.get(brand["qid"])
        r = brand
        if c and c.get("action") == "narrow":  # keep exactly the listed names (since 11 Nov 2026 they may add one)
            keep = set(c.get("aliases") or [])
            r = dict(brand)
            r["aliases"] = list(c.get("aliases") or [])
            r["strict"] = [a for a in brand["strict"] if a in keep] if brand.get("strict") is not None else None
        if not r["aliases"]:
            continue
        if r["qid"] in qids:
            continue
        if any(normalise(a) in aliases for a in r["aliases"]):
            continue
        if c and c.get("action") == "drop":
            continue
        e = expand_open_brand(r, file["generated"])
        if c and c.get("action") == "fix" and c.get("owner") and c.get("owner_country"):
            e = _apply_correction(e, c, corrections["reviewed"])
        out.append(e)
    return out


# =====================================================================================================================
# 5. Matching one payment                              packages/core/src/attribute.ts  matchLocal, cardReader
# =====================================================================================================================

def card_reader(raw):
    """The card reader small businesses use, from what the bank wrote ("SQ *THE BEAN HOUSE" -> Square)."""
    if raw is None:
        return None
    m = CARD_READER_RE.search(raw.upper())
    if not m:
        return None
    return {"prefix": m.group(1), "provider": CARD_READERS.get(m.group(1), m.group(1))}


def match_local(resolver, norm_payee, raw_payee, raw_description=None, where=None):
    """The built-in list only: the normalised payee first, then the raw bank text (which keeps web addresses and
    run-together names), unless a payment service's name comes first."""
    r = resolver.resolve(norm_payee, where or None)
    if r["status"] != "RESOLVED":
        raw_text = raw_description if raw_description is not None else raw_payee
        if not FACILITATOR.search(js_trim(raw_payee)) and not FACILITATOR.search(js_trim(raw_text)):
            raw = resolver.resolve(raw_text, where or None)
            if raw["status"] == "RESOLVED":
                r = raw
        # The clean-up drops "SQ *" from the name, so look for the card reader in what the bank wrote.
        if r["status"] == "UNRESOLVED":
            reader = card_reader(raw_payee) or card_reader(raw_text)
            if reader:
                r = dict(r, status="LIKELY_INDEPENDENT", via="local_list", reason="acquirer:" + reader["prefix"])
    return r


# =====================================================================================================================
# 5b. Where was it paid?                               packages/core/src/locate.ts  locate
# From what the bank printed: a country code or name at the end, a town at the end, a web address's ending, or the
# currency it was charged in; otherwise the bank's own country. It decides which brands can match.
# =====================================================================================================================

_PLACES = {}


def places():
    """Town -> the countries it's in (GeoNames), unpacked from the table at the end of this file."""
    if not _PLACES:
        for country, names in PLACES_BY_COUNTRY.items():
            for name in names.split("|"):
                _PLACES.setdefault(name, []).append(country)
    return _PLACES


def _code_like(t):
    """Currency and bank codes that often follow the town ("... BANGKOK THB 250.00"); not codes that are also words."""
    return bool(re.match(r"(?:GBP|EUR|USD|CR|DR|POS|VIS|DEB|BCC|CLP)\Z", t)) or (t in CURRENCY_COUNTRY and not re.match(r"(?:PEN|TRY|MAD|COP)\Z", t))


def _tail_tokens(raw):
    """The words at the end of the bank's text, without amounts, dates, card digits, references and codes."""
    ws = "[" + JS_SPACE + "]"
    # A web address stays one word, as it's the shop's name ("WWW.EXAMPLETAXI.COM BANGKOK" was paid in Bangkok).
    s = re.sub(r"(?:HTTPS?://)?(?:[A-Z0-9-]+\.)+[A-Z]{2,6}(?:/[^" + JS_SPACE + r"]*)?", "WEBADDRESS", raw.upper(), flags=A)
    s = re.sub(ws + r"+ON" + ws + r"+\d{1,2}[" + JS_SPACE + r"-]?[A-Z]{3}" + JS_DOT + r"*\Z", "", s, count=1, flags=A)
    s = re.sub(ws + r"+ON" + ws + r"+\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}" + JS_DOT + r"*\Z", "", s, count=1, flags=A)
    # Terminals pad fixed-width fields ("SHOP NAME        PARIS        FR"): padding makes a two-letter code safe to read.
    padded = re.search(ws + r"{2,}[A-Z]{2}\Z", re.sub("[" + JS_SPACE + r"\d.,:/-]+\Z", "", s, count=1, flags=A), A) is not None
    tokens = [t for t in normalise(s).split(" ") if t and not re.match(r"\d+\Z", t) and not re.match(r"\d+[A-Z]*\d*\Z", t)]
    while tokens and _code_like(tokens[-1]):
        tokens.pop()
    return tokens, padded


def _place_country(name, home):
    cs = places().get(name)
    if not cs:
        return None
    if home in cs:
        return home
    return cs[0] if len(cs) == 1 else None  # a town in several other countries is no clue


def _trailing_place(tokens, home, end=None):
    """A town at the end (up to three words): (country, town, words used). What's before it must look like a shop."""
    end = len(tokens) if end is None else end
    for n in range(min(3, end - 1), 0, -1):
        if not any(len(t) >= 3 and t not in FILLER for t in tokens[: end - n]):
            continue
        name = " ".join(tokens[end - n:end])
        c = _place_country(name, home)
        if c:
            return c, name, n
    return None


class Locator:
    def __init__(self, countries_table):
        self.known = countries_table or {}
        names = [(normalise(info["name"]), iso) for iso, info in self.known.items()] + [tuple(p) for p in COUNTRY_NAME_EXTRAS]
        self.country_names = sorted((p for p in names if len(p[0]) >= 4), key=lambda p: -len(p[0]))

    def locate(self, texts, home="GB"):
        """{"country", "evidence", "clue"} for where a payment was made, from the bank's texts, strongest clue first."""
        for raw in texts:
            if not raw:
                continue
            tokens, padded = _tail_tokens(raw)
            if len(tokens) >= 2:
                last = tokens[-1]
                if last in ALPHA3:
                    return {"country": ALPHA3[last], "evidence": "country_code", "clue": last}
                if re.match(r"[A-Z]{2}\Z", last):
                    iso = "GB" if last == "UK" else last
                    before = _trailing_place(tokens, home, len(tokens) - 1)
                    in_town = before is not None and iso in places().get(before[1], ())
                    if iso in self.known and (last in SAFE_ALPHA2 or padded or in_town):
                        return {"country": iso, "evidence": "country_code", "clue": last}
                    if last in US_STATES and before is not None and "US" in places().get(before[1], ()):
                        return {"country": "US", "evidence": "place", "clue": "%s %s" % (before[1], last)}
                tail = " " + " ".join(tokens[-4:])
                for name, iso in self.country_names:
                    if tail.endswith(" " + name) and len(tokens) > len(name.split(" ")):
                        return {"country": iso, "evidence": "country_name", "clue": name}
                p = _trailing_place(tokens, home)  # never the whole text: "BRISTOL" alone may be the shop's name
                if p and p[2] < len(tokens):
                    return {"country": p[0], "evidence": "place", "clue": p[1]}
            dom = re.search(r"[A-Z0-9-]+\.((?:CO|COM)\.[A-Z]{2}|[A-Z]{2})(?=\Z|[^A-Z0-9.])", raw.upper(), A)
            if dom and dom.group(1) in TLD_COUNTRY:
                return {"country": TLD_COUNTRY[dom.group(1)], "evidence": "web_domain", "clue": "." + dom.group(1).lower()}
        # The currency it was charged in, when that's mainly one country's ("THB 250.00"); euros don't say which.
        for raw in texts:
            m = PAID_IN_RE.search(raw.upper()) if raw else None
            ccy = m and (m.group(1) or m.group(2) or m.group(3) or m.group(4))
            if ccy and ccy in CURRENCY_COUNTRY:
                return {"country": CURRENCY_COUNTRY[ccy][0], "evidence": "currency", "clue": ccy}
        return {"country": home, "evidence": "home"}


# =====================================================================================================================
# 6. Saying how we know                                packages/core/src/explain.ts
# =====================================================================================================================

MONTH_NAMES = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec")


def short_date(iso):
    """"2026-09-28" -> "28 Sept 2026", as the app shows dates."""
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", iso or "")
    if not m or not 1 <= int(m.group(2)) <= 12:
        return iso or ""
    return "%d %s %s" % (int(m.group(3)), MONTH_NAMES[int(m.group(2)) - 1], m.group(1))


def readable_name(name):
    """A company known only by its Wikidata id gets words, not "Q2836957"."""
    return "a company Wikidata lists without an English name" if re.match(r"Q\d+\Z", name or "") else name


def how_we_know(e):
    """(level, label) for an answer, as explain.ts howWeKnow labels it."""
    if e["tier"] == "CURATED":
        return "checked", "Checked by a person"
    if e["id"].startswith("osm-"):  # OpenStreetMap's brand list, linked to Wikidata
        return ("ai", "AI-corrected open data") if e["tier"] == "LLM_GUESS" else ("open_data", "Open data")
    if e["id"].startswith("lookup-"):  # an answer from our online look-up
        if e["tier"] == "EXACT_ID":
            return "registers", "From official registers"
        if re.search(r"companies house", e.get("technique") or "", re.I):
            return "company_register", "From the UK company register"
        if e["tier"] == "LLM_GUESS":
            return "ai", "AI estimate"
        return "open_data", "Open data"
    if e["tier"] == "EXACT_ID":
        return "registers", "From official registers"
    if e["tier"] == "NAME_MATCH":
        return "open_data", "From public records"
    return "research", "AI-assisted research"


class Countries:
    def __init__(self, table):
        self.table = table or {}

    def name(self, iso):
        if iso == "OTHER":
            return "Other countries"
        info = self.table.get(iso) if iso else None
        return info["name"] if info and info.get("name") else (iso or "")

    def the(self, iso):
        """"the United Kingdom", "Germany": a country name that reads well inside a sentence."""
        n = self.name(iso)
        return "the " + n if THE.search(n) else n


def chain_of(e):
    n = len(e["chain"])
    out = []
    for i, h in enumerate(e["chain"]):
        role = "Top owner" if n == 1 else ROLE.get(h.get("relation"), "Top owner" if i == n - 1 else "Owned by")
        hop = {"name": readable_name(h["name"]), "country": h.get("country") or "", "role": role}
        if h.get("legal_country") and h.get("legal_country") != h.get("country"):
            hop["legal_country"] = h["legal_country"]
        out.append(hop)
    return out


def owner_name(e):
    top = e["chain"][-1] if e["chain"] else None
    return readable_name(top["name"] if top else e["display_name"])


def headline(e, countries):
    owner = owner_name(e)
    where = countries.the(e["owner_country"])
    if owner == e["display_name"] or len(e["chain"]) <= 1:
        return "%s is its own top company, run from %s." % (e["display_name"], where)
    return "%s is owned by %s, run from %s." % (e["display_name"], owner, where)


# =====================================================================================================================
# 7. The ownership data: download, check, load
# =====================================================================================================================

class KysError(Exception):
    """A problem to explain to the person running the script, without a traceback."""

    def __init__(self, message, code=1):
        super().__init__(message)
        self.code = code


def cache_dir():
    """Where `data update` keeps the ownership list."""
    if os.environ.get("KYS_CACHE_DIR"):
        return os.environ["KYS_CACHE_DIR"]
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
    else:
        base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(base, "knowyourspend")


def _check_url(url):
    """Only HTTPS, except to this computer (for testing)."""
    p = urllib.parse.urlparse(url)
    if p.scheme == "https" or (p.scheme == "http" and p.hostname in ("localhost", "127.0.0.1", "::1")):
        return url
    raise KysError("Refusing to use %s: only https:// addresses are allowed." % url)


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def _request(url, data=None, headers=None, timeout=60.0):
    h = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    h.update(headers or {})
    return urllib.request.urlopen(urllib.request.Request(_check_url(url), data=data, headers=h), timeout=timeout)


MAX_DOWNLOAD = 64 << 20  # no data file comes anywhere near this


def data_update(manifest_url=None, dest=None, say=print):
    """Download the ownership list named in the manifest, check each file's SHA-256, then swap the files in together."""
    manifest_url = manifest_url or os.environ.get("KYS_DATA_URL") or DATA_URL
    dest = dest or cache_dir()
    say("Checking %s ..." % manifest_url)
    try:
        with _request(manifest_url) as res:
            manifest = json.loads(res.read(1 << 20).decode("utf-8"))
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as e:
        raise KysError("Couldn't read the list of data files from %s (%s). Check your connection and try again." % (manifest_url, _reason(e)))
    files = manifest.get("files") if isinstance(manifest, dict) else None
    if not isinstance(files, dict):
        raise KysError("The list of data files at %s isn't in the format this script expects. Is kys.py up to date?" % manifest_url)
    plan = []
    for name in DATA_FILES:
        info = files.get(name)
        if not isinstance(info, dict) or not isinstance(info.get("url"), str) or not re.match(r"[0-9a-fA-F]{64}\Z", str(info.get("sha256", ""))):
            raise KysError("The list of data files at %s doesn't describe %s properly." % (manifest_url, name))
        size = info.get("bytes")
        plan.append((name, _check_url(urllib.parse.urljoin(manifest_url, info["url"])), info["sha256"].lower(), size if isinstance(size, int) else None))

    os.makedirs(dest, exist_ok=True)
    ready, fetched = [], 0
    try:
        for name, url, sha, size in plan:
            path = os.path.join(dest, name)
            if os.path.exists(path) and _sha256_file(path) == sha:
                continue  # already have this exact file
            tmp = path + ".download"
            ready.append((tmp, path))  # removed again below unless everything succeeds
            h, n = hashlib.sha256(), 0
            try:
                with _request(url, timeout=120.0) as res, open(tmp, "wb") as f:
                    for chunk in iter(lambda: res.read(1 << 16), b""):
                        n += len(chunk)
                        if n > MAX_DOWNLOAD:
                            raise KysError("%s is far bigger than expected, so it wasn't saved." % name)
                        h.update(chunk)
                        f.write(chunk)
            except (urllib.error.URLError, http.client.HTTPException, OSError) as e:  # HTTPException: cut off part-way
                raise KysError("Couldn't download %s (%s). Nothing was changed. Try again later." % (name, _reason(e)))
            if h.hexdigest() != sha or (size is not None and n != size):
                raise KysError("%s didn't match its SHA-256 checksum, so it wasn't used. Nothing was changed. Try again later." % name)
            fetched += n
        for tmp, path in ready:
            os.replace(tmp, path)
        ready = []
        saved = {
            "version": manifest.get("version"),
            "source": manifest_url,
            "downloaded": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "files": {name: {"sha256": sha} for name, _url, sha, _size in plan},
        }
        _write_json(os.path.join(dest, "manifest.json"), saved)
    finally:
        for tmp, _path in ready:
            try:
                os.remove(tmp)
            except OSError:
                pass
    version = manifest.get("version") or "unknown"
    if fetched:
        say("Downloaded the ownership list, version %s (%s), to %s." % (version, _size_words(fetched), dest))
    else:
        say("The ownership list is already up to date (version %s)." % version)
    return dest


def _write_json(path, value):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp, path)


def _reason(e):
    if isinstance(e, urllib.error.HTTPError):
        e.close()
        return "HTTP %d" % e.code
    if isinstance(e, urllib.error.URLError):
        return str(e.reason)
    return str(e) or e.__class__.__name__


def _size_words(n):
    return "%.1f MB" % (n / 1e6) if n >= 100_000 else "%d KB" % max(1, round(n / 1e3))


def load_data(folder=None):
    """The five data files, from --data FOLDER or from where `data update` saved them."""
    explicit = folder is not None
    folder = folder or cache_dir()
    missing = [n for n in DATA_FILES if not os.path.isfile(os.path.join(folder, n))]
    if missing:
        if explicit:
            raise KysError("%s doesn't have the ownership data: %s missing. Point --data at a folder with all of %s "
                           "(for example packages/ownership/data in a copy of the source code)." % (folder, ", ".join(missing), ", ".join(DATA_FILES)))
        raise KysError("There's no ownership data yet. Download it once (about 2 MB) with:\n\n    python3 %s data update\n\n"
                       "Or use --data FOLDER to read the files from a folder, such as packages/ownership/data in a copy "
                       "of the source code." % os.path.basename(sys.argv[0] or "kys.py"))
    saved = None
    manifest_path = os.path.join(folder, "manifest.json")
    if os.path.isfile(manifest_path):
        try:
            with open(manifest_path, encoding="utf-8") as f:
                saved = json.load(f)
        except (OSError, ValueError):
            saved = None
    data = {}
    for name in DATA_FILES:
        path = os.path.join(folder, name)
        if saved and isinstance(saved.get("files"), dict) and name in saved["files"]:
            if _sha256_file(path) != saved["files"][name].get("sha256"):
                raise KysError("%s has changed since it was downloaded. Run `data update` to get a fresh copy." % path)
        try:
            with open(path, encoding="utf-8") as f:
                data[name] = json.load(f)
        except (OSError, ValueError) as e:
            raise KysError("Couldn't read %s (%s). Run `data update` to get a fresh copy." % (path, e))
    data["_folder"] = folder
    data["_manifest"] = saved
    return data


class Engine:
    """The ownership list, assembled as packages/ownership/src/index.ts does, and a matcher for it."""

    def __init__(self, data):
        merchants = data["merchants.json"]
        products = data["product-brands.json"]
        checked = merchants + products
        self.open_brands = open_brand_entries(data["open-brands.json"], checked, data["open-brand-corrections.json"])
        self.entries = checked + self.open_brands
        self.resolver = Resolver(self.entries)
        self.by_id = {e["id"]: e for e in self.entries}
        self.countries = Countries(data["countries.json"])
        self.locator = Locator(data["countries.json"])
        self.counts = {
            "merchants": len(merchants),
            "product_brands": len(products),
            "open_brands": len(self.open_brands),
            "corrections": len(data["open-brand-corrections.json"].get("corrections") or []),
        }
        self.generated = data["open-brands.json"].get("generated")
        self.reviewed = data["open-brand-corrections.json"].get("reviewed")
        self.folder = data.get("_folder")
        self.manifest = data.get("_manifest")

    def owner_result(self, e, query, method=None, alias=None):
        level, label = how_we_know(e)
        return {
            "query": query,
            "status": "owner",
            "brand": e["display_name"],
            "owner": {"name": owner_name(e), "country": e["owner_country"], "country_name": self.countries.name(e["owner_country"])},
            "chain": chain_of(e),
            "how_we_know": {"level": level, "label": label},
            "as_of": e.get("as_of"),
            "sources": [{"label": s.get("label", ""), "url": s.get("url", "")} for s in (e.get("sources") or [])],
            "headline": headline(e, self.countries),
            "matched": {"method": method, "alias": alias},
            "entry_id": e["id"],
            "answered_by": "built-in list",
        }


# =====================================================================================================================
# 8. One line of text: `kys.py lookup`                 packages/core/src/quick-lookup.ts readQuery, lookUpLocally
# =====================================================================================================================

def read_query(text, home="GB"):
    """What was typed, tidied and cut to MAX_QUERY characters; the cleaned name; the bank's country."""
    t = js_trim(js_slice(js_trim(js_collapse(text or "")), MAX_QUERY))
    h = (home or "").upper()
    return {"text": t, "name": normalise_payee(t) if t else "", "home": h if re.match(r"[A-Z]{2}\Z", h) else "GB"}


# quick-lookup.ts notShopWhy, by the kind of payment classify() reads it as
NOT_SHOP_WHY = {
    "transfer": "It reads like a transfer or a bill payment, which can be to a person, so we haven't sent it to our online look-up.",
    "cash": "It reads like a cash withdrawal, so there's no shop to look up.",
    "internal": "It reads like money moving between your own accounts, or to savings or investments, so there's no shop to look up.",
    "income": "It reads like money coming in, so there's no shop to look up.",
    "fee": "It reads like a fee or interest from your bank, so there's no shop to look up.",
}


# quick-lookup.ts: a line that starts with the bank's bill-payment code ("BP PIPPA", as first direct and HSBC print it)
BILL_CODE_FIRST = re.compile(r"BP\s", re.I)


def look_up_locally(engine, text, country="GB"):
    """One line of bank text -> what the built-in list says, in the order the website's search box uses: a named
    owner, a local independent, then the reasons a name is never sent (sensitive, a person's, not a payment to a shop),
    and otherwise unknown. Nothing here touches the network."""
    q = read_query(text, country)
    base = {"query": q["name"], "text": q["text"], "country": q["home"]}
    if not q["name"]:
        return dict(base, status="empty", can_ask=False)
    # attribute.ts: where it was paid decides which brands can match (one that only trades in Finland can't be in Leeds)
    where = engine.locator.locate([q["text"], q["text"]], q["home"])
    base["where"] = where
    r = match_local(engine.resolver, q["name"], q["text"], q["text"], where["country"])
    # "BP" first on a pasted line is usually the bank's code for a bill payment, not the fuel company: when BP on its own
    # was all that matched and the rest may be a person's name, hold it back ("BP PIPPA"; 11 Nov 2026).
    if (r["status"] == "RESOLVED" and r.get("matched_alias") == "BP" and BILL_CODE_FIRST.match(q["text"])
            and may_be_person(q["text"], q["text"])):
        return dict(base, **_person(q["name"]))
    found = _matched(engine, r, q["name"], q["text"])
    if found:
        return dict(base, **found)
    # Sensitive first: "MARIE STOPES" also looks like a person's name, but what matters is what it could say about you.
    if is_sensitive(q["name"]):
        return dict(base, **_sensitive(q["name"]))
    # The statement reader's person rule: a PayPal payment to a name that could be a person's, a bill payment to a
    # one-word name.
    if may_be_person(q["text"], q["text"]):
        return dict(base, **_person(q["name"]))
    # Not a payment to a shop (cash, your own accounts or savings, money in, a fee, a transfer), as the reader sees it.
    kind = classify(-1, q["text"], q["text"])
    if kind in ("cash", "internal", "income", "fee"):
        return dict(base, **_not_shop(q["name"], kind))
    # Anything that reads like a person's name, also after words like "TRANSFER TO" ("BANK TRANSFER TO DAVID JONES").
    after = TO_SOMEONE.search(q["name"])
    if looks_like_person(q["text"]) or looks_like_person(q["name"]) or (after and looks_like_person(after.group(1))):
        return dict(base, **_person(q["name"]))
    if kind == "transfer":
        return dict(base, **_not_shop(q["name"], kind))
    return dict(base, **_unknown(q["name"]))


def _matched(engine, r, name, raw):
    """A match_local answer from the built-in list: a named owner, a local independent, or None."""
    if r["status"] == "RESOLVED":
        e = r["entry"]
        out = engine.owner_result(e, name, r.get("method"), r.get("matched_alias"))
        via = FACILITATOR.search(js_trim(raw or ""))
        if via and not e.get("intermediary"):
            svc = PAID_THROUGH.get(via.group(1).upper(), via.group(1))
            out["note"] = "%s puts its name before the shop's. We looked through it to the shop." % (svc[0].upper() + svc[1:])
        out["can_ask"] = False
        return out
    if r["status"] == "LIKELY_INDEPENDENT":
        kind, _sep, value = (r.get("reason") or "").partition(":")
        out = {"query": name, "status": "local", "can_ask": False}
        if kind == "acquirer":
            reader = card_reader(raw) or {"prefix": value, "provider": CARD_READERS.get(value, value)}
            out["why"] = ("\"%s *\" means it was paid with a %s card reader. They're mostly used by small businesses: "
                          "cafes, market stalls, salons and tradespeople." % (reader["prefix"], reader["provider"]))
        else:
            out["why"] = "The name contains \"%s\", which usually means a single local business rather than a chain." % value
        return out
    return None


# quick-lookup.ts heldWhy: the reason a name is held back (the website doesn't name the sensitive category on screen)
HELD_WHY = {
    "person": "It looks like a person's name, so we haven't sent it to our online look-up. We only look up businesses.",
    "sensitive": "It could say something sensitive about you (health, money or similar), so we haven't sent it to our online look-up.",
}


def _sensitive(name):
    return {"query": name, "status": "sensitive", "category": sensitive_category(name), "can_ask": False, "why": HELD_WHY["sensitive"]}


def _person(name):
    return {"query": name, "status": "person", "can_ask": False, "why": HELD_WHY["person"]}


def _not_shop(name, kind):
    return {"query": name, "status": "not_shop", "kind": kind, "can_ask": False,
            "why": NOT_SHOP_WHY.get(kind, "It doesn't read like a payment to a shop.")}


def _unknown(name):
    return {"query": name, "status": "unknown", "can_ask": sendable(name)}


# =====================================================================================================================
# 9. A statement: `kys.py statement FILE.csv`
# Reading the file follows packages/statement/src/parse.ts and values.ts, much simplified: the app also recognises each
# bank's format, where this guesses the columns from their headings (or, with none, from what's in them).
# =====================================================================================================================

# As in parse.ts guessMapping: a payee column (the bank's tidy name) and a description column (the bank's own text).
# The payee is used when it's filled in, the description otherwise, and the description is also kept as the bank's text.
PAYEE_HEADERS = ("payee", "merchant", "name", "counter party", "counterparty", "payee name", "merchant name", "partner name")
DESCRIPTION_HEADERS = ("description", "narrative", "details", "transaction description", "transaction details", "memo", "particulars")
_DESCRIPTION_LIKE = re.compile(r"description|details|memo|narrative|reference|payee|merchant|name")
CARD_STATEMENT_HEADERS = ("appears on your statement as", "extended details", "card member")  # American Express
_MONEY_OUT = re.compile(r"paid out|money out|^debits?\b|debit amount|withdrawals?|^out$", A)
_MONEY_IN = re.compile(r"paid in|money in|^credits?\b|credit amount|deposits?|^in$", A)
_AMOUNT = (re.compile(r"^amount$|^value$|^amount \(|^betrag", A), re.compile(r"\bamount\b|\bvalue\b", A))
_TYPE = re.compile(r"type|subcategory")
_CURRENCY = re.compile(r"^currency$|^ccy$|currency$")
_DATE_CELL = re.compile(r"\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}(?:[T ].*)?\Z|\d{1,2}[-/ .]+[A-Za-z]{3,9}\.?[-/ .,]+\d{2,4}\Z|\d{8}\Z", A)


def header_key(h):
    """values.ts headerKey: lower case, trimmed, BOM, quotes and odd spaces removed."""
    h = re.sub("^\N{ZERO WIDTH NO-BREAK SPACE}", "", h)
    h = re.sub("[\xa0\t]", " ", h)
    h = re.sub("^[\"'" + JS_SPACE + "]+|[\"'" + JS_SPACE + "]+\\Z", "", h)
    return js_collapse(h).lower()


def clean_cell(c):
    """parse.ts cleanCell: odd spaces to plain ones, trimmed, Excel's leading apostrophe dropped, cut to length."""
    s = js_trim(re.sub("[\xa0\t]", " ", c or ""))
    s = re.sub("^'(?=[^" + JS_SPACE + "])", "", s, count=1)
    return js_trim(js_slice(s, MAX_FIELD_LENGTH)) if js_len(s) > MAX_FIELD_LENGTH else s


def parse_amount(text):
    """values.ts parseAmount: "1,234.56", "-12.50", "12.50-", "(12.50)", "12.50 CR", "GBP 4.40", "1.234,56".
    Returns {"value", "currency", "marked"} or None."""
    s = js_trim(text or "")
    s = re.sub("^[\"']|[\"']\\Z", "", s)
    s = re.sub("[\xa0\N{NARROW NO-BREAK SPACE}" + JS_SPACE + "]", "", s)
    if not s:
        return None
    currency, negative, marked = None, False, None
    code = re.search(r"(GBP|EUR|USD|CHF|SEK|NOK|DKK|PLN|CZK|HUF|AUD|CAD|NZD|JPY)", s, re.I | A)
    if code:
        currency = code.group(1).upper()
        s = s.replace(code.group(0), "", 1)
    for sym, iso in SYMBOLS.items():
        if sym in s:
            currency = currency or iso
            s = "".join(s.split(sym))
    crdr = re.search(r"^(CR|DR)|(CR|DR)\Z", s, re.I | A)
    if crdr:
        marked = (crdr.group(1) or crdr.group(2)).upper()
        if marked == "DR":
            negative = True
        s = re.sub(r"^(CR|DR)|(CR|DR)\Z", "", s, count=1, flags=re.I | A)
    if re.match(r"\(" + JS_DOT + r"*\)\Z", s):
        negative = True
        s = s[1:-1]
    s = re.sub(r"[^\d.,+-]", "", s, flags=A)
    if s.endswith("-"):
        negative, s = not negative, s[:-1]
    elif s.endswith("+"):
        s = s[:-1]
    if s.startswith("-"):
        negative, s = not negative, s[1:]
    elif s.startswith("+"):
        s = s[1:]
    if not re.search(r"\d", s, A) or re.search(r"[+-]", s):
        return None
    last_dot, last_comma = s.rfind("."), s.rfind(",")
    if last_dot >= 0 and last_comma >= 0:
        s = s.replace(".", "").replace(",", ".", 1) if last_comma > last_dot else s.replace(",", "")
    elif last_comma >= 0:
        s = s.replace(",", ".", 1) if s.count(",") == 1 and re.search(r",\d{1,2}\Z", s, A) else s.replace(",", "")
    if not re.match(r"(?:\d*\.?\d+|\d+\.)\Z", s, A):
        return None
    n = float(s)
    if not math.isfinite(n):
        return None
    value = js_round((-n if negative else n) * 100) / 100
    return {"value": value + 0.0 if value else 0.0, "currency": currency, "marked": marked}


def _decode(raw):
    """parse.ts decodeFile: strict UTF-8, else Windows-1252 (Nationwide and Santander exports)."""
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("cp1252", errors="replace")
    text = re.sub("^\N{ZERO WIDTH NO-BREAK SPACE}", "", text)
    text = re.sub("\xc2(?=[\xa3 ])", "", text)  # UTF-8 pound sign read as Windows-1252
    text = text.replace("\xe2\N{SINGLE LOW-9 QUOTATION MARK}\xac", "\N{EURO SIGN}")
    return re.sub(r"\r\n?", "\n", text)


def _sniff_delimiter(text):
    lines = [l for l in text.split("\n") if l.strip()][:30]
    sample = "\n".join(lines)
    try:
        d = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
        widths = [len(r) for r in csv.reader(io.StringIO(sample), delimiter=d)]
        if widths and max(widths) > 1:
            return d
    except csv.Error:
        pass
    # parse.ts sniffDelimiter: the delimiter that splits the most lines into the same number of fields
    best, best_score = ",", -1
    for d in (",", ";", "\t"):
        counts = {}
        for r in csv.reader(io.StringIO(sample), delimiter=d):
            counts[len(r)] = counts.get(len(r), 0) + 1
        modal, modal_count = 1, 0
        for width, c in counts.items():
            if width > 1 and (c > modal_count or (c == modal_count and width > modal)):
                modal, modal_count = width, c
        score = modal_count if modal > 1 else 0
        if score > best_score:
            best, best_score = d, score
    return best


def _find_column(keys, wanted):
    """--column / --amount-column: a heading (any case) or a column number counting from 1."""
    k = header_key(wanted)
    if k in keys:
        return keys.index(k)
    if re.match(r"\d+\Z", wanted.strip()):
        i = int(wanted.strip()) - 1
        if 0 <= i < max(len(keys), 1):
            return i
    return None


def _guess_columns(keys):
    """Columns from their headings, as parse.ts guessMapping finds them."""
    used = set()

    def find(patterns):
        for rx in patterns:
            for i, k in enumerate(keys):
                if i not in used and rx.search(k):
                    used.add(i)
                    return i
        return None

    def named(names):
        for want in names:
            if want in keys and keys.index(want) not in used:
                used.add(keys.index(want))
                return keys.index(want)
        return None

    cols = {"out": find([_MONEY_OUT]), "in": find([_MONEY_IN]), "amount": find(_AMOUNT), "type": find([_TYPE]), "currency": find([_CURRENCY])}
    cols["payee"] = named(PAYEE_HEADERS)
    cols["description"] = named(DESCRIPTION_HEADERS)
    if cols["description"] is None:
        cols["description"] = find([re.compile(r"^(?!.*account).*(?:" + _DESCRIPTION_LIKE.pattern + ")")])
    if cols["description"] is None:  # only a payee column: that is the text
        cols["description"], cols["payee"] = cols["payee"], None
    return cols


def _wordiest(rows, skip=()):
    """The column whose cells are mostly words and longest on average (parse.ts guessMapping's fallback)."""
    width = max((len(r) for r in rows), default=0)
    best, best_len = None, 0.0
    for i in range(width):
        if i in skip:
            continue
        c = [clean_cell(r[i]) for r in rows if i < len(r) and clean_cell(r[i])]
        if not c or sum(1 for x in c if re.search(r"[A-Za-z]", x)) / len(c) < 0.8 or sum(1 for x in c if _DATE_CELL.match(x)) / len(c) > 0.5:
            continue
        avg = sum(len(x) for x in c) / len(c)
        if avg > best_len:
            best, best_len = i, avg
    return best


def _content_columns(rows):
    """A file with no headings: the wordiest column is the shop, the first column of amounts is the amount."""
    width = max((len(r) for r in rows), default=0)
    desc = _wordiest(rows)
    amount = None
    for i in range(width):
        c = [clean_cell(r[i]) for r in rows if i < len(r) and clean_cell(r[i])]
        if i != desc and c and sum(1 for x in c if parse_amount(x) is not None and not _DATE_CELL.match(x)) / len(c) >= 0.8:
            amount = i
            break
    return {"payee": None, "description": desc, "amount": amount, "out": None, "in": None, "type": None, "currency": None}


def _clip(s):
    """parse.ts clip: a cell is cut to MAX_FIELD_LENGTH characters."""
    return js_trim(js_slice(s, MAX_FIELD_LENGTH)) if js_len(s) > MAX_FIELD_LENGTH else s


def _numeric(value):
    return value is not None and re.match(r"\s*\d+\s*\Z", value) is not None


def read_statement(path, column=None, amount_column=None, spend_positive=False):
    """The rows of a CSV statement, [{"payee", "description", "amount" (negative = money out), "type", "currency"}],
    and how it was read."""
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError as e:
        raise KysError("Couldn't open %s (%s)." % (path, e.strerror or e))
    text = _decode(raw)
    delimiter = _sniff_delimiter(text)
    table = list(csv.reader(io.StringIO(text), delimiter=delimiter))

    header_at, cols, keys = None, None, []
    for i, row in enumerate(table[:HEADER_SCAN_ROWS]):
        k = [header_key(c) for c in row]
        if not any(k):
            continue
        guess = _guess_columns(k)
        if amount_column is not None:
            a = _find_column(k, amount_column)
            if a is None or (not _numeric(amount_column) and header_key(amount_column) not in k):
                continue
            is_out = bool(_MONEY_OUT.search(k[a]))
            guess.update(out=a if is_out else None, amount=None if is_out else a, **({} if is_out else {"in": None}))
        if guess["amount"] is None and guess["out"] is None and guess["in"] is None:
            continue
        if column is not None:
            d = _find_column(k, column)
            if d is None or (not _numeric(column) and header_key(column) not in k):
                continue
            guess["description"], guess["payee"] = d, None
        if guess["description"] is None:
            # headings we don't know for the shop (a German "Empfaenger"): the wordiest column under them
            taken = {guess[c] for c in ("amount", "out", "in", "type", "currency") if guess[c] is not None}
            guess["description"] = _wordiest(table[i + 1:i + 61], taken)
            if guess["description"] is None:
                continue
        header_at, cols, keys = i, guess, k
        break
    headerless = header_at is None
    if headerless:
        if (column is not None and not _numeric(column)) or (amount_column is not None and not _numeric(amount_column)):
            raise KysError("Couldn't find the column %s in %s. Check the spelling of the heading, or give its number "
                           "counting from 1." % (" or ".join("\"%s\"" % c for c in (column, amount_column) if c and not _numeric(c)), path))
        body = [r for r in table if any(c.strip() for c in r)]
        cols = _content_columns(body)
        width = max((len(r) for r in body), default=0)
        keys = ["column %d" % (n + 1) for n in range(width)]
        if _numeric(column):
            cols["description"] = int(column) - 1
        if _numeric(amount_column):
            cols["amount"] = int(amount_column) - 1
        start = table.index(body[0]) if body else 0
    else:
        start = header_at + 1
    if cols["description"] is None:
        raise KysError("Couldn't tell which column has the shop names in %s. Name it with --column, for example "
                       "--column \"Description\" (or a column number, like --column 2)." % path)
    if cols["out"] is not None and cols["in"] is None and cols["amount"] is not None:
        cols["out"] = None  # a lone money-out column next to a signed amount: use the amount, as parse.ts does
    if cols["out"] is not None or cols["in"] is not None:
        cols["amount"] = None
    if cols["amount"] is None and cols["out"] is None and cols["in"] is None:
        raise KysError("Couldn't tell which column has the amounts in %s. Name it with --amount-column, for example "
                       "--amount-column \"Amount\" or --amount-column \"Paid out\"." % path)

    width = len(table[header_at]) if not headerless else len(keys)
    rows, skipped = [], {"no shop name": 0, "no amount": 0, "balance line": 0}
    header_line = "|".join(keys)
    for r in table[start:]:
        cells = list(r)
        while len(cells) > width and clean_cell(cells[-1]) == "":
            cells.pop()
        if width > 0 and len(cells) > width:  # unquoted commas inside the shop's name (Barclays): join them back
            extra = len(cells) - width
            d = cols["description"]
            cells = cells[:d] + [",".join(cells[d:d + extra + 1])] + cells[d + extra + 1:]
        cells = [clean_cell(c) for c in cells]
        if not any(cells):
            continue
        if not headerless and "|".join(header_key(c) for c in cells) == header_line:
            continue  # the headings again (Lloyds repeats them)
        if any(OPENING_BALANCE.search(c) for c in cells):
            skipped["balance line"] += 1
            continue
        get = lambda i: cells[i] if i is not None and i < len(cells) else ""
        desc = js_trim(js_collapse(get(cols["description"])))
        payee = js_trim(js_collapse(get(cols["payee"])))
        if not desc and not payee:
            skipped["no shop name"] += 1
            continue
        amount, symbol = None, None
        if cols["amount"] is not None:
            a = parse_amount(get(cols["amount"]))
            if a:
                amount, symbol = a["value"], a["currency"]
                if spend_positive and not a["marked"]:
                    amount = -amount if amount else 0.0
        else:
            o = parse_amount(get(cols["out"])) if cols["out"] is not None else None
            n = parse_amount(get(cols["in"])) if cols["in"] is not None else None
            if o or n:
                amount = js_round((abs(n["value"] if n else 0) - abs(o["value"] if o else 0)) * 100) / 100
                symbol = (o["currency"] if o else None) or (n["currency"] if n else None)
        if amount is None:
            skipped["no amount"] += 1
            continue
        cur = get(cols["currency"]).upper()
        raw_payee = _clip(payee or desc)
        description = _clip(desc)
        rows.append({
            "payee": raw_payee,  # what the app calls rawPayee and rawDescription (parse.ts makeTransaction)
            "description": description if description and description != raw_payee else None,
            "amount": amount,
            # on a card statement everything is a card payment, except paying the card off (banks/amex.ts, cards.ts)
            "type": get(cols["type"]) or ("CARD" if spend_positive else None),
            "currency": cur if re.match(r"[A-Z]{3}\Z", cur) else symbol,
        })
    names = {k: (None if v is None else (("column %d" % (v + 1)) if headerless else (table[header_at][v].strip() or "column %d" % (v + 1)))) for k, v in cols.items()}
    card = not headerless and any(h in keys for h in CARD_STATEMENT_HEADERS)
    return rows, {"columns": names, "headerless": headerless, "skipped": {k: v for k, v in skipped.items() if v}, "delimiter": delimiter, "card_statement": card}


KIND_WORDS = {
    "transfer": "Transfers (they may be to people)",
    "cash": "Cash withdrawals",
    "internal": "Between your own accounts",
    "fee": "Bank fees",
    "income": "Money in",
    "unknown": "Zero amounts",
}
STATUS_WORDS = {
    "owner": "owner found",
    "local": "local independent",
    "sensitive": "sensitive: not looked up",
    "person": "looks like a person: not looked up",
    "not_shop": "not a payment to a shop",
    "unknown": "not in the list",
    "not_business": "doesn't look like a business",
    "retry": "couldn't check it just now: try again later",
}
_RANK = {"owner": 0, "local": 1, "not_business": 2, "retry": 3, "unknown": 4, "not_shop": 5, "person": 6, "sensitive": 7}


def _held_or_unknown(name, sensitive, person):
    return _sensitive(name) if sensitive else _person(name) if person else _unknown(name)


def analyse_statement(engine, rows, home="GB"):
    """Each row as the app treats it (parse.ts makeTransaction, prepare.ts prepareStatement, attribute.ts), grouped
    by shop name. home: the bank's country."""
    groups, done = {}, {}
    for row in rows:
        payee, desc = row["payee"], row["description"]
        sign = (row["amount"] > 0) - (row["amount"] < 0)  # all classify() needs to know about the amount
        seen = done.get((payee, desc, row["type"], sign))
        if seen is None:
            kind = classify(row["amount"], payee, desc, row["type"])
            norm = normalise_payee(payee) or (normalise_payee(desc) if desc else "")
            spendish = kind in ("spend", "refund")
            sensitive = is_sensitive(norm) or (desc is not None and is_sensitive(normalise_payee(desc)))
            # Held back as the app holds names back: mayBePerson on the row (parse.ts) and looksLikePerson on the
            # name that would be sent (apps/mobile/src/lib/lookup.ts sendable). classify() already made other
            # person-like rows transfers, which are never matched or sent.
            person = spendish and (may_be_person(payee, desc, row["type"]) or looks_like_person(norm))
            res = None
            if spendish:
                # where it was paid, from the bank's text (attribute.ts: locate([rawDescription, rawPayee], home))
                where = engine.locator.locate([desc, payee], home)["country"]
                r = match_local(engine.resolver, norm, payee, desc, where) if norm else {"status": "UNRESOLVED", "via": "none"}
                res = _matched(engine, r, norm, desc if desc is not None else payee) or _held_or_unknown(norm, sensitive, person)
            seen = done[(payee, desc, row["type"], sign)] = (kind, norm, spendish, sensitive, person, res)
        kind, norm, spendish, sensitive, person, res = seen
        key = (norm, "spend" if spendish else kind)
        g = groups.get(key)
        if g is None:
            g = groups[key] = {"query": norm, "kind": "spend" if spendish else kind, "payments": 0, "out": 0, "in": 0,
                               "example": payee, "currencies": {}, "rows": [], "sensitive": False, "person": False, "result": None}
        g["payments"] += 1
        g["currencies"][row["currency"]] = g["currencies"].get(row["currency"], 0) + 1
        pence = js_round(abs(row["amount"]) * 100)
        if row["amount"] < 0:
            g["out"] += pence
        else:
            g["in"] += pence
        g["rows"].append(row)
        if spendish:
            g["sensitive"] = g["sensitive"] or sensitive
            g["person"] = g["person"] or person
            if g["result"] is None or _RANK[res["status"]] < _RANK[g["result"]["status"]]:
                g["result"] = res
    for g in groups.values():
        # A name held back on any row is held back on every row (prepare.ts).
        if g["kind"] == "spend" and g["result"]["status"] == "unknown" and (g["sensitive"] or g["person"]):
            g["result"] = _held_or_unknown(g["query"], g["sensitive"], g["person"])
    return list(groups.values())


def main_currency(groups):
    counts = {}
    for g in groups:
        if g["kind"] == "spend":
            for c, n in g["currencies"].items():
                counts[c] = counts.get(c, 0) + n
    return max(counts, key=lambda c: (counts[c], c is not None, c or "")) if counts else None


def summarise(groups, countries, currency):
    """Spending by the owner's country, worked out here from the rows, in the main currency. As in the app
    (aggregate.ts), refunds come off their own shop's spending, and a shop never counts for less than nothing."""
    by_country, buckets, not_counted = {}, {"local": 0, "unknown": 0, "held": 0, "retry": 0, "not_business": 0}, {}
    total, other_currency = 0, 0
    for g in groups:
        if g["kind"] != "spend":
            if g["kind"] != "income" and g["out"] > 0:
                n, amt = not_counted.get(g["kind"], (0, 0))
                not_counted[g["kind"]] = (n + sum(1 for r in g["rows"] if r["amount"] < 0), amt + g["out"])
            continue
        net = 0
        for row in g["rows"]:
            if row["currency"] != currency and row["currency"] is not None and currency is not None:
                other_currency += 1
                continue
            p = js_round(abs(row["amount"]) * 100)
            net += p if row["amount"] < 0 else -p
        if net <= 0:
            continue
        total += net
        st = g["result"]["status"]
        if st == "owner":
            iso = g["result"]["owner"]["country"]
            c = by_country.setdefault(iso, {"amount": 0, "brands": {}})
            c["amount"] += net
            b = g["result"]["brand"]
            c["brands"][b] = c["brands"].get(b, 0) + net
        elif st in ("sensitive", "person"):
            buckets["held"] += net
        elif st in buckets:
            buckets[st] += net
        else:
            buckets["unknown"] += net
    lines = []
    for iso, c in sorted(by_country.items(), key=lambda kv: (-kv[1]["amount"], kv[0])):
        top = [b for b, _n in sorted(c["brands"].items(), key=lambda kv: (-kv[1], kv[0]))][:3]
        lines.append({"country": iso, "country_name": countries.name(iso), "amount": c["amount"], "share": round(c["amount"] / total, 4) if total > 0 else 0.0, "top": top})
    return {"currency": currency, "total": total, "countries": lines, "buckets": buckets, "not_counted": not_counted, "other_currency": other_currency}


# =====================================================================================================================
# 10. --online: our look-up service, for names the built-in list doesn't know
# The service the website and the app use: a Supabase Edge Function in Ireland (services/lookup/kys-lookup.ts). It's
# sent {"merchants": [names]}, plus "country" when that isn't GB, and nothing else: no amounts, no dates, no bank text.
# For each name it checks its earlier answers, Wikidata, GLEIF and Companies House, and may ask Mistral AI.
# =====================================================================================================================

MAX_PER_REQUEST = 60  # names in one request (MAX_NAMES in kys-lookup.ts)
MAX_NAME_LENGTH = 60  # the longest name it takes (MAX_LEN there); cleaned names are 40 characters at most anyway
LOOKUP_TIMEOUT = 150.0  # seconds: a name nobody has asked about before can take up to two minutes
LOOKUP_PLACE = "our look-up service (run on Supabase in Ireland)"
# quick-lookup.ts and explain.ts, as the website words them
PAUSED = "Our online look-up has reached its limit for researching new names today. Names it already knows still work. Please try again tomorrow."
UNFINISHED = "Our online look-up didn't finish checking it. Please try again in a little while."
MISSED = "Our online look-up checked company registers and asked an AI to research it, but couldn't find who owns it."
NOT_BUSINESS = ("Our online look-up thinks it's a person's name or something other than a business, so it didn't look for an owner. "
                "Names like this aren't kept.")
LOCAL_FOUND = ("It isn't in our built-in list. Our online look-up's AI step (Mistral) found a small local business rather than a chain, "
               "and no owner that a register or a web search confirms.")
RECHECK = "It hasn't been checked with a web search yet. That full check runs when someone asks about this name again, from %s."
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def lookup_url(override=None):
    return override or os.environ.get("KYS_API_URL") or LOOKUP_URL


def sendable(name):
    """Could --online send this name? Two characters or more, and no longer than the look-up takes."""
    return 2 <= len(name) <= MAX_NAME_LENGTH


def request_body(names, country):
    """Exactly what --online sends, as the website does: the names, sorted and each once, and the country if it isn't GB."""
    body = {"merchants": sorted(set(names))}
    if country != "GB":
        body["country"] = country
    return body


def _service_name(name):
    """The look-up's own clean-up of a name (normaliseName in services/lookup/registries.ts), which labels its answers:
    "24/7 FITNESS" comes back as "24 7 FITNESS". The names sent are already plain upper case, so this is all of it."""
    return re.sub(r"\s+", " ", re.sub(r"[^A-Z0-9&]+", " ", name), flags=A).strip()[:MAX_NAME_LENGTH]


def _headers():
    """The website's public key (the same for everyone), or your own key if KYS_API_KEY is set."""
    own = os.environ.get("KYS_API_KEY")
    return {"Content-Type": "application/json", "Authorization": "Bearer " + (own or LOOKUP_KEY), "apikey": LOOKUP_KEY}


def _retry_after(value):
    if not value:
        return None
    value = value.strip()
    if re.match(r"\d+\Z", value):
        return int(value)
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max(0, math.ceil((when - datetime.now(timezone.utc)).total_seconds()))


def _wait_words(seconds):
    if seconds < 90:
        return _plural(seconds, "1 second", "%d seconds")
    if seconds < 5400:
        return "%d minutes" % round(seconds / 60)
    return "%d hours" % round(seconds / 3600)


def ask_online(names, country, url=None, timeout=None, sleep=None, say=print):
    """Ask our look-up about the names, MAX_PER_REQUEST at a time. Returns (answers, sources, problem): answers is
    {name: answer}; sources what the service could use ({"ai": False} when its AI research is paused for the day);
    problem a KysError (exit code 3) if it stopped answering, with the answers it had given so far."""
    url = lookup_url(url)
    sleep = sleep or time.sleep
    names = sorted({n for n in names if sendable(n)})
    answers, sources = {}, {}
    try:
        for i in range(0, len(names), MAX_PER_REQUEST):
            batch = names[i:i + MAX_PER_REQUEST]
            reply = _post(url, request_body(batch, country), timeout or LOOKUP_TIMEOUT, sleep, say)
            results = reply.get("results") if isinstance(reply, dict) else None
            if not isinstance(results, list):
                raise KysError("Our online look-up sent an answer this script can't read. Is kys.py up to date?", 3)
            told = reply.get("sources") if isinstance(reply.get("sources"), dict) else {}
            for k, v in told.items():
                if isinstance(v, bool):
                    sources[k] = sources.get(k, True) and v
            by_name = {}
            for r in results:
                if isinstance(r, dict) and isinstance(r.get("query"), str):
                    by_name.setdefault(r["query"], r)
            for n in batch:
                r = by_name.get(n) or by_name.get(_service_name(n))
                if r is not None:
                    answers[n] = r
    except KysError as e:
        return answers, sources, e
    return answers, sources, None


def _post(url, body, timeout, sleep, say):
    data = json.dumps(body).encode("utf-8")
    for attempt in range(4):
        try:
            with _request(url, data=data, headers=_headers(), timeout=timeout) as res:
                return json.loads(res.read(8 << 20).decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail, retry = _error_detail(e), e.headers.get("Retry-After")
            e.close()
            if e.code == 429:
                wait = _retry_after(retry)
                if attempt < 3 and wait is not None and wait <= 120:
                    say("Our online look-up is busy. Trying again in %s..." % _wait_words(max(wait, 1)))
                    sleep(wait)
                    continue
                if wait:
                    raise KysError("Our online look-up is busy. Please try again in about %s." % _wait_words(wait), 3)
                raise KysError("You've looked up a lot of new names today. Please try again tomorrow.", 3)
            if e.code in (401, 403):
                raise KysError("Our online look-up turned the request down (HTTP %d%s). %s" % (
                    e.code, detail, "Check your KYS_API_KEY." if os.environ.get("KYS_API_KEY") else "Please try again later."), 3)
            if e.code >= 500:
                raise KysError("Our online look-up had a problem (HTTP %d%s). Please try again in a little while." % (e.code, detail), 3)
            raise KysError("Our online look-up couldn't answer (HTTP %d%s)." % (e.code, detail), 3)
        except (urllib.error.URLError, http.client.HTTPException, OSError) as e:
            if isinstance(e, socket.timeout) or isinstance(getattr(e, "reason", None), socket.timeout):
                raise KysError("Our online look-up didn't answer within %d seconds. Please try again in a few minutes." % timeout, 3)
            raise KysError("We couldn't reach our online look-up (%s). Check your connection and try again." % _reason(e), 3)
        except ValueError:
            raise KysError("Our online look-up sent an answer this script can't read. Is kys.py up to date?", 3)
    raise KysError("Our online look-up is busy. Please try again later.", 3)


def _error_detail(e):
    try:
        body = json.loads(e.read(1 << 16).decode("utf-8"))
        msg = body.get("error") or body.get("message") if isinstance(body, dict) else None
        return ": " + str(msg)[:200] if msg else ""
    except Exception:
        return ""


def _plain(value):
    """Text from the network, made safe to print: control characters (which a terminal could act on) become spaces."""
    if isinstance(value, str):
        return _CONTROL.sub(" ", value)
    if isinstance(value, list):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    return value


def _online_entry(entry, name):
    """An entry from the look-up, with what this script needs filled in."""
    e = _plain(dict(entry))
    e["id"] = str(e.get("id") or "lookup-")
    e["display_name"] = str(e.get("display_name") or name)
    e["kind"] = e.get("kind") or "merchant"
    e["chain"] = [h for h in (e.get("chain") or []) if isinstance(h, dict) and h.get("name")]
    e["owner_country"] = str(e["owner_country"])
    e["tier"] = str(e.get("tier") or "LLM_GUESS")
    e["sources"] = [s for s in (e.get("sources") or []) if isinstance(s, dict)]
    return e


def online_result(engine, answer, name, paused=False):
    """An answer from our look-up, in quick-lookup.ts withAnswer()'s order: an owner (shown just as one from the
    built-in list is), a local independent, not a business, or no owner found. One it couldn't finish checking is
    "retry"; paused (the look-up said its AI step is paused for the day) says so instead, as the website does."""
    trace = [s for s in (answer.get("trace") or []) if isinstance(s, dict)]
    failed = any(s.get("status") == "error" for s in trace)
    recheck = answer.get("recheck_after") if isinstance(answer.get("recheck_after"), str) else None
    entry = answer.get("entry") if isinstance(answer.get("entry"), dict) else None
    base = {"answered_by": "online look-up", "steps": [_plain(str(s["detail"])) for s in trace if s.get("detail")], "can_ask": False}
    if answer.get("status") == "RESOLVED" and entry and entry.get("owner_country"):
        # attribute.ts: an answer naming an entry the built-in list has is shown with that entry
        e = engine.by_id.get(entry.get("id")) or _online_entry(entry, name)
        out = dict(engine.owner_result(e, name), **base)
        # explain.ts howWeKnow: an AI answer that hasn't had its web search yet says when that will happen
        if (recheck and e["id"].startswith("lookup-") and e["tier"] == "LLM_GUESS"
                and not re.search(r"checked with a web search|web search couldn't confirm", e.get("technique") or "", re.I)):
            out["note"] = RECHECK % short_date(recheck)
        return out
    if answer.get("status") == "LOCAL_BUSINESS":  # explain.ts localLines
        check = "A web search was part of that check." if answer.get("checked") == "web" else RECHECK % short_date(recheck) if recheck else "It wasn't checked with a web search."
        return dict(base, query=name, status="local", why=LOCAL_FOUND + " " + check)
    if answer.get("status") == "NOT_A_BUSINESS":
        return dict(base, query=name, status="not_business", why=NOT_BUSINESS)
    if failed:
        return dict(base, query=name, status="retry", why=PAUSED if paused else UNFINISHED)
    return dict(base, query=name, status="unknown", why=MISSED)


def confirm(names, url, country, assume_yes, say=print, ask=None, held=0, statement=True):
    """Show exactly what would be sent, and ask first."""
    say("")
    say("Our built-in list doesn't know %s. With --online, just %s%s would be sent to %s:" % (
        _plural(len(names), "this shop", "these %d shops"), "this name" if len(names) == 1 else "these names",
        "" if country == "GB" else ", and the country %s," % country, LOOKUP_PLACE if url == LOOKUP_URL else url))
    for n in names:
        say("  " + n)
    say("Nothing else is sent: no amounts, dates or anything else from your statement." if statement else
        "Nothing else is sent: not the rest of the text, and nothing about you.")
    if held:
        say("Held back and never sent: %s that may be a person's, could be sensitive or are local independents." % _plural(held, "1 name", "%d names"))
    if assume_yes:
        return True
    if not sys.stdin or not sys.stdin.isatty():
        say("Not sent: there's nobody to ask. Add --yes to send without asking.")
        return False
    try:
        answer = (ask or input)("Send %s? [y/N] " % ("it" if len(names) == 1 else "them"))
    except EOFError:
        answer = ""
    if answer.strip().lower() in ("y", "yes"):
        return True
    say("Not sent.")
    return False


def _plural(n, one, many):
    return one if n == 1 else many % n


# =====================================================================================================================
# 11. Words on the screen
# =====================================================================================================================

ARROW = " \N{RIGHTWARDS ARROW} "


def money(pence, currency=None):
    sign = "-" if pence < 0 else ""
    v = "{:,.2f}".format(abs(pence) / 100)
    symbol = {"GBP": "\xa3", "EUR": "\N{EURO SIGN}", "USD": "$"}.get(currency or "")
    if symbol:
        return sign + symbol + v
    return sign + v + (" " + currency if currency else "")


def chain_words(chain, countries):
    return ARROW.join("%s (%s)" % (h["name"], countries.name(h["country"]) if h.get("country") else "country unknown") for h in chain)


def print_result(r, countries, say=print, online_hint=True):
    if r.get("text") is not None and r.get("text") != r.get("query"):
        say("%s  (cleaned to \"%s\")" % (r["text"], r["query"]))
    elif r.get("query"):
        say(r["query"])
    st = r["status"]
    if st == "owner":
        say("  " + r["headline"])
        say("  Owner:        %s (%s)" % (r["owner"]["name"], r["owner"]["country_name"]))
        if r.get("chain"):
            say("  Chain:        " + chain_words(r["chain"], countries))
        how = r["how_we_know"]["label"] or "Not given"
        say("  How we know:  %s%s" % (how, ", last checked " + short_date(r["as_of"]) if r.get("as_of") else ""))
        m = r.get("matched") or {}
        if m.get("method") == "exact":
            say("  Matched:      \"%s\" in the text" % m["alias"])
        elif m.get("method") == "domain":
            say("  Matched:      the web address %s" % m["alias"].lower())
        elif m.get("method") == "joined":
            say("  Matched:      \"%s\" with the spaces missing, as banks often print it" % m["alias"])
        elif m.get("method") == "near":
            say("  Matched:      one letter different from \"%s\" (allowed for long names only; it can be wrong)" % m["alias"])
        elif r.get("answered_by") == "online look-up":
            say("  Answered by:  our online look-up")
        if r.get("note"):
            say("  Note:         " + r["note"])
        for s in r.get("sources") or []:
            say("  Source:       %s  %s" % (s["label"], s["url"]))
    elif st == "local":
        say("  This looks like a local independent business, so there's no owner to look up.")
        if r.get("why"):
            say("  " + r["why"])
    elif st == "person":
        say("  " + r["why"])  # "It looks like a person's name, so ..."
    elif st in HEADLINES:
        say("  " + HEADLINES[st])
        say("  " + r["why"])
    elif st == "empty":
        say("  There's no shop name in that text.")
    elif r.get("answered_by") == "online look-up":
        say("  We couldn't find who owns this.")
        say("  " + r["why"])
    else:
        say("  Not in our built-in list.")
        if online_hint and r.get("can_ask"):
            say("  To ask our online look-up, add --online. It sends just the name \"%s\"." % r["query"])
    where = r.get("where") or {}
    if where.get("evidence") not in (None, "home") and where.get("country") != r.get("country"):
        say("  Paid in:      %s (%s: %s)" % (countries.name(where["country"]), EVIDENCE_LABEL.get(where["evidence"], where["evidence"]), where.get("clue", "")))
    for i, step in enumerate(r.get("steps") or []):
        say(("  Checked:      " if i == 0 else " " * 16) + step)


HEADLINES = {  # quick-lookup.ts, the first line of each answer
    "sensitive": "We've held this name back.",
    "not_shop": "This doesn't look like a payment to a shop.",
    "not_business": "This doesn't look like a business.",
    "retry": "We couldn't look this up just now.",
}


def print_summary(s, groups, info, path, countries, say=print):
    cur = s["currency"]
    spend = [g for g in groups if g["kind"] == "spend"]
    payments = sum(g["payments"] for g in spend)
    cols = info["columns"]
    if cols.get("payee"):
        how = "\"%s\" and \"%s\" for the shop" % (cols["payee"], cols["description"])
    else:
        how = "\"%s\" for the shop" % cols["description"]
    if cols.get("amount"):
        how += ", \"%s\" for the amount" % cols["amount"]
    else:
        how += ", " + " and ".join("\"%s\"" % c for c in (cols.get("out"), cols.get("in")) if c) + " for the amount"
    if cols.get("type"):
        how += ", \"%s\" for the type of payment" % cols["type"]
    say("Read %s from %s (%s)." % (_plural(sum(g["payments"] for g in groups), "1 payment", "%d payments"), os.path.basename(path), how))
    for why, n in info.get("skipped", {}).items():
        say("  Skipped %s: %s." % (_plural(n, "1 line", "%d lines"), why))
    say("")
    if not payments:
        say("No spending found.")
        return
    say("Spending by the country of each shop's owner (%s, %s):" % (money(s["total"], cur), _plural(payments, "1 payment", "%d payments")))
    rows = [(c["country_name"], c["amount"], ", ".join(c["top"])) for c in s["countries"]]
    b = s["buckets"]
    extra = [
        ("Local independents", b["local"], "small local businesses: no owner to look up"),
        ("Not in our list", b["unknown"], ""),
        ("Couldn't check", b["retry"], "our online look-up couldn't check them just now: try again later"),
        ("Not businesses", b["not_business"], "according to our online look-up"),
        ("Held back", b["held"], "may be a person, or sensitive: never looked up"),
    ]
    rows += [r for r in extra if r[1] > 0]
    wide = max([len(r[0]) for r in rows] + [10])
    for name, amount, note in rows:
        share = "%3d%%" % round(100 * amount / s["total"]) if s["total"] > 0 else "    "
        say("  %s  %12s  %s  %s" % (name.ljust(wide), money(amount, cur), share, note))
    if s["other_currency"]:
        say("  %s in other currencies %s not added in." % (_plural(s["other_currency"], "1 payment", "%d payments"), "was" if s["other_currency"] == 1 else "were"))
    nc = s["not_counted"]
    if nc:
        parts = ["%s %s (%d)" % (KIND_WORDS[k].lower(), money(amt, cur), n) for k, (n, amt) in sorted(nc.items())]
        say("")
        say("Not counted as spending: " + "; ".join(parts) + ".")


def print_statement_results(groups, countries, say=print):
    shown = sorted((g for g in groups if g["kind"] == "spend"), key=lambda g: (_RANK[g["result"]["status"]], -g["out"], g["query"]))
    if not shown:
        return
    say("")
    say("Shops:")
    for g in shown:
        r = g["result"]
        if r["status"] == "owner":
            what = "%s%s%s (%s)" % (r["brand"], ARROW, r["owner"]["name"], r["owner"]["country_name"])
        else:
            what = STATUS_WORDS.get(r["status"], r["status"])
        say("  %-32s %s" % ((g["query"] or g["example"])[:32], what))


CSV_FIELDS = ("payee", "kind", "payments", "money_out", "money_in", "status", "brand", "owner", "owner_country",
              "owner_country_name", "how_we_know", "last_checked", "chain", "matched", "answered_by", "sources", "note")


def _cell(v):
    """A spreadsheet runs a cell starting with = + - or @ as a formula: put an apostrophe in front of text like that."""
    v = str(v)
    return "'" + v if v[:1] in ("=", "+", "-", "@", "\t", "\r") else v


def write_owners_csv(path, groups, countries, currency):
    rows = sorted(groups, key=lambda g: (g["kind"] != "spend", _RANK.get((g.get("result") or {}).get("status"), 9), -g["out"], g["query"]))
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(CSV_FIELDS)
        for g in rows:
            r = g.get("result") or {}
            st = r.get("status") if g["kind"] == "spend" else g["kind"]
            owner = r.get("owner") or {}
            m = r.get("matched") or {}
            w.writerow(_cell(v) for v in [
                g["query"] or g["example"], g["kind"], g["payments"], "%.2f" % (g["out"] / 100), "%.2f" % (g["in"] / 100),
                ("owner not found" if st == "unknown" and r.get("answered_by") == "online look-up" else STATUS_WORDS.get(st, st))
                if g["kind"] == "spend" else "not counted: " + KIND_WORDS.get(st, st).lower(),
                r.get("brand", ""), owner.get("name", ""), owner.get("country", ""), owner.get("country_name", ""),
                (r.get("how_we_know") or {}).get("label", ""), r.get("as_of") or "",
                chain_words(r["chain"], countries) if r.get("chain") else "",
                "%s: %s" % (m["method"], m["alias"]) if m.get("method") else "", r.get("answered_by", ""),
                " | ".join(s["url"] for s in r.get("sources") or []), r.get("note") or r.get("why") or "",
            ])


# =====================================================================================================================
# 12. The command line
# =====================================================================================================================

def _engine(args):
    return Engine(load_data(args.data))


def _country(value):
    c = (value or "").strip().upper()
    if not re.match(r"[A-Z]{2}\Z", c):
        raise KysError("--country takes a two-letter country code, like GB, IE or FR.", 2)
    return c


def cmd_lookup(args):
    country = _country(args.country)
    engine = _engine(args)
    r = look_up_locally(engine, " ".join(args.text), country)
    say = _err if args.json else print
    failure = None
    if args.online and r["status"] == "unknown" and r.get("can_ask"):
        url = lookup_url(args.api_url)
        if confirm([r["query"]], url, country, args.yes, say=say, statement=False):
            say("Asking our online look-up. It checks company registers, then asks an AI to research it. "
                "For a name nobody has asked about before, this can take up to two minutes.")
            answers, sources, failure = ask_online([r["query"]], country, url, say=say)
            if r["query"] in answers:
                r = dict(online_result(engine, answers[r["query"]], r["query"], paused=sources.get("ai") is False),
                         text=r["text"], country=r["country"], where=r.get("where"))
    if args.json:
        print(json.dumps(r, indent=2, ensure_ascii=False))
    else:
        if args.online:
            print("")
        print_result(r, engine.countries, online_hint=not args.online)
    if failure:
        _err("kys.py: %s" % failure)
        return failure.code
    return 0


def cmd_statement(args):
    country = _country(args.country)
    engine = _engine(args)
    rows, info = read_statement(args.file, args.column, args.amount_column, args.spend_positive)
    if not rows:
        raise KysError("Found no payments in %s. If the columns were guessed wrongly, name them with --column and --amount-column." % args.file)
    if not args.spend_positive and info["columns"].get("amount"):
        # parse.ts guessMapping: card statements list spending as positive numbers
        values = [r["amount"] for r in rows if r["amount"]]
        if info.get("card_statement") or (len(values) >= 3 and sum(1 for v in values if v > 0) / len(values) >= 0.75):
            _err("Most amounts in \"%s\" are positive%s. Card statements show spending that way: if this is one, run "
                 "again with --spend-positive." % (info["columns"]["amount"], ", and this looks like an American Express statement" if info.get("card_statement") else ""))
    groups = analyse_statement(engine, rows, country)
    say = _err if args.json else print
    failure = None
    if args.online:
        spend = [g for g in groups if g["kind"] == "spend"]
        names = sorted(g["query"] for g in spend if g["result"]["status"] == "unknown" and g["result"].get("can_ask"))
        held = [g for g in spend if g["result"]["status"] in ("person", "sensitive", "local")]
        url = lookup_url(args.api_url)
        if not names:
            say("Every shop name is either in our built-in list or held back, so there's nothing to look up online.")
        elif confirm(names, url, country, args.yes, say=say, held=len(held)):
            say("Asking our online look-up about %s. It checks company registers, then asks an AI to research each one. "
                "For names nobody has asked about before, this can take up to two minutes." % _plural(len(names), "1 name", "%d names"))
            answers, sources, failure = ask_online(names, country, url, say=say)
            paused = sources.get("ai") is False
            for g in spend:
                if g["query"] in answers:
                    g["result"] = online_result(engine, answers[g["query"]], g["query"], paused=paused)
            if answers:
                say("Our online look-up answered %s." % _plural(len(answers), "1 name", "%d names"))
            unfinished = sum(1 for g in spend if g["result"]["status"] == "retry")
            if unfinished:
                say(PAUSED if paused else "It didn't finish checking %s. Please try again in a little while." % _plural(unfinished, "1 name", "%d names"))
    currency = main_currency(groups)
    s = summarise(groups, engine.countries, currency)
    out = args.out
    if out is None and not args.json:
        stem, _ext = os.path.splitext(args.file)
        out = stem + ".owners.csv"
    if out:
        if os.path.abspath(out) == os.path.abspath(args.file):
            raise KysError("--out names the statement itself. Choose another file name, so your statement isn't written over.")
        write_owners_csv(out, groups, engine.countries, currency)
    if args.json:
        print(json.dumps({
            "file": os.path.basename(args.file),
            "columns": info["columns"],
            "currency": currency,
            "summary": {"total": s["total"] / 100, "countries": [dict(c, amount=c["amount"] / 100) for c in s["countries"]],
                        "local": s["buckets"]["local"] / 100, "not_in_list": s["buckets"]["unknown"] / 100, "held_back": s["buckets"]["held"] / 100,
                        "couldnt_check": s["buckets"]["retry"] / 100, "not_business": s["buckets"]["not_business"] / 100,
                        "not_counted": {k: {"payments": n, "money_out": amt / 100} for k, (n, amt) in s["not_counted"].items()},
                        "other_currency_payments": s["other_currency"]},
            "shops": [dict(g["result"], payments=g["payments"], money_out=g["out"] / 100, money_in=g["in"] / 100) for g in groups if g["kind"] == "spend"],
            "not_counted": [{"payee": g["query"], "kind": g["kind"], "payments": g["payments"], "money_out": g["out"] / 100, "money_in": g["in"] / 100}
                            for g in groups if g["kind"] != "spend"],
        }, indent=2, ensure_ascii=False))
    else:
        print_summary(s, groups, info, args.file, engine.countries)
        if args.details:
            print_statement_results(groups, engine.countries)
        if out:
            print("")
            print("Saved one line per shop to %s." % out)
        unknown = [g for g in groups if g["kind"] == "spend" and g["result"]["status"] == "unknown" and g["result"].get("can_ask")]
        if unknown and not args.online:
            print("%s in our list. To look %s up online, run again with --online: you'll see the names before anything is sent."
                  % (_plural(len(unknown), "1 shop isn't", "%d shops aren't"), "it" if len(unknown) == 1 else "them"))
    if failure:
        _err("kys.py: %s" % failure)
        return failure.code
    return 0


def cmd_data_update(args):
    data_update(args.url, None)
    return 0


def cmd_data_status(args):
    engine = _engine(args)
    m = engine.manifest or {}
    print("Ownership data in %s" % engine.folder)
    if m:
        print("  Version %s, downloaded %s from %s, checked against its SHA-256." % (m.get("version") or "unknown", short_date(m.get("downloaded")), m.get("source") or "?"))
    c = engine.counts
    print("  %s hand-built shops and %s product brands." % ("{:,}".format(c["merchants"]), "{:,}".format(c["product_brands"])))
    print("  %s brands from OpenStreetMap and Wikidata (built %s), with %s reviewed corrections (%s)." % (
        "{:,}".format(c["open_brands"]), short_date(engine.generated), "{:,}".format(c["corrections"]), short_date(engine.reviewed)))
    return 0


def _err(msg=""):
    print(msg, file=sys.stderr)


def build_parser():
    p = argparse.ArgumentParser(
        prog="kys.py",
        description="Who owns the shops on your bank statement. Works offline: nothing leaves your computer unless you add --online.",
        epilog="More: https://knowyourspend.org",
    )
    p.add_argument("--version", action="version", version="kys.py " + __version__)
    sub = p.add_subparsers(dest="command", metavar="COMMAND")
    sub.required = True
    data_opt = argparse.ArgumentParser(add_help=False)
    data_opt.add_argument("--data", metavar="FOLDER", help="read the ownership data from this folder (default: what `data update` saved)")

    lk = sub.add_parser("lookup", parents=[data_opt], help="who owns the shop in a line of bank text",
                        description="Who owns the shop in a line of bank text, a shop's name or a company's name.")
    lk.add_argument("text", nargs="+", help="for example \"COSTA COFFEE 43012 LONDON GB\"")
    lk.add_argument("--country", default="GB", help="two-letter code of your bank's country, or where you paid (default GB); "
                    "a country named in the text, like \"DUBLIN IE\", counts first")
    lk.add_argument("--json", action="store_true", help="print the answer as JSON")
    lk.add_argument("--online", action="store_true", help="if our list doesn't know it, ask our online look-up (sends just the cleaned name)")
    lk.add_argument("--yes", action="store_true", help="with --online, send without asking first")
    lk.add_argument("--api-url", metavar="URL", help="where --online sends names (default: our look-up service, or KYS_API_URL)")
    lk.set_defaults(func=cmd_lookup)

    st = sub.add_parser("statement", parents=[data_opt], help="who owns the shops in a statement saved as CSV",
                        description="Who owns the shops in a bank statement saved as CSV. Writes one line per shop to a CSV "
                                    "file and prints your spending by the country of each owner. Amounts and dates never leave your computer.")
    st.add_argument("file", help="the statement, as a CSV file")
    st.add_argument("--column", metavar="NAME", help="the heading of the column with the shop names (or its number, counting from 1)")
    st.add_argument("--amount-column", metavar="NAME", help="the heading of the amount column (negative = money out), or of a money-out column")
    st.add_argument("--spend-positive", action="store_true", help="the amount column shows spending as positive numbers (card statements, like Amex)")
    st.add_argument("--country", default="GB", help="two-letter code of your bank's country (default GB); a country named in a "
                    "payment's text, like \"DUBLIN IE\", counts first, as in the app")
    st.add_argument("--out", metavar="FILE", help="where to write the list of shops and owners (default: next to the statement, ending .owners.csv)")
    st.add_argument("--details", action="store_true", help="also print every shop and its owner")
    st.add_argument("--json", action="store_true", help="print everything as JSON instead (writes the CSV only with --out)")
    st.add_argument("--online", action="store_true", help="ask our online look-up about shops our list doesn't know (shows you the names first)")
    st.add_argument("--yes", action="store_true", help="with --online, send without asking first")
    st.add_argument("--api-url", metavar="URL", help="where --online sends names (default: our look-up service, or KYS_API_URL)")
    st.set_defaults(func=cmd_statement)

    dt = sub.add_parser("data", help="download or check the ownership data")
    dsub = dt.add_subparsers(dest="data_command", metavar="ACTION")
    dsub.required = True
    up = dsub.add_parser("update", help="download the latest ownership data (about 2 MB) from knowyourspend.org")
    up.add_argument("--url", help=argparse.SUPPRESS)
    up.set_defaults(func=cmd_data_update)
    ds = dsub.add_parser("status", parents=[data_opt], help="show which ownership data is in use")
    ds.set_defaults(func=cmd_data_status)
    return p


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")  # a console that can't show a character gets "?", not a crash
        except (AttributeError, ValueError):
            pass
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except KysError as e:
        _err("kys.py: %s" % e)
        return e.code
    except KeyboardInterrupt:
        _err("Stopped.")
        return 130
    except BrokenPipeError:  # the output went to something that stopped reading (| head)
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        return 1


# ==================================================================================================================
# Generated tables. Everything below this line up to the end marker is written by tools/python/build.mjs from the
# TypeScript files named in the comments, so this script matches the app. Don't edit it here: change the TypeScript
# and run `node tools/python/build.mjs`.
# ==================================================================================================================

# packages/statement/src/normalise.ts
MAX_PAYEE_LENGTH = 40
MONTHS = "JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEPT?|OCT|NOV|DEC"
BANK_PREFIXES = (
    "DIRECT DEBIT PAYMENT TO", "CONTACTLESS PAYMENT TO", "DEBIT CARD PAYMENT TO", "CONTACTLESS PAYMENT",
    "DEBIT CARD PAYMENT", "STANDING ORDER TO", "FASTER PAYMENT TO", "BILL PAYMENT TO", "CARD PAYMENT TO",
    "DIRECT DEBIT TO", "STANDING ORDER", "FASTER PAYMENT", "CARD PURCHASE", "VISA PURCHASE", "CARD PAYMENT",
    "DIRECT DEBIT", "BILL PAYMENT", "CONTACTLESS", "PAYMENT TO", "GOOGLE PAY", "APPLE PAY", "PURCHASE", "VISA",
    "POS", "CRD", "DDR", "D/D", "S/O", "STO", "FPI", "FPO", "VIS", "BGC", "DEB", "CPT", "TFR", "BBP", "EFT", "OTR",
    "DD", "SO", "BP",
)
FACILITATOR_RE = re.compile(r"^(SQ|SUMUP|ZETTLE_?|IZETTLE|IZ|PAYPAL|PP|GOOGLE|CRV|SP|TST|KLARNA|CLEARPAY|BT)\s*\*\s*", re.A)
FACILITATOR_NAME = {"PP": "PAYPAL", "IZ": "ZETTLE", "IZETTLE": "ZETTLE", "ZETTLE_": "ZETTLE"}
BT_OWN = re.compile(r"^(?:MOBILE|BROADBAND|SPORT|TV|GROUP|PLC|BUSINESS|BILL|INTERNET|HOME|OPENREACH|PAYMENT|EE)\b", re.A)
KNOWN_FORMS = (
    (
        re.compile(
            r"^(?:AMZNMKTPLACE|AMZN\s*MKTP|AMAZON\s*MKTPL|AMAZON\s*MARKETPLACE|AMAZON\.CO\.UK|AMAZON\.COM"
            r"|AMZN\.CO\.UK|WWW\.AMAZON|AMAZON\s+EU\b)",
            re.A,
        ),
        "AMAZON",
    ),
    (re.compile(r"^UBER\s*\*?\s*EATS\b|^UBEREATS\b", re.A), "UBER EATS"),
    (re.compile(r"^UBER\s*\*?\s*(?:TRIP|RIDES?|HELP\.UBER|BV)\b", re.A), "UBER"),
    (re.compile(r"^(?:TFL|TRANSPORT FOR LONDON)\b", re.A), "TFL"),
)
COUNTRIES_SAFE = (
    "UNITED STATES OF AMERICA", "UNITED KINGDOM", "UNITED STATES", "GREAT BRITAIN", "ISLE OF MAN", "NETHERLANDS",
    "LUXEMBOURG", "SWITZERLAND", "AUSTRALIA", "GUERNSEY", "PORTUGAL", "IRELAND", "GERMANY", "BELGIUM", "DENMARK",
    "FINLAND", "AUSTRIA", "SWEDEN", "NORWAY", "POLAND", "CANADA", "FRANCE", "JERSEY", "SPAIN", "ITALY", "GBR",
    "USA", "IRL", "LUX", "NLD", "DEU", "FRA", "ESP", "ITA", "BEL", "PRT", "CHE", "SWE", "DNK", "NOR", "FIN", "POL",
    "AUT", "CAN", "AUS", "JEY", "GGY", "IMN", "GB", "UK", "IE", "NL", "LU", "FR",
)
COUNTRIES_PADDED_ONLY = (
    "US", "DE", "ES", "IT", "BE", "AT", "CH", "SE", "DK", "NO", "FI", "PL", "CZ", "GR", "PT", "CA", "AU", "JE",
    "GG", "IM",
)
PLACE_NAMES = (
    "LONDON", "MANCHESTER", "BIRMINGHAM", "LEEDS", "GLASGOW", "EDINBURGH", "LIVERPOOL", "BRISTOL", "SHEFFIELD",
    "NEWCASTLE UPON TYNE", "NEWCASTLE", "NOTTINGHAM", "LEICESTER", "CARDIFF", "BELFAST", "COVENTRY", "BRADFORD",
    "SOUTHAMPTON", "PORTSMOUTH", "PLYMOUTH", "READING", "DERBY", "WOLVERHAMPTON", "STOKE ON TRENT",
    "STOKE-ON-TRENT", "SUNDERLAND", "NORWICH", "SWANSEA", "ABERDEEN", "DUNDEE", "OXFORD", "CAMBRIDGE", "BRIGHTON",
    "HOVE", "MILTON KEYNES", "NORTHAMPTON", "LUTON", "YORK", "HULL", "PRESTON", "BOURNEMOUTH", "POOLE", "SWINDON",
    "PETERBOROUGH", "SOUTHEND ON SEA", "SOUTHEND", "IPSWICH", "EXETER", "GLOUCESTER", "CHELTENHAM", "WATFORD",
    "SLOUGH", "CRAWLEY", "GUILDFORD", "WOKING", "BASINGSTOKE", "MAIDSTONE", "CANTERBURY", "CHELMSFORD",
    "COLCHESTER", "BASILDON", "STEVENAGE", "ST ALBANS", "HIGH WYCOMBE", "AYLESBURY", "BEDFORD", "LINCOLN",
    "CHESTER", "WARRINGTON", "STOCKPORT", "BOLTON", "WIGAN", "OLDHAM", "ROCHDALE", "SALFORD", "BLACKPOOL",
    "BLACKBURN", "BURNLEY", "HUDDERSFIELD", "WAKEFIELD", "DONCASTER", "ROTHERHAM", "BARNSLEY", "MIDDLESBROUGH",
    "DARLINGTON", "DURHAM", "CARLISLE", "LANCASTER", "HARROGATE", "SCARBOROUGH", "WORCESTER", "HEREFORD",
    "SHREWSBURY", "TELFORD", "WALSALL", "DUDLEY", "SOLIHULL", "NUNEATON", "RUGBY", "LEAMINGTON SPA",
    "STRATFORD UPON AVON", "BANBURY", "WINCHESTER", "SALISBURY", "TAUNTON", "TORQUAY", "TRURO", "STIRLING",
    "INVERNESS", "PERTH", "PAISLEY", "NEWPORT", "WREXHAM", "DERRY", "LISBURN", "WESTMINSTER", "CAMDEN", "ISLINGTON",
    "HACKNEY", "GREENWICH", "LEWISHAM", "SOUTHWARK", "LAMBETH", "BRIXTON", "CLAPHAM", "CROYDON", "WIMBLEDON",
    "KINGSTON UPON THAMES", "KINGSTON", "RICHMOND", "HAMMERSMITH", "FULHAM", "CHELSEA", "KENSINGTON", "SHOREDITCH",
    "STRATFORD", "CANARY WHARF", "WEMBLEY", "EALING", "ROMFORD", "ILFORD", "BROMLEY", "SUTTON", "HARROW", "ENFIELD",
    "BARNET", "WOOLWICH", "PECKHAM", "WALTHAMSTOW", "HOUNSLOW", "UXBRIDGE", "HEATHROW", "GATWICK", "DUBLIN", "CORK",
    "GALWAY", "LIMERICK", "AMSTERDAM", "BERLIN", "MUNICH", "MUENCHEN", "FRANKFURT", "HAMBURG", "PARIS", "LYON",
    "MADRID", "BARCELONA", "MALAGA", "LISBON", "LISBOA", "PORTO", "ROME", "MILAN", "MILANO", "BRUSSELS",
    "BRUXELLES", "VIENNA", "WIEN", "PRAGUE", "PRAHA", "COPENHAGEN", "STOCKHOLM", "OSLO", "HELSINKI", "ZURICH",
    "GENEVA", "LUXEMBOURG", "WARSAW", "BUDAPEST", "ATHENS", "NEW YORK", "SAN FRANCISCO", "LOS ANGELES", "SEATTLE",
)

# packages/statement/src/places-more.ts
MORE_PLACES = (
    "ABBEY ROAD", "ABBEY WOOD", "ABBOTS LANGLEY", "ABERCANAID", "ABERCARN", "ABERCYNON", "ABERDARE", "ABERGAVENNY",
    "ABERGELE", "ABERKENFIG", "ABERTILLERY", "ABERTRIDWR", "ABERYSTWYTH", "ABINGDON", "ABRAM", "ACCRINGTON",
    "ACOCKS GREEN", "ADDLESTONE", "ADLINGTON", "ADWICK LE STREET", "AIGBURTH", "AIRDRIE", "ALCESTER", "ALDERSHOT",
    "ALDRIDGE", "ALEXANDRIA", "ALFRETON", "ALLERTON", "ALLOA", "ALNESS", "ALNWICK", "ALSAGER", "ALTRINCHAM",
    "AMBLE", "AMERSHAM", "AMERSHAM ON THE HILL", "AMESBURY", "AMMANFORD", "AMPTHILL", "AN MUILEANN GCEARR",
    "AN ROS", "ANDOVER", "ANNAN", "ANNFIELD PLAIN", "ANSTEY", "ANTRIM", "APPLEY BRIDGE", "ARBROATH", "ARCHWAY",
    "ARDROSSAN", "ARKLOW", "ARLESEY", "ARMADALE", "ARMAGH", "ARMTHORPE", "ARTANE", "ASH VALE", "ASHBOURNE",
    "ASHBY DE LA ZOUCH", "ASHFORD", "ASHINGTON", "ASHTEAD", "ASHTON IN MAKERFIELD", "ASHTON UNDER LYNE", "ASKERN",
    "ATHERSTONE", "ATHERTON", "ATHLONE", "ATTLEBOROUGH", "AUCHTERARDER", "AUDLEY", "AVELEY", "AXMINSTER",
    "AYLESTONE", "AYLSHAM", "BACUP", "BAGSHOT", "BAILDON", "BALALLY", "BALBRIGGAN", "BALDOCK", "BALDOYLE",
    "BALERNO", "BALHAM", "BALLINA", "BALLINASLOE", "BALLINCOLLIG", "BALLINGRY", "BALLINTEER", "BALLYBODEN",
    "BALLYCASTLE", "BALLYCLARE", "BALLYFERMOT", "BALLYMENA", "BALLYMONEY", "BALLYMUN", "BALLYNAHINCH",
    "BALSALL COMMON", "BANBRIDGE", "BANCHORY", "BANDON", "BANGOR", "BANNOCKBURN", "BANSTEAD", "BARGOED",
    "BARKINGSIDE", "BARNARD CASTLE", "BARNES", "BARNHAM", "BARNOLDSWICK", "BARNSBURY", "BARNSTAPLE", "BARNT GREEN",
    "BARRHEAD", "BARROW IN FURNESS", "BARROW UPON SOAR", "BARROWFORD", "BARTLEY GREEN", "BARTON ON SEA",
    "BARTON UPON HUMBER", "BASFORD", "BASFORD STOKE ON TRENT", "BATCHWORTH", "BATHGATE", "BATLEY", "BATTERSEA",
    "BATTLE", "BAYSTON HILL", "BAYSWATER", "BEACONSFIELD", "BEARSDEN", "BEBINGTON", "BECCLES", "BECKENHAM",
    "BECONTREE", "BEDDAU", "BEDLINGTON", "BEDWAS", "BEDWORTH", "BEIGHTON", "BEITH", "BELGRAVE", "BELLE VALE",
    "BELLSHILL", "BELPER", "BELSIZE PARK", "BENNETTS END", "BENTLEY", "BENWELL", "BERKHAMSTED", "BERNARDS HEATH",
    "BERWICK UPON TWEED", "BETHNAL GREEN", "BEVERLEY", "BEWBUSH", "BEWDLEY", "BEXHILL ON SEA", "BEXLEY", "BICESTER",
    "BICKLEY", "BIDDULPH", "BIDEFORD", "BIDFORD ON AVON", "BIGGIN HILL", "BIGGLESWADE", "BILLERICAY", "BILLINGE",
    "BILLINGHAM", "BILLINGSHURST", "BINGHAM", "BINGLEY", "BIRCHINGTON ON SEA", "BIRCOTES", "BIRKENHEAD", "BIRSTALL",
    "BISHOP AUCKLAND", "BISHOPBRIGGS", "BISHOPS CLEEVE", "BISHOPS STORTFORD", "BISHOPS WALTHAM", "BISHOPSTOKE",
    "BISHOPSWORTH", "BLABY", "BLACKHEATH", "BLACKLEY", "BLACKROCK", "BLACKROD", "BLACKWALL", "BLACKWOOD", "BLACON",
    "BLAENAVON", "BLAIRGOWRIE AND RATTRAY", "BLANCHARDSTOWN", "BLANDFORD FORUM", "BLANTYRE", "BLAYDON ON TYNE",
    "BLESSINGTON", "BLETCHLEY", "BLOXWICH", "BLYTH", "BODMIN", "BOGNOR REGIS", "BOLLINGTON", "BOLSOVER",
    "BOLTON LE SANDS", "BOLTON UPON DEARNE", "BONESS", "BONHILL", "BONNYBRIDGE", "BONNYRIGG", "BOOTERSTOWN",
    "BOOTLE", "BORDON", "BOREHAMWOOD", "BORROWASH", "BOSTON SPA", "BOTHWELL", "BOUGHTON", "BOURNE END", "BOVINGDON",
    "BOWDON", "BOWTHORPE", "BRACEBRIDGE HEATH", "BRACKLEY", "BRACKNELL", "BRADFORD ON AVON", "BRADWELL",
    "BRAINTREE", "BRAMCOTE", "BRAMHALL", "BRAUNSTONE", "BRAUNTON", "BRECHIN", "BRECON", "BREDBURY", "BRENT",
    "BRENTFORD", "BRENTWOOD", "BRIDGE OF ALLAN", "BRIDGEND", "BRIDGNORTH", "BRIDGWATER", "BRIDLINGTON", "BRIDPORT",
    "BRIERFIELD", "BRIERLEY HILL", "BRIGG", "BRIGHOUSE", "BRIGHTLINGSEA", "BRITON FERRY", "BRITWELL", "BRIXHAM",
    "BRIXTON HILL", "BRIXWORTH", "BROADFIELD", "BROADSTAIRS", "BROADSTONE", "BROADWATER", "BROCKLEY", "BROMBOROUGH",
    "BROMSGROVE", "BROSELEY", "BROTTON", "BROUGH", "BROUGHTON", "BROUGHTON ASTLEY", "BROWNHILLS", "BROXBOURNE",
    "BROXBURN", "BRUNDALL", "BRYMBO", "BRYNAMMAN", "BRYNMAWR", "BRYNNA", "BUCKHURST HILL", "BUCKIE", "BUCKINGHAM",
    "BUCKLEY", "BUDLEIGH SALTERTON", "BULFORD", "BUNCRANA", "BUNGAY", "BURGESS HILL", "BURLEY IN WHARFEDALE",
    "BURNAGE", "BURNGREAVE", "BURNHAM", "BURNHAM ON CROUCH", "BURNHAM ON SEA", "BURNTISLAND", "BURNTWOOD",
    "BURPHAM", "BURRY PORT", "BURSCOUGH", "BURSLEDON", "BURTON LATIMER", "BURTON UPON TRENT", "BURWELL",
    "BURY ST EDMUNDS", "BUXTON", "CABINTEELY", "CAERLEON", "CAERNARFON", "CAERPHILLY", "CAISTER ON SEA", "CALCOT",
    "CALDICOT", "CALLINGTON", "CALNE", "CALVERTON", "CAMBERLEY", "CAMBOURNE", "CAMBUSLANG", "CAMDEN TOWN",
    "CANFORD HEATH", "CANNING TOWN", "CANNOCK", "CANONBURY", "CANVEY ISLAND", "CARCROFT", "CARDIGAN", "CARLOW",
    "CARLUKE", "CARMARTHEN", "CARNFORTH", "CARNOUSTIE", "CARPENDERS PARK", "CARRICK ON SUIR", "CARRICKFERGUS",
    "CARRICKMACROSS", "CARRIGALINE", "CARRIGTWOHILL", "CARRYDUFF", "CARSHALTON", "CARTERTON", "CASTLE DONINGTON",
    "CASTLE VALE", "CASTLEBAR", "CASTLEFORD", "CASTLEKNOCK", "CASTLEREAGH", "CASTLETROY", "CATERHAM", "CATFORD",
    "CATTERICK GARRISON", "CAVAN", "CELBRIDGE", "CHADDERTON", "CHADDESDEN", "CHADWELL HEATH", "CHADWELL ST MARY",
    "CHAFFORD HUNDRED", "CHALFONT SAINT PETER", "CHALFONT ST GILES", "CHALFORD", "CHALK FARM", "CHAPEL ALLERTON",
    "CHAPEL EN LE FRITH", "CHAPELHALL", "CHAPELIZOD", "CHAPELTOWN", "CHARLTON", "CHARLTON KINGS", "CHASETOWN",
    "CHATHAM", "CHATTERIS", "CHEADLE", "CHEADLE HULME", "CHEAM", "CHEDDAR", "CHEETHAM HILL", "CHELMSLEY WOOD",
    "CHELSFIELD", "CHEPSTOW", "CHERRY ORCHARD", "CHERRYVILLE", "CHERTSEY", "CHESHAM", "CHESHUNT", "CHESSINGTON",
    "CHESTER LE STREET", "CHESTERFIELD", "CHICHESTER", "CHIGWELL", "CHILDWALL", "CHILWELL", "CHINGFORD", "CHINNOR",
    "CHIPPENHAM", "CHIPPING NORTON", "CHIPPING SODBURY", "CHISLEHURST", "CHISWELL GREEN", "CHISWICK", "CHORLEY",
    "CHORLEYWOOD", "CHRISTCHURCH", "CHURCH STREET", "CHURCHDOWN", "CINDERFORD", "CIRENCESTER", "CITY OF LONDON",
    "CITY OF WESTMINSTER", "CLACTON ON SEA", "CLANE", "CLAPHAM JUNCTION", "CLARKSTON", "CLAYTON LE MOORS",
    "CLAYTON LE WOODS", "CLAYTON WEST", "CLEATOR MOOR", "CLECKHEATON", "CLEETHORPES", "CLEVEDON", "CLEVELEYS",
    "CLITHEROE", "CLONDALKIN", "CLOWNE", "CLUAIN MEALA", "CLYDACH", "CLYDEBANK", "COALISLAND", "COALVILLE",
    "COATBRIDGE", "COBHAM", "COCKENZIE", "COCKERMOUTH", "COCKFOSTERS", "COCKINGTON", "CODICOTE", "CODSALL",
    "COEDPOETH", "COITY", "COLEFORD", "COLERAINE", "COLINTON", "COLLIER ROW", "COLNBROOK", "COLNE", "COLWYN BAY",
    "COMBER", "CONFEY", "CONGLETON", "CONISBROUGH", "CONSETT", "COOKHAM", "COOKSTOWN", "COPPULL", "CORBY",
    "CORSHAM", "COSHAM", "COTGRAVE", "COTTENHAM", "COULSDON", "COUNTESTHORPE", "COWDENBEATH", "COWES", "COWLEY",
    "COWPLAIN", "CRADLEY HEATH", "CRAIGAVON", "CRAMLINGTON", "CRANFIELD", "CRANFORD", "CRANLEIGH", "CREDITON",
    "CRESWELL", "CREWE", "CREWKERNE", "CRICKLEWOOD", "CRIEFF", "CROFTON", "CROFTON PARK", "CROMER", "CROOK",
    "CROSS HILLS", "CROUCH END", "CROWBOROUGH", "CROWTHORNE", "CROXLEY GREEN", "CROXTETH", "CRUMLIN", "CRUMPSALL",
    "CRYSTAL PALACE", "CUDWORTH", "CULCHETH", "CULLOMPTON", "CUMBERNAULD", "CUMNOCK", "CUNNINGHAM", "CUPAR",
    "CURRIE", "CWMAFAN", "CWMBRAN", "DAGENHAM", "DALGETY BAY", "DALKEITH", "DALKEY", "DALMUIR", "DALRY", "DALSERF",
    "DALTON IN FURNESS", "DANBURY", "DARFIELD", "DARNDALE", "DARRAS HALL", "DARTFORD", "DARTMOUTH", "DARTON",
    "DARWEN", "DAVENTRY", "DAWLISH", "DEESIDE", "DEGANWY", "DENBIGH", "DENMEAD", "DENNY", "DENTON", "DENTON HOLME",
    "DESBOROUGH", "DEVIZES", "DEWSBURY", "DHEKELIA", "DIDCOT", "DIDSBURY", "DINAS POWYS", "DINGLE", "DINGWALL",
    "DINNINGTON", "DODWORTH", "DOLLYMOUNT", "DONABATE", "DONAGHADEE", "DONAGHMEDE", "DONINGTON LE HEATH",
    "DONNYBROOK", "DONNYCARNEY", "DORCHESTER", "DORKING", "DORRIDGE", "DOUGLAS", "DOWNHAM MARKET", "DOWNPATRICK",
    "DOWNSIDE", "DRIFFIELD", "DROGHEDA", "DROICHEAD NUA", "DROITWICH", "DROMORE", "DRONFIELD", "DROYLSDEN",
    "DUKINFIELD", "DUMBARTON", "DUMFRIES", "DUN LAOGHAIRE", "DUNBAR", "DUNBLANE", "DUNBOYNE", "DUNDALK",
    "DUNDONALD", "DUNDRUM", "DUNFERMLINE", "DUNGANNON", "DUNGARVAN", "DUNHOLME", "DUNOON", "DUNSTABLE", "DUNTOCHER",
    "DURSLEY", "EADESTOWN", "EAGLESCLIFFE", "EALING COMMON", "EARL SHILTON", "EARLS BARTON", "EARLS COURT",
    "EARLSFIELD", "EARLSWOOD", "EASINGTON", "EAST BARNET", "EAST BOLDON", "EAST COWES", "EAST DEREHAM",
    "EAST DULWICH", "EAST GRINSTEAD", "EAST HORSLEY", "EAST KILBRIDE", "EAST LEAKE", "EAST MOLESEY", "EAST SHEEN",
    "EAST TILBURY", "EAST WITTERING", "EASTBOURNE", "EASTLEIGH", "EASTON", "EASTWOOD", "EATON SOCON", "EBBW VALE",
    "ECCLES", "EDENBRIDGE", "EDENDERRY", "EDGWARE", "EDGWAREBURY", "EDMONTON", "EDWINSTOWE", "EGHAM", "EGREMONT",
    "ELDERSLIE", "ELLAND", "ELLESMERE PORT TOWN", "ELLON", "ELM PARK", "ELTHAM", "EMERSON PARK", "EMSWORTH",
    "ENDERBY", "ENFIELD LOCK", "ENFIELD TOWN", "ENNIS", "ENNISCORTHY", "ENNISKILLEN", "EPPING", "ERITH", "ERSKINE",
    "ESHER", "ESTON", "EUXTON", "EVESHAM", "EVINGTON", "EWELL", "EXMOUTH", "FAIFLEY", "FAILSWORTH", "FAIR OAK",
    "FAKENHAM", "FALKIRK", "FALLOWFIELD", "FALMOUTH", "FAREHAM", "FARINGDON", "FARNBOROUGH", "FARNHAM",
    "FARNHAM ROYAL", "FARNWORTH", "FAVERSHAM", "FAZAKERLEY", "FAZELEY", "FEATHERSTONE", "FELIXSTOWE", "FELLING",
    "FERMOY", "FERNDALE", "FERNDOWN", "FERRYHILL", "FETCHAM", "FILEY", "FINGLAS", "FIRHOUSE", "FLACKWELL HEATH",
    "FLEET", "FLEETVILLE", "FLEETWOOD", "FLITWICK", "FOLKESTONE", "FORDINGBRIDGE", "FOREST HILL", "FORFAR",
    "FORMBY", "FORRES", "FORT WILLIAM", "FOUR MARKS", "FOXROCK", "FRASERBURGH", "FRECKLETON", "FRESHWATER",
    "FRIERN BARNET", "FRIMLEY", "FRIMLEY GREEN", "FRINTON ON SEA", "FRODSHAM", "FULWOOD", "FURNACE GREEN",
    "FURZE PLATT", "FURZEDOWN", "FYLDE", "GAINSBOROUGH", "GALASHIELS", "GARFORTH", "GARSTANG", "GARSTON",
    "GARSWOOD", "GATESHEAD", "GEDLING", "GELLIGAER", "GERRARDS CROSS", "GIFFNOCK", "GILLINGHAM", "GIPSY HILL",
    "GIRVAN", "GLANMIRE", "GLASTONBURY", "GLEN PARVA", "GLENFIELD", "GLENROTHES", "GLOSSOP", "GLUSBURN",
    "GLYN NEATH", "GODALMING", "GODMANCHESTER", "GOLBORNE", "GOLDERS GREEN", "GOODMAYES", "GOOLE", "GOREBRIDGE",
    "GOREY", "GORLESTON ON SEA", "GORSEINON", "GOSFORTH", "GOSPORT", "GOSSOPS GREEN", "GOUROCK", "GRANGE HILL",
    "GRANGEMOUTH", "GRANTHAM", "GRAPPENHALL", "GRAVESEND", "GRAYS", "GREASBY", "GREAT BOOKHAM", "GREAT DUNMOW",
    "GREAT GONERBY", "GREAT HARWOOD", "GREAT MALVERN", "GREAT MISSENDEN", "GREAT SANKEY", "GREAT TORRINGTON",
    "GREAT WAKERING", "GREAT WYRLEY", "GREAT YARMOUTH", "GREENFORD", "GREENHILL", "GREENHILLS", "GREENHITHE",
    "GREENISLAND", "GREENOCK", "GRESFORD", "GREYSTONES", "GRIMSBY", "GROBY", "GROVE", "GUISBOROUGH", "GUISELEY",
    "HADDINGTON", "HADLEIGH", "HADLEY", "HADLEY WOOD", "HAGLEY", "HAILSHAM", "HAINAULT", "HALE BARNS", "HALESOWEN",
    "HALESWORTH", "HALEWOOD", "HALSTEAD", "HAMPTON WICK", "HANWORTH", "HARDINGSTONE", "HAREFIELD", "HARLESDEN",
    "HARLOW", "HAROLD WOOD", "HARPENDEN", "HARRINGAY", "HARROW ON THE HILL", "HARROW ROAD", "HARROW WEALD",
    "HARTLEPOOL", "HARTLEY", "HARTSHILL", "HARTSTOWN", "HARWICH", "HASLEMERE", "HASLINGDEN", "HASSOCKS", "HASTINGS",
    "HATCH END", "HATFIELD", "HAUGHTON GREEN", "HAVANT", "HAVERFORDWEST", "HAVERHILL", "HAWARDEN", "HAWICK",
    "HAWKINGE", "HAWORTH", "HAXBY", "HAYDOCK", "HAYLE", "HAYLING ISLAND", "HAYWARDS HEATH", "HAZEL GROVE",
    "HEADSTONE", "HEANOR", "HEAVITREE", "HEBBURN", "HECKMONDWIKE", "HEDGE END", "HEDON", "HEIGHINGTON",
    "HELENSBURGH", "HELSBY", "HELSTON", "HEMEL HEMPSTEAD", "HEMSBY", "HEMSWORTH", "HENGOED", "HENLEY ON THAMES",
    "HENLOW", "HERNE BAY", "HERTFORD", "HESTON", "HESWALL", "HETHERSETT", "HETTON LE HOLE", "HEXHAM", "HEYSHAM",
    "HEYWOOD", "HIGH BARNET", "HIGH BLANTYRE", "HIGH PEAK", "HIGHAM FERRERS", "HIGHAMS PARK", "HIGHBURY",
    "HIGHWORTH", "HILLINGDON", "HINCKLEY", "HINDHEAD", "HINDLEY", "HIRWAUN", "HISTON", "HITCHIN", "HOCKLEY",
    "HODDESDON", "HOLBEACH", "HOLBECK", "HOLBORN", "HOLLINWOOD", "HOLLOWAY", "HOLMES CHAPEL", "HOLYHEAD",
    "HOLYTOWN", "HOLYWELL", "HOLYWOOD", "HONITON", "HORBURY", "HORLEY", "HORNCASTLE", "HORNCHURCH", "HORNSEA",
    "HORNSEY", "HORSFORTH", "HORSHAM", "HORWICH", "HOUGHTON LE SPRING", "HOUSTON", "HOWTH", "HOYLAKE",
    "HOYLAND NETHER", "HUCKNALL", "HULME", "HUMBERSTON", "HUMBERSTONE", "HUNGERFORD", "HUNSTANTON", "HUNTINGDON",
    "HUNTS CROSS", "HURSTPIERPOINT", "HUYTON", "HYDE PARK", "HYTHE", "IBSTOCK", "ICKENHAM", "ILFRACOMBE",
    "ILKESTON", "ILKLEY", "ILMINSTER", "IMMINGHAM", "INCE IN MAKERFIELD", "INGATESTONE", "INGLEBY GREENHOW",
    "INVERKEITHING", "INVERURIE", "IRLAM", "IRTHLINGBOROUGH", "IRVINE", "ISLE OF ARRAN", "ISLE OF BUTE",
    "ISLE OF LEWIS", "ISLEWORTH", "IVER HEATH", "IVYBRIDGE", "JARROW", "JOBSTOWN", "JOHNSTONE", "JORDANSTOWN",
    "KEARSLEY", "KEIGHLEY", "KELSO", "KELTY", "KELVEDON", "KEMPSTON", "KEMPSTON HARDWICK", "KEMSING", "KENDAL",
    "KENILWORTH", "KENLEY", "KENSAL GREEN", "KESGRAVE", "KETTERING", "KEYNSHAM", "KEYWORTH", "KIBWORTH HARCOURT",
    "KIDBROOKE", "KIDDERMINSTER", "KIDLINGTON", "KIDSGROVE", "KILBIRNIE", "KILBURN", "KILCOCK", "KILDARE",
    "KILKEEL", "KILKENNY", "KILLAMARSH", "KILLARNEY", "KILLESTER", "KILMARNOCK", "KILQUADE", "KILSYTH",
    "KILWINNING", "KIMBERLEY", "KINGS CROSS", "KINGS LANGLEY", "KINGS LYNN", "KINGSBRIDGE", "KINGSTEIGNTON",
    "KINGSTON UPON HULL", "KINGSWINFORD", "KINGSWOOD", "KINSALE", "KINSEALY DRINAN", "KIPPAX", "KIRBY MUXLOE",
    "KIRK SANDALL", "KIRKBY", "KIRKBY IN ASHFIELD", "KIRKCALDY", "KIRKDALE", "KIRKHAM", "KIRKINTILLOCH",
    "KIRKLEATHAM", "KIRKWALL", "KIRRIEMUIR", "KIVETON PARK", "KNAPHILL", "KNARESBOROUGH",
    "KNIGHTSBRIDGE AND BELGRAVIA", "KNOCKLYON", "KNOTTINGLEY", "KNOTTY ASH", "KNOWLE", "KNUTSFORD", "LADYWELL",
    "LANARK", "LANCASTER GATE", "LANCING", "LANGLEY GREEN", "LARBERT", "LARGS", "LARKFIELD", "LARKHALL", "LARNE",
    "LATCHMERE", "LAUNCESTON", "LAYTOWN", "LEATHERHEAD", "LEAVESDEN GREEN", "LEDBURY", "LEE ON THE SOLENT",
    "LEICESTER FOREST EAST", "LEIGH", "LEIGHTON BUZZARD", "LEISTON", "LEIXLIP", "LENZIE", "LEOMINSTER", "LERWICK",
    "LETCHWORTH GARDEN CITY", "LETTERKENNY", "LEVEN", "LEVERSTOCK GREEN", "LEWES", "LEYLAND", "LEYTON",
    "LEYTONSTONE", "LICHFIELD", "LIGHTWATER", "LIMAVADY", "LIMEHOUSE", "LINLITHGOW", "LINWOOD", "LIPHOOK",
    "LISKEARD", "LITHERLAND", "LITTLE BOOKHAM", "LITTLE BRAY", "LITTLE HULTON", "LITTLE LEVER", "LITTLE VENICE",
    "LITTLEBOROUGH", "LITTLEHAMPTON", "LITTLEPORT", "LIVERSEDGE", "LIVINGSTON", "LLANDAFF", "LLANDRINDOD WELLS",
    "LLANDUDNO", "LLANELLI", "LLANHARAN", "LLANTRISANT", "LLANTWIT MAJOR", "LOANHEAD", "LOCHARBRIGGS", "LOCHGELLY",
    "LOFTHOUSE", "LONDON COLNEY", "LONDONDERRY COUNTY BOROUGH", "LONG ASHTON", "LONG DITTON", "LONG EATON",
    "LONGDENDALE", "LONGFIELD", "LONGFORD", "LONGRIDGE", "LONGSIGHT", "LONGTON", "LOSSIEMOUTH", "LOUGHBOROUGH",
    "LOUGHREA", "LOUGHTON", "LOUTH", "LOWER EARLEY", "LOWESTOFT", "LUCAN", "LUDLOW", "LUTTERWORTH", "LYDNEY",
    "LYMINGTON", "LYNEHAM", "LYTHAM ST ANNES", "MABLETHORPE", "MACCLESFIELD", "MAESTEG", "MAGHERAFELT", "MAGHULL",
    "MAGOR", "MAIDA HILL", "MAIDENBOWER", "MAIDENHEAD", "MALAHIDE", "MALDON", "MALLOW", "MALMESBURY", "MALTBY",
    "MALTON", "MANCHESTER CITY CENTRE", "MANGOTSFIELD", "MANNINGTREE", "MANOR PARK", "MANSFIELD",
    "MANSFIELD WOODHOUSE", "MANSTON", "MARCHWOOD", "MARGATE", "MARINO", "MARKET DEEPING", "MARKET DRAYTON",
    "MARKET HARBOROUGH", "MARKET WARSOP", "MARKET WEIGHTON", "MARLBOROUGH", "MARPLE", "MARSHALSWICK",
    "MARSKE BY THE SEA", "MARYPORT", "MATLOCK", "MAYFIELD", "MAYNOOTH", "MEASHAM", "MEIKLE EARNOCK", "MELKSHAM",
    "MELTHAM", "MELTHAM MILLS", "MELTON MOWBRAY", "MENDIP", "MERIDEN", "MERROW", "MERSTHAM", "MERTHYR TYDFIL",
    "METHIL", "MEXBOROUGH", "MIDDLETON", "MIDDLEWICH", "MIDHURST", "MIDLETON", "MIDSOMER NORTON", "MILDENHALL",
    "MILFORD", "MILFORD HAVEN", "MILL END", "MILLOM", "MILNGAVIE", "MILNROW", "MINEHEAD", "MIRFIELD", "MITCHAM",
    "MONAGHAN", "MONIFIETH", "MONKHAMS", "MONKSTOWN", "MONMOUTH", "MONTROSE", "MOODIESBURN", "MOOR PARK", "MORDEN",
    "MORECAMBE", "MORETON", "MORPETH", "MORTLAKE", "MOSSEND", "MOSSLEY", "MOSSLEY HILL", "MOTHERWELL", "MOTTINGHAM",
    "MOUNT MERRION", "MOUNTAIN ASH", "MOUNTSORREL", "MURTON", "MUSSELBURGH", "MUSWELL HILL", "NAILSEA",
    "NAILSWORTH", "NAIRN", "NANTWICH", "NARBOROUGH", "NAVAN", "NEATH", "NEILSTON", "NELSON", "NENAGH",
    "NENAGH BRIDGE", "NESTON", "NETHER EDGE", "NETHERLEY", "NETLEY", "NEW ALRESFORD", "NEW BARNET", "NEW BASFORD",
    "NEW CROSS", "NEW FERRY", "NEW MALDEN", "NEW MILL", "NEW MILLS", "NEW MILTON", "NEW ROMNEY", "NEW ROSS",
    "NEW STEVENSTON", "NEWARK ON TRENT", "NEWARTHILL", "NEWBIGGIN BY THE SEA", "NEWBRIDGE", "NEWBURN", "NEWBURY",
    "NEWBURY PARK", "NEWCASTLE UNDER LYME", "NEWCASTLE WEST", "NEWHAVEN", "NEWMAINS", "NEWMARKET",
    "NEWPORT PAGNELL", "NEWQUAY", "NEWRY", "NEWTON ABBOT", "NEWTON AYCLIFFE", "NEWTON LE WILLOWS", "NEWTON MEARNS",
    "NEWTOWN", "NEWTOWN TRIM", "NEWTOWNABBEY", "NEWTOWNARDS", "NORBITON", "NORBURY", "NORRIS GREEN", "NORTH ANSTON",
    "NORTH BADDESLEY", "NORTH BERWICK", "NORTH FERRIBY", "NORTH SHIELDS", "NORTH WALSHAM", "NORTH WATFORD",
    "NORTHALLERTON", "NORTHAM", "NORTHOLT", "NORTHUMBERLAND PARK", "NORTHWICH", "NORTHWOOD", "NORTHWOOD HILLS",
    "NORTON CANES", "NOTTING HILL", "OADBY", "OAKENGATES", "OAKHAM", "OKEHAMPTON", "OLD HARLOW", "OLD SWAN",
    "OLD TRAFFORD", "OLD WINDSOR", "OLDBAWN", "OLDBURY", "OLNEY", "OMAGH", "ORMSKIRK", "ORPINGTON", "OSSETT",
    "OSTERLEY", "OSWESTRY", "OTFORD", "OTLEY", "OUNDLE", "OXTED", "PADDOCK WOOD", "PADIHAM", "PAIGNTON",
    "PALMERS GREEN", "PALMERSTOWN", "PARKSTONE", "PARTINGTON", "PASSAGE WEST", "PEACEHAVEN", "PEASEDOWN SAINT JOHN",
    "PEEBLES", "PELSALL", "PELTON", "PEMBROKE", "PEMBROKE DOCK", "PEMBURY", "PENARTH", "PENCOED", "PENICUIK",
    "PENISTONE", "PENKRIDGE", "PENRITH", "PENRYN", "PENTRE", "PENZANCE", "PERRY VALE", "PERSHORE", "PETERHEAD",
    "PETERLEE", "PETERSFIELD", "PICKERING", "PIMLICO", "PINKNEYS GREEN", "PINNER", "PINXTON", "PITSEA", "PLUMSTEAD",
    "PLYMPTON", "PLYMSTOCK", "POCKLINGTON", "POLESWORTH", "POLMONT", "PONDERS END", "PONTARDDULAIS", "PONTEFRACT",
    "PONTELAND", "PONTYCLUN", "PONTYPOOL", "PONTYPRIDD", "POPLAR", "PORINGLAND", "PORT GLASGOW", "PORTADOWN",
    "PORTARLINGTON", "PORTHCAWL", "PORTISHEAD", "PORTLAND", "PORTLAOISE", "PORTLETHEN", "PORTMARNOCK", "PORTRUSH",
    "PORTSLADE", "PORTSTEWART", "PORTSWOOD", "POTTERS BAR", "POULTON LE FYLDE", "POYNTON", "PREESALL", "PRENTON",
    "PRESCOT", "PRESTATYN", "PRESTONPANS", "PRESTWICH", "PRESTWICK", "PRIMROSE PLACE", "PRINCES RISBOROUGH",
    "PRUDHOE", "PUDSEY", "PURFLEET ON THAMES", "PURLEY", "PUTNEY", "PYRFORD", "QUEENS PARK", "QUEENSBURY",
    "QUEENSFERRY", "QUEENSTOWN", "QUORNDON", "RADCLIFFE", "RADCLIFFE ON TRENT", "RADLETT", "RADSTOCK", "RAHENY",
    "RAINFORD", "RAINHAM", "RAINHILL", "RAINWORTH", "RAMSBOTTOM", "RAMSEY", "RAMSGATE", "RANDALSTOWN", "RASTRICK",
    "RATHFARNHAM", "RATHGAR", "RATHMINES", "RATOATH", "RAUNDS", "RAVENSHEAD", "RAWMARSH", "RAWTENSTALL", "RAYLEIGH",
    "REDBOURN", "REDCAR", "REDDITCH", "REDHILL", "REDRUTH", "REGENTS PARK", "REIGATE", "RENFREW", "RETFORD",
    "RHIWBINA", "RHONDDA", "RHOOSE", "RHOSLLANNERCHRUGOG", "RHYMNEY", "RICKMANSWORTH", "RINGSEND", "RINGWOOD",
    "RIPLEY", "RIPON", "RISCA", "RISHTON", "ROCHESTER", "ROCHFORD", "ROEHAMPTON", "ROMSEY", "ROSCOMMON", "ROSCREA",
    "ROSS ON WYE", "ROSSENDALE", "ROSYTH", "ROTHERHITHE", "ROTHWELL", "ROTTINGDEAN", "ROWLANDS GILL",
    "ROYAL LEAMINGTON SPA", "ROYAL TUNBRIDGE WELLS", "ROYAL WOOTTON BASSETT", "ROYSTON", "ROYTON", "RUDDINGTON",
    "RUGELEY", "RUISLIP", "RUISLIP MANOR", "RUNCORN", "RUSHDEN", "RUSKINGTON", "RUSTINGTON", "RUTHERGLEN", "RUTHIN",
    "RYHILL", "RYHOPE", "RYTON", "SACRISTON", "SADDLEWORTH", "SAFFRON WALDEN", "SAINT ANDREWS", "SAINT BLAZEY",
    "SAINT IVES", "SAINT LEONARDS ON SEA", "SAINT NEOTS", "SAINT PETERS", "SALLINS", "SALLYNOGGIN", "SALTAIRE",
    "SALTASH", "SALTBURN BY THE SEA", "SALTCOATS", "SANDBACH", "SANDERSTEAD", "SANDHURST", "SANDOWN", "SANDY",
    "SANDYFORD", "SANDYMOUNT", "SAUCHIE", "SAWBRIDGEWORTH", "SAWSTON", "SAWTRY", "SCALBY", "SCONE", "SCUNTHORPE",
    "SEAFORD", "SEATON", "SEATON DELAVAL", "SELKIRK", "SELSEY", "SEVEN SISTERS", "SEVENOAKS", "SHADWELL",
    "SHAFTESBURY", "SHANKILL", "SHANKLIN", "SHANNON", "SHEERNESS", "SHEFFORD", "SHELLEY", "SHENFIELD",
    "SHEPHERDS BUSH", "SHEPLEY", "SHEPPERTON", "SHEPSHED", "SHEPTON MALLET", "SHERBORNE", "SHERBURN IN ELMET",
    "SHERINGHAM", "SHEVINGTON", "SHIFNAL", "SHILDON", "SHIPLEY", "SHIPSTON ON STOUR", "SHIREBROOK",
    "SHOREHAM BY SEA", "SHORTLANDS", "SHOTTS", "SIDCUP", "SIDMOUTH", "SILEBY", "SILSDEN", "SINFIN", "SITTINGBOURNE",
    "SKEGNESS", "SKELMERSDALE", "SKELTON", "SKERRIES", "SKIPTON", "SLEAFORD", "SLIGO", "SMETHWICK", "SNARESBROOK",
    "SNODLAND", "SOHAM", "SOPWELL", "SOUTH BENFLEET", "SOUTH CROYDON", "SOUTH DUBLIN", "SOUTH ELMSALL",
    "SOUTH HAYLING", "SOUTH MOLTON", "SOUTH NORWOOD", "SOUTH OCKENDON", "SOUTH RUISLIP", "SOUTH SHIELDS",
    "SOUTHALL", "SOUTHAM", "SOUTHGATE", "SOUTHPORT", "SOUTHSEA", "SOUTHWATER", "SOUTHWELL", "SOWERBY BRIDGE",
    "SPALDING", "SPEKE", "SPENNYMOOR", "SPITALFIELDS", "ST ANDREWS", "ST ANNS", "ST AUSTELL", "ST BLAZEY",
    "ST HELENS", "ST HELIER", "ST IVES", "ST JAMESS", "ST LEONARDS", "ST LEONARDS ON SEA", "ST NEOTS", "ST PETERS",
    "STAFFORD", "STAINFORTH", "STAKEFORD", "STALYBRIDGE", "STAMFORD", "STAMFORD HILL", "STANFORD LE HOPE",
    "STANSTED MOUNTFITCHET", "STANWELL", "STAPLEFORD", "STAPLEHURST", "STAVELEY", "STENHOUSEMUIR", "STEPNEY",
    "STEPPS", "STEVENSTON", "STEWARTON", "STEYNING", "STOCKSBRIDGE", "STOCKTON HEATH", "STOCKTON ON TEES",
    "STOKE GIFFORD", "STONE", "STONEHAVEN", "STONEHOUSE", "STORNOWAY", "STORRINGTON", "STOTFOLD", "STOURBRIDGE",
    "STOURPORT ON SEVERN", "STOWMARKET", "STRABANE", "STRANRAER", "STRATHAVEN", "STREATHAM", "STREETLY",
    "STRENSALL", "STRETFORD", "STROOD", "STROUD", "STROUD GREEN", "STUDLEY", "STURRY", "SUDBURY",
    "SUNBURY ON THAMES", "SUNNINGHILL", "SURBITON", "SUTTON COLDFIELD", "SUTTON IN ASHFIELD", "SWADLINCOTE",
    "SWAFFHAM", "SWANAGE", "SWANLEY", "SWANSCOMBE", "SWINTON", "SWORDS", "SYSTON", "TADCASTER", "TADLEY",
    "TADWORTH", "TALLAGHT", "TARLETON", "TAVISTOCK", "TEDDINGTON", "TEIGNMOUTH", "TEMPLEOGUE", "TENTERDEN",
    "TERENURE", "TETBURY", "TEWKESBURY", "THAME", "THAMES DITTON", "THAMESMEAD", "THATCHAM", "THE BOLDONS",
    "THETFORD", "THIRSK", "THORNABY ON TEES", "THORNBURY", "THORNE", "THORNHILL", "THORNTON", "THORNTON CLEVELEYS",
    "THORNTON HEATH", "THORPE", "THORPE HAMLET", "THRAPSTON", "THURLES", "THURSO", "TIDWORTH", "TILBURY",
    "TILLICOULTRY", "TIMPERLEY", "TIPTON", "TIPTREE", "TITCHFIELD", "TIVERTON", "TODMORDEN", "TOLWORTH",
    "TONBRIDGE", "TONYPANDY", "TONYREFAIL", "TOOTING", "TORPOINT", "TOTNES", "TOTON", "TOTTENHAM", "TOTTENHAM HALE",
    "TOTTERIDGE", "TOTTINGTON", "TOTTON", "TOWCESTER", "TOWNSEND", "TRA MHOR", "TRALEE", "TRANENT", "TREDEGAR",
    "TREHARRIS", "TREORCHY", "TRING", "TROON", "TROWBRIDGE", "TULLAMORE", "TULLIBODY", "TUNSTALL", "TURRIFF",
    "TWYFORD", "TYLDESLEY", "TYNEMOUTH", "UCKFIELD", "UDDINGSTON", "ULVERSTON", "UPMINSTER", "UPPER NORWOOD",
    "UPPERMILL", "UPTON", "UPTON LEA", "URMSTON", "USHAW MOOR", "UTTOXETER", "VALE OF LEVEN", "VENTNOR", "VERWOOD",
    "VIEWPARK", "VINCENT SQUARE", "WADEBRIDGE", "WALES", "WALKDEN", "WALKINSTOWN", "WALLASEY", "WALLINGFORD",
    "WALLINGTON", "WALLSEND", "WALTHAM", "WALTHAM ABBEY", "WALTHAM CROSS", "WALTON ON THAMES", "WALTON ON THE NAZE",
    "WANSTEAD", "WANTAGE", "WARDLE", "WAREHAM", "WARLINGHAM", "WARMINSTER", "WARRENPOINT", "WARSOP",
    "WASHINGBOROUGH", "WASHINGTON", "WASHWOOD HEATH", "WATER EATON", "WATERBEACH", "WATERFORD", "WATERLOOVILLE",
    "WATH UPON DEARNE", "WATTON", "WAVERTREE", "WEALDSTONE", "WEAVERHAM", "WEDNESBURY", "WEDNESFIELD",
    "WELLESBOURNE", "WELLESBOURNE MOUNTFORD", "WELLING", "WELLINGBOROUGH", "WELLINGTON", "WELSHPOOL",
    "WELWYN GARDEN CITY", "WENDOVER", "WEST BRIDGFORD", "WEST BROMWICH", "WEST BYFLEET", "WEST CLANDON",
    "WEST DERBY", "WEST DRAYTON", "WEST EALING", "WEST END", "WEST END OF LONDON", "WEST HALLAM", "WEST HAM",
    "WEST KINGSDOWN", "WEST KIRBY", "WEST MERSEA", "WEST MOLESEY", "WEST THURROCK", "WEST WATFORD", "WEST WICKHAM",
    "WESTBOURNE", "WESTBURY", "WESTERGATE", "WESTGATE ON SEA", "WESTHILL", "WESTHOUGHTON", "WESTON SUPER MARE",
    "WESTPORT", "WETHERBY", "WEXFORD", "WEYBRIDGE", "WEYMOUTH", "WHALEY BRIDGE", "WHEATLEY", "WHETSTONE",
    "WHICKHAM", "WHISTON", "WHITBURN", "WHITCHURCH", "WHITECHAPEL", "WHITEFIELD", "WHITEHAVEN", "WHITLEY BAY",
    "WHITSTABLE", "WHITTLESEY", "WHITWORTH", "WICKFORD", "WICKLOW", "WIDEOPEN", "WIDNES", "WIGSTON MAGNA", "WIGTON",
    "WILLENHALL", "WILLESDEN", "WILLINGTON", "WILMSLOW", "WILSDEN", "WIMBLEDON PARK", "WIMBORNE MINSTER",
    "WINCANTON", "WINDERMERE", "WINGATE", "WINGERWORTH", "WINSFORD", "WIRKSWORTH", "WISBECH", "WISHAW", "WITHAM",
    "WITHERNSEA", "WITLEY", "WITNEY", "WIVENHOE", "WOBURN SANDS", "WOKINGHAM", "WOMBOURNE", "WOMBWELL",
    "WOOD GREEN", "WOODBRIDGE", "WOODFORD GREEN", "WOODSIDE", "WOOLSTON", "WOOLTON", "WORCESTER PARK", "WORKINGTON",
    "WORKSOP", "WORLDS END", "WORTHING", "WOTTON UNDER EDGE", "WROUGHTON", "YAPTON", "YATELEY", "YATTON", "YAXLEY",
    "YEADON", "YEOVIL", "YOUGHAL", "YSTALYFERA",
)

# packages/statement/src/normalise.ts
TRAILING_CODES = (
    "BCC", "CLP", "DDR", "POS", "VIS", "DEB", "CPT", "BGC", "STO", "FPO", "FPI", "TFR", "CR", "DR", "GBP", "EUR",
    "RECEIPT",
)
CONNECTOR_BEFORE = re.compile(r"(?:^|\s)(?:OF|AIR|AND|&|THE|DE|DU|LA|LE|VON|VAN)\Z", re.A)
PREFIX_RE = re.compile(
    r"^(?:DIRECT\s+DEBIT\s+PAYMENT\s+TO|CONTACTLESS\s+PAYMENT\s+TO|DEBIT\s+CARD\s+PAYMENT\s+TO"
    r"|CONTACTLESS\s+PAYMENT|DEBIT\s+CARD\s+PAYMENT|STANDING\s+ORDER\s+TO|FASTER\s+PAYMENT\s+TO|BILL\s+PAYMENT\s+TO"
    r"|CARD\s+PAYMENT\s+TO|DIRECT\s+DEBIT\s+TO|STANDING\s+ORDER|FASTER\s+PAYMENT|CARD\s+PURCHASE|VISA\s+PURCHASE"
    r"|CARD\s+PAYMENT|DIRECT\s+DEBIT|BILL\s+PAYMENT|CONTACTLESS|PAYMENT\s+TO|GOOGLE\s+PAY|APPLE\s+PAY|PURCHASE|VISA"
    r"|POS|CRD|DDR|D/D|S/O|STO|FPI|FPO|VIS|BGC|DEB|CPT|TFR|BBP|EFT|OTR|DD|SO|BP)(?=\Z|[\s,:;\-])[\s,:;\-]*",
    re.A,
)
PADDED_COUNTRY_RE = re.compile(
    r"\s{2,}(?:UNITED\s+STATES\s+OF\s+AMERICA|UNITED\s+KINGDOM|UNITED\s+STATES|GREAT\s+BRITAIN|ISLE\s+OF\s+MAN"
    r"|NETHERLANDS|SWITZERLAND|LUXEMBOURG|AUSTRALIA|GUERNSEY|PORTUGAL|IRELAND|GERMANY|BELGIUM|DENMARK|FINLAND"
    r"|AUSTRIA|SWEDEN|NORWAY|POLAND|CANADA|FRANCE|JERSEY|SPAIN|ITALY|GBR|USA|IRL|LUX|NLD|DEU|FRA|ESP|ITA|BEL|PRT"
    r"|CHE|SWE|DNK|NOR|FIN|POL|AUT|CAN|AUS|JEY|GGY|IMN|GB|UK|IE|NL|LU|FR|US|DE|ES|IT|BE|AT|CH|SE|DK|NO|FI|PL|CZ|GR"
    r"|PT|CA|AU|JE|GG|IM)\s*\Z",
    re.A,
)
TRAILING_COUNTRY_RE = re.compile(
    r"\s(?:UNITED\s+STATES\s+OF\s+AMERICA|UNITED\s+KINGDOM|UNITED\s+STATES|GREAT\s+BRITAIN|ISLE\s+OF\s+MAN"
    r"|NETHERLANDS|SWITZERLAND|LUXEMBOURG|AUSTRALIA|GUERNSEY|PORTUGAL|IRELAND|GERMANY|BELGIUM|DENMARK|FINLAND"
    r"|AUSTRIA|SWEDEN|NORWAY|POLAND|CANADA|FRANCE|JERSEY|SPAIN|ITALY|GBR|USA|IRL|LUX|NLD|DEU|FRA|ESP|ITA|BEL|PRT"
    r"|CHE|SWE|DNK|NOR|FIN|POL|AUT|CAN|AUS|JEY|GGY|IMN|GB|UK|IE|NL|LU|FR)\Z",
    re.A,
)
TRAILING_PLACE_RE = re.compile(
    r"\s(?:KINGSTON\s+UPON\s+THAMES|NEWCASTLE\s+UPON\s+TYNE|STRATFORD\s+UPON\s+AVON|SOUTHEND\s+ON\s+SEA"
    r"|STOKE\s+ON\s+TRENT|STOKE-ON-TRENT|LEAMINGTON\s+SPA|WOLVERHAMPTON|MILTON\s+KEYNES|MIDDLESBROUGH"
    r"|SAN\s+FRANCISCO|PETERBOROUGH|HIGH\s+WYCOMBE|HUDDERSFIELD|CANARY\s+WHARF|SOUTHAMPTON|NORTHAMPTON|BOURNEMOUTH"
    r"|BASINGSTOKE|SCARBOROUGH|WESTMINSTER|HAMMERSMITH|WALTHAMSTOW|LOS\s+ANGELES|MANCHESTER|BIRMINGHAM|NOTTINGHAM"
    r"|PORTSMOUTH|SUNDERLAND|GLOUCESTER|CHELTENHAM|CANTERBURY|CHELMSFORD|COLCHESTER|WARRINGTON|DARLINGTON"
    r"|SHREWSBURY|WINCHESTER|KENSINGTON|SHOREDITCH|COPENHAGEN|LUXEMBOURG|EDINBURGH|LIVERPOOL|SHEFFIELD|NEWCASTLE"
    r"|LEICESTER|CAMBRIDGE|GUILDFORD|MAIDSTONE|STEVENAGE|ST\s+ALBANS|AYLESBURY|STOCKPORT|BLACKPOOL|BLACKBURN"
    r"|WAKEFIELD|DONCASTER|ROTHERHAM|LANCASTER|HARROGATE|WORCESTER|SALISBURY|INVERNESS|ISLINGTON|GREENWICH"
    r"|SOUTHWARK|WIMBLEDON|STRATFORD|AMSTERDAM|FRANKFURT|BARCELONA|BRUXELLES|STOCKHOLM|COVENTRY|BRADFORD|PLYMOUTH"
    r"|ABERDEEN|BRIGHTON|SOUTHEND|BASILDON|ROCHDALE|BARNSLEY|CARLISLE|HEREFORD|SOLIHULL|NUNEATON|STIRLING|LEWISHAM"
    r"|KINGSTON|RICHMOND|WOOLWICH|HOUNSLOW|UXBRIDGE|HEATHROW|LIMERICK|MUENCHEN|BRUSSELS|HELSINKI|BUDAPEST"
    r"|NEW\s+YORK|GLASGOW|BRISTOL|CARDIFF|BELFAST|READING|NORWICH|SWANSEA|PRESTON|SWINDON|IPSWICH|WATFORD|CRAWLEY"
    r"|BEDFORD|LINCOLN|CHESTER|SALFORD|BURNLEY|TELFORD|WALSALL|BANBURY|TAUNTON|TORQUAY|PAISLEY|NEWPORT|WREXHAM"
    r"|LISBURN|HACKNEY|LAMBETH|BRIXTON|CLAPHAM|CROYDON|CHELSEA|WEMBLEY|ROMFORD|BROMLEY|ENFIELD|PECKHAM|GATWICK"
    r"|HAMBURG|SEATTLE|LONDON|DUNDEE|OXFORD|EXETER|SLOUGH|WOKING|BOLTON|OLDHAM|DURHAM|DUDLEY|CAMDEN|FULHAM|EALING"
    r"|ILFORD|SUTTON|HARROW|BARNET|DUBLIN|GALWAY|BERLIN|MUNICH|MADRID|MALAGA|LISBON|LISBOA|MILANO|VIENNA|PRAGUE"
    r"|ZURICH|GENEVA|WARSAW|ATHENS|LEEDS|DERBY|LUTON|POOLE|WIGAN|RUGBY|TRURO|PERTH|DERRY|PARIS|PORTO|MILAN|PRAHA"
    r"|HOVE|YORK|HULL|CORK|LYON|ROME|WIEN|OSLO)\Z",
    re.A,
)
MORE_PLACE_RE = re.compile(
    r"\s(?:KNIGHTSBRIDGE\s+AND\s+BELGRAVIA|LONDONDERRY\s+COUNTY\s+BOROUGH|BLAIRGOWRIE\s+AND\s+RATTRAY"
    r"|BASFORD\s+STOKE\s+ON\s+TRENT|LETCHWORTH\s+GARDEN\s+CITY|MANCHESTER\s+CITY\s+CENTRE|WELLESBOURNE\s+MOUNTFORD"
    r"|LEICESTER\s+FOREST\s+EAST|ROYAL\s+TUNBRIDGE\s+WELLS|ROYAL\s+WOOTTON\s+BASSETT|SAINT\s+LEONARDS\s+ON\s+SEA"
    r"|STANSTED\s+MOUNTFITCHET|AMERSHAM\s+ON\s+THE\s+HILL|ASHTON\s+IN\s+MAKERFIELD|BURLEY\s+IN\s+WHARFEDALE"
    r"|CHALFONT\s+SAINT\s+PETER|NEWBIGGIN\s+BY\s+THE\s+SEA|NEWCASTLE\s+UNDER\s+LYME|PEASEDOWN\s+SAINT\s+JOHN"
    r"|ROYAL\s+LEAMINGTON\s+SPA|CITY\s+OF\s+WESTMINSTER|ELLESMERE\s+PORT\s+TOWN|MANSFIELD\s+WOODHOUSE"
    r"|NORTHUMBERLAND\s+PARK|SALTBURN\s+BY\s+THE\s+SEA|STOURPORT\s+ON\s+SEVERN|AN\s+MUILEANN\s+GCEARR"
    r"|BARTON\s+UPON\s+HUMBER|BERWICK\s+UPON\s+TWEED|BIRCHINGTON\s+ON\s+SEA|BOLTON\s+UPON\s+DEARNE"
    r"|BUDLEIGH\s+SALTERTON|CATTERICK\s+GARRISON|CHAPEL\s+EN\s+LE\s+FRITH|DONINGTON\s+LE\s+HEATH"
    r"|HARROW\s+ON\s+THE\s+HILL|HOUGHTON\s+LE\s+SPRING|INCE\s+IN\s+MAKERFIELD|KINGSTON\s+UPON\s+HULL"
    r"|KIRKBY\s+IN\s+ASHFIELD|PRINCES\s+RISBOROUGH|PURFLEET\s+ON\s+THAMES|RADCLIFFE\s+ON\s+TRENT|RHOSLLANNERCHRUGOG"
    r"|ST\s+LEONARDS\s+ON\s+SEA|SUTTON\s+IN\s+ASHFIELD|THORNTON\s+CLEVELEYS|WALTON\s+ON\s+THE\s+NAZE"
    r"|WELWYN\s+GARDEN\s+CITY|WEST\s+END\s+OF\s+LONDON|ASHBY\s+DE\s+LA\s+ZOUCH|ASHTON\s+UNDER\s+LYNE"
    r"|BARROW\s+IN\s+FURNESS|BISHOPS\s+STORTFORD|BRACEBRIDGE\s+HEATH|BURNHAM\s+ON\s+CROUCH|BURTON\s+UPON\s+TRENT"
    r"|CHALFONT\s+ST\s+GILES|CHESTER\s+LE\s+STREET|DALTON\s+IN\s+FURNESS|KEMPSTON\s+HARDWICK|KIBWORTH\s+HARCOURT"
    r"|LEE\s+ON\s+THE\s+SOLENT|LLANDRINDOD\s+WELLS|MARKET\s+HARBOROUGH|MARSKE\s+BY\s+THE\s+SEA"
    r"|NEWTON\s+LE\s+WILLOWS|SHERBURN\s+IN\s+ELMET|SHIPSTON\s+ON\s+STOUR|SUNBURY\s+ON\s+THAMES"
    r"|WESTON\s+SUPER\s+MARE|WOTTON\s+UNDER\s+EDGE|ADWICK\s+LE\s+STREET|BARROW\s+UPON\s+SOAR|BRADFORD\s+ON\s+AVON"
    r"|BROUGHTON\s+ASTLEY|CASTLE\s+DONINGTON|CHADWELL\s+ST\s+MARY|CHAFFORD\s+HUNDRED|CHIPPING\s+SODBURY"
    r"|CLAPHAM\s+JUNCTION|CLAYTON\s+LE\s+MOORS|CLAYTON\s+LE\s+WOODS|GORLESTON\s+ON\s+SEA|GREAT\s+TORRINGTON"
    r"|HENLEY\s+ON\s+THAMES|INGLEBY\s+GREENHOW|LEIGHTON\s+BUZZARD|LEVERSTOCK\s+GREEN|POULTON\s+LE\s+FYLDE"
    r"|STANFORD\s+LE\s+HOPE|STOCKTON\s+ON\s+TEES|SUTTON\s+COLDFIELD|THORNABY\s+ON\s+TEES|WALTON\s+ON\s+THAMES"
    r"|WATH\s+UPON\s+DEARNE|WIMBORNE\s+MINSTER|BIDFORD\s+ON\s+AVON|BISHOP\s+AUCKLAND|BISHOPS\s+WALTHAM"
    r"|BLANDFORD\s+FORUM|BLAYDON\s+ON\s+TYNE|BOLTON\s+LE\s+SANDS|BRIDGE\s+OF\s+ALLAN|BURY\s+ST\s+EDMUNDS"
    r"|CARPENDERS\s+PARK|CARRICK\s+ON\s+SUIR|CHAPEL\s+ALLERTON|CHIPPING\s+NORTON|FLACKWELL\s+HEATH"
    r"|GREAT\s+MISSENDEN|HEMEL\s+HEMPSTEAD|IRTHLINGBOROUGH|KINSEALY\s+DRINAN|LEAVESDEN\s+GREEN|LYTHAM\s+ST\s+ANNES"
    r"|MARKET\s+WEIGHTON|MIDSOMER\s+NORTON|NEWARK\s+ON\s+TRENT|NEWPORT\s+PAGNELL|NEWTON\s+AYCLIFFE"
    r"|NORTH\s+BADDESLEY|NORTHWOOD\s+HILLS|SHOREHAM\s+BY\s+SEA|WESTGATE\s+ON\s+SEA|ABBOTS\s+LANGLEY"
    r"|ANNFIELD\s+PLAIN|BALSALL\s+COMMON|BARNARD\s+CASTLE|BERNARDS\s+HEATH|BEXHILL\s+ON\s+SEA|BISHOPS\s+CLEEVE"
    r"|BLANCHARDSTOWN|BUCKHURST\s+HILL|BURNHAM\s+ON\s+SEA|BURTON\s+LATIMER|CAISTER\s+ON\s+SEA|CARRICKMACROSS"
    r"|CHADWELL\s+HEATH|CHARLTON\s+KINGS|CHELMSLEY\s+WOOD|CHERRY\s+ORCHARD|CHISWELL\s+GREEN|CITY\s+OF\s+LONDON"
    r"|CLACTON\s+ON\s+SEA|CRYSTAL\s+PALACE|DOWNHAM\s+MARKET|EAST\s+GRINSTEAD|EAST\s+WITTERING|FRINTON\s+ON\s+SEA"
    r"|GERRARDS\s+CROSS|GREAT\s+WAKERING|GREAT\s+YARMOUTH|HAUGHTON\s+GREEN|HAYLING\s+ISLAND|HAYWARDS\s+HEATH"
    r"|HETTON\s+LE\s+HOLE|HIGHAM\s+FERRERS|HOYLAND\s+NETHER|HURSTPIERPOINT|LANCASTER\s+GATE|LITTLE\s+BOOKHAM"
    r"|LLANTWIT\s+MAJOR|MARKET\s+DEEPING|MARKET\s+DRAYTON|MEIKLE\s+EARNOCK|MELTON\s+MOWBRAY|MERTHYR\s+TYDFIL"
    r"|NEW\s+STEVENSTON|NEWCASTLE\s+WEST|PINKNEYS\s+GREEN|PRIMROSE\s+PLACE|SAFFRON\s+WALDEN|SAWBRIDGEWORTH"
    r"|SEATON\s+DELAVAL|SHEPHERDS\s+BUSH|SHEPTON\s+MALLET|SOUTH\s+BENFLEET|SOUTH\s+OCKENDON|SOWERBY\s+BRIDGE"
    r"|STOCKTON\s+HEATH|THORNTON\s+HEATH|TOTTENHAM\s+HALE|VINCENT\s+SQUARE|WASHINGBOROUGH|WASHWOOD\s+HEATH"
    r"|WELLINGBOROUGH|WEST\s+BRIDGFORD|WEST\s+KINGSDOWN|WIMBLEDON\s+PARK|WOODFORD\s+GREEN|WORCESTER\s+PARK"
    r"|APPLEY\s+BRIDGE|BARTLEY\s+GREEN|BARTON\s+ON\s+SEA|BETHNAL\s+GREEN|BILLINGSHURST|BRIERLEY\s+HILL"
    r"|BRIGHTLINGSEA|CANFORD\s+HEATH|CANVEY\s+ISLAND|CARRICKFERGUS|CARRIGTWOHILL|CHEADLE\s+HULME|CHEETHAM\s+HILL"
    r"|CHURCH\s+STREET|COUNTESTHORPE|CRADLEY\s+HEATH|CROXLEY\s+GREEN|DROICHEAD\s+NUA|DUN\s+LAOGHAIRE"
    r"|EALING\s+COMMON|EAST\s+KILBRIDE|FARNHAM\s+ROYAL|FORDINGBRIDGE|FRIERN\s+BARNET|FRIMLEY\s+GREEN"
    r"|FURNACE\s+GREEN|GODMANCHESTER|GOLDERS\s+GREEN|GOSSOPS\s+GREEN|GREAT\s+BOOKHAM|GREAT\s+GONERBY"
    r"|GREAT\s+HARWOOD|GREAT\s+MALVERN|HAVERFORDWEST|HIGH\s+BLANTYRE|HOLMES\s+CHAPEL|INVERKEITHING"
    r"|ISLE\s+OF\s+ARRAN|ISLE\s+OF\s+LEWIS|KIDDERMINSTER|KINGS\s+LANGLEY|KINGSTEIGNTON|KIRKINTILLOCH|KNARESBOROUGH"
    r"|LANGLEY\s+GREEN|LITTLE\s+HULTON|LITTLE\s+VENICE|LITTLEBOROUGH|LITTLEHAMPTON|LONDON\s+COLNEY|MARKET\s+WARSOP"
    r"|MELTHAM\s+MILLS|MILFORD\s+HAVEN|MOUNT\s+MERRION|NENAGH\s+BRIDGE|NEW\s+ALRESFORD|NEWTON\s+MEARNS"
    r"|NORTH\s+BERWICK|NORTH\s+FERRIBY|NORTH\s+SHIELDS|NORTH\s+WALSHAM|NORTH\s+WATFORD|NORTHALLERTON"
    r"|PALMERS\s+GREEN|PEMBROKE\s+DOCK|PONTARDDULAIS|PORTARLINGTON|RICKMANSWORTH|ROWLANDS\s+GILL|RUISLIP\s+MANOR"
    r"|SAINT\s+ANDREWS|SEVEN\s+SISTERS|SITTINGBOURNE|SOUTH\s+CROYDON|SOUTH\s+ELMSALL|SOUTH\s+HAYLING"
    r"|SOUTH\s+NORWOOD|SOUTH\s+RUISLIP|SOUTH\s+SHIELDS|STAMFORD\s+HILL|STENHOUSEMUIR|STOKE\s+GIFFORD"
    r"|THAMES\s+DITTON|THORPE\s+HAMLET|UPPER\s+NORWOOD|VALE\s+OF\s+LEVEN|WALTHAM\s+ABBEY|WALTHAM\s+CROSS"
    r"|WATERLOOVILLE|WEST\s+BROMWICH|WEST\s+THURROCK|WHALEY\s+BRIDGE|WIGSTON\s+MAGNA|ACOCKS\s+GREEN|ATTLEBOROUGH"
    r"|AUCHTERARDER|BALLINCOLLIG|BALLYNAHINCH|BARNOLDSWICK|BAYSTON\s+HILL|BEACONSFIELD|BELSIZE\s+PARK"
    r"|BENNETTS\s+END|BISHOPBRIGGS|BISHOPSWORTH|BOGNOR\s+REGIS|BRITON\s+FERRY|BRIXTON\s+HILL|BURGESS\s+HILL"
    r"|CANNING\s+TOWN|CHESTERFIELD|CHRISTCHURCH|CLAYTON\s+WEST|CLEATOR\s+MOOR|CLUAIN\s+MEALA|CROFTON\s+PARK"
    r"|DENTON\s+HOLME|EAGLESCLIFFE|EARL\s+SHILTON|EARLS\s+BARTON|EAST\s+DEREHAM|EAST\s+DULWICH|EAST\s+HORSLEY"
    r"|EAST\s+MOLESEY|EAST\s+TILBURY|EMERSON\s+PARK|ENFIELD\s+LOCK|ENFIELD\s+TOWN|FEATHERSTONE|FORT\s+WILLIAM"
    r"|GAINSBOROUGH|GREAT\s+DUNMOW|GREAT\s+SANKEY|GREAT\s+WYRLEY|HAMPTON\s+WICK|HARDINGSTONE|HARROW\s+WEALD"
    r"|HECKMONDWIKE|HIGHAMS\s+PARK|ISLE\s+OF\s+BUTE|KENSAL\s+GREEN|KINGSWINFORD|KIRBY\s+MUXLOE|KIRK\s+SANDALL"
    r"|KIVETON\s+PARK|LITTLE\s+LEVER|LOCHARBRIGGS|LOUGHBOROUGH|LOWER\s+EARLEY|MACCLESFIELD|MANGOTSFIELD"
    r"|MARSHALSWICK|MOSSLEY\s+HILL|MOUNTAIN\s+ASH|MUSWELL\s+HILL|NEWBURY\s+PARK|NEWTON\s+ABBOT|NEWTOWN\s+TRIM"
    r"|NEWTOWNABBEY|NORRIS\s+GREEN|NORTH\s+ANSTON|NORTON\s+CANES|NOTTING\s+HILL|OLD\s+TRAFFORD|PADDOCK\s+WOOD"
    r"|PASSAGE\s+WEST|PORT\s+GLASGOW|REGENTS\s+PARK|SAINT\s+BLAZEY|SAINT\s+PETERS|SKELMERSDALE|SOUTH\s+DUBLIN"
    r"|SOUTH\s+MOLTON|SPITALFIELDS|STOCKSBRIDGE|STROUD\s+GREEN|TILLICOULTRY|WELLESBOURNE|WEST\s+BYFLEET"
    r"|WEST\s+CLANDON|WEST\s+DRAYTON|WEST\s+MOLESEY|WEST\s+WATFORD|WEST\s+WICKHAM|WESTHOUGHTON|WOBURN\s+SANDS"
    r"|ABERGAVENNY|ABERTILLERY|ABERYSTWYTH|BALLINASLOE|BALLYCASTLE|BALLYFERMOT|BANNOCKBURN|BARKINGSIDE"
    r"|BARNT\s+GREEN|BERKHAMSTED|BIGGIN\s+HILL|BIGGLESWADE|BISHOPSTOKE|BLESSINGTON|BONNYBRIDGE|BOOTERSTOWN"
    r"|BOREHAMWOOD|BRIDLINGTON|BROADSTAIRS|BROMBOROUGH|BURNTISLAND|CAMDEN\s+TOWN|CARRIGALINE|CASTLE\s+VALE"
    r"|CASTLEKNOCK|CASTLEREAGH|CHERRYVILLE|CHESSINGTON|CHISLEHURST|CHORLEYWOOD|CIRENCESTER|CLECKHEATON|CLEETHORPES"
    r"|COCKERMOUTH|COCKFOSTERS|COLLIER\s+ROW|CONISBROUGH|COWDENBEATH|CRAMLINGTON|CRICKLEWOOD|CROSS\s+HILLS"
    r"|CROWBOROUGH|CUMBERNAULD|DALGETY\s+BAY|DARRAS\s+HALL|DINAS\s+POWYS|DONNYCARNEY|DOWNPATRICK|DUNFERMLINE"
    r"|EARLS\s+COURT|EAST\s+BARNET|EAST\s+BOLDON|EATON\s+SOCON|EDGWAREBURY|ENNISCORTHY|ENNISKILLEN|FALLOWFIELD"
    r"|FARNBOROUGH|FOREST\s+HILL|FRASERBURGH|FURZE\s+PLATT|GLASTONBURY|GRANGE\s+HILL|GRANGEMOUTH|GRAPPENHALL"
    r"|GREENISLAND|GUISBOROUGH|HADLEY\s+WOOD|HAROLD\s+WOOD|HARROW\s+ROAD|HAZEL\s+GROVE|HEIGHINGTON|HELENSBURGH"
    r"|HIGH\s+BARNET|HUMBERSTONE|HUNTS\s+CROSS|INGATESTONE|JORDANSTOWN|KINGS\s+CROSS|KINGSBRIDGE|KIRKLEATHAM"
    r"|KNOTTINGLEY|LEATHERHEAD|LETTERKENNY|LEYTONSTONE|LITTLE\s+BRAY|LLANTRISANT|LONG\s+ASHTON|LONG\s+DITTON"
    r"|LONGDENDALE|LOSSIEMOUTH|LUTTERWORTH|MABLETHORPE|MAGHERAFELT|MAIDENBOWER|MANNINGTREE|MARLBOROUGH|MOODIESBURN"
    r"|MOUNTSORREL|MUSSELBURGH|NETHER\s+EDGE|NEW\s+BASFORD|NEWTOWNARDS|OLD\s+WINDSOR|PALMERSTOWN|PETERSFIELD"
    r"|POCKLINGTON|PONDERS\s+END|PORTMARNOCK|PORTSTEWART|POTTERS\s+BAR|PRESTONPANS|QUEENS\s+PARK|QUEENSFERRY"
    r"|RANDALSTOWN|RATHFARNHAM|RAWTENSTALL|ROSS\s+ON\s+WYE|ROTHERHITHE|ROTTINGDEAN|SADDLEWORTH|SAINT\s+NEOTS"
    r"|SALLYNOGGIN|SANDERSTEAD|SHAFTESBURY|SNARESBROOK|ST\s+LEONARDS|STALYBRIDGE|STAPLEHURST|STORRINGTON"
    r"|STOURBRIDGE|SUNNINGHILL|SWADLINCOTE|THE\s+BOLDONS|WALKINSTOWN|WALLINGFORD|WARRENPOINT|WATER\s+EATON"
    r"|WEDNESFIELD|WEST\s+EALING|WEST\s+HALLAM|WEST\s+MERSEA|WHITECHAPEL|WHITLEY\s+BAY|WINGERWORTH|ABBEY\s+ROAD"
    r"|ABBEY\s+WOOD|ABERCANAID|ABERKENFIG|ABERTRIDWR|ACCRINGTON|ADDLESTONE|ALEXANDRIA|ALTRINCHAM|ATHERSTONE"
    r"|BALBRIGGAN|BALLINTEER|BALLYBODEN|BALLYCLARE|BALLYMONEY|BARNSTAPLE|BARROWFORD|BATCHWORTH|BEDLINGTON"
    r"|BELLE\s+VALE|BILLERICAY|BILLINGHAM|BIRKENHEAD|BLACKHEATH|BOLLINGTON|BOSTON\s+SPA|BOURNE\s+END|BRAUNSTONE"
    r"|BRIDGNORTH|BRIDGWATER|BRIERFIELD|BROADFIELD|BROADSTONE|BROADWATER|BROMSGROVE|BROWNHILLS|BROXBOURNE"
    r"|BUCKINGHAM|BURNGREAVE|BURRY\s+PORT|CABINTEELY|CAERNARFON|CAERPHILLY|CALLINGTON|CAMBUSLANG|CARMARTHEN"
    r"|CARNOUSTIE|CARSHALTON|CASTLEFORD|CASTLETROY|CHADDERTON|CHADDESDEN|CHALK\s+FARM|CHAPELHALL|CHAPELIZOD"
    r"|CHAPELTOWN|CHELSFIELD|CHICHESTER|CHIPPENHAM|CHURCHDOWN|CINDERFORD|CLONDALKIN|COALISLAND|COATBRIDGE"
    r"|COCKINGTON|COLWYN\s+BAY|CROUCH\s+END|CROWTHORNE|CULLOMPTON|CUNNINGHAM|DESBOROUGH|DINNINGTON|DOLLYMOUNT"
    r"|DONAGHADEE|DONAGHMEDE|DONNYBROOK|DORCHESTER|DUKINFIELD|EARLSFIELD|EAST\s+COWES|EAST\s+LEAKE|EAST\s+SHEEN"
    r"|EASTBOURNE|EDENBRIDGE|EDWINSTOWE|FAILSWORTH|FAZAKERLEY|FELIXSTOWE|FLEETVILLE|FOLKESTONE|FOUR\s+MARKS"
    r"|FRECKLETON|FRESHWATER|GALASHIELS|GILLINGHAM|GIPSY\s+HILL|GLEN\s+PARVA|GLENROTHES|GLYN\s+NEATH|GOREBRIDGE"
    r"|GREENHILLS|GREENHITHE|GREYSTONES|HADDINGTON|HALE\s+BARNS|HALESWORTH|HARTLEPOOL|HASLINGDEN|HETHERSETT"
    r"|HILLINGDON|HOLLINWOOD|HORNCASTLE|HORNCHURCH|HUMBERSTON|HUNGERFORD|HUNSTANTON|HUNTINGDON|ILFRACOMBE"
    r"|IVER\s+HEATH|KENILWORTH|KIDLINGTON|KILLAMARSH|KILMARNOCK|KILWINNING|KINGS\s+LYNN|KIRRIEMUIR|KNOTTY\s+ASH"
    r"|LAUNCESTON|LEOMINSTER|LIGHTWATER|LINLITHGOW|LITHERLAND|LITTLEPORT|LIVERSEDGE|LIVINGSTON|LONG\s+EATON"
    r"|MAIDA\s+HILL|MAIDENHEAD|MALMESBURY|MANOR\s+PARK|MEXBOROUGH|MIDDLEWICH|MILDENHALL|MOTHERWELL|MOTTINGHAM"
    r"|NAILSWORTH|NARBOROUGH|NEW\s+BARNET|NEW\s+MALDEN|NEW\s+MILTON|NEW\s+ROMNEY|NEWARTHILL|OAKENGATES|OKEHAMPTON"
    r"|OLD\s+HARLOW|PARTINGTON|PEACEHAVEN|PERRY\s+VALE|POLESWORTH|PONTEFRACT|PONTYPRIDD|PORINGLAND|PORTISHEAD"
    r"|PORTLAOISE|PORTLETHEN|QUEENSBURY|QUEENSTOWN|RAMSBOTTOM|RAVENSHEAD|ROEHAMPTON|ROSSENDALE|RUDDINGTON"
    r"|RUSKINGTON|RUSTINGTON|RUTHERGLEN|SAINT\s+IVES|SANDYMOUNT|SCUNTHORPE|SHEPPERTON|SHERINGHAM|SHEVINGTON"
    r"|SHIREBROOK|SHORTLANDS|SOUTHWATER|SPENNYMOOR|ST\s+ANDREWS|ST\s+AUSTELL|STAINFORTH|STAPLEFORD|STEVENSTON"
    r"|STONEHAVEN|STONEHOUSE|STOWMARKET|STRATHAVEN|SWANSCOMBE|TEDDINGTON|TEIGNMOUTH|TEMPLEOGUE|TEWKESBURY"
    r"|THAMESMEAD|TITCHFIELD|TONYREFAIL|TOTTERIDGE|TOTTINGTON|TROWBRIDGE|UDDINGSTON|USHAW\s+MOOR|WADEBRIDGE"
    r"|WALLINGTON|WARLINGHAM|WARMINSTER|WASHINGTON|WATERBEACH|WEALDSTONE|WEDNESBURY|WELLINGTON|WEST\s+DERBY"
    r"|WEST\s+KIRBY|WESTBOURNE|WESTERGATE|WHITCHURCH|WHITEFIELD|WHITEHAVEN|WHITSTABLE|WHITTLESEY|WILLENHALL"
    r"|WILLINGTON|WINDERMERE|WIRKSWORTH|WITHERNSEA|WOOD\s+GREEN|WOODBRIDGE|WORKINGTON|WORLDS\s+END|YSTALYFERA"
    r"|ABERCYNON|ADLINGTON|ALDERSHOT|AMMANFORD|ARDROSSAN|ARMTHORPE|ASHBOURNE|ASHINGTON|AXMINSTER|AYLESTONE"
    r"|BALLINGRY|BALLYMENA|BANBRIDGE|BARNSBURY|BATTERSEA|BAYSWATER|BEBINGTON|BECKENHAM|BECONTREE|BELLSHILL"
    r"|BLACKROCK|BLACKWALL|BLACKWOOD|BLAENAVON|BLETCHLEY|BONNYRIGG|BORROWASH|BOVINGDON|BOWTHORPE|BRACKNELL"
    r"|BRAINTREE|BRENTFORD|BRENTWOOD|BRIGHOUSE|BRIXWORTH|BROUGHTON|BRYNAMMAN|BURNTWOOD|BURSCOUGH|BURSLEDON"
    r"|CALVERTON|CAMBERLEY|CAMBOURNE|CANONBURY|CARNFORTH|CARRYDUFF|CARTERTON|CASTLEBAR|CELBRIDGE|CHASETOWN"
    r"|CHATTERIS|CHILDWALL|CHINGFORD|CLARKSTON|CLEVELEYS|CLITHEROE|CLYDEBANK|COALVILLE|COCKENZIE|COEDPOETH"
    r"|COLERAINE|COLNBROOK|CONGLETON|COOKSTOWN|COTTENHAM|CRAIGAVON|CRANFIELD|CRANLEIGH|CREWKERNE|CRUMPSALL"
    r"|DARTMOUTH|DRIFFIELD|DROITWICH|DRONFIELD|DROYLSDEN|DUMBARTON|DUNDONALD|DUNGANNON|DUNGARVAN|DUNSTABLE"
    r"|DUNTOCHER|EADESTOWN|EARLSWOOD|EASINGTON|EASTLEIGH|EBBW\s+VALE|EDENDERRY|ELDERSLIE|FARINGDON|FARNWORTH"
    r"|FAVERSHAM|FERRYHILL|FLEETWOOD|FURZEDOWN|GATESHEAD|GELLIGAER|GLENFIELD|GODALMING|GOODMAYES|GORSEINON"
    r"|GRAVESEND|GREENFORD|GREENHILL|HALESOWEN|HAREFIELD|HARLESDEN|HARPENDEN|HARRINGAY|HARTSHILL|HARTSTOWN"
    r"|HASLEMERE|HATCH\s+END|HAVERHILL|HEADSTONE|HEAVITREE|HEDGE\s+END|HEMSWORTH|HERNE\s+BAY|HIGH\s+PEAK|HIGHWORTH"
    r"|HODDESDON|HORSFORTH|HYDE\s+PARK|ILMINSTER|IMMINGHAM|INVERURIE|ISLEWORTH|IVYBRIDGE|JOHNSTONE|KETTERING"
    r"|KIDBROOKE|KIDSGROVE|KILBIRNIE|KILLARNEY|KILLESTER|KIMBERLEY|KINGSWOOD|KIRKCALDY|KNOCKLYON|KNUTSFORD"
    r"|LARKFIELD|LATCHMERE|LICHFIELD|LIMEHOUSE|LLANDUDNO|LLANHARAN|LOCHGELLY|LOFTHOUSE|LONGFIELD|LONGRIDGE"
    r"|LONGSIGHT|LOWESTOFT|LYMINGTON|MANSFIELD|MARCHWOOD|MIDDLETON|MILNGAVIE|MONIFIETH|MONKSTOWN|MOOR\s+PARK"
    r"|MORECAMBE|NETHERLEY|NEW\s+CROSS|NEW\s+FERRY|NEW\s+MILLS|NEWBRIDGE|NEWMARKET|NORTHWICH|NORTHWOOD|ORPINGTON"
    r"|PARKSTONE|PENISTONE|PENKRIDGE|PETERHEAD|PICKERING|PLUMSTEAD|PLYMSTOCK|PONTELAND|PONTYCLUN|PONTYPOOL"
    r"|PORTADOWN|PORTHCAWL|PORTSLADE|PORTSWOOD|PRESTATYN|PRESTWICH|PRESTWICK|RADCLIFFE|RAINWORTH|RATHMINES"
    r"|ROCHESTER|ROSCOMMON|SACRISTON|SALTCOATS|SANDHURST|SANDYFORD|SEVENOAKS|SHEERNESS|SHENFIELD|SHERBORNE"
    r"|SMETHWICK|SOUTHGATE|SOUTHPORT|SOUTHWELL|ST\s+BLAZEY|ST\s+HELENS|ST\s+HELIER|ST\s+JAMESS|ST\s+PETERS"
    r"|STAKEFORD|STEWARTON|STORNOWAY|STRANRAER|STREATHAM|STRENSALL|STRETFORD|TADCASTER|TAVISTOCK|TENTERDEN"
    r"|THORNBURY|THORNHILL|THRAPSTON|TIMPERLEY|TODMORDEN|TONBRIDGE|TONYPANDY|TOTTENHAM|TOWCESTER|TREHARRIS"
    r"|TULLAMORE|TULLIBODY|TYLDESLEY|TYNEMOUTH|ULVERSTON|UPMINSTER|UPPERMILL|UPTON\s+LEA|UTTOXETER|WATERFORD"
    r"|WAVERTREE|WEAVERHAM|WELSHPOOL|WEYBRIDGE|WHETSTONE|WHITWORTH|WILLESDEN|WINCANTON|WOKINGHAM|WOMBOURNE"
    r"|WROUGHTON|ABERCARN|ABERDARE|ABERGELE|ABINGDON|AIGBURTH|ALCESTER|ALDRIDGE|ALFRETON|ALLERTON|AMERSHAM|AMESBURY"
    r"|AMPTHILL|ARBROATH|ARMADALE|ASH\s+VALE|ATHERTON|BALDOYLE|BALLYMUN|BANCHORY|BANSTEAD|BARRHEAD|BATHGATE"
    r"|BEARSDEN|BEDWORTH|BEIGHTON|BELGRAVE|BEVERLEY|BICESTER|BIDDULPH|BIDEFORD|BILLINGE|BIRCOTES|BIRSTALL|BLACKLEY"
    r"|BLACKROD|BLANTYRE|BLOXWICH|BOLSOVER|BOTHWELL|BOUGHTON|BRACKLEY|BRADWELL|BRAMCOTE|BRAMHALL|BRAUNTON|BREDBURY"
    r"|BRIDGEND|BRIDPORT|BRITWELL|BROCKLEY|BROSELEY|BROXBURN|BRUNDALL|BRYNMAWR|BUNCRANA|CAERLEON|CALDICOT|CARCROFT"
    r"|CARDIGAN|CATERHAM|CHALFORD|CHARLTON|CHEPSTOW|CHERTSEY|CHESHUNT|CHIGWELL|CHILWELL|CHISWICK|CLEVEDON|CODICOTE"
    r"|COLEFORD|COLINTON|COTGRAVE|COULSDON|COWPLAIN|CRANFORD|CREDITON|CRESWELL|CROXTETH|CUDWORTH|CULCHETH|DAGENHAM"
    r"|DALKEITH|DARFIELD|DARNDALE|DARTFORD|DAVENTRY|DEWSBURY|DHEKELIA|DIDSBURY|DINGWALL|DODWORTH|DONABATE|DORRIDGE"
    r"|DOWNSIDE|DROGHEDA|DUMFRIES|DUNBLANE|DUNBOYNE|DUNHOLME|EASTWOOD|EDMONTON|EGREMONT|ELM\s+PARK|EMSWORTH"
    r"|EVINGTON|FAIR\s+OAK|FAKENHAM|FALMOUTH|FERNDALE|FERNDOWN|FIRHOUSE|FLITWICK|FRODSHAM|GARFORTH|GARSTANG"
    r"|GARSWOOD|GIFFNOCK|GLANMIRE|GLUSBURN|GOLBORNE|GOSFORTH|GRANTHAM|GREENOCK|GRESFORD|GUISELEY|HADLEIGH|HAILSHAM"
    r"|HAINAULT|HALEWOOD|HALSTEAD|HANWORTH|HASSOCKS|HASTINGS|HATFIELD|HAWARDEN|HAWKINGE|HERTFORD|HIGHBURY|HINCKLEY"
    r"|HINDHEAD|HOLBEACH|HOLLOWAY|HOLYHEAD|HOLYTOWN|HOLYWELL|HOLYWOOD|HUCKNALL|ICKENHAM|ILKESTON|JOBSTOWN|KEARSLEY"
    r"|KEIGHLEY|KELVEDON|KEMPSTON|KESGRAVE|KEYNSHAM|KEYWORTH|KILKENNY|KILQUADE|KIRKDALE|KIRKWALL|KNAPHILL|LADYWELL"
    r"|LARKHALL|LIMAVADY|LISKEARD|LLANDAFF|LLANELLI|LOANHEAD|LONGFORD|LOUGHREA|LOUGHTON|MALAHIDE|MARYPORT|MAYFIELD"
    r"|MAYNOOTH|MELKSHAM|MERSTHAM|MIDHURST|MIDLETON|MILL\s+END|MINEHEAD|MIRFIELD|MONAGHAN|MONKHAMS|MONMOUTH"
    r"|MONTROSE|MORTLAKE|NANTWICH|NEILSTON|NEW\s+MILL|NEW\s+ROSS|NEWHAVEN|NEWMAINS|NORBITON|NORTHOLT|OLD\s+SWAN"
    r"|ORMSKIRK|OSTERLEY|OSWESTRY|PAIGNTON|PEMBROKE|PENICUIK|PENZANCE|PERSHORE|PETERLEE|PLYMPTON|PORTLAND|PORTRUSH"
    r"|PREESALL|QUORNDON|RADSTOCK|RAINFORD|RAINHILL|RAMSGATE|RASTRICK|RAWMARSH|RAYLEIGH|REDBOURN|REDDITCH|RHIWBINA"
    r"|RINGSEND|RINGWOOD|ROCHFORD|ROTHWELL|SALTAIRE|SANDBACH|SHADWELL|SHANKILL|SHANKLIN|SHEFFORD|SHEPSHED|SIDMOUTH"
    r"|SKEGNESS|SKERRIES|SLEAFORD|SNODLAND|SOUTHALL|SOUTHSEA|SPALDING|ST\s+NEOTS|STAFFORD|STAMFORD|STANWELL"
    r"|STAVELEY|STEYNING|STOTFOLD|STRABANE|STREETLY|SURBITON|SWAFFHAM|TADWORTH|TALLAGHT|TARLETON|TERENURE|THATCHAM"
    r"|THETFORD|THORNTON|TIDWORTH|TIVERTON|TOLWORTH|TORPOINT|TOWNSEND|TRA\s+MHOR|TREDEGAR|TREORCHY|TUNSTALL"
    r"|UCKFIELD|VIEWPARK|WALLASEY|WALLSEND|WANSTEAD|WENDOVER|WEST\s+END|WEST\s+HAM|WESTBURY|WESTHILL|WESTPORT"
    r"|WETHERBY|WEYMOUTH|WHEATLEY|WHICKHAM|WHITBURN|WICKFORD|WIDEOPEN|WILMSLOW|WINSFORD|WIVENHOE|WOMBWELL|WOODSIDE"
    r"|WOOLSTON|WORTHING|AIRDRIE|ALNWICK|ALSAGER|ANDOVER|ARCHWAY|ARLESEY|ASHFORD|ASHTEAD|ATHLONE|AYLSHAM|BAGSHOT"
    r"|BAILDON|BALALLY|BALDOCK|BALERNO|BALLINA|BARGOED|BARNHAM|BASFORD|BECCLES|BENTLEY|BENWELL|BEWBUSH|BEWDLEY"
    r"|BICKLEY|BINGHAM|BINGLEY|BONHILL|BRECHIN|BRIXHAM|BROTTON|BUCKLEY|BULFORD|BURNAGE|BURNHAM|BURPHAM|BURWELL"
    r"|CANNOCK|CARLUKE|CATFORD|CHATHAM|CHEADLE|CHEDDAR|CHESHAM|CHINNOR|CHORLEY|CLYDACH|CODSALL|CONSETT|COOKHAM"
    r"|COPPULL|CORSHAM|CROFTON|CRUMLIN|CUMNOCK|CWMAFAN|CWMBRAN|DALMUIR|DALSERF|DANBURY|DAWLISH|DEESIDE|DEGANWY"
    r"|DENBIGH|DENMEAD|DEVIZES|DORKING|DOUGLAS|DROMORE|DUNDALK|DUNDRUM|DURSLEY|EDGWARE|ENDERBY|ERSKINE|EVESHAM"
    r"|EXMOUTH|FAIFLEY|FALKIRK|FAREHAM|FARNHAM|FAZELEY|FELLING|FETCHAM|FINGLAS|FOXROCK|FRIMLEY|FULWOOD|GARSTON"
    r"|GEDLING|GLOSSOP|GOSPORT|GOUROCK|GREASBY|GRIMSBY|HARTLEY|HARWICH|HAWORTH|HAYDOCK|HEBBURN|HELSTON|HENGOED"
    r"|HESWALL|HEYSHAM|HEYWOOD|HINDLEY|HIRWAUN|HITCHIN|HOCKLEY|HOLBECK|HOLBORN|HONITON|HORBURY|HORNSEA|HORNSEY"
    r"|HORSHAM|HORWICH|HOUSTON|HOYLAKE|IBSTOCK|KEMSING|KILBURN|KILCOCK|KILDARE|KILKEEL|KILSYTH|KINSALE|KIRKHAM"
    r"|LANCING|LARBERT|LAYTOWN|LEDBURY|LEISTON|LEIXLIP|LERWICK|LEYLAND|LINWOOD|LIPHOOK|LONGTON|LYNEHAM|MAESTEG"
    r"|MAGHULL|MANSTON|MARGATE|MATLOCK|MEASHAM|MELTHAM|MERIDEN|MILFORD|MILNROW|MITCHAM|MORETON|MORPETH|MOSSEND"
    r"|MOSSLEY|NAILSEA|NEWBURN|NEWBURY|NEWQUAY|NEWTOWN|NORBURY|NORTHAM|OLDBAWN|OLDBURY|PADIHAM|PEEBLES|PELSALL"
    r"|PEMBURY|PENARTH|PENCOED|PENRITH|PIMLICO|PINXTON|POLMONT|POYNTON|PRENTON|PRESCOT|PRUDHOE|PYRFORD|RADLETT"
    r"|RAINHAM|RATHGAR|RATOATH|REDHILL|REDRUTH|REIGATE|RENFREW|RETFORD|RHONDDA|RHYMNEY|RISHTON|ROSCREA|ROYSTON"
    r"|RUGELEY|RUISLIP|RUNCORN|RUSHDEN|SALLINS|SALTASH|SANDOWN|SAUCHIE|SAWSTON|SEAFORD|SELKIRK|SHANNON|SHELLEY"
    r"|SHEPLEY|SHIFNAL|SHILDON|SHIPLEY|SILSDEN|SKELTON|SKIPTON|SOPWELL|SOUTHAM|ST\s+ANNS|ST\s+IVES|STEPNEY|STUDLEY"
    r"|SUDBURY|SWANAGE|SWANLEY|SWINTON|TETBURY|THURLES|TILBURY|TIPTREE|TOOTING|TRANENT|TURRIFF|TWYFORD|URMSTON"
    r"|VENTNOR|VERWOOD|WALKDEN|WALTHAM|WANTAGE|WAREHAM|WELLING|WEXFORD|WHISTON|WICKLOW|WILSDEN|WINGATE|WISBECH"
    r"|WOOLTON|WORKSOP|YATELEY|YOUGHAL|ALNESS|AN\s+ROS|ANSTEY|ANTRIM|ARKLOW|ARMAGH|ARTANE|ASKERN|AUDLEY|AVELEY"
    r"|BALHAM|BANDON|BANGOR|BARNES|BATLEY|BATTLE|BEDDAU|BEDWAS|BELPER|BEXLEY|BLACON|BODMIN|BONESS|BOOTLE|BORDON"
    r"|BOWDON|BRECON|BROUGH|BRYMBO|BRYNNA|BUCKIE|BUNGAY|BUXTON|CALCOT|CARLOW|CLOWNE|COBHAM|COMBER|CONFEY|COSHAM"
    r"|COWLEY|CRIEFF|CROMER|CURRIE|DALKEY|DARTON|DARWEN|DENTON|DIDCOT|DINGLE|DUNBAR|DUNOON|EASTON|ECCLES|ELLAND"
    r"|ELTHAM|EPPING|EUXTON|FERMOY|FORFAR|FORMBY|FORRES|GIRVAN|HADLEY|HAGLEY|HARLOW|HAVANT|HAWICK|HEANOR|HELSBY"
    r"|HEMSBY|HENLOW|HESTON|HEXHAM|HISTON|HORLEY|HUYTON|ILKLEY|IRVINE|JARROW|KENDAL|KENLEY|KIPPAX|KIRKBY|KNOWLE"
    r"|LANARK|LENZIE|LEYTON|LUDLOW|LYDNEY|MALDON|MALLOW|MALTBY|MALTON|MARINO|MARPLE|MENDIP|MERROW|METHIL|MILLOM"
    r"|MORDEN|MURTON|NELSON|NENAGH|NESTON|NETLEY|OAKHAM|OSSETT|OTFORD|OUNDLE|PELTON|PENRYN|PENTRE|PINNER|PITSEA"
    r"|POPLAR|PUDSEY|PURLEY|PUTNEY|RAHENY|RAMSEY|RAUNDS|REDCAR|RHOOSE|RIPLEY|ROMSEY|ROSYTH|ROYTON|RUTHIN|RYHILL"
    r"|RYHOPE|SAWTRY|SCALBY|SEATON|SELSEY|SHOTTS|SIDCUP|SILEBY|SINFIN|STEPPS|STROOD|STROUD|STURRY|SWORDS|SYSTON"
    r"|TADLEY|THIRSK|THORNE|THORPE|THURSO|TIPTON|TOTNES|TOTTON|TRALEE|WARDLE|WARSOP|WATTON|WIDNES|WIGTON|WISHAW"
    r"|WITHAM|WITLEY|WITNEY|YAPTON|YATTON|YAXLEY|YEADON|YEOVIL|ABRAM|ALLOA|AMBLE|ANNAN|BACUP|BEITH|BLABY|BLYTH"
    r"|BRENT|BRIGG|CALNE|CAVAN|CHEAM|CLANE|COITY|COLNE|CORBY|COWES|CREWE|CROOK|CUPAR|DALRY|DENNY|EGHAM|ELLON|ENNIS"
    r"|ERITH|ESHER|ESTON|EWELL|FILEY|FLEET|FYLDE|GOOLE|GOREY|GRAYS|GROBY|GROVE|HAXBY|HAYLE|HEDON|HOWTH|HULME|HYTHE"
    r"|IRLAM|KELSO|KELTY|LARGS|LARNE|LEIGH|LEVEN|LEWES|LOUTH|LUCAN|MAGOR|NAIRN|NAVAN|NEATH|NEWRY|OADBY|OLNEY|OMAGH"
    r"|OTLEY|OXTED|RIPON|RISCA|RYTON|SANDY|SCONE|SLIGO|SOHAM|SPEKE|STONE|THAME|TOTON|TRING|TROON|UPTON|WALES)\Z",
    re.A,
)
TRAILING_CODE_RE = re.compile(r"\s(?:RECEIPT|BCC|CLP|DDR|POS|VIS|DEB|CPT|BGC|STO|FPO|FPI|TFR|GBP|EUR|CR|DR)\Z", re.A)
TLD = (
    "CO\\.UK|ORG\\.UK|GOV\\.UK|AC\\.UK|LTD\\.UK|ME\\.UK|COM|NET|ORG|UK|IE|DE|FR|NL|IO|EU|ES|IT|BE|LU|APP|TV|CO|"
    "FM|AI|ME|GG|DEV|XYZ|SHOP|STORE|ONLINE|TECH|BIZ|INFO|US|CA|AU|SE|DK|NO|FI|AT|CH|PL|PT"
)
DOMAIN_TOKEN_RE = re.compile(
    r"^(?:HTTPS?://)?(?:WWW\.)?(?:[A-Z0-9\-]+\.)*?([A-Z0-9\-]*[A-Z][A-Z0-9\-]*)\.(?:CO\.UK|ORG\.UK|GOV\.UK|AC\.UK"
    r"|LTD\.UK|ME\.UK|COM|NET|ORG|UK|IE|DE|FR|NL|IO|EU|ES|IT|BE|LU|APP|TV|CO|FM|AI|ME|GG|DEV|XYZ|SHOP|STORE|ONLINE"
    r"|TECH|BIZ|INFO|US|CA|AU|SE|DK|NO|FI|AT|CH|PL|PT)(?:/\S*)?\Z",
    re.A,
)

# packages/statement/src/classify.ts
UK_TYPE_CODES = {
    "BGC": "income", "BNS": "income", "BP": "bill", "CHG": "fee", "CHQ": "transfer", "COM": "fee", "COR": "other",
    "CPT": "cash", "CSH": "cash", "CSQ": "other", "DD": "dd", "DEB": "card", "DEP": "income", "EFT": "card",
    "EUR": "other", "FE": "other", "FEE": "fee", "FPC": "fee", "FPI": "transfer", "FPO": "transfer",
    "IB": "transfer", "INT": "income", "MPI": "transfer", "MPO": "transfer", "MTG": "dd", "NS": "internal",
    "NSC": "internal", "OTH": "other", "PAY": "other", "PSB": "internal", "PSV": "internal", "SAL": "income",
    "SPB": "cash", "SO": "bill", "STK": "internal", "TD": "internal", "TDG": "income", "TDI": "internal",
    "TDN": "income", "TFR": "transfer", "UT": "internal", "SUR": "other", "BBP": "bill", "BAC": "other",
    "BACS": "other", "BSP": "transfer", "CDM": "cash", "CHAPS": "transfer", "CHP": "transfer", "CRE": "income",
    "CUI": "other", "D/D": "dd", "DDR": "dd", "DIV": "income", "DR": "other", "DWP": "income", "ERTF": "fee",
    "FP": "transfer", "IBP": "transfer", "IMO": "transfer", "ITL": "other", "NDC": "other", "OTR": "transfer",
    "POC": "cash", "POS": "card", "REV": "refund", "S/O": "bill", "STO": "bill", "SBT": "transfer",
    "TEL": "transfer", "TLR": "cash", "UNP": "other", "VIS": "card", "ATM": "cash", "CR": "income", "CDR": "income",
    "OD": "other", "C/L": "cash", "DPC": "transfer", ")))": "card", "MAS": "card", "OBP": "bill", "CAR": "card",
    "MOS": "transfer", "MOR": "income", "MOA": "income", "EXC": "internal", "CRF": "refund",
}
TYPE_LABEL_RULES = (
    (
        re.compile(
            r"POT TRANSFER|\bPOT\b|SAVINGS|STARLING TRANSFER|INTERNAL TRANSFER|TOP.?UP|EXCHANGE|CONVERSION"
            r"|^BALANCE\Z",
            re.A,
        ),
        "internal",
    ),
    (re.compile(r"REFUND|REVERSAL", re.A), "refund"), (re.compile(r"\bATM\b|CASH", re.A), "cash"),
    (re.compile(r"\bFEES?\b|CHARGE", re.A), "fee"),
    (
        re.compile(
            r"CARD|CONTACTLESS|VISA|MASTERCARD|PRESENTMENT|CHIP ?(?:&|AND) ?PIN|ONLINE PAYMENT|APPLE PAY|GOOGLE PAY"
            r"|^PURCHASE\Z|^DEBIT\Z",
            re.A,
        ),
        "card",
    ),
    (re.compile(r"DIRECT DEBIT", re.A), "dd"),
    (re.compile(r"STANDING ORDER|BILL PAYMENT|^PAYMENT TO\Z|^PAYMENT\Z", re.A), "bill"),
    (re.compile(r"TRANSFER|FASTER PAYMENT|CHAPS|SENT MONEY|MONZO-TO-MONZO|P2P|^PAYMENT FROM\Z", re.A), "transfer"),
    (re.compile(r"SALARY|INTEREST|INCOME|CREDIT|DEPOSIT|DIVIDEND|^BACS", re.A), "income"),
)
DESCRIPTION_PREFIX_RULES = (
    (
        re.compile(
            r"^(?:CARD PAYMENT|CARD PURCHASE|VISA PURCHASE|DEBIT CARD|CONTACTLESS|VIS|POS|DEB|PURCHASE)\b",
            re.A,
        ),
        "card",
    ),
    (re.compile(r"^(?:DIRECT DEBIT|DD|DDR|D/D)\b", re.A), "dd"),
    (re.compile(r"^(?:STANDING ORDER|SO|STO|S/O|BILL PAYMENT|BP|BBP)\b", re.A), "bill"),
    (
        re.compile(
            r"^(?:FASTER PAYMENT|FPO|FPI|TFR|TRANSFER|BANK TRANSFER|TO A/C|SENT MONEY TO|RECEIVED MONEY FROM"
            r"|MOBILE PAYMENT)\b",
            re.A,
        ),
        "transfer",
    ),
    (re.compile(r"^(?:CASH WITHDRAWAL|CASHPOINT|ATM|CPT|LINK)\b", re.A), "cash"),
    (re.compile(r"^(?:CARD TRANSACTION OF)\b", re.A), "card"),
    (re.compile(r"^(?:REFUND|REVERSAL)\b", re.A), "refund"),
)
INTERNAL_TEXT = re.compile(
    r"\bPOTS?\b|TO SAVINGS|FROM SAVINGS|SAVINGS (?:POT|ACCOUNT|SPACE)|\bTOP[\- ]?UP\b|\bTOPUP\b"
    r"|\bEXCHANGED?\s+(?:TO|FROM)\b|\bCONVERTED\b|PAYMENT RECEIVED|THANK YOU|OWN ACCOUNT|\bADD TO BAL(?:ANCE)?\b",
    re.A,
)
SAVINGS_ACCOUNT = re.compile(r"\b(?:MONTHLY|REGULAR|EASY|ONLINE|LOYALTY|CHILDRENS?) SAVER\b", re.A)
PLATFORM = re.compile(
    r"^(?:TO |FROM )?(?:TRADING ?212|VANGUARD|FREETRADE|NUTMEG|MONEYBOX|HARGREAVES LANSDOWN|AJ BELL"
    r"|INTERACTIVE INVESTOR|ETORO|INVESTENGINE|MONEYFARM|WEALTHIFY)\b(.*)\Z",
    re.A,
)
FINANCE_WORDS = re.compile(
    r"\b(?:LTD|LIMITED|PLC|UK|EUROPE|ISA|SIPP|GIA|LISA|JISA|\w*INVEST\w*|ASSETS?|MANAGEMENT|MGMT|SECURITIES"
    r"|NOMINEES?|MARKETS|CFD|PERSONAL|PENSIONS?|WEALTH|MONEY|ACCOUNT|ACC|TOP ?UP|DEPOSIT|PAYMENT|TRANSFER|SAVINGS?"
    r"|STOCKS|SHARES|AND)\b|&",
    re.A,
)
CARD_REPAYMENT = re.compile(r"\b(?:CREDIT CARD|BARCLAYCARD|AMERICAN EXPRESS|AMEX|MBNA|CAPITAL ONE|VANQUIS|AQUA CARD)\b", re.A)
OWN_WALLET = re.compile(r"^(?:REVOLUT|MONZO|TRANSFERWISE|WISE|CURVE|PAYPAL)\b", re.A)
CASH_TEXT = re.compile(r"\bATM\b|CASH WITHDRAWAL|CASH MACHINE|CASHPOINT|NOTEMACHINE|\bCPT\b", re.A)
FEE_TEXT = re.compile(
    r"\b(?:ACCOUNT FEE|MONTHLY FEE|MONTHLY ACCOUNT FEE|OVERDRAFT (?:FEE|INTEREST|CHARGE)|NON[\- ]STERLING"
    r"|FOREIGN (?:TRANSACTION|EXCHANGE) FEE|TRANSACTION FEE|ARRANGED OVERDRAFT|UNARRANGED OVERDRAFT"
    r"|INTEREST CHARGED|BANK CHARGES?|SERVICE CHARGE|DEBIT INTEREST)\b",
    re.A,
)
REFUND_TEXT = re.compile(r"\bREFUND\b|\bREVERSAL\b|\bREFD\b", re.A)
TRANSFER_TEXT = re.compile(
    r"FASTER PAYMENTS?|\bFPO\b|\bTFR\b|TRANSFER TO|BANK TRANSFER|MOBILE PAYMENT|SENT MONEY TO|MONZO-TO-MONZO",
    re.A,
)
CARD_MARKERS = re.compile(r"\)\)\)|\*|\.COM\b|\.CO\.UK\b|\bWWW\.|\s\d{3,}\b|\b(?:GB|GBR|UK|IRL|USA|LUX)\Z", re.A)
PERSON_LINK = re.compile(r"^MONZO\s?\*\s?ME\b|\bMONZO\.ME\b", re.A)
ORG_WORDS = re.compile(
    r"\b(?:LTD|LIMITED|PLC|LLP|INC|CORP|CO|COMPANY|GROUP|HOLDINGS|SERVICES|COUNCIL|BOROUGH|HMRC|DVLA|TV LICEN[CS]E"
    r"|ENERGY|ELECTRIC|GAS|WATER|POWER|INSURANCE|ASSURANCE|MORTGAGE|LETTINGS|ESTATES?|PROPERTY|HOUSING|ASSOCIATION"
    r"|SOCIETY|TRUST|CHARITY|FOUNDATION|UNIVERSITY|COLLEGE|SCHOOL|NURSERY|GYM|FITNESS|CLUB|BANK|BUILDING SOCIETY"
    r"|TELECOM|MOBILE|BROADBAND|STORES?|SHOP|SUPERMARKETS?|MARKET|COFFEE|CAFE|RESTAURANT|KITCHEN|PIZZA|PUB|BAR"
    r"|HOTEL|TRAVEL|RAIL|TRAINS?|AIRWAYS|AIRLINES|TAXIS?|CARS|MOTORS|GARAGE|PHARMACY|DENTAL|CLINIC|SURGERY|NHS"
    r"|FOODS?|BAKERY|BUTCHERS?|DELI|SALON|BARBERS?|INTERIORS|DESIGNS?|STUDIOS?|SUPPLIES|SOLUTIONS|CONSULTING"
    r"|CONSULTANTS|JEWELLERS|FLORISTS?|STATIONERS|GALLERY|BOUTIQUE|WORKSHOP|GMBH|AG|KG|SARL|SRL|SAS|SPA|BV|NV|LLC"
    r"|OYJ)\b",
    re.A,
)
COMMON_BRANDS = (
    "TESCO", "SAINSBURYS", "SAINSBURY", "ASDA", "MORRISONS", "WAITROSE", "ALDI", "LIDL", "ICELAND", "COOP", "CO-OP",
    "MARKS", "M&S", "BOOTS", "SUPERDRUG", "GREGGS", "COSTA", "STARBUCKS", "PRET", "NERO", "MCDONALDS", "KFC",
    "NANDOS", "SUBWAY", "DOMINOS", "DELIVEROO", "JUST EAT", "UBER", "NETFLIX", "SPOTIFY", "AMAZON", "APPLE",
    "GOOGLE", "MICROSOFT", "DISNEY", "SKY", "VIRGIN", "BT", "EE", "O2", "VODAFONE", "THREE", "TFL", "TRAINLINE",
    "SHELL", "BP", "ESSO", "TEXACO", "ARGOS", "CURRYS", "IKEA", "PRIMARK", "NEXT", "ZARA", "H&M", "UNIQLO",
    "JOHN LEWIS", "WILKO", "B&Q", "HOMEBASE", "SCREWFIX", "WICKES", "HALFORDS", "EBAY", "PAYPAL", "ETSY", "ASOS",
    "BOOHOO", "SHEIN", "TEMU", "ALIEXPRESS", "EASYJET", "RYANAIR", "BRITISH AIRWAYS", "PREMIER INN", "TRAVELODGE",
    "AIRBNB", "BOOKING", "WETHERSPOON", "LEON", "WASABI", "ITSU", "FIVE GUYS", "BURGER KING", "PIZZA EXPRESS",
    "WAGAMAMA", "DUNELM", "POUNDLAND", "SPECSAVERS", "HOLLAND", "SCREWFIX",
)
BRAND_RE = re.compile(
    r"^(?:TESCO|SAINSBURYS|SAINSBURY|ASDA|MORRISONS|WAITROSE|ALDI|LIDL|ICELAND|COOP|CO-OP|MARKS|M&S|BOOTS|SUPERDRUG"
    r"|GREGGS|COSTA|STARBUCKS|PRET|NERO|MCDONALDS|KFC|NANDOS|SUBWAY|DOMINOS|DELIVEROO|JUST EAT|UBER|NETFLIX|SPOTIFY"
    r"|AMAZON|APPLE|GOOGLE|MICROSOFT|DISNEY|SKY|VIRGIN|BT|EE|O2|VODAFONE|THREE|TFL|TRAINLINE|SHELL|BP|ESSO|TEXACO"
    r"|ARGOS|CURRYS|IKEA|PRIMARK|NEXT|ZARA|H&M|UNIQLO|JOHN LEWIS|WILKO|B&Q|HOMEBASE|SCREWFIX|WICKES|HALFORDS|EBAY"
    r"|PAYPAL|ETSY|ASOS|BOOHOO|SHEIN|TEMU|ALIEXPRESS|EASYJET|RYANAIR|BRITISH AIRWAYS|PREMIER INN|TRAVELODGE|AIRBNB"
    r"|BOOKING|WETHERSPOON|LEON|WASABI|ITSU|FIVE GUYS|BURGER KING|PIZZA EXPRESS|WAGAMAMA|DUNELM|POUNDLAND"
    r"|SPECSAVERS|HOLLAND|SCREWFIX)\b",
    re.A,
)
BRAND_NAMES = frozenset({
    "TESCO", "SAINSBURYS", "SAINSBURY", "ASDA", "MORRISONS", "WAITROSE", "ALDI", "LIDL", "ICELAND", "COOP", "CO-OP",
    "MARKS", "M&S", "BOOTS", "SUPERDRUG", "GREGGS", "COSTA", "STARBUCKS", "PRET", "NERO", "MCDONALDS", "KFC",
    "NANDOS", "SUBWAY", "DOMINOS", "DELIVEROO", "JUST EAT", "UBER", "NETFLIX", "SPOTIFY", "AMAZON", "APPLE",
    "GOOGLE", "MICROSOFT", "DISNEY", "SKY", "VIRGIN", "BT", "EE", "O2", "VODAFONE", "THREE", "TFL", "TRAINLINE",
    "SHELL", "BP", "ESSO", "TEXACO", "ARGOS", "CURRYS", "IKEA", "PRIMARK", "NEXT", "ZARA", "H&M", "UNIQLO",
    "JOHN LEWIS", "WILKO", "B&Q", "HOMEBASE", "SCREWFIX", "WICKES", "HALFORDS", "EBAY", "PAYPAL", "ETSY", "ASOS",
    "BOOHOO", "SHEIN", "TEMU", "ALIEXPRESS", "EASYJET", "RYANAIR", "BRITISH AIRWAYS", "PREMIER INN", "TRAVELODGE",
    "AIRBNB", "BOOKING", "WETHERSPOON", "LEON", "WASABI", "ITSU", "FIVE GUYS", "BURGER KING", "PIZZA EXPRESS",
    "WAGAMAMA", "DUNELM", "POUNDLAND", "SPECSAVERS", "HOLLAND",
})
HONORIFICS = re.compile(r"^(?:MR|MRS|MS|MISS|MX|DR|PROF|SIR)\.?\s+", re.A)
CLASSIFY_MONTHS = "JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEPT?|OCT|NOV|DEC"
PAYEE_AFTER_FACILITATOR = re.compile(r"(?:^|[^A-Z0-9])(?:PAYPAL|PP)\s*\*\s*(.*)\Z", re.A)
WEB_ADDRESS = re.compile(r"\bWWW\.|\.(?:COM|CO\.UK|ORG\.UK|NET|ORG|IO|APP|SHOP|STORE)\b", re.A)

# packages/statement/src/sensitive.ts
SENSITIVE_KEYWORDS = {
    "health": (
        "CLINIC", "DENTAL", "DENTIST", "DENTISTS", "DENTISTRY", "ORTHODONTIC", "ORTHODONTICS", "PHARMACY",
        "CHEMIST", "CHEMISTS", "GP", "GP SURGERY", "SURGERY", "MEDICAL CENTRE", "HEALTH CENTRE", "HOSPITAL", "NHS",
        "THERAPY", "THERAPIST", "PHYSIOTHERAPY", "PHYSIO", "COUNSELLING", "COUNSELING", "COUNSELLOR",
        "PSYCHOLOGIST", "PSYCHOLOGY", "PSYCHIATRIST", "PSYCHIATRY", "PSYCHOTHERAPY", "OSTEOPATH", "CHIROPRACTOR",
        "IVF", "FERTILITY", "SEXUAL HEALTH", "BPAS", "MSI REPRODUCTIVE", "OPTICIAN", "OPTICIANS", "BUPA",
        "HEALTHCARE", "SPIRE HEALTHCARE", "NUFFIELD HEALTH", "DOCTOR", "DOCTORS", "PUSH DOCTOR", "LIVI",
        "BETTERHELP", "TALKSPACE", "REHAB", "REHABILITATION", "DETOX", "PRESCRIPTION", "LLOYDSPHARMACY", "MEDICAL",
        "HOSPICE", "SAMARITANS", "MIND", "REFUGE", "WOMENS AID", "RAPE CRISIS", "VICTIM SUPPORT", "CRUSE", "RELATE",
        "ALCOHOLICS ANONYMOUS", "NARCOTICS ANONYMOUS", "TURNING POINT", "CHILDLINE", "SHOUT 85258", "AL ANON",
        "AL-ANON", "COCAINE ANONYMOUS", "OVEREATERS ANONYMOUS", "MENTAL HEALTH", "RETHINK MENTAL ILLNESS",
        "YOUNGMINDS", "YOUNG MINDS", "BEAT EATING DISORDERS", "PRIORY GROUP", "PRIORY HOSPITAL",
        "PRIORY HEALTHCARE", "PRIORY WELLBEING", "TERRENCE HIGGINS TRUST", "TERRENCE HIGGINS", "MARIE STOPES",
        "BRITISH PREGNANCY ADVISORY", "FAMILY PLANNING", "ABORTION", "HIV", "BROOK YOUNG PEOPLE", "BROOK ADVISORY",
        "MERMAIDS", "GENDERGP", "GENDER GP", "MACMILLAN CANCER",
    ),
    "gambling": (
        "BET365", "BET 365", "PADDY POWER", "PADDYPOWER", "WILLIAM HILL", "WILLIAMHILL", "SKYBET", "SKY BET",
        "LADBROKES", "CORAL", "BETFAIR", "BETFRED", "BETWAY", "UNIBET", "888", "888SPORT", "888CASINO",
        "BOYLESPORTS", "BETVICTOR", "SPORTING INDEX", "CASINO", "POKER", "POKERSTARS", "PARTYPOKER", "BINGO",
        "GALA", "GROSVENOR", "TOMBOLA", "JACKPOTJOY", "VIRGIN GAMES", "LOTTERY", "NATIONAL LOTTERY", "LOTTO",
        "EUROMILLIONS", "BETTING", "BOOKMAKER", "BOOKMAKERS", "SLOTS", "BETANO", "LOTTOLAND", "PUNTER", "SPREADEX",
        "GAMCARE", "GAMBLERS ANONYMOUS",
    ),
    "dating": (
        "TINDER", "HINGE", "BUMBLE", "GRINDR", "MATCH COM", "MATCH GROUP", "FEELD", "PLENTY OF FISH",
        "PLENTYOFFISH", "POF", "OKCUPID", "EHARMONY", "BADOO", "RAYA", "ZOOSK", "ELITE SINGLES", "ELITESINGLES",
        "DATING", "HER APP", "LUXY", "INNER CIRCLE", "COFFEE MEETS BAGEL", "SCRUFF",
    ),
    "politics": (
        "LABOUR PARTY", "CONSERVATIVE PARTY", "CONSERVATIVE AND UNIONIST", "CONSERVATIVES", "LIBERAL DEMOCRATS",
        "LIB DEMS", "LIBDEMS", "GREEN PARTY", "REFORM UK", "SNP", "SCOTTISH NATIONAL PARTY", "PLAID CYMRU",
        "SINN FEIN", "DUP", "UKIP", "ALLIANCE PARTY", "SDLP", "YOUR PARTY", "POLITICAL PARTY", "LABOUR", "MOMENTUM",
    ),
    "union": (
        "TRADE UNION", "UNISON", "UNITE THE UNION", "GMB", "NEU", "NASUWT", "UCU", "PCS UNION", "RMT", "ASLEF",
        "CWU", "USDAW", "RCN", "ROYAL COLLEGE OF NURSING", "BMA", "PROSPECT UNION", "FBU", "NAHT", "EIS",
        "COMMUNITY UNION", "EQUITY UNION", "MUSICIANS UNION", "NUJ",
    ),
    "religion": (
        "CHURCH", "MOSQUE", "SYNAGOGUE", "TEMPLE", "GURDWARA", "MANDIR", "PARISH", "DIOCESE", "CATHEDRAL", "CHAPEL",
        "ISLAMIC", "ISLAMIC RELIEF", "MUSLIM", "JEWISH", "CHRISTIAN", "MINISTRIES", "KINGDOM HALL", "QUAKER",
        "QUAKERS", "HINDU", "SIKH", "BUDDHIST", "TITHE", "ZAKAT", "SADAQAH", "TZEDAKAH", "SALVATION ARMY",
        "CHRISTIAN AID", "TEARFUND",
    ),
    "debt": (
        "PAYDAY", "QUICKQUID", "WONGA", "LENDING STREAM", "LENDINGSTREAM", "MR LENDER", "DRAFTY", "CASHFLOAT",
        "PEACHY", "SATSUMA", "MONEYBOAT", "POLAR CREDIT", "BRIGHTHOUSE", "PROVIDENT", "LOWELL", "CABOT",
        "CABOT FINANCIAL", "INTRUM", "STEPCHANGE", "PAYPLAN", "DEBT", "DEBT COLLECTION", "BAILIFF", "BAILIFFS",
        "MARSTON", "ARROW GLOBAL", "HOIST", "PRA GROUP", "MOORCROFT", "LINK FINANCIAL", "CAPQUEST",
        "CREDIT RESOLVE", "RESOLVECALL", "BW LEGAL", "IVA", "DEBT MANAGEMENT",
    ),
    "adult": (
        "ONLYFANS", "FANSLY", "PORNHUB", "BRAZZERS", "CHATURBATE", "STRIPCHAT", "LIVEJASMIN", "CAMSODA", "MANYVIDS",
        "ADULT", "XXX", "ANN SUMMERS", "LOVEHONEY", "SEX SHOP", "ESCORT", "ESCORTS", "ADULTWORK", "CLIPS4SALE",
        "XHAMSTER",
    ),
}
SENSITIVE_EXACT = {
    "MATCH": "dating", "HER": "dating", "REFORM": "politics", "UNITE": "union", "PCS": "union", "PROSPECT": "union",
    "EQUITY": "union", "PRIORY": "health", "THE PRIORY": "health", "BROOK": "health", "THT": "health",
}
CATEGORY_RES = (
    (
        "health",
        re.compile(
            r"(?:^|[^A-Z0-9])(?:BRITISH\s+PREGNANCY\s+ADVISORY|RETHINK\s+MENTAL\s+ILLNESS"
            r"|TERRENCE\s+HIGGINS\s+TRUST|BEAT\s+EATING\s+DISORDERS|ALCOHOLICS\s+ANONYMOUS|OVEREATERS\s+ANONYMOUS"
            r"|NARCOTICS\s+ANONYMOUS|BROOK\s+YOUNG\s+PEOPLE|COCAINE\s+ANONYMOUS|PRIORY\s+HEALTHCARE"
            r"|MSI\s+REPRODUCTIVE|SPIRE\s+HEALTHCARE|PRIORY\s+WELLBEING|TERRENCE\s+HIGGINS|MACMILLAN\s+CANCER"
            r"|NUFFIELD\s+HEALTH|PRIORY\s+HOSPITAL|FAMILY\s+PLANNING|MEDICAL\s+CENTRE|REHABILITATION|LLOYDSPHARMACY"
            r"|VICTIM\s+SUPPORT|BROOK\s+ADVISORY|HEALTH\s+CENTRE|PHYSIOTHERAPY|PSYCHOTHERAPY|SEXUAL\s+HEALTH"
            r"|TURNING\s+POINT|MENTAL\s+HEALTH|ORTHODONTICS|PSYCHOLOGIST|PSYCHIATRIST|CHIROPRACTOR|PRESCRIPTION"
            r"|PRIORY\s+GROUP|MARIE\s+STOPES|ORTHODONTIC|COUNSELLING|PUSH\s+DOCTOR|RAPE\s+CRISIS|SHOUT\s+85258"
            r"|YOUNG\s+MINDS|GP\s+SURGERY|COUNSELING|COUNSELLOR|PSYCHOLOGY|PSYCHIATRY|HEALTHCARE|BETTERHELP"
            r"|SAMARITANS|WOMENS\s+AID|YOUNGMINDS|DENTISTRY|THERAPIST|OSTEOPATH|FERTILITY|OPTICIANS|TALKSPACE"
            r"|CHILDLINE|GENDER\s+GP|DENTISTS|PHARMACY|CHEMISTS|HOSPITAL|OPTICIAN|ABORTION|MERMAIDS|GENDERGP"
            r"|DENTIST|CHEMIST|SURGERY|THERAPY|DOCTORS|MEDICAL|HOSPICE|AL\s+ANON|AL-ANON|CLINIC|DENTAL|PHYSIO"
            r"|DOCTOR|REFUGE|RELATE|REHAB|DETOX|CRUSE|BPAS|BUPA|LIVI|MIND|NHS|IVF|HIV|GP)(?![A-Z0-9])",
            re.A,
        ),
    ),
    (
        "gambling",
        re.compile(
            r"(?:^|[^A-Z0-9])(?:GAMBLERS\s+ANONYMOUS|NATIONAL\s+LOTTERY|SPORTING\s+INDEX|WILLIAM\s+HILL"
            r"|VIRGIN\s+GAMES|EUROMILLIONS|PADDY\s+POWER|WILLIAMHILL|BOYLESPORTS|PADDYPOWER|POKERSTARS|PARTYPOKER"
            r"|JACKPOTJOY|BOOKMAKERS|LADBROKES|888CASINO|BETVICTOR|GROSVENOR|BOOKMAKER|LOTTOLAND|888SPORT|SPREADEX"
            r"|BET\s+365|SKY\s+BET|BETFAIR|BETFRED|TOMBOLA|LOTTERY|BETTING|GAMCARE|BET365|SKYBET|BETWAY|UNIBET"
            r"|CASINO|BETANO|PUNTER|CORAL|POKER|BINGO|LOTTO|SLOTS|GALA|888)(?![A-Z0-9])",
            re.A,
        ),
    ),
    (
        "dating",
        re.compile(
            r"(?:^|[^A-Z0-9])(?:COFFEE\s+MEETS\s+BAGEL|PLENTY\s+OF\s+FISH|ELITE\s+SINGLES|PLENTYOFFISH|ELITESINGLES"
            r"|INNER\s+CIRCLE|MATCH\s+GROUP|MATCH\s+COM|EHARMONY|OKCUPID|HER\s+APP|TINDER|BUMBLE|GRINDR|DATING"
            r"|SCRUFF|HINGE|FEELD|BADOO|ZOOSK|RAYA|LUXY|POF)(?![A-Z0-9])",
            re.A,
        ),
    ),
    (
        "politics",
        re.compile(
            r"(?:^|[^A-Z0-9])(?:CONSERVATIVE\s+AND\s+UNIONIST|SCOTTISH\s+NATIONAL\s+PARTY|CONSERVATIVE\s+PARTY"
            r"|LIBERAL\s+DEMOCRATS|POLITICAL\s+PARTY|ALLIANCE\s+PARTY|CONSERVATIVES|LABOUR\s+PARTY|GREEN\s+PARTY"
            r"|PLAID\s+CYMRU|YOUR\s+PARTY|REFORM\s+UK|SINN\s+FEIN|LIB\s+DEMS|MOMENTUM|LIBDEMS|LABOUR|UKIP|SDLP|SNP"
            r"|DUP)(?![A-Z0-9])",
            re.A,
        ),
    ),
    (
        "union",
        re.compile(
            r"(?:^|[^A-Z0-9])(?:ROYAL\s+COLLEGE\s+OF\s+NURSING|UNITE\s+THE\s+UNION|COMMUNITY\s+UNION"
            r"|MUSICIANS\s+UNION|PROSPECT\s+UNION|EQUITY\s+UNION|TRADE\s+UNION|PCS\s+UNION|UNISON|NASUWT|ASLEF"
            r"|USDAW|NAHT|GMB|NEU|UCU|RMT|CWU|RCN|BMA|FBU|EIS|NUJ)(?![A-Z0-9])",
            re.A,
        ),
    ),
    (
        "religion",
        re.compile(
            r"(?:^|[^A-Z0-9])(?:ISLAMIC\s+RELIEF|SALVATION\s+ARMY|CHRISTIAN\s+AID|KINGDOM\s+HALL|MINISTRIES"
            r"|SYNAGOGUE|CATHEDRAL|CHRISTIAN|GURDWARA|BUDDHIST|TZEDAKAH|TEARFUND|DIOCESE|ISLAMIC|QUAKERS|SADAQAH"
            r"|CHURCH|MOSQUE|TEMPLE|MANDIR|PARISH|CHAPEL|MUSLIM|JEWISH|QUAKER|HINDU|TITHE|ZAKAT|SIKH)(?![A-Z0-9])",
            re.A,
        ),
    ),
    (
        "debt",
        re.compile(
            r"(?:^|[^A-Z0-9])(?:CABOT\s+FINANCIAL|DEBT\s+COLLECTION|DEBT\s+MANAGEMENT|LENDING\s+STREAM"
            r"|LINK\s+FINANCIAL|CREDIT\s+RESOLVE|LENDINGSTREAM|POLAR\s+CREDIT|ARROW\s+GLOBAL|BRIGHTHOUSE"
            r"|RESOLVECALL|STEPCHANGE|QUICKQUID|MR\s+LENDER|CASHFLOAT|MONEYBOAT|PROVIDENT|PRA\s+GROUP|MOORCROFT"
            r"|BAILIFFS|CAPQUEST|BW\s+LEGAL|SATSUMA|PAYPLAN|BAILIFF|MARSTON|PAYDAY|DRAFTY|PEACHY|LOWELL|INTRUM"
            r"|WONGA|CABOT|HOIST|DEBT|IVA)(?![A-Z0-9])",
            re.A,
        ),
    ),
    (
        "adult",
        re.compile(
            r"(?:^|[^A-Z0-9])(?:ANN\s+SUMMERS|CHATURBATE|LIVEJASMIN|CLIPS4SALE|STRIPCHAT|LOVEHONEY|ADULTWORK"
            r"|ONLYFANS|BRAZZERS|MANYVIDS|SEX\s+SHOP|XHAMSTER|PORNHUB|CAMSODA|ESCORTS|FANSLY|ESCORT|ADULT"
            r"|XXX)(?![A-Z0-9])",
            re.A,
        ),
    ),
)

# packages/ownership/src/resolve.ts
ACQUIRER_PREFIXES = ("SQ", "SUMUP", "SUM UP", "ZETTLE", "IZ", "IZETTLE")
INDEPENDENT_KEYWORDS = (
    "CAFE", "DELI", "BAKERY", "BUTCHER", "BUTCHERS", "BARBER", "BARBERS", "FISH BAR", "KEBAB", "FLORIST",
    "NEWSAGENT", "NEWSAGENTS", "OFF LICENCE", "TAKEAWAY",
)
TIER_RANK = {"CURATED": 4, "EXACT_ID": 3, "NAME_MATCH": 2, "LLM_GUESS": 1}
METHOD_RANK = {"exact": 3, "domain": 2, "joined": 1, "near": 0}
VENUE_FIRST = frozenset({
    "RESTAURANTE", "RESTAURANT", "RISTORANTE", "TRATTORIA", "OSTERIA", "PIZZERIA", "TABERNA", "TAVERNA", "TASCA",
    "CERVECERIA", "MARISQUERIA", "ASADOR", "BRASSERIE",
})
FOOD_AND_DRINK = re.compile(
    r"^(?:coffee_fast_food|pub|amenity/(?:restaurant|fast_food|cafe|bar|pub|biergarten|ice_cream|food_court)"
    r"|shop/(?:bakery|pastry|coffee|deli))\Z",
    re.A,
)
ARTICLE = re.compile(r"^(?:LA|EL|LE|IL|LO|LES|LOS|LAS|THE|DA|DE|DI|DEL|DES|DU)\Z", re.A)
SHORTHAND = {
    "AMZN": "AMAZON", "AMZ": "AMAZON", "MKTP": "MARKETPLACE", "MKTPL": "MARKETPLACE", "MKTPLACE": "MARKETPLACE",
    "SMKT": "SUPERMARKET", "SMKTS": "SUPERMARKET", "SPRMKT": "SUPERMARKET", "SUPERMKT": "SUPERMARKET",
    "SPMKT": "SUPERMARKET", "SAINSBURY": "SAINSBURYS", "SAINSBURYSS": "SAINSBURYS", "MORRISON": "MORRISONS",
    "MCDONALD": "MCDONALDS", "MCD": "MCDONALDS", "MACDONALDS": "MCDONALDS", "WETHERSPOON": "WETHERSPOONS",
    "JDWETHERSPOON": "WETHERSPOONS", "NFLX": "NETFLIX", "SPOTIFYUK": "SPOTIFY", "GOOGLEPLAY": "GOOGLE PLAY",
    "PRIMEVIDEO": "PRIME VIDEO", "FACEBK": "FACEBOOK", "INTL": "INTERNATIONAL", "SVCS": "SERVICES",
    "SVC": "SERVICE", "STN": "STATION", "RSTRNT": "RESTAURANT", "RESTRNT": "RESTAURANT",
}
NOISE_TAIL = frozenset({
    "LTD", "LIMITED", "PLC", "LLP", "UK", "GB", "GBR", "LONDON", "STORE", "STORES", "SHOP", "ONLINE", "CONTACTLESS",
    "PAYMENT", "PURCHASE", "CARD", "DEBIT", "CREDIT", "REF", "REFERENCE", "TXN", "POS", "WWW", "COM", "CO", "HTTPS",
    "HTTP",
})
DOMAIN_RE = re.compile(
    r"(?:^|[^A-Z0-9\-])((?:[A-Z0-9\-]+\.)+(?:CO\.UK|ORG\.UK|COM|NET|ORG|UK|IE|DE|FR|NL|ES|IT|BE|LU|EU|IO|APP|TV|CO"
    r"|SE|DK|NO|FI|AT|CH|PL|PT|US|CA|AU))(?=\Z|[^A-Z0-9.\-]|\.(?![A-Z]))",
    re.A,
)

# packages/ownership/src/open-brands.ts
BROAD = frozenset({"gb", "ie", "001", "150", "154", "155", "039", "151", "eu"})
OPEN_BRANDS_TECHNIQUE = (
    "Name and web address from OpenStreetMap's brand list (name-suggestion-index), linked to Wikidata; owner "
    "from Wikidata's 'parent organisation' / 'owned by' statements (current, controlling stakes only). Not "
    "checked by a person or a company register."
)

# packages/core/src/attribute.ts
FACILITATOR = re.compile(
    r"(?:^|[^A-Z0-9])(SQ|SUMUP|ZETTLE_?|IZETTLE|IZ|PAYPAL|PP|GOOGLE|CRV|SP|TST|KLARNA|CLEARPAY"
    r"|BT)[\t\n\x0b\x0c\r \xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*\*",
    re.A | re.I,
)
CARD_READER_RE = re.compile(
    r"(?:^|[^A-Z0-9])(SQ|SUM ?UP|I?ZETTLE"
    r"|IZ)[\t\n\x0b\x0c\r \xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*_?[\t\n\x0b\x0c\r \xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*\*",
    re.A,
)
CARD_READERS = {
    "SQ": "Square", "SUMUP": "SumUp", "SUM UP": "SumUp", "ZETTLE": "Zettle by PayPal",
    "IZETTLE": "Zettle by PayPal", "IZ": "Zettle by PayPal",
}

# packages/core/src/locate.ts
ALPHA3 = {
    "GBR": "GB", "IRL": "IE", "FRA": "FR", "DEU": "DE", "ESP": "ES", "ITA": "IT", "NLD": "NL", "BEL": "BE",
    "LUX": "LU", "PRT": "PT", "CHE": "CH", "AUT": "AT", "SWE": "SE", "NOR": "NO", "DNK": "DK", "FIN": "FI",
    "POL": "PL", "CZE": "CZ", "SVK": "SK", "HUN": "HU", "GRC": "GR", "CYP": "CY", "MLT": "MT", "HRV": "HR",
    "SVN": "SI", "ROU": "RO", "BGR": "BG", "EST": "EE", "LVA": "LV", "LTU": "LT", "ISL": "IS", "TUR": "TR",
    "USA": "US", "MEX": "MX", "BRA": "BR", "ARG": "AR", "AUS": "AU", "NZL": "NZ", "JPN": "JP", "CHN": "CN",
    "HKG": "HK", "SGP": "SG", "THA": "TH", "IND": "IN", "SAU": "SA", "QAT": "QA", "ISR": "IL", "EGY": "EG",
    "ZAF": "ZA", "KOR": "KR", "TWN": "TW", "MYS": "MY", "IDN": "ID", "PHL": "PH", "VNM": "VN", "JEY": "JE",
    "GGY": "GG", "IMN": "IM", "GIB": "GI",
}
SAFE_ALPHA2 = frozenset({
    "GB", "IE", "FR", "ES", "NL", "PT", "LU", "CH", "SE", "DK", "FI", "PL", "GR", "CZ", "HR", "CY", "MT", "HU",
    "RO", "BG", "SK", "SI", "EE", "LV", "LT", "TR", "AU", "NZ", "JP", "CN", "HK", "SG", "TH", "AE", "SA", "QA",
    "IL", "ZA", "MX", "BR", "AR", "KR", "TW", "JE", "GG", "IM", "GI", "UK",
})
COUNTRY_NAME_EXTRAS = (
    ("UNITED STATES OF AMERICA", "US"), ("NORTHERN IRELAND", "GB"), ("UNITED KINGDOM", "GB"),
    ("UNITED STATES", "US"), ("GREAT BRITAIN", "GB"), ("DEUTSCHLAND", "DE"), ("OSTERREICH", "AT"),
    ("NEDERLAND", "NL"), ("SCOTLAND", "GB"), ("ENGLAND", "GB"), ("HOLLAND", "NL"), ("SCHWEIZ", "CH"),
    ("ESPANA", "ES"), ("ITALIA", "IT"), ("SUISSE", "CH"), ("WALES", "GB"),
)
TLD_COUNTRY = {
    "CO.UK": "GB", "UK": "GB", "IE": "IE", "FR": "FR", "DE": "DE", "ES": "ES", "IT": "IT", "NL": "NL", "BE": "BE",
    "LU": "LU", "PT": "PT", "AT": "AT", "CH": "CH", "SE": "SE", "DK": "DK", "NO": "NO", "FI": "FI", "PL": "PL",
    "GR": "GR", "CZ": "CZ", "JP": "JP", "AU": "AU", "COM.AU": "AU", "NZ": "NZ", "CO.NZ": "NZ", "CA": "CA",
    "COM.BR": "BR", "MX": "MX", "COM.MX": "MX", "IN": "IN", "CO.IN": "IN",
}
US_STATES = frozenset({
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA",
    "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
    "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
})
FILLER = frozenset({
    "THE", "A", "AN", "AND", "OF", "LE", "LA", "LES", "EL", "DE", "DA", "DI", "IL", "AT", "TO", "YE", "OLD", "NEW",
    "BAR", "CAFE", "PUB", "INN",
})
CURRENCY_COUNTRY = {
    "USD": ("US", "US dollars"), "CAD": ("CA", "Canadian dollars"), "AUD": ("AU", "Australian dollars"),
    "NZD": ("NZ", "New Zealand dollars"), "JPY": ("JP", "Japanese yen"), "CNY": ("CN", "Chinese yuan"),
    "HKD": ("HK", "Hong Kong dollars"), "SGD": ("SG", "Singapore dollars"), "THB": ("TH", "Thai baht"),
    "VND": ("VN", "Vietnamese dong"), "IDR": ("ID", "Indonesian rupiah"), "MYR": ("MY", "Malaysian ringgit"),
    "PHP": ("PH", "Philippine pesos"), "KRW": ("KR", "South Korean won"), "TWD": ("TW", "Taiwan dollars"),
    "INR": ("IN", "Indian rupees"), "LKR": ("LK", "Sri Lankan rupees"), "AED": ("AE", "UAE dirhams"),
    "SAR": ("SA", "Saudi riyals"), "QAR": ("QA", "Qatari riyals"), "ILS": ("IL", "Israeli shekels"),
    "EGP": ("EG", "Egyptian pounds"), "MAD": ("MA", "Moroccan dirhams"), "TRY": ("TR", "Turkish lira"),
    "ZAR": ("ZA", "South African rand"), "KES": ("KE", "Kenyan shillings"), "MXN": ("MX", "Mexican pesos"),
    "BRL": ("BR", "Brazilian reais"), "ARS": ("AR", "Argentine pesos"), "COP": ("CO", "Colombian pesos"),
    "PEN": ("PE", "Peruvian soles"), "CHF": ("CH", "Swiss francs"), "NOK": ("NO", "Norwegian kroner"),
    "SEK": ("SE", "Swedish kronor"), "DKK": ("DK", "Danish kroner"), "ISK": ("IS", "Icelandic kr\xf3nur"),
    "PLN": ("PL", "Polish z\u0142oty"), "CZK": ("CZ", "Czech koruna"), "HUF": ("HU", "Hungarian forint"),
    "RON": ("RO", "Romanian lei"), "RSD": ("RS", "Serbian dinars"),
}
PAID_IN_RE = re.compile(
    r"\b(?:(USD|CAD|AUD|NZD|JPY|CNY|HKD|SGD|THB|VND|IDR|MYR|PHP|KRW|TWD|INR|LKR|AED|SAR|QAR|ILS|EGP|MAD|TRY|ZAR|KES"
    r"|MXN|BRL|ARS|COP|PEN|CHF|NOK|SEK|DKK|ISK|PLN|CZK|HUF|RON|RSD) ?\d[\d,]*\.\d{2}|(JPY|KRW|VND|IDR|ISK|HUF"
    r"|TWD) (?:\d{1,3}(?:,\d{3})+|\d{3,}))(?![\d.,])|(?<![\d.,])(?:\d[\d,]*\.\d{2} ?(USD|CAD|AUD|NZD|JPY|CNY|HKD"
    r"|SGD|THB|VND|IDR|MYR|PHP|KRW|TWD|INR|LKR|AED|SAR|QAR|ILS|EGP|MAD|TRY|ZAR|KES|MXN|BRL|ARS|COP|PEN|CHF|NOK|SEK"
    r"|DKK|ISK|PLN|CZK|HUF|RON|RSD)|(?:\d{1,3}(?:,\d{3})+|\d{3,}) (JPY|KRW|VND|IDR|ISK|HUF|TWD))(?![\w\-])",
    re.A,
)
EVIDENCE_LABEL = {
    "country_code": "country code on your statement", "country_name": "country named on your statement",
    "place": "town named on your statement", "web_domain": "the shop's web address",
    "currency": "the currency the shop charged in", "home": "paid at home (nothing foreign on the statement)",
}

# packages/core/data/places.json
# Town and city names from GeoNames (https://www.geonames.org), CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/),
# reduced to names and country codes.
PLACES_BY_COUNTRY = {
    "AE": (
        "ABU DHABI|AJMAN|AL AIN|AL AIN CITY|AL KARAMA|AL MAJAZ|AL SAJAAH|AL SHAMKHAH CITY|AL WARQAA|AR RUMAYLAH|"
        "BANI YAS CITY|BUSINESS BAY|DAYRAH|DUBAI|DUBAI FESTIVAL CITY|DUBAI INVESTMENTS PARK|DUBAI MARINA|"
        "DUBAI SILICON OASIS|FUJAIRAH|HAWR AL ANZ|INTERNATIONAL CITY|JEBEL ALI|KHALIFAH A CITY|LAHBAB|MIRDIF|"
        "MOHAMMED BIN ZAYED CITY|MUSAFFAH|NAYF|RAS AL KHAIMAH|REEF AL FUJAIRAH CITY|SHARJAH|TARIF KALBA|"
        "UMM AL QUWAIN CITY|WARISAN|ZAYED CITY"
    ),
    "AF": (
        "BAGHLAN|BAGRAM|BALKH|BAMYAN|BAZAR E YAKAWLANG|BAZARAK|CHARIKAR|GARDEZ|GHAZNI|HERAT|JALALABAD|KABUL|"
        "KANDAHAR|KHANABAD|KHOST|KHULM|KUNDUZ|MAYMANA|MAZAR E SHARIF|PUL E KHUMRI|SAR E PUL|SHIBIRGHAN|TALOQAN"
    ),
    "AG": "SAINT JOHNS", "AL": "BERAT|DURRES|ELBASAN|FIER|FIER CIFCI|KORCE|KRUJE|LUSHNJE|SHKODER|TIRANA|VLORE",
    "AM": (
        "ABOVYAN|AJAPNYAK|ARABKIR|AVAN|DAVTASHEN|EREBUNI|GYUMRI|KANAKER ZEYTUN|KENTRON|MALATIA SEBASTIA|NOR NORK|"
        "SHENGAVIT|VANADZOR|YEREVAN"
    ),
    "AO": (
        "ANDULO|BAIA FARTA|BAILUNDO|BALOMBO|BARRA DO DANDE|BENFICA|BENGUELA|BOCOIO|CAALA|CABINDA|CACUACO|CAFUNFO|"
        "CAHAMA|CALUMBO|CAMACUPA|CAMAMA|CAMUCUIO|CANGANDALA|CATCHIUNGO|CATUMBELA|CAXITO|CAZENGA|CELA|CHITATO|"
        "CUANGO LUZAMBA|CUBAL|CUITO|DONDO|DUNDO|ECUNNA|GABELA|GAMA|GANDA|GOLFE|HOJI YA HENDA|HUAMBO|INGOMBOTA|"
        "KIKOLO|KILAMBA|KIMA KIEZA|LOBITO|LONGONJO|LUANDA|LUAU|LUBANGO|LUCAPA|LUENA|LUQUEMBO|MAIANGA|MALANJE|"
        "MATALA|MBANZA KONGO|MENONGUE|MOSSAMEDES|MULENVOS|NAVEGANTES|NDALATANDO|NEGAGE|NOVA VIDA|NZAGI|ONDJIVA|"
        "PANGUILA|PORTO AMBOIM|QUISSECULA|RAMIROS|RANGEL|SAMBA|SAMBIZANGA|SAURIMO|SOYO|SUMBE|TALATONA|UIGE|VIANA|"
        "VILA FLOR|ZANGO"
    ),
    "AR": (
        "AVELLANEDA|AZUL|BAHIA BLANCA|BALVANERA|BANFIELD|BARRACAS|BARRANQUERAS|BELGRANO|BELLA VISTA|BERAZATEGUI|"
        "BERISSO|BUENOS AIRES|BURZACO|CALETA OLIVIA|CAMPANA|CASTELAR|CATAMARCA|CHIMBAS|CHIVILCOY|CIPOLLETTI|"
        "CIUDAD DE LAS HERAS|COLEGIALES|COMODORO RIVADAVIA|CONCEPCION DEL URUGUAY|CONCORDIA|CORDOBA|CORRIENTES|"
        "DON TORCUATO|EL PALOMAR|ELDORADO|ENSENADA|EZEIZA|FORMOSA|GENERAL PICO|GENERAL ROCA|GOBERNADOR GALVEZ|"
        "GOYA|GUALEGUAYCHU|HURLINGHAM|ISIDRO CASANOVA|ITUZAINGO|JOSE C PAZ|JUNIN|LA PLATA|LA RIOJA|LAFERRERE|"
        "LANUS|LOMAS DE ZAMORA|LOS POLVORINES|LUJAN|MAR DEL PLATA|MAR DEL TUYU|MENDOZA|MERLO|MONTE CHINGOLO|"
        "MORENO|NECOCHEA|NEUQUEN|OBERA|OLAVARRIA|PALERMO|PARANA|PERGAMINO|PILAR|PLOTTIER|POSADAS|"
        "PRESIDENCIA ROQUE SAENZ PENA|PUERTO MADRYN|PUNTA ALTA|QUILMES|RAFAELA|RAWSON|RECONQUISTA|"
        "REMEDIOS DE ESCALADA DE SAN MARTIN|RESISTENCIA|RIO CUARTO|RIO GALLEGOS|RIO GRANDE|RIO TERCERO|ROSARIO|"
        "SALTA|SAN CARLOS DE BARILOCHE|SAN FRANCISCO|SAN JUAN|SAN JUSTO|SAN LUIS|SAN MARTIN|SAN MIGUEL|"
        "SAN MIGUEL DE TUCUMAN|SAN NICOLAS DE LOS ARROYOS|SAN PEDRO DE JUJUY|SAN RAFAEL|"
        "SAN RAMON DE LA NUEVA ORAN|SAN SALVADOR DE JUJUY|SAN VICENTE|SANTA FE|SANTA LUCIA|SANTA ROSA|"
        "SANTIAGO DEL ESTERO|SANTO TOME|SARANDI|TANDIL|TARTAGAL|TRELEW|TRES ARROYOS|USHUAIA|VENADO TUERTO|"
        "VILLA CARLOS PAZ|VILLA LUGANO|VILLA MARIA|VILLA MERCEDES|YERBA BUENA|ZARATE"
    ),
    "AT": (
        "ASPERN|BRIGITTENAU|DOBLING|DOEBLING|DONAUSTADT|EISENZICKEN|FAVORITEN|FLORIDSDORF|FUENFHAUS|FUNFHAUS|"
        "GRAZ|HERNALS|HIETZING|INNSBRUCK|KLAGENFURT AM WOERTHERSEE|KLAGENFURT AM WORTHERSEE|LANDSTRASSE|LINZ|"
        "MARGARETEN|MEIDLING|OTTAKRING|PENZING|SALZBURG|SIMMERING|VIENNA|VILLACH|WAEHRING|WAHRING|WIEN"
    ),
    "AU": (
        "ADELAIDE|ADELAIDE HILLS|BALLARAT|BENDIGO|BERWICK|BLUE MOUNTAINS|BRISBANE|BUNBURY|BUNDABERG|CAIRNS|"
        "CALOUNDRA|CANBERRA|CENTRAL COAST|CITY OF PORT PHILLIP|COFFS HARBOUR|CRAIGIEBURN|GEELONG|GOLD COAST|"
        "HERVEY BAY|HOBART|LAUNCESTON|LOGAN|LOGAN CITY|MACKAY|MAITLAND|MANDURAH|MELBOURNE|MELBOURNE CITY CENTRE|"
        "NEWCASTLE|PAKENHAM|PERTH|PITTWATER|POINT COOK|PORT MACQUARIE|ROCKHAMPTON|SUNSHINE COAST|SYDNEY|TARNEIT|"
        "TOOWOOMBA|TOWNSVILLE|TUGGERANONG|WERRIBEE|WOLLONGONG"
    ),
    "AZ": (
        "BAKIXANOV|BAKU|GANJA|KHIRDALAN|LANKARAN|LERIK|MINGACHEVIR|NAXCIVAN|QARACUXUR|SHEKI|SIRVAN|SUMGAYIT|"
        "XACMAZ|YEVLAKH"
    ),
    "BA": "BANJA LUKA|BIHAC|ILIDZA|MOSTAR|SARAJEVO|TUZLA|ZENICA", "BB": "BRIDGETOWN",
    "BD": (
        "ASHUGANJ CITY|AZIMPUR|BAGERHAT|BANDARBAN|BARISHAL|BHAIRAB BAZAR|BHATARA|BHOLA|BIBIR HAT|BOGRA|"
        "BRAHMANBARIA|CHANDPUR|CHATTOGRAM|COMILLA|COXS BAZAR|DHAKA|DHANMONDI|DINAJPUR|FARIDPUR|FENI|GAZIPUR|"
        "GOPALGANJ|GULSHAN|HABIGANJ|HATHAZARI|ISHWARDI|JAMALPUR|JESSORE|JOYPUR HAT|KAFRUL|KARNAPHULI|"
        "KHAGRACHHARI|KHULNA|KISHORGANJ|KUSHTIA|LAKSHAM|LAKSHMIPUR|LALMONIRHAT|MADARIPUR|MAIJDI|MANIKGANJ|"
        "MAULAVI BAZAR|MIRPUR MODEL THANA|MOHAMMADPUR|MOTIJHEEL|MYMENSINGH|NAGAR NALUAKOT|NAGARPUR|NARAIL|"
        "NARAYANGANJ|NARSINGDI|NATORE|NAWABGANJ|NETRAKONA|PABNA|PALANG|PALLABI|PALTAN|PAR NAOGAON|PATIYA|"
        "PATUAKHALI|PIROJPUR|PUTHIA|RAIPUR|RAJSHAHI|RAMGANJ|RAMNA MAIDAN|RANGAMATI|RANGPUR|SAIDPUR|SANDWIP|"
        "SARISHABARI|SATKANIA|SATKHIRA|SAVAR|SHAHZADPUR|SHERPUR|SHIBGANJ|SIRAJGANJ|SONARGAON|SUNAMGANJ|SYLHET|"
        "TANGAIL|THAKURGAON|TUNGI|TUNGIPARA"
    ),
    "BE": (
        "AALST|ANDERLECHT|ANTWERP|ANTWERPEN|BRUGGE|BRUSSEL|BRUSSELS|BRUXELLES|CHARLEROI|DEURNE|GENK|GENT|HASSELT|"
        "IXELLES|JETTE|KORTRIJK|LA LOUVIERE|LEUVEN|LIEGE|MECHELEN|MOLENBEEK SAINT JEAN|MONS|MOUSCRON|NAMUR|"
        "OSTEND|ROESELARE|SAINT GILLES|SCHAERBEEK|SERAING|SINT NIKLAAS|TOURNAI|UCCLE|VERVIERS|"
        "WOLUWE SAINT LAMBERT"
    ),
    "BF": (
        "BANFORA|BOBO DIOULASSO|DEDOUGOU|DJIBO|FADA NGOURMA|HOUNDE|KAYA|KONGOUSSI|KOUDOUGOU|NIOKO I|OUAGADOUGOU|"
        "OUAHIGOUYA|POUYTENGA|SAABA|TENKODOGO"
    ),
    "BG": (
        "ASENOVGRAD|BLAGOEVGRAD|BURGAS|DOBRICH|HASKOVO|PAZARDZHIK|PERNIK|PLEVEN|PLOVDIV|RUSE|SHUMEN|SLIVEN|SOFIA|"
        "STARA ZAGORA|VARNA|VELIKO TURNOVO|YAMBOL"
    ),
    "BH": "AL MUHARRAQ|AR RIFA|DAR KULAYB|JIDD HAFS|MADINAT HAMAD|MANAMA|SITRAH",
    "BI": "BUJUMBURA|GITEGA|MPANDA|NGOZI|RUMONGE",
    "BJ": (
        "ABOMEY|ABOMEY CALAVI|BOHICON|COTONOU|DJOUGOU|EKPE|GODOME|KANDI|KEROU|MALANVILLE|NATITINGOU|PARAKOU|"
        "PORTO NOVO"
    ),
    "BN": "BANDAR SERI BEGAWAN",
    "BO": (
        "COCHABAMBA|COLCAPIRHUA|LA PAZ|MONTERO|ORURO|POTOSI|QUILLACOLLO|RIBERALTA|SACABA|SANTA CRUZ DE LA SIERRA|"
        "SUCRE|TARIJA|TIQUIPAYA|VIACHA|VINTO|YACUIBA"
    ),
    "BR": (
        "ABAETETUBA|ABREU E LIMA|ACAILANDIA|ACARA|ACARAU|ACOPIARA|AGUA RASA|AGUAS CLARAS|AGUAS LINDAS DE GOIAS|"
        "ALAGOINHAS|ALEGRETE|ALENQUER|ALFENAS|ALMIRANTE TAMANDARE|ALTAMIRA|ALVORADA|AMERICANA|AMPARO|ANANINDEUA|"
        "ANAPOLIS|ANDRADAS|ANDRADINA|ANGRA DOS REIS|ANHANGUERA|APARECIDA DE GOIANIA|APUCARANA|AQUIRAZ|ARACAJU|"
        "ARACATUBA|ARACRUZ|ARAGUAINA|ARAGUARI|ARAPIRACA|ARAPONGAS|ARARANGUA|ARARAQUARA|ARARAS|ARARIPINA|ARARUAMA|"
        "ARAUCARIA|ARAXA|ARCOVERDE|ARICANDUVA|ARIQUEMES|ARTUR ALVIM|ARTUR NOGUEIRA|ARUJA|ASSIS|ATIBAIA|AVARE|"
        "BACABAL|BAGE|BAIRRO DA PENHA|BAIRRO PARQUE NOSSA SENHORA DO CARMO|BALNEARIO CAMBORIU|BALSAS|BARBACENA|"
        "BARBALHA|BARCARENA|BARRA|BARRA DA TIJUCA|BARRA DO CORDA|BARRA DO GARCAS|BARRA DO PIRAI|BARRA MANSA|"
        "BARREIRAS|BARREIRINHAS|BARRETOS|BARUERI|BATATAIS|BAURU|BAYEUX|BEBEDOURO|BEBERIBE|BELA VISTA|BELEM|"
        "BELFORD ROXO|BELO HORIZONTE|BELO JARDIM|BENEVIDES|BENTO GONCALVES|BERTIOGA|BETIM|BEZERROS|BIGUACU|"
        "BIRIGUI|BLUMENAU|BOA VIAGEM|BOA VISTA|BOITUVA|BOM DESPACHO|BOM JESUS DA LAPA|BOSQUE SAUDE|BOTAFOGO|"
        "BOTUCATU|BRAGANCA|BRAGANCA PAULISTA|BRASILANDIA|BRASILIA|BRAZLANDIA|BREJO DA MADRE DE DEUS|BREU BRANCO|"
        "BREVES|BRUMADO|BRUSQUE|BUIQUE|BURITICUPU|BUTANTA|CABEDELO|CABO DE SANTO AGOSTINHO|CABO FRIO|CACADOR|"
        "CACAPAVA|CACERES|CACHOEIRA DO SUL|CACHOEIRAS DE MACACU|CACHOEIRINHA|CACHOEIRO DE ITAPEMIRIM|CACOAL|"
        "CAETITE|CAICO|CAIEIRAS|CAJAMAR|CAJAZEIRAS|CALDAS NOVAS|CAMACARI|CAMAQUA|CAMARAGIBE|CAMBE|CAMBORIU|"
        "CAMETA|CAMOCIM|CAMPINA GRANDE|CAMPINAS|CAMPO BELO|CAMPO BOM|CAMPO FORMOSO|CAMPO GRANDE|CAMPO LARGO|"
        "CAMPO LIMPO|CAMPO LIMPO PAULISTA|CAMPO MOURAO|CAMPOS DO JORDAO|CAMPOS DOS GOYTACAZES|CANDEIAS|CANGAIBA|"
        "CANGUCU|CANINDE|CANOAS|CANOINHAS|CAPANEMA|CAPAO DA CANOA|CAPAO REDONDO|CAPITAO POCO|CAPIVARI|"
        "CARAGUATATUBA|CARAPICUIBA|CARATINGA|CARAZINHO|CARIACICA|CARPINA|CARRAO|CARUARU|CASA NOVA|CASA VERDE|"
        "CASCAVEL|CASTANHAL|CATAGUASES|CATALAO|CATANDUVA|CAUCAIA|CAXIAS|CAXIAS DO SUL|CEARA MIRIM|CEILANDIA|"
        "CHAPADINHA|CHAPECO|CIANORTE|CIDADE ADEMAR|CIDADE DUTRA|CIDADE LIDER|CIDADE OCIDENTAL|CIDADE TIRADENTES|"
        "COARI|CODO|COLATINA|COLOMBO|CONCEICAO DO COITE|CONCORDIA|CONGONHAS|CONSELHEIRO LAFAIETE|CONSOLACAO|"
        "CONTAGEM|COPACABANA|COROATA|CORONEL FABRICIANO|CORUMBA|CORURIPE|COSMOPOLIS|COTIA|CRATEUS|CRATO|CRICIUMA|"
        "CRISTALINA|CRUZ ALTA|CRUZ DAS ALMAS|CRUZEIRO|CRUZEIRO DO SUL|CUBATAO|CUIABA|CURITIBA|CURSINO|CURVELO|"
        "DELMIRO GOUVEIA|DIADEMA|DIAS DAVILA|DIVINOPOLIS|DOM ELISEU|DOURADOS|DUQUE DE CAXIAS|EMBU DAS ARTES|"
        "EMBU GUACU|ERECHIM|ERMELINO MATARAZZO|ESCADA|ESMERALDAS|ESTANCIA|ESTANCIA VELHA|ESTEIO|"
        "EUCLIDES DA CUNHA|EUNAPOLIS|EUSEBIO|EXTREMA|EXTREMOZ|FARROUPILHA|FAZENDA RIO GRANDE|FEIRA DE SANTANA|"
        "FERNANDOPOLIS|FERRAZ DE VASCONCELOS|FLORIANO|FLORIANOPOLIS|FORMIGA|FORMOSA|FORTALEZA|FOZ DO IGUACU|"
        "FRANCA|FRANCISCO BELTRAO|FRANCISCO MORATO|FRANCO DA ROCHA|FREGUESIA DO O|FRUTAL|GAMA|GARANHUNS|GASPAR|"
        "GOIANA|GOIANESIA|GOIANIA|GOVERNADOR VALADARES|GRAJAU|GRANJA|GRAVATA|GRAVATAI|GUAIANASES|GUAIBA|GUANAMBI|"
        "GUAPIMIRIM|GUARA|GUARABIRA|GUARAPARI|GUARAPUAVA|GUARATINGUETA|GUARUJA|GUARULHOS|GUAXUPE|GURUPI|"
        "HORIZONTE|HORTOLANDIA|HUMAITA|IBIPORA|IBIRITE|IBITINGA|IBIUNA|ICARA|IGARAPE MIRI|IGARASSU|IGUATEMI|"
        "IGUATU|IJUI|ILHEUS|IMBITUBA|IMPERATRIZ|INDAIAL|INDAIATUBA|INHUMAS|IPATINGA|IPIRA|IPIRANGA|"
        "IPIXUNA DO PARA|IPOJUCA|IRATI|IRECE|ITABAIANA|ITABERABA|ITABIRA|ITABIRITO|ITABORAI|ITABUNA|ITACOATIARA|"
        "ITAGUAI|ITAIM BIBI|ITAIM PAULISTA|ITAITUBA|ITAJAI|ITAJUBA|ITAMARAJU|ITANHAEM|ITAPAGE|"
        "ITAPECERICA DA SERRA|ITAPECURU MIRIM|ITAPEMA|ITAPERUNA|ITAPETINGA|ITAPETININGA|ITAPEVA|ITAPEVI|"
        "ITAPIPOCA|ITAPIRA|ITAPOA|ITAQUAQUECETUBA|ITAQUERA|ITATIBA|ITAUNA|ITUIUTABA|ITUMBIARA|ITUPIRANGA|"
        "JABAQUARA|JABOATAO DOS GUARARAPES|JABOTICABAL|JACANA|JACAREI|JACOBINA|JACUNDA|JAGUAQUARA|JAGUARE|"
        "JAGUARIUNA|JANAUBA|JANDIRA|JANUARIA|JAPERI|JARAGUA|JARAGUA DO SUL|JARDIM ANGELA|JARDIM BOTANICO|"
        "JARDIM HELENA|JARDIM PAULISTA|JARDIM SAO LUIS|JARU|JATAI|JEQUIE|JI PARANA|JOAO MONLEVADE|JOAO PESSOA|"
        "JOINVILLE|JOSE BONIFACIO|JUAZEIRO|JUAZEIRO DO NORTE|JUIZ DE FORA|JUNDIAI|JURUTI|LAGARTO|LAGES|"
        "LAGOA DA PRATA|LAGOA SANTA|LAJEADO|LAPA|LAURO DE FREITAS|LAVRAS|LEME|LENCOIS PAULISTA|LEOPOLDINA|"
        "LIBERDADE|LIMAO|LIMEIRA|LIMOEIRO|LIMOEIRO DO NORTE|LINHARES|LINS|LONDRINA|LORENA|LOUVEIRA|"
        "LUCAS DO RIO VERDE|LUIS EDUARDO MAGALHAES|LUZIANIA|MACAE|MACAIBA|MACAPA|MACAUBAS|MACEIO|MAFRA|MAGE|"
        "MAIRIPORA|MANACAPURU|MANAUS|MANDAQUI|MANHUACU|MANICORE|MARABA|MARACANAU|MARANGUAPE|"
        "MARECHAL CANDIDO RONDON|MARECHAL DEODORO|MARIANA|MARICA|MARILIA|MARINGA|MARITUBA|MATAO|MAUA|MAUES|"
        "MINEIROS|MIRASSOL|MOCOCA|MOEMA|MOGI DAS CRUZES|MOGI GUACU|MOGI MIRIM|MOJU|MONGAGUA|MONTE ALEGRE|"
        "MONTE ALTO|MONTE MOR|MONTENEGRO|MONTES CLAROS|MOOCA|MORADA NOVA|MORENO|MORRINHOS|MORUMBI|MOSSORO|MURIAE|"
        "NATAL|NAVEGANTES|NAVIRAI|NILOPOLIS|NITEROI|NOSSA SENHORA DO SOCORRO|NOVA FRIBURGO|NOVA IGUACU|NOVA LIMA|"
        "NOVA ODESSA|NOVA SERRANA|NOVA VENECIA|NOVO GAMA|NOVO HAMBURGO|NOVO REPARTIMENTO|OBIDOS|OLIMPIA|OLINDA|"
        "ORIXIMINA|OSASCO|OURICURI|OURINHOS|OURO PRETO|PACAJUS|PACATUBA|PACO DO LUMIAR|PALHOCA|PALMARES|PALMAS|"
        "PARA DE MINAS|PARACATU|PARAGOMINAS|PARAISO DO TOCANTINS|PARANAGUA|PARANAVAI|PARANOA|PARAUAPEBAS|"
        "PARELHEIROS|PARINTINS|PARNAIBA|PARNAMIRIM|PAROBE|PARQUE DO CARMO|PASSO FUNDO|PASSOS|PATO BRANCO|PATOS|"
        "PATOS DE MINAS|PATROCINIO|PAUDALHO|PAULINIA|PAULISTA|PAULO AFONSO|PEDREIRA|PEDRO LEOPOLDO|PELOTAS|"
        "PENAPOLIS|PENEDO|PERDIZES|PERUIBE|PERUS|PESQUEIRA|PETROLINA|PETROPOLIS|PICOS|PIEDADE|PINDAMONHANGABA|"
        "PINHAIS|PINHEIRO|PINHEIROS|PIRACICABA|PIRAPORA|PIRAQUARA|PIRASSUNUNGA|PIRIPIRI|PIRITUBA|PLANALTINA|"
        "PLANO PILOTO|POCOS DE CALDAS|PONTA GROSSA|PONTA PORA|PONTE NOVA|PONTE RASA|POR DO SOL|PORTEL|"
        "PORTO ALEGRE|PORTO FELIZ|PORTO FERREIRA|PORTO NACIONAL|PORTO SEGURO|PORTO VELHO|POUSO ALEGRE|"
        "PRAIA GRANDE|PRESIDENTE PRUDENTE|QUEIMADOS|QUIXADA|QUIXERAMOBIM|RAPOSO TAVARES|RECANTO DAS EMAS|RECIFE|"
        "REDENCAO|REGISTRO|REPUBLICA|RESENDE|RIACHO FUNDO II|RIBEIRA DO POMBAL|RIBEIRAO DAS NEVES|RIBEIRAO PIRES|"
        "RIBEIRAO PRETO|RIO BONITO|RIO BRANCO|RIO CLARO|RIO DAS OSTRAS|RIO DE JANEIRO|RIO DO SUL|RIO GRANDE|"
        "RIO LARGO|RIO PEQUENO|RIO VERDE|ROLANDIA|ROLIM DE MOURA|RONDON DO PARA|RONDONOPOLIS|RUROPOLIS|RUSSAS|"
        "SABARA|SACOMA|SALGUEIRO|SALTO|SALVADOR|SAMAMBAIA|SANTA BARBARA DOESTE|SANTA CECILIA|"
        "SANTA CRUZ DO CAPIBARIBE|SANTA CRUZ DO SUL|SANTA INES|SANTA ISABEL|SANTA ISABEL DO PARA|SANTA LUZIA|"
        "SANTA MARIA|SANTA RITA|SANTA ROSA|SANTANA|SANTANA DE PARNAIBA|SANTANA DO LIVRAMENTO|SANTAREM|"
        "SANTO AMARO|SANTO ANDRE|SANTO ANGELO|SANTO ANTONIO DE JESUS|SANTO ANTONIO DO DESCOBERTO|SANTO ESTEVAO|"
        "SANTOS|SAO BENTO DO SUL|SAO BERNARDO DO CAMPO|SAO BORJA|SAO CAETANO DO SUL|SAO CARLOS|SAO CRISTOVAO|"
        "SAO DOMINGOS|SAO FELIX DO XINGU|SAO FRANCISCO|SAO FRANCISCO DO SUL|SAO GABRIEL|SAO GABRIEL DA CACHOEIRA|"
        "SAO GONCALO|SAO GONCALO DO AMARANTE|SAO JOAO DA BOA VISTA|SAO JOAO DE MERITI|SAO JOAO DEL REI|SAO JOSE|"
        "SAO JOSE DE RIBAMAR|SAO JOSE DO RIO PARDO|SAO JOSE DO RIO PRETO|SAO JOSE DOS CAMPOS|"
        "SAO JOSE DOS PINHAIS|SAO LEOPOLDO|SAO LOURENCO DA MATA|SAO LUCAS|SAO LUIS|SAO MATEUS|SAO MIGUEL|"
        "SAO MIGUEL DO GUAMA|SAO MIGUEL DOS CAMPOS|SAO PAULO|SAO PEDRO DA ALDEIA|SAO RAFAEL|SAO ROQUE|"
        "SAO SEBASTIAO|SAO SEBASTIAO DO PARAISO|SAO VICENTE|SAPE|SAPIRANGA|SAPOPEMBA|SAPUCAIA DO SUL|SAQUAREMA|"
        "SARANDI|SENADOR CANEDO|SENHOR DO BONFIM|SEROPEDICA|SERRA|SERRA TALHADA|SERRINHA|SERTAOZINHO|SETE LAGOAS|"
        "SIMOES FILHO|SINOP|SOBRADINHO|SOBRADINHO II|SOBRAL|SOROCABA|SORRISO|SOUSA|SUMARE|SURUBIM|SUZANO|"
        "TABATINGA|TABOAO DA SERRA|TAGUATINGA|TAILANDIA|TANGARA DA SERRA|TAQUARA|TAQUARITINGA|TATUAPE|TATUI|TAUA|"
        "TAUBATE|TEFE|TEIXEIRA DE FREITAS|TELEMACO BORBA|TEOFILO OTONI|TERESINA|TERESOPOLIS|TIANGUA|TIJUCAS|"
        "TIMON|TIMOTEO|TOBIAS BARRETO|TOME ACU|TRAIRI|TRAMANDAI|TRES CORACOES|TRES LAGOAS|TRES PONTAS|TRES RIOS|"
        "TRINDADE|TUBARAO|TUCURUI|TUCURUVI|TUPA|TUTOIA|UBATUBA|UBERABA|UBERLANDIA|UMUARAMA|UNAI|UNIAO DA VITORIA|"
        "UNIAO DOS PALMARES|URUGUAIANA|VACARIA|VALENCA|VALINHOS|VALPARAISO DE GOIAS|VARGEM GRANDE|"
        "VARGEM GRANDE PAULISTA|VARGINHA|VARZEA GRANDE|VARZEA PAULISTA|VENANCIO AIRES|VESPASIANO|VIAMAO|VIANA|"
        "VICENTE PIRES|VICOSA|VICOSA DO CEARA|VIDEIRA|VIGIA|VILA ANDRADE|VILA CURUCA|VILA FORMOSA|VILA GUILHERME|"
        "VILA JACUI|VILA MARIA|VILA MARIANA|VILA MATILDE|VILA MEDEIROS|VILA PRUDENTE|VILA VELHA|VILHENA|VINHEDO|"
        "VISEU|VITORIA|VITORIA DA CONQUISTA|VITORIA DE SANTO ANTAO|VOLTA REDONDA|VOTORANTIM|VOTUPORANGA|XANXERE"
    ),
    "BS": "NASSAU", "BT": "THIMPHU",
    "BW": "FRANCISTOWN|GABORONE|MAUN|MOCHUDI|MOGODITSHANE|MOLEPOLOLE|PALAPYE|SEROWE|TLOKWENG",
    "BY": (
        "BARANOVICHI|BARYSAW|BOBRUYSK|BREST|HOMYEL|HORAD ZHODZINA|HRODNA|KOBRYN|LIDA|MAHILYOW|MALADZIECNA|MAZYR|"
        "MINSK|NOVOPOLOTSK|ORSHA|PINSK|POLOTSK|RECHYTSA|SLUTSK|SOLIGORSK|SVETLOGORSK|VITEBSK|ZHLOBIN"
    ),
    "BZ": "BELIZE CITY",
    "CA": (
        "ABBOTSFORD|AHUNTSIC CARTIERVILLE|AIRDRIE|AJAX|AYLMER|BARRIE|BEAUPORT|BELLEVILLE|BRAMPTON|BRANTFORD|"
        "BRIGHOUSE CITY CENTRE|BROSSARD|BURNABY|CALEDON|CALGARY|CHARLESBOURG|CHICOUTIMI|CHILLIWACK|CHOMEDEY|"
        "CLOVERDALE|CONFEDERATION|COQUITLAM|DARTMOUTH|DOWNTOWN VANCOUVER|DRUMMONDVILLE|EAST HASTINGS|EDMONTON|"
        "ETOBICOKE|FLEETWOOD|FORT GARRY SOUTH|FORT MCMURRAY|FREDERICTON|GATINEAU|GRANBY|GRANDE PRAIRIE|"
        "GREATER SUDBURY|GUELPH|GUILDFORD|HALTON HILLS|JONQUIERE|KAMLOOPS|KANATA|KELOWNA|KITCHENER|"
        "LA CITE LIMOILOU|LA HAUTE SAINT CHARLES|LAKEWOOD|LANGLEY|LAVAL|LE PLATEAU MONT ROYAL|LE SUD OUEST|"
        "LE VIEUX LONGUEUIL|LES RIVIERES|LETHBRIDGE|LEVIS|LONDON|LONGUEUIL|LOWER SACKVILLE|MAPLE RIDGE|MARKHAM|"
        "MEDICINE HAT|MERCIER HOCHELAGA MAISONNEUVE|METROTOWN|MISSISSAUGA|MONCTON|MONTREAL|MONTREAL NORD|NANAIMO|"
        "NEPEAN|NEW WESTMINSTER|NEWMARKET|NIAGARA FALLS|NORFOLK COUNTY|NORTH BAY|NORTH DELTA|NORTH VANCOUVER|"
        "NOTRE DAME DE GRACE|NUTANA SECTOR|OAKVILLE|OSHAWA|OTTAWA|OTTAWA SOUTH|PETERBOROUGH|PICKERING|"
        "PIERREFONDS|PIERREFONDS ROXBORO|PORT COQUITLAM|PRINCE GEORGE|QUEBEC|RED DEER|RENFREW COLLINGWOOD|"
        "REPENTIGNY|RICHMOND HILL|RIVIERE DES PRAIRIES POINTE AUX TREMBLES|ROSEMONT LA PETITE PATRIE|SAANICH|"
        "SAGUENAY|SAINT HUBERT|SAINT HYACINTHE|SAINT JEAN SUR RICHELIEU|SAINT JEROME|SAINT JOHN|SAINT LAURENT|"
        "SAINT LEONARD|SAINT LOUIS DE TERREBONNE|SAINT MICHEL|SAINTE FOY|SAINTE FOY SILLERY CAP ROUGE|SARNIA|"
        "SASKATOON|SAULT STE MARIE|SHERBROOKE|SHERWOOD PARK|SOUTH SURREY|ST ALBERT|ST CATHARINES|ST JOHNS|"
        "STONEY CREEK|SURREY|TERREBONNE|THORNHILL|THUNDER BAY|TORONTO|TROIS RIVIERES|UNIVERSITY HEIGHTS|"
        "VANCOUVER|VAUGHAN|VERDUN|VILLE MARIE|VILLERAY SAINT MICHEL PARC EXTENSION|"
        "WATERFRONT COMMUNITIES THE ISLAND|WELLAND|WHALLEY|WHITBY|WILLOWDALE|WILLOWDALE EAST|WINNIPEG|WOBURN"
    ),
    "CD": (
        "AKETI|BABAMBA|BAKWA|BANDUNDU PROVINCE|BASOKO|BAUDHUINVILLE|BENI|BINGA|BOENDE|BOLENGE|BOMA|BUKAMA|BUKAVU|"
        "BULUNGU|BUMBA|BUNIA|BUTA|BUTEMBO|DIBAYA LUBWE|FUNGURUME|GANDAJIKA|GBADOLITE|GEMENA|GOMA|HYOSHA|IDIOFA|"
        "ILEBO|INKISI|INONGO|ISIRO|KABALO|KABINDA|KALEMIE|KALIMA|KAMBOVE|KAMINA|KANANGA|KANYAMA|KASONGO|KATWA|"
        "KAYNA|KENGE|KIKWIT|KIMPESE|KINDU|KINSHASA|KIPUSHI|KIRUMBA|KISANGANI|KITUKU|KOLWEZI|KONGOLO|KUTU|LIKASI|"
        "LISALA|LODJA|LUBUMBASHI|LUPUTA|MANGAI|MANGINA|MANONO|MASINA|MATADI|MBANDAKA|MBANZA NGUNGU|MBUJI MAYI|"
        "MIABI|MOANDA|MULONGO|MUSHIE|MWEKA|MWENE|MWENE DITU|NIOKI|NYUNZU|RUTSHURU|TSHELA|TSHIKAPA|TSHILENGE|"
        "UVIRA|YANGAMBI"
    ),
    "CF": "BAMBARI|BANGASSOU|BANGUI|BEGOUA|BERBERATI|BIMBO|BOSSANGOA|BOUAR|CARNOT|KAGA BANDORO",
    "CG": "BRAZZAVILLE|DOLISIE|KAYES|NKAYI|POINTE NOIRE",
    "CH": "BASEL|BERN|BIEL BIENNE|GENEVE|LAUSANNE|LUGANO|LUZERN|SANKT GALLEN|WINTERTHUR|ZUERICH|ZURICH",
    "CI": (
        "ABENGOUROU|ABIDJAN|ABOBO|ABOISSO|ADZOPE|AGBOVILLE|AGNIBILEKROU|ANYAMA|BINGERVILLE|BONDOUKOU|BONON|"
        "BOUAFLE|BOUAKE|BOUNDIALI|DABOU|DALOA|DANANE|DAOUKRO|DIMBOKRO|DIVO|DUEKOUE|FERKESSEDOUGOU|GAGNOA|"
        "GRAND BASSAM|GUIGLO|ISSIA|KATIOLA|KORHOGO|KOUMASSI|MARCORY|MEAGUI|ODIENNE|OUME|SAN PEDRO|SEGUELA|SINFRA|"
        "SOUBRE|TENGRELA|TOUMODI|VAVOUA|YAMOUSSOUKRO|ZAGNE"
    ),
    "CL": (
        "ALTO HOSPICIO|ANTOFAGASTA|ARICA|BUIN|CALAMA|CHIGUAYANTE|CHILLAN|COLINA|CONCEPCION|COPIAPO|COQUIMBO|"
        "CORONEL|CURICO|HUALPEN|IQUIQUE|LA CALERA|LA PINTANA|LA SERENA|LAMPA|LINARES|LO PRADO|LOS ANDES|"
        "LOS ANGELES|MAIPU|MELIPILLA|NUNOA|OSORNO|OVALLE|PADRE HURTADO|PADRE LAS CASAS|PAINE|PENAFLOR|PENALOLEN|"
        "PUENTE ALTO|PUERTO MONTT|PUNTA ARENAS|QUILICURA|QUILLOTA|QUILPUE|RANCAGUA|RENCA|SAN ANTONIO|"
        "SAN BERNARDO|SAN FELIPE|SAN PEDRO DE LA PAZ|SANTIAGO|TALAGANTE|TALCA|TALCAHUANO|TEMUCO|TOME|VALDIVIA|"
        "VALPARAISO|VILLA ALEMANA|VILLA MERCEDES|VINA DEL MAR"
    ),
    "CM": (
        "BAFANG|BAFIA|BAFOUSSAM|BAMENDA|BERTOUA|BUEA|DOUALA|DSCHANG|EBOLOWA|EDEA|FOUMBAN|FOUMBOT|GUIDER|KOUSSERI|"
        "KRIBI|KUMBA|KUMBO|LIMBE|LOUM|MAROUA|MBALMAYO|MBOUDA|MEIGANGA|MELONG|MOKOLO|MORA|MUTENGENE|NGAOUNDERE|"
        "NKONGSAMBA|SANGMELIMA|TIKO|YAGOUA|YAOUNDE"
    ),
    "CN": (
        "ACHENG|AIHUI|ALAER|ANBU|ANDA|ANGUO|ANJIANG|ANKANG|ANLIU|ANLONG|ANLU|ANNING|ANQING|ANQIU|ANSHAN|ANSHUN|"
        "ANTU|ANWEN|ANYANG|AOXI|AQSU|ARTUX|BABU|BACHUAN|BAGEQI|BAIANBA|BAICHENG|BAIDI|BAIHECUN|BAIJIANTAN|"
        "BAIMAJING|BAIQUAN|BAISE|BAISHA|BAISHAN|BAISHISHAN|BAIXI|BAIYIN|BANAN|BAOAN|BAOAN CENTRE|BAODING|BAOJI|"
        "BAOQING|BAOSHAN|BAOTOU|BAOYING|BARKAM|BASHAN|BASUO|BAYAN|BAYAN HOT|BAYAN NUR|BAYIJI|BAZHONG|BEIAN|"
        "BEIBEI|BEICHENGQU|BEIDAO|BEIHAI|BEIJING|BEILIU|BEIMENG|BEINING|BEIPIAO|BEISU|BENGBU|BENXI|BIANZHUANG|"
        "BIJIE|BIN XIAN|BINZHOU|BISHAN|BOLE|BOLI|BONAN|BOSHAN|BOTOU|BOZHOU|BUHE|BUZHUANG|CAIDIAN|CANGZHOU|CAOHE|"
        "CAOQIAO|CHAIGOU|CHAIHE|CHANGBAI|CHANGCHENG|CHANGCHUN|CHANGDE|CHANGJI|CHANGLE|CHANGLENG|CHANGLI|"
        "CHANGLING|CHANGNING|CHANGPING|CHANGQING|CHANGSHA|CHANGSHU|CHANGTU|CHANGYI|CHANGYUAN|CHANGZHENG|CHANGZHI|"
        "CHANGZHOU|CHAOHU|CHAOYANG|CHAOZHOU|CHENGDE|CHENGDU|CHENGGU|CHENGGUAN QU|CHENGHUA|CHENGQIAO|CHENGTANGCUN|"
        "CHENGXIAN CHENGGUANZHEN|CHENGXIANG|CHENGYANG|CHENGZHONG|CHENGZIHE|CHENZHOU|CHIFENG|CHIZHOU|CHONGFU|"
        "CHONGLONG|CHONGMING|CHONGQING|CHONGZUO|CHUXIONG|CHUZHOU|CIXI|DACHANG|DACHENG|DALAI|DALI|DALI OLD TOWN|"
        "DALIAN|DALIANG|DALIANWAN|DAMIAO|DANCHENG|DANDONG|DANJIANGKOU|DANSHUI|DAOKOU|DAOTIAN|DAPENG|DAQING|DASHA|"
        "DASHAHE|DASHI|DASHIQIAO|DASHITOU|DATONG|DATUN|DAWUKOU|DAXING|DAXINGANLING|DAXU|DAYE|DAZESHAN|DAZHONG|"
        "DAZHOU|DEGAN|DEHUI|DENGBU|DENGZHOU|DEQEN|DEQING|DEYANG|DEZHOU|DIANBU|DIANZI|DIDAO|DINGJIA|DINGTAO|"
        "DINGXI|DINGZHOU|DOILUNGDEQEN|DONGCUN|DONGDU|DONGFENG|DONGGUAN|DONGHAI|DONGHE|DONGKAN|DONGLING|DONGNING|"
        "DONGSHENG|DONGTAI|DONGXI|DONGXIA|DONGXING|DONGYANG|DONGYING|DORBOD|DUCHENG|DUNHOU|DUNHUA|DUNHUANG|DUOBA|"
        "DUOBAO|DUSHAN|DUYUN|DUZHOU|EMIN|ENCHENG|ENSHI|ERDAOJIANG|EZHOU|FANGCHENG|FANGCHENGGANG|FANGCUN|FANGSHAN|"
        "FANLOU|FEICHENG|FENDOU|FENGCHENG|FENGGANG|FENGHUA|FENGHUANG|FENGKOU|FENGPING|FENGRUN|FENGXIANG|FENGYI|"
        "FENSHUI|FENYI|FOSHAN|FUAN|FUDING|FUJI|FUJIN|FULING|FUQING|FUSHUN|FUXIN|FUYANG|FUYU|FUZHOU|GANGSHANG|"
        "GANGU CHENGGUANZHEN|GANNAN|GANSHUI|GANTANG|GANZHOU|GAOGOU|GAOJING|GAOLIU|GAOMI|GAOPING|GAOYOU|GAOZHOU|"
        "GEJIU|GELAN|GENGQING|GENHE|GHULJA|GONGCHANGLING|GONGGUAN|GONGHEYONG|GONGYI|GONGZHULING|GUANGAN|"
        "GUANGSHUI|GUANGYUAN|GUANGZHOU|GUANHU|GUANKOU|GUANSHAN|GUANYIN|GUANZHUANG|GUCHENG|GUCHENG CHENGGUANZHEN|"
        "GUCUN|GUIGANG|GUILIN|GUIPING|GUIREN|GUIXI|GUIYANG|GUJANGBAGH|GULI|GULIN|GUNAN|GUOZHEN|GUSHU|GUSONG|"
        "GUYUAN|HAICHENG|HAIKOU|HAILAR|HAILIN|HAILUN|HAIMEN|HAINING|HAIZHOU|HAMI|HANCHENG|HANCHUAN|HANDAN|"
        "HANFENG|HANGU|HANGZHOU|HANJIA|HANTING|HANYIN CHENGGUANZHEN|HANYUAN|HANZHONG|HARBIN|HEBI|HECHI|HECHUAN|"
        "HECUN|HEDE|HEDONG|HEFEI|HEGANG|HEGUAN|HEIHE|HEISHAN|HEJIANG|HELONG|HENGBEI|HENGSHAN|HENGSHUI|HENGYANG|"
        "HEPINGJIE|HEPO|HEPU|HESHAN|HEYUAN|HEZE|HEZHOU|HEZUO|HOHHOT|HONDLON|HONGGANG|HONGHE|HONGJIANG|HONGKOU|"
        "HONGQIAO|HOUZHEN|HUACHENG|HUADIAN|HUAIAN|HUAIBEI|HUAICHENG|HUAIDIAN|HUAIHUA|HUAINAN|HUAIYANG|"
        "HUAIYUAN CHENGGUANZHEN|HUAJING|HUALONG|HUANAN|HUANGCHUAN|HUANGGANG|HUANGHUA|HUANGLOU|HUANGMEI|HUANGNIHE|"
        "HUANGPI|HUANGPU|HUANGSHAN|HUANGSHI|HUANGZHOU|HUANKOU|HUANREN|HUASHAN|HUAYIN|HUAYUAN|HUAZHOU|HUGUO|"
        "HUICHENG|HUILONG|HUINAN|HUINONG|HUIQU|HUIXING|HUIZHOU|HULAN|HULAN ERGI|HULUDAO|HULUNBUIR|HUMEN|HUNCHUN|"
        "HUOCHENG|HUOQIU CHENGGUANZHEN|HUSHITAI|HUTANG|HUZHOU|JALAI NUR|JIADING|JIAGEDAQI|JIAMUSI|JIAN|JIANCHANG|"
        "JIANGAN|JIANGBEI|JIANGKOU|JIANGMEN|JIANGSHAN|JIANGUANG|JIANGYAN|JIANGYIN|JIANGYOU|JIANGZHUANG|JIANOU|"
        "JIANSHUI|JIAOHE|JIAOJIANG|JIAOZHOU|JIAOZUO|JIASHAN|JIAWANG|JIAXING|JIAYUE|JIAYUGUAN|JIAZI|JIDONG|JIEHU|"
        "JIESHI|JIESHOU|JIETOU|JIEXIU|JIEYANG|JIJIANG|JILIN|JIMO|JINAN|JINCHANG|JINCHENG|JINDING|JINFENG|JINGAN|"
        "JINGDEZHEN|JINGGOU|JINGLING|JINGMEN|JINGZHI|JINGZHOU|JINHUA|JINING|JINJI|JINJIANG|JINNIU|JINSHA|JINSHAN|"
        "JINSHANLU|JINSHI|JINXIANG|JINZHONG|JINZHOU|JISHOU|JISHU|JISHUI|JITAI|JIUDIAN|JIUJIANG|JIUPU|JIUQUAN|"
        "JIUTAI|JIXI|JIXIAN|JIYUAN|JIZHOU|JUEGANG|JUNLIAN|JUYE|KAGELEKE|KAIFENG|KAIHUA|KAILI|KAITONG|KAIYUAN|"
        "KANGDING|KANJIA|KARAMAY|KASHGAR|KORLA|KUANDIAN|KUNMING|KUNSHAN|KUNYANG|LAIBIN|LAIWU|LAIXI|LAIYANG|"
        "LAIZHOU|LANGFANG|LANGTOUCUN|LANGXIANG|LANGZHONG|LANSHAN|LANXI|LANZHOU|LAOHEKOU|LAOJUNMIAO|LECHENG|"
        "LEIYANG|LENGSHUIJIANG|LENGSHUITAN|LESHAN|LHASA|LHOKA|LHUENZHUB|LHUNZHUB|LIANCHENG|LIANGHU|LIANGJI|"
        "LIANGPING|LIANGXIANG|LIANGZHAI|LIANHE|LIANJIANG|LIANSHAN|LIANYUAN|LIANYUNGANG|LIANZHOU|LIAOCHENG|"
        "LIAOLAN|LIAOYANG|LIAOZHONG|LICHA|LICHENG|LICHUAN|LIDU|LIGEZHUANG|LIGUO|LIJIANG|LINCANG|LINFEN|LINGAO|"
        "LINGCHENG|LINGDONG|LINGHAI|LINGHE|LINGWU|LINGYUAN|LINJIACUN|LINJIANG|LINKOU|LINPING|LINQIONG|LINQU|"
        "LINSHUI|LINTONG|LINXI|LINXIA CHENGGUANZHEN|LINYI|LIPING|LISHI|LISHU|LISHUI|LIUHE|LIUJI|LIUKU|LIUPANSHUI|"
        "LIUQUAN|LIUXIN|LIUZHI|LIUZHOU|LIXIAN|LIZHI|LONGFENG|LONGGANG|LONGGU|LONGJIANG|LONGJING|LONGLING COUNTY|"
        "LONGNAN|LONGQUAN|LONGSHAN|LONGSHI|LONGSHUI|LONGTAN|LONGYAN|LOUDI|LOUSHANGUAN|LUAN|LUANCHENG|LUBU|"
        "LUCHENG|LUEEYANG CHENGGUANZHEN|LUELIANG|LUESHUN|LUEYANG CHENGGUANZHEN|LULIANG|LULOU|LUOCHENG|LUODIAN|"
        "LUOHE|LUOHU DISTRICT|LUOHUANG|LUOJIANG|LUOJING|LUOMEN|LUORONG|LUOYANG|LUSHAR|LUSHUI|LUSHUN|LUZHOU|"
        "MAANSHAN|MABA|MABAI|MACHENG|MAJIE|MALINGSHAN|MANZHOULI|MAOCUN|MAOMING|MAOZHOU|MAQIN COUNTY|MEIHEKOU|"
        "MEISHAN|MEIZHOU|MENGCHENG CHENGGUANZHEN|MENGHUAN|MENGLANG|MENGMAO|MENGYIN|MENGZI|MENTOUGOU|MIANYANG|"
        "MIANZHU DEYANG SICHUAN|MIAOHANG|MIAOJIE|MICHENG|MINGCUN|MINGGANG|MINGGUANG|MINGSHUI|MINHANG|MISHAN|"
        "MIYANG|MUDANJIANG|MUDU|MUJIAYINGZI|MULING|NADA|NANBIN|NANCHANG|NANCHONG|NANCHUAN|NANCUN|NANDAJIE|"
        "NANDING|NANDU|NANFENG|NANGONG|NANHAI|NANHU|NANJIAN|NANJIN|NANJING|NANLONG|NANMA|NANNING|NANPIAO|NANPING|"
        "NANQIAO|NANTAI|NANTONG|NANTOU|NANXI|NANYANG|NANZHANG CHENGGUANZHEN|NANZHOU|NAXI|NEHE|NEIJIANG|NENJIANG|"
        "NIANBO|NIANZHUANG|NIANZISHAN|NINGBO|NINGDE|NINGER|NINGHAI|NINGYANG|NOSSA SENHORA DE FATIMA|NYINGCHI|"
        "ORDOS|OROQEN ZIZHIQI|PAILOU|PANAN|PANJIN|PANLONG|PANLONGCHENG JINGJI KAIFAQU|PANSHAN|PANSHI|PANZHIHUA|"
        "PEICHENG|PENGCHENG|PENGPU|PENGZE|PICHENG|PINGDINGSHAN|PINGDU|PINGJIN|PINGLIANG|PINGNAN|PINGSHAN|"
        "PINGWU COUNTY|PINGXIANG|PINGYI|PINGYIN|PINGZHUANG|PIZHOU|POYANG|PUCHENG|PUDONG|PUER|PUJI|PULANDIAN|"
        "PUNING|PUQI|PUTIAN|PUTUO|PUXI|PUYANG|PUYANG CHENGGUANZHEN|QAMDO|QARAQASH|QARASU|QIANJIANG|QIANTANG|"
        "QIAOGUAN|QIAOTOU|QIBAO|QINCHENG|QINGDAO|QINGFU|QINGGANG|QINGNIAN|QINGPU|QINGQUAN|QINGSHAN|QINGSHUPING|"
        "QINGXICHANG|QINGYANG|QINGYUAN|QINGZHOU|QINHUANGDAO|QINNAN|QINZHOU|QIONGHAI|QIONGHU|QIONGSHAN|QIPAN|"
        "QIQIHAR|QISHAN|QITAIHE|QIUJI|QUANZHOU|QUFU|QUJING|QUZHOU|RENQIU|RENZHAO|RIKAZE|RIZHAO|RUGAO|RUIAN|RUNAN|"
        "SALAQI|SANCHAZI|SANCHUAN|SANDAOHEZI|SANDU|SANHE|SANHUI|SANMENXIA|SANMING|SANSHUI|SANTO ANTONIO|SANYA|"
        "SANZHUANG|SAO LOURENCO|SHACHE|SHAHECHENG|SHAJING|SHAJING TOWN|SHANCHENG|SHANGHAI|SHANGKOU|SHANGLUO|"
        "SHANGMEI|SHANGQIU|SHANGRAO|SHANGRI LA|SHANGSI|SHANGYU|SHANGZHI|SHANHAIGUAN|SHANHECUN|SHANJI|SHANKOU|"
        "SHANTING|SHANTOU|SHANWANG|SHANWEI|SHAOGUAN|SHAOSHAN|SHAOWU|SHAOXING|SHAOYANG|SHAOZHUANG|SHENGLILU|"
        "SHENJIAMEN|SHENLIU|SHENYANG|SHENZHEN|SHENZHEN CITY CENTRE|SHIBUZI|SHIGUAI|SHIHEZI|SHIJIAZHUANG|SHIJIE|"
        "SHIKANG|SHILIN|SHILONG|SHIMA|SHIQI|SHIQIAO|SHIQIAOZI|SHIQUAN|SHITANJING|SHIWAN|SHIXING|SHIYAN|SHIZHAI|"
        "SHIZILU|SHIZUISHAN|SHOUGUANG|SHOUXIAN|SHUANGCHENG|SHUANGFENGQIAO|SHUANGLIAO|SHUANGLONGHU|SHUANGYANG|"
        "SHUANGYASHAN|SHUIFU|SHUIJIANG|SHUIKOU|SHUIZHAI|SHULAN|SHUNYI|SHUOZHOU|SINO SINGAPORE TIANJIN ECO CITY|"
        "SIPING|SISHUI|SITOU|SONGCHENG|SONGJIANG|SONGJIANGHE|SONGLING|SONGLINGCUN|SONGLOU|SONGNAN|SONGYANG|"
        "SONGYUAN|SUICHENG|SUIFENHE|SUIHUA|SUILING|SUINING|SUIXI|SUIZHOU|SUJIATUN|SUOZHEN|SUQIAN|SUYANGSHAN|"
        "SUZHOU|TACHENG|TAHE|TAIAN|TAIBAI|TAICANG|TAIFU|TAIHE|TAILAI|TAISHAN|TAITOU|TAIXING|TAIYUAN|TAIZHOU|"
        "TANFANG|TANGGU|TANGHE|TANGJIAZHUANG|TANGPING|TANGSHAN|TANGWU|TANGXIANG|TANGZHAI|TANGZHANG|TANTOU|"
        "TANZHOU|TAOLUO|TAONAN|TAOYUAN|TAOZHOU|TAOZHUANG|TASHAN|TENGYUE|TIANCHANG|TIANFU|TIANJIN|TIANLIU|"
        "TIANPENG|TIANSHUI|TIANZHUANG|TIEFU|TIELI|TIELING|TONGCHUAN|TONGCHUANSHI|TONGHUA|TONGLIAO|TONGLING|"
        "TONGREN|TONGSHAN|TONGZHOU|TUANBAO|TUMEN|TUMXUK|TURPAN|UERUEMQI|ULANHOT|ULANQAB|URUMQI|"
        "WACHENG NEIGHBORHOOD|WAFANGDIAN|WANGGOU|WANGJI|WANGKUI|WANGQING|WANNING|WANSHENG|WANXIAN|WANZHOU|"
        "WAYAOBU|WEIFANG|WEIHAI|WEIMIAO|WEINAN|WEINING|WENCHANG|WENJIANG|WENLING|WENSHAN|WENSHAN CITY|WENSHANG|"
        "WENSU|WENXING|WENZHOU|WUCHANG|WUCHENG|WUCHUAN|WUDA|WUDAN|WUGANG|WUHAI|WUHAN|WUHU|WUJIAQU|WUJING|"
        "WULINGYUAN|WULONG|WUSHAN|WUSU|WUWEI|WUXI|WUXUE|WUYANG|WUYISHAN|WUZHEN|WUZHISHAN|WUZHONG|WUZHOU|XIAMEN|"
        "XIAN|XIANGCHENG|XIANGTAN|XIANGXIANG|XIANGYANG|XIANGZHOU|XIANJU|XIANNING|XIANNU|XIANNUE|XIANSHUIGU|"
        "XIANTAO|XIANYANG|XIAOGAN|XIAOLINGWEI|XIAOSHAN|XIAOSHI|XIAOWEIZHAI|XIAYANG|XIAZHEN|XIAZHUANG|XICHANG|"
        "XIEMA|XIFENG|XIGANG|XIHE|XILIN HOT|XILINHOT|XIMEICUN|XINCHENG|XINDI|XINDIAN|XINGCHENG|XINGGUO|XINGHUA|"
        "XINGLONGSHAN|XINGNING|XINGQIAO|XINGREN|XINGTAI|XINGYI|XINHE|XINING|XININGLU|XINJI|XINLE|XINMIN|XINQIAO|"
        "XINQING|XINSHI|XINTAI|XINXIANG|XINXING|XINYANG|XINYE|XINYI|XINYU|XINYUAN|XINZHAI|XINZHI|XINZHOU|"
        "XIONGZHOU|XISHAN|XIUGU|XIULIN|XIUYAN|XIUYING|XIXIANG|XUANCHENG|XUANHUA|XUANTAN|XUCHANG|XUCHENG|XUHUI|"
        "XUJIANG|XUNCHANG|XUNYANG|XUYONG|XUZHOU|XUZHUANG|YAAN|YAKESHI|YANAN|YANCHENG|YANGCHENG|YANGCHUN|YANGCUN|"
        "YANGGU|YANGHANG|YANGHE|YANGJIANG|YANGLIUQING|YANGPU|YANGQUAN|YANGSHUO|YANGTUN|YANGZHOU|YANJI|YANJIA|"
        "YANLIANG|YANTA|YANTAI|YANTONGSHAN|YANZHOU|YAOJI|YAOWAN|YASHAN|YATOU|YAXING|YEBAISHOU|YEYUAN|YEZHOU|"
        "YIBIN|YICHANG|YICHENG|YICHUN|YIDU|YIGOU|YILAN|YIMA|YINCHUAN|YINGJIANG|YINGKOU|YINGLI|YINGQIU|"
        "YINGSHANG CHENGGUANZHEN|YINGTAN|YINMA|YINTAI|YINZHU|YISHAN|YISHUI|YIWU|YIXING|YIZHOU|YONGAN|YONGBEI|"
        "YONGCHUAN|YONGFENG|YONGJI|YONGJIAN|YONGNING|YONGQING|YONGZHOU|YOUHAO|YOUSUO|YOUXI|YUANPING|YUANSHANG|"
        "YUCHENG|YUCI|YUDONG|YUEPU|YUEYANG|YULIN|YULINSHI|YUNCHENG|YUNFU|YUNJIN|YUNJINGHONG|YUNLONG|YUNMEN|"
        "YUNMENG CHENGGUANZHEN|YUNNANYI|YUNSHAN|YUNYANG|YUSHU|YUTAN|YUXI|YUXIA|YUYAO|YUZHOU|ZAOYANG|ZAOZHUANG|"
        "ZEPU|ZHABEI|ZHALANTUN|ZHANGFENG|ZHANGJI|ZHANGJIACHUAN|ZHANGJIAGANG|ZHANGJIAJIE|ZHANGJIAKOU|ZHANGYE|"
        "ZHANGZHAI|ZHANGZHOU|ZHANGZHUANG|ZHANJIANG|ZHAOBAOSHAN|ZHAODONG|ZHAODUN|ZHAOGEZHUANG|ZHAOQING|ZHAOTONG|"
        "ZHAOYUAN|ZHAOZHOU|ZHAOZHUANG|ZHAWA|ZHEFANG|ZHENGDING|ZHENGZHOU|ZHENJIANG|ZHENLAI|ZHENPING|ZHENXI|"
        "ZHENZHOU|ZHICHENG|ZHIJIANG|ZHONGDUO|ZHONGGULOU|ZHONGHE|ZHONGSHAN|ZHONGSHU|ZHONGWEI|ZHONGXIANG|ZHONGXIN|"
        "ZHONGXING|ZHOUCHENG|ZHOUCUN|ZHOUJIABA|ZHOUKOU|ZHOUSHAN|ZHU CHENG|ZHU CHENG CITY|ZHUANGHE|ZHUANGYUAN|"
        "ZHUCHENG|ZHUHAI|ZHUJI|ZHUJIAJIAO|ZHUJING|ZHUMADIAN|ZHUTUO|ZHUYI|ZHUZHAI|ZHUZHOU|ZIBIHU|ZIBO|ZIGONG|"
        "ZITONG|ZIYANG|ZIZHUANG|ZOUCHENG|ZUNYI"
    ),
    "CO": (
        "AGUACHICA|AGUSTIN CODAZZI|APARTADO|ARAUCA|ARJONA|ARMENIA|AYAPEL|BARANOA|BARBOSA|BARRANCABERMEJA|"
        "BARRANQUILLA|BELLO|BOGOTA|BUCARAMANGA|BUENAVENTURA|CAJICA|CALARCA|CALDAS|CALI|CARTAGENA|CARTAGO|"
        "CAUCASIA|CERETE|CHIA|CHIGORODO|CHINCHINA|CHINU|CIENAGA|CIMITARRA|CUCUTA|DOSQUEBRADAS|DUITAMA|EL BAGRE|"
        "EL BANCO|ENVIGADO|ESPINAL|FACATATIVA|FLORENCIA|FLORIDABLANCA|FUNDACION|FUNZA|FUSAGASUGA|GIRARDOT CITY|"
        "GIRON|GRANADA|GUADALAJARA DE BUGA|IBAGUE|IPIALES|ITAGUEI|ITAGUI|KENNEDY|LA DORADA|LOS PATIOS|MAGANGUE|"
        "MAICAO|MALAMBO|MANIZALES|MARINILLA|MEDELLIN|MOCOA|MONTELIBANO|MONTERIA|MOSQUERA|NEIVA|OCANA|ORITO|"
        "PALMIRA|PAMPLONA|PASTO|PEREIRA|PIEDECUESTA|PITALITO|PLANETA RICA|POPAYAN|PUERTO BERRIO|QUIBDO|RIOHACHA|"
        "RIONEGRO|SABANALARGA|SABANETA|SAHAGUN|SAN ANDRES|SAN JOSE DEL GUAVIARE|SAN MARCOS|SANTA MARTA|"
        "SANTA ROSA DE CABAL|SANTANDER DE QUILICHAO|SINCELEJO|SOACHA|SOGAMOSO|SOLEDAD|TULUA|TUMACO|TUNJA|TURBACO|"
        "VALLEDUPAR|VILLA DEL ROSARIO|VILLAVICENCIO|YOPAL|YUMBO|ZIPAQUIRA"
    ),
    "CR": "LIMON|SAN FRANCISCO|SAN JOSE",
    "CU": (
        "ALAMAR|ALMENDARES|ARROYO NARANJO|ARTEMISA|BALCON DE LA LISA|BANES|BARTOLOME MASO|BAYAMO|BOYEROS|"
        "CAMAGUEEY|CAMAGUEY|CARDENAS|CENTRO HABANA|CERRO|CIEGO DE AVILA|CIENFUEGOS|CIUDAD CAMILO CIENFUEGOS|"
        "CONSOLACION DEL SUR|CONTRAMAESTRE|CORRALILLO|DIEZ DE OCTUBRE|FONTANAR|GUANABACOA|GUANTANAMO|GUEINES|"
        "GUEIRA DE MELENA|GUINES|GUIRA DE MELENA|HAVANA|HOLGUIN|JAGUEEY GRANDE|JAGUEY GRANDE|JESUS MENENDEZ|"
        "LA HABANA VIEJA|LAS TUNAS|MANTILLA|MANZANILLO|MARIANAO|MATANZAS|NUEVITAS|PALMA SORIANO|PINAR DEL RIO|"
        "PLACETAS|PLAZA DE LA REVOLUCION|PUERTO PADRE|SAGUA LA GRANDE|SAN CRISTOBAL|SAN JOSE DE LAS LAJAS|"
        "SAN LUIS|SAN MIGUEL DEL PADRON|SANCTI SPIRITUS|SANTA CLARA|SANTIAGO DE CUBA|VEDADO|VEDADO DEL COTORRO"
    ),
    "CV": "MINDELO|PRAIA", "CW": "WILLEMSTAD", "CY": "LARNACA|LIMASSOL|NICOSIA|STROVOLOS",
    "CZ": (
        "BRNO|BRNO STRED|CESKE BUDEJOVICE|CHODOV|FRYDEK MISTEK|HAVIROV|HRADEC KRALOVE|JIHLAVA|KLADNO|LIBEREC|"
        "OLOMOUC|OPAVA|OSTRAVA|PARDUBICE|PILSEN|PRAGUE|PRAHA|STODULKY|TEPLICE|USTI NAD LABEM|ZIZKOV|ZLIN"
    ),
    "DE": (
        "AACHEN|AALEN|AHLEN|ALT HOHENSCHOENHAUSEN|ALT HOHENSCHONHAUSEN|ALTONA|ARNSBERG|ASCHAFFENBURG|AUGSBURG|"
        "BAD HOMBURG VOR DER HOEHE|BAD HOMBURG VOR DER HOHE|BAD SALZUFLEN|BADEN BADEN|BAMBERG|BAYREUTH|BERGEDORF|"
        "BERGHEIM|BERGISCH GLADBACH|BERGKAMEN|BERLIN|BERLIN KOEPENICK|BERLIN KOPENICK|BIELEFELD|BILLSTEDT|"
        "BOCHOLT|BOCHUM|BOGENHAUSEN|BONN|BOTTROP|BRANDENBURG AN DER HAVEL|BRAUNSCHWEIG|BREMEN|BREMERHAVEN|"
        "CASTROP RAUXEL|CELLE|CHARLOTTENBURG|CHEMNITZ|COTTBUS|CUXHAVEN|DARMSTADT|DELMENHORST|DESSAU|DETMOLD|"
        "DINSLAKEN|DORMAGEN|DORSTEN|DORTMUND|DRESDEN|DUEREN|DUESSELDORF|DUISBURG|DUREN|DUSSELDORF|EIMSBUETTEL|"
        "EIMSBUTTEL|EMDEN|ERFTSTADT|ERFURT|ERLANGEN|ESCHWEILER|ESSEN|ESSLINGEN|EUSKIRCHEN|FLENSBURG|"
        "FRANKFURT AM MAIN|FRANKFURT ODER|FRECHEN|FREIBURG|FRIEDRICHSFELDE|FRIEDRICHSHAFEN|FRIEDRICHSHAIN|"
        "FRIEDRICHSHAIN BEZIRK|FUERTH|FULDA|FURTH|GARBSEN|GELSENKIRCHEN|GERA|GESUNDBRUNNEN|GIESSEN|GLADBECK|"
        "GOEPPINGEN|GOERLITZ|GOETTINGEN|GOPPINGEN|GORLITZ|GOTTINGEN|GREVENBROICH|GRONAU|GUETERSLOH|GUMMERSBACH|"
        "GUTERSLOH|HAGEN|HALLE SAALE|HAMBURG|HAMBURG MITTE|HAMBURG NORD|HAMELN|HAMM|HANAU AM MAIN|HANNOVER|"
        "HARBURG|HATTINGEN|HEIDELBERG|HEIDENHEIM AN DER BRENZ|HEILBRONN|HELLERSDORF|HERFORD|HERNE|HERTEN|HILDEN|"
        "HILDESHEIM|HUERTH|HURTH|IBBENBUEREN|INGOLSTADT|ISERLOHN|JENA|KAISERSLAUTERN|KARLSRUHE|KASSEL|"
        "KEMPTEN ALLGAEU|KEMPTEN ALLGAU|KERPEN|KIEL|KOBLENZ|KOELN|KOEPENICK|KOLN|KONSTANZ|KOPENICK|KREFELD|"
        "KREUZBERG|LAHR|LANDSHUT|LANGENFELD|LANGENHAGEN|LEIPZIG|LEVERKUSEN|LICHTENRADE|LICHTERFELDE|LINGEN|"
        "LIPPSTADT|LUBECK|LUDENSCHEID|LUDWIGSBURG|LUDWIGSHAFEN AM RHEIN|LUEBECK|LUEDENSCHEID|LUENEBURG|LUENEN|"
        "LUNEBURG|LUNEN|MAGDEBURG|MAINZ|MANNHEIM|MARBURG AN DER LAHN|MARIENDORF|MARIENTHAL|MARL|MARZAHN|"
        "MEERBUSCH|MENDEN|MINDEN|MITTE|MOABIT|MOENCHENGLADBACH|MOERS|MONCHENGLADBACH|MUELHEIM|MUENCHEN|MUENSTER|"
        "MULHEIM|MUNCHEN|MUNICH|MUNSTER|NEU HOHENSCHOENHAUSEN|NEU HOHENSCHONHAUSEN|NEU ULM|NEUBRANDENBURG|"
        "NEUBRUCK|NEUBRUECK|NEUE NEUSTADT|NEUKOELLN|NEUKOLLN|NEUMUENSTER|NEUMUNSTER|NEUSS|"
        "NEUSTADT AN DER WEINSTRASSE|NEUWIED|NIPPES|NORDERSTEDT|NORDHORN|NUREMBERG|NURNBERG|OBERHAUSEN|OFFENBACH|"
        "OFFENBURG|OLDENBURG|OSNABRUCK|OSNABRUECK|PADERBORN|PANKOW|PASSAU|PFORZHEIM|PLAUEN|PORZ AM RHEIN|POTSDAM|"
        "PRENZLAUER BERG|PRENZLAUER BERG BEZIRK|PULHEIM|RAHLSTEDT|RATINGEN|RECKLINGHAUSEN|REGENSBURG|"
        "REINICKENDORF|REMSCHEID|REUTLINGEN|RHEINE|RHEINHAUSEN|RODENKIRCHEN|ROSENHEIM|ROSTOCK|"
        "RUESSELSHEIM AM MAIN|RUSSELSHEIM AM MAIN|SAARBRUCKEN|SAARBRUECKEN|SALZGITTER|SANKT AUGUSTIN|SCHOENEBERG|"
        "SCHONEBERG|SCHWABISCH GMUND|SCHWAEBISCH GMUEND|SCHWEINFURT|SCHWERIN|SCHWERTE|SIEGEN|SINDELFINGEN|"
        "SOLINGEN|SPEYER|STEGLITZ|STEGLITZ BEZIRK|STOLBERG|STRALSUND|STUTTGART|TEMPELHOF|TREPTOW|TRIER|TROISDORF|"
        "TUBINGEN|TUEBINGEN|UNIVERSITATS UND HANSESTADT GREIFSWALD|UNNA|VELBERT|VIERSEN|VILLINGEN SCHWENNINGEN|"
        "WAIBLINGEN|WANDSBEK|WATTENSCHEID|WEIMAR|WESEL|WETZLAR|WIESBADEN|WILHELMSBURG|WILHELMSHAVEN|WILLICH|"
        "WILMERSDORF|WINTERHUDE|WITTEN|WOLFENBUETTEL|WOLFENBUTTEL|WOLFSBURG|WUERZBURG|WUPPERTAL|WURZBURG|"
        "ZEHLENDORF|ZWICKAU"
    ),
    "DJ": "ALI SABIH|BALBALA|DJIBOUTI",
    "DK": (
        "AALBORG|ARHUS|AVED RE|AVEDORE|COPENHAGEN|ESBJERG|FREDERIKSBERG|HERNING|HORSENS|HVIDOVRE|KLINTEBY FRIHED|"
        "KOBENHAVN|KOLDING|ODENSE|RANDERS|ROSKILDE|VEJLE"
    ),
    "DO": (
        "AZUA|BAJOS DE HAINA|BANI|BELLA VISTA|BONAO|CRISTO REY|LA ROMANA|LA VEGA|MOCA|PUERTO PLATA|PUNTA CANA|"
        "SALVALEON DE HIGUEEY|SALVALEON DE HIGUEY|SAN CRISTOBAL|SAN FRANCISCO DE MACORIS|SAN JUAN DE LA MAGUANA|"
        "SAN PEDRO DE MACORIS|SANTA CRUZ DE BARAHONA|SANTIAGO DE LOS CABALLEROS|SANTO DOMINGO|SANTO DOMINGO ESTE|"
        "SANTO DOMINGO OESTE|VILLA FRANCISCA"
    ),
    "DZ": (
        "ADRAR|AFLOU|AIN BEIDA|AIN DEFLA|AIN MLILA|AIN OULMENE|AIN OUSSERA|AIN TEMOUCHENT|AIN TOUTA|ALGIERS|"
        "ALI MENDJELI|ANNABA|ARZEW|ASSI BOU NIF|BAB EZZOUAR|BARAKI|BARIKA|BATNA|BECHAR|BEJAIA|BENI MERED|"
        "BERROUAGHIA|BESBES|BIR EL ATER|BIR EL DJIR|BIRKHADEM|BISKRA|BLIDA|BOGHNI|BORDJ BOU ARRERIDJ|"
        "BORDJ EL BAHRI|BORDJ EL KIFFAN|BOU SAADA|BOUDOUAOU|BOUFARIK|BOUIRA|CHELGHOUM EL AID|CHERIA|CHLEF|"
        "CONSTANTINE|DISTRICT OF TAHER|DJELFA|DREAN|ECH CHETTIA|EL ACHIR|EL BAYADH|EL EULMA|EL KHROUB|EL MENIA|"
        "EL OUED|EN NEDJMA|GHARDAIA|GUELMA|GUERARA|HAMMA BOUZIANE|HASSI BAHBAH|JIJEL|KHEMIS MILIANA|KHENCHELA|"
        "KOLEA|KSAR CHELLALA|KSAR EL BOUKHARI|LAGHOUAT|LARBAA|MAGHNIA|MANSOURA|MASCARA|MECHERIA|MEDEA|MESSAAD|"
        "MILA|MOHAMMADIA|MOSTAGANEM|MSILA|ORAN|OUARGLA|OUED RHIOU|OULED DJELLAL|OUM EL BOUAGHI|REGHAIA|RELIZANE|"
        "ROUIBA|ROUISSAT|SAIDA|SETIF|SIDI AISSA|SIDI BEL ABBES|SKIKDA|SOUGUEUR|SOUK AHRAS|TAMANGHASSET|TEBESSA|"
        "TIARET|TISSEMSILT|TIZI OUZOU|TLEMCEN|TOLGA|TOUGGOURT"
    ),
    "EC": (
        "AMBATO|BABAHOYO|CUENCA|DAULE|ELOY ALFARO|ESMERALDAS|GUAYAQUIL|IBARRA|LA LIBERTAD|LATACUNGA|LOJA|MACHALA|"
        "MANTA|MILAGRO|PORTOVIEJO|QUEVEDO|QUITO|RIOBAMBA|SANTO DOMINGO DE LOS COLORADOS|TULCAN"
    ),
    "EE": "HAABERSTI|KESKLINN|LASNAMAE|LASNAMAEE|MUSTAMAE|MUSTAMAEE|NARVA|POHJA TALLINN|TALLINN|TARTU",
    "EG": (
        "ABNUB|ABU AL MATAMIR|ABU AN NUMRUS|ABU HUMMUS|ABU KABIR|ABU QURQAS|ABU TIJ|AD DAWAHY|AD DILINJAT|AKHMIM|"
        "AL ASHIR MIN RAMADAN|AL BADARI|AL BADRASHAYN|AL BAJUR|AL BALYANA|AL BURJ|AL FASHN|AL FAYYUM|AL GHANAYIM|"
        "AL HAMUL|AL HAWAMIDIYAH|AL HUSAYNIYAH|AL IBRAHIMIYAH|AL JAMMALIYAH|AL KHANKAH|AL KHARIJAH|AL KHARJAH|"
        "AL KHUSUS|AL MAHALLAH AL KUBRA|AL MANAKH|AL MANSURAH|AL MANZALAH|AL MARAGHAH|AL MATARIYAH|AL MINSHAH|"
        "AL QAHIRAH AL JADIDAH|AL QANATIR AL KHAYRIYAH|AL QANAYAT|AL QURAYN|AL QUSIYAH|AL UBUR|AL WASITAH|"
        "ALEXANDRIA|ARISH|ARMANT|AS SAFF|AS SAHIL|AS SALIHIYAH AL JADIDAH|AS SINBILLAWAYN|ASH SHAYKH ZAYID|"
        "ASH SHUHADA|ASHMUN|ASSIUT|ASWAN|AWSIM|AZ ZUHUR|BALTIM|BANHA|BANI MAZAR|BANI SUWAYF|BASYUN|BIBA|BILBEIS|"
        "BILQAS|BIRKAT AS SAB|BIYALA|BULAQ ABU AL ILA|BUR FUAD|CAIRO|DAMANHUR|DAMIETTA|DARAW|DAYR MAWAS|DAYRUT|"
        "DIKIRNIS|DISHNA|DISUQ|DIYARB NAJM|DUMYAT AL JADIDAH|EDFU|EL SHOROUK|ESNA|FAQUS|FARSHUT|FUWWAH|GIRGA|"
        "GIZA|HADAIQ AL QUBBAH|HALWAN|HAWSH ISA|HIHYA|HURGHADA|IBSHAWAY|IDKU|IHNASIYAH|IHNASYA AL MADINAH|"
        "ISMAILIA|ITAY AL BARUD|ITSA|IZBAT ALI AS SAYYID|JUHAYNAH|KAFR AD DAWWAR|KAFR ASH SHAYKH|KAFR AZ ZAYYAT|"
        "KAWM HAMADAH|KIRDASAH|KOM OMBO|LUXOR|MADINAT AN NASR|MADINAT AS SADAT|MAGHAGHAH|MALLAWI|MANFALUT|"
        "MARSA MATRUH|MASHTUL AS SUQ|MATAY|MINYA|MINYA AL QAMH|MINYAT AN NASR|MIT GHAMR|MUNUF|NABARUH|"
        "NAG HAMMADI|NEW CAIRO|PORT SAID|QALYUB|QINA|QUWAYSINA|ROSETTA|SAFAGA|SAMALUT|SAMANNUD|SHIBIN AL KAWM|"
        "SHIBIN AL QANATIR|SHIRBIN|SHUBRA AL KHAYMAH|SINNURIS|SIRS AL LAYYANAH|SOHAG|SUEZ|SUMUSTA AL WAQF|TAHTA|"
        "TALA|TALKHA|TAMIYAH|TANTA|TIMA|TUKH|ZAGAZIG|ZEFTA"
    ),
    "EH": "DAKHLA|LAAYOUNE", "ER": "ASMARA|KEREN",
    "ES": (
        "A CORUNA|ALBACETE|ALCALA DE GUADAIRA|ALCALA DE HENARES|ALCOBENDAS|ALCORCON|ALCOY|ALGECIRAS|ALGORTA|"
        "ALICANTE|ALMERIA|ALUCHE|ARANJUEZ|ARGANDA|ARGANZUELA|ARONA|ARRECIFE|AVILA|AVILES|BADAJOZ|BADALONA|"
        "BARAKALDO|BARCELONA|BARRI DE SANT ANDREU|BENALMADENA|BENIDORM|BILBAO|BOADILLA DEL MONTE|BURGOS|CACERES|"
        "CADIZ|CALVIA|CAMPINA|CARABANCHEL|CARTAGENA|CASTELLDEFELS|CASTELLO DE LA PLANA|CENTRO|"
        "CERDANYOLA DEL VALLES|CEUTA|CHAMARTIN|CHAMBERI|CHICLANA DE LA FRONTERA|CIUDAD LINEAL|CIUDAD REAL|"
        "CIUTAT VELLA|COLLADO VILLALBA|CORDOBA|CORNELLA DE LLOBREGAT|COSLADA|CUENCA|DELICIAS|"
        "DONOSTIA SAN SEBASTIAN|DOS HERMANAS|EIXAMPLE|EL EJIDO|EL PRAT DE LLOBREGAT|EL PUERTO DE SANTA MARIA|"
        "ELCHE|ELDA|ESTEPONA|FERROL|FUENCARRAL|FUENCARRAL EL PARDO|FUENGIROLA|FUENLABRADA|GAMONAL|GANDIA|"
        "GASTEIZ VITORIA|GETAFE|GETXO|GIJON|GIRONA|GRACIA|GRANADA|GRANOLLERS|GRAO DE MURVIEDRO|GUADALAJARA|"
        "HORTA GUINARDO|HORTALEZA|HUELVA|HUESCA|IRUN|JAEN|JEREZ DE LA FRONTERA|LA LAGUNA|"
        "LA LINEA DE LA CONCEPCION|LA NOVA ESQUERRA DE LEIXAMPLE|LA VILA DE GRACIA|LAS AGUILAS|"
        "LAS PALMAS DE GRAN CANARIA|LAS ROZAS DE MADRID|LATINA|LEGANES|LES CORTS|LHOSPITALET DE LLOBREGAT|"
        "LINARES|LLEIDA|LOGRONO|LORCA|LUGO|MADRID|MADRID CENTRO|MAJADAHONDA|MALAGA|MANRESA|MARBELLA|MATARO|"
        "MELILLA|MERIDA|MIJAS|MOLINA DE SEGURA|MOLLET DEL VALLES|MONCLOA ARAVACA|MORATALAZ|MOSTOLES|MOTRIL|"
        "MURCIA|NOU BARRIS|ORIHUELA|OURENSE|OVIEDO|PALENCIA|PALMA|PAMPLONA|PARLA|PATERNA|PINAR DEL REY|"
        "PONFERRADA|PONTEVEDRA|POZUELO DE ALARCON|PUEBLO NUEVO|PUENTE DE VALLECAS|PUERTOLLANO|RETIRO|REUS|"
        "RIVAS VACIAMADRID|ROQUETAS DE MAR|RUBI|SABADELL|SAGRADA FAMILIA|SAGUNTO|SALAMANCA|"
        "SAN BARTOLOME DE TIRAJANA|SAN BLAS CANILLEJAS|SAN FERNANDO|SAN SEBASTIAN|SAN SEBASTIAN DE LOS REYES|"
        "SAN VICENT DEL RASPEIG|SANLUCAR DE BARRAMEDA|SANT ANDREU|SANT BOI DE LLOBREGAT|SANT CUGAT DEL VALLES|"
        "SANT MARTI|SANTA COLOMA DE GRAMENET|SANTA CRUZ DE TENERIFE|SANTA LUCIA|SANTIAGO DE COMPOSTELA|"
        "SANTS MONTJUIC|SANTUTXU|SARRIA SANT GERVASI|SEGOVIA|SEVILLA|TALAVERA DE LA REINA|TARRAGONA|TELDE|"
        "TERRASSA|TETUAN DE LAS VICTORIAS|TORREJON DE ARDOZ|TORRELAVEGA|TORREMOLINOS|TORRENT|TORREVIEJA|USERA|"
        "UTRERA|VALDEFUENTES|VALDEMORO|VALENCIA|VALLADOLID|VALLECAS|VALVERDE|VELEZ MALAGA|VENTAS|VICALVARO|VIGO|"
        "VILA REAL|VILADECANS|VILANOVA I LA GELTRU|VILLA DE VALLECAS|VILLAVERDE|ZAMORA|ZARAGOZA"
    ),
    "ET": (
        "ADDIS ABABA|ADIGRAT|ADWA|AGARO|AKSUM|ALAMATA|ALEMAYA|ARABI|ARBA MINCH|AREKA|ARSI NEGELE|ASELA|ASOSA|"
        "AWASA|BAHIR DAR|BISHOFTU|BODITI|BONGA|BURAYU|BUTAJIRA|CHAGNI|CIRO|DANGILA|DEBRE BIRHAN|DEBRE MARKOS|"
        "DEBRE TABOR|DEMBI DOLO|DESSIE|DILA|DIRE DAWA|DURAME|FELEGE NEWAY|FICHE|FINOTE SELAM|GAMBELA|GIMBI|GOBA|"
        "GODE|GONDER|GUNUNO|HAGERE HIYWET|HAGERE MARYAM|HARAR|HOSAINA|INDA SILASE|JIJIGA|JIMMA|JINKA|KOBO|KOLITO|"
        "KOMBOLCHA|MEKELE|MEKI|METU|MIZAN TEFERI|MOJO|MOTA|NAZRET|NEGELE|NEKEMTE|SAMARA|SEBETA|SEKOTA|SHASHAMANE|"
        "SODO|TEPI|WALISO|WARDER|WELDIYA|WELKITE|WENDO|WIKRO|YIRGA ALEM|ZIWAY"
    ),
    "FI": (
        "EAST HELSINKI|ESPOO|HAEMEENLINNA|HAMEENLINNA|HELSINKI|JOENSUU|JYVAESKYLAE|JYVASKYLA|KOTKA|KOUVOLA|"
        "KUOPIO|LAHTI|LAPPEENRANTA|MIKKELI|OULU|PORI|PORVOO|ROVANIEMI|SALO|SEINAEJOKI|SEINAJOKI|TAMPERE|TURKU|"
        "VAASA|VANTAA"
    ),
    "FJ": "LAUTOKA|NASINU|SUVA",
    "FR": (
        "AIX EN PROVENCE|AJACCIO|ALBI|AMIENS|ANGERS|ANTIBES|ANTONY|ARGENTEUIL|ARLES|ASNIERES SUR SEINE|"
        "AUBERVILLIERS|AULNAY SOUS BOIS|AVIGNON|BEAUVAIS|BELFORT|BESANCON|BEZIERS|BLOIS|BORDEAUX|"
        "BOULOGNE BILLANCOURT|BOURGES|BREST|BRIVE LA GAILLARDE|CAEN|CALAIS|CERGY|CERGY PONTOISE|"
        "CHALONS EN CHAMPAGNE|CHAMBERY|CHAMPIGNY SUR MARNE|CHARLEVILLE MEZIERES|CHATEAUROUX|CHOLET|CLAMART|"
        "CLERMONT FERRAND|CLICHY|COLMAR|COLOMBES|COURBEVOIE|CRETEIL|DIJON|DRANCY|DUNKIRK|EVREUX|EVRY|"
        "FONTENAY SOUS BOIS|FREJUS|GARE|GRENOBLE|HYERES|ISSY LES MOULINEAUX|IVRY SUR SEINE|JUAN LES PINS|"
        "LA ROCHE SUR YON|LA ROCHELLE|LA SEYNE SUR MER|LAVAL|LE HAVRE|LE MANS|LEVALLOIS PERRET|LILLE|LIMOGES|"
        "LORIENT|LYON|MAISON BLANCHE|MAISONS ALFORT|MARNE LA VALLEE|MARSEILLE|MEAUX|MERIGNAC|METZ|MONTAUBAN|"
        "MONTPELLIER|MONTREUIL|MULHOUSE|NANTERRE|NANTES|NARBONNE|NEUILLY SUR SEINE|NICE|NIMES|NIORT|"
        "NOISY LE GRAND|PANTIN|PARIS|PERPIGNAN|PESSAC|PICPUS|POITIERS|QUIMPER|REIMS|RENNES|ROUBAIX|ROUEN|"
        "RUEIL MALMAISON|SAINT BRIEUC|SAINT DENIS|SAINT ETIENNE|SAINT MALO|SAINT MAUR DES FOSSES|SAINT NAZAIRE|"
        "SAINT QUENTIN|SAINT QUENTIN EN YVELINES|SARCELLES|SARTROUVILLE|STRASBOURG|TARBES|TOULON|TOULOUSE|"
        "TOURCOING|TROYES|VALENCE|VANNES|VENISSIEUX|VERSAILLES|VILLENEUVE DASCQ|VILLEURBANNE|VITRY SUR SEINE"
    ),
    "GA": "FRANCEVILLE|LIBREVILLE|MOANDA|NTOUM|OWENDO|OYEM|PORT GENTIL",
    "GB": (
        "ABBEY ROAD|ABBEY WOOD|ABBOTS LANGLEY|ABERCANAID|ABERCARN|ABERCYNON|ABERDARE|ABERDEEN|ABERGAVENNY|"
        "ABERGELE|ABERKENFIG|ABERTILLERY|ABERTRIDWR|ABERYSTWYTH|ABINGDON|ABRAM|ACCRINGTON|ACOCKS GREEN|ACTON|"
        "ADDLESTONE|ADLINGTON|ADWICK LE STREET|AIGBURTH|AIRDRIE|ALCESTER|ALDERSHOT|ALDRIDGE|ALEXANDRIA|ALFRETON|"
        "ALLERTON|ALLOA|ALNESS|ALNWICK|ALSAGER|ALTON|ALTRINCHAM|AMBLE|AMERSHAM|AMERSHAM ON THE HILL|AMESBURY|"
        "AMMANFORD|AMPTHILL|ANDOVER|ANNAN|ANNFIELD PLAIN|ANSTEY|ANTRIM|APPLEY BRIDGE|ARBROATH|ARCHWAY|ARDROSSAN|"
        "ARLESEY|ARMADALE|ARMAGH|ARMTHORPE|ARNOLD|ASCOT|ASH VALE|ASHBOURNE|ASHBY DE LA ZOUCH|ASHFORD|ASHINGTON|"
        "ASHTEAD|ASHTON IN MAKERFIELD|ASHTON UNDER LYNE|ASKERN|ASTON|ATHERSTONE|ATHERTON|ATTLEBOROUGH|"
        "AUCHTERARDER|AUDLEY|AVELEY|AXMINSTER|AYLESBURY|AYLESTONE|AYLSHAM|BACUP|BAGSHOT|BAILDON|BALDOCK|BALERNO|"
        "BALHAM|BALLINGRY|BALLYCASTLE|BALLYCLARE|BALLYMENA|BALLYMONEY|BALLYNAHINCH|BALSALL COMMON|BANBRIDGE|"
        "BANBURY|BANCHORY|BANGOR|BANNOCKBURN|BANSTEAD|BARGOED|BARKING|BARKINGSIDE|BARNARD CASTLE|BARNES|BARNET|"
        "BARNHAM|BARNOLDSWICK|BARNSBURY|BARNSLEY|BARNSTAPLE|BARNT GREEN|BARRHEAD|BARROW IN FURNESS|"
        "BARROW UPON SOAR|BARROWFORD|BARRY|BARTLEY GREEN|BARTON ON SEA|BARTON UPON HUMBER|BASFORD|"
        "BASFORD STOKE ON TRENT|BASILDON|BASINGSTOKE|BATCHWORTH|BATHGATE|BATLEY|BATTERSEA|BATTLE|BAYSTON HILL|"
        "BAYSWATER|BEACONSFIELD|BEARSDEN|BEBINGTON|BECCLES|BECKENHAM|BECONTREE|BEDDAU|BEDFORD|BEDLINGTON|BEDWAS|"
        "BEDWORTH|BEIGHTON|BEITH|BELFAST|BELGRAVE|BELLE VALE|BELLSHILL|BELMONT|BELPER|BELSIZE PARK|BELVEDERE|"
        "BENNETTS END|BENSON|BENTLEY|BENWELL|BERKHAMSTED|BERNARDS HEATH|BERWICK UPON TWEED|BETHNAL GREEN|"
        "BEVERLEY|BEWBUSH|BEWDLEY|BEXHILL ON SEA|BEXLEY|BICESTER|BICKLEY|BIDDULPH|BIDEFORD|BIDFORD ON AVON|"
        "BIGGIN HILL|BIGGLESWADE|BILLERICAY|BILLINGE|BILLINGHAM|BILLINGSHURST|BINGHAM|BINGLEY|BIRCHINGTON ON SEA|"
        "BIRCOTES|BIRKENHEAD|BIRMINGHAM|BIRSTALL|BISHOP AUCKLAND|BISHOPBRIGGS|BISHOPS CLEEVE|BISHOPS STORTFORD|"
        "BISHOPS WALTHAM|BISHOPSTOKE|BISHOPSWORTH|BLABY|BLACKBURN|BLACKHEATH|BLACKLEY|BLACKPOOL|BLACKROD|"
        "BLACKWALL|BLACKWOOD|BLACON|BLAENAVON|BLAIRGOWRIE AND RATTRAY|BLANDFORD FORUM|BLANTYRE|BLAYDON ON TYNE|"
        "BLETCHLEY|BLOXWICH|BLYTH|BODMIN|BOGNOR REGIS|BOLLINGTON|BOLSOVER|BOLTON|BOLTON LE SANDS|"
        "BOLTON UPON DEARNE|BONESS|BONHILL|BONNYBRIDGE|BONNYRIGG|BOOTLE|BORDON|BOREHAMWOOD|BORROWASH|BOSTON SPA|"
        "BOTHWELL|BOUGHTON|BOURNE|BOURNE END|BOURNEMOUTH|BOVINGDON|BOWDON|BOWTHORPE|BRACEBRIDGE HEATH|BRACKLEY|"
        "BRACKNELL|BRADFORD|BRADFORD ON AVON|BRADWELL|BRAINTREE|BRAMCOTE|BRAMHALL|BRAUNSTONE|BRAUNTON|BRECHIN|"
        "BRECON|BREDBURY|BRENT|BRENTFORD|BRENTWOOD|BRIDGE OF ALLAN|BRIDGEND|BRIDGNORTH|BRIDGWATER|BRIDLINGTON|"
        "BRIDPORT|BRIERFIELD|BRIERLEY HILL|BRIGG|BRIGHOUSE|BRIGHTLINGSEA|BRIGHTON|BRISTOL|BRITON FERRY|BRITWELL|"
        "BRIXHAM|BRIXTON|BRIXTON HILL|BRIXWORTH|BROADFIELD|BROADSTAIRS|BROADSTONE|BROADWATER|BROCKLEY|"
        "BROMBOROUGH|BROMSGROVE|BROSELEY|BROTTON|BROUGH|BROUGHTON|BROUGHTON ASTLEY|BROWNHILLS|BROXBOURNE|"
        "BROXBURN|BRUNDALL|BRYMBO|BRYNAMMAN|BRYNMAWR|BRYNNA|BUCKHURST HILL|BUCKIE|BUCKINGHAM|BUCKLEY|BUDE|"
        "BUDLEIGH SALTERTON|BULFORD|BUNGAY|BURGESS HILL|BURLEY IN WHARFEDALE|BURNAGE|BURNGREAVE|BURNHAM|"
        "BURNHAM ON CROUCH|BURNHAM ON SEA|BURNLEY|BURNTISLAND|BURNTWOOD|BURPHAM|BURRY PORT|BURSCOUGH|BURSLEDON|"
        "BURTON LATIMER|BURTON UPON TRENT|BURWELL|BURY|BURY ST EDMUNDS|BUSHEY|BUXTON|CAERLEON|CAERNARFON|"
        "CAERPHILLY|CAISTER ON SEA|CALCOT|CALDICOT|CALLINGTON|CALNE|CALVERTON|CAMBERLEY|CAMBORNE|CAMBOURNE|"
        "CAMBUSLANG|CAMDEN TOWN|CANARY WHARF|CANFORD HEATH|CANNING TOWN|CANNOCK|CANONBURY|CANTERBURY|"
        "CANVEY ISLAND|CARCROFT|CARDIFF|CARDIGAN|CARLISLE|CARLUKE|CARMARTHEN|CARNFORTH|CARNOUSTIE|"
        "CARPENDERS PARK|CARRICKFERGUS|CARRYDUFF|CARSHALTON|CARTERTON|CASTLE DONINGTON|CASTLE VALE|CASTLEFORD|"
        "CASTLEREAGH|CATERHAM|CATFORD|CATTERICK GARRISON|CHADDERTON|CHADDESDEN|CHADWELL HEATH|CHADWELL ST MARY|"
        "CHAFFORD HUNDRED|CHALFONT SAINT PETER|CHALFONT ST GILES|CHALFORD|CHALK FARM|CHAPEL ALLERTON|"
        "CHAPEL EN LE FRITH|CHAPELHALL|CHAPELTOWN|CHARD|CHARLTON|CHARLTON KINGS|CHASETOWN|CHATHAM|CHATTERIS|"
        "CHEADLE|CHEADLE HULME|CHEAM|CHEDDAR|CHEETHAM HILL|CHELMSFORD|CHELMSLEY WOOD|CHELSEA|CHELSFIELD|"
        "CHELTENHAM|CHEPSTOW|CHERTSEY|CHESHAM|CHESHUNT|CHESSINGTON|CHESTER LE STREET|CHESTERFIELD|CHICHESTER|"
        "CHIGWELL|CHILDWALL|CHILWELL|CHINGFORD|CHINNOR|CHIPPENHAM|CHIPPING NORTON|CHIPPING SODBURY|CHISLEHURST|"
        "CHISWELL GREEN|CHISWICK|CHORLEY|CHORLEYWOOD|CHRISTCHURCH|CHURCH STREET|CHURCHDOWN|CINDERFORD|"
        "CIRENCESTER|CITY OF LONDON|CITY OF WESTMINSTER|CLACTON ON SEA|CLAPHAM JUNCTION|CLARKSTON|"
        "CLAYTON LE MOORS|CLAYTON LE WOODS|CLAYTON WEST|CLEATOR MOOR|CLECKHEATON|CLEETHORPES|CLEVEDON|CLEVELEYS|"
        "CLITHEROE|CLOWNE|CLYDACH|CLYDEBANK|COALISLAND|COALVILLE|COATBRIDGE|COBHAM|COCKENZIE|COCKERMOUTH|"
        "COCKFOSTERS|COCKINGTON|CODICOTE|CODSALL|COEDPOETH|COITY|COLCHESTER|COLEFORD|COLERAINE|COLINTON|"
        "COLLIER ROW|COLNBROOK|COLNE|COLWYN BAY|COMBER|CONGLETON|CONISBROUGH|CONSETT|COOKHAM|COOKSTOWN|COPPULL|"
        "CORBY|CORSHAM|COSHAM|COTGRAVE|COTTENHAM|COULSDON|COUNTESTHORPE|COVE|COVENTRY|COWDENBEATH|COWES|COWLEY|"
        "COWPLAIN|CRADLEY HEATH|CRAIGAVON|CRAMLINGTON|CRANFIELD|CRANFORD|CRANLEIGH|CRAWLEY|CREDITON|CRESWELL|"
        "CREWE|CREWKERNE|CRICKLEWOOD|CRIEFF|CROFTON|CROFTON PARK|CROMER|CROOK|CROSS HILLS|CROUCH END|CROWBOROUGH|"
        "CROWTHORNE|CROXLEY GREEN|CROXTETH|CROYDON|CRUMLIN|CRUMPSALL|CRYSTAL PALACE|CUDWORTH|CULCHETH|CULLOMPTON|"
        "CUMBERNAULD|CUMNOCK|CUNNINGHAM|CUPAR|CURRIE|CWMAFAN|CWMBRAN|DAGENHAM|DALGETY BAY|DALKEITH|DALMUIR|DALRY|"
        "DALSERF|DALTON IN FURNESS|DANBURY|DARFIELD|DARLINGTON|DARRAS HALL|DARTFORD|DARTMOUTH|DARTON|DARWEN|"
        "DAVENTRY|DAWLISH|DEESIDE|DEGANWY|DENBIGH|DENMEAD|DENNY|DENTON|DENTON HOLME|DERBY|DERRY|DESBOROUGH|"
        "DEVIZES|DEWSBURY|DHEKELIA|DIDCOT|DIDSBURY|DINAS POWYS|DINGLE|DINGWALL|DINNINGTON|DISS|DODWORTH|"
        "DONAGHADEE|DONCASTER|DONINGTON LE HEATH|DORCHESTER|DORKING|DORRIDGE|DOWNHAM MARKET|DOWNPATRICK|DOWNSIDE|"
        "DRIFFIELD|DROITWICH|DROMORE|DRONFIELD|DROYLSDEN|DUDLEY|DUKINFIELD|DUMBARTON|DUMFRIES|DUNBAR|DUNBLANE|"
        "DUNDEE|DUNDONALD|DUNFERMLINE|DUNGANNON|DUNHOLME|DUNOON|DUNSTABLE|DUNTOCHER|DURHAM|DURSLEY|DYCE|"
        "EAGLESCLIFFE|EALING COMMON|EARL SHILTON|EARLS BARTON|EARLS COURT|EARLSFIELD|EARLSWOOD|EASINGTON|"
        "EAST BARNET|EAST BOLDON|EAST COWES|EAST DEREHAM|EAST DULWICH|EAST GRINSTEAD|EAST HORSLEY|EAST KILBRIDE|"
        "EAST LEAKE|EAST MOLESEY|EAST SHEEN|EAST TILBURY|EAST WITTERING|EASTBOURNE|EASTLEIGH|EASTON|EASTWOOD|"
        "EATON SOCON|EBBW VALE|ECCLES|EDENBRIDGE|EDGWARE|EDGWAREBURY|EDINBURGH|EDMONTON|EDWINSTOWE|EGHAM|"
        "EGREMONT|ELDERSLIE|ELGIN|ELLAND|ELLESMERE PORT TOWN|ELLON|ELM PARK|ELTHAM|EMERSON PARK|EMSWORTH|ENDERBY|"
        "ENFIELD LOCK|ENFIELD TOWN|ENNISKILLEN|EPPING|EPSOM|ERITH|ERSKINE|ESHER|ESTON|EUXTON|EVESHAM|EVINGTON|"
        "EWELL|EXETER|EXMOUTH|FAIFLEY|FAILSWORTH|FAIR OAK|FAKENHAM|FALKIRK|FALLOWFIELD|FALMOUTH|FAREHAM|"
        "FARINGDON|FARNBOROUGH|FARNHAM|FARNHAM ROYAL|FARNWORTH|FAVERSHAM|FAZAKERLEY|FAZELEY|FEATHERSTONE|"
        "FELIXSTOWE|FELLING|FELTHAM|FERNDALE|FERNDOWN|FERRYHILL|FETCHAM|FILEY|FINCHLEY|FLACKWELL HEATH|FLEET|"
        "FLEETVILLE|FLEETWOOD|FLINT|FLITWICK|FOLKESTONE|FORDINGBRIDGE|FOREST HILL|FORFAR|FORMBY|FORRES|"
        "FORT WILLIAM|FOUR MARKS|FRASERBURGH|FRECKLETON|FRESHWATER|FRIERN BARNET|FRIMLEY|FRIMLEY GREEN|"
        "FRINTON ON SEA|FRODSHAM|FROME|FULHAM|FULWOOD|FURNACE GREEN|FURZE PLATT|FURZEDOWN|FYLDE|GAINSBOROUGH|"
        "GALASHIELS|GARFORTH|GARSTANG|GARSTON|GARSWOOD|GATESHEAD|GEDLING|GELLIGAER|GERRARDS CROSS|GIFFNOCK|"
        "GILLINGHAM|GIPSY HILL|GIRVAN|GLASGOW|GLASTONBURY|GLEN PARVA|GLENFIELD|GLENROTHES|GLOSSOP|GLOUCESTER|"
        "GLUSBURN|GLYN NEATH|GODALMING|GODMANCHESTER|GOLBORNE|GOLDERS GREEN|GOODMAYES|GOOLE|GOREBRIDGE|"
        "GORLESTON ON SEA|GORSEINON|GOSFORTH|GOSPORT|GOSSOPS GREEN|GOUROCK|GRANGE HILL|GRANGEMOUTH|GRANTHAM|"
        "GRAPPENHALL|GRAVESEND|GRAYS|GREASBY|GREAT BOOKHAM|GREAT DUNMOW|GREAT GONERBY|GREAT HARWOOD|"
        "GREAT MALVERN|GREAT MISSENDEN|GREAT SANKEY|GREAT TORRINGTON|GREAT WAKERING|GREAT WYRLEY|GREAT YARMOUTH|"
        "GREENFORD|GREENHILL|GREENHITHE|GREENISLAND|GREENOCK|GREENWICH|GRESFORD|GRIMSBY|GROBY|GROVE|GUILDFORD|"
        "GUISBOROUGH|GUISELEY|HADDINGTON|HADLEIGH|HADLEY|HADLEY WOOD|HAGLEY|HAILSHAM|HAINAULT|HALE|HALE BARNS|"
        "HALESOWEN|HALESWORTH|HALEWOOD|HALSTEAD|HAMPTON|HAMPTON WICK|HANWORTH|HARDINGSTONE|HAREFIELD|HARLESDEN|"
        "HARLOW|HAROLD WOOD|HARPENDEN|HARRINGAY|HARROGATE|HARROW|HARROW ON THE HILL|HARROW ROAD|HARROW WEALD|"
        "HARTLEPOOL|HARTLEY|HARTSHILL|HARWICH|HASLEMERE|HASLINGDEN|HASSOCKS|HASTINGS|HATCH END|HATFIELD|"
        "HAUGHTON GREEN|HAVANT|HAVERFORDWEST|HAVERHILL|HAWARDEN|HAWICK|HAWKINGE|HAWORTH|HAXBY|HAYDOCK|HAYES|"
        "HAYLE|HAYLING ISLAND|HAYWARDS HEATH|HAZEL GROVE|HEADSTONE|HEANOR|HEAVITREE|HEBBURN|HECKMONDWIKE|"
        "HEDGE END|HEDON|HEIGHINGTON|HELENSBURGH|HELSBY|HELSTON|HEMEL HEMPSTEAD|HEMSBY|HEMSWORTH|HENGOED|"
        "HENLEY ON THAMES|HENLOW|HEREFORD|HERNE BAY|HERTFORD|HESTON|HESWALL|HETHERSETT|HETTON LE HOLE|HEXHAM|"
        "HEYSHAM|HEYWOOD|HIGH BARNET|HIGH BLANTYRE|HIGH PEAK|HIGH WYCOMBE|HIGHAM FERRERS|HIGHAMS PARK|HIGHBURY|"
        "HIGHGATE|HIGHWORTH|HILLINGDON|HINCKLEY|HINDHEAD|HINDLEY|HIRWAUN|HISTON|HITCHIN|HOCKLEY|HODDESDON|"
        "HOLBEACH|HOLBECK|HOLBORN|HOLLINWOOD|HOLLOWAY|HOLMES CHAPEL|HOLYHEAD|HOLYTOWN|HOLYWELL|HOLYWOOD|HONITON|"
        "HOOK|HORBURY|HORLEY|HORNCASTLE|HORNCHURCH|HORNSEA|HORNSEY|HORSFORTH|HORSHAM|HORWICH|HOUGHTON LE SPRING|"
        "HOUNSLOW|HOUSTON|HOYLAKE|HOYLAND NETHER|HUCKNALL|HUDDERSFIELD|HULME|HUMBERSTON|HUMBERSTONE|HUNGERFORD|"
        "HUNSTANTON|HUNTINGDON|HUNTS CROSS|HURSTPIERPOINT|HUYTON|HYDE|HYDE PARK|HYTHE|IBSTOCK|ICKENHAM|ILFORD|"
        "ILFRACOMBE|ILKESTON|ILKLEY|ILMINSTER|IMMINGHAM|INCE IN MAKERFIELD|INGATESTONE|INGLEBY GREENHOW|"
        "INVERKEITHING|INVERNESS|INVERURIE|IPSWICH|IRLAM|IRTHLINGBOROUGH|IRVINE|ISLE OF ARRAN|ISLE OF BUTE|"
        "ISLE OF LEWIS|ISLEWORTH|ISLINGTON|IVER|IVER HEATH|IVYBRIDGE|JARROW|JOHNSTONE|JORDANSTOWN|KEARSLEY|"
        "KEIGHLEY|KELSO|KELTY|KELVEDON|KEMPSTON|KEMPSTON HARDWICK|KEMSING|KENDAL|KENILWORTH|KENLEY|KENSAL GREEN|"
        "KENSINGTON|KESGRAVE|KETTERING|KEYNSHAM|KEYWORTH|KIBWORTH HARCOURT|KIDBROOKE|KIDDERMINSTER|KIDLINGTON|"
        "KIDSGROVE|KILBIRNIE|KILBURN|KILKEEL|KILLAMARSH|KILMARNOCK|KILSYTH|KILWINNING|KIMBERLEY|KINGS CROSS|"
        "KINGS LANGLEY|KINGS LYNN|KINGSBRIDGE|KINGSTEIGNTON|KINGSTON UPON HULL|KINGSTON UPON THAMES|KINGSWINFORD|"
        "KINGSWOOD|KIPPAX|KIRBY MUXLOE|KIRK SANDALL|KIRKBY|KIRKBY IN ASHFIELD|KIRKCALDY|KIRKDALE|KIRKHAM|"
        "KIRKINTILLOCH|KIRKLEATHAM|KIRKWALL|KIRRIEMUIR|KIVETON PARK|KNAPHILL|KNARESBOROUGH|"
        "KNIGHTSBRIDGE AND BELGRAVIA|KNOTTINGLEY|KNOTTY ASH|KNOWLE|KNUTSFORD|LADYWELL|LAMBETH|LANARK|LANCASTER|"
        "LANCASTER GATE|LANCING|LANGLEY GREEN|LARBERT|LARGS|LARKFIELD|LARKHALL|LARNE|LATCHMERE|LAUNCESTON|"
        "LEATHERHEAD|LEAVESDEN GREEN|LEDBURY|LEE ON THE SOLENT|LEEDS|LEEK|LEES|LEICESTER|LEICESTER FOREST EAST|"
        "LEIGH|LEIGHTON BUZZARD|LEISTON|LENZIE|LEOMINSTER|LERWICK|LETCHWORTH GARDEN CITY|LEVEN|LEVERSTOCK GREEN|"
        "LEWES|LEYLAND|LEYTON|LEYTONSTONE|LICHFIELD|LIGHTWATER|LIMAVADY|LIMEHOUSE|LINLITHGOW|LINWOOD|LIPHOOK|"
        "LISBURN|LISKEARD|LISS|LITHERLAND|LITTLE BOOKHAM|LITTLE HULTON|LITTLE LEVER|LITTLE VENICE|LITTLEBOROUGH|"
        "LITTLEHAMPTON|LITTLEPORT|LIVERPOOL|LIVERSEDGE|LIVINGSTON|LLANDAFF|LLANDRINDOD WELLS|LLANDUDNO|LLANELLI|"
        "LLANHARAN|LLANTRISANT|LLANTWIT MAJOR|LOANHEAD|LOCHARBRIGGS|LOCHGELLY|LOFTHOUSE|LONDON|LONDON COLNEY|"
        "LONDONDERRY COUNTY BOROUGH|LONG ASHTON|LONG DITTON|LONG EATON|LONGDENDALE|LONGFIELD|LONGRIDGE|LONGSIGHT|"
        "LONGTON|LOOE|LOSSIEMOUTH|LOUGHBOROUGH|LOUGHTON|LOUTH|LOWER EARLEY|LOWESTOFT|LUDLOW|LUTON|LUTTERWORTH|"
        "LYDNEY|LYMINGTON|LYMM|LYNEHAM|LYTHAM ST ANNES|MABLETHORPE|MACCLESFIELD|MAESTEG|MAGHERAFELT|MAGHULL|"
        "MAGOR|MAIDA HILL|MAIDENBOWER|MAIDENHEAD|MAIDSTONE|MALDON|MALMESBURY|MALTBY|MALTON|MANCHESTER|"
        "MANCHESTER CITY CENTRE|MANGOTSFIELD|MANNINGTREE|MANOR PARK|MANSFIELD|MANSFIELD WOODHOUSE|MANSTON|"
        "MARCHWOOD|MARGATE|MARKET DEEPING|MARKET DRAYTON|MARKET HARBOROUGH|MARKET WARSOP|MARKET WEIGHTON|"
        "MARLBOROUGH|MARLOW|MARPLE|MARSHALSWICK|MARSKE BY THE SEA|MARYLEBONE|MARYPORT|MATLOCK|MAYFIELD|MEASHAM|"
        "MEIKLE EARNOCK|MELKSHAM|MELTHAM|MELTHAM MILLS|MELTON MOWBRAY|MENDIP|MERIDEN|MERROW|MERSTHAM|"
        "MERTHYR TYDFIL|METHIL|MEXBOROUGH|MIDDLESBROUGH|MIDDLETON|MIDDLEWICH|MIDHURST|MIDSOMER NORTON|MILDENHALL|"
        "MILFORD|MILFORD HAVEN|MILL END|MILLOM|MILNGAVIE|MILNROW|MILTON KEYNES|MINEHEAD|MIRFIELD|MITCHAM|MOLD|"
        "MONIFIETH|MONKHAMS|MONMOUTH|MONTROSE|MOODIESBURN|MOOR PARK|MORDEN|MORECAMBE|MORETON|MORPETH|MORTLAKE|"
        "MOSSEND|MOSSLEY|MOSSLEY HILL|MOTHERWELL|MOTTINGHAM|MOUNTAIN ASH|MOUNTSORREL|MURTON|MUSSELBURGH|"
        "MUSWELL HILL|NAILSEA|NAILSWORTH|NAIRN|NANTWICH|NARBOROUGH|NEATH|NEILSTON|NELSON|NESTON|NETHER EDGE|"
        "NETHERLEY|NETLEY|NEW ALRESFORD|NEW BARNET|NEW BASFORD|NEW CROSS|NEW FERRY|NEW MALDEN|NEW MILL|NEW MILLS|"
        "NEW MILTON|NEW ROMNEY|NEW STEVENSTON|NEWARK ON TRENT|NEWARTHILL|NEWBIGGIN BY THE SEA|NEWBRIDGE|NEWBURN|"
        "NEWBURY|NEWBURY PARK|NEWCASTLE|NEWCASTLE UNDER LYME|NEWCASTLE UPON TYNE|NEWHAVEN|NEWMAINS|NEWMARKET|"
        "NEWPORT|NEWPORT PAGNELL|NEWQUAY|NEWRY|NEWTON ABBOT|NEWTON AYCLIFFE|NEWTON LE WILLOWS|NEWTON MEARNS|"
        "NEWTOWN|NEWTOWNABBEY|NEWTOWNARDS|NIGG|NORBITON|NORBURY|NORRIS GREEN|NORTH ANSTON|NORTH BADDESLEY|"
        "NORTH BERWICK|NORTH FERRIBY|NORTH SHIELDS|NORTH WALSHAM|NORTH WATFORD|NORTHALLERTON|NORTHAM|NORTHAMPTON|"
        "NORTHOLT|NORTHUMBERLAND PARK|NORTHWICH|NORTHWOOD|NORTHWOOD HILLS|NORTON|NORTON CANES|NORWICH|"
        "NOTTING HILL|NOTTINGHAM|NUNEATON|OADBY|OAKENGATES|OAKHAM|OAKWOOD|OBAN|OKEHAMPTON|OLD HARLOW|OLD SWAN|"
        "OLD TRAFFORD|OLD WINDSOR|OLDBURY|OLDHAM|OLNEY|OMAGH|ORMSKIRK|ORPINGTON|OSSETT|OSTERLEY|OSWESTRY|OTFORD|"
        "OTLEY|OUNDLE|OXFORD|OXTED|PADDOCK WOOD|PADIHAM|PAIGNTON|PAISLEY|PALMERS GREEN|PARKSTONE|PARTINGTON|"
        "PEACEHAVEN|PEASEDOWN SAINT JOHN|PECKHAM|PEEBLES|PELSALL|PELTON|PEMBROKE|PEMBROKE DOCK|PEMBURY|PENARTH|"
        "PENCOED|PENICUIK|PENISTONE|PENKRIDGE|PENRITH|PENRYN|PENTRE|PENZANCE|PERRY VALE|PERSHORE|PERTH|"
        "PETERBOROUGH|PETERHEAD|PETERLEE|PETERSFIELD|PICKERING|PIMLICO|PINKNEYS GREEN|PINNER|PINXTON|PITSEA|"
        "PLUMSTEAD|PLYMOUTH|PLYMPTON|PLYMSTOCK|POCKLINGTON|POLESWORTH|POLMONT|PONDERS END|PONTARDDULAIS|"
        "PONTEFRACT|PONTELAND|PONTYCLUN|PONTYPOOL|PONTYPRIDD|POOLE|POPLAR|PORINGLAND|PORT GLASGOW|PORTADOWN|"
        "PORTHCAWL|PORTISHEAD|PORTLAND|PORTLETHEN|PORTRUSH|PORTSLADE|PORTSMOUTH|PORTSTEWART|PORTSWOOD|"
        "POTTERS BAR|POULTON LE FYLDE|POYNTON|PREESALL|PRENTON|PRESCOT|PRESTATYN|PRESTONPANS|PRESTWICH|PRESTWICK|"
        "PRIMROSE PLACE|PRINCES RISBOROUGH|PRUDHOE|PUDSEY|PURFLEET ON THAMES|PURLEY|PUTNEY|PYLE|PYRFORD|"
        "QUEENS PARK|QUEENSBURY|QUEENSFERRY|QUEENSTOWN|QUORNDON|RADCLIFFE|RADCLIFFE ON TRENT|RADLETT|RADSTOCK|"
        "RAINFORD|RAINHAM|RAINHILL|RAINWORTH|RAMSBOTTOM|RAMSEY|RAMSGATE|RANDALSTOWN|RASTRICK|RAUNDS|RAVENSHEAD|"
        "RAWMARSH|RAWTENSTALL|RAYLEIGH|REDBOURN|REDCAR|REDDITCH|REDHILL|REDRUTH|REGENTS PARK|REIGATE|RENFREW|"
        "RETFORD|RHIWBINA|RHONDDA|RHOOSE|RHOSLLANNERCHRUGOG|RHYL|RHYMNEY|RICKMANSWORTH|RINGWOOD|RIPLEY|RIPON|"
        "RISCA|RISHTON|ROCHDALE|ROCHESTER|ROCHFORD|ROEHAMPTON|ROMFORD|ROMSEY|ROSS ON WYE|ROSSENDALE|ROSYTH|"
        "ROTHERHAM|ROTHERHITHE|ROTHWELL|ROTTINGDEAN|ROWLANDS GILL|ROYAL LEAMINGTON SPA|ROYAL TUNBRIDGE WELLS|"
        "ROYAL WOOTTON BASSETT|ROYSTON|ROYTON|RUDDINGTON|RUGBY|RUGELEY|RUISLIP|RUISLIP MANOR|RUNCORN|RUSHDEN|"
        "RUSKINGTON|RUSTINGTON|RUTHERGLEN|RUTHIN|RYDE|RYHILL|RYHOPE|RYTON|SACRISTON|SADDLEWORTH|SAFFRON WALDEN|"
        "SAINT ANDREWS|SAINT BLAZEY|SAINT IVES|SAINT LEONARDS ON SEA|SAINT NEOTS|SAINT PETERS|SALFORD|SALISBURY|"
        "SALTAIRE|SALTASH|SALTBURN BY THE SEA|SALTCOATS|SANDBACH|SANDERSTEAD|SANDHURST|SANDOWN|SANDY|SAUCHIE|"
        "SAWBRIDGEWORTH|SAWSTON|SAWTRY|SCALBY|SCARBOROUGH|SCONE|SCUNTHORPE|SEAFORD|SEAHAM|SEATON|SEATON DELAVAL|"
        "SELBY|SELKIRK|SELSEY|SEND|SEVEN SISTERS|SEVENOAKS|SHADWELL|SHAFTESBURY|SHANKLIN|SHEERNESS|SHEFFIELD|"
        "SHEFFORD|SHELLEY|SHENFIELD|SHEPHERDS BUSH|SHEPLEY|SHEPPERTON|SHEPSHED|SHEPTON MALLET|SHERBORNE|"
        "SHERBURN IN ELMET|SHERINGHAM|SHEVINGTON|SHIFNAL|SHILDON|SHIPLEY|SHIPSTON ON STOUR|SHIREBROOK|SHIRLEY|"
        "SHOREHAM BY SEA|SHORTLANDS|SHOTTS|SHREWSBURY|SIDCUP|SIDMOUTH|SILEBY|SILSDEN|SINFIN|SITTINGBOURNE|"
        "SKEGNESS|SKELMERSDALE|SKELTON|SKIPTON|SLEAFORD|SLOUGH|SMETHWICK|SNARESBROOK|SNODLAND|SOHAM|SOHO|"
        "SOLIHULL|SOPWELL|SOUTH BENFLEET|SOUTH CROYDON|SOUTH ELMSALL|SOUTH HAYLING|SOUTH MOLTON|SOUTH NORWOOD|"
        "SOUTH OCKENDON|SOUTH RUISLIP|SOUTH SHIELDS|SOUTHALL|SOUTHAM|SOUTHAMPTON|SOUTHEND ON SEA|SOUTHGATE|"
        "SOUTHPORT|SOUTHSEA|SOUTHWATER|SOUTHWELL|SOWERBY BRIDGE|SPALDING|SPEKE|SPENNYMOOR|SPITALFIELDS|ST ALBANS|"
        "ST ANNS|ST AUSTELL|ST HELENS|ST HELIER|ST IVES|ST JAMESS|ST LEONARDS|STAFFORD|STAINES|STAINFORTH|"
        "STAKEFORD|STALYBRIDGE|STAMFORD|STAMFORD HILL|STANFORD LE HOPE|STANLEY|STANSTED MOUNTFITCHET|STANWELL|"
        "STAPLEFORD|STAPLEHURST|STAVELEY|STENHOUSEMUIR|STEPNEY|STEPPS|STEVENAGE|STEVENSTON|STEWARTON|STEYNING|"
        "STIRLING|STOCKPORT|STOCKSBRIDGE|STOCKTON HEATH|STOCKTON ON TEES|STOKE GIFFORD|STOKE ON TRENT|STONE|"
        "STONEHAVEN|STONEHOUSE|STORNOWAY|STORRINGTON|STOTFOLD|STOURBRIDGE|STOURPORT ON SEVERN|STOWMARKET|"
        "STRABANE|STRANRAER|STRATFORD|STRATFORD UPON AVON|STRATHAVEN|STREATHAM|STREETLY|STRENSALL|STRETFORD|"
        "STROOD|STROUD|STROUD GREEN|STUDLEY|STURRY|SUDBURY|SUNBURY ON THAMES|SUNDERLAND|SUNNINGHILL|SURBITON|"
        "SUTTON COLDFIELD|SUTTON IN ASHFIELD|SWADLINCOTE|SWAFFHAM|SWANAGE|SWANLEY|SWANSCOMBE|SWANSEA|SWINDON|"
        "SWINTON|SYSTON|TADCASTER|TADLEY|TADWORTH|TAMWORTH|TARLETON|TAUNTON|TAVISTOCK|TEDDINGTON|TEIGNMOUTH|"
        "TELFORD|TENTERDEN|TETBURY|TEWKESBURY|THAME|THAMES DITTON|THAMESMEAD|THATCHAM|THE BOLDONS|THETFORD|"
        "THIRSK|THORNABY ON TEES|THORNBURY|THORNE|THORNHILL|THORNTON|THORNTON CLEVELEYS|THORNTON HEATH|THORPE|"
        "THORPE HAMLET|THRAPSTON|THURSO|TIDWORTH|TILBURY|TILLICOULTRY|TIMPERLEY|TIPTON|TIPTREE|TITCHFIELD|"
        "TIVERTON|TODMORDEN|TOLWORTH|TONBRIDGE|TONYPANDY|TONYREFAIL|TOOTING|TORPOINT|TORQUAY|TOTNES|TOTON|"
        "TOTTENHAM|TOTTENHAM HALE|TOTTERIDGE|TOTTINGTON|TOTTON|TOWCESTER|TOWNSEND|TRANENT|TREDEGAR|TREHARRIS|"
        "TREORCHY|TRING|TROON|TROWBRIDGE|TRURO|TULLIBODY|TUNSTALL|TURRIFF|TWYFORD|TYLDESLEY|TYNEMOUTH|UCKFIELD|"
        "UDDINGSTON|ULVERSTON|UNDY|UPMINSTER|UPPER NORWOOD|UPPERMILL|UPTON|UPTON LEA|URMSTON|USHAW MOOR|"
        "UTTOXETER|UXBRIDGE|VALE OF LEVEN|VENTNOR|VERWOOD|VIEWPARK|VINCENT SQUARE|WADEBRIDGE|WAKEFIELD|WALES|"
        "WALKDEN|WALLASEY|WALLINGFORD|WALLINGTON|WALLSEND|WALSALL|WALTHAM|WALTHAM ABBEY|WALTHAM CROSS|"
        "WALTHAMSTOW|WALTON ON THAMES|WALTON ON THE NAZE|WANSTEAD|WANTAGE|WARDLE|WARE|WAREHAM|WARLINGHAM|"
        "WARMINSTER|WARRENPOINT|WARRINGTON|WARSOP|WASHINGBOROUGH|WASHINGTON|WASHWOOD HEATH|WATER EATON|"
        "WATERBEACH|WATERLOOVILLE|WATFORD|WATH UPON DEARNE|WATTON|WAVERTREE|WEALDSTONE|WEAVERHAM|WEDNESBURY|"
        "WEDNESFIELD|WELLESBOURNE|WELLESBOURNE MOUNTFORD|WELLING|WELLINGBOROUGH|WELLINGTON|WELSHPOOL|"
        "WELWYN GARDEN CITY|WEMBLEY|WENDOVER|WEST BRIDGFORD|WEST BROMWICH|WEST BYFLEET|WEST CLANDON|WEST DERBY|"
        "WEST DRAYTON|WEST EALING|WEST END|WEST END OF LONDON|WEST HALLAM|WEST HAM|WEST KINGSDOWN|WEST KIRBY|"
        "WEST MERSEA|WEST MOLESEY|WEST THURROCK|WEST WATFORD|WEST WICKHAM|WESTBOURNE|WESTBURY|WESTERGATE|"
        "WESTGATE ON SEA|WESTHILL|WESTHOUGHTON|WESTON SUPER MARE|WETHERBY|WEYBRIDGE|WEYMOUTH|WHALEY BRIDGE|"
        "WHEATLEY|WHETSTONE|WHICKHAM|WHISTON|WHITBURN|WHITBY|WHITCHURCH|WHITECHAPEL|WHITEFIELD|WHITEHAVEN|"
        "WHITLEY BAY|WHITSTABLE|WHITTLESEY|WHITWORTH|WICK|WICKFORD|WIDEOPEN|WIDNES|WIGAN|WIGSTON MAGNA|WIGTON|"
        "WILLENHALL|WILLESDEN|WILLINGTON|WILMSLOW|WILSDEN|WIMBLEDON|WIMBLEDON PARK|WIMBORNE MINSTER|WINCANTON|"
        "WINCHESTER|WINDERMERE|WINGATE|WINGERWORTH|WINSFORD|WIRKSWORTH|WISBECH|WISHAW|WITHAM|WITHERNSEA|WITLEY|"
        "WITNEY|WIVENHOE|WOBURN SANDS|WOKING|WOKINGHAM|WOLVERHAMPTON|WOMBOURNE|WOMBWELL|WOOD GREEN|WOODBRIDGE|"
        "WOODFORD GREEN|WOODSIDE|WOOLSTON|WOOLTON|WORCESTER|WORCESTER PARK|WORKINGTON|WORKSOP|WORLDS END|"
        "WORTHING|WOTTON UNDER EDGE|WREXHAM|WROUGHTON|YAPTON|YARM|YATE|YATELEY|YATTON|YAXLEY|YEADON|YEOVIL|YORK|"
        "YSTALYFERA"
    ),
    "GE": "BATUMI|KUTAISI|RUSTAVI|SOKHUMI|TBILISI", "GF": "CAYENNE",
    "GG": "SAINT PETER PORT|SAINT SAMPSON|VALE PARISH",
    "GH": (
        "ACCRA|ADENTA|AFLAO|AKIM ODA|AMANFROM|ASHAIMAN|ATSIAMAN|BAWKU|BEREKUM|BOLGATANGA|BUDUBURAM|CAPE COAST|"
        "EJURA|GBAWE|HOHOE|JAPEKROM|JIRAPA|KASOA|KINTAMPO|KOFORIDUA|KUMASI|MAMPONG|MANDELA|MEDINA ESTATES|NUNGUA|"
        "OBUASE|SEKONDI|SEKONDI TAKORADI|SUHUM|SUNYANI|SWEDRU|TAFO|TAKORADI|TAMALE|TECHIMAN|TEMA|TEMA NEW TOWN|"
        "TESHI OLD TOWN|TWIFU PRASO|WINNEBA|YENDI"
    ),
    "GM": "BRIKAMA|BUNUNKA KUNDA|SEREKUNDA|SUKUTA",
    "GN": (
        "BOKE|CAMAYENNE|CONAKRY|COYAH|DIXINN|DUBREKA|FARANAH|FRIA|GUECKEDOU|KAMSAR|KANKAN|KINDIA|KISSIDOUGOU|"
        "KOLABOUI|LABE|MACENTA|MAMOU|MANEAH|NZEREKORE|SANGAREDI|SIGUIRI"
    ),
    "GP": "LES ABYMES", "GQ": "BATA|MALABO",
    "GR": (
        "ACHARNES|AGIA PARASKEVI|AGIOS DIMITRIOS|AIGALEO|ALEXANDROUPOLI|ATHENS|ATHINA|CHALKIDA|CHANIA|EVOSMOS|"
        "GALATSI|GLYFADA|ILION|ILIOUPOLI|IOANNINA|IRAKLEION|KALAMARIA|KALAMATA|KALLITHEA|KATERINI|KAVALA|"
        "KERATSINI|KHALANDRION|KORYDALLOS|LAMIA|LARISA|MAROUSI|NEA IONIA|NEA SMYRNI|NIKAIA|PALAIO FALIRO|PATRA|"
        "PERISTERI|PETROUPOLIS|PIRAEUS|SERRES|THESSALONIKI|TRIKALA|VOLOS|VYRONAS|ZOGRAFOS"
    ),
    "GT": (
        "AMATITLAN|CHICACAO|CHICHICASTENANGO|CHIMALTENANGO|CHINAUTLA|CHIQUIMULA|COATEPEQUE|COBAN|COMITANCILLO|"
        "ESCUINTLA|FRAIJANES|GUATEMALA|GUATEMALA CITY|HUEHUETENANGO|JALAPA|JUTIAPA|MALACATAN|MAZATENANGO|MIXCO|"
        "OSTUNCALCO|PALIN|PANZOS|PATZUN|PETAPA|PUERTO BARRIOS|QUETZALTENANGO|RETALHULEU|SALAMA|"
        "SAN FRANCISCO EL ALTO|SAN JOSE PINULA|SAN JUAN SACATEPEQUEZ|SAN PEDRO AYAMPUC|SANTA CATARINA PINULA|"
        "SANTA CRUZ DEL QUICHE|SANTA LUCIA COTZUMALGUAPA|TOTONICAPAN|VILLA CANALES|VILLA NUEVA|ZACAPA"
    ),
    "GW": "BAIRRO MILITAR|BISSAU",
    "HK": (
        "FANLING|HONG KONG|HONG KONG ISLAND|KOWLOON|KOWLOON CITY|KOWLOON CITY CENTRE|KOWLOON WEST END|KWAI CHUNG|"
        "LOHAS PARK|MA ON SHAN|MONG KOK|NAM CHEONG|NEW TERRITORIES|POK FU LAM|SAN TUNG CHUNG HANG|SAU MAU PING|"
        "SHA TIN|SHA TIN WAI|SHAM SHUI PO|SHAP PAT HEUNG|SIU LEK YUEN|TAI PO|TIN SHUI WAI|TIU KENG LENG|"
        "TSEUNG KWAN O|TSING YI TOWN|TSUEN WAN|TUEN MUN|TUNG CHUNG|WAN CHAI|WONG TAI SIN|YUEN LONG|"
        "YUEN LONG KAU HUI|YUEN LONG SAN HUI"
    ),
    "HN": (
        "CATACAMAS|CHOLOMA|CIUDAD CHOLUTECA|COMAYAGUA|DANLI|EL NEGRITO|EL PROGRESO|LA CEIBA|OLANCHITO|OMOA|"
        "PUERTO CORTEZ|SAN PEDRO DE COPAN|SAN PEDRO SULA|SANTA CRUZ DE YOJOA|SIGUATEPEQUE|TEGUCIGALPA|TOCOA"
    ),
    "HR": "OSIJEK|PULA|RIJEKA|SESVETE|ZADAR|ZAGREB",
    "HT": (
        "ARCAHAIE|CAP HAITIEN|CARREFOUR|CITE SOLEIL|CROIX DES BOUQUETS|DELMAS|DESSALINES|GONAIVES|JACMEL|JEREMIE|"
        "LEOGANE|LES CAYES|MIRAGOANE|PETIONVILLE|PORT AU PRINCE|PORT DE PAIX|SAINT MARC|SAINT MICHEL DE LATALAYE|"
        "THOMAZEAU|TIGWAV"
    ),
    "HU": (
        "ANGYALFOELD|ANGYALFOLD|BEKESCSABA|BUDA|BUDAPEST|BUDAPEST II KERUELET|BUDAPEST II KERULET|"
        "BUDAPEST III KERUELET|BUDAPEST III KERULET|BUDAPEST IV KERUELET|BUDAPEST IV KERULET|"
        "BUDAPEST VIII KERUELET|BUDAPEST VIII KERULET|BUDAPEST XI KERUELET|BUDAPEST XI KERULET|"
        "BUDAPEST XII KERUELET|BUDAPEST XII KERULET|BUDAPEST XIII KERUELET|BUDAPEST XIII KERULET|"
        "BUDAPEST XIX KERUELET|BUDAPEST XIX KERULET|BUDAPEST XV KERUELET|BUDAPEST XV KERULET|"
        "BUDAPEST XVI KERUELET|BUDAPEST XVI KERULET|BUDAPEST XVII KERUELET|BUDAPEST XVII KERULET|"
        "BUDAPEST XVIII KERUELET|BUDAPEST XVIII KERULET|BUDAPEST XX KERUELET|BUDAPEST XX KERULET|"
        "BUDAPEST XXI KERUELET|BUDAPEST XXI KERULET|BUDAPEST XXII KERUELET|BUDAPEST XXII KERULET|DEBRECEN|"
        "DUNAUJVAROS|EGER|ERZSEBETVAROS|FERENCVAROS|GYOR|JOZSEFVAROS|KAPOSVAR|KECSKEMET|KELENFOELD|KELENFOLD|"
        "KISPEST|KOBANYA|MISKOLC|NYIREGYHAZA|PECS|PEST|PESTLORINC|SOPRON|SZEGED|SZEKESFEHERVAR|SZOLNOK|"
        "SZOMBATHELY|TATABANYA|UJPEST|VESZPREM|ZALAEGERSZEG|ZUGLO"
    ),
    "ID": (
        "ABEPURA|ADIWERNA|AMAHAI|AMBARAWA|AMBON|AMUNTAI|ARJAWINANGUN|ASTANAJAPURA|ATAMBUA|BAEKRAJAN|BAKI|"
        "BALAI PUNGUT|BALIKPAPAN|BANDA ACEH|BANDAR LAMPUNG|BANDUNG|BANGIL|BANGKALAN|BANJAR|BANJARAN|BANJARBARU|"
        "BANJARMASIN|BANTUL|BANYUWANGI|BARABAI|BATAM|BATANG|BATU|BATURAJA|BAUBAU|BEKASI|BELAWAN|BENGKULU|BESUKI|"
        "BIMA|BINJAI|BITUNG|BLITAR|BLORA|BOGOR|BOJONEGORO|BONDOWOSO|BONTANG|BOYOLALI|BUKITTINGGI|CARINGIN|CEPU|"
        "CIAMIS|CIAMPEA|CIANJUR|CIBINONG|CICURUG|CIKAMPEK|CIKARANG|CIKUPA|CILACAP|CILEGON|CILEUNGSIR|CILEUNYI|"
        "CIMAHI|CIPUTAT|CIRANJANG HILIR|CIREBON|CITEUREUP|COMAL|CURUG|DENPASAR|DEPOK|DOBO|DOMPU|DUKUHTURI|DUMAI|"
        "ENDE|GALESONG|GAMPING LOR|GARUT|GEDANGAN|GENTENG|GODEAN|GOMBONG|GORONTALO|GRESIK|GROGOL|GUNUNGSITOLI|"
        "INDRAMAYU|JAKARTA|JAMBI|JAMBI CITY|JATIBARANG|JATIROTO|JATIWANGI|JAYAPURA|JEMBER|JEPARA|JOMBANG|"
        "KABANJAHE|KARANGSEMBUNG|KARAWANG|KARTASURA|KASIHAN|KAWALU|KEBOMAS|KEDIRI|KEDUNGWARU|KEDUNGWUNI|KENDARI|"
        "KEPANJEN|KERTOSONO|KISARAN|KLANGENAN|KLATEN|KLUNGKUNG|KOTA SAMBAS|KOTAMOBAGU|KRESEK|KUDUS|KUNINGAN|"
        "KUPANG|LABUAN BAJO|LAHAT|LAMONGAN|LANGSA|LAWANG|LEMBANG|LHOKSEUMAWE|LOA JANAN|LUBUKLINGGAU|LUMAJANG|"
        "MADIUN|MAGELANG|MAJALENGKA|MAJENE|MAKASSAR|MALANG|MANADO|MANOKWARI|MARGAHAYUKENCANA|MARTAPURA|MATARAM|"
        "MAUMERE|MEDAN|MELATI|MENDAHA|MERAUKE|MERTOYUDAN|MEULABOH|MOJOKERTO|MUNCAR|MUNTILAN|NABIRE|NEGARA|"
        "NGANJUK|NUNUKAN|NUSANTARA|PADALARANG|PADANG|PADANGPANJANG|PADANGSIDEMPUAN|PAGAR ALAM|PALANGKARAYA|"
        "PALEMBANG|PALIMANAN|PALOPO|PALU|PAMANUKAN|PAMEKASAN|PAMULANG|PANDAK|PANDEGLANG|PANGKALANBUUN|"
        "PANGKALPINANG|PARE|PAREPARE|PARIAMAN|PARUNG|PASARKEMIS|PASEH|PASURUAN|PATI|PAYAKUMBUH|PECANGAAN|"
        "PEKALONGAN|PEKANBARU|PELABUHANRATU|PEMALANG|PEMANGKAT|PEMATANGSIANTAR|PERBAUNGAN|PERCUT|PLUMBON|"
        "POLEWALI|PONOROGO|PONTIANAK|PRABUMULIH|PROBOLINGGO|PURBALINGGA|PURWAKARTA|PURWODADI|PURWOKERTO|RAHA|"
        "RANGKASBITUNG|RANTAUPRAPAT|RENGASDENGKLOK|SALATIGA|SAMARINDA|SAMPANG|SAMPIT|SANGKAPURA|SAWANGAN|SELONG|"
        "SEMARANG|SENGKANG|SEPATAN|SERANG|SERPONG|SEWON|SIBOLGA|SIDIKALANG|SIDOARJO|SINGARAJA|SINGKAWANG|"
        "SINGOSARI|SINTANG|SITUBONDO|SLAWI|SLEMAN|SOKARAJA|SOLOK|SOREANG|SORONG|SOUTH TANGERANG|SRAGEN|SUBANG|"
        "SUBULUSSALAM|SUKABUMI|SUKAWATI|SUMBAWA BESAR|SUMBER|SUMEDANG|SUMEDANG UTARA|SUMENEP|SUNGAI PENUH|"
        "SUNGAILIAT|SUNGGAL|SURABAYA|SURAKARTA|TALIWANG|TANGERANG|TANJUNG PANDAN|TANJUNG PINANG|TANJUNG SELOR|"
        "TANJUNGAGUNG|TANJUNGBALAI|TARAKAN|TARUB|TASIKMALAYA|TEBINGTINGGI|TEGAL|TELUKNAGA|TERBANGGI BESAR|"
        "TERNATE|TIMIKA|TOLI TOLI|TUAL|TUBAN|TULANGAN UTARA|TULUNGAGUNG|UBUD|UNGARAN|WAMENA|WATAMPONE|WEDI|"
        "WELERI|WERU|WONOSARI|WONOSOBO|YOGYAKARTA"
    ),
    "IE": (
        "AN MUILEANN GCEARR|AN ROS|ARKLOW|ARTANE|ASHBOURNE|ATHLONE|ATHY|BALALLY|BALBRIGGAN|BALDOYLE|BALLINA|"
        "BALLINASLOE|BALLINCOLLIG|BALLINTEER|BALLYBODEN|BALLYFERMOT|BALLYMUN|BANDON|BEAUMONT|BIRR|BLACKROCK|"
        "BLANCHARDSTOWN|BLESSINGTON|BOOTERSTOWN|BRAY|BUNCRANA|CABINTEELY|CARLOW|CARRICK ON SUIR|CARRICKMACROSS|"
        "CARRIGALINE|CARRIGTWOHILL|CASTLEBAR|CASTLEKNOCK|CASTLETROY|CAVAN|CELBRIDGE|CHAPELIZOD|CHERRY ORCHARD|"
        "CHERRYVILLE|CLANE|CLONDALKIN|CLUAIN MEALA|COBH|CONFEY|CORK|CRUMLIN|DALKEY|DARNDALE|DOLLYMOUNT|DONABATE|"
        "DONAGHMEDE|DONNYBROOK|DONNYCARNEY|DOUGLAS|DROGHEDA|DROICHEAD NUA|DUBLIN|DUN LAOGHAIRE|DUNBOYNE|DUNDALK|"
        "DUNDRUM|DUNGARVAN|EADESTOWN|EDENDERRY|ENNIS|ENNISCORTHY|FERMOY|FINGLAS|FIRHOUSE|FOXROCK|GALWAY|GLANMIRE|"
        "GOREY|GREENHILLS|GREYSTONES|HARTSTOWN|HOWTH|JOBSTOWN|KILCOCK|KILDARE|KILKENNY|KILLARNEY|KILLESTER|"
        "KILQUADE|KINSALE|KINSEALY DRINAN|KNOCKLYON|LAYTOWN|LEIXLIP|LETTERKENNY|LIMERICK|LITTLE BRAY|LONGFORD|"
        "LOUGHREA|LUCAN|LUSK|MALAHIDE|MALLOW|MARINO|MAYNOOTH|MIDLETON|MONAGHAN|MONKSTOWN|MOUNT MERRION|NAAS|"
        "NAVAN|NENAGH|NENAGH BRIDGE|NEW ROSS|NEWCASTLE WEST|NEWTOWN TRIM|OLDBAWN|PALMERSTOWN|PASSAGE WEST|"
        "PORTARLINGTON|PORTLAOISE|PORTMARNOCK|RAHENY|RATHFARNHAM|RATHGAR|RATHMINES|RATOATH|RINGSEND|ROSCOMMON|"
        "ROSCREA|SALLINS|SALLYNOGGIN|SANDYFORD|SANDYMOUNT|SHANKILL|SHANNON|SKERRIES|SLIGO|SOUTH DUBLIN|SWORDS|"
        "TALLAGHT|TEMPLEOGUE|TERENURE|THURLES|TRA MHOR|TRALEE|TRIM|TUAM|TULLAMORE|WALKINSTOWN|WATERFORD|WESTPORT|"
        "WEXFORD|WICKLOW|YOUGHAL"
    ),
    "IL": (
        "ASHDOD|ASHKELON|BAT YAM|BEERSHEBA|BET SHEMESH|BNEI BRAK|EILAT|GIVATAYIM|HADERA|HAIFA|HERZLIYA|"
        "HOD HASHARON|HOLON|JAFFA|JERUSALEM|KFAR SABA|KIRYAT GAT|MODIIN ILIT|MODIIN MAKKABBIM REUT|NAHARIYYA|"
        "NAZARETH|NESS ZIONA|NETANYA|PETAH TIQVA|QIRYAT ATA|RAANANA|RAMAT GAN|RAMLA|REHOVOT|RISHON LETSIYYON|"
        "ROSH HAAYIN|TEL AVIV|UMM EL FAHM|WEST JERUSALEM"
    ),
    "IM": "DOUGLAS|PEEL|RAMSEY",
    "IN": (
        "ABOHAR|ABU ROAD|ACHALPUR|ADILABAD|ADONI|AGARTALA|AGRA|AHILYANAGAR|AHMEDABAD|AIROLI|AIZAWL|AJMER|AKOLA|"
        "AKOT|ALANDUR|ALAPPUZHA|ALIGARH|ALIPUR DUAR|ALLINAGARAM|ALWAR|AMALAPURAM|AMALNER|AMARAVATI|AMBAJOGAI|"
        "AMBALA|AMBALA SADAR|AMBARNATH|AMBATTUR|AMBIKAPUR|AMBUR|AMRAVATI|AMRELI|AMRITSAR|AMROHA|AMUR|ANAIYUR|"
        "ANAKAPALLE|ANAND|ANANTAPUR|ANANTNAG|ANJANGAON|ANJAR|ANKLESHWAR|AONLA|ARAKKONAM|ARAMBAGH|ARARIA|ARCOT|"
        "ARNI|ARRAH|ARSIKERE|ARUPPUKKOTTAI|ARWAL|ASANSOL|ASHOKNAGAR|ASHOKNAGAR KALYANGARH|ASHTA|ATTILI|ATTUR|"
        "AURAIYA|AURANGABAD|AVADI|AVANIYAPURAM|AYODHYA|AZAMGARH|BADA BARABIL|BADAGARA|BADLAPUR|BADVEL|BAGAHA|"
        "BAGALKOT|BAGBERA|BAHADURGARH|BAHARAMPUR|BAHERI|BAHRAIGH|BAIDYABATI|BALAGHAT|BALANGIR|BALASORE|BALLARI|"
        "BALLARPUR|BALOTRA|BALRAMPUR|BALURGHAT|BANDA|BANGAON|BANGARDA CHHOTA|BANKRA|BANKURA|BANSBARIA|BANSWARA|"
        "BAPATLA|BAPROLA|BARAKPUR|BARAMATI|BARAMULA|BARAN|BARANAGAR|BARASAT|BARAUNI|BARAUT|BARBIL|BARDDHAMAN|"
        "BARDOLI|BAREILLY|BARGARH|BARH|BARI|BARIPADA|BARMER|BARNALA|BARSHI|BARUIPUR|BARUNI|BARWANI|BASAVAKALYAN|"
        "BASIRHAT CITY|BASMAT|BASODA|BASTI|BATALA|BATHINDA|BAWANA|BEAWAR|BEED|BEGAMPUR|BEGUSARAI|BELA|BELAGAVI|"
        "BELLAMPALLI|BENGALURU|BENIPUR|BETTIAH|BETUL|BEYPORE|BHABHUA|BHADOHI|BHADRACHALAM|BHADRAK|BHADRAVATI|"
        "BHADRESWAR|BHAGALPUR|BHALSWA JAHANGIRPUR|BHANDARA|BHARATPUR|BHARUCH|BHATAPARA|BHATPARA|BHAVNAGAR|"
        "BHAWANIPATNA|BHAYANDAR|BHETIA|BHILAI|BHILAI CHARODA|BHILWARA|BHIMAVARAM|BHIMUNIPATNAM|BHIND|BHIWADI|"
        "BHIWANDI|BHIWANI|BHONGIR|BHOPAL|BHUBANESWAR|BHUJ|BHUSAWAL|BIDAR|BIHAR SHARIF|BIHAT|BIJNOR|BIKANER|"
        "BILASPUR|BILIMORA|BINA|BIRGAON|BISALPUR|BISHNUPUR|BISWAN|BOBBILI|BODHAN|BODINAYAKKANUR|BOKARO|BOLPUR|"
        "BONGAIGAON|BORIVLI|BORSAD|BOTAD|BRAHMAPUR|BRAJARAJNAGAR|BUDAUN|BUDGE BUDGE|BULANDSHAHR|BULDANA|BUNDI|"
        "BURARI|BURHANPUR|BUXAR|BYASANAGAR|CHAIBASA|CHAKRADHARPUR|CHALISGAON|CHALLAKERE|CHAMRAJNAGAR|CHANDA|"
        "CHANDANNAGAR|CHANDIGARH|CHANDPUR|CHANDUASI|CHANGANACHERI|CHANNAPATNA|CHAPRA|CHARKHI DADRI|CHAS|CHAUMU|"
        "CHENGALPATTU|CHENNAI|CHERUVANNUR|CHHATARPUR|CHHIBRAMAU|CHHINDWARA|CHIDAMBARAM|CHIK BALLAPUR|CHIKHLI|"
        "CHIKMAGALUR|CHILAKALURUPET|CHILLA SORODA BANGAR|CHINNACHOWK|CHINTAMANI|CHIPLUN|CHIRALA|CHIRMIRI|"
        "CHITRADURGA|CHITTOOR|CHITTORGARH|CHOPDA|CHOUDWAR|CHURU|CLOSEPET|COIMBATORE|CONTAI|CUDDALORE|CUMBUM|"
        "CUTTACK|DABHEL|DABHOI|DABRA|DABWALI|DADRI|DAHANU|DALUPURA|DAM DAM|DAMOH|DANDELI|DARBHANGA|DARJILING|"
        "DATIA|DAUDNAGAR|DAUSA|DAVANGERE|DEESA|DEGLUR|DEHRADUN|DELHI|DELHI CANTONMENT|DEOBAND|DEOGHAR|DEOLALI|"
        "DEOLI|DEORIA|DEVAKOTTAI|DEWAS|DHAMTARI|DHANBAD|DHAR|DHARAPURAM|DHARASHIV|DHARAVI|DHARMAPURI|DHARMAVARAM|"
        "DHAULPUR|DHENKANAL|DHOLKA|DHONE|DHORAJI|DHRANGADHRA|DHUBRI|DHULE|DHULIAN|DHURI|DIBRUGARH|DIDWANA|"
        "DIMAPUR|DINAPORE|DINAPUR NIZAMAT|DINDIGUL|DIPHU|DODDABALLAPURA|DOHAD|DOMBIVALI|DUMRAON|DURG|DURGAPUR|"
        "EDATTALA|ELECTRONIC CITY PHASE I|ELURU|EMMIGANUR|ERODE|ETAH|ETAWA|ETAWAH|FARIDABAD|FARIDKOT|FARIDPUR|"
        "FARRUKHABAD|FATEHABAD|FATEHPUR|FATWA|FAZILKA|FIROZABAD|FIROZPUR|FORBESGANJ|FYZABAD|GADAG|GADAG BETAGERI|"
        "GADDI ANNARAM|GADWAL|GAJRAULA|GAJUWAKA|GANDHIDHAM|GANDHINAGAR|GANGAPUR|GANGARAMPUR|GANGAVATI|GANGOH|"
        "GANGTOK|GARHCHIROLI|GAURIGANJ|GAYA|GHARROLI|GHATAL|GHAZIABAD|GHAZIPUR|GIRIDIH|GOALPARA|"
        "GOBICHETTIPALAYAM|GOBINDGARH|GODHRA|GOHAD|GOHANA|GOKAK|GOKALPUR|GOLA GOKARANNATH|GONDA CITY|GONDAL|"
        "GONDIA|GOPALGANJ|GORAKHPUR|GOYERKATA|GREATER NOIDA|GUDIVADA|GUDIYATHAM|GUDUR|GUMLA|GUNA|GUNDUPALAIYAM|"
        "GUNTAKAL|GUNTUR|GURDASPUR|GURUGRAM|GUWAHATI|GWALIOR|GYANPUR|HABRA|HAJIPUR|HALDIA|HALDWANI|HALISAHAR|"
        "HALOL|HANSI|HANUMANGARH|HAPUR|HARDA|HARDOI|HARIDWAR|HARIHAR|HASANPUR|HASHTSAL|HATHRAS|HAVERI|HAZARIBAGH|"
        "HILSA|HIMATNAGAR|HINDAUN|HINDUPUR|HINGANGHAT|HINGOLI|HIRIYUR|HISAR|HODAL|HOSAPETE|HOSHIARPUR|HOSKOTE|"
        "HOSUR|HOWRAH|HUBBALLI|HUGLI|HUNSUR|HYDERABAD|ICHALKARANJI|IDAIYARPALAIYAM|IDAPPADI|ILKAL|IMPHAL|INDORE|"
        "ISLAMPUR|ITANAGAR|ITARSI|JABALPUR|JAFARABAD|JAGADHRI|JAGDALPUR|JAGGAIAHPET|JAGRAON|JAGTIAL|JAHANABAD|"
        "JAHANGIRABAD|JAIGAON|JAIPUR|JAISALMER|JAITPUR|JAJMAU|JALANDHAR|JALAUN|JALGAON|JALNA|JALOR|JALPAIGURI|"
        "JAMALPUR|JAMKHANDI|JAMMU|JAMNAGAR|JAMSHEDPUR|JAMUI|JAMURIA|JANGAON|JANGIPUR|JAORA|JATANI|JAUNPUR|JETPUR|"
        "JEYPORE|JHALAWAR|JHANSI|JHARGRAM|JHARIA|JHARSUGUDA|JHUMRI TELAIYA|JHUNJHUNUN|JIND|JODHPUR|JORHAT|"
        "JUNAGADH|KADAPA|KADAYANALLUR|KADI|KADIRI|KAGAZNAGAR|KAIRANA|KAITHAL|KAKINADA|KALABURAGI|KALAMASSERY|"
        "KALIYAGANJ|KALLAKURICHI|KALNA|KALOL|KALYAN|KALYANI|KAMAREDDI|KAMARHATI|KAMTHI|KANAKAPURA|KANAYANNUR|"
        "KANCHIPURAM|KANCHRAPARA|KANDI|KANDUKUR|KANHANGAD|KANNAUJ|KANNUR|KANPUR|KANPUR CANTONMENT|KAPAS HERD|"
        "KAPURTHALA TOWN|KARAD|KARAIKAL|KARAIKKUDI|KARANJA|KARAULI|KARAWALNAGAR|KARIMGANJ|KARIMNAGAR|KARNAL|"
        "KAROL BAGH|KARUR|KARWAR|KASARAGOD|KASGANJ|KASHIPUR|KASIBUGGA|KASIPALAIYAM|KATHUA|KATIHAR|KATOYA|KATRAS|"
        "KAVALI|KAVANUR|KAYAMKULAM|KEONJHARGARH|KESHOD|KHADKI|KHAGAUL|KHAJOORI KHAS|KHAMBHAT|KHAMGAON|KHAMMAM|"
        "KHANAPURAM HAVELI|KHANDWA|KHANNA|KHARAGPUR|KHARAKVASLA|KHARAR|KHARDAH|KHARGHAR|KHARGONE|KHATAULI|"
        "KHOPOLI|KHURAI|KHURJA|KIRARI SULEMANNAGAR|KIRATPUR|KISHANGANJ|KISHANGARH|KOCH BIHAR|KOCHI|KODAR|"
        "KODUNGALLUR|KOHIMA|KOLAR|KOLHAPUR|KOLKATA|KOLLAM|KOLLEGAL|KONCH|KONNAGAR|KOPARGAON|KOPPAL|KORATLA|KORBA|"
        "KOSI|KOT KAPURA|KOTA|KOTHARIA|KOTKAPURA|KOTTAGUDEM|KOTTAYAM|KOVILPATTI|KOYILANDY|KOZHIKODE|KRISHNAGIRI|"
        "KRISHNANAGAR|KUCHAMAN|KUKATPALLY|KULTI|KUMARAPALAYAM|KUMBAKONAM|KUNDLA|KUNIYAMUTTUR|KUNNAMKULAM|"
        "KURICHCHI|KURNOOL|KUSHINAGAR|LADNUN|LAHARPUR|LAKHIMPUR|LAL BAHADUR NAGAR|LALITPUR|LATUR|LAXMANGARH|"
        "LOHARDAGA|LONAVLA|LONI|LUCKEESARAI|LUCKNOW|LUDHIANA|LUNGLEI|MACHERLA|MACHILIPATNAM|MADANAPALLE|MADGAON|"
        "MADHAVARAM|MADHEPURA|MADHUBANI|MADHUPUR|MADHURAMPUR DEHRI|MADHYAMGRAM|MADURAI|MADURAVOYAL|MAHASAMUND|"
        "MAHBUBNAGAR|MAHESANA|MAHESHTALA|MAHOBA|MAHUVA|MAINPURI|MAKRANA|MALAPPURAM|MALDA|MALEGAON|MALER KOTLA|"
        "MALKAJGIRI|MALKAPUR|MALOUT|MANCHERIAL|MANDAMARRI|MANDAPETA|MANDI DABWALI|MANDIDEEP|MANDLA|MANDOLI|"
        "MANDSAUR|MANDVI|MANDYA|MANGALAGIRI|MANGALURU|MANGROL|MANJERI|MANMAD|MANNARAKKAT|MANNARGUDI|MANSA|"
        "MARAIMALAINAGAR|MARKAPUR|MASAURHI BUZURG|MATHURA|MAWANA|MAWLAI MAWIONG|MAYILADUTHURAI|MEDININAGAR|"
        "MEDINIPUR|MEERUT|METPALLE|METTUPALAYAM|METTUR|MHOW|MIRYALAGUDA|MIRZAPUR|MITHEPUR|MODASA|MODINAGAR|MOGA|"
        "MOHALI|MOKAMEH|MOLARBAND|MOONNIYUR|MORADABAD|MORENA|MORMUGAO|MORVI|MOTHIHARI|MUBARAKPUR|MUDHOL|"
        "MUKANDPUR|MUKTSAR|MULBAGAL|MULUGU|MUMBAI|MUNDKA|MUNGER|MUNNAR|MURADNAGAR|MURWARA|MUSTAFABAD|"
        "MUZAFFARNAGAR|MUZAFFARPUR|MYSURU|NABHA|NADIAD|NAGAON|NAGAPATTINAM|NAGARI|NAGAUR|NAGDA|NAGERCOIL|NAGINA|"
        "NAGPUR|NAIHATI|NAJAFGARH|NAJIBABAD|NAKSALBARI|NALGONDA|NALLUR|NAMAKKAL|NANDED|NANDURBAR|NANDYAL|"
        "NANGLOI JAT|NANI DAMAN|NANJANGUD|NARASAPUR|NARASARAOPET|NARELA|NARMADAPURAM|NARNAUL|NARSIMHAPUR|NARWANA|"
        "NASHIK|NASIRABAD|NAVADWIP|NAVI MUMBAI|NAVSARI|NAWABGANJ|NAWADA|NAWALGARH|NAYA GAON|NEDUMANGAD|"
        "NEELANKARAI|NELLORE|NERKUNRAM|NERUPPERICHCHAL|NEW DELHI|NEYVELI|NEYYATTINKARA|NIMACH|NIMBAHERA|NIPANI|"
        "NIRMAL|NITHARI|NIZAMABAD|NOIDA|NOKHA|NORTH LAKHIMPUR|NOWRANGAPUR|NUZVID|OBRA|OKHA|ONGOLE|OOTY|ORAI|"
        "OTTAPALAM|OZAR|PACHORA|PALAKKAD|PALAKOLLU|PALANI|PALANPUR|PALASA|PALGHAR|PALI|PALITANA|PALLAVARAM|"
        "PALLICHAL|PALMANER|PALONCHA|PALWAL|PALWANCHA|PAMMAL|PANCHKULA|PANDHARPUR|"
        "PANDIT DEEN DAYAL UPADHYAYA NAGAR|PANIHATI|PANIPAT|PANIPAT TARAF MAKHDUM ZADGAN|PANJIM|PANNA|PANRUTI|"
        "PANVEL|PARADIP GARH|PARALAKHEMUNDI|PARAMAGUDI|PARBHANI|PARLI VAIJNATH|PARVATIPURAM|PATAN|PATHANKOT|"
        "PATIALA|PATNA|PATTUKKOTTAI|PAYYANUR|PERANAMPATTU|PERIYA SEMUR|PETLAD|PHAGWARA|PHALTAN|PHULWARI SHARIF|"
        "PHUSRO|PIDUGURALLA|PILIBHIT|PILKHUA|PIMPRI|PIMPRI CHINCHWAD|PITHAMPUR|PITHAPURAM|POLLACHI|PONNANI|"
        "PONNUR|PONNURU|POONAMALLE|PORBANDAR|PORT BLAIR|PRAYAGRAJ|PRODDATUR|PUDUCHERRY|PUDUKKOTTAI|PUL PEHLAD|"
        "PULIVENDLA|PULIYANKUDI|PUNASA|PUNE|PUNGANURU|PURI|PURNIA|PURULIYA|PUSAD|PUTH KALAN|PUTTUR|QUTHBULLAPUR|"
        "RABKAVI|RABKAVI BANHATTI|RAEBARELI|RAGHOGARH|RAICHUR|RAIGANJ|RAIGARH|RAIPUR|RAJ NANDGAON|"
        "RAJAMAHENDRAVARAM|RAJAPALAYAM|RAJGANGPUR|RAJGARH|RAJKOT|RAJPUR SONARPUR|RAJPURA|RAJSAMAND|RAMAGUNDAM|"
        "RAMANATHAPURAM|RAMAPURAM|RAMGARH|RAMGUNDAM|RAMNAGAR|RAMPUR|RAMPUR HAT|RAMPURA PHUL|RANAGHAT|RANCHI|"
        "RANEBENNUR|RANIGANJ|RANIPET|RASAPUDIPALEM|RASIPURAM|RATANGARH|RATH|RATLAM|RATNAGIRI|"
        "RAURKELA INDUSTRIAL TOWNSHIP|RAXAUL|RAYACHOTI|RAYADRUG|RAYAGADA|RAZAMPETA|RENUKUT|REPALLE|REWA|REWARI|"
        "RISHIKESH|RISHRA|ROBERTSONPET|ROHA|ROHINI|ROHTAK|ROORKEE|ROPAR|ROSHANPURA|ROURKELA|RUDRAPUR|"
        "SADATPUR GUJRAN|SAGAR|SAHARANPUR|SAHARSA|SAHASWAN|SAHIBABAD DAULOTPUR|SAHIBGANJ|SALEM|SALUR|SAMALKOT|"
        "SAMANA|SAMASTIPUR|SAMBALPUR|SAMBHAL|SANAND|SANDILA|SANGAMNER|SANGAREDDI|SANGLI|SANGRUR|SANKARANKOVIL|"
        "SARDARSHAHR|SARNI|SASARAM|SATARA|SATNA|SATTENAPALLE|SAUGOR|SAUNDA|SAVARKUNDLA|SAWAI MADHOPUR|"
        "SECUNDERABAD|SEHORE|SENDHWA|SEONI|SERILINGAMPALLE|SHAHABAD|SHAHADA|SHAHDOL|SHAHJANPUR|SHAHPUR|SHAHUWADI|"
        "SHAJAPUR|SHAMLI|SHANTIPUR|SHEGAON|SHEIKHPURA|SHELLA|SHEOPUR|SHERKOT|SHIKOHABAD|SHILLONG|SHIMLA|SHIRPUR|"
        "SHIVAJI NAGAR|SHIVAMOGGA|SHIVPURI|SHOLAPUR|SHORAPUR|SHRIRAMPUR|SHUJALPUR|SHYAMNAGAR|SIBSAGAR|SIDDHAPUR|"
        "SIDDIPET|SIDHI|SIDLAGHATTA|SIHOR|SIKANDARABAD|SIKAR|SILCHAR|SILIGURI|SILLOD|SILVASSA|SINDHNUR|SINGRAULI|"
        "SINNAR|SIRA|SIRHIND|SIRONJ|SIRSA|SIRSI|SIRSILLA|SIRUGUPPA|SITAMARHI|SITAPUR|SIURI|SIVAKASI|SIWAN|"
        "SONIPAT|SOPUR|SOYIBUG|SRI DUNGARGARH|SRI GANGANAGAR|SRIKAKULAM|SRIKALAHASTI|SRINAGAR|SRIVILLIPUTHUR|"
        "SUJANGARH|SULTAN PUR MAJRA|SULTANGANJ|SULTANPUR|SUNABEDA|SUNAM|SUPAUL|SURAT|SURATGARH|SURENDRANAGAR|"
        "SURIAPET|TADEPALLE|TADEPALLIGUDEM|TADPATRI|TAJ PUL|TALEGAON DABHADE|TALIPARAMBA|TAMBARAM|TANDA|TANDONI|"
        "TANDUR|TANUKU|TARN TARAN|TEGHRA|TELLICHERRY|TENI|TENNALA|TEZPUR|THANE|THANESAR|THANJAVUR|THENALI|"
        "THENKASI|THIRUVANANTHAPURAM|THIRUVARUR|THODUPUZHA|THOOTHUKUDI|THRISSUR|TIKAMGARH|TILHAR|TINDIVANAM|"
        "TINSUKIA|TIPTUR|TIRUCHENGODE|TIRUCHIRAPPALLI|TIRUMANGALAM|TIRUNELVELI|TIRUPATI|TIRUPATTUR|"
        "TIRUPPARANGUNRAM|TIRUPPUR|TIRUR|TIRURANGADI|TIRUTTANGAL|TIRUVALLA|TIRUVALLUR|TIRUVANNAMALAI|"
        "TIRUVOTTIYUR|TITAGARH|TOHANA|TONK|TRIPUNITTURA|TUMKUR|TUNDLA|TUNI|TURA|UDAIPUR|UDGIR|UDHAMPUR|"
        "UDUMALAIPPETTAI|UDUPI|UJHANI|UJJAIN|ULHASNAGAR|ULLAGARAM|ULLAL|ULUBERIYA|UMRED|UNJHA|UNNAO|UPLETA|"
        "UPPAL KALAN|URUN ISLAMPUR|VADODARA|VALPARAI|VALSAD|VANIYAMBADI|VAPI|VARANASI|VASCO DA GAMA|VAZHAKKALA|"
        "VEJALPUR|VELAMPALAIYAM|VELLORE|VENKATAGIRI|VERAVAL|VIDISHA|VIJALPOR|VIJAYAPURA|VIJAYAWADA|VIKARABAD|"
        "VILLUPURAM|VINUKONDA|VIRAMGAM|VIRAPANDI|VIRAPPANCHATHIRAM|VIRAR|VIRARAGHAVAPURAM|VIRUDHACHALAM|"
        "VIRUDUNAGAR|VISAKHAPATNAM|VISNAGAR|VIZIANAGARAM|VRIDDHACHALAM|VRINDAVAN|WADGAON KOLHATI|WANI|WANPARTI|"
        "WARANGAL|WARDHA|WARI|WASHIM|WOKHA|YADGIR|YAMUNA NAGAR|YANAM|YAVATMAL|YELAHANKA|ZAHIRABAD|ZERAKPUR|"
        "ZIAUDDIN PUR"
    ),
    "IQ": (
        "ABU AL KAHSIB|ABU GHARAQ|ABU GHURAYB|AKRA|AL AMARAH|AL DIWANIYAH|AL FALLUJAH|AL FAW|AL HAMDANIYA|"
        "AL HARITHAH|AL HAYY|AL HILLAH|AL HINDIYAH|AL KUT|AL MADINAH|AL MAHMUDIYAH|AL MAWSIL AL JADIDAH|"
        "AL MIQDADIYAH|AL MUSAYAB|AL QAIM|AL QASIM|AL QURNAH|AN NUMANIYAH|AS SAMAWAH|AS SUWAYRAH|ASH SHAMIYAH|"
        "ASH SHARQAT|ASH SHATRAH|AZ ZUBAYR|BAGHDAD|BAHARKAH|BAQUBAH|BASRAH|BAYJI|DERBENDIXAN|DIHOK|ERBIL|HAJIAWA|"
        "HALABJA|KARBALA|KELAR|KHALIS|KHANAQIN|KHASNAHZAN|KIRKUK|KUFA|MOSUL|NAHIYAT AL ISKANDARIYAH|NAJAF|"
        "NASIRIYAH|QALAT SUKKAR|QE ADIZE|QELADIZE|RAMADI|RANYAH|SADR|SADR CITY|SAMARRA|SHELADIZ|SIMELE|SINAH|"
        "SORAN|SULAYMANIYAH|SUMAYL|TUZ KHURMATU|UMM QASR|XEBAT|ZAXO"
    ),
    "IR": (
        "ABADAN|ABADEH|ABHAR|ABYEK|AHAR|AHVAZ|ALI ABAD E KATUL|ALIGUDARZ|ALVAND|AMOL|ANDIMESHK|ANDISHEH|ARAK|"
        "ARAN BIDGOL|ARDABIL|ARDAKAN|ASADABAD|BABOL|BAGHESTAN|BAHARESTAN|BANDAR ABBAS|BANDAR E ANZALI|"
        "BANDAR E EMAM KHOMEYNI|BANDAR E GENAVEH|BANDAR E KANGAN|BANDAR E MAHSHAHR|BANDAR E TORKAMAN|BANEH|"
        "BAQERSHAHR|BEHBAHAN|BEHSHAHR|BIJAR|BIRJAND|BOJNURD|BONAB|BORAZJAN|BORUJEN|BORUJERD|BUKAN|BUMAHEN|"
        "BUSHEHR|CHALUS|CHENARAN|DAMGHAN|DARAB|DEHDASHT|DEZFUL|DOGONBADAN|DORUD|EQBALIYEH|ESFARAYEN|"
        "ESLAMABAD E GHARB|ESLAMSHAHR|FARDIS|FASA|FIRUZABAD|FULAD SHAHR|GOLESTAN|GOLPAYEGAN|GONBAD E KAVUS|"
        "GORGAN|HAMADAN|HARSIN|HASHTGERD|ILAM|IRANSHAHR|ISFAHAN|IZEH|JAHROM|JAVANRUD|JIROFT|KAHNUJ|KAMALSHAHR|"
        "KAMYARAN|KANGAVAR|KARAJ|KASHAN|KASHMAR|KAZERUN|KERMAN|KERMANSHAH|KHALKHAL|KHASH|KHOMEYN|KHOMEYNI SHAHR|"
        "KHORRAMABAD|KHORRAMDARREH|KHORRAMSHAHR|KHUY|KUHDASHT|KUT E ABDOLLAH|LAHIJAN|LANGARUD|MAHABAD|MAHDASHT|"
        "MALARD|MALAYER|MARAGHEH|MARAND|MARIVAN|MARVDASHT|MASHHAD|MASJED SOLEYMAN|MEHESTAN|MESHGIN SHAHR|"
        "MESHKIN DASHT|MEYBOD|MIANDOAB|MIANEH|MINAB|MOBARAKEH|MOHAMMAD SHAHR|MOHAMMADIYEH|NAHAVAND|NAJAFABAD|"
        "NAQADEH|NASIM SHAHR|NASIMSHAHR|NAZARABAD|NEKA|NEYSHABUR|NURABAD|OMIDIYEH|ORUMIYEH|OSHNAVIYEH|PAKDASHT|"
        "PARAND|PARDIS|PARSABAD|PIRANSHAHR|PISHVA|QAEM SHAHR|QARCHAK|QAZVIN|QODS|QORVEH|QUCHAN|RAFSANJAN|"
        "RAMHORMOZ|RASHT|ROBAT KARIM|SABBASHAHR|SABZEVAR|SAHAND|SALEHIEH|SALMAS|SANANDAJ|SAQQEZ|SARAVAN|SARI|"
        "SAVEH|SEMNAN|SHAHIN SHAHR|SHAHR E BABAK|SHAHR E KORD|SHAHR E SADRA|SHAHRAK E PARDISAN|"
        "SHAHRE JADIDE ANDISHEH|SHAHREZA|SHAHRIAR|SHAHRUD|SHIRAZ|SHIRVAN|SHUSH|SHUSHTAR|SIRJAN|SUSANGERD|TABRIZ|"
        "TAJRISH|TAKAB|TAKESTAN|TEHRAN|TORBAT E HEYDARIYEH|TORBAT E JAM|TUYSERKAN|VARAMIN|YASUJ|YAZD|ZABOL|"
        "ZAHEDAN|ZANJAN|ZARAND|ZARRIN SHAHR"
    ),
    "IS": "REYKJAVIK",
    "IT": (
        "ACERRA|ACILIA CASTEL FUSANO OSTIA ANTICA|AFRAGOLA|ALESSANDRIA|ALTAMURA|ANCONA|ANDRIA|APRILIA|ARENELLA|"
        "AREZZO|ASTI|AVERSA|BAGHERIA|BARI|BARLETTA|BARRIERA DI LANZO|BARRIERA DI MILANO|BENEVENTO|BERGAMO|"
        "BISCEGLIE|BITONTO|BOLOGNA|BOLZANO|BRESCIA|BRINDISI|BUSTO ARSIZIO|CAGLIARI|CALTANISSETTA|CAMPO DI MARTE|"
        "CARPI|CARRARA|CASERTA|CASORIA|CASTELLAMMARE DI STABIA|CATANIA|CATANZARO|CAVA DE TIRRENI|CERIGNOLA|"
        "CESENA|CINISELLO BALSAMO|CIRCOISCRIZIONE I|CIRCOISCRIZIONE II|CIRCOISCRIZIONE III|CIRCOISCRIZIONE IV|"
        "CIRCOISCRIZIONE V|CIRCOISCRIZIONE VI|CIRCOISCRIZIONE VII|CIRCOISCRIZIONE VIII|COMO|COSENZA|CREMONA|"
        "CROTONE|CUNEO|ERCOLANO|FANO|FERRARA|FIRENZE|FIUMICINO|FLORENCE|FOGGIA|FOLIGNO|FORLI|FUORIGROTTA|"
        "GALLARATE|GELA|GENOA|GENOVA|GIUGLIANO IN CAMPANIA|GROSSETO|GUIDONIA MONTECELIO|IMOLA|LA SPEZIA|"
        "LAMEZIA TERME|LATINA|LECCE|LEGNANO|LIDO DI OSTIA|LIVORNO|LUCCA|MANFREDONIA|MARSALA|MASSA|MATERA|"
        "MAZARA DEL VALLO|MESSINA|MESTRE|MILAN|MILANO|MODENA|MODICA|MOLFETTA|MONCALIERI|MONTESILVANO|MONZA|"
        "NAPLES|NAPOLI|NOVARA|OLBIA|PADUA|PALERMO|PARMA|PAVIA|PERUGIA|PESARO|PESCARA|PIACENZA|PIANURA|PISA|"
        "PISTOIA|PONTICELLI|PORTICI|POTENZA|POZZO STRADA|POZZUOLI|PRATO|QUARTO OGGIARO|QUARTU SANTELENA|RAGUSA|"
        "RAVENNA|REGGIO CALABRIA|REGGIO NELLEMILIA|RIMINI|ROMA|ROME|ROVIGO|SALERNO|SAN CARLO ALLARENA|SAN SEVERO|"
        "SASSARI|SAVONA|SECONDIGLIANO|SESTO SAN GIOVANNI|SIENA|SIRACUSA|TARANTO|TERAMO|TERNI|TORINO|"
        "TORRE DEL GRECO|TRANI|TRAPANI|TRENTO|TREVISO|TRIESTE|TURIN|UDINE|VARESE|VELLETRI|VENEZIA|VERONA|"
        "VIAREGGIO|VICENZA|VIGEVANO|VITTORIA"
    ),
    "JE": "SAINT HELIER|ST LAWRENCE", "JM": "MONTEGO BAY|NEW KINGSTON|PORTMORE|SPANISH TOWN",
    "JO": (
        "AJLUN|AMMAN|AQABA|AR RAMTHA|AS SALT|AZ ZULAYL|HAYY KHILDA|IRBID|KHURAYBAT AS SUQ|MAAN|MADABA|MAFRAQ|"
        "MARJ AL HAMAM|RUKBAN|RUSSEIFA|SUWAYLIH|WADI AS SIR|ZARQA"
    ),
    "JP": (
        "ABIKO|ADACHI|AGEO|AIHARA|AIRA|AISAI|AIZU WAKAMATSU|AKASHI|AKIHABARA|AKIRUNO|AKISHIMA|AKITA|AMAGASAKI|"
        "AMAKUSA|ANAN|ANJO|ANNAKA|AOMORI|ARAKAWA|ARAO|ARASHIYAMA|ASAHI|ASAHIKAWA|ASAKA|ASAKURA|ASAKUSA|ASHIKAGA|"
        "ASHIYA|ATSUGI|AYASE|AZUMINO|BANDO|BEPPU|BUNKYO|CHIBA|CHICHIBU|CHIGASAKI|CHIKUMA|CHIKUSEI|CHIKUSHINO SHI|"
        "CHINO|CHIRYU|CHITA|CHITOSE|CHIYODA|CHOFU|CHOSHI|CHUO|DAISEN|DAITO|DAZAIFU|EBETSU|EBINA|ECHIZEN|EDOGAWE|"
        "ENIWA|FUCHU|FUCHUCHO|FUEFUKI|FUJI|FUJIEDA|FUJIIDERA|FUJIMINO|FUJINOMIYA|FUJIOKA|FUJISAWA|FUKAYACHO|"
        "FUKUCHIYAMA|FUKUI SHI|FUKUOKA|FUKUROI|FUKUSHIMA|FUKUTSU|FUKUYAMA|FURUKAWA|FUSSA|FUTTSU|GAMAGORI|GIFU|"
        "GINOWAN|GION|GOSHOGAWARA|GOTEMBA|GUSHIKAWA|GYODA|HABIKINO|HACHINOHE|HACHIOJI|HADANO|HAKODATE|HAMADA|"
        "HAMAKITA|HAMAMATSU|HAMURA|HANAMAKI|HANDA|HANNAN|HANNO|HANYU|HASHIMA|HASHIMOTO|HASUDA|HATOGAYA HONCHO|"
        "HATSUKAICHI|HEKINAN|HIDAKA|HIGASHI MATSUYAMA|HIGASHIHIROSHIMA|HIGASHIKURUME|HIGASHIMURAYAMA|"
        "HIGASHIOSAKA|HIGASHIYAMATO|HIKARI|HIKONE|HIMEJI|HIMIMACHI|HINO|HIRAKATA|HIRATSUKA|HIROSAKI|HIROSHIMA|"
        "HITA|HITACHI|HITACHI NAKA|HOFU|HONCHO|HONJO|HONMACHI|HYUGA|IBARAKI|ICHIHARA|ICHIKAWA|ICHINOMIYA|"
        "ICHINOSEKI|IIDA|IIZUKA|IKEDA|IKOMA|IMABARI|IMAICHI|IMARICHO KO|IMIZU|INADA|INAGI|INAZAWA|INUYAMA|INZAI|"
        "IRUMA|ISAHAYA|ISEHARA|ISESAKI|ISHIKARI|ISHINOMAKI|ISHIOKA|ITABASHI|ITAMI|ITOMAN|ITOSHIMA|IWADE|IWAKI|"
        "IWAKUNI|IWAMIZAWA|IWATA|IWATSUKI|IZUMI|IZUMIOTSU|IZUMISANO|IZUMO|JOETSU|JOSO|JOYO|KADOMA|KAGA|KAGOSHIMA|"
        "KAIZUKA|KAKAMIGAHARA|KAKEGAWA|KAKOGAWACHO HONMACHI|KAMAGAYA|KAMAKURA|KAMEOKA|KAMIFUKUOKA|KAMIGYO KU|"
        "KAMIRENJAKU|KAMISU|KANAZAWA|KANI|KANONJICHO|KANOYA|KANUMA|KARATSU|KARIYA|KASAMA|KASAOKA|KASHIBA|"
        "KASHIHARA|KASHIHARA SHI|KASHIMA SHI|KASHIWA|KASHIWARA|KASHIWAZAKI|KASUGA|KASUGAI|KASUKABE|KATANAWA|"
        "KATANO|KATORI SHI|KATSUSHIKA|KATSUTA|KAWACHI NAGANO|KAWAGOE|KAWAGUCHI|KAWANISHI|KAWASAKI|KAZO|KESENNUMA|"
        "KIMITSU|KINOKAWA|KIRISHIMA|KIRYU|KISARAZU|KISHIWADA|KITA|KITAHIROSHIMA|KITAKAMI|KITAKYUSHU|KITAMI|"
        "KITAMOTO|KITANAGOYA|KIYOSE|KIYOSU|KIZUGAWA|KOBE|KOCHI|KODAIRA|KOFU|KOGA|KOGANEI|KOKA|KOKUBU MATSUKI|"
        "KOKUBUNJI|KOMAE|KOMAKI|KOMATSU|KONAN|KONOSU|KORIYAMA|KOSAI|KOSHI|KOSHIGAYA|KOTARI|KOTO|KUDAMATSU|"
        "KUKICHUO|KUMAGAYA|KUMAMOTO|KUNITACHI|KURASHIKI|KURE|KURIHAMA|KURIHARA|KUROISO|KURUME|KUSATSU|KUSHIRO|"
        "KUWANA|KYOTANABE|KYOTANGO|KYOTO|MACHIDA|MAEBARU CHUO|MAEBASHI|MAIZURU|MARUGAME|MATSUBARA|MATSUDO|MATSUE|"
        "MATSUMOTO|MATSUSAKA|MATSUTO|MATSUYAMA|MEGURO|MIDORI|MIHARA|MIKI|MINAMI ALPS|MINAMI SOMA|MINAMIARUPUSU|"
        "MINAMIRINKAN|MINAMIUONUMA|MINATO|MINATO CITY|MINOH|MINOKAMO|MISATO SAITAMA|MISHIMA|MITO|MITOYO|MIURA|"
        "MIYAKO|MIYAKOJIMA|MIYAKONOJO|MIYAZAKI|MIYOSHI|MIZUHO|MIZUSAWA|MOBARA|MOOKA|MORIGUCHI|MORIOKA|MORIYA|"
        "MORIYAMA|MUKO|MUNAKATA|MURAKAMI|MURORAN|MUSASHIMURAYAMA|MUSASHINO|MUTSU|NABARI|NAGAHAMA|NAGAKUTE|NAGANO|"
        "NAGAOKA|NAGAREYAMA|NAGASAKI|NAGO|NAGOYA|NAHA|NAKA|NAKANO|NAKATSU|NAKATSUGAWA|NANAO|NARA SHI|NARASHINO|"
        "NARITA|NARUTOCHO MITSUISHI|NASUSHIOBARA|NATORI SHI|NEYAGAWA|NICHINAN|NIHOMMATSU|NIIGATA|NIIHAMA|"
        "NIITSU HONCHO|NIIZA|NIKKO|NISHI TOKYO SHI|NISHINOMIYA|NISHIO|NISSHIN|NOBEOKA|NODA|NOGATA|NONOICHI|"
        "NOSHIRO|NUMAZU|OAMI|OBIHIRO|ODATE|ODAWARA|OGAKI|OGORI|OITA|OJIMA|OKAYA|OKAYAMA|OKAZAKI|OKEGAWA|OKINAWA|"
        "OMIHACHIMAN|OMURA|OMUTA|ONOJO|ONOMICHI|OSAKA|OSAKI|OSHU|OTARU|OTAWARA|OTSU|OWARIASAHI|OYAMA|RITTO|"
        "RYUGASAKI|SABAE|SADO|SAGAMIHARA|SAIJO|SAIKI|SAITAMA|SAKADO|SAKAI|SAKAIDECHO|SAKATA|SAKU|SAKURA|SAKURAI|"
        "SANDACHO|SANJO|SANO|SANYOONODA|SAPPORO|SASEBO|SATTE|SAYAMA|SEKIMACHI|SENDAI|SENNAN|SETAGAYA|SETO|SETTSU|"
        "SHIBATA|SHIBUKAWA|SHIBUYA|SHIJONAWATE|SHIKI|SHIKOKUCHUO|SHIMADA|SHIMODATE|SHIMONOSEKI|SHIMOTODA|"
        "SHIMOTSUKE|SHINAGAWA|SHINJUKU|SHIOGAMA|SHIOJIRI|SHIRAKAWA|SHIRAOKA|SHIROI|SHIZUOKA|SHUNAN|SODEGAURA|"
        "SOJA|SOKA|SUGINAMI|SUITA|SUKAGAWA|SUMIDA|SUSONO|SUZAKA|SUZUKA|TACHIKAWA|TAGAJO SHI|TAGAWA|TAHARA|TAITO|"
        "TAJIMI|TAKAISHI|TAKAMATSU|TAKAOKA|TAKARAZUKA|TAKASAGO|TAKASAKI|TAKATSUKI|TAKAYAMA|TAKEFU|TAKIZAWA|TAMA|"
        "TAMANA|TAMANO|TAMBA|TANABE|TANASHICHO|TANBA|TATEBAYASHI|TATEYAMA|TATSUNO|TENDO|TENRI|TOCHIGI|TOGANE|"
        "TOKAI|TOKAMACHI|TOKI|TOKONAME|TOKOROZAWA|TOKUSHIMA|TOKUYAMA|TOKYO|TOMAKOMAI|TOME|TOMIGUSUKU|TOMIYA|"
        "TONDABAYASHICHO|TORIDE|TOSHIMA|TOSU|TOTTORI SHI|TOWADA|TOYAMA|TOYOAKE|TOYOHASHI|TOYOKAWA|TOYONAKA|"
        "TOYOOKA|TOYOTA|TSUBAME|TSUCHIURA|TSUKUBA|TSURUGA|TSURUGASHIMA|TSURUOKA|TSURUSAKI|TSUSHIMA|TSUYAMA|UEDA|"
        "UENO EBISUMACHI|URASOE|URAYASU|URUMA|USHIKU|UTSUNOMIYA|UWAJIMA|WAKAYAMA|WAKO|WARABI|YACHIMATA|YACHIYO|"
        "YAIZU|YAMAGATA|YAMAGUCHI|YAMATO|YAMATO TAKADA|YAMATOKORIYAMA|YAME|YANAGAWA|YASHIO|YASU|YAWATA|YOKKAICHI|"
        "YOKOHAMA|YOKOSUKA|YOKOTA|YOKOTE|YONAGO|YONEZAWA|YONO|YOSHIKAWA|YOTSUKAIDO|YOTSUYA|YOUKAICHI|YUKI|"
        "YUKUHASHI|YURIHONJO|ZAMA|ZUSHI"
    ),
    "KE": (
        "ATHI RIVER|BUNGOMA|BUSIA|EL WAK|ELDORET|EMBU|GARISSA|GILGIL|GITHUNGURI|IMARA DAIMA ESTATE|ISIOLO|JOMVU|"
        "JUJA|KAKAMEGA|KAPENGURIA|KARURI|KERICHO|KHWISERO|KIAMBU|KIKUYU|KILIFI|KIMILILI|KISERIAN|KISII|KISUMU|"
        "KITALE|KITENGELA|LANGATA|LIMURU|LODWAR|MACHAKOS|MALINDI|MANDERA|MATUGA|MBALE|MERU|MIGORI|MLOLONGO|"
        "MOMBASA|MTWAPA|MWALA|NAIROBI|NAIVASHA|NAKURU|NANYUKI|NAROK|NGONG|NYERI|ONGATA RONGAI|RUIRU|THIKA|UKUNDA|"
        "UPPER GILGIL|WAJIR|WANGURU"
    ),
    "KG": "BISHKEK|KARAKOL|MANAS|TOKMOK",
    "KH": (
        "ANLONG VEAENG|BATTAMBANG|DANGKAO|KAMPONG CHAM|KAMPONG CHHNANG|PAOY PAET|PHNOM PENH|PREAEK PRASAB|PURSAT|"
        "SIEM REAP|SIHANOUKVILLE|TA KHMAU|TAKEO"
    ),
    "KM": "MORONI",
    "KP": (
        "ANJU|CHAERYONG NI|CHAERYONG UP|CHANGAM CHON|CHONGDAN UP|CHONGJIN|HAEJU|HAMHUNG|HONGWON|HUNGNAM|HWADAE|"
        "HWASONG|HYESAN|HYESAN DONG|KAECHON|KAESONG|KANGGYE|KANGNYONG|KANGSON|KILJU|KWAIL UP|MANGYONGDAE RI|"
        "MANPO|MYONGCHON|MYONGGAN DONG|NAMPO|NAMYANG NODONGJAGU|ONGJIN|ORANG|PAECHON UP|PAEKAK|PONGCHON UP|"
        "PYONGSONG|PYONGYANG|RAJIN|SAMCHON|SARIWON SI|SINCHON UP|SINPO|SINUIJU|SINWON UP|SONGNIM NI|SUNCHON|"
        "TAETAN UP|TOKCHON|UIJU|ULLYUL|UNCHON UP|UNDOK|WONSAN|YUKTAE DONG"
    ),
    "KR": (
        "ANDONG|ANSAN SI|ANSEONG|ANYANG SI|ASAN|BORYEONG|BUCHEON SI|BUSAN|BUYEO|CHANGNYEONG|CHANGWON|CHEONAN|"
        "CHEONGJU SI|CHINCHON|CHINJU|CHUNCHEON|CHUNGJU|DAEGU|DAEJEON|DONGHAE CITY|EISEN|GANGNEUNG|GAPYEONG|GEOJE|"
        "GIJANG|GIMCHEON|GIMPO SI|GONGJU|GOYANG SI|GUMI|GUNPO|GUNSAN|GURI SI|GWANGJU|GWANGMYEONG|GWANGYANG|"
        "GYEONGJU|GYEONGSAN SI|HANAM|HONGCHON|HONGSEONG|HWADO|HWASEONG SI|HWASUN|HWAWON|ICHEON SI|IKSAN|INCHEON|"
        "JEJU|JEJU CITY|JEONGEUP|JEONJU|KIMHAE|KOCHANG|KOSONG|KWANGYANG|KYOSAI|MASAN|MIRYANG|MOKPO|MUAN|"
        "MUNGYEONG|NAESO|NAMYANGJU|NANGEN|OKCHEON|OSAN|POHANG|PUBAL|PYEONGTAEK|SANGJU|SEJONG|SEOGWIPO|"
        "SEONGNAM SI|SEOSAN|SEOUL|SIHEUNGDONG|SINAN|SINHYEON|SOKCHO|SUNCHEON|SUWON|TALLANG DONG|TONGYEONG|"
        "UIJEONGBU SI|UIWANG|ULSAN|UNGSANG|WABU|WANJU|WONJU|YANGJU|YANGPYONG|YANGSAN|YECHEON|YEOJU|YEONGAM|"
        "YEONGGWANG|YEONGJU|YEOSU"
    ),
    "KW": (
        "AL AHMADI|AL FAHAHIL|AL FARWANIYAH|AR RIQQAH|AR RUMAYTHIYAH|AS SALIMIYAH|HAWALLI|KUWAIT CITY|"
        "SABAH AS SALIM"
    ),
    "KZ": (
        "AKTAU|AKTOBE|ALMATY|ASTANA|ATYRAU|BAIKONUR|BALQASH|EKIBASTUZ|KARAGANDY|KENTAU|KOKSHETAU|KOSTANAY|"
        "KYZYLORDA|ORAL|PAVLODAR|PETROPAVL|QULSARY|RIDDER|RUDNYY|SARQANT|SATPAYEV|SEMEY|SHYMKENT|TALDYKORGAN|"
        "TARAZ|TEMIRTAU|TURKISTAN|UST KAMENOGORSK|ZHANAOZEN|ZHEZQAZGHAN"
    ),
    "LA": "BAN KHOAN|LUANG PRABANG|PAKSE|SAVANNAKHET|THAKHEK|VIENTIANE|XAM NUA",
    "LB": "AARSAL|ALEY|BEIRUT|GHAZIEH|HABBOUCH|JOUNIEH|NABATIYE ET TAHTA|RAS BAYRUT|SIDON|TRIPOLI|ZAHLE",
    "LK": (
        "AMBALANGODA|AMBALANTOTA|ANURADHAPURA|BATTARAMULLA SOUTH|BATTICALOA|BELIATTA|COLOMBO|DAMBULLA|"
        "DEHIWALA MOUNT LAVINIA|GALLE|HENDALA|JAFFNA|KALMUNAI|KANDY|KATUNAYAKA|KOLONNAWA|KOTIKAWATTA|MAHARAGAMA|"
        "MATARA|MORATUWA|NEGOMBO|PITA KOTTE|POINT PEDRO|SRI JAYEWARDENEPURA KOTTE|TRINCOMALEE|VALVEDDITTURAI|"
        "VAVUNIYA"
    ),
    "LR": "GANTA|GBARNGA|KAKATA|MONROVIA", "LS": "MAPUTSOE|MASERU",
    "LT": "DAINAVA KAUNAS|KAUNAS|KLAIPEDA|PANEVEZYS|SIAULIAI|VILNIUS",
    "LV": "DAUGAVPILS|JELGAVA|JURMALA|LIEPAJA|RIGA",
    "LY": (
        "AJDABIYA|AL AJAYLAT|AL AZIZIYAH|AL BAYDA|AL HURSHAH|AL JADID|AL JUMAYL|AL KHUMS|AL MARJ|AS SAWANI|"
        "AZ ZAWIYAH|BENGHAZI|DARNAH|JANZUR|MISRATAH|MSALATAH|QASR BIN GHASHIR|SABHA|SABRATAH|SIRTE|SURMAN|TAJURA|"
        "TARHUNA|TOBRUK|TRIPOLI|ZAWIYA|ZLITEN"
    ),
    "MA": (
        "AD DARWA|AGADIR|AIN EL AOUDA|AIN HARROUDA|AIT MELLOUL|AL AAROUI|AL FQIH BEN CALAH|AL HOCEIMA|AZROU|"
        "BEJAAD|BEN GUERIR|BEN JERRAR|BENI ENZAR|BENI MELLAL|BENSLIMANE|BERKANE|BERRECHID|BOUSKOURA|CASABLANCA|"
        "DAKHLA|DAR BOUAZZA|DCHIRA EL JIHADIA|EL JADIDA|EL KELAA DES SRARHNA|ERRACHIDIA|ESSAOUIRA|FES AL BALI|"
        "FNIDEK|GUELMIM|GUERCIF|IFRANE|INEZGANE|KASBA TADLA|KENITRA|KHEMISSET|KHENIFRA|KHOURIBGA|KSAR EL KEBIR|"
        "LAHRAOUYINE|LARACHE|LQOLIAA|MARRAKESH|MARTIL|MDIQ|MEKNES|MIDELT|MOHAMMEDIA|MY DRARGA|NADOR|OUARZAZATE|"
        "OUED ZEM|OUEZZANE|OUISLANE|OUJDA|OULAD TEIMA|RABAT|SAFI|SALE AL JADIDA|SEFROU|SETTAT|SIDI BENNOUR|"
        "SIDI KACEM|SIDI SLIMANE|SIDI TAIBI|SKHIRATE|SOUK EL ARBAA|SOUQ SEBT OULAD NEMMA|TAN TAN|TANGIER|"
        "TAOURIRT|TAROUDANT|TAZA|TEMARA|TETOUAN|TIFLET|TIRHANIMINE|TIZNIT|YOUSSOUFIA"
    ),
    "MD": "BALTI|BENDER|CHISINAU|RIBNITA|TIRASPOL", "ME": "NIKSIC|PODGORICA",
    "MG": (
        "AMBANJA|AMBATONDRAZAKA|AMBILOBE|AMBOVOMBE|ANTALAHA|ANTANANARIVO|ANTANIFOTSY|ANTSALOVA|ANTSIRABE|"
        "ANTSIRANANA|FIANARANTSOA|HELL VILLE|IMERINTSIATOSIKA|IVATO|MAHAJANGA|MORAMANGA|MORONDAVA|SAMBAVA|"
        "TOAMASINA|TOLANARO|TOLIARA"
    ),
    "MK": "BITOLA|CAIR|GOSTIVAR|KISELA VODA|KUMANOVO|PRILEP|SKOPJE|TETOVO|VELES",
    "ML": (
        "BAMAKO|BOUGOUNI|DIALAKORODJI|FANA|KALABAN KORO|KATI|KAYES|KITA|KOULIKORO|KOUTIALA|MARKALA|MOPTI|NIONO|"
        "NIORO|PELENGANA|SEGOU|SIKASSO|TIMBUKTU"
    ),
    "MM": (
        "AMARAPURA|BAGO|BHAMO|BOGALE|BUTHIDAUNG TOWN|CHAUK|DAWBON|DAWEI|HEHO|HINTHADA|HLAINGTHAYA|HPA AN|HPAKAN|"
        "INSEIN|KALAW|KALEMYO|KANBE|KAWTHOUNG|KENG TUNG|KYAIKLAT|KYAUKPYU|KYAUKSE|KYAUKTAN|KYIMYINDINE|LAKANG|"
        "LASHIO|MAGWAY|MANAUNG|MANDALAY|MAWLAMYINE|MEIKTILA|MINBU|MINGALA TANGNYUNT|MINGALADON|MOENG YANG|MOGOK|"
        "MONG YANG|MONYWA|MU SE|MUDON|MYAUNGMYA|MYAYDO|MYEIK|MYINGYAN|MYITKYINA|NAY PYI TAW|NYAUNGLEBIN|PAKOKKU|"
        "PATHEIN|PYAY|PYIN OO LWIN|PYINMANA|SAGAING|SAN CHAUNG|SANGYOUNG|SET KA LAY|SHWEBO|SHWEGU|SITTWE|"
        "TACHILEK|TAIKKYI|TAUNGDWINGYI|TAUNGGYI|TAUNGOO|THANBYUZAYAT|THANDWE|THANHLYIN|THANLYIN|THARYARWADY|"
        "THATON|THAYETMYO|THONGWA|YAMETHIN|YANGON|YAWNGHWE|YENANGYAUNG"
    ),
    "MN": "DARHAN|ERDENET|ULAN BATOR", "MO": "MACAU|TAIPA", "MQ": "FORT DE FRANCE",
    "MR": "DAR NAIM|KAEDI|KIFFA|KSAR|MBERA|NEMA|NOUADHIBOU|NOUAKCHOTT|ZOUERAT",
    "MU": "BEAU BASSIN ROSE HILL|CUREPIPE|PORT LOUIS|QUATRE BORNES|VACOAS",
    "MW": "BLANTYRE|KARONGA|KASUNGU|LILONGWE|MANGOCHI|MZUZU|ZOMBA",
    "MX": (
        "ACAMBARO|ACAPULCO DE JUAREZ|ACAYUCAN|AGUA PRIETA|AGUASCALIENTES|ALTAMIRA|ALVARO OBREGON|AMOZOC DE MOTA|"
        "APATZINGAN|ARANDAS|ATLIXCO|AZCAPOTZALCO|BENITO JUAREZ|BUENAVISTA|CABO SAN LUCAS|CADEREYTA|"
        "CADEREYTA JIMENEZ|CAMPECHE|CANCUN|CARDENAS|CELAYA|CHALCO|CHETUMAL|CHICOLOAPAN|CHIHUAHUA|CHILPANCINGO|"
        "CHOLULA|CIUDAD ACUNA|CIUDAD APODACA|CIUDAD BENITO JUAREZ|CIUDAD DE HUAJUAPAN DE LEON|"
        "CIUDAD DE VILLA DE ALVAREZ|CIUDAD DEL CARMEN|CIUDAD DELICIAS|CIUDAD GENERAL ESCOBEDO|CIUDAD GUZMAN|"
        "CIUDAD HIDALGO|CIUDAD JUAREZ|CIUDAD LAZARO CARDENAS|CIUDAD LOPEZ MATEOS|CIUDAD MADERO|CIUDAD MANTE|"
        "CIUDAD NEZAHUALCOYOTL|CIUDAD OBREGON|CIUDAD RIO BRAVO|CIUDAD VALLES|CIUDAD VICTORIA|COACALCO|COATEPEC|"
        "COATZACOALCOS|COLIMA|COLONIA DEL VALLE|COLONIA LINDAVISTA|COLONIA NATIVITAS|COMITAN|CORDOBA|CORTAZAR|"
        "COYOACAN|COZUMEL|CUAUHTEMOC|CUAUTITLAN|CUAUTITLAN IZCALLI|CUAUTLA|CUERNAVACA|CULIACAN|"
        "DELEGACION CUAJIMALPA DE MORELOS|DOLORES HIDALGO|ECATEPEC DE MORELOS|EL PUEBLITO|ENSENADA|FRESNILLO|"
        "FRONTERA|FUENTES DEL VALLE|GOMEZ PALACIO|GUADALAJARA|GUADALUPE|GUAMUCHIL|GUANAJUATO|GUASAVE|"
        "GUSTAVO ADOLFO MADERO|HACIENDA SANTA FE|HERMOSILLO|HEROICA CABORCA|"
        "HEROICA CIUDAD DE JUCHITAN DE ZARAGOZA|HEROICA GUAYMAS|HEROICA MATAMOROS|HEROICA ZITACUARO|"
        "HIDALGO DEL PARRAL|HUAMANTLA|HUAUCHINANGO|HUIXQUILUCAN|IGUALA DE LA INDEPENDENCIA|IRAPUATO|"
        "IXTAPA ZIHUATANEJO|IXTAPALUCA|IZTACALCO|IZTAPALAPA|JACONA DE PLANCARTE|JARDINES DE LA SILLA|JIUTEPEC|"
        "KANASIN|LA PAZ|LA PIEDAD DE CABADAS|LAGOS DE MORENO|LEON DE LOS ALDAMA|LERDO|LINARES|LOS MOCHIS|"
        "LOS REYES ACAQUILPAN|MAGDALENA CONTRERAS|MANZANILLO|MARTINEZ DE LA TORRE|MATAMOROS|MATEHUALA|MAZATLAN|"
        "MERIDA|MEXICALI|MEXICO|MEXICO CITY|MIGUEL HIDALGO|MINATITLAN|MIRAMAR|MONCLOVA|MONTEMORELOS|MONTERREY|"
        "MORELIA|NAUCALPAN DE JUAREZ|NAVOJOA|NICOLAS ROMERO|NOGALES|NUEVO CASAS GRANDES|NUEVO LAREDO|OAXACA|"
        "OCOTLAN|OJO DE AGUA|ORIZABA|PACHUCA DE SOTO|PAPANTLA DE OLARTE|PARAISO|PATZCUARO|PIEDRAS NEGRAS|"
        "PIJIJIAPAN|PLAYA DEL CARMEN|POLANCO|POZA RICA DE HIDALGO|PUEBLA|PUERTO PENASCO|PUERTO VALLARTA|"
        "RAMOS ARIZPE|REYNOSA|RIOVERDE|ROSARITO|SABINAS|SAHUAYO DE MORELOS|SALAMANCA|SALINA CRUZ|SALTILLO|"
        "SAN ANDRES TUXTLA|SAN BERNARDINO TLAXCALANCINGO|SAN CRISTOBAL DE LAS CASAS|SAN FRANCISCO DEL RINCON|"
        "SAN FRANCISCO TESISTAN|SAN JOSE DEL CABO|SAN JUAN DEL RIO|SAN LUIS POTOSI|SAN LUIS RIO COLORADO|"
        "SAN MARTIN TEXMELUCAN DE LABASTIDA|SAN MATEO ATENCO|SAN MIGUEL DE ALLENDE|SAN NICOLAS DE LOS GARZA|"
        "SAN PABLO DE LAS SALINAS|SAN PEDRO GARZA GARCIA|SAN SALVADOR TIZATLALLI|SANTA CATARINA|"
        "SANTA CRUZ XOXOCOTLAN|SANTA MARIA CHIMALHUACAN|SANTIAGO DE QUERETARO|SANTIAGO TEYAHUALCO|"
        "SANTO DOMINGO TEHUANTEPEC|SILAO DE LA VICTORIA|SOLEDAD DE GRACIANO SANCHEZ|TAMPICO|TAPACHULA|"
        "TAXCO DE ALARCON|TECATE|TECOMAN|TEHUACAN|TEMIXCO|TEOLOYUCAN|TEPATITLAN DE MORELOS|"
        "TEPEJI DEL RIO DE OCAMPO|TEPEXPAN|TEPIC|TEXCOCO DE MORA|TEZIUTLAN|TIJUANA|TLAHUAC|TLALNEPANTLA|TLALPAN|"
        "TLAQUEPAQUE|TLAXCALA|TOLUCA|TONALA|TORREON|TULANCINGO|TULTEPEC|TUXPAM DE RODRIGUEZ CANO|TUXTEPEC|TUXTLA|"
        "URIANGATO|URUAPAN|VALLE DE SANTIAGO|VENUSTIANO CARRANZA|VERACRUZ|VICTORIA DE DURANGO|"
        "VILLA VICENTE GUERRERO|VILLAHERMOSA|XALAPA DE ENRIQUEZ|XICO|XOCHIMILCO|YAUTEPEC|ZACAPU|ZACATECAS|"
        "ZAMORA DE HIDALGO|ZAPOPAN|ZINACANTEPEC|ZUMPANGO"
    ),
    "MY": (
        "ALOR SETAR|AMPANG|ARA DAMANSARA|BANDAR BUKIT RAJA|BANDAR KINRARA|BANDAR LABUAN|BANDAR MAHKOTA CHERAS|"
        "BANDAR SAUJANA UTAMA|BANDAR SERI ALAM|BANDAR SUNWAY|BANDAR TASIK PUTERI|BANDAR UTAMA|BATU CAVES|"
        "BATU PAHAT|BAYAN LEPAS|BERCHAM|BINTULU|BUKIT BINTANG|BUKIT INDAH|BUKIT JALIL|BUKIT MERTAJAM|"
        "BUKIT RAHMAN PUTRA|BUKIT TENGAH|BUTTERWORTH|CHERAS|CUKAI|CYBERJAYA|DAMANSARA DAMAI|DONGGONGON|"
        "GELANG PATAH|GEORGE TOWN|HULU LANGAT|IJOK|IPOH|ISKANDAR PUTERI|JELUTONG|JITRA|JOHOR BAHRU|JOHOR JAYA|"
        "KAJANG|KAMPONG BAHARU CHERAS BATU SEBELAS|KAMPONG DUNGUN|KAMPONG SIDAM|KAMPUNG BARU BALAKONG|"
        "KAMPUNG BARU SUBANG|KAMPUNG BUKIT BAHARU|KAMPUNG KANGKAR TEBERAU|KAMPUNG LARKIN LAMA|KAMPUNG MANJOI|"
        "KAMPUNG PASIR GUDANG BARU|KAMPUNG SUNGAI ARA|KAMPUNG SUNGAI GLUGUR|KAMPUNG SUNGAI KAJANG|KANGAR|KAPAR|"
        "KEMPAS|KENINGAU|KEPONG|KLANG|KLUANG|KOTA BHARU|KOTA DAMANSARA|KOTA KINABALU|KOTA KUALA MUDA|KOTA TINGGI|"
        "KUALA KRAI|KUALA KUBU BAHARU|KUALA LUMPUR|KUALA NERUS|KUALA SELANGOR|KUALA TERENGGANU|KUANTAN|"
        "KUCHAI LAMA|KUCHING|KULAI|KULIM|LABUAN|LAHAD DATU|MALACCA|MARAN|MARUDI|MASAI|MIRI|MUAR|MUKIM PULAI|"
        "PADANG SERAI|PAGOH|PANDAMARAN|PARIT|PARIT SULUNG|PASIR GUDANG|PASIR MAS|PASIR PUTEH|PAYA TERUBONG|"
        "PELENTONG|PENDANG|PERAI|PERLING|PETALING JAYA|PORT DICKSON|PUCHONG|PUTATAN|PUTRA HEIGHTS|PUTRAJAYA|"
        "RAWANG|SANDAKAN|SEGAMAT|SELAYANG BARU UTARA|SEMENYIH|SEMPORNA|SENTUL|SEPANG|SEREMBAN|SERENDAH|"
        "SERI KEMBANGAN|SERI MANJUNG|SERIAN|SETAPAK|SETIA ALAM|SETIA TROPIKA|SHAH ALAM|SIBU|SIMPANG EMPAT|"
        "SIMPANG RENGGAM|SITIAWAN|SKUDAI|SRI PETALING|SUBANG JAYA|SUNGAI BULOH|SUNGAI PETANI|TAIPING|"
        "TAMAN MELATI|TAMAN MELAWATI|TAMAN PETALING|TAMAN SENAI|TAMAN SENAWANG INDAH|TANJONG MALIM|TASEK GLUGOR|"
        "TAWAU|TELUK INTAN|TEMERLUH|TITIWANGSA|ULU TIRAM|VAL DOR|WANGSA MAJU|YAN BESAR"
    ),
    "MZ": (
        "ANGOCHE|BEIRA|CHIBUTO|CHIMOIO|CHOKWE|CUAMBA|DONDO|GURUE|INHAMBANE|LICHINGA|MANDIMBA|MANHICA|MAPUTO|"
        "MATOLA|MAXIXE|MOCUBA|MONAPO|MONTEPUEZ|MOZAMBIQUE|NACALA|NAMETIL|NAMPULA|PEMBA|QUELIMANE|RESSANO GARCIA|"
        "TETE|XAI XAI"
    ),
    "NA": "RUNDU|SWAKOPMUND|WALVIS BAY|WINDHOEK", "NC": "NOUMEA",
    "NE": "AGADEZ|ALAGHSAS|ARLIT|BIRNI N KONNI|DIFFA|DOGONDOUTCHI|DOSSO|GAYA|MARADI|NIAMEY|TAHOUA|TESSAOUA|ZINDER",
    "NG": (
        "ABAKALIKI|ABEOKUTA|ABUJA|ADO EKITI|AFIKPO|AGBOR|AGEGE|AGULU|AJEGUNLE|AKOWONJO|AKURE|ALASIA|ALIAYABIAGBA|"
        "ALIMOSHO|AMAIGBO|APOMU|ARAMOKO EKITI|ASABA|ATANI|AUCHI|AWKA|AZARE|BAMA|BAUCHI|BENDE|BENIN|BENIN CITY|"
        "BIDA|BIRNIN KEBBI|BUGUMA|CALABAR|CHAKWAMA|DAURA|EBUTE IKORODU|EFFIUM|EFON ALAAYE|EHA AMUFU|EJIGBO|"
        "EKPOMA|EMURE EKITI|ENUGU|ENUGU UKWU|ESUK ORON|EZZA OHU|FIDITI|FUNTUA|GAMBORU|GASHUA|GBOKO|GBONGAN|GOMBE|"
        "GUSAU|HADEJIA|IBADAN|IDAH|IDANRE|IGBARA ODO|IGBO ORA|IGBO UKWU|IGBOHO|IGEDE EKITI|IHIALA|IJEBU IGBO|"
        "IJEBU JESA|IJEBU ODE|IJERO EKITI|IKARE|IKEJA|IKERE EKITI|IKIRE|IKIRUN|IKOM|IKOT EKPENE|ILA ORANGUN|"
        "ILE IFE|ILESA|ILOBU|ILORIN|INISA|IPOTI|IREWE|ISE EKITI|ISEYIN|ISIEKE|JALINGO|JEGA|JIMETA|KADUNA|"
        "KAFANCHAN|KAGORO|KANO|KATSINA|KAURA NAMODA|KEFFI|KISI|KONTAGORA|KUJE|LAFIA|LAFIAGI|LAGOS|LALUPON|LEKKI|"
        "LERE|LOKOJA|MAIDUGURI|MAKOKO|MAKURDI|MALUMFASHI|MINNA|MODAKEKE|MUBI|MUSHIN|NGURU|NKPOR|NKWERRE|NNEWI|"
        "NSUKKA|NUMAN|OBALENDE|OBONOMA|OFFA|OGAMINANA|OGBOMOSO|OHAFIA IFIGH|OKE MESI|OKENE|OKIGWE|OKRIKA|OLUPONA|"
        "ONDO|ONITSHA|ORITA ERUWA|OSHODI|OSOGBO|OWERRI|OYAN|OZUBULU|PINDIGA|PORT HARCOURT|POTISKUM|SAKI|SAPELE|"
        "SHAGAMU|SHOMOLU|SOKOTO|SULEJA|SURULERE|UGEP|UGHELLI|UMUAHIA|UROMI|WARRI|WUKARI|YENAGOA|YOLA|ZARIA"
    ),
    "NI": (
        "CHINANDEGA|CIUDAD SANDINO|EL VIEJO|ESTELI|GRANADA|JINOTEGA|JUIGALPA|MANAGUA|MASAYA|MATAGALPA|MATEARE|"
        "NUEVA GUINEA|TIPITAPA"
    ),
    "NL": (
        "ALKMAAR|ALMELO|ALMERE STAD|ALPHEN AAN DEN RIJN|AMERSFOORT|AMSTELVEEN|AMSTERDAM|AMSTERDAM CENTRUM|"
        "AMSTERDAM NIEUW WEST|AMSTERDAM OOST|AMSTERDAM WEST|AMSTERDAM ZUID|AMSTERDAM ZUIDOOST|APELDOORN|ARNHEM|"
        "ASSEN|BERGEN OP ZOOM|BREDA|CAPELLE AAN DEN IJSSEL|DELFT|DEN HAAG|DEN HELDER|DEVENTER|DORDRECHT|"
        "EINDHOVEN|EMMEN|ENSCHEDE|GOUDA|GRONINGEN|HAARLEM|HARDENBERG|HEERLEN|HELMOND|HENGELO|HILVERSUM|HOOFDDORP|"
        "HOORN|LEEUWARDEN|LEIDEN|LELYSTAD|MAASTRICHT|NIEUWEGEIN|NIJMEGEN|NOORD|OOSTERHOUT|PURMEREND|ROOSENDAAL|"
        "ROTTERDAM|S GRAVENHAGE|S HERTOGENBOSCH|SCHIEDAM|SPIJKENISSE|THE HAGUE|TILBURG|UTRECHT|VEENENDAAL|"
        "VELSEN ZUID|VENLO|VLAARDINGEN|ZAANDAM|ZAANSTAD|ZEIST|ZOETERMEER|ZWOLLE"
    ),
    "NO": (
        "ALESUND|ASKER|BERGEN|DRAMMEN|FREDRIKSTAD|KRISTIANSAND|LILLESTR M|LILLESTROM|OSLO|SANDEFJORD|SANDNES|"
        "SARPSBORG|SKIEN|STAVANGER|T NSBERG|TONSBERG|TRONDHEIM"
    ),
    "NP": (
        "BANEPA|BHARATPUR|BHIMDATTA|BIRATNAGAR|BIRENDRANAGAR|BIRGANJ|BUTWAL|CHAUTARA|DHANGADHI|DHARAN|GULARIYA|"
        "HETAUDA|INARUWA|JANAKPUR|KATHMANDU|LAHAN|MADHYAPUR THIMI|NEPALGUNJ|PATAN|POKHARA|RAJBIRAJ|"
        "SIDDHARTHANAGAR|TRIYUGA"
    ),
    "NZ": (
        "AUCKLAND|CHRISTCHURCH|DUNEDIN|INVERCARGILL|LOWER HUTT|MANUKAU|MANUKAU CITY|NAPIER|NEW PLYMOUTH|"
        "NORTH SHORE|PALMERSTON NORTH|PAPATOETOE|PORIRUA|ROTORUA|TAURANGA|WELLINGTON|WHANGAREI"
    ),
    "OM": (
        "AL BURAYMI|AL KHABURAH|AS SUWAYQ|BAHLA|BARKA|BAWSHAR|IBRI|MUSCAT|NIZWA|QURAYYAT|RUSTAQ|SAHAM|SALALAH|"
        "SAMAIL|SEEB|SOHAR"
    ),
    "PA": "ARRAIJAN|JUAN DIAZ|LA CHORRERA|LAS CUMBRES|PANAMA|PANAMA CITY|PEDREGAL|SAN MIGUELITO|TOCUMEN",
    "PE": (
        "ABANCAY|AREQUIPA|AYACUCHO|BELEN|BRENA|CAJAMARCA|CALLAO|CATACAOS|CERRO DE PASCO|CHICLAYO|CHILCA|CHIMBOTE|"
        "CHINCHA ALTA|CHOSICA|CHULUCANAS|CIUDAD SATELITE|CUSCO|HUACHO|HUANCAYO|HUANUCO|HUARAL|HUARAZ|IQUITOS|"
        "JAEN|JESUS MARIA|JULIACA|LIMA|MIRAFLORES|MOQUEGUA|MOYOBAMBA|PAITA|PISCO|PIURA|PUCALLPA|PUERTO MALDONADO|"
        "PUNO|SAN FERNANDO|SAN FRANCISCO DE BORJA|SAN ISIDRO|SAN JUAN|SAN MARTIN|SAN MIGUEL|"
        "SANTA ANITA LOS FICUS|SANTIAGO DE SURCO|SELVA ALEGRE|SULLANA|TACNA|TALARA|TARMA|TINGO MARIA|TRUJILLO|"
        "TUMBES|VILLA POETA JOSE GALVEZ BARRENECHEA|WANCHAQ"
    ),
    "PG": "PORT MORESBY",
    "PH": (
        "ALABEL|ANGAT|ANGELES|ANGELES CITY|ANGONO|ANTIPOLO|APALIT|APARRI|ARAYAT|BACOLOD|BACOLOD CITY|BACOOR|"
        "BAGO CITY|BAGONG BARRIO|BAGONG SILANG|BAGONG SILANGAN|BAGUIO|BAIS|BALAGTAS|BALANGA|BALAYAN|BALIUAG|"
        "BAMBAN|BAMBANG|BANCO FILIPINO HOMES|BANGA|BANTAYAN|BATAC CITY|BATANGAS|BAUANG|BAYAMBANG|BAYAWAN|BAYUGAN|"
        "BINAN|BINANGONAN|BINONGA|BISLIG|BOCAUE|BONGABON|BORONGAN|BROOKES POINT|BUDTA|BUENAVISTA|BULACAN|BULAON|"
        "BULUAN|BUNAWAN|BURAUEN|BUSTOS|BUTUAN|CABANATUAN|CABANATUAN CITY|CABUYAO|CADIZ|CAGAYAN DE ORO|CAINTA|"
        "CALABANGA|CALAMBA|CALAPAN|CALASIAO|CALAUAG|CALAUAN|CALBAYOG CITY|CALOOCAN|CALUMPIT|CANDELARIA|CAPAS|"
        "CARDONA|CARMONA|CATARMAN|CATBALOGAN|CAVITE CITY|CEBU|CEBU CITY|CITY OF ISABELA|COGAN|CONCEPCION|"
        "COTABATO|CUPANG|DAANBANTAYAN|DAET|DAGUPAN|DANAO|DAPITAN|DASMARINAS|DAVAO|DIGOS|DINAIG|DINALUPIHAN|"
        "DIPOLOG|DON CARLOS|DUMAGUETE|EL NIDO|ENRIQUE B MAGALONA|ESCALANTE|ESTANCIA|GAPAN|GENERAL SANTOS|"
        "GENERAL TRIAS|GINGOOG|GUBAT|GUIGUINTO|GUYONG|HAGONOY|HIMAMAYLAN|ILAGAN|ILIGAN|ILIGAN CITY|ILOILO|"
        "IMPASUGONG|IMUS|INDANG|IRIGA CITY|ISULAN|ITOGON|JOLO|JOSE RIZAL|KABANKALAN|KALAMANSIG|KALIBO|KAWIT|"
        "KIDAPAWAN|KORONADAL|LA CARLOTA|LA PAZ|LA TRINIDAD|LAMBAYONG|LAOAG|LAPU LAPU|LAPU LAPU CITY|LAS PINAS|"
        "LEGASPI|LIBERTAD|LIBON|LIMAY|LINGAYEN|LIPA CITY|LOS BANOS|LUBAO|LUCENA|LUPON|MABALACAT CITY|MACO|"
        "MAGALANG|MAGSAYSAY|MAGUGPO POBLACION|MAKATI|MAKATI CITY|MALABON|MALAPATAN|MALAYBALAY|MALINGAO|MALITA|"
        "MALOLOS|MALUNGUN|MANAOAG|MANDALUYONG|MANDALUYONG CITY|MANDAUE|MANDAUE CITY|MANGALDAN|MANILA|"
        "MANOLO FORTICH|MANSILINGAN|MANTAMPAY|MARAMAG|MARAWI CITY|MARIANO|MARIKINA|MARIKINA CITY|MARILAO|"
        "MARIVELES|MASINLOC|MATI|MAUBAN|MEYCAUAYAN|MIDSAYAP|MINGLANILLA|MONKAYO|MUNOZ|MUNTINLUPA|MURICAY|NAGA|"
        "NAIC|NASUGBU|NAVOTAS|NIA VALENCIA|NORZAGARAY|OBANDO|OLONGAPO|ORION|ORMOC|OROQUIETA|OZAMIZ CITY|PACO|"
        "PAGADIAN|PAGBILAO|PANABO|PANALANOY|PANDI|PANIQUI|PAOMBONG|PARANAQUE|PARANAQUE CITY|PASAY|PASIG|"
        "PASIG CITY|PATEROS|PATUTO|PLARIDEL|POBLACION|POLANGUI|POLOMOLOK|PORT AREA|PROSPERIDAD|PUERTO PRINCESA|"
        "PULILAN|PULONG SANTA CRUZ|PUTATAN|QUEZON|QUEZON CITY|ROSALES|ROSARIO|ROXAS CITY|SABLAYAN|SAGAY|"
        "SAN FERNANDO|SAN FRANCISCO|SAN ILDEFONSO|SAN JOSE|SAN JOSE DEL MONTE|SAN JUAN|SAN LEONARDO|SAN MATEO|"
        "SAN MIGUEL|SAN PABLO|SAN PEDRO|SANTA CRUZ|SANTA ROSA|SANTO TOMAS|SANTOL|SIBONGA|SILANG|SIOCON|SIPALAY|"
        "SOLANA|SORSOGON|SUBIC|SULTAN KUDARAT|SURALLAH|SURIGAO|TABACO|TABUK|TACLOBAN|TACURONG|TAGAYTAY|"
        "TAGBILARAN CITY|TAGUIG|TALAVERA|TALISAY|TANAUAN|TANAY|TANJAY|TANZA|TARLAC|TARLAC CITY|TAYABAS|TAYTAY|"
        "TINONGAN|TUBOD|TUGUEGARAO|TUNASAN|TUPI|UALOG|URDANETA|VALENZUELA|VICTORIAS|VILLASIS|VIRAC|ZAMBOANGA|"
        "ZARAGOZA"
    ),
    "PK": (
        "ABBOTTABAD|AHMADPUR EAST|ALAHABAD|ARIF WALA|ARIFWALA|ATTOCK CITY|BADIN|BAHAWALNAGAR|BAHAWALPUR|BANNU|"
        "BASIRPUR|BAT KHELA|BATTAGRAM|BHAKKAR|BHALWAL|BHAWANA|BUNI|BUREWALA|CHAK JHUMRA|CHAKWAL|CHAMAN|CHARSADDA|"
        "CHICHAWATNI|CHINIOT|CHISHTIAN|CHITRAL|CHUHAR KANA|CHUNIAN|DADU|DAHARKI|DAJAL|DARYA KHAN|DASKA KALAN|"
        "DAUR|DERA GHAZI KHAN|DERA ISMAIL KHAN|DERA MURAD JAMALI|DHIRKOT|DIGRI|DIJKOT|DINGA|DIPALPUR|DOKRI|"
        "DULLEWALA|EMINABAD|FAISALABAD|FAQIRWALI|FARUKA|FATEHJANG|FORT ABBAS|GAMBAT|GARHI KHAIRO|GHOTKI|GILGIT|"
        "GOJRA|GUJAR KHAN|GUJRANWALA|GUJRAT|GWADAR|HAFIZABAD|HALA|HARIPUR|HARUNABAD|HASILPUR|HAVELI LAKHA|"
        "HUJRA SHAH MUQIM|HYDERABAD|ISLAMABAD|JACOBABAD|JAHANGIRA|JAHANIAN|JALALPUR JATTAN|JALALPUR PIRWALA|"
        "JAMPUR|JAMRUD|JARANWALA|JAUHARABAD|JHANG SADR|JHELUM|KABIRWALA|KAHNA NAU|KAHROR PAKKA|KAMALIA|KAMBAR|"
        "KAMOKE|KANDHKOT|KARACHI|KASUR|KHAIRPUR MIRS|KHANPUR|KHARIAN|KHEWRA|KHURARIANWALA|KHUSHAB|KHUZDAR|KOHAT|"
        "KOT ADDU|KOT MALIK BARKHURDAR|KOT MUMIN|KOT RADHA KISHAN|KOTRI|KUNJAH|KUNRI|KURKALI SINDH PAKISTAN|"
        "LAHORE|LALA MUSA|LALIAN|LARKANA|LAYYAH|LODHRAN|MAILSI|MALIR CANTONMENT|MANDI BAHAUDDIN|MANJHAND|"
        "MANSEHRA|MARDAN|MATLI|MIAN CHANNUN|MIANWALI|MINCHINABAD|MINGORA|MIRPUR KHAS|MIRPUR MATHELO|MITHI|"
        "MODEL TOWN|MORO|MULTAN|MURIDKE|MUZAFFARABAD|MUZAFFARGARH|NANKANA SAHIB|NAROWAL|NAWABSHAH|"
        "NEW MIRPUR CITY|NOWSHERA KALAN|OKARA|PABBI|PAHARPUR|PAKPATTAN|PANO AQIL|PASRUR|PATTOKI|PESHAWAR|PHALIA|"
        "PHOOL NAGAR|PINDI BHATTIAN|PINDI GHEB|PIR JO GOTH|PIR MAHAL|QABULA|QADIRPUR RAN|QUBO SAEED KHAN|QUETTA|"
        "RABWAH|RAHIM YAR KHAN|RAJA JANG|RAJANPUR|RATODERO|RAWALAKOT|RAWALPINDI|RENALA KHURD|ROHRI|SADDIQABAD|"
        "SAHIWAL|SAKRAND|SAMBRIAL|SANGHAR|SANGLA HILL|SARAI ALAMGIR|SARGODHA|SHABQADAR|SHAHDAD KOT|SHAHDADPUR|"
        "SHAHKOT|SHAKARGARH|SHARIFABAD|SHEKHUPURA|SHIKARPUR|SHORKOT|SHUJAABAD|SIALKOT|SIBI|SINJHORO|SKARDU|"
        "SUKKUR|SWABI|TALAGANG|TALHAR|TANDO ADAM|TANDO ALLAHYAR|TANDO BAGO|TANDO JAM|TANDO MUHAMMAD KHAN|TAUNSA|"
        "THUL|TOBA TEK SINGH|TOPI|TORDHER|TURBAT|UBAURO|UMARKOT|USTA MUHAMMAD|VIHARI|WAH CANTT|WAZIRABAD|YAZMAN|"
        "ZAHIR PIR|ZHOB"
    ),
    "PL": (
        "BE CHATOW|BEDZIN|BELCHATOW|BEMOWO|BIA A PODLASKA|BIA O EKA|BIA YSTOK|BIALA PODLASKA|BIALOLEKA|BIALYSTOK|"
        "BIELANY|BIELSKO BIALA|BYDGOSZCZ|BYTOM|CHE M|CHELM|CHORZOW|CZESTOCHOWA|DABROWA GORNICZA|ELBLAG|FORDON|"
        "G OGOW|GDANSK|GDYNIA|GLIWICE|GLOGOW|GNIEZNO|GORZOW WIELKOPOLSKI|GRUDZIADZ|INOWROC AW|INOWROCLAW|"
        "JASTRZEBIE ZDROJ|JAWORZNO|JELENIA GORA|KALISZ|KATOWICE|KEDZIERZYN KOZLE|KIELCE|KONIN|KOSZALIN|KRAKOW|"
        "LEGIONOWO|LEGNICA|LESZNO|LODZ|LOMZA|LUBIN|LUBLIN|MIELEC|MOKOTOW|MYS OWICE|MYSLOWICE|NOWY SACZ|OCHOTA|"
        "OLSZTYN|OMZA|OPOLE|OSTRO EKA|OSTROLEKA|OSTROW WIELKOPOLSKI|OSTROWIEC SWIETOKRZYSKI|P OCK|PABIANICE|PI A|"
        "PIEKARY SLASKIE|PILA|PIOTRKOW TRYBUNALSKI|PLOCK|POZNAN|PRAGA PO NOC|PRAGA PO UDNIE|PRAGA POLNOC|"
        "PRAGA POLUDNIE|PRUSZKOW|PRZEMYSL|PSIE POLE|RACIBORZ|RADOM|RUDA SLASKA|RYBNIK|RZESZOW|S UPSK|SIEDLCE|"
        "SIEMIANOWICE SLASKIE|SLUPSK|SOSNOWIEC|SRODMIESCIE|STALOWA WOLA|STARACHOWICE|STARGARD|SUWA KI|SUWALKI|"
        "SWIDNICA|SWIETOCH OWICE|SWIETOCHLOWICE|SZCZECIN|TARGOWEK|TARNOBRZEG|TARNOW|TARNOWSKIE GORY|TCZEW|"
        "TOMASZOW MAZOWIECKI|TORUN|TYCHY|URSYNOW|W OC AWEK|WA BRZYCH|WALBRZYCH|WARSAW|WARSZAWA|WAWER|WLOCLAWEK|"
        "WOLA|WROC AW|WROCLAW|WRZESZCZ|ZABRZE|ZAMOSC|ZAWIERCIE|ZGIERZ|ZIELONA GORA|ZOLIBORZ|ZORY"
    ),
    "PR": "ARECIBO|BAYAMON|CAGUAS|GUAYNABO|MAYAGUEEZ|MAYAGUEZ|PONCE|SAN JUAN|TRUJILLO ALTO",
    "PS": "BATTIR|BAYT LAHYA|DAYR AL BALAH|EAST JERUSALEM|GAZA|HEBRON|JABALYA|KHAN YUNIS|NABLUS|RAFAH",
    "PT": (
        "ALGUEIRAO|AMADORA|AMORA|AVEIRO|BARREIRO|BRAGA|CACEM|COIMBRA|CORROIOS|EVORA|FARO|FELGUEIRAS|FUNCHAL|"
        "LEIRIA|LISBOA|LISBON|LOURES|MONSANTO|ODIVELAS|QUELUZ|RIO DE MOURO|SETUBAL|VILA NOVA DE GAIA|VISEU"
    ),
    "PY": (
        "ASUNCION|CAACUPE|CAAGUAZU|CAPIATA|CIUDAD DEL ESTE|CORONEL OVIEDO|ENCARNACION|FERNANDO DE LA MORA|"
        "ITAUGUA|LAMBARE|LIMPIO|MARIANO ROQUE ALONSO|NEMBY|PEDRO JUAN CABALLERO|PRESIDENTE FRANCO|SAN ANTONIO|"
        "SAN LORENZO|VILLA ELISA|VILLA HAYES"
    ),
    "QA": "AL MANSURAH|AL MATAR AL ATIQ|AR RAYYAN|AZ ZAAYIN|DOHA|LUSAIL",
    "RE": "LE TAMPON|SAINT ANDRE|SAINT DENIS|SAINT LOUIS|SAINT PAUL|SAINT PIERRE",
    "RO": (
        "ALBA IULIA|ARAD|BACAU|BAIA MARE|BARLAD|BISTRITA|BOTOSANI|BRAILA|BRASOV|BUCHAREST|BUZAU|CLUJ NAPOCA|"
        "CONSTANTA|CRAIOVA|DEVA|DROBETA TURNU SEVERIN|FOCSANI|GALATI|GIURGIU|HUNEDOARA|IASI|MEDIAS|ORADEA|"
        "PIATRA NEAMT|PITESTI|PLOIESTI|RAMNICU VALCEA|RESITA|SATU MARE|SFANTU GHEORGHE|SIBIU|SLATINA|SUCEAVA|"
        "TARGOVISTE|TARGU JIU|TARGU MURES|TIMISOARA|TULCEA|VASLUI|ZALAU"
    ),
    "RS": (
        "BELGRADE|CACAK|KRAGUJEVAC|KRALJEVO|KRUSEVAC|LESKOVAC|NOVI BEOGRAD|NOVI PAZAR|NOVI SAD|PANCEVO|SABAC|"
        "SMEDEREVO|SUBOTICA|UZICE|VALJEVO|VRANJE|ZEMUN|ZRENJANIN"
    ),
    "RU": (
        "ABAKAN|ACHINSK|ADLER|ADMIRALTEISKY|AKADEMGORODOK|AKADEMICHESKOE|ALEKSANDROV|ALEKSEYEVKA|ALEKSIN|"
        "ALMETYEVSK|ALTUFYEVSKIY|ANAPA|ANGARSK|ANZHERO SUDZHENSK|APATITY|ARKHANGELSK|ARMAVIR|ARSENYEV|ARTEM|"
        "ARZAMAS|ASBEST|ASTRAKHAN|AZOV|BABUSHKIN|BALAKOVO|BALASHIKHA|BALASHOV|BARNAUL|BATAYSK|BELEBEY|BELGOROD|"
        "BELOGORSK|BELORECHENSK|BELORETSK|BELOVO|BERDSK|BEREZNIKI|BEREZOVSKIY|BIBIREVO|BIROBIDZHAN|BIRYULEVO|"
        "BIRYULEVO ZAPADNOYE|BIYSK|BLAGOVESHCHENSK|BOGORODSKOYE|BORISOGLEBSK|BOROVICHI|BRATEYEVO|BRATSK|BRYANSK|"
        "BUDYONNOVSK|BUGULMA|BUGURUSLAN|BUYNAKSK|BUZULUK|CENTRALNIY|CHAPAYEVSK|CHAYKOVSKIY|CHEBOKSARY|CHEKHOV|"
        "CHELYABINSK|CHEREMKHOVO|CHEREMUSHKI|CHEREPOVETS|CHERKESSK|CHERNAYA RECHKA|CHERNOGORSK|"
        "CHERTANOVO YUZHNOYE|CHISTOPOL|CHITA|CHUSOVOY|DACHNOYE|DERBENT|DIMITROVGRAD|DMITROV|DOLGOPRUDNYY|"
        "DOMODEDOVO|DONETSK|DOROGOMILOVO|DUBNA|DZERZHINSK|ELEKTROSTAL|ELISTA|ENGELS|EZHVA|FILI|FINLYANDSKIY|"
        "FRYAZEVO|FRYAZINO|GATCHINA|GELENDZHIK|GEORGIYEVSK|GLAZOV|GOLYANOVO|GORNO ALTAYSK|GOROD SOLNETCHNOGORSK|"
        "GRAZHDANKA|GROZNY|GUBKIN|GUKOVO|GUS KHRUSTALNYY|IRKUTSK|ISHIM|ISHIMBAY|ISKITIM|IVANOVO|IVANOVSKOYE|"
        "IVANTEYEVKA|IZHEVSK|IZMAYLOVO|KALININGRAD|KALININSKIY|KALUGA|KAMENSK SHAKHTINSKY|KAMENSK URALSKIY|"
        "KAMYSHIN|KANSK|KASPIYSK|KAZAN|KEMEROVO|KHABAROVSK|KHANTY MANSIYSK|KHASAVYURT|KHIMKI|KHOROSHEVO MNEVNIKI|"
        "KIMRY|KINESHMA|KINGISEPP|KIRISHI|KIROV|KIROVO CHEPETSK|KISELEVSK|KISILEVSK|KISLOVODSK|KIZLYAR|KLIMOVSK|"
        "KLIN|KLINTSY|KOGALYM|KOLOMNA|KOLPINO|KOMENDANTSKY AERODROM|KOMSOMOLSK ON AMUR|KOPEYSK|KOROLEV|KOSTROMA|"
        "KOTLAS|KOTLOVKA|KOVROV|KOZEYEVO|KOZHUKHOVO|KRASNAYA GLINKA|KRASNODAR|KRASNOGORSK|KRASNOGVARGEISKY|"
        "KRASNOKAMENSK|KRASNOKAMSK|KRASNOTURINSK|KRASNOYARSK|KROPOTKIN|KRYMSK|KSTOVO|KUMERTAU|KUNGUR|KUNTSEVO|"
        "KUPCHINO|KURGAN|KURORTNYY|KURSK|KUZMINKI|KUZNETSK|KYZYL|LABINSK|LEFORTOVO|LENINOGORSK|LENINSK KUZNETSKY|"
        "LESNOY|LESOSIBIRSK|LEVOBEREZHNYY|LIANOZOVO|LIKHOBORY|LIPETSK|LISKI|LOBNYA|LYSVA|LYTKARINO|LYUBERTSY|"
        "LYUBLINO|MAGADAN|MAGNITOGORSK|MAKHACHKALA|MARINO|MAYKOP|MELEUZ|METROGORODOK|MEZHDURECHENSK|MIASS|"
        "MICHURINSK|MIKHAYLOVKA|MIKHAYLOVSK|MINERALNYE VODY|MINUSINSK|MOSCOW|MURMANSK|MUROM|MYTISHCHI|"
        "NABEREZHNYYE CHELNY|NAGORNYY|NAKHODKA|NALCHIK|NARO FOMINSK|NAZAROVO|NAZRAN|NEFTEKAMSK|NEFTEYUGANSK|"
        "NERYUNGRI|NEVINNOMYSSK|NIKOLSKOYE|NIZHNEKAMSK|NIZHNEVARTOVSK|NIZHNIY NOVGOROD|NIZHNY TAGIL|NOGINSK|"
        "NORILSK|NOVAYA BALAKHNA|NOVO PEREDELKINO|NOVOALTAYSK|NOVOCHEBOKSARSK|NOVOCHERKASSK|NOVOGIREYEVO|"
        "NOVOKHOVRINO|NOVOKUYBYSHEVSK|NOVOKUZMINKI|NOVOKUZNETSK|NOVOMOSKOVSK|NOVOROSSIYSK|NOVOSHAKHTINSK|"
        "NOVOSIBIRSK|NOVOTROITSK|NOVOURALSK|NOVOVLADYKINO|NOVYY URENGOY|NOVYYE CHEREMUSHKI|NOVYYE KUZMINKI|"
        "NOYABRSK|NYAGAN|OBNINSK|OBRUCHEVO|OCHAKOVO MATVEYEVSKOYE|ODINTSOVO|OKTYABRSKY|OMSK|OREKHOVO BORISOVO|"
        "OREKHOVO BORISOVO SEVERNOYE|OREKHOVO ZUYEVO|OREL|ORENBURG|ORSK|OSTANKINSKIY|OTRADNYY|OZERKI|OZERSK|"
        "PARNAS|PAVLOVO|PAVLOVSKIY POSAD|PENZA|PERM|PERVOURALSK|PETERHOF|PETRODVORETS|PETROGRADKA|"
        "PETROPAVLOVSK KAMCHATSKY|PETROZAVODSK|PODOLSK|POKROVSKOYE STRESHNEVO|POLEVSKOY|PRESNENSKIY|PROKHLADNYY|"
        "PROKOPYEVSK|PSKOV|PUSHKIN|PUSHKINO|PYATIGORSK|RAMENKI|RAMENSKOYE|REUTOV|REVDA|ROSLAVL|ROSSOSH|"
        "ROSTOV ON DON|RUBTSOVSK|RYAZAN|RYAZANSKIY|RYBATSKOYE|RYBINSK|RZHEV|SAINT PETERSBURG|SALAVAT|SALSK|"
        "SAMARA|SARANSK|SARAPUL|SARATOV|SAROV|SEMENOVSKOYE|SERGIYEV POSAD|SEROV|SERPUKHOV|SEVERNYY|SEVERODVINSK|"
        "SEVEROMORSK|SEVERSK|SHADRINSK|SHAKHTY|SHCHEKINO|SHCHUKINO|SHCHYOLKOVO|SHUYA|SIBAY|SLAVYANSK NA KUBANI|"
        "SMOLENSK|SNEZHINSK|SOCHI|SOKOL|SOKOLNIKI|SOLIKAMSK|SOLNECHNOGORSK|SOLNTSEVO|SOSNOVKA|SOSNOVYY BOR|"
        "STARYY OSKOL|STAVROPOL|STERLITAMAK|STROGINO|STUPINO|SUNZHA|SURGUT|SVETLANOVSKIY|SVIBLOVO|SVOBODNYY|"
        "SYKTYVKAR|SYZRAN|TAGANROG|TAGANSKIY|TALNAKH|TAMBOV|TEKSTILSHCHIKI|TIKHORETSK|TIKHVIN|TIMASHYOVSK|"
        "TOBOLSK|TOLYATTI|TOMSK|TROITSK|TROPAREVO|TSARITSYNO|TUAPSE|TULA|TULUN|TUYMAZY|TVER|TYOPLY STAN|TYUMEN|"
        "UKHTA|ULAN UDE|ULYANOVSK|UNTOLOVO|URITSK|USOLYE SIBIRSKOYE|USSURIYSK|UST ILIMSK|UZLOVAYA|VAGONOREMONT|"
        "VASYLEVSKY OSTROV|VATUTINO|VELIKIY NOVGOROD|VELIKIYE LUKI|VERKHNYAYA PYSHMA|VESHNYAKI|VIDNOYE|"
        "VLADIKAVKAZ|VLADIMIR|VLADIVOSTOK|VOLGODONSK|VOLGOGRAD|VOLOGDA|VOLSK|VOLZHSK|VOLZHSKY|VORKUTA|VORONEZH|"
        "VOSKRESENSK|VOSTOCHNOE DEGUNINO|VOTKINSK|VYAZMA|VYBORG|VYKHINO ZHULEBINO|VYKSA|VYSHNIY VOLOCHEK|YAKUTSK|"
        "YAROSLAVL|YAROSLAVSKIY|YARTSEVO|YASENEVO|YEGORYEVSK|YEKATERINBURG|YELABUGA|YELETS|YESSENTUKI|YEYSK|"
        "YOSHKAR OLA|YURGA|YUZHNO SAKHALINSK|ZAMOSKVORECHYE|ZARECHNYY|ZARINSK|ZELENODOLSK|ZELENOGORSK|ZELENOGRAD|"
        "ZHELEZNODOROZHNYY|ZHELEZNOGORSK|ZHIGULEVSK|ZHUKOVSKY|ZHULEBINO|ZLATOUST|ZYABLIKOVO|ZYUZINO"
    ),
    "RW": "BUTARE|GISENYI|GITARAMA|KIGALI|MUHANGA|MUSANZE|NYAGATARE",
    "SA": (
        "ABHA|ABU ARISH|AD DAWADIMI|AD DIRIYAH|AL BAHAH|AL HUFUF|AL JUBAYL|AL KHAFJI|AL KHARJ|AL LITH|"
        "AL MUBARRAZ|AL QATIF|AR RASS|ARAR|ASH SHAFA|AZ ZULFI|BALJURASHI|BARIQ|BISHAH|BURAYDAH|DAMMAM|DHAHRAN|"
        "HAFAR AL BATIN|HAIL|JEDDAH|JIZAN|KHAMIS MUSHAIT|KHOBAR|KING FAISAL MILITARY CITY|MADINAH|MAKKAH|NAJRAN|"
        "QURAYYAT|RABIGH|RAS TANURA|RIYADH|SABT ALALAYAH|SABYA|SAKAKAH|SAYHAT|SULTANAH|TABUK|TAIF|TARUT|THUQBAH|"
        "TURAYF|UNAIZAH|YANBU"
    ),
    "SB": "HONIARA",
    "SD": (
        "AD DAMAZIN|AD DAMIR|AD DOUIEM|AL JUNAYNAH|AL MANAQIL|AL QADARIF|AN NUHUD|ARDAMATA|ATBARA|BURAM|DILLING|"
        "DONGOLA|EL DAEIN|EL FASHER|EL GENEINA FORT|EL OBEID|ER ROSEIRES|GEREIDA|KADUGLI|KASSALA|KHARTOUM|"
        "KHARTOUM NORTH|KOSTI|MELLIT|NEW HALFA|NYALA|OMDURMAN|PORT SUDAN|RABAK|SENNAR|SHENDI|SINGA|UMM RUWABA|"
        "WAD MEDANI"
    ),
    "SE": (
        "BORAS|BROMMA|ESKILSTUNA|GAEVLE|GAVLE|GOTEBORG|GOTHENBURG|HALMSTAD|HANINGE|HELSINGBORG|HUDDINGE|"
        "JOENKOEPING|JONKOPING|KARLSKRONA|KARLSTAD|KUNGSHOLMEN|LINKOEPING|LINKOPING|LULEA|LUND|MALMO|MALMOE|"
        "MOELNDAL|MOLNDAL|NORRKOEPING|NORRKOPING|OEREBRO|OREBRO|SODERMALM|SODERTALJE|SOEDERMALM|SOEDERTAELJE|"
        "SOLLENTUNA|SOLNA|STOCKHOLM|SUNDSVALL|TABY|UMEA|UPPSALA|VAESTERAS|VAEXJOE|VASASTADEN|VASTERAS|VAXJO"
    ),
    "SG": (
        "ANG MO KIO NEW TOWN|BEDOK NEW TOWN|BISHAN NEW TOWN|BUKIT BATOK NEW TOWN|BUKIT MERAH ESTATE|"
        "BUKIT PANJANG NEW TOWN|BUKIT TIMAH|CHOA CHU KANG NEW TOWN|CLEMENTI HOUSING ESTATE|GEYLANG|"
        "HOUGANG NEW TOWN|JURONG EAST|JURONG TOWN|JURONG WEST|KALLANG|KAMPONG PASIR RIS|KEMBANGAN|MATILDA ESTATE|"
        "NOVENA|PASIR RIS NEW TOWN|PUNGGOL|QUEENSTOWN ESTATE|SEMBAWANG ESTATE|SENGKANG NEW TOWN|SERANGOON|"
        "SERANGOON NEW TOWN|SINGAPORE|TAMPINES ESTATE|TAMPINES NEW TOWN|TOA PAYOH NEW TOWN|ULU BEDOK|WOODLANDS|"
        "YISHUN NEW TOWN"
    ),
    "SI": "LJUBLJANA|MARIBOR",
    "SK": "BANSKA BYSTRICA|BRATISLAVA|KOSICE|NITRA|PETRZALKA|PRESOV|TRENCIN|TRNAVA|ZILINA",
    "SL": "FREETOWN|KENEMA|KOIDU|MAKENI",
    "SN": (
        "BARGNY|BARGNY GUEDJ|BARGNY NGOUDE|DAKAR|DIOURBEL|DOUGNANE|GUEDIAWAYE|KAFFRINE|KAOLACK|KEUR MEDOUNE|"
        "KEURMEDOUNE|KOLDA|LOUGA|MBAKE|MBOUR|PIKINE|RICHARD TOLL|RUFISQUE|RUFISQUE EST|SAINT LOUIS|TAMBACOUNDA|"
        "THIES|THIES NONES|TIEBO|TIVAOUANE|TOUBA|YOFF|ZIGUINCHOR"
    ),
    "SO": (
        "AFGOOYE|BAIDOA|BALANBALE|BELED HAWO|BELEDWEYNE|BERBERA|BORAMA|BOSASO|BURAO|CABUDWAAQ|EL DIBIR|GAALKACYO|"
        "GAROOWE|GEBILEY|HARGEYSA|KAAMBOONI|KISMAYO|LAASCAANOOD|MARKA|MOGADISHU|QORYOOLEY|RUQI"
    ),
    "SR": "PARAMARIBO", "SS": "JUBA|KUACJOK|MALAKAL|WINEJOK", "ST": "SAO TOME",
    "SV": (
        "APOPA|DELGADO|MEJICANOS|SAN MARCOS|SAN MIGUEL|SAN SALVADOR|SANTA ANA|SANTA TECLA|SONSONATE|SOYAPANGO|"
        "USULUTAN"
    ),
    "SY": (
        "AL BAB|AL HASAKAH|AL MAYADIN|AL QAMISHLI|AL TABQA|AL YARMUK|ALBU KAMAL|ALEPPO|AR RAQQAH|AR RASTAN|"
        "AS SAFIRAH|AS SALAMIYAH|AS SUWAYDA|AT TALL|AYN AL ARAB|BABILA|DAMASCUS|DARA|DARAYYA|DEIR EZ ZOR|DUMA|"
        "HAMAH|HOMS|IDLIB|IZAZ|JABLAH|JARAMANA|KABBASIN|LATAKIA|MANBIJ|MUADAMIYAT AL SHAM|TADMUR|TARTUS"
    ),
    "SZ": "MANZINI|MBABANE",
    "TD": "ABECHE|AM TIMAN|BONGOR|DERESSIA|DOBA|GOZ BEIDA|KELO|KOUMRA|MONGO|MOUNDOU|NDJAMENA|PALA|SARH",
    "TG": "ATAKPAME|BASSAR|DAPAONG|KPALIME|LOME|SOKODE|TSEVIE",
    "TH": (
        "ANUSAWARI|BAN I CHANG|BAN KHLONG PRAWET|BAN KO SIRE|BAN LAK SONG|BAN LAM LUK KA|BAN MAI|BAN PONG|"
        "BAN SAMAE DAM|BAN TALAT YAI|BAN THA KHAM|BANG BON|BANG KAPI|BANG KHAE|BANG KHAE NUEA|BANG KHUN THIAN|"
        "BANG KRUAI|BANG NA|BANG PHLAT|BANG RAK|BANG SUE|BANG SUE SUBDISTRICT|BANGKOK|BANGKOK NOI|BANGKOK YAI|"
        "BUENG KUM|CHAIYAPHUM|CHANTHABURI|CHATUCHAK|CHIANG MAI|CHIANG RAI|CHOM THONG|CHON BURI|CHUMPHON|"
        "DIN DAENG|DUSIT|HAT YAI|HUA HIN|HUAI KHWANG|HUAMAK|KABIN BURI|KALASIN|KAMPHAENG PHET|KANCHANABURI|"
        "KHAN NA YAO|KHLONG CHAN|KHLONG KUM|KHLONG LUANG|KHLONG SAM WA|KHLONG SAN|KHLONG TOEI|KHON KAEN|KLAENG|"
        "KO SAMUI|KRATHUM BAEN|LAEM CHABANG|LAK SI|LAMPANG|LAT KRABANG|LAT PHRAO|LATKRABANG|LOP BURI|"
        "MAHA SARAKHAM|MUEANG NONTHABURI|NA DI|NAKHON PATHOM|NAKHON RATCHASIMA|NAKHON SAWAN|NAKHON SI THAMMARAT|"
        "NONG CHOK|NONG KHAEM|NONG KHAI|NONG PRUE|PAK KRET|PATHUM WAN|PATTAYA|PHASI CHAROEN|PHAYA THAI|"
        "PHETCHABUN|PHITSANULOK|PHRA KHANONG|PHRA NAKHON|PHRA NAKHON SI AYUTTHAYA|PHRA PHUTTHABAT|PHRA PRADAENG|"
        "PHUKET|POM PRAP SATTRU PHAI|PRACHANTAKHAM|RAT BURANA|RATCHABURI|RATCHATHEWI|RAYONG|SAI MAI|SAKON NAKHON|"
        "SAMUT PRAKAN|SAMUT SAKHON|SAPHAN SUNG|SARABURI|SATHON|SATHORN|SATTAHIP|SI MAHA PHOT|SI RACHA|SONGKHLA|"
        "SUAN LUANG|SUPHAN BURI|SURAT THANI|TALING CHAN|THA MAKA|THA RAENG|THAWI WATTHANA|THON BURI|THUNG KHRU|"
        "TRANG|UBON RATCHATHANI|UDON THANI|UTTARADIT|WANG THONGLANG|WAT THA PHRA|WATTHANA|YALA|YAN NAWA"
    ),
    "TJ": "BOKHTAR|DUSHANBE|ISFARA|ISTARAVSHAN|KHUJAND|KONIBODOM|KULOB", "TL": "DILI",
    "TM": "ASHGABAT|BALKANABAT|BAYRAMALY|DASOGUZ|TEJEN|TUERKMENABAT|TUERKMENBASY|TURKMENABAT|TURKMENBASY",
    "TN": (
        "ARYANAH|BEJA|BEN AROUS|BEN GARDANE|BIZERTE|DJEMMAL|DOUANE|DOUAR HICHER|EL KEF|EL MGARSA|EL MOUROUJ|"
        "ETTADHAMEN|FERIANA|GABES|GAFSA|HAMMAMET|HOUMT SOUK|JENDOUBA|KAIROUAN|KASSERINE|KELAA KEBIRA|KELIBIA|"
        "KORBA|KSAR HELLAL|LA MARSA|LA MOHAMMEDIA|LE BARDO|LE KRAM|MAHDIA|MEDENINE|MENZEL BOURGUIBA|MNIHLA|"
        "MOKNINE|MONASTIR|MSAKEN|NABEUL|OUED LILL|RADES|RAWAD|SAKIET ED DAIER|SAKIET EZ ZIT|SFAX|SIDI HUSAYN|"
        "SKANES|SOUSSE|SUKRAH|TATAOUINE|TUNIS|ZARZIS"
    ),
    "TR": (
        "ADANA|ADAPAZARI|ADILCEVAZ|ADIYAMAN|AFYONKARAHISAR|AGRI|AHLAT|AKCAPINAR|AKHISAR|AKSARAY|AKSEHIR|ALANYA|"
        "AMASYA|ANAMUR|ANKARA|ANTAKYA|ANTALYA|ARDESEN|ARNAVUTKOEY|ARNAVUTKOY|ARSUZ|ATASEHIR|AYDIN|AYVALIK|BAFRA|"
        "BAGCILAR|BAHCELIEVLER|BALIKESIR|BANDIRMA|BARTIN|BASAKSEHIR|BATIKENT|BATMAN|BELEK|BERGAMA|BEYLIKDUEZUE|"
        "BEYLIKDUZU|BIGA|BILECIK|BINGOEL|BINGOL|BISMIL|BITLIS|BOLU|BOLVADIN|BORNOVA|BOZUEYUEK|BOZUYUK|"
        "BUEYUEKCEKMECE|BURDUR|BURSA|BUYUKCEKMECE|CANAKKALE|CANKAYA|CANKIRI|CARSAMBA|CERKEZKOEY|CERKEZKOY|CEYHAN|"
        "CIGLI|CIZRE|CORLU|CORUM|CUBUK|DENIZLI|DERINCE|DIYARBAKIR|DOERTYOL|DOGUBAYAZIT|DORTYOL|DUEZCE|DUZCE|"
        "EDIRNE|ELAZIG|ELBISTAN|EMINOENUE|EMINONU|ERBAA|ERCIS|EREGLI|ERGANI|ERZINCAN|ERZURUM|ESENLER|ESENYURT|"
        "ESKISEHIR|FATIH|FATSA|FETHIYE|GAZIANTEP|GEBZE|GEMLIK|GIRESUN|GOELBASI|GOELCUEK|GOLBASI|GOLCUK|"
        "GUENGOEREN MERTER|GUNGOREN MERTER|HAKKARI|IGDIR|INEGOL|ISKENDERUN|ISPARTA|ISTANBUL|IZMIR|IZMIT|KADIRLI|"
        "KAHRAMANMARAS|KAHTA|KARABAGLAR|KARABUEK|KARABUK|KARAMAN|KARS|KARSIYAKA|KASTAMONU|KAVAKLI|KAYSERI|KILIS|"
        "KIRIKHAN|KIRIKKALE|KIRKLARELI|KIRSEHIR|KIZILTEPE|KOERFEZ|KONAK|KONYA|KORFEZ|KOZAN|KUCUKCEKMECE|"
        "KUECUEKCEKMECE|KUETAHYA|KUSADASI|KUTAHYA|LUELEBURGAZ|LULEBURGAZ|MALATYA|MALTEPE|MANAVGAT|MANISA|MARDIN|"
        "MENEMEN|MERKEZEFENDI|MERSIN|MERTER KERESTECILER|MERZIFON|MIDYAT|MUGLA|MURATPASA|MUSTAFAKEMALPASA|"
        "NAZILLI|NEVSEHIR|NIGDE|NILUEFER|NILUFER|NIZIP|NUSAYBIN|ODEMIS|OEDEMIS|ORDU|ORHANGAZI|OSMANIYE|PATNOS|"
        "POLATLI|REYHANLI|RIZE|SALIHLI|SAMANDAG|SAMSUN|SANCAKTEPE|SANLIURFA|SEYDISEHIR|SIIRT|SILIFKE|SILIVRI|"
        "SILOPI|SILVAN|SIRNAK|SISLI|SIVAS|SIVEREK|SOEKE|SOKE|SOMA|SORGUN|SULTANBEYLI|SULTANGAZI|SURUC|TARSUS|"
        "TATVAN|TAVSANLI|TEKIRDAG|TOKAT|TORBALI|TRABZON|TURGUTLU|TURHAL|UEMRANIYE|UENYE|UESKUEDAR|UMRANIYE|UNYE|"
        "URLA|USAK|USKUDAR|VIRANSEHIR|YALOVA|YOZGAT|YUEKSEKOVA|YUKSEKOVA|ZEYTINBURNU|ZILE|ZONGULDAK"
    ),
    "TT": "CHAGUANAS|MON REPOS|SAN FERNANDO",
    "TW": (
        "BADE|BANQIAO|CAOTUN|CHANG HUA|CHANGHUA|CHAOZHOU|CHIAYI CITY|DANSHUI|DAXI|DOULIU|FENGSHAN|HSINCHU|"
        "HUALIEN CITY|KAOHSIUNG|KEELUNG|MAGONG|MIAOLI|NANTOU|NEIHU|NEILI|NEW TAIPEI|NEW TAIPEI CITY|PULI|SANXIA|"
        "SHULIN|TAICHUNG|TAINAN|TAIPEI|TAITUNG|TAOYUAN|TOUFEN|WUFENG|XIHU|XINYING|XIZHI|YILAN|YINGGE|YONGKANG|"
        "YUANLIN|ZHUBEI|ZHUDONG"
    ),
    "TZ": (
        "ARUSHA|BABATI|BAGAMOYO|BARIADI|BUKOBA|BUNDA|BUSERESERE|CHAKE CHAKE|DAR ES SALAAM|DODOMA|GEITA|HANDENI|"
        "IFAKARA|IRINGA|KAHAMA|KASULU|KATORO|KATUMBA|KIBAHA|KIBAIGWA|KIGOMA|KILOSA|KONDOA|KOROGWE|LINDI|MAFINGA|"
        "MAKUMBAKO|MASASI|MASUMBWE|MBEYA|MBINGA|MERELANI|MOROGORO|MOSHI|MPANDA|MTWARA|MUSOMA|MWANZA|NJOMBE|NZEGA|"
        "SENGEREMA|SHINYANGA|SINGIDA|SONGEA|SUMBAWANGA|TABORA|TANGA|TARIME|TUKUYU|TUNDUMA|USHIROMBO|UTENGULE|"
        "UYOVU|VIKINDU|VWAWA|ZANZIBAR"
    ),
    "UA": (
        "ALCHEVSK|ANTRATSYT|AVTOZAVODSKYI|BAKHMUT|BERDYANSK|BERDYCHIV|BERESTOVSKYI|BILA TSERKVA|BOHODUKHIVSKYI|"
        "BOHUNIYA|BORSHCHAHIVKA|BORYSPIL|BOSSE|BROVARY|CHEREMUSHKY|CHERKASY|CHERNIHIV|CHERNIVTSI|CHOKOLIVKA|"
        "CHORNOMORSK|CHUMAKIVSKYI|CHYSTYAKOVE|DARNYTSKYI MASYV|DARNYTSYA|DESNA|DESNYANSKYI|DNIPRO|DNIPROVSKYI|"
        "DONETSK|DOVZHANSK|DROHOBYCH|DRUZHKIVKA|ENERHODAR|FEODOSIYA|FORTECHNYI|HIRNYTSKYI|HOLOSIYIV|HORLIVKA|"
        "HRUZKYI|INDUSTRIALNYI|INHULETS|IRPIN|IVANO FRANKIVSK|IZMAYIL|KADIYIVKA|KALMIUSKYI|KALUSH|KALYNIVSKYI|"
        "KAMYANETS PODILSKYI|KAMYANSKE|KERCH|KHANZHONKIVSKYI|KHARKIV|KHARKIVSKYI MASYV|KHARTSYZK|KHERSON|"
        "KHMELNYTSKYI|KHOLODNA HORA|KHRUSTALNYI|KINDRATIVSKYI|KOLOMYIA|KONOTOP|KORABELNA STORONA|KOROLYOV|"
        "KOROSTEN|KOSMICHNYI|KOSTYANTYNIVKA|KOVEL|KOVPAKIVSKYI|KRAMATORSK|KREMENCHUK|KROPYVNYTSKYI|KRYUKIV|"
        "KRYVYY RIH|KYIV|KYIVSKYI|LISOVYI MASYV|LIVOBEREZHNYI|LIVYI BEREH|LOZOVA|LUHANSK|LUTSK|LVIV|LYSYCHANSK|"
        "MAKIYIVKA|MARIUPOL|MELITOPOL|MUKACHEVO|MYKILSKA BORSHCHAHIVKA|MYKOLAYIV|MYKYTIVSKYI|NEMYSHLYANSKYI|"
        "NIKOPOL|NIZHYN|NOVOBAVARSKYI|NOVOZAVODSKYI|NYVKY|NYZHNODNIPROVSK|OBOLON|ODESA|OLEKSANDRIVSKYI|"
        "OLEKSANDRIYA|OLEKSIYIVKA|OSNOVYANSKYI|PAVLOHRAD|PECHERSK|PERVOMAYSK|PIVDENNA BORSHCHAHIVKA|PODILSKYI|"
        "POKROVSK|POLTAVA|POZNIAKY|PRAVYI BEREH|PRYLUKY|PRYMORSKYI|RAYON KHTZ|RIVNE|RUBIZHNE|RUTCHENKIVSKYI|"
        "SALTIVKA|SALTIVSKYI|SAMAR|SEVASTOPOL|SHAKHTARSK|SHEPTYTSKYI|SHEVCHENKIVSKYI|SHEVCHENKO|SHOSTKA|"
        "SHULYAVKA|SIMFEROPOL|SIVERSKODONETSK|SKHIDNI KVARTALY|SLOBIDSKYI|SLOVYANSK|SMILA|SMOLYANSKYI|SNIZHNE|"
        "SOTSMISTO|STRYI|SUMY|SVYATOSHYN|SYKHIV|TEKSTYLNYK|TERNOPIL|TSENTRALNO MISKYI|TSENTRALNYI|UMAN|UZHHOROD|"
        "VERHUNSKYI|VIDRADNYI|VILKHIVSKYI|VINNYTSYA|VOSKRESENKA|VOZNESENSKYI|VYHURIVSHCHYNA TROYESHCHYNA|"
        "VYNOHRADAR|YALTA|YENAKIYEVE|YEVPATORIYA|YUZIVSKYI|ZAPORIZHZHYA|ZARICHNYI|ZHYTOMYR|ZVYAHEL"
    ),
    "UG": (
        "APAC|ARUA|BUNAMWAYA|BUSIA|BWIZIBWERA|ENTEBBE|FORT PORTAL|GULU|HOIMA|IBANDA|IGANGA|JINJA|KABALE|KAJANSI|"
        "KAMPALA|KAMULI|KAPCHORWA|KASANGATI|KASESE|KATABI|KIRA|KITGUM|KOBOKO|KOTIDO|KYENGERA|LIRA|LUGAZI|MASAKA|"
        "MASINDI|MBALE|MBARARA|MITYANA|MPONDWE|MUBENDE|MUKONO|NAKIVALE REFUGEE CAMP|NANSANA|NJERU|RUTOMA|SOROTI|"
        "WAKISO"
    ),
    "US": (
        "ABILENE|ABINGTON|AHWATUKEE FOOTHILLS|AKRON|ALAFAYA|ALAMEDA|ALBANY PARK|ALBUQUERQUE|ALHAMBRA|ALIEF|"
        "ALISO VIEJO|ALLAPATTAH|ALLENTOWN|ALPHARETTA|AMARILLO|AMES|AMHERST|ANAHEIM|ANCHORAGE|ANKENY|ANN ARBOR|"
        "ANTIOCH|APPLE VALLEY|APPLETON|ARCADIA|ARDEN ARCADE|ARLINGTON|ARLINGTON HEIGHTS|ARVADA|ASHEVILLE|ASTORIA|"
        "ATASCOCITA|ATLANTA|AVONDALE|BAKERSFIELD|BALDWIN PARK|BALTIMORE|BARTLETT|BATON ROUGE|BATTLE CREEK|"
        "BAYONNE|BAYSIDE|BAYTOWN|BEAUMONT|BEAVERTON|BELLEVUE|BELLFLOWER|BELLINGHAM|BELMONT CRAGIN|BENSALEM|"
        "BENSONHURST|BERWYN|BETHESDA|BETHLEHEM|BILLINGS|BISMARCK|BLAINE|BLOOMINGTON|BLUE SPRINGS|BOCA RATON|"
        "BOISE|BOLINGBROOK|BONITA SPRINGS|BOROUGH PARK|BOSSIER CITY|BOWLING GREEN|BOYLE HEIGHTS|BOYNTON BEACH|"
        "BRADENTON|BRENTWOOD|BRIARWOOD|BRIDGEPORT|BROCKTON|BROKEN ARROW|BROOKHAVEN|BROOKLINE|BROOKLYN|"
        "BROOKLYN PARK|BROOMFIELD|BROWNSVILLE|BUCKEYE|BUENA PARK|BURBANK|BURIEN|BURNSVILLE|BUSHWICK|CALDWELL|"
        "CAMARILLO|CANARSIE|CANOGA PARK|CANYON COUNTRY|CAPE CORAL|CARLSBAD|CARMEL|CARMICHAEL|CAROL CITY|"
        "CARROLLTON|CARSON CITY|CARY|CASA GRANDE|CASAS ADOBES|CASPER|CASTLE ROCK|CASTRO VALLEY|"
        "CATALINA FOOTHILLS|CATHEDRAL CITY|CEDAR PARK|CEDAR RAPIDS|CELINA|CENTENNIAL|CENTER CITY|CENTRAL CITY|"
        "CENTREVILLE|CHAMPAIGN|CHAPEL HILL|CHARLOTTE|CHATTANOOGA|CHEEKTOWAGA|CHERRY HILL|CHESAPEAKE|CHEYENNE|"
        "CHICAGO|CHICAGO LAWN|CHICO|CHICOPEE|CHINATOWN|CHINO|CHINO HILLS|CHULA VISTA|CICERO|CINCINNATI|"
        "CITRUS HEIGHTS|CITY OF MILFORD BALANCE|CLARKSVILLE|CLEARWATER|CLEVELAND|CLINTON TOWNSHIP|CLOVIS|"
        "COCONUT CREEK|COLLEGE STATION|COLORADO SPRINGS|COLTON|COLUMBUS|COMMERCE CITY|COMPTON|CONCORD|"
        "CONEY ISLAND|CONROE|COON RAPIDS|CORAL GABLES|CORAL SPRINGS|CORDOVA|CORONA|CORPUS CHRISTI|CORVALLIS|"
        "COSTA MESA|COUNCIL BLUFFS|CRANSTON|CUPERTINO|CYPRESS|CYPRESS HILLS|DALE CITY|DALLAS|DALY CITY|DANBURY|"
        "DAVENPORT|DAVIE|DAYTONA BEACH|DEARBORN|DEARBORN HEIGHTS|DECATUR|DEER VALLEY|DEERFIELD BEACH|DELANO|"
        "DELRAY BEACH|DELTONA|DENTON|DENVER|DES MOINES|DES PLAINES|DESOTO|DETROIT|DIAMOND BAR|DORAL|DORCHESTER|"
        "DOTHAN|DOWNEY|DOWNTOWN DC|DUBUQUE|DULUTH|DUNDALK|EAGAN|EAST CHATTANOOGA|EAST FLATBUSH|EAST HAMPTON|"
        "EAST HARLEM|EAST HARTFORD|EAST INDEPENDENCE|EAST LOS ANGELES|EAST NEW YORK|EAST NORWALK|EAST ORANGE|"
        "EAST PENSACOLA HEIGHTS|EAST VILLAGE|EASTVALE|EAU CLAIRE|EDEN PRAIRIE|EDGEWATER|EDINA|EDINBURG|EDMOND|"
        "EL CAJON|EL MONTE|EL PASO|ELGIN|ELK GROVE|ELKHART|ELLICOTT CITY|ELMHURST|ELYRIA|ENCANTO|ENCHANTED HILLS|"
        "ENCINITAS|ENID|ESCONDIDO|EULESS|EVANSTON|EVANSVILLE|FAIRFIELD|FALL RIVER|FARMINGTON HILLS|FAYETTEVILLE|"
        "FEDERAL WAY|FINANCIAL DISTRICT|FISHERS|FLAGAMI|FLAGSTAFF|FLATBUSH|FLATLANDS|FLORENCE GRAHAM|FLORISSANT|"
        "FLOWER MOUND|FOLSOM|FONTANA|FORDHAM|FOREST HILLS|FORT COLLINS|FORT LAUDERDALE|FORT MYERS|FORT SMITH|"
        "FORT WAYNE|FORT WORTH|FOUNTAIN VALLEY|FOUNTAINEBLEAU|FRAMINGHAM|FRAMINGHAM CENTER|FREMONT|FRESNO|FRISCO|"
        "FULLERTON|GAINESVILLE|GAITHERSBURG|GALVESTON|GARDEN GROVE|GARDENA|GARLAND|GASTONIA|GERMANTOWN|GILROY|"
        "GLEN BURNIE|GLENDALE|GLENDORA|GOODYEAR|GRAND FORKS|GRAND ISLAND|GRAND JUNCTION|GRAND PRAIRIE|"
        "GRAND RAPIDS|GRAPEVINE|GRAVESEND|GREAT FALLS|GREELEY|GREEN BAY|GREENBURGH|GREENSBORO|GREENVILLE|"
        "GREENWOOD|GRESHAM|GULFPORT|HACIENDA HEIGHTS|HAMDEN|HANFORD|HARLINGEN|HARRISBURG|HARRISONBURG|HAVERHILL|"
        "HAVERTOWN|HAWTHORNE|HAYWARD|HEMET|HEMPSTEAD|HENDERSONVILLE|HESPERIA|HIALEAH|HIGH POINT|HIGHLANDS RANCH|"
        "HILLSBORO|HOBOKEN|HOFFMAN ESTATES|HOMESTEAD|HONOLULU|HOUSTON|HUNTERSVILLE|HUNTINGTON BEACH|"
        "HUNTINGTON PARK|HUNTSVILLE|IDAHO FALLS|INDIANAPOLIS|INDIO|INGLEWOOD|IOWA CITY|IRONDEQUOIT|IRVING PARK|"
        "IRVINGTON|JACKSON HEIGHTS|JACKSONVILLE|JANESVILLE|JERSEY CITY|JOHNS CREEK|JOHNSON CITY|JOLIET|JONESBORO|"
        "JOPLIN|KALAMAZOO|KANSAS|KANSAS CITY|KENDALE LAKES|KENNER|KENNEWICK|KENOSHA|KENTWOOD|KETTERING|KILLEEN|"
        "KINGS BRIDGE|KINGSPORT|KIRKLAND|KISSIMMEE|KNOXVILLE|KOKOMO|KOREATOWN|LA CROSSE|LA HABRA|LA MESA|"
        "LAGUNA NIGUEL|LAKE CHARLES|LAKE ELSINORE|LAKE FOREST|LAKE HAVASU CITY|LAKELAND|LAKEVILLE|LAKEWOOD|"
        "LANSING|LAREDO|LARGO|LAS CRUCES|LAS VEGAS|LAUDERHILL|LAWTON|LAYTON|LEAGUE CITY|LEANDER|LEES SUMMIT|"
        "LEESBURG|LEHI|LEHIGH ACRES|LENEXA|LEVITTOWN|LEWISVILLE|LEXINGTON|LEXINGTON FAYETTE|LINCOLN PARK|"
        "LITTLE HAVANA|LITTLE ROCK|LIVERMORE|LIVONIA|LODI|LOGAN SQUARE|LONG BEACH|LONGMONT|LONGVIEW|LORAIN|"
        "LOS ANGELES|LOUISVILLE|LOVELAND|LOWELL|LUBBOCK|LYNCHBURG|LYNWOOD|MACON|MADERA|MALDEN|MANHATTAN|"
        "MANSFIELD|MANTECA|MAPLE GROVE|MARGATE|MARIETTA|MARYSVILLE|MARYVALE|MCALLEN|MCKINNEY|MEADS|MEDFORD|"
        "MEMPHIS|MENIFEE|MERCED|MERIDEN|MERIDIAN|MESA|MESQUITE|METAIRIE|METAIRIE TERRACE|METHUEN|MIAMI|"
        "MIAMI BEACH|MIAMI GARDENS|MID CITY|MIDDLETOWN|MIDLAND|MIDWEST CITY|MILFORD|MILLCREEK|MILPITAS|MILWAUKEE|"
        "MINNEAPOLIS|MINNETONKA|MINNETONKA MILLS|MIRA MESA|MIRAMAR|MISSION VIEJO|MISSOULA|MISSOURI CITY|MODESTO|"
        "MONTEBELLO|MONTEREY PARK|MORENO VALLEY|MORNINGSIDE HEIGHTS|MOTT HAVEN|MOUNT PLEASANT|MOUNT PROSPECT|"
        "MOUNT VERNON|MOUNTAIN VIEW|MUNCIE|MURFREESBORO|MURRIETA|NAMPA|NAPA|NAPERVILLE|NASHUA|NASHVILLE|"
        "NATIONAL CITY|NEAR NORTH SIDE|NEW BEDFORD|NEW BRAUNFELS|NEW BRITAIN|NEW BRUNSWICK|NEW HAVEN|NEW ORLEANS|"
        "NEW ROCHELLE|NEW SOUTH MEMPHIS|NEW YORK|NEW YORK CITY|NEWPORT BEACH|NEWPORT NEWS|NOBLESVILLE|"
        "NORTH BERGEN|NORTH CHARLESTON|NORTH CHICOPEE|NORTH HILLS|NORTH HOLLYWOOD|NORTH LA CROSSE|"
        "NORTH LAS VEGAS|NORTH LITTLE ROCK|NORTH MIAMI|NORTH PEORIA|NORTH PORT|NORTH RICHLAND HILLS|"
        "NORTH STAMFORD|NORTHRIDGE|NORWALK|NOVATO|NOVI|OAK LAWN|OAK PARK|OAKLAND|OCALA|OCEANSIDE|ODESSA|OFALLON|"
        "OGDEN|OKLAHOMA|OKLAHOMA CITY|OLATHE|OLYMPIA|OMAHA|OREM|ORLAND PARK|ORLANDO|OSHKOSH|OVERLAND PARK|"
        "OWENSBORO|OXNARD|OZONE PARK|PALATINE|PALM BAY|PALM BEACH GARDENS|PALM COAST|PALM DESERT|PALM HARBOR|"
        "PALMDALE|PALO ALTO|PARK SLOPE|PARKCHESTER|PARMA|PARSIPPANY|PASADENA|PASCO|PASSAIC|PATERSON|PAWTUCKET|"
        "PEABODY|PEARLAND|PEMBROKE PINES|PENSACOLA|PEORIA|PERRIS|PERTH AMBOY|PETALUMA|PFLUGERVILLE|PHARR|"
        "PHILADELPHIA|PICO RIVERA|PINE HILLS|PINELLAS PARK|PISCATAWAY|PITTSBURG|PITTSBURGH|PLACENTIA|PLAINFIELD|"
        "PLANO|PLEASANTON|POCATELLO|POINCIANA|POMONA|POMPANO BEACH|PONTIAC|PORT ARTHUR|PORT CHARLOTTE|"
        "PORT ORANGE|PORT SAINT LUCIE|PORTAGE PARK|PORTERVILLE|PORTLAND|PORTSMOUTH HEIGHTS|POWAY|PROVO|PUEBLO|"
        "QUEENS|QUEENS VILLAGE|QUINCY|RACINE|RALEIGH|RANCHO CORDOVA|RANCHO CUCAMONGA|RANCHO PENASQUITOS|"
        "RAPID CITY|REDDING|REDLANDS|REDMOND|REDONDO BEACH|REDWOOD CITY|RENTON|RESEDA|RESTON|REVERE|RIALTO|"
        "RICHLAND|RICHMOND HILL|RIDGEWOOD|RIO RANCHO|RIVERSIDE|RIVERVIEW|ROANOKE|ROCHESTER HILLS|ROCK HILL|"
        "ROCKFORD|ROCKLIN|ROCKVILLE|ROCKY MOUNT|ROGERS PARK|ROSEMEAD|ROSEVILLE|ROSWELL|ROUND ROCK|ROWLETT|"
        "ROYAL OAK|SACRAMENTO|SAINT CHARLES|SAINT CLAIR SHORES|SAINT CLOUD|SAINT GEORGE|SAINT JOSEPH|SAINT PAUL|"
        "SAINT PETERS|SALINAS|SALT LAKE CITY|SAMMAMISH|SAN ANGELO|SAN ANTONIO|SAN BERNARDINO|SAN CLEMENTE|"
        "SAN DIEGO|SAN FRANCISCO|SAN JOSE|SAN LEANDRO|SAN MARCOS|SAN MATEO|SAN PEDRO|SAN RAFAEL|SAN RAMON|"
        "SAN TAN VALLEY|SANDY HILLS|SANDY SPRINGS|SANFORD|SANTA ANA|SANTA BARBARA|SANTA CLARA|SANTA CLARITA|"
        "SANTA CRUZ|SANTA FE|SANTA MARIA|SANTA MONICA|SANTA ROSA|SANTEE|SARASOTA|SCHAUMBURG|SCHENECTADY|"
        "SCOTTSDALE|SCRANTON|SEATTLE|SHAWNEE|SHEEPSHEAD BAY|SHERMAN OAKS|SHORELINE|SHREVEPORT|SILVER SPRING|"
        "SIMI VALLEY|SIOUX CITY|SIOUX FALLS|SKOKIE|SMYRNA|SOMERVILLE|SOUTH BEND|SOUTH BOSTON|SOUTH FULTON|"
        "SOUTH GATE|SOUTH HILL|SOUTH JORDAN|SOUTH LAWNDALE|SOUTH OZONE PARK|SOUTH PEABODY|SOUTH SAN FRANCISCO|"
        "SOUTH SHORE|SOUTH SUFFOLK|SOUTH VINELAND|SOUTH WHITTIER|SOUTHAVEN|SOUTHFIELD|SPOKANE|SPOKANE VALLEY|"
        "SPRING HILL|SPRING VALLEY|SPRINGDALE|ST LOUIS|ST PETERSBURG|STAMFORD|STATEN ISLAND|STERLING HEIGHTS|"
        "STOCKTON|STONECREST|STRATFORD|SUGAR LAND|SUNNYVALE|SUNRISE MANOR|SUNSET PARK|SYLMAR|TACOMA|TALLAHASSEE|"
        "TAMARAC|TAMIAMI|TAMPA|TAUNTON|TAYLORSVILLE|TEMECULA|TEMPE|TEMPE JUNCTION|TERRE HAUTE|THE BRONX|"
        "THE HAMMOCKS|THE TRAILS OF FRISCO|THE VILLAGES|THE WOODLANDS|THOUSAND OAKS|TIGARD|TINLEY PARK|"
        "TOMS RIVER|TOPEKA|TORRANCE|TOWN N COUNTRY|TOWSON|TRENTON|TRI CITIES|TUCSON|TULARE|TULSA|TURLOCK|"
        "TUSCALOOSA|TUSTIN|UNION CITY|UNIVERSAL CITY|UNIVERSITY OF TEXAS|UPLAND|UPPER WEST SIDE|UPTOWN|UTICA|"
        "VACAVILLE|VALDOSTA|VALLEJO|VALLEY GLEN|VAN NUYS|VENTURA|VICTORVILLE|VINELAND|VIRGINIA BEACH|VISALIA|"
        "WACO|WAKEFIELD|WALDORF|WALNUT CREEK|WALTHAM|WARNER ROBINS|WASHINGTON|WASHINGTON HEIGHTS|WATERBURY|"
        "WATERFORD|WATSONVILLE|WAUKEGAN|WAUKESHA|WEST ALBANY|WEST ALLIS|WEST BLOOMFIELD TOWNSHIP|"
        "WEST COON RAPIDS|WEST COVINA|WEST DES MOINES|WEST GULFPORT|WEST HARTFORD|WEST HAVEN|WEST HOLLYWOOD|"
        "WEST JORDAN|WEST LYNCHBURG|WEST NEW YORK|WEST PALM BEACH|WEST RALEIGH|WEST RIDGE|WEST SACRAMENTO|"
        "WEST TOWN|WEST VALLEY CITY|WESTLAND|WESTON|WEYMOUTH|WHEATON|WHITE PLAINS|WHITTIER|WICHITA|WICHITA FALLS|"
        "WILMINGTON|WINSTON SALEM|WOODBURY|WOODLAND HILLS|YAKIMA|YONKERS|YORBA LINDA|YOUNGSTOWN|YUBA CITY|"
        "YUCAIPA|YUMA"
    ),
    "UY": "LAS PIEDRAS|MALDONADO|MELO|MONTEVIDEO|PAYSANDU|RIVERA|SALTO|TACUAREMBO",
    "UZ": (
        "ANDIJON|ANGREN|ASAKA|BEKOBOD|BERUNIY|BESHARIQ|BUKHARA|CHILANZAR|CHIRCHIQ|CHORTOQ|CHUST|DENOV|FERGANA|"
        "GULISTON|GURLAN|JIZZAX|KATTAQORGON SHAHRI|KOGON SHAHRI|KOSON|KOSONSOY|MARGILON|NAMANGAN|NAVOIY|NUKUS|"
        "OLMALIQ|OLTINKOL|PARKENT|QARSHI|QOQON|QUNGHIROT|QUVASOY|SAMARKAND|SERGELI|SHAHRISABZ|SHAHRIXON|TASHKENT|"
        "TIRMIZ|TUYTEPA|URGANCH|URGUT SHAHRI|XIVA|XOJAYLI SHAHRI|YANGIYUL|YUNUSOBOD"
    ),
    "VE": (
        "ACARIGUA|ALTAGRACIA DE ORITUCO|ALTO BARINAS|ANACO|ARAURE|BARCELONA|BARINAS|BARINITAS|BARQUISIMETO|"
        "BARUTA|BIRUACA|BOCONO|CABIMAS|CABUDARE|CAGUA|CAICARA DEL ORINOCO|CALABOZO|CANTAURA|CARACAS|CARORA|"
        "CARUPANO|CATIA LA MAR|CAUCAGUEITO|CAUCAGUITO|CHACAO|CHARALLAVE|CHIVACOA|CIUDAD BOLIVAR|CIUDAD BOLIVIA|"
        "CIUDAD GUAYANA|CIUDAD OJEDA|CIUDAD PIAR|COCOROTE|CONCEPCION|CORO|CUMANA|EJIDO|EL CAFETAL|EL HATILLO|"
        "EL LIMON|EL TIGRE|EL TOCUYO|EL VIGIA|GUACARA|GUANARE|GUARENAS|GUASDUALITO|GUATIRE|GUEIGUEE|GUIGUE|"
        "LA CONCEPCION|LA DOLORITA|LA FRIA|LA VICTORIA|LA VILLA DEL ROSARIO|LANDER|LOS DOS CAMINOS|"
        "LOS PUERTOS DE ALTAGRACIA|LOS RASTROJOS|LOS TEQUES|MACHIQUES|MAIQUETIA|MARACAIBO|MARACAY|MARIARA|"
        "MATURIN|MENE GRANDE|MERIDA|NIRGUA|OCUMARE DEL TUY|PALO NEGRO|PAMPAN|PAMPATAR|PETARE|PORLAMAR|"
        "PUERTO AYACUCHO|PUERTO CABELLO|PUERTO LA CRUZ|PUNTA CARDON|PUNTA DE MATA|PUNTO FIJO|QUIBOR|RUBIO|"
        "SAN ANTONIO DE LOS ALTOS|SAN ANTONIO DEL TACHIRA|SAN CARLOS|SAN CARLOS DEL ZULIA|SAN CRISTOBAL|"
        "SAN FELIPE|SAN FERNANDO DE APURE|SAN JOAQUIN|SAN JOSE DE GUANIPA|SAN JOSECITO|SAN JUAN BAUTISTA|"
        "SAN JUAN DE LOS MORROS|SAN MATEO|SAN RAFAEL|SAN TIMOTEO|SANTA CRUZ DE MARA|SANTA TERESA DEL TUY|SOCOPO|"
        "TACARIGUA|TARIBA|TINAQUILLO|TRUJILLO|TUCUPITA|TURMERO|UPATA|URENA|VALENCIA|VALERA|VALLE DE LA PASCUA|"
        "VILLA BRUZUAL|VILLA DE CURA|YARITAGUA|ZARAZA"
    ),
    "VI": "SAINT CROIX",
    "VN": (
        "A LAT|AN HAI|AN KHE|AN NHON|BA DINH|BA GJON|BA ON|BA VI|BAC GIANG|BAC LIEU|BAC NINH|BAC QUANG|"
        "BAC TU LIEM|BACH MAI|BAO LOC|BEN CAT|BEN TRE|BIEN HOA|BIM SON|BINH MINH|BINH THANH|BINH THUY|BO E|"
        "BO GJE|BUON HO|BUON MA THUOT|CA MAU|CAI LAY|CAI RANG|CAM LE|CAM PHA|CAM PHA MINES|CAM RANH|CAN GIO|"
        "CAN GIUOC|CAN GJUOC|CAN THO|CAN UOC|CAO BANG|CAO LANH|CAU GIAY|CHAU GJOC|CHAU OC|CHAU PHONG|CHI LINH|"
        "CHO LON|CHON THANH|CO GJO|CO O|CU CHI|CUA NAM|CUNG KIEM|DA LAT|DA NANG|DAI MO|DI AN|DIEN BIEN PHU|"
        "DONG HA|DUONG NOI|DUYEN HAI|GIA LAM|GIA NGHIA|GIA RAI|GIANG VO|GJIEN BAN|GJINH CONG|GJO SON|GJONG GJA|"
        "GJONG HOI|GJONG NGAC|GJONG XOAI|GJUC PHO|GJUC TRONG|GO CONG|GO VAP|HA GIANG|HA GJONG|HA LONG|HA ONG|"
        "HA TIEN|HA TINH|HAI BA TRUNG|HAI CHAU|HAI DUONG|HAIPHONG|HANOI|HO CHI MINH|HO CHI MINH CITY|HOA BINH|"
        "HOA CUONG|HOA LU|HOA THANH|HOAN KIEM|HOANG LIET|HOANG MAI|HONG NGU|HUNG YEN|HUONG THUY|HUONG TRA|"
        "HUYEN LAM HA|IEN BAN|INH CONG|KHUONG GJINH|KHUONG INH|KIEN AN|KIEN HUNG|KON TUM|KY ANH|LA GI|LAI VUNG|"
        "LANG SON|LAO CAI|LINH AM|LINH GJAM|LONG BIEN|LONG KHANH|LONG MY|LONG XUYEN|MONG CAI|MUI NE|MY HAO|"
        "MY THO|NAM GJINH|NAM INH|NGA BAY|NGA NAM|NGHI SON|NGHIA GJO|NGHIA LO|NGHIA O|NHA TRANG|NINH HOA|"
        "NUI THANH|O MON|O SON|ONG A|ONG HA|ONG HOI|ONG NGAC|ONG XOAI|PHAN RANG THAP CHAM|PHAN THIET|PHO YEN|"
        "PHONG GJIEN|PHONG IEN|PHONG THANH|PHU LY|PHU MY|PHU QUOC|PHU THO|PHUC LOI|PHUC YEN|PLEIKU|QUAN BA|"
        "QUAN BON|QUAN GJUC THINH|QUAN MUOI|QUAN MUOI MOT|QUAN NAM|QUAN SAU|QUAN UC THINH|QUANG NGAI|QUI NHON|"
        "RACH GIA|SA DEC|SAM SON|SOC SON|SOC TRANG|SON LA|SON TAY|SON TRA|SONG CAU|TAM KY|TAN AN|TAN BINH|"
        "TAN CHAU|TAN UYEN|TAY HO|TAY NINH|THAI BINH|THAI HOA|THAI NGUYEN|THANH HOA|THANH KHE|THANH LIET|"
        "THANH PHO BA RIA|THANH PHO SONG CONG|THANH PHO UONG BI|THANH XUAN|THI TRAN AI TU|THI TRAN GJAI TU|"
        "THI TRAN GJONG TRIEU|THI TRAN MAO KHE|THI TRAN ONG TRIEU|THI TRAN PHUOC BUU|THI TRAN THUAN CHAU|"
        "THOI LAI|THOT NOT|THU DAU MOT|THU GJUC|THU UC|THUAN AN|THUAN THANH|THUONG CAT|TINH BIEN|TRA VINH|"
        "TRAN VAN THOI|TRANG BANG|TRANG BOM|TU SON|TUONG MAI|TUY HOA|TUYEN QUANG|UC PHO|UC TRONG|VIET TRI|"
        "VIET YEN|VINH|VINH CHAU|VINH LONG|VINH THANH|VINH TUY|VINH YEN|VINHOMES OCEAN PARK|VINHOMES SMART CITY|"
        "VINHOMES TIMES CITY|VUNG TAU|XOM CAI NUOC|XUAN LOC|YEN BAI|YEN HOA|YEN VINH"
    ),
    "XK": "DECAN|FERIZAJ|GJAKOVE|GJILAN|GLOGOVAC|MITROVICE|PRISTINA|PRIZREN|SUVA REKA",
    "YE": "ADEN|AL HUDAYDAH|AMRAN|DHAMAR|MUKALLA|SADAH|SANAA|SAYYAN|TAIZ|ZABID", "YT": "MAMOUDZOU",
    "ZA": (
        "ALBERTON|ATHLONE|ATLANTIS|BARBERTON|BELA BELA|BENONI|BETHAL|BETHLEHEM|BHISHO|BLOEMFONTEIN|BOKSBURG|"
        "BOTHAVILLE|BOTSHABELO|BRAKPAN|BUTTERWORTH|CAPE TOWN|CARLETONVILLE|CENTURION|DELMAS|DIEPSLOOT|DURBAN|"
        "DURBANVILLE|EAST LONDON|EKANGALA|EMALAHLENI|EMBALENHLE|ERMELO|ETWATWA|EVATON|FOCHVILLE|FORT BEAUFORT|"
        "GA RANKUWA|GERMISTON|GQEBERHA|GRAAFF REINET|GRAHAMSTOWN|HAMMANSKRAAL|HEIDELBERG|HERMANUS|IVORY PARK|"
        "JOHANNESBURG|KARIEGA|KIMBERLEY|KLERKSDORP|KNYSNA|KOKSTAD|KRAAIFONTEIN|KROONSTAD|KRUGERSDORP|KUTLOANONG|"
        "KWADUKUZA|KWAGGAFONTEIN|LADYSMITH|LICHTENBURG|LOUIS TRICHARDT|MABOPANE|MAFIKENG|MBOMBELA|MDANTSANE|"
        "MIDDELBURG|MIDRAND|MMABATHO|MODIMOLLE|MOKOPANE|MONDLO|MOSSEL BAY|MPUMALANGA|MTHATHA|MUSINA|NEWCASTLE|"
        "NKOWAKOWA|NTUZUMA|ODENDAALSRUS|ORKNEY|OUDTSHOORN|PAARL|PARYS|PHALABORWA|PHUTHADITJHABA|PIET RETIEF|"
        "PIETERMARITZBURG|PINETOWN|POLOKWANE|PORT SHEPSTONE|POTCHEFSTROOM|PRETORIA|QONCE|QUEENSTOWN|RANDBURG|"
        "RANDFONTEIN|RICHARDS BAY|ROODEPOORT|RUSTENBURG|SALDANHA|SASOLBURG|SCHWEIZER RENEKE|SOMAROBORO|"
        "SOMERSET WEST|SOSHANGUVE|SOWETO|STANDERTON|STELLENBOSCH|STILFONTEIN|THABA NCHU|THEMBISA|THOHOYANDOU|"
        "TOKOZA|TONGAAT|TRICHARDT|UPINGTON|VANDERBIJLPARK|VEREENIGING|VILJOENSKROON|VRYBURG|VRYHEID|WELKOM|"
        "WESTONARIA"
    ),
    "ZM": (
        "CHILANGA TOWNSHIP|CHILILABOMBWE|CHINGOLA|CHIPATA|CHOMA|CHONGWE|CHUNGA|KABWE|KAFUE|KALULUSHI|"
        "KAPIRI MPOSHI|KASAMA|KITWE|LIVINGSTONE|LUANSHYA|LUSAKA|MADIDO|MANSA|MAZABUKA|MONGU|MONZE|MPIKA|MPULUNGU|"
        "MUFULIRA|NAKONDE|NAMALOMBWE|NCHELENGE|NDOLA|PETAUKE|SAMFYA|SOLWEZI"
    ),
    "ZW": (
        "BEITBRIDGE|BINDURA|BULAWAYO|CHEGUTU|CHINHOYI|CHITUNGWIZA|EPWORTH|GWERU|HARARE|KADOMA|KWEKWE|MARONDERA|"
        "MASVINGO|MUTARE|RUWA|ZVISHAVANE"
    ),
}

# packages/core/src/explain.ts
THE = re.compile(
    r"^(United |Netherlands\Z|Philippines\Z|Bahamas\Z|Gambia\Z|Maldives\Z|Comoros\Z|Dominican Republic\Z"
    r"|Central African Republic\Z|Isle of Man\Z|Holy See|Vatican)|Islands\Z",
    re.A,
)
ROLE = {"brand_of": "Brand", "operator": "Run in the UK by", "owned_by": "Owned by", "ultimate_parent": "Top owner"}
PAID_THROUGH = {
    "PAYPAL": "PayPal", "PP": "PayPal", "GOOGLE": "Google Play", "CRV": "Curve", "SQ": "Square", "SUMUP": "SumUp",
    "ZETTLE": "Zettle", "ZETTLE_": "Zettle", "IZETTLE": "Zettle", "IZ": "Zettle",
    "SP": "an online shop's payment service", "TST": "Toast", "KLARNA": "Klarna", "CLEARPAY": "Clearpay",
    "BT": "Braintree (PayPal's card payments)",
}

# packages/core/src/quick-lookup.ts
MAX_QUERY = 140
TO_SOMEONE = re.compile(
    r"\b(?:TRANSFER|TFR|PAYMENT|PAYMENTS|PAYMT|PYMT|SENT|BACS|FPS|FPO|FPI|STO|ORDER)\s+(?:TO|FROM)\s+(.+)\Z",
    re.A,
)

# apps/site/site.config.json
LOOKUP_URL = "https://cxvwngmnkxtweuwaxfmz.supabase.co/functions/v1/kys-lookup"
LOOKUP_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN4dnduZ21ua3h0d2V1d2F4Zm16Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5ODg2MzgsImV4cCI6MjA5MDU2NDYzOH0.707IwxJpvRl_ffzp7Jpfro7LrAJJ5h_bvv77YC5avgc"
)

# packages/statement/src/parse.ts
MAX_FIELD_LENGTH = 256
HEADER_SCAN_ROWS = 20
OPENING_BALANCE = re.compile(
    r"^(?:opening|closing|start(?:ing)?|end(?:ing)?) balance\Z|^balance (?:brought|carried) forward\Z|^(?:brought"
    r"|carried) forward\Z",
    re.A | re.I,
)

# packages/statement/src/values.ts
SYMBOLS = {"\xa3": "GBP", "\u20ac": "EUR", "$": "USD"}

# ============================================== end of generated tables ============================================

if __name__ == "__main__":
    sys.exit(main())

# MIT License
#
# Copyright (c) 2026 the KnowYourSpend authors
#
# Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
# documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
# rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
# permit persons to whom the Software is furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
# Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
# WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
# COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
# OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
#
# The KnowYourSpend name and logo are not covered by this licence. The ownership data this script downloads is built
# from OpenStreetMap's name-suggestion-index (BSD-3-Clause), Wikidata (CC0), GLEIF (CC0) and Companies House (Open
# Government Licence v3.0). The town and city names in the tables above are from GeoNames (https://www.geonames.org),
# CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), reduced to names and country codes. See open-source/NOTICE
# in the source code for the full terms.
