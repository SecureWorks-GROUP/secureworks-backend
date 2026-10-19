-- Dispatch scope material lines, stage 2.
--
-- Contract: docs/dispatch-scope-material-lines-v1.md. Reader:
-- ops-api `dispatch_scope_material_lines`. Writer: ops-api
-- `dispatch_scope_order_apply`, and nothing else, through
-- dispatch_replace_scope_material_lines.
--
-- Copies known scope-order lines onto the existing job_material_lines list
-- as To order. It does not create a second materials table, a suppliers row,
-- a purchase order, or a price. supplier_match on the scope-order row is a
-- flag, not a contact. price_to_confirm is the generic price note, not a price.
--
-- Version 20261019150000 is after 20261019120000 and does not collide with a
-- file in this repository.
--
-- No trigger, no business_events row, no job_events row.
--
-- Rollback: supabase/rollbacks/20261019150000_dispatch_scope_material_lines_down.sql.

ALTER TABLE public.dispatch_scope_order_lines
  ADD COLUMN IF NOT EXISTS price_to_confirm boolean NOT NULL DEFAULT false;

ALTER TABLE public.dispatch_scope_order_lines
  ADD COLUMN IF NOT EXISTS supplier_match text NULL;

ALTER TABLE public.dispatch_scope_order_lines
  DROP CONSTRAINT IF EXISTS dispatch_scope_order_lines_supplier_match_valid;

ALTER TABLE public.dispatch_scope_order_lines
  ADD CONSTRAINT dispatch_scope_order_lines_supplier_match_valid CHECK (
    supplier_match IS NULL OR supplier_match IN ('matched', 'unmatched', 'ambiguous')
  );

COMMENT ON COLUMN public.dispatch_scope_order_lines.price_to_confirm IS
  'True only when every toConfirm note on the demand is the generic price reminder. Not a price.';

COMMENT ON COLUMN public.dispatch_scope_order_lines.supplier_match IS
  'Set by dispatch_scope_order_apply: matched, unmatched or ambiguous. Re-import clears it. Not a supplier id.';

-- Known aliases are data on the supplier record. Empty until someone records
-- one. Matching never invents an alias in code.
ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS aliases text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.suppliers.aliases IS
  'Names that match this supplier exactly after trim, case fold and collapsed spaces. Dispatch scope apply reads them. No row is created by that apply.';

-- The same list slice 4 owns. A scope line is source scope with both link
-- columns set. A hand line, and a slice 4 suggestion, leave both null.
ALTER TABLE public.job_material_lines
  ADD COLUMN IF NOT EXISTS product text NULL,
  ADD COLUMN IF NOT EXISTS length_mm integer NULL,
  ADD COLUMN IF NOT EXISTS stock_length_mm integer NULL,
  ADD COLUMN IF NOT EXISTS stock_qty numeric(12,3) NULL,
  ADD COLUMN IF NOT EXISTS cut_size text NULL,
  ADD COLUMN IF NOT EXISTS cuts jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS scope_id text NULL,
  ADD COLUMN IF NOT EXISTS demand_id text NULL,
  ADD COLUMN IF NOT EXISTS unit_price numeric(12,2) NULL;

ALTER TABLE public.job_material_lines
  DROP CONSTRAINT IF EXISTS job_material_lines_scope_link_check;

ALTER TABLE public.job_material_lines
  ADD CONSTRAINT job_material_lines_scope_link_check CHECK (
    (scope_id IS NULL AND demand_id IS NULL)
    OR (source = 'scope' AND scope_id IS NOT NULL AND demand_id IS NOT NULL)
  );

ALTER TABLE public.job_material_lines
  DROP CONSTRAINT IF EXISTS job_material_lines_product_length;

ALTER TABLE public.job_material_lines
  ADD CONSTRAINT job_material_lines_product_length CHECK (
    product IS NULL OR char_length(product) BETWEEN 1 AND 200
  );

ALTER TABLE public.job_material_lines
  DROP CONSTRAINT IF EXISTS job_material_lines_length_mm_range;

ALTER TABLE public.job_material_lines
  ADD CONSTRAINT job_material_lines_length_mm_range CHECK (
    length_mm IS NULL OR (length_mm >= 0 AND length_mm <= 100000)
  );

ALTER TABLE public.job_material_lines
  DROP CONSTRAINT IF EXISTS job_material_lines_stock_length_mm_range;

ALTER TABLE public.job_material_lines
  ADD CONSTRAINT job_material_lines_stock_length_mm_range CHECK (
    stock_length_mm IS NULL OR (stock_length_mm >= 0 AND stock_length_mm <= 100000)
  );

ALTER TABLE public.job_material_lines
  DROP CONSTRAINT IF EXISTS job_material_lines_stock_qty_not_negative;

ALTER TABLE public.job_material_lines
  ADD CONSTRAINT job_material_lines_stock_qty_not_negative CHECK (
    stock_qty IS NULL OR stock_qty >= 0
  );

ALTER TABLE public.job_material_lines
  DROP CONSTRAINT IF EXISTS job_material_lines_cut_size_length;

ALTER TABLE public.job_material_lines
  ADD CONSTRAINT job_material_lines_cut_size_length CHECK (
    cut_size IS NULL OR char_length(cut_size) BETWEEN 1 AND 300
  );

ALTER TABLE public.job_material_lines
  DROP CONSTRAINT IF EXISTS job_material_lines_cuts_array;

ALTER TABLE public.job_material_lines
  ADD CONSTRAINT job_material_lines_cuts_array CHECK (jsonb_typeof(cuts) = 'array');

ALTER TABLE public.job_material_lines
  DROP CONSTRAINT IF EXISTS job_material_lines_cuts_count;

ALTER TABLE public.job_material_lines
  ADD CONSTRAINT job_material_lines_cuts_count CHECK (jsonb_array_length(cuts) <= 40);

ALTER TABLE public.job_material_lines
  DROP CONSTRAINT IF EXISTS job_material_lines_scope_id_shape;

ALTER TABLE public.job_material_lines
  ADD CONSTRAINT job_material_lines_scope_id_shape CHECK (
    scope_id IS NULL OR (
      char_length(scope_id) BETWEEN 1 AND 200
      AND scope_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:|/+-]*$'
    )
  );

ALTER TABLE public.job_material_lines
  DROP CONSTRAINT IF EXISTS job_material_lines_demand_id_shape;

ALTER TABLE public.job_material_lines
  ADD CONSTRAINT job_material_lines_demand_id_shape CHECK (
    demand_id IS NULL OR (
      char_length(demand_id) BETWEEN 1 AND 200
      AND demand_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:|/+-]*$'
    )
  );

ALTER TABLE public.job_material_lines
  DROP CONSTRAINT IF EXISTS job_material_lines_unit_price_not_negative;

ALTER TABLE public.job_material_lines
  ADD CONSTRAINT job_material_lines_unit_price_not_negative CHECK (
    unit_price IS NULL OR unit_price >= 0
  );

CREATE UNIQUE INDEX IF NOT EXISTS job_material_lines_job_scope_demand_key
  ON public.job_material_lines (job_id, scope_id, demand_id)
  WHERE scope_id IS NOT NULL AND demand_id IS NOT NULL;

COMMENT ON TABLE public.job_material_lines IS
  'Dispatch tab (docs/dispatch-slice-4-contract.md, docs/dispatch-scope-material-lines-v1.md): one row per material line, each under a supplier chosen for the job. Written by ops-api dispatch_materials_save_line / _delete_line / _suggest and by dispatch_scope_order_apply through dispatch_replace_scope_material_lines. purchase_order_id is set by no slice 4 path.';

COMMENT ON TABLE public.job_material_suppliers IS
  'Dispatch tab (docs/dispatch-slice-4-contract.md, docs/dispatch-scope-material-lines-v1.md): the supplier contacts chosen for a job. Written by ops-api dispatch_materials_add_supplier / dispatch_materials_remove_supplier, and by dispatch_scope_order_apply when a matched supplier is not yet on the job. That apply does not create suppliers rows and does not rename a contact already on the job.';

-- Persist the price-note flag. A payload from before this column omits it and
-- stores false. supplier_match is not copied: a re-import clears it.
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
      product, product_unknown, price_to_confirm, description, quantity, unit,
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
      coalesce(x.price_to_confirm, false),
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
      price_to_confirm boolean,
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
  'Dispatch scope order import, one transaction: delete and insert one scope on one job. Other scopes stay. Raises no_lines, scope_id_required or order_version_required. Stores price_to_confirm and clears supplier_match. No price, purchase order or job event.';

REVOKE ALL ON FUNCTION public.dispatch_replace_scope_order_lines(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_replace_scope_order_lines(jsonb) TO service_role;

-- Replace one scope's copied material lines. An empty lines array clears the
-- scope's lines that are not already on a purchase order. A line already on a
-- purchase order is left as it was, including when that demand has left the
-- scope. Manually added lines, and every other scope, stay. The 500 cap matches
-- DISPATCH_MATERIAL_LINES_PER_JOB_MAX and is checked before any write.
CREATE OR REPLACE FUNCTION public.dispatch_replace_scope_material_lines(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job uuid := (p->>'job_id')::uuid;
  v_org uuid := (p->>'org_id')::uuid;
  v_scope text := btrim(p->>'scope_id');
  v_user uuid;
  v_email text := nullif(p#>>'{actor,email}', '');
  v_now timestamptz := coalesce((p->>'now')::timestamptz, now());
  v_prior jsonb;
  v_keep integer;
  v_add integer;
  v_removed integer;
  v_held integer;
  v_copied integer;
BEGIN
  IF v_scope IS NULL OR v_scope = '' THEN
    RAISE EXCEPTION 'scope_id_required';
  END IF;
  BEGIN
    v_user := nullif(p#>>'{actor,user_id}', '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_user := NULL;
  END;

  SELECT count(*)::integer INTO v_keep
  FROM public.job_material_lines
  WHERE job_id = v_job
    AND NOT (source = 'scope' AND scope_id = v_scope AND purchase_order_id IS NULL);

  SELECT count(*)::integer INTO v_add
  FROM jsonb_to_recordset(coalesce(p->'lines', '[]'::jsonb)) AS x(demand_id text)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.job_material_lines held
    WHERE held.job_id = v_job
      AND held.source = 'scope'
      AND held.scope_id = v_scope
      AND held.demand_id = x.demand_id
      AND held.purchase_order_id IS NOT NULL
  );

  IF v_keep + v_add > 500 THEN
    RAISE EXCEPTION 'too_many_lines';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'demand_id', demand_id,
    'purchase_order_id', purchase_order_id,
    'created_at', created_at,
    'created_by', created_by,
    'created_by_email', created_by_email
  )), '[]'::jsonb)
  INTO v_prior
  FROM public.job_material_lines
  WHERE job_id = v_job AND source = 'scope' AND scope_id = v_scope;

  SELECT count(*)::integer INTO v_removed
  FROM jsonb_to_recordset(v_prior) AS prior(demand_id text, purchase_order_id uuid)
  WHERE prior.purchase_order_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_to_recordset(coalesce(p->'lines', '[]'::jsonb)) AS x(demand_id text)
      WHERE x.demand_id = prior.demand_id
    );

  SELECT count(*)::integer INTO v_held
  FROM jsonb_to_recordset(v_prior) AS prior(purchase_order_id uuid)
  WHERE prior.purchase_order_id IS NOT NULL;

  INSERT INTO public.job_material_suppliers (
    org_id, job_id, supplier_id, supplier_name, position, created_at, created_by, created_by_email
  )
  SELECT
    v_org,
    v_job,
    s.supplier_id,
    s.supplier_name,
    coalesce((SELECT max(position) FROM public.job_material_suppliers WHERE job_id = v_job), -1)
      + row_number() OVER (ORDER BY s.position, s.supplier_id),
    v_now,
    v_user,
    v_email
  FROM (
    SELECT DISTINCT ON (supplier_id) supplier_id, supplier_name, position
    FROM jsonb_to_recordset(coalesce(p->'suppliers', '[]'::jsonb)) AS x(
      supplier_id uuid,
      supplier_name text,
      position integer
    )
    ORDER BY supplier_id, position
  ) s
  WHERE NOT EXISTS (
    SELECT 1 FROM public.job_material_suppliers existing
    WHERE existing.job_id = v_job AND existing.supplier_id = s.supplier_id
  );

  DELETE FROM public.job_material_lines
  WHERE job_id = v_job
    AND source = 'scope'
    AND scope_id = v_scope
    AND purchase_order_id IS NULL;

  WITH inserted AS (
    INSERT INTO public.job_material_lines (
      id, org_id, job_id, supplier_id, description, quantity, unit,
      status, source, product, length_mm, stock_length_mm, stock_qty, cut_size, cuts,
      scope_id, demand_id, unit_price, purchase_order_id, position,
      created_at, created_by, created_by_email,
      updated_at, updated_by, updated_by_email
    )
    SELECT
      x.id,
      v_org,
      v_job,
      x.supplier_id,
      x.description,
      x.quantity,
      x.unit,
      'to_order',
      'scope',
      x.product,
      x.length_mm,
      x.stock_length_mm,
      x.stock_qty,
      x.cut_size,
      coalesce(x.cuts, '[]'::jsonb),
      v_scope,
      x.demand_id,
      x.unit_price,
      NULL,
      x.position,
      coalesce(pr.created_at, v_now),
      coalesce(pr.created_by, v_user),
      coalesce(pr.created_by_email, v_email),
      v_now,
      v_user,
      v_email
    FROM jsonb_to_recordset(coalesce(p->'lines', '[]'::jsonb)) AS x(
      id uuid,
      supplier_id uuid,
      description text,
      quantity numeric,
      unit text,
      product text,
      length_mm integer,
      stock_length_mm integer,
      stock_qty numeric,
      cut_size text,
      cuts jsonb,
      demand_id text,
      unit_price numeric,
      position integer
    )
    LEFT JOIN jsonb_to_recordset(v_prior) AS pr(
      demand_id text,
      created_at timestamptz,
      created_by uuid,
      created_by_email text
    ) ON pr.demand_id = x.demand_id
    WHERE NOT EXISTS (
      SELECT 1 FROM public.job_material_lines existing
      WHERE existing.job_id = v_job
        AND existing.scope_id = v_scope
        AND existing.demand_id = x.demand_id
    )
    RETURNING demand_id
  )
  SELECT count(*)::integer INTO v_copied FROM inserted;

  UPDATE public.dispatch_scope_order_lines AS line
  SET supplier_match = flag.supplier_match
  FROM jsonb_to_recordset(coalesce(p->'flags', '[]'::jsonb)) AS flag(
    demand_id text,
    supplier_match text
  )
  WHERE line.job_id = v_job
    AND line.scope_id = v_scope
    AND line.demand_id = flag.demand_id;

  RETURN jsonb_build_object('removed', v_removed, 'copied', v_copied, 'held', v_held);
END $$;

COMMENT ON FUNCTION public.dispatch_replace_scope_material_lines(jsonb) IS
  'Dispatch scope apply, one transaction: copy one scope onto job_material_lines as to_order. Leaves manual lines, other scopes, and lines already on a purchase order. Raises scope_id_required or too_many_lines. Does not create a suppliers row, a purchase order, or a price.';

REVOKE ALL ON FUNCTION public.dispatch_replace_scope_material_lines(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_replace_scope_material_lines(jsonb) TO service_role;
