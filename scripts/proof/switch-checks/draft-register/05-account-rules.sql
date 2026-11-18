-- Draft register, check 5, for the ZZTEST job's organisation: every kind of
-- draft the register records has a 'default' account rule, so a line of a
-- kind with no rule of its own still finds a code (accountRuleFor). Evidence:
-- the line kinds each source kind has, never an account code.
\set zz_check 'draft_register.account_rules'
\ir ../session.sql
\if :zz_ok
WITH k(source_kind) AS (VALUES ('trade_invoice'), ('expense_receipt'), ('supplier_bill'), ('supplier_credit')),
per AS (
  SELECT k.source_kind,
         coalesce(jsonb_agg(r.line_kind ORDER BY r.line_kind) FILTER (WHERE r.line_kind IS NOT NULL), '[]') AS line_kinds,
         bool_or(r.line_kind = 'default' AND btrim(r.account_code) <> '') AS has_default
  FROM k LEFT JOIN public.xero_account_rules r ON r.org_id = :'zz_org_id' AND r.source_kind = k.source_kind
  GROUP BY k.source_kind
)
SELECT :'zz_check' AS "check",
       CASE WHEN (SELECT bool_and(coalesce(has_default, false)) FROM per) THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('by_source_kind', (SELECT jsonb_object_agg(source_kind,
                            jsonb_build_object('line_kinds', line_kinds, 'has_default', coalesce(has_default, false))) FROM per))::text AS evidence;
\endif
