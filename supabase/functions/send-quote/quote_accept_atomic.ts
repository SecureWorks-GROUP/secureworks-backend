// SQ-23 remedy slice 1: the public quote acceptance through one database
// transaction (accept_quote_document_atomic, migration 20261019230000).
// Used only while quote_accept_atomic_v1 reads true. Off, missing or
// unreadable keeps today's separate writes in index.ts, unchanged.
// Design: docs/sq23/acceptance-atomic-design.md.

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

// Read BEFORE any of the reads the party rules decide from. null means the
// read failed: the caller shows the retry page and writes nothing.
// deno-lint-ignore no-explicit-any
export async function readQuoteAcceptanceFingerprint(sb: any, jobId: string): Promise<string | null> {
  try {
    const { data, error } = await sb.rpc('quote_acceptance_fingerprint', { p_job_id: jobId })
    if (error || typeof data !== 'string') return null
    return data
  } catch {
    return null
  }
}

export type AtomicAcceptInput = {
  documentId: string
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

// One call. A database refusal or error rolls everything back. A transport
// error does not prove a rollback, so the attempt row is read back: if it
// exists this request's acceptance committed, and its follow-up work is still
// this request's to run (recovered: true). Otherwise 'failed' (retry page).
// deno-lint-ignore no-explicit-any
export async function acceptQuoteDocumentAtomically(sb: any, input: AtomicAcceptInput): Promise<AtomicAcceptOutcome> {
  let data: unknown = null
  let rpcFailed = false
  try {
    const res = await sb.rpc('accept_quote_document_atomic', {
      p_document_id: input.documentId,
      p_accepted_at: input.acceptedAt,
      p_job_status: input.jobStatus,
      p_fingerprint: input.fingerprint,
      p_run_label: input.runLabel,
      p_accept_event: input.acceptEvent,
    })
    if (res.error) rpcFailed = true
    else data = res.data
  } catch {
    rpcFailed = true
  }
  if (rpcFailed) return await recoverAtomicAcceptance(sb, input)
  const result = (data || {}) as { outcome?: string; reason?: string; job_status?: string }
  switch (result.outcome) {
    case 'accepted':
      return { kind: 'accepted', recovered: false, jobStatus: result.job_status || input.jobStatus }
    case 'replay':
      return { kind: 'replay' }
    case 'stale':
      return { kind: 'stale' }
    case 'refused':
      return { kind: 'refused', reason: result.reason || 'refused' }
    default:
      return await recoverAtomicAcceptance(sb, input)
  }
}

// deno-lint-ignore no-explicit-any
async function recoverAtomicAcceptance(sb: any, input: AtomicAcceptInput): Promise<AtomicAcceptOutcome> {
  try {
    const { data, error } = await sb
      .from('quote_acceptance_attempts')
      .select('document_id, job_status, accepted_at')
      .eq('document_id', input.documentId)
      .limit(1)
    if (error) return { kind: 'failed' }
    const row = data?.[0]
    // Only this request's own commit counts: same document and same instant.
    if (row && new Date(row.accepted_at).getTime() === new Date(input.acceptedAt).getTime()) {
      return { kind: 'accepted', recovered: true, jobStatus: row.job_status }
    }
    return { kind: 'failed' }
  } catch {
    return { kind: 'failed' }
  }
}

// Called before each response of an atomic acceptance once its follow-up
// work has run. A no-op on the legacy path (documentId null). Failure only
// leaves the attempt listed for a person.
// deno-lint-ignore no-explicit-any
export async function finishAtomicAcceptance(sb: any, documentId: string | null, outcome = 'done'): Promise<void> {
  if (!documentId) return
  try {
    await sb.rpc('quote_acceptance_finish_downstream', { p_document_id: documentId, p_outcome: outcome })
  } catch (e) {
    console.error('[accept] atomic follow-up not marked finished:', (e as Error).message)
  }
}
