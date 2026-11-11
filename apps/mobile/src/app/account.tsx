import { useEffect, useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { createPassphrase, hasSavedCopy, requestCode, resetCopy, unlockCopy, useAccount, verifyCode } from "@/lib/account";
import { track } from "@/lib/usage";
import { BackLink, Button, Card, Checkbox, Field, H1, LinkText, Notice, P, Page, Spinner } from "@/components/ui";

type Step = "checking" | "email" | "code" | "create" | "unlock" | "reset" | "done";

/**
 * Optional account: sign in with a code sent by email (no password), then either choose a passphrase
 * (first time) or enter it (to open the copy saved from another device). The passphrase encrypts the
 * copy on this device; we never receive it.
 */
export default function Account() {
  const acct = useAccount();
  const [step, setStep] = useState<Step>(acct.syncing ? "done" : acct.email ? "checking" : "email");
  const [email, setEmail] = useState(acct.email ?? "");
  const [code, setCode] = useState("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message || "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  // Signed in on this device but the copy isn't open yet: ask for the right passphrase.
  useEffect(() => {
    if (step !== "checking") return;
    hasSavedCopy()
      .then((has) => setStep(has ? "unlock" : "create"))
      .catch((e) => (setErr((e as Error).message), setStep("email")));
  }, [step]);
  const back = () => (router.canGoBack() ? router.back() : router.replace("/settings"));
  const passOk = pass.length >= 10 && pass === pass2 && understood;

  return (
    <Page testID="account">
      <BackLink onPress={back} />
      <H1>{step === "done" ? "Your data is saved to your account" : "Save your data to an account"}</H1>

      {step === "checking" && <Spinner label="Checking your account…" />}

      {step === "email" && (
        <>
          <P muted>Optional. KnowYourSpend works fully without an account. With one, an encrypted copy of your data is kept on our server so you can open it on another phone or computer.</P>
          <Card style={{ padding: 16, gap: 12 }}>
            <Field label="Your email" value={email} onChange={setEmail} placeholder="you@example.com" keyboard="email-address" autoComplete="email" testID="account-email" />
            <Button title={busy ? "Sending…" : "Email me a sign-in code"} disabled={busy || !email} onPress={() => run(async () => { await requestCode(email); setStep("code"); })} testID="account-send-code" />
            <P small muted={3}>No password. We'll email you a 6-digit code. Your email is used to sign you in, and for nothing else unless you ask.</P>
          </Card>
        </>
      )}

      {step === "code" && (
        <Card style={{ padding: 16, gap: 12 }}>
          <P>We've sent a 6-digit code to <P bold>{email.trim()}</P>. It can take a minute; check your spam folder too.</P>
          <Field label="Code" value={code} onChange={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))} placeholder="123456" keyboard="number-pad" autoComplete="one-time-code" testID="account-code" maxLength={6} />
          <Button
            title={busy ? "Checking…" : "Sign in"}
            disabled={busy || code.length !== 6}
            onPress={() => run(async () => { const { hasCopy } = await verifyCode(email, code); setStep(hasCopy ? "unlock" : "create"); })}
            testID="account-verify"
          />
          <View style={{ flexDirection: "row", gap: 16 }}>
            <LinkText onPress={() => run(async () => { await requestCode(email); setNote("We've sent a new code."); })}>Send a new code</LinkText>
            <LinkText onPress={() => (setStep("email"), setCode(""))}>Use a different email</LinkText>
          </View>
        </Card>
      )}

      {(step === "create" || step === "reset") && (
        <Card style={{ padding: 16, gap: 12 }}>
          <P bold>{step === "reset" ? "Choose a new passphrase" : "Choose a passphrase for your saved copy"}</P>
          <P small muted>Your data is encrypted on this device with this passphrase before it's saved. We never see it, so we can't read your data — and we can't reset the passphrase for you.</P>
          <Field label="Passphrase (10 or more characters)" value={pass} onChange={setPass} secure autoComplete="new-password" testID="account-pass" />
          <Field label="Type it again" value={pass2} onChange={setPass2} secure autoComplete="new-password" testID="account-pass2" />
          {pass2.length > 0 && pass !== pass2 && <P small style={{ color: "#a33" }}>The two don't match.</P>}
          <Checkbox checked={understood} onChange={setUnderstood} testID="account-understood">
            <P small>I understand that if I forget this passphrase, my saved copy can't be opened by anyone, including KnowYourSpend.</P>
          </Checkbox>
          <Button
            title={busy ? "Encrypting and saving…" : "Save my data to my account"}
            disabled={busy || !passOk}
            onPress={() => run(async () => {
              if (step === "reset") await resetCopy(pass);
              else await createPassphrase(pass);
              track("account_created");
              setStep("done");
            })}
            testID="account-create"
          />
        </Card>
      )}

      {step === "unlock" && (
        <Card style={{ padding: 16, gap: 12 }}>
          <P>You've saved data to this account before. Enter its passphrase to open it on this device. Anything already here is kept and added to it.</P>
          <Field label="Passphrase" value={pass} onChange={setPass} secure autoComplete="current-password" testID="account-unlock-pass" />
          <Button title={busy ? "Opening…" : "Open my saved data"} disabled={busy || pass.length < 10} onPress={() => run(async () => { await unlockCopy(pass); setStep("done"); })} testID="account-unlock" />
          <LinkText onPress={() => (setPass(""), setPass2(""), setUnderstood(false), setStep("reset"))}>I've forgotten it — start a new saved copy</LinkText>
          <P small muted={3}>Starting again deletes the old saved copy. The data on this device stays.</P>
        </Card>
      )}

      {step === "done" && (
        <Card style={{ padding: 16, gap: 10 }}>
          <P>Signed in as <P bold>{acct.email}</P>. Changes on this device are now saved to your account automatically, encrypted with your passphrase.</P>
          <P small muted>To open your data somewhere else, go to Settings there, sign in with this email and enter the same passphrase.</P>
          <Button title="Done" onPress={back} testID="account-done" />
        </Card>
      )}

      {note && <Notice>{note}</Notice>}
      {err && <P small style={{ color: "#a33" }} testID="account-error">{err}</P>}
    </Page>
  );
}
