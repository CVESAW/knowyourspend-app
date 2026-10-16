import { Platform, useColorScheme } from "react-native";

/** Design tokens from DESIGN-product.md §3 ("editorial atlas"), light and dark. */
const light = {
  paper: "#f6f1e7",
  surface: "#fbf8f2",
  sunk: "#efe8da",
  ink: "#1c1b19",
  ink2: "#4a463f",
  ink3: "#6e685d",
  rule: "#d9d1c0",
  focus: "#2d4e8a",
  oxblood: "#8c2f39",
  onOxblood: "#ffffff",
  teal: "#1f6f78",
  stamp: "#2d4e8a",
  brass: "#a8782a",
  country: { GB: "#4a463f", US: "#1f6f78", DE: "#a8782a", FR: "#2d4e8a", NL: "#8c2f39", SE: "#5e7d3a", JP: "#7a5c8e" } as Record<string, string>,
  extra: ["#3f8f98", "#c49a4a", "#5474ad", "#a9545e", "#7f9c5c", "#9a7eae"],
  other: "#cfc6b3",
};

const dark: typeof light = {
  paper: "#14130f",
  surface: "#1d1b17",
  sunk: "#100f0c",
  ink: "#ede7da",
  ink2: "#bdb5a6",
  ink3: "#8f887b",
  rule: "#34312a",
  focus: "#8fb0f0",
  oxblood: "#e07a83",
  onOxblood: "#14130f",
  teal: "#6fc3cb",
  stamp: "#8fb0f0",
  brass: "#e0b565",
  country: { GB: "#bdb5a6", US: "#6fc3cb", DE: "#e0b565", FR: "#8fb0f0", NL: "#e07a83", SE: "#a3c47f", JP: "#c3a6d6" },
  extra: ["#4fa9b2", "#c9a052", "#6f93d6", "#c7707a", "#8bad68", "#a98dbf"],
  other: "#4a463f",
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

/** Colour follows the country (never its rank), so the US is the same colour on every screen. */
/** Common owner countries beyond the fixed seven get their own slot so neighbours never share a colour. */
const EXTRA_SLOT: Record<string, number> = { IE: 0, CH: 1, LU: 2, DK: 3, IT: 4, ES: 5 };

export function countryColour(t: Theme, iso: string): string {
  if (iso === "OTHER") return t.other;
  const fixed = t.country[iso];
  if (fixed) return fixed;
  const slot = EXTRA_SLOT[iso];
  if (slot !== undefined) return t.extra[slot]!;
  let h = 0;
  for (const c of iso) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return t.extra[h % t.extra.length]!;
}

export const serif = {
  fontFamily: Platform.select({ ios: "Georgia", android: "serif", default: "Georgia, 'Times New Roman', serif" }),
} as const;
