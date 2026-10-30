-- TP-16 bounded operator recovery into an already claimed BUILDING rebuild.
-- Loading this file defines only a session-local helper; it executes no repair.
-- There is no permanent API, schedule, setting, live-note edit or financial write.
-- Use only after review of the exact source manifest and authorized rollout of
-- context_ledger_rebuild_packet. Run inside BEGIN/ROLLBACK first. A real COMMIT
-- needs the existing production authority. The normal reader must still read,
-- validate and finish this generation; this operation never promotes it.
-- Request: {run_id,lease_token,source_generation_id,expected_live_generation_id,
--           items:[{key,row_md5}]}. Hash source rows with SET LOCAL timezone='UTC'
-- and SELECT md5(to_jsonb(i)::text) FROM context_ledger_items i ... .
CREATE OR REPLACE FUNCTION pg_temp.context_recover_rebuild_items(p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp SET timezone='UTC' AS $$
DECLARE r public.context_extraction_runs; g public.context_ledger_generations;
 source_gen public.context_ledger_generations; live_gen public.context_ledger_generations;
 s public.context_ledger_items; n public.context_ledger_items; wanted jsonb; cite jsonb;
 request_hash text; replay boolean:=false; copied integer:=0; v_id uuid; packet jsonb;
BEGIN
 IF jsonb_typeof(p_request) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_request->'items') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_request->'items') NOT BETWEEN 1 AND 20
    OR (SELECT count(DISTINCT x->>'key') FROM jsonb_array_elements(p_request->'items') x)<>jsonb_array_length(p_request->'items')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_request->'items') x
       WHERE nullif(x->>'key','') IS NULL OR coalesce(x->>'row_md5','') !~ '^[0-9a-f]{32}$') THEN
  RAISE EXCEPTION 'context_recovery_invalid_request';
 END IF;
 request_hash:=md5(p_request::text);
 -- Run -> building generation -> current generation follows normal store custody.
 SELECT * INTO r FROM public.context_extraction_runs WHERE id=(p_request->>'run_id')::uuid FOR UPDATE;
 IF r.id IS NULL OR r.phase<>'ledger' OR r.status<>'running'
    OR r.lease_token IS DISTINCT FROM (p_request->>'lease_token')::uuid
    OR r.lease_expires_at IS NULL OR r.lease_expires_at<=now() THEN
  RAISE EXCEPTION 'context_recovery_lease_lost';
 END IF;
 SELECT * INTO g FROM public.context_ledger_generations WHERE run_id=r.id AND job_id=r.job_id AND kind='rebuild' AND status='building' FOR UPDATE;
 IF g.id IS NULL THEN RAISE EXCEPTION 'context_recovery_not_building_rebuild'; END IF;
 SELECT * INTO live_gen FROM public.context_ledger_generations WHERE id=public.context_ledger_current_generation(r.job_id) FOR UPDATE;
 IF live_gen.id IS NULL OR live_gen.status<>'live' OR live_gen.id IS DISTINCT FROM (p_request->>'expected_live_generation_id')::uuid THEN
  RAISE EXCEPTION 'context_recovery_live_generation_changed';
 END IF;
 SELECT * INTO source_gen FROM public.context_ledger_generations WHERE id=(p_request->>'source_generation_id')::uuid FOR SHARE;
 IF source_gen.id IS NULL OR source_gen.job_id<>r.job_id OR source_gen.status<>'retired'
    OR source_gen.promoted_at IS NULL OR live_gen.promoted_at IS NULL
    OR source_gen.promoted_at>=live_gen.promoted_at THEN
  RAISE EXCEPTION 'context_recovery_source_generation_invalid';
 END IF;
 -- Seed ordinary live obligations first. This also enforces lane, lease and
 -- same-generation source checks. An exception rolls back this entire statement.
 packet:=public.context_ledger_rebuild_packet(r.id,r.lease_token);
 SELECT * INTO g FROM public.context_ledger_generations WHERE id=g.id;
 IF g.checks#>>'{rebuild_seed,source_generation_id}' IS DISTINCT FROM live_gen.id::text THEN
  RAISE EXCEPTION 'context_recovery_seed_generation_changed';
 END IF;
 IF g.checks ? 'historical_recovery' THEN
  IF g.checks#>>'{historical_recovery,request_hash}' IS DISTINCT FROM request_hash THEN
   RAISE EXCEPTION 'context_recovery_manifest_changed';
  END IF;
  replay:=true;
 END IF;
 IF NOT replay AND EXISTS(SELECT 1 FROM public.context_ledger_writes WHERE generation_id=g.id) THEN
  RAISE EXCEPTION 'context_recovery_model_already_written';
 END IF;
 FOR wanted IN SELECT x FROM jsonb_array_elements(p_request->'items') x ORDER BY x->>'key' LOOP
  SELECT * INTO s FROM public.context_ledger_items WHERE generation_id=source_gen.id AND item_key=wanted->>'key' FOR SHARE;
  IF s.id IS NULL OR md5(to_jsonb(s)::text) IS DISTINCT FROM wanted->>'row_md5' THEN
   RAISE EXCEPTION 'context_recovery_source_changed: %',wanted->>'key';
  END IF;
  IF s.person_locked OR s.written_by NOT LIKE 'model:%' OR s.status NOT IN ('open','disputed') OR s.closes_on='payment'
     OR jsonb_array_length(s.opened_by)=0 THEN
   RAISE EXCEPTION 'context_recovery_not_unresolved_nonpayment: %',s.item_key;
  END IF;
  IF NOT replay AND EXISTS(SELECT 1 FROM public.context_ledger_items WHERE generation_id=g.id AND item_key=s.item_key) THEN
   RAISE EXCEPTION 'context_recovery_already_present: %',s.item_key;
  END IF;
  -- Never override a later exact decision, explicit replacement, person decision
  -- or potentially equivalent obligation. A closed model PAYMENT from the same
  -- opening message does not dispose of a distinct REPLY request.
  FOR n IN SELECT i.* FROM public.context_ledger_items i
   JOIN public.context_ledger_generations newer ON newer.id=i.generation_id
   WHERE i.job_id=r.job_id AND newer.status IN ('live','retired') AND newer.promoted_at>source_gen.promoted_at
    AND (i.item_key=s.item_key OR i.supersedes_key=s.item_key
      OR (i.person_locked AND (i.about_key=s.about_key OR i.opened_by->0->>'id'=s.opened_by->0->>'id'))
      OR (i.about_key=s.about_key AND i.item_type=s.item_type AND i.closes_on IS NOT DISTINCT FROM s.closes_on)
      OR i.opened_by->0->>'id'=s.opened_by->0->>'id') FOR SHARE OF i LOOP
   IF NOT (n.item_key<>s.item_key AND n.supersedes_key IS DISTINCT FROM s.item_key AND NOT n.person_locked
     AND s.item_type='request' AND s.closes_on='reply' AND n.item_type='request' AND n.closes_on='payment' AND n.status='closed') THEN
    RAISE EXCEPTION 'context_recovery_later_decision_or_duplicate: %',s.item_key;
   END IF;
  END LOOP;
  FOR cite IN SELECT x FROM jsonb_array_elements(s.opened_by) x LOOP
   IF cite->>'table'='business_events' THEN
    PERFORM 1 FROM public.business_events WHERE id=(cite->>'id')::uuid FOR SHARE;
   ELSIF cite->>'table'='inbox_events' THEN
    PERFORM 1 FROM public.inbox_events WHERE id=(cite->>'id')::uuid FOR SHARE;
   ELSE RAISE EXCEPTION 'context_recovery_unsupported_opening_source: %',s.item_key;
   END IF;
   IF NOT coalesce((public.context_ledger_cite(r.job_id,cite)->>'ok')::boolean,false) THEN
    RAISE EXCEPTION 'context_recovery_source_not_currently_placed: %',s.item_key;
   END IF;
  END LOOP;
  IF replay THEN
   IF NOT EXISTS(SELECT 1 FROM public.context_ledger_items WHERE generation_id=g.id AND item_key=s.item_key) THEN
    RAISE EXCEPTION 'context_recovery_prepared_item_missing: %',s.item_key;
   END IF;
   CONTINUE; -- Revalidate, never reseed an item that the reader has since closed.
  END IF;
  INSERT INTO public.context_ledger_items
   (generation_id,job_id,item_key,item_type,status,from_role,from_name,to_role,to_name,
    what,about_key,modality,phase,due_date,due_basis,opened_at,opened_by,closed_at,closed_by,
    closes_on,supersedes_key,blocks,needs_reply,also_concerns,written_by,person_locked)
  VALUES(g.id,s.job_id,s.item_key,s.item_type,s.status,s.from_role,s.from_name,s.to_role,s.to_name,
    s.what,s.about_key,s.modality,s.phase,s.due_date,s.due_basis,s.opened_at,s.opened_by,s.closed_at,s.closed_by,
    s.closes_on,s.supersedes_key,s.blocks,s.needs_reply,s.also_concerns,s.written_by,s.person_locked)
  RETURNING id INTO v_id;
  INSERT INTO public.context_ledger_transitions(item_id,generation_id,job_id,from_status,to_status,by,evidence,reason)
  VALUES(v_id,g.id,r.job_id,NULL,s.status,'rule:historical_recovery',s.opened_by,
    'Recovered omitted unresolved item from retired generation '||source_gen.id::text||'; requires normal reader reconciliation');
  copied:=copied+1;
 END LOOP;
 IF replay THEN RETURN packet||jsonb_build_object('historical_recovery_replayed',true); END IF;
 UPDATE public.context_ledger_generations SET checks=checks||jsonb_build_object('historical_recovery',
  jsonb_build_object('request_hash',request_hash,'source_generation_id',source_gen.id,'expected_live_generation_id',live_gen.id,
    'items',p_request->'items','copied',copied,'at',now())),updated_at=now() WHERE id=g.id;
 RETURN public.context_ledger_rebuild_packet(r.id,r.lease_token)||jsonb_build_object('historical_recovery_copied',copied,'historical_recovery_replayed',false);
END $$;


-- Use this completion path for the recovery operation, never an unguarded
-- context_ledger_finish call or a handoff to an ordinary asynchronous worker.
-- It locks/rechecks current staff decisions, source rows/citations and finance
-- immediately before the normal finish, in the SAME SQL statement/transaction.
CREATE OR REPLACE FUNCTION pg_temp.context_recover_rebuild_finish(p_request jsonb,p_meta jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp SET timezone='UTC' AS $$
DECLARE packet jsonb; g public.context_ledger_generations; m jsonb; result jsonb;
BEGIN
 packet:=pg_temp.context_recover_rebuild_items(p_request);
 SELECT * INTO g FROM public.context_ledger_generations WHERE id=(packet->>'rebuild_generation_id')::uuid FOR UPDATE;
 IF jsonb_typeof(p_meta->'checks') IS DISTINCT FROM 'object'
   OR p_meta#>>'{checks,financial_signature}' IS DISTINCT FROM public.context_ledger_record_signature(g.job_id) THEN
  RAISE EXCEPTION 'context_recovery_financial_snapshot_changed';
 END IF;
 m:=jsonb_set(p_meta,'{checks}',(p_meta->'checks')||jsonb_build_object('historical_recovery',g.checks->'historical_recovery'));
 result:=public.context_ledger_finish((p_request->>'run_id')::uuid,(p_request->>'lease_token')::uuid,g.id,'built',m);
 IF result->>'outcome'<>'built' OR NOT coalesce((result->>'passed')::boolean,false) THEN
  RAISE EXCEPTION 'context_recovery_finish_refused: %',result;
 END IF;
 RETURN result;
END $$;
