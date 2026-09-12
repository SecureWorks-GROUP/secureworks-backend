\set ON_ERROR_STOP on
alter table jobs add column job_number text,add column client_name text,add column type text;
update jobs set job_number='FIXTURE-DISPATCH-1',client_name='Local fixture customer',type='patio',site_address='Fixture site address' where id='10000000-0000-4000-8000-000000000001';
update jobs set job_number='FIXTURE-DISPATCH-2',client_name='Unresolved acceptance fixture',type='fencing' where id='10000000-0000-4000-8000-000000000002';
alter table job_documents add column pdf_url text;
alter table po_communications add column po_id uuid,add column from_email text,add column to_email text,add column subject text,add column body_text text,add column body_html text,add column thread_id text,add column message_id text;
alter table job_media add column storage_url text,add column type text;
alter table job_assignments add column user_id uuid,add column scheduled_date date,add column scheduled_end date,add column start_time time,add column end_time time,add column status text;
create view calendar_events as select a.id as assignment_id,a.job_id,a.user_id,a.scheduled_date,a.scheduled_end,a.start_time,a.end_time,a.status as assignment_status,'Fixture crew'::text as crew_name,j.org_id,j.job_number from job_assignments a join jobs j on j.id=a.job_id;
insert into purchase_orders(id,org_id,job_id,po_number,supplier_name,status,line_items) values('70000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','FIXTURE-PO-1','Fixture supplier','authorised','[{"description":"Fixture roof sheet","quantity":20,"unit":"each","unit_price":null}]');
insert into po_communications(id,job_id,po_id,from_email,to_email,subject,body_text,thread_id,message_id) values('80000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','supplier@example.test','ops@example.test','Fixture delivery reply','Fixture only: first eight sheets at yard.','fixture-thread-1','fixture-message-1');
