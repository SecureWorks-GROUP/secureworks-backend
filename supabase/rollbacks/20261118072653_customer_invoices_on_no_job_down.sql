DROP FUNCTION IF EXISTS public.customer_invoices_on_no_job(uuid, date, date);
DELETE FROM public.feature_flags WHERE flag_name = 'customer_invoice_no_job_items_v1';
