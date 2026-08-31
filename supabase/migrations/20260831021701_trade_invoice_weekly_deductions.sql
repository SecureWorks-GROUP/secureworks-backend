-- Weekly work-order trade invoices with typed deductions.
--
-- The existing weekly invoice header/line tables remain authoritative. This
-- migration adds only the facts needed to reconstruct invoice job blocks,
-- prove deduction sources, and distinguish the job grand total from the final
-- TO BE PAID amount. Legacy invoices keep every new field NULL.

ALTER TABLE public.trade_invoices
  ADD COLUMN IF NOT EXISTS job_grand_total_ex numeric(12,2),
  ADD COLUMN IF NOT EXISTS final_deductions_total_ex numeric(12,2),
  ADD COLUMN IF NOT EXISTS to_be_paid_ex numeric(12,2);

COMMENT ON COLUMN public.trade_invoices.job_grand_total_ex IS
  'Weekly work-order shape: sum of all job-block lines, including job-scoped deductions, before final payout deductions.';
COMMENT ON COLUMN public.trade_invoices.final_deductions_total_ex IS
  'Weekly work-order shape: positive magnitude of final non-job payout deductions.';
COMMENT ON COLUMN public.trade_invoices.to_be_paid_ex IS
  'Weekly work-order shape: job_grand_total_ex - final_deductions_total_ex; equals subtotal_ex/gross_earned and the pre-GST Xero bill total.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.trade_invoices'::regclass
      AND conname = 'trade_invoices_weekly_totals_check'
  ) THEN
    ALTER TABLE public.trade_invoices
      ADD CONSTRAINT trade_invoices_weekly_totals_check CHECK (
        (
          COALESCE(invoice_source, 'hourly') <> 'weekly_work_order'
          AND job_grand_total_ex IS NULL
          AND final_deductions_total_ex IS NULL
          AND to_be_paid_ex IS NULL
        )
        OR
        (
          invoice_source = 'weekly_work_order'
          AND job_grand_total_ex IS NOT NULL
          AND final_deductions_total_ex IS NOT NULL
          AND to_be_paid_ex IS NOT NULL
          AND job_grand_total_ex > 0
          AND final_deductions_total_ex >= 0
          AND to_be_paid_ex > 0
          AND to_be_paid_ex = round(job_grand_total_ex - final_deductions_total_ex, 2)
          AND to_be_paid_ex = round(subtotal_ex, 2)
        )
      ) NOT VALID;
  END IF;
END
$$;

ALTER TABLE public.trade_invoice_lines
  ADD COLUMN IF NOT EXISTS source_work_order_id uuid,
  ADD COLUMN IF NOT EXISTS source_trade_invoice_line_id uuid,
  ADD COLUMN IF NOT EXISTS deduction_user_id uuid,
  ADD COLUMN IF NOT EXISTS deduction_assignment_id uuid,
  ADD COLUMN IF NOT EXISTS deduction_trade_rate_id uuid,
  ADD COLUMN IF NOT EXISTS site_address text,
  ADD COLUMN IF NOT EXISTS line_position integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trade_invoice_lines'::regclass
      AND conname = 'trade_invoice_lines_source_work_order_fk'
  ) THEN
    ALTER TABLE public.trade_invoice_lines
      ADD CONSTRAINT trade_invoice_lines_source_work_order_fk
      FOREIGN KEY (source_work_order_id) REFERENCES public.work_orders(id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trade_invoice_lines'::regclass
      AND conname = 'trade_invoice_lines_source_trade_line_fk'
  ) THEN
    ALTER TABLE public.trade_invoice_lines
      ADD CONSTRAINT trade_invoice_lines_source_trade_line_fk
      FOREIGN KEY (source_trade_invoice_line_id) REFERENCES public.trade_invoice_lines(id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trade_invoice_lines'::regclass
      AND conname = 'trade_invoice_lines_deduction_user_fk'
  ) THEN
    ALTER TABLE public.trade_invoice_lines
      ADD CONSTRAINT trade_invoice_lines_deduction_user_fk
      FOREIGN KEY (deduction_user_id) REFERENCES public.users(id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trade_invoice_lines'::regclass
      AND conname = 'trade_invoice_lines_deduction_assignment_fk'
  ) THEN
    ALTER TABLE public.trade_invoice_lines
      ADD CONSTRAINT trade_invoice_lines_deduction_assignment_fk
      FOREIGN KEY (deduction_assignment_id) REFERENCES public.job_assignments(id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trade_invoice_lines'::regclass
      AND conname = 'trade_invoice_lines_deduction_trade_rate_fk'
  ) THEN
    ALTER TABLE public.trade_invoice_lines
      ADD CONSTRAINT trade_invoice_lines_deduction_trade_rate_fk
      FOREIGN KEY (deduction_trade_rate_id) REFERENCES public.trade_rates(id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trade_invoice_lines'::regclass
      AND conname = 'trade_invoice_lines_typed_deduction_sign_check'
  ) THEN
    ALTER TABLE public.trade_invoice_lines
      ADD CONSTRAINT trade_invoice_lines_typed_deduction_sign_check CHECK (
        line_type NOT IN (
          'crew_work_order_deduction',
          'labour_deduction',
          'travel_logistics_deduction',
          'materials_deduction',
          'final_payout_deduction'
        )
        OR line_total_ex < 0
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trade_invoice_lines'::regclass
      AND conname = 'trade_invoice_lines_final_deduction_scope_check'
  ) THEN
    ALTER TABLE public.trade_invoice_lines
      ADD CONSTRAINT trade_invoice_lines_final_deduction_scope_check CHECK (
        line_type <> 'final_payout_deduction'
        OR (
          job_id IS NULL
          AND job_number IS NULL
          AND source_work_order_id IS NULL
          AND source_trade_invoice_line_id IS NULL
          AND deduction_user_id IS NULL
          AND deduction_assignment_id IS NULL
          AND deduction_trade_rate_id IS NULL
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trade_invoice_lines'::regclass
      AND conname = 'trade_invoice_lines_line_position_check'
  ) THEN
    ALTER TABLE public.trade_invoice_lines
      ADD CONSTRAINT trade_invoice_lines_line_position_check CHECK (
        line_position IS NULL OR line_position >= 0
      ) NOT VALID;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_trade_invoice_lines_source_work_order
  ON public.trade_invoice_lines(source_work_order_id)
  WHERE source_work_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trade_invoice_lines_source_trade_line
  ON public.trade_invoice_lines(source_trade_invoice_line_id)
  WHERE source_trade_invoice_line_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trade_invoice_lines_deduction_user
  ON public.trade_invoice_lines(deduction_user_id)
  WHERE deduction_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trade_invoice_lines_deduction_assignment
  ON public.trade_invoice_lines(deduction_assignment_id)
  WHERE deduction_assignment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trade_invoice_lines_deduction_trade_rate
  ON public.trade_invoice_lines(deduction_trade_rate_id)
  WHERE deduction_trade_rate_id IS NOT NULL;

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
CREATE OR REPLACE FUNCTION public.persist_trade_work_order_invoice_v1(
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
  v_work_order_id uuid;
  v_job_id uuid;
  v_prior_draft_id uuid;
  v_prior_xero_bill_id text;
  v_prior_xero_pushed_at timestamptz;
  v_draft_count integer;
  v_deleted_count integer;
  v_line_sum numeric(12,2);
BEGIN
  IF p_invoice IS NULL
     OR p_lines IS NULL
     OR jsonb_typeof(p_invoice) <> 'object'
     OR jsonb_typeof(p_lines) <> 'array'
     OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'work-order invoice requires one header object and at least one line'
      USING ERRCODE = '22023';
  END IF;

  v_org_id := NULLIF(p_invoice->>'org_id', '')::uuid;
  v_user_id := NULLIF(p_invoice->>'user_id', '')::uuid;
  v_work_order_id := NULLIF(p_invoice->>'work_order_id', '')::uuid;
  IF v_org_id IS NULL
     OR v_user_id IS NULL
     OR v_work_order_id IS NULL
     OR p_invoice->>'invoice_source' <> 'work_order'
     OR p_invoice->>'status' <> 'draft' THEN
    RAISE EXCEPTION 'invalid work-order invoice persistence identity'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('weekly-trade-invoice:' || v_org_id::text, 0)
  );

  SELECT job_id
  INTO v_job_id
  FROM public.work_orders
  WHERE id = v_work_order_id
    AND org_id = v_org_id
  FOR SHARE;
  IF v_job_id IS NULL
     OR v_job_id IS DISTINCT FROM NULLIF(p_invoice->>'job_id', '')::uuid THEN
    RAISE EXCEPTION 'work-order invoice source does not belong to the requested tenant and job'
      USING ERRCODE = '23503';
  END IF;

  SELECT count(*)
  INTO v_draft_count
  FROM public.trade_invoices
  WHERE org_id = v_org_id
    AND work_order_id = v_work_order_id
    AND status = 'draft';
  IF v_draft_count > 1 THEN
    RAISE EXCEPTION 'multiple work-order drafts need office review before replacement'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id, xero_bill_id, xero_pushed_at
  INTO v_prior_draft_id, v_prior_xero_bill_id, v_prior_xero_pushed_at
  FROM public.trade_invoices
  WHERE org_id = v_org_id
    AND work_order_id = v_work_order_id
    AND status = 'draft'
  ORDER BY created_at, id
  LIMIT 1
  FOR UPDATE;

  IF p_requested_prior_draft_id IS DISTINCT FROM v_prior_draft_id THEN
    RAISE EXCEPTION 'selected work-order draft is no longer replaceable'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_prior_draft_id IS NOT NULL
     AND (v_prior_xero_bill_id IS NOT NULL OR v_prior_xero_pushed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'work-order draft has an external Xero identity'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.trade_invoices parent
    WHERE parent.org_id = v_org_id
      AND parent.work_order_id = v_work_order_id
      AND parent.id IS DISTINCT FROM v_prior_draft_id
      AND (parent.status IS NULL OR parent.status NOT IN ('ops-reject', 'failed'))
  ) OR EXISTS (
    SELECT 1
    FROM public.trade_invoice_lines existing
    JOIN public.trade_invoices parent
      ON parent.id = existing.trade_invoice_id
    WHERE existing.source_work_order_id = v_work_order_id
      AND parent.id IS DISTINCT FROM v_prior_draft_id
      AND (parent.status IS NULL OR parent.status NOT IN ('ops-reject', 'failed'))
  ) THEN
    RAISE EXCEPTION 'work order is already held by another invoice'
      USING ERRCODE = '23505';
  END IF;

  SELECT round(COALESCE(sum((line->>'line_total_ex')::numeric), 0), 2)
  INTO v_line_sum
  FROM jsonb_array_elements(p_lines) AS input(line);
  IF v_line_sum <= 0
     OR v_line_sum <> round((p_invoice->>'subtotal_ex')::numeric, 2)
     OR v_line_sum <> round((p_invoice->>'gross_earned')::numeric, 2) THEN
    RAISE EXCEPTION 'work-order invoice header does not equal its server-resolved lines'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_lines) AS input(line)
    WHERE NULLIF(input.line->>'job_id', '')::uuid IS DISTINCT FROM v_job_id
  ) THEN
    RAISE EXCEPTION 'work-order invoice line does not belong to its source job'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
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

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_lines) AS input(line)
    LEFT JOIN public.trade_invoice_lines source_line
      ON source_line.id = NULLIF(input.line->>'source_trade_invoice_line_id', '')::uuid
    LEFT JOIN public.trade_invoices source_invoice
      ON source_invoice.id = source_line.trade_invoice_id
    WHERE NULLIF(input.line->>'source_trade_invoice_line_id', '') IS NOT NULL
      AND (
        input.line->>'line_type' IS DISTINCT FROM 'crew_work_order_deduction'
        OR source_line.id IS NULL
        OR source_line.job_id IS DISTINCT FROM v_job_id
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
    RAISE EXCEPTION 'work-order invoice contains an invalid crew-charge source'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
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

  INSERT INTO public.trade_invoices (
    org_id, user_id, work_order_id, invoice_source,
    subtotal_ex, gst, total_inc, gst_on, super_rate, super_amount,
    gross_earned, net_pay, has_manual_overrides, override_details,
    submitted_at, status
  ) VALUES (
    v_org_id,
    v_user_id,
    v_work_order_id,
    'work_order',
    (p_invoice->>'subtotal_ex')::numeric,
    (p_invoice->>'gst')::numeric,
    (p_invoice->>'total_inc')::numeric,
    (p_invoice->>'gst_on')::boolean,
    (p_invoice->>'super_rate')::numeric,
    (p_invoice->>'super_amount')::numeric,
    (p_invoice->>'gross_earned')::numeric,
    (p_invoice->>'net_pay')::numeric,
    COALESCE((p_invoice->>'has_manual_overrides')::boolean, false),
    CASE WHEN jsonb_typeof(p_invoice->'override_details') = 'object'
      THEN p_invoice->'override_details' ELSE NULL END,
    NULLIF(p_invoice->>'submitted_at', '')::timestamptz,
    'draft'
  )
  RETURNING id INTO v_invoice_id;

  INSERT INTO public.trade_invoice_lines (
    trade_invoice_id, job_id, job_number, client_name, total_hours,
    hourly_rate, line_total_ex, acknowledgment_status, line_type,
    description, quantity, unit, unit_rate, line_date, division,
    site_address, source_trade_invoice_line_id, line_position
  )
  SELECT
    v_invoice_id,
    NULLIF(line->>'job_id', '')::uuid,
    NULLIF(line->>'job_number', ''),
    NULLIF(line->>'client_name', ''),
    NULLIF(line->>'total_hours', '')::numeric,
    NULLIF(line->>'hourly_rate', '')::numeric,
    (line->>'line_total_ex')::numeric,
    'pending',
    NULLIF(line->>'line_type', ''),
    NULLIF(line->>'description', ''),
    NULLIF(line->>'quantity', '')::numeric,
    NULLIF(line->>'unit', ''),
    NULLIF(line->>'unit_rate', '')::numeric,
    NULLIF(line->>'line_date', '')::date,
    NULLIF(line->>'division', ''),
    NULLIF(line->>'site_address', ''),
    NULLIF(line->>'source_trade_invoice_line_id', '')::uuid,
    COALESCE(NULLIF(line->>'line_position', '')::integer, ordinality::integer - 1)
  FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS input(line, ordinality);

  IF v_prior_draft_id IS NOT NULL THEN
    DELETE FROM public.trade_invoices
    WHERE id = v_prior_draft_id;
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    IF v_deleted_count <> 1 THEN
      RAISE EXCEPTION 'work-order draft changed before replacement'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN v_invoice_id;
END;
$$;

REVOKE ALL ON FUNCTION public.persist_trade_work_order_invoice_v1(jsonb, jsonb, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_trade_work_order_invoice_v1(jsonb, jsonb, uuid)
  TO service_role;

COMMENT ON FUNCTION public.persist_trade_work_order_invoice_v1(jsonb, jsonb, uuid) IS
  'Atomically serializes single-work-order and weekly source claims before any Xero work can start.';

-- Weekly invoice persistence shares the same organization transaction lock.
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
  v_status text;
  v_prior_draft_id uuid;
  v_prior_xero_bill_id text;
  v_prior_xero_pushed_at timestamptz;
  v_draft_count integer;
  v_deleted_count integer;
  v_line_sum numeric(12,2);
  v_job_grand_total numeric(12,2);
  v_final_deductions_total numeric(12,2);
BEGIN
  IF p_invoice IS NULL
     OR p_lines IS NULL
     OR jsonb_typeof(p_invoice) <> 'object'
     OR jsonb_typeof(p_lines) <> 'array'
     OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'weekly invoice requires one header object and at least one line'
      USING ERRCODE = '22023';
  END IF;

  v_org_id := NULLIF(p_invoice->>'org_id', '')::uuid;
  v_user_id := NULLIF(p_invoice->>'user_id', '')::uuid;
  v_week_start := NULLIF(p_invoice->>'week_start', '')::date;
  v_status := NULLIF(p_invoice->>'status', '');
  IF v_org_id IS NULL
     OR v_user_id IS NULL
     OR v_week_start IS NULL
     OR p_invoice->>'invoice_source' <> 'weekly_work_order'
     OR v_status NOT IN ('draft', 'pending_acknowledgment') THEN
    RAISE EXCEPTION 'invalid weekly invoice persistence identity'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('weekly-trade-invoice:' || v_org_id::text, 0)
  );

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

  IF p_requested_prior_draft_id IS NOT NULL
     AND p_requested_prior_draft_id IS DISTINCT FROM v_prior_draft_id THEN
    RAISE EXCEPTION 'selected weekly draft is no longer replaceable'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_prior_draft_id IS NOT NULL
     AND (v_prior_xero_bill_id IS NOT NULL OR v_prior_xero_pushed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'weekly draft has an external Xero identity'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT
    round(COALESCE(sum((line->>'line_total_ex')::numeric), 0), 2),
    round(COALESCE(sum(
      CASE WHEN line->>'line_type' <> 'final_payout_deduction'
        THEN (line->>'line_total_ex')::numeric ELSE 0 END
    ), 0), 2),
    round(COALESCE(-sum(
      CASE WHEN line->>'line_type' = 'final_payout_deduction'
        THEN (line->>'line_total_ex')::numeric ELSE 0 END
    ), 0), 2)
  INTO v_line_sum, v_job_grand_total, v_final_deductions_total
  FROM jsonb_array_elements(p_lines) AS input(line);

  IF v_line_sum <> round((p_invoice->>'subtotal_ex')::numeric, 2)
     OR v_job_grand_total <> round((p_invoice->>'job_grand_total_ex')::numeric, 2)
     OR v_final_deductions_total <> round((p_invoice->>'final_deductions_total_ex')::numeric, 2)
     OR v_line_sum <> round((p_invoice->>'to_be_paid_ex')::numeric, 2) THEN
    RAISE EXCEPTION 'weekly invoice header does not equal its server-resolved lines'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_lines) AS input(line)
    LEFT JOIN public.work_orders wo
      ON wo.id = NULLIF(input.line->>'source_work_order_id', '')::uuid
    WHERE NULLIF(input.line->>'source_work_order_id', '') IS NOT NULL
      AND (
        wo.id IS NULL
        OR wo.org_id <> v_org_id
        OR wo.job_id IS DISTINCT FROM NULLIF(input.line->>'job_id', '')::uuid
      )
  ) THEN
    RAISE EXCEPTION 'weekly invoice contains an invalid work-order source'
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
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
      AND parent.status NOT IN ('ops-reject', 'failed')
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
      AND parent.status NOT IN ('ops-reject', 'failed')
  ) THEN
    RAISE EXCEPTION 'a weekly work order is already held by another invoice'
      USING ERRCODE = '23505';
  END IF;

  IF EXISTS (
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

  IF EXISTS (
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

  IF EXISTS (
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
      AND parent.status NOT IN ('ops-reject', 'failed')
  ) THEN
    RAISE EXCEPTION 'a crew charge is already held by another invoice'
      USING ERRCODE = '23505';
  END IF;

  IF EXISTS (
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
        OR COALESCE(wo.completed_at::date, wo.scheduled_date) IS NULL
        OR rate.effective_from > COALESCE(wo.completed_at::date, wo.scheduled_date)
        OR (
          rate.effective_to IS NOT NULL
          AND rate.effective_to < COALESCE(wo.completed_at::date, wo.scheduled_date)
        )
        OR round(-rate.hourly_rate, 2) <> round((input.line->>'unit_rate')::numeric, 2)
        OR round((input.line->>'quantity')::numeric * -rate.hourly_rate, 2)
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
    'weekly_work_order',
    (p_invoice->>'job_grand_total_ex')::numeric,
    (p_invoice->>'final_deductions_total_ex')::numeric,
    (p_invoice->>'to_be_paid_ex')::numeric,
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
    site_address, source_work_order_id, source_trade_invoice_line_id,
    deduction_user_id, deduction_assignment_id, deduction_trade_rate_id,
    line_position
  )
  SELECT
    v_invoice_id,
    NULLIF(line->>'job_id', '')::uuid,
    NULLIF(line->>'job_number', ''),
    NULLIF(line->>'client_name', ''),
    NULLIF(line->>'total_hours', '')::numeric,
    NULLIF(line->>'hourly_rate', '')::numeric,
    (line->>'line_total_ex')::numeric,
    'pending',
    NULLIF(line->>'line_type', ''),
    NULLIF(line->>'description', ''),
    NULLIF(line->>'quantity', '')::numeric,
    NULLIF(line->>'unit', ''),
    NULLIF(line->>'unit_rate', '')::numeric,
    NULLIF(line->>'line_date', '')::date,
    NULLIF(line->>'division', ''),
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
    SET invoiced_in = NULL
    WHERE invoiced_in = v_prior_draft_id;

    DELETE FROM public.trade_invoices
    WHERE id = v_prior_draft_id;
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    IF v_deleted_count <> 1 THEN
      RAISE EXCEPTION 'weekly draft changed before replacement'
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
  'Atomically serializes weekly invoice source claims, validates server-resolved line sums and provenance, inserts the complete replacement, and only then removes a prior draft.';

-- Preserve existing source values and add the weekly multi-work-order shape.
-- Refuse an unexpected same-name definition instead of replacing it blindly.
DO $$
DECLARE
  source_check_definition text;
BEGIN
  SELECT pg_get_constraintdef(oid)
  INTO source_check_definition
  FROM pg_constraint
  WHERE conrelid = 'public.trade_invoices'::regclass
    AND conname = 'trade_invoices_invoice_source_check';

  IF source_check_definition IS NULL THEN
    ALTER TABLE public.trade_invoices
      ADD CONSTRAINT trade_invoices_invoice_source_check CHECK (
        invoice_source IN ('hourly', 'work_order', 'weekly_work_order', 'per_metre', 'misc')
      ) NOT VALID;
  ELSIF source_check_definition LIKE '%weekly_work_order%' THEN
    NULL;
  ELSIF source_check_definition LIKE '%hourly%'
    AND source_check_definition LIKE '%work_order%'
    AND source_check_definition LIKE '%per_metre%'
    AND source_check_definition LIKE '%misc%'
  THEN
    ALTER TABLE public.trade_invoices
      DROP CONSTRAINT trade_invoices_invoice_source_check;
    ALTER TABLE public.trade_invoices
      ADD CONSTRAINT trade_invoices_invoice_source_check CHECK (
        invoice_source IN ('hourly', 'work_order', 'weekly_work_order', 'per_metre', 'misc')
      ) NOT VALID;
  ELSE
    RAISE EXCEPTION
      'Unexpected trade_invoices_invoice_source_check definition; refusing replacement: %',
      source_check_definition;
  END IF;
END
$$;

-- Keep typed job deductions in the canonical cost lane. The final payout
-- deduction deliberately has no job identity and remains unresolved/non-job.
CREATE OR REPLACE VIEW public.v_trade_charge_resolved AS
WITH line_base AS (
  SELECT
    til.*,
    NULLIF(BTRIM(til.job_number), '') AS line_job_number,
    NULLIF(
      substring(
        UPPER(COALESCE(til.description, ''))
        FROM '(SWMS-[0-9]+|SWG-[0-9]+|SWF-[0-9]+|SWP-[0-9]+|BWCWA[0-9]+|AJBR-[0-9]+|MLB-[0-9]+)'
      ),
      ''
    ) AS description_job_number,
    (
      COALESCE(til.description, '') ILIKE '%QA TEST%'
      OR COALESCE(til.description, '') ILIKE '%make-safe hours - delete%'
      OR COALESCE(til.description, '') ILIKE '%makesafe hours - delete%'
    ) AS is_probable_test_line
  FROM public.trade_invoice_lines til
)
SELECT
  lb.id AS line_id,
  COALESCE(j_direct.id, j_line.id, j_desc.id) AS resolved_job_id,
  (j_direct.id IS NOT NULL) AS attributed_direct,
  ti.id AS trade_invoice_id,
  ti.user_id,
  ti.week_start,
  ti.status AS invoice_status,
  ti.xero_bill_id,
  lb.line_type,
  lb.description,
  lb.total_hours,
  lb.hourly_rate,
  lb.line_total_ex,
  lb.line_date,
  lb.division,
  CASE
    WHEN lb.line_type IN (
      'labour', 'fencing', 'patio', 'make safe', 'general labour',
      'crew_work_order_deduction', 'labour_deduction'
    ) THEN 'labour'
    WHEN lb.line_type IN ('materials', 'materials_deduction') THEN 'materials'
    WHEN lb.line_type = 'commission' THEN 'commission'
    WHEN lb.line_type IN (
      'travel', 'equipment', 'other', 'travel_logistics_deduction'
    ) THEN 'other'
    ELSE 'unclassified'
  END AS cost_lane,
  CASE
    WHEN j_direct.id IS NOT NULL THEN 'job_id'
    WHEN j_line.id IS NOT NULL THEN 'line_job_number'
    WHEN j_desc.id IS NOT NULL THEN 'description_job_number'
    ELSE 'unresolved'
  END AS match_method,
  lb.is_probable_test_line,
  CASE
    WHEN lb.is_probable_test_line THEN 'qa_or_delete_test_line'
    ELSE NULL
  END AS exclusion_reason,
  lb.flag_type,
  lb.baseline_hours,
  lb.baseline_source,
  lb.hours_justification,
  lb.flagged_at,
  (lb.flag_type IS NOT NULL) AS is_hours_flagged
FROM line_base lb
JOIN public.trade_invoices ti ON ti.id = lb.trade_invoice_id
LEFT JOIN public.jobs j_direct
  ON j_direct.id = lb.job_id
 AND j_direct.org_id = ti.org_id
LEFT JOIN public.jobs j_line
  ON j_line.job_number = lb.line_job_number
 AND j_line.org_id = ti.org_id
 AND j_direct.id IS NULL
LEFT JOIN public.jobs j_desc
  ON j_desc.job_number = lb.description_job_number
 AND j_desc.org_id = ti.org_id
 AND j_direct.id IS NULL
 AND j_line.id IS NULL;

COMMENT ON VIEW public.v_trade_charge_resolved IS
  'Canonical trade-cost resolver with hours-flag facts and weekly typed deduction lanes. Final payout deductions stay non-job/unresolved.';

REVOKE ALL ON public.v_trade_charge_resolved FROM anon, authenticated;
GRANT SELECT ON public.v_trade_charge_resolved TO service_role, postgres;
