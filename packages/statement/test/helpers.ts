import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeFile, parseStatement } from "../src/index";
import type { LocalTransaction, ParseResult } from "../src/types";

// Test-only Node file access; the library itself never touches the filesystem.
export function fixtureBytes(name: string): ArrayBuffer {
  const buf = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export function fixtureText(name: string): string {
  return decodeFile(fixtureBytes(name));
}

export function parseFixture(name: string): Promise<ParseResult> {
  return parseStatement(fixtureText(name), { filename: name });
}

/** Compact view of a transaction for readable assertions. */
export function brief(t: LocalTransaction) {
  return { date: t.date, amount: t.amount, kind: t.kind, normPayee: t.normPayee };
}
