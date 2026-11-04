/** A draft invoice must never cross either invoice email path. */
export type InvoiceEmailStatusRefusal = {
  error: string;
  code: string;
  status_code: number;
};

export function invoiceEmailStatusRefusal(
  invoice: { Status?: unknown } | null | undefined,
): InvoiceEmailStatusRefusal | null {
  const status = typeof invoice?.Status === "string"
    ? invoice.Status.trim().toUpperCase()
    : "";
  if (!status) {
    return {
      error:
        "Could not verify the invoice status in Xero. Nothing was emailed.",
      code: "invoice_email_status_unknown",
      status_code: 503,
    };
  }
  if (status !== "AUTHORISED" && status !== "PAID") {
    return {
      error:
        "Only an authorised or paid invoice can be emailed. Approve the invoice first.",
      code: "invoice_email_not_issued",
      status_code: 409,
    };
  }
  return null;
}

/** Used by the Xero-direct route; the read must succeed before any email call. */
export async function sendIssuedInvoiceEmail(
  readInvoice: () => Promise<{ Invoices?: Array<{ Status?: unknown }> }>,
  sendEmail: () => Promise<unknown>,
): Promise<InvoiceEmailStatusRefusal | null> {
  const live = await readInvoice();
  const refusal = invoiceEmailStatusRefusal(live?.Invoices?.[0]);
  if (refusal) return refusal;
  await sendEmail();
  return null;
}
