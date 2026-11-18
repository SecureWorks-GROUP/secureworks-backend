-- Earlier registered cases supply the released work-order and held-line schema.
-- Mirror existing production indexes if a prior reduced fixture omitted them.
CREATE INDEX IF NOT EXISTS idx_inv_lines_job ON public.trade_invoice_lines(job_id);
CREATE INDEX IF NOT EXISTS idx_inv_lines_invoice ON public.trade_invoice_lines(trade_invoice_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_orders_job_current ON public.work_orders(job_id) WHERE kind='job';
CREATE INDEX IF NOT EXISTS idx_work_order_customer_variations_wo ON public.work_order_customer_variations(work_order_id) WHERE work_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS work_order_amount_changes_wo_idx ON public.work_order_amount_changes(work_order_id);
