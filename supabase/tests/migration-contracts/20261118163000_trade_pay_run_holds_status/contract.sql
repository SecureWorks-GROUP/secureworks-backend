-- cl-1622-fix contract (option A). Every value, id and word is made up (ZZTEST).
--
-- Director ruling 14:35, three conditions:
--  (i)   the stamp takes the statuses today's send writes: pending_ops_review
--        (P1-10.4's hold) and queried (the office's query), and leaves them;
--  (ii)  Job Profit and job cost do not change at the stamp;
--  (iii) the crew release cannot act on a stamped invoice (TypeScript side in
--        trade_pay_run_hold_test.ts; here: the stamp moves no status the crew
--        release reads).
BEGIN;
SET LOCAL statement_timeout = '120s';
-- Later check bodies first (this transaction is rolled back).
\ir roll_back_check_successors.sql
-- Rule 17: re-apply what this contract asserts on.
\ir ../../../migrations/20261118163000_trade_pay_run_holds_status.sql
\ir ../../../migrations/20261118163000_trade_pay_run_holds_status.sql

CREATE FUNCTION pg_temp.zz_assert(ok boolean, words text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ZZTEST %', words; END IF;
END $$;
CREATE FUNCTION pg_temp.zz_error(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$ BEGIN
  EXECUTE p_sql; RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM;
END $$;

-- The installed body is this migration's; privileges unchanged.
SELECT pg_temp.zz_assert((SELECT md5(prosrc) FROM pg_proc
  WHERE oid = 'public.approve_trade_pay_run(uuid,date,uuid,jsonb)'::regprocedure) = 'dc17fd7b51c2916054ede4801eb8ead1',
  'own body installed after two runs');
SELECT pg_temp.zz_assert(has_function_privilege('service_role', 'public.approve_trade_pay_run(uuid,date,uuid,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.approve_trade_pay_run(uuid,date,uuid,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.approve_trade_pay_run(uuid,date,uuid,jsonb)', 'EXECUTE'),
  'service role only');
SELECT pg_temp.zz_assert((SELECT enabled = false FROM public.feature_flags WHERE flag_name = 'trade_pay_run_v1'),
  'switch stays off');

-- Rule 15 collision: another body at the signature is never replaced by a
-- re-apply, nor by the rollback. The captured last error is the refusal.
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
SAVEPOINT zz_collide;
CREATE OR REPLACE FUNCTION public.approve_trade_pay_run(p_org_id uuid, p_week_start date, p_actor uuid, p_snapshot jsonb)
RETURNS jsonb LANGUAGE sql AS $other$ SELECT '{"zztest":"another owner"}'::jsonb $other$;
\ir ../../../migrations/20261118163000_trade_pay_run_holds_status.sql
ROLLBACK TO SAVEPOINT zz_collide;
SELECT :'LAST_ERROR_MESSAGE' AS collide_apply_error \gset
SAVEPOINT zz_collide;
CREATE OR REPLACE FUNCTION public.approve_trade_pay_run(p_org_id uuid, p_week_start date, p_actor uuid, p_snapshot jsonb)
RETURNS jsonb LANGUAGE sql AS $other$ SELECT '{"zztest":"another owner"}'::jsonb $other$;
\ir ../../../rollbacks/20261118163000_trade_pay_run_holds_status_down.sql
ROLLBACK TO SAVEPOINT zz_collide;
SELECT :'LAST_ERROR_MESSAGE' AS collide_down_error \gset
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
SELECT pg_temp.zz_assert(:'collide_apply_error' LIKE '%approve_trade_pay_run: Rule 15, another body is installed%',
  'a re-apply must refuse another approve body: ' || :'collide_apply_error');
SELECT pg_temp.zz_assert(:'collide_down_error' LIKE '%approve_trade_pay_run rollback: another body is installed%',
  'the rollback must refuse another approve body: ' || :'collide_down_error');
SELECT pg_temp.zz_assert((SELECT md5(prosrc) FROM pg_proc
  WHERE oid = 'public.approve_trade_pay_run(uuid,date,uuid,jsonb)'::regprocedure) = 'dc17fd7b51c2916054ede4801eb8ead1',
  'own body after the collision proofs');
-- The rollback, then a re-apply, round-trip to this body.
SAVEPOINT zz_round;
\ir ../../../rollbacks/20261118163000_trade_pay_run_holds_status_down.sql
SELECT pg_temp.zz_assert((SELECT md5(prosrc) FROM pg_proc
  WHERE oid = 'public.approve_trade_pay_run(uuid,date,uuid,jsonb)'::regprocedure) = '422a37ee4add48ff6bd7ca221d9fda7f',
  'the rollback restores main''s body');
SELECT pg_temp.zz_assert((SELECT md5(prosrc) FROM pg_proc
  WHERE oid = 'public.trade_pay_run_check_v2(date,integer,uuid,text)'::regprocedure) = 'c36b18bc0c4c4bc4b1ffed9021717664',
  'the rollback restores P1-08.1''s check body');
SELECT pg_temp.zz_assert(to_regprocedure('public.claim_trade_pay_run_push(uuid,uuid,uuid)') IS NULL
  AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.trade_pay_run_invoices'::regclass
                  AND a.attname = 'push_claimed_at' AND NOT a.attisdropped),
  'the rollback drops the push claim');
\ir ../../../migrations/20261118163000_trade_pay_run_holds_status.sql
RELEASE SAVEPOINT zz_round;
SELECT pg_temp.zz_assert(
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.claim_trade_pay_run_push(uuid,uuid,uuid)'::regprocedure) = 'ba34283a686a38fdbc8e50798711ff40'
  AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.release_trade_pay_run_push(uuid,uuid,timestamptz)'::regprocedure) = '328348944a48084ed0dbe243bd39d60d',
  'claim and release bodies are this migration''s after the round trip');
SELECT pg_temp.zz_assert((SELECT md5(prosrc) FROM pg_proc
  WHERE oid = 'public.trade_pay_run_check_v2(date,integer,uuid,text)'::regprocedure) = '7bf3b7dbccc9c5ef8656b6c43e3e9a0b',
  'the check body is this migration''s (hourly note) after the round trip');
-- Rule 15 for the check: another check body is never replaced.
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
SAVEPOINT zz_collide_check;
CREATE OR REPLACE FUNCTION public.trade_pay_run_check_v2(p_as_of date, p_weeks integer, p_org_id uuid, p_stage text DEFAULT 'after_xero')
RETURNS jsonb LANGUAGE plpgsql AS $other$ BEGIN RETURN '{"zztest":"another owner"}'::jsonb; END $other$;
\ir ../../../migrations/20261118163000_trade_pay_run_holds_status.sql
ROLLBACK TO SAVEPOINT zz_collide_check;
SELECT :'LAST_ERROR_MESSAGE' AS collide_check_apply \gset
SAVEPOINT zz_collide_check;
CREATE OR REPLACE FUNCTION public.trade_pay_run_check_v2(p_as_of date, p_weeks integer, p_org_id uuid, p_stage text DEFAULT 'after_xero')
RETURNS jsonb LANGUAGE plpgsql AS $other$ BEGIN RETURN '{"zztest":"another owner"}'::jsonb; END $other$;
\ir ../../../rollbacks/20261118163000_trade_pay_run_holds_status_down.sql
ROLLBACK TO SAVEPOINT zz_collide_check;
SELECT :'LAST_ERROR_MESSAGE' AS collide_check_down \gset
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
SELECT pg_temp.zz_assert(:'collide_check_apply' LIKE '%trade_pay_run_check_v2: Rule 15, another body is installed%',
  'a re-apply must refuse another check body: ' || :'collide_check_apply');
SELECT pg_temp.zz_assert(:'collide_check_down' LIKE '%trade_pay_run_check_v2: Rule 15, another body is installed%',
  'the rollback must refuse another check body: ' || :'collide_check_down');
-- Rule 15 for the claim: another claim body is never replaced or dropped.
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
SAVEPOINT zz_collide_claim;
CREATE OR REPLACE FUNCTION public.claim_trade_pay_run_push(p_run_id uuid, p_invoice_id uuid, p_actor uuid)
RETURNS timestamptz LANGUAGE sql AS $other$ SELECT now() $other$;
\ir ../../../migrations/20261118163000_trade_pay_run_holds_status.sql
ROLLBACK TO SAVEPOINT zz_collide_claim;
SELECT :'LAST_ERROR_MESSAGE' AS collide_claim_apply \gset
SAVEPOINT zz_collide_claim;
CREATE OR REPLACE FUNCTION public.claim_trade_pay_run_push(p_run_id uuid, p_invoice_id uuid, p_actor uuid)
RETURNS timestamptz LANGUAGE sql AS $other$ SELECT now() $other$;
\ir ../../../rollbacks/20261118163000_trade_pay_run_holds_status_down.sql
ROLLBACK TO SAVEPOINT zz_collide_claim;
SELECT :'LAST_ERROR_MESSAGE' AS collide_claim_down \gset
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
SELECT pg_temp.zz_assert(:'collide_claim_apply' LIKE '%claim_trade_pay_run_push: Rule 15, another body is installed%',
  'a re-apply must refuse another claim body: ' || :'collide_claim_apply');
SELECT pg_temp.zz_assert(:'collide_claim_down' LIKE '%claim_trade_pay_run_push rollback: another body is installed%',
  'the rollback must refuse another claim body: ' || :'collide_claim_down');

-- Fixtures: four crew invoices for one week, n x 112 inclusive of n x 12
-- super. Historical fixtures need not satisfy today's write guards, so they
-- are written with user triggers off; every trigger is back on for the stamp.
DO $$ DECLARE t text; c record; BEGIN
  FOREACH t IN ARRAY ARRAY['jobs','users','work_orders','trade_invoices','trade_invoice_lines'] LOOP
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = format('public.%I', t)::regclass AND contype IN ('c','x') LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, c.conname);
    END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid = format('public.%I', t)::regclass
        AND attnum > 0 AND NOT attisdropped AND attnotnull AND attname <> 'id' LOOP
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL', t, c.attname);
    END LOOP;
  END LOOP;
END $$;
DROP INDEX IF EXISTS public.idx_trade_inv_unique;
-- The job cost triggers are installed so the column check below sees them.
SELECT to_regprocedure('public.job_cost_lines_install_trade_triggers()') IS NOT NULL AS have_cost \gset
\if :have_cost
SELECT public.job_cost_lines_install_trade_triggers();
\endif

SET LOCAL session_replication_role = replica;
INSERT INTO public.users (id, org_id, role) VALUES
  ('0a160000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'admin');
INSERT INTO public.users (id, org_id, role)
  SELECT ('0a160000-0000-4000-8000-0000000000' || (10 + n))::uuid, '00000000-0000-0000-0000-000000000001', 'crew'
  FROM generate_series(1, 4) n;
UPDATE public.trade_pay_settings SET inclusive_super_from = '2026-11-23',
  pay_run_approver_user_ids = ARRAY['0a160000-0000-4000-8000-000000000001'::uuid] WHERE id = 1;
INSERT INTO public.jobs (id, org_id, job_number, type, status)
  SELECT ('0a160000-0000-4000-8000-0000000001' || (10 + n))::uuid, '00000000-0000-0000-0000-000000000001',
    'ZZTEST-1622-' || n, 'fencing', 'accepted' FROM generate_series(1, 4) n;
INSERT INTO public.work_orders (id, org_id, job_id, kind, status, agreed_labour_ex)
  SELECT ('0a160000-0000-4000-8000-0000000002' || (10 + n))::uuid, '00000000-0000-0000-0000-000000000001',
    ('0a160000-0000-4000-8000-0000000001' || (10 + n))::uuid, 'job', 'approved', 1000 FROM generate_series(1, 4) n;
-- Invoices 1 to 3 are what P1-10.4's send writes; invoice 4 the office queried.
INSERT INTO public.trade_invoices (id, org_id, user_id, invoice_number, week_start, status, invoice_kind,
    submitted_at, subtotal_ex, gross_earned, gst, total_inc, gst_on, super_rate, super_amount, net_pay, super_basis)
  SELECT ('0a160000-0000-4000-8000-0000000003' || (10 + n))::uuid, '00000000-0000-0000-0000-000000000001',
    ('0a160000-0000-4000-8000-0000000000' || (10 + n))::uuid, 'ZZTEST-1622-INV-' || n, '2026-11-16',
    CASE WHEN n = 4 THEN 'queried' ELSE 'pending_ops_review' END, 'standard',
    '2026-11-20 01:00Z'::timestamptz + n * interval '1 minute', n * 112, n * 112, 0, n * 112, false, .12,
    n * 12, n * 100, 'inclusive_12_112_v1' FROM generate_series(1, 4) n;
INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, job_number, job_work_order_id, line_type, line_total_ex, description)
  SELECT ('0a160000-0000-4000-8000-0000000003' || (10 + n))::uuid, ('0a160000-0000-4000-8000-0000000001' || (10 + n))::uuid,
    'ZZTEST-1622-' || n, ('0a160000-0000-4000-8000-0000000002' || (10 + n))::uuid, 'labour', n * 112, 'ZZTEST labour'
  FROM generate_series(1, 4) n;
SET LOCAL session_replication_role = origin;

-- (ii) The stamp writes only pay_run_id, reviewed_at and reviewed_by, and no
-- trigger on trade_invoices is scoped to those columns: the job cost trigger
-- (UPDATE OF status, xero_bill_status, ...) and the repayment lock (UPDATE OF
-- status, recurring_deduction_*) do not fire.
SELECT pg_temp.zz_assert(NOT EXISTS (
  SELECT 1 FROM pg_trigger t
  CROSS JOIN LATERAL unnest(t.tgattr::int2[]) a(attnum)
  JOIN pg_attribute c ON c.attrelid = t.tgrelid AND c.attnum = a.attnum
  WHERE t.tgrelid = 'public.trade_invoices'::regclass AND NOT t.tgisinternal
    AND c.attname IN ('pay_run_id', 'reviewed_at', 'reviewed_by')), 'a trigger is scoped to a stamp column');
\if :have_cost
SELECT pg_temp.zz_assert(EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'job_cost_lines_trade_invoice_update'
  AND tgrelid = 'public.trade_invoices'::regclass), 'job cost trigger installed for the check');
\endif

-- Job Profit's own trigger on trade_invoices is not column-scoped, so it does
-- fire at the stamp, exactly as it fires on main's stamp (or any invoice
-- update). It is installed here with its switch on, to show it only queues a
-- refresh mark for the invoice's jobs and changes no figure.
-- (Rule 17: an earlier contract in the shard may have dropped these; the
-- section runs whenever they exist, which they do on a fresh build.)
SELECT to_regclass('public.job_profit_change_events') IS NOT NULL
   AND to_regprocedure('public.job_profit_trade_invoices_trg()') IS NOT NULL AS have_profit_marks \gset
\if :have_profit_marks
INSERT INTO public.feature_flags (flag_name, enabled) VALUES ('job_profit_refresh_v1', true)
  ON CONFLICT (flag_name) DO UPDATE SET enabled = true;
DROP TRIGGER IF EXISTS job_profit_changed ON public.trade_invoices;
CREATE TRIGGER job_profit_changed AFTER INSERT OR UPDATE OR DELETE ON public.trade_invoices
  FOR EACH ROW EXECUTE FUNCTION public.job_profit_trade_invoices_trg();
CREATE TEMP TABLE zz_marks_before ON COMMIT DROP AS
  SELECT coalesce(max(id), 0) AS last_id FROM public.job_profit_change_events;
\endif
CREATE TEMP TABLE zz_cost_before ON COMMIT DROP AS
  SELECT md5(coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id)::text, '')) AS h FROM public.job_cost_lines c;

CREATE TEMP TABLE zz_before ON COMMIT DROP AS
  SELECT i.id, to_jsonb(i) - 'pay_run_id' - 'reviewed_at' - 'reviewed_by' - 'updated_at' AS row_data
  FROM public.trade_invoices i WHERE i.invoice_number LIKE 'ZZTEST-1622-INV-%';
CREATE TEMP TABLE zz_profit_before ON COMMIT DROP AS
  SELECT md5(coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.job_id)::text, '')) AS h
  FROM public.v_job_profit v WHERE v.job_id IN (SELECT id FROM public.jobs WHERE job_number LIKE 'ZZTEST-1622-%');

-- The press, all four clean.
CREATE FUNCTION pg_temp.zz_snapshot() RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('check_rule', 'v2', 'invoices', jsonb_agg(jsonb_build_object(
    'invoice_id', i.id, 'verdict', 'clean', 'stops', '[]'::jsonb,
    'pays', i.net_pay, 'super_amount', i.super_amount) ORDER BY i.invoice_number))
  FROM public.trade_invoices i WHERE i.invoice_number LIKE 'ZZTEST-1622-INV-%'
$$;
-- An empty week cannot close: no invoice, or every invoice stopped, is
-- refused and writes nothing, so the week stays open for its real run.
CREATE FUNCTION pg_temp.zz_press(p_snapshot jsonb) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.zz_error(format('SELECT public.approve_trade_pay_run(%L, %L, %L, %L)',
    '00000000-0000-0000-0000-000000000001', '2026-11-16', '0a160000-0000-4000-8000-000000000001', p_snapshot))
$$;
SELECT pg_temp.zz_assert(pg_temp.zz_press('{"check_rule":"v2","invoices":[]}') LIKE '%pay_run_nothing_clean%',
  'a week with no invoice must be refused');
SELECT pg_temp.zz_assert(pg_temp.zz_press(jsonb_set(pg_temp.zz_snapshot(), '{invoices}',
    (SELECT jsonb_agg(e || '{"verdict":"stopped","stops":[{"code":"zztest","words":"ZZTEST stop"}]}')
     FROM jsonb_array_elements(pg_temp.zz_snapshot()->'invoices') e))) LIKE '%pay_run_nothing_clean%',
  'a week with every invoice stopped must be refused');
SELECT pg_temp.zz_assert(NOT EXISTS (SELECT 1 FROM public.trade_pay_runs)
  AND NOT EXISTS (SELECT 1 FROM public.trade_pay_run_invoices)
  AND NOT EXISTS (SELECT 1 FROM public.trade_invoices WHERE pay_run_id IS NOT NULL OR reviewed_at IS NOT NULL),
  'an empty week wrote something');

SELECT pg_temp.zz_assert(pg_temp.zz_error(format('SELECT public.approve_trade_pay_run(%L, %L, %L, %L)',
  '00000000-0000-0000-0000-000000000001', '2026-11-16', '0a160000-0000-4000-8000-000000000001', pg_temp.zz_snapshot())) IS NULL,
  'the run must be approved');

-- (i) Every invoice is stamped and keeps the status it had at the press.
SELECT pg_temp.zz_assert((SELECT count(*) = 4
    AND count(*) FILTER (WHERE i.status = 'pending_ops_review') = 3
    AND count(*) FILTER (WHERE i.status = 'queried') = 1
    AND bool_and(i.pay_run_id = r.id AND i.reviewed_by = '0a160000-0000-4000-8000-000000000001'
      AND i.reviewed_at IS NOT NULL AND i.xero_bill_id IS NULL)
  FROM public.trade_invoices i CROSS JOIN public.trade_pay_runs r
  WHERE i.invoice_number LIKE 'ZZTEST-1622-INV-%'), 'stamped, status kept');
SELECT pg_temp.zz_assert((SELECT count(*) = 1 AND bool_and(invoice_count = 4 AND total_pays = 1000 AND super_total = 120
  AND status = 'approved') FROM public.trade_pay_runs), 'one run with the four');
SELECT pg_temp.zz_assert((SELECT count(*) = 4 AND bool_and(verdict = 'clean' AND pushed_at IS NULL)
  FROM public.trade_pay_run_invoices), 'four clean run rows');

-- (ii) Nothing else on the invoice moved, and Job Profit reads the same.
SELECT pg_temp.zz_assert(NOT EXISTS (
  SELECT 1 FROM zz_before b JOIN public.trade_invoices i ON i.id = b.id
  WHERE b.row_data IS DISTINCT FROM (to_jsonb(i) - 'pay_run_id' - 'reviewed_at' - 'reviewed_by' - 'updated_at')),
  'the stamp changed an invoice column other than the run stamp');
SELECT pg_temp.zz_assert((SELECT md5(coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.job_id)::text, ''))
  FROM public.v_job_profit v WHERE v.job_id IN (SELECT id FROM public.jobs WHERE job_number LIKE 'ZZTEST-1622-%'))
  = (SELECT h FROM zz_profit_before), 'Job Profit changed at the stamp');
SELECT pg_temp.zz_assert((SELECT md5(coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id)::text, '')) FROM public.job_cost_lines c)
  = (SELECT h FROM zz_cost_before), 'a job cost line changed at the stamp');
-- The only other write is Job Profit's refresh mark, one per fixture job, as
-- main's stamp makes; the refresh re-reads figures that did not move.
\if :have_profit_marks
SELECT pg_temp.zz_assert((SELECT count(*) > 0 AND bool_and(e.reason = 'crew_invoice'
    AND e.job_id IN (SELECT id FROM public.jobs WHERE job_number LIKE 'ZZTEST-1622-%'))
  FROM public.job_profit_change_events e WHERE e.id > (SELECT last_id FROM zz_marks_before)),
  'the stamp wrote a Job Profit mark other than the refresh mark for its own jobs');
\echo 'PASS: cl-1622-fix Job Profit trigger at the stamp only queues refresh marks for its own jobs.'
\endif

-- (iii) The crew release moves only pending_acknowledgment bills to approved;
-- the stamp leaves none of these at that status or at approved.
SELECT pg_temp.zz_assert(NOT EXISTS (SELECT 1 FROM public.trade_invoices
  WHERE invoice_number LIKE 'ZZTEST-1622-INV-%' AND status IN ('pending_acknowledgment', 'approved')),
  'a stamped invoice is in a status a release or push takes');

-- Push claim (director 15:22 (b)): one press at a time per run invoice.
SELECT r.run_id AS zz_run, r.invoice_id AS zz_inv FROM public.trade_pay_run_invoices r
 ORDER BY r.invoice_id LIMIT 1 \gset
SELECT public.claim_trade_pay_run_push(:'zz_run', :'zz_inv', '0a160000-0000-4000-8000-000000000001') AS zz_claim1 \gset
SELECT pg_temp.zz_assert(:'zz_claim1' <> '', 'the first press claims the row');
-- The rollback refuses while a claim is live (a press may be mid-push).
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
SAVEPOINT zz_live_claim;
\ir ../../../rollbacks/20261118163000_trade_pay_run_holds_status_down.sql
ROLLBACK TO SAVEPOINT zz_live_claim;
SELECT :'LAST_ERROR_MESSAGE' AS live_claim_down \gset
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
SELECT pg_temp.zz_assert(:'live_claim_down' LIKE '%a push claim is live%',
  'the rollback must refuse a live claim: ' || :'live_claim_down');
SELECT pg_temp.zz_assert(public.claim_trade_pay_run_push(:'zz_run', :'zz_inv', '0a160000-0000-4000-8000-000000000002') IS NULL,
  'a second press while the claim is live gets nothing');
SELECT pg_temp.zz_assert(public.release_trade_pay_run_push(:'zz_run', :'zz_inv', now() - interval '1 day') = false
  AND (SELECT push_claimed_at FROM public.trade_pay_run_invoices WHERE run_id = :'zz_run' AND invoice_id = :'zz_inv') = :'zz_claim1'::timestamptz,
  'a release with another stamp clears nothing');
SELECT pg_temp.zz_assert(public.release_trade_pay_run_push(:'zz_run', :'zz_inv', :'zz_claim1') = true,
  'the press gives back its own claim');
SELECT pg_temp.zz_assert(public.claim_trade_pay_run_push(:'zz_run', :'zz_inv', '0a160000-0000-4000-8000-000000000002') IS NOT NULL,
  'after a release the next press claims');
UPDATE public.trade_pay_run_invoices SET push_claimed_at = clock_timestamp() - interval '11 minutes'
 WHERE run_id = :'zz_run' AND invoice_id = :'zz_inv';
SELECT pg_temp.zz_assert(public.claim_trade_pay_run_push(:'zz_run', :'zz_inv', '0a160000-0000-4000-8000-000000000001') IS NOT NULL,
  'a claim older than ten minutes lapses, so a crashed press never strands the invoice');
UPDATE public.trade_pay_run_invoices SET push_claimed_at = NULL, pushed_at = now(), xero_bill_id = 'ZZTEST-BILL'
 WHERE run_id = :'zz_run' AND invoice_id = :'zz_inv';
SELECT pg_temp.zz_assert(public.claim_trade_pay_run_push(:'zz_run', :'zz_inv', '0a160000-0000-4000-8000-000000000001') IS NULL,
  'a pushed row is never claimed');
SELECT pg_temp.zz_assert(public.claim_trade_pay_run_push(:'zz_run', '0c400000-0000-4000-8000-0000000000ff', '0a160000-0000-4000-8000-000000000001') IS NULL
  AND public.claim_trade_pay_run_push(:'zz_run', (SELECT invoice_id FROM public.trade_pay_run_invoices WHERE run_id = :'zz_run' AND pushed_at IS NULL ORDER BY invoice_id LIMIT 1), NULL) IS NULL,
  'no row, or no actor, claims nothing');
SELECT pg_temp.zz_assert(has_function_privilege('service_role', 'public.claim_trade_pay_run_push(uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.claim_trade_pay_run_push(uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.claim_trade_pay_run_push(uuid,uuid,uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.release_trade_pay_run_push(uuid,uuid,timestamptz)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.release_trade_pay_run_push(uuid,uuid,timestamptz)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.release_trade_pay_run_push(uuid,uuid,timestamptz)', 'EXECUTE'),
  'claim and release are service role only');
\echo 'PASS: cl-1622-fix push claim: one press at a time, own release only, ten-minute lease, pushed rows never claimed.'

-- A second press for the week is refused; nothing more is written.
SELECT pg_temp.zz_assert(pg_temp.zz_error(format('SELECT public.approve_trade_pay_run(%L, %L, %L, %L)',
  '00000000-0000-0000-0000-000000000001', '2026-11-16', '0a160000-0000-4000-8000-000000000001', pg_temp.zz_snapshot()))
  = 'pay_run_already_approved', 'second press refused');

ROLLBACK;
\echo 'PASS: cl-1622-fix stamp keeps status (i), leaves Job Profit and job cost (ii), no release status (iii), empty week refused, Rule 15.'

-- ── The hourly note (director ruling 15:54) ────────────────────────────────
-- An hourly line on a job with no agreed amount on file is a note: it is in
-- the invoice's notes and counted, it is never a stop, and the invoice's
-- verdict is the one it has without the note. A job with an agreed amount
-- gets no note. Every id, figure and word is made up.
\echo == cl-1622-fix hourly no-agreed-amount note ==
BEGIN;
SET LOCAL statement_timeout = '120s';
-- Ignore unrelated write guards only inside this rolled-back read fixture.
DO $$ DECLARE t text; c record; BEGIN
  FOREACH t IN ARRAY ARRAY['users','jobs','trade_invoices','trade_invoice_lines','work_orders','trade_pay_settings','feature_flags'] LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER USER',t);
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid=format('public.%I',t)::regclass AND contype IN ('f','c','u','x')
      AND NOT (t='feature_flags' AND contype='u') LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',t,c.conname);
    END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=format('public.%I',t)::regclass
      AND attnum>0 AND NOT attisdropped AND attnotnull AND attname<>'id'
      AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid=attrelid AND k.contype='p' AND attnum=ANY(k.conkey)) LOOP
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL',t,c.attname);
    END LOOP;
  END LOOP;
END $$;
TRUNCATE public.trade_invoice_lines, public.trade_invoices, public.work_orders, public.trade_pay_settings CASCADE;
INSERT INTO public.trade_pay_settings(id,inclusive_super_from) VALUES(1,'2026-11-23');
INSERT INTO public.feature_flags(flag_name,enabled) VALUES('trade_pay_inclusive_super_v1',true)
 ON CONFLICT(flag_name) DO UPDATE SET enabled=EXCLUDED.enabled;
INSERT INTO public.users(id,name) SELECT md5('ZZTEST hourly role '||n)::uuid,'ZZTEST trade role' FROM generate_series(1,3)n ON CONFLICT(id) DO NOTHING;
-- Job 1: work order with no agreed amount. Job 2: agreed. Job 3: none at all, closed.
INSERT INTO public.jobs(id,status) VALUES(md5('ZZTEST hourly job 1')::uuid,'accepted'),
 (md5('ZZTEST hourly job 2')::uuid,'accepted'),(md5('ZZTEST hourly job 3')::uuid,'complete')
 ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status;
INSERT INTO public.work_orders(id,job_id,kind,agreed_labour_ex) VALUES
 (md5('ZZTEST hourly wo 1')::uuid,md5('ZZTEST hourly job 1')::uuid,'job',NULL),
 (md5('ZZTEST hourly wo 2')::uuid,md5('ZZTEST hourly job 2')::uuid,'job',5000.00);
INSERT INTO public.trade_invoices(id,user_id,org_id,invoice_number,invoice_source,week_start,status,
 subtotal_ex,gross_earned,super_amount,net_pay,super_basis,invoice_kind,gst_on,gst)
SELECT md5('ZZTEST hourly invoice '||n)::uuid,md5('ZZTEST hourly role '||n)::uuid,md5('ZZTEST hourly org')::uuid,
 'ZZTEST-H'||n,'ZZTEST','2026-11-23','approved',1120,1120,120.00,1000.00,'inclusive_12_112_v1','standard',false,0
 FROM generate_series(1,3)n;
INSERT INTO public.trade_invoice_lines(id,trade_invoice_id,job_id,job_number,line_type,line_total_ex,job_work_order_id)
SELECT md5('ZZTEST hourly line '||n)::uuid,md5('ZZTEST hourly invoice '||n)::uuid,md5('ZZTEST hourly job '||n)::uuid,
 'ZZTEST-J'||n,'labour',1120,CASE WHEN n<3 THEN md5('ZZTEST hourly wo '||n)::uuid END
 FROM generate_series(1,3)n;
CREATE FUNCTION pg_temp.hourly() RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.trade_pay_run_check_v2('2026-11-25',1,md5('ZZTEST hourly org')::uuid,'before_xero')
$$;
CREATE FUNCTION pg_temp.inv(p_number text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT i FROM jsonb_array_elements(pg_temp.hourly()->'invoices') i WHERE i->>'invoice_number'=p_number
$$;
DO $$ DECLARE j jsonb; code text := 'hourly_no_agreed_amount'; BEGIN
 j := pg_temp.hourly();
 -- Noted on the job with no agreed amount (1) and the job with no work order (3).
 IF NOT (pg_temp.inv('ZZTEST-H1')->'notes' @> jsonb_build_array(jsonb_build_object('code',code)))
    OR NOT (pg_temp.inv('ZZTEST-H3')->'notes' @> jsonb_build_array(jsonb_build_object('code',code))) THEN
   RAISE EXCEPTION 'ZZTEST hourly line with no agreed amount must carry the note: %', j;
 END IF;
 -- Never on the agreed job.
 IF pg_temp.inv('ZZTEST-H2')->'notes' @> jsonb_build_array(jsonb_build_object('code',code)) THEN
   RAISE EXCEPTION 'ZZTEST an agreed job must carry no hourly note: %', j;
 END IF;
 -- Never a stop: the noted invoice is clean, like the agreed one.
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(j->'invoices') i WHERE i->'stops' @> jsonb_build_array(jsonb_build_object('code',code)))
    OR pg_temp.inv('ZZTEST-H1')->>'verdict' <> 'clean' OR pg_temp.inv('ZZTEST-H2')->>'verdict' <> 'clean' THEN
   RAISE EXCEPTION 'ZZTEST the hourly note must not stop: %', j;
 END IF;
 -- Counted: clean_with_notes holds the noted clean invoices.
 IF (j#>>'{counts,clean_with_notes}')::int < 1 THEN RAISE EXCEPTION 'ZZTEST noted invoices must be counted: %', j; END IF;
 -- The work order on job 1 now gets an agreed amount: the note goes.
 UPDATE public.work_orders SET agreed_labour_ex = 5000.00 WHERE id = md5('ZZTEST hourly wo 1')::uuid;
 IF pg_temp.inv('ZZTEST-H1')->'notes' @> jsonb_build_array(jsonb_build_object('code',code)) THEN
   RAISE EXCEPTION 'ZZTEST the note must go once an amount is agreed';
 END IF;
END $$;
ROLLBACK;
\echo 'PASS: cl-1622-fix hourly line on a job with no agreed amount is a counted note, never a stop.'
