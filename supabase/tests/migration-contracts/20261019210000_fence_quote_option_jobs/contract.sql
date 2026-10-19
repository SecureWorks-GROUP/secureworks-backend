-- Contract: 20261019210000_fence_quote_option_jobs. Options are grouped only by
-- link_fence_quote_option, for open fencing jobs of one customer. With the switch on, accepting
-- one option marks its open siblings superseded (pointer, time, one job_event each), and with it
-- off nothing. A sibling crewed or invoiced is left alone; a deliberate repeat job (no group) is
-- never touched; no job status is changed by the migration's own code. CIO decisions (19 Oct):
-- reversal back to quoted clears the marks with an unsuperseded event each; lost keeps them for
-- review; two options won at once leave every option live; a failed mark (including a cancel)
-- leaves a review event and the acceptance stands; every cleared pointer closes its interval with
-- an event. Concurrency (two sessions) is not provable in this single-session runner.
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
-- Events of one type (and optional reason) on one job.
CREATE FUNCTION pg_temp.qo_events(p_job uuid, p_type text, p_reason text DEFAULT NULL) RETURNS bigint
LANGUAGE sql AS $$
 SELECT count(*) FROM public.job_events
  WHERE job_id = p_job AND event_type = p_type
    AND (p_reason IS NULL OR detail_json->>'reason' = p_reason)
$$;

SELECT pg_temp.qo_assert((SELECT enabled = false FROM public.feature_flags
  WHERE flag_name = 'quote_option_supersede_v1'), 'the supersede switch must be seeded off');
SELECT pg_temp.qo_assert((SELECT enabled = false FROM public.feature_flags
  WHERE flag_name = 'fence_same_site_guard_v1'), 'the same-site guard switch must be seeded off');
SELECT pg_temp.qo_assert(NOT has_function_privilege('public', 'public.link_fence_quote_option(uuid, uuid, text, uuid)', 'EXECUTE'),
 'the link function must not be executable by PUBLIC');
SELECT pg_temp.qo_assert(has_function_privilege('service_role', 'public.link_fence_quote_option(uuid, uuid, text, uuid)', 'EXECUTE')
 AND NOT has_function_privilege('authenticated', 'public.link_fence_quote_option(uuid, uuid, text, uuid)', 'EXECUTE')
 AND NOT has_function_privilege('anon', 'public.link_fence_quote_option(uuid, uuid, text, uuid)', 'EXECUTE'),
 'the link function must be the service role''s only');
SELECT pg_temp.qo_assert(NOT EXISTS (
  SELECT 1 FROM unnest(ARRAY['public', 'anon', 'authenticated', 'service_role']) r(role),
       unnest(ARRAY['public.fence_quote_option_mark_options(uuid, text, uuid, uuid[])',
                    'public.fence_quote_option_clear_mark(uuid, text, uuid, uuid)']) f(fn)
   WHERE has_function_privilege(r.role, f.fn, 'EXECUTE')),
 'the mark and clear helpers must not be callable directly by any API role');
SELECT pg_temp.qo_assert((SELECT count(*) = 3
   AND bool_and(coalesce(p.prosecdef, false))
   AND bool_and(coalesce(p.proconfig @> ARRAY['search_path=public, pg_temp'], false))
  FROM pg_proc p
  WHERE p.oid IN ('public.jobs_quote_option_supersede()'::regprocedure,
    'public.fence_quote_option_mark_options(uuid, text, uuid, uuid[])'::regprocedure,
    'public.fence_quote_option_clear_mark(uuid, text, uuid, uuid)'::regprocedure)),
 'the trigger and its helpers must run as their owner with a fixed search_path');
SELECT pg_temp.qo_assert(NOT EXISTS (SELECT 1 FROM pg_trigger
  WHERE tgrelid = 'public.quote_option_settle_runs'::regclass AND NOT tgisinternal),
 'the run table must have no triggers');
SELECT pg_temp.qo_assert(has_table_privilege('service_role', 'public.quote_option_settle_runs', 'SELECT')
 AND NOT has_table_privilege('service_role', 'public.quote_option_settle_runs', 'DELETE')
 AND NOT has_table_privilege('service_role', 'public.quote_option_settle_runs', 'INSERT')
 AND NOT has_table_privilege('authenticated', 'public.quote_option_settle_runs', 'SELECT')
 AND NOT has_table_privilege('anon', 'public.quote_option_settle_runs', 'SELECT')
 AND NOT has_table_privilege('public', 'public.quote_option_settle_runs', 'SELECT')
 AND NOT has_table_privilege('service_role', 'public.quote_option_settle_runs', 'TRUNCATE')
 AND NOT has_table_privilege('service_role', 'public.quote_option_settle_runs', 'UPDATE')
 AND has_column_privilege('service_role', 'public.quote_option_settle_runs', 'resolved_at', 'UPDATE')
 AND has_column_privilege('service_role', 'public.quote_option_settle_runs', 'resolved_by', 'UPDATE')
 AND NOT has_column_privilege('service_role', 'public.quote_option_settle_runs', 'settled_at', 'UPDATE')
 AND NOT has_column_privilege('service_role', 'public.quote_option_settle_runs', 'sqlstate', 'UPDATE'),
 'the run table must be read and resolved by the service role only, never inserted, edited or deleted');
SELECT pg_temp.qo_assert((SELECT NOT relrowsecurity AND NOT relforcerowsecurity FROM pg_class
  WHERE oid = 'public.quote_option_settle_runs'::regclass), 'the run table must have no row level security');

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
INSERT INTO public.jobs (id, org_id, status, type, ghl_contact_id)
VALUES ('9c000000-0000-4000-8000-0000000000a9', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'c-1');
SELECT pg_temp.qo_assert(pg_temp.qo_refused($q$
 SELECT public.link_fence_quote_option('9c000000-0000-4000-8000-0000000000a9', '9c000000-0000-4000-8000-00000000000a', NULL, NULL)
$q$), 'a completed job must not be linked as an option');
SELECT pg_temp.qo_assert(pg_temp.qo_refused($q$
 SELECT public.link_fence_quote_option('9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-00000000000a', NULL, NULL)
$q$), 'a job must not be its own option');
-- One party of a shared fence accepting does not decide between options.
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'quote_option_supersede_v1';
UPDATE public.jobs SET status = 'partially_accepted' WHERE id = '9c000000-0000-4000-8000-00000000000c';
SELECT pg_temp.qo_assert((SELECT count(*) FROM public.jobs WHERE superseded_at IS NOT NULL
  AND id::text LIKE '9c000000-%') = 0, 'partially_accepted must supersede nothing');
UPDATE public.jobs SET status = 'draft' WHERE id = '9c000000-0000-4000-8000-00000000000c';
UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'quote_option_supersede_v1';

INSERT INTO public.job_assignments (id, job_id) VALUES ('9c000000-0000-4000-8000-0000000000e1', '9c000000-0000-4000-8000-00000000000e');
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_type, job_id, status)
VALUES ('00000000-0000-0000-0000-000000000001', '9c-fixture-invoice', 'ACCREC', '9c000000-0000-4000-8000-00000000000f', 'AUTHORISED');

-- Switch off: accepting B supersedes nothing.
UPDATE public.jobs SET status = 'accepted' WHERE id = '9c000000-0000-4000-8000-00000000000b';
SELECT pg_temp.qo_assert((SELECT count(*) FROM public.jobs WHERE superseded_at IS NOT NULL
  AND id::text LIKE '9c000000-%') = 0, 'with the switch off nothing is superseded');
UPDATE public.jobs SET status = 'quoted' WHERE id = '9c000000-0000-4000-8000-00000000000b';

-- One accepted option. Switch on: accepting B supersedes A and C only.
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
SELECT pg_temp.qo_assert(pg_temp.qo_events('9c000000-0000-4000-8000-00000000000e', 'quote_option_review_needed', 'crewed') = 1
 AND pg_temp.qo_events('9c000000-0000-4000-8000-00000000000f', 'quote_option_review_needed', 'invoiced') = 1,
 'a crewed or invoiced option must be flagged for review, not superseded');
-- The group is decided: no new options.
SELECT pg_temp.qo_assert(pg_temp.qo_refused($q$
 SELECT public.link_fence_quote_option('9c000000-0000-4000-8000-00000000000d', '9c000000-0000-4000-8000-00000000000e', NULL, NULL)
$q$), 'a decided group must take no new options');

-- Reversal back to quoted: A and C are live again, each with a closing event.
UPDATE public.jobs SET status = 'quoted' WHERE id = '9c000000-0000-4000-8000-00000000000b';
SELECT pg_temp.qo_assert((SELECT count(*) FROM public.jobs WHERE superseded_at IS NOT NULL
  AND id::text LIKE '9c000000-%') = 0, 'reversing B back to quoted must clear every mark B made');
SELECT pg_temp.qo_assert(pg_temp.qo_events('9c000000-0000-4000-8000-00000000000a', 'quote_option_unsuperseded', 'acceptance_reversed') = 1
 AND pg_temp.qo_events('9c000000-0000-4000-8000-00000000000c', 'quote_option_unsuperseded', 'acceptance_reversed') = 1,
 'each cleared mark must close its interval with a quote_option_unsuperseded event');

-- Accepted, then lost: the marks stay and a person is told.
UPDATE public.jobs SET status = 'accepted' WHERE id = '9c000000-0000-4000-8000-00000000000b';
UPDATE public.jobs SET status = 'lost' WHERE id = '9c000000-0000-4000-8000-00000000000b';
SELECT pg_temp.qo_assert((SELECT array_agg(right(id::text, 1) ORDER BY id) FROM public.jobs
  WHERE superseded_by_job_id = '9c000000-0000-4000-8000-00000000000b') = ARRAY['a', 'c'],
 'an accepted job going to lost must not revive the options it superseded');
SELECT pg_temp.qo_assert(pg_temp.qo_events('9c000000-0000-4000-8000-00000000000b', 'quote_option_review_needed', 'accepted_job_lost') = 1,
 'an accepted job going to lost must leave a review event');

-- The client then accepts superseded A (its superseder is lost): A is the winner, its own mark
-- clears with a closing event, and a person is told. C stays superseded.
UPDATE public.jobs SET status = 'accepted' WHERE id = '9c000000-0000-4000-8000-00000000000a';
SELECT pg_temp.qo_assert((SELECT status = 'accepted' AND superseded_at IS NULL AND superseded_by_job_id IS NULL
  FROM public.jobs WHERE id = '9c000000-0000-4000-8000-00000000000a'),
 'a superseded option the client accepts must be accepted and no longer marked');
SELECT pg_temp.qo_assert(pg_temp.qo_events('9c000000-0000-4000-8000-00000000000a', 'quote_option_review_needed', 'accepted_after_superseded') = 1
 AND pg_temp.qo_events('9c000000-0000-4000-8000-00000000000a', 'quote_option_unsuperseded', 'accepted_after_superseded') = 1,
 'a late acceptance of a superseded option must close its interval and be flagged for review');
SELECT pg_temp.qo_assert((SELECT superseded_by_job_id = '9c000000-0000-4000-8000-00000000000b'
  FROM public.jobs WHERE id = '9c000000-0000-4000-8000-00000000000c'), 'C must stay superseded');
-- A superseded option takes no new options, and the shape holds (C is superseded now).
SELECT pg_temp.qo_assert(pg_temp.qo_refused($q$
 SELECT public.link_fence_quote_option('9c000000-0000-4000-8000-00000000000d', '9c000000-0000-4000-8000-00000000000c', NULL, NULL)
$q$), 'a superseded job must not take new options');
SELECT pg_temp.qo_assert(pg_temp.qo_refused($q$
 UPDATE public.jobs SET superseded_at = NULL WHERE id = '9c000000-0000-4000-8000-00000000000c'
$q$), 'a superseded pointer without its time must be refused');

-- Two options won at once (customer c-3: P, Q, R). Accepting P supersedes Q and R; accepting Q
-- as well leaves every option live and flags the group. P then lost: Q is the one winner, so the
-- normal rule supersedes R by Q.
INSERT INTO public.jobs (id, org_id, status, type, ghl_contact_id) VALUES
 ('9c000000-0000-4000-8000-0000000000b1', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-3'),
 ('9c000000-0000-4000-8000-0000000000b2', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-3'),
 ('9c000000-0000-4000-8000-0000000000b3', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-3');
SELECT public.link_fence_quote_option('9c000000-0000-4000-8000-0000000000b2', '9c000000-0000-4000-8000-0000000000b1', NULL, NULL);
SELECT public.link_fence_quote_option('9c000000-0000-4000-8000-0000000000b3', '9c000000-0000-4000-8000-0000000000b1', NULL, NULL);
UPDATE public.jobs SET status = 'accepted' WHERE id = '9c000000-0000-4000-8000-0000000000b1';
UPDATE public.jobs SET status = 'accepted' WHERE id = '9c000000-0000-4000-8000-0000000000b2';
SELECT pg_temp.qo_assert((SELECT count(*) FROM public.jobs WHERE superseded_at IS NOT NULL
  AND quote_option_group_id = '9c000000-0000-4000-8000-0000000000b1') = 0,
 'two options won at once must leave every option live');
SELECT pg_temp.qo_assert(pg_temp.qo_events('9c000000-0000-4000-8000-0000000000b2', 'quote_option_review_needed', 'more_than_one_option_won') = 1,
 'two options won at once must leave one review event');
SELECT pg_temp.qo_assert(pg_temp.qo_events('9c000000-0000-4000-8000-0000000000b3', 'quote_option_unsuperseded', 'more_than_one_option_won') = 1,
 'clearing R''s mark when a second option is won must close its interval');
UPDATE public.jobs SET status = 'lost' WHERE id = '9c000000-0000-4000-8000-0000000000b1';
SELECT pg_temp.qo_assert((SELECT superseded_by_job_id = '9c000000-0000-4000-8000-0000000000b2'
  FROM public.jobs WHERE id = '9c000000-0000-4000-8000-0000000000b3')
 AND (SELECT superseded_at IS NULL FROM public.jobs WHERE id = '9c000000-0000-4000-8000-0000000000b1'),
 'once exactly one option is won, the normal rule must apply to it');

-- A failed mark (customer c-4: S, T, U). A forced error while marking U rolls back the
-- trigger's work only: S stays accepted, T's mark is undone, and a review event records it. Run
-- once as a cancel (57014, not caught by WHEN OTHERS) and once as an ordinary error.
INSERT INTO public.jobs (id, org_id, status, type, ghl_contact_id) VALUES
 ('9c000000-0000-4000-8000-0000000000c1', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-4'),
 ('9c000000-0000-4000-8000-0000000000c2', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-4'),
 ('9c000000-0000-4000-8000-0000000000c3', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-4');
SELECT public.link_fence_quote_option('9c000000-0000-4000-8000-0000000000c2', '9c000000-0000-4000-8000-0000000000c1', NULL, NULL);
SELECT public.link_fence_quote_option('9c000000-0000-4000-8000-0000000000c3', '9c000000-0000-4000-8000-0000000000c1', NULL, NULL);
CREATE FUNCTION public.qo_contract_fail() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'contract forced failure' USING ERRCODE = TG_ARGV[0]; END $$;
CREATE TRIGGER qo_contract_fail BEFORE UPDATE OF superseded_at ON public.jobs FOR EACH ROW
 WHEN (NEW.id = '9c000000-0000-4000-8000-0000000000c3' AND NEW.superseded_at IS NOT NULL)
 EXECUTE FUNCTION public.qo_contract_fail('57014');
UPDATE public.jobs SET status = 'accepted' WHERE id = '9c000000-0000-4000-8000-0000000000c1';
SELECT pg_temp.qo_assert((SELECT status = 'accepted' FROM public.jobs WHERE id = '9c000000-0000-4000-8000-0000000000c1'),
 'a cancel inside the trigger must not undo the acceptance');
SELECT pg_temp.qo_assert((SELECT count(*) FROM public.jobs WHERE superseded_at IS NOT NULL
  AND quote_option_group_id = '9c000000-0000-4000-8000-0000000000c1') = 0
 AND pg_temp.qo_events('9c000000-0000-4000-8000-0000000000c2', 'quote_option_superseded') = 0,
 'a failed mark must roll back the trigger''s marks and events together');
SELECT pg_temp.qo_assert((SELECT count(*) FROM public.job_events WHERE job_id = '9c000000-0000-4000-8000-0000000000c1'
  AND event_type = 'quote_option_review_needed' AND detail_json->>'reason' = 'supersede_failed'
  AND detail_json->>'sqlstate' = '57014') = 1, 'a cancelled mark must leave a durable review event');
UPDATE public.jobs SET status = 'quoted' WHERE id = '9c000000-0000-4000-8000-0000000000c1';
DROP TRIGGER qo_contract_fail ON public.jobs;
CREATE TRIGGER qo_contract_fail BEFORE UPDATE OF superseded_at ON public.jobs FOR EACH ROW
 WHEN (NEW.id = '9c000000-0000-4000-8000-0000000000c3' AND NEW.superseded_at IS NOT NULL)
 EXECUTE FUNCTION public.qo_contract_fail('P0001');
UPDATE public.jobs SET status = 'accepted' WHERE id = '9c000000-0000-4000-8000-0000000000c1';
SELECT pg_temp.qo_assert((SELECT count(*) FROM public.job_events WHERE job_id = '9c000000-0000-4000-8000-0000000000c1'
  AND event_type = 'quote_option_review_needed' AND detail_json->>'reason' = 'supersede_failed'
  AND detail_json->>'sqlstate' = 'P0001') = 1, 'an ordinary error in a mark must leave a durable review event');
-- If even the review event cannot be written, the status change still stands (send-quote has
-- already committed the customer's acceptance), the trigger's marks roll back, and a row in the
-- last-resort table records it. Group 4: customer c-5, V and W.
INSERT INTO public.jobs (id, org_id, status, type, ghl_contact_id) VALUES
 ('9c000000-0000-4000-8000-0000000000d1', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-5'),
 ('9c000000-0000-4000-8000-0000000000d2', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-5');
SELECT public.link_fence_quote_option('9c000000-0000-4000-8000-0000000000d2', '9c000000-0000-4000-8000-0000000000d1', NULL, NULL);
DROP TRIGGER qo_contract_fail ON public.jobs;
CREATE TRIGGER qo_contract_fail BEFORE UPDATE OF superseded_at ON public.jobs FOR EACH ROW
 WHEN (NEW.id = '9c000000-0000-4000-8000-0000000000d2' AND NEW.superseded_at IS NOT NULL)
 EXECUTE FUNCTION public.qo_contract_fail('P0001');
CREATE FUNCTION public.qo_contract_fail_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.event_type = 'quote_option_review_needed' THEN RAISE EXCEPTION 'contract forced event failure'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER qo_contract_fail_event BEFORE INSERT ON public.job_events FOR EACH ROW
 EXECUTE FUNCTION public.qo_contract_fail_event();
UPDATE public.jobs SET status = 'accepted' WHERE id = '9c000000-0000-4000-8000-0000000000d1';
SELECT pg_temp.qo_assert((SELECT status = 'accepted' FROM public.jobs WHERE id = '9c000000-0000-4000-8000-0000000000d1'),
 'a status change whose failure could not be recorded must still stand');
SELECT pg_temp.qo_assert((SELECT superseded_at IS NULL FROM public.jobs WHERE id = '9c000000-0000-4000-8000-0000000000d2')
 AND pg_temp.qo_events('9c000000-0000-4000-8000-0000000000d2', 'quote_option_superseded') = 0,
 'an unrecorded failure must roll back the trigger''s marks and events');
SELECT pg_temp.qo_assert((SELECT count(*) FROM public.quote_option_settle_runs
  WHERE job_id = '9c000000-0000-4000-8000-0000000000d1'
    AND quote_option_group_id = '9c000000-0000-4000-8000-0000000000d1'
    AND status = 'accepted' AND settled_at IS NULL AND sqlstate = 'P0001' AND review_sqlstate = 'P0001'
    AND resolved_at IS NULL) = 1,
 'a run whose work and review event both failed must stay on record, unsettled, with both reasons');
-- A later failure in a group with older review events is still recorded (no history suppresses it).
UPDATE public.jobs SET status = 'quoted' WHERE id = '9c000000-0000-4000-8000-0000000000d1';
UPDATE public.jobs SET status = 'accepted' WHERE id = '9c000000-0000-4000-8000-0000000000d1';
SELECT pg_temp.qo_assert((SELECT count(*) FROM public.quote_option_settle_runs
  WHERE job_id = '9c000000-0000-4000-8000-0000000000d1' AND settled_at IS NULL) = 2
 AND (SELECT count(*) FROM public.quote_option_settle_runs
  WHERE job_id = '9c000000-0000-4000-8000-0000000000d1' AND settled_at IS NOT NULL) = 1,
 'every failed run must stay unsettled on its own row, and the clean reversal must settle');
-- The second-winner case: E1 is accepted and marks E2 and E3. E2 is then accepted too, so the
-- trigger must clear every mark, but clearing E3 fails and so does the review event. E2's
-- acceptance stands, the marks stay as they were, and the run is on record, unsettled.
INSERT INTO public.jobs (id, org_id, status, type, ghl_contact_id) VALUES
 ('9c000000-0000-4000-8000-0000000000e7', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-6'),
 ('9c000000-0000-4000-8000-0000000000e8', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-6'),
 ('9c000000-0000-4000-8000-0000000000e9', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-6');
SELECT public.link_fence_quote_option('9c000000-0000-4000-8000-0000000000e8', '9c000000-0000-4000-8000-0000000000e7', NULL, NULL);
SELECT public.link_fence_quote_option('9c000000-0000-4000-8000-0000000000e9', '9c000000-0000-4000-8000-0000000000e7', NULL, NULL);
DROP TRIGGER qo_contract_fail_event ON public.job_events;
UPDATE public.jobs SET status = 'accepted' WHERE id = '9c000000-0000-4000-8000-0000000000e7';
SELECT pg_temp.qo_assert((SELECT count(*) FROM public.jobs
  WHERE superseded_by_job_id = '9c000000-0000-4000-8000-0000000000e7') = 2, 'E1 must mark E2 and E3');
CREATE TRIGGER qo_contract_fail_event BEFORE INSERT ON public.job_events FOR EACH ROW
 EXECUTE FUNCTION public.qo_contract_fail_event();
DROP TRIGGER qo_contract_fail ON public.jobs;
CREATE TRIGGER qo_contract_fail BEFORE UPDATE OF superseded_at ON public.jobs FOR EACH ROW
 WHEN (NEW.id = '9c000000-0000-4000-8000-0000000000e9' AND NEW.superseded_at IS NULL)
 EXECUTE FUNCTION public.qo_contract_fail('P0001');
UPDATE public.jobs SET status = 'accepted' WHERE id = '9c000000-0000-4000-8000-0000000000e8';
SELECT pg_temp.qo_assert((SELECT status = 'accepted' AND superseded_by_job_id = '9c000000-0000-4000-8000-0000000000e7'
  FROM public.jobs WHERE id = '9c000000-0000-4000-8000-0000000000e8')
 AND (SELECT superseded_by_job_id = '9c000000-0000-4000-8000-0000000000e7'
  FROM public.jobs WHERE id = '9c000000-0000-4000-8000-0000000000e9'),
 'a failed second-winner run must keep the status change and leave the marks as they were');
SELECT pg_temp.qo_assert((SELECT count(*) FROM public.quote_option_settle_runs
  WHERE job_id = '9c000000-0000-4000-8000-0000000000e8' AND settled_at IS NULL AND sqlstate = 'P0001') = 1,
 'a failed second-winner run must stay on record, unsettled');
DROP TRIGGER qo_contract_fail_event ON public.job_events;
DROP FUNCTION public.qo_contract_fail_event();
DROP TRIGGER qo_contract_fail ON public.jobs;
DROP FUNCTION public.qo_contract_fail();

-- The switch fails closed. With the switch false, NULL (where the column allows it) or missing,
-- or set true but with its read raising (a cancel or statement timeout 57014, a permission error
-- 42501, a lock timeout 55P03, a missing table 42P01, an ordinary error P0001, an assert failure
-- P0004), accepting an option and reversing it write no pointer, no job_event and no run record,
-- and the acceptance stands. Group 6: customer c-7, G1 and G2. The read is made to
-- raise by putting a view over the switch table for this transaction only; other
-- switches read through it as before.
INSERT INTO public.jobs (id, org_id, status, type, ghl_contact_id) VALUES
 ('9c000000-0000-4000-8000-0000000000f1', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-7'),
 ('9c000000-0000-4000-8000-0000000000f2', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'c-7');
SELECT public.link_fence_quote_option('9c000000-0000-4000-8000-0000000000f2', '9c000000-0000-4000-8000-0000000000f1', NULL, NULL);
SELECT pg_temp.qo_assert((SELECT enabled FROM public.feature_flags WHERE flag_name = 'quote_option_supersede_v1'),
 'the fail-closed cases need the switch row set true');
-- One silent round trip: accept G1, check nothing was written, put it back to quoted, check
-- again. "Nothing" is measured against the counts before the first case, so a write by any
-- acceptance or any reversal is caught.
CREATE FUNCTION pg_temp.qo_group6_writes() RETURNS bigint LANGUAGE sql AS $$
 SELECT (SELECT count(*) FROM public.jobs WHERE quote_option_group_id = '9c000000-0000-4000-8000-0000000000f1'
          AND superseded_at IS NOT NULL)
      + (SELECT count(*) FROM public.job_events
          WHERE job_id IN ('9c000000-0000-4000-8000-0000000000f1', '9c000000-0000-4000-8000-0000000000f2')
            AND event_type LIKE 'quote_option_%' AND event_type <> 'quote_option_linked')
      + (SELECT count(*) FROM public.quote_option_settle_runs
          WHERE quote_option_group_id = '9c000000-0000-4000-8000-0000000000f1')
$$;
CREATE FUNCTION pg_temp.qo_silent_round_trip(p_case text, p_baseline bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE public.jobs SET status = 'accepted' WHERE id = '9c000000-0000-4000-8000-0000000000f1';
 IF (SELECT status FROM public.jobs WHERE id = '9c000000-0000-4000-8000-0000000000f1') <> 'accepted' THEN
  RAISE EXCEPTION 'fence quote option contract: switch %: the acceptance must stand', p_case;
 END IF;
 IF pg_temp.qo_group6_writes() <> p_baseline THEN
  RAISE EXCEPTION 'fence quote option contract: switch %: an acceptance must write no pointer, event or run record', p_case;
 END IF;
 UPDATE public.jobs SET status = 'quoted' WHERE id = '9c000000-0000-4000-8000-0000000000f1';
 IF pg_temp.qo_group6_writes() <> p_baseline THEN
  RAISE EXCEPTION 'fence quote option contract: switch %: a reversal must write no pointer, event or run record', p_case;
 END IF;
END $$;
CREATE TEMP TABLE qo_group6_baseline AS SELECT pg_temp.qo_group6_writes() AS n;
SELECT pg_temp.qo_assert((SELECT n FROM qo_group6_baseline) = 0, 'group 6 must start with nothing written');
-- Readable but not true: false, NULL, and no row at all.
UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'quote_option_supersede_v1';
SELECT pg_temp.qo_silent_round_trip('false', (SELECT n FROM qo_group6_baseline));
DO $$
BEGIN
 UPDATE public.feature_flags SET enabled = NULL WHERE flag_name = 'quote_option_supersede_v1';
 PERFORM pg_temp.qo_silent_round_trip('NULL', (SELECT n FROM qo_group6_baseline));
EXCEPTION WHEN not_null_violation THEN
 RAISE NOTICE 'feature_flags.enabled is NOT NULL here, so a NULL switch cannot occur';
END $$;
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'quote_option_supersede_v1';
CREATE FUNCTION public.qo_contract_raise() RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'contract forced switch read failure' USING ERRCODE = current_setting('qo.flag_error');
END $$;
ALTER TABLE public.feature_flags RENAME TO qo_contract_feature_flags;
CREATE VIEW public.feature_flags AS
 SELECT f.* FROM public.qo_contract_feature_flags f WHERE f.flag_name <> 'quote_option_supersede_v1';
SELECT pg_temp.qo_silent_round_trip('row missing', (SELECT n FROM qo_group6_baseline));
-- Unreadable: the switch row is true, but reading it raises.
CREATE OR REPLACE VIEW public.feature_flags AS
 SELECT f.* FROM public.qo_contract_feature_flags f
  WHERE CASE WHEN f.flag_name = 'quote_option_supersede_v1' THEN public.qo_contract_raise() ELSE true END;
DO $$
DECLARE
 v_code text;
BEGIN
 FOREACH v_code IN ARRAY ARRAY['57014', '42501', '55P03', '42P01', 'P0001', 'P0004'] LOOP
  PERFORM set_config('qo.flag_error', v_code, true);
  PERFORM pg_temp.qo_silent_round_trip('read raising ' || v_code, (SELECT n FROM qo_group6_baseline));
 END LOOP;
END $$;
DROP VIEW public.feature_flags;
ALTER TABLE public.qo_contract_feature_flags RENAME TO feature_flags;
DROP FUNCTION public.qo_contract_raise();
-- With the switch readable again, the same acceptance does supersede: the cases above were
-- the read failing, not the code path being dead.
UPDATE public.jobs SET status = 'accepted' WHERE id = '9c000000-0000-4000-8000-0000000000f1';
SELECT pg_temp.qo_assert((SELECT superseded_by_job_id = '9c000000-0000-4000-8000-0000000000f1'
  FROM public.jobs WHERE id = '9c000000-0000-4000-8000-0000000000f2'),
 'with the switch readable and on, the same acceptance must supersede the sibling');

-- Message time: for every fixture job, superseded events minus unsuperseded events is 1 while
-- the pointer is set and 0 otherwise, so the intervals can be rebuilt from events alone.
SELECT pg_temp.qo_assert(NOT EXISTS (
  SELECT 1 FROM public.jobs j WHERE j.id::text LIKE '9c000000-%'
     AND pg_temp.qo_events(j.id, 'quote_option_superseded') - pg_temp.qo_events(j.id, 'quote_option_unsuperseded')
         <> CASE WHEN j.superseded_at IS NULL THEN 0 ELSE 1 END),
 'every pointer set or cleared must have its own event');
ROLLBACK;
