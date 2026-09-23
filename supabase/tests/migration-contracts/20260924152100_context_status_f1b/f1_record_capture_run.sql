-- F1's record_capture_run(jsonb), byte for byte (20260924020000, md5(prosrc)
-- a85b48f9422fff111ee96093bad55c40). Not a migration. Contracts that re-apply
-- a migration built on F1's writer (C1d) load it inside their rolled-back
-- transaction to stand the pre-image back up after F1b replaced the body.
-- The F1b contract checks the md5.
CREATE OR REPLACE FUNCTION public.record_capture_run(p_run jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 r public.context_capture_runs; n public.context_capture_runs; run_id uuid; src text; k text; val jsonb; existed boolean;
 now_time timestamptz:=clock_timestamp();
BEGIN
 IF p_run IS NULL OR jsonb_typeof(p_run)<>'object'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_run) x WHERE x NOT IN ('run_id','source','status','window_from','window_to','watermark','cursor','counts','error_code'))
 THEN RAISE EXCEPTION 'capture_run_invalid'; END IF;
 src:=nullif(btrim(p_run->>'source'),'');
 IF src IS NULL OR src !~ '^[a-z][a-z0-9_]{2,62}$' THEN RAISE EXCEPTION 'capture_run_source_invalid'; END IF;
 IF p_run ? 'status' AND (p_run->>'status') NOT IN ('running','succeeded','partial','failed') THEN RAISE EXCEPTION 'capture_run_status_invalid'; END IF;
 IF p_run ? 'counts' THEN
  val:=p_run->'counts';
  IF jsonb_typeof(val)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(val))>40 THEN RAISE EXCEPTION 'capture_run_counts_invalid'; END IF;
  FOR k IN SELECT jsonb_object_keys(val) LOOP
   IF k !~ '^[a-z][a-z0-9_]{0,62}$' OR jsonb_typeof(val->k)<>'number' OR (val->>k)::numeric<0 OR (val->>k)::numeric<>trunc((val->>k)::numeric)
    OR (val->>k)::numeric>2147483647
   THEN RAISE EXCEPTION 'capture_run_counts_invalid'; END IF;
  END LOOP;
 END IF;
 BEGIN
  run_id:=coalesce((p_run->>'run_id')::uuid,gen_random_uuid());
  n.window_from:=(p_run->>'window_from')::timestamptz; n.window_to:=(p_run->>'window_to')::timestamptz; n.watermark:=(p_run->>'watermark')::timestamptz;
 EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'capture_run_invalid';
 END;
 SELECT * INTO r FROM public.context_capture_runs c WHERE c.id=run_id FOR UPDATE;
 existed:=FOUND;
 IF existed THEN
  IF r.source<>src THEN RAISE EXCEPTION 'capture_run_source_mismatch'; END IF;
  n:=r;
 ELSE
  n.id:=run_id; n.source:=src; n.status:='running'; n.started_at:=now_time; n.counts:='{}'::jsonb;
  n.window_from:=NULL; n.window_to:=NULL; n.watermark:=NULL; n.cursor:=NULL; n.error_code:=NULL; n.finished_at:=NULL;
 END IF;
 IF p_run ? 'status' THEN n.status:=p_run->>'status'; END IF;
 IF p_run ? 'window_from' THEN n.window_from:=(p_run->>'window_from')::timestamptz; END IF;
 IF p_run ? 'window_to' THEN n.window_to:=(p_run->>'window_to')::timestamptz; END IF;
 IF p_run ? 'watermark' THEN n.watermark:=(p_run->>'watermark')::timestamptz; END IF;
 IF p_run ? 'cursor' THEN n.cursor:=CASE WHEN jsonb_typeof(p_run->'cursor')='null' THEN NULL ELSE p_run->'cursor' END; END IF;
 IF p_run ? 'counts' THEN n.counts:=p_run->'counts'; END IF;
 IF p_run ? 'error_code' THEN n.error_code:=nullif(p_run->>'error_code',''); END IF;
 IF n.error_code IS NOT NULL AND n.error_code !~ '^[a-z0-9][a-z0-9_.:-]{0,119}$' THEN RAISE EXCEPTION 'capture_run_error_code_invalid'; END IF;
 IF n.status='failed' AND n.error_code IS NULL THEN RAISE EXCEPTION 'capture_run_error_code_required'; END IF;
 IF existed AND r.status<>'running' THEN
  IF (n.status,n.window_from,n.window_to,n.watermark,n.cursor,n.counts,n.error_code)
     IS NOT DISTINCT FROM (r.status,r.window_from,r.window_to,r.watermark,r.cursor,r.counts,r.error_code)
  THEN RETURN jsonb_build_object('outcome','unchanged','run_id',r.id,'source',r.source,'status',r.status); END IF;
  RAISE EXCEPTION 'capture_run_finished';
 END IF;
 n.updated_at:=now_time;
 n.finished_at:=CASE WHEN n.status='running' THEN NULL ELSE now_time END;
 BEGIN
  IF existed THEN
   UPDATE public.context_capture_runs c SET status=n.status,updated_at=n.updated_at,finished_at=n.finished_at,window_from=n.window_from,
    window_to=n.window_to,watermark=n.watermark,cursor=n.cursor,counts=n.counts,error_code=n.error_code WHERE c.id=n.id;
  ELSE
   INSERT INTO public.context_capture_runs(id,source,status,started_at,updated_at,finished_at,window_from,window_to,watermark,cursor,counts,error_code)
   VALUES(n.id,n.source,n.status,n.started_at,n.updated_at,n.finished_at,n.window_from,n.window_to,n.watermark,n.cursor,n.counts,n.error_code);
  END IF;
 EXCEPTION WHEN check_violation THEN RAISE EXCEPTION 'capture_run_invalid';
  WHEN unique_violation THEN RAISE EXCEPTION 'capture_run_conflict';
 END;
 RETURN jsonb_build_object('outcome',CASE WHEN existed THEN 'updated' ELSE 'created' END,'run_id',n.id,'source',n.source,'status',n.status);
END $$;
