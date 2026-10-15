-- Runs after supabase/rollbacks/20261013153000_context_rebuild_request_down.sql on the stack applied
-- through this case: the judge's body and comment are back word for word (the finished wake's,
-- 20261012093500), its access is as it was, the due list was never touched, the two functions and
-- the table are gone, and a job read by the current reader with nothing new is not due. A second
-- run of the rollback is a no-op.
DO $restored$
DECLARE sig constant text := 'public.context_ledger_judge(uuid[])'; live text; c text;
BEGIN
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(sig);
 IF live IS DISTINCT FROM '902eaf18e7fd84e05d0db5ffa6e67de1' THEN
  RAISE EXCEPTION 'rebuild request rollback: % md5 % (want the finished wake''s)', sig, coalesce(live, '<missing>');
 END IF;
 c := coalesce(obj_description(to_regprocedure(sig), 'pg_proc'), '');
 IF c NOT LIKE 'Context ledger store (20261006013000), story safety (20261006040000): (scoping pipeline, 20261009133000) (finished wake, 20261012093500) The owner''s 12 Oct 2026 ruling: a finished job%'
    OR c LIKE '%rebuild request%' THEN
  RAISE EXCEPTION 'rebuild request rollback: the judge''s comment is not the earlier one';
 END IF;
 IF has_function_privilege('anon', sig, 'EXECUTE') OR has_function_privilege('authenticated', sig, 'EXECUTE')
    OR NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
  RAISE EXCEPTION 'rebuild request rollback: the judge''s access is wrong';
 END IF;
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_ledger_due(integer)');
 IF live IS DISTINCT FROM '874180d1d58ffc8a35cbe167b9f33d6d' THEN
  RAISE EXCEPTION 'rebuild request rollback: the due list changed: %', coalesce(live, '<missing>');
 END IF;
 IF to_regclass('public.context_ledger_rebuild_requests') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
               AND p.proname IN ('context_ledger_rebuild_request_state', 'context_ledger_request_rebuild')) THEN
  RAISE EXCEPTION 'rebuild request rollback: the table or a function it added is still there';
 END IF;
END $restored$;

-- A job read by the current reader with nothing new: not due, by a judge that reads no request.
BEGIN;
SET LOCAL session_replication_role = replica;
UPDATE public.context_ledger_settings SET mode = 'live', calls_per_day = 50, reader = 'luna-ledger:v3', job_ids = NULL,
 backfill_from_hour = NULL, backfill_to_hour = NULL;
UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, ghl_contact_id, pricing_json, metadata, created_at)
VALUES ('9d000000-0000-4000-8000-000000000901', '00000000-0000-0000-0000-000000000001', 'SWF-96901', 'scheduled', 'fencing', 'Request RB', 'ct96901', '{}', '{}', now() - interval '60 days');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_step, attribution_confidence, attributed_at, match_method)
VALUES ('9d0b0000-0000-4000-8000-000000000901', '9d000000-0000-4000-8000-000000000901', 'client.reply', 'ledger_contract', 'sms', 'inbound', 'ct96901',
  '{"body":"When can you start?"}',
  '{"written_as":"service_role","party_roles":{"version":"party_roles_v2","counterpart_role":"customer","sender_role":"customer","basis":"job_customer","audience":"customer"}}',
  now() - interval '5 days', now() - interval '5 days', now() - interval '5 days', now() - interval '5 days', 'direct', 1, 1, now() - interval '5 days', 'direct_job_id');
INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, evidence_until, promoted_at, created_at, finished_at, updated_at, checks)
VALUES ('9d000000-0000-4000-8000-000000000901', 'backfill', 'live', 'luna-ledger:v3', now() - interval '2 days', now() - interval '2 days',
 now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', '{"passed":true,"store":{"pass":true}}');
DO $out$
DECLARE d record;
BEGIN
 SELECT * INTO d FROM public.context_ledger_judge(ARRAY['9d000000-0000-4000-8000-000000000901'::uuid]);
 IF d.due OR d.reason IS NOT NULL OR d.blocked_reason IS NOT NULL OR d.evidence_rows <> 1 THEN
  RAISE EXCEPTION 'rebuild request rollback: a job with nothing new is not due: %', row_to_json(d);
 END IF;
END $out$;
ROLLBACK;

-- A second run of the rollback changes nothing and does not fail.
-- (held notes, 20261015100000) replaced the judge, the item check, the story's ledger read, the packet and
-- the story since: its down goes first, inside this transaction only.
SELECT to_regprocedure('public.context_ledger_held_cite(uuid,jsonb)') IS NOT NULL AS held_notes_live \gset
\if :held_notes_live
\ir ../../../rollbacks/20261015100000_context_held_notes_down.sql
\endif
\ir ../../../rollbacks/20261013153000_context_rebuild_request_down.sql
DO $twice$
BEGIN
 IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_ledger_judge(uuid[])')) IS DISTINCT FROM '902eaf18e7fd84e05d0db5ffa6e67de1' THEN
  RAISE EXCEPTION 'rebuild request rollback: a second run changed the judge';
 END IF;
END $twice$;
