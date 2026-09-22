-- Independent exact-content decisions. Same private append/read storage pattern
-- as sales_booking_packs, isolated from its deprecated combined kind=stamp.
CREATE TABLE public.sales_booking_approvals (
  binding_hash text PRIMARY KEY CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
  step text NOT NULL CHECK (step IN ('calendar', 'message')),
  resource text NOT NULL CHECK (resource = 'marnin'),
  week_start date NOT NULL CHECK (EXTRACT(ISODOW FROM week_start) = 1),
  state text NOT NULL CHECK (state IN ('approved', 'refused')),
  reason text,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  approved_by_user_id uuid NOT NULL,
  approved_by_email text NOT NULL,
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > approved_at AND expires_at <= approved_at + interval '15 minutes'),
  CHECK ((state = 'approved' AND reason IS NULL) OR
         (state = 'refused' AND length(trim(reason)) BETWEEN 1 AND 1000 AND reason IS NOT NULL)),
  CHECK (snapshot ?& ARRAY['schema','step','resource','week_start','content_hash','content','pack_revision','contact_id']),
  CHECK (snapshot->>'schema' = 'scope-booking-approval.v1' AND snapshot->>'step' = step AND snapshot->>'resource' = resource)
);
ALTER TABLE public.sales_booking_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_booking_approvals FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.sales_booking_approvals TO service_role;
COMMENT ON TABLE public.sales_booking_approvals IS 'One immutable calendar OR exact-message approval/refusal per content binding. Never executes, never sends. Retries retain original actor/time/expiry.';
