// deno-lint-ignore-file no-explicit-any
// Reminder texts before a scheduled job's first work day (captain, 13 Nov 2026:
// "an automated text every seven days that the job does not happen", then one the day
// before; "the template is fixed: every single job will be the same").
//
// At 12:00 Perth every day, weekends included (pg_cron job-schedule-reminders, 04:00
// UTC), every fencing, patio and repair job in Scheduled is checked:
//   - In Scheduled: fencing and patio at jobs.status 'scheduled'; a repair (the Repairs
//     board family) at board stage 'scheduled'. Make-safe and restoration cards are
//     never texted. Which lane a job is in is job_auto_start.ts autoStartLane, the same
//     rule the 6am auto start moves jobs by.
//   - The job's first work day is its earliest crew work booking on or after today
//     (job_auto_start.ts isWorkBooking: an install booking, never a ghost watcher row,
//     never cancelled). A job still in Scheduled has not started (the 6am auto start
//     moves it to In Progress on its first work day), so a booking before today is a
//     stale one left on the calendar and never the day the customer is told (captain
//     answer 3). The day is re-read every run, so a moved job follows its new day and
//     nothing is stored ahead of time.
//   - reminderKindForToday: d = calendar days from today to the first work day. d = 1 is
//     the day-before text; d = 7, 14, 21 ... is the weekly text; any other day sends
//     nothing. No catch-up: a missed noon is not sent later.
//   - Held for the day (captain answer 1): a crew booking on the job was made, changed
//     or removed today, or an install_rescheduled text went today. The booked-in or
//     reschedule text covers that day.
//   - Repairs: when the job's contact sits on other clients' jobs (a builder's or an
//     agent's number, the job story's contact_shared test, context_job_story_meta), the
//     job is held and flagged instead (captain answer 6).
//   - Who: every paying party on the job with their own GHL contact, or the job's client
//     when it has no party rows (captain answer 5; job_closeout.ts reviewRecipients).
//   - Before each text, the prior-text scan (captain answer 7): the outbound texts to
//     that contact (business_events client.sms_out / sms_sent, hand-sent and tool-sent)
//     and the job's sms_sent job events since the previous reminder slot (weekly: the
//     last 6 days; day before: today). One that mentions the work day, its weekday or
//     reminder wording (similarReminderReason) holds this text as skipped_similar_prior.
//     A reminder this sweep sent the contact for another job (its GHL message id on a
//     job_schedule_reminders row of that job) is not a repeat and is left out.
//   - Once: one job_schedule_reminders row per job, recipient and Perth day, claimed by
//     insert before the send (conflict = someone already has it). Outcomes: sent, refused
//     (a 4xx: nothing went), unconfirmed (may have reached GHL, never retried),
//     no_contact, or skipped_<reason>. Each outcome writes one schedule_reminder job
//     event; a sent or failed text also writes an email_events row, comms trigger
//     schedule_reminder, for the Ops comms timeline.
//   - The text goes through ghl-proxy send_sms with jobId (the shared sender policy and
//     the contact guard), like every other client text.
//
// Switch: job_closeout_settings.schedule_reminder_mode, 'off' or 'live', shipped off
// (20261113120000). Missing or unreadable is off. A POST with dry_run not false (any
// call by hand) reads everything, writes nothing and sends nothing, and answers what
// it would send. Each live run writes one job_schedule_reminder_runs row.

import { autoStartLane, isWorkBooking, perthToday } from "./job_auto_start.ts";
import { isGenuineCrewAssignmentRow } from "./ghost_observer_mirror.ts";
import { reviewRecipients, type SmsSendResult } from "./job_closeout.ts";

export const SCHEDULE_REMINDER_COMMS_TRIGGER = "schedule_reminder";
export const SCHEDULE_REMINDER_EVENT = "schedule_reminder";
export const SCHEDULE_REMINDER_SOURCE = "schedule_reminder_sweep";

export type ScheduleReminderMode = "off" | "live";
export type ReminderKind = "weekly" | "day_before";

// ── The captain's wording (13 Nov 2026), fixed ──────────────────────────────
// Only whitespace was normalised: the double space after "tomorrow," and the indent
// before "Cheers," and "Shaun". {date} reads "Friday, 27 November"; {work} is "install",
// or "repair" on a repair job.

export const WEEKLY_REMINDER_TEMPLATE = "Hi {first_name},\n\n" +
  "Just an update that we are still on track for your {work} on {date}. We will be in contact if there's changes or updates.\n\n" +
  "Let us know if there are any questions or concerns!\n\n" +
  "Cheers,\nShaun";

export const DAY_BEFORE_REMINDER_TEMPLATE = "Hi {first_name},\n" +
  "Just an update that we will be coming in tomorrow, {date} for your {work}. Our crew will be there between 7-10am, they will be in contact with you before coming.\n\n" +
  "Let us know if there are any questions or concerns!\n\n" +
  "Cheers,\nShaun";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const ID_CHUNK = 50;
const JOB_PAGE_SIZE = 500;
const JOB_PAGES_MAX = 10;
const BOOKING_PAGE_SIZE = 500;
const PRIOR_TEXT_LIMIT = 200;

const text = (v: unknown): string => String(v ?? "").trim();

// ── Dates ────────────────────────────────────────────────────────────────────

function utcDay(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`);
}

/** Calendar days from `from` to `to` (both YYYY-MM-DD). */
export function calendarDaysBetween(from: string, to: string): number {
  return Math.round(
    (utcDay(to).getTime() - utcDay(from).getTime()) / 86_400_000,
  );
}

export function addCalendarDays(iso: string, days: number): string {
  const d = utcDay(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "Friday, 27 November" for 2026-11-27. */
export function reminderDateWords(iso: string): string {
  const d = utcDay(iso);
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${
    MONTHS[d.getUTCMonth()]
  }`;
}

/** The instant a Perth day (YYYY-MM-DD) starts. Perth is UTC+8 with no daylight saving. */
export function perthDayStart(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00+08:00`).toISOString();
}

// ── The rule ────────────────────────────────────────────────────────────────

/**
 * Which reminder goes today for a job whose first work day is `firstWorkDay`:
 * d = 1 the day-before text, d = 7, 14, 21 ... the weekly text, otherwise none.
 */
export function reminderKindForToday(
  today: string,
  firstWorkDay: string,
): ReminderKind | null {
  const d = calendarDaysBetween(today, firstWorkDay);
  if (d === 1) return "day_before";
  if (d >= 7 && d % 7 === 0) return "weekly";
  return null;
}

/** The earliest day on or after `today` of the job's crew work bookings, or null. */
export function firstWorkDay(bookings: any[], today: string): string | null {
  let first: string | null = null;
  for (const row of bookings) {
    if (!isWorkBooking(row)) continue;
    const day = String(row.scheduled_date).slice(0, 10);
    if (day < today) continue;
    if (!first || day < first) first = day;
  }
  return first;
}

/** True when a crew booking on the job (cancelled ones too) was made or changed today. */
export function bookingChangedOn(bookings: any[], today: string): boolean {
  return bookings.some((row) => {
    if (!isGenuineCrewAssignmentRow(row)) return false;
    return [row.created_at, row.updated_at].some((at) =>
      text(at) !== "" && perthToday(new Date(String(at))) === today
    );
  });
}

/** Where the prior-text scan starts: the previous reminder slot. */
export function priorTextWindowStart(
  kind: ReminderKind,
  today: string,
): string {
  return perthDayStart(kind === "weekly" ? addCalendarDays(today, -6) : today);
}

// ── The text ────────────────────────────────────────────────────────────────

export function reminderFirstName(name: unknown): string {
  return text(name).split(/\s+/)[0] || "there";
}

export function reminderMessage(
  kind: ReminderKind,
  name: unknown,
  workDay: string,
  isRepair: boolean,
): string {
  const template = kind === "weekly"
    ? WEEKLY_REMINDER_TEMPLATE
    : DAY_BEFORE_REMINDER_TEMPLATE;
  return template
    .replace("{first_name}", reminderFirstName(name))
    .replace("{date}", reminderDateWords(workDay))
    .replace("{work}", isRepair ? "repair" : "install");
}

// ── The prior-text scan ─────────────────────────────────────────────────────

/** Words that make an earlier text read as a booking or a reminder. */
export const REMINDER_LIKE_WORDS = [
  "on track",
  "reminder",
  "remind",
  "booked",
  "booking",
  "coming in",
  "tomorrow",
  "scheduled",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Why an earlier text reads like this reminder, or null: it mentions the work day (its
 * date in any common form), its weekday, or reminder wording.
 */
export function similarReminderReason(
  message: unknown,
  workDay: string,
): string | null {
  const body = text(message).toLowerCase().replace(/\s+/g, " ");
  if (!body) return null;
  for (const word of REMINDER_LIKE_WORDS) {
    if (new RegExp(`\\b${escapeRegExp(word)}\\b`).test(body)) {
      return `wording:${word}`;
    }
  }
  const d = utcDay(workDay);
  const weekday = WEEKDAYS[d.getUTCDay()].toLowerCase();
  if (new RegExp(`\\b${weekday}\\b`).test(body)) return `weekday:${weekday}`;
  const day = d.getUTCDate();
  const monthNum = d.getUTCMonth() + 1;
  const month = MONTHS[d.getUTCMonth()].toLowerCase();
  const mon = month.slice(0, 3);
  const months = `(?:${month}|${mon})`;
  const datePatterns = [
    // "27th", "the 27th", "27th of November"
    `\\b${day}(?:st|nd|rd|th)\\b`,
    // "27 November", "27 Nov"
    `\\b${day}\\s+(?:of\\s+)?${months}\\b`,
    // "November 27"
    `\\b${months}\\s+${day}\\b`,
    // "27/11", "27.11", "27-11"
    `\\b0?${day}[/.-]0?${monthNum}\\b`,
  ];
  for (const p of datePatterns) {
    if (new RegExp(p).test(body)) return `date:${workDay}`;
  }
  return null;
}

export interface PriorText {
  at: string;
  message: string;
  source: string;
}

/** The first earlier text in the window that reads like this reminder, or null. */
export function similarPriorText(
  texts: PriorText[],
  workDay: string,
  windowStart: string,
): (PriorText & { reason: string }) | null {
  const from = new Date(windowStart).getTime();
  for (const t of texts) {
    const at = new Date(t.at).getTime();
    if (!Number.isFinite(at) || at < from) continue;
    const reason = similarReminderReason(t.message, workDay);
    if (reason) return { ...t, reason };
  }
  return null;
}

// ── The sweep ────────────────────────────────────────────────────────────────

export interface ReminderCandidate {
  job: any;
  details: any | null;
  bookings: any[];
  parties: any[];
}

export interface ReminderRecipientRow {
  job_id: string;
  recipient_key: string;
  send_on: string;
  kind: ReminderKind;
  work_day: string;
  ghl_contact_id: string | null;
  job_contact_id: string | null;
}

export interface JobDayEvents {
  /** A crew booking was created or deleted today (job_events). */
  booking_event: boolean;
  /** An install_rescheduled text was sent today (email_events). */
  reschedule_text: boolean;
}

export interface ScheduleReminderDeps {
  now: () => Date;
  readMode: () => Promise<ScheduleReminderMode>;
  loadCandidates: () => Promise<ReminderCandidate[] | null>;
  /** Today's booking and reschedule-text events on the job; null when unreadable. */
  readJobDayEvents: (
    jobId: string,
    dayStart: string,
  ) => Promise<JobDayEvents | null>;
  /** The job story's contact_shared test; null when unreadable. */
  readContactShared: (jobId: string) => Promise<boolean | null>;
  /** Outbound texts to the contact and the job's sent texts since `since`; null when unreadable. */
  readPriorTexts: (
    contactId: string,
    jobId: string,
    since: string,
  ) => Promise<PriorText[] | null>;
  /** Insert the claim row; "taken" when the row already exists. */
  claim: (
    row: ReminderRecipientRow,
  ) => Promise<"claimed" | "taken" | "failed">;
  finish: (
    row: ReminderRecipientRow,
    outcome: Record<string, unknown>,
  ) => Promise<void>;
  /** One SMS through ghl-proxy send_sms (the shared sender policy and contact guard). */
  sendSms: (
    args: { contactId: string; message: string; jobId: string },
  ) => Promise<SmsSendResult>;
  recordRun: (row: Record<string, unknown>) => Promise<void>;
}

type JobResult = {
  job_id: string;
  job_number: string | null;
  action: string;
  detail?: unknown;
  recipients?: Array<Record<string, unknown>>;
};

/** Which job-level hold applies today, or null. */
async function jobHold(
  deps: ScheduleReminderDeps,
  c: ReminderCandidate,
  today: string,
  isRepair: boolean,
): Promise<string | null> {
  if (bookingChangedOn(c.bookings, today)) {
    return "skipped_booking_changed_today";
  }
  const events = await deps.readJobDayEvents(
    String(c.job.id),
    perthDayStart(today),
  );
  if (!events) return "skipped_job_events_unreadable";
  if (events.booking_event) return "skipped_booking_changed_today";
  if (events.reschedule_text) return "skipped_reschedule_text_today";
  if (isRepair) {
    const shared = await deps.readContactShared(String(c.job.id));
    if (shared === null) return "skipped_contact_unreadable";
    if (shared) return "skipped_contact_shared";
  }
  return null;
}

export async function jobScheduleReminderSweep(
  deps: ScheduleReminderDeps,
  body: Record<string, unknown> = {},
) {
  const dryRun = body.dry_run !== false;
  const today = perthToday(deps.now());
  const mode = await deps.readMode();
  if (mode !== "live" && !dryRun) {
    return { ok: true, ran: false, reason: "switched_off", today };
  }
  const candidates = await deps.loadCandidates();
  if (!candidates) {
    if (!dryRun) {
      await deps.recordRun({
        run_on: today,
        outcome: "failed",
        sent_count: 0,
        detail: { reason: "candidates_unreadable" },
      });
    }
    return { ok: false, ran: false, reason: "candidates_unreadable", today };
  }

  const results: JobResult[] = [];
  for (const c of candidates) {
    const base = {
      job_id: String(c.job.id),
      job_number: c.job.job_number ?? null,
    };
    try {
      results.push({ ...base, ...(await remindOne(deps, c, today, dryRun)) });
    } catch (e) {
      results.push({
        ...base,
        action: "failed",
        detail: (e as Error)?.message ?? String(e),
      });
    }
  }

  const outcomes: Record<string, number> = {};
  for (const r of results) {
    for (const rec of r.recipients ?? []) {
      const key = String(rec.result);
      outcomes[key] = (outcomes[key] ?? 0) + 1;
    }
  }
  const sentCount = outcomes.sent ?? 0;
  const partial = results.some((r) => r.action === "failed") ||
    (outcomes.unconfirmed ?? 0) > 0 || (outcomes.claim_failed ?? 0) > 0;
  const summary = {
    ok: true,
    ran: true,
    dry_run: dryRun,
    mode,
    today,
    checked: candidates.length,
    sent_count: sentCount,
    outcomes,
    results,
  };
  if (!dryRun) {
    await deps.recordRun({
      run_on: today,
      outcome: partial ? "partial" : "ok",
      sent_count: sentCount,
      detail: {
        checked: candidates.length,
        outcomes,
        reminded: results.filter((r) => r.recipients?.length),
        not_due: results
          .filter((r) => !r.recipients?.length)
          .map(({ job_number, job_id, action, detail }) => ({
            job_number,
            job_id,
            action,
            detail,
          })),
      },
    });
  }
  return summary;
}

async function remindOne(
  deps: ScheduleReminderDeps,
  c: ReminderCandidate,
  today: string,
  dryRun: boolean,
): Promise<Omit<JobResult, "job_id" | "job_number">> {
  const type = text(c.job.type).toLowerCase();
  const lane = autoStartLane(c.job, c.details);
  if (lane.lane === "skip") return { action: lane.reason };
  const isRepair = lane.lane === "repair";
  if (!isRepair && type !== "fencing" && type !== "patio") {
    return { action: "not_reminded_type", detail: type || null };
  }
  const workDay = firstWorkDay(c.bookings, today);
  if (!workDay) return { action: "no_work_booking" };
  const kind = reminderKindForToday(today, workDay);
  if (!kind) return { action: "not_due", detail: { first_work_day: workDay } };

  const hold = await jobHold(deps, c, today, isRepair);
  const recipients = reviewRecipients(c.job, c.parties);
  const message = (name: unknown) =>
    reminderMessage(kind, name, workDay, isRepair);
  const windowStart = priorTextWindowStart(kind, today);
  const out: Array<Record<string, unknown>> = [];

  for (const r of recipients) {
    const row: ReminderRecipientRow = {
      job_id: String(c.job.id),
      recipient_key: r.ghl_contact_id ||
        (r.party_id ? `party:${r.party_id}` : "owner"),
      send_on: today,
      kind,
      work_day: workDay,
      ghl_contact_id: r.ghl_contact_id,
      job_contact_id: r.party_id,
    };
    const entry: Record<string, unknown> = {
      label: r.label,
      ghl_contact_id: r.ghl_contact_id,
    };
    out.push(entry);

    // Decide everything that needs no send first; a dry run stops at the verdict.
    let verdict: { result: string; extra?: Record<string, unknown> } | null =
      hold ? { result: hold } : null;
    if (!verdict && !r.ghl_contact_id) verdict = { result: "no_contact" };
    if (!verdict && dryRun) {
      verdict = await priorVerdict(deps, r.ghl_contact_id!, row, windowStart);
      if (!verdict) {
        entry.result = "would_send";
        entry.message = message(r.first_name);
        continue;
      }
    }
    if (dryRun) {
      entry.result = `would_${verdict!.result}`;
      if (verdict!.extra) Object.assign(entry, verdict!.extra);
      continue;
    }

    // Live: claim before anything is sent, so two runs cannot both text.
    const claimed = await deps.claim(row);
    if (claimed !== "claimed") {
      entry.result = claimed === "taken" ? "already_claimed" : "claim_failed";
      continue;
    }
    if (!verdict) {
      verdict = await priorVerdict(deps, r.ghl_contact_id!, row, windowStart);
    }
    if (verdict) {
      entry.result = verdict.result;
      if (verdict.extra) Object.assign(entry, verdict.extra);
      await deps.finish(row, { status: verdict.result, ...verdict.extra });
      continue;
    }
    const text_ = message(r.first_name);
    let sent: SmsSendResult;
    try {
      sent = await deps.sendSms({
        contactId: r.ghl_contact_id!,
        message: text_,
        jobId: row.job_id,
      });
    } catch (e) {
      sent = {
        ok: false,
        refused: false,
        error: String((e as Error)?.message ?? e),
      };
    }
    if (sent.ok) {
      entry.result = "sent";
      await deps.finish(row, {
        status: "sent",
        message: text_,
        ghl_message_id: sent.message_id,
      });
    } else {
      // A 4xx refusal sent nothing; anything else may have reached GHL. Neither is retried.
      entry.result = sent.refused ? "refused" : "unconfirmed";
      entry.error = sent.error.slice(0, 500);
      await deps.finish(row, {
        status: entry.result,
        message: text_,
        reason: entry.error,
      });
    }
  }
  return {
    action: hold ?? (dryRun ? "would_remind" : "reminded"),
    detail: { kind, first_work_day: workDay },
    recipients: out,
  };
}

/** The prior-text scan for one recipient: a skip verdict, or null to send. */
async function priorVerdict(
  deps: ScheduleReminderDeps,
  contactId: string,
  row: ReminderRecipientRow,
  windowStart: string,
): Promise<{ result: string; extra?: Record<string, unknown> } | null> {
  const prior = await deps.readPriorTexts(contactId, row.job_id, windowStart);
  if (!prior) return { result: "skipped_prior_unreadable" };
  const similar = similarPriorText(prior, row.work_day, windowStart);
  if (!similar) return null;
  return {
    result: "skipped_similar_prior",
    extra: {
      reason: similar.reason,
      prior_at: similar.at,
      prior_source: similar.source,
    },
  };
}

// ── Switch and reads ─────────────────────────────────────────────────────────

/** Fails closed: an unreadable row, or anything but live, is off. */
export async function readScheduleReminderMode(
  client: any,
): Promise<ScheduleReminderMode> {
  try {
    const { data, error } = await client.from("job_closeout_settings")
      .select("schedule_reminder_mode")
      .eq("id", 1)
      .maybeSingle();
    if (error || !data) return "off";
    return text(data.schedule_reminder_mode) === "live" ? "live" : "off";
  } catch {
    return "off";
  }
}

const JOB_COLUMNS =
  "id, job_number, type, status, metadata, client_name, ghl_contact_id";
const PARTY_COLUMNS =
  "id, job_id, contact_label, is_primary, share_percentage, removed_at, status, client_name, ghl_contact_id";
const BOOKING_COLUMNS =
  "id, job_id, role, status, assignment_type, is_ghost, scheduled_date, scheduled_end, created_at, updated_at";

/**
 * Jobs that may be in Scheduled (jobs.status scheduled, or a repair whose board stage may
 * read scheduled), with their make-safe details, every booking and every party row.
 * Null when a read fails.
 */
export async function loadScheduleReminderCandidates(
  client: any,
): Promise<ReminderCandidate[] | null> {
  const jobs: any[] = [];
  for (let page = 0; page < JOB_PAGES_MAX; page++) {
    const { data, error } = await client.from("jobs")
      .select(JOB_COLUMNS)
      .or(
        "status.in.(scheduled,schedule_install),metadata->>repair_stage.eq.scheduled",
      )
      .order("id")
      .range(page * JOB_PAGE_SIZE, (page + 1) * JOB_PAGE_SIZE - 1);
    if (error) {
      console.error(
        "[job_schedule_reminders] jobs read failed:",
        error.message,
      );
      return null;
    }
    jobs.push(...(data ?? []));
    if (!data || data.length < JOB_PAGE_SIZE) break;
  }
  const ids = jobs.map((j) => String(j.id));
  const details = new Map<string, any>();
  const bookings = new Map<string, any[]>();
  const parties = new Map<string, any[]>();
  const push = (map: Map<string, any[]>, row: any) => {
    const key = String(row.job_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(row);
  };
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const [detailRead, partyRead, bookingRows] = await Promise.all([
      client.from("makesafe_job_details").select("job_id, report_type").in(
        "job_id",
        chunk,
      ),
      client.from("job_contacts").select(PARTY_COLUMNS).in("job_id", chunk)
        .limit(5000),
      readChunkBookings(client, chunk),
    ]);
    if (detailRead.error || partyRead.error || !bookingRows) {
      console.error(
        "[job_schedule_reminders] job facts read failed:",
        detailRead.error?.message ?? partyRead.error?.message ?? "bookings",
      );
      return null;
    }
    for (const d of detailRead.data ?? []) details.set(String(d.job_id), d);
    for (const p of partyRead.data ?? []) push(parties, p);
    for (const b of bookingRows) push(bookings, b);
  }
  return jobs.map((job) => ({
    job,
    details: details.get(String(job.id)) ?? null,
    bookings: bookings.get(String(job.id)) ?? [],
    parties: parties.get(String(job.id)) ?? [],
  }));
}

/** Every booking on the chunk's jobs, paged past the row cap. Null when a page fails. */
async function readChunkBookings(
  client: any,
  chunk: string[],
): Promise<any[] | null> {
  const rows: any[] = [];
  for (let page = 0;; page++) {
    const { data, error } = await client.from("job_assignments")
      .select(BOOKING_COLUMNS)
      .in("job_id", chunk)
      .order("id")
      .range(page * BOOKING_PAGE_SIZE, (page + 1) * BOOKING_PAGE_SIZE - 1);
    if (error) return null;
    rows.push(...(data ?? []));
    if (!data || data.length < BOOKING_PAGE_SIZE) return rows;
  }
}

export async function readScheduleReminderJobDayEvents(
  client: any,
  jobId: string,
  dayStart: string,
): Promise<JobDayEvents | null> {
  const [bookingEvents, rescheduleTexts] = await Promise.all([
    client.from("job_events")
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId)
      .in("event_type", ["assignment_created", "assignment_deleted"])
      .gte("created_at", dayStart),
    client.from("email_events")
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId)
      .eq("comms_trigger", "install_rescheduled")
      .eq("status", "sent")
      .gte("created_at", dayStart),
  ]);
  if (bookingEvents.error || rescheduleTexts.error) return null;
  return {
    booking_event: (bookingEvents.count ?? 0) > 0,
    reschedule_text: (rescheduleTexts.count ?? 0) > 0,
  };
}

/** context_job_story_meta's contact_shared.shared; null when it cannot be read. */
export async function readScheduleReminderContactShared(
  client: any,
  jobId: string,
  now: Date,
): Promise<boolean | null> {
  const { data, error } = await client.rpc("context_job_story_meta", {
    p_job_id: jobId,
    p_as_of: now.toISOString(),
  });
  if (error) return null;
  const shared = data?.contact_shared?.shared;
  return typeof shared === "boolean" ? shared : null;
}

/**
 * Outbound texts to the contact (business_events client.sms_out and legacy sms_sent, any
 * sender) and the job's sms_sent job events (to that contact, or naming none) since
 * `since`, less the reminders this sweep sent the contact for another job (matched by
 * GHL message id). Null when any read fails.
 */
export async function readScheduleReminderPriorTexts(
  client: any,
  contactId: string,
  jobId: string,
  since: string,
): Promise<PriorText[] | null> {
  const [events, jobTexts, otherJobReminders] = await Promise.all([
    client.from("business_events")
      .select(
        "event_type, event_at, occurred_at, provider_message_id, body_preview, body:payload->>body, msg:payload->>message",
      )
      .in("event_type", ["client.sms_out", "sms_sent"])
      .or(`contact_id.eq.${contactId},entity_id.eq.${contactId}`)
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .limit(PRIOR_TEXT_LIMIT),
    client.from("job_events")
      .select("created_at, detail_json")
      .eq("job_id", jobId)
      .eq("event_type", "sms_sent")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(PRIOR_TEXT_LIMIT),
    client.from("job_schedule_reminders")
      .select("ghl_message_id")
      .eq("ghl_contact_id", contactId)
      .neq("job_id", jobId)
      .not("ghl_message_id", "is", null),
  ]);
  if (events.error || jobTexts.error || otherJobReminders.error) return null;
  const otherJobIds = new Set(
    (otherJobReminders.data ?? []).map((r: any) => text(r.ghl_message_id)),
  );
  const isOtherJobReminder = (id: unknown) =>
    text(id) !== "" && otherJobIds.has(text(id));
  const out: PriorText[] = [];
  for (const e of events.data ?? []) {
    if (isOtherJobReminder(text(e.provider_message_id).replace(/^ghl:/, ""))) {
      continue;
    }
    out.push({
      // The message's own time when known (a backfilled row lands later than it was sent).
      at: String(e.event_at || e.occurred_at),
      message: text(e.body || e.msg || e.body_preview),
      source: `business_events:${e.event_type}`,
    });
  }
  for (const e of jobTexts.data ?? []) {
    const to = text(e.detail_json?.contact_id);
    if (to && to !== contactId) continue;
    if (isOtherJobReminder(e.detail_json?.message_id)) continue;
    out.push({
      at: String(e.created_at),
      message: text(e.detail_json?.message),
      source: "job_events:sms_sent",
    });
  }
  return out;
}

export async function claimScheduleReminder(
  client: any,
  row: ReminderRecipientRow,
  now: Date,
): Promise<"claimed" | "taken" | "failed"> {
  const { data, error } = await client.from("job_schedule_reminders")
    .upsert({ ...row, status: "claimed", claimed_at: now.toISOString() }, {
      onConflict: "job_id,recipient_key,send_on",
      ignoreDuplicates: true,
    })
    .select("id");
  if (error) {
    console.error("[job_schedule_reminders] claim failed:", error.message);
    return "failed";
  }
  return Array.isArray(data) && data.length > 0 ? "claimed" : "taken";
}

/** The outcome on the claim row, one job event, and (sent or failed text) one email_events row. */
export async function finishScheduleReminder(
  client: any,
  row: ReminderRecipientRow,
  outcome: Record<string, unknown>,
  now: Date,
): Promise<void> {
  const status = text(outcome.status);
  const at = now.toISOString();
  const { error } = await client.from("job_schedule_reminders").update({
    status,
    message: outcome.message ?? null,
    ghl_message_id: outcome.ghl_message_id ?? null,
    reason: outcome.reason ?? null,
    detail: outcome,
    finished_at: at,
  })
    .eq("job_id", row.job_id)
    .eq("recipient_key", row.recipient_key)
    .eq("send_on", row.send_on);
  if (error) {
    console.error(
      "[job_schedule_reminders] outcome write failed:",
      error.message,
    );
  }
  await client.from("job_events").insert({
    job_id: row.job_id,
    event_type: SCHEDULE_REMINDER_EVENT,
    detail_json: {
      result: status,
      kind: row.kind,
      work_day: row.work_day,
      ghl_contact_id: row.ghl_contact_id,
      job_contact_id: row.job_contact_id,
      source: SCHEDULE_REMINDER_SOURCE,
      ...(status === "skipped_contact_shared"
        ? { flag: "contact_shared" }
        : {}),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.ghl_message_id
        ? { ghl_message_id: outcome.ghl_message_id }
        : {}),
    },
  });
  if (status === "sent" || status === "refused" || status === "unconfirmed") {
    await client.from("email_events").insert({
      email_type: "notification",
      entity_type: "job",
      entity_id: row.job_id,
      job_id: row.job_id,
      recipient: row.ghl_contact_id ?? row.recipient_key,
      sender: "system",
      subject:
        `Client update: ${SCHEDULE_REMINDER_COMMS_TRIGGER} (${row.kind}) -> ${row.work_day}`,
      status: status === "sent" ? "sent" : "failed",
      comms_trigger: SCHEDULE_REMINDER_COMMS_TRIGGER,
      comms_channel: "sms",
      sent_at: status === "sent" ? at : null,
      ...(status === "sent"
        ? {}
        : { failure_reason: text(outcome.reason).slice(0, 500) || status }),
    });
  }
}

export async function recordScheduleReminderRun(
  client: any,
  row: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.from("job_schedule_reminder_runs").insert(row);
  if (error) {
    console.error("[job_schedule_reminders] run record failed:", error.message);
  }
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/** Server key only, POST only. */
export async function runScheduleReminderAction(
  method: string,
  body: Record<string, unknown>,
  isServer: boolean,
  deps: ScheduleReminderDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!isServer) {
    return { status: 403, body: { ok: false, code: "server_key_required" } };
  }
  if (method !== "POST") {
    return { status: 405, body: { ok: false, code: "method_not_allowed" } };
  }
  return { status: 200, body: await jobScheduleReminderSweep(deps, body) };
}
