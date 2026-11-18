BEGIN;
SET LOCAL statement_timeout = '90s';
-- Rule 17: the rollback keeps the record table, so a re-apply must find and keep it; then a
-- second apply is a no-op.
\ir ../../../rollbacks/20261118999908_work_order_cap_start_set_down.sql
\ir ../../../migrations/20261118999908_work_order_cap_start_set.sql
\ir ../../../migrations/20261118999908_work_order_cap_start_set.sql

CREATE FUNCTION pg_temp.assert_ok(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ZZTEST %', label; END IF;
END $$;
CREATE FUNCTION pg_temp.expect_error(cmd text, wanted text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  EXECUTE cmd;
  RAISE EXCEPTION 'ZZTEST missing refusal %', wanted;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> wanted THEN RAISE; END IF;
END $$;

-- What runs on merge: no start date, the hold switch untouched, the door service role only.
DO $$ BEGIN
  PERFORM pg_temp.assert_ok((SELECT cap_start_on IS NULL FROM public.work_order_cap_settings WHERE id = 1), 'start date set on merge');
  PERFORM pg_temp.assert_ok(NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'trade_line_hold_v1' AND enabled), 'hold switch on');
  PERFORM pg_temp.assert_ok(EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'work_order_cap_settings_record'
    AND tgrelid = 'public.work_order_cap_settings'::regclass AND NOT tgisinternal), 'record trigger missing');
  PERFORM pg_temp.assert_ok(has_function_privilege('service_role', 'public.set_work_order_cap_start(uuid,text,date,date,text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.set_work_order_cap_start(uuid,text,date,date,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.set_work_order_cap_start(uuid,text,date,date,text)', 'EXECUTE'), 'door grants');
  PERFORM pg_temp.assert_ok(NOT has_function_privilege('service_role', 'public.work_order_cap_settings_record()', 'EXECUTE'), 'record function callable');
  PERFORM pg_temp.assert_ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.work_order_cap_start_changes'::regclass), 'record RLS off');
  PERFORM pg_temp.assert_ok(has_table_privilege('service_role', 'public.work_order_cap_start_changes', 'SELECT')
    AND NOT has_table_privilege('service_role', 'public.work_order_cap_start_changes', 'INSERT')
    AND NOT has_table_privilege('service_role', 'public.work_order_cap_start_changes', 'UPDATE')
    AND NOT has_table_privilege('service_role', 'public.work_order_cap_start_changes', 'DELETE')
    AND NOT has_table_privilege('authenticated', 'public.work_order_cap_start_changes', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.work_order_cap_start_changes', 'SELECT'), 'record grants');
END $$;

-- Made-up approver (owner list) and a made-up person on no list.
UPDATE public.work_order_settings SET owner_user_ids = ARRAY['f1990800-0000-4000-8000-0000000000a1'::uuid] WHERE id = 1;

DO $$ DECLARE
  approver uuid := 'f1990800-0000-4000-8000-0000000000a1';
  stranger uuid := 'f1990800-0000-4000-8000-0000000000a2';
  before_n bigint := (SELECT count(*) FROM public.work_order_cap_start_changes);
  r public.work_order_cap_start_changes%ROWTYPE;
  answer jsonb;
BEGIN
  -- Who may set it is checked before anything is read: with the settings row gone, a
  -- stranger still gets not_approver, never settings_missing.
  ALTER TABLE public.work_order_cap_settings DISABLE TRIGGER work_order_cap_settings_record;
  DELETE FROM public.work_order_cap_settings;
  PERFORM pg_temp.expect_error(format($c$SELECT public.set_work_order_cap_start(%L, NULL, NULL, DATE '2026-11-24', 'ZZTEST start')$c$, stranger),
    'work_order_cap_start_not_approver');
  PERFORM pg_temp.expect_error(format($c$SELECT public.set_work_order_cap_start(%L, NULL, NULL, DATE '2026-11-24', 'ZZTEST start')$c$, approver),
    'work_order_cap_settings_missing');
  INSERT INTO public.work_order_cap_settings (id, cap_start_on) VALUES (1, NULL);
  ALTER TABLE public.work_order_cap_settings ENABLE TRIGGER work_order_cap_settings_record;

  PERFORM pg_temp.expect_error(format($c$SELECT public.set_work_order_cap_start(NULL, NULL, NULL, DATE '2026-11-24', 'ZZTEST start')$c$),
    'work_order_cap_start_not_approver');
  PERFORM pg_temp.expect_error(format($c$SELECT public.set_work_order_cap_start(%L, NULL, NULL, DATE '2026-11-24', ' x ')$c$, approver),
    'work_order_cap_start_reason_invalid');
  -- Shown a date that is not the saved one: refused, nothing changes.
  PERFORM pg_temp.expect_error(format($c$SELECT public.set_work_order_cap_start(%L, NULL, DATE '2026-11-01', DATE '2026-11-24', 'ZZTEST start')$c$, approver),
    'work_order_cap_start_changed');
  PERFORM pg_temp.assert_ok((SELECT count(*) FROM public.work_order_cap_start_changes) = before_n, 'a refusal recorded a change');

  answer := public.set_work_order_cap_start(approver, ' approver@example.invalid ', NULL, DATE '2026-11-24', ' ZZTEST start ');
  PERFORM pg_temp.assert_ok(answer = jsonb_build_object('changed', true, 'cap_start_on', '2026-11-24',
    'previous_start', NULL, 'authority', 'owner'), 'set answer ' || answer::text);
  PERFORM pg_temp.assert_ok((SELECT cap_start_on FROM public.work_order_cap_settings WHERE id = 1) = DATE '2026-11-24', 'date not saved');
  SELECT * INTO r FROM public.work_order_cap_start_changes ORDER BY id DESC LIMIT 1;
  PERFORM pg_temp.assert_ok(r.via = 'approver' AND r.set_by = approver AND r.set_by_email = 'approver@example.invalid'
    AND r.authority = 'owner' AND r.reason = 'ZZTEST start' AND r.previous_start IS NULL
    AND r.new_start = DATE '2026-11-24' AND r.db_role IS NOT NULL, 'approver record');
  PERFORM pg_temp.assert_ok(coalesce(current_setting('sw.work_order_cap_start_by', true), '') = '', 'approver marker left set');

  -- A retry of the same ask: changed false, nothing recorded.
  answer := public.set_work_order_cap_start(approver, NULL, NULL, DATE '2026-11-24', 'ZZTEST retry');
  PERFORM pg_temp.assert_ok(answer ->> 'changed' = 'false', 'retry changed');
  PERFORM pg_temp.assert_ok((SELECT count(*) FROM public.work_order_cap_start_changes) = before_n + 1, 'retry recorded');

  -- Direct SQL, as before this change, is still allowed and now recorded, naming the role.
  UPDATE public.work_order_cap_settings SET cap_start_on = DATE '2026-12-01' WHERE id = 1;
  SELECT * INTO r FROM public.work_order_cap_start_changes ORDER BY id DESC LIMIT 1;
  PERFORM pg_temp.assert_ok(r.via = 'direct_sql' AND r.set_by IS NULL AND r.authority IS NULL
    AND r.previous_start = DATE '2026-11-24' AND r.new_start = DATE '2026-12-01' AND r.db_role IS NOT NULL, 'direct record');
  UPDATE public.work_order_cap_settings SET updated_at = now() WHERE id = 1;
  PERFORM pg_temp.assert_ok((SELECT count(*) FROM public.work_order_cap_start_changes) = before_n + 2, 'an unchanged date recorded');
  -- A row removed and put back is two changes.
  DELETE FROM public.work_order_cap_settings WHERE id = 1;
  INSERT INTO public.work_order_cap_settings (id, cap_start_on) VALUES (1, DATE '2026-12-01');
  PERFORM pg_temp.assert_ok((SELECT count(*) FROM public.work_order_cap_start_changes
    WHERE id > (SELECT max(id) - 2 FROM public.work_order_cap_start_changes)
      AND ((previous_start = DATE '2026-12-01' AND new_start IS NULL)
        OR (previous_start IS NULL AND new_start = DATE '2026-12-01'))) = 2, 'delete and insert recorded');
  -- The approver now needs the date they were shown (2026-12-01) to move it back.
  PERFORM pg_temp.expect_error(format($c$SELECT public.set_work_order_cap_start(%L, NULL, DATE '2026-11-24', DATE '2026-11-24', 'ZZTEST back')$c$, approver),
    'work_order_cap_start_changed');
  answer := public.set_work_order_cap_start(approver, NULL, DATE '2026-12-01', DATE '2026-11-24', 'ZZTEST back');
  PERFORM pg_temp.assert_ok(answer ->> 'previous_start' = '2026-12-01', 'move back');

  -- The record is append-only.
  PERFORM pg_temp.expect_error('UPDATE public.work_order_cap_start_changes SET reason = ''x''', 'work_order_cap_start_changes_write_once');
  PERFORM pg_temp.expect_error('DELETE FROM public.work_order_cap_start_changes', 'work_order_cap_start_changes_write_once');
  PERFORM pg_temp.expect_error('TRUNCATE public.work_order_cap_start_changes', 'work_order_cap_start_changes_write_once');
END $$;

-- Live runs as service_role (ops-api's door call and a hand UPDATE through the API): both are
-- recorded, naming that role.
SET LOCAL ROLE service_role;
SELECT public.set_work_order_cap_start('f1990800-0000-4000-8000-0000000000a1', NULL, DATE '2026-11-24', DATE '2026-11-25', 'ZZTEST as service role');
UPDATE public.work_order_cap_settings SET cap_start_on = DATE '2026-11-24', updated_at = now() WHERE id = 1;
RESET ROLE;
DO $$ BEGIN
  PERFORM pg_temp.assert_ok((SELECT array_agg(via || ':' || db_role || ':' || new_start ORDER BY id)
      FROM (SELECT * FROM public.work_order_cap_start_changes ORDER BY id DESC LIMIT 2) t)
    = ARRAY['approver:service_role:2026-11-25', 'direct_sql:service_role:2026-11-24'],
    'service role records ' || (SELECT array_agg(via || ':' || db_role ORDER BY id)::text
      FROM (SELECT * FROM public.work_order_cap_start_changes ORDER BY id DESC LIMIT 2) t));
  PERFORM pg_temp.assert_ok((SELECT cap_start_on FROM public.work_order_cap_settings WHERE id = 1) = DATE '2026-11-24', 'service role update');
END $$;

-- The before-switch counts (PR text, run here verbatim). Live may hold a job with no status or
-- no creation time although the migrations forbid both, so the fixture has one of each.
ALTER TABLE public.jobs ALTER COLUMN status DROP NOT NULL, ALTER COLUMN created_at DROP NOT NULL;
SET LOCAL session_replication_role = replica;
INSERT INTO public.jobs (id, org_id, type, status, job_number, created_at) VALUES
  -- Perth 24 Nov starts at 23 Nov 16:00 UTC.
  ('f1990800-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'ZZTEST-CAP-NEW-BARE', '2026-11-23 16:00:00+00'),
  ('f1990800-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'ZZTEST-CAP-OLD-BARE', '2026-11-23 15:59:59+00'),
  ('f1990800-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'fencing', NULL, 'ZZTEST-CAP-NO-STATUS', '2026-11-25 01:00:00+00'),
  ('f1990800-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'ZZTEST-CAP-NO-CREATED', NULL),
  ('f1990800-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000001', 'patio', 'scheduled', 'ZZTEST-CAP-NEW-DRAFT', '2026-11-26 01:00:00+00'),
  ('f1990800-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'ZZTEST-CAP-APPROVED-AFTER', '2026-11-01 01:00:00+00'),
  ('f1990800-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'ZZTEST-CAP-APPROVED-BEFORE', '2026-11-01 01:00:00+00'),
  ('f1990800-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000001', 'fencing', 'complete', 'ZZTEST-CAP-CLOSED', '2026-11-26 01:00:00+00');
INSERT INTO public.work_orders (id, org_id, job_id, wo_number, kind, status, agreed_labour_ex, approved_at, approved_by, sealed_content_hash) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', 'f1990800-0000-4000-8000-000000000005', 'ZZTEST-CAP-WO-5', 'job', 'draft', 100, NULL, NULL, NULL),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', 'f1990800-0000-4000-8000-000000000006', 'ZZTEST-CAP-WO-6', 'job', 'approved', 100,
   '2026-11-23 16:00:00+00', 'f1990800-0000-4000-8000-0000000000a1', 'ZZTEST sealed'),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', 'f1990800-0000-4000-8000-000000000007', 'ZZTEST-CAP-WO-7', 'job', 'approved', 100,
   '2026-11-23 15:59:59+00', 'f1990800-0000-4000-8000-0000000000a1', 'ZZTEST sealed');
-- The counts read only these made-up jobs: every other job is closed for the test.
UPDATE public.jobs SET status = 'archived'
 WHERE id::text NOT LIKE 'f1990800-0000-4000-8000-00000000000_' AND status IS DISTINCT FROM 'archived';
SET LOCAL session_replication_role = origin;

-- query:held-by-status begin
CREATE TEMP VIEW zz_held_by_status AS
-- Open jobs the cap would hold for the office because they have no approved job work order,
-- by status. Open: any status but the five closed ones, and a job with no status. A job with
-- no creation time counts (the rule holds a job it cannot read). Replace 2026-11-24 with the
-- Perth start day you intend. Read only.
WITH s AS (SELECT DATE '2026-11-24' AS cap_start_on)
SELECT CASE WHEN GROUPING(j.status) = 1 THEN 'TOTAL'
            ELSE coalesce(j.status, '(no status)') END AS status,
       count(*) AS jobs
FROM public.jobs j CROSS JOIN s
WHERE (j.status IS NULL OR j.status NOT IN ('complete','completed','archived','cancelled','lost'))
  AND (j.created_at IS NULL
       OR j.created_at >= (s.cap_start_on::timestamp AT TIME ZONE 'Australia/Perth'))
  AND NOT EXISTS (
    SELECT 1 FROM public.work_orders w
    WHERE w.job_id = j.id AND w.kind = 'job'
      AND w.status = 'approved' AND w.approved_at IS NOT NULL)
GROUP BY ROLLUP (j.status)
ORDER BY GROUPING(j.status), j.status NULLS FIRST;
-- query:held-by-status end

-- query:from-the-rule begin
CREATE TEMP VIEW zz_from_the_rule AS
-- Once the date is saved: what work_order_cap_scope itself says about every open job, split
-- by why. An approved order always carries an amount (work_orders_approved_sealed_check), so
-- an in-scope job is held for the office only for having no approved order;
-- held_no_approved_order must equal the TOTAL row above for the same date. approved_before_start: open jobs whose job work order was approved
-- before the start day; with the hold switch on these lose the cap they have today. Read only.
WITH open_jobs AS (
  SELECT j.id FROM public.jobs j
  WHERE j.status IS NULL OR j.status NOT IN ('complete','completed','archived','cancelled','lost')),
sc AS (
  SELECT s.job_id, s.in_scope
  FROM public.work_order_cap_scope((SELECT array_agg(o.id) FROM open_jobs o)) s),
a AS (
  SELECT sc.job_id, sc.in_scope, EXISTS (
    SELECT 1 FROM public.work_orders w
    WHERE w.job_id = sc.job_id AND w.kind = 'job'
      AND w.status = 'approved' AND w.approved_at IS NOT NULL) AS approved
  FROM sc)
SELECT count(*) FILTER (WHERE in_scope AND NOT approved) AS held_no_approved_order,
       count(*) FILTER (WHERE in_scope AND approved) AS capped_by_approved_order,
       count(*) FILTER (WHERE NOT in_scope AND approved) AS approved_before_start,
       count(*) FILTER (WHERE NOT in_scope AND NOT approved) AS older_no_approved_order,
       count(*) AS open_jobs
FROM a;
-- query:from-the-rule end

DO $$ BEGIN
  -- Saved date is 2026-11-24 (set by the approver above).
  PERFORM pg_temp.assert_ok((SELECT array_agg(status || '=' || jobs ORDER BY status COLLATE "C") FROM zz_held_by_status)
    = ARRAY['(no status)=1', 'TOTAL=4', 'accepted=2', 'scheduled=1'], 'held by status '
      || (SELECT array_agg(status || '=' || jobs)::text FROM zz_held_by_status));
  PERFORM pg_temp.assert_ok((SELECT row(held_no_approved_order, capped_by_approved_order, approved_before_start,
      older_no_approved_order, open_jobs)::text FROM zz_from_the_rule) = '(4,1,1,1,7)',
    'from the rule ' || (SELECT row(z.*)::text FROM zz_from_the_rule z));
  PERFORM pg_temp.assert_ok((SELECT jobs FROM zz_held_by_status WHERE status = 'TOTAL')
    = (SELECT held_no_approved_order FROM zz_from_the_rule), 'the two counts disagree');
END $$;

ROLLBACK;
SELECT 'FU49-9b cap start set by an approver, recorded, counts agree: passed' AS result;
