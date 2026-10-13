// Trade recurring deductions (owner, 13 Oct 2026): a weekly amount that comes
// off one trade's weekly invoice. First use: "Ute hire", $100 for the invoice
// week starting Monday 12 Oct 2026 and $200 for every invoice week from Monday
// 19 Oct 2026, for the one trade named in table trade_recurring_deductions.
//
// This module is the one owner of WHICH invoice carries a deduction. The money
// itself (the payable, the Xero line) is trade_invoice_money.ts.
//
//   - The rule is data (trade_recurring_deductions): trade, label, amount,
//     first invoice week, optional last invoice week, on or off. No amount
//     lives in code.
//   - Only an invoice with an invoice week (week_start) carries one. An
//     invoice for a week before the rule's first week carries none.
//   - Once per invoice week: when another live invoice of the same trade and
//     week already carries it, this one carries none. A draft, a failed and an
//     ops-reject invoice are released and never hold the week.
//   - Never a negative invoice: when the amount payable is less than the
//     deduction, nothing is refused and nothing is taken; the invoice is
//     marked for the office with the plain reason.
//   - A trade with no row is untouched: no read of theirs changes shape and
//     nothing is written for them.
//
// Contract: docs/trade-recurring-deductions-2026-10-13.md.

import type { TradeInvoiceRecurringDeduction } from "./trade_invoice_money.ts";

// The released statuses, as RELEASED_INVOICE_STATUSES in index.ts and the
// once-per-week index in 20261013143700_trade_recurring_deductions.sql.
const RELEASED_INVOICE_STATUSES = new Set(["draft", "failed", "ops-reject"]);

export type TradeRecurringDeductionRule = {
  id: string;
  user_id: string;
  label: string;
  amount: number;
  first_week_start: string;
  last_week_start: string | null;
  active: boolean;
};

export type TradeRecurringDeductionOutcome =
  // no rule covers this trade and invoice week
  | "none"
  // taken on this invoice
  | "applied"
  // a rule covers the week, but another live invoice already carries it
  | "already_taken"
  // a rule covers the week, but the amount payable is less than it
  | "payable_below_deduction";

export type TradeRecurringDeductionDecision = {
  outcome: TradeRecurringDeductionOutcome;
  // The rule covering this trade and week, whether or not it was taken.
  rule: (TradeInvoiceRecurringDeduction & { week_start: string }) | null;
  // What this invoice carries. null unless outcome is "applied".
  applied: TradeInvoiceRecurringDeduction | null;
  // The plain reason for the office when a rule covered the week and was not
  // taken. null otherwise.
  note: string | null;
};

const NO_DEDUCTION: TradeRecurringDeductionDecision = {
  outcome: "none",
  rule: null,
  applied: null,
  note: null,
};

const moneyLabel = (value: number): string => `$${value.toFixed(2)}`;
const toCents = (value: number): number => Math.round(value * 100);

function dateOnly(value: unknown): string | null {
  const text = String(value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === text ? text : null;
}

/**
 * The one rule row covering this trade and invoice week, or null. Rows that
 * are switched off, belong to another trade, or whose weeks do not include
 * this one are ignored. Where two rows cover the week, the one whose first
 * week is later wins: the amount is changed by adding a row from the week it
 * changes, never by rewriting history.
 */
export function selectTradeRecurringDeductionRule(
  rules: unknown,
  userId: unknown,
  weekStart: unknown,
): TradeRecurringDeductionRule | null {
  const week = dateOnly(weekStart);
  const trade = String(userId ?? "").trim();
  if (!week || !trade || !Array.isArray(rules)) return null;

  let chosen: TradeRecurringDeductionRule | null = null;
  for (const raw of rules) {
    const row = raw && typeof raw === "object"
      ? raw as Record<string, unknown>
      : {};
    if (row.active !== true) continue;
    if (String(row.user_id ?? "") !== trade) continue;
    const id = String(row.id ?? "").trim();
    const label = String(row.label ?? "").replace(/\s+/g, " ").trim();
    const amount = Math.round(Number(row.amount) * 100) / 100;
    const first = dateOnly(row.first_week_start);
    const last = row.last_week_start === null ||
        row.last_week_start === undefined || row.last_week_start === ""
      ? null
      : dateOnly(row.last_week_start);
    // A row that cannot be read as a rule is never guessed at.
    if (!id || !label || !Number.isFinite(amount) || amount <= 0 || !first) {
      continue;
    }
    if (row.last_week_start && !last) continue;
    if (week < first) continue;
    if (last && week > last) continue;
    if (
      !chosen || first > chosen.first_week_start ||
      (first === chosen.first_week_start && id > chosen.id)
    ) {
      chosen = {
        id,
        user_id: trade,
        label,
        amount,
        first_week_start: first,
        last_week_start: last,
        active: true,
      };
    }
  }
  return chosen;
}

/**
 * Decide what one invoice carries. Pure: the caller supplies the rule rows,
 * the amount payable before any deduction (net pay + GST) and the other
 * invoices of the same trade and week that carry a deduction.
 */
export function decideTradeRecurringDeduction(input: {
  rules: unknown;
  userId: unknown;
  // The invoice's week_start. null or absent: the invoice has no invoice week.
  weekStart: unknown;
  // net pay + GST for this invoice, before any deduction.
  payable: unknown;
  // Other invoices of this trade and week carrying a deduction:
  // { id, status, invoice_number }. Released ones never hold the week.
  carriers?: unknown;
  // Invoices that are this same invoice (its own row on a retry, the draft it
  // replaces): never counted as "another" invoice.
  ownInvoiceIds?: unknown[];
}): TradeRecurringDeductionDecision {
  const week = dateOnly(input.weekStart);
  if (!week) return NO_DEDUCTION;
  const rule = selectTradeRecurringDeductionRule(
    input.rules,
    input.userId,
    week,
  );
  if (!rule) return NO_DEDUCTION;

  const covering = {
    id: rule.id,
    label: rule.label,
    amount: rule.amount,
    week_start: week,
  };
  const own = new Set(
    (input.ownInvoiceIds || []).map((id) => String(id ?? "")).filter(Boolean),
  );
  const holder = (Array.isArray(input.carriers) ? input.carriers : [])
    .map((raw) =>
      raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    )
    .find((row) =>
      !own.has(String(row.id ?? "")) &&
      !RELEASED_INVOICE_STATUSES.has(String(row.status ?? ""))
    );
  if (holder) {
    const named = String(holder.invoice_number ?? "").trim();
    return {
      outcome: "already_taken",
      rule: covering,
      applied: null,
      note: `${rule.label} ${
        moneyLabel(rule.amount)
      } not taken on this invoice: it is already on ${
        named ? `invoice ${named}` : "another invoice"
      } for the week starting ${week}.`,
    };
  }

  const payable = Number(input.payable);
  if (!Number.isFinite(payable) || toCents(payable) < toCents(rule.amount)) {
    return {
      outcome: "payable_below_deduction",
      rule: covering,
      applied: null,
      note: `${rule.label} ${
        moneyLabel(rule.amount)
      } NOT taken for the week starting ${week}: the amount payable on this invoice (${
        Number.isFinite(payable) ? moneyLabel(payable) : "unknown"
      }) is less than the deduction. Nothing was taken off. The office to recover it another way.`,
    };
  }

  return {
    outcome: "applied",
    rule: covering,
    applied: { id: rule.id, label: rule.label, amount: rule.amount },
    note: null,
  };
}

type QueryResult = {
  data: unknown;
  error: { message?: string } | null;
};

/**
 * Read the rule rows and this week's carriers, then decide. A failed read
 * throws: an invoice must never be saved in full because the rule could not
 * be read (a PostgREST error returns, it does not throw).
 */
export async function loadTradeRecurringDeductionDecision(
  // deno-lint-ignore no-explicit-any
  client: any,
  input: {
    userId: string;
    weekStart: string | null | undefined;
    payable: number;
    ownInvoiceIds?: Array<string | null | undefined>;
  },
): Promise<TradeRecurringDeductionDecision> {
  const week = dateOnly(input.weekStart);
  if (!week || !input.userId) return NO_DEDUCTION;

  const rulesRead = await client.from("trade_recurring_deductions")
    .select(
      "id, user_id, label, amount, first_week_start, last_week_start, active",
    )
    .eq("user_id", input.userId)
    .eq("active", true) as QueryResult;
  if (rulesRead.error) {
    throw new Error(
      "Failed to read the weekly deductions for this trade: " +
        (rulesRead.error.message || "unknown error"),
    );
  }
  // The usual case, and every other trade's: no row, no second read.
  if (!selectTradeRecurringDeductionRule(rulesRead.data, input.userId, week)) {
    return NO_DEDUCTION;
  }

  const carriersRead = await client.from("trade_invoices")
    .select("id, status, invoice_number")
    .eq("user_id", input.userId)
    .eq("week_start", week)
    .not("recurring_deduction_amount", "is", null) as QueryResult;
  if (carriersRead.error) {
    throw new Error(
      "Failed to check whether this week's deduction is already on an invoice: " +
        (carriersRead.error.message || "unknown error"),
    );
  }

  return decideTradeRecurringDeduction({
    rules: rulesRead.data,
    userId: input.userId,
    weekStart: week,
    payable: input.payable,
    carriers: carriersRead.data,
    ownInvoiceIds: input.ownInvoiceIds,
  });
}

/**
 * The four trade_invoices columns for a decision. An invoice with no rule
 * gets no keys at all, so its insert is byte for byte what it was.
 */
export function tradeRecurringDeductionInvoiceFields(
  decision: TradeRecurringDeductionDecision,
): Record<string, unknown> {
  if (decision.outcome === "none") return {};
  return {
    recurring_deduction_id: decision.applied?.id ?? null,
    recurring_deduction_label: decision.applied?.label ?? null,
    recurring_deduction_amount: decision.applied?.amount ?? null,
    recurring_deduction_note: decision.note,
  };
}

/**
 * What a response says about the week's deduction before and after submit:
 * the rule covering the week, whether this invoice carries it and, when not,
 * why. null when no rule covers the trade and week.
 */
export function tradeRecurringDeductionResponse(
  decision: TradeRecurringDeductionDecision,
): Record<string, unknown> {
  if (decision.outcome === "none" || !decision.rule) return {};
  return {
    recurring_deduction_week: {
      label: decision.rule.label,
      amount: decision.rule.amount,
      week_start: decision.rule.week_start,
      applied: decision.outcome === "applied",
      outcome: decision.outcome,
      note: decision.note,
    },
  };
}
