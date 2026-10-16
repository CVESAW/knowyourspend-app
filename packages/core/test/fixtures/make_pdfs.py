"""Mock bank-statement PDFs (made-up people and numbers) in three common UK layouts, with truth.json."""
import json, random
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
random.seed(3)
W, H = A4
truth = {}

SHOPS = [("Tesco", "TESCO STORES 3456", "London"), ("Sainsbury's", "SAINSBURYS S/MKTS", "London"), ("Pret A Manger", "PRET A MANGER", "London"),
         ("Amazon", "AMAZON.CO.UK*AB12CD34E", "amazon.co.uk"), ("Netflix", "NETFLIX.COM", "Amsterdam"), ("Uber", "UBER *TRIP", "help.uber.com"),
         ("Costa Coffee", "COSTA COFFEE 43012", "London"), ("Lidl", "LIDL GB", "London"), ("Spotify", "SPOTIFY", "Stockholm"), ("Greggs", "GREGGS 1234", "London"),
         ("Deliveroo", "DELIVEROO", "London"), ("Boots", "BOOTS 1182", "London"), ("Apple", "APPLE.COM/BILL", "Cork"), ("The Old Bakehouse", "SQ *THE OLD BAKEHOUSE", "London")]

def money(x): return f"£{x:,.2f}"

def rows(n, start_bal=1200.0):
    out, bal = [], start_bal
    for i in range(n):
        day = 1 + (i * 30) // n
        if i == 7:
            amt, name, raw, city, kind = 1850.00, "Acme Ltd", "ACME LTD SALARY", "", "in"
        elif i == 15:
            amt, name, raw, city, kind = 25.00, "Jane Smith", "JANE SMITH", "", "out_transfer"
        else:
            name, raw, city = random.choice(SHOPS); amt = round(random.uniform(2, 90), 2); kind = "out"
        bal = round(bal + (amt if kind == "in" else -amt), 2)
        out.append(dict(day=day, name=name, raw=raw, city=city, amt=amt, kind=kind, bal=bal))
    return out

# ── Revolut-style ─────────────────────────────────────────────
def revolut(path, n=46):
    c = canvas.Canvas(path, pagesize=A4)
    rs = rows(n)
    def header(first):
        c.setFont("Helvetica-Bold", 18); c.drawString(40, H - 50, "GBP Statement")
        c.setFont("Helvetica", 8); c.drawString(40, H - 64, "Generated on the 2 Aug 2026"); c.drawRightString(W - 40, H - 50, "Revolut Ltd")
        if first:
            c.setFont("Helvetica-Bold", 10); c.drawString(40, H - 95, "Alex Example")
            c.setFont("Helvetica", 8); c.drawString(40, H - 107, "1 Example Road, London, SE10 0AA")
            c.drawString(330, H - 95, "IBAN  GB00 REVO 0099 0000 0000 00"); c.drawString(330, H - 107, "Sort code 04-00-75   Account 00000000")
            c.setFont("Helvetica-Bold", 11); c.drawString(40, H - 140, "Balance summary")
            c.setFont("Helvetica", 8)
            for x, t in [(40, "Product"), (230, "Opening balance"), (330, "Money out"), (420, "Money in"), (W - 40, "Closing balance")]:
                (c.drawRightString if x == W - 40 else c.drawString)(x, H - 156, t)
            c.drawString(40, H - 170, "Account (Current Account)"); c.drawString(230, H - 170, "£1,200.00"); c.drawString(330, H - 170, "£1,234.56"); c.drawString(420, H - 170, "£1,850.00"); c.drawRightString(W - 40, H - 170, money(rs[-1]["bal"]))
            c.drawString(40, H - 184, "Total"); c.drawString(230, H - 184, "£1,200.00")
            c.setFont("Helvetica-Bold", 11); c.drawString(40, H - 215, "Account transactions from 1 July 2026 to 31 July 2026")
            return H - 235
        return H - 90
    def colheads(y):
        c.setFont("Helvetica-Bold", 8)
        c.drawString(40, y, "Date"); c.drawString(120, y, "Description")
        c.drawRightString(390, y, "Money out"); c.drawRightString(470, y, "Money in"); c.drawRightString(W - 40, y, "Balance")
        c.line(40, y - 4, W - 40, y - 4)
        return y - 18
    page, y = 1, colheads(header(True))
    for r in rs:
        if y < 90:
            c.setFont("Helvetica", 7); c.drawString(40, 40, "Revolut Ltd is registered in England and Wales (No. 08804411)."); c.drawRightString(W - 40, 40, f"Page {page}")
            c.showPage(); page += 1; y = colheads(header(False))
        c.setFont("Helvetica", 9)
        c.drawString(40, y, f"{r['day']} Jul 2026"); c.drawString(120, y, r["name"])
        if r["kind"] == "in": c.drawRightString(470, y, money(r["amt"]))
        else: c.drawRightString(390, y, money(r["amt"]))
        c.drawRightString(W - 40, y, money(r["bal"]))
        c.setFont("Helvetica", 7)
        if r["kind"] == "out":
            c.drawString(120, y - 10, f"To: {r['raw']}, {r['city']}"); c.drawString(120, y - 19, "Card: 535522******1234"); y -= 34
        elif r["kind"] == "in":
            c.drawString(120, y - 10, f"From: {r['raw']}"); y -= 25
        else:
            c.drawString(120, y - 10, f"To: {r['raw']}"); c.drawString(120, y - 19, "Reference: dinner"); y -= 34
    # pending section (should be ignored)
    c.setFont("Helvetica-Bold", 11); c.drawString(40, y - 10, "Pending from 30 July 2026 to 31 July 2026"); y = colheads(y - 30)
    c.setFont("Helvetica", 9); c.drawString(40, y, "31 Jul 2026"); c.drawString(120, y, "Tesco"); c.drawRightString(390, y, "£9.99")
    c.setFont("Helvetica", 7); c.drawString(40, 40, "Revolut Ltd is registered in England and Wales (No. 08804411)."); c.drawRightString(W - 40, 40, f"Page {page}")
    c.save()
    return rs

# ── Monzo-style: one signed amount column ─────────────────────
def monzo(path, n=30):
    c = canvas.Canvas(path, pagesize=A4)
    rs = rows(n)
    c.setFont("Helvetica-Bold", 16); c.drawString(40, H - 50, "Monzo Bank Limited"); c.setFont("Helvetica", 9); c.drawString(40, H - 66, "Personal Account statement  01/07/2026 - 31/07/2026")
    y = H - 100
    c.setFont("Helvetica-Bold", 8); c.drawString(40, y, "Date"); c.drawString(110, y, "Description"); c.drawRightString(450, y, "(GBP) Amount"); c.drawRightString(W - 40, y, "(GBP) Balance"); y -= 18
    for r in rs:
        c.setFont("Helvetica", 9)
        c.drawString(40, y, f"{r['day']:02d}/07/2026"); c.drawString(110, y, f"{r['raw']} {r['city']}".strip())
        c.drawRightString(450, y, f"{'' if r['kind']=='in' else '-'}{r['amt']:,.2f}"); c.drawRightString(W - 40, y, f"{r['bal']:,.2f}")
        y -= 16
    c.save()
    return rs

# ── Barclays-style: date only on the first row of each day ────
def barclays(path, n=30):
    c = canvas.Canvas(path, pagesize=A4)
    rs = rows(n)
    c.setFont("Helvetica-Bold", 14); c.drawString(40, H - 50, "Barclays Bank UK PLC — Your transactions")
    c.setFont("Helvetica", 9); c.drawString(40, H - 66, "1 Jul - 31 Jul 2026")
    y = H - 90
    c.setFont("Helvetica-Bold", 8)
    c.drawString(40, y, "Date"); c.drawString(100, y, "Description"); c.drawRightString(390, y, "Money out £"); c.drawRightString(470, y, "Money in £"); c.drawRightString(W - 40, y, "Balance £"); y -= 18
    c.setFont("Helvetica", 9); c.drawString(100, y, "Start balance"); c.drawRightString(W - 40, y, "1,200.00"); y -= 16
    last = None
    for r in rs:
        if r["day"] != last: c.drawString(40, y, f"{r['day']} Jul"); last = r["day"]
        c.drawString(100, y, ("Card Payment to " if r["kind"] == "out" else "") + r["raw"] + (" On 0" + str(r['day']) + " Jul" if r["kind"] == "out" else ""))
        if r["kind"] == "in": c.drawRightString(470, y, f"{r['amt']:,.2f}")
        else: c.drawRightString(390, y, f"{r['amt']:,.2f}")
        c.drawRightString(W - 40, y, f"{r['bal']:,.2f}")
        y -= 16
    c.save()
    return rs

# ── Revolut account statement (2026 layout): "Date (UTC)", a type-code column, thousands grouped
#    with a space, FX lines under foreign card payments, headings only on the first table page,
#    a second period after the Revolut Bank transition, and a £0.00 legend at the end ────────────
def revolut2(path):
    c = canvas.Canvas(path, pagesize=A4)
    def sp(x): return "£" + f"{x:,.2f}".replace(",", " ")
    rs = [("MOA", "Money added from SHOPIFY INC \u2022", "SHOPIFY /PAYER ACC", None, 273.65),
          ("CAR", "Paypal *tcgplayer", None, 2296.15, None), ("CAR", "Paypal *shopify", "FX", 47.23, None),
          ("MOS", "Paypal Uk \u2022 5G92222S93F2W", None, 1200.00, None), ("CAR", "Post Office Counter", None, 22.95, None),
          ("MOA", "Money added from EBAY COMMERCE UK", "\u2022 ref 12345", None, 1981.71), ("CAR", "Paypal *microsoft", "FX", 7.29, None),
          ("CAR", "Anthropic", None, 75.00, None), ("MOS", "A Friend", "\u2022 dinner", 25.00, None)] * 3
    bal = 5000.0
    def heads(y):
        c.setFont("Helvetica-Bold", 8)
        c.drawString(43.5, y, "Date (UTC)"); c.drawString(172.8, y, "Description")
        c.drawString(360, y, "Money out"); c.drawString(443.5, y, "Money in"); c.drawString(526, y, "Balance")
        return y - 22
    c.setFont("Helvetica-Bold", 18); c.drawString(360, 767, "Account statement")
    c.setFont("Helvetica", 6); c.drawString(36, 14.9, "\u00a9 2026 Revolut Ltd")
    c.setFont("Helvetica-Bold", 11); c.drawString(42, 507, "Balance summary")
    c.setFont("Helvetica", 7.5); c.drawString(42.8, 455, "Money in"); c.drawString(204, 455, sp(99999.99))
    c.setFont("Helvetica-Bold", 12); c.drawString(42, 347, "Transactions from 1 June 2026 to 29 June 2026")
    y = heads(324); out = inn = 0.0; n = 0
    for i, (code, desc, detail, o, m) in enumerate(rs):
        if y < 120:
            c.setFont("Helvetica", 6); c.drawRightString(557, 24, "1/2"); c.showPage(); y = 792
        day = 28 - i
        bal = round(bal - (o or 0) + (m or 0), 2)
        c.setFont("Helvetica", 7.5)
        c.drawString(43.5, y, f"{day} Jun 2026"); c.drawString(121, y, code); c.drawString(172.8, y, desc)
        if o: c.drawRightString(402.6, y, sp(o))
        if m: c.drawRightString(480.2, y, sp(m))
        c.drawRightString(557.7, y, sp(bal))
        if detail == "FX":
            c.setFont("Helvetica", 6); c.drawString(172.8, y - 10.7, "FX Rate GBP 1 = USD 1.342888"); c.drawRightString(402.6, y - 10.7, "$" + f"{(o * 1.34):.2f}")
        elif detail:
            c.drawString(172.8, y - 13.5, detail)
        out += o or 0; inn += m or 0; n += 1
        y -= 33
    # second period on its own page
    c.showPage()
    c.setFont("Helvetica-Bold", 12); c.drawString(42, 347, "Transactions from 30 June 2026 to 30 June 2026")
    y = heads(324)
    c.setFont("Helvetica", 7.5); c.drawString(43.5, y, "30 Jun 2026"); c.drawString(121, y, "MOA"); c.drawString(172.8, y, "Money added from EBAY COMMERCE UK")
    c.drawRightString(480.2, y, sp(758.65)); c.drawRightString(557.7, y, sp(bal + 758.65)); inn += 758.65; n += 1
    c.setFont("Helvetica", 7.5)
    for x, t in [(38.3, "Card payments (CAR)"), (181.7, "Money sent (MOS)"), (301.9, "Money received (MOR)"), (437.5, "Money added (MOA)")]:
        c.drawString(x, 165, t); c.drawString(x, 155, "£0.00")
    c.save()
    return n, round(out, 2), round(inn, 2)

for name, fn in [("revolut", revolut), ("monzo", monzo), ("barclays", barclays)]:
    random.seed(3)
    rs = fn(f"{name}.pdf")
    spend = [r for r in rs if r["kind"] != "in"]
    truth[name] = {"rows": len(rs), "out": round(sum(r["amt"] for r in spend), 2), "in": round(sum(r["amt"] for r in rs if r["kind"] == "in"), 2),
                   "first": rs[0]["name"], "closing": rs[-1]["bal"]}
n, o, i = revolut2("revolut-2026.pdf")
truth["revolut-2026"] = {"rows": n, "out": o, "in": i}
json.dump(truth, open("truth.json", "w"), indent=1)
print(truth)
