-- Runs after supabase/rollbacks/20261012164500_context_rebuild_order_down.sql on the stack applied
-- through this case: the due list's body and comment are back word for word (the finished wake's,
-- 20261012093500), its access is as it was, and the reader-change rebuilds are listed newest
-- evidence first again, whatever their customers wrote.
DO $restored$
DECLARE sig constant text := 'public.context_ledger_due(integer)'; live text; c text;
BEGIN
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(sig);
 IF live IS DISTINCT FROM '15083363afc35bf335c81a78f2d5d13d' THEN
  RAISE EXCEPTION 'rebuild order rollback: % md5 % (want the finished wake''s)', sig, coalesce(live, '<missing>');
 END IF;
 c := coalesce(obj_description(to_regprocedure(sig), 'pg_proc'), '');
 IF c NOT LIKE 'Context ledger store (20261006013000): (scoping pipeline, 20261009133000) (finished wake, 20261012093500) The finished jobs the lead rule calls awake%'
    OR c LIKE '%rebuild order%' THEN
  RAISE EXCEPTION 'rebuild order rollback: the comment is not the earlier one';
 END IF;
 IF has_function_privilege('anon', sig, 'EXECUTE') OR has_function_privilege('authenticated', sig, 'EXECUTE')
    OR NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
  RAISE EXCEPTION 'rebuild order rollback: access wrong';
 END IF;
END $restored$;

-- Two reader-change rebuilds: one whose customer texted 2 days ago, one with only our own text a day
-- ago. The earlier order is newest evidence first: the quiet job leads again.
BEGIN;
SET LOCAL session_replication_role = replica;
UPDATE public.context_ledger_settings SET mode = 'live', calls_per_day = 50, reader = 'luna-ledger:v3', job_ids = NULL,
 backfill_from_hour = NULL, backfill_to_hour = NULL;
UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, ghl_contact_id, pricing_json, metadata, created_at)
VALUES ('9c000000-0000-4000-8000-000000000501', '00000000-0000-0000-0000-000000000001', 'SWF-97501', 'scheduled', 'fencing', 'Order RB', 'ct97501', '{}', '{}', now() - interval '60 days'),
       ('9c000000-0000-4000-8000-000000000502', '00000000-0000-0000-0000-000000000001', 'SWF-97502', 'scheduled', 'fencing', 'Order RB Two', 'ct97502', '{}', '{}', now() - interval '60 days');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_step, attribution_confidence, attributed_at, match_method)
VALUES
 ('9c0b0000-0000-4000-8000-000000000501', '9c000000-0000-4000-8000-000000000501', 'client.reply', 'ledger_contract', 'sms', 'inbound', 'ct97501',
  '{"body":"The fence is leaning, can someone come out?"}',
  '{"written_as":"service_role","party_roles":{"version":"party_roles_v2","counterpart_role":"customer","sender_role":"customer","basis":"job_customer","audience":"customer"}}',
  now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', 'direct', 1, 1, now() - interval '2 days', 'direct_job_id'),
 ('9c0b0000-0000-4000-8000-000000000502', '9c000000-0000-4000-8000-000000000502', 'client.sms_out', 'ledger_contract', 'sms', 'outbound', 'ct97502',
  '{"body":"Your install is booked"}',
  '{"written_as":"service_role","party_roles":{"version":"party_roles_v2","counterpart_role":"customer","sender_role":"staff","basis":"job_customer","audience":"customer"}}',
  now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', 'direct', 1, 1, now() - interval '1 day', 'direct_job_id');
INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, evidence_until, promoted_at, created_at, finished_at, updated_at, checks)
SELECT j.id, 'backfill', 'live', 'luna-ledger:v2', now() - interval '12 hours', now() - interval '12 hours', now() - interval '12 hours',
 now() - interval '12 hours', now() - interval '12 hours', '{"passed":true,"store":{"pass":true}}'
FROM public.jobs j WHERE j.job_number IN ('SWF-97501', 'SWF-97502');
DO $out$
DECLARE got text;
BEGIN
 SELECT string_agg(concat_ws(' ', jb.job_number, x.reason), ', ' ORDER BY x.ord) INTO got
 FROM public.context_ledger_due(200) WITH ORDINALITY x(job_id, kind, reason, priority, newest_evidence_at, ord)
 JOIN public.jobs jb ON jb.id = x.job_id WHERE jb.job_number LIKE 'SWF-975%';
 IF got IS DISTINCT FROM 'SWF-97502 reader_changed, SWF-97501 reader_changed' THEN
  RAISE EXCEPTION 'rebuild order rollback: the reader-change rebuilds are newest evidence first again: %', got;
 END IF;
END $out$;
ROLLBACK;
