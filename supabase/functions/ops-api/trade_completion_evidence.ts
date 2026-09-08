// Fencing job completion evidence — the gate between "job complete" and
// "trade can invoice this job" (Captain ask 2026-09-08).
//
// A fencing trade invoices a JOB (work order / per-metre). Before that job is
// billable the office must hold, on the job record:
//   - completion photos (job_media.phase = 'completion'), at least
//     COMPLETION_PHOTOS_REQUIRED, and
//   - the neighbours' sign-off, one screenshot per affected neighbour
//     (job_media.phase = 'neighbour_signoff'), at least
//     max(1, named neighbours on the scope) — unless the trade recorded a
//     waiver ("no neighbour affected", with a reason) as a job_events row.
//
// Hourly crew invoices are time-based and are NOT gated here. Patio / decking /
// make-safe jobs are not gated (completionEvidenceApplies).
//
// Read paths (my_work_orders, my_hours) carry the evaluation so the app can
// explain what is missing; write paths (submit_work_order_invoice, weekly
// resolver, per-metre submit_trade_invoice) refuse with the same message.
// Evidence that cannot be read fails closed: the job is not billable until the
// read succeeds.

export const COMPLETION_PHOTOS_REQUIRED = 3
export const NEIGHBOUR_SIGNOFF_PHASE = 'neighbour_signoff'
export const COMPLETION_PHOTO_PHASE = 'completion'
export const NEIGHBOUR_SIGNOFF_WAIVED_EVENT = 'neighbour_signoff_waived'
export const COMPLETION_EVIDENCE_BLOCK_REASON = 'completion_evidence'

export type CompletionEvidence = {
  job_id: string
  applies: boolean
  satisfied: boolean
  photos: number
  photos_required: number
  signoffs: number
  signoffs_required: number
  named_neighbours: number
  waived: boolean
  waiver_reason: string | null
  missing: string[]
  read_failed: boolean
}

type EvidenceJobInput = {
  id: string
  vertical: string
  scope_json?: unknown
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function completionEvidenceApplies(vertical: unknown): boolean {
  return String(vertical || '').trim().toLowerCase() === 'fencing'
}

/** Neighbours the scoper actually named. A blank row (the scoping tool
 *  always seeds one) does not count. */
export function namedNeighbourCount(scopeJson: unknown): number {
  const scope = asObject(scopeJson)
  const job = asObject(scope.job)
  const rows = Array.isArray(job.neighbours) ? job.neighbours : []
  let n = 0
  for (const raw of rows) {
    const row = asObject(raw)
    const named = [row.firstName, row.lastName, row.name, row.address, row.email, row.phone]
      .some((v) => typeof v === 'string' && v.trim() !== '')
    if (named) n++
  }
  return n
}

/** A dividing fence always has at least one affected neighbour. */
export function requiredNeighbourSignoffs(scopeJson: unknown): number {
  return Math.max(1, namedNeighbourCount(scopeJson))
}

function mediaPhase(row: unknown): string {
  return String(asObject(row).phase || '').trim().toLowerCase()
}

function mediaIsPhoto(row: unknown): boolean {
  const type = String(asObject(row).type || '').trim().toLowerCase()
  return !type || type === 'photo' || type === 'image' || type === 'screenshot'
}

export function evaluateCompletionEvidence(args: {
  job: EvidenceJobInput
  media: unknown[]
  events: unknown[]
  readFailed?: boolean
}): CompletionEvidence {
  const applies = completionEvidenceApplies(args.job.vertical)
  const photos = (args.media || []).filter((m) => mediaPhase(m) === COMPLETION_PHOTO_PHASE && mediaIsPhoto(m)).length
  const signoffs = (args.media || []).filter((m) => mediaPhase(m) === NEIGHBOUR_SIGNOFF_PHASE).length
  const named = namedNeighbourCount(args.job.scope_json)
  const waiver = (args.events || [])
    .map((e) => asObject(e))
    .find((e) => String(e.event_type || '') === NEIGHBOUR_SIGNOFF_WAIVED_EVENT)
  const waived = !!waiver
  const waiverReason = waived ? String(asObject(waiver?.detail_json).reason || '').trim() || null : null
  const signoffsRequired = waived ? 0 : requiredNeighbourSignoffs(args.job.scope_json)
  const missing: string[] = []
  if (args.readFailed) missing.push('evidence_unavailable')
  if (photos < COMPLETION_PHOTOS_REQUIRED) missing.push('completion_photos')
  if (signoffs < signoffsRequired) missing.push('neighbour_signoff')
  return {
    job_id: args.job.id,
    applies,
    satisfied: !applies || (missing.length === 0),
    photos,
    photos_required: COMPLETION_PHOTOS_REQUIRED,
    signoffs,
    signoffs_required: signoffsRequired,
    named_neighbours: named,
    waived,
    waiver_reason: waiverReason,
    missing,
    read_failed: args.readFailed === true,
  }
}

export function completionEvidenceMessage(
  ev: CompletionEvidence,
  jobLabel?: string | null,
  verb: 'invoiced' | 'marked complete' = 'invoiced',
): string {
  const label = jobLabel ? `${jobLabel} ` : 'This job '
  if (ev.read_failed) {
    return `${label}cannot be ${verb} yet: the completion photos and neighbour sign-off could not be checked. Try again, and tell the office if it keeps happening.`
  }
  const parts: string[] = []
  if (ev.missing.includes('completion_photos')) {
    parts.push(`${ev.photos} of ${ev.photos_required} completion photos`)
  }
  if (ev.missing.includes('neighbour_signoff')) {
    parts.push(`${ev.signoffs} of ${ev.signoffs_required} neighbour sign-off screenshot${ev.signoffs_required === 1 ? '' : 's'}`)
  }
  const lead = verb === 'invoiced' ? 'Complete the job in the app first: ' : 'Still needed: '
  return `${label}cannot be ${verb} yet. ${lead}${parts.join(' and ')} on file.`
}

/** Batch read. Fencing jobs only; every other vertical comes back as
 *  applies=false / satisfied=true without a query. */
export async function loadCompletionEvidenceByJob(
  client: any,
  jobs: EvidenceJobInput[],
): Promise<Map<string, CompletionEvidence>> {
  const out = new Map<string, CompletionEvidence>()
  const byId = new Map<string, EvidenceJobInput>()
  for (const job of jobs || []) {
    if (!job?.id) continue
    if (!byId.has(job.id)) byId.set(job.id, job)
  }
  const fencing = [...byId.values()].filter((j) => completionEvidenceApplies(j.vertical))
  for (const job of byId.values()) {
    if (!completionEvidenceApplies(job.vertical)) {
      out.set(job.id, evaluateCompletionEvidence({ job, media: [], events: [] }))
    }
  }
  if (fencing.length === 0) return out
  const ids = fencing.map((j) => j.id)
  const needScope = fencing.filter((j) => j.scope_json === undefined).map((j) => j.id)
  let readFailed = false
  const scopeById = new Map<string, unknown>()
  let mediaRows: any[] = []
  let eventRows: any[] = []
  try {
    const [scopeRes, mediaRes, eventsRes] = await Promise.all([
      needScope.length > 0
        ? client.from('jobs').select('id, scope_json').in('id', needScope)
        : Promise.resolve({ data: [], error: null }),
      client.from('job_media').select('id, job_id, phase, type').in('job_id', ids),
      client.from('job_events').select('id, job_id, event_type, detail_json, created_at')
        .eq('event_type', NEIGHBOUR_SIGNOFF_WAIVED_EVENT).in('job_id', ids),
    ])
    if (scopeRes?.error || mediaRes?.error || eventsRes?.error) {
      readFailed = true
      console.error('[ops-api] completion evidence read failed:', scopeRes?.error?.message || mediaRes?.error?.message || eventsRes?.error?.message)
    }
    for (const row of scopeRes?.data || []) scopeById.set(String(row.id), row.scope_json)
    mediaRows = mediaRes?.data || []
    eventRows = eventsRes?.data || []
  } catch (e) {
    readFailed = true
    console.error('[ops-api] completion evidence read threw:', (e as Error)?.message || e)
  }
  for (const job of fencing) {
    const scope = job.scope_json !== undefined ? job.scope_json : scopeById.get(job.id)
    out.set(job.id, evaluateCompletionEvidence({
      job: { ...job, scope_json: scope },
      media: mediaRows.filter((m) => String(m?.job_id || '') === job.id),
      events: eventRows.filter((e) => String(e?.job_id || '') === job.id),
      readFailed,
    }))
  }
  return out
}
