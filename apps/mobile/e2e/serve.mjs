// Static server for the exported web app with the same security headers as production (vercel.json).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
const root = process.argv[2], port = Number(process.argv[3] ?? 8090);
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".ico": "image/x-icon", ".gz": "application/gzip", ".ttf": "font/ttf" };
// mirror the production headers from vercel.json
let headers = {};
try {
  const v = JSON.parse(await readFile(join(root, "..", "vercel.json"), "utf8"));
  for (const h of v.headers.find((x) => x.source === "/(.*)").headers) headers[h.key] = h.value;
  delete headers["Strict-Transport-Security"];
} catch {}
createServer(async (req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  let f = join(root, p);
  try { if ((await stat(f)).isDirectory()) f = join(f, "index.html"); } catch { f = join(root, "index.html"); }
  try { const b = await readFile(f); res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream", ...headers }); res.end(b); }
  catch { res.writeHead(404); res.end(); }
}).listen(port);
