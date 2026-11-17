\ir ../20261117194401_trade_reimbursement_receipt_replacement/setup.sql
SELECT strpos(pg_get_functiondef('public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure), '-- FU12: release only') = 0 AS needs_fu12 \gset
\if :needs_fu12
\ir ../../../migrations/20261117194401_trade_reimbursement_receipt_replacement.sql
\endif
-- Match current main's v1 body in the standalone fixture too. The full
-- registered stack already has both changes, so its body is left alone.
ALTER TABLE public.trade_invoices ADD COLUMN IF NOT EXISTS super_basis text,
  ADD COLUMN IF NOT EXISTS super_base_ex numeric;
DO $fixture$ DECLARE d text; BEGIN
 d := pg_get_functiondef('public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure);
 IF strpos(d, 'public.carry_work_order_variations(') = 0 THEN
  -- Same carry insertion as 20261012130000, applied only to this one fixture.
  d := regexp_replace(d, '([ \t]*)(DELETE FROM public\.trade_invoices\s+WHERE id = v_prior_draft_id;)',
    E'\\1PERFORM public.carry_work_order_variations(v_prior_draft_id, v_invoice_id);\n\\1\\2');
  IF to_regprocedure('public.carry_work_order_variations(uuid,uuid)') IS NULL THEN
   EXECUTE 'CREATE FUNCTION public.carry_work_order_variations(uuid,uuid) RETURNS void LANGUAGE sql AS ''SELECT''';
  END IF;
 END IF;
 IF strpos(d, 'p_invoice->>''super_basis''') = 0 THEN
  -- Same two insert fragments as 20261117020000, without its other functions.
  d := replace(d, E'    gst_on, super_rate, super_amount, gross_earned, net_pay,\n    invoice_source,',
    E'    gst_on, super_rate, super_amount, gross_earned, net_pay,\n    super_basis, super_base_ex,\n    invoice_source,');
  d := replace(d, E'    (p_invoice->>''net_pay'')::numeric,\n    v_invoice_source,',
    E'    (p_invoice->>''net_pay'')::numeric,\n    NULLIF(p_invoice->>''super_basis'', ''''),\n    NULLIF(p_invoice->>''super_base_ex'', '''')::numeric,\n    v_invoice_source,');
 END IF;
 EXECUTE d;
END $fixture$;
