import { useState } from "react";
import { Platform, Text, View } from "react-native";
import { askedBefore } from "@kys/core/lookup-plan";
import { LOOKUP_HOST, requestBody } from "@/lib/lookup";
import { useStore } from "@/lib/store";
import type { Disclosure, ItemKind } from "@/lib/types";
import { useTheme } from "@/lib/theme";
import { Disclosure as Collapsible, Divider, LinkText, P } from "./ui";

/**
 * "What data leaves your phone" — shown, collapsed, on every submission (before saving and on the
 * report afterwards). Expanded, it lists every kind of data involved, where it goes and why, the
 * names that are (or would be) looked up, and the literal request body.
 */
type Fate = "stays" | "sent" | "held";
interface RowData {
  what: string;
  count?: number;
  fate: Fate;
  where: string;
  why: string;
}

export interface PanelPlan {
  candidates: string[];
  sensitive: string[];
  recognisedLocally: number;
  transfersExcluded?: number;
}

function FateTag({ fate }: { fate: Fate }) {
  const t = useTheme();
  const c = fate === "stays" ? t.teal : fate === "sent" ? t.oxblood : t.ink2;
  return (
    <View style={{ borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: fate === "held" ? "transparent" : `${c}1f`, borderWidth: fate === "held" ? 1 : 0, borderStyle: "dashed", borderColor: t.ink3 }}>
      <Text style={{ fontSize: 11, fontWeight: "600", color: c }}>{fate === "stays" ? "Stays on your phone" : fate === "sent" ? "Leaves your phone" : "Held back"}</Text>
    </View>
  );
}

/**
 * `willSend` (before saving): the names that will be looked up online when the user goes ahead.
 * `record` (after saving): what actually happened.
 */
export function DataLeavesPanel({ kind, plan, record, willSend, defaultOpen, itemId }: { kind: ItemKind; plan?: PanelPlan; record?: Disclosure; willSend?: string[]; defaultOpen?: boolean; itemId?: string }) {
  const t = useTheme();
  const { prefs } = useStore();
  const [showRequest, setShowRequest] = useState(false);
  const candidates = record ? [...record.sent, ...record.notSent] : plan?.candidates ?? [];
  const sensitive = record ? record.sensitiveHeld : plan?.sensitive ?? [];
  const recognised = record ? record.recognisedLocally : plan?.recognisedLocally ?? 0;
  const transfers = record ? record.transfersExcluded : plan?.transfersExcluded ?? 0;
  const sentNames = record ? record.sent : willSend ?? [];
  // The exact request: as the request log kept it, once sent; before, as it will go (with names asked about before).
  const logged = record && itemId ? prefs.requestLog.filter((l) => l.itemId === itemId).map((l) => l.payload) : [];
  const exact = logged.length ? logged.join("\n\n") : requestBody(sentNames, record ? [] : askedBefore(sentNames, prefs));

  const rows: RowData[] =
    kind === "statement"
      ? [
          { what: "Your statement file", fate: "stays", where: "Read here, on this device", why: "There is no upload — the file is opened and read on this phone, then only the results are kept here." },
          { what: "Amounts, dates, balances, account number and sort code", fate: "stays", where: "On this phone", why: "Only needed to draw your charts, which happens on this phone. A backup or account copy you make is encrypted with your passphrase first." },
          ...(transfers ? [{ what: "Payments to people", count: transfers, fate: "stays" as Fate, where: "On this phone", why: "People's names are never looked up, and leave this phone only inside an encrypted copy you choose to make." }] : []),
          { what: "Shop names we already know", count: recognised, fate: "stays", where: "Matched on this phone", why: "The app carries its own list of who owns common shops, so these need no lookup." },
        ]
      : [
          { what: "The photo of your receipt", fate: "stays", where: "Read here, then discarded", why: "The text is read on this phone. The photo is not saved or sent." },
          { what: "Prices, total, date and card details", fate: "stays", where: "On this phone", why: "Only needed to draw your charts, which happens on this phone. A backup or account copy you make is encrypted with your passphrase first." },
          { what: "Shop and brand names we already know", count: recognised, fate: "stays", where: "Matched on this phone", why: "The app carries its own list of who owns common shops and brands." },
        ];
  // Phone builds read receipts with Google ML Kit: the photo and its text stay on the device, but the library reports usage metrics to Google.
  const ocrMetrics = record ? !!record.ocrMetrics : kind === "receipt" && Platform.OS !== "web";
  if (ocrMetrics)
    rows.push({
      what: "Usage statistics from the phone's text reader",
      fate: "sent",
      where: "Sent to Google by ML Kit",
      why: "Receipts are read by Google's ML Kit, on this phone. It never sends the photo or the words on it, but it does report how often and how fast it runs.",
    });
  if (sensitive.length) rows.push({ what: "Names that might be sensitive", count: sensitive.length, fate: "held", where: "On this phone", why: "Things like health, gambling, dating, religion, politics or debt, and payments that might be to a person, are held back by default." });
  if (sentNames.length)
    rows.push({
      what: record ? "Shop names looked up online" : "Shop names we'll look up online",
      count: sentNames.length,
      fate: "sent",
      where: `Sent to ${LOOKUP_HOST}`,
      why: "Only the shop names, to find who owns them — no amounts, dates, account details or people's names, and no record of who asked. You can switch this off in Settings.",
    });
  const kept = candidates.filter((n) => !sentNames.includes(n));
  if (kept.length)
    rows.push({
      what: "Shop names we don't know yet",
      count: kept.length,
      fate: "stays",
      where: "On this phone",
      why: "Not sent. They're counted under the country you paid in, marked “Estimated”, and you can set the right country yourself on the report.",
    });

  const leaving = sentNames.length > 0;
  const chip = leaving ? `${sentNames.length} shop names` : ocrMetrics ? "Usage stats only" : "Nothing";
  return (
    <View testID="data-leaves-panel">
      <Collapsible
        defaultOpen={defaultOpen}
        testID="data-leaves-toggle"
        title={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: `${t.teal}1f`, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ fontSize: 15 }}>📱</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, fontWeight: "600", color: t.ink }}>What data leaves your phone</Text>
              <Text style={{ fontSize: 12, color: t.ink3 }}>{record ? "For this submission" : "Before anything is sent"}</Text>
            </View>
          </View>
        }
        right={
          <View style={{ borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: leaving ? `${t.oxblood}1f` : `${t.teal}1f` }} testID="leaves-summary">
            <Text style={{ fontSize: 12, fontWeight: "600", color: leaving ? t.oxblood : t.teal }}>{chip}</Text>
          </View>
        }
      >
        {rows.map((r, i) => (
          <View key={r.what} style={{ gap: 4 }}>
            {i > 0 && <Divider />}
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingTop: i > 0 ? 10 : 0 }}>
              <Text style={{ fontWeight: "600", color: t.ink, flexShrink: 1 }}>
                {r.what}
                {r.count !== undefined && <Text style={{ color: t.ink3, fontWeight: "400" }}> ({r.count})</Text>}
              </Text>
              <View style={{ marginLeft: "auto" }}>
                <FateTag fate={r.fate} />
              </View>
            </View>
            <P small muted>
              <Text style={{ fontWeight: "600", color: t.ink }}>{r.where}.</Text> {r.why}
            </P>
          </View>
        ))}
        {(candidates.length > 0 || sensitive.length > 0) && (
          <View style={{ gap: 6 }}>
            <Text style={{ color: t.ink3, fontSize: 11, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" }}>Names not recognised</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }} testID="leaves-names">
              {[...candidates, ...sensitive].map((n) => (
                <View key={n} style={{ borderRadius: 8, borderWidth: 1, borderColor: t.rule, paddingHorizontal: 8, paddingVertical: 3 }}>
                  <Text style={{ fontFamily: "monospace", fontSize: 12, color: t.ink3 }}>
                    {n}
                    {sensitive.includes(n) ? " · held back" : sentNames.includes(n) ? (record ? " · sent" : " · will be sent") : " · not sent"}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        )}
        <View style={{ gap: 6 }}>
          <LinkText onPress={() => setShowRequest((s) => !s)}>{showRequest ? "Hide" : "Show"} the exact request</LinkText>
          {showRequest && (
            <View style={{ borderRadius: 12, backgroundColor: t.sunk, padding: 12 }} testID="exact-request">
              {sentNames.length ? (
                <Text style={{ fontFamily: "monospace", fontSize: 12, color: t.ink }}>{exact}</Text>
              ) : (
                <P small muted>
                  {record ? "We made no request for this submission." : "We make no request for this submission."}
                  {ocrMetrics ? " Google's text reader sends its own usage statistics — never the photo or its text." : record ? "" : " Nothing about it leaves your phone."}
                </P>
              )}
            </View>
          )}
        </View>
      </Collapsible>
    </View>
  );
}
