-- Rolls back the registered successors of the ledger reader fixes' write that are live, newest first, so this contract
-- can re-apply its own migration over its own bodies: replaced by (20261104050000), which edits context_ledger_write
-- after this one. Each runs only while its body is live, so this is a no-op on a stack that holds none.
SELECT coalesce(md5(pg_get_functiondef(to_regprocedure('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)'))), '')
 = 'af7c768f7ef2d3e8b45bb0706a485194' AS replaced_by_successor_live \gset
\if :replaced_by_successor_live
\ir ../../../rollbacks/20261104050000_context_ledger_replaced_by_down.sql
\endif
