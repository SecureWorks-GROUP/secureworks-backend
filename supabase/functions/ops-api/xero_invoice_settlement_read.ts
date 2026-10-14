// Same Deno URL dependency as the owning edge entrypoints.
// deno-lint-ignore no-import-prefix
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  type SettlementEvidence,
  xeroObject,
  xeroText,
} from "../_shared/xero_settlement_evidence.ts";

type Invoice = {
  xero_invoice_id: string;
  amount_paid: number | null;
  currency_code?: string | null;
  payments?: unknown;
};
const cents = (n: number) => Math.round(n * 100);

// This is a statement about observed provider reconciliation, never a statement
// that an actual bank line has been loaded or matched in SecureWorks.
export function paymentReconciliation(
  payment: SettlementEvidence,
  batch: SettlementEvidence | undefined,
): { reconciled: boolean | null; unknown_reason: string | null } {
  const unknown = (reason: string) => ({
    reconciled: null,
    unknown_reason: reason,
  });
  if (payment.status !== "AUTHORISED") return unknown("payment_not_authorised");
  if (!xeroText(payment.account?.AccountID)) {
    return unknown("payment_account_missing");
  }
  if (payment.is_reconciled === null) {
    return unknown("payment_reconciliation_not_returned");
  }
  if (payment.batch_payment_id) {
    if (!batch) return unknown("batch_evidence_missing");
    if (batch.status !== "AUTHORISED") return unknown("batch_not_authorised");
    if (!xeroText(batch.account?.AccountID)) {
      return unknown("batch_account_missing");
    }
    if (batch.account?.AccountID !== payment.account?.AccountID) {
      return unknown("batch_account_conflict");
    }
    const allocations = Array.isArray(batch.raw_json.Payments)
      ? batch.raw_json.Payments
      : [];
    const matches = allocations.filter((a) =>
      xeroObject(a)?.PaymentID === payment.provider_id
    );
    if (matches.length !== 1) {
      return unknown("batch_allocation_missing_or_duplicate");
    }
    const allocation = xeroObject(matches[0])!;
    if (
      xeroObject(allocation.Invoice)?.InvoiceID !== payment.invoice_id ||
      typeof allocation.Amount !== "number" || payment.amount === null ||
      cents(allocation.Amount) !== cents(payment.amount)
    ) {
      return unknown("batch_allocation_conflict");
    }
    if (batch.is_reconciled === null) {
      return unknown("batch_reconciliation_not_returned");
    }
    if (batch.is_reconciled !== payment.is_reconciled) {
      return unknown("batch_reconciliation_conflict");
    }
  }
  return { reconciled: payment.is_reconciled, unknown_reason: null };
}

export function invoiceSettlementRead(
  invoice: Invoice,
  evidence: SettlementEvidence[],
  readError: string | null = null,
) {
  const invoiceId = invoice.xero_invoice_id.toLowerCase();
  const batchMap = new Map(
    evidence.filter((r) => r.record_type === "batch_payment").map(
      (r) => [r.provider_id, r],
    ),
  );
  const own = evidence.filter((r) =>
    r.record_type === "payment" && r.invoice_id === invoiceId
  );
  const ids = new Set(own.map((r) => r.provider_id));
  const embedded = Array.isArray(invoice.payments) ? invoice.payments : [];
  const missingIds = embedded.filter((p) =>
    !ids.has(String(xeroObject(p)?.PaymentID).toLowerCase())
  ).map((p) => xeroText(xeroObject(p)?.PaymentID));
  const active = own.filter((p) => p.status === "AUTHORISED");
  const observedAmount = active.reduce((n, p) => n + cents(p.amount ?? 0), 0);
  const payments = own.sort((a, b) =>
    a.provider_id.localeCompare(b.provider_id)
  ).map((p) => ({
    payment_id: p.provider_id,
    invoice_id: p.invoice_id,
    date: p.payment_date,
    amount: p.amount,
    reference: p.reference,
    batch_payment_id: p.batch_payment_id,
    account: p.account,
    status: p.status,
    is_reconciled: p.is_reconciled,
    captured_at: p.captured_at,
    provider_updated_at: p.provider_updated_at,
    bank_proof: paymentReconciliation(
      p,
      p.batch_payment_id ? batchMap.get(p.batch_payment_id) : undefined,
    ),
  }));
  const reasons = new Set<string>();
  if (
    (invoice.payments != null && !Array.isArray(invoice.payments)) ||
    embedded.some((p) => !xeroObject(p))
  ) {
    reasons.add("embedded_payment_list_unreadable");
  }
  if (readError) reasons.add(readError);
  if (invoice.amount_paid === null || !Number.isFinite(invoice.amount_paid)) {
    reasons.add("invoice_paid_amount_unknown");
  } else if (invoice.amount_paid <= 0) reasons.add("no_recorded_cash_payment");
  if (missingIds.length) reasons.add("embedded_payment_evidence_missing");
  if (!active.length && (invoice.amount_paid ?? 0) > 0) {
    reasons.add("payment_evidence_missing");
  }
  if (active.some((p) => p.amount === null || p.amount <= 0)) {
    reasons.add("payment_amount_unknown_or_nonpositive");
  }
  if (
    invoice.amount_paid !== null &&
    observedAmount !== cents(invoice.amount_paid)
  ) reasons.add("payment_total_differs_from_invoice_paid");
  for (const p of active) {
    const currency = xeroText(xeroObject(p.raw_json.Invoice)?.CurrencyCode);
    if (
      !currency || !invoice.currency_code || currency !== invoice.currency_code
    ) reasons.add("invoice_payment_currency_unknown_or_conflict");
    const reconciliation = paymentReconciliation(
      p,
      p.batch_payment_id ? batchMap.get(p.batch_payment_id) : undefined,
    );
    if (reconciliation.unknown_reason) {
      reasons.add(reconciliation.unknown_reason);
    }
  }
  const reconciled = reasons.size
    ? null
    : active.every((p) => p.is_reconciled === true);
  const batchIds = new Set(own.map((p) => p.batch_payment_id).filter(Boolean));
  return {
    contract: "xero-invoice-settlement/v1",
    invoice_id: invoiceId,
    paid_amount: invoice.amount_paid,
    currency: invoice.currency_code ?? null,
    observed_payment_amount: observedAmount / 100,
    payments,
    missing_payment_ids: missingIds,
    batches: [...batchMap.values()].filter((b) => batchIds.has(b.provider_id))
      .map((b) => ({
        batch_payment_id: b.provider_id,
        date: b.payment_date,
        total_amount: b.amount,
        reference: b.reference,
        account: b.account,
        status: b.status,
        is_reconciled: b.is_reconciled,
        allocations: b.raw_json.Payments,
        captured_at: b.captured_at,
      })),
    bank_proof: {
      basis: "xero_payment_reconciliation",
      reconciled,
      unknown_reason: [...reasons][0] ?? null,
      unknown_reasons: [...reasons],
      statement_line: {
        state: "not_ingested",
        reason: "BK-03_statement_line_scope_pending",
      },
    },
  };
}

// Service-side, scoped by the caller's org and the existing connection's tenant.
// Every read fault stays unknown or fails loudly, never an empty all-clear.
export async function readInvoiceSettlement(
  sb: Pick<SupabaseClient, "from">,
  orgId: string,
  invoiceId: string,
) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(invoiceId)) {
    throw new Error("xero_invoice_id must be a provider UUID");
  }
  const { data: invoice, error } = await sb.from("xero_invoices")
    .select(
      "xero_invoice_id,invoice_type,amount_paid,currency_code,payments:raw_json->Payments",
    )
    .eq("org_id", orgId).eq("xero_invoice_id", invoiceId.toLowerCase())
    .maybeSingle();
  if (error) throw new Error("Invoice settlement invoice read failed");
  if (!invoice || invoice.invoice_type !== "ACCREC") return null;
  const { data: connection, error: connectionError } = await sb.from(
    "xero_tokens",
  )
    .select("tenant_id").eq("org_id", orgId).maybeSingle();
  if (connectionError || !connection?.tenant_id) {
    return invoiceSettlementRead(invoice, [], "xero_tenant_unavailable");
  }
  const evidence: SettlementEvidence[] = [];
  for (let offset = 0;; offset += 500) {
    const { data, error } = await sb.from("xero_settlement_evidence").select(
      "*",
    )
      .eq("org_id", orgId).eq("tenant_id", connection.tenant_id)
      .eq("record_type", "payment").eq("invoice_id", invoiceId.toLowerCase())
      .order("provider_id").range(offset, offset + 499);
    if (error || !data) {
      return invoiceSettlementRead(invoice, [], "payment_evidence_read_failed");
    }
    evidence.push(...data);
    if (data.length < 500) break;
  }
  const batchIds = [
    ...new Set(evidence.map((p) => p.batch_payment_id).filter(Boolean)),
  ];
  for (let offset = 0; offset < batchIds.length; offset += 25) {
    const { data, error } = await sb.from("xero_settlement_evidence").select(
      "*",
    )
      .eq("org_id", orgId).eq("tenant_id", connection.tenant_id).eq(
        "record_type",
        "batch_payment",
      )
      .in("provider_id", batchIds.slice(offset, offset + 25));
    if (error || !data) {
      return invoiceSettlementRead(
        invoice,
        evidence,
        "batch_evidence_read_failed",
      );
    }
    evidence.push(...data);
  }
  return invoiceSettlementRead(invoice, evidence);
}
