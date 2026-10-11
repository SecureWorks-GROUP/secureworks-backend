-- Runs after supabase/rollbacks/20261011100000_context_story_lead_rank_down.sql on the stack applied
-- through this case: 20261009133000's assembler body and comment are back word for word, with the
-- same access, and the oldest open loop leads again.
DO $restored$
DECLARE sig text := 'public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)'; live text; s jsonb;
BEGIN
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(sig);
 IF live IS DISTINCT FROM '0612faee09a436d9f971ff8477e13f1d' THEN
  RAISE EXCEPTION 'story lead rank rollback: assembler md5 % (want 0612faee09a436d9f971ff8477e13f1d)', coalesce(live, '<missing>');
 END IF;
 IF coalesce(obj_description(to_regprocedure(sig), 'pg_proc'), '') LIKE '%story lead rank%'
    OR coalesce(obj_description(to_regprocedure(sig), 'pg_proc'), '') NOT LIKE
       'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000): (lead cutoff, 20261007010000) (scoping pipeline, 20261009133000)%' THEN
  RAISE EXCEPTION 'story lead rank rollback: the assembler comment is not the earlier one';
 END IF;
 IF has_function_privilege('anon', sig, 'EXECUTE') OR has_function_privilege('authenticated', sig, 'EXECUTE')
    OR NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
  RAISE EXCEPTION 'story lead rank rollback: access wrong';
 END IF;
 s := public.context_job_story_assemble('{"id":"x","status":"in_progress","type":"fencing","created_at":"2026-09-22T00:00:00Z"}', '{}'::jsonb,
   jsonb_build_object('status', 'live', 'generation', jsonb_build_object('id', 'g1', 'status', 'live'), 'unread_rows', 0, 'items', jsonb_build_array(
     jsonb_build_object('item_key', 'o', 'item_type', 'request', 'status', 'open', 'from_role', 'customer', 'to_role', 'us', 'what', 'older',
                        'about_key', 'quote:x', 'opened_at', '2026-10-01T02:00:00Z', 'cites_ok', true, 'opened_by', '[]'::jsonb),
     jsonb_build_object('item_key', 'n', 'item_type', 'request', 'status', 'open', 'from_role', 'customer', 'to_role', 'us', 'what', 'newer',
                        'about_key', 'quote:x', 'opened_at', '2026-10-03T02:00:00Z', 'cites_ok', true, 'opened_by', '[]'::jsonb))),
   NULL, '2026-10-11T04:00:00Z', NULL);
 IF s->'now'->'next'->>'what' IS DISTINCT FROM 'older' THEN
  RAISE EXCEPTION 'story lead rank rollback: the oldest open loop should lead again: %', s->'now';
 END IF;
END $restored$;
