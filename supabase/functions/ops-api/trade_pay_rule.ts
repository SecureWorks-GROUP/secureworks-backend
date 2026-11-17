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
// groupBasis ?? resolve(...).
//
// A submit refuses (503, nothing saved) when the switch or the start date
// cannot be read: pricing a week under the wrong rule is a wrong pay. A
// preview shows no money figures (money_unavailable).

import {
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

/** One read of the switch and one of the start date. */
export async function readTradePayRule(client: any): Promise<TradePayRuleRead> {
  try {
    const [flag, settings] = await Promise.all([
      client.from("feature_flags")
        .select("enabled")
        .eq("flag_name", TRADE_PAY_INCLUSIVE_FLAG)
        .limit(1),
      client.from("trade_pay_settings")
        .select("inclusive_super_from")
        .eq("id", 1)
        .limit(1),
    ]);
    if (flag?.error) return { ok: false, error: "switch unreadable" };
    if (settings?.error) return { ok: false, error: "start date unreadable" };
    const on = firstRow(flag?.data)?.enabled === true;
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

/** For a write that saves an invoice: refuses when the rule is unreadable. */
export async function resolveTradePayBasisForSubmit(
  client: any,
  payDay: unknown,
): Promise<TradeInvoiceSuperBasis | null> {
  const read = await readTradePayRule(client);
  if (!read.ok) throw new TradePayRuleUnreadable(read.error);
  return tradePayBasisFor(read, payDay);
}

/** For a read that only shows money: unavailable instead of a guess. */
export async function resolveTradePayBasisForPreview(
  client: any,
  payDay: unknown,
): Promise<{ basis: TradeInvoiceSuperBasis | null; unavailable: boolean }> {
  const read = await readTradePayRule(client);
  if (!read.ok) {
    console.error("[ops-api] pay rule unreadable, preview shows no money:", read.error);
    return { basis: null, unavailable: true };
  }
  return { basis: tradePayBasisFor(read, payDay), unavailable: false };
}
