// A trade adds themselves to a job so they can invoice it (Marnin, 11 Nov 2026):
// "If they are allocated to a job then they can invoice for that job. So in the
// trade app invoicing side if they try invoice for a job they aren't allocated
// to they can self allocate there. And then invoice."
//
// One trade action, `self_allocate_for_invoice` { job_id, work_date }. It only
// ever books the CALLER, on ONE day, on a job in the caller's company. It never
// moves or reassigns anyone else and never texts anyone. The row it writes is an
// ordinary job_assignments crew row (through createAssignment, so the make-safe
// cycle binding and the ghost watcher mirror run as for any other allocation),
// marked accepted, with a note saying the trade added themselves from their
// invoice, plus a `trade_self_allocated` job event so the office sees it.
//
// Being booked on a job is what lets a trade bill it (the invoice's extra-line
// rule `booked_on_job`, and the job card lane), so after this the normal
// invoice path works with no other change. The office still reviews every
// invoice as before.
//
// The rules are the owner's to change: edit them here, with a test.
//
// Marnin, 13 Nov 2026, behind `trade_self_booking_v1` (seeded off): a trade may
// also book themselves AHEAD, for today or a future day, from the job page
// (`self_book_job`), and take their own booking off again (`self_unbook_job`).
// Those two doors are at the bottom of this file. `self_allocate_for_invoice`
// above them is unchanged: it stays the door for a day already worked.
// Contract: docs/trade-open-access-v1.md.
// deno-lint-ignore-file no-explicit-any

import { perthToday } from "./trade_invoice_time_entry.ts";

// A job in one of these states is not work a trade can have done: a lead, a
// draft or quote not yet accepted, or a job that was lost, cancelled or never
// real. A finished, invoiced or archived job is allowed on purpose: trades
// often invoice the week after the job is closed.
export const SELF_ALLOCATE_REFUSED_JOB_STATUSES: ReadonlySet<string> = new Set([
  "lead",
  "new",
  "draft",
  "quoted",
  "lost",
  "cancelled",
  "deleted",
  "duplicate",
  "duplicated",
  "void",
  "voided",
]);

// How far back a trade may add themselves. Matches the invoice time entry
// rule: a date more than a year ago is a mistyped year, not a late claim.
export const SELF_ALLOCATE_MAX_DAYS_BACK = 366;

export class SelfAllocationRefusal extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function isIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(toIso + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z")) / 86400000,
  );
}

/** Refuses a day that is not a real date, after today, or over a year ago. */
export function selfAllocationDateRefusal(
  workDate: string,
  today: string,
): SelfAllocationRefusal | null {
  if (!isIsoDay(workDate)) {
    return new SelfAllocationRefusal(
      "self_allocate_date_invalid",
      "Pick the day you worked on this job.",
      400,
    );
  }
  if (workDate > today) {
    return new SelfAllocationRefusal(
      "self_allocate_future_date",
      "You can only add yourself for a day you have already worked (today or earlier).",
      400,
    );
  }
  if (daysBetween(workDate, today) > SELF_ALLOCATE_MAX_DAYS_BACK) {
    return new SelfAllocationRefusal(
      "self_allocate_date_too_old",
      "That day is more than a year ago. Check the date.",
      400,
    );
  }
  return null;
}

/** Refuses a job a trade cannot have worked on. */
export function selfAllocationJobRefusal(job: any): SelfAllocationRefusal | null {
  const status = String(job?.status || "").trim().toLowerCase();
  const ref = String(job?.job_number || "this job");
  if (SELF_ALLOCATE_REFUSED_JOB_STATUSES.has(status)) {
    return new SelfAllocationRefusal(
      "self_allocate_job_not_open",
      `${ref} is ${status ? "a " + status + " job" : "not a live job"}, so you cannot add yourself to it. Ask the office.`,
    );
  }
  // A holding job (today only SWF-PDF-BUCKET) is never a customer's job.
  const holding = String(job?.metadata?.do_not_schedule ?? "").trim().toLowerCase();
  if (holding === "true") {
    return new SelfAllocationRefusal(
      "self_allocate_job_not_open",
      `${ref} is not a customer job, so you cannot add yourself to it. Ask the office.`,
    );
  }
  return null;
}

/** The job, only when it is in the caller's company. Null when it is not. */
async function readOwnCompanyJob(client: any, jobId: string, orgId: string): Promise<any | null> {
  const { data: job, error: jobErr } = await client.from("jobs")
    .select("id, job_number, status, type, metadata")
    .eq("id", jobId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (jobErr) throw new Error("Could not read the job: " + (jobErr.message || jobErr));
  return job || null;
}

/**
 * The trade put themselves on the job, so the row is accepted, not waiting on
 * "I'm on it" (best effort: a scheduled row can be invoiced as well), and a
 * `trade_self_allocated` job event says who did it and why.
 */
async function acceptAndLogSelfAllocation(
  client: any,
  input: {
    created: any;
    jobId: string;
    trade: { id: string; name?: string | null };
    workDate: string;
    reason: "invoice" | "planned";
    label: string;
    nowIso: string;
    mode?: string;
  },
): Promise<any> {
  let assignment = input.created;
  try {
    const { data: accepted, error: accErr } = await client.from("job_assignments")
      .update({ status: "confirmed", acknowledged_at: input.nowIso })
      .eq("id", input.created.id)
      .eq("user_id", input.trade.id)
      .eq("status", "scheduled")
      .select()
      .maybeSingle();
    if (accErr) {
      console.error(`[ops-api] ${input.label}: accept not saved:`, accErr.message);
    } else if (accepted) {
      assignment = accepted;
    }
  } catch (e) {
    console.error(`[ops-api] ${input.label}: accept threw:`, (e as Error)?.message);
  }

  const { error: evErr } = await client.from("job_events").insert({
    job_id: input.jobId,
    user_id: input.trade.id,
    event_type: "trade_self_allocated",
    detail_json: {
      assignment_id: assignment.id,
      work_date: input.workDate,
      reason: input.reason,
      trade_name: input.trade.name || null,
      ...(input.mode ? { mode: input.mode } : {}),
    },
  });
  if (evErr) console.error(`[ops-api] ${input.label}: event not saved:`, evErr.message);
  return assignment;
}

export type SelfAllocationDeps = {
  /** Existing live (not cancelled, not ghost) row for this job/user/day, or null. */
  findExisting: (jobId: string, userId: string, day: string) => Promise<any | null>;
  /** createAssignment, already bound to the client. */
  createAssignment: (body: any) => Promise<{ assignment: any; deduped?: boolean }>;
  isUserDateConflict: (error: any) => boolean;
  today?: string;
};

/**
 * Books the caller on the job for one day. Idempotent: an existing live row
 * for that job, caller and day is returned as is (mode `existing`).
 */
export async function selfAllocateForInvoice(
  client: any,
  input: {
    body: any;
    trade: { id: string; orgId: string; name?: string | null };
  },
  deps: SelfAllocationDeps,
): Promise<{ ok: true; mode: "created" | "existing"; assignment: any }> {
  const jobId = String(input.body?.job_id || input.body?.jobId || "").trim();
  if (!jobId) {
    throw new SelfAllocationRefusal("self_allocate_job_required", "Pick the job first.", 400);
  }
  const workDate = String(input.body?.work_date || input.body?.scheduled_date || "").trim();
  const today = deps.today || perthToday();
  const dateRefusal = selfAllocationDateRefusal(workDate, today);
  if (dateRefusal) throw dateRefusal;

  const job = await readOwnCompanyJob(client, jobId, input.trade.orgId);
  if (!job) {
    throw new SelfAllocationRefusal(
      "self_allocate_job_not_found",
      "We could not find that job in your company.",
      404,
    );
  }
  const jobRefusal = selfAllocationJobRefusal(job);
  if (jobRefusal) throw jobRefusal;

  const existing = await deps.findExisting(jobId, input.trade.id, workDate);
  if (existing) return { ok: true, mode: "existing", assignment: existing };

  const nowIso = new Date().toISOString();
  let created: any;
  try {
    const res = await deps.createAssignment({
      jobId,
      userId: input.trade.id,
      scheduledDate: workDate,
      confirmation_status: "confirmed",
      suppress_notifications: true,
      allocated_by_user_id: input.trade.id,
      notes: "Added themselves from their invoice",
    });
    created = res?.assignment;
  } catch (error) {
    if (!deps.isUserDateConflict(error)) throw error;
    const raced = await deps.findExisting(jobId, input.trade.id, workDate);
    if (raced) return { ok: true, mode: "existing", assignment: raced };
    throw new SelfAllocationRefusal(
      "self_allocate_conflict",
      "There is already a record for you on this job that day. Ask the office to check it.",
    );
  }
  if (!created?.id) throw new Error("Could not add you to the job");

  const assignment = await acceptAndLogSelfAllocation(client, {
    created,
    jobId,
    trade: input.trade,
    workDate,
    reason: "invoice",
    label: "self_allocate_for_invoice",
    nowIso,
  });

  return { ok: true, mode: "created", assignment };
}

// ── Booking ahead: self_book_job / self_unbook_job (13 Nov 2026) ─────────────

export const SELF_BOOK_MAX_DATES = 14;
export const SELF_BOOK_MAX_DAYS_AHEAD = 60;
export const SELF_BOOK_NOTE = "Added themselves in the app";

// After the work: the job is being paid or reviewed, not scheduled. Read with
// the terminal set allocate_job refuses (handed in by ops-api as
// `notSchedulableStatuses`, so the two doors agree on a finished job).
export const SELF_BOOK_POST_WORK_JOB_STATUSES: ReadonlySet<string> = new Set([
  "final_payment",
  "get_review",
]);

export class SelfBookingRefusal extends SelfAllocationRefusal {
  /** Days already booked by this call before it was refused. */
  bookings: SelfBooking[];
  constructor(code: string, message: string, status = 409, bookings: SelfBooking[] = []) {
    super(code, message, status);
    this.bookings = bookings;
  }
}

export type SelfBooking = {
  work_date: string;
  mode: "created" | "existing" | "revived";
  assignment: any;
};

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
}

function selfBookingDisabled(): SelfBookingRefusal {
  return new SelfBookingRefusal(
    "self_booking_disabled",
    "Booking yourself on a job is not switched on yet. Ask the office to add you.",
  );
}

/**
 * The days asked for: `dates` (a list) or one `work_date`. One to fourteen
 * different real days, each from today (Perth) to sixty days ahead. Returned
 * in date order, each once.
 */
export function selfBookingDates(body: any, today: string): string[] {
  const raw: unknown[] = Array.isArray(body?.dates)
    ? body.dates
    : body?.work_date || body?.scheduled_date
    ? [body.work_date || body.scheduled_date]
    : [];
  const days = [...new Set(raw.map((d) => String(d ?? "").trim()))];
  if (days.length === 0 || days.every((d) => !d)) {
    throw new SelfBookingRefusal("self_book_dates_required", "Pick the day or days you will be on this job.", 400);
  }
  if (days.length > SELF_BOOK_MAX_DATES) {
    throw new SelfBookingRefusal(
      "self_book_too_many_dates",
      `You can book up to ${SELF_BOOK_MAX_DATES} days at a time.`,
      400,
    );
  }
  const last = addDays(today, SELF_BOOK_MAX_DAYS_AHEAD);
  for (const day of days) {
    if (!isIsoDay(day)) {
      throw new SelfBookingRefusal("self_book_date_invalid", "One of those days is not a real date.", 400);
    }
    if (day < today) {
      throw new SelfBookingRefusal(
        "self_book_past_date",
        "You can only book yourself for today or a day ahead. For a day you already worked, add the job to your invoice.",
        400,
      );
    }
    if (day > last) {
      throw new SelfBookingRefusal(
        "self_book_date_too_far",
        `You can book yourself up to ${SELF_BOOK_MAX_DAYS_AHEAD} days ahead.`,
        400,
      );
    }
  }
  return days.sort();
}

/**
 * Refuses a job a trade cannot book ahead on: everything the invoice door
 * refuses, and also a job that is finished or closed.
 */
export function selfBookingJobRefusal(
  job: any,
  notSchedulableStatuses: readonly string[] = [],
): SelfBookingRefusal | null {
  const base = selfAllocationJobRefusal(job);
  if (base) return new SelfBookingRefusal("self_book_job_not_open", base.message);
  const status = String(job?.status || "").trim().toLowerCase();
  if (notSchedulableStatuses.includes(status) || SELF_BOOK_POST_WORK_JOB_STATUSES.has(status)) {
    const ref = String(job?.job_number || "this job");
    return new SelfBookingRefusal(
      "self_book_job_not_open",
      `${ref} is ${status.replace(/_/g, " ")}, so you cannot book yourself on it. Ask the office.`,
    );
  }
  return null;
}

type OwnDayPlan =
  | { day: string; action: "existing"; row: any }
  | { day: string; action: "create" }
  | { day: string; action: "revive"; row: any };

/**
 * What to do with one day, from the caller's own row on that job and day (the
 * unique key allows one, whatever its status). A cancelled row that was worked
 * or invoiced is never reused: that day is refused.
 */
export function selfBookingDayPlan(day: string, row: any | null): OwnDayPlan | "conflict" {
  // A watcher's ghost on the key is not a booking; createAssignment clears it.
  if (!row || row.is_ghost === true) return { day, action: "create" };
  if (String(row.status || "").toLowerCase() !== "cancelled") return { day, action: "existing", row };
  const used = !!row.invoiced_in || !!row.started_at || !!row.completed_at || !!row.clocked_on_at ||
    (row.hours_worked != null && Number(row.hours_worked) > 0);
  return used ? "conflict" : { day, action: "revive", row };
}

export type SelfBookingDeps = {
  /** trade_self_booking_v1. Missing or unreadable is off. */
  bookingEnabled: () => Promise<boolean>;
  /** Every row of the caller on this job for these days, any status, ghosts too. */
  findOwnRows: (jobId: string, userId: string, days: string[]) => Promise<any[]>;
  /** createAssignment, already bound to the client. */
  createAssignment: (body: any) => Promise<{ assignment: any; deduped?: boolean }>;
  isUserDateConflict: (error: any) => boolean;
  /** The job statuses allocate_job refuses. */
  notSchedulableStatuses?: readonly string[];
  today?: string;
};

/**
 * Books the caller on the job for each day asked. Every day is checked before
 * the first write. A day the caller already holds is returned as `existing`; a
 * cancelled, unused row of theirs is brought back (`revived`) instead of
 * tripping the one-row-per-job-user-day key.
 */
export async function selfBookJob(
  client: any,
  input: { body: any; trade: { id: string; orgId: string; name?: string | null } },
  deps: SelfBookingDeps,
): Promise<{ ok: true; bookings: SelfBooking[] }> {
  if (!(await deps.bookingEnabled())) throw selfBookingDisabled();
  const jobId = String(input.body?.job_id || input.body?.jobId || "").trim();
  if (!jobId) throw new SelfBookingRefusal("self_book_job_required", "Pick the job first.", 400);
  const today = deps.today || perthToday();
  const days = selfBookingDates(input.body, today);

  const job = await readOwnCompanyJob(client, jobId, input.trade.orgId);
  if (!job) {
    throw new SelfBookingRefusal("self_book_job_not_found", "We could not find that job in your company.", 404);
  }
  const jobRefusal = selfBookingJobRefusal(job, deps.notSchedulableStatuses || []);
  if (jobRefusal) throw jobRefusal;

  const conflict = (day: string, bookings: SelfBooking[] = []) =>
    new SelfBookingRefusal(
      "self_book_conflict",
      `There is already a record for you on this job on ${day}. Ask the office to check it.`,
      409,
      bookings,
    );

  const rowForDay = (rows: any[], day: string) =>
    (rows || []).find((row: any) => String(row?.scheduled_date || "").slice(0, 10) === day) || null;
  const ownRows = await deps.findOwnRows(jobId, input.trade.id, days);
  const plans: OwnDayPlan[] = [];
  for (const day of days) {
    const plan = selfBookingDayPlan(day, rowForDay(ownRows, day));
    if (plan === "conflict") throw conflict(day);
    plans.push(plan);
  }

  const bookings: SelfBooking[] = [];
  for (const plan of plans) {
    if (plan.action === "existing") {
      bookings.push({ work_date: plan.day, mode: "existing", assignment: plan.row });
      continue;
    }
    const mode = plan.action === "revive" ? "revived" : "created";
    let created: any;
    try {
      const res = await deps.createAssignment({
        jobId,
        userId: input.trade.id,
        scheduledDate: plan.day,
        confirmation_status: "confirmed",
        suppress_notifications: true,
        allocated_by_user_id: input.trade.id,
        notes: SELF_BOOK_NOTE,
        ...(plan.action === "revive" ? { revive_cancelled_assignment_id: plan.row.id } : {}),
      });
      created = res?.assignment;
    } catch (error) {
      if (!deps.isUserDateConflict(error)) throw error;
      const raced = selfBookingDayPlan(plan.day, rowForDay(await deps.findOwnRows(jobId, input.trade.id, [plan.day]), plan.day));
      if (raced !== "conflict" && raced.action === "existing") {
        bookings.push({ work_date: plan.day, mode: "existing", assignment: raced.row });
        continue;
      }
      throw conflict(plan.day, bookings);
    }
    if (!created?.id) throw new Error("Could not add you to the job");
    const assignment = await acceptAndLogSelfAllocation(client, {
      created,
      jobId,
      trade: input.trade,
      workDate: plan.day,
      reason: "planned",
      label: "self_book_job",
      nowIso: new Date().toISOString(),
      mode,
    });
    bookings.push({ work_date: plan.day, mode, assignment });
  }
  return { ok: true, bookings };
}

export type SelfUnbookingDeps = {
  bookingEnabled: () => Promise<boolean>;
  /** deleteAssignment, already bound to the client: the office's own removal. */
  deleteAssignment: (body: any) => Promise<unknown>;
  today?: string;
};

const SELF_UNBOOK_OPEN_STATUSES: ReadonlySet<string> = new Set(["scheduled", "confirmed"]);

/**
 * The caller takes their OWN booking off, only when they made it themselves
 * (a `trade_self_allocated` job event names the row), it has not been started
 * or invoiced, and it is for today or later. Goes through the office's own
 * removal, so the watcher rows follow.
 */
export async function selfUnbookJob(
  client: any,
  input: { body: any; trade: { id: string; orgId: string; name?: string | null } },
  deps: SelfUnbookingDeps,
): Promise<{ ok: true; assignment_id: string; job_id: string; work_date: string | null }> {
  if (!(await deps.bookingEnabled())) throw selfBookingDisabled();
  const assignmentId = String(input.body?.assignment_id || input.body?.assignmentId || "").trim();
  if (!assignmentId) {
    throw new SelfBookingRefusal("self_unbook_assignment_required", "Pick the booking to remove.", 400);
  }
  const notFound = () =>
    new SelfBookingRefusal("self_unbook_not_found", "We could not find that booking of yours.", 404);

  const { data: row, error: rowErr } = await client.from("job_assignments")
    .select("id, job_id, user_id, scheduled_date, status, is_ghost, invoiced_in, started_at, clocked_on_at")
    .eq("id", assignmentId)
    .maybeSingle();
  if (rowErr) throw new Error("Could not read the booking: " + (rowErr.message || rowErr));
  if (!row || String(row.user_id || "") !== input.trade.id || row.is_ghost === true) throw notFound();

  const { data: events, error: evReadErr } = await client.from("job_events")
    .select("id, detail_json")
    .eq("job_id", row.job_id)
    .eq("user_id", input.trade.id)
    .eq("event_type", "trade_self_allocated");
  if (evReadErr) throw new Error("Could not read who made the booking: " + (evReadErr.message || evReadErr));
  const selfMade = (events || []).some((ev: any) =>
    String(ev?.detail_json?.assignment_id || "") === String(row.id)
  );
  if (!selfMade) {
    throw new SelfBookingRefusal(
      "self_unbook_not_self_made",
      "The office put you on this job. Ask the office to take you off it.",
      403,
    );
  }
  const status = String(row.status || "").toLowerCase();
  if (row.clocked_on_at || row.started_at || !SELF_UNBOOK_OPEN_STATUSES.has(status)) {
    throw new SelfBookingRefusal(
      "self_unbook_started",
      "You have already started this booking, so you cannot remove it. Ask the office.",
    );
  }
  if (row.invoiced_in) {
    throw new SelfBookingRefusal(
      "self_unbook_invoiced",
      "This booking is on an invoice, so you cannot remove it. Ask the office.",
    );
  }
  const workDate = row.scheduled_date ? String(row.scheduled_date).slice(0, 10) : null;
  const today = deps.today || perthToday();
  if (!workDate || workDate < today) {
    throw new SelfBookingRefusal(
      "self_unbook_past",
      "That day has passed, so you cannot remove the booking. Ask the office.",
    );
  }

  await deps.deleteAssignment({ assignmentId: row.id });

  const { error: evErr } = await client.from("job_events").insert({
    job_id: row.job_id,
    user_id: input.trade.id,
    event_type: "trade_self_unbooked",
    detail_json: {
      assignment_id: row.id,
      work_date: workDate,
      trade_name: input.trade.name || null,
    },
  });
  if (evErr) console.error("[ops-api] self_unbook_job: event not saved:", evErr.message);

  return { ok: true, assignment_id: String(row.id), job_id: String(row.job_id), work_date: workDate };
}
