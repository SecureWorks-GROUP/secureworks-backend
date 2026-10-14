-- Ship the reserve table but not the ceiling: the down migration puts back
-- 20260924220000's cadence, K1's claim and the old status block, then the
-- settings table is created again with its default row. A catch-up-only job
-- is then due at 300 calls and the contract must catch it.
-- (The call cap setting, 20261013100000, replaced the cadence and the status block after this
-- migration: when a full stack has it, it is rolled back first, as this down demands.)
SELECT to_regprocedure('public.context_cadence_policy_today()') IS NOT NULL AS call_cap_setting_live \gset
\if :call_cap_setting_live
-- Roll back the later daily recheck before the body this proof needs.
SELECT (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_core_status()')) = 'bf6a84ad3b2fdcc0f9f1ba2f253b72a2' AS rc_later_live \gset
\if :rc_later_live
\ir ../../../rollbacks/20261014034549_context_recheck_messages_first_down.sql
\endif
\ir ../../../rollbacks/20261013100000_context_call_cap_setting_down.sql
\endif
\ir ../../../rollbacks/20261005233000_context_backlog_ceiling_down.sql
CREATE TABLE public.context_cadence_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK (id),
 live_reserve_calls_day integer NOT NULL DEFAULT 100 CHECK (live_reserve_calls_day>=0),
 live_reserve_calls_morning integer NOT NULL DEFAULT 100 CHECK (live_reserve_calls_morning>=0),
 live_reserve_reads_per_job integer NOT NULL DEFAULT 2 CHECK (live_reserve_reads_per_job>=0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 note text
);
ALTER TABLE public.context_cadence_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_cadence_settings FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.context_cadence_settings TO service_role;
INSERT INTO public.context_cadence_settings(id) VALUES(true);
