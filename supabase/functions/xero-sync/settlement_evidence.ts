// Same Deno URL dependency as the owning edge entrypoints.
// deno-lint-ignore no-import-prefix
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  projectXeroSettlementEvidence,
  type SettlementEvidence,
  xeroCollection,
} from "../_shared/xero_settlement_evidence.ts";
import { incrementalModifiedSince } from "./sync_window.ts";

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
  sb: Pick<SupabaseClient, "from">,
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
  for (let offset = 0; offset < rows.length; offset += 100) {
    const { error } = await sb.from("xero_settlement_evidence").upsert(
      rows.slice(offset, offset + 100),
      {
        onConflict: "org_id,tenant_id,record_type,provider_id",
      },
    );
    if (error) {
      throw new Error(`Settlement evidence write failed: ${error.message}`);
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
  return {
    success: true,
    payments: seen.size,
    batches: batchIds.size,
    payment_pages: pages,
    modified_since: since ?? null,
    full_reread: !since,
    captured_at: started,
  };
}
