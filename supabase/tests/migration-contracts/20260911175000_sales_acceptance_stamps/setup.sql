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
