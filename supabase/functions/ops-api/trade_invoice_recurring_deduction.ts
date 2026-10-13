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
//   - One row a week: when two active rows of a trade cover the same week,
//     none is taken and the invoice is marked for the office.
//   - Once per invoice week: when another live invoice of the same trade and
//     week already carries it, this one carries none. A draft, a failed and an
//     ops-reject invoice are released and never hold the week.
//   - Never a negative invoice: when the amount payable is less than the
//     deduction, nothing is refused and nothing is taken; the invoice is
//     marked for the office with the plain reason. An invoice with nothing
//     payable yet (an empty preview or draft) is not marked.
//   - A submitted invoice with no invoice week, and a work-order invoice,
//     carry none; when the trade has a deduction that week the invoice is
//     marked for the office so the skip is never silent.
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

// A submitted invoice that has no invoice week: why, and the day it is for.
// The week that day falls in is the week checked for a deduction.
export type TradeRecurringDeductionWeekless = {
  kind: "no_invoice_week" | "work_order_invoice";
  day: unknown;
};

export type TradeRecurringDeductionOutcome =
  // no rule covers this trade and invoice week
  | "none"
  // taken on this invoice
  | "applied"
  // a rule covers the week, but another live invoice already carries it
  | "already_taken"
  // a rule covers the week, but the amount payable is less than it
  | "payable_below_deduction"
  // a rule covers the week, but nothing is payable on this invoice yet
  | "nothing_payable"
  // two active rows cover the week: none is taken
  | "rules_overlap"
  // the trade has a rule that week, but this invoice has no invoice week
  | "no_invoice_week"
  // the trade has a rule that week, but this is a work-order invoice
  | "work_order_invoice";

export type TradeRecurringDeductionDecision = {
  outcome: TradeRecurringDeductionOutcome;
  // The one rule covering this invoice's week, whether or not it was taken.
  // null when no single rule does, or the invoice has no invoice week.
  rule: (TradeInvoiceRecurringDeduction & { week_start: string }) | null;
  // What this invoice carries. null unless outcome is "applied".
  applied: TradeInvoiceRecurringDeduction | null;
  // The plain reason for the office when a deduction was due and not taken.
  // null otherwise.
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
const namedRules = (rules: TradeRecurringDeductionRule[]): string =>
  rules.map((rule) => `${rule.label} ${moneyLabel(rule.amount)}`).join(", ");

function dateOnly(value: unknown): string | null {
  const text = String(value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === text ? text : null;
}

// The Monday of the invoice week a day falls in.
function weekStartOf(value: unknown): string | null {
  const day = dateOnly(value);
  if (!day) return null;
  const monday = new Date(`${day}T00:00:00.000Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

/**
 * The rule rows covering this trade and invoice week. Rows that are switched
 * off, belong to another trade, or whose weeks do not include this one are
 * left out. One row is the rule; more than one is a fault in the rows and is
 * never resolved by picking one.
 */
export function tradeRecurringDeductionRulesCovering(
  rules: unknown,
  userId: unknown,
  weekStart: unknown,
): TradeRecurringDeductionRule[] {
  const week = dateOnly(weekStart);
  const trade = String(userId ?? "").trim();
  if (!week || !trade || !Array.isArray(rules)) return [];

  const covering: TradeRecurringDeductionRule[] = [];
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
    covering.push({
      id,
      user_id: trade,
      label,
      amount,
      first_week_start: first,
      last_week_start: last,
      active: true,
    });
  }
  return covering;
}

// A submitted invoice with no invoice week carries none. When the trade has a
// deduction in the week the invoice is for, it is marked for the office.
function decideWeeklessTradeRecurringDeduction(
  rules: unknown,
  userId: unknown,
  weekless: TradeRecurringDeductionWeekless | null | undefined,
): TradeRecurringDeductionDecision {
  const week = weekless ? weekStartOf(weekless.day) : null;
  if (!weekless || !week) return NO_DEDUCTION;
  const covering = tradeRecurringDeductionRulesCovering(rules, userId, week);
  if (covering.length === 0) return NO_DEDUCTION;
  return {
    outcome: weekless.kind,
    rule: null,
    applied: null,
    note: `Weekly deduction ${namedRules(covering)} NOT applied: ${
      weekless.kind === "work_order_invoice"
        ? "this is a work-order invoice"
        : "this invoice has no invoice week"
    }. Nothing was taken off. The office to check it is on the trade's weekly invoice for the week starting ${week}.`,
  };
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
  // Only for a submitted invoice with no invoice week. A draft passes none.
  weekless?: TradeRecurringDeductionWeekless | null;
}): TradeRecurringDeductionDecision {
  const week = dateOnly(input.weekStart);
  if (!week) {
    return decideWeeklessTradeRecurringDeduction(
      input.rules,
      input.userId,
      input.weekless,
    );
  }
  const rules = tradeRecurringDeductionRulesCovering(
    input.rules,
    input.userId,
    week,
  );
  if (rules.length === 0) return NO_DEDUCTION;
  if (rules.length > 1) {
    return {
      outcome: "rules_overlap",
      rule: null,
      applied: null,
      note:
        `Weekly deduction NOT taken for the week starting ${week}: ${rules.length} active deductions cover that week for this trade (${
          namedRules(rules)
        }). Nothing was taken off. The office to leave one row covering the week and recover it another way.`,
    };
  }
  const rule = rules[0];

  const covering = {
    id: rule.id,
    label: rule.label,
    amount: rule.amount,
    week_start: week,
  };
  const holder = (Array.isArray(input.carriers) ? input.carriers : [])
    .map((raw) =>
      raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    )
    .find((row) => !RELEASED_INVOICE_STATUSES.has(String(row.status ?? "")));
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
  // An empty preview or a draft with nothing on it yet: nothing to take it
  // from and nothing for the office to chase.
  if (Number.isFinite(payable) && toCents(payable) === 0) {
    return {
      outcome: "nothing_payable",
      rule: covering,
      applied: null,
      note: null,
    };
  }
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
 * be read (a PostgREST error returns, it does not throw). An invoice with no
 * invoice week has nothing taken either way, so its submit never fails on the
 * read: the failure is logged and the invoice goes unmarked.
 */
export async function loadTradeRecurringDeductionDecision(
  // deno-lint-ignore no-explicit-any
  client: any,
  input: {
    userId: string;
    weekStart: string | null | undefined;
    payable: number;
    weekless?: TradeRecurringDeductionWeekless | null;
  },
): Promise<TradeRecurringDeductionDecision> {
  const week = dateOnly(input.weekStart);
  if (!input.userId || (!week && !input.weekless)) return NO_DEDUCTION;

  const rulesRead = await client.from("trade_recurring_deductions")
    .select(
      "id, user_id, label, amount, first_week_start, last_week_start, active",
    )
    .eq("user_id", input.userId)
    .eq("active", true) as QueryResult;
  if (rulesRead.error) {
    const message = "Failed to read the weekly deductions for this trade: " +
      (rulesRead.error.message || "unknown error");
    if (week) throw new Error(message);
    console.error("[ops-api] " + message);
    return NO_DEDUCTION;
  }
  const decided = decideTradeRecurringDeduction({
    rules: rulesRead.data,
    userId: input.userId,
    weekStart: week,
    payable: input.payable,
    weekless: input.weekless,
  });
  // The usual case, and every other trade's: no single rule for the week, no
  // second read.
  if (!week || !decided.rule) return decided;

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
 * why. null when no single rule covers the invoice's week.
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

/**
 * The office's note on a stored invoice, as a read returns it. The stored
 * query_note is rewritten as the invoice moves on (it is cleared once the Xero
 * bill reconciles), so a "not taken" reason kept only there is lost. The
 * invoice's own recurring_deduction_note is never rewritten: a read that
 * returns query_note carries the reason in it whatever the invoice's status.
 * An invoice with no such reason, and a read without query_note, come back
 * as they went in.
 */
export function withTradeRecurringDeductionOfficeNote<
  T extends Record<string, unknown>,
>(invoice: T): T {
  const reason = String(invoice.recurring_deduction_note ?? "").trim();
  if (!reason || !("query_note" in invoice)) return invoice;
  const stored = String(invoice.query_note ?? "").trim();
  if (stored.includes(reason)) return invoice;
  return {
    ...invoice,
    query_note: [stored, reason].filter(Boolean).join(" | "),
  };
}
