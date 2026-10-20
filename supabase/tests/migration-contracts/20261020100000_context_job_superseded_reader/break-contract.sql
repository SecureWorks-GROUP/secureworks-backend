-- Deliberately restore the slice 1 r1 body: the newest event wins, with a
-- same-instant tie broken by id::text COLLATE "C". It picks one side of an
-- opposite-type tie instead of answering unknown (S1-M1), so the contract
-- must fail on the trap. CREATE OR REPLACE keeps the comment and the grants,
-- so only the behaviour breaks.
CREATE OR REPLACE FUNCTION public.context_job_superseded_during(p_job uuid, p_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE AS $fn$
 SELECT CASE
  WHEN p_job IS NULL OR p_at IS NULL THEN NULL::boolean
  ELSE coalesce((
   SELECT e.event_type = 'quote_option_superseded'
     FROM public.job_events e
    WHERE e.job_id = p_job
      AND e.event_type IN ('quote_option_superseded', 'quote_option_unsuperseded')
      AND e.created_at IS NOT NULL
      AND e.created_at OPERATOR(pg_catalog.<=) p_at
    ORDER BY e.created_at DESC, e.id::text COLLATE "C" DESC
    LIMIT 1), false)
 END
$fn$;
