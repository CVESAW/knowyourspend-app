import { useMemo, useState } from "react";
import { FlatList, Modal, Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { countries } from "@/lib/ownership";
import { serif, useTheme } from "@/lib/theme";
import { Button, Divider, P } from "./ui";

const ALL = Object.entries(countries)
  .map(([iso, c]) => ({ iso, name: c.name, flag: c.flag }))
  .sort((a, b) => a.name.localeCompare(b.name));
const COMMON = ["GB", "US", "IE", "DE", "FR", "NL", "ES", "IT", "SE", "JP", "CN", "CH", "LU"];

/** "Which country is this?" — the user sets the owner country for a shop we don't know (or got wrong). */
export function CountryPicker({ name, current, open, onPick, onClear, onClose }: {
  name: string;
  current?: string;
  open: boolean;
  onPick: (iso: string) => void;
  onClear?: () => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s) return ALL.filter((c) => c.name.toLowerCase().includes(s) || c.iso.toLowerCase() === s);
    const common = COMMON.map((iso) => ALL.find((c) => c.iso === iso)!).filter(Boolean);
    return [...common, ...ALL.filter((c) => !COMMON.includes(c.iso))];
  }, [q]);
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }} accessibilityLabel="Close">
        <Pressable onPress={() => {}} style={{ alignSelf: "center", width: "100%", maxWidth: 560, maxHeight: "85%", backgroundColor: t.paper, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: insets.bottom + 16, gap: 12 }} testID="country-picker">
          <Text style={[serif, { fontSize: 22, fontWeight: "600", color: t.ink }]}>Which country is this?</Text>
          <P small muted>
            Where is the company that owns <Text style={{ fontFamily: "monospace", color: t.ink }}>{name}</Text> run from? Your answer is used for every payment to it, and kept with the rest of your data, which only you can read.
          </P>
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Search countries"
            placeholderTextColor={t.ink3}
            autoCorrect={false}
            accessibilityLabel="Search countries"
            testID="country-search"
            style={{ minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: t.rule, backgroundColor: t.surface, paddingHorizontal: 12, color: t.ink, fontSize: 16 }}
          />
          <FlatList
            data={list}
            keyExtractor={(c) => c.iso}
            style={{ flexGrow: 0, maxHeight: 360 }}
            keyboardShouldPersistTaps="handled"
            ItemSeparatorComponent={Divider}
            renderItem={({ item: c }) => (
              <Pressable onPress={() => onPick(c.iso)} accessibilityRole="button" testID={`pick-${c.iso}`} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 }}>
                <Text style={{ fontSize: 20 }}>{c.flag}</Text>
                <Text style={{ flex: 1, color: t.ink, fontSize: 15, fontWeight: c.iso === current ? "700" : "400" }}>{c.name}</Text>
                {c.iso === current && <Text style={{ color: t.teal }}>✓</Text>}
              </Pressable>
            )}
          />
          {onClear && <Button title="Use our answer again" variant="ghost" onPress={onClear} testID="clear-override" />}
          <Button title="Cancel" variant="secondary" onPress={onClose} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
