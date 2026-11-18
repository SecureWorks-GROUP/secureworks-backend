// Same Deno URL dependency as the owning edge entrypoints.
// deno-lint-ignore no-import-prefix
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  projectXeroSettlementEvidence,
  type SettlementEvidence,
  xeroCollection,
  xeroInstant,
} from "../_shared/xero_settlement_evidence.ts";
import { incrementalModifiedSince } from "./sync_window.ts";
import { JobMarks } from "./job_marks.ts";

type Get = (
  path: string,
  params: Record<string, string>,
  headers: Record<string, string>,
) => Promise<unknown>;
// Full initial traversal, then provider modification windows with the existing
// 15 minute overlap. Invoice updates do not own payment reconciliation updates.
// Xero does not promise that reconciling a payment moves its UpdatedDateUTC, so
// a complete traversal is repeated whenever the last one is a day old.
export const SETTLEMENT_FULL_REREAD_MS = 24 * 60 * 60 * 1000;
export async function syncSettlementEvidence(
  sb: Pick<SupabaseClient, "from" | "rpc">,
  orgId: string,
  tenantId: string,
  get: Get,
  now = () => new Date(),
) {
  const key = `settlement_evidence:${orgId}:${tenantId}`;
  const fullKey = `settlement_evidence_full:${orgId}:${tenantId}`;
  const { data: cursors, error: cursorError } = await sb.from("xero_sync_state")
    .select("key,cursor_at").in("key", [key, fullKey]);
  if (cursorError || !Array.isArray(cursors)) {
    throw new Error(
      `Settlement cursor read failed: ${cursorError?.message ?? "no rows"}`,
    );
  }
  const cursorAt = (k: string) =>
    cursors.find((c) => c.key === k)?.cursor_at as string | null | undefined;
  const startedAt = now();
  const started = startedAt.toISOString();
  const lastFull = Date.parse(cursorAt(fullKey) ?? "");
  const fullDue = !Number.isFinite(lastFull) ||
    startedAt.getTime() - lastFull >= SETTLEMENT_FULL_REREAD_MS;
  const since = fullDue
    ? undefined
    : incrementalModifiedSince(cursorAt(key), startedAt.getTime());
  const headers: Record<string, string> = since
    ? { "If-Modified-Since": since }
    : {};
  const rows: SettlementEvidence[] = [];
  const seen = new Set<string>();
  let pages = 0;
  for (let page = 1;; page++) {
    // A bound refuses completion; it never drops the remainder or advances the cursor.
    if (page > 100) {
      throw new Error(
        "Settlement payment traversal limit reached; cursor retained",
      );
    }
    const data = await get("/Payments", {
      where: 'PaymentType=="ACCRECPAYMENT"',
      page: String(page),
      pageSize: "100",
      order: "PaymentID ASC",
    }, headers);
    const payments = xeroCollection(data, "Payments");
    if (payments.length > 100) {
      throw new Error("Xero Payments exceeded page size");
    }
    pages++;
    for (const payment of payments) {
      const row = projectXeroSettlementEvidence(
        payment,
        "payment",
        orgId,
        tenantId,
        started,
      );
      if (seen.has(row.provider_id)) {
        throw new Error(
          "Xero Payments changed during traversal; duplicate identity, cursor retained",
        );
      }
      seen.add(row.provider_id);
      rows.push(row);
    }
    if (payments.length < 100) break;
  }
  // BatchPayments is NOT paginated in Xero's contract. Keep each complete
  // receipt batch and its Payments array, never multiply TotalAmount by allocations.
  const batches = xeroCollection(
    await get("/BatchPayments", {
      where: 'Type=="RECBATCH"',
      order: "BatchPaymentID ASC",
    }, headers),
    "BatchPayments",
  );
  const batchIds = new Set<string>();
  for (const batch of batches) {
    const row = projectXeroSettlementEvidence(
      batch,
      "batch_payment",
      orgId,
      tenantId,
      started,
    );
    if (batchIds.has(row.provider_id)) {
      throw new Error("Xero BatchPayments returned duplicate identity");
    }
    batchIds.add(row.provider_id);
    rows.push(row);
  }
  // Only write after both provider reads completed. A partial persistence failure
  // leaves the cursor in place, so the next normal sync repeats the same window.
  // P0-08.5: invoice/material/credit writes already have merged source triggers.
  // Settlement snapshots have none. Share the existing OFF-by-default profit
  // refresh switch; no new install, schedule or provider request is introduced.
  let marksOn = false;
  try {
    const { data, error } = await sb.from("feature_flags").select("enabled")
      .eq("flag_name", "job_profit_refresh_v1").maybeSingle();
    marksOn = !error && data?.enabled === true;
  } catch { /* Missing/unreadable switch retains the existing sync. */ }
  const changedInvoices = new Set<string>();
  let markReadSkipped: string | null = null;
  let jobMarks: { marked: number; skipped: string | null } = {
    marked: 0,
    skipped: null,
  };
  try {
    for (let offset = 0; offset < rows.length; offset += 100) {
      const batch = rows.slice(offset, offset + 100);
      let changed: SettlementEvidence[] = [];
      if (marksOn) {
        try {
          // Composite primary key: org, tenant, kind, provider id. Split kinds
          // so each read fixes the full leading prefix and at most 100 ids.
          for (const kind of ["payment", "batch_payment"] as const) {
            const incoming = batch.filter((r) => r.record_type === kind);
            if (!incoming.length) continue;
            const { data, error } = await sb.from("xero_settlement_evidence")
              .select("*").eq("org_id", orgId).eq("tenant_id", tenantId)
              .eq("record_type", kind).in(
                "provider_id",
                incoming.map((r) => r.provider_id),
              );
            if (error || !Array.isArray(data)) throw new Error("evidence read");
            const prior = new Map(
              data.map((r) => [r.provider_id, r as SettlementEvidence]),
            );
            for (const row of incoming) {
              const old = prior.get(row.provider_id);
              // The existing BEFORE UPDATE guard keeps a newer concurrent copy.
              if (old && Date.parse(old.captured_at) > startedAt.getTime()) {
                continue;
              }
              if (!old || evidenceSignature(old) !== evidenceSignature(row)) {
                if (old) changed.push(old);
                changed.push(row);
              }
            }
          }
        } catch {
          changed = [];
          markReadSkipped = "evidence_unreadable";
          console.error(
            "[xero-sync] Settlement job marks: evidence unreadable",
          );
        }
      }
      const { error } = await sb.from("xero_settlement_evidence").upsert(
        batch,
        {
          onConflict: "org_id,tenant_id,record_type,provider_id",
        },
      );
      if (error) {
        throw new Error(`Settlement evidence write failed: ${error.message}`);
      }
      for (const row of changed) {
        if (row.invoice_id) changedInvoices.add(row.invoice_id);
        for (
          const allocation of row.record_type === "batch_payment" &&
              Array.isArray(row.raw_json.Payments)
            ? row.raw_json.Payments
            : []
        ) {
          const invoice =
            (allocation as { Invoice?: { InvoiceID?: unknown } } | null)
              ?.Invoice;
          if (typeof invoice?.InvoiceID === "string") {
            changedInvoices.add(invoice.InvoiceID.toLowerCase());
          }
        }
      }
    }
    const updatedAt = now().toISOString();
    const note =
      `Payments ${seen.size}; receipt batches ${batchIds.size}; complete provider traversal`;
    const { error } = await sb.from("xero_sync_state").upsert([
      { key, cursor_at: started, updated_at: updatedAt, note },
      ...(since ? [] : [{
        key: fullKey,
        cursor_at: started,
        updated_at: updatedAt,
        note,
      }]),
    ], { onConflict: "key" });
    if (error) {
      throw new Error(`Settlement cursor write failed: ${error.message}`);
    }
  } finally {
    // A later batch/cursor refusal must not strand marks for earlier committed
    // snapshots: their retry is unchanged and would correctly add no new mark.
    const marks = new JobMarks();
    const invoiceIds = [...changedInvoices];
    for (let offset = 0; offset < invoiceIds.length; offset += 50) {
      try {
        // xero_invoices_xero_invoice_id_idx. Resolve the current office-owned
        // job link; never infer a job from the payment's words or a client name.
        const { data, error } = await sb.from("xero_invoices")
          .select("xero_invoice_id,job_id").eq("org_id", orgId)
          .in("xero_invoice_id", invoiceIds.slice(offset, offset + 50));
        if (error || !Array.isArray(data)) throw new Error("invoice read");
        for (const row of data) marks.add(row.job_id, "xero_payment");
      } catch {
        markReadSkipped = "invoices_unreadable";
        console.error("[xero-sync] Settlement job marks: invoices unreadable");
      }
    }
    jobMarks = await marks.flush(sb);
  }
  return {
    success: true,
    payments: seen.size,
    batches: batchIds.size,
    payment_pages: pages,
    modified_since: since ?? null,
    full_reread: !since,
    captured_at: started,
    ...(marksOn
      ? {
        job_marks: {
          ...jobMarks,
          skipped: jobMarks.skipped ?? markReadSkipped,
        },
      }
      : {}),
  };
}

// PostgreSQL jsonb may reorder keys; observation time alone is not a change.
function evidenceSignature(row: SettlementEvidence): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
          .map(([key, item]) => [key, canonical(item)]),
      );
    }
    return value;
  };
  const { captured_at: _observed, provider_updated_at, amount, ...facts } = row;
  // PostgREST and the provider projection can spell the same instant differently.
  return JSON.stringify(canonical({
    ...facts,
    amount: amount === null ? null : Number(amount),
    provider_updated_at: xeroInstant(provider_updated_at) ??
      provider_updated_at,
  }));
}
