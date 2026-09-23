-- Deliberately remove the rule that a direct row is never moved by a later
-- claim, and prove the contract catches it.
CREATE OR REPLACE FUNCTION public.capture_business_event(p_row jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 k text; mode text; bad text[]; cols text[]; ins_id uuid; ins_job uuid; ins_status text; ex record; new_job uuid; up_meta jsonb;
BEGIN
 IF p_row IS NULL OR jsonb_typeof(p_row)<>'object' THEN RETURN jsonb_build_object('outcome','error','code','capture_row_invalid'); END IF;
 k:=nullif(btrim(p_row->>'provider_message_id'),'');
 IF k IS NULL THEN RETURN jsonb_build_object('outcome','error','code','capture_row_key_required'); END IF;
 IF nullif(btrim(p_row->>'event_type'),'') IS NULL THEN RETURN jsonb_build_object('outcome','error','code','capture_row_event_type_required'); END IF;
 IF nullif(btrim(p_row->>'source'),'') IS NULL THEN RETURN jsonb_build_object('outcome','error','code','capture_row_source_required'); END IF;
 mode:=CASE WHEN jsonb_typeof(p_row->'metadata')='object' THEN p_row->'metadata'->>'capture_mode' END;
 IF mode IS NULL OR mode NOT IN ('live','backfill','relink') THEN RETURN jsonb_build_object('outcome','error','code','capture_row_capture_mode_invalid'); END IF;
 SELECT array_agg(key ORDER BY key) INTO bad FROM jsonb_object_keys(p_row) key
 WHERE key IN ('id','sequence_number','recorded_at','occurred_at','context_captured_at','attribution_status','attribution_step','attribution_confidence',
  'attributed_at','attribution_checked_at','candidate_job_ids','match_status','match_confidence');
 IF bad IS NOT NULL THEN RETURN jsonb_build_object('outcome','error','code','capture_row_writer_owned_field','fields',to_jsonb(bad)); END IF;
 SELECT array_agg(key ORDER BY key) INTO bad FROM jsonb_object_keys(p_row) key
 WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.business_events'::regclass
  AND a.attname=key AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='');
 IF bad IS NOT NULL THEN RETURN jsonb_build_object('outcome','error','code','capture_row_unknown_column','fields',to_jsonb(bad)); END IF;
 IF NOT public.automation_lane_enabled('capture') THEN RETURN jsonb_build_object('outcome','capture_disabled'); END IF;

 SELECT array_agg(quote_ident(key) ORDER BY key) INTO cols FROM jsonb_object_keys(p_row) key;
 EXECUTE format(
  'INSERT INTO public.business_events (%1$s,occurred_at) SELECT %2$s,clock_timestamp() FROM jsonb_populate_record(NULL::public.business_events,$1) r'
  ' ON CONFLICT (provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING RETURNING id,job_id,attribution_status',
  array_to_string(cols,','),'r.'||array_to_string(cols,',r.'))
 INTO ins_id,ins_job,ins_status USING p_row;
 IF ins_id IS NOT NULL THEN
  RETURN jsonb_build_object('outcome','inserted','id',ins_id,'job_id',ins_job,'attribution_status',ins_status);
 END IF;

 SELECT e.id,e.job_id,e.attribution_status,e.attribution_step,e.attributed_at,e.attribution_confidence,e.match_status,e.match_method,e.match_confidence
 INTO ex FROM public.business_events e WHERE e.provider_message_id=k FOR UPDATE;
 IF ex.id IS NULL THEN RETURN jsonb_build_object('outcome','error','code','capture_duplicate_unreadable'); END IF;

 IF p_row->>'match_method'='direct_job_id' AND p_row->>'job_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  SELECT j.id INTO new_job FROM public.jobs j WHERE j.id=(p_row->>'job_id')::uuid;
 END IF;
 IF new_job IS NULL THEN
  RETURN jsonb_build_object('outcome','duplicate','id',ex.id,'job_id',ex.job_id,'attribution_status',ex.attribution_status,'upgraded',false);
 END IF;
 IF NOT public.automation_lane_enabled('attribution') THEN
  RETURN jsonb_build_object('outcome','duplicate','id',ex.id,'job_id',ex.job_id,'attribution_status',ex.attribution_status,'upgraded',false,
   'upgrade_skipped','attribution_disabled');
 END IF;

 up_meta:=jsonb_build_object(
  'upgraded_from',jsonb_build_object('job_id',ex.job_id,'attribution_status',ex.attribution_status,'attribution_step',ex.attribution_step,
   'attributed_at',ex.attributed_at,'attribution_confidence',ex.attribution_confidence,'match_status',ex.match_status,
   'match_method',ex.match_method,'match_confidence',ex.match_confidence,
   'upgraded_at',clock_timestamp(),'upgraded_by_source',p_row->>'source'),
  'source_job_binding',jsonb_build_object('job_id',new_job,'match_method','direct_job_id'));
 UPDATE public.business_events e SET
  job_id=new_job, attribution_status='direct', attribution_step=1, attributed_at=clock_timestamp(), attribution_confidence=1,
  match_status='matched', match_method='direct_job_id', match_confidence=1,
  metadata=coalesce(e.metadata,'{}'::jsonb)||up_meta
 WHERE e.id=ex.id;
 RETURN jsonb_build_object('outcome','duplicate','id',ex.id,'job_id',new_job,'attribution_status','direct','upgraded',true);
EXCEPTION WHEN OTHERS THEN
 RETURN jsonb_build_object('outcome','error','code',SQLSTATE);
END $$;
