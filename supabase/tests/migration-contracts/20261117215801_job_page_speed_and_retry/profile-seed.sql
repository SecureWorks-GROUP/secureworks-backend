-- OPTIONAL LOCAL PROFILE ONLY, not invoked by the contract runner.
-- Use a disposable PostgreSQL copy of the registered schema. No live export.
-- Replica mode bypasses fixture insertion side effects in this local copy only.
\set ON_ERROR_STOP on
SELECT coalesce(inet_server_addr() <<= '127.0.0.0/8'::inet,false)
 AND :'disposable_ack'='I-confirm-this-is-disposable-local-postgres' AS local_disposable \gset
\if :local_disposable
\else
 \echo 'Refused: disposable localhost PostgreSQL acknowledgement required'
 \quit 2
\endif
\set ON_ERROR_STOP on
SET TimeZone='UTC';
SET session_replication_role=replica;
INSERT INTO public.jobs(id,org_id,type,status,job_number,created_at,metadata)
SELECT md5('ZZTEST-page-'||g)::uuid,'00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-PAGE-'||g,now()-interval '30 days','{}'::jsonb
FROM generate_series(1,2500) g;
INSERT INTO public.business_events(id,job_id,event_type,channel,direction,source,provider_message_id,occurred_at,recorded_at,context_captured_at,attributed_at,attribution_status,payload,metadata)
SELECT md5('ZZTEST-page-event-'||g)::uuid,md5('ZZTEST-page-'||((g-1)%2500+1))::uuid,
 'client.email_received','email','inbound','ZZTEST','ZZTEST-event-'||g,
 now()-interval '10 days'+g*interval '1 second',now()-interval '10 days'+g*interval '1 second',
 now()-interval '10 days'+g*interval '1 second',now()-interval '10 days'+g*interval '1 second',
 'direct','{"body":"ZZTEST message"}'::jsonb,'{"written_as":"service_role"}'::jsonb
FROM generate_series(1,100000) g;
INSERT INTO public.business_events(id,job_id,event_type,channel,direction,source,provider_message_id,occurred_at,recorded_at,context_captured_at,attributed_at,attribution_status,payload,metadata)
SELECT md5('ZZTEST-page-call-'||g||'-'||k)::uuid,md5('ZZTEST-page-1')::uuid,
 CASE k WHEN 1 THEN 'client.call_logged' ELSE 'call.transcript_completed' END,'call','inbound','ghl',
 CASE k WHEN 1 THEN 'ghl:ZZTEST-call-'||g ELSE 'ghltx:ZZTEST-call-'||g END,
 now()-interval '8 days'+g*interval '1 second',now()-interval '8 days'+g*interval '1 second',
 now()-interval '8 days'+g*interval '1 second',now()-interval '8 days'+g*interval '1 second',
 'direct',jsonb_build_object('body','ZZTEST call','ghl_call_id','ZZTEST-call-'||g),'{"written_as":"service_role"}'::jsonb
FROM generate_series(1,200) g CROSS JOIN generate_series(1,2) k;
INSERT INTO public.xero_invoices(id,org_id,job_id,xero_invoice_id,invoice_number,invoice_type,status,invoice_date,due_date,created_at,line_items,raw_json)
SELECT md5('ZZTEST-page-invoice-'||g)::uuid,'00000000-0000-0000-0000-000000000001',md5('ZZTEST-page-'||((g-1)%2500+1))::uuid,
 'ZZTEST-xero-'||g,'ZZTEST-INV-'||g,'ACCREC','AUTHORISED',current_date-8,current_date-1,now()-interval '8 days','[]'::jsonb,'{}'::jsonb
FROM generate_series(1,10000) g;
SET session_replication_role=origin;
ANALYZE;
SELECT public.job_mark_changed(md5('ZZTEST-page-1')::uuid,'message');
