-- Never-miss-a-repair reconciliation — READ ONLY
--
-- Run this daily. It takes ten seconds to read and it is the only thing that
-- would tell you the repair pipeline is silently not being used.
--
-- WHY IT EXISTS
--   A missed repair is a correctly-executed make-safe. The card looks completely
--   normal, no alarm fires, no test fails, and nothing in the intake watchdog,
--   the draft heartbeat, the daily digest, the morning brief, the CEO report or
--   the Playwright suite can see it — all of those prove the MECHANISM works.
--   Only a comparison of INPUT SIGNAL against OUTPUT FAMILY can catch it.
--
--   On 90-day volumes this returns roughly two rows a quarter in section A, so
--   the daily false-positive load is effectively zero.
--
-- HOW TO READ IT: see scripts/README-repair-intake-reconciliation.md.
-- In one line: A is what should have become a repair, B is what did.
-- **A > B is the alarm.**
--
-- Every statement is a SELECT. Nothing here writes, locks or schedules anything.

\set ON_ERROR_STOP on

-- ─────────────────────────────────────────────────────────────────────────────
-- A. Work orders carrying an explicit repair signal in the last 48 hours.
--
-- These are the three signals the classifier itself treats as repair authority —
-- not prose, not a guess:
--   * subject matching \brapid repairs?\b
--   * a LABELLED standalone dispatch line (so an email signature reading
--     "Repair Coordinator | Rapid Repair" cannot produce a false positive)
--   * a declared-type header line in the work-order PDF
--
-- Deliberately ABSENT: MLB's `Makesafe/Emergency Repairs` work-order category.
-- It is 242 of the last 90 days' headers and the grammar maps it to make-safe on
-- purpose. Treating it as a repair signal is a captain decision that has not
-- been taken; adding it here would drown this check.
-- ─────────────────────────────────────────────────────────────────────────────
WITH suspects AS (
  SELECT
    d.id,
    d.created_at,
    d.status,
    left(coalesce(d.subject, ''), 120) AS detail,
    'subject_rapid_repair' AS signal
  FROM public.makesafe_intake_drafts d
  WHERE d.created_at > now() - interval '48 hours'
    AND d.subject ~* '\mrapid\s+repairs?\M'

  UNION ALL

  SELECT
    d.id,
    d.created_at,
    d.status,
    left(coalesce(d.body_preview, ''), 120),
    'dispatch_line_rapid_repair'
  FROM public.makesafe_intake_drafts d
  WHERE d.created_at > now() - interval '48 hours'
    AND coalesce(d.body_preview, '')
        ~* '(^|\n)\s*dispatch\s+(class|type)\s*:\s*rapid\s+repairs?\s*($|\n)'

  UNION ALL

  SELECT
    a.id,
    a.created_at,
    NULL,
    left(coalesce(a.pdf_extraction_text, ''), 120),
    'pdf_declared_repair'
  FROM public.email_attachments a
  WHERE a.created_at > now() - interval '48 hours'
    AND a.pdf_extraction_text
        ~* '(^|\n)\s*(rapid repairs?|scaffolding\s*/?\s*access equipment( external)?)\s*(\r?$|\n)'
)
SELECT signal, created_at, status, detail
FROM suspects
ORDER BY created_at DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- B. Repair-family jobs actually created in the same window.
-- All four board-authority markers, matching loadInsuranceRepairJobIds.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  count(*)                                                            AS repair_jobs_created,
  count(*) FILTER (WHERE j.type = 'repair')                           AS true_repair_type,
  count(*) FILTER (WHERE j.type <> 'repair')                          AS legacy_marker_only
FROM public.jobs j
WHERE j.org_id = '00000000-0000-0000-0000-000000000001'
  AND j.created_at > now() - interval '48 hours'
  AND (
    j.type = 'repair'
    OR j.metadata->>'makesafe_job_family' = 'repair'
    OR j.metadata->>'ses_family' = 'repair'
    OR EXISTS (
      SELECT 1 FROM public.makesafe_job_details d
      WHERE d.job_id = j.id AND d.report_type = 'repair'
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- C. Exceptions a human has to disposition, last 48 hours.
-- This is the lane with no screen: every one of these is a work order that
-- reached the pipeline and produced no job.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  reason_code,
  count(*)          AS cases,
  max(created_at)   AS most_recent
FROM public.makesafe_intake_cases
WHERE created_at > now() - interval '48 hours'
  AND state = 'exception'
GROUP BY 1
ORDER BY 2 DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- D. Drafts still waiting on a human, oldest first.
-- A repair sitting unapproved is a missed repair with a timer on it, and there
-- is no staleness alarm anywhere. The board's own list is capped at 50 rows, so
-- this is the only place the full queue is visible.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  count(*)                                                     AS open_drafts,
  count(*) FILTER (WHERE created_at < now() - interval '7 days')  AS older_than_7d,
  count(*) FILTER (WHERE created_at < now() - interval '21 days') AS older_than_21d,
  min(created_at)                                              AS oldest
FROM public.makesafe_intake_drafts
WHERE status = 'needs_review';
