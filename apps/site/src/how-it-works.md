---
title: How we work out where your money goes
updated: 18 October 2026
---

# How we work out where your money goes

For every payment on your statement, KnowYourSpend answers one question: **which country is the company at the top of this business run from?** This page explains exactly how we get that answer, how sure we are, and where it can go wrong. In the app, tap any shop to see the reasons for that shop.

## The question we answer

We follow who controls a business up to the company at the top, the one no other company controls, and count the country that company is run from: its head office.

| Your bank wrote | Who's at the top | Counted as |
|---|---|---|
| TESCO STORES 3456 | Tesco PLC | United Kingdom |
| LIDL GB LONDON | Schwarz Group | Germany |
| COSTA COFFEE | The Coca-Cola Company | United States |
| MCDONALDS 1234 | McDonald's Corporation, which owns the brand (most outlets are franchises) | United States |
| SPOTIFY | Spotify Technology S.A., registered in Luxembourg but run from Stockholm | Sweden |
| VIRGIN MEDIA | Virgin Media O2, owned half by Telefónica (Spain) and half by Liberty Global (US) | United Kingdom |
| SQ *THE BEAN HOUSE | A small local café, paid with a Square card reader | United Kingdom, as a local independent |

The country tells you who ultimately owns the business you paid. It doesn't tell you where the staff work, where tax is paid or where the products are made.

## 1. Recognising the payment, on your phone

KnowYourSpend carries its own list of who owns over {{BRANDS}} shops and brands, so most payments are matched on your phone and nothing is sent anywhere.

Banks print shop names in their own shorthand: shortened, run together, with store numbers, towns and references. Before matching, the app:

- drops store numbers, dates and references, so "TESCO STORES 3456 LONDON" is Tesco;
- knows bank shorthand like AMZN, MKTP and SMKT;
- finds names with the spaces missing, like JDSPORTS;
- recognises web addresses, like netflix.com;
- allows one letter out in long names, as banks sometimes cut or misprint them.

To avoid false matches, a brand whose name is an everyday word only matches at the start of the payment, and a brand that only trades abroad only matches payments made abroad. Payment services that put their name in front of the shop's, like "PAYPAL *NETFLIX", are looked through: we count the shop behind them.

Where the list comes from:

- **{{HAND}} shops, services and grocery brands researched one at a time, with an AI's help.** Where Wikidata (an open database of companies) and the Global LEI register agree on the top company, that's the answer. Where they disagree or are out of date, often after a takeover, the answer rests on published reports, cited in the app where we have one.
- **About {{OPEN}} more brands from OpenStreetMap's list of shop brands**, each linked to Wikidata, with owners from Wikidata's records. An AI review re-checked the UK and Irish ones for takeovers Wikidata had missed: it corrected {{FIXES}} owners, and dropped {{DROPS}} brands that have closed, no longer trade here, or aren't businesses people pay.

None of the list has been checked by a person yet. We'll start with the brands people pay most.

## 2. Small local businesses

Most payments to small businesses, like a café, a market stall or a barber, will never be on any list, and no public register says who owns them. We don't guess an owner. We count them as **Local independent**, in the country where you paid them, because almost all of them are owned there.

We spot them in three ways:

1. **A card reader small businesses use.** If the name in your bank's text comes after "SQ *" (Square), "SUMUP *" (SumUp), or "ZETTLE_*" or "IZ *" (Zettle by PayPal), and it isn't a chain we know, it's a local independent. A chain paid this way, like "SQ *TESCO STORES", is still the chain.
2. **A word that usually means one local business:** CAFE, DELI, BAKERY, BUTCHER, BARBER, FISH BAR, KEBAB, FLORIST, NEWSAGENT, OFF LICENCE or TAKEAWAY, in a name that isn't a chain we know. We leave out words chains use in their names, like COFFEE, PIZZA and EXPRESS.
3. **Our online look-up says so:** its AI step found a small local business rather than a chain, and named no owner (see below).

Names spotted the first two ways are never sent to our look-up. Where you paid is read from the country code, country name, town or web address your bank prints, and is otherwise your home country, which you can change in Settings → Shops we don't know. If one of these is really part of a bigger company, set its country yourself.

## 3. The online look-up, if you allow it

A shop that isn't on the list, and doesn't look like a local independent, can be looked up online. By default this happens when you add a statement. You can change it to "Ask me" or "Never" in Settings → Shops we don't know.

**What's sent:** only the shop's name, as your bank printed it, tidied up: for example "THE BEAN HOUSE". Never amounts, dates, balances, account details or anything about you. When the app asks again about a name whose answer was still waiting for its full check, it marks the name as asked before, so the look-up doesn't count it as someone else asking. Names that look like a person, and names that could reveal something sensitive (health, gambling, dating, religion, politics, trade unions, debt or adult content), are held back. You see the list before it's sent, and can stop it.

**What the look-up does,** in this order, stopping at the first good answer:

1. Reuses the answer it gave anyone else for the same name, if it's still fresh.
2. For UK statements, checks a list of answers we can add on the server without an app update (empty so far).
3. Looks for the name on Wikidata and follows its owners up to the top. If the Global LEI register (GLEIF), where companies file their parent company for financial regulators, names the company at the top, or has no parent recorded above the one Wikidata ends at, that's the answer.
4. For UK statements, looks for exactly one active company with that name at Companies House, the UK's official company register, and follows its filings of who controls it up to the top.
5. Takes Wikidata's answer on its own, if it has one.
6. Asks an AI: Mistral, a French AI company.

When a register's answer is weak, the AI is asked too, and its answer is used if it's sure. A register's answer is weak when the Companies House chain stops at a UK company (the owner abroad often isn't in UK filings), when it comes from Wikidata alone, or when the top company sits somewhere companies often register for tax or legal reasons: Jersey, Guernsey, the Isle of Man, Luxembourg, the Cayman Islands, the British Virgin Islands, Bermuda, Gibraltar, Cyprus or Malta. A Wikidata match on only part of the name is never used on its own: only the AI's answer can be.

**How the AI step works:**

- The AI is asked five times at once. At least three of its answers must name the same owner's country, or we don't use them.
- The owner it names is looked up on Wikidata and GLEIF.
- Unless all five answers agree and a register confirms the owner, a second AI model checks with a web search, and its answer is used when it's sure who the owner is.
- The web search's owner isn't used when it still calls the business small and local, or, for a name the five answers called local, doesn't call it a chain or an online business (it once named an unrelated company for a made-up café). The business then counts as a local independent, except that an owner abroad from the five answers means no answer, and an owner at home that a register confirms is kept.
- There's no web search if any answer took the name for a person or not a business, once 200 have run that day, or after the first minute of a look-up. The five answers then stand, checked against the registers; when only the daily limit or the time stopped the web search, the answer is kept for just 3 days, so it gets its web search soon.
- If most answers say the name is a person or not a business, no owner is named, and the payment is counted where you paid, marked Estimated. If they say it's a small local business and nothing finds an owner, it's counted as a local independent.
- To keep costs down, the first time anyone asks about a name, it gets no web search if the answers call it a small local business (and none is sure it's owned abroad) or can't tell what kind of business it is. That answer is kept for only 3 days, and the full check comes once more than one phone has asked about the name. Your phone asks again when you next add a statement with it, marking it as asked before so it isn't counted as another phone; if nobody else has asked by then, it waits 30 days before asking again.
- An AI answer that names an owner is labelled "AI estimate"; one that finds a small local business is labelled "Local independent". Both say whether a web search checked them.

**What we keep:** each name and its answer, shared by everyone so the next person gets an answer straight away. An answer is used for 3 days to a year, depending on how well it was checked; after that it isn't used again, but stays in the database until the name is next looked up, when it's replaced. And, for each name answered except those the AI step decides aren't a business, how many look-ups have asked about it, until a year after the latest. Nothing about who asked, and since 18 October 2026 times only to the day. Mistral keeps what it's sent for up to 30 days to check for abuse. Every place your data can go is listed on [our home page](/#transparency).

## 4. Everything else: counted where you paid

A shop we can't name an owner for, and that doesn't look like a local independent, is counted in the country where you paid it and marked **Estimated**. An unknown shop in Lewisham is almost always owned in the UK; one in Málaga, in Spain. The country comes from the same clues: a country code, country name, town or web address in your bank's text, or else your home country. You can switch this off in Settings → Shops we don't know → Estimate them from where you paid; then these payments, and local independents, aren't counted at all.

## 5. Your choice comes first

Tap any shop in the app and choose **Set the country myself**. Your answer is used for every payment to that shop, is kept with the rest of your data, which only you can read, and always wins over ours.

## The rules we follow

- **Franchises:** we count the brand owner, not the local franchisee. The McDonald's you visit may be run by a local company, but McDonald's Corporation owns the brand and is paid for its use.
- **Private equity:** the private-equity firm counts as the owner, in the country the firm is run from, not where its funds are registered.
- **Run from, not registered in:** companies are often registered in Luxembourg, Jersey, the Cayman Islands or Delaware for tax or legal reasons. We count where the top company is run from, and the app shows both when they differ.
- **No single controlling owner:** a listed company with no controlling shareholder is its own top company. When no one company has control, as in a 50:50 joint venture, we count the country of the business itself and list its owners.
- **Families, co-operatives, mutuals, employee trusts and governments** can be the top owner too.
- **Marketplaces and delivery apps:** when you pay Amazon Marketplace, eBay or Deliveroo, the seller or restaurant behind the payment isn't on your statement, so we count the platform.
- **Payment services:** PayPal, Klarna or Clearpay count as themselves only when your bank doesn't show the shop behind them.
- **Takeovers:** only completed ones. A deal that's been agreed but hasn't completed doesn't change the owner.

## How sure we are

Every answer in the app has a label saying where it came from. The badge next to an owner says how sure we are: **Checked**, **Matched** or **Unverified**.

| Label | Badge | What it means |
|---|---|---|
| Checked by a person | Checked | A person checked each step against company filings and registers. None has been yet. |
| From official registers | Matched | Wikidata's ownership records, followed to the top company, which the Global LEI register names or has no parent recorded above. |
| From the UK company register | Matched | Companies House filings, followed up to the top company. |
| From public records, or Open data | Matched | Found in public records or open data (Wikidata, the Global LEI register, or OpenStreetMap's list of shop brands), but the sources don't confirm each other, or no official register does. |
| AI-assisted research | Unverified | From our own list: the registers were out of date or incomplete, so the answer rests on published reports, researched with an AI's help. |
| AI-corrected open data | Unverified | An AI review replaced an owner in the open data that looked out of date. |
| AI estimate | Unverified | From the online look-up's AI step. |
| Local independent | | A small local business, counted where you paid. |
| Estimated | | We don't know the owner, so it's counted where you paid. |
| You set this | | Your own choice. |

## How accurate it is

We test the online look-up's AI step on 185 names: 60 chains and 90 brands from the built-in list, 20 names that aren't a business we can name (people's names, words like CAFE and TAXI, banking terms), and 15 made-up small local businesses. For the chains and brands, the right answer is the built-in list's, which no person has checked yet, except 23 we checked by hand because the list looked out of date or unclear: 17 now have a hand-checked answer, and 6 are left out because the right answer isn't clear. An answer is right when the payment ends up counted in the right country: for the made-up local businesses that's the UK, where they were paid, and for the names that aren't a business, naming any owner is wrong. In the latest test, on 17 October 2026, of the 179 names scored:

| | Right | Wrong | No answer |
|---|---|---|---|
| With the full check | 177 | 2 | 0 |
| The first time anyone asks about each name | 173 | 5 | 1 |

These are names we chose, and many are well known, so real statements, with more small and unusual shops, will do worse. The built-in list hasn't been measured this way yet, and we haven't yet measured accuracy on a large number of real statements.

Where it goes wrong:

- **Recent takeovers.** Registers and the AI's knowledge lag behind sales, so a takeover from last month may not show yet.
- **Two businesses with the same name.** A name on a statement can belong to more than one company.
- **Holding companies.** Ownership often runs through companies set up for tax or legal reasons, and filings don't always name the company above them.
- **Small chains that look local.** A shop that looks independent may belong to a group.

## Keeping it up to date

The built-in list is updated with the app. Look-up answers are used for 3 days to a year, depending on how well they were checked: a year when a web search checked them, or when all five AI answers agreed and a register confirmed the owner; 3 days when an answer is still waiting for its web search. After that, the next look-up of the name starts again. Your phone keeps the answers it was given. It asks again only about an answer that was still waiting for its full check, and, after 30 days, about a shop the look-up couldn't answer, so a takeover after that won't reach it until we correct our list. Ownership changes all the time, so if you spot a mistake, [tell us](mailto:{{EMAIL}}?subject=Ownership%20mistake) and we'll fix it for everyone.

## Sources and licences

- OpenStreetMap's list of shop brands (the name-suggestion-index), © OpenStreetMap contributors, BSD 3-Clause licence: https://nsi.guide
- Wikidata, CC0: https://www.wikidata.org
- The Global LEI register (GLEIF), CC0: https://www.gleif.org
- Companies House, Open Government Licence v3.0: https://find-and-update.company-information.service.gov.uk
- GeoNames, for town names, CC BY 4.0: https://www.geonames.org
- Mistral AI, for the AI step: https://mistral.ai

## Check it yourself

- In the app, tap any shop for **Why this country?**: what your bank wrote (which only you can see), how we recognised it, who owns it step by step, how we know, the rules we applied and the sources.
- Settings → What we can see lists every look-up the app has sent, with exactly what was in it.
- The code is open source: [{{SOURCE_LABEL}}]({{SOURCE}}).
- Spotted a mistake? Email {{EMAIL}} and we'll fix it for everyone.
