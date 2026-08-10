// ── Rescue SES remainder item 1: the make-safe substatus coherence gate ──────
// Mission: wiki coding/work/campaigns/makesafe-system/missions/rescue-ses-2026-08.
// Spec: coding/work/campaigns/makesafe-system/SPEC.md item 1.
//
// This module owns the DECISION half of `assertMakesafeSubstatusTransition`.
// index.ts keeps the thin wrapper that turns a refusal into an `ApiError` (the
// serve() handler matches on `instanceof ApiError`, so the throw must stay
// there), and this module is import-safe for tests: importing index.ts boots
// the production HTTP server via serve(...) at module load.
//
// WHY THIS EXISTS AS ITS OWN CONTRACT — the defect it closes:
// the gate used to wrap its two pre-reads in try/catch and never inspect
// `error`. Backend AGENTS.md records the rule that breaks: PostgREST RETURNS
// errors, it does not throw. So the catch was dead code, its console.warn never
// fired, and a failed read silently produced `jobState = ''` (the cancelled/lost
// guard passes) plus `current = null` (an early return before the transition
// check). The one coherence gate in front of every substatus write opened, and
// it opened INVISIBLY.
//
// The fail-open itself is DELIBERATE and is preserved here byte-for-byte in
// behaviour: the gate stops known-incoherent moves, and it must not add a new
// outage mode to every evidence event when a read hiccups. Turning it into a
// fail-closed is a separate change with its own outage profile and is NOT
// authorised by this spec. What changed is that the fail-open is now named,
// counted and greppable rather than silent.

import { describeMakesafeWriteOrigin, type MakesafeWriteOrigin } from './makesafe_write_origin.ts'

/** Stable, greppable marker for the deliberate fail-open. Count these. */
export const MAKESAFE_SUBSTATUS_GATE_FAIL_OPEN_MARKER = 'makesafe_substatus_gate_fail_open'

/**
 * Distinct marker for the last-resort catch. PostgREST returns errors rather
 * than throwing, so this marker firing means something OTHER than a query
 * error (a client/transport fault) — a genuinely different incident to
 * diagnose, which is why it must never share the fail-open marker.
 */
export const MAKESAFE_SUBSTATUS_GATE_READ_THREW_MARKER = 'makesafe_substatus_gate_read_threw'

export const MAKESAFE_SUBSTATUS_TRANSITIONS: Record<string, readonly string[]> = {
  company_contact_required: ['company_contact_done', 'waiting_on_trade_report', 'awaiting_portal_completion', 'admin_to_send_report'],
  company_contact_done: ['company_contact_required', 'waiting_on_trade_report', 'awaiting_portal_completion', 'admin_to_send_report'],
  awaiting_portal_completion: ['company_contact_required', 'waiting_on_trade_report', 'admin_to_send_report'],
  waiting_on_trade_report: ['company_contact_required', 'awaiting_portal_completion', 'admin_to_send_report'],
  admin_to_send_report: ['waiting_on_trade_report', 'awaiting_portal_completion', 'ready_to_invoice', 'complete'],
  ready_to_invoice: ['waiting_on_trade_report', 'admin_to_send_report', 'complete'],
  complete: ['waiting_on_trade_report', 'admin_to_send_report'],
}

/**
 * What a single pre-read produced.
 *
 * `absent` and `unreadable` are DIFFERENT states and the old code conflated
 * them: a card that genuinely has no `makesafe_job_details` row read the same
 * as a card whose row could not be read. Only `unreadable` is a fail-open.
 */
export type MakesafeSubstatusGateReadState = 'ok' | 'absent' | 'unreadable'

/**
 * The gate's answer on the paths that let a write through.
 *
 * `checked`              — both pre-reads returned cleanly and the gate applied
 *                          its checks to real data (including the legitimate
 *                          first-set / idempotent-repeat early return).
 * `fail_open_unreadable` — at least one pre-read failed, so the gate STEPPED
 *                          ASIDE for the checks that read depended on. The
 *                          write proceeds, as it always has.
 *
 * Callers do not have to act on this yet; item 2's `writeMakesafeSubstatus`
 * helper is where it becomes useful. It exists now so "passed the check" and
 * "could not read" stop looking identical at the call site.
 */
export type MakesafeSubstatusGateOutcome = 'checked' | 'fail_open_unreadable'

export interface MakesafeSubstatusGateResult {
  outcome: MakesafeSubstatusGateOutcome
  detail_read: MakesafeSubstatusGateReadState
  job_read: MakesafeSubstatusGateReadState
  /** Normalised substatus already on the card, or null when absent/unreadable. */
  current_substatus: string | null
  next_substatus: string
  /** Lower-cased `jobs.status`, or null when absent/unreadable. */
  job_status: string | null
}

export interface MakesafeSubstatusGateRefusal {
  status: number
  message: string
  /** Which rule refused: the cancelled/lost guard, or the transition table. */
  rule: 'job_terminal' | 'incoherent_transition'
}

export interface MakesafeSubstatusGateDecision {
  result: MakesafeSubstatusGateResult
  /** Non-null when the caller must throw. Null means let the write proceed. */
  refusal: MakesafeSubstatusGateRefusal | null
}

/** One PostgREST-ish read error, reduced to the fields worth logging. */
interface GateReadFault {
  read: 'makesafe_job_details' | 'jobs'
  code: string | null
  message: string | null
  details: string | null
  hint: string | null
}

export interface MakesafeSubstatusGateDeps {
  /** index.ts owns the substatus alias map; injected so it cannot drift. */
  normalizeSubstatus: (substatus: string | null | undefined) => string | null
  /** Injectable for tests. Defaults to console.warn. */
  warn?: (message: string, payload: Record<string, unknown>) => void
}

function faultFrom(read: GateReadFault['read'], error: any): GateReadFault {
  return {
    read,
    code: error?.code != null ? String(error.code) : null,
    message: error?.message != null ? String(error.message) : String(error),
    details: error?.details != null ? String(error.details) : null,
    hint: error?.hint != null ? String(error.hint) : null,
  }
}

function readState(error: unknown, row: unknown): MakesafeSubstatusGateReadState {
  if (error) return 'unreadable'
  return row ? 'ok' : 'absent'
}

/**
 * Evaluate the coherence gate for one substatus write.
 *
 * `nextSubstatus` must already be validated/normalised by the caller
 * (index.ts calls `requireValidMakesafeSubstatus` first, as it always has).
 *
 * Behaviour on the healthy path is unchanged: the cancelled/lost refusal and
 * the transition table are exactly as before. Behaviour on a read failure is
 * also unchanged — the gate still steps aside — but it now says so.
 */
export async function evaluateMakesafeSubstatusGate(
  client: any,
  jobId: string,
  nextSubstatus: string,
  origin: MakesafeWriteOrigin,
  deps: MakesafeSubstatusGateDeps,
): Promise<MakesafeSubstatusGateDecision> {
  const warn = deps.warn || ((message: string, payload: Record<string, unknown>) => console.warn(message, payload))

  let detailRes: any = null
  let jobRes: any = null
  let threwFault: string | null = null
  try {
    ;[detailRes, jobRes] = await Promise.all([
      client.from('makesafe_job_details').select('substatus').eq('job_id', jobId).maybeSingle(),
      client.from('jobs').select('status').eq('id', jobId).maybeSingle(),
    ])
  } catch (e: any) {
    // Genuine last-resort guard, kept ONLY under its own marker. The documented
    // client behaviour says a query error arrives as `error`, not as a throw,
    // so reaching here is a transport/client fault and a different incident.
    // It fails open the same way, because the trade above still applies.
    threwFault = e?.message || String(e)
    warn(`[ops-api] ${MAKESAFE_SUBSTATUS_GATE_READ_THREW_MARKER}`, {
      marker: MAKESAFE_SUBSTATUS_GATE_READ_THREW_MARKER,
      job_id: jobId,
      next_substatus: nextSubstatus,
      source: origin,
      error: threwFault,
    })
  }

  const detailError = detailRes?.error ?? null
  const jobError = jobRes?.error ?? null
  const detailRow = detailRes?.data ?? null
  const jobRow = jobRes?.data ?? null

  // A throw left both responses null. That is unreadable, not absent — do not
  // let the last-resort path masquerade as a clean read of an empty card.
  const detail_read: MakesafeSubstatusGateReadState = threwFault
    ? 'unreadable'
    : readState(detailError, detailRow)
  const job_read: MakesafeSubstatusGateReadState = threwFault
    ? 'unreadable'
    : readState(jobError, jobRow)

  const faults: GateReadFault[] = []
  if (detailError) faults.push(faultFrom('makesafe_job_details', detailError))
  if (jobError) faults.push(faultFrom('jobs', jobError))

  const unreadable = detail_read === 'unreadable' || job_read === 'unreadable'

  // ONE structured line per gated write that stepped aside, never one per
  // failed read — a marker that fires twice for one write cannot be counted.
  // Suppressed when the last-resort catch already logged its own marker, so a
  // single incident never emits two different markers.
  if (faults.length > 0 && !threwFault) {
    warn(`[ops-api] ${MAKESAFE_SUBSTATUS_GATE_FAIL_OPEN_MARKER}`, {
      marker: MAKESAFE_SUBSTATUS_GATE_FAIL_OPEN_MARKER,
      job_id: jobId,
      next_substatus: nextSubstatus,
      source: origin,
      detail_read,
      job_read,
      faults,
      // Name what the gate could not do, so a log reader does not have to
      // re-derive it from which read failed.
      skipped_checks: [
        ...(job_read === 'unreadable' ? ['cancelled_lost_guard'] : []),
        ...(detail_read === 'unreadable' ? ['transition_table'] : []),
      ],
    })
  }

  const jobStatus = jobRow?.status != null ? String(jobRow.status).toLowerCase() : null
  const result: MakesafeSubstatusGateResult = {
    outcome: unreadable ? 'fail_open_unreadable' : 'checked',
    detail_read,
    job_read,
    current_substatus: deps.normalizeSubstatus(detailRow?.substatus),
    next_substatus: nextSubstatus,
    job_status: jobStatus,
  }

  // Cancelled/lost guard. An unreadable `jobs` row yields a null status and so
  // passes, exactly as the old `String(jobRes?.data?.status || '')` did.
  if (
    jobStatus && ['cancelled', 'lost'].includes(jobStatus) &&
    origin.class !== 'intake'
  ) {
    return {
      result,
      refusal: {
        status: 409,
        rule: 'job_terminal',
        message: `substatus write refused: job is ${jobStatus} (source=${
          describeMakesafeWriteOrigin(origin)
        }); reinstate the job before changing its work state`,
      },
    }
  }

  const current = result.current_substatus
  // First set / idempotent repeat. Also the fail-open path for an unreadable
  // detail row, which is why `outcome` — not this return — is what tells a
  // caller whether the transition table was actually consulted.
  if (!current || current === nextSubstatus) return { result, refusal: null }

  const allowed = MAKESAFE_SUBSTATUS_TRANSITIONS[current] || []
  if (!allowed.includes(nextSubstatus)) {
    return {
      result,
      refusal: {
        status: 409,
        rule: 'incoherent_transition',
        message: `substatus transition refused: '${current}' -> '${nextSubstatus}' is not a coherent move (source=${
          describeMakesafeWriteOrigin(origin)
        })`,
      },
    }
  }

  return { result, refusal: null }
}
