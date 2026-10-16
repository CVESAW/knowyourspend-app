---
title: Privacy notice
updated: 15 October 2026
status: Draft for legal review — not yet published
---

# Privacy notice

KnowYourSpend is built so that we never receive your bank statements, your receipts, or anything about
how much money you have in a form we can read. This notice explains the little that does leave your
phone, who receives it, and your rights. You don't need an account; the optional extras in sections 3
to 6 send nothing unless you choose them.

## Who we are

KnowYourSpend is run by KnowYourSpend Ltd, a company registered in England and Wales
([company number to follow]), registered office [address to follow]. We are the controller for the
personal data described here. ICO registration number: [to follow].

Contact: hello@knowyourspend.org

## What stays on your phone

When you add a bank statement or a receipt photo, the app reads it on your phone (or in your browser,
if you use the web version). The file is never uploaded. The transactions it finds — amounts, dates,
balances, account details and payee names — are stored only on your device. On phones the app deletes
its temporary copy of the file or photo as soon as it has been read; it doesn't keep receipt photos.

We can't see this data, so we can't access, correct or delete it for you. You can delete it at any
time in the app: Settings → Delete all my data. Uninstalling the app or clearing your browser's site
data also deletes it.

If you save an encrypted backup, the file is created on your device, protected by a passphrase you
choose, and stored wherever you put it. We never receive it and cannot open it. (If you choose to keep
an encrypted copy in an account instead, see section 4.)

## What leaves your phone, and why

### 1. Names of shops we don't recognise (optional)

To work out who owns a shop that isn't in the app's built-in list, the app can send that shop's name
to our look-up service. It sends **only the business name** as it appears on your statement — never
amounts, dates, balances or account details. Filters hold back names that look like a person and
names that point to something sensitive, such as a clinic, a pharmacy or a gambling site. Filters can
miss some, which is why you can check the list and stop it being sent.

- **When:** by default ("Automatically"), when you add a statement. The check screen shows the names
  that would be sent and has a tick box to stop them being sent for that statement. You can change the
  setting to "Ask me" or "Never" in Settings → Shops we don't know.
- **What we keep:** the shop name and the answer, in a cache shared by all users, for 3 days to a year so
  the next person gets an answer faster. The cache doesn't record who asked. We also keep daily counts
  of how many look-ups were made.
- **Who helps us:** the look-up service runs on Supabase. Its database is in Ireland; the code may run
  in the Supabase region nearest you. To answer, it may pass the shop name to Companies House, Wikidata
  (Wikimedia Foundation, USA) and GLEIF, and — if those don't know — to Mistral AI's AI service (France),
  which may also search the web for the shop name to check its answer. Only the shop name is passed on.
  Mistral keeps what it is sent for up to 30 days to watch for abuse, and we have switched off its use of
  our requests to improve its models [to confirm before launch].
- **Your IP address:** like any web request, the request reaches our hosting provider with your
  device's IP address. We don't store it in our database. Our provider's logs may hold it for a short
  period for security and fault-finding [retention period to confirm with Supabase].
- **Lawful basis:** legitimate interests — giving you the ownership answer you asked the app for, in a
  way that doesn't identify you.

### 2. Receipt reading

In the web version, receipts are read by a text reader that runs in your browser; the photo and its
text are never sent. If you use one of our iPhone or Android apps, they read receipts with Google's ML
Kit, also on your phone, but ML Kit sends Google basic diagnostics (device model, operating system and
app version, how long a read took, error codes) so Google can keep the feature working. Lawful basis: legitimate interests (making receipt reading work reliably). See Google's
description: https://developers.google.com/ml-kit/android-data-disclosure

### 3. Emailing your results to yourself (optional)

If you tap "Email me my results" and enter your email address, the app sends our email service your
address and a summary built on your device: the headline percentage, the percentage of your spending
by owner's country, the time period, and up to eight well-known shops you pay most with their owner and
country. It never includes amounts, dates, balances, account details, or names the app doesn't
recognise. The app shows you exactly what will be sent first.

- **What we keep:** nothing, unless you also tick "Send me occasional updates" (section 5). To stop
  misuse we keep a one-way, salted code made from your address and one made from your IP address, with
  a daily count, for 30 days. They can't be turned back into your address or IP address.
- **Who helps us:** our email function runs on Supabase (see section 1). The email is sent by our email
  provider, Brevo (Sendinblue SAS, France), which processes your address and the email on our behalf.
  Brevo keeps a delivery log (your address, the subject and whether it arrived) for one month, and
  doesn't keep a copy of the email. Brevo also counts whether emails are opened and links clicked;
  we've set this to anonymous totals that aren't linked to you. [Lawyer to confirm: Brevo can't switch
  this counting off for one-off emails.]
- **Lawful basis:** performing the service you asked for (contract).

### 4. An account to keep your data (optional)

You can sign in with your email address (we send you a 6-digit code; there's no password) to keep a copy
of your data and open it on another device. Before anything is saved, the app encrypts your data on
your device with a key made from a passphrase only you know (AES-256-GCM, with the key derived using
PBKDF2-SHA256). We store the encrypted copy, its size and when it was last saved. We can't read it, and
if you forget your passphrase we can't recover it.

- **What we keep:** your email address, the dates your account was created and last used, and the
  encrypted copy, until you delete your account (Settings → Delete my account), which removes all of
  them straight away. [Accounts that stop being used: retention to decide — suggested deletion after 2
  years without use, with an email first.]
- **Who helps us:** Supabase stores the account and encrypted copy (database in Ireland) and sends
  sign-in codes through our email provider (section 3).
- **Lawful basis:** performing the service you asked for (contract).

### 5. Occasional updates (optional)

Only if you tick the box. We keep your email address, when and how you agreed, and the wording you
agreed to, and send occasional news about KnowYourSpend. Every email has an unsubscribe link, which
deletes your address from the list. Lawful basis: your consent, which you can withdraw at any time.

### 6. Anonymous counts (optional, off unless you switch them on)

If you switch on Settings → Send anonymous counts, the app adds one to a daily total on our server when
you add a statement or receipt, open the demo, create an account or email your results. We store only
the event, the day and the running total: no IP address, identifier, device details or anything about
what you added. Lawful basis: legitimate interests (knowing whether the app is used), with your
choice to switch it on.

### 7. The web version

The web version of the app is served by Vercel. Vercel receives your IP address and browser details
when it delivers the app's files, as any web host does, and keeps them in its logs for a short period.
Nothing you add to the app is sent to Vercel.

### 8. Our website (knowyourspend.org)

The website uses no cookies unless you accept them. If you click "Accept", it loads the Meta Pixel.
It sends Meta (Facebook and Instagram) the page you visited, including any ad campaign tags in its web
address, the page you came from, which store button you pressed, your IP address and browser details,
and sets a Meta cookie, so we can see which of our ads work. Meta can link this to your Meta account under its own privacy policy;
for this collection, Meta and we are joint controllers. Lawful basis: your consent, which you can
withdraw at any time with the "Cookie settings" link at the bottom of every page. The app itself
contains no Meta Pixel or other advertising tracker.

### 9. If you email us

We keep your email address and message to answer you, and for up to two years afterwards in case you
follow up. Lawful basis: legitimate interests (answering you). Email to hello@knowyourspend.org is
forwarded by Cloudflare to a Gmail inbox (Google).

### 10. App stores

Apple and Google run the App Store and Google Play. When you download the app they process data about
you under their own privacy policies; they give us only aggregated, anonymous statistics.

## Transfers outside the UK

Wikidata is in the USA, and Vercel and Meta may process data there. Mistral AI is in France; its web
search may use search providers outside the UK and EU [to confirm from Mistral's list of sub-processors].
Where personal data
is involved we rely on the UK–US data bridge for certified companies, or on the UK International Data
Transfer Addendum. Shop names on their own are not usually personal data.

## How long we keep things

| What | How long |
| --- | --- |
| Your statements, transactions, settings, fixes | On your device until you delete them |
| Shop names and answers in the look-up cache | 3 days to a year, then refreshed or removed |
| Daily look-up counts | Kept, but they contain no personal data |
| Hosting logs (IP addresses) | As set by Supabase and Vercel [to confirm] |
| Emails to us | Up to 2 years after the last message |
| Website consent choice | 12 months in your browser |
| Account, email address and encrypted copy | Until you delete your account [unused accounts: to decide] |
| Salted codes used to limit emails | 30 days |
| Email address for updates | Until you unsubscribe |
| Anonymous daily counts | Kept, but they contain no personal data |

## Your rights

You have the right to ask for a copy of personal data we hold about you, to have it corrected or
deleted, to restrict or object to how we use it, and to have it moved. Unless you have an account or
asked for updates, we will usually hold nothing that identifies you, because almost everything stays
on your device and our cache doesn't record who asked; we'll tell you if so. If you have an account, we
can give you your email address, dates and the encrypted copy, which only your passphrase opens. Email hello@knowyourspend.org. We reply within one month.

You can complain to the Information Commissioner's Office: ico.org.uk/make-a-complaint, 0303 123 1113.
We'd appreciate the chance to put things right first.

## Age

KnowYourSpend is for adults (18 and over).

## Changes

If we change what leaves your phone, we'll update this notice, change the date at the top, and show
the change in the app before it applies.
