import { getRandomValues } from "expo-crypto";

export function newId(prefix = ""): string {
  const a = new Uint8Array(10);
  getRandomValues(a);
  return prefix + Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}
