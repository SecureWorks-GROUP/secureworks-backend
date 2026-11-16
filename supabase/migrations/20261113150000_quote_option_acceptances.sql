-- Ruling 14 step 1 (13 Nov 2026): optional extras on a quote, ticked by the customer
-- when accepting (or by staff accepting by phone). The quote tool seals the options
-- and every tickable combination in pricing_json.optional_extras; send-quote picks the
-- ticked combination, checks it and writes this record.
--
--   quote_option_acceptances: one row per accepted whole-quote document whose released
--   revision offered options. It keeps every offered option (id, name, line, price ex
--   GST, GST, price inc GST, where it goes), the ticked ids, the base total and the
--   accepted totals and deposit. Not taken = offered minus taken ("offered, not taken"
--   on the job's record). Written once by send-quote (quote_options_store.ts) and never
--   changed; no browser role can read or write it.
--
--   accept_quote_document_with_options: marks the document accepted AND writes its
--   record in one transaction. send-quote never accepts an option offer any other
--   way, so there is never an accepted document without its record (a failed write
--   writes nothing and the customer's retry completes the same selection). Without
--   this migration an offer with options cannot be accepted at all (retry page).
--
--   apply_quote_options_to_scope_drafts: before the scope drafts are released, each
--   taken crew option's sealed labour line joins the job work order (and its total
--   the agreed labour), and the payer amounts and payment stages become the ticked
--   combination's. Checked against the frozen revision; a repeat replays. A NOT
--   taken option is on none of them. scope_payment_plan reads the combination's
--   stages for such a job (contract section 4.4).
--
--   Which record applies: the one on the job's current accepted quote
--   (job_documents.superseded_at null). Only the client's quote carries options; a
--   neighbour's acceptance writes no record. A record on a superseded document never
--   applies; one that took options on these drafts' revision, with no current
--   record, holds the drafts (scope_options_record_superseded). Two current records
--   are refused (scope_options_more_than_one_record).
--
--   Unknown crew labour: a taken crew option sealed with no total is refused
--   (scope_options_labour_unknown) and nothing is written, so no work order is
--   agreed or released at the base labour. send-quote also refuses such a line at
--   acceptance only when it is unreadable; a blank total is allowed there and held here.
--
-- A quote with no options writes no row and accepts exactly as before.
--
-- Rollback: supabase/rollbacks/20261113150000_quote_option_acceptances_down.sql. It
-- restores scope_payment_plan and drops the two functions and the write-once trigger.
-- It KEEPS the record table, its rows and the three draft-set columns, and does not
-- undo drafts already changed by apply_quote_options_to_scope_drafts (work order
-- labour, payer amounts, totals). It is not a restore of pre-option business content.

CREATE TABLE IF NOT EXISTS public.quote_option_acceptances (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                   uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  job_document_id          uuid NOT NULL REFERENCES public.job_documents(id) ON DELETE CASCADE,
  quote_revision_id        uuid NOT NULL REFERENCES public.quote_revisions(id),
  accepted_via             text NOT NULL CHECK (accepted_via IN ('public_link', 'staff_phone')),
  accepted_by              uuid,
  offered                  jsonb NOT NULL CHECK (
    jsonb_typeof(offered) = 'array'
    AND jsonb_array_length(offered) BETWEEN 1 AND 6
  ),
  taken_option_ids         text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(taken_option_ids) <= 6),
  base_total_inc_gst       numeric(12,2) NOT NULL CHECK (base_total_inc_gst >= 0),
  accepted_total_ex_gst    numeric(12,2) NOT NULL CHECK (accepted_total_ex_gst >= 0),
  accepted_gst             numeric(12,2) NOT NULL CHECK (accepted_gst >= 0),
  accepted_total_inc_gst   numeric(12,2) NOT NULL,
  accepted_deposit_inc_gst numeric(12,2) NOT NULL,
  -- The taken options and the ticked combination exactly as sealed: what goes on
  -- the supplier order, work order and office list is read from here.
  taken_options            jsonb NOT NULL DEFAULT '[]'::jsonb,
  accepted_combination     jsonb NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quote_option_acceptances_one_per_document UNIQUE (job_document_id),
  CONSTRAINT quote_option_acceptances_total_adds_up
    CHECK (accepted_total_inc_gst = accepted_total_ex_gst + accepted_gst),
  CONSTRAINT quote_option_acceptances_total_not_below_base
    CHECK (accepted_total_inc_gst >= base_total_inc_gst),
  CONSTRAINT quote_option_acceptances_staff_named
    CHECK (accepted_via <> 'staff_phone' OR accepted_by IS NOT NULL),
  CONSTRAINT quote_option_acceptances_deposit_within_total
    CHECK (accepted_deposit_inc_gst >= 0 AND accepted_deposit_inc_gst <= accepted_total_inc_gst),
  CONSTRAINT quote_option_acceptances_taken_sealed
    CHECK (jsonb_typeof(taken_options) = 'array'
      AND jsonb_array_length(taken_options) = cardinality(taken_option_ids)),
  CONSTRAINT quote_option_acceptances_combination_sealed
    CHECK (jsonb_typeof(accepted_combination) = 'object'
      AND COALESCE(jsonb_typeof(accepted_combination->'option_ids'), '') = 'array'
      AND jsonb_array_length(accepted_combination->'option_ids') = cardinality(taken_option_ids))
);
CREATE INDEX IF NOT EXISTS quote_option_acceptances_job_idx
  ON public.quote_option_acceptances (job_id);

COMMENT ON TABLE public.quote_option_acceptances IS
  'Ruling 14 step 1 (20261113150000): the options a customer (accepted_via public_link) or staff on the phone (staff_phone, accepted_by the staff user) ticked when accepting a whole-quote document whose released revision (quote_revision_id) carried pricing_json.optional_extras. offered: every option offered, [{id, name, line, sell_ex_gst, gst, sell_inc_gst, goes}]; taken_option_ids: the ticked ids; not taken = offered minus taken. The accepted totals and deposit are the tool''s precomputed combination for the ticked set, never worked out here. One row per document, written once by send-quote quote_options_store.ts; an update is refused.';

-- Written once: an acceptance record never changes.
CREATE OR REPLACE FUNCTION public.quote_option_acceptances_write_once()
RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'quote_option_acceptances is written once and never changed'
    USING ERRCODE = 'restrict_violation';
END $$;
REVOKE ALL ON FUNCTION public.quote_option_acceptances_write_once() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS quote_option_acceptances_write_once ON public.quote_option_acceptances;
CREATE TRIGGER quote_option_acceptances_write_once
  BEFORE UPDATE ON public.quote_option_acceptances
  FOR EACH ROW EXECUTE FUNCTION public.quote_option_acceptances_write_once();

ALTER TABLE public.quote_option_acceptances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.quote_option_acceptances FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.quote_option_acceptances TO service_role;
DROP POLICY IF EXISTS quote_option_acceptances_service_role_all ON public.quote_option_acceptances;
CREATE POLICY quote_option_acceptances_service_role_all ON public.quote_option_acceptances
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── The acceptance and its record, one transaction ─────────────────────────────
CREATE OR REPLACE FUNCTION public.accept_quote_document_with_options(
  p_document_id uuid, p_accepted_at timestamptz, p_record jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d public.job_documents%ROWTYPE;
  r public.quote_option_acceptances%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.job_documents WHERE id = p_document_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quote_options_document_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF d.accepted_at IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', false);
  END IF;
  IF p_accepted_at IS NULL OR jsonb_typeof(p_record) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'quote_options_record_invalid' USING ERRCODE = '22023';
  END IF;
  r := jsonb_populate_record(NULL::public.quote_option_acceptances, p_record);
  IF r.job_document_id IS DISTINCT FROM d.id OR r.job_id IS DISTINCT FROM d.job_id THEN
    RAISE EXCEPTION 'quote_options_record_not_this_document' USING ERRCODE = '22023';
  END IF;
  -- The record names the revision this document was sent as.
  IF NOT EXISTS (SELECT 1 FROM public.quote_revisions q
                  WHERE q.id = r.quote_revision_id AND q.job_document_id = d.id) THEN
    RAISE EXCEPTION 'quote_options_record_not_this_revision' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.quote_option_acceptances (
    job_id, job_document_id, quote_revision_id, accepted_via, accepted_by, offered,
    taken_option_ids, base_total_inc_gst, accepted_total_ex_gst, accepted_gst,
    accepted_total_inc_gst, accepted_deposit_inc_gst, taken_options, accepted_combination)
  VALUES (r.job_id, r.job_document_id, r.quote_revision_id, r.accepted_via, r.accepted_by, r.offered,
    COALESCE(r.taken_option_ids, '{}'::text[]), r.base_total_inc_gst, r.accepted_total_ex_gst, r.accepted_gst,
    r.accepted_total_inc_gst, r.accepted_deposit_inc_gst,
    COALESCE(p_record->'taken_options', '[]'::jsonb), p_record->'accepted_combination');
  UPDATE public.job_documents SET accepted_at = p_accepted_at WHERE id = d.id;
  RETURN jsonb_build_object('claimed', true);
END $$;
REVOKE ALL ON FUNCTION public.accept_quote_document_with_options(uuid, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_quote_document_with_options(uuid, timestamptz, jsonb) TO service_role;

-- ── Taken options on the scope drafts ───────────────────────────────────────────
ALTER TABLE public.scope_job_draft_sets
  ADD COLUMN IF NOT EXISTS quote_option_ids text[],
  ADD COLUMN IF NOT EXISTS quote_option_stages jsonb,
  ADD COLUMN IF NOT EXISTS quote_options_applied_at timestamptz;
COMMENT ON COLUMN public.scope_job_draft_sets.quote_option_ids IS
  'Ruling 14 step 1 (20261113150000): the quote options the customer took, applied to these drafts by apply_quote_options_to_scope_drafts before release. Null: none applied.';
COMMENT ON COLUMN public.scope_job_draft_sets.quote_option_stages IS
  'The ticked combination''s local_invoice_stages, read by scope_payment_plan in place of the base stages once options were applied.';

CREATE OR REPLACE FUNCTION public.apply_quote_options_to_scope_drafts(p_job_id uuid, p_scope_revision_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  j public.jobs%ROWTYPE; s public.scope_job_draft_sets%ROWTYPE; r public.scope_revisions%ROWTYPE;
  w public.work_orders%ROWTYPE; rec public.quote_option_acceptances%ROWTYPE;
  n int; pricing jsonb; combo jsonb; opt jsonb; ids text[]; combo_ids text[];
  lines jsonb; add_labour bigint := 0; c bigint;
  new_labour bigint; parties jsonb; party jsonb; payer text; seen text[] := ARRAY[]::text[];
  ex bigint; gst bigint; inc bigint; tex bigint; tgst bigint; tinc bigint;
  sx bigint := 0; sg bigint := 0; si bigint := 0;
  stages jsonb; base_has_stages boolean; touched int;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'scope_options_job_not_found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO s FROM public.scope_job_draft_sets WHERE job_id = j.id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('applied', false, 'reason', 'no_drafts'); END IF;
  IF s.scope_revision_id IS DISTINCT FROM p_scope_revision_id THEN
    RAISE EXCEPTION 'scope_drafts_accepted_revision_mismatch' USING ERRCODE = '23514';
  END IF;
  -- The applicable record is the one on the job's current accepted quote: a
  -- record on a document since superseded (a re-quote) never applies. Only the
  -- client's quote carries options, so a job has at most one current record.
  SELECT count(*) INTO n FROM public.quote_option_acceptances a
    JOIN public.job_documents d ON d.id = a.job_document_id
   WHERE a.job_id = j.id AND d.superseded_at IS NULL;
  IF n = 0 THEN
    -- A superseded record that took options on the revision these drafts were
    -- prepared from, with no current record: the drafts are held, never
    -- released at the base price while the re-quote is open.
    IF EXISTS (SELECT 1 FROM public.quote_option_acceptances a
                 JOIN public.job_documents d ON d.id = a.job_document_id
                 JOIN public.quote_revisions q ON q.id = a.quote_revision_id
                WHERE a.job_id = j.id AND d.superseded_at IS NOT NULL
                  AND q.scope_revision_id = s.scope_revision_id
                  AND cardinality(a.taken_option_ids) > 0) THEN
      RAISE EXCEPTION 'scope_options_record_superseded' USING ERRCODE = '23514';
    END IF;
    RETURN jsonb_build_object('applied', false, 'reason', 'no_options_record');
  END IF;
  IF n > 1 THEN RAISE EXCEPTION 'scope_options_more_than_one_record' USING ERRCODE = '23514'; END IF;
  SELECT a.* INTO rec FROM public.quote_option_acceptances a
    JOIN public.job_documents d ON d.id = a.job_document_id
   WHERE a.job_id = j.id AND d.superseded_at IS NULL;
  ids := COALESCE(rec.taken_option_ids, '{}'::text[]);
  IF s.quote_options_applied_at IS NOT NULL THEN
    IF s.quote_option_ids IS NOT DISTINCT FROM ids THEN
      RETURN jsonb_build_object('applied', true, 'replayed', true);
    END IF;
    RAISE EXCEPTION 'scope_options_applied_differently' USING ERRCODE = '23514';
  END IF;
  IF s.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'scope_options_after_release' USING ERRCODE = '23514';
  END IF;
  IF cardinality(ids) = 0 THEN
    -- Nothing taken: the drafts are the base price as prepared.
    UPDATE public.scope_job_draft_sets SET quote_option_ids = ids, quote_options_applied_at = now()
      WHERE job_id = j.id;
    RETURN jsonb_build_object('applied', true, 'taken', 0);
  END IF;

  -- The record must be what the frozen revision sealed: the ticked combination
  -- and every taken option, entry for entry.
  SELECT * INTO r FROM public.scope_revisions WHERE id = s.scope_revision_id AND job_id = j.id
    AND status IN ('frozen', 'superseded');
  IF NOT FOUND OR encode(sha256(convert_to(r.pricing_canonical_text, 'UTF8')), 'hex') <> r.pricing_hash THEN
    RAISE EXCEPTION 'scope_drafts_source_corrupt' USING ERRCODE = '23514';
  END IF;
  pricing := r.pricing_canonical_text::jsonb;
  combo := rec.accepted_combination;
  -- Exact equality, never containment: a subset of a sealed entry is not it.
  IF jsonb_typeof(pricing#>'{optional_extras,combinations}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(pricing#>'{optional_extras,options}') IS DISTINCT FROM 'array'
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(pricing#>'{optional_extras,combinations}') e
                    WHERE e.value = combo) THEN
    RAISE EXCEPTION 'scope_options_not_sealed' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(array_agg(x ORDER BY o), '{}'::text[]) INTO combo_ids
    FROM jsonb_array_elements_text(combo->'option_ids') WITH ORDINALITY t(x, o);
  IF combo_ids IS DISTINCT FROM ids OR jsonb_array_length(rec.taken_options) <> cardinality(ids) THEN
    RAISE EXCEPTION 'scope_options_not_sealed' USING ERRCODE = '23514';
  END IF;
  FOR opt IN SELECT value FROM jsonb_array_elements(rec.taken_options) LOOP
    IF NOT (opt->>'id' = ANY(ids))
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(pricing#>'{optional_extras,options}') e
                      WHERE e.value = opt) THEN
      RAISE EXCEPTION 'scope_options_not_sealed' USING ERRCODE = '23514';
    END IF;
  END LOOP;

  -- Crew: each labour line appended as sealed; its total joins the agreed
  -- labour. A blank total is unknown labour: nothing is written and the drafts
  -- are held, never issued with the base labour as the agreed figure.
  lines := s.labour_lines;
  FOR opt IN SELECT value FROM jsonb_array_elements(rec.taken_options) WHERE value->>'goes' = 'crew' LOOP
    IF jsonb_typeof(opt->'labour_line') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'scope_options_labour_line_invalid' USING ERRCODE = '23514';
    END IF;
    c := public.scope_draft_cents(opt#>'{labour_line,total}');
    IF c IS NULL THEN RAISE EXCEPTION 'scope_options_labour_unknown' USING ERRCODE = '23514'; END IF;
    add_labour := add_labour + c;
    lines := lines || jsonb_build_array(opt->'labour_line');
  END LOOP;
  new_labour := CASE WHEN s.labour_total_cents IS NULL THEN NULL ELSE s.labour_total_cents + add_labour END;

  -- Money: the combination's totals and every payer's share (no parties: the
  -- client alone, as the drafts were prepared).
  tex := public.scope_draft_cents(combo->'totalExGST');
  tgst := public.scope_draft_cents(combo->'gst');
  tinc := public.scope_draft_cents(combo->'totalIncGST');
  IF tex IS NULL OR tgst IS NULL OR tinc IS NULL OR tex + tgst <> tinc THEN
    RAISE EXCEPTION 'scope_drafts_totals_mismatch' USING ERRCODE = '23514';
  END IF;
  parties := combo->'parties';
  IF parties IS NULL OR parties IN ('null'::jsonb, '[]'::jsonb) THEN
    IF pricing->'parties' IS NOT NULL AND pricing->'parties' NOT IN ('null'::jsonb, '[]'::jsonb) THEN
      RAISE EXCEPTION 'scope_drafts_payers_invalid' USING ERRCODE = '23514';
    END IF;
    parties := jsonb_build_array(jsonb_build_object('id', '__client__', 'ex_gst', combo->'totalExGST',
      'gst', combo->'gst', 'inc_gst', combo->'totalIncGST'));
  END IF;
  IF jsonb_typeof(parties) <> 'array' OR jsonb_array_length(parties) = 0 THEN
    RAISE EXCEPTION 'scope_drafts_payers_invalid' USING ERRCODE = '23514';
  END IF;
  FOR party IN SELECT value FROM jsonb_array_elements(parties) LOOP
    payer := party->>'id';
    IF jsonb_typeof(party->'id') IS DISTINCT FROM 'string' OR payer = '' OR payer = ANY(seen)
      OR NOT EXISTS (SELECT 1 FROM public.scope_job_draft_invoices i
                      WHERE i.job_id = j.id AND i.scope_revision_id = s.scope_revision_id AND i.payer_id = payer) THEN
      RAISE EXCEPTION 'scope_drafts_payers_invalid' USING ERRCODE = '23514';
    END IF;
    seen := array_append(seen, payer);
    ex := public.scope_draft_cents(party->'ex_gst'); gst := public.scope_draft_cents(party->'gst');
    inc := public.scope_draft_cents(party->'inc_gst');
    IF ex IS NULL OR gst IS NULL OR inc IS NULL OR ex + gst <> inc THEN
      RAISE EXCEPTION 'scope_drafts_payer_totals_mismatch' USING ERRCODE = '23514';
    END IF;
    sx := sx + ex; sg := sg + gst; si := si + inc;
  END LOOP;
  IF sx <> tex OR sg <> tgst OR si <> tinc
    OR (SELECT count(*) FROM public.scope_job_draft_invoices i
         WHERE i.job_id = j.id AND i.scope_revision_id = s.scope_revision_id) <> cardinality(seen) THEN
    RAISE EXCEPTION 'scope_drafts_payer_sum_mismatch' USING ERRCODE = '23514';
  END IF;
  base_has_stages := pricing->'local_invoice_stages' IS NOT NULL AND pricing->'local_invoice_stages' <> 'null'::jsonb;
  stages := combo->'local_invoice_stages';
  IF stages = 'null'::jsonb THEN stages := NULL; END IF;
  IF base_has_stages IS DISTINCT FROM (stages IS NOT NULL) THEN
    RAISE EXCEPTION 'scope_options_stages_not_sealed' USING ERRCODE = '23514';
  END IF;

  -- The work order: still the untouched draft the scope prepared.
  SELECT * INTO w FROM public.work_orders WHERE id = s.work_order_id FOR UPDATE;
  IF NOT FOUND OR w.status IS DISTINCT FROM 'draft' OR w.approved_at IS NOT NULL OR w.sealed_content_hash IS NOT NULL THEN
    RAISE EXCEPTION 'scope_drafts_work_order_sealed' USING ERRCODE = '23514';
  END IF;
  IF w.scope_items IS DISTINCT FROM s.labour_lines
    OR w.agreed_labour_ex IS DISTINCT FROM s.labour_total_cents / 100.0 THEN
    RAISE EXCEPTION 'scope_drafts_source_changed' USING ERRCODE = '23514';
  END IF;
  PERFORM set_config('secureworks.scope_draft_prepare', j.id::text, true);
  UPDATE public.work_orders SET scope_items = lines, agreed_labour_ex = new_labour / 100.0, updated_at = now()
    WHERE id = w.id;
  PERFORM set_config('secureworks.scope_draft_prepare', '', true);

  UPDATE public.scope_job_draft_sets
     SET labour_lines = lines, labour_total_cents = new_labour,
         totals = jsonb_build_object('ex_cents', tex, 'gst_cents', tgst, 'inc_cents', tinc),
         amounts_confirmed = s.amounts_confirmed,
         quote_option_ids = ids, quote_option_stages = stages, quote_options_applied_at = now()
   WHERE job_id = j.id;
  FOR party IN SELECT value FROM jsonb_array_elements(parties) LOOP
    UPDATE public.scope_job_draft_invoices
       SET ex_cents = public.scope_draft_cents(party->'ex_gst'), gst_cents = public.scope_draft_cents(party->'gst'),
           inc_cents = public.scope_draft_cents(party->'inc_gst')
     WHERE job_id = j.id AND scope_revision_id = s.scope_revision_id AND payer_id = party->>'id';
    GET DIAGNOSTICS touched = ROW_COUNT;
    IF touched <> 1 THEN RAISE EXCEPTION 'scope_drafts_payers_invalid' USING ERRCODE = '23514'; END IF;
  END LOOP;
  -- Ids only: job_events is readable by trades.
  INSERT INTO public.job_events(job_id, event_type, detail_json) VALUES
    (j.id, 'scope_job_drafts_quote_options_applied', jsonb_build_object(
      'work_order_id', s.work_order_id, 'scope_revision_id', s.scope_revision_id,
      'option_ids', to_jsonb(ids)));
  RETURN jsonb_build_object('applied', true, 'taken', cardinality(ids));
END $$;
REVOKE ALL ON FUNCTION public.apply_quote_options_to_scope_drafts(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_quote_options_to_scope_drafts(uuid, uuid) TO service_role;

-- ── The payment plan reads the taken combination's stages ──────────────────────
-- Same body as 20261106044806 with one addition (marked): with options applied,
-- the stages are the ticked combination's.
CREATE OR REPLACE FUNCTION public.scope_payment_plan(p_job uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.scope_job_draft_sets%ROWTYPE; plan public.scope_payment_plans%ROWTYPE;
  schedule jsonb; stage jsonb; payer jsonb; ids text[]:=ARRAY[]::text[]; payer_ids text[];
  amount bigint; total bigint:=0; payer_total bigint; parent record; stage_total bigint; ordinal int:=0;
BEGIN
  -- Same job-first lock order as the parent producer and release.
  PERFORM 1 FROM public.jobs WHERE id=p_job FOR UPDATE NOWAIT;
  SELECT * INTO d FROM public.scope_job_draft_sets WHERE job_id=p_job;
  IF NOT FOUND OR d.released_at IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO plan FROM public.scope_payment_plans WHERE job_id=p_job;
  IF FOUND THEN
    IF plan.scope_revision_id<>d.scope_revision_id THEN RAISE EXCEPTION 'scope_payment_revision_mismatch'; END IF;
    RETURN plan.schedule;
  END IF;
  SELECT r.pricing_canonical_text::jsonb->'local_invoice_stages' INTO schedule
    FROM public.scope_revisions r WHERE r.id=d.scope_revision_id AND r.job_id=p_job
      AND r.status IN ('frozen','superseded')
      AND encode(sha256(convert_to(r.pricing_canonical_text,'UTF8')),'hex')=r.pricing_hash;
  -- Ruling 14 step 1 (20261113150000): a job whose customer took quote options
  -- is paid by the ticked combination's stages, applied to the drafts before
  -- release by apply_quote_options_to_scope_drafts; the base stages are obsolete.
  IF cardinality(coalesce(d.quote_option_ids,'{}'::text[]))>0 THEN
    schedule:=d.quote_option_stages;
  END IF;
  IF schedule IS NULL OR schedule='null'::jsonb THEN RETURN NULL; END IF;
  IF NOT d.amounts_confirmed OR schedule->'version' IS DISTINCT FROM '1'::jsonb OR schedule->>'currency' IS DISTINCT FROM 'AUD'
    OR schedule->>'terms_version' IS DISTINCT FROM '2026-11-06' OR jsonb_typeof(schedule->'stages') IS DISTINCT FROM 'array'
    OR jsonb_array_length(schedule->'stages')=0
    OR public.scope_draft_cents(schedule->'total_inc_gst') IS DISTINCT FROM (d.totals->>'inc_cents')::bigint THEN
    RAISE EXCEPTION 'scope_payment_schedule_invalid' USING ERRCODE='23514';
  END IF;
  FOR stage IN SELECT value FROM jsonb_array_elements(schedule->'stages') LOOP
    ordinal:=ordinal+1;
    amount:=public.scope_draft_cents(stage->'amount_inc_gst');
    IF amount IS NULL OR jsonb_typeof(stage->'id') IS DISTINCT FROM 'string'
      OR coalesce(stage->>'id','')='' OR length(stage->>'id')>200 OR stage->>'id'=ANY(ids)
      OR jsonb_typeof(stage->'label') IS DISTINCT FROM 'string' OR jsonb_typeof(stage->'printed_terms') IS DISTINCT FROM 'string'
      OR coalesce(btrim(stage->>'label'),'')='' OR coalesce(btrim(stage->>'printed_terms'),'')=''
      OR coalesce(stage->>'basis','') NOT IN ('deposit','work_done','materials_supplied','unconfirmed')
      OR coalesce(stage#>>'{trigger,kind}','') NOT IN ('quote_accepted','install_scheduled','council_step_completed','stage_confirmed')
      OR stage#>>'{due_rule,kind}' IS DISTINCT FROM 'days_after_trigger'
      OR jsonb_typeof(stage#>'{due_rule,days}') IS DISTINCT FROM 'number'
      OR (stage#>>'{due_rule,days}')::numeric<0
      OR trunc((stage#>>'{due_rule,days}')::numeric)<>(stage#>>'{due_rule,days}')::numeric
      OR jsonb_typeof(stage->'payers') IS DISTINCT FROM 'array'
      OR jsonb_array_length(stage->'payers')=0 THEN
      RAISE EXCEPTION 'scope_payment_schedule_invalid' USING ERRCODE='23514';
    END IF;
    -- Validate the storage/date range for every stage before consuming any.
    PERFORM d.released_at+make_interval(days=>(stage#>>'{due_rule,days}')::int);
    IF ordinal=1 AND (stage->>'basis'<>'deposit' OR stage#>>'{trigger,kind}'<>'quote_accepted')
      OR ordinal>1 AND (stage->>'basis'='deposit' OR stage#>>'{trigger,kind}'='quote_accepted') THEN
      RAISE EXCEPTION 'scope_payment_first_stage_invalid' USING ERRCODE='23514';
    END IF;
    IF stage#>>'{trigger,kind}'='council_step_completed' AND (
      coalesce(stage#>>'{trigger,submission_id}','')='' OR coalesce(stage#>>'{trigger,step_id}','')=''
      OR coalesce(stage#>>'{trigger,step_name}','')='') THEN
      RAISE EXCEPTION 'scope_payment_council_identity_missing' USING ERRCODE='23514';
    END IF;
    ids:=array_append(ids,stage->>'id'); total:=total+amount; stage_total:=0; payer_ids:=ARRAY[]::text[];
    FOR payer IN SELECT value FROM jsonb_array_elements(stage->'payers') LOOP
      amount:=public.scope_draft_cents(payer->'amount_inc_gst');
      IF amount IS NULL OR payer->>'payer_id'=ANY(payer_ids) OR NOT EXISTS (
        SELECT 1 FROM public.scope_job_draft_invoices i WHERE i.job_id=p_job AND i.scope_revision_id=d.scope_revision_id
          AND i.payer_id=payer->>'payer_id') THEN
        RAISE EXCEPTION 'scope_payment_payer_invalid' USING ERRCODE='23514';
      END IF;
      payer_ids:=array_append(payer_ids,payer->>'payer_id'); stage_total:=stage_total+amount;
    END LOOP;
    IF stage_total<>public.scope_draft_cents(stage->'amount_inc_gst') THEN
      RAISE EXCEPTION 'scope_payment_stage_sum_mismatch' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF total<>(d.totals->>'inc_cents')::bigint THEN RAISE EXCEPTION 'scope_payment_total_mismatch' USING ERRCODE='23514'; END IF;
  FOR parent IN SELECT * FROM public.scope_job_draft_invoices WHERE job_id=p_job AND scope_revision_id=d.scope_revision_id LOOP
    SELECT sum(public.scope_draft_cents(p.value->'amount_inc_gst')) INTO payer_total
      FROM jsonb_array_elements(schedule->'stages') s CROSS JOIN LATERAL jsonb_array_elements(s.value->'payers') p
      WHERE p.value->>'payer_id'=parent.payer_id;
    IF payer_total IS DISTINCT FROM parent.inc_cents THEN RAISE EXCEPTION 'scope_payment_payer_sum_mismatch' USING ERRCODE='23514'; END IF;
  END LOOP;
  INSERT INTO public.scope_payment_plans(job_id,org_id,scope_revision_id,schedule) VALUES(p_job,d.org_id,d.scope_revision_id,schedule);
  RETURN schedule;
END $$;
REVOKE ALL ON FUNCTION public.scope_payment_plan(uuid) FROM PUBLIC, anon, authenticated, service_role;
