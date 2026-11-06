import type { GetTokenFn, XeroGetFn } from "./xero_accpay_books.ts";
import { isGroupShareLine } from "./group_work_order.ts";
import { recordTradeInvoiceEvent } from "./trade_invoice_events.ts";
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";

type Row = Record<string, any>;
export class VoidedTradeInvoiceReleaseError extends Error {
  constructor(public code: string, message: string, public status = 409) {
    super(message);
  }
}

function requireRelease(
  ok: unknown,
  code: string,
  message: string,
): asserts ok {
  if (!ok) throw new VoidedTradeInvoiceReleaseError(code, message);
}

/** Xero bill states that can never take another payment. A VOIDED bill was
 * authorised and then cancelled; a DELETED bill was a draft or submitted bill
 * that was removed. Never substitute a mirror status or an absent invoice.
 */
export const RELEASABLE_XERO_BILL_STATUSES = ["VOIDED", "DELETED"] as const;
export type ReleasableXeroBillStatus =
  typeof RELEASABLE_XERO_BILL_STATUSES[number];

/** Local invoice states a voided or deleted bill can release. */
const RELEASABLE_INVOICE_STATUSES = ["pushed_to_xero", "approved"];

export function assertUnpaidVoidedSupplierBill(
  bill: Row,
  expectedId: string,
): ReleasableXeroBillStatus {
  requireRelease(
    bill?.InvoiceID === expectedId && bill.Type === "ACCPAY",
    "voided_release_identity",
    "The exact supplier bill could not be verified.",
  );
  requireRelease(
    (RELEASABLE_XERO_BILL_STATUSES as readonly string[]).includes(bill.Status),
    "voided_release_not_voided",
    "Void or delete the supplier bill in Xero before releasing its Trade App invoice.",
  );
  requireRelease(
    bill.AmountPaid != null && Number(bill.AmountPaid) === 0 &&
      Number(bill.AmountCredited ?? 0) === 0 && !bill.BatchPaymentID,
    "voided_release_settled",
    "A payment, credit or batch payment prevents release.",
  );
  for (
    const key of ["Payments", "CreditNotes", "Prepayments", "Overpayments"]
  ) {
    requireRelease(
      bill[key] == null || (Array.isArray(bill[key]) && bill[key].length === 0),
      "voided_release_settled",
      "A payment or credit allocation prevents release.",
    );
  }
  return bill.Status as ReleasableXeroBillStatus;
}

/** The local half of a release, shared by the office action and the sync.
 * The row must still hold the exact bill, status, payment and history it was
 * read with; anything else is a concurrent change and writes nothing.
 */
function assertLocalInvoiceReleasable(invoice: Row, billId: string): void {
  requireRelease(
    invoice?.xero_bill_id === billId,
    "voided_release_identity",
    "The invoice's Xero identity changed. Read it again.",
  );
  requireRelease(
    invoice.override_details == null ||
      (typeof invoice.override_details === "object" &&
        !Array.isArray(invoice.override_details)),
    "voided_release_history_shape",
    "This invoice needs an office history review before release.",
  );
  requireRelease(
    (invoice.amount_paid == null || Number(invoice.amount_paid) === 0) &&
      !invoice.paid_at,
    "voided_release_settled",
    "This invoice records a payment and cannot be released.",
  );
}

async function assertNoGroupLines(client: any, id: string): Promise<void> {
  const { data: lines, error } = await client.from("trade_invoice_lines")
    .select("id, line_type, group_share_id").eq("trade_invoice_id", id);
  if (error) {
    throw new VoidedTradeInvoiceReleaseError(
      "voided_release_unreadable",
      "The invoice lines could not be read.",
      503,
    );
  }
  // An invoice with no lines left is out of the ordinary: the office looks
  // at it rather than the sync releasing it blind.
  requireRelease(
    Array.isArray(lines) && lines.length > 0,
    "voided_release_no_lines",
    "This invoice has no lines, so it is left for the office to check.",
  );
  requireRelease(
    !lines.some((line: Row) => isGroupShareLine(line)),
    "voided_release_group_invoice",
    "Group-share invoices need their group release procedure.",
  );
}

async function readProviderBill(
  client: any,
  billId: string,
  deps: { getToken: GetTokenFn; xeroGet: XeroGetFn },
): Promise<{ bill: Row; tenantId: string }> {
  const { accessToken, tenantId } = await deps.getToken(client);
  const result = await deps.xeroGet(
    `/Invoices/${encodeURIComponent(billId)}`,
    accessToken,
    tenantId,
    { unitdp: "4" },
  );
  requireRelease(
    result?.Invoices?.length === 1,
    "voided_release_unreadable",
    "Xero did not return the exact supplier bill.",
  );
  return { bill: result.Invoices[0], tenantId };
}

/** Compare-and-set the release, then record it. Keeps the header, lines,
 * assignment pointers and Xero identity as history.
 */
async function writeRelease(
  client: any,
  invoice: Row,
  bill: Row,
  billStatus: ReleasableXeroBillStatus,
  proofContext: { tenantId: string; actor: string; reason: string; automatic: boolean },
): Promise<{ eventRecorded: boolean }> {
  const word = billStatus === "DELETED" ? "deleted" : "voided";
  const proof = {
    xero_bill_id: invoice.xero_bill_id,
    tenant_id: proofContext.tenantId,
    status: bill.Status,
    amount_paid: Number(bill.AmountPaid),
    checked_at: new Date().toISOString(),
    actor: proofContext.actor,
    reason: proofContext.reason,
    automatic: proofContext.automatic,
    prior_status: invoice.status,
    prior_query_note: invoice.query_note ?? null,
  };
  let update = client.from("trade_invoices").update({
    status: "ops-reject",
    xero_bill_status: billStatus,
    amount_paid: 0,
    query_note:
      `Xero bill ${word} with nothing paid. Released for a corrected submission: ${proofContext.reason}`,
    override_details: {
      ...(invoice.override_details || {}),
      voided_release: proof,
    },
  }).eq("id", invoice.id).eq("user_id", invoice.user_id)
    .eq("status", invoice.status).eq("xero_bill_id", invoice.xero_bill_id)
    .is("paid_at", null);
  if (invoice.org_id) update = update.eq("org_id", invoice.org_id);
  update = invoice.amount_paid == null
    ? update.is("amount_paid", null)
    : update.eq("amount_paid", invoice.amount_paid);
  update = invoice.override_details == null
    ? update.is("override_details", null)
    : update.eq("override_details", JSON.stringify(invoice.override_details));
  update = invoice.query_note == null
    ? update.is("query_note", null)
    : update.eq("query_note", invoice.query_note);
  const { data: released, error: writeError } = await update.select("id")
    .maybeSingle();
  if (writeError) {
    throw new VoidedTradeInvoiceReleaseError(
      "voided_release_failed",
      "The release was not saved.",
      503,
    );
  }
  requireRelease(
    released?.id === invoice.id,
    "voided_release_changed",
    "The invoice changed during release. Read it again.",
  );
  const eventRecorded = await recordTradeInvoiceEvent(client, {
    trade_invoice_id: invoice.id,
    event_type: "voided_bill_released",
    actor: proofContext.actor,
    reason: proofContext.reason,
    detail: {
      xero_bill_id: invoice.xero_bill_id,
      xero_bill_status: billStatus,
      prior_status: invoice.status,
      automatic: proofContext.automatic,
      invoice_number: invoice.invoice_number ?? null,
    },
  });
  return { eventRecorded };
}

/** Release only the local claim locks. Keep the original header, lines,
 * assignment pointers and external identity as history. All new submissions
 * must pass the current patio/group and duplicate guards again.
 */
export async function releaseVoidedTradeInvoice(
  client: any,
  body: Row,
  context: { allowed: boolean; orgId: string; actor: string },
  deps: { getToken: GetTokenFn; xeroGet: XeroGetFn },
): Promise<Row> {
  if (!context.allowed) {
    throw new VoidedTradeInvoiceReleaseError(
      "voided_release_forbidden",
      "An authorised office caller is required.",
      403,
    );
  }
  requireRelease(
    body.confirm === true,
    "voided_release_confirmation_required",
    "Confirm this exact voided invoice release.",
  );
  const id = String(body.invoice_id || "").trim();
  const billId = String(body.expected_xero_bill_id || "").trim();
  const reason = String(body.reason || "").trim();
  requireRelease(
    Boolean(id && billId && reason.length >= 3 && reason.length <= 500),
    "voided_release_input",
    "Name the invoice, its expected Xero bill and the reason.",
  );
  const { data: invoice, error } = await client.from("trade_invoices").select(
    "*",
  )
    .eq("id", id).eq("org_id", context.orgId).maybeSingle();
  if (error) {
    throw new VoidedTradeInvoiceReleaseError(
      "voided_release_unreadable",
      "The invoice could not be read.",
      503,
    );
  }
  requireRelease(
    invoice?.xero_bill_id === billId,
    "voided_release_identity",
    "The invoice's Xero identity changed. Read it again.",
  );
  const prior = invoice.override_details?.voided_release;
  const replay = invoice.status === "ops-reject" &&
    prior?.xero_bill_id === billId;
  requireRelease(
    RELEASABLE_INVOICE_STATUSES.includes(invoice.status) || replay,
    "voided_release_status",
    "Only a pushed invoice with a verified voided or deleted bill can be released.",
  );
  if (!replay) assertLocalInvoiceReleasable(invoice, billId);
  await assertNoGroupLines(client, id);

  const { bill, tenantId } = await readProviderBill(client, billId, deps);
  const billStatus = assertUnpaidVoidedSupplierBill(bill, billId);
  if (replay) {
    return {
      ok: true,
      invoice_id: id,
      status: "ops-reject",
      already_released: true,
    };
  }
  const { eventRecorded } = await writeRelease(client, invoice, bill, billStatus, {
    tenantId,
    actor: context.actor,
    reason,
    automatic: false,
  });
  return {
    ok: true,
    invoice_id: id,
    status: "ops-reject",
    xero_bill_status: billStatus,
    already_released: false,
    event_recorded: eventRecorded,
    note:
      "The original invoice is retained. Submit only eligible corrected lines; current group rules still apply.",
  };
}

export const AUTO_RELEASE_REASON =
  "Standing policy: the Xero bill was voided or deleted with nothing paid, so the week is free to invoice again.";
export const AUTO_RELEASE_ACTOR = "system:xero-sync";
const AUTO_RELEASE_DEFAULT_LIMIT = 20;
const AUTO_RELEASE_COLUMNS =
  "id, org_id, user_id, status, invoice_number, xero_bill_id, xero_bill_status, amount_paid, paid_at, override_details, query_note";

export interface AutoReleaseResult {
  checked: number;
  released: string[];
  skipped: { invoice_id: string; code: string }[];
  events_unrecorded: string[];
}

/** Standing policy (owner, 6 Nov 2026): when the sync sees a trade bill VOIDED
 * or DELETED in Xero with nothing paid, the week is released through the same
 * checks as the office release. Each candidate is re-read from Xero itself;
 * the copy only nominates. A bill with any payment, credit or batch payment,
 * a group-share invoice, a bill Xero could not return, or a row that changed
 * meanwhile is skipped and left for the office. One failure never stops the
 * others; only a Xero rate limit ends the run.
 */
export async function autoReleaseVoidedTradeInvoices(
  client: any,
  deps: { getToken: GetTokenFn; xeroGet: XeroGetFn },
  options: { limit?: number } = {},
): Promise<AutoReleaseResult> {
  const limit = Math.max(1, Math.min(options.limit ?? AUTO_RELEASE_DEFAULT_LIMIT, 100));
  const { data, error } = await client.from("trade_invoices")
    .select(AUTO_RELEASE_COLUMNS)
    .not("xero_bill_id", "is", null)
    .in("status", RELEASABLE_INVOICE_STATUSES)
    .in("xero_bill_status", [...RELEASABLE_XERO_BILL_STATUSES])
    .is("paid_at", null)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    throw new VoidedTradeInvoiceReleaseError(
      "voided_release_unreadable",
      "Trade invoices with voided or deleted bills could not be read.",
      503,
    );
  }
  const result: AutoReleaseResult = {
    checked: 0,
    released: [],
    skipped: [],
    events_unrecorded: [],
  };
  let token: { accessToken: string; tenantId: string } | null = null;
  const cachedDeps = {
    getToken: async (c: any) => (token ??= await deps.getToken(c)),
    xeroGet: deps.xeroGet,
  };
  for (const invoice of (data || []) as Row[]) {
    result.checked++;
    try {
      assertLocalInvoiceReleasable(invoice, String(invoice.xero_bill_id));
      await assertNoGroupLines(client, invoice.id);
      const { bill, tenantId } = await readProviderBill(
        client,
        String(invoice.xero_bill_id),
        cachedDeps,
      );
      const billStatus = assertUnpaidVoidedSupplierBill(
        bill,
        String(invoice.xero_bill_id),
      );
      const { eventRecorded } = await writeRelease(client, invoice, bill, billStatus, {
        tenantId,
        actor: AUTO_RELEASE_ACTOR,
        reason: AUTO_RELEASE_REASON,
        automatic: true,
      });
      result.released.push(invoice.id);
      if (!eventRecorded) result.events_unrecorded.push(invoice.id);
    } catch (e) {
      // A Xero rate limit stops the run for the whole sync to honour.
      if (e instanceof XeroCooldownError) throw e;
      result.skipped.push({
        invoice_id: invoice.id,
        code: e instanceof VoidedTradeInvoiceReleaseError
          ? e.code
          : "voided_release_provider_error",
      });
    }
  }
  return result;
}
