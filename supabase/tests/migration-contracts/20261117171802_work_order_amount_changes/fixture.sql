INSERT INTO public.users(id,org_id,name,role) VALUES
 ('ee180000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','ZZTEST office','ops_manager'),
 ('ee180000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000001','ZZTEST crew','crew');
UPDATE public.work_order_settings SET approver_user_ids=approver_user_ids||'ee180000-0000-4000-8000-000000000001'::uuid WHERE id=1;
INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES
 ('ee180000-0000-4000-8000-000000000101','00000000-0000-0000-0000-000000000001','patio','quoted','ZZTEST-P2');
INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex,scope_items,special_instructions)
 VALUES('ee180000-0000-4000-8000-000000000201','00000000-0000-0000-0000-000000000001','ee180000-0000-4000-8000-000000000101','ZZTEST-WO','job','draft',1120,'[]','ZZTEST scope');
UPDATE public.jobs SET status='accepted' WHERE id='ee180000-0000-4000-8000-000000000101';
UPDATE public.work_orders SET status='approved',approved_by='ee180000-0000-4000-8000-000000000001' WHERE id='ee180000-0000-4000-8000-000000000201';
