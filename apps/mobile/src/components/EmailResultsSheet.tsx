import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Breakdown } from "@/lib/aggregate";
import { useAccount } from "@/lib/account";
import { emailResults, summarise, UPDATES_CONSENT } from "@/lib/email";
import { PRIVACY_URL, openUrl } from "@/lib/links";
import { serif, useTheme } from "@/lib/theme";
import { Button, Checkbox, Field, LinkText, P } from "./ui";

/**
 * "Email me my results" — no account needed. Shows exactly what will be sent (percentages by country
 * and the best-known shops you pay most; never amounts, dates or balances) before anything leaves.
 */
export function EmailResultsSheet({ b, periodLabel, open, onClose }: { b: Breakdown; periodLabel: string; open: boolean; onClose: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const acct = useAccount();
  const summary = useMemo(() => summarise(b, periodLabel), [b, periodLabel]);
  const [to, setTo] = useState("");
  const [updates, setUpdates] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const address = acct.email ?? to;

  const send = async () => {
    setErr(null);
    setBusy(true);
    try {
      await emailResults(address, updates, summary);
      setSent(address.trim());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setSent(null);
    setErr(null);
    onClose();
  };

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
      <Pressable onPress={close} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }} accessibilityLabel="Close">
        <Pressable onPress={() => {}} style={{ alignSelf: "center", width: "100%", maxWidth: 560, maxHeight: "92%", backgroundColor: t.paper, borderTopLeftRadius: 24, borderTopRightRadius: 24 }} testID="email-sheet">
          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 20, gap: 14 }} keyboardShouldPersistTaps="handled">
            <Text style={[serif, { fontSize: 22, fontWeight: "600", color: t.ink }]}>Email me my results</Text>
            {sent ? (
              <>
                <P testID="email-sent">Sent to <P bold>{sent}</P>. It can take a minute to arrive; check your spam folder too.</P>
                <Button title="Done" onPress={close} testID="email-done" />
              </>
            ) : (
              <>
                <View style={{ borderRadius: 12, borderWidth: 1, borderColor: t.rule, backgroundColor: t.surface, padding: 14, gap: 6 }} testID="email-preview">
                  <P small muted={3}>What we'll send</P>
                  <P bold>{summary.headline}</P>
                  <P small muted>{summary.period}</P>
                  {summary.countries.map((c) => (
                    <View key={c.name} style={{ flexDirection: "row", gap: 8 }}>
                      <P small style={{ flex: 1 }}>{c.name}</P>
                      <P small bold style={{ fontVariant: ["tabular-nums"] }}>{Math.round(c.share * 100)}%</P>
                    </View>
                  ))}
                  {summary.shops.length > 0 && (
                    <P small muted>Who you pay most: {summary.shops.map((s) => s.name).join(", ")}</P>
                  )}
                </View>
                <P small muted>Percentages and well-known shop names only. No amounts, dates, balances or account details, and nothing about the people you pay.</P>
                {acct.email ? (
                  <P small>Sending to <P small bold>{acct.email}</P>, the email on your account.</P>
                ) : (
                  <Field label="Your email" value={to} onChange={setTo} placeholder="you@example.com" keyboard="email-address" autoComplete="email" testID="email-to" />
                )}
                <Checkbox checked={updates} onChange={setUpdates} testID="email-updates">
                  <P small>{UPDATES_CONSENT}</P>
                </Checkbox>
                <Button title={busy ? "Sending…" : "Send my results"} disabled={busy || !address.trim()} onPress={send} testID="email-send" />
                {err && <P small style={{ color: "#a33" }} testID="email-error">{err}</P>}
                <P small muted={3}>
                  We use your address to send this one email{updates ? " and the occasional update" : ", then forget it"}.{" "}
                  <LinkText onPress={() => openUrl(PRIVACY_URL)}>Privacy notice</LinkText>
                </P>
                <Button title="Cancel" variant="ghost" onPress={close} />
              </>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
