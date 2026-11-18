-- Draft register, check 2: the table has every column recordXeroDraft writes
-- (xero_draft_register.ts) and the daily check reads, and a unique index on
-- exactly (org_id, xero_document_id), which its upsert names as onConflict.
\set zz_check 'draft_register.register_table'
\ir ../session.sql
WITH want(col) AS (
  SELECT unnest(ARRAY['id','org_id','xero_document_id','document_type','source_kind','source_id','register_row',
    'job_ids','drafted_at','lines_fingerprint','has_account_codes','has_division_tags','has_job_reference',
    'has_source_document','problems','approved_seen_at','approved_fingerprint','edited_before_approval'])
), missing AS (
  SELECT w.col FROM want w
  WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.xero_draft_register')
                    AND a.attname = w.col AND a.attnum > 0 AND NOT a.attisdropped)
), uniq AS (
  SELECT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = to_regclass('public.xero_draft_register') AND i.indisunique AND i.indpred IS NULL
      AND (SELECT array_agg(a.attname::text ORDER BY k.n) FROM unnest(i.indkey) WITH ORDINALITY k(attnum, n)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['org_id', 'xero_document_id']) AS ok
)
SELECT :'zz_check' AS "check",
       CASE WHEN to_regclass('public.xero_draft_register') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM missing)
             AND (SELECT ok FROM uniq) THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('table_found', to_regclass('public.xero_draft_register') IS NOT NULL,
                          'missing_columns', (SELECT coalesce(jsonb_agg(col), '[]') FROM missing),
                          'unique_org_document', (SELECT ok FROM uniq))::text AS evidence;
