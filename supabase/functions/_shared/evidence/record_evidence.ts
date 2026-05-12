// T7 Loop 1 — recordEvidence: the single capture choke point
//
// Roadmap: cio/operations/2026-05-02-t7-evidence-capture-spine-roadmap.md (Section 5)
//
// Every comms / ops writer routes through this helper. The helper:
//   - normalizes the envelope (truncates body_preview, computes safe_summary,
//     resolves match_status via the matching ladder, defaults privacy +
//     retention class);
//   - writes the body to Storage when present and records body_pointer + body_hash;
//   - inserts the business_events row;
//   - conditionally enqueues an extraction_jobs row;
//   - returns the canonical EvidenceRef for downstream proposal writers.
//
// Failure mode: a spine insert failure does NOT block the raw write. The
// raw write happens before recordEvidence is called. Spine failures log a
// minimal 'system.evidence_capture_failed' row using a direct insert so
// drops are visible.

import {
  BODY_PREVIEW_MAX,
  SAFE_SUMMARY_MAX,
  EXTRACTOR_ELIGIBLE_CHANNELS,
  EvidenceCapture,
  RecordEvidenceResult,
  Channel,
  Direction,
  PrivacyClassification,
  RetentionClass,
} from "./types.ts";
import { resolveMatch } from "./match.ts";
import { writeBody } from "./storage.ts";
import { makeEvidenceRef } from "./evidence_ref.ts";
import { isFlagOn } from "./feature_flag.ts";

/**
 * Supabase client surface. Typed as `any` because the @supabase/supabase-js
 * Deno types do not narrow cleanly to a stable subset across versions, and
 * every writer in this codebase already passes a service-role client. Tests
 * pass a hand-shaped fake (see record_evidence_test.ts).
 */
// deno-lint-ignore no-explicit-any
export type SupabaseLike = any;

export interface RecordEvidenceOptions {
  /**
   * Org id required to build storage paths. Single-org installs may pass
   * a constant; multi-org will derive from the source row.
   */
  org_id: string;

  /**
   * When true, the helper computes everything (envelope, hash, would-be
   * pointer) but does not insert into business_events or write to Storage
   * or enqueue. Used by tests and migration backfill simulation.
   */
  dry_run?: boolean;

  /**
   * Override the extractor channel allowlist. Default is
   * EXTRACTOR_ELIGIBLE_CHANNELS from types.ts.
   */
  extractor_eligible_channels?: Channel[];

  /**
   * Extractor version tag for the extraction_jobs row. Defaults to
   * 'context-fact-extractor:v1' to match T5 Iteration 4.
   */
  extractor_version?: string;

  /**
   * When true, skip the evidence_capture_v1 feature-flag check. Used by
   * tests + the agent_audit_log writer (which is structurally safe to log
   * even when capture is OFF). Default false.
   */
  bypass_feature_flag?: boolean;

  /**
   * Optional Supabase Storage client. When supplied AND options.dry_run
   * is false AND capture.body_full is set, the body is uploaded. Without
   * a client, writeBody runs in stub mode (returns pointer + hash, no
   * upload). Loop 3 writers pass `supabase.storage` here.
   */
  // deno-lint-ignore no-explicit-any
  storage_client?: any;
}

const DEFAULT_EXTRACTOR_VERSION = "context-fact-extractor:v1";

export async function recordEvidence(
  supabase: SupabaseLike,
  capture: EvidenceCapture,
  options: RecordEvidenceOptions,
): Promise<RecordEvidenceResult> {
  const warnings: string[] = [];

  // Validate caller-supplied envelope.
  validateRequired(capture);

  // Feature-flag short-circuit. When evidence_capture_v1 is OFF, fall
  // through to dry_run regardless of the caller's preference. Lets us
  // wire writers across many loops while keeping the flag as the single
  // structural enable.
  let effectiveDryRun = options.dry_run ?? false;
  if (!effectiveDryRun && !options.bypass_feature_flag) {
    const enabled = await isFlagOn(supabase, "evidence_capture_v1", options.org_id);
    if (!enabled) {
      effectiveDryRun = true;
      warnings.push("evidence_capture_v1 OFF — dry-run");
    }
  }

  // Resolve match status via the ladder.
  const match = resolveMatch({
    job_id: capture.job_id,
    match_method: capture.match_method,
    match_confidence: capture.match_confidence,
  });
  if (match.notes.length > 0) warnings.push(...match.notes);

  // Normalize body fields.
  const body_preview = truncate(capture.body_preview ?? "", BODY_PREVIEW_MAX);
  const safe_summary = truncate(
    capture.safe_summary ?? deriveSafeSummary(body_preview),
    SAFE_SUMMARY_MAX,
  );
  if (capture.body_preview && capture.body_preview.length > BODY_PREVIEW_MAX) {
    warnings.push(`body_preview truncated from ${capture.body_preview.length} to ${BODY_PREVIEW_MAX}`);
  }

  // Body storage. In dry-run, writeBody computes the pointer + hash but
  // does not upload. In live mode with a storage_client, the body is
  // uploaded to the bucket implied by the channel.
  let body_pointer: string | undefined;
  let body_hash: string | undefined;
  if (capture.body_full !== undefined && capture.body_full !== null) {
    try {
      const stored = await writeBody({
        org_id: options.org_id,
        channel: capture.channel,
        source_id: capture.source_id,
        body_full: capture.body_full,
        filename: capture.body_filename,
        mime: capture.body_mime,
      }, effectiveDryRun ? undefined : options.storage_client);
      body_pointer = stored.pointer;
      body_hash = stored.hash;
      if (stored.bytes > 5 * 1024 * 1024) {
        warnings.push(`body ${stored.bytes} bytes — large; verify retention/cost`);
      }
    } catch (e) {
      // Storage failure is non-fatal at the spine layer. We still record
      // the spine row (without body_pointer) so the event isn't lost; an
      // operator can re-fetch the body later from the source row.
      warnings.push(`storage write failed: ${(e as Error).message}; spine row recorded without body_pointer`);
      body_pointer = undefined;
      body_hash = undefined;
    }
  }

  // Privacy + retention defaults.
  const privacy_classification: PrivacyClassification =
    capture.privacy_classification ?? defaultPrivacy(capture.channel, capture.direction);
  const retention_class: RetentionClass =
    capture.retention_class ?? defaultRetention(capture.channel, capture.direction);

  // Build the spine row payload.
  const occurred_at = capture.occurred_at ?? new Date().toISOString();
  const conversation_key = capture.conversation_key ?? capture.thread_key ?? null;

  const spineRow = {
    event_type: capture.event_type,
    source: capture.source,
    occurred_at,
    entity_type: capture.entity_type ?? entityTypeForChannel(capture.channel),
    entity_id: capture.entity_id ?? capture.source_id,
    job_id: match.job_id,
    payload: capture.payload ?? {},
    metadata: {
      ...(capture.metadata ?? {}),
      t7_envelope_version: 1,
      match_notes: match.notes,
      warnings,
    },
    schema_version: "1.0",
    // T7 envelope columns
    source_table: capture.source_table,
    source_id: capture.source_id,
    direction: capture.direction,
    channel: capture.channel,
    body_preview: body_preview || null,
    safe_summary: safe_summary || null,
    body_pointer: body_pointer ?? null,
    body_hash: body_hash ?? null,
    thread_key: capture.thread_key ?? null,
    conversation_key,
    contact_id: capture.contact_id ?? null,
    match_status: match.match_status,
    match_confidence: match.match_confidence,
    match_method: match.match_method,
    privacy_classification,
    retention_class,
  };

  // Insert (or simulate).
  let spine_event_id: string;
  let inserted_occurred_at: string;
  if (effectiveDryRun) {
    spine_event_id = `dry-run-${cryptoRandom()}`;
    inserted_occurred_at = occurred_at;
  } else {
    // Real Supabase insert returns data:null unless we chain .select().
    // We need the inserted row's id + occurred_at so downstream consumers
    // (evidence_ref, extraction_jobs.metadata.spine_event_id, source-table
    // backref columns) point at a real row. Use .select('id, occurred_at')
    // and read [0]; .single() would throw on the empty case which we
    // already handle below.
    const result = await supabase.from("business_events")
      .insert(spineRow)
      .select("id, occurred_at");
    if (result.error) {
      warnings.push(`spine insert failed: ${result.error.message}`);
      // Best-effort drop-visibility log. Use a direct insert (NOT .select())
      // because we don't need the row back and the row itself is just a
      // tombstone. If even this fails, silent-drop is unavoidable.
      try {
        await supabase.from("business_events").insert({
          event_type: "system.evidence_capture_failed",
          source: "recordEvidence",
          occurred_at: new Date().toISOString(),
          entity_type: "system",
          entity_id: capture.source_id,
          job_id: capture.job_id,
          payload: {
            failed_event_type: capture.event_type,
            failed_source: capture.source,
            error: result.error.message,
          },
          metadata: { t7_envelope_version: 1 },
          schema_version: "1.0",
        });
      } catch {
        // Failure log itself failed; nothing more to do here.
      }
      throw new Error(`recordEvidence: spine insert failed: ${result.error.message}`);
    }
    const data = result.data as Array<{ id: string; occurred_at: string }> | null;
    if (!Array.isArray(data) || data.length === 0 || !data[0]?.id) {
      // The select chain returned no row even though the insert reported
      // no error. This shouldn't happen in normal Postgres semantics; if
      // it does, we cannot safely return an EvidenceRef pointing at a
      // non-existent id, so we throw and let the caller fall back to the
      // legacy path.
      throw new Error("recordEvidence: spine insert returned no row");
    }
    spine_event_id = data[0].id;
    inserted_occurred_at = data[0].occurred_at ?? occurred_at;
  }

  // Conditional extraction enqueue (Loop 8 wires real flow; Loop 1 only sets up the path).
  let extraction_job_id: string | undefined;
  const eligibleChannels = options.extractor_eligible_channels ?? EXTRACTOR_ELIGIBLE_CHANNELS;
  const extractionEligible =
    (capture.enqueueExtraction ?? eligibleChannels.includes(capture.channel)) &&
    match.match_status === "matched" &&
    match.job_id !== null;
  if (extractionEligible && !effectiveDryRun) {
    const enqueueResult = await supabase.from("extraction_jobs")
      .insert({
        job_id: match.job_id,
        source_table: "business_events",
        source_id: spine_event_id,
        source_event_type: capture.event_type,
        extractor_version: options.extractor_version ?? DEFAULT_EXTRACTOR_VERSION,
        priority: capture.extractor_priority ?? 5,
        status: "pending",
        metadata: {
          spine_event_id,
          occurred_at: inserted_occurred_at,
          channel: capture.channel,
          direction: capture.direction,
          original_source_table: capture.source_table,
          original_source_id: capture.source_id,
        },
      })
      .select("id");
    if (enqueueResult.error) {
      // Enqueue failure is non-fatal; spine row is already in.
      warnings.push(`extraction enqueue failed: ${enqueueResult.error.message}`);
    } else {
      const eqData = enqueueResult.data as Array<{ id: string }> | null;
      if (eqData && eqData.length > 0) {
        extraction_job_id = eqData[0].id;
      }
      // If select returned empty (e.g. ON CONFLICT DO NOTHING from the
      // dedupe constraint) the enqueue is structurally idempotent —
      // a queue row already exists for this (source_table, source_id,
      // extractor_version). Not a warning.
    }
  }

  // Return the EvidenceRef downstream writers can cite.
  const ref = makeEvidenceRef({
    id: spine_event_id,
    source_table: capture.source_table,
    source_id: capture.source_id,
    channel: capture.channel,
    direction: capture.direction,
    occurred_at: inserted_occurred_at,
    job_id: match.job_id,
    contact_id: capture.contact_id ?? null,
    thread_key: capture.thread_key ?? null,
    safe_summary,
    body_preview,
  });

  return {
    spine_event_id,
    spine_row: {
      id: spine_event_id,
      occurred_at: inserted_occurred_at,
      job_id: match.job_id,
      contact_id: capture.contact_id ?? null,
      channel: capture.channel,
      direction: capture.direction,
      match_status: match.match_status,
      match_confidence: match.match_confidence,
      match_method: match.match_method,
      body_pointer: body_pointer ?? null,
      body_hash: body_hash ?? null,
    },
    evidence_ref: ref,
    body_pointer,
    body_hash,
    extraction_job_id,
    warnings,
  };
}

function validateRequired(capture: EvidenceCapture) {
  if (!capture.event_type) throw new Error("recordEvidence: event_type required");
  if (!capture.source) throw new Error("recordEvidence: source required");
  if (!capture.source_table) throw new Error("recordEvidence: source_table required");
  if (!capture.source_id) throw new Error("recordEvidence: source_id required");
  if (!capture.channel) throw new Error("recordEvidence: channel required");
  if (!capture.direction) throw new Error("recordEvidence: direction required");
  if (capture.job_id === undefined) {
    throw new Error("recordEvidence: job_id must be string or null (undefined not allowed)");
  }
}

function truncate(text: string, max: number): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

/**
 * Default safe_summary derivation: collapse whitespace, strip control
 * characters, take the first sentence-ish chunk. Conservative fallback;
 * channel-specific writers can supply a better summary.
 */
function deriveSafeSummary(preview: string): string {
  if (!preview) return "";
  const collapsed = preview
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x1F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Cut at first sentence terminator if reasonable.
  const m = collapsed.match(/^(.{40,200}?[.!?])\s/);
  if (m) return m[1];
  return collapsed.slice(0, SAFE_SUMMARY_MAX);
}

function defaultPrivacy(channel: Channel, direction: Direction): PrivacyClassification {
  if (channel === "call") return "audio_unredacted";
  if (channel === "audit" || channel === "system") return "internal";
  if (direction === "inbound" || direction === "outbound") {
    // Customer-facing comms: staff-only by default; mailbox config can
    // upgrade to restricted_pii for personal mailboxes (Loop 3).
    return "staff_only";
  }
  return "internal";
}

function defaultRetention(channel: Channel, _direction: Direction): RetentionClass {
  if (channel === "call") return "12m_default";
  if (channel === "audit" || channel === "system") return "90d_transient";
  if (channel === "scope" || channel === "chat") return "12m_default";
  return "7y_audit";
}

function entityTypeForChannel(channel: Channel): string {
  switch (channel) {
    case "email":
    case "sms":
    case "call":
    case "telegram":
    case "chat":
      return "message";
    case "note":
      return "note";
    case "document":
      return "document";
    case "po":
      return "purchase_order";
    case "wo":
      return "work_order";
    case "assignment":
      return "assignment";
    case "quote":
      return "quote";
    case "invoice":
    case "payment":
    case "xero":
      return "invoice";
    case "status":
      return "job";
    case "scope":
      return "scope_session";
    case "audit":
      return "tool_call";
    default:
      return "system";
  }
}

function cryptoRandom(): string {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}
