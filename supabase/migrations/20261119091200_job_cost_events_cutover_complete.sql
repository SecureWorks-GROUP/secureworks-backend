-- P2-01.8 (F2): the guarded writer for the cost-lines cutover marker.
--
-- v_job_cost_events (20261117210402) reads the cost lines only when the switch
-- job_cost_events_from_cost_lines_v1 is on AND job_cost_events_cutover.completed_at
-- is set, and completed_at needs all four precondition stamps. Nothing wrote them.
-- This adds the one writer, and the read it trusts instead of the stamps:
--
--   public.job_cost_events_cutover_check(org, cutoff default 1 Oct 2026) -> jsonb
--     Measures the preconditions from the rows themselves, writes nothing:
--       bills_missing_cost_lines           live supplier bills (ACCPAY, AUTHORISED or PAID,
--                                          dated on or after the cutoff) that the bills
--                                          backfill would write (the mirror rule says none,
--                                          and job_cost_lines_bill_document gives at least
--                                          one line) with no cost line;
--       bills_mirror_stopped               the same bills the mirror rule stops (a trade
--                                          invoice with no organisation holds them). The
--                                          backfill never writes these; reported, not a gate;
--       credits_missing_cost_lines         live supplier credit notes dated on or after the
--                                          cutoff with an allocation or remaining credit
--                                          (what the credit sync writes) and no cost line;
--       trade_invoices_missing_cost_lines  live trade invoices (not draft, not ops-reject,
--                                          bill not deleted or voided) with a real line
--                                          (v_trade_charge_resolved, not a probable test
--                                          line) and no cost line;
--       trade_triggers_installed           all four trade sync triggers in pg_trigger, by
--                                          name, table and function, enabled;
--       mirror_overlap_count               cost lines a total still reads (state set) on a
--                                          supplier bill the mirror rule skips (a trade
--                                          invoice holds it); mirror_overlap_all_states
--                                          counts every state, reported only;
--       profit_diffs                       per job of the organisation, actual cost ex GST
--                                          and actual line count from v_job_cost_events_legacy
--                                          against v_job_cost_events_lines: the count of
--                                          differing jobs over every event date (what Job
--                                          Profit would move) and since the cutoff, and the
--                                          50 largest differences;
--       ready                              every gate count 0, the triggers installed and no
--                                          differing job. ready_except_profit_diffs drops
--                                          the last term.
--
--   public.job_cost_events_cutover_complete(org, cutoff, allow_profit_diff default false) -> jsonb
--     Runs the check under the marker's row lock and refuses
--     (cutover_preconditions_not_met, the check in DETAIL) unless every gate holds and
--     no job differs or allow_profit_diff is true. Then stamps the four preconditions
--     and completed_at in its one transaction, keeping any stamp already there. It
--     never turns a switch: with job_cost_events_from_cost_lines_v1 off, Job Profit
--     still reads the legacy view. Database owner only.
--
-- The marker is one row for the database; the organisation names whose rows are
-- measured. No trigger, schedule or row write is installed by applying this.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Build only on what this was written against, and over nothing but itself.
DO $guard$
DECLARE h text;
BEGIN
  IF to_regclass('public.job_cost_events_cutover') IS NULL
     OR to_regclass('public.v_job_cost_events_legacy') IS NULL
     OR to_regclass('public.v_job_cost_events_lines') IS NULL
     OR to_regclass('public.v_trade_charge_resolved') IS NULL
     OR to_regprocedure('public.trade_invoice_bill_mirror_verdicts(uuid,text[])') IS NULL
     OR to_regprocedure('public.job_cost_lines_bill_document(uuid,jsonb,boolean)') IS NULL
     OR to_regprocedure('public.job_cost_lines_trade_statement()') IS NULL
     OR to_regprocedure('public.job_cost_lines_trade_invoice_row()') IS NULL THEN
    RAISE EXCEPTION 'cost_events_cutover_prerequisites_missing';
  END IF;
  SELECT md5(p.prosrc) INTO h FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.job_cost_events_cutover_check(uuid,date)');
  IF h IS NOT NULL AND h <> 'e21f4ab58a295a1d300826af84237f5d' THEN
    RAISE EXCEPTION 'job_cost_events_cutover_check_body_changed';
  END IF;
  SELECT md5(p.prosrc) INTO h FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.job_cost_events_cutover_complete(uuid,date,boolean)');
  IF h IS NOT NULL AND h <> '753a125fad2af39f77d7f683f93a96b2' THEN
    RAISE EXCEPTION 'job_cost_events_cutover_complete_body_changed';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.job_cost_events_cutover_check(
  p_org_id uuid, p_cutoff date DEFAULT DATE '2026-10-01')
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
-- The legacy cost view is read whole for one organisation. PostgREST hoists this.
SET statement_timeout = '120s'
AS $$
DECLARE
  v_bills int; v_stopped int; v_credits int; v_trade int; v_triggers boolean;
  v_overlap int; v_overlap_all int; v_diff_all int; v_diff_since int; v_diff_jobs jsonb;
  v_gates boolean;
BEGIN
  IF p_org_id IS NULL OR p_cutoff IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'cutover_check_invalid_arguments: org and cutoff are required';
  END IF;

  -- a) Supplier bills the bills backfill owes lines for, and b') the ones it stops.
  WITH bills AS (
    SELECT x.xero_invoice_id AS id,
      jsonb_build_object('invoice_type', x.invoice_type, 'xero_invoice_id', x.xero_invoice_id,
        'status', x.status, 'invoice_number', x.invoice_number, 'invoice_date', x.invoice_date,
        'xero_contact_id', x.xero_contact_id, 'contact_name', x.contact_name,
        'fully_paid_on', x.fully_paid_on, 'line_items', x.line_items, 'sub_total', x.sub_total,
        'raw_json', jsonb_build_object('LineAmountTypes', x.raw_json->'LineAmountTypes')) AS bill
    FROM xero_invoices x
    WHERE x.org_id = p_org_id AND x.invoice_type = 'ACCPAY'
      AND x.status IN ('AUTHORISED', 'PAID') AND x.invoice_date >= p_cutoff
      AND x.xero_invoice_id IS NOT NULL
  ), verdicts AS (
    SELECT v.bill_id, v.verdict
    FROM trade_invoice_bill_mirror_verdicts(p_org_id, ARRAY(SELECT DISTINCT b.id FROM bills b)) v
  ), judged AS (
    SELECT b.id, b.bill, (SELECT v.verdict FROM verdicts v WHERE v.bill_id = b.id LIMIT 1) AS verdict
    FROM bills b
  )
  SELECT
    count(*) FILTER (WHERE j.verdict = 'none'
      AND jsonb_array_length(coalesce(job_cost_lines_bill_document(p_org_id, j.bill, false)->'lines', '[]'::jsonb)) > 0
      AND NOT EXISTS (SELECT 1 FROM job_cost_lines l WHERE l.org_id = p_org_id
        AND l.document_kind = 'xero_bill' AND l.document_id = j.id)),
    count(*) FILTER (WHERE j.verdict IS DISTINCT FROM 'none' AND j.verdict IS DISTINCT FROM 'mirror')
  INTO v_bills, v_stopped
  FROM judged j;

  -- b) Supplier credit notes the credit sync owes lines for.
  SELECT count(*) INTO v_credits
  FROM xero_supplier_credit_notes n
  WHERE n.org_id = p_org_id AND n.status IN ('AUTHORISED', 'PAID') AND n.credit_note_date >= p_cutoff
    AND (n.remaining_credit > 0 OR EXISTS (SELECT 1 FROM xero_supplier_credit_note_allocations a
      WHERE a.org_id = n.org_id AND a.xero_credit_note_id = n.xero_credit_note_id
        AND NOT a.is_deleted AND a.xero_invoice_id IS NOT NULL))
    AND NOT EXISTS (SELECT 1 FROM job_cost_lines l WHERE l.org_id = p_org_id
      AND l.document_kind = 'xero_credit_note' AND l.document_id = n.xero_credit_note_id);

  -- c) Live trade invoices with a real line the trade sync owes lines for.
  WITH live AS (
    SELECT t.id FROM trade_invoices t
    WHERE t.org_id = p_org_id
      AND t.status IS DISTINCT FROM 'draft' AND t.status IS DISTINCT FROM 'ops-reject'
      AND upper(coalesce(t.xero_bill_status, '')) NOT IN ('DELETED', 'VOIDED')
      AND NOT EXISTS (SELECT 1 FROM job_cost_lines l WHERE l.org_id = p_org_id
        AND l.document_kind = 'trade_invoice' AND l.document_id = t.id::text)
  )
  SELECT count(*) INTO v_trade FROM live
  WHERE live.id IN (SELECT r.trade_invoice_id FROM v_trade_charge_resolved r
    WHERE r.trade_invoice_id IN (SELECT id FROM live) AND NOT r.is_probable_test_line);

  -- d) The four trade sync triggers, as job_cost_lines_install_trade_triggers makes them.
  SELECT count(*) = 4 INTO v_triggers
  FROM (VALUES
    ('job_cost_lines_trade_insert', 'public.trade_invoice_lines', 'public.job_cost_lines_trade_statement()'),
    ('job_cost_lines_trade_update', 'public.trade_invoice_lines', 'public.job_cost_lines_trade_statement()'),
    ('job_cost_lines_trade_delete', 'public.trade_invoice_lines', 'public.job_cost_lines_trade_statement()'),
    ('job_cost_lines_trade_invoice_update', 'public.trade_invoices', 'public.job_cost_lines_trade_invoice_row()')
  ) w(name, rel, fn)
  WHERE EXISTS (SELECT 1 FROM pg_trigger tg
    WHERE tg.tgname = w.name AND tg.tgrelid = to_regclass(w.rel)
      AND tg.tgfoid = to_regprocedure(w.fn) AND NOT tg.tgisinternal AND tg.tgenabled <> 'D');

  -- e) Supplier bill cost lines on a bill the mirror rule skips (mirror or stop).
  WITH bill_lines AS (
    SELECT l.document_id, l.state FROM job_cost_lines l
    WHERE l.org_id = p_org_id AND l.document_kind = 'xero_bill'
  ), verdicts AS (
    SELECT v.bill_id, v.verdict
    FROM trade_invoice_bill_mirror_verdicts(p_org_id, ARRAY(SELECT DISTINCT b.document_id FROM bill_lines b)) v
  )
  SELECT count(*) FILTER (WHERE b.state IS NOT NULL), count(*)
  INTO v_overlap, v_overlap_all
  FROM bill_lines b
  WHERE EXISTS (SELECT 1 FROM verdicts v WHERE v.bill_id = b.document_id AND v.verdict <> 'none');

  -- f) What Job Profit would move, per job of this organisation, actual rows only.
  WITH legacy AS (
    SELECT g.job_id,
      round(sum(g.amount_ex) FILTER (WHERE g.is_actual), 2) AS total,
      count(*) FILTER (WHERE g.is_actual) AS n,
      round(sum(g.amount_ex) FILTER (WHERE g.is_actual AND g.event_date >= p_cutoff), 2) AS total_since,
      count(*) FILTER (WHERE g.is_actual AND g.event_date >= p_cutoff) AS n_since
    FROM v_job_cost_events_legacy g
    WHERE g.job_id IN (SELECT j.id FROM jobs j WHERE j.org_id = p_org_id)
    GROUP BY g.job_id
  ), lines AS (
    SELECT g.job_id,
      round(sum(g.amount_ex) FILTER (WHERE g.is_actual), 2) AS total,
      count(*) FILTER (WHERE g.is_actual) AS n,
      round(sum(g.amount_ex) FILTER (WHERE g.is_actual AND g.event_date >= p_cutoff), 2) AS total_since,
      count(*) FILTER (WHERE g.is_actual AND g.event_date >= p_cutoff) AS n_since
    FROM v_job_cost_events_lines g
    WHERE g.job_id IN (SELECT j.id FROM jobs j WHERE j.org_id = p_org_id)
    GROUP BY g.job_id
  ), joined AS (
    SELECT coalesce(a.job_id, b.job_id) AS job_id,
      coalesce(a.total, 0) AS legacy_total, coalesce(b.total, 0) AS lines_total,
      coalesce(a.n, 0) AS legacy_lines, coalesce(b.n, 0) AS lines_lines,
      coalesce(a.total_since, 0) IS DISTINCT FROM coalesce(b.total_since, 0)
        OR coalesce(a.n_since, 0) <> coalesce(b.n_since, 0) AS differs_since
    FROM legacy a FULL JOIN lines b ON b.job_id = a.job_id
  ), differing AS (
    SELECT * FROM joined
    WHERE legacy_total IS DISTINCT FROM lines_total OR legacy_lines <> lines_lines
  )
  SELECT (SELECT count(*) FROM differing),
    (SELECT count(*) FROM joined WHERE differs_since),
    coalesce((SELECT jsonb_agg(jsonb_build_object('job_id', d.job_id,
        'legacy_total_ex', d.legacy_total, 'lines_total_ex', d.lines_total,
        'legacy_lines', d.legacy_lines, 'lines_lines', d.lines_lines)
        ORDER BY abs(d.lines_total - d.legacy_total) DESC, d.job_id)
      FROM (SELECT * FROM differing
            ORDER BY abs(lines_total - legacy_total) DESC, job_id LIMIT 50) d), '[]'::jsonb)
  INTO v_diff_all, v_diff_since, v_diff_jobs;

  v_gates := v_bills = 0 AND v_credits = 0 AND v_trade = 0 AND v_triggers AND v_overlap = 0;
  RETURN jsonb_build_object(
    'org_id', p_org_id,
    'cutoff', p_cutoff,
    'bills_missing_cost_lines', v_bills,
    'bills_mirror_stopped', v_stopped,
    'credits_missing_cost_lines', v_credits,
    'trade_invoices_missing_cost_lines', v_trade,
    'trade_triggers_installed', v_triggers,
    'mirror_overlap_count', v_overlap,
    'mirror_overlap_all_states', v_overlap_all,
    'profit_diffs', jsonb_build_object(
      'differing_jobs_count', v_diff_all,
      'differing_jobs_count_since_cutoff', v_diff_since,
      'shown_limit', 50,
      'jobs', v_diff_jobs),
    'ready_except_profit_diffs', v_gates,
    'ready', v_gates AND v_diff_all = 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.job_cost_events_cutover_complete(
  p_org_id uuid, p_cutoff date DEFAULT DATE '2026-10-01', p_allow_profit_diff boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '120s'
SET lock_timeout = '5s'
AS $$
DECLARE c jsonb; m job_cost_events_cutover%ROWTYPE; switch_on boolean;
BEGIN
  IF p_org_id IS NULL OR p_cutoff IS NULL OR p_allow_profit_diff IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'cutover_complete_invalid_arguments: org, cutoff and allow_profit_diff are required';
  END IF;
  -- One completion at a time: the marker row is held from the check to the stamp.
  SELECT * INTO m FROM job_cost_events_cutover WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'cutover_marker_missing';
  END IF;
  c := job_cost_events_cutover_check(p_org_id, p_cutoff);
  -- Every gate read from the measurement itself; a missing key refuses.
  IF coalesce((c->>'bills_missing_cost_lines')::int <> 0, true)
     OR coalesce((c->>'credits_missing_cost_lines')::int <> 0, true)
     OR coalesce((c->>'trade_invoices_missing_cost_lines')::int <> 0, true)
     OR NOT coalesce((c->>'trade_triggers_installed')::boolean, false)
     OR coalesce((c->>'mirror_overlap_count')::int <> 0, true)
     OR (coalesce((c->'profit_diffs'->>'differing_jobs_count')::int <> 0, true) AND NOT p_allow_profit_diff) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'cutover_preconditions_not_met', DETAIL = c::text;
  END IF;
  -- A stamp already there keeps its first instant.
  UPDATE job_cost_events_cutover SET
    bills_backfilled_at = coalesce(bills_backfilled_at, now()),
    credits_backfilled_at = coalesce(credits_backfilled_at, now()),
    trade_backfilled_at = coalesce(trade_backfilled_at, now()),
    trade_triggers_installed_at = coalesce(trade_triggers_installed_at, now()),
    completed_at = coalesce(completed_at, now())
  WHERE singleton
  RETURNING * INTO m;
  switch_on := EXISTS (SELECT 1 FROM feature_flags
    WHERE flag_name = 'job_cost_events_from_cost_lines_v1' AND enabled);
  RETURN jsonb_build_object(
    'completed', true,
    'allowed_profit_diff', p_allow_profit_diff AND (c->'profit_diffs'->>'differing_jobs_count')::int <> 0,
    'marker', jsonb_build_object(
      'bills_backfilled_at', m.bills_backfilled_at, 'credits_backfilled_at', m.credits_backfilled_at,
      'trade_backfilled_at', m.trade_backfilled_at, 'trade_triggers_installed_at', m.trade_triggers_installed_at,
      'completed_at', m.completed_at),
    'switch_on', switch_on,
    'check', c);
END;
$$;

REVOKE ALL ON FUNCTION public.job_cost_events_cutover_check(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_cost_events_cutover_check(uuid, date) TO service_role;
REVOKE ALL ON FUNCTION public.job_cost_events_cutover_complete(uuid, date, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.job_cost_events_cutover_check(uuid, date) IS
  'P2-01.8: the cost-lines cutover preconditions measured from the rows (missing bill, credit and trade cost lines, trade triggers, mirror overlap, per-job Job Profit differences). Writes nothing.';
COMMENT ON FUNCTION public.job_cost_events_cutover_complete(uuid, date, boolean) IS
  'P2-01.8: stamps job_cost_events_cutover only when job_cost_events_cutover_check passes (profit differences only with p_allow_profit_diff). Turns no switch. Database owner only.';
