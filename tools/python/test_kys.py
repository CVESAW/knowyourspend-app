"""Tests for dist/kys.py (standard library only):  python3 -m unittest discover -s tools/python -v

1. Parity: every case in vectors.json (made by vectors.ts from the TypeScript engine) must give the same answer here.
   KYS_VECTORS=path uses another vectors file (CI writes a fresh one); KYS_TEST_DATA=folder another data folder
   (default: packages/ownership/data in this repository, the files the vectors were made from).
2. Reading statements: guessing columns, amounts, the summary.
3. data update, against a local web server with a made-up manifest.
4. --online, against a local mock of the look-up API: what's sent (only names), answers, 429 and errors.
"""

import contextlib
import hashlib
import http.server
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(HERE, "dist"))

import kys  # noqa: E402  (dist/kys.py, the file people download)

DATA = os.environ.get("KYS_TEST_DATA") or os.path.join(REPO, "packages", "ownership", "data")
VECTORS = os.environ.get("KYS_VECTORS") or os.path.join(HERE, "vectors.json")
_engine = None


def engine():
    global _engine
    if _engine is None:
        _engine = kys.Engine(kys.load_data(DATA))
    return _engine


def resolution(r):
    """A match_local/resolve answer in the shape vectors.ts writes."""
    o = {"status": r["status"], "via": r["via"]}
    for k_py, k_ts in (("reason", "reason"), ("method", "method"), ("matched_alias", "alias"), ("cleaned", "cleaned")):
        if r.get(k_py) is not None:
            o[k_ts] = r[k_py]
    if r.get("entry"):
        o["id"] = r["entry"]["id"]
    return {k: o[k] for k in ("status", "via", "reason", "id", "method", "alias", "cleaned") if k in o}


def ordered(d):
    return {k: d[k] for k in ("status", "via", "reason", "id", "method", "alias", "cleaned") if k in d} if isinstance(d, dict) else d


class Parity(unittest.TestCase):
    """The Python port gives exactly the TypeScript engine's answers."""

    @classmethod
    def setUpClass(cls):
        with open(VECTORS, encoding="utf-8") as f:
            cls.v = json.load(f)

    def check(self, cases, compute, label):
        bad = []
        for case in cases:
            try:
                got = compute(case)
            except Exception as e:  # report, don't stop at the first
                got = {"error": repr(e)}
            want = {k: case[k] for k in got if k in case} if isinstance(got, dict) and "error" not in got else case
            if got != want:
                diff = {k: (want.get(k), got.get(k)) for k in set(want) | set(got) if want.get(k) != got.get(k)} if isinstance(got, dict) else got
                bad.append((case.get("input", case.get("row")), case.get("country"), diff))
        if bad:
            lines = ["%d of %d %s differ from the TypeScript engine:" % (len(bad), len(cases), label)]
            for inp, country, diff in bad[:40]:
                lines.append("  %r [%s]" % (inp, country))
                for k, (want, got) in sorted(diff.items()) if isinstance(diff, dict) else [("?", (None, diff))]:
                    lines.append("      %s: want %r, got %r" % (k, want, got))
            self.fail("\n".join(lines))

    def test_meta(self):
        e = engine()
        self.assertEqual({"entries": len(e.entries), "aliases": e.resolver.size()["aliases"], "open_brands": len(e.open_brands)}, self.v["meta"])

    def test_payees(self):
        e = engine()

        def compute(c):
            text, country = c["input"], c["country"]
            q = kys.read_query(text, country)
            m = kys.match_local(e.resolver, q["name"], q["text"], q["text"], q["home"])
            person = {"text": kys.looks_like_person(q["text"]), "name": kys.looks_like_person(q["name"]), "maybe": kys.may_be_person(q["text"])}
            reader = kys.card_reader(text)
            where = e.locator.locate([q["text"], q["text"]], q["home"])
            look = kys.look_up_locally(e, text, country)  # what `kys.py lookup` says, against the website's lookUpLocally
            return {
                "text": q["text"], "name": q["name"], "norm": kys.normalise_payee(text), "sensitive": kys.sensitive_category(q["name"]),
                "person": person, "card_reader": reader["prefix"] if reader else None, "domains": kys.domains_in(text),
                "match": resolution(m), "resolve": resolution(e.resolver.resolve(text, country)),
                "where": {"country": where["country"], "evidence": where["evidence"], "clue": where.get("clue")},
                "status": look["status"],
                "owner": look["brand"] if look["status"] == "owner" else None,
                "line": look["why"] if look["status"] in ("not_shop", "person", "sensitive") else None,
            }

        cases = [dict(c, match=ordered(c["match"]), resolve=ordered(c["resolve"])) for c in self.v["payees"]]
        self.check(cases, compute, "payees")

    def test_rows(self):
        e = engine()

        def compute(c):
            r = c["row"]
            amount = r["amount"] if r["amount"] is not None else float("nan")
            kind = kys.classify(amount, r["rawPayee"], r.get("rawDescription"), r.get("typeLabel"))
            norm = kys.normalise_payee(r["rawPayee"]) or (kys.normalise_payee(r["rawDescription"]) if r.get("rawDescription") else "")
            spendish = kind in ("spend", "refund")
            mbp = kys.may_be_person(r["rawPayee"], r.get("rawDescription"), r.get("typeLabel"))
            held = kys.is_sensitive(norm) or (r.get("rawDescription") is not None and kys.is_sensitive(kys.normalise_payee(r["rawDescription"]))) or (spendish and mbp)
            where = e.locator.locate([r.get("rawDescription"), r["rawPayee"]], "GB")["country"]
            match = resolution(kys.match_local(e.resolver, norm, r["rawPayee"], r.get("rawDescription"), where)) if spendish and norm else None
            return {"row": r, "type_hint": kys.type_hint(r.get("typeLabel")), "kind": kind, "may_be_person": mbp, "norm": norm, "held": held,
                    "where": where, "match": match}

        cases = [dict(c, match=ordered(c["match"])) for c in self.v["rows"]]
        self.check(cases, compute, "rows")

    def test_amounts(self):
        def compute(c):
            a = kys.parse_amount(c["input"])
            return {"input": c["input"], "value": a["value"] if a else None, "currency": a["currency"] if a else None, "marked": a["marked"] if a else None}

        self.check(self.v["amounts"], compute, "amounts")

    def test_type_hints(self):
        self.check(self.v["type_hints"], lambda c: {"input": c["input"], "hint": kys.type_hint(c["input"])}, "type labels")

    def test_entries(self):
        e = engine()
        by_id = {x["id"]: x for x in e.entries}

        def compute(c):
            x = by_id.get(c["id"])
            if x is None:
                return {"id": c["id"], "missing": True}
            return {
                "id": x["id"], "display_name": x["display_name"], "kind": x["kind"], "owner_country": x["owner_country"], "tier": x["tier"],
                "as_of": x["as_of"], "category": x.get("category"), "trades_in": x.get("trades_in"), "intermediary": x.get("intermediary"),
                "chain": [[h["name"], h["relation"], h["country"]] for h in x["chain"]],
                "sources": [[s["label"], s["url"]] for s in x.get("sources") or []],
                "how": list(kys.how_we_know(x)), "headline": kys.headline(x, e.countries),
                "roles": [[h["name"], h["country"], h["role"]] for h in kys.chain_of(x)],
            }

        self.check(self.v["entries"], compute, "entries")

    def test_online_answers_are_labelled_as_the_app_labels_them(self):
        e = engine()

        def compute(c):
            x = kys._online_entry(c["entry"], "OBSCURE WIDGETS")
            return {"entry": c["entry"], "how": list(kys.how_we_know(x)), "headline": kys.headline(x, e.countries),
                    "roles": [[h["name"], h["country"], h["role"]] for h in kys.chain_of(x)]}

        self.check(self.v["online_entries"], compute, "online answers")

    def test_online_answers_are_read_as_the_website_reads_them(self):
        e = engine()

        def compute(c):
            r = kys.online_result(e, c["answer"], c["name"], paused=c["ai"] is False)
            owner = r["status"] == "owner"
            return {"answer": c["answer"], "ai": c["ai"], "name": c["name"], "status": r["status"], "brand": r["brand"] if owner else None,
                    "headline": r["headline"] if owner else None, "reason": r.get("note") if owner else r.get("why")}

        self.check(self.v["online_answers"], compute, "online answers")

    def test_the_examples(self):
        e = engine()
        for text, status in [("BANK TRANSFER TO DAVID JONES", "person"), ("CASH WITHDRAWAL", "not_shop"), ("VANGUARD ISA", "not_shop"),
                             ("PAYPAL *JOHNSMITH", "person"), ("FASTER PAYMENT TO JOHN SMITH REF RENT", "person"), ("MARIE STOPES", "sensitive")]:
            self.assertEqual(kys.look_up_locally(e, text, "GB")["status"], status, text)
            self.assertIn({"input": text, "country": "GB", "status": status}, [{k: c[k] for k in ("input", "country", "status")} for c in self.v["payees"]])


# ── Helpers for the tests below ──────────────────────────────────────────────────────────────────────────────────────

class TempDir(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kys-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def file(self, name, text, encoding="utf-8"):
        path = os.path.join(self.tmp, name)
        with open(path, "w", encoding=encoding, newline="") as f:
            f.write(text)
        return path


def run(argv, env=None, stdin_tty=False, answer=None):
    """Run kys.main(argv); returns (exit code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    patches = [mock.patch.dict(os.environ, env or {}), mock.patch("kys.time.sleep", lambda s: None),
               # the list is the same every time: build it once (Parity and DataUpdate test the building)
               mock.patch("kys._engine", lambda args: engine() if args.data == DATA else kys.Engine(kys.load_data(args.data)))]
    stdin = mock.MagicMock()
    stdin.isatty.return_value = stdin_tty
    patches.append(mock.patch("kys.sys.stdin", stdin))
    if answer is not None:
        patches.append(mock.patch("builtins.input", lambda prompt="": answer))
    with contextlib.ExitStack() as stack:
        for p in patches:
            stack.enter_context(p)
        stack.enter_context(contextlib.redirect_stdout(out))
        stack.enter_context(contextlib.redirect_stderr(err))
        code = kys.main(argv)
    return code, out.getvalue(), err.getvalue()


class Server:
    """A tiny web server on 127.0.0.1 in a thread; handler(request) -> (status, headers, body bytes)."""

    def __init__(self, handler):
        self.requests = []
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def _serve(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n) if n else b""
                req = {"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body}
                outer.requests.append(req)
                status, headers, data = handler(req)
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = _serve

            def log_message(self, *args):
                pass

        class Quiet(http.server.ThreadingHTTPServer):
            def handle_error(self, request, client_address):
                pass  # a client that gave up waiting (the time-out test) isn't worth a traceback

        self.httpd = Quiet(("127.0.0.1", 0), H)
        self.url = "http://127.0.0.1:%d" % self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def json_reply(obj, status=200, headers=None):
    return status, dict({"Content-Type": "application/json"}, **(headers or {})), json.dumps(obj).encode("utf-8")


# ── 2. Reading statements ────────────────────────────────────────────────────────────────────────────────────────────

class ReadingStatements(TempDir):
    def read(self, text, **kw):
        return kys.read_statement(self.file("s.csv", text), **kw)

    def test_monzo_style_payee_description_money_out_and_in(self):
        rows, info = self.read(
            "Transaction ID,Date,Type,Name,Category,Amount,Currency,Description,Money Out,Money In\n"
            "tx1,01/03/2025,Card payment,Costa Coffee,Eating out,-3.40,GBP,COSTA COFFEE 43012 LONDON GBR,-3.40,\n"
            "tx2,02/03/2025,Card payment,Amazon,Shopping,23.99,GBP,AMAZON.CO.UK*AB12CD34E,,23.99\n")
        c = info["columns"]
        self.assertEqual((c["payee"], c["description"], c["out"], c["in"], c["type"], c["currency"], c["amount"]),
                         ("Name", "Description", "Money Out", "Money In", "Type", "Currency", None))
        self.assertEqual(rows[0], {"payee": "Costa Coffee", "description": "COSTA COFFEE 43012 LONDON GBR", "amount": -3.4, "type": "Card payment", "currency": "GBP"})
        self.assertEqual(rows[1]["amount"], 23.99)

    def test_lloyds_style_debit_and_credit_columns_and_repeated_headings(self):
        head = "Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance\n"
        rows, info = self.read(head + "03/03/2025,DEB,'30-00-00,12345678,TESCO STORES 3456,12.30,,1987.70\n" + head +
                               "07/03/2025,BGC,'30-00-00,12345678,ACME WIDGETS LTD,,2500.00,4339.25\n")
        self.assertEqual(info["columns"]["description"], "Transaction Description")
        self.assertEqual(info["columns"]["type"], "Transaction Type")
        self.assertEqual([(r["payee"], r["amount"]) for r in rows], [("TESCO STORES 3456", -12.3), ("ACME WIDGETS LTD", 2500.0)])

    def test_barclays_unquoted_comma_in_the_shop_name_is_joined_back(self):
        rows, _info = self.read("Number,Date,Account,Amount,Subcategory,Memo\n0,02/03/2025,20-00-00 12345678,-24.50,Card Purchase,SMITH, JONES & CO LTD    \tON 02 MAR          BCC\n")
        self.assertEqual(rows[0]["payee"], "SMITH, JONES & CO LTD ON 02 MAR BCC")
        self.assertEqual(rows[0]["amount"], -24.5)

    def test_preamble_windows_1252_pound_signs_and_paid_out(self):
        text = ('"Account Name:","FlexAccount ****12345"\n"Account Balance:","\xa33,109.25"\n\n'
                '"Date","Transaction type","Description","Paid out","Paid in","Balance"\n'
                '"02 May 2025","Visa purchase","TESCO STORES 3456 LONDON GB","\xa323.10","","\xa31,206.46"\n')
        rows, info = kys.read_statement(self.file("n.csv", text, encoding="cp1252"))
        self.assertEqual(info["columns"]["out"], "Paid out")
        self.assertEqual(rows, [{"payee": "TESCO STORES 3456 LONDON GB", "description": None, "amount": -23.1, "type": "Visa purchase", "currency": "GBP"}])

    def test_no_headings(self):
        rows, info = self.read("03/03/2025,TESCO STORES 3456 ))),-12.30\n04/03/2025,J SMITH,-50.00\n06/03/2025,NETFLIX.COM,-10.99\n")
        self.assertTrue(info["headerless"])
        self.assertEqual((info["columns"]["description"], info["columns"]["amount"]), ("column 2", "column 3"))
        self.assertEqual([r["amount"] for r in rows], [-12.3, -50.0, -10.99])

    def test_semicolons_decimal_commas_and_headings_it_does_not_know(self):
        rows, info = self.read("Buchungstag;Empf\xe4nger;Verwendungszweck;Betrag\n01.03.2025;REWE MARKT FILIALE KOELN;Einkauf;-12,50\n15.03.2025;ACME GMBH;Gehalt;2.500,00\n")
        self.assertEqual(info["delimiter"], ";")
        self.assertEqual((info["columns"]["description"], info["columns"]["amount"]), ("Empf\xe4nger", "Betrag"))
        self.assertEqual([r["amount"] for r in rows], [-12.5, 2500.0])

    def test_choosing_columns_by_heading_or_number(self):
        text = "When,Shop,Note,Spent\n01/02/2025,COSTA COFFEE 43012,coffee,-3.40\n"
        rows, info = self.read(text, column="shop", amount_column="Spent")
        self.assertEqual((info["columns"]["description"], info["columns"]["amount"], rows[0]["payee"]), ("Shop", "Spent", "COSTA COFFEE 43012"))
        rows, info = self.read(text, column="3", amount_column="Spent")
        self.assertEqual(rows[0]["payee"], "coffee")
        with self.assertRaises(kys.KysError) as e:
            self.read(text, column="Merchant name")
        self.assertIn("Merchant name", str(e.exception))

    def test_a_money_out_column_named_by_hand_counts_as_money_out(self):
        rows, _info = self.read("Date,Details,Out\n01/02/2025,COSTA COFFEE,3.40\n", amount_column="Out")
        self.assertEqual(rows[0]["amount"], -3.4)

    def test_balance_lines_are_skipped_and_card_statements_can_be_flipped(self):
        rows, info = self.read("Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP)\n,Opening Balance,,,,1000.00\n01/03/2025,Tesco,TESCO STORES 3456,CONTACTLESS,-12.30,987.70\n")
        self.assertEqual(len(rows), 1)
        self.assertEqual(info["skipped"], {"balance line": 1})
        rows, _info = self.read("Date,Description,Amount\n01/03/2025,TESCO STORES 3456,12.30\n02/03/2025,AMAZON,-15.99\n03/03/2025,X,12.50 CR\n", spend_positive=True)
        self.assertEqual([(r["amount"], r["type"]) for r in rows], [(-12.3, "CARD"), (15.99, "CARD"), (12.5, "CARD")])

    def test_clear_errors(self):
        with self.assertRaises(kys.KysError) as e:
            self.read("Date,Description\n01/02/2025,COSTA\n")
        self.assertIn("--amount-column", str(e.exception))
        with self.assertRaises(kys.KysError) as e:
            kys.read_statement(os.path.join(self.tmp, "missing.csv"))
        self.assertIn("Couldn't open", str(e.exception))

    def test_amounts(self):
        for text, value in [("-12.50", -12.5), ("\xa31,234.56", 1234.56), ("(12.50)", -12.5), ("12.50 DR", -12.5), ("\N{EURO SIGN}1.234,56", 1234.56), ("12.50-", -12.5)]:
            self.assertEqual(kys.parse_amount(text)["value"], value, text)
        self.assertIsNone(kys.parse_amount("abc"))


# ── 2b. The statement command and its summary ─────────────────────────────────────────────────────────────────────────

STATEMENT = (
    "Date,Type,Description,Amount\n"
    "01/10/2026,Card payment,TESCO STORES 3456 LONDON GB,-12.30\n"
    "02/10/2026,Card payment,ZZQ WIDGETS LTD,-45.00\n"
    "03/10/2026,Card payment,BLORPTECH,-9.99\n"
    "04/10/2026,Card payment,SQ *THE BEAN HOUSE,-3.20\n"
    "05/10/2026,Faster payment,J SMITH,-50.00\n"
    "06/10/2026,Card payment,ZZQ DENTAL CLINIC,-60.00\n"
    "07/10/2026,Card payment,PAYPAL *JOHNSMITH,-20.00\n"
    "08/10/2026,Card payment,ZZQ WIDGETS LTD,-5.00\n"
    "09/10/2026,Bill payment,PIPPA,-30.00\n"
    "10/10/2026,Card payment,NETFLIX.COM,-10.99\n"
    "11/10/2026,Card payment,NETFLIX.COM,10.99\n"
    "12/10/2026,Card payment,COSTA COFFEE 43012,-3.40\n"
    "13/10/2026,Card payment,LINK ATM,-40.00\n"
    "14/10/2026,Bacs,ACME WIDGETS LTD SALARY,2500.00\n"
)
SENT = ["BLORPTECH", "ZZQ WIDGETS LTD"]


class StatementCommand(TempDir):
    def test_summary_csv_and_what_is_held_back(self):
        path = self.file("oct.csv", STATEMENT)
        code, out, err = run(["statement", path, "--data", DATA])
        self.assertEqual(code, 0, err)
        self.assertIn("Read 14 payments from oct.csv", out)
        self.assertIn("United Kingdom", out)  # Tesco
        self.assertIn("United States", out)  # Costa Coffee; Netflix was refunded in full
        self.assertIn("Not in our list", out)
        self.assertIn("Held back", out)
        self.assertIn("Local independents", out)
        self.assertIn("2 shops aren't in our list", out)
        with open(os.path.join(self.tmp, "oct.owners.csv"), encoding="utf-8-sig") as f:
            table = list(csv_rows(f.read()))
        self.assertEqual(table[0], list(kys.CSV_FIELDS))
        by = {r[0]: r for r in table[1:]}
        self.assertEqual(by["TESCO STORES"][5:9], ["owner found", "Tesco", "Tesco PLC", "GB"])
        self.assertEqual(by["ZZQ WIDGETS LTD"][2:4], ["2", "50.00"])
        self.assertEqual(by["THE BEAN HOUSE"][5], "local independent")
        self.assertEqual(by["ZZQ DENTAL CLINIC"][5], "sensitive: not looked up")
        self.assertEqual(by["JOHNSMITH"][5], "looks like a person: not looked up")
        self.assertEqual(by["PIPPA"][5], "looks like a person: not looked up")
        self.assertEqual(by["J SMITH"][1:6], ["transfer", "1", "50.00", "0.00", "not counted: transfers (they may be to people)"])
        self.assertEqual(by["LINK ATM"][1], "cash")

    def test_summary_numbers(self):
        e = engine()
        rows, _info = kys.read_statement(self.file("oct.csv", STATEMENT))
        groups = kys.analyse_statement(e, rows, "GB")
        s = kys.summarise(groups, e.countries, kys.main_currency(groups))
        countries = {c["country"]: c["amount"] for c in s["countries"]}
        self.assertEqual(countries, {"GB": 1230, "US": 340})  # Netflix's refund cancels it, and nothing goes below zero
        self.assertEqual(s["buckets"], {"local": 320, "unknown": 5999, "held": 11000, "retry": 0, "not_business": 0})
        self.assertEqual(s["total"], 1230 + 340 + 320 + 5999 + 11000)
        self.assertEqual(s["not_counted"], {"transfer": (1, 5000), "cash": (1, 4000)})
        self.assertAlmostEqual(sum(c["share"] for c in s["countries"]), (1230 + 340) / s["total"], places=3)

    def test_csv_cells_a_spreadsheet_would_run_are_defused(self):
        self.assertEqual([kys._cell(v) for v in ("=HYPERLINK(1)", "+44", "-1", "@SUM", "TESCO", 3)], ["'=HYPERLINK(1)", "'+44", "'-1", "'@SUM", "TESCO", "3"])
        path = self.file("f.csv", "Date,Type,Description,Amount\n01/10/2026,Card payment,@ZZQSHOP,-1.00\n")
        self.assertEqual(run(["statement", path, "--data", DATA])[0], 0)
        with open(os.path.join(self.tmp, "f.owners.csv"), encoding="utf-8-sig") as f:
            self.assertEqual(list(csv_rows(f.read()))[1][0], "'@ZZQSHOP")

    def test_never_writes_over_the_statement(self):
        path = self.file("oct.csv", STATEMENT)
        code, _out, err = run(["statement", path, "--data", DATA, "--out", path])
        self.assertEqual(code, 1)
        self.assertIn("written over", err)
        with open(path, encoding="utf-8") as f:
            self.assertEqual(f.read(), STATEMENT)

    def test_json(self):
        code, out, _err = run(["statement", self.file("oct.csv", STATEMENT), "--data", DATA, "--json"])
        self.assertEqual(code, 0)
        d = json.loads(out)
        self.assertEqual(sorted(s["query"] for s in d["shops"] if s["status"] == "unknown"), SENT)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "oct.owners.csv")))  # --json writes the CSV only with --out

    def test_lookup_command(self):
        code, out, _err = run(["lookup", "COSTA COFFEE 43012 LONDON GB", "--data", DATA])
        self.assertEqual(code, 0)
        self.assertIn("Costa Coffee is owned by The Coca-Cola Company, run from the United States.", out)
        self.assertIn("How we know:  From official registers", out)
        code, out, _err = run(["lookup", "J", "SMITH", "--data", DATA, "--json"])
        self.assertEqual(json.loads(out)["status"], "person")
        code, _out, err = run(["lookup", "TESCO", "--country", "Britain", "--data", DATA])
        self.assertEqual(code, 2)
        self.assertIn("two-letter", err)

    def test_no_data_yet(self):
        code, _out, err = run(["lookup", "TESCO"], env={"KYS_CACHE_DIR": os.path.join(self.tmp, "empty")})
        self.assertEqual(code, 1)
        self.assertIn("no ownership data yet", err)
        self.assertIn("data update", err)


def csv_rows(text):
    import csv
    return csv.reader(io.StringIO(text))


# ── 3. data update ───────────────────────────────────────────────────────────────────────────────────────────────────

FAKE_FILES = {
    "merchants.json": [],
    "product-brands.json": [],
    "open-brands.json": {"version": 1, "generated": "2026-10-07", "sources": [], "brands": []},
    "open-brand-corrections.json": {"version": 1, "reviewed": "2026-10-07", "method": "", "corrections": []},
    "countries.json": {"GB": {"name": "United Kingdom", "flag": ""}},
}


class DataUpdate(TempDir):
    def serve(self, files, tweak=None):
        blobs = {name: json.dumps(v).encode("utf-8") for name, v in files.items()}
        manifest = {"version": "abc123", "files": {name: {"url": "/data/files/%s" % name.replace(".json", ".0123.json"),
                                                          "sha256": hashlib.sha256(b).hexdigest(), "bytes": len(b)} for name, b in blobs.items()}}
        if tweak:
            tweak(manifest)

        def handler(req):
            if req["path"] == "/data/manifest.json":
                return json_reply(manifest)
            for name, b in blobs.items():
                if req["path"] == "/data/files/%s" % name.replace(".json", ".0123.json"):
                    return 200, {"Content-Type": "application/json"}, b
            return 404, {}, b"not found"

        srv = Server(handler)
        self.addCleanup(srv.close)
        return srv

    def update(self, srv):
        env = {"KYS_DATA_URL": srv.url + "/data/manifest.json", "KYS_CACHE_DIR": os.path.join(self.tmp, "cache")}
        return run(["data", "update"], env=env)

    def test_downloads_checks_and_saves(self):
        srv = self.serve(FAKE_FILES)
        code, out, err = self.update(srv)
        self.assertEqual(code, 0, err)
        self.assertIn("version abc123", out)
        cache = os.path.join(self.tmp, "cache")
        self.assertEqual(sorted(os.listdir(cache)), sorted(list(kys.DATA_FILES) + ["manifest.json"]))
        data = kys.load_data(cache)  # checked against the saved SHA-256s
        self.assertEqual(data["_manifest"]["version"], "abc123")
        self.assertEqual(len(kys.Engine(data).entries), 0)
        # a second run downloads nothing
        before = len(srv.requests)
        code, out, _err = self.update(srv)
        self.assertEqual(code, 0)
        self.assertIn("already up to date", out)
        self.assertEqual(len(srv.requests), before + 1)  # the manifest only
        # a file changed afterwards is noticed
        with open(os.path.join(cache, "countries.json"), "w") as f:
            f.write("{}")
        with self.assertRaises(kys.KysError) as e:
            kys.load_data(cache)
        self.assertIn("has changed since it was downloaded", str(e.exception))

    def test_a_wrong_checksum_changes_nothing(self):
        good = self.serve(FAKE_FILES)
        self.assertEqual(self.update(good)[0], 0)
        cache = os.path.join(self.tmp, "cache")
        with open(os.path.join(cache, "merchants.json"), "rb") as f:
            kept = f.read()
        changed = dict(FAKE_FILES, **{"merchants.json": [{"id": "x"}]})

        def lie(manifest):
            manifest["files"]["merchants.json"]["sha256"] = "0" * 64
        code, _out, err = self.update(self.serve(changed, lie))
        self.assertEqual(code, 1)
        self.assertIn("didn't match its SHA-256", err)
        with open(os.path.join(cache, "merchants.json"), "rb") as f:
            self.assertEqual(f.read(), kept)
        self.assertFalse([n for n in os.listdir(cache) if n.endswith(".download")])

    def test_a_wrong_size_or_a_missing_file_is_refused(self):
        def short(manifest):
            manifest["files"]["countries.json"]["bytes"] += 1
        code, _out, err = self.update(self.serve(FAKE_FILES, short))
        self.assertEqual(code, 1)
        self.assertIn("countries.json", err)

        def missing(manifest):
            del manifest["files"]["open-brands.json"]
        code, _out, err = self.update(self.serve(FAKE_FILES, missing))
        self.assertEqual(code, 1)
        self.assertIn("open-brands.json", err)

    def test_a_download_that_breaks_off_leaves_nothing_behind(self):
        blobs = {name: json.dumps(v).encode("utf-8") for name, v in FAKE_FILES.items()}
        manifest = {"version": "v2", "files": {n: {"url": "/f/" + n, "sha256": hashlib.sha256(b).hexdigest(), "bytes": len(b)} for n, b in blobs.items()}}

        def handler(req):
            if req["path"] == "/m.json":
                return json_reply(manifest)
            if req["path"] == "/f/open-brands.json":
                return 200, {"Content-Length": "999999"}, b"{"  # promises more than it sends
            return 200, {}, blobs[req["path"][3:]]
        srv = Server(handler)
        self.addCleanup(srv.close)
        code, _out, err = run(["data", "update"], env={"KYS_DATA_URL": srv.url + "/m.json", "KYS_CACHE_DIR": self.tmp})
        self.assertEqual(code, 1, err)
        self.assertEqual(sorted(os.listdir(self.tmp)), [])  # no half-written files, and no manifest

    def test_only_https(self):
        with self.assertRaises(kys.KysError) as e:
            kys.data_update("http://example.org/data/manifest.json", self.tmp, say=lambda s: None)
        self.assertIn("only https://", str(e.exception))

    def test_unreachable(self):
        srv = Server(lambda req: (500, {}, b""))
        url = srv.url
        srv.close()
        code, _out, err = run(["data", "update"], env={"KYS_DATA_URL": url + "/data/manifest.json", "KYS_CACHE_DIR": self.tmp})
        self.assertEqual(code, 1)
        self.assertIn("Couldn't read the list of data files", err)


# ── 4. --online ─────────────────────────────────────────────────────────────────────────────────────────────────────

def lookup_entry(**over):
    e = {"id": "lookup-zzq-widgets-ltd", "display_name": "Zzq Widgets Ltd", "kind": "merchant", "aliases": ["ZZQ WIDGETS LTD"],
         "chain": [{"name": "ZZQ Widgets Ltd", "relation": "brand_of", "country": "GB", "source": "companies_house"},
                   {"name": "Widget Holdings SE", "relation": "ultimate_parent", "country": "DE", "source": "gleif"}],
         "owner_country": "DE", "tier": "EXACT_ID", "technique": "Found in Wikidata and GLEIF",
         "sources": [{"label": "GLEIF record", "url": "https://search.gleif.org/"}], "as_of": "2026-10-20", "reviewed_by": None, "reviewed_at": None}
    e.update(over)
    return e


# The look-up's answer (services/lookup/kys-lookup.ts): ZZQ WIDGETS LTD found; BLORPTECH not finished, AI paused today
ANSWERS = {
    "results": [
        {"query": "ZZQ WIDGETS LTD", "status": "RESOLVED", "entry": lookup_entry(), "trace": [{"step": "wikidata+gleif", "status": "found", "detail": "Found."}]},
        {"query": "BLORPTECH", "status": "UNRESOLVED", "trace": [{"step": "ai", "status": "error", "detail": "The AI step is paused for today."}]},
    ],
    "sources": {"ai": False, "web": False, "companies_house": True},
}


class Online(TempDir):
    def api(self, replies):
        """replies: handler results used in turn (the last one repeats); a callable is called with the request."""
        seq = list(replies)

        def handler(req):
            r = seq.pop(0) if len(seq) > 1 else seq[0]
            return r(req) if callable(r) else r
        srv = Server(handler)
        self.addCleanup(srv.close)
        return srv

    def statement(self, srv, *extra, env=None, **kw):
        path = self.file("oct.csv", STATEMENT)
        env = dict({"KYS_API_URL": srv.url + "/functions/v1/kys-lookup", "KYS_API_KEY": ""}, **(env or {}))
        return run(["statement", path, "--data", DATA, "--online", *extra], env=env, **kw)

    def test_sends_only_unknown_business_names_as_the_website_does(self):
        srv = self.api([json_reply(ANSWERS)])
        code, out, err = self.statement(srv, "--yes")
        self.assertEqual(code, 0, err)
        self.assertEqual(len(srv.requests), 1)
        req = srv.requests[0]
        self.assertEqual((req["method"], req["path"]), ("POST", "/functions/v1/kys-lookup"))
        self.assertEqual(json.loads(req["body"]), {"merchants": SENT})  # exactly this: no country for GB, nothing else
        for secret in (b"45.00", b"2026", b"TESCO", b"SMITH", b"PIPPA", b"DENTAL", b"BEAN", b"NETFLIX", b"SALARY"):
            self.assertNotIn(secret, req["body"])
        headers = {k.lower(): v for k, v in req["headers"].items()}
        self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(headers["authorization"], "Bearer " + kys.LOOKUP_KEY)
        self.assertEqual(headers["apikey"], kys.LOOKUP_KEY)
        self.assertNotIn("origin", headers)
        # the list was shown first, then the wait explained, and the answers used
        self.assertIn("would be sent to %s/functions/v1/kys-lookup:\n  BLORPTECH\n  ZZQ WIDGETS LTD\n" % srv.url, out)
        self.assertIn("can take up to two minutes", out)
        self.assertIn(kys.PAUSED, out)
        self.assertIn("Germany", out)
        self.assertIn("Couldn't check", out)
        with open(os.path.join(self.tmp, "oct.owners.csv"), encoding="utf-8-sig") as f:
            by = {r[0]: r for r in csv_rows(f.read())}
        self.assertEqual(by["ZZQ WIDGETS LTD"][5:11], ["owner found", "Zzq Widgets Ltd", "Widget Holdings SE", "DE", "Germany", "From official registers"])
        self.assertEqual(by["ZZQ WIDGETS LTD"][14], "online look-up")
        self.assertEqual(by["BLORPTECH"][5], "couldn't check it just now: try again later")

    def test_names_it_didnt_finish_are_counted_apart(self):
        unfinished = {"results": [{"query": "BLORPTECH", "status": "UNRESOLVED", "trace": [{"step": "cache", "status": "error", "detail": "Ran out of time."}]}],
                      "sources": {"ai": True}}
        srv = self.api([json_reply(unfinished)])
        code, out, err = self.statement(srv, "--yes", "--details")
        self.assertEqual(code, 0, err)
        self.assertIn("Our online look-up answered 1 name.\nIt didn't finish checking 1 name. Please try again in a little while.", out)
        self.assertNotIn(kys.PAUSED, out)
        self.assertRegex(out, r"Couldn't check +9\.99 +5%")
        self.assertRegex(out, r"BLORPTECH +couldn't check it just now: try again later")
        self.assertRegex(out, r"ZZQ WIDGETS LTD +not in the list")  # not answered: still unknown

    def test_the_country_only_when_it_isnt_gb_and_your_own_key(self):
        srv = self.api([json_reply({"results": [], "sources": {"ai": True}})])
        self.statement(srv, "--yes", "--country", "fr", env={"KYS_API_KEY": "my-own-key"})
        body = json.loads(srv.requests[0]["body"])
        self.assertEqual(set(body), {"merchants", "country"})
        self.assertEqual(body["country"], "FR")
        headers = {k.lower(): v for k, v in srv.requests[0]["headers"].items()}
        self.assertEqual((headers["authorization"], headers["apikey"]), ("Bearer my-own-key", kys.LOOKUP_KEY))

    def test_says_where_the_names_go(self):
        said = []
        self.assertTrue(kys.confirm(SENT, kys.LOOKUP_URL, "IE", True, say=said.append, held=3))
        self.assertEqual(said[1:], [
            "Our built-in list doesn't know these 2 shops. With --online, just these names, and the country IE, would be sent to "
            "our look-up service (run on Supabase in Ireland):", "  BLORPTECH", "  ZZQ WIDGETS LTD",
            "Nothing else is sent: no amounts, dates or anything else from your statement.",
            "Held back and never sent: 3 names that may be a person's, could be sensitive or are local independents."])
        self.assertEqual(kys.lookup_url(), kys.LOOKUP_URL)
        self.assertTrue(kys.LOOKUP_URL.startswith("https://") and kys.LOOKUP_URL.endswith("/functions/v1/kys-lookup"))

    def test_asks_first(self):
        srv = self.api([json_reply(ANSWERS)])
        code, out, _err = self.statement(srv)  # no --yes, nobody at the keyboard
        self.assertEqual((code, srv.requests), (0, []))
        self.assertIn("Not sent", out)
        self.statement(srv, stdin_tty=True, answer="n")
        self.assertEqual(srv.requests, [])
        self.statement(srv, stdin_tty=True, answer="y")
        self.assertEqual(len(srv.requests), 1)

    def test_busy_then_answers(self):
        srv = self.api([json_reply({"error": "slow down"}, 429, {"Retry-After": "1"}), json_reply(ANSWERS)])
        code, out, err = self.statement(srv, "--yes")
        self.assertEqual(code, 0, err)
        self.assertEqual(len(srv.requests), 2)
        self.assertIn("busy. Trying again in 1 second", out)
        self.assertIn("Germany", out)

    def test_limits_and_errors_keep_the_offline_results(self):
        for reply, words in [
            (json_reply({"error": "Too many look-ups from this connection today. Please try again tomorrow."}, 429), "Please try again tomorrow"),
            (json_reply({"error": "limit"}, 429, {"Retry-After": "3600"}), "try again in about 60 minutes"),
            (json_reply({"error": "origin not allowed"}, 403), "turned the request down (HTTP 403: origin not allowed). Please try again later."),
            (json_reply({"error": "boom"}, 503), "had a problem (HTTP 503: boom)"),
            ((200, {"Content-Type": "text/html"}, b"<html>"), "can't read"),
        ]:
            srv = self.api([reply])
            code, out, err = self.statement(srv, "--yes")
            self.assertEqual(code, 3, (words, err))
            self.assertIn(words, err)
            self.assertIn("United Kingdom", out)  # the offline summary is still there
        srv = Server(lambda req: (200, {}, b""))
        url = srv.url
        srv.close()
        code, _out, err = run(["statement", self.file("oct.csv", STATEMENT), "--data", DATA, "--online", "--yes", "--api-url", url + "/x"])
        self.assertEqual(code, 3)
        self.assertIn("couldn't reach our online look-up", err)

    def test_a_slow_answer_times_out_politely(self):
        def slow(req):
            threading.Event().wait(1.0)  # not time.sleep, which run() switches off
            return json_reply(ANSWERS)
        srv = self.api([slow])
        with mock.patch("kys.LOOKUP_TIMEOUT", 0.2):
            code, out, err = self.statement(srv, "--yes")
        self.assertEqual(code, 3)
        self.assertIn("Our online look-up didn't answer within", err)
        self.assertIn("United Kingdom", out)

    def test_how_answers_are_shown(self):
        cases = [
            ({"query": "GRUNDLEBURG HOLDINGS LTD", "status": "LOCAL_BUSINESS", "checked": "web", "trace": []}, ["local independent", "A web search was part of that check."]),
            ({"query": "GRUNDLEBURG HOLDINGS LTD", "status": "NOT_A_BUSINESS", "trace": []}, ["This doesn't look like a business."]),
            ({"query": "GRUNDLEBURG HOLDINGS LTD", "status": "UNRESOLVED", "trace": [{"step": "ai", "status": "not_found", "detail": "No owner."}]},
             ["We couldn't find who owns this."]),
            ({"query": "GRUNDLEBURG HOLDINGS LTD", "status": "UNRESOLVED", "trace": [{"step": "ai", "status": "error", "detail": "Paused."}]},
             ["We couldn't look this up just now.", kys.PAUSED]),
            ({"query": "GRUNDLEBURG HOLDINGS LTD", "status": "RESOLVED", "trace": [], "recheck_after": "2026-10-25",
              "entry": lookup_entry(tier="LLM_GUESS", technique="AI vote")}, ["owned by Widget Holdings SE, run from Germany.", "AI estimate",
                                                                            "Answered by:  our online look-up", "from 25 Oct 2026"]),
            ({"query": "GRUNDLEBURG HOLDINGS LTD", "status": "RESOLVED", "trace": [], "entry": dict(lookup_entry(), id="tesco")},
             ["Tesco is owned by Tesco PLC, run from the United Kingdom.", "From official registers"]),  # the built-in entry wins
            ({"query": "GRUNDLEBURG HOLDINGS LTD", "status": "RESOLVED", "entry": lookup_entry(display_name="Zzq\x1b[2J Widgets\x07"),
              "trace": [{"step": "wikidata", "status": "found", "detail": "Found\x1b]0;hi\x07 in Wikidata."}, {"step": "gleif", "status": "found", "detail": "GLEIF agrees."}]},
             ["Zzq [2J Widgets  is owned by", "Checked:      Found ]0;hi  in Wikidata.\n                GLEIF agrees.\n"]),  # nothing a terminal would act on
        ]
        for answer, expected in cases:
            srv = self.api([json_reply({"results": [answer], "sources": {"ai": False}})])
            code, out, err = run(["lookup", "CARD PAYMENT TO GRUNDLEBURG HOLDINGS LTD ON 12 OCT", "--data", DATA, "--online", "--yes",
                                  "--api-url", srv.url + "/functions/v1/kys-lookup"], env={"KYS_API_KEY": ""})
            self.assertEqual(code, 0, err)
            for words in expected:
                self.assertIn(words, out, (answer["status"], out))
            self.assertNotRegex(out, "[\x00-\x09\x0b-\x1f\x7f]")
            self.assertEqual(json.loads(srv.requests[0]["body"]), {"merchants": ["GRUNDLEBURG HOLDINGS LTD"]})

    def test_lookup_sends_just_the_name_and_never_a_held_one(self):
        srv = self.api([json_reply({"results": [{"query": "GRUNDLEBURG HOLDINGS LTD", "status": "NOT_A_BUSINESS", "trace": []}]})])
        env = {"KYS_API_URL": srv.url + "/functions/v1/kys-lookup", "KYS_API_KEY": ""}
        code, _out, err = run(["lookup", "CARD PAYMENT TO GRUNDLEBURG HOLDINGS LTD ON 12 OCT", "--data", DATA, "--online", "--yes", "--country", "ie"], env=env)
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(srv.requests[0]["body"]), {"merchants": ["GRUNDLEBURG HOLDINGS LTD"], "country": "IE"})
        for held in ("J SMITH", "MARIE STOPES", "SQ *THE BEAN HOUSE", "TESCO STORES 3456", "BANK TRANSFER TO DAVID JONES", "CASH WITHDRAWAL",
                     "VANGUARD ISA", "PAYPAL *JOHNSMITH", "FASTER PAYMENT TO JOHN SMITH REF RENT"):
            run(["lookup", held, "--data", DATA, "--online", "--yes"], env=env)
        self.assertEqual(len(srv.requests), 1)  # people, sensitive names, local independents, non-shops, known shops: never sent

    def test_batches_names_and_the_services_own_spelling(self):
        srv = self.api([lambda req: json_reply({"results": [{"query": n.replace("/", " "), "status": "NOT_A_BUSINESS", "trace": []}
                                                            for n in json.loads(req["body"])["merchants"]], "sources": {"ai": True}})])
        names = ["SHOP %03d" % i for i in range(130)] + ["24/7 FITNESS", "SHOP 001", "X" * 61, "A"]
        answers, sources, problem = kys.ask_online(names, "GB", srv.url, say=lambda s: None)
        self.assertIsNone(problem)
        sent = [json.loads(r["body"])["merchants"] for r in srv.requests]
        self.assertEqual([len(b) for b in sent], [60, 60, 11])  # sorted, each once, nothing too long or too short
        self.assertEqual(sum(sent, []), sorted(set(names) - {"X" * 61, "A"}))
        self.assertEqual(answers["24/7 FITNESS"]["status"], "NOT_A_BUSINESS")  # answered as "24 7 FITNESS"
        self.assertEqual(sources, {"ai": True})


if __name__ == "__main__":
    unittest.main()
