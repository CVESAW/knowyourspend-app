import type { RefObject } from "react";
import type { View } from "react-native";
import { SHARE_H, SHARE_W } from "@kys/core/share-card";

/** Web: draw the card SVG onto a canvas, then use the browser's share sheet or download the PNG. */
async function toPng(svg: string): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("image"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = SHARE_W;
    canvas.height = SHARE_H;
    canvas.getContext("2d")!.drawImage(img, 0, 0);
    return await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function shareCard(svg: string, _view: RefObject<View | null>, text: string): Promise<"shared" | "downloaded"> {
  const png = await toPng(svg);
  const file = new File([png], "knowyourspend.png", { type: "image/png" });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text, title: "KnowYourSpend" });
      return "shared";
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") return "shared";
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(png);
  a.download = "knowyourspend.png";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return "downloaded";
}
