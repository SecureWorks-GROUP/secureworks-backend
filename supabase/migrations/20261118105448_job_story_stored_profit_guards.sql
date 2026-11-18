-- FU26.1 follow-up (blocking items before job_story_stored_profit_v1 goes on).
-- Replaces four private FU26.1 bodies (20261118065939), each md5-guarded:
--  1. with job_story_stored_profit_v1 on, the stamped staff read never reuses
--     a supplied book (stored or fallback); it resolves the book through the
--     current wrapper. Off, it reuses a supplied book exactly as main does;
--  2. a snapshot counts only after the store was armed (install, or any write
--     to the job_profit_refresh_v1 row), only from a refresh transaction begun
--     after the arm, and only while the same 11 source triggers are present
--     and enabled O or A (never R replica-only or D). Arming waits for every
--     in-flight write on those 11 tables to commit (SHARE lock to its commit),
--     so a write made while the refresh was off is visible to any counted refresh;
--  3. a snapshot counts only while its two event sets are exactly the ones its
--     refresh stored (count and a fingerprint of every field of every row,
--     recorded at refresh);
--  4. install and remove pin every helper they copy, and every body an
--     already-installed or already-removed answer trusts.
-- On merge: two private tables, private functions, four replaced private
-- bodies. No entry point is replaced, no trigger is created, nothing is
-- installed and the switch stays as it is. If FU26.1 was already installed,
-- the live staff read moves to the new stamped body, and the store answers
-- nothing until install_job_story_stored_profit() is run again (it arms).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Rule 15: the bodies replaced here are FU26.1's (20261118065939) or this
-- migration's own (a re-apply). Anything else refuses.
DO $guard$
/* function block */ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.job_story_stored_profit_as_at(uuid,timestamptz)'))
    NOT IN ('33655a0a0bf3c36cb83ff2796d747af6','48d8c171c00cb3015688a27abffd4800') THEN
  RAISE EXCEPTION 'story_stored_profit_guards_preimage: job_story_stored_profit_as_at'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.install_job_story_stored_profit()'))
    NOT IN ('597475dfd06f211f9b836675f0cb172f','48ddebb7caa8539699d770b5eca774b7') THEN
  RAISE EXCEPTION 'story_stored_profit_guards_preimage: install_job_story_stored_profit'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.remove_job_story_stored_profit()'))
    NOT IN ('8e96644715a2ca31fe88b6a48a1df499','404751117e0e76af73d0b32e0388ded1') THEN
  RAISE EXCEPTION 'story_stored_profit_guards_preimage: remove_job_story_stored_profit'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_text_get_stamped(uuid,jsonb,boolean)'))
    NOT IN ('935cecb054f2ff9cc77e05df5e1a199a','a712ec6772216f23eb8791e1d9cefb7d') THEN
  RAISE EXCEPTION 'story_stored_profit_guards_preimage: context_job_story_text_get_stamped'; END IF;
 -- The live staff read is the original (not installed) or one of the two
 -- stamped bodies (installed).
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_text_get(uuid,jsonb,boolean)'))
    NOT IN ('ac51513f6164fa256011d67c1bd82b10','935cecb054f2ff9cc77e05df5e1a199a','a712ec6772216f23eb8791e1d9cefb7d') THEN
  RAISE EXCEPTION 'story_stored_profit_guards_preimage: context_job_story_text_get'; END IF;
 -- This migration's own new functions: absent, or exactly this migration's body.
 IF EXISTS(SELECT 1 FROM (VALUES
   ('public.job_story_stored_profit_setup()','f6c89476ff1e9886c66e0907dfeab421'),
   ('public.job_story_stored_profit_arm()','6a464d989843143fdf8b8c6ce528d076'),
   ('public.job_story_stored_profit_rearm_trg()','a586dc515a9406118ace00837ae68337'),
   ('public.job_story_stored_profit_count_trg()','5f186940947c020de80915ba0993672a')) v(sig,m)
   JOIN pg_proc p ON p.oid=to_regprocedure(v.sig) WHERE md5(p.prosrc)<>v.m) THEN
  RAISE EXCEPTION 'story_stored_profit_guards_preimage: own helper changed'; END IF;
END $guard$;

-- The 11 profit refresh source tables, in job_profit_refresh_install's order.
-- Each must carry an enabled job_profit_changed trigger (O origin or A always;
-- D disabled and R replica-only skip ordinary writes) for a snapshot to count.
CREATE OR REPLACE FUNCTION public.job_story_stored_profit_setup()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
 -- pg_trigger_tgrelid_tgname_index, one probe per source table. NULL when a
 -- trigger is missing or not O/A; else the oids and modes in a fixed order.
 SELECT CASE WHEN count(g.oid)=11 THEN md5(string_agg(t.name||':'||g.oid::text||':'||g.tgenabled::text,'|' ORDER BY t.ord)) END
 FROM unnest(ARRAY['job_materials_facts','trade_invoice_lines','trade_invoices','purchase_orders',
   'job_budgets','xero_invoices','xero_supplier_credit_note_allocations','jobs','work_orders',
   'group_work_order_shares','group_work_orders']) WITH ORDINALITY t(name,ord)
 LEFT JOIN pg_trigger g ON g.tgrelid=to_regclass('public.'||t.name) AND g.tgname='job_profit_changed' AND g.tgenabled IN ('O','A');
$fn$;

-- Arm stamp. One row, overwritten, never a history. A snapshot counts only
-- when computed after it: a write skipped while the refresh was off, or while
-- a source trigger was missing, can never be answered by an older snapshot.
-- Written by install and, in the flipping statement, by any write to the
-- job_profit_refresh_v1 switch row (trigger created by install).
CREATE TABLE IF NOT EXISTS public.job_story_stored_profit_arm (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 armed_at timestamptz NOT NULL,
 setup text
);
ALTER TABLE public.job_story_stored_profit_arm ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_story_stored_profit_arm FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.job_story_stored_profit_arm TO service_role;

-- Event sets the refresh stored for each summary: the count and a
-- fingerprint (md5 of every row's full text, rows in C order, rendered under
-- fixed time zone and date settings), and when that refresh's transaction
-- began. One row per stored summary (deleted with it); keyed to the summary's
-- computed_at, so a row left by an earlier refresh never vouches for a later one.
CREATE TABLE IF NOT EXISTS public.job_story_stored_profit_counts (
 job_id uuid PRIMARY KEY,
 computed_at timestamptz NOT NULL,
 refresh_started_at timestamptz NOT NULL,
 cost_events bigint NOT NULL,
 cost_print text NOT NULL,
 revenue_events bigint NOT NULL,
 revenue_print text NOT NULL
);
ALTER TABLE public.job_story_stored_profit_counts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_story_stored_profit_counts FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.job_story_stored_profit_counts TO service_role;

-- Arming first waits for every in-flight write on the 11 source tables to
-- commit: SHARE conflicts with the ROW EXCLUSIVE a writer holds to its commit,
-- and is held to the arming transaction's commit, so a write begun while the
-- refresh was off is committed before the stamp, and a write after it queues
-- (it runs once the flag write commits). A lock not had in 2 seconds fails the
-- arm: install refuses; a flag write goes on with no stamp (see below).
CREATE OR REPLACE FUNCTION public.job_story_stored_profit_arm()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='2s' AS $fn$
DECLARE t text;
/* function block */ BEGIN
 FOREACH t IN ARRAY ARRAY['job_materials_facts','trade_invoice_lines','trade_invoices','purchase_orders',
   'job_budgets','xero_invoices','xero_supplier_credit_note_allocations','jobs','work_orders',
   'group_work_order_shares','group_work_orders'] LOOP
  IF to_regclass('public.'||t) IS NOT NULL THEN
   EXECUTE format('LOCK TABLE public.%I IN SHARE MODE',t);
  END IF;
 END LOOP;
 -- job_story_stored_profit_arm_pkey (singleton).
 INSERT INTO public.job_story_stored_profit_arm(singleton,armed_at,setup)
 VALUES(true,clock_timestamp(),public.job_story_stored_profit_setup())
 ON CONFLICT(singleton) DO UPDATE SET armed_at=EXCLUDED.armed_at,setup=EXCLUDED.setup;
END $fn$;

-- On the switch table: any write to the refresh switch row re-arms. It never
-- fails a switch write; a failed re-arm leaves the old stamp, and the store
-- is then refused on the switch check or the trigger set until a re-arm.
CREATE OR REPLACE FUNCTION public.job_story_stored_profit_rearm_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
/* function block */ BEGIN
 IF (TG_OP<>'INSERT' AND OLD.flag_name='job_profit_refresh_v1') OR (TG_OP<>'DELETE' AND NEW.flag_name='job_profit_refresh_v1') THEN
  /* re-arm block */ BEGIN
   PERFORM public.job_story_stored_profit_arm();
  EXCEPTION WHEN OTHERS THEN
   -- A failed re-arm must not leave a stamp the new state never earned.
   /* clear block */ BEGIN
    DELETE FROM public.job_story_stored_profit_arm WHERE singleton;
   EXCEPTION WHEN OTHERS THEN NULL;
   END;
   RAISE WARNING 'job_story_stored_profit_rearm_failed code=%',SQLSTATE;
  END;
 END IF;
 RETURN NULL;
END $fn$;

-- On job_profit_stored: the sole writer (job_profit_refresh_many) inserts the
-- summary after both event sets, so this counts what that refresh stored.
-- It never fails a refresh: a failed count leaves no row for the new stamp.
CREATE OR REPLACE FUNCTION public.job_story_stored_profit_count_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
 SET TimeZone='UTC' SET DateStyle='ISO, MDY' SET IntervalStyle='postgres' SET extra_float_digits='1' AS $fn$
/* function block */ BEGIN
 /* count block */ BEGIN
  IF TG_OP='DELETE' THEN
   -- job_story_stored_profit_counts_pkey: the row goes with its summary.
   DELETE FROM public.job_story_stored_profit_counts WHERE job_id=OLD.job_id;
  ELSE
   -- job_cost_events_stored_job_idx and job_revenue_events_stored_job_idx.
   -- now() is this refresh transaction's start.
   INSERT INTO public.job_story_stored_profit_counts(job_id,computed_at,refresh_started_at,cost_events,cost_print,revenue_events,revenue_print)
   SELECT NEW.job_id,NEW.computed_at,now(),c.n,c.f,r.n,r.f
   FROM (SELECT count(*) n,md5(coalesce(string_agg(e::text,'|' ORDER BY e::text COLLATE "C"),'')) f
         FROM public.job_cost_events_stored e WHERE e.job_id=NEW.job_id) c,
        (SELECT count(*) n,md5(coalesce(string_agg(e::text,'|' ORDER BY e::text COLLATE "C"),'')) f
         FROM public.job_revenue_events_stored e WHERE e.job_id=NEW.job_id) r
   ON CONFLICT(job_id) DO UPDATE SET computed_at=EXCLUDED.computed_at,refresh_started_at=EXCLUDED.refresh_started_at,
    cost_events=EXCLUDED.cost_events,cost_print=EXCLUDED.cost_print,
    revenue_events=EXCLUDED.revenue_events,revenue_print=EXCLUDED.revenue_print;
  END IF;
 EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'job_story_stored_profit_count_failed code=%',SQLSTATE;
 END;
 RETURN NULL;
END $fn$;

-- 2 and 3. The as-at time of a stored snapshot the story may use for this job, or NULL.
-- Usable only while the store is armed, the profit refresh is on, every one of
-- its source triggers is installed and enabled (the same ones as when armed),
-- nothing for the job is queued or marked, the summary was computed by a
-- refresh transaction begun after the arm stamp, on the as-of Perth day, and
-- its two event sets are exactly the ones its refresh fingerprinted (every
-- field of every row), none stamped later or on another day. The fingerprint
-- settings are the counts trigger's own.
CREATE OR REPLACE FUNCTION public.job_story_stored_profit_as_at(p_job_id uuid,p_as_of timestamptz)
RETURNS timestamptz LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp
 SET TimeZone='UTC' SET DateStyle='ISO, MDY' SET IntervalStyle='postgres' SET extra_float_digits='1' AS $fn$
DECLARE stamp timestamptz; v_armed_at timestamptz; v_setup text;
/* function block */ BEGIN
 -- job_story_stored_profit_arm_pkey (one row).
 SELECT a.armed_at,a.setup INTO v_armed_at,v_setup FROM public.job_story_stored_profit_arm a WHERE a.singleton;
 IF p_job_id IS NULL OR v_armed_at IS NULL OR v_setup IS NULL
 -- feature_flags key.
 OR NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1' AND enabled)
 -- Every source trigger present and O/A, and the same triggers as when armed.
 OR public.job_story_stored_profit_setup() IS DISTINCT FROM v_setup THEN
  RETURN NULL;
 END IF;
 -- job_profit_stored_pkey, job_story_stored_profit_counts_pkey,
 -- job_profit_dirty_pkey, job_profit_change_events_job_idx,
 -- job_cost_events_stored_job_idx and job_revenue_events_stored_job_idx.
 -- The sole writer (job_profit_refresh_many) replaces all three sets in one
 -- transaction, stamping each row with clock_timestamp(): events before summary.
 SELECT s.computed_at INTO stamp FROM public.job_profit_stored s
 JOIN public.job_story_stored_profit_counts k ON k.job_id=s.job_id AND k.computed_at=s.computed_at
 CROSS JOIN LATERAL (SELECT count(*) n,md5(coalesce(string_agg(c::text,'|' ORDER BY c::text COLLATE "C"),'')) f,
   bool_or(c.computed_at>s.computed_at OR (c.computed_at AT TIME ZONE 'Australia/Perth')::date<>(s.computed_at AT TIME ZONE 'Australia/Perth')::date) late
  FROM public.job_cost_events_stored c WHERE c.job_id=p_job_id) ce
 CROSS JOIN LATERAL (SELECT count(*) n,md5(coalesce(string_agg(e::text,'|' ORDER BY e::text COLLATE "C"),'')) f,
   bool_or(e.computed_at>s.computed_at OR (e.computed_at AT TIME ZONE 'Australia/Perth')::date<>(s.computed_at AT TIME ZONE 'Australia/Perth')::date) late
  FROM public.job_revenue_events_stored e WHERE e.job_id=p_job_id) re
 WHERE s.job_id=p_job_id
  AND s.computed_at>v_armed_at
  AND k.refresh_started_at>v_armed_at
  AND s.computed_at<=p_as_of
  AND (s.computed_at AT TIME ZONE 'Australia/Perth')::date=(p_as_of AT TIME ZONE 'Australia/Perth')::date
  AND NOT EXISTS(SELECT 1 FROM public.job_profit_dirty d WHERE d.job_id=p_job_id)
  AND NOT EXISTS(SELECT 1 FROM public.job_profit_change_events q WHERE q.job_id=p_job_id)
  -- Exactly the events this refresh stored: none missing, none added, no
  -- field of any row changed, none stamped later or on another day.
  AND ce.n=k.cost_events AND ce.f=k.cost_print AND NOT coalesce(ce.late,false)
  AND re.n=k.revenue_events AND re.f=k.revenue_print AND NOT coalesce(re.late,false);
 RETURN stamp;
END $fn$;

-- 1. Stamped staff read: with job_story_stored_profit_v1 on, a supplied book
-- is never trusted (a stored one, or a fallback one built before a later
-- change); it is resolved through the current book wrapper, which falls back
-- while a change waits. Off, a supplied book is reused exactly as the
-- installed read does. Built from FU26.1's stamped body (one counted swap).
DO $stamp$
DECLARE d text; live_was_stamped boolean;
/* function block */ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_text_get_stamped(uuid,jsonb,boolean)'::regprocedure)
    ='935cecb054f2ff9cc77e05df5e1a199a' THEN
  live_was_stamped:=(SELECT prosrc FROM pg_proc WHERE oid='public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure)
   =(SELECT prosrc FROM pg_proc WHERE oid='public.context_job_story_text_get_stamped(uuid,jsonb,boolean)'::regprocedure);
  d:=pg_get_functiondef('public.context_job_story_text_get_stamped(uuid,jsonb,boolean)'::regprocedure);
  IF (length(d)-length(replace(d,$o$AND (p_card #>> '{book,job_id}') = p_job_id::text THEN$o$,'')))
     /length($o$AND (p_card #>> '{book,job_id}') = p_job_id::text THEN$o$)<>1 THEN
   RAISE EXCEPTION 'story_stored_profit_guards_preimage_text: stamped book test'; END IF;
  d:=replace(d,$o$AND (p_card #>> '{book,job_id}') = p_job_id::text THEN$o$,
   $n$AND (p_card #>> '{book,job_id}') = p_job_id::text AND NOT public.job_story_stored_profit_on() THEN$n$);
  EXECUTE d;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_text_get_stamped(uuid,jsonb,boolean)'::regprocedure)
     IS DISTINCT FROM 'a712ec6772216f23eb8791e1d9cefb7d' THEN
   RAISE EXCEPTION 'story_stored_profit_guards_stamped_result'; END IF;
  -- Installed: the live staff read is the stamped body, so it moves too.
  IF live_was_stamped THEN
   EXECUTE replace(d,'FUNCTION public.context_job_story_text_get_stamped(','FUNCTION public.context_job_story_text_get(');
  END IF;
 END IF;
END $stamp$;

-- 4. Install: only over the installed FU26.0 book and the current staff read.
-- Rule 15: the two helpers it copies are pinned before any copy or return,
-- and so are the bodies an already-installed answer trusts. Then it creates
-- its two triggers when missing and arms: only a refresh after this counts.
-- Re-running it is the re-arm after any change to the refresh triggers.
CREATE OR REPLACE FUNCTION public.install_job_story_stored_profit() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='5s' AS $fn$
DECLARE book text; fast text; switched text; txt text; stamped text; unstamped text;
/* function block */ BEGIN
 SELECT prosrc INTO book FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure;
 SELECT prosrc INTO fast FROM pg_proc WHERE oid='public.context_job_story_book_fast(uuid,timestamptz)'::regprocedure;
 SELECT prosrc INTO switched FROM pg_proc WHERE oid='public.context_job_story_book_switch(uuid,timestamptz)'::regprocedure;
 SELECT prosrc INTO txt FROM pg_proc WHERE oid='public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure;
 SELECT prosrc INTO stamped FROM pg_proc WHERE oid='public.context_job_story_text_get_stamped(uuid,jsonb,boolean)'::regprocedure;
 SELECT prosrc INTO unstamped FROM pg_proc WHERE oid='public.context_job_story_text_get_unstamped(uuid,jsonb,boolean)'::regprocedure;
 IF md5(switched) IS DISTINCT FROM 'a4535d4e67f1a8bd261e81c83b8532c8' OR md5(stamped) IS DISTINCT FROM 'a712ec6772216f23eb8791e1d9cefb7d' THEN
  RAISE EXCEPTION 'story_stored_profit_helper_changed'; END IF;
 IF NOT (book=switched AND txt=stamped) THEN
  IF md5(fast) IS DISTINCT FROM 'af4fc8363060be37e1aec1046d933561' OR book IS DISTINCT FROM fast THEN
   RAISE EXCEPTION 'story_stored_profit_needs_fast_book_installed'; END IF;
  IF txt IS DISTINCT FROM unstamped OR md5(txt) IS DISTINCT FROM 'ac51513f6164fa256011d67c1bd82b10' THEN
   RAISE EXCEPTION 'story_stored_profit_text_get_preimage_changed'; END IF;
  EXECUTE replace(pg_get_functiondef('public.context_job_story_book_switch(uuid,timestamptz)'::regprocedure),
   'FUNCTION public.context_job_story_book_switch(','FUNCTION public.context_job_story_book(');
  EXECUTE replace(pg_get_functiondef('public.context_job_story_text_get_stamped(uuid,jsonb,boolean)'::regprocedure),
   'FUNCTION public.context_job_story_text_get_stamped(','FUNCTION public.context_job_story_text_get(');
 END IF;
 -- pg_trigger_tgrelid_tgname_index.
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.job_profit_stored'::regclass AND tgname='job_story_stored_profit_counts') THEN
  CREATE TRIGGER job_story_stored_profit_counts AFTER INSERT OR UPDATE OR DELETE ON public.job_profit_stored
   FOR EACH ROW EXECUTE FUNCTION public.job_story_stored_profit_count_trg();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.feature_flags'::regclass AND tgname='job_story_stored_profit_rearm') THEN
  CREATE TRIGGER job_story_stored_profit_rearm AFTER INSERT OR UPDATE OR DELETE ON public.feature_flags
   FOR EACH ROW EXECUTE FUNCTION public.job_story_stored_profit_rearm_trg();
 END IF;
 PERFORM public.job_story_stored_profit_arm();
END $fn$;

-- Remove: restores the installed FU26.0 book and the original staff read
-- exactly. Rule 15: both sources are pinned before any copy or return. It
-- drops its two triggers and clears its arm stamp and counts.
CREATE OR REPLACE FUNCTION public.remove_job_story_stored_profit() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='5s' AS $fn$
DECLARE book text; fast text; switched text; txt text; stamped text; unstamped text;
/* function block */ BEGIN
 SELECT prosrc INTO book FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure;
 SELECT prosrc INTO fast FROM pg_proc WHERE oid='public.context_job_story_book_fast(uuid,timestamptz)'::regprocedure;
 SELECT prosrc INTO switched FROM pg_proc WHERE oid='public.context_job_story_book_switch(uuid,timestamptz)'::regprocedure;
 SELECT prosrc INTO txt FROM pg_proc WHERE oid='public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure;
 SELECT prosrc INTO stamped FROM pg_proc WHERE oid='public.context_job_story_text_get_stamped(uuid,jsonb,boolean)'::regprocedure;
 SELECT prosrc INTO unstamped FROM pg_proc WHERE oid='public.context_job_story_text_get_unstamped(uuid,jsonb,boolean)'::regprocedure;
 IF md5(fast) IS DISTINCT FROM 'af4fc8363060be37e1aec1046d933561' OR md5(unstamped) IS DISTINCT FROM 'ac51513f6164fa256011d67c1bd82b10' THEN
  RAISE EXCEPTION 'story_stored_profit_remove_source_changed'; END IF;
 IF book=switched OR txt=stamped THEN
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
 END IF;
 DROP TRIGGER IF EXISTS job_story_stored_profit_rearm ON public.feature_flags;
 DROP TRIGGER IF EXISTS job_story_stored_profit_counts ON public.job_profit_stored;
 -- job_story_stored_profit_arm_pkey; the counts table holds at most one row
 -- per stored summary and is emptied whole here, its only trim besides the
 -- per-summary delete.
 DELETE FROM public.job_story_stored_profit_arm WHERE singleton;
 -- WHERE keeps it valid under safeupdate on API sessions.
 DELETE FROM public.job_story_stored_profit_counts WHERE job_id IS NOT NULL;
END $fn$;

DO $acl$
DECLARE f regprocedure;
/* function block */ BEGIN
 FOREACH f IN ARRAY ARRAY[
  'public.job_story_stored_profit_setup()'::regprocedure,
  'public.job_story_stored_profit_arm()'::regprocedure,
  'public.job_story_stored_profit_rearm_trg()'::regprocedure,
  'public.job_story_stored_profit_count_trg()'::regprocedure,
  'public.job_story_stored_profit_as_at(uuid,timestamptz)'::regprocedure,
  'public.context_job_story_text_get_stamped(uuid,jsonb,boolean)'::regprocedure,
  'public.install_job_story_stored_profit()'::regprocedure,
  'public.remove_job_story_stored_profit()'::regprocedure] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
 END LOOP;
END $acl$;
