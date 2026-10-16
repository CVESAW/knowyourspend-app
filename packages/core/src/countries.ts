import { countries } from "@kys/ownership";

export function countryName(iso: string): string {
  if (iso === "OTHER") return "Other countries";
  return countries[iso]?.name ?? iso;
}
export function countryShort(iso: string): string {
  if (iso === "GB") return "UK";
  if (iso === "US") return "US";
  if (iso === "OTHER") return "Other";
  return countryName(iso);
}
export function flag(iso: string): string {
  if (iso === "OTHER") return "🌍";
  return countries[iso]?.flag ?? "🏳️";
}
