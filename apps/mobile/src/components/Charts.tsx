import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import Svg, { Circle, G, Path, Text as SvgText } from "react-native-svg";
import { mapLayout } from "@kys/core/map-layout";
import { topSlices, type Breakdown } from "@/lib/aggregate";
import { countryName, countryShort, flag } from "@/lib/countries";
import { monthLabel, pct } from "@/lib/format";
import { countryColour, serif, useTheme } from "@/lib/theme";
import { Card, P } from "./ui";

/* ── Donut ─────────────────────────────────────────────────────────────── */
export function Donut({ b, size = 240 }: { b: Breakdown; size?: number }) {
  const t = useTheme();
  const slices = topSlices(b.countries);
  const r = size / 2 - 22;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const empty = slices.length === 0;
  const label = empty ? "No data yet" : `Pie chart: ${slices.map((s) => `${countryName(s.iso)} ${pct(s.share)}`).join(", ")}`;
  return (
    <View style={{ alignItems: "center", gap: 16 }}>
      <View accessible accessibilityRole="image" accessibilityLabel={label}>
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <Circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={t.rule} strokeWidth={34} />
          <G rotation={-90} origin={`${size / 2}, ${size / 2}`}>
            {slices.map((s) => {
              const len = s.share * c;
              const el = (
                <Circle
                  key={s.iso}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  stroke={countryColour(t, s.iso)}
                  strokeWidth={34}
                  strokeDasharray={`${Math.max(0, len - 1.5)} ${c}`}
                  strokeDashoffset={-offset}
                />
              );
              offset += len;
              return el;
            })}
          </G>
          <SvgText x={size / 2} y={size * 0.52} textAnchor="middle" fill={t.ink} fontSize={size / 5} fontWeight="700" fontFamily={serif.fontFamily}>
            {empty ? "–" : pct(b.scores.ukShare)}
          </SvgText>
          <SvgText x={size / 2} y={size * 0.64} textAnchor="middle" fill={t.ink2} fontSize={14}>
            UK-owned
          </SvgText>
        </Svg>
      </View>
      <Legend slices={slices} />
    </View>
  );
}

function Legend({ slices }: { slices: { iso: string; share: number }[] }) {
  const t = useTheme();
  return (
    <View style={{ width: "100%", flexDirection: "row", flexWrap: "wrap", rowGap: 6 }}>
      {slices.map((s) => (
        <View key={s.iso} style={{ width: "50%", flexDirection: "row", alignItems: "center", gap: 8, paddingRight: 12 }}>
          <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: countryColour(t, s.iso) }} />
          <Text>{flag(s.iso)}</Text>
          <Text numberOfLines={1} style={{ flex: 1, color: t.ink, fontSize: 14 }}>{countryShort(s.iso)}</Text>
          <Text style={{ color: t.ink, fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{pct(s.share)}</Text>
        </View>
      ))}
    </View>
  );
}

/* ── Ranked bars ──────────────────────────────────────────────────────── */
export function Bars({ b, limit = 10 }: { b: Breakdown; limit?: number }) {
  const t = useTheme();
  const rows = b.countries.slice(0, limit);
  const max = rows[0]?.share ?? 1;
  return (
    <View style={{ gap: 10 }} accessibilityLabel="Spending by owner country, ranked">
      {rows.map((c) => (
        <View key={c.iso}>
          <View style={{ flexDirection: "row", gap: 8, marginBottom: 4 }}>
            <Text>{flag(c.iso)}</Text>
            <Text numberOfLines={1} style={{ flex: 1, color: t.ink, fontSize: 14 }}>{countryName(c.iso)}</Text>
            <Text style={{ color: t.ink, fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{pct(c.share, c.share < 0.01 ? 1 : 0)}</Text>
          </View>
          <View style={{ height: 10, borderRadius: 5, backgroundColor: t.sunk }}>
            <View style={{ height: 10, borderRadius: 5, width: `${Math.max(2, (c.share / max) * 100)}%`, backgroundColor: countryColour(t, c.iso) }} />
          </View>
        </View>
      ))}
      {b.countries.length > limit && <P small muted={3}>+ {b.countries.length - limit} more countries</P>}
    </View>
  );
}

/* ── Over time: 100% stacked bars per month ─────────────────────────── */
export function OverTime({ b }: { b: Breakdown }) {
  const t = useTheme();
  const top = topSlices(b.countries, 5).map((s) => s.iso).filter((i) => i !== "OTHER");
  const months = b.months.slice(-12);
  if (months.length < 2) return <P muted={3} style={{ textAlign: "center", paddingVertical: 40 }}>Add at least two months to see how it changes.</P>;
  return (
    <View>
      <View style={{ height: 176, flexDirection: "row", alignItems: "flex-end", gap: 8 }} accessibilityRole="image" accessibilityLabel="Share of spending by owner country each month">
        {months.map((m) => {
          let other = m.total;
          const parts = top.map((iso) => {
            const v = m.byCountry[iso] ?? 0;
            other -= v;
            return { iso, v };
          });
          parts.push({ iso: "OTHER", v: Math.max(0, other) });
          return (
            <View key={m.month} style={{ flex: 1, height: "100%", alignItems: "center", gap: 4 }}>
              <View style={{ flex: 1, width: "100%", flexDirection: "column-reverse", borderRadius: 6, overflow: "hidden" }}>
                {parts.map((p) => (
                  <View key={p.iso} style={{ height: `${m.total ? (p.v / m.total) * 100 : 0}%`, backgroundColor: countryColour(t, p.iso) }} />
                ))}
              </View>
              <Text style={{ fontSize: 11, color: t.ink3 }}>{monthLabel(m.month)}</Text>
            </View>
          );
        })}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 12 }}>
        {[...top, "OTHER"].map((iso) => (
          <View key={iso} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: countryColour(t, iso) }} />
            <Text style={{ fontSize: 12, color: t.ink2 }}>{countryShort(iso)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/* ── Map (circles, not shaded countries — small places stay visible) ──── */
export function MapView({ b }: { b: Breakdown }) {
  const t = useTheme();
  const W = 340;
  const H = 200;
  const { path, bubbles } = useMemo(() => mapLayout(b.countries, W, H), [b]);
  return (
    <View style={{ gap: 8 }}>
      <View accessible accessibilityRole="image" accessibilityLabel={`Map: ${b.countries.map((c) => `${countryName(c.iso)} ${pct(c.share)}`).join(", ")}`} style={{ width: "100%", aspectRatio: W / H }}>
        <Svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`}>
          <Path d={path} fill={t.sunk} stroke={t.rule} strokeWidth={0.5} />
          {bubbles.map((bb) => (
            <G key={bb.iso}>
              <Circle cx={bb.x} cy={bb.y} r={bb.r} fill={countryColour(t, bb.iso)} fillOpacity={0.85} stroke={t.surface} strokeWidth={1} />
              {bb.r > 11 && (
                <SvgText x={bb.x} y={bb.y + 3.5} textAnchor="middle" fontSize={9} fontWeight="700" fill="#fff">
                  {pct(bb.share)}
                </SvgText>
              )}
            </G>
          ))}
        </Svg>
      </View>
      <P small muted={3}>Circle size = share of your spending.</P>
      <Legend slices={topSlices(b.countries)} />
    </View>
  );
}

/* ── Tiny pie for list rows ───────────────────────────────────────────── */
export function MiniPie({ b, size = 36 }: { b: Breakdown; size?: number }) {
  const t = useTheme();
  const slices = topSlices(b.countries, 4);
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <Svg width={size} height={size}>
      <Circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={t.rule} strokeWidth={7} />
      <G rotation={-90} origin={`${size / 2}, ${size / 2}`}>
        {slices.map((s) => {
          const len = s.share * c;
          const el = <Circle key={s.iso} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={countryColour(t, s.iso)} strokeWidth={7} strokeDasharray={`${len} ${c}`} strokeDashoffset={-offset} />;
          offset += len;
          return el;
        })}
      </G>
    </Svg>
  );
}

/* ── Swipeable carousel ──────────────────────────────────────────────── */
const VIEWS = [
  { id: "pie", label: "Pie" },
  { id: "bars", label: "Ranked" },
  { id: "map", label: "Map" },
  { id: "time", label: "Over time" },
] as const;

export function ChartCarousel({ b, onShare }: { b: Breakdown; onShare?: () => void }) {
  const t = useTheme();
  const [w, setW] = useState(0);
  const [idx, setIdx] = useState(0);
  const scroller = useRef<ScrollView>(null);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!w) return;
    const i = Math.round(e.nativeEvent.contentOffset.x / w);
    if (i !== idx) setIdx(i);
  };
  const go = (i: number) => {
    setIdx(i);
    scroller.current?.scrollTo({ x: i * w, animated: true });
  };
  return (
    <Card style={{ paddingVertical: 16 }}>
      <View style={{ flexDirection: "row", gap: 6, paddingHorizontal: 16, marginBottom: 12 }} accessibilityRole="tablist">
        {VIEWS.map((v, i) => (
          <Pressable
            key={v.id}
            onPress={() => go(i)}
            accessibilityRole="tab"
            accessibilityState={{ selected: idx === i }}
            testID={`chart-tab-${v.id}`}
            style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: idx === i ? t.ink : "transparent", borderWidth: 1, borderColor: idx === i ? t.ink : t.rule }}
          >
            <Text style={{ fontSize: 12, fontWeight: "600", color: idx === i ? t.paper : t.ink2 }}>{v.label}</Text>
          </Pressable>
        ))}
      </View>
      <View onLayout={(e) => setW(e.nativeEvent.layout.width)}>
        {w > 0 && (
          <ScrollView ref={scroller} horizontal pagingEnabled showsHorizontalScrollIndicator={false} onScroll={onScroll} scrollEventThrottle={32} testID="chart-carousel">
            {VIEWS.map((v) => (
              <View key={v.id} style={{ width: w, paddingHorizontal: 16 }}>
                {v.id === "pie" ? <Donut b={b} /> : v.id === "bars" ? <Bars b={b} /> : v.id === "map" ? <MapView b={b} /> : <OverTime b={b} />}
              </View>
            ))}
          </ScrollView>
        )}
      </View>
      <View style={{ flexDirection: "row", justifyContent: "center", gap: 6, marginTop: 12 }}>
        {VIEWS.map((v, i) => (
          <View key={v.id} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: i === idx ? t.ink : t.rule }} />
        ))}
      </View>
      {onShare && (
        <Pressable onPress={onShare} accessibilityRole="button" testID="share-open" style={{ alignSelf: "center", marginTop: 12, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: t.rule }}>
          <Text style={{ fontSize: 14 }}>↗</Text>
          <Text style={{ fontSize: 14, fontWeight: "600", color: t.ink }}>Share as an image</Text>
        </Pressable>
      )}
    </Card>
  );
}
