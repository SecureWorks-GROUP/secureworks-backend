-- Remove the seal: an approved job work order becomes editable again.
DROP TRIGGER IF EXISTS trg_work_orders_job_kind_guard ON public.work_orders;
CREATE TRIGGER trg_work_orders_job_kind_guard
  BEFORE INSERT OR DELETE ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.work_orders_job_kind_guard();
