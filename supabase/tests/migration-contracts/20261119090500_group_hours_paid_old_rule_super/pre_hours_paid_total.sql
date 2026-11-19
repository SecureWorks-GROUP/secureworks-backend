-- Byte copy of group_work_order_hours_paid_total from 20261106160000 (main's
-- body before 20261119090500), for the break proof.
CREATE OR REPLACE FUNCTION public.group_work_order_hours_paid_total(p_job uuid, p_basis text)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(sum(public.group_work_order_hours_paid_budget(p_basis, h.gross_ex)), 0)
  FROM public.group_work_order_hours_paid(p_job) h;
$$;
