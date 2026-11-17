CREATE OR REPLACE FUNCTION public.trade_invoice_first_numeric_candidate_v1(
  p_values jsonb,
  p_fallback numeric
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(
    (
      SELECT candidate.value_text::numeric
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(p_values) = 'array' THEN p_values ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS candidate(value_text, ordinality)
      WHERE NULLIF(BTRIM(candidate.value_text), '') IS NOT NULL
        AND candidate.value_text ~ '^\s*-?([0-9]+(\.[0-9]*)?|\.[0-9]+)\s*$'
      ORDER BY candidate.ordinality
      LIMIT 1
    ),
    p_fallback
  );
$$;

CREATE OR REPLACE FUNCTION public.trade_invoice_work_order_scope_lines_v1(
  p_scope_items jsonb
)
RETURNS TABLE (
  line_type text,
  description text,
  quantity numeric,
  unit text,
  unit_rate numeric,
  line_total_ex numeric
)
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT
    CASE
      WHEN LOWER(CONCAT_WS(' ', item->>'line_type', item->>'type', item->>'category', item->>'description', item->>'name'))
        ~ '(travel|logistics|disposal|pickup)' THEN 'travel'
      WHEN LOWER(CONCAT_WS(' ', item->>'line_type', item->>'type', item->>'category', item->>'description', item->>'name'))
        ~ '(material|plinth|tube|lattice)' THEN 'materials'
      WHEN LOWER(CONCAT_WS(' ', item->>'line_type', item->>'type', item->>'category', item->>'description', item->>'name'))
        ~ 'patio' THEN 'patio'
      WHEN LOWER(CONCAT_WS(' ', item->>'line_type', item->>'type', item->>'category', item->>'description', item->>'name'))
        ~ '(fence|removal|install|gate|labour|labor)' THEN 'labour'
      ELSE 'other'
    END,
    COALESCE(
      NULLIF(BTRIM(regexp_replace(item->>'description', '\s+', ' ', 'g')), ''),
      NULLIF(BTRIM(regexp_replace(item->>'name', '\s+', ' ', 'g')), ''),
      'Work order item'
    ),
    round(quantity.value, 2),
    COALESCE(NULLIF(item->>'unit', ''), CASE WHEN item ? 'metres' THEN 'm' ELSE 'ea' END),
    round(unit_rate.value, 2),
    round(round(quantity.value, 2) * round(unit_rate.value, 2), 2)
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(p_scope_items) = 'array' THEN p_scope_items ELSE '[]'::jsonb END
  ) AS input(item)
  CROSS JOIN LATERAL (
    SELECT public.trade_invoice_first_numeric_candidate_v1(
      jsonb_build_array(item->'quantity', item->'metres', item->'qty'),
      1
    )
  ) AS quantity(value)
  CROSS JOIN LATERAL (
    SELECT public.trade_invoice_first_numeric_candidate_v1(
      jsonb_build_array(item->'unit_price', item->'rate', item->'price'),
      0
    )
  ) AS unit_rate(value);
$$;

REVOKE ALL ON FUNCTION public.trade_invoice_first_numeric_candidate_v1(jsonb, numeric)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trade_invoice_work_order_scope_lines_v1(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trade_invoice_first_numeric_candidate_v1(jsonb, numeric)
  TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.trade_invoice_work_order_scope_lines_v1(jsonb)
  TO service_role, postgres;

COMMENT ON COLUMN public.trade_invoice_lines.source_work_order_id IS
  'Work order whose stored scope/rates produced this weekly invoice line.';
COMMENT ON COLUMN public.trade_invoice_lines.source_trade_invoice_line_id IS
  'Acknowledged crew invoice line whose server-selected amount was signed negative for pass-through.';
COMMENT ON COLUMN public.trade_invoice_lines.deduction_user_id IS
  'Crew user whose dated trade_rates row priced a direct labour deduction.';
COMMENT ON COLUMN public.trade_invoice_lines.deduction_assignment_id IS
  'Non-cancelled job assignment proving the direct labour deduction belongs to the job.';
COMMENT ON COLUMN public.trade_invoice_lines.deduction_trade_rate_id IS
  'Exact dated trade_rates row whose hourly rate priced the direct labour deduction.';
COMMENT ON COLUMN public.trade_invoice_lines.site_address IS
  'Invoice snapshot of the job address used to render a stable weekly job block.';
COMMENT ON COLUMN public.trade_invoice_lines.line_position IS
  'Zero-based stable display/Xero order within the invoice.';

-- Both invoice routes acquire this same organization-scoped transaction lock.
-- Contractor invoices are low volume, and the deliberately coarse lock means
-- a single-work-order submit cannot race a weekly draft for the same source.
CREATE OR REPLACE FUNCTION public.persist_weekly_trade_invoice_v1(
  p_invoice jsonb,
  p_lines jsonb,
  p_requested_prior_draft_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_invoice_id uuid;
  v_org_id uuid;
  v_user_id uuid;
  v_week_start date;
  v_week_end date;
  v_status text;
  v_invoice_source text;
  v_prior_draft_id uuid;
  v_prior_xero_bill_id text;
  v_prior_xero_pushed_at timestamptz;
  v_draft_count integer;
  v_deleted_count integer;
  v_line_sum numeric(12,2);
  v_job_grand_total numeric(12,2);
  v_final_deductions_total numeric(12,2);
  v_user_role text;
  v_user_managed_verticals text[];
BEGIN
  IF p_invoice IS NULL
     OR p_lines IS NULL
     OR jsonb_typeof(p_invoice) <> 'object'
     OR jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'weekly/hourly draft persistence requires one header object and a line array'
      USING ERRCODE = '22023';
  END IF;

  v_org_id := NULLIF(p_invoice->>'org_id', '')::uuid;
  v_user_id := NULLIF(p_invoice->>'user_id', '')::uuid;
  v_week_start := NULLIF(p_invoice->>'week_start', '')::date;
  v_week_end := NULLIF(p_invoice->>'week_end', '')::date;
  v_status := NULLIF(p_invoice->>'status', '');
  v_invoice_source := NULLIF(p_invoice->>'invoice_source', '');
  IF v_org_id IS NULL
     OR v_user_id IS NULL
     OR v_week_start IS NULL
     OR v_week_end IS NULL
     OR v_week_end <> v_week_start + 6
     OR EXTRACT(ISODOW FROM v_week_start) <> 1
     OR v_invoice_source NOT IN ('weekly_work_order', 'hourly')
     OR NOT (
       (v_invoice_source = 'weekly_work_order' AND v_status IN ('draft', 'pending_acknowledgment'))
       OR (v_invoice_source = 'hourly' AND v_status = 'draft')
     ) THEN
    RAISE EXCEPTION 'invalid weekly/hourly draft persistence identity'
      USING ERRCODE = '22023';
  END IF;
  IF v_invoice_source = 'weekly_work_order' AND jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'weekly invoice requires at least one line'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('weekly-trade-invoice:' || v_org_id::text, 0)
  );

  SELECT LOWER(COALESCE(role, '')), COALESCE(managed_verticals, ARRAY[]::text[])
  INTO v_user_role, v_user_managed_verticals
  FROM public.users
  WHERE id = v_user_id
    AND org_id = v_org_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'trade invoice submitter is no longer an active tenant user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM public.work_orders wo
  JOIN (
    SELECT DISTINCT NULLIF(line->>'source_work_order_id', '')::uuid AS source_id
    FROM jsonb_array_elements(p_lines) AS input(line)
    WHERE COALESCE(line->>'line_type', '') <> 'final_payout_deduction'
  ) sources
    ON sources.source_id = wo.id
  JOIN public.jobs job
    ON job.id = wo.job_id
   AND job.org_id = wo.org_id
  WHERE wo.org_id = v_org_id
  FOR UPDATE OF wo, job;

  IF v_invoice_source = 'weekly_work_order' AND EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT NULLIF(line->>'source_work_order_id', '')::uuid AS source_id
      FROM jsonb_array_elements(p_lines) AS input(line)
      WHERE COALESCE(line->>'line_type', '') <> 'final_payout_deduction'
    ) sources
    JOIN public.work_orders wo
      ON wo.id = sources.source_id
     AND wo.org_id = v_org_id
    JOIN public.jobs job
      ON job.id = wo.job_id
     AND job.org_id = wo.org_id
    WHERE wo.assigned_user_id IS DISTINCT FROM v_user_id
      AND v_user_role NOT IN ('admin', 'owner', 'ops_manager')
      AND NOT (
        CASE
          WHEN LOWER(COALESCE(job.type, '')) = 'makesafe'
            OR UPPER(COALESCE(job.job_number, '')) LIKE 'SWMS-%'
            THEN 'makesafe'
          ELSE LOWER(COALESCE(job.type, ''))
        END = ANY(v_user_managed_verticals)
      )
  ) THEN
    RAISE EXCEPTION 'weekly invoice submitter no longer owns or manages every source work order'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM public.trade_invoice_lines source_line
  JOIN public.trade_invoices source_invoice
    ON source_invoice.id = source_line.trade_invoice_id
  WHERE source_line.id IN (
    SELECT NULLIF(line->>'source_trade_invoice_line_id', '')::uuid
    FROM jsonb_array_elements(p_lines) AS input(line)
    WHERE NULLIF(line->>'source_trade_invoice_line_id', '') IS NOT NULL
  )
  FOR UPDATE OF source_line, source_invoice;

  PERFORM 1
  FROM public.job_assignments assignment
  WHERE assignment.id IN (
    SELECT NULLIF(line->>'deduction_assignment_id', '')::uuid
    FROM jsonb_array_elements(p_lines) AS input(line)
    WHERE NULLIF(line->>'deduction_assignment_id', '') IS NOT NULL
  )
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_lines) AS input(line)
    WHERE input.line->>'line_type' = 'labour_deduction'
  ) THEN
    LOCK TABLE public.trade_rates IN SHARE MODE;
  END IF;

  SELECT count(*)
  INTO v_draft_count
  FROM public.trade_invoices
  WHERE org_id = v_org_id
    AND user_id = v_user_id
    AND week_start = v_week_start
    AND status = 'draft';

  IF v_draft_count > 1 THEN
    RAISE EXCEPTION 'multiple weekly drafts need office review before replacement'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id, xero_bill_id, xero_pushed_at
  INTO v_prior_draft_id, v_prior_xero_bill_id, v_prior_xero_pushed_at
  FROM public.trade_invoices
  WHERE org_id = v_org_id
    AND user_id = v_user_id
    AND week_start = v_week_start
    AND status = 'draft'
  ORDER BY created_at, id
  LIMIT 1
  FOR UPDATE;

  IF p_requested_prior_draft_id IS DISTINCT FROM v_prior_draft_id THEN
    RAISE EXCEPTION 'selected weekly/hourly draft is no longer replaceable'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_prior_draft_id IS NOT NULL
     AND (v_prior_xero_bill_id IS NOT NULL OR v_prior_xero_pushed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'weekly/hourly draft has an external Xero identity'
      USING ERRCODE = 'P0001';
  END IF;

  -- The target columns store quantity/rate to two decimals. Validate against
  -- those exact persisted values so a higher-precision request cannot pass
  -- one total check and then store a different arithmetic result.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_lines) AS input(line)
    WHERE NULLIF(line->>'quantity', '') IS NOT NULL
      AND NULLIF(line->>'unit_rate', '') IS NOT NULL
      AND round(
        round((line->>'quantity')::numeric, 2) *
        round((line->>'unit_rate')::numeric, 2),
        2
      ) IS DISTINCT FROM round((line->>'line_total_ex')::numeric, 2)
  ) THEN
    RAISE EXCEPTION 'trade invoice line total does not match storage-precision quantity and rate'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    round(COALESCE(sum(round((line->>'line_total_ex')::numeric, 2)), 0), 2),
    round(COALESCE(sum(
      CASE WHEN line->>'line_type' <> 'final_payout_deduction'
        THEN round((line->>'line_total_ex')::numeric, 2) ELSE 0 END
    ), 0), 2),
    round(COALESCE(-sum(
      CASE WHEN line->>'line_type' = 'final_payout_deduction'
        THEN round((line->>'line_total_ex')::numeric, 2) ELSE 0 END
    ), 0), 2)
  INTO v_line_sum, v_job_grand_total, v_final_deductions_total
  FROM jsonb_array_elements(p_lines) AS input(line);

  IF v_line_sum IS DISTINCT FROM round((p_invoice->>'subtotal_ex')::numeric, 2)
     OR v_line_sum IS DISTINCT FROM round((p_invoice->>'gross_earned')::numeric, 2)
     OR (
       v_invoice_source = 'weekly_work_order'
       AND (
         v_job_grand_total IS DISTINCT FROM round((p_invoice->>'job_grand_total_ex')::numeric, 2)
         OR v_final_deductions_total IS DISTINCT FROM round((p_invoice->>'final_deductions_total_ex')::numeric, 2)
         OR v_line_sum IS DISTINCT FROM round((p_invoice->>'to_be_paid_ex')::numeric, 2)
       )
     ) THEN
    RAISE EXCEPTION 'weekly/hourly draft header does not equal its persisted lines'
      USING ERRCODE = '23514';
  END IF;

  IF v_invoice_source = 'weekly_work_order' AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_lines) AS input(line)
    LEFT JOIN public.work_orders wo
      ON wo.id = NULLIF(input.line->>'source_work_order_id', '')::uuid
    WHERE COALESCE(input.line->>'line_type', '') <> 'final_payout_deduction'
      AND (
        NULLIF(input.line->>'source_work_order_id', '') IS NULL
        OR wo.id IS NULL
        OR wo.org_id <> v_org_id
        OR wo.job_id IS DISTINCT FROM NULLIF(input.line->>'job_id', '')::uuid
        OR wo.status IS DISTINCT FROM 'complete'
        OR COALESCE((wo.completed_at AT TIME ZONE 'Australia/Perth')::date, wo.scheduled_date) IS NULL
        OR COALESCE((wo.completed_at AT TIME ZONE 'Australia/Perth')::date, wo.scheduled_date)
          NOT BETWEEN v_week_start AND v_week_end
        OR COALESCE((wo.completed_at AT TIME ZONE 'Australia/Perth')::date, wo.scheduled_date)
          IS DISTINCT FROM NULLIF(input.line->>'line_date', '')::date
      )
  ) THEN
    RAISE EXCEPTION 'weekly invoice contains an invalid work-order source'
      USING ERRCODE = '23503';
  END IF;

  IF v_invoice_source = 'weekly_work_order' AND EXISTS (
    WITH expected AS (
      SELECT
        wo.id AS source_work_order_id,
        wo.job_id,
        scope.line_type,
        scope.description,
        scope.quantity,
        scope.unit,
        scope.unit_rate,
        scope.line_total_ex,
        COALESCE((wo.completed_at AT TIME ZONE 'Australia/Perth')::date, wo.scheduled_date) AS line_date,
        count(*) AS line_count
      FROM public.work_orders wo
      JOIN (
        SELECT DISTINCT NULLIF(line->>'source_work_order_id', '')::uuid AS source_id
        FROM jsonb_array_elements(p_lines) AS input(line)
        WHERE COALESCE(line->>'line_type', '') <> 'final_payout_deduction'
      ) sources
        ON sources.source_id = wo.id
      CROSS JOIN LATERAL public.trade_invoice_work_order_scope_lines_v1(wo.scope_items) scope
      WHERE wo.org_id = v_org_id
      GROUP BY
        wo.id,
        wo.job_id,
        scope.line_type,
        scope.description,
        scope.quantity,
        scope.unit,
        scope.unit_rate,
        scope.line_total_ex,
        COALESCE((wo.completed_at AT TIME ZONE 'Australia/Perth')::date, wo.scheduled_date)
    ),
    actual AS (
      SELECT
        NULLIF(line->>'source_work_order_id', '')::uuid AS source_work_order_id,
        NULLIF(line->>'job_id', '')::uuid AS job_id,
        NULLIF(line->>'line_type', '') AS line_type,
        NULLIF(BTRIM(regexp_replace(line->>'description', '\s+', ' ', 'g')), '') AS description,
        round(NULLIF(line->>'quantity', '')::numeric, 2) AS quantity,
        NULLIF(line->>'unit', '') AS unit,
        round(NULLIF(line->>'unit_rate', '')::numeric, 2) AS unit_rate,
        round((line->>'line_total_ex')::numeric, 2) AS line_total_ex,
        NULLIF(line->>'line_date', '')::date AS line_date,
        count(*) AS line_count
      FROM jsonb_array_elements(p_lines) AS input(line)
      WHERE COALESCE(line->>'line_type', '') NOT IN (
        'crew_work_order_deduction',
        'labour_deduction',
        'travel_logistics_deduction',
        'materials_deduction',
        'final_payout_deduction'
      )
      GROUP BY
        NULLIF(line->>'source_work_order_id', '')::uuid,
        NULLIF(line->>'job_id', '')::uuid,
        NULLIF(line->>'line_type', ''),
        NULLIF(BTRIM(regexp_replace(line->>'description', '\s+', ' ', 'g')), ''),
        round(NULLIF(line->>'quantity', '')::numeric, 2),
        NULLIF(line->>'unit', ''),
        round(NULLIF(line->>'unit_rate', '')::numeric, 2),
        round((line->>'line_total_ex')::numeric, 2),
        NULLIF(line->>'line_date', '')::date
    ),
    mismatches AS (
      (SELECT * FROM expected EXCEPT SELECT * FROM actual)
      UNION ALL
      (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    )
    SELECT 1 FROM mismatches
  ) THEN
    RAISE EXCEPTION 'weekly invoice source scope changed before persistence'
      USING ERRCODE = '23503';
  END IF;

  IF v_invoice_source = 'weekly_work_order' AND (
    EXISTS (
      SELECT 1
      FROM (
        SELECT DISTINCT NULLIF(line->>'source_work_order_id', '')::uuid AS source_id
        FROM jsonb_array_elements(p_lines) AS input(line)
      ) sources
      JOIN public.trade_invoice_lines existing
        ON existing.source_work_order_id = sources.source_id
      JOIN public.trade_invoices parent
        ON parent.id = existing.trade_invoice_id
      WHERE sources.source_id IS NOT NULL
        AND parent.id IS DISTINCT FROM v_prior_draft_id
        AND (parent.status IS NULL OR parent.status NOT IN ('ops-reject', 'failed'))
    ) OR EXISTS (
      SELECT 1
      FROM (
        SELECT DISTINCT NULLIF(line->>'source_work_order_id', '')::uuid AS source_id
        FROM jsonb_array_elements(p_lines) AS input(line)
      ) sources
      JOIN public.trade_invoices parent
        ON parent.work_order_id = sources.source_id
      WHERE sources.source_id IS NOT NULL
        AND parent.id IS DISTINCT FROM v_prior_draft_id
        AND (parent.status IS NULL OR parent.status NOT IN ('ops-reject', 'failed'))
    )
  ) THEN
    RAISE EXCEPTION 'a weekly work order is already held by another invoice'
      USING ERRCODE = '23505';
  END IF;

  IF v_invoice_source = 'weekly_work_order' AND EXISTS (
    SELECT 1
    FROM (
      SELECT NULLIF(line->>'source_trade_invoice_line_id', '')::uuid AS source_id
      FROM jsonb_array_elements(p_lines) AS input(line)
      WHERE NULLIF(line->>'source_trade_invoice_line_id', '') IS NOT NULL
      GROUP BY NULLIF(line->>'source_trade_invoice_line_id', '')::uuid
      HAVING count(*) > 1
    ) duplicate_sources
  ) THEN
    RAISE EXCEPTION 'a crew charge can only be deducted once'
      USING ERRCODE = '23505';
  END IF;

  IF v_invoice_source = 'weekly_work_order' AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_lines) AS input(line)
    LEFT JOIN public.trade_invoice_lines source_line
      ON source_line.id = NULLIF(input.line->>'source_trade_invoice_line_id', '')::uuid
    LEFT JOIN public.trade_invoices source_invoice
      ON source_invoice.id = source_line.trade_invoice_id
    WHERE NULLIF(input.line->>'source_trade_invoice_line_id', '') IS NOT NULL
      AND (
        source_line.id IS NULL
        OR source_line.job_id IS DISTINCT FROM NULLIF(input.line->>'job_id', '')::uuid
        OR source_line.acknowledgment_status IS DISTINCT FROM 'acknowledged'
        OR source_invoice.org_id IS DISTINCT FROM v_org_id
        OR source_invoice.user_id IS NULL
        OR source_invoice.user_id = v_user_id
        OR source_invoice.status IS NULL
        OR source_invoice.status IN ('ops-reject', 'failed', 'draft')
        OR round(-COALESCE(source_line.override_amount, source_line.line_total_ex), 2)
          <> round((input.line->>'line_total_ex')::numeric, 2)
      )
  ) THEN
    RAISE EXCEPTION 'weekly invoice contains an invalid crew-charge source'
      USING ERRCODE = '23503';
  END IF;

  IF v_invoice_source = 'weekly_work_order' AND EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT NULLIF(line->>'source_trade_invoice_line_id', '')::uuid AS source_id
      FROM jsonb_array_elements(p_lines) AS input(line)
    ) sources
    JOIN public.trade_invoice_lines existing
      ON existing.source_trade_invoice_line_id = sources.source_id
    JOIN public.trade_invoices parent
      ON parent.id = existing.trade_invoice_id
    WHERE sources.source_id IS NOT NULL
      AND parent.id IS DISTINCT FROM v_prior_draft_id
      AND (parent.status IS NULL OR parent.status NOT IN ('ops-reject', 'failed'))
  ) THEN
    RAISE EXCEPTION 'a crew charge is already held by another invoice'
      USING ERRCODE = '23505';
  END IF;

  IF v_invoice_source = 'weekly_work_order' AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_lines) AS input(line)
    LEFT JOIN public.job_assignments assignment
      ON assignment.id = NULLIF(input.line->>'deduction_assignment_id', '')::uuid
    LEFT JOIN public.trade_rates rate
      ON rate.id = NULLIF(input.line->>'deduction_trade_rate_id', '')::uuid
    LEFT JOIN public.work_orders wo
      ON wo.id = NULLIF(input.line->>'source_work_order_id', '')::uuid
    WHERE input.line->>'line_type' = 'labour_deduction'
      AND (
        assignment.id IS NULL
        OR assignment.user_id IS DISTINCT FROM NULLIF(input.line->>'deduction_user_id', '')::uuid
        OR assignment.job_id IS DISTINCT FROM NULLIF(input.line->>'job_id', '')::uuid
        OR assignment.status = 'cancelled'
        OR rate.id IS NULL
        OR rate.org_id IS DISTINCT FROM v_org_id
        OR rate.user_id IS DISTINCT FROM NULLIF(input.line->>'deduction_user_id', '')::uuid
        OR COALESCE((wo.completed_at AT TIME ZONE 'Australia/Perth')::date, wo.scheduled_date) IS NULL
        OR rate.effective_from > COALESCE((wo.completed_at AT TIME ZONE 'Australia/Perth')::date, wo.scheduled_date)
        OR (
          rate.effective_to IS NOT NULL
          AND rate.effective_to < COALESCE((wo.completed_at AT TIME ZONE 'Australia/Perth')::date, wo.scheduled_date)
        )
        OR rate.id IS DISTINCT FROM (
          SELECT latest_rate.id
          FROM public.trade_rates latest_rate
          WHERE latest_rate.org_id = v_org_id
            AND latest_rate.user_id = NULLIF(input.line->>'deduction_user_id', '')::uuid
            AND latest_rate.effective_from <= COALESCE((wo.completed_at AT TIME ZONE 'Australia/Perth')::date, wo.scheduled_date)
            AND (
              latest_rate.effective_to IS NULL
              OR latest_rate.effective_to >= COALESCE((wo.completed_at AT TIME ZONE 'Australia/Perth')::date, wo.scheduled_date)
            )
          ORDER BY latest_rate.effective_from DESC, latest_rate.id DESC
          LIMIT 1
        )
        OR round(-rate.hourly_rate, 2) <> round((input.line->>'unit_rate')::numeric, 2)
        OR round(
          round((input.line->>'quantity')::numeric, 2) * round(-rate.hourly_rate, 2),
          2
        )
          <> round((input.line->>'line_total_ex')::numeric, 2)
      )
  ) THEN
    RAISE EXCEPTION 'weekly invoice contains an invalid direct-labour source'
      USING ERRCODE = '23503';
  END IF;

  INSERT INTO public.trade_invoices (
    org_id, user_id, week_start, week_end, total_hours,
    total_breaks_minutes, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay,
    invoice_source, job_grand_total_ex, final_deductions_total_ex,
    to_be_paid_ex, has_manual_overrides, override_details, notes,
    invoice_number, submitted_at, status
  ) VALUES (
    v_org_id,
    v_user_id,
    v_week_start,
    NULLIF(p_invoice->>'week_end', '')::date,
    COALESCE((p_invoice->>'total_hours')::numeric, 0),
    COALESCE((p_invoice->>'total_breaks_minutes')::integer, 0),
    (p_invoice->>'subtotal_ex')::numeric,
    (p_invoice->>'gst')::numeric,
    (p_invoice->>'total_inc')::numeric,
    (p_invoice->>'gst_on')::boolean,
    (p_invoice->>'super_rate')::numeric,
    (p_invoice->>'super_amount')::numeric,
    (p_invoice->>'gross_earned')::numeric,
    (p_invoice->>'net_pay')::numeric,
    v_invoice_source,
    CASE WHEN v_invoice_source = 'weekly_work_order'
      THEN round((p_invoice->>'job_grand_total_ex')::numeric, 2) ELSE NULL END,
    CASE WHEN v_invoice_source = 'weekly_work_order'
      THEN round((p_invoice->>'final_deductions_total_ex')::numeric, 2) ELSE NULL END,
    CASE WHEN v_invoice_source = 'weekly_work_order'
      THEN round((p_invoice->>'to_be_paid_ex')::numeric, 2) ELSE NULL END,
    COALESCE((p_invoice->>'has_manual_overrides')::boolean, false),
    CASE WHEN jsonb_typeof(p_invoice->'override_details') = 'object'
      THEN p_invoice->'override_details' ELSE NULL END,
    NULLIF(p_invoice->>'notes', ''),
    NULLIF(p_invoice->>'invoice_number', ''),
    NULLIF(p_invoice->>'submitted_at', '')::timestamptz,
    v_status
  )
  RETURNING id INTO v_invoice_id;

  INSERT INTO public.trade_invoice_lines (
    trade_invoice_id, job_id, job_number, client_name, total_hours,
    hourly_rate, line_total_ex, acknowledgment_status, line_type,
    description, quantity, unit, unit_rate, line_date, division,
    work_order_hours, days_worked, assignment_ids, query_note,
    flag_type, baseline_hours, baseline_source, hours_justification,
    flagged_at, wo_allocated, wo_labour_deduction, wo_labour_lines,
    site_address, source_work_order_id, source_trade_invoice_line_id,
    deduction_user_id, deduction_assignment_id, deduction_trade_rate_id,
    line_position
  )
  SELECT
    v_invoice_id,
    NULLIF(line->>'job_id', '')::uuid,
    NULLIF(line->>'job_number', ''),
    NULLIF(line->>'client_name', ''),
    round(NULLIF(line->>'total_hours', '')::numeric, 2),
    round(NULLIF(line->>'hourly_rate', '')::numeric, 2),
    round((line->>'line_total_ex')::numeric, 2),
    COALESCE(NULLIF(line->>'acknowledgment_status', ''), 'pending'),
    COALESCE(NULLIF(line->>'line_type', ''), 'labour'),
    NULLIF(line->>'description', ''),
    round(NULLIF(line->>'quantity', '')::numeric, 2),
    NULLIF(line->>'unit', ''),
    round(NULLIF(line->>'unit_rate', '')::numeric, 2),
    NULLIF(line->>'line_date', '')::date,
    NULLIF(line->>'division', ''),
    round(NULLIF(line->>'work_order_hours', '')::numeric, 2),
    NULLIF(line->>'days_worked', '')::integer,
    CASE WHEN jsonb_typeof(line->'assignment_ids') = 'array'
      THEN ARRAY(
        SELECT assignment_id::uuid
        FROM jsonb_array_elements_text(line->'assignment_ids') AS ids(assignment_id)
      )
      ELSE NULL
    END,
    NULLIF(line->>'query_note', ''),
    NULLIF(line->>'flag_type', ''),
    round(NULLIF(line->>'baseline_hours', '')::numeric, 2),
    NULLIF(line->>'baseline_source', ''),
    NULLIF(line->>'hours_justification', ''),
    NULLIF(line->>'flagged_at', '')::timestamptz,
    NULLIF(line->>'wo_allocated', '')::numeric,
    NULLIF(line->>'wo_labour_deduction', '')::numeric,
    CASE WHEN jsonb_typeof(line->'wo_labour_lines') = 'array'
      THEN line->'wo_labour_lines' ELSE NULL END,
    NULLIF(line->>'site_address', ''),
    NULLIF(line->>'source_work_order_id', '')::uuid,
    NULLIF(line->>'source_trade_invoice_line_id', '')::uuid,
    NULLIF(line->>'deduction_user_id', '')::uuid,
    NULLIF(line->>'deduction_assignment_id', '')::uuid,
    NULLIF(line->>'deduction_trade_rate_id', '')::uuid,
    COALESCE(NULLIF(line->>'line_position', '')::integer, ordinality::integer - 1)
  FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS input(line, ordinality);

  IF v_prior_draft_id IS NOT NULL THEN
    UPDATE public.job_assignments
    SET invoiced_in = CASE
      WHEN id IN (
        SELECT assignment_id::uuid
        FROM jsonb_array_elements(p_lines) AS input(line)
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(line->'assignment_ids') = 'array'
            THEN line->'assignment_ids' ELSE '[]'::jsonb END
        ) AS assignment_ids(assignment_id)
      ) THEN v_invoice_id
      ELSE NULL
    END
    WHERE invoiced_in = v_prior_draft_id;

    DELETE FROM public.trade_invoices
    WHERE id = v_prior_draft_id;
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    IF v_deleted_count <> 1 THEN
      RAISE EXCEPTION 'weekly/hourly draft changed before replacement'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN v_invoice_id;
END;
$$;

REVOKE ALL ON FUNCTION public.persist_weekly_trade_invoice_v1(jsonb, jsonb, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_weekly_trade_invoice_v1(jsonb, jsonb, uuid)
  TO service_role;

COMMENT ON FUNCTION public.persist_weekly_trade_invoice_v1(jsonb, jsonb, uuid) IS
  'Atomically serializes dated hourly and weekly drafts, validates storage-precision line sums and weekly provenance, inserts the complete replacement, transfers assignment locks, and only then removes a prior draft.';
