import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";

/** A file the user picked. Its contents are read here, on the device, and never uploaded. */
export interface Picked {
  name: string;
  uri: string;
  mimeType?: string;
  /** web only: the browser File */
  file?: Blob;
}

async function readBytes(p: Picked): Promise<ArrayBuffer> {
  if (p.file) return p.file.arrayBuffer();
  if (Platform.OS === "web") return (await fetch(p.uri)).arrayBuffer();
  const { File } = await import("expo-file-system");
  const bytes = await new File(p.uri).bytes();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Phones: delete the app's own temporary copy of a picked file once it has been read, so statements and
 * receipt photos don't linger in the app's cache. Only files inside the app's cache folder are touched —
 * never the user's original. Web: nothing to do (the browser holds the File in memory only).
 */
export async function discard(p: Picked): Promise<void> {
  if (Platform.OS === "web" || p.file) return;
  try {
    const { File, Paths } = await import("expo-file-system");
    if (!p.uri.startsWith(Paths.cache.uri)) return;
    const f = new File(p.uri);
    if (f.exists) f.delete();
  } catch {
    // best effort: a file we can't delete is cleared by "Delete all my data" or by the system
  }
}

/** Phones: clear the folders the file and photo pickers copy into (used by "Delete all my data"). */
export async function clearPickerCache(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const { Directory, Paths } = await import("expo-file-system");
    for (const name of ["DocumentPicker", "ImagePicker", "ImageManipulator"]) {
      const d = new Directory(Paths.cache, name);
      if (d.exists) d.delete();
    }
  } catch {
    // best effort
  }
}

export function isPdf(p: Picked): boolean {
  return /\.pdf$/i.test(p.name) || p.mimeType === "application/pdf";
}

export async function pickStatement(): Promise<(Picked & { bytes: () => Promise<ArrayBuffer> }) | null> {
  const r = await DocumentPicker.getDocumentAsync({
    // Phones label CSVs inconsistently (text/csv, text/comma-separated-values, application/vnd.ms-excel…), so accept anything there.
    type: Platform.OS === "web" ? ["text/csv", ".csv", "text/plain", ".txt", "application/vnd.ms-excel", "application/pdf"] : "*/*",
    copyToCacheDirectory: true,
    base64: false,
  });
  if (r.canceled || !r.assets?.[0]) return null;
  const a = r.assets[0];
  const picked: Picked = { name: a.name, uri: a.uri, mimeType: a.mimeType, file: a.file };
  let cached: Promise<ArrayBuffer> | null = null;
  // Read once, keep the bytes in memory for this screen, and delete the app's temporary copy at once.
  return { ...picked, bytes: () => (cached ??= readBytes(picked).finally(() => discard(picked))) };
}

export async function pickReceiptPhoto(source: "camera" | "library"): Promise<Picked | null> {
  if (source === "camera" && Platform.OS !== "web") {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return null;
  }
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 1, exif: false };
  const r = source === "camera" ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  if (r.canceled || !r.assets?.[0]) return null;
  const a = r.assets[0];
  return { name: a.fileName ?? "receipt.jpg", uri: a.uri, mimeType: a.mimeType, file: a.file ?? undefined };
}
