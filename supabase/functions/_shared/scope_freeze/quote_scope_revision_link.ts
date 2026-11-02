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
// a caller-supplied pdf_url. Slice 1b (bottom of this file) adds the producer
// contract agreed with Sales: a Scope Engine producer names the frozen row it
// rendered from as source_scope_revision_id on the send body. Until a producer
// passes it (the legacy tools/fencing send never does), every send stores null.
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

// ── JP-24 slice 1b: the frozen revision the producer names ──
//
// Contract with Sales (PR #1207, comment 6497114720): a Scope Engine producer
// freezes the scope, reads the frozen row back and renders the quote from that
// sealed revision before any send, so it knows that row's id at render time.
// It passes the id as `source_scope_revision_id` on the send body (send-quote
// /send and /send-runs, and the ops-api quick quote).
//
// The consumer never takes a hash from the caller. It reads that one row
// (id, job_id, status and the two hashes), once, bounded, started as soon as
// the request body is parsed and before any send await. It accepts the row
// only when it belongs to the job being sent and is `frozen` at that read, and
// then stores that row's id. The row's own scope_hash and pricing_hash are the
// sent document's provenance; checking them against the same row would be a
// tautology, and checking them against the job's CURRENT frozen row (the slice 1
// hash rule) is exactly the re-read the P2 review refused: a refreeze to B while
// the send is in flight would turn A's quote into null, or into B's id when the
// two hashes happen to match. So a named, accepted row is stored as itself.
// Everything else (no id, a malformed id, another job's row, a row that is not
// frozen, a missing row, a failed or slow read) stores null. Since the D1 fix
// (F1) the senders also judge the named read before the email
// (sealedSendSource, bottom of this file): such a send is refused, so a null
// link on the named path is only reachable by a caller that skips that step.

export type NamedScopeRevision = {
  id: string
  job_id: string
  scope_hash: string
  pricing_hash: string
  // Only with { withFrozenBlobs: true }: the revision's own frozen scope and
  // pricing, parsed from its canonical texts and re-hashed to its stored
  // hashes. The send builds the crew pack and the release record from these.
  scope_json?: Record<string, unknown>
  pricing_json?: Record<string, unknown>
}

export type NamedScopeRevisionReason =
  | 'named_revision_read'
  | 'named_id_absent'
  | 'named_id_malformed'
  | 'named_revision_read_failed'
  | 'named_revision_missing'
  | 'named_revision_not_frozen'
  | 'named_revision_row_malformed'
  | 'named_revision_read_timed_out'
  | 'named_revision_read_threw'

export type NamedScopeRevisionRead =
  | { revision: NamedScopeRevision; reason: 'named_revision_read'; named_id: string }
  | { revision: null; reason: Exclude<NamedScopeRevisionReason, 'named_revision_read'>; named_id?: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True when the send body names no revision at all (the legacy senders). */
export function namedScopeRevisionAbsent(raw: unknown): boolean {
  return raw === undefined || raw === null
}

// A frozen canonical text parsed back, accepted only when it re-hashes to the
// row's stored hash (the same canonicalJsonAndHash freeze_scope used).
async function frozenBlobFromCanonicalText(text: unknown, hash: string): Promise<Record<string, unknown> | null> {
  if (typeof text !== 'string' || !text) return null
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return null }
  if (!isPlainObjectWithKeys(parsed)) return null
  const again = await canonicalJsonAndHash(parsed)
  return again.hash === hash ? parsed : null
}

async function readNamedScopeRevisionOnce(client: any, id: string, withFrozenBlobs: boolean): Promise<NamedScopeRevisionRead> {
  try {
    const { data, error } = await client.from('scope_revisions')
      .select(withFrozenBlobs
        ? 'id, job_id, status, scope_hash, pricing_hash, scope_canonical_text, pricing_canonical_text'
        : 'id, job_id, status, scope_hash, pricing_hash')
      .eq('id', id)
      .maybeSingle()
    if (error) return { revision: null, reason: 'named_revision_read_failed', named_id: id }
    if (!data) return { revision: null, reason: 'named_revision_missing', named_id: id }
    const row = data as Record<string, unknown>
    if (row.id !== id || typeof row.job_id !== 'string' || !row.job_id
        || typeof row.scope_hash !== 'string' || !HEX64.test(row.scope_hash)
        || typeof row.pricing_hash !== 'string' || !HEX64.test(row.pricing_hash)) {
      return { revision: null, reason: 'named_revision_row_malformed', named_id: id }
    }
    if (row.status !== 'frozen') return { revision: null, reason: 'named_revision_not_frozen', named_id: id }
    const revision: NamedScopeRevision = { id, job_id: row.job_id, scope_hash: row.scope_hash, pricing_hash: row.pricing_hash }
    if (withFrozenBlobs) {
      const scope = await frozenBlobFromCanonicalText(row.scope_canonical_text, row.scope_hash)
      const pricing = await frozenBlobFromCanonicalText(row.pricing_canonical_text, row.pricing_hash)
      if (!scope || !pricing) return { revision: null, reason: 'named_revision_row_malformed', named_id: id }
      revision.scope_json = scope
      revision.pricing_json = pricing
    }
    return { revision, reason: 'named_revision_read', named_id: id }
  } catch {
    return { revision: null, reason: 'named_revision_read_threw', named_id: id }
  }
}

/**
 * Start the one bounded read of the revision a send body names. Call it with
 * the raw body value as soon as the body is parsed, before any send await, and
 * await the promise only at the quote_revisions insert. The promise never
 * rejects. With no id it reads nothing.
 */
export function startNamedScopeRevisionRead(
  client: any,
  raw: unknown,
  opts: { timeoutMs?: number; withFrozenBlobs?: boolean } = {},
): Promise<NamedScopeRevisionRead> {
  if (namedScopeRevisionAbsent(raw)) return Promise.resolve({ revision: null, reason: 'named_id_absent' })
  if (typeof raw !== 'string' || !UUID.test(raw)) {
    return Promise.resolve({ revision: null, reason: 'named_id_malformed' })
  }
  const id = raw.toLowerCase()
  const timeoutMs = opts.timeoutMs ?? QUOTE_SCOPE_REVISION_LINK_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<NamedScopeRevisionRead>((resolve) => {
    timer = setTimeout(() => resolve({ revision: null, reason: 'named_revision_read_timed_out', named_id: id }), timeoutMs)
  })
  return Promise.race([readNamedScopeRevisionOnce(client, id, opts.withFrozenBlobs === true), timedOut])
    .catch((): NamedScopeRevisionRead => ({ revision: null, reason: 'named_revision_read_threw', named_id: id }))
    .finally(() => { if (timer !== undefined) clearTimeout(timer) })
}

/**
 * What a quote_revisions writer stores. With a named revision (the promise from
 * startNamedScopeRevisionRead) it stores that row's id only when the read
 * accepted it and the row belongs to `jobId`; it never falls back to another
 * rule. With none, the slice 1 rule over the sent document's provenance
 * (quoteScopeRevisionIdForSend) answers. Never throws; logs one ids-only line
 * whenever the named path answers null.
 */
export async function quoteScopeRevisionIdForRelease(
  client: any,
  jobId: string,
  source: {
    named?: Promise<NamedScopeRevisionRead> | null
    sent?: SentQuoteSourceHashes | null
  },
  ctx: { handler: string },
  opts: { timeoutMs?: number } = {},
): Promise<string | null> {
  let read: NamedScopeRevisionRead | null = null
  try {
    read = source.named ? await source.named : null
  } catch {
    read = { revision: null, reason: 'named_revision_read_threw' }
  }
  if (read === null || read.reason === 'named_id_absent') {
    return quoteScopeRevisionIdForSend(client, jobId, source.sent ?? null, ctx, opts)
  }
  let reason: string = read.reason
  if (read.revision) {
    if (read.revision.job_id === jobId) return read.revision.id
    reason = 'named_revision_other_job'
  }
  try {
    console.log('[quote-scope-revision-link]', JSON.stringify({
      job_id: jobId,
      handler: ctx.handler,
      reason,
      ...(read.named_id ? { named_revision_id: read.named_id } : {}),
      stored: null,
    }))
  } catch { /* logging never fails a send */ }
  return null
}

// ── D1 fix F1: everything a named send builds comes from the named revision ──
//
// Business rule: when the sender names sealed revision A, the customer PDF
// (rendered by the producer from A), the crew trade pack, the release record's
// pricing and the expected cost all come from A. A save_scope from another
// device between sealing and sending only changes jobs.scope_json /
// pricing_json (B); A stays frozen. So the send builds from A's own frozen
// texts, never from the live job, and a racing save cannot reach the pack.
//
// When the named revision cannot be proven (malformed id, missing, another
// job's row, superseded by a newer seal, a corrupt row, a failed or slow read)
// the send is refused before any email, with a reason the office can act on.
// Legacy senders name nothing and keep today's live-job behaviour.

export type SealedSendSource =
  | { kind: 'legacy' }
  | { kind: 'sealed'; revision_id: string; scope_json: Record<string, unknown>; pricing_json: Record<string, unknown> }
  | { kind: 'refused'; status: 400 | 409 | 503; body: { error: string; code: string; reason: string } }

/**
 * Decide what a send builds from, given the awaited result of
 * startNamedScopeRevisionRead(..., { withFrozenBlobs: true }) and the job
 * being sent. Pure; never throws.
 */
export function sealedSendSource(read: NamedScopeRevisionRead | null | undefined, jobId: string | null | undefined): SealedSendSource {
  if (!read || read.reason === 'named_id_absent') return { kind: 'legacy' }
  const rev = read.revision
  if (rev && rev.job_id === jobId && rev.scope_json && rev.pricing_json) {
    return { kind: 'sealed', revision_id: rev.id, scope_json: rev.scope_json, pricing_json: rev.pricing_json }
  }
  const reason = rev ? (rev.job_id !== jobId ? 'named_revision_other_job' : 'named_revision_row_malformed') : read.reason
  if (reason === 'named_id_malformed') {
    return { kind: 'refused', status: 400, body: {
      error: 'source_scope_revision_id is not a revision id. Nothing was sent.',
      code: 'sealed_revision_id_malformed', reason,
    } }
  }
  if (reason === 'named_revision_read_failed' || reason === 'named_revision_read_timed_out' || reason === 'named_revision_read_threw') {
    return { kind: 'refused', status: 503, body: {
      error: 'Could not read the sealed quote revision this send names. Nothing was sent. Try again.',
      code: 'sealed_revision_read_failed', reason,
    } }
  }
  return { kind: 'refused', status: 409, body: {
    error: 'The sealed quote revision this send names is not this job\'s current sealed revision (it was replaced, removed or belongs to another job). Nothing was sent. Reopen the quote, seal it again and resend.',
    code: 'sealed_revision_conflict', reason,
  } }
}

/**
 * The scope and pricing a send builds its crew pack and release record from:
 * the sealed revision's own frozen blobs when the send names one, otherwise
 * (legacy senders) the live job's.
 */
export function quoteSendBuildSource(
  sealed: SealedSendSource,
  live: { scope_json?: unknown; pricing_json?: unknown } | null | undefined,
): { scope_json: unknown; pricing_json: unknown } {
  if (sealed.kind === 'sealed') return { scope_json: sealed.scope_json, pricing_json: sealed.pricing_json }
  return { scope_json: live?.scope_json ?? null, pricing_json: live?.pricing_json ?? null }
}
