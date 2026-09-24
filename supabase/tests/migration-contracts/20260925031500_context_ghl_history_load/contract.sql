-- M4 behaviour contract (GHL history load for live-job contacts), on recorded
-- fixtures of the rows the design names (sms.md section 10, read 23 Sep 2026;
-- INTEGRATION X15, X18, X27). Job numbers, GHL message ids and GHL contact ids
-- are as recorded; where the design gives no contact id or status the fixture
-- uses a labelled stand-in. No customer names. Message times are the recorded
-- times. Quote send dates are relative to now(), because "sent in the last 60
-- days" is relative to when the load runs.
--   R6   foM3hD1SggjmCoNexihJ, BIuigfV2iHxTTeFN8YG5, XPtcG3KZv34WWXdIOdKy
--        4 Sep staff app texts on SWF-261335, cache only today: loaded as
--        backfill, linked to SWF-261335, waking no read on their own.
--   R5   mDS89hMzWE2R3VCMqxP2  the tool-sent row already saved: a duplicate,
--        never a second row, its direct link untouched.
--   R1   pffXnIL1v2FTaKnz4DHm  two live fencing quotes: history is placed by the
--        placement-owned trigger exactly as a live row is (review, both stored);
--        the load writes no placement field of its own.
--   R14  XyDhsX5IZ9kaS2XxPEzr, oS67q2BCAyhbIl4SjihH  pre-job texts loaded after
--        both quotes exist: both at-time candidates, in both lanes.
--   R15  vylm5LHmbChCfgZLawc2  3 Jul, SWF-261209 created 14 Aug: before any
--        job (X18: stays before any job until P3), never pulled onto the job.
--   R9   1TPog9f79izPytVu8yoo  one live patio job: single_open.
--   R8   uQQ42WwGWSnz0Ccvs5Go  lead with no job: not a live job, never loaded.
--   Scope: the captain's 24 Sep ruling, bounded in SQL, on the live status
--   vocabulary read from production 24 Sep. The day bound: 100 jobs, strict,
--   reserved atomically (concurrent.sh proves two callers at once).
--   Link action: a live job with no GHL contact gets one, never an overwrite,
--   one audit row per change, reversible.

CREATE FUNCTION pg_temp.m4_row(p_id text,p_contact text,p_dir text,p_body text,p_at text,p_mode text DEFAULT 'backfill',
 p_source text DEFAULT 'ghl-history-load') RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object(
  'event_type',CASE p_dir WHEN 'inbound' THEN 'client.reply' WHEN 'internal' THEN 'ghl.internal_comment' ELSE 'client.sms_out' END,
  'source',p_source,'entity_type','contact','entity_id',p_contact,'contact_id',p_contact,
  'job_id',NULL,'match_method','none','event_at',p_at,'provider_message_id','ghl:'||p_id,
  'channel',CASE p_dir WHEN 'internal' THEN 'note' ELSE 'sms' END,'direction',p_dir,'thread_key',NULL,
  'body_preview',p_body,'safe_summary',p_body,'privacy_classification','staff_only','retention_class','7y_audit',
  'payload',jsonb_build_object('body',p_body,'text',p_body,'channel',CASE p_dir WHEN 'internal' THEN 'note' ELSE 'sms' END,
   'direction',p_dir,'ghl_message_id',p_id,'ghl_contact_id',p_contact),
  'metadata',jsonb_build_object('capture_mode',p_mode,'history_run_id','00000000-0000-4000-8000-00000000c0de'))
$$;
CREATE FUNCTION pg_temp.m4_job(p_number text,p_status text,p_type text,p_contact text,p_created timestamptz,
 p_quote_sent timestamptz DEFAULT NULL,p_archived boolean DEFAULT false,p_meta jsonb DEFAULT '{}') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at,updated_at,archived,metadata)
 VALUES(j,'00000000-0000-0000-0000-000000000001',p_status,p_type,p_number,p_contact,p_created,p_created,p_archived,p_meta);
 IF p_quote_sent IS NOT NULL THEN
  INSERT INTO public.job_documents(job_id,type,sent_at,file_name) VALUES(j,'quote',p_quote_sent,p_number||'-quote.pdf');
 END IF;
 RETURN j;
END $$;
CREATE FUNCTION pg_temp.m4_run(p_source text,p_jobs integer,p_started timestamptz DEFAULT now()) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
 r:=public.record_capture_run(jsonb_build_object('source',p_source,'counts',jsonb_build_object('jobs_covered',p_jobs)));
 UPDATE public.context_capture_runs SET started_at=p_started WHERE id=(r->>'run_id')::uuid;
 RETURN (r->>'run_id')::uuid;
END $$;

BEGIN;
-- 1. Grants and hardening: service side only, fixed search_path, the ledger
-- unreadable by the public key and a signed-in login.
DO $$
DECLARE f regprocedure;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_ghl_history_policy()','public.context_ghl_history_live_jobs()',
  'public.context_ghl_history_due(integer)','public.reserve_ghl_history_run(integer,text)','public.record_ghl_history_contact(jsonb)','public.capture_ghl_history_event(jsonb)',
  'public.context_ghl_history_link_candidates(uuid,integer)','public.link_job_ghl_contact(jsonb)','public.reverse_ghl_contact_link(uuid,text)']::regprocedure[] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('public',f,'EXECUTE')
  THEN RAISE EXCEPTION 'm4 public execute on %',f; END IF;
  IF NOT has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'm4 service_role cannot execute %',f; END IF;
  IF (SELECT proconfig FROM pg_proc WHERE oid=f) IS NULL THEN RAISE EXCEPTION 'm4 % has no fixed search_path',f; END IF;
 END LOOP;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.context_ghl_history_contacts'::regclass) THEN RAISE EXCEPTION 'm4 ledger RLS off'; END IF;
 IF has_table_privilege('anon','public.context_ghl_history_contacts','SELECT') OR has_table_privilege('authenticated','public.context_ghl_history_contacts','SELECT')
  OR has_table_privilege('anon','public.context_ghl_history_contacts','INSERT') OR has_table_privilege('authenticated','public.context_ghl_history_contacts','INSERT')
  OR has_table_privilege('service_role','public.context_ghl_history_contacts','INSERT') OR has_table_privilege('service_role','public.context_ghl_history_contacts','UPDATE')
 THEN RAISE EXCEPTION 'm4 ledger grants too wide'; END IF;
 IF NOT has_table_privilege('service_role','public.context_ghl_history_contacts','SELECT') THEN RAISE EXCEPTION 'm4 service_role cannot read the ledger'; END IF;
 IF (SELECT count(*) FROM pg_policy WHERE polrelid='public.context_ghl_history_contacts'::regclass)<>0 THEN RAISE EXCEPTION 'm4 ledger has a policy'; END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.context_ghl_contact_links'::regclass)
  OR has_table_privilege('anon','public.context_ghl_contact_links','SELECT') OR has_table_privilege('authenticated','public.context_ghl_contact_links','SELECT')
  OR has_table_privilege('service_role','public.context_ghl_contact_links','INSERT') OR has_table_privilege('service_role','public.context_ghl_contact_links','UPDATE')
  OR NOT has_table_privilege('service_role','public.context_ghl_contact_links','SELECT')
 THEN RAISE EXCEPTION 'm4 link audit grants'; END IF;
 -- The rules the captain set, in one place.
 IF public.context_ghl_history_policy()->'daily_job_limit'<>'100' OR public.context_ghl_history_policy()->'quote_sent_days'<>'60'
  OR public.context_ghl_history_policy()->'live_statuses'<>'["accepted","partially_accepted","scheduled","in_progress","processing","approvals","order_materials","schedule_install","awaiting_supplier","awaiting_deposit","final_payment","rectification"]'
  OR public.context_ghl_history_policy()->'quote_statuses'<>'["draft","quoted"]'
 THEN RAISE EXCEPTION 'm4 policy %',public.context_ghl_history_policy(); END IF;
END $$;
ROLLBACK;

BEGIN;
-- 2. Scope: live jobs only (captain ruling 24 Sep 2026), never closed jobs.
DO $$
DECLARE live uuid[]; j record; want text[]; got text[]; st text;
BEGIN
 PERFORM pg_temp.m4_job('M4-ACC-1','accepted','fencing','m4AcceptedContact01','2026-08-01Z');
 PERFORM pg_temp.m4_job('M4-PAC-1','partially_accepted','fencing','m4PartAccContact01','2026-08-01Z');
 PERFORM pg_temp.m4_job('M4-SCH-1','scheduled','fencing','m4ScheduledCont01','2026-08-01Z');
 PERFORM pg_temp.m4_job('M4-INP-1','in_progress','patio','m4InProgressCont01','2026-08-01Z');
 FOREACH st IN ARRAY ARRAY['processing','approvals','order_materials','schedule_install','awaiting_supplier','awaiting_deposit',
  'final_payment','rectification'] LOOP
  PERFORM pg_temp.m4_job('M4-ST-'||st,st,'fencing','m4St'||replace(st,'_','')||'001','2026-08-01Z');
 END LOOP;
 PERFORM pg_temp.m4_job('M4-Q59-1','quoted','fencing','m4Quote59Contact01','2026-06-01Z',now()-interval '59 days');
 PERFORM pg_temp.m4_job('M4-DRQ-1','draft','fencing','m4DraftQuoteCont01','2026-06-01Z',now()-interval '3 days');
 -- Out: a quote sent 61 days ago, a quoted job with no sent quote, a draft with
 -- none, every closed status, an unknown status, archived, a holding job, no
 -- contact, a quote document never sent.
 PERFORM pg_temp.m4_job('M4-Q61-1','quoted','fencing','m4Quote61Contact01','2026-06-01Z',now()-interval '61 days');
 PERFORM pg_temp.m4_job('M4-QNS-1','quoted','fencing','m4QuoteNoSend0001','2026-06-01Z');
 PERFORM pg_temp.m4_job('M4-DRF-1','draft','fencing','m4DraftContact001','2026-06-01Z');
 PERFORM pg_temp.m4_job('M4-CMP-1','complete','fencing','m4CompleteCont001','2026-06-01Z',now()-interval '3 days');
 PERFORM pg_temp.m4_job('M4-INV-1','invoiced','fencing','m4InvoicedCont001','2026-06-01Z',now()-interval '3 days');
 PERFORM pg_temp.m4_job('M4-CAN-1','cancelled','fencing','m4CancelledCont01','2026-06-01Z',now()-interval '3 days');
 PERFORM pg_temp.m4_job('M4-LST-1','lost','fencing','m4LostContact0001','2026-06-01Z',now()-interval '3 days');
 PERFORM pg_temp.m4_job('M4-ONH-1','on_hold','fencing','m4OnHoldContact01','2026-06-01Z',now()-interval '3 days');
 PERFORM pg_temp.m4_job('M4-REV-1','get_review','fencing','m4GetReviewCont01','2026-06-01Z',now()-interval '3 days');
 PERFORM pg_temp.m4_job('M4-ARS-1','archived','fencing','m4ArchStatusCon01','2026-06-01Z',now()-interval '3 days');
 PERFORM pg_temp.m4_job('M4-ARC-1','accepted','fencing','m4ArchivedCont001','2026-06-01Z',NULL,true);
 PERFORM pg_temp.m4_job('M4-HLD-1','accepted','fencing','m4HoldingContact1','2026-06-01Z',NULL,false,'{"do_not_schedule":true}');
 PERFORM pg_temp.m4_job('M4-NOC-1','accepted','fencing',NULL,'2026-06-01Z');
 PERFORM pg_temp.m4_job('M4-BLK-1','accepted','fencing','   ','2026-06-01Z');
 INSERT INTO public.job_documents(job_id,type,sent_at,file_name)
 SELECT id,'quote',NULL,'unsent.pdf' FROM public.jobs WHERE job_number='M4-QNS-1';
 INSERT INTO public.job_documents(job_id,type,sent_at,file_name)
 SELECT id,'invoice',now()-interval '1 day','invoice.pdf' FROM public.jobs WHERE job_number='M4-DRF-1';
 SELECT array_agg(job_number ORDER BY job_number) INTO got FROM public.context_ghl_history_live_jobs() WHERE job_number LIKE 'M4-%';
 -- Jobs with no contact are live too (the link action's list), with a null contact.
 want:=ARRAY['M4-ACC-1','M4-BLK-1','M4-DRQ-1','M4-INP-1','M4-NOC-1','M4-PAC-1','M4-Q59-1','M4-SCH-1','M4-ST-approvals','M4-ST-awaiting_deposit',
  'M4-ST-awaiting_supplier','M4-ST-final_payment','M4-ST-order_materials','M4-ST-processing','M4-ST-rectification','M4-ST-schedule_install'];
 IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'm4 scope: live jobs %, expected %',got,want; END IF;
 FOR j IN SELECT * FROM public.context_ghl_history_live_jobs() WHERE job_number LIKE 'M4-%' LOOP
  IF j.live_basis<>(CASE WHEN j.job_number IN ('M4-Q59-1','M4-DRQ-1') THEN 'quote_sent' ELSE 'status' END)
  THEN RAISE EXCEPTION 'm4 scope: % basis %',j.job_number,j.live_basis; END IF;
  IF (j.ghl_contact_id IS NULL)<>(j.job_number IN ('M4-NOC-1','M4-BLK-1')) THEN RAISE EXCEPTION 'm4 scope: % contact %',j.job_number,j.ghl_contact_id; END IF;
  IF j.tier<>(CASE WHEN j.job_number IN ('M4-INP-1','M4-ST-rectification') THEN 1 WHEN j.job_number IN ('M4-SCH-1','M4-ST-schedule_install') THEN 2
   WHEN j.live_basis='quote_sent' THEN 4 ELSE 3 END) THEN RAISE EXCEPTION 'm4 scope: % tier %',j.job_number,j.tier; END IF;
 END LOOP;
 -- The load never offers a job with no contact.
 IF public.context_ghl_history_due(100)::text ~ '"contact_id": null' THEN RAISE EXCEPTION 'm4 due offered a contactless job'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 3. The due list: one entry per GHL contact, in progress first, and never
-- more than the day's 100 jobs.
DO $$
DECLARE d jsonb; c jsonb; gauci uuid[]:='{}'; i integer; run uuid;
BEGIN
 -- R1 / R13 / R14: two live fencing quotes on one contact.
 gauci:=gauci||pg_temp.m4_job('SWF-261431','quoted','fencing','lYPee0K2DuQHXH2xHL1P','2026-09-17T02:00:00Z',now()-interval '5 days');
 gauci:=gauci||pg_temp.m4_job('SWF-261448','quoted','fencing','lYPee0K2DuQHXH2xHL1P','2026-09-21T02:00:00Z',now()-interval '3 days');
 -- R9 (stand-in status in_progress; the design records a live patio job).
 PERFORM pg_temp.m4_job('SWP-26941','in_progress','patio','Oxqi7eCx2rGCsS0BXOH2','2026-09-01T02:00:00Z');
 -- R6 (stand-in status scheduled: install text sent 18 Sep).
 PERFORM pg_temp.m4_job('SWF-261335','scheduled','fencing','1VHBzZX6DsjMZW2WbgQn','2026-08-20T02:00:00Z');
 d:=public.context_ghl_history_due(20);
 IF (d->>'daily_job_limit')::integer<>100 OR (d->>'jobs_counted_today')::integer<>0 OR (d->>'daily_remaining')::integer<>100 THEN RAISE EXCEPTION 'm4 due header %',d; END IF;
 IF jsonb_array_length(d->'contacts')<>3 OR (d->>'jobs_offered')::integer<>4 THEN RAISE EXCEPTION 'm4 due contacts %',d->'contacts'; END IF;
 -- Tier order: in progress, scheduled, then quotes.
 IF d#>>'{contacts,0,contact_id}'<>'Oxqi7eCx2rGCsS0BXOH2' OR d#>>'{contacts,1,contact_id}'<>'1VHBzZX6DsjMZW2WbgQn'
  OR d#>>'{contacts,2,contact_id}'<>'lYPee0K2DuQHXH2xHL1P' THEN RAISE EXCEPTION 'm4 due order %',d->'contacts'; END IF;
 c:=d#>'{contacts,2}';
 IF (c->>'jobs')::integer<>2 OR NOT (c->'job_ids' @> to_jsonb(gauci) AND to_jsonb(gauci) @> (c->'job_ids')) THEN RAISE EXCEPTION 'm4 due grouping %',c; END IF;
 -- A contact id that is not a GHL id is counted, never offered.
 PERFORM pg_temp.m4_job('M4-BADID','accepted','fencing','not a ghl id!','2026-08-01Z');
 d:=public.context_ghl_history_due(20);
 IF (d->>'jobs_invalid_contact_id')::integer<>1 OR d::text LIKE '%not a ghl id%' THEN RAISE EXCEPTION 'm4 bad contact id %',d; END IF;
 -- R8: a lead with no job is never offered.
 IF d::text LIKE '%cS6dKRalWMgthDS9mELw%' THEN RAISE EXCEPTION 'm4 a lead with no job was offered'; END IF;

 -- 97 jobs already covered today: only 3 remain, so the 2-job contact fits
 -- after the 1-job contacts and nothing more is offered.
 run:=pg_temp.m4_run('ghl_history_load',97);
 d:=public.context_ghl_history_due(20);
 IF (d->>'jobs_counted_today')::integer<>97 OR (d->>'daily_remaining')::integer<>3 OR (d->>'jobs_offered')::integer<>2
  OR (d->>'contacts_waiting')::integer<>1 OR (d->>'jobs_waiting')::integer<>2
 THEN RAISE EXCEPTION 'm4 day bound at 97: %',d; END IF;
 -- A dry run and yesterday's runs never count against today.
 PERFORM pg_temp.m4_run('ghl_history_load_dry',50);
 PERFORM pg_temp.m4_run('ghl_history_load',50,now()-interval '2 days');
 IF (public.context_ghl_history_due(20)->>'jobs_counted_today')::integer<>97 THEN RAISE EXCEPTION 'm4 day count took a dry or old run'; END IF;
 -- The day is full: nothing offered.
 PERFORM pg_temp.m4_run('ghl_history_load',3);
 d:=public.context_ghl_history_due(20);
 IF (d->>'daily_limit_reached')::boolean IS NOT TRUE OR jsonb_array_length(d->'contacts')<>0 OR (d->>'jobs_waiting')::integer<>4
 THEN RAISE EXCEPTION 'm4 full day still offers %',d; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 4. The per-call size stops adding contacts, but never blocks a contact the
-- day can hold; a contact bigger than a whole day is never offered.
DO $$
DECLARE d jsonb; i integer;
BEGIN
 FOR i IN 1..3 LOOP PERFORM pg_temp.m4_job('M4-BIG-'||i,'accepted','fencing','m4BigContact00001','2026-08-01Z'); END LOOP;
 PERFORM pg_temp.m4_job('M4-ONE-1','scheduled','fencing','m4OneContact00001','2026-08-01Z');
 d:=public.context_ghl_history_due(1);
 -- max 1: the scheduled contact (tier 2) is taken, then the call is full.
 IF jsonb_array_length(d->'contacts')<>1 OR d#>>'{contacts,0,contact_id}'<>'m4OneContact00001' THEN RAISE EXCEPTION 'm4 max jobs 1: %',d; END IF;
 d:=public.context_ghl_history_due(2);
 -- max 2: one taken (1 < 2), the 3-job contact still fits the day and is taken.
 IF (d->>'jobs_offered')::integer<>4 THEN RAISE EXCEPTION 'm4 max jobs 2: %',d; END IF;
 FOR i IN 4..101 LOOP PERFORM pg_temp.m4_job('M4-BIG-'||i,'accepted','fencing','m4BigContact00001','2026-08-01Z'); END LOOP;
 DELETE FROM public.jobs WHERE job_number='M4-ONE-1';
 -- 101 live jobs on one contact: never inside the day's bound, even on a fresh day.
 d:=public.context_ghl_history_due(100);
 IF jsonb_array_length(d->'contacts')<>0 OR (d->>'jobs_offered')::integer<>0 OR (d->>'contacts_over_daily_limit')::integer<>1
  OR (d->>'jobs_over_daily_limit')::integer<>101
 THEN RAISE EXCEPTION 'm4 oversized contact must never be offered: %',d; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 5. The ledger: done contacts are not offered again, partial loads resume
-- first, a failed contact is offered again on a later day, never given up on.
DO $$
DECLARE run uuid; dry uuid; d jsonb; r jsonb;
BEGIN
 PERFORM pg_temp.m4_job('M4-L-DONE','accepted','fencing','m4LedgerDone0001','2026-08-01Z');
 PERFORM pg_temp.m4_job('M4-L-PART','accepted','fencing','m4LedgerPart0001','2026-08-01Z');
 PERFORM pg_temp.m4_job('M4-L-FAIL','in_progress','fencing','m4LedgerFail0001','2026-08-01Z');
 PERFORM pg_temp.m4_job('M4-L-CALL','accepted','fencing','m4LedgerCall0001','2026-08-01Z');
 run:=pg_temp.m4_run('ghl_history_load',0);
 dry:=pg_temp.m4_run('ghl_history_load_dry',0);
 -- A dry run never writes the ledger.
 BEGIN
  PERFORM public.record_ghl_history_contact(jsonb_build_object('contact_id','m4LedgerDone0001','run_id',dry,'status','done','actor','m4-test'));
  RAISE EXCEPTION 'm4 ledger took a dry run';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'history_contact_run_invalid' THEN RAISE; END IF;
 END;
 -- Refusals name their code.
 BEGIN PERFORM public.record_ghl_history_contact(jsonb_build_object('contact_id','m4LedgerDone0001','run_id',run,'status','failed','actor','m4-test'));
  RAISE EXCEPTION 'm4 failed without a code'; EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'history_contact_error_code_required' THEN RAISE; END IF; END;
 BEGIN PERFORM public.record_ghl_history_contact(jsonb_build_object('contact_id','m4LedgerDone0001','run_id',run,'status','done','body','x'));
  RAISE EXCEPTION 'm4 unknown key taken'; EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'history_contact_invalid' THEN RAISE; END IF; END;
 BEGIN PERFORM public.record_ghl_history_contact(jsonb_build_object('contact_id','m4LedgerDone0001','run_id',run,'status','done','counts',jsonb_build_object('inserted',-1)));
  RAISE EXCEPTION 'm4 negative count taken'; EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'history_contact_counts_invalid' THEN RAISE; END IF; END;
 PERFORM public.record_ghl_history_contact(jsonb_build_object('contact_id','m4LedgerDone0001','run_id',run,'status','done','jobs',1,'actor','m4-test',
  'resume',jsonb_build_object('v',1,'done','[]'::jsonb),'earliest_message_at','2026-03-01T00:00:00Z','latest_message_at','2026-09-01T00:00:00Z'));
 PERFORM public.record_ghl_history_contact(jsonb_build_object('contact_id','m4LedgerPart0001','run_id',run,'status','partial','jobs',1,'actor','m4-test',
  'resume',jsonb_build_object('v',1,'done','[]'::jsonb,'conversation_id','m4Conversation001','last_message_id','m4Cursor00000001')));
 FOR i IN 1..3 LOOP
  r:=public.record_ghl_history_contact(jsonb_build_object('contact_id','m4LedgerFail0001','run_id',run,'status','failed','error_code','provider_request_failed','actor','m4-test'));
 END LOOP;
 IF r->>'attempts'<>'3' OR r->>'outcome'<>'updated' THEN RAISE EXCEPTION 'm4 attempts %',r; END IF;
 -- Failed today: not offered again today.
 IF public.context_ghl_history_due(20)::text LIKE '%m4LedgerFail0001%' THEN RAISE EXCEPTION 'm4 failed contact retried the same day'; END IF;
 PERFORM public.record_ghl_history_contact(jsonb_build_object('contact_id','m4LedgerCall0001','run_id',run,'status','done','jobs',1,'skipped_calls',2,'actor','m4-test'));
 -- A done row keeps no resume point and records when it was completed.
 IF (SELECT resume IS NOT NULL OR completed_at IS NULL FROM public.context_ghl_history_contacts WHERE contact_id='m4LedgerDone0001')
 THEN RAISE EXCEPTION 'm4 done row kept a resume point'; END IF;
 d:=public.context_ghl_history_due(20);
 IF jsonb_array_length(d->'contacts')<>1 OR d#>>'{contacts,0,contact_id}'<>'m4LedgerPart0001' OR d#>>'{contacts,0,prior_status}'<>'partial'
  OR d#>>'{contacts,0,resume,last_message_id}'<>'m4Cursor00000001'
 THEN RAISE EXCEPTION 'm4 ledger due %',d; END IF;
 -- Failed on an earlier day, after three attempts: offered again (in progress first).
 UPDATE public.context_ghl_history_contacts SET last_attempt_at=now()-interval '2 days' WHERE contact_id='m4LedgerFail0001';
 d:=public.context_ghl_history_due(20);
 IF jsonb_array_length(d->'contacts')<>2 OR d#>>'{contacts,1,contact_id}'<>'m4LedgerFail0001' OR d#>>'{contacts,1,prior_status}'<>'failed'
 THEN RAISE EXCEPTION 'm4 failed contact not retried on a later day %',d; END IF;
 -- Skipped calls are recorded on a done contact, which is not offered again.
 IF (SELECT skipped_calls FROM public.context_ghl_history_contacts WHERE contact_id='m4LedgerCall0001')<>2 OR d::text LIKE '%m4LedgerCall0001%'
 THEN RAISE EXCEPTION 'm4 skipped calls'; END IF;
 -- An earlier message found later widens the recorded span; never narrows it.
 PERFORM public.record_ghl_history_contact(jsonb_build_object('contact_id','m4LedgerDone0001','run_id',run,'status','done','actor','m4-test',
  'earliest_message_at','2026-05-01T00:00:00Z','latest_message_at','2026-05-02T00:00:00Z'));
 IF (SELECT earliest_message_at<>'2026-03-01T00:00:00Z' OR latest_message_at<>'2026-09-01T00:00:00Z' OR attempts<>2
  FROM public.context_ghl_history_contacts WHERE contact_id='m4LedgerDone0001') THEN RAISE EXCEPTION 'm4 span narrowed'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 6. R6 and R5 on SWF-261335: history lands on its job at its own time,
-- as backfill, and wakes no read on its own; a live row does.
DO $$
DECLARE j uuid; o jsonb; e public.business_events; c jsonb; existing uuid; n integer; wake_before integer; unread_before integer;
BEGIN
 j:=pg_temp.m4_job('SWF-261335','scheduled','fencing','1VHBzZX6DsjMZW2WbgQn','2026-08-20T02:00:00Z');
 -- R5: the tool-sent install text already saved with a direct link (C1a).
 INSERT INTO public.business_events(source,payload,contact_id,provider_message_id,channel,direction,event_at,job_id,match_method,metadata)
 VALUES('ghl-proxy','{"body":"Install text for the R5 fixture."}','1VHBzZX6DsjMZW2WbgQn','ghl:mDS89hMzWE2R3VCMqxP2','sms','outbound',
  '2026-09-18T01:10:00Z',j,'direct_job_id','{"capture_mode":"live"}') RETURNING id INTO existing;
 -- R5 is a live row: it already wakes the job. The history must add nothing to that.
 c:=(SELECT cadence FROM public.context_jobs_cadence(ARRAY[j]));
 wake_before:=(c->>'waking_count')::integer; unread_before:=(c->>'unread_count')::integer;
 FOR o IN SELECT public.capture_ghl_history_event(pg_temp.m4_row(x.id,'1VHBzZX6DsjMZW2WbgQn','outbound','Staff app text for the R6 fixture.',x.at))
  FROM (VALUES ('foM3hD1SggjmCoNexihJ','2026-09-04T01:00:00Z'),('BIuigfV2iHxTTeFN8YG5','2026-09-04T01:05:00Z'),('XPtcG3KZv34WWXdIOdKy','2026-09-04T01:10:00Z')) x(id,at)
 LOOP
  IF o->>'outcome' IS DISTINCT FROM 'inserted' OR o->>'attribution_status' IS DISTINCT FROM 'single_open' OR o->>'job_id'<>j::text OR o ? 'rested'
  THEN RAISE EXCEPTION 'R6: history must land on SWF-261335, got %',o; END IF;
 END LOOP;
 SELECT * INTO e FROM public.business_events WHERE provider_message_id='ghl:foM3hD1SggjmCoNexihJ';
 IF e.event_at<>'2026-09-04T01:00:00Z' OR e.metadata->>'capture_mode'<>'backfill' OR e.source<>'ghl-history-load'
  OR e.metadata->>'history_run_id' IS NULL OR e.occurred_at<now()-interval '1 minute'
 THEN RAISE EXCEPTION 'R6: provider time and backfill mode must be kept, got % % %',e.event_at,e.metadata,e.source; END IF;
 -- R5: the load sees the same GHL message: one row, the direct link untouched.
 o:=public.capture_ghl_history_event(pg_temp.m4_row('mDS89hMzWE2R3VCMqxP2','1VHBzZX6DsjMZW2WbgQn','outbound','Install text for the R5 fixture.','2026-09-18T01:10:00Z'));
 SELECT count(*) INTO n FROM public.business_events WHERE provider_message_id='ghl:mDS89hMzWE2R3VCMqxP2';
 SELECT * INTO e FROM public.business_events WHERE id=existing;
 IF o->>'outcome' IS DISTINCT FROM 'duplicate' OR (o->>'upgraded')::boolean OR n<>1 OR e.job_id IS DISTINCT FROM j OR e.metadata->>'capture_mode'<>'live'
 THEN RAISE EXCEPTION 'R5: a duplicate must change nothing, got % n=% %',o,n,e.metadata; END IF;
 -- Waking: the three history rows are unread but none wakes the job.
 c:=(SELECT cadence FROM public.context_jobs_cadence(ARRAY[j]));
 IF (c->>'waking_count')::integer<>wake_before OR (c->>'unread_count')::integer<>unread_before+3
 THEN RAISE EXCEPTION 'R6: backfill must be unread but never waking (before % %), got %',wake_before,unread_before,c; END IF;
 -- Control: the same kind of row captured live does wake it.
 PERFORM public.capture_business_event(pg_temp.m4_row('m4LiveControl0001','1VHBzZX6DsjMZW2WbgQn','inbound','Live control text.',
  to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'live','ghl-webhook-receiver'));
 c:=(SELECT cadence FROM public.context_jobs_cadence(ARRAY[j]));
 IF (c->>'waking_count')::integer<>wake_before+1 THEN RAISE EXCEPTION 'R6 control: a live row must wake, got %',c; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 7. R1 and R14: two live quotes. The load writes no placement field: the
-- placement-owned trigger places a history row exactly as it places a live
-- row (review, both candidates stored, in both jobs' not-yet-placed lane).
-- The live ladder does not yet keep backfill rows from the model (X27); that
-- is the placement track's follow-up, recorded here as today's behaviour.
DO $$
DECLARE j31 uuid; j48 uuid; o jsonb; e public.business_events; c public.business_events; n integer;
BEGIN
 j31:=pg_temp.m4_job('SWF-261431','quoted','fencing','lYPee0K2DuQHXH2xHL1P','2026-09-17T02:00:00Z',now()-interval '5 days');
 j48:=pg_temp.m4_job('SWF-261448','quoted','fencing','lYPee0K2DuQHXH2xHL1P','2026-09-21T02:00:00Z',now()-interval '3 days');
 o:=public.capture_ghl_history_event(pg_temp.m4_row('pffXnIL1v2FTaKnz4DHm','lYPee0K2DuQHXH2xHL1P','inbound',
  'I haven''t received all three quotes as yet?','2026-09-23T04:35:00Z'));
 SELECT * INTO e FROM public.business_events WHERE provider_message_id='ghl:pffXnIL1v2FTaKnz4DHm';
 -- Control: the same kind of message captured live, at the same time.
 PERFORM public.capture_business_event(pg_temp.m4_row('m4LiveControl0002','lYPee0K2DuQHXH2xHL1P','inbound','Live control text.',
  '2026-09-23T04:35:00Z','live','ghl-webhook-receiver'));
 SELECT * INTO c FROM public.business_events WHERE provider_message_id='ghl:m4LiveControl0002';
 IF o->>'outcome' IS DISTINCT FROM 'inserted' OR o->>'attribution_status'<>e.attribution_status OR o ? 'rested'
  OR e.metadata ? 'unplaced_reason' OR e.metadata->>'capture_mode'<>'backfill'
 THEN RAISE EXCEPTION 'R1: the load must return the writer''s outcome and add no placement of its own, got % %',o,e.metadata; END IF;
 IF (e.attribution_status,e.attribution_step,e.job_id,e.candidate_job_ids,e.metadata->>'placement_rule')
    IS DISTINCT FROM (c.attribution_status,c.attribution_step,c.job_id,c.candidate_job_ids,c.metadata->>'placement_rule')
  OR e.candidate_job_ids IS DISTINCT FROM ARRAY[j31,j48]
 THEN RAISE EXCEPTION 'R1: history must be placed exactly as a live row, got % % % / live % %',e.attribution_status,e.candidate_job_ids,e.metadata,
  c.attribution_status,c.candidate_job_ids; END IF;
 SELECT count(*) INTO n FROM public.context_unplaced_for_job(j31) WHERE id=e.id;
 IF n<>1 THEN RAISE EXCEPTION 'R1: missing from the SWF-261431 lane'; END IF;
 SELECT count(*) INTO n FROM public.context_unplaced_for_job(j48) WHERE id=e.id;
 IF n<>1 THEN RAISE EXCEPTION 'R1: missing from the SWF-261448 lane'; END IF;
 -- R14: pre-job texts loaded now: both quotes' lead windows cover 16 Sep.
 FOR o IN SELECT public.capture_ghl_history_event(pg_temp.m4_row(x.id,'lYPee0K2DuQHXH2xHL1P','inbound','Pre-job text for the R14 fixture.',x.at))
  FROM (VALUES ('XyDhsX5IZ9kaS2XxPEzr','2026-09-16T03:00:00Z'),('oS67q2BCAyhbIl4SjihH','2026-09-16T03:05:00Z')) x(id,at)
 LOOP
  SELECT * INTO e FROM public.business_events WHERE id=(o->>'id')::uuid;
  IF e.attribution_status<>o->>'attribution_status' OR e.candidate_job_ids IS DISTINCT FROM ARRAY[j31,j48] OR e.job_id IS NOT NULL
  THEN RAISE EXCEPTION 'R14: pre-job history must have both quotes as candidates, got % %',e.attribution_status,e.candidate_job_ids; END IF;
 END LOOP;
END $$;
ROLLBACK;

BEGIN;
-- 8. R15 and R9: all past evidence of a live job's contact is loaded, and the
-- ladder still places it at its own time. R15's 3 Jul text is before any job
-- (SWF-261209 created 14 Aug; its lead window starts 15 Jul): it stays
-- before any job, never pulled onto the job by being loaded now (X18).
DO $$
DECLARE j09 uuid; j41 uuid; o jsonb; e public.business_events;
BEGIN
 j09:=pg_temp.m4_job('SWF-261209','accepted','fencing','9wd4UDe6f9eW83msKylC','2026-08-14T02:00:00Z');
 o:=public.capture_ghl_history_event(pg_temp.m4_row('vylm5LHmbChCfgZLawc2','9wd4UDe6f9eW83msKylC','inbound','Shared fence text for the R15 fixture.','2026-07-03T02:00:00Z'));
 SELECT * INTO e FROM public.business_events WHERE id=(o->>'id')::uuid;
 IF e.attribution_status<>'admin_bucket' OR e.job_id IS NOT NULL OR e.metadata->>'placement_rule'<>'no_candidate_at_time'
 THEN RAISE EXCEPTION 'R15: must stay before any job, got % % %',e.attribution_status,e.job_id,e.metadata; END IF;
 j41:=pg_temp.m4_job('SWP-26941','in_progress','patio','Oxqi7eCx2rGCsS0BXOH2','2026-09-01T02:00:00Z');
 o:=public.capture_ghl_history_event(pg_temp.m4_row('1TPog9f79izPytVu8yoo','Oxqi7eCx2rGCsS0BXOH2','inbound','are the guys coming today?','2026-09-22T23:08:00Z'));
 IF o->>'attribution_status' IS DISTINCT FROM 'single_open' OR o->>'job_id'<>j41::text THEN RAISE EXCEPTION 'R9: one live job, got %',o; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 9. The door refuses anything but a backfill history row naming no job, and
-- loads nothing while the attribution lane is off.
DO $$
DECLARE j uuid; o jsonb; n integer;
BEGIN
 j:=pg_temp.m4_job('SWF-261335','scheduled','fencing','1VHBzZX6DsjMZW2WbgQn','2026-08-20T02:00:00Z');
 o:=public.capture_ghl_history_event(pg_temp.m4_row('m4Refuse00000001','1VHBzZX6DsjMZW2WbgQn','inbound','x','2026-09-04T01:00:00Z','live'));
 IF o->>'code' IS DISTINCT FROM 'history_row_not_backfill' THEN RAISE EXCEPTION 'm4 live row taken %',o; END IF;
 o:=public.capture_ghl_history_event(pg_temp.m4_row('m4Refuse00000002','1VHBzZX6DsjMZW2WbgQn','inbound','x','2026-09-04T01:00:00Z','backfill','ghl_sms_cache_backfill'));
 IF o->>'code' IS DISTINCT FROM 'history_row_source_invalid' THEN RAISE EXCEPTION 'm4 other source taken %',o; END IF;
 o:=public.capture_ghl_history_event(pg_temp.m4_row('m4Refuse00000003','1VHBzZX6DsjMZW2WbgQn','inbound','x','2026-09-04T01:00:00Z')
  ||jsonb_build_object('job_id',j,'match_method','direct_job_id'));
 IF o->>'code' IS DISTINCT FROM 'history_row_job_refused' THEN RAISE EXCEPTION 'm4 job assertion taken %',o; END IF;
 o:=public.capture_ghl_history_event(pg_temp.m4_row('m4Refuse00000004','1VHBzZX6DsjMZW2WbgQn','inbound','x','2026-09-04T01:00:00Z')||'{"metadata":null}');
 IF o->>'code' IS DISTINCT FROM 'history_row_not_backfill' THEN RAISE EXCEPTION 'm4 row without metadata taken %',o; END IF;
 UPDATE public.automation_switches SET attribution=false WHERE id=1;
 o:=public.capture_ghl_history_event(pg_temp.m4_row('m4Refuse00000005','1VHBzZX6DsjMZW2WbgQn','inbound','x','2026-09-04T01:00:00Z'));
 IF o->>'code' IS DISTINCT FROM 'attribution_disabled' THEN RAISE EXCEPTION 'm4 attribution off taken %',o; END IF;
 SELECT count(*) INTO n FROM public.business_events WHERE provider_message_id LIKE 'ghl:m4Refuse%';
 IF n<>0 THEN RAISE EXCEPTION 'm4 a refused row was written (%)',n; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 10. A real run starts through one reservation: the jobs it will cover are
-- counted on its run row before any work, a second live run is refused, an
-- abandoned one is closed, and the next reservation sees the counted jobs.
DO $$
DECLARE r jsonb; r2 jsonb; id1 uuid;
BEGIN
 PERFORM pg_temp.m4_job('SWP-26941','in_progress','patio','Oxqi7eCx2rGCsS0BXOH2','2026-09-01T02:00:00Z');
 PERFORM pg_temp.m4_job('SWF-261431','quoted','fencing','lYPee0K2DuQHXH2xHL1P','2026-09-17T02:00:00Z',now()-interval '5 days');
 PERFORM pg_temp.m4_job('SWF-261448','quoted','fencing','lYPee0K2DuQHXH2xHL1P','2026-09-21T02:00:00Z',now()-interval '3 days');
 BEGIN PERFORM public.reserve_ghl_history_run(20,'bad actor!'); RAISE EXCEPTION 'm4 bad actor taken';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'history_reserve_actor_invalid' THEN RAISE; END IF; END;
 r:=public.reserve_ghl_history_run(1,'m4-validator');
 id1:=(r->>'run_id')::uuid;
 IF r->>'outcome'<>'reserved' OR jsonb_array_length(r#>'{due,contacts}')<>1 OR r#>>'{due,contacts,0,contact_id}'<>'Oxqi7eCx2rGCsS0BXOH2'
 THEN RAISE EXCEPTION 'm4 reserve %',r; END IF;
 IF (SELECT (counts->>'jobs_covered')::integer<>1 OR status<>'running' OR source<>'ghl_history_load' OR cursor->>'actor'<>'m4-validator'
  FROM public.context_capture_runs WHERE id=id1) THEN RAISE EXCEPTION 'm4 reservation not counted on its run row'; END IF;
 -- A second real run while the first is live: refused, nothing counted.
 r2:=public.reserve_ghl_history_run(20,'m4-validator');
 IF r2<>jsonb_build_object('outcome','run_in_progress','run_id',id1) THEN RAISE EXCEPTION 'm4 second live run %',r2; END IF;
 -- The first finishes; the next reservation sees its job counted and takes the rest.
 PERFORM public.record_ghl_history_contact(jsonb_build_object('contact_id','Oxqi7eCx2rGCsS0BXOH2','run_id',id1,'status','done','jobs',1,'actor','m4-validator'));
 PERFORM public.record_capture_run(jsonb_build_object('run_id',id1,'source','ghl_history_load','status','succeeded'));
 r2:=public.reserve_ghl_history_run(20,'m4-validator');
 IF r2#>>'{due,jobs_counted_today}'<>'1' OR r2#>>'{due,jobs_offered}'<>'2' THEN RAISE EXCEPTION 'm4 next reservation %',r2; END IF;
 -- A run left running past the window is abandoned, and its counted jobs stay counted.
 UPDATE public.context_capture_runs SET updated_at=now()-interval '11 minutes' WHERE id=(r2->>'run_id')::uuid;
 r:=public.reserve_ghl_history_run(20,'m4-validator');
 IF r->>'outcome'<>'reserved' OR r#>>'{due,jobs_counted_today}'<>'3'
  OR (SELECT status<>'failed' OR error_code<>'run_abandoned' FROM public.context_capture_runs WHERE id=(r2->>'run_id')::uuid)
 THEN RAISE EXCEPTION 'm4 abandoned run %',r; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 11. The link action: a live job with no GHL contact gets the one contact its
-- keys match, never an overwrite, one audit row per change, reversible.
-- Stand-ins: SWF-26168 (sms.md R21, a real job with no contact) and a blank
-- contact job; SWF-26167 carries a contact already.
DO $$
DECLARE j68 uuid; jblank uuid; j67 uuid; jdone uuid; jfrozen uuid; jdraft uuid; jdraft2 uuid; run uuid; dry uuid; o jsonb; l record; c record; n integer;
BEGIN
 j68:=pg_temp.m4_job('SWF-26168','accepted','fencing',NULL,'2026-07-20T02:00:00Z');
 UPDATE public.jobs SET client_phone='0412 345 678',client_email='Chris.Test@Example.com' WHERE id=j68;
 jblank:=pg_temp.m4_job('M4-LNK-BLANK','scheduled','fencing','  ','2026-08-01Z');
 UPDATE public.jobs SET client_email='blank.test@example.com' WHERE id=jblank;
 j67:=pg_temp.m4_job('SWF-26167','accepted','fencing','TZ8YSOsYK6et7nCbviSs','2026-07-10T02:00:00Z');
 UPDATE public.jobs SET client_phone='0400 111 222' WHERE id=j67;
 jdone:=pg_temp.m4_job('M4-LNK-DONE','complete','fencing',NULL,'2026-06-01Z');
 UPDATE public.jobs SET client_phone='0400 999 888' WHERE id=jdone;
 -- Candidates: live and contactless only, with B0 keys; our records name no contact for them.
 SELECT count(*) INTO n FROM public.context_ghl_history_link_candidates(NULL,500) WHERE job_id IN (j67,jdone);
 IF n<>0 THEN RAISE EXCEPTION 'm4 link candidates took a contacted or closed job'; END IF;
 SELECT * INTO c FROM public.context_ghl_history_link_candidates(NULL,500) WHERE job_id=j68;
 IF c.phone_key<>'412345678' OR c.email_key<>'chris.test@example.com' OR c.own_contact_id IS NOT NULL OR c.own_contacts<>0
 THEN RAISE EXCEPTION 'm4 link candidate keys %',to_jsonb(c); END IF;
 -- Our records already give the key to a contact: the candidate says so.
 UPDATE public.jobs SET client_phone='0400 111 222' WHERE id=jblank;
 SELECT * INTO c FROM public.context_ghl_history_link_candidates(NULL,500) WHERE job_id=jblank;
 IF c.own_contact_id IS DISTINCT FROM 'TZ8YSOsYK6et7nCbviSs' OR c.own_contacts<>1 THEN RAISE EXCEPTION 'm4 own records %',to_jsonb(c); END IF;

 run:=pg_temp.m4_run('ghl_history_link',0);
 dry:=pg_temp.m4_run('ghl_history_link_dry',0);
 BEGIN
  PERFORM public.link_job_ghl_contact(jsonb_build_object('job_id',j68,'contact_id','m4LinkContact0001','key_kind','phone','run_id',dry,'actor','m4-test'));
  RAISE EXCEPTION 'm4 a dry run linked';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'link_run_invalid' THEN RAISE; END IF; END;
 BEGIN
  PERFORM public.link_job_ghl_contact(jsonb_build_object('job_id',j68,'contact_id','m4LinkContact0001','key_kind','name','run_id',run,'actor','m4-test'));
  RAISE EXCEPTION 'm4 a name link taken';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'link_key_kind_invalid' THEN RAISE; END IF; END;
 -- Certain: written, with its audit row.
 o:=public.link_job_ghl_contact(jsonb_build_object('job_id',j68,'contact_id','m4LinkContact0001','key_kind','phone_and_email','run_id',run,'actor','m4-test'));
 SELECT * INTO l FROM public.context_ghl_contact_links WHERE job_id=j68;
 IF o->>'outcome' IS DISTINCT FROM 'linked' OR (SELECT ghl_contact_id FROM public.jobs WHERE id=j68)<>'m4LinkContact0001'
  OR l.old_value IS NOT NULL OR l.new_contact_id<>'m4LinkContact0001' OR l.key_kind<>'phone_and_email' OR l.run_id<>run
  OR l.actor<>'m4-test' OR l.job_number<>'SWF-26168' OR l.reversed_at IS NOT NULL
 THEN RAISE EXCEPTION 'm4 link write % %',o,to_jsonb(l); END IF;
 -- The linked job now folds into the history load.
 IF NOT EXISTS(SELECT 1 FROM public.context_ghl_history_live_jobs() WHERE job_id=j68 AND ghl_contact_id='m4LinkContact0001')
 THEN RAISE EXCEPTION 'm4 linked job not in the load scope'; END IF;
 -- Never an overwrite: a second link, or a link on a job that has a contact.
 o:=public.link_job_ghl_contact(jsonb_build_object('job_id',j68,'contact_id','m4OtherContact001','key_kind','email','run_id',run,'actor','m4-test'));
 IF o->>'outcome' IS DISTINCT FROM 'already_linked' OR (o->>'same_contact')::boolean OR (SELECT ghl_contact_id FROM public.jobs WHERE id=j68)<>'m4LinkContact0001'
 THEN RAISE EXCEPTION 'm4 overwrite %',o; END IF;
 o:=public.link_job_ghl_contact(jsonb_build_object('job_id',j67,'contact_id','m4OtherContact001','key_kind','phone','run_id',run,'actor','m4-test'));
 IF o->>'outcome' IS DISTINCT FROM 'already_linked' OR (SELECT ghl_contact_id FROM public.jobs WHERE id=j67)<>'TZ8YSOsYK6et7nCbviSs'
 THEN RAISE EXCEPTION 'm4 overwrite of an existing contact %',o; END IF;
 -- A closed job is never linked.
 o:=public.link_job_ghl_contact(jsonb_build_object('job_id',jdone,'contact_id','m4OtherContact001','key_kind','phone','run_id',run,'actor','m4-test'));
 IF o->>'outcome' IS DISTINCT FROM 'not_live' OR (SELECT ghl_contact_id FROM public.jobs WHERE id=jdone) IS NOT NULL THEN RAISE EXCEPTION 'm4 closed job linked %',o; END IF;
 -- A blank value is replaced, and the blank is what the audit keeps.
 o:=public.link_job_ghl_contact(jsonb_build_object('job_id',jblank,'contact_id','TZ8YSOsYK6et7nCbviSs','key_kind','phone','run_id',run,'actor','m4-test'));
 IF o->>'outcome' IS DISTINCT FROM 'linked' OR (SELECT old_value FROM public.context_ghl_contact_links WHERE job_id=jblank)<>'  '
 THEN RAISE EXCEPTION 'm4 blank link %',o; END IF;
 SELECT count(*) INTO n FROM public.context_ghl_contact_links;
 IF n<>2 THEN RAISE EXCEPTION 'm4 audit rows % (one per change only)',n; END IF;
 -- Reverse: the old value comes back and the audit row says who reversed it.
 o:=public.reverse_ghl_contact_link(l.id,'m4-reverser');
 IF o->>'outcome' IS DISTINCT FROM 'reversed' OR (SELECT ghl_contact_id FROM public.jobs WHERE id=j68) IS NOT NULL
  OR (SELECT reversed_by FROM public.context_ghl_contact_links WHERE id=l.id)<>'m4-reverser'
 THEN RAISE EXCEPTION 'm4 reverse %',o; END IF;
 IF public.reverse_ghl_contact_link(l.id,'m4-reverser')->>'outcome'<>'already_reversed' THEN RAISE EXCEPTION 'm4 reverse twice'; END IF;
 -- A reversal never undoes a later change.
 SELECT * INTO l FROM public.context_ghl_contact_links WHERE job_id=jblank;
 UPDATE public.jobs SET ghl_contact_id='m4HandSetContact1' WHERE id=jblank;
 o:=public.reverse_ghl_contact_link(l.id,'m4-reverser');
 IF o->>'outcome' IS DISTINCT FROM 'link_superseded' OR (SELECT ghl_contact_id FROM public.jobs WHERE id=jblank)<>'m4HandSetContact1'
 THEN RAISE EXCEPTION 'm4 reverse over a later change %',o; END IF;
 -- Only ghl_contact_id changes: a job with a frozen expected-cost baseline is
 -- linked and keeps it, and the SES money seal never fires.
 PERFORM set_config('m4.forbid_seal','on',true);
 jfrozen:=pg_temp.m4_job('M4-LNK-FROZEN','accepted','fencing',NULL,'2026-08-01Z');
 UPDATE public.jobs SET expected_costs='{"version":1}',expected_frozen_at='2026-08-02Z',client_phone='0433 222 111' WHERE id=jfrozen;
 o:=public.link_job_ghl_contact(jsonb_build_object('job_id',jfrozen,'contact_id','m4FrozenContact01','key_kind','phone','run_id',run,'actor','m4-test'));
 IF o->>'outcome' IS DISTINCT FROM 'linked' OR (SELECT expected_costs<>'{"version":1}' OR expected_frozen_at<>'2026-08-02Z' OR ghl_contact_id<>'m4FrozenContact01'
  FROM public.jobs WHERE id=jfrozen) THEN RAISE EXCEPTION 'm4 frozen-cost job %',o; END IF;
 -- The stand-in proves itself: a real seal-column change does fire it.
 BEGIN UPDATE public.jobs SET type='patio' WHERE id=jfrozen; RAISE EXCEPTION 'm4 seal stand-in did not fire';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'m4 ses money seal fired' THEN RAISE; END IF; END;
 PERFORM set_config('m4.forbid_seal','off',true);
 -- A booking-intake draft is unique per contact: never a second one.
 jdraft:=pg_temp.m4_job('M4-LNK-DRAFT1','draft','fencing','m4DraftOwner00001','2026-08-01Z',NULL,false,'{"booking_intake_draft":"true"}');
 jdraft2:=pg_temp.m4_job('M4-LNK-DRAFT2','draft','fencing',NULL,'2026-08-01Z',now()-interval '2 days',false,'{"booking_intake_draft":"true"}');
 o:=public.link_job_ghl_contact(jsonb_build_object('job_id',jdraft2,'contact_id','m4DraftOwner00001','key_kind','phone','run_id',run,'actor','m4-test'));
 IF o->>'outcome' IS DISTINCT FROM 'booking_draft_conflict' OR (SELECT ghl_contact_id FROM public.jobs WHERE id=jdraft2) IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.context_ghl_contact_links WHERE job_id=jdraft2)
 THEN RAISE EXCEPTION 'm4 second booking draft %',o; END IF;
 -- The reversed job can be linked again (one open link per job).
 o:=public.link_job_ghl_contact(jsonb_build_object('job_id',j68,'contact_id','m4LinkContact0001','key_kind','phone','run_id',run,'actor','m4-test'));
 IF o->>'outcome' IS DISTINCT FROM 'linked' THEN RAISE EXCEPTION 'm4 relink after reverse %',o; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 12. Link candidates are paged by job id (keyset), so repeated runs reach
-- every live job without a contact, not the same first page.
DO $$
DECLARE i integer; ids uuid[]; seen uuid[]:='{}'; page uuid[]; after uuid; pages integer:=0;
BEGIN
 FOR i IN 1..5 LOOP PERFORM pg_temp.m4_job('M4-PAGE-'||i,'accepted','fencing',NULL,'2026-08-01Z'); END LOOP;
 SELECT array_agg(id ORDER BY id) INTO ids FROM public.jobs WHERE job_number LIKE 'M4-PAGE-%';
 -- Walk pages of 2 from the start, each after the last job of the one before.
 LOOP
  SELECT array_agg(job_id ORDER BY job_id) INTO page FROM public.context_ghl_history_link_candidates(after,2);
  EXIT WHEN page IS NULL;
  pages:=pages+1;
  IF cardinality(page)>2 OR (after IS NOT NULL AND page[1]<=after) THEN RAISE EXCEPTION 'm4 keyset page % after %',page,after; END IF;
  seen:=seen||page; after:=page[cardinality(page)];
  EXIT WHEN pages>1000;
 END LOOP;
 IF NOT (seen @> ids) OR cardinality(seen)<>(SELECT count(DISTINCT x) FROM unnest(seen) x) THEN RAISE EXCEPTION 'm4 keyset walk % missed or repeated %',seen,ids; END IF;
 IF (SELECT count(*) FROM public.context_ghl_history_link_candidates(NULL,100000))>500 THEN RAISE EXCEPTION 'm4 page larger than 500'; END IF;
 IF EXISTS(SELECT 1 FROM public.context_ghl_history_link_candidates(ids[5],500) WHERE job_id=ANY(ids)) THEN RAISE EXCEPTION 'm4 page after the last job'; END IF;
END $$;
ROLLBACK;
