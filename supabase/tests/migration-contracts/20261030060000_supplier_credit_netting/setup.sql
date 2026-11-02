-- Prerequisites for 20261030060000 (supplier credit netting, TP-07 slice 2).
-- The registered stack brings the credit note copy and its placement view
-- (20261030010000), the job profit engine (v_job_cost_events, 20261028173000),
-- the TP-01 tie-out (20261029121500) and the helpers they read. Fail closed,
-- by name, if any of them is gone. xero_sync_state (20260910100000, never a
-- registered case) is stood up here with its production columns.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.xero_supplier_credit_notes', 'public.xero_supplier_credit_note_allocations',
                           'public.v_supplier_credit_placement', 'public.v_job_cost_events', 'public.v_job_profit',
                           'public.xero_invoices', 'public.job_materials_facts', 'public.jobs'] LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE EXCEPTION 'supplier credit netting setup: % missing from the registered stack', t;
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['public.xero_tieout_monthly(date,integer,uuid)', 'public.job_cost_credit_share(jsonb,numeric)',
                           'public.materials_ai_trade_mirror(text,jsonb)', 'public.job_profit_num(jsonb)'] LOOP
    IF to_regprocedure(t) IS NULL THEN
      RAISE EXCEPTION 'supplier credit netting setup: % missing from the registered stack', t;
    END IF;
  END LOOP;
  IF to_regclass('public.v_supplier_credit_allocations') IS NOT NULL THEN
    RAISE EXCEPTION 'supplier credit netting setup: the netting exists before the migration';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.xero_sync_state (
  key text PRIMARY KEY,
  cursor_at timestamptz,
  note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.xero_sync_state ENABLE ROW LEVEL SECURITY;
