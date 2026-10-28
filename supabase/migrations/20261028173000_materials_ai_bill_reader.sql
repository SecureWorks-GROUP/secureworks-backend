-- AI bill reader, live (28 Oct 2026).
--
-- Owner's word, 28 Oct 2026: "no shadow mode, get me to live state now", and
-- "yes it can place all bills, people should only confirm absolute edge cases
-- that we aren't sure about". This replaces the 20 Oct installer rule (JP-12,
-- a person confirms each installer bill): the AI bill reader places installer
-- bills too, and its placement counts as cost like a person's.
--
-- Rules still run first (xero-sync: Xero job link, PO, job number). What the
-- rules leave in Bills to place is read by the AI bill reader (Jarvis,
-- ChatGPT), which decides a job, "not job related", or "not sure".
--
-- 1. job_materials_facts.automation_source gains 'agent_ai'.
-- 2. materials_ai_settings: one row. On/off, the confidence bar (a placement
--    below it is left for a person), the daily call cap, bills per call, the
--    second-check threshold and the automatic bar rise.
-- 3. materials_ai_placements: one audit row per AI decision on a bill, with
--    the reason, the evidence and the model. One live placement per bill.
--    An undone placement is kept, and that bill is never read by the AI again.
-- 4. materials_ai_calls: one row per reader call (the daily cap counts these).
-- 5. Functions, service role only:
--    materials_ai_bill_batch(limit)        the next bills to read, biggest
--                                          dollars first, with their evidence
--    materials_ai_candidate_jobs(from, to) jobs a bill dated in that window
--                                          may belong to
--    materials_ai_reserve_call / _finish_call
--    materials_ai_apply(call, decision)    the only AI write: places the bill
--                                          (fact + queue row + audit + job
--                                          event in one transaction), files it
--                                          as not job related, or records that
--                                          it is left for a person
--    materials_ai_undo(placement, actor, note)
--                                          one-click Undo: the fact goes, the
--                                          queue row reopens, the audit row is
--                                          marked undone
--    materials_ai_second_check_due / _record_second_check
--                                          the blind check by a different
--                                          model; a day's disagreement over the
--                                          setting raises the bar
--    materials_ai_status()                 counts for the screen and reports
-- 6. v_bill_allocation_balance and v_job_cost_events: an installer bill the
--    AI placed counts as placed (agent_ai beside manual_queue/manual_split).
--    Every other line of both views is as 20261020181800 left it.
--
-- Never writes Xero. Never moves a bill a person placed, split or filed.
-- Rollback: supabase/rollbacks/20261028173000_materials_ai_bill_reader_down.sql

-- ─────────────────────────────────────────────────────────────
-- 1. Source
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.job_materials_facts DROP CONSTRAINT IF EXISTS job_materials_facts_source_chk;
ALTER TABLE public.job_materials_facts ADD CONSTRAINT job_materials_facts_source_chk
  CHECK (automation_source IN ('xero_ref_link', 'po_deterministic', 'manual_queue', 'agent_prematch', 'manual_split', 'agent_ai'));

-- ─────────────────────────────────────────────────────────────
-- 2. Settings
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.materials_ai_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT true,
  confidence_bar numeric(4,3) NOT NULL DEFAULT 0.850 CHECK (confidence_bar >= 0.5 AND confidence_bar <= 0.99),
  confidence_bar_floor numeric(4,3) NOT NULL DEFAULT 0.850 CHECK (confidence_bar_floor >= 0.5 AND confidence_bar_floor <= 0.99),
  daily_call_cap integer NOT NULL DEFAULT 800 CHECK (daily_call_cap BETWEEN 0 AND 2000),
  bills_per_call integer NOT NULL DEFAULT 6 CHECK (bills_per_call BETWEEN 1 AND 20),
  reread_after_days integer NOT NULL DEFAULT 14 CHECK (reread_after_days BETWEEN 1 AND 365),
  second_check_over_ex numeric(12,2) NOT NULL DEFAULT 5000 CHECK (second_check_over_ex >= 0),
  second_check_sample numeric(4,3) NOT NULL DEFAULT 0.100 CHECK (second_check_sample >= 0 AND second_check_sample <= 1),
  disagreement_raise_at numeric(4,3) NOT NULL DEFAULT 0.050 CHECK (disagreement_raise_at > 0 AND disagreement_raise_at <= 1),
  bar_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
INSERT INTO public.materials_ai_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
COMMENT ON TABLE public.materials_ai_settings IS
  'AI bill reader (20261028173000): one row. confidence_bar: a decision below it is left for a person. The bar rises by 0.03 (never above 0.97) when a day''s second-model disagreement passes disagreement_raise_at over at least 10 checks; each change is kept in bar_history. Service role only.';
ALTER TABLE public.materials_ai_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.materials_ai_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON TABLE public.materials_ai_settings TO service_role;
DROP POLICY IF EXISTS service_role_all ON public.materials_ai_settings;
CREATE POLICY service_role_all ON public.materials_ai_settings FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────
-- 3. Reader calls
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.materials_ai_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date date NOT NULL,
  kind text NOT NULL DEFAULT 'place' CHECK (kind IN ('place', 'second_check')),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
  bills integer NOT NULL DEFAULT 0 CHECK (bills >= 0),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  error text CHECK (error IS NULL OR length(error) <= 500),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS materials_ai_calls_day ON public.materials_ai_calls (run_date, kind);
ALTER TABLE public.materials_ai_calls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.materials_ai_calls FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.materials_ai_calls TO service_role;
DROP POLICY IF EXISTS service_role_all ON public.materials_ai_calls;
CREATE POLICY service_role_all ON public.materials_ai_calls FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────
-- 4. Audit
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.materials_ai_placements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid REFERENCES public.materials_ai_calls(id) ON DELETE SET NULL,
  xero_invoice_id text NOT NULL,
  invoice_number text,
  contact_name text,
  amount_ex numeric(12,2),
  installer boolean NOT NULL DEFAULT false,
  decision text NOT NULL CHECK (decision IN ('job', 'not_job_related', 'unsure')),
  job_id uuid,
  job_number text,
  confidence numeric(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  bar numeric(4,3),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('placed', 'filed_not_job_related', 'left_for_person', 'refused')),
  refusal text CHECK (refusal IS NULL OR length(refusal) <= 300),
  replaced_machine_source text,
  second_check_status text NOT NULL DEFAULT 'not_needed'
    CHECK (second_check_status IN ('not_needed', 'due', 'agreed', 'disagreed')),
  second_check jsonb,
  second_check_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  undone_by text,
  undo_note text CHECK (undo_note IS NULL OR length(undo_note) <= 500),
  CONSTRAINT materials_ai_placements_job CHECK ((decision = 'job' OR job_id IS NULL) AND (outcome <> 'placed' OR job_id IS NOT NULL)),
  CONSTRAINT materials_ai_placements_undo CHECK ((undone_at IS NULL) = (undone_by IS NULL)),
  CONSTRAINT materials_ai_placements_undo_kind CHECK (undone_at IS NULL OR outcome IN ('placed', 'filed_not_job_related'))
);
CREATE UNIQUE INDEX IF NOT EXISTS materials_ai_placements_live_uidx
  ON public.materials_ai_placements (xero_invoice_id)
  WHERE outcome IN ('placed', 'filed_not_job_related') AND undone_at IS NULL;
CREATE INDEX IF NOT EXISTS materials_ai_placements_bill ON public.materials_ai_placements (xero_invoice_id, created_at DESC);
CREATE INDEX IF NOT EXISTS materials_ai_placements_created ON public.materials_ai_placements (created_at DESC);
CREATE INDEX IF NOT EXISTS materials_ai_placements_check_due ON public.materials_ai_placements (created_at)
  WHERE second_check_status = 'due';
COMMENT ON TABLE public.materials_ai_placements IS
  'AI bill reader (20261028173000): one row per AI decision on a bill (placed, filed not job related, left for a person, refused), with the reason, evidence and model. At most one live placement per bill. Undo keeps the row (undone_at, undone_by) and the bill is never read by the AI again. second_check_*: a different model''s blind re-placement. Written only by materials_ai_apply, materials_ai_undo and materials_ai_record_second_check. Service role only.';
ALTER TABLE public.materials_ai_placements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.materials_ai_placements FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.materials_ai_placements TO service_role;
DROP POLICY IF EXISTS service_role_all ON public.materials_ai_placements;
CREATE POLICY service_role_all ON public.materials_ai_placements FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────
-- 5a. Helpers
-- ─────────────────────────────────────────────────────────────
-- A bill the trade app already counts as labour (a trade invoice's mirror).
CREATE OR REPLACE FUNCTION public.materials_ai_trade_mirror(p_xero_invoice_id text, p_line_items jsonb)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.trade_invoices t WHERE t.xero_bill_id = p_xero_invoice_id)
      OR EXISTS (SELECT 1
                   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_line_items) = 'array' THEN p_line_items ELSE '[]'::jsonb END) li
                  WHERE li.value ->> 'Description' ~ '\| SW - [A-Z]')
$$;
REVOKE ALL ON FUNCTION public.materials_ai_trade_mirror(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materials_ai_trade_mirror(text, jsonb) TO service_role;

-- Held for a person whatever the AI says: a contradicted fact, a Xero link to
-- another job, a duplicated supplier document. installer_confirm is NOT held
-- any more (owner 28 Oct 2026): the AI resolves it like any bill.
CREATE OR REPLACE FUNCTION public.materials_ai_held_reason(p_reason text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(p_reason, '') IN ('fact_contradicted', 'xero_link_conflict', 'duplicate_document', 'ai_undone')
$$;
REVOKE ALL ON FUNCTION public.materials_ai_held_reason(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materials_ai_held_reason(text) TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 5b. The next bills to read
-- ─────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────
-- 5c. Jobs a bill in this window may belong to
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.materials_ai_candidate_jobs(p_from date, p_to date)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'job_id', j.id,
           'job_number', j.job_number,
           'type', j.type,
           'status', j.status,
           'client', left(j.client_name, 120),
           'site', left(concat_ws(', ', NULLIF(btrim(j.site_address), ''), NULLIF(btrim(j.site_suburb), '')), 200),
           'created', j.created_at::date,
           'scheduled', (SELECT min(a.scheduled_date) FROM public.job_assignments a
                          WHERE a.job_id = j.id AND COALESCE(a.status, '') <> 'cancelled'))) ORDER BY j.job_number), '[]'::jsonb)
    FROM public.jobs j
   WHERE j.job_number IS NOT NULL
     AND lower(COALESCE(j.status, '')) NOT IN ('cancelled', 'lost')
     AND lower(COALESCE(j.metadata ->> 'do_not_schedule', '')) <> 'true'
     -- Made before the bill (plus a week: a bill can arrive dated before the card)
     AND j.created_at < (COALESCE(p_to, current_date) + 7)
     -- and alive around it: made in the half year before it, or booked on site
     -- from two months before to four months after it, or still open today.
     -- updated_at is not used: any later touch moves it, so every finished job
     -- would read as alive and the list would hold the whole company.
     AND (j.created_at >= (COALESCE(p_from, current_date) - 180)
          OR EXISTS (SELECT 1 FROM public.job_assignments a
                      WHERE a.job_id = j.id AND COALESCE(a.status, '') <> 'cancelled'
                        AND a.scheduled_date BETWEEN (COALESCE(p_from, current_date) - 60) AND (COALESCE(p_to, current_date) + 120))
          OR lower(COALESCE(j.status, '')) NOT IN ('archived', 'complete', 'completed', 'invoiced', 'final_payment', 'get_review', 'draft'))
$$;
REVOKE ALL ON FUNCTION public.materials_ai_candidate_jobs(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materials_ai_candidate_jobs(date, date) TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 5d. Calls and the daily cap
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.materials_ai_reserve_call(p_kind text, p_model text, p_bills integer)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  s public.materials_ai_settings%ROWTYPE;
  v_day date := (now() AT TIME ZONE 'Australia/Perth')::date;
  v_id uuid;
BEGIN
  SELECT * INTO s FROM public.materials_ai_settings WHERE id FOR UPDATE;
  IF NOT FOUND OR NOT s.enabled THEN RETURN NULL; END IF;
  IF COALESCE(p_kind, '') NOT IN ('place', 'second_check') THEN
    RAISE EXCEPTION 'materials_ai_reserve_call: kind must be place or second_check';
  END IF;
  IF (SELECT count(*) FROM public.materials_ai_calls WHERE run_date = v_day) >= s.daily_call_cap THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.materials_ai_calls (run_date, kind, model, bills)
  VALUES (v_day, p_kind, left(COALESCE(NULLIF(btrim(p_model), ''), 'unknown'), 100), GREATEST(COALESCE(p_bills, 0), 0))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.materials_ai_reserve_call(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materials_ai_reserve_call(text, text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.materials_ai_finish_call(p_call uuid, p_status text, p_error text)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  UPDATE public.materials_ai_calls
     SET status = CASE WHEN p_status = 'done' THEN 'done' ELSE 'failed' END,
         error = left(p_error, 500),
         finished_at = now()
   WHERE id = p_call AND status = 'running'
$$;
REVOKE ALL ON FUNCTION public.materials_ai_finish_call(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materials_ai_finish_call(uuid, text, text) TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 5e. Apply one decision
--     p_decision: {xero_invoice_id, decision: job|not_job_related|unsure,
--                  job_id?, job_number?, confidence: 0..1, reason, evidence: []}
--     Returns {outcome, placement_id, refusal?}.
-- ─────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────
-- 5f. Undo
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.materials_ai_undo(p_placement uuid, p_actor text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  p public.materials_ai_placements%ROWTYPE;
  q public.materials_reconciliation_queue%ROWTYPE;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'undo_refused: actor required';
  END IF;
  SELECT * INTO p FROM public.materials_ai_placements WHERE id = p_placement;
  IF NOT FOUND THEN RAISE EXCEPTION 'undo_refused: placement not found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('job_materials_facts:' || p.xero_invoice_id, 0));
  SELECT * INTO p FROM public.materials_ai_placements WHERE id = p_placement FOR UPDATE;
  IF p.undone_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'placement_id', p.id);
  END IF;
  IF p.outcome NOT IN ('placed', 'filed_not_job_related') THEN
    RAISE EXCEPTION 'undo_refused: the AI did not place or file this bill (%)', p.outcome;
  END IF;
  SELECT * INTO q FROM public.materials_reconciliation_queue WHERE xero_invoice_id = p.xero_invoice_id FOR UPDATE;
  -- Only the AI's own work comes off. If a person has since moved the bill,
  -- the person's decision stands and there is nothing to undo.
  IF q.id IS NULL OR q.assigned_by IS DISTINCT FROM ('ai:' || p.model)
     OR (p.outcome = 'placed' AND q.status <> 'assigned')
     OR (p.outcome = 'filed_not_job_related' AND q.status <> 'not_job_related') THEN
    RAISE EXCEPTION 'undo_refused: bill % was changed by a person after the AI; change it in Bills to place', p.invoice_number;
  END IF;
  IF p.outcome = 'placed' THEN
    DELETE FROM public.job_materials_facts
     WHERE xero_invoice_id = p.xero_invoice_id AND automation_source = 'agent_ai';
  END IF;
  UPDATE public.materials_reconciliation_queue
     SET status = 'open', assigned_job_id = NULL, assigned_by = NULL, assigned_at = NULL,
         suggestion_reason = 'ai_undone', updated_at = now()
   WHERE id = q.id;
  UPDATE public.materials_ai_placements
     SET undone_at = now(), undone_by = left(btrim(p_actor), 200), undo_note = left(NULLIF(btrim(COALESCE(p_note, '')), ''), 500)
   WHERE id = p.id;
  IF p.job_id IS NOT NULL THEN
    INSERT INTO public.job_events (job_id, event_type, detail_json)
    VALUES (p.job_id, 'materials_bill_unassigned', jsonb_build_object(
      'source', 'agent_ai_undo', 'placement_id', p.id, 'xero_invoice_id', p.xero_invoice_id,
      'invoice_number', p.invoice_number, 'contact_name', p.contact_name, 'amount_ex_gst', p.amount_ex,
      'undone_by', left(btrim(p_actor), 200), 'note', left(p_note, 500)));
  END IF;
  RETURN jsonb_build_object('ok', true, 'idempotent', false, 'placement_id', p.id, 'xero_invoice_id', p.xero_invoice_id);
END;
$$;
REVOKE ALL ON FUNCTION public.materials_ai_undo(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materials_ai_undo(uuid, text, text) TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 5g. Second-model check
-- ─────────────────────────────────────────────────────────────
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

-- p_result: {decision: job|not_job_related|unsure, job_number?, confidence, reason, model}
-- Agreement: same decision, and for a job the same job number. "unsure" is
-- not agreement. The day's disagreement share over at least 10 checks above
-- the setting raises the bar by 0.03 (never above 0.97), once a day.
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

-- ─────────────────────────────────────────────────────────────
-- 5h. Status
-- ─────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────
-- 6. Views: the AI's installer placement counts (only the three source lists
--    change; every other line is 20261020181800's)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_bill_allocation_balance AS
WITH alloc AS (
  SELECT f.xero_invoice_id, count(*) AS rows, sum(f.amount_ex_gst) AS allocated_ex,
         bool_or(f.automation_source IN ('manual_queue', 'manual_split', 'agent_ai')) AS person_placed
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
   AND NOT (COALESCE(b.installer, false) AND NOT COALESCE(a.person_placed, false) AND COALESCE(q.overhead_ex, 0) = 0)) AS balanced,
  q.status AS queue_status,
  -- JP-12: an installer bill whose rows no person made (only a split writes
  -- an overhead part, and only a person splits) is not allocated yet.
  (COALESCE(b.installer, false) AND NOT COALESCE(a.person_placed, false) AND COALESCE(q.overhead_ex, 0) = 0) AS installer_unconfirmed
FROM (SELECT xero_invoice_id FROM alloc
      UNION SELECT xero_invoice_id FROM public.materials_reconciliation_queue WHERE COALESCE(overhead_ex, 0) > 0) k
LEFT JOIN alloc a ON a.xero_invoice_id = k.xero_invoice_id
LEFT JOIN bills b ON b.xero_invoice_id = k.xero_invoice_id
LEFT JOIN public.materials_reconciliation_queue q ON q.xero_invoice_id = k.xero_invoice_id;

COMMENT ON VIEW public.v_bill_allocation_balance IS
  'CFO-18: every supplier bill with allocation rows or an overhead part. remainder_ex = bill ex GST - allocated - overhead; balanced when 0 to the cent and the bill is live in Xero (a voided or deleted bill with rows is never balanced: undo its rows). A bill amended in Xero after a split shows the drift as a remainder. A bill placed whole by one row is balanced only when that row carries the bill sub_total. JP-12: an installer bill (306/301) whose rows neither a person nor the AI bill reader (agent_ai, 20261028173000) made is installer_unconfirmed and never balanced. Read only, service role only.';
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
  'Job profit engine (20261009130000, CFO-12 20261019120000, CFO-18/20 20261020181800): one row per job cost, lane labour/materials/commission/other, source trade_line/supplier_bill/materials_fact/supplier_credit/installer_bill_unconfirmed/installer_bill_not_job_related/po_committed/po_ordered/po_invoice_emailed. A bill with an allocation row on another job is read through its rows only. supplier_credit is credit applied in Xero against a live bill, negative, in proportion. An installer bill (306/301) counts only once a person or the AI bill reader (agent_ai, 20261028173000) placed it on the job (JP-12): until then it is installer_bill_unconfirmed (and its credit too), and one a person marked not job related is installer_bill_not_job_related; neither is ever actual. The three po_ sources are never actual. Read only, service role only.';

