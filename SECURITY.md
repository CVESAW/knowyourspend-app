# Security

If you find a security or privacy problem in KnowYourSpend — the app, the look-up service, the account
or email functions, or the website — please tell us privately first.

- Email **hello@knowyourspend.org** with "Security" in the subject, or use GitHub's
  "Report a vulnerability" button on this repository's Security tab.
- Include what you found, how to reproduce it and what it could affect.
- Please don't access other people's data, run denial-of-service tests or send us real bank statements.

We'll reply within 5 working days, keep you updated, and credit you when it's fixed if you'd like.

## What's in scope

- Anything that sends data from the device that the README or privacy notice says doesn't leave it.
- Getting at another person's account copy, email address or subscription.
- Weaknesses in how the account copy is encrypted on the device (`apps/mobile/src/lib/account.ts`).
- The Edge Functions in `services/`, and the website and web app at knowyourspend.org and
  app.knowyourspend.org.

## Known and expected

- The Supabase URL and anon key in the app are public by design: they only allow what the app itself can do,
  and the database's row-level security limits each account to its own row.
- Ownership answers can be wrong or out of date. That's a data issue, not a security one: email us or open
  an issue.
