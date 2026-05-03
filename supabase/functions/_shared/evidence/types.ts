// T7 Loop 1 — Shared evidence envelope types
//
// Roadmap: cio/operations/2026-05-02-t7-evidence-capture-spine-roadmap.md
// Migration: 20260502000001_t7_spine_envelope.sql (DRAFT)
//
// Single source for envelope semantics. Every writer that emits raw evidence
// imports from here. Do NOT redefine these types in writer code.

export type Direction =
  | "inbound"
  | "outbound"
  | "internal"
  | "system"
  | "unknown";

export type Channel =
  | "email"
  | "sms"
  | "call"
  | "telegram"
  | "note"
  | "document"
  | "xero"
  | "po"
  | "wo"
  | "assignment"
  | "status"
  | "quote"
  | "invoice"
  | "payment"
  | "scope"
  | "chat"
  | "audit"
  | "system";

export type MatchStatus =
  | "matched"
  | "ambiguous"
  | "unresolved"
  | "ignored";

export type MatchMethod =
  | "direct_job_id"
  | "direct_reference"
  | "contact_id"
  | "email_match"
  | "phone_match"
  | "thread_continuation"
  | "single_recent_active_job"
  | "supplier_relation"
  | "manual"
  | "none";

export type PrivacyClassification =
  | "internal"
  | "client_safe"
  | "staff_only"
  | "restricted_pii"
  | "audio_unredacted";

export type RetentionClass =
  | "7y_audit"
  | "12m_default"
  | "6m_short"
  | "90d_transient";

/**
 * Caps. Enforced by the helper; never bypass.
 */
export const BODY_PREVIEW_MAX = 500;
export const SAFE_SUMMARY_MAX = 280;

/**
 * Confidence floor below which a match is downgraded to 'unresolved'
 * regardless of the proposed match_method.
 */
export const MATCH_CONFIDENCE_FLOOR = 0.60;

/**
 * Channels that are extractor-eligible by default. The recordEvidence
 * helper enqueues an extraction_jobs row only when the channel is on this
 * allowlist AND a job_id is present AND match_status === 'matched'.
 *
 * Conservative by design (per T5 Iter-5 enqueuer recommendation): start
 * with email and notes; expand only after observing skipped/done rates.
 */
export const EXTRACTOR_ELIGIBLE_CHANNELS: Channel[] = [
  "email",
  "note",
];

/**
 * Canonical EvidenceRef shape returned by recordEvidence and required on
 * every ai_proposed_actions.action_payload.evidence_refs[] entry.
 *
 * Closes T5-DEVQ-9. See roadmap Section 18.
 */
export interface EvidenceRef {
  evidence_id: string;       // business_events.id
  source_table: string;
  source_id: string;
  channel: Channel;
  direction: Direction;
  occurred_at: string;       // ISO
  job_id: string | null;
  contact_id: string | null;
  thread_key?: string | null;
  summary: string;           // safe_summary OR truncated body_preview
}

/**
 * Input to recordEvidence.
 *
 * job_id is required-or-explicit-null. Pass null when you genuinely could
 * not match (the helper will set match_status='unresolved'). Do NOT pass
 * undefined — that is a programmer error.
 */
export interface EvidenceCapture {
  // Event identity
  event_type: string;
  source: string;                                     // e.g. "monitor-inbox", "send-quote/send"
  occurred_at?: string;
  channel: Channel;
  direction: Direction;

  // Source row backref
  source_table: string;
  source_id: string;

  // Linkage (job_id may be null; helper will quarantine)
  job_id: string | null;
  contact_id?: string | null;
  entity_type?: string;
  entity_id?: string;

  // Match outcome (caller may suggest; helper enforces floor and policy)
  match_method?: MatchMethod;
  match_confidence?: number;                          // 0-1; helper clamps and validates

  // Body
  body_preview?: string;                              // helper truncates to BODY_PREVIEW_MAX
  safe_summary?: string;                              // helper truncates to SAFE_SUMMARY_MAX
  body_full?: string | Uint8Array;                    // when set, helper writes to storage and records pointer
  body_filename?: string;
  body_mime?: string;

  // Threading
  thread_key?: string | null;
  conversation_key?: string | null;

  // Privacy/retention (defaulted by channel + direction if not supplied)
  privacy_classification?: PrivacyClassification;
  retention_class?: RetentionClass;

  // Domain extras
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;

  // Extraction
  enqueueExtraction?: boolean;                        // override default channel allowlist
  extractor_priority?: number;                        // 1..9, lower = higher priority
}

export interface RecordEvidenceResult {
  spine_event_id: string;
  spine_row: {
    id: string;
    occurred_at: string;
    job_id: string | null;
    contact_id: string | null;
    channel: Channel;
    direction: Direction;
    match_status: MatchStatus;
    match_confidence: number | null;
    match_method: MatchMethod | null;
    body_pointer: string | null;
    body_hash: string | null;
  };
  evidence_ref: EvidenceRef;
  body_pointer?: string;
  body_hash?: string;
  extraction_job_id?: string;                          // when enqueued
  warnings: string[];                                  // non-fatal issues (preview truncated, etc.)
}
