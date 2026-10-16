# Supabase: accounts, emailed results and anonymous counts

Project `cxvwngmnkxtweuwaxfmz` (eu-west-1). The app reaches it over plain `fetch` with the public anon
key; nothing here can read a user's data, which is encrypted on their device before it's saved.

| Piece | What it does |
| --- | --- |
| `migrations/20261011_kys_accounts_and_email.sql` | `kys_vault` (one encrypted copy per account, RLS own-row only, 15 MB cap), `kys_email_limits` + `kys_email_bump()` (salted-hash rate limits, 30 days), `kys_subscribers` (opt-in updates with consent text and unsubscribe token), `kys_usage_counts` + `kys_count()` (event + day + total, nothing else) |
| `functions/kys-email` | "Email me my results": validates and clamps the summary, rate-limits, sends through Brevo (or Resend), optional subscribe (unsubscribe links go to `kys-unsubscribe`) |
| `functions/kys-account` | `DELETE`: removes the caller's vault row, subscriber row and auth user |
| `functions/kys-count` | `POST {event}` → +1 to today's total for that event |
| `functions/kys-unsubscribe` | `GET`/`POST ?token=<uuid>` from an email's unsubscribe link: deletes that subscriber. `verify_jwt` off (opened from email) |
| `functions/_shared/cors.ts` | Allowed origins: the Vercel app, knowyourspend.org and its app./www. subdomains, localhost |

## Switching it on

1. Apply the migration and deploy the functions (`verify_jwt` on except `kys-unsubscribe`; `kys-email`
   also accepts the anon key, for people without an account).
2. Secrets (Edge Functions → Secrets): `BREVO_API_KEY`, `EMAIL_FROM` (e.g.
   `KnowYourSpend <hello@knowyourspend.org>`), optional `EMAIL_DAILY_CAP` (default 300) and
   `APP_URL` (the app address used in the email's links).
   Without an email key, `kys-email` answers 503 "isn't switched on yet".
3. Authentication → Emails → SMTP: Brevo (`smtp-relay.brevo.com`, port 587, the Brevo SMTP login and
   key), sender `hello@knowyourspend.org`. Supabase's built-in mailer is for testing only.
4. Authentication → Emails → Templates: the app signs in with a 6-digit code, so **Magic Link** and
   **Confirm signup** must show `{{ .Token }}`. Suggested body for both:

   ```html
   <h2>Your KnowYourSpend sign-in code</h2>
   <p>Enter this code in the app: <strong style="font-size:24px;letter-spacing:4px">{{ .Token }}</strong></p>
   <p>It works for 1 hour. If you didn't ask for it, ignore this email; nothing happens without the code.</p>
   ```

   Subject: `Your KnowYourSpend code: {{ .Token }}`.
5. Authentication → URL configuration: Site URL = the app's address; add it to redirect URLs.
6. In the app, set the default of `ONLINE_EXTRAS` in `apps/mobile/src/lib/features.ts` to on.

The smoke test (`apps/mobile/e2e/smoke.mjs`) stands in for all of these endpoints and checks that the
saved copy is ciphertext and the email request carries no amounts.
