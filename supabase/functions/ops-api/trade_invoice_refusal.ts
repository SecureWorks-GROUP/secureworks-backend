// A trade invoice route never answers with a raw database or server sentence.
//
// The trade invoice doors (weekly invoice, work-order invoice, saved drafts,
// group hours and shares) save through database functions whose guards raise
// exceptions. Before this module those refusals reached the trade as an HTTP
// 500 carrying the internal text ("work-order invoice source is no longer
// complete in the selected business date"), and the trade retried the same
// press. A guard refusal is the trade's answer, not a server fault: it is a
// 409 with a short reason the trade can act on, plus a stable code. Anything
// that is not a recognised refusal is still a plain sentence; the internal
// detail goes only to the function log.

import {
  JOB_LABOUR_CAP_EXCEEDED,
  JOB_LABOUR_CAP_TRADE_MESSAGE,
  JOB_LABOUR_CAP_UNREADABLE,
  JOB_LABOUR_CAP_UNREADABLE_TRADE_MESSAGE,
} from "./job_labour_cap.ts";

/** Every action that reads or writes a trade's own invoice or pay claim. */
export const TRADE_INVOICE_ROUTE_ACTIONS: ReadonlySet<string> = new Set([
  "generate_trade_invoice",
  "submit_trade_invoice",
  "submit_work_order_invoice",
  "save_trade_invoice_draft",
  "save_running_invoice_draft",
  "sync_running_invoice_draft",
  "get_running_invoice_draft",
  "delete_trade_invoice",
  "acknowledge_invoice_line",
  "my_trade_invoices",
  "get_trade_invoice",
  "my_invoices",
  "my_hours",
  "my_work_orders",
  "my_money",
  "log_my_job_hours",
  "submit_group_work_order_hours",
  "delete_group_work_order_hours",
  "my_group_work_orders",
  "group_work_order_my_share",
  "freeze_group_work_order",
  "sign_group_work_order",
  "join_group_work_order",
  "create_group_work_order",
]);

/** An error that keeps the database's SQLSTATE next to the old message. */
export class TradeInvoiceStoreError extends Error {
  pgCode: string | null;
  constructor(message: string, pgCode: unknown) {
    super(message);
    this.name = "TradeInvoiceStoreError";
    this.pgCode = pgCode == null || pgCode === "" ? null : String(pgCode);
  }
}

export type TradeInvoiceRefusal = {
  status: number;
  body: { ok: false; error: string; code: string };
};

// Known guard texts, most specific first. Each answer says what happened and
// what the trade can do next, in trade words.
const KNOWN_REFUSALS: ReadonlyArray<
  { match: RegExp; code: string; error: string; status?: number }
> = [
  {
    // Ruling 17 step 4: the database's labour cap (job_labour_cap.ts). No
    // figure: the maximum is the office's.
    match: new RegExp(JOB_LABOUR_CAP_EXCEEDED),
    code: JOB_LABOUR_CAP_EXCEEDED,
    error: JOB_LABOUR_CAP_TRADE_MESSAGE,
  },
  {
    match: new RegExp(JOB_LABOUR_CAP_UNREADABLE),
    code: JOB_LABOUR_CAP_UNREADABLE,
    error: JOB_LABOUR_CAP_UNREADABLE_TRADE_MESSAGE,
  },
  {
    match: /work-order invoice source is no longer complete/i,
    code: "work_order_not_complete",
    error:
      "This work order is not marked complete with a finish date, so it cannot be invoiced yet. Ask the office to mark it complete, or bill your hours for this job on your Weekly Invoice for the week you worked it. Nothing was saved.",
  },
  {
    match: /work-order invoice source scope changed/i,
    code: "work_order_changed",
    error:
      "This work order changed while you were invoicing. Reload and check it before you try again. Nothing was saved.",
  },
  {
    match: /work-order invoice source does not belong/i,
    code: "work_order_not_found",
    error:
      "This work order is no longer on that job. Reload and try again. Nothing was saved.",
  },
  {
    match: /no longer owns or manages|no longer an active tenant user/i,
    code: "not_your_work",
    error:
      "This work is no longer allocated to you, so you cannot invoice it. Ask the office if you think that is wrong. Nothing was saved.",
    status: 403,
  },
  {
    match: /already held by another invoice|can only be deducted once/i,
    code: "already_on_another_invoice",
    error:
      "Some of this work is already on another invoice. Reload to see what is left to bill. Nothing was saved.",
  },
  {
    match: /multiple (weekly|work-order) drafts need office review/i,
    code: "drafts_need_office_review",
    error:
      "There is more than one saved draft for this. Ask the office to tidy them up, then try again. Nothing was saved.",
  },
  {
    match:
      /prior trade invoice (changed|is not a replaceable draft)|replacement trade invoice is not locally owned/i,
    code: "draft_changed",
    error:
      "Your saved draft changed while you were working on it. Reload and try again. Nothing was saved.",
  },
  {
    match: /line total does not match/i,
    code: "line_total_mismatch",
    error:
      "A line total did not add up. Reload and try again. Nothing was saved.",
  },
  {
    match: /group_split_frozen/i,
    code: "group_split_frozen",
    error:
      "The group shares are already finalised, so hours cannot change. Ask the office to reopen the split if something is wrong.",
  },
  {
    match: /group_split_busy/i,
    code: "group_split_busy",
    error: "Someone else on the crew is saving right now. Try again in a moment.",
  },
];

// SQLSTATE classes our guards raise: data exception (22), integrity (23),
// insufficient privilege (42501), raise_exception (P0001), no data (P0002).
// Serialization and deadlock (40001, 40P01) are a busy answer, not a fault.
function sqlStateIsRefusal(code: string | null): boolean {
  if (!code) return false;
  return /^2[23]/.test(code) || code === "42501" || code === "P0001" ||
    code === "P0002";
}

function sqlStateIsBusy(code: string | null): boolean {
  return code === "40001" || code === "40P01";
}

function errorCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const record = err as Record<string, unknown>;
  const code = record.pgCode ?? record.code;
  return typeof code === "string" && code ? code : null;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || "";
  if (err && typeof err === "object") {
    return String((err as Record<string, unknown>).message || "");
  }
  return String(err ?? "");
}

// Words that mark a sentence as database or server internals rather than a
// sentence written for the trade.
const INTERNAL_TEXT =
  /failed to|violates|constraint|pgrst|relation|column|function|duplicate key|syntax|null value|invalid input|permission denied|jwt|\brpc\b|\bsql\b|undefined|exception|persist|postgrest|timeout|fetch/i;

/**
 * A plain `new Error('...')` the server wrote for the trade ("You are not
 * assigned to this job"). It keeps its words, as a 400 rather than a 500.
 * A TypeError or similar is a fault, never a trade sentence.
 */
function plainTradeSentence(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  if (Object.getPrototypeOf(err) !== Error.prototype) return null;
  const text = String(err.message || "").trim();
  if (!text || text.length > 200 || INTERNAL_TEXT.test(text)) return null;
  return text;
}

/**
 * The plain answer for a failure on a trade invoice route. Known guard text
 * and database refusal codes are a 4xx; a sentence written for the trade
 * keeps its words as a 400; anything else is a plain 500. The caller logs the
 * raw error; internal text never reaches the body.
 */
export function tradeInvoiceRefusal(err: unknown): TradeInvoiceRefusal {
  const text = errorText(err);
  const code = errorCode(err);
  for (const known of KNOWN_REFUSALS) {
    if (known.match.test(text)) {
      return {
        status: known.status ?? 409,
        body: { ok: false, error: known.error, code: known.code },
      };
    }
  }
  if (sqlStateIsBusy(code)) {
    return {
      status: 409,
      body: {
        ok: false,
        error: "The system was busy saving another change. Reload and try again in a moment.",
        code: "trade_invoice_busy",
      },
    };
  }
  if (sqlStateIsRefusal(code)) {
    return {
      status: 409,
      body: {
        ok: false,
        error:
          "The system could not accept this. Reload to see where it is up to, and tell the office if it keeps happening.",
        code: "trade_invoice_refused",
      },
    };
  }
  const sentence = code ? null : plainTradeSentence(err);
  if (sentence) {
    return {
      status: 400,
      body: { ok: false, error: sentence, code: "trade_invoice_refused" },
    };
  }
  return {
    status: 500,
    body: {
      ok: false,
      error:
        "Something went wrong on our side. Reload to see where it is up to, and tell the office if it keeps happening.",
      code: "trade_invoice_error",
    },
  };
}
