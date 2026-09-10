// Reconciliation needs a positively identified provider record. An unavailable
// record (including HTTP404) does not prove that an accounting balance is zero.
export async function reconcileXeroInvoice(
  // deno-lint-ignore no-explicit-any
  client: any,
  orgId: string,
  invoiceId: string,
  readInvoice: () => Promise<unknown>,
  now: Date = new Date(),
): Promise<boolean> {
  const data = await readInvoice() as {
    Invoices?: Array<Record<string, unknown>>;
  };
  const inv = data?.Invoices?.[0];
  if (
    data?.Invoices?.length !== 1 || !inv || inv.InvoiceID !== invoiceId ||
    inv.Type !== "ACCREC" ||
    !["DRAFT", "SUBMITTED", "AUTHORISED", "PAID", "VOIDED", "DELETED"]
      .includes(String(inv.Status))
  ) {
    throw new Error(
      "Invoice reconciliation is incomplete: provider identity or status is unverified",
    );
  }
  if (
    typeof inv.AmountDue !== "number" || !Number.isFinite(inv.AmountDue) ||
    typeof inv.AmountPaid !== "number" || !Number.isFinite(inv.AmountPaid)
  ) {
    throw new Error(
      "Invoice reconciliation is incomplete: provider balances are unverified",
    );
  }
  const patch: Record<string, unknown> = {
    status: inv.Status,
    amount_due: inv.AmountDue,
    amount_paid: inv.AmountPaid,
    synced_at: now.toISOString(),
    // Keep the verified provider snapshot aligned with status and balances.
    raw_json: inv,
  };
  // Optional omissions cannot erase known cached values.
  if (
    typeof inv.DueDateString === "string" &&
    Number.isFinite(Date.parse(inv.DueDateString))
  ) {
    patch.due_date = inv.DueDateString;
  }
  if (Array.isArray(inv.LineItems)) patch.line_items = inv.LineItems;
  const date = String(inv.UpdatedDateUTC ?? "").match(
    /\/Date\((\d+)([+-]\d+)?\)\//,
  );
  // updated_at drives the incremental sync watermark. A retrieval timestamp
  // cannot substitute for a missing provider update timestamp.
  const updated = date ? new Date(Number(date[1])) : null;
  if (updated && Number.isFinite(updated.getTime())) {
    patch.updated_at = updated.toISOString();
  }
  const { error } = await client.from("xero_invoices").update(patch)
    .eq("xero_invoice_id", invoiceId).eq("org_id", orgId);
  if (error) {
    throw new Error(
      "Invoice reconciliation could not save the verified provider record",
    );
  }
  return true;
}

export async function listStaleXeroInvoices(
  // deno-lint-ignore no-explicit-any
  client: any,
  orgId: string,
  now: Date = new Date(),
): Promise<Array<{ xero_invoice_id: string }>> {
  const { data, error } = await client.from("xero_invoices")
    .select("xero_invoice_id")
    .eq("org_id", orgId).eq("invoice_type", "ACCREC")
    .in("status", ["AUTHORISED", "SUBMITTED"])
    .gt("amount_due", 0)
    .lt("synced_at", new Date(now.getTime() - 60 * 60 * 1000).toISOString())
    .limit(50);
  if (
    error || !Array.isArray(data) ||
    data.some((row) =>
      !row || typeof row.xero_invoice_id !== "string" || !row.xero_invoice_id
    )
  ) {
    throw new Error(
      "Invoice reconciliation is incomplete: stale invoice selection failed",
    );
  }
  return data;
}
