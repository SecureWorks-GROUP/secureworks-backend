-- Remove the seal: an approved customer variation becomes editable again.
DROP TRIGGER IF EXISTS trg_work_order_customer_variations_guard ON public.work_order_customer_variations;
CREATE TRIGGER trg_work_order_customer_variations_guard
  BEFORE INSERT OR DELETE ON public.work_order_customer_variations
  FOR EACH ROW EXECUTE FUNCTION public.work_order_customer_variations_guard();
