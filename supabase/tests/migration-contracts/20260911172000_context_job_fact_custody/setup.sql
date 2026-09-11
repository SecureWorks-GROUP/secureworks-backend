-- Real B1 tables and B2 attribution migration precede this packet in the registry.
-- No substitute helpers. These optional reader columns mirror production types.
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS quoted_at timestamptz;
