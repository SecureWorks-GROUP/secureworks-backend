-- Rollback of 20261117020000_trade_super_inclusive.
--
-- Refuses while any invoice is priced super inclusive: the old checks would
-- reject it. Re-price or remove those invoices by hand first. Otherwise
-- restores the 20261112090000 split check and basis check, takes the two
-- columns back out of the persist inserts, removes the unfreeze refusal, and
-- drops the start date table and the switch. Roll back the matching ops-api
-- first: it reads the switch and the start date.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.trade_invoices WHERE super_basis = 'super_inclusive_v1') THEN
    RAISE EXCEPTION 'trade_super_inclusive rollback: invoices are priced super inclusive; re-price them by hand first';
  END IF;
END $$;

DO $unfreeze$
DECLARE
  v_def text := pg_get_functiondef('public.unfreeze_group_work_order_split(uuid,uuid)'::regprocedure);
  v_guard text := E'  IF EXISTS (\n'
    || E'    SELECT 1\n'
    || E'    FROM public.group_work_order_shares s\n'
    || E'    JOIN public.trade_invoice_lines l ON l.group_share_id = s.id\n'
    || E'    JOIN public.trade_invoices i ON i.id = l.trade_invoice_id\n'
    || E'    WHERE s.group_id = p_group_id\n'
    || E'      AND i.super_basis = ''super_inclusive_v1''\n'
    || E'  ) THEN\n'
    || E'    RAISE EXCEPTION ''group_split_super_inclusive_invoice'' USING ERRCODE = ''23514'';\n'
    || E'  END IF;\n\n';
BEGIN
  IF position('group_split_super_inclusive_invoice' IN v_def) = 0 THEN
    RETURN;
  END IF;
  IF (length(v_def) - length(replace(v_def, v_guard, ''))) / length(v_guard) <> 1 THEN
    RAISE EXCEPTION 'trade_super_inclusive rollback: unfreeze_group_work_order_split body changed; restore it by hand';
  END IF;
  EXECUTE replace(v_def, v_guard, '');
END;
$unfreeze$;

DO $persist$
DECLARE
  v_target record;
  v_def text;
  v_new text;
BEGIN
  FOR v_target IN
    SELECT * FROM (VALUES
      ('public.persist_weekly_trade_invoice_v1(jsonb, jsonb, uuid)',
       E'    gst_on, super_rate, super_amount, gross_earned, net_pay,\n    invoice_source,',
       E'    gst_on, super_rate, super_amount, gross_earned, net_pay,\n    super_basis, super_base_ex,\n    invoice_source,',
       E'    (p_invoice->>''net_pay'')::numeric,\n    v_invoice_source,',
       E'    (p_invoice->>''net_pay'')::numeric,\n    NULLIF(p_invoice->>''super_basis'', ''''),\n    NULLIF(p_invoice->>''super_base_ex'', '''')::numeric,\n    v_invoice_source,'),
      ('public.persist_trade_work_order_invoice_v1(jsonb, jsonb, uuid)',
       E'    gross_earned, net_pay, has_manual_overrides, override_details,',
       E'    gross_earned, net_pay, super_basis, super_base_ex, has_manual_overrides, override_details,',
       E'    (p_invoice->>''net_pay'')::numeric,\n    COALESCE((p_invoice->>''has_manual_overrides'')::boolean, false),',
       E'    (p_invoice->>''net_pay'')::numeric,\n    NULLIF(p_invoice->>''super_basis'', ''''),\n    NULLIF(p_invoice->>''super_base_ex'', '''')::numeric,\n    COALESCE((p_invoice->>''has_manual_overrides'')::boolean, false),')
    ) AS t(signature, cols_old, cols_new, vals_old, vals_new)
  LOOP
    v_def := pg_get_functiondef(to_regprocedure(v_target.signature));
    IF position('p_invoice->>''super_basis''' IN v_def) = 0 THEN
      CONTINUE;
    END IF;
    IF (length(v_def) - length(replace(v_def, v_target.cols_new, ''))) / length(v_target.cols_new) <> 1
       OR (length(v_def) - length(replace(v_def, v_target.vals_new, ''))) / length(v_target.vals_new) <> 1 THEN
      RAISE EXCEPTION 'trade_super_inclusive rollback: % insert changed; restore it by hand', v_target.signature;
    END IF;
    v_new := replace(v_def, v_target.cols_new, v_target.cols_old);
    v_new := replace(v_new, v_target.vals_new, v_target.vals_old);
    EXECUTE v_new;
  END LOOP;
END;
$persist$;

ALTER TABLE public.trade_invoices DROP CONSTRAINT IF EXISTS trade_invoices_super_gst_split_check;
ALTER TABLE public.trade_invoices ADD CONSTRAINT trade_invoices_super_gst_split_check CHECK (
  ((gst_on IS NULL) AND (super_rate IS NULL) AND (super_amount IS NULL) AND (gross_earned IS NULL) AND (net_pay IS NULL) AND (super_basis IS NULL) AND (super_base_ex IS NULL))
  OR ((gst_on IS NOT NULL) AND (super_rate = 0.12) AND (super_amount >= 0) AND (gross_earned >= 0) AND (net_pay >= 0)
    AND (gross_earned = round(subtotal_ex, 2))
    AND (super_base_ex IS NULL OR (super_base_ex >= 0 AND super_base_ex < gross_earned))
    AND (super_amount = round(COALESCE(super_base_ex, gross_earned) * super_rate, 2))
    AND (
      (super_basis IS NULL AND (
        (net_pay = round(gross_earned - round(COALESCE(super_base_ex, gross_earned) * 0.06, 2), 2))
        OR (super_base_ex IS NULL AND net_pay = round(gross_earned - super_amount, 2))
      ))
      OR (super_basis = 'employer_12_v2' AND net_pay = gross_earned)
    )
    AND (gst = CASE WHEN gst_on THEN round(gross_earned * 0.10, 2) ELSE 0 END)
    AND (total_inc = round(gross_earned + gst, 2)))
);

ALTER TABLE public.trade_invoices DROP CONSTRAINT IF EXISTS trade_invoices_super_basis_check;
ALTER TABLE public.trade_invoices ADD CONSTRAINT trade_invoices_super_basis_check
  CHECK (super_basis IS NULL OR super_basis = 'employer_12_v2');
COMMENT ON COLUMN public.trade_invoices.super_basis IS
  'Null: the ordinary split (6% withheld from the worker, 6% company). employer_12_v2: a group share where the company pays all 12% super inside the share; net_pay equals gross_earned.';

DROP TABLE IF EXISTS public.trade_super_inclusive_settings;
DELETE FROM public.feature_flags WHERE flag_name = 'trade_super_inclusive_v1';
