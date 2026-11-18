-- Stored reader, check 4: each of the 11 profit refresh source tables
-- carries an enabled job_profit_changed trigger (O origin or A always; D
-- disabled and R replica-only skip ordinary writes). Same list and order as
-- job_story_stored_profit_setup.
\set zz_check 'stored_reader.source_triggers'
\ir ../session.sql
\if :zz_ok
WITH t(name, ord) AS (
  SELECT * FROM unnest(ARRAY['job_materials_facts','trade_invoice_lines','trade_invoices','purchase_orders',
    'job_budgets','xero_invoices','xero_supplier_credit_note_allocations','jobs','work_orders',
    'group_work_order_shares','group_work_orders']) WITH ORDINALITY
), found AS (
  SELECT t.name, t.ord, g.tgenabled::text AS mode
  FROM t LEFT JOIN pg_trigger g ON g.tgrelid = to_regclass('public.' || t.name) AND g.tgname = 'job_profit_changed'
)
SELECT :'zz_check' AS "check",
       CASE WHEN (SELECT count(*) FROM found WHERE mode IN ('O', 'A')) = 11 THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('enabled', (SELECT count(*) FROM found WHERE mode IN ('O', 'A')),
                          'not_enabled', (SELECT coalesce(jsonb_agg(jsonb_build_object('table', name, 'mode', mode) ORDER BY ord), '[]')
                                          FROM found WHERE mode IS NULL OR mode NOT IN ('O', 'A')))::text AS evidence;
\endif
