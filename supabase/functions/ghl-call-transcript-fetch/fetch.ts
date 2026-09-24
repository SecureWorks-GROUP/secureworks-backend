// The GHL call transcript fetcher (context slice T2; design transcripts.md §2
// "Transcript: one writer, the fetcher", §3, §8, §12).
//
// GHL records our calls and writes its own transcript, split into the two
// sides of the line. This fetcher is the only writer of that transcript into
// the evidence log: a call.transcript_completed row keyed ghltx:<the call's
// GHL message id>, beside (never instead of) the call row keyed ghl:<id> that
// the webhook, the reconciler or the history load wrote (slice T1). It never
// pays for transcription, never downloads audio and never places a row on a
// job: the database ladder places it on insert, as for every door.
//
// Two modes over one per-call step (processCall):
//
//  * live (every 5 minutes, pg_cron): the calls due now, from
//    context_transcript_due_calls (last 14 days, eligible from the stored
//    status and duration, no terminal outcome, next try due, oldest first,
//    40 a run). Idle, with no provider read and no run row, while the fetch
//    flag ghl_call_transcript_fetch_v1 or the capture lane is off.
//
//  * backfill (the history load, run by hand): the owner asked for the past
//    calls of the jobs that are live now (24 Sep 2026: "for call transcripts
//    i need all the evidence of past jobs as well", "i just need it for the
//    jobs that are currently live"). For each contact of a live job
//    (context_transcript_backfill_contacts) it reads the contact's GHL
//    conversations and messages, saves each call row through the one builder
//    and writer (capture mode backfill, legacy pairing as the reconciler does)
//    and fetches its transcript. Every row it writes is capture mode
//    backfill, so a past call never wakes an extraction read. dry_run is the
//    default: a dry run reads GHL and reports what it would write, and writes
//    nothing at all (no call row, no transcript, no fetch record, no run
//    row). While the fetch flag is off a dry run reads no transcript either:
//    it lists the calls it would fetch (would_fetch). A real run needs the fetch flag and the capture lane on, like the
//    live fetcher: transcripts are the most sensitive rows (transcripts.md
//    §13, G-ANON), and the flag stays off until that gate.
//
// Per call (processCall):
//  1. A call whose ghltx: row already exists (a crashed run, the other mode)
//     is recorded saved, with no provider call.
//  2. The provider re-read (review M10): GET the call item, bind it to our
//     location and to the stored contact, and take its final status and
//     duration. A call GHL now says was not answered, busy, failed or too
//     short is terminal not_expected (a no-answer call's transcription answer
//     is HTTP 400, read 24 Sep 2026).
//  3. GET the transcription (v3) and read it through the one reader
//     _shared/ghl/call_transcript.ts. An empty list or a 404 is not ready yet;
//     any other failure is an error with its code. The backoff and when an
//     outcome becomes terminal are the database writer's
//     (record_call_transcript_fetch), never this file's.
//  5. Build the row (buildGhlCallTranscriptRow) and save it through
//     capture_business_event; a duplicate is a save. Record the outcome.
//
// Logs and results carry ids, counts and codes only, never words.

import {
  buildGhlCallTranscriptRow,
  buildGhlMessageRow,
  type CallRowFacts,
  type CaptureMode,
  type GhlMessageItem,
} from "../_shared/evidence/ghl_message.ts";
import {
  flattenTranscript,
  normaliseSentences,
  readTranscriptSentences,
} from "../_shared/ghl/call_transcript.ts";
import type { LegacyCallPairOutcome } from "../_shared/evidence/ghl_call_pair.ts";

export const FETCH_FLAG = "ghl_call_transcript_fetch_v1";
/** business_events.source on call rows the history load writes. */
export const BACKFILL_CALL_SOURCE = "ghl-call-transcript-fetch";
export const ACTOR = "workflow:ghl-call-transcript-fetch";

/** The thresholds the fetcher reads from context_transcript_capture_policy(). */
export interface FetchPolicy {
  run_source: string;
  backfill_run_source: string;
  batch_limit: number;
  min_call_seconds: number;
  agreement_minutes: number;
}

/** Local limits of one invocation (not business thresholds). */
export const LIMITS = {
  timeBudgetMs: 100_000,
  runningStaleMs: 10 * 60_000,
  backfillDefaultContacts: 10,
  backfillMaxContacts: 25,
  conversationPageLimit: 50,
  messagePages: 20,
  messagePageLimit: 100,
};

/** One call due a fetch, as context_transcript_due_calls returns it. */
export interface DueCall {
  call_event_id: string;
  call_message_id: string;
  event_type: string;
  event_at: string;
  contact_id: string;
  conversation_key: string | null;
  direction: string | null;
  call_status: string | null;
  duration_seconds: number | null;
  call_sid: string | null;
  line: string | null;
  from_line: string | null;
  by_user: string | null;
  capture_mode: string | null;
  transcript_event_id: string | null;
  attempts: number;
  seen_sentences: number | null;
  seen_digest: string | null;
  seen_at: string | null;
}

/** A provider read: the parsed body, or why there is none. Never words in a code. */
export type ProviderRead =
  | { ok: true; body: unknown }
  | { ok: false; status: number | null; code: string };

export type CaptureOutcome =
  | { outcome: "inserted"; id?: string }
  | { outcome: "duplicate"; id?: string }
  | { outcome: "capture_disabled" }
  | { outcome: "error"; code?: string };

export type FetchResult =
  | "saved"
  | "not_ready"
  | "awaiting_agreement"
  | "error"
  | "not_expected";

export interface FetchRecord {
  call_message_id: string;
  call_event_id: string;
  mode: "live" | "backfill";
  result: FetchResult;
  code?: string;
  provider_status?: string | null;
  provider_duration_seconds?: number | null;
  sentences?: number;
  digest?: string;
  transcript_event_id?: string;
}

export interface RunRow {
  id: string;
  status: string;
  started_at: string;
}

export interface FetchDeps {
  /** Epoch milliseconds. */
  now(): number;
  flagOn(): Promise<boolean>;
  laneOn(): Promise<boolean>;
  policy(): Promise<FetchPolicy>;
  latestRun(source: string): Promise<RunRow | null>;
  /** record_capture_run. Throws on a refusal. */
  recordRun(run: Record<string, unknown>): Promise<string>;
  dueCalls(limit: number): Promise<DueCall[]>;
  /** GET /conversations/messages/{id}. */
  readCallMessage(messageId: string): Promise<ProviderRead>;
  /** GET /conversations/locations/{loc}/messages/{id}/transcription (v3). */
  readTranscription(messageId: string): Promise<ProviderRead>;
  /** The configured GHL location id. */
  locationId: string;
  /** capture_business_event(row). Never throws. */
  capture(row: Record<string, unknown>): Promise<CaptureOutcome>;
  /** record_call_transcript_fetch. Never throws: a refusal is { error }. */
  recordFetch(
    record: FetchRecord,
  ): Promise<{ outcome: string } | { error: string }>;
}

export interface BackfillContact {
  ghl_contact_id: string;
  job_ids: string[];
  job_numbers: string[];
}

export interface BackfillDeps extends FetchDeps {
  backfillContacts(
    after: string | null,
    limit: number,
  ): Promise<BackfillContact[]>;
  listConversations(
    contactId: string,
    startAfterDate?: string,
  ): Promise<{ conversations: Record<string, unknown>[]; next: string | null }>;
  listMessages(
    contactId: string,
    conversationId: string,
    lastMessageId?: string,
  ): Promise<{ messages: Record<string, unknown>[]; next: string | null }>;
  /** Which of these provider_message_id keys already have a row, with the row id. Throws when unreadable. */
  existingRows(keys: string[]): Promise<Map<string, string>>;
  /** Fetch records of these call message ids. Throws when unreadable. */
  fetchOutcomes(ids: string[]): Promise<Map<string, FetchState>>;
  pairLegacyCall(
    row: Record<string, unknown>,
  ): Promise<{ row: Record<string, unknown>; outcome: LegacyCallPairOutcome }>;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  const n = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d{1,7}(\.\d{1,3})?$/.test(value.trim())
    ? Number(value.trim())
    : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function codePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(
    /^_+|_+$/g,
    "",
  )
    .slice(0, 40) || "unknown";
}

/**
 * Whether a call, by the provider's own status and duration, can carry a
 * transcript. The same rule as the database's context_call_transcript_eligible:
 * completed and at least min seconds or with no duration recorded, or a
 * voicemail.
 */
export function providerCallEligible(
  status: string | null,
  duration: number | null,
  messageType: string | null,
  minSeconds: number,
): { eligible: true } | { eligible: false; code: string } {
  const s = (status ?? "").toLowerCase();
  const t = (messageType ?? "").toUpperCase().replace(/^TYPE_/, "");
  if (s === "voicemail" || t === "VOICEMAIL") return { eligible: true };
  if (s === "completed") {
    if (duration === null || duration >= minSeconds) return { eligible: true };
    return { eligible: false, code: "provider_too_short" };
  }
  return {
    eligible: false,
    code: `provider_status_${codePart(s || "none")}`,
  };
}

/** The call item inside GHL's GET /conversations/messages/{id} answer. */
function callItem(body: unknown): Record<string, unknown> {
  const outer = body && typeof body === "object"
    ? body as Record<string, unknown>
    : {};
  const inner = outer.message;
  return inner && typeof inner === "object" && !Array.isArray(inner)
    ? inner as Record<string, unknown>
    : outer;
}

export type CallOutcome =
  | "saved"
  | "saved_existing"
  | "duplicate_saved"
  | "not_ready"
  | "awaiting_agreement"
  | "not_expected"
  | "error"
  | "would_save"
  | "record_failed";

export interface CallStep {
  outcome: CallOutcome;
  code?: string;
  /** The run must stop: GHL rate limit, or the capture lane went off. */
  stop?: "rate_limited" | "capture_disabled";
  /** Provider requests made (for the attempts count). */
  reads: number;
  sentences?: number;
  lowSignal?: boolean;
}

/**
 * One call: re-read, fetch, agree, save, record. Pure orchestration over the
 * injected reads and writes. With dryRun it reads GHL and writes nothing.
 */
export async function processCall(
  call: DueCall,
  mode: "live" | "backfill",
  policy: FetchPolicy,
  deps: FetchDeps,
  dryRun = false,
): Promise<CallStep> {
  const base = {
    call_message_id: call.call_message_id,
    call_event_id: call.call_event_id,
    mode,
  };
  const record = async (
    r: Omit<FetchRecord, "call_message_id" | "call_event_id" | "mode">,
    step: CallStep,
  ): Promise<CallStep> => {
    if (dryRun) return step;
    const out = await deps.recordFetch({ ...base, ...r });
    if ("error" in out) {
      return { ...step, outcome: "record_failed", code: out.error };
    }
    return step;
  };

  // 1. Crash replay: the transcript row already exists.
  if (call.transcript_event_id) {
    return record(
      { result: "saved", transcript_event_id: call.transcript_event_id },
      { outcome: "saved_existing", reads: 0 },
    );
  }

  // 2. Provider re-read of the call item.
  const msg = await deps.readCallMessage(call.call_message_id);
  if (!msg.ok) {
    const code = msg.status === 404
      ? "message_not_found"
      : msg.status
      ? `message_http_${msg.status}`
      : `message_${msg.code}`;
    const step: CallStep = {
      outcome: msg.status === 404 ? "not_ready" : "error",
      code,
      reads: 1,
      ...(msg.status === 429 ? { stop: "rate_limited" as const } : {}),
    };
    return record(
      { result: msg.status === 404 ? "not_ready" : "error", code },
      step,
    );
  }
  const item = callItem(msg.body);
  const mismatch = text(item.id) !== call.call_message_id
    ? "provider_id_mismatch"
    : text(item.locationId) !== deps.locationId
    ? "provider_location_mismatch"
    : text(item.contactId) !== call.contact_id
    ? "provider_contact_mismatch"
    : !/^(TYPE_)?(CALL|VOICEMAIL|IVR_?CALL)$/i.test(
        String(item.messageType ?? ""),
      )
    ? "provider_not_a_call"
    : null;
  if (mismatch) {
    return record({ result: "error", code: mismatch }, {
      outcome: "error",
      code: mismatch,
      reads: 1,
    });
  }
  const meta =
    (item.meta && typeof item.meta === "object"
      ? (item.meta as Record<string, unknown>).call
      : null) as Record<string, unknown> | null;
  const finalStatus = text(meta?.status) ?? text(item.status);
  const finalDuration = num(meta?.duration);
  const provider = {
    provider_status: finalStatus,
    provider_duration_seconds: finalDuration,
  };
  const eligible = providerCallEligible(
    finalStatus,
    finalDuration,
    text(item.messageType),
    policy.min_call_seconds,
  );
  if (!eligible.eligible) {
    return record(
      { result: "not_expected", code: eligible.code, ...provider },
      {
        outcome: "not_expected",
        code: eligible.code,
        reads: 1,
      },
    );
  }

  // 3. The transcription.
  const tx = await deps.readTranscription(call.call_message_id);
  if (!tx.ok) {
    const notReady = tx.status === 404;
    const code = notReady
      ? "transcript_not_found"
      : tx.status
      ? `http_${tx.status}`
      : tx.code;
    return record(
      { result: notReady ? "not_ready" : "error", code, ...provider },
      {
        outcome: notReady ? "not_ready" : "error",
        code,
        reads: 2,
        ...(tx.status === 429 ? { stop: "rate_limited" as const } : {}),
      },
    );
  }
  const read = readTranscriptSentences(tx.body);
  if (!read.ok) {
    return record({ result: "error", code: "provider_invalid", ...provider }, {
      outcome: "error",
      code: "provider_invalid",
      reads: 2,
    });
  }
  if (read.sentences.length === 0) {
    return record({ result: "not_ready", code: "empty", ...provider }, {
      outcome: "not_ready",
      code: "empty",
      reads: 2,
    });
  }
  const flat = await flattenTranscript(normaliseSentences(read.sentences));

  const nowMs = deps.now();
  const seenAt = call.seen_at ? Date.parse(call.seen_at) : NaN;
  const agrees = call.seen_digest === flat.digest &&
    call.seen_sentences === flat.sentenceCount &&
    Number.isFinite(seenAt) &&
    nowMs - seenAt >= policy.agreement_minutes * 60_000;
  if (!agrees) {
    return record({
      result: "awaiting_agreement",
      sentences: flat.sentenceCount,
      digest: flat.digest,
      ...provider,
    }, {
      outcome: "awaiting_agreement",
      reads: 2,
      sentences: flat.sentenceCount,
      lowSignal: flat.lowSignal,
    });
  }
  const agreement = "reached";

  // 5. Build and save.
  const facts: CallRowFacts = {
    ghlMessageId: call.call_message_id,
    contactId: call.contact_id,
    eventAt: call.event_at,
    direction: call.direction,
    conversationKey: call.conversation_key,
    callSid: call.call_sid,
    durationSeconds: finalDuration ?? call.duration_seconds,
    line: call.line,
    fromLine: call.from_line,
    byUser: call.by_user,
  };
  const stored = call.capture_mode;
  const captureMode: CaptureMode = mode === "backfill"
    ? "backfill"
    : stored === "backfill" || stored === "relink"
    ? stored
    : "live";
  const built = buildGhlCallTranscriptRow(facts, flat, {
    captureMode,
    agreement,
  });
  if (built.kind !== "row") {
    return record({ result: "error", code: `build_${built.reason}` }, {
      outcome: "error",
      code: `build_${built.reason}`,
      reads: 2,
    });
  }
  if (dryRun) {
    return {
      outcome: "would_save",
      reads: 2,
      sentences: flat.sentenceCount,
      lowSignal: flat.lowSignal,
    };
  }
  const saved = await deps.capture(built.row);
  if (saved.outcome === "capture_disabled") {
    return {
      outcome: "error",
      code: "capture_disabled",
      stop: "capture_disabled",
      reads: 2,
    };
  }
  if (saved.outcome === "error" || !saved.id) {
    const code = `capture_${
      codePart(saved.outcome === "error" ? saved.code ?? "error" : "no_id")
    }`;
    return record({ result: "error", code, ...provider }, {
      outcome: "error",
      code,
      reads: 2,
    });
  }
  return record({
    result: "saved",
    transcript_event_id: saved.id,
    ...provider,
  }, {
    outcome: saved.outcome === "duplicate" ? "duplicate_saved" : "saved",
    reads: 2,
    sentences: flat.sentenceCount,
    lowSignal: flat.lowSignal,
  });
}

function emptyCounts(): Record<string, number> {
  return {
    selected: 0,
    saved: 0,
    saved_existing: 0,
    duplicates: 0,
    not_ready: 0,
    awaiting_agreement: 0,
    not_expected: 0,
    errors: 0,
    record_failed: 0,
    attempts: 0,
    low_signal: 0,
  };
}

function tally(counts: Record<string, number>, step: CallStep): void {
  counts.attempts += step.reads;
  if (
    step.lowSignal &&
    (step.outcome === "saved" || step.outcome === "duplicate_saved")
  ) {
    counts.low_signal++;
  }
  switch (step.outcome) {
    case "saved":
      counts.saved++;
      break;
    case "saved_existing":
      counts.saved_existing++;
      break;
    case "duplicate_saved":
      counts.duplicates++;
      break;
    case "not_ready":
      counts.not_ready++;
      break;
    case "awaiting_agreement":
      counts.awaiting_agreement++;
      break;
    case "not_expected":
      counts.not_expected++;
      break;
    case "record_failed":
      counts.record_failed++;
      break;
    case "would_save":
      counts.would_save = (counts.would_save ?? 0) + 1;
      break;
    default:
      counts.errors++;
  }
}

export type LiveResult =
  | { outcome: "idle"; reason: "fetch_flag_off" | "capture_lane_off" }
  | { outcome: "run_in_progress"; run_id: string }
  | {
    outcome: "ran";
    run_id: string;
    status: "succeeded" | "partial" | "failed";
    error_code: string | null;
    counts: Record<string, number>;
    calls: { call_message_id: string; outcome: CallOutcome; code?: string }[];
  };

/** One live run: the calls due now. */
export async function runLiveFetch(deps: FetchDeps): Promise<LiveResult> {
  if (!(await deps.flagOn())) {
    return { outcome: "idle", reason: "fetch_flag_off" };
  }
  if (!(await deps.laneOn())) {
    return { outcome: "idle", reason: "capture_lane_off" };
  }
  const policy = await deps.policy();
  const started = deps.now();
  const latest = await deps.latestRun(policy.run_source);
  if (
    latest?.status === "running" &&
    started - Date.parse(latest.started_at) < LIMITS.runningStaleMs
  ) {
    return { outcome: "run_in_progress", run_id: latest.id };
  }
  const runId = await deps.recordRun({
    source: policy.run_source,
    status: "running",
    cursor: { actor: ACTOR, mode: "live" },
  });
  const counts = emptyCounts();
  const calls: {
    call_message_id: string;
    outcome: CallOutcome;
    code?: string;
  }[] = [];
  let status: "succeeded" | "partial" | "failed" = "succeeded";
  let errorCode: string | null = null;
  try {
    const due = await deps.dueCalls(policy.batch_limit);
    for (const call of due) {
      if (deps.now() - started > LIMITS.timeBudgetMs) {
        status = "partial";
        errorCode = "time_budget";
        break;
      }
      counts.selected++;
      const step = await processCall(call, "live", policy, deps);
      tally(counts, step);
      calls.push({
        call_message_id: call.call_message_id,
        outcome: step.outcome,
        ...(step.code ? { code: step.code } : {}),
      });
      if (step.stop) {
        status = "partial";
        errorCode = step.stop;
        break;
      }
    }
  } catch (error) {
    status = "failed";
    errorCode = codePart(
      (error as { code?: string })?.code ?? "due_calls_unreadable",
    );
  }
  await deps.recordRun({
    run_id: runId,
    source: policy.run_source,
    status,
    counts,
    ...(errorCode ? { error_code: errorCode } : {}),
  });
  return {
    outcome: "ran",
    run_id: runId,
    status,
    error_code: errorCode,
    counts,
    calls,
  };
}

export interface BackfillCursor {
  contact_id: string;
  conversation_page: string | null;
  conversation_ids: string[] | null;
  message_page: string | null;
}

export interface FetchState {
  outcome: string;
  next_at: string | null;
  attempts: number;
  seen_sentences: number | null;
  seen_digest: string | null;
  seen_at: string | null;
}

export interface BackfillRequest {
  cursor?: BackfillCursor | null;
  dryRun: boolean;
  after: string | null;
  maxContacts: number;
}

export interface BackfillCallReport {
  call_message_id: string;
  contact_id: string;
  job_numbers: string[];
  event_at: string | null;
  call_row: "exists" | "written" | "would_write" | "failed" | "skipped";
  outcome:
    | CallOutcome
    | "skipped_terminal"
    | "skipped_not_eligible"
    | "retry_wait"
    | "would_fetch";
  code?: string;
  sentences?: number;
}

export type BackfillResult =
  | { outcome: "refused"; reason: "fetch_flag_off" | "capture_lane_off" }
  | {
    outcome: "ran";
    dry_run: boolean;
    run_id: string | null;
    status: "succeeded" | "partial" | "failed";
    error_code: string | null;
    contacts_done: number;
    next_after: string | null;
    next_cursor: BackfillCursor | null;
    complete: boolean;
    counts: Record<string, number>;
    calls: BackfillCallReport[];
  };

const CALL_TYPES = /^(TYPE_)?(CALL|VOICEMAIL|IVR_?CALL)$/i;

/** The history load over the contacts of the jobs that are live now. */
export async function runBackfill(
  req: BackfillRequest,
  deps: BackfillDeps,
): Promise<BackfillResult> {
  // The fetch flag gates every transcript read, not only every write: a real
  // run is refused while it is off, and a dry run then lists the calls it
  // would fetch without ever asking GHL for a transcript's words.
  const flagOn = await deps.flagOn();
  if (!req.dryRun) {
    if (!flagOn) {
      return { outcome: "refused", reason: "fetch_flag_off" };
    }
    if (!(await deps.laneOn())) {
      return { outcome: "refused", reason: "capture_lane_off" };
    }
  }
  const policy = await deps.policy();
  const started = deps.now();
  const max = Math.max(
    1,
    Math.min(
      LIMITS.backfillMaxContacts,
      Math.trunc(req.maxContacts) || LIMITS.backfillDefaultContacts,
    ),
  );
  const runId = req.dryRun ? null : await deps.recordRun({
    source: policy.backfill_run_source,
    status: "running",
    cursor: {
      actor: ACTOR,
      mode: "backfill",
      after: req.after,
      next_cursor: req.cursor ?? null,
    },
  });
  const counts: Record<string, number> = {
    ...emptyCounts(),
    contacts: 0,
    conversations: 0,
    call_items: 0,
    call_rows_written: 0,
    call_rows_existing: 0,
    call_rows_failed: 0,
    calls_paired_legacy: 0,
    skipped_terminal: 0,
    skipped_not_eligible: 0,
    retry_wait: 0,
    provider_list_reads: 0,
  };
  const calls: BackfillCallReport[] = [];
  let status: "succeeded" | "partial" | "failed" = "succeeded";
  let errorCode: string | null = null;
  let lastDone: string | null = req.after;
  let contactsDone = 0;
  let complete = false;
  let cursor = req.cursor ?? null;
  let pagesRead = 0;
  try {
    const contacts = await deps.backfillContacts(req.after, max);
    complete = contacts.length < max;
    contactLoop:
    for (const contact of contacts) {
      if (deps.now() - started > LIMITS.timeBudgetMs) {
        status = "partial";
        errorCode = "time_budget";
        complete = false;
        break;
      }
      counts.contacts++;
      if (cursor && cursor.contact_id !== contact.ghl_contact_id) {
        throw Object.assign(new Error("cursor_contact_mismatch"), {
          code: "cursor_contact_mismatch",
        });
      }
      cursor ??= {
        contact_id: contact.ghl_contact_id,
        conversation_page: null,
        conversation_ids: null,
        message_page: null,
      };
      while (cursor) {
        if (
          pagesRead >= LIMITS.messagePages ||
          deps.now() - started > LIMITS.timeBudgetMs
        ) {
          status = "partial";
          errorCode = "page_or_time_budget";
          complete = false;
          break contactLoop;
        }
        pagesRead++;
        if (
          cursor.conversation_ids === null ||
          cursor.conversation_ids.length === 0
        ) {
          if (
            cursor.conversation_ids !== null &&
            cursor.conversation_page === null
          ) {
            cursor = null;
            break;
          }
          const convs = await deps.listConversations(
            contact.ghl_contact_id,
            cursor.conversation_page ?? undefined,
          );
          counts.provider_list_reads++;
          const ids = convs.conversations.map((conv) => text(conv.id));
          if (ids.some((id) => !id)) {
            throw Object.assign(new Error("conversation_identity_missing"), {
              code: "conversation_identity_missing",
            });
          }
          cursor = {
            ...cursor,
            conversation_page: convs.next,
            conversation_ids: ids as string[],
            message_page: null,
          };
          if (ids.length === 0) continue;
        }
        const convId = cursor.conversation_ids![0];
        const page = await deps.listMessages(
          contact.ghl_contact_id,
          convId,
          cursor.message_page ?? undefined,
        );
        counts.provider_list_reads++;
        counts.conversations++;
        const items = page.messages.filter((m) =>
          CALL_TYPES.test(String(m.messageType ?? ""))
        ) as GhlMessageItem[];
        let pending = false;
        counts.call_items += items.length;
        const built = items.map((item) =>
          buildGhlMessageRow(item, {
            source: BACKFILL_CALL_SOURCE,
            captureMode: "backfill",
          })
        ).filter((b): b is { kind: "row"; row: Record<string, unknown> } =>
          b.kind === "row" && b.row.contact_id === contact.ghl_contact_id
        ).map((b) => b.row);
        const ids = built.map((r) => String(r.provider_message_id).slice(4));
        const existing = ids.length
          ? await deps.existingRows(
            ids.flatMap((id) => [`ghl:${id}`, `ghltx:${id}`]),
          )
          : new Map<string, string>();
        const outcomes = ids.length
          ? await deps.fetchOutcomes(ids)
          : new Map<string, FetchState>();

        for (const row of built) {
          const id = String(row.provider_message_id).slice(4);
          const payload = row.payload as Record<string, unknown>;
          const report: BackfillCallReport = {
            call_message_id: id,
            contact_id: contact.ghl_contact_id,
            job_numbers: contact.job_numbers,
            event_at: (row.event_at as string | null) ?? null,
            call_row: "skipped",
            outcome: "skipped_not_eligible",
          };
          calls.push(report);
          const prior = outcomes.get(id);
          if (prior && prior.outcome !== "pending") {
            report.outcome = "skipped_terminal";
            report.code = prior.outcome;
            counts.skipped_terminal++;
            continue;
          }
          if (
            prior?.next_at && Date.parse(prior.next_at) > deps.now() &&
            !existing.has(`ghltx:${id}`)
          ) {
            report.outcome = "retry_wait";
            counts.retry_wait++;
            pending = true;
            continue;
          }
          // The call row: exists, or written now (backfill, legacy pairing).
          let callEventId = existing.get(`ghl:${id}`) ?? null;
          if (callEventId) {
            report.call_row = "exists";
            counts.call_rows_existing++;
          } else if (req.dryRun) {
            report.call_row = "would_write";
            callEventId = "00000000-0000-0000-0000-000000000000";
          } else {
            const paired = await deps.pairLegacyCall(row);
            if (paired.outcome === "paired") counts.calls_paired_legacy++;
            const out = await deps.capture(paired.row);
            if (out.outcome === "capture_disabled") {
              report.call_row = "failed";
              status = "partial";
              errorCode = "capture_disabled";
              break contactLoop;
            }
            if (
              (out.outcome === "inserted" || out.outcome === "duplicate") &&
              out.id
            ) {
              callEventId = out.id;
              report.call_row = "written";
              counts.call_rows_written++;
            } else {
              report.call_row = "failed";
              report.code = `capture_${
                codePart(
                  out.outcome === "error" ? out.code ?? "error" : "no_id",
                )
              }`;
              counts.call_rows_failed++;
              pending = true;
              continue;
            }
          }
          // Selection eligibility from the stored (here: just built) row. The
          // provider re-read inside processCall decides again.
          const eligible = providerCallEligible(
            text(payload.call_status),
            typeof payload.duration_seconds === "number"
              ? payload.duration_seconds
              : null,
            text(payload.ghl_message_type),
            policy.min_call_seconds,
          );
          const txId = existing.get(`ghltx:${id}`) ?? null;
          if (!eligible.eligible && !txId) {
            report.code = eligible.code;
            counts.skipped_not_eligible++;
            continue;
          }
          if (deps.now() - started > LIMITS.timeBudgetMs) {
            status = "partial";
            errorCode = "time_budget";
            complete = false;
            break contactLoop;
          }
          counts.selected++;
          const due: DueCall = {
            call_event_id: callEventId,
            call_message_id: id,
            event_type: String(row.event_type),
            event_at: String(row.event_at ?? ""),
            contact_id: contact.ghl_contact_id,
            conversation_key: text(row.conversation_key),
            direction: text(row.direction),
            call_status: text(payload.call_status),
            duration_seconds: typeof payload.duration_seconds === "number"
              ? payload.duration_seconds
              : null,
            call_sid: text(payload.call_sid),
            line: text(payload.line),
            from_line: text(payload.from_line),
            by_user: text(payload.by_user),
            capture_mode: "backfill",
            transcript_event_id: txId,
            attempts: prior?.attempts ?? 0,
            seen_sentences: prior?.seen_sentences ?? null,
            seen_digest: prior?.seen_digest ?? null,
            seen_at: prior?.seen_at ?? null,
          };
          if (!flagOn) {
            // Dry run with the fetch flag off: no transcript read at all.
            report.outcome = "would_fetch";
            counts.would_fetch = (counts.would_fetch ?? 0) + 1;
            continue;
          }
          const step = await processCall(
            due,
            "backfill",
            policy,
            deps,
            req.dryRun,
          );
          if (
            !req.dryRun &&
            !["saved", "saved_existing", "duplicate_saved", "not_expected"]
              .includes(step.outcome)
          ) {
            pending = true;
          }
          tally(counts, step);
          report.outcome = step.outcome;
          if (step.code) report.code = step.code;
          if (step.sentences !== undefined) report.sentences = step.sentences;
          if (step.stop) {
            status = "partial";
            errorCode = step.stop;
            complete = false;
            break contactLoop;
          }
        }
        if (pending) {
          status = "partial";
          errorCode = "retry_pending";
          complete = false;
          break contactLoop;
        }
        cursor = page.next ? { ...cursor, message_page: page.next } : {
          ...cursor,
          conversation_ids: cursor.conversation_ids!.slice(1),
          message_page: null,
        };
      }
      lastDone = contact.ghl_contact_id;
      contactsDone++;
    }
  } catch (error) {
    status = "failed";
    complete = false;
    errorCode = codePart(
      (error as { code?: string })?.code ?? "backfill_read_failed",
    );
  }
  if (runId) {
    await deps.recordRun({
      run_id: runId,
      source: policy.backfill_run_source,
      status,
      counts,
      cursor: {
        actor: ACTOR,
        mode: "backfill",
        after: req.after,
        next_after: lastDone,
        next_cursor: cursor,
      },
      ...(errorCode ? { error_code: errorCode } : {}),
    });
  }
  return {
    outcome: "ran",
    dry_run: req.dryRun,
    run_id: runId,
    status,
    error_code: errorCode,
    contacts_done: contactsDone,
    next_after: lastDone,
    next_cursor: cursor,
    complete: complete && cursor === null && status === "succeeded",
    counts,
    calls,
  };
}
