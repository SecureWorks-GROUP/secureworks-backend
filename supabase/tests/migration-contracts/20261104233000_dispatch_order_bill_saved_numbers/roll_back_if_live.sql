-- Rolls back B4 rules (e) and (f) (20261104233000) while its view is live, so an earlier contract can roll back
-- 20261104040000 and then the email reader (20261002150000): v_dispatch_order_bills reads its attachments. A no-op
-- on a stack without it.
SELECT coalesce(md5(pg_get_viewdef(to_regclass('public.v_dispatch_order_bills'), true)), '')
  = '8f4d6f8fd3ad096dd39f4822913bb76a' AS b4_saved_numbers_live \gset
\if :b4_saved_numbers_live
\ir ../../../rollbacks/20261104233000_dispatch_order_bill_saved_numbers_down.sql
\endif
