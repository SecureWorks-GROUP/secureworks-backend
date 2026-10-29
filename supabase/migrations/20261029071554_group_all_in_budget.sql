-- Preserve existing approvals; new groups explicitly opt into an immutable basis.
ALTER TABLE public.group_work_orders
  ADD COLUMN IF NOT EXISTS pay_basis text NOT NULL DEFAULT 'gross_v1'
    CHECK (pay_basis IN ('gross_v1','all_in_12_6_v1')),
  ADD COLUMN IF NOT EXISTS approved_budget_ex numeric(12,2),
  ADD COLUMN IF NOT EXISTS budget_approved_by uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS budget_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS budget_approval_reason text;
ALTER TABLE public.group_work_orders ADD CONSTRAINT group_budget_approval_complete CHECK (
  approved_budget_ex IS NULL OR (approved_budget_ex > 0 AND budget_approved_by IS NOT NULL
    AND budget_approved_at IS NOT NULL AND coalesce(length(btrim(budget_approval_reason)),0) >= 3)
);

CREATE OR REPLACE FUNCTION public.group_work_order_budget_lock()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF OLD.split_frozen_at IS NOT NULL AND (
    NEW.pay_basis IS DISTINCT FROM OLD.pay_basis OR NEW.approved_budget_ex IS DISTINCT FROM OLD.approved_budget_ex
    OR NEW.budget_approved_by IS DISTINCT FROM OLD.budget_approved_by
    OR NEW.budget_approved_at IS DISTINCT FROM OLD.budget_approved_at
    OR NEW.budget_approval_reason IS DISTINCT FROM OLD.budget_approval_reason
  ) THEN RAISE EXCEPTION 'group_split_frozen' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER group_work_order_budget_lock BEFORE UPDATE OF pay_basis,approved_budget_ex,budget_approved_by,budget_approved_at,budget_approval_reason
ON public.group_work_orders FOR EACH ROW EXECUTE FUNCTION public.group_work_order_budget_lock();

ALTER TABLE public.group_work_order_events DROP CONSTRAINT group_work_order_events_action_check;
ALTER TABLE public.group_work_order_events ADD CONSTRAINT group_work_order_events_action_check
  CHECK (action IN ('freeze','unfreeze','revoke_signoff','void_group','rekey','remove_participant','approve_budget'));

-- One trusted cents calculation for display, invoice pricing and the line trigger.
CREATE OR REPLACE FUNCTION public.group_work_order_share_pay(p_group_id uuid,p_budget_ex numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_basis text; v_budget bigint; v_gross bigint; v_super bigint; v_withhold bigint; v_cost bigint;
BEGIN
  SELECT pay_basis INTO STRICT v_basis FROM public.group_work_orders WHERE id=p_group_id;
  IF p_budget_ex IS NULL OR p_budget_ex < 0 THEN RAISE EXCEPTION 'group_share_amount_invalid'; END IF;
  v_budget := round(p_budget_ex*100)::bigint;
  IF v_basis='gross_v1' THEN v_gross:=v_budget;
  ELSIF v_basis='all_in_12_6_v1' THEN
    v_gross:=floor(v_budget::numeric/1.06)::bigint;
    -- Rounding of total super minus worker withholding is not always round(6%).
    WHILE v_gross + round(v_gross*.12)::bigint - round(v_gross*.06)::bigint > v_budget LOOP v_gross:=v_gross-1; END LOOP;
    WHILE v_gross+1 + round((v_gross+1)*.12)::bigint - round((v_gross+1)*.06)::bigint <= v_budget LOOP v_gross:=v_gross+1; END LOOP;
  ELSE RAISE EXCEPTION 'group_pay_basis_unsupported'; END IF;
  v_super:=round(v_gross*.12)::bigint; v_withhold:=round(v_gross*.06)::bigint;
  v_cost:=v_gross+v_super-v_withhold;
  RETURN jsonb_build_object('pay_basis',v_basis,'budget_ex',v_budget/100.0,'invoice_ex',v_gross/100.0,
    'cash_pay',(v_gross-v_withhold)/100.0,'super_amount',v_super/100.0,
    'company_contribution',(v_super-v_withhold)/100.0,'company_total_out',v_cost/100.0,
    'budget_remainder',CASE WHEN v_basis='all_in_12_6_v1' THEN (v_budget-v_cost)/100.0 ELSE NULL END);
END; $$;
REVOKE ALL ON FUNCTION public.group_work_order_share_pay(uuid,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.group_work_order_share_pay(uuid,numeric) TO service_role;

DO $patch$
DECLARE
  v_split text:=pg_get_functiondef('public.group_work_order_write_split(uuid,boolean)'::regprocedure);
  v_line text:=pg_get_functiondef('public.trade_invoice_lines_group_share_snapshot()'::regprocedure);
  v_old text:='SELECT wo.agreed_labour_ex INTO v_pot';
  v_new text:='SELECT COALESCE((SELECT g.approved_budget_ex FROM public.group_work_orders g WHERE g.id=p_group_id),wo.agreed_labour_ex) INTO v_pot';
  v_compare text:='IF NEW.line_total_ex IS DISTINCT FROM v_share_ex THEN';
  v_converted text:='IF NEW.line_total_ex IS DISTINCT FROM (public.group_work_order_share_pay(v_group,v_share_ex)->>''invoice_ex'')::numeric THEN';
BEGIN
  IF (length(v_split)-length(replace(v_split,v_old,'')))/length(v_old)<>1 THEN RAISE EXCEPTION 'group_budget_split_source_changed'; END IF;
  IF (length(v_line)-length(replace(v_line,v_compare,'')))/length(v_compare)<>1 THEN RAISE EXCEPTION 'group_budget_line_source_changed'; END IF;
  EXECUTE replace(v_split,v_old,v_new);
  EXECUTE replace(v_line,v_compare,v_converted);
END; $patch$;
