-- Follow-up 26, story-only stored Job Profit reader. Seeded off, no installs.
-- Before (director, 17 Nov): story card 12.4 s / 51 calls; one-job profit
-- 7.4 s / 62 calls. This migration makes no live performance claim.
-- Output-key guard delegation declarations, not removals: the book returns
-- the complete guarded main implementation from *_profit_live/stored. The
-- static checker cannot follow those calls. The own contract compares every
-- returned JSON field, including all nested fields, with the original book.
-- output-key-guard: drop public.context_job_story_book complete
-- output-key-guard: drop public.context_job_story_book cost_flag
-- output-key-guard: drop public.context_job_story_book digest
-- output-key-guard: drop public.context_job_story_book facts
-- output-key-guard: drop public.context_job_story_book incomplete
-- output-key-guard: drop public.context_job_story_book incomplete_line
-- output-key-guard: drop public.context_job_story_book invoices_emailed_unplaced
-- output-key-guard: drop public.context_job_story_book job_id
-- output-key-guard: drop public.context_job_story_book job_lines
-- output-key-guard: drop public.context_job_story_book likely_unplaced_bills
-- output-key-guard: drop public.context_job_story_book lines
-- output-key-guard: drop public.context_job_story_book margin_ok
-- output-key-guard: drop public.context_job_story_book money_sig
-- output-key-guard: drop public.context_job_story_book orders_unpriced_open
-- output-key-guard: drop public.context_job_story_book priced_orders_open
-- output-key-guard: drop public.context_job_story_book reason
-- output-key-guard: drop public.context_job_story_book reasons
-- output-key-guard: drop public.context_job_story_book revenue_flag
-- output-key-guard: drop public.context_job_story_book signed_off
-- output-key-guard: drop public.context_job_story_book source
-- output-key-guard: drop public.context_job_story_book started
-- output-key-guard: drop public.context_job_story_book v
-- output-key-guard: drop public.context_job_story_book version
-- output-key-guard: drop public.context_job_story_book work_order

SET LOCAL lock_timeout = '5s';

-- Capture only the exact bodies now on main. Re-apply retains these originals.
DO $guard$
DECLARE spec record; f text; h text;
/* function block */ BEGIN
 FOR spec IN SELECT * FROM (VALUES
  ('context_job_story_book(uuid,timestamp with time zone)', 'context_job_story_book', 'fc9a1c8f605a1dfd6c7d1ef7667bfa0d','62d11c1c91fba84c7d6ca5ab3bafda32'),
  ('context_job_story_text_get(uuid,jsonb,boolean)', 'context_job_story_text_get', 'ac51513f6164fa256011d67c1bd82b10','da7e2486ccfb3f5e43094cfbe8a98477'),
  ('context_job_story_money_sig(uuid)', 'context_job_story_money_sig', '7a7798901a26351b8e910da3f1392509',NULL)
 ) s(sig, name, expected, installed) LOOP
  SELECT pg_get_functiondef(oid), md5(prosrc) INTO f,h FROM pg_proc
   WHERE oid=to_regprocedure('public.'||spec.sig);
  IF h IS DISTINCT FROM spec.expected THEN
   IF h = spec.installed
      AND (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.'||replace(spec.sig,spec.name,spec.name||'_profit_live'))) = spec.expected THEN
    CONTINUE;
   END IF;
   RAISE EXCEPTION 'story_stored_profit_preimage: % %',spec.name,h;
  END IF;
  EXECUTE replace(f, 'FUNCTION public.'||spec.name||'(', 'FUNCTION public.'||spec.name||'_profit_live(');
 END LOOP;
END $guard$;

INSERT INTO public.feature_flags(flag_name,enabled,description)
VALUES('job_story_stored_profit_v1',false,'Story money reads a current stored Job Profit refresh with an as-at time')
ON CONFLICT(flag_name) DO NOTHING;

CREATE OR REPLACE FUNCTION public.job_story_stored_profit_on()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $fn$
/* function block */ BEGIN
 RETURN EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_story_stored_profit_v1' AND enabled);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;

-- The stored implementation is mechanically identical to main's book. Keep
-- its raw-source signature rules, replacing only its profit view lookup too.
DO $stored$
DECLARE f text;
/* function block */ BEGIN
 SELECT pg_get_functiondef('public.context_job_story_money_sig_profit_live(uuid)'::regprocedure) INTO f;
 f:=replace(f,'FUNCTION public.context_job_story_money_sig_profit_live(', 'FUNCTION public.context_job_story_money_sig_profit_stored(');
 EXECUTE replace(f,'public.v_job_profit','public.job_profit_stored');
 SELECT pg_get_functiondef('public.context_job_story_book_profit_live(uuid,timestamptz)'::regprocedure) INTO f;
 f:=replace(f,'FUNCTION public.context_job_story_book_profit_live(', 'FUNCTION public.context_job_story_book_profit_stored(');
 f:=replace(replace(replace(f,'public.v_job_profit','public.job_profit_stored'),
      'public.v_job_cost_events','public.job_cost_events_stored'),
      'public.v_job_revenue_events','public.job_revenue_events_stored');
 EXECUTE replace(f,'public.context_job_story_money_sig(', 'public.context_job_story_money_sig_profit_stored(');
END $stored$;

CREATE OR REPLACE FUNCTION public.context_job_story_book(p_job_id uuid,p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $fn$
DECLARE stamp timestamptz; book jsonb;
/* function block */ BEGIN -- story-stored-profit-v1
 -- Missing/unreadable switch and every stored failure use the original read.
 /* stored-read block */ BEGIN
  IF public.job_story_stored_profit_on() THEN
   -- All new reads are per job: profit/dirty primary keys and event job indexes.
   -- The sole refresh writer replaces all three sets in one transaction,
   -- stamping event rows before the summary with clock_timestamp(), not one
   -- shared timestamp. Later or previous-day events are not a usable snapshot.
   SELECT s.computed_at INTO stamp FROM public.job_profit_stored s
   WHERE s.job_id=p_job_id
    AND s.computed_at <= p_as_of
    AND (s.computed_at AT TIME ZONE 'Australia/Perth')::date
        = (p_as_of AT TIME ZONE 'Australia/Perth')::date
    AND NOT EXISTS(SELECT 1 FROM public.job_profit_dirty d WHERE d.job_id=p_job_id)
    AND NOT EXISTS(SELECT 1 FROM public.job_cost_events_stored c WHERE c.job_id=p_job_id AND (c.computed_at > s.computed_at OR (c.computed_at AT TIME ZONE 'Australia/Perth')::date <> (s.computed_at AT TIME ZONE 'Australia/Perth')::date))
    AND NOT EXISTS(SELECT 1 FROM public.job_revenue_events_stored e WHERE e.job_id=p_job_id AND (e.computed_at > s.computed_at OR (e.computed_at AT TIME ZONE 'Australia/Perth')::date <> (s.computed_at AT TIME ZONE 'Australia/Perth')::date));
   IF stamp IS NOT NULL THEN
    book:=public.context_job_story_book_profit_stored(p_job_id,p_as_of);
    RETURN book || jsonb_build_object('computed_at',stamp);
   END IF;
  END IF;
 EXCEPTION WHEN OTHERS THEN
  NULL;
 END;
 RETURN public.context_job_story_book_profit_live(p_job_id,p_as_of);
END $fn$;

-- Preserve the complete off answer. Only a stored book adds the as-at field
-- to the existing money payload consumed by job pages and the story reader.
DO $projection$
DECLARE f text; old text := $o$'incomplete_line', v_book -> 'incomplete_line') END)$o$;
 new text := $n$'incomplete_line', v_book -> 'incomplete_line')
             || CASE WHEN public.job_story_stored_profit_on() AND v_book ? 'computed_at' THEN jsonb_build_object('computed_at',v_book -> 'computed_at') ELSE '{}'::jsonb END END)$n$;
/* function block */ BEGIN
 SELECT pg_get_functiondef('public.context_job_story_text_get_profit_live(uuid,jsonb,boolean)'::regprocedure) INTO f;
 IF (length(f)-length(replace(f,old,'')))/length(old) <> 1 THEN
  RAISE EXCEPTION 'story_stored_profit_projection_preimage';
 END IF;
 f:=replace(f,'FUNCTION public.context_job_story_text_get_profit_live(', 'FUNCTION public.context_job_story_text_get(');
 -- Marker is part of the function body so re-apply guards recognize it.
 f:=replace(f,'BEGIN', 'BEGIN -- story-stored-profit-v1');
 EXECUTE replace(f,old,new);
END $projection$;

DO $acl$
DECLARE f regprocedure;
/* function block */ BEGIN
 FOREACH f IN ARRAY ARRAY[
  'public.job_story_stored_profit_on()'::regprocedure,
  'public.context_job_story_book(uuid,timestamptz)'::regprocedure,
  'public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure,
  'public.context_job_story_book_profit_live(uuid,timestamptz)'::regprocedure,
  'public.context_job_story_text_get_profit_live(uuid,jsonb,boolean)'::regprocedure,
  'public.context_job_story_money_sig_profit_live(uuid)'::regprocedure,
  'public.context_job_story_money_sig_profit_stored(uuid)'::regprocedure,
  'public.context_job_story_book_profit_stored(uuid,timestamptz)'::regprocedure] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
 END LOOP;
END $acl$;
