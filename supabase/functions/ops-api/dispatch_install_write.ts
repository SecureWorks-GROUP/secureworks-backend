// deno-lint-ignore-file no-explicit-any
// Dispatch slice 7: the one write behind the schedule step.
// Contract: docs/dispatch-slice-7-contract.md, section 3.
//
//   set_dispatch_install_confirmed   Mark confirmed, or clearing it
//
// It writes the four install_confirmed_* columns of the job's
// job_dispatch_state row and one job_events row, and nothing else. It never
// writes jobs, job_assignments, business_events or jarvis_event_log, never the
// stage or next-step columns, and calls no other function, service or message
// sender: the only client calls in this file are reads of jobs, users,
// job_assignments and job_dispatch_state, the state row write and the one
// job_events insert. The calendar's booking lock is never touched. Keep it
// that way; the acceptance run reads this file end to end.
//
// Rules come from dispatch_install.ts and dispatch_stage.ts. Errors are
// DispatchStageWriteError so index.ts maps them as it does slice 3's.

import {
  DISPATCH_FAMILY_PROJECTION,
  DISPATCH_STAGE_PROJECTION,
  dispatchWorkType,
} from "./dispatch_job_list.ts";
import {
  type DispatchInstallBooking,
  dispatchInstallBookingsOnDay,
  dispatchInstallDay,
  isDispatchInstallBooking,
} from "./dispatch_install.ts";
import { DISPATCH_STATE_SELECT, dispatchRowFields } from "./dispatch_stage.ts";
import { findDispatchOperator } from "./dispatch_operator.ts";
import {
  DispatchStageWriteError,
  readDispatchInstallBookings,
} from "./dispatch_stage_write.ts";

export const DISPATCH_INSTALL_CONFIRMED_EVENT = "dispatch_install_confirmed";
export const DISPATCH_INSTALL_CLEARED_EVENT =
  "dispatch_install_confirmed_cleared";

// Who pressed: the signed-in user from the verified session, or, for the
// privileged ops key, no user and the operator email the screen stamps.
export type DispatchInstallActor = {
  mode: "jwt" | "api_key";
  userId: string | null;
  email: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const JOB_SELECT = [
  "id, org_id, type, status, job_number, council_required",
  ...DISPATCH_FAMILY_PROJECTION,
  ...DISPATCH_STAGE_PROJECTION,
].join(", ");

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function readJob(client: any, jobId: string, orgId: string) {
  const { data, error } = await client.from("jobs")
    .select(JOB_SELECT)
    .eq("id", jobId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new DispatchStageWriteError(`Job ${jobId} not found`, 404);
  if (dispatchWorkType(data) === "makesafe") {
    throw new DispatchStageWriteError(
      `job ${
        data.job_number || jobId
      } is a make-safe job; it has no install step on Dispatch`,
      409,
      { code: "not_dispatch_work" },
    );
  }
  return data;
}

async function readState(client: any, jobId: string) {
  const { data, error } = await client.from("job_dispatch_state")
    .select(DISPATCH_STATE_SELECT)
    .eq("job_id", jobId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// The person the mark names. The ops key must name a real user; a session's
// email is its users row's.
async function resolvePerson(
  client: any,
  actor: DispatchInstallActor,
  body: any,
  orgId: string,
): Promise<{ userId: string | null; email: string }> {
  if (actor.mode === "jwt" && actor.userId) {
    if (cleanText(actor.email)) {
      return { userId: actor.userId, email: cleanText(actor.email) as string };
    }
    const { data, error } = await client.from("users")
      .select("id, email")
      .eq("id", actor.userId)
      .maybeSingle();
    if (error) throw error;
    const email = cleanText(data?.email);
    if (!email) {
      throw new DispatchStageWriteError(
        "the signed-in user has no email on record",
        400,
        { code: "operator_required" },
      );
    }
    return { userId: actor.userId, email };
  }
  const raw = cleanText(body?.operator_email);
  if (!raw) {
    throw new DispatchStageWriteError(
      "operator_email naming a person is required",
      400,
      { code: "operator_required" },
    );
  }
  const match = await findDispatchOperator(client, orgId, raw);
  if (!match) {
    throw new DispatchStageWriteError(
      "operator_email does not match a person on record",
      400,
      { code: "operator_required" },
    );
  }
  return { userId: null, email: match.email };
}

function answerFields(
  job: any,
  state: any,
  bookings: DispatchInstallBooking[],
  today: string,
) {
  const fields = dispatchRowFields(job, state, { bookings, today });
  return {
    dispatch_install: fields.dispatch_install ?? null,
    dispatch_install_open: fields.dispatch_install_open ?? null,
    dispatch_todo: fields.dispatch_todo,
    dispatch_todo_out: fields.dispatch_todo_out,
  };
}

async function refuse(
  client: any,
  job: any,
  bookings: DispatchInstallBooking[],
  today: string,
  code: "install_changed" | "confirmation_changed",
): Promise<never> {
  const current = await readState(client, job.id);
  throw new DispatchStageWriteError(
    code === "install_changed"
      ? `job ${
        job.job_number || job.id
      }'s install booking changed; nothing was written`
      : `job ${
        job.job_number || job.id
      }'s install confirmation changed; nothing was written`,
    409,
    {
      code,
      job_id: job.id,
      job_number: job.job_number ?? null,
      ...answerFields(job, current, bookings, today),
    },
  );
}

function expectedDay(body: any): string | null {
  if (!("expected_install_day" in (body || {}))) {
    throw new DispatchStageWriteError(
      "expected_install_day required: the install day the screen was showing, or null",
      400,
    );
  }
  const value = body.expected_install_day;
  if (value === null) return null;
  if (typeof value !== "string" || !DAY_RE.test(value.trim())) {
    throw new DispatchStageWriteError(
      "expected_install_day must be YYYY-MM-DD or null",
      400,
    );
  }
  return value.trim();
}

function expectedConfirmedAt(body: any): string | null {
  if (!("expected_confirmed_at" in (body || {}))) {
    throw new DispatchStageWriteError(
      "expected_confirmed_at required: the confirmation time the screen was showing, or null",
      400,
    );
  }
  const value = body.expected_confirmed_at;
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new DispatchStageWriteError(
      "expected_confirmed_at must be a time or null",
      400,
    );
  }
  return value.trim();
}

// Two time strings name the same instant (PostgREST and the screen may print
// one instant differently).
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) ? ta === tb : a === b;
}

export async function setDispatchInstallConfirmed(
  client: any,
  body: any,
  actor: DispatchInstallActor,
  orgId: string,
  today: string,
) {
  const jobId = String(body?.job_id ?? body?.jobId ?? "").trim();
  if (!jobId) throw new DispatchStageWriteError("job_id required", 400);
  if (!UUID_RE.test(jobId)) {
    throw new DispatchStageWriteError("job_id must be a job id", 400);
  }
  if (typeof body?.confirmed !== "boolean") {
    throw new DispatchStageWriteError("confirmed must be true or false", 400);
  }
  const confirm: boolean = body.confirmed;
  const shownDay = expectedDay(body);
  const shownAt = expectedConfirmedAt(body);

  const job = await readJob(client, jobId, orgId);
  const person = await resolvePerson(client, actor, body, orgId);
  const [bookings, state] = await Promise.all([
    readDispatchInstallBookings(client, jobId),
    readState(client, jobId),
  ]);
  const installs = bookings.filter(isDispatchInstallBooking);
  const { day } = dispatchInstallDay(installs, today);

  // A booking moved in the calendar while the tab was open is never confirmed
  // by mistake.
  if (day !== shownDay) {
    await refuse(client, job, bookings, today, "install_changed");
  }
  const storedAt = cleanText(state?.install_confirmed_at);
  if (!sameInstant(storedAt, shownAt)) {
    await refuse(client, job, bookings, today, "confirmation_changed");
  }

  const storedDay = cleanText(state?.install_confirmed_for_day)?.slice(0, 10) ??
    null;
  const unchanged = confirm
    ? storedAt !== null && storedDay === day
    : storedAt === null;
  if (unchanged) {
    return {
      success: true,
      unchanged: true,
      job_id: jobId,
      ...answerFields(job, state, bookings, today),
      audit_logged: false,
    };
  }

  const now = new Date().toISOString();
  const markFields = confirm
    ? {
      install_confirmed_at: now,
      install_confirmed_by: person.userId,
      install_confirmed_by_email: person.email,
      install_confirmed_for_day: day,
    }
    : {
      install_confirmed_at: null,
      install_confirmed_by: null,
      install_confirmed_by_email: null,
      install_confirmed_for_day: null,
    };

  let written: any = null;
  if (!state) {
    // No row yet: stage and next step stay null. A row inserted in between is a
    // 409, never an overwrite.
    const { data, error } = await client.from("job_dispatch_state")
      .insert({
        job_id: jobId,
        org_id: job.org_id || orgId,
        ...markFields,
        updated_at: now,
      })
      .select(DISPATCH_STATE_SELECT)
      .maybeSingle();
    if (error) {
      if (String(error?.code || "") === "23505") {
        await refuse(client, job, bookings, today, "confirmation_changed");
      }
      throw error;
    }
    written = data;
  } else {
    // Guarded on the mark it read: a press in between matches no row.
    let update = client.from("job_dispatch_state")
      .update({ ...markFields, updated_at: now })
      .eq("job_id", jobId);
    update = state.install_confirmed_at == null
      ? update.is("install_confirmed_at", null)
      : update.eq("install_confirmed_at", state.install_confirmed_at);
    const { data, error } = await update
      .select(DISPATCH_STATE_SELECT)
      .maybeSingle();
    if (error) throw error;
    written = data;
  }
  if (!written) {
    await refuse(client, job, bookings, today, "confirmation_changed");
  }

  const onDay = dispatchInstallBookingsOnDay(installs, day);
  const previous = storedAt
    ? {
      at: storedAt,
      by_email: cleanText(state?.install_confirmed_by_email),
      for_day: storedDay,
    }
    : null;
  const after = answerFields(job, written, bookings, today);
  const { error: eventError } = await client.from("job_events").insert({
    job_id: jobId,
    event_type: confirm
      ? DISPATCH_INSTALL_CONFIRMED_EVENT
      : DISPATCH_INSTALL_CLEARED_EVENT,
    user_id: person.userId,
    detail_json: confirm
      ? {
        for_day: day,
        people: (after.dispatch_install?.people || []).map((p: any) => p.name),
        booking_ids: onDay.map((row) => row.id).filter(Boolean),
        calendar_confirmed: after.dispatch_install?.calendar_confirmed ?? false,
        previous,
        operator_email: person.email,
      }
      : {
        was_confirmed_at: storedAt,
        was_confirmed_by_email: previous?.by_email ?? null,
        was_for_day: storedDay,
        operator_email: person.email,
      },
  });
  if (eventError) {
    console.error(
      "[set_dispatch_install_confirmed] job_events audit row not written:",
      eventError,
    );
  }

  return {
    success: true,
    job_id: jobId,
    ...after,
    audit_logged: !eventError,
  };
}
