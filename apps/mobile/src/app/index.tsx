import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle } from "react-native-svg";
import type { Period } from "@/lib/aggregate";
import { useAppData, useBreakdown } from "@/lib/data";
import { countryName, flag } from "@/lib/countries";
import { seedDemo } from "@/lib/demo";
import { pct } from "@/lib/format";
import { entryById } from "@/lib/ownership";
import { store } from "@/lib/store";
import { track } from "@/lib/usage";
import { ONLINE_EXTRAS } from "@/lib/features";
import { serif, useTheme } from "@/lib/theme";
import { ChartCarousel } from "@/components/Charts";
import { ShareSheet } from "@/components/ShareSheet";
import { EmailResultsSheet } from "@/components/EmailResultsSheet";
import { ItemsList } from "@/components/ItemsList";
import { KeepSafeCard } from "@/components/KeepSafeCard";
import { useBrandListReady } from "@/lib/brand-data";
import { ScoreTiles } from "@/components/ScoreTiles";
import { BasisBadge, Button, Card, Chip, Divider, H1, H2, LinkText, P, Page, Row, Spinner, TierBadge } from "@/components/ui";

const PERIODS: { id: Period; label: string }[] = [
  { id: "1m", label: "1 month" },
  { id: "3m", label: "3 months" },
  { id: "12m", label: "12 months" },
  { id: "all", label: "All" },
];

const PERIOD_LABEL: Record<Period, string> = { "1m": "Last month", "3m": "Last 3 months", "12m": "Last 12 months", all: "All my spending" };

export default function Home() {
  const t = useTheme();
  const data = useAppData();
  const [period, setPeriod] = useState<Period>("all");
  const b = useBreakdown(data, period);
  const [seeding, setSeeding] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const listReady = useBrandListReady();
  // The website's "Try a sample statement" button opens /?demo=1: go straight into the demo.
  const { demo: demoParam } = useLocalSearchParams<{ demo?: string }>();
  const demoStarted = useRef(false);
  useEffect(() => {
    if (demoParam !== "1" || !data.loaded || demoStarted.current) return;
    demoStarted.current = true;
    router.setParams({ demo: undefined });
    if (data.demo) return;
    setSeeding(true);
    track("demo_opened");
    seedDemo().finally(() => setSeeding(false));
  }, [demoParam, data.loaded, data.demo]);

  if (!data.loaded || seeding || (!listReady && data.items.length > 0)) return <View style={{ flex: 1, justifyContent: "center", backgroundColor: t.paper }}><Spinner label={seeding ? "Building the demo on this phone…" : "Loading…"} /></View>;

  const empty = data.items.length === 0;
  const topCompanies = b.countries
    .flatMap((c) => c.entries.map((e) => ({ ...e, iso: c.iso })))
    .sort((a, c) => c.amount - a.amount)
    .slice(0, 5);

  const startDemo = async () => {
    setSeeding(true);
    track("demo_opened");
    await seedDemo();
    setSeeding(false);
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.paper }}>
      <Page bottomInset={120} testID="home">
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text style={[serif, { flex: 1, fontSize: 20, fontWeight: "700", color: t.ink }]}>KnowYourSpend</Text>
        </View>

        {data.demo && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 12, backgroundColor: t.sunk, paddingHorizontal: 12, paddingVertical: 8 }} testID="demo-banner">
            <P small muted style={{ flex: 1 }}>You're looking at made-up demo data.</P>
            <LinkText onPress={() => store.load("real")} testID="exit-demo">Exit demo</LinkText>
          </View>
        )}

        {empty ? (
          <Card dashed style={{ padding: 24, alignItems: "center", gap: 8 }} >
            <View testID="empty-home" style={{ alignItems: "center", gap: 8 }}>
              <Svg width={120} height={120} viewBox="0 0 120 120">
                <Circle cx={60} cy={60} r={44} fill="none" stroke={t.rule} strokeWidth={18} />
              </Svg>
              <H1 style={{ textAlign: "center", fontSize: 24 }}>Let's see who you pay</H1>
              <P muted style={{ textAlign: "center" }}>Tap the ＋ button below to add a bank statement or photograph a receipt.</P>
              <P small muted={3} style={{ textAlign: "center", marginTop: 8 }}>
                Want a look first? <LinkText onPress={startDemo} testID="try-demo">Try the demo</LinkText>
              </P>
            </View>
          </Card>
        ) : (
          <>
            <H1>
              {b.totalSpend > 0 ? (
                <>
                  <Text style={{ fontVariant: ["tabular-nums"] }}>{pct(1 - b.scores.ukShare)}</Text> went to companies owned outside the UK
                </>
              ) : (
                "Your spending"
              )}
            </H1>
            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
              {PERIODS.map((p) => (
                <Chip key={p.id} label={p.label} active={period === p.id} onPress={() => setPeriod(p.id)} testID={`period-${p.id}`} />
              ))}
            </View>
            <ScoreTiles b={b} />
            <ChartCarousel b={b} onShare={b.totalSpend > 0 ? () => setSharing(true) : undefined} />
            <ShareSheet b={b} periodLabel={PERIOD_LABEL[period]} open={sharing} onClose={() => setSharing(false)} />
            {ONLINE_EXTRAS && b.totalSpend > 0 && !data.demo && (
              <>
                <Button title="Email me my results" icon="✉︎" variant="secondary" onPress={() => setEmailing(true)} testID="email-results" />
                <EmailResultsSheet b={b} periodLabel={PERIOD_LABEL[period]} open={emailing} onClose={() => setEmailing(false)} />
              </>
            )}
            <P small muted={3}>
              Named owners for {pct(b.scores.identified)} of your spending
              {b.estimatedSpend > 0 && ` · ${pct(b.estimatedSpend / Math.max(b.totalSpend, 0.01))} estimated from where you paid`}
              {b.unmatched.length > 0 && ` · ${b.unmatched.length} shops not counted`}
              {data.otherCurrency > 0 && ` · ${data.otherCurrency} non-GBP payments not included`}
            </P>
            {topCompanies.length > 0 && (
              <View>
                <H2>Who you pay most</H2>
                <Card style={{ overflow: "hidden" }}>
                  {topCompanies.map((c, i) => {
                    const e = c.basis === "owner" ? entryById(c.entryId) : undefined;
                    const parent = e?.chain[e.chain.length - 1]?.name ?? c.name;
                    return (
                      <View key={c.entryId}>
                        {i > 0 && <Divider />}
                        <Row>
                          <Text style={{ fontSize: 20 }}>{flag(c.iso)}</Text>
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <P bold numberOfLines={1}>{e?.display_name ?? c.name}</P>
                            <P small muted numberOfLines={1}>{parent === c.name ? countryName(c.iso) : `${parent} · ${countryName(c.iso)}`}</P>
                          </View>
                          {e ? <TierBadge tier={e.tier} /> : c.basis !== "owner" ? <BasisBadge basis={c.basis} /> : null}
                        </Row>
                      </View>
                    );
                  })}
                </Card>
              </View>
            )}
          </>
        )}
        <KeepSafeCard hasData={!empty && !data.demo} />
        <ItemsList data={data} />
      </Page>
      <AddBar />
    </View>
  );
}

/** Bottom bar with the big centre ＋ (TikTok-style): the one obvious way to add something. */
function AddBar() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const side = (icon: string, label: string, onPress: () => void, testID: string, active?: boolean) => (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} testID={testID} style={{ flex: 1, alignItems: "center", gap: 2, paddingTop: 10 }}>
      <Text style={{ fontSize: 20, color: active ? t.ink : t.ink3 }}>{icon}</Text>
      <Text style={{ fontSize: 11, fontWeight: "600", color: active ? t.ink : t.ink3 }}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: t.surface, borderTopWidth: 1, borderTopColor: t.rule, paddingBottom: insets.bottom + 6 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", alignSelf: "center", width: "100%", maxWidth: 560 }}>
        {side("◉", "Home", () => {}, "tab-home", true)}
        <View style={{ width: 96, alignItems: "center" }}>
          <Pressable
            onPress={() => router.push("/add")}
            accessibilityRole="button"
            accessibilityLabel="Add a statement or receipt"
            testID="add-button"
            style={({ pressed }) => ({
              marginTop: -22,
              width: 64,
              height: 64,
              borderRadius: 32,
              backgroundColor: t.oxblood,
              borderWidth: 4,
              borderColor: t.paper,
              alignItems: "center",
              justifyContent: "center",
              transform: [{ scale: pressed ? 0.94 : 1 }],
              shadowColor: "#000",
              shadowOpacity: 0.2,
              shadowRadius: 10,
              shadowOffset: { width: 0, height: 4 },
              elevation: 6,
            })}
          >
            <Text style={{ color: t.onOxblood, fontSize: 32, lineHeight: 36, fontWeight: "300" }}>＋</Text>
          </Pressable>
        </View>
        {side("⚙︎", "Settings", () => router.push("/settings"), "open-settings")}
      </View>
    </View>
  );
}
