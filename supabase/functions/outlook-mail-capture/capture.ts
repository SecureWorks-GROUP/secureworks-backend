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
//   deep     the deep history load (history depth, 7
//            Oct 2026): one slice [from, to) of any age
//            back to the hard floor, as history, but only
//            mail touching a monitored live job from 30
//            days before that job's first record, and
//            every row marked metadata.history_tier deep
//                                                      outlook_deep_history_<key>
//   deep with probe: true   counts only, by month (see runDeepProbe); no
//            row of any kind is written                (none)
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
// each was received in cursor.miss_received_at (the newest
// POLICY.sweepMissTimesMax, times only, a null for a time it could not read;
// sweepMissList); the status (context_email_capture_status_at,
// 20261006050000) leaves out mail older than the source's first successful
// poll and counts the rest. Keeping the newest means every miss past the list
// is older than every listed one, so a busy mailbox's first sweep, all of it
// from before its first poll, counts nothing.
//
// Attachments: a poll handles an email's attachments once; the nightly sweep
// and history runs check them again and retry recorded failures (recheck,
// attachments.ts).
//
// The deep history load (history depth, 7 Oct 2026): the 60-day limit is this
// reader's own rule, not Microsoft's. Mode deep reads one slice of a mailbox,
// of any age back to the policy's hard floor, chosen by the plan's tick
// (trigger_context_email_deep_history, 20261007080000), which walks each
// mailbox backwards from its first live window: a user mailbox in slices of at
// most 32 days, a group in one window walked conversation by conversation
// exactly as W7's group history.
// Everything else is the history path: the cursor, the resume (a deep window is
// named by its start AND its end, because the plan can re-read a period with
// the same end), the checkpoints, the grace, counts.progressed, backfill rows.
// What it keeps is narrower than history: an email touching a monitored live
// job (context_email_deep_scope: the job's number named, its client's email
// among the outside addresses, or its builder's reference named), received on
// or after 30 days before that job's first record (a key shared by several
// jobs takes the earliest). Mail matching a key but older than every such job
// is skipped (counts.skipped_before_job). Every deep row carries
// metadata.history_tier deep, so AI placement never asks about it. The privacy,
// noise, folder, draft and old-path copy rules are the same as every mode's.
// It runs only while flag email_reader_deep_v1 is on (context_email_deep_enabled),
// and never reads before the policy's hard floor.
//
// Builder references: every row of every mode carries payload.builder_refs
// (_shared/makesafe_refs.ts builderRefTokens over the prefix set loaded once a
// call), so the ladder can place a builder's email by its reference.
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
import {
  builderRefTokens,
  REF_PREFIX_FLOOR,
} from "../_shared/makesafe_refs.ts";
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
export const DEEP_FLAG = "email_reader_deep_v1";

export type Mode = "poll" | "sweep" | "history" | "deep";

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
  /** A sweep records the received time of at most this many misses (the newest). */
  sweepMissTimesMax: 100,
  /** The longest deep window of a user mailbox when the gate does not say (the plan's slices are 31 days). */
  deepUserWindowMaxDays: 32,
  /** Lean pages (50 a page) the probe lists in each month of a user mailbox. */
  probeMonthPages: 2,
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

/** The deep load's switch and bounds (context_email_deep_enabled). */
export interface DeepGate {
  /** Flag email_reader_deep_v1. The probe does not need it. */
  enabled: boolean;
  /** No deep window may start before this (epoch ms). */
  hardFloorMs: number;
  userWindowMaxDays: number;
}

/**
 * What the deep load keeps (context_email_deep_scope): each key of a
 * monitored live job, with the earliest time mail for it is kept (epoch ms,
 * 30 days before the first record of the oldest job carrying the key). Job
 * numbers upper case, client emails lower case, builder references as
 * builderRefTokens gives them.
 */
export interface DeepScope {
  version: string;
  jobs: number;
  jobNumbers: Map<string, number>;
  clientEmails: Map<string, number>;
  builderRefs: Map<string, number>;
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
  /** The deep load's flag and bounds. Throws when unreadable. */
  deepGate(): Promise<DeepGate>;
  /** The monitored live jobs' keys and their earliest times. Throws when unreadable. */
  deepScope(): Promise<DeepScope>;
  /** The make-safe reference prefix set, or null when it cannot be read (the floor is used). */
  builderRefPrefixes(): Promise<string[] | null>;
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
  /** Mode deep only: list the window and count by month, write nothing. */
  probe?: boolean;
}

/**
 * The deep probe's answer (go point G6): how much mail Graph gives for a
 * window, by Perth month, so a person can see how far back a mailbox reaches
 * before anything is saved. Counts and times only. A user mailbox lists at
 * most POLICY.probeMonthPages pages (50 a page) of each month (`more`: there
 * was more); a group counts conversations by the month they were last
 * delivered.
 */
export interface ProbeResult {
  outcome: "probe";
  source_key: string;
  kind: "user" | "group";
  from: string;
  to: string;
  /** False when the time budget or an error stopped it. */
  complete: boolean;
  months: Record<string, { seen: number; more: boolean }>;
  /** User mailbox: messages by folder kind (skipped = junk, drafts, outbox). Group: conversations. */
  folders: Record<string, number>;
  oldest_seen: string | null;
  newest_seen: string | null;
  reads: number;
  error_code: string | null;
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
  | ProbeResult
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
    : mode === "deep"
    ? `outlook_deep_history_${sourceKey}`
    : `outlook_history_${sourceKey}`;
}

/** History and deep runs share the history path: a fixed window, a resumable cursor, backfill rows. */
function isHistoryLike(mode: Mode): boolean {
  return mode === "history" || mode === "deep";
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

/**
 * A sweep's cursor.miss_received_at: a null for each miss whose received time
 * could not be read (it always counts), then the newest readable times,
 * oldest first, at most max entries in all. Every miss left off is older
 * than the oldest listed time, so the status
 * (context_email_capture_status_at, 20261006050000) can leave those out when
 * that time is before the source's first poll, and counts them otherwise.
 */
export function sweepMissList(
  times: Array<number | null>,
  max: number = POLICY.sweepMissTimesMax,
): Array<string | null> {
  const unknown = times.filter((t) => t === null).length;
  const nulls = Math.min(unknown, max);
  const known = times.filter((t): t is number => t !== null).sort((a, b) =>
    a - b
  );
  const room = max - nulls;
  return [
    ...Array.from({ length: nulls }, () => null),
    ...(room > 0 ? known.slice(-room) : []).map(iso),
  ];
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

/**
 * A deep window: [from, to) not before the gate's hard floor, to not in the
 * future, and a user mailbox's window at most the gate's longest (the plan's
 * slices are 31 days); a group's window may be any length, because a group is
 * walked conversation by conversation and reads every newer conversation
 * anyway. The probe may span any length for either kind.
 */
export function deepWindow(
  req: CaptureRequest,
  nowMs: number,
  gate: DeepGate,
  kind: "user" | "group",
): { ok: true; fromMs: number; toMs: number } | { ok: false; code: string } {
  const from = ms(req.from);
  const to = ms(req.to);
  if (from === null || to === null || from >= to || to > nowMs) {
    return { ok: false, code: "deep_window_invalid" };
  }
  if (!(from >= gate.hardFloorMs)) {
    return { ok: false, code: "deep_window_before_floor" };
  }
  const maxDays = gate.userWindowMaxDays > 0
    ? gate.userWindowMaxDays
    : POLICY.deepUserWindowMaxDays;
  if (!req.probe && kind === "user" && to - from > maxDays * 86_400_000) {
    return { ok: false, code: "deep_window_too_long" };
  }
  return { ok: true, fromMs: from, toMs: to };
}

export async function runOutlookCapture(
  deps: CaptureDeps,
  req: CaptureRequest,
): Promise<CaptureResult> {
  const began = deps.now();
  if (!["poll", "sweep", "history", "deep"].includes(req.mode)) {
    return { outcome: "refused", code: "mode_invalid" };
  }
  if (req.probe && req.mode !== "deep") {
    return { outcome: "refused", code: "probe_needs_deep_mode" };
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
  let gate: DeepGate | null = null;
  if (req.mode === "deep") {
    if (!req.source) return { outcome: "refused", code: "deep_needs_source" };
    gate = await deps.deepGate();
    // The probe writes nothing and is how the owner sees how far a mailbox
    // reaches before the load is switched on (go point G6).
    if (!gate.enabled && !req.probe) {
      return { outcome: "idle", reason: `${DEEP_FLAG}_off` };
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
  if (gate) {
    const d = deepWindow(req, began, gate, sources[0].kind as "user" | "group");
    if (!d.ok) return { outcome: "refused", code: d.code };
    window = { fromMs: d.fromMs, toMs: d.toMs };
    if (req.probe) return await runDeepProbe(deps, sources[0], window, began);
  }

  const supplierDomains = await deps.supplierDomains();
  const jobClientEmails = await deps.jobClientEmails();
  const scope = req.mode === "history" ? await deps.historyScope() : null;
  const deepScope = req.mode === "deep" ? await deps.deepScope() : null;
  const loaded = await deps.builderRefPrefixes();
  const prefixes = loaded ?? [...REF_PREFIX_FLOOR];

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
        deepScope,
        prefixes,
        prefixesFloorOnly: loaded === null,
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
  deepScope: DeepScope | null;
  /** The make-safe reference prefixes for payload.builder_refs and the deep scope. */
  prefixes: readonly string[];
  /** The company prefixes could not be read: the floor was used. */
  prefixesFloorOnly: boolean;
}

export type DeepDecision =
  | { keep: true; by: "job_number" | "builder_ref" | "client_email" }
  | { keep: false; reason: "skipped_before_job" | "skipped_out_of_scope" };

/**
 * The deep load keeps an email touching a monitored live job: it names the
 * job's number, or its builder's reference (the subject's bare 5-digit
 * numbers count, extractRef's fallback order, never the words'), or one of
 * its outside addresses is the job's client email; and it was received on or
 * after that key's time (30 days before the first record of the oldest job
 * carrying it). A key matched only by mail older than every such time is
 * skipped_before_job; no key at all is skipped_out_of_scope. Pure.
 */
export function deepScopeDecision(
  row: Record<string, unknown>,
  atMs: number,
  scope: DeepScope,
  prefixes: readonly string[],
): DeepDecision {
  const p = row.payload as Record<string, unknown>;
  const body = String(p.body ?? "");
  let matched = false;
  const at = (m: Map<string, number>, k: string): boolean => {
    const from = m.get(k);
    if (from === undefined) return false;
    matched = true;
    return atMs >= from;
  };
  for (const r of ourReferences(body).map((x) => x.toUpperCase())) {
    if (
      at(scope.jobNumbers, r) ||
      at(scope.jobNumbers, r.replace(/^([A-Z]+)(\d)/, "$1-$2"))
    ) return { keep: true, by: "job_number" };
  }
  const refs = new Set([
    ...builderRefTokens(body, prefixes),
    ...builderRefTokens(String(p.subject ?? ""), prefixes, {
      bareNumeric: true,
    }),
  ]);
  for (const r of refs) {
    if (at(scope.builderRefs, r)) return { keep: true, by: "builder_ref" };
  }
  const addrs = [
    p.from,
    ...(p.to as unknown[] ?? []),
    ...(p.cc as unknown[] ?? []),
  ]
    .map((a) => emailAddress(String(a ?? "")))
    .filter((a): a is string => !!a && !isOurAddress(a));
  for (const a of addrs) {
    if (at(scope.clientEmails, a)) return { keep: true, by: "client_email" };
  }
  return {
    keep: false,
    reason: matched ? "skipped_before_job" : "skipped_out_of_scope",
  };
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
    // the one it started from), so the newest run is enough. A deep window is
    // named by its start too: the deep plan may read a period again with the
    // same end and an earlier start (a job that joined later), and resuming a
    // cursor from the narrower window would skip the start of the wider one.
    const fresh: StartPoint = {
      startMs: env.window!.fromMs,
      skipBeforeMs: null,
      skipIdsAt: new Set(),
      previousWindowTo: null,
    };
    const newest = recent.find((r) =>
      r.status !== "running" &&
      r.cursor?.history_to === historyKey!.history_to &&
      (req.mode !== "deep" ||
        r.cursor?.history_from === historyKey!.history_from)
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
  if (isHistoryLike(req.mode) && s.kind === "group") {
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
  if (req.mode === "deep") {
    counts.kept_by_job_number = 0;
    counts.kept_by_builder_ref = 0;
    counts.kept_by_client_email = 0;
    counts.skipped_before_job = 0;
  }
  if (env.prefixesFloorOnly) counts.builder_ref_prefixes_floor_only = 1;
  if (walk) {
    counts.conversations_read = 0;
    counts.conversations_skipped = 0;
    counts.conversations_undated = 0;
  }
  const captureMode: CaptureMode = isHistoryLike(req.mode)
    ? "backfill"
    : "live";
  const source: OutlookSource = {
    email: s.email,
    sourceKey: s.source_key,
    kind: s.kind as "user" | "group",
    scopeLabel: s.scope_label,
    ownerPrivacy: s.owner_privacy === true,
  };

  // A sweep: when each email it had to save was received (epoch ms; null
  // when the time could not be read).
  const missTimes: Array<number | null> = [];

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
        ...(req.mode === "deep" ? { history_tier: "deep" } : {}),
        ...(walk ? { group: walk } : {}),
        ...(req.mode === "sweep"
          ? { miss_received_at: sweepMissList(missTimes) }
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
    ...(isHistoryLike(req.mode) ? progressFields() : {}),
  });
  let lastCheckpoint = nowMs;
  // A long history run saves its cursor on its running row as it goes.
  const checkpoint = async (): Promise<void> => {
    if (!isHistoryLike(req.mode)) return;
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
      builderRefPrefixes: env.prefixes,
      ...(req.mode === "deep" ? { historyTier: "deep" as const } : {}),
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
    if (env.deepScope) {
      const d = deepScopeDecision(built.row, t, env.deepScope, env.prefixes);
      if (!d.keep) {
        counts[d.reason]++;
        await advance();
        return;
      }
      counts[`kept_by_${d.by}`]++;
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
        // An unreadable time is listed as null; the status counts it.
        missTimes.push(ms(item.receivedAt));
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
    return !isHistoryLike(req.mode) || counts.progressed > 0 ||
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
      // Only a poll or a sweep reaches here: history and deep walk the group.
      const liveMode = req.mode as "poll" | "sweep";
      const maxConv = POLICY.groupMaxConversations[liveMode];
      const maxPosts = POLICY.groupMaxPosts[liveMode];
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

const PERTH_OFFSET_MS = 8 * 3_600_000;

/** The Perth month ("2026-07") an instant falls in. Perth keeps UTC+8 all year. */
export function perthMonth(t: number): string {
  return new Date(t + PERTH_OFFSET_MS).toISOString().slice(0, 7);
}

/** The Perth months a window covers, each clipped to the window, oldest first. */
export function perthMonths(
  fromMs: number,
  toMs: number,
): Array<{ label: string; startMs: number; endMs: number }> {
  const out: Array<{ label: string; startMs: number; endMs: number }> = [];
  const first = new Date(fromMs + PERTH_OFFSET_MS);
  let y = first.getUTCFullYear();
  let m = first.getUTCMonth();
  for (;;) {
    const start = Date.UTC(y, m, 1) - PERTH_OFFSET_MS;
    const end = Date.UTC(y, m + 1, 1) - PERTH_OFFSET_MS;
    if (start >= toMs) break;
    out.push({
      label: `${y}-${String(m + 1).padStart(2, "0")}`,
      startMs: Math.max(fromMs, start),
      endMs: Math.min(toMs, end),
    });
    m++;
    if (m === 12) {
      m = 0;
      y++;
    }
  }
  return out;
}

/**
 * The deep probe (go point G6): how much mail Graph gives one mailbox for a
 * window, by Perth month, before anything is saved. Read only: no evidence
 * row, no run row, no attachment, no message body read (a user mailbox is
 * listed lean, a group by its conversation list only). A user mailbox lists at
 * most POLICY.probeMonthPages pages of each month, oldest month first; a group
 * walks its conversations newest first until one was last delivered before the
 * window. Stops at the time budget (complete false). Counts and times only.
 */
export async function runDeepProbe(
  deps: CaptureDeps,
  s: SourceRow,
  window: { fromMs: number; toMs: number },
  began: number,
): Promise<ProbeResult> {
  const kind = s.kind as "user" | "group";
  const months: Record<string, { seen: number; more: boolean }> = {};
  const folders: Record<string, number> = kind === "user"
    ? { inbox: 0, sent: 0, deleted: 0, skipped: 0 }
    : { conversations: 0, undated: 0 };
  let oldest: number | null = null;
  let newest: number | null = null;
  let reads = 0;
  let complete = false;
  let errorCode: string | null = null;
  const saw = (t: number | null) => {
    if (t === null) return;
    if (oldest === null || t < oldest) oldest = t;
    if (newest === null || t > newest) newest = t;
  };
  const over = () => deps.now() - began > POLICY.budgetMs;
  try {
    if (kind === "user") {
      const f = await deps.mail.folderIds(s.email);
      reads++;
      const skip = new Set(
        [f.junk, f.drafts, f.outbox].filter((x): x is string => !!x),
      );
      let stopped = false;
      for (const mo of perthMonths(window.fromMs, window.toMs)) {
        if (over()) {
          stopped = true;
          break;
        }
        const entry = { seen: 0, more: false };
        months[mo.label] = entry;
        let next: string | null = null;
        for (let page = 0; page < POLICY.probeMonthPages; page++) {
          const got: MessagePage = await deps.mail.listMessages(s.email, {
            fromIso: iso(mo.startMs),
            toIso: iso(mo.endMs),
            top: POLICY.bulkPageSize,
            next,
            lean: true,
          });
          reads++;
          for (const m of got.items) {
            entry.seen++;
            const where = m.isDraft === true ||
                (!!m.parentFolderId && skip.has(m.parentFolderId))
              ? "skipped"
              : m.parentFolderId && m.parentFolderId === f.sent
              ? "sent"
              : m.parentFolderId && m.parentFolderId === f.deleted
              ? "deleted"
              : "inbox";
            folders[where]++;
            saw(ms(m.receivedAt));
          }
          next = got.next;
          if (!next) break;
          if (page === POLICY.probeMonthPages - 1) entry.more = true;
        }
      }
      complete = !stopped;
    } else {
      const groupId = await deps.mail.resolveGroupId(s.email);
      reads++;
      if (!groupId) {
        errorCode = "group_not_found";
      } else {
        let next: string | null = null;
        let done = false;
        for (
          let page = 0;
          page < POLICY.groupHistoryMaxPages && !done && !over();
          page++
        ) {
          const got = await deps.mail.listGroupConversations(groupId, next);
          reads++;
          for (const c of got.items) {
            const t = ms(c.lastDeliveredDateTime);
            if (t === null) {
              folders.undated++;
              continue;
            }
            if (t < window.fromMs) {
              done = true;
              break;
            }
            if (t >= window.toMs) continue;
            const label = perthMonth(t);
            (months[label] ??= { seen: 0, more: false }).seen++;
            folders.conversations++;
            saw(t);
          }
          next = got.next;
          if (!next) done = true;
        }
        complete = done;
      }
    }
  } catch (e) {
    errorCode = safeCode(e, "graph_error");
    complete = false;
  }
  const sorted: Record<string, { seen: number; more: boolean }> = {};
  for (const k of Object.keys(months).sort()) sorted[k] = months[k];
  return {
    outcome: "probe",
    source_key: s.source_key,
    kind,
    from: iso(window.fromMs),
    to: iso(window.toMs),
    complete,
    months: sorted,
    folders,
    oldest_seen: oldest === null ? null : iso(oldest),
    newest_seen: newest === null ? null : iso(newest),
    reads,
    error_code: errorCode,
  };
}
