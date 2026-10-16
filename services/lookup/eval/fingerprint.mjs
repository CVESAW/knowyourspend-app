// Prints the fingerprint of the local files (the same values kys-llm-eval returns for {"action":"fingerprint"}),
// and, given the live result as a file argument, says whether they match.
import { readFileSync } from "node:fs";
globalThis.Deno = { env: { get: () => "" }, serve: () => {} };
const { fingerprint } = await import(process.env.KYS_EVAL_INDEX ?? "../kys-llm-eval.ts");
const local = await fingerprint();
const live = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], "utf8")) : null;
if (!live) console.log(JSON.stringify(local, null, 1));
else {
  const diff = Object.keys(local).filter((k) => JSON.stringify(local[k]) !== JSON.stringify(live[k]));
  console.log(diff.length ? `DIFFERENT: ${diff.join(", ")}` : "same as the local files");
  for (const k of diff) console.log(k, "\n local:", JSON.stringify(local[k]), "\n live: ", JSON.stringify(live[k]));
}
