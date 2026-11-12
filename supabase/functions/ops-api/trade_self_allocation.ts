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

  const { data: job, error: jobErr } = await client.from("jobs")
    .select("id, job_number, status, type, metadata")
    .eq("id", jobId)
    .eq("org_id", input.trade.orgId)
    .maybeSingle();
  if (jobErr) throw new Error("Could not read the job: " + (jobErr.message || jobErr));
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

  // The trade said they did the work, so the row is accepted, not waiting on
  // "I'm on it". Best effort: a scheduled row can be invoiced as well.
  let assignment = created;
  try {
    const { data: accepted, error: accErr } = await client.from("job_assignments")
      .update({ status: "confirmed", acknowledged_at: nowIso })
      .eq("id", created.id)
      .eq("user_id", input.trade.id)
      .eq("status", "scheduled")
      .select()
      .maybeSingle();
    if (accErr) {
      console.error("[ops-api] self_allocate_for_invoice: accept not saved:", accErr.message);
    } else if (accepted) {
      assignment = accepted;
    }
  } catch (e) {
    console.error("[ops-api] self_allocate_for_invoice: accept threw:", (e as Error)?.message);
  }

  const { error: evErr } = await client.from("job_events").insert({
    job_id: jobId,
    user_id: input.trade.id,
    event_type: "trade_self_allocated",
    detail_json: {
      assignment_id: assignment.id,
      work_date: workDate,
      reason: "invoice",
      trade_name: input.trade.name || null,
    },
  });
  if (evErr) console.error("[ops-api] self_allocate_for_invoice: event not saved:", evErr.message);

  return { ok: true, mode: "created", assignment };
}
