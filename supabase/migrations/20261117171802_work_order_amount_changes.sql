-- P1-14.1. Changes sit beside the sealed work order.
INSERT INTO public.feature_flags(flag_name,enabled,description)
VALUES ('work_order_amount_change_v1',false,'Any staff member may change a work order''s amount with a reason; every change is on the owner''s list.') ON CONFLICT(flag_name) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.work_order_amount_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL,
  work_order_id uuid NOT NULL REFERENCES public.work_orders(id),
  job_id uuid NOT NULL REFERENCES public.jobs(id),
  kind text NOT NULL CHECK(kind IN ('amount','people')),
  from_ex numeric(12,2), to_ex numeric(12,2), delta_ex numeric(12,2) NOT NULL DEFAULT 0,
  reason text NOT NULL CHECK(char_length(btrim(reason)) BETWEEN 3 AND 500),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  changed_by uuid NOT NULL REFERENCES public.users(id),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  profit_before_ex numeric(12,2), profit_after_ex numeric(12,2), profit_basis text,
  CHECK(kind <> 'amount' OR (from_ex IS NOT NULL AND to_ex IS NOT NULL AND to_ex >= 0 AND delta_ex = to_ex-from_ex)),
  CHECK(kind <> 'people' OR delta_ex=0)
);
CREATE INDEX IF NOT EXISTS work_order_amount_changes_wo_idx ON public.work_order_amount_changes(work_order_id);
CREATE INDEX IF NOT EXISTS work_order_amount_changes_at_idx ON public.work_order_amount_changes(org_id,changed_at DESC);
ALTER TABLE public.work_order_amount_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.work_order_amount_changes FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.work_order_amount_changes TO service_role;
DROP POLICY IF EXISTS work_order_amount_changes_service ON public.work_order_amount_changes;
CREATE POLICY work_order_amount_changes_service ON public.work_order_amount_changes FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE OR REPLACE FUNCTION public.work_order_amount_changes_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'work_order_amount_changes_append_only'; END $$;
DROP TRIGGER IF EXISTS work_order_amount_changes_immutable ON public.work_order_amount_changes;
CREATE TRIGGER work_order_amount_changes_immutable BEFORE UPDATE OR DELETE ON public.work_order_amount_changes
FOR EACH ROW EXECUTE FUNCTION public.work_order_amount_changes_immutable();
CREATE OR REPLACE FUNCTION public.work_order_amount_change_total(p_work_order_id uuid)
RETURNS numeric LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT coalesce(sum(delta_ex),0) FROM public.work_order_amount_changes WHERE work_order_id=p_work_order_id;
$$;
REVOKE ALL ON FUNCTION public.work_order_amount_change_total(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.work_order_amount_change_total(uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.change_work_order_amount(p_work_order_id uuid,p_to_ex numeric,p_reason text,p_actor uuid,p_org_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE wo public.work_orders%ROWTYPE; v_from numeric; v_billed numeric; v_variations numeric; v_row public.work_order_amount_changes%ROWTYPE;
BEGIN
  SELECT * INTO wo FROM public.work_orders WHERE id=p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'work_order_not_found'; END IF;
  IF wo.org_id IS DISTINCT FROM p_org_id THEN RAISE EXCEPTION 'work_order_wrong_company'; END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'work_order_change_reason_required'; END IF;
  IF p_to_ex IS NULL OR p_to_ex < 0 OR p_to_ex <> round(p_to_ex,2) OR p_to_ex::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'work_order_change_amount_invalid'; END IF;
  IF wo.status IS DISTINCT FROM 'approved' OR wo.agreed_labour_ex IS NULL THEN RAISE EXCEPTION 'work_order_not_approved'; END IF;
  IF EXISTS(SELECT 1 FROM public.group_work_orders WHERE work_order_id=wo.id AND split_frozen_at IS NOT NULL) THEN RAISE EXCEPTION 'work_order_split_locked'; END IF;
  v_from := wo.agreed_labour_ex + public.work_order_amount_change_total(wo.id);
  SELECT coalesce(sum(trade_allocation_ex),0) INTO v_variations FROM public.work_order_customer_variations WHERE work_order_id=wo.id AND status='approved';
  SELECT coalesce(sum(l.line_total_ex),0) INTO v_billed FROM public.trade_invoice_lines l
    JOIN public.trade_invoices i ON i.id=l.trade_invoice_id
    WHERE l.job_id=wo.job_id AND i.status=ANY(public.job_work_order_billed_invoice_statuses())
      AND lower(btrim(coalesce(l.line_type,''))) NOT IN ('commission','reimbursement');
  IF p_to_ex+v_variations < v_billed THEN RAISE EXCEPTION 'work_order_change_below_billed'; END IF;
  INSERT INTO public.work_order_amount_changes(org_id,work_order_id,job_id,kind,from_ex,to_ex,delta_ex,reason,changed_by)
    VALUES(p_org_id,wo.id,wo.job_id,'amount',v_from,p_to_ex,p_to_ex-v_from,btrim(p_reason),p_actor) RETURNING * INTO v_row;
  IF to_regprocedure('public.job_mark_changed(uuid,text)') IS NOT NULL THEN
    PERFORM public.job_mark_changed(wo.job_id,'work_order_amount');
  END IF;
  RETURN to_jsonb(v_row);
END $$;
REVOKE ALL ON FUNCTION public.change_work_order_amount(uuid,numeric,text,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.change_work_order_amount(uuid,numeric,text,uuid,uuid) TO service_role;
