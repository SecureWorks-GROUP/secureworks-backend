-- SES trade-report-submitted trigger (CIO, 2026-09-11).
-- Contract: INSURANCE-to-CIO-SES-trigger-contract-2026-09-10 (wiki).
--
-- A submitted report currently waits for a human to notice it and build the
-- pack. This migration adds a durable run ledger, an AFTER INSERT trigger on
-- job_events for the three report-submitted producers, a claim function, and
-- a one-per-minute drain that posts one pending run to ops-api
-- run_ses_report_trigger. The ops-api action does the re-read, the refusals,
-- and the existing prepare_ses_docket_revision build (which already carries
-- the exact-once docs-ready admin SMS). job_events itself stays an audit trail;
-- this table is the outbox and the pending-work view.

CREATE TABLE IF NOT EXISTS public.ses_report_trigger_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE CHECK (length(btrim(dedupe_key)) > 0),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  attendance_cycle_id uuid,
  cycle_number integer,
  event_id uuid,
  event_type text NOT NULL CHECK (
    event_type IN ('roof_report_submitted', 'makesafe_report_submitted', 'makesafe_portal_report_done', 'manual')
  ),
  source jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source) = 'object'),
  state text NOT NULL DEFAULT 'pending' CHECK (
    state IN ('pending', 'claimed', 'done', 'refused_stale', 'refused_conflict', 'refused_gate', 'failed', 'unknown')
  ),
  attempts integer NOT NULL DEFAULT 0,
  duplicate_events integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  claimed_by text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  last_error text,
  recovery_action text,
  docket_revision_id uuid,
  output_content_hash text,
  docs_ready_sms jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ses_report_trigger_runs_pending
  ON public.ses_report_trigger_runs (state, next_attempt_at, created_at)
  WHERE state IN ('pending', 'claimed', 'failed', 'unknown');

CREATE INDEX IF NOT EXISTS idx_ses_report_trigger_runs_job
  ON public.ses_report_trigger_runs (job_id, created_at DESC);

COMMENT ON TABLE public.ses_report_trigger_runs IS
  'Outbox and pending-work view for the SES report-submitted trigger. One row per (job, attendance cycle, source identity). job_events remains audit only.';

-- Producer trigger: file one run per submitted report identity. The dedupe key
-- is job + attendance cycle + source identity (document id and render hash for
-- an own-template roof, the report id for a make-safe report, the event id for
-- a portal verification). A second event with the same identity increments
-- duplicate_events and changes nothing else. Cycle resolution for producers
-- that do not carry it is left to the ops-api action, which re-reads the
-- current cycle before any effect anyway.
CREATE OR REPLACE FUNCTION public.enqueue_ses_report_trigger_run()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cycle_id uuid;
  v_cycle_number integer;
  v_identity text;
  v_key text;
  v_source jsonb;
BEGIN
  IF NEW.event_type NOT IN ('roof_report_submitted', 'makesafe_report_submitted', 'makesafe_portal_report_done') THEN
    RETURN NEW;
  END IF;
  IF NEW.job_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_cycle_id := NULLIF(NEW.detail_json->>'attendance_cycle_id', '')::uuid;
  v_cycle_number := NULLIF(NEW.detail_json->>'cycle_number', '')::integer;

  IF NEW.event_type = 'roof_report_submitted' THEN
    v_identity := 'roof:' || coalesce(NEW.detail_json->>'report_doc_id', '') || ':' || coalesce(NEW.detail_json->>'render_hash', '');
    v_source := jsonb_build_object(
      'kind', 'own_roof_report',
      'report_doc_id', NEW.detail_json->>'report_doc_id',
      'render_hash', NEW.detail_json->>'render_hash',
      'draft_id', NEW.detail_json->>'draft_id',
      'report_type_job', NEW.detail_json->'report_type_job'
    );
  ELSIF NEW.event_type = 'makesafe_report_submitted' THEN
    v_identity := 'report:' || coalesce(NEW.detail_json->>'report_id', NEW.id::text);
    v_source := jsonb_build_object(
      'kind', 'makesafe_report',
      'report_id', coalesce(NEW.detail_json->>'report_id', NEW.id::text)
    );
  ELSE
    v_identity := 'portal:' || NEW.id::text;
    v_source := jsonb_build_object('kind', 'portal_verification', 'event_id', NEW.id);
  END IF;

  v_key := NEW.job_id::text || ':' || coalesce(v_cycle_id::text, 'cycle?') || ':' || v_identity;

  INSERT INTO public.ses_report_trigger_runs (dedupe_key, job_id, attendance_cycle_id, cycle_number, event_id, event_type, source, state)
  VALUES (v_key, NEW.job_id, v_cycle_id, v_cycle_number, NEW.id, NEW.event_type, v_source, 'pending')
  ON CONFLICT (dedupe_key) DO UPDATE
    SET duplicate_events = public.ses_report_trigger_runs.duplicate_events + 1,
        updated_at = clock_timestamp();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_ses_report_trigger_run ON public.job_events;
CREATE TRIGGER trg_enqueue_ses_report_trigger_run
AFTER INSERT ON public.job_events
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_ses_report_trigger_run();

-- Claim one run for a bounded lease. FOR UPDATE SKIP LOCKED so a webhook drain,
-- a manual retry and a cron drain never process the same row twice. A stale
-- claim (lease expired) is reclaimable. Terminal refusals and done are never
-- reclaimed here; the manual action re-files them explicitly.
CREATE OR REPLACE FUNCTION public.claim_ses_report_trigger_run(
  p_run_id uuid,
  p_owner text,
  p_lease_seconds integer DEFAULT 300
)
RETURNS SETOF public.ses_report_trigger_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.ses_report_trigger_runs;
BEGIN
  SELECT * INTO v_row
    FROM public.ses_report_trigger_runs
   WHERE id = p_run_id
     AND (
       state = 'pending'
       OR (state = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp()))
       OR (state = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at < clock_timestamp())
     )
   FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  UPDATE public.ses_report_trigger_runs
     SET state = 'claimed',
         attempts = attempts + 1,
         claimed_by = p_owner,
         claimed_at = clock_timestamp(),
         lease_expires_at = clock_timestamp() + make_interval(secs => greatest(30, least(p_lease_seconds, 1800))),
         updated_at = clock_timestamp()
   WHERE id = p_run_id
   RETURNING * INTO v_row;
  RETURN NEXT v_row;
END;
$$;

-- Next runnable row, oldest first, for the drain.
CREATE OR REPLACE FUNCTION public.next_ses_report_trigger_run()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id
    FROM public.ses_report_trigger_runs
   WHERE state = 'pending'
      OR (state = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp()))
      OR (state = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at < clock_timestamp())
   ORDER BY created_at ASC
   LIMIT 1;
$$;

-- Drain: post one runnable row to the ops-api action. Same cron gate and
-- service key door as the make-safe PDF extraction belt.
CREATE OR REPLACE FUNCTION public.trigger_ses_report_trigger_drain() RETURNS void AS $$
DECLARE
  v_run_id uuid;
BEGIN
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_ses_report_trigger_drain: cron gate disabled; skipping';
    RETURN;
  END IF;
  v_run_id := public.next_ses_report_trigger_run();
  IF v_run_id IS NULL THEN
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=run_ses_report_trigger',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || public.sw_service_key(),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('run_id', v_run_id, 'actor', 'ses-report-trigger-drain')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.claim_ses_report_trigger_run(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.next_ses_report_trigger_run() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trigger_ses_report_trigger_drain() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ses_report_trigger_run(uuid, text, integer) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.next_ses_report_trigger_run() TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.trigger_ses_report_trigger_drain() TO service_role, postgres;

-- Schedule only where pg_cron exists (production). The contract runner's plain
-- PostgreSQL has no cron schema and must still apply this file.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('ses-report-trigger-drain')
      FROM cron.job WHERE jobname = 'ses-report-trigger-drain';
    PERFORM cron.schedule(
      'ses-report-trigger-drain',
      '* * * * *',
      $cron$SELECT public.trigger_ses_report_trigger_drain()$cron$
    );
  END IF;
END $$;
