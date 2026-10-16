import { useEffect } from "react";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { store, useStore } from "@/lib/store";
import { useTheme } from "@/lib/theme";
import { CrashScreen } from "@/components/CrashScreen";
import { PdfEngineHost } from "@/components/PdfEngineHost";
import { registerServiceWorker } from "@/lib/sw";
import { initInstall } from "@/lib/install";
import { startBrandData } from "@/lib/brand-data";
import { initAccount } from "@/lib/account";

SplashScreen.preventAutoHideAsync();

/** Shown instead of a blank screen if something breaks. Nothing is lost: data stays on the device. */
export function ErrorBoundary({ error, retry }: { error: Error; retry: () => Promise<void> }) {
  return <CrashScreen error={error} retry={retry} />;
}

export default function RootLayout() {
  const t = useTheme();
  const { loaded } = useStore();
  useEffect(() => {
    store.load();
    registerServiceWorker();
    initInstall();
    startBrandData();
    void initAccount();
  }, []);
  useEffect(() => {
    if (loaded) SplashScreen.hideAsync();
  }, [loaded]);
  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.paper } }}>
        <Stack.Screen name="index" options={{ title: "KnowYourSpend" }} />
        <Stack.Screen name="add" options={{ presentation: "transparentModal", animation: "fade", title: "Add" }} />
        <Stack.Screen name="add-statement" options={{ title: "Add a bank statement" }} />
        <Stack.Screen name="add-receipt" options={{ title: "Add a receipt" }} />
        <Stack.Screen name="item/[id]" options={{ title: "Report" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
        <Stack.Screen name="account" options={{ title: "Your account" }} />
        <Stack.Screen name="privacy" options={{ title: "What we can see" }} />
        <Stack.Screen name="method" options={{ title: "How we work out who owns what" }} />
      </Stack>
      <PdfEngineHost />
    </SafeAreaProvider>
  );
}
