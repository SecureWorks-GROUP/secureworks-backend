-- Removes the one-press write and turns its switch off. The confirmations
-- table and its rows stay: who confirmed which amount is kept nowhere else.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP FUNCTION IF EXISTS public.confirm_job_work_order_labour(uuid, uuid, numeric, uuid, uuid);
UPDATE public.feature_flags SET enabled = false
 WHERE flag_name = 'job_work_order_labour_confirm_v1';
