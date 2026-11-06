import type { GetTokenFn, XeroGetFn } from "./xero_accpay_books.ts";
import { isGroupShareLine } from "./group_work_order.ts";

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

/** A provider VOIDED bill cannot acquire another payment. Never substitute a
 * mirror status, an absent invoice, DELETED, or an unpaid AUTHORISED bill.
 */
export function assertUnpaidVoidedSupplierBill(
  bill: Row,
  expectedId: string,
): void {
  requireRelease(
    bill?.InvoiceID === expectedId && bill.Type === "ACCPAY",
    "voided_release_identity",
    "The exact supplier bill could not be verified.",
  );
  requireRelease(
    bill.Status === "VOIDED",
    "voided_release_not_voided",
    "Void the supplier bill in Xero before releasing its Trade App invoice.",
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
  requireRelease(
    invoice.override_details == null ||
      (typeof invoice.override_details === "object" &&
        !Array.isArray(invoice.override_details)),
    "voided_release_history_shape",
    "This invoice needs an office history review before release.",
  );
  const prior = invoice.override_details?.voided_release;
  const replay = invoice.status === "ops-reject" &&
    prior?.xero_bill_id === billId;
  requireRelease(
    invoice.status === "pushed_to_xero" || replay,
    "voided_release_status",
    "Only a pushed invoice with a verified voided bill can be released.",
  );
  requireRelease(
    invoice.amount_paid != null && Number(invoice.amount_paid) === 0 &&
      !invoice.paid_at,
    "voided_release_settled",
    "This invoice records a payment and cannot be released.",
  );
  const { data: lines, error: linesError } = await client.from(
    "trade_invoice_lines",
  )
    .select("id, line_type, group_share_id").eq("trade_invoice_id", id);
  if (linesError) {
    throw new VoidedTradeInvoiceReleaseError(
      "voided_release_unreadable",
      "The invoice lines could not be read.",
      503,
    );
  }
  requireRelease(
    Array.isArray(lines) && lines.length > 0 &&
      !lines.some((line: Row) => isGroupShareLine(line)),
    "voided_release_group_invoice",
    "Group-share invoices need their group release procedure.",
  );

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
  const bill = result.Invoices[0];
  assertUnpaidVoidedSupplierBill(bill, billId);
  if (replay) {
    return {
      ok: true,
      invoice_id: id,
      status: "ops-reject",
      already_released: true,
    };
  }
  const proof = {
    xero_bill_id: billId,
    tenant_id: tenantId,
    status: bill.Status,
    amount_paid: Number(bill.AmountPaid),
    checked_at: new Date().toISOString(),
    actor: context.actor,
    reason,
    prior_query_note: invoice.query_note ?? null,
  };
  let update = client.from("trade_invoices").update({
    status: "ops-reject",
    xero_bill_status: "VOIDED",
    query_note:
      `Xero bill voided and unpaid. Released for a corrected submission: ${reason}`,
    override_details: {
      ...(invoice.override_details || {}),
      voided_release: proof,
    },
  }).eq("id", id).eq("org_id", context.orgId).eq("user_id", invoice.user_id)
    .eq("status", "pushed_to_xero").eq("xero_bill_id", billId)
    .eq("amount_paid", invoice.amount_paid).is("paid_at", null);
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
    released?.id === id,
    "voided_release_changed",
    "The invoice changed during release. Read it again.",
  );
  return {
    ok: true,
    invoice_id: id,
    status: "ops-reject",
    already_released: false,
    note:
      "The original invoice is retained. Submit only eligible corrected lines; current group rules still apply.",
  };
}
