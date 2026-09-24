// The 15-minute GHL message reconciler (context build plan slice C1d; design
// sms.md §2 "Pull (safety net)", §7 step 9, review M12, §8 F5, F6, F8).
//
// GHL tells us about each text through its webhook. This run is the safety net:
// it reads GHL itself, newest conversations first, and saves any message the
// webhook missed, through the one row builder (_shared/evidence/ghl_message.ts)
// and the one SQL writer (public.capture_business_event). It never places a
// message on a job: the database ladder does that on insert, as for every door.
//
// How far back it reads. The runs share one "scan" at a time, kept in the run
// row's cursor (context_capture_runs, written only through record_capture_run):
//   * scan_top        the time the scan started (newest bound);
//   * list_floor      conversations whose last message is at or after this are
//                     read: the previous complete scan's top minus 30 minutes
//                     (the overlap catches late-arriving messages);
//   * message_floor   inside each conversation, messages at or after this are
//                     read: the previous scan's list_floor. A conversation that
//                     gets a new message while a scan is running jumps above
//                     the scan and is only read by the next one; reading its
//                     messages back to the previous floor recovers what it held
//                     (one GHL page usually covers it, so this costs little);
//   * position        the last conversation fully read, as (last message time,
//                     ids at that exact time), saved after every page;
//   * retry_from      the earliest time of a message whose save failed in this
//                     scan (null when none did), carried across the runs of
//                     one scan.
// A scan that cannot finish in one run (page or time budget) is continued by the
// next run from its position, so a burst larger than one run drains over
// several runs instead of re-reading the same newest page forever (review M12).
// The watermark (top of the last complete scan) only moves when a scan
// completes; a failed run holds both the position and the watermark (F6).
// A scan that completes with a failed save moves the watermark only up to that
// message's time (retry_from), so the next scan's floors sit below it and the
// message is read and saved again, whether or not its conversation changes.
//
// When the item flag ghl_message_capture_v2 or the capture lane is off the run
// is idle: no provider read, no run row (F8: it drains on re-enable, reading
// back at most MAX_LOOKBACK; older history is the M4 history load's job).
//
// Pure orchestration over injected reads and writes: the caller supplies the
// GHL reads, the database calls and the clock. No model call anywhere.

import {
  buildGhlMessageRow,
  type GhlMessageItem,
} from "../_shared/evidence/ghl_message.ts";

/** context_capture_runs.source for this reconciler. */
export const RUN_SOURCE = "ghl_message_reconcile";
/** business_events.source on rows this reconciler saves. */
export const EVENT_SOURCE = "ghl-message-reconcile";
/** The per-item flag, shared with the webhook receiver. Missing or unreadable reads as off. */
export const ITEM_FLAG = "ghl_message_capture_v2";

export interface ReconcilePolicy {
  overlapMs: number;
  initialLookbackMs: number;
  maxLookbackMs: number;
  listPageLimit: number;
  messagePageLimit: number;
  maxConversationsPerRun: number;
  maxMessagePagesPerConversation: number;
  timeBudgetMs: number;
  runningStaleMs: number;
}

export const POLICY: Readonly<ReconcilePolicy> = {
  overlapMs: 30 * 60_000,
  initialLookbackMs: 2 * 60 * 60_000,
  maxLookbackMs: 72 * 60 * 60_000,
  listPageLimit: 50,
  messagePageLimit: 50,
  maxConversationsPerRun: 150,
  maxMessagePagesPerConversation: 10,
  timeBudgetMs: 100_000,
  runningStaleMs: 10 * 60_000,
};

/** context_capture_runs.cursor CHECK: octet_length(cursor::text) <= 4096 */
export const CAPTURE_RUN_CURSOR_MAX_BYTES = 4096;
const CAPTURE_RUN_CURSOR_SAFETY_BYTES = 64;

export interface RunRow {
  id: string;
  status: "running" | "succeeded" | "partial" | "failed";
  started_at: string;
  updated_at: string;
  watermark: string | null;
  cursor: unknown;
}

export interface ScanState {
  v: 1;
  scan_top: string;
  list_floor: string;
  message_floor: string;
  position: { last_message_ms: number; ids: string[] } | null;
  /** Earliest time of a message whose save failed in this scan. */
  retry_from?: string | null;
  complete: boolean;
}

/** A provider read failure, as thrown by ghl-proxy/provider_reads.ts. */
export interface ProviderFailure {
  code?: string;
  status?: number;
  providerStatus?: number;
}

export type CaptureOutcome =
  | { outcome: "inserted"; id?: string }
  | { outcome: "duplicate"; id?: string }
  | { outcome: "capture_disabled" }
  | { outcome: "error"; code?: string };

export interface ReconcileDeps {
  /** Epoch milliseconds. */
  now(): number;
  itemFlagOn(): Promise<boolean>;
  captureLaneOn(): Promise<boolean>;
  /** Newest runs of RUN_SOURCE first. Throws when unreadable. */
  latestRuns(limit: number): Promise<RunRow[]>;
  /** record_capture_run. Throws on a refusal. Returns the run id. */
  recordRun(run: Record<string, unknown>): Promise<string>;
  listRecentConversations(args: {
    limit: number;
    startAfterDate?: string;
  }): Promise<
    { conversations: Record<string, unknown>[]; hasMore: boolean | null }
  >;
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
  /** Which of these provider_message_id keys already have a row. Throws when unreadable. */
  existingKeys(keys: string[]): Promise<Set<string>>;
  /** capture_business_event(row). Never throws: a transport fault is outcome error. */
  capture(row: Record<string, unknown>): Promise<CaptureOutcome>;
}

export type ReconcileResult =
  | { outcome: "idle"; reason: "item_flag_off" | "capture_lane_off" }
  | { outcome: "run_in_progress"; run_id: string }
  | {
    outcome: "ran";
    run_id: string;
    status: "succeeded" | "partial" | "failed";
    error_code: string | null;
    watermark: string | null;
    window: { from: string; to: string };
    counts: Record<string, number>;
  };

const COUNT_KEYS = [
  "conversations_listed",
  "conversations_read",
  "conversations_no_date",
  "conversations_unreadable",
  "list_pages",
  "message_pages",
  "message_pages_capped",
  "message_cursor_missing",
  "items_seen",
  "items_older_than_floor",
  "inserted",
  "duplicates",
  "webhook_misses",
  "write_errors",
  "precheck_errors",
  "skipped_no_id",
  "skipped_no_contact",
  "skipped_no_direction",
  "skipped_call",
  "skipped_activity",
  "skipped_unsupported_type",
  "backlog_conversations",
  "backlog_more",
  "boundary_tie_widened",
  "boundary_tie_fallbacks",
  "window_capped",
  "scan_continued",
  "scan_completed",
  "cursor_reset",
] as const;
type CountKey = typeof COUNT_KEYS[number];

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function postgresJsonbText(value: unknown): string {
  if (value === null || value === undefined) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return Number.isFinite(value) ? String(value) : "null";
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map(postgresJsonbText).join(", ")}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return `{${
        keys.map((k) => `${JSON.stringify(k)}: ${postgresJsonbText(obj[k])}`)
          .join(", ")
      }}`;
    }
    default:
      return "null";
  }
}

export function captureRunCursorBytes(cursor: unknown): number {
  return new TextEncoder().encode(postgresJsonbText(cursor)).length;
}

function positionFitsCursor(
  scan: ScanState,
  position: NonNullable<ScanState["position"]>,
): boolean {
  return captureRunCursorBytes({ ...scan, position }) <=
    CAPTURE_RUN_CURSOR_MAX_BYTES - CAPTURE_RUN_CURSOR_SAFETY_BYTES;
}

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

/** A conversation's last message time (GHL sends epoch milliseconds). */
export function conversationTime(row: Record<string, unknown>): number | null {
  return ms(row.lastMessageDate ?? row.last_message_date);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A code safe for context_capture_runs.error_code. */
export function safeCode(value: unknown, fallback = "error"): string {
  const raw = String(value ?? "").toLowerCase().replace(/[^a-z0-9_.:-]/g, "_")
    .replace(/^[^a-z0-9]+/, "").slice(0, 120);
  return raw || fallback;
}

/** The stored scan, or null when absent or not this shape. */
export function parseScanState(cursor: unknown): ScanState | null {
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
    return null;
  }
  const c = cursor as Record<string, unknown>;
  if (c.v !== 1 || typeof c.complete !== "boolean") return null;
  const top = ms(c.scan_top);
  const listFloor = ms(c.list_floor);
  const messageFloor = ms(c.message_floor);
  if (top === null || listFloor === null || messageFloor === null) return null;
  if (listFloor > top || messageFloor > listFloor) return null;
  let position: ScanState["position"] = null;
  if (c.position !== null && c.position !== undefined) {
    const p = c.position as Record<string, unknown>;
    const at = ms(p?.last_message_ms);
    if (
      at === null || !Array.isArray(p.ids) ||
      !p.ids.every((id) => typeof id === "string")
    ) return null;
    position = { last_message_ms: at, ids: p.ids as string[] };
  }
  let retryFrom: number | null = null;
  if (c.retry_from !== null && c.retry_from !== undefined) {
    retryFrom = ms(c.retry_from);
    if (retryFrom === null) return null;
  }
  return {
    v: 1,
    scan_top: iso(top),
    list_floor: iso(listFloor),
    message_floor: iso(messageFloor),
    position,
    retry_from: retryFrom === null ? null : iso(retryFrom),
    complete: c.complete,
  };
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

/**
 * Whether a provider failure must stop the run (cursor held) rather than skip
 * one conversation: rate limits, transport faults, a provider outage and a
 * missing credential stop; a record-level refusal skips that conversation.
 */
export function failureStopsRun(f: ProviderFailure): boolean {
  if (f.status === 429 || f.providerStatus === 429) return true;
  if (typeof f.providerStatus === "number" && f.providerStatus >= 500) {
    return true;
  }
  return [
    "provider_transport_failed",
    "provider_read_budget_exceeded",
    "provider_not_configured",
    "ghl_rate_limited",
    undefined,
  ].includes(f.code);
}

function stopCode(f: ProviderFailure): string {
  if (f.status === 429 || f.providerStatus === 429) return "ghl_rate_limited";
  return safeCode(f.code ?? "provider_read_failed");
}

type ConversationResult =
  | { kind: "done" }
  | { kind: "skipped"; code: string }
  | { kind: "stop"; code: string };

export async function runGhlMessageReconcile(
  deps: ReconcileDeps,
  policy: Readonly<ReconcilePolicy> = POLICY,
): Promise<ReconcileResult> {
  if (!(await deps.itemFlagOn())) {
    return { outcome: "idle", reason: "item_flag_off" };
  }
  if (!(await deps.captureLaneOn())) {
    return { outcome: "idle", reason: "capture_lane_off" };
  }

  const started = deps.now();
  const counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])) as Record<
    CountKey,
    number
  >;

  // 1. The previous run: in progress, abandoned, or the state to continue.
  const runs = await deps.latestRuns(5);
  let latest: RunRow | undefined = runs[0];
  if (latest?.status === "running") {
    const updated = ms(latest.updated_at) ?? 0;
    if (started - updated < policy.runningStaleMs) {
      return { outcome: "run_in_progress", run_id: latest.id };
    }
    // Abandoned (the worker died mid-run). Close it; its cursor and watermark
    // stay as they were saved after its last full page.
    await deps.recordRun({
      run_id: latest.id,
      source: RUN_SOURCE,
      status: "failed",
      error_code: "run_abandoned",
    });
    latest = { ...latest, status: "failed" };
  }

  const watermarkMs = ms(latest?.watermark);
  const previous = latest ? parseScanState(latest.cursor) : null;
  if (latest && latest.cursor != null && !previous) counts.cursor_reset = 1;

  // 2. Continue the unfinished scan, or start a new one.
  let scan: ScanState;
  if (previous && !previous.complete) {
    scan = previous;
    counts.scan_continued = 1;
  } else {
    const oldest = started - policy.maxLookbackMs;
    let listFloor = (watermarkMs ?? started - policy.initialLookbackMs) -
      policy.overlapMs;
    let messageFloor = Math.min(
      listFloor,
      previous ? (ms(previous.list_floor) ?? listFloor) : listFloor,
    );
    if (listFloor < oldest) {
      listFloor = oldest;
      counts.window_capped = 1;
    }
    if (messageFloor < oldest) {
      messageFloor = oldest;
      counts.window_capped = 1;
    }
    scan = {
      v: 1,
      scan_top: iso(started),
      list_floor: iso(listFloor),
      message_floor: iso(messageFloor),
      position: null,
      retry_from: null,
      complete: false,
    };
  }
  const listFloorMs = ms(scan.list_floor)!;
  const messageFloorMs = ms(scan.message_floor)!;
  const window = { from: scan.message_floor, to: scan.scan_top };

  const runId = await deps.recordRun({
    source: RUN_SOURCE,
    status: "running",
    window_from: window.from,
    window_to: window.to,
    watermark: watermarkMs === null ? null : iso(watermarkMs),
    cursor: scan,
    counts,
  });

  let firstIssue: string | null = null;
  const issue = (code: string) => {
    firstIssue ??= code;
  };
  // A failed save pins the next scan's floors at or below its time. A message
  // with no readable time pins the floor this scan read from, which still
  // lists its conversation and reads the message again.
  let retryFromMs = ms(scan.retry_from);
  const failedSave = (at: number | null) => {
    const t = at ?? messageFloorMs;
    retryFromMs = retryFromMs === null ? t : Math.min(retryFromMs, t);
    scan.retry_from = iso(retryFromMs);
  };

  const readConversation = async (
    conversation: Record<string, unknown>,
  ): Promise<ConversationResult> => {
    const contactId = text(conversation.contactId)!;
    const conversationId = text(conversation.id)!;
    let lastMessageId: string | undefined;
    for (let page = 0;; page++) {
      if (page >= policy.maxMessagePagesPerConversation) {
        counts.message_pages_capped++;
        return { kind: "done" };
      }
      let read;
      try {
        read = await deps.listMessages({
          contactId,
          conversationId,
          limit: policy.messagePageLimit,
          lastMessageId,
        });
      } catch (error) {
        const f = providerFailure(error);
        if (failureStopsRun(f)) return { kind: "stop", code: stopCode(f) };
        return {
          kind: "skipped",
          code: safeCode(f.code ?? "provider_read_failed"),
        };
      }
      counts.message_pages++;
      const items = read.messages;
      counts.items_seen += items.length;
      const rows: { row: Record<string, unknown>; at: number | null }[] = [];
      const keys = new Set<string>();
      let oldestOnPage: number | null = null;
      for (const item of items) {
        const at = ms(item.dateAdded);
        if (at !== null) {
          oldestOnPage = oldestOnPage === null
            ? at
            : Math.min(oldestOnPage, at);
        }
        if (at !== null && at < messageFloorMs) {
          counts.items_older_than_floor++;
          continue;
        }
        const built = buildGhlMessageRow(item as GhlMessageItem, {
          source: EVENT_SOURCE,
          captureMode: "live",
        });
        if (built.kind === "skip") {
          const key = (built.reason.startsWith("skipped_")
            ? built.reason
            : `skipped_${built.reason}`) as CountKey;
          counts[key]++;
          continue;
        }
        const key = String(built.row.provider_message_id);
        if (keys.has(key)) continue;
        keys.add(key);
        rows.push({ row: built.row, at });
      }
      let existing = new Set<string>();
      if (rows.length) {
        try {
          existing = await deps.existingKeys([...keys]);
        } catch {
          // The writer is idempotent, so an unreadable pre-check only costs
          // extra writer calls. Counted, never hidden.
          counts.precheck_errors++;
        }
      }
      for (const { row, at } of rows) {
        if (existing.has(String(row.provider_message_id))) {
          counts.duplicates++;
          continue;
        }
        const out = await deps.capture(row);
        if (out.outcome === "inserted") {
          counts.inserted++;
          counts.webhook_misses++;
        } else if (out.outcome === "duplicate") {
          counts.duplicates++;
        } else if (out.outcome === "capture_disabled") {
          return { kind: "stop", code: "capture_disabled" };
        } else {
          counts.write_errors++;
          issue(`write_error:${safeCode(out.code, "unknown")}`);
          failedSave(at);
        }
      }
      if (
        !items.length || read.hasMore === false ||
        (oldestOnPage !== null && oldestOnPage < messageFloorMs)
      ) return { kind: "done" };
      if (!read.nextLastMessageId) {
        counts.message_cursor_missing++;
        return { kind: "done" };
      }
      lastMessageId = read.nextLastMessageId;
    }
  };

  // 3. Walk the conversations newest first from the scan position.
  let stop: string | null = null;
  let position = scan.position;
  let processed = 0;
  // A page can hold only ids already read when many conversations share the
  // boundary millisecond (GHL has no tie-break cursor). Step 1 re-reads the
  // boundary with the largest page GHL allows; step 2, only if that is still
  // all ties, moves strictly past the boundary and counts it, because
  // conversations at that exact millisecond may then be skipped.
  let tieStep = 0;
  try {
    scanLoop:
    for (;;) {
      let startAfterDate: string | undefined;
      if (position) {
        // Re-read the boundary time (ties at the same millisecond) and skip the
        // ids already read there.
        startAfterDate = String(
          tieStep === 2
            ? position.last_message_ms
            : position.last_message_ms + 1,
        );
      }
      const limit = tieStep === 1
        ? Math.max(policy.listPageLimit, 100)
        : policy.listPageLimit;
      let page;
      try {
        page = await deps.listRecentConversations({ limit, startAfterDate });
      } catch (error) {
        stop = stopCode(providerFailure(error));
        break;
      }
      counts.list_pages++;
      const list = page.conversations;
      counts.conversations_listed += list.length;
      for (const row of list) {
        if (conversationTime(row) === null) counts.conversations_no_date++;
      }
      const fresh = list.filter((c) => {
        const at = conversationTime(c);
        if (at === null) return false;
        if (!position) return true;
        if (at > position.last_message_ms) return false;
        return !(at === position.last_message_ms &&
          position.ids.includes(String(c.id)));
      });
      if (!fresh.length) {
        const dated = list.filter((c) => conversationTime(c) !== null);
        const boundaryMs = position?.last_message_ms;
        const boundaryTies = boundaryMs !== undefined &&
          dated.length === list.length &&
          list.length >= limit &&
          dated.every((c) => conversationTime(c) === boundaryMs);
        if (boundaryTies && tieStep < 2) {
          tieStep++;
          if (tieStep === 1) counts.boundary_tie_widened++;
          else counts.boundary_tie_fallbacks++;
          continue;
        }
        if (boundaryTies) {
          counts.backlog_more = 1;
          break;
        }
        scan.complete = true;
        break;
      }
      tieStep = 0;
      let steppedPastMs: number | null = null;
      for (let i = 0; i < fresh.length; i++) {
        const conversation = fresh[i];
        const at = conversationTime(conversation);
        if (at === null) continue;
        if (steppedPastMs !== null && at >= steppedPastMs) continue;
        if (at < listFloorMs) {
          scan.complete = true;
          break scanLoop;
        }
        if (
          processed >= policy.maxConversationsPerRun ||
          deps.now() - started >= policy.timeBudgetMs
        ) {
          counts.backlog_conversations = fresh.slice(i).filter((c) => {
            const t = conversationTime(c);
            return t !== null && t >= listFloorMs &&
              (steppedPastMs === null || t < steppedPastMs);
          }).length;
          counts.backlog_more = page.hasMore === false ? 0 : 1;
          break scanLoop;
        }
        const result = await readConversation(conversation);
        if (result.kind === "stop") {
          stop = result.code;
          break scanLoop;
        }
        if (result.kind === "skipped") {
          counts.conversations_unreadable++;
          issue(`conversation_unreadable:${result.code}`);
        } else {
          counts.conversations_read++;
        }
        processed++;
        const id = String(conversation.id);
        const next = position && position.last_message_ms === at
          ? { last_message_ms: at, ids: [...position.ids, id] }
          : { last_message_ms: at, ids: [id] };
        if (!positionFitsCursor(scan, next)) {
          counts.boundary_tie_fallbacks++;
          steppedPastMs = at;
          continue;
        }
        position = next;
      }
      if (
        steppedPastMs !== null &&
        position?.last_message_ms === steppedPastMs
      ) {
        tieStep = 2;
      }
      scan.position = position;
      if (!list.length || page.hasMore === false) {
        scan.complete = true;
        break;
      }
      // Save progress after every fully read page (review M12).
      await deps.recordRun({
        run_id: runId,
        source: RUN_SOURCE,
        cursor: scan,
        counts,
      });
    }
  } catch (error) {
    // Anything unexpected (a database write refused mid-run) fails the run
    // with its code; the position saved so far is kept.
    stop = safeCode(providerFailure(error).code ?? "run_error");
  }
  scan.position = position;

  // 4. Finish the run row.
  const complete = scan.complete && !stop;
  if (!complete) scan.complete = false;
  counts.scan_completed = complete ? 1 : 0;
  const watermark = complete
    ? iso(Math.min(ms(scan.scan_top)!, retryFromMs ?? Infinity))
    : watermarkMs === null
    ? null
    : iso(watermarkMs);
  const status: "succeeded" | "partial" | "failed" = stop
    ? "failed"
    : !complete || firstIssue
    ? "partial"
    : "succeeded";
  const errorCode = stop ?? firstIssue;
  await deps.recordRun({
    run_id: runId,
    source: RUN_SOURCE,
    status,
    watermark,
    cursor: scan,
    counts,
    error_code: errorCode,
  });
  return {
    outcome: "ran",
    run_id: runId,
    status,
    error_code: errorCode,
    watermark,
    window,
    counts,
  };
}
