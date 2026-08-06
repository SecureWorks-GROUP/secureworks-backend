/**
 * Who is allowed to run a LIVE clean-intake advancement sweep.
 *
 * `auto_approve_clean_intake_drafts` batch-approves intake drafts, and approving a
 * draft CREATES A LIVE MAKE-SAFE JOB. The privileged auth gate on the action
 * (ops key or admin/owner JWT) is correct and is NOT touched here — it answers
 * "may this caller approve?". This module answers the different question the
 * 2026-08-06 captain ruling named: "did anybody actually ASK for an approval?"
 *
 * The defect it closes: the ops dashboard awaited this action on the make-safe
 * board's RENDER path (`triggered_by: 'ops_board_autoload'`, ops.html `loadJobs`).
 * The dashboard authenticates with the master ops key, so the privileged gate was
 * satisfied and the call was permitted — a read performed a privileged write as a
 * side effect, with no moment where a human ticked anything. Measured 2026-08-06
 * against production: 51 reviewable drafts, 48 of them "clean" by the pure gate and
 * every one of the 51 already carrying a live card on the same `external_ref`, so
 * every board paint re-attempted 48 approvals that the duplicate/identity guards in
 * `approveIntakeDraft` refuse. That cost the board ~28.6s of click-to-paint and had
 * successfully approved 2 drafts in the 46 days since it shipped.
 *
 * The rule is therefore INTENT, not authority: a live sweep must name a trigger that
 * is either an explicit human action or a scheduled/skill clock. An unnamed or
 * unrecognised trigger still gets its full preview — the same counts, the same
 * eligibility reasons, the same clean evidence — it simply performs no approvals.
 *
 * Fail-safe by construction, and deliberately so: this is a batch that mints live
 * jobs, so "I could not tell who asked" must resolve to a preview, never to a run.
 * That also means a stale cached ops.html cannot resurrect the defect after the
 * dashboard ships its own fix — the refusal lives on the server, where every client
 * meets it.
 *
 * Adding a name here authorises unattended live job creation under that name. Add
 * one only for a trigger that is genuinely explicit or genuinely scheduled, and
 * never for anything reached by rendering a page.
 */

/** How a trigger earns the right to approve. */
export type MakesafeIntakeAdvanceTriggerKind = 'explicit' | 'scheduled'

export interface MakesafeIntakeAdvanceTriggerDecision {
  /** The trigger as it will be recorded in `makesafe_intake_drafts.approved_by`. */
  trigger: string
  /** Null when the trigger is not authorised for a live run. */
  kind: MakesafeIntakeAdvanceTriggerKind | null
  /** True only when this trigger may perform live approvals. */
  liveAuthorised: boolean
  /** Null when authorised; otherwise the reason a live run was withheld. */
  refusalReason: MakesafeIntakeAdvanceRefusalReason | null
}

export type MakesafeIntakeAdvanceRefusalReason =
  | 'trigger_missing'
  | 'render_path_trigger'
  | 'trigger_not_authorised'

/**
 * The closed allow-list. Every entry is either a deliberate human action or a
 * clock that runs off the render path.
 *
 * - `ses-reporting-skill` is the Amendment-46 one-pass coupling: every SES reporting
 *   skill run calls `makesafe_reporting_intake_pass` exactly once, which runs one
 *   bounded scan and then this sweep (limit 100). It is the standing owner of the
 *   BACKLOG re-sweep — a draft that was not clean when its creating run made it and
 *   became clean later (late PDF, re-extract, gap-fill).
 * - `ops_intake_review_sweep` is the operator pressing "advance clean drafts" in the
 *   make-safe intake review overlay: the surface where a human is already looking at
 *   the drafts this sweep would approve.
 *
 * New mail needs neither: the standing scan (`makesafe-ses-poll`, every 2 minutes)
 * advances the drafts of its own run via `advanceDrafts`, and `scanFreshMakesafeSource`
 * covers a source whose PDF extraction settles late. Removing the board trigger
 * therefore leaves no draft without an owner.
 */
export const MAKESAFE_INTAKE_ADVANCE_LIVE_TRIGGERS: ReadonlyMap<
  string,
  MakesafeIntakeAdvanceTriggerKind
> = new Map<string, MakesafeIntakeAdvanceTriggerKind>([
  ['ses-reporting-skill', 'scheduled'],
  ['ops_intake_review_sweep', 'explicit'],
])

/**
 * Triggers known to be a page render. Held separately from "merely unrecognised" so
 * the refusal names the actual defect in logs and in the response rather than
 * reading as a typo, and so a stale client is diagnosable at a glance.
 *
 * `ops_board_autoload` is the ops.html make-safe board autoload this module exists
 * to stop.
 */
export const MAKESAFE_INTAKE_ADVANCE_RENDER_PATH_TRIGGERS: ReadonlySet<string> =
  new Set<string>([
    'ops_board_autoload',
  ])

/**
 * The historical `approved_by` label used when a caller named no trigger. Retained so
 * the intake-health "auto-filed" counter and the 70 existing rows carrying it stay
 * attributable — it labels a row, it does NOT authorise a live run.
 */
export const MAKESAFE_INTAKE_ADVANCE_DEFAULT_LABEL = 'auto_intake_clean_gate'

function readTrigger(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const raw = body as Record<string, unknown>
  const named = raw.triggered_by ?? raw.triggeredBy
  return typeof named === 'string' ? named.trim() : ''
}

/**
 * Resolve a sweep body to its trigger and whether that trigger may approve.
 *
 * Pure: no I/O, no clock, no environment. The caller combines this with the two
 * existing emergency brakes (`MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE` and
 * `makesafe_cron_settings.auto_file_enabled`) and the caller's own `dry_run`; any
 * one of them withholding a live run is sufficient.
 */
export function resolveMakesafeIntakeAdvanceTrigger(
  body: unknown,
): MakesafeIntakeAdvanceTriggerDecision {
  const named = readTrigger(body)
  if (!named) {
    return {
      trigger: MAKESAFE_INTAKE_ADVANCE_DEFAULT_LABEL,
      kind: null,
      liveAuthorised: false,
      refusalReason: 'trigger_missing',
    }
  }
  const kind = MAKESAFE_INTAKE_ADVANCE_LIVE_TRIGGERS.get(named)
  if (kind) {
    return { trigger: named, kind, liveAuthorised: true, refusalReason: null }
  }
  return {
    trigger: named,
    kind: null,
    liveAuthorised: false,
    refusalReason: MAKESAFE_INTAKE_ADVANCE_RENDER_PATH_TRIGGERS.has(named)
      ? 'render_path_trigger'
      : 'trigger_not_authorised',
  }
}

/** Operator-facing explanation of a withheld live run. */
export function describeMakesafeIntakeAdvanceRefusal(
  decision: MakesafeIntakeAdvanceTriggerDecision,
): string | null {
  switch (decision.refusalReason) {
    case null:
      return null
    case 'trigger_missing':
      return 'preview only: no triggered_by was named, so this sweep cannot be attributed to an explicit action or a scheduled run'
    case 'render_path_trigger':
      return `preview only: '${decision.trigger}' is a page-render trigger, and rendering a board must never create live make-safe jobs`
    case 'trigger_not_authorised':
      return `preview only: '${decision.trigger}' is not an authorised live-approval trigger`
  }
}
