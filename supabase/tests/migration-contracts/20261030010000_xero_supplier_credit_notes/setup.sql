-- Prerequisites for 20261030010000 (supplier credit notes, TP-07 slice 1).
-- Everything else it reads (organisations, xero_invoices, job_materials_facts,
-- v_job_cost_events, job_profit_num) comes from the registered stack.
-- feature_flags has no producer in this repository (live drift), so the case
-- stands up the shape the other cases use.
CREATE TABLE IF NOT EXISTS public.feature_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_name text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT false,
  description text,
  updated_at timestamptz DEFAULT now()
);
