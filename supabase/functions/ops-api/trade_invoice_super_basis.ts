/**
 * Super on top for one trade's own invoices (owner, 11 Nov 2026).
 *
 * Everyone is on the ordinary split (trade_invoice_money.ts): super is 12% of
 * the submitted total, half withheld from the trade, half paid by the
 * company. The office can mark a trade as "super on top": that trade's own
 * hourly and weekly invoices are then paid in full and the company pays the
 * whole 12% on top (the employer_12_v2 basis).
 *
 * This module is the one owner of that decision:
 *   - the setting is office-only data in trade_super_bases (dated rows: who
 *     set it, from when, who ended it). Nothing a trade sends reaches it;
 *   - an invoice that carries a group share keeps the group's own pay basis,
 *     whatever the trade's setting says;
 *   - the invoice records the setting row that priced it
 *     (trade_invoices.super_basis_setting_id), which is also what lets the
 *     database accept ordinary lines on an employer-super invoice.
 *
 * With no setting row every path returns the ordinary split, unchanged.
 * Migration: 20261111203000_trade_super_on_top.sql.
 */
// deno-lint-ignore-file no-explicit-any
import {
  TRADE_INVOICE_EMPLOYER_SUPER_BASIS,
  type TradeInvoiceSuperBasis,
} from "./trade_invoice_money.ts";

export const TRADE_SUPER_BASIS_TABLE = "trade_super_bases";
const SETTING_COLUMNS =
  "id, user_id, super_basis, effective_from, effective_to, created_by, created_at";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type TradeSuperBasisSetting = {
  id: string;
  user_id: string;
  super_basis: string;
  effective_from: string;
  effective_to: string | null;
  created_by?: string | null;
  created_at?: string | null;
};

/** What prices one invoice: the basis and, for an office setting, its row. */
export type TradeInvoiceSuperBasisDecision = {
  superBasis: TradeInvoiceSuperBasis | null;
  settingId: string | null;
};

export const ORDINARY_TRADE_SUPER_BASIS: TradeInvoiceSuperBasisDecision = Object
  .freeze({ superBasis: null, settingId: null });

export class TradeSuperBasisError extends Error {
  status: number;
  code: string;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "TradeSuperBasisError";
    this.code = code;
    this.status = status;
  }
}

function day(value: unknown): string | null {
  const text = String(value ?? "").slice(0, 10);
  if (!DAY_RE.test(text)) return null;
  const parsed = new Date(text + "T00:00:00Z");
  return Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== text
    ? null
    : text;
}

function addDays(value: string, days: number): string {
  return new Date(new Date(value + "T00:00:00Z").getTime() + days * 86400000)
    .toISOString().slice(0, 10);
}

/**
 * The setting row in effect on a day, or null. A row whose basis this code
 * does not know is never applied. When rows overlap, the latest start wins.
 */
export function tradeSuperBasisSettingOn(
  rows: readonly TradeSuperBasisSetting[] | null | undefined,
  userId: unknown,
  earningsDay: unknown,
): TradeSuperBasisSetting | null {
  const on = day(earningsDay);
  const user = String(userId || "");
  if (!on || !user) return null;
  const covering = (rows || []).filter((row) =>
    row && String(row.user_id) === user &&
    row.super_basis === TRADE_INVOICE_EMPLOYER_SUPER_BASIS &&
    day(row.effective_from) !== null &&
    String(row.effective_from).slice(0, 10) <= on &&
    (row.effective_to == null || String(row.effective_to).slice(0, 10) >= on)
  );
  covering.sort((a, b) =>
    String(b.effective_from).localeCompare(String(a.effective_from)) ||
    String(b.created_at || "").localeCompare(String(a.created_at || ""))
  );
  return covering[0] || null;
}

/**
 * The pure rule. A group share keeps the group's basis; otherwise the trade's
 * office setting, when one is in effect, prices the invoice on top.
 */
export function decideTradeInvoiceSuperBasis(input: {
  hasGroupShare: boolean;
  groupSuperBasis?: TradeInvoiceSuperBasis | null;
  setting: TradeSuperBasisSetting | null;
}): TradeInvoiceSuperBasisDecision {
  if (input.hasGroupShare) {
    return { superBasis: input.groupSuperBasis ?? null, settingId: null };
  }
  if (!input.setting) return ORDINARY_TRADE_SUPER_BASIS;
  return {
    superBasis: TRADE_INVOICE_EMPLOYER_SUPER_BASIS,
    settingId: String(input.setting.id),
  };
}

/** Reads the trade's setting for a day. An unreadable setting throws. */
export async function loadTradeSuperBasisSetting(
  client: any,
  userId: string,
  earningsDay: unknown,
): Promise<TradeSuperBasisSetting | null> {
  const on = day(earningsDay);
  if (!userId || !on) return null;
  // One trade has a handful of rows at most; the day is matched here, by the
  // same rule the tests pin, so the read is as plain as the deduction read.
  const { data, error } = await client.from(TRADE_SUPER_BASIS_TABLE)
    .select(SETTING_COLUMNS)
    .eq("user_id", userId);
  if (error) {
    throw new TradeSuperBasisError(
      "trade_super_basis_unreadable",
      "Your super setting could not be checked, so nothing was saved. Try again shortly.",
      503,
    );
  }
  return tradeSuperBasisSettingOn(data || [], userId, on);
}

/**
 * The basis for one invoice a trade raises. The setting is not read when the
 * invoice carries a group share.
 */
export async function loadTradeInvoiceSuperBasis(
  client: any,
  input: {
    userId: string;
    earningsDay: unknown;
    hasGroupShare: boolean;
    groupSuperBasis?: TradeInvoiceSuperBasis | null;
  },
): Promise<TradeInvoiceSuperBasisDecision> {
  if (input.hasGroupShare) {
    return decideTradeInvoiceSuperBasis({ ...input, setting: null });
  }
  return decideTradeInvoiceSuperBasis({
    ...input,
    setting: await loadTradeSuperBasisSetting(
      client,
      input.userId,
      input.earningsDay,
    ),
  });
}

/** The invoice column, only when an office setting priced the invoice. */
export function tradeSuperBasisInvoiceFields(
  decision: TradeInvoiceSuperBasisDecision | null | undefined,
): { super_basis_setting_id?: string } {
  return decision?.settingId
    ? { super_basis_setting_id: decision.settingId }
    : {};
}

/** Open settings, for the office rates panel. */
export async function listOpenTradeSuperBases(
  client: any,
): Promise<TradeSuperBasisSetting[]> {
  const { data, error } = await client.from(TRADE_SUPER_BASIS_TABLE)
    .select(SETTING_COLUMNS)
    .is("effective_to", null)
    .order("effective_from", { ascending: false });
  if (error) {
    throw new TradeSuperBasisError(
      "trade_super_basis_unreadable",
      "Super settings could not be read.",
      503,
    );
  }
  return (data || []).filter((row: TradeSuperBasisSetting) =>
    row.super_basis === TRADE_INVOICE_EMPLOYER_SUPER_BASIS
  );
}

/**
 * The office turns super on top on or off for one trade.
 *
 * On: adds an open row from `effectiveFrom` (default today). Already on is
 * answered with the row there is. Off: ends the open row the day before
 * `effectiveFrom` (default today), so invoices for earlier weeks keep it and
 * later ones return to the ordinary split. No invoice is rewritten either
 * way: a saved invoice keeps the basis it was saved on.
 */
export async function setTradeSuperOnTop(
  client: any,
  input: {
    userId: unknown;
    on: unknown;
    effectiveFrom?: unknown;
    actor: string;
    today: string;
  },
): Promise<{
  success: true;
  user_id: string;
  super_on_top: boolean;
  changed: boolean;
  setting: TradeSuperBasisSetting | null;
}> {
  const userId = String(input.userId || "");
  if (!UUID_RE.test(userId)) {
    throw new TradeSuperBasisError(
      "trade_super_basis_user_required",
      "Choose the trade to change.",
      400,
    );
  }
  if (typeof input.on !== "boolean") {
    throw new TradeSuperBasisError(
      "trade_super_basis_choice_required",
      "Say whether super on top is on or off.",
      400,
    );
  }
  const actor = String(input.actor || "").trim();
  const today = day(input.today);
  const from =
    input.effectiveFrom == null || input.effectiveFrom === ""
      ? today
      : day(input.effectiveFrom);
  if (!actor || !today || !from) {
    throw new TradeSuperBasisError(
      "trade_super_basis_date_invalid",
      "Enter the start date as a real day.",
      400,
    );
  }
  const { data: user, error: userErr } = await client.from("users")
    .select("id, org_id")
    .eq("id", userId)
    .maybeSingle();
  if (userErr || !user?.id || !user?.org_id) {
    throw new TradeSuperBasisError(
      "trade_super_basis_user_not_found",
      "That trade could not be found.",
      userErr ? 503 : 404,
    );
  }
  const readOpen = async (): Promise<TradeSuperBasisSetting | null> => {
    const { data, error } = await client.from(TRADE_SUPER_BASIS_TABLE)
      .select(SETTING_COLUMNS)
      .eq("user_id", userId)
      .is("effective_to", null)
      .maybeSingle();
    if (error) {
      throw new TradeSuperBasisError(
        "trade_super_basis_unreadable",
        "The current super setting could not be read. Nothing was changed.",
        503,
      );
    }
    return data || null;
  };
  const open = await readOpen();

  if (input.on) {
    if (open) {
      return {
        success: true,
        user_id: userId,
        super_on_top: true,
        changed: false,
        setting: open,
      };
    }
    const { data, error } = await client.from(TRADE_SUPER_BASIS_TABLE)
      .insert({
        org_id: user.org_id,
        user_id: userId,
        super_basis: TRADE_INVOICE_EMPLOYER_SUPER_BASIS,
        effective_from: from,
        created_by: actor,
      })
      .select(SETTING_COLUMNS)
      .single();
    if (error || !data?.id) {
      // Two office users at once: the one open row per trade wins.
      const raced = error?.code === "23505" ? await readOpen() : null;
      if (raced) {
        return {
          success: true,
          user_id: userId,
          super_on_top: true,
          changed: false,
          setting: raced,
        };
      }
      throw new TradeSuperBasisError(
        "trade_super_basis_not_saved",
        "Super on top could not be turned on. Nothing was changed.",
        503,
      );
    }
    return {
      success: true,
      user_id: userId,
      super_on_top: true,
      changed: true,
      setting: data,
    };
  }

  if (!open) {
    return {
      success: true,
      user_id: userId,
      super_on_top: false,
      changed: false,
      setting: null,
    };
  }
  const lastDay = addDays(from, -1);
  const floor = addDays(String(open.effective_from).slice(0, 10), -1);
  const { data: ended, error: endErr } = await client
    .from(TRADE_SUPER_BASIS_TABLE)
    .update({
      effective_to: lastDay < floor ? floor : lastDay,
      ended_by: actor,
      ended_at: new Date().toISOString(),
    })
    .eq("id", open.id)
    .is("effective_to", null)
    .select(SETTING_COLUMNS)
    .maybeSingle();
  if (endErr || !ended?.id) {
    throw new TradeSuperBasisError(
      "trade_super_basis_not_saved",
      "Super on top could not be turned off. Nothing was changed.",
      503,
    );
  }
  return {
    success: true,
    user_id: userId,
    super_on_top: false,
    changed: true,
    setting: ended,
  };
}
