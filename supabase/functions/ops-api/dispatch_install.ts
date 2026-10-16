// Dispatch slice 7: the schedule step. Who is booked for the install and on
// what day, and Dispatch's own install confirmation mark.
// Contract: docs/dispatch-slice-7-contract.md.
//
// Everything here is pure. `pipeline` (dispatch=1) and
// set_dispatch_install_confirmed own the reads and the write; this module owns
// every rule: which booking is the install, the day the row shows, whether a
// mark still stands, and why a Trade scheduled job is back in To do. Nothing
// else may restate these rules. slice 3's dispatchTodo reads the outcome
// through dispatchInstallHoldsTodo.
//
// The mark is never the calendar's lock on a booking (ruling I1): the lock is
// shown as a fact (calendar_confirmed) and never counted.

// The bookings read's extra columns under dispatch=1, beside the plain
// pipeline's `job_id, scheduled_date, is_ghost, role, status`. The person's
// name is embedded through the user_id foreign key to users.
export const DISPATCH_INSTALL_BOOKING_COLUMNS =
  "id, user_id, assignment_type, scheduled_end, is_lead, confirmation_status, person:user_id(name)";

// The write's own read of one job's bookings: the same columns, the same
// filter as the list (cancelled is checked again in code below).
export const DISPATCH_INSTALL_BOOKING_SELECT =
  `job_id, scheduled_date, is_ghost, role, status, ${DISPATCH_INSTALL_BOOKING_COLUMNS}`;

export const NAME_NOT_ON_RECORD = "Name not on record";

export type DispatchInstallBooking = {
  id?: string | null;
  job_id?: string | null;
  user_id?: string | null;
  scheduled_date?: string | null;
  scheduled_end?: string | null;
  assignment_type?: string | null;
  status?: string | null;
  is_ghost?: boolean | null;
  role?: string | null;
  is_lead?: boolean | null;
  confirmation_status?: string | null;
  person?: { name?: string | null } | null;
};

// The mark as the job_dispatch_state row carries it.
export type DispatchInstallMarkRow =
  | {
    install_confirmed_at?: string | null;
    install_confirmed_by?: string | null;
    install_confirmed_by_email?: string | null;
    install_confirmed_for_day?: string | null;
    install_confirmer?: { name?: string | null } | null;
  }
  | null
  | undefined;

export type DispatchInstallState = "ahead" | "past" | "none";

export type DispatchInstall = {
  state: DispatchInstallState;
  day: string | null;
  end_day: string | null;
  people: Array<{ name: string; lead: boolean }>;
  also_days: string[];
  calendar_confirmed: boolean;
  confirmed: { at: string; by: string | null; for_day: string | null } | null;
  confirmed_current: boolean;
};

export type DispatchInstallOpen = "not_confirmed" | "moved" | "booked_after";

function token(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function ymd(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const day = value.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

// An install booking: type install, not cancelled (a null status counts; the
// column is nullable, so this is checked here and never trusted to the read),
// not a ghost or observer watcher row, and dated.
export function isDispatchInstallBooking(row: DispatchInstallBooking): boolean {
  if (!row) return false;
  if (token(row.assignment_type) !== "install") return false;
  if (row.status != null && token(row.status) === "cancelled") return false;
  if (row.is_ghost === true) return false;
  if (token(row.role) === "observer") return false;
  return ymd(row.scheduled_date) !== null;
}

// Every install booking, grouped by job.
export function dispatchInstallBookingsByJob(
  rows: DispatchInstallBooking[] | null | undefined,
): Map<string, DispatchInstallBooking[]> {
  const byJob = new Map<string, DispatchInstallBooking[]>();
  for (const row of rows || []) {
    if (!isDispatchInstallBooking(row)) continue;
    const jobId = String(row.job_id ?? "");
    if (!jobId) continue;
    const list = byJob.get(jobId);
    if (list) list.push(row);
    else byJob.set(jobId, [row]);
  }
  return byJob;
}

function installDays(bookings: DispatchInstallBooking[]): string[] {
  const days = new Set<string>();
  for (const row of bookings) {
    if (!isDispatchInstallBooking(row)) continue;
    days.add(ymd(row.scheduled_date) as string);
  }
  return [...days].sort();
}

// The install day the row shows: the earliest day on or after today (a
// booking dated today counts as ahead), else the latest day, else none.
export function dispatchInstallDay(
  bookings: DispatchInstallBooking[],
  today: string,
): { state: DispatchInstallState; day: string | null; also_days: string[] } {
  const days = installDays(bookings);
  const ahead = days.filter((day) => day >= today);
  if (ahead.length > 0) {
    return { state: "ahead", day: ahead[0], also_days: ahead.slice(1) };
  }
  if (days.length > 0) {
    return { state: "past", day: days[days.length - 1], also_days: [] };
  }
  return { state: "none", day: null, also_days: [] };
}

// The install bookings on one day.
export function dispatchInstallBookingsOnDay(
  bookings: DispatchInstallBooking[],
  day: string | null,
): DispatchInstallBooking[] {
  if (!day) return [];
  return bookings.filter((row) =>
    isDispatchInstallBooking(row) && ymd(row.scheduled_date) === day
  );
}

function personName(row: DispatchInstallBooking): string {
  const name = row?.person?.name;
  return typeof name === "string" && name.trim()
    ? name.trim()
    : NAME_NOT_ON_RECORD;
}

// C order: code units, never the database or locale collation.
function cOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function peopleOnDay(
  onDay: DispatchInstallBooking[],
): Array<{ name: string; lead: boolean }> {
  return onDay
    .map((row) => ({ name: personName(row), lead: row.is_lead === true }))
    .sort((a, b) =>
      a.lead === b.lead ? cOrder(a.name, b.name) : a.lead ? -1 : 1
    );
}

function endDay(onDay: DispatchInstallBooking[], day: string): string | null {
  let latest: string | null = null;
  for (const row of onDay) {
    const end = ymd(row.scheduled_end);
    if (end && end > day && (!latest || end > latest)) latest = end;
  }
  return latest;
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// The stored mark, by the confirmer's name, else the stored email.
export function dispatchInstallMark(
  state: DispatchInstallMarkRow,
): { at: string; by: string | null; for_day: string | null } | null {
  const at = cleanText(state?.install_confirmed_at);
  if (!at) return null;
  return {
    at,
    by: cleanText(state?.install_confirmer?.name) ??
      cleanText(state?.install_confirmed_by_email),
    for_day: ymd(state?.install_confirmed_for_day),
  };
}

// The schedule step for one job, from its bookings (any rows: the non-install
// ones are left out here), its Dispatch state row and the Perth day.
export function dispatchInstall(
  bookings: DispatchInstallBooking[] | null | undefined,
  state: DispatchInstallMarkRow,
  today: string,
): DispatchInstall {
  const installs = (bookings || []).filter(isDispatchInstallBooking);
  const { state: installState, day, also_days } = dispatchInstallDay(
    installs,
    today,
  );
  const onDay = dispatchInstallBookingsOnDay(installs, day);
  const confirmed = dispatchInstallMark(state);
  // A mark for a day stands while the job still has an install booking on that
  // day, past or ahead: one confirmation is for the install, so it does not
  // lapse when the day shown moves on to the next install day. A mark made with
  // nothing booked stands while nothing is booked ahead.
  const confirmedCurrent = confirmed === null
    ? false
    : confirmed.for_day
    ? installDays(installs).includes(confirmed.for_day)
    : installState !== "ahead";
  return {
    state: installState,
    day,
    end_day: day ? endDay(onDay, day) : null,
    people: peopleOnDay(onDay),
    also_days,
    calendar_confirmed: onDay.some((row) =>
      token(row.confirmation_status) === "confirmed"
    ),
    confirmed,
    confirmed_current: confirmedCurrent,
  };
}

// The install condition of To do: a Trade scheduled job stays in To do while
// its install is ahead (or not booked) and not confirmed for that booking.
export function dispatchInstallHoldsTodo(install: DispatchInstall): boolean {
  if (install.state === "past") return false;
  return !(install.confirmed && install.confirmed_current);
}

// Why a Trade scheduled job is in To do. Null unless the job is in To do at
// stop 6 because of the install condition. `moved` means no install booking
// remains on the mark's day.
export function dispatchInstallOpen(
  install: DispatchInstall | null,
  stageIndex: number | null,
  todo: boolean,
): DispatchInstallOpen | null {
  if (!install || stageIndex !== 6 || !todo) return null;
  if (!install.confirmed) return "not_confirmed";
  if (install.confirmed_current) return null;
  return install.confirmed.for_day ? "moved" : "booked_after";
}
