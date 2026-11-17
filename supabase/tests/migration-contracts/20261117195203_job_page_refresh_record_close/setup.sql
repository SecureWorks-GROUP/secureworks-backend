\ir ../20261117195201_context_ledger_record_candidates/setup.sql
SELECT to_regclass('public.job_pages') IS NULL AS record_needs_pages \gset
\if :record_needs_pages
-- The isolated case loads real mark/page storage and queue logic.
\ir ../../../migrations/20261117171302_job_change_marks.sql
\ir ../../../migrations/20261117171304_job_pages.sql
\ir ../../../migrations/20261117172503_job_pages_queue_safety.sql
-- Stand-ins only for the wider story stack, which the full registered stack supplies.
CREATE FUNCTION public.context_job_story(p_job_id uuid,p_as_of timestamptz DEFAULT now(),p_generation_id uuid DEFAULT NULL,p_since timestamptz DEFAULT NULL,p_record_only boolean DEFAULT false) RETURNS jsonb LANGUAGE sql AS $s$
 SELECT jsonb_build_object('loops',coalesce(jsonb_agg(jsonb_build_object('id',id,'status',status)) FILTER(WHERE status='open'),'[]'))
 FROM public.context_ledger_items WHERE job_id=p_job_id
$s$;
CREATE FUNCTION public.context_job_story_text_get(uuid,jsonb,boolean) RETURNS jsonb LANGUAGE sql AS $s$ SELECT '{"status":"fresh","card_hash":"fixture"}'::jsonb $s$;
\endif

-- The absent phase-4 Reconcile adapter is a price-free idempotent stand-in
-- only in the standalone stack. Full-stack runs keep the real adapter.
SELECT to_regprocedure('public.context_reconcile_raise(text,uuid,text,text,jsonb,text)') IS NULL
 AND to_regprocedure('public.context_reconcile_raise(text,uuid,text,text,jsonb)') IS NULL AS record_needs_queue \gset
\if :record_needs_queue
CREATE TABLE IF NOT EXISTS public.record_close_fixture_queue(subject text PRIMARY KEY,suggestions jsonb,open boolean DEFAULT true);
CREATE FUNCTION public.context_reconcile_raise(text,uuid,text,text,jsonb) RETURNS uuid LANGUAGE plpgsql AS $s$
BEGIN
 INSERT INTO public.record_close_fixture_queue(subject,suggestions) VALUES($3,$5)
 ON CONFLICT(subject) DO NOTHING; RETURN NULL;
END $s$;
CREATE FUNCTION public.context_reconcile_withdraw(text,text,text) RETURNS void LANGUAGE sql AS $s$
 UPDATE public.record_close_fixture_queue SET open=false WHERE subject=$2
$s$;
\endif
