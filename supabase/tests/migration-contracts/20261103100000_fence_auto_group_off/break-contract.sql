-- Lose the fence guard: the helper stops seeing quoted labour outside the
-- pool. The contract must catch it on the coverage view (SWF-261459 shape).
CREATE OR REPLACE FUNCTION public.group_work_order_labour_outside_pool(p_scope_items jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
AS $$ SELECT false; $$;
