-- Dispatch scope order lines, stage 1.
--
-- Contract: docs/dispatch-scope-order-lines-v1.md. Reader: ops-api
-- `dispatch_scope_order_lines`. Writer: ops-api `dispatch_scope_order_import`,
-- and nothing else, through dispatch_replace_scope_order_lines.
--
-- One row per demand on one scope of a job. A second scope on the same job
-- is a second set of rows. It is not a material line and not a purchase
-- order: no supplier contact, no price, no send. A blank product is stored
-- and flagged. Re-importing the same scope replaces only that scope, in this
-- function. length_mm is the piece. stock_length_mm and stock_qty are the
-- bar to buy. cuts are the piece lengths.
--
-- Version 20261018140000 does not collide with 20261018120000.
--
-- No trigger, no business_events row, no job_events row.
--
-- Row security on with no policy, revoked from the browser roles, as
-- job_material_lines is: only ops-api reaches it.
--
-- Rollback: supabase/rollbacks/20261018140000_dispatch_scope_order_lines_down.sql.

CREATE TABLE IF NOT EXISTS public.dispatch_scope_order_lines (
  -- Hashed from the job, the scope and the demand id, so a retried import of
  -- the same scope is the same row. A fence post-1 and a patio post-1 differ.
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  scope_id text NOT NULL,
  order_version text NOT NULL,
  demand_id text NOT NULL,
  product text NULL,
  product_unknown boolean NOT NULL,
  description text NOT NULL,
  quantity numeric(12,3) NULL,
  unit text NULL,
  length_mm integer NULL,
  stock_length_mm integer NULL,
  stock_qty numeric(12,3) NULL,
  cut_size text NULL,
  cuts jsonb NOT NULL DEFAULT '[]'::jsonb,
  element_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  supplier_name text NULL,
  position integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL,
  updated_by uuid NULL,
  created_by_email text NULL,
  updated_by_email text NULL,
  CONSTRAINT dispatch_scope_order_lines_job_scope_demand_key UNIQUE (job_id, scope_id, demand_id),
  CONSTRAINT dispatch_scope_order_lines_scope_id_shape CHECK (
    char_length(scope_id) BETWEEN 1 AND 200
    AND scope_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:|/+-]*$'
  ),
  CONSTRAINT dispatch_scope_order_lines_order_version_length CHECK (
    char_length(order_version) BETWEEN 1 AND 200
  ),
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
  CONSTRAINT dispatch_scope_order_lines_stock_length_mm_range CHECK (
    stock_length_mm IS NULL OR (stock_length_mm >= 0 AND stock_length_mm <= 100000)
  ),
  CONSTRAINT dispatch_scope_order_lines_stock_qty_not_negative CHECK (
    stock_qty IS NULL OR stock_qty >= 0
  ),
  CONSTRAINT dispatch_scope_order_lines_cut_size_length CHECK (
    cut_size IS NULL OR char_length(cut_size) BETWEEN 1 AND 300
  ),
  CONSTRAINT dispatch_scope_order_lines_supplier_name_length CHECK (
    supplier_name IS NULL OR char_length(supplier_name) BETWEEN 1 AND 200
  ),
  CONSTRAINT dispatch_scope_order_lines_cuts_array CHECK (jsonb_typeof(cuts) = 'array'),
  CONSTRAINT dispatch_scope_order_lines_cuts_count CHECK (jsonb_array_length(cuts) <= 40),
  CONSTRAINT dispatch_scope_order_lines_element_refs_array CHECK (jsonb_typeof(element_refs) = 'array'),
  CONSTRAINT dispatch_scope_order_lines_element_refs_count CHECK (jsonb_array_length(element_refs) <= 80),
  CONSTRAINT dispatch_scope_order_lines_position_range CHECK (position >= 0 AND position < 500)
);

CREATE INDEX IF NOT EXISTS dispatch_scope_order_lines_job_id_idx
  ON public.dispatch_scope_order_lines (job_id, scope_id);

COMMENT ON TABLE public.dispatch_scope_order_lines IS
  'Dispatch (docs/dispatch-scope-order-lines-v1.md): one Scope Engine demand on one scope of a job. Written only by ops-api dispatch_scope_order_import through dispatch_replace_scope_order_lines. No supplier contact, price or send.';

ALTER TABLE public.dispatch_scope_order_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dispatch_scope_order_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dispatch_scope_order_lines TO service_role;

-- Replace one scope. Other scopes on the job stay. A demand that is still in
-- the scope keeps its created_at and created_by. p.lines is the whole new
-- set; an empty set is refused so a bad payload cannot wipe the scope.
CREATE OR REPLACE FUNCTION public.dispatch_replace_scope_order_lines(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job uuid := (p->>'job_id')::uuid;
  v_org uuid := (p->>'org_id')::uuid;
  v_scope text := btrim(p->>'scope_id');
  v_version text := btrim(p->>'order_version');
  v_user uuid;
  v_email text := nullif(p#>>'{actor,email}', '');
  v_now timestamptz := coalesce((p->>'now')::timestamptz, now());
  v_prior jsonb;
  v_removed integer;
BEGIN
  IF v_scope IS NULL OR v_scope = '' THEN
    RAISE EXCEPTION 'scope_id_required';
  END IF;
  IF v_version IS NULL OR v_version = '' THEN
    RAISE EXCEPTION 'order_version_required';
  END IF;
  IF coalesce(jsonb_array_length(p->'lines'), 0) = 0 THEN
    RAISE EXCEPTION 'no_lines';
  END IF;
  BEGIN
    v_user := nullif(p#>>'{actor,user_id}', '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_user := NULL;
  END;

  -- Snapshot, then delete, then insert. One statement cannot see its own
  -- delete through the primary key, so a re-import of the same row id would
  -- raise a duplicate key. These statements share the caller's transaction.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'demand_id', demand_id,
    'created_at', created_at,
    'created_by', created_by,
    'created_by_email', created_by_email
  )), '[]'::jsonb)
  INTO v_prior
  FROM public.dispatch_scope_order_lines
  WHERE job_id = v_job AND scope_id = v_scope;

  DELETE FROM public.dispatch_scope_order_lines
  WHERE job_id = v_job AND scope_id = v_scope;

  WITH inserted AS (
    INSERT INTO public.dispatch_scope_order_lines (
      id, org_id, job_id, scope_id, order_version, demand_id,
      product, product_unknown, description, quantity, unit,
      length_mm, stock_length_mm, stock_qty, cut_size, cuts, element_refs,
      supplier_name, position,
      created_at, created_by, created_by_email,
      updated_at, updated_by, updated_by_email
    )
    SELECT
      x.id,
      v_org,
      v_job,
      v_scope,
      v_version,
      x.demand_id,
      x.product,
      x.product_unknown,
      x.description,
      x.quantity,
      x.unit,
      x.length_mm,
      x.stock_length_mm,
      x.stock_qty,
      x.cut_size,
      coalesce(x.cuts, '[]'::jsonb),
      coalesce(x.element_refs, '[]'::jsonb),
      x.supplier_name,
      x.position,
      coalesce(pr.created_at, v_now),
      coalesce(pr.created_by, v_user),
      coalesce(pr.created_by_email, v_email),
      v_now,
      v_user,
      v_email
    FROM jsonb_to_recordset(p->'lines') AS x(
      id uuid,
      demand_id text,
      product text,
      product_unknown boolean,
      description text,
      quantity numeric,
      unit text,
      length_mm integer,
      stock_length_mm integer,
      stock_qty numeric,
      cut_size text,
      cuts jsonb,
      element_refs jsonb,
      supplier_name text,
      position integer
    )
    LEFT JOIN jsonb_to_recordset(v_prior) AS pr(
      demand_id text,
      created_at timestamptz,
      created_by uuid,
      created_by_email text
    ) ON pr.demand_id = x.demand_id
    RETURNING demand_id
  )
  SELECT count(*)::integer INTO v_removed
  FROM jsonb_to_recordset(v_prior) AS prior(demand_id text)
  WHERE NOT EXISTS (SELECT 1 FROM inserted i WHERE i.demand_id = prior.demand_id);

  RETURN jsonb_build_object('removed', v_removed);
END $$;

COMMENT ON FUNCTION public.dispatch_replace_scope_order_lines(jsonb) IS
  'Dispatch scope order import, one transaction: delete and insert one scope on one job. Other scopes stay. Raises no_lines, scope_id_required or order_version_required. No price, purchase order or job event.';

REVOKE ALL ON FUNCTION public.dispatch_replace_scope_order_lines(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_replace_scope_order_lines(jsonb) TO service_role;
