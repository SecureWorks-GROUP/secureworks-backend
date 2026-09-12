ALTER TABLE public.business_events ADD COLUMN IF NOT EXISTS event_type text;
ALTER TABLE public.business_events ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE public.business_events ADD COLUMN IF NOT EXISTS entity_type text;
ALTER TABLE public.business_events ADD COLUMN IF NOT EXISTS entity_id text;
ALTER TABLE public.business_events ADD COLUMN IF NOT EXISTS correlation_id uuid;
ALTER TABLE public.business_events ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.business_events ADD COLUMN IF NOT EXISTS attribution_status text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS org_id uuid;
UPDATE public.jobs SET org_id='00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;
