/**
 * Short "how to get your statement" guides. Kept deliberately brief and hedged: banks change
 * their apps often. TODO: verify each against the live app with real screenshots before launch.
 */
export interface BankGuide {
  id: string;
  name: string;
  format: "CSV" | "CSV or PDF" | "TXT" | "OFX or QIF";
  history: string;
  steps: string[];
  /** Heading on the file step, when "Getting your <name> statement" doesn't read well. */
  heading?: string;
}

export const BANK_GUIDES: BankGuide[] = [
  { id: "monzo", name: "Monzo", format: "CSV", history: "Choose any date range", steps: ["Open the Monzo app and tap your account", "Tap the ••• or Help menu and choose Export transactions (or Statements)", "Pick CSV and the months you want", "Save the file, then come back here and choose it"] },
  { id: "starling", name: "Starling", format: "CSV", history: "Choose any date range", steps: ["In the Starling app, open your account", "Tap Statements → Export", "Choose CSV and a date range", "Save the file, then choose it here"] },
  { id: "revolut", name: "Revolut", format: "CSV or PDF", history: "Choose any date range", steps: ["In the Revolut app, open your GBP account", "Tap ••• → Statement", "Choose Excel/CSV (or PDF) and the period", "Save the file, then choose it here"] },
  { id: "barclays", name: "Barclays", format: "CSV", history: "About 2 months at a time", steps: ["Log in to Barclays Online Banking on a computer", "Open your account and choose Export transactions", "Pick CSV and the widest range offered", "Repeat for earlier months if you like — we remove overlaps"] },
  { id: "lloyds", name: "Lloyds, Halifax or Bank of Scotland", format: "CSV", history: "Up to about 12 months", steps: ["Log in to Internet Banking on a computer", "Open your account and choose Export (or Download transactions)", "Pick CSV and the date range", "Save the file, then choose it here"] },
  { id: "natwest", name: "NatWest or RBS", format: "CSV", history: "Several months", steps: ["Log in to Online Banking on a computer", "Choose Statements → Download or export transactions", "Pick CSV (Excel, BOS, Quicken, Quickbooks)", "Save the file, then choose it here"] },
  { id: "nationwide", name: "Nationwide", format: "CSV", history: "Several months", steps: ["Log in to Internet Banking", "Open your account and choose Download transactions", "Pick CSV", "Save the file, then choose it here"] },
  { id: "santander", name: "Santander", format: "TXT", history: "Several months", steps: ["Log in to Online Banking on a computer", "Open your account and choose Download transactions", "Pick Text file (.txt)", "Save the file, then choose it here"] },
  { id: "hsbc", name: "HSBC or First Direct", format: "CSV", history: "About 90 days (HSBC)", steps: ["Log in to Online Banking on a computer", "Open your account and choose Download", "Pick CSV", "For older months, download PDF statements and choose those instead"] },
  { id: "chase", name: "Chase UK", format: "CSV", history: "About 90 days per export", steps: ["In the Chase app, open your account", "Tap Statements → Create a custom statement", "Choose CSV", "Save the file, then choose it here"] },
  { id: "wise", name: "Wise", format: "CSV", history: "Choose any date range", steps: ["In Wise, open your GBP balance", "Choose Statements and reports → Statement", "Pick CSV", "Save the file, then choose it here"] },
  { id: "amex", name: "American Express", format: "CSV", history: "Several months", steps: ["Log in on the Amex website", "Open Statements & activity → Download", "Pick CSV", "Save the file, then choose it here"] },
  { id: "barclaycard", name: "Barclaycard", format: "CSV", history: "Several months", steps: ["Log in to Barclaycard online on a computer", "Open your transactions and look for Download or Export", "Pick CSV and the widest range offered", "Save the file, then choose it here"] },
  { id: "mbna", name: "MBNA", format: "CSV", history: "Several months", steps: ["Log in to MBNA online on a computer", "Open your transactions and look for Download or Export", "Pick CSV", "Save the file, then choose it here"] },
  { id: "tesco-bank", name: "Tesco Bank credit card", format: "CSV", history: "Several months", steps: ["Log in to Tesco Bank online on a computer", "Open your credit card transactions and look for Download or Export", "Pick CSV", "Save the file, then choose it here"] },
  { id: "aqua", name: "Aqua", format: "CSV", history: "Several months", steps: ["Log in to Aqua online", "Open your transactions and look for Download or Export", "Pick CSV", "Save the file, then choose it here"] },
  { id: "curve", name: "Curve", format: "CSV", history: "Choose any date range", steps: ["In the Curve app, open your transactions", "Look for Export transactions", "Pick CSV and the period", "Save the file, then choose it here"] },
  { id: "ofx", name: "Any bank", heading: "Getting an OFX or QIF file", format: "OFX or QIF", history: "Whatever your bank offers", steps: ["Many banks offer a download for money apps, labelled OFX, QFX, Microsoft Money, Quicken or QIF", "Log in to your bank on a computer and look for Download or Export transactions", "Pick one of those formats instead of CSV", "Save the file, then choose it here"] },
  { id: "n26", name: "N26", format: "CSV", history: "Choose any date range", steps: ["In the N26 web app, open Downloads", "Choose CSV export and a period", "Save the file, then choose it here"] },
];
