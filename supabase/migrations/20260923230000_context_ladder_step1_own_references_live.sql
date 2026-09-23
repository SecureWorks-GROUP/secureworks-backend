-- L1 (context build plan, Wave 1; audit C5; sms.md prerequisite P0), built on the
-- LIVE production body. The first attempt (20260923120000, PR 880, reverted in
-- PR 886) guarded on the repository body and refused on production: the live
-- resolve_context_attribution is the 20260911171000 body with its five comment
-- lines stripped (md5(prosrc) e6d5a8ec5ab942dff7f288d579d1b8f4, read from production 23 Sep 2026).
-- Behaviour is identical; only comments differ.
--
-- Ladder step 1 links a message directly to a job when its words name exactly one
-- of our references. Until now "reference" meant ANY xero_invoices.invoice_number,
-- supplier bills included. Supplier bills are numbered "10", "21", "07", and short
-- bill numbers sit on the holding job SWF-PDF-BUCKET, so "see you on the 21 Sep"
-- or "$5,478" linked customer texts directly to that holding job (audit C5).
--
-- Step 1 now matches only, each as a whole token of at least 5 characters:
--  * our job numbers (jobs.job_number);
--  * ACCREC invoice numbers starting INV- (never supplier bills, never credit notes);
--  * purchase order numbers (purchase_orders.po_number);
-- and never a reference whose job is a holding job (metadata.do_not_schedule).
-- A verified writer job id (explicit source custody) is unchanged. Every other
-- line of the body is byte-identical to the live body, and the body carries no
-- comments (like the live one), so md5(prosrc) is the same however it is applied.
--
-- No row is rewritten here. Rows already on the holding job stay until the
-- separate, logged re-run of the holding-job rows (audit C5 second half).
-- Rollback: supabase/rollbacks/20260923230000_context_ladder_step1_own_references_live_down.sql restores the live body byte for byte.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Pre-image guard. Accepted bodies:
--  e6d5a8ec5ab942dff7f288d579d1b8f4  the live production body (first apply in production);
--  9214e779cf7d19c69327171c640bba95  the 20260911171000 repository body, which differs from the live body
--          only by five comment lines (first apply on a database built from the
--          repository migrations);
--  acb80ebe792beeb7e5b537643bf9f184  this migration's body (re-apply).
-- Anything else refuses rather than silently reverting a live change.
DO $guard$
DECLARE live_md5 text;
BEGIN
 SELECT md5(p.prosrc) INTO live_md5 FROM pg_proc p
 WHERE p.oid=to_regprocedure('public.resolve_context_attribution(public.business_events)');
 IF live_md5 IS NULL
  OR live_md5 NOT IN ('e6d5a8ec5ab942dff7f288d579d1b8f4','9214e779cf7d19c69327171c640bba95','acb80ebe792beeb7e5b537643bf9f184') THEN
  RAISE EXCEPTION 'context_ladder_preimage_mismatch: live resolve_context_attribution md5 % is not the production body, the 20260911171000 body or this migration body; read the live definition before replacing it', coalesce(live_md5,'<missing>');
 END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.resolve_context_attribution(e public.business_events) RETURNS public.business_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE words text; tokens text; ids uuid[]; candidate uuid; n int; line text; contact_ids text[]; prior_status text; source_method text;
BEGIN
 prior_status:=e.attribution_status;
 source_method:=e.match_method;
 IF e.job_id IS NOT NULL AND source_method IN ('direct_job_id','direct_reference','manual') THEN
   e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('source_job_binding',jsonb_build_object('job_id',e.job_id,'match_method',source_method));
 ELSIF e.job_id IS NULL AND e.metadata->'source_job_binding'->>'match_method' IN ('direct_job_id','direct_reference','manual') THEN
   SELECT id INTO e.job_id FROM public.jobs WHERE id::text=e.metadata->'source_job_binding'->>'job_id';
   source_method:=e.metadata->'source_job_binding'->>'match_method';
 END IF;
 IF e.job_id IS NOT NULL AND coalesce(source_method,'none') NOT IN ('direct_job_id','direct_reference','manual') THEN
   e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('attribution_hint',jsonb_build_object('job_id',e.job_id,'match_method',source_method,'match_confidence',e.match_confidence));
   e.job_id:=NULL;
 END IF;
 e.attribution_checked_at:=clock_timestamp();
 words:=public.context_event_text(e);
 e.attribution_status:='admin_bucket'; e.attribution_step:=6;
 e.attribution_confidence:=NULL; e.attributed_at:=NULL;
 e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
 IF NOT public.automation_lane_enabled('attribution') THEN e.job_id:=NULL; RETURN e; END IF;
 IF to_jsonb(e)->>'channel' IN ('system','audit') THEN e.attribution_status:='automated'; RETURN e; END IF;
 IF btrim(words)='' THEN e.attribution_status:='empty'; RETURN e; END IF;
 IF prior_status='automated' OR e.payload->>'automated'='true' OR e.payload->>'auto_submitted' IN ('auto-generated','auto-replied')
 THEN e.attribution_status:='automated'; RETURN e; END IF;
 SELECT id INTO candidate FROM public.jobs WHERE id=e.job_id;
 IF candidate IS NULL THEN
   tokens:=' '||upper(regexp_replace(words,'[^a-zA-Z0-9-]+',' ','g'))||' ';
   SELECT array_agg(DISTINCT refs.job_id) INTO ids FROM (
     SELECT j.id AS job_id FROM public.jobs j WHERE length(btrim(j.job_number))>=5
      AND strpos(tokens,' '||upper(j.job_number)||' ')>0
     UNION SELECT x.job_id FROM public.xero_invoices x WHERE x.job_id IS NOT NULL
      AND x.invoice_type='ACCREC' AND upper(x.invoice_number) LIKE 'INV-%' AND length(btrim(x.invoice_number))>=5
      AND strpos(tokens,' '||upper(x.invoice_number)||' ')>0
     UNION SELECT po.job_id FROM public.purchase_orders po WHERE po.job_id IS NOT NULL AND length(btrim(po.po_number))>=5
      AND strpos(tokens,' '||upper(po.po_number)||' ')>0
   ) refs JOIN public.jobs ref_job ON ref_job.id=refs.job_id
   WHERE coalesce(to_jsonb(ref_job)->'metadata'->>'do_not_schedule','') NOT IN ('true','1');
   IF cardinality(ids)=1 THEN candidate:=ids[1];
   ELSIF cardinality(ids)>1 THEN e.job_id:=NULL; RETURN e; END IF;
 END IF;
 IF candidate IS NOT NULL THEN e.attribution_status:='direct'; e.attribution_step:=1;
 ELSE
  SELECT job_id INTO candidate FROM public.event_threads WHERE thread_key=e.thread_key;
  IF candidate IS NOT NULL THEN e.attribution_status:='thread'; e.attribution_step:=2;
  ELSE
   IF e.contact_id IS NULL THEN
    SELECT array_agg(DISTINCT j.ghl_contact_id) INTO contact_ids FROM public.jobs j
    WHERE j.ghl_contact_id IS NOT NULL AND (
      (nullif(e.payload->>'email','') IS NOT NULL AND lower(to_jsonb(j)->>'client_email')=lower(e.payload->>'email')) OR
      (length(regexp_replace(coalesce(e.payload->>'phone',''),'[^0-9]','','g'))>=8 AND
       right(regexp_replace(coalesce(to_jsonb(j)->>'client_phone',to_jsonb(j)->>'phone',''),'[^0-9]','','g'),9)=right(regexp_replace(e.payload->>'phone','[^0-9]','','g'),9)));
    IF cardinality(contact_ids)=1 THEN e.contact_id:=contact_ids[1]; END IF;
   END IF;
   SELECT array_agg(id) INTO ids FROM public.context_contact_jobs(e.contact_id);
   n:=coalesce(cardinality(ids),0);
   IF n=1 THEN candidate:=ids[1]; e.attribution_status:='single_open'; e.attribution_step:=3;
   ELSIF n>1 THEN
    line:=lower(coalesce(e.payload->>'line',e.payload->>'business_line',''));
    SELECT array_agg(id) INTO ids FROM public.context_contact_jobs(e.contact_id) WHERE type::text=line AND line IN ('fencing','patio');
    IF cardinality(ids)=1 THEN candidate:=ids[1]; e.attribution_status:='single_line'; e.attribution_step:=4;
    ELSE e.attribution_status:='pending_luna'; e.attribution_step:=5; END IF;
   END IF;
  END IF;
 END IF;
 e.job_id:=candidate;
 IF candidate IS NOT NULL THEN
  IF nullif(e.thread_key,'') IS NOT NULL THEN
   INSERT INTO public.event_threads(thread_key,job_id,bound_by,source_event_id) VALUES(e.thread_key,candidate,'ladder',e.id) ON CONFLICT DO NOTHING;
   IF NOT EXISTS (SELECT 1 FROM public.event_threads WHERE thread_key=e.thread_key AND job_id=candidate) THEN
    e.job_id:=NULL; e.attribution_status:='admin_bucket'; e.attribution_step:=6;
    e.payload:=coalesce(e.payload,'{}')||jsonb_build_object('attribution_error','thread_conflict'); RETURN e;
   END IF;
  END IF;
  e.attribution_confidence:=1; e.attributed_at:=clock_timestamp();
  e.match_status:='matched'; e.match_method:=CASE WHEN e.attribution_status='direct' THEN 'direct_job_id' ELSE 'contact_id' END; e.match_confidence:=1;
 ELSE e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
 END IF;
 RETURN e;
EXCEPTION WHEN OTHERS THEN
 e.job_id:=NULL; e.attribution_status:='admin_bucket'; e.attribution_step:=6;
 e.attribution_confidence:=NULL; e.attributed_at:=NULL;
 e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
 e.payload:=coalesce(e.payload,'{}')||jsonb_build_object('attribution_error',SQLERRM);
 RETURN e;
END $$;
-- CREATE OR REPLACE keeps the existing ACL; restate it. The trigger calls this
-- function as its owner, so no role needs EXECUTE.
REVOKE ALL ON FUNCTION public.resolve_context_attribution(public.business_events) FROM PUBLIC,anon,authenticated;
