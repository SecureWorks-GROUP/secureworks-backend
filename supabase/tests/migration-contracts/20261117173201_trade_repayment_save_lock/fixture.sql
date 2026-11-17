INSERT INTO public.users(id,org_id,name,role)
VALUES('ee320000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','ZZTEST crew','crew');
INSERT INTO public.trade_recurring_deductions(id,user_id,label,amount,first_week_start,kind,balance_total,xero_account_code)
VALUES('ee320000-0000-4000-8000-000000000002','ee320000-0000-4000-8000-000000000001','ZZTEST repayment',100,'2099-01-05','repayment',250,'ZZTEST-account');
UPDATE public.feature_flags SET enabled=true WHERE flag_name='trade_repayments_v1';
