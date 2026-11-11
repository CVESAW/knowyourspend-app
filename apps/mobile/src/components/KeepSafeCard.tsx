import { useEffect, useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { keepData, promptInstall, snooze, snoozed, useInstall } from "@/lib/install";
import { Button, Card, LinkText, P } from "./ui";
import { ONLINE_EXTRAS } from "@/lib/features";

/**
 * Web only, once someone has added something: their data lives in this browser alone, so suggest
 * adding the app to the home screen (browsers keep installed apps' data far more reliably) and
 * saving an encrypted backup. Hidden for 30 days by "Not now", and never shown in the installed app.
 */
export function KeepSafeCard({ hasData }: { hasData: boolean }) {
  const install = useInstall();
  const [hidden, setHidden] = useState(true);
  useEffect(() => setHidden(snoozed()), []);
  useEffect(() => {
    if (hasData) keepData();
  }, [hasData]);
  if (!hasData || !install.inBrowserTab || hidden) return null;
  return (
    <Card style={{ padding: 16 }}>
      <View style={{ gap: 8 }} testID="keep-safe-card">
      <P bold>Keep KnowYourSpend on your home screen</P>
      <P small muted>
        Your statements are stored only in this browser. Browsers can clear a website's data if it isn't used for a while, but they keep a home-screen app's data. {ONLINE_EXTRAS ? "An account or a backup gives you a copy you control, encrypted so only you can open it." : "A backup gives you a copy you control."}
      </P>
      {install.canPrompt ? (
        <Button title="Add to home screen" onPress={() => promptInstall()} testID="install-app" />
      ) : install.ios ? (
        <P small>In Safari, tap the Share button, then “Add to Home Screen”.</P>
      ) : (
        <P small>In your browser's menu, choose “Install app” or “Add to Home screen”.</P>
      )}
      <View style={{ flexDirection: "row", gap: 16, flexWrap: "wrap" }}>
        {ONLINE_EXTRAS && <LinkText onPress={() => router.push("/account")} testID="keep-safe-account">Save to an account</LinkText>}
        <LinkText onPress={() => router.push("/settings")} testID="keep-safe-backup">Save a backup</LinkText>
        <LinkText
          onPress={() => {
            snooze();
            setHidden(true);
          }}
          testID="keep-safe-dismiss"
        >
          Not now
        </LinkText>
      </View>
      </View>
    </Card>
  );
}
