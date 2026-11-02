-- Supplier credit netting into Job Profit (TP-07 slice 2), 30 Oct 2026.
-- Plan: 08-path-to-trusted-profit, ticket TP-07 ("each supplier credit note is
-- placed on the job of the bill it reverses, and netted from that job's cost
-- once"). Slice 1 (20261030010000) copied the credit notes and their
-- allocations from Xero and changed no money figure. This slice nets them.
--
-- The one-side rule (the custodian's call, open to the CFO):
--   An allocation of a credit note to a bill is one credit, which Xero shows
--   twice: on the credit note (its Allocations list, slice 1's copy) and on the
--   bill (the bill's own CreditNotes list or AmountCredited, which CFO-20,
--   20261020181800, already takes off the job's cost). Job Profit counts each
--   allocation once, from one side:
--     * the bill side, unchanged, whenever the bill's copy counts it: the
--       bill's CreditNotes list names this credit note (bill_side counts_it),
--       or the bill's list cannot decide and its AmountCredited does
--       (bill_side amount_credited: Xero's total for every credit note on
--       the bill, so no single one can be told apart; the credit note side
--       then counts none of that bill's allocations);
--     * the credit note side only where the bill's copy does not count it: the
--       bill shows no credit at all (bill_side none), or its list decides and
--       does not name this credit note (bill_side not_this_one). Then the
--       allocation is taken off every row the bill has in Job Profit (its
--       lines on its Xero job, or its allocation rows when split or moved),
--       row ex GST x allocation / bill total, rounded per row: CFO-20's own
--       rule, so a credit counted from either side lands on the same rows at
--       the same figure (for one allocation, to the cent).
--   Never both. When the credit note side and the bill side together would
--   credit a bill above its total (two copies out of step), the credit note
--   side counts none of that bill's allocations (exceeds_bill) and shows them.
--
-- What stays unplaced, never moving a job figure, never read as $0, each with
-- its reason (v_supplier_credit_placement): credit left on the note
-- (unallocated, or remaining_unknown when Xero did not send it), a note whose
-- list Xero did not return (allocations_not_read), a note that is not live, a
-- deleted allocation, an allocation with no amount (amount_unknown) or of 0 or
-- less (amount_not_positive), a bill not in our copy, not live, with no total,
-- or not placed on any job, a crew bill (crew_bill, below) and cash refunded
-- on the note (cash_refund, from the note's own Payments list). No credit
-- note is placed by any clue other than its allocation's bill.
--
-- Crew bills: a bill the trade app already counts as labour (a trade-app
-- mirror bill: materials_ai_trade_mirror, the job profit engine's own test) is
-- never a supplier row in Job Profit: its cost comes from the trade invoice's
-- lines (document trade_invoices.id), and its Xero total is the trade's
-- payable (gross less the worker's super withhold and any recurring
-- deduction, plus GST), not the cost on the job. So "bill row x allocation /
-- bill total" has no row to work on and no total that matches the cost, and
-- CFO-20 never credits these bills either. Its allocations stay unplaced,
-- reason crew_bill, until the CFO says how a credit against crew pay lands.
--
-- 1. job_cost_credit_note_part(row ex, allocation, bill total): the per-row
--    part, round(row ex x allocation / bill total, 2); null when the bill
--    total is not above 0.
-- 2. v_supplier_credit_allocations: one row per allocation, how the bill's own
--    copy treats it (bill_side) and whether Job Profit counts it from the
--    credit note (counts_from_credit_note). The one rule for "which side".
-- 3. v_job_cost_events: 20261028173000's body unchanged, plus credit_note
--    rows: source supplier_credit (installer_bill_unconfirmed or
--    installer_bill_not_job_related while the bill's own row is held, as
--    CFO-20 does), negative, match_method xero_credit_note, one per bill row
--    and allocation counted from the credit note, dated and documented as the
--    bill row it reduces. v_job_profit sums them with no change of its own.
-- 4. v_supplier_credit_placement: slice 1's twenty columns, same meaning,
--    plus bill_side, job_profit (counted_from_credit_note, counted_by_bill,
--    bill_amount_credited, exceeds_bill, not_counted), counted_ex (what Job
--    Profit takes off this job's actual cost for this allocation from the
--    credit note) and part_key (one key per part of a note, for sums). New
--    unplaced states crew_bill, amount_not_positive and cash_refund.
--    credit_ex is now the sum of the per-row parts, so it equals the rows
--    Job Profit carries (slice 1 rounded the job's sum once).
-- 5. xero_tieout_monthly: TP-01's bills tie-out unchanged; once xero-sync has
--    finished a full read of the org's supplier credit notes
--    (xero_sync_state supplier_credit_notes_full:<org>:<tenant>), each month
--    also shows its supplier credit notes (by credit note date, inc GST as
--    Xero allocates, with the ex GST total): placed (and how Job Profit counts
--    it), not placed by reason, unallocated, refunded, and whether the parts
--    add up to the notes. Until then the answer is byte for byte TP-01's
--    (credit_notes not_yet_read). Credit notes are shown beside the bills
--    total, never netted from it.
--
-- No switch of its own: netting starts with the copy, which xero-sync fills
-- only while feature_flags.xero_supplier_credit_notes_v1 is on (slice 1,
-- seeded off). A job with no credit note row is untouched, row for row.
--
-- Columns checked against this repository's migrations, not the live schema:
-- xero_supplier_credit_notes and its allocations (20261030010000),
-- xero_invoices (20250301000003), xero_sync_state (20260910100000),
-- v_job_cost_events (20261028173000). The version was checked against this
-- branch and the open branches' migrations, not the live ledger: check it
-- against supabase_migrations.schema_migrations before merge.
--
-- Order: roll this migration back before 20261030010000's down (it reads the
-- copy tables; that down refuses while this placement view is live) and
-- before any down that replaces v_job_cost_events or the tie-out.
-- Rollback: supabase/rollbacks/20261030060000_supplier_credit_netting_down.sql
-- Contract: supabase/tests/migration-contracts/20261030060000_supplier_credit_netting/

-- ─────────────────────────────────────────────────────────────
-- 0. Guard: read what is there before changing anything. Reports every
--    problem at once. v_job_cost_events must be 20261028173000's body (or
--    this migration's: a re-apply); the placement view slice 1's (or this
--    migration's); the tie-out TP-01's (or this migration's).
-- ─────────────────────────────────────────────────────────────
DO $guard$
DECLARE
  problems text[] := '{}';
  c text;
  jce_cols text;
  jce_comment text;
  jce_def text;
  cmt text;
BEGIN
  IF to_regclass('public.v_job_cost_events') IS NULL THEN
    problems := problems || 'public.v_job_cost_events is missing'::text;
  ELSE
    SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum) INTO jce_cols
      FROM pg_attribute a
     WHERE a.attrelid = 'public.v_job_cost_events'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
    IF jce_cols IS DISTINCT FROM 'job_id uuid, event_date date, lane text, lane_detail text, party_kind text, party_id text, party text, amount_ex numeric, source text, source_id text, document_id text, document_number text, document_status text, paid boolean, paid_on date, confidence text, is_actual boolean, description text, hours numeric, account_code text, business_unit text, match_method text, incomplete_invoice boolean' THEN
      problems := problems || ('public.v_job_cost_events columns are not 20261028173000''s: ' || COALESCE(jce_cols, '(none)'));
    END IF;
    jce_comment := COALESCE(obj_description('public.v_job_cost_events'::regclass, 'pg_class'), '');
    jce_def := pg_get_viewdef('public.v_job_cost_events'::regclass);
    IF jce_comment LIKE 'Job profit engine (20261009130000, CFO-12 20261019120000, CFO-18/20 20261020181800, TP-07 20261030060000):%' THEN
      NULL; -- this migration's own body: a re-apply
    ELSIF jce_comment NOT LIKE 'Job profit engine (20261009130000, CFO-12 20261019120000, CFO-18/20 20261020181800):%'
       OR jce_def NOT LIKE '%agent_ai%' OR jce_def LIKE '%xero_credit_note%' THEN
      problems := problems || 'public.v_job_cost_events is neither 20261028173000''s body nor this migration''s; build this body on the live one'::text;
    END IF;
  END IF;
  FOREACH c IN ARRAY ARRAY['public.xero_supplier_credit_notes', 'public.xero_supplier_credit_note_allocations'] LOOP
    IF to_regclass(c) IS NULL THEN
      problems := problems || (c || ' is missing (20261030010000 first)');
    ELSIF COALESCE(obj_description(to_regclass(c), 'pg_class'), '') NOT LIKE 'Supplier credit notes (20261030010000%' THEN
      problems := problems || (c || ' is not 20261030010000''s');
    END IF;
  END LOOP;
  IF to_regclass('public.v_supplier_credit_placement') IS NULL THEN
    problems := problems || 'public.v_supplier_credit_placement is missing (20261030010000 first)'::text;
  ELSE
    cmt := COALESCE(obj_description('public.v_supplier_credit_placement'::regclass, 'pg_class'), '');
    IF cmt NOT LIKE 'Supplier credit notes (20261030010000%' AND cmt NOT LIKE 'Supplier credit netting (20261030060000%' THEN
      problems := problems || 'public.v_supplier_credit_placement is neither 20261030010000''s nor this migration''s'::text;
    END IF;
  END IF;
  IF to_regclass('public.v_supplier_credit_allocations') IS NOT NULL
     AND COALESCE(obj_description(to_regclass('public.v_supplier_credit_allocations'), 'pg_class'), '') NOT LIKE 'Supplier credit netting (20261030060000%' THEN
    problems := problems || 'public.v_supplier_credit_allocations exists and is not this migration''s'::text;
  END IF;
  IF to_regprocedure('public.job_cost_credit_note_part(numeric,numeric,numeric)') IS NOT NULL
     AND COALESCE(obj_description(to_regprocedure('public.job_cost_credit_note_part(numeric,numeric,numeric)'), 'pg_proc'), '') NOT LIKE 'Supplier credit netting (20261030060000%' THEN
    problems := problems || 'public.job_cost_credit_note_part exists and is not this migration''s'::text;
  END IF;
  IF to_regprocedure('public.xero_tieout_monthly(date,integer,uuid)') IS NULL THEN
    problems := problems || 'public.xero_tieout_monthly is missing (20261029121500 first)'::text;
  ELSIF COALESCE(obj_description(to_regprocedure('public.xero_tieout_monthly(date,integer,uuid)'), 'pg_proc'), '') NOT LIKE 'TP-01 Xero tie-out (20261029121500)%' THEN
    problems := problems || 'public.xero_tieout_monthly is neither 20261029121500''s nor this migration''s'::text;
  END IF;
  FOREACH c IN ARRAY ARRAY['public.job_cost_credit_share(jsonb,numeric)', 'public.materials_ai_trade_mirror(text,jsonb)',
                           'public.job_profit_num(jsonb)', 'public.job_cost_installer_bill(jsonb)'] LOOP
    IF to_regprocedure(c) IS NULL THEN
      problems := problems || (c || ' is missing');
    END IF;
  END LOOP;
  FOREACH c IN ARRAY ARRAY['key', 'cursor_at'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'xero_sync_state' AND column_name = c) THEN
      problems := problems || ('public.xero_sync_state has no column ' || c);
    END IF;
  END LOOP;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'supplier_credit_netting_preimage_mismatch: %', array_to_string(problems, '; ');
  END IF;
END
$guard$;

-- ─────────────────────────────────────────────────────────────
-- 1. The per-row part of one allocation
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.job_cost_credit_note_part(p_row_ex numeric, p_allocation numeric, p_bill_total numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN p_bill_total > 0 THEN round(p_row_ex * p_allocation / p_bill_total, 2) END
$$;
COMMENT ON FUNCTION public.job_cost_credit_note_part(numeric, numeric, numeric) IS
  'Supplier credit netting (20261030060000, TP-07 slice 2): the part of one credit note allocation that lands on one Job Profit row of the bill it reverses: round(row ex GST x allocation / bill total, 2), CFO-20''s rule. Null when the bill total is not above 0 (never 0). No SET clause, so it inlines. Service role only.';
REVOKE ALL ON FUNCTION public.job_cost_credit_note_part(numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_cost_credit_note_part(numeric, numeric, numeric) TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 2. Which side counts each allocation (the one rule)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_supplier_credit_allocations AS
WITH alloc AS (
  SELECT
    n.org_id, n.xero_credit_note_id, n.credit_note_number, n.xero_contact_id, n.contact_name,
    n.credit_note_date, n.status AS credit_note_status,
    COALESCE(n.status IN ('AUTHORISED', 'PAID'), false) AS note_live,
    a.n AS allocation_n, a.allocation_id, a.xero_invoice_id, a.invoice_number, a.amount, a.allocation_date, a.is_deleted,
    x.xero_invoice_id IS NOT NULL AS bill_in_copy,
    x.status AS bill_status,
    x.total AS bill_total,
    x.line_items AS bill_line_items,
    -- What CFO-20 takes off the bill's rows (its share of the bill), and the
    -- same read with AmountCredited set aside: the two agree exactly when the
    -- bill's CreditNotes list decides (job_cost_credit_share's own rule).
    public.job_cost_credit_share(x.raw_json, x.total) AS bill_credit_share,
    public.job_cost_credit_share(x.raw_json - 'AmountCredited', x.total) AS bill_list_share,
    -- The same allocation as the bill's own copy lists it (slice 1's column).
    (SELECT sum(public.job_profit_num(c.value -> 'AppliedAmount'))
       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.raw_json -> 'CreditNotes') = 'array' THEN x.raw_json -> 'CreditNotes' ELSE '[]'::jsonb END) c
      WHERE COALESCE(c.value ->> 'CreditNoteID', c.value ->> 'ID') = a.xero_credit_note_id) AS bill_side_applied,
    EXISTS (SELECT 1
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.raw_json -> 'CreditNotes') = 'array' THEN x.raw_json -> 'CreditNotes' ELSE '[]'::jsonb END) c
             WHERE COALESCE(c.value ->> 'CreditNoteID', c.value ->> 'ID') = a.xero_credit_note_id) AS bill_lists_note
  FROM public.xero_supplier_credit_notes n
  JOIN public.xero_supplier_credit_note_allocations a
    ON a.org_id = n.org_id AND a.xero_credit_note_id = n.xero_credit_note_id
  LEFT JOIN public.xero_invoices x
    ON x.org_id = a.org_id AND x.xero_invoice_id = a.xero_invoice_id AND x.invoice_type = 'ACCPAY'
  WHERE n.allocations_returned
),
judged AS (
  SELECT a.*,
    CASE
      WHEN NOT a.bill_in_copy THEN NULL
      WHEN COALESCE(a.bill_credit_share, 0) <= 0 THEN 'none'
      WHEN a.bill_list_share = a.bill_credit_share AND a.bill_lists_note THEN 'counts_it'
      WHEN a.bill_list_share = a.bill_credit_share THEN 'not_this_one'
      ELSE 'amount_credited'
    END AS bill_side,
    CASE
      WHEN NOT a.note_live THEN 'credit_note_not_live'
      WHEN a.is_deleted THEN 'allocation_deleted'
      WHEN a.amount IS NULL THEN 'amount_unknown'
      WHEN a.amount <= 0 THEN 'amount_not_positive'
      WHEN NOT a.bill_in_copy THEN 'bill_not_in_copy'
      WHEN a.bill_status IS NULL OR a.bill_status NOT IN ('AUTHORISED', 'PAID') THEN 'bill_not_live'
      WHEN a.bill_total IS NULL OR a.bill_total <= 0 THEN 'bill_total_unknown'
      WHEN public.materials_ai_trade_mirror(a.xero_invoice_id, a.bill_line_items) THEN 'crew_bill'
      ELSE 'bill_live'
    END AS state,
    round(COALESCE(a.bill_credit_share, 0) * a.bill_total, 2) AS bill_credit_inc
  FROM alloc a
),
candidate AS (
  SELECT j.*,
    (j.state = 'bill_live' AND j.bill_side IN ('none', 'not_this_one')) AS from_note,
    -- The bill's credit the bill's copy already counts, plus every live
    -- allocation the credit note side would count on it.
    j.bill_credit_inc
      + COALESCE(sum(j.amount) FILTER (WHERE j.state = 'bill_live' AND j.bill_side IN ('none', 'not_this_one'))
                   OVER (PARTITION BY j.org_id, j.xero_invoice_id), 0) AS credit_on_bill_inc
  FROM judged j
)
SELECT
  c.org_id, c.xero_credit_note_id, c.credit_note_number, c.xero_contact_id, c.contact_name, c.credit_note_date,
  c.credit_note_status, c.allocation_n, c.allocation_id, c.xero_invoice_id, c.invoice_number, c.allocation_date,
  c.amount, c.is_deleted, c.bill_status, c.bill_total, c.bill_side_applied, c.bill_side, c.state,
  c.bill_credit_inc, c.credit_on_bill_inc,
  COALESCE(c.from_note AND c.credit_on_bill_inc > c.bill_total, false) AS exceeds_bill,
  COALESCE(c.from_note AND c.credit_on_bill_inc <= c.bill_total, false) AS counts_from_credit_note
FROM candidate c;
COMMENT ON VIEW public.v_supplier_credit_allocations IS
  'Supplier credit netting (20261030060000, TP-07 slice 2): one row per supplier credit note allocation (slice 1''s copy), the one rule for which side counts it. bill_side: how the bill''s own copy treats it (null: bill not in our copy; none: the bill shows no credit; counts_it: the bill''s CreditNotes list decides and names this note, so CFO-20 already takes it off; not_this_one: the list decides and does not name it; amount_credited: the list cannot decide and AmountCredited does, every note together, so the bill side counts them all). state: credit_note_not_live, allocation_deleted, amount_unknown, amount_not_positive, bill_not_in_copy, bill_not_live, bill_total_unknown, crew_bill (a trade-app mirror bill: its cost comes from the trade invoice''s lines, never a supplier row) or bill_live. counts_from_credit_note: bill_live, bill_side none or not_this_one, and the bill''s own credit plus those allocations stays within the bill total (else exceeds_bill and none of them is counted). Amounts inc GST as Xero allocates them. Read by v_job_cost_events and v_supplier_credit_placement. Read only, service role only.';
REVOKE ALL ON public.v_supplier_credit_allocations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_supplier_credit_allocations TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 3. v_job_cost_events: 20261028173000's body, plus credit_note (marked TP-07)
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
    public.job_cost_credit_share(x.raw_json, x.total) AS credit_share,
    -- JP-12: an installer bill counts on its Xero job only once a person
    -- placed it there; one a person marked not job related never counts.
    CASE
      WHEN NOT public.job_cost_installer_bill(x.line_items) THEN 'not_installer'
      WHEN EXISTS (SELECT 1 FROM public.job_materials_facts f
                    WHERE f.xero_invoice_id = x.xero_invoice_id AND f.job_id = x.job_id
                      AND f.automation_source IN ('manual_queue', 'agent_ai')) THEN 'confirmed'
      WHEN EXISTS (SELECT 1 FROM public.materials_reconciliation_queue q
                    WHERE q.xero_invoice_id = x.xero_invoice_id AND q.status = 'not_job_related') THEN 'not_job_related'
      ELSE 'unconfirmed'
    END AS installer_state
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
    CASE b.installer_state
      WHEN 'unconfirmed' THEN 'installer_bill_unconfirmed'
      WHEN 'not_job_related' THEN 'installer_bill_not_job_related'
      ELSE 'supplier_bill'
    END AS source,
    b.xero_invoice_id || ':' || b.n AS source_id,
    b.xero_invoice_id AS document_id,
    b.invoice_number AS document_number,
    b.status AS document_status,
    (b.status = 'PAID') AS paid,
    b.fully_paid_on AS paid_on,
    CASE b.installer_state
      WHEN 'unconfirmed' THEN 'awaiting_confirmation'
      WHEN 'not_job_related' THEN 'person_marked_not_job_related'
      ELSE 'high'
    END AS confidence,
    b.installer_state NOT IN ('unconfirmed', 'not_job_related') AS is_actual,
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
    public.job_cost_credit_share(x.raw_json, x.total) AS credit_share,
    -- JP-12: installer labour placed by anything but a person is not confirmed.
    (COALESCE(f.automation_source, '') NOT IN ('manual_queue', 'manual_split', 'agent_ai')
      AND (f.lane = 'labour' OR public.job_cost_installer_bill(x.line_items))) AS installer_unconfirmed
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
  SELECT job_id, event_date, lane, lane_detail, party_kind, party_id, party, amount_ex,
         CASE WHEN installer_unconfirmed THEN 'installer_bill_unconfirmed' ELSE source END AS source,
         source_id, document_id, document_number, document_status, paid, paid_on,
         CASE WHEN installer_unconfirmed THEN 'awaiting_confirmation' ELSE confidence END AS confidence,
         NOT installer_unconfirmed AS is_actual,
         description, hours, account_code, business_unit, match_method, incomplete_invoice
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
    CASE WHEN s.is_actual THEN 'supplier_credit' ELSE s.source END AS source,
    s.source_id || ':credit' AS source_id,
    s.document_id,
    s.document_number,
    s.document_status,
    s.paid,
    s.paid_on,
    s.confidence,
    s.is_actual,
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
    CASE WHEN f.installer_unconfirmed THEN 'installer_bill_unconfirmed' ELSE 'supplier_credit' END AS source,
    f.source_id || ':credit' AS source_id,
    f.document_id, f.document_number, f.document_status, f.paid, f.paid_on,
    CASE WHEN f.installer_unconfirmed THEN 'awaiting_confirmation' ELSE f.confidence END AS confidence,
    NOT f.installer_unconfirmed AS is_actual,
    'Credit applied in Xero' AS description,
    NULL::numeric AS hours, f.account_code, f.business_unit,
    'xero_amount_credited'::text AS match_method,
    false AS incomplete_invoice
  FROM fact_base f
  WHERE f.bill_live AND f.credit_share > 0 AND f.amount_ex <> 0
),
-- TP-07 (20261030060000): a supplier credit note allocated in Xero to this
-- bill, counted from the credit note only where the bill's own copy does not
-- count it (v_supplier_credit_allocations.counts_from_credit_note): taken off
-- every row the bill has here, row ex GST x allocation / bill total, rounded
-- per row (CFO-20's rule). Same lane, party, document, date and actual or
-- held state as the bill row it reduces.
credit_note AS (
  SELECT
    s.job_id,
    s.event_date,
    s.lane,
    s.lane_detail,
    s.party_kind,
    s.party_id,
    s.party,
    -public.job_cost_credit_note_part(s.amount_ex, a.amount, a.bill_total) AS amount_ex,
    CASE WHEN s.is_actual THEN 'supplier_credit' ELSE s.source END AS source,
    s.source_id || ':credit_note:' || a.xero_credit_note_id || ':' || a.allocation_n AS source_id,
    s.document_id,
    s.document_number,
    s.document_status,
    s.paid,
    s.paid_on,
    s.confidence,
    s.is_actual,
    'Supplier credit note ' || COALESCE(a.credit_note_number, '(no number)') || ' applied in Xero' AS description,
    NULL::numeric AS hours,
    s.account_code,
    s.business_unit,
    'xero_credit_note'::text AS match_method,
    false AS incomplete_invoice
  FROM (SELECT * FROM supplier UNION ALL SELECT * FROM fact) s
  JOIN public.v_supplier_credit_allocations a
    ON a.xero_invoice_id = s.document_id AND a.counts_from_credit_note
  WHERE s.amount_ex <> 0
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
UNION ALL SELECT * FROM credit_note
UNION ALL SELECT * FROM po;


COMMENT ON VIEW public.v_job_cost_events IS
  'Job profit engine (20261009130000, CFO-12 20261019120000, CFO-18/20 20261020181800, TP-07 20261030060000): one row per job cost, lane labour/materials/commission/other, source trade_line/supplier_bill/materials_fact/supplier_credit/installer_bill_unconfirmed/installer_bill_not_job_related/po_committed/po_ordered/po_invoice_emailed. A bill with an allocation row on another job is read through its rows only. supplier_credit is credit applied in Xero against a live bill, negative, in proportion. An installer bill (306/301) counts only once a person or the AI bill reader (agent_ai, 20261028173000) placed it on the job (JP-12): until then it is installer_bill_unconfirmed (and its credit too), and one a person marked not job related is installer_bill_not_job_related; neither is ever actual. The three po_ sources are never actual. TP-07 (20261030060000): a supplier credit note allocated in Xero to a live bill is also supplier_credit (match_method xero_credit_note, source_id <bill row>:credit_note:<note>:<n>), taken off the bill''s rows at the same rule, only where the bill''s own copy does not already count it (v_supplier_credit_allocations), so each allocation is counted once; a crew (trade-app mirror) bill never. Read only, service role only.';
REVOKE ALL ON public.v_job_cost_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_job_cost_events TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 4. Where each part of a credit note lands, and who counts it (read only)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_supplier_credit_placement
WITH (security_invoker = true) AS
WITH note AS (
  SELECT n.*, COALESCE(n.status IN ('AUTHORISED', 'PAID'), false) AS live
  FROM public.xero_supplier_credit_notes n
),
alloc AS (
  SELECT a.*
  FROM public.v_supplier_credit_allocations a
),
-- The bill's placement in Job Profit: its own supplier rows (never a credit
-- row of either side). Ex GST, as v_job_cost_events carries them.
bill_row AS (
  SELECT e.document_id AS xero_invoice_id, e.job_id, e.amount_ex, e.is_actual
  FROM public.v_job_cost_events e
  WHERE e.party_kind = 'supplier'
    AND e.match_method IS DISTINCT FROM 'xero_amount_credited'
    AND e.match_method IS DISTINCT FROM 'xero_credit_note'
    AND e.source IN ('supplier_bill', 'materials_fact', 'installer_bill_unconfirmed', 'installer_bill_not_job_related')
    AND e.job_id IS NOT NULL
    AND e.document_id IN (SELECT a.xero_invoice_id FROM public.xero_supplier_credit_note_allocations a)
),
-- Per allocation and job: the bill's part and the allocation's part, summed
-- row by row exactly as v_job_cost_events' credit_note rows are.
part AS (
  SELECT a.org_id, a.xero_credit_note_id, a.allocation_n, r.job_id,
         sum(r.amount_ex) AS part_ex,
         bool_and(r.is_actual) AS part_is_actual,
         sum(public.job_cost_credit_note_part(r.amount_ex, a.amount, a.bill_total)) FILTER (WHERE r.amount_ex <> 0) AS credit_ex,
         sum(public.job_cost_credit_note_part(r.amount_ex, a.amount, a.bill_total)) FILTER (WHERE r.amount_ex <> 0 AND r.is_actual) AS actual_credit_ex
  FROM alloc a
  JOIN bill_row r ON r.xero_invoice_id = a.xero_invoice_id
  WHERE a.state = 'bill_live'
  GROUP BY a.org_id, a.xero_credit_note_id, a.allocation_n, r.job_id
),
judged AS (
  SELECT a.*,
    CASE
      WHEN a.state <> 'bill_live' THEN a.state
      WHEN NOT EXISTS (SELECT 1 FROM part p
                        WHERE p.org_id = a.org_id AND p.xero_credit_note_id = a.xero_credit_note_id
                          AND p.allocation_n = a.allocation_n) THEN 'bill_not_placed'
      ELSE 'placed'
    END AS place_state
  FROM alloc a
),
-- Cash Xero refunded on a live note (its own Payments list), never placed.
refund AS (
  SELECT n.org_id, n.xero_credit_note_id, n.credit_note_number, n.xero_contact_id, n.contact_name, n.credit_note_date,
         n.status, p.ord, p.value ->> 'PaymentID' AS payment_id,
         public.job_profit_num(p.value -> 'Amount') AS amount,
         CASE
           WHEN COALESCE(p.value ->> 'DateString', p.value ->> 'Date') ~ '^\d{4}-\d{2}-\d{2}'
             THEN left(COALESCE(p.value ->> 'DateString', p.value ->> 'Date'), 10)::date
           WHEN p.value ->> 'Date' ~ '^/Date\(-?\d+'
             THEN (to_timestamp(substring(p.value ->> 'Date' FROM '^/Date\((-?\d+)')::bigint / 1000.0) AT TIME ZONE 'UTC')::date
         END AS refund_date
  FROM note n
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(n.raw_json -> 'Payments') = 'array' THEN n.raw_json -> 'Payments' ELSE '[]'::jsonb END)
       WITH ORDINALITY AS p(value, ord)
  WHERE n.live
    AND upper(COALESCE(p.value ->> 'Status', '')) <> 'DELETED'
)
-- Placed: one row per job the reversed bill sits on.
SELECT j.org_id, j.xero_credit_note_id, j.credit_note_number, j.xero_contact_id, j.contact_name, j.credit_note_date,
       j.credit_note_status, j.allocation_n, j.allocation_id, j.xero_invoice_id, j.invoice_number, j.bill_status,
       j.allocation_date, j.amount::numeric AS amount, 'placed'::text AS state,
       p.job_id, p.part_ex::numeric AS bill_part_ex, p.credit_ex::numeric AS credit_ex,
       p.part_is_actual, j.bill_side_applied::numeric AS bill_side_applied,
       j.bill_side,
       CASE
         WHEN j.counts_from_credit_note THEN 'counted_from_credit_note'
         WHEN j.exceeds_bill THEN 'exceeds_bill'
         WHEN j.bill_side = 'counts_it' THEN 'counted_by_bill'
         ELSE 'bill_amount_credited'
       END AS job_profit,
       CASE WHEN j.counts_from_credit_note THEN COALESCE(p.actual_credit_ex, 0) END::numeric AS counted_ex,
       'allocation:' || j.allocation_n AS part_key
  FROM judged j
  JOIN part p ON p.org_id = j.org_id AND p.xero_credit_note_id = j.xero_credit_note_id AND p.allocation_n = j.allocation_n
 WHERE j.place_state = 'placed'
UNION ALL
-- Every other allocation: no job, its reason.
SELECT j.org_id, j.xero_credit_note_id, j.credit_note_number, j.xero_contact_id, j.contact_name, j.credit_note_date,
       j.credit_note_status, j.allocation_n, j.allocation_id, j.xero_invoice_id, j.invoice_number, j.bill_status,
       j.allocation_date, j.amount, j.place_state,
       NULL::uuid, NULL::numeric, NULL::numeric, NULL::boolean, j.bill_side_applied,
       j.bill_side, 'not_counted'::text, NULL::numeric, 'allocation:' || j.allocation_n
  FROM judged j
 WHERE j.place_state <> 'placed'
UNION ALL
-- Credit still on a live note: on no bill and no job, its amount shown
-- (Xero's RemainingCredit), or unknown when Xero did not send it.
SELECT n.org_id, n.xero_credit_note_id, n.credit_note_number, n.xero_contact_id, n.contact_name, n.credit_note_date,
       n.status, NULL::integer, NULL::text, NULL::text, NULL::text, NULL::text,
       NULL::date, n.remaining_credit,
       CASE WHEN n.remaining_credit IS NULL THEN 'remaining_unknown' ELSE 'unallocated' END,
       NULL::uuid, NULL::numeric, NULL::numeric, NULL::boolean, NULL::numeric,
       NULL::text, 'not_counted'::text, NULL::numeric, 'remaining'::text
  FROM note n
 WHERE n.live AND (n.remaining_credit IS NULL OR n.remaining_credit > 0)
UNION ALL
-- A live note whose record came without its Allocations list.
SELECT n.org_id, n.xero_credit_note_id, n.credit_note_number, n.xero_contact_id, n.contact_name, n.credit_note_date,
       n.status, NULL::integer, NULL::text, NULL::text, NULL::text, NULL::text,
       NULL::date, NULL::numeric, 'allocations_not_read'::text,
       NULL::uuid, NULL::numeric, NULL::numeric, NULL::boolean, NULL::numeric,
       NULL::text, 'not_counted'::text, NULL::numeric, 'allocations_not_read'::text
  FROM note n
 WHERE n.live AND NOT n.allocations_returned
UNION ALL
-- Cash refunded on a live note: on no bill and no job. allocation_id is the
-- Xero PaymentID, allocation_date the refund's day; amount unknown when Xero
-- sent none, never $0.
SELECT r.org_id, r.xero_credit_note_id, r.credit_note_number, r.xero_contact_id, r.contact_name, r.credit_note_date,
       r.status, NULL::integer, r.payment_id, NULL::text, NULL::text, NULL::text,
       r.refund_date, r.amount, 'cash_refund'::text,
       NULL::uuid, NULL::numeric, NULL::numeric, NULL::boolean, NULL::numeric,
       NULL::text, 'not_counted'::text, NULL::numeric, 'refund:' || r.ord
  FROM refund r;
COMMENT ON VIEW public.v_supplier_credit_placement IS
  'Supplier credit netting (20261030060000, TP-07 slice 2; slice 1 20261030010000): where each part of a supplier credit note lands and whether Job Profit counts it. state placed: one row per job the reversed bill sits on in Job Profit (v_job_cost_events'' supplier rows for that bill), bill_part_ex the bill''s part there, credit_ex the allocation''s part (row ex GST x allocation / bill total, per row, CFO-20''s rule). Every other row has no job and job_profit not_counted: unallocated (credit left on a live note, Xero''s RemainingCredit, never $0), remaining_unknown, allocations_not_read, cash_refund (the note''s Payments list; allocation_id is the PaymentID, allocation_date the refund day, amount unknown when not sent), credit_note_not_live, allocation_deleted, amount_unknown, amount_not_positive, bill_not_in_copy, bill_not_live, bill_total_unknown, crew_bill (a trade-app mirror bill: no supplier row, its cost is the trade invoice''s lines), bill_not_placed. On a placed row job_profit says who counts it: counted_from_credit_note (v_job_cost_events credit_note rows; counted_ex is what comes off this job''s actual cost, less any part of the bill held there for confirmation), counted_by_bill (the bill''s own CreditNotes list names this note: CFO-20 counts it), bill_amount_credited (the bill''s AmountCredited counts every note on it together), exceeds_bill (the bill''s credit and these allocations would pass its total: not counted). bill_side as v_supplier_credit_allocations; bill_side_applied as the bill''s copy lists it. part_key: one key per part of a note (allocation:<n>, remaining, allocations_not_read, refund:<n>). Amounts inc GST as Xero allocates them; bill_part_ex, credit_ex and counted_ex ex GST. Read only, service role only.';
REVOKE ALL ON public.v_supplier_credit_placement FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_supplier_credit_placement TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 5. The TP-01 tie-out: bills unchanged, supplier credit notes once read
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.xero_tieout_monthly(p_as_of date DEFAULT NULL, p_months integer DEFAULT 12, p_org_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH win AS (
    SELECT a.as_of,
           m.months,
           (date_trunc('month', a.as_of) - make_interval(months => m.months - 1))::date AS from_month,
           (date_trunc('month', a.as_of) + interval '1 month')::date AS to_excl,
           (date_trunc('month', a.as_of) - interval '5 months')::date AS six_from
      FROM (SELECT COALESCE(p_as_of, (now() AT TIME ZONE 'Australia/Perth')::date) AS as_of) a,
           (SELECT GREATEST(1, LEAST(COALESCE(p_months, 12), 120)) AS months) m
  ),
  bills AS (
    SELECT DISTINCT ON (x.org_id, x.xero_invoice_id)
           x.org_id, x.xero_invoice_id, x.status, x.invoice_date, x.job_id, x.line_items,
           round(x.sub_total, 2) AS bill_ex, round(x.total, 2) AS bill_inc
      FROM public.xero_invoices x
     WHERE x.invoice_type = 'ACCPAY'
       AND x.xero_invoice_id IS NOT NULL
       AND (p_org_id IS NULL OR x.org_id = p_org_id)
     ORDER BY x.org_id, x.xero_invoice_id, (x.status IN ('AUTHORISED', 'PAID')) DESC
  ),
  b1 AS (
    SELECT b.org_id, b.xero_invoice_id, b.invoice_date, b.bill_ex, b.bill_inc,
           date_trunc('month', b.invoice_date)::date AS month,
           -- In the total: a bill of 0 or more. Below 0: negative_bill only.
           (b.bill_ex IS NOT NULL AND b.bill_ex >= 0) AS counted,
           (b.bill_ex IS NOT NULL AND b.bill_ex < 0) AS negative,
           public.materials_ai_trade_mirror(b.xero_invoice_id, b.line_items) AS mirror,
           public.job_cost_installer_bill(b.line_items) AS installer,
           q.status AS queue_status,
           round(GREATEST(COALESCE(q.overhead_ex, 0), 0), 2) AS overhead_part,
           COALESCE(a.n, 0) AS row_count,
           round(COALESCE(a.job_rows_ex, 0), 2) AS job_rows_ex,
           round(COALESCE(a.hold_rows_ex, 0), 2) AS hold_rows_ex,
           COALESCE(a.person_placed, false) AS person_placed,
           CASE WHEN b.job_id IS NULL THEN 'none'
                WHEN xj.id IS NULL THEN 'unknown_job'
                WHEN lower(COALESCE(xj.metadata ->> 'do_not_schedule', '')) = 'true' THEN 'holding'
                ELSE 'job' END AS xero_link
      FROM bills b
      -- The bill's allocation rows, summed per bill (so no bill is counted
      -- twice). A row with no org is read as its bill's org.
      LEFT JOIN LATERAL (
        SELECT count(*) AS n,
               sum(f.amount_ex_gst) FILTER (WHERE NOT f.hold) AS job_rows_ex,
               sum(f.amount_ex_gst) FILTER (WHERE f.hold) AS hold_rows_ex,
               bool_or(f.automation_source IN ('manual_queue', 'manual_split', 'agent_ai')) AS person_placed
          FROM (SELECT f.amount_ex_gst, f.automation_source,
                       lower(COALESCE(j.metadata ->> 'do_not_schedule', '')) = 'true' AS hold
                  FROM public.job_materials_facts f
                  LEFT JOIN public.jobs j ON j.id = f.job_id
                 WHERE f.kind = 'actual'
                   AND f.xero_invoice_id = b.xero_invoice_id
                   AND COALESCE(f.org_id, b.org_id) = b.org_id) f
      ) a ON true
      LEFT JOIN public.materials_reconciliation_queue q ON q.org_id = b.org_id AND q.xero_invoice_id = b.xero_invoice_id
      LEFT JOIN public.jobs xj ON xj.id = b.job_id
     CROSS JOIN win
     WHERE b.status IN ('AUTHORISED', 'PAID')
       -- Only the months read (and undated bills, so none is silently dropped).
       AND (b.invoice_date IS NULL
            OR (b.invoice_date >= LEAST(win.from_month, win.six_from) AND b.invoice_date < win.to_excl))
  ),
  b2 AS (
    SELECT b1.*,
           (row_count > 0 OR overhead_part > 0) AS by_rows,
           -- JP-12: a machine's installer placement is not on a job yet.
           (installer AND NOT person_placed AND overhead_part = 0) AS installer_gate
      FROM b1
  ),
  b3 AS (
    SELECT b2.*,
           -- Overhead first, capped at the bill.
           CASE WHEN NOT counted OR mirror THEN 0
                WHEN by_rows THEN LEAST(overhead_part, bill_ex)
                WHEN queue_status = 'not_job_related' THEN bill_ex
                ELSE 0 END AS overhead_ex,
           CASE WHEN NOT counted OR mirror THEN 0
                WHEN by_rows THEN CASE WHEN installer_gate THEN 0 ELSE GREATEST(job_rows_ex, 0) END
                WHEN queue_status = 'not_job_related' THEN 0
                WHEN xero_link = 'job' AND NOT installer_gate THEN bill_ex
                ELSE 0 END AS job_basis,
           -- Everything the rows (summed with their signs) and the overhead part
           -- claim, above the bill. A trade-app labour bill is read whole and its
           -- rows are not read, so it is never over allocated.
           CASE WHEN counted AND NOT mirror AND by_rows
                THEN GREATEST(job_rows_ex + hold_rows_ex + overhead_part - bill_ex, 0)
                ELSE 0 END AS over_ex
      FROM b2
  ),
  b4 AS (
    SELECT b3.*,
           CASE WHEN counted AND mirror THEN bill_ex ELSE 0 END AS mirror_ex,
           -- Job rows next, capped at what overhead left of the bill.
           LEAST(job_basis, CASE WHEN counted THEN bill_ex - overhead_ex ELSE 0 END) AS on_job_ex
      FROM b3
  ),
  placed AS (
    SELECT b4.*,
           CASE WHEN NOT counted OR mirror THEN 0
                ELSE bill_ex - overhead_ex - on_job_ex END AS unplaced_ex
      FROM b4
  ),
  sorted AS (
    SELECT p.*,
           CASE WHEN p.unplaced_ex = 0 THEN NULL
                WHEN p.installer_gate AND (p.job_rows_ex > 0 OR (NOT p.by_rows AND p.xero_link = 'job')) THEN 'installer_awaiting_confirmation'
                WHEN p.hold_rows_ex > 0 OR (NOT p.by_rows AND p.xero_link = 'holding') THEN 'holding_job'
                WHEN p.queue_status = 'open' THEN 'waiting_in_bills_to_place'
                WHEN p.queue_status IS NULL AND NOT p.by_rows THEN 'not_in_intake'
                ELSE 'rows_short_of_bill' END AS unplaced_reason
      FROM placed p
  ),
  months AS (
    SELECT g::date AS month
      FROM win, generate_series(win.from_month::timestamp, (win.to_excl - 1)::timestamp, interval '1 month') g
  ),
  -- The month's bills read straight from the copy, not through any join, for
  -- parts_add_up.
  direct AS (
    SELECT date_trunc('month', b.invoice_date)::date AS month, sum(b.bill_ex) AS ex
      FROM bills b
     WHERE b.status IN ('AUTHORISED', 'PAID') AND b.bill_ex >= 0
     GROUP BY 1
  ),
  not_counted AS (
    SELECT date_trunc('month', b.invoice_date)::date AS month, count(*) AS n, sum(b.bill_ex) AS ex
      FROM bills b
     WHERE b.status IN ('DRAFT', 'SUBMITTED')
     GROUP BY 1
  ),
  spend AS (
    SELECT date_trunc('month', t.txn_date)::date AS month,
           count(*) AS n,
           CASE WHEN bool_and(t.sub_total IS NOT NULL) THEN sum(abs(t.sub_total)) END AS ex
      FROM public.xero_bank_transactions t
     WHERE t.txn_type = 'SPEND'
       AND upper(COALESCE(t.status, '')) NOT IN ('DELETED', 'VOIDED')
       AND (p_org_id IS NULL OR t.org_id = p_org_id)
     GROUP BY 1
  ),
  month_rows AS (
    SELECT m.month,
           count(s.xero_invoice_id) FILTER (WHERE s.counted OR s.bill_ex IS NULL) AS bills,
           COALESCE(sum(s.bill_ex) FILTER (WHERE s.counted), 0) AS total_ex,
           COALESCE(sum(s.bill_inc) FILTER (WHERE s.counted), 0) AS total_inc,
           count(s.xero_invoice_id) FILTER (WHERE s.bill_ex IS NULL) AS amount_unknown,
           COALESCE(sum(s.on_job_ex), 0) AS on_job_ex,
           COALESCE(sum(s.overhead_ex), 0) AS overhead_ex,
           COALESCE(sum(s.mirror_ex), 0) AS mirror_ex,
           COALESCE(sum(s.unplaced_ex), 0) AS unplaced_ex,
           COALESCE(sum(s.over_ex), 0) AS over_ex,
           count(s.xero_invoice_id) FILTER (WHERE s.over_ex > 0) AS over_bills,
           count(s.xero_invoice_id) FILTER (WHERE s.negative) AS neg_bills,
           COALESCE(sum(s.bill_ex) FILTER (WHERE s.negative), 0) AS neg_ex,
           COALESCE(sum(s.bill_inc) FILTER (WHERE s.negative), 0) AS neg_inc,
           COALESCE(sum(s.unplaced_ex) FILTER (WHERE s.unplaced_reason = 'waiting_in_bills_to_place'), 0) AS r_waiting,
           COALESCE(sum(s.unplaced_ex) FILTER (WHERE s.unplaced_reason = 'holding_job'), 0) AS r_holding,
           COALESCE(sum(s.unplaced_ex) FILTER (WHERE s.unplaced_reason = 'installer_awaiting_confirmation'), 0) AS r_installer,
           COALESCE(sum(s.unplaced_ex) FILTER (WHERE s.unplaced_reason = 'not_in_intake'), 0) AS r_not_in_intake,
           COALESCE(sum(s.unplaced_ex) FILTER (WHERE s.unplaced_reason = 'rows_short_of_bill'), 0) AS r_short
      FROM months m
      LEFT JOIN sorted s ON s.month = m.month
     GROUP BY m.month
  ),
  six AS (
    SELECT COALESCE(sum(s.bill_ex) FILTER (WHERE s.counted), 0) AS total_ex,
           COALESCE(sum(s.unplaced_ex), 0) AS unplaced_ex
      FROM sorted s, win
     WHERE s.invoice_date >= win.six_from AND s.invoice_date < win.to_excl
  ),
  -- TP-01's document (20261029121500), unchanged.
  tp01 AS (
  SELECT jsonb_build_object(
    'as_of', win.as_of,
    'as_of_reads', 'as_of picks the months shown and nothing else. Allocation rows, Bills to place states, overhead parts and holding-job marks are read as they are today, and bills as our copy of Xero holds them today (copy_synced_at).',
    'org_id', p_org_id,
    'months_shown', win.months,
    'from_month', win.from_month,
    'basis', 'ex GST, to the cent; supplier bills (ACCPAY) AUTHORISED or PAID in our copy of Xero, by invoice date; a bill below 0 is shown only as negative_bill',
    'covers', 'bills only',
    'complete', false,
    'copy_synced_at', (SELECT max(x.synced_at) FROM public.xero_invoices x
                        WHERE x.invoice_type = 'ACCPAY' AND (p_org_id IS NULL OR x.org_id = p_org_id)),
    'not_yet_read', jsonb_build_array(
      jsonb_build_object('part', 'supplier_credit_notes', 'ticket', 'TP-07',
        'why', 'Supplier credit notes (ACCPAYCREDIT) are not copied from Xero yet.'),
      jsonb_build_object('part', 'spend_money', 'ticket', 'TP-08',
        'why', 'Spend money and card spend are not in the bill intake yet. The bank copy holds only reconciled transactions from the last 90 days, so it is shown as a partial look and not counted.'),
      jsonb_build_object('part', 'stock_and_vehicles', 'ticket', 'TP-01',
        'why', 'No bill is marked stock or vehicle in our records yet. A bill a person filed as not job related is in overhead.')),
    'last_6_months', jsonb_build_object(
      'from', win.six_from,
      'to', (win.to_excl - 1),
      'bills_total_ex', six.total_ex,
      'unplaced_ex', six.unplaced_ex,
      'unplaced_share_of_bills', CASE WHEN six.total_ex > 0 THEN (ceil(six.unplaced_ex / six.total_ex * 10000) / 10000)::numeric(8,4) END,
      'accounted_share_of_bills', CASE WHEN six.total_ex > 0 THEN (1 - ceil(six.unplaced_ex / six.total_ex * 10000) / 10000)::numeric(8,4) END),
    'undated_bills', (SELECT jsonb_build_object('count', count(*) FILTER (WHERE NOT s.negative),
                                                'ex', COALESCE(sum(s.bill_ex) FILTER (WHERE s.counted), 0),
                                                'negative_bills', count(*) FILTER (WHERE s.negative))
                        FROM sorted s WHERE s.invoice_date IS NULL),
    'months', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'month', to_char(r.month, 'YYYY-MM'),
        'tie_out_total_ex', r.total_ex,
        'covers', 'bills only',
        'bills', jsonb_build_object(
          'count', r.bills,
          'total_ex', r.total_ex,
          'total_inc', r.total_inc,
          'amount_unknown_count', r.amount_unknown,
          'on_job_ex', r.on_job_ex,
          'trade_app_labour_ex', r.mirror_ex,
          'non_job', jsonb_build_object(
            'overhead_not_job_related_ex', r.overhead_ex,
            'stock_ex', NULL,
            'vehicles_ex', NULL,
            'stock_and_vehicles', 'not_yet_separated'),
          'unplaced_ex', r.unplaced_ex,
          'unplaced_share', CASE WHEN r.total_ex > 0 THEN (ceil(r.unplaced_ex / r.total_ex * 10000) / 10000)::numeric(8,4) END,
          'unplaced_by_reason', jsonb_build_object(
            'waiting_in_bills_to_place', r.r_waiting,
            'holding_job', r.r_holding,
            'installer_awaiting_confirmation', r.r_installer,
            'not_in_intake', r.r_not_in_intake,
            'rows_short_of_bill', r.r_short),
          'over_allocated', jsonb_build_object('bills', r.over_bills, 'ex', r.over_ex, 'counted', false,
            'reads', 'Per bill of 0 or more that is not trade-app labour: job rows + holding-job rows + overhead part - bill, when above 0. Rows are summed with their signs. A trade-app labour bill is read whole, so it is never over allocated.'),
          'negative_bill', jsonb_build_object('bills', r.neg_bills, 'ex', r.neg_ex, 'inc', r.neg_inc, 'counted', false),
          'parts_add_up', (r.on_job_ex + r.mirror_ex + r.overhead_ex + r.unplaced_ex = COALESCE(d.ex, 0)),
          'parts_check', 'on_job + trade_app_labour + overhead + unplaced against the bills read directly from the copy; unplaced is each bill''s remainder, so this catches a bill dropped or counted twice, not a mis-sorted dollar'),
        'not_counted', jsonb_build_object(
          'draft_or_submitted_bills', COALESCE(nc.n, 0),
          'draft_or_submitted_ex', COALESCE(nc.ex, 0)),
        'spend', jsonb_build_object(
          'status', 'not_yet_read',
          'ticket', 'TP-08',
          'amount_ex', NULL,
          'counted', false,
          'bank_copy_partial', jsonb_build_object(
            'rows', COALESCE(sp.n, 0),
            'ex', sp.ex,
            'note', 'Reconciled spend in the rolling 90-day bank copy only; includes supplier prepayments and overpayments; not placed; not counted.')),
        'credit_notes', jsonb_build_object(
          'status', 'not_yet_read',
          'ticket', 'TP-07',
          'amount_ex', NULL,
          'counted', false)
      ) ORDER BY r.month DESC), '[]'::jsonb)
      FROM month_rows r
      LEFT JOIN direct d ON d.month = r.month
      LEFT JOIN not_counted nc ON nc.month = r.month
      LEFT JOIN spend sp ON sp.month = r.month)
  ) AS doc
  FROM win, six
  ),
  -- TP-07 (20261030060000): the org's supplier credit notes, read only once
  -- xero-sync has finished a full read of them (supplier_credit_notes_full:
  -- <org>:<tenant>); with no org, once every org with a bill in the copy has.
  cn_orgs AS (
    SELECT DISTINCT x.org_id FROM public.xero_invoices x WHERE x.invoice_type = 'ACCPAY'
  ),
  cn_read AS (
    SELECT CASE
             WHEN p_org_id IS NOT NULL THEN
               (SELECT min(s.cursor_at) FROM public.xero_sync_state s
                 WHERE starts_with(s.key, 'supplier_credit_notes_full:' || p_org_id::text || ':') AND s.cursor_at IS NOT NULL)
             WHEN NOT EXISTS (SELECT 1 FROM cn_orgs o
                               WHERE NOT EXISTS (SELECT 1 FROM public.xero_sync_state s
                                                  WHERE starts_with(s.key, 'supplier_credit_notes_full:' || o.org_id::text || ':')
                                                    AND s.cursor_at IS NOT NULL))
               THEN (SELECT min(s.cursor_at) FROM public.xero_sync_state s
                      WHERE starts_with(s.key, 'supplier_credit_notes_full:') AND s.cursor_at IS NOT NULL)
           END AS read_at
  ),
  -- The notes of the months shown (by credit note date) and undated ones.
  cn_note AS (
    SELECT n.org_id, n.xero_credit_note_id, n.credit_note_date,
           date_trunc('month', n.credit_note_date)::date AS month,
           COALESCE(n.status IN ('AUTHORISED', 'PAID'), false) AS live,
           n.total, n.sub_total
      FROM public.xero_supplier_credit_notes n, win
     WHERE (p_org_id IS NULL OR n.org_id = p_org_id)
       AND (n.credit_note_date IS NULL OR (n.credit_note_date >= win.from_month AND n.credit_note_date < win.to_excl))
  ),
  -- Their parts as the placement view sorts them (one rule, read once).
  cn_rows AS (
    SELECT p.org_id, p.xero_credit_note_id, p.part_key, p.state, p.job_profit, p.amount, p.counted_ex
      FROM public.v_supplier_credit_placement p
     WHERE (p_org_id IS NULL OR p.org_id = p_org_id)
       AND EXISTS (SELECT 1 FROM cn_note n
                    WHERE n.live AND n.org_id = p.org_id AND n.xero_credit_note_id = p.xero_credit_note_id)
  ),
  -- One row per part (a placed allocation is one row per job there).
  cn_part AS (
    SELECT DISTINCT ON (r.org_id, r.xero_credit_note_id, r.part_key)
           r.org_id, r.xero_credit_note_id, r.part_key, r.state, r.job_profit, r.amount
      FROM cn_rows r
     ORDER BY r.org_id, r.xero_credit_note_id, r.part_key
  ),
  cn_on_job AS (
    SELECT r.org_id, r.xero_credit_note_id, sum(r.counted_ex) AS counted_ex
      FROM cn_rows r
     WHERE r.job_profit = 'counted_from_credit_note'
     GROUP BY r.org_id, r.xero_credit_note_id
  ),
  cn_per_note AS (
    SELECT n.org_id, n.xero_credit_note_id, n.month, n.total, n.sub_total,
           COALESCE(max(j.counted_ex), 0) AS counted_ex,
           COALESCE(sum(p.amount) FILTER (WHERE p.state <> 'allocation_deleted' AND p.amount IS NOT NULL), 0) AS parts_inc,
           count(p.part_key) FILTER (WHERE p.state IN ('remaining_unknown', 'allocations_not_read', 'amount_unknown')
                                        OR (p.state = 'cash_refund' AND p.amount IS NULL)) AS unknown_parts,
           COALESCE(sum(p.amount) FILTER (WHERE p.state = 'placed'), 0) AS placed_inc,
           COALESCE(sum(p.amount) FILTER (WHERE p.job_profit = 'counted_from_credit_note'), 0) AS from_note_inc,
           COALESCE(sum(p.amount) FILTER (WHERE p.job_profit = 'counted_by_bill'), 0) AS by_bill_inc,
           COALESCE(sum(p.amount) FILTER (WHERE p.job_profit = 'bill_amount_credited'), 0) AS amount_credited_inc,
           COALESCE(sum(p.amount) FILTER (WHERE p.job_profit = 'exceeds_bill'), 0) AS exceeds_inc,
           COALESCE(sum(p.amount) FILTER (WHERE p.state = 'bill_not_in_copy'), 0) AS np_not_in_copy,
           COALESCE(sum(p.amount) FILTER (WHERE p.state = 'bill_not_live'), 0) AS np_not_live,
           COALESCE(sum(p.amount) FILTER (WHERE p.state = 'bill_total_unknown'), 0) AS np_total_unknown,
           COALESCE(sum(p.amount) FILTER (WHERE p.state = 'crew_bill'), 0) AS np_crew,
           COALESCE(sum(p.amount) FILTER (WHERE p.state = 'bill_not_placed'), 0) AS np_not_placed,
           COALESCE(sum(p.amount) FILTER (WHERE p.state = 'amount_not_positive'), 0) AS np_not_positive,
           COALESCE(sum(p.amount) FILTER (WHERE p.state = 'unallocated'), 0) AS unallocated_inc,
           COALESCE(sum(p.amount) FILTER (WHERE p.state = 'cash_refund'), 0) AS refund_inc
      FROM cn_note n
      LEFT JOIN cn_part p ON p.org_id = n.org_id AND p.xero_credit_note_id = n.xero_credit_note_id
      LEFT JOIN cn_on_job j ON j.org_id = n.org_id AND j.xero_credit_note_id = n.xero_credit_note_id
     WHERE n.live
     GROUP BY n.org_id, n.xero_credit_note_id, n.month, n.total, n.sub_total
  ),
  cn_month AS (
    SELECT m.month,
           count(c.xero_credit_note_id) AS notes,
           count(c.xero_credit_note_id) FILTER (WHERE c.total IS NULL) AS amount_unknown,
           COALESCE(sum(c.total), 0) AS total_inc,
           COALESCE(sum(c.sub_total), 0) AS total_ex,
           COALESCE(sum(c.placed_inc), 0) AS placed_inc,
           COALESCE(sum(c.from_note_inc), 0) AS from_note_inc,
           COALESCE(sum(c.by_bill_inc), 0) AS by_bill_inc,
           COALESCE(sum(c.amount_credited_inc), 0) AS amount_credited_inc,
           COALESCE(sum(c.exceeds_inc), 0) AS exceeds_inc,
           COALESCE(sum(c.counted_ex), 0) AS counted_ex,
           COALESCE(sum(c.np_not_in_copy + c.np_not_live + c.np_total_unknown + c.np_crew + c.np_not_placed + c.np_not_positive), 0) AS not_placed_inc,
           COALESCE(sum(c.np_not_in_copy), 0) AS np_not_in_copy,
           COALESCE(sum(c.np_not_live), 0) AS np_not_live,
           COALESCE(sum(c.np_total_unknown), 0) AS np_total_unknown,
           COALESCE(sum(c.np_crew), 0) AS np_crew,
           COALESCE(sum(c.np_not_placed), 0) AS np_not_placed,
           COALESCE(sum(c.np_not_positive), 0) AS np_not_positive,
           COALESCE(sum(c.unallocated_inc), 0) AS unallocated_inc,
           COALESCE(sum(c.refund_inc), 0) AS refund_inc,
           COALESCE(sum(c.unknown_parts), 0) AS unknown_parts,
           count(c.xero_credit_note_id) FILTER (WHERE c.total IS NULL OR c.unknown_parts > 0) AS unknown_notes,
           COALESCE(sum(c.total - c.parts_inc) FILTER (WHERE c.total IS NOT NULL AND c.unknown_parts = 0), 0) AS not_accounted_inc,
           CASE
             WHEN bool_or(c.total IS NOT NULL AND c.unknown_parts = 0 AND c.total <> c.parts_inc) THEN false
             WHEN bool_or(c.total IS NULL OR c.unknown_parts > 0) THEN NULL
             ELSE true
           END AS parts_add_up,
           (SELECT count(*) FROM cn_note x WHERE NOT x.live AND x.month = m.month) AS not_live_notes,
           (SELECT COALESCE(sum(x.total), 0) FROM cn_note x WHERE NOT x.live AND x.month = m.month) AS not_live_inc
      FROM months m
      LEFT JOIN cn_per_note c ON c.month = m.month
     GROUP BY m.month
  ),
  cn_month_doc AS (
    SELECT to_char(c.month, 'YYYY-MM') AS month,
           jsonb_build_object(
             'status', 'read',
             'ticket', 'TP-07',
             'counted', false,
             'basis', 'inc GST as Xero allocates credit; total_ex is Xero''s SubTotal; on_job_ex is what Job Profit takes off actual job cost, ex GST. By credit note date. Live notes (AUTHORISED or PAID) only; shown beside the bills total, never netted from it.',
             'notes', c.notes,
             'amount_unknown_count', c.amount_unknown,
             'total_inc', c.total_inc,
             'total_ex', c.total_ex,
             'amount_ex', c.total_ex,
             'placed_inc', c.placed_inc,
             'placed_by_job_profit', jsonb_build_object(
               'counted_from_credit_note_inc', c.from_note_inc,
               'counted_by_bill_inc', c.by_bill_inc,
               'bill_amount_credited_inc', c.amount_credited_inc,
               'exceeds_bill_inc', c.exceeds_inc),
             'on_job_ex', jsonb_build_object('counted_from_credit_note_ex', c.counted_ex),
             'not_placed_inc', c.not_placed_inc,
             'not_placed_by_reason', jsonb_build_object(
               'bill_not_in_copy', c.np_not_in_copy,
               'bill_not_live', c.np_not_live,
               'bill_total_unknown', c.np_total_unknown,
               'crew_bill', c.np_crew,
               'bill_not_placed', c.np_not_placed,
               'amount_not_positive', c.np_not_positive),
             'unallocated_inc', c.unallocated_inc,
             'cash_refund_inc', c.refund_inc,
             'unknown_parts', c.unknown_parts,
             'unknown_notes', c.unknown_notes,
             'not_accounted_inc', c.not_accounted_inc,
             'parts_add_up', c.parts_add_up,
             'parts_check', 'Per live note with a known total and no unknown part: placed + not placed + unallocated + refunded against Xero''s Total; a deleted allocation is no part. Null while a total or a part is unknown; false when a known note does not add up.',
             'not_live', jsonb_build_object('notes', c.not_live_notes, 'inc', c.not_live_inc, 'counted', false)
           ) AS doc
      FROM cn_month c
  )
  SELECT CASE
    WHEN r.read_at IS NULL THEN t.doc
    ELSE t.doc || jsonb_build_object(
      'covers', 'bills; supplier credit notes are shown beside each month, never netted from the bills total',
      'credit_notes_read_at', r.read_at,
      'not_yet_read', (SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ord), '[]'::jsonb)
                         FROM jsonb_array_elements(t.doc -> 'not_yet_read') WITH ORDINALITY AS e(value, ord)
                        WHERE e.value ->> 'part' IS DISTINCT FROM 'supplier_credit_notes'),
      'undated_credit_notes', (SELECT jsonb_build_object('count', count(*) FILTER (WHERE c.live),
                                                         'inc', COALESCE(sum(c.total) FILTER (WHERE c.live), 0))
                                 FROM cn_note c WHERE c.credit_note_date IS NULL),
      'months', (SELECT COALESCE(jsonb_agg(CASE WHEN d.doc IS NULL THEN m.value
                                                ELSE m.value || jsonb_build_object('credit_notes', d.doc) END
                                           ORDER BY m.ord), '[]'::jsonb)
                   FROM jsonb_array_elements(t.doc -> 'months') WITH ORDINALITY AS m(value, ord)
                   LEFT JOIN cn_month_doc d ON d.month = m.value ->> 'month'))
  END
  FROM tp01 t, cn_read r
$$;


COMMENT ON FUNCTION public.xero_tieout_monthly(date, integer, uuid) IS
  'TP-01 Xero tie-out (20261029121500), supplier credit notes TP-07 (20261030060000): by month, every AUTHORISED or PAID supplier bill dollar of 0 or more (ex GST) in our copy of Xero sorted into on a job, trade-app labour (already counted on jobs by the trade app), overhead / not job related (stock and vehicles not yet separated) or unplaced, with the unplaced share (rounded up, never below 0) and the last 6 months. A bill below 0 is shown only as negative_bill; rows (summed with their signs) and overhead parts above a bill that is not trade-app labour are shown as over_allocated; neither is in the total. parts_add_up checks the buckets against the bills read directly. p_org_id scopes every read to one org (null reads every org, a bill per org and Xero id). as_of picks the months only: allocations and Bills to place states are as of today. Spend money (TP-08) is not_yet_read with a null amount, never $0. Supplier credit notes (TP-07): not_yet_read with a null amount until xero-sync has finished a full read of the org''s credit notes (xero_sync_state supplier_credit_notes_full:<org>:<tenant>; with no org, every org with a bill), and until then the answer is TP-01''s, byte for byte; after it each month''s credit_notes shows its live notes by credit note date (inc GST as Xero allocates, with total_ex): placed and how Job Profit counts each (from the credit note, by the bill, by the bill''s AmountCredited, or not: exceeds the bill), not placed by reason, unallocated, cash refunded, not live, unknown parts, and whether the parts add up to Xero''s totals, read from v_supplier_credit_placement; credit_notes_read_at is that read''s start. Credit notes are never netted from the bills total. Read only, aggregates only, service role only.';
REVOKE ALL ON FUNCTION public.xero_tieout_monthly(date, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.xero_tieout_monthly(date, integer, uuid) TO service_role;
