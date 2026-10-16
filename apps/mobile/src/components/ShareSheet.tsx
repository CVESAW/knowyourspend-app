import { useMemo, useRef, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SvgXml } from "react-native-svg";
import { topSlices, type Breakdown } from "@/lib/aggregate";
import { SHARE_H, SHARE_W, shareSvg, shareText } from "@kys/core/share-card";
import { shareCard } from "@/lib/share";
import { serif, useTheme } from "@/lib/theme";
import { Button, P } from "./ui";

/**
 * Preview and share a card built only from percentages and country names — never amounts, dates
 * or shop names (the share model can't carry them).
 */
export function ShareSheet({ b, periodLabel, open, onClose }: { b: Breakdown; periodLabel: string; open: boolean; onClose: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const cardRef = useRef<View>(null);
  const [status, setStatus] = useState<string | null>(null);
  const model = useMemo(() => ({ ukShare: b.scores.ukShare, slices: topSlices(b.countries).map((s) => ({ iso: s.iso, share: s.share })), periodLabel }), [b, periodLabel]);
  const svg = useMemo(() => shareSvg(model), [model]);

  const share = async () => {
    setStatus(null);
    try {
      const r = await shareCard(svg, cardRef, shareText(model));
      if (r === "downloaded") setStatus("Image saved — it shows percentages only, never amounts.");
    } catch {
      setStatus("Couldn't create the image. Please try again.");
    }
  };

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }} accessibilityLabel="Close">
        <Pressable onPress={() => {}} style={{ alignSelf: "center", width: "100%", maxWidth: 560, backgroundColor: t.paper, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: insets.bottom + 20, gap: 14 }} testID="share-sheet">
          <Text style={[serif, { fontSize: 22, fontWeight: "600", color: t.ink }]}>Share your card</Text>
          <View ref={cardRef} collapsable={false} style={{ alignSelf: "center", width: "62%", maxWidth: 300, aspectRatio: SHARE_W / SHARE_H, borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: t.rule }} testID="share-card">
            <SvgXml xml={svg} width="100%" height="100%" />
          </View>
          <P small muted style={{ textAlign: "center" }}>Only percentages and countries — no amounts, dates or shop names.</P>
          <Button title="Share" icon="↗" onPress={share} testID="share-now" />
          <Button title="Close" variant="ghost" onPress={onClose} />
          {status && <P small muted style={{ textAlign: "center" }} testID="share-status">{status}</P>}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
