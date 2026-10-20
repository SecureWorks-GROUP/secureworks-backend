import { canonicalJsonAndHash } from './release_packet/canonicalize.ts'

// Server-side quote pricing gate, shared by every quote send route:
// send-quote `/send` and `/send-runs`, and ops-api `send_quick_quote_email`.
//
// Returns the reason a quote must NOT be sent, or null when it may.
//
// Every check is strict (`=== false`, a non-empty list) so a quote that never
// carried a flag (legacy quotes, older tool copies) is judged on its total
// alone, exactly as before. Only a flag the scoping tool set refuses.
//
// The scoping tools write these flags into pricing_json (CFO pricing receipt,
// 20 Oct 2026, rule A: no quote is sent while pricing is incomplete):
// - pricing_validation_passed: false   the tool's own validation failed
// - pricing_complete: false            a sell price or a cost line is unknown
// - sell_to_confirm: [names]           sell prices still to confirm
// - internal.costs_complete: false     cost lines with no price
// - revision.sealed: false             the quote was changed after its last seal
export function quotePricingGateError(pricingJsonRaw: unknown): string | null {
  // deno-lint-ignore no-explicit-any
  let pj: any = {}
  try {
    pj = typeof pricingJsonRaw === 'string' ? JSON.parse(pricingJsonRaw || '{}') : (pricingJsonRaw || {})
  } catch {
    return 'Quote pricing is missing or invalid. Re-open the job in the scoping tool and re-save before sending.'
  }
  if (!pj || typeof pj !== 'object') {
    return 'Quote pricing is missing or invalid. Re-open the job in the scoping tool and re-save before sending.'
  }
  if (pj.pricing_validation_passed === false) {
    return 'Quote failed pricing validation in the scoping tool and cannot be sent. Fix the flagged pricing issues, re-save, and try again.'
  }
  const sellToConfirm = Array.isArray(pj.sell_to_confirm)
    ? pj.sell_to_confirm.filter((s: unknown) => typeof s === 'string' && s.trim() !== '')
    : []
  if (sellToConfirm.length) {
    return `Quote has sell prices still to confirm (${sellToConfirm.join(', ')}). Confirm them in the scoping tool, re-save, and try again.`
  }
  const internal = pj.internal && typeof pj.internal === 'object' ? pj.internal : null
  if (internal && internal.costs_complete === false) {
    const n = Array.isArray(internal.costs_to_confirm) ? internal.costs_to_confirm.length : 0
    return `Quote has ${n > 0 ? n + ' ' : ''}cost line${n === 1 ? '' : 's'} with no price yet. Price them in the scoping tool, re-save, and try again.`
  }
  if (pj.pricing_complete === false) {
    return 'Quote pricing is not complete in the scoping tool. Finish the pricing, re-save, and try again.'
  }
  const revision = pj.revision && typeof pj.revision === 'object' ? pj.revision : null
  if (revision && revision.sealed === false) {
    return 'Quote was changed after its last sealed revision. Seal the new revision in the scoping tool, re-save, and try again.'
  }
  const total = Number(pj.totalIncGST ?? pj.total ?? pj.grandTotal ?? 0)
  if (!(total > 0)) {
    return 'Quote total is zero or missing. Set pricing on the job in the scoping tool before sending.'
  }
  return null
}

// ── Frozen revision gate ─────────────────────────────────────────────────
// A quote whose pricing carries a sealed scoping-tool revision
// (`pricing_json.revision.sealed === true`, written by the fence and patio
// tools) may be sent only when the job has a frozen `scope_revisions` row
// whose `pricing_hash` equals the hash of the pricing being sent. That row is
// what Dispatch and Job Profit read, so the customer can never receive a
// price those readers do not hold.
//
// The hash is the one `freeze_scope` stores: `canonicalJsonAndHash` over the
// raw `jobs.pricing_json` value. Pass the raw column value, not a re-parsed
// copy, so the two hashes are taken over the same input.
//
// Fails closed: a read error, no frozen row, or a different hash all refuse.
// Pricing with no sealed revision (legacy quotes, quick quotes, tools that do
// not seal) is unaffected and returns null, exactly as before.


export const FROZEN_REVISION_REQUIRED_ERROR =
  'This quote has no frozen revision on the server. Send it again from the scoping tool so the revision is frozen first.'
export const FROZEN_REVISION_MISMATCH_ERROR =
  'This quote has changed since its revision was frozen. Send it again from the scoping tool so the new revision is frozen first.'
export const FROZEN_REVISION_UNREADABLE_ERROR =
  'The frozen revision for this quote could not be checked. Nothing was sent; try again shortly.'

type FrozenRow = { pricing_hash?: string | null }
// deno-lint-ignore no-explicit-any
type FrozenRevisionReader = (jobId: string) => Promise<{ rows: FrozenRow[] | null; error: any }>

export function quoteRequiresFrozenRevision(pricingJsonRaw: unknown): boolean {
  // deno-lint-ignore no-explicit-any
  let pj: any = null
  try {
    pj = typeof pricingJsonRaw === 'string' ? JSON.parse(pricingJsonRaw || '{}') : pricingJsonRaw
  } catch {
    return false
  }
  return !!(pj && typeof pj === 'object' && pj.revision && typeof pj.revision === 'object' && pj.revision.sealed === true)
}

export async function quoteFrozenRevisionGateError(
  readFrozen: FrozenRevisionReader,
  jobId: string | null | undefined,
  pricingJsonRaw: unknown,
): Promise<string | null> {
  if (!quoteRequiresFrozenRevision(pricingJsonRaw)) return null
  if (!jobId) return FROZEN_REVISION_REQUIRED_ERROR
  let res
  try {
    res = await readFrozen(jobId)
  } catch {
    return FROZEN_REVISION_UNREADABLE_ERROR
  }
  if (!res || res.error || !Array.isArray(res.rows)) return FROZEN_REVISION_UNREADABLE_ERROR
  if (res.rows.length === 0) return FROZEN_REVISION_REQUIRED_ERROR
  const { hash } = await canonicalJsonAndHash(pricingJsonRaw)
  return res.rows.some((r) => r && r.pricing_hash === hash) ? null : FROZEN_REVISION_MISMATCH_ERROR
}

// The production reader: the job's frozen rows (at most one by invariant).
// deno-lint-ignore no-explicit-any
export function frozenRevisionReader(client: any): FrozenRevisionReader {
  return async (jobId: string) => {
    const { data, error } = await client.from('scope_revisions')
      .select('pricing_hash')
      .eq('job_id', jobId)
      .eq('status', 'frozen')
    return { rows: data ?? null, error }
  }
}
