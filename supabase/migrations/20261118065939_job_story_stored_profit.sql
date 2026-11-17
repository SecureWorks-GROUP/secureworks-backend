-- FU26.1 (Follow-up 26 item 1, story part): the story money book reads the
-- stored Job Profit rows, rebuilt on the installed FU26.0 book (20261118024514).
-- On merge: private functions, one index on the profit change queue and the
-- switch job_story_stored_profit_v1 seeded OFF. No entry point is replaced, no
-- trigger, schedule or install runs. The director runs
-- install_job_story_stored_profit() after FU26.0 is installed and the profit
-- refresh (job_profit_refresh_install) is installed and proven on a ZZTEST job.
-- Undo order: remove_job_story_stored_profit(), then FU26.0's remove.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- The freshness probe asks "is a source change for this job still queued?".
-- The queue (20261118000101) has only its id key; no index on job_id exists on
-- main. The refresh tick deletes what it folds, at most 200 rows a minute.
CREATE INDEX IF NOT EXISTS job_profit_change_events_job_idx
 ON public.job_profit_change_events(job_id);

INSERT INTO public.feature_flags(flag_name,enabled,description)
VALUES('job_story_stored_profit_v1',false,'Story money book reads a current stored Job Profit refresh, with its as-at time')
ON CONFLICT(flag_name) DO NOTHING;

CREATE OR REPLACE FUNCTION public.job_story_stored_profit_on()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
/* function block */ BEGIN
 -- feature_flags key. Missing or unreadable means off.
 RETURN EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_story_stored_profit_v1' AND enabled);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;

-- The as-at time of a stored snapshot the story may use for this job, or NULL.
-- Usable only while the profit refresh is on and every one of its source
-- triggers is installed, nothing for the job is queued or marked, and the
-- three stored sets are one same-day refresh no later than the summary.
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

-- Stored-events copy of context_story_book_costs: the same four columns and the
-- same two sources, read from the stored cost events (job_cost_events_stored_job_idx).
CREATE OR REPLACE FUNCTION public.context_story_book_costs_stored(p_job_id uuid)
RETURNS TABLE(party text,amount_ex numeric,source text,is_actual boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
 SELECT e.party,e.amount_ex,e.source,e.is_actual FROM public.job_cost_events_stored e
 WHERE e.job_id=p_job_id AND e.source IN ('trade_line','po_committed');
$fn$;

-- Session-local helper: replace exactly n occurrences, refusing any other count.
CREATE OR REPLACE FUNCTION pg_temp.story_stored_profit_swap(d text,old text,new text,n integer)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $fn$
/* function block */ BEGIN
 IF (length(d)-length(replace(d,old,'')))/length(old)<>n THEN
  RAISE EXCEPTION 'story_stored_profit_preimage_text: %',left(old,60); END IF;
 RETURN replace(d,old,new);
END $fn$;

-- Derive every private body from the pinned bodies now on main and live. No
-- copy of the money rules, words or hashes is kept in this migration.
DO $derive$
DECLARE d text;
/* function block */ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_book_fast(uuid,timestamptz)'))
    IS DISTINCT FROM 'af4fc8363060be37e1aec1046d933561' THEN
  RAISE EXCEPTION 'story_stored_profit_preimage: context_job_story_book_fast'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_money_sig(uuid)'))
    IS DISTINCT FROM '7a7798901a26351b8e910da3f1392509' THEN
  RAISE EXCEPTION 'story_stored_profit_preimage: context_job_story_money_sig'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_text_get(uuid,jsonb,boolean)'))
    IS DISTINCT FROM 'ac51513f6164fa256011d67c1bd82b10'
 AND (SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_text_get(uuid,jsonb,boolean)'))
    IS DISTINCT FROM (SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_text_get_stamped(uuid,jsonb,boolean)')) THEN
  RAISE EXCEPTION 'story_stored_profit_preimage: context_job_story_text_get'; END IF;

 -- Money signature on the stored summary (its one profit view read).
 d:=pg_get_functiondef('public.context_job_story_money_sig(uuid)'::regprocedure);
 d:=pg_temp.story_stored_profit_swap(d,'FUNCTION public.context_job_story_money_sig(','FUNCTION public.context_job_story_money_sig_stored(',1);
 d:=pg_temp.story_stored_profit_swap(d,'public.v_job_profit','public.job_profit_stored',1);
 EXECUTE d;

 -- Book on stored rows, from the installed fast body. Its fallback handler is
 -- dropped: a stored failure must reach the switch wrapper, which answers with
 -- the installed book, never a live answer stamped with an as-at time.
 d:=pg_get_functiondef('public.context_job_story_book_fast(uuid,timestamptz)'::regprocedure);
 d:=pg_temp.story_stored_profit_swap(d,'FUNCTION public.context_job_story_book_fast(','FUNCTION public.context_job_story_book_stored(',1);
 d:=pg_temp.story_stored_profit_swap(d,'public.context_story_book_costs(p_job_id)','public.context_story_book_costs_stored(p_job_id)',2);
 d:=pg_temp.story_stored_profit_swap(d,'public.v_job_profit','public.job_profit_stored',1);
 d:=pg_temp.story_stored_profit_swap(d,'public.v_job_revenue_events','public.job_revenue_events_stored',1);
 d:=pg_temp.story_stored_profit_swap(d,'public.context_job_story_money_sig(','public.context_job_story_money_sig_stored(',2);
 d:=pg_temp.story_stored_profit_swap(d,E'EXCEPTION WHEN OTHERS THEN\n -- A changed source or failed bounded read gets exactly main''s answer or error.\n RETURN public.context_job_story_book_main(p_job_id, p_as_of);\n','',1);
 IF d ~ '(v_job_profit|v_job_cost_events|v_job_revenue_events|context_story_book_costs\(|context_job_story_book_main|context_job_story_money_sig\()' THEN
  RAISE EXCEPTION 'story_stored_profit_live_read_left'; END IF;
 EXECUTE d;

 -- Staff read that carries the as-at time in its money block, only from a
 -- stored book and only while the switch is on. Kept beside an exact copy of
 -- the current read; install and remove swap one for the other.
 d:=pg_get_functiondef('public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure);
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure)
    ='ac51513f6164fa256011d67c1bd82b10' THEN
  EXECUTE pg_temp.story_stored_profit_swap(d,'FUNCTION public.context_job_story_text_get(','FUNCTION public.context_job_story_text_get_unstamped(',1);
  d:=pg_temp.story_stored_profit_swap(d,'FUNCTION public.context_job_story_text_get(','FUNCTION public.context_job_story_text_get_stamped(',1);
  d:=pg_temp.story_stored_profit_swap(d,$o$'incomplete_line', v_book -> 'incomplete_line') END)$o$,
   $n$'incomplete_line', v_book -> 'incomplete_line')
            || CASE WHEN public.job_story_stored_profit_on() AND v_book ? 'computed_at' THEN jsonb_build_object('computed_at', v_book -> 'computed_at') ELSE '{}'::jsonb END END)$n$,1);
  EXECUTE d;
 END IF;
END $derive$;

-- The switch wrapper. Off, or no usable snapshot, or any stored failure: the
-- installed book's own answer, exactly. On with a usable snapshot: the stored
-- book plus computed_at, a field outside its digest.
CREATE OR REPLACE FUNCTION public.context_job_story_book_switch(p_job_id uuid,p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE stamp timestamptz; book jsonb;
/* function block */ BEGIN
 IF public.job_story_stored_profit_on() THEN
  /* stored-read block */ BEGIN
   stamp:=public.job_story_stored_profit_as_at(p_job_id,p_as_of);
   IF stamp IS NOT NULL THEN
    book:=public.context_job_story_book_stored(p_job_id,p_as_of);
    IF book IS NOT NULL THEN RETURN book||jsonb_build_object('computed_at',stamp); END IF;
   END IF;
  EXCEPTION WHEN OTHERS THEN
   NULL;
  END;
 END IF;
 RETURN public.context_job_story_book_fast(p_job_id,p_as_of);
END $fn$;

-- Install: only over the installed FU26.0 book and the current staff read.
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

-- Remove: restores the installed FU26.0 book and the original staff read exactly.
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

DO $acl$
DECLARE f regprocedure;
/* function block */ BEGIN
 FOREACH f IN ARRAY ARRAY[
  'public.job_story_stored_profit_on()'::regprocedure,
  'public.job_story_stored_profit_as_at(uuid,timestamptz)'::regprocedure,
  'public.context_story_book_costs_stored(uuid)'::regprocedure,
  'public.context_job_story_money_sig_stored(uuid)'::regprocedure,
  'public.context_job_story_book_stored(uuid,timestamptz)'::regprocedure,
  'public.context_job_story_book_switch(uuid,timestamptz)'::regprocedure,
  'public.context_job_story_text_get_stamped(uuid,jsonb,boolean)'::regprocedure,
  'public.context_job_story_text_get_unstamped(uuid,jsonb,boolean)'::regprocedure,
  'public.install_job_story_stored_profit()'::regprocedure,
  'public.remove_job_story_stored_profit()'::regprocedure] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
 END LOOP;
END $acl$;
