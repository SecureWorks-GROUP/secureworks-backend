// deno-lint-ignore-file no-explicit-any
// Job bookings: the light read of a job's bookings and the all-or-nothing move
// or stretch of them (Ops Dash calendar, owner's go 28 Oct 2026).
//
// A job on the calendar is a set of separate crew bookings (job_assignments
// rows, often one per crew member per day). Before this, a drag saved each
// booking with its own update_assignment call, so a failure partway left the
// job half moved. Here the whole change is planned once on the server and
// written by ONE Postgres function (reschedule_job_assignments_v1, migration
// 20261028150000): every row changes or none does.
//
// The plan is a port of the calendar's own planner (secureworks-ux ops.html,
// CalOpsCore.planJobMove / planJobStretch) so a booking lands on the same day
// whichever side plans it:
//   - weekends are breaks: an interior Sat/Sun is never a worked day, and a
//     weekend day counts only as a chosen end;
//   - a move keeps every booking's working-day offset from the first day and
//     its own working-day length, so gaps between days hold;
//   - a stretch holds the other end and gives every crew member the same days
//     added or taken away, extending their one multi-day row when it reaches
//     the dragged end and adding one-day rows otherwise.
// Only live crew bookings move: never a ghost watcher row, a cancelled row, a
// completed visit or a meeting / reminder.
//
// What update_assignment / create_assignment / delete_assignment do around a
// write is kept: the make-safe attendance-cycle binding and trade visibility
// are worked out before the write and carried into it, an invoiced booking is
// never deleted, and the GHL push, ghost watcher sync and make-safe report
// binding run once after the write commits (per job, per date, per crew
// member), never once per row. No message to a customer or crew member is
// sent from here: the reschedule texts stay with the calendar's own prompt,
// and rows a stretch adds are silent, as the calendar already makes them.

import { isGenuineCrewAssignmentRow } from "./ghost_observer_mirror.ts";

/** The fields the light read returns, and only these. */
export const JOB_BOOKING_READ_COLUMNS =
  "id, user_id, role, status, is_ghost, scheduled_date, scheduled_end";

/** What the planner and the write read of each of the job's rows. */
export const JOB_BOOKING_PLAN_COLUMNS = [
  "id",
  "job_id",
  "user_id",
  "crew_name",
  "role",
  "status",
  "assignment_type",
  "is_ghost",
  "scheduled_date",
  "scheduled_end",
  "duration_days",
  "start_time",
  "end_time",
  "confirmation_status",
  "attendance_cycle_id",
  "cycle_attribution",
].join(", ");

// job_assignments.status is nullable; a bare .neq('status','cancelled') would
// drop NULL rows (SQL three-valued logic), so the read keeps them explicitly.
const NOT_CANCELLED_PREDICATE = "status.is.null,status.neq.cancelled";

export class JobBookingsError extends Error {
  code: string;
  status: number;
  details: Record<string, unknown>;
  constructor(
    code: string,
    status: number,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type JobBookingRow = {
  id: string;
  job_id?: string | null;
  user_id?: string | null;
  crew_name?: string | null;
  role?: string | null;
  status?: string | null;
  assignment_type?: string | null;
  is_ghost?: boolean | null;
  scheduled_date: string;
  scheduled_end?: string | null;
  duration_days?: number | null;
  start_time?: string | null;
  end_time?: string | null;
  confirmation_status?: string | null;
  attendance_cycle_id?: string | null;
  cycle_attribution?: string | null;
};

// ── Working-day date math (pure; mirrors CalOpsCore) ─────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function day(value: unknown): string {
  return String(value || "").slice(0, 10);
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + (days | 0));
  return d.toISOString().slice(0, 10);
}

export function isWeekend(dateStr: string): boolean {
  const dow = new Date(dateStr + "T00:00:00Z").getUTCDay();
  return dow === 0 || dow === 6;
}

/** A row's last day; an end before its start reads as a one-day span. */
export function spanEnd(
  row: { scheduled_date: string; scheduled_end?: string | null },
): string {
  const s = day(row.scheduled_date);
  const e = day(row.scheduled_end) || s;
  return e < s ? s : e;
}

/** `durationDays` worked days laid forward from startStr (day 1 is startStr). */
export function layWorkingDays(startStr: string, durationDays: number): string {
  const n = Math.max(1, Math.round(Number(durationDays) || 1));
  let cur = startStr;
  for (let i = 1; i < n; i++) {
    cur = addDays(cur, 1);
    while (isWeekend(cur)) cur = addDays(cur, 1);
  }
  return cur;
}

/** Days in [start,end] that are worked: weekdays, and Sat/Sun only as an end. */
export function paintedSpanDates(
  startStr: string,
  endStr?: string | null,
): string[] {
  const out: string[] = [];
  const end = !endStr || endStr < startStr ? startStr : endStr;
  for (let d = startStr; d <= end; d = addDays(d, 1)) {
    if (!isWeekend(d) || d === startStr || d === end) out.push(d);
  }
  return out;
}

export function workingSpanDays(
  startStr: string,
  endStr?: string | null,
): number {
  return paintedSpanDates(startStr, endStr).length;
}

/** The date N working days from startStr (negative goes back); weekends skipped. */
export function shiftWorkingDays(startStr: string, n: number): string {
  const steps = Math.round(Number(n) || 0);
  const dir = steps < 0 ? -1 : 1;
  let cur = startStr;
  for (let i = 0; i < Math.abs(steps); i++) {
    cur = addDays(cur, dir);
    while (isWeekend(cur)) cur = addDays(cur, dir);
  }
  return cur;
}

// ── Which rows move ──────────────────────────────────────────────────────────

const GHOST_MARKERS = new Set(["observer", "ghost"]);
const PLANNING_TYPES = new Set(["meeting", "reminder"]);
const DONE_STATUSES = new Set(["cancelled", "complete", "completed"]);

/** A live crew booking: the only kind a job move or stretch acts on. */
export function isLiveJobBookingRow(row: any): boolean {
  if (!row || !row.id || !isIsoDate(day(row.scheduled_date))) return false;
  if (row.is_ghost === true) return false;
  const role = String(row.role || "").toLowerCase();
  const type = String(row.assignment_type || "install").toLowerCase();
  if (GHOST_MARKERS.has(role) || GHOST_MARKERS.has(type)) return false;
  if (PLANNING_TYPES.has(type)) return false;
  return !DONE_STATUSES.has(String(row.status || "").toLowerCase());
}

function normaliseRow(row: any): JobBookingRow {
  return {
    ...row,
    id: String(row.id),
    scheduled_date: day(row.scheduled_date),
    scheduled_end: row.scheduled_end ? day(row.scheduled_end) : null,
  };
}

export type JobSpan = { start: string; end: string };

export function jobSpan(rows: JobBookingRow[]): JobSpan | null {
  let span: JobSpan | null = null;
  for (const row of rows) {
    const s = row.scheduled_date;
    const e = spanEnd(row);
    if (!span) span = { start: s, end: e };
    else {
      if (s < span.start) span.start = s;
      if (e > span.end) span.end = e;
    }
  }
  return span;
}

// ── The plan ─────────────────────────────────────────────────────────────────

export type PlanUpdate = {
  id: string;
  user_id: string | null;
  expected_scheduled_date: string;
  expected_scheduled_end: string | null;
  scheduled_date: string;
  scheduled_end: string;
  duration_days: number;
};

export type PlanCreate = {
  template_id: string;
  user_id: string;
  crew_name: string | null;
  role: string;
  assignment_type: string;
  scheduled_date: string;
  scheduled_end: string;
  duration_days: number;
  start_time: string | null;
  end_time: string | null;
  confirmation_status: string;
};

export type PlanDelete = {
  id: string;
  user_id: string | null;
  expected_scheduled_date: string;
  expected_scheduled_end: string | null;
};

export type JobBookingPlan = {
  kind: "move" | "stretch";
  edge?: "start" | "end";
  from: JobSpan | null;
  to: JobSpan | null;
  updates: PlanUpdate[];
  creates: PlanCreate[];
  deletes: PlanDelete[];
  /** Crew a stretch would add days for who have no user on record. */
  unbookable: JobBookingRow[];
};

function emptyPlan(
  kind: "move" | "stretch",
  from: JobSpan | null,
): JobBookingPlan {
  return {
    kind,
    from,
    to: null,
    updates: [],
    creates: [],
    deletes: [],
    unbookable: [],
  };
}

function updateFor(row: JobBookingRow, start: string, end: string): PlanUpdate {
  return {
    id: row.id,
    user_id: row.user_id ?? null,
    expected_scheduled_date: row.scheduled_date,
    expected_scheduled_end: row.scheduled_end ?? null,
    scheduled_date: start,
    scheduled_end: end,
    duration_days: workingSpanDays(start, end),
  };
}

/** A row's start or end dragged onto a day; the other edge holds, never inverts. */
function resizeUpdate(
  row: JobBookingRow,
  edge: "start" | "end",
  target: string,
): PlanUpdate {
  const start = row.scheduled_date;
  const end = row.scheduled_end || start;
  const newStart = edge === "start" ? (target > end ? end : target) : start;
  const newEnd = edge === "end" ? (target < start ? start : target) : end;
  return updateFor(row, newStart, newEnd);
}

/** The rows as they will be once the plan is written. */
export function applyPlanToRows(
  rows: JobBookingRow[],
  plan: JobBookingPlan,
): JobBookingRow[] {
  const upd = new Map(plan.updates.map((u) => [u.id, u]));
  const del = new Set(plan.deletes.map((d) => d.id));
  const out: JobBookingRow[] = [];
  for (const row of rows) {
    if (del.has(row.id)) continue;
    const u = upd.get(row.id);
    out.push(
      u
        ? {
          ...row,
          scheduled_date: u.scheduled_date,
          scheduled_end: u.scheduled_end,
          duration_days: u.duration_days,
        }
        : row,
    );
  }
  plan.creates.forEach((c, i) => {
    out.push({
      id: `planned-${i}-${c.scheduled_date}`,
      user_id: c.user_id,
      role: c.role,
      assignment_type: c.assignment_type,
      status: "scheduled",
      scheduled_date: c.scheduled_date,
      scheduled_end: c.scheduled_end,
      duration_days: c.duration_days,
    });
  });
  return out;
}

/**
 * Move: newStart is the bookings' new FIRST day. Each booking keeps its
 * working-day offset from the first day and its own working-day length, so
 * Fri, Mon, Tue, Thu moved one working day later is Mon, Tue, Wed, Fri.
 */
export function planJobBookingMove(
  rows: JobBookingRow[],
  newStart: string,
): JobBookingPlan {
  const live = rows.filter(isLiveJobBookingRow).map(normaliseRow);
  const span = jobSpan(live);
  const plan = emptyPlan("move", span);
  if (!span || !newStart || newStart === span.start) return plan;
  for (const row of live) {
    const rowStart = layWorkingDays(
      newStart,
      workingSpanDays(span.start, row.scheduled_date),
    );
    const duration = row.scheduled_end
      ? workingSpanDays(row.scheduled_date, row.scheduled_end)
      : (Number(row.duration_days) > 0
        ? Math.round(Number(row.duration_days))
        : 1);
    plan.updates.push(
      updateFor(row, rowStart, layWorkingDays(rowStart, duration)),
    );
  }
  plan.to = jobSpan(applyPlanToRows(live, plan));
  return plan;
}

function crewKey(row: JobBookingRow): string {
  return row.user_id ? "u:" + row.user_id : "n:" + String(row.crew_name || "");
}

/**
 * Stretch: drag one END of the bookings onto `target`; the other end holds.
 * Every crew member gains or loses the same working days (a weekend day only
 * as the chosen end) and their own gaps stay gaps. A crew member whose own
 * booking reaches the dragged end as one row has that row's start or end
 * moved; anyone else gets a new one-day row for each added day, or loses the
 * rows past the new end.
 */
export function planJobBookingStretch(
  rows: JobBookingRow[],
  edge: "start" | "end",
  target: string,
): JobBookingPlan {
  const live = rows.filter(isLiveJobBookingRow).map(normaliseRow);
  const span = jobSpan(live);
  const plan = emptyPlan("stretch", span);
  plan.edge = edge;
  if (!span || !target) return plan;
  let newStart = span.start;
  let newEnd = span.end;
  if (edge === "start") newStart = target > span.end ? span.end : target;
  else newEnd = target < span.start ? span.start : target;
  if (newStart === span.start && newEnd === span.end) return plan;

  let added: string[] = [];
  if (edge === "start" && newStart < span.start) {
    added = paintedSpanDates(newStart, span.start).filter((d) =>
      d !== span.start
    );
  } else if (edge === "end" && newEnd > span.end) {
    added = paintedSpanDates(span.end, newEnd).filter((d) => d !== span.end);
  }

  const groups = new Map<string, JobBookingRow[]>();
  for (const row of live) {
    const g = crewKey(row);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(row);
  }

  for (const evs of groups.values()) {
    if (added.length) {
      const anchor = evs.reduce((best: JobBookingRow | null, row) => {
        if (!best) return row;
        return edge === "start"
          ? (row.scheduled_date < best.scheduled_date ? row : best)
          : (spanEnd(row) > spanEnd(best) ? row : best);
      }, null)!;
      const atEdge = edge === "start"
        ? anchor.scheduled_date === span.start
        : spanEnd(anchor) === span.end;
      if (
        atEdge && (evs.length === 1 || spanEnd(anchor) > anchor.scheduled_date)
      ) {
        plan.updates.push(
          resizeUpdate(anchor, edge, edge === "start" ? newStart : newEnd),
        );
        continue;
      }
      if (!anchor.user_id) {
        plan.unbookable.push(anchor);
        continue;
      }
      const confirmation = anchor.confirmation_status === "placeholder"
        ? "placeholder"
        : "tentative";
      for (const d of added) {
        plan.creates.push({
          template_id: anchor.id,
          user_id: String(anchor.user_id),
          crew_name: anchor.crew_name ?? null,
          role: anchor.role || "lead_installer",
          assignment_type: anchor.assignment_type || "install",
          scheduled_date: d,
          scheduled_end: d,
          duration_days: 1,
          start_time: anchor.start_time ?? null,
          end_time: anchor.end_time ?? null,
          confirmation_status: confirmation,
        });
      }
      continue;
    }
    for (const row of evs) {
      const s = row.scheduled_date;
      const e = spanEnd(row);
      const asDelete: PlanDelete = {
        id: row.id,
        user_id: row.user_id ?? null,
        expected_scheduled_date: row.scheduled_date,
        expected_scheduled_end: row.scheduled_end ?? null,
      };
      if (edge === "start") {
        if (e < newStart) plan.deletes.push(asDelete);
        else if (s < newStart) {
          plan.updates.push(resizeUpdate(row, "start", newStart));
        }
      } else {
        if (s > newEnd) plan.deletes.push(asDelete);
        else if (e > newEnd) {
          plan.updates.push(resizeUpdate(row, "end", newEnd));
        }
      }
    }
  }
  plan.to = jobSpan(applyPlanToRows(live, plan));
  return plan;
}

// ── The write order and the date clash check ─────────────────────────────────

function keyOf(userId: string | null | undefined, date: string): string | null {
  // A NULL user_id is not constrained by job_assignments_job_user_date_key.
  return userId ? `${userId}|${date}` : null;
}

/**
 * Checks every date the plan writes against job_assignments_job_user_date_key
 * (job_id, user_id, scheduled_date), which has no status or ghost exemption,
 * and orders the updates so no write ever lands on a key another pending
 * update still holds (a one-day shift frees Wed before Tue and Tue before
 * Mon). `allRows` is every row of the job, cancelled and completed included.
 * A watcher's own ghost on a target key does not block: the write releases it
 * (as update_assignment does). Throws `booking_date_taken` when a row the plan
 * does not move holds a target date, so nothing is written.
 */
export function orderPlanForWrite(
  allRows: JobBookingRow[],
  plan: JobBookingPlan,
  watcherUserIds: ReadonlySet<string>,
): PlanUpdate[] {
  const moving = new Set([
    ...plan.updates.map((u) => u.id),
    ...plan.deletes.map((d) => d.id),
  ]);
  const fixed = new Map<string, JobBookingRow>();
  for (const raw of allRows) {
    const row = normaliseRow(raw);
    if (moving.has(row.id)) continue;
    const k = keyOf(row.user_id, row.scheduled_date);
    if (!k) continue;
    const releasable = row.is_ghost === true && !!row.user_id &&
      watcherUserIds.has(String(row.user_id));
    if (!releasable) fixed.set(k, row);
  }

  const landing = new Map<string, string>();
  const claim = (userId: string | null, date: string, by: string) => {
    const k = keyOf(userId, date);
    if (!k) return;
    const holder = fixed.get(k);
    if (holder || landing.has(k)) {
      throw new JobBookingsError(
        "booking_date_taken",
        409,
        `Not changed: that crew member already has a booking on this job on ${date}`,
        {
          user_id: userId,
          scheduled_date: date,
          assignment_id: by,
          held_by: holder ? holder.id : landing.get(k),
          constraint: "job_assignments_job_user_date_key",
        },
      );
    }
    landing.set(k, by);
  };
  for (const u of plan.updates) claim(u.user_id, u.scheduled_date, u.id);
  plan.creates.forEach((c, i) =>
    claim(c.user_id, c.scheduled_date, `planned-${i}`)
  );

  // Order: an update whose target key is still another pending update's
  // source key waits for it.
  const pending = plan.updates.slice();
  const ordered: PlanUpdate[] = [];
  while (pending.length) {
    const sources = new Map<string, string>();
    for (const u of pending) {
      const k = keyOf(u.user_id, u.expected_scheduled_date);
      if (k) sources.set(k, u.id);
    }
    const idx = pending.findIndex((u) => {
      const k = keyOf(u.user_id, u.scheduled_date);
      const holder = k ? sources.get(k) : undefined;
      return !holder || holder === u.id;
    });
    if (idx < 0) {
      throw new JobBookingsError(
        "booking_order_unresolvable",
        409,
        "Not changed: these bookings swap dates with each other and cannot be saved in one step",
        { assignment_ids: pending.map((u) => u.id) },
      );
    }
    ordered.push(pending.splice(idx, 1)[0]);
  }
  return ordered;
}

// ── The light read ───────────────────────────────────────────────────────────

/** A job's non-cancelled bookings, with exactly JOB_BOOKING_READ_COLUMNS. */
export async function readJobBookings(client: any, jobId: string) {
  const [jobRes, rowsRes] = await Promise.all([
    client.from("jobs").select("id").eq("id", jobId).maybeSingle(),
    client.from("job_assignments")
      .select(JOB_BOOKING_READ_COLUMNS)
      .eq("job_id", jobId)
      .or(NOT_CANCELLED_PREDICATE)
      .order("scheduled_date", { ascending: true })
      .order("id", { ascending: true }),
  ]);
  if (jobRes.error) throw jobRes.error;
  if (rowsRes.error) throw rowsRes.error;
  if (!jobRes.data) {
    throw new JobBookingsError("job_not_found", 404, "Job not found", {
      job_id: jobId,
    });
  }
  return { job_id: jobId, bookings: (rowsRes.data || []).map(toReadShape) };
}

function toReadShape(row: any) {
  return {
    id: row.id,
    user_id: row.user_id ?? null,
    role: row.role ?? null,
    status: row.status ?? null,
    is_ghost: row.is_ghost === true,
    scheduled_date: row.scheduled_date ?? null,
    scheduled_end: row.scheduled_end ?? null,
  };
}

// ── The write ────────────────────────────────────────────────────────────────

/** What index.ts lends the write: the make-safe helpers and event logging. */
export type JobBookingsDeps = {
  /** A make-safe by its type or job number (a make-safe detail row also counts). */
  isMakesafeJobType: (job: any) => boolean;
  ensureAttendanceCycle: (
    jobId: string,
    cycleNumber: number,
    reason: string,
  ) => Promise<{ id: string }>;
  reconcileReportBinding: (params: {
    jobId: string;
    userId: string;
    attendanceCycleId: string;
    preferredAssignmentId: string;
  }) => Promise<void>;
  isGenuineTradeAssignment: (row: any) => boolean;
  logBusinessEvent: (event: Record<string, unknown>) => void;
  pushGhlScheduledDate: (opportunityId: string, scheduledDate: string) => void;
  recomputeJobIntelligence: (jobId: string) => void;
  /** Every ghost watcher's user id (resolveGhostWatcherUserIds). */
  ghostWatcherUserIds: () => Promise<string[]>;
  /** Brings one date's watcher ghosts back in line (syncGhostObserverMirrorForSpan). */
  syncGhostWatchers: (jobId: string, scheduledDate: string) => Promise<void>;
  releasedInvoiceStatuses: readonly string[];
};

export type RescheduleRequest =
  | {
    jobId: string;
    kind: "move";
    newStart: string;
    assignmentIds: string[] | null;
    operator: string | null;
  }
  | {
    jobId: string;
    kind: "stretch";
    edge: "start" | "end";
    target: string;
    assignmentIds: string[] | null;
    operator: string | null;
  };

/** Reads and checks the request body. `shift_working_days` is resolved later. */
export function parseRescheduleBody(
  body: any,
): RescheduleRequest & { shiftWorkingDays?: number } {
  const jobId = String(body?.job_id || body?.jobId || "").trim();
  if (!jobId) {
    throw new JobBookingsError("job_id_required", 400, "job_id required");
  }
  const kind = String(body?.mode || body?.kind || "").toLowerCase();
  const rawIds = body?.assignment_ids ?? body?.assignmentIds;
  let assignmentIds: string[] | null = null;
  if (rawIds !== undefined && rawIds !== null) {
    if (
      !Array.isArray(rawIds) || !rawIds.length ||
      rawIds.some((id: unknown) => typeof id !== "string" || !id)
    ) {
      throw new JobBookingsError(
        "assignment_ids_invalid",
        400,
        "assignment_ids must be a non-empty list of booking ids",
      );
    }
    assignmentIds = [...new Set(rawIds as string[])];
  }
  const operator = body?.operator_email || body?.user_email || null;
  if (kind === "move") {
    const newStart = body?.new_start ?? body?.newStart;
    const shift = body?.shift_working_days ?? body?.shiftWorkingDays;
    if (newStart !== undefined && newStart !== null) {
      if (!isIsoDate(newStart)) {
        throw new JobBookingsError(
          "new_start_invalid",
          400,
          "new_start must be a YYYY-MM-DD date",
        );
      }
      return { jobId, kind, newStart, assignmentIds, operator };
    }
    if (
      typeof shift === "number" && Number.isInteger(shift) && shift !== 0 &&
      Math.abs(shift) <= 366
    ) {
      return {
        jobId,
        kind,
        newStart: "",
        shiftWorkingDays: shift,
        assignmentIds,
        operator,
      };
    }
    throw new JobBookingsError(
      "move_target_required",
      400,
      "A move needs new_start (YYYY-MM-DD) or shift_working_days (a whole number of working days, not 0)",
    );
  }
  if (kind === "stretch") {
    const edge = String(body?.edge || "").toLowerCase();
    if (edge !== "start" && edge !== "end") {
      throw new JobBookingsError(
        "edge_invalid",
        400,
        "A stretch needs edge: 'start' or 'end'",
      );
    }
    const target = body?.target ?? body?.target_date;
    if (!isIsoDate(target)) {
      throw new JobBookingsError(
        "target_invalid",
        400,
        "A stretch needs target (YYYY-MM-DD)",
      );
    }
    return { jobId, kind, edge, target, assignmentIds, operator };
  }
  throw new JobBookingsError(
    "mode_invalid",
    400,
    "mode must be 'move' or 'stretch'",
  );
}

/** Maps a reschedule_job_assignments_v1 refusal (SQLSTATE JB4xx) to an error. */
export function jobBookingsRpcError(error: any): Error {
  const sqlstate = String(error?.code || "");
  if (sqlstate === "JB409" || sqlstate === "JB404") {
    let details: Record<string, unknown> = {};
    try {
      details = error?.hint ? JSON.parse(String(error.hint)) : {};
    } catch {
      details = {};
    }
    return new JobBookingsError(
      String(
        error?.details ||
          (sqlstate === "JB404" ? "job_not_found" : "booking_changed"),
      ),
      sqlstate === "JB404" ? 404 : 409,
      String(error?.message || "Not changed"),
      details,
    );
  }
  return error instanceof Error
    ? error
    : new Error(String(error?.message || error));
}

/**
 * Moves or stretches one job's live bookings in one step. Reads the job's
 * rows, plans the change, checks its dates, then hands every write to
 * reschedule_job_assignments_v1, which re-checks each row is as read under a
 * lock and either writes all of them or none. Follow-up work runs once after
 * the write commits; a follow-up failure is reported in `follow_up_failures`
 * and never undoes or hides the committed move.
 */
export async function rescheduleJobBookings(
  client: any,
  body: any,
  deps: JobBookingsDeps,
) {
  const req = parseRescheduleBody(body);

  const [jobRes, rowsRes] = await Promise.all([
    client.from("jobs").select(
      "id, type, job_number, status, ghl_opportunity_id",
    ).eq("id", req.jobId).maybeSingle(),
    client.from("job_assignments").select(JOB_BOOKING_PLAN_COLUMNS).eq(
      "job_id",
      req.jobId,
    ),
  ]);
  if (jobRes.error) throw jobRes.error;
  if (rowsRes.error) throw rowsRes.error;
  const job = jobRes.data;
  if (!job) {
    throw new JobBookingsError("job_not_found", 404, "Job not found", {
      job_id: req.jobId,
    });
  }
  const allRows: JobBookingRow[] = (rowsRes.data || []).map(normaliseRow);

  let live = allRows.filter(isLiveJobBookingRow);
  if (req.assignmentIds) {
    const liveIds = new Set(live.map((r) => r.id));
    const notLive = req.assignmentIds.filter((id) => !liveIds.has(id));
    if (notLive.length) {
      throw new JobBookingsError(
        "booking_not_live",
        409,
        "Not changed: a booking named is not a live crew booking on this job (it may have moved, been cancelled or been completed)",
        { assignment_ids: notLive },
      );
    }
    const wanted = new Set(req.assignmentIds);
    live = live.filter((r) => wanted.has(r.id));
  }
  if (!live.length) {
    throw new JobBookingsError(
      "no_live_bookings",
      409,
      "Not changed: this job has no live crew bookings to move",
    );
  }

  let plan: JobBookingPlan;
  if (req.kind === "move") {
    const shift = (req as { shiftWorkingDays?: number }).shiftWorkingDays;
    const span = jobSpan(live)!;
    const newStart = shift ? shiftWorkingDays(span.start, shift) : req.newStart;
    plan = planJobBookingMove(live, newStart);
  } else {
    plan = planJobBookingStretch(live, req.edge, req.target);
  }
  if (plan.unbookable.length) {
    throw new JobBookingsError(
      "crew_without_user",
      409,
      "Not changed: a crew member on this job has no user on record to book the added days to",
      {
        assignment_ids: plan.unbookable.map((r) => r.id),
        crew_names: plan.unbookable.map((r) => r.crew_name ?? null),
      },
    );
  }
  if (!plan.updates.length && !plan.creates.length && !plan.deletes.length) {
    return {
      ok: true,
      changed: false,
      job_id: req.jobId,
      kind: plan.kind,
      from: plan.from,
      to: plan.from,
      updated: [],
      created: [],
      deleted: [],
      bookings: allRows.filter((r) =>
        String(r.status || "").toLowerCase() !== "cancelled"
      ).map(toReadShape),
      follow_up_failures: [],
    };
  }

  const watcherIds = await deps.ghostWatcherUserIds();
  const orderedUpdates = orderPlanForWrite(allRows, plan, new Set(watcherIds));

  // Make-safe parity with update_assignment / create_assignment: an existing
  // bound row is attendance history and keeps its cycle; an unbound row is
  // bound to the current cycle when it is written; a new make-safe row is
  // visible to trades and bound. Worked out once for the job.
  const rowById = new Map(allRows.map((r) => [r.id, r]));
  const isBound = (row: JobBookingRow | undefined) =>
    !!(row?.attendance_cycle_id && row?.cycle_attribution === "bound");
  const { data: detail, error: detailErr } = await client.from(
    "makesafe_job_details",
  )
    .select("cycle_number").eq("job_id", req.jobId).maybeSingle();
  if (detailErr) throw detailErr;
  const isMakesafe = deps.isMakesafeJobType(job) || !!detail;
  let cycleForUpdates: { id: string } | null = null;
  let cycleForCreates: { id: string } | null = null;
  if (detail) {
    const cycleNumber = Number(detail.cycle_number || 1);
    if (orderedUpdates.some((u) => !isBound(rowById.get(u.id)))) {
      cycleForUpdates = await deps.ensureAttendanceCycle(
        req.jobId,
        cycleNumber,
        "assignment_reassign",
      );
    }
    if (plan.creates.length) {
      cycleForCreates = await deps.ensureAttendanceCycle(
        req.jobId,
        cycleNumber,
        "allocate_job",
      );
    }
  }
  const rpcUpdates = orderedUpdates.map((u) => {
    const bound = isBound(rowById.get(u.id));
    return {
      id: u.id,
      expected_user_id: u.user_id,
      expected_scheduled_date: u.expected_scheduled_date,
      expected_scheduled_end: u.expected_scheduled_end,
      scheduled_date: u.scheduled_date,
      scheduled_end: u.scheduled_end,
      duration_days: u.duration_days,
      ...(cycleForUpdates && !bound
        ? {
          attendance_cycle_id: cycleForUpdates.id,
          cycle_attribution: "bound",
        }
        : {}),
    };
  });
  const rpcCreates = plan.creates.map((c) => ({
    user_id: c.user_id,
    crew_name: c.crew_name,
    role: c.role,
    assignment_type: c.assignment_type,
    scheduled_date: c.scheduled_date,
    scheduled_end: c.scheduled_end,
    duration_days: c.duration_days,
    start_time: c.start_time,
    end_time: c.end_time,
    confirmation_status: c.confirmation_status,
    visible_to_trades: isMakesafe ? true : null,
    ...(cycleForCreates
      ? { attendance_cycle_id: cycleForCreates.id, cycle_attribution: "bound" }
      : {}),
  }));

  const { data: written, error: rpcErr } = await client.rpc(
    "reschedule_job_assignments_v1",
    {
      p_job_id: req.jobId,
      p_updates: rpcUpdates,
      p_deletes: plan.deletes.map((d) => ({
        id: d.id,
        expected_user_id: d.user_id,
        expected_scheduled_date: d.expected_scheduled_date,
        expected_scheduled_end: d.expected_scheduled_end,
      })),
      p_creates: rpcCreates,
      p_release_ghost_user_ids: watcherIds,
      p_released_invoice_statuses: [...deps.releasedInvoiceStatuses],
      p_operator: req.operator,
    },
  );
  if (rpcErr) throw jobBookingsRpcError(rpcErr);

  const updated: any[] = written?.updated || [];
  const created: any[] = written?.created || [];
  const deleted: any[] = written?.deleted || [];
  const bookings: any[] = written?.bookings || [];
  const followUpFailures: Array<{ step: string; error: string }> = [];
  const followUp = async (step: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
    } catch (e) {
      console.error(
        `[ops-api] reschedule_job_bookings follow-up ${step} failed:`,
        e,
      );
      followUpFailures.push({
        step,
        error: String((e as Error)?.message || e),
      });
    }
  };

  // Audit, as create_assignment / delete_assignment write it (job_events
  // rows are written inside the transaction).
  await followUp("business_events", () => {
    for (const row of created) {
      deps.logBusinessEvent({
        event_type: "schedule.assignment_created",
        entity_type: "crew_assignment",
        entity_id: row.id,
        job_id: job.job_number || req.jobId,
        correlation_id: req.jobId,
        payload: {
          entity: {
            id: row.id,
            name: `${row.crew_name || "Crew"} on ${row.scheduled_date}`,
          },
          changes: { status: { from: null, to: "scheduled" } },
          confirmation_status: row.confirmation_status,
          crew_name: row.crew_name || "",
          scheduled_date: row.scheduled_date,
          related_entities: [
            { type: "job", id: req.jobId },
            {
              type: "crew",
              id: row.user_id || null,
              name: row.crew_name || "",
            },
          ],
        },
        metadata: { operator: req.operator, via: "reschedule_job_bookings" },
      });
    }
    for (const row of deleted) {
      deps.logBusinessEvent({
        event_type: "schedule.assignment_deleted",
        entity_type: "crew_assignment",
        entity_id: row.id,
        job_id: req.jobId,
        payload: {
          crew_name: row.crew_name,
          scheduled_date: row.scheduled_date,
          was_locked: row.confirmation_status === "confirmed",
        },
        metadata: { operator: req.operator, via: "reschedule_job_bookings" },
      });
    }
  });

  if (created.length) {
    await followUp("job_status", async () => {
      if (job.status !== "accepted") return;
      const { error } = await client.from("jobs")
        .update({
          status: "processing",
          processing_at: new Date().toISOString(),
        })
        .eq("id", req.jobId).eq("status", "accepted");
      if (error) throw error;
    });
    await followUp("jarvis_event_log", async () => {
      const { error } = await client.from("jarvis_event_log").insert(
        created.map((row) => ({
          event_type: "crew_assigned",
          job_id: req.jobId,
          channel: "system",
          triggered_by: "reschedule_job_bookings",
          message_content: `Assigned ${
            row.crew_name || "crew"
          } to job on ${row.scheduled_date}`,
          metadata: {
            user_id: row.user_id || null,
            scheduled_date: row.scheduled_date,
          },
        })),
      );
      if (error) throw error;
    });
    await followUp(
      "job_intelligence",
      () => deps.recomputeJobIntelligence(req.jobId),
    );
  }

  // One GHL push for the job: its new first day.
  const firstDay = bookings
    .filter((r) => isLiveJobBookingRow(r))
    .map((r) => day(r.scheduled_date))
    .sort()[0];
  if (
    job.ghl_opportunity_id && firstDay && (updated.length || created.length)
  ) {
    await followUp(
      "ghl_push",
      () => deps.pushGhlScheduledDate(String(job.ghl_opportunity_id), firstDay),
    );
  }

  // Make-safe report binding, once per crew member written onto a bound cycle.
  const reconciled = new Set<string>();
  for (const row of [...updated, ...created]) {
    if (
      !row?.user_id || !row?.attendance_cycle_id ||
      row?.cycle_attribution !== "bound"
    ) continue;
    if (!deps.isGenuineTradeAssignment(row)) continue;
    const userId = String(row.user_id);
    if (reconciled.has(userId)) continue;
    reconciled.add(userId);
    await followUp(
      "makesafe_report_binding",
      () =>
        deps.reconcileReportBinding({
          jobId: req.jobId,
          userId,
          attendanceCycleId: String(row.attendance_cycle_id),
          preferredAssignmentId: String(row.id),
        }),
    );
  }

  // Ghost watchers: one sync per date a booking left or landed on. The sync
  // removes a watcher's ghost from a date nobody works any more and mirrors
  // one onto a date crew now work.
  const dates = new Set<string>();
  for (const u of plan.updates) {
    if (u.expected_scheduled_date !== u.scheduled_date) {
      dates.add(u.expected_scheduled_date);
      dates.add(u.scheduled_date);
    } else {
      dates.add(u.scheduled_date);
    }
  }
  for (const d of plan.deletes) dates.add(d.expected_scheduled_date);
  for (const c of plan.creates) dates.add(c.scheduled_date);
  const genuine = [
    ...plan.updates.map((u) => rowById.get(u.id)),
    ...plan.deletes.map((d) => rowById.get(d.id)),
  ]
    .some((row) => isGenuineCrewAssignmentRow(row)) ||
    plan.creates.length > 0;
  if (genuine) {
    for (const date of [...dates].sort()) {
      await followUp(
        "ghost_watchers",
        () => deps.syncGhostWatchers(req.jobId, date),
      );
    }
  }

  return {
    ok: true,
    changed: true,
    job_id: req.jobId,
    kind: plan.kind,
    ...(plan.edge ? { edge: plan.edge } : {}),
    from: plan.from,
    to: plan.to,
    updated,
    created,
    deleted: deleted.map((r) => r.id),
    bookings: bookings.map(toReadShape),
    follow_up_failures: followUpFailures,
  };
}
