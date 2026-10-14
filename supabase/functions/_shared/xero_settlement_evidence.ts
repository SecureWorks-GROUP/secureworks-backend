// One projection of provider payment evidence, used by sync and the invoice read.
// No bank transaction matching and no provider write capability.
export type XeroRecord = Record<string, unknown>;
export type SettlementEvidence = {
  org_id: string;
  tenant_id: string;
  record_type: "payment" | "batch_payment";
  provider_id: string;
  invoice_id: string | null;
  batch_payment_id: string | null;
  payment_date: string | null;
  amount: number | null;
  reference: string | null;
  account: XeroRecord | null;
  is_reconciled: boolean | null;
  status: string | null;
  provider_updated_at: string | null;
  captured_at: string;
  raw_json: XeroRecord;
};
export function xeroObject(v: unknown): XeroRecord | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? v as XeroRecord
    : null;
}
export function xeroText(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
export function xeroNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
export function xeroInstant(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const ms = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(v);
  const t = ms ? Number(ms[1]) : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
export function xeroCollection(value: unknown, key: string): XeroRecord[] {
  const rows = xeroObject(value)?.[key];
  if (!Array.isArray(rows) || rows.some((r) => !xeroObject(r))) {
    throw new Error(`Xero ${key} response is unreadable`);
  }
  return rows as XeroRecord[];
}
export function projectXeroSettlementEvidence(
  raw: XeroRecord,
  kind: SettlementEvidence["record_type"],
  orgId: string,
  tenantId: string,
  capturedAt: string,
): SettlementEvidence {
  const id = xeroText(raw[kind === "payment" ? "PaymentID" : "BatchPaymentID"]);
  const invoice = xeroObject(raw.Invoice);
  if (!id || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("Xero settlement identity is missing or invalid");
  }
  if (
    kind === "payment" && (raw.PaymentType !== "ACCRECPAYMENT" ||
      !xeroText(invoice?.InvoiceID) ||
      (invoice?.Type !== undefined && invoice.Type !== "ACCREC"))
  ) {
    throw new Error("Xero payment is not a sales invoice allocation");
  }
  if (kind === "batch_payment" && raw.Type !== "RECBATCH") {
    throw new Error("Xero batch is not a receipt batch");
  }
  if (kind === "batch_payment") xeroCollection(raw, "Payments");
  return {
    org_id: orgId,
    tenant_id: tenantId,
    record_type: kind,
    provider_id: id.toLowerCase(),
    invoice_id: kind === "payment"
      ? String(invoice!.InvoiceID).toLowerCase()
      : null,
    batch_payment_id: kind === "payment"
      ? xeroText(raw.BatchPaymentID)?.toLowerCase() ?? null
      : null,
    payment_date: xeroInstant(raw.DateString ?? raw.Date)?.slice(0, 10) ?? null,
    amount: xeroNumber(kind === "payment" ? raw.Amount : raw.TotalAmount),
    reference: typeof raw.Reference === "string" ? raw.Reference : null,
    account: xeroObject(raw.Account),
    is_reconciled: typeof raw.IsReconciled === "boolean"
      ? raw.IsReconciled
      : null,
    status: xeroText(raw.Status),
    provider_updated_at: xeroInstant(raw.UpdatedDateUTC),
    captured_at: capturedAt,
    raw_json: raw,
  };
}
