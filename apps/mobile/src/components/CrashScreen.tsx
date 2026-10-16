import { View } from "react-native";
import { useTheme } from "@/lib/theme";
import { reportProblem } from "@/lib/links";
import { Button, H1, LinkText, P } from "./ui";

export function CrashScreen({ error, retry }: { error: Error; retry: () => Promise<void> | void }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: t.paper, alignItems: "center", justifyContent: "center", padding: 24 }} testID="crash-screen">
      <View style={{ maxWidth: 420, gap: 14 }}>
        <H1>Something went wrong</H1>
        <P muted>Sorry — that screen hit a problem. Your statements and receipts are still safe on this device.</P>
        <P small muted={3}>{error.message}</P>
        <Button title="Try again" onPress={() => retry()} />
        <LinkText onPress={() => reportProblem(error.message)} testID="crash-report">Tell us what happened</LinkText>
      </View>
    </View>
  );
}
