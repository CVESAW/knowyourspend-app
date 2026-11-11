import { useMemo, useState } from "react";
import { Image, Platform, Pressable, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { isSensitive, normalisePayee } from "@kys/statement";
import { pickReceiptPhoto, type Picked, discard } from "@/lib/files";
import { useOwnershipVersion } from "@/lib/brand-data";
import { money } from "@/lib/format";
import { newId } from "@/lib/id";
import { offDisclosure, saveReceipt } from "@/lib/ingest";
import type { LookupPlan } from "@/lib/lookup";
import { OCR_AVAILABLE, readReceiptImage } from "@/lib/ocr";
import { allEntries, entryById, resolver } from "@/lib/ownership";
import type { ParsedReceipt, ParsedReceiptLine } from "@/lib/receipt";
import { useTheme } from "@/lib/theme";
import { DataLeavesPanel } from "@/components/DataLeavesPanel";
import { BackLink, Button, Card, Divider, Eyebrow, H1, LinkText, P, Page, ProgressBar, Spinner } from "@/components/ui";

type Step = "capture" | "reading" | "confirm" | "saving";
interface EditLine extends ParsedReceiptLine {
  id: string;
  included: boolean;
}
const merchantList = (_version: number) => allEntries.filter((e) => e.kind === "merchant").sort((a, b) => a.display_name.localeCompare(b.display_name));

export default function AddReceipt() {
  const listVersion = useOwnershipVersion();
  // listVersion is read so the list is rebuilt when the full brand list arrives
  const merchants = useMemo(() => merchantList(listVersion), [listVersion]);
  const t = useTheme();
  const [step, setStep] = useState<Step>("capture");
  const [photo, setPhoto] = useState<Picked | null>(null);
  const [progress, setProgress] = useState(0);
  const [parsed, setParsed] = useState<ParsedReceipt | null>(null);
  const [storeId, setStoreId] = useState("");
  const [storeText, setStoreText] = useState("");
  const [pickShop, setPickShop] = useState(false);
  const [shopQuery, setShopQuery] = useState("");
  const [date, setDate] = useState("");
  const [total, setTotal] = useState("");
  const [lines, setLines] = useState<EditLine[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const onPhoto = async (source: "camera" | "library") => {
    setErr(null);
    const p = await pickReceiptPhoto(source);
    if (!p) return;
    setPhoto(p);
    setStep("reading");
    setProgress(0.02);
    try {
      const r = await readReceiptImage(p, setProgress);
      setParsed(r);
      setStoreId(r.storeEntryId ?? "");
      setStoreText(r.storeText ?? "");
      setDate(r.date ?? new Date().toISOString().slice(0, 10));
      setTotal(r.total != null ? r.total.toFixed(2) : "");
      setLines(r.lines.map((l) => ({ ...l, id: newId("l_"), included: true })));
      setStep("confirm");
    } catch (e) {
      setErr((e as Error).message || "We couldn't read this receipt.");
      setStep("capture");
    } finally {
      setPhoto(null); // the photo is not kept
      discard(p); // nor is the app's temporary copy of it
    }
  };

  const editLine = (id: string, text: string) =>
    setLines((ls) =>
      ls.map((l) => {
        if (l.id !== id) return l;
        const r = resolver.resolveProduct(text);
        const ok = r.status === "RESOLVED";
        return { ...l, text, entryId: ok ? r.entry?.id : undefined, brandName: ok ? r.entry?.display_name : undefined, ownBrandRetailerId: r.own_brand_retailer?.id };
      }),
    );

  // Only the shop name could ever be looked up online for a receipt — never the items you bought.
  const plan: LookupPlan = useMemo(() => {
    const norm = storeId ? "" : normalisePayee(storeText);
    const sensitive = norm && isSensitive(norm) ? [norm] : [];
    const candidates = norm && !sensitive.length ? [norm] : [];
    return { rowsRead: lines.length, recognisedLocally: lines.filter((l) => l.entryId).length + (storeId ? 1 : 0), transfersExcluded: 0, candidates, sensitive };
  }, [storeId, storeText, lines]);

  const save = async () => {
    setStep("saving");
    const shop = entryById(storeId);
    const tot = Number(total.replace(",", "."));
    const item = await saveReceipt(
      {
        storeText: shop?.display_name ?? (storeText || undefined),
        storeEntryId: shop?.id,
        date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
        total: isFinite(tot) && tot > 0 ? tot : undefined,
        lines,
      },
      { ...offDisclosure(plan), ...(Platform.OS !== "web" ? { ocrMetrics: true } : {}) },
    );
    router.replace({ pathname: "/item/[id]", params: { id: item.id, new: "1" } });
  };

  const shop = entryById(storeId);
  const shopMatches = shopQuery ? merchants.filter((m) => m.display_name.toLowerCase().includes(shopQuery.toLowerCase())).slice(0, 8) : merchants.slice(0, 8);
  const input = { minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: t.rule, backgroundColor: t.surface, paddingHorizontal: 10, color: t.ink, fontSize: 16 } as const;

  return (
    <Page testID="add-receipt">
      <BackLink onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} />
      <H1>Add a receipt</H1>

      {step === "capture" && (
        <View style={{ gap: 14 }}>
          {!OCR_AVAILABLE && (
            <Card style={{ padding: 16 }}>
              <P muted>Reading receipts needs the full KnowYourSpend app, not the Expo Go preview. For now, open KnowYourSpend in your web browser to add receipts.</P>
            </Card>
          )}
          <View style={{ alignSelf: "center", width: "100%", maxWidth: 320, aspectRatio: 3 / 4, borderRadius: 24, borderWidth: 1, borderColor: t.rule, backgroundColor: t.sunk, alignItems: "center", justifyContent: "center" }}>
            <View style={{ position: "absolute", top: 24, left: 24, right: 24, bottom: 24, borderRadius: 16, borderWidth: 2, borderStyle: "dashed", borderColor: t.ink3 }} />
            <P small muted style={{ textAlign: "center", maxWidth: "70%" }}>Lay the receipt flat in good light, with the whole thing in the frame.</P>
          </View>
          <Button title="Take a photo" icon="📷" onPress={() => onPhoto("camera")} disabled={!OCR_AVAILABLE} testID="receipt-camera" />
          <Button title="Choose from photos" variant="secondary" onPress={() => onPhoto("library")} disabled={!OCR_AVAILABLE} testID="receipt-library" />
          {err && <P small style={{ color: t.oxblood }}>{err}</P>}
          <P small muted={3} style={{ textAlign: "center" }}>The photo is read on this phone and then thrown away. It's never uploaded.</P>
        </View>
      )}

      {step === "reading" && (
        <Card style={{ padding: 20, gap: 14 }}>
          {photo && <Image source={{ uri: photo.uri }} style={{ height: 240, borderRadius: 12 }} resizeMode="contain" accessibilityLabel="Your receipt" />}
          <P bold>Reading your receipt on this phone…</P>
          <ProgressBar value={progress} />
          <P small muted={3}>The first receipt takes a little longer while the reader loads.</P>
        </Card>
      )}

      {step === "confirm" && parsed && (
        <View style={{ gap: 16 }} testID="receipt-confirm">
          <P muted>Here's what we read. Fix anything that's wrong — it only takes a second.</P>
          <Card style={{ padding: 16, gap: 12 }}>
            <View style={{ gap: 6 }}>
              <Eyebrow>Shop</Eyebrow>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <P bold style={{ flex: 1 }} >
                  <Text testID="receipt-shop">{shop ? shop.display_name : storeText ? `Not recognised: ${storeText}` : "Choose the shop…"}</Text>
                </P>
                <LinkText onPress={() => setPickShop((s) => !s)} testID="change-shop">{pickShop ? "Done" : "Change"}</LinkText>
              </View>
              {pickShop && (
                <View style={{ gap: 6 }}>
                  <TextInput value={shopQuery} onChangeText={setShopQuery} placeholder="Search shops" placeholderTextColor={t.ink3} style={input} />
                  {shopMatches.map((m) => (
                    <Pressable key={m.id} onPress={() => { setStoreId(m.id); setPickShop(false); setShopQuery(""); }} style={{ paddingVertical: 8 }}>
                      <P>{m.display_name}</P>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ flex: 1, gap: 6 }}>
                <Eyebrow>Date</Eyebrow>
                <TextInput value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" placeholderTextColor={t.ink3} style={input} testID="receipt-date" />
              </View>
              <View style={{ flex: 1, gap: 6 }}>
                <Eyebrow>Total (£)</Eyebrow>
                <TextInput value={total} onChangeText={setTotal} keyboardType="decimal-pad" inputMode="decimal" style={input} testID="receipt-total" />
              </View>
            </View>
          </Card>
          <Card style={{ paddingVertical: 8 }}>
            <View style={{ paddingHorizontal: 16, paddingVertical: 6 }}>
              <Eyebrow>Items · {lines.filter((l) => l.entryId).length} brands recognised</Eyebrow>
            </View>
            {lines.length === 0 && <P small muted={3} style={{ padding: 16 }}>We couldn't pick out individual items. That's fine — the whole receipt will count under the shop.</P>}
            {lines.map((l, i) => {
              const e = entryById(l.entryId);
              return (
                <View key={l.id} style={{ opacity: l.included ? 1 : 0.4 }} testID="receipt-line">
                  {i > 0 && <Divider />}
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 8 }}>
                    <Pressable
                      onPress={() => setLines((ls) => ls.map((x) => (x.id === l.id ? { ...x, included: !x.included } : x)))}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: l.included }}
                      accessibilityLabel={`Include ${l.text}`}
                      style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: t.ink3, backgroundColor: l.included ? t.ink : "transparent", alignItems: "center", justifyContent: "center" }}
                    >
                      {l.included && <Text style={{ color: t.paper, fontSize: 13, fontWeight: "700" }}>✓</Text>}
                    </Pressable>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <TextInput value={l.text} onChangeText={(v) => editLine(l.id, v.toUpperCase())} style={{ fontFamily: "monospace", fontSize: 12, color: t.ink, padding: 0 }} accessibilityLabel="Item text" />
                      <Text style={{ fontSize: 12, color: e ? t.ink2 : t.ink3 }} testID="receipt-line-brand">{e ? e.display_name : "Own-brand or not recognised — counts under the shop"}</Text>
                    </View>
                    <Text style={{ fontSize: 14, color: t.ink, fontVariant: ["tabular-nums"] }}>{l.price != null ? money(l.price) : ""}</Text>
                  </View>
                </View>
              );
            })}
          </Card>
          <DataLeavesPanel kind="receipt" plan={plan} />
          <Button title="Analyse this receipt" onPress={save} disabled={!storeId && !storeText} testID="confirm-receipt" />
          <Button title="Retake photo" variant="ghost" onPress={() => setStep("capture")} />
        </View>
      )}

      {step === "saving" && (
        <Card>
          <Spinner label="Working out who owns what…" />
        </Card>
      )}
    </Page>
  );
}
