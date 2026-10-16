import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Breakdown } from "@/lib/aggregate";
import { pct } from "@/lib/format";
import { serif, useTheme } from "@/lib/theme";

const EXPLAIN = {
  uk: "Share of the spending we could identify that went to companies whose ultimate owner is run from the UK.",
  countries: "How many different countries the owners of the companies you paid are run from.",
  identified: "How much of your spending is linked to a country. Named owners come from our list or an online lookup; the rest is estimated from where you paid (small independent shops, mostly) or set by you.",
} as const;

/** Descriptive numbers about the user's own spending — never a moral score or a grade for brands. */
export function ScoreTiles({ b }: { b: Breakdown }) {
  const t = useTheme();
  const [open, setOpen] = useState<keyof typeof EXPLAIN | null>(null);
  const empty = b.totalSpend === 0;
  const tiles: { key: keyof typeof EXPLAIN; label: string; value: string }[] = [
    { key: "uk", label: "UK-owned", value: empty ? "–" : pct(b.scores.ukShare) },
    { key: "countries", label: "Countries", value: empty ? "–" : String(b.scores.countryCount) },
    { key: "identified", label: "Has a country", value: empty ? "–" : pct(b.scores.withCountry) },
  ];
  return (
    <View style={{ gap: 8 }} testID="score-tiles">
      <View style={{ flexDirection: "row", gap: 10 }}>
        {tiles.map((x) => (
          <Pressable
            key={x.key}
            onPress={() => setOpen(open === x.key ? null : x.key)}
            accessibilityRole="button"
            accessibilityState={{ expanded: open === x.key }}
            style={{ flex: 1, borderRadius: 18, borderWidth: 1, borderColor: open === x.key ? t.ink3 : t.rule, backgroundColor: t.surface, padding: 12 }}
          >
            <Text style={[serif, { fontSize: 32, fontWeight: "700", color: t.ink, fontVariant: ["tabular-nums"] }]}>{x.value}</Text>
            <Text style={{ marginTop: 4, fontSize: 12, fontWeight: "600", color: t.ink2 }}>{x.label}</Text>
          </Pressable>
        ))}
      </View>
      {open && (
        <View style={{ borderRadius: 12, backgroundColor: t.sunk, paddingHorizontal: 12, paddingVertical: 8 }}>
          <Text style={{ fontSize: 14, color: t.ink2 }}>{EXPLAIN[open]}</Text>
        </View>
      )}
    </View>
  );
}
