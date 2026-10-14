-- Deliberately put the adapter list back to what production held before this
-- migration (no 'ambrose'). contract.sql must fail on it.
ALTER TABLE public.makesafe_intake_cases
  DROP CONSTRAINT makesafe_intake_cases_deterministic_shapes_check;
ALTER TABLE public.makesafe_intake_cases
  ADD CONSTRAINT makesafe_intake_cases_deterministic_shapes_check CHECK (
    adapter_id IS NULL
    OR adapter_id IN (
      'mlb', 'ajs_ajbr', 'prime', 'rapid', 'builderwest', 'western',
      'chatter', 'synthetic_livefire'
    )
  );
