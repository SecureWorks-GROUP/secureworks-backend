-- P2-01.1: empty, service-only cost lines and their conserved allocations.
-- No source sync, reader cutover, decision foreign key, or historical writes.

CREATE TABLE IF NOT EXISTS public.job_cost_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('supplier_bill', 'installer_bill', 'trade_line', 'group_share',
    'commission', 'reimbursement', 'supplier_credit', 'receipt', 'bank_spend', 'employer_super')),
  document_kind text NOT NULL CHECK (document_kind IN ('xero_bill', 'trade_invoice',
    'xero_credit_note', 'expense_receipt', 'xero_bank_txn')),
  document_id text NOT NULL,
  line_key text NOT NULL,
  line_no int,
  document_number text,
  document_date date,
  document_status text,
  party_kind text,
  party_id text,
  party_name text,
  description text,
  account_code text,
  xero_tracking_option text,
  lane text NOT NULL,
  amount_ex numeric(12,2),
  gst numeric(12,2),
  paid boolean,
  paid_on date,
  is_actual boolean NOT NULL DEFAULT true,
  hours numeric,
  business_unit text,
  incomplete_invoice boolean NOT NULL DEFAULT false,
  state text CHECK (state IN ('on_job', 'split', 'overhead', 'division_stock', 'needs_person')),
  needs_reason text,
  not_counted_reason text CHECK (not_counted_reason IN ('document_not_live', 'line_removed',
    'duplicate_document', 'duplicate_of_trade_invoice', 'counted_by_bank_line', 'counted_by_trade_invoice')),
  covered_by_line_id uuid REFERENCES public.job_cost_lines(id),
  follows_line_id uuid REFERENCES public.job_cost_lines(id),
  follows_document_kind text,
  follows_document_id text,
  order_kind text CHECK (order_kind IN ('purchase_order', 'dispatch_order')),
  order_id text,
  decision_id bigint,
  decided_by_kind text CHECK (decided_by_kind IN ('person', 'matcher', 'source', 'legacy')),
  event_source text,
  event_source_id text,
  event_match_method text,
  event_confidence text,
  event_lane_detail text,
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  state_changed_at timestamptz,
  UNIQUE (org_id, document_kind, document_id, line_key),
  CHECK ((state IS NULL) = (not_counted_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS job_cost_lines_document_idx
  ON public.job_cost_lines (document_kind, document_id);
CREATE INDEX IF NOT EXISTS job_cost_lines_needs_person_idx
  ON public.job_cost_lines (state) WHERE state = 'needs_person';
CREATE INDEX IF NOT EXISTS job_cost_lines_follows_document_idx
  ON public.job_cost_lines (follows_document_kind, follows_document_id);
CREATE INDEX IF NOT EXISTS job_cost_lines_order_idx
  ON public.job_cost_lines (order_kind, order_id) WHERE order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.job_cost_line_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id uuid NOT NULL REFERENCES public.job_cost_lines(id) ON DELETE CASCADE,
  part_no int NOT NULL,
  target text NOT NULL CHECK (target IN ('job', 'overhead', 'division_stock')),
  job_id uuid REFERENCES public.jobs(id),
  division text CHECK (division IN ('patios', 'fencing', 'insurance')),
  lane text NOT NULL,
  amount_ex numeric(12,2) NOT NULL,
  UNIQUE (line_id, part_no),
  CHECK ((target = 'job') = (job_id IS NOT NULL)),
  CHECK ((target = 'division_stock') = (division IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS job_cost_line_parts_job_idx
  ON public.job_cost_line_parts (job_id) WHERE job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.job_cost_lines_parts_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  affected_ids uuid[] := '{}';
  affected_id uuid;
  cost_line public.job_cost_lines%ROWTYPE;
  part_count bigint;
  part_total numeric;
  only_target text;
  conserved boolean;
BEGIN
  IF TG_TABLE_NAME = 'job_cost_lines' THEN
    IF TG_OP <> 'INSERT' THEN affected_ids := array_append(affected_ids, OLD.id); END IF;
    IF TG_OP <> 'DELETE' THEN affected_ids := array_append(affected_ids, NEW.id); END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN affected_ids := array_append(affected_ids, OLD.line_id); END IF;
    IF TG_OP <> 'DELETE' THEN affected_ids := array_append(affected_ids, NEW.line_id); END IF;
  END IF;

  -- A part can move: validate both parents, once each, in stable lock order.
  FOR affected_id IN SELECT DISTINCT u.id FROM unnest(affected_ids) AS u(id) ORDER BY u.id LOOP
    IF TG_TABLE_NAME = 'job_cost_line_parts' THEN
      -- A row version, not just a row lock, serializes disjoint part edits
      -- under repeatable read too. Keep every stored fact unchanged. The
      -- queued line trigger only reads, so this cannot recurse into writes.
      UPDATE public.job_cost_lines l SET updated_at = l.updated_at
        WHERE l.id = affected_id RETURNING l.* INTO cost_line;
    ELSE
      SELECT l.* INTO cost_line FROM public.job_cost_lines l
        WHERE l.id = affected_id FOR UPDATE;
    END IF;
    -- Parent deletion cascades parts; no allocation remains to conserve.
    IF NOT FOUND THEN CONTINUE; END IF;

    SELECT count(*), sum(p.amount_ex), min(p.target)
      INTO part_count, part_total, only_target
      FROM public.job_cost_line_parts p WHERE p.line_id = affected_id;

    conserved := CASE
      WHEN cost_line.state IS NULL OR cost_line.state = 'needs_person' THEN part_count = 0
      WHEN cost_line.amount_ex IS NULL THEN false
      WHEN cost_line.state = 'split' THEN part_count >= 2 AND part_total = cost_line.amount_ex
      WHEN cost_line.state = 'on_job' THEN
        part_count = 1 AND only_target = 'job' AND part_total = cost_line.amount_ex
      WHEN cost_line.state = 'overhead' THEN
        part_count = 1 AND only_target = 'overhead' AND part_total = cost_line.amount_ex
      WHEN cost_line.state = 'division_stock' THEN
        part_count = 1 AND only_target = 'division_stock' AND part_total = cost_line.amount_ex
      ELSE false
    END;
    IF conserved IS DISTINCT FROM true THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cost_line_parts_do_not_conserve';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.job_cost_lines_parts_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_cost_lines_parts_check() TO service_role;

DROP TRIGGER IF EXISTS job_cost_lines_parts_conserve ON public.job_cost_lines;
CREATE CONSTRAINT TRIGGER job_cost_lines_parts_conserve
  AFTER INSERT OR UPDATE OR DELETE ON public.job_cost_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.job_cost_lines_parts_check();
DROP TRIGGER IF EXISTS job_cost_line_parts_conserve ON public.job_cost_line_parts;
CREATE CONSTRAINT TRIGGER job_cost_line_parts_conserve
  AFTER INSERT OR UPDATE OR DELETE ON public.job_cost_line_parts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.job_cost_lines_parts_check();

ALTER TABLE public.job_cost_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_cost_line_parts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_cost_lines, public.job_cost_line_parts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_cost_lines, public.job_cost_line_parts TO service_role;
DROP POLICY IF EXISTS job_cost_lines_service ON public.job_cost_lines;
CREATE POLICY job_cost_lines_service ON public.job_cost_lines
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS job_cost_line_parts_service ON public.job_cost_line_parts;
CREATE POLICY job_cost_line_parts_service ON public.job_cost_line_parts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES
  ('job_cost_lines_sync_v1', false, 'Sync cost lines in shadow. Seeded off.'),
  ('job_cost_events_from_cost_lines_v1', false, 'Read cost events from cost lines. Seeded off.')
ON CONFLICT (flag_name) DO NOTHING;
