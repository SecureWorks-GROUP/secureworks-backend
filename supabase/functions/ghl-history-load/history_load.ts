// The one-off GHL history load for the contacts of live jobs (context build
// plan slice M4; design sms.md section 12 "M4 one-off history load", review
// B5 and D2; INTEGRATION.md X15 and X27).
//
// Captain's scope ruling, 24 Sep 2026: live jobs only (accepted, scheduled,
// in progress, plus quotes sent in the last 60 days), never closed jobs; each
// live job contact's GHL history is loaded back to its first message; at
// most 100 jobs a day. Which jobs are live, which contacts are due and the
// daily bound are decided in SQL (context_ghl_history_live_jobs and
// context_ghl_history_due, migration 20260925031500), never here.
//
// One call is one run:
//   1. dry_run defaults to true. A dry run reads GHL and our keys, builds every
//      row and reports what it would save; it writes no evidence row and no
//      ledger row, only its own run row (source ghl_history_load_dry).
//   2. A real run (dry_run exactly false) needs the item flag
//      ghl_message_capture_v2, the capture lane and the attribution lane on.
//      The flag is the go: history is loaded only once live texts are on
//      (gate G-ANON, sms.md section 13a, holds the flag), so the evidence
//      table never gains customer history while it is still publicly readable,
//      and nothing between the load and live capture is left uncovered.
//   3. A real run starts with reserve_ghl_history_run, which under one lock
//      refuses a second live run, closes an abandoned one, picks the due
//      contacts and counts their jobs on the new run row before any work, so
//      the day's limit is strict and never shared by two runs. With nothing
//      due it creates no run row and the load idles (nothing_due). The day is
//      charged only for jobs actually loaded (schedule slice B-2,
//      20261005190000): when the run ends, jobs_covered is set to the jobs of
//      the contacts it attempted, so contacts it never reached give their
//      quota back, and a contact already attempted today (a partial load
//      resuming) costs nothing again the same day. A dry run reads the same
//      due list without reserving anything (one dry run at a time).
//      The day's limit is SQL's (context_ghl_history_day_limit): 250 jobs a
//      day for 7 days from the first scheduled run, 100 after, and 100 from
//      the first GHL rate limit on, recorded on the run row's cursor.
//   4. For each due contact: every GHL conversation of the contact, every
//      message page back to the first message. Each item goes through the one
//      row builder (_shared/evidence/ghl_message.ts) with capture_mode
//      backfill, and is saved through capture_ghl_history_event (checks, then
//      the one writer capture_business_event). The load writes no placement
//      field: the placement-owned trigger places each row at its own GHL time.
//      A message another writer already saved (an older key-less row naming
//      the same GHL message id, or the same contact, words and time within
//      5 seconds, that the readers read: placed on a job, admissible,
//      captured, the same channel) is not saved again: the door answers
//      duplicate with copy_of_other_writer, counted in duplicates and, per
//      contact, in duplicates_other_writer (migration 20261006031000, gap map
//      W9). A dry run asks the same question through copiesOf.
//      Calls are saved as client.call_logged rows by the same builder (slice
//      T1); before a call row is written the load records its one legacy
//      client.call_complete row, as every call writer does (ghl_call_pair.ts).
//   5. Per contact, one ledger row (context_ghl_history_contacts): done,
//      partial with a resume point (page/time budget, failed capture, or a
//      stopping message-read failure), or failed with a code (offered again
//      on a later day). A failed capture retains the page input cursor so
//      retry cannot skip the unsaved row. A full conversation page without
//      a cursor, or a nonempty message page claiming more without a cursor,
//      never marks done. One row the writer cannot save inside the statement
//      timeout (57014) never stops the contact or the run: the row is skipped,
//      its page is kept on the resume point (retry) and re-read on a later run
//      (the writer is idempotent), and after three runs that still time out
//      the row is given up and counted. More than three timeouts in one
//      contact in one run stop that contact where it stood (it resumes on the
//      next run); the run goes on to the next contact.
//
// None of these rows wakes an extraction read (capture_mode backfill, X15).
// The live ladder does not yet keep backfill rows from the model (X27); rows
// it sends to review are counted pending_review, never moved here.
// Pure orchestration over injected reads and writes: no model call, no clock
// but the one injected.

import {
  buildGhlMessageRow,
  type GhlMessageItem,
} from "../_shared/evidence/ghl_message.ts";
import type { LegacyCallPairOutcome } from "../_shared/evidence/ghl_call_pair.ts";
import {
  failureStopsRun,
  type ProviderFailure,
  safeCode,
} from "../ghl-message-reconcile/reconcile.ts";

/** context_capture_runs.source of a real run. */
export const RUN_SOURCE = "ghl_history_load";
/** context_capture_runs.source of a dry run. */
export const DRY_RUN_SOURCE = "ghl_history_load_dry";
/** business_events.source of every row this load saves. */
export const EVENT_SOURCE = "ghl-history-load";
/** The live-texts item flag (C1c, C1d). Missing or unreadable reads as off. */
export const ITEM_FLAG = "ghl_message_capture_v2";

export interface HistoryPolicy {
  /** Jobs asked of the due list per call (the SQL day limit still bounds it). */
  defaultMaxJobs: number;
  maxJobsCeiling: number;
  conversationPageLimit: number;
  maxConversationPages: number;
  messagePageLimit: number;
  /** Message pages per contact per run; past it the contact resumes next run. */
  maxMessagePagesPerContact: number;
  timeBudgetMs: number;
  runningStaleMs: number;
  /** A duplicate whose stored time is this far from GHL's is counted (M4a sizing). */
  timeDriftMs: number;
  /** Pages kept on the resume point for rows that timed out (B-2). */
  maxRetryPages: number;
  /** Row timeouts in one contact in one run before the contact stops (B-2). */
  maxRowTimeoutsPerContactRun: number;
  /** Runs a timed-out page is re-read before its rows are given up (B-2). */
  maxRowRetryRuns: number;
}

export const POLICY: Readonly<HistoryPolicy> = {
  defaultMaxJobs: 20,
  maxJobsCeiling: 100,
  conversationPageLimit: 100,
  maxConversationPages: 5,
  messagePageLimit: 100,
  maxMessagePagesPerContact: 40,
  timeBudgetMs: 100_000,
  runningStaleMs: 10 * 60_000,
  timeDriftMs: 60_000,
  maxRetryPages: 10,
  maxRowTimeoutsPerContactRun: 3,
  maxRowRetryRuns: 3,
};

/** PostgreSQL's statement timeout: one heavy row, never a reason to stop. */
export const STATEMENT_TIMEOUT_CODES: ReadonlySet<string> = new Set(["57014"]);

/** The statuses that put a row on its job (F1's context_linked_status). */
const LINKED = new Set([
  "direct",
  "thread",
  "single_open",
  "single_line",
  "luna",
  "content_ref",
  "party",
]);

export interface RunRow {
  id: string;
  status: "running" | "succeeded" | "partial" | "failed";
  updated_at: string;
  cursor?: unknown;
}

export interface RetryPage {
  conversation_id: string;
  /** The GHL cursor the page was read with (null: the newest page). */
  last_message_id: string | null;
  /** Runs that re-read the page and still timed out. */
  tries: number;
}

export interface Resume {
  v: 1;
  /** Conversations of this contact already read to their first message. */
  done: string[];
  /** The conversation being read, and the GHL cursor of its next older page. */
  conversation_id: string | null;
  last_message_id: string | null;
  /** Pages with rows the writer timed out on, re-read on a later run (B-2). */
  retry?: RetryPage[];
}

export interface DueContact {
  contact_id: string;
  job_ids: string[];
  jobs: number;
  prior_status: "done" | "partial" | "failed" | null;
  resume: unknown;
  attempts: number;
  oversized?: boolean;
  /** Attempted earlier today, so already charged: costs nothing again today. */
  charged_today?: boolean;
}

export interface DueList {
  daily_job_limit: number;
  jobs_counted_today: number;
  daily_remaining: number;
  contacts: DueContact[];
  jobs_offered: number;
  contacts_waiting: number;
  jobs_waiting: number;
  daily_limit_reached: boolean;
  jobs_invalid_contact_id?: number;
  contacts_over_daily_limit?: number;
  jobs_over_daily_limit?: number;
  /** Jobs the offered contacts charge to today (charged_today ones are free). */
  jobs_charged?: number;
  /** context_ghl_history_day_limit's answer (limit, basis, boost window). */
  limit?: Record<string, unknown>;
}

export type HistoryCaptureOutcome =
  | {
    outcome: "inserted";
    id?: string;
    attribution_status?: string | null;
    rested?: string;
  }
  | {
    outcome: "duplicate";
    id?: string;
    /** Another writer already saved this message (gap map W9). */
    copy_of_other_writer?: boolean;
    copy_rule?: string;
  }
  | { outcome: "capture_disabled" }
  | { outcome: "error"; code?: string };

export interface HistoryDeps {
  now(): number;
  itemFlagOn(): Promise<boolean>;
  laneOn(lane: "capture" | "attribution"): Promise<boolean>;
  /** Newest run of this source, or null. Throws when unreadable. */
  latestRun(source: string): Promise<RunRow | null>;
  /** record_capture_run. Throws on a refusal. Returns the run id. */
  recordRun(run: Record<string, unknown>): Promise<string>;
  /** context_ghl_history_due (dry runs: read only). Throws when unreadable. */
  due(maxJobs: number): Promise<DueList>;
  /** reserve_ghl_history_run (real runs). Throws on a refusal. */
  reserve(maxJobs: number, actor: string): Promise<
    | {
      outcome: "reserved";
      run_id: string;
      due: DueList;
      cursor?: Record<string, unknown>;
    }
    | { outcome: "run_in_progress"; run_id: string }
    | { outcome: "nothing_due"; due: DueList }
  >;
  /** record_ghl_history_contact. Throws on a refusal. */
  recordContact(row: Record<string, unknown>): Promise<void>;
  listConversations(args: {
    contactId: string;
    limit: number;
    startAfterDate?: string;
  }): Promise<{
    conversations: Record<string, unknown>[];
    hasMore: boolean | null;
    nextStartAfterDate: string | null;
  }>;
  listMessages(args: {
    contactId: string;
    conversationId: string;
    limit: number;
    lastMessageId?: string;
  }): Promise<{
    messages: Record<string, unknown>[];
    hasMore: boolean | null;
    nextLastMessageId: string | null;
  }>;
  /** Stored event_at of each key that already has a row. Throws when unreadable. */
  existingKeys(keys: string[]): Promise<Map<string, string | null>>;
  /** capture_ghl_history_event(row). Never throws: a fault is outcome error. */
  capture(row: Record<string, unknown>): Promise<HistoryCaptureOutcome>;
  /**
   * Dry runs only: of these rows, the ones another writer already saved
   * (context_ghl_message_copies), by provider_message_id. A real run needs no
   * such read: capture_ghl_history_event answers duplicate for them. Throws
   * when unreadable. Optional: without it a dry run counts them as
   * would_insert, as before.
   */
  copiesOf?(rows: Record<string, unknown>[]): Promise<Set<string>>;
  /**
   * For a call row: the row to write, with payload.legacy_event_id when exactly
   * one legacy client.call_complete row of the contact sits around the call
   * (_shared/evidence/ghl_call_pair.ts, slice T1). Never throws.
   */
  pairLegacyCall(row: Record<string, unknown>): Promise<{
    row: Record<string, unknown>;
    outcome: LegacyCallPairOutcome;
  }>;
}

export interface HistoryRequest {
  dryRun: boolean;
  maxJobs: number;
  actor: string;
}

export interface ContactSummary {
  contact_id: string;
  jobs: number;
  status: "done" | "partial" | "failed";
  error_code: string | null;
}

export type HistoryResult =
  | {
    outcome: "idle";
    reason:
      | "item_flag_off"
      | "capture_lane_off"
      | "attribution_lane_off";
  }
  | {
    outcome: "idle";
    reason: "nothing_due";
    daily_job_limit: number;
    daily_remaining: number;
    daily_limit_reached: boolean;
    contacts_waiting: number;
  }
  | { outcome: "run_in_progress"; run_id: string }
  | {
    outcome: "ran";
    run_id: string;
    dry_run: boolean;
    status: "succeeded" | "partial" | "failed";
    error_code: string | null;
    counts: Record<string, number>;
    contacts: ContactSummary[];
    /** What the day was charged: reserved at the start, charged at the end. */
    quota: Quota;
  };

export interface Quota {
  jobs_reserved: number;
  jobs_charged: number;
  jobs_refunded: number;
  contacts_unreached: number;
  rows_timeout_skipped: number;
  rows_given_up: number;
  rate_limited: boolean;
}

const COUNT_KEYS = [
  "dry_run",
  "daily_job_limit",
  "jobs_counted_before",
  "daily_remaining",
  "daily_limit_reached",
  "contacts_due",
  "jobs_due",
  "contacts_waiting",
  "jobs_invalid_contact_id",
  "contacts_over_daily_limit",
  "jobs_covered",
  "contacts_done",
  "contacts_partial",
  "contacts_failed",
  "conversations_read",
  "conversation_pages",
  "message_pages",
  "message_pages_capped",
  "message_cursor_missing",
  "items_seen",
  "inserted",
  "would_insert",
  "duplicates",
  "existing_time_differs",
  "placed_on_job",
  "pending_review",
  "unplaced",
  "admin_bucket",
  "other_status",
  "write_errors",
  "precheck_errors",
  "skipped_no_id",
  "skipped_no_contact",
  "skipped_no_direction",
  "skipped_call",
  "skipped_activity",
  "skipped_unsupported_type",
  // Slice T1: call rows that recorded their one legacy call row, and lookups
  // that could not be read (the row is then written as normal).
  "calls_paired_legacy",
  "call_pair_unreadable",
  "backlog_contacts",
] as const;
type CountKey = typeof COUNT_KEYS[number];
type Counts = Record<CountKey, number>;

const CONTACT_COUNT_KEYS = [
  "conversations_read",
  "message_pages",
  "items_seen",
  "inserted",
  "duplicates",
  "existing_time_differs",
  "placed_on_job",
  "pending_review",
  "unplaced",
  "admin_bucket",
  "other_status",
  "write_errors",
  "skipped_call",
  "timeout_skipped",
  "timeout_given_up",
  // Gap map W9: messages another writer already saved (also counted in
  // duplicates). The run counts stay at their 40 keys, the writer's limit.
  "duplicates_other_writer",
] as const;
type ContactCountKey = typeof CONTACT_COUNT_KEYS[number];

function ms(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value !== "string" || !value.trim()) return null;
  if (/^\d{1,16}$/.test(value.trim())) return Number(value.trim());
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function providerFailure(error: unknown): ProviderFailure {
  const e = (error ?? {}) as Record<string, unknown>;
  return {
    code: typeof e.code === "string" ? e.code : undefined,
    status: typeof e.status === "number" ? e.status : undefined,
    providerStatus: typeof e.providerStatus === "number"
      ? e.providerStatus
      : undefined,
  };
}

function stopCode(f: ProviderFailure): string {
  if (f.status === 429 || f.providerStatus === 429) return "ghl_rate_limited";
  return safeCode(f.code ?? "provider_read_failed");
}

/** A stored resume point, or a fresh one when absent or not this shape. */
export function parseResume(value: unknown): Resume {
  const fresh: Resume = {
    v: 1,
    done: [],
    conversation_id: null,
    last_message_id: null,
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fresh;
  const r = value as Record<string, unknown>;
  if (
    r.v !== 1 || !Array.isArray(r.done) ||
    !r.done.every((id) => typeof id === "string")
  ) return fresh;
  const retry: RetryPage[] = [];
  if (Array.isArray(r.retry)) {
    for (const p of r.retry) {
      if (!p || typeof p !== "object") continue;
      const e = p as Record<string, unknown>;
      const conversation = text(e.conversation_id);
      if (!conversation) continue;
      const tries = typeof e.tries === "number" && Number.isInteger(e.tries) &&
          e.tries >= 0
        ? e.tries
        : 0;
      retry.push({
        conversation_id: conversation,
        last_message_id: text(e.last_message_id),
        tries,
      });
    }
  }
  return {
    v: 1,
    done: r.done as string[],
    conversation_id: text(r.conversation_id),
    last_message_id: text(r.conversation_id) ? text(r.last_message_id) : null,
    ...(retry.length ? { retry } : {}),
  };
}

/** The request as the door received it. dry_run is false only when sent as false. */
export function parseRequest(
  body: Record<string, unknown>,
  actor: string,
  policy: Readonly<HistoryPolicy> = POLICY,
): HistoryRequest {
  const n = typeof body.max_jobs === "number" && Number.isInteger(body.max_jobs)
    ? body.max_jobs
    : policy.defaultMaxJobs;
  return {
    dryRun: body.dry_run !== false,
    maxJobs: Math.min(Math.max(n, 1), policy.maxJobsCeiling),
    actor,
  };
}

type ContactOutcome = {
  status: "done" | "partial" | "failed";
  errorCode: string | null;
  resume: Resume | null;
  counts: Record<ContactCountKey, number>;
  earliestMs: number | null;
  latestMs: number | null;
  stopRun: string | null;
};

export async function runGhlHistoryLoad(
  deps: HistoryDeps,
  req: HistoryRequest,
  policy: Readonly<HistoryPolicy> = POLICY,
): Promise<HistoryResult> {
  if (!req.dryRun) {
    if (!(await deps.itemFlagOn())) {
      return { outcome: "idle", reason: "item_flag_off" };
    }
    if (!(await deps.laneOn("capture"))) {
      return { outcome: "idle", reason: "capture_lane_off" };
    }
    if (!(await deps.laneOn("attribution"))) {
      return { outcome: "idle", reason: "attribution_lane_off" };
    }
  }
  const source = req.dryRun ? DRY_RUN_SOURCE : RUN_SOURCE;
  const started = deps.now();

  // 1. The due contacts and the day's bound (SQL decides both). A real run
  // reserves them atomically; a dry run only reads them.
  let due: DueList;
  let runId: string | null = null;
  let runCursor: Record<string, unknown> = { v: 1, actor: req.actor };
  if (req.dryRun) {
    const latest = await deps.latestRun(source);
    if (latest?.status === "running") {
      const updated = ms(latest.updated_at) ?? 0;
      if (started - updated < policy.runningStaleMs) {
        return { outcome: "run_in_progress", run_id: latest.id };
      }
      await deps.recordRun({
        run_id: latest.id,
        source,
        status: "failed",
        error_code: "run_abandoned",
      });
    }
    due = await deps.due(req.maxJobs);
  } else {
    const reserved = await deps.reserve(req.maxJobs, req.actor);
    if (reserved.outcome === "run_in_progress") return reserved;
    if (reserved.outcome === "nothing_due") {
      // Nothing to load now (every contact done, waiting for a later day, or
      // today's limit spent): no run row, no GHL call.
      return {
        outcome: "idle",
        reason: "nothing_due",
        daily_job_limit: reserved.due.daily_job_limit,
        daily_remaining: reserved.due.daily_remaining,
        daily_limit_reached: reserved.due.daily_limit_reached,
        contacts_waiting: reserved.due.contacts_waiting,
      };
    }
    due = reserved.due;
    runId = reserved.run_id;
    if (reserved.cursor && typeof reserved.cursor === "object") {
      runCursor = { ...reserved.cursor };
    }
  }
  // What each contact charges today: nothing on a dry run, nothing for a
  // contact already attempted today (it was charged then), else its jobs.
  const cost = (contact: DueContact) =>
    req.dryRun || contact.charged_today ? 0 : contact.jobs;
  const reservedJobs = req.dryRun
    ? 0
    : typeof due.jobs_charged === "number"
    ? due.jobs_charged
    : due.contacts.reduce((a, c) => a + cost(c), 0);
  let chargedJobs = 0;
  let pendingJobs = reservedJobs;
  let rowsTimeoutSkipped = 0;
  let rowsGivenUp = 0;

  const counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])) as Counts;
  counts.dry_run = req.dryRun ? 1 : 0;
  counts.daily_job_limit = due.daily_job_limit;
  counts.jobs_counted_before = due.jobs_counted_today;
  counts.daily_remaining = due.daily_remaining;
  counts.daily_limit_reached = due.daily_limit_reached ? 1 : 0;
  counts.contacts_due = due.contacts.length;
  counts.jobs_due = due.jobs_offered;
  counts.contacts_waiting = due.contacts_waiting;
  counts.jobs_invalid_contact_id = due.jobs_invalid_contact_id ?? 0;
  counts.contacts_over_daily_limit = due.contacts_over_daily_limit ?? 0;
  // While the run works its reservation stands (strict, never shared); at the
  // end jobs_covered becomes the jobs it actually charged.
  counts.jobs_covered = reservedJobs;

  if (runId === null) {
    runId = await deps.recordRun({
      source,
      status: "running",
      window_to: new Date(started).toISOString(),
      cursor: runCursor,
      counts,
    });
  } else {
    await deps.recordRun({ run_id: runId, source, counts });
  }
  const run = runId;

  const outcomes: ContactSummary[] = [];
  let stop: string | null = null;
  let firstIssue: string | null = null;

  const loadContact = async (
    contact: DueContact,
  ): Promise<ContactOutcome> => {
    const c = Object.fromEntries(
      CONTACT_COUNT_KEYS.map((k) => [k, 0]),
    ) as Record<ContactCountKey, number>;
    const resume = parseResume(contact.resume);
    const retry: RetryPage[] = (resume.retry ?? []).map((p) => ({ ...p }));
    let earliestMs: number | null = null;
    let latestMs: number | null = null;
    let pagesThisRun = 0;
    let timeoutsThisRun = 0;
    let givenUp = 0;
    const point = (
      conversationId: string | null,
      lastMessageId: string | null,
    ): Resume => ({
      v: 1,
      done: resume.done,
      conversation_id: conversationId,
      last_message_id: conversationId ? lastMessageId : null,
      ...(retry.length ? { retry: retry.map((p) => ({ ...p })) } : {}),
    });
    const out = (
      status: ContactOutcome["status"],
      errorCode: string | null,
      resumePoint: Resume | null,
      stopRun: string | null = null,
    ): ContactOutcome => ({
      status,
      errorCode,
      resume: resumePoint,
      counts: c,
      earliestMs,
      latestMs,
      stopRun,
    });

    // Build, pre-check and save one page of GHL items. A row the writer timed
    // out on is skipped and counted (timedOut); any other refusal ends the
    // contact where it stood (the page is read again on resume).
    type PageSave =
      | { kind: "ok"; timedOut: number }
      | {
        kind: "stop";
        status: "partial";
        code: string;
        stopRun: string | null;
      };
    const savePage = async (
      items: Record<string, unknown>[],
    ): Promise<PageSave> => {
      const rows: Record<string, unknown>[] = [];
      const keys = new Set<string>();
      for (const item of items) {
        const at = ms(item.dateAdded);
        if (at !== null) {
          earliestMs = earliestMs === null ? at : Math.min(earliestMs, at);
          latestMs = latestMs === null ? at : Math.max(latestMs, at);
        }
        const built = buildGhlMessageRow(item as GhlMessageItem, {
          source: EVENT_SOURCE,
          captureMode: "backfill",
        });
        if (built.kind === "skip") {
          const key = (built.reason.startsWith("skipped_")
            ? built.reason
            : `skipped_${built.reason}`) as CountKey;
          counts[key]++;
          if (key === "skipped_call") {
            c.skipped_call++;
          }
          continue;
        }
        const key = String(built.row.provider_message_id);
        if (keys.has(key)) continue;
        keys.add(key);
        built.row.metadata = {
          ...(built.row.metadata as Record<string, unknown>),
          history_run_id: run,
        };
        rows.push(built.row);
      }

      let existing = new Map<string, string | null>();
      if (rows.length) {
        try {
          existing = await deps.existingKeys([...keys]);
        } catch {
          // The writer is idempotent: an unreadable pre-check only costs
          // extra writer calls. Counted, never hidden.
          counts.precheck_errors++;
        }
      }
      // A dry run asks which new rows another writer already saved, so it
      // reports what a real run would save (the real door skips them).
      let copies = new Set<string>();
      if (req.dryRun && deps.copiesOf) {
        const fresh = rows.filter((r) =>
          !existing.has(String(r.provider_message_id))
        );
        if (fresh.length) {
          try {
            copies = await deps.copiesOf(fresh);
          } catch {
            counts.precheck_errors++;
          }
        }
      }
      let timedOut = 0;
      for (const row of rows) {
        const key = String(row.provider_message_id);
        if (copies.has(key)) {
          counts.duplicates++;
          c.duplicates++;
          c.duplicates_other_writer++;
          continue;
        }
        if (existing.has(key)) {
          counts.duplicates++;
          c.duplicates++;
          const stored = ms(existing.get(key));
          const provider = ms(row.event_at);
          if (
            stored !== null && provider !== null &&
            Math.abs(stored - provider) > policy.timeDriftMs
          ) {
            counts.existing_time_differs++;
            c.existing_time_differs++;
          }
          continue;
        }
        if (req.dryRun) {
          counts.would_insert++;
          continue;
        }
        let toWrite = row;
        if (row.event_type === "client.call_logged") {
          const paired = await deps.pairLegacyCall(row);
          toWrite = paired.row;
          if (paired.outcome === "paired") counts.calls_paired_legacy++;
          else if (paired.outcome === "unreadable") {
            counts.call_pair_unreadable++;
          }
        }
        const saved = await deps.capture(toWrite);
        if (saved.outcome === "inserted") {
          counts.inserted++;
          c.inserted++;
          const status = saved.attribution_status ?? null;
          const bucket: ContactCountKey = status && LINKED.has(status)
            ? "placed_on_job"
            : status === "pending_luna"
            ? "pending_review"
            : status === "unplaced"
            ? "unplaced"
            : status === "admin_bucket"
            ? "admin_bucket"
            : "other_status";
          counts[bucket]++;
          c[bucket]++;
        } else if (saved.outcome === "duplicate") {
          counts.duplicates++;
          c.duplicates++;
          if (saved.copy_of_other_writer === true) c.duplicates_other_writer++;
        } else if (saved.outcome === "capture_disabled") {
          return {
            kind: "stop",
            status: "partial",
            code: "capture_disabled",
            stopRun: "capture_disabled",
          };
        } else {
          const code = safeCode(saved.code, "unknown");
          counts.write_errors++;
          c.write_errors++;
          if (STATEMENT_TIMEOUT_CODES.has(code)) {
            // One heavy row: skip it, keep its page for a later run.
            timedOut++;
            timeoutsThisRun++;
            rowsTimeoutSkipped++;
            c.timeout_skipped++;
            if (timeoutsThisRun > policy.maxRowTimeoutsPerContactRun) {
              return {
                kind: "stop",
                status: "partial",
                code: "statement_timeout",
                stopRun: null,
              };
            }
            continue;
          }
          return {
            kind: "stop",
            status: "partial",
            code,
            stopRun: code === "attribution_disabled" ? code : null,
          };
        }
      }
      return { kind: "ok", timedOut };
    };

    // a. Pages kept from earlier runs for rows that timed out: read again
    // (already-saved rows are duplicates), dropped once every row saves,
    // given up after maxRowRetryRuns runs that still time out.
    for (const page of [...retry]) {
      if (deps.now() - started >= policy.timeBudgetMs) {
        return out(
          "partial",
          null,
          point(resume.conversation_id, resume.last_message_id),
        );
      }
      const drop = () => retry.splice(retry.indexOf(page), 1);
      if (page.tries >= policy.maxRowRetryRuns) {
        // Stopped mid-page on its last try: given up without another read.
        drop();
        givenUp++;
        rowsGivenUp++;
        c.timeout_given_up++;
        continue;
      }
      let read;
      try {
        read = await deps.listMessages({
          contactId: contact.contact_id,
          conversationId: page.conversation_id,
          limit: policy.messagePageLimit,
          lastMessageId: page.last_message_id ?? undefined,
        });
      } catch (error) {
        const f = providerFailure(error);
        if (failureStopsRun(f)) {
          return out(
            "partial",
            stopCode(f),
            point(resume.conversation_id, resume.last_message_id),
            stopCode(f),
          );
        }
        page.tries++;
        if (page.tries >= policy.maxRowRetryRuns) {
          drop();
          givenUp++;
          rowsGivenUp++;
          c.timeout_given_up++;
        }
        continue;
      }
      pagesThisRun++;
      counts.message_pages++;
      c.message_pages++;
      counts.items_seen += read.messages.length;
      c.items_seen += read.messages.length;
      const saved = await savePage(read.messages);
      if (saved.kind === "stop") {
        if (saved.code === "statement_timeout") page.tries++;
        return out(
          saved.status,
          saved.code,
          point(resume.conversation_id, resume.last_message_id),
          saved.stopRun,
        );
      }
      if (saved.timedOut === 0) {
        drop();
      } else {
        page.tries++;
        if (page.tries >= policy.maxRowRetryRuns) {
          drop();
          givenUp += saved.timedOut;
          rowsGivenUp += saved.timedOut;
          c.timeout_given_up += saved.timedOut;
        }
      }
    }

    // b. Every conversation of the contact, newest first.
    const conversations: string[] = [];
    let startAfterDate: string | undefined;
    for (let page = 0;; page++) {
      if (page >= policy.maxConversationPages) {
        return out("failed", "conversation_pages_capped", null);
      }
      let list;
      try {
        list = await deps.listConversations({
          contactId: contact.contact_id,
          limit: policy.conversationPageLimit,
          startAfterDate,
        });
      } catch (error) {
        const f = providerFailure(error);
        const keep = resume.done.length > 0 ||
          resume.conversation_id !== null ||
          retry.length > 0;
        if (failureStopsRun(f)) {
          return out(
            keep ? "partial" : "failed",
            stopCode(f),
            keep ? point(resume.conversation_id, resume.last_message_id) : null,
            stopCode(f),
          );
        }
        return out("failed", safeCode(f.code ?? "provider_read_failed"), null);
      }
      counts.conversation_pages++;
      for (const row of list.conversations) {
        const id = text(row.id);
        if (id && !conversations.includes(id)) conversations.push(id);
      }
      if (!list.conversations.length || list.hasMore === false) break;
      if (!list.nextStartAfterDate) {
        // A short page is the end of the list; a full one with no cursor
        // cannot prove it read every conversation.
        if (list.conversations.length < policy.conversationPageLimit) break;
        return out("failed", "conversation_cursor_missing", null);
      }
      startAfterDate = list.nextStartAfterDate;
    }

    // c. Each conversation back to its first message. A resumed load finishes
    // the conversation it stopped in first, then the ones it has not read.
    const order = resume.conversation_id &&
        conversations.includes(resume.conversation_id)
      ? [
        resume.conversation_id,
        ...conversations.filter((id) => id !== resume.conversation_id),
      ]
      : conversations;
    for (const conversationId of order) {
      if (resume.done.includes(conversationId)) continue;
      let lastMessageId = resume.conversation_id === conversationId
        ? (resume.last_message_id ?? undefined)
        : undefined;
      for (;;) {
        if (
          pagesThisRun >= policy.maxMessagePagesPerContact ||
          deps.now() - started >= policy.timeBudgetMs
        ) {
          if (pagesThisRun >= policy.maxMessagePagesPerContact) {
            counts.message_pages_capped++;
          }
          return out(
            "partial",
            null,
            point(conversationId, lastMessageId ?? null),
          );
        }
        let read;
        try {
          read = await deps.listMessages({
            contactId: contact.contact_id,
            conversationId,
            limit: policy.messagePageLimit,
            lastMessageId,
          });
        } catch (error) {
          const f = providerFailure(error);
          if (failureStopsRun(f)) {
            return out(
              "partial",
              stopCode(f),
              point(conversationId, lastMessageId ?? null),
              stopCode(f),
            );
          }
          return out(
            "failed",
            safeCode(f.code ?? "provider_read_failed"),
            null,
          );
        }
        pagesThisRun++;
        counts.message_pages++;
        c.message_pages++;
        const items = read.messages;
        counts.items_seen += items.length;
        c.items_seen += items.length;

        const saved = await savePage(items);
        if (saved.kind === "stop") {
          return out(
            saved.status,
            saved.code,
            point(conversationId, lastMessageId ?? null),
            saved.stopRun,
          );
        }
        if (saved.timedOut > 0) {
          const already = retry.some((p) =>
            p.conversation_id === conversationId &&
            p.last_message_id === (lastMessageId ?? null)
          );
          if (!already) {
            if (retry.length >= policy.maxRetryPages) {
              // No room to remember the page: stop here so it is read again.
              return out(
                "partial",
                "statement_timeout",
                point(conversationId, lastMessageId ?? null),
              );
            }
            retry.push({
              conversation_id: conversationId,
              last_message_id: lastMessageId ?? null,
              tries: 0,
            });
          }
        }

        if (!items.length || read.hasMore === false) break;
        if (!read.nextLastMessageId) {
          counts.message_cursor_missing++;
          // Without a cursor the first message cannot be proved reached.
          if (
            read.hasMore === true || items.length >= policy.messagePageLimit
          ) {
            return out("failed", "message_cursor_missing", null);
          }
          break;
        }
        lastMessageId = read.nextLastMessageId;
      }
      c.conversations_read++;
      counts.conversations_read++;
      resume.done = [...resume.done, conversationId];
      resume.conversation_id = null;
      resume.last_message_id = null;
    }
    // Every conversation read: done, unless timed-out pages still wait.
    if (retry.length) {
      return out("partial", "statement_timeout_retry", point(null, null));
    }
    return out("done", givenUp ? "rows_given_up_after_timeouts" : null, null);
  };

  try {
    for (let i = 0; i < due.contacts.length; i++) {
      const contact = due.contacts[i];
      if (deps.now() - started >= policy.timeBudgetMs) {
        counts.backlog_contacts = due.contacts.length - i;
        break;
      }
      await deps.recordRun({ run_id: run, source, counts });

      const result = await loadContact(contact);
      // Attempted: its GHL reads were spent, so its jobs are charged today.
      chargedJobs += cost(contact);
      pendingJobs -= cost(contact);
      counts[
        result.status === "done"
          ? "contacts_done"
          : result.status === "partial"
          ? "contacts_partial"
          : "contacts_failed"
      ]++;
      if (result.errorCode && result.status !== "done") {
        firstIssue ??= `contact_${result.status}:${result.errorCode}`;
      }
      outcomes.push({
        contact_id: contact.contact_id,
        jobs: contact.jobs,
        status: result.status,
        error_code: result.errorCode,
      });
      if (!req.dryRun) {
        await deps.recordContact({
          contact_id: contact.contact_id,
          run_id: run,
          status: result.status,
          job_ids: contact.job_ids,
          jobs: contact.jobs,
          earliest_message_at: result.earliestMs === null
            ? null
            : new Date(result.earliestMs).toISOString(),
          latest_message_at: result.latestMs === null
            ? null
            : new Date(result.latestMs).toISOString(),
          skipped_calls: result.counts.skipped_call,
          resume: result.resume,
          counts: result.counts,
          error_code: result.errorCode,
          actor: req.actor,
        });
      }
      if (result.stopRun) {
        stop = result.stopRun;
        counts.backlog_contacts = due.contacts.length - i - 1;
        break;
      }
    }
  } catch (error) {
    // A database write refused mid-run fails the run with its code; every
    // contact recorded so far stays recorded.
    stop = safeCode(providerFailure(error).code ?? "run_error");
  }

  const status: "succeeded" | "partial" | "failed" = stop
    ? "failed"
    : firstIssue || counts.backlog_contacts > 0 ||
        counts.contacts_partial > 0 || counts.contacts_failed > 0
    ? "partial"
    : "succeeded";
  const errorCode = stop ?? firstIssue;
  // The refund: the day is charged only for the contacts this run attempted.
  counts.jobs_covered = chargedJobs;
  const quota: Quota = {
    jobs_reserved: reservedJobs,
    jobs_charged: chargedJobs,
    jobs_refunded: Math.max(0, pendingJobs),
    contacts_unreached: due.contacts.length - outcomes.length,
    rows_timeout_skipped: rowsTimeoutSkipped,
    rows_given_up: rowsGivenUp,
    rate_limited: (errorCode ?? "").includes("ghl_rate_limited"),
  };
  await deps.recordRun({
    run_id: run,
    source,
    status,
    counts,
    cursor: { ...runCursor, quota },
    error_code: errorCode,
  });
  return {
    outcome: "ran",
    run_id: run,
    dry_run: req.dryRun,
    status,
    error_code: errorCode,
    counts,
    contacts: outcomes,
    quota,
  };
}
