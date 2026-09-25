-- Quote v2 stage 2 local proof fixture. DISPOSABLE LOCAL DATABASE ONLY
-- (scripts/quote-v2/test-quote-records-local.sh). Freezes the three real
-- shapes and issues party links; tokens are kept in a proof-only table so the
-- renderer can open them. Nothing here is a production write.
CREATE TABLE quote_v2_proof_links (label text PRIMARY KEY, token text NOT NULL);

INSERT INTO public.jobs (id, org_id, status, type, job_number, site_suburb) VALUES
  ('00000000-0000-4000-8000-000000261423', '00000000-0000-0000-0000-000000000001', 'draft', 'fencing', 'SWF-261423', 'Gwelup'),
  ('00000000-0000-4000-8000-000000026051', '00000000-0000-0000-0000-000000000001', 'draft', 'patio', 'SWP-26051', 'Canning Vale'),
  ('00000000-0000-4000-8000-00000000c1c0', '00000000-0000-0000-0000-000000000001', 'draft', 'miscellaneous', 'KIKO-DRAFT', 'Balcatta');

DO $$
DECLARE
  gw uuid := '00000000-0000-4000-8000-000000261423';
  stated jsonb := jsonb_build_object('basis', 'stated', 'kind', 'owner', 'stated_by', 'marnin', 'stated_at', '2026-09-17T08:00:00+08');
  gw_lines jsonb;
  rev1 uuid;
  rev2 uuid;
  pc uuid;
  pn uuid;
  tool text := 'patio-tool pricing_json generated 2026-04-02T05:23:10.383Z';
  swp_lines jsonb;
  rev uuid;
  e426 text := 'Stratco estimate E426 TB-WA-20260916-426, 16/09/2026';
BEGIN
  gw_lines := jsonb_build_array(
    jsonb_build_object('line_key', 'fence', 'description', 'Colorbond fence 1800 Woodland Grey, Sameside', 'qty', 22, 'unit', 'lm', 'sell', stated || '{"unit_sell_ex_gst": 125}'),
    jsonb_build_object('line_key', 'plinths', 'description', 'Retaining plinths', 'qty', 9, 'unit', 'each', 'sell', stated || '{"unit_sell_ex_gst": 80}'),
    jsonb_build_object('line_key', 'removal', 'description', 'Remove existing Hardie fence', 'qty', 22, 'unit', 'lm', 'sell', stated || '{"unit_sell_ex_gst": 30}'),
    jsonb_build_object('line_key', 'delivery', 'description', 'Delivery', 'qty', 1, 'unit', 'delivery', 'sell', stated || '{"unit_sell_ex_gst": 200}'));
  -- Revision 1: the 15 Sep shape, a 45/55 split.
  rev1 := public.quote_v2_create_draft(gw, jsonb_build_object('family', 'fencing',
    'scope', jsonb_build_object('title', 'Colorbond boundary fence', 'summary', 'Replace the shared Hardie fence with 22 m of Colorbond, Woodland Grey 1800 Sameside, on retaining plinths.',
      'exclusions', jsonb_build_array('Root removal (neighbour only, priced separately)')),
    'parties', jsonb_build_array(
      jsonb_build_object('ref', 'c', 'role', 'client', 'display_name', 'Stephen', 'share_rule', 'agreed_percent', 'share_bp', 4500),
      jsonb_build_object('ref', 'n', 'role', 'neighbour', 'display_name', 'Fiona', 'share_rule', 'agreed_percent', 'share_bp', 5500)),
    'lines', gw_lines), 'quote-v2-proof');
  PERFORM public.quote_v2_freeze_revision(rev1, 'quote-v2-proof', public.quote_v2_perth_today() + 30);
  SELECT party_id INTO pc FROM public.quote_v2_revision_parties WHERE revision_id = rev1 AND role = 'client';
  SELECT party_id INTO pn FROM public.quote_v2_revision_parties WHERE revision_id = rev1 AND role = 'neighbour';
  INSERT INTO quote_v2_proof_links VALUES
    ('gwelup-client-rev1', public.quote_v2_issue_party_link(rev1, pc, 'quote-v2-proof')->>'token'),
    ('gwelup-neighbour-rev1', public.quote_v2_issue_party_link(rev1, pn, 'quote-v2-proof')->>'token');
  -- Revision 2: the 17 Sep revision, 50/50 on every line. Same two people.
  rev2 := public.quote_v2_create_draft(gw, jsonb_build_object('family', 'fencing',
    'scope', jsonb_build_object('title', 'Colorbond boundary fence', 'summary', 'Replace the shared Hardie fence with 22 m of Colorbond, Woodland Grey 1800 Sameside, on retaining plinths.',
      'exclusions', jsonb_build_array('Root removal (neighbour only, priced separately)')),
    'parties', jsonb_build_array(
      jsonb_build_object('ref', 'c', 'party_id', pc, 'ghl_contact_id', 'ghl-contact-of-stephen', 'share_rule', 'equal', 'share_bp', 5000),
      jsonb_build_object('ref', 'n', 'party_id', pn, 'share_rule', 'equal', 'share_bp', 5000)),
    'lines', gw_lines), 'quote-v2-proof');
  PERFORM public.quote_v2_freeze_revision(rev2, 'quote-v2-proof', public.quote_v2_perth_today() + 30);
  INSERT INTO quote_v2_proof_links VALUES
    ('gwelup-neighbour-rev2', public.quote_v2_issue_party_link(rev2, pn, 'quote-v2-proof')->>'token');

  -- SWP-26051 at the patio tool's costs, its sells carried as the owner's
  -- stated sells, without the second "Gutter Beam 100x50x2" line.
  SELECT jsonb_agg(jsonb_build_object('line_key', x.k, 'description', x.d, 'qty', x.q, 'unit', x.u,
      'cost', jsonb_build_object('source', 'tool', 'unit_cost_ex_gst', x.c, 'evidence', tool),
      'sell', jsonb_build_object('basis', 'stated', 'kind', 'owner', 'unit_sell_ex_gst', x.s, 'stated_by', 'marnin', 'stated_at', '2026-04-02T05:23:10.383Z')) ORDER BY x.o)
  INTO swp_lines
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
  rev := public.quote_v2_create_draft('00000000-0000-4000-8000-000000026051', jsonb_build_object('family', 'patio',
    'scope', jsonb_build_object('title', '12.5 m x 5.5 m gable patio', 'summary', 'SpanPlus 330 roof in Classic Cream, Manor Red steel, fascia connection.'),
    'parties', jsonb_build_array(jsonb_build_object('ref', 'c', 'role', 'client', 'display_name', 'Margaret', 'share_rule', 'sole', 'share_bp', 10000)),
    'lines', swp_lines), 'quote-v2-proof');
  PERFORM public.quote_v2_freeze_revision(rev, 'quote-v2-proof', public.quote_v2_perth_today() + 30);
  INSERT INTO quote_v2_proof_links VALUES ('swp-26051-client',
    public.quote_v2_issue_party_link(rev, (SELECT party_id FROM public.quote_v2_revision_parties WHERE revision_id = rev), 'quote-v2-proof')->>'token');

  -- Kiko: Stratco cost x 1.4 (family default), rounded by the owner.
  rev := public.quote_v2_create_draft('00000000-0000-4000-8000-00000000c1c0', jsonb_build_object('family', 'stratco',
    'scope', jsonb_build_object('title', 'Aluminium slat screens and gate', 'summary', 'Nine void-infill slat bays (14.1 m, 711 high, Quickscreen 65, 15 mm gap) and one pedestrian swing gate for the 1700 opening.',
      'exclusions', jsonb_build_array('Gate latch and hinges', 'Fixings into existing pillars', 'Delivery')),
    'parties', jsonb_build_array(jsonb_build_object('ref', 'c', 'role', 'client', 'display_name', 'Kiko', 'share_rule', 'sole', 'share_bp', 10000)),
    'lines', jsonb_build_array(
      jsonb_build_object('line_key', 'bays-materials', 'description', 'Slat bays, cut to size', 'qty', 1, 'unit', 'lot',
        'cost', jsonb_build_object('source', 'stated', 'unit_cost_ex_gst', 2015.44, 'stated_by', 'kiko-balcatta-slats-quote-20260917', 'evidence', e426),
        'sell', jsonb_build_object('basis', 'cost_markup')),
      jsonb_build_object('line_key', 'bays-labour', 'description', 'Install slat bays', 'qty', 14.115, 'unit', 'lm',
        'cost', jsonb_build_object('source', 'stated', 'unit_cost_ex_gst', 50, 'stated_by', 'marnin', 'evidence', 'labour $50/m (hold H4, provisional)'),
        'sell', jsonb_build_object('basis', 'cost_markup')),
      jsonb_build_object('line_key', 'gate-materials', 'description', 'Pedestrian swing gate', 'qty', 1, 'unit', 'lot',
        'cost', jsonb_build_object('source', 'stated', 'unit_cost_ex_gst', 737.63, 'stated_by', 'kiko-balcatta-slats-quote-20260917', 'evidence', e426),
        'sell', jsonb_build_object('basis', 'cost_markup')),
      jsonb_build_object('line_key', 'gate-labour', 'description', 'Install gate', 'qty', 1, 'unit', 'each',
        'cost', jsonb_build_object('source', 'stated', 'unit_cost_ex_gst', 300, 'stated_by', 'marnin', 'evidence', 'labour $300 per gate (hold H4, provisional)'),
        'sell', jsonb_build_object('basis', 'cost_markup')),
      jsonb_build_object('line_key', 'rounding', 'description', 'Rounding', 'cost', jsonb_build_object('source', 'none'),
        'sell', jsonb_build_object('basis', 'adjustment', 'amount_ex_gst', -2.35, 'stated_by', 'marnin', 'stated_at', '2026-09-17T12:00:00+08'),
        'note', 'Quoted as $5,260 ex (cost x 1.4 = $5,262.35)'))), 'quote-v2-proof');
  PERFORM public.quote_v2_freeze_revision(rev, 'quote-v2-proof', public.quote_v2_perth_today() + 30);
  INSERT INTO quote_v2_proof_links VALUES ('kiko-client',
    public.quote_v2_issue_party_link(rev, (SELECT party_id FROM public.quote_v2_revision_parties WHERE revision_id = rev), 'quote-v2-proof')->>'token');
END $$;
