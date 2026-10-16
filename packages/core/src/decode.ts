/**
 * Decode statement bytes without relying on TextDecoder (the phone JS engine only guarantees UTF-8,
 * and not always that). Strict UTF-8 first; if the bytes aren't valid UTF-8, Windows-1252 — used
 * by Santander and Nationwide exports, where £ is 0xA3. Same output as @kys/statement's decodeFile.
 */
const CP1252_80_9F = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

function utf8Strict(b: Uint8Array): string | null {
  const out: string[] = [];
  let chunk: number[] = [];
  const flush = () => {
    out.push(String.fromCodePoint(...chunk));
    chunk = [];
  };
  for (let i = 0; i < b.length; ) {
    const c = b[i]!;
    let cp: number, n: number;
    if (c < 0x80) { cp = c; n = 0; }
    else if (c >= 0xc2 && c < 0xe0) { cp = c & 0x1f; n = 1; }
    else if (c >= 0xe0 && c < 0xf0) { cp = c & 0x0f; n = 2; }
    else if (c >= 0xf0 && c < 0xf5) { cp = c & 0x07; n = 3; }
    else return null;
    if (i + n >= b.length + (n ? 0 : 1) && n) return null;
    for (let k = 1; k <= n; k++) {
      const cc = b[i + k];
      if (cc === undefined || (cc & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (cc & 0x3f);
    }
    if ((n === 2 && cp < 0x800) || (n === 3 && (cp < 0x10000 || cp > 0x10ffff)) || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    chunk.push(cp);
    if (chunk.length >= 8192) flush();
    i += n + 1;
  }
  flush();
  return out.join("");
}

function cp1252(b: Uint8Array): string {
  const out: string[] = [];
  let chunk: number[] = [];
  for (const c of b) {
    chunk.push(c >= 0x80 && c <= 0x9f ? CP1252_80_9F[c - 0x80]! : c);
    if (chunk.length >= 8192) {
      out.push(String.fromCharCode(...chunk));
      chunk = [];
    }
  }
  out.push(String.fromCharCode(...chunk));
  return out.join("");
}

export function decodeStatementBytes(bytes: ArrayBuffer): string {
  const b = new Uint8Array(bytes);
  const utf8 = utf8Strict(b);
  return utf8 !== null ? utf8.replace(/^\uFEFF/, "") : cp1252(b);
}
