-- The scorecard v2 (migration 20261007120000_context_scorecard_v2): the check
-- after it lands. READ ONLY: it ends in ROLLBACK and changes nothing. Run it on
-- production only after the migration is applied (its guard refuses until the
-- seven 7 Oct data sources are on the database).
--
-- Expect: the ledger row; the three bodies are v2's (md5 below) with a 50 s
-- statement timeout; the card is context-scorecard-v2 with its scope (live jobs,
-- monitored jobs, leads no longer followed up) and how long it took; one line per
-- row; every red lane with its value and note; the first page of jobs. Ids and
-- counts only: no customer words.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '120s';
SELECT version, name FROM supabase_migrations.schema_migrations WHERE version = '20261007120000';
SELECT p.oid::regprocedure AS fn, md5(p.prosrc) AS md5, p.proconfig
FROM pg_proc p
WHERE p.oid IN ('public.context_scorecard_policy()'::regprocedure, 'public.context_scorecard(timestamptz)'::regprocedure,
                'public.context_scorecard_jobs(uuid,integer,timestamptz)'::regprocedure)
ORDER BY 1;
-- v2's md5: policy cf2438ff9b72b8aca9191b0dcf80c7b6, card 13f30d2cd4cafb4b6c30f1243b6f3195,
-- jobs c0a2b2a18dfa2f6bc78f883911896d87.
WITH c AS (SELECT public.context_scorecard(now()) AS s, clock_timestamp() AS done_at)
SELECT c.s->>'version' AS version, c.s->'scope' AS scope, c.s->'summary'->'red_rows' AS red_rows,
       c.s->'summary'->>'green' AS green, c.s->'summary'->>'amber' AS amber, c.s->'summary'->>'red' AS red,
       round(extract(epoch FROM c.done_at - statement_timestamp())::numeric, 2) AS seconds
FROM c;
SELECT (r->>'row')::integer AS row_no, r->>'status' AS status, r->>'stage' AS stage
FROM jsonb_array_elements(public.context_scorecard(now())->'rows') r ORDER BY 1;
SELECT (r->>'row')::integer AS row_no, l->>'lane' AS lane, l->>'number' AS number, l->>'value' AS value, l->>'note' AS note
FROM jsonb_array_elements(public.context_scorecard(now())->'rows') r, jsonb_array_elements(r->'lanes') l
WHERE l->>'status' = 'red' ORDER BY (r->>'row')::integer, (l->>'lane') COLLATE "C";
SELECT x->>'job_number' AS job_number, x->>'status' AS status, x->'red_rows' AS red_rows
FROM jsonb_array_elements(public.context_scorecard_jobs(NULL, 20, now())->'jobs') x;
ROLLBACK;
