-- Only an isolated contract needs the earlier slices' setup.
SELECT to_regprocedure('public.reconcile_undo(bigint,uuid)') IS NULL AS needs_undo \gset
\if :needs_undo
\ir ../20261118195300_reconcile_undo/setup.sql
\ir ../../../migrations/20261118195300_reconcile_undo.sql
\endif
