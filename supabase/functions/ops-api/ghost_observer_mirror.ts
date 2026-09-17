// deno-lint-ignore-file no-explicit-any
// Ghost observer auto-mirror (Captain 2026-09-17): "repair works that are
// scheduled need to be seen by Shaun as a ghost assignment too, just as any
// other job would." Every genuine, dated crew assignment on ANY job type
// (make-safe, repair, fencing, patio, decking, …) mirrors a ghost watcher row
// for the ops manager, so his own calendar shows every scheduled job without
// ever crediting him as crew.
//
// A ghost is `job_assignments.is_ghost = true`, `role = 'observer'`. That
// shape and its read-side exclusion contract (calendar_events, my_jobs, the
// Trade app, the make-safe planner's next/last-visit logic) are documented in
// AGENTS.md and pinned by myjobs_ghost_rows_test.ts — this module NEVER
// touches a read path, only the write side that used to be entirely manual.
//
// `job_assignments.role` is intentionally re-checked here rather than
// imported from index.ts's OBSERVER_ROLES: index.ts imports FROM this module
// (matching every other ops-api helper file), so importing back would be
// circular. Keep the two sets in sync by hand if either changes.
const GHOST_MIRROR_OBSERVER_ROLES = new Set(['observer', 'ghost'])
// Planning entries (calendar meetings/reminders) are not field work and must
// never mint a ghost — mirrors the SMS notify skip in createAssignment.
const GHOST_MIRROR_PLANNING_TYPES = new Set(['meeting', 'reminder'])

export const GHOST_OBSERVER_MIRROR_SOURCE = 'ghost_auto_mirror'

/** The role every ghost observer mirror row carries. */
export const GHOST_OBSERVER_ROLE = 'observer'

export type GhostMirrorSpan = {
  jobId: string
  scheduledDate: string
  scheduledEnd?: string | null
  startTime?: string | null
  endTime?: string | null
  crewName?: string | null
}

/**
 * A row counts as real, dated crew work — never an existing ghost/observer
 * placeholder, and never a planning-only meeting/reminder entry. Does NOT
 * require `user_id`: the legacy `approve_assignment_request` writer creates
 * name-only assist rows, which still represent genuine scheduled field work.
 */
export function isGenuineCrewAssignmentRow(row: any): boolean {
  if (!row) return false
  if (row.is_ghost === true) return false
  const role = String(row.role || '').toLowerCase()
  const type = String(row.assignment_type || '').toLowerCase()
  if (GHOST_MIRROR_OBSERVER_ROLES.has(role) || GHOST_MIRROR_OBSERVER_ROLES.has(type)) return false
  if (GHOST_MIRROR_PLANNING_TYPES.has(type)) return false
  return true
}

/**
 * The ops manager to mirror onto every job. Resolved by ROLE at runtime
 * (never a hard-coded user id) — `users.role = 'ops_manager'`. Deterministic
 * when more than one such user exists (oldest account wins) rather than
 * picking arbitrarily.
 */
export async function resolveOpsManagerUserId(client: any): Promise<string | null> {
  const { data, error } = await client
    .from('users')
    .select('id')
    .eq('role', 'ops_manager')
    .order('created_at', { ascending: true })
    .limit(1)
  if (error) {
    console.log('[ops-api] ghost observer mirror: failed to resolve ops manager user:', error)
    return null
  }
  const row = Array.isArray(data) ? data[0] : null
  return row?.id ? String(row.id) : null
}

async function findGhostRowForSpan(
  client: any,
  opsManagerId: string,
  jobId: string,
  scheduledDate: string,
): Promise<{ id: string } | null> {
  const { data, error } = await client
    .from('job_assignments')
    .select('id')
    .eq('job_id', jobId)
    .eq('user_id', opsManagerId)
    .eq('is_ghost', true)
    .eq('scheduled_date', scheduledDate)
    .neq('status', 'cancelled')
    .limit(1)
  if (error) {
    console.log('[ops-api] ghost observer mirror: ghost-row read failed:', error)
    return null
  }
  const row = Array.isArray(data) ? data[0] : null
  return row?.id ? { id: String(row.id) } : null
}

/**
 * Idempotent create: ensures exactly one non-cancelled ghost observer row for
 * the ops manager covers `span.scheduledDate` on `span.jobId`. No-ops when
 * the ops manager cannot be resolved, when a covering ghost already exists,
 * or when `assigneeUserId` IS the ops manager (he is already the real
 * assignee — no watcher row needed).
 */
export async function ensureGhostObserverMirror(
  client: any,
  span: GhostMirrorSpan,
  assigneeUserId?: string | null,
): Promise<{ created: boolean; ghostId?: string; opsManagerId?: string | null }> {
  if (!span?.jobId || !span?.scheduledDate) return { created: false }

  const opsManagerId = await resolveOpsManagerUserId(client)
  if (!opsManagerId) return { created: false, opsManagerId: null }
  if (assigneeUserId && String(assigneeUserId) === String(opsManagerId)) {
    return { created: false, opsManagerId }
  }

  const existing = await findGhostRowForSpan(client, opsManagerId, span.jobId, span.scheduledDate)
  if (existing) return { created: false, ghostId: existing.id, opsManagerId }

  const insertRow = {
    job_id: span.jobId,
    user_id: opsManagerId,
    scheduled_date: span.scheduledDate,
    scheduled_end: span.scheduledEnd || null,
    start_time: span.startTime || null,
    end_time: span.endTime || null,
    role: GHOST_OBSERVER_ROLE,
    assignment_type: 'install',
    is_ghost: true,
    status: 'scheduled',
    confirmation_status: 'tentative',
    crew_name: null,
    notes: `Auto ghost observer for ${span.crewName || 'crew'} schedule`,
  }
  const { data, error } = await client.from('job_assignments').insert(insertRow).select().single()
  if (error) {
    console.log('[ops-api] ghost observer mirror: insert failed:', error)
    return { created: false, opsManagerId }
  }

  await client.from('job_events').insert({
    job_id: span.jobId,
    event_type: 'assignment_created',
    detail_json: {
      assignment_id: data?.id,
      date: span.scheduledDate,
      source: GHOST_OBSERVER_MIRROR_SOURCE,
    },
  })

  return { created: true, ghostId: data?.id ? String(data.id) : undefined, opsManagerId }
}

/**
 * Does any OTHER non-cancelled, genuine crew row still cover `scheduledDate`
 * on `jobId`? Shared by reschedule-reconcile and delete/cancel-cleanup so
 * both agree on "the last crew row for that date is gone".
 */
async function anotherCrewRowStillCoversSpan(
  client: any,
  jobId: string,
  scheduledDate: string,
  excludeAssignmentId?: string | null,
): Promise<boolean> {
  const { data, error } = await client
    .from('job_assignments')
    .select('id, role, assignment_type, is_ghost, status')
    .eq('job_id', jobId)
    .eq('scheduled_date', scheduledDate)
    .neq('status', 'cancelled')
  if (error) {
    console.log('[ops-api] ghost observer mirror: sibling-coverage read failed:', error)
    // A read fault must never make the mirror destructive — assume coverage
    // still exists so a ghost is never wrongly removed.
    return true
  }
  return (data || []).some((row: any) =>
    (!excludeAssignmentId || String(row.id) !== String(excludeAssignmentId)) &&
    isGenuineCrewAssignmentRow(row),
  )
}

/**
 * Reschedule: when a genuine crew assignment's date moves and no other crew
 * row still covers the OLD date, the ops manager's ghost for the old date
 * moves with it (or is dropped if a ghost already covers the new date, or
 * created fresh if none existed). When another crew row still holds the old
 * date, the old ghost is left alone and the new date simply gets its own
 * mirror via the same idempotent `ensureGhostObserverMirror`.
 */
export async function reconcileGhostObserverMirrorOnReschedule(
  client: any,
  params: {
    jobId: string
    assignmentId: string
    oldDate: string
    newDate: string
    newScheduledEnd?: string | null
    newStartTime?: string | null
    newEndTime?: string | null
    crewName?: string | null
    assigneeUserId?: string | null
  },
): Promise<void> {
  if (!params?.jobId || !params?.oldDate || !params?.newDate || params.oldDate === params.newDate) return

  const opsManagerId = await resolveOpsManagerUserId(client)
  if (!opsManagerId) return

  const stillCovered = await anotherCrewRowStillCoversSpan(
    client, params.jobId, params.oldDate, params.assignmentId,
  )

  if (!stillCovered) {
    const oldGhost = await findGhostRowForSpan(client, opsManagerId, params.jobId, params.oldDate)
    if (oldGhost) {
      const assigneeIsOpsManager = params.assigneeUserId &&
        String(params.assigneeUserId) === String(opsManagerId)
      const newGhost = assigneeIsOpsManager
        ? null
        : await findGhostRowForSpan(client, opsManagerId, params.jobId, params.newDate)
      if (assigneeIsOpsManager || newGhost) {
        // The ops manager is now the real assignee, or the new date is
        // already mirrored — the stale old-date ghost is redundant.
        await client.from('job_assignments').delete().eq('id', oldGhost.id)
      } else {
        await client.from('job_assignments').update({
          scheduled_date: params.newDate,
          scheduled_end: params.newScheduledEnd ?? null,
          start_time: params.newStartTime ?? null,
          end_time: params.newEndTime ?? null,
        }).eq('id', oldGhost.id)
      }
      return
    }
  }

  await ensureGhostObserverMirror(client, {
    jobId: params.jobId,
    scheduledDate: params.newDate,
    scheduledEnd: params.newScheduledEnd ?? null,
    startTime: params.newStartTime ?? null,
    endTime: params.newEndTime ?? null,
    crewName: params.crewName ?? null,
  }, params.assigneeUserId ?? null)
}

/**
 * Deletion / cancellation of a crew row: when no other genuine crew row still
 * covers that job/date, the ops manager's mirrored ghost for that span is
 * removed too — never left pointing at a date nobody is working.
 */
export async function cleanupGhostObserverMirrorForSpan(
  client: any,
  params: { jobId: string; scheduledDate: string; excludeAssignmentId?: string | null },
): Promise<{ removed: number }> {
  if (!params?.jobId || !params?.scheduledDate) return { removed: 0 }

  const opsManagerId = await resolveOpsManagerUserId(client)
  if (!opsManagerId) return { removed: 0 }

  const stillCovered = await anotherCrewRowStillCoversSpan(
    client, params.jobId, params.scheduledDate, params.excludeAssignmentId,
  )
  if (stillCovered) return { removed: 0 }

  const { data, error } = await client
    .from('job_assignments')
    .select('id')
    .eq('job_id', params.jobId)
    .eq('user_id', opsManagerId)
    .eq('is_ghost', true)
    .eq('scheduled_date', params.scheduledDate)
    .neq('status', 'cancelled')
  if (error) {
    console.log('[ops-api] ghost observer mirror: cleanup read failed:', error)
    return { removed: 0 }
  }

  let removed = 0
  for (const row of data || []) {
    const { error: delErr } = await client.from('job_assignments').delete().eq('id', row.id)
    if (!delErr) removed++
  }
  return { removed }
}

// ── Backfill (backfill_ghost_observers action) ──────────────────────────────

export type GhostBackfillCandidate = {
  jobId: string
  scheduledDate: string
  scheduledEnd: string | null
  startTime: string | null
  endTime: string | null
  crewName: string | null
  job: any
}

/**
 * Every non-cancelled, non-ghost, genuine crew assignment dated `today` or
 * later on a job/date span the ops manager does not already have a ghost
 * covering. Read-only — never writes. Job-type categorisation is left to the
 * caller (index.ts owns `_jobVertical`, and importing it here would be
 * circular), so each candidate carries its raw `job` row.
 */
export async function findGhostObserverBackfillCandidates(
  client: any,
  opts: { today: string },
): Promise<GhostBackfillCandidate[]> {
  const opsManagerId = await resolveOpsManagerUserId(client)
  if (!opsManagerId) return []

  const { data: rows, error } = await client
    .from('job_assignments')
    .select(
      'id, job_id, user_id, role, assignment_type, is_ghost, status, scheduled_date, ' +
      'scheduled_end, start_time, end_time, crew_name, jobs:job_id(type, metadata, job_number)',
    )
    .eq('is_ghost', false)
    .neq('status', 'cancelled')
    .gte('scheduled_date', opts.today)
  if (error) throw error

  const { data: ghostRows, error: ghostErr } = await client
    .from('job_assignments')
    .select('job_id, scheduled_date')
    .eq('is_ghost', true)
    .eq('user_id', opsManagerId)
    .neq('status', 'cancelled')
    .gte('scheduled_date', opts.today)
  if (ghostErr) throw ghostErr

  const covered = new Set(
    (ghostRows || []).map((g: any) => `${g.job_id}::${g.scheduled_date}`),
  )

  const seenSpans = new Set<string>()
  const candidates: GhostBackfillCandidate[] = []
  for (const row of rows || []) {
    if (!isGenuineCrewAssignmentRow(row)) continue
    if (!row.job_id || !row.scheduled_date) continue
    if (row.user_id && String(row.user_id) === String(opsManagerId)) continue
    const spanKey = `${row.job_id}::${row.scheduled_date}`
    if (covered.has(spanKey) || seenSpans.has(spanKey)) continue
    seenSpans.add(spanKey)
    candidates.push({
      jobId: row.job_id,
      scheduledDate: row.scheduled_date,
      scheduledEnd: row.scheduled_end ?? null,
      startTime: row.start_time ?? null,
      endTime: row.end_time ?? null,
      crewName: row.crew_name ?? null,
      job: row.jobs || null,
    })
  }
  return candidates
}

/** Writes a ghost for every candidate (each call idempotent on its own). */
export async function applyGhostObserverBackfill(
  client: any,
  candidates: GhostBackfillCandidate[],
): Promise<{ created: number }> {
  let created = 0
  for (const c of candidates) {
    const res = await ensureGhostObserverMirror(client, {
      jobId: c.jobId,
      scheduledDate: c.scheduledDate,
      scheduledEnd: c.scheduledEnd,
      startTime: c.startTime,
      endTime: c.endTime,
      crewName: c.crewName,
    })
    if (res.created) created++
  }
  return { created }
}
