# Look-up service (Supabase Edge Functions)

The app sends the names of shops it doesn't know — nothing else — and this service works out who owns them.
Two Edge Functions in Supabase project `cxvwngmnkxtweuwaxfmz` (Ireland):

- **kys-lookup** — the live look-up the app calls (`verify_jwt` on). Deploy `kys-lookup.ts` as `index.ts`
  with `lookup.ts`, `registries.ts` and `ai.ts`.
- **kys-llm-eval** — the test bench for the AI step (`verify_jwt` off; an `x-eval-token` header whose SHA-256
  is in the source is the check). Deploy `kys-llm-eval.ts` as `index.ts` with `registries.ts` and `ai.ts`.
  It runs the same `ai.ts` as the live look-up and stores nothing.

The code is plain JavaScript in `.ts` files: the original TypeScript was lost on 2 Oct 2026, and the look-up
was recovered from its deployed bundle on 12 Oct.

## What happens to a name

1. **Cache** — answers found before, kept per name (and per bank country, for banks outside the UK).
2. **Our list** (`kys_reference_entries`).
3. **Wikidata + GLEIF** — the exact name on Wikidata, its owner chain followed, and the top company confirmed
   by the global LEI register.
4. **Companies House** — UK banks only: one active company with exactly that name, with its owners from its
   "persons with significant control" filings.
5. **Wikidata alone** — an owner chain GLEIF can't confirm.
6. **AI estimate by Mistral AI (Paris)**, only for names none of the above could place:
   - Mistral Large 4 gives five answers in one call. At least three must name the same owner's country, and if
     most say it isn't a business (a person's name, a transfer, a generic word), it's treated as one.
   - The voted owner is looked up on Wikidata/GLEIF by exact name. If all five answers agree and the register
     confirms the owner's country, that's the answer.
   - Otherwise Mistral Medium 3.5 checks with Mistral's web search (asked to search at most twice), and its
     answer wins. Its owner is looked up on Wikidata/GLEIF by exact name to fill in the ownership chain and
     sources. If any of the five answers took the name for a person or not a business, it isn't searched on the
     web.
   - If no web check is possible (the daily limit, or the request's first minute is over), the vote stands,
     checked against Wikidata/GLEIF: if the register puts the owner in another country, Mistral is shown both,
     and the answer is kept only if that settles it. If the web check fails or isn't sure, the vote stands
     unless the register put the owner in another country.
   - Every AI answer is labelled "AI estimate … Not checked by a person", with the model, the check it passed
     and its sources.

What leaves at each step: only the shop name, cleaned up (capitals, no punctuation), and — if the app sends it —
the bank's country. Never amounts, dates, account details or anything about the person. The web search gets the
shop name only, through Mistral.

For a bank outside the UK, our list and Companies House aren't used, legal forms such as A/S and S.A. are dropped
from names, and answers are kept per country. The Wikidata step still matches by name alone. UK names keep the
rules they had before 14 Oct, so two initials at the end ("EVANS S L") aren't taken for a legal form.

## Settings

Secrets (Supabase → Edge Functions → Secrets): `MISTRAL_API_KEY` and `COMPANIES_HOUSE_API_KEY`. Optional:

| Name | Default | What it does |
| --- | --- | --- |
| `LLM_MODEL` | `mistral-large-4` | The five-answer model |
| `WEB_SEARCH` | `unsure` | `unsure` (unless all five answers agree and a register confirms the owner); `always` (every business); `check` (only when a register doesn't confirm the vote); `fallback` (only when there's no answer); `off` |
| `DAILY_LLM_CAP` | 2,000 | Names a day the AI step may look at |
| `DAILY_WEB_CAP` | 200 | Web checks a day |
| `DAILY_CH_CAP` | 5,000 | Companies House calls a day |

When the AI step is paused — today's limit reached, or the Mistral account out of credit (HTTP 402) — the names
come back unknown with an error step, so neither the cache nor the app records them and they're tried again
later. New names start until 90 seconds into a request, AI calls stop at 125 seconds and every outside call
ends by 138 seconds, inside the host's 150-second limit.

How long answers are kept: register answers 60 to 120 days; AI answers checked with the web, or agreed by all
five answers and confirmed by a register, a year; AI answers that wanted a web check they couldn't get (today's
limit, the request's time, or a failure) 3 days, so the check comes soon; other AI answers, and the AI's "not a
business" or "not sure", 30 days (served from the cache until then, so the same name isn't sent to Mistral again;
the app also waits 30 days before asking again about a name with no answer); other unknown names 7 days. Answers
saved before 15 Oct keep the expiry they were saved with. An answer is only looked up again after it expires,
when someone whose phone doesn't have it yet brings that name.

Cost: about $0.02 for each name that reaches the AI step, on the test set: about $0.0015 for the five answers,
and about $0.06 for each web check, most of it web searches at about $0.03 each (check Mistral's price list),
which about 3 names in 10 needed. At the default caps that's at most about $3 a day for the five answers and
$12 for web checks; requests running at the same time can go slightly over the caps. A web check that fails
with a server error or a timeout isn't repeated, since it may already have been charged for its searches. The
Mistral account is prepaid: when the credit runs out, the AI step pauses as above.

Mistral account (admin.mistral.ai): keep "Anonymous improvement data" off (Privacy), so our requests aren't used
for training. Mistral keeps API requests for 30 days to watch for abuse, unless zero data retention is agreed
with them. Set a monthly spending limit.

## How accurate it is

Test set: 170 names in `eval/cases.json` (60 known chains, 90 owned brands, 20 non-businesses). An answer is
graded against our list's country unless a hand check in `eval/truth.json` (with its sources) says otherwise.
Six names whose owner is genuinely unclear are skipped, leaving 164.

| Setup (14 Oct 2026) | Right | Wrong | Declined |
| --- | --- | --- | --- |
| Five answers and a register check, no web | 138 | 7 | 19 |
| Web search only | 155 | 2 | 7 |
| Web only when a register doesn't confirm the vote | 155 | 5 | 4 |
| **Web unless all five answers agree and a register confirms the owner (live)** | **157** | **3** | **4** |
| Web for every business, and the web answer wins | 158 | 2 | 4 |
| Web and vote must agree | 144 | 0 | 20 |

These rows combine saved runs offline (`eval/combine-web.mjs`). The live rule searched the web for 48 of the 170
names, against about 150 when every business is searched, so it costs less than half as much (about $18 per 1,000
names against $47) for one more wrong answer. "Declined" means no AI answer; the app then estimates from where
you paid. For comparison, Claude Haiku 5.5, which ran the AI step until 14 Oct, scored 118 right, 8 wrong and 44
declined against our list, before the hand checks. The 12 Oct bake-off (one answer per model, Claude against
Mistral) is in this file's history.

Live check of the earlier setting, the web for every business (now `node run.mjs always`; 14 Oct): it stopped
after 79 names, when the Mistral account ran out of credit, with 75 right, 2 wrong and 2 declined — against 76, 1
and 2 for the same names in the table above. It took a median of 14 seconds a name (90th percentile 23 seconds).
The live rule hasn't had its own live check yet; that needs Mistral credit (`node run.mjs live`, about $3).

Known weak spots:

- Confident wrong answers. The live rule's three wrong answers were Home Bargains, Leaders and Puccino's: all
  five answers put the owner in the same wrong country, and Wikidata confirmed the country of the owner they named
  most (TJX, Countrywide, Whitbread). The register check confirms where that owner is run from, not that it owns
  the shop. Searching the web for every business got these three right.
- Deals announced but not completed. Searching the web for every business took easyJet and Boots for deals that
  hadn't completed (the live rule kept the right answers); the prompt now says only completed deals count.
- Owners who are people: DAZN came back as Len Blavatnik (GB) rather than his company, Access Industries (US).
- Part-owners: Welcome Break came back once as Applegreen (Ireland) rather than Blackstone (US).
- A bare payment-provider name ("PAYPAL") and shop names that look like a person ("ROGER PLATT") are treated as
  not a business.

## Running the bench

From `services/lookup/eval`, with the bench token in `EVAL_TOKEN` or `~/.kys-eval-token` (never in the repo):

    CHUNK=8 node run.mjs live          # the deployed settings on all 170 names (about $3)
    CHUNK=8 node run.mjs always        # the web for every business, the setting until 14 Oct (about $9)
    node run.mjs --report live         # grade saved results again, no API calls
    node run.mjs ask-large4            # other setups: see SETUPS in run.mjs
    node web-all.mjs                   # the web-search ask on every name (results-web-medium.json)
    node combine-web.mjs               # the table above, offline, from saved results
    node fingerprint.mjs               # what the bench's {"action":"fingerprint"} should return for this code

Saved results (`results-*.json`) aren't committed. To rotate the token, make a random one, keep it outside the
repo, put its SHA-256 in `TOKEN_SHA256` in `kys-llm-eval.ts`, and redeploy kys-llm-eval.

## Tests

Node 22.18 or later (it runs the `.ts` files directly):

    node services/lookup/test/names.mjs     # name clean-up (no network)
    node services/lookup/test/ai-step.mjs   # the AI step's decisions, with a stand-in for Mistral
    node services/lookup/test/deadline.mjs  # time limits
    node services/lookup/test/handler.mjs   # the live handler, with a stand-in database and Mistral

The last three look owners up on Wikidata and GLEIF for real, so they need the internet.
