-- Follow-up 56: is everything trade_line_hold_v1 (the work order cap and the
-- held-line send) needs in place before the switch goes on?
-- Reads only. Opens a READ ONLY transaction and rolls it back; calls no
-- application function; never writes the switch or any setting.
-- Input: job_number, one exact ZZTEST job, the fixture the director will use.
-- Output: one row per check, then one overall row.
--   kind required    : must PASS before the switch goes on.
--   kind fixture     : the ZZTEST job is ready for the proof (not the switch).
--   kind after_send  : read after a ZZTEST send with a held line; not counted,
--                      since no held line exists while the switch is off.
--   kind not_checked : SQL cannot see it; the director checks it by hand.
-- Evidence is names, counts, codes and dates only: no names of people, no pay.
-- Sources: migrations 20261117020000, 20261117172401, 20261117173901,
-- 20261117174103, 20261118060051, 20261118070639, 20261118073218,
-- 20261118122207, 20261118122208, 20261118122209, 20261118153101;
-- #1643 (reconcile_item_raise_named), #1649 (director ruling C11 (a));
-- ops-api trade_line_send.ts (lineHoldSendApplies, raiseHeldLines),
-- trade_pay_rule.ts (readTradePayRule, tradePayBasisFor); follow-up FU49.

START TRANSACTION READ ONLY;

SELECT to_regclass('public.trade_pay_settings') IS NOT NULL AS has_pay_settings,
       to_regclass('public.work_order_cap_settings') IS NOT NULL AS has_cap_settings,
       to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS has_ledger,
       to_regclass('public.reconcile_items') IS NOT NULL
         AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
           WHERE a.attrelid = to_regclass('public.trade_invoice_lines')
             AND a.attname = 'hold_reason' AND NOT a.attisdropped) AS has_held_reads
\gset

\if :has_pay_settings
\set pay_settings_rows 'SELECT inclusive_super_from, true AS readable FROM public.trade_pay_settings WHERE id = 1'
\else
\set pay_settings_rows 'SELECT NULL::date AS inclusive_super_from, false AS readable'
\endif
\if :has_cap_settings
\set cap_settings_rows 'SELECT cap_start_on, true AS readable FROM public.work_order_cap_settings WHERE id = 1'
\else
\set cap_settings_rows 'SELECT NULL::date AS cap_start_on, false AS readable'
\endif
\if :has_held_reads
\set held_rows 'SELECT l.id::text AS line_id, j.org_id, EXISTS (SELECT 1 FROM public.reconcile_items r WHERE r.kind = ''pay_line_held'' AND r.subject_table = ''trade_invoice_lines'' AND r.subject_id = l.id::text AND r.org_id = j.org_id) AS landed, true AS readable FROM public.trade_invoice_lines l JOIN public.jobs j ON j.id = l.job_id JOIN fixture_job f ON f.id = j.id WHERE l.hold_reason IS NOT NULL'
\else
\set held_rows 'SELECT NULL::text AS line_id, NULL::uuid AS org_id, false AS landed, false AS readable'
\endif
\if :has_ledger
\set ledger_rows 'SELECT version::text AS version, true AS readable FROM supabase_migrations.schema_migrations'
\else
\set ledger_rows 'SELECT NULL::text AS version, false AS readable'
\endif

WITH
flags AS (
  SELECT flag_name, enabled FROM public.feature_flags
  WHERE flag_name IN ('trade_line_hold_v1', 'trade_pay_inclusive_super_v1')
),
settings AS (:pay_settings_rows),
cap_settings AS (:cap_settings_rows),
ledger AS (:ledger_rows),
perth AS (SELECT (now() AT TIME ZONE 'Australia/Perth')::date AS today),
-- Columns the hold writes (20261117173901, 20261117172401).
hold_columns(rel, col) AS (VALUES
  ('trade_invoices', 'invoice_kind'), ('trade_invoices', 'send_id'),
  ('trade_invoices', 'follows_invoice_id'),
  ('trade_invoice_lines', 'hold_reason'), ('trade_invoice_lines', 'hold_detail'),
  ('trade_invoice_lines', 'held_at'), ('trade_invoice_lines', 'decided_at'),
  ('trade_invoice_lines', 'sent_amount_ex'), ('trade_invoice_lines', 'sent_values'),
  ('trade_invoice_lines', 'office_change_reason'),
  ('trade_invoice_lines', 'split_group_id'),
  ('trade_invoice_lines', 'not_job_work_type_id')
),
missing_columns AS (
  SELECT h.rel || '.' || h.col AS name FROM hold_columns h
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = to_regclass('public.' || h.rel)
      AND a.attname = h.col AND a.attnum > 0 AND NOT a.attisdropped)
),
hold_tables(rel) AS (VALUES ('not_job_work_types'), ('trade_held_line_notes')),
hold_table_state AS (
  SELECT t.rel, c.oid IS NOT NULL AS present,
    coalesce(c.relrowsecurity, false) AS rls,
    c.oid IS NOT NULL AND (
      (to_regrole('anon') IS NOT NULL
        AND has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))
      OR (to_regrole('authenticated') IS NOT NULL
        AND has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))
    ) AS browser_access
  FROM hold_tables t
  LEFT JOIN pg_catalog.pg_class c ON c.oid = to_regclass('public.' || t.rel)
),
-- A function the service role calls: present, service role may run it, no
-- browser role may.
fns(id, signature) AS (VALUES
  ('backed_room', 'public.job_backed_room(uuid)'),
  ('backed_billed', 'public.work_order_backed_billed(uuid[],uuid[])'),
  ('send_totals', 'public.trade_send_totals(uuid)'),
  ('merge', 'public.trade_line_hold_merge_v1(jsonb,jsonb)'),
  ('decide', 'public.decide_held_trade_line(uuid,text,uuid,uuid,jsonb,text)')
),
fn_state AS (
  SELECT f.id, f.signature, p.oid IS NOT NULL AS present,
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
-- Owner-only installs the migrations never call (install_trade_line_hold,
-- install_trade_line_job_amount_guard). Enabled means origin or always.
triggers(id, rel, tgname, fn) AS (VALUES
  ('notes', 'trade_held_line_notes', 'trade_held_line_notes_append_only',
    'public.trade_held_line_notes_append_only()'),
  ('line_guard', 'trade_invoice_lines', 'trade_invoice_lines_job_amount_guard',
    'public.trade_invoice_lines_job_amount_guard()'),
  ('header_guard', 'trade_invoices', 'trade_invoices_job_amount_guard',
    'public.trade_invoices_job_amount_guard()')
),
trigger_state AS (
  SELECT g.id, g.tgname, t.oid IS NOT NULL AS present,
    t.tgenabled::text AS enabled_code,
    t.tgfoid IS NOT DISTINCT FROM to_regprocedure(g.fn) AND t.oid IS NOT NULL AS right_function,
    EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = t.tgrelid AND a.attname = 'override_amount'
        AND a.attnum = ANY (t.tgattr)) AS watches_override
  FROM triggers g
  LEFT JOIN pg_catalog.pg_trigger t
    ON t.tgrelid = to_regclass('public.' || g.rel) AND t.tgname = g.tgname
      AND NOT t.tgisinternal
),
-- PostgREST calls a function by argument name. raiseHeldLines sends these,
-- through reconcile_item_raise itself or its named door (#1643).
raise_names AS (
  SELECT ARRAY['p_kind','p_subject_table','p_subject_id','p_job_ids',
    'p_suggestion','p_evidence','p_raised_by']::text[] AS sent
),
raise_overloads AS (
  SELECT p.proname, p.pronargs, p.proargnames,
    'p_org_id' = ANY (p.proargnames) AS takes_org,
    has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_runs,
    p.proargnames IS NOT NULL
      AND (p.proargnames[1:p.pronargs])::text[] @> r.sent
      AND r.sent @> (p.proargnames[1:p.pronargs - p.pronargdefaults])::text[] AS by_name
  FROM pg_catalog.pg_proc p CROSS JOIN raise_names r
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN ('reconcile_item_raise', 'reconcile_item_raise_named')
),
-- Ruling C11 (a): trade_invoice_lines has no org_id, so a held line's raise
-- passes the holding invoice's organisation as p_org_id (#1649).
org_hint AS (
  SELECT coalesce(bool_or(by_name AND takes_org AND service_role_runs), false) AS door
  FROM raise_overloads
),
-- reconcile_item_org resolves a subject only through a table with a uuid
-- org_id and a single-column primary key (20261118073218).
subjects(rel) AS (VALUES ('trade_invoice_lines'), ('jobs')),
subject_state AS (
  SELECT s.rel,
    EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass('public.' || s.rel) AND a.attname = 'org_id'
        AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype) AS has_org,
    EXISTS (SELECT 1 FROM pg_catalog.pg_index i
      WHERE i.indrelid = to_regclass('public.' || s.rel) AND i.indisprimary
        AND i.indnkeyatts = 1) AS single_key,
    s.rel = 'trade_invoice_lines' AND (SELECT door FROM org_hint) AS org_hint
  FROM subjects s
),
family(version) AS (VALUES
  ('20261117020000'), ('20261117172401'), ('20261117173901'), ('20261117174103'),
  ('20261118060051'), ('20261118070639'), ('20261118073218'), ('20261118122207'),
  ('20261118122208'), ('20261118122209'), ('20261118153101')
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
held AS (:held_rows),
held_state AS (
  SELECT bool_or(readable) AS readable,
    count(line_id) AS held_lines,
    count(line_id) FILTER (WHERE landed) AS raised
  FROM held
),
fixture_orders AS (
  SELECT count(*) AS approved_orders,
    count(*) FILTER (WHERE w.agreed_labour_ex > 0) AS with_agreed_labour
  FROM public.work_orders w JOIN fixture_job j ON j.id = w.job_id
  WHERE w.kind = 'job' AND w.status = 'approved'
),
checks(ord, kind, check_name, passed, evidence, source) AS (
  SELECT 1, 'required', 'C01 switch row trade_line_hold_v1 exists',
    EXISTS (SELECT 1 FROM flags WHERE flag_name = 'trade_line_hold_v1'),
    jsonb_build_object('enabled_now',
      (SELECT enabled FROM flags WHERE flag_name = 'trade_line_hold_v1')),
    '20261117173901 line 3'
  UNION ALL
  SELECT 2, 'required', 'C02 pay rule switch trade_pay_inclusive_super_v1 is on',
    coalesce((SELECT enabled FROM flags WHERE flag_name = 'trade_pay_inclusive_super_v1'), false),
    jsonb_build_object('enabled_now',
      (SELECT enabled FROM flags WHERE flag_name = 'trade_pay_inclusive_super_v1')),
    'trade_line_send.ts lineHoldSendApplies: the hold applies only under the pay rule'
  UNION ALL
  SELECT 3, 'required', 'C03 pay rule start date set, a Monday, not after today (Perth)',
    coalesce(s.readable, false) AND s.inclusive_super_from IS NOT NULL
      AND extract(isodow FROM s.inclusive_super_from) = 1
      AND s.inclusive_super_from <= (SELECT today FROM perth),
    jsonb_build_object('settings_readable', coalesce(s.readable, false),
      'inclusive_super_from', s.inclusive_super_from, 'today_perth', (SELECT today FROM perth)),
    'trade_pay_rule.ts readTradePayRule, tradePayBasisFor'
  FROM (SELECT 1) one LEFT JOIN settings s ON true
  UNION ALL
  SELECT 4, 'required', 'C04 hold columns present',
    NOT EXISTS (SELECT 1 FROM missing_columns),
    jsonb_build_object('expected', (SELECT count(*) FROM hold_columns),
      'missing', (SELECT coalesce(jsonb_agg(name ORDER BY name), '[]') FROM missing_columns)),
    '20261117173901, 20261117172401'
  UNION ALL
  SELECT 5, 'required', 'C05 hold tables present, row security on, no browser access',
    bool_and(present AND rls AND NOT browser_access),
    jsonb_agg(jsonb_build_object('table', rel, 'present', present, 'rls', rls,
      'browser_access', browser_access) ORDER BY rel),
    '20261117173901 lines 51-91'
  FROM hold_table_state
  UNION ALL
  SELECT CASE g.id WHEN 'notes' THEN 6 WHEN 'line_guard' THEN 7 ELSE 8 END, 'required',
    CASE g.id
      WHEN 'header_guard' THEN 'C08 header job amount guard trigger installed and enabled'
      WHEN 'line_guard' THEN 'C07 line job amount guard trigger installed, enabled, watches override_amount'
      ELSE 'C06 held line notes append-only trigger installed and enabled'
    END,
    g.present AND g.right_function AND g.enabled_code IN ('O', 'A')
      AND (g.id <> 'line_guard' OR g.watches_override),
    jsonb_build_object('trigger', g.tgname, 'present', g.present,
      'enabled_code', g.enabled_code, 'right_function', g.right_function,
      'watches_override_amount', g.watches_override),
    CASE g.id
      WHEN 'notes' THEN 'install_trade_line_hold() (20261117173901), owner-only'
      ELSE 'install_trade_line_job_amount_guard() (20261118153101), owner-only'
    END
  FROM trigger_state g
  UNION ALL
  SELECT 9, 'required', 'C09 cap functions present, service role only',
    bool_and(present AND service_role_runs AND NOT browser_runs),
    jsonb_agg(jsonb_build_object('function', signature, 'present', present,
      'service_role_runs', service_role_runs, 'browser_runs', browser_runs,
      'body_md5', body_md5) ORDER BY signature),
    '20261117173901, 20261118122208, 20261118153101'
  FROM fn_state WHERE id IN ('backed_room', 'backed_billed', 'send_totals', 'merge')
  UNION ALL
  SELECT 10, 'required', 'C10 reconcile_item_raise (or its named door) callable by argument name',
    coalesce(bool_or(by_name AND service_role_runs), false),
    jsonb_build_object('overloads', count(*), 'names_sent',
      (SELECT sent FROM raise_names),
      'overload_arg_names', coalesce(jsonb_agg(jsonb_build_object(
        'function', proname, 'args', pronargs, 'names', proargnames,
        'by_name', by_name, 'service_role_runs', service_role_runs)), '[]')),
    'trade_line_send.ts raiseHeldLines; follow-up P1-10.3 item 1; #1643'
  FROM raise_overloads
  UNION ALL
  SELECT 11, 'required', 'C11 held line raise subjects resolve an organisation (own org_id, or the org hint)',
    bool_and(single_key AND (has_org OR org_hint)),
    jsonb_agg(jsonb_build_object('table', rel, 'uuid_org_id', has_org,
      'single_column_key', single_key, 'org_hint_door', org_hint) ORDER BY rel),
    'reconcile_item_org (20261118073218); ruling C11 (a), #1649; raiseHeldLines subjects'
  FROM subject_state
  UNION ALL
  -- FU49 item 3 is code only (#1664): the door moves its draft to approved
  -- before any Xero contact or bill call, so the guard checks it first. No
  -- database object carries it, so SQL cannot see it.
  SELECT 12, 'not_checked', 'C12 work order door checks the cap before Xero (code, #1664)',
    NULL, jsonb_build_object('how',
      'git merge-base --is-ancestor <#1664 merge> <ops_api_version commit_sha>'),
    'FU49 item 3; #1664'
  UNION ALL
  SELECT 13, 'required', 'C13 office can decide a held line',
    present AND service_role_runs AND NOT browser_runs,
    jsonb_build_object('function', signature, 'present', present,
      'service_role_runs', service_role_runs, 'browser_runs', browser_runs),
    'P1-05.10; decide_held_trade_line is not on main at writing'
  FROM fn_state WHERE id = 'decide'
  UNION ALL
  SELECT 14, 'required', 'C14 every cap family migration is in the ledger',
    readable AND missing IS NULL,
    jsonb_build_object('ledger_readable', coalesce(readable, false),
      'versions', (SELECT count(*) FROM family), 'missing', coalesce(missing, '{}')),
    'supabase_migrations.schema_migrations'
  FROM ledger_state
  UNION ALL
  -- With no start date every job is out of the cap's scope
  -- (work_order_cap_scope), so the switch would hold and cap nothing.
  SELECT 15, 'required', 'C15 work order cap start date is set',
    coalesce(c.readable, false) AND c.cap_start_on IS NOT NULL,
    jsonb_build_object('settings_readable', coalesce(c.readable, false),
      'settings_row', c.readable IS NOT NULL, 'cap_start_on', c.cap_start_on,
      'today_perth', (SELECT today FROM perth)),
    '20261118193817 (work_order_cap_settings, work_order_cap_scope); set only by set_work_order_cap_start'
  FROM (SELECT 1) one LEFT JOIN cap_settings c ON true
  UNION ALL
  SELECT 20, 'fixture', 'F01 exactly one ZZTEST job with that number',
    (SELECT count(*) FROM fixture_job) = 1,
    jsonb_build_object('matched_jobs', (SELECT count(*) FROM fixture_job)),
    'input job_number'
  UNION ALL
  SELECT 21, 'fixture', 'F02 the ZZTEST job has one approved job work order with agreed labour',
    (SELECT count(*) FROM fixture_job) = 1 AND o.approved_orders = 1
      AND o.with_agreed_labour = 1,
    jsonb_build_object('approved_job_work_orders', o.approved_orders,
      'with_agreed_labour', o.with_agreed_labour),
    '20261012130000 (work_orders kind job)'
  FROM fixture_orders o
  UNION ALL
  SELECT 25, 'after_send', 'F03 a raise lands for a ZZTEST held line',
    coalesce(readable, false) AND held_lines > 0 AND raised = held_lines,
    jsonb_build_object('readable', coalesce(readable, false),
      'held_lines', held_lines, 'raised', raised,
      'state', CASE WHEN NOT coalesce(readable, false) THEN 'tables missing'
        WHEN held_lines = 0 THEN 'no held line yet: send one ZZTEST held line first'
        WHEN raised = held_lines THEN 'every held line has its office item'
        ELSE 'held lines without an office item' END),
    'raiseHeldLines (pay_line_held); director ruling C11 (a)'
  FROM held_state
  UNION ALL
  SELECT 30, 'not_checked', 'N01 deployed ops-api carries the cap code, the FU49 door and the C11 org hint (#1649)',
    NULL, jsonb_build_object('how',
      'ops_api_version commit_sha, then git merge-base --is-ancestor <merge> <commit_sha>'),
    'AGENTS.md: measure the deployed thing'
  UNION ALL
  SELECT 31, 'not_checked', 'N02 token or contact failure after the save (pending_acknowledgment) accepted',
    NULL, jsonb_build_object('how', 'director ruling on the FU49 follow-up'),
    'followups/FU49.md item 1'
  UNION ALL
  SELECT 32, 'not_checked', 'N03 the owner says turn it on',
    NULL, jsonb_build_object('how', 'owner''s word'), 'switch row is seeded off'
)
SELECT ord, kind, check_name,
  CASE WHEN kind = 'not_checked' THEN 'NOT CHECKED HERE'
       WHEN passed THEN 'PASS' ELSE 'FAIL' END AS result,
  evidence, source
FROM checks
UNION ALL
SELECT 99, 'overall', 'trade_line_hold_v1 preconditions (SQL-visible only)',
  CASE WHEN count(*) FILTER (WHERE kind IN ('required', 'fixture')
    AND passed IS NOT TRUE) = 0 THEN 'PASS' ELSE 'FAIL' END,
  jsonb_build_object(
    'required_failed', count(*) FILTER (WHERE kind = 'required' AND passed IS NOT TRUE),
    'fixture_failed', count(*) FILTER (WHERE kind = 'fixture' AND passed IS NOT TRUE),
    'not_checked_here', count(*) FILTER (WHERE kind = 'not_checked'),
    'after_send_failed', count(*) FILTER (WHERE kind = 'after_send' AND passed IS NOT TRUE)),
  'PASS here never means safe to switch: the not_checked rows need the director'
FROM checks
ORDER BY ord;

ROLLBACK;
