-- After the down: the setting and its invoice column are gone, the line guard
-- and the weekly persist are back to their earlier text, and invoices remain.
DO $$
BEGIN
  ASSERT to_regclass('public.trade_super_bases') IS NULL, 'table dropped';
  ASSERT NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trade_invoices' AND column_name = 'super_basis_setting_id'),
    'invoice column dropped';
  ASSERT strpos(pg_get_functiondef('public.trade_invoice_lines_group_share_snapshot()'::regprocedure), '20261111203000') = 0
    AND strpos(pg_get_functiondef('public.trade_invoice_lines_group_share_snapshot()'::regprocedure),
      'An employer-super invoice carries its group share and nothing else.') > 0, 'line guard restored';
  ASSERT strpos(pg_get_functiondef('public.persist_weekly_trade_invoice_v1(jsonb, jsonb, uuid)'::regprocedure), 'super_basis') = 0,
    'weekly persist restored';
  ASSERT to_regclass('public.trade_invoices') IS NOT NULL, 'invoices remain';
END $$;
