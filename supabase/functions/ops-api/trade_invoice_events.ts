// One writer for trade_invoice_events (migration 20261106163712): the
// append-only record of what the system or the office did to a trade invoice
// outside the normal submit flow. Ids, codes and plain reasons only, never a
// rate, an amount or a person's name in `reason`.
//
// Since 20261111194500 it also records a trade invoice submit the server
// refused or that failed (`submit_refused`): who, which door, which week, and
// the code and message the trade was shown. See tradeSubmitRefusedEvent.

export type TradeInvoiceEventType =
  | "voided_bill_released"
  | "stuck_invoice_resolved"
  | "xero_bill_reused"
  | "extra_rate_held"
  | "submit_refused";

export interface TradeInvoiceEvent {
  /** Empty only on `submit_refused`: a refused submit usually never became an invoice. */
  trade_invoice_id: string | null;
  event_type: TradeInvoiceEventType;
  actor: string;
  reason?: string | null;
  detail?: Record<string, unknown>;
}

/** Record one event. Returns false, and logs, when the write fails: the
 * action it describes has already happened and its proof is on the invoice. */
export async function recordTradeInvoiceEvent(
  client: any,
  event: TradeInvoiceEvent,
): Promise<boolean> {
  try {
    const { error } = await client.from("trade_invoice_events").insert({
      trade_invoice_id: event.trade_invoice_id,
      event_type: event.event_type,
      actor: String(event.actor || "unknown").slice(0, 200),
      reason: event.reason ? String(event.reason).slice(0, 500) : null,
      detail: event.detail ?? {},
    });
    if (error) {
      console.error(
        `[trade_invoice_events] ${event.event_type} for ${event.trade_invoice_id} not recorded: ${error.message}`,
      );
      return false;
    }
    return true;
  } catch (e) {
    console.error(
      `[trade_invoice_events] ${event.event_type} for ${event.trade_invoice_id} not recorded: ${(e as Error).message}`,
    );
    return false;
  }
}

/** The two doors a trade submits an invoice through. */
export const TRADE_SUBMIT_ACTIONS: ReadonlySet<string> = new Set([
  "generate_trade_invoice",
  "submit_trade_invoice",
]);

export interface TradeSubmitRefusal {
  /** The ops-api action the trade called. */
  action: string;
  /** The signed-in trade's user id. */
  userId: string;
  /** The HTTP status the trade was answered with. */
  status: number;
  /** What the trade posted. Only the week and the draft id are read from it. */
  requestBody?: unknown;
  /** What the trade was told. Only the code, the message and an invoice id are read from it. */
  responseBody?: unknown;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Za-z0-9_.-]{1,80}$/;

function isoDay(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim().slice(0, 10) : "";
  return ISO_DAY.test(text) ? text : null;
}

function uuid(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return UUID.test(text) ? text.toLowerCase() : null;
}

/** The sentence the trade was shown, with any dollar amount taken out. */
function refusalMessage(body: Record<string, unknown>): string | null {
  const raw = [body.userMessage, body.error, body.message]
    .find((value) => typeof value === "string" && value.trim() !== "");
  if (typeof raw !== "string") return null;
  return raw
    .replace(/\$\s?\d[\d,]*(\.\d+)?/g, "[amount]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/**
 * The one event a refused or failed trade invoice submit leaves behind, or
 * null when there is nothing to record (the submit went through, or nobody is
 * signed in). Pure.
 *
 * It copies named fields only. The request carries the trade's lines, hours
 * and extras, and a refusal can carry the money of the week's existing
 * invoice: none of that is read, so no bank detail, rate or pay figure can
 * reach the record. The database check on `submit_refused` refuses those keys
 * as a second line.
 */
export function tradeSubmitRefusedEvent(
  refusal: TradeSubmitRefusal,
): TradeInvoiceEvent | null {
  const action = String(refusal.action || "");
  const userId = String(refusal.userId || "").trim();
  const status = Number(refusal.status);
  if (!TRADE_SUBMIT_ACTIONS.has(action) || !userId) return null;
  if (!Number.isFinite(status) || status < 400) return null;

  const request = refusal.requestBody && typeof refusal.requestBody === "object"
    ? refusal.requestBody as Record<string, unknown>
    : {};
  const response =
    refusal.responseBody && typeof refusal.responseBody === "object"
      ? refusal.responseBody as Record<string, unknown>
      : {};

  const code = typeof response.code === "string" && CODE.test(response.code)
    ? response.code
    : `http_${status}`;
  const detail: Record<string, unknown> = {
    action,
    user_id: userId,
    http_status: status,
    code,
  };
  const message = refusalMessage(response);
  if (message) detail.message = message;
  const weekStart = isoDay(request.week_start);
  const weekEnd = isoDay(request.week_ending) ?? isoDay(request.week_end);
  if (weekStart) detail.week_start = weekStart;
  if (weekEnd) detail.week_end = weekEnd;
  const draftId = uuid(request.draft_id);
  if (draftId) detail.draft_id = draftId;

  return {
    // The week's existing invoice, when the refusal named one.
    trade_invoice_id: uuid(response.invoice_id),
    event_type: "submit_refused",
    actor: `trade:${userId}`,
    reason: code,
    detail,
  };
}

/** Record a refused or failed trade invoice submit. Never throws: the trade's
 * answer is already decided and must not change because the record failed. */
export async function recordTradeSubmitRefused(
  client: any,
  refusal: TradeSubmitRefusal,
): Promise<boolean> {
  const event = tradeSubmitRefusedEvent(refusal);
  if (!event) return false;
  return await recordTradeInvoiceEvent(client, event);
}
