// deno-lint-ignore-file no-explicit-any
// Dispatch v2 board: which jobs the Dispatch list shows, in which stage group,
// Active or Archive, and what each card carries (full name, days in stage,
// install date, deposit, the moves the header rail may offer, the Arrival line).
// Contract: docs/dispatch-v2-board-contract.md.
//
// Opt-in: `pipeline&dispatch=1&board=v2`. Without `board=v2` the v1 Dispatch
// list (dispatch_job_list.ts, dispatch_stage.ts) answers exactly as before.
//
// The rules here are pure. The reads live at the bottom of this file and are
// called from `pipeline` in index.ts; `dispatch_arrival` (one job) also lives
// here. Nothing in this module writes anything.
//
// The plain rules, in business words:
// - A job is on the board when its REAL pipeline status is Order Materials,
//   Awaiting Supplier, Order Confirmed, Schedule Install, Scheduled, In
//   Progress or Rectification (fencing, patio, decking). A repair is on it
//   when its Repairs board stage is Materials or Scheduled. Nothing earlier,
//   no make-safes, no other types. Dispatch's own v1 stage
//   (job_dispatch_state) never decides this.
// - In Progress and Rectification are on the board (Shaun, 27 Oct 2026)
//   because that is where extra materials get ordered once a crew is on site:
//   a flashing, a downpipe, a fix-up part. They stay Active for as long as the
//   job is at that stage, whatever the install day.
// - Archive is Dispatch's own and never changes the real status. A Scheduled
//   job (or one already moved past Rectification) goes to Archive the day
//   after its last install day, Perth time. Archive shows the last 30 days; a
//   search finds older ones.
// - A Scheduled job with no install booked stays Active with a flag.
// - Each supplier order on a card carries its material stage and who it is
//   waiting on (dispatch_v2_material_stage.ts). A card is "waiting on us" when
//   any order is, or when the job itself is (Order Materials with nothing
//   ordered yet, Schedule Install).

import { STATUS_LABELS } from "../_shared/stage-gate/job-state-machine.ts";
import { insuranceRepairStage } from "./insurance_repairs_board.ts";
import { dispatchWorkType } from "./dispatch_job_list.ts";
import {
  type DispatchInstallBooking,
  dispatchInstallBookingsByJob,
  dispatchInstallDay,
  isDispatchInstallBooking,
} from "./dispatch_install.ts";
import {
  isDispatchDeliveryCounted,
  isDispatchDeliveryDate,
} from "./dispatch_deliveries.ts";
import { fetchAllRows, fetchAllRowsInChunks } from "./makesafe_compact_reads.ts";
import {
  type DispatchV2Fulfilment,
  dispatchV2FulfilmentOf,
} from "./dispatch_v2_emails.ts";
import {
  type DispatchMaterialStageKey,
  dispatchMaterialStageLabel,
  type DispatchMaterialStageShown,
  dispatchMaterialTodo,
  type DispatchMaterialWaitingOn,
  dispatchMaterialWaitingOn,
  dispatchPoMaterialStage,
  dispatchV2BoxStage,
  type DispatchV2BoxStage,
} from "./dispatch_v2_material_stage.ts";
import {
  type DispatchV2Accounts,
  dispatchV2AccountsOf,
  dispatchV2TermsFor,
} from "./dispatch_v2_payment.ts";

// ── The request ─────────────────────────────────────────────────────────────

export const DISPATCH_BOARD_PARAM = "board";
export const DISPATCH_BOARD_V2 = "v2";
export const DISPATCH_BOARD_VIEW_PARAM = "view";

export type DispatchBoardView = "active" | "archive";

export type DispatchBoardRequest = { view: DispatchBoardView };

// `board=v2` only means something on the Dispatch list (`dispatch=1`). The
// view defaults to Active; anything other than `archive` is Active.
export function dispatchBoardRequest(
  params: { get(name: string): string | null },
): DispatchBoardRequest | null {
  if (params.get("dispatch") !== "1") return null;
  if (params.get(DISPATCH_BOARD_PARAM) !== DISPATCH_BOARD_V2) return null;
  const view = params.get(DISPATCH_BOARD_VIEW_PARAM) === "archive"
    ? "archive"
    : "active";
  return { view };
}

// ── The stages ──────────────────────────────────────────────────────────────

// The real pipeline statuses the board shows, in pipeline order. These are
// jobs.status values, moved by the existing `update_job_status` action.
export const DISPATCH_BOARD_STATUSES = [
  "order_materials",
  "awaiting_supplier",
  "order_confirmed",
  "schedule_install",
  "scheduled",
  "in_progress",
  "rectification",
] as const;

// The two board stages a crew has already been on site for. A job here stays
// Active whatever its install day, and its orders made from then on are
// extra orders.
export const DISPATCH_BOARD_ON_SITE_STATUSES = [
  "in_progress",
  "rectification",
];

function isOnSiteStage(stage: { track: string; key: string }): boolean {
  return stage.track === "pipeline" &&
    DISPATCH_BOARD_ON_SITE_STATUSES.includes(stage.key);
}

// The Repairs board stages the board shows, in order. These live in
// jobs.metadata.repair_stage and are moved by `update_repair_stage`.
export const DISPATCH_BOARD_REPAIR_STAGES = ["materials", "scheduled"] as const;

// Every real status after Rectification. A job here has left Dispatch's
// window; it is only ever seen in Archive (by its install day).
export const DISPATCH_BOARD_AFTER_STATUSES = [
  "complete",
  "final_payment",
  "invoiced",
  "get_review",
  "archived",
];

// Repairs board stages after Scheduled.
export const DISPATCH_BOARD_REPAIR_AFTER_STAGES = ["on_site", "complete"];

// The work types the board lists. Make-safe, insurance, miscellaneous and
// quick quote jobs are never on it, even for a search.
export const DISPATCH_BOARD_WORK_TYPES = [
  "fencing",
  "patio",
  "decking",
  "repair",
];

export const DISPATCH_BOARD_ARCHIVE_DAYS = 30;

// The archive read looks this many days further back than the 30 shown, so a
// multi-day install whose first day is older than 30 days still comes back
// when its last day is inside the 30 (the pure rule below makes the final cut).
export const DISPATCH_BOARD_ARCHIVE_LOOKBACK_DAYS = 14;

// Past this many candidate jobs the archive read stops narrowing the job read
// by id (a very long id list would make the request URL too long) and reads
// every accepted job instead. Same answer, just slower.
export const DISPATCH_BOARD_ARCHIVE_ID_LIMIT = 300;

// The Active view's database filter, one flat PostgREST `or`: a job in one of
// the seven statuses, or a repair-family job (whose Repairs board stage is only
// known in code, below). The status floor and the make-safe filter of the v1
// list still apply on top of this.
export const DISPATCH_BOARD_ACTIVE_FILTER =
  `status.in.(${DISPATCH_BOARD_STATUSES.join(",")}),` +
  "type.eq.repair,metadata->>ses_family.eq.repair,metadata->>makesafe_job_family.eq.repair";

export type DispatchBoardTrack = "pipeline" | "repairs";

export type DispatchBoardStage = {
  track: DispatchBoardTrack;
  key: string;
  label: string;
  // 1-based position in its track's stage list; 0 for a stage after the window.
  order: number;
  // window = one of the board stages; after = past Scheduled (Archive only).
  phase: "window" | "after";
};

const REPAIR_STAGE_LABELS: Record<string, string> = {
  wo_in: "WO In",
  scoping: "Scoping",
  quoted: "Quoted",
  variation: "Variation",
  approved: "Approved",
  materials: "Materials",
  scheduled: "Scheduled",
  on_site: "On Site",
  complete: "Complete",
};

function token(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function dispatchBoardStatusLabel(status: string): string {
  return STATUS_LABELS[status] || status;
}

// The stage list the header rail draws, per track, in order.
export function dispatchBoardStageList(track: DispatchBoardTrack) {
  const keys: readonly string[] = track === "repairs"
    ? DISPATCH_BOARD_REPAIR_STAGES
    : DISPATCH_BOARD_STATUSES;
  return keys.map((key, index) => ({
    track,
    key,
    label: track === "repairs"
      ? REPAIR_STAGE_LABELS[key]
      : dispatchBoardStatusLabel(key),
    order: index + 1,
  }));
}

// The job row as the Dispatch list reads it (index.ts `pipeline`): type,
// status and the `ds_` family and Repairs stage aliases.
export type DispatchBoardJob = {
  id?: string | null;
  type?: string | null;
  status?: string | null;
  job_number?: string | null;
  client_name?: string | null;
  site_suburb?: string | null;
  scheduled_at?: string | null;
  ds_ses_family?: string | null;
  ds_makesafe_family?: string | null;
  ds_repair_stage?: string | null;
};

// The Repairs board stage of a repair, by the Repairs board's own reader: a
// stamped metadata.repair_stage wins, else it is read from the job status.
function repairBoardStage(job: DispatchBoardJob): string {
  return insuranceRepairStage({
    repair_stage: job?.ds_repair_stage,
    status: job?.status,
  });
}

// Where a job sits on the board, or null when it is not a board job at all.
export function dispatchBoardStage(
  job: DispatchBoardJob,
): DispatchBoardStage | null {
  const workType = dispatchWorkType(job);
  if (!DISPATCH_BOARD_WORK_TYPES.includes(workType)) return null;
  if (workType === "repair") {
    const stage = repairBoardStage(job);
    const at = (DISPATCH_BOARD_REPAIR_STAGES as readonly string[]).indexOf(
      stage,
    );
    if (at >= 0) {
      return {
        track: "repairs",
        key: stage,
        label: REPAIR_STAGE_LABELS[stage],
        order: at + 1,
        phase: "window",
      };
    }
    if (DISPATCH_BOARD_REPAIR_AFTER_STAGES.includes(stage)) {
      return {
        track: "repairs",
        key: stage,
        label: REPAIR_STAGE_LABELS[stage] || stage,
        order: 0,
        phase: "after",
      };
    }
    return null;
  }
  const status = token(job?.status);
  const at = (DISPATCH_BOARD_STATUSES as readonly string[]).indexOf(status);
  if (at >= 0) {
    return {
      track: "pipeline",
      key: status,
      label: dispatchBoardStatusLabel(status),
      order: at + 1,
      phase: "window",
    };
  }
  if (DISPATCH_BOARD_AFTER_STATUSES.includes(status)) {
    return {
      track: "pipeline",
      key: status,
      label: dispatchBoardStatusLabel(status),
      order: 0,
      phase: "after",
    };
  }
  return null;
}

// ── Perth days ──────────────────────────────────────────────────────────────

// Perth is UTC+8 all year (no daylight saving), so a fixed offset is exact.
const PERTH_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function ymd(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const day = value.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

// The Perth calendar day of a timestamp, YYYY-MM-DD.
export function perthDayOf(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + PERTH_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

// Whole calendar days from `from` to `to` (both YYYY-MM-DD).
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
      DAY_MS,
  );
}

// ── The install ─────────────────────────────────────────────────────────────

export type DispatchBoardInstall = {
  booked: boolean;
  // The day the card shows: the earliest install day on or after today, else
  // the latest one (dispatch_install.ts, the v1 rule).
  day: string | null;
  first_day: string | null;
  // The last day of the install, counting a booking's scheduled_end.
  last_day: string | null;
  // The day the job goes to Archive (last_day + 1), when it is Scheduled.
  archive_on: string | null;
  // Every install day is before today.
  passed: boolean;
  // Every install booking on `day` is still tentative.
  tentative: boolean;
};

// The install from the job's install bookings (any rows: cancelled, ghost,
// observer and non-install rows are left out here, as in dispatch_install.ts).
export function dispatchBoardInstall(
  bookings: DispatchInstallBooking[] | null | undefined,
  today: string,
): DispatchBoardInstall {
  const installs = (bookings || []).filter(isDispatchInstallBooking);
  if (installs.length === 0) {
    return {
      booked: false,
      day: null,
      first_day: null,
      last_day: null,
      archive_on: null,
      passed: false,
      tentative: false,
    };
  }
  let first: string | null = null;
  let last: string | null = null;
  for (const row of installs) {
    const start = ymd(row.scheduled_date) as string;
    const end = ymd(row.scheduled_end);
    const finish = end && end > start ? end : start;
    if (!first || start < first) first = start;
    if (!last || finish > last) last = finish;
  }
  const { day } = dispatchInstallDay(installs, today);
  const onDay = installs.filter((row) => ymd(row.scheduled_date) === day);
  return {
    booked: true,
    day,
    first_day: first,
    last_day: last,
    archive_on: last ? addDays(last, 1) : null,
    passed: !!last && last < today,
    tentative: onDay.length > 0 &&
      onDay.every((row) => token(row.confirmation_status) === "tentative"),
  };
}

// ── Active or Archive ───────────────────────────────────────────────────────

// Which view a board job belongs in, or null when it is in neither (a job past
// Scheduled with no install booking: there is no day to place it by).
// `install` null means the bookings read failed: a window job then stays
// Active (never hidden), and nothing can be placed in Archive.
export function dispatchBoardPlacement(
  stage: DispatchBoardStage,
  install: DispatchBoardInstall | null,
): DispatchBoardView | null {
  if (stage.phase === "after") {
    return install && install.booked ? "archive" : null;
  }
  // Only Scheduled leaves for Archive by date. An earlier stage with an install
  // day already gone (a tentative placeholder that slipped) stays Active, and
  // the card says the day has passed.
  if (stage.key !== "scheduled") return "active";
  if (install && install.booked && install.passed) return "archive";
  return "active";
}

// Whether an Archive job is inside the window shown (the last 30 days by its
// last install day). A search shows every Archive job, however old.
export function dispatchBoardInArchiveWindow(
  install: DispatchBoardInstall | null,
  today: string,
  searching: boolean,
): boolean {
  if (searching) return true;
  if (!install?.last_day) return false;
  return install.last_day >= addDays(today, -DISPATCH_BOARD_ARCHIVE_DAYS);
}

// ── Days in stage ───────────────────────────────────────────────────────────

// One status or Repairs-stage change, as the list reads it from job_events:
// `status_changed` (update_job_status, detail_json.new_status) and
// `repair_stage_changed` (update_repair_stage, detail_json.to_stage).
export type DispatchBoardStageEvent = {
  job_id?: string | null;
  event_type?: string | null;
  created_at?: string | null;
  ev_status?: string | null;
  ev_stage?: string | null;
};

export const DISPATCH_BOARD_STAGE_EVENT_TYPES = [
  "status_changed",
  "repair_stage_changed",
];

export const DISPATCH_BOARD_STAGE_EVENT_SELECT =
  "id, job_id, event_type, created_at, ev_status:detail_json->>new_status, ev_stage:detail_json->>to_stage";

export type DispatchBoardDaysSource =
  | "status_event"
  | "repair_stage_event"
  | "status_stamp"
  | "unknown";

// When the job came into the stage it is in now: the change that moved it in,
// oldest to newest, so a re-save of the same status does not restart the
// count and a move out and back in does.
function enteredAt(
  events: DispatchBoardStageEvent[],
  valueOf: (event: DispatchBoardStageEvent) => string | null,
  current: string,
): string | null {
  const sorted = [...events].sort((a, b) =>
    String(a.created_at ?? "") < String(b.created_at ?? "") ? -1 : 1
  );
  let previous: string | null = null;
  let since: string | null = null;
  for (const event of sorted) {
    const value = valueOf(event);
    if (value === null) continue;
    if (value === current && previous !== current) {
      since = event.created_at ?? null;
    }
    previous = value;
  }
  return since;
}

export function dispatchBoardStageSince(
  job: DispatchBoardJob,
  stage: DispatchBoardStage,
  events: DispatchBoardStageEvent[],
): { since: string | null; source: DispatchBoardDaysSource } {
  const status = token(job?.status);
  if (stage.track === "repairs") {
    // A stamped stage moved on the Repairs board: its own change events.
    if (token(job?.ds_repair_stage) === stage.key) {
      const since = enteredAt(
        events.filter((e) => e.event_type === "repair_stage_changed"),
        (e) => (e.ev_stage ? token(e.ev_stage) : null),
        stage.key,
      );
      return since
        ? { since, source: "repair_stage_event" }
        : { since: null, source: "unknown" };
    }
    // An unstamped repair reads its stage from the status, so the status
    // changes say when it came in (each mapped to its Repairs stage).
    const since = enteredAt(
      events.filter((e) => e.event_type === "status_changed"),
      (e) =>
        e.ev_status ? insuranceRepairStage({ status: e.ev_status }) : null,
      stage.key,
    );
    return since
      ? { since, source: "status_event" }
      : { since: null, source: "unknown" };
  }
  const since = enteredAt(
    events.filter((e) => e.event_type === "status_changed"),
    (e) => (e.ev_status ? token(e.ev_status) : null),
    status,
  );
  if (since) return { since, source: "status_event" };
  // Scheduled is the one board status with its own stamp on the job.
  if (status === "scheduled" && job?.scheduled_at) {
    return { since: job.scheduled_at, source: "status_stamp" };
  }
  return { since: null, source: "unknown" };
}

// ── Deposit ─────────────────────────────────────────────────────────────────

export type DispatchBoardDeposit = {
  required: boolean;
  paid: boolean | null;
  state: "paid" | "not_paid" | "not_required" | "unknown";
};

// Insurance repairs take no deposit. Every other board job needs one; paid is
// the Ops Dash rule (pipeline's `deposit_paid`: a PAID ACCREC invoice whose
// reference carries DEP). A failed invoice read is `unknown`, never "not paid".
export function dispatchBoardDeposit(
  workType: string,
  invoice: { deposit_paid?: boolean } | null,
  invoicesReadOk: boolean,
): DispatchBoardDeposit {
  if (workType === "repair") {
    return { required: false, paid: null, state: "not_required" };
  }
  if (!invoicesReadOk) return { required: true, paid: null, state: "unknown" };
  const paid = invoice?.deposit_paid === true;
  return { required: true, paid, state: paid ? "paid" : "not_paid" };
}

// ── Moves (the header rail) ─────────────────────────────────────────────────

export type DispatchBoardMoves = {
  // The existing ops-api action the screen calls to move the job.
  action: "update_job_status" | "update_repair_stage";
  // The body field that carries the target stage.
  field: "status" | "stage";
  current: string;
  targets: Array<{
    key: string;
    label: string;
    direction: "forward" | "back";
  }>;
};

// Every other stage in the job's track, forwards and backwards (both ruled
// allowed, with the same confirm). Null for a job past Scheduled: it is moved
// from the Ops Dash, not from Dispatch.
export function dispatchBoardMoves(
  stage: DispatchBoardStage,
): DispatchBoardMoves | null {
  if (stage.phase !== "window") return null;
  const list = dispatchBoardStageList(stage.track);
  return {
    action: stage.track === "repairs"
      ? "update_repair_stage"
      : "update_job_status",
    field: stage.track === "repairs" ? "stage" : "status",
    current: stage.key,
    targets: list
      .filter((entry) => entry.key !== stage.key)
      .map((entry) => ({
        key: entry.key,
        label: entry.label,
        direction: entry.order > stage.order ? "forward" : "back",
      })),
  };
}

// ── The Arrival line ────────────────────────────────────────────────────────

// A supplier box (job_material_suppliers) with the v2 arrival columns
// (migration 20261023160000_dispatch_v2_board_arrival_dates.sql). In v2 one
// supplier box is one order: one email, one delivery date.
export type DispatchBoardSupplierBox = {
  id?: string | null;
  job_id?: string | null;
  supplier_id?: string | null;
  supplier_name?: string | null;
  position?: number | null;
  created_at?: string | null;
  delivery_date?: string | null;
  delivery_date_confirmed_at?: string | null;
  delivery_date_source?: string | null;
  delivery_date_set_at?: string | null;
  delivery_date_set_by_email?: string | null;
  // The material stage a person set (migration
  // 20261028170000_dispatch_v2_material_stages.sql).
  material_stage?: string | null;
  material_stage_set_at?: string | null;
  material_stage_set_by_email?: string | null;
  // Mark paid (migration 20261029120100_dispatch_v2_box_paid.sql).
  paid_at?: string | null;
  paid_by_email?: string | null;
};

export const DISPATCH_BOARD_BOX_SELECT =
  "id, job_id, supplier_id, supplier_name, position, created_at, delivery_date, delivery_date_confirmed_at, delivery_date_source, delivery_date_set_at, delivery_date_set_by_email, material_stage, material_stage_set_at, material_stage_set_by_email, paid_at, paid_by_email";

// The material lines in the boxes, only for the material stage: which lines
// are still to be ordered, and when each last changed.
export const DISPATCH_BOARD_LINE_SELECT =
  "id, job_id, supplier_id, status, dispatch_order_email_id, purchase_order_id, created_at, updated_at";

// The v2 supplier order emails that really went (status sent). A test copy to
// admin@ is never status sent, so it never counts as an order sent. The table
// comes with the supplier order emails slice
// (20261023214200_dispatch_v2_emails_draft_list_and_order_emails.sql).
export const DISPATCH_BOARD_SENT_EMAIL_SELECT =
  "id, job_id, supplier_id, status, sent_at, delivery_date, body_text";

// The account list (on account or pay first): which approved entry each Xero
// supplier is linked to, and each entry's on_account (migration
// 20261029120000_dispatch_v2_on_account_suppliers.sql).
export const DISPATCH_ACCOUNT_LINK_SELECT = "supplier_id, approved_id";
export const DISPATCH_ACCOUNT_ENTRY_SELECT = "id, name, active, on_account";

export type DispatchBoardSentEmail = {
  id?: string | null;
  job_id?: string | null;
  supplier_id?: string | null;
  status?: string | null;
  sent_at?: string | null;
  // The delivery date the email asked for (its Date: line).
  delivery_date?: string | null;
  // The body as sent: its opening line says delivery or pickup.
  body_text?: string | null;
};

// Per supplier on one job: when its order email last went, the date it
// asked for, and whether it was a delivery or a pickup.
export function dispatchBoardSentBySupplier(
  emails: DispatchBoardSentEmail[] | null | undefined,
): Map<
  string,
  {
    sent_at: string;
    requested_date: string | null;
    fulfilment: DispatchV2Fulfilment;
  }
> {
  const bySupplier = new Map<
    string,
    {
      sent_at: string;
      requested_date: string | null;
      fulfilment: DispatchV2Fulfilment;
    }
  >();
  for (const email of emails || []) {
    if (token(email?.status) !== "sent") continue;
    const supplierId = String(email?.supplier_id ?? "");
    const sentAt = text(email?.sent_at);
    if (!supplierId || !sentAt) continue;
    const seen = bySupplier.get(supplierId);
    if (seen && seen.sent_at >= sentAt) continue;
    bySupplier.set(supplierId, {
      sent_at: sentAt,
      requested_date: isDispatchDeliveryDate(email?.delivery_date)
        ? email.delivery_date as string
        : null,
      fulfilment: dispatchV2FulfilmentOf(email?.body_text),
    });
  }
  return bySupplier;
}

// A purchase order on the job (v1 Dispatch orders and orders made elsewhere,
// for example in Xero). No price column.
export const DISPATCH_BOARD_ORDER_SELECT =
  "id, job_id, supplier_id, supplier_name, source, status, po_type, po_number, delivery_date, confirmed_delivery_date, created_at";

// An order's status that says it has gone to the supplier.
const ORDER_SENT_STATUSES = new Set([
  "sent",
  "submitted",
  "authorised",
  "acked",
  "confirmed",
  "delivered",
  "billed",
]);

export type DispatchArrivalMark = "solid" | "ring" | "none";
export type DispatchArrivalFlag =
  | "not_sent"
  | "no_date"
  | "after_install"
  | null;

export type DispatchArrivalOrder = {
  // box:<supplier_id> for a supplier box, po:<id> for an order with no box.
  key: string;
  source: "supplier_box" | "dispatch_order" | "other_order";
  supplier_id: string | null;
  supplier_name: string | null;
  order_sent: boolean;
  sent_at: string | null;
  delivery_date: string | null;
  // Where the date came from: the box (set by hand or from an accepted
  // supplier reply), the date our sent email asked for, or a purchase order.
  date_source: "box" | "requested" | "order" | null;
  date_confirmed: boolean;
  // A supplier box only (null for a purchase order): the box's id (what
  // dispatch_v2_set_delivery_date takes), and how the box's OWN date was set:
  // 'by_hand' (typed by a person) or 'supplier_reply' (Accept on a reply),
  // when and by whom. Null when the box has no date of its own.
  box_id: string | null;
  box_date_source: "by_hand" | "supplier_reply" | null;
  box_date_set_at: string | null;
  box_date_set_by_email: string | null;
  // solid = confirmed date, ring = a date not confirmed, none = no date.
  mark: DispatchArrivalMark;
  // The red cases: no date yet on a sent order, or a date after the install.
  // not_sent is an order still being put together (no red). An extra order
  // and a delivered order never carry a red flag.
  flag: DispatchArrivalFlag;
  // Where the materials are at (dispatch_v2_material_stage.ts): the stage,
  // whether a person set it ('set'), it was worked out from the box
  // ('worked_out') or read from a purchase order's status ('order'), and who
  // set it when a person did.
  material_stage: DispatchMaterialStageKey;
  material_stage_label: string;
  // 'payment' = moved to Order confirmed by Mark paid (contract section 3c).
  material_stage_source: DispatchMaterialStageShown["source"] | "order";
  material_stage_set_at: string | null;
  material_stage_set_by_email: string | null;
  // Who it is waiting on, and the next thing to do in plain words (null once
  // delivered).
  waiting_on: DispatchMaterialWaitingOn;
  todo: string | null;
  // An extra order: ordered (or still to be ordered) on or after the install
  // day, for example a flashing once the crew is on site.
  extra: boolean;
  // Delivery or pickup, from the box's newest sent order email (its opening
  // line). Null for an order not sent from Dispatch, and for a purchase order.
  fulfilment: DispatchV2Fulfilment | null;
  // The box's payment step (dispatch_v2_payment.ts, contract section 3c):
  // its terms (on_account, pay_first, or unknown when the account list read
  // failed), whether it is paid for the current order, and what the screen
  // may offer. Null for a purchase order with no box.
  payment: DispatchV2BoxStage["payment"] | null;
};

export type DispatchArrival = {
  today: string;
  install_day: string | null;
  orders: DispatchArrivalOrder[];
  counts: {
    orders: number;
    sent: number;
    confirmed: number;
    late: number;
    // Orders not delivered yet, those waiting on us, and the extra orders not
    // delivered yet.
    open: number;
    on_us: number;
    extra_open: number;
  };
  // At least one order, every one with a confirmed date on or before the
  // install day (or simply confirmed, with no install booked yet).
  all_confirmed_in_time: boolean;
  // The next thing to do on each order waiting on us, in box order.
  waiting_on_us: string[];
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boxDateSource(
  value: unknown,
): DispatchArrivalOrder["box_date_source"] {
  return value === "by_hand" || value === "supplier_reply" ? value : null;
}

// `shown` is a supplier box's own label, waiting on and next step
// (dispatchV2BoxStage); a purchase order leaves it out and gets them from its
// stage here.
function arrivalEntry(
  base: Omit<
    DispatchArrivalOrder,
    "mark" | "flag" | "material_stage_label" | "waiting_on" | "todo"
  >,
  installDay: string | null,
  shown?: Pick<DispatchV2BoxStage, "label" | "waiting_on" | "todo">,
): DispatchArrivalOrder {
  const mark: DispatchArrivalMark = base.delivery_date
    ? (base.date_confirmed ? "solid" : "ring")
    : "none";
  const delivered = base.material_stage === "delivered";
  let flag: DispatchArrivalFlag = null;
  if (!base.delivery_date) {
    flag = base.order_sent ? (delivered ? null : "no_date") : "not_sent";
  } else if (
    installDay && base.delivery_date > installDay && !base.extra && !delivered
  ) {
    flag = "after_install";
  }
  const installBooked = !!installDay;
  if (shown) {
    return {
      ...base,
      mark,
      flag,
      material_stage_label: shown.label,
      waiting_on: shown.waiting_on,
      todo: shown.todo,
    };
  }
  return {
    ...base,
    mark,
    flag,
    material_stage_label: dispatchMaterialStageLabel(base.material_stage),
    waiting_on: dispatchMaterialWaitingOn(base.material_stage, installBooked),
    todo: dispatchMaterialTodo(
      base.material_stage,
      base.supplier_name,
      installBooked,
    ),
  };
}

// Whether an order is an extra: its newest send (or, not sent yet, today) is
// on or after the install's first day. No install booked = never extra.
function isExtraOrder(
  installDay: string | null,
  today: string,
  lastSentAt: unknown,
  stillToOrder: boolean,
): boolean {
  if (!installDay) return false;
  const sentDay = perthDayOf(lastSentAt);
  if (stillToOrder) return today >= installDay;
  return !!sentDay && sentDay >= installDay;
}

function oldestFirst(a: any, b: any): number {
  const at = String(a?.created_at ?? "");
  const bt = String(b?.created_at ?? "");
  if (at !== bt) return at < bt ? -1 : 1;
  return String(a?.id ?? "") < String(b?.id ?? "") ? -1 : 1;
}

// The Arrival line for one job: one entry per supplier box (in box order),
// then one per material order that sits under no box. A box's order is sent
// when its v2 order email went (`sentEmails`); its date is the box's own
// date, else the date that email asked for (never confirmed), else a v1
// Dispatch order for the same supplier, so a v1 order still draws. A box date
// set before the box's newest send belongs to an earlier order (an extra
// order went since), so that send's asked-for date shows instead.
//
// Each entry also carries its material stage (dispatch_v2_material_stage.ts),
// worked out from the box, its sends and `lines` (the job's material lines),
// by the same dispatchV2BoxStage the materials panel calls. `accounts` is the
// account list (dispatch_v2_payment.ts); left out or null = not read, every
// box's terms are "unknown".
export function dispatchArrival(
  input: {
    boxes: DispatchBoardSupplierBox[];
    orders: any[];
    sentEmails?: DispatchBoardSentEmail[];
    lines?: any[];
    installDay: string | null;
    today: string;
    accounts?: DispatchV2Accounts | null;
  },
): DispatchArrival {
  const installDay = input.installDay;
  const orders = (input.orders || [])
    .filter(isDispatchDeliveryCounted)
    .sort(oldestFirst);
  const boxes = [...(input.boxes || [])].sort((a, b) =>
    (a.position ?? 0) - (b.position ?? 0) || oldestFirst(a, b)
  );
  const used = new Set<string>();
  const entries: DispatchArrivalOrder[] = [];

  for (const box of boxes) {
    const supplierId = text(box.supplier_id);
    if (!supplierId) continue;
    const v1 = orders.find((o) =>
      o.source === "dispatch" && String(o.supplier_id ?? "") === supplierId &&
      !used.has(String(o.id))
    );
    if (v1) used.add(String(v1.id));
    const view = dispatchV2BoxStage({
      box,
      emails: input.sentEmails,
      lines: input.lines,
      terms: dispatchV2TermsFor(input.accounts, supplierId),
      installDay,
    });
    const sent = view.newest_sent;
    const boxDate = view.box_date;
    const v1Date = text(v1?.confirmed_delivery_date) ||
      text(v1?.delivery_date);
    let deliveryDate: string | null = null;
    let dateSource: DispatchArrivalOrder["date_source"] = null;
    let dateConfirmed = false;
    if (boxDate) {
      deliveryDate = boxDate;
      dateSource = "box";
      dateConfirmed = view.box_date_confirmed;
    } else if (sent?.requested_date) {
      deliveryDate = sent.requested_date;
      dateSource = "requested";
    } else if (v1Date) {
      deliveryDate = v1Date.slice(0, 10);
      dateSource = "order";
      dateConfirmed = !!text(v1?.confirmed_delivery_date);
    }
    const sentByOrder = v1
      ? ORDER_SENT_STATUSES.has(token(v1.status))
      : false;
    const unsent = view.unsent_line_changes;
    entries.push(arrivalEntry({
      key: `box:${supplierId}`,
      source: "supplier_box",
      supplier_id: supplierId,
      supplier_name: text(box.supplier_name),
      order_sent: !!sent || sentByOrder,
      sent_at: sent?.sent_at ?? null,
      delivery_date: deliveryDate,
      date_source: dateSource,
      date_confirmed: dateConfirmed,
      box_id: text(box.id),
      box_date_source: boxDate ? boxDateSource(box.delivery_date_source) : null,
      box_date_set_at: boxDate ? text(box.delivery_date_set_at) : null,
      box_date_set_by_email: boxDate
        ? text(box.delivery_date_set_by_email)
        : null,
      fulfilment: sent?.fulfilment ?? null,
      material_stage: view.key,
      material_stage_source: view.source,
      material_stage_set_at: view.set_at,
      material_stage_set_by_email: view.set_by_email,
      extra: isExtraOrder(
        installDay,
        input.today,
        sent?.sent_at ?? null,
        view.key === "order_materials" && unsent.length > 0,
      ),
      payment: view.payment,
    }, installDay, view));
  }

  for (const order of orders) {
    if (used.has(String(order.id))) continue;
    const confirmed = text(order.confirmed_delivery_date);
    const expected = text(order.delivery_date);
    const date = confirmed || expected;
    entries.push(arrivalEntry({
      key: `po:${order.id}`,
      source: order.source === "dispatch" ? "dispatch_order" : "other_order",
      supplier_id: text(order.supplier_id),
      supplier_name: text(order.supplier_name),
      order_sent: ORDER_SENT_STATUSES.has(token(order.status)),
      sent_at: null,
      delivery_date: date ? date.slice(0, 10) : null,
      date_source: date ? "order" : null,
      date_confirmed: !!confirmed,
      box_id: null,
      box_date_source: null,
      box_date_set_at: null,
      box_date_set_by_email: null,
      fulfilment: null,
      material_stage: dispatchPoMaterialStage(order.status),
      material_stage_source: "order",
      material_stage_set_at: null,
      material_stage_set_by_email: null,
      // A purchase order is an extra when it was made on or after the
      // install's first day.
      extra: !!installDay && (perthDayOf(order.created_at) ?? "") >= installDay,
      payment: null,
    }, installDay));
  }

  const confirmed = entries.filter((e) => e.date_confirmed);
  const open = entries.filter((e) => e.material_stage !== "delivered");
  const onUs = entries.filter((e) => e.waiting_on === "us");
  return {
    today: input.today,
    install_day: installDay,
    orders: entries,
    counts: {
      orders: entries.length,
      sent: entries.filter((e) => e.order_sent).length,
      confirmed: confirmed.length,
      late: entries.filter((e) =>
        e.flag === "no_date" || e.flag === "after_install"
      ).length,
      open: open.length,
      on_us: onUs.length,
      extra_open: open.filter((e) => e.extra).length,
    },
    all_confirmed_in_time: entries.length > 0 &&
      entries.every((e) =>
        e.date_confirmed && e.flag !== "after_install"
      ),
    waiting_on_us: onUs.map((e) => e.todo).filter((t): t is string => !!t),
  };
}

// ── One board row ───────────────────────────────────────────────────────────

export type DispatchBoardRow = {
  view: DispatchBoardView;
  track: DispatchBoardTrack;
  stage_key: string;
  stage_label: string;
  stage_order: number;
  stage_phase: "window" | "after";
  real_status: string | null;
  repair_stage: string | null;
  title: string;
  job_number: string | null;
  client_name: string | null;
  suburb: string | null;
  work_type: string;
  days_in_stage: number | null;
  in_stage_since: string | null;
  days_in_stage_source: DispatchBoardDaysSource;
  install: DispatchBoardInstall | null;
  deposit: DispatchBoardDeposit;
  flags: {
    deposit_not_paid: boolean;
    no_install_booked: boolean;
    install_date_passed: boolean;
  };
  moves: DispatchBoardMoves | null;
  arrival: DispatchArrival | null;
  // Whether the card is waiting on us, and what to do, in plain words: the
  // job's own step (order the materials, book the install) then each order's.
  waiting: DispatchBoardWaiting;
};

export type DispatchBoardWaiting = {
  on_us: boolean;
  todo: string[];
};

// What a card is waiting on us for. The job's own step comes first: Order
// Materials (or a repair's Materials) with nothing ordered yet, and Schedule
// Install. Then each supplier order waiting on us. With no Arrival line (its
// read failed) only the job's own step is known.
export function dispatchBoardWaiting(
  stage: DispatchBoardStage,
  arrival: DispatchArrival | null,
): DispatchBoardWaiting {
  const todo: string[] = [];
  const ordersStep = (stage.track === "pipeline" &&
    stage.key === "order_materials") ||
    (stage.track === "repairs" && stage.key === "materials");
  if (ordersStep && arrival && arrival.counts.orders === 0) {
    todo.push("Order the materials");
  }
  if (stage.track === "pipeline" && stage.key === "schedule_install") {
    todo.push("Book the install");
  }
  if (arrival) todo.push(...arrival.waiting_on_us);
  return { on_us: todo.length > 0, todo };
}

export type DispatchBoardContext = {
  view: DispatchBoardView;
  today: string;
  now: Date;
  searching: boolean;
  // Install bookings by job id; null when the bookings read failed.
  bookingsByJob: Map<string, DispatchInstallBooking[]> | null;
  // Stage change events by job id; null when that read failed.
  eventsByJob: Map<string, DispatchBoardStageEvent[]> | null;
  invoicesReadOk: boolean;
  // Arrival inputs by job id; null when any of the three reads failed.
  boxesByJob: Map<string, DispatchBoardSupplierBox[]> | null;
  ordersByJob: Map<string, any[]> | null;
  sentByJob: Map<string, DispatchBoardSentEmail[]> | null;
  // The boxes' material lines by job id (the material stage); null or left
  // out = no lines.
  linesByJob?: Map<string, any[]> | null;
  // The account list (dispatch_v2_payment.ts); null or left out = not read,
  // every box's terms are "unknown".
  accounts?: DispatchV2Accounts | null;
};

// The board fields of one job for the view asked for, or null when the job is
// not on that view. `invoice` is pipeline's own deposit figures for the row.
export function dispatchBoardRow(
  job: DispatchBoardJob,
  invoice: { deposit_paid?: boolean } | null,
  ctx: DispatchBoardContext,
): DispatchBoardRow | null {
  const stage = dispatchBoardStage(job);
  if (!stage) return null;
  const id = String(job?.id ?? "");
  const install = ctx.bookingsByJob
    ? dispatchBoardInstall(ctx.bookingsByJob.get(id), ctx.today)
    : null;
  const placement = dispatchBoardPlacement(stage, install);
  if (placement !== ctx.view) return null;
  if (
    placement === "archive" &&
    !dispatchBoardInArchiveWindow(install, ctx.today, ctx.searching)
  ) {
    return null;
  }

  const workType = dispatchWorkType(job);
  const { since, source } = ctx.eventsByJob
    ? dispatchBoardStageSince(job, stage, ctx.eventsByJob.get(id) || [])
    : { since: null, source: "unknown" as const };
  const sinceDay = perthDayOf(since);
  const deposit = dispatchBoardDeposit(workType, invoice, ctx.invoicesReadOk);
  const jobNumber = text(job?.job_number);
  const clientName = text(job?.client_name);
  const arrival = ctx.boxesByJob && ctx.ordersByJob && ctx.sentByJob
    ? dispatchArrival({
      boxes: ctx.boxesByJob.get(id) || [],
      orders: ctx.ordersByJob.get(id) || [],
      sentEmails: ctx.sentByJob.get(id) || [],
      lines: ctx.linesByJob?.get(id) || [],
      installDay: install?.day ?? null,
      today: ctx.today,
      accounts: ctx.accounts ?? null,
    })
    : null;

  return {
    view: placement,
    track: stage.track,
    stage_key: stage.key,
    stage_label: stage.label,
    stage_order: stage.order,
    stage_phase: stage.phase,
    real_status: text(job?.status),
    repair_stage: stage.track === "repairs" ? stage.key : null,
    title: [jobNumber, clientName].filter(Boolean).join(" · "),
    job_number: jobNumber,
    client_name: clientName,
    suburb: text(job?.site_suburb),
    work_type: workType,
    days_in_stage: sinceDay
      ? Math.max(0, daysBetween(sinceDay, ctx.today))
      : null,
    in_stage_since: since,
    days_in_stage_source: source,
    install,
    deposit,
    flags: {
      deposit_not_paid: deposit.state === "not_paid",
      // Amber "No install booked": a Scheduled job with nothing booked. A
      // failed bookings read never raises it.
      no_install_booked: stage.key === "scheduled" && stage.phase === "window" &&
        install !== null && !install.booked,
      // Never on In Progress or Rectification: the crew has been, so a day
      // gone by is expected there.
      install_date_passed: stage.phase === "window" &&
        stage.key !== "scheduled" && !isOnSiteStage(stage) &&
        !!install?.passed,
    },
    moves: dispatchBoardMoves(stage),
    arrival,
    waiting: dispatchBoardWaiting(stage, arrival),
  };
}

// ── The board summary (top level of the answer) ────────────────────────────

export type DispatchBoardGroup = {
  key: string;
  track: DispatchBoardTrack | "archive";
  label: string;
  count: number;
  job_ids: string[];
};

export type DispatchBoardReads = {
  installs: "ok" | "failed";
  days_in_stage: "ok" | "failed";
  deposits: "ok" | "failed";
  arrival: "ok" | "failed";
  // The account list (on account or pay first). Failed = every box's terms
  // are "unknown": no payment gate, no reply move (contract section 3c).
  accounts: "ok" | "failed";
};

function byNumber(a: any, b: any): number {
  const an = String(a?.board?.job_number ?? "");
  const bn = String(b?.board?.job_number ?? "");
  return an < bn ? -1 : an > bn ? 1 : 0;
}

// Active: one group per stage in pipeline order, then the two repair groups,
// every group present even when empty. Scheduled groups sort by install day
// (soonest first, nothing booked last); the others by days in stage (longest
// waiting first). Archive: one group, most recent install first.
export function dispatchBoardGroups(
  rows: any[],
  view: DispatchBoardView,
): DispatchBoardGroup[] {
  if (view === "archive") {
    const sorted = [...rows].sort((a, b) => {
      const ad = String(a?.board?.install?.last_day ?? "");
      const bd = String(b?.board?.install?.last_day ?? "");
      if (ad !== bd) return ad < bd ? 1 : -1;
      return byNumber(a, b);
    });
    return [{
      key: "archive",
      track: "archive",
      label: "Archive",
      count: sorted.length,
      job_ids: sorted.map((row) => String(row.id)),
    }];
  }
  const groups: DispatchBoardGroup[] = [];
  for (const track of ["pipeline", "repairs"] as DispatchBoardTrack[]) {
    for (const stage of dispatchBoardStageList(track)) {
      const inGroup = rows.filter((row) =>
        row?.board?.track === track && row?.board?.stage_key === stage.key
      );
      inGroup.sort((a, b) => {
        if (stage.key === "scheduled") {
          const ad = a?.board?.install?.day ?? "9999-12-31";
          const bd = b?.board?.install?.day ?? "9999-12-31";
          if (ad !== bd) return ad < bd ? -1 : 1;
        } else {
          const ad = a?.board?.days_in_stage ?? -1;
          const bd = b?.board?.days_in_stage ?? -1;
          if (ad !== bd) return bd - ad;
        }
        return byNumber(a, b);
      });
      groups.push({
        key: track === "repairs" ? `repair_${stage.key}` : stage.key,
        track,
        label: track === "repairs" ? `Repairs: ${stage.label}` : stage.label,
        count: inGroup.length,
        job_ids: inGroup.map((row) => String(row.id)),
      });
    }
  }
  return groups;
}

export function dispatchBoardSummary(
  rows: any[],
  request: DispatchBoardRequest,
  today: string,
  searching: boolean,
  reads: DispatchBoardReads,
) {
  return {
    version: DISPATCH_BOARD_V2,
    view: request.view,
    today,
    searching,
    archive_days: DISPATCH_BOARD_ARCHIVE_DAYS,
    // The oldest last install day Archive shows without a search.
    archive_from: searching
      ? null
      : addDays(today, -DISPATCH_BOARD_ARCHIVE_DAYS),
    stages: {
      pipeline: dispatchBoardStageList("pipeline"),
      repairs: dispatchBoardStageList("repairs"),
    },
    reads,
    groups: dispatchBoardGroups(rows, request.view),
    total: rows.length,
    // Cards waiting on us (the board's Waiting on us filter).
    waiting_on_us: rows.filter((row) => row?.board?.waiting?.on_us === true)
      .length,
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

type ReadResult<T> = { data: T[]; error: unknown | null };

async function safeRead<T>(read: () => Promise<T[]>): Promise<ReadResult<T>> {
  try {
    return { data: await read(), error: null };
  } catch (error) {
    return { data: [], error };
  }
}

function groupByJob<T extends { job_id?: string | null }>(
  rows: T[],
): Map<string, T[]> {
  const byJob = new Map<string, T[]>();
  for (const row of rows || []) {
    const key = String(row?.job_id ?? "");
    if (!key) continue;
    const list = byJob.get(key);
    if (list) list.push(row);
    else byJob.set(key, [row]);
  }
  return byJob;
}

// The Archive view's narrowing read, before the job read: the jobs with an
// install booking dated inside the window (plus the lookback) and before
// today. Null when the list would be too long to send as an id filter, or the
// read failed: the job read then reads every accepted job, and the pure rule
// still makes the cut.
export async function loadDispatchBoardArchiveCandidates(
  client: any,
  today: string,
): Promise<string[] | null> {
  const from = addDays(
    today,
    -(DISPATCH_BOARD_ARCHIVE_DAYS + DISPATCH_BOARD_ARCHIVE_LOOKBACK_DAYS),
  );
  try {
    const rows = await fetchAllRows<any>(
      () =>
        client.from("job_assignments")
          .select("id, job_id, status")
          .eq("assignment_type", "install")
          .gte("scheduled_date", from)
          .lt("scheduled_date", today),
      "pipeline.dispatch_board_archive",
      "id",
    );
    const ids = new Set<string>();
    for (const row of rows) {
      if (token(row?.status) === "cancelled") continue;
      if (row?.job_id) ids.add(String(row.job_id));
    }
    if (ids.size > DISPATCH_BOARD_ARCHIVE_ID_LIMIT) return null;
    return [...ids];
  } catch (error) {
    console.error(
      "[pipeline] dispatch board archive candidates read failed:",
      (error as Error)?.message ?? error,
    );
    return null;
  }
}

export type DispatchBoardExtras = {
  events: ReadResult<DispatchBoardStageEvent>;
  boxes: ReadResult<DispatchBoardSupplierBox>;
  orders: ReadResult<any>;
  sent: ReadResult<DispatchBoardSentEmail>;
  // Left out = no lines (stages read from the boxes and sends only).
  lines?: ReadResult<any>;
  // The account list's two reads (dispatch_v2_payment.ts). Left out = not
  // read (terms unknown).
  accountLinks?: ReadResult<any>;
  accountEntries?: ReadResult<any>;
};

// The reads only the v2 board makes, for the jobs the list read returned:
// stage change events (days in stage), and supplier boxes, orders, sent order
// emails and material lines (the Arrival line and its material stages), and
// the account list (on account or pay first, the whole organisation's: about
// 26 entries). Each fails on its own and never rejects.
export async function loadDispatchBoardExtras(
  client: any,
  jobIds: string[],
  orgId?: string,
): Promise<DispatchBoardExtras> {
  const ids = jobIds.map((id) => String(id));
  const [accountLinks, accountEntries] = loadDispatchAccountList(
    client,
    orgId,
    "pipeline.dispatch_board",
  );
  const [events, boxes, orders, sent, lines] = await Promise.all([
    safeRead<DispatchBoardStageEvent>(() =>
      fetchAllRowsInChunks<DispatchBoardStageEvent>(
        ids,
        (chunk) =>
          client.from("job_events")
            .select(DISPATCH_BOARD_STAGE_EVENT_SELECT)
            .in("job_id", chunk)
            .in("event_type", DISPATCH_BOARD_STAGE_EVENT_TYPES),
        "pipeline.dispatch_board_events",
        "id",
      )
    ),
    safeRead<DispatchBoardSupplierBox>(() =>
      fetchAllRowsInChunks<DispatchBoardSupplierBox>(
        ids,
        (chunk) =>
          client.from("job_material_suppliers")
            .select(DISPATCH_BOARD_BOX_SELECT)
            .in("job_id", chunk),
        "pipeline.dispatch_board_boxes",
        "id",
      )
    ),
    safeRead<any>(() =>
      fetchAllRowsInChunks<any>(
        ids,
        (chunk) =>
          client.from("purchase_orders")
            .select(DISPATCH_BOARD_ORDER_SELECT)
            .in("job_id", chunk),
        "pipeline.dispatch_board_orders",
        "id",
      )
    ),
    safeRead<DispatchBoardSentEmail>(() =>
      fetchAllRowsInChunks<DispatchBoardSentEmail>(
        ids,
        (chunk) =>
          client.from("dispatch_supplier_order_emails")
            .select(DISPATCH_BOARD_SENT_EMAIL_SELECT)
            .in("job_id", chunk)
            .eq("status", "sent"),
        "pipeline.dispatch_board_sent_emails",
        "id",
      )
    ),
    safeRead<any>(() =>
      fetchAllRowsInChunks<any>(
        ids,
        (chunk) =>
          client.from("job_material_lines")
            .select(DISPATCH_BOARD_LINE_SELECT)
            .in("job_id", chunk),
        "pipeline.dispatch_board_lines",
        "id",
      )
    ),
  ]);
  for (
    const [label, result] of [
      ["job_events", events],
      ["job_material_suppliers", boxes],
      ["purchase_orders", orders],
      ["dispatch_supplier_order_emails", sent],
      ["job_material_lines", lines],
    ] as const
  ) {
    if (result.error) {
      console.error(
        `[pipeline] dispatch board ${label} read failed:`,
        (result.error as Error)?.message ?? result.error,
      );
    }
  }
  return {
    events,
    boxes,
    orders,
    sent,
    lines,
    accountLinks: await accountLinks,
    accountEntries: await accountEntries,
  };
}

// The account list's two reads (links and entries), started together; each
// fails on its own and never rejects. Logged here, so callers only look.
function loadDispatchAccountList(
  client: any,
  orgId: string | undefined,
  label: string,
): [Promise<ReadResult<any>>, Promise<ReadResult<any>>] {
  const logged = (name: string, read: Promise<ReadResult<any>>) =>
    read.then((result) => {
      if (result.error) {
        console.error(
          `[dispatch] ${label} ${name} read failed:`,
          (result.error as Error)?.message ?? result.error,
        );
      }
      return result;
    });
  const scoped = (query: any) => orgId ? query.eq("org_id", orgId) : query;
  return [
    logged(
      "dispatch_approved_supplier_email_links",
      safeRead<any>(() =>
        fetchAllRows<any>(
          () =>
            scoped(
              client.from("dispatch_approved_supplier_email_links")
                .select(DISPATCH_ACCOUNT_LINK_SELECT),
            ),
          `${label}_account_links`,
          "supplier_id",
        )
      ),
    ),
    logged(
      "dispatch_approved_supplier_emails",
      safeRead<any>(() =>
        fetchAllRows<any>(
          () =>
            scoped(
              client.from("dispatch_approved_supplier_emails")
                .select(DISPATCH_ACCOUNT_ENTRY_SELECT),
            ),
          `${label}_account_entries`,
          "id",
        )
      ),
    ),
  ];
}

// The account list as the payment rules take it; null data when either read
// failed (dispatchV2AccountsOf then says the read failed).
function accountsFrom(
  links: ReadResult<any> | undefined,
  entries: ReadResult<any> | undefined,
): DispatchV2Accounts | null {
  if (!links || !entries) return null;
  return dispatchV2AccountsOf(
    links.error ? null : links.data,
    entries.error ? null : entries.data,
  );
}

// Apply the board to the list's rows: keep the rows on the view asked for,
// each with its `board` object. `rawById` is the job read's own rows (with the
// `ds_` aliases the list strips); `bookings` is the list's assignment read
// (null when it failed).
export function applyDispatchBoard(
  rows: any[],
  rawById: Map<string, any>,
  input: {
    request: DispatchBoardRequest;
    today: string;
    now: Date;
    searching: boolean;
    bookings: DispatchInstallBooking[] | null;
    invoicesReadOk: boolean;
    extras: DispatchBoardExtras;
  },
): { rows: any[]; summary: ReturnType<typeof dispatchBoardSummary> } {
  const { extras } = input;
  const arrivalOk = !extras.boxes.error && !extras.orders.error &&
    !extras.sent.error && !extras.lines?.error;
  const accounts = accountsFrom(extras.accountLinks, extras.accountEntries);
  const ctx: DispatchBoardContext = {
    view: input.request.view,
    today: input.today,
    now: input.now,
    searching: input.searching,
    bookingsByJob: input.bookings
      ? dispatchInstallBookingsByJob(input.bookings)
      : null,
    eventsByJob: extras.events.error ? null : groupByJob(extras.events.data),
    invoicesReadOk: input.invoicesReadOk,
    boxesByJob: arrivalOk ? groupByJob(extras.boxes.data) : null,
    ordersByJob: arrivalOk ? groupByJob(extras.orders.data) : null,
    sentByJob: arrivalOk ? groupByJob(extras.sent.data) : null,
    linesByJob: arrivalOk ? groupByJob(extras.lines?.data || []) : null,
    accounts,
  };
  const kept: any[] = [];
  for (const row of rows) {
    const raw = rawById.get(String(row?.id)) || row;
    const board = dispatchBoardRow(raw, row, ctx);
    if (board) kept.push({ ...row, board });
  }
  const summary = dispatchBoardSummary(
    kept,
    input.request,
    input.today,
    input.searching,
    {
      installs: input.bookings ? "ok" : "failed",
      days_in_stage: extras.events.error ? "failed" : "ok",
      deposits: input.invoicesReadOk ? "ok" : "failed",
      arrival: arrivalOk ? "ok" : "failed",
      accounts: accounts?.readOk ? "ok" : "failed",
    },
  );
  return { rows: kept, summary };
}

// The answer for a board read that found no job.
export function emptyDispatchBoardSummary(
  request: DispatchBoardRequest,
  today: string,
  searching: boolean,
) {
  return dispatchBoardSummary([], request, today, searching, {
    installs: "ok",
    days_in_stage: "ok",
    deposits: "ok",
    arrival: "ok",
    accounts: "ok",
  });
}

// ── dispatch_arrival: one job's Arrival line and install ────────────────────

export class DispatchArrivalError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.body = { error: message, code };
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A pure read. The job's install (from its install bookings) and its Arrival
// line. Refuses a missing or malformed id with 400 before any query, an
// unknown job with 404, and a job that is not Dispatch work (make-safe and
// the other types) with 409.
export async function dispatchArrivalRead(
  client: any,
  jobIdParam: string | null,
  orgId: string,
  today: string,
) {
  const jobId = String(jobIdParam ?? "").trim();
  if (!jobId) {
    throw new DispatchArrivalError("job_id required", 400, "invalid_request");
  }
  if (!UUID_RE.test(jobId)) {
    throw new DispatchArrivalError(
      "job_id must be a job id",
      400,
      "invalid_request",
    );
  }
  const { data: job, error: jobError } = await client.from("jobs")
    .select(
      "id, type, status, job_number, client_name, site_suburb, ds_ses_family:metadata->>ses_family, ds_makesafe_family:metadata->>makesafe_job_family, ds_repair_stage:metadata->>repair_stage",
    )
    .eq("id", jobId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (jobError) throw jobError;
  if (!job) {
    throw new DispatchArrivalError(`Job ${jobId} not found`, 404, "not_found");
  }
  const workType = dispatchWorkType(job);
  if (!DISPATCH_BOARD_WORK_TYPES.includes(workType)) {
    throw new DispatchArrivalError(
      "This job is not Dispatch work",
      409,
      "not_dispatch_work",
    );
  }
  const [accountLinks, accountEntries] = loadDispatchAccountList(
    client,
    orgId,
    "dispatch_arrival",
  );
  const [bookings, boxes, orders, sent, lines] = await Promise.all([
    safeRead<DispatchInstallBooking>(() =>
      fetchAllRows<DispatchInstallBooking>(
        () =>
          client.from("job_assignments")
            .select(
              "id, job_id, scheduled_date, scheduled_end, assignment_type, status, is_ghost, role, confirmation_status",
            )
            .eq("job_id", jobId),
        "dispatch_arrival.bookings",
        "id",
      )
    ),
    safeRead<DispatchBoardSupplierBox>(() =>
      fetchAllRows<DispatchBoardSupplierBox>(
        () =>
          client.from("job_material_suppliers")
            .select(DISPATCH_BOARD_BOX_SELECT)
            .eq("job_id", jobId),
        "dispatch_arrival.boxes",
        "id",
      )
    ),
    safeRead<any>(() =>
      fetchAllRows<any>(
        () =>
          client.from("purchase_orders")
            .select(DISPATCH_BOARD_ORDER_SELECT)
            .eq("job_id", jobId),
        "dispatch_arrival.orders",
        "id",
      )
    ),
    safeRead<DispatchBoardSentEmail>(() =>
      fetchAllRows<DispatchBoardSentEmail>(
        () =>
          client.from("dispatch_supplier_order_emails")
            .select(DISPATCH_BOARD_SENT_EMAIL_SELECT)
            .eq("job_id", jobId)
            .eq("status", "sent"),
        "dispatch_arrival.sent_emails",
        "id",
      )
    ),
    safeRead<any>(() =>
      fetchAllRows<any>(
        () =>
          client.from("job_material_lines")
            .select(DISPATCH_BOARD_LINE_SELECT)
            .eq("job_id", jobId),
        "dispatch_arrival.lines",
        "id",
      )
    ),
  ]);
  const install = bookings.error
    ? null
    : dispatchBoardInstall(bookings.data, today);
  const arrivalOk = !boxes.error && !orders.error && !sent.error &&
    !lines.error;
  const stage = dispatchBoardStage(job);
  const accounts = accountsFrom(await accountLinks, await accountEntries);
  const arrival = arrivalOk
    ? dispatchArrival({
      boxes: boxes.data,
      orders: orders.data,
      sentEmails: sent.data,
      lines: lines.data,
      installDay: install?.day ?? null,
      today,
      accounts,
    })
    : null;
  return {
    job_id: jobId,
    job_number: job.job_number ?? null,
    work_type: workType,
    stage,
    install,
    installs: bookings.error ? "failed" : "ok",
    arrival,
    arrival_read: arrivalOk ? "ok" : "failed",
    // The account list (on account or pay first): failed = every box's
    // payment terms are "unknown" (contract section 3c).
    accounts_read: accounts?.readOk ? "ok" : "failed",
    // What the job is waiting on us for (null when it is not on the board).
    waiting: stage ? dispatchBoardWaiting(stage, arrival) : null,
  };
}
