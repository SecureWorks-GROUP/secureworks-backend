-- Extend the registered production-shaped fixture; job/event IDs remain UUID.
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
 ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.job_events ADD COLUMN IF NOT EXISTS event_type text;
INSERT INTO public.jobs(id,org_id,status,type,job_number,accepted_at,updated_at) VALUES
 ('ea000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000aa','accepted','fencing','TEST-ACCEPT-EVENT',null,'2026-09-10T00:00:00Z'),
 ('ea000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000000aa','scheduled','patio','TEST-ACCEPT-ESTIMATE',null,'2026-09-09T00:00:00Z'),
 ('ea000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-0000000000aa','accepted','fencing','TEST-ACCEPT-EXISTING','2026-01-01T00:00:00Z','2026-09-09T00:00:00Z'),
 ('ea000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-0000000000aa','quoted','fencing','TEST-ACCEPT-NOT-WON',null,'2026-09-09T00:00:00Z');
INSERT INTO public.job_events(id,job_id,event_type,detail_json,created_at) VALUES
 ('eb000000-0000-4000-8000-000000000001','ea000000-0000-4000-8000-000000000001','status_changed','{"new_status":"accepted","source":"ghl_webhook"}','2026-08-01T00:00:00Z'),
 ('eb000000-0000-4000-8000-000000000002','ea000000-0000-4000-8000-000000000001','quote_accepted','{}','2026-08-02T00:00:00Z'),
 ('eb000000-0000-4000-8000-000000000003','ea000000-0000-4000-8000-000000000004','ghl_conflict','{"attempted_status":"accepted"}','2026-08-01T00:00:00Z');

INSERT INTO public.jobs(id,org_id,status,type,job_number,accepted_at,updated_at,deposit_at) VALUES
 ('ea000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-0000000000aa','accepted','fencing','TEST-MULTI-LATER-FULL',null,'2026-09-09T00:00:00Z','2026-07-01T00:00:00Z'),
 ('ea000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-0000000000aa','partially_accepted','fencing','TEST-MULTI-PARTIAL-ONLY',null,'2026-09-09T00:00:00Z','2026-07-01T00:00:00Z'),
 ('ea000000-0000-4000-8000-000000000007','00000000-0000-4000-8000-0000000000aa','quoted','fencing','TEST-AMBIGUOUS',null,'2026-09-09T00:00:00Z','2026-07-01T00:00:00Z'),
 ('ea000000-0000-4000-8000-000000000008','00000000-0000-4000-8000-0000000000aa','scheduled','fencing','TEST-PARTIAL-DOWNSTREAM',null,'2026-09-09T00:00:00Z','2026-07-01T00:00:00Z'),
 ('ea000000-0000-4000-8000-000000000009','00000000-0000-4000-8000-0000000000aa','accepted','fencing','TEST-SINGLE-FULL',null,'2026-09-09T00:00:00Z','2026-07-01T00:00:00Z'),
 ('ea000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-0000000000aa','scheduled','fencing','TEST-AMBIGUOUS-DOWNSTREAM',null,'2026-09-09T00:00:00Z','2026-07-01T00:00:00Z');
INSERT INTO public.job_events(id,job_id,event_type,detail_json,created_at) VALUES
 ('eb000000-0000-4000-8000-000000000010','ea000000-0000-4000-8000-000000000005','quote_accepted','{"document_id": "ec000000-0000-4000-8000-000000000051", "accepted_via": "share_link", "accepted_at": "2026-08-01T00:00:00Z", "job_number": "TEST-5", "client_name": "Contact 1", "contact_label": "Owner 1", "amount": 1100, "is_multi_contact": true, "new_status": "partially_accepted", "message": "Contact 1 accepted quote"}','2026-08-01T00:00:00Z'),
 ('eb000000-0000-4000-8000-000000000011','ea000000-0000-4000-8000-000000000005','quote_accepted','{"document_id": "ec000000-0000-4000-8000-000000000052", "accepted_via": "share_link", "accepted_at": "2026-08-02T00:00:00Z", "job_number": "TEST-5", "client_name": "Contact 2", "contact_label": "Owner 2", "amount": 1100, "is_multi_contact": true, "new_status": "partially_accepted", "message": "Contact 2 accepted quote"}','2026-08-02T00:00:00Z'),
 ('eb000000-0000-4000-8000-000000000012','ea000000-0000-4000-8000-000000000005','quote_accepted','{"document_id": "ec000000-0000-4000-8000-000000000053", "accepted_via": "share_link", "accepted_at": "2026-08-03T00:00:00Z", "job_number": "TEST-5", "client_name": "Contact 3", "contact_label": "Owner 3", "amount": 1100, "is_multi_contact": true, "new_status": "accepted", "message": "Contact 3 accepted quote"}','2026-08-03T00:00:00Z'),
 ('eb000000-0000-4000-8000-000000000013','ea000000-0000-4000-8000-000000000006','quote_accepted','{"document_id": "ec000000-0000-4000-8000-000000000061", "accepted_via": "share_link", "accepted_at": "2026-08-01T00:00:00Z", "job_number": "TEST-6", "client_name": "Contact 1", "contact_label": "Owner 1", "amount": 1100, "is_multi_contact": true, "new_status": "partially_accepted", "message": "Contact 1 accepted quote"}','2026-08-01T00:00:00Z'),
 ('eb000000-0000-4000-8000-000000000014','ea000000-0000-4000-8000-000000000006','quote_accepted','{"document_id": "ec000000-0000-4000-8000-000000000062", "accepted_via": "share_link", "accepted_at": "2026-08-02T00:00:00Z", "job_number": "TEST-6", "client_name": "Contact 2", "contact_label": "Owner 2", "amount": 1100, "is_multi_contact": true, "new_status": "partially_accepted", "message": "Contact 2 accepted quote"}','2026-08-02T00:00:00Z'),
 ('eb000000-0000-4000-8000-000000000015','ea000000-0000-4000-8000-000000000008','quote_accepted','{"document_id": "ec000000-0000-4000-8000-000000000081", "accepted_via": "share_link", "accepted_at": "2026-08-01T00:00:00Z", "job_number": "TEST-8", "client_name": "Contact 1", "contact_label": "Owner 1", "amount": 1100, "is_multi_contact": true, "new_status": "partially_accepted", "message": "Contact 1 accepted quote"}','2026-08-01T00:00:00Z'),
 ('eb000000-0000-4000-8000-000000000016','ea000000-0000-4000-8000-000000000009','quote_accepted','{"document_id": "ec000000-0000-4000-8000-000000000091", "accepted_via": "share_link", "accepted_at": "2026-08-03T00:00:00Z", "job_number": "TEST-9", "client_name": "Contact 1", "contact_label": "Owner 1", "amount": 1100, "is_multi_contact": false, "new_status": "accepted", "message": "Contact 1 accepted quote"}','2026-08-03T00:00:00Z'),
 ('eb000000-0000-4000-8000-000000000017','ea000000-0000-4000-8000-000000000007','quote_accepted','{"accepted_via": "share_link", "accepted_at": "2026-08-01T00:00:00Z", "is_multi_contact": false}','2026-08-01T00:00:00Z'),
 ('eb000000-0000-4000-8000-000000000018','ea000000-0000-4000-8000-000000000010','quote_accepted','{"accepted_via": "share_link", "accepted_at": "2026-08-01T00:00:00Z", "is_multi_contact": false}','2026-08-01T00:00:00Z');

INSERT INTO public.jobs(id,org_id,status,type,job_number,accepted_at,updated_at) VALUES
 ('ea000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-0000000000aa','invoiced','fencing','TEST-INVOICED-CHAIN',null,'2026-09-09T00:00:00Z'),
 ('ea000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-0000000000aa','awaiting_deposit','patio','TEST-AWAIT-DEPOSIT',null,'2026-09-09T00:00:00Z'),
 ('ea000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-0000000000aa','archived','fencing','TEST-ARCHIVED-NOT-CHAIN',null,'2026-09-09T00:00:00Z'),
 ('ea000000-0000-4000-8000-000000000014','00000000-0000-4000-8000-0000000000aa','schedule_install','fencing','TEST-SCHEDULE-INSTALL',null,'2026-09-09T00:00:00Z'),
 ('ea000000-0000-4000-8000-000000000015','00000000-0000-4000-8000-0000000000aa','awaiting_supplier','fencing','TEST-AWAIT-SUPPLIER',null,'2026-09-09T00:00:00Z'),
 ('ea000000-0000-4000-8000-000000000016','00000000-0000-4000-8000-0000000000aa','rectification','patio','TEST-RECTIFICATION',null,'2026-09-09T00:00:00Z');
