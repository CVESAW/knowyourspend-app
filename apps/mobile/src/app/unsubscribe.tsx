import { useState } from "react";
import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { SUPABASE_URL } from "@/lib/account";
import { CONTACT_EMAIL } from "@/lib/links";
import { Button, Card, H1, LinkText, Notice, P, Page } from "@/components/ui";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type State = "idle" | "busy" | "done" | "failed" | "offline";

/**
 * Opened from the unsubscribe link in our update emails (/unsubscribe?token=…). Nothing is sent until the
 * person taps the button: mail scanners open links on their own, and that mustn't unsubscribe anyone.
 * The only request is the token, to our kys-unsubscribe function.
 */
export default function Unsubscribe() {
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const raw = Array.isArray(params.token) ? params.token[0] : params.token;
  const token = raw?.trim() ?? "";
  const valid = UUID.test(token);
  const [state, setState] = useState<State>("idle");

  const unsubscribe = async () => {
    setState("busy");
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/kys-unsubscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      setState(res.ok ? "done" : "failed");
    } catch {
      const offline = typeof navigator !== "undefined" && "onLine" in navigator && !navigator.onLine;
      setState(offline ? "offline" : "failed");
    }
  };

  return (
    <Page testID="unsubscribe">
      <H1>Unsubscribe from updates</H1>
      <Card style={{ padding: 16, gap: 12 }}>
        {state === "done" ? (
          <View testID="unsubscribe-done">
            <Notice>You're unsubscribed. We've deleted your email address from our list.</Notice>
          </View>
        ) : !valid ? (
          <P testID="unsubscribe-invalid">
            This unsubscribe link isn't complete. Try the link in your latest email from us again, or email {CONTACT_EMAIL} and we'll take you off the list.
          </P>
        ) : (
          <>
            <P muted>Tap below and we'll stop sending you occasional updates from KnowYourSpend, and delete your email address from our list.</P>
            <Button title={state === "busy" ? "Unsubscribing…" : "Unsubscribe"} disabled={state === "busy"} onPress={unsubscribe} testID="unsubscribe-button" />
            {state === "failed" && (
              <P small style={{ color: "#a33" }} testID="unsubscribe-error">
                Sorry, that didn't work, and you're still on the list. Please try again in a minute, or email {CONTACT_EMAIL} and we'll do it for you.
              </P>
            )}
            {state === "offline" && (
              <P small style={{ color: "#a33" }} testID="unsubscribe-offline">
                You seem to be offline. Connect to the internet and tap Unsubscribe again.
              </P>
            )}
          </>
        )}
      </Card>
      <LinkText onPress={() => router.replace("/")} testID="unsubscribe-home">Go to KnowYourSpend</LinkText>
    </Page>
  );
}
