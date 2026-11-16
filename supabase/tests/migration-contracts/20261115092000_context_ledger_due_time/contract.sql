-- Contract for 20261115092000_context_ledger_due_time: the due list carries statement_timeout=45s
-- (PostgREST hoists it onto the worker's request) and nothing else about it changed.
\set ON_ERROR_STOP on

-- 1. Shape and access: the setting is there beside the fixed search_path; the list is still stable
-- SQL, a definer, and the service role's only.
DO $shape$
DECLARE sig constant text := 'public.context_ledger_due(integer)'; p record;
BEGIN
 SELECT pr.prosecdef, pr.provolatile, pr.proconfig, pg_get_function_result(pr.oid) AS res,
  (SELECT l.lanname FROM pg_language l WHERE l.oid = pr.prolang) AS lang
 INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(sig);
 IF p IS NULL THEN RAISE EXCEPTION 'due time contract: % is missing', sig; END IF;
 IF p.proconfig IS NULL OR NOT ('statement_timeout=45s' = ANY (p.proconfig)) THEN
  RAISE EXCEPTION 'due time contract: the due list must carry statement_timeout=45s (config %)', p.proconfig;
 END IF;
 IF p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp', 'statement_timeout=45s'] THEN
  RAISE EXCEPTION 'due time contract: the due list keeps its fixed search_path and gains only the timeout (config %)', p.proconfig;
 END IF;
 IF NOT p.prosecdef OR p.provolatile <> 's' OR p.lang <> 'sql' THEN
  RAISE EXCEPTION 'due time contract: the due list must stay stable SQL, security definer (%)', to_jsonb(p)::text;
 END IF;
 IF p.res <> 'TABLE(job_id uuid, kind text, reason text, priority integer, newest_evidence_at timestamp with time zone)' THEN
  RAISE EXCEPTION 'due time contract: the due list''s columns changed: %', p.res;
 END IF;
 IF has_function_privilege('anon', sig, 'EXECUTE') OR has_function_privilege('authenticated', sig, 'EXECUTE')
    OR has_function_privilege('public', sig, 'EXECUTE') OR NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
  RAISE EXCEPTION 'due time contract: the due list must be the service role''s only';
 END IF;
END $shape$;

-- 2. Re-applying the migration changes nothing: body, comment, settings and access.
BEGIN;
CREATE TEMP TABLE due_time_before AS
 SELECT md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c, p.proconfig AS cfg, p.proacl::text AS acl
 FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_ledger_due(integer)');
\ir ../../../migrations/20261115092000_context_ledger_due_time.sql
DO $again$
BEGIN
 IF (SELECT count(*) FROM due_time_before) <> 1 OR EXISTS (SELECT 1 FROM due_time_before x, pg_proc p
       WHERE p.oid = to_regprocedure('public.context_ledger_due(integer)')
        AND (md5(p.prosrc) IS DISTINCT FROM x.m OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM x.c
             OR p.proconfig IS DISTINCT FROM x.cfg OR p.proacl::text IS DISTINCT FROM x.acl)) THEN
  RAISE EXCEPTION 'due time contract: a re-apply must change nothing';
 END IF;
END $again$;
ROLLBACK;

-- 3. A replacement of the list that forgets the setting is caught by putting it back the same way:
-- the migration applies cleanly over a list with no timeout and leaves the body and comment alone.
BEGIN;
CREATE TEMP TABLE due_time_before AS
 SELECT md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c
 FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_ledger_due(integer)');
ALTER FUNCTION public.context_ledger_due(integer) RESET statement_timeout;
\ir ../../../migrations/20261115092000_context_ledger_due_time.sql
DO $fresh$
BEGIN
 IF EXISTS (SELECT 1 FROM due_time_before x, pg_proc p WHERE p.oid = to_regprocedure('public.context_ledger_due(integer)')
       AND (md5(p.prosrc) IS DISTINCT FROM x.m OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM x.c
            OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp', 'statement_timeout=45s'])) THEN
  RAISE EXCEPTION 'due time contract: applied over a list with no timeout, only the setting may change';
 END IF;
END $fresh$;
ROLLBACK;

-- 4. The service role still reads the list with the setting on it (a fresh session, so no cached
-- plan hides a refusal to enter a function that sets a timeout).
\c
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE service_role;
DO $read$
DECLARE n integer;
BEGIN
 SELECT count(*) INTO n FROM public.context_ledger_due(5);
 IF n IS NULL OR n > 5 THEN RAISE EXCEPTION 'due time contract: the service role''s read of the list failed (% rows)', n; END IF;
END $read$;
ROLLBACK;
