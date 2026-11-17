-- P4-04.3: gate only the fact-candidate read in the shared worker state.
-- Missing flag preserves the existing read. No flag, lane or stored row changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.context_worker_state()'::regprocedure);
  body_hash text := (SELECT md5(p.prosrc) FROM pg_proc p
    WHERE p.oid = 'public.context_worker_state()'::regprocedure);
  before_text constant text := $before$'facts', public.context_worker_facts_present()$before$;
  after_text constant text := $after$'facts', CASE WHEN coalesce((SELECT f.enabled FROM public.feature_flags f
        WHERE f.flag_name = 'context_fact_read_v1'), true)
        THEN public.context_worker_facts_present()
        ELSE 0 END$after$; BEGIN
  -- Rule 15: exact main body after the 210101 mark-read migration.
  -- A repeated apply accepts only this exact result, never an unrelated body.
  IF body_hash = '02f8087bdb8e6a36ca35812faf2062fd' THEN
    RETURN;
  END IF;
  IF body_hash IS DISTINCT FROM '7a87765bca2ee439dbf793c99989247c' THEN
    RAISE EXCEPTION 'context_worker_state: Rule 15 pre-image changed';
  END IF;
  EXECUTE replace(definition, before_text, after_text);
END $migration$;
