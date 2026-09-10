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
  -- Minted per claim; every transition is CAS'd on it so a late worker whose
  -- lease expired cannot overwrite a newer claim that shares its actor name.
  claim_token uuid,
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

-- Server-owned ledger: no browser role may read dedupe keys or flip a done row
-- back to pending (that would be the blind replay the contract forbids).
ALTER TABLE public.ses_report_trigger_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ses_report_trigger_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.ses_report_trigger_runs TO service_role, postgres;

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
  -- Read the row through jsonb so a job_events shape without these columns
  -- (older fixtures, partial schemas) yields NULL and the trigger stands aside
  -- instead of raising inside someone else's insert.
  v_row jsonb := to_jsonb(NEW);
  v_event_type text := v_row->>'event_type';
  v_event_id uuid;
  v_job_id uuid;
  v_detail jsonb;
  v_cycle_id uuid;
  v_cycle_number integer;
  v_identity text;
  v_key text;
  v_source jsonb;
BEGIN
  IF v_event_type IS NULL
     OR v_event_type NOT IN ('roof_report_submitted', 'makesafe_report_submitted', 'makesafe_portal_report_done') THEN
    RETURN NEW;
  END IF;
  BEGIN
    v_job_id := NULLIF(v_row->>'job_id', '')::uuid;
    v_event_id := NULLIF(v_row->>'id', '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
  END;
  IF v_job_id IS NULL THEN
    RETURN NEW;
  END IF;
  v_detail := CASE WHEN jsonb_typeof(v_row->'detail_json') = 'object' THEN v_row->'detail_json' ELSE '{}'::jsonb END;

  -- Malformed cycle values must not block the audit insert; the ops-api
  -- handler re-reads the current cycle before any effect regardless.
  BEGIN
    v_cycle_id := NULLIF(v_detail->>'attendance_cycle_id', '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_cycle_id := NULL;
  END;
  BEGIN
    v_cycle_number := NULLIF(v_detail->>'cycle_number', '')::integer;
  EXCEPTION WHEN OTHERS THEN
    v_cycle_number := NULL;
  END;
  -- Producers that do not carry the cycle (own-template roof, portal
  -- verification) are pinned to the job's current cycle AT SUBMISSION TIME, so
  -- a delayed event from a closed cycle is refused as stale later rather than
  -- adopting whatever cycle is current when it is finally processed.
  IF v_cycle_id IS NULL AND to_regclass('public.makesafe_attendance_cycles') IS NOT NULL THEN
    BEGIN
      SELECT c.id, c.cycle_number INTO v_cycle_id, v_cycle_number
        FROM public.makesafe_attendance_cycles c
       WHERE c.job_id = v_job_id
       ORDER BY c.cycle_number DESC
       LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
      v_cycle_id := NULL;
    END;
  END IF;

  IF v_event_type = 'roof_report_submitted' THEN
    v_identity := 'roof:' || coalesce(v_detail->>'report_doc_id', '') || ':' || coalesce(v_detail->>'render_hash', '');
    v_source := jsonb_build_object(
      'kind', 'own_roof_report',
      'report_doc_id', v_detail->>'report_doc_id',
      'render_hash', v_detail->>'render_hash',
      'draft_id', v_detail->>'draft_id',
      'report_type_job', v_detail->'report_type_job'
    );
  ELSIF v_event_type = 'makesafe_report_submitted' THEN
    v_identity := 'report:' || coalesce(v_detail->>'report_id', v_event_id::text, 'unknown');
    v_source := jsonb_build_object(
      'kind', 'makesafe_report',
      'report_id', coalesce(v_detail->>'report_id', v_event_id::text)
    );
  ELSE
    v_identity := 'portal:' || coalesce(v_event_id::text, 'unknown');
    v_source := jsonb_build_object('kind', 'portal_verification', 'event_id', v_event_id);
  END IF;

  v_key := v_job_id::text || ':' || coalesce(v_cycle_id::text, 'cycle?') || ':' || v_identity;

  INSERT INTO public.ses_report_trigger_runs (dedupe_key, job_id, attendance_cycle_id, cycle_number, event_id, event_type, source, state)
  VALUES (v_key, v_job_id, v_cycle_id, v_cycle_number, v_event_id, v_event_type, v_source, 'pending')
  ON CONFLICT (dedupe_key) DO UPDATE
    SET duplicate_events = public.ses_report_trigger_runs.duplicate_events + 1,
        updated_at = clock_timestamp();

  RETURN NEW;
EXCEPTION WHEN foreign_key_violation THEN
  -- A job_events row for a job this database does not know (fixtures, partial
  -- restores) must never block the audit insert. Production jobs always exist.
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
  p_lease_seconds integer DEFAULT 600
)
RETURNS SETOF public.ses_report_trigger_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.ses_report_trigger_runs;
  v_max_attempts constant integer := 6;
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
  -- Attempt ceiling is enforced here, not only in the worker's error path: a
  -- worker that died after claiming leaves an expired lease, and without this
  -- the row would be reclaimed and re-run every lease period forever.
  IF v_row.attempts >= v_max_attempts THEN
    UPDATE public.ses_report_trigger_runs
       SET state = 'unknown',
           last_error = coalesce(last_error, '') || ' | attempt ceiling reached at claim',
           recovery_action = 'attempts exhausted: read back the docket by dedupe key, then mark done or refile',
           claimed_by = NULL, claim_token = NULL, lease_expires_at = NULL,
           updated_at = clock_timestamp()
     WHERE id = p_run_id;
    RETURN;
  END IF;
  UPDATE public.ses_report_trigger_runs
     SET state = 'claimed',
         attempts = attempts + 1,
         claimed_by = p_owner,
         claimed_at = clock_timestamp(),
         claim_token = gen_random_uuid(),
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
