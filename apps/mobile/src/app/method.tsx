import { useMemo } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { allEntries, checkedEntries } from "@/lib/ownership";
import { BackLink, Card, H1, H2, LinkText, P, Page } from "@/components/ui";
import { METHOD_URL, openUrl, reportMistake } from "@/lib/links";
import { useOwnershipVersion } from "@/lib/brand-data";

const TIERS: [string, string, string][] = [
  ["Checked", "CURATED", "A person has checked each step of the ownership chain against primary sources (company filings, official registers) within the last six months. Only checked answers are ever used in anything shared or published."],
  ["Matched", "EXACT_ID", "Worked out from official identifiers that agree with each other — Wikidata entries and the Global LEI (company) register."],
  ["Matched", "NAME_MATCH", "Found by name in an open dataset, but the identifiers haven't been cross-checked."],
  ["Unverified", "LLM_GUESS", "A best guess from AI or analyst knowledge — often correcting registers that are out of date after a takeover. Shown to you privately, clearly labelled, until someone checks it."],
];

export default function Method() {
  const listVersion = useOwnershipVersion(); // the counts grow when the web app finishes loading the brand list
  const counts = useMemo(() => allEntries.reduce<Record<string, number>>((m, e) => ((m[e.tier] = (m[e.tier] ?? 0) + 1), m), {}), [listVersion]);
  const total = useMemo(() => allEntries.length, [listVersion]);
  return (
    <Page testID="method">
      <BackLink onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} />
      <H1>How we work out who owns what</H1>
      <P muted>For each shop or brand we trace a chain — brand, the company that runs it in the UK, and the company at the top — and record the country the top company is run from. That country is what your pie chart shows.</P>
      <P muted>Tap any shop in a report to see why it counts where it does: what your bank wrote, how we recognised it, who owns it and how we know.</P>
      <View>
        <H2>How sure we are</H2>
        <View style={{ gap: 8 }}>
          {TIERS.map(([label, code, text]) => (
            <Card key={code} style={{ padding: 14, gap: 4 }}>
              <P bold>
                {label} <P small muted={3}>{code} · {counts[code] ?? 0} in our list today</P>
              </P>
              <P small muted>{text}</P>
            </Card>
          ))}
        </View>
      </View>
      <View style={{ gap: 6 }}>
        <H2>Where our list comes from</H2>
        <P muted>• {checkedEntries.length} shops and brands researched one by one, with an AI's help, against company registers (Wikidata, GLEIF) and recent takeover news. A person hasn't checked them yet.</P>
        <P muted>• {total - checkedEntries.length} more from OpenStreetMap's brand list, linked to Wikidata, with owners found by following Wikidata's “owned by” records. UK chains were then re-checked for takeovers the records missed; those answers are marked Unverified.</P>
        <P muted>• Shops in neither list can be looked up online by name (our own list, Wikidata and GLEIF, Companies House, then an AI, which also checks register answers that may be out of date) — see Settings.</P>
        <P small muted={3}>Brand data © OpenStreetMap contributors (name-suggestion-index, BSD-3-Clause) and Wikidata (CC0). Place names from GeoNames (CC BY 4.0).</P>
      </View>
      <View style={{ gap: 6 }}>
        <H2>Rules we follow</H2>
        <P muted>• Franchises: we show the brand owner, and the UK company that runs it as a separate step.</P>
        <P muted>• Private-equity owners count as the owner. Joint ventures are marked as shared.</P>
        <P muted>• Where a company is run from and where it's legally registered can differ. The main chart uses where it's run from.</P>
        <P muted>• Payment services in front of a shop (PayPal, Klarna, Clearpay, Square, SumUp) are looked through to the shop itself. Marketplaces (Amazon Marketplace, eBay, Deliveroo) count as themselves, as the seller isn't on your statement.</P>
        <P muted>• Small local businesses — paid with a card reader small businesses use (“SQ *”, “SUMUP *”, “ZETTLE_*”), named like one (CAFE, BAKERY, BARBER…), or found to be local by our look-up — are counted where you paid them, marked “Local independent”. Names spotted by the card reader or the name aren't sent to the look-up.</P>
        <P muted>• Shops we can't link to an owner are counted under the country you paid them in, and marked “Estimated”. An unlisted café in Lewisham is almost always owned in the UK; an unlisted taverna in Málaga, in Spain. We read the country from the country code, town or web address your bank prints, and otherwise take it as paid at home. You can switch this off, or set any shop's country yourself.</P>
      </View>
      <LinkText onPress={() => openUrl(METHOD_URL)} testID="method-full">The full method, and how accurate it is ↗</LinkText>
      <P small muted={3}>
        Estimates based on published ownership data; may contain errors.{" "}
        <LinkText onPress={() => reportMistake()} testID="method-report-mistake">Report a mistake</LinkText>. Brand names are used for identification only; no affiliation or endorsement.
      </P>
    </Page>
  );
}
