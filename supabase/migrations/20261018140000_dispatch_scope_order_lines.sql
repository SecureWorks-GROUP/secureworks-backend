-- Dispatch scope order lines, stage 1.
--
-- Contract: docs/dispatch-scope-order-lines-v1.md. Reader: ops-api
-- `dispatch_scope_order_lines`. Writer: ops-api `dispatch_scope_order_import`,
-- and nothing else.
--
-- One row per stated Scope Engine demand on a job. It is not a material line
-- and not a purchase order: no supplier contact, no price, no send. A blank
-- product is stored and flagged. Re-importing the same demand updates this
-- row; it does not insert another.
--
-- No trigger, no business_events row, no job_events row.
--
-- Row security on with no policy, revoked from the browser roles, as
-- job_material_lines is: only ops-api reaches it.
--
-- Rollback: supabase/rollbacks/20261018140000_dispatch_scope_order_lines_down.sql.

CREATE TABLE IF NOT EXISTS public.dispatch_scope_order_lines (
  -- Hashed from the job and the demand id, so a retried import is the same row.
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  demand_id text NOT NULL,
  product text NULL,
  product_unknown boolean NOT NULL,
  description text NOT NULL,
  quantity numeric(12,3) NULL,
  unit text NULL,
  length_mm integer NULL,
  cut_size text NULL,
  cuts jsonb NOT NULL DEFAULT '[]'::jsonb,
  supplier_name text NULL,
  position integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL,
  updated_by uuid NULL,
  created_by_email text NULL,
  updated_by_email text NULL,
  CONSTRAINT dispatch_scope_order_lines_job_demand_key UNIQUE (job_id, demand_id),
  CONSTRAINT dispatch_scope_order_lines_demand_id_shape CHECK (
    char_length(demand_id) BETWEEN 1 AND 200
    AND demand_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:|/+-]*$'
  ),
  CONSTRAINT dispatch_scope_order_lines_description_length CHECK (char_length(description) BETWEEN 1 AND 300),
  CONSTRAINT dispatch_scope_order_lines_product_length CHECK (
    product IS NULL OR char_length(product) BETWEEN 1 AND 200
  ),
  CONSTRAINT dispatch_scope_order_lines_blank_product_flagged CHECK (
    product IS NOT NULL OR product_unknown
  ),
  CONSTRAINT dispatch_scope_order_lines_quantity_not_negative CHECK (quantity IS NULL OR quantity >= 0),
  CONSTRAINT dispatch_scope_order_lines_unit_length CHECK (
    unit IS NULL OR char_length(unit) BETWEEN 1 AND 30
  ),
  CONSTRAINT dispatch_scope_order_lines_length_mm_range CHECK (
    length_mm IS NULL OR (length_mm >= 0 AND length_mm <= 100000)
  ),
  CONSTRAINT dispatch_scope_order_lines_cut_size_length CHECK (
    cut_size IS NULL OR char_length(cut_size) BETWEEN 1 AND 300
  ),
  CONSTRAINT dispatch_scope_order_lines_supplier_name_length CHECK (
    supplier_name IS NULL OR char_length(supplier_name) BETWEEN 1 AND 200
  ),
  CONSTRAINT dispatch_scope_order_lines_cuts_array CHECK (jsonb_typeof(cuts) = 'array'),
  CONSTRAINT dispatch_scope_order_lines_cuts_count CHECK (jsonb_array_length(cuts) <= 40),
  CONSTRAINT dispatch_scope_order_lines_position_range CHECK (position >= 0 AND position < 500)
);

CREATE INDEX IF NOT EXISTS dispatch_scope_order_lines_job_id_idx
  ON public.dispatch_scope_order_lines (job_id);

COMMENT ON TABLE public.dispatch_scope_order_lines IS
  'Dispatch (docs/dispatch-scope-order-lines-v1.md): one stated Scope Engine demand on a job. Written only by ops-api dispatch_scope_order_import. No supplier contact, price or send.';

ALTER TABLE public.dispatch_scope_order_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dispatch_scope_order_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dispatch_scope_order_lines TO service_role;
