-- Dispatch S5: partial deliveries. What arrived, per material line, in as many
-- parts as it came.
--
-- Contract: docs/dispatch-partial-deliveries-v1.md. Rules:
-- supabase/functions/ops-api/dispatch_line_receipts.ts. Writes go only through
-- the two ops-api actions dispatch_delivery_record_receipt and
-- dispatch_delivery_void_receipt, each a person's own press.
--
-- 1. job_material_line_receipts: one row per part delivery of one line. Rows
--    are append-only: undo is a void (voided_at, voided_by, voided_by_email set
--    once), never an edit or a delete. A receipt names the order its line sat
--    on when it was written, so CFO and Context can see each part delivery
--    with its own date, purchase order and line.
-- 2. job_material_lines.purchase_order_attached_at: when the line went on its
--    current order, stamped by the database whenever purchase_order_id changes.
--    An order's sighting covers only the lines already on it when it was
--    sighted; a line added to the order afterwards needs its own receipts. Lines
--    already on an order before this migration keep a null stamp and read as
--    slice 6 read them.
--
-- Nothing here writes a line's status or quantity, an order's status,
-- line_items, delivery_confirmed_at, xero_po_id or job_id, jobs or
-- job_dispatch_state. No business_events row, no job_events row, no send.
--
-- Row security on with no policy, revoked from the browser roles (TRUNCATE
-- included), as the other Dispatch private tables are: only ops-api reaches it.
--
-- Rollback: supabase/rollbacks/20261020180000_dispatch_line_receipts_down.sql.

-- 2. The stamp.
ALTER TABLE public.job_material_lines
  ADD COLUMN IF NOT EXISTS purchase_order_attached_at timestamptz NULL;

CREATE OR REPLACE FUNCTION public.dispatch_line_po_attached_stamp() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.purchase_order_attached_at := CASE WHEN NEW.purchase_order_id IS NULL THEN NULL ELSE now() END;
  ELSIF NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id THEN
    NEW.purchase_order_attached_at := CASE WHEN NEW.purchase_order_id IS NULL THEN NULL ELSE now() END;
  ELSE
    -- No writer sets the stamp by hand.
    NEW.purchase_order_attached_at := OLD.purchase_order_attached_at;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.dispatch_line_po_attached_stamp() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_job_material_lines_po_attached ON public.job_material_lines;
CREATE TRIGGER trg_job_material_lines_po_attached
  BEFORE INSERT OR UPDATE ON public.job_material_lines
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_line_po_attached_stamp();

-- 1. The receipts.
CREATE TABLE IF NOT EXISTS public.job_material_line_receipts (
  -- Made in the browser per press (client_receipt_id), so a retried press makes one row.
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id),
  line_id uuid NOT NULL REFERENCES public.job_material_lines(id) ON DELETE RESTRICT,
  purchase_order_id uuid NOT NULL REFERENCES public.purchase_orders(id),
  quantity numeric(12,3) NOT NULL,
  received_on date NOT NULL,
  note text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL REFERENCES public.users(id),
  created_by_email text NOT NULL,
  voided_at timestamptz NULL,
  voided_by uuid NULL REFERENCES public.users(id),
  voided_by_email text NULL,
  CONSTRAINT job_material_line_receipts_quantity_positive CHECK (quantity > 0),
  CONSTRAINT job_material_line_receipts_note_length CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 300),
  CONSTRAINT job_material_line_receipts_created_by_email_present CHECK (char_length(btrim(created_by_email)) > 0),
  -- A void always names a person.
  CONSTRAINT job_material_line_receipts_void_named CHECK ((voided_at IS NULL) = (voided_by_email IS NULL))
);

CREATE INDEX IF NOT EXISTS job_material_line_receipts_job_id_idx
  ON public.job_material_line_receipts (job_id);
CREATE INDEX IF NOT EXISTS job_material_line_receipts_line_id_idx
  ON public.job_material_line_receipts (line_id);
CREATE INDEX IF NOT EXISTS job_material_line_receipts_purchase_order_id_idx
  ON public.job_material_line_receipts (purchase_order_id);

-- On insert: the receipt sits on its line's job and its line's current order,
-- and is not dated after today in Perth. On update: only the void, once.
-- Never a delete.
CREATE OR REPLACE FUNCTION public.dispatch_line_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_line record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT l.job_id, l.org_id, l.purchase_order_id INTO v_line
      FROM public.job_material_lines l WHERE l.id = NEW.line_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'dispatch line receipt: line not found' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_line.job_id IS DISTINCT FROM NEW.job_id OR v_line.org_id IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION 'dispatch line receipt: the receipt must sit on its line''s job' USING ERRCODE = 'check_violation';
    END IF;
    IF v_line.purchase_order_id IS NULL OR v_line.purchase_order_id IS DISTINCT FROM NEW.purchase_order_id THEN
      RAISE EXCEPTION 'dispatch line receipt: the receipt must name its line''s current order' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.received_on > (now() AT TIME ZONE 'Australia/Perth')::date THEN
      RAISE EXCEPTION 'dispatch line receipt: received_on cannot be after today in Perth' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'dispatch line receipt: a receipt is written live' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'dispatch line receipt: a voided receipt never changes' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.voided_at IS NULL
       OR (NEW.id, NEW.org_id, NEW.job_id, NEW.line_id, NEW.purchase_order_id, NEW.quantity, NEW.received_on,
           NEW.note, NEW.created_at, NEW.created_by, NEW.created_by_email)
          IS DISTINCT FROM
          (OLD.id, OLD.org_id, OLD.job_id, OLD.line_id, OLD.purchase_order_id, OLD.quantity, OLD.received_on,
           OLD.note, OLD.created_at, OLD.created_by, OLD.created_by_email) THEN
      RAISE EXCEPTION 'dispatch line receipt: the only change is the void' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'dispatch line receipt: receipts are never deleted; void one instead' USING ERRCODE = 'check_violation';
END $$;
REVOKE ALL ON FUNCTION public.dispatch_line_receipt_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_job_material_line_receipts_guard ON public.job_material_line_receipts;
CREATE TRIGGER trg_job_material_line_receipts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.job_material_line_receipts
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_line_receipt_guard();

COMMENT ON TABLE public.job_material_line_receipts IS
  'Dispatch S5 (docs/dispatch-partial-deliveries-v1.md): one row per part delivery of a material line. Append-only; undo is a void. Written only by ops-api dispatch_delivery_record_receipt / dispatch_delivery_void_receipt.';
COMMENT ON COLUMN public.job_material_lines.purchase_order_attached_at IS
  'Dispatch S5: when the line went on its current purchase order, stamped by trg_job_material_lines_po_attached. An order sighting covers only lines on it at the sighting. Null on lines put on an order before S5.';

ALTER TABLE public.job_material_line_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.job_material_line_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.job_material_line_receipts TO service_role;
