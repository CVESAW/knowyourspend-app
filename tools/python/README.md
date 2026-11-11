# kys.py: who owns the shops on your bank statement

`kys.py` is KnowYourSpend in one Python file you can read. Give it a bank statement saved as CSV, or a single line
of bank text, and it tells you which company owns each shop and the country that company is run from. It uses the
same matching as the KnowYourSpend app and website, so it gives the same answers.

It needs Python 3.9 or newer and nothing else: no packages to install.

## Your privacy

- **It works offline.** Your statement is read on your computer and stays there. Amounts, dates, balances, account
  numbers and the names of people you pay never leave it.
- **The one download is our ownership list** (about 2 MB), from knowyourspend.org. The script checks every file
  against its SHA-256 checksum before using it, and checks it again each time it runs.
- **Going online is up to you.** If you add `--online`, the script shows you the names of the shops our list doesn't
  know and asks before sending anything. Then it sends only those names, and your bank's country if it isn't the UK,
  to our look-up service (run on Supabase in Ireland). Nothing else.
- **What the look-up does with them.** It may ask Wikidata, GLEIF, Companies House and Mistral AI (a French AI
  company) about the names. It keeps each name and its answer (from 3 days to a year, depending on the answer) and a
  count of how often each name is asked, never who asked. Names it decides aren't a business aren't kept. To share
  out its daily limits fairly, it counts requests per connection, keeping only a scrambled form of your internet
  address (a salted SHA-256) for two days.
- **Some names are never sent**, even with `--online`: anything that looks like a person's name, anything that could
  say something sensitive about you (health, money worries, gambling, dating, politics, religion and the like), small
  local businesses such as cafés and market stalls, and payments that aren't to a shop (cash, transfers, money
  between your own accounts or to savings, bank fees).

You don't have to take our word for it. The parts that touch the network are `data_update()` and `ask_online()`.
The request is built by `request_body()`: it's just `{"merchants": ["ZZQ WIDGETS LTD", ...]}`, with `"country": "IE"`
added only when your bank's country isn't GB. It carries the website's public key, which is the same for everyone.

## Get it and check it

Download `kys.py` from [knowyourspend.org/statements](https://knowyourspend.org/statements#run-it-yourself). The page
shows the file's SHA-256 checksum. Work out the checksum of your copy and check the two match:

```bash
shasum -a 256 kys.py                          # macOS
sha256sum kys.py                              # Linux
certutil -hashfile kys.py SHA256              # Windows (Command Prompt)
Get-FileHash kys.py -Algorithm SHA256         # Windows (PowerShell)
```

If they don't match, don't run it, and tell us at the address on our website.

## Use it

First, download the ownership list (once, and now and again to get our latest answers):

```bash
python3 kys.py data update
```

On Windows, type `python` or `py` instead of `python3`.

### One line of bank text

```bash
python3 kys.py lookup "COSTA COFFEE 43012 LONDON GB"
```

```
COSTA COFFEE 43012 LONDON GB  (cleaned to "COSTA COFFEE")
  Costa Coffee is owned by The Coca-Cola Company, run from the United States.
  Owner:        The Coca-Cola Company (United States)
  Chain:        Costa Coffee (United Kingdom) → The Coca-Cola Company (United States)
  How we know:  From official registers, last checked 28 Sept 2026
  Matched:      "COSTA COFFEE" in the text
  Source:       Wikidata Q608845  https://www.wikidata.org/wiki/Q608845
  ...
```

It understands what banks add around a shop's name: `PAYPAL *NETFLIX` is Netflix, `VIS KLARNA*ZARA` is Zara,
`AMZN MKTP UK*2A3B45CD6` is Amazon and `JDSPORTS` is JD Sports. It answers in the same order as the search box on
our website:

1. **An owner**, from our built-in list.
2. **A local independent business**: `SQ *THE BEAN HOUSE` was paid with a Square card reader, so there's no owner
   to look up.
3. **Held back**: a name that could say something sensitive about you (`MARIE STOPES`), or that looks like a
   person's (`J SMITH`, `PAYPAL *JOHNSMITH`, `BANK TRANSFER TO DAVID JONES`).
4. **Not a payment to a shop**: `CASH WITHDRAWAL`, `VANGUARD ISA`, a transfer or a bank fee.
5. **Not in our list**: add `--online` to ask our online look-up.

Options:

- `--country IE`: your bank's country, or where you paid, as a two-letter code (the default is GB). A country named
  in the text itself counts first: `COSTA COFFEE DUBLIN IE` is read as paid in Ireland. Some brands only trade in
  one country and only match there: `python3 kys.py lookup "ABC HELSINKI" --country FI`.
- `--json`: the answer as JSON.
- `--online`: if our list doesn't know the shop, ask our online look-up (it shows you the name first).

### A whole statement

Save a statement from your bank as CSV, then:

```bash
python3 kys.py statement my-statement.csv
```

It prints your spending by the country of each shop's owner, and saves one line per shop to
`my-statement.owners.csv`, next to your statement: the shop, how much you spent there, the owner, the owner's
country, how we know and our sources.

It works out which columns to read from their headings: the shop from Description, Payee, Merchant, Name,
Narrative, Details, Transaction Description or Counter Party; the amount from Paid out, Money out, Debit or Amount
(where a negative amount is money out). It also reads the payment type (card payment, transfer, direct debit…) when
there's a column for it. If it guesses wrong, or your file has no headings, say which columns to use:

```bash
python3 kys.py statement my-statement.csv --column "Description" --amount-column "Paid out"
python3 kys.py statement my-statement.csv --column 2 --amount-column 3     # column numbers, counting from 1
```

- Transfers that may be to people, cash withdrawals, money between your own accounts and bank fees aren't counted
  as spending. Refunds come off the shop's spending.
- Card statements (American Express and many credit cards) show spending as positive numbers. Add
  `--spend-positive` for those; the script says when it thinks you need to.
- `--details` also prints every shop and its owner; `--out FILE` saves the list somewhere else; `--json` prints
  everything as JSON instead.
- `--country`: your bank's country (the default is GB). As in the app, each payment's own country is read from the
  bank's text when it names one (a country code, a town or a currency at the end), and brands that only trade in
  one country only match there.

### Looking up shops our list doesn't know

```bash
python3 kys.py statement my-statement.csv --online
```

You see the exact list of names first, and nothing is sent unless you type `y`. (`--yes` sends without asking, for
scripts.) Up to 60 names go in each request. A name nobody has asked about before can take up to two minutes, while
the look-up checks the company registers and asks an AI to research it. Each answer is one of these:

- **Who owns it**, shown just like an answer from our list and marked "Answered by: our online look-up".
- **A small local business**, so there's no owner to look up.
- **Not a business**: it looks like a person's name or something else.
- **Owner not found**: the registers and the AI couldn't say who owns it.
- **Couldn't check it just now**: try again later. If the look-up has used up today's research, it says so: names
  it already knows still work, and new ones can be tried again tomorrow.

If the look-up is busy, the script waits as long as it's asked to (up to two minutes) and tries again. If you've
looked up a lot of new names today, it asks you to try again tomorrow. If the look-up can't be reached or turns the
request down, the script says so politely, still prints and saves everything it worked out offline, and finishes
with exit code 3.

### Other commands

```bash
python3 kys.py data status                 # which ownership data is in use, and how old it is
python3 kys.py lookup "TESCO" --data DIR   # read the data files from a folder instead, such as
                                           # packages/ownership/data in a copy of the source code
python3 kys.py --help
```

Settings, if you need them:

| Setting | What it does |
|---|---|
| `KYS_CACHE_DIR` | Where `data update` saves the list (default `~/.cache/knowyourspend`, or `%LOCALAPPDATA%\knowyourspend` on Windows) |
| `KYS_DATA_URL` | Where the list comes from (default `https://knowyourspend.org/data/manifest.json`) |
| `KYS_API_URL`, or `--api-url URL` | Where `--online` sends names (default `https://cxvwngmnkxtweuwaxfmz.supabase.co/functions/v1/kys-lookup`, our look-up service) |
| `KYS_API_KEY` | Your own key for the online look-up, sent as `Authorization: Bearer …` instead of the website's public key. Leave it unset unless we've given you one. |

Exit codes: 0 when all went well, 1 for a problem with a file, the ownership data or downloading it, 2 for a mistake
in the command, and 3 when the online look-up couldn't answer (everything worked out offline is still printed).

## How we know

Every answer says where it came from:

| Label | Meaning |
|---|---|
| Checked by a person | A person checked each step against company filings and official registers. |
| From official registers | Two public records agree on the top company: Wikidata and the Global LEI register (GLEIF). |
| From the UK company register | From our online look-up: Companies House has one active company with exactly this name, and its filings name each owner in turn. |
| From public records | Public records support it, but they don't confirm each other. |
| Open data | From OpenStreetMap's list of shop brands, or found by name in Wikidata, with the owner from Wikidata. No register confirmed it. |
| AI-corrected open data | As above, but Wikidata's owner looked out of date, so an AI review replaced it. |
| AI-assisted research | Researched with an AI's help from what was publicly reported. A person hasn't checked it. |
| AI estimate | From our online look-up: an AI (Mistral) was asked who owns it, sometimes with a web search. Treat it as a good guess. |

We count the country the top company is run from, not where it's registered. It says nothing about where the staff
are, where tax is paid or where the products are made.

## What it doesn't do (yet)

- It reads CSV files only, not PDF statements. Most banks let you save a statement as CSV.
- The app recognises each bank's file format. This script guesses the columns instead, so for card statements you
  may need `--spend-positive`.
- On our website you can choose to look up a held-back name anyway. This script never sends one.

## For developers

`dist/kys.py` is built, not written by hand: `kys.template.py` is the logic, ported function by function from the
TypeScript in `packages/statement`, `packages/ownership` and `packages/core` (the comments say which), and
`build.mjs` adds the tables (bank prefixes, place names, sensitive words, shorthand, the look-up's address and public
key from `apps/site/site.config.json`…) by running the TypeScript files and copying their constants, translating
regular expressions to Python's syntax. So the tables can't drift.

```bash
node tools/python/build.mjs                    # rebuild dist/kys.py
node tools/python/build.mjs --check            # fails if dist/kys.py is out of date
pnpm --filter @kys/ownership exec tsx ../../tools/python/vectors.ts            # rebuild vectors.json
pnpm --filter @kys/ownership exec tsx ../../tools/python/vectors.ts --check    # fails if vectors.json is out of date
python3 -m unittest discover -s tools/python   # the tests
```

`vectors.ts` runs the real TypeScript engine over 1,460 payee texts and 293 statement rows (the coverage bench, the
normaliser's golden cases, every row of the statement fixtures including the PDFs, the strings in the unit tests,
names from the ownership list, random combinations and hand-picked tricky ones), plus amounts, payment types and
answers from the online look-up, and writes `vectors.json`. `test_kys.py` checks the Python gives exactly the same
answer to every one: the cleaned name, whether it looks like a person or is sensitive, the type of payment, where it
was paid, the match (status, entry, method, alias, cleaned text), what the website's search box says about it
(owner, local, held back, not a shop or unknown, and why), and how an online answer is labelled and worded. It also
tests reading CSV files, the summary, `data update` against a local server and `--online` against a mock of the
look-up (the exact request body and headers, batches, limits, errors and time-outs). For a bigger check,
`vectors.ts --fuzz 30000 --out /tmp/fuzz.json`, then `KYS_VECTORS=/tmp/fuzz.json python3 -m unittest discover -s
tools/python`.

## Licence and credits

MIT licence, © 2026 the KnowYourSpend authors (the licence text is at the end of `kys.py`). The KnowYourSpend name
and logo aren't covered by the licence.

The ownership list is built from:

- [OpenStreetMap's name-suggestion-index](https://github.com/osmlab/name-suggestion-index) (BSD-3-Clause)
- [Wikidata](https://www.wikidata.org) (CC0)
- [GLEIF](https://www.gleif.org), the Global LEI register (CC0)
- [Companies House](https://www.gov.uk/government/organisations/companies-house) (Open Government Licence v3.0)

The town and city names `kys.py` uses to tell where a payment was made are from
[GeoNames](https://www.geonames.org) ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)), reduced to names
and country codes.

See `open-source/NOTICE` in the source code for the full terms.
