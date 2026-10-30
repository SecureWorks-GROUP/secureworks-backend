-- Rolls back the registered successors of the L1g rules ladder that are live,
-- newest first, so an earlier ladder contract can roll its own chain back:
-- TP-04's holding flag (20261029190000), then unplaced stage 1
-- (20261014170000). Each runs only while its body is live, so this is a no-op
-- on a stack that holds neither.
SELECT coalesce((SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.resolve_context_attribution(public.business_events,boolean,boolean)')),'')
 ='2ccef791fca954bfe1fcbb4e0de5f8a2' AS tp04_successor_live \gset
\if :tp04_successor_live
\ir ../../../rollbacks/20261029190000_context_ladder_holding_flag_down.sql
\endif
SELECT coalesce(obj_description(to_regprocedure('public.resolve_context_attribution(public.business_events,boolean,boolean)'),'pg_proc'),'')
 LIKE 'L1g plus unplaced stage 1%' AS s1_successor_live \gset
\if :s1_successor_live
\ir ../../../rollbacks/20261014170000_context_unplaced_stage1_down.sql
\endif
