// Stage 4 Phase A — MakeSafe re-open / re-cycle mechanism.
//
// PRIVILEGED action `re_open_makesafe` (api_key / jwt admin|owner only).
// The routine can NEVER call this action — it is on the ROUTINE_FORBIDDEN list.
//
// Contract (Checkpoint 1 — 2026-06-18):
//   Given job_id + reason, re-activate the job (complete/archived -> scheduled),
//   set reopen_reason + no_charge + increment cycle_number, and create a NEW
//   makesafe_report_packs row with pack_kind = the reason.  Leave the prior 'main'
//   pack + its docs + its invoice INTACT.  Do NOT delete or void any prior invoice.
//
// Charge rules:
//   reattendance -> no_charge = false (CHARGE — a new invoice cycle)
//   rectification -> no_charge = true  (our fault; report only, no invoice)
//   pickup        -> no_charge = true  (internal collection; report only, no invoice)
//
// Cycle-scoped invoice gate:
//   The ambiguous-invoice gate + the send consider ONLY the current cycle's pack/
//   invoice, not ALL job invoices.  This lets a reattendance's new invoice coexist
//   with the original paid invoice without tripping the fail-closed 2+-live-invoice
//   gate.  The prior invoice is NEVER voided.
//
// no_charge honouring (pure building blocks only — orchestration in index.ts):
//   checkNoChargeInvoiceGate: returns {skipped:true} signal for createMakesafeDraftInvoice
//   checkNoChargeSendGate: returns the send-gate variant for a no_charge cycle
//     (exactly 1 report PDF, 0 invoice PDFs — report-only send)
//
// All functions are PURE (no network, no Supabase, no Xero). Tests in
// makesafe_reopen_test.ts.

// ── Valid re-open reasons ─────────────────────────────────────────────────────
export const REOPEN_REASONS = ['reattendance', 'rectification', 'pickup'] as const
export type ReopenReason = typeof REOPEN_REASONS[number]

export function isValidReopenReason(reason: unknown): reason is ReopenReason {
  return REOPEN_REASONS.includes(reason as ReopenReason)
}

// ── Charge rule (pure): derive no_charge from the reason ─────────────────────
//
//   reattendance -> false (CHARGE: a new invoice is raised)
//   rectification -> true  (our fault; no invoice)
//   pickup        -> true  (internal collection; no invoice)
//
// Exported for tests + orchestration.
export function noChargeFromReason(reason: ReopenReason): boolean {
  return reason === 'rectification' || reason === 'pickup'
}

// ── Job-status eligibility for re-open ───────────────────────────────────────
//
// Only completed or archived jobs may be re-opened.  A job that is still in the
// active pipeline (scheduled / in_progress) is NOT re-openable.
export const REOPEN_ELIGIBLE_STATUSES = ['complete', 'invoiced', 'archived']

export function isReopenEligible(jobStatus: string | null | undefined): boolean {
  return REOPEN_ELIGIBLE_STATUSES.includes(String(jobStatus ?? ''))
}

// ── Re-open input validation ──────────────────────────────────────────────────
export interface ReopenValidation {
  ok: boolean
  httpStatus: number
  reason: string | null
}

export function validateReopenInput(args: {
  jobId: unknown
  reason: unknown
  jobStatus: string | null | undefined
}): ReopenValidation {
  if (!args.jobId || typeof args.jobId !== 'string') {
    return { ok: false, httpStatus: 400, reason: 'job_id is required' }
  }
  if (!isValidReopenReason(args.reason)) {
    return {
      ok: false,
      httpStatus: 400,
      reason: `reason must be one of: ${REOPEN_REASONS.join(', ')}; got '${String(args.reason ?? '')}'`,
    }
  }
  if (!isReopenEligible(args.jobStatus)) {
    return {
      ok: false,
      httpStatus: 409,
      reason: `job status '${String(args.jobStatus ?? '')}' is not eligible for re-open; must be one of: ${REOPEN_ELIGIBLE_STATUSES.join(', ')}`,
    }
  }
  return { ok: true, httpStatus: 200, reason: null }
}

// ── Re-open detail patch (pure: what to write to makesafe_job_details) ───────
//
// Returns the patch object to apply to makesafe_job_details for the current
// re-open.  The caller increments cycle_number by reading the current value first.
export interface ReopenDetailPatch {
  reopen_reason: ReopenReason
  no_charge: boolean
  cycle_number: number
  substatus: 'company_contact_required' // reset to first active substatus on re-open
  updated_at: string
}

export function buildReopenDetailPatch(args: {
  reason: ReopenReason
  priorCycleNumber: number
  nowIso: string
}): ReopenDetailPatch {
  return {
    reopen_reason: args.reason,
    no_charge: noChargeFromReason(args.reason),
    cycle_number: args.priorCycleNumber + 1,
    substatus: 'company_contact_required',
    updated_at: args.nowIso,
  }
}

// ── Per-cycle pack_kind key (SAME-REASON REPEAT safety) ──────────────────────
//
// The pack key is UNIQUE(job_id, pack_kind).  If pack_kind were JUST the reason,
// a SECOND reattendance would collide with the first and be swallowed (no distinct
// state — a re-cycle would silently reuse a terminal 'sent' pack).  To give every
// re-open cycle a DISTINCT pack row we encode the cycle_number into the pack_kind:
//
//   cycle 1 (original)            -> pack_kind = 'main'         (unchanged)
//   cycle 2, reason reattendance  -> pack_kind = 'reattendance#2'
//   cycle 3, reason reattendance  -> pack_kind = 'reattendance#3'  (DISTINCT)
//   cycle 2, reason rectification -> pack_kind = 'rectification#2'
//
// Every re-open pack_kind starts with the reason word and is NEVER 'main', so the
// `packKind !== 'main'` test (no_charge / cycle-scoping / per-cycle marker) holds.
// The reason can still be recovered with reopenReasonFromPackKind().
export function reopenPackKindForCycle(reason: ReopenReason, cycleNumber: number): string {
  return `${reason}#${cycleNumber}`
}

// Recover the reason word from a per-cycle pack_kind (e.g. 'reattendance#3' ->
// 'reattendance'). Returns null for 'main' or any non-reopen key.
export function reopenReasonFromPackKind(packKind: string | null | undefined): ReopenReason | null {
  const base = String(packKind ?? '').split('#')[0]
  return isValidReopenReason(base) ? base : null
}

// ── New pack row to create on re-open ─────────────────────────────────────────
//
// Each re-open creates a NEW makesafe_report_packs row with a per-cycle pack_kind
// (reason#cycleNumber).  The prior 'main' pack row + any prior re-open pack are
// NEVER touched.  UNIQUE(job_id, pack_kind) enforces one pack per cycle.
export interface NewPackRow {
  org_id: string
  job_id: string
  pack_kind: string
  status: 'drafted'
  created_at: string
  updated_at: string
}

// Default org_id mirrors the existing DEFAULT_ORG_ID used across the backend.
export const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001'

export function buildNewPackRow(args: {
  jobId: string
  reason: ReopenReason
  cycleNumber: number
  orgId?: string
  nowIso: string
}): NewPackRow {
  return {
    org_id: args.orgId || DEFAULT_ORG_ID,
    job_id: args.jobId,
    pack_kind: reopenPackKindForCycle(args.reason, args.cycleNumber),
    status: 'drafted',
    created_at: args.nowIso,
    updated_at: args.nowIso,
  }
}

// ── no_charge invoice gate (pure building block) ──────────────────────────────
//
// When the current cycle has no_charge=true, createMakesafeDraftInvoice MUST
// skip the Xero call and return a {skipped:true, reason:'no_charge'} sentinel.
// This function tests the flag and returns the skip signal.
export interface NoChargeInvoiceResult {
  skipped: true
  reason: 'no_charge'
  note: string
}

export function checkNoChargeInvoiceGate(noCharge: boolean): NoChargeInvoiceResult | null {
  if (!noCharge) return null
  return {
    skipped: true,
    reason: 'no_charge',
    note: 'no_charge cycle (rectification or pickup): invoice creation skipped; no Xero call',
  }
}

// ── no_charge send gate (pure building block) ─────────────────────────────────
//
// For a no_charge cycle, makesafeSendPack does a REPORT-ONLY send:
//   - skip authorise (no invoice)
//   - skip the invoice preflight
//   - checkClientSendGate gets a variant that requires exactly 1 report PDF + 0
//     invoice PDFs (instead of the normal 1 + 1)
//
// This function validates the attachment list for a no_charge send.  It is the
// no_charge variant of checkClientSendGate: same form (returns [] on PASS, list of
// failures on FAIL), but requires 0 invoice PDFs instead of 1.
import { isReportPdf, isXeroInvoicePdf, attachmentNames } from './makesafe_send_pack.ts'

export interface NoChargeSendGateResult {
  failures: string[]
  isNoCharge: true
}

export function checkNoChargeSendGate(args: {
  noCharge: boolean
  attachments: unknown
}): NoChargeSendGateResult | null {
  if (!args.noCharge) return null

  const names = attachmentNames(args.attachments)
  const failures: string[] = []

  const reportNames = names.filter((n) => isReportPdf(n))
  const invoiceNames = names.filter((n) => isXeroInvoicePdf(n))

  if (reportNames.length !== 1) {
    failures.push(
      `no_charge send requires exactly one make-safe report PDF attachment; got ${reportNames.length}`,
    )
  }
  if (invoiceNames.length > 0) {
    failures.push(
      `no_charge send must have 0 invoice PDFs (no invoice raised on this cycle); got ${invoiceNames.length}`,
    )
  }

  return { failures, isNoCharge: true }
}

// ── Cycle-scoped invoice resolver (pure building block) ───────────────────────
//
// The ambiguous-invoice gate in makesafeSendPack normally considers ALL job
// invoices.  For a re-open cycle we must scope it to ONLY the current cycle's
// pack/invoice so the original paid invoice does not trip the fail-closed
// 2+-live-invoice gate.
//
// Strategy: filter the invoice rows to those whose job_id matches AND whose
// xero_invoice_id matches the current pack's xero_invoice_id.  The prior cycle's
// invoice (different xero_invoice_id) is therefore excluded.
//
// If the current pack has no xero_invoice_id yet (invoice not yet created), the
// scoped set is empty (safe to create the draft).
export function filterInvoicesToCurrentCycle(args: {
  allInvoices: any[] | null | undefined
  currentPackXeroInvoiceId: string | null | undefined
}): any[] {
  const all = args.allInvoices || []
  const currentId = args.currentPackXeroInvoiceId
  // No invoice created yet for this cycle -> scoped set is empty.
  if (!currentId) return []
  return all.filter((inv) => inv?.xero_invoice_id === currentId)
}

// ── Pack-kind send-marker (cycle-scoped idempotency key) ──────────────────────
//
// The existing MAKESAFE_PACK_SENT | main marker is pack_kind='main' specific.
// A re-open cycle writes its OWN marker keyed on the pack_kind (e.g.
// 'MAKESAFE_PACK_SENT | reattendance') so the main marker check in
// makesafeSendPack does NOT block a new-kind cycle's send.
//
// The existing isPackSentMainEvent / hasPackSentMainMarker in makesafe_send_pack.ts
// remain unchanged and ONLY match 'main'.  This function builds and matches the
// per-kind variant.
export const MAKESAFE_PACK_SENT_PREFIX = 'MAKESAFE_PACK_SENT |'

export function buildCyclePackSentMarkerText(args: {
  packKind: string
  invoiceNumber: string | null | undefined
  to: string
  nowIso: string
  messageId?: string | null
}): string {
  return [
    `${MAKESAFE_PACK_SENT_PREFIX} ${args.packKind}`,
    args.invoiceNumber || '?',
    `to=${args.to}`,
    args.nowIso,
    `msgid=${args.messageId || ''}`,
  ].join(' | ')
}

export function isCyclePackSentEvent(ev: any, packKind: string): boolean {
  if (!ev || String(ev.event_type) !== 'note') return false
  let dj = ev.detail_json
  if (typeof dj === 'string') {
    try { dj = JSON.parse(dj) } catch (_) { dj = { text: dj } }
  }
  const text = dj && typeof dj === 'object' ? dj.text : null
  if (typeof text !== 'string') return false
  // Match EXACTLY this pack_kind token (delimited by ' | ' on both sides) so that
  // e.g. packKind='re' does NOT prefix-match 'reattendance'. The marker text is
  // `MAKESAFE_PACK_SENT | <packKind> | <inv> | ...`.
  const t = text.trim()
  const prefix = `${MAKESAFE_PACK_SENT_PREFIX} ${packKind} |`
  // Allow a marker with no trailing fields too: `MAKESAFE_PACK_SENT | <packKind>`
  // exactly (defensive — production always writes the full form).
  return t.startsWith(prefix) || t === `${MAKESAFE_PACK_SENT_PREFIX} ${packKind}`
}

export function hasCyclePackSentMarker(events: any[] | null | undefined, packKind: string): boolean {
  return (events || []).some((ev) => isCyclePackSentEvent(ev, packKind))
}

// ── Unified packKind-aware marker dispatchers (used by makesafeSendPack) ──────
//
// The send state machine must use the RIGHT marker per pack_kind:
//   - packKind === 'main'  -> the existing MAKESAFE_PACK_SENT | main marker
//     (so the board's isPackSentMainEvent / buildPackSentMap stay correct and the
//     main behaviour is byte-identical to before this change).
//   - any other packKind   -> the per-cycle marker (e.g. ... | reattendance | ...)
//
// These dispatchers take the main builder/matcher (imported from
// makesafe_send_pack.ts in the orchestrator) by injection so this module does not
// create an import cycle, and so a packKind='main' send is provably unchanged.
export function buildPackSentMarkerForKind(
  packKind: string,
  mainBuilder: (args: { invoiceNumber: string | null | undefined; to: string; nowIso: string; messageId?: string | null }) => string,
  args: { invoiceNumber: string | null | undefined; to: string; nowIso: string; messageId?: string | null },
): string {
  if (packKind === 'main') return mainBuilder(args)
  return buildCyclePackSentMarkerText({ packKind, ...args })
}

// True if ANY event carries the send marker for THIS pack_kind.
//   main  -> use the injected main matcher (identical to the existing behaviour).
//   other -> use the per-cycle matcher.
export function hasPackSentMarkerForKind(
  packKind: string,
  events: any[] | null | undefined,
  mainMatcher: (ev: any) => boolean,
): boolean {
  if (packKind === 'main') return (events || []).some((ev) => mainMatcher(ev))
  return hasCyclePackSentMarker(events, packKind)
}
