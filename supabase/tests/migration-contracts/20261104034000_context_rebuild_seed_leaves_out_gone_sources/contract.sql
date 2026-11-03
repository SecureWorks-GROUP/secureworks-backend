-- Synthetic database behaviour (finish line C3, 3 Nov 2026): a rebuild whose carried notes cite sources that are gone
-- is prepared, leaving those notes out and naming them, instead of being refused for ever.
BEGIN;
CREATE FUNCTION pg_temp.rs_assert(ok boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'rebuild seed: %', msg; END IF; END $$;
DO $$
DECLARE j uuid := gen_random_uuid(); other_job uuid := gen_random_uuid();
 old_gen uuid := gen_random_uuid(); new_gen uuid := gen_random_uuid();
 run_id uuid := gen_random_uuid(); token uuid := gen_random_uuid();
 ev_kept uuid := gen_random_uuid(); ev_moved uuid := gen_random_uuid(); ev_gone uuid := gen_random_uuid();
 packet jsonb; seed jsonb; before_live jsonb; n integer;
BEGIN
 UPDATE public.automation_switches SET extraction=true,all_stop=false WHERE id=1;
 UPDATE public.context_ledger_settings SET mode='shadow' WHERE id;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,client_name,site_suburb,metadata,created_at)
 VALUES(j,'00000000-0000-0000-0000-000000000001','scheduled','fencing','SWF-98041','Fixture Customer','Testville','{}','2026-09-01'),
 (other_job,'00000000-0000-0000-0000-000000000001','scheduled','fencing','SWF-98042','Other Fixture','Testville','{}','2026-09-01');
 PERFORM set_config('session_replication_role','replica',true);
 INSERT INTO public.business_events(id,job_id,event_type,source,channel,direction,payload,metadata,
  occurred_at,event_at,recorded_at,context_captured_at,attribution_status,attribution_step,attribution_confidence,attributed_at,match_method)
 SELECT v.id,v.job,'client.reply','rebuild_seed_contract','sms','outbound',jsonb_build_object('body',v.body),
  '{"written_as":"service_role","party_roles":{"version":"party_roles_v2","sender_role":"staff","recipient_role":"customer","counterpart_role":"customer","basis":"job_customer","audience":"customer"}}',
  '2026-09-02','2026-09-02','2026-09-02','2026-09-02','direct',1,1,'2026-09-02','direct_job_id'
 FROM (VALUES (ev_kept, j, 'Please pay invoice INV-98041.'), (ev_moved, other_job, 'Please confirm the gate width.')) AS v(id,job,body);
 PERFORM set_config('session_replication_role','origin',true);
 INSERT INTO public.context_extraction_runs(id,job_id,run_date,phase,status,lease_token,lease_expires_at,run_seq)
 VALUES(run_id,j,(now() AT TIME ZONE 'Australia/Perth')::date,'ledger','running',token,now()+interval '30 minutes',1);
 INSERT INTO public.context_ledger_generations(id,job_id,kind,status,reader,promoted_at,run_id)
 VALUES(old_gen,j,'backfill','live','luna-ledger:v8',now()-interval '1 day',NULL),
 (new_gen,j,'rebuild','building','luna-ledger:v8',NULL,run_id);
 -- Kept: its row is on the job. Moved: its row now sits on another job. Gone: its row no longer exists.
 INSERT INTO public.context_ledger_items(generation_id,job_id,item_key,item_type,status,from_role,to_role,
  what,about_key,opened_at,opened_by,closes_on,needs_reply,written_by,person_locked)
 SELECT old_gen,j,v.key,'request',v.status,'us','customer',v.words,v.about,'2026-09-02',
  jsonb_build_array(jsonb_build_object('table','business_events','id',v.ev,'excerpt',v.excerpt)),v.closes,false,'model:luna-ledger:v8',false
 FROM (VALUES
  ('request:payment','open','Please pay INV-98041','invoice:inv-98041',ev_kept,'Please pay invoice INV-98041.','payment'),
  ('request:gate','open','Please confirm the gate width','quote:gate',ev_moved,'Please confirm the gate width.','reply'),
  ('request:gone','disputed','A booking note whose row was deleted','booking:gone',ev_gone,'A booking row deleted since.','record')
 ) AS v(key,status,words,about,ev,excerpt,closes);
 -- A person's own item on the moved row is carried whatever its source.
 INSERT INTO public.context_ledger_items(generation_id,job_id,item_key,item_type,status,from_role,what,
  opened_at,opened_by,closed_at,closed_by,written_by,person_locked)
 VALUES(old_gen,j,'request:person','request','closed','customer','Settled by staff','2026-09-02',
  jsonb_build_array(jsonb_build_object('table','business_events','id',ev_moved,'excerpt','Please confirm the gate width.')),
  '2026-09-06',NULL,'person:fixture',true);
 SELECT jsonb_agg(to_jsonb(i) ORDER BY item_key) INTO before_live FROM public.context_ledger_items i WHERE generation_id=old_gen;

 packet := public.context_ledger_rebuild_packet(run_id,token);
 PERFORM pg_temp.rs_assert(packet->>'rebuild_generation_id'=new_gen::text,'packet bound to the wrong generation');
 PERFORM pg_temp.rs_assert((SELECT array_agg(x->>'item_key' ORDER BY x->>'item_key') FROM jsonb_array_elements(packet->'open_items') x)
  = ARRAY['request:payment','request:person'],'carried the wrong notes: '||(packet->'open_items')::text);
 SELECT checks->'rebuild_seed' INTO seed FROM public.context_ledger_generations WHERE id=new_gen;
 PERFORM pg_temp.rs_assert((seed->>'items')::integer=2,'seed count is not the carried notes');
 PERFORM pg_temp.rs_assert((SELECT array_agg(x->>'item_key' ORDER BY x->>'item_key') FROM jsonb_array_elements(seed->'left_out') x)
  = ARRAY['request:gate','request:gone'],'the notes left out are not named: '||coalesce(seed->'left_out','null')::text);
 PERFORM pg_temp.rs_assert(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(seed->'left_out') x
  WHERE x->>'code' IS NULL OR x->>'table'<>'business_events' OR x->>'item_type'<>'request'),'a left-out note without its code: '||(seed->'left_out')::text);
 PERFORM pg_temp.rs_assert(NOT EXISTS(SELECT 1 FROM public.context_ledger_items WHERE generation_id=new_gen
  AND item_key IN ('request:gate','request:gone')),'a note whose source is gone was copied');
 -- A retry over the seed answers the same notes and seeds nothing again.
 packet := public.context_ledger_rebuild_packet(run_id,token);
 PERFORM pg_temp.rs_assert(jsonb_array_length(packet->'open_items')=2,'retry changed the carried notes');
 SELECT count(*) INTO n FROM public.context_ledger_transitions WHERE generation_id=new_gen AND by='rule:rebuild_seed';
 PERFORM pg_temp.rs_assert(n=2,'retry reseeded: '||n);
 -- A source that moves after the seed still refuses the retry, as before.
 PERFORM set_config('session_replication_role','replica',true);
 UPDATE public.business_events SET job_id=other_job WHERE id=ev_kept;
 PERFORM set_config('session_replication_role','origin',true);
 BEGIN
  PERFORM public.context_ledger_rebuild_packet(run_id,token);
  RAISE EXCEPTION 'a source moved after the seed was accepted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM NOT LIKE 'context_rebuild_prior_source_unresolved:%' THEN RAISE; END IF;
 END;
 PERFORM pg_temp.rs_assert(before_live=(SELECT jsonb_agg(to_jsonb(i) ORDER BY item_key) FROM public.context_ledger_items i WHERE generation_id=old_gen),'live notes changed');
 PERFORM pg_temp.rs_assert(NOT has_function_privilege('anon','public.context_ledger_rebuild_packet(uuid,uuid)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.context_ledger_rebuild_packet(uuid,uuid)','EXECUTE'),'public access widened');
END $$;
ROLLBACK;
