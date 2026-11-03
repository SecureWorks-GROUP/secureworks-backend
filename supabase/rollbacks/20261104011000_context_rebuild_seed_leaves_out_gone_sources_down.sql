-- Undo 20261104011000_context_rebuild_seed_leaves_out_gone_sources: the rebuild packet carries every
-- open item again and refuses the rebuild when one's source is gone
-- (md5 24a300377b1e4f4c01f36fda9b2099c8). Jobs with such a note then fail every rebuild again.
SET LOCAL lock_timeout = '5s';

DO $down$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef('public.context_ledger_rebuild_packet(uuid,uuid)'::regprocedure) INTO v_def;
  IF md5(v_def) = '24a300377b1e4f4c01f36fda9b2099c8' THEN
    RAISE NOTICE 'context_ledger_rebuild_packet is already the old definition';
    RETURN;
  END IF;
  IF md5(v_def) <> 'fc80fa222fedfedf96b38309031d18c4' THEN
    RAISE EXCEPTION 'context_ledger_rebuild_packet is not the 20261104011000 definition (md5 %)', md5(v_def);
  END IF;
  -- The exact definition before 20261104011000 (md5 24a300377b1e4f4c01f36fda9b2099c8), as pg_get_functiondef printed it.
  EXECUTE $old_def$CREATE OR REPLACE FUNCTION public.context_ledger_rebuild_packet(p_run_id uuid, p_lease_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r public.context_extraction_runs; g public.context_ledger_generations;
 prior uuid; s public.context_ledger_items; c jsonb; chk jsonb; v_id uuid;
 packet jsonb; items jsonb; seed_count integer := 0;
BEGIN
 IF p_run_id IS NULL OR p_lease_token IS NULL THEN
  RAISE EXCEPTION 'context_rebuild_invalid';
 END IF;
 -- Same custody/lock order as the existing writer; no live generation is edited.
 SELECT * INTO r FROM public.context_extraction_runs WHERE id = p_run_id FOR UPDATE;
 IF r.id IS NULL OR r.phase <> 'ledger' OR r.lease_token IS DISTINCT FROM p_lease_token
    OR r.status <> 'running' OR r.lease_expires_at IS NULL OR r.lease_expires_at <= now() THEN
  RAISE EXCEPTION 'context_rebuild_lease_lost';
 END IF;
 IF NOT public.automation_lane_enabled('extraction')
    OR coalesce((SELECT mode FROM public.context_ledger_settings WHERE id), 'off') = 'off' THEN
  RAISE EXCEPTION 'context_rebuild_off';
 END IF;
 SELECT * INTO g FROM public.context_ledger_generations
 WHERE run_id = r.id AND job_id = r.job_id AND status = 'building' AND kind = 'rebuild' FOR UPDATE;
 IF g.id IS NULL THEN RAISE EXCEPTION 'context_rebuild_generation_mismatch'; END IF;

 IF NOT (g.checks ? 'rebuild_seed') THEN
  IF EXISTS (SELECT 1 FROM public.context_ledger_writes WHERE generation_id = g.id)
     OR EXISTS (SELECT 1 FROM public.context_ledger_items WHERE generation_id = g.id) THEN
   RAISE EXCEPTION 'context_rebuild_already_written';
  END IF;
  prior := public.context_ledger_current_generation(r.job_id);
  -- Serialize the source snapshot with existing person/store writes. The packet
  -- below uses this seeded generation, never a later selection of live notes.
  PERFORM 1 FROM public.context_ledger_generations WHERE id = prior FOR SHARE;
  FOR s IN SELECT * FROM public.context_ledger_items
   WHERE generation_id = prior AND (person_locked OR status IN ('open','disputed','info'))
   ORDER BY opened_at, item_key COLLATE "C" FOR SHARE LOOP
   INSERT INTO public.context_ledger_items
    (generation_id,job_id,item_key,item_type,status,from_role,from_name,to_role,to_name,
     what,about_key,modality,phase,due_date,due_basis,opened_at,opened_by,closed_at,closed_by,
     closes_on,supersedes_key,blocks,needs_reply,also_concerns,written_by,person_locked)
   VALUES (g.id,s.job_id,s.item_key,s.item_type,s.status,s.from_role,s.from_name,s.to_role,s.to_name,
     s.what,s.about_key,s.modality,s.phase,s.due_date,s.due_basis,s.opened_at,s.opened_by,s.closed_at,s.closed_by,
     s.closes_on,s.supersedes_key,s.blocks,s.needs_reply,s.also_concerns,s.written_by,s.person_locked)
   RETURNING id INTO v_id;
   INSERT INTO public.context_ledger_transitions
    (item_id,generation_id,job_id,from_status,to_status,by,evidence,reason)
   VALUES (v_id,g.id,r.job_id,NULL,s.status,'rule:rebuild_seed',s.opened_by,
     'Preserved from the previous reading without a new decision');
   seed_count := seed_count + 1;
  END LOOP;
  UPDATE public.context_ledger_generations SET checks = checks || jsonb_build_object('rebuild_seed',
   jsonb_build_object('source_generation_id',prior,'items',seed_count,'captured_at',now())), updated_at = now()
  WHERE id = g.id;
 END IF;

 -- Recheck on retries too: a source may have been moved/retracted after the
 -- first preparation. An exception rolls back a first seed in its entirety.
 -- Person corrections remain the person's authority.
 FOR s IN SELECT * FROM public.context_ledger_items
  WHERE generation_id = g.id AND NOT person_locked AND status IN ('open','disputed','info') LOOP
  FOR c IN SELECT value FROM jsonb_array_elements(s.opened_by) LOOP
   chk := public.context_ledger_cite(r.job_id, c);
   IF NOT coalesce((chk ->> 'ok')::boolean, false) THEN
    chk := public.context_ledger_held_cite(r.job_id, c);
    IF NOT coalesce((chk ->> 'ok')::boolean, false) THEN
     RAISE EXCEPTION 'context_rebuild_prior_source_unresolved: %', s.item_key;
    END IF;
   END IF;
  END LOOP;
 END LOOP;
 packet := public.context_ledger_packet(r.job_id, NULL, r.started_at);
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'item_key',i.item_key,'item_type',i.item_type,'status',i.status,'what',i.what,
  'about_key',i.about_key,'phase',i.phase,'from_role',i.from_role,'to_role',i.to_role,
  'opened_at',i.opened_at,'closes_on',i.closes_on,'needs_reply',i.needs_reply,
  'opened_by',i.opened_by,'person_locked',i.person_locked)
  || CASE WHEN i.job_not_certain AND public.context_ledger_item_held_now(r.job_id,i.opened_by,r.started_at)
     THEN jsonb_build_object('job_certain',false,'certainty','job_not_certain') ELSE '{}'::jsonb END
  ORDER BY i.opened_at,i.item_key COLLATE "C"),'[]'::jsonb)
 INTO items FROM public.context_ledger_items i
 WHERE i.generation_id = g.id AND (i.person_locked OR i.status IN ('open','disputed','info'));
 RETURN packet || jsonb_build_object('open_items',items,'rebuild_generation_id',g.id);
END $function$
$old_def$;
  SELECT pg_get_functiondef('public.context_ledger_rebuild_packet(uuid,uuid)'::regprocedure) INTO v_def;
  IF md5(v_def) <> '24a300377b1e4f4c01f36fda9b2099c8' THEN
    RAISE EXCEPTION 'context_ledger_rebuild_packet after undo is not the old definition (md5 %)', md5(v_def);
  END IF;
END
$down$;

COMMENT ON FUNCTION public.context_ledger_rebuild_packet(uuid,uuid) IS
 'TP-16 (20261030150000): leased rebuild preparation, preserving unresolved item identities and closure predicates before reading. Idempotent seed, same-generation packet, source-invalid refusal, no live note or settings edits. Additive/dormant until a separately accepted reader calls it. A seed is not verification or closure.';
