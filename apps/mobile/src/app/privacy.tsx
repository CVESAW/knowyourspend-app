import { Text, View } from "react-native";
import { router } from "expo-router";
import { useAppData } from "@/lib/data";
import { LOOKUP_HOST } from "@/lib/lookup";
import { useStore } from "@/lib/store";
import { useAccount } from "@/lib/account";
import { ONLINE_EXTRAS } from "@/lib/features";
import { useTheme } from "@/lib/theme";
import { BackLink, Card, Disclosure, Divider, H1, P, Page } from "@/components/ui";

/** "What we can see" — the privacy promise, with the user's own numbers. */
export default function Privacy() {
  const t = useTheme();
  const data = useAppData();
  const { prefs } = useStore();
  const acct = useAccount();
  const sent = new Set(data.items.flatMap((i) => i.disclosure.sent));
  const usedMlKit = data.items.some((i) => i.disclosure.ocrMetrics);
  const rows: [string, string][] = [
    ["Your statements and receipt photos", "Read on this device, never uploaded. Photos aren't kept at all."],
    [`${data.txns.length} transactions, ${data.items.length} items`, "This device only"],
    ["Amounts, dates, balances, account details", "This device only"],
    ["Shop names sent for lookup", sent.size === 0 ? "None" : `${sent.size} — names only, with no record of who asked`],
    [
      "On our servers about you",
      acct.email
        ? `Your email (${acct.email}) and, if you've saved one, an encrypted copy of your data that only your passphrase opens. We can see its size and when it was saved, nothing more.`
        : "Nothing. You don't have an account (it's optional). The lookup service keeps shop names and answers only — not who asked.",
    ],
    ...(ONLINE_EXTRAS
      ? ([
          ["Results you email yourself", "Percentages and well-known shop names, sent by our email provider. Your address isn't kept unless you ask for updates."],
          ["Anonymous counts", prefs.shareCounts ? "On — a daily tally of statements and receipts added, with nothing about you or what you added" : "Off — nothing is sent"],
        ] as [string, string][])
      : []),
    ...(usedMlKit ? ([["Usage statistics from the phone's text reader", "Google's ML Kit reports how often it runs — never the photo or its text"]] as [string, string][]) : []),
  ];
  return (
    <Page testID="privacy">
      <BackLink onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} />
      <H1>What we can see</H1>
      <P muted>Short answer: nothing about how much money you have. Here's the detail, with your real numbers.</P>
      <Card style={{ overflow: "hidden" }}>
        {rows.map(([a, b], i) => (
          <View key={a}>
            {i > 0 && <Divider />}
            <View style={{ padding: 14, gap: 4 }}>
              <Text style={{ fontWeight: "600", color: t.ink }}>{a}</Text>
              <P small muted>{b}</P>
            </View>
          </View>
        ))}
      </Card>
      <P small muted={3}>
        Online lookups are{" "}
        {prefs.lookup === "off"
          ? "switched off — shops we don't know are counted by where you paid, and nothing is sent."
          : prefs.lookup === "ask"
            ? "on request — nothing is sent until you tap “Look them up” on a report."
            : `on — when you add a statement, the names of shops we don't know are sent to ${LOOKUP_HOST}. Names that look like a person or a sensitive shop are held back. You see the list before you confirm, and can stop it being sent.`}{" "}
        Change this in Settings.
      </P>
      {prefs.requestLog.length > 0 && (
        <Disclosure title={<P bold>Every request we've sent ({prefs.requestLog.length})</P>}>
          {prefs.requestLog.slice(0, 30).map((r) => (
            <View key={r.id} style={{ gap: 4 }} testID="request-log-entry">
              <P small bold>{new Date(r.at).toLocaleString()} · {r.purpose}</P>
              <P small muted={3}>{r.endpoint}</P>
              <View style={{ borderRadius: 8, backgroundColor: t.sunk, padding: 8 }}>
                <Text style={{ fontFamily: "monospace", fontSize: 11, color: t.ink2 }}>{r.payload}</Text>
              </View>
            </View>
          ))}
        </Disclosure>
      )}
      <Disclosure title={<P bold>Check it yourself</P>}>
        <P small muted>1. On a computer, open the web version and press F12 (or right-click → Inspect), then choose the Network tab.</P>
        <P small muted>2. Add a statement. You'll see the page read the file — but no request carrying your file, amounts or dates.</P>
        <P small muted>3. Or turn on airplane mode after the app has loaded and add another statement: it still works, because it all happens here.</P>
      </Disclosure>
    </Page>
  );
}
