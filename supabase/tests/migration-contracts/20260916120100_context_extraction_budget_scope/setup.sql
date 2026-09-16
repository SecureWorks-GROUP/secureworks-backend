-- Production jobs.metadata is jsonb; holding jobs carry metadata.do_not_schedule = true.
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
