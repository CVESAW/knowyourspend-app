---
title: The KnowYourSpend API
---

# The KnowYourSpend API

Send a shop name, a company, or a line from a bank statement or receipt. Get back who owns it, the chain of companies up to the top, the country each one is run from, how we know, and our sources. Free, with open docs.

**Status: the hosted API opens soon.** Until then you can use our open data and our Python script (below), and the search box on [our home page](/), which gives the same answers. Want to know when it opens, or need more than the free limit? Email {{EMAIL}}.

## What you send

Up to 50 lines in one request. Add your bank's country if it isn't the UK.

```
curl -X POST {{ORIGIN}}/api/v1/lookup \
  -H "Authorization: Bearer YOUR_FREE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"lines": ["COSTA COFFEE 43012 LONDON GB", "PAYPAL *NETFLIX"], "country": "GB"}'
```

Names go in the request body, never in the address, so they stay out of web logs.

## What you get back

```
{
  "results": [
    {
      "query": "COSTA COFFEE 43012 LONDON GB",
      "name": "COSTA COFFEE",
      "status": "owner",
      "brand": "Costa Coffee",
      "owner": { "name": "The Coca-Cola Company", "country": "US" },
      "chain": [
        { "name": "Costa Coffee", "role": "Brand", "country": "GB" },
        { "name": "The Coca-Cola Company", "role": "Top owner", "country": "US" }
      ],
      "how_we_know": { "level": "registers", "label": "From official registers" },
      "as_of": "2026-09-28",
      "sources": [{ "label": "Wikidata Q608845", "url": "https://www.wikidata.org/wiki/Q608845" }],
      "explanation": {
        "headline": "Costa Coffee is owned by The Coca-Cola Company, run from the United States.",
        "sections": [{ "heading": "How we recognised it", "lines": ["…"] }]
      }
    }
  ]
}
```

`status` is one of:

- `owner`: we name the company at the top.
- `local`: a local independent business, like a café paid through a card reader.
- `not_shop`: a transfer, cash, or money moving between your own accounts.
- `person` or `sensitive`: held back. We don't look up names that look like a person's, or that could say something sensitive about you.
- `not_business`: our look-up decided it isn't a business.
- `unknown`: we couldn't find an owner.

## Limits

- **Free key:** 1,000 look-ups a day, of which up to 50 can be names nobody has asked us about before. Those take longer, up to two minutes, because we research them.
- Names we already know answer straight away. Need more? Email us.

## What we keep

The same as for the search box: each name and its answer, for 3 days to a year, and a count of how often each name is asked, never who asked. For a key, we'll keep your email address and each day's count of look-ups, to apply the limits. Details are in our [privacy notice](/privacy).

## Use it today

### Open data

The ownership list that the app, the search box and the API all use, as JSON files with their SHA-256 hashes: [{{ORIGIN}}/data/manifest.json](/data/manifest.json) (version {{DATA_VERSION}}). Over {{BRANDS}} shops and brands, built from company registers and open data. Same licence as our code (MIT); the sources' own terms are in NOTICE in [our source code]({{SOURCE}}).

### Python script

[kys.py](/statements#run-it-yourself) checks names and whole statements on your own computer, offline, against the open data. With `--online` it asks our look-up about names the list doesn't know, after showing you the list.

### How we work it out

Every step, the rules we follow and how accurate we are: [How it works](/how-it-works).
