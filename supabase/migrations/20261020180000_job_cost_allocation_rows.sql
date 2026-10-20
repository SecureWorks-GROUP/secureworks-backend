-- Job profit CFO-18 and CFO-20: cost allocation rows and credits.
--
-- Ticket CFO-18 (allocation lines) and CFO-20 (credits), Job Profit project,
-- 20 Oct 2026. Stacks on 20261015190000 (bill pre-match, PR 1063) and
-- 20261019120000 (commitments truthful, PR 1087).
--
-- 1. job_materials_facts becomes the allocation-row table for supplier bills:
--    one bill may carry several rows, one per job (a split). The one-row-per-
--    bill index is replaced by one row per bill and job. A bill's rows plus the
--    part a person marks as overhead must add up to the bill (conserved).
-- 2. materials_reconciliation_queue gains status 'split' and the overhead
--    part (overhead_ex, overhead_note). A split row records who split it.
-- 3. allocate_bill_split(): the only way to split. One transaction: locks the
--    queue row, refuses a trade-app mirror, a voided or deleted bill, a bill
--    already allocated by anyone else, an unknown or holding job, a part of 0
--    or less, or parts plus overhead that do not equal the bill ex GST (to the
--    cent). Writes the rows (automation_source manual_split, high_manual) and
--    closes the queue row. Calling it again with the same parts is a no-op;
--    with different parts it replaces only rows it wrote itself.
-- 4. v_bill_allocation_balance: every bill with allocation rows or overhead,
--    with bill, allocated, overhead and the remainder. Balanced means 0.
-- 5. v_job_cost_events: a bill with an allocation row on any job other than
--    its own xero_invoices.job_id is read through its rows only (so a bill on
--    the holding card that a person splits leaves the holding card). A bill
--    whose rows are all on its own job keeps its line detail, as before. Credit
--    applied in Xero (raw_json AmountCredited) reduces cost in proportion on
--    every line or row of the bill: source supplier_credit, actual, negative.
-- 6. v_job_revenue_events: credit applied in Xero against a live sales invoice
--    reduces invoiced revenue (kind credit_applied, negative, counts as
--    invoiced).
--
-- Review cycle 1 fixes (20 Oct 2026):
--   * A whole-bill row stays one per bill (partial unique index on bills not
--     split), so the ingest's insert-only write is still refused on a second
--     row; the ingest now inserts and treats 23505 as already placed.
--   * A bill is either placed whole or split, never both: a trigger takes a
--     per-bill advisory lock and refuses a mix (23505), and the split function
--     takes the same lock.
--   * A bill with any split row or an overhead part is read through its rows
--     only, even when every row is on the bill's own Xero job.
--   * Credit is credit notes applied (CreditNotes[].AppliedAmount), not
--     prepayments or overpayments.
--   * An installer bill (306 or 301) is labour on every split part, and 301
--     reads as labour in the engine like 306.
--   * A split refuses a cancelled or lost job; a voided or deleted bill is
--     never balanced.
--
-- Both views keep their columns, names and types, so v_job_profit, its
-- functions and every caller keep working. Not applied anywhere until
-- released. Credit notes not applied to any invoice are not in our copy of
-- Xero and stay unknown (named in the job profit read contract).
--
-- Contract: supabase/tests/migration-contracts/20261020180000_job_cost_allocation_rows/.
-- Rollback: supabase/rollbacks/20261020180000_job_cost_allocation_rows_down.sql.

-- ─────────────────────────────────────────────────────────────
-- Credit share: credit notes applied / Total, 0 when unknown. Inc GST over inc
-- GST, so applying it to an ex-GST amount gives the ex-GST credit. Xero's
-- AmountCredited also counts prepayments and overpayments applied, which are
-- payments, not credits: the credit notes list decides when present; without
-- it, AmountCredited less any prepayments and overpayments listed.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.job_cost_credit_share(p_raw jsonb, p_total numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  WITH applied AS (
    SELECT
      (SELECT sum(public.job_profit_num(c.value -> 'AppliedAmount'))
         FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_raw -> 'CreditNotes') = 'array' THEN p_raw -> 'CreditNotes' ELSE '[]'::jsonb END) c
      ) AS credit_notes,
      CASE WHEN jsonb_typeof(p_raw -> 'CreditNotes') = 'array'
           THEN jsonb_array_length(p_raw -> 'CreditNotes') > 0 ELSE false END AS has_credit_notes,
      (SELECT COALESCE(sum(public.job_profit_num(o.value -> 'AppliedAmount')), 0)
         FROM jsonb_array_elements(
           (CASE WHEN jsonb_typeof(p_raw -> 'Prepayments') = 'array' THEN p_raw -> 'Prepayments' ELSE '[]'::jsonb END)
           || (CASE WHEN jsonb_typeof(p_raw -> 'Overpayments') = 'array' THEN p_raw -> 'Overpayments' ELSE '[]'::jsonb END)) o
      ) AS other_applied
  )
  SELECT CASE
    WHEN COALESCE(p_total, 0) <= 0 OR p_raw IS NULL THEN 0
    WHEN a.has_credit_notes THEN least(greatest(COALESCE(a.credit_notes, 0) / p_total, 0), 1)
    WHEN jsonb_typeof(p_raw -> 'AmountCredited') <> 'number' THEN 0
    ELSE least(greatest(((p_raw ->> 'AmountCredited')::numeric - a.other_applied) / p_total, 0), 1)
  END
  FROM applied a
$$;
REVOKE ALL ON FUNCTION public.job_cost_credit_share(jsonb, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_cost_credit_share(jsonb, numeric) TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 1. Allocation rows
-- ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.job_materials_facts
    GROUP BY xero_invoice_id, job_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'cfo18: job_materials_facts already holds two rows for one bill and job; resolve before applying';
  END IF;
END $$;

DROP INDEX IF EXISTS public.job_materials_facts_invoice_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS job_materials_facts_invoice_job_uidx
  ON public.job_materials_facts (xero_invoice_id, job_id);
CREATE INDEX IF NOT EXISTS job_materials_facts_invoice_idx
  ON public.job_materials_facts (xero_invoice_id);
-- A bill placed whole has one row: two whole-bill rows for one bill are still
-- refused, as the old index did. Only a split carries several rows.
CREATE UNIQUE INDEX IF NOT EXISTS job_materials_facts_invoice_whole_uidx
  ON public.job_materials_facts (xero_invoice_id)
  WHERE automation_source IS DISTINCT FROM 'manual_split';

-- A bill is placed whole or split, never both. The per-bill advisory lock
-- serialises a split against a whole placement racing it (the split function
-- takes the same lock), and each statement re-reads committed rows after it.
CREATE OR REPLACE FUNCTION public.job_materials_facts_no_mix()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('job_materials_facts:' || NEW.xero_invoice_id, 0));
  IF NEW.automation_source = 'manual_split' THEN
    IF EXISTS (SELECT 1 FROM public.job_materials_facts f
                WHERE f.xero_invoice_id = NEW.xero_invoice_id AND f.id IS DISTINCT FROM NEW.id
                  AND f.automation_source IS DISTINCT FROM 'manual_split') THEN
      RAISE EXCEPTION 'split_refused: bill % is already placed by another route; undo that first', NEW.xero_invoice_id
        USING ERRCODE = '23505';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public.job_materials_facts f
                 WHERE f.xero_invoice_id = NEW.xero_invoice_id AND f.id IS DISTINCT FROM NEW.id
                   AND f.automation_source = 'manual_split') THEN
    RAISE EXCEPTION 'placed_by_split: bill % is split across jobs; change it with Split', NEW.xero_invoice_id
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.job_materials_facts_no_mix() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS job_materials_facts_no_mix ON public.job_materials_facts;
CREATE TRIGGER job_materials_facts_no_mix
  BEFORE INSERT OR UPDATE OF xero_invoice_id, automation_source ON public.job_materials_facts
  FOR EACH ROW EXECUTE FUNCTION public.job_materials_facts_no_mix();

ALTER TABLE public.job_materials_facts DROP CONSTRAINT IF EXISTS job_materials_facts_source_chk;
ALTER TABLE public.job_materials_facts ADD CONSTRAINT job_materials_facts_source_chk
  CHECK (automation_source IN ('xero_ref_link', 'po_deterministic', 'manual_queue', 'agent_prematch', 'manual_split'));

COMMENT ON TABLE public.job_materials_facts IS
  'Allocation rows for supplier bills (M2/U3, CFO-18 20261020180000): one row per bill and job; a split bill has one row per job. A bill''s rows plus its overhead part (materials_reconciliation_queue.overhead_ex) equal the bill ex GST (v_bill_allocation_balance). A bill with a row on a job other than its own xero_invoices.job_id is read by the job profit engine through its rows only. Reversible by delete; xero_invoices is never mutated.';

-- ─────────────────────────────────────────────────────────────
-- 2. Queue: split status and overhead part
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.materials_reconciliation_queue
  ADD COLUMN IF NOT EXISTS overhead_ex numeric(12,2),
  ADD COLUMN IF NOT EXISTS overhead_note text;
ALTER TABLE public.materials_reconciliation_queue DROP CONSTRAINT IF EXISTS materials_recon_status_chk;
ALTER TABLE public.materials_reconciliation_queue ADD CONSTRAINT materials_recon_status_chk
  CHECK (status IN ('open', 'assigned', 'not_job_related', 'void_in_xero', 'split'));
ALTER TABLE public.materials_reconciliation_queue DROP CONSTRAINT IF EXISTS materials_recon_overhead_chk;
ALTER TABLE public.materials_reconciliation_queue ADD CONSTRAINT materials_recon_overhead_chk
  CHECK (overhead_ex IS NULL OR overhead_ex >= 0);

-- ─────────────────────────────────────────────────────────────
-- 3. allocate_bill_split
--    p_parts: [{"job_id": uuid, "amount_ex": number, "lane": "materials"|"labour"|"other"}]
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.allocate_bill_split(
  p_xero_invoice_id text,
  p_parts jsonb,
  p_overhead_ex numeric,
  p_overhead_note text,
  p_actor text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  q public.materials_reconciliation_queue%ROWTYPE;
  b record;
  part jsonb;
  v_job public.jobs%ROWTYPE;
  v_amount numeric;
  v_lane text;
  v_sum numeric := 0;
  v_overhead numeric := round(COALESCE(p_overhead_ex, 0), 2);
  v_jobs uuid[] := ARRAY[]::uuid[];
  v_existing int;
  v_same boolean;
  v_bill_lane text;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'split_refused: actor required';
  END IF;
  IF jsonb_typeof(p_parts) <> 'array' OR jsonb_array_length(p_parts) = 0 THEN
    RAISE EXCEPTION 'split_refused: at least one job part is required';
  END IF;
  IF v_overhead < 0 THEN
    RAISE EXCEPTION 'split_refused: overhead cannot be negative';
  END IF;

  -- The same per-bill lock as the no-mix trigger: a whole placement racing
  -- this split waits, then sees the split rows (and is refused).
  PERFORM pg_advisory_xact_lock(hashtextextended('job_materials_facts:' || p_xero_invoice_id, 0));

  SELECT * INTO q FROM public.materials_reconciliation_queue
   WHERE xero_invoice_id = p_xero_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'split_refused: bill % is not in Bills to place', p_xero_invoice_id;
  END IF;

  SELECT x.status, x.sub_total, x.line_items INTO b
    FROM public.xero_invoices x
   WHERE x.xero_invoice_id = p_xero_invoice_id AND x.invoice_type = 'ACCPAY'
   ORDER BY (x.status IN ('AUTHORISED', 'PAID')) DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'split_refused: bill % is not in our copy of Xero', p_xero_invoice_id;
  END IF;
  IF b.status NOT IN ('AUTHORISED', 'PAID') THEN
    RAISE EXCEPTION 'split_refused: bill % is % in Xero', p_xero_invoice_id, b.status;
  END IF;
  IF b.sub_total IS NULL OR b.sub_total <= 0 THEN
    RAISE EXCEPTION 'split_refused: bill % has no known ex-GST amount', p_xero_invoice_id;
  END IF;
  IF EXISTS (SELECT 1 FROM public.trade_invoices t WHERE t.xero_bill_id = p_xero_invoice_id) THEN
    RAISE EXCEPTION 'split_refused: bill % is a trade app invoice, counted through the trade app', p_xero_invoice_id;
  END IF;
  -- An installer bill (a money line on 306 or 301) is labour on every part,
  -- whatever the screen sent.
  v_bill_lane := CASE WHEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.line_items) = 'array' THEN b.line_items ELSE '[]'::jsonb END) li
      WHERE li.value ->> 'AccountCode' IN ('306', '301')
        AND COALESCE(public.job_profit_num(li.value -> 'LineAmount'), 0) <> 0)
    THEN 'labour' END;

  FOR part IN SELECT value FROM jsonb_array_elements(p_parts) LOOP
    IF jsonb_typeof(part -> 'amount_ex') <> 'number' THEN
      RAISE EXCEPTION 'split_refused: every part needs an amount';
    END IF;
    v_amount := round((part ->> 'amount_ex')::numeric, 2);
    IF v_amount <= 0 THEN
      RAISE EXCEPTION 'split_refused: every part must be more than 0';
    END IF;
    SELECT * INTO v_job FROM public.jobs WHERE id = (part ->> 'job_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'split_refused: job % not found', part ->> 'job_id';
    END IF;
    IF lower(COALESCE(v_job.metadata ->> 'do_not_schedule', '')) = 'true' THEN
      RAISE EXCEPTION 'split_refused: % is a holding job', v_job.job_number;
    END IF;
    IF lower(COALESCE(v_job.status, '')) IN ('cancelled', 'lost') THEN
      RAISE EXCEPTION 'split_refused: % is %', v_job.job_number, v_job.status;
    END IF;
    IF v_job.id = ANY (v_jobs) THEN
      RAISE EXCEPTION 'split_refused: % appears twice; give it one part', v_job.job_number;
    END IF;
    v_lane := COALESCE(part ->> 'lane', 'materials');
    IF v_lane NOT IN ('materials', 'labour', 'other') THEN
      RAISE EXCEPTION 'split_refused: lane % is not materials, labour or other', v_lane;
    END IF;
    v_jobs := v_jobs || v_job.id;
    v_sum := v_sum + v_amount;
  END LOOP;

  IF abs(v_sum + v_overhead - round(b.sub_total, 2)) > 0.005 THEN
    RAISE EXCEPTION 'split_refused: parts % plus overhead % do not equal the bill % ex GST',
      v_sum, v_overhead, round(b.sub_total, 2);
  END IF;

  SELECT count(*) INTO v_existing FROM public.job_materials_facts
   WHERE xero_invoice_id = p_xero_invoice_id AND automation_source <> 'manual_split';
  IF v_existing > 0 THEN
    RAISE EXCEPTION 'split_refused: bill % is already placed by another route; undo that first', p_xero_invoice_id;
  END IF;

  -- Same parts again: nothing to do.
  SELECT (q.status = 'split'
          AND COALESCE(q.overhead_ex, 0) = v_overhead
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_parts) p
            WHERE NOT EXISTS (
              SELECT 1 FROM public.job_materials_facts f
              WHERE f.xero_invoice_id = p_xero_invoice_id
                AND f.job_id = (p.value ->> 'job_id')::uuid
                AND f.amount_ex_gst = round((p.value ->> 'amount_ex')::numeric, 2)
                AND f.lane = COALESCE(v_bill_lane, p.value ->> 'lane', 'materials')))
          AND (SELECT count(*) FROM public.job_materials_facts f
                WHERE f.xero_invoice_id = p_xero_invoice_id) = jsonb_array_length(p_parts))
    INTO v_same;
  IF v_same THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'xero_invoice_id', p_xero_invoice_id);
  END IF;

  DELETE FROM public.job_materials_facts
   WHERE xero_invoice_id = p_xero_invoice_id AND automation_source = 'manual_split';

  INSERT INTO public.job_materials_facts (
    org_id, xero_invoice_id, invoice_number, xero_contact_id, contact_name, job_id, job_number,
    lane, kind, amount_ex_gst, amount_inc_gst, confidence, automation_source, match_reason,
    fact_date, assigned_by, updated_at)
  SELECT
    q.org_id, q.xero_invoice_id, q.invoice_number, q.xero_contact_id, q.contact_name, j.id, j.job_number,
    COALESCE(v_bill_lane, p.value ->> 'lane', 'materials'), 'actual', round((p.value ->> 'amount_ex')::numeric, 2), NULL,
    'high_manual', 'manual_split',
    'manual_split:' || jsonb_array_length(p_parts) || ' jobs' ||
      CASE WHEN v_overhead > 0 THEN ' + overhead ' || v_overhead ELSE '' END,
    q.invoice_date, p_actor, now()
  FROM jsonb_array_elements(p_parts) p
  JOIN public.jobs j ON j.id = (p.value ->> 'job_id')::uuid;

  UPDATE public.materials_reconciliation_queue
     SET status = 'split',
         assigned_job_id = NULL,
         assigned_by = p_actor,
         assigned_at = now(),
         overhead_ex = CASE WHEN v_overhead > 0 THEN v_overhead END,
         overhead_note = CASE WHEN v_overhead > 0 THEN NULLIF(btrim(COALESCE(p_overhead_note, '')), '') END,
         updated_at = now()
   WHERE id = q.id;

  RETURN jsonb_build_object('ok', true, 'idempotent', false, 'xero_invoice_id', p_xero_invoice_id,
                            'parts', jsonb_array_length(p_parts), 'allocated_ex', v_sum, 'overhead_ex', v_overhead);
END;
$$;
REVOKE ALL ON FUNCTION public.allocate_bill_split(text, jsonb, numeric, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.allocate_bill_split(text, jsonb, numeric, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_bill_split(text, jsonb, numeric, text, text) TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 4. Conservation check
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_bill_allocation_balance AS
WITH alloc AS (
  SELECT f.xero_invoice_id, count(*) AS rows, sum(f.amount_ex_gst) AS allocated_ex
  FROM public.job_materials_facts f
  WHERE f.kind = 'actual'
  GROUP BY f.xero_invoice_id
),
bills AS (
  SELECT DISTINCT ON (x.xero_invoice_id) x.xero_invoice_id, x.invoice_number, x.contact_name, x.status, x.sub_total
  FROM public.xero_invoices x
  WHERE x.invoice_type = 'ACCPAY'
  ORDER BY x.xero_invoice_id, (x.status IN ('AUTHORISED', 'PAID')) DESC
)
SELECT
  k.xero_invoice_id,
  b.invoice_number,
  b.contact_name,
  b.status AS bill_status,
  round(b.sub_total, 2) AS bill_ex,
  COALESCE(a.rows, 0) AS allocation_rows,
  COALESCE(a.allocated_ex, 0) AS allocated_ex,
  COALESCE(q.overhead_ex, 0) AS overhead_ex,
  round(b.sub_total, 2) - COALESCE(a.allocated_ex, 0) - COALESCE(q.overhead_ex, 0) AS remainder_ex,
  (b.sub_total IS NOT NULL
   AND b.status IN ('AUTHORISED', 'PAID')
   AND abs(round(b.sub_total, 2) - COALESCE(a.allocated_ex, 0) - COALESCE(q.overhead_ex, 0)) <= 0.005) AS balanced,
  q.status AS queue_status
FROM (SELECT xero_invoice_id FROM alloc
      UNION SELECT xero_invoice_id FROM public.materials_reconciliation_queue WHERE COALESCE(overhead_ex, 0) > 0) k
LEFT JOIN alloc a ON a.xero_invoice_id = k.xero_invoice_id
LEFT JOIN bills b ON b.xero_invoice_id = k.xero_invoice_id
LEFT JOIN public.materials_reconciliation_queue q ON q.xero_invoice_id = k.xero_invoice_id;

COMMENT ON VIEW public.v_bill_allocation_balance IS
  'CFO-18: every supplier bill with allocation rows or an overhead part. remainder_ex = bill ex GST - allocated - overhead; balanced when 0 to the cent and the bill is live in Xero (a voided or deleted bill with rows is never balanced: undo its rows). A bill amended in Xero after a split shows the drift as a remainder. A bill placed whole by one row is balanced only when that row carries the bill sub_total. Read only, service role only.';
REVOKE ALL ON public.v_bill_allocation_balance FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_bill_allocation_balance TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 5. v_job_cost_events (from 20261019120000, changes marked CFO-18 / CFO-20)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_job_cost_events AS
WITH trade_mirror_bill AS (
  SELECT x.xero_invoice_id
  FROM public.xero_invoices x
  WHERE x.invoice_type = 'ACCPAY'
    AND (
      EXISTS (SELECT 1 FROM public.trade_invoices t WHERE t.xero_bill_id = x.xero_invoice_id)
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.line_items) = 'array' THEN x.line_items ELSE '[]'::jsonb END) li
        WHERE li.value ->> 'Description' ~ '\| SW - [A-Z]'
      )
    )
),
trade AS (
  SELECT
    r.resolved_job_id AS job_id,
    COALESCE(r.line_date, r.week_start) AS event_date,
    CASE WHEN r.cost_lane = 'unclassified' THEN 'other' ELSE r.cost_lane END AS lane,
    r.cost_lane AS lane_detail,
    'trade'::text AS party_kind,
    r.user_id::text AS party_id,
    COALESCE(NULLIF(btrim(u.name), ''), 'Unnamed trade') AS party,
    r.line_total_ex AS amount_ex,
    'trade_line'::text AS source,
    r.line_id::text AS source_id,
    ti.id::text AS document_id,
    ti.invoice_number AS document_number,
    ti.status AS document_status,
    (ti.status = 'paid' OR upper(COALESCE(ti.xero_bill_status, '')) = 'PAID') AS paid,
    ti.paid_at AS paid_on,
    CASE r.match_method
      WHEN 'job_id' THEN 'high'
      WHEN 'line_job_number' THEN 'medium'
      ELSE 'low'
    END AS confidence,
    true AS is_actual,
    r.description,
    r.total_hours AS hours,
    NULL::text AS account_code,
    NULL::text AS business_unit,
    r.match_method,
    COALESCE(c.zero_line OR c.mismatch, false) AS incomplete_invoice
  FROM public.v_trade_charge_resolved r
  JOIN public.trade_invoices ti ON ti.id = r.trade_invoice_id
  LEFT JOIN public.users u ON u.id = r.user_id
  LEFT JOIN public.v_invoice_line_completeness c ON c.trade_invoice_id = r.trade_invoice_id
  WHERE r.resolved_job_id IS NOT NULL
    AND NOT r.is_probable_test_line
    AND ti.status <> 'ops-reject'
    AND upper(COALESCE(ti.xero_bill_status, '')) NOT IN ('DELETED', 'VOIDED')
),
bill_line AS (
  SELECT
    x.job_id,
    x.invoice_date,
    x.xero_invoice_id,
    x.invoice_number,
    x.contact_name,
    x.status,
    x.fully_paid_on,
    li.n,
    li.value AS line,
    CASE
      WHEN li.value ? '_header_ex' THEN public.job_profit_num(li.value -> '_header_ex')
      WHEN x.raw_json ->> 'LineAmountTypes' = 'Inclusive'
        THEN COALESCE(public.job_profit_num(li.value -> 'LineAmount'), 0)
           - COALESCE(public.job_profit_num(li.value -> 'TaxAmount'), 0)
      ELSE COALESCE(public.job_profit_num(li.value -> 'LineAmount'), 0)
    END AS amount_ex,
    public.job_cost_credit_share(x.raw_json, x.total) AS credit_share
  FROM public.xero_invoices x
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(x.line_items) = 'array' AND jsonb_array_length(x.line_items) > 0 THEN x.line_items
      ELSE jsonb_build_array(jsonb_build_object('_header_ex', x.sub_total, 'Description', 'Bill total (no lines stored)'))
    END
  ) WITH ORDINALITY AS li(value, n)
  WHERE x.invoice_type = 'ACCPAY'
    AND x.status IN ('AUTHORISED', 'PAID')
    AND x.job_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM trade_mirror_bill m WHERE m.xero_invoice_id = x.xero_invoice_id)
    -- CFO-18: a bill with an allocation row on any other job (a person moving
    -- it off the holding card), any split row, or an overhead part is read
    -- through its allocation rows only, never also through xero_invoices.job_id
    -- (so a split or overhead on the bill's own job is never ignored). A bill
    -- placed whole on its own job keeps its richer line detail (as before).
    AND NOT EXISTS (
      SELECT 1 FROM public.job_materials_facts f
      WHERE f.xero_invoice_id = x.xero_invoice_id
        AND (f.job_id IS DISTINCT FROM x.job_id OR f.automation_source = 'manual_split')
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.materials_reconciliation_queue q
      WHERE q.xero_invoice_id = x.xero_invoice_id AND COALESCE(q.overhead_ex, 0) > 0
    )
),
supplier AS (
  SELECT
    b.job_id,
    b.invoice_date AS event_date,
    CASE
      WHEN COALESCE(b.line ->> 'Description', '') ~* 'commission' THEN 'commission'
      WHEN b.line ->> 'AccountCode' IN ('306', '301') THEN 'labour'
      WHEN b.line ->> 'AccountCode' ~ '^3[0-9]{2}$' THEN 'materials'
      ELSE 'other'
    END AS lane,
    COALESCE(b.line ->> 'AccountCode', 'no_account') AS lane_detail,
    'supplier'::text AS party_kind,
    NULL::text AS party_id,
    COALESCE(NULLIF(btrim(b.contact_name), ''), 'Unnamed supplier') AS party,
    b.amount_ex,
    'supplier_bill'::text AS source,
    b.xero_invoice_id || ':' || b.n AS source_id,
    b.xero_invoice_id AS document_id,
    b.invoice_number AS document_number,
    b.status AS document_status,
    (b.status = 'PAID') AS paid,
    b.fully_paid_on AS paid_on,
    'high'::text AS confidence,
    true AS is_actual,
    b.line ->> 'Description' AS description,
    NULL::numeric AS hours,
    b.line ->> 'AccountCode' AS account_code,
    (SELECT t.value ->> 'Option'
       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.line -> 'Tracking') = 'array' THEN b.line -> 'Tracking' ELSE '[]'::jsonb END) t
      WHERE t.value ->> 'Name' = 'Business Unit'
      LIMIT 1) AS business_unit,
    'xero_invoices.job_id'::text AS match_method,
    false AS incomplete_invoice
  FROM bill_line b
),
fact_base AS (
  SELECT
    f.job_id,
    f.fact_date AS event_date,
    CASE WHEN f.lane IN ('labour', 'materials', 'commission', 'other') THEN f.lane ELSE 'materials' END AS lane,
    f.lane AS lane_detail,
    'supplier'::text AS party_kind,
    NULL::text AS party_id,
    COALESCE(NULLIF(btrim(f.contact_name), ''), 'Unnamed supplier') AS party,
    f.amount_ex_gst AS amount_ex,
    'materials_fact'::text AS source,
    f.id::text AS source_id,
    f.xero_invoice_id AS document_id,
    f.invoice_number AS document_number,
    x.status AS document_status,
    COALESCE(x.status = 'PAID', false) AS paid,
    x.fully_paid_on AS paid_on,
    COALESCE(f.confidence, 'unknown') AS confidence,
    true AS is_actual,
    f.match_reason AS description,
    NULL::numeric AS hours,
    NULL::text AS account_code,
    NULL::text AS business_unit,
    COALESCE(f.automation_source, 'materials_fact') AS match_method,
    false AS incomplete_invoice,
    COALESCE(x.status IN ('AUTHORISED', 'PAID'), false) AS bill_live,
    public.job_cost_credit_share(x.raw_json, x.total) AS credit_share
  FROM public.job_materials_facts f
  LEFT JOIN public.xero_invoices x
    ON x.xero_invoice_id = f.xero_invoice_id AND x.invoice_type = 'ACCPAY'
  WHERE f.kind = 'actual'
    AND f.job_id IS NOT NULL
    AND f.amount_ex_gst IS NOT NULL
    AND COALESCE(x.status, '') NOT IN ('VOIDED', 'DELETED')
    AND NOT EXISTS (SELECT 1 FROM trade_mirror_bill m WHERE m.xero_invoice_id = f.xero_invoice_id)
    AND NOT EXISTS (
      SELECT 1 FROM bill_line b
      WHERE b.xero_invoice_id = f.xero_invoice_id AND b.job_id = f.job_id
    )
),
fact AS (
  SELECT job_id, event_date, lane, lane_detail, party_kind, party_id, party, amount_ex, source,
         source_id, document_id, document_number, document_status, paid, paid_on, confidence,
         is_actual, description, hours, account_code, business_unit, match_method, incomplete_invoice
  FROM fact_base
),
-- CFO-20: credit applied in Xero against a live bill reduces cost in proportion
-- on every line or allocation row of that bill (AmountCredited / Total, so GST
-- comes out the same way). Never on a voided or deleted bill.
supplier_credit AS (
  SELECT
    b.job_id,
    b.invoice_date AS event_date,
    s.lane,
    s.lane_detail,
    s.party_kind,
    s.party_id,
    s.party,
    -round(s.amount_ex * b.credit_share, 2) AS amount_ex,
    'supplier_credit'::text AS source,
    s.source_id || ':credit' AS source_id,
    s.document_id,
    s.document_number,
    s.document_status,
    s.paid,
    s.paid_on,
    s.confidence,
    true AS is_actual,
    'Credit applied in Xero' AS description,
    NULL::numeric AS hours,
    s.account_code,
    s.business_unit,
    'xero_amount_credited'::text AS match_method,
    false AS incomplete_invoice
  FROM supplier s
  JOIN bill_line b ON b.xero_invoice_id || ':' || b.n = s.source_id
  WHERE b.credit_share > 0 AND s.amount_ex <> 0
),
fact_credit AS (
  SELECT
    f.job_id, f.event_date, f.lane, f.lane_detail, f.party_kind, f.party_id, f.party,
    -round(f.amount_ex * f.credit_share, 2) AS amount_ex,
    'supplier_credit'::text AS source,
    f.source_id || ':credit' AS source_id,
    f.document_id, f.document_number, f.document_status, f.paid, f.paid_on, f.confidence,
    true AS is_actual,
    'Credit applied in Xero' AS description,
    NULL::numeric AS hours, f.account_code, f.business_unit,
    'xero_amount_credited'::text AS match_method,
    false AS incomplete_invoice
  FROM fact_base f
  WHERE f.bill_live AND f.credit_share > 0 AND f.amount_ex <> 0
),
po_base AS (
  SELECT
    p.id,
    p.job_id,
    p.po_number,
    p.supplier_name,
    p.status,
    p.notes,
    p.delivery_date,
    p.created_at,
    p.invoice_received_at,
    -- A positive subtotal, else a positive total less GST; otherwise no price.
    -- A 0 subtotal never hides a known total, and no price is never $0.
    CASE WHEN p.subtotal > 0 THEN p.subtotal WHEN p.total > 0 THEN p.total / 1.1 END AS po_amount_ex,
    NOT (COALESCE(p.subtotal, 0) > 0 OR COALESCE(p.total, 0) > 0) AS unpriced,
    COALESCE(
      (SELECT min(oe.sent_at) FROM public.job_order_emails oe
        WHERE oe.purchase_order_id = p.id AND oe.status = 'sent' AND oe.sent_at IS NOT NULL),
      p.last_sent_at,
      p.created_at
    ) AS ordered_at
  FROM public.purchase_orders p
  WHERE p.job_id IS NOT NULL
    AND p.xero_bill_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.job_materials_facts f
      WHERE f.matched_po_id = p.id AND f.kind = 'actual'
    )
    AND lower(COALESCE(p.status, '')) NOT IN ('draft', 'billed', 'cancelled', 'canceled', 'void', 'voided', 'deleted')
),
po_state AS (
  SELECT
    b.*,
    CASE
      WHEN b.invoice_received_at IS NOT NULL THEN 'po_invoice_emailed'
      WHEN b.unpriced THEN 'po_ordered'
      ELSE 'po_committed'
    END AS state
  FROM po_base b
),
po AS (
  SELECT
    s.job_id,
    CASE s.state
      WHEN 'po_invoice_emailed' THEN (s.invoice_received_at AT TIME ZONE 'Australia/Perth')::date
      WHEN 'po_ordered' THEN (s.ordered_at AT TIME ZONE 'Australia/Perth')::date
      ELSE COALESCE(s.delivery_date, s.created_at::date)
    END AS event_date,
    'materials'::text AS lane,
    'purchase_order'::text AS lane_detail,
    'supplier'::text AS party_kind,
    NULL::text AS party_id,
    COALESCE(NULLIF(btrim(s.supplier_name), ''), 'Unnamed supplier') AS party,
    CASE WHEN s.unpriced THEN NULL::numeric ELSE s.po_amount_ex END AS amount_ex,
    s.state AS source,
    s.id::text AS source_id,
    s.id::text AS document_id,
    s.po_number AS document_number,
    s.status AS document_status,
    false AS paid,
    NULL::date AS paid_on,
    CASE s.state
      WHEN 'po_invoice_emailed' THEN 'invoice_emailed'
      WHEN 'po_ordered' THEN 'ordered_not_billed'
      ELSE 'committed'
    END AS confidence,
    false AS is_actual,
    s.notes AS description,
    NULL::numeric AS hours,
    NULL::text AS account_code,
    NULL::text AS business_unit,
    'purchase_orders.job_id'::text AS match_method,
    false AS incomplete_invoice
  FROM po_state s
)
SELECT * FROM trade
UNION ALL SELECT * FROM supplier
UNION ALL SELECT * FROM fact
UNION ALL SELECT * FROM supplier_credit
UNION ALL SELECT * FROM fact_credit
UNION ALL SELECT * FROM po;


COMMENT ON VIEW public.v_job_cost_events IS
  'Job profit engine (20261009130000, CFO-12 20261019120000, CFO-18/20 20261020180000): one row per job cost, lane labour/materials/commission/other, source trade_line/supplier_bill/materials_fact/supplier_credit/po_committed/po_ordered/po_invoice_emailed. A bill with an allocation row on another job is read through its rows only. supplier_credit is credit applied in Xero against a live bill, negative, in proportion. The three po_ sources are never actual. Read only, service role only.';

-- ─────────────────────────────────────────────────────────────
-- 6. v_job_revenue_events (from 20261009130000, credit rows added, CFO-20)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_job_revenue_events AS
SELECT
  x.job_id,
  'invoice_line'::text AS kind,
  x.invoice_date,
  CASE
    WHEN li.value ? '_header_ex' THEN public.job_profit_num(li.value -> '_header_ex')
    WHEN x.raw_json ->> 'LineAmountTypes' = 'Inclusive'
      THEN COALESCE(public.job_profit_num(li.value -> 'LineAmount'), 0)
         - COALESCE(public.job_profit_num(li.value -> 'TaxAmount'), 0)
    ELSE COALESCE(public.job_profit_num(li.value -> 'LineAmount'), 0)
  END AS amount_ex,
  x.status,
  (x.status = 'PAID') AS paid,
  x.fully_paid_on AS paid_on,
  (x.status IN ('AUTHORISED', 'PAID')) AS counts_as_invoiced,
  x.xero_invoice_id || ':' || li.n AS source_id,
  x.xero_invoice_id AS document_id,
  x.invoice_number AS document_number,
  x.contact_name AS party,
  li.value ->> 'Description' AS description,
  li.value ->> 'AccountCode' AS account_code,
  (SELECT t.value ->> 'Option'
     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(li.value -> 'Tracking') = 'array' THEN li.value -> 'Tracking' ELSE '[]'::jsonb END) t
    WHERE t.value ->> 'Name' = 'Business Unit'
    LIMIT 1) AS business_unit,
  false AS agreed
FROM public.xero_invoices x
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN jsonb_typeof(x.line_items) = 'array' AND jsonb_array_length(x.line_items) > 0 THEN x.line_items
    ELSE jsonb_build_array(jsonb_build_object('_header_ex', x.sub_total, 'Description', 'Invoice total (no lines stored)'))
  END
) WITH ORDINALITY AS li(value, n)
WHERE x.invoice_type = 'ACCREC'
  AND x.job_id IS NOT NULL
  AND x.status NOT IN ('VOIDED', 'DELETED')
UNION ALL
-- CFO-20: credit applied in Xero against a live sales invoice reduces the
-- job's invoiced revenue (AmountCredited x SubTotal / Total, ex GST). Counted
-- as invoiced so invoiced_ex is net of credit; never a paid amount.
SELECT
  x.job_id,
  'credit_applied'::text AS kind,
  x.invoice_date,
  -round(x.sub_total * public.job_cost_credit_share(x.raw_json, x.total), 2) AS amount_ex,
  x.status,
  (x.status = 'PAID') AS paid,
  x.fully_paid_on AS paid_on,
  true AS counts_as_invoiced,
  x.xero_invoice_id || ':credit' AS source_id,
  x.xero_invoice_id AS document_id,
  x.invoice_number AS document_number,
  x.contact_name AS party,
  'Credit applied in Xero'::text AS description,
  NULL::text AS account_code,
  NULL::text AS business_unit,
  false AS agreed
FROM public.xero_invoices x
WHERE x.invoice_type = 'ACCREC'
  AND x.job_id IS NOT NULL
  AND x.status IN ('AUTHORISED', 'PAID')
  AND public.job_cost_credit_share(x.raw_json, x.total) > 0
  AND COALESCE(x.sub_total, 0) <> 0
UNION ALL
SELECT
  v.job_id,
  'variation'::text AS kind,
  COALESCE(v.accepted_at, v.approved_at, v.sent_at, v.created_at)::date AS invoice_date,
  CASE WHEN v.gst_included THEN round(v.amount / 1.1, 2) ELSE v.amount END AS amount_ex,
  v.status,
  false AS paid,
  NULL::date AS paid_on,
  false AS counts_as_invoiced,
  v.id::text AS source_id,
  v.id::text AS document_id,
  'V' || v.variation_number AS document_number,
  NULL::text AS party,
  v.description,
  NULL::text AS account_code,
  NULL::text AS business_unit,
  (
    v.declined_at IS NULL
    AND lower(COALESCE(v.status, '')) NOT IN ('declined', 'rejected')
    AND (v.accepted_at IS NOT NULL OR lower(COALESCE(v.status, '')) IN ('accepted', 'invoiced'))
  ) AS agreed
FROM public.job_variations v
WHERE v.job_id IS NOT NULL;


COMMENT ON VIEW public.v_job_revenue_events IS
  'Job profit engine (20261009130000, CFO-20 20261020180000): sales invoice lines per job (VOIDED/DELETED excluded; counts_as_invoiced for AUTHORISED/PAID), credit applied in Xero against a live sales invoice (kind credit_applied, negative, counts as invoiced), and every variation (counts_as_invoiced false). Read only, service role only.';
