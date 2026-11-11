import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, serif } from "@/lib/theme";

/** The ＋ sheet: two choices, nothing else. */
export default function AddSheet() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const go = (path: "/add-statement" | "/add-receipt") => {
    router.replace(path);
  };
  return (
    <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "flex-end" }} onPress={() => router.back()} accessibilityLabel="Close">
      <Pressable onPress={() => {}} style={{ alignSelf: "center", width: "100%", maxWidth: 560, backgroundColor: t.paper, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: insets.bottom + 24, gap: 12 }} testID="add-sheet">
        <View style={{ alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: t.rule, marginBottom: 4 }} />
        <Text style={[serif, { fontSize: 22, fontWeight: "600", color: t.ink }]}>What would you like to add?</Text>
        <Option icon="🧾" title="Bank statement" body="A PDF or CSV from your banking app. Covers every card payment." onPress={() => go("/add-statement")} testID="choose-statement" />
        <Option icon="📷" title="Receipt photo" body="Snap a till receipt to see which brands were in the basket." onPress={() => go("/add-receipt")} testID="choose-receipt" />
        <Text style={{ textAlign: "center", color: t.ink3, fontSize: 13, marginTop: 4 }}>Both are read on this phone. Nothing is uploaded.</Text>
      </Pressable>
    </Pressable>
  );
}

function Option({ icon, title, body, onPress, testID }: { icon: string; title: string; body: string; onPress: () => void; testID: string }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} testID={testID} accessibilityRole="button" style={({ pressed }) => ({ flexDirection: "row", gap: 14, alignItems: "center", padding: 16, borderRadius: 18, borderWidth: 1, borderColor: t.rule, backgroundColor: pressed ? t.sunk : t.surface })}>
      <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: t.sunk, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ fontSize: 24 }}>{icon}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 17, fontWeight: "600", color: t.ink }}>{title}</Text>
        <Text style={{ fontSize: 14, color: t.ink2, marginTop: 2 }}>{body}</Text>
      </View>
      <Text style={{ color: t.ink3, fontSize: 20 }}>›</Text>
    </Pressable>
  );
}
