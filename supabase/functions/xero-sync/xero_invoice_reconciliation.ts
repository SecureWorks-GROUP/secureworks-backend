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
  const invalid = (data: unknown, error: unknown) =>
    error || !Array.isArray(data) ||
    data.some((row) =>
      !row || typeof row.xero_invoice_id !== "string" || !row.xero_invoice_id
    );
  // Open receivables: verified hourly while money is owed.
  const open = await client.from("xero_invoices")
    .select("xero_invoice_id")
    .eq("org_id", orgId).eq("invoice_type", "ACCREC")
    .in("status", ["AUTHORISED", "SUBMITTED"])
    .gt("amount_due", 0)
    .lt("synced_at", new Date(now.getTime() - 60 * 60 * 1000).toISOString())
    .limit(50);
  if (invalid(open.data, open.error)) {
    throw new Error(
      "Invoice reconciliation is incomplete: stale invoice selection failed",
    );
  }
  // Cached drafts: a draft deleted in Xero never comes back through the
  // incremental list (Xero omits deleted drafts there), so the cache kept
  // showing DRAFT for invoices Xero had removed (BOOKKEEPING, 10 Sep 2026:
  // INV-0441, INV-1228 to INV-1231, INV-1248). Verify each cached draft by
  // identity once a day; the single-record read returns DELETED honestly.
  const drafts = await client.from("xero_invoices")
    .select("xero_invoice_id")
    .eq("org_id", orgId).eq("invoice_type", "ACCREC")
    .eq("status", "DRAFT")
    .lt("synced_at", new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString())
    .order("synced_at", { ascending: true })
    .limit(25);
  if (invalid(drafts.data, drafts.error)) {
    throw new Error(
      "Invoice reconciliation is incomplete: stale draft selection failed",
    );
  }
  const seen = new Set<string>();
  const merged: Array<{ xero_invoice_id: string }> = [];
  for (const row of [...open.data, ...drafts.data]) {
    if (seen.has(row.xero_invoice_id)) continue;
    seen.add(row.xero_invoice_id);
    merged.push({ xero_invoice_id: row.xero_invoice_id });
    if (merged.length >= 50) break;
  }
  return merged;
}
