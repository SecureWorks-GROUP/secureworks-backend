INSERT INTO public.users(id,org_id,name,role) VALUES
 ('ee190000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','ZZTEST office','ops_manager'),
 ('ee190000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000001','ZZTEST crew','crew');
UPDATE public.work_order_settings SET approver_user_ids=approver_user_ids||'ee190000-0000-4000-8000-000000000001'::uuid WHERE id=1;
INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES
 ('ee190000-0000-4000-8000-000000000101','00000000-0000-0000-0000-000000000001','makesafe','processing','ZZTEST-R1'),
 ('ee190000-0000-4000-8000-000000000102','00000000-0000-0000-0000-000000000001','makesafe','processing','ZZTEST-R2');
INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex,scope_items,special_instructions)
 VALUES('ee190000-0000-4000-8000-000000000201','00000000-0000-0000-0000-000000000001','ee190000-0000-4000-8000-000000000101','ZZTEST-WO','job','draft',80,'[]','ZZTEST inspect and quote');
UPDATE public.work_orders SET status='approved',approved_by='ee190000-0000-4000-8000-000000000001' WHERE id='ee190000-0000-4000-8000-000000000201';
INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,title,agreed_labour_ex,scope_items,special_instructions)
 VALUES('ee190000-0000-4000-8000-000000000301','00000000-0000-0000-0000-000000000001','ee190000-0000-4000-8000-000000000101','WO-ZZTEST-R1-2','additional','draft','ZZTEST restoration works',352,'[{"description":"Strip out"}]','ZZTEST demo day'),
       ('ee190000-0000-4000-8000-000000000302','00000000-0000-0000-0000-000000000001','ee190000-0000-4000-8000-000000000102','WO-ZZTEST-R2-2','additional','draft','ZZTEST no main',100,'[]','ZZTEST');
