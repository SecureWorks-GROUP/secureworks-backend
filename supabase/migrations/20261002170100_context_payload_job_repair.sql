-- Repair for rows a contact rule placed on one job while their own payload
-- names another (the payload_job_mismatch class, read-only production check
-- 2 Oct 2026: 26 rows on three jobs, statuses luna and single_open).
--
-- 20261002170000 stops the batch reader handing such rows out, so they no
-- longer fail a job's daily read; they wait, untouched, on the job they were
-- placed on. This migration installs the one reviewed way to move them, and
-- moves nothing itself:
--
--   context_payload_job_mismatch_rows() (read-only) and
--   context_payload_job_repair(p_dry_run default true, p_limit default 500)
--     Select every business_events row with the exact mismatch rule the
--     revision store refuses: job_id set, payload.job_id set, and
--     payload.job_id <> job_id::text. Each is classed:
--       repoint                placed by a contact rule (single_open,
--                              single_line, luna) and payload.job_id is the
--                              exact id text of a job that is not holding
--                              (metadata.do_not_schedule);
--       payload_job_not_found  payload.job_id names no job (stale payload);
--       payload_job_holding    payload.job_id names a holding job, which the
--                              ladder never places on;
--       not_contact_rule       placed by custody, a reference, a thread, a
--                              content reference, a party or by hand;
--       thread_bound_elsewhere a non-GHL row whose email thread is bound to
--                              another job: the ladder's thread rule would
--                              bucket it as thread_conflict on any re-run, so
--                              moving it needs a person to rebind the thread.
--     Only repoint rows are ever moved. Every other class is counted and left
--     for a human, because moving it would overrule stronger evidence than
--     the contact rule that misplaced the repoint rows.
--     Dry run (the default): counts by class and the from/to job pairs
--     (ids only), nothing written; it runs inside a read-only transaction. Real run: each repoint row, locked and
--     re-checked, is placed on its payload job as a direct placement
--     (attribution_status direct, step 1, confidence 1, match_method
--     direct_job_id, the ladder's own labelling of a step-1 placement, with
--     metadata.source_job_binding so a later re-decision keeps it), stamped
--     capture_mode relink (the value before kept in capture_mode_before, so a
--     moved row never wakes a read on its own, cadence 5.1) and
--     metadata.placement_repaired (rule, from job, status, step, confidence,
--     placed time, repair time). Ids and codes only, no message text.
--     A row another session holds is skipped and counted. Idempotent: a moved
--     row no longer matches the rule, so a second run moves nothing.
--     Nothing is deleted and no other table is written (event_threads
--     included).
--
-- Service role only. Runs nothing on apply. Rollback drops both functions:
-- supabase/rollbacks/20261002170100_context_payload_job_repair_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard: the admission rule this repair pairs with is in place,
-- and the repair name is absent or already this migration's body.
DO $guard$
DECLARE problems text[]:='{}'; live text;
BEGIN
 IF to_regprocedure('public.context_event_source_admissible(public.business_events)') IS NULL
 THEN problems:=problems||'public.context_event_source_admissible(business_events) is missing; apply 20261002170000 first'::text; END IF;
 IF to_regprocedure('public.context_event_is_ghl(public.business_events)') IS NULL
 THEN problems:=problems||'public.context_event_is_ghl(business_events) (20260924140000) is missing'::text; END IF;
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.context_payload_job_mismatch_rows()');
 IF live IS NOT NULL AND live<>'3c7759191b5f51dfeaabab87ae2c4cdb' THEN problems:=problems||format('public.context_payload_job_mismatch_rows() md5 %s',live); END IF;
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.context_payload_job_repair(boolean,integer)');
 IF live IS NOT NULL AND live<>'db0412566058df9e27a070472abb5482' THEN problems:=problems||format('public.context_payload_job_repair(boolean,integer) md5 %s',live); END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_payload_job_repair_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The one classification, read-only: every row with the exact mismatch
-- rule, and its class. Usable on its own as the dry-run count query.
CREATE OR REPLACE FUNCTION public.context_payload_job_mismatch_rows()
RETURNS TABLE(id uuid,from_job_id uuid,to_job_id uuid,status text,class text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT b.id,b.job_id,j.id,b.attribution_status,
  CASE
   WHEN b.attribution_status IS NULL OR b.attribution_status NOT IN ('single_open','single_line','luna') THEN 'not_contact_rule'
   WHEN j.id IS NULL THEN 'payload_job_not_found'
   WHEN coalesce(j.metadata->>'do_not_schedule','') IN ('true','1') THEN 'payload_job_holding'
   WHEN nullif(b.thread_key,'') IS NOT NULL AND NOT public.context_event_is_ghl(b)
    AND EXISTS(SELECT 1 FROM public.event_threads t WHERE t.thread_key=b.thread_key AND t.job_id<>j.id) THEN 'thread_bound_elsewhere'
   ELSE 'repoint' END
 FROM public.business_events b
 LEFT JOIN public.jobs j ON j.id::text=b.payload#>>'{job_id}'
 WHERE b.job_id IS NOT NULL AND b.payload#>>'{job_id}' IS NOT NULL AND b.payload#>>'{job_id}'<>b.job_id::text
$$;
COMMENT ON FUNCTION public.context_payload_job_mismatch_rows() IS
 'Rows the revision store refuses as payload_job_mismatch (job_id set, payload.job_id set and different), each classed repoint, payload_job_not_found, payload_job_holding, not_contact_rule or thread_bound_elsewhere (20261002170100). Read-only. Service role only.';

-- 2. The repair.
CREATE OR REPLACE FUNCTION public.context_payload_job_repair(p_dry_run boolean DEFAULT true,p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 c record; e public.business_events; v_now timestamptz:=clock_timestamp(); v_target uuid;
 v_limit int:=greatest(0,least(coalesce(p_limit,500),1000));
 v_counts jsonb; v_pairs jsonb;
 n_moved int:=0; n_busy int:=0; n_changed int:=0; v_truncated boolean:=false;
BEGIN
 IF p_dry_run IS NULL THEN RAISE EXCEPTION 'context_payload_job_repair: p_dry_run must be true or false'; END IF;
 SELECT jsonb_build_object(
   'repoint',count(*) FILTER (WHERE class='repoint'),
   'payload_job_not_found',count(*) FILTER (WHERE class='payload_job_not_found'),
   'payload_job_holding',count(*) FILTER (WHERE class='payload_job_holding'),
   'not_contact_rule',count(*) FILTER (WHERE class='not_contact_rule'),
   'thread_bound_elsewhere',count(*) FILTER (WHERE class='thread_bound_elsewhere'),
   'total',count(*))
  INTO v_counts FROM public.context_payload_job_mismatch_rows();
 SELECT coalesce(jsonb_agg(jsonb_build_object('from_job_id',p.from_job,'to_job_id',p.to_job,'status',p.status,'class',p.class,'rows',p.n)
   ORDER BY p.n DESC,p.from_job,p.to_job,p.status),'[]'::jsonb)
  INTO v_pairs FROM (
   SELECT r.from_job_id AS from_job,r.to_job_id AS to_job,r.status,r.class,count(*) AS n FROM public.context_payload_job_mismatch_rows() r
   GROUP BY 1,2,3,4 ORDER BY count(*) DESC,1,2,3 LIMIT 100) p;

 IF p_dry_run THEN
  RETURN jsonb_build_object('outcome','dry_run','rule','payload_job_mismatch','counts',v_counts,'pairs',v_pairs,
   'limit',v_limit);
 END IF;

 FOR c IN SELECT r.id,r.to_job_id AS to_job FROM public.context_payload_job_mismatch_rows() r WHERE r.class='repoint' ORDER BY r.id LOOP
  IF n_moved+n_busy+n_changed>=v_limit THEN v_truncated:=true; EXIT; END IF;
  SELECT * INTO e FROM public.business_events b WHERE b.id=c.id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN n_busy:=n_busy+1; CONTINUE; END IF;
  -- Re-check the whole rule under the lock: the row may have moved since.
  v_target:=NULL;
  SELECT j.id INTO v_target FROM public.jobs j WHERE j.id::text=e.payload#>>'{job_id}'
   AND coalesce(j.metadata->>'do_not_schedule','') NOT IN ('true','1');
  IF e.job_id IS NULL OR e.payload#>>'{job_id}' IS NULL OR e.payload#>>'{job_id}'=e.job_id::text
   OR e.attribution_status IS NULL OR e.attribution_status NOT IN ('single_open','single_line','luna')
   OR v_target IS DISTINCT FROM c.to_job
   OR (nullif(e.thread_key,'') IS NOT NULL AND NOT public.context_event_is_ghl(e)
    AND EXISTS(SELECT 1 FROM public.event_threads t WHERE t.thread_key=e.thread_key AND t.job_id<>v_target))
  THEN n_changed:=n_changed+1; CONTINUE; END IF;
  UPDATE public.business_events SET
   job_id=v_target,attribution_status='direct',attribution_step=1,attribution_confidence=1,
   attributed_at=v_now,attribution_checked_at=v_now,candidate_job_ids=NULL,
   match_status='matched',match_method='direct_job_id',match_confidence=1,
   metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
    'source_job_binding',jsonb_build_object('job_id',v_target,'match_method','direct_job_id','via','payload_job_id'),
    'placement_rule','payload_job',
    'capture_mode','relink',
    'capture_mode_before',coalesce(metadata->'capture_mode_before',to_jsonb(coalesce(metadata->>'capture_mode','live'))),
    'placement_repaired',jsonb_build_object('rule','payload_job_mismatch','by','context_payload_job_repair','at',v_now,
     'from_job_id',e.job_id,'from_status',e.attribution_status,'from_step',e.attribution_step,
     'from_confidence',e.attribution_confidence,'from_attributed_at',e.attributed_at))
  WHERE id=e.id;
  n_moved:=n_moved+1;
 END LOOP;
 RETURN jsonb_build_object('outcome','done','rule','payload_job_mismatch','counts',v_counts,'pairs',v_pairs,
  'moved',n_moved,'skipped_busy',n_busy,'changed_meanwhile',n_changed,
  'truncated',v_truncated,'limit',v_limit);
END $$;
COMMENT ON FUNCTION public.context_payload_job_repair(boolean,integer) IS
 'Repair for the payload_job_mismatch class (20261002170100): dry run by default (counts by class and from/to job pairs, ids only). A real run moves only rows placed by a contact rule (single_open, single_line, luna) whose payload.job_id is a non-holding job and whose email thread is not bound to another job, as a direct placement stamped placement_repaired and capture_mode relink. Never deletes. Service role only.';

REVOKE ALL ON FUNCTION public.context_payload_job_mismatch_rows(),public.context_payload_job_repair(boolean,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_payload_job_mismatch_rows(),public.context_payload_job_repair(boolean,integer) TO service_role;
