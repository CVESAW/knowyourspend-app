import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { pdfBridge } from "@/lib/pdf";
import { buildPdfEngineHtml, PDF_ENGINE_BASE_URL } from "@/lib/pdf-engine";

const IDLE_UNMOUNT_MS = 60_000;

/**
 * Hosts the PDF reader page in an invisible WebView, only while a PDF is being read (and for a
 * minute after, so a second file is quick). The page cannot reach the network: its CSP allows no
 * hosts and every navigation is refused here. Mounted once in the root layout.
 */
export function PdfEngineHost() {
  const [wanted, setWanted] = useState(false);
  const [mounted, setMounted] = useState(false);
  const ref = useRef<WebView>(null);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Built lazily: the engine is ~1.8 MB of text and only needed when someone adds a PDF.
  const html = useMemo(() => {
    if (!mounted) return "";
    const { PDFJS_MAIN, PDFJS_WORKER } = require("@/lib/pdf-engine.generated") as typeof import("@/lib/pdf-engine.generated");
    return buildPdfEngineHtml(PDFJS_MAIN, PDFJS_WORKER);
  }, [mounted]);

  useEffect(() => {
    const h = {
      run: (id: string, b64: string) => {
        ref.current?.injectJavaScript(`window.__kysReadPdf(${JSON.stringify(id)}, ${JSON.stringify(b64)}); true;`);
      },
      setWanted,
    };
    pdfBridge.attach(h);
    return () => pdfBridge.detach(h);
  }, []);

  useEffect(() => {
    if (idle.current) clearTimeout(idle.current);
    if (wanted) setMounted(true);
    else if (mounted) idle.current = setTimeout(() => setMounted(false), IDLE_UNMOUNT_MS);
    return () => {
      if (idle.current) clearTimeout(idle.current);
    };
  }, [wanted, mounted]);

  useEffect(() => {
    if (!mounted) pdfBridge.setReady(false);
  }, [mounted]);

  if (!mounted) return null;
  return (
    <View pointerEvents="none" style={{ position: "absolute", width: 1, height: 1, left: -10, top: -10, opacity: 0 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <WebView
        ref={ref}
        source={{ html, baseUrl: PDF_ENGINE_BASE_URL }}
        originWhitelist={["https://kys-pdf.invalid", "about:blank"]}
        onShouldStartLoadWithRequest={(r) => r.url === PDF_ENGINE_BASE_URL || r.url.startsWith("about:") || r.url.startsWith("blob:")}
        onMessage={(e: WebViewMessageEvent) => pdfBridge.onMessage(e.nativeEvent.data)}
        onContentProcessDidTerminate={() => {
          pdfBridge.setReady(false);
          ref.current?.reload();
        }}
        onRenderProcessGone={() => {
          pdfBridge.setReady(false);
          setMounted(false);
        }}
        javaScriptEnabled
        domStorageEnabled={false}
        cacheEnabled={false}
        incognito
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
        geolocationEnabled={false}
        mediaPlaybackRequiresUserAction
        setSupportMultipleWindows={false}
        style={{ width: 1, height: 1, backgroundColor: "transparent" }}
      />
    </View>
  );
}
