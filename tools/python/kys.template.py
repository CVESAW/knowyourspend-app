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


# @@GENERATED_TABLES@@

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
