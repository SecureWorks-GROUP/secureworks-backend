-- Contract for 20261006040000_context_story_safety: the job story is safe to switch on
-- with the reader off. Each section fails on the bodies before it (972, 975 and
-- 20261006033000):
--  0. Shape and access: thirteen replaced bodies keep their flags, grants and slice
--     names; seven helpers, service role only.
--  1. No false all-clear while no live (promoted) reading has read the words, nor
--     while a live one has rows on the job it has not read yet: the line leads with
--     "Whose move is unclear:", says the messages are not yet checked for promises or
--     requests (a lagging reading: how many newer rows of every kind, ours included),
--     and with no message on record claims nothing unchecked; whose move and the item
--     the first line names belong to the same party; a payer is "owed by", never "from".
--  2. An inbox email is dropped only for a saved copy on the same job: story, reader
--     evidence and citation check; the citation check only widens for mail. A mail
--     brought back this way joined the job's evidence no earlier than the rule's first
--     apply and its copy's landing, so a reading from before never read it (story,
--     packet, judge). not_known counts the mail the story shows whose copy sits
--     elsewhere; C11 says where that copy sits. The copy read finds every key by an
--     index (no payload containment look-up per mail).
--  3. Money guards: a paid deposit is acceptance; C2 for each record that disagrees
--     with the job value (one the app has no record of sending said so) and R8 then
--     unconfirmed; R8 never leads before the work is done and its status says not_due
--     (in the client story too, after the loops due now); overdue and due invoices owed
--     by whoever they are addressed to, and the customer's move names the customer's
--     invoice, never a neighbour's; a quote waits on the customer; a shared supplier
--     bill says so with this job's share.
--  4. Who and when: CRM time for backfilled texts, in the story, the reader's evidence
--     and the citation check; texts before the job's lead window are never the
--     customer's and never the reader's evidence (nor citable; the judge reads such a
--     job in full); ghost and observer bookings are copies; work is done only on a
--     completion status or record; the builder is the customer.
--  5. The first line says what the records show.
--  6. An automated send that was the only one is kept.
--  7. The client story counts the client's Xero contact on another client's private
--     job, only while owing; never a builder billed for a homeowner's job, nor a payer
--     not named as the client.
--  8. Re-applying changes nothing.
-- Fourth review (each fails on the 5eb5d30f bodies): an invoice placed on no job or on
-- another job that names the job leaves what is left to invoice unconfirmed (C2), and a
-- line naming the job there gives its own base; an unconfirmed R8 is never the move or the
-- first line's item (status unconfirmed); the client's owing is only what they owe; a
-- shadow asked for by id that has read every row reads as its promotion would; the line's
-- contact facts take the customer's messages placed on no job and their withheld mail; R7
-- with the customer in touch since the quote leaves whose move unclear and names it; a
-- make-safe's stage set to complete or its pack-sent note finishes the work (and a status
-- history entering complete); the customer's unread words are "not yet checked by the
-- reader".
-- Fifth review (each fails on the 53c15c39 bodies): this customer's CRM texts placed on no job
-- that were loaded later from the CRM's cache are at the CRM's own time, and never theirs from
-- before the job's lead window, in R7's contact since the quote and the line's contact facts.
-- Every fixture row is synthetic and rolled back; user triggers are off for it.

-- 0. Shape and access.
DO $shape$
DECLARE x record; p record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
   ('public.context_job_record_legacy_mail(uuid[],timestamptz)', false, 'Job record (20261006011000), story safety (20261006040000):%'),
   ('public.context_job_record_messages(uuid[],timestamptz)', false, 'Job record (20261006011000), story safety (20261006040000):%'),
   ('public.context_job_record_timeline(uuid[],timestamptz)', true, 'Job record (20261006011000), story fixes (20261006033000), story safety (20261006040000):%'),
   ('public.context_job_record_loops(uuid[],timestamptz)', true, 'Job record (20261006011000), story fixes (20261006033000), story safety (20261006040000):%'),
   ('public.context_job_record_money(uuid[],timestamptz)', true, 'Job record (20261006011000), story safety (20261006040000):%'),
   ('public.context_job_record_contact(uuid[],timestamptz)', true, 'Job record (20261006011000), story safety (20261006040000):%'),
   ('public.context_job_story_facts(uuid,timestamptz)', true, 'Job story (20261006014000), story safety (20261006040000):%'),
   ('public.context_job_story_meta(uuid,timestamptz)', true, 'Job story (20261006014000), story safety (20261006040000):%'),
   ('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)', false,
    'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000):%'),
   ('public.context_client_story(uuid,timestamptz)', true, 'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000):%'),
   ('public.context_ledger_evidence_rows(uuid[],timestamptz)', true, 'Context ledger store (20261006013000), story safety (20261006040000):%'),
   ('public.context_ledger_cite(uuid,jsonb)', true, 'Context ledger store (20261006013000), story safety (20261006040000):%'),
   ('public.context_ledger_judge(uuid[])', true, 'Context ledger store (20261006013000), story safety (20261006040000):%'),
   ('public.context_job_record_crm_time(text,text,text,uuid)', false, 'Story safety (20261006040000):%'),
   ('public.context_job_record_payer_role(uuid,text,text,text,uuid)', false, 'Story safety (20261006040000):%'),
   ('public.context_job_record_bill_share(text,jsonb,text)', false, 'Story safety (20261006040000):%'),
   ('public.context_job_record_value(uuid[],timestamptz)', false, 'Story safety (20261006040000):%'),
   ('public.context_job_story_day(date,date)', false, 'Story safety (20261006040000):%'),
   ('public.context_ledger_mail_rule_since()', false, 'Story safety (20261006040000):%'),
   ('public.context_ledger_mail_copies(uuid[])', false, 'Story safety (20261006040000):%')
 ) v(sig, definer, cmt) LOOP
  SELECT pr.prosecdef, pr.provolatile, pr.proconfig INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(x.sig);
  IF p IS NULL THEN RAISE EXCEPTION 'story safety contract: % missing', x.sig; END IF;
  IF p.prosecdef IS DISTINCT FROM x.definer OR p.provolatile NOT IN ('s', 'i')
     OR (x.definer AND p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']) OR (NOT x.definer AND p.proconfig IS NOT NULL) THEN
   RAISE EXCEPTION 'story safety contract: % flags changed (definer %, volatility %, config %)', x.sig, p.prosecdef, p.provolatile, p.proconfig;
  END IF;
  IF has_function_privilege('anon', x.sig, 'EXECUTE') OR has_function_privilege('authenticated', x.sig, 'EXECUTE')
     OR NOT has_function_privilege('service_role', x.sig, 'EXECUTE') THEN
   RAISE EXCEPTION 'story safety contract: % access wrong', x.sig;
  END IF;
  IF coalesce(obj_description(to_regprocedure(x.sig), 'pg_proc'), '') NOT LIKE x.cmt THEN
   RAISE EXCEPTION 'story safety contract: % comment must keep its slice name first and name story safety', x.sig;
  END IF;
 END LOOP;
END $shape$;

-- 2 (shape). The copy read finds each copy key by an index, never one payload containment
-- look-up per mail (each answered in 0.65 to 0.84 ms live and almost all found nothing:
-- 0.5 s a judgement at full rollout); the sender key reads the inbound mail sender index.
DO $copyshape$
DECLARE src text;
BEGIN
 SELECT p.prosrc INTO src FROM pg_proc p WHERE p.oid = 'public.context_ledger_mail_copies(uuid[])'::regprocedure;
 IF position('@>' IN src) > 0
    OR position('lower(btrim(coalesce(substring(b.payload ->> ''from'', ''<([^<>]*)>''), b.payload ->> ''from'')))' IN src) = 0
    OR to_regclass('public.business_events_party_mail_from') IS NULL THEN
  RAISE EXCEPTION 'story safety contract: the copy read must find each copy key by an index, never a payload look-up per mail: %', src;
 END IF;
END $copyshape$;

-- 1. No false all-clear (pure assembler). With no live reading of the words, nothing
-- open on record is never nobody's move: the line leads with "Whose move is unclear:",
-- says no record item is open and the messages are not yet checked for promises or
-- requests (never "not been read", which reads as staff not reading them), with the
-- newest customer message and our last reply; handling.commitments is empty. A finished
-- reading (live, or a shadow the story shows only when asked for it by id) may still say
-- nothing is open, but only once it has read every row on the job; a building or failed
-- one never counts as read.
DO $allclear$
DECLARE s jsonb; s2 jsonb; st text;
 job constant jsonb := '{"id":"x","status":"quoted","type":"fencing","created_at":"2026-09-01T00:00:00Z"}';
 contact constant jsonb := '{"last_customer_message":{"at":"2026-10-01T01:00:00Z","channel":"sms","direction":"inbound","table":"business_events","id":"e1","placed_on":"this_job"},
   "last_to_customer":{"at":"2026-10-02T01:00:00Z","channel":"sms","direction":"outbound","table":"business_events","id":"e2","placed_on":"this_job"}}';
 phrase constant text := 'Whose move is unclear: no record item is open, and the messages are not yet checked for promises or requests; '
                          || 'newest customer message Thu 1 Oct, our last reply Fri 2 Oct';
BEGIN
 s := public.context_job_story_assemble(job, jsonb_build_object('contact', contact), NULL, NULL, '2026-10-07 02:00Z', NULL);
 IF s->'now'->>'whose_move' <> 'unknown' OR position(phrase IN s->'now'->>'line') = 0 OR s->'now'->>'line' LIKE '%Nothing open%'
    OR s->'handling'->'commitments' <> 'null'::jsonb THEN
  RAISE EXCEPTION 'story safety contract: with no live reading nothing open is never an all-clear: % / %', s->'now', s->'handling';
 END IF;
 -- (fourth review) A shadow reading is shown only when asked for by id (the grade reads the
 -- proof jobs' shadows so); one that has read every row reads as its promotion will: it may
 -- say nothing is open, nobody's move, and its commitments count. One with rows it has not
 -- read says how many, and whose move is unclear. A building or failed reading shown on
 -- request never counts as read, nor judges a customer message.
 s := public.context_job_story_assemble(job, jsonb_build_object('contact', contact),
        '{"status":"shadow","generation":{"id":"g1","status":"shadow","evidence_until":"2026-10-05T00:00:00Z"},"items":[],"transitions":[],"unread_rows":0,"unread_ids":[],"read_ids":["e1"]}',
        NULL, '2026-10-07 02:00Z', NULL);
 s2 := public.context_job_story_assemble(job, jsonb_build_object('contact', contact),
        '{"status":"live","generation":{"id":"g1","status":"live","evidence_until":"2026-10-05T00:00:00Z"},"items":[],"transitions":[],"unread_rows":0,"unread_ids":[],"read_ids":["e1"]}',
        NULL, '2026-10-07 02:00Z', NULL);
 IF s->'now'->>'whose_move' <> 'nobody' OR s->'now'->>'line' IS DISTINCT FROM s2->'now'->>'line'
    OR s->'handling'->'commitments' IS DISTINCT FROM '{"kept": 0, "late": 0, "open": 0, "overdue": 0}'::jsonb THEN
  RAISE EXCEPTION 'story safety contract: a shadow asked for that has read every row reads as its promotion will: % / % / %', s->'now', s2->'now', s->'handling';
 END IF;
 s := public.context_job_story_assemble(job, jsonb_build_object('contact', contact),
        '{"status":"shadow","generation":{"id":"g1","status":"shadow","evidence_until":"2026-10-01T12:00:00Z"},"items":[],"transitions":[],"unread_rows":2,"unread_ids":["e2","e4"],"read_ids":["e1"]}',
        NULL, '2026-10-07 02:00Z', NULL);
 IF s->'now'->>'whose_move' <> 'unknown' OR s->'now'->>'line' LIKE '%Nothing open%'
    OR position('Whose move is unclear: no record item is open, and 2 newer messages, calls, notes or documents (ours included) are not yet checked' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: a shadow with rows it has not read is no all-clear: %', s->'now';
 END IF;
 FOREACH st IN ARRAY ARRAY['building', 'failed'] LOOP
  s := public.context_job_story_assemble(job, jsonb_build_object('contact', contact, 'loops', jsonb_build_array(jsonb_build_object(
          'rule', 'R5_customer_wrote_last', 'loop_key', 'R5_customer_wrote_last:e1', 'shown_as', 'candidate', 'owner', 'us', 'counterparty', 'customer',
          'what', 'Customer texted Thu 1 Oct 09:00 and nothing went to the customer since: "Is Monday fine?"', 'opened_at', '2026-10-01T01:00:00Z',
          'about_key', 'contact:customer-reply', 'source_table', 'business_events', 'source_id', 'e1'))),
         jsonb_build_object('status', st, 'generation', jsonb_build_object('id', 'g1', 'status', st, 'evidence_until', '2026-10-05T00:00:00Z'),
          'items', '[]'::jsonb, 'transitions', '[]'::jsonb, 'unread_rows', 0, 'unread_ids', '[]'::jsonb, 'read_ids', '["e1"]'::jsonb),
         NULL, '2026-10-07 02:00Z', NULL);
  IF s->'now'->>'whose_move' <> 'unknown' OR s->'now'->>'line' LIKE '%Nothing open%' OR s->'handling'->'commitments' <> 'null'::jsonb
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(s->'checks') k WHERE k->>'what' LIKE '%the reader judged%')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'checks') k WHERE k->>'what' LIKE 'Customer wrote last; not yet checked by the reader.%') THEN
   RAISE EXCEPTION 'story safety contract: a % reading shown on request never counts as read: % / %', st, s->'now', s->'checks';
  END IF;
 END LOOP;
 s := public.context_job_story_assemble(job, jsonb_build_object('contact', contact),
        '{"status":"live","generation":{"id":"g1","evidence_until":"2026-10-05T00:00:00Z"},"items":[],"transitions":[],"unread_rows":0,"unread_ids":[],"read_ids":["e1"]}',
        NULL, '2026-10-07 02:00Z', NULL);
 IF s->'now'->>'whose_move' <> 'nobody' OR position('Nothing open on record' IN s->'now'->>'line') = 0
    OR s->'handling'->'commitments' IS DISTINCT FROM '{"kept": 0, "late": 0, "open": 0, "overdue": 0}'::jsonb THEN
  RAISE EXCEPTION 'story safety contract: a live reading that found nothing open may say so: % / %', s->'now', s->'handling';
 END IF;
 -- A live reading that has not read every row on the job (here three newer rows, our
 -- newest reply among them; or one) is no all-clear either: whose move is unknown and
 -- the line says how many newer rows it has not checked, every kind and ours included
 -- (the count is not of the customer's messages). What it did read still counts
 -- (handling.commitments).
 s := public.context_job_story_assemble(job, jsonb_build_object('contact', contact),
        '{"status":"live","generation":{"id":"g1","evidence_until":"2026-10-01T12:00:00Z"},"items":[],"transitions":[],"unread_rows":3,"unread_ids":["e2","e4","e5"],"read_ids":["e1"]}',
        NULL, '2026-10-07 02:00Z', NULL);
 s2 := public.context_job_story_assemble(job, jsonb_build_object('contact', contact),
        '{"status":"live","generation":{"id":"g1","evidence_until":"2026-10-01T12:00:00Z"},"items":[],"transitions":[],"unread_rows":1,"unread_ids":["e2"],"read_ids":["e1"]}',
        NULL, '2026-10-07 02:00Z', NULL);
 IF s->'now'->>'whose_move' <> 'unknown' OR s->'now'->>'line' LIKE '%Nothing open%'
    OR position('Whose move is unclear: no record item is open, and 3 newer messages, calls, notes or documents (ours included) are not yet checked '
                || 'for promises or requests; newest customer message Thu 1 Oct, our last reply Fri 2 Oct' IN s->'now'->>'line') = 0
    OR s->'handling'->'commitments' IS DISTINCT FROM '{"kept": 0, "late": 0, "open": 0, "overdue": 0}'::jsonb
    OR s2->'now'->>'whose_move' <> 'unknown'
    OR position('Whose move is unclear: no record item is open, and 1 newer message, call, note or document (ours included) is not yet checked '
                || 'for promises or requests;' IN s2->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: a live reading with rows it has not read is no all-clear: % / %', s->'now', s2->'now';
 END IF;
 -- Whose move and the item the line names belong to the same party: our move (a draft
 -- not issued) names what we owe, never another payer's overdue invoice that ranks
 -- above it (SWF-261423 class).
 s := public.context_job_story_assemble('{"id":"x","status":"invoiced","type":"fencing","created_at":"2026-09-01T00:00:00Z"}'::jsonb,
        jsonb_build_object('contact', contact, 'loops', jsonb_build_array(
          jsonb_build_object('rule', 'R1_overdue', 'loop_key', 'R1_overdue:n1', 'shown_as', 'loop', 'owner', 'third_party', 'counterparty', 'us',
           'what', 'INV-9 $100.00 overdue from N (a neighbour paying part of this job) since Tue 1 Sep 2026 (36 days)',
           'opened_at', '2026-09-01T00:00:00Z', 'due_date', '2026-09-01', 'amount', 100, 'about_key', 'invoice:inv-9',
           'source_table', 'xero_invoices', 'source_id', 'n1'),
          jsonb_build_object('rule', 'R3_draft', 'loop_key', 'R3_draft:c1', 'shown_as', 'loop', 'owner', 'us', 'counterparty', 'customer',
           'what', 'Draft invoice INV-10 $500.00 to C not issued since Thu 1 Oct 2026', 'opened_at', '2026-09-30T16:00:00Z', 'amount', 500,
           'about_key', 'invoice:inv-10', 'source_table', 'xero_invoices', 'source_id', 'c1'))),
        '{"status":"live","generation":{"id":"g1","evidence_until":"2026-10-05T00:00:00Z"},"items":[],"transitions":[],"unread_rows":0,"unread_ids":[],"read_ids":["e1"]}',
        NULL, '2026-10-07 02:00Z', NULL);
 IF s->'now'->>'whose_move' <> 'us' OR position('Our move, we owe: Draft invoice INV-10' IN s->'now'->>'line') = 0
    OR s->'now'->>'line' LIKE '%another payer owes%' OR s->'now'->'next'->>'what' NOT LIKE 'Draft invoice INV-10%' THEN
  RAISE EXCEPTION 'story safety contract: our move names what we owe, never another payer''s invoice: %', s->'now';
 END IF;
 -- only an automated text went to the customer: no reply from a person, the text named
 s := public.context_job_story_assemble(job, jsonb_build_object('contact', jsonb_build_object('last_customer_message', contact->'last_customer_message',
        'last_to_customer', '{"newer_automated":{"at":"2026-10-03T01:00:00Z","channel":"sms","direction":"outbound","table":"business_events","id":"e3","automated":true},"only_automated":true}'::jsonb)),
        NULL, NULL, '2026-10-07 02:00Z', NULL);
 IF position('newest customer message Thu 1 Oct, no reply from us on record (an automated text went Sat 3 Oct)' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: an automated text is never our reply, but it is named: %', s->'now'->>'line';
 END IF;
 -- no customer message and no reply from us on record: whose move is unclear, and the
 -- line says so and claims nothing unchecked (never "the messages have not been read yet:
 -- no customer message on record")
 s := public.context_job_story_assemble(job, '{}'::jsonb, NULL, NULL, '2026-10-07 02:00Z', NULL);
 IF s->'now'->>'whose_move' <> 'unknown'
    OR position('Whose move is unclear: no record item is open; no customer message and no reply from us on record' IN s->'now'->>'line') = 0
    OR s->'now'->>'line' LIKE '%not yet checked%' OR s->'now'->>'line' LIKE '%been read%' THEN
  RAISE EXCEPTION 'story safety contract: with no message on record the line claims nothing unchecked: %', s->'now';
 END IF;
 -- a visit booked ahead and nothing open: never "Nothing open until the visit" either
 s := public.context_job_story_assemble('{"id":"x","status":"scheduled","type":"fencing","created_at":"2026-09-01T00:00:00Z"}'::jsonb,
        jsonb_build_object('contact', contact, 'facts', jsonb_build_object('bookings', jsonb_build_array(
          jsonb_build_object('id', 'b1', 'scheduled_date', '2026-10-09', 'status', 'scheduled', 'created_at', '2026-10-01T00:00:00Z')))),
        NULL, NULL, '2026-10-07 02:00Z', NULL);
 IF s->'now'->>'whose_move' <> 'unknown' OR s->'now'->>'line' LIKE '%Nothing open%' OR position('next visit' IN s->'now'->>'line') = 0
    OR position(phrase IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: a booked visit is no all-clear without a reading: %', s->'now';
 END IF;
END $allclear$;

-- 1 (continued, pure assembler). The owing words name who owes each invoice ("owed by",
-- never "from", which reads as a bill from them) whenever a neighbour or another payer owes
-- it, with their role, whatever the move and however many parties owe. Here only the neighbour owes: beside our move (a draft not issued) and
-- beside the customer's move (a quote waiting) the neighbour's invoice never reads as the
-- customer's. A money row with no payer role is read by its money loop's owner.
DO $owing$
DECLARE s jsonb;
 contact constant jsonb := '{"last_customer_message":{"at":"2026-10-01T01:00:00Z","channel":"sms","direction":"inbound","table":"business_events","id":"e1","placed_on":"this_job"},
   "last_to_customer":{"at":"2026-10-02T01:00:00Z","channel":"sms","direction":"outbound","table":"business_events","id":"e2","placed_on":"this_job"}}';
 live constant jsonb := '{"status":"live","generation":{"id":"g1","evidence_until":"2026-10-05T00:00:00Z"},"items":[],"transitions":[],"unread_rows":0,"unread_ids":[],"read_ids":["e1"]}';
 r1 constant jsonb := jsonb_build_object('rule', 'R1_overdue', 'loop_key', 'R1_overdue:n1', 'shown_as', 'loop', 'owner', 'third_party', 'counterparty', 'us',
   'what', 'INV-9 $100.00 overdue from N (a neighbour paying part of this job) since Tue 1 Sep 2026 (36 days)',
   'opened_at', '2026-09-01T00:00:00Z', 'due_date', '2026-09-01', 'amount', 100, 'about_key', 'invoice:inv-9', 'source_table', 'xero_invoices', 'source_id', 'n1');
 r3 constant jsonb := jsonb_build_object('rule', 'R3_draft', 'loop_key', 'R3_draft:c1', 'shown_as', 'loop', 'owner', 'us', 'counterparty', 'customer',
   'what', 'Draft invoice INV-10 $500.00 to C not issued since Thu 1 Oct 2026', 'opened_at', '2026-09-30T16:00:00Z', 'amount', 500,
   'about_key', 'invoice:inv-10', 'source_table', 'xero_invoices', 'source_id', 'c1');
 r7 constant jsonb := jsonb_build_object('rule', 'R7_quote_waiting', 'loop_key', 'R7_quote_waiting:q1', 'shown_as', 'loop', 'owner', 'customer', 'counterparty', 'us',
   'what', 'Quote Q-1 v1 sent Sun 20 Sep 2026 (17 days), not viewed; no answer and no customer message since',
   'opened_at', '2026-09-20T01:10:00Z', 'about_key', 'quote:q-1', 'source_table', 'job_documents', 'source_id', 'q1');
 owed constant jsonb := jsonb_build_object('party', 'N', 'xero_contact_id', 'xn', 'invoiced', 100, 'paid', 0, 'credited', 0, 'owing', 100, 'overdue', 100,
   'oldest_overdue_due', '2026-09-01', 'drafts', 0, 'draft_total', 0, 'invoices', jsonb_build_array(jsonb_build_object(
     'id', 'n1', 'number', 'INV-9', 'status', 'AUTHORISED', 'total', 100, 'payer_role', 'neighbour', 'owing', 100,
     'due_date', '2026-09-01', 'overdue', true, 'days_overdue', 36)));
 drafted constant jsonb := jsonb_build_object('party', 'C', 'xero_contact_id', 'xc', 'invoiced', 0, 'paid', 0, 'credited', 0, 'owing', 0, 'overdue', 0,
   'drafts', 1, 'draft_total', 500, 'invoices', jsonb_build_array(jsonb_build_object(
     'id', 'c1', 'number', 'INV-10', 'status', 'DRAFT', 'total', 500, 'payer_role', 'customer', 'owing', 0)));
BEGIN
 -- our move
 s := public.context_job_story_assemble('{"id":"x","status":"invoiced","type":"fencing","created_at":"2026-09-01T00:00:00Z"}'::jsonb,
        jsonb_build_object('contact', contact, 'loops', jsonb_build_array(r1, r3), 'money', jsonb_build_array(owed, drafted)),
        live, NULL, '2026-10-07 02:00Z', NULL);
 IF s->'now'->>'whose_move' <> 'us'
    OR position('Owing $100.00 ($100.00 overdue): INV-9 $100.00 owed by N (a neighbour paying part of this job) overdue since Tue 1 Sep (36 days), '
                || '1 draft invoice not issued. Our move, we owe: Draft invoice INV-10' IN s->'now'->>'line') = 0
    OR s->'now'->>'line' LIKE '%$100.00 from N%' THEN
  RAISE EXCEPTION 'story safety contract: beside our move a neighbour''s invoice names the neighbour: %', s->'now';
 END IF;
 -- the customer's move
 s := public.context_job_story_assemble('{"id":"x","status":"quoted","type":"fencing","created_at":"2026-09-01T00:00:00Z"}'::jsonb,
        jsonb_build_object('contact', contact, 'loops', jsonb_build_array(r1, r7), 'money', jsonb_build_array(owed)),
        live, NULL, '2026-10-07 02:00Z', NULL);
 IF s->'now'->>'whose_move' <> 'customer'
    OR position('Owing $100.00 ($100.00 overdue): INV-9 $100.00 owed by N (a neighbour paying part of this job) overdue since Tue 1 Sep (36 days). '
                || 'The customer''s move, waiting on the customer: Quote Q-1 v1' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: beside the customer''s move a neighbour''s invoice names the neighbour: %', s->'now';
 END IF;
 -- a money row without its payer role: its money loop's owner says another party owes it
 s := public.context_job_story_assemble('{"id":"x","status":"invoiced","type":"fencing","created_at":"2026-09-01T00:00:00Z"}'::jsonb,
        jsonb_build_object('contact', contact, 'loops', jsonb_build_array(r1, r3),
          'money', jsonb_build_array(jsonb_set(owed, '{invoices,0}', (owed #> '{invoices,0}') - 'payer_role'), drafted)),
        live, NULL, '2026-10-07 02:00Z', NULL);
 IF position('INV-9 $100.00 owed by N (another payer, not this job''s customer) overdue since Tue 1 Sep (36 days)' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: an invoice its loop says another party owes names that party: %', s->'now';
 END IF;
 -- the customer's own invoice, the only one owing, still names no payer
 s := public.context_job_story_assemble('{"id":"x","status":"invoiced","type":"fencing","created_at":"2026-09-01T00:00:00Z"}'::jsonb,
        jsonb_build_object('contact', contact, 'loops', jsonb_build_array(jsonb_build_object('rule', 'R1_overdue', 'loop_key', 'R1_overdue:k1',
            'shown_as', 'loop', 'owner', 'customer', 'counterparty', 'us', 'what', 'INV-11 $100.00 overdue from C since Tue 1 Sep 2026 (36 days)',
            'opened_at', '2026-09-01T00:00:00Z', 'due_date', '2026-09-01', 'amount', 100, 'about_key', 'invoice:inv-11',
            'source_table', 'xero_invoices', 'source_id', 'k1'), r3),
          'money', jsonb_build_array(jsonb_build_object('party', 'C', 'xero_contact_id', 'xc', 'invoiced', 100, 'paid', 0, 'credited', 0,
            'owing', 100, 'overdue', 100, 'oldest_overdue_due', '2026-09-01', 'drafts', 1, 'draft_total', 500, 'invoices', jsonb_build_array(
              jsonb_build_object('id', 'k1', 'number', 'INV-11', 'status', 'AUTHORISED', 'total', 100, 'payer_role', 'customer', 'owing', 100,
                'due_date', '2026-09-01', 'overdue', true, 'days_overdue', 36),
              jsonb_build_object('id', 'c1', 'number', 'INV-10', 'status', 'DRAFT', 'total', 500, 'payer_role', 'customer', 'owing', 0))))),
        live, NULL, '2026-10-07 02:00Z', NULL);
 IF position('INV-11 $100.00 overdue since Tue 1 Sep (36 days)' IN s->'now'->>'line') = 0 OR s->'now'->>'line' LIKE '%INV-11 $100.00 from%'
    OR s->'now'->>'line' LIKE '%INV-11 $100.00 owed by%' THEN
  RAISE EXCEPTION 'story safety contract: the customer''s own invoice names no payer when only they owe: %', s->'now';
 END IF;
END $owing$;

-- 3 (pure assembler, fourth review). An R8 whose amount the job value cannot confirm (a C2
-- check, no amount) is held once the work is done: its status says unconfirmed, it ranks
-- after every loop due now, and it is never the move or the first line's item, so the
-- customer's overdue balance leads (SWP-261180 class: both invoices name a $3,790.60 base,
-- the job value is stale). The item the line names is cut at a word, never mid-word.
DO $held$
DECLARE s jsonb; w text;
 contact constant jsonb := '{"last_customer_message":{"at":"2026-10-01T01:00:00Z","channel":"sms","direction":"inbound","table":"business_events","id":"e1","placed_on":"this_job"},
   "last_to_customer":{"at":"2026-10-02T01:00:00Z","channel":"sms","direction":"outbound","table":"business_events","id":"e2","placed_on":"this_job"}}';
 r8 constant jsonb := jsonb_build_object('rule', 'R8_not_yet_invoiced', 'loop_key', 'R8_not_yet_invoiced:j1', 'shown_as', 'loop', 'owner', 'us', 'counterparty', 'customer',
   'what', 'Job value $6,298.71 (pricing_json.totalIncGST) is unconfirmed (check C2); issued invoices $3,790.60; what is left to invoice is not known',
   'opened_at', '2026-08-06T00:00:00Z', 'about_key', 'payment:final', 'source_table', 'jobs', 'source_id', 'j1');
 r1 constant jsonb := jsonb_build_object('rule', 'R1_overdue', 'loop_key', 'R1_overdue:i2', 'shown_as', 'loop', 'owner', 'customer', 'counterparty', 'us',
   'what', 'INV-12 $1,895.30 overdue from C since Fri 2 Oct 2026 (5 days)', 'opened_at', '2026-10-02T00:00:00Z', 'due_date', '2026-10-02',
   'amount', 1895.30, 'about_key', 'invoice:inv-12', 'source_table', 'xero_invoices', 'source_id', 'i2');
BEGIN
 s := public.context_job_story_assemble('{"id":"x","status":"invoiced","type":"patio","created_at":"2026-08-01T00:00:00Z"}'::jsonb,
        jsonb_build_object('contact', contact, 'loops', jsonb_build_array(r8, r1), 'facts', jsonb_build_object('status_completed_at', '2026-09-24T01:00:00Z')),
        NULL, NULL, '2026-10-07 02:00Z', NULL);
 IF s->'now'->>'whose_move' <> 'customer'
    OR position('The customer''s move, the customer owes: INV-12 $1,895.30 overdue from C since Fri 2 Oct 2026' IN s->'now'->>'line') = 0
    OR s->'now'->>'line' LIKE '%we owe%' OR s->'now'->'next'->>'what' NOT LIKE 'INV-12%'
    OR (SELECT l->>'status' FROM jsonb_array_elements(s->'loops') l WHERE l->>'rule' = 'R8_not_yet_invoiced') IS DISTINCT FROM 'unconfirmed'
    OR (SELECT (l->>'rank')::int FROM jsonb_array_elements(s->'loops') l WHERE l->>'rule' = 'R8_not_yet_invoiced') <> 2 THEN
  RAISE EXCEPTION 'story safety contract: an unconfirmed R8 is never the move; the customer''s overdue balance leads: % / %', s->'now', s->'loops';
 END IF;
 -- alone after the work (SWP-261046 class: settled by a final invoice below a stale value):
 -- still never our move, and never an all-clear without a reading
 s := public.context_job_story_assemble('{"id":"x","status":"get_review","type":"patio","created_at":"2026-08-01T00:00:00Z"}'::jsonb,
        jsonb_build_object('contact', contact, 'loops', jsonb_build_array(r8), 'facts', jsonb_build_object('status_completed_at', '2026-09-24T01:00:00Z')),
        NULL, NULL, '2026-10-07 02:00Z', NULL);
 IF s->'now'->>'whose_move' IN ('us', 'nobody') OR s->'now'->>'line' LIKE '%we owe%' OR s->'now'->>'line' LIKE '%Nothing open%' THEN
  RAISE EXCEPTION 'story safety contract: an unconfirmed R8 alone is never our move: %', s->'now';
 END IF;
 -- a long item is cut at a word with "...", never mid-word
 s := public.context_job_story_assemble('{"id":"x","status":"invoiced","type":"fencing","created_at":"2026-09-01T00:00:00Z"}'::jsonb,
        jsonb_build_object('contact', contact, 'loops', jsonb_build_array(jsonb_build_object('rule', 'R3_draft', 'loop_key', 'R3_draft:c1', 'shown_as', 'loop',
          'owner', 'us', 'counterparty', 'customer', 'what', 'Draft invoice INV-77 $500.00 to C not issued since Thu 1 Oct 2026 (' || repeat('alpha beta ', 30) || 'end)',
          'opened_at', '2026-09-30T16:00:00Z', 'amount', 500, 'about_key', 'invoice:inv-77', 'source_table', 'xero_invoices', 'source_id', 'c1'))),
        NULL, NULL, '2026-10-07 02:00Z', NULL);
 w := substring(s->'now'->>'line' FROM 'Our move, we owe: (Draft invoice INV-77 .*?\.\.\.)');
 IF w IS NULL OR length(w) > 200 OR w !~ ' (alpha|beta)\.\.\.$' THEN
  RAISE EXCEPTION 'story safety contract: the item the line names is cut at a word: %', s->'now'->>'line';
 END IF;
END $held$;

BEGIN;
SET LOCAL session_replication_role = replica;

-- Jobs. Org and dates fixed; the replay instant is Wed 7 Oct 2026 10:00 Perth.
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, client_email, ghl_contact_id, xero_contact_id, pricing_json,
  accepted_at, completed_at, created_at)
VALUES
 ('40000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4001', 'quoted', 'fencing', 'Mail Client',
  'mail.m@example.test', 'ct40m', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4002', 'archived', 'fencing', 'Bucket',
  NULL, NULL, NULL, '{}', NULL, NULL, '2026-08-01 01:00Z'),
 -- the old-inbox count names the mail the story shows (job N); each copy key is read (job K)
 ('40000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4003', 'quoted', 'fencing', 'Count Client',
  'count.m@example.test', 'ct40n', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4004', 'quoted', 'fencing', 'Copies Client',
  'copies.c@example.test', 'ct40k', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z'),
 -- money
 ('40000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-0000000000aa', 'SWP-T4011', 'in_progress', 'patio', 'Deposit Client',
  NULL, 'ct40d', NULL, '{"totalIncGST": 7509.68}', NULL, NULL, '2026-07-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-0000000000aa', 'SWP-T4012', 'in_progress', 'patio', 'Base Client',
  NULL, 'ct40v1', NULL, '{"totalIncGST": 14161.11}', '2026-07-05 01:00Z', NULL, '2026-07-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-0000000000aa', 'SWP-T4013', 'rectification', 'patio', 'Percent Client',
  NULL, 'ct40v2', NULL, '{"totalIncGST": 10515.26}', '2026-07-05 01:00Z', NULL, '2026-07-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-0000000000aa', 'SWP-T4014', 'approvals', 'patio', 'Unsent Client',
  NULL, 'ct40v3', NULL, '{"totalIncGST": 10515.26}', '2026-07-05 01:00Z', NULL, '2026-07-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000015', '00000000-0000-4000-8000-0000000000aa', 'SWP-T4015', 'complete', 'patio', 'Final Client',
  NULL, 'ct40v4', NULL, '{"totalIncGST": 15500}', '2026-07-05 01:00Z', '2026-09-30 01:00Z', '2026-07-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000016', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4016', 'accepted', 'fencing', 'Quote Client',
  NULL, 'ct40v5', NULL, '{"totalIncGST": 10406}', '2026-09-10 01:00Z', NULL, '2026-09-01 01:00Z'),
 -- the deposit client's second job: a quote waiting on them (due now, unlike job 11's R8)
 ('40000000-0000-4000-8000-000000000017', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4017', 'quoted', 'fencing', 'Deposit Client',
  NULL, 'ct40d', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z'),
 -- payers
 ('40000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4021', 'final_payment', 'fencing', 'Payer Client',
  NULL, 'ct40p1', 'x40-client', '{}', NULL, NULL, '2026-06-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4022', 'invoiced', 'fencing', 'Client P2',
  NULL, 'ct40p2', NULL, '{}', NULL, NULL, '2026-06-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-0000000000aa', 'SWR-T4023', 'processing', 'repair', 'Home Owner',
  NULL, NULL, 'x40-builder', '{}', NULL, NULL, '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000024', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4024', 'quoted', 'fencing', 'Waiting Client',
  'wait@example.test', 'ct40q', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000025', '00000000-0000-4000-8000-0000000000aa', 'SWP-94025', 'scheduled', 'patio', 'Bill Client',
  NULL, 'ct40sb', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000026', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4026', 'invoiced', 'fencing', 'Client P6',
  NULL, 'ct40p6', NULL, '{}', NULL, NULL, '2026-06-01 01:00Z'),
 -- only a neighbour owes, and our draft to the customer is the move (SWF-26677 class)
 ('40000000-0000-4000-8000-000000000028', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4028', 'invoiced', 'fencing', 'Client P8',
  NULL, 'ct40p8', NULL, '{}', NULL, NULL, '2026-06-01 01:00Z'),
 -- who and when
 ('40000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4031', 'quoted', 'fencing', 'Backfill Client',
  NULL, 'ct40b1', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4032', 'quoted', 'fencing', 'Later Client',
  NULL, 'ct40b2', NULL, '{}', NULL, NULL, '2026-09-15 01:00Z'),
 ('40000000-0000-4000-8000-000000000033', '00000000-0000-4000-8000-0000000000aa', 'SWP-T4033', 'scheduled', 'patio', 'Ghost Client',
  NULL, 'ct40g', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000034', '00000000-0000-4000-8000-0000000000aa', 'SWP-T4034', 'in_progress', 'patio', 'Unfinished Client',
  NULL, 'ct40u', NULL, '{}', NULL, NULL, '2026-08-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000035', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4035', 'scheduled', 'fencing', 'Packed Client',
  NULL, 'ct40w', NULL, '{}', NULL, NULL, '2026-08-01 01:00Z'),
 -- first line
 ('40000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4041', 'scheduled', 'fencing', 'Passed Client',
  NULL, 'ct40f1', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000042', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4042', 'invoiced', 'fencing', 'Due Client',
  NULL, 'ct40f2', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000043', '00000000-0000-4000-8000-0000000000aa', 'SWMS-T4043', 'processing', 'makesafe', 'Insured Owner',
  NULL, NULL, 'x40-ms-builder', '{}', NULL, NULL, '2026-09-20 01:00Z'),
 ('40000000-0000-4000-8000-000000000044', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4044', 'quoted', 'fencing', 'Declined Client',
  NULL, 'ct40f4', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000045', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4045', 'quoted', 'fencing', 'Pause Client',
  NULL, 'ct40f5', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000046', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4046', 'scheduled', 'fencing', 'Request Client',
  NULL, 'ct40f6', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000047', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4047', 'quoted', 'fencing', 'Chased Client',
  NULL, 'ct40a6', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z'),
 -- client story
 ('40000000-0000-4000-8000-000000000051', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4051', 'complete', 'fencing', 'Client Seven',
  NULL, 'ct40c7a', NULL, '{}', NULL, NULL, '2026-03-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000052', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4052', 'final_payment', 'fencing', 'Client Eight',
  NULL, 'ct40c7b', 'x40-c7b', '{}', NULL, NULL, '2026-06-01 01:00Z'),
 -- a homeowner's private job billed to a builder, who is also billed on builder work and on
 -- another homeowner's private job (SWF-261343 class): never the homeowner's own contact
 ('40000000-0000-4000-8000-000000000053', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4053', 'archived', 'fencing', 'Homeowner Nine',
  NULL, 'ct40c9', NULL, '{}', NULL, NULL, '2026-05-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000054', '00000000-0000-4000-8000-0000000000aa', 'SWMS-T4054', 'processing', 'makesafe', 'Insured Ten',
  NULL, NULL, 'x40-bld9', '{}', NULL, NULL, '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000055', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4055', 'invoiced', 'fencing', 'Homeowner Eleven',
  NULL, 'ct40c11', NULL, '{}', NULL, NULL, '2026-08-01 01:00Z'),
 -- another client's job client seven paid on; a tenant's job paid by an agent named
 -- otherwise, who owes on another client's job; builder work the payer client owes on
 ('40000000-0000-4000-8000-000000000056', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4056', 'final_payment', 'fencing', 'Client Twelve',
  NULL, 'ct40c12', 'x40-c12', '{}', NULL, NULL, '2026-08-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000057', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4057', 'archived', 'fencing', 'Tenant Thirteen',
  NULL, 'ct40c13', NULL, '{}', NULL, NULL, '2026-05-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000058', '00000000-0000-4000-8000-0000000000aa', 'SWMS-T4058', 'processing', 'makesafe', 'Insured Fourteen',
  NULL, NULL, 'x40-bld14', '{}', NULL, NULL, '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000059', '00000000-0000-4000-8000-0000000000aa', 'SWF-T4059', 'invoiced', 'fencing', 'Client Fifteen',
  NULL, 'ct40c15', 'x40-c15', '{}', NULL, NULL, '2026-08-01 01:00Z');

-- 2. Mail on job M (SWF-T4001): i1's saved copy is on the archived bucket job, i2's is
-- placed on no job, i3's is on job M itself, i4 has none.
INSERT INTO public.inbox_events (id, job_id, from_email, subject, body_preview, received_at, processed_at, graph_message_id, mailbox, classification)
VALUES ('40a00000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'mail.m@example.test', 'ETA', 'When will you arrive?',
        '2026-10-03 01:00Z', '2026-10-03 01:00Z', 'g40-1', 'office@example.test', 'client_reply'),
       ('40a00000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000001', 'mail.m@example.test', 'Colour', 'Is black available?',
        '2026-10-02 01:00Z', '2026-10-02 01:00Z', 'g40-2', 'office@example.test', 'client_reply'),
       ('40a00000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000001', 'mail.m@example.test', 'Gate', 'Please add a gate.',
        '2026-09-30 01:00Z', '2026-09-30 01:00Z', 'g40-3', 'office@example.test', 'client_reply'),
       ('40a00000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000001', 'mail.m@example.test', 'Height', 'Can it be 1.8 m?',
        '2026-09-29 01:00Z', '2026-09-29 01:00Z', 'g40-4', 'office@example.test', 'client_reply');
-- (each copy was captured when it was recorded: the column's default is the clock of the
-- run, which would make when a copy landed depend on when the contract runs)
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence, source_table, source_id, provider_message_id)
VALUES
 ('40b00000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"When will you arrive?","from":"mail.m@example.test","subject":"ETA"}', '{"written_as":"service_role"}',
  '2026-10-03 01:00Z', '2026-10-03 01:05Z', '2026-10-03 01:00Z', '2026-10-03 01:05Z', 'direct', 1, 'inbox_events', '40a00000-0000-4000-8000-000000000001', NULL),
 ('40b00000-0000-4000-8000-000000000002', NULL, 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"Is black available?","from":"mail.m@example.test","subject":"Colour"}', '{"written_as":"service_role"}',
  '2026-10-02 01:00Z', '2026-10-02 01:05Z', '2026-10-02 01:00Z', '2026-10-02 01:05Z', 'unplaced', NULL, NULL, NULL, 'graph:g40-2'),
 ('40b00000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000001', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', 'ct40m',
  '{"body":"Please add a gate.","from":"mail.m@example.test","subject":"Gate"}',
  '{"written_as":"service_role","party_roles":{"counterpart_role":"customer","sender_role":"customer","basis":"job_customer"}}',
  '2026-09-30 01:00Z', '2026-09-30 01:05Z', '2026-09-30 01:00Z', '2026-09-30 01:05Z', 'direct', 1, 'inbox_events', '40a00000-0000-4000-8000-000000000003', NULL);
-- Job N (SWF-T4003): i6's saved copy is on the bucket job; i9, at i6's instant, too (the
-- record shows one mail per instant); i7's copy too, but an email on N at i7's instant hides
-- i7; i8, from the client's address and placed on no job, has a copy on no job.
-- Job K (SWF-T4004): i10's copy is an inbound email from its sender at its instant, captured
-- later, on the bucket job; i11's is an old-path copy (no source table, its id in the payload,
-- at its instant, no channel) on no job; i12's is an internal email on the bucket job.
INSERT INTO public.inbox_events (id, job_id, from_email, subject, body_preview, received_at, processed_at, graph_message_id, mailbox, classification)
VALUES ('40a00000-0000-4000-8000-000000000006', '40000000-0000-4000-8000-000000000003', 'count.m@example.test', 'Fence', 'When can you start?',
        '2026-10-01 01:00Z', '2026-10-01 01:00Z', 'g40-6', 'office@example.test', 'client_reply'),
       ('40a00000-0000-4000-8000-000000000009', '40000000-0000-4000-8000-000000000003', 'count.m@example.test', 'Fence again', 'Same instant, a second row',
        '2026-10-01 01:00Z', '2026-10-01 01:00Z', 'g40-9', 'office@example.test', 'client_reply'),
       ('40a00000-0000-4000-8000-000000000007', '40000000-0000-4000-8000-000000000003', 'count.m@example.test', 'Gate', 'How wide is the gate?',
        '2026-09-30 01:00Z', '2026-09-30 01:00Z', 'g40-7', 'office@example.test', 'client_reply'),
       ('40a00000-0000-4000-8000-000000000008', NULL, 'count.m@example.test', 'Colour', 'Is green available?',
        '2026-10-02 01:00Z', '2026-10-02 01:00Z', 'g40-8', 'office@example.test', 'client_reply'),
       ('40a00000-0000-4000-8000-000000000010', '40000000-0000-4000-8000-000000000004', 'copies.c@example.test', 'Posts', 'How deep are the posts?',
        '2026-09-25 01:00Z', '2026-09-25 01:00Z', 'g40-10', 'office@example.test', 'client_reply'),
       ('40a00000-0000-4000-8000-000000000011', '40000000-0000-4000-8000-000000000004', 'copies.c@example.test', 'Panels', 'Which panels are those?',
        '2026-09-26 01:00Z', '2026-09-26 01:00Z', 'g40-11', 'office@example.test', 'client_reply'),
       ('40a00000-0000-4000-8000-000000000012', '40000000-0000-4000-8000-000000000004', 'staff.test@secureworkswa.com.au', 'Measure', 'Measure it on Tuesday please',
        '2026-09-27 01:00Z', '2026-09-27 01:00Z', 'g40-12', 'office@example.test', 'internal');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence, source_table, source_id, provider_message_id)
VALUES
 ('40b00000-0000-4000-8000-000000000006', '40000000-0000-4000-8000-000000000002', 'client.email_in', 'monitor-inbox', 'email', 'inbound', NULL,
  '{"body":"When can you start?","from":"count.m@example.test","subject":"Fence"}', '{"written_as":"service_role"}',
  '2026-10-01 01:00Z', '2026-10-01 01:05Z', '2026-10-01 01:00Z', '2026-10-01 01:05Z', 'direct', 1, 'inbox_events', '40a00000-0000-4000-8000-000000000006', NULL),
 ('40b00000-0000-4000-8000-000000000009', '40000000-0000-4000-8000-000000000002', 'client.email_in', 'monitor-inbox', 'email', 'inbound', NULL,
  '{"body":"Same instant, a second row","from":"count.m@example.test","subject":"Fence again"}', '{"written_as":"service_role"}',
  '2026-10-01 01:00Z', '2026-10-01 01:05Z', '2026-10-01 01:00Z', '2026-10-01 01:05Z', 'direct', 1, 'inbox_events', '40a00000-0000-4000-8000-000000000009', NULL),
 ('40b00000-0000-4000-8000-000000000007', '40000000-0000-4000-8000-000000000002', 'client.email_in', 'monitor-inbox', 'email', 'inbound', NULL,
  '{"body":"How wide is the gate?","from":"count.m@example.test","subject":"Gate"}', '{"written_as":"service_role"}',
  '2026-09-30 01:00Z', '2026-09-30 01:05Z', '2026-09-30 01:00Z', '2026-09-30 01:05Z', 'direct', 1, 'inbox_events', '40a00000-0000-4000-8000-000000000007', NULL),
 ('40b00000-0000-4000-8000-00000000007a', '40000000-0000-4000-8000-000000000003', 'client.email_out', 'outlook-mail-capture', 'email', 'outbound', 'ct40n',
  '{"body":"Thanks, we will check the gate","from":"office@secureworkswa.com.au","to":"count.m@example.test"}',
  '{"written_as":"service_role","party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
  '2026-09-30 01:00Z', '2026-09-30 01:05Z', '2026-09-30 01:00Z', '2026-09-30 01:05Z', 'direct', 1, NULL, NULL, NULL),
 ('40b00000-0000-4000-8000-000000000008', NULL, 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"Is green available?","from":"count.m@example.test","subject":"Colour"}', '{"written_as":"service_role"}',
  '2026-10-02 01:00Z', '2026-10-02 01:05Z', '2026-10-02 01:00Z', '2026-10-02 01:05Z', 'unplaced', NULL, NULL, NULL, 'graph:g40-8'),
 ('40b00000-0000-4000-8000-000000000010', '40000000-0000-4000-8000-000000000002', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"How deep are the posts?","from":"copies.c@example.test","subject":"Posts"}', '{"written_as":"service_role"}',
  '2026-10-02 03:00Z', '2026-10-02 03:00Z', '2026-09-25 01:00Z', '2026-10-02 03:00Z', 'direct', 1, NULL, NULL, NULL),
 ('40b00000-0000-4000-8000-000000000011', NULL, 'client.email_in', 'monitor_inbox', NULL, NULL, NULL,
  '{"body":"Which panels are those?","inbox_events_id":"40a00000-0000-4000-8000-000000000011"}', '{"written_as":"service_role"}',
  '2026-09-26 01:00Z', '2026-09-26 01:01Z', NULL, '2026-09-26 01:01Z', 'unplaced', NULL, NULL, NULL, NULL),
 ('40b00000-0000-4000-8000-000000000012', '40000000-0000-4000-8000-000000000002', 'staff.email_internal', 'outlook-mail-capture', 'email', 'internal', NULL,
  '{"body":"Measure it on Tuesday please","from":"staff.test@secureworkswa.com.au","subject":"Measure"}', '{"written_as":"service_role"}',
  '2026-10-02 03:00Z', '2026-10-02 03:00Z', '2026-09-27 01:00Z', '2026-10-02 03:00Z', 'direct', 1, NULL, NULL, NULL);

-- 3. Money.
INSERT INTO public.xero_invoices (org_id, id, job_id, xero_invoice_id, xero_contact_id, contact_name, invoice_number, invoice_type, status, reference,
  total, amount_due, amount_paid, invoice_date, due_date, fully_paid_on, line_items, raw_json, job_contact_id, created_at)
VALUES
 -- a paid deposit, no other acceptance recorded; its line names the job value
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000011', '40000000-0000-4000-8000-000000000011', 'x4011',
  'x40-d', 'Deposit Client', 'INV-4011', 'ACCREC', 'PAID', 'SWP-T4011-DEP20', 1501.94, 0, 1501.94, '2026-07-02', '2026-07-09', '2026-07-03',
  '[{"Description":"Deposit (20% of $7,509.68 inc GST)\nSWP-T4011 | Patio","LineAmount":1365.4,"TaxAmount":136.54}]', '{"Status":"PAID","Payments":[]}', NULL, '2026-07-02 01:00Z'),
 -- a deposit line on another base than the job value
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000012', '40000000-0000-4000-8000-000000000012', 'x4012',
  'x40-v1', 'Base Client', 'INV-4012', 'ACCREC', 'PAID', 'SWP-T4012-DEP20', 2905.50, 0, 2905.50, '2026-07-06', '2026-07-13', '2026-07-07',
  '[{"Description":"Deposit (20% of $14,527.51 inc GST)\nSWP-T4012 | Patio","LineAmount":2641.36,"TaxAmount":264.14}]', '{"Status":"PAID","Payments":[]}', NULL, '2026-07-06 01:00Z'),
 -- a deposit that says only its percentage
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000013', '40000000-0000-4000-8000-000000000013', 'x4013',
  'x40-v2', 'Percent Client', 'INV-4013', 'ACCREC', 'PAID', 'SWP-T4013', 1595.00, 0, 1595.00, '2026-07-06', '2026-07-13', '2026-07-07',
  '[{"Description":"50% Deposit - Patio Installation","LineAmount":1450,"TaxAmount":145}]', '{"Status":"PAID","Payments":[]}', NULL, '2026-07-06 01:00Z'),
 -- a deposit and a final balance below the job value
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000015', '40000000-0000-4000-8000-000000000015', 'x4015a',
  'x40-v4', 'Final Client', 'INV-4015', 'ACCREC', 'PAID', 'SWP-T4015-DEP50', 7750.00, 0, 7750.00, '2026-07-06', '2026-07-13', '2026-07-07',
  '[{"Description":"Deposit (50% of $15,500.00 inc GST)\nSWP-T4015 | Patio","LineAmount":7045.45,"TaxAmount":704.55}]', '{"Status":"PAID","Payments":[]}', NULL, '2026-07-06 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000016', '40000000-0000-4000-8000-000000000015', 'x4015b',
  'x40-v4', 'Final Client', 'INV-4016', 'ACCREC', 'PAID', 'SWP-T4015-FINBAL50', 2372.50, 0, 2372.50, '2026-09-30', '2026-10-07', '2026-10-01',
  '[{"Description":"Balance of quote\nSWP-T4015 | Patio","LineAmount":2156.82,"TaxAmount":215.68}]', '{"Status":"PAID","Payments":[]}', NULL, '2026-09-30 01:00Z'),
 -- payers: the job's own Xero contact paid; another contact owes
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000021', '40000000-0000-4000-8000-000000000021', 'x4021a',
  'x40-client', 'Payer Client', 'INV-4021', 'ACCREC', 'PAID', 'SWF-T4021-DEP50', 2000.00, 0, 2000.00, '2026-06-02', '2026-06-09', '2026-06-03',
  NULL, '{"Status":"PAID","Payments":[]}', NULL, '2026-06-02 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000022', '40000000-0000-4000-8000-000000000021', 'x4021b',
  'x40-neigh', 'Neighbour Payer', 'INV-4022', 'ACCREC', 'AUTHORISED', 'SWF-T4021-B', 1850.40, 1850.40, 0, '2026-07-15', '2026-07-29', NULL,
  NULL, '{"Status":"AUTHORISED","Payments":[]}', NULL, '2026-07-15 01:00Z'),
 -- builder work
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000023', '40000000-0000-4000-8000-000000000023', 'x4023',
  'x40-builder', 'Builder Co', 'INV-4023', 'ACCREC', 'AUTHORISED', 'SWR-T4023', 2882.00, 2882.00, 0, '2026-10-01', '2026-10-12', NULL,
  NULL, '{"Status":"AUTHORISED","Payments":[]}', NULL, '2026-10-01 01:00Z'),
 -- a supplier bill shared with other jobs
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000025', '40000000-0000-4000-8000-000000000025', 'x4025',
  'x40-supplier', 'A Supplier', 'BILL-4025', 'ACCPAY', 'PAID', NULL, 1081.60, 0, 1081.60, '2026-09-20', '2026-09-27', '2026-09-25',
  '[{"Description":"SWP-94025 | Patio panels","LineAmount":268.8,"TaxAmount":0},{"Description":"SWP-940251 | Posts","LineAmount":117.6,"TaxAmount":0},{"Description":"SWP-94025 | Gutter","LineAmount":235.2,"TaxAmount":0},{"Description":"SWMS-94098 | Tarps","LineAmount":460,"TaxAmount":0}]',
  '{"Status":"PAID","LineAmountTypes":"NoTax","Payments":[]}', NULL, '2026-09-20 01:00Z'),
 -- first line: one invoice due, named with its due date
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000042', '40000000-0000-4000-8000-000000000042', 'x4042',
  'x40-f2', 'Due Client', 'INV-4042', 'ACCREC', 'AUTHORISED', 'SWF-T4042', 500.00, 500.00, 0, '2026-09-30', '2026-10-14', NULL,
  NULL, '{"Status":"AUTHORISED","Payments":[]}', NULL, '2026-09-30 01:00Z'),
 -- first line: a make-safe billed to the builder
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000043', '40000000-0000-4000-8000-000000000043', 'x4043',
  'x40-ms-builder', 'Make Safe Builder', 'INV-4043', 'ACCREC', 'AUTHORISED', 'SWMS-T4043', 500.50, 500.50, 0, '2026-09-29', '2026-10-13', NULL,
  NULL, '{"Status":"AUTHORISED","Payments":[]}', NULL, '2026-09-29 01:00Z'),
 -- the client story: client seven owes on their own job and, as a payer, on client eight's
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000051', '40000000-0000-4000-8000-000000000051', 'x4051',
  'x40-c7a', 'Client Seven', 'INV-4051', 'ACCREC', 'AUTHORISED', 'SWF-T4051', 839.20, 839.20, 0, '2026-03-20', '2026-04-02', NULL,
  NULL, '{"Status":"AUTHORISED","Payments":[]}', NULL, '2026-03-20 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000052', '40000000-0000-4000-8000-000000000052', 'x4052a',
  'x40-c7b', 'Client Eight', 'INV-4052', 'ACCREC', 'PAID', 'SWF-T4052-A', 6011.78, 0, 6011.78, '2026-07-10', '2026-07-24', '2026-07-20',
  NULL, '{"Status":"PAID","Payments":[]}', NULL, '2026-07-10 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000053', '40000000-0000-4000-8000-000000000052', 'x4052b',
  'x40-c7a', 'Client Seven', 'INV-4053', 'ACCREC', 'AUTHORISED', 'SWF-T4052-B', 1850.40, 1850.40, 0, '2026-07-15', '2026-07-29', NULL,
  NULL, '{"Status":"AUTHORISED","Payments":[]}', NULL, '2026-07-15 01:00Z'),
 -- ... and paid client twelve's invoice (no debt, so no other job of theirs)
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000057', '40000000-0000-4000-8000-000000000056', 'x4056',
  'x40-c7a', 'Client Seven', 'INV-4057', 'ACCREC', 'PAID', 'SWF-T4056-B', 300.00, 0, 300.00, '2026-08-10', '2026-08-24', '2026-08-20',
  NULL, '{"Status":"PAID","Payments":[]}', NULL, '2026-08-10 01:00Z'),
 -- homeowner nine's private job billed to the builder, the builder's make-safe and the
 -- builder's invoice on homeowner eleven's private job
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000054', '40000000-0000-4000-8000-000000000053', 'x4053',
  'x40-bld9', 'Builder Nine', 'INV-4054', 'ACCREC', 'PAID', 'SWF-T4053', 1200.00, 0, 1200.00, '2026-05-10', '2026-05-24', '2026-05-20',
  NULL, '{"Status":"PAID","Payments":[]}', NULL, '2026-05-10 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000055', '40000000-0000-4000-8000-000000000054', 'x4054',
  'x40-bld9', 'Builder Nine', 'INV-4055', 'ACCREC', 'AUTHORISED', 'SWMS-T4054', 1000.00, 1000.00, 0, '2026-09-06', '2026-09-20', NULL,
  NULL, '{"Status":"AUTHORISED","Payments":[]}', NULL, '2026-09-06 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000056', '40000000-0000-4000-8000-000000000055', 'x4055',
  'x40-bld9', 'Builder Nine', 'INV-4056', 'ACCREC', 'AUTHORISED', 'SWF-T4055', 500.00, 500.00, 0, '2026-10-06', '2026-10-20', NULL,
  NULL, '{"Status":"AUTHORISED","Payments":[]}', NULL, '2026-10-06 01:00Z'),
 -- tenant thirteen's job paid by an agent named otherwise; the agent owes on client fifteen's job
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000058', '40000000-0000-4000-8000-000000000057', 'x4057',
  'x40-agent', 'Agent Sixteen', 'INV-4058', 'ACCREC', 'PAID', 'SWF-T4057', 400.00, 0, 400.00, '2026-05-10', '2026-05-24', '2026-05-20',
  NULL, '{"Status":"PAID","Payments":[]}', NULL, '2026-05-10 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000059', '40000000-0000-4000-8000-000000000059', 'x4059',
  'x40-agent', 'Agent Sixteen', 'INV-4059', 'ACCREC', 'AUTHORISED', 'SWF-T4059-B', 250.00, 250.00, 0, '2026-09-20', '2026-10-04', NULL,
  NULL, '{"Status":"AUTHORISED","Payments":[]}', NULL, '2026-09-20 01:00Z'),
 -- the payer client's own Xero contact billed on builder work
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000060', '40000000-0000-4000-8000-000000000058', 'x4058',
  'x40-client', 'Payer Client', 'INV-4060', 'ACCREC', 'AUTHORISED', 'SWMS-T4058', 450.00, 450.00, 0, '2026-09-06', '2026-09-20', NULL,
  NULL, '{"Status":"AUTHORISED","Payments":[]}', NULL, '2026-09-06 01:00Z');
-- party link: client P2's primary party and a neighbour party, each invoiced; the same
-- for client P6, whose neighbour's invoice id sorts before the customer's (SWF-261209
-- class: both due the same day)
INSERT INTO public.job_contacts (id, job_id, contact_type, client_name, xero_contact_id, is_primary, created_at)
VALUES ('40d00000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000022', 'primary', 'Client P2', 'x40-p2c', true, '2026-06-01 01:00Z'),
       ('40d00000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000022', 'neighbour_b', 'Neighbour P2', 'x40-p2n', false, '2026-06-01 01:00Z'),
       ('40d00000-0000-4000-8000-000000000061', '40000000-0000-4000-8000-000000000026', 'primary', 'Client P6', 'x40-p6c', true, '2026-06-01 01:00Z'),
       ('40d00000-0000-4000-8000-000000000062', '40000000-0000-4000-8000-000000000026', 'neighbour_b', 'Neighbour P6', 'x40-p6n', false, '2026-06-01 01:00Z'),
       ('40d00000-0000-4000-8000-000000000081', '40000000-0000-4000-8000-000000000028', 'primary', 'Client P8', 'x40-p8c', true, '2026-06-01 01:00Z'),
       ('40d00000-0000-4000-8000-000000000082', '40000000-0000-4000-8000-000000000028', 'neighbour_b', 'Neighbour P8', 'x40-p8n', false, '2026-06-01 01:00Z');
INSERT INTO public.xero_invoices (org_id, id, job_id, xero_invoice_id, xero_contact_id, contact_name, invoice_number, invoice_type, status, reference,
  total, amount_due, amount_paid, invoice_date, due_date, raw_json, job_contact_id, created_at)
VALUES ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000031', '40000000-0000-4000-8000-000000000022', 'x4022a',
        'x40-p2c', 'Client P2', 'INV-4031', 'ACCREC', 'AUTHORISED', 'SWF-T4022-A', 1351.63, 1351.63, 0, '2026-10-01', '2026-10-10',
        '{"Status":"AUTHORISED","Payments":[]}', '40d00000-0000-4000-8000-000000000001', '2026-10-01 01:00Z'),
       ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000032', '40000000-0000-4000-8000-000000000022', 'x4022b',
        'x40-p2n', 'Neighbour P2', 'INV-4032', 'ACCREC', 'AUTHORISED', 'SWF-T4022-B', 1351.63, 1351.63, 0, '2026-10-01', '2026-10-10',
        '{"Status":"AUTHORISED","Payments":[]}', '40d00000-0000-4000-8000-000000000002', '2026-10-01 01:00Z'),
       ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000026', '40000000-0000-4000-8000-000000000026', 'x4026n',
        'x40-p6n', 'Neighbour P6', 'INV-4026', 'ACCREC', 'AUTHORISED', 'SWF-T4026-B', 1351.63, 1351.63, 0, '2026-10-01', '2026-10-10',
        '{"Status":"AUTHORISED","Payments":[]}', '40d00000-0000-4000-8000-000000000062', '2026-10-01 01:00Z'),
       ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000027', '40000000-0000-4000-8000-000000000026', 'x4026c',
        'x40-p6c', 'Client P6', 'INV-4027', 'ACCREC', 'AUTHORISED', 'SWF-T4026-A', 1351.63, 1351.63, 0, '2026-10-01', '2026-10-10',
        '{"Status":"AUTHORISED","Payments":[]}', '40d00000-0000-4000-8000-000000000061', '2026-10-01 01:00Z'),
       -- client P8: the neighbour's invoice is overdue; our draft to the customer is not issued
       ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000081', '40000000-0000-4000-8000-000000000028', 'x4028n',
        'x40-p8n', 'Neighbour P8', 'INV-4081', 'ACCREC', 'AUTHORISED', 'SWF-T4028-B', 1190.75, 1190.75, 0, '2026-09-01', '2026-09-15',
        '{"Status":"AUTHORISED","Payments":[]}', '40d00000-0000-4000-8000-000000000082', '2026-09-01 01:00Z'),
       ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000082', '40000000-0000-4000-8000-000000000028', 'x4028c',
        'x40-p8c', 'Client P8', 'INV-4082', 'ACCREC', 'DRAFT', 'SWF-T4028-A', 1190.75, 1190.75, 0, '2026-09-20', '2026-10-04',
        '{"Status":"DRAFT","Payments":[]}', '40d00000-0000-4000-8000-000000000081', '2026-09-20 01:00Z');
INSERT INTO public.makesafe_job_details (job_id, requesting_company_name, created_at)
VALUES ('40000000-0000-4000-8000-000000000023', 'Builder Co', '2026-09-01 01:00Z'),
       ('40000000-0000-4000-8000-000000000043', 'Make Safe Builder', '2026-09-20 01:00Z');
-- quotes: unsent only (V3); sent and valued, still standing (V5); waiting (Q, and the
-- deposit client's second job); declined (F4)
INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at, viewed_at, declined_at)
VALUES ('40e00000-0000-4000-8000-000000000014', '40000000-0000-4000-8000-000000000014', 'quote', NULL, 1, '2026-07-02 01:00Z', NULL, NULL, NULL),
       ('40e00000-0000-4000-8000-000000000016', '40000000-0000-4000-8000-000000000016', 'quote', 'Q-4016', 4, '2026-09-05 01:00Z', '2026-09-05 01:10Z', NULL, NULL),
       ('40e00000-0000-4000-8000-000000000017', '40000000-0000-4000-8000-000000000017', 'quote', 'Q-4017', 1, '2026-09-20 01:00Z', '2026-09-20 01:10Z', NULL, NULL),
       ('40e00000-0000-4000-8000-000000000024', '40000000-0000-4000-8000-000000000024', 'quote', 'Q-4024', 1, '2026-09-20 01:00Z', '2026-09-20 01:10Z', NULL, NULL),
       ('40e00000-0000-4000-8000-000000000044', '40000000-0000-4000-8000-000000000044', 'quote', 'Q-4044', 1, '2026-09-20 01:00Z', '2026-09-20 01:10Z', NULL, '2026-09-25 01:00Z');
INSERT INTO public.quote_revisions (id, job_id, job_document_id, version, totals_snapshot_json, released_via, sent_at)
VALUES ('40f00000-0000-4000-8000-000000000016', '40000000-0000-4000-8000-000000000016', '40e00000-0000-4000-8000-000000000016', 4,
        '{"total_inc_gst": 9509.5}', 'send-quote/send', '2026-09-05 01:10Z');
INSERT INTO public.email_events (id, job_id, email_type, recipient, subject, status, sent_at, created_at, metadata)
VALUES ('40900000-0000-4000-8000-000000000024', '40000000-0000-4000-8000-000000000024', 'quote', 'wait@example.test', 'Your quote', 'delivered',
        '2026-09-20 01:10Z', '2026-09-20 01:10Z', '{"document_id":"40e00000-0000-4000-8000-000000000024"}');

-- 4. Who and when. B1: a CRM text loaded on 5 Oct that the CRM sent on 20 Sep, before
-- our 25 Sep reply. B2: texts the CRM dates in June, before the job's lead window (it
-- was created 15 Sep).
INSERT INTO public.ghl_conversation_cache (contact_id, job_id, messages, synced_at)
VALUES ('ct40b1', '40000000-0000-4000-8000-000000000031',
        '[{"id":"m40-1","timestamp":"2026-09-20T01:00:00.000Z","type":"TYPE_SMS","direction":"inbound"},{"id":"m40-bad","timestamp":"2026-13-45T99:00:00Z"}]',
        '2026-10-05 01:00Z'),
       ('ct40b2', '40000000-0000-4000-8000-000000000032',
        '[{"id":"m40-2","timestamp":"2026-06-09T06:09:12.277Z","direction":"outbound"},{"id":"m40-3","timestamp":"2026-06-10T01:08:34.644Z","direction":"inbound"}]',
        '2026-09-15 23:00Z');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  attribution_status, attribution_confidence, provider_message_id)
VALUES
 ('40b00000-0000-4000-8000-000000000031', '40000000-0000-4000-8000-000000000031', 'client.reply', 'ghl_sms_cache_backfill', 'sms', 'inbound', 'ct40b1',
  '{"body":"Can we start Monday?","ghl_message_id":"m40-1"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-05 01:00Z', '2026-10-05 01:00Z', '2026-10-05 01:00Z', 'single_open', 1, 'ghl:m40-1'),
 ('40b00000-0000-4000-8000-000000000032', '40000000-0000-4000-8000-000000000031', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct40b1',
  '{"body":"Monday is booked in, see you then"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
  '2026-09-25 01:00Z', '2026-09-25 01:00Z', '2026-09-25 01:00Z', 'direct', 1, NULL),
 ('40b00000-0000-4000-8000-000000000033', '40000000-0000-4000-8000-000000000032', 'client.sms_out', 'ghl_sms_cache_backfill', 'sms', 'outbound', 'ct40b2',
  '{"body":"Our June text to someone","ghl_message_id":"m40-2"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
  '2026-09-16 01:00Z', '2026-09-16 01:00Z', '2026-09-16 01:00Z', 'single_open', 1, 'ghl:m40-2'),
 -- (no CRM contact on this one: the CRM time is found in its job's cache row)
 ('40b00000-0000-4000-8000-000000000034', '40000000-0000-4000-8000-000000000032', 'client.reply', 'ghl_sms_cache_backfill', 'sms', 'inbound', NULL,
  '{"body":"June words from someone else","ghl_message_id":"m40-3"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-09-16 01:00Z', '2026-09-16 01:00Z', '2026-09-16 01:00Z', 'single_open', 1, 'ghl:m40-3');
-- G: a real booking, a ghost copy made by a correction script and an observer row with
-- no source tag, each with its booking-made event
INSERT INTO public.job_assignments (id, job_id, role, scheduled_date, assignment_type, status, crew_name, is_ghost, created_at)
VALUES ('40100000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000033', 'lead_installer', '2026-10-12', 'install', 'scheduled', 'Crew G', false, '2026-09-20 01:00Z'),
       ('40100000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000033', 'observer', '2026-10-05', 'install', 'scheduled', NULL, true, '2026-10-05 09:04Z'),
       ('40100000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000033', 'observer', '2026-10-06', 'install', 'scheduled', NULL, false, '2026-10-05 09:05Z'),
       -- U: in progress, the newest booking marked complete, nothing records the job finished
       ('40100000-0000-4000-8000-000000000011', '40000000-0000-4000-8000-000000000034', 'lead_installer', '2026-09-08', 'install', 'scheduled', 'Crew U', false, '2026-09-01 01:00Z'),
       ('40100000-0000-4000-8000-000000000012', '40000000-0000-4000-8000-000000000034', 'lead_installer', '2026-09-24', 'install', 'complete', 'Crew U', false, '2026-09-20 01:00Z'),
       -- W: a booking marked complete, then a completion pack the next day
       ('40100000-0000-4000-8000-000000000021', '40000000-0000-4000-8000-000000000035', 'lead_installer', '2026-10-01', 'install', 'complete', 'Crew W', false, '2026-09-25 01:00Z'),
       -- F1: Monday's booking passed with no attendance; another is booked today
       ('40100000-0000-4000-8000-000000000031', '40000000-0000-4000-8000-000000000041', 'lead_installer', '2026-10-05', 'install', 'scheduled', 'Crew F', false, '2026-09-25 01:00Z'),
       ('40100000-0000-4000-8000-000000000032', '40000000-0000-4000-8000-000000000041', 'lead_installer', '2026-10-07', 'install', 'scheduled', 'Crew F', false, '2026-09-25 01:00Z'),
       -- F3: the make-safe attended
       ('40100000-0000-4000-8000-000000000041', '40000000-0000-4000-8000-000000000043', 'lead_installer', '2026-09-23', 'install', 'complete', 'Crew M', false, '2026-09-21 01:00Z'),
       -- F6: a booking ahead, made before the customer's new request
       ('40100000-0000-4000-8000-000000000051', '40000000-0000-4000-8000-000000000046', 'lead_installer', '2026-10-12', 'install', 'scheduled', 'Crew R', false, '2026-10-01 01:00Z');
INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at)
VALUES ('40200000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000033', 'assignment_created',
        '{"assignment_id":"40100000-0000-4000-8000-000000000001","date":"2026-10-12","operator":"office"}', '2026-09-20 01:00Z'),
       ('40200000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000033', 'assignment_created',
        '{"assignment_id":"40100000-0000-4000-8000-000000000002","date":"2026-10-05","source":"ghost_watcher_correction_2026_10_05","change":"moved"}', '2026-10-05 09:04Z'),
       ('40200000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000033', 'assignment_created',
        '{"assignment_id":"40100000-0000-4000-8000-000000000003","date":"2026-10-06"}', '2026-10-05 09:05Z'),
       ('40200000-0000-4000-8000-000000000021', '40000000-0000-4000-8000-000000000035', 'completion_pack_generated', '{}', '2026-10-02 03:00Z'),
       ('40200000-0000-4000-8000-000000000041', '40000000-0000-4000-8000-000000000043', 'makesafe_pack_sent_at_derived', '{}', '2026-09-29 03:00Z');
-- first line messages: a missed call (F2), a pause (F5), a new request after the
-- booking then our reply (F6), only an automated chaser (A6)
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  attribution_status, attribution_confidence)
VALUES
 ('40b00000-0000-4000-8000-000000000042', '40000000-0000-4000-8000-000000000042', 'client.call_logged', 'ghl', 'call', 'inbound', 'ct40f2',
  '{"body":"Call. Provider status: no-answer. Duration: 0 seconds"}', '{}', '2026-10-04 01:00Z', '2026-10-04 01:00Z', '2026-10-04 01:00Z', 'direct', 1),
 ('40b00000-0000-4000-8000-000000000045', '40000000-0000-4000-8000-000000000045', 'client.reply', 'ghl', 'sms', 'inbound', 'ct40f5',
  '{"body":"We have decided to wait until next year"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-02 01:00Z', '2026-10-02 01:00Z', '2026-10-02 01:00Z', 'direct', 1),
 ('40b00000-0000-4000-8000-000000000046', '40000000-0000-4000-8000-000000000046', 'client.reply', 'ghl', 'sms', 'inbound', 'ct40f6',
  '{"body":"Could you also price a second gate?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-05 01:00Z', '2026-10-05 01:00Z', '2026-10-05 01:00Z', 'direct', 1),
 ('40b00000-0000-4000-8000-000000000047', '40000000-0000-4000-8000-000000000046', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct40f6',
  '{"body":"Thanks, we will look at it"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
  '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', 'direct', 1),
 ('40b00000-0000-4000-8000-000000000048', '40000000-0000-4000-8000-000000000047', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct40a6',
  '{"body":"Reminder: your quote is waiting","sent_by_kind":"workflow"}', '{"party_roles":{"counterpart_role":"customer"}}',
  '2026-10-03 01:00Z', '2026-10-03 01:00Z', '2026-10-03 01:00Z', 'direct', 1);

DO $safety$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; s jsonb; r record; got text; n integer; chk jsonb;
 m constant uuid := '40000000-0000-4000-8000-000000000001';
BEGIN
 -- 2. Mail: only a copy on the same job stands in for an inbox email.
 SELECT string_agg(x.id::text, ',' ORDER BY x.id) INTO got FROM public.context_job_record_legacy_mail(ARRAY[m], asof) x;
 IF got IS DISTINCT FROM '40a00000-0000-4000-8000-000000000001,40a00000-0000-4000-8000-000000000002,40a00000-0000-4000-8000-000000000004' THEN
  RAISE EXCEPTION 'story safety contract: an inbox email is dropped only for a saved copy on the same job: %', got;
 END IF;
 s := public.context_job_story(m, asof);
 IF s->'last_exchange'->'customer_said'->>'id' IS DISTINCT FROM '40a00000-0000-4000-8000-000000000001'
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'not_known') k
                   WHERE k->>'what' = '2 emails on this job are shown from the old inbox: their saved copies are on another job or on no job yet.')
    OR position('2026-10-03' IN (s->'meta'->'sources'->>'legacy_inbox')) = 0 THEN
  RAISE EXCEPTION 'story safety contract: the story must show the mail whose copy sits elsewhere, and say so: % / %', s->'last_exchange', s->'not_known';
 END IF;
 SELECT string_agg(e.src_table || ':' || e.src_id, ',' ORDER BY e.at) INTO got FROM public.context_ledger_evidence_rows(ARRAY[m], asof) e;
 IF got IS DISTINCT FROM 'inbox_events:40a00000-0000-4000-8000-000000000004,business_events:40b00000-0000-4000-8000-000000000003,'
    || 'inbox_events:40a00000-0000-4000-8000-000000000002,inbox_events:40a00000-0000-4000-8000-000000000001' THEN
  RAISE EXCEPTION 'story safety contract: the reader''s evidence must hold each email once: %', got;
 END IF;
 -- The citation check only widens: a mail whose copy sits elsewhere can be cited now; one
 -- with no copy as before; one whose copy is on the job is still cited by its copy. The
 -- 972 rule (any copy anywhere) is computed here for each, and whatever it accepted the
 -- store still accepts.
 FOR r IN SELECT i.id, i.body_preview,
                 NOT (EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table = 'inbox_events' AND b.source_id = i.id::text)
                      OR EXISTS (SELECT 1 FROM public.business_events b WHERE i.graph_message_id IS NOT NULL AND b.provider_message_id = 'graph:' || i.graph_message_id)
                      OR EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table IS NULL AND b.payload @> jsonb_build_object('inbox_events_id', i.id::text))
                      OR EXISTS (SELECT 1 FROM public.business_events b WHERE b.channel = 'email' AND coalesce(b.event_at, b.occurred_at) = i.received_at
                                 AND lower(btrim(coalesce(b.payload ->> 'from', b.payload ->> 'from_email'))) = lower(btrim(i.from_email)))) AS ok_972
          FROM public.inbox_events i WHERE i.job_id = m ORDER BY i.id LOOP
  chk := public.context_ledger_cite(m, jsonb_build_object('table', 'inbox_events', 'id', r.id::text, 'excerpt', r.body_preview));
  IF r.ok_972 AND NOT coalesce((chk->>'ok')::boolean, false) THEN
   RAISE EXCEPTION 'story safety contract: the store must still accept what it accepted before: % %', r.id, chk;
  END IF;
  IF (r.id = '40a00000-0000-4000-8000-000000000003') = coalesce((chk->>'ok')::boolean, false) THEN
   RAISE EXCEPTION 'story safety contract: only the mail whose copy is on this job is cited by its copy: % %', r.id, chk;
  END IF;
 END LOOP;
 -- every timeline line of every fixture job that cites a record the store can read is accepted
 SELECT count(*) INTO n FROM public.jobs jb CROSS JOIN LATERAL public.context_job_record_timeline(ARRAY[jb.id], asof) t
 WHERE jb.id::text LIKE '40000000-%' AND t.source_table IN ('xero_invoices', 'job_documents', 'job_assignments', 'job_events', 'email_events', 'inbox_events');
 IF n < 40 THEN RAISE EXCEPTION 'story safety contract: too few timeline lines to check the store against (%)', n; END IF;
 FOR r IN SELECT t.job_id, t.source_table, t.source_id FROM public.jobs jb
          CROSS JOIN LATERAL public.context_job_record_timeline(ARRAY[jb.id], asof) t
          WHERE jb.id::text LIKE '40000000-%' AND t.source_table IN ('xero_invoices', 'job_documents', 'job_assignments', 'job_events', 'email_events', 'inbox_events') LOOP
  chk := public.context_ledger_cite(r.job_id, jsonb_build_object('table', r.source_table, 'id', r.source_id));
  IF NOT coalesce((chk->>'ok')::boolean, false) AND NOT (r.source_table = 'inbox_events' AND chk->>'code' = 'excerpt_required') THEN
   RAISE EXCEPTION 'story safety contract: the store refuses a timeline line: % %', row_to_json(r), chk;
  END IF;
 END LOOP;

 -- 3. Money. A paid deposit is acceptance: R8 fires with the amount; before the work is
 -- done it is never the move or in the first line.
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000011'::uuid], asof) l WHERE l.rule = 'R8_not_yet_invoiced';
 IF r.what IS DISTINCT FROM 'Job value $7,509.68 (pricing_json.totalIncGST); issued invoices $1,501.94; $6,007.74 not yet invoiced'
    OR r.amount IS DISTINCT FROM 6007.74 OR r.why NOT LIKE 'A deposit invoice is paid, so the job is accepted%' THEN
  RAISE EXCEPTION 'story safety contract: a paid deposit invoice is acceptance: %', row_to_json(r);
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000011', asof);
 IF s->'now'->>'whose_move' = 'us' OR s->'now'->>'line' LIKE '%not yet invoiced%' OR s->'now'->>'line' LIKE '%we owe%'
    OR position('Whose move is unclear: no record item is due yet' IN s->'now'->>'line') = 0
    OR s->'loops'->0->>'key' <> 'R8_not_yet_invoiced:40000000-0000-4000-8000-000000000011' THEN
  RAISE EXCEPTION 'story safety contract: before the work is done the final invoice never leads: % / %', s->'now', s->'loops';
 END IF;
 -- It is the job's only loop, so it ranks first; its status says it is not due yet,
 -- never open (an agent or reader reading the loops never sees it as a move).
 IF s->'loops'->0->>'status' IS DISTINCT FROM 'not_due' OR (s->'loops'->0->>'rank')::int <> 1 THEN
  RAISE EXCEPTION 'story safety contract: a final invoice before the work is done is not due, never open: %', s->'loops';
 END IF;
 -- The client story keeps that status and lists the loop after every loop due now on
 -- the client's other jobs, whatever its rank on its own job (the quote waiting on
 -- SWF-T4017 is newer, but due now).
 s := public.context_client_story('40000000-0000-4000-8000-000000000011', asof);
 IF (SELECT array_agg((l->>'job_number') || '=' || (l->>'rule') || '=' || (l->>'status') ORDER BY o)
     FROM jsonb_array_elements(s->'open_loops') WITH ORDINALITY x(l, o))
    IS DISTINCT FROM ARRAY['SWF-T4017=R7_quote_waiting=open', 'SWP-T4011=R8_not_yet_invoiced=not_due'] THEN
  RAISE EXCEPTION 'story safety contract: the client story lists a loop not due after the loops due now: %', s->'open_loops';
 END IF;
 -- Each record that disagrees with the job value is a C2 check, and R8 is then unconfirmed.
 SELECT string_agg(l.job_id::text || '=' || l.what, ' | ' ORDER BY l.job_id) INTO got
 FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000012', '40000000-0000-4000-8000-000000000013',
   '40000000-0000-4000-8000-000000000014', '40000000-0000-4000-8000-000000000015', '40000000-0000-4000-8000-000000000016']::uuid[], asof) l
 WHERE l.rule = 'C2_value_mismatch';
 IF got IS DISTINCT FROM
    '40000000-0000-4000-8000-000000000012=Invoice INV-4012 says it is a share of $14,527.51; the job value is $14,161.11 (pricing_json.totalIncGST) | '
    || '40000000-0000-4000-8000-000000000013=Deposit invoice INV-4013 is 50% of the price, which makes the price $3,190.00; the job value is $10,515.26 (pricing_json.totalIncGST) | '
    || '40000000-0000-4000-8000-000000000014=The job value $10,515.26 (pricing_json.totalIncGST) comes from quote without a number v1; '
    || 'the app has no record of this quote being sent | '
    || '40000000-0000-4000-8000-000000000015=Final invoice INV-4016 is issued and the issued invoices total $10,122.50, $5,377.50 less than the job value $15,500.00 (pricing_json.totalIncGST) | '
    || '40000000-0000-4000-8000-000000000016=The newest sent quote Q-4016 v4 is $9,509.50; the job value is $10,406.00 (pricing_json.totalIncGST)' THEN
  RAISE EXCEPTION 'story safety contract: C2 must name each record that disagrees with the job value: %', got;
 END IF;
 SELECT count(*) INTO n FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000012', '40000000-0000-4000-8000-000000000013',
   '40000000-0000-4000-8000-000000000014', '40000000-0000-4000-8000-000000000015', '40000000-0000-4000-8000-000000000016']::uuid[], asof) l
 WHERE l.rule = 'R8_not_yet_invoiced' AND l.amount IS NULL AND l.what LIKE '% is unconfirmed (check C2); issued invoices %; what is left to invoice is not known';
 IF n <> 5 THEN RAISE EXCEPTION 'story safety contract: R8 on an unconfirmed job value states no amount (% of 5)', n; END IF;
 SELECT * INTO r FROM public.context_job_record_money(ARRAY['40000000-0000-4000-8000-000000000012'::uuid], asof) mm;
 IF r.not_yet_invoiced IS NOT NULL OR r.job_value_basis NOT LIKE 'pricing_json.totalIncGST (unconfirmed%' THEN
  RAISE EXCEPTION 'story safety contract: the money rows never state an unconfirmed amount: %', row_to_json(r);
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000015', asof);
 IF s->'money'->'not_yet_invoiced'->>'amount' IS NOT NULL OR NOT (s->'money'->'not_yet_invoiced'->>'unconfirmed')::boolean
    OR position('the job value is unconfirmed (check C2)' IN s->'money'->>'line') = 0
    OR s->'now'->>'line' LIKE '%5,377.50%' OR position('unconfirmed' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: an unconfirmed amount is never stated as fact: % / %', s->'money', s->'now'->>'line';
 END IF;
 -- Overdue and due invoices are owed by whoever they are addressed to.
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000021'::uuid], asof) l WHERE l.rule = 'R1_overdue';
 IF r.owner IS DISTINCT FROM 'third_party'
    OR r.what IS DISTINCT FROM 'INV-4022 $1,850.40 overdue from Neighbour Payer (another payer, not this job''s customer) since Wed 29 Jul 2026 (70 days)' THEN
  RAISE EXCEPTION 'story safety contract: another payer''s overdue invoice is theirs, named so: %', row_to_json(r);
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000021', asof);
 IF s->'now'->>'whose_move' <> 'third_party' OR position('Waiting on another party, another payer owes: INV-4022' IN s->'now'->>'line') = 0
    OR s->'now'->>'line' LIKE '%the customer owes%' THEN
  RAISE EXCEPTION 'story safety contract: the first line names the payer who owes: %', s->'now';
 END IF;
 SELECT string_agg(l.source_id || '=' || l.owner || '=' || (l.what LIKE '%(a neighbour paying part of this job)%')::text, ',' ORDER BY l.source_id) INTO got
 FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000022'::uuid], asof) l WHERE l.rule = 'M1_money_due';
 IF got IS DISTINCT FROM '40c00000-0000-4000-8000-000000000031=customer=false,40c00000-0000-4000-8000-000000000032=third_party=true' THEN
  RAISE EXCEPTION 'story safety contract: a neighbour party''s invoice is theirs: %', got;
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000022', asof);
 IF position('Owing $2,703.26: INV-4031 $1,351.63 owed by Client P2 due Sat 10 Oct; INV-4032 $1,351.63 owed by Neighbour P2 (a neighbour paying part of this job) due Sat 10 Oct'
             IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: the first line names both payers, each invoice and its due date: %', s->'now'->>'line';
 END IF;
 -- Whose move and the invoice the line names agree: the customer and a neighbour both
 -- owe, due the same day, and the neighbour's invoice id sorts first. It is the
 -- customer's move, and the line and the next item name the customer's invoice, never
 -- the neighbour's.
 s := public.context_job_story('40000000-0000-4000-8000-000000000026', asof);
 IF s->'now'->>'whose_move' <> 'customer' OR position('The customer''s move, the customer owes: INV-4027 $1,351.63 owing from Client P6' IN s->'now'->>'line') = 0
    OR s->'now'->>'line' LIKE '%another payer owes%'
    OR NOT s->'now'->'next'->'cites' @> '[{"t": "xero_invoices", "id": "40c00000-0000-4000-8000-000000000027"}]'::jsonb
    OR position('Owing $2,703.26: INV-4026 $1,351.63 owed by Neighbour P6 (a neighbour paying part of this job) due Sat 10 Oct; INV-4027 $1,351.63 owed by Client P6 due Sat 10 Oct'
                IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: the customer''s move names the customer''s invoice, never a neighbour''s: % / %', s->'now', s->'loops';
 END IF;
 -- Only a neighbour owes and the move is ours (a draft to the customer not issued): the
 -- owing words name the neighbour and their role beside the invoice, so it never reads as
 -- the customer's next to "Our move" (SWF-26677 class).
 s := public.context_job_story('40000000-0000-4000-8000-000000000028', asof);
 IF s->'now'->>'whose_move' <> 'us'
    OR position('Owing $1,190.75 ($1,190.75 overdue): INV-4081 $1,190.75 owed by Neighbour P8 (a neighbour paying part of this job) overdue since Tue 15 Sep (22 days), 1 draft invoice not issued. Our move, we owe: Draft invoice INV-4082'
                IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: a neighbour''s invoice beside our move names the neighbour: % / %', s->'now', s->'loops';
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000023', asof);
 IF NOT s->'who' @> '[{"name":"Home Owner","role":"insured"},{"name":"Builder Co","role":"customer"}]'::jsonb
    OR s->'who' @> '[{"name":"Home Owner","role":"customer"}]'::jsonb
    OR position('the customer owes: INV-4023 $2,882.00 owing from Builder Co (the builder), due Mon 12 Oct 2026' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: on builder work the builder is the customer: % / %', s->'who', s->'now'->>'line';
 END IF;
 -- A quote waiting reads as waiting on the customer, never as money owed.
 s := public.context_job_story('40000000-0000-4000-8000-000000000024', asof);
 IF position('waiting on the customer: Quote Q-4024 v1 sent' IN s->'now'->>'line') = 0 OR s->'now'->>'line' LIKE '%owes: Quote%' THEN
  RAISE EXCEPTION 'story safety contract: a waiting quote is not money owed: %', s->'now'->>'line';
 END IF;
 -- A supplier bill shared with other jobs says so, with this job's lines.
 SELECT t.what INTO got FROM public.context_job_record_timeline(ARRAY['40000000-0000-4000-8000-000000000025'::uuid], asof) t WHERE t.kind = 'supplier_bill';
 IF got IS DISTINCT FROM 'Supplier bill BILL-4025 from A Supplier: total $1,081.60, shared with other jobs (this job''s lines $504.00), paid (money we owed)' THEN
  RAISE EXCEPTION 'story safety contract: a shared supplier bill gives this job''s share: %', got;
 END IF;
 SELECT * INTO r FROM public.context_job_record_money(ARRAY['40000000-0000-4000-8000-000000000025'::uuid], asof) mm;
 IF NOT coalesce((r.supplier_bills->0->>'shared')::boolean, false) OR coalesce((r.supplier_bills->0->>'job_share')::numeric, 0) <> 504.00 THEN
  RAISE EXCEPTION 'story safety contract: the money rows carry the shared bill''s share: %', r.supplier_bills;
 END IF;

 -- 4. Who and when. A backfilled CRM text is timed by the CRM.
 SELECT m2.at INTO r FROM public.context_job_record_messages(ARRAY['40000000-0000-4000-8000-000000000031'::uuid], asof) m2
 WHERE m2.source_id = '40b00000-0000-4000-8000-000000000031';
 IF r.at IS DISTINCT FROM '2026-09-20 01:00Z'::timestamptz THEN
  RAISE EXCEPTION 'story safety contract: a backfilled CRM text is timed by the CRM: %', r.at;
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000031', asof);
 IF (s->'last_exchange'->'customer_said'->>'at')::timestamptz IS DISTINCT FROM '2026-09-20 01:00Z'::timestamptz
    OR s->'now'->>'line' LIKE '%wrote last%'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(s->'checks') k WHERE k->>'rule' = 'R5_customer_wrote_last') THEN
  RAISE EXCEPTION 'story safety contract: answered on 25 Sep, the 20 Sep text is not the customer writing last: % / %', s->'last_exchange', s->'now'->>'line';
 END IF;
 -- Texts the CRM dates before the job's lead window are never this customer's words.
 SELECT string_agg(m2.source_id || '=' || m2.placement || '=' || m2.customer_side::text, ',' ORDER BY m2.source_id) INTO got
 FROM public.context_job_record_messages(ARRAY['40000000-0000-4000-8000-000000000032'::uuid], asof) m2;
 IF got IS DISTINCT FROM '40b00000-0000-4000-8000-000000000033=before_job=false,40b00000-0000-4000-8000-000000000034=before_job=false' THEN
  RAISE EXCEPTION 'story safety contract: texts from before the job''s lead window are not the customer''s side: %', got;
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000032', asof);
 IF s->'last_exchange'->'customer_said' <> 'null'::jsonb OR s->'last_exchange'->'we_told_customer' <> 'null'::jsonb
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(s->'timeline') t WHERE t->>'kind' = 'first_contact')
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'not_known') k
                   WHERE k->>'what' = '2 texts on this job are dated by the CRM more than 30 days before the job was created; they are not read as this customer''s words.') THEN
  RAISE EXCEPTION 'story safety contract: another person''s earlier texts are no last word or first contact: % / %', s->'last_exchange', s->'not_known';
 END IF;
 -- Ghost and observer rows are copies, never "Booking made".
 SELECT string_agg(right(t.source_id, 2) || '=' || t.kind, ',' ORDER BY t.source_id) INTO got
 FROM public.context_job_record_timeline(ARRAY['40000000-0000-4000-8000-000000000033'::uuid], asof) t WHERE t.source_table = 'job_events';
 IF got IS DISTINCT FROM '01=booking_change,02=booking_mirror,03=booking_mirror' THEN
  RAISE EXCEPTION 'story safety contract: a ghost or observer booking is a copy: %', got;
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000033', asof);
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(s->'timeline') t WHERE t->>'what' LIKE 'Booking made for Mon 5 Oct%' OR t->>'what' LIKE 'Booking made for Tue 6 Oct%') THEN
  RAISE EXCEPTION 'story safety contract: the story never shows a copy as a booking made: %', s->'timeline';
 END IF;
 -- Work is done only on a completion status or record, never because a booking is complete.
 s := public.context_job_story('40000000-0000-4000-8000-000000000034', asof);
 IF s->'now'->>'phase' <> 'install' OR s->'now'->>'line' LIKE 'Work done%' OR s->'now'->>'line' LIKE '%Work complete%'
    OR position('the Thu 24 Sep booking is marked complete; nothing records the job finished' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: a booking marked complete is not finished work: %', s->'now';
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000035', asof);
 IF s->'now'->>'phase' <> 'complete' OR s->'now'->>'line' NOT LIKE 'Work complete since Fri 2 Oct%' THEN
  RAISE EXCEPTION 'story safety contract: a completion record finishes the work: %', s->'now';
 END IF;

 -- 5. The first line says what the records show.
 s := public.context_job_story('40000000-0000-4000-8000-000000000041', asof);
 IF position('attendance not recorded for Mon 5 Oct' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: a passed booking with no attendance is named: %', s->'now'->>'line';
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000042', asof);
 IF position('Owing $500.00: INV-4042 $500.00 due Wed 14 Oct' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: the invoice owing is named with its due date: %', s->'now'->>'line';
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000043', asof);
 IF s->'now'->>'line' NOT LIKE 'Report pack sent to the builder Tue 29 Sep, payment owing; attended Wed 23 Sep%' THEN
  RAISE EXCEPTION 'story safety contract: a report pack sent is named: %', s->'now'->>'line';
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000044', asof);
 IF position('The customer declined quote Q-4044 v1 on Fri 25 Sep' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: a declined quote is named: %', s->'now'->>'line';
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000045', asof);
 -- (owner's ruling: "not yet checked by the reader", never "not read yet")
 IF position('The customer wrote last on Fri 2 Oct; not yet checked by the reader: "We have decided to wait until next year"' IN s->'now'->>'line') = 0
    OR s->'now'->>'line' LIKE '%not read yet%' THEN
  RAISE EXCEPTION 'story safety contract: the customer''s unread words reach the first line: %', s->'now'->>'line';
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000046', asof);
 IF position('The customer wrote Mon 5 Oct after the booking was made: "Could you also price a second gate?"' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: a request made after the booking reaches the first line: %', s->'now'->>'line';
 END IF;

 -- 6. Only an automated chaser went to the customer: it is kept, never our reply.
 s := public.context_job_story('40000000-0000-4000-8000-000000000047', asof);
 IF s->'last_exchange'->'we_told_customer'->'newer_automated'->>'id' IS DISTINCT FROM '40b00000-0000-4000-8000-000000000048'
    OR NOT (s->'last_exchange'->'we_told_customer'->>'only_automated')::boolean OR s->'last_exchange'->'we_told_customer' ? 'id' THEN
  RAISE EXCEPTION 'story safety contract: an automated send that was the only one is kept: %', s->'last_exchange';
 END IF;

 -- 7. The client story counts what the client's own Xero contact owes on another client's job.
 s := public.context_client_story('40000000-0000-4000-8000-000000000051', asof);
 IF (s->'money'->>'owing')::numeric <> 2689.60 OR (s->'money'->>'overdue')::numeric <> 2689.60
    OR s->'money'->'other_jobs'->0->>'job_number' IS DISTINCT FROM 'SWF-T4052'
    OR (SELECT x->'job_numbers' FROM jsonb_array_elements(s->'money'->'by_party') x WHERE x->>'xero_contact_id' = 'x40-c7a')
       IS DISTINCT FROM '["SWF-T4051", "SWF-T4052"]'::jsonb
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'not_known') k
                   WHERE k->>'what' = 'Owing includes $1,850.40 this client owes as a payer on another client''s job (SWF-T4052).') THEN
  RAISE EXCEPTION 'story safety contract: the client story counts the client''s Xero contact on another job: % / %', s->'money', s->'not_known';
 END IF;
 -- the other client's story keeps that debt as another payer's, never the client's own: the
 -- client owes nothing (fourth review: it used to add every payer's debt on their jobs)
 s := public.context_client_story('40000000-0000-4000-8000-000000000052', asof);
 IF coalesce(jsonb_array_length(s->'money'->'other_jobs'), -1) <> 0 OR (s->'money'->>'owing')::numeric <> 0
    OR (s->'money'->>'overdue')::numeric <> 0 OR (s->'money'->'owed_by_others'->>'owing')::numeric IS DISTINCT FROM 1850.40
    OR (SELECT (x->>'owing')::numeric FROM jsonb_array_elements(s->'money'->'by_party') x WHERE x->>'xero_contact_id' = 'x40-c7b') <> 0
    OR (SELECT (x->>'owing')::numeric FROM jsonb_array_elements(s->'money'->'by_party') x WHERE x->>'xero_contact_id' = 'x40-c7a') <> 1850.40 THEN
  RAISE EXCEPTION 'story safety contract: another payer''s debt on the client''s job is never the client''s: %', s->'money';
 END IF;
END $safety$;

-- 7 (continued). A job's only paying contact is the client's own only when every invoice to
-- it names it as the client and it is billed on no builder work: the builder billed for
-- homeowner nine's private job (SWF-261343 class) never makes the builder's make-safe or
-- homeowner eleven's job homeowner nine's debt, and an agent named otherwise who paid tenant
-- thirteen's job never makes the agent's invoice on client fifteen's job the tenant's. Only
-- invoices still owing count (client seven's paid one names no job), and never on builder
-- work (the payer client's own contact billed on a make-safe).
DO $builder$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; s jsonb;
BEGIN
 s := public.context_client_story('40000000-0000-4000-8000-000000000053', asof);
 IF coalesce(jsonb_array_length(s->'money'->'other_jobs'), -1) <> 0 OR (s->'money'->>'owing')::numeric <> 0
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(s->'money'->'by_party') x WHERE x->>'xero_contact_id' = 'x40-bld9' AND (x->>'owing')::numeric <> 0)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(s->'not_known') k WHERE k->>'what' LIKE 'Owing includes %') THEN
  RAISE EXCEPTION 'story safety contract: a builder billed for a homeowner''s private job is never the homeowner: % / %', s->'money', s->'not_known';
 END IF;
 s := public.context_client_story('40000000-0000-4000-8000-000000000057', asof);
 IF coalesce(jsonb_array_length(s->'money'->'other_jobs'), -1) <> 0 OR (s->'money'->>'owing')::numeric <> 0 THEN
  RAISE EXCEPTION 'story safety contract: a payer not named as the client is never the client''s own contact: %', s->'money';
 END IF;
 s := public.context_client_story('40000000-0000-4000-8000-000000000051', asof);
 IF (SELECT array_agg(x->>'job_number' ORDER BY o) FROM jsonb_array_elements(s->'money'->'other_jobs') WITH ORDINALITY y(x, o))
    IS DISTINCT FROM ARRAY['SWF-T4052']
    OR (SELECT x->'job_numbers' FROM jsonb_array_elements(s->'money'->'by_party') x WHERE x->>'xero_contact_id' = 'x40-c7a')
       IS DISTINCT FROM '["SWF-T4051", "SWF-T4052"]'::jsonb THEN
  RAISE EXCEPTION 'story safety contract: a paid invoice on another client''s job is no debt and names no job: %', s->'money';
 END IF;
 -- (the neighbour payer's invoice on the client's own job is theirs, not the client's: fourth review)
 s := public.context_client_story('40000000-0000-4000-8000-000000000021', asof);
 IF coalesce(jsonb_array_length(s->'money'->'other_jobs'), -1) <> 0 OR (s->'money'->>'owing')::numeric <> 0
    OR (s->'money'->'owed_by_others'->>'owing')::numeric IS DISTINCT FROM 1850.40 THEN
  RAISE EXCEPTION 'story safety contract: builder work is never the client''s debt as a payer elsewhere, nor another payer''s on their job: %', s->'money';
 END IF;
END $builder$;

-- 4 (continued). The reader's evidence and the citation check time a CRM text loaded later
-- by the CRM's own time, as the story does (landed when loaded), and leave out one from
-- before the job's lead window (SWF-261419's June texts by another person): never this
-- job's evidence, never cited. The judge reads such a never-read job in full and finds it
-- has no evidence, never a backfill of nothing.
DO $crmtime$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; r record; chk jsonb; jd record; got text;
 b1 constant uuid := '40000000-0000-4000-8000-000000000031'; b2 constant uuid := '40000000-0000-4000-8000-000000000032';
BEGIN
 SELECT e.at, e.landed_at, (SELECT greatest(coalesce(b.context_captured_at, b.recorded_at, b.occurred_at), b.attributed_at) FROM public.business_events b
                            WHERE b.id = e.src_id) AS loaded
 INTO r FROM public.context_ledger_evidence_rows(ARRAY[b1], asof) e WHERE e.src_id = '40b00000-0000-4000-8000-000000000031';
 IF r.at IS DISTINCT FROM '2026-09-20 01:00Z'::timestamptz OR r.landed_at IS DISTINCT FROM r.loaded THEN
  RAISE EXCEPTION 'story safety contract: the reader''s evidence times a CRM text loaded later by the CRM: %', row_to_json(r);
 END IF;
 SELECT string_agg(e.src_id::text, ',' ORDER BY e.src_id) INTO got FROM public.context_ledger_evidence_rows(ARRAY[b2], asof) e;
 IF got IS NOT NULL THEN
  RAISE EXCEPTION 'story safety contract: texts from before the job''s lead window are not the reader''s evidence: %', got;
 END IF;
 chk := public.context_ledger_cite(b2, '{"table":"business_events","id":"40b00000-0000-4000-8000-000000000034","excerpt":"June words from someone else"}');
 IF coalesce((chk->>'ok')::boolean, true) OR chk->>'code' IS DISTINCT FROM 'citation_not_admissible' THEN
  RAISE EXCEPTION 'story safety contract: a text from before the job''s lead window is never cited: %', chk;
 END IF;
 chk := public.context_ledger_cite(b1, '{"table":"business_events","id":"40b00000-0000-4000-8000-000000000031","excerpt":"Can we start Monday?"}');
 IF NOT coalesce((chk->>'ok')::boolean, false) OR (chk->>'at')::timestamptz IS DISTINCT FROM '2026-09-20 01:00Z'::timestamptz THEN
  RAISE EXCEPTION 'story safety contract: the citation check times a CRM text loaded later by the CRM, as the evidence does: %', chk;
 END IF;
 UPDATE public.context_ledger_settings SET mode = 'shadow', calls_per_day = 50, reader = 'luna-ledger:v1', job_ids = NULL;
 UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1;
 SELECT * INTO jd FROM public.context_ledger_judge(ARRAY[b2]);
 IF coalesce(jd.due, true) OR jd.blocked_reason IS DISTINCT FROM 'no_evidence' OR jd.evidence_rows IS DISTINCT FROM 0 THEN
  RAISE EXCEPTION 'story safety contract: a never-read job whose only rows are from before its lead window has no evidence: %', to_jsonb(jd);
 END IF;
END $crmtime$;

-- 2 (continued). not_known counts the old-inbox mail the story shows whose saved copy sits
-- elsewhere: on job N, i6 (its copy on another job) and i8 (from the client's address on no
-- job, its copy on no job); never i9 (the record shows one mail per instant) nor i7 (an email
-- on N at its instant hides it), which the count of every inbox row on the job with a copy
-- elsewhere took in (3, with i8 left out).
DO $mailcount$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; s jsonb; got text;
 n constant uuid := '40000000-0000-4000-8000-000000000003';
BEGIN
 SELECT string_agg(right(x.id::text, 2), ',' ORDER BY x.id) INTO got FROM public.context_job_record_legacy_mail(ARRAY[n], asof) x WHERE x.placement <> 'withheld';
 s := public.context_job_story(n, asof);
 IF got IS DISTINCT FROM '06,08'
    OR (SELECT count(*) FROM jsonb_array_elements(s->'not_known') k
        WHERE k->>'what' = '2 emails on this job are shown from the old inbox: their saved copies are on another job or on no job yet.') <> 1 THEN
  RAISE EXCEPTION 'story safety contract: the old-inbox count is the mail the story shows (%): %', got, s->'not_known';
 END IF;
END $mailcount$;

-- 1 (continued, the record). C11 on a mail brought back from the old inbox says where its
-- saved copy sits, never "stored only in the old inbox" (a copy of it is stored elsewhere).
DO $c11$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; got text;
BEGIN
 SELECT string_agg(right(l.job_id::text, 2) || '=' || l.what, ' | ' ORDER BY l.job_id) INTO got
 FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000003']::uuid[], asof) l
 WHERE l.rule = 'C11_customer_mail_unanswered';
 IF got IS DISTINCT FROM '01=Customer emailed Sat 3 Oct 09:00 (from the old inbox; its saved copy is on another job) and nothing went to the customer since: '
                         || '"ETA | When will you arrive?" | 03=Customer emailed Fri 2 Oct 09:00 (from the old inbox, not placed on any job; its saved copy '
                         || 'is on no job yet) and nothing went to the customer since: "Colour | Is green available?"' THEN
  RAISE EXCEPTION 'story safety contract: C11 says where a brought-back mail''s saved copy sits: %', got;
 END IF;
END $c11$;

-- 2 (continued). The copy read finds each key: K's i10 by an inbound email from its sender
-- at its instant (captured a week later, on another job), i11 by an old-path copy (no
-- source table, its id in the payload, at its instant, no channel) on no job, i12 by an
-- internal email on another job; N's i6 by its source pointer and i8 by its graph key. Each
-- joined no earlier than the rule's first apply and its copy's landing, and the reader's
-- evidence on K gives each that time.
DO $copies$
DECLARE got text; since constant timestamptz := public.context_ledger_mail_rule_since();
BEGIN
 SELECT string_agg(right(c.mail_id::text, 2) || '=' || coalesce(right(c.copy_job_id::text, 2), 'none') || '='
                   || (c.joined_at = greatest(since, CASE right(c.mail_id::text, 2) WHEN '10' THEN '2026-10-02 03:00Z'::timestamptz
                                                     WHEN '11' THEN '2026-09-26 01:01Z' WHEN '12' THEN '2026-10-02 03:00Z'
                                                     WHEN '06' THEN '2026-10-01 01:05Z' ELSE '2026-10-02 01:05Z' END))::text,
                   ',' ORDER BY c.mail_id, c.copy_job_id)
 INTO got
 FROM public.context_ledger_mail_copies(ARRAY['40a00000-0000-4000-8000-000000000010', '40a00000-0000-4000-8000-000000000011',
   '40a00000-0000-4000-8000-000000000012', '40a00000-0000-4000-8000-000000000006', '40a00000-0000-4000-8000-000000000008']::uuid[]) c;
 IF got IS DISTINCT FROM '06=02=true,08=none=true,10=02=true,11=none=true,12=02=true' THEN
  RAISE EXCEPTION 'story safety contract: the copy read must find each copy key: %', got;
 END IF;
 SELECT string_agg(right(e.src_id::text, 2) || '=' || (e.landed_at >= since)::text, ',' ORDER BY e.at) INTO got
 FROM public.context_ledger_evidence_rows(ARRAY['40000000-0000-4000-8000-000000000004'::uuid], '2026-10-07 02:00Z') e;
 IF got IS DISTINCT FROM '10=true,11=true,12=true' THEN
  RAISE EXCEPTION 'story safety contract: mail kept for a copy elsewhere joined K''s evidence then: %', got;
 END IF;
END $copies$;

-- 2 (continued). A mail this rule brings back joined job M's evidence no earlier than the
-- rule's first apply and its saved copy's own landing where it sits, never when the mail
-- itself landed. A live reading of M built on Mon 5 Oct, before that, never read i1 (copy
-- on another job) or i2 (copy on no job): its story counts both unread, gives no all-clear
-- and never says the reader judged them, its update packet gives them as unread, and the
-- judge and the due read list M. A mail with no copy and a copy on M keep their own times.
DO $readmit$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; s jsonb; pk jsonb; jd record; got text; g uuid; gs uuid;
 m constant uuid := '40000000-0000-4000-8000-000000000001';
 i1 constant text := '40a00000-0000-4000-8000-000000000001';
BEGIN
 UPDATE public.context_ledger_settings SET mode = 'shadow', calls_per_day = 50, reader = 'luna-ledger:v1', job_ids = NULL;
 UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1;
 INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, evidence_until, promoted_at, created_at, finished_at, updated_at, checks)
 VALUES (m, 'backfill', 'live', 'luna-ledger:v1', '2026-10-05 00:00Z', '2026-10-05 00:10Z', '2026-10-04 23:00Z', '2026-10-05 00:10Z',
         '2026-10-05 00:10Z', '{"passed": true, "store": {"pass": true}}')
 RETURNING id INTO g;
 s := public.context_job_story(m, asof);
 IF (s->'meta'->'ledger'->>'unread_rows')::int IS DISTINCT FROM 2 OR s->'now'->>'whose_move' IS DISTINCT FROM 'unknown'
    OR s->'now'->>'line' LIKE '%Nothing open%'
    OR position('The customer wrote last on Sat 3 Oct; not yet checked by the reader: "ETA | When will you arrive?"' IN s->'now'->>'line') = 0
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(s->'checks') k
               WHERE k->'cites' @> jsonb_build_array(jsonb_build_object('t', 'inbox_events', 'id', i1)) AND k->>'what' LIKE '%the reader judged%')
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'checks') k
                   WHERE k->'cites' @> jsonb_build_array(jsonb_build_object('t', 'inbox_events', 'id', i1))
                     AND k->>'what' LIKE 'Customer wrote last; not yet checked by the reader.%') THEN
  RAISE EXCEPTION 'story safety contract: a live reading from before the mail was brought back never read it: % / % / %',
   s->'now', s->'meta'->'ledger', s->'checks';
 END IF;
 pk := public.context_ledger_packet(m, '2026-10-05 00:00Z', asof);
 SELECT string_agg(right(x->>'id', 2) || '=' || (x->>'already_read'), ',' ORDER BY o) INTO got
 FROM jsonb_array_elements(pk->'evidence') WITH ORDINALITY y(x, o);
 IF got IS DISTINCT FROM '04=true,03=true,02=false,01=false' THEN
  RAISE EXCEPTION 'story safety contract: the update packet must give the mail brought back as unread: %', got;
 END IF;
 SELECT * INTO jd FROM public.context_ledger_judge(ARRAY[m]);
 IF NOT coalesce(jd.due, false) OR jd.kind IS DISTINCT FROM 'update' OR jd.reason IS DISTINCT FROM 'new_evidence' OR jd.blocked_reason IS NOT NULL THEN
  RAISE EXCEPTION 'story safety contract: the judge must list a job whose live reading never read the mail brought back: %', to_jsonb(jd);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.context_ledger_due(200) d WHERE d.job_id = m AND d.reason = 'new_evidence') THEN
  RAISE EXCEPTION 'story safety contract: the due read must list that job as the judge does';
 END IF;
 SELECT string_agg(right(e.src_id::text, 2) || '=' || CASE
          WHEN e.src_id::text = i1 THEN (e.landed_at = greatest(public.context_ledger_mail_rule_since(), '2026-10-03 01:05Z'::timestamptz))::text
          WHEN e.src_id = '40a00000-0000-4000-8000-000000000002' THEN (e.landed_at = greatest(public.context_ledger_mail_rule_since(), '2026-10-02 01:05Z'::timestamptz))::text
          WHEN e.src_table = 'inbox_events' THEN (e.landed_at = '2026-09-29 01:00Z')::text
          ELSE (e.landed_at = '2026-09-30 01:05Z')::text END, ',' ORDER BY e.at) INTO got
 FROM public.context_ledger_evidence_rows(ARRAY[m], asof) e;
 IF got IS DISTINCT FROM '04=true,03=true,02=true,01=true' THEN
  RAISE EXCEPTION 'story safety contract: when each row joined M''s evidence: %', got;
 END IF;
 -- A reading after the rule's first apply has read both; once i1's copy is placed on another
 -- job after that reading, i1 is new to read again (and only i1).
 UPDATE public.context_ledger_generations SET evidence_until = public.context_ledger_mail_rule_since() + interval '1 second' WHERE id = g;
 UPDATE public.business_events SET attributed_at = public.context_ledger_mail_rule_since() + interval '2 seconds'
 WHERE id = '40b00000-0000-4000-8000-000000000001';
 s := public.context_job_story(m, asof);
 IF (s->'meta'->'ledger'->>'unread_rows')::int IS DISTINCT FROM 1 OR s->'now'->>'whose_move' IS DISTINCT FROM 'unknown'
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'checks') k
                   WHERE k->'cites' @> jsonb_build_array(jsonb_build_object('t', 'inbox_events', 'id', i1))
                     AND k->>'what' LIKE 'Customer wrote last; not yet checked by the reader.%') THEN
  RAISE EXCEPTION 'story safety contract: a mail whose copy moved after the reading is new to read: % / %', s->'now', s->'meta'->'ledger';
 END IF;
 -- (fourth review) A shadow reading of M asked for by id that has read every row reads as its
 -- promotion will (the grade reads the proof jobs' shadows so): nothing open is nobody's move,
 -- the reader's judgement of the customer's mail stands, and its commitments are counted.
 INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, evidence_until, created_at, finished_at, updated_at, checks)
 VALUES (m, 'rebuild', 'shadow', 'luna-ledger:v1', public.context_ledger_mail_rule_since() + interval '1 hour', '2026-10-06 00:00Z',
         '2026-10-06 00:10Z', '2026-10-06 00:10Z', '{"passed": true, "store": {"pass": true}}')
 RETURNING id INTO gs;
 s := public.context_job_story(m, asof, gs);
 IF s->'meta'->'ledger'->>'status' IS DISTINCT FROM 'shadow' OR (s->'meta'->'ledger'->>'unread_rows')::int IS DISTINCT FROM 0
    OR s->'now'->>'whose_move' IS DISTINCT FROM 'nobody' OR position('Nothing open on record' IN s->'now'->>'line') = 0
    OR s->'handling'->'commitments' IS DISTINCT FROM '{"kept": 0, "late": 0, "open": 0, "overdue": 0}'::jsonb
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'checks') k
                   WHERE k->'cites' @> jsonb_build_array(jsonb_build_object('t', 'inbox_events', 'id', i1))
                     AND k->>'what' LIKE 'Customer wrote last; the reader judged no reply is needed.%') THEN
  RAISE EXCEPTION 'story safety contract: a shadow asked for by id that has read every row reads as its promotion will: % / % / %',
   s->'now', s->'meta'->'ledger', s->'handling';
 END IF;
END $readmit$;

-- Fourth review fixtures. 3: an invoice placed elsewhere that names the job (U: the builder's
-- invoice and a draft placed on no job, and one naming a longer job number; S: the remainder
-- billed on the sibling job T); D: a deposit and a balance both naming a $3,790.60 base
-- against a stale job value, the balance overdue. 1: the customer in touch after a quote in
-- ways that do not close it (C: an answered call on the job; X: a text placed on no job);
-- the no-reader line's contact facts (P: newer messages placed on no job; Q: only such a
-- message; W: mail withheld because the client has another job). 4: make-safes finished in
-- June by their records alone (J; K re-attended after); H: a status history entering
-- complete. 7: a homeowner on builder work (B).
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, client_email, ghl_contact_id, xero_contact_id, pricing_json,
  accepted_at, completed_at, created_at)
VALUES
 ('40000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-0000000000aa', 'SWF-94061', 'invoiced', 'repair', 'Builder Home',
  NULL, 'ct40u1', NULL, '{"totalIncGST": 6237}', '2026-08-01 01:00Z', '2026-09-02 01:00Z', '2026-07-20 01:00Z'),
 ('40000000-0000-4000-8000-000000000062', '00000000-0000-4000-8000-0000000000aa', 'SWF-94062', 'final_payment', 'fencing', 'Sibling Client',
  NULL, 'ct40s', NULL, '{"totalIncGST": 1922.81}', '2026-07-01 01:00Z', NULL, '2026-06-20 01:00Z'),
 ('40000000-0000-4000-8000-000000000063', '00000000-0000-4000-8000-0000000000aa', 'SWF-94063', 'final_payment', 'fencing', 'Sibling Client',
  NULL, 'ct40s', NULL, '{}', '2026-07-01 01:00Z', NULL, '2026-06-20 01:00Z'),
 ('40000000-0000-4000-8000-000000000066', '00000000-0000-4000-8000-0000000000aa', 'SWP-94066', 'invoiced', 'patio', 'Deposit Base Client',
  NULL, 'ct40db', NULL, '{"totalIncGST": 6298.71}', NULL, '2026-09-24 01:00Z', '2026-08-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000071', '00000000-0000-4000-8000-0000000000aa', 'SWF-94071', 'quoted', 'fencing', 'Called Client',
  NULL, 'ct40cc', NULL, '{}', NULL, NULL, '2026-07-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000072', '00000000-0000-4000-8000-0000000000aa', 'SWF-94072', 'quoted', 'fencing', 'Texted Client',
  NULL, 'ct40tt', NULL, '{}', NULL, NULL, '2026-08-20 01:00Z'),
 ('40000000-0000-4000-8000-000000000073', '00000000-0000-4000-8000-0000000000aa', 'SWF-94073', 'accepted', 'fencing', 'Unplaced Client',
  NULL, 'ct40up', NULL, '{}', NULL, NULL, '2026-06-20 01:00Z'),
 ('40000000-0000-4000-8000-000000000074', '00000000-0000-4000-8000-0000000000aa', 'SWF-94074', 'accepted', 'fencing', 'Quiet Client',
  NULL, 'ct40qt', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000075', '00000000-0000-4000-8000-0000000000aa', 'SWF-94075', 'accepted', 'fencing', 'Two Jobs Client',
  'twojobs@example.test', 'ct40tj', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000076', '00000000-0000-4000-8000-0000000000aa', 'SWF-94076', 'archived', 'fencing', 'Two Jobs Client',
  'twojobs@example.test', 'ct40tj', NULL, '{}', NULL, NULL, '2026-05-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-0000000000aa', 'SWMS-94081', 'processing', 'makesafe', 'June Insured',
  NULL, NULL, 'x40-ms81', '{}', NULL, NULL, '2026-06-15 01:00Z'),
 ('40000000-0000-4000-8000-000000000082', '00000000-0000-4000-8000-0000000000aa', 'SWMS-94082', 'processing', 'makesafe', 'Reattend Insured',
  NULL, NULL, 'x40-ms82', '{}', NULL, NULL, '2026-06-15 01:00Z'),
 ('40000000-0000-4000-8000-000000000083', '00000000-0000-4000-8000-0000000000aa', 'SWF-94083', 'partially_accepted', 'fencing', 'History Client',
  NULL, 'ct40hc', NULL, '{}', NULL, '2026-07-30 03:33Z', '2026-06-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000091', '00000000-0000-4000-8000-0000000000aa', 'SWR-94091', 'processing', 'repair', 'Home Owner Two',
  NULL, 'ct40hb', 'x40-bldb', '{}', NULL, NULL, '2026-09-01 01:00Z');
INSERT INTO public.xero_invoices (org_id, id, job_id, xero_invoice_id, xero_contact_id, contact_name, invoice_number, invoice_type, status, reference,
  total, amount_due, amount_paid, invoice_date, due_date, fully_paid_on, line_items, raw_json, job_contact_id, created_at)
VALUES
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000161', NULL, 'x4161', 'x40-mlb', 'Builder MLB', 'INV-4161', 'ACCREC', 'AUTHORISED',
  'MLB-24319PO-56427', 5610.00, 5610.00, 0, '2026-09-14', '2026-09-28', NULL,
  '[{"Description":"Remove and replace the fence panels, SWF-94061 | 12 Example St","LineAmount":5100,"TaxAmount":510}]', '{"Status":"AUTHORISED"}', NULL, '2026-09-14 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000162', NULL, 'x4162', 'x40-mlb', 'Builder MLB', 'INV-4162', 'ACCREC', 'DRAFT',
  'MLB-24319PO-56427', 4565.00, 4565.00, 0, '2026-09-15', '2026-09-29', NULL,
  '[{"Description":"Remove and replace the fence panels, SWF-94061 | 12 Example St","LineAmount":4150,"TaxAmount":415}]', '{"Status":"DRAFT"}', NULL, '2026-09-15 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000163', NULL, 'x4163', 'x40-mlb', 'Builder MLB', 'INV-4163', 'ACCREC', 'AUTHORISED',
  'MLB-24320', 999.00, 999.00, 0, '2026-09-16', '2026-09-30', NULL,
  '[{"Description":"Fence for SWF-940611 only","LineAmount":908.18,"TaxAmount":90.82}]', '{"Status":"AUTHORISED"}', NULL, '2026-09-16 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000164', '40000000-0000-4000-8000-000000000062', 'x4164', 'x40-sib', 'Sibling Client',
  'INV-4164', 'ACCREC', 'DELETED', 'SWF-94062-DEP50', 961.40, 0, 0, '2026-07-02', '2026-07-09', NULL,
  '[{"Description":"Deposit (50% of $1,922.81 inc GST)\nSWF-94062 | Colorbond","LineAmount":874,"TaxAmount":87.4}]', '{"Status":"DELETED"}', NULL, '2026-07-02 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000165', '40000000-0000-4000-8000-000000000063', 'x4165', 'x40-sib', 'Sibling Client',
  'INV-4165', 'ACCREC', 'PAID', 'SWF-94063-FINBAL', 3228.50, 0, 3228.50, '2026-08-10', '2026-08-24', '2026-08-12',
  '[{"Description":"Remainder of quote SWF-94063 (50% of $5,709.00 inc GST) | Colorbond","LineAmount":2595,"TaxAmount":259.5},{"Description":"Remainder of quote SWF-94062 (50% of $748.01 inc GST) | Colorbond","LineAmount":340,"TaxAmount":34}]',
  '{"Status":"PAID","Payments":[]}', NULL, '2026-08-10 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000166', '40000000-0000-4000-8000-000000000066', 'x4166', 'x40-db', 'Deposit Base Client',
  'INV-4166', 'ACCREC', 'PAID', 'SWP-94066-DEP50', 1895.30, 0, 1895.30, '2026-08-05', '2026-08-12', '2026-08-06',
  '[{"Description":"Deposit (50% of $3,790.60 inc GST) / SWP-94066 | Polycarbonate","LineAmount":1723,"TaxAmount":172.3}]', '{"Status":"PAID","Payments":[]}', NULL, '2026-08-05 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000167', '40000000-0000-4000-8000-000000000066', 'x4167', 'x40-db', 'Deposit Base Client',
  'INV-4167', 'ACCREC', 'AUTHORISED', 'SWP-94066-FINBAL50', 1895.30, 1895.30, 0, '2026-09-25', '2026-10-02', NULL,
  '[{"Description":"Balance (50% of $3,790.60 inc GST) / SWP-94066 | Polycarbonate","LineAmount":1723,"TaxAmount":172.3}]', '{"Status":"AUTHORISED","Payments":[]}', NULL, '2026-09-25 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000181', '40000000-0000-4000-8000-000000000081', 'x4181', 'x40-ms81', 'MS Builder',
  'INV-4181', 'ACCREC', 'PAID', 'SWMS-94081', 500.50, 0, 500.50, '2026-07-06', '2026-07-20', '2026-08-03', NULL, '{"Status":"PAID","Payments":[]}', NULL, '2026-07-06 03:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000182', '40000000-0000-4000-8000-000000000082', 'x4182', 'x40-ms82', 'MS Builder',
  'INV-4182', 'ACCREC', 'PAID', 'SWMS-94082', 500.50, 0, 500.50, '2026-07-06', '2026-07-20', '2026-08-03', NULL, '{"Status":"PAID","Payments":[]}', NULL, '2026-07-06 03:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000183', '40000000-0000-4000-8000-000000000083', 'x4183', 'x40-hc', 'History Client',
  'INV-4183', 'ACCREC', 'PAID', 'SWF-94083', 3000.00, 0, 3000.00, '2026-07-30', '2026-08-06', '2026-08-01', NULL, '{"Status":"PAID","Payments":[]}', NULL, '2026-07-30 05:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000191', '40000000-0000-4000-8000-000000000091', 'x4191', 'x40-bldb', 'Builder B',
  'INV-4191', 'ACCREC', 'AUTHORISED', 'SWR-94091', 2882.00, 2882.00, 0, '2026-10-01', '2026-10-12', NULL, NULL, '{"Status":"AUTHORISED","Payments":[]}', NULL, '2026-10-01 01:00Z');
INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at, viewed_at, declined_at)
VALUES ('40e00000-0000-4000-8000-000000000071', '40000000-0000-4000-8000-000000000071', 'quote', 'Q-4071', 1, '2026-07-20 01:00Z', '2026-07-20 01:10Z', '2026-07-21 01:00Z', NULL),
       ('40e00000-0000-4000-8000-000000000072', '40000000-0000-4000-8000-000000000072', 'quote', 'Q-4072', 1, '2026-08-27 01:00Z', '2026-08-27 01:10Z', NULL, NULL);
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  attribution_status, attribution_confidence, candidate_job_ids)
VALUES
 -- C: the customer's answered call on the job a week after the quote
 ('40b00000-0000-4000-8000-000000000171', '40000000-0000-4000-8000-000000000071', 'client.call_logged', 'ghl', 'call', 'inbound', 'ct40cc',
  '{"body":"Call. Provider status: completed. Duration: 333 seconds","call_status":"completed"}',
  '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}', '2026-07-27 01:00Z', '2026-07-27 01:00Z', '2026-07-27 01:00Z', 'direct', 1, NULL),
 -- X: their text and our reply on the job before the quote; their text after it, placed on no job
 ('40b00000-0000-4000-8000-000000000172', '40000000-0000-4000-8000-000000000072', 'client.reply', 'ghl', 'sms', 'inbound', 'ct40tt',
  '{"body":"Can you quote the back fence?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-08-26 01:00Z', '2026-08-26 01:00Z', '2026-08-26 01:00Z', 'direct', 1, NULL),
 ('40b00000-0000-4000-8000-000000000173', '40000000-0000-4000-8000-000000000072', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct40tt',
  '{"body":"Yes, the quote is on its way"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
  '2026-08-27 00:30Z', '2026-08-27 00:30Z', '2026-08-27 00:30Z', 'direct', 1, NULL),
 ('40b00000-0000-4000-8000-000000000174', NULL, 'client.reply', 'ghl', 'sms', 'inbound', 'ct40tt',
  '{"body":"Can the price come down a little?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-09-24 01:00Z', '2026-09-24 01:00Z', '2026-09-24 01:00Z', 'unplaced', NULL, ARRAY['40000000-0000-4000-8000-000000000072'::uuid]),
 -- P: their text and our reply on the job in July; newer ones each way placed on no job
 ('40b00000-0000-4000-8000-000000000175', '40000000-0000-4000-8000-000000000073', 'client.reply', 'ghl', 'sms', 'inbound', 'ct40up',
  '{"body":"Thanks for the visit"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-07-01 01:00Z', '2026-07-01 01:00Z', '2026-07-01 01:00Z', 'direct', 1, NULL),
 ('40b00000-0000-4000-8000-000000000176', '40000000-0000-4000-8000-000000000073', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct40up',
  '{"body":"You are welcome"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
  '2026-07-02 01:00Z', '2026-07-02 01:00Z', '2026-07-02 01:00Z', 'direct', 1, NULL),
 ('40b00000-0000-4000-8000-000000000177', NULL, 'client.reply', 'ghl', 'sms', 'inbound', 'ct40up',
  '{"body":"Can we move the install?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-05 01:00Z', '2026-10-05 01:00Z', '2026-10-05 01:00Z', 'unplaced', NULL, ARRAY['40000000-0000-4000-8000-000000000073'::uuid]),
 ('40b00000-0000-4000-8000-000000000178', NULL, 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct40up',
  '{"body":"We will call you about it"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
  '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', 'unplaced', NULL, ARRAY['40000000-0000-4000-8000-000000000073'::uuid]),
 -- Q: nothing on the job; their text placed on no job
 ('40b00000-0000-4000-8000-000000000179', NULL, 'client.reply', 'ghl', 'sms', 'inbound', 'ct40qt',
  '{"body":"Still keen, any news?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-04 01:00Z', '2026-10-04 01:00Z', '2026-10-04 01:00Z', 'unplaced', NULL, ARRAY['40000000-0000-4000-8000-000000000074'::uuid]);
-- W: the client's mail placed on no job (they have another job, so it is withheld)
INSERT INTO public.inbox_events (id, job_id, from_email, subject, body_preview, received_at, processed_at, graph_message_id, mailbox, classification)
VALUES ('40a00000-0000-4000-8000-000000000075', NULL, 'twojobs@example.test', 'Fence', 'Any update on the fence?', '2026-10-03 01:00Z', '2026-10-03 01:00Z',
        'g40-75', 'office@example.test', 'client_reply');
-- J and K: attended 22 Jun, the stage set to complete and the pack-sent note on 6 Jul, the
-- invoice paid; K is re-attended on 10 Aug. H: the status history went complete, invoiced,
-- rectification and archived on 30 Jul to 17 Aug; the job now says partially accepted.
INSERT INTO public.job_assignments (id, job_id, role, scheduled_date, assignment_type, status, crew_name, is_ghost, created_at)
VALUES ('40100000-0000-4000-8000-000000000081', '40000000-0000-4000-8000-000000000081', 'lead_installer', '2026-06-22', 'makesafe', 'complete', 'Crew J', false, '2026-06-16 01:00Z'),
       ('40100000-0000-4000-8000-000000000082', '40000000-0000-4000-8000-000000000082', 'lead_installer', '2026-06-22', 'makesafe', 'complete', 'Crew K', false, '2026-06-16 01:00Z'),
       ('40100000-0000-4000-8000-000000000083', '40000000-0000-4000-8000-000000000083', 'lead_installer', '2026-07-29', 'install', 'complete', 'Crew H', false, '2026-07-20 01:00Z');
INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at)
VALUES ('40200000-0000-4000-8000-000000000081', '40000000-0000-4000-8000-000000000081', 'makesafe_substatus_changed',
        '{"substatus":"complete","changed_at":"2026-07-06T02:00:00Z"}', '2026-07-06 02:00Z'),
       ('40200000-0000-4000-8000-000000000082', '40000000-0000-4000-8000-000000000081', 'note',
        '{"text":"MAKESAFE_PACK_SENT | main | INV-4181 | to=builder@example.test | 2026-07-06T02:05:00Z | msgid=-"}', '2026-07-06 02:05Z'),
       ('40200000-0000-4000-8000-000000000083', '40000000-0000-4000-8000-000000000082', 'makesafe_substatus_changed',
        '{"substatus":"complete","changed_at":"2026-07-06T02:00:00Z"}', '2026-07-06 02:00Z'),
       ('40200000-0000-4000-8000-000000000084', '40000000-0000-4000-8000-000000000082', 'note',
        '{"text":"MAKESAFE_PACK_SENT | main | INV-4182 | to=builder@example.test | 2026-07-06T02:05:00Z | msgid=-"}', '2026-07-06 02:05Z'),
       ('40200000-0000-4000-8000-000000000085', '40000000-0000-4000-8000-000000000082', 'makesafe_reattend', '{}', '2026-08-10 01:00Z'),
       ('40200000-0000-4000-8000-000000000086', '40000000-0000-4000-8000-000000000083', 'status_changed', '{"new_status":"complete","old_status":"in_progress"}', '2026-07-30 03:33Z'),
       ('40200000-0000-4000-8000-000000000087', '40000000-0000-4000-8000-000000000083', 'status_changed', '{"new_status":"invoiced","old_status":"complete"}', '2026-07-30 04:38Z'),
       ('40200000-0000-4000-8000-000000000088', '40000000-0000-4000-8000-000000000083', 'status_changed', '{"new_status":"rectification","old_status":"invoiced"}', '2026-07-30 05:24Z'),
       ('40200000-0000-4000-8000-000000000089', '40000000-0000-4000-8000-000000000083', 'status_changed', '{"new_status":"archived","old_status":"rectification"}', '2026-08-17 01:59Z');

-- 3 (fourth review). An invoice placed on no job (U: the builder's invoice and a draft, SWF-26997
-- class) or on another job (S's remainder billed on its sibling T, SWF-26368 class) whose
-- reference or lines name the job is a C2 check while the job's own invoices fall short of its
-- value, and a line naming the job there gives its own base; one naming a longer job number
-- (SWF-940611) never counts. R8 then states no amount, and the first line never reads "not yet
-- invoiced" nor makes it our move to bill the builder or the client a second time.
DO $elsewhere$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; s jsonb; got text; n integer; x uuid;
BEGIN
 SELECT string_agg(right(l.job_id::text, 2) || '=' || l.what, ' | ' ORDER BY l.job_id, l.source_id) INTO got
 FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000061', '40000000-0000-4000-8000-000000000062',
   '40000000-0000-4000-8000-000000000063']::uuid[], asof) l WHERE l.rule = 'C2_value_mismatch';
 IF got IS DISTINCT FROM '61=Invoice INV-4161 ($5,610.00, authorised) names this job but is placed on no job; this job''s own issued invoices total $0.00 '
    || 'against the job value $6,237.00 (pricing_json.totalIncGST) | 61=Draft invoice INV-4162 ($4,565.00, draft) names this job but is placed on no job; '
    || 'this job''s own issued invoices total $0.00 against the job value $6,237.00 (pricing_json.totalIncGST) | 62=Invoice INV-4165 (placed on job SWF-94063) '
    || 'says this job is a share of $748.01; the job value is $1,922.81 (pricing_json.totalIncGST)' THEN
  RAISE EXCEPTION 'story safety contract: an invoice placed elsewhere that names the job is a check of its value: %', got;
 END IF;
 SELECT string_agg((c->>'kind') || ':' || right(c->>'id', 3), ',' ORDER BY (c->>'kind')::int, c->>'id') INTO got
 FROM public.context_job_record_value(ARRAY['40000000-0000-4000-8000-000000000062'::uuid], asof) v, jsonb_array_elements(v.checks) c;
 IF got IS DISTINCT FROM '3:165,8:165' THEN
  RAISE EXCEPTION 'story safety contract: the sibling''s invoice gives this job''s own base and names this job (kinds 3 and 8): %', got;
 END IF;
 SELECT count(*) INTO n FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000061', '40000000-0000-4000-8000-000000000062']::uuid[], asof) l
 WHERE l.rule = 'R8_not_yet_invoiced' AND l.amount IS NULL AND l.what LIKE '% is unconfirmed (check C2); issued invoices $0.00; what is left to invoice is not known';
 IF n <> 2 THEN RAISE EXCEPTION 'story safety contract: billed elsewhere, R8 states no amount (% of 2)', n; END IF;
 FOREACH x IN ARRAY ARRAY['40000000-0000-4000-8000-000000000061', '40000000-0000-4000-8000-000000000062']::uuid[] LOOP
  s := public.context_job_story(x, asof);
  IF s->'now'->>'whose_move' = 'us' OR s->'now'->>'line' LIKE '%not yet invoiced%' OR s->'now'->>'line' LIKE '%we owe%'
     OR NOT coalesce((s->'money'->'not_yet_invoiced'->>'unconfirmed')::boolean, false)
     OR position('the job value is unconfirmed (check C2)' IN s->'money'->>'line') = 0 THEN
   RAISE EXCEPTION 'story safety contract: a job billed elsewhere is never "not yet invoiced" as fact: % / %', s->'now', s->'money'->>'line';
  END IF;
 END LOOP;
END $elsewhere$;

-- 3 (fourth review, the database). D was accepted by its paid deposit; the deposit and the
-- overdue balance both name a $3,790.60 base the two cover, against a stale job value (C2), so
-- R8 is unconfirmed: never the move, the customer's overdue balance leads, and the client
-- story lists R8 after the loops due now (SWP-261180 class). A final invoice issued below the
-- value with nothing else open is never our move either (SWP-26373 and SWP-261046 class).
DO $unconfirmed$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; s jsonb;
BEGIN
 s := public.context_job_story('40000000-0000-4000-8000-000000000066', asof);
 IF s->'now'->>'whose_move' <> 'customer'
    OR position('The customer''s move, the customer owes: INV-4167 $1,895.30 overdue from Deposit Base Client since Fri 2 Oct 2026 (5 days)' IN s->'now'->>'line') = 0
    OR s->'now'->>'line' LIKE '%we owe%' OR s->'now'->>'line' LIKE '%is left to .%'
    OR (SELECT l->>'status' FROM jsonb_array_elements(s->'loops') l WHERE l->>'rule' = 'R8_not_yet_invoiced') IS DISTINCT FROM 'unconfirmed'
    OR s->'loops'->0->>'rule' <> 'R1_overdue' THEN
  RAISE EXCEPTION 'story safety contract: an unconfirmed R8 never outranks the customer''s overdue balance: % / %', s->'now', s->'loops';
 END IF;
 s := public.context_client_story('40000000-0000-4000-8000-000000000066', asof);
 IF (SELECT array_agg((l->>'rule') || '=' || (l->>'status') ORDER BY o) FROM jsonb_array_elements(s->'open_loops') WITH ORDINALITY x(l, o))
    IS DISTINCT FROM ARRAY['R1_overdue=open', 'R8_not_yet_invoiced=unconfirmed'] THEN
  RAISE EXCEPTION 'story safety contract: the client story lists an unconfirmed R8 after the loops due now: %', s->'open_loops';
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000015', asof);
 IF s->'now'->>'whose_move' = 'us' OR s->'now'->>'line' LIKE '%we owe%'
    OR (SELECT l->>'status' FROM jsonb_array_elements(s->'loops') l WHERE l->>'rule' = 'R8_not_yet_invoiced') IS DISTINCT FROM 'unconfirmed' THEN
  RAISE EXCEPTION 'story safety contract: a final invoice below a stale value is never our move: % / %', s->'now', s->'loops';
 END IF;
END $unconfirmed$;

-- 1 (fourth review). R7 with the customer in touch since the quote in a way that does not close
-- it (C: their answered call on the job, SWF-26167 class; X: their text placed on no job,
-- SWF-261431 class): it may be answered, so whose move is unclear and the line names that
-- contact, never "waiting on the customer: ... no customer message since".
DO $touch$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; s jsonb; r record;
BEGIN
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000071'::uuid], asof) l WHERE l.rule = 'R7_quote_waiting';
 IF r.owner IS DISTINCT FROM 'unknown' OR r.shown_as IS DISTINCT FROM 'loop'
    OR r.what IS DISTINCT FROM 'Quote Q-4071 v1 sent Mon 20 Jul 2026 (79 days), viewed; no answer recorded, but the customer was in touch since: an answered call Mon 27 Jul 2026' THEN
  RAISE EXCEPTION 'story safety contract: a quote the customer rang about since is not waiting on them: %', row_to_json(r);
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000071', asof);
 IF s->'now'->>'whose_move' <> 'unknown' OR s->'now'->>'line' LIKE '%waiting on the customer%' OR s->'now'->>'line' LIKE '%no customer message since%'
    OR position('Whose move is unclear, open: Quote Q-4071 v1 sent Mon 20 Jul 2026 (79 days), viewed; no answer recorded, but the customer was in touch since: '
                || 'an answered call Mon 27 Jul 2026' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: the first line names the customer''s contact since the quote: %', s->'now';
 END IF;
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000072'::uuid], asof) l WHERE l.rule = 'R7_quote_waiting';
 IF r.owner IS DISTINCT FROM 'unknown'
    OR r.what IS DISTINCT FROM 'Quote Q-4072 v1 sent Thu 27 Aug 2026 (41 days), not viewed; no answer recorded, but the customer was in touch since: '
                               || 'a text Thu 24 Sep 2026 (not placed on any job)' THEN
  RAISE EXCEPTION 'story safety contract: a text placed on no job since the quote is the customer in touch: %', row_to_json(r);
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000072', asof);
 IF s->'now'->>'whose_move' <> 'unknown' OR s->'now'->>'line' LIKE '%waiting on the customer%' THEN
  RAISE EXCEPTION 'story safety contract: a text placed on no job since the quote leaves whose move unclear: %', s->'now';
 END IF;
END $touch$;

-- 1 (fourth review). The no-reader line's contact facts take this customer's messages placed on
-- no job yet and their mail withheld because they have another job, naming where each sits:
-- never a stale date (P: newer ones each way placed on no job, SWP-26328 class), never "no
-- customer message" while one waits there (Q, SWF-261495 class; W, withheld mail).
DO $contact$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; s jsonb;
BEGIN
 s := public.context_job_story('40000000-0000-4000-8000-000000000073', asof);
 IF s->'now'->>'whose_move' <> 'unknown'
    OR position('Whose move is unclear: no record item is open, and the messages are not yet checked for promises or requests; '
                || 'newest customer message Mon 5 Oct (not placed on any job), our last reply Mon 5 Oct (not placed on any job)' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: the line names the customer''s newer messages placed on no job: %', s->'now'->>'line';
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000074', asof);
 IF s->'now'->>'line' LIKE '%no customer message%'
    OR position('newest customer message Sun 4 Oct (not placed on any job), no reply from us on record' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: never "no customer message" while one waits placed on no job: %', s->'now'->>'line';
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000075', asof);
 IF s->'now'->>'line' LIKE '%no customer message%'
    OR position('newest customer message Sat 3 Oct (an email not placed on any job; it may be about another of their jobs), no reply from us on record'
                IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: the customer''s withheld mail is named, never "no customer message": %', s->'now'->>'line';
 END IF;
END $contact$;

-- 4 (fourth review). A make-safe finished by its own records before the release's derived
-- sent events began (J, SWMS-26708 class: the stage set to complete and the pack-sent note
-- staff wrote; its invoice is paid too) is work done, never "Make-safe in progress"; a
-- re-attend after them opens it again (K). A job whose app status history went complete (then invoiced, rectification and
-- archived) is work done whatever its status says now (H, SWF-26395 class).
DO $worked$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; s jsonb;
BEGIN
 s := public.context_job_story('40000000-0000-4000-8000-000000000081', asof);
 IF s->'now'->>'phase' <> 'complete' OR s->'now'->>'line' LIKE 'Make-safe in progress%'
    OR s->'now'->>'line' NOT LIKE 'Work complete since Mon 6 Jul%' OR position('attended Mon 22 Jun' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: a make-safe finished by its own records is work done: %', s->'now';
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000082', asof);
 IF s->'now'->>'phase' <> 'makesafe' OR s->'now'->>'line' NOT LIKE 'Make-safe in progress%' THEN
  RAISE EXCEPTION 'story safety contract: a re-attend after the records opens the make-safe again: %', s->'now';
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000083', asof);
 IF s->'now'->>'phase' <> 'complete' OR s->'now'->>'line' NOT LIKE 'Work complete since Thu 30 Jul%' THEN
  RAISE EXCEPTION 'story safety contract: a status history that went complete is work done: %', s->'now';
 END IF;
END $worked$;

-- 7 (fourth review). The client story's owing is what the client owes: a homeowner on builder
-- work owes none of the builder's invoice (B, SWR-261364 class), which is owed_by_others (in the
-- money and on the job) and named in not_known.
DO $clientowes$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; s jsonb;
BEGIN
 s := public.context_client_story('40000000-0000-4000-8000-000000000091', asof);
 IF (s->'money'->>'owing')::numeric <> 0 OR (s->'money'->>'overdue')::numeric <> 0
    OR (s->'money'->'owed_by_others'->>'owing')::numeric IS DISTINCT FROM 2882.00
    OR (s->'jobs'->0->>'owing')::numeric IS DISTINCT FROM 0 OR (s->'jobs'->0->>'owed_by_others')::numeric IS DISTINCT FROM 2882.00
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'not_known') k
                   WHERE k->>'what' = 'Owing and overdue count only what this client owes; others owe $2,882.00 on these jobs (a builder on builder work, '
                                      || 'a neighbour or another payer), in money.owed_by_others; money.by_party has each paying party on its own.') THEN
  RAISE EXCEPTION 'story safety contract: a homeowner never owes the builder''s invoice: % / %', s->'money', s->'not_known';
 END IF;
END $clientowes$;

-- Fifth review fixtures: this customer's CRM texts loaded later from the CRM's cache and placed
-- on no job (SWMS-261403, SWF-261421 and SWF-261422 class). Z: their text the CRM dates 25 Aug,
-- before the 1 Sep quote, loaded on 20 Sep after it (their last word on the job was 30 Aug, our
-- reply 31 Aug). Y: nothing on the job; their text and our reply the CRM dates 25 and 26 Aug,
-- both loaded on 20 Sep. L: texts each way the CRM dates in June, before the job's lead window
-- (it was created 15 Sep), loaded on 20 Sep after its quote.
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, client_email, ghl_contact_id, xero_contact_id, pricing_json,
  accepted_at, completed_at, created_at)
VALUES
 ('40000000-0000-4000-8000-000000000077', '00000000-0000-4000-8000-0000000000aa', 'SWF-94077', 'quoted', 'fencing', 'Cache Quote Client',
  NULL, 'ct40zq', NULL, '{}', NULL, NULL, '2026-08-20 01:00Z'),
 ('40000000-0000-4000-8000-000000000078', '00000000-0000-4000-8000-0000000000aa', 'SWF-94078', 'accepted', 'fencing', 'Cache Quiet Client',
  NULL, 'ct40zy', NULL, '{}', NULL, NULL, '2026-08-20 01:00Z'),
 ('40000000-0000-4000-8000-000000000079', '00000000-0000-4000-8000-0000000000aa', 'SWF-94079', 'quoted', 'fencing', 'Lead Window Client',
  NULL, 'ct40zl', NULL, '{}', NULL, NULL, '2026-09-15 01:00Z');
INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at, viewed_at, declined_at)
VALUES ('40e00000-0000-4000-8000-000000000077', '40000000-0000-4000-8000-000000000077', 'quote', 'Q-4077', 1, '2026-09-01 01:00Z', '2026-09-01 01:10Z', NULL, NULL),
       ('40e00000-0000-4000-8000-000000000079', '40000000-0000-4000-8000-000000000079', 'quote', 'Q-4079', 1, '2026-09-16 01:00Z', '2026-09-16 01:10Z', NULL, NULL);
INSERT INTO public.ghl_conversation_cache (contact_id, job_id, messages, synced_at)
VALUES ('ct40zq', NULL, '[{"id":"m40-77","timestamp":"2026-08-25T03:00:00.000Z","direction":"inbound"}]', '2026-09-20 01:00Z'),
       ('ct40zy', NULL, '[{"id":"m40-78a","timestamp":"2026-08-25T03:00:00.000Z","direction":"inbound"},{"id":"m40-78b","timestamp":"2026-08-26T03:00:00.000Z","direction":"outbound"}]',
        '2026-09-20 01:05Z'),
       ('ct40zl', NULL, '[{"id":"m40-79a","timestamp":"2026-06-10T01:08:34.644Z","direction":"inbound"},{"id":"m40-79b","timestamp":"2026-06-09T06:09:12.277Z","direction":"outbound"}]',
        '2026-09-20 01:05Z');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  attribution_status, attribution_confidence, candidate_job_ids, provider_message_id)
VALUES
 -- Z: their text and our reply on the job before the quote; a text the CRM dates 25 Aug, before
 -- the quote, loaded on 20 Sep after it and placed on no job
 ('40b00000-0000-4000-8000-000000000180', '40000000-0000-4000-8000-000000000077', 'client.reply', 'ghl', 'sms', 'inbound', 'ct40zq',
  '{"body":"Please send the quote through"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-08-30 01:00Z', '2026-08-30 01:00Z', '2026-08-30 01:00Z', 'direct', 1, NULL, NULL),
 ('40b00000-0000-4000-8000-000000000186', '40000000-0000-4000-8000-000000000077', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct40zq',
  '{"body":"It will be with you on Tuesday"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
  '2026-08-31 01:00Z', '2026-08-31 01:00Z', '2026-08-31 01:00Z', 'direct', 1, NULL, NULL),
 ('40b00000-0000-4000-8000-000000000181', NULL, 'client.reply', 'ghl_sms_cache_backfill', 'sms', 'inbound', 'ct40zq',
  '{"body":"Is the quote coming?","ghl_message_id":"m40-77"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-09-20 01:00Z', '2026-09-20 01:00Z', '2026-09-20 01:00Z', 'unplaced', NULL, ARRAY['40000000-0000-4000-8000-000000000077'::uuid], 'ghl:m40-77'),
 -- Y: nothing on the job; their text (CRM 25 Aug) and our reply (CRM 26 Aug), both loaded on 20 Sep and placed on no job
 ('40b00000-0000-4000-8000-000000000182', NULL, 'client.reply', 'ghl_sms_cache_backfill', 'sms', 'inbound', 'ct40zy',
  '{"body":"Can you come out next week?","ghl_message_id":"m40-78a"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-09-20 01:00Z', '2026-09-20 01:00Z', '2026-09-20 01:00Z', 'unplaced', NULL, ARRAY['40000000-0000-4000-8000-000000000078'::uuid], 'ghl:m40-78a'),
 ('40b00000-0000-4000-8000-000000000183', NULL, 'client.sms_out', 'ghl_sms_cache_backfill', 'sms', 'outbound', 'ct40zy',
  '{"body":"Yes, Tuesday suits","ghl_message_id":"m40-78b"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
  '2026-09-20 01:05Z', '2026-09-20 01:05Z', '2026-09-20 01:05Z', 'unplaced', NULL, ARRAY['40000000-0000-4000-8000-000000000078'::uuid], 'ghl:m40-78b'),
 -- L: texts each way the CRM dates in June, before the job's lead window (it was created 15 Sep), loaded on 20 Sep after the quote, placed on no job
 ('40b00000-0000-4000-8000-000000000184', NULL, 'client.reply', 'ghl_sms_cache_backfill', 'sms', 'inbound', 'ct40zl',
  '{"body":"June words from someone else","ghl_message_id":"m40-79a"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-09-20 01:00Z', '2026-09-20 01:00Z', '2026-09-20 01:00Z', 'unplaced', NULL, ARRAY['40000000-0000-4000-8000-000000000079'::uuid], 'ghl:m40-79a'),
 ('40b00000-0000-4000-8000-000000000185', NULL, 'client.sms_out', 'ghl_sms_cache_backfill', 'sms', 'outbound', 'ct40zl',
  '{"body":"Our June text to someone","ghl_message_id":"m40-79b"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
  '2026-09-20 01:05Z', '2026-09-20 01:05Z', '2026-09-20 01:05Z', 'unplaced', NULL, ARRAY['40000000-0000-4000-8000-000000000079'::uuid], 'ghl:m40-79b');

-- 1 and 4 (fifth review). A CRM text placed on no job that was loaded later from the CRM's cache
-- is at the CRM's own time in R7's contact since the quote and in the no-reader line's contact
-- facts, as the job's own texts are: a text the customer sent before the quote is never contact
-- since it, however late it was loaded (Z); the line names the days the CRM gives, never the load
-- day (Y); a text from before the job's lead window is never the customer's newest message,
-- contact since a quote or our last reply (L), though the placement queue still counts it.
DO $cached$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; s jsonb; r record;
BEGIN
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000077'::uuid], asof) l WHERE l.rule = 'R7_quote_waiting';
 IF r.owner IS DISTINCT FROM 'customer' OR r.counterparty IS DISTINCT FROM 'us'
    OR r.what IS DISTINCT FROM 'Quote Q-4077 v1 sent Tue 1 Sep 2026 (36 days), not viewed; no answer and no customer message since' THEN
  RAISE EXCEPTION 'story safety contract: a text the customer sent before the quote is never contact since it, however late it was loaded: %', row_to_json(r);
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000077', asof);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'customer' OR s->'now'->>'line' LIKE '%in touch since%'
    OR position('The customer''s move, waiting on the customer: Quote Q-4077 v1 sent Tue 1 Sep 2026 (36 days), not viewed; no answer and no customer message since'
                IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: the first line never reads a text sent before the quote as contact since it: %', s->'now';
 END IF;
 s := public.context_job_story_meta('40000000-0000-4000-8000-000000000078', asof);
 IF (s->'unplaced'->>'newest_customer_at')::timestamptz IS DISTINCT FROM '2026-08-25 03:00Z'
    OR (s->'unplaced'->>'newest_reply_at')::timestamptz IS DISTINCT FROM '2026-08-26 03:00Z'
    OR (s->'unplaced'->>'newest_at')::timestamptz IS DISTINCT FROM '2026-08-26 03:00Z' OR (s->'unplaced'->>'count')::int IS DISTINCT FROM 2 THEN
  RAISE EXCEPTION 'story safety contract: the story meta times a CRM text placed on no job by the CRM''s own time: %', s->'unplaced';
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000078', asof);
 IF position('newest customer message Tue 25 Aug (not placed on any job), our last reply Wed 26 Aug (not placed on any job)' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: the line names the days the CRM gives texts placed on no job, never the load day: %', s->'now'->>'line';
 END IF;
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000079'::uuid], asof) l WHERE l.rule = 'R7_quote_waiting';
 IF r.owner IS DISTINCT FROM 'customer'
    OR r.what IS DISTINCT FROM 'Quote Q-4079 v1 sent Wed 16 Sep 2026 (21 days), not viewed; no answer and no customer message since' THEN
  RAISE EXCEPTION 'story safety contract: a text placed on no job from before the lead window is never contact since the quote: %', row_to_json(r);
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000079', asof);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'customer' OR s->'now'->>'line' LIKE '%in touch since%' THEN
  RAISE EXCEPTION 'story safety contract: the first line never reads a text from before the lead window as contact since the quote: %', s->'now';
 END IF;
 s := public.context_job_story_meta('40000000-0000-4000-8000-000000000079', asof);
 IF s->'unplaced'->>'newest_customer_at' IS NOT NULL OR s->'unplaced'->>'newest_reply_at' IS NOT NULL OR s->'unplaced'->>'newest_at' IS NOT NULL
    OR (s->'unplaced'->>'count')::int IS DISTINCT FROM 2 THEN
  RAISE EXCEPTION 'story safety contract: texts placed on no job from before the lead window are counted, never the newest of either side: %', s->'unplaced';
 END IF;
END $cached$;
ROLLBACK;

-- 8. Re-applying the migration changes nothing (its guard accepts its own bodies).
BEGIN;
CREATE TEMP TABLE story_safety_md5 AS
 SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('context_job_record_legacy_mail', 'context_job_record_messages',
  'context_job_record_timeline', 'context_job_record_loops', 'context_job_record_money', 'context_job_record_contact', 'context_job_story_facts',
  'context_job_story_meta', 'context_job_story_assemble', 'context_client_story', 'context_ledger_evidence_rows', 'context_ledger_cite',
  'context_ledger_judge', 'context_job_record_crm_time', 'context_job_record_payer_role', 'context_job_record_bill_share', 'context_job_record_value',
  'context_job_story_day', 'context_ledger_mail_rule_since', 'context_ledger_mail_copies');
\ir ../../../migrations/20261006040000_context_story_safety.sql
DO $again$
BEGIN
 IF (SELECT count(*) FROM story_safety_md5) <> 20 OR EXISTS (SELECT 1 FROM story_safety_md5 x JOIN pg_proc p ON p.oid = x.sig::regprocedure
       WHERE md5(p.prosrc) IS DISTINCT FROM x.m OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM x.c) THEN
  RAISE EXCEPTION 'story safety contract: a re-apply must change nothing';
 END IF;
END $again$;
ROLLBACK;
