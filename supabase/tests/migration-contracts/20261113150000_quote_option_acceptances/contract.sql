-- Contract for 20261113150000_quote_option_acceptances.sql. Every fixture write is
-- inside a transaction that rolls back.

-- 1. Row-level security, exactly one service-role policy, no browser role can read or
-- write the record.
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.quote_option_acceptances'::regclass) THEN
    RAISE EXCEPTION 'quote options contract: row-level security is off';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'quote_option_acceptances') <> 1
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'quote_option_acceptances'
                 AND NOT (roles = ARRAY['service_role']::name[])) THEN
    RAISE EXCEPTION 'quote options contract: the record must carry exactly one service-role policy';
  END IF;
  IF has_table_privilege('anon', 'public.quote_option_acceptances', 'SELECT')
     OR has_table_privilege('authenticated', 'public.quote_option_acceptances', 'SELECT')
     OR has_table_privilege('anon', 'public.quote_option_acceptances', 'INSERT')
     OR has_table_privilege('authenticated', 'public.quote_option_acceptances', 'INSERT') THEN
    RAISE EXCEPTION 'quote options contract: a browser role can read or write the record';
  END IF;
END $$;

-- 2. One record per document, written once, money that adds up.
BEGIN;
INSERT INTO public.jobs (id, org_id, status, type, job_number)
VALUES ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-000000000001', 'accepted', 'patio', 'ZZTEST-F001');
INSERT INTO public.job_documents (id, job_id, type)
VALUES ('00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-00000000f001', 'quote'),
       ('00000000-0000-0000-0000-00000000f102', '00000000-0000-0000-0000-00000000f001', 'quote');
INSERT INTO public.quote_revisions (id, job_id, job_document_id, version, totals_snapshot_json, released_via, sent_at)
VALUES ('00000000-0000-0000-0000-00000000f201', '00000000-0000-0000-0000-00000000f001',
        '00000000-0000-0000-0000-00000000f101', 1, '{}'::jsonb, 'contract', now());
INSERT INTO public.quote_option_acceptances (
  job_id, job_document_id, quote_revision_id, accepted_via, offered, taken_option_ids,
  base_total_inc_gst, accepted_total_ex_gst, accepted_gst, accepted_total_inc_gst, accepted_deposit_inc_gst,
  taken_options, accepted_combination)
VALUES ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f101',
        '00000000-0000-0000-0000-00000000f201', 'public_link',
        '[{"id":"a","name":"Lights","sell_ex_gst":400,"gst":40,"sell_inc_gst":440,"goes":"supplier"}]'::jsonb,
        ARRAY['a'], 1100, 1400, 140, 1540, 770,
        '[{"id":"a","goes":"supplier"}]'::jsonb, '{"option_ids":["a"]}'::jsonb);
DO $$
DECLARE
  bad record;
BEGIN
  -- A second record for the same document is refused.
  BEGIN
    INSERT INTO public.quote_option_acceptances (
      job_id, job_document_id, quote_revision_id, accepted_via, offered,
      base_total_inc_gst, accepted_total_ex_gst, accepted_gst, accepted_total_inc_gst, accepted_deposit_inc_gst,
      accepted_combination)
    VALUES ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f101',
            '00000000-0000-0000-0000-00000000f201', 'public_link', '[{"id":"a"}]'::jsonb, 1100, 1000, 100, 1100, 550,
            '{"option_ids":[]}'::jsonb);
    RAISE EXCEPTION 'quote options contract: a second record for one document was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- Written once: an update is refused.
  BEGIN
    UPDATE public.quote_option_acceptances SET taken_option_ids = '{}'::text[]
     WHERE job_document_id = '00000000-0000-0000-0000-00000000f101';
    RAISE EXCEPTION 'quote options contract: the record was changed';
  EXCEPTION WHEN restrict_violation THEN NULL;
  END;
  -- Money and shape checks, each refused.
  FOR bad IN
    SELECT * FROM (VALUES
      ('public_link', '[{"id":"a"}]', 1100::numeric, 1000::numeric, 100::numeric, 1200::numeric, 550::numeric, '{}', '[]', '{"option_ids":[]}', 'ex plus GST is not inc'),
      ('public_link', '[{"id":"a"}]', 1100, 900, 90, 990, 495, '{}', '[]', '{"option_ids":[]}', 'accepted below base'),
      ('public_link', '[{"id":"a"}]', 1100, 1000, 100, 1100, 1200, '{}', '[]', '{"option_ids":[]}', 'deposit above total'),
      ('public_link', '[{"id":"a"}]', 1100, 1000, 100, 1100, -1, '{}', '[]', '{"option_ids":[]}', 'negative deposit'),
      ('public_link', '[]', 1100, 1000, 100, 1100, 550, '{}', '[]', '{"option_ids":[]}', 'no option offered'),
      ('public_link', '{"id":"a"}', 1100, 1000, 100, 1100, 550, '{}', '[]', '{"option_ids":[]}', 'offered not a list'),
      ('public_link', '[1,2,3,4,5,6,7]', 1100, 1000, 100, 1100, 550, '{}', '[]', '{"option_ids":[]}', 'more than six offered'),
      ('staff_phone', '[{"id":"a"}]', 1100, 1000, 100, 1100, 550, '{}', '[]', '{"option_ids":[]}', 'staff not named'),
      ('by_email', '[{"id":"a"}]', 1100, 1000, 100, 1100, 550, '{}', '[]', '{"option_ids":[]}', 'unknown way in'),
      ('public_link', '[{"id":"a"}]', 1100, 1000, 100, 1100, 550, '{a}', '[]', '{"option_ids":["a"]}', 'a taken id with no sealed option'),
      ('public_link', '[{"id":"a"}]', 1100, 1000, 100, 1100, 550, '{a}', '[{"id":"a"}]', '{"option_ids":[]}', 'a combination that is not the ticked set'),
      ('public_link', '[{"id":"a"}]', 1100, 1000, 100, 1100, 550, '{}', '[]', '{}', 'a combination with no option ids')
    ) AS v(via, offered, base, ex, gst, inc, dep, taken, taken_options, combo, what)
  LOOP
    BEGIN
      INSERT INTO public.quote_option_acceptances (
        job_id, job_document_id, quote_revision_id, accepted_via, offered,
        base_total_inc_gst, accepted_total_ex_gst, accepted_gst, accepted_total_inc_gst, accepted_deposit_inc_gst,
        taken_option_ids, taken_options, accepted_combination)
      VALUES ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f102',
              '00000000-0000-0000-0000-00000000f201', bad.via, bad.offered::jsonb,
              bad.base, bad.ex, bad.gst, bad.inc, bad.dep,
              bad.taken::text[], bad.taken_options::jsonb, bad.combo::jsonb);
      RAISE EXCEPTION 'quote options contract: accepted a record with %', bad.what;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  -- Staff on the phone, named, nothing ticked: accepted (offered, not taken).
  INSERT INTO public.quote_option_acceptances (
    job_id, job_document_id, quote_revision_id, accepted_via, accepted_by, offered,
    base_total_inc_gst, accepted_total_ex_gst, accepted_gst, accepted_total_inc_gst, accepted_deposit_inc_gst,
    accepted_combination)
  VALUES ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f102',
          '00000000-0000-0000-0000-00000000f201', 'staff_phone', '00000000-0000-0000-0000-00000000f301',
          '[{"id":"a"}]'::jsonb, 1100, 1000, 100, 1100, 550, '{"option_ids":[]}'::jsonb);
  IF (SELECT taken_option_ids FROM public.quote_option_acceptances
       WHERE job_document_id = '00000000-0000-0000-0000-00000000f102') <> '{}'::text[] THEN
    RAISE EXCEPTION 'quote options contract: nothing ticked must record no taken ids';
  END IF;
END $$;
ROLLBACK;

-- 3. The acceptance and its record are one write: a refused record leaves the
-- document unaccepted, a second accept claims nothing, browsers cannot call it.
BEGIN;
CREATE FUNCTION pg_temp.qo_refused(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END $$;
INSERT INTO public.jobs (id, org_id, status, type, job_number)
VALUES ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-000000000001', 'quoted', 'patio', 'ZZTEST-F002');
INSERT INTO public.job_documents (id, job_id, type)
VALUES ('00000000-0000-0000-0000-00000000f111', '00000000-0000-0000-0000-00000000f002', 'quote'),
       ('00000000-0000-0000-0000-00000000f112', '00000000-0000-0000-0000-00000000f002', 'quote');
INSERT INTO public.quote_revisions (id, job_id, job_document_id, version, totals_snapshot_json, released_via, sent_at)
VALUES ('00000000-0000-0000-0000-00000000f211', '00000000-0000-0000-0000-00000000f002',
        '00000000-0000-0000-0000-00000000f111', 1, '{}'::jsonb, 'contract', now()),
       ('00000000-0000-0000-0000-00000000f212', '00000000-0000-0000-0000-00000000f002',
        '00000000-0000-0000-0000-00000000f112', 1, '{}'::jsonb, 'contract', now());
DO $$
DECLARE
  rec jsonb := jsonb_build_object(
    'job_id', '00000000-0000-0000-0000-00000000f002', 'job_document_id', '00000000-0000-0000-0000-00000000f111',
    'quote_revision_id', '00000000-0000-0000-0000-00000000f211', 'accepted_via', 'public_link',
    'offered', '[{"id":"a","goes":"crew"}]'::jsonb, 'taken_option_ids', '["a"]'::jsonb,
    'base_total_inc_gst', 1100, 'accepted_total_ex_gst', 1200, 'accepted_gst', 120,
    'accepted_total_inc_gst', 1320, 'accepted_deposit_inc_gst', 660,
    'taken_options', '[{"id":"a","goes":"crew"}]'::jsonb, 'accepted_combination', '{"option_ids":["a"]}'::jsonb);
  r jsonb; err text;
BEGIN
  -- A record for another document: refused, nothing written.
  err := pg_temp.qo_refused(format('SELECT public.accept_quote_document_with_options(%L, now(), %L)',
    '00000000-0000-0000-0000-00000000f112', rec));
  ASSERT err = 'quote_options_record_not_this_document', 'a record for another document is refused: ' || coalesce(err, 'it went through');
  -- A record whose taken options do not match its ids: refused by the table, and
  -- the document is NOT left accepted.
  err := pg_temp.qo_refused(format('SELECT public.accept_quote_document_with_options(%L, now(), %L)',
    '00000000-0000-0000-0000-00000000f111', rec || '{"taken_options":[]}'::jsonb));
  ASSERT err IS NOT NULL, 'a record with a missing taken option is refused';
  ASSERT (SELECT accepted_at IS NULL FROM public.job_documents WHERE id = '00000000-0000-0000-0000-00000000f111'),
    'a refused record leaves the document unaccepted';
  ASSERT NOT EXISTS (SELECT 1 FROM public.quote_option_acceptances WHERE job_id = '00000000-0000-0000-0000-00000000f002'),
    'a refused record writes nothing';
  -- The right record: accepted and recorded together.
  r := public.accept_quote_document_with_options('00000000-0000-0000-0000-00000000f111', now(), rec);
  ASSERT r = '{"claimed": true}'::jsonb, 'the first accept claims the document';
  ASSERT (SELECT accepted_at IS NOT NULL FROM public.job_documents WHERE id = '00000000-0000-0000-0000-00000000f111'),
    'the document is accepted';
  ASSERT (SELECT taken_options = '[{"id":"a","goes":"crew"}]'::jsonb AND accepted_combination = '{"option_ids":["a"]}'::jsonb
    FROM public.quote_option_acceptances WHERE job_document_id = '00000000-0000-0000-0000-00000000f111'),
    'the record keeps the sealed taken options and combination';
  -- A second accept (a double tap) claims nothing and writes nothing.
  r := public.accept_quote_document_with_options('00000000-0000-0000-0000-00000000f111', now(), rec);
  ASSERT r = '{"claimed": false}'::jsonb, 'a second accept claims nothing';
  ASSERT (SELECT count(*) FROM public.quote_option_acceptances WHERE job_id = '00000000-0000-0000-0000-00000000f002') = 1,
    'one record';
  ASSERT NOT has_function_privilege('anon', 'public.accept_quote_document_with_options(uuid, timestamptz, jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.accept_quote_document_with_options(uuid, timestamptz, jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.apply_quote_options_to_scope_drafts(uuid, uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.apply_quote_options_to_scope_drafts(uuid, uuid)', 'EXECUTE'),
    'browser roles cannot call the option functions';
END $$;
ROLLBACK;

-- 4. A taken crew option joins the job work order and the agreed labour; the
-- payer amounts become the ticked combination's; an untaken option is nowhere;
-- a record that is not what the revision sealed changes nothing.
BEGIN;
CREATE FUNCTION pg_temp.qo_refused(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END $$;
UPDATE public.feature_flags SET enabled = false
  WHERE flag_name IN ('owner_approval_saved_revision_required_v1', 'job_work_order_auto_issue_v1');

CREATE TEMP TABLE qo_fx (k text PRIMARY KEY, v jsonb NOT NULL);
INSERT INTO qo_fx VALUES
  ('gate', '{"id":"gate","name":"Synthetic gate","goes":"crew","labour_line":{"line_key":"opt-gate","description":"Synthetic gate labour","total":200}}'),
  ('lights', '{"id":"lights","name":"Synthetic lights","goes":"supplier","order_line":{"name":"Synthetic light","qty":2}}'),
  ('base', '{"option_ids":[],"totalExGST":3000,"gst":300,"totalIncGST":3300,"parties":[{"id":"__client__","ex_gst":3000,"gst":300,"inc_gst":3300}]}'),
  ('combo_gate', '{"option_ids":["gate"],"totalExGST":3400,"gst":340,"totalIncGST":3740,"parties":[{"id":"__client__","ex_gst":3400,"gst":340,"inc_gst":3740}]}'),
  ('combo_lights', '{"option_ids":["lights"],"totalExGST":3200,"gst":320,"totalIncGST":3520,"parties":[{"id":"__client__","ex_gst":3200,"gst":320,"inc_gst":3520}]}');

-- One job: drafts prepared from a frozen revision offering both options, the
-- document accepted with the given taken set. Returns job, revision, work order.
CREATE FUNCTION pg_temp.qo_job(p_taken text[], OUT job uuid, OUT rev uuid, OUT wo uuid)
LANGUAGE plpgsql AS $$
DECLARE
  org uuid := '0a0a0a0a-0000-4000-8000-0000000014aa';
  doc uuid := gen_random_uuid(); qrev uuid := gen_random_uuid();
  combos jsonb := jsonb_build_array((SELECT v FROM qo_fx WHERE k = 'base'),
    (SELECT v FROM qo_fx WHERE k = 'combo_gate'), (SELECT v FROM qo_fx WHERE k = 'combo_lights'));
  pricing jsonb; combo jsonb;
BEGIN
  job := gen_random_uuid(); rev := gen_random_uuid();
  pricing := jsonb_build_object('totalExGST', 3000, 'gst', 300, 'totalIncGST', 3300,
    'labourCostEstimate', 800,
    'internal', jsonb_build_object('labour_lines', '[{"line_key":"crew","description":"Synthetic crew","total":800}]'::jsonb),
    'parties', '[{"id":"__client__","ex_gst":3000,"gst":300,"inc_gst":3300}]'::jsonb,
    'optional_extras', jsonb_build_object('options', jsonb_build_array(
      (SELECT v FROM qo_fx WHERE k = 'gate'), (SELECT v FROM qo_fx WHERE k = 'lights')), 'combinations', combos));
  INSERT INTO public.jobs(id, org_id, type, status, job_number)
    VALUES (job, org, 'fencing', 'draft', 'ZZTEST-SE-R14-' || left(job::text, 8));
  INSERT INTO public.scope_revisions(id, job_id, revision_number, status, scope_canonical_text,
      pricing_canonical_text, scope_hash, pricing_hash)
    VALUES (rev, job, 1, 'frozen', '{}', pricing::text,
      encode(sha256(convert_to('{}', 'UTF8')), 'hex'), encode(sha256(convert_to(pricing::text, 'UTF8')), 'hex'));
  PERFORM public.prepare_scope_job_drafts(job, rev, org);
  SELECT w.id INTO wo FROM public.work_orders w WHERE w.job_id = job AND w.kind = 'job';
  INSERT INTO public.job_documents (id, job_id, type) VALUES (doc, job, 'quote');
  INSERT INTO public.quote_revisions (id, job_id, job_document_id, version, totals_snapshot_json, released_via, sent_at)
    VALUES (qrev, job, doc, 1, '{}'::jsonb, 'contract', now());
  SELECT c INTO combo FROM jsonb_array_elements(combos) c
    WHERE (SELECT coalesce(array_agg(x ORDER BY x), '{}') FROM jsonb_array_elements_text(c->'option_ids') x) = p_taken;
  PERFORM public.accept_quote_document_with_options(doc, now(), jsonb_build_object(
    'job_id', job, 'job_document_id', doc, 'quote_revision_id', qrev, 'accepted_via', 'public_link',
    'offered', '[{"id":"gate"},{"id":"lights"}]'::jsonb, 'taken_option_ids', to_jsonb(p_taken),
    'base_total_inc_gst', 3300, 'accepted_total_ex_gst', combo->'totalExGST', 'accepted_gst', combo->'gst',
    'accepted_total_inc_gst', combo->'totalIncGST', 'accepted_deposit_inc_gst', 0,
    'taken_options', (SELECT coalesce(jsonb_agg(v ORDER BY k), '[]'::jsonb) FROM qo_fx WHERE k = ANY(p_taken)),
    'accepted_combination', combo));
  UPDATE public.jobs SET status = 'accepted' WHERE id = job;
END $$;

DO $$
DECLARE f record; g record; h record; r jsonb; err text;
BEGIN
  -- The gate (crew) taken: its labour line joins the work order and its total the
  -- agreed labour; the client's draft invoice and totals are the combination's.
  f := pg_temp.qo_job(ARRAY['gate']);
  r := public.apply_quote_options_to_scope_drafts(f.job, f.rev);
  ASSERT r = '{"applied": true, "taken": 1}'::jsonb, 'the taken option is applied: ' || r::text;
  ASSERT (SELECT agreed_labour_ex = 1000 AND jsonb_array_length(scope_items) = 2
      AND scope_items->1 = (SELECT v->'labour_line' FROM qo_fx WHERE k = 'gate')
    FROM public.work_orders WHERE id = f.wo), 'the work order carries the option labour line and total';
  ASSERT (SELECT labour_total_cents = 100000 AND (totals->>'inc_cents')::bigint = 374000
      AND quote_option_ids = ARRAY['gate'] FROM public.scope_job_draft_sets WHERE job_id = f.job),
    'the drafts carry the accepted labour and total';
  ASSERT (SELECT inc_cents = 374000 FROM public.scope_job_draft_invoices WHERE job_id = f.job AND payer_id = '__client__'),
    'the client draft invoice is the accepted total';
  ASSERT (SELECT count(*) FROM public.job_events WHERE job_id = f.job
    AND event_type = 'scope_job_drafts_quote_options_applied') = 1, 'one audit, ids only';
  -- A repeat replays, and the release still matches the drafts.
  r := public.apply_quote_options_to_scope_drafts(f.job, f.rev);
  ASSERT r = '{"applied": true, "replayed": true}'::jsonb, 'a repeat replays';
  err := pg_temp.qo_refused(format('SELECT public.release_scope_job_drafts(%L, %L)', f.job, f.rev));
  ASSERT err IS NULL, 'the release accepts the overlaid drafts: ' || coalesce(err, '');

  -- A supplier option taken: nothing on the work order changes, the money does.
  g := pg_temp.qo_job(ARRAY['lights']);
  PERFORM public.apply_quote_options_to_scope_drafts(g.job, g.rev);
  ASSERT (SELECT agreed_labour_ex = 800 AND jsonb_array_length(scope_items) = 1 FROM public.work_orders WHERE id = g.wo),
    'an untaken crew option is not on the work order';
  ASSERT (SELECT inc_cents = 352000 FROM public.scope_job_draft_invoices WHERE job_id = g.job), 'the supplier option is billed';

  -- Nothing taken: the drafts stay the base.
  h := pg_temp.qo_job(ARRAY[]::text[]);
  r := public.apply_quote_options_to_scope_drafts(h.job, h.rev);
  ASSERT r = '{"applied": true, "taken": 0}'::jsonb, 'nothing taken applies nothing';
  ASSERT (SELECT agreed_labour_ex = 800 FROM public.work_orders WHERE id = h.wo)
    AND (SELECT inc_cents = 330000 FROM public.scope_job_draft_invoices WHERE job_id = h.job), 'the base stays';

  -- A record that is not what the revision sealed changes nothing.
  f := pg_temp.qo_job(ARRAY['gate']);
  ALTER TABLE public.quote_option_acceptances DISABLE TRIGGER quote_option_acceptances_write_once;
  UPDATE public.quote_option_acceptances
     SET taken_options = jsonb_set(taken_options, '{0,labour_line,total}', '5000')
   WHERE job_id = f.job;
  ALTER TABLE public.quote_option_acceptances ENABLE TRIGGER quote_option_acceptances_write_once;
  err := pg_temp.qo_refused(format('SELECT public.apply_quote_options_to_scope_drafts(%L, %L)', f.job, f.rev));
  ASSERT err = 'scope_options_not_sealed', 'an unsealed option is refused: ' || coalesce(err, 'it went through');
  ASSERT (SELECT agreed_labour_ex = 800 FROM public.work_orders WHERE id = f.wo), 'a refused overlay changes nothing';

  -- Released before the options were applied: refused, never a late change.
  g := pg_temp.qo_job(ARRAY['gate']);
  PERFORM public.release_scope_job_drafts(g.job, g.rev);
  err := pg_temp.qo_refused(format('SELECT public.apply_quote_options_to_scope_drafts(%L, %L)', g.job, g.rev));
  ASSERT err = 'scope_options_after_release', 'options after release are refused: ' || coalesce(err, 'it went through');
END $$;
ROLLBACK;
