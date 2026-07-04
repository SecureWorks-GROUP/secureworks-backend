// deno-lint-ignore-file no-explicit-any
// ════════════════════════════════════════════════════════════
// MAKE-SAFE INTAKE — EXTRACT-AT-MOST-ONCE marker helpers (cost leak fix)
// Mission: makesafe/intake-scanned-marker (Auto-Intake v2)
// ════════════════════════════════════════════════════════════
//
// The scan re-extracted the same NON-work-order emails every cycle (they never create a
// draft, so the draft-level dedup had nothing to match). These two helpers implement the
// fix and are the testable seams for it:
//   scanMarkEligible — WHEN an email may be marked scanned (extract-at-most-once rule).
//   markEmailsScanned — the batched, chunked, pre-migration-safe, idempotent DB write.

export interface ScanMarkState {
  /** A deterministic template full-parse succeeded (no model call). */
  templateParsed: boolean;
  /** The classifier returned a usable, parseable JSON result. */
  modelValidResult: boolean;
  /** The classifier call failed auth for THIS email (dead key). */
  authFailed: boolean;
  /** The classifier call failed transiently (network / 5xx / bad JSON). */
  transientFailed: boolean;
  /** The key is dead/absent, so the model was not called for this email. */
  keyDegradedOrAbsent: boolean;
}

/**
 * The extract-at-most-once rule: mark an email scanned ONLY when it received a usable
 * classification (a valid model result OR a deterministic template parse). NEVER mark on
 * an auth/transient failure or a dead/absent key — those must retry when the key
 * recovers, preserving the fail-loud backfill path and the dead-key health behaviour.
 */
export function scanMarkEligible(s: ScanMarkState): boolean {
  if (s.authFailed || s.transientFailed || s.keyDegradedOrAbsent) return false;
  return s.templateParsed || s.modelValidResult;
}

/** Split ids into chunks; post_ids are long, so an unbounded .in() list would blow the
 * PostgREST gateway URL cap. */
export function partitionForMark<T>(items: T[], chunkSize: number): T[][] {
  const size = Math.max(1, chunkSize);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface MarkResult {
  marked: number;
  attempted: boolean;
  errorChunks: number;
}

/**
 * Stamp makesafe_scanned_at=now() on the given email post_ids. Batched + chunked;
 * guarded by `.is('makesafe_scanned_at', null)` so it is IDEMPOTENT (only unmarked rows
 * change); error-CHECKED (supabase-js returns {error} without throwing — a failed chunk
 * is logged and left for the next run, never crashes the scan). Skipped entirely when
 * the column isn't available yet (pre-migration) — the marker activates the moment the
 * migration is hand-applied.
 */
export async function markEmailsScanned(
  client: any,
  postIds: string[],
  opts: { columnAvailable: boolean; nowIso?: string; chunkSize?: number },
): Promise<MarkResult> {
  if (!opts.columnAvailable || !postIds || postIds.length === 0) {
    return { marked: 0, attempted: false, errorChunks: 0 };
  }
  const nowIso = opts.nowIso || new Date().toISOString();
  const chunks = partitionForMark(postIds, opts.chunkSize ?? 30);
  let marked = 0;
  let errorChunks = 0;
  for (const chunk of chunks) {
    try {
      const { error } = await client.from("emails")
        .update({ makesafe_scanned_at: nowIso })
        .in("post_id", chunk)
        .is("makesafe_scanned_at", null);
      if (error) {
        errorChunks++;
        console.warn("[ops-api] intake scanned-marker update failed (chunk retries next run):", error.message);
      } else {
        marked += chunk.length;
      }
    } catch (e) {
      errorChunks++;
      console.warn("[ops-api] intake scanned-marker update threw (non-fatal):", (e as Error).message);
    }
  }
  return { marked, attempted: true, errorChunks };
}
