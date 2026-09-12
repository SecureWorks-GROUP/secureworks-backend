-- B5 mail streams already registered. Need a business_events row for the logical source.
ALTER TABLE public.business_events ADD COLUMN IF NOT EXISTS event_type text;
