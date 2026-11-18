-- CI: the registered stack already holds P2-03.1, P2-03.2 and P4-01.6
-- (the eight-argument reconcile_item_raise), so this is a no-op. Isolated local
-- proof: build them from their own case files. No function stand-ins.
SELECT to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text,uuid)') IS NULL
  AS isolated_named_raise_setup \gset
\if :isolated_named_raise_setup
\ir ../20261118124439_context_reconcile_raise/setup.sql
\ir ../../../migrations/20261118124439_context_reconcile_raise.sql
\endif
