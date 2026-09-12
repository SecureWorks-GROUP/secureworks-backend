-- Real B1 tables and B2 attribution migration precede this packet in the registry.
-- No substitute helpers. These optional reader columns mirror production types.
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS quoted_at timestamptz;

-- A legacy proposal has no trustworthy event date: retain audit, never invent expiry.
INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES('b3000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','accepted','patio','B3-LEGACY-PROPOSAL');
INSERT INTO public.job_context(id,job_id,kind,value,provenance,created_at) VALUES('b3000000-0000-0000-0000-000000000002','b3000000-0000-0000-0000-000000000001','proposal','{"text":"Legacy suggestion"}','{}',now()-interval '60 days');
