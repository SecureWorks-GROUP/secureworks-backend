// deno-lint-ignore-file no-explicit-any
// Ghost observer auto-mirror (Captain 2026-09-17): "repair works that are
// scheduled need to be seen by Shaun as a ghost assignment too, just as any
// other job would." Every genuine, dated crew assignment mirrors a ghost
// watcher row for each watcher whose scope covers that job, so their own
// calendar shows the schedule without ever crediting them as crew.
//
// Who watches what (Captain 2026-10-05): Shaun watches EVERY job type
// (make-safe, repair, fencing, patio, decking, ...). Nithin watches patio
// jobs only; on any other job he appears only when he is allocated as real
// crew. The list lives in GHOST_WATCHERS below.
//
// The first version picked "the oldest users.role = 'ops_manager'" as the one
// watcher. Eight people hold that role, and Nithin's account is one day older
// than Shaun's, so every ghost meant for Shaun landed on Nithin instead. The
// watchers are now named explicitly by email, never inferred from a role.
//
// A ghost is `job_assignments.is_ghost = true`, `role = 'observer'`. That
// shape and its read-side exclusion contract (calendar_events, my_jobs, the
// Trade app, the make-safe planner's next/last-visit logic) are documented in
// AGENTS.md and pinned by myjobs_ghost_rows_test.ts — this module NEVER
// touches a read path, only the write side that used to be entirely manual.
//
// `job_assignments_job_user_date_key` is UNIQUE(job_id, user_id,
// scheduled_date) with no is_ghost / status predicate, so a watcher can hold
// at most ONE row per job/date — ghost or real, live or cancelled. Every
// writer here therefore reads that one row first and reuses it (revives a
// cancelled ghost, yields to a real assignment) rather than inserting blind,
// and `releaseGhostObserverMirrorForRealAssignee` clears the ghost out of the
// way before a real row for that watcher lands on the key.
//
// Creating a ghost respects each watcher's scope. Cleaning one up does not:
// when the crew for a date goes away, every watcher's ghost for that date is
// removed, so a ghost written before a scope change still gets tidied.
//
// `job_assignments.role` is intentionally re-checked here rather than
// imported from index.ts's OBSERVER_ROLES: index.ts imports FROM this module
// (matching every other ops-api helper file), so importing back would be
// circular. Keep the two sets in sync by hand if either changes.
import { fetchAllRows } from "./makesafe_compact_reads.ts";

const GHOST_MIRROR_OBSERVER_ROLES = new Set(["observer", "ghost"]);
// `job_assignments.status` is nullable, and a plain `.neq('status', ...)`
// drops NULL-status rows under SQL three-valued logic. Every live-row read
// here keeps NULL and excludes only an explicit cancel.
const LIVE_STATUS_PREDICATE = "status.is.null,status.neq.cancelled";
// Planning entries (calendar meetings/reminders) are not field work and must
// never mint a ghost — mirrors the SMS notify skip in createAssignment.
const GHOST_MIRROR_PLANNING_TYPES = new Set(["meeting", "reminder"]);

export const GHOST_OBSERVER_MIRROR_SOURCE = "ghost_auto_mirror";

/** The role every ghost observer mirror row carries. */
export const GHOST_OBSERVER_ROLE = "observer";

/**
 * One person who gets a ghost row on scheduled jobs. `jobTypes: null` means
 * every job type; otherwise only jobs whose `jobs.type` is in the list.
 */
export type GhostWatcherRule = {
  email: string;
  jobTypes: string[] | null;
};

/**
 * Captain 2026-10-05: Shaun sees every scheduled job; Nithin sees patio jobs
 * only. Order matters only for the return value of
 * `ensureGhostObserverMirror` (the first watcher's ghost is reported).
 */
export const GHOST_WATCHERS: ReadonlyArray<GhostWatcherRule> = [
  { email: "shaun@secureworkswa.com.au", jobTypes: null },
  { email: "nithin@secureworkswa.com.au", jobTypes: ["patio"] },
];

type ResolvedWatcher = { id: string; jobTypes: string[] | null };

export type GhostMirrorSpan = {
  jobId: string;
  scheduledDate: string;
  scheduledEnd?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  durationDays?: number | null;
  crewName?: string | null;
};

function positiveDurationDays(value: unknown): number | null {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The mutable span fields a ghost mirrors from its crew row. */
function ghostSpanFields(span: GhostMirrorSpan): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    scheduled_end: span.scheduledEnd || null,
    start_time: span.startTime || null,
    end_time: span.endTime || null,
  };
  const duration = positiveDurationDays(span.durationDays);
  if (duration !== null) fields.duration_days = duration;
  return fields;
}

function ghostSpanDiffers(
  row: WatcherSpanRow,
  span: GhostMirrorSpan,
): boolean {
  const want = ghostSpanFields(span);
  return Object.keys(want).some((key) =>
    (row.fields[key] ?? null) !== (want[key] ?? null)
  );
}

type WatcherSpanRow = {
  id: string;
  is_ghost: boolean;
  status: string;
  fields: Record<string, unknown>;
};

/**
 * A row counts as real, dated crew work — never an existing ghost/observer
 * placeholder, and never a planning-only meeting/reminder entry. Does NOT
 * require `user_id`: the legacy `approve_assignment_request` writer creates
 * name-only assist rows, which still represent genuine scheduled field work.
 */
export function isGenuineCrewAssignmentRow(row: any): boolean {
  if (!row) return false;
  if (row.is_ghost === true) return false;
  const role = String(row.role || "").toLowerCase();
  const type = String(row.assignment_type || "").toLowerCase();
  if (
    GHOST_MIRROR_OBSERVER_ROLES.has(role) ||
    GHOST_MIRROR_OBSERVER_ROLES.has(type)
  ) return false;
  if (GHOST_MIRROR_PLANNING_TYPES.has(type)) return false;
  return true;
}

export function isAssignmentUserDateUniqueViolation(error: any): boolean {
  if (String(error?.code || "") !== "23505") return false;
  const detail = `${error?.message || ""} ${error?.details || ""} ${
    error?.hint || ""
  }`;
  return detail.includes("job_assignments_job_user_date_key") ||
    detail.includes("(job_id, user_id, scheduled_date)");
}

/** Does this watcher's scope cover a job of this `jobs.type`? */
export function ghostWatcherCoversJobType(
  jobTypes: string[] | null,
  jobType: unknown,
): boolean {
  if (jobTypes === null) return true;
  const type = String(jobType || "").trim().toLowerCase();
  return !!type && jobTypes.includes(type);
}

/**
 * Every configured watcher that exists as a user, in GHOST_WATCHERS order.
 * Resolved by email at runtime (user ids are never hard-coded). A watcher
 * whose email has no user row is simply skipped.
 */
async function resolveGhostWatchers(
  client: any,
): Promise<ResolvedWatcher[]> {
  const emails = GHOST_WATCHERS.map((w) => w.email);
  const { data, error } = await client
    .from("users")
    .select("id, email")
    .in("email", emails);
  if (error) {
    console.log(
      "[ops-api] ghost observer mirror: failed to resolve watcher users:",
      error,
    );
    return [];
  }
  const idByEmail = new Map<string, string>();
  for (const row of data || []) {
    if (row?.id && row?.email) {
      idByEmail.set(String(row.email).toLowerCase(), String(row.id));
    }
  }
  const watchers: ResolvedWatcher[] = [];
  for (const rule of GHOST_WATCHERS) {
    const id = idByEmail.get(rule.email.toLowerCase());
    if (id) watchers.push({ id, jobTypes: rule.jobTypes });
  }
  return watchers;
}

/** The job's raw `jobs.type`, or null when it cannot be read. */
async function readJobType(client: any, jobId: string): Promise<string | null> {
  const { data, error } = await client
    .from("jobs")
    .select("type")
    .eq("id", jobId)
    .maybeSingle();
  if (error) {
    console.log("[ops-api] ghost observer mirror: job type read failed:", error);
    return null;
  }
  return data?.type ? String(data.type) : null;
}

/**
 * Every watcher, each flagged with whether their scope covers this job. A
 * job-type read fault leaves only the every-job watchers in scope, so a
 * fault never mints a ghost outside someone's scope.
 */
async function resolveGhostWatchersForJob(
  client: any,
  jobId: string,
): Promise<Array<{ id: string; inScope: boolean }>> {
  const watchers = await resolveGhostWatchers(client);
  if (!watchers.length) return [];
  const needsType = watchers.some((w) => w.jobTypes !== null);
  const jobType = needsType ? await readJobType(client, jobId) : null;
  return watchers.map((w) => ({
    id: w.id,
    inScope: ghostWatcherCoversJobType(w.jobTypes, jobType),
  }));
}

/**
 * The watcher's ONE row on (job, date) — ghost or real, any status — or
 * null. `unreadable` is distinct from "no row" so a read fault never lets a
 * caller insert onto a key it could not see.
 */
async function readWatcherRowForSpan(
  client: any,
  watcherId: string,
  jobId: string,
  scheduledDate: string,
): Promise<{ row: WatcherSpanRow | null; unreadable: boolean }> {
  const { data, error } = await client
    .from("job_assignments")
    .select(
      "id, is_ghost, status, scheduled_end, start_time, end_time, duration_days",
    )
    .eq("job_id", jobId)
    .eq("user_id", watcherId)
    .eq("scheduled_date", scheduledDate)
    .limit(1);
  if (error) {
    console.log(
      "[ops-api] ghost observer mirror: span-row read failed:",
      error,
    );
    return { row: null, unreadable: true };
  }
  const raw = Array.isArray(data) ? data[0] : null;
  if (!raw?.id) return { row: null, unreadable: false };
  return {
    row: {
      id: String(raw.id),
      is_ghost: raw.is_ghost === true,
      status: String(raw.status || "").toLowerCase(),
      fields: {
        scheduled_end: raw.scheduled_end ?? null,
        start_time: raw.start_time ?? null,
        end_time: raw.end_time ?? null,
        duration_days: raw.duration_days ?? null,
      },
    },
    unreadable: false,
  };
}

function isLiveGhost(row: WatcherSpanRow | null): row is WatcherSpanRow {
  return !!row && row.is_ghost && row.status !== "cancelled";
}

async function findGhostRowForSpan(
  client: any,
  watcherId: string,
  jobId: string,
  scheduledDate: string,
): Promise<{ id: string } | null> {
  const { row } = await readWatcherRowForSpan(
    client,
    watcherId,
    jobId,
    scheduledDate,
  );
  return isLiveGhost(row) ? { id: row.id } : null;
}

function ghostMirrorNotes(crewName?: string | null): string {
  return `Auto ghost observer for ${crewName || "crew"} schedule`;
}

async function writeGhostMirrorEvent(
  client: any,
  jobId: string,
  ghostId: string | undefined,
  scheduledDate: string,
  revived: boolean,
) {
  const { error } = await client.from("job_events").insert({
    job_id: jobId,
    event_type: "assignment_created",
    detail_json: {
      assignment_id: ghostId,
      date: scheduledDate,
      source: GHOST_OBSERVER_MIRROR_SOURCE,
      ...(revived ? { revived: true } : {}),
    },
  });
  if (error) {
    console.log("[ops-api] ghost observer mirror: event write failed:", error);
  }
}

async function reviveCancelledGhost(
  client: any,
  ghostId: string,
  span: GhostMirrorSpan,
): Promise<boolean> {
  const { error } = await client.from("job_assignments").update({
    status: "scheduled",
    confirmation_status: "tentative",
    ...ghostSpanFields(span),
    notes: ghostMirrorNotes(span.crewName),
  }).eq("id", ghostId);
  if (error) {
    console.log("[ops-api] ghost observer mirror: ghost revive failed:", error);
    return false;
  }
  return true;
}

async function syncLiveGhostSpan(
  client: any,
  row: WatcherSpanRow,
  span: GhostMirrorSpan,
): Promise<void> {
  if (!ghostSpanDiffers(row, span)) return;
  const { error } = await client.from("job_assignments").update(
    ghostSpanFields(span),
  ).eq("id", row.id);
  if (error) {
    console.log(
      "[ops-api] ghost observer mirror: ghost span sync failed:",
      error,
    );
  }
}

type EnsureResult = {
  created: boolean;
  ghostId?: string;
  opsManagerId?: string | null;
};

/**
 * Idempotent create for ONE watcher (see `ensureGhostObserverMirror`).
 * Scope is the caller's job: this never checks the job type.
 */
async function ensureGhostForWatcher(
  client: any,
  watcherId: string,
  span: GhostMirrorSpan,
  assigneeUserId?: string | null,
): Promise<EnsureResult> {
  if (assigneeUserId && String(assigneeUserId) === String(watcherId)) {
    return { created: false, opsManagerId: watcherId };
  }

  const reuse = async (): Promise<EnsureResult | null> => {
    const { row, unreadable } = await readWatcherRowForSpan(
      client,
      watcherId,
      span.jobId,
      span.scheduledDate,
    );
    if (unreadable) return { created: false, opsManagerId: watcherId };
    if (!row) return null;
    if (!row.is_ghost) {
      if (row.status !== "cancelled") {
        return { created: false, opsManagerId: watcherId };
      }
      console.log(
        `[ops-api] ghost observer mirror: watcher ${watcherId} holds a cancelled real assignment on job ${span.jobId} / ${span.scheduledDate}; not mirrored`,
      );
      return { created: false, opsManagerId: watcherId };
    }
    if (row.status !== "cancelled") {
      await syncLiveGhostSpan(client, row, span);
      return { created: false, ghostId: row.id, opsManagerId: watcherId };
    }
    const revived = await reviveCancelledGhost(client, row.id, span);
    if (!revived) return { created: false, opsManagerId: watcherId };
    await writeGhostMirrorEvent(
      client,
      span.jobId,
      row.id,
      span.scheduledDate,
      true,
    );
    return { created: true, ghostId: row.id, opsManagerId: watcherId };
  };

  const reused = await reuse();
  if (reused) return reused;

  const insertRow = {
    job_id: span.jobId,
    user_id: watcherId,
    scheduled_date: span.scheduledDate,
    ...ghostSpanFields(span),
    role: GHOST_OBSERVER_ROLE,
    assignment_type: "install",
    is_ghost: true,
    status: "scheduled",
    confirmation_status: "tentative",
    crew_name: null,
    notes: ghostMirrorNotes(span.crewName),
  };
  const { data, error } = await client.from("job_assignments").insert(insertRow)
    .select().single();
  if (error) {
    if (isAssignmentUserDateUniqueViolation(error)) {
      const raced = await reuse();
      if (raced) return raced;
    }
    console.log("[ops-api] ghost observer mirror: insert failed:", error);
    return { created: false, opsManagerId: watcherId };
  }

  await writeGhostMirrorEvent(
    client,
    span.jobId,
    data?.id,
    span.scheduledDate,
    false,
  );

  return {
    created: true,
    ghostId: data?.id ? String(data.id) : undefined,
    opsManagerId: watcherId,
  };
}

/**
 * Idempotent create: for every watcher whose scope covers the job, ensures
 * exactly one non-cancelled ghost observer row covers `span.scheduledDate` on
 * `span.jobId`, carrying the crew row's scheduled_end / start_time / end_time
 * / duration_days. A ghost already on the key is never duplicated: its span
 * fields are brought into line with this call (last writer wins) and no
 * second event is written. Skips a watcher who already holds a REAL row on
 * that key (they are crew — no watcher row needed) or who IS
 * `assigneeUserId`. A cancelled ghost on the key is revived in place rather
 * than inserted over, because the unique key does not exempt cancelled rows.
 *
 * Returns `created` when any watcher's ghost was created or revived, and the
 * first in-scope watcher's ghost id as `ghostId` / `opsManagerId`.
 */
export async function ensureGhostObserverMirror(
  client: any,
  span: GhostMirrorSpan,
  assigneeUserId?: string | null,
): Promise<EnsureResult> {
  if (!span?.jobId || !span?.scheduledDate) return { created: false };

  const watchers = (await resolveGhostWatchersForJob(client, span.jobId))
    .filter((w) => w.inScope);
  if (!watchers.length) return { created: false, opsManagerId: null };

  let first: EnsureResult | null = null;
  let created = false;
  for (const watcher of watchers) {
    const res = await ensureGhostForWatcher(
      client,
      watcher.id,
      span,
      assigneeUserId,
    );
    if (res.created) created = true;
    if (!first) first = res;
  }
  return { ...first!, created };
}

/**
 * A REAL crew row for `userId` is about to be written onto (job, date). When
 * that user is a watcher, any ghost row already on that exact key is deleted
 * first (cancelled included) so the unique key never fires and the real
 * assignment wins. Every writer of a real watcher row — insert or
 * date/assignee move — must call this before its write. No-op for anyone
 * else. Applies whatever the watcher's scope, because an out-of-scope ghost
 * on the key would block the real row just the same.
 */
export async function releaseGhostObserverMirrorForRealAssignee(
  client: any,
  params: { jobId: string; scheduledDate: string; userId?: string | null },
): Promise<{ removed: number }> {
  if (!params?.jobId || !params?.scheduledDate || !params?.userId) {
    return { removed: 0 };
  }
  const watchers = await resolveGhostWatchers(client);
  const watcherId = watchers.find((w) =>
    String(w.id) === String(params.userId)
  )?.id;
  if (!watcherId) return { removed: 0 };

  const { data, error } = await client
    .from("job_assignments")
    .delete()
    .eq("job_id", params.jobId)
    .eq("user_id", watcherId)
    .eq("scheduled_date", params.scheduledDate)
    .eq("is_ghost", true)
    .select("id");
  if (error) {
    console.log(
      "[ops-api] ghost observer mirror: release-for-real-assignee delete failed:",
      error,
    );
    return { removed: 0 };
  }
  return { removed: (data || []).length };
}

type SpanCoverage = {
  covered: boolean;
  unreadable: boolean;
  coveringRow: any | null;
};

/**
 * Does any OTHER non-cancelled, genuine crew row still cover `scheduledDate`
 * on `jobId`? Shared by reschedule-reconcile and delete/cancel-sync so both
 * agree on "the last crew row for that date is gone". Returns one covering
 * row so a caller can re-mirror the span from real crew facts. A read fault
 * reports `covered` so the mirror is never destructive on a fault.
 */
async function spanCrewCoverage(
  client: any,
  jobId: string,
  scheduledDate: string,
  excludeAssignmentId?: string | null,
): Promise<SpanCoverage> {
  const { data, error } = await client
    .from("job_assignments")
    .select(
      "id, user_id, role, assignment_type, is_ghost, status, scheduled_end, start_time, end_time, duration_days, crew_name",
    )
    .eq("job_id", jobId)
    .eq("scheduled_date", scheduledDate)
    .or(LIVE_STATUS_PREDICATE);
  if (error) {
    console.log(
      "[ops-api] ghost observer mirror: sibling-coverage read failed:",
      error,
    );
    return { covered: true, unreadable: true, coveringRow: null };
  }
  const coveringRow = (data || []).find((row: any) =>
    (!excludeAssignmentId ||
      String(row.id) !== String(excludeAssignmentId)) &&
    isGenuineCrewAssignmentRow(row)
  ) || null;
  return { covered: !!coveringRow, unreadable: false, coveringRow };
}

function spanFromCoveringRow(
  jobId: string,
  scheduledDate: string,
  cover: any,
): GhostMirrorSpan {
  return {
    jobId,
    scheduledDate,
    scheduledEnd: cover.scheduled_end ?? null,
    startTime: cover.start_time ?? null,
    endTime: cover.end_time ?? null,
    durationDays: cover.duration_days ?? null,
    crewName: cover.crew_name ?? null,
  };
}

async function deleteGhostRow(
  client: any,
  ghostId: string,
  label: string,
): Promise<boolean> {
  const { error } = await client.from("job_assignments").delete().eq(
    "id",
    ghostId,
  );
  if (error) {
    console.log(
      `[ops-api] ghost observer mirror: ${label} delete failed:`,
      error,
    );
    return false;
  }
  return true;
}

/**
 * Removes this watcher's live ghost(s) on (job, date). Used when nobody
 * works that date any more, or the watcher's scope no longer covers it.
 */
async function removeWatcherGhostsForSpan(
  client: any,
  watcherId: string,
  jobId: string,
  scheduledDate: string,
): Promise<number> {
  const { data, error } = await client
    .from("job_assignments")
    .select("id")
    .eq("job_id", jobId)
    .eq("user_id", watcherId)
    .eq("is_ghost", true)
    .eq("scheduled_date", scheduledDate)
    .or(LIVE_STATUS_PREDICATE);
  if (error) {
    console.log("[ops-api] ghost observer mirror: cleanup read failed:", error);
    return 0;
  }
  let removed = 0;
  for (const row of data || []) {
    if (await deleteGhostRow(client, String(row.id), "cleanup")) removed++;
  }
  return removed;
}

type RescheduleParams = {
  jobId: string;
  assignmentId: string;
  oldDate: string;
  newDate: string;
  newScheduledEnd?: string | null;
  newStartTime?: string | null;
  newEndTime?: string | null;
  newDurationDays?: number | null;
  crewName?: string | null;
  assigneeUserId?: string | null;
};

/** Reschedule reconcile for ONE in-scope watcher. */
async function reconcileGhostForWatcherOnReschedule(
  client: any,
  watcherId: string,
  params: RescheduleParams,
  oldCoverage: SpanCoverage,
): Promise<void> {
  const newSpan: GhostMirrorSpan = {
    jobId: params.jobId,
    scheduledDate: params.newDate,
    scheduledEnd: params.newScheduledEnd ?? null,
    startTime: params.newStartTime ?? null,
    endTime: params.newEndTime ?? null,
    durationDays: params.newDurationDays ?? null,
    crewName: params.crewName ?? null,
  };

  if (oldCoverage.covered && oldCoverage.coveringRow) {
    // The moved row may have been the watcher's own real row, which held the
    // old key in place of a ghost; the crew left behind still needs one.
    await ensureGhostForWatcher(
      client,
      watcherId,
      spanFromCoveringRow(
        params.jobId,
        params.oldDate,
        oldCoverage.coveringRow,
      ),
    );
  }

  if (!oldCoverage.covered) {
    const oldGhost = await findGhostRowForSpan(
      client,
      watcherId,
      params.jobId,
      params.oldDate,
    );
    if (oldGhost) {
      const assigneeIsWatcher = params.assigneeUserId &&
        String(params.assigneeUserId) === String(watcherId);
      const newRow = assigneeIsWatcher
        ? { row: null, unreadable: false }
        : await readWatcherRowForSpan(
          client,
          watcherId,
          params.jobId,
          params.newDate,
        );
      if (assigneeIsWatcher || newRow.row) {
        // The watcher is now the real assignee, or already holds a row on
        // the new date — the stale old-date ghost is redundant. A cancelled
        // ghost on the new date is revived by the ensure below.
        await deleteGhostRow(client, oldGhost.id, "stale old-date ghost");
        if (
          newRow.row && newRow.row.is_ghost &&
          newRow.row.status === "cancelled"
        ) {
          await ensureGhostForWatcher(
            client,
            watcherId,
            newSpan,
            params.assigneeUserId ?? null,
          );
        }
        return;
      }
      if (newRow.unreadable) {
        console.log(
          "[ops-api] ghost observer mirror: new-date span unreadable; old-date ghost left in place",
        );
        return;
      }
      const { error: moveErr } = await client.from("job_assignments").update({
        scheduled_date: params.newDate,
        ...ghostSpanFields(newSpan),
        notes: ghostMirrorNotes(params.crewName),
      }).eq("id", oldGhost.id);
      if (moveErr) {
        console.log(
          "[ops-api] ghost observer mirror: ghost date move failed:",
          moveErr,
        );
        if (isAssignmentUserDateUniqueViolation(moveErr)) {
          // Something already holds the new key — the old-date ghost is the
          // only thing left to remove.
          await deleteGhostRow(
            client,
            oldGhost.id,
            "old-date ghost after move conflict",
          );
        }
      }
      return;
    }
  }

  await ensureGhostForWatcher(
    client,
    watcherId,
    newSpan,
    params.assigneeUserId ?? null,
  );
}

/**
 * Reschedule: when a genuine crew assignment's date moves and no other crew
 * row still covers the OLD date, each in-scope watcher's ghost for the old
 * date moves with it (or is dropped if the new date is already held by any
 * row of that watcher, or created fresh if none existed). When another crew
 * row still holds the old date, the old ghost is left alone and the new date
 * simply gets its own mirror. An out-of-scope watcher never gains a ghost;
 * their stale old-date ghost is removed once nobody works that date.
 */
export async function reconcileGhostObserverMirrorOnReschedule(
  client: any,
  params: RescheduleParams,
): Promise<void> {
  if (
    !params?.jobId || !params?.oldDate || !params?.newDate ||
    params.oldDate === params.newDate
  ) return;

  const watchers = await resolveGhostWatchersForJob(client, params.jobId);
  if (!watchers.length) return;

  const oldCoverage = await spanCrewCoverage(
    client,
    params.jobId,
    params.oldDate,
    params.assignmentId,
  );

  for (const watcher of watchers) {
    if (watcher.inScope) {
      await reconcileGhostForWatcherOnReschedule(
        client,
        watcher.id,
        params,
        oldCoverage,
      );
    } else if (!oldCoverage.covered) {
      await removeWatcherGhostsForSpan(
        client,
        watcher.id,
        params.jobId,
        params.oldDate,
      );
    }
  }
}

/**
 * Deletion / cancellation of a crew row, or a row leaving a span: brings the
 * span back to the invariant. When no other genuine crew row still covers
 * that job/date, every watcher's mirrored ghost for that span is removed —
 * never left pointing at a date nobody is working. When other crew DOES
 * still cover it, each in-scope watcher's ghost is (re-)ensured from that
 * crew's facts, because the departing row may have been the watcher's own
 * real assignment, which held the unique key in place of a ghost.
 */
export async function syncGhostObserverMirrorForSpan(
  client: any,
  params: {
    jobId: string;
    scheduledDate: string;
    excludeAssignmentId?: string | null;
  },
): Promise<{ removed: number; ensured: boolean }> {
  if (!params?.jobId || !params?.scheduledDate) {
    return { removed: 0, ensured: false };
  }

  const watchers = await resolveGhostWatchersForJob(client, params.jobId);
  if (!watchers.length) return { removed: 0, ensured: false };

  const coverage = await spanCrewCoverage(
    client,
    params.jobId,
    params.scheduledDate,
    params.excludeAssignmentId,
  );
  if (coverage.covered) {
    if (!coverage.coveringRow) return { removed: 0, ensured: false };
    const span = spanFromCoveringRow(
      params.jobId,
      params.scheduledDate,
      coverage.coveringRow,
    );
    let ensured = false;
    for (const watcher of watchers) {
      if (!watcher.inScope) continue;
      const res = await ensureGhostForWatcher(client, watcher.id, span);
      if (res.created) ensured = true;
    }
    return { removed: 0, ensured };
  }

  let removed = 0;
  for (const watcher of watchers) {
    removed += await removeWatcherGhostsForSpan(
      client,
      watcher.id,
      params.jobId,
      params.scheduledDate,
    );
  }
  return { removed, ensured: false };
}

// ── Backfill (backfill_ghost_observers action) ──────────────────────────────

export type GhostBackfillCandidate = {
  watcherId: string;
  jobId: string;
  scheduledDate: string;
  scheduledEnd: string | null;
  startTime: string | null;
  endTime: string | null;
  durationDays: number | null;
  crewName: string | null;
  job: any;
};

/**
 * One candidate per (watcher, job/date span) where a non-cancelled, non-ghost,
 * genuine crew assignment is dated `today` or later, the watcher's scope
 * covers the job, and the watcher does not already hold a live row on that
 * span (ghost or real). Read-only — never writes; every read pages past the
 * PostgREST 1000-row ceiling. Job-type categorisation for reporting is left
 * to the caller (index.ts owns `_jobVertical`, and importing it here would be
 * circular), so each candidate carries its raw `job` row.
 */
export async function findGhostObserverBackfillCandidates(
  client: any,
  opts: { today: string },
): Promise<GhostBackfillCandidate[]> {
  const watchers = await resolveGhostWatchers(client);
  if (!watchers.length) return [];

  const rows = await fetchAllRows<any>(
    () =>
      client
        .from("job_assignments")
        .select(
          "id, job_id, user_id, role, assignment_type, is_ghost, status, scheduled_date, " +
            "scheduled_end, start_time, end_time, duration_days, crew_name, jobs:job_id(type, metadata, job_number)",
        )
        .eq("is_ghost", false)
        .or(LIVE_STATUS_PREDICATE)
        .gte("scheduled_date", opts.today),
    "ghost observer backfill: crew rows",
    "id",
  );

  const watcherRows = await fetchAllRows<any>(
    () =>
      client
        .from("job_assignments")
        .select("id, user_id, job_id, scheduled_date, status")
        .in("user_id", watchers.map((w) => w.id))
        .or(LIVE_STATUS_PREDICATE)
        .gte("scheduled_date", opts.today),
    "ghost observer backfill: watcher rows",
    "id",
  );

  const covered = new Set(
    watcherRows.map((g: any) =>
      `${g.user_id}::${g.job_id}::${g.scheduled_date}`
    ),
  );

  const seen = new Set<string>();
  const candidates: GhostBackfillCandidate[] = [];
  for (const row of rows) {
    if (!isGenuineCrewAssignmentRow(row)) continue;
    if (!row.job_id || !row.scheduled_date) continue;
    for (const watcher of watchers) {
      if (!ghostWatcherCoversJobType(watcher.jobTypes, row.jobs?.type)) {
        continue;
      }
      if (row.user_id && String(row.user_id) === String(watcher.id)) continue;
      const key = `${watcher.id}::${row.job_id}::${row.scheduled_date}`;
      if (covered.has(key) || seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        watcherId: watcher.id,
        jobId: row.job_id,
        scheduledDate: row.scheduled_date,
        scheduledEnd: row.scheduled_end ?? null,
        startTime: row.start_time ?? null,
        endTime: row.end_time ?? null,
        durationDays: row.duration_days ?? null,
        crewName: row.crew_name ?? null,
        job: row.jobs || null,
      });
    }
  }
  return candidates;
}

/** Writes a ghost for every candidate (each call idempotent on its own). */
export async function applyGhostObserverBackfill(
  client: any,
  candidates: GhostBackfillCandidate[],
): Promise<{ created: number; failed: number }> {
  let created = 0;
  let failed = 0;
  for (const c of candidates) {
    const res = await ensureGhostForWatcher(client, c.watcherId, {
      jobId: c.jobId,
      scheduledDate: c.scheduledDate,
      scheduledEnd: c.scheduledEnd,
      startTime: c.startTime,
      endTime: c.endTime,
      durationDays: c.durationDays,
      crewName: c.crewName,
    });
    if (res.created) created++;
    else failed++;
  }
  return { created, failed };
}
