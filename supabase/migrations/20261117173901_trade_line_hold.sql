-- P1-05.6. Storage only: existing sends and Xero callers are unchanged.
-- The earlier gap-reader migration owns hold_reason and held_at.
INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('trade_line_hold_v1', false,
  'A trade can always send their week. A line that is not backed is held for the office with one reason, line by line; backed lines are paid in the run.')
ON CONFLICT (flag_name) DO NOTHING;

ALTER TABLE public.trade_invoices
  ADD COLUMN IF NOT EXISTS invoice_kind text NOT NULL DEFAULT 'standard'
    CHECK (invoice_kind IN ('standard','held','follow_on')),
  ADD COLUMN IF NOT EXISTS send_id uuid,
  ADD COLUMN IF NOT EXISTS follows_invoice_id uuid REFERENCES public.trade_invoices(id);
CREATE INDEX IF NOT EXISTS trade_invoices_send_idx
  ON public.trade_invoices (send_id) WHERE send_id IS NOT NULL;

-- Held invoice headers carry no payable money or Xero binding. The line owns
-- the claimed amount. NOT VALID avoids scanning historical invoices at merge;
-- new and updated rows are checked, and standard invoices are unchanged.
ALTER TABLE public.trade_invoices
  ADD CONSTRAINT trade_invoices_held_money_check CHECK (
    invoice_kind <> 'held' OR (
      coalesce(subtotal_ex, 0) = 0 AND coalesce(gst, 0) = 0
      AND coalesce(total_inc, 0) = 0 AND coalesce(gross_earned, 0) = 0
      AND coalesce(super_amount, 0) = 0 AND coalesce(net_pay, 0) = 0
      AND coalesce(super_base_ex, 0) = 0
      AND coalesce(job_grand_total_ex, 0) = 0
      AND coalesce(final_deductions_total_ex, 0) = 0
      AND coalesce(to_be_paid_ex, 0) = 0
      AND coalesce(recurring_deduction_amount, 0) = 0
      AND xero_bill_id IS NULL AND xero_pushed_at IS NULL
    )
  ) NOT VALID;

ALTER TABLE public.trade_invoice_lines
  ADD COLUMN IF NOT EXISTS hold_reason text,
  ADD COLUMN IF NOT EXISTS hold_detail jsonb,
  ADD COLUMN IF NOT EXISTS held_at timestamptz,
  ADD COLUMN IF NOT EXISTS decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS sent_amount_ex numeric(12,2),
  ADD COLUMN IF NOT EXISTS sent_values jsonb,
  ADD COLUMN IF NOT EXISTS office_change_reason text,
  ADD COLUMN IF NOT EXISTS split_group_id uuid,
  ADD COLUMN IF NOT EXISTS not_job_work_type_id uuid;
ALTER TABLE public.trade_invoice_lines
  ADD CONSTRAINT trade_invoice_lines_hold_reason_check CHECK (
    hold_reason IS NULL OR hold_reason IN (
      'no_work_order','no_amount','over_amount','hourly_no_maximum','no_job',
      'not_job_work','reimbursement','not_on_crew','commission_no_figure','rate_above_rule'
    )
  ) NOT VALID,
  ADD CONSTRAINT trade_invoice_lines_hold_status_check
    CHECK (hold_reason IS NULL OR office_review_status IS NOT NULL) NOT VALID;
CREATE INDEX IF NOT EXISTS trade_invoice_lines_held_idx
  ON public.trade_invoice_lines (held_at)
  WHERE hold_reason IS NOT NULL AND office_review_status IN ('awaiting','queried');

CREATE TABLE public.not_job_work_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 60),
  division text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, label)
);
ALTER TABLE public.trade_invoice_lines
  ADD CONSTRAINT trade_invoice_lines_not_job_work_type_fkey
  FOREIGN KEY (not_job_work_type_id) REFERENCES public.not_job_work_types(id) NOT VALID;

CREATE TABLE public.trade_held_line_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id uuid NOT NULL REFERENCES public.trade_invoice_lines(id),
  user_id uuid NOT NULL,
  from_office boolean NOT NULL DEFAULT false,
  note text,
  storage_path text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (note IS NOT NULL OR storage_path IS NOT NULL)
);

ALTER TABLE public.not_job_work_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_held_line_notes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.not_job_work_types, public.trade_held_line_notes
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.not_job_work_types, public.trade_held_line_notes TO service_role;
GRANT UPDATE (active, label) ON public.not_job_work_types TO service_role;
CREATE POLICY not_job_work_types_service_select ON public.not_job_work_types
  FOR SELECT TO service_role USING (true);
CREATE POLICY not_job_work_types_service_insert ON public.not_job_work_types
  FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY not_job_work_types_service_update ON public.not_job_work_types
  FOR UPDATE TO service_role USING (true) WITH CHECK (true);
CREATE POLICY trade_held_line_notes_service_select ON public.trade_held_line_notes
  FOR SELECT TO service_role USING (true);
CREATE POLICY trade_held_line_notes_service_insert ON public.trade_held_line_notes
  FOR INSERT TO service_role WITH CHECK (true);

CREATE FUNCTION public.trade_held_line_notes_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$ BEGIN
  RAISE EXCEPTION 'held pay line notes are append-only' USING ERRCODE = '55000';
END $$;
REVOKE ALL ON FUNCTION public.trade_held_line_notes_append_only() FROM PUBLIC, anon, authenticated, service_role;

-- Owner-only installation, never called by the migration or a browser role.
CREATE FUNCTION public.install_trade_line_hold() RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.trade_held_line_notes'::regclass
      AND tgname = 'trade_held_line_notes_append_only' AND NOT tgisinternal) THEN
    CREATE TRIGGER trade_held_line_notes_append_only
      BEFORE UPDATE OR DELETE ON public.trade_held_line_notes
      FOR EACH ROW EXECUTE FUNCTION public.trade_held_line_notes_append_only();
  END IF;
END $$;
CREATE FUNCTION public.remove_trade_line_hold() RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$ BEGIN
  DROP TRIGGER IF EXISTS trade_held_line_notes_append_only ON public.trade_held_line_notes;
END $$;
REVOKE ALL ON FUNCTION public.install_trade_line_hold(), public.remove_trade_line_hold()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.trade_send_totals(p_send_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  -- trade_invoices_send_idx finds one send; idx_inv_lines_invoice finds its lines.
  WITH totals AS (
    SELECT coalesce(sum(l.sent_amount_ex), 0) AS sent_ex,
      coalesce(sum(l.line_total_ex) FILTER (
        WHERE i.invoice_kind IN ('standard','follow_on')), 0) AS in_pay_ex,
      coalesce(sum(l.line_total_ex) FILTER (
        WHERE i.invoice_kind = 'held' AND l.office_review_status IN ('awaiting','queried')), 0) AS held_ex,
      coalesce(sum(l.sent_amount_ex) FILTER (
        WHERE i.invoice_kind = 'held' AND l.office_review_status = 'rejected'), 0)
      + coalesce(sum(l.sent_amount_ex - l.line_total_ex) FILTER (
        WHERE i.invoice_kind = 'follow_on'), 0) AS declined_ex
    FROM public.trade_invoices i
    JOIN public.trade_invoice_lines l ON l.trade_invoice_id = i.id
    WHERE i.send_id = p_send_id
  )
  SELECT jsonb_build_object(
    'sent_ex', sent_ex, 'in_pay_ex', in_pay_ex, 'held_ex', held_ex,
    'declined_ex', declined_ex,
    'balanced', sent_ex = in_pay_ex + held_ex + declined_ex
  ) FROM totals;
$$;
REVOKE ALL ON FUNCTION public.trade_send_totals(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trade_send_totals(uuid) TO service_role;
