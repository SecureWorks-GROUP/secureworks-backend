-- Rolls back B4 rules (c) and (d) (20261104040000) while its view is live, so an earlier contract can roll back
-- the email reader (20261002150000): v_dispatch_order_bills reads its attachments. A no-op on a stack without it.
SELECT coalesce(md5(pg_get_viewdef(to_regclass('public.v_dispatch_order_bills'), true)), '')
  = '4bb5ce8ad2c5a57cf3d34df0e3c8bfd6' AS b4_more_rules_live \gset
\if :b4_more_rules_live
\ir ../../../rollbacks/20261104040000_dispatch_order_bill_more_rules_down.sql
\endif
