-- Follow-up 56: is everything trade_pay_run_v1 (the weekly pay run) needs in
-- place before the switch goes on?
-- Reads only. Opens a READ ONLY transaction and rolls it back; calls no
-- application function; never writes the switch or any setting.
-- Input: job_number, one exact ZZTEST job, the fixture the director will use.
-- Output: one row per check, then one overall row.
--   kind required    : must PASS before the switch goes on.
--   kind follow_up   : a named follow-up, reported but not counted overall.
--   kind fixture     : the ZZTEST job is ready for the proof (not the switch).
--   kind not_checked : SQL cannot see it; the director checks it by hand.
-- Evidence is names, counts, codes and dates only: no names of people, no pay.
-- Sources: migrations 20261117020000, 20261118043357, 20261118060051,
-- 20261118063223, 20261118073218, 20261118115852; ops-api trade_pay_run.ts,
-- trade_pay_run_wait.ts; follow-ups P1-10.3 and cl-1622-fix.

START TRANSACTION READ ONLY;

SELECT to_regclass('public.trade_pay_settings') IS NOT NULL AS has_pay_settings,
       to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS has_ledger
\gset

\if :has_pay_settings
\set pay_settings_rows 'SELECT pay_run_approver_user_ids AS approvers, true AS readable FROM public.trade_pay_settings WHERE id = 1'
\else
\set pay_settings_rows 'SELECT NULL::uuid[] AS approvers, false AS readable'
\endif
\if :has_ledger
\set ledger_rows 'SELECT version::text AS version, true AS readable FROM supabase_migrations.schema_migrations'
\else
\set ledger_rows 'SELECT NULL::text AS version, false AS readable'
\endif

WITH
flags AS (
  SELECT flag_name, enabled FROM public.feature_flags
  WHERE flag_name = 'trade_pay_run_v1'
),
settings AS (:pay_settings_rows),
ledger AS (:ledger_rows),
approver_state AS (
  SELECT coalesce(s.readable, false) AS readable,
    coalesce(cardinality(s.approvers), 0) AS listed,
    (SELECT count(DISTINCT u.id) FROM public.users u
      WHERE u.id = ANY (coalesce(s.approvers, '{}'))) AS known_users
  FROM (SELECT 1) one LEFT JOIN settings s ON true
),
run_tables(rel) AS (VALUES ('trade_pay_runs'), ('trade_pay_run_invoices')),
run_table_state AS (
  SELECT t.rel, c.oid IS NOT NULL AS present,
    coalesce(c.relrowsecurity, false) AS rls,
    c.oid IS NOT NULL AND to_regrole('service_role') IS NOT NULL
      AND has_table_privilege('service_role', c.oid, 'SELECT')
      AND has_table_privilege('service_role', c.oid, 'INSERT')
      AND has_table_privilege('service_role', c.oid, 'UPDATE') AS service_role_writes,
    c.oid IS NOT NULL AND (
      (to_regrole('anon') IS NOT NULL
        AND has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))
      OR (to_regrole('authenticated') IS NOT NULL
        AND has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))
    ) AS browser_access
  FROM run_tables t
  LEFT JOIN pg_catalog.pg_class c ON c.oid = to_regclass('public.' || t.rel)
),
run_columns(col) AS (VALUES ('pay_run_id'), ('reviewed_at'), ('reviewed_by')),
missing_columns AS (
  SELECT 'trade_invoices.' || r.col AS name FROM run_columns r
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = to_regclass('public.trade_invoices')
      AND a.attname = r.col AND a.attnum > 0 AND NOT a.attisdropped)
),
fns(signature) AS (VALUES
  ('public.approve_trade_pay_run(uuid,date,uuid,jsonb)'),
  ('public.trade_pay_run_check_v2(date,integer,uuid,text)'),
  ('public.trade_pay_run_standing_checks(uuid,uuid[],text)')
),
fn_state AS (
  SELECT f.signature, p.oid IS NOT NULL AS present,
    p.oid IS NOT NULL AND to_regrole('service_role') IS NOT NULL
      AND has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_runs,
    p.oid IS NOT NULL AND (
      (to_regrole('anon') IS NOT NULL AND has_function_privilege('anon', p.oid, 'EXECUTE'))
      OR (to_regrole('authenticated') IS NOT NULL
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    ) AS browser_runs,
    md5(p.prosrc) AS body_md5
  FROM fns f LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(f.signature)
),
-- PostgREST calls a function by argument name. trade_pay_run.ts sends these.
-- The raise counts through reconcile_item_raise itself or its named door
-- reconcile_item_raise_named (#1643).
calls(fn, sent) AS (VALUES
  ('reconcile_item_raise', ARRAY['p_kind','p_subject_table','p_subject_id',
    'p_job_ids','p_suggestion','p_evidence','p_raised_by']::text[]),
  ('reconcile_item_withdraw', ARRAY['p_kind','p_subject_table','p_subject_id',
    'p_reason']::text[])
),
call_state AS (
  SELECT c.fn, c.sent, count(p.oid) AS overloads,
    coalesce(bool_or(p.proargnames IS NOT NULL
      AND (p.proargnames[1:p.pronargs])::text[] @> c.sent
      AND c.sent @> (p.proargnames[1:p.pronargs - p.pronargdefaults])::text[]), false) AS by_name,
    coalesce(jsonb_agg(jsonb_build_object('function', p.proname, 'args', p.pronargs,
      'names', p.proargnames)) FILTER (WHERE p.oid IS NOT NULL), '[]') AS overload_arg_names
  FROM calls c
  LEFT JOIN pg_catalog.pg_proc p
    ON p.pronamespace = 'public'::regnamespace
      AND (p.proname = c.fn
        OR (c.fn = 'reconcile_item_raise' AND p.proname = 'reconcile_item_raise_named'))
  GROUP BY c.fn, c.sent
),
-- pay_run_stopped is raised on subject trade_pay_run_weeks; reconcile_item_org
-- resolves only a table with a uuid org_id and a single-column key.
weeks_subject AS (
  SELECT to_regclass('public.trade_pay_run_weeks') IS NOT NULL AS present,
    EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass('public.trade_pay_run_weeks') AND a.attname = 'org_id'
        AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype) AS has_org,
    EXISTS (SELECT 1 FROM pg_catalog.pg_index i
      WHERE i.indrelid = to_regclass('public.trade_pay_run_weeks') AND i.indisprimary
        AND i.indnkeyatts = 1) AS single_key
),
reject_rpc AS (
  SELECT p.oid IS NOT NULL AS present,
    coalesce(p.prosrc LIKE '%pay_run_id%', false) AS filters_pay_run
  FROM (SELECT 1) one
  LEFT JOIN pg_catalog.pg_proc p
    ON p.oid = to_regprocedure('public.reject_trade_invoice_v1(uuid,text,text)')
),
family(version) AS (VALUES
  ('20261117020000'), ('20261118043357'), ('20261118060051'), ('20261118063223'),
  ('20261118073218'), ('20261118115852')
),
ledger_state AS (
  SELECT bool_or(readable) AS readable,
    array_agg(f.version ORDER BY f.version) FILTER (WHERE NOT EXISTS (
      SELECT 1 FROM ledger l WHERE l.version = f.version)) AS missing
  FROM family f CROSS JOIN (SELECT bool_or(readable) AS readable FROM ledger) r
),
fixture_job AS (
  SELECT j.id FROM public.jobs j
  WHERE j.job_number = :'job_number' AND j.job_number LIKE 'ZZTEST%'
),
checks(ord, kind, check_name, passed, evidence, source) AS (
  SELECT 1, 'required', 'P01 switch row trade_pay_run_v1 exists',
    EXISTS (SELECT 1 FROM flags),
    jsonb_build_object('enabled_now', (SELECT enabled FROM flags)),
    '20261118115852 line 36; trade_pay_run_wait.ts readPayRunSwitchForSubmit'
  UNION ALL
  SELECT 2, 'required', 'P02 run tables present, row security on, service role writes, no browser access',
    bool_and(present AND rls AND service_role_writes AND NOT browser_access),
    jsonb_agg(jsonb_build_object('table', rel, 'present', present, 'rls', rls,
      'service_role_writes', service_role_writes, 'browser_access', browser_access)
      ORDER BY rel),
    '20261118115852 lines 42-125'
  FROM run_table_state
  UNION ALL
  SELECT 3, 'required', 'P03 trade_invoices run columns present',
    NOT EXISTS (SELECT 1 FROM missing_columns),
    jsonb_build_object('missing',
      (SELECT coalesce(jsonb_agg(name ORDER BY name), '[]') FROM missing_columns)),
    '20261118115852 line 95'
  UNION ALL
  SELECT 4, 'required', 'P04 run functions present, service role only',
    bool_and(present AND service_role_runs AND NOT browser_runs),
    jsonb_agg(jsonb_build_object('function', signature, 'present', present,
      'service_role_runs', service_role_runs, 'browser_runs', browser_runs,
      'body_md5', body_md5) ORDER BY signature),
    '20261118043357, 20261118063223, 20261118115852; trade_pay_run.ts reads'
  FROM fn_state
  UNION ALL
  SELECT 5, 'required', 'P05 approver list set and every id is a known user',
    readable AND listed > 0 AND known_users = listed,
    jsonb_build_object('settings_readable', readable, 'approvers_listed', listed,
      'known_users', known_users),
    'trade_pay_run.ts approvers(); approve_trade_pay_run pay_run_not_approver'
  FROM approver_state
  UNION ALL
  SELECT CASE fn WHEN 'reconcile_item_raise' THEN 6 ELSE 7 END, 'required',
    CASE fn WHEN 'reconcile_item_raise'
      THEN 'P06 reconcile_item_raise (or its named door) callable by argument name'
      ELSE 'P07 reconcile_item_withdraw callable by argument name' END,
    by_name,
    jsonb_build_object('overloads', overloads, 'names_sent', sent,
      'overload_arg_names', overload_arg_names),
    'trade_pay_run.ts raise/withdraw; follow-up P1-10.3 item 1; #1643'
  FROM call_state
  UNION ALL
  SELECT 8, 'required', 'P08 pay_run_stopped subject trade_pay_run_weeks resolves an organisation',
    present AND has_org AND single_key,
    jsonb_build_object('present', present, 'uuid_org_id', has_org,
      'single_column_key', single_key),
    'trade_pay_run.ts pay_run_stopped; follow-up P1-10.3 items 2 and 3'
  FROM weeks_subject
  UNION ALL
  SELECT 9, 'required', 'P09 every pay run family migration is in the ledger',
    readable AND missing IS NULL,
    jsonb_build_object('ledger_readable', coalesce(readable, false),
      'versions', (SELECT count(*) FROM family), 'missing', coalesce(missing, '{}')),
    'supabase_migrations.schema_migrations'
  FROM ledger_state
  UNION ALL
  SELECT 15, 'follow_up', 'P15 reject_trade_invoice_v1 leaves a run invoice alone',
    present AND filters_pay_run,
    jsonb_build_object('present', present, 'body_names_pay_run_id', filters_pay_run),
    'follow-up cl-1622-fix item 7 (race only; not blocking)'
  FROM reject_rpc
  UNION ALL
  SELECT 20, 'fixture', 'F01 exactly one ZZTEST job with that number',
    (SELECT count(*) FROM fixture_job) = 1,
    jsonb_build_object('matched_jobs', (SELECT count(*) FROM fixture_job)),
    'input job_number'
  UNION ALL
  SELECT 30, 'not_checked', 'N01 deployed ops-api carries the pay run wait and push (#1633, #1634)',
    NULL, jsonb_build_object('how',
      'ops_api_version commit_sha, then git merge-base --is-ancestor <merge> <commit_sha>'),
    'AGENTS.md: measure the deployed thing'
  UNION ALL
  SELECT 31, 'not_checked', 'N02 each office door checks the run (approve, push, line review, sibling push, stuck release)',
    NULL, jsonb_build_object('how', 'one handler test per door on the deployed commit'),
    'follow-up cl-1622-fix item 16'
  UNION ALL
  SELECT 32, 'not_checked', 'N03 two presses at once cannot push a run twice (row lock or claim)',
    NULL, jsonb_build_object('how', 'code review of the run push on the deployed commit'),
    'follow-up cl-1622-fix item 15'
  UNION ALL
  SELECT 33, 'not_checked', 'N04 super wording reads Marked paid by the office',
    NULL, jsonb_build_object('how', 'read My pay on the deployed commit'),
    'follow-up cl-1622-fix item 14'
  UNION ALL
  SELECT 34, 'not_checked', 'N05 crew-in-run ruling and lost-answer recovery decided',
    NULL, jsonb_build_object('how', 'director ruling'),
    'follow-ups cl-1622-fix item 1, P1-10.3 item 8'
  UNION ALL
  SELECT 35, 'not_checked', 'N06 the owner says turn it on',
    NULL, jsonb_build_object('how', 'owner''s word'), 'switch row is seeded off'
)
SELECT ord, kind, check_name,
  CASE WHEN kind = 'not_checked' THEN 'NOT CHECKED HERE'
       WHEN passed THEN 'PASS' ELSE 'FAIL' END AS result,
  evidence, source
FROM checks
UNION ALL
SELECT 99, 'overall', 'trade_pay_run_v1 preconditions (SQL-visible only)',
  CASE WHEN count(*) FILTER (WHERE kind IN ('required', 'fixture')
    AND passed IS NOT TRUE) = 0 THEN 'PASS' ELSE 'FAIL' END,
  jsonb_build_object(
    'required_failed', count(*) FILTER (WHERE kind = 'required' AND passed IS NOT TRUE),
    'fixture_failed', count(*) FILTER (WHERE kind = 'fixture' AND passed IS NOT TRUE),
    'follow_up_failed', count(*) FILTER (WHERE kind = 'follow_up' AND passed IS NOT TRUE),
    'not_checked_here', count(*) FILTER (WHERE kind = 'not_checked')),
  'PASS here never means safe to switch: the not_checked rows need the director'
FROM checks
ORDER BY ord;

ROLLBACK;
