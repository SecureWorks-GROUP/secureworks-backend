-- Contract: 20261019210000_fence_quote_option_jobs. Options are grouped only by
-- link_fence_quote_option, for open fencing jobs of one customer; accepting one option marks its
-- open siblings superseded (pointer, time, one job_event each) with the switch on, and nothing
-- with it off; a sibling past quoted, crewed or invoiced is left alone; a deliberate repeat job
-- (no group) is never touched; no job status is changed by the migration's own code.
\set ON_ERROR_STOP on
CREATE FUNCTION pg_temp.qo_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'fence quote option contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.qo_refused(p_sql text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE p_sql;
 RETURN false;
EXCEPTION WHEN invalid_parameter_value OR check_violation THEN
 RETURN true;
END $$;

SELECT pg_temp.qo_assert((SELECT enabled = false FROM public.feature_flags
  WHERE flag_name = 'quote_option_supersede_v1'), 'the supersede switch must be seeded off');
SELECT pg_temp.qo_assert(NOT has_function_privilege('public', 'public.link_fence_quote_option(uuid, uuid, text, uuid)', 'EXECUTE'),
 'the link function must not be executable by PUBLIC');

BEGIN;
-- One customer (c-1) at one site: A (first quote), B and C (options), D (a deliberate repeat, not
-- grouped), E (an option already crewed), F (an option already invoiced). Another customer: X.
INSERT INTO public.jobs (id, org_id, status, type, ghl_contact_id) VALUES
 ('9c000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-1'),
 ('9c000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-1'),
 ('9c000000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000001', 'draft', 'fencing', 'c-1'),
 ('9c000000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-1'),
 ('9c000000-0000-4000-8000-00000000000e', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-1'),
 ('9c000000-0000-4000-8000-00000000000f', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-1'),
 ('9c000000-0000-4000-8000-0000000000ff', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-2');

SELECT pg_temp.qo_assert(public.link_fence_quote_option('9c000000-0000-4000-8000-00000000000b',
  '9c000000-0000-4000-8000-00000000000a', 'Option B', NULL) = '9c000000-0000-4000-8000-00000000000a',
 'linking B to A must return A as the group');
-- Idempotent, and an option of an option joins the same group.
SELECT pg_temp.qo_assert(public.link_fence_quote_option('9c000000-0000-4000-8000-00000000000b',
  '9c000000-0000-4000-8000-00000000000a', 'Option B', NULL) = '9c000000-0000-4000-8000-00000000000a',
 'linking B to A again must be a no-op');
SELECT pg_temp.qo_assert(public.link_fence_quote_option('9c000000-0000-4000-8000-00000000000c',
  '9c000000-0000-4000-8000-00000000000b', 'Option C', NULL) = '9c000000-0000-4000-8000-00000000000a',
 'an option of B must join A''s group');
SELECT public.link_fence_quote_option('9c000000-0000-4000-8000-00000000000e', '9c000000-0000-4000-8000-00000000000a', NULL, NULL);
SELECT public.link_fence_quote_option('9c000000-0000-4000-8000-00000000000f', '9c000000-0000-4000-8000-00000000000a', NULL, NULL);
SELECT pg_temp.qo_assert((SELECT count(*) FROM public.job_events WHERE event_type = 'quote_option_linked'
  AND job_id::text LIKE '9c000000-%') = 4, 'one quote_option_linked event per new link, none for the no-op');
-- Refusals: another customer, itself, a job that is not open.
SELECT pg_temp.qo_assert(pg_temp.qo_refused($q$
 SELECT public.link_fence_quote_option('9c000000-0000-4000-8000-0000000000ff', '9c000000-0000-4000-8000-00000000000a', NULL, NULL)
$q$), 'another customer''s job must not join the group');
-- A job already past quoted is never made an option.
INSERT INTO public.jobs (id, org_id, status, type, ghl_contact_id)
VALUES ('9c000000-0000-4000-8000-0000000000a9', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'c-1');
SELECT pg_temp.qo_assert(pg_temp.qo_refused($q$
 SELECT public.link_fence_quote_option('9c000000-0000-4000-8000-0000000000a9', '9c000000-0000-4000-8000-00000000000a', NULL, NULL)
$q$), 'a completed job must not be linked as an option');
-- One party of a shared fence accepting does not decide between options.
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'quote_option_supersede_v1';
UPDATE public.jobs SET status = 'partially_accepted' WHERE id = '9c000000-0000-4000-8000-00000000000c';
SELECT pg_temp.qo_assert((SELECT count(*) FROM public.jobs WHERE superseded_at IS NOT NULL
  AND id::text LIKE '9c000000-%') = 0, 'partially_accepted must supersede nothing');
UPDATE public.jobs SET status = 'draft' WHERE id = '9c000000-0000-4000-8000-00000000000c';
UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'quote_option_supersede_v1';
SELECT pg_temp.qo_assert(pg_temp.qo_refused($q$
 SELECT public.link_fence_quote_option('9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-00000000000a', NULL, NULL)
$q$), 'a job must not be its own option');

INSERT INTO public.job_assignments (id, job_id) VALUES ('9c000000-0000-4000-8000-0000000000e1', '9c000000-0000-4000-8000-00000000000e');
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_type, job_id, status)
VALUES ('00000000-0000-0000-0000-000000000001', '9c-fixture-invoice', 'ACCREC', '9c000000-0000-4000-8000-00000000000f', 'AUTHORISED');

-- Switch off: accepting B supersedes nothing.
UPDATE public.jobs SET status = 'accepted' WHERE id = '9c000000-0000-4000-8000-00000000000b';
SELECT pg_temp.qo_assert((SELECT count(*) FROM public.jobs WHERE superseded_at IS NOT NULL
  AND id::text LIKE '9c000000-%') = 0, 'with the switch off nothing is superseded');
UPDATE public.jobs SET status = 'quoted' WHERE id = '9c000000-0000-4000-8000-00000000000b';

-- Switch on: accepting B supersedes A and C only.
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'quote_option_supersede_v1';
UPDATE public.jobs SET status = 'accepted' WHERE id = '9c000000-0000-4000-8000-00000000000b';
SELECT pg_temp.qo_assert((SELECT array_agg(right(id::text, 1) ORDER BY id) FROM public.jobs
  WHERE superseded_by_job_id = '9c000000-0000-4000-8000-00000000000b') = ARRAY['a', 'c'],
 'accepting B must supersede exactly the open, uncrewed, uninvoiced options A and C');
SELECT pg_temp.qo_assert((SELECT bool_and(superseded_at IS NOT NULL) FROM public.jobs
  WHERE superseded_by_job_id = '9c000000-0000-4000-8000-00000000000b'), 'each superseded job carries its time');
SELECT pg_temp.qo_assert((SELECT array_agg(status ORDER BY id) FROM public.jobs
  WHERE id IN ('9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-00000000000c')) = ARRAY['quoted', 'draft'],
 'superseding must not change a job''s status');
SELECT pg_temp.qo_assert((SELECT count(*) FROM public.job_events WHERE event_type = 'quote_option_superseded'
  AND detail_json->>'superseded_by_job_id' = '9c000000-0000-4000-8000-00000000000b') = 2,
 'one quote_option_superseded event per superseded option');
SELECT pg_temp.qo_assert((SELECT superseded_at IS NULL FROM public.jobs WHERE id = '9c000000-0000-4000-8000-00000000000d'),
 'a deliberate repeat job (no group) must never be superseded');
SELECT pg_temp.qo_assert((SELECT bool_and(superseded_at IS NULL) FROM public.jobs
  WHERE id IN ('9c000000-0000-4000-8000-00000000000e', '9c000000-0000-4000-8000-00000000000f')),
 'a crewed or invoiced option must be left for a person');
SELECT pg_temp.qo_assert((SELECT array_agg(detail_json->>'reason' ORDER BY job_id) FROM public.job_events
  WHERE event_type = 'quote_option_review_needed'
    AND job_id IN ('9c000000-0000-4000-8000-00000000000e', '9c000000-0000-4000-8000-00000000000f')) = ARRAY['crewed', 'invoiced'],
 'a crewed or invoiced option must be flagged for review, not superseded');
-- The group is decided: no new options, and a progressed job is never linked.
SELECT pg_temp.qo_assert(pg_temp.qo_refused($q$
 SELECT public.link_fence_quote_option('9c000000-0000-4000-8000-00000000000d', '9c000000-0000-4000-8000-00000000000e', NULL, NULL)
$q$), 'a decided group must take no new options');
-- The client accepts superseded A anyway: acceptance stands, A's mark clears, a person is told.
UPDATE public.jobs SET status = 'accepted' WHERE id = '9c000000-0000-4000-8000-00000000000a';
SELECT pg_temp.qo_assert((SELECT status = 'accepted' AND superseded_at IS NULL AND superseded_by_job_id IS NULL
  FROM public.jobs WHERE id = '9c000000-0000-4000-8000-00000000000a'),
 'a superseded option the client accepts must be accepted and no longer marked');
SELECT pg_temp.qo_assert(EXISTS (SELECT 1 FROM public.job_events WHERE job_id = '9c000000-0000-4000-8000-00000000000a'
  AND event_type = 'quote_option_review_needed' AND detail_json->>'reason' = 'accepted_after_superseded'),
 'a late acceptance of a superseded option must be flagged for review');
-- A superseded option cannot be linked again, and the shape holds.
SELECT pg_temp.qo_assert(pg_temp.qo_refused($q$
 SELECT public.link_fence_quote_option('9c000000-0000-4000-8000-00000000000d', '9c000000-0000-4000-8000-00000000000a', NULL, NULL)
$q$), 'a superseded job must not take new options (A was superseded)');
SELECT pg_temp.qo_assert(pg_temp.qo_refused($q$
 UPDATE public.jobs SET superseded_at = NULL WHERE id = '9c000000-0000-4000-8000-00000000000a'
$q$), 'a superseded pointer without its time must be refused');
ROLLBACK;
