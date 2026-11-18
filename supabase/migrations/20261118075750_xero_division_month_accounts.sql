SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.xero_division_month_accounts (
  org_id uuid NOT NULL,
  month date NOT NULL CHECK (month = date_trunc('month', month)::date),
  tracking_option text NOT NULL,
  section text NOT NULL CHECK (section IN ('income', 'cost_of_sales', 'expenses')),
  account_id text NOT NULL,
  account_name text NOT NULL,
  amount numeric(14,2) NOT NULL,
  report_synced_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, month, tracking_option, account_id)
);

ALTER TABLE public.xero_division_month_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.xero_division_month_accounts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.xero_division_month_accounts TO service_role;

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('division_tieout_v1', false, 'Compare monthly division accounts with Xero.')
ON CONFLICT (flag_name) DO NOTHING;
