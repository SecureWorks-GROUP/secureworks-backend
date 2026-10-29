// JP-24 slice 1: which frozen scope revision a sent quote was sent from.
//
// Both quote_revisions writers (send-quote recordReleasedQuoteRevision and
// ops-api's quick-quote copy of it) call quoteScopeRevisionIdForSend just
// before their INSERT and store the answer in quote_revisions.scope_revision_id.
//
// Job Profit reads a non-null link as quote-to-scope provenance, so a wrong id
// is worse than none. The link is therefore bound ONLY to the provenance of the
// document that was actually sent: the canonicalJsonAndHash hashes of the exact
// jobs.scope_json and jobs.pricing_json blobs the sent quote was built from,
// captured by the producer of that document before any await of the send
// (sentQuoteSourceHashes). The rule:
//   * no such provenance on the sent document -> null, and nothing is read;
//   * otherwise read the job's frozen scope_revisions rows (id and hashes);
//   * store the one frozen row's id only when BOTH its scope_hash and its
//     pricing_hash equal the sent document's hashes. Anything else is null.
//
// Never done here, on purpose:
//   * re-reading jobs.scope_json / jobs.pricing_json after the send. The job's
//     state then (B) says nothing about the document that went out (A): a save
//     and refreeze between rendering and sending, or during the provider and
//     storage awaits, would link B to a quote built from A (P2 review on #1207).
//   * hashing the manifest's scope_snapshot. It is built for the customer and
//     has different semantics from the stored blobs.
//   * a price search, a timestamp fallback or a "nearest" revision.
//
// Today no sent document carries that provenance: the /send PDF is rendered by
// the scoping tool and stored with no source hashes, and the quick-quote PDF is
// a caller-supplied pdf_url. So every send stores null (unknown) until the
// producer of the sent document records its source hashes and passes them in.
//
// This lookup never blocks, delays past its own bound, or changes a customer
// send. It runs after the email went. Every failure answers null and logs one
// ids-only line: job id, handler, reason, and a revision id when one was read.

import { canonicalJsonAndHash } from '../release_packet/canonicalize.ts'

/** The hashes of the exact blobs a sent quote was built from. */
export type SentQuoteSourceHashes = { scope_hash: string; pricing_hash: string }

export type QuoteScopeRevisionLinkReason =
  | 'matched'
  | 'sent_document_provenance_unavailable'
  | 'sent_document_provenance_malformed'
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
// response waits on the one read. A slow read answers null (unknown).
export const QUOTE_SCOPE_REVISION_LINK_TIMEOUT_MS = 4000

const HEX64 = /^[0-9a-f]{64}$/

// The same precondition freezeScope applies before it hashes: a non-empty
// plain object. A blob freezeScope would refuse can never have been frozen.
function isPlainObjectWithKeys(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length > 0
}

/**
 * For the producer of a quote document: the hashes of the exact scope and
 * pricing blobs it is building the quote from, computed with the function
 * freeze_scope uses. Call it on the blobs in hand BEFORE any await, never on a
 * later read of the job. Null when either blob is not one freeze_scope could
 * have frozen.
 */
export async function sentQuoteSourceHashes(
  scopeJson: unknown,
  pricingJson: unknown,
): Promise<SentQuoteSourceHashes | null> {
  if (!isPlainObjectWithKeys(scopeJson) || !isPlainObjectWithKeys(pricingJson)) return null
  const { hash: scope_hash } = await canonicalJsonAndHash(scopeJson)
  const { hash: pricing_hash } = await canonicalJsonAndHash(pricingJson)
  return { scope_hash, pricing_hash }
}

/**
 * The pure lookup. With no provenance it reads nothing. Otherwise it reads at
 * most two frozen scope_revisions rows of the job (id and the two hashes only).
 * It never reads jobs. Never throws.
 */
export async function resolveQuoteScopeRevisionLink(
  client: any,
  jobId: string,
  sent: SentQuoteSourceHashes | null | undefined,
): Promise<QuoteScopeRevisionLink> {
  if (sent == null) return { scope_revision_id: null, reason: 'sent_document_provenance_unavailable' }
  if (typeof sent.scope_hash !== 'string' || !HEX64.test(sent.scope_hash)
      || typeof sent.pricing_hash !== 'string' || !HEX64.test(sent.pricing_hash)) {
    return { scope_revision_id: null, reason: 'sent_document_provenance_malformed' }
  }
  try {
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

    const scopeOk = sent.scope_hash === rev.scope_hash
    const pricingOk = sent.pricing_hash === rev.pricing_hash
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
 * What a quote_revisions writer stores. `sent` is the provenance the sent
 * document carries (null or undefined when it carries none). Bounded by
 * timeoutMs, never throws, logs one ids-only line whenever the answer is null.
 */
export async function quoteScopeRevisionIdForSend(
  client: any,
  jobId: string,
  sent: SentQuoteSourceHashes | null | undefined,
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
    link = await Promise.race([resolveQuoteScopeRevisionLink(client, jobId, sent), timedOut])
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
