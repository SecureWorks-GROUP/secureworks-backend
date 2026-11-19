-- Original production column used only by the profile-change fixtures.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS trade_details jsonb;
