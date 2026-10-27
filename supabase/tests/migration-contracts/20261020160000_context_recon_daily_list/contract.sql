-- Contract for 20261020160000_context_recon_daily_list. Proves the invoice subject, its writer
-- and the ranked daily list against the real stacked schema. Every fixture write is rolled back.
\set ON_ERROR_STOP 1

-- 1. Shape: invoice subjects are accepted, and no browser role can call the new functions.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'context_reconciliation_decisions_subject_kind_check'
                 AND pg_get_constraintdef(oid) LIKE '%invoice%') THEN
    RAISE EXCEPTION 'recon list contract: the store does not take invoice subjects';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND (has_function_privilege('authenticated', 'public.context_recon_daily_list(timestamptz,int)', 'EXECUTE')
          OR has_function_privilege('anon', 'public.context_recon_record_invoice_decision(uuid,text,text,uuid[],text,uuid,text)', 'EXECUTE')
          OR has_function_privilege('authenticated', 'public.context_recon_invoice_evidence_hash(uuid)', 'EXECUTE')
          OR has_function_privilege('authenticated', 'public.context_recon_daily_rows(timestamptz)', 'EXECUTE')
          OR has_function_privilege('anon', 'public.context_recon_daily_left_out(timestamptz)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'recon list contract: a browser role holds a grant';
  END IF;
END $$;

BEGIN;
INSERT INTO public.jobs (id, org_id, type, status, job_number, ghl_contact_id, xero_contact_id, created_at) VALUES
  ('7d000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'SWF-98001', 'recon-list-1', 'recon-xc-1', '2026-09-01'),
  ('7d000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000001', 'patio', 'accepted', 'SWP-98002', 'recon-list-2', 'recon-xc-2', '2026-09-01'),
  ('7d000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000001', 'fencing', 'archived', 'SWF-98003', 'recon-list-3', NULL, '2026-01-01');
INSERT INTO public.users (id, org_id, name, role) VALUES
  ('7d100000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'List staff', 'ops_manager'),
  ('7d100000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'List trade', 'lead_installer');
INSERT INTO public.xero_invoices (id, org_id, xero_invoice_id, invoice_number, invoice_type, status, total, amount_due, amount_paid,
                                  invoice_date, job_id, xero_contact_id, reference, contact_name) VALUES
  -- owed, on no job: band 1
  ('7d200000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'recon-x-1', 'INV-98001', 'ACCREC', 'AUTHORISED', 1500, 1500, 0,
   '2026-10-01', NULL, 'recon-xc-1', 'Fence deposit', 'Contract client one'),
  -- owed on job A: contact 1 owes, so its messages are band 2
  ('7d200000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'recon-x-2', 'INV-98002', 'ACCREC', 'AUTHORISED', 900, 900, 0,
   '2026-10-02', '7d000000-0000-0000-0000-00000000000a', 'recon-xc-1', 'SWF-98001', 'Contract client one'),
  -- voided with no job: never listed
  ('7d200000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'recon-x-3', 'INV-98003', 'ACCREC', 'VOIDED', 700, 700, 0,
   '2026-10-03', NULL, 'recon-xc-2', 'Void', 'Contract client two');
INSERT INTO public.business_events (id, channel, direction, occurred_at, contact_id, payload, event_type, source) VALUES
  ('7d300000-0000-0000-0000-000000000001', 'sms', 'inbound', '2026-10-18 01:00Z', 'recon-list-1', '{"body":"About my fence"}', 'sms.inbound', 'recon-list'),
  ('7d300000-0000-0000-0000-000000000002', 'sms', 'inbound', '2026-10-17 01:00Z', 'recon-list-2', '{"body":"Patio start date?"}', 'sms.inbound', 'recon-list'),
  ('7d300000-0000-0000-0000-000000000003', 'sms', 'inbound', '2026-10-17 01:00Z', 'recon-list-3', '{"body":"Old job"}', 'sms.inbound', 'recon-list'),
  ('7d300000-0000-0000-0000-000000000004', 'sms', 'inbound', '2026-10-17 01:00Z', NULL, '{"body":"Who is this"}', 'sms.inbound', 'recon-list'),
  -- a call transcript from the live-job customer: listed, but its words must never reach the list
  ('7d300000-0000-0000-0000-000000000005', 'call', 'inbound', '2026-10-16 01:00Z', 'recon-list-2',
   '{"body":"RECONCALLWORD body","body_preview":"RECONCALLWORD preview","text":"RECONCALLWORD text","transcript":"RECONCALLWORD"}',
   'call.transcript_completed', 'recon-list');
UPDATE public.business_events SET job_id = NULL, attribution_status = 'unplaced', attribution_checked_at = '2026-10-19 00:00Z',
  context_captured_at = occurred_at
WHERE source = 'recon-list';

DO $$
DECLARE asof timestamptz := '2026-10-20 00:00Z'; inv uuid := '7d200000-0000-0000-0000-000000000001';
  a uuid := '7d000000-0000-0000-0000-00000000000a'; staff uuid := '7d100000-0000-0000-0000-000000000001';
  h text; r record; n int; lo jsonb;
BEGIN
  -- 2. Ranking: the owed invoice first, then the owing contact's message, then the live-job message.
  SELECT count(*) INTO n FROM public.context_recon_daily_list(asof) WHERE subject_id IN
    ('7d200000-0000-0000-0000-000000000003', '7d300000-0000-0000-0000-000000000003', '7d300000-0000-0000-0000-000000000004');
  IF n <> 0 THEN RAISE EXCEPTION 'recon list contract: a voided invoice, a closed-job message or a defect row was listed'; END IF;
  SELECT * INTO r FROM public.context_recon_daily_list(asof) WHERE subject_id = inv;
  IF r.band IS DISTINCT FROM 1 OR r.amount IS DISTINCT FROM 1500::numeric OR r.summary ->> 'invoice_number' IS DISTINCT FROM 'INV-98001'
     OR r.offered_jobs -> 0 ->> 'job_number' IS DISTINCT FROM 'SWF-98001'
     OR r.decision_state IS DISTINCT FROM 'none' OR r.owner IS DISTINCT FROM 'context_resolver'
     OR r.summary ? 'counterpart_role' THEN
    RAISE EXCEPTION 'recon list contract: the owed invoice is not band 1 with its contact''s job offered';
  END IF;
  SELECT * INTO r FROM public.context_recon_daily_list(asof) WHERE subject_id = '7d300000-0000-0000-0000-000000000001';
  IF r.band IS DISTINCT FROM 2 OR r.amount IS DISTINCT FROM 900::numeric OR r.other_jobs -> 0 ->> 'job_number' IS DISTINCT FROM 'SWF-98001' THEN
    RAISE EXCEPTION 'recon list contract: the owing contact''s message is not band 2';
  END IF;
  SELECT * INTO r FROM public.context_recon_daily_list(asof) WHERE subject_id = '7d300000-0000-0000-0000-000000000002';
  IF r.band IS DISTINCT FROM 3 OR r.summary ->> 'preview' IS DISTINCT FROM 'Patio start date?'
     OR r.evidence_hash IS DISTINCT FROM public.context_recon_evidence_hash('7d300000-0000-0000-0000-000000000002') THEN
    RAISE EXCEPTION 'recon list contract: the live-job customer message is not band 3 with its hash';
  END IF;
  SELECT * INTO r FROM public.context_recon_daily_list(asof) WHERE subject_id = '7d300000-0000-0000-0000-000000000005';
  IF r.band IS DISTINCT FROM 3 OR r.summary ->> 'channel' IS DISTINCT FROM 'call' OR r.summary ->> 'preview' IS NOT NULL
     OR r.summary::text LIKE '%RECONCALLWORD%' THEN
    RAISE EXCEPTION 'recon list contract: a call transcript is not band 3, or its words reached the list';
  END IF;
  -- Message summary shape: the party-roles stamp rides every message row, and a
  -- customer stamp is the word customer, so the screen says Customer and never
  -- "Sender not known". Invoice summaries stay money fields (asserted above).
  SELECT count(*) INTO n FROM public.context_recon_daily_list(asof) WHERE subject_kind = 'event';
  IF n <> 3 THEN RAISE EXCEPTION 'recon list contract: expected 3 message rows, got %', n; END IF;
  FOR r IN SELECT * FROM public.context_recon_daily_list(asof) WHERE subject_kind = 'event' LOOP
    IF (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(r.summary) k)
       IS DISTINCT FROM ARRAY['channel','counterpart_role','direction','from','occurred_at','preview','subject']::text[] THEN
      RAISE EXCEPTION 'recon list contract: message summary keys for % are %', r.subject_id, r.summary;
    END IF;
    IF r.summary ->> 'counterpart_role' IS DISTINCT FROM 'customer'
       OR r.summary::text LIKE '%Sender not known%'
       OR r.summary ->> 'counterpart_role' IS DISTINCT FROM (
            SELECT e.metadata -> 'party_roles' ->> 'counterpart_role'
            FROM public.business_events e WHERE e.id = r.subject_id) THEN
      RAISE EXCEPTION 'recon list contract: customer message % is not labelled customer (role %)',
        r.subject_id, r.summary ->> 'counterpart_role';
    END IF;
  END LOOP;
  SELECT * INTO r FROM public.context_recon_daily_list(asof) WHERE subject_id = '7d300000-0000-0000-0000-000000000002';
  IF r.summary ->> 'occurred_at' IS DISTINCT FROM '2026-10-17T01:00:00Z'
     OR r.summary -> 'from' IS DISTINCT FROM 'null'::jsonb
     OR r.summary -> 'subject' IS DISTINCT FROM 'null'::jsonb
     OR r.summary ->> 'preview' IS DISTINCT FROM 'Patio start date?'
     OR r.summary ->> 'channel' IS DISTINCT FROM 'sms'
     OR r.summary ->> 'direction' IS DISTINCT FROM 'inbound'
     OR r.summary ->> 'counterpart_role' IS DISTINCT FROM 'customer' THEN
    RAISE EXCEPTION 'recon list contract: band 3 message summary shape is %', r.summary;
  END IF;
  -- 2b. What the list leaves out is counted, never hidden: the no-contact message is a
  --     no-identity row, every count is a whole number, and nothing listed is counted as left out.
  SELECT public.context_recon_daily_left_out(asof) INTO lo;
  IF lo IS NULL OR NOT (lo ?& ARRAY['no_identity', 'never_asked', 'not_ranked', 'backlog'])
     OR (lo ->> 'no_identity')::int < 1 OR (lo ->> 'never_asked')::int < 0
     OR (lo ->> 'not_ranked')::int < 0 OR (lo ->> 'backlog')::int < 0 THEN
    RAISE EXCEPTION 'recon list contract: the left-out counts are missing or wrong: %', lo;
  END IF;
  SELECT count(*) INTO n FROM public.context_recon_queue(asof) q
  WHERE q.lane = 'live' AND q.cause LIKE 'ambiguity:%';
  IF (lo ->> 'not_ranked')::int + (SELECT count(*) FROM public.context_recon_daily_rows(asof) d
        JOIN public.context_recon_queue(asof) q ON q.event_id = d.subject_id
        WHERE d.subject_kind = 'event' AND q.lane = 'live' AND q.cause LIKE 'ambiguity:%') <> n THEN
    RAISE EXCEPTION 'recon list contract: listed and not-ranked rows do not add up to the live ambiguity rows';
  END IF;
  -- The list is cut at the asked limit, so ops-api can ask one more and say more.
  SELECT count(*) INTO n FROM public.context_recon_daily_list(asof, 2);
  IF n <> 2 THEN RAISE EXCEPTION 'recon list contract: p_limit 2 returned % rows', n; END IF;
  SELECT count(*) INTO n FROM public.context_recon_daily_list(asof, 500);
  IF n < 4 OR n > 201 THEN RAISE EXCEPTION 'recon list contract: p_limit 500 returned % rows', n; END IF;

  -- 3. The invoice writer refuses a non-staff person, a stale hash, confirm and split.
  h := public.context_recon_invoice_evidence_hash(inv);
  BEGIN PERFORM public.context_recon_record_invoice_decision(inv, h, 'correct', ARRAY[a], 'ambiguity:invoice_no_job', '7d100000-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'recon list contract: trade recorded an invoice decision'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.context_recon_record_invoice_decision(inv, md5('x'), 'correct', ARRAY[a], 'ambiguity:invoice_no_job', staff);
    RAISE EXCEPTION 'recon list contract: a stale hash was accepted'; EXCEPTION WHEN serialization_failure THEN NULL; END;
  BEGIN PERFORM public.context_recon_record_invoice_decision(inv, h, 'confirm', ARRAY[a], 'ambiguity:invoice_no_job', staff);
    RAISE EXCEPTION 'recon list contract: confirm was accepted on an invoice'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

  -- 4. Escalate keeps it listed with its owner; correct keeps it listed with Finance, names the
  --    chosen job and writes no invoice.
  PERFORM public.context_recon_record_invoice_decision(inv, h, 'escalate', '{}', 'ambiguity:invoice_no_job', staff, 'finance');
  SELECT * INTO r FROM public.context_recon_daily_list(asof) WHERE subject_id = inv;
  IF r.owner IS DISTINCT FROM 'finance' OR r.last_action IS DISTINCT FROM 'escalate' THEN
    RAISE EXCEPTION 'recon list contract: an escalated invoice left the list or lost its owner';
  END IF;
  PERFORM public.context_recon_record_invoice_decision(inv, h, 'correct', ARRAY[a], 'ambiguity:invoice_no_job', staff);
  SELECT * INTO r FROM public.context_recon_daily_list(asof) WHERE subject_id = inv;
  IF r.subject_id IS NULL OR r.owner IS DISTINCT FROM 'finance' OR r.last_action IS DISTINCT FROM 'correct'
     OR r.decision_state IS DISTINCT FROM 'decided'
     OR r.summary -> 'decided_jobs' -> 0 ->> 'job_number' IS DISTINCT FROM 'SWF-98001' THEN
    RAISE EXCEPTION 'recon list contract: a corrected invoice left the list or is not with Finance naming its job';
  END IF;
  IF (SELECT job_id FROM public.xero_invoices WHERE id = inv) IS NOT NULL THEN
    RAISE EXCEPTION 'recon list contract: the decision wrote the invoice';
  END IF;
  IF (SELECT by FROM public.context_reconciliation_decisions WHERE subject_kind = 'invoice' AND subject_id = inv ORDER BY id DESC LIMIT 1)
     IS DISTINCT FROM 'person:' || staff THEN
    RAISE EXCEPTION 'recon list contract: by is not the person';
  END IF;

  -- 5. A part payment keeps the decision (still with Finance); a changed total reopens it.
  UPDATE public.xero_invoices SET amount_due = 500, amount_paid = 1000 WHERE id = inv;
  SELECT * INTO r FROM public.context_recon_daily_list(asof) WHERE subject_id = inv;
  IF r.decision_state IS DISTINCT FROM 'decided' OR r.owner IS DISTINCT FROM 'finance' THEN
    RAISE EXCEPTION 'recon list contract: a part payment reopened the decision or dropped it';
  END IF;
  UPDATE public.xero_invoices SET total = 1600, amount_due = 600 WHERE id = inv;
  SELECT * INTO r FROM public.context_recon_daily_list(asof) WHERE subject_id = inv;
  IF r.decision_state IS DISTINCT FROM 'evidence_changed' THEN
    RAISE EXCEPTION 'recon list contract: a changed total did not reopen the decision';
  END IF;
  -- An unrelated decision also stays with Finance.
  PERFORM public.context_recon_record_invoice_decision(inv, public.context_recon_invoice_evidence_hash(inv), 'unrelated', '{}',
    'ambiguity:invoice_no_job', staff);
  SELECT * INTO r FROM public.context_recon_daily_list(asof) WHERE subject_id = inv;
  IF r.owner IS DISTINCT FROM 'finance' OR r.last_action IS DISTINCT FROM 'unrelated' THEN
    RAISE EXCEPTION 'recon list contract: an unrelated invoice left the list or is not with Finance';
  END IF;
  -- Only Xero carrying the job takes it off the list.
  UPDATE public.xero_invoices SET job_id = a WHERE id = inv;
  IF EXISTS (SELECT 1 FROM public.context_recon_daily_list(asof) WHERE subject_id = inv) THEN
    RAISE EXCEPTION 'recon list contract: an invoice Xero now puts on a job is still listed';
  END IF;
  UPDATE public.xero_invoices SET job_id = NULL WHERE id = inv;
  -- A sales invoice with no type recorded is still a sales invoice. This stack keeps the type
  -- NOT NULL, so lift that inside this rolled-back transaction to prove the rule.
  ALTER TABLE public.xero_invoices ALTER COLUMN invoice_type DROP NOT NULL;
  UPDATE public.xero_invoices SET invoice_type = NULL WHERE id = inv;
  IF NOT EXISTS (SELECT 1 FROM public.context_recon_daily_list(asof) WHERE subject_id = inv) THEN
    RAISE EXCEPTION 'recon list contract: an owed invoice with no type recorded was dropped';
  END IF;

  -- 6. Event decisions still go through the event writer: confirm the band 3 message.
  PERFORM public.context_recon_record_decision('7d300000-0000-0000-0000-000000000002',
    public.context_recon_evidence_hash('7d300000-0000-0000-0000-000000000002'), 'correct',
    ARRAY['7d000000-0000-0000-0000-00000000000b']::uuid[], 'ambiguity:no_candidate', staff);
  IF EXISTS (SELECT 1 FROM public.context_recon_daily_list(asof) WHERE subject_id = '7d300000-0000-0000-0000-000000000002') THEN
    RAISE EXCEPTION 'recon list contract: a decided message is still listed';
  END IF;

  -- 7. Once go-live is set after these messages, the message bands keep to the live lane and the
  --    owed invoice stays.
  IF NOT EXISTS (SELECT 1 FROM public.context_recon_daily_list(asof) WHERE subject_id = '7d300000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'recon list contract: the band 2 message is missing before go-live is set';
  END IF;
  UPDATE public.context_recon_settings SET live_from = '2026-10-19 00:00Z' WHERE id;
  IF EXISTS (SELECT 1 FROM public.context_recon_daily_list(asof) WHERE subject_kind = 'event'
             AND subject_id IN ('7d300000-0000-0000-0000-000000000001', '7d300000-0000-0000-0000-000000000002')) THEN
    RAISE EXCEPTION 'recon list contract: a backlog message is on the daily list';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.context_recon_daily_list(asof) WHERE subject_id = inv) THEN
    RAISE EXCEPTION 'recon list contract: go-live took the owed invoice off the list';
  END IF;
  IF (public.context_recon_daily_left_out(asof) ->> 'backlog')::int < 1 THEN
    RAISE EXCEPTION 'recon list contract: a message moved to the backlog is not counted as left out';
  END IF;

  -- 8. The list stops at 201 rows, so ops-api's 200 plus one can tell a full page from a cut one.
  INSERT INTO public.xero_invoices (id, org_id, xero_invoice_id, invoice_number, invoice_type, status, total, amount_due,
                                    amount_paid, invoice_date, job_id, xero_contact_id, reference, contact_name)
  SELECT gen_random_uuid(), '00000000-0000-0000-0000-000000000001', 'recon-cap-' || g, 'INV-97' || lpad(g::text, 3, '0'),
         'ACCREC', 'AUTHORISED', 10, 10, 0, '2026-10-05', NULL, NULL, 'Cap', 'Cap client'
  FROM generate_series(1, 205) g;
  SELECT count(*) INTO n FROM public.context_recon_daily_list(asof, 500);
  IF n <> 201 THEN RAISE EXCEPTION 'recon list contract: the list cap is % rows, not 201', n; END IF;
  SELECT count(*) INTO n FROM public.context_recon_daily_list(asof, 200);
  IF n <> 200 THEN RAISE EXCEPTION 'recon list contract: p_limit 200 returned % rows', n; END IF;
END $$;
ROLLBACK;
