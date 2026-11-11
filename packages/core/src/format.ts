export function pct(x: number, digits = 0): string {
  if (!isFinite(x)) return "–";
  return `${(x * 100).toFixed(digits)}%`;
}
export function money(x: number, currency = "GBP"): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: x >= 100 ? 0 : 2 }).format(x);
}
export function shortDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, 1).toLocaleDateString("en-GB", { month: "short" });
}
export function monthRange(from?: string, to?: string): string {
  if (!from || !to) return "";
  const f = new Date(from + "T00:00:00");
  const t = new Date(to + "T00:00:00");
  const sameYear = f.getFullYear() === t.getFullYear();
  const fm = f.toLocaleDateString("en-GB", { month: "short", ...(sameYear ? {} : { year: "numeric" }) });
  const tm = t.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
  if (f.getFullYear() === t.getFullYear() && f.getMonth() === t.getMonth()) return tm;
  return `${fm} – ${tm}`;
}
