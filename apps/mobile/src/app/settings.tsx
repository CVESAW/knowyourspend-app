import { useState } from "react";
import { TextInput, View } from "react-native";
import Constants from "expo-constants";
import { router } from "expo-router";
import { restoreBackup, saveBackup } from "@/lib/backup";
import { useTheme } from "@/lib/theme";
import { seedDemo } from "@/lib/demo";
import { store, useStore } from "@/lib/store";
import { BackLink, Button, Card, Checkbox, Chip, Divider, H1, H2, LinkText, P, Page, Row } from "@/components/ui";
import { CountryPicker } from "@/components/CountryPicker";
import { countryName, flag } from "@/lib/countries";
import type { LookupMode, Prefs } from "@/lib/prefs";
import { CONTACT_EMAIL, PRIVACY_URL, SUPPORT_URL, TERMS_URL, openUrl, reportProblem } from "@/lib/links";
import { deleteAccount, signOut, useAccount, type AccountState } from "@/lib/account";
import { ONLINE_EXTRAS } from "@/lib/features";
import { clearPickerCache } from "@/lib/files";

const LOOKUP_CHOICES: { id: LookupMode; label: string; text: string }[] = [
  { id: "auto", label: "Automatically", text: "When you add a statement, shop names we don't know are looked up online. You see the list first and can stop it being sent. Names that look like a person or a sensitive shop are held back." },
  { id: "ask", label: "Ask me", text: "Nothing is sent until you tap “Look them up” on a report." },
  { id: "off", label: "Never", text: "Nothing is sent. Shops we don't know are counted by where you paid, or you can set them yourself." },
];

export default function Settings() {
  const s = useStore();
  const t = useTheme();
  const acct = useAccount();
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pickHome, setPickHome] = useState(false);
  const setPrefs = (p: Partial<Prefs>) => store.update((d) => ({ prefs: { ...d.prefs, ...p } }));
  const fixes = Object.keys(s.prefs.overrides).length;
  const found = Object.keys(s.prefs.lookups).length;
  const run = async (fn: () => Promise<string | null>) => {
    setMsg(null);
    setBusy(true);
    try {
      const m = await fn();
      if (m) setMsg(m);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const back = () => (router.canGoBack() ? router.back() : router.replace("/"));
  return (
    <Page testID="settings">
      <BackLink onPress={back} />
      <H1>Settings</H1>

      {ONLINE_EXTRAS && s.mode === "real" && <AccountSection acct={acct} />}

      <View>
        <H2>Your data</H2>
        <Card style={{ padding: 16, gap: 10 }}>
          <P muted>
            {acct.syncing
              ? "Everything you add is kept on this device, with an encrypted copy in your account. The button below deletes what's on this device and signs you out; your account copy stays until you delete your account."
              : "Everything you add is kept only on this device. Deleting the app, or the button below, removes it for good."}
          </P>
          <P small muted={3}>
            {s.items.length} items · {s.txns.length} transactions{s.mode === "demo" ? " (demo data)" : ""}
          </P>
          {confirmWipe ? (
            <Button
              title="Yes, delete everything on this device"
              variant="danger"
              testID="confirm-wipe"
              onPress={async () => {
                if (acct.email) await signOut();
                await store.wipe();
                await clearPickerCache();
                setConfirmWipe(false);
                router.replace("/");
              }}
            />
          ) : (
            <Button title="Delete all my data" variant="secondary" onPress={() => setConfirmWipe(true)} testID="wipe" />
          )}
        </Card>
      </View>

      <View>
        <H2>Shops we don't know</H2>
        <Card style={{ padding: 16, gap: 12 }} >
          <View style={{ gap: 6 }}>
            <P bold>Look up their owners online</P>
            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
              {LOOKUP_CHOICES.map((c) => (
                <Chip key={c.id} label={c.label} active={s.prefs.lookup === c.id} onPress={() => setPrefs({ lookup: c.id })} testID={`lookup-${c.id}`} />
              ))}
            </View>
            <P small muted>{LOOKUP_CHOICES.find((c) => c.id === s.prefs.lookup)?.text}</P>
          </View>
          <Divider />
          <Row onPress={() => setPrefs({ estimate: !s.prefs.estimate })} testID="estimate-toggle">
            <P style={{ fontSize: 18 }}>{s.prefs.estimate ? "☑" : "☐"}</P>
            <View style={{ flex: 1 }}>
              <P bold>Estimate them from where you paid</P>
              <P small muted>Counts an unknown shop under the country the payment was made in (marked “Estimated”). Off: they're left out of the percentages.</P>
            </View>
          </Row>
          <Row onPress={() => setPickHome(true)} testID="home-country">
            <P style={{ fontSize: 18 }}>{flag(s.prefs.home)}</P>
            <View style={{ flex: 1 }}>
              <P bold>Home country: {countryName(s.prefs.home)}</P>
              <P small muted>Card payments with nothing foreign on the statement are taken as made here.</P>
            </View>
            <P muted={3}>›</P>
          </Row>
          <P small muted={3}>
            {fixes} shop{fixes === 1 ? "" : "s"} you've set yourself · {found} owner{found === 1 ? "" : "s"} found online
          </P>
          {fixes > 0 && <LinkText onPress={() => setPrefs({ overrides: {} })} testID="clear-fixes">Forget the countries I set</LinkText>}
        </Card>
        {ONLINE_EXTRAS && <Card style={{ padding: 16, gap: 8, marginTop: 12 }}>
          <Checkbox checked={!!s.prefs.shareCounts} onChange={(v) => setPrefs({ shareCounts: v })} testID="share-counts">
            <P bold>Send anonymous counts</P>
            <P small muted>Adds one to a daily tally when you add a statement or receipt, so we can see whether the app is used. No ID, no device details and nothing about what you added.</P>
          </Checkbox>
        </Card>}
        <CountryPicker open={pickHome} name="your home country" current={s.prefs.home} onPick={(iso) => (setPrefs({ home: iso }), setPickHome(false))} onClose={() => setPickHome(false)} />
      </View>

      {s.mode === "real" && (
        <View>
          <H2>Back up or move your data</H2>
          <Card style={{ padding: 16, gap: 10 }} >
            <P muted>Your history lives on this device. If you clear it or change phone, it's gone — so save an encrypted backup now and then. Backups open in the web version and the app.</P>
            <TextInput
              value={pass}
              onChangeText={setPass}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Choose a passphrase (8+ characters)"
              placeholderTextColor={t.ink3}
              accessibilityLabel="Backup passphrase"
              testID="backup-pass"
              style={{ minHeight: 46, borderRadius: 12, borderWidth: 1, borderColor: t.rule, backgroundColor: t.surface, paddingHorizontal: 12, color: t.ink, fontSize: 16 }}
            />
            <Button
              title={busy ? "Working…" : "Save encrypted backup"}
              variant="secondary"
              disabled={busy}
              testID="backup-save"
              onPress={() => run(async () => (await saveBackup(pass), "Backup saved. Keep the passphrase safe — without it the backup can't be opened, by you or by us."))}
            />
            <Button
              title="Restore a backup"
              variant="ghost"
              disabled={busy}
              testID="backup-restore"
              onPress={() => run(async () => {
                const r = await restoreBackup(pass);
                return r ? `Restored ${r.items} item${r.items === 1 ? "" : "s"}.` : null;
              })}
            />
            {msg && <P small testID="backup-msg">{msg}</P>}
          </Card>
        </View>
      )}

      <View>
        <H2>Demo</H2>
        <Card style={{ padding: 16, gap: 10 }}>
          <P muted>See how the app works with made-up data. It's kept separately and never mixed with yours.</P>
          {s.mode === "demo" ? (
            <Button title="Exit the demo" variant="secondary" onPress={() => store.load("real").then(back)} />
          ) : (
            <Button title="Open the demo" variant="secondary" onPress={() => seedDemo().then(() => router.replace("/"))} testID="settings-demo" />
          )}
        </Card>
      </View>

      <Card style={{ overflow: "hidden" }}>
        <Row onPress={() => router.push("/privacy")} testID="open-privacy">
          <P style={{ flex: 1 }}>What we can see</P>
          <P muted={3}>›</P>
        </Row>
        <Divider />
        <Row onPress={() => router.push("/method")} testID="open-method">
          <P style={{ flex: 1 }}>How we work out who owns what</P>
          <P muted={3}>›</P>
        </Row>
        <Divider />
        <Row onPress={() => openUrl(PRIVACY_URL)} testID="open-privacy-notice">
          <P style={{ flex: 1 }}>Privacy notice</P>
          <P muted={3}>↗</P>
        </Row>
        <Divider />
        <Row onPress={() => openUrl(TERMS_URL)} testID="open-terms">
          <P style={{ flex: 1 }}>Terms of use</P>
          <P muted={3}>↗</P>
        </Row>
        <Divider />
        <Row onPress={() => openUrl(SUPPORT_URL)} testID="open-support">
          <P style={{ flex: 1 }}>Help, or contact us ({CONTACT_EMAIL})</P>
          <P muted={3}>↗</P>
        </Row>
        <Divider />
        <Row onPress={() => reportProblem()} testID="report-problem">
          <P style={{ flex: 1 }}>Report a problem</P>
          <P muted={3}>✉︎</P>
        </Row>
      </Card>

      <View>
        <H2>How this works</H2>
        <Card style={{ padding: 16, gap: 8 }}>
          <P muted>Statements and receipts are read on this device. The app carries its own list of who owns over 6,000 shops and brands, so matching happens here too.</P>
          <P muted>Only the names of shops we don't know can leave your phone, and only if online lookups are on (above). Amounts, dates and account details never do{ONLINE_EXTRAS ? " — except inside your account copy, if you make one, which is encrypted on this device so we can't read it" : ""}.</P>
          <P small muted={3}>Ownership badges: Checked = a person verified it; Matched = company registries agree; Unverified = a best guess, not yet checked.</P>
        </Card>
      </View>
      <P small muted={3} style={{ textAlign: "center" }}>
        KnowYourSpend {Constants.expoConfig?.version ?? ""} · Estimates from published ownership data; may contain errors.
      </P>
    </Page>
  );
}

/** Optional account: an encrypted copy of this device's data, to open on another device. */
function AccountSection({ acct }: { acct: AccountState }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!acct.ready) return null;
  const when = acct.savedAt ? new Date(acct.savedAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : null;
  const status =
    acct.status === "saving" ? "Saving…" : acct.status === "offline" ? "Offline — it'll save when you're back online." : acct.status === "error" ? acct.error ?? "Couldn't save. We'll try again." : when ? `Last saved ${when}` : "Saved";
  return (
    <View>
      <H2>Your account</H2>
      <Card style={{ padding: 16, gap: 10 }}>
        {!acct.email ? (
          <>
            <P muted>Optional. Sign in with just your email to keep an encrypted copy of your data and open it on another phone or computer.</P>
            <Button title="Save my data to an account" variant="secondary" onPress={() => router.push("/account")} testID="open-account" />
          </>
        ) : !acct.syncing ? (
          <>
            <P>Signed in as <P bold>{acct.email}</P>, but your saved copy isn't open on this device yet.</P>
            <Button title="Enter my passphrase" variant="secondary" onPress={() => router.push("/account")} testID="open-account" />
            <LinkText onPress={() => signOut()} testID="sign-out">Sign out</LinkText>
          </>
        ) : (
          <>
            <P>Signed in as <P bold>{acct.email}</P>. Changes save automatically, encrypted with your passphrase.</P>
            <P small muted={3} testID="account-status">{status}</P>
            <View style={{ flexDirection: "row", gap: 16, flexWrap: "wrap" }}>
              <LinkText onPress={() => signOut()} testID="sign-out">Sign out on this device</LinkText>
              {!confirm && <LinkText onPress={() => setConfirm(true)} testID="delete-account">Delete my account</LinkText>}
            </View>
          </>
        )}
        {acct.email && confirm && (
          <>
            <P small>This deletes your account and its saved copy for good. The data on this device stays.</P>
            <Button
              title={busy ? "Deleting…" : "Yes, delete my account"}
              variant="danger"
              disabled={busy}
              testID="confirm-delete-account"
              onPress={async () => {
                setErr(null);
                setBusy(true);
                try {
                  await deleteAccount();
                  setConfirm(false);
                } catch (e) {
                  setErr((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            />
            <LinkText onPress={() => setConfirm(false)}>Cancel</LinkText>
          </>
        )}
        {err && <P small style={{ color: "#a33" }}>{err}</P>}
      </Card>
    </View>
  );
}
