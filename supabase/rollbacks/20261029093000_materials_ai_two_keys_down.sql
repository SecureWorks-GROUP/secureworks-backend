-- Down for 20261029093000_materials_ai_two_keys.sql.
--
-- A bill still held for the second check goes back to "left for a person"
-- (its queue row was never moved, so it is still open in Bills to place, and
-- it had no cost row). Every placement the two-keys path made stays placed: a
-- placement is a link a person can Undo, and taking cost off jobs is not this
-- rollback's call. Then the five functions return to 20261028173000's bodies
-- byte for byte, and the view, the helpers, the constraints and the columns
-- go. agreed_keys, key_evidence and held_at are dropped with their columns:
-- export materials_ai_placements first if they must be kept.

UPDATE public.materials_ai_placements
   SET outcome = 'left_for_person', second_check_status = 'not_needed',
       refusal = 'held for the second check when two keys was rolled back'
 WHERE outcome = 'held_for_check';

DROP FUNCTION IF EXISTS public.materials_ai_placed_without_key_count();
DROP VIEW IF EXISTS public.v_materials_ai_placed_without_key;

CREATE OR REPLACE FUNCTION public.materials_ai_bill_batch(p_limit integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH s AS (SELECT * FROM public.materials_ai_settings WHERE id),
  open_rows AS (
    SELECT q.*, x.line_items, x.reference, x.status AS bill_status, x.due_date, x.raw_json ->> 'LineAmountTypes' AS amount_types,
           public.job_cost_installer_bill(x.line_items) AS installer
      FROM public.materials_reconciliation_queue q
      JOIN LATERAL (
        SELECT x.line_items, x.reference, x.status, x.due_date, x.raw_json
          FROM public.xero_invoices x
         WHERE x.xero_invoice_id = q.xero_invoice_id AND x.invoice_type = 'ACCPAY'
         ORDER BY (x.status IN ('AUTHORISED', 'PAID')) DESC
         LIMIT 1) x ON true
     WHERE q.status = 'open'
       AND NOT public.materials_ai_held_reason(q.suggestion_reason)
       AND q.sub_total IS NOT NULL AND q.sub_total > 0
       AND x.status IN ('AUTHORISED', 'PAID')
       AND NOT public.materials_ai_trade_mirror(q.xero_invoice_id, x.line_items)
       -- Undone once: never read by the AI again.
       AND NOT EXISTS (SELECT 1 FROM public.materials_ai_placements p
                        WHERE p.xero_invoice_id = q.xero_invoice_id AND p.undone_at IS NOT NULL)
       -- Read recently and left for a person (or refused): wait before reading again.
       AND NOT EXISTS (SELECT 1 FROM public.materials_ai_placements p, s
                        WHERE p.xero_invoice_id = q.xero_invoice_id
                          AND p.created_at > now() - make_interval(days => s.reread_after_days))
       -- A person's row on the bill: never the AI's to touch.
       AND NOT EXISTS (SELECT 1 FROM public.job_materials_facts f
                        WHERE f.xero_invoice_id = q.xero_invoice_id
                          AND f.automation_source IN ('manual_queue', 'manual_split', 'agent_ai'))
     ORDER BY q.sub_total DESC, q.xero_invoice_id
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 6), 20))
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'xero_invoice_id', o.xero_invoice_id,
    'invoice_number', o.invoice_number,
    'supplier', o.contact_name,
    'xero_contact_id', o.xero_contact_id,
    'invoice_date', o.invoice_date,
    'due_date', o.due_date,
    'amount_ex', o.sub_total,
    'amount_inc', o.total,
    'reference', o.reference,
    'installer', o.installer,
    'waiting_reason', o.suggestion_reason,
    'lines', (SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                'description', left(li.value ->> 'Description', 400),
                'account', li.value ->> 'AccountCode',
                'quantity', li.value -> 'Quantity',
                'amount', li.value -> 'LineAmount',
                'tracking', (SELECT jsonb_agg(t.value ->> 'Option')
                               FROM jsonb_array_elements(CASE WHEN jsonb_typeof(li.value -> 'Tracking') = 'array' THEN li.value -> 'Tracking' ELSE '[]'::jsonb END) t)))
                ORDER BY li.n), '[]'::jsonb)
                FROM jsonb_array_elements(CASE WHEN jsonb_typeof(o.line_items) = 'array' THEN o.line_items ELSE '[]'::jsonb END)
                     WITH ORDINALITY li(value, n)),
    'machine_suggestion', CASE WHEN o.suggested_job_number IS NOT NULL THEN jsonb_build_object(
        'job_number', o.suggested_job_number, 'confidence', o.suggestion_confidence, 'reason', o.suggestion_reason) END,
    'rules_proposal', (SELECT jsonb_build_object('kind', p.proposal_kind, 'job_number', p.proposed_job_number,
                                                 'confidence', p.confidence, 'rule', p.rule, 'reason', left(p.reason, 600))
                         FROM public.materials_bill_proposals p
                        WHERE p.xero_invoice_id = o.xero_invoice_id AND p.outcome <> 'superseded'
                        ORDER BY p.updated_at DESC NULLS LAST LIMIT 1),
    'supplier_history', (SELECT COALESCE(jsonb_agg(h ORDER BY h ->> 'date' DESC), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('job_number', f.job_number, 'date', f.fact_date, 'amount_ex', f.amount_ex_gst,
                                  'invoice_number', f.invoice_number, 'placed_by', f.automation_source,
                                  'suburb', j.site_suburb) AS h
          FROM public.job_materials_facts f
          LEFT JOIN public.jobs j ON j.id = f.job_id
         WHERE f.xero_invoice_id <> o.xero_invoice_id
           AND ((o.xero_contact_id IS NOT NULL AND f.xero_contact_id = o.xero_contact_id)
                OR (o.xero_contact_id IS NULL AND lower(f.contact_name) = lower(o.contact_name)))
         ORDER BY f.fact_date DESC NULLS LAST
         LIMIT 15) hh),
    'supplier_not_job_related', (SELECT count(*) FROM public.materials_reconciliation_queue q2
                                  WHERE q2.status = 'not_job_related' AND q2.xero_invoice_id <> o.xero_invoice_id
                                    AND ((o.xero_contact_id IS NOT NULL AND q2.xero_contact_id = o.xero_contact_id)
                                         OR (o.xero_contact_id IS NULL AND lower(q2.contact_name) = lower(o.contact_name)))),
    'purchase_orders', (SELECT COALESCE(jsonb_agg(jsonb_build_object('po_number', po.po_number, 'job_number', pj.job_number,
                                         'status', po.status, 'subtotal', po.subtotal)), '[]'::jsonb)
                          FROM public.purchase_orders po
                          LEFT JOIN public.jobs pj ON pj.id = po.job_id
                         WHERE ((o.xero_contact_id IS NOT NULL AND po.xero_contact_id = o.xero_contact_id)
                                OR lower(COALESCE(po.supplier_name, '')) = lower(COALESCE(o.contact_name, '-')))
                           AND COALESCE(lower(po.status), '') NOT IN ('deleted', 'cancelled')),
    'emails', (SELECT COALESCE(jsonb_agg(e ORDER BY e ->> 'at' DESC), '[]'::jsonb) FROM (
        SELECT DISTINCT ON (be.id) jsonb_strip_nulls(jsonb_build_object(
                 'at', be.occurred_at, 'subject', left(be.payload ->> 'subject', 300),
                 'from', left(be.payload ->> 'from', 200),
                 'text', left(COALESCE(be.payload ->> 'body_preview', be.payload ->> 'safe_summary'), 1500),
                 'attachment', a.file_name,
                 'on_job', bj.job_number)) AS e
          FROM public.context_email_attachments a
          JOIN public.business_events be ON be.id = a.business_event_id
          LEFT JOIN public.jobs bj ON bj.id = be.job_id
         WHERE length(regexp_replace(COALESCE(o.invoice_number, ''), '[^A-Za-z0-9]', '', 'g')) >= 5
           AND regexp_replace(lower(COALESCE(a.file_name, '')), '[^a-z0-9]', '', 'g')
               LIKE '%' || regexp_replace(lower(o.invoice_number), '[^a-z0-9]', '', 'g') || '%'
         ORDER BY be.id
         LIMIT 4) ee)
  ) ORDER BY o.sub_total DESC, o.xero_invoice_id), '[]'::jsonb)
  FROM open_rows o
$$;
REVOKE ALL ON FUNCTION public.materials_ai_bill_batch(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materials_ai_bill_batch(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.materials_ai_apply(p_call uuid, p_model text, p_decision jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  s public.materials_ai_settings%ROWTYPE;
  q public.materials_reconciliation_queue%ROWTYPE;
  b record;
  v_job public.jobs%ROWTYPE;
  v_bill text := btrim(COALESCE(p_decision ->> 'xero_invoice_id', ''));
  v_kind text := COALESCE(p_decision ->> 'decision', '');
  v_conf numeric;
  v_reason text := left(btrim(COALESCE(p_decision ->> 'reason', '')), 2000);
  v_evidence jsonb := CASE WHEN jsonb_typeof(p_decision -> 'evidence') = 'array' THEN p_decision -> 'evidence' ELSE '[]'::jsonb END;
  v_model text := left(COALESCE(NULLIF(btrim(p_model), ''), 'unknown'), 100);
  v_actor text;
  v_installer boolean := false;
  v_refusal text;
  v_outcome text;
  v_machine text;
  v_po uuid;
  v_check text := 'not_needed';
  v_id uuid;
  v_job_id uuid;
  v_job_number text;
BEGIN
  IF v_bill = '' THEN RAISE EXCEPTION 'materials_ai_apply: xero_invoice_id required'; END IF;
  IF v_kind NOT IN ('job', 'not_job_related', 'unsure') THEN
    RAISE EXCEPTION 'materials_ai_apply: decision must be job, not_job_related or unsure';
  END IF;
  IF v_reason = '' THEN v_reason := 'No reason given.'; END IF;
  v_conf := CASE WHEN jsonb_typeof(p_decision -> 'confidence') = 'number'
                 THEN LEAST(GREATEST((p_decision ->> 'confidence')::numeric, 0), 1) END;
  v_actor := 'ai:' || v_model;

  SELECT * INTO s FROM public.materials_ai_settings WHERE id;
  IF NOT FOUND OR NOT s.enabled THEN
    RETURN jsonb_build_object('outcome', 'off');
  END IF;

  -- The same per-bill lock as the allocation rows' no-mix trigger and the split.
  PERFORM pg_advisory_xact_lock(hashtextextended('job_materials_facts:' || v_bill, 0));

  SELECT * INTO q FROM public.materials_reconciliation_queue WHERE xero_invoice_id = v_bill FOR UPDATE;
  SELECT x.status, x.sub_total, x.line_items, x.invoice_date INTO b
    FROM public.xero_invoices x
   WHERE x.xero_invoice_id = v_bill AND x.invoice_type = 'ACCPAY'
   ORDER BY (x.status IN ('AUTHORISED', 'PAID')) DESC
   LIMIT 1;
  IF FOUND THEN v_installer := public.job_cost_installer_bill(b.line_items); END IF;

  -- Refusals: the bill is no longer the AI's to decide.
  IF q.id IS NULL THEN v_refusal := 'not in Bills to place';
  ELSIF q.status <> 'open' THEN v_refusal := 'already ' || q.status;
  ELSIF public.materials_ai_held_reason(q.suggestion_reason) THEN v_refusal := 'held for a person (' || q.suggestion_reason || ')';
  ELSIF b.status IS NULL OR b.status NOT IN ('AUTHORISED', 'PAID') THEN v_refusal := 'not live in Xero';
  ELSIF b.sub_total IS NULL OR b.sub_total <= 0 THEN v_refusal := 'no known amount';
  ELSIF public.materials_ai_trade_mirror(v_bill, b.line_items) THEN v_refusal := 'a trade app invoice, counted through the trade app';
  ELSIF EXISTS (SELECT 1 FROM public.materials_ai_placements p WHERE p.xero_invoice_id = v_bill AND p.undone_at IS NOT NULL) THEN
    v_refusal := 'a person undid an AI placement on this bill';
  ELSIF EXISTS (SELECT 1 FROM public.materials_ai_placements p WHERE p.xero_invoice_id = v_bill
                  AND p.outcome IN ('placed', 'filed_not_job_related') AND p.undone_at IS NULL) THEN
    v_refusal := 'already decided by the AI';
  ELSIF EXISTS (SELECT 1 FROM public.job_materials_facts f WHERE f.xero_invoice_id = v_bill
                  AND f.automation_source IN ('manual_queue', 'manual_split', 'agent_ai')) THEN
    v_refusal := 'a person placed this bill';
  END IF;

  IF v_refusal IS NULL AND v_kind = 'job' THEN
    IF COALESCE(p_decision ->> 'job_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      SELECT * INTO v_job FROM public.jobs WHERE id = (p_decision ->> 'job_id')::uuid;
    ELSIF COALESCE(btrim(p_decision ->> 'job_number'), '') <> '' THEN
      SELECT * INTO v_job FROM public.jobs WHERE upper(job_number) = upper(btrim(p_decision ->> 'job_number'))
       ORDER BY created_at DESC LIMIT 1;
    END IF;
    IF v_job.id IS NULL THEN v_refusal := 'job not found';
    ELSIF lower(COALESCE(v_job.metadata ->> 'do_not_schedule', '')) = 'true' THEN v_refusal := 'a holding job';
    ELSIF lower(COALESCE(v_job.status, '')) IN ('cancelled', 'lost') THEN v_refusal := 'job is ' || v_job.status;
    END IF;
    v_job_id := v_job.id;
    v_job_number := v_job.job_number;
  END IF;
  IF v_refusal IS NULL AND v_kind = 'job' THEN
    -- Another machine row on a materials bill means the rules already placed it:
    -- the queue row would not be open. Only an installer bill's machine row
    -- (installer_confirm) is the AI's to replace.
    SELECT f.automation_source, f.matched_po_id INTO v_machine, v_po FROM public.job_materials_facts f
     WHERE f.xero_invoice_id = v_bill LIMIT 1;
    IF v_machine IS NOT NULL AND NOT v_installer THEN
      v_refusal := 'already placed by ' || v_machine;
    END IF;
  END IF;

  IF v_refusal IS NOT NULL THEN
    INSERT INTO public.materials_ai_placements (call_id, xero_invoice_id, invoice_number, contact_name, amount_ex, installer,
      decision, job_id, job_number, confidence, bar, reason, evidence, model, outcome, refusal)
    VALUES (p_call, v_bill, q.invoice_number, q.contact_name, round(b.sub_total, 2), v_installer,
      v_kind, v_job_id, v_job_number, v_conf, s.confidence_bar, v_reason, v_evidence, v_model, 'refused', left(v_refusal, 300))
    RETURNING id INTO v_id;
    RETURN jsonb_build_object('outcome', 'refused', 'placement_id', v_id, 'refusal', v_refusal);
  END IF;

  -- Below the bar, or not sure: left for a person, with the AI's reason.
  IF v_kind = 'unsure' OR v_conf IS NULL OR v_conf < s.confidence_bar THEN
    INSERT INTO public.materials_ai_placements (call_id, xero_invoice_id, invoice_number, contact_name, amount_ex, installer,
      decision, job_id, job_number, confidence, bar, reason, evidence, model, outcome)
    VALUES (p_call, v_bill, q.invoice_number, q.contact_name, round(b.sub_total, 2), v_installer,
      v_kind, v_job_id, v_job_number, v_conf, s.confidence_bar, v_reason, v_evidence, v_model, 'left_for_person')
    RETURNING id INTO v_id;
    RETURN jsonb_build_object('outcome', 'left_for_person', 'placement_id', v_id);
  END IF;

  -- A different model checks the big ones, closed jobs and a sample, the same day.
  IF b.sub_total >= s.second_check_over_ex
     OR (v_kind = 'job' AND lower(COALESCE(v_job.status, '')) IN ('archived', 'complete', 'completed', 'invoiced', 'final_payment', 'get_review'))
     OR random() < s.second_check_sample THEN
    v_check := 'due';
  END IF;

  IF v_kind = 'job' THEN
    -- An installer bill a rule placed (installer_confirm): the AI's row replaces it.
    IF v_machine IS NOT NULL THEN
      DELETE FROM public.job_materials_facts WHERE xero_invoice_id = v_bill;
    END IF;
    INSERT INTO public.job_materials_facts (
      org_id, xero_invoice_id, invoice_number, xero_contact_id, contact_name, job_id, job_number,
      lane, kind, amount_ex_gst, amount_inc_gst, confidence, automation_source, match_reason,
      fact_date, assigned_by, updated_at, matched_po_id)
    VALUES (
      q.org_id, q.xero_invoice_id, q.invoice_number, q.xero_contact_id, q.contact_name, v_job.id, v_job.job_number,
      CASE WHEN v_installer THEN 'labour' ELSE 'materials' END, 'actual', round(b.sub_total, 2), q.total,
      CASE WHEN v_conf >= 0.95 THEN 'high' ELSE 'medium' END, 'agent_ai',
      left('agent_ai: ' || v_reason, 500),
      COALESCE(q.invoice_date, b.invoice_date), v_actor, now(),
      CASE WHEN v_machine IS NOT NULL THEN v_po END);
    UPDATE public.materials_reconciliation_queue
       SET status = 'assigned', assigned_job_id = v_job.id, assigned_by = v_actor, assigned_at = now(), updated_at = now()
     WHERE id = q.id;
    v_outcome := 'placed';
  ELSE
    IF v_machine IS NOT NULL OR EXISTS (SELECT 1 FROM public.job_materials_facts f WHERE f.xero_invoice_id = v_bill) THEN
      -- Filing a bill a rule placed is a person's call.
      INSERT INTO public.materials_ai_placements (call_id, xero_invoice_id, invoice_number, contact_name, amount_ex, installer,
        decision, confidence, bar, reason, evidence, model, outcome, refusal)
      VALUES (p_call, v_bill, q.invoice_number, q.contact_name, round(b.sub_total, 2), v_installer,
        v_kind, v_conf, s.confidence_bar, v_reason, v_evidence, v_model, 'left_for_person', 'a rule placed it on a job')
      RETURNING id INTO v_id;
      RETURN jsonb_build_object('outcome', 'left_for_person', 'placement_id', v_id);
    END IF;
    UPDATE public.materials_reconciliation_queue
       SET status = 'not_job_related', assigned_job_id = NULL, assigned_by = v_actor, assigned_at = now(), updated_at = now()
     WHERE id = q.id;
    v_outcome := 'filed_not_job_related';
  END IF;

  INSERT INTO public.materials_ai_placements (call_id, xero_invoice_id, invoice_number, contact_name, amount_ex, installer,
    decision, job_id, job_number, confidence, bar, reason, evidence, model, outcome, replaced_machine_source, second_check_status)
  VALUES (p_call, v_bill, q.invoice_number, q.contact_name, round(b.sub_total, 2), v_installer,
    v_kind, v_job_id, v_job_number, v_conf, s.confidence_bar, v_reason, v_evidence, v_model, v_outcome, v_machine, v_check)
  RETURNING id INTO v_id;

  IF v_kind = 'job' THEN
    INSERT INTO public.job_events (job_id, event_type, detail_json)
    VALUES (v_job.id, 'materials_bill_assigned', jsonb_build_object(
      'source', 'agent_ai', 'action', 'ai-bill-reader', 'manual', false,
      'placement_id', v_id, 'model', v_model, 'confidence', v_conf, 'reason', left(v_reason, 600),
      'xero_invoice_id', v_bill, 'invoice_number', q.invoice_number, 'contact_name', q.contact_name,
      'amount_ex_gst', round(b.sub_total, 2), 'job_number', v_job.job_number, 'installer', v_installer,
      'replaced', v_machine, 'reversible', 'Undo in Bills to place (materials_ai_undo)'));
  END IF;

  RETURN jsonb_build_object('outcome', v_outcome, 'placement_id', v_id, 'second_check', v_check);
END;
$$;
REVOKE ALL ON FUNCTION public.materials_ai_apply(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materials_ai_apply(uuid, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.materials_ai_second_check_due(p_limit integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'placement_id', p.id, 'xero_invoice_id', p.xero_invoice_id, 'invoice_number', p.invoice_number,
           'supplier', p.contact_name, 'amount_ex', p.amount_ex, 'installer', p.installer,
           'invoice_date', q.invoice_date, 'reference', x.reference,
           'lines', (SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                       'description', left(li.value ->> 'Description', 400), 'account', li.value ->> 'AccountCode',
                       'amount', li.value -> 'LineAmount'))), '[]'::jsonb)
                       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.line_items) = 'array' THEN x.line_items ELSE '[]'::jsonb END) li))
           ORDER BY p.created_at), '[]'::jsonb)
    FROM (SELECT * FROM public.materials_ai_placements
           WHERE second_check_status = 'due' AND undone_at IS NULL
           ORDER BY created_at LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 6), 20))) p
    LEFT JOIN public.materials_reconciliation_queue q ON q.xero_invoice_id = p.xero_invoice_id
    LEFT JOIN LATERAL (SELECT x.reference, x.line_items FROM public.xero_invoices x
                        WHERE x.xero_invoice_id = p.xero_invoice_id AND x.invoice_type = 'ACCPAY'
                        ORDER BY (x.status IN ('AUTHORISED', 'PAID')) DESC LIMIT 1) x ON true
$$;
REVOKE ALL ON FUNCTION public.materials_ai_second_check_due(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materials_ai_second_check_due(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.materials_ai_record_second_check(p_placement uuid, p_result jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  p public.materials_ai_placements%ROWTYPE;
  s public.materials_ai_settings%ROWTYPE;
  v_agree boolean;
  v_day date := (now() AT TIME ZONE 'Australia/Perth')::date;
  v_checked integer;
  v_disagreed integer;
  v_raised boolean := false;
BEGIN
  SELECT * INTO p FROM public.materials_ai_placements WHERE id = p_placement FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'second_check: placement not found'; END IF;
  IF p.second_check_status <> 'due' THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'status', p.second_check_status);
  END IF;
  v_agree := COALESCE(p_result ->> 'decision', '') = p.decision
             AND (p.decision <> 'job' OR upper(btrim(COALESCE(p_result ->> 'job_number', ''))) = upper(COALESCE(p.job_number, '')));
  UPDATE public.materials_ai_placements
     SET second_check_status = CASE WHEN v_agree THEN 'agreed' ELSE 'disagreed' END,
         second_check = jsonb_build_object(
           'decision', p_result ->> 'decision', 'job_number', p_result ->> 'job_number',
           'confidence', p_result -> 'confidence', 'reason', left(p_result ->> 'reason', 2000),
           'model', left(p_result ->> 'model', 100)),
         second_check_at = now()
   WHERE id = p.id;

  SELECT count(*) FILTER (WHERE second_check_status IN ('agreed', 'disagreed')),
         count(*) FILTER (WHERE second_check_status = 'disagreed')
    INTO v_checked, v_disagreed
    FROM public.materials_ai_placements
   WHERE second_check_at IS NOT NULL AND (second_check_at AT TIME ZONE 'Australia/Perth')::date = v_day;
  SELECT * INTO s FROM public.materials_ai_settings WHERE id FOR UPDATE;
  IF v_checked >= 10 AND v_disagreed::numeric / v_checked > s.disagreement_raise_at AND s.confidence_bar < 0.97
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.bar_history) h
                      WHERE h ->> 'day' = v_day::text AND h ->> 'why' = 'disagreement') THEN
    UPDATE public.materials_ai_settings
       SET confidence_bar = LEAST(confidence_bar + 0.03, 0.97),
           bar_history = bar_history || jsonb_build_array(jsonb_build_object(
             'day', v_day, 'at', now(), 'why', 'disagreement', 'from', confidence_bar,
             'to', LEAST(confidence_bar + 0.03, 0.97), 'checked', v_checked, 'disagreed', v_disagreed)),
           updated_at = now(), updated_by = 'auto:second_check'
     WHERE id;
    v_raised := true;
  END IF;
  RETURN jsonb_build_object('ok', true, 'agreed', v_agree, 'bar_raised', v_raised);
END;
$$;
REVOKE ALL ON FUNCTION public.materials_ai_record_second_check(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materials_ai_record_second_check(uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.materials_ai_status()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH s AS (SELECT * FROM public.materials_ai_settings WHERE id),
  d AS (SELECT (now() AT TIME ZONE 'Australia/Perth')::date AS day),
  p AS (SELECT * FROM public.materials_ai_placements),
  latest AS (SELECT DISTINCT ON (xero_invoice_id) * FROM public.materials_ai_placements ORDER BY xero_invoice_id, created_at DESC)
  SELECT jsonb_build_object(
    'enabled', s.enabled,
    'confidence_bar', s.confidence_bar,
    'daily_call_cap', s.daily_call_cap,
    'calls_today', (SELECT count(*) FROM public.materials_ai_calls c, d WHERE c.run_date = d.day),
    'placed', (SELECT count(*) FROM p WHERE outcome = 'placed' AND undone_at IS NULL),
    'placed_ex', (SELECT COALESCE(sum(amount_ex), 0) FROM p WHERE outcome = 'placed' AND undone_at IS NULL),
    'placed_installer', (SELECT count(*) FROM p WHERE outcome = 'placed' AND undone_at IS NULL AND installer),
    'filed_not_job_related', (SELECT count(*) FROM p WHERE outcome = 'filed_not_job_related' AND undone_at IS NULL),
    'filed_ex', (SELECT COALESCE(sum(amount_ex), 0) FROM p WHERE outcome = 'filed_not_job_related' AND undone_at IS NULL),
    'undone', (SELECT count(*) FROM p WHERE undone_at IS NOT NULL),
    'left_for_person_open', (SELECT count(*) FROM latest l JOIN public.materials_reconciliation_queue q
                              ON q.xero_invoice_id = l.xero_invoice_id AND q.status = 'open'
                             WHERE l.outcome = 'left_for_person'),
    'second_check', jsonb_build_object(
      'due', (SELECT count(*) FROM p WHERE second_check_status = 'due' AND undone_at IS NULL),
      'agreed', (SELECT count(*) FROM p WHERE second_check_status = 'agreed'),
      'disagreed', (SELECT count(*) FROM p WHERE second_check_status = 'disagreed')),
    'bills_to_place_open', (SELECT count(*) FROM public.materials_reconciliation_queue WHERE status = 'open'),
    'bills_to_place_open_ex', (SELECT COALESCE(sum(sub_total), 0) FROM public.materials_reconciliation_queue WHERE status = 'open'),
    'bar_history', s.bar_history)
  FROM s
$$;
REVOKE ALL ON FUNCTION public.materials_ai_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materials_ai_status() TO service_role;

DROP FUNCTION IF EXISTS public.materials_ai_hard_keys(text, uuid);

DROP INDEX IF EXISTS public.materials_ai_placements_held_uidx;
ALTER TABLE public.materials_ai_placements DROP CONSTRAINT IF EXISTS materials_ai_placements_held_chk;
ALTER TABLE public.materials_ai_placements DROP CONSTRAINT IF EXISTS materials_ai_placements_keys_chk;
ALTER TABLE public.materials_ai_placements DROP CONSTRAINT IF EXISTS materials_ai_placements_outcome_chk;
ALTER TABLE public.materials_ai_placements DROP CONSTRAINT IF EXISTS materials_ai_placements_outcome_check;
ALTER TABLE public.materials_ai_placements ADD CONSTRAINT materials_ai_placements_outcome_check
  CHECK (outcome IN ('placed', 'filed_not_job_related', 'left_for_person', 'refused'));
ALTER TABLE public.materials_ai_placements
  DROP COLUMN IF EXISTS agreed_keys,
  DROP COLUMN IF EXISTS key_evidence,
  DROP COLUMN IF EXISTS held_at;
