-- T7 Loop 2 — Evidence Health views (DRAFT — NOT YET APPLIED)
--
-- Status: draft only. Apply only after explicit user approval naming this
-- migration ("apply 20260502000010_v_evidence_health.sql") and AFTER
-- 20260502000001_t7_spine_envelope.sql is applied.
--
-- Roadmap: cio/operations/2026-05-02-t7-evidence-capture-spine-roadmap.md (Section 9, Loop 2)
--
-- Why:
-- Marnin's instruction: visibility before broad writer changes. These views
-- show what is and is not landing in the spine — across channels, sources,
-- and the proposed-action layer (T5-DEVQ-9) — without any writer touched.
-- They run against the existing spine plus the new envelope columns.
-- Existing rows have NULL envelope values; that is itself useful signal.
--
-- Views shipped in this draft:
--   v_evidence_health             : per channel/direction/source_table coverage matrix
--   v_evidence_health_queue       : extraction_jobs by status
--   v_evidence_health_mailbox     : per-mailbox last-seen (joins monitored_mailboxes when available)
--   v_evidence_health_proposals   : ai_proposed_actions evidence_refs coverage
--   v_evidence_health_stale       : channels with zero traffic in last 24h that normally have traffic
--
-- All views are READ-ONLY. They never UPDATE or DELETE.
--
-- Performance posture:
--   30-day window keeps every view fast. Indexes added by the spine envelope
--   migration cover (channel, occurred_at), (source_table, source_id),
--   (contact_id, occurred_at), (thread_key, occurred_at), and the unresolved
--   partial index. If production volumes push these views past 500ms, swap
--   to MATERIALIZED VIEW with a 5-minute refresh.
--
-- Rollback:
--   DROP VIEW IF EXISTS public.v_evidence_health_stale;
--   DROP VIEW IF EXISTS public.v_evidence_health_proposals;
--   DROP VIEW IF EXISTS public.v_evidence_health_mailbox;
--   DROP VIEW IF EXISTS public.v_evidence_health_queue;
--   DROP VIEW IF EXISTS public.v_evidence_health;
--   Time-to-revert: <1s.

BEGIN;

-- ----------------------------------------------------------------
-- Per-channel / direction / source coverage matrix (last 30 days)
-- ----------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_evidence_health AS
SELECT
  COALESCE(channel, '_legacy_no_channel')                 AS channel,
  COALESCE(direction, '_legacy_no_direction')             AS direction,
  COALESCE(source_table, '_legacy_no_source_table')       AS source_table,
  COUNT(*)                                                AS rows_30d,
  COUNT(*) FILTER (WHERE job_id IS NULL)                  AS missing_job,
  COUNT(*) FILTER (WHERE contact_id IS NULL)              AS missing_contact,
  COUNT(*) FILTER (WHERE channel IS NULL
                     OR direction IS NULL
                     OR source_table IS NULL
                     OR source_id IS NULL)                AS missing_envelope,
  COUNT(*) FILTER (WHERE body_preview IS NULL
                     AND channel IN ('email','sms','call','telegram','note'))
                                                          AS comms_missing_preview,
  COUNT(*) FILTER (WHERE body_preview IS NOT NULL
                     AND char_length(body_preview) >= 500
                     AND body_pointer IS NULL)
                                                          AS preview_truncated_no_pointer,
  COUNT(*) FILTER (WHERE match_status = 'matched')        AS matched,
  COUNT(*) FILTER (WHERE match_status = 'ambiguous')      AS ambiguous,
  COUNT(*) FILTER (WHERE match_status = 'unresolved')     AS unresolved,
  COUNT(*) FILTER (WHERE match_status = 'ignored')        AS ignored,
  COUNT(*) FILTER (WHERE match_status IS NULL)            AS no_match_status,
  MAX(occurred_at)                                        AS last_event_at,
  MIN(occurred_at)                                        AS first_event_at
FROM public.business_events
WHERE occurred_at > now() - interval '30 days'
GROUP BY 1, 2, 3
ORDER BY channel, direction, source_table;

COMMENT ON VIEW public.v_evidence_health IS
  'T7 Evidence Health: per-channel / direction / source_table coverage matrix over the last 30 days of business_events. Shows missing job / contact / envelope / preview-without-pointer counts plus match_status histogram. NULL envelope columns surface rows that pre-date Loop 3 writer migration.';

-- ----------------------------------------------------------------
-- Extraction queue health
-- ----------------------------------------------------------------
-- Single shape: status -> count. extraction_jobs lives in 20260501160000.
-- View exists even when extraction_jobs is empty (T5 Iter-5: 0 rows live).

CREATE OR REPLACE VIEW public.v_evidence_health_queue AS
SELECT
  status,
  COUNT(*)                  AS n,
  MIN(created_at)           AS oldest_created_at,
  MAX(created_at)           AS newest_created_at,
  MAX(processed_at)         AS newest_processed_at
FROM public.extraction_jobs
GROUP BY status
ORDER BY status;

COMMENT ON VIEW public.v_evidence_health_queue IS
  'T7 Evidence Health: extraction_jobs queue counts by status. Empty until Loop 8 enqueuer ships.';

-- ----------------------------------------------------------------
-- Per-mailbox last-seen
-- ----------------------------------------------------------------
-- Joins monitored_mailboxes when applied. Until Loop 8, derives from the
-- existing inbox_events rows (mailbox column has been live since
-- 20260405000003).

CREATE OR REPLACE VIEW public.v_evidence_health_mailbox AS
SELECT
  ie.mailbox                          AS mailbox,
  COUNT(*) FILTER (WHERE ie.received_at > now() - interval '24 hours') AS rows_24h,
  COUNT(*) FILTER (WHERE ie.received_at > now() - interval '7 days')   AS rows_7d,
  COUNT(*) FILTER (WHERE ie.received_at > now() - interval '30 days')  AS rows_30d,
  MAX(ie.received_at)                 AS last_message_at,
  MAX(ie.processed_at)                AS last_processed_at
FROM public.inbox_events ie
WHERE ie.received_at > now() - interval '30 days'
   OR ie.processed_at > now() - interval '30 days'
GROUP BY ie.mailbox
ORDER BY ie.mailbox;

COMMENT ON VIEW public.v_evidence_health_mailbox IS
  'T7 Evidence Health: per-mailbox last-seen and 24h/7d/30d traffic. Pre-Loop-8 derives from inbox_events.mailbox; post-Loop-8 will LEFT JOIN monitored_mailboxes for enabled flag and last_polled_at.';

-- ----------------------------------------------------------------
-- Proposed-action evidence_refs coverage (T5-DEVQ-9 surface)
-- ----------------------------------------------------------------
-- T5 Iter-5: 310/310 rows in 30d carry zero evidence_refs. T7 Loop 8 closes
-- this. Until then, this view shows the gap.

CREATE OR REPLACE VIEW public.v_evidence_health_proposals AS
SELECT
  COUNT(*)                                        AS rows_30d,
  COUNT(*) FILTER (WHERE
    action_payload ? 'evidence_refs'
    AND jsonb_typeof(action_payload->'evidence_refs') = 'array'
    AND jsonb_array_length(action_payload->'evidence_refs') > 0
  )                                               AS with_evidence_refs,
  COUNT(*) FILTER (WHERE
    NOT (action_payload ? 'evidence_refs')
    OR jsonb_typeof(action_payload->'evidence_refs') <> 'array'
    OR jsonb_array_length(action_payload->'evidence_refs') = 0
  )                                               AS without_evidence_refs,
  COUNT(*) FILTER (WHERE
    action_payload->>'exception_reason' IN
      ('synthetic_probe','scheduled_cleanup','first_run_bootstrap','health_check')
  )                                               AS with_exception_reason,
  COUNT(*) FILTER (WHERE status = 'proposed')     AS proposed,
  COUNT(*) FILTER (WHERE status = 'approved')     AS approved,
  COUNT(*) FILTER (WHERE status = 'rejected')     AS rejected,
  MAX(created_at)                                 AS latest_proposal_at
FROM public.ai_proposed_actions
WHERE created_at > now() - interval '30 days';

COMMENT ON VIEW public.v_evidence_health_proposals IS
  'T7 Evidence Health: ai_proposed_actions evidence_refs coverage over 30 days. T5 Iter-5 baseline: 310/310 missing. Loop 8 closes this via evidence_refs_strict_mode.';

-- ----------------------------------------------------------------
-- Stale channel alarms
-- ----------------------------------------------------------------
-- Channels that historically saw traffic but have zero rows in last 24h.
-- Powers the daily-digest fragment.

CREATE OR REPLACE VIEW public.v_evidence_health_stale AS
WITH per_channel AS (
  SELECT
    COALESCE(channel, '_legacy_no_channel')                            AS channel,
    COUNT(*) FILTER (WHERE occurred_at > now() - interval '24 hours')  AS rows_24h,
    COUNT(*) FILTER (WHERE occurred_at > now() - interval '7 days')    AS rows_7d,
    MAX(occurred_at)                                                   AS last_event_at
  FROM public.business_events
  WHERE occurred_at > now() - interval '7 days'
  GROUP BY 1
)
SELECT *
FROM per_channel
WHERE rows_7d > 5            -- has historical traffic
  AND rows_24h = 0           -- but nothing today
ORDER BY last_event_at;

COMMENT ON VIEW public.v_evidence_health_stale IS
  'T7 Evidence Health: channels that saw >5 rows in the last 7 days but zero in the last 24 hours. Drives daily-digest stale-channel alarms.';

COMMIT;
