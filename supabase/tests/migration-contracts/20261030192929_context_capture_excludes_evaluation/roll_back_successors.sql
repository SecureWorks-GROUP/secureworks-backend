-- Rolls back the registered successors of the CTX-T5 capture classification that
-- are live, newest first, so an earlier capture contract can roll its own chain
-- back: C1 capture lanes (20261103230000), which replaces both capture bodies
-- after this one. Each runs only while its body is live, so this is a no-op on
-- a stack that holds none.
SELECT coalesce((SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_source_freshness()')),'')
 ='35b687b9a9daff5c090eadc145ebbe12'
 OR coalesce((SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_source_freshness_policy()')),'')
 ='080b0163e5f58c6857312865864ec1e9' AS c1_lanes_successor_live \gset
\if :c1_lanes_successor_live
\ir ../../../rollbacks/20261103230000_context_capture_quiet_lanes_down.sql
\endif
