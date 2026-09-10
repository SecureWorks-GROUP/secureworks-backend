import { jsonHash } from "../_shared/release_packet/canonicalize.ts";
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";

/** Server-derived key for the resolved invoice request. No wall-clock bucket or caller key.
 * Xero's retention is six minutes; this does not provide durable duplicate prevention.
 */
export async function genericInvoiceIdempotencyKey(input: {
  orgId: string;
  tenantId: string;
  jobId: string;
  contactId: string | null;
  jobContactId: string | null;
  runLabel: string | null;
  reference: string;
  invoice: unknown;
}): Promise<string> {
  const digest = await jsonHash({
    operation: "ops-api/create_invoice/v1",
    ...input,
  });
  return `inv-${digest.slice(0, 32)}`;
}

export type InvoiceEmailStatus =
  | "not_requested"
  | "accepted"
  | "failed"
  | "unknown";

/** An explicit rejection is failed; transport loss or an ambiguous response is unknown. */
export function rejectedInvoiceEmailStatus(
  error: unknown,
): "failed" | "unknown" {
  const record = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  const status = typeof record.status === "number" ? record.status : null;
  const details = record.details && typeof record.details === "object"
    ? record.details as Record<string, unknown>
    : {};
  if (
    details.provider_call_made === false || details.provider_called === false ||
    record.provider_call_made === false || record.provider_called === false
  ) return "failed";
  if (status !== null && status >= 400 && status < 500 && status !== 408) {
    return "failed";
  }
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Xero validation error:")) return "failed";
  const matched = /^Xero API \/Invoices\/[^/]+\/Email failed \((4\d\d)\):/.exec(
    message,
  );
  if (matched && matched[1] !== "408") return "failed";
  return "unknown";
}

/** Preserve transport evidence without echoing an arbitrary provider error body. */
export function invoiceEmailErrorMetadata(
  error: unknown,
  identity: { xeroInvoiceId: string; invoiceNumber: string | null },
): Record<string, unknown> {
  const evidence = error instanceof XeroCooldownError
    ? {
      ...error.details,
      code: error.code,
      http_status: error.status,
      error: error.message,
    }
    : {
      code: rejectedInvoiceEmailStatus(error) === "failed"
        ? "XERO_INVOICE_EMAIL_REJECTED"
        : "XERO_INVOICE_EMAIL_UNCONFIRMED",
      error: rejectedInvoiceEmailStatus(error) === "failed"
        ? "Xero did not accept the invoice email request"
        : "Invoice email acceptance could not be confirmed",
    };
  return {
    ...evidence,
    xero_invoice_id: identity.xeroInvoiceId,
    invoice_number: identity.invoiceNumber,
  };
}

export function invoiceEmailAccepted(
  status: InvoiceEmailStatus,
): boolean | null {
  return status === "unknown" ? null : status === "accepted";
}
