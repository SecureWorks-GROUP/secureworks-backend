// Never a second draft bill for one trade invoice (B13, 6 Nov 2026).
//
// Every trade bill create sends an Idempotency-Key, but Xero keeps those only
// for a short time. A create whose reply was lost (a timeout, a worker limit)
// stores no bill id, so a later office retry used to create a second draft
// bill for the same invoice. Before any create, look in Xero for a live bill
// with this invoice's exact bill number:
// - none (or only bills already stored on another trade invoice): create;
// - exactly one, for the same supplier: reuse it, no create;
// - more than one, or one for a different supplier: refuse and leave it for
//   the office, because creating would make a duplicate and reusing would be
//   a guess;
// - Xero cannot be searched: refuse. Nothing is created on a failed check.
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";
import { xeroOptionalContains } from "./xero_where_clause.ts";
import { recordTradeInvoiceEvent } from "./trade_invoice_events.ts";

type Row = Record<string, any>;

export type XeroGet = (
  path: string,
  accessToken: string,
  tenantId: string,
  params?: Record<string, string>,
) => Promise<any>;

export class TradeXeroBillSearchError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** Bills that are, or can still become, payable. VOIDED and DELETED bills are
 * finished and never block or get reused. */
export const LIVE_TRADE_BILL_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "AUTHORISED",
  "PAID",
] as const;

function xeroStringLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function existingTradeBillWhere(invoiceNumber: string): string {
  return `Type=="ACCPAY" AND InvoiceNumber=="${xeroStringLiteral(invoiceNumber)}"`;
}

export interface ExistingTradeBillSearch {
  tradeInvoiceId: string;
  invoiceNumber: string;
  contactId: string | null;
}

export async function findExistingTradeXeroBill(
  client: any,
  xeroGet: XeroGet,
  auth: { accessToken: string; tenantId: string },
  search: ExistingTradeBillSearch,
): Promise<Row | null> {
  const number = String(search.invoiceNumber || "").trim();
  if (!number) {
    throw new TradeXeroBillSearchError(
      409,
      "xero_bill_number_missing",
      "This bill has no number to check in Xero, so it was not created.",
    );
  }
  let listed: any;
  try {
    listed = await xeroGet("/Invoices", auth.accessToken, auth.tenantId, {
      where: existingTradeBillWhere(number),
      Statuses: LIVE_TRADE_BILL_STATUSES.join(","),
      page: "1",
    });
  } catch (e) {
    if (e instanceof XeroCooldownError) throw e;
    throw new TradeXeroBillSearchError(
      503,
      "xero_existing_bill_search_failed",
      "Xero could not be checked for an existing bill, so no new bill was created. Try again shortly.",
    );
  }
  if (!listed || !Array.isArray(listed.Invoices)) {
    throw new TradeXeroBillSearchError(
      503,
      "xero_existing_bill_search_failed",
      "Xero could not be checked for an existing bill, so no new bill was created. Try again shortly.",
    );
  }
  const candidates: Row[] = listed.Invoices.filter((bill: Row) =>
    bill?.Type === "ACCPAY" &&
    String(bill.InvoiceNumber ?? "").trim() === number &&
    (LIVE_TRADE_BILL_STATUSES as readonly string[]).includes(String(bill.Status || "").toUpperCase()) &&
    bill.InvoiceID
  );
  if (candidates.length === 0) return null;

  const ids = candidates.map((bill) => String(bill.InvoiceID));
  const { data: owners, error } = await client.from("trade_invoices")
    .select("id, xero_bill_id")
    .in("xero_bill_id", ids);
  if (error) {
    throw new TradeXeroBillSearchError(
      503,
      "xero_existing_bill_search_failed",
      "Stored bills could not be read, so no new bill was created. Try again shortly.",
    );
  }
  const ownedElsewhere = new Set(
    (owners || [])
      .filter((row: Row) => String(row.id) !== String(search.tradeInvoiceId))
      .map((row: Row) => String(row.xero_bill_id)),
  );
  const unowned = candidates.filter((bill) => !ownedElsewhere.has(String(bill.InvoiceID)));
  if (unowned.length === 0) return null;
  if (unowned.length > 1) {
    throw new TradeXeroBillSearchError(
      409,
      "xero_existing_bill_ambiguous",
      "Xero already has more than one live bill with this number. Nothing new was created. The office needs to check those bills in Xero.",
    );
  }
  const [match] = unowned;
  const contactId = search.contactId ? String(search.contactId) : null;
  if (contactId && String(match.Contact?.ContactID || "") !== contactId) {
    throw new TradeXeroBillSearchError(
      409,
      "xero_existing_bill_other_supplier",
      "Xero already has a live bill with this number for a different supplier. Nothing new was created. The office needs to check it in Xero.",
    );
  }
  // The list may omit lines; read the full bill the split check needs.
  let full: any;
  try {
    full = await xeroGet(
      `/Invoices/${encodeURIComponent(String(match.InvoiceID))}`,
      auth.accessToken,
      auth.tenantId,
      { unitdp: "4" },
    );
  } catch (e) {
    if (e instanceof XeroCooldownError) throw e;
    full = null;
  }
  const bill = full?.Invoices?.length === 1 ? full.Invoices[0] : null;
  if (!bill || String(bill.InvoiceID) !== String(match.InvoiceID)) {
    throw new TradeXeroBillSearchError(
      503,
      "xero_existing_bill_search_failed",
      "An existing Xero bill was found but could not be read, so no new bill was created. Try again shortly.",
    );
  }
  return bill;
}

/** Create the trade bill, unless Xero already holds it. Returns what the PUT
 * would have: `{ Invoices: [bill] }`. */
export async function createOrReuseTradeXeroBill(
  client: any,
  deps: { xeroGet: XeroGet; putBill: (payload: Row, idempotencyKey: string) => Promise<any> },
  args: {
    accessToken: string;
    tenantId: string;
    tradeInvoiceId: string;
    payload: Row;
    idempotencyKey: string;
    actor: string;
  },
): Promise<{ result: any; reused: boolean }> {
  const header = args.payload?.Invoices?.[0] || {};
  const existing = await findExistingTradeXeroBill(client, deps.xeroGet, args, {
    tradeInvoiceId: args.tradeInvoiceId,
    invoiceNumber: String(header.InvoiceNumber || ""),
    contactId: header.Contact?.ContactID ? String(header.Contact.ContactID) : null,
  });
  if (existing) {
    await recordTradeInvoiceEvent(client, {
      trade_invoice_id: args.tradeInvoiceId,
      event_type: "xero_bill_reused",
      actor: args.actor,
      reason: "A live Xero bill with this invoice's number already existed, so no second bill was created.",
      detail: {
        xero_bill_id: String(existing.InvoiceID),
        xero_bill_status: String(existing.Status || ""),
      },
    });
    return { result: { Invoices: [existing] }, reused: true };
  }
  return { result: await deps.putBill(args.payload, args.idempotencyKey), reused: false };
}

/** Where a trade bill carrying this invoice number in its Reference sits. */
export function tradeBillReferenceWhere(invoiceNumber: string): string {
  return `Type=="ACCPAY" AND ${xeroOptionalContains("Reference", xeroStringLiteral(invoiceNumber))}`;
}

/** Live Xero trade bills that may already be this invoice's bill, found by
 * its number (as the bill number, or inside the bill Reference). Used before
 * the office releases an invoice with no saved bill id: a create whose reply
 * was lost leaves a bill in Xero and nothing here. Any failure to search
 * throws, so the caller refuses rather than releasing on a guess. */
export async function findLiveTradeBillsByNumber(
  xeroGet: XeroGet,
  auth: { accessToken: string; tenantId: string },
  invoiceNumber: string,
): Promise<Row[]> {
  const number = String(invoiceNumber || "").trim();
  if (!number) {
    throw new TradeXeroBillSearchError(
      409,
      "xero_bill_number_missing",
      "This invoice has no number to check in Xero.",
    );
  }
  const found = new Map<string, Row>();
  for (const where of [existingTradeBillWhere(number), tradeBillReferenceWhere(number)]) {
    let listed: any;
    try {
      listed = await xeroGet("/Invoices", auth.accessToken, auth.tenantId, {
        where,
        Statuses: LIVE_TRADE_BILL_STATUSES.join(","),
        page: "1",
      });
    } catch (_e) {
      listed = null;
    }
    if (!listed || !Array.isArray(listed.Invoices)) {
      throw new TradeXeroBillSearchError(
        503,
        "xero_existing_bill_search_failed",
        "Xero could not be checked for a bill for this invoice. Try again shortly.",
      );
    }
    for (const bill of listed.Invoices as Row[]) {
      const status = String(bill?.Status || "").toUpperCase();
      if (
        bill?.Type === "ACCPAY" && bill.InvoiceID &&
        (LIVE_TRADE_BILL_STATUSES as readonly string[]).includes(status) &&
        (String(bill.InvoiceNumber ?? "").trim() === number ||
          String(bill.Reference ?? "").includes(number))
      ) {
        found.set(String(bill.InvoiceID), bill);
      }
    }
  }
  return [...found.values()];
}
