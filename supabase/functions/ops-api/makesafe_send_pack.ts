// MakeSafe Reporting Autopilot (Wave 2) -- pure, testable building blocks for
// the makesafe_send_pack resumable state machine. NO network, NO Supabase, NO
// Xero, NO jsPDF here. The orchestration (index.ts:makesafeSendPack) imports
// these and supplies the live clients.
//
// MONEY/COMMS critical. Every gate here FAILS CLOSED: an ambiguous or incomplete
// input yields "do not send / do not authorise".

// ── Privileged-caller auth gate (decision: scoped-routine-key-2026-06-17) ──
//
// send_pack authorises a Xero invoice and emails a builder. It is reachable by
// the PRIVILEGED caller classes only:
//   - authMode='api_key'  -> the master SW_API_KEY (the ops dashboard, which has
//                            NO per-user login) or the service-role key. PRIVILEGED.
//   - authMode='jwt'      -> a logged-in user; only role admin/owner is privileged.
//   - authMode='routine'  -> the LESSER MAKESAFE_ROUTINE_KEY held by the make-safe
//                            automation. Drafts-only. REJECTED here (and centrally,
//                            via Sentinel Wave 0's ROUTINE_FORBIDDEN_ACTIONS,
//                            branch origin/sentinel/makesafe-wave0-hardening PR #179).
//
// The 'routine' class falls through to false because it is neither 'api_key' nor
// jwt admin/owner. Under main (where authMode is only 'api_key'|'jwt' and there is
// no 'routine' class yet) this predicate is identical in behaviour: dashboard
// api_key + admin/owner jwt are allowed. Belt-and-braces with the central deny-list.
export function sendPackAllowed(
  authMode: 'api_key' | 'jwt' | 'routine',
  authUser: { role?: string } | null | undefined,
): boolean {
  return authMode === 'api_key' ||
    (authMode === 'jwt' && (authUser?.role === 'admin' || authUser?.role === 'owner'))
}

// ── Marker idempotency (mirrors index.ts isPackSentMainEvent) ──
export const MAKESAFE_PACK_SENT_MAIN_PREFIX = 'MAKESAFE_PACK_SENT | main'

export function isPackSentMainEvent(ev: any): boolean {
  if (!ev || String(ev.event_type) !== 'note') return false
  let dj = ev.detail_json
  if (typeof dj === 'string') {
    try { dj = JSON.parse(dj) } catch (_) { dj = { text: dj } }
  }
  const text = dj && typeof dj === 'object' ? dj.text : null
  return typeof text === 'string' && text.trim().startsWith(MAKESAFE_PACK_SENT_MAIN_PREFIX)
}

// True if any note row in the set carries the verified main-pack marker.
export function hasPackSentMainMarker(events: any[] | null | undefined): boolean {
  return (events || []).some((ev) => isPackSentMainEvent(ev))
}

// Build the marker text the send writes on success. Bakes the live invoice
// number at send time (the board's M3 resolver never trusts this number for
// resolution; it is a triage breadcrumb only -- see makesafe_marker_integrity).
export function buildPackSentMarkerText(args: {
  invoiceNumber: string | null | undefined
  to: string
  nowIso: string
  messageId?: string | null
}): string {
  return [
    MAKESAFE_PACK_SENT_MAIN_PREFIX,
    args.invoiceNumber || '?',
    `to=${args.to}`,
    args.nowIso,
    `msgid=${args.messageId || ''}`,
  ].join(' | ')
}

// ── Duplicate-invoice 3-tier resolver (TS port of
// create_makesafe_draft_invoice.py resolve_existing_invoice) ──
//
// Returns the single existing LIVE invoice that maps to the job, or null. A
// VOIDED/DELETED invoice NEVER blocks creation (it is ignored). Tiers, highest
// trust first:
//   job_id            -- invoice.job_id === job.id
//   reference         -- norm(invoice.reference) === norm(external_ref)
//   reference_substr  -- norm(external_ref) is a substring of norm(reference),
//                        external_ref >= 5 chars (short tokens cannot false-match)
const VOID_STATUSES = ['VOIDED', 'DELETED']

export function normRef(s: unknown): string {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, '')
}

export function isVoidStatus(status: unknown): boolean {
  return VOID_STATUSES.includes(String(status ?? '').toUpperCase())
}

export interface ExistingInvoiceHit {
  invoice_number: string | null
  status: string | null
  xero_invoice_id: string | null
  match_method: 'job_id' | 'reference' | 'reference_substring'
}

export function resolveExistingInvoice(
  rows: any[] | null | undefined,
  jobId: string | null | undefined,
  externalRef: string | null | undefined,
): ExistingInvoiceHit | null {
  const all = rows || []
  const liveHit = (cands: any[]): any | null => {
    const live = cands.filter((c) => !isVoidStatus(c?.status))
    return live.length ? live[0] : null
  }
  const toHit = (r: any, method: ExistingInvoiceHit['match_method']): ExistingInvoiceHit => ({
    invoice_number: r?.invoice_number ?? null,
    status: r?.status ?? null,
    xero_invoice_id: r?.xero_invoice_id ?? null,
    match_method: method,
  })

  // Tier 1: job_id
  if (jobId) {
    const byJob = all.filter((r) => r?.job_id && r.job_id === jobId)
    const hit = liveHit(byJob)
    if (hit) return toHit(hit, 'job_id')
  }

  const nref = normRef(externalRef)
  if (!nref) return null

  // Tier 2: exact normalised reference
  const exact = all.filter((r) => normRef(r?.reference) === nref && normRef(r?.reference) !== '')
  const exactHit = liveHit(exact)
  if (exactHit) return toHit(exactHit, 'reference')

  // Tier 3: reference substring (>= 5 chars)
  if (nref.length >= 5) {
    const sub = all.filter((r) => {
      const ir = normRef(r?.reference)
      return ir !== '' && ir.includes(nref)
    })
    const subHit = liveHit(sub)
    if (subHit) return toHit(subHit, 'reference_substring')
  }
  return null
}

// ── Client-send gate (TS port of check_client_send_gate.py:validate) ──
//
// Stricter than a draft validator. Run immediately before any live builder send.
// Any failure -> do not send. The process-confirmation checklist (client_send_gate
// object) from the Python is NOT re-required here: in the autopilot the human
// approval is the admin/owner JWT on send_pack, and the structural facts below
// (sender/cc/subject/attachments) are what the backend can actually verify.
export const MAKESAFE_ADMIN_FROM = 'admin@secureworkswa.com.au'
export const MAKESAFE_CC = 'ses@secureworkswa.com.au'
export const REVIEW_MARKERS = ['TEST', 'ROUND', 'DRAFT', 'REVIEW', 'INTERNAL', 'PREVIEW']

export function splitEmails(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => splitEmails(v))
  if (typeof value !== 'string') return []
  return value.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean)
}

export function attachmentNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names: string[] = []
  for (const item of value) {
    if (item && typeof item === 'object' && (item as any).name) names.push(String((item as any).name))
    else if (typeof item === 'string') names.push(item.split('/').pop() || item)
  }
  return names
}

// Marker present as a whole token (not a substring of an unrelated word).
export function hasReviewMarker(name: string): string | null {
  const upper = name.toUpperCase()
  for (const marker of REVIEW_MARKERS) {
    const re = new RegExp(`(^|[^A-Z0-9])${marker}([^A-Z0-9]|$)`)
    if (re.test(upper)) return marker
  }
  return null
}

export function isReportPdf(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.pdf') && (lower.includes('make safe report') || lower.includes('makesafe report'))
}

export function isXeroInvoicePdf(name: string): boolean {
  const lower = name.toLowerCase()
  const rejected = ['invoice line review', 'line review', 'local price', 'price summary', 'invoice_lines']
  return lower.endsWith('.pdf') &&
    lower.includes('xero') &&
    lower.includes('invoice') &&
    !rejected.some((t) => lower.includes(t))
}

export interface ClientSendPayload {
  from?: string
  from_email?: string
  to?: unknown
  cc?: unknown
  subject?: string
  htmlBody?: string
  html_body?: string
  attachments?: unknown
}

// Returns [] when the payload is safe to send; otherwise a list of failure
// strings. Empty == PASS. The caller MUST treat any non-empty result as a hard
// stop (no send, no authorise).
export function checkClientSendGate(payload: ClientSendPayload): string[] {
  const failures: string[] = []

  const fromEmail = String(payload.from || payload.from_email || '').trim().toLowerCase()
  if (fromEmail !== MAKESAFE_ADMIN_FROM) {
    failures.push(`sender must be ${MAKESAFE_ADMIN_FROM}; got ${fromEmail || '<missing>'}`)
  }

  if (splitEmails(payload.to).length === 0) failures.push('to recipient is missing')

  const cc = splitEmails(payload.cc)
  if (!cc.includes(MAKESAFE_CC)) failures.push(`cc must include ${MAKESAFE_CC}`)

  const subject = String(payload.subject || '').trim()
  if (!subject) {
    failures.push('subject is missing')
  } else {
    const marker = hasReviewMarker(subject)
    if (marker) failures.push(`client subject contains review/test marker '${marker}': ${subject}`)
  }

  const html = String(payload.htmlBody || payload.html_body || '')
  if (!html.trim()) failures.push('html body is missing')

  const names = attachmentNames(payload.attachments)
  if (names.length < 2) {
    failures.push('client send requires at least two separate PDF attachments: report and Xero invoice')
  }
  const reportNames = names.filter((n) => isReportPdf(n))
  const invoiceNames = names.filter((n) => isXeroInvoicePdf(n))
  if (reportNames.length !== 1) {
    failures.push(`expected exactly one final make-safe report PDF attachment; got ${reportNames.length}`)
  }
  if (invoiceNames.length !== 1) {
    failures.push(`expected exactly one actual Xero invoice PDF attachment; got ${invoiceNames.length}`)
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.pdf')) {
      failures.push(`attachment must be a PDF for formal client send: ${name}`)
    }
    const marker = hasReviewMarker(name)
    if (marker) failures.push(`client attachment filename contains review/test marker '${marker}': ${name}`)
  }
  return failures
}

// ── Atomic send-lock model (pure reference implementation) ──
//
// The live action takes the lock with a single conditional UPDATE:
//   UPDATE makesafe_report_packs
//      SET status='sending', send_started_at=now()
//    WHERE job_id=? AND pack_kind=? AND status IN (lockable)
//   RETURNING *
// Postgres serialises concurrent UPDATEs on the same row, so exactly one racer
// transitions a lockable row to 'sending'; the other sees 0 rows -> 409. This
// pure model proves that invariant for the tests without a database.
export const LOCKABLE_STATUSES = ['admin_to_send_report', 'drafted', 'authorised_not_sent']

export function canAcquireSendLock(currentStatus: string | null | undefined): boolean {
  return LOCKABLE_STATUSES.includes(String(currentStatus ?? ''))
}

// A tiny serialised lock cell: the FIRST acquire that finds a lockable status
// wins and flips to 'sending'; every subsequent acquire fails until released.
// Models the DB's conditional-UPDATE-RETURNING semantics exactly.
export class SendLockCell {
  status: string
  constructor(initial: string) {
    this.status = initial
  }
  // Returns true and flips to 'sending' iff the current status is lockable.
  tryAcquire(): boolean {
    if (canAcquireSendLock(this.status)) {
      this.status = 'sending'
      return true
    }
    return false
  }
  set(status: string): void {
    this.status = status
  }
}
