// deno-lint-ignore-file no-explicit-any
// The office submits a trade's invoice (owner, 20 Nov 2026: "Do it through
// the system, fix the system and do it."). ops-api office_generate_trade_invoice
// runs the trade's OWN submit path, generate_trade_invoice, as that trade: the
// same eligibility, money module, agreed work order check, time entry rules,
// duplicate locks and super split, so the office can bill nothing the trade
// could not bill. This module only decides who is asking, for which trade and
// why, and records that on the invoice's append-only event store.
//
// Who may ask: a signed-in staff person (admin, owner, ops_manager), or the
// server key naming one in actor_user_id. A trade's own session never may.
import { recordTradeInvoiceEvent } from "./trade_invoice_events.ts";

export const OFFICE_TRADE_INVOICE_ACTION = "office_generate_trade_invoice";

// The body keys this action adds to generate_trade_invoice's body. They are
// taken off before the trade's path reads the body, so that path sees exactly
// what the trade's app would have sent.
export const OFFICE_TRADE_INVOICE_BODY_KEYS = [
  "trade_user_id",
  "actor_user_id",
  "reason",
] as const;

const STAFF_ROLES = new Set(["admin", "owner", "ops_manager"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class OfficeTradeInvoiceError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export type OfficeTradeInvoiceCaller = {
  authMode: string;
  serverSecretPresented: boolean;
  // The verified session's person (authMode jwt only).
  sessionUser: { id: string; orgId: string; role: string } | null;
};

export type OfficeTradeInvoiceTrade = {
  id: string;
  email: string;
  orgId: string;
  role: string;
  managedVerticals: unknown;
  seeEverything: boolean;
};

export type OfficeTradeInvoiceRequest = {
  trade: OfficeTradeInvoiceTrade;
  actorUserId: string;
  reason: string;
  via: "staff_session" | "server_key";
};

function isStaffRole(role: unknown): boolean {
  return STAFF_ROLES.has(String(role || "").trim().toLowerCase());
}

/** The reason, trimmed, 3 to 500 characters; null when it is not one. */
export function officeTradeInvoiceReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const reason = raw.trim();
  return reason.length >= 3 && reason.length <= 500 ? reason : null;
}

/**
 * Who is asking, for which trade, and why. Refuses (OfficeTradeInvoiceError)
 * before anything is read about the invoice:
 *  - 403 office_staff_only: not a staff session and not the server key;
 *  - 400 office_actor_required / 403 office_actor_not_staff: the server key
 *    must name an active staff person in the trade's company;
 *  - 400 office_reason_required;
 *  - 400 office_trade_required / 404 office_trade_not_found: the trade must be
 *    a person in the asking person's company.
 */
export async function resolveOfficeTradeInvoiceRequest(
  client: any,
  caller: OfficeTradeInvoiceCaller,
  body: Record<string, any>,
): Promise<OfficeTradeInvoiceRequest> {
  const staffSession = caller.authMode === "jwt" && !!caller.sessionUser &&
    isStaffRole(caller.sessionUser.role);
  const serverKey = caller.authMode === "api_key" &&
    caller.serverSecretPresented === true;
  if (!staffSession && !serverKey) {
    throw new OfficeTradeInvoiceError(
      403,
      "office_staff_only",
      "Only the office can submit an invoice for a trade.",
    );
  }

  let actor: { id: string; orgId: string };
  if (staffSession) {
    const named = body?.actor_user_id;
    if (named !== undefined && named !== null && named !== "" && String(named) !== caller.sessionUser!.id) {
      throw new OfficeTradeInvoiceError(
        403,
        "office_actor_not_caller",
        "A signed-in person submits as themselves.",
      );
    }
    actor = { id: caller.sessionUser!.id, orgId: caller.sessionUser!.orgId };
  } else {
    const named = String(body?.actor_user_id ?? "").trim();
    if (!UUID.test(named)) {
      throw new OfficeTradeInvoiceError(
        400,
        "office_actor_required",
        "Name the staff person this is done for (actor_user_id).",
      );
    }
    const { data, error } = await client.from("users")
      .select("id, org_id, role")
      .eq("id", named)
      .maybeSingle();
    if (error) {
      throw new OfficeTradeInvoiceError(
        503,
        "office_actor_unreadable",
        "The staff person could not be checked. Nothing was saved. Try again.",
      );
    }
    if (!data?.org_id || !isStaffRole(data.role)) {
      throw new OfficeTradeInvoiceError(
        403,
        "office_actor_not_staff",
        "The named person is not office staff.",
      );
    }
    actor = { id: String(data.id), orgId: String(data.org_id) };
  }

  const reason = officeTradeInvoiceReason(body?.reason);
  if (!reason) {
    throw new OfficeTradeInvoiceError(
      400,
      "office_reason_required",
      "Give a reason for submitting this invoice for the trade.",
    );
  }

  const tradeId = String(body?.trade_user_id ?? "").trim();
  if (!UUID.test(tradeId)) {
    throw new OfficeTradeInvoiceError(
      400,
      "office_trade_required",
      "Name the trade this invoice is for (trade_user_id).",
    );
  }
  const { data: trade, error: tradeError } = await client.from("users")
    .select("id, email, org_id, role, managed_verticals, trade_sees_all_jobs")
    .eq("id", tradeId)
    .maybeSingle();
  if (tradeError) {
    throw new OfficeTradeInvoiceError(
      503,
      "office_trade_unreadable",
      "The trade could not be read. Nothing was saved. Try again.",
    );
  }
  // Another company's person reads as not found, never as a different refusal.
  if (!trade?.id || !trade.org_id || String(trade.org_id) !== actor.orgId) {
    throw new OfficeTradeInvoiceError(
      404,
      "office_trade_not_found",
      "That trade could not be found.",
    );
  }

  return {
    trade: {
      id: String(trade.id),
      email: String(trade.email || ""),
      orgId: String(trade.org_id),
      role: String(trade.role || "unknown"),
      managedVerticals: trade.managed_verticals,
      seeEverything: trade.trade_sees_all_jobs === true,
    },
    actorUserId: actor.id,
    reason,
    via: staffSession ? "staff_session" : "server_key",
  };
}

/** The office's keys off; the rest of the body is the trade's submit. */
export function stripOfficeTradeInvoiceKeys(body: Record<string, any>): void {
  if (!body || typeof body !== "object") return;
  for (const key of OFFICE_TRADE_INVOICE_BODY_KEYS) delete body[key];
}

/**
 * One office_submitted event on each invoice the office's submit saved. The
 * invoice is saved before this runs, so a failed write never undoes it: the
 * write is tried twice, then logged under one searchable code
 * (office_trade_invoice_event_unrecorded) naming the invoice and the person.
 */
export async function recordOfficeTradeInvoiceSubmitted(
  client: any,
  invoiceId: string,
  request: OfficeTradeInvoiceRequest,
  detail: Record<string, unknown> = {},
): Promise<boolean> {
  const event = {
    trade_invoice_id: invoiceId,
    event_type: "office_submitted" as const,
    actor: `user:${request.actorUserId}`,
    reason: request.reason,
    detail: {
      trade_user_id: request.trade.id,
      via: request.via,
      ...detail,
    },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await recordTradeInvoiceEvent(client, event)) return true;
  }
  console.error(JSON.stringify({
    event: "office_trade_invoice_event_unrecorded",
    trade_invoice_id: invoiceId,
    actor_user_id: request.actorUserId,
    trade_user_id: request.trade.id,
  }));
  return false;
}
