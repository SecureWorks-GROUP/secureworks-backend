// Scope-Memory-Saving Loop 1, step 6 — hash-verified scope_revision_id citation.
//
// Codex stop-time review (2026-05-04) caught that returning the "latest
// frozen scope_revisions row" without further checking can cite a stale
// revision: the operator may have edited jobs.scope_json AFTER freezing v(N)
// (either via cloneScopeForEdit + live edit, or a direct save_scope path
// that bypasses the freeze flow). At quote-send time the V2 packet's
// scope_snapshot_json reflects the live edits, but a naive lookup would
// stamp scope_revision_id = v(N).id — making the citation a lie because
// canonical-hash(jobs.scope_json) no longer equals v(N).scope_hash.
//
// This helper closes that gap by VERIFYING the citation:
//   1. SELECT the latest status='frozen' row for the job (id + scope_hash +
//      pricing_hash + revision_number).
//   2. canonical-hash the live jobs.scope_json + pricing_json with the same
//      `canonicalJsonAndHash` the freeze flow uses.
//   3. Cite the row only when BOTH hashes match. Otherwise return null and
//      log a structured warning so an operator (or later T7 audit) can spot
//      jobs where the live scope drifted from the frozen citation.
//
// Returning null is safe: pre-step-6 callers, Quick Quote, and any "no
// frozen revision yet" job already wrote null. The Cap 0 V2 enforce-mode
// flip (separate future gate) is the only path that would refuse a
// non-Quick-Quote release lacking a citation; until then, null citations
// continue to ship as soft warnings in mode='warn'.

import { canonicalJsonAndHash } from './canonicalize.ts'

export type ResolveScopeRevisionCitationInput = {
  job_id: string
  scope_json: Record<string, unknown> | null
  pricing_json: Record<string, unknown> | null
}

export type ResolveScopeRevisionCitationResult = {
  // The verified citation id when live scope+pricing hash-match the latest
  // frozen row. Null otherwise (no frozen row, drift, or DB error).
  scope_revision_id: string | null
  // Structured outcome for logging/observability. Callers (send-quote)
  // already log to console; this lets future test/observability code
  // assert which branch fired without parsing log lines.
  reason:
    | 'no_jobs_input'        // scope_json or pricing_json was null
    | 'no_frozen_revision'   // table empty for this job, or only drafts
    | 'verified'             // happy path — hashes match
    | 'scope_hash_mismatch'  // live scope drifted from frozen
    | 'pricing_hash_mismatch'// live pricing drifted from frozen
    | 'db_error'             // SELECT failed
    | 'hash_error'           // canonicalJsonAndHash threw (shouldn't)
  // Diagnostic detail for log lines. Always populated when reason !== 'verified'.
  detail?: {
    latest_frozen_id?: string
    latest_frozen_revision_number?: number
    live_scope_hash?: string
    frozen_scope_hash?: string
    live_pricing_hash?: string
    frozen_pricing_hash?: string
    error_message?: string
  }
}

export async function resolveScopeRevisionCitation(
  sb: any,
  input: ResolveScopeRevisionCitationInput,
): Promise<ResolveScopeRevisionCitationResult> {
  if (!input.scope_json || !input.pricing_json) {
    return { scope_revision_id: null, reason: 'no_jobs_input' }
  }

  // 1. Latest frozen row.
  type FrozenRow = { id: string; revision_number: number; scope_hash: string; pricing_hash: string }
  let row: FrozenRow | null = null
  try {
    const { data, error } = await sb.from('scope_revisions')
      .select('id, revision_number, scope_hash, pricing_hash')
      .eq('job_id', input.job_id)
      .eq('status', 'frozen')
      .order('revision_number', { ascending: false })
      .limit(1)
    if (error) {
      return {
        scope_revision_id: null,
        reason: 'db_error',
        detail: { error_message: String(error.message ?? error) },
      }
    }
    const rows = (data as FrozenRow[] | null) ?? []
    row = rows[0] ?? null
  } catch (e: any) {
    return {
      scope_revision_id: null,
      reason: 'db_error',
      detail: { error_message: String(e?.message ?? e) },
    }
  }
  if (!row) {
    return { scope_revision_id: null, reason: 'no_frozen_revision' }
  }

  // 2. Canonical-hash the live scope + pricing the same way scope_freeze does.
  let live_scope_hash: string
  let live_pricing_hash: string
  try {
    const scopeHashOut = await canonicalJsonAndHash(input.scope_json)
    const pricingHashOut = await canonicalJsonAndHash(input.pricing_json)
    live_scope_hash = scopeHashOut.hash
    live_pricing_hash = pricingHashOut.hash
  } catch (e: any) {
    return {
      scope_revision_id: null,
      reason: 'hash_error',
      detail: { error_message: String(e?.message ?? e) },
    }
  }

  // 3. Both hashes must match for the citation to be honest.
  if (live_scope_hash !== row.scope_hash) {
    return {
      scope_revision_id: null,
      reason: 'scope_hash_mismatch',
      detail: {
        latest_frozen_id: row.id,
        latest_frozen_revision_number: row.revision_number,
        live_scope_hash,
        frozen_scope_hash: row.scope_hash,
      },
    }
  }
  if (live_pricing_hash !== row.pricing_hash) {
    return {
      scope_revision_id: null,
      reason: 'pricing_hash_mismatch',
      detail: {
        latest_frozen_id: row.id,
        latest_frozen_revision_number: row.revision_number,
        live_pricing_hash,
        frozen_pricing_hash: row.pricing_hash,
      },
    }
  }

  return { scope_revision_id: row.id, reason: 'verified' }
}
