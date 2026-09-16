-- Real B1 tables and B2 attribution migration precede this packet in the registry.
-- No substitute helpers. These optional reader columns mirror production types.
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS quoted_at timestamptz;

-- Pre-migration rows that mirror the three live populations (read 2026-09-16):
-- a legacy Haiku proposal with no source date (retain audit, never invent expiry),
-- a per-event Luna v1 fact that carries its source time in provenance, and an
-- operator override kind the stage-gate engine reads (must survive untouched).
INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES('b3000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','accepted','patio','B3-LEGACY-PROPOSAL');
INSERT INTO public.job_context(id,job_id,kind,value,provenance,created_at) VALUES
 ('b3000000-0000-0000-0000-000000000002','b3000000-0000-0000-0000-000000000001','proposal','{"text":"Legacy suggestion"}','{"extractor":"context-fact-extractor:v1.5","extracted_at":"2026-07-01T00:00:00Z"}',now()-interval '60 days'),
 ('b3000000-0000-0000-0000-000000000003','b3000000-0000-0000-0000-000000000001','proposal','{"text":"Source dated 2026-09-15 reports: can we book Tuesday"}',
  jsonb_build_object('extractor','context-luna-subscription:v1','writer_role','classifier','untrusted',false,'lifecycle','active',
   'source_occurred_at',to_char(now()-interval '1 day','YYYY-MM-DD"T"HH24:MI:SS.MSOF'),'source_event_ids',jsonb_build_array('b3000000-0000-0000-0000-00000000000e'),
   'safety',jsonb_build_object('memory_trusted',true,'action_safe',false,'state_change_safe',false,'outbound_safe',false)),now()),
 ('b3000000-0000-0000-0000-000000000004','b3000000-0000-0000-0000-000000000001','payment_agreement','{"text":"Deposit waived by MD"}','{"writer_role":"human"}',now()-interval '100 days');
INSERT INTO public.job_temporary_context(id,job_id,kind,value,provenance,expires_at,created_at) VALUES
 ('b3000000-0000-0000-0000-000000000005','b3000000-0000-0000-0000-000000000001','pending_action','{"text":"Source dated 2026-09-15 reports: call back Thursday"}',
  jsonb_build_object('extractor','context-luna-subscription:v1','writer_role','classifier','untrusted',false,'lifecycle','active',
   'source_occurred_at',to_char(now()-interval '2 days','YYYY-MM-DD"T"HH24:MI:SS.MSOF'),
   'safety',jsonb_build_object('memory_trusted',true,'action_safe',false,'state_change_safe',false,'outbound_safe',false)),
  now()-interval '1 day',now()-interval '2 days');
