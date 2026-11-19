-- Remove the hold: a disputed office entry no longer stops the freeze. The
-- contract must catch it.
DROP TRIGGER trg_group_work_orders_office_dispute_hold ON public.group_work_orders;
