import type { OwnershipEntry } from "./types";
import merchantsJson from "../data/merchants.json";
import productBrandsJson from "../data/product-brands.json";
import countriesJson from "../data/countries.json";
import correctionsJson from "../data/open-brand-corrections.json";
import { openBrandEntries, type OpenBrandCorrectionsFile, type OpenBrandsFile } from "./open-brands";
import { BUNDLED_OPEN_BRANDS } from "./open-brands-data";

export * from "./types";
export {
  createResolver, normalise, tierRank, isPublishable, badgeFor, cleanPayee, domainsIn,
  FRESHNESS_DAYS, ACQUIRER_PREFIXES, INDEPENDENT_KEYWORDS, SHORTHAND,
} from "./resolve";
export type { Resolver, BadgeLabel, ResolverOptions, ResolveWhere } from "./resolve";
export { expandOpenBrand, openBrandEntries, tradesIn, OPEN_BRANDS_TECHNIQUE } from "./open-brands";
export type { OpenBrandRecord, OpenBrandsFile, OpenBrandCorrection, OpenBrandCorrectionsFile } from "./open-brands";

export interface CountryInfo { name: string; flag: string }

// JSON imports widen literal unions (tier, relation…) to string; scripts/validate.ts is what guarantees the shape.
/** Hand-built list (merchants), checked against registries and analyst knowledge. */
export const merchants = merchantsJson as unknown as OwnershipEntry[];
export const productBrands = productBrandsJson as unknown as OwnershipEntry[];
/** The hand-built lists only (no generated brands): used where text is noisy, e.g. receipt photos. */
export const checkedEntries: OwnershipEntry[] = [...merchants, ...productBrands];
const corrections = correctionsJson as unknown as OpenBrandCorrectionsFile;
/**
 * Generated list: OpenStreetMap brands + Wikidata owners, minus anything the hand-built list covers.
 * Bundled everywhere except the web app, which adds it later with addOpenBrands() (the arrays below
 * are then filled in place, so every importer sees the full list).
 */
export const openBrands: OwnershipEntry[] = BUNDLED_OPEN_BRANDS ? openBrandEntries(BUNDLED_OPEN_BRANDS, checkedEntries, corrections) : [];
export const openBrandsMeta: { generated: string; sources: string[] } = {
  generated: BUNDLED_OPEN_BRANDS?.generated ?? "",
  sources: BUNDLED_OPEN_BRANDS?.sources ?? [],
};
export const allEntries: OwnershipEntry[] = [...checkedEntries, ...openBrands];

/** Add the generated list when it wasn't bundled (web). Returns the entries added; a second call adds nothing. */
export function addOpenBrands(file: OpenBrandsFile): OwnershipEntry[] {
  if (openBrands.length) return [];
  const added = openBrandEntries(file, checkedEntries, corrections);
  openBrands.push(...added);
  allEntries.push(...added);
  openBrandsMeta.generated = file.generated;
  openBrandsMeta.sources = file.sources;
  return added;
}
export const countries = countriesJson as Record<string, CountryInfo>;
