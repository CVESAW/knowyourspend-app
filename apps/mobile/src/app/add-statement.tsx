import { useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { guessMapping, type ColumnMapping, type ParseResult } from "@kys/statement";
import { BANK_GUIDES } from "@/lib/bank-guides";
import { isPdf, pickStatement } from "@/lib/files";
import { monthRange } from "@/lib/format";
import { newItemId, prepareStatement, readStatementBytes, saveStatement, type PreparedStatement } from "@/lib/ingest";
import { disclosureFor, lookUp, recordSent, sendable } from "@/lib/lookup";
import { useStore } from "@/lib/store";
import { kv } from "@/lib/kv";
import { PDF_AVAILABLE, readStatementPdf } from "@/lib/pdf";
import { useTheme } from "@/lib/theme";
import { DataLeavesPanel } from "@/components/DataLeavesPanel";
import { BackLink, Button, Card, Chip, Divider, Eyebrow, H1, LinkText, P, Page, Row, Spinner } from "@/components/ui";

type Step = "bank" | "file" | "reading" | "mapping" | "check" | "saving" | "looking" | "error";
const BANK_KEY = "kys.bank";
const FIELDS = [
  { k: "date", label: "Date" },
  { k: "description", label: "Description" },
  { k: "amount", label: "Amount (±)" },
  { k: "paidOut", label: "Paid out" },
  { k: "paidIn", label: "Paid in" },
] as const;

export default function AddStatement() {
  const t = useTheme();
  const [step, setStep] = useState<Step>("bank");
  const [bankId, setBankId] = useState<string | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  const [file, setFile] = useState<{ name: string; bytes: ArrayBuffer } | null>(null);
  const [parse, setParse] = useState<ParseResult | null>(null);
  const [mapping, setMapping] = useState<Partial<ColumnMapping>>({});
  const [prep, setPrep] = useState<PreparedStatement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const itemId = useMemo(() => newItemId(), []);
  const { prefs } = useStore();
  const [lookupNow, setLookupNow] = useState<boolean | null>(null);
  const lookupNames = prep && prefs.lookup !== "off" ? sendable(prep.plan.candidates) : [];
  const willSend = (lookupNow ?? prefs.lookup === "auto") ? lookupNames : [];

  useEffect(() => {
    kv.get(BANK_KEY).then((saved) => {
      if (saved) {
        setBankId(saved);
        setStep("file");
      }
    }).catch(() => {});
  }, []);

  const chooseBank = (id: string) => {
    setBankId(id);
    kv.set(BANK_KEY, id).catch(() => {});
    setStep("file");
  };

  const finishParse = (res: ParseResult) => {
    if (res.transactions.length === 0) {
      setError("empty");
      setStep("error");
      return;
    }
    setPrep(prepareStatement(res, itemId));
    setStep("check");
  };

  const choose = async () => {
    setError(null);
    const picked = await pickStatement();
    if (!picked) return;
    const pdf = isPdf(picked);
    setStep("reading");
    try {
      const bytes = await picked.bytes();
      setFile({ name: picked.name, bytes });
      const res = pdf ? await readStatementPdf(bytes) : await readStatementBytes(bytes, picked.name);
      if (pdf && res.transactions.length === 0) {
        setError("pdf");
        setStep("error");
        return;
      }
      setParse(res);
      if (res.needsMapping) {
        setMapping(guessMapping(res.headers, res.previewRows));
        setStep("mapping");
      } else finishParse(res);
    } catch (e) {
      setError((e as Error).message || "Unknown error");
      setStep("error");
    }
  };

  const applyMapping = async () => {
    if (!file || mapping.date === undefined || mapping.description === undefined) return;
    setStep("reading");
    const res = await readStatementBytes(file.bytes, file.name, mapping as ColumnMapping);
    setParse(res);
    finishParse(res);
  };

  const confirm = async () => {
    if (!prep) return;
    setStep("saving");
    await saveStatement(prep, itemId, disclosureFor(prep.plan, []), file?.name);
    if (willSend.length) {
      // Saved first, so nothing is lost if the lookup service is slow or unreachable.
      setStep("looking");
      const r = await lookUp(willSend, itemId);
      await recordSent(itemId, r.sent);
    }
    router.replace({ pathname: "/item/[id]", params: { id: itemId, new: "1" } });
  };

  const bank = BANK_GUIDES.find((b) => b.id === bankId);

  return (
    <Page testID="add-statement">
      <BackLink onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} />
      <H1>Add a bank statement</H1>

      {step === "bank" && (
        <View style={{ gap: 12 }}>
          <P muted>Which bank is it from? We'll show you how to download it.</P>
          <Card style={{ overflow: "hidden" }}>
            {BANK_GUIDES.map((g, i) => (
              <View key={g.id}>
                {i > 0 && <Divider />}
                <Row onPress={() => chooseBank(g.id)} testID={`bank-${g.id}`}>
                  <P bold style={{ flex: 1 }}>{g.name}</P>
                  <View style={{ borderRadius: 6, backgroundColor: t.sunk, paddingHorizontal: 6, paddingVertical: 2 }}>
                    <Text style={{ fontFamily: "monospace", fontSize: 11, color: t.ink2 }}>{g.format}</Text>
                  </View>
                  <Text style={{ color: t.ink3 }}>›</Text>
                </Row>
              </View>
            ))}
            <Divider />
            <Row onPress={() => chooseBank("other")} testID="bank-other">
              <P muted>My bank isn't listed — I have a CSV file</P>
            </Row>
          </Card>
        </View>
      )}

      {step === "file" && (
        <View style={{ gap: 16 }}>
          {bank && (
            <Card style={{ padding: 16, gap: 6 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <P bold style={{ flex: 1, fontSize: 18 }}>{bank.heading ?? `Getting your ${bank.name} statement`}</P>
                <LinkText onPress={() => setStep("bank")}>Change bank</LinkText>
              </View>
              <P small muted={3}>{bank.format} · {bank.history}</P>
              <LinkText onPress={() => setShowSteps((s) => !s)}>{showSteps ? "Hide the steps" : "Show me how"}</LinkText>
              {showSteps && (
                <View style={{ gap: 6, marginTop: 6 }}>
                  {bank.steps.map((s, i) => (
                    <P key={s} small muted>{i + 1}. {s}</P>
                  ))}
                </View>
              )}
            </Card>
          )}
          {!bank && bankId === "other" && (
            <View style={{ flexDirection: "row" }}>
              <LinkText onPress={() => setStep("bank")}>Choose a bank instead</LinkText>
            </View>
          )}
          <Card dashed style={{ padding: 24, alignItems: "center", gap: 12, borderWidth: 2 }}>
            <Text style={{ fontSize: 40 }}>📄</Text>
            <P bold>Choose your statement file</P>
            <P small muted={3}>{PDF_AVAILABLE ? "CSV, TXT, OFX, QIF or PDF" : "CSV, TXT, OFX or QIF"}</P>
            <Button title="Choose file" onPress={choose} testID="choose-file" />
          </Card>
          <P small muted={3} style={{ textAlign: "center" }}>Your file is opened on this phone. There's no upload.</P>
        </View>
      )}

      {step === "reading" && (
        <Card>
          <Spinner label="Reading your statement on this phone…" />
        </Card>
      )}

      {step === "mapping" && parse && (
        <View style={{ gap: 16 }}>
          <P muted>We don't recognise this layout yet. Tell us which columns are which.</P>
          <ScrollView horizontal style={{ borderRadius: 16, borderWidth: 1, borderColor: t.rule, backgroundColor: t.surface }}>
            <View style={{ padding: 8 }}>
              {[parse.headers, ...parse.previewRows.slice(0, 5)].map((r, i) => (
                <View key={i} style={{ flexDirection: "row", borderTopWidth: i ? 1 : 0, borderColor: t.rule }}>
                  {r.map((c, j) => (
                    <Text key={j} numberOfLines={1} style={{ width: 120, padding: 4, fontFamily: "monospace", fontSize: 11, color: i ? t.ink2 : t.ink, fontWeight: i ? "400" : "700" }}>
                      {c || (i === 0 ? `Column ${j + 1}` : "")}
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
          {FIELDS.map(({ k, label }) => (
            <View key={k} style={{ gap: 6 }}>
              <P bold small>{label}</P>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                <Chip label="—" active={mapping[k] === undefined} onPress={() => setMapping((m) => ({ ...m, [k]: undefined }))} />
                {parse.headers.map((h, i) => (
                  <Chip key={i} label={h || `Column ${i + 1}`} active={mapping[k] === i} onPress={() => setMapping((m) => ({ ...m, [k]: i }))} />
                ))}
              </View>
            </View>
          ))}
          {mapping.amount !== undefined && mapping.paidOut === undefined && (
            <View style={{ gap: 6 }}>
              <P bold small>How does spending show?</P>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                <Chip label="As minus: −12.50" active={!mapping.invertSign} onPress={() => setMapping((m) => ({ ...m, invertSign: false }))} testID="sign-normal" />
                <Chip label="As plus: 12.50 (credit cards)" active={!!mapping.invertSign} onPress={() => setMapping((m) => ({ ...m, invertSign: true }))} testID="sign-invert" />
              </View>
            </View>
          )}
          <Button title="Read it" onPress={applyMapping} disabled={mapping.date === undefined || mapping.description === undefined || (mapping.amount === undefined && mapping.paidOut === undefined)} />
        </View>
      )}

      {step === "check" && prep && (
        <View style={{ gap: 16 }} testID="statement-check">
          <Card style={{ padding: 16, gap: 4 }}>
            <Eyebrow>Read on this phone</Eyebrow>
            <P bold style={{ fontSize: 18 }}>
              {prep.parse.bank?.name ?? "Your bank"} · {monthRange(prep.parse.dateRange?.from, prep.parse.dateRange?.to)}
            </P>
            <P small muted>
              {prep.plan.rowsRead} transactions · {prep.plan.recognisedLocally} shops recognised
              {prep.plan.candidates.length > 0 && ` · ${prep.plan.candidates.length} not recognised yet`}
            </P>
            {prep.parse.bank?.confidence === "unconfirmed" && <P small muted>We haven't seen many files from this bank yet — check the report looks right.</P>}
          </Card>
          {lookupNames.length > 0 && (
            <Row onPress={() => setLookupNow(!(willSend.length > 0))} testID="lookup-toggle">
              <Text style={{ fontSize: 18, color: t.ink }}>{willSend.length ? "☑" : "☐"}</Text>
              <View style={{ flex: 1 }}>
                <P bold>Look up {lookupNames.length} shop{lookupNames.length === 1 ? "" : "s"} we don't know</P>
                <P small muted>Sends only the shop names to find their owners. Untick to keep them on this phone; they'll be counted by where you paid.</P>
              </View>
            </Row>
          )}
          <DataLeavesPanel kind="statement" plan={prep.plan} willSend={willSend} />
          <Button title="Analyse my spending" onPress={confirm} testID="confirm-statement" />
        </View>
      )}

      {(step === "saving" || step === "looking") && (
        <Card>
          <Spinner label={step === "looking" ? `Looking up ${willSend.length} shop${willSend.length === 1 ? "" : "s"}…` : "Working out who owns what…"} />
        </Card>
      )}

      {step === "error" && (
        <Card style={{ padding: 20, gap: 12 }} >
          {error === "pdf-password" ? (
            <>
              <P bold style={{ fontSize: 18 }}>This PDF is password-protected</P>
              <P muted>Download the statement again without a password (most banks offer this), or use your bank's CSV export.</P>
            </>
          ) : error === "pdf-unreadable" ? (
            <>
              <P bold style={{ fontSize: 18 }}>We couldn't open this PDF</P>
              <P muted>The file may be damaged or not really a PDF. Try downloading it again, or use your bank's CSV export.</P>
            </>
          ) : error === "pdf" ? (
            <>
              <P bold style={{ fontSize: 18 }}>We couldn't find transactions in this PDF</P>
              <P muted>It may be a scanned copy (a picture with no text in it) or a layout we don't know yet. Your bank's CSV export always works.</P>
            </>
          ) : error === "empty" ? (
            <>
              <P bold style={{ fontSize: 18 }}>We couldn't find any transactions</P>
              <P muted>Is this the right file? It should be a statement export with one row per payment.</P>
            </>
          ) : (
            <>
              <P bold style={{ fontSize: 18 }}>We couldn't read that file</P>
              <P muted>{error}</P>
            </>
          )}
          <Button title="Try another file" variant="secondary" onPress={() => setStep("file")} />
        </Card>
      )}
    </Page>
  );
}
