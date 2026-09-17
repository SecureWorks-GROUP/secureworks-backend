-- Sales Booking pack + stamp store (17 Sep 2026).
--
-- The Booking door's live read had no proposed times or draft texts because the
-- engine pack never reached the backend, and the captain's Send stamp lived only
-- in browser memory. This table is the one server store both sides share:
--   kind=pack  — engine publish (proposals.json + coverage.json + drafts map)
--   kind=stamp — captain KEEP/CUT (approved/rejected/decisions/stage_moves)
-- Latest row per (resource, week_start, kind) is greatest as_of.
--
-- RLS on, no anon/authenticated policies: only ops-api (service role) reads
-- and writes. No send, no calendar write, no GHL write.

CREATE TABLE IF NOT EXISTS public.sales_booking_packs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource text NOT NULL CHECK (resource IN ('nithin', 'marnin')),
  week_start date NOT NULL CHECK (EXTRACT(ISODOW FROM week_start) = 1),
  kind text NOT NULL CHECK (kind IN ('pack', 'stamp')),
  as_of timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  published_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (resource, week_start, kind, as_of)
);

CREATE INDEX IF NOT EXISTS idx_sales_booking_packs_latest
  ON public.sales_booking_packs (resource, week_start, kind, as_of DESC);

COMMENT ON TABLE public.sales_booking_packs IS
  'Engine pack (kind=pack) and captain stamp (kind=stamp) for the Sales Booking door. Latest = greatest as_of per (resource, week_start, kind). Service-role only.';

ALTER TABLE public.sales_booking_packs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sales_booking_packs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.sales_booking_packs TO service_role, postgres;
