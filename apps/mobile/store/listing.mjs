/**
 * The store listing text, in one place. `node store/listing.mjs` writes:
 *   - store.config.json        (Apple App Store, pushed with `npx eas-cli metadata:push`)
 *   - store/play/en-GB/*.txt    (Google Play, entered in Play Console or pushed by store/play-push.mjs)
 * and checks every field against the stores' length limits. Check new wording against COPY-GUIDE.md.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SITE = "https://knowyourspend.org";

const name = "KnowYourSpend";
const subtitle = "See who owns the shops you pay";
const short = "See which countries own the shops you pay. Statements stay on your phone.";
const promo =
  "Add a bank statement and see which countries own the shops you pay. It's read on your phone, and the file is never uploaded.";
const keywords = ["ownership", "country", "british", "buy local", "statement", "receipt", "shops", "brands", "spending", "owner", "uk", "privacy"];

const description = `KnowYourSpend shows which countries own the companies behind your everyday spending.

Add a bank statement (a PDF or CSV from your banking app) or take a photo of a receipt. KnowYourSpend reads it on your phone, works out who owns each shop, and shows your spending by the owner's country: a pie chart, a ranked list, a map and a timeline.

PRIVATE BY DESIGN
• Your statement is read on your phone. Amounts, dates, balances and account details are never uploaded.
• Receipt photos are read on your phone and not kept.
• No account, no sign-up, no ads, no advertising trackers.
• Every report has a "What data leaves your phone" panel that lists what, if anything, was sent and why.
• Look-ups for shops we don't know send the shop name only. Filters hold back people's names and sensitive payees, and you can switch look-ups off.
• Receipt reading on the phone uses Google's ML Kit, which sends Google basic diagnostics (never the photo or its text).

WHAT YOU SEE
• The share of your spending that goes to companies owned in the UK, the US, Germany, France and elsewhere
• Who you pay most, and who ultimately owns them
• Where each answer came from, and how sure we are
• "Which country is this?" to fix any shop yourself
• A share card with your percentages, never your amounts

Reads CSV statements from Monzo, Starling, Revolut, Barclays, Lloyds, NatWest, RBS, Nationwide, Santander, Wise and N26, and PDF statements (tested with Revolut, Monzo and Barclays). Other banks' CSV files can be read by matching their columns.

GOOD TO KNOW
Ownership estimates are based on published data (Companies House, Wikidata, GLEIF and OpenStreetMap) and, where those are missing or out of date, AI estimates labelled "Unverified". They may contain errors; tell us and we'll look into it. Brand names are used for identification only; no affiliation or endorsement. KnowYourSpend doesn't give financial advice and can't move money.`;

const releaseNotes = "First release.";

const reviewNotes = `KnowYourSpend reads bank statements (PDF or CSV files the user chooses) and receipt photos on the device, and shows which countries own the shops the user paid. It moves no money, gives no financial or investment advice, has no accounts or sign-in, and does not connect to any bank.

To try it without a statement: open the app and tap "Try the demo" on the home screen.

To try a statement: download ${SITE}/sample-statement.csv (made-up data) to Files, then tap + > Bank statement > Monzo > Choose file, and pick it.

Network use: the app's only request is an optional look-up that sends the names of unfamiliar shops (filtered to exclude people's names; never amounts or dates) to our look-up service. It can be turned off in Settings > Shops we don't know > Look up their owners online > Never. Receipt text recognition runs on the device with Google ML Kit, which sends Google its own basic diagnostics.`;

const limits = [
  ["name", name, 30], ["subtitle", subtitle, 30], ["short description", short, 80], ["promo text", promo, 170],
  ["keywords", keywords.join(","), 100], ["description", description, 4000], ["review notes", reviewNotes, 4000],
];
let bad = false;
for (const [label, text, max] of limits) {
  if (text.length > max) { console.error(`✗ ${label}: ${text.length}/${max}`); bad = true; }
  else console.log(`✓ ${label}: ${text.length}/${max}`);
}
if (bad) process.exit(1);

const apple = {
  configVersion: 0,
  apple: {
    copyright: "2026 KnowYourSpend Ltd",
    categories: ["LIFESTYLE", "SHOPPING"],
    advisory: {
      alcoholTobaccoOrDrugUseOrReferences: "NONE", contests: "NONE", gamblingSimulated: "NONE", horrorOrFearThemes: "NONE",
      matureOrSuggestiveThemes: "NONE", medicalOrTreatmentInformation: "NONE", profanityOrCrudeHumor: "NONE",
      sexualContentGraphicAndNudity: "NONE", sexualContentOrNudity: "NONE", violenceCartoonOrFantasy: "NONE",
      violenceRealistic: "NONE", violenceRealisticProlongedGraphicOrSadistic: "NONE",
      gambling: false, unrestrictedWebAccess: false, kidsAgeBand: null,
    },
    info: {
      "en-GB": {
        title: name, subtitle, description, keywords, releaseNotes, promoText: promo,
        marketingUrl: SITE, supportUrl: `${SITE}/support`, privacyPolicyUrl: `${SITE}/privacy`,
      },
    },
    release: { automaticRelease: false, phasedRelease: true },
    review: { demoRequired: false, notes: reviewNotes },
  },
};
writeFileSync(join(here, "..", "store.config.json"), JSON.stringify(apple, null, 2) + "\n");

const play = join(here, "play", "en-GB");
writeFileSync(join(play, "title.txt"), name + "\n");
writeFileSync(join(play, "short_description.txt"), short + "\n");
writeFileSync(join(play, "full_description.txt"), description + "\n");
writeFileSync(join(play, "release_notes.txt"), releaseNotes + "\n");
writeFileSync(join(here, "review-notes.txt"), reviewNotes + "\n");
console.log("Wrote store.config.json and store/play/en-GB/*.txt");
