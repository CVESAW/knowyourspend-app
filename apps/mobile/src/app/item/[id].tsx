import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { breakdown } from "@/lib/aggregate";
import { countryName, flag } from "@/lib/countries";
import { useAppData } from "@/lib/data";
import { money, monthRange, pct, shortDate } from "@/lib/format";
import { deleteItem } from "@/lib/ingest";
import { entryById } from "@/lib/ownership";
import { clearCountry, setCountry } from "@/lib/fixes";
import { lookUp, recordSent, sendable } from "@/lib/lookup";
import { useStore } from "@/lib/store";
import { EVIDENCE_LABEL } from "@kys/core/locate";
import { CountryPicker } from "@/components/CountryPicker";
import { useTheme } from "@/lib/theme";
import { ChartCarousel } from "@/components/Charts";
import { ShareSheet } from "@/components/ShareSheet";
import { EmailResultsSheet } from "@/components/EmailResultsSheet";
import { ONLINE_EXTRAS } from "@/lib/features";
import { DataLeavesPanel } from "@/components/DataLeavesPanel";
import { reportMistake } from "@/lib/links";
import { useBrandListReady } from "@/lib/brand-data";
import { BackLink, BasisBadge, Button, Card, Divider, Eyebrow, H1, H2, LinkText, Notice, P, Page, Row, Spinner, TierBadge } from "@/components/ui";
import type { Contribution } from "@/lib/aggregate";

interface Shop { payee: string; label: string; amount: number; country?: string; basis?: Contribution["basis"]; entryId?: string; evidence?: Contribution["evidence"] }

export default function Report() {
  const t = useTheme();
  const { id, new: isNew } = useLocalSearchParams<{ id: string; new?: string }>();
  const data = useAppData();
  const listReady = useBrandListReady();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [picking, setPicking] = useState<Shop | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [looking, setLooking] = useState<string | null>(null);
  const { prefs } = useStore();
  const item = data.items.find((i) => i.id === id);
  // Every shop paid in this item, one row per payee (the user fixes the country here).
  const shops = useMemo(() => {
    const m = new Map<string, Shop>();
    for (const c of data.contribs) {
      if (c.itemId !== id || c.source !== "statement" || !c.payee) continue;
      const cur = m.get(c.payee) ?? { payee: c.payee, label: c.label, amount: 0, country: c.country, basis: c.basis, entryId: c.entryId, evidence: c.evidence };
      cur.amount += c.amount;
      m.set(c.payee, cur);
    }
    return [...m.values()].filter((x) => x.amount > 0.005).sort((a, b) => b.amount - a.amount);
  }, [data, id]);
  const b = useMemo(() => breakdown(data.contribs.filter((c) => c.itemId === id)), [data, id]);
  const receiptLines = data.lines.filter((l) => l.itemId === id && l.included);
  const home = () => (router.canGoBack() ? router.back() : router.replace("/"));

  if (!data.loaded || !listReady) return <Spinner label="Loading…" />;
  if (!item)
    return (
      <Page>
        <P muted>This item isn't on this phone. <LinkText onPress={() => router.replace("/")}>Home</LinkText></P>
      </Page>
    );

  const others = b.countries.filter((c) => c.iso !== "GB");
  const foreign = others
    .flatMap((c) => c.entries.filter((e) => e.basis === "owner" && entryById(e.entryId)).map((e) => ({ ...e, iso: c.iso })))
    .sort((a, c) => c.amount - a.amount)
    .slice(0, 3);
  const pending = prefs.lookup === "off" ? [] : sendable(shops.filter((x) => x.basis !== "owner" && x.basis !== "you" && !item.disclosure.sensitiveHeld.includes(x.payee)).map((x) => x.payee));
  const findOwners = async () => {
    setLooking(null);
    const r = await lookUp(pending, item.id);
    await recordSent(item.id, r.sent);
    setLooking(r.error ? `Couldn't finish: ${r.error}. Try again later.` : `Found owners for ${r.found} of ${r.sent.length}.`);
  };
  const visibleShops = showAll ? shops : shops.slice(0, 12);

  return (
    <Page testID="report">
      <BackLink label="‹ Home" onPress={home} />
      {isNew === "1" && <Notice>Added. Your home screen has been updated.</Notice>}
      <View style={{ gap: 6 }}>
        <Eyebrow>
          {item.kind === "statement" ? "Statement" : "Receipt"} · {item.kind === "statement" ? monthRange(item.dateFrom, item.dateTo) : shortDate(item.receipt?.date)}
        </Eyebrow>
        <H1>{item.title}</H1>
        {b.totalSpend > 0 ? (
          <P muted testID="report-summary">
            Of <Text style={{ fontWeight: "700", color: t.ink }}>{money(b.totalSpend)}</Text> spent{item.kind === "statement" ? " in this statement" : ""},{" "}
            <Text style={{ fontWeight: "700", color: t.ink }}>{pct(b.scores.ukShare)}</Text> went to UK-owned companies and{" "}
            <Text style={{ fontWeight: "700", color: t.ink }}>{pct(1 - b.scores.ukShare)}</Text> to companies owned from {others.length} other {others.length === 1 ? "country" : "countries"}.
          </P>
        ) : (
          <P muted>No spending we could analyse in this item.</P>
        )}
        {item.receipt?.matchedTransactionId && (
          <P small style={{ color: t.teal }}>This receipt matches a payment in one of your statements, so it splits that payment into brands instead of counting it twice.</P>
        )}
      </View>

      {b.totalSpend > 0 && (
        <>
          <ChartCarousel b={b} onShare={() => setSharing(true)} />
          <ShareSheet b={b} periodLabel={item.kind === "receipt" ? "One shop" : monthRange(item.dateFrom, item.dateTo)} open={sharing} onClose={() => setSharing(false)} />
          {ONLINE_EXTRAS && item.kind === "statement" && !data.demo && (
            <>
              <Button title="Email me these results" icon="✉︎" variant="secondary" onPress={() => setEmailing(true)} testID="email-results" />
              <EmailResultsSheet b={b} periodLabel={monthRange(item.dateFrom, item.dateTo)} open={emailing} onClose={() => setEmailing(false)} />
            </>
          )}
        </>
      )}
      <DataLeavesPanel kind={item.kind} record={item.disclosure} />

      {b.countries.length > 0 && (
        <View>
          <H2>By owner country</H2>
          <View style={{ gap: 8 }}>
            {b.countries.map((c) => (
              <Card key={c.iso} style={{ padding: 16, gap: 4 }}>
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                  <Text style={{ fontSize: 20 }}>{flag(c.iso)}</Text>
                  <P bold style={{ flex: 1 }}>{countryName(c.iso)}</P>
                  <P bold>{pct(c.share)}</P>
                  <P small muted={3}>{money(c.amount)}</P>
                </View>
                <P small muted>
                  {c.entries.slice(0, 6).map((e) => e.name).join(", ")}
                  {c.entries.length > 6 && ` +${c.entries.length - 6} more`}
                </P>
              </Card>
            ))}
          </View>
        </View>
      )}

      {foreign.length > 0 && (
        <View>
          <H2>Worth knowing</H2>
          <View style={{ gap: 8 }}>
            {foreign.map((f) => {
              const e = entryById(f.entryId)!;
              const top = e.chain[e.chain.length - 1];
              return (
                <Card key={f.entryId} style={{ padding: 16, flexDirection: "row", gap: 12 }}>
                  <Text style={{ fontSize: 20 }}>{flag(f.iso)}</Text>
                  <View style={{ flex: 1, gap: 6 }}>
                    <P small>
                      <Text style={{ fontWeight: "700" }}>{e.display_name}</Text> is owned by <Text style={{ fontWeight: "700" }}>{top?.name}</Text>, run from {countryName(e.owner_country)}.
                    </P>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <P small muted={3}>Checked {shortDate(e.as_of)}</P>
                      <TierBadge tier={e.tier} />
                    </View>
                  </View>
                </Card>
              );
            })}
          </View>
        </View>
      )}

      {item.kind === "receipt" && receiptLines.length > 0 && (
        <View>
          <H2>What was in the basket</H2>
          <Card style={{ overflow: "hidden" }}>
            {receiptLines.map((l, i) => {
              const e = entryById(l.entryId);
              return (
                <View key={l.id}>
                  {i > 0 && <Divider />}
                  <Row>
                    <Text style={{ width: 24, textAlign: "center" }}>{e ? flag(e.owner_country) : "·"}</Text>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text numberOfLines={1} style={{ fontFamily: "monospace", fontSize: 12, color: t.ink }}>{l.text}</Text>
                      <P small muted numberOfLines={1}>{e ? `${e.display_name} · ${e.chain[e.chain.length - 1]?.name}` : `Counted under ${item.receipt?.storeText ?? "the shop"}`}</P>
                    </View>
                    <P small>{l.price != null ? money(l.price) : ""}</P>
                  </Row>
                </View>
              );
            })}
          </Card>
        </View>
      )}

      {shops.length > 0 && (
        <View>
          <H2>Shops in this statement</H2>
          <P small muted style={{ marginBottom: 8 }}>
            {pct(b.scores.identified)} of spending has a named owner
            {b.estimatedSpend > 0 ? `; ${pct(b.estimatedSpend / Math.max(b.totalSpend, 0.01))} is estimated from where you paid` : ""}. Tap a shop to set its country yourself.
          </P>
          {pending.length > 0 && (
            <Card style={{ padding: 14, gap: 8, marginBottom: 8 }}>
              <P bold>Find owners for {pending.length} shop{pending.length === 1 ? "" : "s"} we don't know</P>
              <P small muted>Sends only these shop names to our lookup service — no amounts, dates or account details.</P>
              <Button title="Look them up" variant="secondary" onPress={findOwners} testID="find-owners" />
            </Card>
          )}
          {looking && <Notice tone="ink">{looking}</Notice>}
          <Card style={{ overflow: "hidden" }}>
            {visibleShops.map((x, i) => {
              const e = x.basis === "owner" ? entryById(x.entryId) : undefined;
              const top = e?.chain[e.chain.length - 1]?.name;
              const sub = e
                ? `${top && top !== e.display_name ? `${top} · ` : ""}${countryName(x.country!)}`
                : x.basis === "you"
                  ? `${countryName(x.country!)} · your choice`
                  : x.country
                    ? `${countryName(x.country)} · ${EVIDENCE_LABEL[x.evidence ?? "home"]}`
                    : "Not matched";
              return (
                <View key={x.payee}>
                  {i > 0 && <Divider />}
                  <Row onPress={() => setPicking(x)} testID={`shop-${x.payee}`}>
                    <Text style={{ width: 24, textAlign: "center", fontSize: 18 }}>{x.country ? flag(x.country) : "·"}</Text>
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <P bold numberOfLines={1}>{e?.display_name ?? x.label}</P>
                      <P small muted numberOfLines={2}>{sub}</P>
                    </View>
                    <View style={{ alignItems: "flex-end", gap: 4 }}>
                      <P small>{money(x.amount)}</P>
                      {e ? <TierBadge tier={e.tier} /> : x.basis === "you" || x.basis === "estimated" ? <BasisBadge basis={x.basis} /> : null}
                    </View>
                  </Row>
                </View>
              );
            })}
          </Card>
          {shops.length > 12 && (
            <View style={{ marginTop: 8 }}>
              <LinkText onPress={() => setShowAll((v) => !v)} testID="shops-all">{showAll ? "Show fewer" : `Show all ${shops.length} shops`}</LinkText>
            </View>
          )}
          <CountryPicker
            open={!!picking}
            name={picking?.label ?? ""}
            current={picking?.country}
            onClose={() => setPicking(null)}
            onPick={async (iso) => {
              if (picking) await setCountry(picking.payee, iso);
              setPicking(null);
            }}
            onClear={picking && prefs.overrides[picking.payee] ? async () => {
              await clearCountry(picking.payee);
              setPicking(null);
            } : undefined}
          />
        </View>
      )}

      {b.unmatched.length > 0 && (
        <P small muted={3}>
          {b.unmatched.length} shop{b.unmatched.length === 1 ? "" : "s"} not counted ({money(b.unmatchedSpend)}). Turn on “Estimate shops we don't know” in Settings to count them by where you paid.
        </P>
      )}

      <P small muted={3}>
        Estimates based on published ownership data; may contain errors.{" "}
        <LinkText onPress={() => reportMistake(item.title)} testID="report-mistake">Report a mistake</LinkText>
      </P>

      <View style={{ gap: 10 }}>
        <Button title="Back to home" variant="secondary" onPress={home} />
        {confirmDelete ? (
          <Button
            title="Yes, delete it from this phone"
            variant="danger"
            onPress={async () => {
              await deleteItem(item.id);
              router.replace("/");
            }}
            testID="confirm-delete"
          />
        ) : (
          <Button title="Delete this item" variant="ghost" onPress={() => setConfirmDelete(true)} testID="delete-item" />
        )}
      </View>
    </Page>
  );
}
