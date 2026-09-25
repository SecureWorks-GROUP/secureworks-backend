-- Quote v2 records contract. Every fixture write is rolled back.
BEGIN;

-- expect_refusal(sql, code, what): the statement must fail with an error
-- naming `code`; if it succeeds, fail with `what`.
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

-- ── Access: private, written only through the functions ─────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'quote_v2_parties', 'quote_v2_revisions', 'quote_v2_revision_parties', 'quote_v2_lines',
    'quote_v2_line_splits', 'quote_v2_line_allocations', 'quote_v2_party_totals',
    'quote_v2_party_links', 'quote_v2_link_revocations', 'quote_v2_acceptances']
  LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION '% must have RLS', t;
    END IF;
    IF has_table_privilege('anon', 'public.' || t, 'SELECT')
       OR has_table_privilege('authenticated', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION '% must not be readable by browser roles', t;
    END IF;
    IF has_table_privilege('service_role', 'public.' || t, 'INSERT')
       OR has_table_privilege('service_role', 'public.' || t, 'UPDATE')
       OR has_table_privilege('service_role', 'public.' || t, 'DELETE') THEN
      RAISE EXCEPTION '% must be written only through the quote functions', t;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.quote_v2_accept(text, uuid, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.quote_v2_open_party_link(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.quote_v2_freeze_revision(uuid, text, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'quote functions must not be callable by browser roles';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.quote_v2_open_party_link(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the party page runs through the service role';
  END IF;
  -- PB-10: approval locks the subject, not the proposal.
  IF position('price_book_subject_lock_key' IN pg_get_functiondef(
       'public.price_book_decide_proposal(uuid, text, text, text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'price_book_decide_proposal must lock per subject';
  END IF;
  IF public.price_book_subject_lock_key('cost', '{"item_key":"a","supplier":"S"}')
     <> public.price_book_subject_lock_key('cost', '{"supplier":"S","item_key":"a","extra":1}') THEN
    RAISE EXCEPTION 'two proposals for one item and supplier must share one lock';
  END IF;
END $$;

-- ── Split helper: parts always sum to the total, ties go to the first ────
DO $$
DECLARE
  a bigint[];
BEGIN
  a := public.quote_v2_split_cents(10001, ARRAY[3334, 3333, 3333]::bigint[]);
  IF a <> ARRAY[3335, 3333, 3333]::bigint[] THEN
    RAISE EXCEPTION 'odd cents across three: %', a;
  END IF;
  a := public.quote_v2_split_cents(-235, ARRAY[5000, 5000]::bigint[]);
  IF a <> ARRAY[-118, -117]::bigint[] THEN
    RAISE EXCEPTION 'negative split: %', a;
  END IF;
  a := public.quote_v2_split_cents(1, ARRAY[0, 5000, 5000]::bigint[]);
  IF a <> ARRAY[0, 1, 0]::bigint[] THEN
    RAISE EXCEPTION 'a zero weight never takes a remainder cent: %', a;
  END IF;
END $$;

-- ── Fixture jobs ────────────────────────────────────────────────────────
INSERT INTO public.jobs (id, org_id, status, type, job_number, site_suburb) VALUES
  ('00000000-0000-4000-8000-000000261423', '00000000-0000-0000-0000-000000000001', 'draft', 'fencing', 'SWF-261423', 'Gwelup'),
  ('00000000-0000-4000-8000-000000026051', '00000000-0000-0000-0000-000000000001', 'draft', 'patio', 'SWP-26051', 'Canning Vale'),
  ('00000000-0000-4000-8000-00000000c1c0', '00000000-0000-0000-0000-000000000001', 'draft', 'miscellaneous', 'KIKO-DRAFT', 'Balcatta'),
  ('00000000-0000-4000-8000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'draft', 'patio', 'SWP-TEST-1', 'Testville');

-- ── Gwelup SWF-261423: two parties, 50/50, sums to $4,763.00 ────────────
DO $$
DECLARE
  job uuid := '00000000-0000-4000-8000-000000261423';
  rev uuid;
  res jsonb;
  pid_c uuid;
  pid_n uuid;
  t record;
BEGIN
  rev := public.quote_v2_create_draft(job, jsonb_build_object(
    'family', 'fencing',
    'scope', jsonb_build_object('title', 'Colorbond fence, Woodland Grey 1800 Sameside',
      'inclusions', jsonb_build_array('22 m fence', '9 retaining plinths', 'Remove Hardie fence', 'Delivery'),
      'exclusions', jsonb_build_array('Root removal: neighbour only, priced separately')),
    'parties', jsonb_build_array(
      jsonb_build_object('ref', 'client', 'role', 'client', 'display_name', 'Stephen Client',
        'ghl_contact_id', 'ghl-stephen', 'share_rule', 'equal', 'share_bp', 5000),
      jsonb_build_object('ref', 'nb', 'role', 'neighbour', 'display_name', 'Fiona Neighbour',
        'share_rule', 'equal', 'share_bp', 5000)),
    'lines', jsonb_build_array(
      jsonb_build_object('line_key', 'fence', 'description', 'Colorbond fence 1800 Woodland Grey', 'qty', 22, 'unit', 'lm',
        'cost', jsonb_build_object('source', 'none'),
        'sell', jsonb_build_object('basis', 'stated', 'kind', 'owner', 'unit_sell_ex_gst', 125, 'stated_by', 'marnin', 'stated_at', '2026-09-17T08:00:00+08')),
      jsonb_build_object('line_key', 'plinths', 'description', 'Retaining plinths', 'qty', 9, 'unit', 'each',
        'cost', jsonb_build_object('source', 'none'),
        'sell', jsonb_build_object('basis', 'stated', 'kind', 'owner', 'unit_sell_ex_gst', 80, 'stated_by', 'marnin', 'stated_at', '2026-09-17T08:00:00+08')),
      jsonb_build_object('line_key', 'removal', 'description', 'Remove Hardie fence', 'qty', 22, 'unit', 'lm',
        'cost', jsonb_build_object('source', 'none'),
        'sell', jsonb_build_object('basis', 'stated', 'kind', 'owner', 'unit_sell_ex_gst', 30, 'stated_by', 'marnin', 'stated_at', '2026-09-17T08:00:00+08')),
      jsonb_build_object('line_key', 'delivery', 'description', 'Delivery', 'qty', 1, 'unit', 'delivery',
        'cost', jsonb_build_object('source', 'none'),
        'sell', jsonb_build_object('basis', 'stated', 'kind', 'owner', 'unit_sell_ex_gst', 200, 'stated_by', 'marnin', 'stated_at', '2026-09-17T08:00:00+08')))),
    'contract');
  res := public.quote_v2_freeze_revision(rev, 'contract', public.quote_v2_perth_today() + 30);
  IF (res->>'job_total_ex_gst')::numeric <> 4330.00 OR (res->>'job_gst')::numeric <> 433.00
     OR (res->>'job_total_inc_gst')::numeric <> 4763.00 THEN
    RAISE EXCEPTION 'Gwelup job total must be 4330.00 + 433.00 = 4763.00, got %', res;
  END IF;
  FOR t IN SELECT * FROM public.quote_v2_party_totals WHERE revision_id = rev LOOP
    IF t.share_ex_gst <> 2165.00 OR t.share_gst <> 216.50 OR t.share_inc_gst <> 2381.50 THEN
      RAISE EXCEPTION 'Gwelup: each party pays 2381.50 inc, got % % %', t.share_ex_gst, t.share_gst, t.share_inc_gst;
    END IF;
  END LOOP;
  IF (SELECT sum(share_inc_gst) FROM public.quote_v2_party_totals WHERE revision_id = rev) <> 4763.00 THEN
    RAISE EXCEPTION 'Gwelup: party shares must sum to the job';
  END IF;
  SELECT party_id INTO pid_c FROM public.quote_v2_revision_parties WHERE revision_id = rev AND role = 'client';
  SELECT party_id INTO pid_n FROM public.quote_v2_revision_parties WHERE revision_id = rev AND role = 'neighbour';
  IF (SELECT ghl_contact_id FROM public.quote_v2_revision_parties WHERE revision_id = rev AND party_id = pid_c) <> 'ghl-stephen' THEN
    RAISE EXCEPTION 'the GHL contact at prepare time is kept on the revision party';
  END IF;
  -- An owner-stated sell with no cost says so on the owner's preview, never
  -- on the party's copy.
  IF (SELECT public.quote_v2_line_price_source(x) FROM public.quote_v2_lines x WHERE revision_id = rev AND line_key = 'fence')
     NOT LIKE 'sell stated by marnin at %, no cost recorded'
     OR position('no cost' IN public.quote_v2_staff_revision(rev)::text) = 0 THEN
    RAISE EXCEPTION 'a stated sell with no cost must read "no cost recorded" to staff, got %',
      (SELECT public.quote_v2_line_price_source(x) FROM public.quote_v2_lines x WHERE revision_id = rev AND line_key = 'fence');
  END IF;
  IF position('no cost' IN public.quote_v2_party_view(rev, pid_c)::text) > 0 THEN
    RAISE EXCEPTION 'the party copy must not carry the owner''s cost note';
  END IF;
  INSERT INTO ids VALUES ('gw_rev1', rev::text), ('gw_client', pid_c::text), ('gw_nb', pid_n::text);
END $$;

-- ── A tool supplies cost and quantity, never a sell ─────────────────────
DO $$
DECLARE
  job uuid := '00000000-0000-4000-8000-000000261423';
  party jsonb := jsonb_build_array(jsonb_build_object('ref', 'c', 'role', 'client', 'display_name', 'Tess Tool',
    'share_rule', 'sole', 'share_bp', 10000));
BEGIN
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_create_draft(%L, %L, %L)', job, jsonb_build_object(
      'family', 'patio', 'parties', party,
      'lines', jsonb_build_array(jsonb_build_object('line_key', 'posts', 'description', 'Posts', 'qty', 5, 'unit', 'each',
        'cost', jsonb_build_object('source', 'tool', 'unit_cost_ex_gst', 145.55, 'evidence', 'patio-tool calc 1'),
        'sell', jsonb_build_object('basis', 'stated', 'kind', 'tool', 'unit_sell_ex_gst', 181.94, 'source_ref', 'patio-tool calc 1')))),
      'contract'),
    'quote_line_sell_kind_unknown', 'a tool-stated sell was accepted');
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_create_draft(%L, %L, %L)', job, jsonb_build_object(
      'family', 'patio', 'parties', party,
      'lines', jsonb_build_array(jsonb_build_object('line_key', 'posts', 'description', 'Posts', 'qty', 5, 'unit', 'each',
        'cost', jsonb_build_object('source', 'tool', 'unit_cost_ex_gst', 145.55, 'evidence', 'patio-tool calc 1'),
        'sell', jsonb_build_object('basis', 'stated', 'unit_sell_ex_gst', 181.94)))),
      'contract'),
    'quote_line_sell_kind_unknown', 'a stated sell with no owner was accepted');
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_create_draft(%L, %L, %L)', job, jsonb_build_object(
      'family', 'patio', 'parties', party,
      'lines', jsonb_build_array(jsonb_build_object('line_key', 'posts', 'description', 'Posts', 'qty', 5, 'unit', 'each',
        'cost', jsonb_build_object('source', 'none'), 'sell', jsonb_build_object('basis', 'cost_markup')))),
      'contract'),
    'quote_v2_lines_check', 'a marked-up line with no cost was accepted');
END $$;

-- ── The party view: own quote only, never cost, markup or other money ───
DO $$
DECLARE
  rev uuid := (SELECT v::uuid FROM ids WHERE k = 'gw_rev1');
  pc uuid := (SELECT v::uuid FROM ids WHERE k = 'gw_client');
  pn uuid := (SELECT v::uuid FROM ids WHERE k = 'gw_nb');
  v jsonb;
BEGIN
  v := public.quote_v2_party_view(rev, pc);
  IF v->'party'->>'first_name' <> 'Stephen' OR (v->'party'->'share'->>'inc_gst')::numeric <> 2381.50 THEN
    RAISE EXCEPTION 'client view must show Stephen and his own share, got %', v->'party';
  END IF;
  IF (v->'job_total'->>'inc_gst')::numeric <> 4763.00 THEN
    RAISE EXCEPTION 'the view shows the job total';
  END IF;
  IF jsonb_array_length(v->'lines') <> 4
     OR (v->'lines'->0->>'your_share_ex_gst')::numeric <> 1375.00
     OR (v->'lines'->0->>'line_total_ex_gst')::numeric <> 2750.00 THEN
    RAISE EXCEPTION 'the view shows the party''s share line by line, got %', v->'lines';
  END IF;
  IF v->'other_parties' <> '[{"role": "neighbour", "first_name": "Fiona", "share_of_job_percent": 50.0}]'::jsonb THEN
    RAISE EXCEPTION 'other parties appear by first name and split only, got %', v->'other_parties';
  END IF;
  IF position(pn::text IN v::text) > 0 OR v::text ~* '(unit_cost|markup|cost_|token|ghl|stated_by)'
     OR position('Neighbour' IN v::text) > 0 OR position('Client' IN v::text) > 0 THEN
    RAISE EXCEPTION 'the party view leaked another party id, a surname, a cost, a markup or a contact: %', v;
  END IF;
  IF public.quote_v2_party_view(rev, gen_random_uuid()) IS NOT NULL THEN
    RAISE EXCEPTION 'a party not on the revision sees nothing';
  END IF;
END $$;

-- ── Links: forward to the same party's current revision; accept per party ─
DO $$
DECLARE
  job uuid := '00000000-0000-4000-8000-000000261423';
  rev1 uuid := (SELECT v::uuid FROM ids WHERE k = 'gw_rev1');
  pc uuid := (SELECT v::uuid FROM ids WHERE k = 'gw_client');
  pn uuid := (SELECT v::uuid FROM ids WHERE k = 'gw_nb');
  rev2 uuid;
  tok_c1 text;
  tok_n1 text;
  tok_c2 text;
  lk jsonb;
  o jsonb;
  a jsonb;
  h text;
BEGIN
  lk := public.quote_v2_issue_party_link(rev1, pc, 'contract');
  tok_c1 := lk->>'token';
  tok_n1 := (public.quote_v2_issue_party_link(rev1, pn, 'contract'))->>'token';
  IF tok_c1 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'a link token is 64 hex characters';
  END IF;
  IF EXISTS (SELECT 1 FROM public.quote_v2_party_links WHERE token_sha256 = tok_c1) THEN
    RAISE EXCEPTION 'only the token hash is stored';
  END IF;
  o := public.quote_v2_open_party_link(tok_c1);
  IF o->>'state' <> 'current' OR o->'quote'->'party'->>'first_name' <> 'Stephen' THEN
    RAISE EXCEPTION 'the client link opens the client''s current quote, got %', o;
  END IF;
  o := public.quote_v2_open_party_link(tok_n1);
  IF o->'quote'->'party'->>'first_name' <> 'Fiona' THEN
    RAISE EXCEPTION 'the neighbour link opens the neighbour''s own quote';
  END IF;
  IF public.quote_v2_open_party_link(repeat('a', 64))->>'state' <> 'unknown'
     OR public.quote_v2_open_party_link('not-a-token')->>'state' <> 'unknown'
     OR public.quote_v2_open_party_link(repeat('a', 64))->'quote' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'an unknown token opens nothing';
  END IF;

  -- Revision 2: same parties, 45/55 split (the 15 Sep shape). Revision 1's
  -- links now forward to the SAME party's revision 2, never the other's.
  rev2 := public.quote_v2_create_draft(job, jsonb_build_object(
    'family', 'fencing', 'scope', jsonb_build_object('title', 'Colorbond fence, revised split'),
    'parties', jsonb_build_array(
      jsonb_build_object('ref', 'c', 'party_id', pc, 'share_rule', 'agreed_percent', 'share_bp', 4500),
      jsonb_build_object('ref', 'n', 'party_id', pn, 'share_rule', 'agreed_percent', 'share_bp', 5500)),
    'lines', jsonb_build_array(
      jsonb_build_object('line_key', 'fence', 'description', 'Colorbond fence 1800 Woodland Grey', 'qty', 22, 'unit', 'lm',
        'sell', jsonb_build_object('basis', 'stated', 'kind', 'owner', 'unit_sell_ex_gst', 125, 'stated_by', 'marnin', 'stated_at', '2026-09-15T08:00:00+08')))),
    'contract');
  PERFORM public.quote_v2_freeze_revision(rev2, 'contract', public.quote_v2_perth_today() + 30);
  o := public.quote_v2_open_party_link(tok_c1);
  IF o->>'state' <> 'forwarded' OR (o->'quote'->>'revision_id')::uuid <> rev2
     OR o->'quote'->'party'->>'first_name' <> 'Stephen' OR (o->>'link_revision_number')::int <> 1 THEN
    RAISE EXCEPTION 'a retired client link forwards to the client''s current revision, got %', o;
  END IF;
  IF (o->'quote'->'party'->'share'->>'ex_gst')::numeric <> 1237.50 THEN
    RAISE EXCEPTION 'the forwarded page shows the frozen 45%% share (1237.50 ex), got %', o->'quote'->'party';
  END IF;
  o := public.quote_v2_open_party_link(tok_n1);
  IF o->'quote'->'party'->>'first_name' <> 'Fiona' OR (o->'quote'->'party'->'share'->>'ex_gst')::numeric <> 1512.50 THEN
    RAISE EXCEPTION 'a retired neighbour link forwards to the neighbour''s current revision';
  END IF;
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_issue_party_link(%L, %L, %L)', rev1, pc, 'contract'),
    'quote_revision_not_current', 'a link was issued for a replaced revision');

  -- Accepting needs the current revision and exactly what was shown.
  h := (SELECT content_hash FROM public.quote_v2_revisions WHERE id = rev2);
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_accept(%L, %L, %L)', tok_c1, rev1,
      (SELECT content_hash FROM public.quote_v2_revisions WHERE id = rev1)),
    'quote_revision_not_current', 'a replaced revision was accepted');
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_accept(%L, %L, %L)', tok_c1, rev2, 'sha256:' || repeat('1', 64)),
    'quote_content_changed', 'an acceptance of different content was recorded');
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_accept(%L, %L, %L)', repeat('b', 64), rev2, h),
    'quote_link_invalid', 'an unknown token accepted');

  a := public.quote_v2_accept(tok_c1, rev2, h, 'Stephen');
  IF a->>'state' <> 'accepted' OR (a->>'job_fully_accepted')::boolean THEN
    RAISE EXCEPTION 'one of two parties accepting does not accept the job, got %', a;
  END IF;
  IF EXISTS (SELECT 1 FROM public.quote_v2_acceptances WHERE party_id = pn) THEN
    RAISE EXCEPTION 'the client''s link recorded the neighbour''s acceptance';
  END IF;
  a := public.quote_v2_accept(tok_c1, rev2, h);
  IF a->>'state' <> 'already_accepted' THEN
    RAISE EXCEPTION 'accepting twice is idempotent';
  END IF;
  a := public.quote_v2_accept(tok_n1, rev2, h, 'Fiona');
  IF a->>'state' <> 'accepted' OR NOT (a->>'job_fully_accepted')::boolean THEN
    RAISE EXCEPTION 'every party with a share accepted: the job is accepted, got %', a;
  END IF;
  IF NOT (public.quote_v2_job_acceptance(job)->>'fully_accepted')::boolean THEN
    RAISE EXCEPTION 'job acceptance read disagrees';
  END IF;
  IF (SELECT count(*) FROM public.quote_v2_acceptances WHERE revision_id = rev1) <> 0 THEN
    RAISE EXCEPTION 'nothing was accepted on the replaced revision';
  END IF;

  -- A revoked link opens and accepts nothing.
  lk := public.quote_v2_issue_party_link(rev2, pc, 'contract');
  tok_c2 := lk->>'token';
  PERFORM public.quote_v2_revoke_party_link((lk->>'link_id')::uuid, 'contract', 'sent to the wrong address');
  IF public.quote_v2_open_party_link(tok_c2)->>'state' <> 'revoked'
     OR public.quote_v2_open_party_link(tok_c2)->'quote' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'a revoked link must open nothing';
  END IF;
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_accept(%L, %L, %L)', tok_c2, rev2, h),
    'quote_link_invalid', 'a revoked link accepted');
  -- Revoking is per party: the client's older, forwarding link stops too,
  -- the neighbour's links do not, and a re-issued link is fresh and live.
  IF public.quote_v2_open_party_link(tok_c1)->>'state' <> 'revoked'
     OR public.quote_v2_open_party_link(tok_c1)->'quote' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'revoking one of a party''s links must revoke its forwarding links, got %',
      public.quote_v2_open_party_link(tok_c1)->>'state';
  END IF;
  IF public.quote_v2_open_party_link(tok_n1)->>'state' <> 'forwarded' THEN
    RAISE EXCEPTION 'revoking the client''s links must not touch the neighbour''s';
  END IF;
  IF public.quote_v2_revoke_party_link((lk->>'link_id')::uuid, 'contract', 'again') <> 0 THEN
    RAISE EXCEPTION 'revoking an already revoked party revokes nothing more';
  END IF;
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_revoke_party_link(%L, %L, %L)', gen_random_uuid(), 'contract', 'x'),
    'quote_link_missing', 'an unknown link was revoked');
  tok_c2 := (public.quote_v2_issue_party_link(rev2, pc, 'contract'))->>'token';
  IF public.quote_v2_open_party_link(tok_c2)->>'state' <> 'current'
     OR public.quote_v2_accept(tok_c2, rev2, h)->>'state' <> 'already_accepted' THEN
    RAISE EXCEPTION 'a link re-issued after revocation must open the party''s current quote';
  END IF;
  INSERT INTO ids VALUES ('gw_rev2', rev2::text);
END $$;

-- ── A party dropped from the current revision has no current quote ──────
DO $$
DECLARE
  job uuid := '00000000-0000-4000-8000-0000000000aa';
  rev1 uuid;
  rev2 uuid;
  pc uuid;
  tok_n text;
  o jsonb;
BEGIN
  rev1 := public.quote_v2_create_draft(job, jsonb_build_object(
    'family', 'misc', 'scope', '{}'::jsonb,
    'parties', jsonb_build_array(
      jsonb_build_object('ref', 'c', 'role', 'client', 'display_name', 'Ann', 'share_rule', 'equal', 'share_bp', 5000),
      jsonb_build_object('ref', 'n', 'role', 'neighbour', 'display_name', 'Bo', 'share_rule', 'equal', 'share_bp', 5000)),
    'lines', jsonb_build_array(jsonb_build_object('line_key', 'x', 'description', 'Work', 'qty', 1, 'unit', 'item',
      'sell', jsonb_build_object('basis', 'stated', 'kind', 'owner', 'unit_sell_ex_gst', 100, 'stated_by', 'marnin', 'stated_at', '2026-09-20T08:00:00+08')))),
    'contract');
  PERFORM public.quote_v2_freeze_revision(rev1, 'contract', public.quote_v2_perth_today() + 7);
  SELECT party_id INTO pc FROM public.quote_v2_revision_parties WHERE revision_id = rev1 AND role = 'client';
  tok_n := (public.quote_v2_issue_party_link(rev1,
    (SELECT party_id FROM public.quote_v2_revision_parties WHERE revision_id = rev1 AND role = 'neighbour'), 'contract'))->>'token';
  rev2 := public.quote_v2_create_draft(job, jsonb_build_object(
    'family', 'misc', 'scope', '{}'::jsonb,
    'parties', jsonb_build_array(jsonb_build_object('ref', 'c', 'party_id', pc, 'share_rule', 'sole', 'share_bp', 10000)),
    'lines', jsonb_build_array(jsonb_build_object('line_key', 'x', 'description', 'Work', 'qty', 1, 'unit', 'item',
      'sell', jsonb_build_object('basis', 'stated', 'kind', 'owner', 'unit_sell_ex_gst', 100, 'stated_by', 'marnin', 'stated_at', '2026-09-20T08:00:00+08')))),
    'contract');
  PERFORM public.quote_v2_freeze_revision(rev2, 'contract', public.quote_v2_perth_today() + 7);
  o := public.quote_v2_open_party_link(tok_n);
  IF o->>'state' <> 'no_current_quote' OR o->'quote' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'a dropped neighbour''s old link must never show the client''s quote, got %', o;
  END IF;
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_accept(%L, %L, %L)', tok_n, rev2,
      (SELECT content_hash FROM public.quote_v2_revisions WHERE id = rev2)),
    'quote_party_nothing_to_accept', 'a dropped party accepted the client''s revision');
END $$;

-- ── Frozen means frozen ─────────────────────────────────────────────────
DO $$
DECLARE
  rev uuid := (SELECT v::uuid FROM ids WHERE k = 'gw_rev2');
  line uuid := (SELECT id FROM public.quote_v2_lines WHERE revision_id = (SELECT v::uuid FROM ids WHERE k = 'gw_rev2') LIMIT 1);
BEGIN
  PERFORM pg_temp.expect_refusal(format('UPDATE public.quote_v2_lines SET description = %L WHERE id = %L', 'x', line),
    'quote_v2_frozen_immutable', 'frozen line UPDATE was accepted');
  PERFORM pg_temp.expect_refusal(format('DELETE FROM public.quote_v2_lines WHERE id = %L', line),
    'quote_v2_frozen_immutable', 'frozen line DELETE was accepted');
  PERFORM pg_temp.expect_refusal(format('UPDATE public.quote_v2_revisions SET valid_until = valid_until + 1 WHERE id = %L', rev),
    'quote_v2_frozen_immutable', 'frozen revision UPDATE was accepted');
  PERFORM pg_temp.expect_refusal(format('UPDATE public.quote_v2_party_totals SET share_gst = 0 WHERE revision_id = %L', rev),
    'quote_v2_frozen_immutable', 'frozen party total UPDATE was accepted');
  PERFORM pg_temp.expect_refusal(format(
      'INSERT INTO public.quote_v2_lines (revision_id, line_key, ordinal, description, qty, unit, cost_source, sell_basis, sell_stated_kind, sell_stated_by, sell_stated_at, unit_sell_ex_gst) VALUES (%L, %L, 99, %L, 1, %L, %L, %L, %L, %L, now(), 1)',
      rev, 'sneak', 'Sneaked line', 'item', 'none', 'stated', 'owner', 'x'),
    'quote_v2_frozen_immutable', 'a line was added to a frozen revision');
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_freeze_revision(%L, %L, %L)', rev, 'x', public.quote_v2_perth_today() + 1),
    'quote_revision_not_draft', 'a frozen revision was frozen again');
  PERFORM pg_temp.expect_refusal(format('DELETE FROM public.quote_v2_acceptances WHERE revision_id = %L', rev),
    'price_book_append_only', 'an acceptance was deleted');
  PERFORM pg_temp.expect_refusal(format('UPDATE public.quote_v2_parties SET display_name = %L', 'B'),
    'price_book_append_only', 'a party identity was changed');
END $$;

-- ── SWP-26051 Canning Vale: the double-counted gutter beam is refused;
--    without it the quote totals $29,631.23 inc ───────────────────────────
DO $$
DECLARE
  job uuid := '00000000-0000-4000-8000-000000026051';
  tool text := 'patio-tool pricing_json generated 2026-04-02T05:23:10.383Z';
  tool_at timestamptz := '2026-04-02T05:23:10.383Z';
  base jsonb;
  dup jsonb;
  lines jsonb;
  rev_dup uuid;
  rev uuid;
  res jsonb;
BEGIN
  -- qty, unit and unit cost exactly as the scoping tool recorded them; the
  -- sell it showed is carried as the owner's stated sell
  -- (Ridge Cap, Gable Barges and Fascia Board carry their true metres).
  SELECT jsonb_agg(jsonb_build_object(
      'line_key', x.k, 'description', x.d, 'qty', x.q, 'unit', x.u,
      'cost', jsonb_build_object('source', 'tool', 'unit_cost_ex_gst', x.c, 'evidence', tool),
      'sell', jsonb_build_object('basis', 'stated', 'kind', 'owner', 'unit_sell_ex_gst', x.s, 'stated_by', 'marnin', 'stated_at', tool_at))
    ORDER BY x.o)
  INTO base
  FROM (VALUES
    (1, 'posts', 'Posts 90×90×2', 5, 'each', 145.55, 181.938),
    (2, 'kwikset', 'Kwikset Concrete (5 bags/post)', 25, 'bag', 5, 6.25),
    (3, 'gutter-beam', 'Gutter Beam 100×50×2', 1, 'stock', 195, 243.75),
    (4, 'fascia-beam', 'Fascia Beam 100×50×2', 1, 'stock', 240, 300),
    (5, 'trusses', 'Trusses 76×38×1.6 (risers welded, 200H×300V)', 8, 'each', 702.7075, 878.385),
    (6, 'purlins', 'Purlins 76×38×1.6 RHS', 6, 'stock', 248, 310),
    (7, 'fascia-brackets', 'Fascia Brackets', 4, 'each', 12, 15),
    (8, 'spanplus', 'SpanPlus 330 Sheets, last sheet cut to 290mm', 235.6, 'lm', 12.04, 15.05),
    (9, 'ridge-cap', 'Ridge Cap', 8, 'lm', 24, 30),
    (10, 'patio-gutter', 'Patio Gutter', 6.5, 'lm', 22, 27.5),
    (11, 'downpipes', 'Downpipes 95×45mm (2×1800mm + clip each)', 2, 'each', 79.99, 99.97),
    (12, 'gable-barges', 'Gable Barges', 26, 'lm', 24, 30),
    (13, 'gable-infill', 'Gable Infill, Colorbond', 2, 'each', 132.86, 166.075),
    (14, 'fascia-board', 'Fascia Board (House Wall)', 8, 'lm', 24, 30),
    (15, 'fixings', 'Fixings (screws, anchors, silicone, foam)', 68.4, 'm2', 2.5, 3.13),
    (17, 'demolition', 'Demolition + Disposal', 1, 'item', 1040, 1850),
    (18, 'labour', 'Labour, 2 trades x 5 days', 80, 'hour', 45, 110)
  ) AS x(o, k, d, q, u, c, s);
  dup := jsonb_build_object('line_key', 'gutter-beam-extra', 'description', 'Gutter Beam 100×50×2', 'qty', 1, 'unit', 'each',
    'cost', jsonb_build_object('source', 'tool', 'unit_cost_ex_gst', 195, 'evidence', tool),
    'sell', jsonb_build_object('basis', 'stated', 'kind', 'owner', 'unit_sell_ex_gst', 248, 'stated_by', 'marnin', 'stated_at', tool_at));
  lines := base || jsonb_build_array(dup);
  rev_dup := public.quote_v2_create_draft(job, jsonb_build_object(
    'family', 'patio',
    'scope', jsonb_build_object('title', '12.5 m x 5.5 m gable patio, SpanPlus 330, Classic Cream, Manor Red steel'),
    'parties', jsonb_build_array(jsonb_build_object('ref', 'c', 'role', 'client', 'display_name', 'Margaret',
      'ghl_contact_id', 'CPGOXQtXDJwFOCNZ4gzd', 'share_rule', 'sole', 'share_bp', 10000)),
    'lines', lines), 'contract');
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_freeze_revision(%L, %L, %L)', rev_dup, 'contract', public.quote_v2_perth_today() + 30),
    'quote_line_duplicate', 'SWP-26051 froze with the gutter beam counted twice');

  rev := public.quote_v2_create_draft(job, jsonb_build_object(
    'family', 'patio',
    'scope', jsonb_build_object('title', '12.5 m x 5.5 m gable patio, SpanPlus 330, Classic Cream, Manor Red steel'),
    'parties', jsonb_build_array(jsonb_build_object('ref', 'c', 'role', 'client', 'display_name', 'Margaret',
      'ghl_contact_id', 'CPGOXQtXDJwFOCNZ4gzd', 'share_rule', 'sole', 'share_bp', 10000)),
    'lines', base), 'contract');
  res := public.quote_v2_freeze_revision(rev, 'contract', public.quote_v2_perth_today() + 30);
  IF (res->>'job_total_ex_gst')::numeric <> 26937.48 OR (res->>'job_total_inc_gst')::numeric <> 29631.23 THEN
    RAISE EXCEPTION 'SWP-26051 without the double count must be 26937.48 ex / 29631.23 inc, got %', res;
  END IF;
  IF (SELECT sum(line_cost_ex_gst) FROM public.quote_v2_lines WHERE revision_id = rev) <> 17669.73 THEN
    RAISE EXCEPTION 'SWP-26051 cost to us is recorded on every line, got %',
      (SELECT sum(line_cost_ex_gst) FROM public.quote_v2_lines WHERE revision_id = rev);
  END IF;
  -- A deliberate repeat is allowed when it says why.
  rev := public.quote_v2_create_draft(job, jsonb_build_object(
    'family', 'patio', 'scope', '{}'::jsonb,
    'parties', jsonb_build_array(jsonb_build_object('ref', 'c', 'role', 'client', 'display_name', 'Margaret', 'share_rule', 'sole', 'share_bp', 10000)),
    'lines', base || jsonb_build_array(dup || '{"duplicate_ack": "second beam on the house side, measured on site"}'::jsonb)), 'contract');
  res := public.quote_v2_freeze_revision(rev, 'contract', public.quote_v2_perth_today() + 30);
  -- 26937.48 + 248.00 = 27185.48 ex (the tool stored 27185.49: its own
  -- line sums drift by a cent) -> 29904.03 inc.
  IF (res->>'job_total_inc_gst')::numeric <> 29904.03 THEN
    RAISE EXCEPTION 'an acknowledged repeat is priced, got %', res;
  END IF;
END $$;

-- ── Kiko, Balcatta: Stratco slats priced from cost x 1.4, rounded by the
--    owner to $5,260 ex = $5,786.00 inc ─────────────────────────────────
DO $$
DECLARE
  job uuid := '00000000-0000-4000-8000-00000000c1c0';
  e426 text := 'Stratco estimate E426 TB-WA-20260916-426, 16/09/2026';
  rev uuid;
  res jsonb;
  l record;
BEGIN
  rev := public.quote_v2_create_draft(job, jsonb_build_object(
    'family', 'stratco',
    'scope', jsonb_build_object('title', 'Aluminium slat screens, 9 void-infill bays and one pedestrian gate',
      'exclusions', jsonb_build_array('Gate latch and hinges', 'Fixings into existing pillars', 'Delivery')),
    'parties', jsonb_build_array(jsonb_build_object('ref', 'c', 'role', 'client', 'display_name', 'Kiko',
      'ghl_contact_id', 'Q8az8vefdIKIs3yl1bLn', 'share_rule', 'sole', 'share_bp', 10000)),
    'lines', jsonb_build_array(
      jsonb_build_object('line_key', 'bays-materials', 'description', 'Slat bays, Quickscreen 65, cut to size (9 bays, 14.1 m, 711 high)', 'qty', 1, 'unit', 'lot',
        'cost', jsonb_build_object('source', 'stated', 'unit_cost_ex_gst', 2015.44, 'stated_by', 'kiko-balcatta-slats-quote-20260917', 'evidence', e426),
        'sell', jsonb_build_object('basis', 'cost_markup')),
      jsonb_build_object('line_key', 'bays-labour', 'description', 'Install slat bays', 'qty', 14.115, 'unit', 'lm',
        'cost', jsonb_build_object('source', 'stated', 'unit_cost_ex_gst', 50, 'stated_by', 'marnin', 'evidence', 'labour $50/m, hold H4 (provisional)'),
        'sell', jsonb_build_object('basis', 'cost_markup')),
      jsonb_build_object('line_key', 'gate-materials', 'description', 'Pedestrian swing gate, 1700 opening', 'qty', 1, 'unit', 'lot',
        'cost', jsonb_build_object('source', 'stated', 'unit_cost_ex_gst', 737.63, 'stated_by', 'kiko-balcatta-slats-quote-20260917', 'evidence', e426),
        'sell', jsonb_build_object('basis', 'cost_markup')),
      jsonb_build_object('line_key', 'gate-labour', 'description', 'Install gate', 'qty', 1, 'unit', 'each',
        'cost', jsonb_build_object('source', 'stated', 'unit_cost_ex_gst', 300, 'stated_by', 'marnin', 'evidence', 'labour $300 per gate, hold H4 (provisional)'),
        'sell', jsonb_build_object('basis', 'cost_markup')),
      jsonb_build_object('line_key', 'rounding', 'description', 'Rounding', 'cost', jsonb_build_object('source', 'none'),
        'sell', jsonb_build_object('basis', 'adjustment', 'amount_ex_gst', -2.35, 'stated_by', 'marnin', 'stated_at', '2026-09-17T12:00:00+08'),
        'note', 'Quoted as $5,260 ex (cost x 1.4 = $5,262.35)'))),
    'contract');
  res := public.quote_v2_freeze_revision(rev, 'contract', public.quote_v2_perth_today() + 30);
  IF (res->>'job_total_ex_gst')::numeric <> 5260.00 OR (res->>'job_total_inc_gst')::numeric <> 5786.00 THEN
    RAISE EXCEPTION 'Kiko must be 5260.00 ex / 5786.00 inc, got %', res;
  END IF;
  FOR l IN SELECT * FROM public.quote_v2_lines WHERE revision_id = rev AND sell_basis = 'cost_markup' LOOP
    IF l.markup_multiplier <> 1.40 OR l.markup_source <> 'family_default' OR l.markup_rule_status <> 'provisional'
       OR l.markup_rule_row_id IS NULL THEN
      RAISE EXCEPTION 'Kiko lines use the stratco 1.4 family default, got % % %', l.line_key, l.markup_multiplier, l.markup_source;
    END IF;
  END LOOP;
  IF (SELECT sum(line_sell_ex_gst) FROM public.quote_v2_lines WHERE revision_id = rev AND sell_basis = 'cost_markup') <> 5262.35
     OR (SELECT line_sell_ex_gst FROM public.quote_v2_lines WHERE revision_id = rev AND line_key = 'bays-labour') <> 988.05 THEN
    RAISE EXCEPTION 'Kiko cost x 1.4 must be 5262.35 ex';
  END IF;
END $$;

-- ── Price book lines: whole stock lengths at their own rate (PB-9), the
--    scoper's markup with who set it, stale costs and unset markups refused
DO $$
DECLARE
  job uuid := '00000000-0000-4000-8000-0000000000aa';
  rev uuid;
  rev_older uuid;
  res jsonb;
  l record;
  ov uuid;
  lines jsonb;
BEGIN
  INSERT INTO public.price_book_items (item_key, family, category, description, unit, created_by) VALUES
    ('steel-rhs-100x50x2', 'patio', 'steel', 'RHS 100x50x2 galvanised', 'lm', 'contract'),
    ('steel-rhs-76x38x1-6', 'patio', 'steel', 'RHS 76x38x1.6', 'lm', 'contract'),
    ('concrete-kwikset-20kg', 'patio', 'concrete', 'Kwikset 20 kg', 'bag', 'contract');
  -- BD Metals priced two lengths on an invoice ($172.73 per 6.5 m, $150.00
  -- per 5.5 m) and has a generic list rate; 76x38 only has a 6.1 m price.
  INSERT INTO public.price_book_costs (item_key, supplier, cost_ex_gst, per_length_mm, as_at, evidence_kind, evidence_ref, recorded_by) VALUES
    ('steel-rhs-100x50x2', 'BD Metals', 26.5738, 6500, '2026-01-27', 'invoice', 'INV 00022187', 'contract'),
    ('steel-rhs-100x50x2', 'BD Metals', 27.2727, 5500, '2026-01-27', 'invoice', 'INV 00022187', 'contract'),
    ('steel-rhs-100x50x2', 'BD Metals', 28.00, NULL, '2026-01-20', 'price_list', 'BD list Jan 2026', 'contract'),
    ('steel-rhs-76x38x1-6', 'BD Metals', 16.00, 6100, '2026-01-27', 'invoice', 'INV 00022187', 'contract'),
    ('concrete-kwikset-20kg', 'Bunnings', 8.00, NULL, '2026-06-13', 'tool_constant', 'patio tool', 'contract');

  IF (SELECT whole_length_ex_gst FROM public.price_book_current_length_costs(ARRAY['steel-rhs-100x50x2'])
      WHERE per_length_mm = 6500) <> 172.73 THEN
    RAISE EXCEPTION 'a 6.5 m length costs its invoiced $172.73';
  END IF;

  lines := jsonb_build_array(
    jsonb_build_object('line_key', 'beam-6500', 'description', '100x50 beam, 6.5 m lengths', 'qty', 2,
      'cost', jsonb_build_object('source', 'price_book', 'item_key', 'steel-rhs-100x50x2', 'stock_length_mm', 6500),
      'sell', jsonb_build_object('basis', 'cost_markup')),
    jsonb_build_object('line_key', 'beam-5500', 'description', '100x50 beam, 5.5 m lengths', 'qty', 1,
      'cost', jsonb_build_object('source', 'price_book', 'item_key', 'steel-rhs-100x50x2', 'stock_length_mm', 5500),
      'sell', jsonb_build_object('basis', 'cost_markup')),
    jsonb_build_object('line_key', 'beam-8000', 'description', '100x50 beam, 8 m lengths', 'qty', 1,
      'cost', jsonb_build_object('source', 'price_book', 'item_key', 'steel-rhs-100x50x2', 'stock_length_mm', 8000),
      'sell', jsonb_build_object('basis', 'cost_markup')),
    jsonb_build_object('line_key', 'kwikset', 'description', 'Kwikset', 'qty', 10,
      'cost', jsonb_build_object('source', 'price_book', 'item_key', 'concrete-kwikset-20kg'),
      'sell', jsonb_build_object('basis', 'cost_markup')));
  rev_older := public.quote_v2_create_draft(job, jsonb_build_object('family', 'patio', 'scope', '{}'::jsonb,
    'parties', jsonb_build_array(jsonb_build_object('ref', 'c', 'role', 'client', 'display_name', 'Ann', 'share_rule', 'sole', 'share_bp', 10000)),
    'lines', lines), 'contract');
  rev := public.quote_v2_create_draft(job, jsonb_build_object('family', 'patio', 'scope', '{}'::jsonb,
    'parties', jsonb_build_array(jsonb_build_object('ref', 'c', 'role', 'client', 'display_name', 'Ann', 'share_rule', 'sole', 'share_bp', 10000)),
    'lines', lines), 'contract');

  SELECT * INTO l FROM public.quote_v2_lines WHERE revision_id = rev AND line_key = 'beam-5500';
  IF l.unit <> 'length' OR l.unit_cost_ex_gst <> 150.00 OR l.cost_rate_basis <> 'length_rate' OR l.stock_length_mm <> 5500 THEN
    RAISE EXCEPTION 'PB-9: a 5.5 m length costs its own $150.00, not 5.5 m of the 6.5 m rate, got % % %', l.unit, l.unit_cost_ex_gst, l.cost_rate_basis;
  END IF;
  SELECT * INTO l FROM public.quote_v2_lines WHERE revision_id = rev AND line_key = 'beam-8000';
  IF l.unit_cost_ex_gst <> 224.00 OR l.cost_rate_basis <> 'per_lm_rate' THEN
    RAISE EXCEPTION 'PB-9: an unpriced length falls back to the supplier''s generic $/LM rate, got % %', l.unit_cost_ex_gst, l.cost_rate_basis;
  END IF;
  SELECT * INTO l FROM public.quote_v2_lines WHERE revision_id = rev AND line_key = 'kwikset';
  IF l.unit <> 'bag' OR l.cost_rate_basis <> 'item_unit' OR l.cost_status <> 'provisional' OR l.cost_as_at <> '2026-06-13' THEN
    RAISE EXCEPTION 'a per-item price book line carries its unit, rate date and status';
  END IF;
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_create_draft(%L, %L::jsonb, %L)', job, jsonb_build_object(
      'family', 'patio', 'scope', '{}'::jsonb,
      'parties', jsonb_build_array(jsonb_build_object('ref', 'c', 'role', 'client', 'display_name', 'Ann', 'share_rule', 'sole', 'share_bp', 10000)),
      'lines', jsonb_build_array(jsonb_build_object('line_key', 'p', 'description', '76x38 5 m', 'qty', 1,
        'cost', jsonb_build_object('source', 'price_book', 'item_key', 'steel-rhs-76x38x1-6', 'stock_length_mm', 5000),
        'sell', jsonb_build_object('basis', 'cost_markup')))), 'contract'),
    'quote_line_unpriced', 'a stock length with no rate was priced by guess');

  -- The scoper marks one line up to 1.5; the rest take the patio default 1.35.
  ov := public.quote_v2_set_line_markup(rev, 'beam-6500', 1.5, 'nithin', 'long run, heavier handling');
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_set_line_markup(%L, %L, 0.9, %L)', rev, 'beam-6500', 'nithin'),
    'quote_markup_below_cost', 'a markup below cost was accepted');
  res := public.quote_v2_freeze_revision(rev, 'contract', public.quote_v2_perth_today() + 30);
  SELECT * INTO l FROM public.quote_v2_lines WHERE revision_id = rev AND line_key = 'beam-6500';
  IF l.markup_source <> 'line_override' OR l.markup_multiplier <> 1.5 OR l.markup_set_by <> 'nithin'
     OR l.markup_override_id <> ov OR l.unit_sell_ex_gst <> 259.095 OR l.line_sell_ex_gst <> 518.19
     OR l.line_cost_ex_gst <> 345.46 THEN
    RAISE EXCEPTION 'the scoper''s line markup is used and recorded with who set it, got % % % %',
      l.markup_source, l.markup_multiplier, l.unit_sell_ex_gst, l.line_sell_ex_gst;
  END IF;
  SELECT * INTO l FROM public.quote_v2_lines WHERE revision_id = rev AND line_key = 'beam-5500';
  IF l.markup_source <> 'family_default' OR l.markup_multiplier <> 1.35 OR l.line_sell_ex_gst <> 202.50 THEN
    RAISE EXCEPTION 'other lines take the family default, got % % %', l.markup_source, l.markup_multiplier, l.line_sell_ex_gst;
  END IF;
  IF (SELECT public.quote_v2_line_price_source(x) FROM public.quote_v2_lines x WHERE revision_id = rev AND line_key = 'beam-5500')
       NOT LIKE 'cost from price book steel-rhs-100x50x2 5500 mm length, BD Metals as at 2026-01-27 (provisional) x 1.35 patio default (provisional)'
     OR (SELECT public.quote_v2_line_price_source(x) FROM public.quote_v2_lines x WHERE revision_id = rev AND line_key = 'beam-6500')
       NOT LIKE 'cost from price book % x 1.50 set by nithin at %' THEN
    RAISE EXCEPTION 'every line names where its price came from, got %',
      (SELECT string_agg(public.quote_v2_line_price_source(x), ' | ') FROM public.quote_v2_lines x WHERE revision_id = rev);
  END IF;
  IF (public.quote_v2_staff_revision(rev)->'lines'->0->>'price_source') IS NULL
     OR public.quote_v2_staff_revision(rev)::text LIKE '%token%' THEN
    RAISE EXCEPTION 'the staff read shows sources and never a token';
  END IF;
  IF (SELECT (default_multiplier_at_set) FROM public.quote_line_markup_overrides WHERE id = ov) <> 1.35 THEN
    RAISE EXCEPTION 'the default at the time is recorded beside the override';
  END IF;
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_set_line_markup(%L, %L, 1.6, %L)', rev, 'beam-5500', 'nithin'),
    'quote_v2_frozen_immutable', 'a markup was changed on a frozen revision');
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_freeze_revision(%L, %L, %L)', rev_older, 'contract', public.quote_v2_perth_today() + 30),
    'quote_revision_superseded', 'an older draft froze over a newer frozen revision');

  -- A newer cost for a length already on a draft makes the draft stale.
  rev := public.quote_v2_create_draft(job, jsonb_build_object('family', 'patio', 'scope', '{}'::jsonb,
    'parties', jsonb_build_array(jsonb_build_object('ref', 'c', 'role', 'client', 'display_name', 'Ann', 'share_rule', 'sole', 'share_bp', 10000)),
    'lines', jsonb_build_array(lines->0)), 'contract');
  INSERT INTO public.price_book_costs (item_key, supplier, cost_ex_gst, per_length_mm, as_at, evidence_kind, evidence_ref, recorded_by) VALUES
    ('steel-rhs-100x50x2', 'BD Metals', 27.10, 6500, '2026-09-01', 'invoice', 'INV 00023001', 'contract');
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_freeze_revision(%L, %L, %L)', rev, 'contract', public.quote_v2_perth_today() + 30),
    'quote_cost_stale', 'a draft froze on a replaced cost');

  -- Fencing has no family markup yet: a cost-plus fencing line cannot freeze
  -- until someone sets one.
  rev := public.quote_v2_create_draft('00000000-0000-4000-8000-000000261423', jsonb_build_object('family', 'fencing', 'scope', '{}'::jsonb,
    'parties', jsonb_build_array(jsonb_build_object('ref', 'c', 'role', 'client', 'display_name', 'Stephen', 'share_rule', 'sole', 'share_bp', 10000)),
    'lines', jsonb_build_array(jsonb_build_object('line_key', 'k', 'description', 'Panel kit', 'qty', 1, 'unit', 'kit',
      'cost', jsonb_build_object('source', 'stated', 'unit_cost_ex_gst', 88, 'stated_by', 'marnin', 'evidence', 'fence tool COST_PRICES'),
      'sell', jsonb_build_object('basis', 'cost_markup')))), 'contract');
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_freeze_revision(%L, %L, %L)', rev, 'contract', public.quote_v2_perth_today() + 30),
    'quote_markup_unset', 'a fencing cost-plus line froze with no markup');
END $$;

-- ── Splits: a neighbour-only line, three parties, odd cents ─────────────
DO $$
DECLARE
  job uuid := '00000000-0000-4000-8000-0000000000aa';
  rev uuid;
  res jsonb;
  stated jsonb := jsonb_build_object('basis', 'stated', 'kind', 'owner', 'stated_by', 'marnin', 'stated_at', '2026-09-20T08:00:00+08');
BEGIN
  rev := public.quote_v2_create_draft(job, jsonb_build_object('family', 'fencing', 'scope', '{}'::jsonb,
    'parties', jsonb_build_array(
      jsonb_build_object('ref', 'c', 'role', 'client', 'display_name', 'Ann', 'share_rule', 'equal', 'share_bp', 3334),
      jsonb_build_object('ref', 'n1', 'role', 'neighbour', 'display_name', 'Bo', 'share_rule', 'equal', 'share_bp', 3333),
      jsonb_build_object('ref', 'n2', 'role', 'neighbour', 'display_name', 'Cy', 'share_rule', 'equal', 'share_bp', 3333)),
    'lines', jsonb_build_array(
      jsonb_build_object('line_key', 'fence', 'description', 'Fence', 'qty', 1, 'unit', 'item', 'sell', stated || '{"unit_sell_ex_gst": 100.01}'),
      jsonb_build_object('line_key', 'roots', 'description', 'Root removal', 'qty', 1, 'unit', 'item', 'sell', stated || '{"unit_sell_ex_gst": 55.55}',
        'splits', jsonb_build_array(jsonb_build_object('party_ref', 'n1', 'share_bp', 10000))))), 'contract');
  res := public.quote_v2_freeze_revision(rev, 'contract', public.quote_v2_perth_today() + 30);
  IF (res->>'job_total_inc_gst')::numeric <> 171.12
     OR res->'parties' <> jsonb_build_array(
       jsonb_build_object('party_id', res->'parties'->0->'party_id', 'share_ex_gst', 33.35, 'share_gst', 3.34, 'share_inc_gst', 36.69),
       jsonb_build_object('party_id', res->'parties'->1->'party_id', 'share_ex_gst', 88.88, 'share_gst', 8.89, 'share_inc_gst', 97.77),
       jsonb_build_object('party_id', res->'parties'->2->'party_id', 'share_ex_gst', 33.33, 'share_gst', 3.33, 'share_inc_gst', 36.66)) THEN
    RAISE EXCEPTION 'splits must sum to the job to the cent with the neighbour-only line on Bo, got %', res;
  END IF;

  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_freeze_revision(public.quote_v2_create_draft(%L, %L::jsonb, %L), %L, %L)',
      job, jsonb_build_object('family', 'misc', 'scope', '{}'::jsonb,
        'parties', jsonb_build_array(
          jsonb_build_object('ref', 'c', 'role', 'client', 'display_name', 'Ann', 'share_rule', 'agreed_percent', 'share_bp', 5000),
          jsonb_build_object('ref', 'n', 'role', 'neighbour', 'display_name', 'Bo', 'share_rule', 'agreed_percent', 'share_bp', 4000)),
        'lines', jsonb_build_array(jsonb_build_object('line_key', 'x', 'description', 'X', 'qty', 1, 'unit', 'item', 'sell', stated || '{"unit_sell_ex_gst": 10}'))),
      'contract', 'contract', public.quote_v2_perth_today() + 1),
    'quote_party_shares_not_whole', 'shares summing to 90% froze');
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_freeze_revision(public.quote_v2_create_draft(%L, %L::jsonb, %L), %L, %L)',
      job, jsonb_build_object('family', 'misc', 'scope', '{}'::jsonb,
        'parties', jsonb_build_array(jsonb_build_object('ref', 'n', 'role', 'neighbour', 'display_name', 'Bo', 'share_rule', 'sole', 'share_bp', 10000)),
        'lines', jsonb_build_array(jsonb_build_object('line_key', 'x', 'description', 'X', 'qty', 1, 'unit', 'item', 'sell', stated || '{"unit_sell_ex_gst": 10}'))),
      'contract', 'contract', public.quote_v2_perth_today() + 1),
    'quote_client_count', 'a revision with no client froze');
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_create_draft(%L, %L::jsonb, %L)',
      job, jsonb_build_object('family', 'misc', 'scope', '{"internal_margin": "x"}'::jsonb,
        'parties', jsonb_build_array(jsonb_build_object('ref', 'c', 'role', 'client', 'display_name', 'Ann', 'share_rule', 'sole', 'share_bp', 10000)),
        'lines', jsonb_build_array(jsonb_build_object('line_key', 'x', 'description', 'X', 'qty', 1, 'unit', 'item', 'sell', stated || '{"unit_sell_ex_gst": 10}'))),
      'contract'),
    'quote_scope_key_unknown', 'an internal note reached the customer-facing scope');
  PERFORM pg_temp.expect_refusal(format('SELECT public.quote_v2_freeze_revision(public.quote_v2_create_draft(%L, %L::jsonb, %L), %L, %L)',
      job, jsonb_build_object('family', 'misc', 'scope', '{}'::jsonb,
        'parties', jsonb_build_array(jsonb_build_object('ref', 'c', 'role', 'client', 'display_name', 'Ann', 'share_rule', 'sole', 'share_bp', 10000)),
        'lines', jsonb_build_array(jsonb_build_object('line_key', 'x', 'description', 'X', 'qty', 1, 'unit', 'item', 'sell', stated || '{"unit_sell_ex_gst": 10}'))),
      'contract', 'contract', public.quote_v2_perth_today() - 1),
    'quote_valid_until_invalid', 'a quote froze already expired');
END $$;

ROLLBACK;
