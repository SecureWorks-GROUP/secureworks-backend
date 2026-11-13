// The office's rate rule for trade invoice extras lines (B14, 6 Nov 2026).
//
// An extras line is one the trade typed: its rate is the trade's word. Before
// this, a line whose client claimed a server rate skipped the "client rate"
// note, and every typed rate went straight to a Xero draft. Now:
// - only a line the server priced itself is server_resolved; every other
//   extras line is client_entered, whatever the client says;
// - a client_entered rate above the office's limit holds the line for office
//   review (office_review_status 'awaiting'), which holds the whole invoice
//   out of Xero until the office approves the line;
// - the limit is the office's row for that line type, else the office's '*'
//   row, else, for a line that bills hours, the trade's own dated hourly rate;
// - when the office rules cannot be read, every typed rate is held.
// Limits live only in trade_invoice_extra_rate_rules, never in code.
import { isTradeInvoiceTimeLineType } from "./trade_invoice_time_entry.ts";

type Row = Record<string, any>;

export interface ExtraRateRule {
  line_type: string;
  max_unit_rate_ex: number;
}

export type ExtraRateRules =
  | { ok: true; rules: ExtraRateRule[] }
  | { ok: false };

export type ExtraRateCapSource = "office_rule" | "office_default" | "trade_rate";

export interface ExtraRateCap {
  cap: number;
  source: ExtraRateCapSource;
}

export interface ExtraRateHold {
  held: true;
  cap: number | null;
  source: ExtraRateCapSource | "rules_unreadable" | "no_trade_rate";
  note: string;
}

export function extraRateRuleKey(lineType: unknown): string {
  return String(lineType ?? "").trim().toLowerCase();
}

export async function loadExtraRateRules(client: any): Promise<ExtraRateRules> {
  try {
    const { data, error } = await client.from("trade_invoice_extra_rate_rules")
      .select("line_type, max_unit_rate_ex");
    if (error) return { ok: false };
    return {
      ok: true,
      rules: (data || [])
        .map((row: Row) => ({
          line_type: extraRateRuleKey(row.line_type),
          max_unit_rate_ex: Number(row.max_unit_rate_ex),
        }))
        .filter((rule: ExtraRateRule) => rule.line_type && Number.isFinite(rule.max_unit_rate_ex) && rule.max_unit_rate_ex > 0),
    };
  } catch {
    return { ok: false };
  }
}

export function extraLineRateCap(
  lineType: unknown,
  rules: readonly ExtraRateRule[],
  tradeHourlyRate: number | null,
): ExtraRateCap | null {
  const key = extraRateRuleKey(lineType);
  const own = rules.find((rule) => rule.line_type === key);
  if (own) return { cap: own.max_unit_rate_ex, source: "office_rule" };
  const fallback = rules.find((rule) => rule.line_type === "*");
  if (fallback) return { cap: fallback.max_unit_rate_ex, source: "office_default" };
  if (isTradeInvoiceTimeLineType(lineType) && tradeHourlyRate != null && tradeHourlyRate > 0) {
    return { cap: tradeHourlyRate, source: "trade_rate" };
  }
  return null;
}

/** Whether a trade-typed rate is held. Null means it may go on as before. */
export function extraLineRateHold(input: {
  lineType: unknown;
  rate: number;
  serverResolved: boolean;
  rules: ExtraRateRules;
  tradeHourlyRate: number | null;
}): ExtraRateHold | null {
  if (input.serverResolved) return null;
  const rate = Number(input.rate);
  // A deduction or a zero line asks for no money.
  if (!Number.isFinite(rate) || rate <= 0) return null;
  if (!input.rules.ok) {
    return {
      held: true,
      cap: null,
      source: "rules_unreadable",
      note: "Typed rate held for office review: the office rate limits could not be read.",
    };
  }
  const cap = extraLineRateCap(input.lineType, input.rules.rules, input.tradeHourlyRate);
  if (!cap) return null;
  if (Math.round(rate * 100) <= Math.round(cap.cap * 100)) return null;
  return {
    held: true,
    cap: cap.cap,
    source: cap.source,
    note: cap.source === "trade_rate"
      ? "Typed rate is above this trade's pay rate. Held for office review."
      : "Typed rate is above the office limit for this line type. Held for office review.",
  };
}

// ── A rate typed on a job card (Marnin, 13 Nov 2026) ────────────────────────
// Behind trade_rate_editable_v1 a trade may type their hourly rate on a job
// card of the weekly invoice (`manual_assignments`), not only on an extras
// line. The same office limit decides whether the line is held.

/** Job cards are saved as labour lines; that is the line type the limit is read for. */
export const JOB_CARD_RATE_LINE_TYPE = "labour";

/**
 * The rate a trade typed on a job card, or null. The trade app posts `rate` on
 * every card and says whether the trade changed it in `rate_source`; only a
 * positive number posted as `client_entered` is a typed rate. Anything else
 * (missing, zero, not a number, `server_resolved`) is the office rate's job.
 */
export function typedJobCardRate(card: Row | null | undefined): number | null {
  if (!card || String(card.rate_source || "") !== "client_entered") return null;
  if (typeof card.rate !== "number" && typeof card.rate !== "string") return null;
  if (typeof card.rate === "string" && !card.rate.trim()) return null;
  const rate = Number(card.rate);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return Math.round(rate * 100) / 100;
}

/**
 * Whether a rate typed on a job card is held for office review. At or below
 * the trade's own office rate it never is. Above it, the extras rule decides
 * (the office's row for labour, else its `*` row, else the trade's own rate).
 * A trade with no office rate on file is always held.
 */
export function jobCardTypedRateHold(input: {
  rate: number;
  rules: ExtraRateRules;
  tradeHourlyRate: number | null;
}): ExtraRateHold | null {
  const rate = Number(input.rate);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const own = input.tradeHourlyRate != null && input.tradeHourlyRate > 0 ? input.tradeHourlyRate : null;
  if (own !== null && Math.round(rate * 100) <= Math.round(own * 100)) return null;
  const hold = extraLineRateHold({
    lineType: JOB_CARD_RATE_LINE_TYPE,
    rate,
    serverResolved: false,
    rules: input.rules,
    tradeHourlyRate: own,
  });
  if (hold) return hold;
  if (own === null) {
    return {
      held: true,
      cap: null,
      source: "no_trade_rate",
      note: "Typed rate with no pay rate on file for this trade. Held for office review.",
    };
  }
  return null;
}

export class ExtraRateRuleError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function listExtraRateRules(
  client: any,
  actor: { staff: boolean },
): Promise<Row> {
  if (!actor.staff) {
    throw new ExtraRateRuleError(403, "operator_access_required", "An authorised operator session is required.");
  }
  const { data, error } = await client.from("trade_invoice_extra_rate_rules")
    .select("line_type, max_unit_rate_ex, note, updated_by, updated_at")
    .order("line_type", { ascending: true });
  if (error) {
    throw new ExtraRateRuleError(503, "rules_unreadable", "The rate limits could not be read.");
  }
  return { rules: data || [] };
}

/** Set or clear one limit. `max_unit_rate_ex: null` removes the row. */
export async function setExtraRateRule(
  client: any,
  body: Row,
  actor: { staff: boolean; userId: string | null },
): Promise<Row> {
  if (!actor.staff) {
    throw new ExtraRateRuleError(403, "operator_access_required", "An authorised operator session is required.");
  }
  const lineType = extraRateRuleKey(body?.line_type);
  if (!lineType) {
    throw new ExtraRateRuleError(400, "line_type_required", "Name the line type, or * for every other type.");
  }
  if (body?.max_unit_rate_ex === null) {
    const { error } = await client.from("trade_invoice_extra_rate_rules")
      .delete().eq("line_type", lineType);
    if (error) throw new ExtraRateRuleError(503, "rule_write_failed", "The rate limit was not removed.");
    return { ok: true, line_type: lineType, removed: true };
  }
  const max = Number(body?.max_unit_rate_ex);
  if (!Number.isFinite(max) || max <= 0 || max > 100000) {
    throw new ExtraRateRuleError(400, "invalid_rate", "Give a limit above 0.");
  }
  const row = {
    line_type: lineType,
    max_unit_rate_ex: Math.round(max * 100) / 100,
    note: typeof body?.note === "string" ? body.note.trim().slice(0, 500) || null : null,
    updated_by: actor.userId,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await client.from("trade_invoice_extra_rate_rules")
    .upsert(row, { onConflict: "line_type" })
    .select("line_type, max_unit_rate_ex, note, updated_by, updated_at")
    .maybeSingle();
  if (error) throw new ExtraRateRuleError(503, "rule_write_failed", "The rate limit was not saved.");
  return { ok: true, rule: data || row };
}
