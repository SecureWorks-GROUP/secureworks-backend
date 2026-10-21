-- Job profit: one recorded-person boundary for installer bills (JP-12).
-- 21 Oct 2026. Stacks on 20261020181800 (PR 1107) and 20261021161500 (PR 1134).
--
-- Codex (REQUEST CHANGES at 1107 0a4d88a7 / 1134 6dbc83c3) showed a bill
-- could count as actual installer cost, or read settled, with no person
-- recorded: 1107 trusted any manual_queue / manual_split row whatever its
-- actor, and allocate_bill_split refused only a blank actor, so actor_missing,
-- ops_dashboard and a routine name all counted. The rule (coordinator 21 Oct
-- 16:36Z, from the builder's trace of the stored actor forms):
--
--   * public.cfo_recorded_person(source, actor) is the one rule: a person
--     source whose actor is user:<uuid> of a public.users row, or a user's
--     email. Everything else is not a person.
--   * allocate_bill_split refuses an actor that fails it.
--   * v_bill_allocation_balance, v_job_cost_events and
--     cfo_bill_reconciliation_outcomes all read it, so an existing row that
--     fails it reads unconfirmed. Nothing is rewritten: no backfill, no
--     UPDATE of job_materials_facts or materials_reconciliation_queue.
--   * ops-api refuses the three Bills to place writes (assign, split, not
--     job related) unless a signed-in session made the request
--     (ops-api/materials_recon_person.ts). An x-sw-actor header on a
--     server-key call is a claim, never a person, even when it names a real
--     user (the same reading as approve_work_order's, without its flag).
--   * A bill with an overhead part takes its H7 decider from the queue row
--     only, never from its job rows.
--
-- Known limit: a stored user:<uuid> written before this from a header claim
-- cannot be told from one written by a signed-in session (no actor source
-- is stored). Such rows count. Storing the source is a later proposal.
-- A user's email is matched case-insensitively (the house rule).
--
-- The views and the function below are the 1107 and 1134 bodies with only
-- the marked 20261021173000 changes; column lists and order are unchanged.
--
-- Contract: supabase/tests/migration-contracts/20261021173000_cfo_recorded_person/.
-- Rollback: supabase/rollbacks/20261021173000_cfo_recorded_person_down.sql.

-- The one rule for a recorded person (JP-12, coordinator 21 Oct 16:36Z):
-- a person source (manual_queue, manual_split) whose actor is user:<uuid> of
-- a public.users row, or the email of a public.users row (compared as
-- lower(btrim(email)), the house rule in 20261005200000 and 20261007010000).
-- Nothing else is a person: blank, null, actor_missing, ops_dashboard,
-- makesafe-reporting-routine, xero-sync or any service name, free text, a
-- bare uuid, person:<uuid>, an unknown email, a user: of a uuid that is not a
-- user, and any machine source whatever actor it carries. The id is compared
-- as text, so a malformed user: value is false, never a cast error. Plain
-- SQL, STABLE, no SET clause, so a view inlines it.
CREATE OR REPLACE FUNCTION public.cfo_recorded_person(p_source text, p_actor text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(p_source IN ('manual_queue', 'manual_split'), false)
     AND CASE
           WHEN p_actor IS NULL THEN false
           WHEN btrim(p_actor) ~* '^user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN EXISTS (SELECT 1 FROM public.users u
                           WHERE u.id::text = lower(substr(btrim(p_actor), 6)))
           WHEN position('@' IN p_actor) > 1
             THEN EXISTS (SELECT 1 FROM public.users u
                           WHERE NULLIF(lower(btrim(u.email)), '') = lower(btrim(p_actor)))
           ELSE false
         END
$$;
REVOKE ALL ON FUNCTION public.cfo_recorded_person(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cfo_recorded_person(text, text) TO service_role;
COMMENT ON FUNCTION public.cfo_recorded_person(text, text) IS
  'JP-12 recorded person (20261021173000): true only for a person source (manual_queue, manual_split) whose actor is user:<uuid> of a public.users row or the email of one (case-insensitive). Used by allocate_bill_split, v_bill_allocation_balance, v_job_cost_events and cfo_bill_reconciliation_outcomes. Service role only.';

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
  -- 20261021173000: only a recorded person splits (cfo_recorded_person).
  -- A blank actor, a placeholder, a service name or an unknown user is refused.
  IF NOT public.cfo_recorded_person('manual_split', p_actor) THEN
    RAISE EXCEPTION 'split_refused: a recorded person is required (a signed-in user)';
  END IF;
  IF jsonb_typeof(p_parts) IS DISTINCT FROM 'array' OR jsonb_array_length(p_parts) = 0 THEN
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
    IF jsonb_typeof(part -> 'amount_ex') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'split_refused: every part needs an amount';
    END IF;
    v_amount := round((part ->> 'amount_ex')::numeric, 2);
    IF v_amount <= 0 THEN
      RAISE EXCEPTION 'split_refused: every part must be more than 0';
    END IF;
    IF COALESCE(part ->> 'job_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'split_refused: every part needs a job';
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

CREATE OR REPLACE VIEW public.v_bill_allocation_balance AS
WITH alloc AS (
  SELECT f.xero_invoice_id, count(*) AS rows, sum(f.amount_ex_gst) AS allocated_ex,
         -- 20261021173000: every row placed by a recorded person.
         bool_and(public.cfo_recorded_person(f.automation_source, f.assigned_by)) AS person_placed
  FROM public.job_materials_facts f
  WHERE f.kind = 'actual'
  GROUP BY f.xero_invoice_id
),
bills AS (
  SELECT DISTINCT ON (x.xero_invoice_id) x.xero_invoice_id, x.invoice_number, x.contact_name, x.status, x.sub_total,
         public.job_cost_installer_bill(x.line_items) AS installer
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
   AND abs(round(b.sub_total, 2) - COALESCE(a.allocated_ex, 0) - COALESCE(q.overhead_ex, 0)) <= 0.005
   AND NOT (COALESCE(b.installer, false)
            AND NOT (COALESCE(a.person_placed, true)
                     AND (COALESCE(q.overhead_ex, 0) = 0
                          OR public.cfo_recorded_person('manual_split', q.assigned_by))))) AS balanced,
  q.status AS queue_status,
  -- JP-12 (20261021173000): an installer bill is allocated only when every
  -- row and any overhead part was placed by a recorded person.
  (COALESCE(b.installer, false)
   AND NOT (COALESCE(a.person_placed, true)
            AND (COALESCE(q.overhead_ex, 0) = 0
                 OR public.cfo_recorded_person('manual_split', q.assigned_by)))) AS installer_unconfirmed
FROM (SELECT xero_invoice_id FROM alloc
      UNION SELECT xero_invoice_id FROM public.materials_reconciliation_queue WHERE COALESCE(overhead_ex, 0) > 0) k
LEFT JOIN alloc a ON a.xero_invoice_id = k.xero_invoice_id
LEFT JOIN bills b ON b.xero_invoice_id = k.xero_invoice_id
LEFT JOIN public.materials_reconciliation_queue q ON q.xero_invoice_id = k.xero_invoice_id;

COMMENT ON VIEW public.v_bill_allocation_balance IS
  'CFO-18: every supplier bill with allocation rows or an overhead part. remainder_ex = bill ex GST - allocated - overhead; balanced when 0 to the cent and the bill is live in Xero (a voided or deleted bill with rows is never balanced: undo its rows). A bill amended in Xero after a split shows the drift as a remainder. A bill placed whole by one row is balanced only when that row carries the bill sub_total. JP-12: an installer bill (306/301) with a row or overhead part no recorded person made (cfo_recorded_person, 20261021173000) is installer_unconfirmed and never balanced; person_placed is true only when every row was placed by a recorded person. Read only, service role only.';
REVOKE ALL ON public.v_bill_allocation_balance FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_bill_allocation_balance TO service_role;

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
      -- 20261021173000: only a recorded person (cfo_recorded_person) confirms
      -- or marks not job related; anything else is unconfirmed.
      WHEN EXISTS (SELECT 1 FROM public.job_materials_facts f
                    WHERE f.xero_invoice_id = x.xero_invoice_id AND f.job_id = x.job_id
                      AND f.automation_source = 'manual_queue'
                      AND public.cfo_recorded_person(f.automation_source, f.assigned_by)) THEN 'confirmed'
      WHEN EXISTS (SELECT 1 FROM public.materials_reconciliation_queue q
                    WHERE q.xero_invoice_id = x.xero_invoice_id AND q.status = 'not_job_related'
                      AND public.cfo_recorded_person('manual_queue', q.assigned_by)) THEN 'not_job_related'
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
    -- JP-12: installer labour placed by anything but a recorded person
    -- (cfo_recorded_person, 20261021173000) is not confirmed.
    (NOT public.cfo_recorded_person(f.automation_source, f.assigned_by)
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
  'Job profit engine (20261009130000, CFO-12 20261019120000, CFO-18/20 20261020181800): one row per job cost, lane labour/materials/commission/other, source trade_line/supplier_bill/materials_fact/supplier_credit/installer_bill_unconfirmed/installer_bill_not_job_related/po_committed/po_ordered/po_invoice_emailed. A bill with an allocation row on another job is read through its rows only. supplier_credit is credit applied in Xero against a live bill, negative, in proportion. An installer bill (306/301) counts only once a recorded person (cfo_recorded_person, 20261021173000) placed it on the job (JP-12): until then it is installer_bill_unconfirmed (and its credit too), and one a person marked not job related is installer_bill_not_job_related; neither is ever actual. The three po_ sources are never actual. Read only, service role only.';

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
    f.fact_by_min, f.fact_by_max, f.fact_at
  FROM universe u
  LEFT JOIN bill b ON b.xero_invoice_id = u.xero_invoice_id
  LEFT JOIN fact f ON f.xero_invoice_id = u.xero_invoice_id
  LEFT JOIN public.materials_reconciliation_queue q ON q.xero_invoice_id = u.xero_invoice_id
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
      WHEN abs(b.bill_ex - b.parts_ex - b.overhead_ex) > 0.005 THEN 'unbalanced'
      WHEN NOT COALESCE(b.all_person, false) THEN 'placed_unconfirmed'
      ELSE 'confirmed'
    END AS state0
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
  )::text) AS evidence_hash
FROM judged j;

COMMENT ON VIEW public.cfo_bill_reconciliation_outcomes IS
  'Job profit H7 (20261021161500): one row per non-mirror supplier bill (Xero ACCPAY) linked to a job, with allocation rows, or in Bills to place, for Context to read. state unknown, voided, confirmed_overhead, unplaced, installer_unconfirmed, unbalanced, placed_unconfirmed or confirmed; only confirmed and confirmed_overhead are a confirmed reconciliation. parts lists each job part with placed_by person, machine (the bill''s own Xero job link with no row is machine, source xero_job_link) or unrecorded (a person source whose actor is not a recorded person by cfo_recorded_person, 20261021173000); a decision with no single recorded person reads placed_unconfirmed, and a bill with an overhead part takes its decider from the queue row only, and a not-job-related mark wins over a Xero job link with no row. evidence_hash is md5 of a fixed jsonb array led by the contract version cfo-recon-outcome-v1; a payment does not move it (CFO proposal, CIO may overturn), a changed total, line, credit, status class, part or overhead does. credit_applied_ex is null when the stored copy does not show credit. No history. Read only, service role only.';
REVOKE ALL ON public.cfo_bill_reconciliation_outcomes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cfo_bill_reconciliation_outcomes TO service_role;
