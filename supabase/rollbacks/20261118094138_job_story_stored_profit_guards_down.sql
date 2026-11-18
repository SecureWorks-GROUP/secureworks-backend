-- Undo the FU26.1 follow-up: FU26.1's own four bodies (20261118065939) come
-- back exactly, its triggers go before their functions, then its tables.
-- Refuses if a later change replaced a body this migration wrote.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
DO $guard$
/* function block */ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_story_stored_profit_as_at(uuid,timestamptz)'::regprocedure)<>'05d149259e4ed4b90dfb31f3f9dda4ff'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.install_job_story_stored_profit()'::regprocedure)<>'6aaee48d89c6e3e55058a11be4142100'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.remove_job_story_stored_profit()'::regprocedure)<>'404751117e0e76af73d0b32e0388ded1'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_text_get_stamped(uuid,jsonb,boolean)'::regprocedure)<>'0d4040250186678ad880a69be4367df3' THEN
  RAISE EXCEPTION 'story_stored_profit_guards_down_preimage'; END IF;
END $guard$;
DROP TRIGGER IF EXISTS job_story_stored_profit_rearm ON public.feature_flags;
DROP TRIGGER IF EXISTS job_story_stored_profit_counts ON public.job_profit_stored;
-- The stamped staff read, and the live one when installed, go back to FU26.1's.
DO $stamp$
DECLARE d text; live_was_stamped boolean;
/* function block */ BEGIN
 live_was_stamped:=(SELECT prosrc FROM pg_proc WHERE oid='public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure)
  =(SELECT prosrc FROM pg_proc WHERE oid='public.context_job_story_text_get_stamped(uuid,jsonb,boolean)'::regprocedure);
 d:=replace(pg_get_functiondef('public.context_job_story_text_get_stamped(uuid,jsonb,boolean)'::regprocedure),
  $n$AND (p_card #>> '{book,job_id}') = p_job_id::text AND NOT ((p_card -> 'book') ? 'computed_at') THEN$n$,
  $o$AND (p_card #>> '{book,job_id}') = p_job_id::text THEN$o$);
 EXECUTE d;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_text_get_stamped(uuid,jsonb,boolean)'::regprocedure)
    IS DISTINCT FROM '935cecb054f2ff9cc77e05df5e1a199a' THEN
  RAISE EXCEPTION 'story_stored_profit_guards_down_stamped_result'; END IF;
 IF live_was_stamped THEN
  EXECUTE replace(d,'FUNCTION public.context_job_story_text_get_stamped(','FUNCTION public.context_job_story_text_get(');
 END IF;
END $stamp$;
CREATE OR REPLACE FUNCTION public.job_story_stored_profit_as_at(p_job_id uuid,p_as_of timestamptz)
RETURNS timestamptz LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE stamp timestamptz;
/* function block */ BEGIN
 IF p_job_id IS NULL
 -- feature_flags key.
 OR NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1' AND enabled)
 -- pg_trigger (tgrelid, tgname) key, one probe per source table.
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['job_materials_facts','trade_invoice_lines','trade_invoices','purchase_orders',
   'job_budgets','xero_invoices','xero_supplier_credit_note_allocations','jobs','work_orders',
   'group_work_order_shares','group_work_orders']) t(name)
  WHERE NOT EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgrelid=to_regclass('public.'||t.name)
   AND g.tgname='job_profit_changed' AND g.tgenabled<>'D')) THEN
  RETURN NULL;
 END IF;
 -- job_profit_stored_pkey, job_profit_dirty_pkey, job_profit_change_events_job_idx,
 -- job_cost_events_stored_job_idx and job_revenue_events_stored_job_idx.
 -- The sole writer (job_profit_refresh_many) replaces all three sets in one
 -- transaction, stamping each row with clock_timestamp(): events before summary.
 SELECT s.computed_at INTO stamp FROM public.job_profit_stored s
 WHERE s.job_id=p_job_id
  AND s.computed_at<=p_as_of
  AND (s.computed_at AT TIME ZONE 'Australia/Perth')::date=(p_as_of AT TIME ZONE 'Australia/Perth')::date
  AND NOT EXISTS(SELECT 1 FROM public.job_profit_dirty d WHERE d.job_id=p_job_id)
  AND NOT EXISTS(SELECT 1 FROM public.job_profit_change_events q WHERE q.job_id=p_job_id)
  AND NOT EXISTS(SELECT 1 FROM public.job_cost_events_stored c WHERE c.job_id=p_job_id
   AND (c.computed_at>s.computed_at OR (c.computed_at AT TIME ZONE 'Australia/Perth')::date<>(s.computed_at AT TIME ZONE 'Australia/Perth')::date))
  AND NOT EXISTS(SELECT 1 FROM public.job_revenue_events_stored e WHERE e.job_id=p_job_id
   AND (e.computed_at>s.computed_at OR (e.computed_at AT TIME ZONE 'Australia/Perth')::date<>(s.computed_at AT TIME ZONE 'Australia/Perth')::date));
 RETURN stamp;
END $fn$;

CREATE OR REPLACE FUNCTION public.install_job_story_stored_profit() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE book text; fast text; switched text; txt text; stamped text; unstamped text;
/* function block */ BEGIN
 SELECT prosrc INTO book FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure;
 SELECT prosrc INTO fast FROM pg_proc WHERE oid='public.context_job_story_book_fast(uuid,timestamptz)'::regprocedure;
 SELECT prosrc INTO switched FROM pg_proc WHERE oid='public.context_job_story_book_switch(uuid,timestamptz)'::regprocedure;
 SELECT prosrc INTO txt FROM pg_proc WHERE oid='public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure;
 SELECT prosrc INTO stamped FROM pg_proc WHERE oid='public.context_job_story_text_get_stamped(uuid,jsonb,boolean)'::regprocedure;
 SELECT prosrc INTO unstamped FROM pg_proc WHERE oid='public.context_job_story_text_get_unstamped(uuid,jsonb,boolean)'::regprocedure;
 IF book=switched AND txt=stamped THEN RETURN; END IF;
 IF md5(fast)<>'af4fc8363060be37e1aec1046d933561' OR book IS DISTINCT FROM fast THEN
  RAISE EXCEPTION 'story_stored_profit_needs_fast_book_installed'; END IF;
 IF txt IS DISTINCT FROM unstamped OR md5(txt)<>'ac51513f6164fa256011d67c1bd82b10' THEN
  RAISE EXCEPTION 'story_stored_profit_text_get_preimage_changed'; END IF;
 EXECUTE replace(pg_get_functiondef('public.context_job_story_book_switch(uuid,timestamptz)'::regprocedure),
  'FUNCTION public.context_job_story_book_switch(','FUNCTION public.context_job_story_book(');
 EXECUTE replace(pg_get_functiondef('public.context_job_story_text_get_stamped(uuid,jsonb,boolean)'::regprocedure),
  'FUNCTION public.context_job_story_text_get_stamped(','FUNCTION public.context_job_story_text_get(');
END $fn$;

CREATE OR REPLACE FUNCTION public.remove_job_story_stored_profit() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE book text; fast text; switched text; txt text; stamped text; unstamped text;
/* function block */ BEGIN
 SELECT prosrc INTO book FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure;
 SELECT prosrc INTO fast FROM pg_proc WHERE oid='public.context_job_story_book_fast(uuid,timestamptz)'::regprocedure;
 SELECT prosrc INTO switched FROM pg_proc WHERE oid='public.context_job_story_book_switch(uuid,timestamptz)'::regprocedure;
 SELECT prosrc INTO txt FROM pg_proc WHERE oid='public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure;
 SELECT prosrc INTO stamped FROM pg_proc WHERE oid='public.context_job_story_text_get_stamped(uuid,jsonb,boolean)'::regprocedure;
 SELECT prosrc INTO unstamped FROM pg_proc WHERE oid='public.context_job_story_text_get_unstamped(uuid,jsonb,boolean)'::regprocedure;
 IF book IS DISTINCT FROM switched AND txt IS DISTINCT FROM stamped THEN RETURN; END IF;
 IF (book IS DISTINCT FROM switched AND book IS DISTINCT FROM fast)
 OR (txt IS DISTINCT FROM stamped AND txt IS DISTINCT FROM unstamped) THEN
  RAISE EXCEPTION 'story_stored_profit_remove_preimage_changed'; END IF;
 IF book=switched THEN
  EXECUTE replace(pg_get_functiondef('public.context_job_story_book_fast(uuid,timestamptz)'::regprocedure),
   'FUNCTION public.context_job_story_book_fast(','FUNCTION public.context_job_story_book(');
 END IF;
 IF txt=stamped THEN
  EXECUTE replace(pg_get_functiondef('public.context_job_story_text_get_unstamped(uuid,jsonb,boolean)'::regprocedure),
   'FUNCTION public.context_job_story_text_get_unstamped(','FUNCTION public.context_job_story_text_get(');
 END IF;
END $fn$;

DROP FUNCTION IF EXISTS public.job_story_stored_profit_rearm_trg();
DROP FUNCTION IF EXISTS public.job_story_stored_profit_count_trg();
DROP FUNCTION IF EXISTS public.job_story_stored_profit_arm();
DROP FUNCTION IF EXISTS public.job_story_stored_profit_setup();
DROP TABLE IF EXISTS public.job_story_stored_profit_counts;
DROP TABLE IF EXISTS public.job_story_stored_profit_arm;
