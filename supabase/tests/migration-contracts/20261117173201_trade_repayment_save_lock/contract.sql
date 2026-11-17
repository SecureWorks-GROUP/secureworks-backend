BEGIN;
SELECT public.install_trade_repayment_save_lock();
\ir fixture.sql
DO $$ DECLARE n integer; taken numeric; BEGIN
  -- Each request carries the stale full instalment; only the balance may be saved.
  FOR n IN 0..3 LOOP
    INSERT INTO public.trade_invoices(org_id,user_id,week_start,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,recurring_deduction_id,recurring_deduction_label,recurring_deduction_amount)
VALUES('00000000-0000-0000-0000-000000000001','ee320000-0000-4000-8000-000000000001','2099-01-05'::date+7*n,'pending_acknowledgment',1000,1000,0,1000,false,.12,120,940,'ee320000-0000-4000-8000-000000000002','ZZTEST repayment',100);
  END LOOP;
  SELECT sum(recurring_deduction_amount) INTO taken FROM public.trade_invoices
  WHERE user_id='ee320000-0000-4000-8000-000000000001';
  IF taken IS DISTINCT FROM 250 THEN RAISE EXCEPTION 'ZZTEST repayment over-collected: %',taken; END IF;
  IF (SELECT recurring_deduction_amount FROM public.trade_invoices WHERE user_id='ee320000-0000-4000-8000-000000000001' AND week_start='2099-01-19') IS DISTINCT FROM 50 THEN
    RAISE EXCEPTION 'ZZTEST last instalment not clamped'; END IF;
  IF public.trade_repayment_balance('ee320000-0000-4000-8000-000000000002') IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'ZZTEST balance not settled'; END IF;
END $$;
-- Draft saves reserve nothing. Promotion to a submitted status rechecks the balance.
INSERT INTO public.trade_invoices(org_id,user_id,week_start,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,recurring_deduction_id,recurring_deduction_label,recurring_deduction_amount)
VALUES('00000000-0000-0000-0000-000000000001','ee320000-0000-4000-8000-000000000001','2099-02-02','draft',1000,1000,0,1000,false,.12,120,940,'ee320000-0000-4000-8000-000000000002','ZZTEST repayment',100);
UPDATE public.trade_invoices SET status='pending_acknowledgment'
WHERE user_id='ee320000-0000-4000-8000-000000000001' AND week_start='2099-02-02';
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.trade_invoices WHERE user_id='ee320000-0000-4000-8000-000000000001' AND week_start='2099-02-02' AND recurring_deduction_amount IS NOT NULL) THEN
    RAISE EXCEPTION 'ZZTEST submitted draft reused exhausted balance'; END IF;
END $$;
UPDATE public.feature_flags SET enabled=false WHERE flag_name='trade_repayments_v1';
INSERT INTO public.trade_invoices(org_id,user_id,week_start,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,recurring_deduction_id,recurring_deduction_label,recurring_deduction_amount)
VALUES('00000000-0000-0000-0000-000000000001','ee320000-0000-4000-8000-000000000001','2099-02-09','pending_acknowledgment',1000,1000,0,1000,false,.12,120,940,'ee320000-0000-4000-8000-000000000002','ZZTEST repayment',100);
DO $$ BEGIN
  IF (SELECT recurring_deduction_amount FROM public.trade_invoices WHERE user_id='ee320000-0000-4000-8000-000000000001' AND week_start='2099-02-09') IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION 'ZZTEST switch off changed save'; END IF;
END $$;
ROLLBACK;
