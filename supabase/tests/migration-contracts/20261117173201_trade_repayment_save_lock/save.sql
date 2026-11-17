BEGIN;
INSERT INTO public.trade_invoices(org_id,user_id,week_start,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,recurring_deduction_id,recurring_deduction_label,recurring_deduction_amount)
VALUES('00000000-0000-0000-0000-000000000001','ee320000-0000-4000-8000-000000000001',:'week','pending_acknowledgment',1000,1000,0,1000,false,.12,120,940,'ee320000-0000-4000-8000-000000000002','ZZTEST repayment',100);
SELECT 'ZZTEST saved';
SELECT pg_sleep(:hold);
COMMIT;
