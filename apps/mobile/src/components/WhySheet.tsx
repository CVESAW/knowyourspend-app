import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { theCountry, type Why } from "@kys/core/explain";
import { countryName, flag } from "@/lib/countries";
import { METHOD_URL, openUrl, reportMistake } from "@/lib/links";
import { serif, useTheme } from "@/lib/theme";
import { Button, Card, Disclosure, Eyebrow, LinkText, Notice, P } from "./ui";

/**
 * "Why this country?" — everything behind one shop's answer, in plain words: what the bank wrote, how we
 * recognised it, who owns it (step by step), how we know, the rules we applied and the sources. Opened by
 * tapping a shop. The bank text shown here is never sent to the look-up (an account copy, if kept, is encrypted first).
 */
export function WhySheet({ why, open, onClose, onSetCountry, onLookUp, lookingUp, note }: {
  why: Why | null;
  open: boolean;
  onClose: () => void;
  /** offered when there's a payee to set it for */
  onSetCountry?: () => void;
  /** offered when an online look-up could find the owner and the user allows look-ups */
  onLookUp?: () => void;
  lookingUp?: boolean;
  note?: string | null;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  if (!why) return null;
  const level = LEVEL_TONE[why.level] ?? "ink3";
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }} accessibilityLabel="Close">
        <Pressable onPress={() => {}} style={{ alignSelf: "center", width: "100%", maxWidth: 560, maxHeight: "90%", backgroundColor: t.paper, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: insets.bottom + 12 }} testID="why-sheet" accessibilityViewIsModal>
          <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
            <View style={{ gap: 8 }}>
              <Eyebrow>Why this country?</Eyebrow>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                <Text style={{ fontSize: 34 }}>{why.country ? flag(why.country) : "·"}</Text>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[serif, { fontSize: 22, fontWeight: "600", color: t.ink }]} numberOfLines={2}>{why.name}</Text>
                  <P small muted>{why.country ? `Counted as ${theCountry(why.country)}` : "Not counted"}</P>
                </View>
              </View>
              <View style={{ alignSelf: "flex-start", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, borderWidth: 1, borderColor: t[level] }}>
                <Text style={{ fontSize: 12, fontWeight: "600", color: t[level] }} testID="why-label">{why.label}</Text>
              </View>
              <P testID="why-headline">{why.headline}</P>
            </View>

            {why.bankText ? (
              <View style={{ gap: 6 }}>
                <Eyebrow>What your bank wrote</Eyebrow>
                <Card style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
                  <Text style={{ fontFamily: "monospace", fontSize: 13, color: t.ink }} selectable>{why.bankText}</Text>
                </Card>
                <P small muted={3}>Only you can see this. It's never sent to our look-up, and an account copy, if you keep one, is encrypted with your passphrase first.</P>
              </View>
            ) : null}

            {why.sections.map((s) => (
              <View key={s.heading} style={{ gap: 6 }}>
                <Eyebrow>{s.heading}</Eyebrow>
                {s.heading === "Who owns it" && why.chain.length > 0 && <Chain why={why} />}
                {s.lines.map((l) => (
                  <P key={l} small muted>{l}</P>
                ))}
              </View>
            ))}

            {why.sources.length > 0 && (
              <View style={{ gap: 6 }}>
                <Eyebrow>Sources</Eyebrow>
                {why.sources.map((s) => (
                  <LinkText key={s.url} onPress={() => openUrl(s.url)}>{`${s.label} ↗`}</LinkText>
                ))}
              </View>
            )}

            {why.notes ? (
              <Disclosure title={<P small bold>Our research notes, as written</P>} testID="why-notes">
                <P small muted>{why.notes}</P>
              </Disclosure>
            ) : null}

            {note ? <Notice tone="ink">{note}</Notice> : null}
            <View style={{ gap: 10 }}>
              {onLookUp && (
                <Button title={lookingUp ? "Looking it up…" : "Find who owns it online"} variant="secondary" onPress={onLookUp} disabled={lookingUp} testID="why-lookup" />
              )}
              {onLookUp && <P small muted={3}>Sends only this shop's name to our look-up service: no amounts, dates or account details.</P>}
              {onSetCountry && <Button title="Set the country myself" variant="secondary" onPress={onSetCountry} testID="why-set-country" />}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16, justifyContent: "center" }}>
                <LinkText onPress={() => reportMistake(why.name)} testID="why-report">Report a mistake</LinkText>
                <LinkText onPress={() => openUrl(METHOD_URL)} testID="why-method">How we work this out ↗</LinkText>
              </View>
              <Button title="Close" variant="ghost" onPress={onClose} testID="why-close" />
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const LEVEL_TONE: Partial<Record<Why["level"], "teal" | "ink" | "ink2" | "ink3" | "stamp">> = {
  checked: "stamp",
  registers: "ink",
  company_register: "ink",
  open_data: "ink2",
  research: "ink2",
  ai: "ink3",
  local: "ink2",
  estimate: "ink3",
  you: "teal",
  none: "ink3",
};

/** Brand → … → top owner, one step per line, with where each is run from (and registered, if different). */
function Chain({ why }: { why: Why }) {
  const t = useTheme();
  return (
    <Card style={{ paddingHorizontal: 12, paddingVertical: 4 }}>
      {why.chain.map((h, i) => (
        <View key={`${h.name}-${i}`} style={{ flexDirection: "row", gap: 10, paddingVertical: 8, borderTopWidth: i ? 1 : 0, borderTopColor: t.rule }}>
          <Text style={{ width: 92, fontSize: 11, fontWeight: "700", letterSpacing: 0.5, color: t.ink3, textTransform: "uppercase", paddingTop: 2 }}>{h.role}</Text>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <P small bold>{h.name}</P>
            {h.country ? (
              <P small muted>
                {flag(h.country)} {countryName(h.country)}
                {h.legal ? ` · registered in ${countryName(h.legal)}` : ""}
              </P>
            ) : null}
          </View>
        </View>
      ))}
    </Card>
  );
}
