// deno-lint-ignore-file no-explicit-any
// Scheduled -> In Progress on a booked work day (captain, 2 Nov 2026: "all.
// even repairs"; a quick fix until the Trade App's Start press moves a job).
//
// At 6am Perth (pg_cron job-auto-start, 22:00 UTC the day before) every job still at
// Scheduled that has a work booking on the calendar today, Perth time, moves to In
// Progress. Rules:
//   - A work booking is a live crew booking in job_assignments, the rows the Ops Dash
//     calendar paints: assignment_type install (or unset, which the calendar reads as
//     install), never a ghost watcher row (is_ghost, role/type observer or ghost),
//     never a meeting, reminder, follow-up or delivery, never a cancelled row.
//   - A booking is on today when today is one of its painted days (job_bookings.ts
//     paintedSpanDates: scheduled_date to scheduled_end, an interior weekend skipped).
//     Earlier bookings do not matter: a job rebooked after older bookings were left on
//     the calendar still moves on the day it is booked (SWF-261308, 2 Nov 2026).
//   - No catch-up: a job with bookings only before today, or only after, stays put.
//   - Fencing, patio and every other type that lives on jobs.status: Scheduled is
//     jobs.status 'scheduled', In Progress is 'in_progress'. The move is ops-api
//     updateJobStatus with expected_statuses ['scheduled'] (compare and set), so a job
//     someone moved meanwhile is untouched, and the hand move's side effects run: the
//     status_changed job event, the business event, the GHL stage push. Nothing texts
//     the client on a move to in_progress.
//   - Repairs (the Repairs board family, isInsuranceRepairFamily): the board's Scheduled
//     is repair stage 'scheduled' and its In Progress is 'on_site'. The move is
//     updateRepairStage with expected_stages ['scheduled']; when jobs.status is also
//     'scheduled' it moves to 'in_progress' the same way as above.
//   - Make-safe and restoration cards (the make-safe board) have no Scheduled or In
//     Progress stage: their column comes from evidence and the substatus, never
//     jobs.status. They are skipped (make_safe_board).
//   - Forward only: nothing is ever moved back.
//
// Switch: feature_flags.job_auto_start_v1 (seeded ON by 20261102140000). Missing or
// unreadable is off. Each live run writes one job_auto_start_runs row: the Perth day,
// how many moved and their job numbers, and what was skipped and why.

import { paintedSpanDates } from "./job_bookings.ts";
import {
  insuranceRepairStage,
  isInsuranceRepairFamily,
} from "./insurance_repairs_board.ts";

export const JOB_AUTO_START_FLAG = "job_auto_start_v1";
export const JOB_AUTO_START_SOURCE = "auto_schedule_start";
export const JOB_AUTO_START_ACTIONS = ["job_auto_start_sweep"] as const;

const SCHEDULED_STATUS = "scheduled";
const IN_PROGRESS_STATUS = "in_progress";
const REPAIR_SCHEDULED_STAGE = "scheduled";
const REPAIR_IN_PROGRESS_STAGE = "on_site";

/** Booking kinds that are real work on site; anything else (meeting, reminder,
 *  followup, delivery, a scope or quote visit) is not a work day. */
const WORK_BOOKING_TYPES = new Set(["install"]);
const WATCHER_MARKERS = new Set(["observer", "ghost"]);

const ID_CHUNK = 50;
const JOB_PAGE_SIZE = 500;
const JOB_PAGES_MAX = 10;

/** Today's date (YYYY-MM-DD) in Perth, whatever the server clock's zone. */
export function perthToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Perth",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function token(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/** A booking that is a crew work day on the calendar. */
export function isWorkBooking(row: any): boolean {
  if (!row || row.is_ghost === true) return false;
  if (token(row.status) === "cancelled") return false;
  const role = token(row.role);
  const type = token(row.assignment_type) || "install";
  if (WATCHER_MARKERS.has(role) || WATCHER_MARKERS.has(type)) return false;
  if (!WORK_BOOKING_TYPES.has(type)) return false;
  return /^\d{4}-\d{2}-\d{2}/.test(String(row.scheduled_date ?? ""));
}

/** True when one of the job's work bookings covers `today` (YYYY-MM-DD). */
export function hasWorkBookingOn(rows: any[], today: string): boolean {
  return rows.some((row) =>
    isWorkBooking(row) &&
    paintedSpanDates(
      String(row.scheduled_date).slice(0, 10),
      row.scheduled_end ? String(row.scheduled_end).slice(0, 10) : null,
    ).includes(today)
  );
}

/** The days the job's work bookings fall on, for the run record of a job not moved. */
function workDays(rows: any[]): string[] {
  const days = new Set<string>();
  for (const row of rows) {
    if (!isWorkBooking(row)) continue;
    for (
      const d of paintedSpanDates(
        String(row.scheduled_date).slice(0, 10),
        row.scheduled_end ? String(row.scheduled_end).slice(0, 10) : null,
      )
    ) days.add(d);
  }
  return [...days].sort();
}

/** Make-safe board cards: their column is not jobs.status (AGENTS.md, Release 12). */
function isMakeSafeBoardJob(job: any): boolean {
  const type = token(job?.type);
  if (type === "makesafe") return true;
  return type === "insurance" &&
    token(job?.metadata?.insurance_job_type) === "restoration";
}

export type AutoStartLane =
  | { lane: "status" }
  | { lane: "repair"; move_status: boolean }
  | { lane: "skip"; reason: string };

/** Which Scheduled -> In Progress move applies to this job, if any. */
export function autoStartLane(job: any, details: any = null): AutoStartLane {
  const status = token(job?.status);
  const authority = { ...job, makesafe_details: details };
  if (isInsuranceRepairFamily(authority)) {
    if (insuranceRepairStage(authority) !== REPAIR_SCHEDULED_STAGE) {
      return { lane: "skip", reason: "not_scheduled" };
    }
    return { lane: "repair", move_status: status === SCHEDULED_STATUS };
  }
  if (isMakeSafeBoardJob(job)) {
    return { lane: "skip", reason: "make_safe_board" };
  }
  if (status !== SCHEDULED_STATUS) {
    return { lane: "skip", reason: "not_scheduled" };
  }
  return { lane: "status" };
}

export interface AutoStartCandidate {
  job: any;
  details: any | null;
  bookings: any[];
}

export interface AutoStartDeps {
  now: () => Date;
  readFlag: () => Promise<boolean | null>;
  loadCandidates: () => Promise<AutoStartCandidate[] | null>;
  /** ops-api updateJobStatus (with expected_statuses for compare and set). */
  moveJobStatus: (body: Record<string, unknown>) => Promise<any>;
  /** ops-api updateRepairStage (with expected_stages for compare and set). */
  moveRepairStage: (body: Record<string, unknown>) => Promise<any>;
  recordRun: (row: Record<string, unknown>) => Promise<void>;
}

type Result = {
  job_id: string;
  job_number: string | null;
  action: string;
  detail?: unknown;
};

export async function jobAutoStartSweep(
  deps: AutoStartDeps,
  body: Record<string, unknown> = {},
) {
  const dryRun = body.dry_run !== false;
  const today = perthToday(deps.now());
  const flag = await deps.readFlag();
  if (flag !== true && !dryRun) {
    return {
      ok: true,
      ran: false,
      reason: flag === null ? "switch_unreadable" : "switched_off",
      today,
    };
  }
  const candidates = await deps.loadCandidates();
  if (!candidates) {
    if (!dryRun) {
      await deps.recordRun({
        run_on: today,
        outcome: "failed",
        moved_count: 0,
        moved_job_numbers: [],
        detail: { reason: "candidates_unreadable" },
      });
    }
    return { ok: false, ran: false, reason: "candidates_unreadable", today };
  }

  const results: Result[] = [];
  for (const { job, details, bookings } of candidates) {
    const base = { job_id: String(job.id), job_number: job.job_number ?? null };
    const lane = autoStartLane(job, details);
    if (lane.lane === "skip") {
      results.push({ ...base, action: "skipped", detail: lane.reason });
      continue;
    }
    if (!hasWorkBookingOn(bookings, today)) {
      const days = workDays(bookings);
      results.push({
        ...base,
        action: days.length === 0
          ? "no_work_booking"
          : days[days.length - 1] < today
          ? "booked_earlier_only"
          : days[0] > today
          ? "starts_later"
          : "not_booked_today",
        detail: days.length
          ? { first: days[0], last: days[days.length - 1] }
          : null,
      });
      continue;
    }
    if (dryRun) {
      results.push({ ...base, action: "would_move", detail: lane.lane });
      continue;
    }
    try {
      results.push({ ...base, ...(await moveOne(deps, job, lane)) });
    } catch (e) {
      results.push({
        ...base,
        action: "failed",
        detail: (e as Error)?.message ?? String(e),
      });
    }
  }

  const moved = results.filter((r) => r.action === "moved");
  const summary = {
    ok: true,
    ran: true,
    dry_run: dryRun,
    today,
    checked: candidates.length,
    moved_count: moved.length,
    moved_job_numbers: moved.map((r) => r.job_number ?? r.job_id),
    results,
  };
  if (!dryRun) {
    await deps.recordRun({
      run_on: today,
      outcome: results.some((r) => r.action === "failed") ? "partial" : "ok",
      moved_count: moved.length,
      moved_job_numbers: summary.moved_job_numbers,
      detail: {
        checked: candidates.length,
        not_moved: results.filter((r) => r.action !== "moved"),
      },
    });
  }
  return summary;
}

async function moveOne(
  deps: AutoStartDeps,
  job: any,
  lane: Exclude<AutoStartLane, { lane: "skip" }>,
): Promise<{ action: string; detail?: unknown }> {
  if (lane.lane === "repair") {
    const staged = await deps.moveRepairStage({
      job_id: job.id,
      stage: REPAIR_IN_PROGRESS_STAGE,
      expected_stages: [REPAIR_SCHEDULED_STAGE],
      source: JOB_AUTO_START_SOURCE,
    });
    if (staged?.success !== true) {
      return { action: "stage_changed", detail: staged?.skipped ?? null };
    }
    if (!lane.move_status) return { action: "moved", detail: "repair_stage" };
  }
  const moved = await deps.moveJobStatus({
    jobId: job.id,
    status: IN_PROGRESS_STATUS,
    source: JOB_AUTO_START_SOURCE,
    expected_statuses: [SCHEDULED_STATUS],
  });
  if (moved?.success === false) {
    // A repair whose stage already moved has moved on its board.
    return lane.lane === "repair"
      ? { action: "moved", detail: "repair_stage" }
      : { action: "status_changed", detail: moved?.status_seen ?? null };
  }
  return {
    action: "moved",
    detail: lane.lane === "repair" ? "repair_stage_and_status" : "status",
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** The switch: true or false from the row, null when it cannot be read. */
export async function readJobAutoStartFlag(
  client: any,
): Promise<boolean | null> {
  const { data, error } = await client.from("feature_flags")
    .select("enabled")
    .eq("flag_name", JOB_AUTO_START_FLAG)
    .maybeSingle();
  if (error) return null;
  return data?.enabled === true;
}

/**
 * Jobs that may be at Scheduled: jobs.status scheduled, and repairs whose board stage
 * may read scheduled (a repair_stage stamp, or a status the Repairs board maps there),
 * with their make-safe details row and every booking. Null when a read fails.
 */
export async function loadJobAutoStartCandidates(
  client: any,
): Promise<AutoStartCandidate[] | null> {
  const jobs: any[] = [];
  for (let page = 0; page < JOB_PAGES_MAX; page++) {
    const { data, error } = await client.from("jobs")
      .select("id, job_number, type, status, metadata")
      .or(
        "status.in.(scheduled,schedule_install),metadata->>repair_stage.eq.scheduled",
      )
      .order("id")
      .range(page * JOB_PAGE_SIZE, (page + 1) * JOB_PAGE_SIZE - 1);
    if (error) {
      console.error("[job_auto_start] jobs read failed:", error.message);
      return null;
    }
    jobs.push(...(data ?? []));
    if (!data || data.length < JOB_PAGE_SIZE) break;
  }
  const ids = jobs.map((j) => String(j.id));
  const details = new Map<string, any>();
  const bookings = new Map<string, any[]>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const [detailRead, bookingRead] = await Promise.all([
      client.from("makesafe_job_details").select("job_id, report_type").in(
        "job_id",
        chunk,
      ),
      client.from("job_assignments")
        .select(
          "job_id, role, status, assignment_type, is_ghost, scheduled_date, scheduled_end",
        )
        .in("job_id", chunk),
    ]);
    if (detailRead.error || bookingRead.error) {
      console.error(
        "[job_auto_start] details or bookings read failed:",
        (detailRead.error ?? bookingRead.error).message,
      );
      return null;
    }
    for (const d of detailRead.data ?? []) details.set(String(d.job_id), d);
    for (const b of bookingRead.data ?? []) {
      const key = String(b.job_id);
      if (!bookings.has(key)) bookings.set(key, []);
      bookings.get(key)!.push(b);
    }
  }
  return jobs.map((job) => ({
    job,
    details: details.get(String(job.id)) ?? null,
    bookings: bookings.get(String(job.id)) ?? [],
  }));
}

export async function recordJobAutoStartRun(
  client: any,
  row: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.from("job_auto_start_runs").insert(row);
  if (error) {
    console.error("[job_auto_start] run record failed:", error.message);
  }
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/** Server key only, POST only. */
export async function runJobAutoStartAction(
  method: string,
  body: Record<string, unknown>,
  isServer: boolean,
  deps: AutoStartDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!isServer) {
    return { status: 403, body: { ok: false, code: "server_key_required" } };
  }
  if (method !== "POST") {
    return { status: 405, body: { ok: false, code: "method_not_allowed" } };
  }
  return { status: 200, body: await jobAutoStartSweep(deps, body) };
}
