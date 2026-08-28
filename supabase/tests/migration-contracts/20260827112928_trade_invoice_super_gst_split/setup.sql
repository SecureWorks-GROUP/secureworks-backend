-- Minimal pre-migration trade invoice surface.

CREATE TABLE IF NOT EXISTS public.trade_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subtotal_ex numeric(10,2) NOT NULL DEFAULT 0,
  gst numeric(10,2) NOT NULL DEFAULT 0,
  total_inc numeric(10,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.trade_invoices (
  id, subtotal_ex, gst, total_inc, status, created_at
) VALUES (
  '10000000-0000-4000-8000-000000000001',
  500,
  50,
  550,
  'pushed_to_xero',
  '2026-08-01T00:00:00Z'
)
ON CONFLICT (id) DO NOTHING;
