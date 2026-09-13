// Provider-open ACCREC vs cache rows of any status.
// Production SELECT 2026-09-13 02:36:28 UTC: the 13 door-absent invoices
// already exist (same Xero IDs). 12 cached DELETED/0, INV-1442 cached DRAFT.
// Incremental If-Modified-Since plus a watermark advanced by local DELETED
// writes never re-asks those IDs; stale reconcile only selects AUTHORISED
// amount_due>0 or a tiny DRAFT sweep. Repair UPDATES existing money/status
// from provider authority and must not wipe debt_* notes/classifications.
// Author tests must not write production.

export type ProviderOpenInvoice = {
  InvoiceID: string;
  InvoiceNumber: string;
  Type?: string;
  Status: string;
  AmountDue: number;
  AmountPaid?: number;
  UpdatedDateUTC?: string;
};

export type CacheInvoice = {
  xero_invoice_id: string;
  invoice_number?: string | null;
  invoice_type?: string | null;
  status?: string | null;
  amount_due?: number | null;
  debt_classification?: string | null;
  debt_brief?: string | null;
};

export function isProviderOpenAccrec(row: ProviderOpenInvoice): boolean {
  return (row.Type ?? "ACCREC") === "ACCREC" &&
    row.Status === "AUTHORISED" &&
    Number(row.AmountDue) > 0;
}

export function isDoorOpen(row: CacheInvoice): boolean {
  return (row.invoice_type ?? "ACCREC") === "ACCREC" &&
    row.status === "AUTHORISED" &&
    Number(row.amount_due) > 0;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function rejectIfError(result: { error?: { message?: string } | null } | null | undefined, what: string) {
  const err = result?.error;
  if (!err) return;
  throw err instanceof Error ? err : new Error(err.message || what);
}

export function classifyProviderVsCache(
  provider: ProviderOpenInvoice[],
  cache: CacheInvoice[],
) {
  const p = provider.filter(isProviderOpenAccrec);
  const byId = new Map(cache.map((r) => [r.xero_invoice_id, r]));
  const stale_status: Array<{ provider: ProviderOpenInvoice; cache: CacheInvoice }> = [];
  const absent: ProviderOpenInvoice[] = [];
  const matched: ProviderOpenInvoice[] = [];
  for (const inv of p) {
    const row = byId.get(inv.InvoiceID);
    if (!row) {
      absent.push(inv);
      continue;
    }
    if (!isDoorOpen(row) || round2(Number(row.amount_due)) !== round2(Number(inv.AmountDue))) {
      stale_status.push({ provider: inv, cache: row });
    } else {
      matched.push(inv);
    }
  }
  const door = cache.filter(isDoorOpen);
  const cutoffTimes = p
    .map((r) => Date.parse(String(r.UpdatedDateUTC || "")))
    .filter((n) => Number.isFinite(n));
  return {
    provider_count: p.length,
    provider_due: round2(p.reduce((s, r) => s + Number(r.AmountDue), 0)),
    door_count: door.length,
    door_due: round2(door.reduce((s, r) => s + Number(r.amount_due || 0), 0)),
    provider_cutoff: cutoffTimes.length
      ? new Date(Math.max(...cutoffTimes)).toISOString()
      : null,
    stale_status,
    absent,
    matched_count: matched.length,
  };
}

const MONEY_FIELDS = [
  "status",
  "amount_due",
  "amount_paid",
  "synced_at",
] as const;

export function providerMoneyPatch(inv: ProviderOpenInvoice, now = new Date()) {
  return {
    status: inv.Status,
    amount_due: inv.AmountDue,
    amount_paid: inv.AmountPaid ?? 0,
    synced_at: now.toISOString(),
  };
}

export async function applyOpenReceivableReconcile(
  client: { from: (t: string) => any },
  orgId: string,
  provider: ProviderOpenInvoice[],
  opts: { write: boolean; now?: Date; provider_pages?: number },
) {
  const ids = provider.filter(isProviderOpenAccrec).map((p) => p.InvoiceID);
  const { data, error } = await client.from("xero_invoices")
    .select(
      "xero_invoice_id, invoice_number, invoice_type, status, amount_due, debt_classification, debt_brief",
    )
    .eq("org_id", orgId)
    .in("xero_invoice_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  if (error) throw error;
  const diff = classifyProviderVsCache(provider, data || []);
  if (!opts.write) {
    return { ...diff, updated: 0, inserted: 0, attempted: 0, failed: 0, receipt_id: null };
  }
  const now = opts.now ?? new Date();
  const runIns = await client.from("xero_open_receivable_reconcile_runs").insert({
    org_id: orgId,
    status: "running",
    provider_pages: opts.provider_pages ?? 0,
    provider_count: diff.provider_count,
    provider_cutoff: diff.provider_cutoff,
    attempted: diff.stale_status.length + diff.absent.length,
  }).select("id").single();
  rejectIfError(runIns, "reconcile receipt create failed");
  if (!runIns.data?.id) throw new Error("reconcile receipt create failed");
  const receiptId = runIns.data.id;
  let updated = 0;
  let inserted = 0;
  let failed = 0;
  let lastError: { invoice?: string; message: string } | null = null;
  const mark = async (invoiceId: string, action: "update" | "insert", ok: boolean, message?: string) => {
    const itemIns = await client.from("xero_open_receivable_reconcile_items").insert({
      run_id: receiptId,
      xero_invoice_id: invoiceId,
      action,
      ok,
      error: message ?? null,
    });
    rejectIfError(itemIns, "reconcile receipt item write failed");
  };
  const finishReceipt = async (status: "completed" | "partial" | "failed") => {
    const recUp = await client.from("xero_open_receivable_reconcile_runs").update({
      status,
      finished_at: new Date().toISOString(),
      updated,
      inserted,
      failed,
      attempted: diff.stale_status.length + diff.absent.length,
      traversal_complete: status === "completed",
      last_error: lastError,
    }).eq("id", receiptId);
    rejectIfError(recUp, "reconcile receipt progress write failed");
  };
  try {
    for (const { provider: inv } of diff.stale_status) {
      const patch = providerMoneyPatch(inv, now);
      const { error: upErr } = await client.from("xero_invoices").update(patch)
        .eq("org_id", orgId).eq("xero_invoice_id", inv.InvoiceID);
      if (upErr) {
        failed += 1;
        lastError = { invoice: inv.InvoiceID, message: upErr.message };
        await mark(inv.InvoiceID, "update", false, upErr.message);
        throw upErr;
      }
      updated += 1;
      await mark(inv.InvoiceID, "update", true);
    }
    for (const inv of diff.absent) {
      const { error: inErr } = await client.from("xero_invoices").insert({
        org_id: orgId,
        xero_invoice_id: inv.InvoiceID,
        invoice_number: inv.InvoiceNumber,
        invoice_type: inv.Type ?? "ACCREC",
        ...providerMoneyPatch(inv, now),
      });
      if (inErr) {
        failed += 1;
        lastError = { invoice: inv.InvoiceID, message: inErr.message };
        await mark(inv.InvoiceID, "insert", false, inErr.message);
        throw inErr;
      }
      inserted += 1;
      await mark(inv.InvoiceID, "insert", true);
    }
  } catch (err) {
    lastError = lastError || { message: err instanceof Error ? err.message : String(err) };
    await finishReceipt(updated + inserted > 0 ? "partial" : "failed");
    throw err;
  }
  await finishReceipt("completed");
  return { ...diff, updated, inserted, attempted: diff.stale_status.length + diff.absent.length, failed: 0, receipt_id: receiptId, money_fields: MONEY_FIELDS };
}
