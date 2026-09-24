-- After the down migration: K1's bodies are back (the down migration checks
-- their md5 itself), the writer, pending read and triggers are gone, the list
-- and read record are kept,
-- and a listed job with only pre-go-live evidence is no longer due.
DO $$
DECLARE j uuid:=gen_random_uuid(); e uuid;
BEGIN
 IF to_regprocedure('public.context_catchup_request(boolean)') IS NOT NULL OR to_regprocedure('public.context_catchup_mark_done()') IS NOT NULL
  OR to_regprocedure('public.context_catchup_record_read()') IS NOT NULL OR to_regprocedure('public.context_catchup_pending_rows(uuid[])') IS NOT NULL
  OR to_regprocedure('public.context_catchup_eligible_rows(uuid[])') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.context_extraction_runs'::regclass AND tgname='context_catchup_mark_done')
  OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.context_extraction_event_receipts'::regclass AND tgname='context_catchup_record_read')
 THEN RAISE EXCEPTION 'catch-up rollback left its writer, row readers or a trigger'; END IF;
 IF to_regclass('public.context_catchup_jobs') IS NULL OR to_regclass('public.context_catchup_reads') IS NULL
 THEN RAISE EXCEPTION 'catch-up rollback dropped the list or the read record'; END IF;
 IF public.context_cadence_status() ? 'catchup' THEN RAISE EXCEPTION 'catch-up rollback status still has the block'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.persist_luna_context_revision(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,integer)'))
  IS DISTINCT FROM '2ef95a949f0aae99cc323abde10f2ee7'
 THEN RAISE EXCEPTION 'catch-up rollback did not restore the 9-argument persistence body'; END IF;
 IF has_function_privilege('anon','public.context_extraction_candidates(integer)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_extraction_candidates(integer)','EXECUTE')
 THEN RAISE EXCEPTION 'catch-up rollback grants'; END IF;
 INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES(j,'00000000-0000-0000-0000-000000000001','scheduled','fencing','CU-RB-'||j);
 INSERT INTO public.business_events(job_id,match_method,direction,event_type,payload,occurred_at,event_at)
  VALUES(j,'direct_job_id','inbound','client.sms_in','{"body":"Before go-live"}',now()-interval '400 days',now()-interval '400 days') RETURNING id INTO e;
 UPDATE public.business_events SET context_captured_at=(public.context_cadence_policy()->>'live_since')::timestamptz-interval '1 day',
  attributed_at=CASE WHEN attributed_at IS NULL THEN NULL ELSE (public.context_cadence_policy()->>'live_since')::timestamptz-interval '1 day' END,
  metadata=metadata-'written_as' WHERE id=e;
 INSERT INTO public.context_catchup_jobs(job_id,job_number,priority) VALUES(j,'CU-RB',1);
 IF EXISTS(SELECT 1 FROM public.context_extraction_candidates(400) c WHERE c.job_id=j) THEN RAISE EXCEPTION 'catch-up rollback still reads listed jobs'; END IF;
 IF (SELECT count(*) FROM public.context_extraction_events(j,25))<>1 THEN RAISE EXCEPTION 'catch-up rollback batch is not the unread read'; END IF;
 DELETE FROM public.context_catchup_jobs WHERE job_id=j;
 DELETE FROM public.business_events WHERE job_id=j;
 DELETE FROM public.jobs WHERE id=j;
END $$;
