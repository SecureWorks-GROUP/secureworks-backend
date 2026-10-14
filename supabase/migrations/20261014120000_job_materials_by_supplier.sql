-- Dispatch slice 4: Materials by supplier.
--
-- Contract: docs/dispatch-slice-4-contract.md. Reader: ops-api
-- `dispatch_materials` (one job) and `pipeline` with dispatch=1 (only
-- job_id, status, purchase_order_id of job_material_lines). Writers: the six
-- ops-api `dispatch_materials_*` actions (rules in
-- supabase/functions/ops-api/dispatch_materials.ts), and nothing else.
--
-- Three Dispatch-only tables: the suppliers chosen for a job, one row per
-- material line, and one working-out pad and sketch per job. They are their own
-- tables, not columns on jobs and not keys in jobs.metadata or jobs.scope_json:
-- any update to jobs moves jobs.updated_at, which orders the Dispatch list, and
-- scope_json already carries base64 pictures.
--
-- No trigger, no business_events row, no job_events row: who changed a row and
-- when is kept on the row.
--
-- Row security on with no policy, revoked from the browser roles, as
-- quote_builder_versions and job_contacts are: only ops-api reaches them. The
-- sketch is a staff-only working note and must never reach a trade or a client.
--
-- Rollback: supabase/rollbacks/20261014120000_job_materials_by_supplier_down.sql.

CREATE TABLE IF NOT EXISTS public.job_material_suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id),
  supplier_name text NOT NULL,
  position integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL,
  created_by_email text NULL,
  CONSTRAINT job_material_suppliers_job_supplier_key UNIQUE (job_id, supplier_id)
);

CREATE TABLE IF NOT EXISTS public.job_material_lines (
  -- Made in the browser when the line is added, so a retried save cannot make two.
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL,
  description text NOT NULL,
  quantity numeric(12,3) NULL,
  unit text NULL,
  status text NOT NULL DEFAULT 'not_reviewed',
  purchase_order_id uuid NULL REFERENCES public.purchase_orders(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'manual',
  position integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL,
  updated_by uuid NULL,
  created_by_email text NULL,
  updated_by_email text NULL,
  -- A line sits under a supplier chosen for this job; a supplier cannot be
  -- taken off a job while a line still points at it.
  CONSTRAINT job_material_lines_supplier_on_job_fkey FOREIGN KEY (job_id, supplier_id)
    REFERENCES public.job_material_suppliers (job_id, supplier_id),
  -- Only the three hand-set values are ever stored. On PO and Delivered are
  -- worked out on read (dispatch_materials.ts), never stored.
  CONSTRAINT job_material_lines_status_valid CHECK (status IN ('not_reviewed', 'to_order', 'in_stock')),
  CONSTRAINT job_material_lines_source_valid CHECK (source IN ('manual', 'scope')),
  -- ops-api trims the text; these keep the stored shape honest.
  CONSTRAINT job_material_lines_description_length CHECK (char_length(description) BETWEEN 1 AND 300),
  CONSTRAINT job_material_lines_quantity_not_negative CHECK (quantity IS NULL OR quantity >= 0),
  CONSTRAINT job_material_lines_unit_length CHECK (unit IS NULL OR char_length(unit) BETWEEN 1 AND 30)
);

CREATE INDEX IF NOT EXISTS job_material_lines_job_id_idx ON public.job_material_lines (job_id);

CREATE TABLE IF NOT EXISTS public.job_dispatch_workings (
  job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  working_out text NULL,
  working_out_updated_at timestamptz NULL,
  working_out_updated_by_email text NULL,
  -- The canvas's own PNG as a data URL. Never selected in a list read.
  sketch_png text NULL,
  sketch_updated_at timestamptz NULL,
  sketch_updated_by_email text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_dispatch_workings_working_out_length CHECK (working_out IS NULL OR char_length(working_out) <= 20000),
  CONSTRAINT job_dispatch_workings_sketch_png_shape CHECK (
    sketch_png IS NULL OR (char_length(sketch_png) <= 400000 AND sketch_png LIKE 'data:image/png;base64,%')
  )
);

COMMENT ON TABLE public.job_material_suppliers IS
  'Dispatch tab (docs/dispatch-slice-4-contract.md): the supplier contacts chosen for a job. Written only by ops-api dispatch_materials_add_supplier / dispatch_materials_remove_supplier.';
COMMENT ON TABLE public.job_material_lines IS
  'Dispatch tab (docs/dispatch-slice-4-contract.md): one row per material line, each under a supplier chosen for the job. Written only by ops-api dispatch_materials_save_line / _delete_line / _suggest. purchase_order_id is set by no slice 4 path.';
COMMENT ON TABLE public.job_dispatch_workings IS
  'Dispatch tab (docs/dispatch-slice-4-contract.md): the job''s working-out text and sketch. Staff only, through ops-api dispatch_materials; never read by a trade, client, pack, email or agent surface.';

ALTER TABLE public.job_material_suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_material_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_dispatch_workings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.job_material_suppliers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.job_material_lines FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.job_dispatch_workings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.job_material_suppliers TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.job_material_lines TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.job_dispatch_workings TO service_role;
