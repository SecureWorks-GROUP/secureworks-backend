-- FU26.0: the original entry points stay byte-identical until explicit install.
-- No switch, trigger, timer or cache is enabled by this migration.
-- Version uses the current rework timestamp after main's latest, rule 19.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- The direct lane reuses context_story_trade_lines_job. These two expression
-- indexes mirror the resolver's other two coordinates, not a new identity rule.
CREATE INDEX IF NOT EXISTS context_story_trade_line_number
 ON public.trade_invoice_lines ((nullif(btrim(job_number),'')));
CREATE INDEX IF NOT EXISTS context_story_trade_description_number
 ON public.trade_invoice_lines ((nullif(substring(upper(coalesce(description,''))
 FROM '(SWMS-[0-9]+|SWG-[0-9]+|SWF-[0-9]+|SWP-[0-9]+|BWCWA[0-9]+|AJBR-[0-9]+|MLB-[0-9]+)'),'')));
-- No equivalent matched-PO index exists on main. idx_po_job already serves POs.
CREATE INDEX IF NOT EXISTS context_story_actual_fact_po
 ON public.job_materials_facts(matched_po_id) WHERE kind='actual';

CREATE OR REPLACE FUNCTION public.context_story_book_costs(p_job_id uuid)
RETURNS TABLE(party text,amount_ex numeric,source text,is_actual boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
/* function block */ BEGIN
 -- Fail back to main if a later release changes either source. No cached truth.
 -- feature_flags_pkey and the singleton PK serve this cutover probe.
 IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass,true))<>'c2e9632718dfa057703f1ee36b97322e'
 OR md5(pg_get_viewdef('public.v_job_cost_events_legacy'::regclass,true))<>'b48997c55913ce3c90e3a3c947533fd3'
 OR md5(pg_get_viewdef('public.v_trade_charge_resolved'::regclass,true))<>'d12b26e9e288b558a79aee827c196470'
 OR (EXISTS(SELECT 1 FROM public.feature_flags f WHERE f.flag_name='job_cost_events_from_cost_lines_v1' AND f.enabled)
  AND EXISTS(SELECT 1 FROM public.job_cost_events_cutover c WHERE c.singleton AND c.completed_at IS NOT NULL)) THEN
  RAISE EXCEPTION 'story_book_source_changed';
 END IF;
 RETURN QUERY
 -- Every candidate lane is an index probe. UNION deduplicates overlapping
 -- coordinates; the real resolver then decides job identity and tenant scope.
 WITH candidate AS MATERIALIZED (
  SELECT l.id FROM public.trade_invoice_lines l WHERE l.job_id=p_job_id
  UNION
  SELECT l.id FROM public.trade_invoice_lines l WHERE nullif(btrim(l.job_number),'')=
   (SELECT j.job_number FROM public.jobs j WHERE j.id=p_job_id)
  UNION
  SELECT l.id FROM public.trade_invoice_lines l WHERE nullif(substring(upper(coalesce(l.description,''))
   FROM '(SWMS-[0-9]+|SWG-[0-9]+|SWF-[0-9]+|SWP-[0-9]+|BWCWA[0-9]+|AJBR-[0-9]+|MLB-[0-9]+)'), '')=
   (SELECT j.job_number FROM public.jobs j WHERE j.id=p_job_id)
 )
 SELECT coalesce(nullif(btrim(u.name),''),'Unnamed trade'),r.line_total_ex,'trade_line'::text,true
 FROM candidate c
 -- OFFSET 0 keeps each resolver call behind trade_invoice_lines_pkey.
 -- jobs_pkey/jobs_job_number_key, trade_invoices_pkey and users_pkey serve its joins.
 CROSS JOIN LATERAL (SELECT r.* FROM public.v_trade_charge_resolved r WHERE r.line_id=c.id OFFSET 0) r
 JOIN public.trade_invoices ti ON ti.id=r.trade_invoice_id
 LEFT JOIN public.users u ON u.id=r.user_id
 WHERE r.resolved_job_id=p_job_id AND NOT r.is_probable_test_line
  AND ti.status NOT IN ('ops-reject','draft')
  AND upper(coalesce(ti.xero_bill_status,'')) NOT IN ('DELETED','VOIDED') AND r.cost_lane<>'advance';
 RETURN QUERY
 -- Exact legacy po_base -> po_state predicate, with no unused bill/trade CTEs.
 -- idx_po_job and context_story_actual_fact_po bound both sides to this job.
 SELECT NULL::text,NULL::numeric,'po_committed'::text,false
 FROM public.purchase_orders p WHERE p.job_id=p_job_id AND p.xero_bill_id IS NULL
 AND NOT EXISTS(SELECT 1 FROM public.job_materials_facts f WHERE f.matched_po_id=p.id AND f.kind='actual')
 AND lower(coalesce(p.status,'')) NOT IN ('draft','billed','cancelled','canceled','void','voided','deleted')
 AND p.invoice_received_at IS NULL AND (p.subtotal>0 OR p.total>0);
END $fn$;


-- Derive both private bodies from the pinned current main definition. No copy
-- of the money rules, formatting or hashes is maintained in this migration.
DO $copy$
DECLARE d text; src text; current_md5 text; n integer;
/* function block */ BEGIN
 SELECT md5(prosrc) INTO current_md5 FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure;
 IF current_md5='fc9a1c8f605a1dfd6c7d1ef7667bfa0d' THEN
  d:=pg_get_functiondef('public.context_job_story_book(uuid,timestamptz)'::regprocedure);
 ELSE
  IF current_md5<>'af4fc8363060be37e1aec1046d933561' THEN RAISE EXCEPTION 'story_book_migration_preimage_changed'; END IF;
  d:=pg_get_functiondef('public.context_job_story_book_main(uuid,timestamptz)'::regprocedure);
  d:=replace(d,'public.context_job_story_book_main(', 'public.context_job_story_book(');
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure)<>'ac51513f6164fa256011d67c1bd82b10' THEN
  RAISE EXCEPTION 'story_text_get_migration_preimage_changed'; END IF;
 IF to_regprocedure('public.context_job_story_book_main(uuid,timestamptz)') IS NOT NULL
 AND (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_book_main(uuid,timestamptz)'))<>'fc9a1c8f605a1dfd6c7d1ef7667bfa0d' THEN
  RAISE EXCEPTION 'story_book_main_copy_changed'; END IF;
 EXECUTE replace(d,'public.context_job_story_book(', 'public.context_job_story_book_main(');
 src:='FROM public.v_job_cost_events e WHERE e.job_id = p_job_id';
 n:=(length(d)-length(replace(d,src,'')))/length(src);
 IF n<>2 THEN RAISE EXCEPTION 'story_book_cost_read_preimage_changed'; END IF;
 d:=replace(d,'public.context_job_story_book(', 'public.context_job_story_book_fast(');
 d:=replace(d,src,'FROM public.context_story_book_costs(p_job_id) e WHERE true');
 d:=replace(d,'END $function$',E'EXCEPTION WHEN OTHERS THEN\n -- A changed source or failed bounded read gets exactly main''s answer or error.\n RETURN public.context_job_story_book_main(p_job_id, p_as_of);\nEND $function$');
 EXECUTE d;
END $copy$;

-- Both originals are pinned. In particular, this does not replace or weaken
-- text_get's digest, bill-outcome or wrong-card checks, nor job_page_refresh.
CREATE OR REPLACE FUNCTION public.install_context_story_book_speed() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE d text;
/* function block */ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure)<>'ac51513f6164fa256011d67c1bd82b10' THEN
  RAISE EXCEPTION 'story_text_get_preimage_changed'; END IF;
 IF (SELECT prosrc FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure)=
    (SELECT prosrc FROM pg_proc WHERE oid='public.context_job_story_book_fast(uuid,timestamptz)'::regprocedure) THEN RETURN; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure)<>'fc9a1c8f605a1dfd6c7d1ef7667bfa0d' THEN
  RAISE EXCEPTION 'story_book_preimage_changed'; END IF;
 -- Source-read guard is also exercised at every fast call, with main fallback.
 d:=pg_get_functiondef('public.context_job_story_book_fast(uuid,timestamptz)'::regprocedure);
 EXECUTE replace(d,'public.context_job_story_book_fast(', 'public.context_job_story_book(');
END $fn$;
CREATE OR REPLACE FUNCTION public.remove_context_story_book_speed() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE d text;
/* function block */ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure)='fc9a1c8f605a1dfd6c7d1ef7667bfa0d' THEN RETURN; END IF;
 IF (SELECT prosrc FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure) IS DISTINCT FROM
    (SELECT prosrc FROM pg_proc WHERE oid='public.context_job_story_book_fast(uuid,timestamptz)'::regprocedure) THEN
  RAISE EXCEPTION 'story_book_remove_preimage_changed'; END IF;
 d:=pg_get_functiondef('public.context_job_story_book_main(uuid,timestamptz)'::regprocedure);
 EXECUTE replace(d,'public.context_job_story_book_main(', 'public.context_job_story_book(');
END $fn$;
REVOKE ALL ON FUNCTION public.context_story_book_costs(uuid),
 public.context_job_story_book_main(uuid,timestamptz),public.context_job_story_book_fast(uuid,timestamptz),
 public.install_context_story_book_speed(),public.remove_context_story_book_speed() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_story_book_costs(uuid),
 public.context_job_story_book_main(uuid,timestamptz),public.context_job_story_book_fast(uuid,timestamptz),
 public.install_context_story_book_speed(),public.remove_context_story_book_speed() TO service_role;
