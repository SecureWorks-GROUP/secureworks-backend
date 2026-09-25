-- Quote v2 send (stage 3) contract. Every fixture write is rolled back.
BEGIN;

CREATE FUNCTION pg_temp.expect_refusal(p_sql text, p_code text, p_what text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  succeeded boolean := false;
BEGIN
  BEGIN
    EXECUTE p_sql;
    succeeded := true;
  EXCEPTION WHEN others THEN
    IF position(p_code IN SQLERRM) = 0 THEN
      RAISE EXCEPTION '% (expected %, got: %)', p_what, p_code, SQLERRM;
    END IF;
  END;
  IF succeeded THEN
    RAISE EXCEPTION '%', p_what;
  END IF;
END $$;

CREATE TEMP TABLE ids (k text PRIMARY KEY, v text NOT NULL);

-- ── Access ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quote_v2_send_previews', 'quote_v2_send_approvals',
    'quote_v2_sends', 'quote_v2_outbox', 'quote_v2_outbox_deliveries']
  LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION '% must have RLS', t;
    END IF;
    IF has_table_privilege('anon', 'public.' || t, 'SELECT')
       OR has_table_privilege('authenticated', 'public.' || t, 'SELECT')
       OR has_table_privilege('service_role', 'public.' || t, 'INSERT')
       OR has_table_privilege('service_role', 'public.' || t, 'UPDATE') THEN
      RAISE EXCEPTION '% must be private and written only through the send functions', t;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.quote_v2_build_draft(uuid, jsonb, jsonb, text, date)',
    'public.quote_v2_open_party_document(text)',
    'public.quote_v2_prepare_send(uuid, jsonb, text, integer)',
    'public.quote_v2_approve_send(uuid, text, text)',
    'public.quote_v2_execute_send(uuid, text, text, boolean)',
    'public.quote_v2_live_outbox_pending(uuid)',
    'public.quote_v2_claim_delivery(uuid)',
    'public.quote_v2_record_delivery(uuid, text, text, text)',
    'public.quote_v2_issue_approved_party_link(uuid, uuid, text, text)']
  LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION '% must be service role only', f;
    END IF;
  END LOOP;
END $$;

INSERT INTO public.jobs (id, org_id, status, type, job_number, site_suburb) VALUES
  ('00000000-0000-4000-8000-0000000000c3', '00000000-0000-0000-0000-000000000001', 'draft', 'fencing', 'SWF-TEST3', 'Gwelup');

-- ── Build in one transaction ────────────────────────────────────────────
DO $$
DECLARE
  job uuid := '00000000-0000-4000-8000-0000000000c3';
  stated jsonb := jsonb_build_object('basis', 'stated', 'kind', 'owner', 'stated_by', 'marnin',
    'stated_at', '2026-09-17T08:00:00+08');
  payload jsonb;
  b jsonb;
  n integer;
BEGIN
  payload := jsonb_build_object('family', 'fencing',
    'scope', jsonb_build_object('title', 'Boundary fence'),
    'parties', jsonb_build_array(
      jsonb_build_object('ref', 'c', 'role', 'client', 'display_name', 'Stephen', 'share_rule', 'equal', 'share_bp', 5000),
      jsonb_build_object('ref', 'n', 'role', 'neighbour', 'display_name', 'Fiona', 'share_rule', 'equal', 'share_bp', 5000)),
    'lines', jsonb_build_array(
      jsonb_build_object('line_key', 'fence', 'description', 'Colorbond fence', 'qty', 22, 'unit', 'lm',
        'sell', stated || '{"unit_sell_ex_gst": 125}'),
      jsonb_build_object('line_key', 'labour', 'description', 'Install', 'qty', 10, 'unit', 'hour',
        'cost', jsonb_build_object('source', 'stated', 'unit_cost_ex_gst', 50, 'stated_by', 'marnin', 'evidence', 'rate'),
        'sell', jsonb_build_object('basis', 'cost_markup', 'family', 'patio'))));

  -- A refused markup leaves nothing behind: build is one transaction.
  SELECT count(*) INTO n FROM public.quote_v2_revisions WHERE job_id = job;
  PERFORM pg_temp.expect_refusal(format(
    'SELECT public.quote_v2_build_draft(%L, %L::jsonb, %L::jsonb, %L, %L::date)', job, payload,
    '[{"line_key": "labour", "multiplier": 0.9}]', 'khairo', public.quote_v2_perth_today() + 30),
    'quote_markup_below_cost', 'a markup under 1.0 must refuse the whole build');
  IF (SELECT count(*) FROM public.quote_v2_revisions WHERE job_id = job) <> n THEN
    RAISE EXCEPTION 'a refused build must leave no draft';
  END IF;

  b := public.quote_v2_build_draft(job, payload,
    '[{"line_key": "labour", "multiplier": 1.2, "reason": "long dig"}]'::jsonb, 'khairo',
    public.quote_v2_perth_today() + 30);
  IF NOT (b->>'frozen')::boolean OR (b->'freeze'->>'job_total_inc_gst')::numeric <> 3685.00 THEN
    RAISE EXCEPTION 'build must freeze 22 x 125 + 10 x 50 x 1.2 = 3,350 ex, 3,685 inc, got %', b;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.quote_v2_lines
                 WHERE revision_id = (b->>'revision_id')::uuid AND line_key = 'labour'
                   AND markup_source = 'line_override' AND markup_set_by = 'khairo'
                   AND markup_multiplier = 1.2) THEN
    RAISE EXCEPTION 'the scoper''s markup must be recorded with who set it';
  END IF;
  INSERT INTO ids VALUES ('rev', b->>'revision_id');
  INSERT INTO ids SELECT 'p_' || rp.role, rp.party_id::text
    FROM public.quote_v2_revision_parties rp WHERE rp.revision_id = (b->>'revision_id')::uuid;
END $$;

-- ── The party document carries the issue day and never a cost ───────────
DO $$
DECLARE
  d jsonb := public.quote_v2_party_document((SELECT v FROM ids WHERE k = 'rev')::uuid,
    (SELECT v FROM ids WHERE k = 'p_client')::uuid);
BEGIN
  IF d->>'issued_on' IS NULL OR d ? 'expired' OR d ? 'accepted_at' THEN
    RAISE EXCEPTION 'the party document is the frozen view plus the issue day, got %', d;
  END IF;
  IF d::text ~ '(unit_cost|markup|price_source|cost_source|stated_by)' THEN
    RAISE EXCEPTION 'the party document must not carry cost or markup';
  END IF;
END $$;

-- ── Prepare: exact recipients, amounts and messages, hashed ─────────────
CREATE TEMP TABLE send_input AS SELECT jsonb_build_object(
  'adapter', 'capture',
  'link_base_url', 'https://example.test/functions/v1/quote-v2',
  'parties', jsonb_build_array(
    jsonb_build_object('party_id', (SELECT v FROM ids WHERE k = 'p_client'),
      'recipients', jsonb_build_array(
        jsonb_build_object('channel', 'email', 'to', 'stephen@example.test'),
        jsonb_build_object('channel', 'sms', 'to', '+61400000001')),
      'messages', jsonb_build_object(
        'email', jsonb_build_object('subject', 'Your quote', 'text', 'See {{quote_link}}', 'html', '<a href="{{quote_link}}">quote</a>'),
        'sms', jsonb_build_object('text', 'Quote: {{quote_link}}')),
      'documents', jsonb_build_object('html_sha256', repeat('a', 64), 'pdf_sha256', repeat('b', 64))),
    jsonb_build_object('party_id', (SELECT v FROM ids WHERE k = 'p_neighbour'),
      'recipients', jsonb_build_array(jsonb_build_object('channel', 'email', 'to', 'fiona@example.test')),
      'messages', jsonb_build_object(
        'email', jsonb_build_object('subject', 'Your quote', 'text', 'See {{quote_link}}', 'html', '<a href="{{quote_link}}">quote</a>')),
      'documents', jsonb_build_object('html_sha256', repeat('c', 64), 'pdf_sha256', repeat('d', 64))))) AS s;

DO $$
DECLARE
  rev uuid := (SELECT v FROM ids WHERE k = 'rev')::uuid;
  s jsonb := (SELECT s FROM send_input);
  p jsonb;
BEGIN
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_prepare_send(%L, %L::jsonb, %L)', rev,
    jsonb_set(s, '{parties}', jsonb_build_array(s->'parties'->0)), 'khairo'),
    'quote_send_recipient_missing', 'a party with a share and no recipient must refuse');
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_prepare_send(%L, %L::jsonb, %L)', rev,
    jsonb_set(s, '{parties,1,recipients,0,to}', '"not-an-email"'), 'khairo'),
    'quote_send_recipient_invalid', 'a malformed email must refuse');
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_prepare_send(%L, %L::jsonb, %L)', rev,
    jsonb_set(s, '{parties,0,recipients,1,to}', '"0400 000 001"'), 'khairo'),
    'quote_send_recipient_invalid', 'an SMS number must be +614 form');
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_prepare_send(%L, %L::jsonb, %L)', rev,
    jsonb_set(s, '{parties,0,messages,sms,text}', '"no link here"'), 'khairo'),
    'quote_send_message_invalid', 'a message without the party link must refuse');
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_prepare_send(%L, %L::jsonb, %L)', rev,
    jsonb_set(s, '{adapter}', '"smtp"'), 'khairo'),
    'quote_send_adapter_unknown', 'only capture or live');

  p := public.quote_v2_prepare_send(rev, s, 'khairo');
  IF p->>'preview_hash' <> encode(sha256(convert_to((p->'preview')::text, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'the preview hash must be the sha256 of the preview';
  END IF;
  IF (p->'preview'->'parties'->0->'share'->>'inc_gst')::numeric <> 1842.50
     OR (p->'preview'->'job_total'->>'inc_gst')::numeric <> 3685.00
     OR p->'preview'->>'delivery' NOT LIKE 'captured%' THEN
    RAISE EXCEPTION 'the preview must name the amounts from the frozen revision and the capture, got %', p;
  END IF;
  IF (p->'preview')::text ~ '\?t=[0-9a-f]{64}' THEN
    RAISE EXCEPTION 'a preview never holds a link token';
  END IF;
  INSERT INTO ids VALUES ('preview', p->>'preview_id'), ('hash', p->>'preview_hash');
END $$;

-- ── Stamp and send ──────────────────────────────────────────────────────
DO $$
DECLARE
  pid uuid := (SELECT v FROM ids WHERE k = 'preview')::uuid;
  h text := (SELECT v FROM ids WHERE k = 'hash');
  r jsonb;
  again jsonb;
  links integer;
  body text;
BEGIN
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_execute_send(%L, %L, %L)', pid, h, 'khairo'),
    'quote_send_not_approved', 'an unstamped preview must not send');
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_approve_send(%L, %L, %L)', pid, repeat('0', 64), 'marnin'),
    'quote_send_hash_mismatch', 'the stamp must echo the preview hash');
  PERFORM public.quote_v2_approve_send(pid, h, 'marnin@secureworkswa.com.au');
  IF NOT (public.quote_v2_approve_send(pid, h, 'marnin@secureworkswa.com.au')->>'already_approved')::boolean THEN
    RAISE EXCEPTION 'a second stamp is the same stamp';
  END IF;
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_execute_send(%L, %L, %L)', pid, repeat('0', 64), 'khairo'),
    'quote_send_hash_mismatch', 'the send must echo the preview hash');

  r := public.quote_v2_execute_send(pid, h, 'khairo');
  IF (r->>'replay')::boolean OR jsonb_array_length(r->'messages') <> 3
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(r->'messages') m WHERE m->>'delivery' <> 'captured') THEN
    RAISE EXCEPTION 'the send must capture one email and one SMS to Stephen and one email to Fiona, got %', r;
  END IF;
  SELECT body_text INTO body FROM public.quote_v2_outbox
  WHERE send_id = (r->>'send_id')::uuid AND channel = 'sms';
  IF body !~ '^Quote: https://example\.test/functions/v1/quote-v2\?t=[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'the link placeholder must become the party''s own link, got %', body;
  END IF;
  IF public.quote_v2_open_party_link(substring(body from '[0-9a-f]{64}$'))->'quote'->'party'->>'first_name' <> 'Stephen' THEN
    RAISE EXCEPTION 'the SMS to Stephen must open Stephen''s quote';
  END IF;
  SELECT count(*) INTO links FROM public.quote_v2_party_links;
  again := public.quote_v2_execute_send(pid, h, 'khairo');
  IF NOT (again->>'replay')::boolean OR again->>'send_id' <> r->>'send_id'
     OR (SELECT count(*) FROM public.quote_v2_party_links) <> links
     OR (SELECT count(*) FROM public.quote_v2_outbox WHERE send_id = (r->>'send_id')::uuid) <> 3 THEN
    RAISE EXCEPTION 'a retried send must return the same send and write nothing';
  END IF;

  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_record_delivery(%L, %L)',
    (again->'messages'->0->>'outbox_id'), 'delivered'),
    'quote_outbox_capture_never_delivers', 'a captured message is never delivered');
  PERFORM pg_temp.expect_refusal(
    'UPDATE public.quote_v2_outbox SET to_address = ''someone@else.test''',
    'price_book_append_only', 'the outbox is append-only');
  PERFORM pg_temp.expect_refusal('DELETE FROM public.quote_v2_sends',
    'price_book_append_only', 'a send is never deleted');
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_claim_delivery(%L)',
    (again->'messages'->0->>'outbox_id')),
    'quote_outbox_capture_never_delivers', 'a captured message is never claimed');

  -- A hand-issued link is only for a party the owner stamped a send to.
  IF public.quote_v2_issue_approved_party_link(
       (SELECT v FROM ids WHERE k = 'rev')::uuid, (SELECT v FROM ids WHERE k = 'p_neighbour')::uuid,
       h, 'marnin')->>'token' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'the owner may reissue a link to a party his stamp covers';
  END IF;
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_issue_approved_party_link(%L, %L, %L, %L)',
    (SELECT v FROM ids WHERE k = 'rev'), (SELECT v FROM ids WHERE k = 'p_client'), repeat('e', 64), 'marnin'),
    'quote_link_not_approved', 'a link needs a stamped preview');
END $$;

-- ── Live previews and quotes that change ────────────────────────────────
DO $$
DECLARE
  rev uuid := (SELECT v FROM ids WHERE k = 'rev')::uuid;
  s jsonb := (SELECT s FROM send_input);
  live jsonb;
  stale jsonb;
BEGIN
  live := public.quote_v2_prepare_send(rev, jsonb_set(s, '{adapter}', '"live"'), 'khairo');
  PERFORM public.quote_v2_approve_send((live->>'preview_id')::uuid, live->>'preview_hash', 'marnin');
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_execute_send(%L, %L, %L, false)',
    live->>'preview_id', live->>'preview_hash', 'khairo'),
    'quote_send_live_disabled', 'a live preview must not run where live delivery is off');
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_issue_approved_party_link(%L, %L, %L, %L)',
    rev, (SELECT v FROM ids WHERE k = 'p_client'),
    public.quote_v2_prepare_send(rev, s, 'khairo')->>'preview_hash', 'marnin'),
    'quote_link_not_approved', 'an unstamped preview covers no link');

  -- Live delivery: each message is claimed once before any provider call.
  DECLARE
    sent jsonb := public.quote_v2_execute_send((live->>'preview_id')::uuid, live->>'preview_hash', 'khairo', true);
    o1 uuid;
    o2 uuid;
  BEGIN
    IF (SELECT count(*) FROM public.quote_v2_live_outbox_pending((sent->>'send_id')::uuid)) <> 3 THEN
      RAISE EXCEPTION 'every live message starts unclaimed';
    END IF;
    o1 := (sent->'messages'->0->>'outbox_id')::uuid;
    o2 := (sent->'messages'->1->>'outbox_id')::uuid;
    IF NOT public.quote_v2_claim_delivery(o1) OR public.quote_v2_claim_delivery(o1) THEN
      RAISE EXCEPTION 'a message is claimed by exactly one caller';
    END IF;
    IF (SELECT count(*) FROM public.quote_v2_live_outbox_pending((sent->>'send_id')::uuid)) <> 2 THEN
      RAISE EXCEPTION 'a claimed message is never offered again';
    END IF;
    IF public.quote_v2_send_result((sent->>'send_id')::uuid)->'messages'->0->>'delivery' <> 'unknown' THEN
      RAISE EXCEPTION 'a claim that never settled reads as unknown';
    END IF;
    PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_record_delivery(%L, %L)', o2, 'delivered'),
      'quote_outbox_delivery_unclaimed', 'an outcome needs its claim');
    PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_record_delivery(%L, %L)', o1, 'claimed'),
      'quote_outbox_outcome_unknown', 'a claim is not an outcome');
    PERFORM public.quote_v2_record_delivery(o1, 'unknown', NULL, 'SMS provider 503');
    PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_record_delivery(%L, %L)', o1, 'delivered'),
      'quote_outbox_delivery_settled', 'an outcome is recorded once');
    IF public.quote_v2_send_result((sent->>'send_id')::uuid)->'messages'->0->>'delivery' <> 'unknown'
       OR public.quote_v2_claim_delivery(o1) THEN
      RAISE EXCEPTION 'an unknown outcome is never retried';
    END IF;
  END;

  stale := public.quote_v2_prepare_send(rev, s, 'khairo');
  PERFORM public.quote_v2_approve_send((stale->>'preview_id')::uuid, stale->>'preview_hash', 'marnin');
  -- A new revision replaces the one the owner stamped.
  PERFORM public.quote_v2_build_draft('00000000-0000-4000-8000-0000000000c3',
    jsonb_build_object('family', 'fencing', 'scope', '{}'::jsonb,
      'parties', jsonb_build_array(jsonb_build_object('ref', 'c', 'party_id', (SELECT v FROM ids WHERE k = 'p_client'),
        'share_rule', 'sole', 'share_bp', 10000)),
      'lines', jsonb_build_array(jsonb_build_object('line_key', 'fence', 'description', 'Fence', 'qty', 1, 'unit', 'lm',
        'sell', jsonb_build_object('basis', 'stated', 'kind', 'owner', 'unit_sell_ex_gst', 100,
          'stated_by', 'marnin', 'stated_at', '2026-09-17T08:00:00+08')))),
    '[]'::jsonb, 'khairo', public.quote_v2_perth_today() + 30);
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_execute_send(%L, %L, %L)',
    stale->>'preview_id', stale->>'preview_hash', 'khairo'),
    'quote_send_revision_changed', 'a stamp on a replaced quote must not send');
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_prepare_send(%L, %L::jsonb, %L)', rev, s, 'khairo'),
    'quote_revision_not_current', 'a replaced revision cannot be prepared');
END $$;

ROLLBACK;
