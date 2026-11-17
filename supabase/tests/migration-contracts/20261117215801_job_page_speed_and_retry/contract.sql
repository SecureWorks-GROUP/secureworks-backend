-- Historical reapply proofs restore their pinned reader body. Stand only the
-- semantically identical switch initplan back up, without repairing a broken yield.
DO $stand$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_record_messages(uuid[],timestamptz)'::regprocedure)
   ='c2b73175d602d5add3cf19bceeaae7eb' THEN
  EXECUTE replace(pg_get_functiondef('public.context_job_record_messages(uuid[],timestamptz)'::regprocedure),
   'WHEN public.context_ledger_person_placement_enabled()',
   'WHEN (SELECT public.context_ledger_person_placement_enabled())');
 END IF;
END $stand$;
BEGIN;
INSERT INTO public.jobs(id,org_id,type,status,job_number,created_at) VALUES
 ('00000000-0000-4000-8000-000000000471','00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-471','2026-09-01'),
 ('00000000-0000-4000-8000-000000000472','00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-472','2026-09-01');
-- Seed the reader input directly; the unrelated attribution trigger must not
-- relocate this synthetic message before the reader parity assertion.
SET LOCAL session_replication_role=replica;
INSERT INTO public.business_events(id,job_id,event_type,channel,direction,source,provider_message_id,
 occurred_at,recorded_at,payload,metadata,attribution_status) VALUES
 ('00000000-0000-4000-8000-000000000473','00000000-0000-4000-8000-000000000471','client.call_logged','call','inbound','ZZTEST','ghl:ZZTEST-page-471',
 '2026-10-01','2026-10-01','{"body":"ZZTEST message"}','{"written_as":"service_role"}','direct');
SET LOCAL session_replication_role=origin;
-- Compare every field and the real card, at one instant, for missing/off/on.
CREATE TEMP TABLE page_message_expected(mode text PRIMARY KEY,rows jsonb,card jsonb) ON COMMIT DROP;
DO $c$
DECLARE optimized text; v_mode text; baseline text;
BEGIN
 SELECT pg_get_functiondef('public.context_job_record_messages(uuid[],timestamptz)'::regprocedure) INTO optimized;
 baseline:=replace(optimized,'WHEN (SELECT public.context_ledger_person_placement_enabled())',
                              'WHEN public.context_ledger_person_placement_enabled()');
 IF baseline=optimized THEN RAISE EXCEPTION 'page speed: switch is still read per message'; END IF;
 EXECUTE baseline;
 FOREACH v_mode IN ARRAY ARRAY['missing','off','on'] LOOP
  DELETE FROM public.feature_flags WHERE flag_name='context_ledger_person_placement_v1';
  IF v_mode<>'missing' THEN
   INSERT INTO public.feature_flags(flag_name,enabled) VALUES('context_ledger_person_placement_v1',v_mode='on');
  END IF;
  INSERT INTO page_message_expected VALUES(v_mode,
   (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.source_id),'[]')
    FROM public.context_job_record_messages(ARRAY['00000000-0000-4000-8000-000000000471'::uuid],now()) m),
   public.context_job_story('00000000-0000-4000-8000-000000000471'));
 END LOOP;
 IF EXISTS(SELECT 1 FROM page_message_expected WHERE jsonb_array_length(rows)=0) THEN
  RAISE EXCEPTION 'page speed: parity fixture produced no message rows';
 END IF;
 EXECUTE optimized;
 FOREACH v_mode IN ARRAY ARRAY['missing','off','on'] LOOP
  DELETE FROM public.feature_flags WHERE flag_name='context_ledger_person_placement_v1';
  IF v_mode<>'missing' THEN
   INSERT INTO public.feature_flags(flag_name,enabled) VALUES('context_ledger_person_placement_v1',v_mode='on');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM page_message_expected e WHERE e.mode=v_mode
    AND e.rows=(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.source_id),'[]')
     FROM public.context_job_record_messages(ARRAY['00000000-0000-4000-8000-000000000471'::uuid],now()) m)
    AND e.card=public.context_job_story('00000000-0000-4000-8000-000000000471')) THEN
   RAISE EXCEPTION 'page speed: message/card output changed for %',v_mode;
  END IF;
 END LOOP;
END $c$;
ROLLBACK;
\ir index-contract.sql
\ir fairness-contract.sql

-- The historical identity rollback still accepts this equivalent successor.
BEGIN;
\ir ../../../rollbacks/20261030170545_context_staff_placement_identity_down.sql
DO $c$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_record_messages(uuid[],timestamptz)'::regprocedure)
   IS DISTINCT FROM 'f170d0c3f9d2703b57b52df7f7238e96' THEN
  RAISE EXCEPTION 'page speed: historical identity rollback did not restore its predecessor';
 END IF;
END $c$;
ROLLBACK;

-- This runs the real close-before-build, off parity, ambiguity, office closure
-- and isolated-read-fault assertions against THIS refresh body, without reapply.
\set page_speed_record_close_test true
\ir ../20261117195203_job_page_refresh_record_close/contract.sql
\unset page_speed_record_close_test

DO $c$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_page_refresh(uuid)'::regprocedure)
   IS DISTINCT FROM '7c10bf73a85170c37f9a88051cb5ce47' THEN
  RAISE EXCEPTION 'page speed: record-close predecessor changed beyond yield calls';
 END IF;
END $c$;
