#!/usr/bin/env node
/**
 * Builds tools/python/dist/kys.py: kys.template.py with the constant tables taken straight from the TypeScript
 * sources, so the script and the app can't drift apart. Plain Node 22, no dependencies of its own (it borrows the
 * TypeScript compiler the packages already install).
 *
 *   node tools/python/build.mjs           write dist/kys.py
 *   node tools/python/build.mjs --check   fail if dist/kys.py is not what this would write
 *
 * How it reads the constants: each TypeScript file is transpiled to CommonJS and run in this process, with every
 * top-level `const` handed back, exported or not. Imports of the other files listed below are loaded the same way;
 * any other import gets an inert stand-in (nothing here calls into them at load time). Values are then written out as
 * Python literals; regular expressions are translated to Python's `re` syntax by translateRegex() below.
 *
 * The output depends only on the template and the values of the constants (not on comments or formatting in the
 * TypeScript), so --check only fails when something that changes the script's behaviour has changed. Logic written
 * inside TypeScript functions is ported by hand in the template; tools/python/vectors.ts and test_kys.py check it
 * gives the same answers.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const TEMPLATE = join(here, "kys.template.py");
const OUT = join(here, "dist", "kys.py");
const MARKER = "# @@GENERATED_TABLES@@";

// The TypeScript compiler, from a package that already depends on it.
const ts = createRequire(join(repo, "packages", "ownership", "package.json"))("typescript");

// ── Loading TypeScript modules ───────────────────────────────────────────────────────────────────────────────────
const SOURCES = {
  normalise: "packages/statement/src/normalise.ts",
  places: "packages/statement/src/places-more.ts",
  classify: "packages/statement/src/classify.ts",
  sensitive: "packages/statement/src/sensitive.ts",
  parse: "packages/statement/src/parse.ts",
  values: "packages/statement/src/values.ts",
  resolve: "packages/ownership/src/resolve.ts",
  openBrands: "packages/ownership/src/open-brands.ts",
  attribute: "packages/core/src/attribute.ts",
  locate: "packages/core/src/locate.ts",
  explain: "packages/core/src/explain.ts",
  quick: "packages/core/src/quick-lookup.ts",
};
const ALLOWED = new Set(Object.values(SOURCES).map((p) => join(repo, p)));
// Settings read from JSON files: the website's look-up address and its public ("anon") key, the same ones the website
// and the app use, so the script's --online stays in step with them.
const JSON_SOURCES = { site: "apps/site/site.config.json", geonames: "packages/core/data/places.json" };

const inert = new Proxy(function () {}, {
  get: (_t, p) => (p === "__esModule" ? true : p === Symbol.toPrimitive ? () => "" : inert),
  apply: () => inert,
  construct: () => inert,
});
const loaded = new Map();

/** Run one TypeScript file and return { exports, consts }: consts holds every top-level const, exported or not. */
function load(file) {
  if (loaded.has(file)) return loaded.get(file);
  if (!existsSync(file)) throw new Error(`build.mjs: ${relative(repo, file)} is missing (the Python tool reads its constants)`);
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const names = [];
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
  }
  const js = ts.transpileModule(src, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  // Exported consts become exports.X in CommonJS, so fall back to that when there is no local binding.
  const grab = names.map((n) => `${JSON.stringify(n)}: (typeof ${n} !== "undefined" ? ${n} : exports[${JSON.stringify(n)}])`);
  const code = `(function (exports, require, module) {\n${js}\n;module.exports.__consts = {${grab.join(", ")}};\n})`;
  const mod = { exports: {} };
  loaded.set(file, mod);
  const req = (spec) => {
    // No countries while loading: locate.ts's COUNTRY_NAMES then holds only its own extra names ("ENGLAND",
    // "HOLLAND"...), and the script adds the names from countries.json when it loads the data, as locate.ts does.
    if (spec === "@kys/ownership") return { countries: {} };
    if (spec.startsWith(".")) {
      const base = resolve(dirname(file), spec);
      for (const c of [`${base}.ts`, join(base, "index.ts")]) if (ALLOWED.has(c)) return load(c).exports;
    }
    return inert;
  };
  vm.runInThisContext(code, { filename: file })(mod.exports, req, mod);
  return mod;
}

const consts = {};
for (const [key, path] of Object.entries(SOURCES)) consts[key] = load(join(repo, path)).exports.__consts;
for (const [key, path] of Object.entries(JSON_SOURCES)) {
  if (consts[key]) throw new Error(`build.mjs: ${key} is used twice`);
  consts[key] = JSON.parse(readFileSync(join(repo, path), "utf8"));
}
const sourceOf = (mod) => SOURCES[mod] ?? JSON_SOURCES[mod];

function take(mod, name) {
  const v = consts[mod]?.[name];
  if (v === undefined || v === null) throw new Error(`build.mjs: ${sourceOf(mod)} no longer has ${name}; update tools/python (build.mjs and kys.template.py)`);
  return v;
}

// ── JavaScript regular expressions → Python ──────────────────────────────────────────────────────────────────────
/**
 * JavaScript's \s, as the body of a character class. Python's \s differs (it has \x1c-\x1f and \x85, not U+FEFF), and
 * with re.ASCII it is only [ \t\n\r\f\v].
 */
const hex = (n, w) => n.toString(16).padStart(w, "0");
const esc = (cp) => `\\${cp < 0x100 ? "x" : "u"}${hex(cp, cp < 0x100 ? 2 : 4)}`;
const JS_SPACE = ["\\t", "\\n", esc(0x0b), esc(0x0c), "\\r", " ", esc(0xa0), esc(0x1680), `${esc(0x2000)}-${esc(0x200a)}`, esc(0x2028), esc(0x2029), esc(0x202f), esc(0x205f), esc(0x3000), esc(0xfeff)].join("");
const JS_DOT = `[^\\n\\r${esc(0x2028)}${esc(0x2029)}]`;

/** A character as it can appear in a Python pattern written as r"..." (ASCII only, so the file stays ASCII). */
function patChar(ch, inClass) {
  const cp = ch.codePointAt(0);
  if (cp > 0xffff) return `\\U${hex(cp, 8)}`;
  if (cp > 0x7e) return `\\u${hex(cp, 4)}`;
  if (cp < 0x20) return `\\x${hex(cp, 2)}`;
  if (ch === '"') return '\\"';
  if (inClass && "\\]^-[&~|".includes(ch)) return `\\${ch}`;
  return ch;
}

/**
 * Translate a JavaScript RegExp (no u/y/s/m flags) to an equivalent Python pattern, used with re.ASCII so \b, \d and \w
 * mean what they mean in JavaScript. `$` becomes \Z (Python's $ also matches before a final newline). With
 * spaces: "js", \s and . keep JavaScript's exact meaning; with "collapsed" they stay as Python's, which is the same
 * thing for text whose whitespace has already been turned into plain spaces (true of every string the app's
 * normalise, classify and sensitive regexes are run on).
 */
function translateRegex(re, spaces) {
  const src = re.source;
  for (const f of re.flags) if (!"gi".includes(f)) throw new Error(`build.mjs: unsupported flag "${f}" in /${src}/${re.flags}`);
  const S = spaces === "js" ? `[${JS_SPACE}]` : String.raw`\s`;
  const notS = spaces === "js" ? `[^${JS_SPACE}]` : String.raw`\S`;
  const dot = spaces === "js" ? JS_DOT : ".";
  let out = "";
  let i = 0;
  const fail = (why) => {
    throw new Error(`build.mjs: can't translate /${src}/ (${why} at ${i})`);
  };
  /** One escape sequence starting at src[i] === "\\"; returns { text, cls?: boolean, ch?: string }. */
  const escape = (inClass) => {
    const c = src[i + 1];
    if (c === undefined) fail("trailing backslash");
    i += 2;
    if (c === "s") return { cls: true, text: inClass ? (spaces === "js" ? JS_SPACE : String.raw`\s`) : S };
    if (c === "S") {
      if (inClass) fail("\\S inside a class");
      return { cls: true, text: notS };
    }
    if ("dDwW".includes(c)) return { cls: true, text: `\\${c}` };
    if (c === "b") return inClass ? { ch: "\b" } : { cls: true, text: "\\b" };
    if (c === "B") {
      if (inClass) fail("\\B inside a class");
      return { cls: true, text: "\\B" };
    }
    if (c === "t") return { ch: "\t" };
    if (c === "n") return { ch: "\n" };
    if (c === "r") return { ch: "\r" };
    if (c === "f") return { ch: "\f" };
    if (c === "v") return { ch: "\v" };
    if (c === "0" && !/[0-9]/.test(src[i] ?? "")) return { ch: "\0" };
    if (c === "x") {
      const h = src.slice(i, i + 2);
      if (!/^[0-9a-fA-F]{2}$/.test(h)) fail("bad \\x");
      i += 2;
      return { ch: String.fromCharCode(parseInt(h, 16)) };
    }
    if (c === "u") {
      const h = src.slice(i, i + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(h)) fail("bad \\u");
      i += 4;
      return { ch: String.fromCharCode(parseInt(h, 16)) };
    }
    if (/[1-9]/.test(c)) {
      if (inClass) fail("backreference inside a class");
      let n = c;
      while (/[0-9]/.test(src[i] ?? "")) n += src[i++];
      return { cls: true, text: `\\${n}` };
    }
    if (/[A-Za-z0-9]/.test(c)) fail(`unsupported escape \\${c}`);
    return { ch: c }; // identity escape of punctuation: \. \* \/ \- …
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      const e = escape(false);
      out += e.cls ? e.text : patChar(e.ch, false).replace(/^([.*+?()[\]{}|^$\\])$/, "\\$1");
      continue;
    }
    if (c === "[") {
      i++;
      let negate = false;
      if (src[i] === "^") {
        negate = true;
        i++;
      }
      if (src[i] === "]") fail("empty class");
      // atoms: { ch } single characters, { cls } class escapes
      const atoms = [];
      while (i < src.length && src[i] !== "]") {
        if (src[i] === "\\") atoms.push(escape(true));
        else {
          const cp = src.codePointAt(i);
          const ch = String.fromCodePoint(cp);
          atoms.push({ ch, raw: ch === "-" });
          i += ch.length;
        }
      }
      if (src[i] !== "]") fail("unterminated class");
      i++;
      // Left to right, as JavaScript reads it: char "-" char is a range; a "-" at either end or next to a class
      // escape (\s, \d…) is a literal hyphen.
      let body = "";
      for (let k = 0; k < atoms.length; ) {
        const a = atoms[k];
        const dash = atoms[k + 1];
        const to = atoms[k + 2];
        if (a.ch !== undefined && dash?.raw && to?.ch !== undefined) {
          if (a.ch.codePointAt(0) > to.ch.codePointAt(0)) fail("range out of order");
          body += `${patChar(a.ch, true)}-${patChar(to.ch, true)}`;
          k += 3;
        } else {
          body += a.cls ? a.text : patChar(a.ch, true);
          k += 1;
        }
      }
      out += `[${negate ? "^" : ""}${body}]`;
      continue;
    }
    if (c === "(") {
      if (src.startsWith("(?<", i) && !src.startsWith("(?<=", i) && !src.startsWith("(?<!", i)) {
        out += "(?P<";
        i += 3;
        continue;
      }
      out += "(";
      i++;
      continue;
    }
    if (c === "{") {
      const q = /^\{\d+(?:,\d*)?\}/.exec(src.slice(i));
      if (q) {
        out += q[0];
        i += q[0].length;
      } else {
        out += "\\{";
        i++;
      }
      continue;
    }
    if (c === "}") {
      out += "\\}";
      i++;
      continue;
    }
    if (c === ".") {
      out += dot;
      i++;
      continue;
    }
    if (c === "$") {
      out += "\\Z";
      i++;
      continue;
    }
    const cp = src.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    out += patChar(ch, false);
    i += ch.length;
  }
  return { pattern: out, ignoreCase: re.flags.includes("i") };
}

// ── Python literals ──────────────────────────────────────────────────────────────────────────────────────────────
const WIDTH = 116;
const isRegExp = (v) => Object.prototype.toString.call(v) === "[object RegExp]";

function pyStr(s) {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (cp >= 0x20 && cp < 0x7f) out += ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (cp < 0x100) out += `\\x${hex(cp, 2)}`;
    else if (cp < 0x10000) out += `\\u${hex(cp, 4)}`;
    else out += `\\U${hex(cp, 8)}`;
  }
  return `${out}"`;
}

/** A string too long for one line, as "..." pieces Python joins up, split after a "|" (or else a space). */
function pyLongStr(s, indent) {
  const one = pyStr(s);
  if (one.length + indent.length + 6 <= WIDTH) return one;
  const inner = `${indent}    `;
  const room = WIDTH - inner.length - 2;
  const parts = [];
  let cur = "";
  for (const tok of s.split(s.includes("|") ? /(?<=\|)/ : /(?<= )/)) {
    if (cur && pyStr(cur + tok).length > room) {
      parts.push(cur);
      cur = "";
    }
    cur += tok;
  }
  if (cur) parts.push(cur);
  return `(\n${parts.map((x) => `${inner}${pyStr(x)}`).join("\n")}\n${indent})`;
}

/** r"..." pieces of at most ~WIDTH characters, split before a "|" that isn't escaped (implicit concatenation). */
function rawPieces(pattern, room) {
  const pieces = [];
  let start = 0;
  let last = 0;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") {
      i++;
      continue;
    }
    if (pattern[i] === "|" && i > start) {
      if (i - start > room && last > start) {
        pieces.push(pattern.slice(start, last));
        start = last;
      }
      last = i;
    }
  }
  if (pattern.length - start > room && last > start) {
    pieces.push(pattern.slice(start, last));
    start = last;
  }
  pieces.push(pattern.slice(start));
  return pieces.map((p) => `r"${p}"`);
}

function pyRegex(re, spaces, indent) {
  const { pattern, ignoreCase } = translateRegex(re, spaces);
  const flags = ignoreCase ? "re.A | re.I" : "re.A";
  const one = `re.compile(r"${pattern}", ${flags})`;
  if (one.length + indent.length <= WIDTH) return one;
  const inner = `${indent}    `;
  const pieces = rawPieces(pattern, WIDTH - inner.length - 3);
  return `re.compile(\n${pieces.map((p) => `${inner}${p}`).join("\n")},\n${inner}${flags},\n${indent})`;
}

/** Any JSON-like value, or RegExp, as a Python literal. Arrays become tuples, Sets frozensets, objects dicts. */
function py(v, spaces, indent = "") {
  if (isRegExp(v)) return pyRegex(v, spaces, indent);
  if (typeof v === "string") return pyLongStr(v, indent);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("build.mjs: non-finite number");
    return String(v);
  }
  if (typeof v === "boolean") return v ? "True" : "False";
  if (v === null) return "None";
  if (v instanceof Set) {
    const items = [...v].map((x) => py(x, spaces, `${indent}    `));
    return wrap("frozenset({", "})", items, indent, false);
  }
  if (Array.isArray(v)) {
    const items = v.map((x) => py(x, spaces, `${indent}    `));
    return wrap("(", ")", items, indent, items.length === 1);
  }
  if (typeof v === "object") {
    const items = Object.entries(v).map(([k, x]) => `${pyStr(k)}: ${py(x, spaces, `${indent}    `)}`);
    return wrap("{", "}", items, indent, false);
  }
  throw new Error(`build.mjs: can't write ${typeof v} as Python`);
}

function wrap(open, close, items, indent, trailingComma) {
  const flat = `${open}${items.join(", ")}${trailingComma ? "," : ""}${close}`;
  if (!flat.includes("\n") && flat.length + indent.length <= WIDTH) return flat;
  const inner = `${indent}    `;
  // short items are packed several to a line; long or multi-line ones get a line each
  const lines = [];
  let line = "";
  for (const it of items) {
    if (it.includes("\n") || inner.length + it.length + 1 > WIDTH) {
      if (line) lines.push(line);
      lines.push(`${inner}${it},`);
      line = "";
      continue;
    }
    if (line && line.length + it.length + 2 > WIDTH) {
      lines.push(line);
      line = "";
    }
    line = line ? `${line} ${it},` : `${inner}${it},`;
  }
  if (line) lines.push(line);
  return `${open}\n${lines.join("\n")}\n${indent}${close}`;
}

// ── What the script takes from each file ─────────────────────────────────────────────────────────────────────────
// [module, TypeScript name, Python name (default: the same), value mapper]. Regexes in these modules are only run on
// text whose whitespace is already plain spaces ("collapsed"), except attribute.ts, which reads raw bank text ("js").
const TABLES = [
  ["normalise", "MAX_PAYEE_LENGTH"],
  ["normalise", "MONTHS"],
  ["normalise", "BANK_PREFIXES"],
  ["normalise", "FACILITATOR_RE"],
  ["normalise", "FACILITATOR_NAME"],
  ["normalise", "BT_OWN"],
  ["normalise", "KNOWN_FORMS"],
  ["normalise", "COUNTRIES_SAFE"],
  ["normalise", "COUNTRIES_PADDED_ONLY"],
  ["normalise", "PLACE_NAMES"],
  ["places", "MORE_PLACES"],
  ["normalise", "TRAILING_CODES"],
  ["normalise", "CONNECTOR_BEFORE"],
  ["normalise", "PREFIX_RE"],
  ["normalise", "PADDED_COUNTRY_RE"],
  ["normalise", "TRAILING_COUNTRY_RE"],
  ["normalise", "TRAILING_PLACE_RE"],
  ["normalise", "MORE_PLACE_RE"],
  ["normalise", "TRAILING_CODE_RE"],
  ["normalise", "TLD"],
  ["normalise", "DOMAIN_TOKEN_RE"],

  ["classify", "UK_TYPE_CODES", "UK_TYPE_CODES", (v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.hint]))],
  ["classify", "TYPE_LABEL_RULES"],
  ["classify", "DESCRIPTION_PREFIX_RULES"],
  ["classify", "INTERNAL_TEXT"],
  ["classify", "SAVINGS_ACCOUNT"],
  ["classify", "PLATFORM"],
  ["classify", "FINANCE_WORDS"],
  ["classify", "CARD_REPAYMENT"],
  ["classify", "OWN_WALLET"],
  ["classify", "CASH_TEXT"],
  ["classify", "FEE_TEXT"],
  ["classify", "REFUND_TEXT"],
  ["classify", "TRANSFER_TEXT"],
  ["classify", "CARD_MARKERS"],
  ["classify", "PERSON_LINK"],
  ["classify", "ORG_WORDS"],
  ["classify", "COMMON_BRANDS"],
  ["classify", "BRAND_RE"],
  ["classify", "BRAND_NAMES"],
  ["classify", "HONORIFICS"],
  ["classify", "MONTHS", "CLASSIFY_MONTHS"],
  ["classify", "PAYEE_AFTER_FACILITATOR"],
  ["classify", "WEB_ADDRESS"],

  ["sensitive", "SENSITIVE_KEYWORDS"],
  ["sensitive", "SENSITIVE_EXACT"],
  ["sensitive", "CATEGORY_RES"],

  ["resolve", "ACQUIRER_PREFIXES"],
  ["resolve", "INDEPENDENT_KEYWORDS"],
  ["resolve", "TIER_RANK"],
  ["resolve", "METHOD_RANK"],
  ["resolve", "VENUE_FIRST"],
  ["resolve", "FOOD_AND_DRINK"],
  ["resolve", "ARTICLE"],
  ["resolve", "SHORTHAND"],
  ["resolve", "NOISE_TAIL"],
  ["resolve", "DOMAIN_RE"],

  ["openBrands", "BROAD"],
  ["openBrands", "OPEN_BRANDS_TECHNIQUE"],

  ["attribute", "FACILITATOR", "FACILITATOR", undefined, "js"],
  ["attribute", "CARD_READER_RE", "CARD_READER_RE", undefined, "js"],
  ["attribute", "CARD_READERS"],

  ["locate", "ALPHA3"],
  ["locate", "SAFE_ALPHA2"],
  ["locate", "COUNTRY_NAMES", "COUNTRY_NAME_EXTRAS"],
  ["locate", "TLD_COUNTRY"],
  ["locate", "US_STATES"],
  ["locate", "FILLER"],
  ["locate", "CURRENCY_COUNTRY"],
  ["locate", "PAID_IN_RE", "PAID_IN_RE", undefined, "js"],
  ["locate", "EVIDENCE_LABEL"],
  // GeoNames towns (CC BY 4.0), as country -> "TOWN|TOWN|...": a third of the size of town -> [countries]
  ["geonames", "places", "PLACES_BY_COUNTRY", (places) => {
    const by = {};
    for (const [name, cs] of Object.entries(places)) {
      if (name.includes("|")) throw new Error(`build.mjs: a town name has a "|": ${name}`);
      for (const c of cs) (by[c] ??= []).push(name);
    }
    return Object.fromEntries(Object.keys(by).sort().map((c) => [c, by[c].join("|")]));
  }],

  ["explain", "THE"],
  ["explain", "ROLE"],
  ["explain", "PAID_THROUGH"],

  ["quick", "MAX_QUERY"],
  ["quick", "TO_SOMEONE"],

  ["site", "lookupUrl", "LOOKUP_URL"],
  ["site", "lookupKey", "LOOKUP_KEY"],

  ["parse", "MAX_FIELD_LENGTH"],
  ["parse", "HEADER_SCAN_ROWS"],
  ["parse", "OPENING_BALANCE"],
  ["values", "SYMBOLS"],
];

// Tables copied from data that must be credited where it's used (open-source/NOTICE)
const CREDITS = {
  geonames: "Town and city names from GeoNames (https://www.geonames.org), CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/),\n# reduced to names and country codes.",
};

export function generate() {
  const template = readFileSync(TEMPLATE, "utf8").replace(/\r\n/g, "\n");
  const at = template.indexOf(MARKER);
  if (at < 0 || template.indexOf(MARKER, at + 1) >= 0) throw new Error(`build.mjs: the template must contain ${MARKER} exactly once`);
  const blocks = [];
  let lastMod = "";
  const seen = new Set();
  for (const [mod, name, pyName = name, map, spaces = "collapsed"] of TABLES) {
    if (seen.has(pyName)) throw new Error(`build.mjs: ${pyName} is generated twice`);
    seen.add(pyName);
    const value = map ? map(take(mod, name)) : take(mod, name);
    if (mod !== lastMod) {
      blocks.push(`\n# ${sourceOf(mod)}${CREDITS[mod] ? `\n# ${CREDITS[mod]}` : ""}`);
      lastMod = mod;
    }
    blocks.push(`${pyName} = ${py(value, spaces)}`);
  }
  const header = [
    "# " + "=".repeat(114),
    "# Generated tables. Everything below this line up to the end marker is written by tools/python/build.mjs from the",
    "# TypeScript files named in the comments, so this script matches the app. Don't edit it here: change the TypeScript",
    "# and run `node tools/python/build.mjs`.",
    "# " + "=".repeat(114),
  ].join("\n");
  const generated = `${header}\n${blocks.join("\n")}\n\n# ${"=".repeat(46)} end of generated tables ${"=".repeat(44)}`;
  const out = template.slice(0, at) + generated + template.slice(at + MARKER.length);
  if (/[^\x00-\x7f]/.test(out)) {
    const bad = out.match(/[^\x00-\x7f]/)[0];
    throw new Error(`build.mjs: dist/kys.py must be plain ASCII; found U+${hex(bad.codePointAt(0), 4)} (escape it in the template)`);
  }
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = generate();
  const rel = relative(process.cwd(), OUT) || OUT;
  if (process.argv.includes("--check")) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current !== out) {
      console.error(`${rel} is out of date. Run: node tools/python/build.mjs`);
      process.exit(1);
    }
    console.log(`${rel} is up to date.`);
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, out);
    console.log(`Wrote ${rel} (${out.length.toLocaleString("en-GB")} bytes, ${out.split("\n").length - 1} lines).`);
  }
}
