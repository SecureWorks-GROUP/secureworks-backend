BEGIN;
INSERT INTO public.jobs(id,org_id,job_number,type,status) VALUES
('35010000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','ZZTEST-3501','fencing','accepted');
INSERT INTO public.suppliers(id,name,xero_contact_id) VALUES
('35010000-0000-4000-8000-000000000002','ZZTEST supplier','ZZTEST-contact');
INSERT INTO public.purchase_orders(id,job_id,po_number,supplier_name,status,subtotal) VALUES
('35010000-0000-4000-8000-000000000003','35010000-0000-4000-8000-000000000001','ZZTEST-PO-3501','ZZTEST supplier','authorised',0);
INSERT INTO public.dispatch_supplier_order_emails(id,org_id,job_id,supplier_id,supplier_name,subject,status,sent_at,order_cost) VALUES
('35010000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000001','35010000-0000-4000-8000-000000000001','35010000-0000-4000-8000-000000000002','ZZTEST supplier','ZZTEST order','sent',now(),
'{"version":"dispatch-order-cost.v1","lines":[{"line_cost_ex_gst":1500.00},{"line_cost_ex_gst":500.00}]}'),
('35010000-0000-4000-8000-000000000005','00000000-0000-0000-0000-000000000001','35010000-0000-4000-8000-000000000001','35010000-0000-4000-8000-000000000002','ZZTEST supplier','ZZTEST order','sent',now(),
'{"version":"dispatch-order-cost.v1","lines":[{"line_cost_ex_gst":1500.00},{}]}'),
('35010000-0000-4000-8000-000000000006','00000000-0000-0000-0000-000000000001','35010000-0000-4000-8000-000000000001','35010000-0000-4000-8000-000000000002','ZZTEST supplier','ZZTEST order','draft',NULL,NULL);
INSERT INTO public.job_cost_lines(org_id,kind,document_kind,document_id,line_key,lane,amount_ex,state,source_hash,order_kind,order_id)
VALUES('00000000-0000-0000-0000-000000000001','supplier_bill','xero_bill','ZZTEST-order','1','materials',2000,'needs_person','ZZTEST','dispatch_order','35010000-0000-4000-8000-000000000004');
DO $$
BEGIN
 IF public.supplier_name_key('ZZTEST Steel Pty Ltd') IS DISTINCT FROM 'zzteststeel' THEN RAISE EXCEPTION 'orders: supplier key'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.v_job_orders WHERE order_id='35010000-0000-4000-8000-000000000003' AND cost_ex IS NULL AND NOT from_sealed_scope) THEN RAISE EXCEPTION 'orders: unknown purchase cost'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.v_job_orders WHERE order_id='35010000-0000-4000-8000-000000000004' AND cost_ex=2000 AND from_sealed_scope AND matched AND job_live AND order_number IS NULL AND party_id='ZZTEST-contact') THEN RAISE EXCEPTION 'orders: sealed sum or matched'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.v_job_orders WHERE order_id='35010000-0000-4000-8000-000000000005' AND cost_ex IS NULL) THEN RAISE EXCEPTION 'orders: partial cost'; END IF;
 IF EXISTS(SELECT 1 FROM public.v_job_orders WHERE order_id='35010000-0000-4000-8000-000000000006') THEN RAISE EXCEPTION 'orders: draft present'; END IF;
 IF has_table_privilege('authenticated','public.v_job_orders','SELECT') OR has_table_privilege('anon','public.v_job_orders','SELECT') OR NOT has_table_privilege('service_role','public.v_job_orders','SELECT') THEN RAISE EXCEPTION 'orders: grants'; END IF;
END $$;
ROLLBACK;
