-- T7 Loop 1 — Spine envelope additions to business_events (DRAFT — NOT YET APPLIED)
--
-- Status: draft only. Apply only after explicit user approval naming this
-- migration ("apply 20260502000001_t7_spine_envelope.sql").
--
-- Roadmap: cio/operations/2026-05-02-t7-evidence-capture-spine-roadmap.md (Section 3, Loop 2 apply)
-- Canon:   cio/operations/2026-05-01-jarvis-memory-extraction-canon.md
-- Audit:   cio/evidence/context-loop-v1/jarvis-raw-evidence-audit-2026-05-01/README.md
--
-- Why:
-- The Iter-2 audit established that business_events is the canonical extraction
-- substrate. The Iter-5 packet documented G1/G2/G3 (and added G11/T5-DEVQ-9 —
-- 310/310 proposed actions with no evidence_refs). T7 hardens the spine
-- envelope so every comms/ops writer can capture through one helper, every
-- spine row carries a stable backref to its source row, every unlinked event
-- is visible (not silently dropped), and bodies that exceed inline storage
-- get pointers + integrity hashes.
--
-- Core principles:
--   - APPEND-ONLY. business_events is never updated or deleted by T7.
--   - All new columns are NULLABLE for safe rollout (existing rows are not
--     rewritten). recordEvidence will populate them on every new write; a
--     30-day backfill (separate, gated) can later fill where derivable.
--   - The existing correlation_id (uuid) is kept untouched. We add thread_key
--     (text) for the source-system thread id (email Message-ID, GHL
--     conversation id, etc.). Distinct semantics: correlation_id groups all
--     events in one job lifecycle workflow; thread_key groups messages in
--     one source-side conversation thread.
--   - match_status non-null is enforced in code (recordEvidence validator);
--     the column itself is nullable here for backfill compatibility. A
--     follow-up migration in Loop 2 may add NOT NULL once backfill is done.
--   - No CHECK constraint rebuild on business_events (Cap 1A.1 territory).
--   - No new RLS policies (existing select_all/insert_only cover the new
--     columns). No service-role escalation needed.
--
-- Backfill scope (NOT performed by this migration):
--   Forward-only by default. A separate one-shot script can backfill the last
--   30 days of business_events.source_table/source_id from existing
--   payload.* fields where derivable, but is not required for forward correctness.
--   Run cost simulation: 30d ≈ 1500-2400 rows * one UPDATE each ≈ <1s wall.
--
-- Rollback:
--   ALTER TABLE business_events
--     DROP COLUMN IF EXISTS source_table,
--     DROP COLUMN IF EXISTS source_id,
--     DROP COLUMN IF EXISTS direction,
--     DROP COLUMN IF EXISTS channel,
--     DROP COLUMN IF EXISTS body_preview,
--     DROP COLUMN IF EXISTS safe_summary,
--     DROP COLUMN IF EXISTS body_pointer,
--     DROP COLUMN IF EXISTS body_hash,
--     DROP COLUMN IF EXISTS thread_key,
--     DROP COLUMN IF EXISTS conversation_key,
--     DROP COLUMN IF EXISTS contact_id,
--     DROP COLUMN IF EXISTS match_status,
--     DROP COLUMN IF EXISTS match_confidence,
--     DROP COLUMN IF EXISTS match_method,
--     DROP COLUMN IF EXISTS privacy_classification,
--     DROP COLUMN IF EXISTS retention_class;
--   DROP INDEX IF EXISTS idx_events_source_pointer;
--   DROP INDEX IF EXISTS idx_events_channel_occurred;
--   DROP INDEX IF EXISTS idx_events_contact_occurred;
--   DROP INDEX IF EXISTS idx_events_thread_occurred;
--   DROP INDEX IF EXISTS idx_events_quarantine;
--   Time-to-revert: <2s. All adds are additive nullable columns + indexes.
--
-- Downstream impact:
--   - Job Dossier reader (assemble_job_dossier): zero impact. Existing
--     SELECT * patterns inherit the new columns as additional fields.
--   - Extraction queue worker: zero impact. Worker reads (source_table,
--     source_id, extractor_version) which the queue rows already carry;
--     enriching the spine itself does not change extraction shape.
--   - T4 Secure Sale Path A reader: zero impact. The new columns are
--     additive; the contract validator does not require them.
--   - T6 Cap 1: zero impact. Stage gates read operational truth tables, not
--     spine envelope.

BEGIN;

ALTER TABLE public.business_events
  ADD COLUMN IF NOT EXISTS source_table            text,
  ADD COLUMN IF NOT EXISTS source_id               text,
  ADD COLUMN IF NOT EXISTS direction               text
      CHECK (direction IN ('inbound','outbound','internal','system','unknown') OR direction IS NULL),
  ADD COLUMN IF NOT EXISTS channel                 text
      CHECK (channel IN (
        'email','sms','call','telegram','note','document',
        'xero','po','wo','assignment','status','quote','invoice','payment',
        'scope','chat','audit','system'
      ) OR channel IS NULL),
  ADD COLUMN IF NOT EXISTS body_preview            text,
  ADD COLUMN IF NOT EXISTS safe_summary            text,
  ADD COLUMN IF NOT EXISTS body_pointer            text,
  ADD COLUMN IF NOT EXISTS body_hash               text,
  ADD COLUMN IF NOT EXISTS thread_key              text,
  ADD COLUMN IF NOT EXISTS conversation_key        text,
  ADD COLUMN IF NOT EXISTS contact_id              text,
  ADD COLUMN IF NOT EXISTS match_status            text
      CHECK (match_status IN ('matched','ambiguous','unresolved','ignored') OR match_status IS NULL),
  ADD COLUMN IF NOT EXISTS match_confidence        numeric(3,2)
      CHECK ((match_confidence IS NULL) OR (match_confidence BETWEEN 0.00 AND 1.00)),
  ADD COLUMN IF NOT EXISTS match_method            text,
  ADD COLUMN IF NOT EXISTS privacy_classification  text
      CHECK (privacy_classification IN (
        'internal','client_safe','staff_only','restricted_pii','audio_unredacted'
      ) OR privacy_classification IS NULL),
  ADD COLUMN IF NOT EXISTS retention_class         text
      CHECK (retention_class IN (
        '7y_audit','12m_default','6m_short','90d_transient'
      ) OR retention_class IS NULL);

-- Indexes (additive, non-blocking on adds; CONCURRENTLY would require
-- separate transactions and is left for the apply step if production size
-- becomes a concern).
CREATE INDEX IF NOT EXISTS idx_events_source_pointer
  ON public.business_events(source_table, source_id)
  WHERE source_table IS NOT NULL AND source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_channel_occurred
  ON public.business_events(channel, occurred_at DESC)
  WHERE channel IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_contact_occurred
  ON public.business_events(contact_id, occurred_at DESC)
  WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_thread_occurred
  ON public.business_events(thread_key, occurred_at DESC)
  WHERE thread_key IS NOT NULL;

-- Quarantine partial index — keeps the unresolved view fast even at scale.
CREATE INDEX IF NOT EXISTS idx_events_quarantine
  ON public.business_events(occurred_at DESC)
  WHERE match_status IN ('unresolved','ambiguous');

-- Comments document the envelope contract for future schema readers.
COMMENT ON COLUMN public.business_events.source_table IS
  'T7 envelope: name of the raw source table (e.g. inbox_events, ghl_conversation_cache, job_events, xero_invoices, purchase_orders). Required for new writes via recordEvidence.';
COMMENT ON COLUMN public.business_events.source_id IS
  'T7 envelope: primary key of the row in source_table. text not uuid because some sources use external ids (Graph message id, Xero invoice id, GHL message id).';
COMMENT ON COLUMN public.business_events.direction IS
  'T7 envelope: inbound | outbound | internal | system | unknown. Required for any comms event.';
COMMENT ON COLUMN public.business_events.channel IS
  'T7 envelope: domain channel for filtered reads and per-channel coverage health.';
COMMENT ON COLUMN public.business_events.body_preview IS
  'T7 envelope: <=500 char source-truncated text. May contain raw fragments. Safe for operators; not safe to surface in customer-facing copy.';
COMMENT ON COLUMN public.business_events.safe_summary IS
  'T7 envelope: <=280 char redaction-safe paraphrase fit for proposal cards, dossier rows, JARVIS answers.';
COMMENT ON COLUMN public.business_events.body_pointer IS
  'T7 envelope: storage URL or path for full body / attachment / audio / transcript. NULL when body fits inline.';
COMMENT ON COLUMN public.business_events.body_hash IS
  'T7 envelope: SHA-256 of canonical body or pointer target. Always written when body_pointer is set.';
COMMENT ON COLUMN public.business_events.thread_key IS
  'T7 envelope: stable thread/conversation id from the source system (email thread id, GHL conversation id, call session id). Distinct from correlation_id (which spans a job lifecycle workflow).';
COMMENT ON COLUMN public.business_events.conversation_key IS
  'T7 envelope: higher-level grouping when multiple threads roll up to one job-level conversation. Defaults to thread_key when not otherwise set.';
COMMENT ON COLUMN public.business_events.contact_id IS
  'T7 envelope: GHL contact id when known. Redundant with payload but lets the dossier filter without unwrapping JSON.';
COMMENT ON COLUMN public.business_events.match_status IS
  'T7 envelope: matched | ambiguous | unresolved | ignored. Quarantine semantics for evidence we cannot safely link. recordEvidence validator enforces non-null in code; column nullable here for backfill compatibility.';
COMMENT ON COLUMN public.business_events.match_confidence IS
  'T7 envelope: 0.00-1.00. <0.60 forces match_status=unresolved.';
COMMENT ON COLUMN public.business_events.match_method IS
  'T7 envelope: direct_job_id | direct_reference | contact_id | email_match | phone_match | thread_continuation | single_recent_active_job | supplier_relation | manual | none.';
COMMENT ON COLUMN public.business_events.privacy_classification IS
  'T7 envelope: internal | client_safe | staff_only | restricted_pii | audio_unredacted. Drives access control on body dereference.';
COMMENT ON COLUMN public.business_events.retention_class IS
  'T7 envelope: 7y_audit | 12m_default | 6m_short | 90d_transient. Drives storage retention sweep.';

COMMIT;
