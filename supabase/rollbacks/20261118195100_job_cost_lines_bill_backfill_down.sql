-- Rollback of the bills backfill database twin. Drops only its four functions;
-- cost lines it wrote stay (they are the same lines the sync writes).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DROP FUNCTION IF EXISTS public.job_cost_lines_backfill_bills(uuid, date, date, integer, date, text);
DROP FUNCTION IF EXISTS public.job_cost_lines_bill_document(uuid, jsonb, boolean);
DROP FUNCTION IF EXISTS public.job_cost_bill_json(double precision);
DROP FUNCTION IF EXISTS public.job_cost_bill_number(jsonb);
