-- Draft register, check 6, for the ZZTEST job's organisation: every account
-- rule is confirmed by the bookkeeper (confirmed_at set). An unconfirmed rule
-- still fills drafts, but its code was never agreed. Counts only; who
-- confirmed is a person and is not printed.
\set zz_check 'draft_register.rules_confirmed'
\ir ../session.sql
WITH r AS (
  SELECT source_kind, count(*) AS rules, count(*) FILTER (WHERE confirmed_at IS NOT NULL) AS confirmed
  FROM public.xero_account_rules WHERE org_id = :'zz_org_id' GROUP BY source_kind
)
SELECT :'zz_check' AS "check",
       CASE WHEN (SELECT count(*) FROM r) > 0 AND (SELECT bool_and(rules = confirmed) FROM r) THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('by_source_kind', (SELECT coalesce(jsonb_object_agg(source_kind,
                            jsonb_build_object('rules', rules, 'confirmed', confirmed)), '{}') FROM r))::text AS evidence;
