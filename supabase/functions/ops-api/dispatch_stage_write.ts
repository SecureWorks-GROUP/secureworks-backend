// deno-lint-ignore-file no-explicit-any
// Dispatch slice 3: the two writes behind the stage rail.
// Contract: docs/dispatch-slice-3-contract.md, section 3.
//
//   set_dispatch_stage      a confirmed press on a rail stop
//   set_dispatch_next_step  saving the next-step line
//
// Each writes the job's job_dispatch_state row and one job_events row, and
// nothing else. Neither writes `jobs` (no job status, no metadata, no
// updated_at), neither raises a business event, and neither calls another
// function, service or message sender: the only client calls in this file are
// reads of `jobs`, `job_dispatch_state` and (slice 7, so To do is answered by
// the install rule) `job_assignments`, the state row write and the one
// job_events insert. Keep it that way; the acceptance run reads this file end
// to end.
//
// Rules come from dispatch_stage.ts. Errors are DispatchStageWriteError so this
// module needs nothing from index.ts, which maps them to ApiError.

import {
  DISPATCH_FAMILY_PROJECTION,
  DISPATCH_STAGE_PROJECTION,
  dispatchWorkType,
} from "./dispatch_job_list.ts";
import {
  DISPATCH_INSTALL_BOOKING_SELECT,
  type DispatchInstallBooking,
} from "./dispatch_install.ts";
import {
  DISPATCH_NEXT_STEP_MAX,
  DISPATCH_NOT_STARTED,
  DISPATCH_STAGES,
  DISPATCH_STATE_SELECT,
  type DispatchInstallContext,
  dispatchRowFields,
  isDispatchStage,
  normaliseDispatchNextStep,
} from "./dispatch_stage.ts";

export class DispatchStageWriteError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(
    message: string,
    status: number,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = status;
    this.body = { error: message, ...extra };
  }
}

// Who pressed: the signed-in user (id and email from the verified session),
// or, for the privileged ops key, no user and the operator email the screen
// stamps.
export type DispatchWriteActor = {
  userId: string | null;
  email: string | null;
};

export const DISPATCH_STAGE_CHANGED_EVENT = "dispatch_stage_changed";
export const DISPATCH_NEXT_STEP_SET_EVENT = "dispatch_next_step_set";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The job columns the rules need, projected: never metadata or scope_json whole.
const JOB_SELECT = [
  "id, org_id, type, status, job_number, council_required",
  ...DISPATCH_FAMILY_PROJECTION,
  ...DISPATCH_STAGE_PROJECTION,
].join(", ");

function requireJobId(body: any): string {
  const jobId = String(body?.job_id ?? body?.jobId ?? "").trim();
  if (!jobId) throw new DispatchStageWriteError("job_id required", 400);
  if (!UUID_RE.test(jobId)) {
    throw new DispatchStageWriteError("job_id must be a job id", 400);
  }
  return jobId;
}

async function readJob(client: any, jobId: string, orgId: string) {
  const { data, error } = await client.from("jobs")
    .select(JOB_SELECT)
    .eq("id", jobId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new DispatchStageWriteError(`Job ${jobId} not found`, 404);
  // Make-safe jobs have no rail. A repair-family job stored as make-safe is a
  // repair (dispatchWorkType) and is allowed.
  if (dispatchWorkType(data) === "makesafe") {
    throw new DispatchStageWriteError(
      `job ${
        data.job_number || jobId
      } is a make-safe job; it has no Dispatch stage`,
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

// The job's bookings, read as the list reads them (dispatch_install.ts decides
// which are the install). Used by set_dispatch_stage and slice 7's
// set_dispatch_install_confirmed.
export async function readDispatchInstallBookings(
  client: any,
  jobId: string,
): Promise<DispatchInstallBooking[]> {
  const { data, error } = await client.from("job_assignments")
    .select(DISPATCH_INSTALL_BOOKING_SELECT)
    .eq("job_id", jobId)
    .or("status.is.null,status.neq.cancelled");
  if (error) throw error;
  return data || [];
}

// What set_dispatch_stage answers To do with: the job's bookings, or "failed"
// when they could not be read (the press still goes through; To do is then
// unknown).
type StageInstallRead = DispatchInstallContext | "failed" | undefined;

async function readStageInstall(
  client: any,
  jobId: string,
  today?: string,
): Promise<StageInstallRead> {
  if (!today) return undefined;
  try {
    return {
      bookings: await readDispatchInstallBookings(client, jobId),
      today,
    };
  } catch (error) {
    console.error(
      "[set_dispatch_stage] bookings not read; dispatch_todo unknown:",
      error,
    );
    return "failed";
  }
}

function stageRowFields(job: any, state: any, install: StageInstallRead) {
  const {
    dispatch_install: _install,
    dispatch_install_open: _open,
    ...fields
  } = dispatchRowFields(
    job,
    state,
    install === "failed" ? undefined : install,
  );
  return install === "failed" ? { ...fields, dispatch_todo: null } : fields;
}

async function writeEvent(
  client: any,
  row: {
    job_id: string;
    event_type: string;
    user_id: string | null;
    detail_json: Record<string, unknown>;
  },
  label: string,
): Promise<boolean> {
  const { error } = await client.from("job_events").insert(row);
  if (error) {
    console.error(`[${label}] job_events audit row not written:`, error);
    return false;
  }
  return true;
}

function cleanEmail(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isUniqueViolation(error: any): boolean {
  return String(error?.code || "") === "23505";
}

async function stageChanged(
  client: any,
  job: any,
  install: StageInstallRead,
): Promise<never> {
  const current = await readState(client, job.id);
  throw new DispatchStageWriteError(
    `job ${
      job.job_number || job.id
    }'s Dispatch stage changed; nothing was written`,
    409,
    {
      code: "stage_changed",
      job_id: job.id,
      job_number: job.job_number ?? null,
      ...stageRowFields(job, current, install),
    },
  );
}

export async function setDispatchStage(
  client: any,
  body: any,
  actor: DispatchWriteActor,
  orgId: string,
  today?: string,
) {
  const jobId = requireJobId(body);
  const stage = String(body?.stage ?? "").trim();
  if (!stage) throw new DispatchStageWriteError("stage required", 400);
  if (stage === DISPATCH_NOT_STARTED) {
    throw new DispatchStageWriteError(
      "not_started cannot be set; it means no stage is set yet",
      400,
    );
  }
  if (!isDispatchStage(stage)) {
    throw new DispatchStageWriteError(
      `unknown Dispatch stage '${stage}'; expected one of ${
        DISPATCH_STAGES.join(", ")
      }`,
      400,
    );
  }
  const expectedStage = String(body?.expected_stage ?? "").trim();
  if (!expectedStage) {
    throw new DispatchStageWriteError(
      "expected_stage required: the stage the screen was showing",
      400,
    );
  }

  const job = await readJob(client, jobId, orgId);
  const state = await readState(client, jobId);
  // Slice 7: To do at Trade scheduled turns on the install, so the answer is
  // worked out with the job's bookings (read only; nothing about them changes).
  const install = await readStageInstall(client, jobId, today);
  const before = stageRowFields(job, state, install);

  // Two people, or two tabs, cannot both move a job.
  if (before.dispatch_stage !== expectedStage) {
    await stageChanged(client, job, install);
  }

  const operatorEmail = cleanEmail(actor.email);
  const userId = actor.userId || null;

  if (
    before.dispatch_stage_source === "set" && before.dispatch_stage === stage
  ) {
    return {
      success: true,
      unchanged: true,
      job_id: jobId,
      job_number: job.job_number ?? null,
      dispatch_stage: before.dispatch_stage,
      dispatch_stage_index: before.dispatch_stage_index,
      dispatch_stage_source: "set",
      dispatch_stage_set_at: before.dispatch_stage_set_at,
      dispatch_stage_set_by: before.dispatch_stage_set_by,
      previous_stage: before.dispatch_stage,
      previous_source: before.dispatch_stage_source,
      dispatch_todo: before.dispatch_todo,
      dispatch_todo_out: before.dispatch_todo_out,
      audit_logged: false,
    };
  }

  const changedAt = new Date().toISOString();
  const stageFields = {
    stage,
    stage_set_at: changedAt,
    stage_set_by: userId,
    stage_set_by_email: operatorEmail,
    updated_at: changedAt,
  };

  let written: any = null;
  if (!state) {
    // First press on this job. A row inserted in between is a 409, never an
    // overwrite.
    const { data, error } = await client.from("job_dispatch_state")
      .insert({ job_id: jobId, org_id: job.org_id || orgId, ...stageFields })
      .select(DISPATCH_STATE_SELECT)
      .maybeSingle();
    if (error) {
      if (isUniqueViolation(error)) await stageChanged(client, job, install);
      throw error;
    }
    written = data;
  } else {
    // Guarded on the stage it read: a move in between matches no row.
    let update = client.from("job_dispatch_state")
      .update(stageFields)
      .eq("job_id", jobId);
    update = state.stage == null
      ? update.is("stage", null)
      : update.eq("stage", state.stage);
    const { data, error } = await update
      .select(DISPATCH_STATE_SELECT)
      .maybeSingle();
    if (error) throw error;
    written = data;
  }
  if (!written) await stageChanged(client, job, install);

  const auditLogged = await writeEvent(client, {
    job_id: jobId,
    event_type: DISPATCH_STAGE_CHANGED_EVENT,
    user_id: userId,
    detail_json: {
      from_stage: before.dispatch_stage,
      from_source: before.dispatch_stage_source,
      to_stage: stage,
      operator_email: operatorEmail,
      changed_at: changedAt,
    },
  }, "set_dispatch_stage");

  const after = stageRowFields(job, written, install);
  return {
    success: true,
    job_id: jobId,
    job_number: job.job_number ?? null,
    dispatch_stage: after.dispatch_stage,
    dispatch_stage_index: after.dispatch_stage_index,
    dispatch_stage_source: "set",
    dispatch_stage_set_at: after.dispatch_stage_set_at,
    dispatch_stage_set_by: after.dispatch_stage_set_by,
    previous_stage: before.dispatch_stage,
    previous_source: before.dispatch_stage_source,
    dispatch_todo: after.dispatch_todo,
    dispatch_todo_out: after.dispatch_todo_out,
    audit_logged: auditLogged,
  };
}

export async function setDispatchNextStep(
  client: any,
  body: any,
  actor: DispatchWriteActor,
  orgId: string,
) {
  const jobId = requireJobId(body);
  if (typeof body?.text !== "string") {
    throw new DispatchStageWriteError(
      "text required: the next-step line, or an empty string to clear it",
      400,
    );
  }
  const cleaned = normaliseDispatchNextStep(body.text) ?? "";
  if (cleaned.length > DISPATCH_NEXT_STEP_MAX) {
    throw new DispatchStageWriteError(
      `the next-step line is at most ${DISPATCH_NEXT_STEP_MAX} characters`,
      400,
    );
  }
  const text = cleaned || null;

  const job = await readJob(client, jobId, orgId);
  const state = await readState(client, jobId);
  const previousText = state?.next_step ?? null;

  if (previousText === text) {
    return {
      success: true,
      unchanged: true,
      job_id: jobId,
      dispatch_next_step: previousText,
      next_step_set_at: state?.next_step_set_at ?? null,
    };
  }

  const operatorEmail = cleanEmail(actor.email);
  const userId = actor.userId || null;
  const setAt = new Date().toISOString();
  // Only the next-step columns: a stage on the same row is left as it is.
  const { data, error } = await client.from("job_dispatch_state")
    .upsert({
      job_id: jobId,
      org_id: job.org_id || orgId,
      next_step: text,
      next_step_set_at: setAt,
      next_step_set_by: userId,
      next_step_set_by_email: operatorEmail,
      updated_at: setAt,
    }, { onConflict: "job_id" })
    .select("job_id, next_step, next_step_set_at")
    .maybeSingle();
  if (error) throw error;

  const auditLogged = await writeEvent(client, {
    job_id: jobId,
    event_type: DISPATCH_NEXT_STEP_SET_EVENT,
    user_id: userId,
    detail_json: {
      text,
      previous_text: previousText,
      operator_email: operatorEmail,
    },
  }, "set_dispatch_next_step");

  return {
    success: true,
    job_id: jobId,
    dispatch_next_step: data?.next_step ?? text,
    next_step_set_at: data?.next_step_set_at ?? setAt,
    audit_logged: auditLogged,
  };
}
