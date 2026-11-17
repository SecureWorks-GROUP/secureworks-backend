-- P1-06.5: empty accounts and an atomic, approver-only settings audit.
ALTER TABLE public.trade_pay_settings
  ADD COLUMN IF NOT EXISTS repayment_account_code text,
  ADD COLUMN IF NOT EXISTS not_job_work_account_code text;

CREATE TABLE public.trade_pay_settings_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field text NOT NULL CHECK (field IN ('tax_set_aside_percent', 'reimbursement_account_code', 'repayment_account_code', 'not_job_work_account_code')),
  from_value text,
  to_value text,
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.trade_pay_settings_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trade_pay_settings_changes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.trade_pay_settings_changes TO service_role;
CREATE POLICY trade_pay_settings_changes_service_read ON public.trade_pay_settings_changes
  FOR SELECT TO service_role USING (true);
CREATE POLICY trade_pay_settings_changes_service_insert ON public.trade_pay_settings_changes
  FOR INSERT TO service_role WITH CHECK (true);

CREATE FUNCTION public.trade_pay_settings_changes_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  RAISE EXCEPTION 'pay_setting_changes_append_only' USING ERRCODE = '23514';
END;
$fn$;
REVOKE ALL ON FUNCTION public.trade_pay_settings_changes_append_only() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trade_pay_settings_changes_append_only
  BEFORE UPDATE OR DELETE ON public.trade_pay_settings_changes
  FOR EACH ROW EXECUTE FUNCTION public.trade_pay_settings_changes_append_only();

-- Keep all direct settings updates private, including the four fields below.
REVOKE UPDATE ON public.trade_pay_settings FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.set_trade_pay_setting(p_field text, p_value text, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_settings public.trade_pay_settings%ROWTYPE;
  v_from text;
  v_to text;
  v_percent numeric;
  v_changed_at timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO v_settings FROM public.trade_pay_settings WHERE id = 1 FOR UPDATE;
  IF NOT FOUND OR p_actor IS NULL OR NOT COALESCE(p_actor = ANY(v_settings.pay_run_approver_user_ids), false) THEN
    RAISE EXCEPTION 'pay_setting_not_approver' USING ERRCODE = '23514';
  END IF;
  IF p_field IS NULL OR p_field NOT IN ('tax_set_aside_percent', 'reimbursement_account_code', 'repayment_account_code', 'not_job_work_account_code') THEN
    RAISE EXCEPTION 'pay_setting_field_not_allowed' USING ERRCODE = '23514';
  END IF;
  IF p_field = 'tax_set_aside_percent' THEN
    IF p_value IS NOT NULL THEN
      IF p_value !~ '^([0-9]+([.][0-9]{0,2})?|[.][0-9]{1,2})$' THEN
        RAISE EXCEPTION 'pay_setting_value_invalid' USING ERRCODE = '23514';
      END IF;
      v_percent := p_value::numeric;
      IF v_percent < 0 OR v_percent > 60 THEN
        RAISE EXCEPTION 'pay_setting_value_invalid' USING ERRCODE = '23514';
      END IF;
    END IF;
    v_from := v_settings.tax_set_aside_percent::text;
    v_to := v_percent::numeric(5,2)::text;
    UPDATE public.trade_pay_settings
      SET tax_set_aside_percent = v_percent, updated_at = v_changed_at, updated_by = p_actor::text
      WHERE id = 1;
  ELSE
    IF p_value IS NOT NULL AND length(p_value) NOT BETWEEN 1 AND 20 THEN
      RAISE EXCEPTION 'pay_setting_value_invalid' USING ERRCODE = '23514';
    END IF;
    v_from := to_jsonb(v_settings)->>p_field;
    v_to := p_value;
    EXECUTE format('UPDATE public.trade_pay_settings SET %I = $1, updated_at = $2, updated_by = $3 WHERE id = 1', p_field)
      USING p_value, v_changed_at, p_actor::text;
  END IF;
  INSERT INTO public.trade_pay_settings_changes(field, from_value, to_value, changed_by, changed_at)
    VALUES (p_field, v_from, v_to, p_actor, v_changed_at);
  RETURN jsonb_build_object('field', p_field, 'value', v_to, 'changed_at', v_changed_at);
END;
$fn$;
REVOKE ALL ON FUNCTION public.set_trade_pay_setting(text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_trade_pay_setting(text, text, uuid) TO service_role;
