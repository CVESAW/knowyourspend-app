# @kys/ownership

Starter ownership dataset and on-device resolver for KnowYourSpend. It maps a bank-statement payee or till-receipt line to a brand, then to the operator and brand owner, then to the ultimate parent. It returns the country that ultimate owner is run from (`owner_country`, which drives the pie chart) and, where known, where it is incorporated (`legal_country`, used only in the legally-gated "where registered" view).

```ts
import { createResolver, allEntries, badgeFor, isPublishable, countries } from "@kys/ownership";
const r = createResolver(allEntries);
r.resolve("TESCO PFS 3342");            // { status: "RESOLVED", entry: tesco, via: "local_list", matched_alias: "TESCO PFS" }
r.resolveProduct("HNZ BEANZ 415G");     // -> heinz
r.resolveProduct("TESCO BAKED BEANS");  // { status: "UNRESOLVED", own_brand_retailer: tesco }
```

| Script | Command |
|---|---|
| Validate data + tier rules | `pnpm --filter @kys/ownership validate` (or `npx tsx scripts/validate.ts`; add `--strict` to fail on alias collisions) |
| Tests | `pnpm --filter @kys/ownership test` |
| Typecheck | `pnpm --filter @kys/ownership typecheck` |

## The tier ladder

A tier says **how an answer was obtained**, not how likely it is to be right. "IDs matched" does not mean "owner is current": Asda had an exact ID match with both registries agreeing, and the owner was still wrong (Walmart instead of TDR Capital).

| Tier | Meaning | Rule (enforced by `scripts/validate.ts`) | UI badge |
|---|---|---|---|
| `CURATED` | A **named human** reviewed every hop against primary sources. | `reviewed_by` and `reviewed_at` set; `sources` non-empty; every owner hop has a `source_url` and none has `source: "llm"`; `as_of` and `reviewed_at` within **180 days** of today. | **Checked** |
| `EXACT_ID` | Derived from registry identifiers that agree: the Wikidata QID parent chain and the GLEIF LEI ultimate parent point to the same entity, and the result matches current reality. | The chain must contain a `wikidata` hop with a `source_id` (QID) **and** a `gleif` hop with a `source_id` (LEI). | **Matched** |
| `NAME_MATCH` | Found in open data (by name search, or from a single registry) but the identifiers are **not cross-confirmed**. Examples: Wikidata only; GLEIF only; the two agree on country but not entity. | At least one open-data identifier or source. | **Matched** |
| `LLM_GUESS` | From model or analyst knowledge. This includes **corrections of stale registry data**, even when a press release was fetched to check it. | None; the entry must be reviewed before any public use. | **Unverified** |

A fetched primary source (company site, press release, filing, GLEIF record) is always recorded in `sources` and described in `technique`. It does **not** raise the tier: the tier reflects the strongest *registry* technique, and only a named human review makes an entry `CURATED`. So Boots → Sycamore is `LLM_GUESS` even though the Sycamore completion press release is cited, because both registries still say Walgreens.

The tier refers to the chain that sets `owner_country` (brand to ultimate parent). An extra `operator` hop added from analyst knowledge (for example a UK franchisee) carries its own `source: "llm"` and does not change the tier of an `EXACT_ID` entry.

### What each tier may be used for

- **Private, on the user's own device and dashboard:** all tiers may be shown, each with its badge (`badgeFor(tier)`). `LLM_GUESS` entries always show "Unverified", and the UI should make it easy to report a wrong owner.
- **Anything published or shareable** (share cards, public pages, reports, press, social posts): **only `CURATED` entries that pass `isPublishable(entry, today)`**. Everything else must be dropped or shown as "not yet checked". This is the publication gate from launch-readiness §12.5.
- The starter list contains **no CURATED entries**. Every entry has `reviewed_by: null` and `reviewed_at: null`, so nothing is publishable yet.

## How to promote an entry to CURATED (review checklist)

1. **Confirm each hop** (brand, operator, owned_by, ultimate_parent) against a **primary source dated within 180 days**: an annual report or filing, Companies House PSC, a GLEIF record (check `registration.status` is ISSUED, not LAPSED), the company's own "about us" or investor pages, or a deal-completion press release from a party to the deal. Wikipedia, news aggregators and model output are leads, not evidence.
2. **Check for 2023–2026 events**: take-privates, PE secondaries, mergers, demergers, redomiciles and administrations. Search "<company> acquired/completes/sold" for the last 12 months.
3. **Record the evidence**: put a `source_url` on every hop and a `{label, url}` for each document in `sources`. Replace any `source: "llm"` with the real source kind.
4. **Set countries**. `owner_country` is where the ultimate parent is *run from*. `legal_country` comes from GLEIF `entity.jurisdiction`, never from Wikidata P17. Check that `owner_country` equals the last hop's `country`.
5. **Apply the rules below** (franchise, PE, JV, public body). Rewrite `notes` so a later reviewer can see what was decided and why.
6. Set `as_of` and `reviewed_at` to the review date, `reviewed_by` to the reviewer's name, and `tier: "CURATED"`.
7. Run `pnpm --filter @kys/ownership validate` and `test`. The validator rejects CURATED entries with no reviewer, unsourced hops, LLM hops, or stale dates.
8. **Re-review before the 180-day window lapses.** Once expired, an entry fails validation until it is re-reviewed or demoted to its registry tier.

## Ownership rules

- **owner_country vs legal_country.** `owner_country` is the ISO2 country the **ultimate owner is run from** (its operational HQ) and drives the main pie chart. `legal_country` is where the ultimate parent is **incorporated** and must come from GLEIF `entity.jurisdiction`; it is used only in the legally-gated view. Wikidata P17 is never used for either flag, because it missed Boohoo, B&M (both Jersey), AliExpress and CK Hutchison/CK Asset (both Cayman). Examples: Superdrug is `HK` / `KY`; B&M is `GB` / `JE`; Spotify is `SE` / `LU`. Where "run from" is contested (Temu: Dublin HQ, but founders and operations in China; SHEIN: Singapore vs China), the entry follows the registered principal office and a note asks the curator to decide.
- **Franchise rule.** `owner_country` is the ultimate parent of the **brand owner**. The company you actually pay (the UK franchisee or master franchisee) appears as an `operator` hop and is shown in the UI as "who you pay", but does not move the pie slice. Examples: Domino's is brand owner Domino's Pizza, Inc. (US), with operator Domino's Pizza Group plc (UK master franchisee); McDonald's, KFC, Pizza Hut, Subway and Burger King follow the same pattern (Burger King UK is owned by Bridgepoint, but the brand owner is RBI, CA). Fuel brands (Shell, BP, Esso, Texaco) work the same way: forecourts are often dealer-run.
- **Brand-owner rule for products.** Local bottlers and licensees (Coca-Cola Europacific Partners, Carlsberg Britvic for Pepsi, Arla for Anchor in the UK) are operator hops; the brand owner sets the country.
- **Private-equity rule.** A PE or investment firm that controls a company is its **ultimate parent** (Asda → TDR Capital, Morrisons → CD&R, Boots → Sycamore, Wagamama → Apollo, Very → Carlyle, PureGym → Leonard Green). `owner_country` is where the **manager** is run from, not where the fund vehicles are domiciled. Minority co-investors go in `notes` (and in `co_owners` with `shared_ownership: true` when material).
- **JV / consortium rule.** When two or more parents share control and none has a majority (Virgin Media O2 50:50 Telefónica/Liberty Global; Ocado Retail 50:50 Ocado/M&S; Tesco Mobile; the Thames Water consortium), the **JV or holding company itself is the `ultimate_parent`**, `shared_ownership: true`, and each parent is listed in `co_owners` with country and share. The UI should show a "joint venture" caveat or split the slice by `co_owners` instead of showing a single flag. When one parent holds a **majority** (Virgin Atlantic 51% Virgin, Andrex/Arbex 51% Suzano, Eurostar ~56% SNCF), that parent is the ultimate parent and the entry still sets `shared_ownership: true`.
- **Family / natural persons.** People are never chain hops. The top company is the ultimate parent (Mars, Ferrero, Haribo, Warburtons, Red Bull GmbH), with major family holders in notes or `co_owners`.
- **Public bodies.** UK public bodies (TfL → GLA, DVLA, HMRC, councils, DfT-operated railways, TV Licensing/BBC, Post Office) have `owner_country: "GB"`, with the controlling department as ultimate parent. Foreign state ownership is a normal chain (EDF → French State).
- **Marketplaces and PSPs.** `intermediary: "psp"` marks PayPal, Klarna and Clearpay. The resolver prefers any real merchant in the same string (`PAYPAL *NETFLIX` → Netflix). When only the PSP matches, the PSP is returned and its notes say the real seller is hidden. Marketplaces (Amazon Marketplace, eBay, Etsy, Uber Eats, Deliveroo, Airbnb, App Store) are attributed to the platform that collects the payment, and notes say so. Card acquirers (`SQ *`, `SUMUP *`, `ZETTLE_*`, `IZ *`) are stripped. If nothing then matches, the result is `LIKELY_INDEPENDENT`.
- **Retailer own-brand.** Own-brand products ("TESCO BAKED BEANS") are attributed to the retailer on the receipt header, not resolved as a product brand. `resolveProduct` returns `UNRESOLVED` with `own_brand_retailer` set.

## Resolver behaviour (`src/resolve.ts`)

- **Normalise** (`normalise()`): strip diacritics, upper-case, delete apostrophes, turn every other character except `A–Z 0–9 &` into a space, and collapse spaces. Aliases get the same normalisation, so `TESCO.COM` matches `TESCO COM` and `COCA-COLA` matches `COCA COLA`.
- **Match** aliases at word boundaries only (`ICELANDAIR` ≠ `ICELAND`). The **longest alias wins**. Ties go to the merchant in `resolve()` and the product brand in `resolveProduct()`, then to the higher tier.
- `resolveProduct()` looks only at product brands; a merchant hit is reported only as `own_brand_retailer`.
- **`LIKELY_INDEPENDENT`** is deliberately conservative. It fires only when nothing matched, and only if the text contains `CAFE, DELI, BAKERY, BUTCHER(S), BARBER(S), FISH BAR, KEBAB, FLORIST, NEWSAGENT(S), OFF LICENCE, TAKEAWAY`, or started with a card-acquirer prefix. Chain-like words (COFFEE, PIZZA, EXPRESS, CAFFE) are excluded.
- The resolver is pure: it does no I/O and needs no Node APIs. Statement text never leaves the device.
- Also exported: `tierRank` (CURATED 4 > EXACT_ID 3 > NAME_MATCH 2 > LLM_GUESS 1), `isPublishable(entry, today)` and `badgeFor(tier)`.

Aliases must be unique across entries. The validator reports collisions; `--strict` fails on them. Generic words (`APPLE`, `NEXT`, `THREE`, `NOW`, `VERY`, `BOLT`) are deliberately **not** aliases; only qualified forms (`APPLE.COM/BILL`, `NEXT RETAIL`, `THREE.CO.UK`, `NOW TV`, `VERY.CO.UK`, `BOLT.EU`) are.

## How future tiers plug in

1. **Local list (this package)** is checked first on the device. Result: `via: "local_list"`.
2. **Remote lookup service (later).** For `UNRESOLVED` strings (after the transaction-type filter, merchant rows only), the app can call the lookup service. That service runs the registry pipeline: override table → NSI `brands/*` → WDQS search → P749/P127 chain rules → GLEIF Level-2. It returns an `OwnershipEntry` with the tier it actually earned: `EXACT_ID` if Wikidata and GLEIF agree, `NAME_MATCH` if single-source, and `LLM_GUESS` when the LLM proposer produced it. Results come back as `via: "remote"`, and the service never promotes anything to `CURATED`.
3. **Weekly freshness re-run.** Re-run the registry pipeline over every entry, diff the top parents, and flag GLEIF records that turned LAPSED or changed relationships, plus M&A news for tracked merchants. Changed entries are demoted from `CURATED` and queued for review. `as_of` is bumped only when a chain is actually re-checked. Entries marked **IN FLUX** in notes (Thames Water, TalkTalk, Poundland, Boots, Travelodge, Avanti West Coast, Very) should be checked monthly.
4. **Promotion** stays a human step (checklist above). Seed the review queue with the `LLM_GUESS` merchants listed by `validate`, starting with the ones that carry the most spend.

## Data files

See `data/README.md`.
