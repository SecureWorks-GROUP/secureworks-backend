BEGIN;
SET LOCAL statement_timeout = '120s';
-- Rule 17: re-apply what this contract asserts when an earlier contract
-- removed it.
SELECT to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text,uuid)') IS NULL
  AS named_contract_needs_raise \gset
\if :named_contract_needs_raise
\ir ../20261118124439_context_reconcile_raise/setup.sql
\ir ../../../migrations/20261118124439_context_reconcile_raise.sql
\endif
SELECT to_regprocedure('public.reconcile_item_raise_named(text,text,text,uuid[],jsonb,jsonb,text,uuid)') IS NULL
  AS named_contract_needs_wrapper \gset
\if :named_contract_needs_wrapper
\ir ../../../migrations/20261118170200_reconcile_item_raise_named.sql
\endif
SET LOCAL statement_timeout = '120s';

-- Fixtures: one organisation, two jobs. Job numbers only.
INSERT INTO public.reconcile_item_kinds (kind, tab, words, card)
VALUES ('open_item_check', 'other', 'Open item to check', 'generic')
ON CONFLICT (kind) DO NOTHING;
INSERT INTO public.jobs(id, org_id, job_number, type, status) VALUES
 ('99902000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-0000000999a1', 'ZZTEST-99902-A1', 'fencing', 'accepted'),
 ('99902000-0000-4000-8000-0000000000a2', '00000000-0000-0000-0000-0000000999a1', 'ZZTEST-99902-A2', 'fencing', 'accepted');

-- 1. The wrapper's parameters carry names (what PostgREST matches on), and
--    the existing overloads were not touched (still positional).
DO $names$
/* block */ BEGIN
 IF (SELECT proargnames FROM pg_catalog.pg_proc
     WHERE oid = to_regprocedure('public.reconcile_item_raise_named(text,text,text,uuid[],jsonb,jsonb,text,uuid)'))
    IS DISTINCT FROM ARRAY['p_kind','p_subject_table','p_subject_id','p_job_ids',
                           'p_suggestion','p_evidence','p_raised_by','p_org_id']::text[] THEN
  RAISE EXCEPTION 'named raise: the wrapper must name its eight parameters in order';
 END IF;
 IF (SELECT pronargdefaults FROM pg_catalog.pg_proc
     WHERE oid = to_regprocedure('public.reconcile_item_raise_named(text,text,text,uuid[],jsonb,jsonb,text,uuid)')) <> 1 THEN
  RAISE EXCEPTION 'named raise: p_org_id must be the one optional parameter';
 END IF;
 IF (SELECT proargnames FROM pg_catalog.pg_proc
     WHERE oid = to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)')) IS NOT NULL
 OR (SELECT proargnames FROM pg_catalog.pg_proc
     WHERE oid = to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text,uuid)')) IS NOT NULL THEN
  RAISE EXCEPTION 'named raise: the existing overloads must stay positional';
 END IF;
 IF has_function_privilege('anon', 'public.reconcile_item_raise_named(text,text,text,uuid[],jsonb,jsonb,text,uuid)', 'EXECUTE')
 OR has_function_privilege('authenticated', 'public.reconcile_item_raise_named(text,text,text,uuid[],jsonb,jsonb,text,uuid)', 'EXECUTE')
 OR NOT has_function_privilege('service_role', 'public.reconcile_item_raise_named(text,text,text,uuid[],jsonb,jsonb,text,uuid)', 'EXECUTE') THEN
  RAISE EXCEPTION 'named raise: execute must be service_role only';
 END IF;
END $names$;

-- 2. A call with named arguments, as PostgREST sends it, as the service role:
--    seven names (no p_org_id) return an item id; the item is on the list in
--    the job's organisation; asking again returns the same open item.
SET LOCAL ROLE service_role;
SELECT public.reconcile_item_raise_named(
  p_kind => 'open_item_check',
  p_subject_table => 'jobs',
  p_subject_id => '99902000-0000-4000-8000-0000000000a1',
  p_job_ids => ARRAY['99902000-0000-4000-8000-0000000000a1']::uuid[],
  p_suggestion => '{"action":"look"}'::jsonb,
  p_evidence => '{"reason":"zz_named_call","amount_ex":12.50}'::jsonb,
  p_raised_by => 'migration') AS named_first \gset
SELECT public.reconcile_item_raise_named(
  p_raised_by => 'migration',
  p_evidence => '{"reason":"zz_named_call","amount_ex":12.50}'::jsonb,
  p_suggestion => '{"action":"look"}'::jsonb,
  p_job_ids => ARRAY['99902000-0000-4000-8000-0000000000a1']::uuid[],
  p_subject_id => '99902000-0000-4000-8000-0000000000a1',
  p_subject_table => 'jobs',
  p_kind => 'open_item_check') AS named_again \gset
-- With the eighth name too (the organisation resolves from the job, so it is
-- checked, not used).
SELECT public.reconcile_item_raise_named(
  p_kind => 'open_item_check',
  p_subject_table => 'jobs',
  p_subject_id => '99902000-0000-4000-8000-0000000000a2',
  p_job_ids => ARRAY['99902000-0000-4000-8000-0000000000a2']::uuid[],
  p_suggestion => NULL,
  p_evidence => '{"reason":"zz_named_org"}'::jsonb,
  p_raised_by => 'migration',
  p_org_id => '00000000-0000-0000-0000-0000000999a1') AS named_org \gset
RESET ROLE;
-- psql does not substitute variables inside a DO body, so hand them over.
SELECT set_config('zz_named.first', :'named_first', true),
       set_config('zz_named.again', :'named_again', true),
       set_config('zz_named.org', :'named_org', true);

DO $calls$
DECLARE
  v_first text := current_setting('zz_named.first');
  v_again text := current_setting('zz_named.again');
  v_org text := current_setting('zz_named.org');
/* block */ BEGIN
 IF v_first = '' OR NOT EXISTS (SELECT 1 FROM public.reconcile_items i
     WHERE i.id = v_first::uuid AND i.kind = 'open_item_check'
       AND i.subject_table = 'jobs' AND i.subject_id = '99902000-0000-4000-8000-0000000000a1'
       AND i.org_id = '00000000-0000-0000-0000-0000000999a1') THEN
  RAISE EXCEPTION 'named raise: a named call must return the id of the item it put on the list';
 END IF;
 IF v_again IS DISTINCT FROM v_first THEN
  RAISE EXCEPTION 'named raise: the same named call must return the same open item';
 END IF;
 IF v_org = '' OR NOT EXISTS (SELECT 1 FROM public.reconcile_items i
     WHERE i.id = v_org::uuid AND i.subject_id = '99902000-0000-4000-8000-0000000000a2') THEN
  RAISE EXCEPTION 'named raise: a call naming p_org_id must return an item id';
 END IF;
END $calls$;

-- 3. Refusals are reconcile_item_raise's own, unchanged.
DO $refuse$
DECLARE failed boolean := false;
/* block */ BEGIN
 BEGIN
  PERFORM public.reconcile_item_raise_named(
    p_kind => 'open_item_check', p_subject_table => 'jobs',
    p_subject_id => '99902000-0000-4000-8000-0000000000a1', p_job_ids => NULL,
    p_suggestion => NULL, p_evidence => '{}'::jsonb, p_raised_by => 'migration');
 EXCEPTION WHEN OTHERS THEN
  IF position('reconcile_reason_required' IN SQLERRM) = 0 THEN RAISE; END IF;
  failed := true;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'named raise: a missing reason must still refuse'; END IF;
END $refuse$;

SELECT 'PASS reconcile_item_raise_named: named call returns an item id, overloads untouched, service role only';
ROLLBACK;
