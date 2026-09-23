-- Break the shared token rule: drop the space-joined extras. The contract must
-- fail on the N4 fixture ("SWP 26195"), which the TypeScript twin still reads.
CREATE OR REPLACE FUNCTION public.context_job_ref_tokens(p_text text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
 SELECT coalesce(array_agg(w ORDER BY w COLLATE "C"),'{}') FROM (
  SELECT DISTINCT w FROM regexp_split_to_table(btrim(upper(regexp_replace(coalesce(p_text,''),'[^a-zA-Z0-9-]+',' ','g'))),' ') w
  WHERE length(w)>=5 AND w ~ '[0-9]') t
$$;
