-- Production business_events.job_id is UUID (not old pre-April text).
ALTER TABLE public.business_events ADD COLUMN IF NOT EXISTS body_preview text,
 ADD COLUMN IF NOT EXISTS match_confidence numeric,ADD COLUMN IF NOT EXISTS direction text;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS client_email text, ADD COLUMN IF NOT EXISTS client_phone text;
CREATE TABLE IF NOT EXISTS public.purchase_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,po_number text);

-- The checked-in T7 envelope constraint; live readback unavailable (HTTP401).
ALTER TABLE public.business_events ADD CONSTRAINT b2_fixture_match_status CHECK (match_status IN ('matched','ambiguous','unresolved','ignored') OR match_status IS NULL);
