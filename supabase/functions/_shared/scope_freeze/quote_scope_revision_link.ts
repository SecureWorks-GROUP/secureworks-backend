// JP-24 slice 1: which frozen scope revision a sent quote was sent from.
//
// Both quote_revisions writers (send-quote recordReleasedQuoteRevision and
// ops-api's quick-quote copy of it) call quoteScopeRevisionIdForSend just
// before their INSERT and store the answer in quote_revisions.scope_revision_id.
//
// The one match rule (JP-23 r3, JP-24 "Two corrections to the slice 1 scope"):
//   * read the job's single current frozen scope_revisions row
//     (status = 'frozen'; freeze_scope keeps exactly one per job);
//   * recompute canonicalJsonAndHash of the job's CURRENT jobs.scope_json and
//     jobs.pricing_json, the same function freezeScope uses
//     (_shared/scope_freeze/scope_freeze.ts);
//   * store that row's id only when BOTH its scope_hash and its pricing_hash
//     equal the recomputed hashes. Anything else is null, which every reader
//     reads as unknown.
//
// Never hashed: the manifest's scope_snapshot. It is built for the customer and
// can differ from the stored blob. No price search, no timestamp fallback, no
// "nearest" revision: a save after the last freeze leaves the hashes different
// and the honest answer is null.
//
// This lookup never blocks, delays past its own bound, or changes a customer
// send. The release has already happened when it runs (the email went out and
// the row records it). Every failure (a read error, a thrown client, no frozen
// row, several frozen rows, a malformed row, a timeout) answers null and logs
// one ids-only line: job id, handler, reason, and a revision id when one was
// read. No customer data is logged.

import { canonicalJsonAndHash } from '../release_packet/canonicalize.ts'

export type QuoteScopeRevisionLinkReason =
  | 'matched'
  | 'job_read_failed'
  | 'job_not_found'
  | 'job_scope_not_object'
  | 'job_pricing_not_object'
  | 'revision_read_failed'
  | 'no_frozen_revision'
  | 'several_frozen_revisions'
  | 'revision_row_malformed'
  | 'scope_hash_mismatch'
  | 'pricing_hash_mismatch'
  | 'scope_and_pricing_hash_mismatch'
  | 'lookup_threw'
  | 'lookup_timed_out'

export type QuoteScopeRevisionLink =
  | { scope_revision_id: string; reason: 'matched' }
  | { scope_revision_id: null; reason: Exclude<QuoteScopeRevisionLinkReason, 'matched'>; read_revision_id?: string }

// The send has already gone out; this only bounds how long the operator's
// response waits on the two reads. A slow read answers null (unknown).
export const QUOTE_SCOPE_REVISION_LINK_TIMEOUT_MS = 4000

const HEX64 = /^[0-9a-f]{64}$/

// The same precondition freezeScope applies before it hashes: a non-empty
// plain object. A blob freezeScope would refuse can never have been frozen.
function isPlainObjectWithKeys(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length > 0
}

/**
 * The pure lookup. Reads two rows for one job: the job's scope_json and
 * pricing_json (a single-job read, so the blob is allowed), and at most two
 * frozen scope_revisions rows (id and the two hashes only). Never throws.
 */
export async function resolveQuoteScopeRevisionLink(
  client: any,
  jobId: string,
): Promise<QuoteScopeRevisionLink> {
  try {
    const { data: job, error: jobErr } = await client.from('jobs')
      .select('scope_json, pricing_json')
      .eq('id', jobId)
      .maybeSingle()
    if (jobErr) return { scope_revision_id: null, reason: 'job_read_failed' }
    if (!job) return { scope_revision_id: null, reason: 'job_not_found' }
    if (!isPlainObjectWithKeys(job.scope_json)) return { scope_revision_id: null, reason: 'job_scope_not_object' }
    if (!isPlainObjectWithKeys(job.pricing_json)) return { scope_revision_id: null, reason: 'job_pricing_not_object' }

    // limit(2): one row is the answer, a second row is enough to know the
    // job is ambiguous. Ordered so the logged id is stable.
    const { data: revs, error: revErr } = await client.from('scope_revisions')
      .select('id, scope_hash, pricing_hash')
      .eq('job_id', jobId)
      .eq('status', 'frozen')
      .order('revision_number', { ascending: false })
      .limit(2)
    if (revErr) return { scope_revision_id: null, reason: 'revision_read_failed' }
    if (!Array.isArray(revs)) return { scope_revision_id: null, reason: 'revision_read_failed' }
    if (revs.length === 0) return { scope_revision_id: null, reason: 'no_frozen_revision' }
    if (revs.length > 1) return { scope_revision_id: null, reason: 'several_frozen_revisions' }

    const rev = revs[0] as { id?: unknown; scope_hash?: unknown; pricing_hash?: unknown }
    if (typeof rev?.id !== 'string' || !rev.id
        || typeof rev.scope_hash !== 'string' || !HEX64.test(rev.scope_hash)
        || typeof rev.pricing_hash !== 'string' || !HEX64.test(rev.pricing_hash)) {
      return {
        scope_revision_id: null,
        reason: 'revision_row_malformed',
        ...(typeof rev?.id === 'string' && rev.id ? { read_revision_id: rev.id } : {}),
      }
    }

    const { hash: scopeHash } = await canonicalJsonAndHash(job.scope_json)
    const { hash: pricingHash } = await canonicalJsonAndHash(job.pricing_json)
    const scopeOk = scopeHash === rev.scope_hash
    const pricingOk = pricingHash === rev.pricing_hash
    if (scopeOk && pricingOk) return { scope_revision_id: rev.id, reason: 'matched' }
    return {
      scope_revision_id: null,
      reason: !scopeOk && !pricingOk
        ? 'scope_and_pricing_hash_mismatch'
        : !scopeOk ? 'scope_hash_mismatch' : 'pricing_hash_mismatch',
      read_revision_id: rev.id,
    }
  } catch {
    return { scope_revision_id: null, reason: 'lookup_threw' }
  }
}

/**
 * What a quote_revisions writer stores. Bounded by timeoutMs, never throws,
 * logs one ids-only line whenever the answer is null.
 */
export async function quoteScopeRevisionIdForSend(
  client: any,
  jobId: string,
  ctx: { handler: string },
  opts: { timeoutMs?: number } = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? QUOTE_SCOPE_REVISION_LINK_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  let link: QuoteScopeRevisionLink
  try {
    const timedOut = new Promise<QuoteScopeRevisionLink>((resolve) => {
      timer = setTimeout(() => resolve({ scope_revision_id: null, reason: 'lookup_timed_out' }), timeoutMs)
    })
    link = await Promise.race([resolveQuoteScopeRevisionLink(client, jobId), timedOut])
  } catch {
    link = { scope_revision_id: null, reason: 'lookup_threw' }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (link.scope_revision_id === null) {
    try {
      console.log('[quote-scope-revision-link]', JSON.stringify({
        job_id: jobId,
        handler: ctx.handler,
        reason: link.reason,
        ...(link.read_revision_id ? { read_revision_id: link.read_revision_id } : {}),
        stored: null,
      }))
    } catch { /* logging never fails a send */ }
    return null
  }
  return link.scope_revision_id
}
