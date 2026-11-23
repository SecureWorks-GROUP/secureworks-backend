// deno-lint-ignore-file no-explicit-any
// The ops-api Supabase client is intentionally untyped at this boundary,
// matching the sibling store modules.
//
// A trade books the first visit on a new restoration job (owner, 20 Nov 2026):
// "it shouldn't be booked for the day it comes in. it should await for him to
// organise a booking date with the client and then he can book it in on the
// app."
//
// Restoration intake puts the crew on the job with no date
// (restoration_intake_inspection.ts). One trade action,
// `book_restoration_visit` { job_id, date, start_time? }, dates those rows:
//   - the caller must be on the job (a live, real crew row of their own);
//   - the job must be a restoration card in the caller's company;
//   - the day is today or later (Perth), at most 120 days ahead;
//   - it dates the caller's own undated row and every other undated row the
//     intake put on the job (so Marnin's booking moves with Jean's), through
//     updateAssignment, so the ghost watcher mirror and the job events run as
//     for any reschedule;
//   - once a row has a date this action no longer moves it: a change of date
//     is the office's, on the calendar.
// It texts nobody and changes no job status.

import { perthToday } from "./trade_invoice_time_entry.ts";
import { isRestorationCard } from "./restoration_workflow_store.ts";
import { RESTORATION_INTAKE_ASSIGNMENT_NOTE } from "./restoration_intake_inspection.ts";

export const RESTORATION_VISIT_MAX_DAYS_AHEAD = 120;
export const RESTORATION_VISIT_DEFAULT_HOURS = 2;
export const RESTORATION_VISIT_EVENT = "restoration_visit_booked";

export class RestorationVisitRefusal extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function addDays(day: string, n: number): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Pure. "07:30" -> "09:30" (the visit's default two hours); null when unreadable. */
export function restorationVisitEndTime(start: string, hours = RESTORATION_VISIT_DEFAULT_HOURS): string | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(start);
  if (!m) return null;
  const total = Number(m[1]) * 60 + Number(m[2]) + hours * 60;
  if (total >= 24 * 60) return "23:59";
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Pure. A live, real crew row (not cancelled, not a ghost watcher). */
export function isLiveCrewRow(row: any): boolean {
  if (!row) return false;
  if (text(row.status).toLowerCase() === "cancelled") return false;
  if (row.is_ghost === true) return false;
  if (text(row.role).toLowerCase() === "observer") return false;
  return Boolean(text(row.user_id));
}

/** Pure. Which rows a booking dates: the caller's undated row and the intake's undated rows. */
export function restorationVisitRowsToDate(rows: any[], callerId: string): any[] {
  return (rows || []).filter((row) =>
    isLiveCrewRow(row) && !row.scheduled_date &&
    (text(row.user_id) === callerId || text(row.notes) === RESTORATION_INTAKE_ASSIGNMENT_NOTE)
  );
}

export interface RestorationVisitDeps {
  updateAssignment: (body: Record<string, unknown>) => Promise<any>;
  today?: string;
}

/** WRITE. Book the first visit on a restoration job for the signed-in trade. */
export async function bookRestorationVisit(
  client: any,
  input: { body: any; trade: { id: string; orgId: string | null; name: string | null } },
  deps: RestorationVisitDeps,
): Promise<Record<string, unknown>> {
  const body = input.body || {};
  const jobId = text(body.job_id || body.jobId);
  if (!UUID_RE.test(jobId)) throw new RestorationVisitRefusal("job_id_invalid", "job_id must be a job id.", 400);
  const day = text(body.date || body.scheduled_date);
  if (!isIsoDay(day)) throw new RestorationVisitRefusal("date_invalid", "Give the visit date as YYYY-MM-DD.", 400);
  const today = deps.today || perthToday();
  if (day < today) throw new RestorationVisitRefusal("date_in_past", "The visit date cannot be before today.", 400);
  if (day > addDays(today, RESTORATION_VISIT_MAX_DAYS_AHEAD)) {
    throw new RestorationVisitRefusal(
      "date_too_far",
      `The visit date must be within ${RESTORATION_VISIT_MAX_DAYS_AHEAD} days.`,
      400,
    );
  }
  const start = text(body.start_time || body.startTime);
  let end: string | null = null;
  if (start) {
    end = restorationVisitEndTime(start);
    if (!end) throw new RestorationVisitRefusal("start_time_invalid", "Give the start time as HH:MM.", 400);
  }

  const { data: job, error: jobError } = await client.from("jobs")
    .select("id, org_id, job_number, type, metadata").eq("id", jobId).maybeSingle();
  if (jobError) throw new RestorationVisitRefusal("job_unreadable", "The job could not be read.", 503);
  if (!job || (input.trade.orgId && job.org_id && job.org_id !== input.trade.orgId)) {
    throw new RestorationVisitRefusal("job_not_found", "No job matched.", 404);
  }
  if (!isRestorationCard(job)) {
    throw new RestorationVisitRefusal(
      "not_a_restoration_job",
      `${job.job_number || "This job"} is not a restoration job. Ask the office to book it.`,
    );
  }

  const { data: rows, error: rowsError } = await client.from("job_assignments")
    .select("id, job_id, user_id, status, role, is_ghost, scheduled_date, notes")
    .eq("job_id", jobId);
  if (rowsError) throw new RestorationVisitRefusal("bookings_unreadable", "The job's bookings could not be read.", 503);
  const live = (rows || []).filter(isLiveCrewRow);
  const mine = live.filter((row: any) => text(row.user_id) === input.trade.id);
  if (!mine.length) {
    throw new RestorationVisitRefusal("not_on_job", "You are not on this job. Ask the office to add you.", 403);
  }
  const toDate = restorationVisitRowsToDate(live, input.trade.id);
  if (!toDate.length) {
    const booked = mine.find((row: any) => row.scheduled_date);
    throw new RestorationVisitRefusal(
      "already_booked",
      booked
        ? `This visit is already booked for ${booked.scheduled_date}. To change it, ask the office.`
        : "There is no visit waiting for a date on this job.",
    );
  }

  const updated: any[] = [];
  for (const row of toDate) {
    const result = await deps.updateAssignment({
      assignmentId: row.id,
      scheduledDate: day,
      ...(start ? { startTime: start, endTime: end } : {}),
      confirmation_status: "confirmed",
    });
    updated.push({ id: row.id, user_id: row.user_id, scheduled_date: result?.assignment?.scheduled_date ?? day });
  }

  const { error: eventError } = await client.from("job_events").insert({
    job_id: jobId,
    user_id: input.trade.id,
    event_type: RESTORATION_VISIT_EVENT,
    detail_json: {
      date: day,
      start_time: start || null,
      booked_by: input.trade.id,
      booked_by_name: input.trade.name,
      assignment_ids: updated.map((r) => r.id),
    },
  });
  if (eventError) console.error("[ops-api] book_restoration_visit: event not saved:", eventError.message);

  return {
    ok: true,
    job_number: job.job_number || null,
    date: day,
    start_time: start || null,
    end_time: end,
    bookings: updated,
  };
}
