-- Keep the held_reason column but take the hold out: the outcome claims the
-- parts again. The contract must fail on the first labour row nobody recorded.
CREATE OR REPLACE VIEW public.cfo_bill_reconciliation_outcomes AS
WITH bill AS (
  SELECT DISTINCT ON (x.xero_invoice_id)
         x.xero_invoice_id, x.invoice_number, x.status, x.sub_total, x.total, x.line_items, x.raw_json, x.job_id
  FROM public.xero_invoices x
  WHERE x.invoice_type = 'ACCPAY'
  ORDER BY x.xero_invoice_id, (x.status IN ('AUTHORISED', 'PAID')) DESC
),
mirror AS (
  SELECT b.xero_invoice_id
  FROM bill b
  WHERE EXISTS (SELECT 1 FROM public.trade_invoices t WHERE t.xero_bill_id = b.xero_invoice_id)
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.line_items) = 'array' THEN b.line_items ELSE '[]'::jsonb END) li
       WHERE li.value ->> 'Description' ~ '\| SW - [A-Z]'
     )
),
fact_row AS (
  -- A row is a person's only when a person source wrote it AND it names a
  -- recorded person (cfo_recorded_person, 20261021173000): user:<uuid> of a
  -- public.users row, or a user's email. Any other actor is unrecorded.
  SELECT f.*,
         CASE
           WHEN COALESCE(f.automation_source, '') NOT IN ('manual_queue', 'manual_split') THEN 'machine'
           WHEN public.cfo_recorded_person(f.automation_source, f.assigned_by) THEN 'person'
           ELSE 'unrecorded'
         END AS placed_by,
         NULLIF(btrim(f.assigned_by), '') AS actor
  FROM public.job_materials_facts f
  WHERE f.kind = 'actual' AND f.job_id IS NOT NULL
),
fact AS (
  SELECT f.xero_invoice_id,
         jsonb_agg(jsonb_build_object(
           'job_id', f.job_id,
           'amount_ex_gst', round(f.amount_ex_gst, 2),
           'lane', f.lane,
           'placed_by', f.placed_by,
           'automation_source', f.automation_source)
           ORDER BY f.job_id::text COLLATE "C", f.automation_source COLLATE "C") AS parts,
         sum(round(f.amount_ex_gst, 2)) AS parts_ex,
         bool_and(f.placed_by = 'person') AS all_person,
         bool_or(f.amount_ex_gst IS NULL) AS amount_unreadable,
         -- 20261021213000: a labour part no recorded person placed, which the
         -- engine holds as awaiting_confirmation when it reads the rows.
         bool_or(f.lane = 'labour' AND f.placed_by <> 'person') AS labour_unrecorded,
         min(f.actor) FILTER (WHERE f.placed_by = 'person') AS fact_by_min,
         max(f.actor) FILTER (WHERE f.placed_by = 'person') AS fact_by_max,
         max(f.updated_at) AS fact_at
  FROM fact_row f
  GROUP BY f.xero_invoice_id
),
universe AS (
  SELECT xero_invoice_id FROM bill WHERE job_id IS NOT NULL
  UNION SELECT xero_invoice_id FROM fact
  UNION SELECT xero_invoice_id FROM public.materials_reconciliation_queue
),
base AS (
  SELECT
    u.xero_invoice_id,
    b.invoice_number,
    b.status AS bill_status,
    (b.xero_invoice_id IS NOT NULL) AS bill_known,
    CASE
      WHEN b.status IN ('AUTHORISED', 'PAID') THEN 'live'
      WHEN b.status IN ('VOIDED', 'DELETED') THEN 'void'
      ELSE COALESCE(b.status, 'missing')
    END AS status_class,
    round(b.sub_total, 2) AS bill_ex,
    b.line_items,
    COALESCE(public.job_cost_installer_bill(b.line_items), false) AS installer,
    -- Credit is known only when the stored copy shows it; 0 is never assumed.
    CASE
      WHEN b.raw_json IS NULL OR COALESCE(b.total, 0) <= 0 OR b.sub_total IS NULL THEN NULL
      WHEN (jsonb_typeof(b.raw_json -> 'CreditNotes') = 'array'
            AND jsonb_array_length(b.raw_json -> 'CreditNotes') > 0
            AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(b.raw_json -> 'CreditNotes') c
                             WHERE public.job_profit_num(c.value -> 'AppliedAmount') IS NULL))
        OR jsonb_typeof(b.raw_json -> 'AmountCredited') = 'number'
        THEN round(public.job_cost_credit_share(b.raw_json, b.total) * b.sub_total, 2)
      ELSE NULL
    END AS credit_applied_ex,
    CASE
      WHEN f.xero_invoice_id IS NOT NULL THEN f.parts
      WHEN b.job_id IS NOT NULL AND b.status IN ('AUTHORISED', 'PAID')
           AND q.status IS DISTINCT FROM 'not_job_related' THEN
        jsonb_build_array(jsonb_build_object(
          'job_id', b.job_id,
          'amount_ex_gst', round(b.sub_total, 2),
          'lane', NULL,
          'placed_by', 'machine',
          'automation_source', 'xero_job_link'))
      ELSE '[]'::jsonb
    END AS parts,
    CASE
      WHEN f.xero_invoice_id IS NOT NULL THEN f.parts_ex
      WHEN b.job_id IS NOT NULL AND b.status IN ('AUTHORISED', 'PAID')
           AND q.status IS DISTINCT FROM 'not_job_related' THEN round(b.sub_total, 2)
      ELSE 0
    END AS parts_ex,
    CASE
      WHEN f.xero_invoice_id IS NOT NULL THEN f.all_person
      WHEN b.job_id IS NOT NULL AND b.status IN ('AUTHORISED', 'PAID')
           AND q.status IS DISTINCT FROM 'not_job_related' THEN false
    END AS all_person,
    COALESCE(f.amount_unreadable, false) AS amount_unreadable,
    round(COALESCE(q.overhead_ex, 0), 2) AS overhead_ex,
    q.status AS queue_status,
    -- A queue decision is a person's only when its actor is a recorded person.
    CASE WHEN public.cfo_recorded_person('manual_queue', q.assigned_by)
         THEN btrim(q.assigned_by) END AS queue_by,
    q.assigned_at AS queue_at,
    f.fact_by_min, f.fact_by_max, f.fact_at,
    -- 20261021213000: why the engine (v_job_cost_events) does not count what
    -- parts show. The engine reads a bill through its Xero lines exactly when
    -- bill_line does: a job link, live, no job_materials_facts row of any kind
    -- on another job and none manual_split, and no queue overhead part.
    -- Otherwise it reads the rows, and holds a labour row no recorded person
    -- placed (fact_base). Neither rule reads the not-job-related mark, and a
    -- marked bill with no rows has no parts here, so no F1 bill is held.
    CASE
      WHEN f.xero_invoice_id IS NOT NULL THEN
        CASE WHEN f.labour_unrecorded AND NOT xl.read THEN 'labour_part_unconfirmed' END
      WHEN b.job_id IS NOT NULL AND b.status IN ('AUTHORISED', 'PAID')
           AND q.status IS DISTINCT FROM 'not_job_related' AND NOT xl.read THEN
        CASE WHEN q.overhead_ex > 0 THEN 'overhead_on_xero_linked_bill' ELSE 'xero_link_not_counted' END
    END AS hold_reason
  FROM universe u
  LEFT JOIN bill b ON b.xero_invoice_id = u.xero_invoice_id
  LEFT JOIN fact f ON f.xero_invoice_id = u.xero_invoice_id
  LEFT JOIN public.materials_reconciliation_queue q ON q.xero_invoice_id = u.xero_invoice_id
  CROSS JOIN LATERAL (
    SELECT b.job_id IS NOT NULL AND b.status IN ('AUTHORISED', 'PAID')
       AND NOT EXISTS (
         SELECT 1 FROM public.job_materials_facts jf
         WHERE jf.xero_invoice_id = b.xero_invoice_id
           AND (jf.job_id IS DISTINCT FROM b.job_id OR jf.automation_source = 'manual_split'))
       AND NOT COALESCE(q.overhead_ex > 0, false) AS read
  ) xl
  WHERE NOT EXISTS (SELECT 1 FROM mirror m WHERE m.xero_invoice_id = u.xero_invoice_id)
),
judged0 AS (
  SELECT
    b.*,
    CASE WHEN b.amount_unreadable THEN NULL ELSE b.bill_ex - b.parts_ex - b.overhead_ex END AS remainder_ex,
    -- An overhead part is decided only on the queue row, so a bill with one
    -- never takes its decider from its job rows (20261021173000).
    COALESCE(CASE WHEN b.queue_status IN ('assigned', 'split', 'not_job_related') THEN b.queue_by END,
             CASE WHEN b.fact_by_min = b.fact_by_max AND b.overhead_ex = 0 THEN b.fact_by_min END) AS decider,
    CASE
      WHEN NOT b.bill_known THEN 'unknown'
      WHEN b.status_class = 'void' THEN 'voided'
      WHEN b.status_class <> 'live' THEN 'unknown'
      WHEN b.bill_ex IS NULL OR b.amount_unreadable THEN 'unknown'
      WHEN jsonb_array_length(b.parts) = 0
           AND (b.queue_status = 'not_job_related'
                OR (b.overhead_ex > 0 AND abs(b.bill_ex - b.overhead_ex) <= 0.005)) THEN 'confirmed_overhead'
      WHEN jsonb_array_length(b.parts) = 0 THEN 'unplaced'
      WHEN b.installer AND NOT COALESCE(b.all_person, false) THEN 'installer_unconfirmed'
      -- 20261021213000: the engine does not count what parts show, so the
      -- outcome claims no placement; held_reason names why.
      WHEN abs(b.bill_ex - b.parts_ex - b.overhead_ex) > 0.005 THEN 'unbalanced'
      WHEN NOT COALESCE(b.all_person, false) THEN 'placed_unconfirmed'
      ELSE 'confirmed'
    END AS state0,
    CASE
      WHEN b.bill_known AND b.status_class = 'live' AND b.bill_ex IS NOT NULL AND NOT b.amount_unreadable
           AND jsonb_array_length(b.parts) > 0
           AND NOT (b.installer AND NOT COALESCE(b.all_person, false)) THEN b.hold_reason
    END AS held_reason
  FROM base b
),
judged AS (
  -- A decision nobody is recorded as making is not settled: it reads
  -- placed_unconfirmed, never confirmed or confirmed_overhead with a blank
  -- decided_by.
  SELECT j.*,
         CASE WHEN j.state0 IN ('confirmed', 'confirmed_overhead') AND j.decider IS NULL
              THEN 'placed_unconfirmed' ELSE j.state0 END AS state
  FROM judged0 j
)
SELECT
  'cfo-recon-outcome-v1'::text AS contract_version,
  'xero_accpay'::text AS subject_kind,
  j.xero_invoice_id,
  j.invoice_number,
  j.bill_status,
  j.state,
  (j.state IN ('confirmed', 'confirmed_overhead')) AS confirmed,
  j.parts,
  j.overhead_ex,
  CASE WHEN j.bill_ex IS NULL THEN NULL ELSE j.remainder_ex END AS remainder_ex,
  j.bill_ex,
  j.credit_applied_ex,
  -- Who made the deciding rows, as their writer stored it. Null unless confirmed.
  CASE WHEN j.state IN ('confirmed', 'confirmed_overhead') THEN j.decider END AS decided_by,
  CASE WHEN j.state IN ('confirmed', 'confirmed_overhead') THEN
    COALESCE(CASE WHEN j.queue_status IN ('assigned', 'split', 'not_job_related') THEN j.queue_at END, j.fact_at)
  END AS decided_at,
  md5(jsonb_build_array(
    'cfo-recon-outcome-v1',
    j.xero_invoice_id,
    j.status_class,
    j.bill_ex,
    j.line_items,
    j.credit_applied_ex,
    j.parts,
    j.overhead_ex,
    j.queue_status
  )::text) AS evidence_hash,
  -- 20261021213000: null unless the bill reads unknown because the engine
  -- does not count what parts show: labour_part_unconfirmed,
  -- overhead_on_xero_linked_bill or xero_link_not_counted.
  NULL::text AS held_reason
FROM judged j;

