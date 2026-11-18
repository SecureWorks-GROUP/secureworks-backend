SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

DROP FUNCTION IF EXISTS public.stock_division_option(text);
DROP FUNCTION IF EXISTS public.job_division_option(text, text);
