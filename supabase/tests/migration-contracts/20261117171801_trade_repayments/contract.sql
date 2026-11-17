BEGIN;
DO $$ DECLARE u uuid:=gen_random_uuid(); r uuid:=gen_random_uuid(); n integer;
BEGIN
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name='trade_repayments_v1') IS DISTINCT FROM false THEN RAISE EXCEPTION 'repayment switch must stay off'; END IF;
  IF has_function_privilege('authenticated','public.trade_repayment_balance(uuid)','EXECUTE') THEN RAISE EXCEPTION 'repayment balance is private'; END IF;
  INSERT INTO public.users(id,org_id,name) VALUES(u,'00000000-0000-0000-0000-000000000001','ZZTEST trade');
  BEGIN
    INSERT INTO public.trade_recurring_deductions(user_id,label,amount,first_week_start,kind,xero_account_code)
    VALUES(u,'ZZTEST missing balance',100,'2099-01-05','repayment','ZZTEST-account');
    RAISE EXCEPTION 'missing balance accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.trade_recurring_deductions(user_id,label,amount,first_week_start,kind,balance_total)
    VALUES(u,'ZZTEST missing account',100,'2099-01-05','repayment',250);
    RAISE EXCEPTION 'missing account accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO public.trade_recurring_deductions(id,user_id,label,amount,first_week_start,kind,balance_total,xero_account_code)
  VALUES(r,u,'ZZTEST repayment',100,'2099-01-05','repayment',250,'ZZTEST-account');
  FOR n IN 0..3 LOOP
    INSERT INTO public.trade_invoices(org_id,user_id,week_start,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,recurring_deduction_id,recurring_deduction_label,recurring_deduction_amount)
    VALUES('00000000-0000-0000-0000-000000000001',u,'2099-01-05'::date+7*n,
      CASE n WHEN 2 THEN 'ops-reject' WHEN 3 THEN 'draft' ELSE 'approved' END,
      1000,1000,0,1000,false,.12,120,940,r,'ZZTEST repayment',100);
  END LOOP;
  IF public.trade_repayment_balance(r) IS DISTINCT FROM 50 THEN RAISE EXCEPTION 'repayment balance did not exclude draft and rejected'; END IF;
  INSERT INTO public.trade_recurring_deductions(user_id,label,amount,first_week_start)
  VALUES(u,'ZZTEST recurring',100,'2099-02-02') RETURNING id INTO r;
  IF public.trade_repayment_balance(r) IS NOT NULL OR (SELECT kind FROM public.trade_recurring_deductions WHERE id=r)<>'recurring' THEN RAISE EXCEPTION 'recurring rule changed'; END IF;
END $$;
ROLLBACK;
