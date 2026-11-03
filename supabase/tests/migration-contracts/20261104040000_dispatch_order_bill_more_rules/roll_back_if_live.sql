-- Rolls back B4 rules (c) and (d) (20261104040000) while its view is live, so an earlier contract can roll back
-- the email reader (20261002150000): v_dispatch_order_bills reads its attachments. A no-op on a stack without it.
SELECT coalesce(md5(pg_get_viewdef(to_regclass('public.v_dispatch_order_bills'), true)), '')
  = 'e55fe723cb6efdfd96c4e06ebb026f2f' AS b4_more_rules_live \gset
\if :b4_more_rules_live
\ir ../../../rollbacks/20261104040000_dispatch_order_bill_more_rules_down.sql
\endif
