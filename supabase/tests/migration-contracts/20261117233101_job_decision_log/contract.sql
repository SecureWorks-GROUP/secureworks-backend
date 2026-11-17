-- Re-establish the asserted object after earlier contracts' rollback probes.
\ir ../../../migrations/20261117233101_job_decision_log.sql
BEGIN;
\set decision_log_fixtures true
\ir setup.sql
\unset decision_log_fixtures
DO $check$
BEGIN
 IF (SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns
     WHERE table_schema='public' AND table_name='job_decision_log') IS DISTINCT FROM
   ARRAY['job_id','at','subject_kind','subject_id','decision','by','evidence','source_table'] THEN
   RAISE EXCEPTION 'job decision log: wrong columns';
 END IF;
 IF NOT (SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class WHERE oid='public.job_decision_log'::regclass)
   OR has_table_privilege('anon','public.job_decision_log','SELECT')
   OR has_table_privilege('authenticated','public.job_decision_log','SELECT') THEN
   RAISE EXCEPTION 'job decision log: service-only invoker view required';
 END IF;
END $check$;
-- Read as the actual permitted role, including the source-table grants.
SET LOCAL ROLE service_role;
DO $check$
DECLARE j uuid := '00000000-0000-4000-8000-000000000401';
BEGIN
 IF (SELECT count(*) FROM public.job_decision_log WHERE job_id=j) <> 4
   OR EXISTS (SELECT 1 FROM public.job_decision_log WHERE job_id=j AND by !~ '^(person|rule|model):') THEN
   RAISE EXCEPTION 'job decision log: four typed decisions required';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.job_decision_log WHERE job_id=j AND subject_kind='note'
   AND subject_id=j::text AND decision='new to open' AND by='rule:record_close_v1'
   AND at='2026-11-17 01:00Z' AND evidence='[]' AND source_table='context_ledger_transitions')
 OR NOT EXISTS (SELECT 1 FROM public.job_decision_log WHERE job_id=j AND subject_kind='message'
   AND subject_id=j::text AND decision='placed' AND by='model:place-message' AND at='2026-11-17 02:00Z'
   AND evidence=jsonb_build_array(jsonb_build_object('table','jobs','ids',jsonb_build_array(j))) AND source_table='business_events')
 OR NOT EXISTS (SELECT 1 FROM public.job_decision_log WHERE job_id=j AND subject_kind='money_action'
   AND subject_id=j::text AND decision='xero_approve: carried_out' AND by='person:00000000-0000-4000-8000-000000004019'
   AND at='2026-11-17 04:00Z' AND evidence=jsonb_build_array(jsonb_build_object('table','agent_action_proposals','id',j,'params_sha256',repeat('a',64)))
   AND source_table='agent_action_proposals')
 OR NOT EXISTS (SELECT 1 FROM public.job_decision_log WHERE job_id=j AND subject_kind='weekly_read'
   AND subject_id='2026-11-16' AND decision='2 wrong of 5' AND by='person:00000000-0000-4000-8000-000000004019'
   AND at='2026-11-17 05:00Z' AND evidence='[{"target":"story","ref":"headline:1"}]' AND source_table='job_truth_weekly_samples') THEN
   RAISE EXCEPTION 'job decision log: source decision or evidence differs';
 END IF;
END $check$;
RESET ROLE;
-- Rested messages have no job even if a stale custody id remains on the row.
UPDATE public.business_events SET attribution_status='unplaced', attributed_at=NULL,
 metadata='{"luna_outcome":"undecided"}' WHERE id='00000000-0000-4000-8000-000000000401';
SET LOCAL ROLE service_role;
DO $check$
BEGIN
 IF (SELECT count(*) FROM public.job_decision_log WHERE job_id='00000000-0000-4000-8000-000000000401') <> 3
   OR NOT EXISTS (SELECT 1 FROM public.job_decision_log WHERE subject_kind='message'
     AND subject_id='00000000-0000-4000-8000-000000000401' AND job_id IS NULL
     AND decision='rested: undecided' AND at='2026-11-17 03:00Z') THEN
   RAISE EXCEPTION 'job decision log: rested message must have no job';
 END IF;
END $check$;
RESET ROLE;
UPDATE public.agent_action_proposals SET status='observed' WHERE id='00000000-0000-4000-8000-000000000401';
UPDATE public.job_truth_weekly_samples SET read_at=NULL WHERE job_id='00000000-0000-4000-8000-000000000401';
UPDATE public.business_events SET metadata='{}' WHERE id='00000000-0000-4000-8000-000000000401';
DO $check$ BEGIN
 IF (SELECT count(*) FROM public.job_decision_log WHERE job_id='00000000-0000-4000-8000-000000000401') <> 1
   OR EXISTS (SELECT 1 FROM public.job_decision_log WHERE subject_kind='message' AND subject_id='00000000-0000-4000-8000-000000000401') THEN
   RAISE EXCEPTION 'job decision log: undecided sources must be excluded';
 END IF;
END $check$;
ROLLBACK;
\echo PASS: P4-01.9 four decision sources, rested message, exclusions and service-only read
