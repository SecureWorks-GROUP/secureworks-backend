// Client sign-off — the gate between "job finished" and "allocated trades can
// invoice it" (Marnin, 19 Oct 2026, CALLS DSP-11): "trades should invoice when
// the job has been signed off by the client, they should have a workflow where
// they physically sign the job and say they are happy with it and then we
// chase them up for payment and this allows the allocated trades to get onto
// it".
//
// The record is public.job_client_signoffs (20261020170100): append-only, the
// newest row per job is current. Two ways in:
//   - on_site: the completion wizard. complete_my_job records the client's
//     name, the stored signature (job_media phase 'signature'), the rating and,
//     when the app sends it, the "happy with the work" tick.
//   - office_waiver: staff sign off for the client with a written reason
//     (waive_client_signoff), mirroring the neighbour sign-off waiver.
//
// Whether the current row counts is decided here, never stored:
//   - a waiver always counts;
//   - an on-site sign-off counts when happy is not false and the rating is
//     absent or at least client_signoff_settings.min_happy_rating.
//
// PROPOSALS awaiting Marnin's word (client_signoff_settings, seeded by the
// migration): the rating threshold (4), the job types the gate covers
// (fencing, patio; builder-paid make-safe/repair/insurance have no homeowner to
// sign), and applies_from (jobs completed before it are not held). Also a
// proposal: an on-site signature from the current app, which has no happy tick
// yet, counts when the rating passes.
//
// The invoice gate runs only while feature flag
// trade_invoice_requires_client_signoff_v1 is on (seeded off). A missing or
// unreadable flag is OFF, as for every invoice flag. With the flag on, a
// sign-off or settings read that fails is fail-closed: the job is not billable
// until the read succeeds. Read paths (my_work_orders, my_hours) carry the
// evaluation so the app can say "waiting for the client to sign off"; write
// paths (submit_work_order_invoice, the weekly resolver, per-metre
// submit_trade_invoice) refuse with the same message. Hourly crew time is not
// gated, matching the completion evidence gate.

export const CLIENT_SIGNOFF_FLAG = 'trade_invoice_requires_client_signoff_v1'
export const CLIENT_SIGNOFF_BLOCK_REASON = 'client_signoff'
export const CLIENT_SIGNED_OFF_EVENT = 'client_signed_off'
export const CLIENT_SIGNOFF_NOT_HAPPY_EVENT = 'client_signoff_not_happy'
/** The trade sent a sign-off but it could not be stored: not the same as unsigned. */
export const CLIENT_SIGNOFF_NOT_RECORDED_EVENT = 'client_signoff_not_recorded'
export const SIGNATURE_MEDIA_PHASE = 'signature'

export type ClientSignoffSettings = {
  min_happy_rating: number
  gated_job_types: string[]
  applies_from: string | null
}

// Fallback when the settings row is absent. Same values the migration seeds.
export const DEFAULT_CLIENT_SIGNOFF_SETTINGS: ClientSignoffSettings = {
  min_happy_rating: 4,
  gated_job_types: ['fencing', 'patio'],
  applies_from: null,
}

export type ClientSignoffRow = {
  id: string
  job_id: string
  method: string
  signed_name?: string | null
  happy?: boolean | null
  satisfaction_rating?: number | null
  signature_media_id?: string | null
  waiver_reason?: string | null
  created_at: string
}

export type ClientSignoffMissing =
  | 'evidence_unavailable'
  | 'not_signed'
  | 'client_not_happy'
  | 'rating_below_threshold'

export type ClientSignoff = {
  job_id: string
  applies: boolean
  satisfied: boolean
  current: {
    id: string
    method: string
    signed_name: string | null
    happy: boolean | null
    satisfaction_rating: number | null
    created_at: string
  } | null
  missing: ClientSignoffMissing | null
  read_failed: boolean
}

export type ClientSignoffJobInput = {
  id: string
  type: string
  completed_at?: string | null
}

function text(value: unknown): string {
  return String(value ?? '').trim()
}

export function clientSignoffApplies(
  job: ClientSignoffJobInput,
  settings: ClientSignoffSettings,
): boolean {
  const type = text(job.type).toLowerCase()
  if (!settings.gated_job_types.map((t) => text(t).toLowerCase()).includes(type)) return false
  if (!settings.applies_from) return true
  const from = new Date(settings.applies_from).getTime()
  if (Number.isNaN(from)) return true
  const completed = job.completed_at ? new Date(job.completed_at).getTime() : NaN
  // A job not yet recorded complete, or completed on or after the start, is held.
  return Number.isNaN(completed) || completed >= from
}

/** The newest row wins; ties break on id so the answer is stable. */
export function currentClientSignoff(rows: ClientSignoffRow[]): ClientSignoffRow | null {
  let best: ClientSignoffRow | null = null
  for (const row of rows || []) {
    if (!row) continue
    if (!best) { best = row; continue }
    const a = new Date(row.created_at).getTime()
    const b = new Date(best.created_at).getTime()
    if (a > b || (a === b && text(row.id) > text(best.id))) best = row
  }
  return best
}

export function evaluateClientSignoff(args: {
  job: ClientSignoffJobInput
  rows: ClientSignoffRow[]
  settings: ClientSignoffSettings
  readFailed?: boolean
}): ClientSignoff {
  const applies = clientSignoffApplies(args.job, args.settings)
  const row = currentClientSignoff(args.rows)
  const current = row
    ? {
      id: row.id,
      method: row.method,
      signed_name: text(row.signed_name) || null,
      happy: typeof row.happy === 'boolean' ? row.happy : null,
      satisfaction_rating: row.satisfaction_rating == null ? null : Number(row.satisfaction_rating),
      created_at: row.created_at,
    }
    : null
  let missing: ClientSignoffMissing | null = null
  if (args.readFailed) missing = 'evidence_unavailable'
  else if (!current) missing = 'not_signed'
  else if (current.method === 'revoked') missing = 'not_signed'
  else if (current.method !== 'office_waiver') {
    if (current.happy === false) missing = 'client_not_happy'
    else if (current.satisfaction_rating != null && current.satisfaction_rating < args.settings.min_happy_rating) {
      missing = 'rating_below_threshold'
    }
  }
  return {
    job_id: args.job.id,
    applies,
    satisfied: !applies || missing === null,
    current,
    missing,
    read_failed: args.readFailed === true,
  }
}

/** True when a just-recorded sign-off counts, regardless of job type. */
export function signoffRowCounts(row: ClientSignoffRow, settings: ClientSignoffSettings): boolean {
  return evaluateClientSignoff({
    job: { id: row.job_id, type: settings.gated_job_types[0] || 'fencing' },
    rows: [row],
    settings: { ...settings, applies_from: null },
  }).missing === null
}

export function clientSignoffMessage(ev: ClientSignoff, jobLabel?: string | null): string {
  const label = jobLabel ? `${jobLabel} ` : 'This job '
  switch (ev.missing) {
    case 'evidence_unavailable':
      return `${label}cannot be invoiced yet: the client sign-off could not be checked. Try again, and tell the office if it keeps happening.`
    case 'client_not_happy':
    case 'rating_below_threshold':
      return `${label}cannot be invoiced yet: the client has not signed it off as happy. The office will follow up with the client.`
    default:
      return `${label}cannot be invoiced yet: waiting for the client to sign the job off.`
  }
}

/**
 * Reads the switch. A missing or unreadable flag is OFF: a flag read fault
 * must never be the reason a trade cannot submit an invoice.
 */
export async function clientSignoffRequired(
  // deno-lint-ignore no-explicit-any
  client: any,
): Promise<boolean> {
  try {
    const { data, error } = await client.from('feature_flags')
      .select('enabled')
      .eq('flag_name', CLIENT_SIGNOFF_FLAG)
      .limit(1)
    if (error) {
      console.error('[ops-api] client sign-off flag unreadable, treating as off:', error.message)
      return false
    }
    return (Array.isArray(data) ? data[0] : data)?.enabled === true
  } catch (error) {
    console.error('[ops-api] client sign-off flag read threw, treating as off:', error instanceof Error ? error.message : String(error))
    return false
  }
}

function normaliseSettings(row: unknown): ClientSignoffSettings {
  const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>
  const rating = Number(r.min_happy_rating)
  const types = Array.isArray(r.gated_job_types) ? r.gated_job_types.map((t) => text(t)).filter(Boolean) : null
  return {
    min_happy_rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : DEFAULT_CLIENT_SIGNOFF_SETTINGS.min_happy_rating,
    gated_job_types: types ?? DEFAULT_CLIENT_SIGNOFF_SETTINGS.gated_job_types,
    applies_from: text(r.applies_from) || null,
  }
}

/** Settings read; ok:false when the read failed (callers fail closed). */
export async function loadClientSignoffSettings(
  // deno-lint-ignore no-explicit-any
  client: any,
): Promise<{ ok: boolean; settings: ClientSignoffSettings }> {
  try {
    const { data, error } = await client.from('client_signoff_settings')
      .select('min_happy_rating, gated_job_types, applies_from')
      .eq('id', 1)
      .limit(1)
    if (error) {
      console.error('[ops-api] client sign-off settings read failed:', error.message)
      return { ok: false, settings: DEFAULT_CLIENT_SIGNOFF_SETTINGS }
    }
    const row = Array.isArray(data) ? data[0] : data
    return { ok: true, settings: row ? normaliseSettings(row) : DEFAULT_CLIENT_SIGNOFF_SETTINGS }
  } catch (error) {
    console.error('[ops-api] client sign-off settings read threw:', error instanceof Error ? error.message : String(error))
    return { ok: false, settings: DEFAULT_CLIENT_SIGNOFF_SETTINGS }
  }
}

/**
 * Batch read for the invoice gate. Returns null while the flag is off: no
 * caller reads a sign-off then. Jobs outside the gated types come back
 * applies=false / satisfied=true without a sign-off query.
 */
export async function loadClientSignoffByJob(
  // deno-lint-ignore no-explicit-any
  client: any,
  jobs: ClientSignoffJobInput[],
): Promise<Map<string, ClientSignoff> | null> {
  if (!(await clientSignoffRequired(client))) return null
  const out = new Map<string, ClientSignoff>()
  const byId = new Map<string, ClientSignoffJobInput>()
  for (const job of jobs || []) {
    if (job?.id && !byId.has(job.id)) byId.set(job.id, job)
  }
  if (byId.size === 0) return out
  const { ok: settingsOk, settings } = await loadClientSignoffSettings(client)
  const gated = [...byId.values()].filter((j) => !settingsOk || clientSignoffApplies(j, settings))
  for (const job of byId.values()) {
    if (settingsOk && !clientSignoffApplies(job, settings)) {
      out.set(job.id, evaluateClientSignoff({ job, rows: [], settings }))
    }
  }
  if (gated.length === 0) return out
  let readFailed = !settingsOk
  let rows: ClientSignoffRow[] = []
  if (!readFailed) {
    try {
      // Chunked so a long weekly invoice never overflows the request URL, and
      // newest first so the row cap can only ever cut older sign-offs.
      for (const chunk of chunkClientSignoffIds(gated.map((j) => j.id))) {
        const { data, error } = await client.from('job_client_signoffs')
          .select('id, job_id, method, signed_name, happy, satisfaction_rating, signature_media_id, waiver_reason, created_at')
          .in('job_id', chunk)
          .order('created_at', { ascending: false })
        if (error) {
          readFailed = true
          console.error('[ops-api] client sign-off read failed:', error.message)
          break
        }
        rows.push(...(data || []))
      }
    } catch (error) {
      readFailed = true
      console.error('[ops-api] client sign-off read threw:', error instanceof Error ? error.message : String(error))
    }
    if (readFailed) rows = []
  }
  for (const job of gated) {
    const ev = evaluateClientSignoff({
      job,
      rows: rows.filter((r) => text(r?.job_id) === job.id),
      settings,
      readFailed,
    })
    // An unreadable settings row cannot say the job is outside the gate.
    out.set(job.id, readFailed ? { ...ev, applies: true, satisfied: false } : ev)
  }
  return out
}

/** Job ids per .in() filter: 100 uuids keep a request well inside the URL budget. */
export const CLIENT_SIGNOFF_ID_CHUNK = 100

export function chunkClientSignoffIds(ids: string[], size = CLIENT_SIGNOFF_ID_CHUNK): string[][] {
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}
