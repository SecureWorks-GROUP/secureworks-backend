// One super rule (owner, 17 Nov 2026, ticket P1-01): every rate and every
// work order amount includes super. The fund gets 12/112 of the total and the
// person is paid the rest (trade_invoice_money.ts, basis super_inclusive_v1).
//
// This module decides which rule prices an invoice. Nothing else may:
//
//   - feature flag trade_super_inclusive_v1 (seeded off). Missing is off.
//   - trade_super_inclusive_settings.starts_on (one row, null until the office
//     sets it). The rule applies to an invoice whose week starts on or after
//     that day (an invoice with no week: the day it is priced). Null is off.
//   - a group share keeps its group's own rule (all_in_12_v2 is already super
//     inclusive at share level; the older 12/6 groups are an open question),
//     so an invoice that carries a group share line is never priced here.
//
// The rule is stamped on the invoice (super_basis) when it is priced. Every
// read, retry and Xero check follows the stamp and never this switch, so an
// invoice keeps the rule it was priced under and earlier weeks never move.
//
// A submit refuses (503, nothing saved) when the switch or the start date
// cannot be read: pricing a week under the wrong rule is a wrong pay. A
// preview falls back to today's rule and logs.

import {
  TRADE_INVOICE_SUPER_INCLUSIVE_BASIS,
  type TradeInvoiceSuperBasis,
} from "./trade_invoice_money.ts";

export const TRADE_SUPER_INCLUSIVE_FLAG = "trade_super_inclusive_v1";

export type TradeSuperInclusiveState =
  | { ok: true; on: boolean; startsOn: string | null }
  | { ok: false; reason: string };

export class TradeSuperInclusiveUnreadable extends Error {
  readonly code = "super_rule_unreadable";
  constructor(reason: string) {
    super(`Could not check which super rule applies (${reason}).`);
    this.name = "TradeSuperInclusiveUnreadable";
  }
}

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

/** Reads the switch, then (only when it is on) the start date. */
export async function readTradeSuperInclusiveState(
  client: any,
): Promise<TradeSuperInclusiveState> {
  try {
    const flag = await client.from("feature_flags")
      .select("enabled")
      .eq("flag_name", TRADE_SUPER_INCLUSIVE_FLAG)
      .limit(1);
    if (flag?.error) {
      return { ok: false, reason: "switch unreadable" };
    }
    if (firstRow(flag?.data)?.enabled !== true) {
      return { ok: true, on: false, startsOn: null };
    }
    const settings = await client.from("trade_super_inclusive_settings")
      .select("starts_on")
      .eq("id", 1)
      .limit(1);
    if (settings?.error) {
      return { ok: false, reason: "start date unreadable" };
    }
    const raw = firstRow(settings?.data)?.starts_on ?? null;
    const startsOn = dateOnly(raw);
    if (raw !== null && startsOn === null) {
      return { ok: false, reason: "start date not a date" };
    }
    return { ok: true, on: true, startsOn };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export type TradeInvoiceSuperBasisInput = {
  // The basis a group share asks for (assertAllInGroupInvoiceStandalone).
  groupBasis?: TradeInvoiceSuperBasis | null;
  // True when any line is a group share line.
  carriesGroupShare?: boolean;
  // The invoice's week start; else the day it is priced.
  weekStart?: unknown;
  pricedOn: unknown;
};

/** The pure decision. null means today's rule. */
export function chooseTradeInvoiceSuperBasis(
  state: { on: boolean; startsOn: string | null },
  input: TradeInvoiceSuperBasisInput,
): TradeInvoiceSuperBasis | null {
  if (input.groupBasis) return input.groupBasis;
  if (input.carriesGroupShare) return null;
  if (!state.on || !state.startsOn) return null;
  const key = dateOnly(input.weekStart) ?? dateOnly(input.pricedOn);
  if (!key) return null;
  return key >= state.startsOn ? TRADE_INVOICE_SUPER_INCLUSIVE_BASIS : null;
}

/** For a write that saves an invoice: refuses when the rule is unreadable. */
export async function resolveTradeInvoiceSuperBasisForSubmit(
  client: any,
  input: TradeInvoiceSuperBasisInput,
): Promise<TradeInvoiceSuperBasis | null> {
  if (input.groupBasis) return input.groupBasis;
  if (input.carriesGroupShare) return null;
  const state = await readTradeSuperInclusiveState(client);
  if (!state.ok) throw new TradeSuperInclusiveUnreadable(state.reason);
  return chooseTradeInvoiceSuperBasis(state, input);
}

/** For a read that only shows money: falls back to today's rule. */
export async function resolveTradeInvoiceSuperBasisForPreview(
  client: any,
  input: TradeInvoiceSuperBasisInput,
): Promise<TradeInvoiceSuperBasis | null> {
  if (input.groupBasis) return input.groupBasis;
  if (input.carriesGroupShare) return null;
  const state = await readTradeSuperInclusiveState(client);
  if (!state.ok) {
    console.error(
      "[ops-api] super rule unreadable, preview shows today's rule:",
      state.reason,
    );
    return null;
  }
  return chooseTradeInvoiceSuperBasis(state, input);
}

/** True when any line is a group share line. */
export function linesCarryGroupShare(
  lines: ReadonlyArray<{ group_share_id?: unknown; line_type?: unknown }>,
): boolean {
  return (lines || []).some((line) =>
    Boolean(line?.group_share_id) ||
    String(line?.line_type ?? "").trim().toLowerCase() === "group share"
  );
}
