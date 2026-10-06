-- After the down migration: the thirteen bodies are the ones before 20261006040000, word
-- for word (972 and 975 md5s as production has them, 20261006033000's as its migration
-- leaves them), with their comments, flags (SECURITY DEFINER or not, STABLE, the
-- search_path setting) and grants; the seven helpers are gone (the first-apply time with
-- them), and (sixth review) so are the trigger that keeps CRM message times on the
-- conversation cache and its function, while the table of kept CRM times stays, rows and all
-- (they are kept nowhere else), its access unchanged (RLS on, service role reads) and its
-- comment saying the rollback kept it. A second run of the down changes nothing: everything
-- is checked again after it, a kept time among it. Applying the migration again after the
-- down takes the kept table and reads its times first.
CREATE TEMP TABLE story_safety_before (sig text, md5 text, cmt text, definer boolean);
INSERT INTO story_safety_before VALUES
 ('public.context_job_record_legacy_mail(uuid[],timestamptz)', 'e2d1d12725fe4e544971f50f9fe16105', 'Job record (20261006011000): legacy inbox_events mail%', false),
 ('public.context_job_record_messages(uuid[],timestamptz)', '805d8ae8acb9add8f6e3c4cc08813287', 'Job record (20261006011000): message-shaped business_events%', false),
 ('public.context_job_record_timeline(uuid[],timestamptz)', 'f827ec9418fc843470e793c09a55612e', 'Job record (20261006011000), story fixes (20261006033000): app events%', true),
 ('public.context_job_record_loops(uuid[],timestamptz)', '47a6a646655f7110ff52be8e90846599', 'Job record (20261006011000), story fixes (20261006033000): C6 names%', true),
 ('public.context_job_record_money(uuid[],timestamptz)', '33c032c9f111f74fbd7ad0e267bed33e', 'Job record (20261006011000): money per paying party%', true),
 ('public.context_job_record_contact(uuid[],timestamptz)', '698b3753ab5e1ffa6441a7ef6cbb13e5', 'Job record (20261006011000): per job the last customer message%', true),
 ('public.context_job_story_facts(uuid,timestamptz)', '98cc171009db7051a681ae3a28785518', 'Job story (20261006014000): structured record facts%', true),
 ('public.context_job_story_meta(uuid,timestamptz)', 'e7bdb045dc47859e1c03096724737c0d', 'Job story (20261006014000): evidence lanes on the job%', true),
 ('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)', 'aab2d2eb593890b297f6d13a486f6aa0',
  'Job story (20261006014000), story fixes (20261006033000): every text sort%', false),
 ('public.context_client_story(uuid,timestamptz)', 'cc4a2ce461deeb17653cd94b714bbf78', 'Job story (20261006014000), story fixes (20261006033000): parties, paying parties%', true),
 ('public.context_ledger_evidence_rows(uuid[],timestamptz)', '617cc62989572be3e0537e65bf21284c', 'Context ledger store (20261006013000): the admissible worded evidence%', true),
 ('public.context_ledger_cite(uuid,jsonb)', '25a55a28508d0b1df609e6fe4fb00661', 'Context ledger store (20261006013000): checks one {table, id, excerpt}%', true),
 ('public.context_ledger_judge(uuid[])', '1cabd1e254cdb11b26c61a992b8d9744', 'Context ledger store (20261006013000): the one ledger due judgement per job%', true);
CREATE TEMP TABLE story_safety_helpers (sig text);
INSERT INTO story_safety_helpers VALUES ('public.context_job_record_crm_time(text,text,text,uuid)'), ('public.context_job_record_payer_role(uuid,text,text,text,uuid)'),
 ('public.context_job_record_bill_share(text,jsonb,text)'), ('public.context_job_record_value(uuid[],timestamptz)'), ('public.context_job_story_day(date,date)'),
 ('public.context_ledger_mail_rule_since()'), ('public.context_ledger_mail_copies(uuid[])'), ('public.context_crm_message_times_keep()');
CREATE FUNCTION pg_temp.story_safety_check(p_when text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE x record; p record; t record;
BEGIN
 FOR x IN SELECT * FROM story_safety_before LOOP
  SELECT md5(pr.prosrc) AS m, pr.prosecdef, pr.provolatile, pr.proconfig, obj_description(pr.oid, 'pg_proc') AS c INTO p
  FROM pg_proc pr WHERE pr.oid = to_regprocedure(x.sig);
  IF p.m IS DISTINCT FROM x.md5 THEN
   RAISE EXCEPTION 'story safety rollback contract (%): % md5 % (want %)', p_when, x.sig, coalesce(p.m, '<missing>'), x.md5;
  END IF;
  IF p.c NOT LIKE x.cmt OR p.c LIKE '%story safety%' THEN
   RAISE EXCEPTION 'story safety rollback contract (%): % comment is not the one before story safety', p_when, x.sig;
  END IF;
  IF p.prosecdef IS DISTINCT FROM x.definer OR p.provolatile IS DISTINCT FROM 's'
     OR (x.definer AND p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']) OR (NOT x.definer AND p.proconfig IS NOT NULL) THEN
   RAISE EXCEPTION 'story safety rollback contract (%): % flags changed', p_when, x.sig;
  END IF;
  IF has_function_privilege('anon', x.sig, 'EXECUTE') OR has_function_privilege('authenticated', x.sig, 'EXECUTE')
     OR NOT has_function_privilege('service_role', x.sig, 'EXECUTE') THEN
   RAISE EXCEPTION 'story safety rollback contract (%): % access changed', p_when, x.sig;
  END IF;
 END LOOP;
 IF EXISTS (SELECT 1 FROM story_safety_helpers h WHERE to_regprocedure(h.sig) IS NOT NULL) THEN
  RAISE EXCEPTION 'story safety rollback contract (%): a helper survived the rollback', p_when;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = 'public.ghl_conversation_cache'::regclass AND tg.tgname = 'context_crm_message_times_keep') THEN
  RAISE EXCEPTION 'story safety rollback contract (%): the trigger keeping CRM message times survived the rollback', p_when;
 END IF;
 IF to_regclass('public.context_crm_message_times') IS NULL THEN
  RAISE EXCEPTION 'story safety rollback contract (%): the table of kept CRM times must stay (its times are kept nowhere else)', p_when;
 END IF;
 SELECT c.relrowsecurity AS rls, obj_description(c.oid, 'pg_class') AS cmt INTO t FROM pg_class c WHERE c.oid = 'public.context_crm_message_times'::regclass;
 IF NOT t.rls OR coalesce(t.cmt, '') NOT LIKE 'Story safety (20261006040000), sixth review, kept by its rollback:%'
    OR has_table_privilege('anon', 'public.context_crm_message_times', 'SELECT') OR has_table_privilege('authenticated', 'public.context_crm_message_times', 'SELECT')
    OR has_table_privilege('anon', 'public.context_crm_message_times', 'INSERT') OR has_table_privilege('authenticated', 'public.context_crm_message_times', 'INSERT')
    OR NOT has_table_privilege('service_role', 'public.context_crm_message_times', 'SELECT') THEN
  RAISE EXCEPTION 'story safety rollback contract (%): the kept CRM times table must keep its access and say the rollback kept it: %', p_when, row_to_json(t);
 END IF;
END $$;
SELECT pg_temp.story_safety_check('after the down');
-- a CRM time the table kept stays through a second run of the down
INSERT INTO public.context_crm_message_times (ghl_message_id, contact_id, crm_at) VALUES ('rb40-kept', 'ct40rb', '2026-04-04 04:04Z');
\ir ../../../rollbacks/20261006040000_context_story_safety_down.sql
SELECT pg_temp.story_safety_check('after a second run of the down');
DO $kept$
BEGIN
 IF (SELECT k.crm_at FROM public.context_crm_message_times k WHERE k.ghl_message_id = 'rb40-kept') IS DISTINCT FROM '2026-04-04 04:04Z'::timestamptz THEN
  RAISE EXCEPTION 'story safety rollback contract: the down keeps every kept CRM time';
 END IF;
END $kept$;
-- Applying the migration again after the down: its guard takes the kept table, the time of a
-- text no cache row holds any more is the kept one, and the table says what it is again.
BEGIN;
\ir ../../../migrations/20261006040000_context_story_safety.sql
DO $again$
BEGIN
 IF public.context_job_record_crm_time('ghl_sms_cache_backfill', 'ct40rb', 'rb40-kept', NULL) IS DISTINCT FROM '2026-04-04 04:04Z'::timestamptz THEN
  RAISE EXCEPTION 'story safety rollback contract: applying the migration again after the down reads the kept CRM times first';
 END IF;
 IF coalesce(obj_description('public.context_crm_message_times'::regclass, 'pg_class'), '') NOT LIKE 'Story safety (20261006040000), sixth review: the CRM%'
    OR NOT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = 'public.ghl_conversation_cache'::regclass AND tg.tgname = 'context_crm_message_times_keep') THEN
  RAISE EXCEPTION 'story safety rollback contract: applying the migration again after the down puts back the trigger and the table''s own comment';
 END IF;
END $again$;
ROLLBACK;
