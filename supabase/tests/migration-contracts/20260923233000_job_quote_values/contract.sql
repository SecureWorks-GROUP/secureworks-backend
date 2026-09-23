-- Contract for 20260923233000_job_quote_values (context D1, dossier section 4).
--
-- Named-row fixtures are the LIVE shapes read from production on 23 Sep 2026
-- (read-only request d1-prod-read; job numbers are the design's row labels,
-- ids are synthetic, no customer data): which documents exist, their run
-- labels, parties, send/accept/supersede state, revision totals and quote.sent
-- rows (every live quote.sent row has source 'send-quote/send'; none of these
-- jobs has a run_acceptances row). Two synthetic "send-runs shape" jobs cover
-- the run-document rules no named row exercises live, and adversarial rows
-- (forged source, another job's row, malformed money) prove what is ignored.
-- Everything rolls back.

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

INSERT INTO public.jobs (id, org_id, status, type, job_number) VALUES
  ('d1000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'quoted',    'fencing', 'D1-ROW3-SWF-261458'),
  ('d1000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', 'archived',  'fencing', 'D1-ROW6-SWF-26818'),
  ('d1000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000001', 'accepted',  'fencing', 'D1-ROW7-SWF-261355'),
  ('d1000000-0000-4000-8000-000000000010', '00000000-0000-0000-0000-000000000001', 'draft',     'patio',   'D1-ROW10-SWP-261456'),
  ('d1000000-0000-4000-8000-000000000014', '00000000-0000-0000-0000-000000000001', 'invoiced',  'fencing', 'D1-ROW14-SWF-26904'),
  ('d1000000-0000-4000-8000-000000000015', '00000000-0000-0000-0000-000000000001', 'partially_accepted', 'fencing', 'D1-ROW15-SWF-26395'),
  ('d1000000-0000-4000-8000-000000000024', '00000000-0000-0000-0000-000000000001', 'approvals', 'patio',   'D1-ROW24-SWP-261203'),
  ('d1000000-0000-4000-8000-000000000901', '00000000-0000-0000-0000-000000000001', 'quoted',    'fencing', 'D1-RUNS-SHAPE-A'),
  ('d1000000-0000-4000-8000-000000000902', '00000000-0000-0000-0000-000000000001', 'quoted',    'fencing', 'D1-RUNS-SHAPE-B');

-- Parties (owner = is_primary until sites S-M1 adds party_role).
INSERT INTO public.job_contacts (id, job_id, is_primary, client_email) VALUES
  ('d1c00000-0000-4000-8000-000000000141', 'd1000000-0000-4000-8000-000000000014', true,  'party-a14@example.test'),
  ('d1c00000-0000-4000-8000-000000000142', 'd1000000-0000-4000-8000-000000000014', false, 'party-b14@example.test'),
  ('d1c00000-0000-4000-8000-000000000143', 'd1000000-0000-4000-8000-000000000014', false, 'party-c14@example.test'),
  ('d1c00000-0000-4000-8000-000000000151', 'd1000000-0000-4000-8000-000000000015', true,  'party-a15@example.test'),
  ('d1c00000-0000-4000-8000-000000000152', 'd1000000-0000-4000-8000-000000000015', false, 'party-b15@example.test'),
  ('d1c00000-0000-4000-8000-000000000153', 'd1000000-0000-4000-8000-000000000015', false, 'party-c15@example.test'),
  ('d1c00000-0000-4000-8000-000000009011', 'd1000000-0000-4000-8000-000000000901', true,  'owner-a@example.test'),
  ('d1c00000-0000-4000-8000-000000009012', 'd1000000-0000-4000-8000-000000000901', false, 'neighbour-a@example.test'),
  ('d1c00000-0000-4000-8000-000000009013', 'd1000000-0000-4000-8000-000000000901', false, 'neighbour-a2@example.test');

-- Row 3 (SWF-261458, live): Q-0789, one whole quote, revision $4,776.75 and
-- its send-quote/send row.
INSERT INTO public.job_documents (id, job_id, type, version, quote_number, sent_at, viewed_at, created_at) VALUES
  ('d1d00000-0000-4000-8000-000000000031', 'd1000000-0000-4000-8000-000000000003', 'quote', 1, 'Q-0789',
   '2026-09-23T01:27:38Z', '2026-09-23T02:00:00Z', '2026-09-23T01:20:00Z');
INSERT INTO public.quote_revisions (id, job_id, job_document_id, version, recipient_email, totals_snapshot_json, released_via, sent_at) VALUES
  ('d1e00000-0000-4000-8000-000000000031', 'd1000000-0000-4000-8000-000000000003', 'd1d00000-0000-4000-8000-000000000031', 1, 'row3@example.test',
   '{"total_inc_gst": 4776.75}', 'send-quote/send', '2026-09-23T01:27:38Z');

-- Row 6 (SWF-26818, live): Q-0439 v1 superseded (revision $5,571.50); Q-0491
-- v2 current with no revision and no quote.sent row; the REAR run document has
-- NO party (the client's document; neighbour share 0) and a $4,842.45 client
-- share. Adversarial: a forged row from a public source and a send-quote row
-- that belongs to another job, both naming Q-0491, must not give it a value.
INSERT INTO public.job_documents (id, job_id, type, version, quote_number, run_label, job_contact_id, data_snapshot_json, sent_at, superseded_at, created_at) VALUES
  ('d1d00000-0000-4000-8000-000000000061', 'd1000000-0000-4000-8000-000000000006', 'quote', 1, 'Q-0439', NULL, NULL, NULL,
   '2026-06-25T12:15:36Z', '2026-07-05T00:00:00Z', '2026-06-25T12:00:00Z'),
  ('d1d00000-0000-4000-8000-000000000062', 'd1000000-0000-4000-8000-000000000006', 'quote', 2, 'Q-0491', NULL, NULL, NULL,
   '2026-07-05T01:00:00Z', NULL, '2026-07-05T00:30:00Z'),
  ('d1d00000-0000-4000-8000-000000000063', 'd1000000-0000-4000-8000-000000000006', 'quote', 1, NULL, 'REAR', NULL,
   '{"run": {"run_label": "REAR", "totals": {"client_share_inc": 4842.45, "neighbour_share_inc": 0}}}',
   '2026-07-06T01:00:00Z', NULL, '2026-07-06T00:30:00Z');
INSERT INTO public.quote_revisions (id, job_id, job_document_id, version, recipient_email, totals_snapshot_json, released_via, sent_at) VALUES
  ('d1e00000-0000-4000-8000-000000000061', 'd1000000-0000-4000-8000-000000000006', 'd1d00000-0000-4000-8000-000000000061', 1, 'row6@example.test',
   '{"total_inc_gst": 5571.5}', 'send-quote/send', '2026-06-25T12:15:36Z');
INSERT INTO public.business_events (job_id, entity_type, entity_id, event_type, source, payload, metadata, occurred_at) VALUES
  ('d1000000-0000-4000-8000-000000000006', 'job', 'd1000000-0000-4000-8000-000000000006', 'quote.sent', 'send-quote/send',
   '{"document_id": "d1d00000-0000-4000-8000-000000000061", "total_inc_gst": 5571.5}', '{"handler": "send-quote/send"}', '2026-06-25T12:15:36Z'),
  ('d1000000-0000-4000-8000-000000000006', 'job', 'd1000000-0000-4000-8000-000000000006', 'quote.sent', 'website_form',
   '{"document_id": "d1d00000-0000-4000-8000-000000000062", "total_inc_gst": 99999}', '{}', '2026-07-06T02:00:00Z'),
  (NULL, 'job', 'd1000000-0000-4000-8000-000000000003', 'quote.sent', 'send-quote/send',
   '{"document_id": "d1d00000-0000-4000-8000-000000000062", "total_inc_gst": 88888}', '{"handler": "send-quote/send"}', '2026-07-06T03:00:00Z');

-- Row 7 (SWF-261355, live): Q-0738 accepted, no revision, no quote.sent row.
INSERT INTO public.job_documents (id, job_id, type, version, quote_number, sent_at, viewed_at, accepted_at, created_at) VALUES
  ('d1d00000-0000-4000-8000-000000000071', 'd1000000-0000-4000-8000-000000000007', 'quote', 1, 'Q-0738',
   '2026-09-01T02:00:00Z', '2026-09-01T03:00:00Z', '2026-09-22T02:00:00Z', '2026-09-01T01:00:00Z');

-- Row 10 (SWP-261456, live): no quote document at all (emailed from Outlook).

-- Row 14 (SWF-26904, live): three parties recorded, but ONE whole quote,
-- Q-0481, with no party, revision $7,733 (the quote the owner received).
INSERT INTO public.job_documents (id, job_id, type, version, quote_number, sent_at, created_at) VALUES
  ('d1d00000-0000-4000-8000-000000000141', 'd1000000-0000-4000-8000-000000000014', 'quote', 1, 'Q-0481',
   '2026-07-02T14:12:05Z', '2026-07-02T14:00:00Z');
INSERT INTO public.quote_revisions (id, job_id, job_document_id, version, recipient_email, totals_snapshot_json, released_via, sent_at) VALUES
  ('d1e00000-0000-4000-8000-000000000141', 'd1000000-0000-4000-8000-000000000014', 'd1d00000-0000-4000-8000-000000000141', 1, 'party-a14@example.test',
   '{"total_inc_gst": 7733}', 'send-quote/send', '2026-07-02T14:12:05Z');

-- Row 15 (SWF-26395, live): per-party whole quotes Q-0206 (owner, accepted),
-- Q-0207 (party B, accepted), Q-0208 (party C, never accepted). Only the
-- owner's has a revision and a quote.sent row, both $5,104: the whole job
-- (the owner's half is $2,552), not the owner's quote.
INSERT INTO public.job_documents (id, job_id, type, version, quote_number, job_contact_id, sent_at, viewed_at, accepted_at, created_at) VALUES
  ('d1d00000-0000-4000-8000-000000000151', 'd1000000-0000-4000-8000-000000000015', 'quote', 1, 'Q-0206', 'd1c00000-0000-4000-8000-000000000151',
   '2026-06-02T23:59:01Z', '2026-06-03T01:00:00Z', '2026-07-02T01:00:00Z', '2026-06-02T23:00:00Z'),
  ('d1d00000-0000-4000-8000-000000000152', 'd1000000-0000-4000-8000-000000000015', 'quote', 2, 'Q-0207', 'd1c00000-0000-4000-8000-000000000152',
   '2026-06-02T23:59:02Z', '2026-06-03T01:00:00Z', '2026-08-19T01:00:00Z', '2026-06-02T23:00:01Z'),
  ('d1d00000-0000-4000-8000-000000000153', 'd1000000-0000-4000-8000-000000000015', 'quote', 3, 'Q-0208', 'd1c00000-0000-4000-8000-000000000153',
   '2026-06-02T23:59:03Z', '2026-06-03T01:00:00Z', NULL, '2026-06-02T23:00:02Z');
INSERT INTO public.quote_revisions (id, job_id, job_document_id, version, recipient_email, totals_snapshot_json, released_via, sent_at) VALUES
  ('d1e00000-0000-4000-8000-000000000151', 'd1000000-0000-4000-8000-000000000015', 'd1d00000-0000-4000-8000-000000000151', 1, 'party-a15@example.test',
   '{"total_inc_gst": 5104}', 'send-quote/send', '2026-06-02T23:59:01Z');
INSERT INTO public.business_events (job_id, entity_type, entity_id, event_type, source, payload, metadata, occurred_at) VALUES
  (NULL, 'job', 'd1000000-0000-4000-8000-000000000015', 'quote.sent', 'send-quote/send',
   '{"document_id": "d1d00000-0000-4000-8000-000000000151", "total_inc_gst": 5104}', '{"handler": "send-quote/send"}', '2026-06-02T23:59:01Z');

-- Row 24 (SWP-261203, live): one quote document never sent.
INSERT INTO public.job_documents (id, job_id, type, version, sent_at, created_at) VALUES
  ('d1d00000-0000-4000-8000-000000000241', 'd1000000-0000-4000-8000-000000000024', 'quote', 1, NULL, '2026-08-18T08:00:00Z');

-- Send-runs shape A (synthetic; no named row has live run parties): owner and
-- two neighbours on runs; send-runs bound its whole-job revision ($12,195) to
-- the owner's run document; a neighbour's share stored as text; a run
-- document whose snapshot lost its totals.
INSERT INTO public.job_documents (id, job_id, type, version, quote_number, run_label, job_contact_id, data_snapshot_json, sent_at, created_at) VALUES
  ('d1d00000-0000-4000-8000-000000009011', 'd1000000-0000-4000-8000-000000000901', 'quote', 1, 'Q-9011', 'REAR', 'd1c00000-0000-4000-8000-000000009011',
   '{"run": {"totals": {"client_share_inc": 4023.00, "neighbour_share_inc": 3710.00}}}', '2026-08-01T02:00:00Z', '2026-08-01T01:00:00Z'),
  ('d1d00000-0000-4000-8000-000000009012', 'd1000000-0000-4000-8000-000000000901', 'quote', 1, 'Q-9012', 'REAR', 'd1c00000-0000-4000-8000-000000009012',
   '{"run": {"totals": {"client_share_inc": 4023.00, "neighbour_share_inc": 3710.00}}}', '2026-08-01T02:00:00Z', '2026-08-01T01:00:01Z'),
  ('d1d00000-0000-4000-8000-000000009013', 'd1000000-0000-4000-8000-000000000901', 'quote', 1, 'Q-9013', 'LHS', 'd1c00000-0000-4000-8000-000000009013',
   '{"run": {"totals": {"client_share_inc": "1731.00", "neighbour_share_inc": "1731.00"}}}', '2026-08-01T02:00:00Z', '2026-08-01T01:00:02Z'),
  ('d1d00000-0000-4000-8000-000000009014', 'd1000000-0000-4000-8000-000000000901', 'quote', 1, 'Q-9014', 'FRONT', 'd1c00000-0000-4000-8000-000000009012',
   '{"run": {"run_label": "FRONT"}}', '2026-08-01T02:00:00Z', '2026-08-01T01:00:03Z');
INSERT INTO public.quote_revisions (id, job_id, job_document_id, version, recipient_email, totals_snapshot_json, released_via, sent_at) VALUES
  ('d1e00000-0000-4000-8000-000000009011', 'd1000000-0000-4000-8000-000000000901', 'd1d00000-0000-4000-8000-000000009011', 1, 'owner-a@example.test',
   '{"total_inc_gst": 12195.00}', 'send-quote/send-runs', '2026-08-01T02:00:00Z');

-- Send-runs shape B (synthetic): no revision survives, so the whole-job total
-- comes from the send-runs quote.sent row (legacy source 'send-quote' with the
-- send-runs handler), skipping a newer row whose total is not a number.
INSERT INTO public.job_documents (id, job_id, type, version, quote_number, run_label, data_snapshot_json, sent_at, created_at) VALUES
  ('d1d00000-0000-4000-8000-000000009021', 'd1000000-0000-4000-8000-000000000902', 'quote', 1, 'Q-9021', 'REAR',
   '{"run": {"totals": {"client_share_inc": 2552.00, "neighbour_share_inc": 2552.00}}}', '2026-06-01T02:00:00Z', '2026-06-01T01:00:00Z');
INSERT INTO public.business_events (job_id, entity_type, entity_id, event_type, source, payload, metadata, occurred_at) VALUES
  (NULL, 'job', 'd1000000-0000-4000-8000-000000000902', 'quote.sent', 'send-quote',
   '{"document_id": "d1d00000-0000-4000-8000-000000009021", "total_inc_gst": "not a number", "run_count": 1}', '{"handler": "send-quote/send-runs"}', '2026-06-01T02:00:02Z'),
  (NULL, 'job', 'd1000000-0000-4000-8000-000000000902', 'quote.sent', 'send-quote',
   '{"document_id": "d1d00000-0000-4000-8000-000000009021", "total_inc_gst": 5104.00, "run_count": 1}', '{"handler": "send-quote/send-runs"}', '2026-06-01T02:00:01Z');

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
  -- Row 3: sealed revision; a plain whole quote has no separate whole-job total.
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-0789';
  IF r.value_inc_gst IS DISTINCT FROM 4776.75 OR r.value_source <> 'quote_revision' THEN
    RAISE EXCEPTION 'd1 row 3 revision value: got % %', r.value_inc_gst, r.value_source;
  END IF;
  IF r.whole_quote_total_inc IS NOT NULL THEN
    RAISE EXCEPTION 'd1 row 3 whole-job total only when quotes are split by party: got %', r.whole_quote_total_inc;
  END IF;

  -- Row 6: superseded v1 keeps its sealed value; v2 has no record and no forged
  -- or foreign row may give it one; the party-less REAR run document is the
  -- client's and carries the client share.
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-0439';
  IF r.value_inc_gst IS DISTINCT FROM 5571.5 OR r.value_source <> 'quote_revision' THEN
    RAISE EXCEPTION 'd1 row 6 superseded v1: got % %', r.value_inc_gst, r.value_source;
  END IF;
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-0491';
  IF r.value_inc_gst IS NOT NULL OR r.value_source <> 'not recorded on the sent quote' THEN
    RAISE EXCEPTION 'd1 row 6 forged or foreign log used for Q-0491: got % %', r.value_inc_gst, r.value_source;
  END IF;
  SELECT * INTO r FROM d1_out WHERE job_number = 'D1-ROW6-SWF-26818' AND run_label = 'REAR';
  IF r.value_inc_gst IS DISTINCT FROM 4842.45 OR r.value_source <> 'run_snapshot_share' OR r.party_is_owner IS NOT TRUE THEN
    RAISE EXCEPTION 'd1 run doc uses own share (row 6 REAR, no party = client document): got % % owner=%', r.value_inc_gst, r.value_source, r.party_is_owner;
  END IF;
  SELECT count(*) INTO n FROM d1_out WHERE job_number = 'D1-ROW6-SWF-26818';
  IF n <> 3 THEN RAISE EXCEPTION 'd1 row 6 expected 3 sent documents, got %', n; END IF;

  -- Row 7: accepted, no sealed record: value null with the reason.
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-0738';
  IF r.value_inc_gst IS NOT NULL OR r.value_source <> 'not recorded on the sent quote' THEN
    RAISE EXCEPTION 'd1 row 7 unrecorded value: got % %', r.value_inc_gst, r.value_source;
  END IF;

  -- Rows 10 and 24: nothing sent from our systems.
  SELECT count(*) INTO n FROM public.job_quote_values('d1000000-0000-4000-8000-000000000010');
  IF n <> 0 THEN RAISE EXCEPTION 'd1 row 10 no document means no quote: got % rows', n; END IF;
  SELECT count(*) INTO n FROM public.job_quote_values('d1000000-0000-4000-8000-000000000024');
  IF n <> 0 THEN RAISE EXCEPTION 'd1 row 24 an unsent document is not a quote: got % rows', n; END IF;

  -- Row 14: a single whole quote with no party is the whole quote, even
  -- though three parties are recorded on the job.
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-0481';
  IF r.value_inc_gst IS DISTINCT FROM 7733 OR r.value_source <> 'quote_revision' OR r.whole_quote_total_inc IS NOT NULL THEN
    RAISE EXCEPTION 'd1 row 14 single whole quote: got % % whole=%', r.value_inc_gst, r.value_source, r.whole_quote_total_inc;
  END IF;

  -- Row 15: per-party whole quotes never carry the whole-job total as a
  -- party's value; the $5,104 is the job-level whole-quote total.
  SELECT count(*) INTO n FROM d1_out WHERE job_number = 'D1-ROW15-SWF-26395'
    AND value_inc_gst IS NULL AND value_source = 'party share not recorded on this per-party quote';
  IF n <> 3 THEN RAISE EXCEPTION 'd1 per-party quote never shows the whole job (row 15): % of 3', n; END IF;
  SELECT count(*) INTO n FROM d1_out WHERE job_number = 'D1-ROW15-SWF-26395'
    AND whole_quote_total_inc = 5104 AND whole_quote_source = 'quote_revision';
  IF n <> 3 THEN RAISE EXCEPTION 'd1 row 15 whole-job total at job level on every row: % of 3', n; END IF;
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-0206';
  IF r.party_is_owner IS NOT TRUE THEN RAISE EXCEPTION 'd1 row 15 owner party not detected'; END IF;
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-0208';
  IF r.party_is_owner IS NOT FALSE THEN RAISE EXCEPTION 'd1 row 15 party C read as owner'; END IF;

  -- Send-runs shape A: each party's own share; no document carries the
  -- whole-job total bound to the owner's run document.
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-9011';
  IF r.value_inc_gst IS DISTINCT FROM 4023.00 OR r.value_source <> 'run_snapshot_share' THEN
    RAISE EXCEPTION 'd1 run doc uses own share (owner): got % %', r.value_inc_gst, r.value_source;
  END IF;
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-9012';
  IF r.value_inc_gst IS DISTINCT FROM 3710.00 OR r.party_is_owner IS NOT FALSE THEN
    RAISE EXCEPTION 'd1 run doc uses own share (neighbour): got % owner=%', r.value_inc_gst, r.party_is_owner;
  END IF;
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-9013';
  IF r.value_inc_gst IS DISTINCT FROM 1731.00 THEN
    RAISE EXCEPTION 'd1 neighbour share stored as text: got %', r.value_inc_gst;
  END IF;
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-9014';
  IF r.value_inc_gst IS NOT NULL OR r.value_source <> 'share not recorded on this run quote' THEN
    RAISE EXCEPTION 'd1 run doc without a share: got % %', r.value_inc_gst, r.value_source;
  END IF;
  SELECT count(*) INTO n FROM d1_out WHERE job_number = 'D1-RUNS-SHAPE-A' AND value_inc_gst = 12195.00;
  IF n <> 0 THEN RAISE EXCEPTION 'd1 run doc uses own share: a document carries the whole-job total'; END IF;
  SELECT count(*) INTO n FROM d1_out WHERE job_number = 'D1-RUNS-SHAPE-A'
    AND whole_quote_total_inc = 12195.00 AND whole_quote_source = 'quote_revision';
  IF n <> 4 THEN RAISE EXCEPTION 'd1 run send whole-job total at job level on every row: % of 4', n; END IF;

  -- Send-runs shape B: whole total from the send-runs log, malformed row skipped.
  SELECT * INTO r FROM d1_out WHERE quote_number = 'Q-9021';
  IF r.value_inc_gst IS DISTINCT FROM 2552.00 THEN RAISE EXCEPTION 'd1 shape B client share: got %', r.value_inc_gst; END IF;
  IF r.whole_quote_total_inc IS DISTINCT FROM 5104.00 OR r.whole_quote_source <> 'quote_sent_log_unverified' THEN
    RAISE EXCEPTION 'd1 shape B whole-job total from the send-runs log: got % %', r.whole_quote_total_inc, r.whole_quote_source;
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
