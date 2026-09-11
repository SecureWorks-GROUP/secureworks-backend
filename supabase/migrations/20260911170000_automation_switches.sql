-- The switch (CIO, 2026-09-11). Spec: audits/2026-09-11-context-TARGET-ARCHITECTURE
-- section 6 "The switch"; build plan packet B1, shared database contract item 1.
--
-- Today there is no single place that stops the evidence pipeline. The JARVIS
-- scheduler gate fails OPEN (a missing flag row runs the automation, and so does
-- a thrown error), DISABLE_AUTOMATIONS on Railway is read by nothing, and not one
-- pg_cron job carries a gate of any kind. This migration ships the one row and
-- the one helper the whole pipeline reads, and it fails CLOSED at every step:
--
--   * public.automation_switches — one row, id = 1, a boolean per lane
--     (capture, attribution, extraction) plus all_stop, seeded on, on, on, off.
--   * public.automation_lane_enabled(lane) — the only reader. Returns false when
--     the table is missing, when the row is missing, when all_stop is true, when
--     that lane's column is false, when the lane name is unknown, and on ANY
--     error. There is no path through it that returns true by accident.
--   * The capture and attribution pg_cron jobs get their command wrapped in
--     "... WHERE public.automation_lane_enabled('<lane>')", so the post only
--     happens while the lane is on. Name and schedule are untouched.
--
-- Deliberately NOT wrapped, and why:
--   * every make-safe job, ses-report-trigger-drain, process-payment-events and
--     process-outbound-queue — anything that can reach a client or a supplier
--     keeps its own controls and is out of scope for this packet;
--   * xero-token-refresh — credential maintenance, not evidence. Stopping it
--     while capture is off would expire the Xero connection and need a manual
--     reauthorisation, which flipping the switch back on could not undo;
--   * xero-reports-sync, xero-projects-sync, xero-tracking-pl-sync,
--     xero-bank-sync, xero-payables-sync, xero-suppliers-sync, xero-po-sync —
--     these mirror finance into dashboards and write no business_events row, so
--     they are not the capture lane. Gating them would take the CEO and ops
--     money screens down with the evidence pipeline.
--
-- Turn a lane off with an UPDATE, never a DELETE:
--   UPDATE public.automation_switches
--      SET capture = false, updated_by = '<who>', note = '<why>', updated_at = now()
--    WHERE id = 1;
-- A missing row reads as off, but a re-apply of this migration re-seeds it as on.

-- ── The row ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.automation_switches (
  id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton guard
  capture     boolean NOT NULL DEFAULT true,
  attribution boolean NOT NULL DEFAULT true,
  extraction  boolean NOT NULL DEFAULT true,
  all_stop    boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  note        text
);

-- DO NOTHING so a re-apply never flips an operator's explicit off back on.
INSERT INTO public.automation_switches (id, capture, attribution, extraction, all_stop, updated_by, note)
VALUES (true::int, true, true, true, false,
        'migration:20260911170000_automation_switches',
        'seeded by the switch migration; spec section 6')
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.automation_switches IS
  'The one switch for the job context pipeline (spec section 6). Single row id = 1, a boolean per lane (capture, attribution, extraction) and all_stop. Read only through public.automation_lane_enabled(lane), which fails closed. Disable with UPDATE public.automation_switches SET <lane> = false, updated_by = <who>, note = <why>, updated_at = now() WHERE id = 1. Never DELETE the row: a missing row reads as off, but a re-apply of 20260911170000_automation_switches re-seeds it as on.';

COMMENT ON COLUMN public.automation_switches.all_stop IS
  'Master off. When true every lane reads false regardless of its own column.';

ALTER TABLE public.automation_switches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.automation_switches FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.automation_switches TO service_role, postgres;

-- ── The only reader ──────────────────────────────────────────────────────────
-- Fails closed on every path. The lane name is checked against a closed list
-- before it reaches format(%I), so the dynamic column reference cannot be
-- steered by a caller. The exception block is the last line of defence: a
-- dropped table, a renamed column, a permission change and a plain bug all end
-- up as false rather than as an accidental "on".
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
  IF lane NOT IN ('capture', 'attribution', 'extraction') THEN
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
  'True only when public.automation_switches row 1 exists, all_stop is false and the named lane column is true. False for an unknown lane, a missing row, a missing table and any error. Spec section 6.';

-- ── Which pg_cron jobs belong to which lane ──────────────────────────────────
-- One list, read by both the wrap and the unwrap below, so the rollback can
-- never disagree with the forward pass about what was touched.
CREATE OR REPLACE FUNCTION public.automation_switch_cron_lanes()
RETURNS TABLE (cron_jobname text, lane text)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT * FROM (VALUES
    -- capture: pollers that write evidence rows into business_events
    ('monitor-inbox-poll', 'capture'),
    ('xero-invoice-sync',  'capture'),
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$;

-- ── Wrap and unwrap ──────────────────────────────────────────────────────────
-- Both are idempotent and both report one row per job saying what happened, so
-- a deploy readback does not need anyone to open cron.job. Neither touches the
-- job's name or schedule: only the command text changes, by appending or
-- removing exactly " WHERE public.automation_lane_enabled('<lane>')".
--
-- A command that is not the single plain SELECT this expects is left completely
-- alone and reported as skipped_unexpected_command. Guessing at an unfamiliar
-- command is how a cron job gets silently broken.
--
-- Dynamic SQL behind a to_regclass guard so a database without pg_cron (the
-- migration contract runner, a partial restore) reports skipped instead of
-- failing the migration.
CREATE OR REPLACE FUNCTION public.automation_switch_wrap_cron_jobs()
RETURNS TABLE (cron_jobname text, cron_jobid bigint, outcome text)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  r      record;
  j      record;
  v_cmd  text;
  v_sfx  text;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN QUERY SELECT l.cron_jobname, NULL::bigint, 'skipped_no_pg_cron'::text
                   FROM public.automation_switch_cron_lanes() l;
    RETURN;
  END IF;

  FOR r IN SELECT * FROM public.automation_switch_cron_lanes() LOOP
    v_sfx := format(' WHERE public.automation_lane_enabled(%L)', r.lane);
    FOR j IN EXECUTE
      'SELECT c.jobid::bigint AS jobid, c.command::text AS command
         FROM cron.job c WHERE c.jobname = $1 ORDER BY c.jobid'
      USING r.cron_jobname
    LOOP
      v_cmd := btrim(regexp_replace(btrim(j.command), ';\s*$', ''));

      IF v_cmd ILIKE '%automation_lane_enabled%' THEN
        cron_jobname := r.cron_jobname; cron_jobid := j.jobid;
        outcome := 'already_wrapped'; RETURN NEXT; CONTINUE;
      END IF;

      IF v_cmd !~* '^select\s' OR position(';' in v_cmd) > 0 OR v_cmd ~* '\swhere\s' THEN
        cron_jobname := r.cron_jobname; cron_jobid := j.jobid;
        outcome := 'skipped_unexpected_command'; RETURN NEXT; CONTINUE;
      END IF;

      EXECUTE 'SELECT cron.alter_job(job_id := $1, command := $2)'
        USING j.jobid, v_cmd || v_sfx;
      cron_jobname := r.cron_jobname; cron_jobid := j.jobid;
      outcome := 'wrapped'; RETURN NEXT;
    END LOOP;
  END LOOP;
  RETURN;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.automation_switch_unwrap_cron_jobs()
RETURNS TABLE (cron_jobname text, cron_jobid bigint, outcome text)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  r      record;
  j      record;
  v_cmd  text;
  v_sfx  text;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN QUERY SELECT l.cron_jobname, NULL::bigint, 'skipped_no_pg_cron'::text
                   FROM public.automation_switch_cron_lanes() l;
    RETURN;
  END IF;

  FOR r IN SELECT * FROM public.automation_switch_cron_lanes() LOOP
    v_sfx := format(' WHERE public.automation_lane_enabled(%L)', r.lane);
    FOR j IN EXECUTE
      'SELECT c.jobid::bigint AS jobid, c.command::text AS command
         FROM cron.job c WHERE c.jobname = $1 ORDER BY c.jobid'
      USING r.cron_jobname
    LOOP
      v_cmd := btrim(regexp_replace(btrim(j.command), ';\s*$', ''));

      IF right(v_cmd, length(v_sfx)) IS DISTINCT FROM v_sfx THEN
        cron_jobname := r.cron_jobname; cron_jobid := j.jobid;
        outcome := 'not_wrapped'; RETURN NEXT; CONTINUE;
      END IF;

      EXECUTE 'SELECT cron.alter_job(job_id := $1, command := $2)'
        USING j.jobid, btrim(left(v_cmd, length(v_cmd) - length(v_sfx)));
      cron_jobname := r.cron_jobname; cron_jobid := j.jobid;
      outcome := 'unwrapped'; RETURN NEXT;
    END LOOP;
  END LOOP;
  RETURN;
END;
$fn$;

-- ── Apply the wrap ───────────────────────────────────────────────────────────
DO $$
DECLARE w record;
BEGIN
  FOR w IN SELECT * FROM public.automation_switch_wrap_cron_jobs() LOOP
    RAISE NOTICE 'automation switch: % (jobid %) -> %', w.cron_jobname, w.cron_jobid, w.outcome;
  END LOOP;
END $$;

-- ── Server-owned, like every other switch in this schema ─────────────────────
REVOKE ALL ON FUNCTION public.automation_lane_enabled(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.automation_switch_cron_lanes() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.automation_switch_wrap_cron_jobs() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.automation_switch_unwrap_cron_jobs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.automation_lane_enabled(text) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.automation_switch_cron_lanes() TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.automation_switch_wrap_cron_jobs() TO postgres;
GRANT EXECUTE ON FUNCTION public.automation_switch_unwrap_cron_jobs() TO postgres;

-- ── Readback after deploy (prints no key material) ───────────────────────────
--   SELECT * FROM public.automation_switches;
--   SELECT lane, public.automation_lane_enabled(lane)
--     FROM unnest(ARRAY['capture','attribution','extraction']) AS lane;
--   SELECT jobname, schedule, command FROM cron.job
--    WHERE jobname IN ('monitor-inbox-poll','xero-invoice-sync','contact-matching');
