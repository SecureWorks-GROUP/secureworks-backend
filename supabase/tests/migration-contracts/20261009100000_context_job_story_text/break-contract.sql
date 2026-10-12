-- Ship a freshness hash over the whole card (the literal "md5 of the card"):
-- every saved story would read stale as soon as the clock moved (as_of,
-- built_at, a day count in a line), and the writer would rewrite every job's
-- story every day. The contract's digest checks must catch it.
CREATE OR REPLACE FUNCTION public.context_job_story_card_hash(p_card jsonb)
RETURNS text
LANGUAGE sql STABLE STRICT
AS $fn$
 SELECT md5(p_card::text)
$fn$;
