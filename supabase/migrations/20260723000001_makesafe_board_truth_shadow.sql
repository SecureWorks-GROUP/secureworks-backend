-- Make-safe board truth M1: additive shadow status, attributed holds and
-- reconciliation read model. This migration does not rewrite substatus, move a
-- card, backfill jobs, or cut either UI over to computed status.

ALTER TABLE public.makesafe_job_details
  ADD COLUMN IF NOT EXISTS computed_status text,
  ADD COLUMN IF NOT EXISTS computed_status_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS computed_status_missing jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS computed_status_at timestamptz;

ALTER TABLE public.makesafe_job_details
  DROP CONSTRAINT IF EXISTS makesafe_job_details_computed_status_check;
ALTER TABLE public.makesafe_job_details
  ADD CONSTRAINT makesafe_job_details_computed_status_check
  CHECK (computed_status IS NULL OR computed_status IN (
    'new', 'allocated', 'trade_report_in', 'report_ready',
    'completed', 'archive', 'cancelled'
  ));

CREATE INDEX IF NOT EXISTS idx_makesafe_job_details_computed_status
  ON public.makesafe_job_details (computed_status)
  WHERE computed_status IS NOT NULL;

COMMENT ON COLUMN public.makesafe_job_details.computed_status IS
  'M1 shadow-only board status computed from evidence. The Ops and Trade UIs continue to read the declared board model until a separately approved cutover.';
COMMENT ON COLUMN public.makesafe_job_details.computed_status_reasons IS
  'Stable explanations emitted by the M1 pure status engine for its current shadow verdict.';
COMMENT ON COLUMN public.makesafe_job_details.computed_status_missing IS
  'Evidence still missing at the current shadow verdict. Read-only reconciliation context, never a status writer.';
COMMENT ON COLUMN public.makesafe_job_details.computed_status_at IS
  'When the shadow verdict was last refreshed. NULL means not computed yet.';

CREATE TABLE IF NOT EXISTS public.makesafe_status_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  cycle_number integer NOT NULL DEFAULT 1 CHECK (cycle_number >= 1),
  reason_code text NOT NULL CHECK (reason_code IN (
    -- Reporting-skill case_story_recovery.FAILURE_CODES, verbatim.
    'login-failure', 'network-failure', 'missing-email', 'missing-attachment',
    'wrong-job', 'wrong-reference', 'conflicting-identity',
    'changed-portal-content', 'expired-link', 'inaccessible-link',
    'capture-failure', 'recovery-not-run', 'ambiguous-evidence',
    -- Captain-approved board superset (D6).
    'awaiting_client_callback', 'access_blocked', 'duplicate_suspected',
    'manual_review'
  )),
  note text NOT NULL CHECK (length(btrim(note)) > 0),
  held_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  lifted_at timestamptz,
  lifted_by uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT makesafe_status_holds_lift_pair_check CHECK (
    (lifted_at IS NULL AND lifted_by IS NULL) OR
    (lifted_at IS NOT NULL AND lifted_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_makesafe_status_holds_one_live_per_cycle
  ON public.makesafe_status_holds (job_id, cycle_number)
  WHERE lifted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_makesafe_status_holds_live
  ON public.makesafe_status_holds (job_id, created_at DESC)
  WHERE lifted_at IS NULL;

ALTER TABLE public.makesafe_status_holds ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.makesafe_status_holds TO service_role;
DROP POLICY IF EXISTS service_role_all_makesafe_status_holds
  ON public.makesafe_status_holds;
CREATE POLICY service_role_all_makesafe_status_holds
  ON public.makesafe_status_holds FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.makesafe_status_holds IS
  'Captain-approved reason-coded hold facts. Holds render as badges on the evidence-derived column; they never move a card or rewrite substatus.';

-- One bounded batch write for the shadow refresh. The edge function supplies
-- pure-engine verdicts for existing detail rows; this RPC cannot insert cards or
-- alter any declared field. Unknown/malformed entries are ignored.
CREATE OR REPLACE FUNCTION public.refresh_makesafe_status_shadow(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  changed_count integer := 0;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a JSON array';
  END IF;

  WITH incoming AS (
    SELECT
      x.job_id,
      x.computed_status,
      COALESCE(x.reasons, '[]'::jsonb) AS reasons,
      COALESCE(x.missing, '[]'::jsonb) AS missing,
      COALESCE(x.computed_at, now()) AS computed_at
    FROM jsonb_to_recordset(p_rows) AS x(
      job_id uuid,
      computed_status text,
      reasons jsonb,
      missing jsonb,
      computed_at timestamptz
    )
    WHERE x.job_id IS NOT NULL
      AND x.computed_status IN (
        'new', 'allocated', 'trade_report_in', 'report_ready',
        'completed', 'archive', 'cancelled'
      )
  ), updated AS (
    UPDATE public.makesafe_job_details d
    SET computed_status = i.computed_status,
        computed_status_reasons = i.reasons,
        computed_status_missing = i.missing,
        computed_status_at = i.computed_at
    FROM incoming i
    WHERE d.job_id = i.job_id
    RETURNING d.job_id
  )
  SELECT count(*) INTO changed_count FROM updated;

  RETURN changed_count;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_makesafe_status_shadow(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_makesafe_status_shadow(jsonb) TO service_role;

-- Queryable reconciliation surface beside the raw declared substatus. This view
-- intentionally does not mutate either field. Closed substatus matches both the
-- seven-day Completed window and Archive.
CREATE OR REPLACE VIEW public.makesafe_status_disagreements
WITH (security_invoker = true)
AS
WITH compared AS (
  SELECT
    j.id AS job_id,
    j.job_number,
    j.status AS job_status,
    d.substatus AS declared_substatus,
    CASE
      WHEN lower(j.status) IN ('cancelled', 'canceled') THEN 'cancelled'
      WHEN lower(j.status) = 'archived' THEN 'archive'
      WHEN d.substatus = 'company_contact_required' THEN 'new'
      WHEN d.substatus IN ('company_contact_done', 'waiting_on_trade_report') THEN 'allocated'
      WHEN d.substatus = 'admin_to_send_report' THEN 'trade_report_in'
      WHEN d.substatus = 'ready_to_invoice' THEN 'report_ready'
      WHEN d.substatus = 'complete' THEN 'completed'
      ELSE NULL
    END AS declared_status,
    d.computed_status,
    d.computed_status_reasons,
    d.computed_status_missing,
    d.computed_status_at
  FROM public.jobs j
  JOIN public.makesafe_job_details d ON d.job_id = j.id
  WHERE j.type = 'makesafe'
    AND lower(j.status) NOT IN ('lost', 'deleted')
    AND d.computed_status IS NOT NULL
)
SELECT
  *,
  jsonb_build_object(
    'summary', format('declared %s; evidence computes %s', declared_status, computed_status),
    'reasons', computed_status_reasons,
    'missing', computed_status_missing
  ) AS why_they_differ
FROM compared
WHERE NOT (
  declared_status = computed_status OR
  (declared_substatus = 'complete' AND computed_status IN ('completed', 'archive'))
);

GRANT SELECT ON public.makesafe_status_disagreements TO service_role;
COMMENT ON VIEW public.makesafe_status_disagreements IS
  'M1 captain reconciliation list: card, raw declared substatus, mapped declared status, computed shadow status, and evidence explanation. No UI consumes this view.';

-- Cheap standing refresh and alarm-only canary. Both are gated by the existing
-- make-safe cron switch. The canary endpoint is read-only; its only effect is a
-- loud edge log when an invariant fails.
CREATE OR REPLACE FUNCTION public.trigger_makesafe_status_shadow_refresh()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  svc_key text;
BEGIN
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_makesafe_status_shadow_refresh: cron gate disabled; skipping';
    RETURN;
  END IF;
  SELECT decrypted_secret INTO svc_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key'
    LIMIT 1;

  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=makesafe_status_shadow_refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || svc_key
    ),
    body := '{}'::jsonb
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_makesafe_status_canary()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  svc_key text;
BEGIN
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_makesafe_status_canary: cron gate disabled; skipping';
    RETURN;
  END IF;
  SELECT decrypted_secret INTO svc_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key'
    LIMIT 1;

  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=makesafe_status_canary',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || svc_key
    ),
    body := '{}'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_makesafe_status_shadow_refresh() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trigger_makesafe_status_canary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_makesafe_status_shadow_refresh() TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.trigger_makesafe_status_canary() TO service_role, postgres;

DO $$
BEGIN
  PERFORM cron.unschedule('makesafe-status-shadow-refresh')
    FROM cron.job WHERE jobname = 'makesafe-status-shadow-refresh';
  PERFORM cron.unschedule('makesafe-status-canary')
    FROM cron.job WHERE jobname = 'makesafe-status-canary';
END $$;

SELECT cron.schedule(
  'makesafe-status-shadow-refresh',
  '12,42 * * * *',
  $$SELECT public.trigger_makesafe_status_shadow_refresh()$$
);
SELECT cron.schedule(
  'makesafe-status-canary',
  '17,47 * * * *',
  $$SELECT public.trigger_makesafe_status_canary()$$
);

COMMENT ON FUNCTION public.trigger_makesafe_status_canary IS
  'Alarm-only M1 canary sweep. It calls the read-only ops-api consistency check and never mutates a card, declared field, or evidence row.';
