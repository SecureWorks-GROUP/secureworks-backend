-- Runs after supabase/rollbacks/20261117020000_trade_pay_inclusive_super_down.sql
-- against the exact forward stack it reverses. The down ran with no
-- new-basis invoice and succeeded. Here: the old surface is back, and with a
-- new-basis invoice the down refuses.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF to_regclass('public.trade_pay_settings') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback did not drop trade_pay_settings';
  END IF;
  IF to_regprocedure('public.trade_pay_rule_on(date)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback did not drop trade_pay_rule_on';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'trade_pay_inclusive_super_v1') THEN
    RAISE EXCEPTION 'rollback did not remove the switch';
  END IF;
  IF position('super_basis' IN pg_get_functiondef('public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure)) > 0
     OR position('super_basis' IN pg_get_functiondef('public.persist_trade_work_order_invoice_v1(jsonb,jsonb,uuid)'::regprocedure)) > 0
     OR position('group_split_inclusive_super_invoice' IN pg_get_functiondef('public.unfreeze_group_work_order_split(uuid,uuid)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'rollback did not restore the function bodies';
  END IF;
  IF position('i.super_basis IS NOT NULL' IN pg_get_functiondef('public.trade_invoice_lines_group_share_snapshot()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'rollback did not restore the group share line guard';
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'trade_invoices_super_basis_check')) LIKE '%inclusive_12_112_v1%'
     OR pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'trade_invoices_super_gst_split_check')) LIKE '%inclusive_12_112_v1%' THEN
    RAISE EXCEPTION 'rollback did not restore the two checks';
  END IF;
END $$;

-- The down refuses while a new-basis invoice exists. Its refusal block is read
-- from the down file between its <refusal> markers (path from the repository
-- root, where CI runs this suite) and run against a stack with the forward
-- migration applied again and one new-basis invoice. All rolled back.
\set refusal `sed -n '/^-- <refusal>$/,/^-- <\/refusal>$/p' supabase/rollbacks/20261117020000_trade_pay_inclusive_super_down.sql`
BEGIN;
\ir ../../../migrations/20261117020000_trade_pay_inclusive_super.sql
INSERT INTO public.users (id, org_id, name) VALUES
  ('f1170000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000001', 'ZZTEST Crew RB');
INSERT INTO public.trade_invoices (org_id, user_id, status, subtotal_ex, gross_earned, super_rate, super_amount, net_pay, gst_on, gst, total_inc, super_basis, invoice_number)
VALUES ('00000000-0000-0000-0000-000000000001', 'f1170000-0000-4000-8000-00000000000c', 'pending_acknowledgment',
        1120.00, 1120.00, 0.12, 120.00, 1000.00, false, 0, 1120.00, 'inclusive_12_112_v1', 'ZZTEST-RB-1');
SELECT set_config('zztest.refusal', :'refusal', true);
DO $$
DECLARE
  v_sql text := current_setting('zztest.refusal');
  refused boolean := false;
BEGIN
  IF position('RAISE EXCEPTION' IN v_sql) = 0 THEN
    RAISE EXCEPTION 'could not read the rollback refusal block (run the suite from the repository root)';
  END IF;
  BEGIN
    EXECUTE v_sql;
  EXCEPTION WHEN raise_exception THEN
    refused := SQLERRM LIKE 'trade_pay_inclusive_super rollback:%';
  END;
  IF NOT refused THEN RAISE EXCEPTION 'the rollback did not refuse while a new-basis invoice exists'; END IF;
END $$;
ROLLBACK;
