import { countries } from "@kys/ownership";

/**
 * Share images are drawn on the device from aggregates only (DESIGN-product §8.2):
 * whole-number percentages and country names — never amounts, dates, counts or shop names.
 * The typed model below is the only input, so those rules are enforced by construction.
 */
export interface ShareModel {
  ukShare: number; // 0..1
  slices: { iso: string; share: number }[]; // already top-N + OTHER, shares of matched spend
  periodLabel: string; // e.g. "Last 3 months"
}

export const SHARE_W = 1080;
export const SHARE_H = 1350;

const FIXED: Record<string, string> = {
  GB: "#4a463f", US: "#1f6f78", DE: "#a8782a", FR: "#2d4e8a", NL: "#8c2f39", SE: "#5e7d3a", JP: "#7a5c8e", OTHER: "#cfc6b3",
};
const EXTRA = ["#3f8f98", "#c49a4a", "#5474ad", "#a9545e", "#7f9c5c", "#9a7eae"];
const EXTRA_SLOT: Record<string, number> = { IE: 0, CH: 1, LU: 2, DK: 3, IT: 4, ES: 5 };

/** Same colours as the app's light theme, so the card matches the chart it came from. */
export function shareColour(iso: string): string {
  if (FIXED[iso]) return FIXED[iso]!;
  const slot = EXTRA_SLOT[iso];
  if (slot !== undefined) return EXTRA[slot]!;
  let h = 0;
  for (const c of iso) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return EXTRA[h % EXTRA.length]!;
}
function name(iso: string): string {
  if (iso === "GB") return "United Kingdom";
  if (iso === "OTHER") return "Other countries";
  return countries[iso]?.name ?? iso;
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export function shareText(m: ShareModel): string {
  return `${Math.round(m.ukShare * 100)}% of my spending went to UK-owned companies. See yours:`;
}

export function shareSvg(m: ShareModel): string {
  const W = SHARE_W;
  const H = SHARE_H;
  const cx = W / 2;
  const cy = 520;
  const r = 260;
  const sw = 110;
  let a0 = -Math.PI / 2;
  const arcs: string[] = [];
  const total = m.slices.reduce((s, x) => s + x.share, 0) || 1;
  for (const s of m.slices) {
    const frac = s.share / total;
    if (frac <= 0) continue;
    const a1 = a0 + frac * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1 - 0.0001), y1 = cy + r * Math.sin(a1 - 0.0001);
    arcs.push(`<path d="M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}" stroke="${shareColour(s.iso)}" stroke-width="${sw}" fill="none"/>`);
    a0 = a1;
  }
  const sans = "Inter, Helvetica, Arial, sans-serif";
  const serif = "Georgia, 'Times New Roman', serif";
  const legend = m.slices
    .slice(0, 7)
    .map((s, i) => {
      const y = 900 + i * 54;
      return `<rect x="200" y="${y - 22}" width="28" height="28" rx="6" fill="${shareColour(s.iso)}"/>
<text x="248" y="${y}" font-size="34" fill="#1c1b19" font-family="${sans}">${esc(name(s.iso))}</text>
<text x="880" y="${y}" font-size="34" fill="#1c1b19" text-anchor="end" font-family="${sans}" font-weight="600">${Math.round(s.share * 100)}%</text>`;
    })
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#f6f1e7"/>
<text x="${cx}" y="120" font-size="44" text-anchor="middle" fill="#6e685d" font-family="${sans}" letter-spacing="4">WHO OWNS THE COMPANIES I PAY</text>
<text x="${cx}" y="178" font-size="34" text-anchor="middle" fill="#6e685d" font-family="${sans}">${esc(m.periodLabel)}</text>
${arcs.join("\n")}
<text x="${cx}" y="${cy + 10}" font-size="120" text-anchor="middle" fill="#1c1b19" font-family="${serif}" font-weight="700">${Math.round(m.ukShare * 100)}%</text>
<text x="${cx}" y="${cy + 70}" font-size="36" text-anchor="middle" fill="#4a463f" font-family="${sans}">UK-owned</text>
${legend}
<line x1="120" x2="960" y1="1262" y2="1262" stroke="#d9d1c0" stroke-width="2"/>
<text x="120" y="1310" font-size="30" fill="#1c1b19" font-family="${serif}" font-weight="700">KnowYourSpend</text>
<text x="960" y="1300" font-size="22" text-anchor="end" fill="#6e685d" font-family="${sans}">My statement stayed on my phone</text>
<text x="960" y="1328" font-size="20" text-anchor="end" fill="#6e685d" font-family="${sans}">Estimates; may contain errors. knowyourspend.org</text>
</svg>`;
}
