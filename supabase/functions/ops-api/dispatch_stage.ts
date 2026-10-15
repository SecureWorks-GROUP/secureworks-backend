// Dispatch slice 3: the six-stop stage rail and the To do list.
// Contract: docs/dispatch-slice-3-contract.md.
//
// Everything here is pure. `pipeline` (dispatch=1) and the two writes in
// index.ts own the reads and writes; this module owns every rule: where a job
// sits on the rail, whether it is in To do, why a patio is held out, and what a
// write may store. Nothing else may restate these rules.
//
// The stage is Dispatch's own record (table job_dispatch_state), never the job
// status. Where nobody has set one, the place is read from the job status (the
// Repairs board stage for repair). Reading never writes anything.

import {
  type InsuranceRepairStage,
  insuranceRepairStage,
} from "./insurance_repairs_board.ts";
import { dispatchWorkType } from "./dispatch_job_list.ts";
import {
  type DispatchInstall,
  dispatchInstall,
  type DispatchInstallBooking,
  dispatchInstallHoldsTodo,
  type DispatchInstallMarkRow,
  type DispatchInstallOpen,
  dispatchInstallOpen,
} from "./dispatch_install.ts";

export const DISPATCH_NOT_STARTED = "not_started";

// The six stops, in rail order. Index 1 is the first.
export const DISPATCH_STAGES = [
  "accepted",
  "deposit_paid",
  "materials_ordered",
  "supplier_confirmed",
  "materials_on_site",
  "trade_scheduled",
] as const;

export type DispatchStage = (typeof DISPATCH_STAGES)[number];
export type DispatchStageSource = "set" | "job_status" | "repairs_board";

const DISPATCH_STAGE_SET = new Set<string>(DISPATCH_STAGES);

export function isDispatchStage(value: unknown): value is DispatchStage {
  return typeof value === "string" && DISPATCH_STAGE_SET.has(value);
}

export function dispatchStageIndex(stage: string): number {
  const at = (DISPATCH_STAGES as readonly string[]).indexOf(stage);
  return at < 0 ? 0 : at + 1;
}

// The work types with To do. Make-safe is out, and so is any other type (the
// insurance jobs stay in All jobs only, ruling T8).
export const DISPATCH_TODO_WORK_TYPES = [
  "fencing",
  "patio",
  "decking",
  "repair",
];

// The job statuses inside the Dispatch window: Accepted until Scheduled.
export const DISPATCH_WINDOW_STATUSES = [
  "accepted",
  "awaiting_deposit",
  "deposit",
  "approvals",
  "order_materials",
  "processing",
  "awaiting_supplier",
  "order_confirmed",
  "schedule_install",
  "scheduled",
];

// A repair is in the window from Repairs board Approved until Scheduled.
export const DISPATCH_REPAIR_WINDOW_STAGES: InsuranceRepairStage[] = [
  "approved",
  "materials",
  "scheduled",
];

// Every status after Scheduled: a finished job has had its trade scheduled.
const AFTER_SCHEDULED_STATUSES = [
  "in_progress",
  "rectification",
  "complete",
  "final_payment",
  "invoiced",
  "get_review",
  "archived",
];

// Where an unset job sits, by job status. Grouped by the canonical order in
// _shared/stage-gate/job-state-machine.ts (stage_order 4-5, 6-7, 8, 9-10,
// 11 and up). Approvals is a patio stage; a fence at it reads the same stop.
// Materials on site (stop 5) is never read: it exists only once set by hand.
const STAGE_BY_JOB_STATUS: Record<
  string,
  DispatchStage | typeof DISPATCH_NOT_STARTED
> = {
  partially_accepted: DISPATCH_NOT_STARTED,
  accepted: "accepted",
  awaiting_deposit: "accepted",
  deposit: "accepted",
  approvals: "deposit_paid",
  order_materials: "deposit_paid",
  processing: "deposit_paid",
  awaiting_supplier: "materials_ordered",
  order_confirmed: "supplier_confirmed",
  schedule_install: "supplier_confirmed",
  scheduled: "trade_scheduled",
  ...Object.fromEntries(
    AFTER_SCHEDULED_STATUSES.map((status) => [status, "trade_scheduled"]),
  ),
};

// Where an unset repair sits, by its Repairs board stage. The one mapping from
// a repair stage to the rail; the stage itself comes from insuranceRepairStage,
// the function the Repairs board uses.
const STAGE_BY_REPAIR_STAGE: Record<
  InsuranceRepairStage,
  DispatchStage | typeof DISPATCH_NOT_STARTED
> = {
  wo_in: DISPATCH_NOT_STARTED,
  scoping: DISPATCH_NOT_STARTED,
  quoted: DISPATCH_NOT_STARTED,
  variation: DISPATCH_NOT_STARTED,
  approved: "accepted",
  materials: "deposit_paid",
  scheduled: "trade_scheduled",
  on_site: "trade_scheduled",
  complete: "trade_scheduled",
};

function token(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

// The job row as the Dispatch list projects it: `type`, `status`,
// `council_required`, and the `ds_` family and repair stage aliases.
export type DispatchStageJob = {
  type?: string | null;
  status?: string | null;
  council_required?: boolean | null;
  ds_ses_family?: string | null;
  ds_makesafe_family?: string | null;
  ds_repair_stage?: string | null;
};

// The job_dispatch_state row as the list and the writes read it.
export type DispatchStateRow =
  | {
    stage?: string | null;
    stage_set_at?: string | null;
    stage_set_by_email?: string | null;
    next_step?: string | null;
    next_step_set_at?: string | null;
    stage_setter?: { name?: string | null } | null;
  } & NonNullable<DispatchInstallMarkRow>
  | null
  | undefined;

function repairBoardStage(job: DispatchStageJob): InsuranceRepairStage {
  return insuranceRepairStage({
    repair_stage: job?.ds_repair_stage,
    status: job?.status,
  });
}

export type DispatchPlace = {
  stage: string | null;
  index: number | null;
  source: DispatchStageSource | null;
  from: string | null;
};

// A job's place on the rail. A set stage wins; otherwise the job status, or
// the Repairs board stage for repair. A make-safe job has no rail.
export function dispatchPlace(
  job: DispatchStageJob,
  state: DispatchStateRow,
): DispatchPlace {
  const workType = dispatchWorkType(job);
  if (workType === "makesafe") {
    return { stage: null, index: null, source: null, from: null };
  }
  if (isDispatchStage(state?.stage)) {
    return {
      stage: state.stage,
      index: dispatchStageIndex(state.stage),
      source: "set",
      from: null,
    };
  }
  if (workType === "repair") {
    const boardStage = repairBoardStage(job);
    const stage = STAGE_BY_REPAIR_STAGE[boardStage];
    return {
      stage,
      index: dispatchStageIndex(stage),
      source: "repairs_board",
      from: boardStage,
    };
  }
  const status = token(job?.status);
  // A status outside the Dispatch list (only reachable through an explicit
  // `status` filter) has not reached the rail.
  const stage = STAGE_BY_JOB_STATUS[status] || DISPATCH_NOT_STARTED;
  return {
    stage,
    index: dispatchStageIndex(stage),
    source: "job_status",
    from: status || null,
  };
}

export type DispatchTodoHold =
  | "in_council"
  | "council_to_come"
  | "council_not_decided";

const BEFORE_APPROVALS_STATUSES = ["accepted", "awaiting_deposit", "deposit"];

// The patio council rule: a patio or decking job is held while its status is
// Approvals, or while it is before Approvals and council_required is not false.
// council_required false needs no council; true and past Approvals is through.
export function dispatchCouncilHold(
  workType: string,
  job: DispatchStageJob,
): DispatchTodoHold | null {
  if (workType !== "patio" && workType !== "decking") return null;
  const status = token(job?.status);
  if (status === "approvals") return "in_council";
  if (!BEFORE_APPROVALS_STATUSES.includes(status)) return null;
  if (job?.council_required === false) return null;
  return job?.council_required === true
    ? "council_to_come"
    : "council_not_decided";
}

function inDispatchWindow(workType: string, job: DispatchStageJob): boolean {
  if (!DISPATCH_WINDOW_STATUSES.includes(token(job?.status))) return false;
  return workType !== "repair" ||
    DISPATCH_REPAIR_WINDOW_STAGES.includes(repairBoardStage(job));
}

// Whether a listed job is in To do, and, for a job inside the window that the
// council rule holds out, why. The caller passes rows already on the Dispatch
// list (slice 1's ruling R1). Slice 7: a Trade scheduled job stays in To do
// until its install is confirmed for the booked day (dispatch_install.ts).
// Without `install` (a caller that read no bookings) stop 6 is out, as in
// slice 3.
export function dispatchTodo(
  job: DispatchStageJob,
  place: DispatchPlace,
  install?: DispatchInstall | null,
): { todo: boolean; out: DispatchTodoHold | null } {
  const workType = dispatchWorkType(job);
  if (!DISPATCH_TODO_WORK_TYPES.includes(workType)) {
    return { todo: false, out: null };
  }
  if (!inDispatchWindow(workType, job)) return { todo: false, out: null };
  const hold = dispatchCouncilHold(workType, job);
  if (hold) return { todo: false, out: hold };
  const index = place.index ?? 0;
  if (index === 6 && install) {
    return { todo: dispatchInstallHoldsTodo(install), out: null };
  }
  return { todo: index >= 1 && index <= 5, out: null };
}

// The setter's name, else the stamped email, else null.
export function dispatchStageSetBy(state: DispatchStateRow): string | null {
  const name = state?.stage_setter?.name;
  if (typeof name === "string" && name.trim()) return name.trim();
  const email = state?.stage_set_by_email;
  return typeof email === "string" && email.trim() ? email.trim() : null;
}

export type DispatchRowFields = {
  dispatch_stage: string | null;
  dispatch_stage_index: number | null;
  dispatch_stage_source: DispatchStageSource | null;
  dispatch_stage_from: string | null;
  dispatch_stage_set_at: string | null;
  dispatch_stage_set_by: string | null;
  dispatch_todo: boolean;
  dispatch_todo_out: DispatchTodoHold | null;
  dispatch_next_step: string | null;
  dispatch_install?: DispatchInstall | null;
  dispatch_install_open?: DispatchInstallOpen | null;
};

// The bookings the install fields are worked out from (dispatch_install.ts),
// and the Perth day. A caller that passes none gets slice 3's fields only.
export type DispatchInstallContext = {
  bookings: DispatchInstallBooking[] | null | undefined;
  today: string;
};

// Every Dispatch field one list row carries, from the job and its state row.
export function dispatchRowFields(
  job: DispatchStageJob,
  state: DispatchStateRow,
  installContext?: DispatchInstallContext,
): DispatchRowFields {
  const place = dispatchPlace(job, state);
  // A make-safe job has no rail and no schedule step.
  const install = installContext && place.stage !== null
    ? dispatchInstall(installContext.bookings, state, installContext.today)
    : null;
  const { todo, out } = dispatchTodo(job, place, install);
  const isSet = place.source === "set";
  return {
    dispatch_stage: place.stage,
    dispatch_stage_index: place.index,
    dispatch_stage_source: place.source,
    dispatch_stage_from: place.from,
    dispatch_stage_set_at: isSet ? state?.stage_set_at ?? null : null,
    dispatch_stage_set_by: isSet ? dispatchStageSetBy(state) : null,
    dispatch_todo: todo,
    dispatch_todo_out: out,
    dispatch_next_step: place.stage === null
      ? null
      : (typeof state?.next_step === "string" && state.next_step
        ? state.next_step
        : null),
    ...(installContext
      ? {
        dispatch_install: install,
        dispatch_install_open: dispatchInstallOpen(install, place.index, todo),
      }
      : {}),
  };
}

// The read of job_dispatch_state the list and the writes share. The setter's
// name is embedded through the stage_set_by foreign key to users, and the
// install confirmer's (slice 7) through install_confirmed_by.
export const DISPATCH_STATE_SELECT =
  "job_id, stage, stage_set_at, stage_set_by, stage_set_by_email, next_step, next_step_set_at, stage_setter:stage_set_by(name), install_confirmed_at, install_confirmed_by, install_confirmed_by_email, install_confirmed_for_day, install_confirmer:install_confirmed_by(name)";

export const DISPATCH_NEXT_STEP_MAX = 40;

// Trim and collapse runs of white space. Null for a line that is not text.
// An empty result clears the line.
export function normaliseDispatchNextStep(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/\s+/g, " ").trim();
}
