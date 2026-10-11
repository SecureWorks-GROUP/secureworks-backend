-- Contract for 20261006040000_context_story_safety: the job story is safe to switch on
-- with the reader off. Each section fails on the bodies before it (972, 975 and
-- 20261006033000):
--  0. Shape and access: fourteen replaced bodies (eighth review: the ledger read too) keep
--     their flags, grants and slice names; seven helpers, service role only.
--  1. No false all-clear while no live (promoted) reading has read the words, nor
--     while a live one has rows on the job it has not read yet: the line leads with
--     "Whose move is unclear:", says the messages are not yet checked for promises or
--     requests (a lagging reading: how many newer rows of every kind, ours included),
--     and with no message on record claims nothing unchecked; whose move and the item
--     the first line names belong to the same party; a payer is "owed by", never "from".
--  2. An inbox email is dropped for a saved copy on the same job, and (seventh review) for
--     one on another live job, which decides where it belongs, never for one unplaced or on
--     an archived or holding job: story, reader evidence and citation check; the citation
--     check only widens for mail. A mail
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
-- Sixth review (each fails on the 729d928b bodies unless marked a promise kept): a CRM value
-- nothing backs (C2 kind 9) and an invoice on no job to the job's own Xero contact or on a
-- duplicate record (C2 kind 8) leave R8 with no amount, never our move, and the debt on no
-- job is named in the line, the money and the client story; R8 waits while the job is in
-- rectification or reopened work is not finished again; a CRM time is kept when a sync writes
-- the cache over, and a text whose time was never kept is time unknown; a reading of every row
-- is no all-clear over the customer's newer message off the job; R7 is a check past quoted or
-- once the work is done, counts contact of any attribution status and on the customer's other
-- jobs, and is a check when their later job at the same address is accepted; a missed call on
-- no job is R4; a draft whose stage split invoices already reach is a check.
-- Seventh review (each fails on the 88cf7b15 bodies unless marked a promise kept): a draft is a
-- check only when issued invoices bill the same share of its stage for its own payer, never on
-- another payer's invoices or another percentage's; R4 on the job closes on our call, text or
-- email to the customer's CRM contact on any job or none, or their answered call since, and R5
-- and C11 on our reply placed off the job; the customer's newer message off the job leaves whose
-- move unclear over what they owe; a job its paid deposit accepted reads accepted; a copy on
-- another live job takes the mail off the job (story, reader, citation, never unread); mail from
-- our own addresses or labelled with another job's customer is never this job's customer's.
-- Eighth review (each fails on the e10ad4a8 bodies unless marked a promise kept): an off-job message
-- changes only what its sender owes (never the builder's on builder work, where the contact is the
-- insured, named so; never a neighbour's); the customer's unread newest message on the job makes
-- whose move unclear over what they or another party owe (a voicemail among them); a draft shown as
-- an R3 check may duplicate issued invoices, said so; this job's own Xero contacts are its
-- customer's only (a neighbour's invoice on no job is named as theirs, another payer's never tied);
-- stored citations are re-checked by the citation check's current rules (hidden, rebuild); a copy
-- on a job that is not live keeps the mail, and one leaving a live job makes it unread; a missed
-- call's voicemail transcript never answers it; the line's contact facts read the customer's rows
-- on a bucket job, on their other jobs and by address with no CRM contact; a newer off-job message
-- is named after "wrote last"; a reading with an item hidden is no all-clear.
-- Ninth review, regression fixes (each fails on the bddb8494 bodies unless marked a promise kept): on
-- builder work the job's contact is the insured's only when the make-safe details name the builder and
-- none of the job's contact details (CRM contact, client phone, client email) sits on another client's
-- job (meta contact_shared); a contact shared across clients (three builder jobs for three clients
-- sharing one CRM contact, its call placed on one of them; two jobs sharing one phone) is the job
-- contact on every line and in who, never "the insured", and its newer message holds the builder's
-- move; with no builder named, or the meta silent, the line never says "the insured" either; a contact
-- on the same household's other job at the same street stays the insured's (a promise kept).
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
   ('public.context_job_story_ledger(uuid,uuid,timestamptz)', true, 'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000):%'),
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

-- 4 (shape, sixth review). The CRM's own time of each message the conversation cache holds is
-- kept where no sync writes it over: a table (RLS on, no anon or authenticated access) filled
-- by a trigger on each cache write (after insert, or an update of the messages), its function
-- a definer with a pinned search_path, service role only.
DO $keepshape$
DECLARE p record; t record;
BEGIN
 SELECT c.relrowsecurity AS rls, obj_description(c.oid, 'pg_class') AS cmt INTO t FROM pg_class c WHERE c.oid = to_regclass('public.context_crm_message_times');
 IF t IS NULL OR NOT t.rls OR coalesce(t.cmt, '') NOT LIKE 'Story safety (20261006040000)%'
    OR has_table_privilege('anon', 'public.context_crm_message_times', 'SELECT') OR has_table_privilege('authenticated', 'public.context_crm_message_times', 'SELECT')
    OR has_table_privilege('anon', 'public.context_crm_message_times', 'INSERT') OR has_table_privilege('authenticated', 'public.context_crm_message_times', 'INSERT')
    OR NOT has_table_privilege('service_role', 'public.context_crm_message_times', 'SELECT') THEN
  RAISE EXCEPTION 'story safety contract: the CRM message times table must exist, RLS on, service role only: %', to_jsonb(t);
 END IF;
 SELECT pr.prosecdef, pr.proconfig, obj_description(pr.oid, 'pg_proc') AS cmt INTO p FROM pg_proc pr
 WHERE pr.oid = to_regprocedure('public.context_crm_message_times_keep()');
 IF p IS NULL OR NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
    OR coalesce(p.cmt, '') NOT LIKE 'Story safety (20261006040000)%'
    OR has_function_privilege('anon', 'public.context_crm_message_times_keep()', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.context_crm_message_times_keep()', 'EXECUTE') THEN
  RAISE EXCEPTION 'story safety contract: the trigger function keeping CRM times must be a service-role definer: %', to_jsonb(p);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = 'public.ghl_conversation_cache'::regclass AND tg.tgname = 'context_crm_message_times_keep'
                AND tg.tgfoid = to_regprocedure('public.context_crm_message_times_keep()') AND tg.tgenabled = 'O'
                AND pg_get_triggerdef(tg.oid) LIKE '%AFTER INSERT OR UPDATE OF messages ON public.ghl_conversation_cache FOR EACH ROW%') THEN
  RAISE EXCEPTION 'story safety contract: every conversation cache write must keep the CRM times (trigger missing)';
 END IF;
END $keepshape$;

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

-- Sixth review (pure assembler). 1: a reading that has read every row on the job gives no
-- all-clear while the customer's newest message is off the job (placed on no job yet, or their
-- withheld mail): it was never the reading's to read, so whose move is unclear and the line
-- names it, where it sits, unchecked; an off-job message older than the job's own newest
-- customer message leaves the all-clear standing. 3: the final invoice (R8) is not due while
-- the job is in rectification, or while work recorded finished was opened again (a status
-- change into rectification, a make-safe re-attend) with nothing recording it finished since,
-- and never our move then; once a record says it is finished again it is due. 1: a quote
-- waiting (R7) is a check once the work is done, never a wait on the customer.
DO $sixthpure$
DECLARE s jsonb; l jsonb;
 contact constant jsonb := '{"last_customer_message":{"at":"2026-07-01T01:00:00Z","channel":"sms","direction":"inbound","table":"business_events","id":"e1","placed_on":"this_job"},
   "last_to_customer":{"at":"2026-07-02T01:00:00Z","channel":"sms","direction":"outbound","table":"business_events","id":"e2","placed_on":"this_job"}}';
 shadow constant jsonb := '{"status":"shadow","generation":{"id":"g1","status":"shadow","evidence_until":"2026-07-03T00:00:00Z"},"items":[],"transitions":[],"unread_rows":0,"unread_ids":[],"read_ids":["e1"]}';
 accepted constant jsonb := '{"id":"x","status":"accepted","type":"fencing","created_at":"2026-06-20T00:00:00Z"}';
 r8 constant jsonb := jsonb_build_object('rule', 'R8_not_yet_invoiced', 'loop_key', 'R8_not_yet_invoiced:j1', 'shown_as', 'loop', 'owner', 'us', 'counterparty', 'customer',
   'what', 'Job value $7,920.00 (pricing_json.totalIncGST); issued invoices $5,940.00; $1,980.00 not yet invoiced',
   'opened_at', '2026-06-17T08:33:00Z', 'amount', 1980, 'about_key', 'payment:final', 'source_table', 'jobs', 'source_id', 'j1');
 r7 constant jsonb := jsonb_build_object('rule', 'R7_quote_waiting', 'loop_key', 'R7_quote_waiting:q1', 'shown_as', 'loop', 'owner', 'customer', 'counterparty', 'us',
   'what', 'Quote Q-1 v1 sent Wed 5 Aug 2026 (63 days), not viewed; no answer and no customer message since',
   'opened_at', '2026-08-05T01:10:00Z', 'about_key', 'quote:q-1', 'source_table', 'job_documents', 'source_id', 'q1');
 done constant jsonb := '{"at":"2026-07-22T01:00:00Z","t":"job_events","id":"p1","what":"Completion pack generated"}';
BEGIN
 s := public.context_job_story_assemble(accepted, jsonb_build_object('contact', contact), shadow,
        '{"unplaced":{"count":2,"newest_customer_at":"2026-10-05T01:00:00Z","newest_reply_at":"2026-10-05T02:00:00Z"}}', '2026-10-07 02:00Z', NULL);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'unknown' OR s->'now'->>'line' LIKE '%Nothing open%'
    OR position('Whose move is unclear: no record item is open and the reader found nothing open in the job''s own messages, but the customer''s newest message, '
                || 'Mon 5 Oct (not placed on any job), is off the job and not yet checked by the reader' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: a reading of every row on the job is no all-clear over the customer''s newer message off the job: %', s->'now';
 END IF;
 s := public.context_job_story_assemble(accepted, jsonb_build_object('contact', contact), shadow,
        '{"withheld_mail":{"count":1,"newest_at":"2026-10-03T01:00:00Z"}}', '2026-10-07 02:00Z', NULL);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'unknown'
    OR position('the customer''s newest message, Sat 3 Oct (an email not placed on any job; it may be about another of their jobs), is off the job and not yet checked by the reader'
                IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: a reading of every row on the job is no all-clear over the customer''s newer withheld mail: %', s->'now';
 END IF;
 -- (promise kept) an off-job message older than the job's own newest customer message: the
 -- reading's all-clear stands
 s := public.context_job_story_assemble(accepted, jsonb_build_object('contact', contact), shadow,
        '{"unplaced":{"count":1,"newest_customer_at":"2026-06-25T01:00:00Z"}}', '2026-10-07 02:00Z', NULL);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'nobody' OR position('Nothing open on record' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: an older message off the job leaves a full reading''s all-clear standing: %', s->'now';
 END IF;
 -- 3: completion pack 22 Jul, the job in rectification now (SWP-26354 class)
 s := public.context_job_story_assemble('{"id":"x","status":"rectification","type":"patio","created_at":"2026-05-21T00:00:00Z"}'::jsonb,
        jsonb_build_object('contact', contact, 'loops', jsonb_build_array(r8), 'facts', jsonb_build_object('completion', done)), NULL, NULL, '2026-10-07 02:00Z', NULL);
 SELECT x INTO l FROM jsonb_array_elements(s->'loops') x WHERE x->>'rule' = 'R8_not_yet_invoiced';
 IF l->>'status' IS DISTINCT FROM 'not_due' OR l->>'why' NOT LIKE '%the job is in rectification, so the final invoice is not the next move until the work is finished again%'
    OR s->'now'->>'whose_move' = 'us' OR s->'now'->>'line' LIKE '%we owe%' OR s->'now'->>'line' LIKE '%not yet invoiced%' THEN
  RAISE EXCEPTION 'story safety contract: the final invoice is not due while the job is in rectification: % / %', s->'now', l;
 END IF;
 -- 3: reopened by a status change into rectification after the completion pack, rework
 -- scheduled since, nothing recording it finished again
 s := public.context_job_story_assemble('{"id":"x","status":"scheduled","type":"patio","created_at":"2026-05-21T00:00:00Z"}'::jsonb,
        jsonb_build_object('contact', contact, 'loops', jsonb_build_array(r8), 'facts', jsonb_build_object('completion', done,
          'reopened', '{"at":"2026-08-19T02:00:00Z","t":"job_events","id":"r1","what":"Status set to rectification","completed_since":null}'::jsonb)),
        NULL, NULL, '2026-10-07 02:00Z', NULL);
 SELECT x INTO l FROM jsonb_array_elements(s->'loops') x WHERE x->>'rule' = 'R8_not_yet_invoiced';
 IF l->>'status' IS DISTINCT FROM 'not_due' OR s->'now'->>'whose_move' = 'us' OR s->'now'->>'line' LIKE '%we owe%'
    OR l->>'why' NOT LIKE '%the work was opened again after it was recorded finished (status set to rectification Wed 19 Aug) and nothing records it finished since%' THEN
  RAISE EXCEPTION 'story safety contract: the final invoice waits while reopened work is not finished again: % / %', s->'now', l;
 END IF;
 -- (promise kept) finished again since the reopening: due, and our move
 s := public.context_job_story_assemble('{"id":"x","status":"invoiced","type":"patio","created_at":"2026-05-21T00:00:00Z"}'::jsonb,
        jsonb_build_object('contact', contact, 'loops', jsonb_build_array(r8), 'facts', jsonb_build_object('completion', done,
          'reopened', '{"at":"2026-08-19T02:00:00Z","t":"job_events","id":"r1","what":"Status set to rectification","completed_since":"2026-09-01T02:00:00Z"}'::jsonb)),
        NULL, NULL, '2026-10-07 02:00Z', NULL);
 SELECT x INTO l FROM jsonb_array_elements(s->'loops') x WHERE x->>'rule' = 'R8_not_yet_invoiced';
 IF l->>'status' IS DISTINCT FROM 'open' OR s->'now'->>'whose_move' IS DISTINCT FROM 'us' THEN
  RAISE EXCEPTION 'story safety contract: finished again since it was reopened, the final invoice is due: % / %', s->'now', l;
 END IF;
 -- 1: a quote waiting once the work is done (status quoted, a completion record): a check
 s := public.context_job_story_assemble('{"id":"x","status":"quoted","type":"fencing","created_at":"2026-07-30T00:00:00Z"}'::jsonb,
        jsonb_build_object('contact', contact, 'loops', jsonb_build_array(r7), 'facts', jsonb_build_object('completion', '{"at":"2026-08-12T03:00:00Z","t":"job_events","id":"p2","what":"Completion pack generated"}'::jsonb)),
        NULL, NULL, '2026-10-07 02:00Z', NULL);
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(s->'loops') x WHERE x->>'rule' = 'R7_quote_waiting')
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'checks') x WHERE x->>'rule' = 'R7_quote_waiting' AND x->>'what' LIKE 'Quote Q-1 v1 sent%')
    OR s->'now'->>'whose_move' = 'customer' OR s->'now'->>'line' LIKE '%waiting on the customer%' THEN
  RAISE EXCEPTION 'story safety contract: a quote waiting is a check once the work is done: % / %', s->'now', s->'checks';
 END IF;
END $sixthpure$;

-- Eighth review (pure assembler; each fails on the e10ad4a8 bodies unless marked a promise kept).
-- 1 (money): on builder work the job's CRM contact is the insured: their message off the job never
-- makes the builder's money move unclear (SWMS-261441), and the line names their message as the
-- insured's, never the customer's; on private work a message off the job changes only what its
-- sender owes, never a neighbour's invoice. 1 (words): the customer's newest message on the job that
-- no finished reading has read makes whose move unclear over what they or another party owe from
-- before it, named with our last reply whatever we sent since (SWF-261481), a voicemail recording
-- among them (SWF-26091); once a finished reading has read it, or on builder work, the move stands
-- (promises kept). 9: a newer message off the job is named after the customer wrote last
-- (SWP-261265). 3: a draft shown as an R3 check may duplicate issued invoices, said so in the first
-- line and the money line (a plain draft is unchanged: a promise kept). 4: a reading of every row
-- with an item hidden (its citation no longer this job's evidence) is no all-clear.
DO $eighthpure$
DECLARE s jsonb; asof constant timestamptz := '2026-10-07 02:00Z';
 ms constant jsonb := '{"id":"x","status":"processing","type":"makesafe","created_at":"2026-09-20T00:00:00Z"}';
 inv constant jsonb := '{"id":"x","status":"invoiced","type":"fencing","created_at":"2026-09-01T00:00:00Z"}';
 quoted constant jsonb := '{"id":"x","status":"quoted","type":"fencing","created_at":"2026-09-01T00:00:00Z"}';
 m1b constant jsonb := jsonb_build_object('rule', 'M1_money_due', 'loop_key', 'M1_money_due:i1', 'shown_as', 'loop', 'owner', 'customer', 'counterparty', 'us',
   'what', 'INV-1642 $2,145.00 owing from Builder Co (the builder), due Fri 16 Oct 2026', 'opened_at', '2026-10-01T16:00:00Z', 'due_date', '2026-10-16',
   'amount', 2145, 'about_key', 'invoice:inv-1642', 'source_table', 'xero_invoices', 'source_id', 'i1');
 r1n constant jsonb := jsonb_build_object('rule', 'R1_overdue', 'loop_key', 'R1_overdue:n1', 'shown_as', 'loop', 'owner', 'third_party', 'counterparty', 'us',
   'what', 'INV-9 $100.00 overdue from N (a neighbour paying part of this job) since Tue 1 Sep 2026 (36 days)',
   'opened_at', '2026-08-31T16:00:00Z', 'due_date', '2026-09-01', 'amount', 100, 'about_key', 'invoice:inv-9', 'source_table', 'xero_invoices', 'source_id', 'n1');
 m1c constant jsonb := jsonb_build_object('rule', 'M1_money_due', 'loop_key', 'M1_money_due:i2', 'shown_as', 'loop', 'owner', 'customer', 'counterparty', 'us',
   'what', 'INV-1597 $302.51 owing from Cash Client, due Tue 13 Oct 2026', 'opened_at', '2026-09-24T16:00:00Z', 'due_date', '2026-10-13',
   'amount', 302.51, 'about_key', 'invoice:inv-1597', 'source_table', 'xero_invoices', 'source_id', 'i2');
 r1c constant jsonb := jsonb_build_object('rule', 'R1_overdue', 'loop_key', 'R1_overdue:i3', 'shown_as', 'loop', 'owner', 'customer', 'counterparty', 'us',
   'what', 'INV-1236 $2,500.00 overdue from Rect Client since Thu 10 Sep 2026 (27 days)', 'opened_at', '2026-09-09T16:00:00Z', 'due_date', '2026-09-10',
   'amount', 2500, 'about_key', 'invoice:inv-1236', 'source_table', 'xero_invoices', 'source_id', 'i3');
 -- the customer's text on the job after the invoice, and our reply after it
 texted constant jsonb := '{"last_customer_message":{"at":"2026-10-01T01:00:00Z","channel":"sms","direction":"inbound","table":"business_events","id":"e9","placed_on":"this_job","event_type":"client.reply"},
   "last_to_customer":{"at":"2026-10-01T03:00:00Z","channel":"sms","direction":"outbound","table":"business_events","id":"e10","placed_on":"this_job"}}';
 -- their voicemail recording on the job (logged as an answered call), our call before it
 vm constant jsonb := '{"last_customer_message":{"at":"2026-09-25T10:28:47Z","channel":"call","direction":"inbound","table":"business_events","id":"e11","placed_on":"this_job","event_type":"call.transcript_completed"},
   "last_to_customer":{"at":"2026-09-25T09:41:40Z","channel":"call","direction":"outbound","table":"business_events","id":"e12","placed_on":"this_job"}}';
 read9 constant jsonb := '{"status":"live","generation":{"id":"g1","status":"live","evidence_until":"2026-10-05T00:00:00Z"},"items":[],"transitions":[],"unread_rows":0,"unread_ids":[],"read_ids":["e9"]}';
 -- (ninth review) the contact is the insured's: the make-safe details name the builder, and the
 -- job's contact details sit on no other client's job
 msf constant jsonb := '{"builder":"Builder Co"}';
 own constant jsonb := '{"contact_shared":{"shared":false,"by":[],"other_jobs":0}}';
BEGIN
 -- 1 (money): make-safe, the builder's invoice due 16 Oct, the insured's text off the job after it was raised
 s := public.context_job_story_assemble(ms, jsonb_build_object('loops', jsonb_build_array(m1b), 'facts', msf), NULL,
        own || '{"unplaced":{"count":1,"newest_customer_at":"2026-10-02T05:00:00Z"}}', asof, NULL);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'customer'
    OR position('The customer''s move, the customer owes: INV-1642 $2,145.00 owing from Builder Co (the builder), due Fri 16 Oct 2026' IN s->'now'->>'line') = 0
    OR s->'now'->>'line' ~* 'newest message' THEN
  RAISE EXCEPTION 'story safety contract: the insured''s message off the job never makes the builder''s payment unclear: %', s->'now';
 END IF;
 -- ... and with nothing open on builder work the contact facts name it as the insured's
 s := public.context_job_story_assemble(ms, jsonb_build_object('facts', msf), NULL,
        own || '{"unplaced":{"count":1,"newest_customer_at":"2026-10-02T05:00:00Z"}}', asof, NULL);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'unknown'
    OR position('the insured''s newest message Fri 2 Oct (not placed on any job), no reply from us on record' IN s->'now'->>'line') = 0
    OR s->'now'->>'line' LIKE '%newest customer message%' THEN
  RAISE EXCEPTION 'story safety contract: on builder work the contact''s message is named as the insured''s: %', s->'now';
 END IF;
 -- 1 (money): a neighbour's invoice overdue, the customer's newer text off the job: the neighbour's move stands
 s := public.context_job_story_assemble(inv, jsonb_build_object('loops', jsonb_build_array(r1n)), NULL,
        '{"unplaced":{"count":1,"newest_customer_at":"2026-10-03T01:00:00Z"}}', asof, NULL);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'third_party' OR s->'now'->>'line' LIKE '%off the job%'
    OR position('Waiting on another party, another payer owes: INV-9 $100.00 overdue from N' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: a message off the job changes only what its sender owes, never a neighbour''s: %', s->'now';
 END IF;
 -- 1 (words): their text on the job after the invoice, our reply since, no reading: whose move is unclear
 s := public.context_job_story_assemble(inv, jsonb_build_object('contact', texted, 'loops', jsonb_build_array(m1c)), NULL, NULL, asof, NULL);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'unknown'
    OR position('Whose move is unclear, the customer owes: INV-1597 $302.51 owing from Cash Client, due Tue 13 Oct 2026' IN s->'now'->>'line') = 0
    OR position('The customer''s newest message, Thu 1 Oct (a text), is not yet checked by the reader; our last reply Thu 1 Oct' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: the customer''s unread message on the job after what they owe leaves whose move unclear: %', s->'now';
 END IF;
 -- (a promise kept) once a finished reading has read it, the move stands
 s := public.context_job_story_assemble(inv, jsonb_build_object('contact', texted, 'loops', jsonb_build_array(m1c)), read9, NULL, asof, NULL);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'customer' OR s->'now'->>'line' LIKE '%not yet checked%' THEN
  RAISE EXCEPTION 'story safety contract: a message a finished reading has read leaves the move standing: %', s->'now';
 END IF;
 -- their voicemail recording on the job after the overdue invoice, nothing from us since
 s := public.context_job_story_assemble(inv, jsonb_build_object('contact', vm, 'loops', jsonb_build_array(r1c)), NULL, NULL, asof, NULL);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'unknown'
    OR position('Whose move is unclear, the customer owes: INV-1236' IN s->'now'->>'line') = 0
    OR position('The customer''s newest message, Fri 25 Sep (a call recording), is not yet checked by the reader; our last reply Fri 25 Sep' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: the customer''s voicemail after the overdue invoice leaves whose move unclear: %', s->'now';
 END IF;
 -- ... over what another party owes too (their message on the job may be about it)
 s := public.context_job_story_assemble(inv, jsonb_build_object('contact', texted, 'loops', jsonb_build_array(r1n)), NULL, NULL, asof, NULL);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'unknown'
    OR position('The customer''s newest message, Thu 1 Oct (a text), is not yet checked by the reader' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: the customer''s unread message on the job after another party''s invoice leaves whose move unclear: %', s->'now';
 END IF;
 -- (a promise kept) builder work: the insured's text on the job never makes the builder's payment unclear
 s := public.context_job_story_assemble(ms, jsonb_build_object('contact', texted || '{"last_customer_message":{"at":"2026-10-03T01:00:00Z","channel":"sms","direction":"inbound","table":"business_events","id":"e9","placed_on":"this_job"}}'::jsonb,
        'loops', jsonb_build_array(m1b), 'facts', msf), NULL, own, asof, NULL);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'customer' THEN
  RAISE EXCEPTION 'story safety contract: the insured''s message on the job never makes the builder''s payment unclear: %', s->'now';
 END IF;
 -- 9: the customer wrote last on the job, and their newer text sits in the admin bucket
 s := public.context_job_story_assemble(quoted, jsonb_build_object(
        'contact', '{"last_customer_message":{"at":"2026-09-16T01:00:00Z","channel":"sms","direction":"inbound","table":"business_events","id":"e1","placed_on":"this_job"}}'::jsonb,
        'loops', jsonb_build_array(jsonb_build_object('rule', 'R5_customer_wrote_last', 'loop_key', 'R5_customer_wrote_last:e1', 'shown_as', 'candidate', 'owner', 'us',
          'counterparty', 'customer', 'what', 'Customer texted Wed 16 Sep 09:00 and nothing went to the customer since: "Any news on the gate?"',
          'opened_at', '2026-09-16T01:00:00Z', 'about_key', 'contact:customer-reply', 'source_table', 'business_events', 'source_id', 'e1'))),
        NULL, '{"unplaced":{"count":1,"newest_customer_at":"2026-09-27T01:00:00Z"}}', asof, NULL);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'unknown'
    OR position('The customer wrote last on Wed 16 Sep; not yet checked by the reader: "Any news on the gate?"; the customer''s newest message, '
                || 'Sun 27 Sep (not placed on any job), is off the job and not yet checked by the reader' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: a newer message off the job is named after the customer wrote last: %', s->'now';
 END IF;
 -- 3: the full deposit drafted beside the two halves already issued (an R3 check): may duplicate, said so
 s := public.context_job_story_assemble(quoted, jsonb_build_object(
        'money', '[{"party":"Two Halves","xero_contact_id":"xh","invoiced":2601.5,"paid":2601.5,"credited":0,"owing":0,"overdue":0,"drafts":1,"draft_total":5203,
                    "invoices":[{"id":"d1","number":"INV-1553","status":"DRAFT","total":5203,"owing":0},{"id":"p1","number":"INV-1556","status":"PAID","total":2601.5,"owing":0}]},
                   {"party":"Other Payer","xero_contact_id":"xo","invoiced":2601.5,"paid":2601.5,"credited":0,"owing":0,"overdue":0,"drafts":0,"draft_total":0,
                    "invoices":[{"id":"p2","number":"INV-1555","status":"PAID","total":2601.5,"owing":0}]}]'::jsonb,
        'loops', jsonb_build_array(jsonb_build_object('rule', 'R3_draft', 'loop_key', 'R3_draft:d1', 'shown_as', 'check', 'owner', 'us', 'counterparty', 'customer',
          'what', 'Draft invoice INV-1553 $5,203.00 to Two Halves not issued since Fri 18 Sep 2026; it may duplicate the issued deposit invoices INV-1555, INV-1556',
          'opened_at', '2026-09-17T16:00:00Z', 'amount', 5203, 'about_key', 'invoice:inv-1553', 'source_table', 'xero_invoices', 'source_id', 'd1'))),
        NULL, NULL, asof, NULL);
 IF position('1 draft invoice not issued (it may duplicate issued invoices; check R3)' IN s->'now'->>'line') = 0
    OR position('1 draft invoice of $5,203.00 not issued (it may duplicate issued invoices; check R3)' IN s->'money'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: a draft shown as an R3 check is said to maybe duplicate issued invoices: % / %', s->'now'->>'line', s->'money'->>'line';
 END IF;
 -- ... and beside a plain draft, only the one that may duplicate is said so
 s := public.context_job_story_assemble(quoted, jsonb_build_object(
        'money', '[{"party":"Two Halves","xero_contact_id":"xh","invoiced":2601.5,"paid":2601.5,"credited":0,"owing":0,"overdue":0,"drafts":2,"draft_total":5703,
                    "invoices":[{"id":"d1","number":"INV-1553","status":"DRAFT","total":5203,"owing":0},{"id":"d3","number":"INV-1560","status":"DRAFT","total":500,"owing":0}]}]'::jsonb,
        'loops', jsonb_build_array(
          jsonb_build_object('rule', 'R3_draft', 'loop_key', 'R3_draft:d1', 'shown_as', 'check', 'owner', 'us', 'counterparty', 'customer',
           'what', 'Draft invoice INV-1553 $5,203.00 to Two Halves not issued since Fri 18 Sep 2026; it may duplicate the issued deposit invoices INV-1555, INV-1556',
           'opened_at', '2026-09-17T16:00:00Z', 'amount', 5203, 'about_key', 'invoice:inv-1553', 'source_table', 'xero_invoices', 'source_id', 'd1'),
          jsonb_build_object('rule', 'R3_draft', 'loop_key', 'R3_draft:d3', 'shown_as', 'loop', 'owner', 'us', 'counterparty', 'customer',
           'what', 'Draft invoice INV-1560 $500.00 to Two Halves not issued since Thu 1 Oct 2026', 'opened_at', '2026-09-30T16:00:00Z', 'amount', 500,
           'about_key', 'invoice:inv-1560', 'source_table', 'xero_invoices', 'source_id', 'd3'))),
        NULL, NULL, asof, NULL);
 IF position('2 draft invoices not issued (1 of them may duplicate issued invoices; check R3)' IN s->'now'->>'line') = 0
    OR position('2 draft invoices of $5,703.00 not issued (1 of them, $5,203.00, may duplicate issued invoices; check R3)' IN s->'money'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: beside a plain draft only the one that may duplicate is said so: % / %', s->'now'->>'line', s->'money'->>'line';
 END IF;
 -- (a promise kept) a plain draft to issue reads as before
 s := public.context_job_story_assemble(quoted, jsonb_build_object(
        'money', '[{"party":"Plain","xero_contact_id":"xp","invoiced":0,"paid":0,"credited":0,"owing":0,"overdue":0,"drafts":1,"draft_total":500,
                    "invoices":[{"id":"d2","number":"INV-10","status":"DRAFT","total":500,"owing":0}]}]'::jsonb,
        'loops', jsonb_build_array(jsonb_build_object('rule', 'R3_draft', 'loop_key', 'R3_draft:d2', 'shown_as', 'loop', 'owner', 'us', 'counterparty', 'customer',
          'what', 'Draft invoice INV-10 $500.00 to Plain not issued since Thu 1 Oct 2026', 'opened_at', '2026-09-30T16:00:00Z', 'amount', 500,
          'about_key', 'invoice:inv-10', 'source_table', 'xero_invoices', 'source_id', 'd2'))),
        NULL, NULL, asof, NULL);
 IF position('1 draft invoice not issued. ' IN s->'now'->>'line') = 0 OR s->'now'->>'line' LIKE '%may duplicate%'
    OR position('1 draft invoice of $500.00 not issued.' IN s->'money'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: a plain draft reads as before: % / %', s->'now'->>'line', s->'money'->>'line';
 END IF;
 -- 4: a live reading of every row whose one item is hidden (its citation is no longer this job's evidence)
 s := public.context_job_story_assemble(quoted, '{"contact":{"last_customer_message":{"at":"2026-10-01T01:00:00Z","channel":"sms","direction":"inbound","table":"business_events","id":"e1","placed_on":"this_job"}}}'::jsonb,
        '{"status":"live","generation":{"id":"g1","status":"live","evidence_until":"2026-10-05T00:00:00Z"},"transitions":[],"unread_rows":0,"unread_ids":[],"read_ids":["e1"],
          "items":[{"item_key":"commitment:us:call-back","item_type":"commitment","status":"open","from_role":"us","to_role":"customer","what":"Call the customer back about the June price",
                    "opened_at":"2026-09-16T01:00:00Z","opened_by":[{"table":"business_events","id":"e7","excerpt":"June words"}],"cites_ok":false,"person_locked":false}]}',
        NULL, asof, NULL);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'unknown' OR s->'now'->>'line' LIKE '%Nothing open%' OR s->'now'->>'line' LIKE '%we owe%'
    OR position('Whose move is unclear: no record item is open, and 1 reader item is hidden (a message it cites is no longer this job''s evidence); '
                || 'newest customer message Thu 1 Oct' IN s->'now'->>'line') = 0
    OR NOT (s->'meta'->'ledger'->>'needs_rebuild')::boolean THEN
  RAISE EXCEPTION 'story safety contract: a reading with an item hidden is no all-clear: % / %', s->'now', s->'meta'->'ledger';
 END IF;
END $eighthpure$;

-- Ninth review, regression fixes (pure assembler; each fails on the bddb8494 bodies unless marked a
-- promise kept). On builder work the job's contact is the insured's only when the make-safe details
-- name the builder and the meta says none of the job's contact details sits on another client's job
-- (contact_shared). A contact shared across clients is a builder's or an agent's (SWR-261488,
-- SWMS-261065 and SWMS-261163: one builder-side contact on three clients' jobs): the line calls its
-- messages the job contact's, never the insured's, and its newer message may be the builder's own
-- word on what the builder owes, so it holds the move as the customer's does; who never gives the
-- insured that contact, and not_known says why. With no builder named (a repair job quoted to its
-- client: SWF-261111) or the meta silent, the line never says "the insured" either.
DO $ninthpure$
DECLARE s jsonb; asof constant timestamptz := '2026-10-07 02:00Z';
 ms constant jsonb := '{"id":"x","status":"processing","type":"makesafe","created_at":"2026-09-20T00:00:00Z"}';
 rep constant jsonb := '{"id":"x","status":"schedule_install","type":"repair","created_at":"2026-08-26T00:00:00Z"}';
 msf constant jsonb := '{"builder":"Builder Co"}';
 shared constant jsonb := '{"contact_shared":{"shared":true,"by":["contact","phone"],"other_jobs":2}}';
 own constant jsonb := '{"contact_shared":{"shared":false,"by":[],"other_jobs":0}}';
 off constant jsonb := '{"unplaced":{"count":1,"newest_customer_at":"2026-10-02T05:00:00Z"}}';
 m1b constant jsonb := jsonb_build_object('rule', 'M1_money_due', 'loop_key', 'M1_money_due:i1', 'shown_as', 'loop', 'owner', 'customer', 'counterparty', 'us',
   'what', 'INV-1642 $2,145.00 owing from Builder Co (the builder), due Fri 16 Oct 2026', 'opened_at', '2026-10-01T16:00:00Z', 'due_date', '2026-10-16',
   'amount', 2145, 'about_key', 'invoice:inv-1642', 'source_table', 'xero_invoices', 'source_id', 'i1');
 -- the contact's text on the job after the builder's invoice, our reply before it
 texted constant jsonb := '{"last_customer_message":{"at":"2026-10-03T01:00:00Z","channel":"sms","direction":"inbound","table":"business_events","id":"e9","placed_on":"this_job","event_type":"client.reply"},
   "last_to_customer":{"at":"2026-10-01T03:00:00Z","channel":"sms","direction":"outbound","table":"business_events","id":"e10","placed_on":"this_job"}}';
 r5 constant jsonb := jsonb_build_object('rule', 'R5_customer_wrote_last', 'loop_key', 'R5_customer_wrote_last:e1', 'shown_as', 'candidate', 'owner', 'us',
   'counterparty', 'customer', 'what', 'Customer texted Wed 16 Sep 09:00 and nothing went to the customer since: "Any news on the roof?"',
   'opened_at', '2026-09-16T01:00:00Z', 'about_key', 'contact:customer-reply', 'source_table', 'business_events', 'source_id', 'e1');
BEGIN
 -- the shared contact's text off the job after the builder's invoice: whose move is unclear, and it
 -- is the job contact's message
 s := public.context_job_story_assemble(ms, jsonb_build_object('loops', jsonb_build_array(m1b), 'facts', msf), NULL, shared || off, asof, NULL);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'unknown'
    OR position('Whose move is unclear, the customer owes: INV-1642 $2,145.00 owing from Builder Co (the builder), due Fri 16 Oct 2026' IN s->'now'->>'line') = 0
    OR position('The job contact''s newest message, Fri 2 Oct (not placed on any job), is off the job and not yet checked by the reader' IN s->'now'->>'line') = 0
    OR s->'now'->>'line' ~* 'insured' THEN
  RAISE EXCEPTION 'story safety contract: a contact shared across clients holds the builder''s move and is never the insured: %', s->'now';
 END IF;
 -- ... with nothing open, the contact facts name it the job contact's
 s := public.context_job_story_assemble(ms, jsonb_build_object('facts', msf), NULL, shared || off, asof, NULL);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'unknown'
    OR position('the job contact''s newest message Fri 2 Oct (not placed on any job), no reply from us on record' IN s->'now'->>'line') = 0
    OR s->'now'->>'line' ~* 'insured' THEN
  RAISE EXCEPTION 'story safety contract: a shared contact''s message is the job contact''s, never the insured''s: %', s->'now';
 END IF;
 -- ... its unread text on the job after the builder's invoice: whose move is unclear
 s := public.context_job_story_assemble(ms, jsonb_build_object('contact', texted, 'loops', jsonb_build_array(m1b), 'facts', msf), NULL, shared, asof, NULL);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'unknown'
    OR position('The job contact''s newest message, Sat 3 Oct (a text), is not yet checked by the reader; our last reply Thu 1 Oct' IN s->'now'->>'line') = 0
    OR s->'now'->>'line' ~* 'insured' THEN
  RAISE EXCEPTION 'story safety contract: a shared contact''s unread text on the job holds the builder''s move: %', s->'now';
 END IF;
 -- ... it wrote last: never "the insured wrote last"
 s := public.context_job_story_assemble(ms, jsonb_build_object('loops', jsonb_build_array(r5), 'facts', msf,
        'contact', '{"last_customer_message":{"at":"2026-09-16T01:00:00Z","channel":"sms","direction":"inbound","table":"business_events","id":"e1","placed_on":"this_job"}}'::jsonb),
        NULL, shared, asof, NULL);
 IF position('The job contact wrote last on Wed 16 Sep; not yet checked by the reader: "Any news on the roof?"' IN s->'now'->>'line') = 0
    OR s->'now'->>'line' ~* 'insured' THEN
  RAISE EXCEPTION 'story safety contract: a shared contact that wrote last is the job contact, never the insured: %', s->'now';
 END IF;
 -- ... who never gives the insured the shared contact, and not_known says why
 s := public.context_job_story_assemble(ms || '{"client_name":"Home Owner","ghl_contact_id":"ct-shared"}'::jsonb, jsonb_build_object('facts', msf), NULL, shared, asof, NULL);
 IF (SELECT w->'contact_ref' FROM jsonb_array_elements(s->'who') w WHERE w->>'name' = 'Home Owner' AND w->>'role' = 'insured') IS DISTINCT FROM 'null'::jsonb
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'not_known') k
                   WHERE k->>'what' = 'This job''s CRM contact and client phone are also on 2 jobs of other clients, so the messages the story names are not taken to be the '
                                      || 'insured''s: the first line calls them the job contact''s.') THEN
  RAISE EXCEPTION 'story safety contract: who never gives the insured a contact shared across clients, and not_known says so: % / %', s->'who', s->'not_known';
 END IF;
 s := public.context_job_story_assemble(ms, jsonb_build_object('facts', msf), NULL,
        '{"contact_shared":{"shared":true,"by":["contact","email","phone"],"other_jobs":3}}', asof, NULL);
 IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'not_known') k
                WHERE k->>'what' = 'This job''s CRM contact, client email and client phone are also on 3 jobs of other clients, so the messages the story names are not '
                                   || 'taken to be the insured''s: the first line calls them the job contact''s.') THEN
  RAISE EXCEPTION 'story safety contract: not_known names each contact detail on another client''s job: %', s->'not_known';
 END IF;
 -- no builder named (a repair job quoted to its client), or the meta silent: never the insured
 s := public.context_job_story_assemble(rep, '{}'::jsonb, NULL, own || off, asof, NULL);
 IF position('the job contact''s newest message Fri 2 Oct (not placed on any job)' IN s->'now'->>'line') = 0 OR s->'now'->>'line' ~* 'insured' THEN
  RAISE EXCEPTION 'story safety contract: with no builder named the contact is never the insured: %', s->'now';
 END IF;
 s := public.context_job_story_assemble(ms, jsonb_build_object('facts', msf), NULL, off, asof, NULL);
 IF position('the job contact''s newest message Fri 2 Oct (not placed on any job)' IN s->'now'->>'line') = 0 OR s->'now'->>'line' ~* 'insured' THEN
  RAISE EXCEPTION 'story safety contract: with the meta silent on the contact it is never the insured: %', s->'now';
 END IF;
 -- (promises kept) the builder named and the contact the client's alone: the insured's, the builder's
 -- move stands over their message off the job, and who gives them their contact
 s := public.context_job_story_assemble(ms || '{"client_name":"Home Owner","ghl_contact_id":"ct-own"}'::jsonb,
        jsonb_build_object('loops', jsonb_build_array(m1b), 'facts', msf), NULL, own || off, asof, NULL);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'customer' OR s->'now'->>'line' ~* 'newest message'
    OR NOT s->'who' @> '[{"name":"Home Owner","role":"insured","contact_ref":"ct-own"}]'::jsonb
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(s->'not_known') k WHERE k->>'what' LIKE '%another client''s job%' OR k->>'what' LIKE '%jobs of other clients%') THEN
  RAISE EXCEPTION 'story safety contract: the client''s own contact is the insured''s and the builder''s move stands: % / %', s->'now', s->'who';
 END IF;
 s := public.context_job_story_assemble(ms, jsonb_build_object('facts', msf), NULL, own || off, asof, NULL);
 IF position('the insured''s newest message Fri 2 Oct (not placed on any job)' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: the client''s own contact''s message is the insured''s: %', s->'now';
 END IF;
END $ninthpure$;

BEGIN;
SET LOCAL session_replication_role = replica;
-- The fixtures are read as of Wed 7 Oct 2026 10:00 Perth: a fixture row that names no capture
-- time was captured the day they were written (6 Oct), never the day the suite runs, or every
-- run after that instant would see those rows land after the instant measured (rolled back).
ALTER TABLE public.business_events ALTER COLUMN context_captured_at SET DEFAULT '2026-10-06 12:00Z';
-- For the same reason the rule's first apply (context_ledger_mail_rule_since) is production's
-- own instant, Wed 7 Oct 2026 05:40 UTC, never the instant this stack was built: the fixtures
-- time their readings from it, and the judge calls a reading's unread evidence late when it
-- starts more than 14 days before the reading's evidence_until, so on a stack built after
-- 16 Oct 2026 00:00 UTC L3's 2 Oct mail read as late, not new (rolled back).
CREATE OR REPLACE FUNCTION public.context_ledger_mail_rule_since() RETURNS timestamptz
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $since$ SELECT '2026-10-07 05:40:14.825847+00'::timestamptz $since$;

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

-- The archived bucket job was last changed when it was archived (eighth review: a mail kept for
-- a copy on a job that is not live joined no earlier than that job's last change; a job row's
-- updated_at defaults to the clock of the run, which would make that depend on when the contract runs)
UPDATE public.jobs SET updated_at = '2026-08-01 01:00Z' WHERE id = '40000000-0000-4000-8000-000000000002';
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
 -- 2. Mail: a copy on the same job stands in for an inbox email (and one on another live job
 -- decides where it belongs: the seventh review's G1); one on the archived bucket or none keeps it.
 SELECT string_agg(x.id::text, ',' ORDER BY x.id) INTO got FROM public.context_job_record_legacy_mail(ARRAY[m], asof) x;
 IF got IS DISTINCT FROM '40a00000-0000-4000-8000-000000000001,40a00000-0000-4000-8000-000000000002,40a00000-0000-4000-8000-000000000004' THEN
  RAISE EXCEPTION 'story safety contract: an inbox email is dropped only for a saved copy on the same job: %', got;
 END IF;
 s := public.context_job_story(m, asof);
 IF s->'last_exchange'->'customer_said'->>'id' IS DISTINCT FROM '40a00000-0000-4000-8000-000000000001'
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'not_known') k
                   WHERE k->>'what' = '2 emails on this job are shown from the old inbox: their saved copies are on no job yet or on a job that is not live (archived, completed, cancelled, lost, a draft or holding).')
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
        WHERE k->>'what' = '2 emails on this job are shown from the old inbox: their saved copies are on no job yet or on a job that is not live (archived, completed, cancelled, lost, a draft or holding).') <> 1 THEN
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
 IF got IS DISTINCT FROM '01=Customer emailed Sat 3 Oct 09:00 (from the old inbox; its saved copy is on archived job SWF-T4002) and nothing went to the customer since: '
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
-- (lead cutoff, 20261007010000: both quotes, and the customer's messages on the job, inside the 4
-- weeks a lead is followed up, so each is still a quote waiting)
VALUES ('40e00000-0000-4000-8000-000000000071', '40000000-0000-4000-8000-000000000071', 'quote', 'Q-4071', 1, '2026-09-14 01:00Z', '2026-09-14 01:10Z', '2026-09-15 01:00Z', NULL),
       ('40e00000-0000-4000-8000-000000000072', '40000000-0000-4000-8000-000000000072', 'quote', 'Q-4072', 1, '2026-09-17 01:00Z', '2026-09-17 01:10Z', NULL, NULL);
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  attribution_status, attribution_confidence, candidate_job_ids)
VALUES
 -- C: the customer's answered call on the job a week after the quote
 ('40b00000-0000-4000-8000-000000000171', '40000000-0000-4000-8000-000000000071', 'client.call_logged', 'ghl', 'call', 'inbound', 'ct40cc',
  '{"body":"Call. Provider status: completed. Duration: 333 seconds","call_status":"completed"}',
  '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}', '2026-09-21 01:00Z', '2026-09-21 01:00Z', '2026-09-21 01:00Z', 'direct', 1, NULL),
 -- X: their text and our reply on the job before the quote; their text after it, placed on no job
 ('40b00000-0000-4000-8000-000000000172', '40000000-0000-4000-8000-000000000072', 'client.reply', 'ghl', 'sms', 'inbound', 'ct40tt',
  '{"body":"Can you quote the back fence?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-09-16 01:00Z', '2026-09-16 01:00Z', '2026-09-16 01:00Z', 'direct', 1, NULL),
 ('40b00000-0000-4000-8000-000000000173', '40000000-0000-4000-8000-000000000072', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct40tt',
  '{"body":"Yes, the quote is on its way"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
  '2026-09-17 00:30Z', '2026-09-17 00:30Z', '2026-09-17 00:30Z', 'direct', 1, NULL),
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
    OR r.what IS DISTINCT FROM 'Quote Q-4071 v1 sent Mon 14 Sep 2026 (23 days), viewed; no answer recorded, but the customer was in touch since: an answered call Mon 21 Sep 2026' THEN
  RAISE EXCEPTION 'story safety contract: a quote the customer rang about since is not waiting on them: %', row_to_json(r);
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000071', asof);
 IF s->'now'->>'whose_move' <> 'unknown' OR s->'now'->>'line' LIKE '%waiting on the customer%' OR s->'now'->>'line' LIKE '%no customer message since%'
    OR position('Whose move is unclear, open: Quote Q-4071 v1 sent Mon 14 Sep 2026 (23 days), viewed; no answer recorded, but the customer was in touch since: '
                || 'an answered call Mon 21 Sep 2026' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: the first line names the customer''s contact since the quote: %', s->'now';
 END IF;
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000072'::uuid], asof) l WHERE l.rule = 'R7_quote_waiting';
 IF r.owner IS DISTINCT FROM 'unknown'
    OR r.what IS DISTINCT FROM 'Quote Q-4072 v1 sent Thu 17 Sep 2026 (20 days), not viewed; no answer recorded, but the customer was in touch since: '
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
-- before the 15 Sep quote, loaded on 20 Sep after it (their last word on the job was 13 Sep, our
-- reply 14 Sep; the quote inside the 4 weeks a lead is followed up: lead cutoff,
-- 20261007010000). Y: nothing on the job; their text and our reply the CRM dates 25 and 26 Aug,
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
VALUES ('40e00000-0000-4000-8000-000000000077', '40000000-0000-4000-8000-000000000077', 'quote', 'Q-4077', 1, '2026-09-15 01:00Z', '2026-09-15 01:10Z', NULL, NULL),
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
  '2026-09-13 01:00Z', '2026-09-13 01:00Z', '2026-09-13 01:00Z', 'direct', 1, NULL, NULL),
 ('40b00000-0000-4000-8000-000000000186', '40000000-0000-4000-8000-000000000077', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct40zq',
  '{"body":"It will be with you on Tuesday"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
  '2026-09-14 01:00Z', '2026-09-14 01:00Z', '2026-09-14 01:00Z', 'direct', 1, NULL, NULL),
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
    OR r.what IS DISTINCT FROM 'Quote Q-4077 v1 sent Tue 15 Sep 2026 (22 days), not viewed; no answer and no customer message since' THEN
  RAISE EXCEPTION 'story safety contract: a text the customer sent before the quote is never contact since it, however late it was loaded: %', row_to_json(r);
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000077', asof);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'customer' OR s->'now'->>'line' LIKE '%in touch since%'
    OR position('The customer''s move, waiting on the customer: Quote Q-4077 v1 sent Tue 15 Sep 2026 (22 days), not viewed; no answer and no customer message since'
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

-- Sixth review fixtures (each fails on the 729d928b bodies unless said to be a promise kept).
-- Money: E1 (bda6e1de class) has no job number invoices could name (a CRM import's), a value set from the CRM ($1,000.00, source
-- ghl) and no quote; its own invoice is paid ($704.00) and the rest of the quote is billed to
-- its own Xero contact on an invoice placed on no job, still owing; work done (invoiced 20 Apr).
-- E2 and E2b: a CRM value, and the $1,000.00 placeholder with no source, nothing behind either.
-- E3: a scoping-tool value, the rest billed to its own contact on an invoice placed on no job that
-- names nothing. E4: the same with a contact billed on builder work (still a check of the value,
-- never named as this job's debt). D1, D2, D3 (SWP-25005 class): D2, an archived duplicate record
-- (same client, same kind, same site), holds the invoices; D3 is the client's job of another
-- kind at the same site. R1 (SWP-26354 class): completion pack, invoiced, back in rectification;
-- R2: reopened by a rectification, rework scheduled since; R3: reopened and invoiced again.
-- Who and when: T1, a backfilled text whose cache row was written over after the cache held it;
-- T2, one whose CRM time was never kept. Words: N1 (SWF-261111 class), invoiced, its quote
-- never answered on the record, the customer's answered call after it placed on no job with
-- no attribution status. M1, M2 (SWF-261506 and SWF-261509 class): one customer's two quoted
-- jobs, their missed call after ours placed on no job between them; M3, M4: the same with our
-- text after it, placed on M4. Q1, Q2, Q3 (SWF-26403, SWF-26404 and SWF-26498 class): two
-- quotes waiting and the customer's later combined job at the same address, accepted, with
-- their email on it. S1 (SWF-261423 class): a full deposit draft while the deposit is issued as
-- two split invoices.
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, client_email, ghl_contact_id, xero_contact_id, pricing_json,
  accepted_at, completed_at, created_at, site_address)
VALUES
 ('40000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-0000000000aa', 'GHL-IMPORT-0101', 'invoiced', 'fencing', 'CRM Value Client',
  NULL, 'ct40e1', 'x40-e1', '{"source":"ghl","totalExGST":909.09,"totalIncGST":1000}', '2025-10-21 04:19Z', NULL, '2025-10-21 04:19Z', NULL),
 ('40000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-0000000000aa', 'SWF-94102', 'in_progress', 'fencing', 'Placeholder Client',
  NULL, 'ct40e2', NULL, '{"source":"ghl","totalExGST":909.09,"totalIncGST":1000}', '2025-10-02 03:39Z', NULL, '2025-10-02 03:39Z', NULL),
 ('40000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-0000000000aa', 'SWF-94103', 'in_progress', 'fencing', 'Placeholder Two',
  NULL, 'ct40e2b', NULL, '{"totalIncGST":1000}', '2026-02-19 02:25Z', NULL, '2026-02-19 02:25Z', NULL),
 ('40000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-0000000000aa', 'SWF-94104', 'invoiced', 'fencing', 'Own Contact Client',
  NULL, 'ct40e3', 'x40-e3', '{"source":"scoping_tool","totalIncGST":2000}', '2026-05-01 01:00Z', NULL, '2026-05-01 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-0000000000aa', 'SWF-94105', 'invoiced', 'fencing', 'Builder Paid Client',
  NULL, 'ct40e4', 'x40-ms81', '{"source":"scoping_tool","totalIncGST":2000}', '2026-05-01 01:00Z', NULL, '2026-05-01 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000124', '00000000-0000-4000-8000-0000000000aa', 'SWP-94124', 'invoiced', 'patio', 'Duplicate Client',
  NULL, 'ct40dd', NULL, '{"source":"scoping_tool","totalIncGST":12735.02}', '2025-11-16 10:04Z', NULL, '2025-11-16 10:04Z', '12 Example Street'),
 ('40000000-0000-4000-8000-000000000125', '00000000-0000-4000-8000-0000000000aa', 'SWP-94125', 'archived', 'patio', 'Duplicate Client',
  NULL, 'ct40dd', 'x40-dd', '{"source":"ghl","totalIncGST":14048.33}', '2025-11-17 07:35Z', NULL, '2025-11-17 07:35Z', '12 Example Street'),
 ('40000000-0000-4000-8000-000000000126', '00000000-0000-4000-8000-0000000000aa', 'SWF-94126', 'archived', 'fencing', 'Duplicate Client',
  NULL, 'ct40dd', 'x40-dd', '{}', NULL, NULL, '2025-12-01 01:00Z', '12 Example Street'),
 ('40000000-0000-4000-8000-000000000127', '00000000-0000-4000-8000-0000000000aa', 'SWP-94127', 'rectification', 'patio', 'Review Client',
  NULL, 'ct40r1', 'x40-r1', '{"source":"scoping_tool","totalIncGST":7920}', '2026-06-17 08:33Z', NULL, '2026-05-21 13:06Z', NULL),
 ('40000000-0000-4000-8000-000000000128', '00000000-0000-4000-8000-0000000000aa', 'SWP-94128', 'scheduled', 'patio', 'Rework Client',
  NULL, 'ct40r2', 'x40-r2', '{"source":"scoping_tool","totalIncGST":7920}', '2026-06-17 08:33Z', NULL, '2026-05-21 13:06Z', NULL),
 ('40000000-0000-4000-8000-000000000129', '00000000-0000-4000-8000-0000000000aa', 'SWP-94129', 'invoiced', 'patio', 'Done Again Client',
  NULL, 'ct40r3', 'x40-r3', '{"source":"scoping_tool","totalIncGST":7920}', '2026-06-17 08:33Z', NULL, '2026-05-21 13:06Z', NULL),
 ('40000000-0000-4000-8000-000000000113', '00000000-0000-4000-8000-0000000000aa', 'SWF-94113', 'quoted', 'fencing', 'Kept Time Client',
  NULL, 'ct40t1', NULL, '{}', NULL, NULL, '2026-06-01 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000114', '00000000-0000-4000-8000-0000000000aa', 'SWF-94114', 'quoted', 'fencing', 'Lost Time Client',
  NULL, 'ct40t2', NULL, '{}', NULL, NULL, '2026-08-20 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000115', '00000000-0000-4000-8000-0000000000aa', 'SWF-94115', 'invoiced', 'fencing', 'Phone Yes Client',
  NULL, 'ct40n1', NULL, '{}', NULL, NULL, '2026-07-30 04:44Z', NULL),
 ('40000000-0000-4000-8000-000000000116', '00000000-0000-4000-8000-0000000000aa', 'SWF-94116', 'quoted', 'fencing', 'Two Quotes Client',
  NULL, 'ct40m1', NULL, '{}', NULL, NULL, '2026-10-01 00:54Z', NULL),
 ('40000000-0000-4000-8000-000000000117', '00000000-0000-4000-8000-0000000000aa', 'SWF-94117', 'quoted', 'fencing', 'Two Quotes Client',
  NULL, 'ct40m1', NULL, '{}', NULL, NULL, '2026-10-01 07:38Z', NULL),
 ('40000000-0000-4000-8000-000000000118', '00000000-0000-4000-8000-0000000000aa', 'SWF-94118', 'quoted', 'fencing', 'Called Back Client',
  NULL, 'ct40m2', NULL, '{}', NULL, NULL, '2026-10-01 00:54Z', NULL),
 ('40000000-0000-4000-8000-000000000119', '00000000-0000-4000-8000-0000000000aa', 'SWF-94119', 'quoted', 'fencing', 'Called Back Client',
  NULL, 'ct40m2', NULL, '{}', NULL, NULL, '2026-10-01 07:38Z', NULL),
 ('40000000-0000-4000-8000-000000000120', '00000000-0000-4000-8000-0000000000aa', 'SWF-94120', 'quoted', 'fencing', 'Combined Client',
  NULL, 'ct40q1', NULL, '{}', NULL, NULL, '2026-06-03 05:09Z', '7 Sample Road'),
 ('40000000-0000-4000-8000-000000000121', '00000000-0000-4000-8000-0000000000aa', 'SWF-94121', 'quoted', 'fencing', 'Combined Client',
  NULL, 'ct40q1', NULL, '{}', NULL, NULL, '2026-06-03 05:16Z', '7 Sample Road'),
 ('40000000-0000-4000-8000-000000000122', '00000000-0000-4000-8000-0000000000aa', 'SWF-94122', 'archived', 'fencing', 'Combined Client',
  NULL, 'ct40q1', NULL, '{}', '2026-06-30 05:13Z', NULL, '2026-06-05 23:24Z', '7 Sample Road'),
 ('40000000-0000-4000-8000-000000000123', '00000000-0000-4000-8000-0000000000aa', 'SWF-94123', 'order_materials', 'fencing', 'Split Deposit Client',
  NULL, 'ct40s1', NULL, '{"source":"scoping_tool","totalIncGST":4763}', '2026-09-20 01:00Z', NULL, '2026-09-15 09:41Z', NULL);
INSERT INTO public.job_contacts (id, job_id, contact_type, client_name, xero_contact_id, is_primary, created_at)
VALUES ('40d00000-0000-4000-8000-000000000623', '40000000-0000-4000-8000-000000000123', 'primary', 'Split Deposit Client', 'x40-s1c', true, '2026-09-15 09:41Z'),
       ('40d00000-0000-4000-8000-000000000624', '40000000-0000-4000-8000-000000000123', 'neighbour_b', 'Neighbour S', 'x40-s1n', false, '2026-09-15 09:41Z');
INSERT INTO public.xero_invoices (org_id, id, job_id, xero_invoice_id, xero_contact_id, contact_name, invoice_number, invoice_type, status, reference,
  total, amount_due, amount_paid, invoice_date, due_date, fully_paid_on, line_items, raw_json, job_contact_id, created_at)
VALUES
 -- E1: its own invoice paid; the rest billed to its own contact, placed on no job, owing
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000601', '40000000-0000-4000-8000-000000000101', 'x6101', 'x40-e1', 'CRM Value Client',
  'INV-6101', 'ACCREC', 'PAID', 'QT01417', 704.00, 0, 704.00, '2025-11-01', '2025-11-08', '2025-11-05',
  '[{"Description":"Fence removal | 50% of quote QT01417","LineAmount":640,"TaxAmount":64}]', '{"Status":"PAID","Payments":[]}', NULL, '2025-11-01 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000602', NULL, 'x6102', 'x40-e1', 'CRM Value Client',
  'INV-6102', 'ACCREC', 'AUTHORISED', 'QT01417', 704.00, 704.00, 0, '2026-02-28', '2026-03-14', NULL,
  '[{"Description":"Fence removal | Remaining quote amount","LineAmount":640,"TaxAmount":64}]', '{"Status":"AUTHORISED","Payments":[]}', NULL, '2026-02-28 01:00Z'),
 -- E3: its own invoice paid; the rest to its own contact on no job, naming nothing
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000631', '40000000-0000-4000-8000-000000000104', 'x6131', 'x40-e3', 'Own Contact Client',
  'INV-6131', 'ACCREC', 'PAID', 'SWF-94104-A', 1000.00, 0, 1000.00, '2026-06-01', '2026-06-08', '2026-06-05',
  '[{"Description":"Fence work","LineAmount":909.09,"TaxAmount":90.91}]', '{"Status":"PAID","Payments":[]}', NULL, '2026-06-01 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000632', NULL, 'x6132', 'x40-e3', 'Own Contact Client',
  'INV-6132', 'ACCREC', 'AUTHORISED', 'QT2001', 1000.00, 1000.00, 0, '2026-09-01', '2026-09-30', NULL,
  '[{"Description":"Remaining amount","LineAmount":909.09,"TaxAmount":90.91}]', '{"Status":"AUTHORISED","Payments":[]}', NULL, '2026-09-01 01:00Z'),
 -- E4: the same, its contact billed on builder work (SWMS-94081)
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000641', '40000000-0000-4000-8000-000000000105', 'x6141', 'x40-ms81', 'MS Builder',
  'INV-6141', 'ACCREC', 'PAID', 'SWF-94105-A', 1000.00, 0, 1000.00, '2026-06-01', '2026-06-08', '2026-06-05',
  '[{"Description":"Fence work","LineAmount":909.09,"TaxAmount":90.91}]', '{"Status":"PAID","Payments":[]}', NULL, '2026-06-01 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000642', NULL, 'x6142', 'x40-ms81', 'MS Builder',
  'INV-6142', 'ACCREC', 'AUTHORISED', 'QT2002', 1000.00, 1000.00, 0, '2026-09-01', '2026-09-30', NULL,
  '[{"Description":"Remaining amount","LineAmount":909.09,"TaxAmount":90.91}]', '{"Status":"AUTHORISED","Payments":[]}', NULL, '2026-09-01 01:00Z'),
 -- D2 (the duplicate record) holds the invoices naming the quote; D3, another kind, one of its own
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000651', '40000000-0000-4000-8000-000000000125', 'x6151', 'x40-dd', 'Duplicate Client',
  'INV-6151', 'ACCREC', 'PAID', 'QT01356', 7032.22, 0, 7032.22, '2025-11-20', '2025-11-27', '2025-11-25',
  '[{"Description":"Patio | 50% of quote QT01356","LineAmount":6392.93,"TaxAmount":639.29}]', '{"Status":"PAID","Payments":[]}', NULL, '2025-11-20 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000652', '40000000-0000-4000-8000-000000000125', 'x6152', 'x40-dd', 'Duplicate Client',
  'INV-6152', 'ACCREC', 'PAID', 'QT01356', 7016.11, 0, 7016.11, '2026-05-10', '2026-05-17', '2026-05-12',
  '[{"Description":"Patio | Remaining quote amount","LineAmount":6378.28,"TaxAmount":637.83}]', '{"Status":"PAID","Payments":[]}', NULL, '2026-05-10 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000653', '40000000-0000-4000-8000-000000000126', 'x6153', 'x40-dd', 'Duplicate Client',
  'INV-6153', 'ACCREC', 'PAID', 'SWF-94126', 500.00, 0, 500.00, '2025-12-05', '2025-12-12', '2025-12-10',
  '[{"Description":"Gate","LineAmount":454.55,"TaxAmount":45.45}]', '{"Status":"PAID","Payments":[]}', NULL, '2025-12-05 01:00Z'),
 -- R1: a 50% deposit paid and a 25% progress invoice part paid, overdue; R2 and R3: the deposit paid
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000671', '40000000-0000-4000-8000-000000000127', 'x6171', 'x40-r1', 'Review Client',
  'INV-6171', 'ACCREC', 'PAID', 'SWP-94127-DEP50', 3960.00, 0, 3960.00, '2026-06-17', '2026-06-24', '2026-06-20',
  '[{"Description":"Deposit (50% of $7,920.00 inc GST)","LineAmount":3600,"TaxAmount":360}]', '{"Status":"PAID","Payments":[]}', NULL, '2026-06-17 09:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000672', '40000000-0000-4000-8000-000000000127', 'x6172', 'x40-r1', 'Review Client',
  'INV-6172', 'ACCREC', 'AUTHORISED', 'SWP-94127-DEP25', 1980.00, 1480.00, 500.00, '2026-07-24', '2026-08-07', NULL,
  '[{"Description":"Progress payment (25% of $7,920.00 inc GST)","LineAmount":1800,"TaxAmount":180}]', '{"Status":"AUTHORISED","Payments":[]}', NULL, '2026-07-24 02:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000681', '40000000-0000-4000-8000-000000000128', 'x6181', 'x40-r2', 'Rework Client',
  'INV-6181', 'ACCREC', 'PAID', 'SWP-94128-DEP50', 3960.00, 0, 3960.00, '2026-06-17', '2026-06-24', '2026-06-20',
  '[{"Description":"Deposit (50% of $7,920.00 inc GST)","LineAmount":3600,"TaxAmount":360}]', '{"Status":"PAID","Payments":[]}', NULL, '2026-06-17 09:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000691', '40000000-0000-4000-8000-000000000129', 'x6191', 'x40-r3', 'Done Again Client',
  'INV-6191', 'ACCREC', 'PAID', 'SWP-94129-DEP50', 3960.00, 0, 3960.00, '2026-06-17', '2026-06-24', '2026-06-20',
  '[{"Description":"Deposit (50% of $7,920.00 inc GST)","LineAmount":3600,"TaxAmount":360}]', '{"Status":"PAID","Payments":[]}', NULL, '2026-06-17 09:00Z'),
 -- S1: the customer's 25% deposit overdue, the neighbour's 25% paid, the full 50% deposit a draft
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000623', '40000000-0000-4000-8000-000000000123', 'x6123a', 'x40-s1c', 'Split Deposit Client',
  'INV-6123', 'ACCREC', 'AUTHORISED', 'SWF-94123-DEP25', 1190.75, 1190.75, 0, '2026-09-24', '2026-10-01', NULL,
  NULL, '{"Status":"AUTHORISED","Payments":[]}', '40d00000-0000-4000-8000-000000000623', '2026-09-24 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000624', '40000000-0000-4000-8000-000000000123', 'x6123b', 'x40-s1n', 'Neighbour S',
  'INV-6124', 'ACCREC', 'PAID', 'SWF-94123-B-DEP25', 1190.75, 0, 1190.75, '2026-09-24', '2026-10-01', '2026-10-05',
  NULL, '{"Status":"PAID","Payments":[]}', '40d00000-0000-4000-8000-000000000624', '2026-09-24 01:05Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000625', '40000000-0000-4000-8000-000000000123', 'x6123c', 'x40-s1c', 'Split Deposit Client',
  'INV-6125', 'ACCREC', 'DRAFT', 'SWF-94123-DEP50', 2381.50, 2381.50, 0, '2026-10-01', '2026-10-08', NULL,
  '[{"Description":"Deposit ($2,381.50 inc GST)","LineAmount":2165,"TaxAmount":216.5}]', '{"Status":"DRAFT","Payments":[]}', '40d00000-0000-4000-8000-000000000623', '2026-10-01 01:00Z');
INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at, viewed_at, declined_at)
VALUES ('40e00000-0000-4000-8000-000000000615', '40000000-0000-4000-8000-000000000115', 'quote', 'Q-6115', 1, '2026-08-05 01:00Z', '2026-08-05 01:10Z', NULL, NULL),
       ('40e00000-0000-4000-8000-000000000616', '40000000-0000-4000-8000-000000000116', 'quote', 'Q-6116', 1, '2026-10-02 01:00Z', '2026-10-02 01:10Z', NULL, NULL),
       ('40e00000-0000-4000-8000-000000000617', '40000000-0000-4000-8000-000000000117', 'quote', 'Q-6117', 1, '2026-10-02 01:00Z', '2026-10-02 01:20Z', NULL, NULL),
       ('40e00000-0000-4000-8000-000000000620', '40000000-0000-4000-8000-000000000120', 'quote', 'Q-6120', 1, '2026-06-03 05:50Z', '2026-06-03 06:00Z', '2026-06-04 01:00Z', NULL),
       ('40e00000-0000-4000-8000-000000000621', '40000000-0000-4000-8000-000000000121', 'quote', 'Q-6121', 1, '2026-06-03 06:00Z', '2026-06-03 06:10Z', '2026-06-04 01:00Z', NULL);
INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at)
VALUES ('40200000-0000-4000-8000-000000000601', '40000000-0000-4000-8000-000000000101', 'status_changed', '{"new_status":"invoiced","old_status":"in_progress"}', '2026-04-20 02:00Z'),
       ('40200000-0000-4000-8000-000000000604', '40000000-0000-4000-8000-000000000104', 'status_changed', '{"new_status":"invoiced","old_status":"in_progress"}', '2026-09-01 02:00Z'),
       ('40200000-0000-4000-8000-000000000605', '40000000-0000-4000-8000-000000000105', 'status_changed', '{"new_status":"invoiced","old_status":"in_progress"}', '2026-09-01 02:00Z'),
       ('40200000-0000-4000-8000-000000000624', '40000000-0000-4000-8000-000000000124', 'status_changed', '{"new_status":"invoiced","old_status":"in_progress"}', '2026-05-13 02:00Z'),
       ('40200000-0000-4000-8000-000000000671', '40000000-0000-4000-8000-000000000127', 'completion_pack_generated', '{}', '2026-07-22 03:00Z'),
       ('40200000-0000-4000-8000-000000000672', '40000000-0000-4000-8000-000000000127', 'status_changed', '{"new_status":"invoiced","old_status":"in_progress"}', '2026-07-24 02:00Z'),
       ('40200000-0000-4000-8000-000000000673', '40000000-0000-4000-8000-000000000127', 'status_changed', '{"new_status":"rectification","old_status":"invoiced"}', '2026-08-19 02:00Z'),
       ('40200000-0000-4000-8000-000000000681', '40000000-0000-4000-8000-000000000128', 'completion_pack_generated', '{}', '2026-07-22 03:00Z'),
       ('40200000-0000-4000-8000-000000000683', '40000000-0000-4000-8000-000000000128', 'status_changed', '{"new_status":"rectification","old_status":"in_progress"}', '2026-08-19 02:00Z'),
       ('40200000-0000-4000-8000-000000000684', '40000000-0000-4000-8000-000000000128', 'status_changed', '{"new_status":"scheduled","old_status":"rectification"}', '2026-08-25 02:00Z'),
       ('40200000-0000-4000-8000-000000000691', '40000000-0000-4000-8000-000000000129', 'completion_pack_generated', '{}', '2026-07-22 03:00Z'),
       ('40200000-0000-4000-8000-000000000693', '40000000-0000-4000-8000-000000000129', 'status_changed', '{"new_status":"rectification","old_status":"in_progress"}', '2026-08-19 02:00Z'),
       ('40200000-0000-4000-8000-000000000694', '40000000-0000-4000-8000-000000000129', 'status_changed', '{"new_status":"invoiced","old_status":"rectification"}', '2026-09-01 02:00Z'),
       ('40200000-0000-4000-8000-000000000615', '40000000-0000-4000-8000-000000000115', 'completion_pack_generated', '{}', '2026-08-12 03:00Z'),
       ('40200000-0000-4000-8000-000000000616', '40000000-0000-4000-8000-000000000115', 'status_changed', '{"new_status":"invoiced","old_status":"in_progress"}', '2026-08-20 02:00Z');
-- T1: the cache held the text's CRM time, then a sync wrote its row over with 30 newer messages
-- (written with the triggers on, as the cache's writers write it)
SET LOCAL session_replication_role = origin;
INSERT INTO public.ghl_conversation_cache (contact_id, job_id, messages, synced_at)
VALUES ('ct40t1', NULL, '[{"id":"m40-t1","timestamp":"2026-06-15T02:00:00.000Z","direction":"inbound"}]', '2026-06-20 01:00Z');
UPDATE public.ghl_conversation_cache
SET messages = (SELECT jsonb_agg(jsonb_build_object('id', 'm40-t1x' || g, 'timestamp', '2026-09-' || lpad((g % 28 + 1)::text, 2, '0') || 'T01:00:00.000Z',
                                                    'direction', 'inbound') ORDER BY g) FROM generate_series(1, 30) g),
    synced_at = '2026-09-29 01:00Z'
WHERE contact_id = 'ct40t1';
SET LOCAL session_replication_role = replica;
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence, candidate_job_ids, provider_message_id)
VALUES
 -- T1: loaded on 16 Sep from the cache; the CRM sent it on 15 Jun
 ('40b00000-0000-4000-8000-000000000601', '40000000-0000-4000-8000-000000000113', 'client.reply', 'ghl_sms_cache_backfill', 'sms', 'inbound', 'ct40t1',
  '{"body":"Can you come Tuesday?","ghl_message_id":"m40-t1"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-09-16 01:00Z', '2026-09-16 01:00Z', '2026-09-16 01:00Z', '2026-09-16 01:00Z', 'single_open', 1, NULL, 'ghl:m40-t1'),
 -- T2: our text on 9 Sep; their text loaded on 17 Sep from a cache that no longer holds it, its CRM time never kept
 ('40b00000-0000-4000-8000-000000000603', '40000000-0000-4000-8000-000000000114', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct40t2',
  '{"body":"Your quote is on its way"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
  '2026-09-09 01:00Z', '2026-09-09 01:00Z', '2026-09-09 01:00Z', '2026-09-09 01:00Z', 'direct', 1, NULL, NULL),
 ('40b00000-0000-4000-8000-000000000602', '40000000-0000-4000-8000-000000000114', 'client.reply', 'ghl_sms_cache_backfill', 'sms', 'inbound', 'ct40t2',
  '{"body":"Words of an unknown day","ghl_message_id":"m40-t2"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-09-17 01:00Z', '2026-09-17 01:00Z', '2026-09-17 01:00Z', '2026-09-17 01:00Z', 'single_open', 1, NULL, 'ghl:m40-t2'),
 -- N1: the customer's answered call after the quote, placed on no job, no attribution status
 ('40b00000-0000-4000-8000-000000000611', NULL, 'client.call_complete', 'ghl-webhook-receiver', 'call', 'inbound', 'ct40n1',
  '{"body":"Call. Provider status: completed. Duration: 300 seconds","call_status":"completed"}',
  '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-08-05 05:00Z', '2026-08-05 05:00Z', '2026-08-05 05:00Z', '2026-08-05 05:00Z', NULL, NULL, NULL, NULL),
 -- M1, M2: our call and text on M1, then their call that rang out, waiting placement between M1 and M2
 ('40b00000-0000-4000-8000-000000000616', '40000000-0000-4000-8000-000000000116', 'client.call_complete', 'ghl-webhook-receiver', 'call', 'outbound', 'ct40m1',
  '{"body":"Call. Provider status: completed. Duration: 283 seconds","call_status":"completed"}',
  '{"party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
  '2026-10-05 03:38Z', '2026-10-05 03:38Z', '2026-10-05 03:38Z', '2026-10-05 03:38Z', 'direct', 1, NULL, NULL),
 ('40b00000-0000-4000-8000-000000000617', '40000000-0000-4000-8000-000000000116', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct40m1',
  '{"body":"Sorry we missed you, call when you can"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
  '2026-10-05 03:53Z', '2026-10-05 03:53Z', '2026-10-05 03:53Z', '2026-10-05 03:53Z', 'direct', 1, NULL, NULL),
 ('40b00000-0000-4000-8000-000000000618', NULL, 'client.call_complete', 'ghl-webhook-receiver', 'call', 'inbound', 'ct40m1',
  '{"body":"Call. Provider status: ringing. Duration: 0 seconds","call_status":"ringing"}',
  '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-05 03:56Z', '2026-10-05 03:56Z', '2026-10-05 03:56Z', '2026-10-05 03:56Z', 'pending_luna', NULL,
  ARRAY['40000000-0000-4000-8000-000000000116', '40000000-0000-4000-8000-000000000117']::uuid[], NULL),
 -- M3, M4: their call that rang out, then our text to them, placed on M4
 ('40b00000-0000-4000-8000-000000000619', NULL, 'client.call_complete', 'ghl-webhook-receiver', 'call', 'inbound', 'ct40m2',
  '{"body":"Call. Provider status: ringing. Duration: 0 seconds","call_status":"ringing"}',
  '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-05 03:56Z', '2026-10-05 03:56Z', '2026-10-05 03:56Z', '2026-10-05 03:56Z', 'pending_luna', NULL,
  ARRAY['40000000-0000-4000-8000-000000000118', '40000000-0000-4000-8000-000000000119']::uuid[], NULL),
 ('40b00000-0000-4000-8000-000000000620', '40000000-0000-4000-8000-000000000119', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct40m2',
  '{"body":"We saw your call, ringing you back shortly"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
  '2026-10-05 04:30Z', '2026-10-05 04:30Z', '2026-10-05 04:30Z', '2026-10-05 04:30Z', 'direct', 1, NULL, NULL),
 -- Q3: the customer's email on their combined job, paying its deposit
 ('40b00000-0000-4000-8000-000000000622', '40000000-0000-4000-8000-000000000122', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', 'ct40q1',
  '{"body":"Deposit paid for the whole fence, thanks","from":"combined@example.test","subject":"Deposit"}',
  '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-06-30 02:00Z', '2026-06-30 02:00Z', '2026-06-30 02:00Z', '2026-06-30 02:00Z', 'direct', 1, NULL, NULL);

-- 3 (sixth review). A value set from the CRM (pricing_json.source ghl, or the import's $1,000.00
-- placeholder) that no quote backs is a check of the value (C2 kind 9); an invoice placed on no
-- job addressed to the job's own Xero contact (C2 kind 8, so a job with no number is read too),
-- or on the client's duplicate record (another job of the same kind at the same site address),
-- may bill the job. R8 then states no amount and is never our move; the money line and the first
-- line name what the job's own contact owes on the invoice placed on no job, never "owing $0.00"
-- over it, and the client story counts it in what the client owes.
DO $sixthmoney$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; s jsonb; got text; r record; l jsonb;
 e1 constant uuid := '40000000-0000-4000-8000-000000000101';
BEGIN
 SELECT string_agg((c->>'kind') || ':' || right(c->>'id', 3), ',' ORDER BY (c->>'kind')::int, c->>'id') INTO got
 FROM public.context_job_record_value(ARRAY[e1], asof) v, jsonb_array_elements(v.checks) c;
 IF got IS DISTINCT FROM '8:602,9:101' THEN
  RAISE EXCEPTION 'story safety contract: a CRM value with the rest billed to the job''s own contact on no job is checked both ways (kinds 8 and 9): %', got;
 END IF;
 SELECT string_agg(l.what, ' | ' ORDER BY l.source_id) INTO got
 FROM public.context_job_record_loops(ARRAY[e1], asof) l WHERE l.rule = 'C2_value_mismatch';
 IF got IS DISTINCT FROM 'The job value $1,000.00 (pricing_json.totalIncGST) was set from the CRM (pricing_json.source ghl) and no quote on the job backs it | '
                         || 'Invoice INV-6102 ($704.00, authorised, $704.00 owing) is addressed to this job''s Xero contact but is placed on no job; '
                         || 'this job''s own issued invoices total $704.00 against the job value $1,000.00 (pricing_json.totalIncGST)' THEN
  RAISE EXCEPTION 'story safety contract: C2 names the invoice on no job and the CRM value: %', got;
 END IF;
 s := public.context_job_story(e1, asof);
 SELECT x INTO l FROM jsonb_array_elements(s->'loops') x WHERE x->>'rule' = 'R8_not_yet_invoiced';
 IF l->>'status' IS DISTINCT FROM 'unconfirmed' OR s->'now'->>'whose_move' = 'us' OR s->'now'->>'line' LIKE '%we owe%'
    OR s->'now'->>'line' LIKE '%not yet invoiced%' OR s->'now'->>'line' LIKE '%296%'
    OR position('Owing on an invoice placed on no job (addressed to this job''s Xero contact): INV-6102 $704.00 overdue since Sat 14 Mar (207 days)' IN s->'now'->>'line') = 0
    OR position('owing $0.00; the job value is unconfirmed (check C2), so what is left to invoice is not known; owing on an invoice placed on no job '
                || '(addressed to this job''s Xero contact): INV-6102 $704.00 overdue since Sat 14 Mar (207 days).' IN s->'money'->>'line') = 0
    OR s->'money'->'placed_on_no_job'->0->>'number' IS DISTINCT FROM 'INV-6102' OR (s->'money'->'placed_on_no_job'->0->>'owing')::numeric IS DISTINCT FROM 704.00
    OR NOT coalesce((s->'money'->'not_yet_invoiced'->>'unconfirmed')::boolean, false) THEN
  RAISE EXCEPTION 'story safety contract: the false $296 is never our move and the $704 owing on no job is named: % / % / %', s->'now', s->'money', l;
 END IF;
 s := public.context_client_story(e1, asof);
 IF (s->'money'->>'owing')::numeric IS DISTINCT FROM 704.00 OR (s->'money'->>'overdue')::numeric IS DISTINCT FROM 704.00
    OR (s->'money'->>'not_yet_invoiced')::numeric IS DISTINCT FROM 0 OR s->'money'->'placed_on_no_job'->0->>'invoices' IS DISTINCT FROM 'INV-6102'
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'not_known') k
                   WHERE k->>'what' = 'Owing includes $704.00 on invoices addressed to this client''s Xero contact that are placed on no job (INV-6102).') THEN
  RAISE EXCEPTION 'story safety contract: the client owes what their own contact owes on an invoice placed on no job: % / %', s->'money', s->'not_known';
 END IF;
 -- E2, E2b: a CRM value and the $1,000.00 placeholder, nothing behind either: no amount stated
 SELECT string_agg(right(l.job_id::text, 3) || '=' || l.what, ' | ' ORDER BY l.job_id) INTO got
 FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000102', '40000000-0000-4000-8000-000000000103']::uuid[], asof) l
 WHERE l.rule = 'C2_value_mismatch';
 IF got IS DISTINCT FROM '102=The job value $1,000.00 (pricing_json.totalIncGST) was set from the CRM (pricing_json.source ghl) and no quote on the job backs it | '
                         || '103=The job value $1,000.00 (pricing_json.totalIncGST) is $1,000.00, the CRM import''s placeholder and no quote on the job backs it' THEN
  RAISE EXCEPTION 'story safety contract: a CRM value nothing backs is a check of the value: %', got;
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000102', asof);
 IF s->'money'->>'line' LIKE '%of the job value not yet invoiced%' OR s->'money'->'not_yet_invoiced'->>'amount' IS NOT NULL
    OR position('the job value is unconfirmed (check C2), so what is left to invoice is not known' IN s->'money'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: a CRM value''s gap is never stated as not yet invoiced: %', s->'money';
 END IF;
 -- E3: the rest billed to its own contact on an invoice placed on no job that names nothing
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000104'::uuid], asof) l WHERE l.rule = 'C2_value_mismatch';
 IF r.what IS DISTINCT FROM 'Invoice INV-6132 ($1,000.00, authorised, $1,000.00 owing) is addressed to this job''s Xero contact but is placed on no job; '
                            || 'this job''s own issued invoices total $1,000.00 against the job value $2,000.00 (pricing_json.totalIncGST)' THEN
  RAISE EXCEPTION 'story safety contract: an invoice to the job''s own contact on no job is a check of the value: %', row_to_json(r);
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000104', asof);
 IF s->'now'->>'whose_move' = 'us' OR s->'now'->>'line' LIKE '%we owe%' OR s->'now'->>'line' LIKE '%not yet invoiced%'
    OR position('INV-6132 $1,000.00 overdue since Wed 30 Sep (7 days)' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: billed to its own contact on no job, the rest is never our move to bill: %', s->'now';
 END IF;
 -- E4: the contact is billed on builder work: still a check of the value, but never this
 -- job's debt in the story nor the client's
 SELECT string_agg((c->>'kind') || ':' || right(c->>'id', 3), ',' ORDER BY (c->>'kind')::int, c->>'id') INTO got
 FROM public.context_job_record_value(ARRAY['40000000-0000-4000-8000-000000000105'::uuid], asof) v, jsonb_array_elements(v.checks) c;
 s := public.context_job_story('40000000-0000-4000-8000-000000000105', asof);
 IF got IS DISTINCT FROM '8:642' OR s->'now'->>'line' LIKE '%placed on no job (addressed%' OR jsonb_array_length(s->'money'->'placed_on_no_job') <> 0
    OR s->'now'->>'whose_move' = 'us' THEN
  RAISE EXCEPTION 'story safety contract: a builder-billed contact''s invoice on no job checks the value but is never named this job''s debt: % / %', got, s->'now';
 END IF;
 s := public.context_client_story('40000000-0000-4000-8000-000000000105', asof);
 IF (s->'money'->>'owing')::numeric <> 0 OR jsonb_array_length(s->'money'->'placed_on_no_job') <> 0 THEN
  RAISE EXCEPTION 'story safety contract: a builder''s invoice on no job is never the homeowner''s debt: %', s->'money';
 END IF;
 -- D1: its work billed and paid on its duplicate record D2 (same client, same kind, same site);
 -- D3, the client's job of another kind at the same site, never ties
 SELECT string_agg((c->>'kind') || ':' || right(c->>'id', 3), ',' ORDER BY (c->>'kind')::int, c->>'id') INTO got
 FROM public.context_job_record_value(ARRAY['40000000-0000-4000-8000-000000000124'::uuid], asof) v, jsonb_array_elements(v.checks) c;
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000124'::uuid], asof) l
 WHERE l.rule = 'C2_value_mismatch' AND l.source_id = '40c00000-0000-4000-8000-000000000651';
 IF got IS DISTINCT FROM '8:651,8:652'
    OR r.what IS DISTINCT FROM 'Invoice INV-6151 ($7,032.22, paid) is on job SWP-94125, this client''s other job of this kind at the same site address; '
                               || 'this job''s own issued invoices total $0.00 against the job value $12,735.02 (pricing_json.totalIncGST)' THEN
  RAISE EXCEPTION 'story safety contract: a duplicate record''s invoices check the value: % / %', got, row_to_json(r);
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000124', asof);
 IF s->'now'->>'whose_move' = 'us' OR s->'now'->>'line' LIKE '%we owe%' OR s->'now'->>'line' LIKE '%not yet invoiced%'
    OR s->'money'->>'line' LIKE '%of the job value not yet invoiced%' THEN
  RAISE EXCEPTION 'story safety contract: billed and paid on its duplicate record, the job is never billed again: % / %', s->'now', s->'money';
 END IF;
END $sixthmoney$;

-- 3 (sixth review). R8 is not due while the job is in rectification (SWP-26354 class: a
-- completion pack, invoiced, then back in rectification), nor while work recorded finished was
-- opened again by a rectification and nothing records it finished since (rework scheduled), and
-- it never makes the move ours then; finished again since (invoiced), it is due.
DO $sixthrect$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; s jsonb; l jsonb;
BEGIN
 s := public.context_job_story('40000000-0000-4000-8000-000000000127', asof);
 SELECT x INTO l FROM jsonb_array_elements(s->'loops') x WHERE x->>'rule' = 'R8_not_yet_invoiced';
 IF l->>'status' IS DISTINCT FROM 'not_due' OR s->'now'->>'whose_move' = 'us' OR s->'now'->>'line' LIKE '%we owe%'
    OR s->'now'->>'line' LIKE '%not yet invoiced%' OR s->'now'->>'line' NOT LIKE 'In rectification since Wed 19 Aug%'
    OR l->>'why' NOT LIKE '%the job is in rectification, so the final invoice is not the next move until the work is finished again%' THEN
  RAISE EXCEPTION 'story safety contract: in rectification the final invoice is not due and never our move: % / %', s->'now', l;
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000128', asof);
 SELECT x INTO l FROM jsonb_array_elements(s->'loops') x WHERE x->>'rule' = 'R8_not_yet_invoiced';
 IF l->>'status' IS DISTINCT FROM 'not_due' OR s->'now'->>'whose_move' = 'us' OR s->'now'->>'line' LIKE '%we owe%'
    OR l->>'why' NOT LIKE '%the work was opened again after it was recorded finished (status set to rectification Wed 19 Aug) and nothing records it finished since%' THEN
  RAISE EXCEPTION 'story safety contract: reopened by a rectification and not finished since, the final invoice is not due: % / %', s->'now', l;
 END IF;
 -- (promise kept) invoiced again after the rectification: due, our move
 s := public.context_job_story('40000000-0000-4000-8000-000000000129', asof);
 SELECT x INTO l FROM jsonb_array_elements(s->'loops') x WHERE x->>'rule' = 'R8_not_yet_invoiced';
 IF l->>'status' IS DISTINCT FROM 'open' OR s->'now'->>'whose_move' IS DISTINCT FROM 'us' THEN
  RAISE EXCEPTION 'story safety contract: finished again since the rectification, the final invoice is due: % / %', s->'now', l;
 END IF;
END $sixthrect$;

-- 4 (sixth review). A backfilled text keeps the CRM's time once a sync has written its cache row
-- over (T1: the time was kept when the cache held it); one whose CRM time was never kept (T2) is
-- time unknown, never its load time: never the customer's side or words, never the reader's
-- evidence, never citable, named in not_known.
DO $sixthtime$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; s jsonb; r record; chk jsonb; got text;
 t1 constant uuid := '40000000-0000-4000-8000-000000000113'; t2 constant uuid := '40000000-0000-4000-8000-000000000114';
BEGIN
 SELECT m.at, m.placement, m.customer_side INTO r FROM public.context_job_record_messages(ARRAY[t1], asof) m
 WHERE m.source_id = '40b00000-0000-4000-8000-000000000601';
 IF r.at IS DISTINCT FROM '2026-06-15 02:00Z'::timestamptz OR r.placement IS DISTINCT FROM 'on_job' OR NOT coalesce(r.customer_side, false)
    OR public.context_job_record_crm_time('ghl_sms_cache_backfill', 'ct40t1', 'm40-t1', t1) IS DISTINCT FROM '2026-06-15 02:00Z'::timestamptz THEN
  RAISE EXCEPTION 'story safety contract: a text keeps the CRM''s time after its cache row is written over: %', row_to_json(r);
 END IF;
 SELECT m.at, m.placement, m.customer_side INTO r FROM public.context_job_record_messages(ARRAY[t2], asof) m
 WHERE m.source_id = '40b00000-0000-4000-8000-000000000602';
 IF r.placement IS DISTINCT FROM 'time_unknown' OR coalesce(r.customer_side, true) THEN
  RAISE EXCEPTION 'story safety contract: a text whose CRM time is no longer kept is never the customer''s side: %', row_to_json(r);
 END IF;
 s := public.context_job_story(t2, asof);
 IF s->'last_exchange'->'customer_said' <> 'null'::jsonb OR s->'now'->>'line' LIKE '%wrote last%'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(s->'checks') k WHERE k->>'rule' = 'R5_customer_wrote_last')
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'not_known') k
                   WHERE k->>'what' = '1 text on this job was loaded from the CRM''s cache and the CRM''s own time for it is no longer kept; it is not read as this customer''s words.')
    OR (s->'meta'->'sources'->>'texts')::timestamptz IS DISTINCT FROM '2026-09-09 01:00Z'::timestamptz THEN
  RAISE EXCEPTION 'story safety contract: a text of unknown time is never the customer''s last word, said so: % / % / %', s->'last_exchange', s->'now'->>'line', s->'not_known';
 END IF;
 SELECT string_agg(e.src_id::text, ',' ORDER BY e.src_id) INTO got FROM public.context_ledger_evidence_rows(ARRAY[t2], asof) e;
 chk := public.context_ledger_cite(t2, '{"table":"business_events","id":"40b00000-0000-4000-8000-000000000602","excerpt":"Words of an unknown day"}');
 IF got IS DISTINCT FROM '40b00000-0000-4000-8000-000000000603' OR coalesce((chk->>'ok')::boolean, true) OR chk->>'code' IS DISTINCT FROM 'citation_not_admissible' THEN
  RAISE EXCEPTION 'story safety contract: a text of unknown time is never the reader''s evidence nor citable: % / %', got, chk;
 END IF;
END $sixthtime$;

-- 1 (sixth review). The customer's newest message off the job is no all-clear for a reading that
-- read every row on it (fixture P, a shadow asked for by id: the customer's 5 Oct request text is
-- placed on no job). R7 is a check once the job is past quoted, and the customer's contact since
-- the quote counts their rows placed on no job whatever their attribution status (N1: their
-- answered call, attribution status null) and their rows on their other jobs (Q1: their email on
-- the combined job Q3), and a quote their later accepted job of the same kind at the same site
-- address may replace is a check. Their missed call placed on no job with nothing from us since
-- is our move on each job it may be about (M1, M2); never once we wrote to them after it on any
-- job (M3, M4). A full deposit draft whose stage the issued split invoices already reach is a
-- check naming them, never our move (S1).
DO $sixthwords$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; s jsonb; r record; gs uuid; x uuid;
BEGIN
 UPDATE public.business_events SET context_captured_at = recorded_at
 WHERE id IN ('40b00000-0000-4000-8000-000000000175', '40b00000-0000-4000-8000-000000000176');
 INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, evidence_until, created_at, finished_at, updated_at, checks)
 VALUES ('40000000-0000-4000-8000-000000000073', 'backfill', 'shadow', 'luna-ledger:v1', '2026-07-03 00:00Z', '2026-07-03 00:00Z',
         '2026-07-03 00:10Z', '2026-07-03 00:10Z', '{"passed": true, "store": {"pass": true}}')
 RETURNING id INTO gs;
 s := public.context_job_story('40000000-0000-4000-8000-000000000073', asof, gs);
 IF (s->'meta'->'ledger'->>'unread_rows')::int IS DISTINCT FROM 0 OR s->'now'->>'whose_move' IS DISTINCT FROM 'unknown' OR s->'now'->>'line' LIKE '%Nothing open%'
    OR position('the customer''s newest message, Mon 5 Oct (not placed on any job), is off the job and not yet checked by the reader' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: a shadow that read every row on the job is no all-clear over the customer''s newer message off it: % / %',
   s->'now', s->'meta'->'ledger';
 END IF;
 -- N1
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000115'::uuid], asof) l WHERE l.rule = 'R7_quote_waiting';
 IF r.shown_as IS DISTINCT FROM 'check'
    OR r.what IS DISTINCT FROM 'Quote Q-6115 v1 sent Wed 5 Aug 2026 (63 days), not viewed; no answer recorded, but the customer was in touch since: '
                               || 'an answered call Wed 5 Aug 2026 (not placed on any job)' THEN
  RAISE EXCEPTION 'story safety contract: past quoted, a quote waiting is a check naming the customer''s call since: %', row_to_json(r);
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000115', asof);
 IF s->'now'->>'whose_move' = 'customer' OR s->'now'->>'line' LIKE '%waiting on the customer%'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(s->'loops') l WHERE l->>'rule' = 'R7_quote_waiting')
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'checks') k WHERE k->>'rule' = 'R7_quote_waiting') THEN
  RAISE EXCEPTION 'story safety contract: an invoiced job never waits on the customer for its quote: %', s->'now';
 END IF;
 s := public.context_job_story_meta('40000000-0000-4000-8000-000000000115', asof);
 IF (s->'unplaced'->>'newest_customer_at')::timestamptz IS DISTINCT FROM '2026-08-05 05:00Z'::timestamptz THEN
  RAISE EXCEPTION 'story safety contract: the customer''s answered call placed on no job with no attribution status is their newest message: %', s->'unplaced';
 END IF;
 -- Q1
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000120'::uuid], asof) l WHERE l.rule = 'R7_quote_waiting';
 IF r.shown_as IS DISTINCT FROM 'check'
    OR r.what IS DISTINCT FROM 'Quote Q-6120 v1 sent Wed 3 Jun 2026 (125 days), viewed; no answer recorded, but the customer was in touch since: '
                               || 'an email Tue 30 Jun 2026 (on job SWF-94122); job SWF-94122 for this customer at the same site address was accepted '
                               || 'Tue 30 Jun 2026 and may replace this quote'
                               -- (lead cutoff, 20261007010000: no progress on this lead itself, and 4 weeks after the
                               -- customer's newest message, their email on SWF-94122 on 30 Jun, it is no longer
                               -- followed up, said last)
                               || '. Lead not followed up since Tue 28 Jul 2026: 4 weeks after the last quote or message with no progress' THEN
  RAISE EXCEPTION 'story safety contract: a quote the customer''s later accepted job at the address may replace is a check: %', row_to_json(r);
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000120', asof);
 IF s->'now'->>'whose_move' = 'customer' OR s->'now'->>'line' LIKE '%waiting on the customer%' THEN
  RAISE EXCEPTION 'story safety contract: a duplicate quote answered by a combined job never waits on the customer: %', s->'now';
 END IF;
 -- M1, M2
 FOREACH x IN ARRAY ARRAY['40000000-0000-4000-8000-000000000116', '40000000-0000-4000-8000-000000000117']::uuid[] LOOP
  s := public.context_job_story(x, asof);
  SELECT l.placement INTO r FROM public.context_job_record_loops(ARRAY[x], asof) l WHERE l.rule = 'R4_missed_call';
  IF s->'now'->>'whose_move' IS DISTINCT FROM 'us' OR r.placement IS DISTINCT FROM 'not_placed'
     OR position('Our move, we owe: Missed call from the customer Mon 5 Oct 11:56 (not placed on any job); no call, text or email to the customer since'
                 IN s->'now'->>'line') = 0 THEN
   RAISE EXCEPTION 'story safety contract: the customer''s missed call placed on no job is our move: % / %', s->'now', row_to_json(r);
  END IF;
 END LOOP;
 -- (promise kept) M3, M4: we wrote to them after it, on M4
 FOREACH x IN ARRAY ARRAY['40000000-0000-4000-8000-000000000118', '40000000-0000-4000-8000-000000000119']::uuid[] LOOP
  IF EXISTS (SELECT 1 FROM public.context_job_record_loops(ARRAY[x], asof) l WHERE l.rule = 'R4_missed_call') THEN
   RAISE EXCEPTION 'story safety contract: a missed call we answered by text on any job is no move: %', x;
  END IF;
 END LOOP;
 -- S1
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000123'::uuid], asof) l WHERE l.rule = 'R3_draft';
 IF r.shown_as IS DISTINCT FROM 'check'
    OR r.what IS DISTINCT FROM 'Draft invoice INV-6125 $2,381.50 to Split Deposit Client not issued since Thu 1 Oct 2026; it may duplicate the issued deposit '
                               || 'invoices INV-6123, INV-6124 on the same job reference ($2,381.50), which together bill the whole deposit' THEN
  RAISE EXCEPTION 'story safety contract: a draft whose stage the split invoices already reach is a check naming them: %', row_to_json(r);
 END IF;
 s := public.context_job_story('40000000-0000-4000-8000-000000000123', asof);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'customer' OR s->'now'->>'line' LIKE '%we owe%'
    OR position('The customer''s move, the customer owes: INV-6123' IN s->'now'->>'line') = 0
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(s->'now'->'blockers') b WHERE b->>'what' LIKE 'Draft invoice INV-6125%')
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'checks') k WHERE k->>'rule' = 'R3_draft' AND k->>'what' LIKE '%it may duplicate the issued deposit invoices%') THEN
  RAISE EXCEPTION 'story safety contract: the split deposit leads, never the duplicate draft, which blocks nothing: % / %', s->'now', s->'checks';
 END IF;
END $sixthwords$;

-- Seventh review fixtures (each fails on the 88cf7b15 bodies unless said to be a promise kept).
-- Money (R3): H1 (SWF-26380 class): the neighbour's REAR-B-DEP50 paid and the customer's DEP50 a
-- draft; H2: the customer's A-DEP50 issued and the neighbour's B-DEP50 a draft; H3: work done, the
-- neighbour's B-FINBAL50 issued and the customer's FINBAL50 a draft; H4 (SWP-26354 class): a patio
-- DEP50 paid, then a DEP25 progress draft; H5 (SWF-26545 class): the full DEP50 draft beside two
-- DEP50 halves, one the customer's; H6: a draft of the customer's A-DEP50 already issued to them
-- (H5 and H6 were checks before too: their words now say which share the issued invoices bill). Words: K1 (SWF-261525 class), the customer's missed
-- call on the job and our text 4 minutes later placed on their other job K2; K3 (SWMS-261051
-- class), their answered call 14 minutes after it placed on no job; K4 (SWP-26257 class), their
-- answered call on the job the next day; K5 (a promise kept), nothing since. V1 (SWF-261457
-- class): the customer's text on the job answered a minute later in a text placed on no job; V2:
-- their old-inbox mail answered by a text placed on no job. O1 (SWF-26004 class): an overdue
-- invoice and the customer's newer text in the admin bucket; O2 (a promise kept): their text
-- there from before the invoice was due. A1 (SWF-261372 class): processing, accepted by its paid
-- deposit. Mail: G1, its mails' saved copies on another live job G2 (moved after a reading), on
-- the archived bucket and on a holding job G3. Who: I1 (SWMS-26845 class): builder work, the
-- builder's invoice overdue, and inbound mail on it labelled the customer's from an address that
-- is a client of another job, from our own domain and from a crew member; I2 (a promise kept):
-- this job's own contact's text carrying a stale other-job label.
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, client_email, ghl_contact_id, xero_contact_id, pricing_json,
  accepted_at, completed_at, created_at, site_address)
VALUES
 ('40000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-0000000000aa', 'SWF-94201', 'scheduled', 'fencing', 'Half Client',
  NULL, 'ct40h1', 'x40-h1c', '{}', NULL, NULL, '2026-09-10 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-0000000000aa', 'SWF-94202', 'scheduled', 'fencing', 'Pending Half Client',
  NULL, 'ct40h2', 'x40-h2a', '{}', NULL, NULL, '2026-09-10 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-0000000000aa', 'SWF-94203', 'invoiced', 'fencing', 'Final Half Client',
  NULL, 'ct40h3', 'x40-h3c', '{}', NULL, NULL, '2026-08-01 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-0000000000aa', 'SWP-94204', 'in_progress', 'patio', 'Progress Client',
  NULL, 'ct40h4', 'x40-h4c', '{}', NULL, NULL, '2026-08-01 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000205', '00000000-0000-4000-8000-0000000000aa', 'SWF-94205', 'scheduled', 'fencing', 'Two Halves Client',
  NULL, 'ct40h5', 'x40-h5c', '{}', NULL, NULL, '2026-09-01 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000206', '00000000-0000-4000-8000-0000000000aa', 'SWF-94206', 'scheduled', 'fencing', 'Again Client',
  NULL, 'ct40h6', 'x40-h6c', '{}', NULL, NULL, '2026-09-01 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000211', '00000000-0000-4000-8000-0000000000aa', 'SWF-94211', 'quoted', 'fencing', 'Rang Client',
  NULL, 'ct40k1', NULL, '{}', NULL, NULL, '2026-09-20 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000212', '00000000-0000-4000-8000-0000000000aa', 'SWF-94212', 'quoted', 'fencing', 'Rang Client',
  NULL, 'ct40k1', NULL, '{}', NULL, NULL, '2026-09-25 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000213', '00000000-0000-4000-8000-0000000000aa', 'SWF-94213', 'quoted', 'fencing', 'Got Through Client',
  NULL, 'ct40k3', NULL, '{}', NULL, NULL, '2026-08-20 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000214', '00000000-0000-4000-8000-0000000000aa', 'SWF-94214', 'quoted', 'fencing', 'Called In Client',
  NULL, 'ct40k4', NULL, '{}', NULL, NULL, '2026-08-20 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000215', '00000000-0000-4000-8000-0000000000aa', 'SWF-94215', 'quoted', 'fencing', 'Unreturned Client',
  NULL, 'ct40k5', NULL, '{}', NULL, NULL, '2026-09-20 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000221', '00000000-0000-4000-8000-0000000000aa', 'SWF-94221', 'quoted', 'fencing', 'Answered Client',
  NULL, 'ct40v1', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000222', '00000000-0000-4000-8000-0000000000aa', 'SWF-94222', 'quoted', 'fencing', 'Mail Answered Client',
  'mailanswered@example.test', 'ct40v2', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000231', '00000000-0000-4000-8000-0000000000aa', 'SWF-94231', 'invoiced', 'fencing', 'Off Job Client',
  NULL, 'ct40o1', 'x40-o1', '{}', NULL, NULL, '2026-07-01 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000232', '00000000-0000-4000-8000-0000000000aa', 'SWF-94232', 'invoiced', 'fencing', 'Earlier Word Client',
  NULL, 'ct40o2', 'x40-o2', '{}', NULL, NULL, '2026-07-01 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000241', '00000000-0000-4000-8000-0000000000aa', 'SWF-94241', 'processing', 'fencing', 'Deposit Paid Client',
  NULL, 'ct40a1', 'x40-a1', '{}', NULL, NULL, '2026-09-01 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000251', '00000000-0000-4000-8000-0000000000aa', 'SWF-94251', 'quoted', 'fencing', 'Moved Mail Client',
  'moved.m@example.test', 'ct40g1', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000252', '00000000-0000-4000-8000-0000000000aa', 'SWF-94252', 'quoted', 'fencing', 'Live Other Client',
  NULL, 'ct40g2', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000261', '00000000-0000-4000-8000-0000000000aa', 'SWMS-94261', 'invoiced', 'makesafe', 'Insured Owner Two',
  NULL, NULL, 'x40-b261', '{}', NULL, NULL, '2026-06-20 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000262', '00000000-0000-4000-8000-0000000000aa', 'SWF-94262', 'accepted', 'fencing', 'Owner Own Job',
  'owner.personal@example.test', NULL, NULL, '{}', NULL, NULL, '2026-06-01 01:00Z', NULL),
 ('40000000-0000-4000-8000-000000000264', '00000000-0000-4000-8000-0000000000aa', 'SWF-94264', 'quoted', 'fencing', 'Stale Label Client',
  NULL, 'ct40i2', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z', NULL);
-- G3: a holding job (do not schedule), not archived, last changed when it was made one
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, pricing_json, created_at, metadata, updated_at)
VALUES ('40000000-0000-4000-8000-000000000253', '00000000-0000-4000-8000-0000000000aa', 'SWF-94253', 'quoted', 'fencing', 'Holding Job', '{}',
        '2026-08-01 01:00Z', '{"do_not_schedule": true}', '2026-08-01 01:00Z');
INSERT INTO public.job_contacts (id, job_id, contact_type, client_name, xero_contact_id, is_primary, created_at)
VALUES ('40d00000-0000-4000-8000-000000000701', '40000000-0000-4000-8000-000000000201', 'primary', 'Half Client', 'x40-h1c', true, '2026-09-10 01:00Z'),
       ('40d00000-0000-4000-8000-000000000702', '40000000-0000-4000-8000-000000000201', 'neighbour_b', 'Rear Neighbour', 'x40-h1n', false, '2026-09-10 01:00Z'),
       ('40d00000-0000-4000-8000-000000000703', '40000000-0000-4000-8000-000000000202', 'primary', 'Pending Half Client', 'x40-h2a', true, '2026-09-10 01:00Z'),
       ('40d00000-0000-4000-8000-000000000704', '40000000-0000-4000-8000-000000000202', 'neighbour_b', 'Neighbour B Two', 'x40-h2b', false, '2026-09-10 01:00Z'),
       ('40d00000-0000-4000-8000-000000000705', '40000000-0000-4000-8000-000000000203', 'primary', 'Final Half Client', 'x40-h3c', true, '2026-08-01 01:00Z'),
       ('40d00000-0000-4000-8000-000000000706', '40000000-0000-4000-8000-000000000203', 'neighbour_b', 'Neighbour B Three', 'x40-h3n', false, '2026-08-01 01:00Z'),
       ('40d00000-0000-4000-8000-000000000707', '40000000-0000-4000-8000-000000000206', 'primary', 'Again Client', 'x40-h6c', true, '2026-09-01 01:00Z');
INSERT INTO public.xero_invoices (org_id, id, job_id, xero_invoice_id, xero_contact_id, contact_name, invoice_number, invoice_type, status, reference,
  total, amount_due, amount_paid, invoice_date, due_date, fully_paid_on, line_items, raw_json, job_contact_id, created_at)
VALUES
 -- H1: the neighbour's rear half paid; the customer's half a draft (never a duplicate of the neighbour's)
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000711', '40000000-0000-4000-8000-000000000201', 'x7011', 'x40-h1n', 'Rear Neighbour',
  'INV-7011', 'ACCREC', 'PAID', 'SWF-94201-REAR-B-DEP50', 974.84, 0, 974.84, '2026-09-20', '2026-09-27', '2026-09-22', NULL, '{"Status":"PAID","Payments":[]}',
  '40d00000-0000-4000-8000-000000000702', '2026-09-20 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000712', '40000000-0000-4000-8000-000000000201', 'x7012', 'x40-h1c', 'Half Client',
  'INV-7012', 'ACCREC', 'DRAFT', 'SWF-94201-DEP50', 974.84, 974.84, 0, '2026-09-25', '2026-10-02', NULL, NULL, '{"Status":"DRAFT","Payments":[]}',
  '40d00000-0000-4000-8000-000000000701', '2026-09-25 01:00Z'),
 -- H2: the customer's A half issued; the neighbour's B half a draft
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000721', '40000000-0000-4000-8000-000000000202', 'x7021', 'x40-h2a', 'Pending Half Client',
  'INV-7021', 'ACCREC', 'AUTHORISED', 'SWF-94202-A-DEP50', 1351.63, 1351.63, 0, '2026-09-20', '2026-10-20', NULL, NULL, '{"Status":"AUTHORISED","Payments":[]}',
  '40d00000-0000-4000-8000-000000000703', '2026-09-20 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000722', '40000000-0000-4000-8000-000000000202', 'x7022', 'x40-h2b', 'Neighbour B Two',
  'INV-7022', 'ACCREC', 'DRAFT', 'SWF-94202-B-DEP50', 1351.63, 1351.63, 0, '2026-09-25', '2026-10-02', NULL, NULL, '{"Status":"DRAFT","Payments":[]}',
  '40d00000-0000-4000-8000-000000000704', '2026-09-25 01:00Z'),
 -- H3: the neighbour's final half issued (due ahead); the customer's final half a draft
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000731', '40000000-0000-4000-8000-000000000203', 'x7031', 'x40-h3n', 'Neighbour B Three',
  'INV-7031', 'ACCREC', 'AUTHORISED', 'SWF-94203-B-FINBAL50', 1351.63, 1351.63, 0, '2026-10-02', '2026-10-16', NULL, NULL, '{"Status":"AUTHORISED","Payments":[]}',
  '40d00000-0000-4000-8000-000000000706', '2026-10-02 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000732', '40000000-0000-4000-8000-000000000203', 'x7032', 'x40-h3c', 'Final Half Client',
  'INV-7032', 'ACCREC', 'DRAFT', 'SWF-94203-FINBAL50', 1351.63, 1351.63, 0, '2026-10-02', '2026-10-16', NULL, NULL, '{"Status":"DRAFT","Payments":[]}',
  '40d00000-0000-4000-8000-000000000705', '2026-10-02 01:00Z'),
 -- H4: the 50% deposit paid, then a 25% progress claim drafted
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000741', '40000000-0000-4000-8000-000000000204', 'x7041', 'x40-h4c', 'Progress Client',
  'INV-7041', 'ACCREC', 'PAID', 'SWP-94204-DEP50', 3960.00, 0, 3960.00, '2026-08-05', '2026-08-12', '2026-08-06', NULL, '{"Status":"PAID","Payments":[]}',
  NULL, '2026-08-05 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000742', '40000000-0000-4000-8000-000000000204', 'x7042', 'x40-h4c', 'Progress Client',
  'INV-7042', 'ACCREC', 'DRAFT', 'SWP-94204-DEP25', 1980.00, 1980.00, 0, '2026-10-01', '2026-10-08', NULL, NULL, '{"Status":"DRAFT","Payments":[]}',
  NULL, '2026-10-01 01:00Z'),
 -- H5: the full deposit drafted to the customer; issued as two halves, one theirs
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000751', '40000000-0000-4000-8000-000000000205', 'x7051', 'x40-h5c', 'Two Halves Client',
  'INV-7051', 'ACCREC', 'DRAFT', 'SWF-94205-DEP50', 5203.00, 5203.00, 0, '2026-09-18', '2026-09-25', NULL, NULL, '{"Status":"DRAFT","Payments":[]}',
  NULL, '2026-09-18 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000752', '40000000-0000-4000-8000-000000000205', 'x7052', 'x40-h5o', 'Other Payer Five',
  'INV-7052', 'ACCREC', 'PAID', 'SWF-94205-DEP50', 2601.50, 0, 2601.50, '2026-09-18', '2026-09-25', '2026-09-20', NULL, '{"Status":"PAID","Payments":[]}',
  NULL, '2026-09-18 01:05Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000753', '40000000-0000-4000-8000-000000000205', 'x7053', 'x40-h5c', 'Two Halves Client',
  'INV-7053', 'ACCREC', 'PAID', 'SWF-94205-DEP50', 2601.50, 0, 2601.50, '2026-09-18', '2026-09-25', '2026-09-20', NULL, '{"Status":"PAID","Payments":[]}',
  NULL, '2026-09-18 01:10Z'),
 -- H6: the customer's A half issued, and drafted to them again
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000761', '40000000-0000-4000-8000-000000000206', 'x7061', 'x40-h6c', 'Again Client',
  'INV-7061', 'ACCREC', 'PAID', 'SWF-94206-A-DEP50', 1000.00, 0, 1000.00, '2026-09-10', '2026-09-17', '2026-09-12', NULL, '{"Status":"PAID","Payments":[]}',
  '40d00000-0000-4000-8000-000000000707', '2026-09-10 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000762', '40000000-0000-4000-8000-000000000206', 'x7062', 'x40-h6c', 'Again Client',
  'INV-7062', 'ACCREC', 'DRAFT', 'SWF-94206-A-DEP50', 1000.00, 1000.00, 0, '2026-09-30', '2026-10-07', NULL, NULL, '{"Status":"DRAFT","Payments":[]}',
  '40d00000-0000-4000-8000-000000000707', '2026-09-30 01:00Z'),
 -- O1, O2: the customer's invoice, overdue since Tue 1 Sep
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000771', '40000000-0000-4000-8000-000000000231', 'x7071', 'x40-o1', 'Off Job Client',
  'INV-7071', 'ACCREC', 'AUTHORISED', 'SWF-94231', 894.00, 894.00, 0, '2026-08-25', '2026-09-01', NULL, NULL, '{"Status":"AUTHORISED","Payments":[]}',
  NULL, '2026-08-25 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000772', '40000000-0000-4000-8000-000000000232', 'x7072', 'x40-o2', 'Earlier Word Client',
  'INV-7072', 'ACCREC', 'AUTHORISED', 'SWF-94232', 894.00, 894.00, 0, '2026-08-25', '2026-09-01', NULL, NULL, '{"Status":"AUTHORISED","Payments":[]}',
  NULL, '2026-08-25 01:00Z'),
 -- A1: its deposit paid on Thu 10 Sep (no quote accepted, no acceptance on the job row)
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000781', '40000000-0000-4000-8000-000000000241', 'x7081', 'x40-a1', 'Deposit Paid Client',
  'INV-7081', 'ACCREC', 'PAID', 'SWF-94241-DEP', 1500.00, 0, 1500.00, '2026-09-08', '2026-09-15', '2026-09-10', NULL, '{"Status":"PAID","Payments":[]}',
  NULL, '2026-09-08 01:00Z'),
 -- I1: the builder's invoice, 83 days overdue
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000791', '40000000-0000-4000-8000-000000000261', 'x7091', 'x40-b261', 'Builder Two Six One',
  'INV-7091', 'ACCREC', 'AUTHORISED', 'SWMS-94261', 500.50, 500.50, 0, '2026-07-02', '2026-07-16', NULL, NULL, '{"Status":"AUTHORISED","Payments":[]}',
  NULL, '2026-07-02 01:00Z');
INSERT INTO public.makesafe_job_details (job_id, requesting_company_name, created_at)
VALUES ('40000000-0000-4000-8000-000000000261', 'Builder Two Six One', '2026-06-20 01:00Z');
-- H3: the completion record (work done Mon 28 Sep)
INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at)
VALUES ('40200000-0000-4000-8000-000000000703', '40000000-0000-4000-8000-000000000203', 'completion_pack_generated', '{}', '2026-09-28 03:00Z');
-- I1: a crew member's own address (a person in public.users)
INSERT INTO public.users (id, org_id, name, role, email)
VALUES ('40f10000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'Crew Member Seven', 'installer', 'crew.seven@example.test');
-- G1's old-inbox mail: g21's saved copy is on the live job G2, g22's on the archived bucket,
-- g23's on the holding job G3; V2's mail from its client
INSERT INTO public.inbox_events (id, job_id, from_email, subject, body_preview, received_at, processed_at, graph_message_id, mailbox, classification)
VALUES ('40a00000-0000-4000-8000-000000000021', '40000000-0000-4000-8000-000000000251', 'moved.m@example.test', 'Slats', 'Which slats did we pick?',
        '2026-10-01 01:00Z', '2026-10-01 01:00Z', 'g40-21', 'office@example.test', 'client_reply'),
       ('40a00000-0000-4000-8000-000000000022', '40000000-0000-4000-8000-000000000251', 'moved.m@example.test', 'Posts', 'Are the posts concreted?',
        '2026-09-30 01:00Z', '2026-09-30 01:00Z', 'g40-22', 'office@example.test', 'client_reply'),
       ('40a00000-0000-4000-8000-000000000023', '40000000-0000-4000-8000-000000000251', 'moved.m@example.test', 'Gate latch', 'Can the latch be higher?',
        '2026-10-02 01:00Z', '2026-10-02 01:00Z', 'g40-23', 'office@example.test', 'client_reply'),
       ('40a00000-0000-4000-8000-000000000024', '40000000-0000-4000-8000-000000000222', 'mailanswered@example.test', 'Colour', 'Is the colour Monument?',
        '2026-10-03 01:00Z', '2026-10-03 01:00Z', 'g40-24', 'office@example.test', 'client_reply');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence, candidate_job_ids, provider_message_id, source_table, source_id)
VALUES
 -- G1's copies: g21 on the live job G2 (by its source pointer), g22 on the archived bucket (by its
 -- source pointer), g23 on the holding job G3 (by its graph key)
 ('40b00000-0000-4000-8000-000000000721', '40000000-0000-4000-8000-000000000252', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"Which slats did we pick?","from":"moved.m@example.test","subject":"Slats"}', '{"written_as":"service_role"}',
  '2026-10-01 01:00Z', '2026-10-01 01:05Z', '2026-10-01 01:00Z', '2026-10-01 01:05Z', 'direct', 1, NULL, NULL, 'inbox_events', '40a00000-0000-4000-8000-000000000021'),
 ('40b00000-0000-4000-8000-000000000722', '40000000-0000-4000-8000-000000000002', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"Are the posts concreted?","from":"moved.m@example.test","subject":"Posts"}', '{"written_as":"service_role"}',
  '2026-09-30 01:00Z', '2026-09-30 01:05Z', '2026-09-30 01:00Z', '2026-09-30 01:05Z', 'direct', 1, NULL, NULL, 'inbox_events', '40a00000-0000-4000-8000-000000000022'),
 ('40b00000-0000-4000-8000-000000000723', '40000000-0000-4000-8000-000000000253', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"Can the latch be higher?","from":"moved.m@example.test","subject":"Gate latch"}', '{"written_as":"service_role"}',
  '2026-10-02 01:00Z', '2026-10-02 01:05Z', '2026-10-02 01:00Z', '2026-10-02 01:05Z', 'direct', 1, NULL, 'graph:g40-23', NULL, NULL),
 -- K1, K2: their call on K1 rang out at 08:45; our text to them 4 minutes later, placed on K2
 ('40b00000-0000-4000-8000-000000000731', '40000000-0000-4000-8000-000000000211', 'client.call_logged', 'ghl', 'call', 'inbound', 'ct40k1',
  '{"body":"Call. Provider status: ringing. Duration: 0 seconds","call_status":"ringing"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","basis":"job_customer"}}',
  '2026-10-06 00:45Z', '2026-10-06 00:45Z', '2026-10-06 00:45Z', '2026-10-06 00:45Z', 'direct', 1, NULL, NULL, NULL, NULL),
 ('40b00000-0000-4000-8000-000000000732', '40000000-0000-4000-8000-000000000212', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct40k1',
  '{"body":"Sorry we missed you, what can we help with?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff","basis":"job_customer"}}',
  '2026-10-06 00:49Z', '2026-10-06 00:49Z', '2026-10-06 00:49Z', '2026-10-06 00:49Z', 'direct', 1, NULL, NULL, NULL, NULL),
 -- K3: their call on the job rang out; 14 minutes later they got through (answered, placed on no job)
 ('40b00000-0000-4000-8000-000000000733', '40000000-0000-4000-8000-000000000213', 'client.call_logged', 'ghl', 'call', 'inbound', 'ct40k3',
  '{"body":"Call. Provider status: no-answer. Duration: 0 seconds","call_status":"no-answer"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","basis":"job_customer"}}',
  '2026-09-02 00:47Z', '2026-09-02 00:47Z', '2026-09-02 00:47Z', '2026-09-02 00:47Z', 'direct', 1, NULL, NULL, NULL, NULL),
 ('40b00000-0000-4000-8000-000000000734', NULL, 'client.call_complete', 'ghl-webhook-receiver', 'call', 'inbound', 'ct40k3',
  '{"body":"Call. Provider status: completed. Duration: 178 seconds","call_status":"completed"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-09-02 01:01Z', '2026-09-02 01:01Z', '2026-09-02 01:01Z', '2026-09-02 01:01Z', 'unplaced', NULL,
  ARRAY['40000000-0000-4000-8000-000000000213'::uuid], NULL, NULL, NULL),
 -- K4: their call on the job rang out; the next day their answered call on the job
 ('40b00000-0000-4000-8000-000000000735', '40000000-0000-4000-8000-000000000214', 'client.call_logged', 'ghl', 'call', 'inbound', 'ct40k4',
  '{"body":"Call. Provider status: busy. Duration: 0 seconds","call_status":"busy"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","basis":"job_customer"}}',
  '2026-09-02 00:47Z', '2026-09-02 00:47Z', '2026-09-02 00:47Z', '2026-09-02 00:47Z', 'direct', 1, NULL, NULL, NULL, NULL),
 ('40b00000-0000-4000-8000-000000000736', '40000000-0000-4000-8000-000000000214', 'client.call_complete', 'ghl-webhook-receiver', 'call', 'inbound', 'ct40k4',
  '{"body":"Call. Provider status: completed. Duration: 242 seconds","call_status":"completed"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","basis":"job_customer"}}',
  '2026-09-03 01:00Z', '2026-09-03 01:00Z', '2026-09-03 01:00Z', '2026-09-03 01:00Z', 'direct', 1, NULL, NULL, NULL, NULL),
 -- K5: their call on the job rang out; nothing since
 ('40b00000-0000-4000-8000-000000000737', '40000000-0000-4000-8000-000000000215', 'client.call_logged', 'ghl', 'call', 'inbound', 'ct40k5',
  '{"body":"Call. Provider status: no-answer. Duration: 0 seconds","call_status":"no-answer"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","basis":"job_customer"}}',
  '2026-10-05 01:00Z', '2026-10-05 01:00Z', '2026-10-05 01:00Z', '2026-10-05 01:00Z', 'direct', 1, NULL, NULL, NULL, NULL),
 -- V1: their text on the job, answered a minute later in a text placed on no job
 ('40b00000-0000-4000-8000-000000000741', '40000000-0000-4000-8000-000000000221', 'client.reply', 'ghl', 'sms', 'inbound', 'ct40v1',
  '{"body":"Did you get our deposit emails?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","basis":"job_customer"}}',
  '2026-10-04 01:29Z', '2026-10-04 01:29Z', '2026-10-04 01:29Z', '2026-10-04 01:29Z', 'direct', 1, NULL, NULL, NULL, NULL),
 ('40b00000-0000-4000-8000-000000000742', NULL, 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct40v1',
  '{"body":"Yes, both arrived, thanks"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
  '2026-10-04 01:30Z', '2026-10-04 01:30Z', '2026-10-04 01:30Z', '2026-10-04 01:30Z', 'unplaced', NULL,
  ARRAY['40000000-0000-4000-8000-000000000221'::uuid], NULL, NULL, NULL),
 -- V2: our text answering their old-inbox mail, placed on no job
 ('40b00000-0000-4000-8000-000000000743', NULL, 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct40v2',
  '{"body":"Yes, Monument as quoted"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
  '2026-10-03 02:00Z', '2026-10-03 02:00Z', '2026-10-03 02:00Z', '2026-10-03 02:00Z', NULL, NULL, NULL, NULL, NULL, NULL),
 -- O1: their newer text, in the admin bucket; O2: theirs from before the invoice was due
 ('40b00000-0000-4000-8000-000000000751', NULL, 'client.reply', 'ghl', 'sms', 'inbound', 'ct40o1',
  '{"body":"The paint on the fence is peeling already"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-06 01:00Z', '2026-10-06 01:00Z', '2026-10-06 01:00Z', '2026-10-06 01:00Z', 'admin_bucket', NULL, NULL, NULL, NULL, NULL),
 ('40b00000-0000-4000-8000-000000000752', NULL, 'client.reply', 'ghl', 'sms', 'inbound', 'ct40o2',
  '{"body":"Thanks, invoice received"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-08-26 01:00Z', '2026-08-26 01:00Z', '2026-08-26 01:00Z', '2026-08-26 01:00Z', 'admin_bucket', NULL, NULL, NULL, NULL, NULL),
 -- I1: mail on the builder's job labelled the customer's: from an address that is a client of
 -- another job (the owner's own), from our own domain, and from a crew member
 ('40b00000-0000-4000-8000-000000000761', '40000000-0000-4000-8000-000000000261', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"Action needed: SWMS-94261 / MLB-1 call the builder about the tarp","from":"Owner <owner.personal@example.test>","subject":"Action needed: SWMS-94261"}',
  '{"written_as":"service_role","party_roles":{"version":"party_roles_v2","counterpart_role":"customer","sender_role":"customer","basis":"any_job_customer","audience":"customer"}}',
  '2026-09-14 01:00Z', '2026-09-14 01:00Z', '2026-09-14 01:00Z', '2026-09-14 01:00Z', 'direct', 1, NULL, NULL, NULL, NULL),
 ('40b00000-0000-4000-8000-000000000762', '40000000-0000-4000-8000-000000000261', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"Please check the photos","from":"office.seven@secureworkswa.com.au","subject":"Photos"}',
  '{"written_as":"service_role","party_roles":{"version":"party_roles_v2","counterpart_role":"customer","sender_role":"customer","basis":"job_customer","audience":"customer"}}',
  '2026-09-10 01:00Z', '2026-09-10 01:00Z', '2026-09-10 01:00Z', '2026-09-10 01:00Z', 'direct', 1, NULL, NULL, NULL, NULL),
 ('40b00000-0000-4000-8000-000000000763', '40000000-0000-4000-8000-000000000261', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"Tarp is down, photos attached","from":"crew.seven@example.test","subject":"Tarp"}',
  '{"written_as":"service_role","party_roles":{"version":"party_roles_v2","counterpart_role":"customer","sender_role":"customer","basis":"job_customer","audience":"customer"}}',
  '2026-09-11 01:00Z', '2026-09-11 01:00Z', '2026-09-11 01:00Z', '2026-09-11 01:00Z', 'direct', 1, NULL, NULL, NULL, NULL),
 -- I2: this job's own contact's text, its label naming another job's customer (stamped before the
 -- job had the contact)
 ('40b00000-0000-4000-8000-000000000764', '40000000-0000-4000-8000-000000000264', 'client.reply', 'ghl', 'sms', 'inbound', 'ct40i2',
  '{"body":"Is Friday still on?"}', '{"party_roles":{"version":"party_roles_v2","counterpart_role":"customer","sender_role":"customer","basis":"any_job_customer"}}',
  '2026-10-01 01:00Z', '2026-10-01 01:00Z', '2026-10-01 01:00Z', '2026-10-01 01:00Z', 'direct', 1, NULL, NULL, NULL, NULL);

-- Money (R3): a draft is a check only when issued invoices already bill the same share of its stage
-- for its own payer: its own share issued again (H6), or the whole stage billed in parts with its
-- payer's among them (H5, S1); never on another payer's invoices alone (H1, H2, H3), nor across
-- percentages (H4), which stay our move, a blocker, the first line's item.
-- Words: R4 on the job never fires once we called, texted or emailed the customer's CRM contact
-- after it on any job or none (K1) or they got through since, off the job or on it (K3, K4); R5 and
-- C11 close on our reply placed off the job (V1, V2); the customer's newest message off the job and
-- newer than what they owe leaves whose move unclear and is named (O1, not O2); a job its paid
-- deposit accepted reads accepted, never a new enquiry (A1).
-- Mail: a saved copy on another live job decides where the email belongs: it leaves this job's
-- story, reader and citations, and is never unread here (G1); a copy on the archived bucket or on
-- a holding job keeps it, said so.
-- Who: mail from our own addresses, or labelled with another job's customer, is never this job's
-- customer writing last (I1); this job's own contact still is (I2).
DO $seventh$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; s jsonb; r record; got text; chk jsonb; g uuid; jd record; x uuid;
 g1 constant uuid := '40000000-0000-4000-8000-000000000251';
BEGIN
 -- H1, H2, H3, H4: our move, each draft a loop, a blocker and the first line's item
 FOREACH x IN ARRAY ARRAY['40000000-0000-4000-8000-000000000201', '40000000-0000-4000-8000-000000000202', '40000000-0000-4000-8000-000000000203',
                          '40000000-0000-4000-8000-000000000204']::uuid[] LOOP
  SELECT * INTO r FROM public.context_job_record_loops(ARRAY[x], asof) l WHERE l.rule = 'R3_draft';
  s := public.context_job_story(x, asof);
  IF r.shown_as IS DISTINCT FROM 'loop' OR r.what LIKE '%may duplicate%' OR s->'now'->>'whose_move' IS DISTINCT FROM 'us'
     OR position('Our move, we owe: Draft invoice ' || (SELECT xi.invoice_number FROM public.xero_invoices xi WHERE xi.id::text = r.source_id) IN s->'now'->>'line') = 0
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'now'->'blockers') b WHERE b->>'what' LIKE 'Draft invoice %')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(s->'checks') k WHERE k->>'rule' = 'R3_draft') THEN
   RAISE EXCEPTION 'story safety contract: a draft another payer''s or another percentage''s invoice reaches is still ours to issue: % / % / %', row_to_json(r), s->'now', s->'checks';
  END IF;
 END LOOP;
 -- H5: the whole deposit billed in two halves, one the customer's: a check naming both, and that they bill the whole deposit
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000205'::uuid], asof) l WHERE l.rule = 'R3_draft';
 IF r.shown_as IS DISTINCT FROM 'check'
    OR r.what IS DISTINCT FROM 'Draft invoice INV-7051 $5,203.00 to Two Halves Client not issued since Fri 18 Sep 2026 (INV-7052 paid, INV-7053 paid on the same '
                               || 'reference); it may duplicate the issued deposit invoices INV-7052, INV-7053 on the same job reference ($5,203.00), which together bill the whole deposit' THEN
  RAISE EXCEPTION 'story safety contract: a full deposit draft the halves already bill is a check naming them: %', row_to_json(r);
 END IF;
 -- H6: the customer's own share issued again is a check naming it, to the same payer
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000206'::uuid], asof) l WHERE l.rule = 'R3_draft';
 IF r.shown_as IS DISTINCT FROM 'check'
    OR r.what NOT LIKE '%; it may duplicate the issued deposit invoice INV-7061 to the same payer on the same job reference ($1,000.00)' THEN
  RAISE EXCEPTION 'story safety contract: a draft of the customer''s own share already issued is a check: %', row_to_json(r);
 END IF;
 -- K1, K3, K4: no missed call to return
 FOREACH x IN ARRAY ARRAY['40000000-0000-4000-8000-000000000211', '40000000-0000-4000-8000-000000000213', '40000000-0000-4000-8000-000000000214']::uuid[] LOOP
  s := public.context_job_story(x, asof);
  IF EXISTS (SELECT 1 FROM public.context_job_record_loops(ARRAY[x], asof) l WHERE l.rule = 'R4_missed_call')
     OR s->'now'->>'line' LIKE '%Missed call%' OR s->'now'->>'whose_move' = 'us' THEN
   RAISE EXCEPTION 'story safety contract: a missed call we answered off the job, or that they got through after, is no move: % / %', x, s->'now';
  END IF;
 END LOOP;
 -- K5 (a promise kept): nothing since: our move
 s := public.context_job_story('40000000-0000-4000-8000-000000000215', asof);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'us'
    OR position('Our move, we owe: Missed call from the customer Mon 5 Oct 09:00; no call, text or email to the customer since' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: a missed call with nothing since is our move: %', s->'now';
 END IF;
 -- V1: answered off the job a minute later: the customer did not write last
 s := public.context_job_story('40000000-0000-4000-8000-000000000221', asof);
 IF EXISTS (SELECT 1 FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000221'::uuid], asof) l WHERE l.rule = 'R5_customer_wrote_last')
    OR s->'now'->>'line' LIKE '%wrote last%' OR EXISTS (SELECT 1 FROM jsonb_array_elements(s->'checks') k WHERE k->>'rule' = 'R5_customer_wrote_last') THEN
  RAISE EXCEPTION 'story safety contract: our reply placed off the job answers the customer''s text: %', s->'now';
 END IF;
 -- V2: their old-inbox mail answered by our text placed on no job
 IF EXISTS (SELECT 1 FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000222'::uuid], asof) l
            WHERE l.rule = 'C11_customer_mail_unanswered') THEN
  RAISE EXCEPTION 'story safety contract: our reply placed off the job answers the customer''s old-inbox mail';
 END IF;
 -- O1: an overdue invoice and the customer's newer text in the admin bucket: whose move is unclear,
 -- the line names the invoice and their message, where it sits, unchecked
 s := public.context_job_story('40000000-0000-4000-8000-000000000231', asof);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'unknown'
    OR position('Whose move is unclear, the customer owes: INV-7071 $894.00 overdue from Off Job Client since Tue 1 Sep 2026 (36 days)' IN s->'now'->>'line') = 0
    OR position('The customer''s newest message, Tue 6 Oct (not placed on any job), is off the job and not yet checked by the reader' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: the customer''s newer message off the job leaves whose move unclear over what they owe, named: %', s->'now';
 END IF;
 -- O2 (a promise kept): their message off the job from before the invoice was due: the customer's move
 s := public.context_job_story('40000000-0000-4000-8000-000000000232', asof);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'customer' OR s->'now'->>'line' LIKE '%off the job%'
    OR position('The customer''s move, the customer owes: INV-7072 $894.00 overdue' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: an older message off the job leaves the customer''s move standing: %', s->'now';
 END IF;
 -- A1: processing, accepted by its paid deposit on Thu 10 Sep: accepted since then, never a new enquiry
 s := public.context_job_story('40000000-0000-4000-8000-000000000241', asof);
 IF s->'now'->>'phase' IS DISTINCT FROM 'accepted' OR s->'now'->>'line' NOT LIKE 'Accepted since Thu 10 Sep%' OR s->'now'->>'line' LIKE '%enquiry%'
    OR public.context_job_story_facts('40000000-0000-4000-8000-000000000241', asof) -> 'accepted' ->> 'by' IS DISTINCT FROM 'deposit' THEN
  RAISE EXCEPTION 'story safety contract: a job its paid deposit accepted reads accepted since the payment: % / %', s->'now',
   public.context_job_story_facts('40000000-0000-4000-8000-000000000241', asof) -> 'accepted';
 END IF;
 -- G1: g21's copy is on the live job G2, which decides where it belongs: never G1's story mail,
 -- evidence or citation; g22 (copy on the archived bucket) and g23 (copy on the holding job G3) stay
 SELECT string_agg(right(m.id::text, 2), ',' ORDER BY m.id) INTO got FROM public.context_job_record_legacy_mail(ARRAY[g1], asof) m;
 IF got IS DISTINCT FROM '22,23' THEN
  RAISE EXCEPTION 'story safety contract: a copy on another live job takes the mail off this job: %', got;
 END IF;
 SELECT string_agg(right(e.src_id::text, 2), ',' ORDER BY e.at) INTO got FROM public.context_ledger_evidence_rows(ARRAY[g1], asof) e;
 IF got IS DISTINCT FROM '22,23' OR NOT EXISTS (SELECT 1 FROM public.context_ledger_evidence_rows(ARRAY['40000000-0000-4000-8000-000000000252'::uuid], asof) e
                                                 WHERE e.src_id = '40b00000-0000-4000-8000-000000000721') THEN
  RAISE EXCEPTION 'story safety contract: the copy''s live job reads the mail, never this job''s reader: %', got;
 END IF;
 chk := public.context_ledger_cite(g1, '{"table":"inbox_events","id":"40a00000-0000-4000-8000-000000000021","excerpt":"Which slats did we pick?"}');
 IF coalesce((chk->>'ok')::boolean, true) OR chk->>'code' IS DISTINCT FROM 'citation_not_admissible'
    OR NOT coalesce((public.context_ledger_cite(g1, '{"table":"inbox_events","id":"40a00000-0000-4000-8000-000000000022","excerpt":"Are the posts concreted?"}')->>'ok')::boolean, false)
    OR NOT coalesce((public.context_ledger_cite(g1, '{"table":"inbox_events","id":"40a00000-0000-4000-8000-000000000023","excerpt":"Can the latch be higher?"}')->>'ok')::boolean, false) THEN
  RAISE EXCEPTION 'story safety contract: a mail whose copy is on another live job is cited there, never here: %', chk;
 END IF;
 s := public.context_job_story(g1, asof);
 IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'not_known') k
                WHERE k->>'what' = '2 emails on this job are shown from the old inbox: their saved copies are on no job yet or on a job that is not live (archived, completed, cancelled, lost, a draft or holding).')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(s->'timeline') t WHERE t->>'source_id' = '40a00000-0000-4000-8000-000000000021')
    OR (SELECT l.what FROM public.context_job_record_loops(ARRAY[g1], asof) l WHERE l.rule = 'C11_customer_mail_unanswered') IS DISTINCT FROM
       'Customer emailed Fri 2 Oct 09:00 (from the old inbox; its saved copy is on holding job SWF-94253) and nothing went to the customer since: '
       || '"Gate latch | Can the latch be higher?"' THEN
  RAISE EXCEPTION 'story safety contract: the story keeps only the mail whose copy is on a bucket or holding job, said so: % / %', s->'not_known',
   (SELECT l.what FROM public.context_job_record_loops(ARRAY[g1], asof) l WHERE l.rule = 'C11_customer_mail_unanswered');
 END IF;
 -- ... and a person moving g21's copy to G2 after a live reading of G1 never makes it unread on G1
 UPDATE public.context_ledger_settings SET mode = 'shadow', calls_per_day = 50, reader = 'luna-ledger:v1', job_ids = NULL;
 UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1;
 INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, evidence_until, promoted_at, created_at, finished_at, updated_at, checks)
 VALUES (g1, 'backfill', 'live', 'luna-ledger:v1', public.context_ledger_mail_rule_since() + interval '1 second', '2026-10-05 00:10Z', '2026-10-04 23:00Z',
         '2026-10-05 00:10Z', '2026-10-05 00:10Z', '{"passed": true, "store": {"pass": true}}')
 RETURNING id INTO g;
 UPDATE public.business_events SET attributed_at = public.context_ledger_mail_rule_since() + interval '2 seconds'
 WHERE id = '40b00000-0000-4000-8000-000000000721';
 s := public.context_job_story(g1, asof);
 SELECT * INTO jd FROM public.context_ledger_judge(ARRAY[g1]);
 IF (s->'meta'->'ledger'->>'unread_rows')::int IS DISTINCT FROM 0 OR jd.reason IS NOT DISTINCT FROM 'new_evidence' OR coalesce(jd.due, false) THEN
  RAISE EXCEPTION 'story safety contract: a mail whose copy a person filed on another live job is never unread here: % / %', s->'meta'->'ledger', to_jsonb(jd);
 END IF;
 -- I1: mail labelled the customer's from another job's client address, our own domain or a crew
 -- member is never this job's customer side: the builder's overdue invoice is the customer's move
 SELECT string_agg(right(m.source_id, 2) || '=' || m.customer_side::text, ',' ORDER BY m.source_id) INTO got
 FROM public.context_job_record_messages(ARRAY['40000000-0000-4000-8000-000000000261'::uuid], asof) m WHERE m.channel = 'email';
 s := public.context_job_story('40000000-0000-4000-8000-000000000261', asof);
 IF got IS DISTINCT FROM '61=false,62=false,63=false' OR s->'now'->>'whose_move' IS DISTINCT FROM 'customer' OR s->'now'->>'line' LIKE '%wrote last%'
    OR position('The customer''s move, the customer owes: INV-7091 $500.50 overdue from Builder Two Six One (the builder)' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: our own or another job''s client''s mail is never the customer writing last: % / %', got, s->'now';
 END IF;
 -- I2 (a promise kept): this job's own contact's text with a stale other-job label is the customer's
 SELECT m.customer_side INTO r FROM public.context_job_record_messages(ARRAY['40000000-0000-4000-8000-000000000264'::uuid], asof) m
 WHERE m.source_id = '40b00000-0000-4000-8000-000000000764';
 IF NOT coalesce(r.customer_side, false) THEN
  RAISE EXCEPTION 'story safety contract: this job''s own contact''s text is the customer''s whatever an old label says: %', row_to_json(r);
 END IF;
END $seventh$;

-- Eighth review fixtures (each fails on the e10ad4a8 bodies unless said to be a promise kept).
-- Money: M8 (SWMS-261441 class): make-safe, the builder's invoice due 16 Oct, the insured's text
-- off the job after it was raised. S1: a fencing job whose neighbour's final half sits on no job
-- (reference mistyped), the customer's own final half overdue. S2: a tenant's job half paid by an
-- agency (another payer), the agency's invoice for another property on no job, overdue.
-- Evidence: C1 (SWF-261419 class): a shadow reading citing a CRM text the CRM dates in June, before
-- the job's lead window. C2: a live reading citing an old-inbox mail whose saved copy is then filed
-- on live job C3. C4: a live reading citing a text since moved to no job. L1: mail whose saved copy is on a complete job
-- L2. L3: mail whose saved copy is on live job L4, which is archived after a live reading of L3.
-- L5: mail whose saved copy on live job L6 the placement review takes off it after a live reading.
-- Words: W1 (SWF-261481 class): the customer's text after their invoice, answered by ours. W2
-- (SWF-26091 class): their voicemail, logged as an answered call with its recording, after the
-- overdue invoice. P1 (SWP-26148 class): no rows on the job, the customer's email on the archived
-- holding bucket P2. P3 (SWP-26115 class): their email in the admin bucket with no CRM contact. P4,
-- P5 (SWF-261518 class): one customer's two jobs, their texts about P4 on P5. F2 (SWF-T4042): its
-- missed call gets a voicemail transcript 45 seconds later.
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, client_email, ghl_contact_id, xero_contact_id, pricing_json,
  accepted_at, completed_at, created_at, site_address, metadata, updated_at)
VALUES
 ('40000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-0000000000aa', 'SWMS-94301', 'processing', 'makesafe', 'Insured Owner Three',
  NULL, 'ct40x1', 'x40-b301', '{}', NULL, NULL, '2026-09-20 01:00Z', NULL, '{}', '2026-09-20 01:00Z'),
 ('40000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-0000000000aa', 'SWF-94302', 'invoiced', 'fencing', 'Front Client',
  NULL, 'ct40s1', 'x40-s1c', '{"totalIncGST": 4000}', NULL, '2026-09-25 01:00Z', '2026-08-20 01:00Z', NULL, '{}', '2026-09-25 01:00Z'),
 ('40000000-0000-4000-8000-000000000304', '00000000-0000-4000-8000-0000000000aa', 'SWF-94304', 'invoiced', 'fencing', 'Tenant Client',
  NULL, 'ct40s2', 'x40-s2t', '{"totalIncGST": 3000}', NULL, '2026-09-25 01:00Z', '2026-08-20 01:00Z', NULL, '{}', '2026-09-25 01:00Z'),
 ('40000000-0000-4000-8000-000000000305', '00000000-0000-4000-8000-0000000000aa', 'SWF-94305', 'quoted', 'fencing', 'June Text Client',
  NULL, 'ct40y1', NULL, '{}', NULL, NULL, '2026-09-15 01:00Z', NULL, '{}', '2026-09-15 01:00Z'),
 ('40000000-0000-4000-8000-000000000306', '00000000-0000-4000-8000-0000000000aa', 'SWF-94306', 'quoted', 'fencing', 'Moved Text Client',
  NULL, 'ct40y4', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z', NULL, '{}', '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000307', '00000000-0000-4000-8000-0000000000aa', 'SWF-94307', 'quoted', 'fencing', 'Cited Mail Client',
  'cited.mail@example.test', 'ct40y2', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z', NULL, '{}', '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000308', '00000000-0000-4000-8000-0000000000aa', 'SWF-94308', 'quoted', 'fencing', 'Other Live Two',
  NULL, 'ct40y3', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z', NULL, '{}', '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000309', '00000000-0000-4000-8000-0000000000aa', 'SWF-94309', 'quoted', 'fencing', 'Complete Copy Client',
  'complete.copy@example.test', 'ct40l1', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z', NULL, '{}', '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000310', '00000000-0000-4000-8000-0000000000aa', 'SWF-94310', 'complete', 'fencing', 'Finished Other',
  NULL, 'ct40l2', NULL, '{}', NULL, NULL, '2026-07-01 01:00Z', NULL, '{}', '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000311', '00000000-0000-4000-8000-0000000000aa', 'SWF-94311', 'quoted', 'fencing', 'Archived Later Client',
  'archived.later@example.test', 'ct40l3', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z', NULL, '{}', '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000312', '00000000-0000-4000-8000-0000000000aa', 'SWF-94312', 'quoted', 'fencing', 'Live Then Archived',
  NULL, 'ct40l4', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z', NULL, '{}', '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000313', '00000000-0000-4000-8000-0000000000aa', 'SWF-94313', 'quoted', 'fencing', 'Reviewed Copy Client',
  'reviewed.copy@example.test', 'ct40l5', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z', NULL, '{}', '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000314', '00000000-0000-4000-8000-0000000000aa', 'SWF-94314', 'quoted', 'fencing', 'Review From Job',
  NULL, 'ct40l6', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z', NULL, '{}', '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000315', '00000000-0000-4000-8000-0000000000aa', 'SWF-94315', 'invoiced', 'fencing', 'Cash Client',
  NULL, 'ct40z1', 'x40-z1', '{}', NULL, NULL, '2026-09-01 01:00Z', NULL, '{}', '2026-09-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000316', '00000000-0000-4000-8000-0000000000aa', 'SWF-94316', 'invoiced', 'fencing', 'Voicemail Client',
  NULL, 'ct40z2', 'x40-z2', '{}', NULL, NULL, '2026-08-01 01:00Z', NULL, '{}', '2026-08-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000317', '00000000-0000-4000-8000-0000000000aa', 'SWP-94317', 'quoted', 'patio', 'Bucket Reply Client',
  'bucket.reply@example.test', 'ct40w1', NULL, '{}', NULL, NULL, '2026-09-30 01:00Z', NULL, '{}', '2026-09-30 01:00Z'),
 ('40000000-0000-4000-8000-000000000318', '00000000-0000-4000-8000-0000000000aa', 'SWF-94318', 'archived', 'fencing', 'PDF Bucket',
  NULL, NULL, NULL, '{}', NULL, NULL, '2026-05-01 01:00Z', NULL, '{"do_not_schedule": true}', '2026-05-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000319', '00000000-0000-4000-8000-0000000000aa', 'SWP-94319', 'quoted', 'patio', 'Address Only Client',
  'address.only@example.test', 'ct40w2', NULL, '{}', NULL, NULL, '2026-10-01 01:00Z', NULL, '{}', '2026-10-01 01:00Z'),
 ('40000000-0000-4000-8000-000000000320', '00000000-0000-4000-8000-0000000000aa', 'SWF-94320', 'scheduled', 'fencing', 'Two Sites Client',
  NULL, 'ct40w3', NULL, '{}', NULL, NULL, '2026-09-28 01:00Z', NULL, '{}', '2026-09-28 01:00Z'),
 ('40000000-0000-4000-8000-000000000321', '00000000-0000-4000-8000-0000000000aa', 'SWF-94321', 'scheduled', 'fencing', 'Two Sites Client',
  NULL, 'ct40w3', NULL, '{}', NULL, NULL, '2026-09-28 01:00Z', NULL, '{}', '2026-09-28 01:00Z');
INSERT INTO public.makesafe_job_details (job_id, requesting_company_name, created_at)
VALUES ('40000000-0000-4000-8000-000000000301', 'Builder Three Zero One', '2026-09-20 01:00Z');
INSERT INTO public.job_contacts (id, job_id, contact_type, client_name, xero_contact_id, is_primary, created_at)
VALUES ('40d00000-0000-4000-8000-000000000801', '40000000-0000-4000-8000-000000000302', 'primary', 'Front Client', 'x40-s1c', true, '2026-08-20 01:00Z'),
       ('40d00000-0000-4000-8000-000000000802', '40000000-0000-4000-8000-000000000302', 'neighbour_b', 'Back Neighbour', 'x40-s1n', false, '2026-08-20 01:00Z');
INSERT INTO public.xero_invoices (org_id, id, job_id, xero_invoice_id, xero_contact_id, contact_name, invoice_number, invoice_type, status, reference,
  total, amount_due, amount_paid, invoice_date, due_date, fully_paid_on, line_items, raw_json, job_contact_id, created_at)
VALUES
 -- M8: the builder's invoice, raised Fri 2 Oct, due Fri 16 Oct
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000801', '40000000-0000-4000-8000-000000000301', 'x8011', 'x40-b301', 'Builder Three Zero One',
  'INV-8011', 'ACCREC', 'AUTHORISED', 'SWMS-94301', 2145.00, 2145.00, 0, '2026-10-02', '2026-10-16', NULL, NULL, '{"Status":"AUTHORISED","Payments":[]}', NULL, '2026-10-02 01:00Z'),
 -- S1: both deposit halves paid, the customer's final half overdue on the job, the neighbour's on no job
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000811', '40000000-0000-4000-8000-000000000302', 'x9901', 'x40-s1c', 'Front Client',
  'INV-9901', 'ACCREC', 'PAID', 'SWF-94302-A-DEP50', 1000.00, 0, 1000.00, '2026-08-25', '2026-09-01', '2026-08-26', NULL, '{"Status":"PAID","Payments":[]}',
  '40d00000-0000-4000-8000-000000000801', '2026-08-25 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000812', '40000000-0000-4000-8000-000000000302', 'x9902', 'x40-s1n', 'Back Neighbour',
  'INV-9902', 'ACCREC', 'PAID', 'SWF-94302-B-DEP50', 1000.00, 0, 1000.00, '2026-08-25', '2026-09-01', '2026-08-27', NULL, '{"Status":"PAID","Payments":[]}',
  '40d00000-0000-4000-8000-000000000802', '2026-08-25 01:05Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000813', '40000000-0000-4000-8000-000000000302', 'x9903', 'x40-s1c', 'Front Client',
  'INV-9903', 'ACCREC', 'AUTHORISED', 'SWF-94302-A-FINBAL50', 1000.00, 1000.00, 0, '2026-09-21', '2026-09-28', NULL, NULL, '{"Status":"AUTHORISED","Payments":[]}',
  '40d00000-0000-4000-8000-000000000801', '2026-09-21 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000814', NULL, 'x9904', 'x40-s1n', 'Back Neighbour',
  'INV-9904', 'ACCREC', 'AUTHORISED', 'SWF-9430-B-FINBAL50', 1000.00, 1000.00, 0, '2026-09-21', '2026-09-28', NULL, NULL, '{"Status":"AUTHORISED","Payments":[]}',
  NULL, '2026-09-21 01:05Z'),
 -- S2: the tenant's deposit and the agency's half paid on the job; the agency's invoice for another property on no job
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000821', '40000000-0000-4000-8000-000000000304', 'x9911', 'x40-s2t', 'Tenant Client',
  'INV-9911', 'ACCREC', 'PAID', 'SWF-94304-DEP', 1000.00, 0, 1000.00, '2026-08-25', '2026-09-01', '2026-08-26', NULL, '{"Status":"PAID","Payments":[]}', NULL, '2026-08-25 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000822', '40000000-0000-4000-8000-000000000304', 'x9912', 'x40-s2a', 'Agency Co',
  'INV-9912', 'ACCREC', 'PAID', 'SWF-94304', 1000.00, 0, 1000.00, '2026-08-25', '2026-09-01', '2026-08-27', NULL, '{"Status":"PAID","Payments":[]}', NULL, '2026-08-25 01:05Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000823', NULL, 'x9913', 'x40-s2a', 'Agency Co',
  'INV-9913', 'ACCREC', 'AUTHORISED', 'Unit 4 Other Street', 3300.00, 3300.00, 0, '2026-09-10', '2026-09-20', NULL, NULL, '{"Status":"AUTHORISED","Payments":[]}',
  NULL, '2026-09-10 01:00Z'),
 -- W1: due Tue 13 Oct, raised Fri 25 Sep; W2: overdue since Thu 10 Sep
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000831', '40000000-0000-4000-8000-000000000315', 'x8151', 'x40-z1', 'Cash Client',
  'INV-8151', 'ACCREC', 'AUTHORISED', 'SWF-94315', 302.51, 302.51, 0, '2026-09-25', '2026-10-13', NULL, NULL, '{"Status":"AUTHORISED","Payments":[]}', NULL, '2026-09-25 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '40c00000-0000-4000-8000-000000000832', '40000000-0000-4000-8000-000000000316', 'x8161', 'x40-z2', 'Voicemail Client',
  'INV-8161', 'ACCREC', 'AUTHORISED', 'SWF-94316', 2500.00, 2500.00, 0, '2026-09-03', '2026-09-10', NULL, NULL, '{"Status":"AUTHORISED","Payments":[]}', NULL, '2026-09-03 01:00Z');
-- C1: the CRM's own time of the June text, kept when the cache held it
INSERT INTO public.context_crm_message_times (ghl_message_id, contact_id, crm_at) VALUES ('m40-y1', 'ct40y1', '2026-06-10 01:08Z');
-- old-inbox mail: C2's on C1's sibling job, L1's, L3's and L5's
INSERT INTO public.inbox_events (id, job_id, from_email, subject, body_preview, received_at, processed_at, graph_message_id, mailbox, classification)
VALUES ('40a00000-0000-4000-8000-000000000031', '40000000-0000-4000-8000-000000000307', 'cited.mail@example.test', 'Gate', 'Please confirm the gate width',
        '2026-10-01 01:00Z', '2026-10-01 01:00Z', 'g40-31', 'office@example.test', 'client_reply'),
       ('40a00000-0000-4000-8000-000000000032', '40000000-0000-4000-8000-000000000309', 'complete.copy@example.test', 'Colour', 'Which colour did we settle on?',
        '2026-10-02 01:00Z', '2026-10-02 01:00Z', 'g40-32', 'office@example.test', 'client_reply'),
       ('40a00000-0000-4000-8000-000000000033', '40000000-0000-4000-8000-000000000311', 'archived.later@example.test', 'Height', 'Can the fence be 1.8 m?',
        '2026-10-02 01:00Z', '2026-10-02 01:00Z', 'g40-33', 'office@example.test', 'client_reply'),
       ('40a00000-0000-4000-8000-000000000034', '40000000-0000-4000-8000-000000000313', 'reviewed.copy@example.test', 'Posts', 'Are the posts in yet?',
        '2026-10-02 01:00Z', '2026-10-02 01:00Z', 'g40-34', 'office@example.test', 'client_reply');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence, candidate_job_ids, provider_message_id, source_table, source_id, attributed_at)
VALUES
 -- M8: the insured's text off the job (admin bucket), after the builder's invoice was raised
 ('40b00000-0000-4000-8000-000000000801', NULL, 'client.reply', 'ghl', 'sms', 'inbound', 'ct40x1',
  '{"body":"Thanks for the update on the install"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-02 05:00Z', '2026-10-02 05:00Z', '2026-10-02 05:00Z', '2026-10-02 05:00Z', 'admin_bucket', NULL, NULL, NULL, NULL, NULL, NULL),
 -- C1: the CRM text the CRM dates 10 Jun, loaded 16 Sep (the job was created 15 Sep)
 ('40b00000-0000-4000-8000-000000000805', '40000000-0000-4000-8000-000000000305', 'client.reply', 'ghl_sms_cache_backfill', 'sms', 'inbound', 'ct40y1',
  '{"body":"Please honour the June price","ghl_message_id":"m40-y1"}',
  '{"written_as":"service_role","party_roles":{"counterpart_role":"customer","sender_role":"customer","basis":"job_customer"}}',
  '2026-09-16 01:00Z', '2026-09-16 01:00Z', '2026-09-16 01:00Z', '2026-09-16 01:00Z', 'single_open', 1, NULL, 'ghl:m40-y1', NULL, NULL, '2026-09-16 01:00Z'),
 -- C4: a text of theirs a live reading cited, since taken off its job by hand (its placement status
 -- left as it was, so the 033000 re-check came out unknown, which passed)
 ('40b00000-0000-4000-8000-000000000807', NULL, 'client.reply', 'ghl', 'sms', 'inbound', 'ct40y4',
  '{"body":"We will be away until the 20th"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-09-28 01:00Z', '2026-09-28 01:00Z', '2026-09-28 01:00Z', '2026-09-28 01:00Z', 'direct', 1, NULL, NULL, NULL, NULL, '2026-09-28 01:00Z'),
 -- L1's mail's saved copy, on the complete job L2
 ('40b00000-0000-4000-8000-000000000809', '40000000-0000-4000-8000-000000000310', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"Which colour did we settle on?","from":"complete.copy@example.test","subject":"Colour"}', '{"written_as":"service_role"}',
  '2026-10-02 01:00Z', '2026-10-02 01:05Z', '2026-10-02 01:00Z', '2026-10-02 01:05Z', 'direct', 1, NULL, NULL, 'inbox_events', '40a00000-0000-4000-8000-000000000032', '2026-10-02 01:05Z'),
 -- L3's mail's saved copy, on the live job L4; L5's, on the live job L6 (placed by a contact rule)
 ('40b00000-0000-4000-8000-000000000811', '40000000-0000-4000-8000-000000000312', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"Can the fence be 1.8 m?","from":"archived.later@example.test","subject":"Height"}', '{"written_as":"service_role"}',
  '2026-10-02 01:00Z', '2026-10-02 01:05Z', '2026-10-02 01:00Z', '2026-10-02 01:05Z', 'direct', 1, NULL, NULL, 'inbox_events', '40a00000-0000-4000-8000-000000000033', '2026-10-02 01:05Z'),
 ('40b00000-0000-4000-8000-000000000813', '40000000-0000-4000-8000-000000000314', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"Are the posts in yet?","from":"reviewed.copy@example.test","subject":"Posts"}', '{"written_as":"service_role"}',
  '2026-10-02 01:00Z', '2026-10-02 01:05Z', '2026-10-02 01:00Z', '2026-10-02 01:05Z', 'single_open', 1, NULL, NULL, 'inbox_events', '40a00000-0000-4000-8000-000000000034', '2026-10-02 01:05Z'),
 -- W1: their text after the invoice was raised, our reply two hours later
 ('40b00000-0000-4000-8000-000000000815', '40000000-0000-4000-8000-000000000315', 'client.reply', 'ghl', 'sms', 'inbound', 'ct40z1',
  '{"body":"Can we pay cash on the day? We need it done before the 15th"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","basis":"job_customer"}}',
  '2026-10-01 01:00Z', '2026-10-01 01:00Z', '2026-10-01 01:00Z', '2026-10-01 01:00Z', 'direct', 1, NULL, NULL, NULL, NULL, '2026-10-01 01:00Z'),
 ('40b00000-0000-4000-8000-000000000816', '40000000-0000-4000-8000-000000000315', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct40z1',
  '{"body":"Cash is fine, we will be there Wednesday"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff","basis":"job_customer"}}',
  '2026-10-01 03:00Z', '2026-10-01 03:00Z', '2026-10-01 03:00Z', '2026-10-01 03:00Z', 'direct', 1, NULL, NULL, NULL, NULL, '2026-10-01 03:00Z'),
 -- W2: our call, then theirs (logged answered, 58 seconds) and its recording, a voicemail
 ('40b00000-0000-4000-8000-000000000817', '40000000-0000-4000-8000-000000000316', 'client.call_logged', 'ghl', 'call', 'outbound', 'ct40z2',
  '{"body":"Call. Provider status: completed. Duration: 12 seconds","call_status":"completed"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff","basis":"job_customer"}}',
  '2026-09-25 09:41:40Z', '2026-09-25 09:41:40Z', '2026-09-25 09:41:40Z', '2026-09-25 09:41:40Z', 'direct', 1, NULL, NULL, NULL, NULL, '2026-09-25 09:41:40Z'),
 ('40b00000-0000-4000-8000-000000000818', '40000000-0000-4000-8000-000000000316', 'client.call_logged', 'ghl', 'call', 'inbound', 'ct40z2',
  '{"body":"Call. Provider status: completed. Duration: 58 seconds","call_status":"completed"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","basis":"job_customer"}}',
  '2026-09-25 10:28:46Z', '2026-09-25 10:28:46Z', '2026-09-25 10:28:46Z', '2026-09-25 10:28:46Z', 'direct', 1, NULL, 'ghl:c40-818', NULL, NULL, '2026-09-25 10:28:46Z'),
 ('40b00000-0000-4000-8000-000000000819', '40000000-0000-4000-8000-000000000316', 'call.transcript_completed', 'ghl-call-transcript', 'call', 'inbound', 'ct40z2',
  '{"transcript":"You have reached the message bank. Hi, it is the customer, sorry I missed you, please call me about the rectification","ghl_call_id":"c40-818"}',
  '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","basis":"job_customer"}}',
  '2026-09-25 10:28:47Z', '2026-09-25 10:28:47Z', '2026-09-25 10:28:47Z', '2026-09-25 10:28:47Z', 'direct', 1, NULL, 'ghltx:c40-818', NULL, NULL, '2026-09-25 10:28:47Z'),
 -- P1: the customer's email on the archived holding bucket, matched only by their address
 ('40b00000-0000-4000-8000-000000000820', '40000000-0000-4000-8000-000000000318', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"Yes please go ahead with the patio","from":"Bucket Reply <bucket.reply@example.test>","subject":"Re: your patio quote"}', '{"written_as":"service_role"}',
  '2026-09-30 01:25Z', '2026-09-30 01:25Z', '2026-09-30 01:25Z', '2026-09-30 01:25Z', 'direct', 1, NULL, NULL, NULL, NULL, '2026-09-30 01:25Z'),
 -- P3: theirs in the admin bucket, no CRM contact
 ('40b00000-0000-4000-8000-000000000821', NULL, 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"Thanks, the measurements are attached","from":"address.only@example.test","subject":"Measurements"}', '{"written_as":"service_role"}',
  '2026-10-02 01:00Z', '2026-10-02 01:00Z', '2026-10-02 01:00Z', '2026-10-02 01:00Z', 'admin_bucket', NULL, NULL, NULL, NULL, NULL, NULL),
 -- P5: the customer's text about P4's visit, on P5, and our reply there
 ('40b00000-0000-4000-8000-000000000822', '40000000-0000-4000-8000-000000000321', 'client.reply', 'ghl', 'sms', 'inbound', 'ct40w3',
  '{"body":"Is the other site still on for Friday?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","basis":"job_customer"}}',
  '2026-10-05 01:00Z', '2026-10-05 01:00Z', '2026-10-05 01:00Z', '2026-10-05 01:00Z', 'direct', 1, NULL, NULL, NULL, NULL, '2026-10-05 01:00Z'),
 ('40b00000-0000-4000-8000-000000000823', '40000000-0000-4000-8000-000000000321', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct40w3',
  '{"body":"Yes, Friday at 8"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff","basis":"job_customer"}}',
  '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', 'direct', 1, NULL, NULL, NULL, NULL, '2026-10-05 02:00Z');

-- Money: an off-job message changes only what its sender owes (M8: never the builder's on builder
-- work, where the CRM contact is the insured); this job's own Xero contacts are its customer's only
-- (S1: the neighbour's invoice on no job is theirs, named so in C2 and never in the first line; S2:
-- another payer's invoice on no job is never this job's); a draft shown as an R3 check may
-- duplicate issued invoices (H5, SWF-26545 class).
-- Evidence: a stored citation the citation check refuses now hides its item and asks for a rebuild,
-- and the judge raises citation_moved (C1, C2); a copy on a job that is not live keeps the mail
-- (L1), and a copy leaving a live job (L3: the job archived; L5: the placement review takes it off)
-- makes the mail unread to a reading built before.
-- Words: the customer's unread newest message on the job makes whose move unclear over what they owe
-- (W1, our reply after it; W2, a voicemail); the contact facts read the customer's rows on a bucket job
-- (P1), by address with no CRM contact (P3) and on their other job (P4); a missed call's voicemail
-- transcript never answers it (F2).
DO $eighth$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; s jsonb; r record; got text; chk jsonb; g uuid; jd record;
 since constant timestamptz := public.context_ledger_mail_rule_since();
BEGIN
 -- M8: the builder's payment stands; the insured's message is never called the customer's
 s := public.context_job_story('40000000-0000-4000-8000-000000000301', asof);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'customer' OR s->'now'->>'line' ~* 'newest message'
    OR position('The customer''s move, the customer owes: INV-8011 $2,145.00 owing from Builder Three Zero One (the builder), due Fri 16 Oct 2026'
                IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: the insured''s text off the job never makes the builder''s payment unclear: %', s->'now';
 END IF;
 -- S1: the neighbour's invoice on no job is theirs: never "addressed to this job's Xero contact"
 s := public.context_job_story('40000000-0000-4000-8000-000000000302', asof);
 SELECT l.what INTO got FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000302'::uuid], asof) l
 WHERE l.rule = 'C2_value_mismatch' AND l.source_id = '40c00000-0000-4000-8000-000000000814';
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'customer' OR s->'now'->>'line' LIKE '%placed on no job%' OR s->'now'->>'line' LIKE '%INV-9904%'
    OR s->'money'->>'line' LIKE '%INV-9904%'
    OR position('The customer''s move, the customer owes: INV-9903 $1,000.00 overdue from Front Client' IN s->'now'->>'line') = 0
    OR (public.context_job_story_meta('40000000-0000-4000-8000-000000000302', asof)->'unplaced_invoices'->>'count')::int IS DISTINCT FROM 0
    OR got NOT LIKE 'Invoice INV-9904 ($1,000.00, authorised, $1,000.00 owing) is addressed to Back Neighbour, a neighbour paying part of this job, but is placed on no job;%'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(s->'loops') l WHERE l->>'rule' LIKE '%R8%' AND l->>'status' = 'open') THEN
  RAISE EXCEPTION 'story safety contract: a neighbour''s invoice on no job is theirs, never this job''s own contact''s: % / % / %', s->'now', s->'money'->>'line', got;
 END IF;
 -- S2: the agency's invoice for another property is never this job's; what is left to invoice is ours
 s := public.context_job_story('40000000-0000-4000-8000-000000000304', asof);
 IF s->'now'->>'line' LIKE '%INV-9913%' OR s->'money'->>'line' LIKE '%INV-9913%' OR s->'now'->>'whose_move' IS DISTINCT FROM 'us'
    OR position('Our move, we owe: Job value $3,000.00 (pricing_json.totalIncGST); issued invoices $2,000.00; $1,000.00 not yet invoiced' IN s->'now'->>'line') = 0
    OR (public.context_job_story_meta('40000000-0000-4000-8000-000000000304', asof)->'unplaced_invoices'->>'count')::int IS DISTINCT FROM 0
    OR EXISTS (SELECT 1 FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000304'::uuid], asof) l
               WHERE l.source_id = '40c00000-0000-4000-8000-000000000823') THEN
  RAISE EXCEPTION 'story safety contract: another payer''s invoice on no job is never this job''s: % / %', s->'now', s->'money'->>'line';
 END IF;
 -- H5 (SWF-26545 class): the full deposit draft the two halves already bill
 s := public.context_job_story('40000000-0000-4000-8000-000000000205', asof);
 IF position('1 draft invoice not issued (it may duplicate issued invoices; check R3)' IN s->'now'->>'line') = 0
    OR position('1 draft invoice of $5,203.00 not issued (it may duplicate issued invoices; check R3)' IN s->'money'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: a draft that may duplicate issued invoices is said so: % / %', s->'now'->>'line', s->'money'->>'line';
 END IF;
 -- C1: a shadow reading made before this migration applied cites the June text, which the citation
 -- check refuses now: asked for by id, the item is hidden, the story asks for a rebuild and never
 -- gives the reading's item as our move; the judge raises citation_moved
 UPDATE public.context_ledger_settings SET mode = 'shadow', calls_per_day = 50, reader = 'luna-ledger:v1', job_ids = NULL;
 UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1;
 chk := public.context_ledger_cite('40000000-0000-4000-8000-000000000305',
          '{"table":"business_events","id":"40b00000-0000-4000-8000-000000000805","excerpt":"Please honour the June price"}');
 -- (every reading's and item's times are stated: a column default is the clock of the run, and the
 -- story replays them as of 7 Oct; evidence_until is set against the rule's first apply)
 INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, evidence_until, created_at, finished_at, updated_at, checks)
 VALUES ('40000000-0000-4000-8000-000000000305', 'backfill', 'shadow', 'luna-ledger:v1', since - interval '1 hour', '2026-10-05 23:00Z',
         '2026-10-06 00:00Z', '2026-10-06 00:00Z', '{"passed": true, "store": {"pass": true}}')
 RETURNING id INTO g;
 INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, to_role, what, opened_at, opened_by, needs_reply, written_by, created_at)
 VALUES (g, '40000000-0000-4000-8000-000000000305', 'request:june-price', 'request', 'open', 'customer', 'us', 'Customer asked us to honour the June price',
         '2026-09-16 01:00Z', '[{"table":"business_events","id":"40b00000-0000-4000-8000-000000000805","excerpt":"Please honour the June price"}]', true,
         'model:luna-ledger:v1', '2026-10-06 00:00Z');
 s := public.context_job_story('40000000-0000-4000-8000-000000000305', asof, g);
 SELECT * INTO jd FROM public.context_ledger_judge(ARRAY['40000000-0000-4000-8000-000000000305'::uuid]);
 IF coalesce((chk->>'ok')::boolean, true) OR (s->'meta'->'ledger'->>'hidden_items')::int IS DISTINCT FROM 1
    OR NOT coalesce((s->'meta'->'ledger'->>'needs_rebuild')::boolean, false) OR s->'now'->>'line' LIKE '%we owe%'
    OR s->'now'->>'whose_move' = 'us' OR jd.reason IS DISTINCT FROM 'citation_moved' THEN
  RAISE EXCEPTION 'story safety contract: a stored citation of a text from before the lead window hides its item and asks for a rebuild: % / % / % / %',
   chk, s->'now', s->'meta'->'ledger', to_jsonb(jd);
 END IF;
 -- C4: a live reading cites a text since moved to no job: the item is hidden (the re-check is never
 -- unknown: a row on no job read as passing before)
 INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, evidence_until, promoted_at, created_at, finished_at, updated_at, checks)
 VALUES ('40000000-0000-4000-8000-000000000306', 'backfill', 'live', 'luna-ledger:v1', since + interval '1 hour', '2026-10-05 00:10Z',
         '2026-10-04 23:00Z', '2026-10-05 00:10Z', '2026-10-05 00:10Z', '{"passed": true, "store": {"pass": true}}')
 RETURNING id INTO g;
 INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, to_role, what, opened_at, opened_by, needs_reply, written_by, created_at)
 VALUES (g, '40000000-0000-4000-8000-000000000306', 'constraint:away', 'constraint', 'open', 'customer', 'us', 'Customer is away until the 20th',
         '2026-09-28 01:00Z', '[{"table":"business_events","id":"40b00000-0000-4000-8000-000000000807","excerpt":"We will be away until the 20th"}]', false,
         'model:luna-ledger:v1', '2026-10-05 00:05Z');
 s := public.context_job_story('40000000-0000-4000-8000-000000000306', asof);
 IF (s->'meta'->'ledger'->>'hidden_items')::int IS DISTINCT FROM 1 OR NOT coalesce((s->'meta'->'ledger'->>'needs_rebuild')::boolean, false) THEN
  RAISE EXCEPTION 'story safety contract: an item citing a row moved to no job is hidden (the check is never unknown): %', s->'meta'->'ledger';
 END IF;
 -- C2: a live reading cites C2's old-inbox mail (read, the item shown: it promotes the mail's C11
 -- candidate, our move) ...
 INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, evidence_until, promoted_at, created_at, finished_at, updated_at, checks)
 VALUES ('40000000-0000-4000-8000-000000000307', 'backfill', 'live', 'luna-ledger:v1', since + interval '1 hour', '2026-10-05 00:10Z',
         '2026-10-04 23:00Z', '2026-10-05 00:10Z', '2026-10-05 00:10Z', '{"passed": true, "store": {"pass": true}}')
 RETURNING id INTO g;
 INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, to_role, what, opened_at, opened_by, needs_reply, written_by, created_at)
 VALUES (g, '40000000-0000-4000-8000-000000000307', 'request:gate-width', 'request', 'open', 'customer', 'us', 'Customer asked us to confirm the gate width',
         '2026-10-01 01:00Z', '[{"table":"inbox_events","id":"40a00000-0000-4000-8000-000000000031","excerpt":"Please confirm the gate width"}]', true,
         'model:luna-ledger:v1', '2026-10-05 00:05Z');
 s := public.context_job_story('40000000-0000-4000-8000-000000000307', asof);
 IF (s->'meta'->'ledger'->>'hidden_items')::int IS DISTINCT FROM 0 OR s->'now'->>'whose_move' IS DISTINCT FROM 'us'
    OR position('Our move, we owe: Customer emailed Thu 1 Oct 09:00' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: a stored citation of mail the citation check still accepts stays shown: % / %', s->'now', s->'meta'->'ledger';
 END IF;
 -- ... then the mail's saved copy is filed on the live job C3, which decides where it belongs: the
 -- item is hidden, the story asks for a rebuild, the judge raises citation_moved
 INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
   context_captured_at, attribution_status, attribution_confidence, source_table, source_id, attributed_at)
 VALUES ('40b00000-0000-4000-8000-000000000808', '40000000-0000-4000-8000-000000000308', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
         '{"body":"Please confirm the gate width","from":"cited.mail@example.test","subject":"Gate"}', '{"written_as":"service_role"}',
         '2026-10-01 01:00Z', '2026-10-06 03:00Z', '2026-10-01 01:00Z', '2026-10-06 03:00Z', 'direct', 1, 'inbox_events',
         '40a00000-0000-4000-8000-000000000031', '2026-10-06 03:00Z');
 s := public.context_job_story('40000000-0000-4000-8000-000000000307', asof);
 SELECT * INTO jd FROM public.context_ledger_judge(ARRAY['40000000-0000-4000-8000-000000000307'::uuid]);
 IF (s->'meta'->'ledger'->>'hidden_items')::int IS DISTINCT FROM 1 OR NOT coalesce((s->'meta'->'ledger'->>'needs_rebuild')::boolean, false)
    OR s->'now'->>'line' LIKE '%we owe%' OR jd.reason IS DISTINCT FROM 'citation_moved' THEN
  RAISE EXCEPTION 'story safety contract: a stored citation of mail whose copy is filed on another live job hides its item, rebuild: % / % / %',
   s->'now', s->'meta'->'ledger', to_jsonb(jd);
 END IF;
 -- L1: the mail whose saved copy is on a complete job stays this job's: story, reader, citation, C11
 SELECT string_agg(right(m.id::text, 2), ',') INTO got FROM public.context_job_record_legacy_mail(ARRAY['40000000-0000-4000-8000-000000000309'::uuid], asof) m;
 IF got IS DISTINCT FROM '32'
    OR NOT EXISTS (SELECT 1 FROM public.context_ledger_evidence_rows(ARRAY['40000000-0000-4000-8000-000000000309'::uuid], asof) e
                   WHERE e.src_id = '40a00000-0000-4000-8000-000000000032')
    OR NOT coalesce((public.context_ledger_cite('40000000-0000-4000-8000-000000000309',
          '{"table":"inbox_events","id":"40a00000-0000-4000-8000-000000000032","excerpt":"Which colour did we settle on?"}')->>'ok')::boolean, false)
    OR (SELECT l.what FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000309'::uuid], asof) l WHERE l.rule = 'C11_customer_mail_unanswered')
       IS DISTINCT FROM 'Customer emailed Fri 2 Oct 09:00 (from the old inbox; its saved copy is on completed job SWF-94310) and nothing went to the customer since: '
                        || '"Colour | Which colour did we settle on?"' THEN
  RAISE EXCEPTION 'story safety contract: a saved copy on a complete job keeps the mail on its live job: %', got;
 END IF;
 -- L3: a live reading of L3 that read everything up to an hour after the rule applied, the mail's copy
 -- then on the live job L4; L4 archived two hours after the rule applied: the mail comes back unread,
 -- and the judge lists L3
 INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, evidence_until, promoted_at, created_at, finished_at, updated_at, checks)
 VALUES ('40000000-0000-4000-8000-000000000311', 'backfill', 'live', 'luna-ledger:v1', since + interval '1 hour', '2026-10-05 00:10Z',
         '2026-10-04 23:00Z', '2026-10-05 00:10Z', '2026-10-05 00:10Z', '{"passed": true, "store": {"pass": true}}'),
        ('40000000-0000-4000-8000-000000000313', 'backfill', 'live', 'luna-ledger:v1', since + interval '1 hour', '2026-10-05 00:10Z',
         '2026-10-04 23:00Z', '2026-10-05 00:10Z', '2026-10-05 00:10Z', '{"passed": true, "store": {"pass": true}}');
 IF EXISTS (SELECT 1 FROM public.context_job_record_legacy_mail(ARRAY['40000000-0000-4000-8000-000000000311'::uuid], asof)) THEN
  RAISE EXCEPTION 'story safety contract: a copy on a live job keeps the mail off the other job';
 END IF;
 UPDATE public.jobs SET status = 'archived', updated_at = since + interval '2 hours' WHERE id = '40000000-0000-4000-8000-000000000312';
 s := public.context_job_story('40000000-0000-4000-8000-000000000311', asof);
 SELECT * INTO jd FROM public.context_ledger_judge(ARRAY['40000000-0000-4000-8000-000000000311'::uuid]);
 IF (s->'meta'->'ledger'->>'unread_rows')::int IS DISTINCT FROM 1 OR s->'now'->>'whose_move' = 'nobody' OR s->'now'->>'line' LIKE '%Nothing open%'
    OR (SELECT e.landed_at FROM public.context_ledger_evidence_rows(ARRAY['40000000-0000-4000-8000-000000000311'::uuid], asof) e
        WHERE e.src_id = '40a00000-0000-4000-8000-000000000033') IS DISTINCT FROM since + interval '2 hours'
    OR jd.reason IS DISTINCT FROM 'new_evidence' THEN
  RAISE EXCEPTION 'story safety contract: a mail whose copy''s live job is archived after a reading is unread to it: % / % / %', s->'now', s->'meta'->'ledger', to_jsonb(jd);
 END IF;
 -- L5: the placement review takes L5's mail's copy off L6 two hours after the rule applied (its
 -- stamp names the time and the job it left): the mail comes back to L5 unread
 UPDATE public.business_events
 SET job_id = NULL, attribution_status = 'pending_luna', attributed_at = NULL,
     metadata = metadata || jsonb_build_object('placement_reconsidered', jsonb_build_object('reason', 'new_job', 'at', since + interval '2 hours',
                                                'from_job_id', '40000000-0000-4000-8000-000000000314', 'from_status', 'single_open'))
 WHERE id = '40b00000-0000-4000-8000-000000000813';
 s := public.context_job_story('40000000-0000-4000-8000-000000000313', asof);
 IF (s->'meta'->'ledger'->>'unread_rows')::int IS DISTINCT FROM 1 OR s->'now'->>'whose_move' = 'nobody' OR s->'now'->>'line' LIKE '%Nothing open%' THEN
  RAISE EXCEPTION 'story safety contract: a mail whose copy the placement review took off a live job after a reading is unread to it: % / %', s->'now', s->'meta'->'ledger';
 END IF;
 -- W1: their text after the invoice, answered by ours: whose move is unclear, both named
 s := public.context_job_story('40000000-0000-4000-8000-000000000315', asof);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'unknown'
    OR position('Whose move is unclear, the customer owes: INV-8151 $302.51 owing from Cash Client, due Tue 13 Oct 2026' IN s->'now'->>'line') = 0
    OR position('The customer''s newest message, Thu 1 Oct (a text), is not yet checked by the reader; our last reply Thu 1 Oct' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: the customer''s message after their invoice, answered by ours, leaves whose move unclear: %', s->'now';
 END IF;
 -- W2: their voicemail after the overdue invoice
 s := public.context_job_story('40000000-0000-4000-8000-000000000316', asof);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'unknown'
    OR position('Whose move is unclear, the customer owes: INV-8161 $2,500.00 overdue from Voicemail Client' IN s->'now'->>'line') = 0
    OR position('The customer''s newest message, Fri 25 Sep (a call recording), is not yet checked by the reader; our last reply Fri 25 Sep' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: the customer''s voicemail after the overdue invoice leaves whose move unclear: %', s->'now';
 END IF;
 -- P1: no rows on the job; the customer's email on the bucket job is named, unchecked
 s := public.context_job_story('40000000-0000-4000-8000-000000000317', asof);
 IF s->'now'->>'line' LIKE '%no customer message and no reply from us on record%'
    OR position('Whose move is unclear: no record item is open, and the messages are not yet checked for promises or requests; '
                || 'newest customer message Wed 30 Sep (on archived job SWF-94318)' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: the customer''s reply on a bucket job is never "no customer message": %', s->'now';
 END IF;
 -- P3: their email by address alone, in the admin bucket
 s := public.context_job_story('40000000-0000-4000-8000-000000000319', asof);
 IF position('newest customer message Fri 2 Oct (not placed on any job)' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: the customer''s email with no CRM contact is named: %', s->'now';
 END IF;
 -- P4: their messages and ours on their other job
 s := public.context_job_story('40000000-0000-4000-8000-000000000320', asof);
 IF position('newest customer message Mon 5 Oct (on job SWF-94321), our last reply Mon 5 Oct (on job SWF-94321)' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: the customer''s messages on their other job are named "on job X": %', s->'now';
 END IF;
 -- F2 (SWF-T4042): the missed call's voicemail transcript 45 seconds later never answers it
 INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
   attribution_status, attribution_confidence)
 VALUES ('40b00000-0000-4000-8000-000000000824', '40000000-0000-4000-8000-000000000042', 'call.transcript_completed', 'transcribe-call', 'call', 'inbound', 'ct40f2',
         '{"transcript":"Hi, it is me, please call me back about the invoice"}', '{}', '2026-10-04 01:00:45Z', '2026-10-04 01:00:45Z', '2026-10-04 01:00:45Z', 'direct', 1);
 s := public.context_job_story('40000000-0000-4000-8000-000000000042', asof);
 IF NOT EXISTS (SELECT 1 FROM public.context_job_record_loops(ARRAY['40000000-0000-4000-8000-000000000042'::uuid], asof) l WHERE l.rule = 'R4_missed_call')
    OR position('Our move, we owe: Missed call from the customer Sun 4 Oct 09:00' IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'story safety contract: a missed call''s voicemail transcript never answers it: %', s->'now';
 END IF;
END $eighth$;

-- Ninth review fixtures, regression fixes (each fails on the bddb8494 bodies unless said to be a
-- promise kept). R1 to R3 (SWR-261488, SWMS-261065, SWMS-261163 class): three builder jobs for three
-- clients at three sites, one CRM contact and one client phone (a builder's, linked by phone), the
-- contact's answered call placed on R3. H1, H2 (SWMS-26547 class, a promise kept): one household's
-- make-safe and fencing jobs at one street, the address written with and without its suburb, under
-- two names. Q1, Q2: two contactless builder jobs for two clients with one client phone, the phone
-- owner's text placed on neither (both are its candidates).
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, client_email, client_phone, ghl_contact_id, xero_contact_id, pricing_json,
  accepted_at, completed_at, created_at, site_address, metadata, updated_at)
VALUES
 ('40000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-0000000000aa', 'SWR-94401', 'accepted', 'repair', 'Client Alpha One',
  NULL, '0400 111 222', 'ct40rf', NULL, '{}', NULL, NULL, '2026-09-30 01:00Z', '1 Alpha Street, Perth WA 6000', '{}', '2026-09-30 01:00Z'),
 ('40000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-0000000000aa', 'SWMS-94402', 'accepted', 'makesafe', 'Client Beta Two',
  NULL, '0400111222', 'ct40rf', NULL, '{}', NULL, NULL, '2026-09-20 01:00Z', '2 Beta Road, Perth WA 6000', '{}', '2026-09-20 01:00Z'),
 ('40000000-0000-4000-8000-000000000403', '00000000-0000-4000-8000-0000000000aa', 'SWMS-94403', 'processing', 'makesafe', 'Client Gamma Three',
  NULL, '+61 400 111 222', 'ct40rf', NULL, '{}', NULL, NULL, '2026-09-25 01:00Z', '3 Gamma Avenue, Perth WA 6000', '{}', '2026-09-25 01:00Z'),
 ('40000000-0000-4000-8000-000000000404', '00000000-0000-4000-8000-0000000000aa', 'SWMS-94404', 'processing', 'makesafe', 'Tony Sample',
  NULL, '0400 333 444', 'ct40hh', NULL, '{}', NULL, NULL, '2026-09-25 01:00Z', '8 Sample Pass', '{}', '2026-09-25 01:00Z'),
 ('40000000-0000-4000-8000-000000000405', '00000000-0000-4000-8000-0000000000aa', 'SWF-94405', 'quoted', 'fencing', 'Sarah Sample',
  NULL, '0400 333 444', 'ct40hh', NULL, '{}', NULL, NULL, '2026-06-25 01:00Z', '8 Sample Pass, Kinross WA 6028, Australia', '{}', '2026-06-25 01:00Z'),
 ('40000000-0000-4000-8000-000000000406', '00000000-0000-4000-8000-0000000000aa', 'SWMS-94406', 'processing', 'makesafe', 'Client Delta Four',
  NULL, '0400 555 666', NULL, NULL, '{}', NULL, NULL, '2026-09-25 01:00Z', '4 Delta Lane, Perth WA 6000', '{}', '2026-09-25 01:00Z'),
 ('40000000-0000-4000-8000-000000000407', '00000000-0000-4000-8000-0000000000aa', 'SWMS-94407', 'processing', 'makesafe', 'Client Echo Five',
  NULL, '0400555666', NULL, NULL, '{}', NULL, NULL, '2026-09-26 01:00Z', '5 Echo Court, Perth WA 6000', '{}', '2026-09-26 01:00Z');
INSERT INTO public.makesafe_job_details (job_id, requesting_company_name, created_at)
VALUES ('40000000-0000-4000-8000-000000000401', 'Builder Four Zero', '2026-09-30 01:00Z'),
       ('40000000-0000-4000-8000-000000000402', 'Builder Four Zero', '2026-09-20 01:00Z'),
       ('40000000-0000-4000-8000-000000000403', 'Builder Four Zero', '2026-09-25 01:00Z'),
       ('40000000-0000-4000-8000-000000000404', 'Builder Four Zero', '2026-09-25 01:00Z'),
       ('40000000-0000-4000-8000-000000000406', 'Builder Four Zero', '2026-09-25 01:00Z'),
       ('40000000-0000-4000-8000-000000000407', 'Builder Four Zero', '2026-09-26 01:00Z');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence, candidate_job_ids, provider_message_id)
VALUES
 -- R3: the shared contact's answered call, placed on R3
 ('40b00000-0000-4000-8000-000000000901', '40000000-0000-4000-8000-000000000403', 'client.call_logged', 'ghl', 'call', 'inbound', 'ct40rf',
  '{"body":"Call. Provider status: completed. Duration: 95 seconds","call_status":"completed"}',
  '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","basis":"job_customer"}}',
  '2026-09-30 02:00Z', '2026-09-30 02:00Z', '2026-09-30 02:00Z', '2026-09-30 02:00Z', 'direct', 1, NULL, 'ghl:c40-901'),
 -- H1: the household's text on the make-safe
 ('40b00000-0000-4000-8000-000000000902', '40000000-0000-4000-8000-000000000404', 'client.reply', 'ghl', 'sms', 'inbound', 'ct40hh',
  '{"body":"Is the tarp still holding?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","basis":"job_customer"}}',
  '2026-10-01 01:00Z', '2026-10-01 01:00Z', '2026-10-01 01:00Z', '2026-10-01 01:00Z', 'direct', 1, NULL, NULL),
 -- Q1, Q2: the phone owner's text, placed on neither
 ('40b00000-0000-4000-8000-000000000903', NULL, 'client.reply', 'ghl', 'sms', 'inbound', 'ct40qq',
  '{"body":"Can the crew start early tomorrow?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-01 02:00Z', '2026-10-01 02:00Z', '2026-10-01 02:00Z', '2026-10-01 02:00Z', 'unplaced', NULL,
  ARRAY['40000000-0000-4000-8000-000000000406', '40000000-0000-4000-8000-000000000407']::uuid[], NULL);

-- A contact shared across clients is the job contact on every line and in who, never the insured, and
-- not_known says why; the household's contact at one street stays the insured's (a promise kept).
DO $ninth$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; s jsonb; m jsonb; j uuid;
BEGIN
 FOREACH j IN ARRAY ARRAY['40000000-0000-4000-8000-000000000401', '40000000-0000-4000-8000-000000000402', '40000000-0000-4000-8000-000000000403']::uuid[] LOOP
  m := public.context_job_story_meta(j, asof);
  s := public.context_job_story(j, asof);
  IF m->'contact_shared' IS DISTINCT FROM '{"shared": true, "by": ["contact", "phone"], "other_jobs": 2}'::jsonb
     OR s->'now'->>'line' ~* 'insured'
     OR position(CASE WHEN j = '40000000-0000-4000-8000-000000000403' THEN 'the job contact''s newest message Wed 30 Sep, no reply from us on record'
                      ELSE 'the job contact''s newest message Wed 30 Sep (on job SWMS-94403), no reply from us on record' END IN s->'now'->>'line') = 0
     OR (SELECT w->'contact_ref' FROM jsonb_array_elements(s->'who') w WHERE w->>'role' = 'insured') IS DISTINCT FROM 'null'::jsonb
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'not_known') k
                    WHERE k->>'what' = 'This job''s CRM contact and client phone are also on 2 jobs of other clients, so the messages the story names are not taken to be the '
                                       || 'insured''s: the first line calls them the job contact''s.') THEN
   RAISE EXCEPTION 'story safety contract: a contact shared across three clients'' builder jobs is never the insured: % / % / % / %',
    m->'contact_shared', s->'now'->>'line', s->'who', s->'not_known';
  END IF;
 END LOOP;
 -- Q1: the shared phone's owner's text placed on no job is the job contact's
 m := public.context_job_story_meta('40000000-0000-4000-8000-000000000406', asof);
 s := public.context_job_story('40000000-0000-4000-8000-000000000406', asof);
 IF m->'contact_shared' IS DISTINCT FROM '{"shared": true, "by": ["phone"], "other_jobs": 1}'::jsonb OR s->'now'->>'line' ~* 'insured'
    OR position('the job contact''s newest message Thu 1 Oct (not placed on any job)' IN s->'now'->>'line') = 0
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'not_known') k
                   WHERE k->>'what' = 'This job''s client phone is also on another client''s job, so the messages the story names are not taken to be the insured''s: '
                                      || 'the first line calls them the job contact''s.') THEN
  RAISE EXCEPTION 'story safety contract: a client phone shared across clients'' builder jobs is never the insured''s: % / % / %', m->'contact_shared', s->'now'->>'line', s->'not_known';
 END IF;
 -- H1: the household's contact, also on its fencing job at the same street under another name, sits
 -- on no other client's job ...
 m := public.context_job_story_meta('40000000-0000-4000-8000-000000000404', asof);
 s := public.context_job_story('40000000-0000-4000-8000-000000000404', asof);
 IF m->'contact_shared' IS DISTINCT FROM '{"shared": false, "by": [], "other_jobs": 0}'::jsonb THEN
  RAISE EXCEPTION 'story safety contract: one household''s contact at one street is on no other client''s job: %', m->'contact_shared';
 END IF;
 -- ... and stays the insured's (a promise kept)
 IF position('The insured wrote last on Thu 1 Oct' IN s->'now'->>'line') = 0
    OR NOT s->'who' @> '[{"name":"Tony Sample","role":"insured","contact_ref":"ct40hh"}]'::jsonb THEN
  RAISE EXCEPTION 'story safety contract: one household''s contact at one street is the insured''s: % / %', s->'now'->>'line', s->'who';
 END IF;
END $ninth$;
ROLLBACK;

-- 8. Re-applying the migration changes nothing (its guard accepts its own bodies). (Sixth
-- review) It keeps the CRM time of every message a cache row holds when it runs: a message
-- written to the cache with the triggers off is kept by the apply, and its time stays after
-- the cache row is gone. When the lead cutoff (20261007010000) has replaced three of these
-- bodies since, it is rolled back first inside this transaction, so the re-apply starts from
-- this migration's own bodies. (And the scoping pipeline, 20261009133000, which replaced three of
-- the lead cutoff's bodies since, before it: the lead cutoff's down refuses while a later body is live.)
SELECT to_regprocedure('public.context_lead_window_hours(text)') IS NOT NULL AS scoping_pipeline_live \gset
SELECT coalesce(obj_description(to_regprocedure('public.context_lead_monitored_jobs(uuid[],timestamptz)'), 'pg_proc'), '')
       LIKE 'Lead cutoff (20261007010000)%' AS lead_cutoff_live \gset
-- (and before it the notes freshness, 20261009132000, which replaced the lead cutoff's judge and this
-- migration's ledger read since: the lead cutoff's down refuses while it is live)
SELECT coalesce(obj_description(to_regprocedure('public.context_ledger_row_unread(timestamptz,boolean,timestamptz)'), 'pg_proc'), '')
       LIKE 'Notes freshness (20261009132000)%' AS notes_freshness_live \gset
BEGIN;
\if :scoping_pipeline_live
\ir ../../../rollbacks/20261009133000_context_scoping_pipeline_down.sql
\endif
\if :notes_freshness_live
\ir ../../../rollbacks/20261009132000_context_notes_freshness_down.sql
\endif
\if :lead_cutoff_live
\ir ../../../rollbacks/20261007010000_context_lead_cutoff_down.sql
\endif
CREATE TEMP TABLE story_safety_md5 AS
 SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('context_job_record_legacy_mail', 'context_job_record_messages',
  'context_job_record_timeline', 'context_job_record_loops', 'context_job_record_money', 'context_job_record_contact', 'context_job_story_facts',
  'context_job_story_meta', 'context_job_story_assemble', 'context_client_story', 'context_ledger_evidence_rows', 'context_ledger_cite',
  'context_ledger_judge', 'context_job_record_crm_time', 'context_job_record_payer_role', 'context_job_record_bill_share', 'context_job_record_value',
  'context_job_story_day', 'context_ledger_mail_rule_since', 'context_ledger_mail_copies', 'context_crm_message_times_keep',
  'context_job_story_ledger');
SET LOCAL session_replication_role = replica;
INSERT INTO public.ghl_conversation_cache (contact_id, job_id, messages, synced_at)
VALUES ('ct40snap', NULL, '[{"id":"m40-snap","timestamp":"2026-05-05T05:05:00.000Z","direction":"inbound"}]', '2026-05-06 01:00Z');
SET LOCAL session_replication_role = origin;
\ir ../../../migrations/20261006040000_context_story_safety.sql
DELETE FROM public.ghl_conversation_cache WHERE contact_id = 'ct40snap';
DO $again$
BEGIN
 IF (SELECT count(*) FROM story_safety_md5) <> 22 OR EXISTS (SELECT 1 FROM story_safety_md5 x JOIN pg_proc p ON p.oid = x.sig::regprocedure
       WHERE md5(p.prosrc) IS DISTINCT FROM x.m OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM x.c) THEN
  RAISE EXCEPTION 'story safety contract: a re-apply must change nothing';
 END IF;
 IF public.context_job_record_crm_time('ghl_sms_cache_backfill', 'ct40snap', 'm40-snap', NULL) IS DISTINCT FROM '2026-05-05 05:05Z'::timestamptz THEN
  RAISE EXCEPTION 'story safety contract: an apply keeps the CRM time of every message the cache holds then';
 END IF;
END $again$;
ROLLBACK;
