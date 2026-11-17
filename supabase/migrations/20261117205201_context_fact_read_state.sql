-- P4-04.3: gate only the fact-candidate read in the shared worker state.
-- Missing flag preserves the existing read. No flag, lane or stored row changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.context_worker_state()'::regprocedure);
  before_text constant text := $before$'facts', public.context_worker_facts_present()$before$;
  after_text constant text := $after$'facts', CASE WHEN coalesce((SELECT f.enabled FROM public.feature_flags f
        WHERE f.flag_name = 'context_fact_read_v1'), true)
        THEN public.context_worker_facts_present()
        ELSE 0 END$after$; BEGIN
  IF strpos(definition, after_text) > 0 AND strpos(definition, before_text) = 0 THEN
    RETURN;
  END IF;
  IF (length(definition) - length(replace(definition, before_text, ''))) / length(before_text) <> 1
    OR strpos(definition, after_text) > 0 THEN
    RAISE EXCEPTION 'context_worker_state: fact candidate expression differs';
  END IF;
  EXECUTE replace(definition, before_text, after_text);
END $migration$;
