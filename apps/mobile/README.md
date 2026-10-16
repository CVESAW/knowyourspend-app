# KnowYourSpend — Expo app

The KnowYourSpend app built with Expo (SDK 57, Expo Router). This first build targets **Expo web**; the same code runs on iPhone and Android, except receipt reading (see below).

Everything happens on the device: statements and receipts are read here, matched against the built-in ownership list (`@kys/ownership`), and stored only on this device (IndexedDB on web, AsyncStorage on phones). Online lookups are off, so nothing about what you add leaves the device.

## Run it

From the repo root:

```bash
pnpm install              # also copies the OCR files into apps/mobile/public/ocr
pnpm --filter mobile web  # opens the web app at http://localhost:8081
```

On a phone: `pnpm --filter mobile start`, then scan the QR code with the Expo Go app. Statements (CSV) work; receipt reading needs the full build below, so Expo Go shows a note instead.

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
```

`vercel.json` holds the build and the single-page rewrite for hosting on Vercel (project root: `apps/mobile`).

## What's where

- `src/app/` — screens: home (`index`), the ＋ sheet (`add`), `add-statement`, `add-receipt`, the report (`item/[id]`), `settings`
- `src/components/` — charts, score tiles, item list, the "What data leaves your phone" panel, UI primitives
- `src/lib/` — on-device logic: `store` (local storage), `ingest` (statements and receipts in), `ocr.web.ts` (Tesseract.js, served from `/ocr`, no CDN) and `ocr.ts` (ML Kit on phones), `pdf.web.ts` (pdf.js, served from `/pdf`), `share` (share cards)

Spend maths, receipt parsing, image prep, formatting, types and bank guides live in `packages/core` and are shared with the web app; the files in `src/lib` with those names just re-export them.

## Not in this build yet

- Receipt reading on iPhone/Android is wired up (ML Kit) but not yet tried on a real device
- PDF statements on iPhone/Android (the web version reads them, with pdf.js served from `/pdf`)
