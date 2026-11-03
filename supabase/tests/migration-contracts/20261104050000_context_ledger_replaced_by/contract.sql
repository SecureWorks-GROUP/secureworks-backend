-- Synthetic database behaviour (finish line C4, 3 Nov 2026): the store takes a retired note that names the earlier note
-- of its generation it repeats (replaced_by), only for one loop of the same owing side, and every other move as before.
BEGIN;
CREATE FUNCTION pg_temp.rb_assert(ok boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'replaced by contract: %', msg; END IF; END $$;
-- One synthetic note of a generation, opened by one cited row.
CREATE FUNCTION pg_temp.rb_item(p_gen uuid, p_key text, p_type text, p_from text, p_to text, p_about text, p_opened date,
 p_cite uuid, p_closes text DEFAULT 'reply', p_status text DEFAULT 'open', p_locked boolean DEFAULT false) RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.context_ledger_items(generation_id,job_id,item_key,item_type,status,from_role,to_role,what,about_key,opened_at,opened_by,
  closed_at,closed_by,closes_on,written_by,person_locked)
 SELECT p_gen,g.job_id,p_key,p_type,p_status,p_from,p_to,'Fixture note '||p_key,p_about,p_opened::timestamptz,
  jsonb_build_array(jsonb_build_object('table','business_events','id',p_cite,'excerpt','fixture')),
  CASE WHEN p_status IN ('closed','declined','superseded') THEN p_opened::timestamptz + interval '1 day' END,
  CASE WHEN p_status IN ('closed','declined') THEN jsonb_build_array(jsonb_build_object('table','business_events','id',p_cite,'excerpt','fixture')) END,
  p_closes, CASE WHEN p_locked THEN 'person:fixture' ELSE 'model:luna-ledger:v8' END, p_locked
 FROM public.context_ledger_generations g WHERE g.id = p_gen $$;
DO $$
DECLARE j uuid := gen_random_uuid(); j2 uuid := gen_random_uuid(); gen uuid := gen_random_uuid(); gen2 uuid := gen_random_uuid();
 run uuid := gen_random_uuid(); run2 uuid := gen_random_uuid(); tok uuid := gen_random_uuid();
 ev_ask uuid := gen_random_uuid(); ev_reply uuid := gen_random_uuid(); ev_other uuid := gen_random_uuid();
 moves jsonb; res jsonb; again jsonb; n integer;
 dup text := 'A second copy of the earlier note on the same matter.';
BEGIN
 UPDATE public.automation_switches SET extraction=true,all_stop=false WHERE id=1;
 UPDATE public.context_ledger_settings SET mode='shadow' WHERE id;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,client_name,site_suburb,metadata,created_at)
 VALUES(j,'00000000-0000-0000-0000-000000000001','scheduled','fencing','SWF-98051','Fixture Customer','Testville','{}','2026-09-01'),
 (j2,'00000000-0000-0000-0000-000000000001','scheduled','fencing','SWF-98052','Other Fixture','Testville','{}','2026-09-01');
 PERFORM set_config('session_replication_role','replica',true);
 INSERT INTO public.business_events(id,job_id,event_type,source,channel,direction,payload,metadata,
  occurred_at,event_at,recorded_at,context_captured_at,attribution_status,attribution_step,attribution_confidence,attributed_at,match_method)
 SELECT v.id,v.job,'client.reply','replaced_by_contract','sms',v.dir,jsonb_build_object('body',v.body),
  jsonb_build_object('written_as','service_role','party_roles',jsonb_build_object('version','party_roles_v2','sender_role',v.sender,
   'recipient_role',CASE WHEN v.sender='customer' THEN 'staff' ELSE 'customer' END,'counterpart_role','customer','basis','job_customer','audience','customer')),
  v.at,v.at,v.at,v.at,'direct',1,1,v.at,'direct_job_id'
 FROM (VALUES (ev_ask, j, 'inbound', 'customer', 'What colour will the gutter be?', '2026-09-04'::timestamptz),
  (ev_reply, j, 'outbound', 'staff', 'Hi, the gutter colour will be Monument to match your trim.', '2026-09-08'::timestamptz),
  (ev_other, j2, 'inbound', 'customer', 'What colour will the fence be?', '2026-09-04'::timestamptz)) AS v(id,job,dir,sender,body,at);
 PERFORM set_config('session_replication_role','origin',true);
 INSERT INTO public.context_extraction_runs(id,job_id,run_date,phase,status,lease_token,lease_expires_at,run_seq)
 VALUES(run,j,(now() AT TIME ZONE 'Australia/Perth')::date,'ledger','running',tok,now()+interval '30 minutes',1),
 (run2,j2,(now() AT TIME ZONE 'Australia/Perth')::date,'ledger','running',gen_random_uuid(),now()+interval '30 minutes',1);
 INSERT INTO public.context_ledger_generations(id,job_id,kind,status,reader,run_id)
 VALUES(gen,j,'rebuild','building','luna-ledger:v8',run),(gen2,j2,'rebuild','building','luna-ledger:v8',run2);
 -- One loop written twice (an ask and our matching promise; the ask again), and pairs the guard must keep apart.
 PERFORM pg_temp.rb_item(gen,'request:ask','request','customer','us','preference:gutter-colour','2026-09-04',ev_ask);
 PERFORM pg_temp.rb_item(gen,'commitment:promise','commitment','us','customer','preference:gutter-colour','2026-09-05',ev_ask);
 PERFORM pg_temp.rb_item(gen,'request:ask-again','request','customer','us','preference:gutter-colour','2026-09-06',ev_ask);
 PERFORM pg_temp.rb_item(gen,'request:pay-inv-1','request','us','customer','invoice:inv-98051','2026-09-04',ev_ask,'payment');
 PERFORM pg_temp.rb_item(gen,'request:pay-inv-2','request','us','customer','invoice:inv-98052','2026-09-05',ev_ask,'payment');
 PERFORM pg_temp.rb_item(gen,'request:pay-inv-1-builder','request','us','insurer_builder','invoice:inv-98051','2026-09-05',ev_ask,'payment');
 PERFORM pg_temp.rb_item(gen,'issue:latch','issue','customer','us','defect:gate-latch','2026-09-04',ev_ask,'person');
 PERFORM pg_temp.rb_item(gen,'request:fix-latch','request','customer','us','defect:gate-latch','2026-09-05',ev_ask);
 PERFORM pg_temp.rb_item(gen,'request:from-unknown-a','request','unknown','us','preference:gutter-colour','2026-09-04',ev_ask);
 PERFORM pg_temp.rb_item(gen,'request:from-unknown-b','request','unknown','us','preference:gutter-colour','2026-09-05',ev_ask);
 PERFORM pg_temp.rb_item(gen,'request:mid','request','customer','us','preference:gutter-colour','2026-09-07',ev_ask);
 PERFORM pg_temp.rb_item(gen,'request:later','request','customer','us','preference:gutter-colour','2026-09-10',ev_ask);
 PERFORM pg_temp.rb_item(gen,'request:locked','request','customer','us','preference:gutter-colour','2026-09-01',ev_ask,'reply','open',true);
 PERFORM pg_temp.rb_item(gen,'request:closed','request','customer','us','preference:gutter-colour','2026-09-02',ev_ask,'reply','closed');
 PERFORM pg_temp.rb_item(gen,'request:spare','request','customer','us','preference:gutter-colour','2026-09-09',ev_ask);
 PERFORM pg_temp.rb_item(gen,'request:old-target','request','customer','us','scope:gate','2026-09-04',ev_ask);
 PERFORM pg_temp.rb_item(gen,'request:old-replacement','request','customer','us','scope:gate','2026-09-07',ev_ask);
 UPDATE public.context_ledger_items SET supersedes_key='request:old-target' WHERE generation_id=gen AND item_key='request:old-replacement';
 PERFORM pg_temp.rb_item(gen,'request:orphan','request','customer','us','scope:other','2026-09-04',ev_ask);
 PERFORM pg_temp.rb_item(gen,'request:colour','request','customer','us','preference:colour','2026-09-04',ev_ask);
 PERFORM pg_temp.rb_item(gen2,'request:other-job','request','customer','us','preference:gutter-colour','2026-09-01',ev_other);

 moves := jsonb_build_array(
  jsonb_build_object('item_key','commitment:promise','to_status','superseded','evidence','[]'::jsonb,'reason',dup,'replaced_by','request:ask'),
  jsonb_build_object('item_key','request:ask-again','to_status','superseded','evidence','[]'::jsonb,'reason',dup,'replaced_by','request:ask'),
  jsonb_build_object('item_key','request:pay-inv-2','to_status','superseded','evidence','[]'::jsonb,'reason',dup,'replaced_by','request:pay-inv-1'),
  jsonb_build_object('item_key','request:pay-inv-1-builder','to_status','superseded','reason',dup,'replaced_by','request:pay-inv-1'),
  jsonb_build_object('item_key','request:fix-latch','to_status','superseded','reason',dup,'replaced_by','issue:latch'),
  jsonb_build_object('item_key','request:from-unknown-b','to_status','superseded','reason',dup,'replaced_by','request:from-unknown-a'),
  jsonb_build_object('item_key','request:mid','to_status','superseded','reason',dup,'replaced_by','request:later'),
  jsonb_build_object('item_key','request:spare','to_status','superseded','reason',dup,'replaced_by','request:locked'),
  jsonb_build_object('item_key','request:spare','to_status','superseded','reason',dup,'replaced_by','request:closed'),
  jsonb_build_object('item_key','request:spare','to_status','superseded','reason',dup,'replaced_by','request:none:ffffffffffff'),
  jsonb_build_object('item_key','request:spare','to_status','superseded','reason',dup,'replaced_by','request:other-job'),
  jsonb_build_object('item_key','request:spare','to_status','superseded','reason',dup,'replaced_by','request:spare'),
  jsonb_build_object('item_key','request:spare','to_status','superseded','reason',dup,'replaced_by','commitment:promise'),
  jsonb_build_object('item_key','request:spare','to_status','closed','evidence',jsonb_build_array(jsonb_build_object('table','business_events','id',ev_reply,
   'excerpt','the gutter colour will be Monument')),'replaced_by','request:ask'),
  jsonb_build_object('item_key','request:spare','to_status','superseded','replaced_by',42),
  jsonb_build_object('item_key','request:spare','to_status','superseded','replaced_by',''),
  jsonb_build_object('item_key','request:spare','to_status','superseded','replaced_by',NULL::text),
  -- Every other move as before.
  jsonb_build_object('item_key','request:old-target','to_status','superseded','reason','Replaced by the later note.'),
  jsonb_build_object('item_key','request:orphan','to_status','superseded'),
  jsonb_build_object('item_key','request:spare','to_status','superseded','foo','bar'),
  jsonb_build_object('item_key','request:colour','to_status','closed','evidence',jsonb_build_array(jsonb_build_object('table','business_events','id',ev_reply,
   'excerpt','the gutter colour will be Monument')),'reason','Our message gave the colour.'));
 res := public.context_ledger_write(run, tok, gen, '[]', moves, 'luna-ledger:v8');
 PERFORM pg_temp.rb_assert(res->>'outcome'='written' AND (res->>'transitions_accepted')::integer=4,
  'the copies are retired and every other move is taken as before: '||res::text);
 PERFORM pg_temp.rb_assert((SELECT array_agg(x->>'item_key'||' '||(x->>'code') ORDER BY o) FROM jsonb_array_elements(res->'transitions_refused') WITH ORDINALITY y(x,o))
  = ARRAY['request:pay-inv-2 replaced_by_other_loop','request:pay-inv-1-builder replaced_by_other_loop','request:fix-latch replaced_by_other_loop',
   'request:from-unknown-b replaced_by_other_loop','request:mid replaced_by_later','request:spare replaced_by_not_open','request:spare replaced_by_not_open',
   'request:spare replaced_by_unknown','request:spare replaced_by_unknown','request:spare replaced_by_itself','request:spare replaced_by_not_open',
   'request:spare invalid_shape','request:spare invalid_shape','request:spare invalid_shape','request:spare invalid_shape',
   'request:orphan superseded_without_replacement','request:spare invalid_shape'],
  'refusals: '||(res->'transitions_refused')::text);
 PERFORM pg_temp.rb_assert((SELECT x->>'detail' FROM jsonb_array_elements(res->'transitions_refused') WITH ORDINALITY y(x,o) WHERE o=17)
  = 'a transition is {item_key, to_status, evidence, reason}', 'an unknown key keeps its old detail');
 PERFORM pg_temp.rb_assert((SELECT x->>'detail' FROM jsonb_array_elements(res->'transitions_refused') WITH ORDINALITY y(x,o) WHERE o=12)
  = 'replaced_by is the item_key of an earlier note, on a superseded move only', 'replaced_by on a close has its own detail');
 -- The copies: superseded as of their own opening, nothing cited, the move naming the earlier note; the earlier stays.
 PERFORM pg_temp.rb_assert((SELECT bool_and(i.status='superseded' AND i.closed_at=i.opened_at AND i.closed_by IS NULL)
  FROM public.context_ledger_items i WHERE i.generation_id=gen AND i.item_key IN ('commitment:promise','request:ask-again'))
  AND (SELECT count(*) FROM public.context_ledger_items i WHERE i.generation_id=gen AND i.item_key IN ('commitment:promise','request:ask-again'))=2,
  'a retired copy closes as of its own opening');
 PERFORM pg_temp.rb_assert((SELECT array_agg(i.item_key||'>'||t.replaced_by_key||' '||t.from_status||'>'||t.to_status||' '||t.by||' '||t.reason
   ||' '||coalesce(t.evidence::text,'none') ORDER BY i.item_key)
  FROM public.context_ledger_transitions t JOIN public.context_ledger_items i ON i.id=t.item_id WHERE t.generation_id=gen AND t.replaced_by_key IS NOT NULL)
  = ARRAY['commitment:promise>request:ask open>superseded model:luna-ledger:v8 '||dup||' none','request:ask-again>request:ask open>superseded model:luna-ledger:v8 '||dup||' none'],
  'each move names the note it repeats');
 PERFORM pg_temp.rb_assert((SELECT status='open' AND closed_at IS NULL FROM public.context_ledger_items WHERE generation_id=gen AND item_key='request:ask')
  AND NOT EXISTS (SELECT 1 FROM public.context_ledger_transitions t JOIN public.context_ledger_items i ON i.id=t.item_id WHERE i.generation_id=gen AND i.item_key='request:ask'),
  'the earlier note stays as it was');
 PERFORM pg_temp.rb_assert((SELECT count(*) FROM public.context_ledger_items WHERE generation_id=gen AND status='open'
  AND item_key IN ('request:pay-inv-2','request:pay-inv-1-builder','request:fix-latch','request:from-unknown-b','request:mid','request:spare','request:orphan'))=7,
  'a refused move changes nothing');
 -- Every other move as before: a replaced note closes when its replacement opened; a close on a later row.
 PERFORM pg_temp.rb_assert((SELECT status='superseded' AND closed_at='2026-09-07'::timestamptz FROM public.context_ledger_items WHERE generation_id=gen AND item_key='request:old-target'),
  'a superseded move with its replacement, as before');
 PERFORM pg_temp.rb_assert((SELECT status='closed' AND closed_at='2026-09-08'::timestamptz AND closed_by->0->>'id'=ev_reply::text
  FROM public.context_ledger_items WHERE generation_id=gen AND item_key='request:colour'), 'a close on a later row, as before');
 PERFORM pg_temp.rb_assert((SELECT bool_and(t.replaced_by_key IS NULL) FROM public.context_ledger_transitions t JOIN public.context_ledger_items i ON i.id=t.item_id
  WHERE t.generation_id=gen AND i.item_key IN ('request:old-target','request:colour')), 'every other move names no note');
 -- The same request again returns its first answer and writes nothing.
 SELECT count(*) INTO n FROM public.context_ledger_transitions WHERE generation_id=gen;
 again := public.context_ledger_write(run, tok, gen, '[]', moves, 'luna-ledger:v8');
 PERFORM pg_temp.rb_assert((again->>'replayed')::boolean AND (again-'replayed')=res
  AND (SELECT count(*) FROM public.context_ledger_transitions WHERE generation_id=gen)=n, 'replay');
 -- The record: replaced_by_key only on a superseded move.
 BEGIN
  INSERT INTO public.context_ledger_transitions(item_id,generation_id,job_id,from_status,to_status,by,replaced_by_key)
  SELECT id,gen,j,'open','closed','model:luna-ledger:v8','request:ask' FROM public.context_ledger_items WHERE generation_id=gen AND item_key='request:spare';
  RAISE EXCEPTION 'replaced by contract: a close stored replaced_by_key';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 -- The guard on its own.
 PERFORM pg_temp.rb_assert(public.context_ledger_same_loop(a,b) AND NOT public.context_ledger_same_loop(a,c) AND NOT public.context_ledger_same_loop(c,d),
  'context_ledger_same_loop')
 FROM (SELECT (SELECT i FROM public.context_ledger_items i WHERE generation_id=gen AND item_key='request:ask') a,
  (SELECT i FROM public.context_ledger_items i WHERE generation_id=gen AND item_key='commitment:promise') b,
  (SELECT i FROM public.context_ledger_items i WHERE generation_id=gen AND item_key='issue:latch') c,
  (SELECT i FROM public.context_ledger_items i WHERE generation_id=gen AND item_key='request:pay-inv-1') d) x;
 PERFORM pg_temp.rb_assert(NOT has_function_privilege('anon','public.context_ledger_same_loop(public.context_ledger_items,public.context_ledger_items)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.context_ledger_same_loop(public.context_ledger_items,public.context_ledger_items)','EXECUTE')
  AND has_function_privilege('service_role','public.context_ledger_same_loop(public.context_ledger_items,public.context_ledger_items)','EXECUTE'),
  'the guard is service role only');
END $$;
-- The undo refuses while a move names the note it repeats, and changes nothing.
SAVEPOINT before_undo;
\set ON_ERROR_STOP off
\ir ../../../rollbacks/20261104050000_context_ledger_replaced_by_down.sql
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT before_undo;
DO $$ BEGIN
 PERFORM pg_temp.rb_assert(md5(pg_get_functiondef('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)'::regprocedure)) = 'af7c768f7ef2d3e8b45bb0706a485194'
  AND EXISTS (SELECT 1 FROM public.context_ledger_transitions WHERE replaced_by_key IS NOT NULL)
  AND to_regprocedure('public.context_ledger_same_loop(public.context_ledger_items,public.context_ledger_items)') IS NOT NULL,
  'the undo must refuse while a move names a note');
END $$;
ROLLBACK;
