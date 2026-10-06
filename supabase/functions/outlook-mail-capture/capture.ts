// The email reader (context build plan slice EM2; design email.md §2, §7, §8,
// §12). For each selected Outlook source (monitored_mailboxes: enabled and
// status active) it reads inbound and sent mail with the new words of each
// email and saves one evidence row per email through the one row builder
// (_shared/evidence/outlook_mail.ts) and the one SQL writer
// (public.capture_business_event). It never places an email on a job: the
// database ladder does that on insert, as for every capture door. Attachments
// go to the private attachment store (attachments.ts).
//
// Modes (one run row per source per call, in context_capture_runs through
// record_capture_run, named as EM1's contract says):
//   poll     new mail since the source's cursor        outlook_<key>
//   sweep    re-read of the last 48 hours; inserts are
//            mail the poll missed (counts.sweep_misses) outlook_sweep_<key>
//            and when each was received
//            (cursor.miss_received_at)
//   history  bounded backfill of [from, to), at most 60
//            days back, capture_mode backfill, only mail
//            touching a live job (captain ruling 24 Sep) outlook_history_<key>
//
// Cursor (email.md review M5): the pair (window_to, window_end_id) of the last
// email fully processed, plus cursor.ids_at_end (hashes of the ids processed at
// exactly window_to). A caught-up poll starts 10 minutes before window_to (a
// harmless overlap: the key makes a re-read a duplicate). A poll that left
// pages behind (cursor.backlog) starts exactly at window_to and skips what it
// already processed there, so a burst drains over several runs instead of
// re-reading the same page. A history run that was cut short resumes the
// same way. The cursor never moves past an email that failed to save.
//
// Group history (W7, 6 Oct 2026): a group is listed by conversation, newest
// first, so a post-time cursor cannot say where a cut run stopped; the fencing
// group re-read its newest 400 conversations every 5 minutes for a day. A
// group history run walks the conversations instead and records the walk in
// cursor.group (see GroupWalk): every run starts where the last one stopped,
// a conversation cut part way resumes after its last saved post, and the
// window is finished by a pass that sees every conversation in one run. Every
// history run carries its cursor from the start (on its running row, saved
// again every 15 seconds), so a failed or abandoned run hands it on, and a
// run that has not moved yet gets a short grace past the time budget to move
// once. counts.progressed says how far a run moved; the plan's tick
// (trigger_context_email_history, 20261006030000) sets a source aside when
// three calls in a row move nothing. A history window is named by its end
// (history_to): the plan may move its start forward without losing progress.
//
// Old-path copies (gap plan B-1): until the reader's schedule is on, the old
// monitor-inbox path saved inbound inbox mail under its own keys (graph:<id>,
// graph-group:<id>), which never collide with this reader's email:<id> key.
// So before saving an inbound email the reader asks
// context_email_legacy_copy for the old path's row of the same email (same
// sender, same Graph receivedDateTime; or within 2 minutes with the same
// subject, for another mailbox's copy). When one exists the email is not
// saved again (counts.skipped_legacy_copy); its attachments still go to the
// private store, pointed at the old row. Our own mail (outbound, internal) is
// never skipped: its old copy is an inbox copy typed as inbound, the reader's
// row is the correct one.
//
// Sweep misses (lanes health, 6 Oct 2026): the first nightly sweep after a
// source is switched on re-reads 48 hours that began before the source's
// first poll, so some of what it saves was never the poll's to read. The
// sweep keeps counting every insert in counts.sweep_misses and records when
// each was received in cursor.miss_received_at (the oldest
// POLICY.sweepMissTimesMax, times only); the status
// (context_email_capture_status_at, 20261006050000) leaves out mail older
// than the source's first successful poll and counts the rest.
//
// Attachments: a poll handles an email's attachments once; the nightly sweep
// and history runs check them again and retry recorded failures (recheck,
// attachments.ts).
//
// Gates: feature flag email_reader_v1 (this reader's own switch, off by
// default), email_capture_v2 (the email capture program's switch, EM1) and the
// capture lane must all be on; otherwise the call is idle and reads nothing.
//
// Read only towards the mailbox: no send, reply, move, delete or mark-read
// call exists in graph.ts. No model call. Logs and run rows carry codes and
// counts only, never mail text or addresses.

import {
  buildOutlookMailRow,
  type CaptureMode,
  emailAddress,
  type FolderKind,
  isOurAddress,
  ourReferences,
  type OutlookMailItem,
  type OutlookSource,
} from "../_shared/evidence/outlook_mail.ts";
import type { AttachmentResult } from "./attachments.ts";
import type {
  AttachmentHome,
  FolderIds,
  GroupConversation,
  MessagePage,
} from "./graph.ts";

export const EVENT_SOURCE = "outlook-mail-capture";
export const READER_FLAG = "email_reader_v1";
export const PROGRAM_FLAG = "email_capture_v2";

export type Mode = "poll" | "sweep" | "history";

export const POLICY = {
  pollOverlapMs: 10 * 60_000,
  firstPollLookbackMs: 30 * 60_000,
  pollPageSize: 25,
  pollMaxPages: 4,
  sweepWindowMs: 48 * 60 * 60_000,
  bulkPageSize: 50,
  bulkMaxPages: 40,
  historyMaxDays: 60,
  groupMaxConversations: { poll: 25, sweep: 200, history: 400 },
  groupMaxPosts: { poll: 200, sweep: 2000, history: 2000 },
  /** Conversation list pages one group history run may page through (25 a page). */
  groupHistoryMaxPages: 400,
  budgetMs: 120_000,
  /** A history run that has not yet moved its cursor may run this much past the budget to move it once. */
  progressGraceMs: 20_000,
  /** A history run saves its cursor on its running row at most this often. */
  checkpointMs: 15_000,
  runningStaleMs: 10 * 60_000,
  idsAtEndMax: 25,
  /** A sweep records the received time of at most this many misses (the oldest). */
  sweepMissTimesMax: 100,
};

/**
 * The group history walk (W7, 6 Oct 2026). A group is listed as conversations,
 * newest first by lastDeliveredDateTime, never by post time, so a post-time
 * cursor cannot say where a cut run stopped. The walk records it instead:
 * conversations last delivered after `before` (and those exactly at it whose
 * id hash is in `before_ids`) are done in this pass; a conversation cut part
 * way is `conv`, with its last post done (`conv_after`, `conv_ids`). A pass
 * ends at `floor` (the window start). Conversations that received mail after
 * the pass began (`pass_started`) may have moved above `before` unread, so a
 * pass that took more than one run is followed by a top-up pass over just
 * those; a pass that starts and ends in one run finishes the window.
 * Every hash is deps.hash of a Graph id.
 */
export interface GroupWalk {
  floor: string;
  pass_started: string;
  before: string | null;
  before_ids: string[];
  conv: string | null;
  conv_after: string | null;
  conv_ids: string[];
  passes: number;
}

function strList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

/** A run cursor's group walk, or null when absent or malformed. */
export function groupWalkFrom(cursor: unknown): GroupWalk | null {
  const g = (cursor as { group?: unknown } | null)?.group as
    | Record<string, unknown>
    | undefined;
  if (!g || typeof g !== "object") return null;
  const floor = typeof g.floor === "string" && ms(g.floor) !== null
    ? g.floor
    : null;
  const started = typeof g.pass_started === "string" &&
      ms(g.pass_started) !== null
    ? g.pass_started
    : null;
  if (!floor || !started) return null;
  const before = typeof g.before === "string" && ms(g.before) !== null
    ? g.before
    : null;
  const conv = typeof g.conv === "string" ? g.conv : null;
  const convAfter = conv && typeof g.conv_after === "string" &&
      ms(g.conv_after) !== null
    ? g.conv_after
    : null;
  return {
    floor,
    pass_started: started,
    before,
    before_ids: before ? strList(g.before_ids) : [],
    conv: convAfter ? conv : null,
    conv_after: convAfter,
    conv_ids: convAfter ? strList(g.conv_ids) : [],
    passes: typeof g.passes === "number" && Number.isInteger(g.passes) &&
        g.passes >= 0
      ? g.passes
      : 0,
  };
}

export interface SourceRow {
  email: string;
  source_key: string;
  kind: "user" | "group" | "unknown";
  scope_label: string;
  owner_privacy: boolean;
}

export interface RunRow {
  id: string;
  status: "running" | "succeeded" | "partial" | "failed";
  started_at: string;
  updated_at: string;
  window_to: string | null;
  window_end_id: string | null;
  cursor: Record<string, unknown> | null;
}

export type CaptureOutcome =
  | { outcome: "inserted"; id?: string; job_id?: string | null }
  | { outcome: "duplicate"; id?: string; upgraded?: boolean }
  | { outcome: "capture_disabled" }
  | { outcome: "error"; code?: string };

type ListedMessage = MessagePage["items"][number] & { skip?: boolean };

export interface MailReads {
  folderIds(mailbox: string): Promise<FolderIds>;
  listMessages(
    mailbox: string,
    args: {
      fromIso: string;
      toIso?: string | null;
      top: number;
      next?: string | null;
      lean?: boolean;
    },
  ): Promise<MessagePage>;
  messageDetail(
    mailbox: string,
    graphId: string,
  ): Promise<
    { text: string | null; isHtml: boolean; headers: Record<string, string> }
  >;
  resolveGroupId(mail: string): Promise<string | null>;
  listGroupConversations(
    groupId: string,
    next?: string | null,
  ): Promise<{ items: GroupConversation[]; next: string | null }>;
  listGroupThreads(
    groupId: string,
    conversationId: string,
  ): Promise<Array<{ id: string; topic: string | null }>>;
  listGroupPosts(
    groupId: string,
    threadId: string,
    topic: string | null,
  ): Promise<OutlookMailItem[]>;
}

export interface CaptureDeps {
  /** Epoch milliseconds. */
  now(): number;
  flags(): Promise<{ reader: boolean; program: boolean }>;
  captureLaneOn(): Promise<boolean>;
  /** Selected sources: enabled and status active. */
  sources(): Promise<SourceRow[]>;
  supplierDomains(): Promise<Set<string>>;
  jobClientEmails(): Promise<Set<string>>;
  /** Live jobs (captain ruling 24 Sep): their job numbers (upper case) and client emails. */
  historyScope(): Promise<
    { jobNumbers: Set<string>; clientEmails: Set<string> }
  >;
  /** Newest runs of one run source first. Throws when unreadable. */
  latestRuns(runSource: string, limit: number): Promise<RunRow[]>;
  /** record_capture_run. Throws on refusal; returns the run id. */
  recordRun(run: Record<string, unknown>): Promise<string>;
  capture(row: Record<string, unknown>): Promise<CaptureOutcome>;
  /** The old monitor-inbox path's row for the same inbound email, or null. Throws when unreadable. */
  legacyCopy(args: {
    from: string;
    receivedAt: string;
    subject: string;
  }): Promise<string | null>;
  mail: MailReads;
  storeAttachments(args: {
    home: AttachmentHome;
    providerMessageId: string;
    businessEventId: string | null;
    scopeLabel: string;
    /** The sweep and history runs: read the files again, retry failures. */
    recheck: boolean;
  }): Promise<AttachmentResult>;
  hash(text: string): Promise<string>;
}

export interface CaptureRequest {
  mode: Mode;
  /** One source_key; absent means every selected source. */
  source?: string | null;
  /** History window, ISO times. */
  from?: string | null;
  to?: string | null;
}

export interface SourceResult {
  source_key: string;
  run_source: string;
  outcome: "ran" | "busy";
  run_id?: string;
  status?: RunRow["status"];
  error_code?: string | null;
  counts?: Record<string, number>;
}

export type CaptureResult =
  | { outcome: "idle"; reason: string }
  | { outcome: "refused"; code: string }
  | {
    outcome: "ran";
    mode: Mode;
    sources: SourceResult[];
    not_reached: string[];
  };

export function runSourceName(mode: Mode, sourceKey: string): string {
  return mode === "poll"
    ? `outlook_${sourceKey}`
    : mode === "sweep"
    ? `outlook_sweep_${sourceKey}`
    : `outlook_history_${sourceKey}`;
}

/** A provider or database failure's code, safe for a run row (lower case, ids only). */
export function safeCode(e: unknown, fallback = "error"): string {
  const c = (e as { code?: unknown } | null)?.code;
  const s = typeof c === "string" ? c.toLowerCase() : "";
  return /^[a-z0-9][a-z0-9_.:-]{0,100}$/.test(s) ? s : fallback;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function ms(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** Order emails by (time, id), byte order on the id. */
export function byTimeThenId(a: OutlookMailItem, b: OutlookMailItem): number {
  const ta = ms(a.receivedAt) ?? 0;
  const tb = ms(b.receivedAt) ?? 0;
  if (ta !== tb) return ta - tb;
  return a.graphId < b.graphId ? -1 : a.graphId > b.graphId ? 1 : 0;
}

interface StartPoint {
  startMs: number;
  /** Skip emails before this time, and those at it whose id hash is listed. */
  skipBeforeMs: number | null;
  skipIdsAt: Set<string>;
  previousWindowTo: string | null;
}

function startFromRun(run: RunRow, overlapMs: number): StartPoint {
  const to = ms(run.window_to)!;
  const backlog = run.cursor?.backlog === true;
  const ids = Array.isArray(run.cursor?.ids_at_end)
    ? (run.cursor!.ids_at_end as unknown[]).filter((x): x is string =>
      typeof x === "string"
    )
    : [];
  return backlog
    ? {
      startMs: to,
      skipBeforeMs: to,
      skipIdsAt: new Set(ids),
      previousWindowTo: run.window_to,
    }
    : {
      startMs: to - overlapMs,
      skipBeforeMs: null,
      skipIdsAt: new Set(),
      previousWindowTo: run.window_to,
    };
}

class SourceStop extends Error {
  constructor(readonly code: string, readonly status: "failed" | "partial") {
    super(code);
  }
}

/** The history window, refused when malformed, inverted, in the future or older than 60 days. */
export function historyWindow(
  req: CaptureRequest,
  nowMs: number,
): { fromMs: number; toMs: number } | null {
  const from = ms(req.from);
  const to = ms(req.to);
  if (from === null || to === null || from >= to) return null;
  if (to > nowMs) return null;
  if (from < nowMs - POLICY.historyMaxDays * 86_400_000) return null;
  return { fromMs: from, toMs: to };
}

export async function runOutlookCapture(
  deps: CaptureDeps,
  req: CaptureRequest,
): Promise<CaptureResult> {
  const began = deps.now();
  if (!["poll", "sweep", "history"].includes(req.mode)) {
    return { outcome: "refused", code: "mode_invalid" };
  }
  const flags = await deps.flags();
  if (!flags.reader) return { outcome: "idle", reason: `${READER_FLAG}_off` };
  if (!flags.program) return { outcome: "idle", reason: `${PROGRAM_FLAG}_off` };
  if (!(await deps.captureLaneOn())) {
    return { outcome: "idle", reason: "capture_lane_off" };
  }

  let window: { fromMs: number; toMs: number } | null = null;
  if (req.mode === "history") {
    window = historyWindow(req, began);
    if (!window) return { outcome: "refused", code: "history_window_invalid" };
    if (!req.source) {
      return { outcome: "refused", code: "history_needs_source" };
    }
  }

  let sources = (await deps.sources()).filter((s) =>
    s.kind === "user" || s.kind === "group"
  );
  if (req.source) {
    sources = sources.filter((s) => s.source_key === req.source);
    if (sources.length === 0) {
      return { outcome: "refused", code: "source_not_selected" };
    }
  }

  const supplierDomains = await deps.supplierDomains();
  const jobClientEmails = await deps.jobClientEmails();
  const scope = req.mode === "history" ? await deps.historyScope() : null;

  const results: SourceResult[] = [];
  const notReached: string[] = [];
  for (const s of sources) {
    if (deps.now() - began > POLICY.budgetMs) {
      notReached.push(s.source_key);
      continue;
    }
    results.push(
      await runSource(deps, req, s, {
        began,
        window,
        supplierDomains,
        jobClientEmails,
        scope,
      }),
    );
  }
  return {
    outcome: "ran",
    mode: req.mode,
    sources: results,
    not_reached: notReached,
  };
}

interface RunEnv {
  began: number;
  window: { fromMs: number; toMs: number } | null;
  supplierDomains: Set<string>;
  jobClientEmails: Set<string>;
  scope: { jobNumbers: Set<string>; clientEmails: Set<string> } | null;
}

/** History keeps only mail touching a live job: an outside address that is a live job's client email, or a live job number named. */
export function touchesLiveJob(
  row: Record<string, unknown>,
  scope: { jobNumbers: Set<string>; clientEmails: Set<string> },
): boolean {
  const p = row.payload as Record<string, unknown>;
  const addrs = [
    p.from,
    ...(p.to as unknown[] ?? []),
    ...(p.cc as unknown[] ?? []),
  ]
    .map((a) => emailAddress(String(a ?? "")))
    .filter((a): a is string => !!a && !isOurAddress(a));
  if (addrs.some((a) => scope.clientEmails.has(a))) return true;
  const refs = ourReferences(String(p.body ?? "")).map((r) => r.toUpperCase());
  return refs.some((r) =>
    scope.jobNumbers.has(r) ||
    scope.jobNumbers.has(r.replace(/^([A-Z]+)(\d)/, "$1-$2"))
  );
}

async function runSource(
  deps: CaptureDeps,
  req: CaptureRequest,
  s: SourceRow,
  env: RunEnv,
): Promise<SourceResult> {
  const runSource = runSourceName(req.mode, s.source_key);
  const nowMs = deps.now();
  const recent = await deps.latestRuns(runSource, 10);
  const running = recent.find((r) => r.status === "running");
  if (running) {
    if (nowMs - (ms(running.updated_at) ?? 0) < POLICY.runningStaleMs) {
      return {
        source_key: s.source_key,
        run_source: runSource,
        outcome: "busy",
      };
    }
    // An abandoned run (worker stopped mid-run): close it so it never reads as running.
    await deps.recordRun({
      run_id: running.id,
      source: runSource,
      status: "failed",
      error_code: "abandoned",
    });
    running.status = "failed";
  }

  // Where to start, and what to skip at the start.
  let start: StartPoint;
  let endMs: number | null = null;
  let resume: RunRow | null = null;
  const historyKey = env.window
    ? { history_from: iso(env.window.fromMs), history_to: iso(env.window.toMs) }
    : null;
  if (req.mode === "poll") {
    const last = recent.find((r) => r.status !== "running" && r.window_to);
    start = last ? startFromRun(last, POLICY.pollOverlapMs) : {
      startMs: nowMs - POLICY.firstPollLookbackMs,
      skipBeforeMs: null,
      skipIdsAt: new Set(),
      previousWindowTo: null,
    };
  } else if (req.mode === "sweep") {
    start = {
      startMs: nowMs - POLICY.sweepWindowMs,
      skipBeforeMs: null,
      skipIdsAt: new Set(),
      previousWindowTo: null,
    };
    endMs = nowMs;
  } else {
    // Resume from the newest finished run of this window unless it finished
    // the window. The window is named by its end (history_to): the plan may
    // move history_from forward when a long load nears the 60-day limit, and
    // that must not throw the progress away. Every history run, whether
    // succeeded, cut, failed or abandoned, carries the cursor it reached (or
    // the one it started from), so the newest run is enough.
    const fresh: StartPoint = {
      startMs: env.window!.fromMs,
      skipBeforeMs: null,
      skipIdsAt: new Set(),
      previousWindowTo: null,
    };
    const newest = recent.find((r) =>
      r.status !== "running" &&
      r.cursor?.history_to === historyKey!.history_to
    );
    resume = newest && newest.status !== "succeeded" ? newest : null;
    start = resume && resume.window_to && s.kind === "user"
      ? startFromRun({
        ...resume,
        cursor: { ...resume.cursor, backlog: true },
      }, 0)
      : fresh;
    // A cursor before a moved window start starts at the new start.
    if (start.startMs < env.window!.fromMs) start = fresh;
    endMs = env.window!.toMs;
  }

  // A group's history walk: resumed from the cursor, or a new first pass.
  const runStartIso = iso(nowMs);
  let walk: GroupWalk | null = null;
  if (req.mode === "history" && s.kind === "group") {
    walk = (resume ? groupWalkFrom(resume.cursor) : null) ?? {
      floor: iso(env.window!.fromMs),
      pass_started: runStartIso,
      before: null,
      before_ids: [],
      conv: null,
      conv_after: null,
      conv_ids: [],
      passes: 0,
    };
    if (ms(walk.floor)! < env.window!.fromMs) {
      walk = { ...walk, floor: iso(env.window!.fromMs) };
    }
  }

  const counts: Record<string, number> = {
    seen: 0,
    inserted: 0,
    duplicates: 0,
    upgraded: 0,
    skipped_noise: 0,
    skipped_private: 0,
    skipped_folder: 0,
    skipped_no_sender: 0,
    skipped_out_of_scope: 0,
    skipped_legacy_copy: 0,
    skipped_before_cursor: 0,
    no_internet_id: 0,
    body_truncated: 0,
    detail_reads: 0,
    pages: 0,
    attachments_stored: 0,
    attachments_skipped: 0,
    attachment_errors: 0,
    progressed: 0,
  };
  if (req.mode === "sweep") counts.sweep_misses = 0;
  if (walk) {
    counts.conversations_read = 0;
    counts.conversations_skipped = 0;
    counts.conversations_undated = 0;
  }
  const captureMode: CaptureMode = req.mode === "history" ? "backfill" : "live";
  const source: OutlookSource = {
    email: s.email,
    sourceKey: s.source_key,
    kind: s.kind as "user" | "group",
    scopeLabel: s.scope_label,
    ownerPrivacy: s.owner_privacy === true,
  };

  // A sweep: when each email it had to save was received (epoch ms).
  const missTimes: number[] = [];

  // Progress: the last email fully processed.
  let lastMs: number | null = null;
  let lastId: string | null = null;
  let idsAtEnd: string[] = [];
  let backlog = false;
  let readComplete = true;
  let stop: SourceStop | null = null;

  // Where the cursor stands now: the last email fully processed, or for a
  // group history the walk. A group poll or sweep that could not list every
  // changed conversation keeps the previous cursor, so the unread
  // conversations are not jumped over.
  const progressFields = (): Record<string, unknown> => {
    let windowTo: string | null = null;
    let windowEndId: string | null = null;
    let cursorIds: string[] = [];
    if (walk) {
      const b = ms(walk.before);
      if (b !== null && b >= start.startMs) windowTo = walk.before;
    } else if (lastMs !== null && readComplete) {
      windowTo = iso(lastMs);
      windowEndId = lastId;
      cursorIds = idsAtEnd;
    } else if (start.previousWindowTo) {
      windowTo = start.previousWindowTo;
      cursorIds = [...start.skipIdsAt];
    } else if (!stop && readComplete && req.mode === "poll") {
      windowTo = iso(start.startMs);
    }
    const out: Record<string, unknown> = {
      cursor: {
        mode: req.mode,
        backlog: backlog || !readComplete,
        ids_at_end: cursorIds,
        ...(historyKey ?? {}),
        ...(walk ? { group: walk } : {}),
        ...(req.mode === "sweep"
          ? {
            miss_received_at: [...missTimes].sort((a, b) => a - b).slice(
              0,
              POLICY.sweepMissTimesMax,
            ).map(iso),
          }
          : {}),
      },
    };
    if (windowTo) {
      out.window_to = windowTo;
      if (windowEndId) out.window_end_id = windowEndId;
    }
    return out;
  };

  // A history run's running row carries its starting cursor from the first
  // moment, so even a run the worker abandons hands it on.
  const runId = await deps.recordRun({
    source: runSource,
    status: "running",
    window_from: iso(start.startMs),
    ...(req.mode === "history" ? progressFields() : {}),
  });
  let lastCheckpoint = nowMs;
  // A long history run saves its cursor on its running row as it goes.
  const checkpoint = async (): Promise<void> => {
    if (req.mode !== "history") return;
    const t = deps.now();
    if (t - lastCheckpoint < POLICY.checkpointMs) return;
    lastCheckpoint = t;
    await deps.recordRun({
      run_id: runId,
      source: runSource,
      status: "running",
      counts: { ...counts },
      ...progressFields(),
    });
  };

  const process = async (
    item: ListedMessage | OutlookMailItem,
    home: AttachmentHome,
  ): Promise<void> => {
    counts.seen++;
    const t = ms(item.receivedAt) ?? 0;
    if (start.skipBeforeMs !== null) {
      if (t < start.skipBeforeMs) {
        counts.skipped_before_cursor++;
        return;
      }
      if (
        t === start.skipBeforeMs &&
        start.skipIdsAt.has(await deps.hash(item.graphId))
      ) {
        counts.skipped_before_cursor++;
        return;
      }
    }
    const advance = async () => {
      const h = await deps.hash(item.graphId);
      if (lastMs === t) idsAtEnd = [...idsAtEnd, h].slice(-POLICY.idsAtEndMax);
      else idsAtEnd = [h];
      lastMs = t;
      lastId = item.graphId;
      counts.progressed++;
    };
    const listed = item as ListedMessage;
    if (listed.skip) {
      counts.skipped_folder++;
      await advance();
      return;
    }
    if (listed.detailRead === false) {
      try {
        const d = await deps.mail.messageDetail(s.email, item.graphId);
        counts.detail_reads++;
        item = {
          ...item,
          bodyText: d.text,
          bodyIsHtml: d.isHtml,
          headers: d.headers,
        };
      } catch (e) {
        throw new SourceStop(safeCode(e, "graph_error"), "failed");
      }
    }
    const built = buildOutlookMailRow(item, source, {
      source: EVENT_SOURCE,
      captureMode,
      supplierDomains: env.supplierDomains,
      jobClientEmails: env.jobClientEmails,
    });
    if (built.kind === "skip") {
      if (built.reason === "skipped_noise") counts.skipped_noise++;
      else if (built.reason === "skipped_private") counts.skipped_private++;
      else counts.skipped_no_sender++;
      await advance();
      return;
    }
    if (env.scope && !touchesLiveJob(built.row, env.scope)) {
      counts.skipped_out_of_scope++;
      await advance();
      return;
    }
    const payload = built.row.payload as Record<string, unknown>;
    if (
      built.row.direction === "inbound" && item.receivedAt &&
      item.folderKind !== "sent"
    ) {
      let legacyId: string | null;
      try {
        legacyId = await deps.legacyCopy({
          from: String(payload.from),
          receivedAt: item.receivedAt,
          subject: String(payload.subject ?? ""),
        });
      } catch (e) {
        throw new SourceStop(safeCode(e, "legacy_copy_unreadable"), "failed");
      }
      if (legacyId) {
        counts.skipped_legacy_copy++;
        if (item.hasAttachments) {
          const a = await deps.storeAttachments({
            home,
            providerMessageId: String(built.row.provider_message_id),
            businessEventId: legacyId,
            scopeLabel: s.scope_label,
            recheck: req.mode !== "poll",
          });
          counts.attachments_stored += a.stored;
          counts.attachments_skipped += a.skipped;
          counts.attachment_errors += a.errors;
        }
        await advance();
        return;
      }
    }
    const out = await deps.capture(built.row);
    if (out.outcome === "capture_disabled") {
      throw new SourceStop("capture_disabled", "partial");
    }
    if (out.outcome === "error") {
      throw new SourceStop(
        `capture_${safeCode({ code: out.code }, "error")}`.slice(0, 110),
        "failed",
      );
    }
    if (out.outcome === "inserted") {
      counts.inserted++;
      if (req.mode === "sweep") {
        counts.sweep_misses++;
        // An unreadable time is left off the list; the status counts it.
        const at = ms(item.receivedAt);
        if (at !== null) missTimes.push(at);
      }
    } else {
      counts.duplicates++;
      if (out.upgraded) counts.upgraded++;
    }
    if ((built.row.metadata as Record<string, unknown>).no_internet_id) {
      counts.no_internet_id++;
    }
    if (payload.body_truncated) counts.body_truncated++;
    if (item.hasAttachments) {
      const a = await deps.storeAttachments({
        home,
        providerMessageId: String(built.row.provider_message_id),
        businessEventId: out.id ?? null,
        scopeLabel: s.scope_label,
        recheck: req.mode !== "poll",
      });
      counts.attachments_stored += a.stored;
      counts.attachments_skipped += a.skipped;
      counts.attachment_errors += a.errors;
    }
    await advance();
  };

  // Past the time budget, a run stops. A history run that has not moved its
  // cursor yet gets a short grace to move it once, so no run is wasted.
  const overBudget = (): boolean => {
    const spent = deps.now() - env.began;
    if (spent <= POLICY.budgetMs) return false;
    return req.mode !== "history" || counts.progressed > 0 ||
      spent > POLICY.budgetMs + POLICY.progressGraceMs;
  };

  // One conversation of a group history walk: its posts inside the window,
  // oldest first, after the cut point when it was cut before. True when
  // finished (the walk moves past it), false when cut part way (the walk
  // records the last post done).
  const readConversation = async (
    groupId: string,
    c: GroupConversation,
    last: number,
    budget: { conversations: number; posts: number },
  ): Promise<boolean> => {
    const { fromMs, toMs } = env.window!;
    const h = await deps.hash(c.id);
    const posts: Array<{ post: OutlookMailItem; threadId: string }> = [];
    for (const th of await deps.mail.listGroupThreads(groupId, c.id)) {
      for (
        const p of await deps.mail.listGroupPosts(groupId, th.id, th.topic)
      ) {
        const t = ms(p.receivedAt);
        if (t === null || t < fromMs || t >= toMs) continue;
        posts.push({ post: p, threadId: th.id });
      }
    }
    posts.sort((a, b) => byTimeThenId(a.post, b.post));
    const after = walk!.conv === h ? ms(walk!.conv_after) : null;
    const doneAt = new Set(after !== null ? walk!.conv_ids : []);
    for (const { post, threadId } of posts) {
      const t = ms(post.receivedAt)!;
      const ph = await deps.hash(post.graphId);
      if (after !== null && (t < after || (t === after && doneAt.has(ph)))) {
        counts.skipped_before_cursor++;
        continue;
      }
      if (budget.posts <= 0 || overBudget()) return false;
      await process(post, {
        kind: "post",
        groupId,
        threadId,
        postId: post.graphId,
      });
      budget.posts--;
      const at = iso(t);
      walk = {
        ...walk!,
        conv: h,
        conv_after: at,
        conv_ids: walk!.conv === h && walk!.conv_after === at
          ? [...walk!.conv_ids, ph].slice(-POLICY.idsAtEndMax)
          : [ph],
      };
    }
    const before = ms(walk!.before);
    walk = {
      ...walk!,
      before: iso(last),
      before_ids: before === last
        ? [...walk!.before_ids, h].slice(-POLICY.idsAtEndMax)
        : [h],
      conv: null,
      conv_after: null,
      conv_ids: [],
    };
    budget.conversations--;
    counts.conversations_read++;
    counts.progressed++;
    return true;
  };

  // The group history walk (see GroupWalk). True when the window is finished.
  const walkGroupHistory = async (groupId: string): Promise<boolean> => {
    const budget = {
      conversations: POLICY.groupMaxConversations.history,
      posts: POLICY.groupMaxPosts.history,
    };
    for (;;) {
      const floorMs = ms(walk!.floor)!;
      let passDone = false;
      let next: string | null = null;
      list: for (let page = 0; page < POLICY.groupHistoryMaxPages; page++) {
        if (overBudget()) return false;
        const got = await deps.mail.listGroupConversations(groupId, next);
        counts.pages++;
        for (const c of got.items) {
          const last = ms(c.lastDeliveredDateTime);
          if (last === null) {
            counts.conversations_undated++;
            continue;
          }
          if (last < floorMs) {
            passDone = true;
            break list;
          }
          const before = ms(walk!.before);
          if (
            before !== null &&
            (last > before ||
              (last === before &&
                walk!.before_ids.includes(await deps.hash(c.id))))
          ) {
            counts.conversations_skipped++;
            continue;
          }
          if (
            budget.conversations <= 0 || budget.posts <= 0 || overBudget()
          ) return false;
          if (!(await readConversation(groupId, c, last, budget))) {
            return false;
          }
          await checkpoint();
        }
        next = got.next;
        if (!next) {
          passDone = true;
          break;
        }
      }
      if (!passDone) return false;
      counts.progressed++;
      // A pass begun in this run saw every conversation in one go: done.
      if (walk!.pass_started === runStartIso) return true;
      // Otherwise read once more what received mail since the pass began.
      walk = {
        floor: walk!.pass_started,
        pass_started: runStartIso,
        before: null,
        before_ids: [],
        conv: null,
        conv_after: null,
        conv_ids: [],
        passes: walk!.passes + 1,
      };
    }
  };

  try {
    if (s.kind === "user") {
      const folders = await deps.mail.folderIds(s.email).catch((e) => {
        throw new SourceStop(safeCode(e, "graph_error"), "failed");
      });
      const skipFolders = new Set(
        [folders.junk, folders.drafts, folders.outbox].filter((
          x,
        ): x is string => !!x),
      );
      const kindOf = (folderId: string | null | undefined): FolderKind =>
        folderId && folderId === folders.sent
          ? "sent"
          : folderId && folderId === folders.deleted
          ? "deleted"
          : "inbox";
      const pageSize = req.mode === "poll"
        ? POLICY.pollPageSize
        : POLICY.bulkPageSize;
      const maxPages = req.mode === "poll"
        ? POLICY.pollMaxPages
        : POLICY.bulkMaxPages;
      let next: string | null = null;
      let lean = false;
      for (let page = 0; page < maxPages; page++) {
        if (overBudget()) {
          backlog = true;
          break;
        }
        let got: MessagePage;
        try {
          got = await deps.mail.listMessages(s.email, {
            fromIso: iso(start.startMs),
            toIso: endMs === null ? null : iso(endMs),
            top: pageSize,
            next,
            lean,
          });
        } catch (e) {
          // Graph may refuse uniqueBody or headers on a list call: read them per message instead.
          if (!lean && page === 0 && safeCode(e) === "graph_400") {
            lean = true;
            page--;
            continue;
          }
          throw new SourceStop(safeCode(e, "graph_error"), "failed");
        }
        counts.pages++;
        const items = got.items.map((m) => ({
          ...m,
          folderKind: kindOf(m.parentFolderId),
          skip: m.isDraft === true ||
            (!!m.parentFolderId && skipFolders.has(m.parentFolderId)),
        })).sort(byTimeThenId);
        let cut = false;
        for (let i = 0; i < items.length; i++) {
          await process(items[i], {
            kind: "message",
            mailbox: s.email,
            messageId: items[i].graphId,
          });
          if (i < items.length - 1 && overBudget()) {
            cut = true;
            break;
          }
        }
        next = got.next;
        if (cut) {
          backlog = true;
          break;
        }
        if (!next) break;
        if (page === maxPages - 1) backlog = true;
        await checkpoint();
      }
    } else if (walk) {
      const groupId = await deps.mail.resolveGroupId(s.email).catch((e) => {
        throw new SourceStop(safeCode(e, "graph_error"), "failed");
      });
      if (!groupId) throw new SourceStop("group_not_found", "failed");
      try {
        backlog = !(await walkGroupHistory(groupId));
      } catch (e) {
        if (e instanceof SourceStop) throw e;
        throw new SourceStop(safeCode(e, "graph_error"), "failed");
      }
    } else {
      const groupId = await deps.mail.resolveGroupId(s.email).catch((e) => {
        throw new SourceStop(safeCode(e, "graph_error"), "failed");
      });
      if (!groupId) throw new SourceStop("group_not_found", "failed");
      const maxConv = POLICY.groupMaxConversations[req.mode];
      const maxPosts = POLICY.groupMaxPosts[req.mode];
      const posts: Array<{ post: OutlookMailItem; threadId: string }> = [];
      let conversations = 0;
      let next: string | null = null;
      try {
        outer: for (let page = 0; page < 50; page++) {
          const got = await deps.mail.listGroupConversations(groupId, next);
          counts.pages++;
          for (const c of got.items) {
            const last = ms(c.lastDeliveredDateTime);
            if (last !== null && last < start.startMs) break outer;
            if (conversations >= maxConv || overBudget()) {
              readComplete = false;
              break outer;
            }
            conversations++;
            for (const th of await deps.mail.listGroupThreads(groupId, c.id)) {
              for (
                const p of await deps.mail.listGroupPosts(
                  groupId,
                  th.id,
                  th.topic,
                )
              ) {
                const t = ms(p.receivedAt);
                if (t === null || t < start.startMs) continue;
                if (endMs !== null && t >= endMs) continue;
                posts.push({ post: p, threadId: th.id });
              }
            }
          }
          next = got.next;
          if (!next) break;
        }
      } catch (e) {
        if (e instanceof SourceStop) throw e;
        throw new SourceStop(safeCode(e, "graph_error"), "failed");
      }
      posts.sort((a, b) => byTimeThenId(a.post, b.post));
      const take = posts.slice(0, maxPosts);
      if (posts.length > take.length) backlog = true;
      for (let i = 0; i < take.length; i++) {
        await process(take[i].post, {
          kind: "post",
          groupId,
          threadId: take[i].threadId,
          postId: take[i].post.graphId,
        });
        if (i < take.length - 1 && overBudget()) {
          backlog = true;
          break;
        }
      }
    }
  } catch (e) {
    stop = e instanceof SourceStop
      ? e
      : new SourceStop(safeCode(e, "error"), "failed");
  }

  if (!readComplete) backlog = true;
  const status: RunRow["status"] = stop
    ? stop.status
    : backlog && req.mode !== "poll"
    ? "partial"
    : "succeeded";
  await deps.recordRun({
    run_id: runId,
    source: runSource,
    status,
    counts,
    error_code: stop ? stop.code : null,
    ...progressFields(),
  });
  return {
    source_key: s.source_key,
    run_source: runSource,
    outcome: "ran",
    run_id: runId,
    status,
    error_code: stop ? stop.code : null,
    counts,
  };
}
