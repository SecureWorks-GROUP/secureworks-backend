// Provider-open ACCREC book vs xero_invoices cache.
// Incremental If-Modified-Since never re-asks invoices that have not changed,
// so AUTHORISED rows that were never cached stay missing. This pass compares
// a full provider page set to the door filter and upserts only missing opens.
// Author tests must call write=false against production.

export type ProviderOpenInvoice = {
  InvoiceID: string;
  InvoiceNumber: string;
  Type?: string;
  Status: string;
  AmountDue: number;
};

export type CacheOpenInvoice = {
  xero_invoice_id: string;
  invoice_number?: string | null;
  invoice_type?: string | null;
  status?: string | null;
  amount_due?: number | null;
};

export function isOpenAccrec(row: {
  Type?: string | null;
  invoice_type?: string | null;
  Status?: string | null;
  status?: string | null;
  AmountDue?: number | null;
  amount_due?: number | null;
}): boolean {
  const type = row.Type ?? row.invoice_type;
  const status = row.Status ?? row.status;
  const due = Number(row.AmountDue ?? row.amount_due ?? 0);
  return type === "ACCREC" && status === "AUTHORISED" && due > 0;
}

export function diffOpenReceivables(
  provider: ProviderOpenInvoice[],
  cache: CacheOpenInvoice[],
) {
  const p = provider.filter((r) =>
    isOpenAccrec({
      Type: r.Type ?? "ACCREC",
      Status: r.Status,
      AmountDue: r.AmountDue,
    })
  );
  const c = cache.filter((r) =>
    isOpenAccrec({
      invoice_type: r.invoice_type ?? "ACCREC",
      status: r.status,
      amount_due: r.amount_due,
    })
  );
  const pIds = new Map(p.map((r) => [r.InvoiceID, r]));
  const cIds = new Map(c.map((r) => [r.xero_invoice_id, r]));
  const missing = p.filter((r) => !cIds.has(r.InvoiceID));
  const extras = c.filter((r) => !pIds.has(r.xero_invoice_id));
  const amount_diffs: Array<{ id: string; provider: number; cache: number }> = [];
  for (const [id, prow] of pIds) {
    const crow = cIds.get(id);
    if (!crow) continue;
    const pd = Number(prow.AmountDue);
    const cd = Number(crow.amount_due);
    if (Math.round(pd * 100) !== Math.round(cd * 100)) {
      amount_diffs.push({ id, provider: pd, cache: cd });
    }
  }
  return {
    provider_count: p.length,
    provider_due: round2(p.reduce((s, r) => s + Number(r.AmountDue), 0)),
    cache_count: c.length,
    cache_due: round2(c.reduce((s, r) => s + Number(r.amount_due || 0), 0)),
    missing,
    extras,
    amount_diffs,
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export async function applyOpenReceivableReconcile(
  client: { from: (t: string) => any },
  orgId: string,
  provider: ProviderOpenInvoice[],
  opts: { write: boolean },
) {
  const { data, error } = await client.from("xero_invoices")
    .select("xero_invoice_id, invoice_number, invoice_type, status, amount_due")
    .eq("org_id", orgId)
    .eq("invoice_type", "ACCREC")
    .eq("status", "AUTHORISED")
    .gt("amount_due", 0);
  if (error) throw error;
  const diff = diffOpenReceivables(provider, data || []);
  if (!opts.write) return { ...diff, written: 0 };
  let written = 0;
  for (const inv of diff.missing) {
    const { error: upErr } = await client.from("xero_invoices").upsert({
      org_id: orgId,
      xero_invoice_id: inv.InvoiceID,
      invoice_number: inv.InvoiceNumber,
      invoice_type: inv.Type ?? "ACCREC",
      status: inv.Status,
      amount_due: inv.AmountDue,
      synced_at: new Date().toISOString(),
    }, { onConflict: "org_id,xero_invoice_id" });
    if (upErr) throw upErr;
    written += 1;
  }
  return { ...diff, written };
}
