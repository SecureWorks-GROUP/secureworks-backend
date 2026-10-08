-- Another lane changed the scorecard by hand (its body is neither W11's nor
-- this migration's), and a function under the party roles read's name is not
-- the slice's own. The guard must refuse and name both, not replace anything.
CREATE OR REPLACE FUNCTION public.context_scorecard(p_as_of timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT '{"version": "hand-made"}'::jsonb $$;
COMMENT ON FUNCTION public.context_party_roles_lanes(timestamptz, integer) IS 'hand-made read';
