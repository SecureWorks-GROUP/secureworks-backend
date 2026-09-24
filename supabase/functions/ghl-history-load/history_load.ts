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
//      the day's 100 is strict and never shared by two runs. A dry run reads
//      the same due list without reserving anything (one dry run at a time).
//   4. For each due contact: every GHL conversation of the contact, every
//      message page back to the first message. Each item goes through the one
//      row builder (_shared/evidence/ghl_message.ts) with capture_mode
//      backfill, and is saved through capture_ghl_history_event (checks, then
//      the one writer capture_business_event). The load writes no placement
//      field: the placement-owned trigger places each row at its own GHL time.
//      Calls are saved as client.call_logged rows by the same builder (slice
//      T1); before a call row is written the load records its one legacy
//      client.call_complete row, as every call writer does (ghl_call_pair.ts).
//   5. Per contact, one ledger row (context_ghl_history_contacts): done,
//      partial with a resume point (page/time budget, failed capture, or a
//      stopping message-read failure), or failed with a code (offered again
//      on a later day). A failed capture retains the page input cursor so
//      retry cannot skip the unsaved row. A full conversation page without
//      a cursor, or a nonempty message page claiming more without a cursor,
//      never marks done.
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
};

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

export interface Resume {
  v: 1;
  /** Conversations of this contact already read to their first message. */
  done: string[];
  /** The conversation being read, and the GHL cursor of its next older page. */
  conversation_id: string | null;
  last_message_id: string | null;
}

export interface DueContact {
  contact_id: string;
  job_ids: string[];
  jobs: number;
  prior_status: "done" | "partial" | "failed" | null;
  resume: unknown;
  attempts: number;
  oversized?: boolean;
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
}

export type HistoryCaptureOutcome =
  | {
    outcome: "inserted";
    id?: string;
    attribution_status?: string | null;
    rested?: string;
  }
  | { outcome: "duplicate"; id?: string }
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
    | { outcome: "reserved"; run_id: string; due: DueList }
    | { outcome: "run_in_progress"; run_id: string }
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
  | { outcome: "run_in_progress"; run_id: string }
  | {
    outcome: "ran";
    run_id: string;
    dry_run: boolean;
    status: "succeeded" | "partial" | "failed";
    error_code: string | null;
    counts: Record<string, number>;
    contacts: ContactSummary[];
  };

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
  return {
    v: 1,
    done: r.done as string[],
    conversation_id: text(r.conversation_id),
    last_message_id: text(r.conversation_id) ? text(r.last_message_id) : null,
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
    due = reserved.due;
    runId = reserved.run_id;
  }
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
  // A real run's jobs were counted when it was reserved; they stay counted.
  counts.jobs_covered = req.dryRun ? 0 : due.jobs_offered;

  if (runId === null) {
    runId = await deps.recordRun({
      source,
      status: "running",
      window_to: new Date(started).toISOString(),
      cursor: { v: 1, actor: req.actor },
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
    let earliestMs: number | null = null;
    let latestMs: number | null = null;
    let pagesThisRun = 0;
    const out = (
      status: ContactOutcome["status"],
      errorCode: string | null,
      point: Resume | null,
      stopRun: string | null = null,
    ): ContactOutcome => ({
      status,
      errorCode,
      resume: point,
      counts: c,
      earliestMs,
      latestMs,
      stopRun,
    });

    // a. Every conversation of the contact, newest first.
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
        if (failureStopsRun(f)) {
          return out(
            resume.done.length || resume.conversation_id ? "partial" : "failed",
            stopCode(f),
            resume.done.length || resume.conversation_id ? resume : null,
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

    // b. Each conversation back to its first message. A resumed load finishes
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
          return out("partial", null, {
            v: 1,
            done: resume.done,
            conversation_id: conversationId,
            last_message_id: lastMessageId ?? null,
          });
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
          const point: Resume = {
            v: 1,
            done: resume.done,
            conversation_id: conversationId,
            last_message_id: lastMessageId ?? null,
          };
          if (failureStopsRun(f)) {
            return out("partial", stopCode(f), point, stopCode(f));
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
        for (const row of rows) {
          const key = String(row.provider_message_id);
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
          } else if (saved.outcome === "capture_disabled") {
            return out("partial", "capture_disabled", {
              v: 1,
              done: resume.done,
              conversation_id: conversationId,
              last_message_id: lastMessageId ?? null,
            }, "capture_disabled");
          } else {
            const code = safeCode(saved.code, "unknown");
            counts.write_errors++;
            c.write_errors++;
            return out("partial", code, {
              v: 1,
              done: resume.done,
              conversation_id: conversationId,
              last_message_id: lastMessageId ?? null,
            }, code === "attribution_disabled" ? code : undefined);
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
    return out("done", null, null);
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
  await deps.recordRun({
    run_id: run,
    source,
    status,
    counts,
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
  };
}
