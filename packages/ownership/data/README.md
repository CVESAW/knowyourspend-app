# Ownership data

| File | Contents |
|---|---|
| `merchants.json` | `OwnershipEntry[]` with `kind: "merchant"`: UK consumer merchants as they appear on bank statements (supermarkets, coffee/fast food, delivery/transport/post, online and marketplaces, subscriptions, telecoms, energy/water, fuel, high street, travel, gyms, pubs/gambling, PSPs, UK public bodies). |
| `product-brands.json` | `OwnershipEntry[]` with `kind: "product_brand"`: grocery and household brands, with abbreviated till-receipt aliases. Retailer own-brand lines are not listed; they are attributed to the retailer. |
| `countries.json` | ISO 3166-1 alpha-2 → `{ name, flag }` for every country used in the data, plus common ones. Jersey, Guernsey, Isle of Man, Gibraltar, Bermuda, BVI and Cayman are included because they matter for `legal_country`. |

Provenance, as of 2026-09-28:

- Registry facts (QIDs, LEIs, agreement flags) come from the coverage experiment (`research_notes/KnowYourSpend launch readiness/data/coverage_results.csv`: Wikidata Query Service, GLEIF API golden copy 2026-09-28, name-suggestion-index v6.0.20250817) and its spot-check verdicts (`data_coverage.md`).
- Recent ownership changes were checked against fetched press releases or company pages on 2026-09-28, and each is cited in the entry's `sources`. These include Asda, Boots, Three, Deliveroo, Just Eat, Poundland, Very, TalkTalk, Evri, Thames Water, Travelodge, PureGym, Hovis/Kingsmill, Kellanova, Magnum, PG Tips, Andrex/Arbex, JDE Peet's and Kraft Heinz.
- Everything else is analyst/model knowledge and is tagged `LLM_GUESS`.

**No entry has been human-reviewed:** all have `reviewed_by: null`, and no entry is `CURATED` or publishable. Edit the JSON directly, following the checklist in `../README.md`, and run `pnpm --filter @kys/ownership validate` after every change. Aliases are stored upper-case and may contain punctuation. The resolver normalises them (see `normalise()`), and the validator checks uniqueness on the normalised form.

Additions to the base schema (all optional): `category`, `co_owners[]` (JV/consortium parents with shares), `intermediary` (`"psp"` or `"marketplace"`), and on `Resolution`, `own_brand_retailer` and `reason`.
