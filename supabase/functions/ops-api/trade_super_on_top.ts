// Super on top (owner, 13 Nov 2026).
//
// A trade listed in public.trade_super_on_top is paid the whole amount they
// earn, and the company pays the 12% super on top of it. Every other trade
// keeps the split in trade_invoice_money.ts: 6% withheld from the trade, 6%
// from the company.
//
// The list is staff-only data (RLS on, no browser role can read or write it),
// never users.trade_details, which a trade can edit from their own profile.
// A trade moves onto super on top from the date in the row: an invoice whose
// week starts on or after that date (or, with no week, is dated on or after
// it) carries super_basis super_on_top_v1.
//
// A group share keeps its own basis (the group's pay basis decides), so an
// invoice that carries a group share never takes this one.

import { TRADE_INVOICE_SUPER_ON_TOP_BASIS } from "./trade_invoice_money.ts";

export type TradeSuperOnTopRow = {
  user_id: string;
  effective_from: string;
};

export type TradeSuperOnTopRead =
  | { ok: true; row: TradeSuperOnTopRow | null }
  | { ok: false; error: string };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isoDay(value: unknown): string | null {
  const text = String(value ?? "").slice(0, 10);
  return ISO_DAY.test(text) ? text : null;
}

/** The pure rule: on top from effective_from, inclusive. */
export function superOnTopBasisFor(
  row: TradeSuperOnTopRow | null,
  invoiceDay: unknown,
): typeof TRADE_INVOICE_SUPER_ON_TOP_BASIS | null {
  if (!row) return null;
  const from = isoDay(row.effective_from);
  const day = isoDay(invoiceDay);
  if (!from || !day) return null;
  return day >= from ? TRADE_INVOICE_SUPER_ON_TOP_BASIS : null;
}

export async function readTradeSuperOnTop(
  client: any,
  userId: string,
): Promise<TradeSuperOnTopRead> {
  if (!userId) return { ok: true, row: null };
  const { data, error } = await client
    .from("trade_super_on_top")
    .select("user_id, effective_from")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { ok: false, error: String(error.message || error.code || "read failed") };
  return { ok: true, row: data ? { user_id: String(data.user_id), effective_from: String(data.effective_from) } : null };
}

export class TradeSuperOnTopUnreadable extends Error {
  readonly code = "super_on_top_unreadable";
  constructor(detail: string) {
    super(`Could not read whether super is paid on top for this trade: ${detail}`);
  }
}

/**
 * The basis for an invoice that is about to be saved. A failed read refuses
 * rather than guessing: a guess either withholds 6% from a trade who is owed
 * it or pays 6% to one who is not.
 */
export async function resolveSuperOnTopBasisForSubmit(
  client: any,
  userId: string,
  invoiceDay: unknown,
): Promise<typeof TRADE_INVOICE_SUPER_ON_TOP_BASIS | null> {
  const read = await readTradeSuperOnTop(client, userId);
  if (!read.ok) throw new TradeSuperOnTopUnreadable(read.error);
  return superOnTopBasisFor(read.row, invoiceDay);
}

/** For previews and drafts: a failed read shows the ordinary split, logged. */
export async function resolveSuperOnTopBasisForPreview(
  client: any,
  userId: string,
  invoiceDay: unknown,
): Promise<typeof TRADE_INVOICE_SUPER_ON_TOP_BASIS | null> {
  const read = await readTradeSuperOnTop(client, userId);
  if (!read.ok) {
    console.error("[ops-api] super on top unreadable for preview:", read.error);
    return null;
  }
  return superOnTopBasisFor(read.row, invoiceDay);
}
