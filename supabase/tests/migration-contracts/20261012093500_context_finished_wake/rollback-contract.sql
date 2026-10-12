-- Runs after supabase/rollbacks/20261012093500_context_finished_wake_down.sql on the stack applied
-- through this case: the three bodies and their comments are back word for word (20261009133000's
-- lead rule, judge and due list), and so is the one-job form's comment; the wake function is gone,
-- and a finished job is out of the judge and the due list again, whatever its customer wrote.
DO $restored$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
   ('public.context_lead_monitored_jobs(uuid[],timestamptz)', '4787286b92096a92be13171b72a5f291',
    'Lead cutoff (20261007010000): (scoping pipeline, 20261009133000) the owner''s 9 Oct 2026 ruling: drafts are read,%'),
   ('public.context_ledger_judge(uuid[])', '7f876b0454195b26515b5efca3d9ca13',
    'Context ledger store (20261006013000), story safety (20261006040000): (scoping pipeline, 20261009133000) The lead rule is read once for unfinished jobs including drafts;%'),
   ('public.context_ledger_due(integer)', 'f6118bbea03f3cf1ad3a0956700a5bed',
    'Context ledger store (20261006013000): (scoping pipeline, 20261009133000) The drafts the lead rule monitors enter the same due list%')
 ) v(sig, md5, cmt) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.md5 THEN
   RAISE EXCEPTION 'finished wake rollback: % md5 % (want %)', x.sig, coalesce(live, '<missing>'), x.md5;
  END IF;
  IF coalesce(obj_description(to_regprocedure(x.sig), 'pg_proc'), '') NOT LIKE x.cmt
     OR coalesce(obj_description(to_regprocedure(x.sig), 'pg_proc'), '') LIKE '%finished wake%' THEN
   RAISE EXCEPTION 'finished wake rollback: % comment is not the earlier one', x.sig;
  END IF;
  IF has_function_privilege('anon', x.sig, 'EXECUTE') OR has_function_privilege('authenticated', x.sig, 'EXECUTE')
     OR NOT has_function_privilege('service_role', x.sig, 'EXECUTE') THEN
   RAISE EXCEPTION 'finished wake rollback: % access wrong', x.sig;
  END IF;
 END LOOP;
 IF to_regprocedure('public.context_finished_wake_hours()') IS NOT NULL THEN
  RAISE EXCEPTION 'finished wake rollback: the wake function must be gone';
 END IF;
 -- the one-job form's comment is 20261009133000's again
 IF coalesce(obj_description('public.context_lead_monitored(uuid,timestamptz)'::regprocedure, 'pg_proc'), '')
      NOT LIKE 'Lead cutoff (20261007010000): (scoping pipeline, 20261009133000) the one lead rule (context_lead_monitored_jobs) for one job as of p_as_of%'
    OR obj_description('public.context_lead_monitored(uuid,timestamptz)'::regprocedure, 'pg_proc') LIKE '%finished wake%' THEN
  RAISE EXCEPTION 'finished wake rollback: the one-job form''s comment is not the earlier one';
 END IF;
END $restored$;

-- An archived job its customer texted yesterday is out again: not listed with no ids, its row as the
-- earlier rule gives it (not_quoted, monitored), not live for the judge, never on the due list.
BEGIN;
SET LOCAL session_replication_role = replica;
ALTER TABLE public.business_events ALTER COLUMN context_captured_at SET DEFAULT now() - interval '90 days',
 ALTER COLUMN recorded_at SET DEFAULT now() - interval '90 days';
UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1;
UPDATE public.context_ledger_settings SET mode = 'shadow', backfill_from_hour = NULL, backfill_to_hour = NULL, job_ids = NULL WHERE id;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, ghl_contact_id, pricing_json, created_at, updated_at)
VALUES ('9b000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-0000000000aa', 'SWF-98501', 'archived', 'fencing', 'Wake RB', 'ct98501', '{}',
        now() - interval '60 days', now() - interval '1 day');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence)
VALUES ('9b0b0000-0000-4000-8000-000000000501', '9b000000-0000-4000-8000-000000000501', 'client.reply', 'ghl', 'sms', 'inbound', 'ct98501',
        '{"body":"The fence is leaning, can someone come out?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
        now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', 'direct', 1);
DO $out$
DECLARE r record;
BEGIN
 IF EXISTS (SELECT 1 FROM public.context_lead_monitored_jobs(NULL, now()) m WHERE m.job_number = 'SWF-98501') THEN
  RAISE EXCEPTION 'finished wake rollback: a finished job is listed with no ids again';
 END IF;
 SELECT * INTO r FROM public.context_lead_monitored_jobs(ARRAY['9b000000-0000-4000-8000-000000000501'::uuid], now()) m;
 IF r.state IS DISTINCT FROM 'not_quoted' OR r.monitored IS DISTINCT FROM true OR r.cutoff_at IS NOT NULL THEN
  RAISE EXCEPTION 'finished wake rollback: the earlier rule''s row for a finished job: %', row_to_json(r);
 END IF;
 SELECT * INTO r FROM public.context_ledger_judge(ARRAY['9b000000-0000-4000-8000-000000000501'::uuid]) d;
 IF r.due OR r.blocked_reason IS DISTINCT FROM 'not_live' THEN
  RAISE EXCEPTION 'finished wake rollback: a finished job is not live for the judge again: %', row_to_json(r);
 END IF;
 IF EXISTS (SELECT 1 FROM public.context_ledger_due(200) d WHERE d.job_id = '9b000000-0000-4000-8000-000000000501') THEN
  RAISE EXCEPTION 'finished wake rollback: a finished job is on the due list';
 END IF;
END $out$;
ROLLBACK;
