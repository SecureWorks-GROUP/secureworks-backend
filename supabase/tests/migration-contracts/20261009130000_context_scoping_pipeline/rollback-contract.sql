-- Runs after supabase/rollbacks/20261009130000_context_scoping_pipeline_down.sql on the stack applied
-- through this case: the five bodies and their comments are back word for word (20261007010000's lead
-- rule, judge, record loops and assembler; 20261006013000's due list), the window function is gone,
-- and a draft is out of the monitored set, the judge and the due list again.
DO $restored$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
   ('public.context_lead_monitored_jobs(uuid[],timestamptz)', '97299baad327f7c105840bd751e6f3ce', 'Lead cutoff (20261007010000): the owner''s 7 Oct 2026 ruling, the one lead rule.%'),
   ('public.context_ledger_judge(uuid[])', 'eb359d521397c8be161bfef6421a35c9',
    'Context ledger store (20261006013000), story safety (20261006040000): (lead cutoff, 20261007010000) blocked lead_not_monitored:%'),
   ('public.context_ledger_due(integer)', 'b546910aafd7eed12660049e363cd587', 'Context ledger store (20261006013000): live jobs due a ledger read now%'),
   ('public.context_job_record_loops(uuid[],timestamptz)', '9e074113878161cb0ef257ec0e10f670',
    'Job record (20261006011000), story fixes (20261006033000), story safety (20261006040000): (lead cutoff, 20261007010000) R7 on a lead%'),
   ('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)', 'b033f0a79e354567a87967d0efdf3a5c',
    'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000): (lead cutoff, 20261007010000) a lead no longer followed up%')
 ) v(sig, md5, cmt) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.md5 THEN
   RAISE EXCEPTION 'scoping pipeline rollback: % md5 % (want %)', x.sig, coalesce(live, '<missing>'), x.md5;
  END IF;
  IF coalesce(obj_description(to_regprocedure(x.sig), 'pg_proc'), '') NOT LIKE x.cmt
     OR coalesce(obj_description(to_regprocedure(x.sig), 'pg_proc'), '') LIKE '%scoping pipeline%' THEN
   RAISE EXCEPTION 'scoping pipeline rollback: % comment is not the earlier one', x.sig;
  END IF;
  IF has_function_privilege('anon', x.sig, 'EXECUTE') OR has_function_privilege('authenticated', x.sig, 'EXECUTE')
     OR NOT has_function_privilege('service_role', x.sig, 'EXECUTE') THEN
   RAISE EXCEPTION 'scoping pipeline rollback: % access wrong', x.sig;
  END IF;
 END LOOP;
 IF to_regprocedure('public.context_lead_window_hours(text)') IS NOT NULL THEN
  RAISE EXCEPTION 'scoping pipeline rollback: the window function must be gone';
 END IF;
END $restored$;

-- A draft the customer texted yesterday is out again: not listed with no ids, its row as the earlier
-- rule gives it (not_quoted, monitored), not live for the judge, never on the due list.
BEGIN;
SET LOCAL session_replication_role = replica;
ALTER TABLE public.business_events ALTER COLUMN context_captured_at SET DEFAULT now() - interval '90 days',
 ALTER COLUMN recorded_at SET DEFAULT now() - interval '90 days';
UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1;
UPDATE public.context_ledger_settings SET mode = 'shadow', backfill_from_hour = NULL, backfill_to_hour = NULL, job_ids = NULL WHERE id;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, ghl_contact_id, pricing_json, created_at, updated_at)
VALUES ('9a000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-0000000000aa', 'SWP-99501', 'draft', 'patio', 'Draft RB', 'ct99501', '{}',
        now() - interval '10 days', now() - interval '10 days');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence)
VALUES ('9a0b0000-0000-4000-8000-000000000501', '9a000000-0000-4000-8000-000000000501', 'client.reply', 'ghl', 'sms', 'inbound', 'ct99501',
        '{"body":"Is the design ready?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
        now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', 'direct', 1);
DO $out$
DECLARE r record;
BEGIN
 IF EXISTS (SELECT 1 FROM public.context_lead_monitored_jobs(NULL, now()) m WHERE m.job_number = 'SWP-99501') THEN
  RAISE EXCEPTION 'scoping pipeline rollback: a draft is listed with no ids again';
 END IF;
 SELECT * INTO r FROM public.context_lead_monitored_jobs(ARRAY['9a000000-0000-4000-8000-000000000501'::uuid], now()) m;
 IF r.state IS DISTINCT FROM 'not_quoted' OR r.monitored IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'scoping pipeline rollback: the earlier rule''s row for a draft: %', row_to_json(r);
 END IF;
 SELECT * INTO r FROM public.context_ledger_judge(ARRAY['9a000000-0000-4000-8000-000000000501'::uuid]) d;
 IF r.due OR r.blocked_reason IS DISTINCT FROM 'not_live' THEN
  RAISE EXCEPTION 'scoping pipeline rollback: a draft is not live for the judge again: %', row_to_json(r);
 END IF;
 IF EXISTS (SELECT 1 FROM public.context_ledger_due(200) d WHERE d.job_id = '9a000000-0000-4000-8000-000000000501') THEN
  RAISE EXCEPTION 'scoping pipeline rollback: a draft is on the due list';
 END IF;
END $out$;
ROLLBACK;
