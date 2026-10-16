import openBrandsJson from "../data/open-brands.json";
import type { OpenBrandsFile } from "./open-brands";

/**
 * Node, tests and the phone apps: the generated brand list ships inside the bundle.
 * The web app uses open-brands-data.web.ts instead and fetches the list after the first screen is up
 * (it's 1.6 MB — most of the web bundle), via addOpenBrands().
 */
export const BUNDLED_OPEN_BRANDS: OpenBrandsFile | null = openBrandsJson as unknown as OpenBrandsFile;
