-- Ship the stale alarm's old rule: the 20261104130000 status body, which measures staleness from the
-- last run's START, so a reader that starts a run every 20 minutes and never finishes one raises
-- nothing (30 Oct to 3 Nov 2026). The contract's alarm section must catch it.
CREATE OR REPLACE FUNCTION public.context_document_text_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 policy jsonb:=public.context_document_text_policy();
 now_time timestamptz:=now();
 flag jsonb:=public.context_document_text_flag();
 flag_on boolean:=(flag->>'enabled')::boolean;
 lane_on boolean:=public.automation_lane_enabled('capture');
 last_run jsonb; last_run_at timestamptz; runs jsonb; attempts_24h bigint; errors_24h bigint;
 docs jsonb; due integer; alarms jsonb:='[]'::jsonb; since timestamptz;
BEGIN
 SELECT jsonb_build_object('run_id',c.id,'status',c.status,'started_at',c.started_at,'finished_at',c.finished_at,
   'error_code',c.error_code,'counts',c.counts), c.started_at
 INTO last_run,last_run_at FROM public.context_capture_runs c WHERE c.source=policy->>'run_source' ORDER BY c.started_at DESC LIMIT 1;
 SELECT coalesce(jsonb_object_agg(s.status,s.n),'{}'::jsonb) INTO runs FROM (
  SELECT c.status,count(*) n FROM public.context_capture_runs c
  WHERE c.source=policy->>'run_source' AND c.started_at>now_time-interval '24 hours' GROUP BY c.status) s;
 SELECT coalesce(sum(CASE WHEN jsonb_typeof(c.counts->'selected')='number' THEN (c.counts->>'selected')::bigint ELSE 0 END),0),
  coalesce(sum(CASE WHEN jsonb_typeof(c.counts->'errors')='number' THEN (c.counts->>'errors')::bigint ELSE 0 END),0)
 INTO attempts_24h,errors_24h FROM public.context_capture_runs c
 WHERE c.source=policy->>'run_source' AND c.started_at>now_time-interval '24 hours';

 WITH j AS (
  SELECT s.*, t.outcome, t.file_kind, t.next_at, t.source_fingerprint
  FROM public.context_document_text_sources() s
  LEFT JOIN public.context_document_texts t ON t.source_kind=s.source_kind AND t.source_id=s.source_id AND t.job_id IS NOT DISTINCT FROM s.job_id
 )
 SELECT jsonb_build_object(
  'total',count(*),
  'jobs',count(DISTINCT j.job_id),
  'with_text',count(*) FILTER (WHERE j.outcome='saved' AND j.source_fingerprint=j.fingerprint),
  'no_text_layer',count(*) FILTER (WHERE j.outcome='no_text_layer' AND j.source_fingerprint=j.fingerprint),
  'no_text_layer_pdf',count(*) FILTER (WHERE j.outcome='no_text_layer' AND j.file_kind='pdf' AND j.source_fingerprint=j.fingerprint),
  'no_text_layer_image',count(*) FILTER (WHERE j.outcome='no_text_layer' AND j.file_kind='image' AND j.source_fingerprint=j.fingerprint),
  'not_supported',count(*) FILTER (WHERE j.outcome='not_supported' AND j.source_fingerprint=j.fingerprint),
  'too_large',count(*) FILTER (WHERE j.outcome='too_large' AND j.source_fingerprint=j.fingerprint),
  'too_many_pages',count(*) FILTER (WHERE j.outcome='too_many_pages' AND j.source_fingerprint=j.fingerprint),
  'unreadable',count(*) FILTER (WHERE j.outcome='unreadable' AND j.source_fingerprint=j.fingerprint),
  'no_file',count(*) FILTER (WHERE j.outcome='no_file' AND j.source_fingerprint=j.fingerprint),
  'failed',count(*) FILTER (WHERE j.outcome='failed' AND j.source_fingerprint=j.fingerprint),
  'pending',count(*) FILTER (WHERE j.outcome='pending'),
  'never_tried',count(*) FILTER (WHERE j.outcome IS NULL),
  'changed_since_read',count(*) FILTER (WHERE j.outcome IS NOT NULL AND j.outcome<>'pending' AND j.source_fingerprint<>j.fingerprint)),
  count(*) FILTER (WHERE j.outcome IS NULL OR (j.outcome='pending' AND j.next_at<=now_time)
   OR (j.outcome<>'pending' AND j.source_fingerprint<>j.fingerprint))::integer
 INTO docs,due FROM j;

 IF lane_on AND flag_on THEN
  since:=coalesce(last_run_at,(flag->>'updated_at')::timestamptz);
  IF due>0 AND since IS NOT NULL AND now_time-since>make_interval(mins=>(policy->>'stale_minutes')::integer) THEN
   alarms:=alarms||jsonb_build_array(jsonb_build_object('key','document_text_stale','severity','warning','since',since,'due',due,
    'last_run_status',last_run->>'status','last_run_error',last_run->>'error_code',
    'what_to_do','Documents are waiting for a text read but the 10-minute reader has not run for 30 minutes. Check the context-document-text cron job and edge function logs, and the capture lane.'));
  END IF;
  IF attempts_24h>=(policy->>'failing_min_attempts')::integer AND errors_24h>(policy->>'failing_error_ratio')::numeric*attempts_24h THEN
   alarms:=alarms||jsonb_build_array(jsonb_build_object('key','document_text_failing','severity','warning','since',now_time-interval '24 hours',
    'attempts_24h',attempts_24h,'errors_24h',errors_24h,
    'what_to_do','More than 1 in 5 document reads failed in 24 hours. Check the failure codes in context_document_texts and the storage buckets.'));
  END IF;
 END IF;

 RETURN jsonb_build_object('as_of',now_time,'policy',policy,'flag',flag,'capture_lane',lane_on,
  'reader',jsonb_build_object('last_run',last_run,'runs_24h',runs,'selected_24h',attempts_24h,'errors_24h',errors_24h),
  'documents',docs,'due_now',coalesce(due,0),'alarms',alarms);
END $$;
