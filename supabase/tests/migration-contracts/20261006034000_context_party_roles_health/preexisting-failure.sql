-- A lane rule this migration has never seen (someone changed the scorecard
-- after W11): the migration must refuse by name rather than replace it.
CREATE OR REPLACE FUNCTION public.context_scorecard_lane_of(p_event_type text, p_source text, p_channel text, p_direction text,
 p_body text, p_metadata jsonb)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$ SELECT 'texts'::text $fn$;
