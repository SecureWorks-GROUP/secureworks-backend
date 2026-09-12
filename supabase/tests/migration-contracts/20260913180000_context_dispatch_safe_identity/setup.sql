ALTER TABLE public.business_events ADD COLUMN IF NOT EXISTS event_type text;
ALTER TABLE public.business_events ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE public.business_events ADD COLUMN IF NOT EXISTS entity_type text;
ALTER TABLE public.business_events ADD COLUMN IF NOT EXISTS entity_id text;
ALTER TABLE public.business_events ADD COLUMN IF NOT EXISTS correlation_id uuid;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS org_id uuid;
