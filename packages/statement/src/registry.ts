/**
 * Registry of supported bank formats, in detection priority order: most distinctive fingerprints
 * first, loose ones (headerless HSBC, filename-based Chase) last.
 */
import type { BankFormat } from "./types";
import { amex } from "./banks/amex";
import { barclays } from "./banks/barclays";
import { chaseUk } from "./banks/chase";
import type { BankDefinition, MatchContext } from "./banks/format";
import { toBankFormat } from "./banks/format";
import { hsbc } from "./banks/hsbc";
import { lloyds } from "./banks/lloyds";
import { monzo } from "./banks/monzo";
import { n26New, n26Old } from "./banks/n26";
import { nationwide } from "./banks/nationwide";
import { natwest } from "./banks/natwest";
import { revolut } from "./banks/revolut";
import { santander } from "./banks/santander";
import { starling } from "./banks/starling";
import { wise } from "./banks/wise";

export const BANKS: readonly BankDefinition[] = [
  monzo,
  starling,
  revolut,
  wise,
  n26New,
  n26Old,
  lloyds,
  barclays,
  nationwide,
  natwest,
  amex,
  santander,
  hsbc,
  chaseUk,
];

/** Plain list for UI display ("supported banks"). */
export const SUPPORTED_BANKS: BankFormat[] = BANKS.map(toBankFormat);

/** Text-level formats (non-CSV) are matched on raw lines before any CSV parsing. */
export function matchTextFormat(firstLines: string[], ctx: MatchContext = {}): BankDefinition | null {
  return BANKS.find((b) => b.parseText && b.match([], firstLines, ctx)) ?? null;
}

/** Try every CSV bank fingerprint against one candidate header row. */
export function matchHeaderRow(headers: string[], firstLines: string[], ctx: MatchContext = {}): BankDefinition | null {
  return BANKS.find((b) => !b.parseText && b.match(headers, firstLines, ctx)) ?? null;
}

export function getBank(id: string): BankDefinition | undefined {
  return BANKS.find((b) => b.id === id);
}
