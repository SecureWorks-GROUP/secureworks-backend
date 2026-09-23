-- Contract for 20260923190000_job_quote_values (context D1, dossier section 4).
--
-- Fixtures are synthetic ids and money shaped on the dossier design's named
-- rows (row labels only, no customer data). Each block states the row it
-- stands for and the value rule it proves. Everything rolls back.

\set ON_ERROR_STOP on

-- ── Grants and function properties ─────────────────────────────────────────
DO $$
DECLARE
  f regprocedure := 'public.job_quote_values(uuid)'::regprocedure;
  p record;
BEGIN
  SELECT prosecdef, provolatile, proconfig INTO p FROM pg_proc WHERE oid = f;
  IF NOT p.prosecdef THEN RAISE EXCEPTION 'd1 grants: job_quote_values must be SECURITY DEFINER'; END IF;
  IF p.provolatile <> 's' THEN RAISE EXCEPTION 'd1 grants: job_quote_values must be STABLE (read only), got %', p.provolatile; END IF;
  IF p.proconfig IS NULL OR NOT ('search_path=public, pg_temp' = ANY (p.proconfig)) THEN
    RAISE EXCEPTION 'd1 grants: fixed search_path missing, got %', p.proconfig;
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE') THEN RAISE EXCEPTION 'd1 grants: anon can execute job_quote_values'; END IF;
  IF has_function_privilege('authenticated', f, 'EXECUTE') THEN RAISE EXCEPTION 'd1 grants: authenticated can execute job_quote_values'; END IF;
  IF has_function_privilege('public', f, 'EXECUTE') THEN RAISE EXCEPTION 'd1 grants: PUBLIC can execute job_quote_values'; END IF;
  IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN RAISE EXCEPTION 'd1 grants: service_role cannot execute job_quote_values'; END IF;
END $$;

BEGIN;

-- Org and jobs (labels from the dossier named rows).
INSERT INTO public.jobs (id, org_id, status, type, job_number) VALUES
  ('d1000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'quoted',             'fencing', 'D1-ROW3-SWF-261458'),
  ('d1000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', 'quoted',             'fencing', 'D1-ROW6-SWF-26818'),
  ('d1000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000001', 'accepted',           'fencing', 'D1-ROW7-SWF-261355'),
  ('d1000000-0000-4000-8000-000000000010', '00000000-0000-0000-0000-000000000001', 'draft',              'patio',   'D1-ROW10-SWP-261456'),
  ('d1000000-0000-4000-8000-000000000014', '00000000-0000-0000-0000-000000000001', 'accepted',           'fencing', 'D1-ROW14-SWF-26904'),
  ('d1000000-0000-4000-8000-000000000015', '00000000-0000-0000-0000-000000000001', 'partially_accepted', 'fencing', 'D1-ROW15-SWF-26395');

-- Parties (owner = is_primary until sites S-M1 adds party_role).
INSERT INTO public.job_contacts (id, job_id, is_primary, client_email) VALUES
  ('d1c00000-0000-4000-8000-000000000061', 'd1000000-0000-4000-8000-000000000006', true,  'owner6@example.test'),
  ('d1c00000-0000-4000-8000-000000000141', 'd1000000-0000-4000-8000-000000000014', true,  'owner14@example.test'),
  ('d1c00000-0000-4000-8000-000000000142', 'd1000000-0000-4000-8000-000000000014', false, 'neighbour14a@example.test'),
  ('d1c00000-0000-4000-8000-000000000143', 'd1000000-0000-4000-8000-000000000014', false, 'neighbour14b@example.test'),
  ('d1c00000-0000-4000-8000-000000000151', 'd1000000-0000-4000-8000-000000000015', true,  'owner15@example.test'),
  ('d1c00000-0000-4000-8000-000000000152', 'd1000000-0000-4000-8000-000000000015', false, 'neighbour15a@example.test'),
  ('d1c00000-0000-4000-8000-000000000153', 'd1000000-0000-4000-8000-000000000015', false, 'neighbour15b@example.test');

-- Row 3 (SWF-261458): one whole quote with a sealed revision, $4,776.75.
INSERT INTO public.job_documents (id, job_id, type, version, quote_number, sent_at, created_at) VALUES
  ('d1d00000-0000-4000-8000-000000000031', 'd1000000-0000-4000-8000-000000000003', 'quote', 1, 'Q-3001', '2026-09-18T02:00:00Z', '2026-09-18T01:00:00Z');
INSERT INTO public.quote_revisions (id, job_id, job_document_id, version, recipient_email, totals_snapshot_json, released_via, sent_at) VALUES
  ('d1e00000-0000-4000-8000-000000000031', 'd1000000-0000-4000-8000-000000000003', 'd1d00000-0000-4000-8000-000000000031', 1, 'c3@example.test',
   '{"total_ex_gst": 4342.50, "gst": 434.25, "total_inc_gst": 4776.75}', 'send-quote/send', '2026-09-18T02:00:00Z');

-- Row 6 (SWF-26818): Q-0439 v1 superseded (revision $5,000); Q-0491 v2 with no
-- revision, valued only by its send-quote quote.sent log ($5,300, unverified);
-- a forged quote.sent from another source, and a send-quote row for another
-- job, each naming Q-0491, must be ignored; the
-- REAR run document is the owner's share $4,842.45 from its own snapshot even
-- though send-runs bound its revision (whole job $9,684.90) to it; an unsent
-- draft is not a sent quote.
INSERT INTO public.job_documents (id, job_id, type, version, quote_number, run_label, job_contact_id, data_snapshot_json, sent_at, superseded_at, created_at) VALUES
  ('d1d00000-0000-4000-8000-000000000061', 'd1000000-0000-4000-8000-000000000006', 'quote', 1, 'Q-0439', NULL, NULL, NULL,
   '2026-06-01T02:00:00Z', '2026-06-20T02:00:00Z', '2026-06-01T01:00:00Z'),
  ('d1d00000-0000-4000-8000-000000000062', 'd1000000-0000-4000-8000-000000000006', 'quote', 2, 'Q-0491', NULL, NULL, NULL,
   '2026-06-20T02:00:00Z', NULL, '2026-06-20T01:00:00Z'),
  ('d1d00000-0000-4000-8000-000000000063', 'd1000000-0000-4000-8000-000000000006', 'quote', 1, 'Q-0502', 'REAR', 'd1c00000-0000-4000-8000-000000000061',
   '{"run": {"run_label": "REAR", "totals": {"run_total_inc": 9684.90, "client_share_inc": 4842.45, "neighbour_share_inc": 4842.45}}}',
   '2026-07-01T02:00:00Z', NULL, '2026-07-01T01:00:00Z'),
  ('d1d00000-0000-4000-8000-000000000064', 'd1000000-0000-4000-8000-000000000006', 'quote', 3, 'Q-0550', NULL, NULL, NULL,
   NULL, NULL, '2026-07-10T01:00:00Z');
INSERT INTO public.quote_revisions (id, job_id, job_document_id, version, recipient_email, totals_snapshot_json, released_via, sent_at) VALUES
  ('d1e00000-0000-4000-8000-000000000061', 'd1000000-0000-4000-8000-000000000006', 'd1d00000-0000-4000-8000-000000000061', 1, 'owner6@example.test',
   '{"total_inc_gst": 5000}', 'send-quote/send', '2026-06-01T02:00:00Z'),
  ('d1e00000-0000-4000-8000-000000000063', 'd1000000-0000-4000-8000-000000000006', 'd1d00000-0000-4000-8000-000000000063', 2, 'owner6@example.test',
   '{"total_inc_gst": 9684.90}', 'send-quote/send-runs', '2026-07-01T02:00:00Z');
INSERT INTO public.business_events (job_id, entity_type, entity_id, event_type, source, payload, metadata, occurred_at) VALUES
  -- legacy send-quote insert (the attribution ladder may clear its job_id)
  ('d1000000-0000-4000-8000-000000000006', 'job', 'd1000000-0000-4000-8000-000000000006', 'quote.sent', 'send-quote',
   '{"document_id": "d1d00000-0000-4000-8000-000000000062", "total_inc_gst": 5300}', '{"handler": "send-quote/send"}', '2026-06-20T02:00:01Z'),
  -- forged: public-insertable source naming Q-0491, newer and bigger
  ('d1000000-0000-4000-8000-000000000006', 'job', 'd1000000-0000-4000-8000-000000000006', 'quote.sent', 'website_form',
   '{"document_id": "d1d00000-0000-4000-8000-000000000062", "total_inc_gst": 99999}', '{}', '2026-06-21T02:00:00Z'),
  -- right source, wrong job: names Q-0491 but belongs to another job
  (NULL, 'job', 'd1000000-0000-4000-8000-000000000003', 'quote.sent', 'send-quote',
   '{"document_id": "d1d00000-0000-4000-8000-000000000062", "total_inc_gst": 88888}', '{"handler": "send-quote/send"}', '2026-06-22T02:00:00Z'),
  -- recordEvidence path (source is the handler) for the run send
  ('d1000000-0000-4000-8000-000000000006', 'job', 'd1000000-0000-4000-8000-000000000006', 'quote.sent', 'send-quote/send-runs',
   '{"document_id": "d1d00000-0000-4000-8000-000000000063", "total_inc_gst": 9684.90, "run_count": 1}', '{"handler": "send-quote/send-runs"}', '2026-07-01T02:00:01Z');

-- Row 7 (SWF-261355): accepted Q-0738 with no revision and no quote.sent log:
-- value unknown with the reason, never the live price.
INSERT INTO public.job_documents (id, job_id, type, version, quote_number, sent_at, accepted_at, created_at) VALUES
  ('d1d00000-0000-4000-8000-000000000071', 'd1000000-0000-4000-8000-000000000007', 'quote', 1, 'Q-0738',
   '2026-08-01T02:00:00Z', '2026-08-03T02:00:00Z', '2026-08-01T01:00:00Z');

-- Row 10 (SWP-261456): quote emailed from Outlook, only an unsent draft here.
INSERT INTO public.job_documents (id, job_id, type, version, quote_number, sent_at, created_at) VALUES
  ('d1d00000-0000-4000-8000-000000000101', 'd1000000-0000-4000-8000-000000000010', 'quote', 1, NULL, NULL, '2026-09-22T13:40:00Z');

-- Row 14 (SWF-26904): three parties on runs. Owner, neighbour A and neighbour B
-- each get their own share; a run document with no party and one whose
-- snapshot lost its totals each say why they have no value; the send-runs
-- whole-job total is job level only.
INSERT INTO public.job_documents (id, job_id, type, version, quote_number, run_label, job_contact_id, data_snapshot_json, sent_at, created_at) VALUES
  ('d1d00000-0000-4000-8000-000000000141', 'd1000000-0000-4000-8000-000000000014', 'quote', 1, 'Q-1401', 'REAR', 'd1c00000-0000-4000-8000-000000000141',
   '{"run": {"totals": {"run_total_inc": 7733.00, "client_share_inc": 4023.00, "neighbour_share_inc": 3710.00}}}', '2026-08-01T02:00:00Z', '2026-08-01T01:00:00Z'),
  ('d1d00000-0000-4000-8000-000000000142', 'd1000000-0000-4000-8000-000000000014', 'quote', 1, 'Q-1402', 'REAR', 'd1c00000-0000-4000-8000-000000000142',
   '{"run": {"totals": {"run_total_inc": 7733.00, "client_share_inc": 4023.00, "neighbour_share_inc": 3710.00}}}', '2026-08-01T02:00:00Z', '2026-08-01T01:00:01Z'),
  ('d1d00000-0000-4000-8000-000000000143', 'd1000000-0000-4000-8000-000000000014', 'quote', 1, 'Q-1403', 'LHS', 'd1c00000-0000-4000-8000-000000000143',
   '{"run": {"totals": {"run_total_inc": 3462.00, "client_share_inc": "1731.00", "neighbour_share_inc": "1731.00"}}}', '2026-08-01T02:00:00Z', '2026-08-01T01:00:02Z'),
  ('d1d00000-0000-4000-8000-000000000144', 'd1000000-0000-4000-8000-000000000014', 'quote', 1, 'Q-1404', 'RHS', NULL,
   '{"run": {"totals": {"run_total_inc": 1000.00, "client_share_inc": 500.00, "neighbour_share_inc": 500.00}}}', '2026-08-01T02:00:00Z', '2026-08-01T01:00:03Z'),
  ('d1d00000-0000-4000-8000-000000000145', 'd1000000-0000-4000-8000-000000000014', 'quote', 1, 'Q-1405', 'FRONT', 'd1c00000-0000-4000-8000-000000000142',
   '{"run": {"run_label": "FRONT"}}', '2026-08-01T02:00:00Z', '2026-08-01T01:00:04Z');
INSERT INTO public.quote_revisions (id, job_id, job_document_id, version, recipient_email, totals_snapshot_json, released_via, sent_at) VALUES
  ('d1e00000-0000-4000-8000-000000000141', 'd1000000-0000-4000-8000-000000000014', 'd1d00000-0000-4000-8000-000000000141', 1, 'owner14@example.test',
   '{"total_inc_gst": 12195.00}', 'send-quote/send-runs', '2026-08-01T02:00:00Z');

-- Row 15 (SWF-26395): owner and neighbour A accepted, neighbour B never did.
-- Values are each party's share; acceptance roll-up is proved in the ops-api
-- test on the same shape. No send-runs revision survives here, so the
-- whole-job total comes from the send-runs quote.sent log (unverified), and a
-- newer log row whose total is not a number is skipped, never read as money.
INSERT INTO public.job_documents (id, job_id, type, version, quote_number, run_label, job_contact_id, data_snapshot_json, sent_at, accepted_at, created_at) VALUES
  ('d1d00000-0000-4000-8000-000000000151', 'd1000000-0000-4000-8000-000000000015', 'quote', 1, 'Q-0206', 'REAR', 'd1c00000-0000-4000-8000-000000000151',
   '{"run": {"totals": {"client_share_inc": 2552.00, "neighbour_share_inc": 1276.00}}}', '2026-06-01T02:00:00Z', '2026-06-02T02:00:00Z', '2026-06-01T01:00:00Z'),
  ('d1d00000-0000-4000-8000-000000000152', 'd1000000-0000-4000-8000-000000000015', 'quote', 1, 'Q-0207', 'REAR', 'd1c00000-0000-4000-8000-000000000152',
   '{"run": {"totals": {"client_share_inc": 2552.00, "neighbour_share_inc": 1276.00}}}', '2026-06-01T02:00:00Z', '2026-08-19T02:00:00Z', '2026-06-01T01:00:01Z'),
  ('d1d00000-0000-4000-8000-000000000153', 'd1000000-0000-4000-8000-000000000015', 'quote', 1, 'Q-0208', 'REAR', 'd1c00000-0000-4000-8000-000000000153',
   '{"run": {"totals": {"client_share_inc": 2552.00, "neighbour_share_inc": 1276.00}}}', '2026-06-01T02:00:00Z', NULL, '2026-06-01T01:00:02Z');
INSERT INTO public.business_events (job_id, entity_type, entity_id, event_type, source, payload, metadata, occurred_at) VALUES
  ('d1000000-0000-4000-8000-000000000015', 'job', 'd1000000-0000-4000-8000-000000000015', 'quote.sent', 'send-quote',
   '{"document_id": "d1d00000-0000-4000-8000-000000000151", "total_inc_gst": "not a number", "run_count": 1}', '{"handler": "send-quote/send-runs"}', '2026-06-01T02:00:02Z'),
  (NULL, 'job', 'd1000000-0000-4000-8000-000000000015', 'quote.sent', 'send-quote',
   '{"document_id": "d1d00000-0000-4000-8000-000000000151", "total_inc_gst": 5104.00, "run_count": 1}', '{"handler": "send-quote/send-runs"}', '2026-06-01T02:00:01Z');

-- ── Assertions ──────────────────────────────────────────────────────────────
CREATE TEMP TABLE d1_out AS
SELECT j.job_number, d.quote_number, v.*
FROM public.jobs j
CROSS JOIN LATERAL public.job_quote_values(j.id) v
JOIN public.job_documents d ON d.id = v.document_id
WHERE j.job_number LIKE 'D1-%';

DO $$
DECLARE r record; n int;
BEGIN
  -- Row 3: sealed revision.
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-3001';
  IF r.value_inc_gst IS DISTINCT FROM 4776.75 OR r.value_source <> 'quote_revision' THEN
    RAISE EXCEPTION 'd1 row 3 revision value: got % %', r.value_inc_gst, r.value_source;
  END IF;
  IF r.whole_quote_total_inc IS NOT NULL OR r.whole_quote_source IS NOT NULL THEN
    RAISE EXCEPTION 'd1 row 3 whole-job total only for run sends: got % %', r.whole_quote_total_inc, r.whole_quote_source;
  END IF;

  -- Row 6: superseded v1 keeps its sealed value; v2 from the send-quote log only.
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-0439';
  IF r.value_inc_gst IS DISTINCT FROM 5000 OR r.value_source <> 'quote_revision' THEN
    RAISE EXCEPTION 'd1 row 6 superseded v1: got % %', r.value_inc_gst, r.value_source;
  END IF;
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-0491';
  IF r.value_inc_gst IS DISTINCT FROM 5300 OR r.value_source <> 'quote_sent_log_unverified' THEN
    RAISE EXCEPTION 'd1 row 6 forged or wrong log used for Q-0491: got % %', r.value_inc_gst, r.value_source;
  END IF;
  -- Row 6: the run document is the owner's share, never the send-runs revision total.
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-0502';
  IF r.value_inc_gst IS DISTINCT FROM 4842.45 OR r.value_source <> 'run_snapshot_share' OR r.party_is_owner IS NOT TRUE THEN
    RAISE EXCEPTION 'd1 run doc uses own share (row 6 REAR): got % % owner=%', r.value_inc_gst, r.value_source, r.party_is_owner;
  END IF;
  IF r.whole_quote_total_inc IS DISTINCT FROM 9684.90 OR r.whole_quote_source <> 'quote_revision' THEN
    RAISE EXCEPTION 'd1 row 6 whole-job total: got % %', r.whole_quote_total_inc, r.whole_quote_source;
  END IF;
  SELECT count(*) INTO n FROM d1_out WHERE quote_number = 'Q-0550';
  IF n <> 0 THEN RAISE EXCEPTION 'd1 row 6 unsent draft returned as a sent quote'; END IF;
  SELECT count(*) INTO n FROM d1_out WHERE job_number = 'D1-ROW6-SWF-26818';
  IF n <> 3 THEN RAISE EXCEPTION 'd1 row 6 expected 3 sent documents, got %', n; END IF;
  SELECT count(DISTINCT whole_quote_total_inc) INTO n FROM d1_out WHERE job_number = 'D1-ROW6-SWF-26818';
  IF n <> 1 THEN RAISE EXCEPTION 'd1 row 6 whole-job total must be one job-level value on every row'; END IF;

  -- Row 7: accepted, no sealed record: value null with the reason.
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-0738';
  IF r.value_inc_gst IS NOT NULL OR r.value_source <> 'not recorded on the sent quote' THEN
    RAISE EXCEPTION 'd1 row 7 unrecorded value: got % %', r.value_inc_gst, r.value_source;
  END IF;

  -- Row 10: nothing sent from our systems.
  SELECT count(*) INTO n FROM public.job_quote_values('d1000000-0000-4000-8000-000000000010');
  IF n <> 0 THEN RAISE EXCEPTION 'd1 row 10 an unsent draft is not a quote: got % rows', n; END IF;

  -- Row 14: each party's own share; owner client share, neighbours neighbour share.
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-1401';
  IF r.value_inc_gst IS DISTINCT FROM 4023.00 OR r.value_source <> 'run_snapshot_share' THEN
    RAISE EXCEPTION 'd1 run doc uses own share (row 14 owner): got % %', r.value_inc_gst, r.value_source;
  END IF;
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-1402';
  IF r.value_inc_gst IS DISTINCT FROM 3710.00 OR r.party_is_owner IS NOT FALSE THEN
    RAISE EXCEPTION 'd1 run doc uses own share (row 14 neighbour A): got % owner=%', r.value_inc_gst, r.party_is_owner;
  END IF;
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-1403';
  IF r.value_inc_gst IS DISTINCT FROM 1731.00 THEN
    RAISE EXCEPTION 'd1 row 14 neighbour B share stored as text: got %', r.value_inc_gst;
  END IF;
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-1404';
  IF r.value_inc_gst IS NOT NULL OR r.value_source <> 'party not recorded on this run quote' THEN
    RAISE EXCEPTION 'd1 row 14 run doc without a party: got % %', r.value_inc_gst, r.value_source;
  END IF;
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-1405';
  IF r.value_inc_gst IS NOT NULL OR r.value_source <> 'share not recorded on this run quote' THEN
    RAISE EXCEPTION 'd1 row 14 run doc without a share: got % %', r.value_inc_gst, r.value_source;
  END IF;
  SELECT count(*) INTO n FROM d1_out WHERE job_number = 'D1-ROW14-SWF-26904' AND value_inc_gst = 12195.00;
  IF n <> 0 THEN RAISE EXCEPTION 'd1 run doc uses own share (row 14): a document carries the whole-job total'; END IF;
  SELECT count(*) INTO n FROM d1_out WHERE job_number = 'D1-ROW14-SWF-26904'
    AND whole_quote_total_inc = 12195.00 AND whole_quote_source = 'quote_revision';
  IF n <> 5 THEN RAISE EXCEPTION 'd1 row 14 whole-job total at job level on every row: % of 5', n; END IF;

  -- Row 15: three parties, each own share; whole total from the send-runs log,
  -- skipping the newer row whose total is not a number.
  SELECT count(*) INTO n FROM d1_out WHERE job_number = 'D1-ROW15-SWF-26395' AND value_source = 'run_snapshot_share';
  IF n <> 3 THEN RAISE EXCEPTION 'd1 row 15 three party shares expected, got %', n; END IF;
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-0206';
  IF r.value_inc_gst IS DISTINCT FROM 2552.00 THEN RAISE EXCEPTION 'd1 row 15 owner share: got %', r.value_inc_gst; END IF;
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-0208';
  IF r.value_inc_gst IS DISTINCT FROM 1276.00 THEN RAISE EXCEPTION 'd1 row 15 neighbour B share: got %', r.value_inc_gst; END IF;
  IF r.whole_quote_total_inc IS DISTINCT FROM 5104.00 OR r.whole_quote_source <> 'quote_sent_log_unverified' THEN
    RAISE EXCEPTION 'd1 row 15 whole-job total from the send-runs log: got % %', r.whole_quote_total_inc, r.whole_quote_source;
  END IF;
END $$;

-- The service role can call it; the public and signed-in roles cannot.
SET LOCAL ROLE service_role;
SELECT count(*) AS d1_service_role_rows FROM public.job_quote_values('d1000000-0000-4000-8000-000000000006');
RESET ROLE;

DO $$
BEGIN
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM public.job_quote_values('d1000000-0000-4000-8000-000000000006');
    RESET ROLE;
    RAISE EXCEPTION 'd1 grants: anon executed job_quote_values';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;
END $$;

ROLLBACK;
