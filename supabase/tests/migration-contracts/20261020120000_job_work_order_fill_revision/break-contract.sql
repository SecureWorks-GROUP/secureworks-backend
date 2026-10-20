-- Break: drop the guard; the contract must then fail when a draft revision is accepted.
DROP TRIGGER trg_work_orders_fill_revision_guard ON public.work_orders;
