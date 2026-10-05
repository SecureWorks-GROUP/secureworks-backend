// The GHL call transcript fetcher (context slice T2; design transcripts.md §2
// "Transcript: one writer, the fetcher", §3, §8, §12).
//
// GHL records our calls and writes its own transcript, split into the two
// sides of the line. This fetcher is the only writer of that transcript into
// the evidence log: a call.transcript_completed row keyed ghltx:<the call's
// GHL message id>, beside (never instead of) the call row keyed ghl:<id> that
// the webhook, the reconciler or M4's history load wrote (slice T1). It never
// pays for transcription, never downloads audio and never places a row on a
// job: the database ladder places it on insert, as for every door.
//
// Two modes over one per-call step (processCall):
//
//  * live (every 5 minutes, pg_cron): the calls due now, from
//    context_transcript_due_calls (last 14 days, plus any history call whose
//    backfill fetch record is pending and due, eligible from the stored
//    status and duration, no terminal outcome, next try due, 40 a run;
//    calls waiting for their agreeing second read first, then oldest first). Idle, with no provider read and no run row, while the fetch
//    flag ghl_call_transcript_fetch_v1 or the capture lane is off.
//
//  * history (backfill, run by hand): the owner asked for the past calls of
//    the jobs that are live now (24 Sep 2026: "for call transcripts i need
//    all the evidence of past jobs as well", "i just need it for the jobs
//    that are currently live"). The past call ROWS are written by the one GHL
//    history load (slice M4, ghl-history-load) and live capture (T1, the
//    reconciler); this mode only transcribes them. It takes the call rows of
//    live-job contacts (M4's context_ghl_history_live_jobs, the one live-job
//    definition) older than the live 14-day window, through the same
//    selection as the live run (context_transcript_due_calls, history mode).
//    It lists no GHL conversation and
//    writes no call row. Every transcript it saves is capture mode backfill,
//    so a past call never wakes an extraction read. dry_run is the default: a
//    dry run writes nothing at all (no transcript, no fetch record, no run
//    row), and while the fetch flag is off it reads no transcript either (it
//    lists the calls it would fetch, would_fetch). A real run needs the fetch
//    flag and the capture lane on, like the live fetcher: transcripts are the
//    most sensitive rows (transcripts.md §13, G-ANON). The agreement rule and
//    the backoff are the live ones, so a call is saved once two reads agree;
//    the live cron also takes due pending history calls, so their second read
//    and retries need no operator. History is finished only when no history
//    call is pending at all (context_transcript_history_pending, due or
//    waiting): the run reports more, pending_history and next_due_at until
//    then.
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
//     a voicemail answered with HTTP 400 or an unreadable body is terminal
//     not_expected voicemail_no_transcript at once; any other failure is an
//     error with its code. The backoff and when an
//     outcome becomes terminal are the database writer's
//     (record_call_transcript_fetch), never this file's.
//  4. Agreement rule (review M10): every read, live or history, saves only
//     when two reads at least agreement_minutes apart return the same words
//     (sentence count and digest); the first read is recorded and waits.
//  5. Build the row (buildGhlCallTranscriptRow) and save it through
//     capture_business_event; a duplicate is a save. Record the outcome.
//
// Logs and results carry ids, counts and codes only, never words.

import {
  buildGhlCallTranscriptRow,
  type CallRowFacts,
  type CaptureMode,
} from "../_shared/evidence/ghl_message.ts";
import {
  flattenTranscript,
  normaliseSentences,
  readTranscriptSentences,
} from "../_shared/ghl/call_transcript.ts";

export const FETCH_FLAG = "ghl_call_transcript_fetch_v1";
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
  historyDefaultCalls: 40,
  historyMaxCalls: 100,
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
  /** History mode only: the live jobs of the call's contact. */
  job_numbers?: string[] | null;
  /** The open fetch record's mode; a backfill record is always saved as backfill. */
  fetch_mode?: string | null;
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

export interface BackfillDeps extends FetchDeps {
  /** context_transcript_due_calls in history mode. Throws when unreadable. */
  historyCalls(limit: number): Promise<DueCall[]>;
  /** context_transcript_history_pending. Throws when unreadable. */
  historyPending(): Promise<HistoryPending>;
}

/** History calls still unfinished: pending fetch records, due or waiting. */
export interface HistoryPending {
  pending: number;
  next_due_at: string | null;
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

/** Whether GHL's own status or message type says the call is a voicemail. */
export function providerVoicemail(
  status: string | null,
  messageType: string | null,
): boolean {
  return (status ?? "").toLowerCase() === "voicemail" ||
    (messageType ?? "").toUpperCase().replace(/^TYPE_/, "") === "VOICEMAIL";
}

/**
 * A voicemail GHL answered with no usable transcription: the transcription
 * read refused (HTTP 400, as for a no-answer call) or returned a body that is
 * not a sentence list. Seen live 4 Oct 2026: 7 voicemails retried as
 * provider_invalid. Ends terminal on the first such read, never retried.
 */
export const VOICEMAIL_NO_TRANSCRIPT = "voicemail_no_transcript";

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
): { eligible: true } | {
  eligible: false;
  code: string;
  outcome: "not_ready" | "not_expected";
} {
  const s = (status ?? "").toLowerCase();
  if (providerVoicemail(status, messageType)) return { eligible: true };
  if (s === "completed") {
    if (duration === null || duration >= minSeconds) return { eligible: true };
    return {
      eligible: false,
      code: "provider_too_short",
      outcome: "not_expected",
    };
  }
  return {
    eligible: false,
    code: `provider_status_${codePart(s || "none")}`,
    outcome:
      ["no-answer", "busy", "failed", "canceled", "cancelled"].includes(s)
        ? "not_expected"
        : "not_ready",
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
      { result: eligible.outcome, code: eligible.code, ...provider },
      {
        outcome: eligible.outcome,
        code: eligible.code,
        reads: 1,
      },
    );
  }

  // 3. The transcription. A voicemail with no usable transcription ends at
  // once (VOICEMAIL_NO_TRANSCRIPT); a 404 or an empty list is still not ready.
  const voicemail = providerVoicemail(finalStatus, text(item.messageType));
  const noVoicemailTranscript = () =>
    record(
      { result: "not_expected", code: VOICEMAIL_NO_TRANSCRIPT, ...provider },
      { outcome: "not_expected", code: VOICEMAIL_NO_TRANSCRIPT, reads: 2 },
    );
  const tx = await deps.readTranscription(call.call_message_id);
  if (!tx.ok && voicemail && tx.status === 400) return noVoicemailTranscript();
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
  if (!read.ok && voicemail) return noVoicemailTranscript();
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
  const captureMode: CaptureMode =
    mode === "backfill" || call.fetch_mode === "backfill"
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
      counts.errors++;
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
  if (counts.record_failed > 0 && status !== "failed") {
    status = "partial";
    errorCode = "record_failed";
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

export interface BackfillRequest {
  dryRun: boolean;
  maxCalls: number;
}

export interface BackfillCallReport {
  call_message_id: string;
  contact_id: string;
  job_numbers: string[];
  event_at: string;
  outcome: CallOutcome | "would_fetch";
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
    /**
     * True while history is unfinished: the selection filled the page, the
     * run stopped early, or a history call is still pending (unknown counts
     * as unfinished).
     */
    more: boolean;
    /** History calls with a pending fetch record after this run; null if unreadable. */
    pending_history: number | null;
    /** The earliest next try among them. */
    next_due_at: string | null;
    counts: Record<string, number>;
    calls: BackfillCallReport[];
  };

/** The history mode: transcribe past calls of live-job contacts. */
export async function runBackfill(
  req: BackfillRequest,
  deps: BackfillDeps,
): Promise<BackfillResult> {
  // The fetch flag gates every transcript read, not only every write: a real
  // run is refused while it is off, and a dry run then lists the calls it
  // would fetch without ever asking GHL for a transcript's words.
  const flagOn = await deps.flagOn();
  if (!req.dryRun) {
    if (!flagOn) return { outcome: "refused", reason: "fetch_flag_off" };
    if (!(await deps.laneOn())) {
      return { outcome: "refused", reason: "capture_lane_off" };
    }
  }
  const policy = await deps.policy();
  const started = deps.now();
  const max = Math.max(
    1,
    Math.min(
      LIMITS.historyMaxCalls,
      Math.trunc(req.maxCalls) || LIMITS.historyDefaultCalls,
    ),
  );
  const runId = req.dryRun ? null : await deps.recordRun({
    source: policy.backfill_run_source,
    status: "running",
    cursor: { actor: ACTOR, mode: "backfill" },
  });
  const counts: Record<string, number> = { ...emptyCounts(), would_fetch: 0 };
  const calls: BackfillCallReport[] = [];
  let status: "succeeded" | "partial" | "failed" = "succeeded";
  let errorCode: string | null = null;
  let more = false;
  try {
    const selected = await deps.historyCalls(max);
    more = selected.length >= max;
    for (const call of selected) {
      if (deps.now() - started > LIMITS.timeBudgetMs) {
        status = "partial";
        errorCode = "time_budget";
        more = true;
        break;
      }
      counts.selected++;
      const report: BackfillCallReport = {
        call_message_id: call.call_message_id,
        contact_id: call.contact_id,
        job_numbers: call.job_numbers ?? [],
        event_at: call.event_at,
        outcome: "would_fetch",
      };
      calls.push(report);
      if (!flagOn) {
        // Dry run with the fetch flag off: no transcript read at all.
        counts.would_fetch++;
        continue;
      }
      const step = await processCall(
        call,
        "backfill",
        policy,
        deps,
        req.dryRun,
      );
      tally(counts, step);
      report.outcome = step.outcome;
      if (step.code) report.code = step.code;
      if (step.sentences !== undefined) report.sentences = step.sentences;
      if (step.stop) {
        status = "partial";
        errorCode = step.stop;
        more = true;
        break;
      }
    }
  } catch (error) {
    status = "failed";
    errorCode = codePart(
      (error as { code?: string })?.code ?? "history_calls_unreadable",
    );
  }
  if (counts.record_failed > 0 && status !== "failed") {
    status = "partial";
    errorCode = "record_failed";
  }
  let pending: HistoryPending | null = null;
  try {
    pending = await deps.historyPending();
  } catch {
    if (status !== "failed") {
      status = "partial";
      errorCode = errorCode ?? "history_pending_unreadable";
    }
  }
  if (!pending || pending.pending > 0) more = true;
  if (runId) {
    await deps.recordRun({
      run_id: runId,
      source: policy.backfill_run_source,
      status,
      counts,
      ...(errorCode ? { error_code: errorCode } : {}),
    });
  }
  return {
    outcome: "ran",
    dry_run: req.dryRun,
    run_id: runId,
    status,
    error_code: errorCode,
    more,
    pending_history: pending?.pending ?? null,
    next_due_at: pending?.next_due_at ?? null,
    counts,
    calls,
  };
}
