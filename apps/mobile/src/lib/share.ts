import type { RefObject } from "react";
import type { View } from "react-native";
import * as Sharing from "expo-sharing";
import { captureRef } from "react-native-view-shot";

/** Phones: capture the rendered card as a PNG and open the system share sheet. Nothing is uploaded by us. */
export async function shareCard(_svg: string, view: RefObject<View | null>, _text: string): Promise<"shared" | "downloaded"> {
  if (!view.current) throw new Error("card not ready");
  const uri = await captureRef(view, { format: "png", quality: 1, width: 1080, height: 1350 });
  await Sharing.shareAsync(uri, { mimeType: "image/png", dialogTitle: "Share your KnowYourSpend card", UTI: "public.png" });
  return "shared";
}
