-- P0-02.4. Director only, on a disposable database COPY with the job-page
-- triggers installed and the page queue drained. No model/provider calls.
-- psql "$COPY_DATABASE_URL" -X -v ON_ERROR_STOP=1
--   -v job_change_chain_copy=I-confirm-this-is-a-disposable-copy -f <this file>
\set ON_ERROR_STOP on
\if :{?job_change_chain_copy}
SELECT :'job_change_chain_copy' = 'I-confirm-this-is-a-disposable-copy' AS copy_ack \gset
\else
\echo 'Refused: disposable copy acknowledgement required'
\quit 3
\endif
\if :copy_ack
\else
\echo 'Refused: disposable copy acknowledgement required'
\quit 3
\endif

BEGIN;
SET LOCAL statement_timeout = '45s';
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
DO $check$
DECLARE
 a constant uuid := '00000000-0000-4000-8000-000000000412';
 b constant uuid := '00000000-0000-4000-8000-000000000413';
 v_org uuid; v_before bigint; v_result jsonb; v_start timestamptz; v_ms numeric;
 v_writer boolean := public.context_job_story_text_on();
BEGIN
 IF public.job_pages_next_due() IS NOT NULL THEN
  RAISE EXCEPTION 'copy queue must be drained before this isolated chain check';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.business_events'::regclass
  AND tgname='job_mark_changed_business_events' AND tgenabled IN ('O','A')) THEN
  RAISE EXCEPTION 'copy needs the job-page business-event trigger installed';
 END IF;
 SELECT org_id INTO v_org FROM public.jobs ORDER BY id LIMIT 1;
 IF v_org IS NULL THEN RAISE EXCEPTION 'copy needs an existing job organisation'; END IF;
 INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES
  (a,v_org,'fencing','accepted','ZZTEST-412'),(b,v_org,'fencing','accepted','ZZTEST-413');
 v_result := public.job_page_refresh(a);
 IF v_result->>'outcome' IS DISTINCT FROM 'built' THEN RAISE EXCEPTION '412 initial build failed: %',v_result; END IF;
 v_result := public.job_page_refresh(b);
 IF v_result->>'outcome' IS DISTINCT FROM 'built' THEN RAISE EXCEPTION '413 initial build failed: %',v_result; END IF;
 -- Jobs' birth can itself leave an acknowledged mark. Unchanged means its
 -- observed version stays fixed, not that its append-only history is deleted.
 SELECT mark_version INTO v_before FROM public.job_change_marks WHERE job_id=b;
 INSERT INTO public.context_job_story_texts(job_id,checked_at,card_hash,model,sections)
 VALUES(a,now(),repeat('0',32),'zztest',jsonb_build_object(
  'headline','ZZTEST-412','the_job','Test job.','how_we_got_here','Test setup.',
  'where_it_is_at','Test change pending.','watch_out','Test only.'));
 -- The sanctioned evidence writer owns id and occurred_at and verifies the job.
 v_result := public.capture_business_event(jsonb_build_object(
  'provider_message_id','zztest-chain-'||gen_random_uuid()::text,
  'job_id',a,'event_type','note','source','contract','channel','note',
  'match_method','direct_job_id','payload',jsonb_build_object('body','ZZTEST-412 update'),
  'metadata',jsonb_build_object('capture_mode','relink')));
 IF v_result->>'outcome' IS DISTINCT FROM 'inserted' OR v_result->>'job_id' IS DISTINCT FROM a::text THEN
  RAISE EXCEPTION 'planted event was not written on 412: %',v_result;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.job_change_mark_events WHERE job_id=a AND page_pending) THEN
  RAISE EXCEPTION 'planted event did not mark 412';
 END IF;
 v_start := clock_timestamp();
 v_result := public.job_pages_refresh_due(5);
 v_ms := extract(epoch FROM clock_timestamp()-v_start)*1000;
 RAISE NOTICE 'refresh_ms=%',v_ms;
 IF v_ms >= 2000 THEN RAISE EXCEPTION 'queue step exceeded 2000 ms'; END IF;
 IF v_result->>'refreshed' IS DISTINCT FROM '1' OR NOT EXISTS(
  SELECT 1 FROM public.job_change_marks m JOIN public.job_page_marks_seen s USING(job_id)
  JOIN public.job_pages p USING(job_id) WHERE job_id=a AND p.status='ready'
  AND s.mark_version=m.mark_version AND s.page_done_at=m.last_marked_at) THEN
  RAISE EXCEPTION '412 page did not acknowledge its current mark: %',v_result;
 END IF;
 IF v_writer THEN
  IF (SELECT count(*) FROM public.context_job_story_requests WHERE job_id=a AND done_at IS NULL AND reason='job_changed')<>1 THEN
   RAISE EXCEPTION '412 needs exactly one job_changed request';
  END IF;
 ELSE
  RAISE NOTICE 'writer switch off on this copy';
 END IF;
 IF (SELECT mark_version FROM public.job_change_marks WHERE job_id=b) IS DISTINCT FROM v_before
  OR EXISTS(SELECT 1 FROM public.job_change_mark_events WHERE job_id=b AND page_pending)
  OR EXISTS(SELECT 1 FROM public.context_job_story_requests WHERE job_id=b) THEN
  RAISE EXCEPTION 'unchanged 413 acquired work';
 END IF;
 v_result := public.job_pages_refresh_due(5);
 IF v_result->>'refreshed' IS DISTINCT FROM '0'
  OR (v_writer AND (SELECT count(*) FROM public.context_job_story_requests WHERE job_id=a AND done_at IS NULL)<>1) THEN
  RAISE EXCEPTION 'second queue step rebuilt or duplicated work: %',v_result;
 END IF;
 RAISE NOTICE 'PASS: P0-02.4 change marked and page acknowledged; unchanged job idle; repeat idle';
END $check$;
ROLLBACK;
