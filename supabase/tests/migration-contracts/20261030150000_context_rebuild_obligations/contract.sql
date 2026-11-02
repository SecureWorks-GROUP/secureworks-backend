-- Synthetic database behaviour, not reader grading or production acceptance.
-- The original RPC and writer are exercised; no model/provider is called.
BEGIN;
CREATE FUNCTION pg_temp.rb_assert(ok boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'rebuild preservation: %',msg; END IF; END $$;
DO $$
DECLARE j uuid := gen_random_uuid(); other_job uuid := gen_random_uuid();
 old_gen uuid := gen_random_uuid(); new_gen uuid := gen_random_uuid();
 run_id uuid := gen_random_uuid(); token uuid := gen_random_uuid(); ev uuid := gen_random_uuid();
 invoice uuid := gen_random_uuid(); packet jsonb; reply jsonb; before_live jsonb; n integer;
BEGIN
 UPDATE public.automation_switches SET extraction=true,all_stop=false WHERE id=1;
 UPDATE public.context_ledger_settings SET mode='shadow' WHERE id;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,client_name,site_suburb,metadata,created_at)
 VALUES(j,'00000000-0000-0000-0000-000000000001','scheduled','fencing','SWF-97991','Fixture Customer','Testville','{}','2026-09-01'),
 (other_job,'00000000-0000-0000-0000-000000000001','scheduled','fencing','SWF-97992','Other Fixture','Testville','{}','2026-09-01');
 -- Isolate fixture insertion from operational event triggers, not the functions under test.
 PERFORM set_config('session_replication_role','replica',true);
 INSERT INTO public.business_events(id,job_id,event_type,source,channel,direction,payload,metadata,
  occurred_at,event_at,recorded_at,context_captured_at,attribution_status,attribution_step,attribution_confidence,attributed_at,match_method)
 VALUES(ev,j,'client.reply','rebuild_contract','sms','outbound',
  '{"body":"Please pay invoice INV-97991. Please confirm payment. The invoice recipient is disputed."}',
  '{"written_as":"service_role","party_roles":{"version":"party_roles_v2","sender_role":"staff","recipient_role":"customer","counterpart_role":"customer","basis":"job_customer","audience":"customer"}}',
  '2026-09-02','2026-09-02','2026-09-02','2026-09-02','direct',1,1,'2026-09-02','direct_job_id');
 PERFORM set_config('session_replication_role','origin',true);
 INSERT INTO public.xero_invoices(id,org_id,xero_invoice_id,invoice_type,job_id,invoice_number,status,invoice_date,total,
  amount_due,fully_paid_on,created_at,updated_at)
 VALUES(invoice,'00000000-0000-0000-0000-000000000001',gen_random_uuid(),'ACCREC',j,'INV-97991','PAID','2026-09-01',100,0,'2026-09-05','2026-09-01','2026-09-05');
 INSERT INTO public.context_extraction_runs(id,job_id,run_date,phase,status,lease_token,lease_expires_at,run_seq)
 VALUES(run_id,j,(now() AT TIME ZONE 'Australia/Perth')::date,'ledger','running',token,now()+interval '30 minutes',1);
 INSERT INTO public.context_ledger_generations(id,job_id,kind,status,reader,promoted_at,run_id)
 VALUES(old_gen,j,'backfill','live','luna-ledger:v8',now()-interval '1 day',NULL),
 (new_gen,j,'rebuild','building','luna-ledger:v8',NULL,run_id);
 INSERT INTO public.context_ledger_items(generation_id,job_id,item_key,item_type,status,from_role,to_role,
  what,about_key,opened_at,opened_by,closes_on,needs_reply,written_by,person_locked)
 SELECT old_gen,j,v.key,v.kind,v.status,'us','customer',v.words,'invoice:inv-97991','2026-09-02',
  jsonb_build_array(jsonb_build_object('table','business_events','id',ev,'excerpt',v.excerpt)),v.closes,v.needs,
  'model:luna-ledger:v8',false
 FROM (VALUES
  ('request:payment','request','open','Please pay INV-97991','Please pay invoice INV-97991.','payment',false),
  ('request:confirmation','request','open','Please confirm payment of INV-97991','Please confirm payment.','reply',true),
  ('issue:recipient','issue','disputed','The invoice recipient is disputed','The invoice recipient is disputed.','record',false)
 ) AS v(key,kind,status,words,excerpt,closes,needs);
 INSERT INTO public.context_ledger_items(generation_id,job_id,item_key,item_type,status,from_role,what,
  opened_at,opened_by,closed_at,closed_by,written_by,person_locked)
 VALUES(old_gen,j,'request:person','request','closed','customer','Settled by staff','2026-09-02',
  jsonb_build_array(jsonb_build_object('table','business_events','id',ev,'excerpt','Please confirm payment.')),
  '2026-09-06',NULL,'person:fixture',true);
 SELECT jsonb_agg(to_jsonb(i) ORDER BY item_key) INTO before_live FROM public.context_ledger_items i WHERE generation_id=old_gen;

 BEGIN
  PERFORM public.context_ledger_rebuild_packet(run_id,gen_random_uuid());
  RAISE EXCEPTION 'wrong lease accepted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'context_rebuild_lease_lost' THEN RAISE; END IF;
 END;
 PERFORM pg_temp.rb_assert(NOT EXISTS(SELECT 1 FROM public.context_ledger_items WHERE generation_id=new_gen),'wrong lease seeded items');
 packet := public.context_ledger_rebuild_packet(run_id,token);
 PERFORM pg_temp.rb_assert(jsonb_array_length(packet->'open_items')=4,'unresolved notes or person correction lost');
 PERFORM pg_temp.rb_assert(packet->>'rebuild_generation_id'=new_gen::text,'packet bound to wrong generation');
 PERFORM pg_temp.rb_assert(EXISTS(SELECT 1 FROM jsonb_array_elements(packet->'open_items') x
  WHERE x->>'item_key'='request:confirmation' AND x->>'closes_on'='reply' AND x->'needs_reply'='true'::jsonb),'confirmation collapsed into payment');
 PERFORM pg_temp.rb_assert(EXISTS(SELECT 1 FROM jsonb_array_elements(packet->'open_items') x
  WHERE x->>'item_key'='issue:recipient' AND x->>'status'='disputed'),'recipient dispute dropped');
 PERFORM pg_temp.rb_assert(EXISTS(SELECT 1 FROM jsonb_array_elements(packet->'open_items') x
  WHERE x->>'item_key'='request:person' AND x->>'status'='closed' AND x->'person_locked'='true'::jsonb),'person closure changed');
 PERFORM public.context_ledger_rebuild_packet(run_id,token);
 SELECT count(*) INTO n FROM public.context_ledger_transitions WHERE generation_id=new_gen AND by='rule:rebuild_seed';
 PERFORM pg_temp.rb_assert(n=4,'retry duplicated or reseeded obligations');
 PERFORM set_config('session_replication_role','replica',true);
 UPDATE public.business_events SET job_id=other_job WHERE id=ev;
 PERFORM set_config('session_replication_role','origin',true);
 BEGIN
  PERFORM public.context_ledger_rebuild_packet(run_id,token);
  RAISE EXCEPTION 'source moved after seed accepted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM NOT LIKE 'context_rebuild_prior_source_unresolved:%' THEN RAISE; END IF;
 END;
 PERFORM set_config('session_replication_role','replica',true);
 UPDATE public.business_events SET job_id=j WHERE id=ev;
 PERFORM set_config('session_replication_role','origin',true);
 -- Existing write custody can now transition the old exact key on this generation.
 reply := public.context_ledger_write(run_id,token,new_gen,'[]',
  jsonb_build_array(jsonb_build_object('item_key','request:payment','to_status','closed','reason','Original paid invoice',
   'evidence',jsonb_build_array(jsonb_build_object('table','xero_invoices','id',invoice,'excerpt','Paid invoice')))),
  'luna-ledger:v8');
 PERFORM pg_temp.rb_assert((reply->>'transitions_accepted')::integer=1,'paid correction failed: '||reply::text);
 packet := public.context_ledger_rebuild_packet(run_id,token);
 PERFORM pg_temp.rb_assert(jsonb_array_length(packet->'open_items')=3,'retry restored paid debt');
 PERFORM pg_temp.rb_assert(EXISTS(SELECT 1 FROM public.context_ledger_items WHERE generation_id=new_gen
  AND item_key='request:confirmation' AND status='open' AND closes_on='reply'),'payment erased separate confirmation');
 PERFORM pg_temp.rb_assert(before_live=(SELECT jsonb_agg(to_jsonb(i) ORDER BY item_key) FROM public.context_ledger_items i WHERE generation_id=old_gen),'live notes mutated');
 -- A moved source must not be copied into a fresh generation as certain.
 UPDATE public.context_ledger_generations SET status='failed',failure='fixture complete' WHERE id=new_gen;
 UPDATE public.context_extraction_runs SET status='done' WHERE id=run_id;
 run_id := gen_random_uuid(); new_gen := gen_random_uuid();
 INSERT INTO public.context_extraction_runs(id,job_id,run_date,phase,status,lease_token,lease_expires_at,run_seq)
 VALUES(run_id,j,(now() AT TIME ZONE 'Australia/Perth')::date,'ledger','running',token,now()+interval '30 minutes',2);
 INSERT INTO public.context_ledger_generations(id,job_id,kind,status,reader,run_id)
 VALUES(new_gen,j,'rebuild','building','luna-ledger:v8',run_id);
 PERFORM set_config('session_replication_role','replica',true);
 UPDATE public.business_events SET job_id=other_job WHERE id=ev;
 PERFORM set_config('session_replication_role','origin',true);
 BEGIN
  PERFORM public.context_ledger_rebuild_packet(run_id,token);
  RAISE EXCEPTION 'moved source accepted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM NOT LIKE 'context_rebuild_prior_source_unresolved:%' THEN RAISE; END IF;
 END;
 PERFORM pg_temp.rb_assert(NOT EXISTS(SELECT 1 FROM public.context_ledger_items WHERE generation_id=new_gen),'partial seed survived invalid source');
 PERFORM pg_temp.rb_assert(NOT has_function_privilege('anon','public.context_ledger_rebuild_packet(uuid,uuid)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.context_ledger_rebuild_packet(uuid,uuid)','EXECUTE'),'public access widened');
END $$;
ROLLBACK;
