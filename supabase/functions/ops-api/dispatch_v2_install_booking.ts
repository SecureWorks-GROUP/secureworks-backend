// deno-lint-ignore-file no-explicit-any
// Dispatch v2: Book install from the job's Install row (item 4 on the
// Go-or-Park page, picture approved by Shaun 16 Nov 2026: "i like it all").
// Contract: docs/dispatch-v2-board-contract.md, section 3h.
//
// What the presses do, in business words:
//   * Book install books the crew TENTATIVE and texts nobody. One booking row
//     per person per working day (weekends skipped), each one day long, so
//     the Calendar shows exactly what the Calendar's own booking makes.
//   * Confirm locks every tentative install booking (the Calendar's
//     confirm_assignment, client NOT texted) and then texts each crew member
//     once "New job assigned", with their own days, from +61489267771.
//   * Move shifts the whole booking, every day and every person together
//     (the Calendar's reschedule_job_bookings, one transaction). A booking
//     that was confirmed goes back to tentative, as the Calendar's
//     "Reschedule confirmed job" does, so Confirm can text the new days.
//     Nobody is texted by the move itself.
//   * Remove takes every install booking off (the Calendar's
//     delete_assignment, one per row). An invoiced booking is never removed.
//
// Every write goes through the Calendar's own ops-api functions
// (createAssignment, confirmAssignment, rescheduleJobBookings,
// updateAssignment, deleteAssignment), handed in as deps, so ghost observer
// rows, scheduled_end, crew_name, job_events, business_events and the GHL
// push are the same as a Calendar booking.
//
// What this never does: move the job's stage or status (create_assignment's
// old accepted -> processing step is switched off with keep_job_status),
// text the client, warn about clashes or check materials.

import { dispatchWorkType } from "./dispatch_job_list.ts";
import { DISPATCH_BOARD_WORK_TYPES } from "./dispatch_board.ts";
import { isDispatchInstallBooking } from "./dispatch_install.ts";

export const DISPATCH_V2_INSTALL_READ_ACTION = "dispatch_v2_install";
export const DISPATCH_V2_INSTALL_BOOK_ACTION = "dispatch_v2_install_book";
export const DISPATCH_V2_INSTALL_CONFIRM_ACTION = "dispatch_v2_install_confirm";
export const DISPATCH_V2_INSTALL_MOVE_ACTION = "dispatch_v2_install_move";
export const DISPATCH_V2_INSTALL_REMOVE_ACTION = "dispatch_v2_install_remove";
export const DISPATCH_V2_INSTALL_ACTIONS = [
  DISPATCH_V2_INSTALL_READ_ACTION,
  DISPATCH_V2_INSTALL_BOOK_ACTION,
  DISPATCH_V2_INSTALL_CONFIRM_ACTION,
  DISPATCH_V2_INSTALL_MOVE_ACTION,
  DISPATCH_V2_INSTALL_REMOVE_ACTION,
] as const;

/** The most working days one press books. */
export const DISPATCH_INSTALL_MAX_DAYS = 20;
/** The most people one press books (lead plus helpers). */
export const DISPATCH_INSTALL_MAX_PEOPLE = 8;
/** Every crew text goes from SecureWorks Group Admin (OPS.md). */
export const DISPATCH_INSTALL_SMS_FROM = "+61489267771";

const TRADE_JOB_URL =
  "https://secureworks-group.github.io/secureworks-ux/trade.html#job/";

export const DISPATCH_INSTALL_JOB_SELECT =
  "id, type, status, job_number, client_name, site_address, site_suburb, ds_ses_family:metadata->>ses_family, ds_makesafe_family:metadata->>makesafe_job_family, ds_repair_stage:metadata->>repair_stage";
export const DISPATCH_INSTALL_BOOKING_SELECT =
  "id, job_id, user_id, crew_name, role, status, assignment_type, is_ghost, scheduled_date, scheduled_end, confirmation_status, created_at, crew_notified_at";

export class DispatchInstallError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(
    status: number,
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = status;
    this.body = { error: message, code, ...extra };
  }
}

function refuse(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): never {
  throw new DispatchInstallError(status, code, message, extra);
}

export type DispatchInstallJob = {
  id: string;
  type?: string | null;
  status?: string | null;
  job_number?: string | null;
  client_name?: string | null;
  site_address?: string | null;
  site_suburb?: string | null;
  ds_ses_family?: string | null;
  ds_makesafe_family?: string | null;
  ds_repair_stage?: string | null;
};

export type DispatchInstallRow = {
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
  confirmation_status?: string | null;
  created_at?: string | null;
  crew_notified_at?: string | null;
};

export type DispatchInstallUser = {
  id: string;
  name?: string | null;
  phone?: string | null;
};

/** Everything the presses touch, handed in so tests need no database. */
export type DispatchInstallDeps = {
  readJob: (jobId: string) => Promise<DispatchInstallJob | null>;
  readBookings: (jobId: string) => Promise<DispatchInstallRow[]>;
  readUsers: (ids: string[]) => Promise<DispatchInstallUser[]>;
  /** ops-api createAssignment (the Calendar's create_assignment). */
  createAssignment: (body: Record<string, unknown>) => Promise<any>;
  /** ops-api confirmAssignment (the Calendar's confirm_assignment). */
  confirmAssignment: (body: Record<string, unknown>) => Promise<any>;
  /** ops-api updateAssignment (the Calendar's update_assignment). */
  updateAssignment: (body: Record<string, unknown>) => Promise<any>;
  /** ops-api deleteAssignment (the Calendar's delete_assignment). */
  deleteAssignment: (body: Record<string, unknown>) => Promise<any>;
  /** ops-api rescheduleJobBookings (the Calendar's whole-job move). */
  rescheduleJobBookings: (body: Record<string, unknown>) => Promise<any>;
  /** One crew text; true when the provider took it. Never throws. */
  sendCrewText: (
    phone: string,
    message: string,
    jobId: string,
  ) => Promise<boolean>;
  /** Stamps crew_notified_at on the rows a text went out for. */
  markCrewNotified: (ids: string[], at: string) => Promise<void>;
  now?: () => string;
};

export type DispatchInstallContext = {
  operatorEmail: string | null;
  operatorUserId: string | null;
};

// ── Dates ───────────────────────────────────────────────────────────────────

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DAY.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(t) &&
    new Date(t).toISOString().slice(0, 10) === value;
}

function addDays(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function isWeekend(day: string): boolean {
  const dow = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/** The working days a booking lands on: `days` Monday-to-Friday days from
 * `firstDay` (a weekend first day starts on the Monday after). */
export function dispatchInstallWorkingDays(
  firstDay: string,
  days: number,
): string[] {
  const out: string[] = [];
  let day = firstDay;
  while (out.length < days) {
    if (!isWeekend(day)) out.push(day);
    day = addDays(day, 1);
  }
  return out;
}

function ymd(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const day = value.slice(0, 10);
  return isIsoDay(day) ? day : null;
}

// Every day a row covers (its own day, and through scheduled_end when it is a
// multi-day Calendar row), weekends left out.
function rowDays(row: DispatchInstallRow): string[] {
  const start = ymd(row.scheduled_date);
  if (!start) return [];
  const end = ymd(row.scheduled_end);
  const out: string[] = [];
  let day = start;
  const last = end && end > start ? end : start;
  let guard = 0;
  while (day <= last && guard < 366) {
    if (!isWeekend(day) || day === start) out.push(day);
    day = addDays(day, 1);
    guard++;
  }
  return out;
}

function token(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// ── The read ────────────────────────────────────────────────────────────────

export type DispatchInstallPerson = {
  user_id: string | null;
  name: string;
  role: string;
  days: string[];
};

export type DispatchInstallView = {
  job_id: string;
  booked: boolean;
  // tentative: every booking still tentative (or a placeholder);
  // confirmed: every one confirmed; mixed: some of each.
  state: "none" | "tentative" | "confirmed" | "mixed";
  days: string[];
  first_day: string | null;
  last_day: string | null;
  people: DispatchInstallPerson[];
  booking_ids: string[];
  booked_at: string | null;
};

function isConfirmed(row: DispatchInstallRow): boolean {
  return token(row.confirmation_status) === "confirmed";
}

/** The job's install as the Install row shows it: the same rows the board
 * counts (dispatch_install.ts: no ghost, observer, cancelled or non-install
 * row). */
export function dispatchInstallView(
  jobId: string,
  rows: DispatchInstallRow[] | null | undefined,
): DispatchInstallView {
  const live = (rows || []).filter((row) => isDispatchInstallBooking(row));
  if (live.length === 0) {
    return {
      job_id: jobId,
      booked: false,
      state: "none",
      days: [],
      first_day: null,
      last_day: null,
      people: [],
      booking_ids: [],
      booked_at: null,
    };
  }
  const days = new Set<string>();
  const byPerson = new Map<string, DispatchInstallPerson>();
  let bookedAt: string | null = null;
  for (const row of live) {
    const covered = rowDays(row);
    for (const d of covered) days.add(d);
    const key = row.user_id ? `u:${row.user_id}` : `n:${text(row.crew_name)}`;
    let person = byPerson.get(key);
    if (!person) {
      person = {
        user_id: row.user_id || null,
        name: text(row.crew_name) || "Name not on record",
        role: text(row.role) || "lead_installer",
        days: [],
      };
      byPerson.set(key, person);
    }
    if (token(row.role) === "lead_installer") person.role = "lead_installer";
    for (const d of covered) {
      if (!person.days.includes(d)) person.days.push(d);
    }
    const created = text(row.created_at);
    if (created && (!bookedAt || created < bookedAt)) bookedAt = created;
  }
  const people = [...byPerson.values()].map((p) => ({
    ...p,
    days: p.days.sort(),
  })).sort((a, b) => {
    const lead = (p: DispatchInstallPerson) =>
      p.role === "lead_installer" ? 0 : 1;
    return lead(a) - lead(b) || a.name.localeCompare(b.name);
  });
  const sorted = [...days].sort();
  const confirmed = live.filter(isConfirmed).length;
  return {
    job_id: jobId,
    booked: true,
    state: confirmed === 0
      ? "tentative"
      : confirmed === live.length
      ? "confirmed"
      : "mixed",
    days: sorted,
    first_day: sorted[0] || null,
    last_day: sorted[sorted.length - 1] || null,
    people,
    booking_ids: live.map((row) => row.id),
    booked_at: bookedAt,
  };
}

// ── The crew text ───────────────────────────────────────────────────────────

/** The "New job assigned" text, in create_assignment's own words, with the
 * person's own days. */
export function dispatchInstallCrewText(
  job: DispatchInstallJob,
  days: string[],
): string {
  const site = `${text(job.site_address)}${
    text(job.site_suburb) ? ", " + text(job.site_suburb) : ""
  }`.trim().replace(/^,\s*/, "");
  return [
    `New job assigned: ${text(job.job_number)} - ${
      text(job.client_name) || "Client"
    }`.trim(),
    site ? `Site: ${site}` : "",
    days.length > 1 ? `Dates: ${days.join(", ")}` : `Date: ${days[0] || ""}`,
    `Open in Trade: ${TRADE_JOB_URL}${job.id}`,
  ].filter(Boolean).join("\n");
}

// ── Checks ──────────────────────────────────────────────────────────────────

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jobIdOf(body: any, params?: URLSearchParams): string {
  const id = String(params?.get("job_id") || body?.job_id || "").trim();
  if (!id) refuse(400, "job_id_required", "job_id required");
  if (!UUID.test(id)) refuse(400, "job_id_invalid", "job_id must be a job id");
  return id;
}

async function dispatchJob(
  deps: DispatchInstallDeps,
  jobId: string,
): Promise<DispatchInstallJob> {
  const job = await deps.readJob(jobId);
  if (!job) refuse(404, "job_not_found", "No such job");
  if (!(DISPATCH_BOARD_WORK_TYPES as readonly string[]).includes(
    dispatchWorkType(job),
  )) {
    refuse(409, "not_dispatch_work", "This job is not Dispatch work");
  }
  return job;
}

type CrewPick = { user_id: string; name: string; role: string };

function cleanPick(raw: any, role: string): CrewPick | null {
  const id = String(raw?.user_id || raw?.id || "").trim();
  if (!id) return null;
  if (!UUID.test(id)) {
    refuse(400, "crew_invalid", "Every crew member must be picked from the list");
  }
  return { user_id: id, name: text(raw?.name), role };
}

export type DispatchInstallBookRequest = {
  jobId: string;
  firstDay: string;
  days: number;
  crew: CrewPick[];
  note: string | null;
};

export function parseDispatchInstallBook(
  body: any,
): DispatchInstallBookRequest {
  const jobId = jobIdOf(body);
  const firstDay = body?.first_day;
  if (!isIsoDay(firstDay)) {
    refuse(400, "first_day_invalid", "first_day must be a YYYY-MM-DD date");
  }
  const days = body?.days === undefined || body?.days === null
    ? 1
    : Number(body.days);
  if (
    !Number.isInteger(days) || days < 1 || days > DISPATCH_INSTALL_MAX_DAYS
  ) {
    refuse(
      400,
      "days_invalid",
      `days must be a whole number from 1 to ${DISPATCH_INSTALL_MAX_DAYS}`,
    );
  }
  const lead = cleanPick(body?.lead, "lead_installer");
  if (!lead) refuse(400, "lead_required", "Pick the lead crew member");
  const crew: CrewPick[] = [lead];
  const helpers = Array.isArray(body?.helpers) ? body.helpers : [];
  for (const raw of helpers) {
    const pick = cleanPick(raw, "helper");
    if (!pick) continue;
    if (crew.some((c) => c.user_id === pick.user_id)) continue;
    crew.push(pick);
  }
  if (crew.length > DISPATCH_INSTALL_MAX_PEOPLE) {
    refuse(
      400,
      "crew_too_many",
      `At most ${DISPATCH_INSTALL_MAX_PEOPLE} people on one booking`,
    );
  }
  const note = text(body?.note).slice(0, 2000) || null;
  return { jobId, firstDay, days, crew, note };
}

// ── The presses ─────────────────────────────────────────────────────────────

async function view(
  deps: DispatchInstallDeps,
  jobId: string,
): Promise<DispatchInstallView> {
  return dispatchInstallView(jobId, await deps.readBookings(jobId));
}

async function book(
  body: any,
  ctx: DispatchInstallContext,
  deps: DispatchInstallDeps,
) {
  const req = parseDispatchInstallBook(body);
  await dispatchJob(deps, req.jobId);
  const before = dispatchInstallView(
    req.jobId,
    await deps.readBookings(req.jobId),
  );
  if (before.booked) {
    refuse(
      409,
      "already_booked",
      "This job already has an install booked. Move or Remove it first.",
      { install: before },
    );
  }
  // Names as the Calendar writes them: the name picked on screen, else the
  // name on the user record. An id with no user record is refused.
  const users = await deps.readUsers(req.crew.map((c) => c.user_id));
  const byId = new Map(users.map((u) => [u.id, u]));
  for (const pick of req.crew) {
    const user = byId.get(pick.user_id);
    if (!user) {
      refuse(400, "crew_unknown", "A crew member picked is not on record");
    }
    if (!pick.name) pick.name = text(user.name) || "Crew";
  }
  const days = dispatchInstallWorkingDays(req.firstDay, req.days);
  const created: string[] = [];
  try {
    for (const pick of req.crew) {
      for (const day of days) {
        const res = await deps.createAssignment({
          jobId: req.jobId,
          userId: pick.user_id,
          crewName: pick.name,
          role: pick.role,
          scheduledDate: day,
          scheduledEnd: day,
          durationDays: 1,
          assignmentType: "install",
          notes: req.note,
          // Tentative and silent, as the Calendar's planning entries.
          confirmationStatus: "tentative",
          suppress_notifications: true,
          // Booking never moves the job's stage or status.
          keep_job_status: true,
          operator_email: ctx.operatorEmail,
        });
        const id = res?.assignment?.id;
        if (id) created.push(String(id));
      }
    }
  } catch (e) {
    // Take back what this press made, so a half booking is never left.
    const undone: string[] = [];
    for (const id of created) {
      try {
        await deps.deleteAssignment({
          assignmentId: id,
          operator_email: ctx.operatorEmail,
        });
        undone.push(id);
      } catch { /* reported below */ }
    }
    refuse(
      500,
      "book_failed",
      `Not booked: ${(e as Error)?.message || "a booking could not be saved"}` +
        (undone.length === created.length
          ? ". Nothing was left on the Calendar."
          : ". Some days may still be on the Calendar: check it."),
      { left_on_calendar: created.length - undone.length },
    );
  }
  return {
    success: true,
    booked_days: days,
    rows_created: created.length,
    texted: [],
    job_status_changed: false,
    install: await view(deps, req.jobId),
  };
}

async function confirm(
  body: any,
  ctx: DispatchInstallContext,
  deps: DispatchInstallDeps,
) {
  const jobId = jobIdOf(body);
  const job = await dispatchJob(deps, jobId);
  const rows = (await deps.readBookings(jobId)).filter((row) =>
    isDispatchInstallBooking(row)
  );
  if (rows.length === 0) refuse(409, "not_booked", "No install is booked");
  const toConfirm = rows.filter((row) => !isConfirmed(row));
  if (toConfirm.length === 0) {
    refuse(409, "already_confirmed", "The install is already confirmed");
  }
  const done: DispatchInstallRow[] = [];
  const failed: string[] = [];
  for (const row of toConfirm) {
    try {
      await deps.confirmAssignment({
        assignmentId: row.id,
        notifyClient: false,
        confirmedBy: ctx.operatorUserId,
        operator_email: ctx.operatorEmail,
      });
      done.push(row);
    } catch (e) {
      failed.push(`${text(row.crew_name) || "Crew"} ${row.scheduled_date}: ${
        (e as Error)?.message || "not confirmed"
      }`);
    }
  }
  // One text per person whose bookings were just confirmed, with every one
  // of that person's install days.
  const people = new Map<string, DispatchInstallRow[]>();
  for (const row of done) {
    if (!row.user_id) continue;
    const list = people.get(row.user_id) || [];
    list.push(row);
    people.set(row.user_id, list);
  }
  const users = people.size ? await deps.readUsers([...people.keys()]) : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const texted: string[] = [];
  const noPhone: string[] = [];
  const textFailed: string[] = [];
  const at = (deps.now || (() => new Date().toISOString()))();
  for (const [userId, theirs] of people) {
    const user = byId.get(userId);
    const name = text(theirs[0]?.crew_name) || text(user?.name) || "Crew";
    const phone = text(user?.phone);
    if (!phone) {
      noPhone.push(name);
      continue;
    }
    const allTheirs = rows.filter((row) => row.user_id === userId);
    const days = [...new Set(allTheirs.flatMap(rowDays))].sort();
    const ok = await deps.sendCrewText(
      phone,
      dispatchInstallCrewText(job, days),
      jobId,
    );
    if (ok) {
      texted.push(name);
      try {
        await deps.markCrewNotified(theirs.map((row) => row.id), at);
      } catch { /* the text went; the stamp is a record only */ }
    } else textFailed.push(name);
  }
  return {
    success: failed.length === 0,
    confirmed: done.length,
    failed,
    texted,
    no_phone: noPhone,
    text_failed: textFailed,
    client_texted: false,
    job_status_changed: false,
    install: await view(deps, jobId),
  };
}

async function move(
  body: any,
  ctx: DispatchInstallContext,
  deps: DispatchInstallDeps,
) {
  const jobId = jobIdOf(body);
  await dispatchJob(deps, jobId);
  const newStart = body?.new_start;
  if (!isIsoDay(newStart)) {
    refuse(400, "new_start_invalid", "new_start must be a YYYY-MM-DD date");
  }
  const rows = (await deps.readBookings(jobId)).filter((row) =>
    isDispatchInstallBooking(row)
  );
  if (rows.length === 0) refuse(409, "not_booked", "No install is booked");
  const result = await deps.rescheduleJobBookings({
    job_id: jobId,
    mode: "move",
    new_start: newStart,
    operator_email: ctx.operatorEmail,
  });
  // A confirmed booking moved goes back to tentative (the Calendar's
  // "Reschedule confirmed job"), so the crew is texted the new days only
  // when someone presses Confirm again.
  const reset: string[] = [];
  if (result?.changed === true) {
    for (const row of rows.filter(isConfirmed)) {
      try {
        await deps.updateAssignment({
          assignmentId: row.id,
          confirmation_status: "tentative",
          operator_email: ctx.operatorEmail,
        });
        reset.push(row.id);
      } catch { /* the move stands; the row keeps its lock */ }
    }
  }
  return {
    success: true,
    changed: result?.changed === true,
    from: result?.from ?? null,
    to: result?.to ?? null,
    back_to_tentative: reset.length,
    texted: [],
    job_status_changed: false,
    install: await view(deps, jobId),
  };
}

async function remove(
  body: any,
  ctx: DispatchInstallContext,
  deps: DispatchInstallDeps,
) {
  const jobId = jobIdOf(body);
  await dispatchJob(deps, jobId);
  const rows = (await deps.readBookings(jobId)).filter((row) =>
    isDispatchInstallBooking(row)
  );
  if (rows.length === 0) refuse(409, "not_booked", "No install is booked");
  let removed = 0;
  const failed: string[] = [];
  for (const row of rows) {
    try {
      await deps.deleteAssignment({
        assignmentId: row.id,
        operator_email: ctx.operatorEmail,
      });
      removed++;
    } catch (e) {
      failed.push(`${text(row.crew_name) || "Crew"} ${row.scheduled_date}: ${
        (e as Error)?.message || "not removed"
      }`);
    }
  }
  return {
    success: failed.length === 0,
    removed,
    failed,
    texted: [],
    job_status_changed: false,
    install: await view(deps, jobId),
  };
}

/** Runs one Book install action. */
export async function runDispatchV2InstallAction(
  action: string,
  params: URLSearchParams,
  body: any,
  ctx: DispatchInstallContext,
  deps: DispatchInstallDeps,
) {
  switch (action) {
    case DISPATCH_V2_INSTALL_READ_ACTION: {
      const jobId = jobIdOf(body, params);
      await dispatchJob(deps, jobId);
      return { install: await view(deps, jobId) };
    }
    case DISPATCH_V2_INSTALL_BOOK_ACTION:
      return await book(body, ctx, deps);
    case DISPATCH_V2_INSTALL_CONFIRM_ACTION:
      return await confirm(body, ctx, deps);
    case DISPATCH_V2_INSTALL_MOVE_ACTION:
      return await move(body, ctx, deps);
    case DISPATCH_V2_INSTALL_REMOVE_ACTION:
      return await remove(body, ctx, deps);
    default:
      refuse(400, "unknown_action", `Unknown action ${action}`);
  }
}

// ── The PostgREST reads ─────────────────────────────────────────────────────

/** The three reads the presses need, on the ops-api client. */
export function postgrestDispatchInstallReads(client: any) {
  return {
    readJob: async (jobId: string): Promise<DispatchInstallJob | null> => {
      const { data, error } = await client.from("jobs")
        .select(DISPATCH_INSTALL_JOB_SELECT).eq("id", jobId).maybeSingle();
      if (error) throw new Error(error.message || "job read failed");
      return data || null;
    },
    readBookings: async (jobId: string): Promise<DispatchInstallRow[]> => {
      const { data, error } = await client.from("job_assignments")
        .select(DISPATCH_INSTALL_BOOKING_SELECT).eq("job_id", jobId);
      if (error) throw new Error(error.message || "bookings read failed");
      return data || [];
    },
    readUsers: async (ids: string[]): Promise<DispatchInstallUser[]> => {
      if (!ids.length) return [];
      const { data, error } = await client.from("users")
        .select("id, name, phone").in("id", ids);
      if (error) throw new Error(error.message || "users read failed");
      return data || [];
    },
    markCrewNotified: async (ids: string[], at: string): Promise<void> => {
      if (!ids.length) return;
      const { error } = await client.from("job_assignments")
        .update({ crew_notified_at: at }).in("id", ids);
      if (error) throw new Error(error.message || "stamp failed");
    },
  };
}
