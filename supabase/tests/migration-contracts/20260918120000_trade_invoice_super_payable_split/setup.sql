-- Pre-migration surface: the 12% full-carve-out check from
-- 20260827112928 is already live. Keep one historical row so the new
-- CHECK cannot reject existing invoices on a status update.

INSERT INTO public.trade_invoices (
  id, subtotal_ex, gst, total_inc, status,
  gst_on, super_rate, super_amount, gross_earned, net_pay
) VALUES (
  '18000000-0000-4000-8000-000000000001',
  1000, 0, 1000, 'pushed_to_xero',
  false, 0.12, 120, 1000, 880
)
ON CONFLICT (id) DO NOTHING;
