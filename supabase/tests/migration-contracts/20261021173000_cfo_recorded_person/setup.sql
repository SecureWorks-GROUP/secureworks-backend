-- 20261021173000_cfo_recorded_person: cfo_recorded_person reads
-- public.users(id, email). Live public.users carries email (read by
-- 20261005200000 and 20261007010000); the narrow stack adds it here.
CREATE TABLE IF NOT EXISTS public.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email text;
