import { XeroCooldownError } from "../_shared/xero_cooldown.ts";
import { XeroSyncProviderError } from "./xero_transport.ts";

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
    // The attempt stamp orders the daily draft sweep. A verified read clears
    // any recorded failure; synced_at stays a verification timestamp only.
    reconcile_attempted_at: now.toISOString(),
    reconcile_last_error: null,
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

// Stale open receivables are verified hourly, so they take the bulk of the
// batch. Cached drafts hold their own reserved slots below: a full page of
// open receivables must never starve the daily draft sweep.
export const OPEN_RECONCILE_LIMIT = 50;
export const DRAFT_RECONCILE_LIMIT = 5;
// sync_invoices runs every 15 minutes. The draft sweep is a quota decision,
// not a freshness decision: it costs one GET /Invoices/{id} per draft, so it
// is gated to one pass per 24 hours through the existing sync-state table.
export const DRAFT_RECONCILE_KEY = "draft_reconcile_last_run_at";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface StaleXeroSelection {
  invoices: Array<{ xero_invoice_id: string }>;
  // Whether this run spent quota on the daily draft sweep.
  draftsDue: boolean;
  drafts: number;
  // A cursor that cannot prove 24 hours elapsed skips the drafts rather than
  // guessing. The reason travels to the run summary.
  draftGateSkipped: string | null;
}

// A sweep that cannot read its own cursor must not run: an unreadable cursor
// cannot prove a day has passed, and guessing costs 96 sweeps a day.
export async function draftReconcileDue(
  // deno-lint-ignore no-explicit-any
  client: any,
  now: Date,
): Promise<{ due: boolean; skipped: string | null }> {
  const { data, error } = await client.from("xero_sync_state")
    .select("cursor_at").eq("key", DRAFT_RECONCILE_KEY).maybeSingle();
  if (error) {
    return { due: false, skipped: "draft reconcile cursor is unreadable" };
  }
  const last = data?.cursor_at;
  if (last === null || last === undefined) return { due: true, skipped: null };
  const at = Date.parse(String(last));
  if (!Number.isFinite(at)) {
    return { due: false, skipped: "draft reconcile cursor is unreadable" };
  }
  if (now.getTime() - at < DAY_MS) return { due: false, skipped: null };
  return { due: true, skipped: null };
}

async function markDraftReconcileRan(
  // deno-lint-ignore no-explicit-any
  client: any,
  now: Date,
  note: string,
): Promise<void> {
  // Quota was already spent. A failed cursor write only costs one extra sweep,
  // so it is never raised over a batch that already ran.
  try {
    await client.from("xero_sync_state").upsert(
      {
        key: DRAFT_RECONCILE_KEY,
        cursor_at: now.toISOString(),
        note,
        updated_at: now.toISOString(),
      },
      { onConflict: "key" },
    );
  } catch (_) {
    // Next run reads the older cursor and sweeps again. No ledger effect.
  }
}

export async function listStaleXeroInvoices(
  // deno-lint-ignore no-explicit-any
  client: any,
  orgId: string,
  now: Date = new Date(),
): Promise<StaleXeroSelection> {
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
    .limit(OPEN_RECONCILE_LIMIT);
  if (invalid(open.data, open.error)) {
    throw new Error(
      "Invoice reconciliation is incomplete: stale invoice selection failed",
    );
  }
  // Cached drafts: a draft deleted in Xero never comes back through the
  // incremental list (Xero omits deleted drafts there), so the cache kept
  // showing DRAFT for invoices Xero had removed (BOOKKEEPING, 10 Sep 2026:
  // INV-0441, INV-1228 to INV-1231, INV-1248). Verify a few cached drafts by
  // identity once a day; the single-record read returns DELETED honestly.
  const gate = await draftReconcileDue(client, now);
  let draftRows: Array<{ xero_invoice_id: string }> = [];
  if (gate.due) {
    const drafts = await client.from("xero_invoices")
      .select("xero_invoice_id")
      .eq("org_id", orgId).eq("invoice_type", "ACCREC")
      .eq("status", "DRAFT")
      .lt("synced_at", new Date(now.getTime() - DAY_MS).toISOString())
      // A draft whose identity read keeps failing carries the newest attempt
      // stamp, so it sorts last instead of heading every sweep forever.
      .order("reconcile_attempted_at", { ascending: true, nullsFirst: true })
      .order("synced_at", { ascending: true })
      .limit(DRAFT_RECONCILE_LIMIT);
    if (invalid(drafts.data, drafts.error)) {
      throw new Error(
        "Invoice reconciliation is incomplete: stale draft selection failed",
      );
    }
    draftRows = drafts.data;
  }
  const seen = new Set<string>();
  const merged: Array<{ xero_invoice_id: string }> = [];
  const take = (rows: Array<{ xero_invoice_id: string }>, cap: number) => {
    let taken = 0;
    for (const row of rows) {
      if (taken >= cap) break;
      if (seen.has(row.xero_invoice_id)) continue;
      seen.add(row.xero_invoice_id);
      merged.push({ xero_invoice_id: row.xero_invoice_id });
      taken++;
    }
    return taken;
  };
  // Reserved slots: open receivables cannot consume the draft allowance, so a
  // full batch is at most OPEN_RECONCILE_LIMIT + DRAFT_RECONCILE_LIMIT.
  take(open.data, OPEN_RECONCILE_LIMIT);
  const drafts = take(draftRows, DRAFT_RECONCILE_LIMIT);
  return {
    invoices: merged,
    draftsDue: gate.due,
    drafts,
    draftGateSkipped: gate.skipped,
  };
}

export interface StaleReconcileSummary {
  reconciled: number;
  attempted: number;
  failed: number;
  last_error: Record<string, unknown> | null;
  drafts_selected: number;
  draft_sweep_ran: boolean;
  draft_gate_skipped: string | null;
}

// One unverifiable invoice must not hold up the batch. The same row is first
// in every selection, so breaking on it froze reconciliation permanently.
export function isolatedReconcileFailure(error: unknown): boolean {
  if (error instanceof XeroCooldownError) return false;
  if (error instanceof XeroSyncProviderError) return true;
  // The identity and balance guards are per-invoice facts too. A cache write
  // failure is not one, and still stops the batch.
  return error instanceof Error &&
    /provider identity or status is unverified|provider balances are unverified/
      .test(error.message);
}

// Failed lookups leave balances and synced_at untouched. Only the attempt
// stamp moves, so a permanently broken row stops heading the next sweep.
async function recordReconcileFailure(
  // deno-lint-ignore no-explicit-any
  client: any,
  orgId: string,
  invoiceId: string,
  message: string,
  now: Date,
): Promise<void> {
  // Recording an attempt must never mask the original provider failure.
  try {
    await client.from("xero_invoices").update({
      reconcile_attempted_at: now.toISOString(),
      reconcile_last_error: message.slice(0, 500),
    }).eq("xero_invoice_id", invoiceId).eq("org_id", orgId);
  } catch (_) {
    // The next run reselects the row in the order it would have anyway.
  }
}

export async function reconcileStaleXeroInvoices(
  // deno-lint-ignore no-explicit-any
  client: any,
  orgId: string,
  readInvoice: (invoiceId: string) => Promise<unknown>,
  now: Date = new Date(),
): Promise<StaleReconcileSummary> {
  const selection = await listStaleXeroInvoices(client, orgId, now);
  const summary: StaleReconcileSummary = {
    reconciled: 0,
    attempted: 0,
    failed: 0,
    last_error: null,
    drafts_selected: selection.drafts,
    draft_sweep_ran: selection.draftsDue,
    draft_gate_skipped: selection.draftGateSkipped,
  };
  try {
    for (const stale of selection.invoices) {
      summary.attempted++;
      try {
        if (
          await reconcileXeroInvoice(
            client,
            orgId,
            stale.xero_invoice_id,
            () => readInvoice(stale.xero_invoice_id),
            now,
          )
        ) summary.reconciled++;
      } catch (error) {
        // A cooldown is a transport-wide fact: stop and let the caller raise.
        if (error instanceof XeroCooldownError) throw error;
        summary.failed++;
        summary.last_error = {
          error: (error as Error).message,
          invoice_id: stale.xero_invoice_id,
        };
        await recordReconcileFailure(
          client,
          orgId,
          stale.xero_invoice_id,
          (error as Error).message,
          now,
        );
        if (isolatedReconcileFailure(error)) continue;
        break;
      }
    }
  } finally {
    // The sweep spent its quota whatever the per-invoice outcomes were.
    if (selection.draftsDue) {
      await markDraftReconcileRan(
        client,
        now,
        `drafts ${summary.drafts_selected}, failed ${summary.failed}`,
      );
    }
  }
  return summary;
}
