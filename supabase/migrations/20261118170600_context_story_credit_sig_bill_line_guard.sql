-- Follow-up 58, guard: context_job_story_credit_sig_fast also checks job_cost_bill_line_job_id.
-- context_job_story_credit_sig_job's gate finds a bill whose line text names this job with
-- strpos(upper(description), 'SW') > 0 before it calls job_cost_bill_line_job_id. That
-- prefilter is right only while the function matches nothing without "SW" (its body from
-- 20261104063000, md5 a543e41bc709d4a96d1f2b3f7719b572). If that body changes, the gate could
-- miss a route and _job would answer NULL where the company-wide signature places a credit.
-- So _fast now falls back to context_job_story_credit_sig_main whenever that body differs, as
-- it already does for the cost, placement, allocation and parts views.
--
-- What this replaces: context_job_story_credit_sig_fast only (20261118170400's body, md5
-- 26bd02ef6d2b66bd87f58e40a4e3382d), one more OR line in its source check. Nothing else in the
-- body changes. If install_context_story_credit_sig_job() has already been run, the live name
-- context_job_story_credit_sig carries that same body, so it is re-derived from the new _fast
-- in the same transaction (as install does); otherwise the live name keeps its 20261031010000
-- body. While job_cost_bill_line_job_id is the 20261104063000 body, every answer is the same
-- as before. No table, index, trigger, timer or switch is created or changed.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Guards: the bodies this replaces, or this migration already applied. A different
-- job_cost_bill_line_job_id body is not refused here: _fast then gives _main's answer.
DO $guard$
DECLARE
 v_fast text;
 v_live text;
/* block */ BEGIN
 IF to_regprocedure('public.context_job_story_credit_sig_fast(uuid)') IS NULL
 OR to_regprocedure('public.context_job_story_credit_sig_main(uuid)') IS NULL
 OR to_regprocedure('public.context_job_story_credit_sig(uuid)') IS NULL THEN
  RAISE EXCEPTION 'credit_sig_bill_line_guard_missing_source';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_job_story_credit_sig_main(uuid)'::regprocedure)
    IS DISTINCT FROM 'a5d0f9f74c14ab88cc502f2d2ad98f27' THEN
  RAISE EXCEPTION 'credit_sig_bill_line_guard_main_copy_changed';
 END IF;
 v_fast := (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_job_story_credit_sig_fast(uuid)'::regprocedure);
 IF v_fast NOT IN ('26bd02ef6d2b66bd87f58e40a4e3382d', '9177840caa26158636d32d399bebb809') THEN
  RAISE EXCEPTION 'credit_sig_bill_line_guard_fast_changed';
 END IF;
 -- The live name: its 20261031010000 body, or the installed _fast body (old or new).
 v_live := (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_job_story_credit_sig(uuid)'::regprocedure);
 IF v_live NOT IN ('a5d0f9f74c14ab88cc502f2d2ad98f27', '26bd02ef6d2b66bd87f58e40a4e3382d', '9177840caa26158636d32d399bebb809') THEN
  RAISE EXCEPTION 'credit_sig_bill_line_guard_live_changed';
 END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.context_job_story_credit_sig_fast(p_job_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
/* function block */ BEGIN
 -- The gate's route list and the placed select were read from these bodies. feature_flags
 -- and the cutover singleton are read by their primary keys. The gate's 'SW' prefilter
 -- holds only while job_cost_bill_line_job_id is the 20261104063000 body.
 IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) IS DISTINCT FROM 'c2e9632718dfa057703f1ee36b97322e'
 OR md5(pg_get_viewdef('public.v_job_cost_events_legacy'::regclass, true)) IS DISTINCT FROM 'b48997c55913ce3c90e3a3c947533fd3'
 OR md5(pg_get_viewdef('public.v_supplier_credit_placement'::regclass, true)) IS DISTINCT FROM 'e9754f7c63e856eb80f4f6c240039323'
 OR md5(pg_get_viewdef('public.v_bookkeeping_line_parts_current'::regclass, true)) IS DISTINCT FROM '8d1e063dbf8e08524c6c3b2d6023b9c3'
 OR md5(pg_get_viewdef('public.v_supplier_credit_allocations'::regclass, true)) IS DISTINCT FROM '9684232cbb1c45e7564ce168971d800e'
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.job_cost_bill_line_job_id(text)'))
    IS DISTINCT FROM 'a543e41bc709d4a96d1f2b3f7719b572'
 OR (EXISTS (SELECT 1 FROM public.feature_flags f WHERE f.flag_name = 'job_cost_events_from_cost_lines_v1' AND f.enabled)
     AND EXISTS (SELECT 1 FROM public.job_cost_events_cutover c WHERE c.singleton AND c.completed_at IS NOT NULL)) THEN
  RETURN public.context_job_story_credit_sig_main(p_job_id);
 END IF;
 RETURN public.context_job_story_credit_sig_job(p_job_id);
EXCEPTION WHEN OTHERS THEN
 -- A changed source or a failed read gets exactly the company-wide answer (or its error).
 -- A cancel or statement timeout is not caught here.
 RETURN public.context_job_story_credit_sig_main(p_job_id);
END $fn$;

DO $post$
/* block */ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_job_story_credit_sig_fast(uuid)'::regprocedure)
    IS DISTINCT FROM '9177840caa26158636d32d399bebb809' THEN
  RAISE EXCEPTION 'credit_sig_bill_line_guard_postimage';
 END IF;
END $post$;

-- Installed already: the live name carries the old _fast body. Put the new one under it, as
-- install_context_story_credit_sig_job does, so remove still finds live = _fast.
DO $live$
DECLARE d text;
/* block */ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_job_story_credit_sig(uuid)'::regprocedure)
    IS DISTINCT FROM '26bd02ef6d2b66bd87f58e40a4e3382d' THEN RETURN; END IF;
 d := pg_get_functiondef('public.context_job_story_credit_sig_fast(uuid)'::regprocedure);
 EXECUTE replace(d, 'public.context_job_story_credit_sig_fast(', 'public.context_job_story_credit_sig(');
 IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.context_job_story_credit_sig(uuid)'::regprocedure) IS DISTINCT FROM
    (SELECT prosrc FROM pg_proc WHERE oid = 'public.context_job_story_credit_sig_fast(uuid)'::regprocedure) THEN
  RAISE EXCEPTION 'credit_sig_bill_line_guard_live_postimage';
 END IF;
END $live$;

COMMENT ON FUNCTION public.context_job_story_credit_sig_fast(uuid) IS
 'Follow-up 58 (20261118170400, with the bill-line guard): the body install_context_story_credit_sig_job puts under context_job_story_credit_sig. Uses context_job_story_credit_sig_job while v_job_cost_events, its legacy body, v_supplier_credit_placement, v_supplier_credit_allocations, v_bookkeeping_line_parts_current and job_cost_bill_line_job_id (whose match the gate''s SW prefilter assumes) are the definitions it was written against and the cost-lines cutover is not ready; otherwise, or on any error, context_job_story_credit_sig_main. Service role only.';
COMMENT ON FUNCTION public.install_context_story_credit_sig_job() IS
 'Follow-up 58 (20261118170400): puts context_job_story_credit_sig_fast''s body under context_job_story_credit_sig (money_sig and money_sig_stored call that name). Refuses unless the live body is 20261031010000''s (md5 a5d0f9f74c14ab88cc502f2d2ad98f27); a second run does nothing. Undo: remove_context_story_credit_sig_job(). A job none of whose credited bills can reach it answers without a cost read; a job with a reachable credited bill still pays about 0.9 s (one read of its cost rows).';
