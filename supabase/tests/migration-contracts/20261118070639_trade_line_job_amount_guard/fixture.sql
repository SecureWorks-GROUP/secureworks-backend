-- Made-up rows only. Existing business triggers are bypassed during fixture setup.
INSERT INTO public.jobs(id,org_id,type,status,job_number)
VALUES('f1050900-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-P1-05-9');
INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex,
 approved_at,approved_by,sealed_content_hash)
VALUES('f1050900-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000001',
 'f1050900-0000-4000-8000-000000000001','ZZTEST-P1-05-9-WO','job','approved',120,
 now(),'f1050900-0000-4000-8000-000000000003','ZZTEST sealed');
INSERT INTO public.trade_invoices(id,org_id,user_id,invoice_number,week_start,week_end,total_hours,
 status,invoice_kind,subtotal_ex,gst,total_inc,gst_on,super_rate,super_amount,gross_earned,net_pay)
VALUES
 ('f1050900-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000001',
 'f1050900-0000-4000-8000-000000000003','ZZTEST-P1-05-9-A','2026-11-16','2026-11-22',0,
 'pending_ops_review','standard',0,0,0,false,0.12,0,0,0),
 ('f1050900-0000-4000-8000-000000000005','00000000-0000-0000-0000-000000000001',
 'f1050900-0000-4000-8000-000000000006','ZZTEST-P1-05-9-B','2026-11-16','2026-11-22',0,
 'pending_ops_review','standard',0,0,0,false,0.12,0,0,0);
