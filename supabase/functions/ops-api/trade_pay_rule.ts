// One super rule (owner, 17 Nov 2026, ticket P1-01.3): every rate and every
// work order amount includes super. The fund gets 12/112 of the total and the
// person is paid the rest (trade_invoice_money.ts, basis inclusive_12_112_v1).
//
// This module decides which rule prices an invoice. Nothing else may:
//
//   - feature flag trade_pay_inclusive_super_v1 (seeded off). Missing is off.
//   - trade_pay_settings.inclusive_super_from (one row, a Monday, null until
//     the owner's word). The rule applies to an invoice whose pay day is on
//     or after that day. Pay day: week_start when the invoice has one, else
//     the day it is made. Null is off.
//
// The rule is stamped on the invoice (super_basis) when it is priced. Every
// read, retry and Xero check follows the stamp and never this switch, so an
// invoice keeps the rule it was priced under and earlier weeks never move.
// A group share keeps its group's own basis: callers pass
// groupBasis ?? resolveTradePayBasis(...).
//
// resolveTradePayBasis is the one decision for every money door. Given the
// stored invoice the save replaces (a draft, or a retried draft) it returns
// that invoice's stored basis whenever it is priced, a stored null being the
// old rule, and reads the switch only for a new or unpriced invoice. So a
// draft saved again after the switch moves keeps its rule and split. A door
// reads the prior with TRADE_PAY_PRIOR_INVOICE_COLUMNS.
//
// A save refuses (503, nothing saved) when the switch or the start date
// cannot be read: pricing a week under the wrong rule is a wrong pay. A
// preview shows no money figures (money_unavailable).

import {
  TRADE_INVOICE_EMPLOYER_SUPER_BASIS,
  TRADE_INVOICE_INCLUSIVE_SUPER_BASIS,
  type TradeInvoiceSuperBasis,
} from "./trade_invoice_money.ts";

export const TRADE_PAY_INCLUSIVE_FLAG = "trade_pay_inclusive_super_v1";

export type TradePayRuleRead =
  | { ok: true; on: boolean; from: string | null }
  | { ok: false; error: string };

export class TradePayRuleUnreadable extends Error {
  readonly code = "pay_rule_unreadable";
  constructor(reason: string) {
    super(`Could not check the pay rule (${reason}).`);
    this.name = "TradePayRuleUnreadable";
  }
}

export const TRADE_PAY_RULE_UNREADABLE_WORDS =
  "Could not check the pay rule. Nothing was saved. Try again in a minute.";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function dateOnly(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const day = value.slice(0, 10);
  return DATE_ONLY.test(day) ? day : null;
}

function firstRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" ? row as Record<string, unknown> : null;
}

// Also used by the invoice presenters, once per request. A tax read fault
// means unknown, independently of whether the pay rule can still be decided.
export async function readTradePaySettings(client: any) {
  try {
    return await client.from("trade_pay_settings")
      .select("inclusive_super_from, tax_set_aside_percent").eq("id", 1).limit(1);
  } catch {
    return { data: null, error: "settings unreadable" };
  }
}

export function tradePayTaxPercent(settings: any): number | null {
  if (settings?.error) return null;
  const raw = firstRow(settings?.data)?.tax_set_aside_percent;
  if (raw === null || raw === undefined) return null;
  const percent = Number(raw);
  return Number.isFinite(percent) && percent >= 0 && percent <= 60 ? percent : null;
}

/** One read of the switch and one of the start date. */
export async function readTradePayRule(client: any, settingsRead?: ReturnType<typeof readTradePaySettings>): Promise<TradePayRuleRead> {
  try {
    const [flag, settings] = await Promise.all([
      client.from("feature_flags")
        .select("enabled")
        .eq("flag_name", TRADE_PAY_INCLUSIVE_FLAG)
        .limit(1),
      settingsRead ?? readTradePaySettings(client),
    ]);
    if (flag?.error) return { ok: false, error: "switch unreadable" };
    const on = firstRow(flag?.data)?.enabled === true;
    // A switch read cleanly as off decides alone: the start date cannot
    // change the answer, so a fault reading it (or the table not there yet)
    // never stops an invoice priced on the old rule.
    if (!on) return { ok: true, on: false, from: null };
    if (settings?.error) return { ok: false, error: "start date unreadable" };
    const raw = firstRow(settings?.data)?.inclusive_super_from ?? null;
    const from = dateOnly(raw);
    if (raw !== null && from === null) {
      return { ok: false, error: "start date not a date" };
    }
    return { ok: true, on, from };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The pure decision. null means the old rule. */
export function tradePayBasisFor(
  read: { on: boolean; from: string | null },
  payDay: unknown,
): TradeInvoiceSuperBasis | null {
  if (!read.on || !read.from) return null;
  const day = dateOnly(payDay);
  if (!day) return null;
  return day >= read.from ? TRADE_INVOICE_INCLUSIVE_SUPER_BASIS : null;
}

/** The columns a door reads from the stored invoice its save replaces. */
export const TRADE_PAY_PRIOR_INVOICE_COLUMNS = "gross_earned, super_basis, super_base_ex";

/** The stored invoice a save replaces, as read with those columns. */
export type TradePayPriorInvoice = {
  gross_earned?: unknown;
  super_basis?: unknown;
  super_base_ex?: unknown;
} | null | undefined;

/**
 * The stored rule of a priced invoice. Priced means it carries a split
 * (gross_earned set); a stored null basis is the old rule. A basis this code
 * does not know is unreadable, never a guess.
 */
export function tradePayStoredBasis(
  prior: TradePayPriorInvoice,
): { priced: false } | { priced: true; basis: TradeInvoiceSuperBasis | null } {
  if (!prior || prior.gross_earned === null || prior.gross_earned === undefined) {
    return { priced: false };
  }
  const stored = prior.super_basis ?? null;
  if (stored === null) return { priced: true, basis: null };
  if (
    stored === TRADE_INVOICE_EMPLOYER_SUPER_BASIS ||
    stored === TRADE_INVOICE_INCLUSIVE_SUPER_BASIS
  ) {
    return { priced: true, basis: stored };
  }
  throw new TradePayRuleUnreadable("stored basis not recognised");
}

/**
 * The one decision for a write that saves an invoice. A priced prior keeps
 * its stored basis; a new or unpriced invoice takes the current rule for its
 * pay day. Refuses (TradePayRuleUnreadable) when the rule it needs cannot be
 * read.
 */
export async function resolveTradePayBasis(
  client: any,
  prior: TradePayPriorInvoice,
  payDay: unknown,
  settingsRead?: ReturnType<typeof readTradePaySettings>,
): Promise<TradeInvoiceSuperBasis | null> {
  const stored = tradePayStoredBasis(prior);
  if (stored.priced) return stored.basis;
  const read = await readTradePayRule(client, settingsRead);
  if (!read.ok) throw new TradePayRuleUnreadable(read.error);
  return tradePayBasisFor(read, payDay);
}

/** The same decision for a read that only shows money: unavailable, not a guess. */
export async function resolveTradePayBasisForPreview(
  client: any,
  prior: TradePayPriorInvoice,
  payDay: unknown,
  settingsRead?: ReturnType<typeof readTradePaySettings>,
): Promise<{ basis: TradeInvoiceSuperBasis | null; unavailable: boolean }> {
  try {
    return { basis: await resolveTradePayBasis(client, prior, payDay, settingsRead), unavailable: false };
  } catch (error) {
    if (!(error instanceof TradePayRuleUnreadable)) throw error;
    console.error("[ops-api] pay rule unreadable, preview shows no money:", error.message);
    return { basis: null, unavailable: true };
  }
}
