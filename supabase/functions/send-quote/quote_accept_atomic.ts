// SQ-23 remedy slice 1: the public quote acceptance through one database
// transaction (accept_quote_document_atomic, migration 20261019230000).
// Used only while quote_accept_atomic_v1 reads true. Off, missing or
// unreadable keeps today's separate writes in index.ts, unchanged.
// Design: docs/sq23/acceptance-atomic-design.md.
import {
  type QuotePartyDocument,
  type QuoteRunAcceptance,
  quoteDocumentAcceptable,
  quoteDocumentRunLabel,
} from './quote_party_view.ts'

export const QUOTE_ACCEPT_ATOMIC_FLAG = 'quote_accept_atomic_v1'

// Read on every acceptance, never cached: only a readable true selects the
// atomic path.
// deno-lint-ignore no-explicit-any
export async function quoteAcceptAtomicOn(sb: any): Promise<boolean> {
  try {
    const { data, error } = await sb
      .from('feature_flags')
      .select('enabled')
      .eq('flag_name', QUOTE_ACCEPT_ATOMIC_FLAG)
      .limit(1)
    if (error) return false
    return data?.[0]?.enabled === true
  } catch {
    return false
  }
}

export type QuoteAcceptanceSnapshotRead = {
  fingerprint: string
  documents: Array<QuotePartyDocument & { share_token?: string | null }>
  acceptances: QuoteRunAcceptance[]
  runLineItems: Array<{ run_label: string | null; job_contact_id: string | null }>
}

// The decision inputs and their fingerprint, from one database statement.
// null means the read failed: the caller shows the retry page, writes nothing.
// deno-lint-ignore no-explicit-any
export async function readQuoteAcceptanceSnapshot(sb: any, jobId: string): Promise<QuoteAcceptanceSnapshotRead | null> {
  try {
    const { data, error } = await sb.rpc('quote_acceptance_snapshot', { p_job_id: jobId })
    if (error || !data || typeof data.fingerprint !== 'string'
      || !Array.isArray(data.documents) || !Array.isArray(data.acceptances) || !Array.isArray(data.run_line_items)) {
      return null
    }
    return {
      fingerprint: data.fingerprint,
      documents: data.documents,
      acceptances: data.acceptances,
      runLineItems: data.run_line_items,
    }
  } catch {
    return null
  }
}

const sameInstant = (a: unknown, b: unknown) =>
  (a == null && b == null) || (a != null && b != null && new Date(String(a)).getTime() === new Date(String(b)).getTime())

// The document the handler read (by token) must be exactly its snapshot row:
// every field the guards and party rules use, and the current token.
// deno-lint-ignore no-explicit-any
export function quoteDocumentMatchesSnapshot(doc: any, snap: QuoteAcceptanceSnapshotRead, token: string): boolean {
  const row = snap.documents.find((d) => d.id === doc.id)
  if (!row) return false
  return row.share_token === token
    && row.sent_to_client === true
    && (row.job_contact_id ?? null) === (doc.job_contact_id ?? null)
    && (row.run_label ?? null) === (doc.run_label ?? null)
    && quoteDocumentRunLabel(row) === quoteDocumentRunLabel(doc)
    && (row.version ?? null) === (doc.version ?? null)
    && sameInstant(row.sent_at, doc.sent_at)
    && sameInstant(row.send_claimed_at, doc.send_claimed_at)
    && sameInstant(row.accepted_at, doc.accepted_at)
    && sameInstant(row.declined_at, doc.declined_at)
    && sameInstant(row.superseded_at, doc.superseded_at)
    && sameInstant(row.created_at, doc.created_at)
}

// Today's guards (index.ts: superseded, run current-document, whole-quote
// accepted sibling), with each query's filters applied to the snapshot.
export function quoteGuardsPassOnSnapshot(
  // deno-lint-ignore no-explicit-any
  doc: any,
  snap: QuoteAcceptanceSnapshotRead,
  sourceRunLabel: string | null,
): 'ok' | 'superseded' | 'not_current' | 'sibling_accepted' {
  const row = snap.documents.find((d) => d.id === doc.id)
  if (!row || row.superseded_at) return 'superseded'
  const sameContact = (d: QuotePartyDocument) => (d.job_contact_id ?? null) === (doc.job_contact_id ?? null)
  if (sourceRunLabel !== null) {
    const partyDocs = snap.documents.filter((d) =>
      d.sent_to_client === true && !d.superseded_at && sameContact(d)
      && (doc.run_label == null ? d.run_label == null : d.run_label === doc.run_label)
    )
    return quoteDocumentAcceptable(doc, partyDocs) ? 'ok' : 'not_current'
  }
  const siblings = snap.documents.filter((d) =>
    d.run_label == null && d.id !== doc.id && !!d.accepted_at && !d.superseded_at && sameContact(d)
  )
  return quoteDocumentAcceptable(doc, siblings) ? 'ok' : 'sibling_accepted'
}

export type AtomicAcceptInput = {
  documentId: string
  shareToken: string
  requestId: string
  acceptedAt: string
  jobStatus: 'accepted' | 'partially_accepted' | 'quoted'
  fingerprint: string
  runLabel: string | null
  acceptEvent: Record<string, unknown> | null
}

export type AtomicAcceptOutcome =
  | { kind: 'accepted'; recovered: boolean; jobStatus: string }
  | { kind: 'replay' }
  | { kind: 'stale' }
  | { kind: 'refused'; reason: string }
  | { kind: 'failed' }
  | { kind: 'unknown' }

// A database refusal or error (an error carrying a SQLSTATE code) rolled
// everything back: 'failed'. Anything else (a lost or unreadable response)
// does not prove a rollback, so the attempt row is read back by this
// request's id: found means this request committed and its follow-up work is
// still its own to run; another request's row means 'replay'; nothing found,
// after one short wait for an in-flight commit, or a failed read, is
// 'unknown' (the commit may yet have happened).
// deno-lint-ignore no-explicit-any
export async function acceptQuoteDocumentAtomically(sb: any, input: AtomicAcceptInput, waitMs = 1000): Promise<AtomicAcceptOutcome> {
  let data: unknown = null
  try {
    const res = await sb.rpc('accept_quote_document_atomic', {
      p_document_id: input.documentId,
      p_share_token: input.shareToken,
      p_request_id: input.requestId,
      p_accepted_at: input.acceptedAt,
      p_job_status: input.jobStatus,
      p_fingerprint: input.fingerprint,
      p_run_label: input.runLabel,
      p_accept_event: input.acceptEvent,
    })
    if (res.error) {
      const code = String(res.error.code || '')
      if (/^[0-9A-Z]{5}$/.test(code)) return { kind: 'failed' }
      return await recoverAtomicAcceptance(sb, input, waitMs)
    }
    data = res.data
  } catch {
    return await recoverAtomicAcceptance(sb, input, waitMs)
  }
  const result = (data || {}) as { outcome?: string; reason?: string; job_status?: string; request_id?: string }
  switch (result.outcome) {
    case 'accepted':
      if (result.request_id !== input.requestId) return await recoverAtomicAcceptance(sb, input, waitMs)
      return { kind: 'accepted', recovered: false, jobStatus: result.job_status || input.jobStatus }
    case 'replay':
      return { kind: 'replay' }
    case 'stale':
      return { kind: 'stale' }
    case 'refused':
      return { kind: 'refused', reason: result.reason || 'refused' }
    default:
      return await recoverAtomicAcceptance(sb, input, waitMs)
  }
}

// deno-lint-ignore no-explicit-any
async function recoverAtomicAcceptance(sb: any, input: AtomicAcceptInput, waitMs: number): Promise<AtomicAcceptOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, waitMs))
    try {
      const { data, error } = await sb
        .from('quote_acceptance_attempts')
        .select('request_id, job_status')
        .eq('document_id', input.documentId)
        .limit(1)
      if (error) return { kind: 'unknown' }
      const row = data?.[0]
      if (row && row.request_id === input.requestId) return { kind: 'accepted', recovered: true, jobStatus: row.job_status }
      if (row) return { kind: 'replay' }
    } catch {
      return { kind: 'unknown' }
    }
  }
  return { kind: 'unknown' }
}

// Called before each response of an atomic acceptance. It records that the
// handler reached its response, NOT that the follow-up work succeeded (those
// steps keep today's best-effort handling). A no-op on the legacy path
// (documentId null). Failure only leaves the attempt listed for a person.
// deno-lint-ignore no-explicit-any
export async function finishAtomicAcceptance(sb: any, documentId: string | null, requestId: string): Promise<void> {
  if (!documentId) return
  try {
    await sb.rpc('quote_acceptance_handler_finished', { p_document_id: documentId, p_request_id: requestId })
  } catch (e) {
    console.error('[accept] atomic handler not marked finished:', (e as Error).message)
  }
}
