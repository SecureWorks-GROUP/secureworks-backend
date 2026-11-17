-- Keep all fixture schema and rows inside a rolled-back transaction. The real
-- table (including every trigger, constraint, later migration and row) survives.
BEGIN;
\ir ../../../migrations/20261117235502_cost_lines_backfill_mirror_index.sql
DROP INDEX public.trade_invoices_org_xero_bill_idx;
ALTER TABLE public.trade_invoices RENAME TO cx1547_saved_trade_invoices;
CREATE TABLE public.trade_invoices (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  xero_bill_id text
);
\ir ../../../migrations/20261117235502_cost_lines_backfill_mirror_index.sql
-- Reapply proves idempotence; plans below judge the access, never index names.
\ir ../../../migrations/20261117235502_cost_lines_backfill_mirror_index.sql
INSERT INTO public.trade_invoices(id,org_id,xero_bill_id)
SELECT md5('cx1547:'||o||':'||n)::uuid,
       md5('cx1547:org:'||o)::uuid,
       'bill-'||lpad(n::text,6,'0')
FROM generate_series(1,20) o CROSS JOIN generate_series(1,2000) n;
ANALYZE public.trade_invoices;
DO $test$
DECLARE plan jsonb; ids text; scan jsonb; query text;
BEGIN
  SELECT string_agg(quote_literal('bill-'||lpad(n::text,6,'0')), ',')
    INTO ids FROM generate_series(1,200) n;
  query := format('SELECT xero_bill_id FROM public.trade_invoices '
    ||'WHERE org_id=%L::uuid AND xero_bill_id IN (%s) LIMIT 1000',
    md5('cx1547:org:1')::uuid, ids);
  EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) '||query INTO plan;
  IF jsonb_path_exists(plan, '$.** ? (@."Node Type" == "Seq Scan")') THEN
    RAISE EXCEPTION 'mirror lookup scanned the estate: %',plan;
  END IF;
  SELECT value INTO scan FROM jsonb_path_query(plan,
    ('$.** ? (@."Relation Name" == "trade_invoices" && '
    ||'(@."Node Type" == "Index Scan" || @."Node Type" == "Index Only Scan" || '
    ||'@."Node Type" == "Bitmap Heap Scan"))')::jsonpath) value LIMIT 1;
  IF scan IS NULL OR (plan->0->'Plan'->>'Actual Rows')::int <> 200
    OR (scan->>'Actual Rows')::int > 200
    OR coalesce((scan->>'Rows Removed by Filter')::int,0) <> 0
    OR NOT jsonb_path_exists(plan,
      '$.** ? (@."Index Cond" like_regex "org_id" && @."Index Cond" like_regex "xero_bill_id")') THEN
    RAISE EXCEPTION 'mirror lookup not index-bound to org and page ids: %',plan;
  END IF;
  RAISE NOTICE 'PASS P2-01.8 mirror plan: 40000 fixtures, 200 returned, index-bound, no Seq Scan';
END $test$;
ROLLBACK;
