import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { breakdown } from "@/lib/aggregate";
import type { AppData } from "@/lib/data";
import { monthRange, pct, shortDate } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { MiniPie } from "./Charts";
import { Card, Chip, Divider, H2, P, Row } from "./ui";

type Filter = "all" | "statement" | "receipt";

export function ItemsList({ data }: { data: AppData }) {
  const t = useTheme();
  const [filter, setFilter] = useState<Filter>("all");
  const rows = useMemo(
    () => data.items.filter((i) => filter === "all" || i.kind === filter).map((i) => ({ item: i, b: breakdown(data.contribs.filter((c) => c.itemId === i.id)) })),
    [data, filter],
  );
  return (
    <View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <View style={{ flex: 1 }}>
          <H2>Your items</H2>
        </View>
        {(["all", "statement", "receipt"] as Filter[]).map((f) => (
          <Chip key={f} label={f === "all" ? "All" : f === "statement" ? "Statements" : "Receipts"} active={filter === f} onPress={() => setFilter(f)} />
        ))}
      </View>
      {rows.length === 0 ? (
        <Card dashed style={{ padding: 24 }}>
          <P small muted={3} style={{ textAlign: "center" }}>Nothing here yet. Tap ＋ to add a statement or a receipt.</P>
        </Card>
      ) : (
        <Card style={{ overflow: "hidden" }}>
          <View testID="items-list">
            {rows.map(({ item, b }, i) => (
              <View key={item.id}>
                {i > 0 && <Divider />}
                <Row onPress={() => router.push(`/item/${item.id}`)} testID={`item-${item.kind}`}>
                  <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: t.sunk, alignItems: "center", justifyContent: "center" }}>
                    <Text style={{ fontSize: 18 }}>{item.kind === "statement" ? "🧾" : "🛒"}</Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <P bold numberOfLines={1}>{item.title}</P>
                    <P small muted numberOfLines={1}>
                      {item.kind === "statement" ? monthRange(item.dateFrom, item.dateTo) : shortDate(item.receipt?.date ?? item.createdAt)}
                      {b.totalSpend > 0 && ` · ${pct(b.scores.ukShare)} UK-owned · ${b.scores.countryCount} ${b.scores.countryCount === 1 ? "country" : "countries"}`}
                    </P>
                    {item.kind === "receipt" && item.receipt?.matchedTransactionId && <Text style={{ fontSize: 12, color: t.teal }}>Matched to a statement payment</Text>}
                  </View>
                  <MiniPie b={b} />
                </Row>
              </View>
            ))}
          </View>
        </Card>
      )}
    </View>
  );
}
