-- Down for 20261019150000_dispatch_scope_material_lines.
-- Drops the material-line replace function, the scope link on
-- job_material_lines, the price-note and supplier-match columns, and
-- suppliers.aliases. Restores dispatch_replace_scope_order_lines to the
-- body from 20261018140000 while price_to_confirm still exists, then drops
-- that column. jobs, job_material_lines and dispatch_scope_order_lines remain.
-- Roll ops-api back first: dispatch_scope_order_apply names this function.

DROP FUNCTION IF EXISTS public.dispatch_replace_scope_material_lines(jsonb);

ALTER TABLE public.job_material_lines
  DROP CONSTRAINT IF EXISTS job_material_lines_scope_link_check;

DROP INDEX IF EXISTS public.job_material_lines_job_scope_demand_key;

ALTER TABLE public.job_material_lines
  DROP COLUMN IF EXISTS product,
  DROP COLUMN IF EXISTS length_mm,
  DROP COLUMN IF EXISTS stock_length_mm,
  DROP COLUMN IF EXISTS stock_qty,
  DROP COLUMN IF EXISTS cut_size,
  DROP COLUMN IF EXISTS cuts,
  DROP COLUMN IF EXISTS scope_id,
  DROP COLUMN IF EXISTS demand_id,
  DROP COLUMN IF EXISTS unit_price;

-- The body below is the function from 20261018140000. It does not write
-- price_to_confirm; the column default covers a row inserted while the
-- column is still here.
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

ALTER TABLE public.dispatch_scope_order_lines
  DROP CONSTRAINT IF EXISTS dispatch_scope_order_lines_supplier_match_valid;

ALTER TABLE public.dispatch_scope_order_lines
  DROP COLUMN IF EXISTS price_to_confirm,
  DROP COLUMN IF EXISTS supplier_match;

ALTER TABLE public.suppliers
  DROP COLUMN IF EXISTS aliases;
