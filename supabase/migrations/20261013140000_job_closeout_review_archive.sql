-- Paid close-out for fencing and patio jobs (captain, 13 Oct 2026).
--
-- When a fencing or patio job is paid its card moves to Get Review (not Complete),
-- one review text goes out, and the card is archived 24 hours later. The rule for
-- "paid" is supabase/functions/_shared/job_paid_closeout.ts; the reads, moves, sender
-- and sweeps are supabase/functions/ops-api/job_closeout.ts. This migration ships
-- only the switches and the records, every switch OFF:
--
--   1. job_closeout_settings: one row, id = 1.
--        get_review_move_enabled  false: while off, the Xero sync keeps today's rule
--                                 (all linked invoices paid and the card at Invoiced
--                                 -> Complete) for every job type, fencing and patio
--                                 included. On: a paid fencing or patio job moves to
--                                 get_review, and the catch-up runs.
--        review_sender_mode       'off': nothing is texted or logged.
--                                 'dry_run': each job that would be texted gets one
--                                 job_events row review_request_dry_run, nothing sent.
--                                 'live': texts go out, but only while the ops-api env
--                                 JOB_REVIEW_SENDING_ENABLED is exactly "true";
--                                 otherwise 'live' still reads as dry run.
--   2. job_closeout_state: per job, the last paid check and the "paid less than quoted"
--      marker the Ops card can show.
--   3. job_review_claims: the per-job review claim, written BEFORE any text is sent.
--      One row per job, ever: a job is never texted twice by this system.
--   4. A new automation lane, closeout (automation_switches.closeout, default false),
--      admitted by automation_lane_enabled(), and the pg_cron job job-closeout-sweep
--      scheduled already gated on it and listed in automation_switch_cron_lanes().
--
-- Turn on, in this order (each one an UPDATE, never a DELETE):
--   a. UPDATE public.job_closeout_settings SET get_review_move_enabled = true, ...
--   b. UPDATE public.job_closeout_settings SET review_sender_mode = 'dry_run', ...
--      and read the review_request_dry_run job_events rows.
--   c. Switch the old GoHighLevel review workflow OFF in GHL Automation (by hand).
--   d. Set JOB_REVIEW_SENDING_ENABLED=true on ops-api, then review_sender_mode = 'live'.
--   e. UPDATE public.automation_switches SET closeout = true, ... WHERE id = 1.

-- ── 1. Settings ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.job_closeout_settings (
  id                      integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  get_review_move_enabled boolean NOT NULL DEFAULT false,
  review_sender_mode      text NOT NULL DEFAULT 'off'
                          CHECK (review_sender_mode IN ('off', 'dry_run', 'live')),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              text,
  note                    text
);

-- DO NOTHING so a re-apply never flips an operator's setting back.
INSERT INTO public.job_closeout_settings (id, get_review_move_enabled, review_sender_mode, updated_by, note)
VALUES (1, false, 'off', 'migration:20261013140000_job_closeout_review_archive', 'seeded off')
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.job_closeout_settings IS
  'Paid close-out (20261013140000): the switches for fencing and patio jobs. get_review_move_enabled moves a paid job to get_review instead of complete; review_sender_mode off | dry_run | live (live also needs ops-api env JOB_REVIEW_SENDING_ENABLED=true). The 24-hour archive is the closeout automation lane. Change with UPDATE, never DELETE.';

-- ── 2. The per-job paid check and marker ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.job_closeout_state (
  job_id                uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
  outcome               text NOT NULL CHECK (outcome IN ('paid', 'paid_less_than_quoted', 'not_paid')),
  paid_less_than_quoted boolean NOT NULL DEFAULT false,
  paid_total_inc        numeric,
  expected_inc          numeric,
  shortfall_inc         numeric,
  reasons               jsonb NOT NULL DEFAULT '[]'::jsonb,
  checked_at            timestamptz NOT NULL DEFAULT now(),
  checked_by            text
);

COMMENT ON TABLE public.job_closeout_state IS
  'Paid close-out (20261013140000): the last strict paid check of a fencing or patio job (outcome paid | paid_less_than_quoted | not_paid, the reasons, paid and expected totals). paid_less_than_quoted is the marker the Ops card shows when every invoice and every paying party is paid but the money falls short of the quote plus agreed (customer accepted or invoiced) variations: such a card stays where it is. Written only by ops-api job_closeout.ts.';

-- ── 3. The per-job review claim ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.job_review_claims (
  job_id      uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
  status      text NOT NULL CHECK (status IN ('claimed', 'sent', 'skipped', 'unconfirmed')),
  trigger     text NOT NULL,
  reason      text,
  recipients  jsonb NOT NULL DEFAULT '[]'::jsonb,
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

COMMENT ON TABLE public.job_review_claims IS
  'Paid close-out (20261013140000): one review claim per job, inserted before any review text is sent, so the job is never texted twice by this system. status claimed (in flight) | sent (at least one text confirmed) | skipped (deliberately not sent: every paying owner with a contact was asked in the last 90 days) | unconfirmed (a send could not be confirmed; never retried). No row is kept when nothing could go out (no linked contact, paid too long ago, every send refused by a guard), so a later attempt can send. recipients holds one entry per paying owner: label, GHL contact id, result. Written only by ops-api job_closeout.ts.';

ALTER TABLE public.job_closeout_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_closeout_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_review_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.job_closeout_settings, public.job_closeout_state, public.job_review_claims
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.job_closeout_settings, public.job_closeout_state, public.job_review_claims
  TO service_role;
DROP POLICY IF EXISTS job_closeout_settings_service_role_all ON public.job_closeout_settings;
CREATE POLICY job_closeout_settings_service_role_all ON public.job_closeout_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS job_closeout_state_service_role_all ON public.job_closeout_state;
CREATE POLICY job_closeout_state_service_role_all ON public.job_closeout_state
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS job_review_claims_service_role_all ON public.job_review_claims;
CREATE POLICY job_review_claims_service_role_all ON public.job_review_claims
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 4. The closeout automation lane ──────────────────────────────────────────
-- A new column, default false, so the lane ships off; a re-apply never touches an
-- operator's value.
ALTER TABLE public.automation_switches ADD COLUMN IF NOT EXISTS closeout boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.automation_switches.closeout IS
  'Paid close-out (20261013140000): the job-closeout-sweep pg_cron job (fencing and patio cards in get_review for 24 hours, paid, not held and with their review done, are archived). Off by default.';

-- The reader with 'closeout' added to its closed list; every other line as before.
CREATE OR REPLACE FUNCTION public.automation_lane_enabled(lane text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_all_stop boolean;
  v_lane     boolean;
BEGIN
  IF lane IS NULL THEN
    RETURN false;
  END IF;
  IF lane NOT IN ('capture', 'attribution', 'extraction', 'closeout') THEN
    RETURN false;
  END IF;
  IF to_regclass('public.automation_switches') IS NULL THEN
    RETURN false;
  END IF;

  EXECUTE format(
    'SELECT s.all_stop, s.%I FROM public.automation_switches s WHERE s.id = 1',
    lane
  ) INTO v_all_stop, v_lane;

  -- No row at all: both come back null, which is off.
  IF v_all_stop IS NULL OR v_lane IS NULL THEN
    RETURN false;
  END IF;
  IF v_all_stop THEN
    RETURN false;
  END IF;
  RETURN v_lane;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;

COMMENT ON FUNCTION public.automation_lane_enabled(text) IS
  'True only when public.automation_switches row 1 exists, all_stop is false and the named lane column is true. False for an unknown lane, a missing row, a missing table and any error. Spec section 6. Lanes: capture, attribution, extraction, closeout (20261013140000).';

-- The lane list: the live body (the email deep history slice's, 20261007080000,
-- md5 6498276b1eb16b527fb76dd2b0fa6d83) plus this migration's row, every row kept.
-- A list that already names job-closeout-sweep (a re-apply, or a later slice built on
-- this one) is left alone; any other list stops the migration rather than drop a row.
DO $lanes$
DECLARE live text;
BEGIN
 IF EXISTS(SELECT 1 FROM public.automation_switch_cron_lanes() l WHERE l.cron_jobname='job-closeout-sweep' AND l.lane='closeout') THEN
  RAISE NOTICE 'job closeout: automation_switch_cron_lanes() already names job-closeout-sweep; left alone';
  RETURN;
 END IF;
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid='public.automation_switch_cron_lanes()'::regprocedure;
 IF live IS DISTINCT FROM '6498276b1eb16b527fb76dd2b0fa6d83' THEN
  RAISE EXCEPTION 'job_closeout_lanes_refused: automation_switch_cron_lanes() md5 % is not the body this migration builds on; rebuild this migration on it', live;
 END IF;
 EXECUTE $def$
CREATE OR REPLACE FUNCTION public.automation_switch_cron_lanes()
RETURNS TABLE (cron_jobname text, lane text)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT * FROM (VALUES
    -- capture: pollers that write evidence rows into business_events
    ('monitor-inbox-poll', 'capture'),
    ('ghl-message-reconcile', 'capture'),
    ('ghl-call-transcript-fetch', 'capture'),
    ('outlook-mail-poll', 'capture'),
    ('monitor-inbox-sweep', 'capture'),
    ('ghl-history-schedule', 'capture'),
    ('context-document-text', 'capture'),
    ('xero-history-daily', 'capture'),
    ('outlook-mail-deep-history', 'capture'),
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution'),
    -- closeout: archives paid fencing and patio cards 24 hours after Get Review
    ('job-closeout-sweep', 'closeout')
  ) AS t(cron_jobname, lane);
$fn$
$def$;
 IF NOT EXISTS(SELECT 1 FROM public.automation_switch_cron_lanes() l WHERE l.cron_jobname='job-closeout-sweep' AND l.lane='closeout') THEN
  RAISE EXCEPTION 'job_closeout_lanes_failed: automation_switch_cron_lanes() does not name job-closeout-sweep';
 END IF;
END $lanes$;

-- ── 5. The sweep caller and its pg_cron job ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.trigger_job_closeout_sweep()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=job_closeout_sweep',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || public.sw_service_key(),
      'Content-Type', 'application/json',
      'x-sw-actor', 'job-closeout-cron'
    ),
    body := jsonb_build_object('actor', 'job-closeout-cron', 'dry_run', false),
    timeout_milliseconds := 30000
  );
END $$;
COMMENT ON FUNCTION public.trigger_job_closeout_sweep() IS
  'Paid close-out (20261013140000): pg_cron job-closeout-sweep (every 30 minutes, closeout lane) posts ops-api job_closeout_sweep with the service key. ops-api re-checks the lane, the paid rule and the holds before archiving anything.';
REVOKE ALL ON FUNCTION public.trigger_job_closeout_sweep() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_job_closeout_sweep() TO service_role, postgres;

-- Scheduled already gated, so the switch's wrap reports already_wrapped and its unwrap
-- can remove the suffix. Skipped where pg_cron is absent (contract runner).
DO $cron$
BEGIN
 IF to_regclass('cron.job') IS NULL THEN
  RAISE NOTICE 'job closeout: pg_cron absent, not scheduled';
  RETURN;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='job-closeout-sweep') THEN
  PERFORM cron.schedule('job-closeout-sweep','17,47 * * * *',
   $cmd$SELECT public.trigger_job_closeout_sweep() WHERE public.automation_lane_enabled('closeout')$cmd$);
 END IF;
END $cron$;
