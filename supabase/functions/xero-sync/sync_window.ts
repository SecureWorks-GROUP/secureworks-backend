// Incremental sync window for /Invoices (2026-09-10).
//
// The loop asks Xero for invoices modified since the newest local updated_at.
// That column was meant to hold Xero's UpdatedDateUTC, but the table trigger
// update_xero_invoices_updated_at overwrites it with now() on every update, so
// in practice the window starts at the end of the previous run. Anything Xero
// changed while that run was in flight (after its fetch, before its last
// write) was never asked for again. Upserts are idempotent, so we simply look
// back a little further than the last write.
export const SYNC_WINDOW_OVERLAP_MS = 15 * 60 * 1000

export function incrementalModifiedSince(lastUpdatedAt: string | null | undefined, now = Date.now(), overlapMs = SYNC_WINDOW_OVERLAP_MS): string | undefined {
  if (!lastUpdatedAt) return undefined
  const t = new Date(lastUpdatedAt).getTime()
  if (!Number.isFinite(t)) return undefined
  // A future timestamp (clock skew, bad parse) must not push the window past now.
  const base = Math.min(t, now)
  return new Date(base - overlapMs).toISOString()
}
