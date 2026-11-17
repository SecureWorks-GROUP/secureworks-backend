-- P2-01.1: synthetic transaction fixtures only. Successful commits are cleaned
-- up below; failures must happen at COMMIT, not at the preceding write.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.job_cost_lines) OR EXISTS (SELECT 1 FROM public.job_cost_line_parts) THEN
    RAISE EXCEPTION 'cost lines contract: foundation is not empty';
  END IF;
END $$;

CREATE FUNCTION pg_temp.cost_line_fixture(line_key text, state text, amount numeric,
                                         not_counted text DEFAULT NULL)
RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO public.job_cost_lines
    (org_id, kind, document_kind, document_id, line_key, lane, amount_ex, state,
     not_counted_reason, source_hash)
  VALUES ('00000000-0000-0000-0000-000000000001', 'supplier_bill', 'xero_bill',
          'ZZTEST-COST-LINES', line_key, 'materials', amount, state, not_counted, 'fixture')
  RETURNING id;
$$;

CREATE FUNCTION pg_temp.cost_line_commit_refused(code text, message text, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF code IS DISTINCT FROM '23514' OR message IS DISTINCT FROM 'cost_line_parts_do_not_conserve' THEN
    RAISE EXCEPTION 'cost lines contract: % committed without conservation (%, %)', label, code, message;
  END IF;
END;
$$;

BEGIN;
INSERT INTO public.jobs (id, org_id, status, type, job_number)
VALUES ('00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-000000000001',
        'accepted', 'fencing', 'ZZTEST-COST-01');
SELECT pg_temp.cost_line_fixture('on-job', 'on_job', 1000.00) AS on_job_id \gset
INSERT INTO public.job_cost_line_parts (line_id, part_no, target, job_id, lane, amount_ex)
VALUES (:'on_job_id', 1, 'job', '00000000-0000-0000-0000-00000000d101', 'materials', 1000.00);
COMMIT;
\echo 'P2-01.1 PASS: on_job allocation commits'

-- A part-only update must validate its parent, even when the line is untouched.
BEGIN;
UPDATE public.job_cost_line_parts SET amount_ex = 999.99 WHERE line_id = :'on_job_id';
\set ON_ERROR_STOP off
COMMIT;
\set ON_ERROR_STOP on
SELECT pg_temp.cost_line_commit_refused(:'SQLSTATE', :'LAST_ERROR_MESSAGE', 'part update');
\echo 'P2-01.1 PASS: short job part refuses at commit'

BEGIN;
SELECT pg_temp.cost_line_fixture('split', 'split', 1000.00) AS split_id \gset
INSERT INTO public.job_cost_line_parts (line_id, part_no, target, job_id, division, lane, amount_ex)
VALUES (:'split_id', 1, 'job', '00000000-0000-0000-0000-00000000d101', NULL, 'materials', 600.00),
       (:'split_id', 2, 'overhead', NULL, NULL, 'materials', 300.00),
       (:'split_id', 3, 'division_stock', NULL, 'fencing', 'materials', 100.00);
COMMIT;
\echo 'P2-01.1 PASS: three-part split commits'

BEGIN;
SELECT pg_temp.cost_line_fixture('short-split', 'split', 1000.00) AS short_split_id \gset
INSERT INTO public.job_cost_line_parts (line_id, part_no, target, lane, amount_ex)
VALUES (:'short_split_id', 1, 'overhead', 'materials', 600.00),
       (:'short_split_id', 2, 'overhead', 'materials', 300.00);
\set ON_ERROR_STOP off
COMMIT;
\set ON_ERROR_STOP on
SELECT pg_temp.cost_line_commit_refused(:'SQLSTATE', :'LAST_ERROR_MESSAGE', 'short split');
\echo 'P2-01.1 PASS: short split refuses at commit'

BEGIN;
DO $$
BEGIN
  BEGIN
    PERFORM pg_temp.cost_line_fixture('both', 'needs_person', NULL, 'document_not_live');
    RAISE EXCEPTION 'cost lines contract: state and not_counted_reason both accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM pg_temp.cost_line_fixture('neither', NULL, NULL);
    RAISE EXCEPTION 'cost lines contract: missing state and not_counted_reason accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;
ROLLBACK;
\echo 'P2-01.1 PASS: state and exclusion reason are exclusive and exhaustive'

BEGIN;
SELECT pg_temp.cost_line_fixture('needs-part', 'needs_person', NULL) AS needs_part_id \gset
INSERT INTO public.job_cost_line_parts (line_id, part_no, target, lane, amount_ex)
VALUES (:'needs_part_id', 1, 'overhead', 'materials', 0.00);
\set ON_ERROR_STOP off
COMMIT;
\set ON_ERROR_STOP on
SELECT pg_temp.cost_line_commit_refused(:'SQLSTATE', :'LAST_ERROR_MESSAGE', 'needs_person with part');
\echo 'P2-01.1 PASS: needs_person cannot have parts'

BEGIN;
SELECT pg_temp.cost_line_fixture('unknown-job', 'on_job', NULL);
\set ON_ERROR_STOP off
COMMIT;
\set ON_ERROR_STOP on
SELECT pg_temp.cost_line_commit_refused(:'SQLSTATE', :'LAST_ERROR_MESSAGE', 'unknown amount on_job');
\echo 'P2-01.1 PASS: unknown amount cannot be on_job'

BEGIN;
SELECT pg_temp.cost_line_fixture('needs-person', 'needs_person', NULL);
SELECT pg_temp.cost_line_fixture('not-counted', NULL, NULL, 'document_not_live');
SELECT pg_temp.cost_line_fixture('overhead', 'overhead', 1000.00) AS overhead_id \gset
SELECT pg_temp.cost_line_fixture('stock', 'division_stock', 1000.00) AS stock_id \gset
INSERT INTO public.job_cost_line_parts (line_id, part_no, target, division, lane, amount_ex)
VALUES (:'overhead_id', 1, 'overhead', NULL, 'materials', 1000.00),
       (:'stock_id', 1, 'division_stock', 'insurance', 'materials', 1000.00);
COMMIT;
\echo 'P2-01.1 PASS: unknown, not counted, overhead and division stock commit'

BEGIN;
DELETE FROM public.job_cost_line_parts WHERE line_id = :'split_id' AND part_no = 3;
\set ON_ERROR_STOP off
COMMIT;
\set ON_ERROR_STOP on
SELECT pg_temp.cost_line_commit_refused(:'SQLSTATE', :'LAST_ERROR_MESSAGE', 'part deletion');
\echo 'P2-01.1 PASS: deleting a required part refuses'

BEGIN;
-- The destination would be valid; the old parent would be left empty.
SELECT pg_temp.cost_line_fixture('move-destination', 'overhead', 1000.00) AS destination_id \gset
UPDATE public.job_cost_line_parts SET line_id = :'destination_id' WHERE line_id = :'overhead_id';
\set ON_ERROR_STOP off
COMMIT;
\set ON_ERROR_STOP on
SELECT pg_temp.cost_line_commit_refused(:'SQLSTATE', :'LAST_ERROR_MESSAGE', 'part move');
\echo 'P2-01.1 PASS: moving a part validates its old parent'

BEGIN;
UPDATE public.job_cost_lines SET amount_ex = 999.99 WHERE id = :'on_job_id';
\set ON_ERROR_STOP off
COMMIT;
\set ON_ERROR_STOP on
SELECT pg_temp.cost_line_commit_refused(:'SQLSTATE', :'LAST_ERROR_MESSAGE', 'line update');
\echo 'P2-01.1 PASS: changing the line amount refuses'

BEGIN;
UPDATE public.job_cost_lines SET state = 'overhead' WHERE id = :'on_job_id';
\set ON_ERROR_STOP off
COMMIT;
\set ON_ERROR_STOP on
SELECT pg_temp.cost_line_commit_refused(:'SQLSTATE', :'LAST_ERROR_MESSAGE', 'wrong target');
\echo 'P2-01.1 PASS: wrong single target refuses'

BEGIN;
-- Deferred validation permits a temporary imbalance repaired in the same transaction.
UPDATE public.job_cost_lines SET amount_ex = 999.99 WHERE id = :'on_job_id';
UPDATE public.job_cost_line_parts SET amount_ex = 999.99 WHERE line_id = :'on_job_id';
COMMIT;
\echo 'P2-01.1 PASS: balanced replacement commits after temporary imbalance'

BEGIN;
DO $$
DECLARE relation text; operation text; role_name text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['public.job_cost_lines', 'public.job_cost_line_parts'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = relation::regclass) THEN
      RAISE EXCEPTION 'cost lines contract: RLS off for %', relation;
    END IF;
    FOREACH operation IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF has_table_privilege(role_name, relation, operation) THEN
          RAISE EXCEPTION 'cost lines contract: browser role has % on %', operation, relation;
        END IF;
      END LOOP;
      IF NOT has_table_privilege('service_role', relation, operation) THEN
        RAISE EXCEPTION 'cost lines contract: service role lacks % on %', operation, relation;
      END IF;
    END LOOP;
  END LOOP;
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'job_cost_lines_sync_v1') IS DISTINCT FROM false
     OR (SELECT enabled FROM public.feature_flags WHERE flag_name = 'job_cost_events_from_cost_lines_v1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'cost lines contract: switches not seeded off';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'job_cost_lines' AND column_name = 'amount_ex' AND column_default IS NOT NULL) THEN
    RAISE EXCEPTION 'cost lines contract: unknown amount has a default';
  END IF;
END;
$$;
ROLLBACK;
\echo 'P2-01.1 PASS: private grants, RLS, off switches and unknown default'

-- Drive actual service-role CRUD through the RLS surface and deferred trigger.
BEGIN;
SET LOCAL ROLE service_role;
INSERT INTO public.job_cost_lines
  (id, org_id, kind, document_kind, document_id, line_key, lane, amount_ex, state, source_hash)
VALUES ('00000000-0000-0000-0000-00000000d102', '00000000-0000-0000-0000-000000000001',
        'supplier_bill', 'xero_bill', 'ZZTEST-COST-LINES', 'service-role', 'materials', 0.00, 'overhead', 'fixture');
INSERT INTO public.job_cost_line_parts (line_id, part_no, target, lane, amount_ex)
VALUES ('00000000-0000-0000-0000-00000000d102', 1, 'overhead', 'materials', 0.00);
UPDATE public.job_cost_lines SET needs_reason = 'review' WHERE id = '00000000-0000-0000-0000-00000000d102';
UPDATE public.job_cost_line_parts SET lane = 'other' WHERE line_id = '00000000-0000-0000-0000-00000000d102';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.job_cost_lines WHERE id = '00000000-0000-0000-0000-00000000d102'
                 AND needs_reason = 'review')
     OR NOT EXISTS (SELECT 1 FROM public.job_cost_line_parts
                     WHERE line_id = '00000000-0000-0000-0000-00000000d102' AND lane = 'other') THEN
    RAISE EXCEPTION 'cost lines contract: service CRUD refused';
  END IF;
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
DELETE FROM public.job_cost_line_parts WHERE line_id = '00000000-0000-0000-0000-00000000d102';
DELETE FROM public.job_cost_lines WHERE id = '00000000-0000-0000-0000-00000000d102';
COMMIT;
\echo 'P2-01.1 PASS: service role CRUD commits'

BEGIN;
\set ON_ERROR_STOP off
\ir ../../../rollbacks/20261117160400_job_cost_lines_down.sql
\set rollback_code :SQLSTATE
\set rollback_message :LAST_ERROR_MESSAGE
\set ON_ERROR_STOP on
ROLLBACK;
SELECT 1 / CASE WHEN :'rollback_code' = 'P0001'
                     AND :'rollback_message' = 'job_cost_lines_rollback_has_data' THEN 1 ELSE 0 END;
\echo 'P2-01.1 PASS: rollback preserves recorded lines'

BEGIN;
-- Parent cascade deletes must not raise for a line that no longer exists.
DELETE FROM public.job_cost_lines WHERE document_id = 'ZZTEST-COST-LINES';
DELETE FROM public.jobs WHERE id = '00000000-0000-0000-0000-00000000d101';
COMMIT;
\echo 'P2-01.1 PASS: cascade deletion commits and fixtures are removed'

BEGIN;
\ir ../../../migrations/20261117160400_job_cost_lines.sql
ROLLBACK;
\echo 'P2-01.1 PASS: migration reapplies without enabling switches'
