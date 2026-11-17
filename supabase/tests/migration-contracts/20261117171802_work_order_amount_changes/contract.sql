BEGIN;
\ir fixture.sql
DO $$ DECLARE wo uuid:='ee180000-0000-4000-8000-000000000201'; actor uuid:='ee180000-0000-4000-8000-000000000001'; org uuid:='00000000-0000-0000-0000-000000000001'; r jsonb; seal text; inv uuid;
BEGIN
  SELECT sealed_content_hash INTO seal FROM public.work_orders WHERE id=wo;
  r:=public.change_work_order_amount(wo,1344,'ZZTEST extra scope',actor,org);
  IF (r->>'from_ex')::numeric<>1120 OR (r->>'delta_ex')::numeric<>224 OR public.work_order_amount_change_total(wo)<>224 THEN RAISE EXCEPTION 'first change arithmetic'; END IF;
  r:=public.change_work_order_amount(wo,1232,'ZZTEST revised scope',actor,org);
  IF (r->>'from_ex')::numeric<>1344 OR (r->>'delta_ex')::numeric<>-112 OR public.work_order_amount_change_total(wo)<>112 THEN RAISE EXCEPTION 'second change arithmetic'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.work_orders WHERE id=wo AND agreed_labour_ex=1120 AND sealed_content_hash=seal) THEN RAISE EXCEPTION 'sealed work order changed'; END IF;
  BEGIN PERFORM public.change_work_order_amount(wo,1232,'',actor,org); RAISE EXCEPTION 'empty reason accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'work_order_change_reason_required' THEN RAISE; END IF; END;
  BEGIN UPDATE public.work_order_amount_changes SET reason='ZZTEST overwrite' WHERE work_order_id=wo; RAISE EXCEPTION 'update accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'work_order_amount_changes_append_only' THEN RAISE; END IF; END;
  BEGIN DELETE FROM public.work_order_amount_changes WHERE work_order_id=wo; RAISE EXCEPTION 'delete accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'work_order_amount_changes_append_only' THEN RAISE; END IF; END;
  BEGIN
    INSERT INTO public.group_work_orders(org_id,job_id,work_order_id,share_token,split_frozen_at)
    VALUES(org,'ee180000-0000-4000-8000-000000000101',wo,'ZZTEST-frozen-token',now());
    PERFORM public.change_work_order_amount(wo,1344,'ZZTEST frozen',actor,org); RAISE EXCEPTION 'frozen split accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'work_order_split_locked' THEN RAISE; END IF; END;
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay)
    VALUES(org,'ee180000-0000-4000-8000-000000000002','pending_acknowledgment',1000,1000,0,1000,false,.12,120,940) RETURNING id INTO inv;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex)
    VALUES(inv,'ee180000-0000-4000-8000-000000000101','labour',1000);
  BEGIN PERFORM public.change_work_order_amount(wo,999,'ZZTEST below billed',actor,org); RAISE EXCEPTION 'below billed accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'work_order_change_below_billed' THEN RAISE; END IF; END;
END $$;
ROLLBACK;
