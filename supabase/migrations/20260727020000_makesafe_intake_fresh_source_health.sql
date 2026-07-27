-- Make deterministic intake health measure fresh-source coverage, not merely
-- whether the bounded function invocation returned.

ALTER TABLE public.makesafe_intake_health
  ADD COLUMN IF NOT EXISTS latest_ingested_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS latest_final_fate_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS unfated_source_count bigint,
  ADD COLUMN IF NOT EXISTS oldest_unfated_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS fresh_source_lag_seconds bigint,
  ADD COLUMN IF NOT EXISTS last_fresh_source_accounted_at timestamptz;

ALTER TABLE public.makesafe_intake_health
  DROP CONSTRAINT IF EXISTS makesafe_intake_health_unfated_source_count_check;
ALTER TABLE public.makesafe_intake_health
  ADD CONSTRAINT makesafe_intake_health_unfated_source_count_check
  CHECK (unfated_source_count >= 0);

ALTER TABLE public.makesafe_intake_health
  DROP CONSTRAINT IF EXISTS makesafe_intake_health_fresh_source_lag_check;
ALTER TABLE public.makesafe_intake_health
  ADD CONSTRAINT makesafe_intake_health_fresh_source_lag_check
  CHECK (fresh_source_lag_seconds >= 0);

COMMENT ON COLUMN public.makesafe_intake_health.latest_ingested_received_at IS
  'Successfully committed SES mailbox high-water from mail_sync_cursors.last_completed_max.';
COMMENT ON COLUMN public.makesafe_intake_health.latest_final_fate_received_at IS
  'Newest eligible physical source received_at with exactly one durable case-source or classifier-exclusion fate.';
COMMENT ON COLUMN public.makesafe_intake_health.unfated_source_count IS
  'Eligible physical SES sources in the deterministic window without a durable case-source or classifier-exclusion fate.';
COMMENT ON COLUMN public.makesafe_intake_health.oldest_unfated_received_at IS
  'Oldest eligible physical SES source still lacking a final durable fate.';
COMMENT ON COLUMN public.makesafe_intake_health.fresh_source_lag_seconds IS
  'Age in seconds of oldest_unfated_received_at; zero when no eligible source is unfated.';
COMMENT ON COLUMN public.makesafe_intake_health.last_fresh_source_accounted_at IS
  'Most recent scan time at which a source that began the scan without a final fate gained one.';

CREATE OR REPLACE FUNCTION public.makesafe_intake_fresh_source_health(
  p_org_id uuid,
  p_mailbox text,
  p_since timestamptz,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE (
  latest_ingested_received_at timestamptz,
  latest_final_fate_received_at timestamptz,
  unfated_source_count bigint,
  oldest_unfated_received_at timestamptz,
  fresh_source_lag_seconds bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH eligible AS MATERIALIZED (
    SELECT
      e.post_id,
      e.received_at,
      (
        (
          SELECT count(*)
          FROM public.makesafe_intake_case_sources cs
          WHERE cs.org_id = p_org_id
            AND cs.post_id = e.post_id
        )
        +
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM public.email_classifier_exclusions exclusion
            WHERE exclusion.mailbox = p_mailbox
              AND exclusion.post_id = e.post_id
          )
          OR EXISTS (
            SELECT 1
            FROM public.email_events_raw event
            WHERE event.org_id = p_org_id
              AND event.post_id = e.post_id
              AND event.change_type = 'excluded'
          )
          THEN 1
          ELSE 0
        END
      ) = 1
      AS final_fate
    FROM public.emails e
    WHERE e.mailbox = p_mailbox
      AND e.received_at >= p_since
  ),
  aggregate AS (
    SELECT
      max(received_at) FILTER (WHERE final_fate)
        AS latest_final_fate_received_at,
      count(*) FILTER (WHERE NOT final_fate)
        AS unfated_source_count,
      min(received_at) FILTER (WHERE NOT final_fate)
        AS oldest_unfated_received_at
    FROM eligible
  )
  SELECT
    (
      SELECT cursor.last_completed_max
      FROM public.mail_sync_cursors cursor
      WHERE cursor.mailbox = p_mailbox
    ) AS latest_ingested_received_at,
    aggregate.latest_final_fate_received_at,
    aggregate.unfated_source_count,
    aggregate.oldest_unfated_received_at,
    CASE
      WHEN aggregate.oldest_unfated_received_at IS NULL THEN 0::bigint
      ELSE greatest(
        0::bigint,
        floor(
          extract(epoch FROM (p_now - aggregate.oldest_unfated_received_at))
        )::bigint
      )
    END AS fresh_source_lag_seconds
  FROM aggregate;
$$;

REVOKE ALL ON FUNCTION public.makesafe_intake_fresh_source_health(
  uuid,
  text,
  timestamptz,
  timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.makesafe_intake_fresh_source_health(
  uuid,
  text,
  timestamptz,
  timestamptz
) TO service_role, postgres;
