-- Down for 20261111173000_trade_super_on_top.sql.
--
-- Refuses while any invoice was priced by an office super-on-top setting:
-- those invoices store net pay equal to gross with ordinary lines, which the
-- restored line guard would refuse on the next line write. Re-price or reject
-- them first; this never rewrites an invoice.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trade_invoices'
      AND column_name = 'super_basis_setting_id'
  ) THEN
    IF EXISTS (SELECT 1 FROM public.trade_invoices WHERE super_basis_setting_id IS NOT NULL) THEN
      RAISE EXCEPTION 'trade_super_on_top_in_use: invoices priced by an office super setting exist';
    END IF;
  END IF;
END $$;

-- 4. The weekly persist goes back to its fixed column list.
DO $$
DECLARE
  body text := pg_get_functiondef('public.persist_weekly_trade_invoice_v1(jsonb, jsonb, uuid)'::regprocedure);
  before_columns text := $old$    invoice_number, submitted_at, status
  ) VALUES ($old$;
  after_columns text := $new$    invoice_number, submitted_at, status,
    super_basis, super_basis_setting_id -- (20261111173000)
  ) VALUES ($new$;
  before_values text := $old$    NULLIF(p_invoice->>'submitted_at', '')::timestamptz,
    v_status
  )
  RETURNING id INTO v_invoice_id;$old$;
  after_values text := $new$    NULLIF(p_invoice->>'submitted_at', '')::timestamptz,
    v_status,
    NULLIF(p_invoice->>'super_basis', ''),
    NULLIF(p_invoice->>'super_basis_setting_id', '')::uuid
  )
  RETURNING id INTO v_invoice_id;$new$;
BEGIN
  IF strpos(body, '(20261111173000)') > 0 THEN
    IF strpos(body, after_columns) = 0 OR strpos(body, after_values) = 0 THEN
      RAISE EXCEPTION 'persist_weekly_trade_invoice_v1 changed; review before rolling back 20261111173000';
    END IF;
    EXECUTE replace(replace(body, after_columns, before_columns), after_values, before_values);
  END IF;
END $$;

-- 3. The line guard refuses every ordinary line on an employer-super invoice.
DO $$
DECLARE
  body text := pg_get_functiondef('public.trade_invoice_lines_group_share_snapshot()'::regprocedure);
  before_text text := $old$  -- An employer-super invoice carries its group share and nothing else.
  IF NEW.trade_invoice_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.trade_invoices i WHERE i.id = NEW.trade_invoice_id AND i.super_basis IS NOT NULL
  ) THEN$old$;
  after_text text := $new$  -- (20261111173000) An employer-super invoice carries its group share and
  -- nothing else, unless the office set this trade's own invoices to super
  -- on top (trade_super_bases).
  IF NEW.trade_invoice_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.trade_invoices i WHERE i.id = NEW.trade_invoice_id AND i.super_basis IS NOT NULL AND i.super_basis_setting_id IS NULL
  ) THEN$new$;
BEGIN
  IF strpos(body, '(20261111173000)') > 0 THEN
    IF strpos(body, after_text) = 0 THEN
      RAISE EXCEPTION 'trade_invoice_lines_group_share_snapshot changed; review before rolling back 20261111173000';
    END IF;
    EXECUTE replace(body, after_text, before_text);
  END IF;
END $$;

-- 2. and 1.
ALTER TABLE public.trade_invoices
  DROP CONSTRAINT IF EXISTS trade_invoices_super_basis_setting_fkey,
  DROP CONSTRAINT IF EXISTS trade_invoices_super_basis_setting_check,
  DROP COLUMN IF EXISTS super_basis_setting_id;

DROP TABLE IF EXISTS public.trade_super_bases;

NOTIFY pgrst, 'reload schema';
