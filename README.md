# KnowYourSpend

See which countries own the shops you pay. Add a bank statement and KnowYourSpend shows your spending by
the country of each business's ultimate owner. It's free, it needs no account, and your statement is read
on your phone.

- Website: https://knowyourspend.org
- App (web): https://app.knowyourspend.org

This repository is the code behind both: the app, the statement reader, the brand-to-owner list, the
look-up service and the website. It's here so you can check what we say about your data against the code
that does it.

## What leaves your phone

| What | Where it goes | For how long | To keep it from us |
| --- | --- | --- | --- |
| Your statement file, amounts, dates, balances, account and card numbers, and the people you pay | Nowhere. It's read and stored on your device (IndexedDB in the browser) | Until you delete it | Nothing to do |
| Receipt photos | Nowhere. Read on the device, then discarded | Not kept | Nothing to do |
| Names of shops the app doesn't recognise | Our look-up service, which may ask Wikidata, GLEIF, Companies House and Mistral AI about the name | The name and its answer, used for 3 days to a year (an expired answer stays until the name is looked up again); and a count of the look-ups that asked about each name (not names it decides aren't a business, nor a phone asking again), until a year after the latest. No record of who asked; since 18 Oct 2026, times only to the day | Settings → Shops we don't know → Never |
| Your email address and a summary (percentages and well-known shop names, never amounts), if you ask us to email your results | Sent through Brevo; the address isn't kept unless you also ask for updates | Brevo's delivery log, 1 month; salted hashes that stop misuse, 30 days | Don't use "Email me my results" |
| An encrypted copy of your data, if you make an account | Supabase, after it's encrypted on your device with a key from a passphrase only you know (PBKDF2-SHA256, AES-256-GCM) | Until you delete the account | Don't make an account; you don't need one |
| Anonymous counts (one total per action per day) | Supabase | Kept as totals | Off unless you switch them on |

With look-ups set to Never and no account or email, nothing you add leaves your device. The web host still
sees a normal page request (your IP address and browser), as for any website. The full privacy notice is in
[`legal/privacy-notice.md`](legal/privacy-notice.md).

## Check it yourself

- **Read the code that sends things.** Every outgoing request is in one of these files:
  [`apps/mobile/src/lib/lookup.ts`](apps/mobile/src/lib/lookup.ts) (shop-name look-ups),
  [`apps/mobile/src/lib/email.ts`](apps/mobile/src/lib/email.ts) (emailed results),
  [`apps/mobile/src/lib/account.ts`](apps/mobile/src/lib/account.ts) (optional account) and
  [`apps/mobile/src/lib/usage.ts`](apps/mobile/src/lib/usage.ts) (anonymous counts).
- **See every look-up.** In the app, Settings → What we can see lists each look-up request it has sent, with
  its exact body.
- **Read the address list.** The web app's Content Security Policy in
  [`apps/mobile/vercel.json`](apps/mobile/vercel.json) only allows connections to the app's own address and
  our Supabase project. Your browser enforces it; you can see the header in your browser's developer tools.
- **Run the test that watches the network.** The end-to-end test in
  [`apps/mobile/e2e/smoke.mjs`](apps/mobile/e2e/smoke.mjs) adds statements at phone size and fails on any
  request to an address that isn't allowed, and checks that an account copy is ciphertext and an emailed
  summary carries no amounts.
- **Try it offline.** Add one statement, turn on airplane mode, and add another. It still works.

## How a shop gets its country

1. **The built-in list**, on your device: about 6,500 brands from OpenStreetMap's name-suggestion-index and
   Wikidata, plus a hand-built list of UK merchants (`packages/ownership`).
2. **The look-up service** (`services/lookup`), only for names the list doesn't know and only if look-ups are
   on: Wikidata and GLEIF (the global company register), then Companies House, then an AI estimate from
   Mistral AI checked against those registers, with a web search when it isn't sure.
3. **Where you paid**, if nothing else knows the shop: it's counted in that country and marked "Estimated", and
   you can set the country yourself.

Every answer in the app shows which step gave it and how sure it is.

## How accurate it is

On 179 test names (144 shops and brands graded against the built-in list, or for 17 of them a hand check; 20
names that aren't a business; 15 made-up local businesses), the look-up's AI step gives 177 right and 2 wrong
with its full check, and 173 right, 5 wrong and 1 with no answer the first time a name is asked about (17 Oct
2026). The test set, the hand checks with their sources, the scoring and the known weak spots are in
[`services/lookup/README.md`](services/lookup/README.md) and `services/lookup/eval`. Ownership changes, so
answers can be out of date. If you spot a mistake, email hello@knowyourspend.org or open an issue.

## What runs where

| Part | Folder | Runs on |
| --- | --- | --- |
| The app (web now, iPhone and Android later) | `apps/mobile` (Expo, React Native Web) | Your device; files served by Vercel |
| Statement reader (CSV and PDF formats) | `packages/statement` | Your device |
| Totals, PDF and receipt reading, country estimates | `packages/core` | Your device |
| Brand-to-owner list and matcher | `packages/ownership` | Your device |
| Shop look-up service | `services/lookup` | Supabase Edge Functions; cache in Supabase (Ireland) |
| Accounts, emailed results, anonymous counts | `services/supabase` | Supabase Edge Functions and database (Ireland) |
| Website | `apps/site` | Vercel |
| Privacy notice and terms | `legal` | — |

## Run it

Node 22 and pnpm 10:

```bash
pnpm install
pnpm --filter mobile web      # the app at http://localhost:8081
pnpm -r test                  # unit tests
pnpm --filter site test       # build and check the website
node services/lookup/test/names.mjs   # look-up tests (the others need the internet)
```

The app talks to our Supabase project by default. To use your own, set `EXPO_PUBLIC_SUPABASE_URL`,
`EXPO_PUBLIC_LOOKUP_URL` and `EXPO_PUBLIC_LOOKUP_KEY`, and deploy the functions and migration in
`services/` (see [`services/supabase/README.md`](services/supabase/README.md) and
[`services/lookup/README.md`](services/lookup/README.md)). The key in the code is Supabase's public anon key,
which only allows what the app itself can do.

## Contribute

Adding your bank's file format, correcting an owner and improving the reader are all welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md). Please don't put real statements in issues or pull requests.

## Security

See [SECURITY.md](SECURITY.md) to report a vulnerability privately.

## Licence

The code is released under the [MIT licence](LICENSE). Data from other sources keeps its own licence; see
[NOTICE](NOTICE). The KnowYourSpend name and logo aren't covered by the licence: if you run your own copy,
please give it a different name.
