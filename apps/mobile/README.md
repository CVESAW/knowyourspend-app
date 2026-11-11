# KnowYourSpend — Expo app

The KnowYourSpend app built with Expo (SDK 57, Expo Router). The same code is the web version (app.knowyourspend.org) and the iPhone and Android apps.

Statements and receipts are read on the device, matched against the built-in ownership list (`@kys/ownership`), and stored only on the device (IndexedDB on web, AsyncStorage on phones). Amounts, dates, balances and account details are never sent anywhere, except inside an encrypted copy the person chooses to make.

What can leave the device:

- **Shop-name look-ups** — on by default, and can be switched off (Settings → Shops we don't know → Never). The names of shops the built-in list doesn't know are sent to our look-up service: names only, with names that look like a person's or a sensitive payee held back. The person sees the list first, and every request is kept in the app's request log with its exact body (`src/lib/lookup.ts`).
- Only if the person chooses:
  - **An account** (optional; sign in with a code sent by email), which keeps an encrypted copy of their data. It's encrypted on the device with a passphrase only they know (`src/lib/account.ts`).
  - **Emailed results**: percentages by country and well-known shop names, never amounts (`src/lib/email.ts`).
  - **Anonymous counts**, off by default: one daily tally per action, with nothing about the person or what they added (`src/lib/usage.ts`).

On phones, receipts are read with Google ML Kit, which sends Google its own usage diagnostics (never the photo or its text). A web build with `EXPO_PUBLIC_ONLINE_EXTRAS=0` leaves out the account, emailed results and counts.

## Run it

From the repo root:

```bash
pnpm install              # also copies the OCR and PDF readers into apps/mobile/public
pnpm --filter mobile web  # opens the web version at http://localhost:8081
```

On a phone: `pnpm --filter mobile start`, then scan the QR code with the Expo Go app. Statements work; receipt reading needs the full build below, so Expo Go shows a note instead.

## Build the phone app

Receipt reading on phones uses Google ML Kit on the device (`@infinitered/react-native-mlkit-text-recognition`), which is a native module — so it runs in a real build, not in Expo Go. With an Expo account:

```bash
cd apps/mobile
npx eas-cli@latest build --profile preview --platform android   # an installable APK
npx eas-cli@latest build --profile preview --platform ios        # needs an Apple developer account
```

## Build the web version

```bash
pnpm --filter mobile build:web   # static single-page app in apps/mobile/dist
pnpm --filter mobile e2e         # end-to-end checks of that build, under the production headers
```

`vercel.json` holds the build, the single-page rewrite and the security headers for hosting on Vercel (project root: `apps/mobile`).

## What's where

- `src/app/` — screens: home (`index`), the ＋ sheet (`add`), `add-statement`, `add-receipt`, the report (`item/[id]`), `settings`, `account`, "What we can see" (`privacy`), `method`, `unsubscribe`
- `src/components/` — charts, score tiles, item list, the "What data leaves your phone" panel, "Why this country?", UI primitives
- `src/lib/` — on-device logic: `store` (local storage), `ingest` (statements and receipts in), `ocr.web.ts` (Tesseract.js, served from `/ocr`, no CDN) and `ocr.ts` (ML Kit on phones), `pdf.web.ts` (pdf.js, served from `/pdf`) and `pdf.ts` (pdf.js in a sealed, offline WebView on phones), `share` (share cards); and everything that talks to our server: `lookup`, `account`, `email`, `usage`

Spend maths, receipt parsing, image prep, formatting, types and bank guides live in `packages/core`; the files in `src/lib` with those names just re-export them.

## Not in this build yet

- Receipt reading on iPhone/Android is wired up (ML Kit) but not yet tried on a real device
