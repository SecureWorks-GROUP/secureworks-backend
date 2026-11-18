-- CI: the registered stack holds 20261118124326_job_cost_proven_share and all
-- prerequisites, with no function stand-ins.
SELECT to_regprocedure('public.job_cost_proven_share(uuid[])') IS NULL AS need_share_base \gset
\if :need_share_base
\ir ../../../migrations/20261118124326_job_cost_proven_share.sql
\endif
