// Web only: the 6,600-brand generated list is too big for the main bundle (1.6 MB of 3.7 MB), so it's
// served as its own file and fetched after the first screen is up. Copies it to public/data under a
// content hash (so it can be cached for a year) and writes the URL to src/lib/open-brands-url.generated.ts.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const src = join(process.cwd(), "..", "..", "packages", "ownership", "data", "open-brands.json");
const out = join(process.cwd(), "public", "data");
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (/^open-brands\.[0-9a-f]+\.json$/.test(f)) rmSync(join(out, f));
const buf = readFileSync(src);
const hash = createHash("sha256").update(buf).digest("hex").slice(0, 12);
const name = `open-brands.${hash}.json`;
writeFileSync(join(out, name), buf);
writeFileSync(
  join(process.cwd(), "src", "lib", "open-brands-url.generated.ts"),
  `// Written by scripts/copy-data.mjs — do not edit.\nexport const OPEN_BRANDS_URL = "/data/${name}";\n`,
);
console.log(`[copy-data] public/data/${name} (${(buf.length / 1024).toFixed(0)} KB)`);
