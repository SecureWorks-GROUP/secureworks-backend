-- C1a (context build plan, Wave 2; design sms.md §2 and §3, INTEGRATION X3):
-- public.capture_business_event(p_row jsonb), the one SQL writer for new
-- evidence code. Its first caller is ghl-proxy send_sms; the GHL webhook
-- receiver (C1c), the GHL reconciler (C1d), the booking action (D2), email and
-- call capture follow through the same function.
--
-- What it does, in order:
--  1. Refuses a malformed row with a code, writing nothing:
--     capture_row_invalid            p_row is not a json object
--     capture_row_key_required       no provider_message_id (every row is keyed;
--                                    no key means no row, sms.md review M8)
--     capture_row_event_type_required, capture_row_source_required
--     capture_row_capture_mode_invalid  metadata.capture_mode is not live,
--                                    backfill or relink (INTEGRATION X15)
--     capture_row_writer_owned_field a field only the database writes: id,
--                                    sequence_number, recorded_at,
--                                    occurred_at (ingestion time, stamped here),
--                                    context_captured_at, the attribution_*
--                                    fields, candidate_job_ids, match_status,
--                                    match_confidence (the ladder writes them)
--     capture_row_unknown_column     a key that is not a business_events column
--                                    (a typo would otherwise vanish silently)
--  2. Checks the capture lane (automation_lane_enabled('capture')): off returns
--     capture_disabled and writes nothing.
--  3. INSERT ... ON CONFLICT (provider_message_id) WHERE provider_message_id IS
--     NOT NULL DO NOTHING, with occurred_at = clock_timestamp(). The existing
--     BEFORE INSERT trigger runs the ladder as today.
--  4. On a duplicate, the upgrade rule (sms.md §3, review M9): when the new row
--     carries a verified direct writer job id (job_id plus match_method
--     direct_job_id, an existing job) and the existing row is not already
--     direct, the existing row's link becomes that job exactly as the ladder
--     writes a step-1 writer link (job_id, attribution_status direct,
--     attribution_step 1, attributed_at, attribution_confidence 1, match_status
--     matched, match_method direct_job_id, match_confidence 1, and
--     metadata.source_job_binding). The previous values go to
--     metadata.upgraded_from. Nothing else on the existing row changes, and a
--     row already direct is never moved (direct_job_mismatch is reported
--     instead). Like the ladder, no upgrade while the attribution lane is off.
--
-- Returns one json object: {outcome: inserted | duplicate | capture_disabled |
-- error, ...}. inserted and duplicate carry id, job_id, attribution_status;
-- duplicate carries upgraded; error carries code only (never row text).
--
-- Access: SECURITY DEFINER, fixed search_path, EXECUTE for service_role only.
-- Adds no grant, policy or view for anon or authenticated. Writes no row and
-- changes no flag or switch here.
--
-- Rollback: supabase/rollbacks/20260924100000_context_capture_business_event_down.sql
-- (drops the function). Redeploy the previous ghl-proxy first: the new
-- ghl-proxy send_sms calls this function.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Pre-image guard: the function must be absent (as read from production on 23 Sep
-- 2026) or already this body (md5 4819869e6dcc40d5cd19a7eba295392c, a re-apply), and the
-- partial unique index the ON CONFLICT clause infers must be the live one.
DO $guard$
DECLARE live_md5 text; idx text;
BEGIN
 SELECT md5(p.prosrc) INTO live_md5 FROM pg_proc p WHERE p.oid=to_regprocedure('public.capture_business_event(jsonb)');
 IF live_md5 IS NOT NULL AND live_md5 <> '4819869e6dcc40d5cd19a7eba295392c' THEN
  RAISE EXCEPTION 'capture_business_event_preimage_mismatch: public.capture_business_event(jsonb) exists with md5 %; read the live definition before replacing it', live_md5;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='capture_business_event' AND p.oid<>coalesce(to_regprocedure('public.capture_business_event(jsonb)'),0)) THEN
  RAISE EXCEPTION 'capture_business_event_preimage_mismatch: another public.capture_business_event overload exists';
 END IF;
 SELECT pg_get_indexdef(i.indexrelid) INTO idx FROM pg_index i
 WHERE i.indexrelid=to_regclass('public.business_events_provider_message_unique');
 IF idx IS NULL OR idx NOT LIKE 'CREATE UNIQUE INDEX business_events_provider_message_unique ON public.business_events USING btree (provider_message_id) WHERE (provider_message_id IS NOT NULL)' THEN
  RAISE EXCEPTION 'capture_business_event_preimage_mismatch: business_events_provider_message_unique is %', coalesce(idx,'<missing>');
 END IF;
END $guard$;

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
 IF ex.attribution_status IS NOT DISTINCT FROM 'direct' THEN
  RETURN jsonb_build_object('outcome','duplicate','id',ex.id,'job_id',ex.job_id,'attribution_status',ex.attribution_status,'upgraded',false,
   'direct_job_mismatch',ex.job_id IS DISTINCT FROM new_job);
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

COMMENT ON FUNCTION public.capture_business_event(jsonb) IS
 'The one SQL writer for new evidence code (context slice C1a). Keyed on provider_message_id; occurred_at stamped at write; ladder runs on insert; a duplicate may only upgrade a non-direct link to a verified direct writer job id (previous values in metadata.upgraded_from). Returns {outcome: inserted|duplicate|capture_disabled|error}. service_role only.';

REVOKE ALL ON FUNCTION public.capture_business_event(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.capture_business_event(jsonb) TO service_role;
