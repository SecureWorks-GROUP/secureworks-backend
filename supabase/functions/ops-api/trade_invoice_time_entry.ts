// Trade invoice time entries (owner, 12 Oct 2026): every invoice line that
// bills a trade's time records the day it was worked and the start and finish
// time, so the hours can be checked and the job's story can be pieced together.
//
// This module is the ONE owner of the rule. Every trade invoice write path in
// index.ts resolves a time line through it; nothing else parses these fields.
//
// Contract (shared with the trade app, secureworks-ux):
//   work_date      YYYY-MM-DD, the Perth calendar day worked
//   start_time     HH:MM, 24-hour, Perth local time
//   finish_time    HH:MM, 24-hour, Perth local time, after start_time
//   break_minutes  whole minutes, optional, default 0
//   hours = (finish_time - start_time) - break_minutes, computed here
// One line is one job on one day. A shift across midnight is two lines.
// The day worked is never after today, Perth: nobody bills a day not yet worked.
// Materials, travel, equipment, commission and other lines carry none of this.
//
// Enforcement is behind feature flag TRADE_INVOICE_TIME_ENTRY_FLAG, seeded
// off: while off the fields are stored when sent and a line without them is
// accepted; when on, a time line without them is refused `time_entry_required`.
// An invoice line's time entry is always the trade's own statement on that
// line, and always makes the hours the line bills: the server never fills one
// in from the clock or from times saved elsewhere. A job card the server
// collects itself (nobody typed its line) therefore carries none, and when
// the flag is on it is refused by name.
// A wrong entry (finish not after start, hours that disagree, a day worked
// that is after today) is refused in both states. Contract: docs/trade-invoice-time-entries-2026-10-12.md.

export const TRADE_INVOICE_TIME_ENTRY_FLAG =
  "trade_invoice_time_entry_required_v1";

// The line types that bill hours: every type the trade app's hours row
// offers. The M0 capture guard in generate_trade_invoice asks the same
// question for its hours check.
export const TRADE_INVOICE_TIME_LINE_TYPES = [
  "labour",
  "fencing",
  "patio",
  "make safe",
  "general labour",
  "decking",
] as const;

// A type is matched whatever its case and spacing: "Make Safe", "MakeSafe"
// and "make safe" are one type.
function timeLineTypeKey(lineType: unknown): string {
  return String(lineType ?? "").toLowerCase().replace(/\s+/g, "");
}

const TIME_LINE_TYPE_KEYS = new Set<string>(
  TRADE_INVOICE_TIME_LINE_TYPES.map(timeLineTypeKey),
);

export function isTradeInvoiceTimeLineType(lineType: unknown): boolean {
  return TIME_LINE_TYPE_KEYS.has(timeLineTypeKey(lineType));
}

export type TradeInvoiceTimeEntry = {
  work_date: string;
  start_time: string;
  finish_time: string;
  break_minutes: number;
  hours: number;
};

export type TradeInvoiceTimeEntryColumns = {
  work_date: string | null;
  start_time: string | null;
  finish_time: string | null;
  break_minutes: number | null;
};

export type TradeInvoiceTimeEntryErrorCode =
  | "time_entry_required"
  | "time_entry_invalid"
  | "time_entry_future_date"
  | "time_entry_finish_before_start"
  | "time_entry_hours_mismatch"
  | "time_entry_overlap";

// A job card that still needs its times: which job, and the card's day.
export type TradeInvoiceTimeEntryNeeded = {
  assignment_id: string;
  job_id: string | null;
  job_number: string | null;
  work_date: string | null;
};

export class TradeInvoiceTimeEntryError extends Error {
  readonly status = 422;
  readonly code: TradeInvoiceTimeEntryErrorCode;
  readonly needsTimes: TradeInvoiceTimeEntryNeeded[] | null;

  constructor(
    code: TradeInvoiceTimeEntryErrorCode,
    message: string,
    needsTimes: TradeInvoiceTimeEntryNeeded[] | null = null,
  ) {
    super(message);
    this.name = "TradeInvoiceTimeEntryError";
    this.code = code;
    this.needsTimes = needsTimes;
  }
}

/**
 * The one refusal for job cards the server collected itself, which say nowhere
 * when they were worked. It names every such job and day and the one way to
 * give the times, so the trade can fix exactly those.
 */
export function tradeInvoiceTimeEntriesNeededError(
  cards: TradeInvoiceTimeEntryNeeded[],
): TradeInvoiceTimeEntryError {
  const named = cards.map((card) =>
    `${card.job_number || "a job card"}${
      card.work_date ? ` on ${card.work_date}` : ""
    }`
  ).join("; ");
  return new TradeInvoiceTimeEntryError(
    "time_entry_required",
    `Enter your start and finish time for: ${named}. Enter them on that job's card in the Weekly Invoice, then submit again.`,
    cards,
  );
}

const NO_TIME_ENTRY: TradeInvoiceTimeEntryColumns = {
  work_date: null,
  start_time: null,
  finish_time: null,
  break_minutes: null,
};

function present(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function parseWorkDate(value: unknown): string | null {
  const text = String(value ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return text;
}

// Exactly HH:MM, 24-hour: the contract form and the stored form.
function parseClockTime(value: unknown): { text: string; minutes: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(
    String(value ?? "").trim(),
  );
  if (!match) return null;
  return {
    text: `${match[1]}:${match[2]}`,
    minutes: Number(match[1]) * 60 + Number(match[2]),
  };
}

function parseBreakMinutes(value: unknown): number | null {
  if (!present(value)) return 0;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 0) return null;
  return minutes;
}

function hoursFromMinutes(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

const perthClockFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Perth",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function perthClock(value: unknown): { date: string; time: string } | null {
  if (!present(value)) return null;
  const instant = new Date(String(value));
  if (Number.isNaN(instant.getTime())) return null;
  const parts = perthClockFormatter.formatToParts(instant);
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value || "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}

/** Today's calendar day in Perth, YYYY-MM-DD. */
export function perthToday(now: Date = new Date()): string {
  return perthClock(now.toISOString())?.date ?? now.toISOString().slice(0, 10);
}

function lineLabel(label: string | undefined): string {
  const text = String(label ?? "").trim();
  return text ? `the ${text} line` : "a time line";
}

/**
 * Resolves the time entry on one invoice line that bills time.
 *
 * Returns null when the line carries none of the fields and they are not
 * required (the flag is off). Throws TradeInvoiceTimeEntryError otherwise:
 * a missing or half-filled entry is `time_entry_required`, a malformed one
 * `time_entry_invalid`, a finish not after the start
 * `time_entry_finish_before_start`, and a client hours figure more than 0.01
 * away from the computed hours `time_entry_hours_mismatch`, and a day worked
 * after today in Perth `time_entry_future_date`. `today` is for tests.
 */
export function resolveTradeInvoiceTimeEntry(
  raw: unknown,
  opts: {
    required: boolean;
    clientHours?: unknown;
    label?: string;
    today?: string;
  },
): TradeInvoiceTimeEntry | null {
  const line = raw && typeof raw === "object"
    ? raw as Record<string, unknown>
    : {};
  const where = lineLabel(opts.label);
  const hasDate = present(line.work_date);
  const hasStart = present(line.start_time);
  const hasFinish = present(line.finish_time);

  if (!hasDate && !hasStart && !hasFinish) {
    if (!opts.required) return null;
    throw new TradeInvoiceTimeEntryError(
      "time_entry_required",
      `Enter the date you worked and your start and finish time on ${where}.`,
    );
  }
  if (!hasDate || !hasStart || !hasFinish) {
    const missing = [
      hasDate ? null : "the date you worked",
      hasStart ? null : "your start time",
      hasFinish ? null : "your finish time",
    ].filter(Boolean).join(" and ");
    throw new TradeInvoiceTimeEntryError(
      "time_entry_required",
      `Enter ${missing} on ${where}.`,
    );
  }

  const workDate = parseWorkDate(line.work_date);
  if (!workDate) {
    throw new TradeInvoiceTimeEntryError(
      "time_entry_invalid",
      `The date worked on ${where} is not a valid date.`,
    );
  }
  // YYYY-MM-DD compares as text.
  if (workDate > (opts.today || perthToday())) {
    throw new TradeInvoiceTimeEntryError(
      "time_entry_future_date",
      `The date worked on ${where} (${workDate}) is after today. Enter the day the work was done.`,
    );
  }
  const start = parseClockTime(line.start_time);
  const finish = parseClockTime(line.finish_time);
  if (!start || !finish) {
    throw new TradeInvoiceTimeEntryError(
      "time_entry_invalid",
      `Enter the start and finish time on ${where} as 24-hour times, like 07:30 and 15:30.`,
    );
  }
  const breakMinutes = parseBreakMinutes(line.break_minutes);
  if (breakMinutes === null) {
    throw new TradeInvoiceTimeEntryError(
      "time_entry_invalid",
      `Enter the break on ${where} as whole minutes, 0 or more.`,
    );
  }
  if (finish.minutes <= start.minutes) {
    throw new TradeInvoiceTimeEntryError(
      "time_entry_finish_before_start",
      `The finish time on ${where} must be after the start time on the same day. If the shift ran past midnight, enter it as two lines.`,
    );
  }
  const workedMinutes = finish.minutes - start.minutes - breakMinutes;
  if (workedMinutes <= 0) {
    throw new TradeInvoiceTimeEntryError(
      "time_entry_invalid",
      `The break on ${where} is as long as the whole shift. Check the times and the break.`,
    );
  }
  const hours = hoursFromMinutes(workedMinutes);

  if (present(opts.clientHours)) {
    const clientHours = Number(opts.clientHours);
    const gap = Number.isFinite(clientHours)
      ? Math.round(Math.abs(clientHours - hours) * 1000) / 1000
      : Infinity;
    if (gap > 0.01) {
      throw new TradeInvoiceTimeEntryError(
        "time_entry_hours_mismatch",
        `The hours on ${where} (${String(opts.clientHours)}) do not match the start and finish time (${start.text} to ${finish.text}${
          breakMinutes ? `, ${breakMinutes} minute break` : ""
        } is ${hours} hours). Reload and try again.`,
      );
    }
  }

  return {
    work_date: workDate,
    start_time: start.text,
    finish_time: finish.text,
    break_minutes: breakMinutes,
    hours,
  };
}

export function tradeInvoiceTimeEntryColumns(
  entry: TradeInvoiceTimeEntry | null | undefined,
): TradeInvoiceTimeEntryColumns {
  if (!entry) return { ...NO_TIME_ENTRY };
  return {
    work_date: entry.work_date,
    start_time: entry.start_time,
    finish_time: entry.finish_time,
    break_minutes: entry.break_minutes,
  };
}

/**
 * Draft lines are a working copy: nothing is refused. Each field is kept when
 * it is well formed and dropped when it is not (a day worked after today is
 * dropped the same way), a half-filled entry is kept as it stands, and `hours`
 * is computed only for a complete, valid entry.
 */
export function draftTradeInvoiceTimeEntry(
  raw: unknown,
  today: string = perthToday(),
): { columns: TradeInvoiceTimeEntryColumns; hours: number | null } {
  const line = raw && typeof raw === "object"
    ? raw as Record<string, unknown>
    : {};
  let workDate = parseWorkDate(line.work_date);
  if (workDate && workDate > today) workDate = null;
  const start = parseClockTime(line.start_time);
  let finish = parseClockTime(line.finish_time);
  // The table refuses a finish that is not after the start; keep the start.
  if (start && finish && finish.minutes <= start.minutes) finish = null;
  if (!workDate && !start && !finish) {
    return { columns: { ...NO_TIME_ENTRY }, hours: null };
  }
  const breakMinutes = parseBreakMinutes(line.break_minutes) ?? 0;
  const workedMinutes = start && finish
    ? finish.minutes - start.minutes - breakMinutes
    : 0;
  return {
    columns: {
      work_date: workDate,
      start_time: start?.text ?? null,
      finish_time: finish?.text ?? null,
      break_minutes: breakMinutes,
    },
    hours: workDate && workedMinutes > 0
      ? hoursFromMinutes(workedMinutes)
      : null,
  };
}

/**
 * A job card may be sent more than once (two days on one job is two lines),
 * but only when every one of those lines says when it was worked, and no two
 * of them claim the same time on the same day.
 */
export function assertManualTimeEntriesDistinct(
  entries: Array<
    { assignment_id: unknown; entry: TradeInvoiceTimeEntry | null }
  >,
): void {
  const byCard = new Map<string, Array<TradeInvoiceTimeEntry | null>>();
  for (const row of entries) {
    const key = String(row.assignment_id ?? "");
    byCard.set(key, [...(byCard.get(key) || []), row.entry]);
  }
  for (const rows of byCard.values()) {
    if (rows.length < 2) continue;
    if (rows.some((entry) => !entry)) {
      throw new TradeInvoiceTimeEntryError(
        "time_entry_required",
        "A job card was added more than once. Each line for the same job card needs its own date worked, start time and finish time.",
      );
    }
    const dated = rows as TradeInvoiceTimeEntry[];
    for (let i = 0; i < dated.length; i++) {
      for (let j = i + 1; j < dated.length; j++) {
        const a = dated[i];
        const b = dated[j];
        if (
          a.work_date === b.work_date && a.start_time < b.finish_time &&
          b.start_time < a.finish_time
        ) {
          throw new TradeInvoiceTimeEntryError(
            "time_entry_overlap",
            `Two lines for the same job card overlap on ${a.work_date} (${a.start_time} to ${a.finish_time} and ${b.start_time} to ${b.finish_time}). Check the times.`,
          );
        }
      }
    }
  }
}

/**
 * Reads the enforcement flag. A missing or unreadable flag is OFF: a flag
 * read fault must never be the reason a trade cannot submit an invoice.
 */
export async function tradeInvoiceTimeEntryRequired(
  // deno-lint-ignore no-explicit-any
  client: any,
): Promise<boolean> {
  try {
    const { data, error } = await client.from("feature_flags")
      .select("enabled")
      .eq("flag_name", TRADE_INVOICE_TIME_ENTRY_FLAG)
      .limit(1);
    if (error) {
      console.error(
        "[ops-api] trade invoice time entry flag unreadable, treating as off:",
        error.message,
      );
      return false;
    }
    return (Array.isArray(data) ? data[0] : data)?.enabled === true;
  } catch (error) {
    console.error(
      "[ops-api] trade invoice time entry flag read threw, treating as off:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

// ── Times saved on the job view (log_my_job_hours) ──────────────────────────
// Table public.job_assignment_logged_times: one row per job card, the times the
// trade typed when they logged the card's hours. It sits beside
// job_assignments.hours_worked rather than on that table, because every
// job_assignments column is inside the make-safe fact hash. It is a record of
// its own, never an invoice line's entry. Two readers: my_hours returns it as
// `logged_time_entry` so the Weekly Invoice card can open on the trade's own
// saved times for the trade to confirm, and a job's list shows it until that
// day is billed.

export const JOB_ASSIGNMENT_LOGGED_TIME_COLUMNS =
  "assignment_id, user_id, work_date, start_time, finish_time, break_minutes, hours";

/**
 * The saved times for a job card, or null. They are returned only while they
 * still describe the card's hours: when the hours were changed since by any
 * other writer (the clock, the office, a bare-hours log), the saved times are
 * stale and are not used. With `ownerUserId` they must also be that trade's
 * own: a card handed to someone else never carries the first trade's times.
 */
export function loggedTimeEntryForCard(
  row: unknown,
  cardHours: unknown,
  ownerUserId?: unknown,
): TradeInvoiceTimeEntry | null {
  if (!row || typeof row !== "object") return null;
  const saved = row as Record<string, unknown>;
  if (
    ownerUserId !== undefined &&
    String(saved.user_id ?? "") !== String(ownerUserId ?? "")
  ) {
    return null;
  }
  const workDate = parseWorkDate(saved.work_date);
  const start = parseClockTime(saved.start_time);
  const finish = parseClockTime(saved.finish_time);
  const hours = Number(saved.hours);
  if (!workDate || !start || !finish || !Number.isFinite(hours)) return null;
  if (!present(cardHours)) return null;
  const current = Number(cardHours);
  if (!Number.isFinite(current) || Math.abs(current - hours) > 0.01) {
    return null;
  }
  return {
    work_date: workDate,
    start_time: start.text,
    finish_time: finish.text,
    break_minutes: parseBreakMinutes(saved.break_minutes) ?? 0,
    hours,
  };
}

/**
 * The saved rows for a set of job cards, by card id. A failed read answers
 * the reason: the caller decides whether that may be shown as "no saved
 * times" (a view) or must stop the work (a log that would replace them).
 */
export async function loadLoggedTimesByCard(
  // deno-lint-ignore no-explicit-any
  client: any,
  assignmentIds: unknown[],
): Promise<{ byCard: Map<string, unknown>; error: string | null }> {
  const byCard = new Map<string, unknown>();
  const ids = [
    ...new Set(assignmentIds.map((id) => String(id ?? "")).filter(Boolean)),
  ];
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await client.from("job_assignment_logged_times")
        .select(JOB_ASSIGNMENT_LOGGED_TIME_COLUMNS)
        .in("assignment_id", ids.slice(i, i + 100));
      if (error) {
        return { byCard, error: String(error.message || "read failed") };
      }
      for (const row of (data || [])) {
        byCard.set(String(row.assignment_id), row);
      }
    }
    return { byCard, error: null };
  } catch (error) {
    return {
      byCard,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── The per-job list ────────────────────────────────────────────────────────
// Two sources, each row marked with its own:
//   invoice   view public.job_trade_time_entries (migration
//             20261012180000_trade_invoice_time_entries.sql): one row per
//             submitted time line that says when it was worked. Drafts are
//             not in it.
//   job_view  the times a trade saved on the job view, with no invoice
//             fields, until that trade has a submitted time line on the job
//             for the same day.

export const JOB_TRADE_TIME_ENTRY_COLUMNS =
  "trade_invoice_line_id, job_id, job_number, user_id, user_name, work_date, start_time, finish_time, break_minutes, hours, started_at, finished_at, line_type, trade_invoice_id, invoice_number, invoice_status, submitted_at";

export type JobTradeTimeEntry = {
  source: "invoice" | "job_view";
  trade_invoice_line_id: string | null;
  job_id: string;
  job_number: string | null;
  user_id: string | null;
  user_name: string | null;
  work_date: string;
  start_time: string;
  finish_time: string;
  break_minutes: number;
  hours: number | null;
  started_at: string | null;
  finished_at: string | null;
  line_type: string | null;
  trade_invoice_id: string | null;
  invoice_number: string | null;
  invoice_status: string | null;
  submitted_at: string | null;
};

// Perth is UTC+8 all year.
function perthInstant(workDate: string, clockTime: string): string {
  return new Date(`${workDate}T${clockTime}:00+08:00`).toISOString();
}

async function loadJobViewTimeEntries(
  // deno-lint-ignore no-explicit-any
  client: any,
  jobId: string,
  billed: JobTradeTimeEntry[],
): Promise<{ entries: JobTradeTimeEntry[]; error: string | null }> {
  const { data: saved, error: savedError } = await client
    .from("job_assignment_logged_times")
    .select(JOB_ASSIGNMENT_LOGGED_TIME_COLUMNS)
    .eq("job_id", jobId);
  if (savedError) {
    return { entries: [], error: String(savedError.message || "read failed") };
  }
  const rows = (saved || []) as Array<Record<string, unknown>>;
  if (rows.length === 0) return { entries: [], error: null };

  // deno-lint-ignore no-explicit-any
  const cardById = new Map<string, any>();
  const cardIds = rows.map((row) => String(row.assignment_id));
  for (let i = 0; i < cardIds.length; i += 100) {
    const { data: cards, error: cardError } = await client
      .from("job_assignments")
      .select(
        "id, user_id, hours_worked, users:user_id(name), jobs:job_id(job_number)",
      )
      .in("id", cardIds.slice(i, i + 100));
    if (cardError) {
      return { entries: [], error: String(cardError.message || "read failed") };
    }
    for (const card of (cards || [])) cardById.set(String(card.id), card);
  }

  const billedDays = new Set(
    billed.map((entry) => `${entry.user_id}|${entry.work_date}`),
  );
  const entries: JobTradeTimeEntry[] = [];
  for (const row of rows) {
    const card = cardById.get(String(row.assignment_id));
    if (!card) continue;
    const entry = loggedTimeEntryForCard(row, card.hours_worked, card.user_id);
    if (!entry) continue;
    if (billedDays.has(`${card.user_id}|${entry.work_date}`)) continue;
    entries.push({
      source: "job_view",
      trade_invoice_line_id: null,
      job_id: jobId,
      job_number: card.jobs?.job_number ?? null,
      user_id: String(card.user_id),
      user_name: card.users?.name ?? null,
      work_date: entry.work_date,
      start_time: entry.start_time,
      finish_time: entry.finish_time,
      break_minutes: entry.break_minutes,
      hours: entry.hours,
      started_at: perthInstant(entry.work_date, entry.start_time),
      finished_at: perthInstant(entry.work_date, entry.finish_time),
      line_type: null,
      trade_invoice_id: null,
      invoice_number: null,
      invoice_status: null,
      submitted_at: null,
    });
  }
  return { entries, error: null };
}

/**
 * Who worked on a job, which day, from when to when, for how many hours and
 * on which invoice, by day then start. A failed read of either source answers
 * `entries: null` with the reason, never a short or empty list: no rows must
 * mean nobody recorded time, not a fault.
 */
export async function loadJobTradeTimeEntries(
  // deno-lint-ignore no-explicit-any
  client: any,
  jobId: string,
): Promise<{ entries: JobTradeTimeEntry[] | null; error: string | null }> {
  try {
    const { data, error } = await client.from("job_trade_time_entries")
      .select(JOB_TRADE_TIME_ENTRY_COLUMNS)
      .eq("job_id", jobId)
      .order("work_date", { ascending: true })
      .order("start_time", { ascending: true });
    if (error) {
      console.error(
        "[ops-api] job_trade_time_entries read failed:",
        error.message,
      );
      return { entries: null, error: String(error.message || "read failed") };
    }
    const billed = ((data || []) as Array<Omit<JobTradeTimeEntry, "source">>)
      .map((row): JobTradeTimeEntry => ({ source: "invoice", ...row }));
    const jobView = await loadJobViewTimeEntries(client, jobId, billed);
    if (jobView.error) {
      console.error(
        "[ops-api] job view times read failed:",
        jobView.error,
      );
      return { entries: null, error: jobView.error };
    }
    if (jobView.entries.length === 0) return { entries: billed, error: null };
    const key = (entry: JobTradeTimeEntry) =>
      `${entry.work_date} ${entry.start_time}`;
    return {
      entries: [...billed, ...jobView.entries].sort((a, b) =>
        key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0
      ),
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ops-api] job_trade_time_entries read threw:", message);
    return { entries: null, error: message };
  }
}
