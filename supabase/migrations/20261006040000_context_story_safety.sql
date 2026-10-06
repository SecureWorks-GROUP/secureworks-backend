-- Story safety (6 Oct 2026): the job story is safe to switch on with the reader off.
--
-- Why. A records-only grade of the job story on the 29 proof jobs (no reader
-- ledger) found 12 unsafe lines on 10 jobs (the bar is 0) and the first line right
-- on 0 of 29. Every cause below was measured read-only on production; each fix has a
-- contract case that fails on the earlier bodies.
--
--  1. False all-clear. With no reader ledger the first line said "Nothing open on
--     record", nobody's move (523 of 859 live jobs). Until a live (promoted)
--     reading has read every row on a job (none landed after it), the story now says
--     "Whose move is unclear:" first, then that no record item is open (or due yet)
--     and the messages are not yet checked for promises or requests (a live reading
--     that lags: how many newer messages, calls, notes or documents, ours included,
--     it has not checked), with the newest customer message and our last reply, the
--     job's own or this customer's placed on no job yet or withheld, naming where it
--     sits (with neither anywhere it says so and claims nothing unchecked); whose move
--     is unknown. With no live reading handling.commitments is empty (null). A shadow
--     reading counts as read only when the story is asked for it by id (the default
--     view never shows one), so a grade reads the line its promotion gives; a building
--     or failed one never does. Even a reading that has read every row on the job gives
--     no all-clear while the customer's newest message is off the job (placed on no job
--     yet, or withheld): the line names it, unchecked (sixth review).
--  2. Mail dropped. An old-inbox email was dropped whenever its saved copy existed
--     anywhere (220 emails on 42 live jobs: 144 copies unplaced, 76 on another job;
--     82 from the customer's address). It is dropped only for a copy on the same
--     job: in the story (context_job_record_legacy_mail), in the reader's evidence
--     (context_ledger_evidence_rows) and in the citation check (context_ledger_cite,
--     which only widens for mail: every mail citation it accepted before it still
--     accepts). Each email reaches a job's story and reader once; not_known counts the
--     mail the story shows from the old inbox whose saved copy sits elsewhere, and
--     check C11 says where that copy sits instead of "stored only in the old inbox". A
--     mail brought back this way joined the job's evidence no earlier than this
--     migration's first apply (context_ledger_mail_rule_since) and its saved copy's own
--     landing where it sits (context_ledger_mail_copies, which reads each key by an
--     index: never a payload-index look-up per mail), never when the mail itself
--     landed: so a reading built before then never counts it as read (in the story,
--     the update packet and the judge, whose quick read times it the same way,
--     context_ledger_judge) and the job is due a read.
--  3. Money guards. A paid deposit invoice counts as acceptance. Check C2 is raised
--     for each record that disagrees with the job value (an invoice line's own base,
--     also a line naming the job on an invoice placed elsewhere, a deposit's
--     percentage, the newest sent quote, a final invoice issued below the value, a
--     value from a quote the app has no record of sending, an invoice placed elsewhere
--     while the job's own invoices fall short: on no job or another job naming the job,
--     on no job addressed to its own Xero contact, or on this client's other job of the
--     same kind at the same site address (a duplicate record); a value set from the CRM,
--     source ghl or the import's $1,000.00 placeholder, that no quote backs; the two 972
--     checks unchanged), and then R8 says the value is unconfirmed and states no amount;
--     what the job's own contact owes on an invoice placed on no job is named in the first
--     line, the money and the client story. Before the work is done the final invoice (R8)
--     is not due (loop status not_due), nor while the job is in rectification or reopened
--     work is not finished again, and after it an unconfirmed one is held (status unconfirmed):
--     either ranks last and never leads the first line or the move; the client story
--     lists it after the loops due now. Overdue and due invoices (R1, R2, M1) are owed by whoever they are
--     addressed to: the customer (the builder on builder work), else a neighbour or
--     another payer, owner third_party. The first line names the top item of the
--     party whose move it is, never another party's (the customer's move never names
--     a neighbour's invoice), and names who owes each invoice ("owed by") whenever a
--     neighbour or another payer owes it, with their role, whatever the move (so their
--     invoice never reads as the customer's beside our move). A quote waiting reads as
--     waiting on the customer, never "the customer owes: Quote", and one the customer
--     was in touch about since it was sent in a way that does not close it (an answered
--     call, old-inbox mail, a message placed on no job whatever its attribution status, one
--     on their other job, withheld mail) leaves whose move unclear and names that contact;
--     it is a loop only while the job is quoted, and a check once the work is done or a
--     later job of theirs at the same address is accepted. A missed call of theirs placed
--     on no job with nothing from us since is our move (R4). A draft whose stage issued
--     split invoices already reach is a check, never our move. A supplier bill whose lines
--     name other jobs says it is shared and gives this job's lines.
--  4. Who and when. A CRM text loaded later from the CRM's cache (197 texts on 30
--     live jobs, a median 7.8 days late; and 75 placed on no job yet that 22 live jobs
--     read as their customer's, up to 87 days late) is timed by the CRM's own time, in the
--     story (on the job or placed on no job), the reader's evidence and the citation check.
--     The cache holds only a contact's newest messages and each sync writes its row over,
--     so the time is kept when the cache holds it (context_crm_message_times, filled by a
--     trigger on each cache write and once from every cache row here); a text whose CRM
--     time was never kept is time unknown, never its load time: never the customer's,
--     never the reader's evidence, never cited (sixth review). A text the CRM dates more than 30 days
--     before the job was created (before its lead window) is never the customer's last
--     word, first contact or contact since a quote, and is not the reader's evidence
--     (left out of it, and refused as a citation; 15 texts on 1 live job). A text the
--     customer sent before a quote is never contact since it, however late it was
--     loaded. A booking change on a ghost or observer row is an observer copy, never
--     "Booking made" (23 lines on 15 live jobs). Work is done only on a completion
--     status, a completion record (on builder work also the make-safe stage set to
--     complete or the pack-sent note staff wrote; a status history that entered a
--     completion status) or a report pack sent, never because the newest booking is
--     complete; after a make-safe re-attend only a record since it counts. On builder
--     work the builder is the customer.
--  5. The first line names what the records show: each invoice owing with its number
--     and due date (and its payer whenever that is not the customer, or when more than
--     one party owes), a passed booking with no
--     attendance, a report pack sent, a quote declined, and the newest unread words
--     of the customer (a pause, a decline or a new request reads in their words), said
--     to be "not yet checked by the reader" (the owner's words, never "not read yet").
--  6. An automated send was dropped when it was the only thing sent to the customer
--     (NULL || jsonb). It is now last_to_customer {newer_automated, only_automated}
--     (no live job today: automated money texts are off).
--  7. The client story counts what the client's own Xero contact owes as a payer on
--     another client's private job (one live case): only invoices still owing, never
--     on builder work, and a job's only paying contact is the client's own only when
--     it is named as the client and never pays on builder work (a builder billed for a
--     homeowner's job is never the homeowner). Its owing is only what the client owes:
--     the invoices on their jobs addressed to them, never the builder's on builder
--     work, a neighbour's or another payer's (owed_by_others, named in not_known).
--
-- Not changed: the ledger store's closing rules and everything the reader writes;
-- every other body of PRs 966, 972 and 975; any function an open PR (977, 979, 980)
-- replaces. Every signature, volatility, owner and grant stays, and each
-- comment keeps its slice name first.
--
-- Replaced bodies (guarded on the md5 each has after 20261006033000 applies):
--   context_job_record_legacy_mail, context_job_record_messages,
--   context_job_record_timeline, context_job_record_loops, context_job_record_money,
--   context_job_record_contact (the record layer), context_job_story_facts,
--   context_job_story_meta, context_job_story_assemble, context_client_story (the
--   story), context_ledger_evidence_rows, context_ledger_cite (the store's legacy
--   mail rule only), context_ledger_judge (its quick read of legacy mail only).
-- Added helpers: context_job_record_crm_time, context_job_record_payer_role,
--   context_job_record_bill_share, context_job_record_value, context_job_story_day,
--   context_ledger_mail_rule_since (this migration's first apply time, written once),
--   context_ledger_mail_copies; and (sixth review) the table context_crm_message_times
--   with its trigger context_crm_message_times_keep on ghl_conversation_cache (the one
--   write path this migration adds: it never fails a cache write).
-- Query shape: the same reads, plus the CRM cache for backfilled texts only (in the
-- story, the reader's evidence and a citation of one), one read of the job's parties
-- per invoice, and the job's makesafe details; the reader's evidence and the judge
-- also read each legacy mail's saved copies by four indexed keys (source pointer,
-- graph key, its sender's mail at its instant, and the payload key at its instant).
-- Fourth review: the job value reads the customer invoices placed elsewhere for the job's
-- number only while its own issued invoices fall short of its accepted value (when R8
-- would fire); the loops and the story meta read this customer's messages placed on no
-- job yet (context_unplaced_for_job, as not_known already did; the CRM cache for a
-- backfilled text among them) and the loops their withheld mail; the story facts read the
-- job's make-safe stage and status history. Sixth review: the job value also reads, while
-- R8 would fire, invoices on no job by the job's own Xero contact and this client's other
-- jobs at the same site; the loops and the story meta read this customer's rows placed on no
-- job whatever their attribution status (and the loops their rows on their other jobs), by
-- the CRM contact index; the story meta reads invoices on no job by the job's own Xero
-- contact; the CRM time reads context_crm_message_times first.
-- Rollback: supabase/rollbacks/20261006040000_context_story_safety_down.sql (the
-- earlier bodies word for word; the helpers and the trigger dropped; the table of kept CRM
-- times kept, rows and all, since nothing else holds them once the cache is written over).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Guard. Each body replaced here must be the one the stack has after 20261006033000
-- (972, 975 or 033000's, md5 of prosrc, read from production read-only on 6 Oct 2026
-- for the live ones and from a local cluster after 033000 applies for 033000's) or
-- this migration's own (a re-apply is a no-op); anything else is someone else's change
-- and is refused, never overwritten. The helpers it adds must be absent or its own, and
-- every table, column and function the new bodies read must exist. (The judge's 972
-- md5 was read from production read-only on 6 Oct 2026 too.)
DO $guard$
DECLARE problems text[] := '{}'; x record; live text; f text; t text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_job_record_legacy_mail(uuid[],timestamptz)', ARRAY['e2d1d12725fe4e544971f50f9fe16105', 'fd6cc9dade4cd2dd1582d354fa46a299']),
  ('public.context_job_record_messages(uuid[],timestamptz)', ARRAY['805d8ae8acb9add8f6e3c4cc08813287', '9a7e7257af23c0a61375a947b895927f']),
  ('public.context_job_record_timeline(uuid[],timestamptz)', ARRAY['f827ec9418fc843470e793c09a55612e', '0921f25dfb5a67ab04629d2977e9f0a6']),
  ('public.context_job_record_loops(uuid[],timestamptz)', ARRAY['47a6a646655f7110ff52be8e90846599', '21cc2c3a6e7d0379f5baaab13c1e9a65']),
  ('public.context_job_record_money(uuid[],timestamptz)', ARRAY['33c032c9f111f74fbd7ad0e267bed33e', '152c423ec224be8d3ac48790b7d14cd6']),
  ('public.context_job_record_contact(uuid[],timestamptz)', ARRAY['698b3753ab5e1ffa6441a7ef6cbb13e5', '4b8d2c65d3ce03d71f2d0e24f4401471']),
  ('public.context_job_story_facts(uuid,timestamptz)', ARRAY['98cc171009db7051a681ae3a28785518', 'eefb06ac74932d26974411b5815ef088']),
  ('public.context_job_story_meta(uuid,timestamptz)', ARRAY['e7bdb045dc47859e1c03096724737c0d', '79723b6d704128731ae940e102df5bb5']),
  ('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)', ARRAY['aab2d2eb593890b297f6d13a486f6aa0', '0d8517fbc571bdd04bfd4ea75d47a77e']),
  ('public.context_client_story(uuid,timestamptz)', ARRAY['cc4a2ce461deeb17653cd94b714bbf78', 'a362a79d0ce92295f509f6e1b0f0ba66']),
  ('public.context_ledger_evidence_rows(uuid[],timestamptz)', ARRAY['617cc62989572be3e0537e65bf21284c', 'b3430566eb6bac0655a9cfa4284d22c8']),
  ('public.context_ledger_cite(uuid,jsonb)', ARRAY['25a55a28508d0b1df609e6fe4fb00661', '954c80518722f62d190bd75b589065a3']),
  ('public.context_ledger_judge(uuid[])', ARRAY['1cabd1e254cdb11b26c61a992b8d9744', '511794bd25c94ca8f0e0f1bbbfbf03eb'])
 ) v(sig, accepted) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY (x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_job_record_crm_time(text,text,text,uuid)', 'public.context_job_record_payer_role(uuid,text,text,text,uuid)', 'public.context_job_record_bill_share(text,jsonb,text)', 'public.context_job_record_value(uuid[],timestamptz)', 'public.context_job_story_day(date,date)',
   'public.context_ledger_mail_rule_since()', 'public.context_ledger_mail_copies(uuid[])', 'public.context_crm_message_times_keep()'] LOOP
  IF to_regprocedure(f) IS NOT NULL AND coalesce(obj_description(to_regprocedure(f), 'pg_proc'), '') NOT LIKE 'Story safety (20261006040000)%' THEN
   problems := problems || format('%s exists and is not this migration''s', f);
  END IF;
 END LOOP;
 -- (sixth review) the table that keeps CRM message times, and its trigger on the cache: absent or ours
 IF to_regclass('public.context_crm_message_times') IS NOT NULL
    AND coalesce(obj_description(to_regclass('public.context_crm_message_times'), 'pg_class'), '') NOT LIKE 'Story safety (20261006040000)%' THEN
  problems := problems || 'public.context_crm_message_times exists and is not this migration''s'::text;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = to_regclass('public.ghl_conversation_cache') AND tg.tgname = 'context_crm_message_times_keep'
              AND tg.tgfoid IS DISTINCT FROM to_regprocedure('public.context_crm_message_times_keep()')) THEN
  problems := problems || 'trigger context_crm_message_times_keep on public.ghl_conversation_cache exists and is not this migration''s'::text;
 END IF;
 FOREACH f IN ARRAY ARRAY['public.job_quote_values(uuid)', 'public.context_job_record_date(text)', 'public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)',
   'public.context_job_story_ledger(uuid,uuid,timestamptz)', 'public.context_ledger_row_admissible(public.business_events)',
   'public.context_linked_status(text)', 'public.context_unplaced_for_job(uuid)', 'public.context_address_key(text)',
   'public.context_event_text(public.business_events)', 'public.context_internal_text_role(public.business_events)'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['ghl_conversation_cache.contact_id', 'ghl_conversation_cache.messages', 'ghl_conversation_cache.synced_at',
   'makesafe_job_details.requesting_company_name', 'makesafe_job_details.job_id', 'xero_invoices.line_items', 'xero_invoices.job_contact_id',
   'xero_invoices.xero_contact_id', 'xero_invoices.raw_json', 'jobs.xero_contact_id', 'jobs.deposit_invoice_id', 'jobs.completed_at',
   'job_contacts.xero_contact_id', 'job_contacts.removed_at', 'job_contacts.is_primary', 'job_contacts.contact_type',
   'business_events.provider_message_id', 'business_events.contact_id', 'job_events.detail_json', 'job_assignments.is_ghost',
   'job_assignments.role', 'inbox_events.graph_message_id', 'inbox_events.processed_at', 'business_events.attributed_at',
   'business_events.context_captured_at', 'business_events.source_table', 'business_events.source_id',
   'business_events.attribution_status', 'ghl_conversation_cache.id', 'jobs.site_address', 'jobs.metadata', 'jobs.pricing_json',
   'xero_invoices.amount_due', 'xero_invoices.synced_at'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || split_part(t, '.', 1))
                 AND a.attname = split_part(t, '.', 2) AND NOT a.attisdropped) THEN
   problems := problems || format('public.%s missing', t);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_story_safety_preimage_mismatch: %; read the live definitions before replacing them',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The CRM's own time of a CRM text loaded later from its cache (source
-- ghl_sms_cache_backfill): the loader stamped the load time instead. The conversation
-- cache holds each message's own timestamp, but only for a contact's newest messages (about
-- 30), and every sync writes its row over, so a text drops out of it (sixth review: 80 of
-- the 1,181 backfilled texts had dropped out by 6 Oct). So the time is kept where no sync
-- overwrites it:
-- (a) context_crm_message_times: one row per CRM message id the cache has held, with its
--     own time, filled now from every cache row and then by a trigger on each cache write
--     (append only: a message keeps the first time seen; the trigger never fails the
--     cache write, it only warns);
-- (b) context_job_record_crm_time reads that first, then the cache: the message by its CRM
--     id in the cache row of the text's own contact, else a cache row of its job, else any
--     cache row (each id sits in one row; 28 of the 241 live rows carry no contact).
-- A backfilled text whose CRM time is in neither is time unknown, never the load time: its
-- callers keep it off the customer's side, out of the reader's evidence and the citations.
-- One bad cache row never fails a story or a cache write (anything not a full ISO time
-- with a zone, or not a real date, reads as no time).
CREATE TABLE IF NOT EXISTS public.context_crm_message_times (
 ghl_message_id text PRIMARY KEY,
 contact_id text,
 crm_at timestamptz NOT NULL,
 kept_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.context_crm_message_times IS
 'Story safety (20261006040000), sixth review: the CRM''s own time of every CRM message the conversation cache (ghl_conversation_cache) has held, one row per CRM message id (crm_at, its contact, kept_at when first kept), so a CRM text loaded later from the cache keeps its CRM time after a sync writes the cache row over (the cache holds only a contact''s newest messages). Filled once from every cache row by this migration, then by the trigger context_crm_message_times_keep on each cache write; append only (a message keeps the first time seen). Read first by context_job_record_crm_time. RLS on, no policy; service role reads.';
ALTER TABLE public.context_crm_message_times ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_crm_message_times FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.context_crm_message_times TO service_role;

CREATE OR REPLACE FUNCTION public.context_crm_message_times_keep()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
BEGIN
 -- the cache write never fails for this: a message it cannot keep now is kept on a later write
 BEGIN
  INSERT INTO public.context_crm_message_times (ghl_message_id, contact_id, crm_at)
  SELECT DISTINCT ON (btrim(m.v ->> 'id')) btrim(m.v ->> 'id'), NEW.contact_id, (m.v ->> 'timestamp')::timestamptz
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.messages) = 'array' THEN NEW.messages ELSE '[]'::jsonb END) AS m(v)
  WHERE jsonb_typeof(m.v) = 'object' AND nullif(btrim(m.v ->> 'id'), '') IS NOT NULL
    AND (m.v ->> 'timestamp') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]{1,6})?)?(Z|[+-]([01][0-9]|2[0-3]):?[0-5][0-9])$'
    AND public.context_job_record_date(m.v ->> 'timestamp') IS NOT NULL
  ORDER BY btrim(m.v ->> 'id')
  ON CONFLICT (ghl_message_id) DO NOTHING;
 EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'context_crm_message_times_keep: % (%), the CRM times of contact % were not kept on this write', SQLERRM, SQLSTATE, NEW.contact_id;
 END;
 RETURN NULL;
END
$fn$;
COMMENT ON FUNCTION public.context_crm_message_times_keep() IS
 'Story safety (20261006040000), sixth review: trigger on ghl_conversation_cache (after insert, or an update of messages): keeps each message''s CRM id and own time (a full ISO time with a zone on a real date) in context_crm_message_times, a message already kept untouched. Never fails the cache write: any error is a warning and the times are kept on a later write. Service role only.';
CREATE OR REPLACE TRIGGER context_crm_message_times_keep
 AFTER INSERT OR UPDATE OF messages ON public.ghl_conversation_cache
 FOR EACH ROW EXECUTE FUNCTION public.context_crm_message_times_keep();

-- What every cache row holds now (the texts still in it; a re-apply only adds new ones).
INSERT INTO public.context_crm_message_times (ghl_message_id, contact_id, crm_at)
SELECT DISTINCT ON (btrim(m.v ->> 'id')) btrim(m.v ->> 'id'), c.contact_id, (m.v ->> 'timestamp')::timestamptz
FROM public.ghl_conversation_cache c
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.messages) = 'array' THEN c.messages ELSE '[]'::jsonb END) AS m(v)
WHERE jsonb_typeof(m.v) = 'object' AND nullif(btrim(m.v ->> 'id'), '') IS NOT NULL
  AND (m.v ->> 'timestamp') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]{1,6})?)?(Z|[+-]([01][0-9]|2[0-3]):?[0-5][0-9])$'
  AND public.context_job_record_date(m.v ->> 'timestamp') IS NOT NULL
ORDER BY btrim(m.v ->> 'id'), c.synced_at DESC NULLS LAST, c.id
ON CONFLICT (ghl_message_id) DO NOTHING;

-- (b) The CRM time of one text. Plain SQL with no SET (it has subqueries, so it is not
-- inlined); its callers ask only for backfilled rows.
CREATE OR REPLACE FUNCTION public.context_job_record_crm_time(p_source text, p_contact_id text, p_message_id text, p_job_id uuid)
RETURNS timestamptz
LANGUAGE sql STABLE
AS $fn$
 SELECT CASE WHEN p_source = 'ghl_sms_cache_backfill' AND nullif(btrim(p_message_id), '') IS NOT NULL THEN
  coalesce(
   -- the time kept when the cache held it (sixth review), whatever the cache holds now
   (SELECT k.crm_at FROM public.context_crm_message_times k WHERE k.ghl_message_id = btrim(p_message_id)),
   (SELECT (m.v ->> 'timestamp')::timestamptz
    FROM public.ghl_conversation_cache c
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.messages) = 'array' THEN c.messages ELSE '[]'::jsonb END) AS m(v)
    WHERE c.contact_id = p_contact_id AND m.v ->> 'id' = p_message_id
      AND (m.v ->> 'timestamp') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]{1,6})?)?(Z|[+-]([01][0-9]|2[0-3]):?[0-5][0-9])$'
      AND public.context_job_record_date(m.v ->> 'timestamp') IS NOT NULL
    ORDER BY c.synced_at DESC NULLS LAST, c.id LIMIT 1),
   (SELECT (m.v ->> 'timestamp')::timestamptz
    FROM public.ghl_conversation_cache c
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.messages) = 'array' THEN c.messages ELSE '[]'::jsonb END) AS m(v)
    WHERE c.job_id = p_job_id AND m.v ->> 'id' = p_message_id
      AND (m.v ->> 'timestamp') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]{1,6})?)?(Z|[+-]([01][0-9]|2[0-3]):?[0-5][0-9])$'
      AND public.context_job_record_date(m.v ->> 'timestamp') IS NOT NULL
    ORDER BY c.synced_at DESC NULLS LAST, c.id LIMIT 1),
   (SELECT (m.v ->> 'timestamp')::timestamptz
    FROM public.ghl_conversation_cache c
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.messages) = 'array' THEN c.messages ELSE '[]'::jsonb END) AS m(v)
    WHERE c.messages @> jsonb_build_array(jsonb_build_object('id', p_message_id)) AND m.v ->> 'id' = p_message_id
      AND (m.v ->> 'timestamp') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]{1,6})?)?(Z|[+-]([01][0-9]|2[0-3]):?[0-5][0-9])$'
      AND public.context_job_record_date(m.v ->> 'timestamp') IS NOT NULL
    ORDER BY c.synced_at DESC NULLS LAST, c.id LIMIT 1)) END
$fn$;
COMMENT ON FUNCTION public.context_job_record_crm_time(text, text, text, uuid) IS
 'Story safety (20261006040000): the CRM''s own time of a CRM text loaded later from its conversation cache (source ghl_sms_cache_backfill): the time kept for that CRM message id in context_crm_message_times (sixth review: kept when the cache held it, so a cache sync that writes the row over never loses it), else the cache''s timestamp for it, from the cache row of the text''s own contact, else a cache row of its job, else any cache row; null when none (its callers then treat the text as time unknown, never as the load time). Anything not a full ISO time with a zone on a real date reads as null, so one bad cache row never fails a story. Other sources: null. Read by context_job_record_messages, context_job_record_loops (this customer''s messages placed on no job or on their other jobs), context_job_story_meta (the job''s lanes and its messages placed on no job), context_ledger_evidence_rows and context_ledger_cite. Service role only.';

-- 2. Who an invoice is addressed to, in the job's terms: builder work (make-safe,
-- repair, insurance) is billed to the builder, the job's customer; else a party
-- on the job (job_contacts, by the invoice's party link, else its Xero contact):
-- the primary party is the customer, a neighbour or strata party is named so;
-- else a Xero contact other than the job's own is another payer; else the
-- customer. Plain SQL with no SET (a subquery, so not inlined).
CREATE OR REPLACE FUNCTION public.context_job_record_payer_role(p_job_id uuid, p_job_type text, p_job_xero_contact text,
 p_invoice_contact text, p_invoice_party uuid)
RETURNS text
LANGUAGE sql STABLE
AS $fn$
 SELECT CASE
  WHEN p_job_type IN ('makesafe', 'repair', 'insurance') THEN 'builder'
  WHEN pc.id IS NOT NULL THEN
   CASE WHEN coalesce(pc.is_primary, false) OR coalesce(pc.contact_type, '') = 'primary' THEN 'customer'
        WHEN coalesce(pc.contact_type, '') ILIKE 'neighbour%' THEN 'neighbour'
        WHEN coalesce(pc.contact_type, '') ILIKE 'strata%' THEN 'strata'
        ELSE 'other_party' END
  WHEN nullif(btrim(p_job_xero_contact), '') IS NOT NULL AND nullif(btrim(p_invoice_contact), '') IS NOT NULL
       AND btrim(p_invoice_contact) <> btrim(p_job_xero_contact) THEN 'other_payer'
  ELSE 'customer' END
 FROM (SELECT 1) one
 LEFT JOIN LATERAL (
  SELECT c.id, c.is_primary, c.contact_type FROM public.job_contacts c
  WHERE c.job_id = p_job_id AND c.removed_at IS NULL
    AND (c.id = p_invoice_party OR (nullif(btrim(p_invoice_contact), '') IS NOT NULL AND btrim(c.xero_contact_id) = btrim(p_invoice_contact)))
  ORDER BY (c.id = p_invoice_party) DESC NULLS LAST, coalesce(c.is_primary, false) DESC, c.created_at, c.id
  LIMIT 1) pc ON true
$fn$;
COMMENT ON FUNCTION public.context_job_record_payer_role(uuid, text, text, text, uuid) IS
 'Story safety (20261006040000): who a customer invoice is addressed to, in the job''s terms: builder (make-safe, repair and insurance work is billed to the builder, the job''s customer); customer (the job''s primary party, or no party and the job''s own Xero contact or none); neighbour, strata or other_party (a non-primary party on job_contacts, by the invoice''s job_contact_id, else its Xero contact); other_payer (a Xero contact other than the job''s own, with no party row). Read by the record loops (R1, R2, M1), the money rows and the client story. Service role only.';

-- 3. A supplier bill shared across jobs: its lines name job numbers. The bill is
-- shared when a line names another job; this job's share is the lines that name
-- it (inc GST when the bill's amounts exclude tax). Pure.
CREATE OR REPLACE FUNCTION public.context_job_record_bill_share(p_job_number text, p_line_items jsonb, p_amount_types text)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $fn$
 SELECT CASE WHEN coalesce(x.other, false)
             THEN jsonb_build_object('shared', true, 'job_share', round(x.mine_amt, 2), 'job_lines', x.mine_n)
             ELSE jsonb_build_object('shared', false) END
 FROM (
  SELECT bool_or(t.other) AS other, sum(t.amt) FILTER (WHERE t.mine) AS mine_amt, count(*) FILTER (WHERE t.mine) AS mine_n
  FROM (
   SELECT EXISTS (SELECT 1 FROM regexp_matches(coalesce(li ->> 'Description', ''), '(SW[A-Z]{0,4}-[0-9]+)', 'gi') r
                  WHERE upper(r[1]) <> upper(b.base)) AS other,
          EXISTS (SELECT 1 FROM regexp_matches(coalesce(li ->> 'Description', ''), '(SW[A-Z]{0,4}-[0-9]+)', 'gi') r
                  WHERE upper(r[1]) = upper(b.base)) AS mine,
          CASE WHEN jsonb_typeof(li -> 'LineAmount') = 'number' THEN (li ->> 'LineAmount')::numeric ELSE 0 END
          + CASE WHEN p_amount_types = 'Exclusive' AND jsonb_typeof(li -> 'TaxAmount') = 'number' THEN (li ->> 'TaxAmount')::numeric ELSE 0 END AS amt
   FROM (SELECT substring(coalesce(p_job_number, '') FROM '^(SW[A-Za-z]{0,4}-[0-9]+)') AS base) b
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p_line_items) = 'array' THEN p_line_items ELSE '[]'::jsonb END) li
   WHERE b.base IS NOT NULL
  ) t
 ) x
$fn$;
COMMENT ON FUNCTION public.context_job_record_bill_share(text, jsonb, text) IS
 'Story safety (20261006040000): whether a supplier bill is shared across jobs, from its Xero lines: {shared: true, job_share, job_lines} when a line names another job number (SW...-digits), job_share being the lines that name this job (inc GST when the bill''s amounts exclude tax; null when no line names it); else {shared: false}. A job number not in that form gives shared false. Pure. Service role only.';

-- 4. The job value and whether the records agree with it: one reading for the
-- record loops (R8, C2) and the money rows. Accepted: the job row's acceptance,
-- an accepted quote, or a paid deposit invoice (a deposit invoice: reference
-- DEP<n>, a line about a deposit, or the job's deposit invoice; paid: PAID, or a
-- payment on it, by p_as_of). checks: every way the records disagree with the
-- job value, each a C2 check (two kept word for word from 972, six new, the new
-- ones only on an accepted job): the accepted quote, invoices above the value,
-- an invoice line's own base ("50% of $12,000.00", also a line naming this job on an
-- invoice placed elsewhere), a deposit's percentage, the newest sent quote, a final
-- invoice issued below the value, a value taken from a quote the app has no record of
-- sending, an invoice placed elsewhere while this job's own issued invoices fall short of
-- the value (on no job or another job naming this job; sixth review: on no job addressed
-- to this job's own Xero contact, or on this client's other job of the same kind at the
-- same site address), and (sixth review) a value set from the CRM (pricing_json.source
-- ghl, or the import's $1,000.00 placeholder) that no quote on the job backs. Any check
-- makes the value unconfirmed. Plain SQL with no SET, read inside the definer record
-- functions.
CREATE OR REPLACE FUNCTION public.context_job_record_value(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, value numeric, value_basis text, accepted boolean, accepted_at timestamptz, accepted_by text,
 issued numeric, checks jsonb)
LANGUAGE sql STABLE
AS $fn$
 WITH j AS (
  SELECT jb.id, nullif(btrim(jb.deposit_invoice_id), '') AS dep_inv,
         CASE WHEN jb.accepted_at <= p_as_of THEN jb.accepted_at END AS job_acc,
         CASE WHEN jsonb_typeof(jb.pricing_json->'totalIncGST') = 'number' THEN (jb.pricing_json->>'totalIncGST')::numeric END AS price_inc,
         jb.quoted_value, jb.created_at,
         -- the job number as invoices name it (SW...-digits; another form names no job)
         upper(substring(coalesce(jb.job_number, '') FROM '^(SW[A-Za-z]{0,4}-[0-9]+)')) AS jnum,
         -- (sixth review) where the value came from, the job's kind of work, its own Xero
         -- contact, its client (CRM contact, client email) and its site
         nullif(btrim(jb.pricing_json ->> 'source'), '') AS psrc, jb.type::text AS jtype,
         nullif(btrim(jb.xero_contact_id), '') AS jxc, nullif(btrim(jb.ghl_contact_id), '') AS ccontact,
         lower(nullif(btrim(jb.client_email), '')) AS cmail, jb.site_address
  FROM public.jobs jb WHERE jb.id = ANY (p_job_ids)
 ),
 jv AS (  -- job value exactly as the reference: price_inc, else quoted_value (zero counts as none)
  SELECT j.*,
         CASE WHEN coalesce(j.price_inc, 0) <> 0 THEN j.price_inc WHEN coalesce(j.quoted_value, 0) <> 0 THEN j.quoted_value END AS value,
         CASE WHEN coalesce(j.price_inc, 0) <> 0 THEN 'pricing_json.totalIncGST' WHEN coalesce(j.quoted_value, 0) <> 0 THEN 'jobs.quoted_value' END AS basis
  FROM j
 ),
 qd AS (  -- quote documents as the reference reads them (type contains "quote"), stamps after p_as_of unset
  SELECT d.id, d.job_id, d.quote_number, d.version, d.created_at,
         CASE WHEN d.sent_at <= p_as_of THEN d.sent_at END AS sent_at,
         CASE WHEN d.accepted_at <= p_as_of THEN d.accepted_at END AS accepted_at,
         CASE WHEN d.declined_at <= p_as_of THEN d.declined_at END AS declined_at,
         CASE WHEN d.superseded_at <= p_as_of THEN d.superseded_at END AS superseded_at
  FROM public.job_documents d
  WHERE d.job_id = ANY (p_job_ids) AND d.type ILIKE '%quote%' AND d.created_at <= p_as_of
 ),
 si AS (  -- customer invoices by p_as_of (deleted and voided never count) and what their lines say
  SELECT x.id, x.job_id, x.invoice_number, nullif(btrim(x.xero_contact_id), '') AS xc, x.total, x.created_at,
         upper(coalesce(x.status, 'NONE')) AS st,
         coalesce((x.invoice_date::timestamp AT TIME ZONE 'Australia/Perth'), x.created_at) AS at,
         (upper(coalesce(x.status, '')) = 'PAID' OR (upper(coalesce(x.status, '')) IN ('AUTHORISED', 'SUBMITTED') AND coalesce(x.amount_paid, 0) > 0)) AS paid,
         coalesce((x.fully_paid_on::timestamp AT TIME ZONE 'Australia/Perth'), (x.invoice_date::timestamp AT TIME ZONE 'Australia/Perth'), x.created_at) AS paid_at,
         (upper(coalesce(x.reference, '')) ~ '-DEP[0-9]{0,3}(-[A-Z])?$' OR coalesce(ln.dep_word, false)
          OR x.xero_invoice_id = j.dep_inv OR x.id::text = j.dep_inv) AS deposit,
         (upper(coalesce(x.reference, '')) ~ '-(FINBAL|FIN|BAL)[0-9]{0,3}(-[A-Z])?$' OR coalesce(ln.final_word, false)) AS final,
         ln.base, coalesce(ln.pct, substring(upper(coalesce(x.reference, '')) FROM '-DEP([0-9]{1,3})(?:-[A-Z])?$')::numeric) AS pct
  FROM public.xero_invoices x JOIN j ON j.id = x.job_id
  LEFT JOIN LATERAL (
   SELECT bool_or(li ->> 'Description' ~* 'deposit') AS dep_word,
          bool_or(li ->> 'Description' ~* '^\s*(balance|final)') AS final_word,
          -- "Deposit (25% of $10,406.00 inc GST)": the line's own base
          (array_agg(replace((regexp_match(li ->> 'Description', '[0-9]{1,3}(?:\.[0-9]+)?% of \$([0-9][0-9,]*(?:\.[0-9]{1,2})?)'))[1], ',', '')::numeric)
            FILTER (WHERE li ->> 'Description' ~ '[0-9]{1,3}(\.[0-9]+)?% of \$[0-9]'))[1] AS base,
          -- "50% Deposit", "Deposit (50% ..."
          (array_agg(coalesce((regexp_match(li ->> 'Description', '([0-9]{1,3})\s*%\s*deposit', 'i'))[1],
                              (regexp_match(li ->> 'Description', 'deposit\s*\(\s*([0-9]{1,3})(?:\.[0-9]+)?\s*%', 'i'))[1])::numeric)
            FILTER (WHERE li ->> 'Description' ~* '([0-9]{1,3}\s*%\s*deposit|deposit\s*\(\s*[0-9]{1,3}(\.[0-9]+)?\s*%)'))[1] AS pct
   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.line_items) = 'array' THEN x.line_items ELSE '[]'::jsonb END) li) ln ON true
  WHERE x.job_id = ANY (p_job_ids) AND coalesce(x.created_at, x.synced_at, '-infinity'::timestamptz) <= p_as_of
    AND upper(coalesce(x.invoice_type, 'ACCREC')) = 'ACCREC' AND upper(coalesce(x.status, '')) NOT IN ('DELETED', 'VOIDED')
 ),
 acc AS (
  SELECT jv.*,
         (SELECT min(q.accepted_at) FROM qd q WHERE q.job_id = jv.id) AS quote_acc,
         (SELECT min(s.paid_at) FROM si s WHERE s.job_id = jv.id AND s.deposit AND s.paid AND s.paid_at <= p_as_of) AS dep_acc,
         (SELECT sum(coalesce(s.total, 0)) FROM si s WHERE s.job_id = jv.id AND s.st <> 'DRAFT') AS issued
  FROM jv
 ),
 v AS (
  SELECT a.*, (a.job_acc IS NOT NULL OR a.quote_acc IS NOT NULL OR a.dep_acc IS NOT NULL) AS accepted,
         coalesce(a.job_acc, a.quote_acc, a.dep_acc) AS acc_at,
         CASE WHEN a.job_acc IS NOT NULL THEN 'job' WHEN a.quote_acc IS NOT NULL THEN 'quote' WHEN a.dep_acc IS NOT NULL THEN 'deposit' END AS acc_by
  FROM acc a
 ),
 -- (story safety, fourth and sixth review) customer invoices placed elsewhere that may bill
 -- this job, recorded by p_as_of and made no earlier than 30 days before the job, read only
 -- while this job's own issued invoices fall short of its accepted value (when R8 would
 -- fire), so a job billed elsewhere never reads "not yet invoiced" as fact. Each is tied to
 -- the job one way (the first that holds):
 --  names: on no job or another job, its reference or lines name this job's number (base: a
 --         line naming this job that says it is a share, "50% of $748.01");
 --  contact (sixth review): on no job and addressed to this job's own Xero contact (the job's,
 --         or one on its own invoices), so a job with no number is read too (bda6e1de, the rest
 --         of its quote billed to its own contact on an invoice never placed on it); never on
 --         builder work, where every job's contact is the builder (there an invoice must name
 --         the job);
 --  site (sixth review): on this client's other job (CRM contact or client email) of the same
 --         kind at the same site address, a duplicate record of it (SWP-25005's work billed and
 --         paid on SWP-26041, its invoices naming the quote, never the job).
 w AS (SELECT v.* FROM v WHERE v.accepted AND v.value IS NOT NULL AND v.value - coalesce(v.issued, 0) > 1),
 wx AS (  -- this job's own Xero contacts
  SELECT DISTINCT w.id AS job_id, z.x
  FROM w CROSS JOIN LATERAL (SELECT w.jxc AS x UNION SELECT s.xc FROM si s WHERE s.job_id = w.id) z
  WHERE z.x IS NOT NULL AND w.jtype NOT IN ('makesafe', 'repair', 'insurance')
 ),
 ws AS (  -- this client's other jobs of the same kind at the same site address
  SELECT w.id AS job_id, o.id AS other_id
  FROM w JOIN public.jobs o ON o.id <> w.id AND o.type::text = w.jtype
   AND ((w.ccontact IS NOT NULL AND o.ghl_contact_id = w.ccontact)
        OR (w.cmail IS NOT NULL AND o.client_email IS NOT NULL AND lower(btrim(o.client_email)) = w.cmail))
  WHERE public.context_address_key(o.site_address) = public.context_address_key(w.site_address)
     OR nullif(lower(regexp_replace(coalesce(o.site_address, ''), '[^a-zA-Z0-9]+', '', 'g')), '')
        = nullif(lower(regexp_replace(coalesce(w.site_address, ''), '[^a-zA-Z0-9]+', '', 'g')), '')
 ),
 ex AS (
  SELECT y.* FROM (
   SELECT w.id AS job_id, x.id, x.invoice_number, upper(coalesce(x.status, '')) AS st, x.total, x.amount_due,
          coalesce((x.invoice_date::timestamp AT TIME ZONE 'Australia/Perth'), x.created_at) AS at,
          (SELECT o.job_number FROM public.jobs o WHERE o.id = x.job_id) AS on_job, nm.base,
          CASE WHEN nm.names THEN 'names'
               WHEN x.job_id IS NULL AND EXISTS (SELECT 1 FROM wx WHERE wx.job_id = w.id AND wx.x = nullif(btrim(x.xero_contact_id), '')) THEN 'contact'
               WHEN EXISTS (SELECT 1 FROM ws WHERE ws.job_id = w.id AND ws.other_id = x.job_id) THEN 'site' END AS tie
   FROM w
   CROSS JOIN LATERAL (
    SELECT x.* FROM public.xero_invoices x
    WHERE x.job_id IS DISTINCT FROM w.id AND upper(coalesce(x.invoice_type, 'ACCREC')) = 'ACCREC'
      AND upper(coalesce(x.status, '')) IN ('DRAFT', 'AUTHORISED', 'SUBMITTED', 'PAID')
      AND coalesce(x.created_at, x.synced_at, '-infinity'::timestamptz) <= p_as_of
      AND coalesce(x.created_at, x.synced_at, '-infinity'::timestamptz) >= w.created_at - interval '30 days') x
   CROSS JOIN LATERAL (
    SELECT bool_or(true) AS names,
           (array_agg(replace((regexp_match(t.d, '[0-9]{1,3}(?:\.[0-9]+)?% of \$([0-9][0-9,]*(?:\.[0-9]{1,2})?)'))[1], ',', '')::numeric ORDER BY t.o)
             FILTER (WHERE t.d ~ '[0-9]{1,3}(\.[0-9]+)?% of \$[0-9]'))[1] AS base
    FROM (SELECT x.reference AS d, 0 AS o
          UNION ALL
          SELECT li ->> 'Description', 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.line_items) = 'array' THEN x.line_items ELSE '[]'::jsonb END) li) t
    -- the whole job number, never a longer one it begins (SWF-2699 is not SWF-26997)
    WHERE w.jnum IS NOT NULL AND strpos(upper(t.d), w.jnum) > 0
      AND EXISTS (SELECT 1 FROM regexp_matches(t.d, '(SW[A-Z]{0,4}-[0-9]+)', 'gi') r WHERE upper(r[1]) = w.jnum)) nm
  ) y
  WHERE y.tie IS NOT NULL
 ),
 c AS (
  -- (972) an accepted quote's value differs from the job value
  SELECT q.job_id, 1 AS p, jsonb_build_object('table', 'job_documents', 'id', q.document_id::text, 'at', q.accepted_at,
          'amount', q.accepted_value - v.value,
          'what', 'Accepted quote value ' || to_char(q.accepted_value, 'FM$999,999,990.00') || ' differs from the job value '
                  || to_char(v.value, 'FM$999,999,990.00') || ' (' || v.basis || ')') AS o
  FROM (SELECT qd.job_id, (array_agg(qd.id ORDER BY qd.accepted_at DESC))[1] AS document_id, max(qd.accepted_at) AS accepted_at,
               sum(qv.value_inc_gst) AS accepted_value, count(qv.value_inc_gst) AS valued, count(*) AS n
        FROM qd
        LEFT JOIN LATERAL (SELECT x.value_inc_gst FROM public.job_quote_values(qd.job_id) x WHERE x.document_id = qd.id LIMIT 1) qv ON true
        WHERE qd.accepted_at IS NOT NULL GROUP BY qd.job_id) q
  JOIN v ON v.id = q.job_id
  WHERE q.valued = q.n AND v.value IS NOT NULL AND abs(q.accepted_value - v.value) > 1
  UNION ALL
  -- (972) issued invoices exceed the job value
  SELECT v.id, 2, jsonb_build_object('table', 'jobs', 'id', v.id::text, 'at', p_as_of, 'amount', s.issued - v.value,
          'what', 'Issued invoices ' || to_char(s.issued, 'FM$999,999,990.00') || ' exceed the job value ' || to_char(v.value, 'FM$999,999,990.00')
                  || ' (' || v.basis || ')')
  FROM v JOIN LATERAL (SELECT sum(coalesce(x.total, 0)) AS issued FROM si x
                       WHERE x.job_id = v.id AND x.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')) s ON true
  WHERE v.value IS NOT NULL AND s.issued > v.value + 1
  UNION ALL
  -- an issued invoice's line names its own base: "Deposit (20% of $12,000.00 inc GST)"; on an
  -- invoice placed elsewhere, a line naming this job ("Remainder of quote SWF-26368 (50% of
  -- $748.01 inc GST)" on another job's invoice; story safety, fourth review)
  SELECT z.job_id, z.p, z.o FROM (
  SELECT DISTINCT ON (s.job_id) s.job_id, 3 AS p, jsonb_build_object('table', 'xero_invoices', 'id', s.id::text, 'at', s.at, 'amount', s.base - v.value,
          'what', 'Invoice ' || coalesce(s.invoice_number, 'without a number')
                  || CASE WHEN s.placed IS NULL THEN ' says it is a share of ' ELSE ' (' || s.placed || ') says this job is a share of ' END
                  || to_char(s.base, 'FM$999,999,990.00') || '; the job value is ' || to_char(v.value, 'FM$999,999,990.00') || ' (' || v.basis || ')') AS o
  FROM (SELECT s.job_id, s.id, s.invoice_number, s.at, s.st, s.base, NULL::text AS placed FROM si s
        UNION ALL
        SELECT e.job_id, e.id, e.invoice_number, e.at, e.st, e.base, coalesce('placed on job ' || e.on_job, 'placed on no job') FROM ex e) s
  JOIN v ON v.id = s.job_id
  WHERE v.accepted AND v.value IS NOT NULL AND s.st IN ('AUTHORISED', 'SUBMITTED', 'PAID') AND s.base IS NOT NULL AND abs(s.base - v.value) > 1
  ORDER BY s.job_id, s.at DESC, s.id) z
  UNION ALL
  -- a deposit's percentage, where no line names the base: every issued deposit invoice
  -- at that percentage, added up, is that share of the price (one paying contact only)
  SELECT z.job_id, z.p, z.o FROM (
  SELECT DISTINCT ON (g.job_id) g.job_id, 4 AS p, jsonb_build_object('table', 'xero_invoices', 'id', g.newest_id::text, 'at', g.at,
          'amount', round(g.implied - v.value, 2),
          'what', 'Deposit invoice ' || coalesce(g.newest_number, 'without a number') || ' is ' || rtrim(to_char(g.pct, 'FM990.99'), '.')
                  || '% of the price, which makes the price ' || to_char(g.implied, 'FM$999,999,990.00') || '; the job value is '
                  || to_char(v.value, 'FM$999,999,990.00') || ' (' || v.basis || ')') AS o
  FROM (SELECT s.job_id, s.pct, round(sum(coalesce(s.total, 0)) / (s.pct / 100), 2) AS implied,
               (array_agg(s.id ORDER BY s.at DESC, s.id))[1] AS newest_id,
               (array_agg(s.invoice_number ORDER BY s.at DESC, s.id))[1] AS newest_number, max(s.at) AS at
        FROM si s
        WHERE s.deposit AND s.base IS NULL AND s.pct > 0 AND s.pct <= 100 AND s.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')
          AND (SELECT count(DISTINCT x.xc) FROM si x WHERE x.job_id = s.job_id AND x.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')) <= 1
        GROUP BY s.job_id, s.pct) g
  JOIN v ON v.id = g.job_id
  WHERE v.accepted AND v.value IS NOT NULL AND abs(g.implied - v.value) > 1
  ORDER BY g.job_id, g.at DESC, g.pct) z
  UNION ALL
  -- the newest sent quote still standing (none accepted) is valued differently
  SELECT q.job_id, 5, jsonb_build_object('table', 'job_documents', 'id', q.id::text, 'at', q.sent_at, 'amount', qv.value_inc_gst - v.value,
          'what', 'The newest sent quote ' || coalesce(q.quote_number, 'without a number') || coalesce(' v' || q.version, '') || ' is '
                  || to_char(qv.value_inc_gst, 'FM$999,999,990.00') || '; the job value is ' || to_char(v.value, 'FM$999,999,990.00')
                  || ' (' || v.basis || ')')
  FROM (SELECT DISTINCT ON (d.job_id) d.* FROM qd d WHERE d.sent_at IS NOT NULL ORDER BY d.job_id, d.sent_at DESC, d.created_at, d.id) q
  JOIN v ON v.id = q.job_id
  CROSS JOIN LATERAL (SELECT x.value_inc_gst FROM public.job_quote_values(q.job_id) x WHERE x.document_id = q.id LIMIT 1) qv
  WHERE v.accepted AND v.value IS NOT NULL AND q.superseded_at IS NULL AND q.declined_at IS NULL AND q.accepted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM qd a WHERE a.job_id = q.job_id AND a.accepted_at IS NOT NULL)
    AND qv.value_inc_gst IS NOT NULL AND abs(qv.value_inc_gst - v.value) > 1
  UNION ALL
  -- a final or balance invoice is issued and the invoices still fall short of the value
  SELECT z.job_id, z.p, z.o FROM (
  SELECT DISTINCT ON (s.job_id) s.job_id, 6 AS p, jsonb_build_object('table', 'xero_invoices', 'id', s.id::text, 'at', s.at,
          'amount', v.issued - v.value,
          'what', 'Final invoice ' || coalesce(s.invoice_number, 'without a number') || ' is issued and the issued invoices total '
                  || to_char(v.issued, 'FM$999,999,990.00') || ', ' || to_char(v.value - v.issued, 'FM$999,999,990.00')
                  || ' less than the job value ' || to_char(v.value, 'FM$999,999,990.00') || ' (' || v.basis || ')') AS o
  FROM si s JOIN v ON v.id = s.job_id
  WHERE v.accepted AND v.value IS NOT NULL AND s.final AND s.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')
    AND v.value - coalesce(v.issued, 0) > 1
  ORDER BY s.job_id, s.at DESC, s.id) z
  UNION ALL
  -- the job has quotes and the app records none sent: the value is a quote's the app
  -- has no record of sending (it may have gone another way: an accepted and paid job can
  -- carry it, so the words never say the quote was not sent)
  SELECT q.job_id, 7, jsonb_build_object('table', 'job_documents', 'id', q.id::text, 'at', q.created_at, 'amount', NULL,
          'what', 'The job value ' || to_char(v.value, 'FM$999,999,990.00') || ' (' || v.basis || ') comes from quote '
                  || coalesce(q.quote_number, 'without a number') || coalesce(' v' || q.version, '')
                  || '; the app has no record of this quote being sent')
  FROM (SELECT DISTINCT ON (d.job_id) d.* FROM qd d ORDER BY d.job_id, d.created_at DESC, d.id) q
  JOIN v ON v.id = q.job_id
  WHERE v.accepted AND v.value IS NOT NULL AND NOT EXISTS (SELECT 1 FROM qd s WHERE s.job_id = q.job_id AND s.sent_at IS NOT NULL)
  UNION ALL
  -- (story safety, fourth and sixth review) an invoice placed elsewhere ties to this job
  -- (ex: it names the job, is on no job addressed to the job's own Xero contact, or is on
  -- this client's other job of the same kind at the same site address) while its own issued
  -- invoices fall short of the value: it may bill this job, so what is left to invoice is
  -- not known (SWF-26997's builder invoice placed on no job; SWF-26368's remainder billed on
  -- a sibling job; bda6e1de's remainder to its own contact on no job; SWP-25005 billed on
  -- its duplicate record SWP-26041)
  SELECT e.job_id, 8, jsonb_build_object('table', 'xero_invoices', 'id', e.id::text, 'at', e.at, 'amount', e.total,
          'what', CASE WHEN e.st = 'DRAFT' THEN 'Draft invoice ' ELSE 'Invoice ' END || coalesce(e.invoice_number, 'without a number')
                  || ' (' || to_char(coalesce(e.total, 0), 'FM$999,999,990.00') || ', ' || lower(e.st)
                  || CASE e.tie
                      WHEN 'names' THEN ') names this job but is placed ' || coalesce('on job ' || e.on_job, 'on no job')
                      WHEN 'contact' THEN CASE WHEN e.st IN ('AUTHORISED', 'SUBMITTED') AND coalesce(e.amount_due, 0) > 0
                                               THEN ', ' || to_char(e.amount_due, 'FM$999,999,990.00') || ' owing' ELSE '' END
                                          || ') is addressed to this job''s Xero contact but is placed on no job'
                      ELSE ') is on job ' || coalesce(e.on_job, 'without a number')
                           || ', this client''s other job of this kind at the same site address' END
                  || '; this job''s own issued invoices total '
                  || to_char(coalesce(v.issued, 0), 'FM$999,999,990.00') || ' against the job value ' || to_char(v.value, 'FM$999,999,990.00')
                  || ' (' || v.basis || ')')
  FROM ex e JOIN v ON v.id = e.job_id
  UNION ALL
  -- (story safety, sixth review) the value was set from the CRM (pricing_json.source ghl: an
  -- opportunity's value; $1,000.00 is the import's placeholder, 477 jobs carry it) and nothing
  -- on the job backs it, no quote and no issued invoice line naming it as its base: what is
  -- left to invoice is not known (bda6e1de: a $1,000.00 value, the rest of a real quote billed
  -- elsewhere)
  SELECT w.id, 9, jsonb_build_object('table', 'jobs', 'id', w.id::text, 'at', w.created_at, 'amount', NULL,
          'what', 'The job value ' || to_char(w.value, 'FM$999,999,990.00') || ' (' || w.basis || ') '
                  || CASE WHEN w.psrc = 'ghl' THEN 'was set from the CRM (pricing_json.source ghl)'
                          ELSE 'is $1,000.00, the CRM import''s placeholder' END
                  || ' and no quote on the job backs it')
  FROM w
  WHERE (w.psrc = 'ghl' OR w.value = 1000)
    AND NOT EXISTS (SELECT 1 FROM qd q WHERE q.job_id = w.id)
    AND NOT EXISTS (SELECT 1 FROM si s WHERE s.job_id = w.id AND s.base IS NOT NULL AND abs(s.base - w.value) <= 1)
 )
 SELECT v.id AS job_id, v.value, v.basis AS value_basis, v.accepted, v.acc_at AS accepted_at, v.acc_by AS accepted_by,
        coalesce(v.issued, 0) AS issued,
        coalesce((SELECT jsonb_agg(c.o || jsonb_build_object('kind', c.p) ORDER BY c.p, c.o ->> 'id' COLLATE "C") FROM c WHERE c.job_id = v.id),
                 '[]'::jsonb) AS checks
 FROM v
$fn$;
COMMENT ON FUNCTION public.context_job_record_value(uuid[], timestamptz) IS
 'Story safety (20261006040000): per job the value (pricing_json.totalIncGST, else jobs.quoted_value; zero is none), whether it is accepted (the job row''s acceptance, an accepted quote, or a paid deposit invoice: reference DEP<n>, a line about a deposit or the job''s deposit invoice, PAID or with a payment, by p_as_of), when and by which, the issued customer invoices, and checks: each way the records disagree with the value (kind 1 the accepted quote and kind 2 invoices above the value, as 972 had them; on an accepted job also kind 3 an invoice line''s own base, or a line naming this job on an invoice placed on no job or on another job, kind 4 a deposit''s percentage with one paying contact, kind 5 the newest sent quote still standing, kind 6 a final invoice issued below the value, kind 7 a value from a quote the app has no record of sending, worded so: it may have gone another way, kind 8 a customer invoice (draft or issued) placed elsewhere while this job''s own issued invoices fall short of the value: on no job or another job whose reference or lines name this job''s number, or (sixth review) on no job addressed to this job''s own Xero contact (the job''s, or one on its own invoices; never on builder work, where every job''s contact is the builder), or on this client''s other job (CRM contact or client email) of the same kind at the same site address; kind 9 (sixth review) a value set from the CRM, pricing_json.source ghl or the import''s $1,000.00 placeholder, that no quote on the job and no issued invoice line naming it as its base backs, while the issued invoices fall short of it), each {table, id, at, amount, what, kind}. Any check makes the value unconfirmed. Read by the record loops (R8, C2) and the money rows. Service role only.';

-- 5. A Perth day in words, like the story's other dates ("Wed 7 Oct"; the year
-- added when it is not the current one). Pure.
CREATE OR REPLACE FUNCTION public.context_job_story_day(p_day date, p_today date)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $fn$
 SELECT to_char(p_day, 'Dy FMDD Mon')
        || CASE WHEN extract(year FROM p_day) <> extract(year FROM p_today) THEN ' ' || extract(year FROM p_day) ELSE '' END
$fn$;
COMMENT ON FUNCTION public.context_job_story_day(date, date) IS
 'Story safety (20261006040000): a Perth day in the story''s words ("Wed 7 Oct", with the year when it is not p_today''s). Pure; read by the story assembler. Service role only.';

-- 6. The record layer.
CREATE OR REPLACE FUNCTION public.context_job_record_legacy_mail(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(jid uuid, cmail text, id uuid, received_at timestamptz, subject text, body_preview text, from_email text,
 graph_message_id text, on_job boolean, placement text)
LANGUAGE sql STABLE
AS $fn$
 WITH j AS (
  SELECT jb.id, lower(nullif(btrim(jb.client_email), '')) AS cmail, jb.created_at,
         -- (two lookups, each on its own jobs index: the CRM contact, the client email)
         (EXISTS (SELECT 1 FROM public.jobs o WHERE o.ghl_contact_id = nullif(btrim(jb.ghl_contact_id), '') AND o.id <> jb.id)
          OR EXISTS (SELECT 1 FROM public.jobs o WHERE o.client_email IS NOT NULL
                     AND lower(btrim(o.client_email)) = lower(nullif(btrim(jb.client_email), '')) AND o.id <> jb.id)) AS repeat_client
  FROM public.jobs jb WHERE jb.id = ANY (p_job_ids)
 ),
 ibx AS (
  SELECT j.id AS jid, j.cmail, i.id, i.received_at, i.subject, i.body_preview, i.from_email, i.graph_message_id,
         (i.job_id = j.id) AS on_job, 'on_job'::text AS placement
  FROM j JOIN public.inbox_events i ON i.job_id = j.id
  UNION ALL
  SELECT j.id, j.cmail, i.id, i.received_at, i.subject, i.body_preview, i.from_email, i.graph_message_id, false,
         CASE WHEN j.repeat_client THEN 'withheld' ELSE 'not_placed' END
  FROM j JOIN public.inbox_events i ON lower(btrim(i.from_email)) = j.cmail
  -- from the client's address only when placed on no job: mail the old matcher
  -- placed on another job stays there (a repeat customer's other jobs)
  WHERE j.cmail IS NOT NULL AND i.job_id IS NULL
    AND (j.repeat_client OR i.received_at >= j.created_at - interval '30 days')
 )
 SELECT DISTINCT ON (x.jid, x.received_at) x.jid, x.cmail, x.id, x.received_at, x.subject, x.body_preview, x.from_email,
        x.graph_message_id, x.on_job, x.placement
 FROM ibx x
 WHERE x.received_at <= p_as_of
   AND coalesce(x.subject, '') !~* '^(automatic reply|auto[- ]?reply|out of office)'
   -- a business_events copy stands in for the mail only on the same job (recorded by
   -- p_as_of): a copy left unplaced, or placed on another job (an archive bucket),
   -- leaves the mail on this job (story safety, 20261006040000)
   AND NOT EXISTS (SELECT 1 FROM public.business_events c
                   WHERE c.source_table = 'inbox_events' AND c.source_id = x.id::text
                     AND c.job_id = x.jid AND coalesce(c.recorded_at, c.occurred_at) <= p_as_of)
   AND NOT EXISTS (SELECT 1 FROM public.business_events c
                   WHERE x.graph_message_id IS NOT NULL AND c.provider_message_id = 'graph:' || x.graph_message_id
                     AND c.job_id = x.jid AND coalesce(c.recorded_at, c.occurred_at) <= p_as_of)
   AND NOT EXISTS (SELECT 1 FROM public.business_events c
                   WHERE c.payload @> jsonb_build_object('inbox_events_id', x.id::text)
                     AND c.job_id = x.jid AND coalesce(c.recorded_at, c.occurred_at) <= p_as_of)
   AND NOT EXISTS (SELECT 1 FROM public.business_events m
                   WHERE m.job_id = x.jid AND m.channel = 'email' AND coalesce(m.event_at, m.occurred_at) = x.received_at
                     AND coalesce(m.recorded_at, m.occurred_at) <= p_as_of)
 ORDER BY x.jid, x.received_at, x.on_job DESC, x.id
$fn$;
COMMENT ON FUNCTION public.context_job_record_legacy_mail(uuid[], timestamptz) IS
 'Job record (20261006011000), story safety (20261006040000): a business_events copy stands in for an inbox email only when the copy is on the same job and recorded by p_as_of; a copy unplaced or on another job no longer hides the mail. Earlier: legacy inbox_events mail for the jobs: placed on the job (placement on_job), or from the client address and placed on no job (mail placed on another job stays there): withheld when the client has another job (same CRM contact or client email), else not_placed from 30 days before the job was created; no business_events copy, no business_events email on the job at the same instant, one row per received instant, auto-replies dropped. Inlinable helper read by context_job_record_messages (withheld rows never) and the story. Service role only.';

CREATE OR REPLACE FUNCTION public.context_job_record_messages(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, source_table text, source_id text, at timestamptz, event_type text, source text,
 channel text, direction text, words text, counterpart_role text, sender_role text, audience text,
 recipient_role text, is_job_contact boolean, from_is_client boolean, to_is_client boolean, sent_by_kind text,
 internal_role text, is_msg boolean, is_note boolean, customer_side boolean, internal boolean, automated boolean,
 bad_call boolean, call_answered boolean, placement text)
LANGUAGE sql STABLE
AS $fn$
 WITH j AS (
  SELECT jb.id, lower(nullif(btrim(jb.client_email), '')) AS cmail, nullif(btrim(jb.ghl_contact_id), '') AS ccontact, jb.created_at
  FROM public.jobs jb WHERE jb.id = ANY (p_job_ids)
 ),
 ev AS (
  -- a CRM text loaded later from the CRM's cache is timed by the CRM's own message
  -- time (story safety, 20261006040000); one the CRM dates more than 30 days before
  -- the job was created is from before the job's lead window (before_job); one whose CRM
  -- time is no longer known is time unknown (sixth review: never the load time)
  SELECT j.id AS jid, j.cmail, j.ccontact, e.id, coalesce(ct.crm_at, e.event_at, e.occurred_at) AS at,
         coalesce(ct.crm_at < j.created_at - interval '30 days', false) AS before_job,
         (e.source = 'ghl_sms_cache_backfill' AND ct.crm_at IS NULL) AS time_unknown, e.event_type, e.source,
         e.channel, e.direction, e.contact_id, e.payload, e.metadata,
         regexp_replace(public.context_event_text(e), '\s+', ' ', 'g') AS txt,
         -- crew and staff alerts are texts we send; inbound rows are never one
         CASE WHEN e.direction = 'outbound' THEN public.context_internal_text_role(e) ELSE 'other' END AS irole,
         (e.channel IN ('sms', 'email', 'call')
          OR e.event_type IN ('client.sms_out', 'client.email_out', 'client.call_logged', 'client.call_complete',
                              'call.transcript_completed', 'client.reply', 'client.email_in', 'client.sms_in')) AS is_msg,
         (e.event_type IN ('note.added', 'ghl.internal_comment') OR e.channel = 'note') AS is_note
  FROM j JOIN public.business_events e ON e.job_id = j.id
  CROSS JOIN LATERAL (SELECT CASE WHEN e.source = 'ghl_sms_cache_backfill'
                                  THEN public.context_job_record_crm_time(e.source, e.contact_id,
                                         coalesce(nullif(btrim(e.payload ->> 'ghl_message_id'), ''), substring(e.provider_message_id FROM '^ghl:(.+)$')), e.job_id)
                             END AS crm_at) ct
  WHERE coalesce(e.recorded_at, e.occurred_at) <= p_as_of
    -- capture copies (20261006031000): a row marked as a copy of another is the
    -- same message; it is neither shown nor counted
    AND e.metadata #>> '{duplicate_of}' IS NULL
    AND (e.channel IN ('sms', 'email', 'call', 'note')
         OR e.event_type IN ('client.sms_out', 'client.email_out', 'client.call_logged', 'client.call_complete',
                             'call.transcript_completed', 'client.reply', 'client.email_in', 'client.sms_in',
                             'note.added', 'ghl.internal_comment'))
 ),
 lab AS (
  SELECT ev.*,
         nullif(ev.metadata->'party_roles'->>'counterpart_role', '') AS cp,
         nullif(ev.metadata->'party_roles'->>'sender_role', '') AS sr,
         coalesce(nullif(ev.metadata->'party_roles'->>'audience', ''), nullif(ev.metadata->>'audience', '')) AS aud,
         nullif(ev.metadata->>'recipient_role', '') AS rr,
         CASE WHEN ev.contact_id IS NULL OR ev.ccontact IS NULL THEN NULL ELSE ev.contact_id::text = ev.ccontact END AS ijc,
         CASE WHEN ev.cmail IS NULL OR ev.channel IS DISTINCT FROM 'email' THEN NULL
              ELSE position(ev.cmail IN lower(concat_ws(' ', ev.payload->>'from', ev.payload->>'from_email',
                                                       ev.payload->>'sender'))) > 0 END AS fic,
         CASE WHEN ev.cmail IS NULL OR ev.channel IS DISTINCT FROM 'email' THEN NULL
              ELSE position(ev.cmail IN lower(concat_ws(' ', ev.payload->>'to', ev.payload->>'to_email',
                   (ev.payload->'recipients')::text, (ev.payload->'to_recipients')::text, (ev.payload->'cc')::text))) > 0
         END AS tic,
         nullif(ev.payload->>'sent_by_kind', '') AS sbk
  FROM ev
 ),
 bel AS (
  SELECT l.jid, 'business_events'::text AS tbl, l.id::text AS sid, l.at, l.event_type, l.source, l.channel, l.direction,
         left(l.txt, 300) AS words, l.cp, l.sr, l.aud, l.rr, l.ijc, l.fic, l.tic, l.sbk, l.irole, l.is_msg, l.is_note,
         -- a text from before the job's lead window is never this customer's side: the CRM
         -- contact may have been another person's then (story safety, 20261006040000); nor one
         -- whose time is unknown (sixth review: it may be from before the lead window too)
         (NOT l.before_job AND NOT l.time_unknown AND (l.is_msg AND CASE WHEN l.rr IS NOT NULL THEN false
                            WHEN l.cp IS NOT NULL THEN l.cp = 'customer'
                            ELSE coalesce(l.ijc, false) OR coalesce(l.fic, false) OR coalesce(l.tic, false) END)) AS cust,
         (l.rr IN ('crew', 'staff') OR l.aud = 'internal' OR l.irole <> 'other' OR l.cp IN ('crew', 'staff')
          OR (l.is_msg AND l.direction = 'internal')) AS internal,
         (l.sbk = 'workflow' OR l.irole <> 'other') AS automated,
         (l.direction = 'inbound' AND l.channel = 'call'
          AND l.txt ~* 'Provider status: (no-answer|ringing|busy|missed|voicemail|canceled|cancelled)') AS bad_call,
         ((l.channel = 'call' OR l.event_type IN ('client.call_logged', 'client.call_complete', 'call.transcript_completed'))
          AND (l.event_type = 'call.transcript_completed'
               OR lower(coalesce(l.payload->>'call_status', substring(l.txt FROM 'Provider status: ([A-Za-z_-]+)'), ''))
                  IN ('completed', 'answered'))) AS answered,
         CASE WHEN l.before_job THEN 'before_job' WHEN l.time_unknown THEN 'time_unknown' ELSE 'on_job' END AS placement
  FROM lab l
 ),
 -- legacy mail: a repeat client's mail placed on no job is withheld (it may be another job's)
 ib AS (SELECT * FROM public.context_job_record_legacy_mail(p_job_ids, p_as_of) x WHERE x.placement <> 'withheld'),
 ibl AS (
  SELECT ib.jid, 'inbox_events'::text AS tbl, ib.id::text AS sid, ib.received_at AS at, 'inbox.email'::text AS event_type,
         'monitor-inbox legacy'::text AS source, 'email'::text AS channel,
         CASE WHEN lower(coalesce(substring(ib.from_email FROM '@([A-Za-z0-9.-]+)'), ''))
                   ~ '(^|\.)(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$'
              THEN 'internal' ELSE 'inbound' END AS direction,
         left(regexp_replace(coalesce(ib.subject || ' | ', '') || coalesce(ib.body_preview, ''), '\s+', ' ', 'g'), 300) AS words,
         CASE WHEN ib.cmail IS NOT NULL AND lower(btrim(ib.from_email)) = ib.cmail THEN 'customer' END AS cp,
         CASE WHEN ib.cmail IS NOT NULL AND lower(btrim(ib.from_email)) = ib.cmail THEN 'customer' END AS sr,
         NULL::text AS aud, NULL::text AS rr, NULL::boolean AS ijc,
         CASE WHEN ib.cmail IS NULL THEN NULL ELSE lower(btrim(ib.from_email)) = ib.cmail END AS fic,
         NULL::boolean AS tic, NULL::text AS sbk, 'other'::text AS irole, true AS is_msg, false AS is_note,
         (ib.cmail IS NOT NULL AND lower(btrim(ib.from_email)) = ib.cmail) AS cust,
         false AS internal, false AS automated, false AS bad_call, false AS answered,
         ib.placement
  FROM ib
 )
 SELECT u.jid AS job_id, u.tbl AS source_table, u.sid AS source_id, u.at, u.event_type, u.source, u.channel, u.direction,
        u.words, u.cp AS counterpart_role, u.sr AS sender_role, u.aud AS audience, u.rr AS recipient_role,
        u.ijc AS is_job_contact, u.fic AS from_is_client, u.tic AS to_is_client, u.sbk AS sent_by_kind,
        u.irole AS internal_role, u.is_msg, u.is_note, u.cust AS customer_side, coalesce(u.internal, false) AS internal,
        coalesce(u.automated, false) AS automated, coalesce(u.bad_call, false) AS bad_call,
        coalesce(u.answered, false) AS call_answered, u.placement
 FROM (SELECT * FROM bel UNION ALL SELECT * FROM ibl) u
$fn$;
COMMENT ON FUNCTION public.context_job_record_messages(uuid[], timestamptz) IS
 'Job record (20261006011000), story safety (20261006040000): a CRM text loaded later from the CRM''s cache (source ghl_sms_cache_backfill) is timed by the CRM''s own message time (context_job_record_crm_time), not the load time; one the CRM dates more than 30 days before the job was created is history from before the job''s lead window: placement before_job, never the customer''s side, so it is never the customer''s last word, first contact or a candidate; (sixth review) one whose CRM time is no longer known (neither kept nor in the cache) is placement time_unknown, its at the load time it carries, never the customer''s side either. Earlier: message-shaped business_events on the jobs (recorded at or before p_as_of) with the who-to-whom labels of the proof-set reference (customer_side = grade_ref is_customer_counterpart), plus legacy inbox_events mail placed on the job, or from the client address and placed on no job (placement not_placed), with no business_events copy. Since 20261006031000 a row marked as a copy of another (metadata.duplicate_of) is left out, so the timeline, loops and contact counts never count one message twice. Inlinable helper (no SET, not SECURITY DEFINER) read by the job record functions. Service role only.';

CREATE OR REPLACE FUNCTION public.context_job_record_timeline(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, at timestamptz, perth_date date, time_basis text, kind text, what text, amount numeric,
 party text, placement text, source_table text, source_id text, state text, made_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH j AS (
  SELECT jb.id, jb.status::text AS status, jb.type::text AS type, jb.created_at, jb.quoted_at, jb.accepted_at,
         jb.approvals_at, jb.processing_at, jb.scheduled_at, jb.completed_at, jb.deposit_at, jb.deposit_amount, jb.job_number
  FROM public.jobs jb WHERE jb.id = ANY (p_job_ids)
 ),
 msg AS (SELECT * FROM public.context_job_record_messages(p_job_ids, p_as_of)),
 -- status changes from the app timeline and from the status events, folded:
 -- rows less than 10 minutes apart become one row showing the path
 st0 AS (
  SELECT je.job_id, je.created_at AS at,
         coalesce(je.detail_json->>'new_status', je.detail_json->>'to', je.detail_json->>'status') AS to_s,
         coalesce(je.detail_json->>'old_status', je.detail_json->>'from') AS from_s,
         'job_events'::text AS tbl, je.id::text AS sid
  FROM public.job_events je
  WHERE je.job_id = ANY (p_job_ids) AND je.event_type IN ('status_changed', 'status_change') AND je.created_at <= p_as_of
  UNION ALL
  SELECT e.job_id, coalesce(e.event_at, e.occurred_at), e.payload->'changes'->'status'->>'to',
         e.payload->'changes'->'status'->>'from', 'business_events', e.id::text
  FROM public.business_events e
  WHERE e.job_id = ANY (p_job_ids) AND e.event_type = 'job.status_changed'
    AND coalesce(e.recorded_at, e.occurred_at) <= p_as_of
 ),
 st1 AS (
  SELECT s.*, CASE WHEN lag(s.at) OVER w IS NULL OR s.at - lag(s.at) OVER w >= interval '10 minutes' THEN 1 ELSE 0 END AS brk
  FROM st0 s WHERE s.to_s IS NOT NULL AND s.at IS NOT NULL
  WINDOW w AS (PARTITION BY s.job_id ORDER BY s.at, s.sid)
 ),
 st2 AS (SELECT s.*, sum(s.brk) OVER (PARTITION BY s.job_id ORDER BY s.at, s.sid) AS grp FROM st1 s),
 st3 AS (SELECT s.*, lag(s.to_s) OVER (PARTITION BY s.job_id, s.grp ORDER BY s.at, s.sid) AS prev_to FROM st2 s),
 stg AS (
  SELECT s.job_id, s.grp, count(*) AS n, min(s.at) AS first_at, max(s.at) AS last_at,
         (array_agg(s.from_s ORDER BY s.at, s.sid) FILTER (WHERE s.from_s IS NOT NULL))[1] AS from_s,
         string_agg(replace(s.to_s, '_', ' '), ' -> ' ORDER BY s.at, s.sid) FILTER (WHERE s.prev_to IS DISTINCT FROM s.to_s) AS path,
         count(*) FILTER (WHERE s.prev_to IS DISTINCT FROM s.to_s) AS steps,
         (array_agg(s.to_s ORDER BY s.at DESC, s.sid DESC))[1] AS final_to,
         (array_agg(s.tbl ORDER BY s.at DESC, s.sid DESC))[1] AS tbl,
         (array_agg(s.sid ORDER BY s.at DESC, s.sid DESC))[1] AS sid
  FROM st3 s GROUP BY s.job_id, s.grp
 ),
 inv AS (
  SELECT x.id, x.job_id, x.invoice_number, x.reference, x.contact_name, x.total, x.amount_due, x.amount_paid,
         x.invoice_date, x.due_date, x.fully_paid_on, x.raw_json, x.created_at,
         upper(coalesce(x.status, '')) AS st, upper(coalesce(x.invoice_type, 'ACCREC')) AS itype,
         -- a supplier bill whose lines name other jobs is shared: this job's lines are its share
         CASE WHEN upper(coalesce(x.invoice_type, 'ACCREC')) = 'ACCPAY'
              THEN public.context_job_record_bill_share(j.job_number, x.line_items, x.raw_json ->> 'LineAmountTypes') END AS share
  FROM public.xero_invoices x JOIN j ON j.id = x.job_id
  WHERE x.job_id = ANY (p_job_ids) AND coalesce(x.created_at, x.synced_at, '-infinity'::timestamptz) <= p_as_of
 ),
 qv AS (
  SELECT j.id AS job_id, v.document_id, v.value_inc_gst, v.value_source
  FROM j CROSS JOIN LATERAL public.job_quote_values(j.id) v
 ),
 asg AS (
  SELECT a.*, coalesce(a.is_ghost, false) OR coalesce(a.role, '') = 'observer' AS mirror
  FROM public.job_assignments a
  WHERE a.job_id = ANY (p_job_ids) AND a.created_at <= p_as_of
 ),
 -- app events the ledger store lets close a matter (context_ledger_job_event_closes):
 -- a reader cites them by id, and each line's state is its event_type
 ae0 AS (
  SELECT je.id, je.job_id, je.event_type, je.created_at, coalesce(je.detail_json, '{}'::jsonb) AS d,
         nullif(btrim(je.detail_json ->> 'document_id'), '') AS doc,
         CASE WHEN je.detail_json ->> 'assignment_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN (je.detail_json ->> 'assignment_id')::uuid END AS asg_id,
         CASE WHEN je.detail_json ->> 'fully_paid_on' ~ '^/Date\(-?[0-9]{1,13}[^0-9]'
              THEN (to_timestamp(substring(je.detail_json ->> 'fully_paid_on' FROM '^/Date\((-?[0-9]{1,13})')::numeric / 1000)
                    AT TIME ZONE 'Australia/Perth')::date
              ELSE public.context_job_record_date(je.detail_json ->> 'fully_paid_on') END AS paid_day,
         (je.created_at AT TIME ZONE 'Australia/Perth')::date AS day,
         -- the matter it records: its document, invoice, booking or report
         lower(coalesce(nullif(btrim(je.detail_json ->> 'document_id'), ''), nullif(btrim(je.detail_json ->> 'xero_invoice_id'), ''),
                        nullif(btrim(je.detail_json ->> 'invoice_number'), ''), nullif(btrim(je.detail_json ->> 'assignment_id'), ''),
                        nullif(btrim(je.detail_json ->> 'report_id'), ''), nullif(btrim(je.detail_json ->> 'report_doc_id'), ''),
                        nullif(btrim(je.detail_json ->> 'draft_id'), ''), '')) AS obj
  FROM public.job_events je
  WHERE je.job_id = ANY (p_job_ids) AND je.created_at <= p_as_of
    AND je.event_type IN ('quote_sent', 'invoice.emailed', 'acceptance_invoice_sent', 'payment_link_sent', 'payment_received',
                          'payment_recorded', 'clock.clock_on', 'clock.clock_off', 'makesafe_report_submitted', 'roof_report_submitted')
 ),
 -- one line per event type, matter and Perth day (an app that logs the same send
 -- over and over in a day is one line saying how many times), citing the newest.
 -- An event naming a document our system emailed whose every email bounced or
 -- failed, and that the customer never viewed or answered (as of p_as_of), was not
 -- received: the store lets it close nothing (context_ledger_cite, the same rule).
 ae AS (
  SELECT g.*,
         (g.doc IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.email_events ee WHERE ee.metadata ->> 'document_id' = g.doc AND ee.created_at <= p_as_of)
          AND NOT EXISTS (SELECT 1 FROM public.email_events ee WHERE ee.metadata ->> 'document_id' = g.doc
                          AND lower(coalesce(ee.status, '')) IN ('sent', 'delivered', 'accepted') AND ee.sent_at IS NOT NULL AND ee.sent_at <= p_as_of)
          AND NOT EXISTS (SELECT 1 FROM public.job_documents d
                          WHERE d.id = CASE WHEN g.doc ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g.doc::uuid END
                            AND (d.viewed_at <= p_as_of OR d.accepted_at <= p_as_of OR d.declined_at <= p_as_of))) AS not_received
  FROM (SELECT DISTINCT ON (x.job_id, x.event_type, x.obj, x.day) x.*,
               count(*) OVER (PARTITION BY x.job_id, x.event_type, x.obj, x.day) AS n,
               min(x.created_at) OVER (PARTITION BY x.job_id, x.event_type, x.obj, x.day) AS first_at,
               -- a folded clock-off line gives the day's hours: the sum of every stint's net
               -- hours, only when each stint folded into it carries them (else no hours)
               sum(CASE WHEN jsonb_typeof(x.d -> 'net_hours') = 'number' THEN (x.d ->> 'net_hours')::numeric END)
                OVER (PARTITION BY x.job_id, x.event_type, x.obj, x.day) AS net_sum,
               count(*) FILTER (WHERE jsonb_typeof(x.d -> 'net_hours') = 'number')
                OVER (PARTITION BY x.job_id, x.event_type, x.obj, x.day) AS net_n
        FROM ae0 x
        ORDER BY x.job_id, x.event_type, x.obj, x.day, x.created_at DESC, x.id DESC) g
 ),
 m AS (
  -- job created
  SELECT j.id AS job_id, j.created_at AS at, 'observed'::text AS time_basis, 'job_created'::text AS kind,
         'Job created (' || coalesce(j.type, 'type not set') || ')' AS what, NULL::numeric AS amount, NULL::text AS party,
         'on_job'::text AS placement, 'jobs'::text AS source_table, j.id::text AS source_id
  FROM j WHERE j.created_at <= p_as_of
  -- stage stamps on the job row, unless a status row already shows that stage
  UNION ALL
  SELECT j.id, s.at, 'stamp', 'status',
         'Job record stamp: entered ' || replace(s.stage, '_', ' ') || ' (the job row keeps only the last time it entered this stage)',
         CASE WHEN s.stage = 'deposit' THEN j.deposit_amount END, NULL, 'on_job', 'jobs', j.id::text
  FROM j CROSS JOIN LATERAL (VALUES ('quoted', j.quoted_at), ('accepted', j.accepted_at), ('approvals', j.approvals_at),
       ('processing', j.processing_at), ('scheduled', j.scheduled_at), ('complete', j.completed_at),
       ('deposit', j.deposit_at)) s(stage, at)
  WHERE s.at IS NOT NULL AND s.at <= p_as_of
    AND NOT EXISTS (SELECT 1 FROM st0 x WHERE x.job_id = j.id
                    AND (x.to_s = s.stage OR (s.stage = 'complete' AND x.to_s IN ('completed', 'complete')))
                    AND abs(extract(epoch FROM x.at - s.at)) < 3600)
  -- status changes
  UNION ALL
  SELECT g.job_id, g.last_at, 'observed',
         CASE WHEN g.final_to = 'rectification' THEN 'rectification' ELSE 'status' END,
         CASE WHEN g.steps <= 1 THEN 'Status set to ' || replace(g.final_to, '_', ' ')
                   || coalesce(' (from ' || replace(g.from_s, '_', ' ') || ')', '')
              ELSE 'Status changed ' || g.steps || ' times within minutes: ' || g.path
                   || '; it ended at ' || replace(g.final_to, '_', ' ') END,
         NULL, NULL, 'on_job', g.tbl, g.sid
  FROM stg g
  -- first message with the customer (texts, emails, calls, legacy mail)
  UNION ALL
  SELECT * FROM (
   SELECT DISTINCT ON (c.job_id) c.job_id, c.at, 'observed', 'first_contact',
          'First message with the customer on record (' || coalesce(c.channel, c.event_type) || ', '
            || CASE WHEN c.direction = 'inbound' THEN 'from the customer' ELSE 'from us' END
            || CASE WHEN c.placement = 'not_placed' THEN ', not placed on any job' ELSE '' END || ')',
          NULL::numeric, NULL::text, c.placement, c.source_table, c.source_id
   FROM msg c WHERE c.customer_side
   ORDER BY c.job_id, c.at, c.source_id) fc
  -- site visits: CRM appointments, recorded visit outcomes, scope first saved
  UNION ALL
  SELECT e.job_id, coalesce(e.event_at, e.occurred_at), 'observed', 'site_visit',
         'Appointment ' || replace(coalesce(e.payload->>'appointment_action', e.event_type), '_', ' ')
           || coalesce(': ' || left(e.payload->>'title', 120), '')
           || coalesce(', status ' || (e.payload->>'appointment_status'), ''),
         NULL, NULL, 'on_job', 'business_events', e.id::text
  FROM public.business_events e
  WHERE e.job_id = ANY (p_job_ids) AND coalesce(e.recorded_at, e.occurred_at) <= p_as_of
    AND e.event_type IN ('ghl.appointment_created', 'ghl.appointment_updated', 'ghl.appointment_deleted', 'client.appointment')
  UNION ALL
  SELECT j.id, o.visit_start, 'observed', 'site_visit',
         'Visit outcome recorded: ' || replace(coalesce(o.outcome, '?'), '_', ' ') || coalesce(' (' || o.reason || ')', '')
           || CASE WHEN o.quote_owed THEN '; a quote is owed' ELSE '' END,
         NULL, NULL, CASE WHEN o.job_id = j.id THEN 'on_job' ELSE 'contact' END, 'visit_outcomes', o.id::text
  FROM j JOIN public.jobs jj ON jj.id = j.id
  JOIN public.visit_outcomes o
    ON o.job_id = j.id OR (o.job_id IS NULL AND o.contact_id = nullif(btrim(jj.ghl_contact_id), ''))
  WHERE o.recorded_at <= p_as_of AND NOT EXISTS (SELECT 1 FROM public.visit_outcomes s WHERE s.supersedes = o.id)
  UNION ALL
  SELECT * FROM (
   SELECT DISTINCT ON (je.job_id) je.job_id, je.created_at, 'observed', 'site_visit',
          'Scope first saved in the scoping tool', NULL::numeric, NULL::text, 'on_job', 'job_events', je.id::text
   FROM public.job_events je
   WHERE je.job_id = ANY (p_job_ids) AND je.event_type = 'scope_saved' AND je.created_at <= p_as_of
   ORDER BY je.job_id, je.created_at, je.id) ss
  -- quotes: one row per version event; generated is folded into sent when both
  -- happened on the same Perth day within an hour
  UNION ALL
  SELECT d.job_id, q.at, 'observed', 'quote',
         CASE WHEN d.type = 'quote' THEN 'Quote ' ELSE initcap(replace(d.type, '_', ' ')) || ' ' END
           || coalesce(d.quote_number, 'without a number') || coalesce(' v' || d.version, '')
           || coalesce(' (' || d.run_label || ')', '') || ' ' || q.ev
           || CASE WHEN q.ev = 'sent' AND de.undelivered THEN ', but every email of it bounced or failed: not received' ELSE '' END
           || CASE WHEN q.ev = 'sent' THEN coalesce(', value ' || to_char(v.value_inc_gst, 'FM$999,999,990.00') || ' inc GST',
                                                    ', value not recorded (' || coalesce(v.value_source, 'not a sent quote') || ')')
                   WHEN q.ev = 'accepted' THEN coalesce(', value ' || to_char(v.value_inc_gst, 'FM$999,999,990.00') || ' inc GST', '')
                   ELSE '' END,
         CASE WHEN q.ev IN ('sent', 'accepted') THEN v.value_inc_gst END, NULL, 'on_job', 'job_documents', d.id::text
  FROM public.job_documents d
  LEFT JOIN qv v ON v.job_id = d.job_id AND v.document_id = d.id
  -- a document our system emailed, every email of it bounced or failed (as of the
  -- replay instant), and the customer never viewed, accepted or declined it
  CROSS JOIN LATERAL (SELECT (EXISTS (SELECT 1 FROM public.email_events ee WHERE ee.metadata ->> 'document_id' = d.id::text AND ee.created_at <= p_as_of)
       AND NOT EXISTS (SELECT 1 FROM public.email_events ee WHERE ee.metadata ->> 'document_id' = d.id::text
        AND lower(coalesce(ee.status, '')) IN ('sent', 'delivered', 'accepted') AND ee.sent_at IS NOT NULL AND ee.sent_at <= p_as_of)
       AND NOT coalesce(d.viewed_at <= p_as_of OR d.accepted_at <= p_as_of OR d.declined_at <= p_as_of, false)) AS undelivered) de
  CROSS JOIN LATERAL (VALUES ('generated', d.created_at), ('sent', d.sent_at), ('viewed', d.viewed_at),
       ('accepted', d.accepted_at), ('declined', d.declined_at), ('superseded', d.superseded_at)) q(ev, at)
  WHERE d.job_id = ANY (p_job_ids) AND d.type ILIKE '%quote%' AND q.at IS NOT NULL AND q.at <= p_as_of
    AND NOT (q.ev = 'generated' AND d.sent_at IS NOT NULL AND d.sent_at <= p_as_of
             AND d.sent_at - d.created_at < interval '1 hour'
             AND (d.sent_at AT TIME ZONE 'Australia/Perth')::date = (d.created_at AT TIME ZONE 'Australia/Perth')::date)
  -- customer invoices (ACCREC) and supplier bills (ACCPAY, money we owe)
  UNION ALL
  SELECT i.job_id, coalesce((i.invoice_date::timestamp AT TIME ZONE 'Australia/Perth'), i.created_at),
         CASE WHEN i.invoice_date IS NULL THEN 'observed' ELSE 'date_only' END,
         CASE WHEN i.itype = 'ACCPAY' THEN 'supplier_bill' ELSE 'invoice' END,
         CASE WHEN i.itype = 'ACCPAY' THEN
                'Supplier bill ' || coalesce(i.invoice_number, i.reference, 'without a number') || ' from '
                || coalesce(i.contact_name, 'an unnamed supplier') || ': total ' || to_char(i.total, 'FM$999,999,990.00')
                || CASE WHEN coalesce((i.share ->> 'shared')::boolean, false)
                        THEN ', shared with other jobs ' || coalesce('(this job''s lines ' || to_char((i.share ->> 'job_share')::numeric, 'FM$999,999,990.00') || ')',
                                                                     '(no line names this job)')
                        ELSE '' END
                || CASE WHEN i.st IN ('DELETED', 'VOIDED') THEN ', ' || lower(i.st) || ' in Xero (never counted)'
                        WHEN i.st = 'DRAFT' THEN ', draft in Xero'
                        WHEN i.st = 'PAID' THEN ', paid (money we owed)'
                        ELSE ', ' || lower(i.st) || ', we owe ' || to_char(coalesce(i.amount_due, 0), 'FM$999,999,990.00') END
              ELSE
                CASE WHEN i.st = 'DRAFT' THEN 'Draft invoice ' ELSE 'Invoice ' END
                || coalesce(i.invoice_number, 'without a number') || coalesce(' (' || nullif(i.reference, '') || ')', '')
                || ' to ' || coalesce(i.contact_name, 'an unnamed contact') || ': total ' || to_char(i.total, 'FM$999,999,990.00')
                || CASE WHEN i.st IN ('DELETED', 'VOIDED') THEN ', ' || lower(i.st) || ' in Xero (never counted)'
                        WHEN i.st = 'DRAFT' THEN ', not issued (a draft cannot be paid)'
                        WHEN i.st = 'PAID' THEN ', paid'
                        ELSE ', ' || lower(i.st) || coalesce(', due ' || to_char(i.due_date, 'Dy FMDD Mon YYYY'), '')
                             || ', owing ' || to_char(coalesce(i.amount_due, 0), 'FM$999,999,990.00') END
              END,
         i.total, i.contact_name, 'on_job', 'xero_invoices', i.id::text
  FROM inv i
  -- payments, credit notes, overpayments and prepayments applied (Xero raw record)
  UNION ALL
  SELECT p.job_id, p.at, 'date_only',
         CASE WHEN p.itype = 'ACCPAY' THEN 'supplier_payment' WHEN p.k = 'Payments' THEN 'payment' ELSE 'credit' END,
         CASE WHEN p.itype = 'ACCPAY' THEN
                CASE WHEN p.k = 'Payments' THEN 'We paid ' ELSE 'Supplier credit ' END || to_char(p.amt, 'FM$999,999,990.00')
                || ' on supplier bill ' || coalesce(p.invoice_number, p.reference, 'without a number')
                || ' (' || coalesce(p.contact_name, 'unnamed supplier') || ')'
              ELSE
                CASE p.k WHEN 'Payments' THEN 'Payment ' || to_char(p.amt, 'FM$999,999,990.00') || ' received on '
                     WHEN 'CreditNotes' THEN 'Credit note ' || coalesce(p.num || ' ', '') || to_char(p.amt, 'FM$999,999,990.00') || ' applied to '
                     WHEN 'Overpayments' THEN 'Earlier overpayment ' || to_char(p.amt, 'FM$999,999,990.00') || ' applied to '
                     ELSE 'Prepayment ' || to_char(p.amt, 'FM$999,999,990.00') || ' applied to ' END
                || coalesce(p.invoice_number, 'an invoice without a number') || ' (' || coalesce(p.contact_name, 'unnamed contact') || ')'
         END,
         p.amt, p.contact_name, 'on_job', 'xero_invoices', p.id::text
  FROM (
   SELECT i.job_id, i.id, i.itype, i.invoice_number, i.reference, i.contact_name, k.k, e->>'CreditNoteNumber' AS num,
          coalesce(nullif(e->>'Amount', '')::numeric, nullif(e->>'AppliedAmount', '')::numeric) AS amt,
          CASE WHEN e->>'Date' ~ '^/Date\(-?[0-9]+' THEN to_timestamp(substring(e->>'Date' FROM '^/Date\((-?[0-9]+)')::numeric / 1000)
               WHEN e->>'Date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN ((e->>'Date')::date::timestamp AT TIME ZONE 'Australia/Perth')
               WHEN e->>'Date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+$' THEN ((e->>'Date')::timestamp AT TIME ZONE 'UTC')
          END AS at
   FROM inv i
   CROSS JOIN (VALUES ('Payments'), ('CreditNotes'), ('Overpayments'), ('Prepayments')) k(k)
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(i.raw_json->k.k) = 'array' THEN i.raw_json->k.k
                                                ELSE '[]'::jsonb END) e
   WHERE i.st NOT IN ('DELETED', 'VOIDED')) p
  WHERE p.amt IS NOT NULL AND p.at IS NOT NULL AND p.at <= p_as_of
  UNION ALL
  -- a paid invoice whose raw Xero copy carries no payment lines (the copy lags the
  -- columns): the paid-in-full date from the columns, labelled as such
  SELECT i.job_id, (i.fully_paid_on::timestamp AT TIME ZONE 'Australia/Perth'), 'date_only',
         CASE WHEN i.itype = 'ACCPAY' THEN 'supplier_payment' ELSE 'payment' END,
         CASE WHEN i.itype = 'ACCPAY' THEN 'Supplier bill ' ELSE 'Invoice ' END
           || coalesce(i.invoice_number, i.reference, 'without a number') || ' paid in full ('
           || to_char(coalesce(i.amount_paid, i.total), 'FM$999,999,990.00') || '; Xero shows the date, the payment detail is not synced)',
         coalesce(i.amount_paid, i.total), i.contact_name, 'on_job', 'xero_invoices', i.id::text
  FROM inv i
  WHERE i.st = 'PAID' AND i.fully_paid_on IS NOT NULL
    AND (i.fully_paid_on::timestamp AT TIME ZONE 'Australia/Perth') <= p_as_of
    AND jsonb_array_length(CASE WHEN jsonb_typeof(i.raw_json->'Payments') = 'array' THEN i.raw_json->'Payments' ELSE '[]'::jsonb END) = 0
  -- emails our system sent (quotes, invoices, notices)
  UNION ALL
  SELECT ee.job_id, coalesce(ee.sent_at, ee.created_at), 'observed', 'system_email',
         'Our system emailed ' || CASE WHEN jc.cmail IS NOT NULL AND position(jc.cmail IN lower(coalesce(ee.recipient, ''))) > 0
                                       THEN 'the customer' ELSE 'another address' END
           || ' (' || replace(coalesce(ee.email_type, 'email'), '_', ' ') || ', ' || coalesce(ee.status, 'status unknown') || ')'
           || coalesce(': ' || left(ee.subject, 160), ''),
         NULL, NULL, 'on_job', 'email_events', ee.id::text
  FROM public.email_events ee
  JOIN (SELECT jb.id, lower(nullif(btrim(jb.client_email), '')) AS cmail FROM public.jobs jb WHERE jb.id = ANY (p_job_ids)) jc
    ON jc.id = ee.job_id
  WHERE ee.job_id = ANY (p_job_ids) AND ee.created_at <= p_as_of
  -- bookings: the booked day with its status; observer mirrors kept apart
  UNION ALL
  SELECT a.job_id,
         CASE WHEN a.scheduled_date IS NULL THEN a.created_at
              WHEN a.start_time IS NOT NULL THEN ((a.scheduled_date + a.start_time) AT TIME ZONE 'Australia/Perth')
              ELSE (a.scheduled_date::timestamp AT TIME ZONE 'Australia/Perth') END,
         CASE WHEN a.scheduled_date IS NULL THEN 'observed' ELSE 'scheduled' END,
         CASE WHEN a.mirror THEN 'booking_mirror' ELSE 'booking' END,
         CASE WHEN a.mirror THEN 'Observer copy of a booking (not a crew booking): ' ELSE 'Booking: ' END
           || replace(coalesce(a.assignment_type, 'visit'), '_', ' ') || ' '
           || coalesce(to_char(a.scheduled_date, 'Dy FMDD Mon YYYY'), 'with no date set (shown when it was made)')
           || coalesce(' to ' || to_char(nullif(a.scheduled_end, a.scheduled_date), 'Dy FMDD Mon'), '')
           || coalesce(', ' || nullif(btrim(a.crew_name), ''), '') || ', ' || coalesce(a.status, 'status not set'),
         NULL, NULL, 'on_job', 'job_assignments', a.id::text
  FROM asg a
  -- attendance: only started or complete counts
  UNION ALL
  SELECT a.job_id, coalesce(a.completed_at, a.started_at,
           -- a status-only completion: the end of the booked Perth day, or now while
           -- that is still ahead (the status already says it happened)
           CASE WHEN lower(coalesce(a.status, '')) IN ('complete', 'completed') AND a.scheduled_date IS NOT NULL
                THEN least(((a.scheduled_date + 1)::timestamp AT TIME ZONE 'Australia/Perth') - interval '1 second', now()) END,
           (a.scheduled_date::timestamp AT TIME ZONE 'Australia/Perth'), a.created_at),
         CASE WHEN a.completed_at IS NOT NULL OR a.started_at IS NOT NULL THEN 'observed' ELSE 'date_only' END, 'attendance',
         CASE WHEN a.completed_at IS NOT NULL THEN 'Crew marked complete'
              WHEN lower(coalesce(a.status, '')) IN ('complete', 'completed') THEN 'Booking status complete (who and when not recorded)'
              WHEN a.started_at IS NOT NULL THEN 'Crew started'
              ELSE 'Booking status in progress (who and when not recorded)' END
           || ': ' || replace(coalesce(a.assignment_type, 'visit'), '_', ' ')
           || coalesce(' booked ' || to_char(a.scheduled_date, 'Dy FMDD Mon YYYY'), ' (no booked date)')
           || coalesce(', ' || nullif(btrim(a.crew_name), ''), ''),
         NULL, NULL, 'on_job', 'job_assignments', a.id::text
  FROM asg a
  WHERE NOT a.mirror AND (lower(coalesce(a.status, '')) IN ('complete', 'completed', 'in_progress') OR a.completed_at IS NOT NULL OR a.started_at IS NOT NULL)
    AND coalesce(a.completed_at, a.started_at,
          CASE WHEN lower(coalesce(a.status, '')) IN ('complete', 'completed') AND a.scheduled_date IS NOT NULL
               THEN least(((a.scheduled_date + 1)::timestamp AT TIME ZONE 'Australia/Perth') - interval '1 second', now()) END,
          (a.scheduled_date::timestamp AT TIME ZONE 'Australia/Perth'), a.created_at) <= p_as_of
  -- booking changes from the app timeline
  UNION ALL
  -- (a change to a ghost or observer row, or one its writer tags as a ghost copy, is an
  -- observer's copy, never a crew booking: story safety, 20261006040000)
  SELECT je.job_id, je.created_at, 'observed',
         CASE WHEN coalesce(ga.mirror, false) OR coalesce(je.detail_json->>'source', '') LIKE 'ghost%' THEN 'booking_mirror'
              WHEN je.event_type = 'assignment_status_changed'
                   AND je.detail_json->>'new_status' IN ('started', 'in_progress', 'complete', 'completed') THEN 'attendance'
              ELSE 'booking_change' END,
         CASE WHEN coalesce(ga.mirror, false) OR coalesce(je.detail_json->>'source', '') LIKE 'ghost%'
              THEN 'Observer copy, not a crew booking: ' ELSE '' END
         || CASE je.event_type
           WHEN 'assignment_created' THEN 'Booking made for '
                || coalesce(to_char(public.context_job_record_date(je.detail_json->>'date'), 'Dy FMDD Mon YYYY'), 'a date not recorded')
                || coalesce((SELECT CASE WHEN a.scheduled_date::text <> je.detail_json->>'date'
                                         THEN '; now booked ' || to_char(a.scheduled_date, 'Dy FMDD Mon YYYY') END
                             FROM public.job_assignments a
                             WHERE a.id = CASE WHEN je.detail_json->>'assignment_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                               THEN (je.detail_json->>'assignment_id')::uuid END), '')
           WHEN 'assignment_deleted' THEN 'Booking deleted' || coalesce(' (it was for '
                || to_char(public.context_job_record_date(coalesce(je.detail_json->>'date', je.detail_json->>'scheduled_date')), 'Dy FMDD Mon YYYY') || ')', '')
           WHEN 'assignment_removed' THEN 'Booking removed'
           WHEN 'assignment_rescheduled' THEN 'Booking moved'
                || coalesce(' from ' || to_char(public.context_job_record_date(coalesce(je.detail_json->>'old_date', je.detail_json->>'from')), 'Dy FMDD Mon'), '')
                || coalesce(' to ' || to_char(public.context_job_record_date(coalesce(je.detail_json->>'new_date', je.detail_json->>'to', je.detail_json->>'date')), 'Dy FMDD Mon'), '')
           WHEN 'assignment_confirmed' THEN 'Booking confirmed in crew planning'
                || coalesce(' for ' || to_char(public.context_job_record_date(je.detail_json->>'scheduled_date'), 'Dy FMDD Mon'), '')
                || CASE WHEN je.detail_json->>'notify_client' = 'true' THEN ' (client notified)' ELSE '' END
           WHEN 'assignment_status_changed' THEN 'Crew marked the booking ' || replace(coalesce(je.detail_json->>'new_status', '?'), '_', ' ')
           WHEN 'assignment_acknowledged' THEN 'Crew acknowledged the booking'
           ELSE replace(je.event_type, '_', ' ') END,
         NULL, NULL, 'on_job', 'job_events', je.id::text
  FROM public.job_events je
  LEFT JOIN (SELECT a.id, coalesce(a.is_ghost, false) OR coalesce(a.role, '') = 'observer' AS mirror FROM public.job_assignments a) ga
    ON ga.id = CASE WHEN je.detail_json->>'assignment_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN (je.detail_json->>'assignment_id')::uuid END
  WHERE je.job_id = ANY (p_job_ids) AND je.created_at <= p_as_of
    AND je.event_type IN ('assignment_created', 'assignment_deleted', 'assignment_removed', 'assignment_rescheduled',
                          'assignment_confirmed', 'assignment_status_changed', 'assignment_acknowledged')
    -- a "move" to the same date is no booking change
    AND NOT coalesce(je.event_type = 'assignment_rescheduled'
             AND public.context_job_record_date(coalesce(je.detail_json->>'old_date', je.detail_json->>'from'))
                 = public.context_job_record_date(coalesce(je.detail_json->>'new_date', je.detail_json->>'to', je.detail_json->>'date')), false)
  UNION ALL
  SELECT e.job_id, coalesce(e.event_at, e.occurred_at), 'observed',
         CASE WHEN e.event_type LIKE 'clock.%' THEN 'attendance' ELSE 'booking_change' END,
         CASE WHEN e.event_type = 'clock.clock_off' THEN 'Crew clocked off'
              WHEN e.event_type = 'clock.clock_on' THEN 'Crew clocked on'
              ELSE 'Booking ' || replace(replace(e.event_type, 'schedule.', ''), '_', ' ')
                   || coalesce(', ' || to_char(public.context_job_record_date(e.payload->>'old_date'), 'Dy FMDD Mon') || ' to '
                               || to_char(public.context_job_record_date(e.payload->>'new_date'), 'Dy FMDD Mon'), '') END,
         NULL, NULL, 'on_job', 'business_events', e.id::text
  FROM public.business_events e
  WHERE e.job_id = ANY (p_job_ids) AND coalesce(e.recorded_at, e.occurred_at) <= p_as_of
    AND (e.event_type LIKE 'schedule.%' OR e.event_type IN ('clock.clock_on', 'clock.clock_off'))
    -- crew-planning marks are not booking changes: a lock, a status mark (old or
    -- new status: confirmed, tentative, placeholder) and a reschedule to the same
    -- date. A reschedule to another date is a real move and stays, whatever status
    -- keys the crew-planning writer adds to it (it always writes old and new status).
    AND e.event_type <> 'schedule.locked'
    AND NOT (e.event_type LIKE 'schedule.%' AND (e.payload ? 'old_status' OR e.payload ? 'new_status')
             AND NOT coalesce(e.event_type = 'schedule.rescheduled'
                  AND public.context_job_record_date(e.payload->>'old_date') <> public.context_job_record_date(e.payload->>'new_date'), false))
    AND NOT coalesce(e.event_type = 'schedule.rescheduled'
             AND public.context_job_record_date(e.payload->>'old_date') = public.context_job_record_date(e.payload->>'new_date'), false)
    AND NOT (e.event_type = 'schedule.assignment_deleted' AND EXISTS (
         SELECT 1 FROM public.job_events x WHERE x.job_id = e.job_id AND x.event_type = 'assignment_deleted'
           AND abs(extract(epoch FROM x.created_at - coalesce(e.event_at, e.occurred_at))) < 120))
  -- variations
  UNION ALL
  SELECT v.job_id, q.at, 'observed', 'variation',
         'Variation ' || coalesce(v.variation_number::text, '') || ' ' || q.ev || coalesce(': ' || left(v.description, 120), '')
           || coalesce(' (' || to_char(v.amount, 'FM$999,999,990.00') || ')', '') || ', now ' || coalesce(v.status, 'status not set'),
         CASE WHEN q.ev = 'raised' THEN v.amount END, NULL, 'on_job', 'job_variations', v.id::text
  FROM public.job_variations v
  CROSS JOIN LATERAL (VALUES ('raised', v.created_at), ('sent', v.sent_at), ('accepted', v.accepted_at),
       ('declined', v.declined_at)) q(ev, at)
  WHERE v.job_id = ANY (p_job_ids) AND q.at IS NOT NULL AND q.at <= p_as_of AND v.created_at <= p_as_of
  -- purchase orders and work orders
  UNION ALL
  SELECT p.job_id, p.created_at, 'observed', 'purchase_order',
         'Purchase order ' || coalesce(p.po_number, 'without a number') || coalesce(' to ' || p.supplier_name, '')
           || coalesce(' (' || to_char(p.total, 'FM$999,999,990.00') || ')', '') || ', ' || coalesce(p.status, 'status not set')
           || coalesce(', delivery ' || to_char(coalesce(p.confirmed_delivery_date, p.delivery_date), 'Dy FMDD Mon YYYY'), ''),
         p.total, p.supplier_name, 'on_job', 'purchase_orders', p.id::text
  FROM public.purchase_orders p WHERE p.job_id = ANY (p_job_ids) AND p.created_at <= p_as_of
  UNION ALL
  SELECT w.job_id, q.at, 'observed', 'work_order',
         'Work order ' || coalesce(w.wo_number, 'without a number') || ' ' || q.ev || coalesce(' (' || w.trade_name || ')', '')
           || ', now ' || coalesce(w.status, 'status not set'),
         NULL, w.trade_name, 'on_job', 'work_orders', w.id::text
  FROM public.work_orders w
  CROSS JOIN LATERAL (VALUES ('created', w.created_at), ('sent', w.sent_at), ('accepted', w.accepted_at),
       ('completed', w.completed_at)) q(ev, at)
  WHERE w.job_id = ANY (p_job_ids) AND q.at IS NOT NULL AND q.at <= p_as_of AND w.created_at <= p_as_of
  -- rectification: callback jobs opened against this job
  UNION ALL
  SELECT c.callback_parent_id, c.created_at, 'observed', 'rectification',
         'Callback job ' || coalesce(c.job_number, 'without a number') || ' opened (' || coalesce(c.status::text, '?') || ')',
         NULL, NULL, 'on_job', 'jobs', c.id::text
  FROM public.jobs c WHERE c.callback_parent_id = ANY (p_job_ids) AND c.created_at <= p_as_of
  -- make-safe milestones
  UNION ALL
  SELECT je.job_id, je.created_at, 'observed',
         CASE WHEN je.event_type = 'makesafe_reattend' THEN 'rectification' ELSE 'makesafe' END,
         CASE je.event_type
           WHEN 'makesafe_created' THEN 'Make-safe card created'
           WHEN 'makesafe_report_sent_at_derived' THEN 'Make-safe report sent to the builder'
           WHEN 'makesafe_pack_sent_at_derived' THEN 'Make-safe pack sent to the builder'
           WHEN 'makesafe_portal_report_done' THEN 'Builder portal report marked done'
           WHEN 'makesafe_reattend' THEN 'Make-safe re-attend opened'
           WHEN 'makesafe_cancelled' THEN 'Make-safe cancelled'
           ELSE 'Make-safe stage: ' || replace(coalesce(je.detail_json->>'substatus', je.detail_json->>'new_substatus',
                                                         je.detail_json->>'to', '?'), '_', ' ') END,
         NULL, NULL, 'on_job', 'job_events', je.id::text
  FROM public.job_events je
  WHERE je.job_id = ANY (p_job_ids) AND je.created_at <= p_as_of
    -- (a trade's make-safe report is an app event the store lets close a visit: below, from ae)
    AND je.event_type IN ('makesafe_created', 'makesafe_report_sent_at_derived',
                          'makesafe_pack_sent_at_derived', 'makesafe_portal_report_done', 'makesafe_reattend',
                          'makesafe_substatus_changed', 'makesafe_cancelled')
  -- app events the ledger store lets close a matter: one line per event type,
  -- matter and Perth day, citing the newest (ae); its state is its event_type
  UNION ALL
  SELECT e.job_id, e.created_at, 'observed',
         CASE WHEN e.event_type = 'quote_sent' THEN 'quote'
              WHEN e.event_type IN ('invoice.emailed', 'acceptance_invoice_sent', 'payment_link_sent') THEN 'invoice'
              WHEN e.event_type IN ('payment_received', 'payment_recorded') THEN 'payment'
              WHEN e.event_type IN ('clock.clock_on', 'clock.clock_off') THEN 'attendance'
              ELSE 'makesafe' END,
         CASE e.event_type
          WHEN 'quote_sent' THEN 'App recorded ' || CASE WHEN qd.id IS NULL THEN 'a quote'
                                     ELSE 'quote ' || coalesce(qd.quote_number, 'without a number') || coalesce(' v' || qd.version, '') END
               || ' sent ' || CASE WHEN nullif(btrim(e.d ->> 'sent_to'), '') IS NULL THEN 'with no address recorded'
                                   WHEN jc.cmail IS NOT NULL AND position(jc.cmail IN lower(e.d ->> 'sent_to')) > 0 THEN 'to the customer'
                                   ELSE 'to another address' END
               || CASE WHEN e.not_received THEN ', but every email of it bounced or failed: not received' ELSE '' END
          WHEN 'invoice.emailed' THEN 'App recorded invoice ' || coalesce(nullif(btrim(e.d ->> 'invoice_number'), ''), 'without a number')
               || ' emailed ' || CASE WHEN nullif(btrim(e.d ->> 'to'), '') IS NULL THEN 'with no address recorded'
                                      WHEN jc.cmail IS NOT NULL AND position(jc.cmail IN lower(e.d ->> 'to')) > 0 THEN 'to the customer'
                                      ELSE 'to another address' END
               || coalesce(' via ' || nullif(btrim(e.d ->> 'via'), ''), '')
          WHEN 'acceptance_invoice_sent' THEN 'App recorded deposit invoice '
               || coalesce(nullif(btrim(e.d ->> 'invoice_number'), ''), 'without a number') || ' sent on acceptance'
               || CASE WHEN jsonb_typeof(e.d -> 'deposit_amount') = 'number'
                       THEN ' (deposit ' || to_char((e.d ->> 'deposit_amount')::numeric, 'FM$999,999,990.00') || ')' ELSE '' END
               || '; email ' || CASE WHEN e.d ->> 'branded_email_sent' = 'true' THEN 'sent' ELSE 'not recorded as sent' END
               || ', text ' || CASE WHEN e.d ->> 'sms_sent' = 'true' THEN 'sent' ELSE 'not recorded as sent' END
          WHEN 'payment_link_sent' THEN 'App recorded a payment link for invoice '
               || coalesce(nullif(btrim(e.d ->> 'invoice_number'), ''), 'without a number') || ' sent'
               || CASE WHEN e.d ->> 'sms_sent' = 'true' THEN ' by text' ELSE ' (the text was not recorded as sent)' END
          WHEN 'payment_received' THEN 'App recorded invoice ' || coalesce(nullif(btrim(e.d ->> 'invoice_number'), ''), 'without a number')
               || ' paid in full'
               || coalesce(' (' || nullif(concat_ws(', ', CASE WHEN jsonb_typeof(e.d -> 'amount_paid') = 'number'
                                                              THEN to_char((e.d ->> 'amount_paid')::numeric, 'FM$999,999,990.00') END,
                                                    'paid ' || to_char(e.paid_day, 'Dy FMDD Mon YYYY')), '') || ')', '')
          WHEN 'payment_recorded' THEN 'App recorded a payment' || coalesce(' on invoice ' || nullif(btrim(e.d ->> 'invoice_number'), ''), '')
          WHEN 'clock.clock_on' THEN 'Crew clocked on' || coalesce(' for the ' || to_char(ca.scheduled_date, 'Dy FMDD Mon YYYY') || ' booking', '')
          WHEN 'clock.clock_off' THEN 'Crew clocked off' || coalesce(' for the ' || to_char(ca.scheduled_date, 'Dy FMDD Mon YYYY') || ' booking', '')
               || CASE WHEN e.n = 1 AND jsonb_typeof(e.d -> 'net_hours') = 'number'
                       THEN ' (' || rtrim(to_char((e.d ->> 'net_hours')::numeric, 'FM999990.99'), '.') || ' hours net)'
                       WHEN e.n > 1 AND e.net_n = e.n
                       THEN ' (' || rtrim(to_char(e.net_sum, 'FM999990.99'), '.') || ' hours net that day, all stints added)'
                       ELSE '' END
          WHEN 'makesafe_report_submitted' THEN 'Trade make-safe report submitted'
          ELSE 'Trade roof report submitted' END
         || CASE WHEN e.n > 1 THEN '; recorded ' || e.n || ' times that day, first at '
                                   || to_char(e.first_at AT TIME ZONE 'Australia/Perth', 'HH24:MI') ELSE '' END,
         NULL, NULL, 'on_job', 'job_events', e.id::text
  FROM ae e
  LEFT JOIN public.job_documents qd ON qd.id = CASE WHEN e.doc ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN e.doc::uuid END
  LEFT JOIN public.job_assignments ca ON ca.id = e.asg_id
  LEFT JOIN (SELECT jb.id, lower(nullif(btrim(jb.client_email), '')) AS cmail FROM public.jobs jb WHERE jb.id = ANY (p_job_ids)) jc
    ON jc.id = e.job_id
  -- CRM tasks
  UNION ALL
  SELECT e.job_id, coalesce(e.event_at, e.occurred_at), 'observed', 'task',
         'CRM task ' || replace(replace(e.event_type, 'ghl.task_', ''), '_', ' ') || coalesce(': ' || left(e.payload->>'title', 160), '')
           || coalesce(', due ' || (e.payload->>'due_date'), ''),
         NULL, NULL, 'on_job', 'business_events', e.id::text
  FROM public.business_events e
  WHERE e.job_id = ANY (p_job_ids) AND e.event_type LIKE 'ghl.task\_%' AND coalesce(e.recorded_at, e.occurred_at) <= p_as_of
  -- staff notes: their words, no rule
  UNION ALL
  SELECT c.job_id, c.at, 'observed', 'note', 'Staff note: ' || c.words, NULL, NULL, c.placement, c.source_table, c.source_id
  FROM msg c WHERE c.is_note AND btrim(coalesce(c.words, '')) <> ''
  UNION ALL
  SELECT je.job_id, je.created_at, 'observed', 'note',
         'Staff note: ' || left(regexp_replace(coalesce(je.detail_json->>'text', je.detail_json->>'note', ''), '\s+', ' ', 'g'), 300),
         NULL, NULL, 'on_job', 'job_events', je.id::text
  FROM public.job_events je
  WHERE je.job_id = ANY (p_job_ids) AND je.event_type IN ('note', 'note_added') AND je.created_at <= p_as_of
    AND btrim(coalesce(je.detail_json->>'text', je.detail_json->>'note', '')) <> ''
    AND NOT EXISTS (SELECT 1 FROM msg c WHERE c.job_id = je.job_id AND c.is_note
                    AND abs(extract(epoch FROM c.at - je.created_at)) < 300)
  -- documents read into evidence (file name only) and documents sent
  UNION ALL
  SELECT e.job_id, coalesce(e.event_at, e.occurred_at), 'observed', 'document',
         'Document read: ' || coalesce(nullif(e.payload->'document'->>'file_name', ''), nullif(e.payload->'document'->>'label', ''), 'unnamed file'),
         NULL, NULL, 'on_job', 'business_events', e.id::text
  FROM public.business_events e
  WHERE e.job_id = ANY (p_job_ids) AND e.event_type = 'document.text_extracted' AND coalesce(e.recorded_at, e.occurred_at) <= p_as_of
  UNION ALL
  SELECT d.job_id, d.sent_at, 'observed', 'document',
         initcap(replace(d.type, '_', ' ')) || ' sent' || coalesce(': ' || left(d.file_name, 120), ''),
         NULL, NULL, 'on_job', 'job_documents', d.id::text
  FROM public.job_documents d
  WHERE d.job_id = ANY (p_job_ids) AND d.type NOT ILIKE '%quote%' AND d.sent_at IS NOT NULL AND d.sent_at <= p_as_of
 )
 SELECT m.job_id, m.at, (m.at AT TIME ZONE 'Australia/Perth')::date AS perth_date, m.time_basis, m.kind,
        replace(replace(m.what, chr(8212), ', '), chr(8211), '-') AS what, m.amount, m.party, m.placement,
        m.source_table, m.source_id,
        -- the state of the record the row cites, so no reader infers it from the words:
        -- invoices draft | issued | paid | voided; documents generated | sent |
        -- not_delivered (every email of it bounced or failed, never viewed or answered) |
        -- viewed | accepted | declined | superseded (as of p_as_of); system emails sent |
        -- delivered | accepted (with a sent time) | not_sent | bounced | failed | queued;
        -- crew bookings scheduled | attended (started, completed, or a status-only
        -- completion) | cancelled (not standing); app events the ledger store lets close
        -- a matter: their event_type (quote_sent, invoice.emailed, payment_received,
        -- clock.clock_off ...), or not_delivered when the event names a document whose
        -- every email bounced or failed (never viewed or answered); every other row
        -- null. Crew planning's confirmation is never read.
        CASE m.source_table
         WHEN 'xero_invoices' THEN (SELECT CASE WHEN i.st = 'DRAFT' THEN 'draft' WHEN i.st = 'PAID' THEN 'paid'
                                               WHEN i.st IN ('VOIDED', 'DELETED') THEN 'voided'
                                               WHEN i.st IN ('AUTHORISED', 'SUBMITTED') THEN 'issued' END
                                    FROM inv i WHERE i.id::text = m.source_id)
         WHEN 'job_documents' THEN (SELECT CASE WHEN d.accepted_at <= p_as_of THEN 'accepted' WHEN d.declined_at <= p_as_of THEN 'declined'
                                               WHEN d.superseded_at <= p_as_of THEN 'superseded' WHEN d.viewed_at <= p_as_of THEN 'viewed'
                                               WHEN d.sent_at <= p_as_of AND (EXISTS (SELECT 1 FROM public.email_events ee WHERE ee.metadata ->> 'document_id' = d.id::text AND ee.created_at <= p_as_of)
                                                       AND NOT EXISTS (SELECT 1 FROM public.email_events ee WHERE ee.metadata ->> 'document_id' = d.id::text
                                                        AND lower(coalesce(ee.status, '')) IN ('sent', 'delivered', 'accepted') AND ee.sent_at IS NOT NULL AND ee.sent_at <= p_as_of)
                                                       AND NOT coalesce(d.viewed_at <= p_as_of OR d.accepted_at <= p_as_of OR d.declined_at <= p_as_of, false)) THEN 'not_delivered'
                                               WHEN d.sent_at <= p_as_of THEN 'sent' ELSE 'generated' END
                                    FROM public.job_documents d
                                    WHERE d.id = CASE WHEN m.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                                      THEN m.source_id::uuid END)
         -- a system email: its status once it went out with a sent time, else not_sent
         -- (bounced, failed and queued say so)
         WHEN 'email_events' THEN (SELECT CASE WHEN lower(coalesce(ee.status, '')) IN ('sent', 'delivered', 'accepted')
                                                THEN CASE WHEN ee.sent_at IS NOT NULL THEN lower(ee.status) ELSE 'not_sent' END
                                               ELSE coalesce(nullif(lower(btrim(ee.status)), ''), 'unknown') END
                                    FROM public.email_events ee
                                    WHERE ee.id = CASE WHEN m.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                                       THEN m.source_id::uuid END)
         WHEN 'job_assignments' THEN (SELECT CASE WHEN a.mirror THEN NULL
                                                 WHEN a.completed_at <= p_as_of OR a.started_at <= p_as_of
                                                      OR (lower(coalesce(a.status, '')) IN ('complete', 'completed')
                                                          AND a.completed_at IS NULL AND a.started_at IS NULL
                                                          -- a status-only completion counts from the end of its booked
                                                          -- day, or from now while that is still ahead
                                                          AND (a.scheduled_date IS NULL OR least(((a.scheduled_date + 1)::timestamp
                                                               AT TIME ZONE 'Australia/Perth') - interval '1 second', now()) <= p_as_of)) THEN 'attended'
                                                 WHEN lower(coalesce(a.status, '')) IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined')
                                                 THEN 'cancelled'
                                                 ELSE 'scheduled' END
                                      FROM asg a WHERE a.id::text = m.source_id)
         WHEN 'job_events' THEN (SELECT CASE WHEN e.not_received THEN 'not_delivered' ELSE e.event_type END
                                  FROM ae e WHERE e.id::text = m.source_id)
        END AS state,
        CASE WHEN m.source_table = 'job_assignments' THEN (SELECT a.created_at FROM asg a WHERE a.id::text = m.source_id AND NOT a.mirror) END
         AS made_at
 FROM m WHERE m.at IS NOT NULL
 ORDER BY m.job_id, m.at, m.kind COLLATE "C", m.source_id COLLATE "C", m.what COLLATE "C"
$fn$;
COMMENT ON FUNCTION public.context_job_record_timeline(uuid[], timestamptz) IS
 'Job record (20261006011000), story fixes (20261006033000), story safety (20261006040000): a booking change on a ghost or observer row (is_ghost, or role observer), or one its writer tags as a ghost copy, is booking_mirror (an observer copy, never "Booking made"); a supplier bill whose lines name other jobs says it is shared and gives this job''s lines; first contact never comes from a text dated before the job''s lead window (context_job_record_messages). Earlier, story fixes: app events the ledger store lets close a matter (quote_sent, invoice.emailed, acceptance_invoice_sent, payment_link_sent, payment_received, payment_recorded, clock.clock_on, clock.clock_off, makesafe_report_submitted, roof_report_submitted) are lines citing job_events, one per event type, matter and Perth day (the newest cited, the count named; a folded clock-off gives the day''s net hours, every stint added, or none), each with state = its event_type, or not_delivered when it names a document whose every email bounced or failed and the customer never viewed or answered it; rows sort by time, then kind, source and words in C (byte) order. Earlier: one row per record milestone per job, oldest first (job created, first contact, site visit, quote version events with value, folded status changes, invoices, payments, credits, supplier bills, system emails, bookings, booking changes (never a crew-planning mark: a lock, a status mark, or a move to the same date), attendance, variations, purchase and work orders, rectification, make-safe, tasks, staff notes, documents). time_basis observed|date_only|stamp|scheduled. state: the cited record''s state (invoices draft, issued, paid, voided; documents generated, sent, viewed, accepted, declined, superseded; crew bookings scheduled, attended (started, completed, or status complete with neither recorded), cancelled (not standing: cancelled, deleted, draft, disputed, declined); else null); made_at: a crew booking''s created time. A status-only completion is timed at the end of its booked Perth day, or now while that is still ahead. Rows recorded after p_as_of are ignored; mutable rows are read as now. Service role only.';

CREATE OR REPLACE FUNCTION public.context_job_record_loops(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, rule text, loop_key text, shown_as text, owner text, counterparty text, what text, why text,
 opened_at timestamptz, due_date date, amount numeric, about_key text, closes_when text, source_table text, source_id text,
 placement text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH j AS (
  SELECT jb.id, jb.job_number, jb.status::text AS status, jb.type::text AS type,
         nullif(btrim(jb.ghl_contact_id), '') AS ccontact, nullif(btrim(jb.xero_contact_id), '') AS jxc,
         CASE WHEN jb.accepted_at <= p_as_of THEN jb.accepted_at END AS accepted_at,
         CASE WHEN jsonb_typeof(jb.pricing_json->'totalIncGST') = 'number' THEN (jb.pricing_json->>'totalIncGST')::numeric END AS price_inc,
         jb.quoted_value, jb.created_at, jb.site_address,
         (p_as_of AT TIME ZONE 'Australia/Perth')::date AS today
  FROM public.jobs jb WHERE jb.id = ANY (p_job_ids)
 ),
 jv AS (  -- job value exactly as the reference: price_inc, else quoted_value (zero counts as none);
           -- accepted, issued and the checks against the value: context_job_record_value
  SELECT j.*, v.value, v.value_basis, v.accepted, v.accepted_at AS acc_at, v.accepted_by, v.issued, v.checks,
         jsonb_array_length(v.checks) > 0 AS unconfirmed
  FROM j JOIN public.context_job_record_value(p_job_ids, p_as_of) v ON v.job_id = j.id
 ),
 msg AS (SELECT * FROM public.context_job_record_messages(p_job_ids, p_as_of)),
 bm AS (SELECT * FROM msg WHERE msg.source_table = 'business_events' AND msg.is_msg),
 outs AS (SELECT * FROM bm WHERE bm.direction = 'outbound' AND bm.customer_side AND coalesce(bm.sent_by_kind, '') <> 'workflow'),
 ins AS (SELECT * FROM bm WHERE bm.direction = 'inbound' AND bm.customer_side AND bm.channel IN ('sms', 'email')),
 -- (story safety, sixth review) what this customer sent off this job, recorded by p_as_of and
 -- no copy of another, each at its CRM time when it is a CRM text loaded later from the cache
 -- (never one whose CRM time is no longer known, nor one the CRM dates more than 30 days
 -- before the job was created, as the job's own texts are read: context_job_record_messages):
 --  placed on no job (placed null): the placement queue's rows that could be this job's,
 --  their admin-bucket rows and rows on a holding job (context_unplaced_for_job), and every
 --  other row of their CRM contact placed on no job whatever the ladder made of it
 --  (attribution status null or empty, which no queue holds: SWF-261111's answered call
 --  after the quote);
 --  placed on their other jobs (the same CRM contact; placed: that job's number).
 offr AS (
  SELECT o.job_id, o.id, o.placed, o.queued, o.event_type, o.channel, o.contact_id, coalesce(ct.crm_at, o.event_at, o.occurred_at) AS at,
         coalesce(o.metadata #>> '{party_roles,sender_role}', o.metadata #>> '{party_roles,counterpart_role}',
                  CASE WHEN o.event_type LIKE 'client.%' THEN 'customer' END) AS srole,
         lower(coalesce(o.payload ->> 'call_status', substring(o.call_text FROM 'Provider status: ([A-Za-z_-]+)'), '')) AS call_status,
         (o.channel = 'call' OR o.event_type IN ('client.call_logged', 'client.call_complete', 'call.transcript_completed')) AS is_call
  FROM (
   SELECT j.id AS job_id, j.created_at AS job_created, NULL::text AS placed, true AS queued, u.id, u.event_type, u.channel, u.contact_id, u.source,
          u.payload, u.metadata, u.provider_message_id, u.event_at, u.occurred_at, u.recorded_at,
          CASE WHEN u.channel = 'call' OR u.event_type LIKE '%call%' THEN public.context_event_text(u) END AS call_text
   FROM j CROSS JOIN LATERAL public.context_unplaced_for_job(j.id) u
   WHERE u.direction = 'inbound'
   UNION ALL
   SELECT j.id, j.created_at, NULL::text, false, e.id, e.event_type, e.channel, e.contact_id, e.source,
          e.payload, e.metadata, e.provider_message_id, e.event_at, e.occurred_at, e.recorded_at,
          CASE WHEN e.channel = 'call' OR e.event_type LIKE '%call%' THEN public.context_event_text(e) END
   FROM j JOIN public.business_events e ON j.ccontact IS NOT NULL AND e.contact_id = j.ccontact AND e.job_id IS NULL
   WHERE e.direction = 'inbound' AND coalesce(e.attribution_status, '') NOT IN ('pending_luna', 'unplaced', 'admin_bucket', 'automated')
   UNION ALL
   SELECT j.id, j.created_at, coalesce(oj.job_number, 'without a number'), false, e.id, e.event_type, e.channel, e.contact_id, e.source,
          e.payload, e.metadata, e.provider_message_id, e.event_at, e.occurred_at, e.recorded_at,
          CASE WHEN e.channel = 'call' OR e.event_type LIKE '%call%' THEN public.context_event_text(e) END
   FROM j JOIN public.business_events e ON j.ccontact IS NOT NULL AND e.contact_id = j.ccontact AND e.job_id IS NOT NULL AND e.job_id <> j.id
   JOIN public.jobs oj ON oj.id = e.job_id
   WHERE e.direction = 'inbound' AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1')
  ) o
  CROSS JOIN LATERAL (SELECT CASE WHEN o.source = 'ghl_sms_cache_backfill'
                                  THEN public.context_job_record_crm_time(o.source, o.contact_id,
                                         coalesce(nullif(btrim(o.payload ->> 'ghl_message_id'), ''), substring(o.provider_message_id FROM '^ghl:(.+)$')), o.job_id)
                             END AS crm_at) ct
  WHERE o.metadata #>> '{duplicate_of}' IS NULL AND coalesce(o.recorded_at, o.occurred_at) <= p_as_of
    AND coalesce(ct.crm_at, o.event_at, o.occurred_at) <= p_as_of
    AND NOT (o.source = 'ghl_sms_cache_backfill' AND ct.crm_at IS NULL)
    AND NOT coalesce(ct.crm_at < o.job_created - interval '30 days', false)
 ),
 -- (story safety, fourth and sixth review) the customer in touch by any other way the record
 -- knows: an answered call of theirs on the job, their email from the old inbox (on the job,
 -- or from their address on no job), a text, email or answered call of theirs off this job
 -- (offr: placed on no job, named so, or on their other job, named by its number), or their
 -- mail withheld because they have another job. A text or email of theirs on the job closes
 -- R7 (ins); one of these after the quote leaves whose move unclear. A CRM text they sent
 -- before the quote is never contact since it, however late it was loaded.
 tch AS (
  SELECT m.job_id, m.at, CASE WHEN m.source_table = 'inbox_events' THEN 'an email' ELSE 'an answered call' END AS what,
         CASE WHEN m.placement = 'not_placed' THEN 'not placed on any job' WHEN m.source_table = 'inbox_events' THEN 'from the old inbox' END AS note
  FROM msg m
  WHERE m.customer_side AND m.direction = 'inbound'
    AND (m.source_table = 'inbox_events'
         OR (m.call_answered AND (m.channel = 'call' OR m.event_type IN ('client.call_logged', 'client.call_complete', 'call.transcript_completed'))))
  UNION ALL
  SELECT o.job_id, o.at, CASE WHEN o.channel = 'sms' THEN 'a text' WHEN o.channel = 'email' THEN 'an email' ELSE 'an answered call' END,
         CASE WHEN o.placed IS NULL THEN 'not placed on any job' ELSE 'on job ' || o.placed END
  FROM offr o
  WHERE o.srole = 'customer'
    AND (o.channel IN ('sms', 'email')
         OR (o.is_call AND (o.event_type = 'call.transcript_completed' OR o.call_status IN ('completed', 'answered'))))
  UNION ALL
  SELECT w.jid, w.received_at, 'an email', 'not placed on any job; it may be about another of their jobs'
  FROM public.context_job_record_legacy_mail(p_job_ids, p_as_of) w WHERE w.placement = 'withheld'
 ),
 inv AS (
  SELECT x.id, x.job_id, x.invoice_number, x.reference, x.contact_name, x.xero_contact_id, x.xero_invoice_id,
         x.total, x.amount_due, x.amount_paid, x.invoice_date, x.due_date, x.created_at,
         upper(coalesce(x.status, 'NONE')) AS st, upper(coalesce(x.invoice_type, 'ACCREC')) AS itype,
         'invoice:' || lower(coalesce(nullif(btrim(x.invoice_number), ''), 'id-' || left(x.id::text, 8))) AS about,
         -- who the invoice is addressed to: the customer (the builder on builder work), or a
         -- neighbour, strata, another party or another payer (context_job_record_payer_role)
         CASE WHEN upper(coalesce(x.invoice_type, 'ACCREC')) = 'ACCREC'
              THEN public.context_job_record_payer_role(x.job_id, j.type, j.jxc, x.xero_contact_id, x.job_contact_id) END AS payer_role
  FROM public.xero_invoices x JOIN j ON j.id = x.job_id
  WHERE x.job_id = ANY (p_job_ids) AND coalesce(x.created_at, x.synced_at, '-infinity'::timestamptz) <= p_as_of
 ),
 sales AS (SELECT * FROM inv WHERE inv.itype = 'ACCREC'),
 qd AS (  -- quote documents as the reference reads them (type contains "quote"), stamps after p_as_of unset
  SELECT d.id, d.job_id, d.quote_number, d.version, d.created_at,
         CASE WHEN d.sent_at <= p_as_of THEN d.sent_at END AS sent_at,
         CASE WHEN d.viewed_at <= p_as_of THEN d.viewed_at END AS viewed_at,
         CASE WHEN d.accepted_at <= p_as_of THEN d.accepted_at END AS accepted_at,
         CASE WHEN d.declined_at <= p_as_of THEN d.declined_at END AS declined_at,
         CASE WHEN d.superseded_at <= p_as_of THEN d.superseded_at END AS superseded_at
  FROM public.job_documents d
  WHERE d.job_id = ANY (p_job_ids) AND d.type ILIKE '%quote%' AND d.created_at <= p_as_of
 ),
 -- accepted: the job row, an accepted quote, or a paid deposit invoice (context_job_record_value)
 acc AS (SELECT jv.id AS job_id, jv.accepted FROM jv),
 asg AS (
  SELECT a.id, a.job_id, a.scheduled_date, a.status, a.created_at, a.updated_at, a.started_at, a.completed_at,
         a.crew_name, a.assignment_type,
         coalesce(a.is_ghost, false) OR coalesce(a.role, '') = 'observer' AS mirror
  FROM public.job_assignments a WHERE a.job_id = ANY (p_job_ids) AND a.created_at <= p_as_of
 ),
 vo AS (
  SELECT j.id AS job_id, o.id, o.visit_start, o.outcome, o.quote_owed, o.supersedes
  FROM j JOIN public.visit_outcomes o ON o.job_id = j.id OR (j.ccontact IS NOT NULL AND o.contact_id = j.ccontact)
  WHERE o.recorded_at <= p_as_of
 ),
 lp AS (
  -- R1 overdue (reference rule). Owed by whoever the invoice is addressed to: the
  -- customer (the builder on builder work), else another party, named with its role
  SELECT i.job_id, 'R1_overdue'::text AS rule, i.id::text AS sid, 'xero_invoices'::text AS tbl, 'loop'::text AS shown_as,
         CASE WHEN i.payer_role IN ('customer', 'builder') THEN 'customer' ELSE 'third_party' END::text AS owner, 'us'::text AS counterparty,
         coalesce(i.invoice_number, 'An invoice without a number') || ' ' || to_char(i.amount_due, 'FM$999,999,990.00')
           || ' overdue from ' || coalesce(i.contact_name, 'an unnamed contact') || CASE i.payer_role WHEN 'builder' THEN ' (the builder)' WHEN 'neighbour' THEN ' (a neighbour paying part of this job)'
                WHEN 'strata' THEN ' (the strata, paying part of this job)' WHEN 'other_party' THEN ' (another party on this job)'
                WHEN 'other_payer' THEN ' (another payer, not this job''s customer)' ELSE '' END || ' since '
           || to_char(i.due_date, 'Dy FMDD Mon YYYY') || ' (' || (jv.today - i.due_date) || ' days)' AS what,
         'Xero shows it ' || lower(i.st) || ' with ' || to_char(i.amount_due, 'FM$999,999,990.00') || ' due and the due date passed' AS why,
         (i.due_date::timestamp AT TIME ZONE 'Australia/Perth') AS opened_at, i.due_date AS due, i.amount_due AS amount, i.about,
         'Xero shows nothing owing (paid, credited, voided or deleted)' AS closes_when
  FROM sales i JOIN jv ON jv.id = i.job_id
  WHERE i.st IN ('AUTHORISED', 'SUBMITTED') AND coalesce(i.amount_due, 0) > 0 AND i.due_date IS NOT NULL AND i.due_date < jv.today
  UNION ALL
  -- R2 part paid (reference rule)
  SELECT i.job_id, 'R2_part_paid', i.id::text, 'xero_invoices', 'loop',
         CASE WHEN i.payer_role IN ('customer', 'builder') THEN 'customer' ELSE 'third_party' END, 'us',
         coalesce(i.invoice_number, 'An invoice without a number') || ' part paid: ' || to_char(i.amount_paid, 'FM$999,999,990.00')
           || ' of ' || to_char(i.total, 'FM$999,999,990.00') || ', ' || to_char(i.amount_due, 'FM$999,999,990.00') || ' still owing from '
           || coalesce(i.contact_name, 'an unnamed contact') || CASE i.payer_role WHEN 'builder' THEN ' (the builder)' WHEN 'neighbour' THEN ' (a neighbour paying part of this job)'
                WHEN 'strata' THEN ' (the strata, paying part of this job)' WHEN 'other_party' THEN ' (another party on this job)'
                WHEN 'other_payer' THEN ' (another payer, not this job''s customer)' ELSE '' END,
         'Xero shows a payment and an amount still due', coalesce(i.invoice_date::timestamp AT TIME ZONE 'Australia/Perth', i.created_at),
         i.due_date, i.amount_due, i.about, 'Xero shows nothing owing'
  FROM sales i
  WHERE i.st IN ('AUTHORISED', 'SUBMITTED') AND coalesce(i.amount_due, 0) > 0 AND coalesce(i.amount_paid, 0) > 0
  UNION ALL
  -- M1 money due, not yet overdue
  SELECT i.job_id, 'M1_money_due', i.id::text, 'xero_invoices', 'loop',
         CASE WHEN i.payer_role IN ('customer', 'builder') THEN 'customer' ELSE 'third_party' END, 'us',
         coalesce(i.invoice_number, 'An invoice without a number') || ' ' || to_char(i.amount_due, 'FM$999,999,990.00')
           || ' owing from ' || coalesce(i.contact_name, 'an unnamed contact') || CASE i.payer_role WHEN 'builder' THEN ' (the builder)' WHEN 'neighbour' THEN ' (a neighbour paying part of this job)'
                WHEN 'strata' THEN ' (the strata, paying part of this job)' WHEN 'other_party' THEN ' (another party on this job)'
                WHEN 'other_payer' THEN ' (another payer, not this job''s customer)' ELSE '' END
           || coalesce(', due ' || to_char(i.due_date, 'Dy FMDD Mon YYYY'), ', no due date in Xero'),
         'Xero shows it ' || lower(i.st) || ' with an amount due, not yet overdue',
         coalesce(i.invoice_date::timestamp AT TIME ZONE 'Australia/Perth', i.created_at), i.due_date, i.amount_due, i.about,
         'Xero shows nothing owing'
  FROM sales i JOIN jv ON jv.id = i.job_id
  WHERE i.st IN ('AUTHORISED', 'SUBMITTED') AND coalesce(i.amount_due, 0) > 0 AND (i.due_date IS NULL OR i.due_date >= jv.today)
  UNION ALL
  -- R3 draft not issued (reference rule). (Story safety, sixth review) When the job's issued
  -- invoices for the same stage of the same job reference (its stem, SWF-261423, and the
  -- stage its suffix names: DEP a deposit, FIN, BAL or FINBAL the final) already reach the
  -- draft's amount, the stage is billed (a deposit split between two payers, SWF-261423's
  -- DEP25 and B-DEP25 against the full DEP50 draft): issuing the draft would bill it twice,
  -- so it is a check naming them, never our move
  SELECT i.job_id, 'R3_draft', i.id::text, 'xero_invoices', CASE WHEN dup.n IS NOT NULL THEN 'check' ELSE 'loop' END, 'us', 'customer',
         'Draft invoice ' || coalesce(i.invoice_number, 'without a number') || ' ' || to_char(i.total, 'FM$999,999,990.00') || ' to '
           || coalesce(i.contact_name, 'an unnamed contact') || ' not issued since ' || to_char(i.invoice_date, 'Dy FMDD Mon YYYY')
           || coalesce(' (' || (SELECT string_agg(coalesce(o.invoice_number, 'unnumbered') || ' ' || lower(o.st), ', '
                                                  ORDER BY o.invoice_number COLLATE "C", o.id)
                                FROM sales o WHERE o.job_id = i.job_id AND o.id <> i.id AND o.reference = i.reference)
                       || ' on the same reference)', '')
           || coalesce('; it may duplicate the issued ' || CASE WHEN dup.n IS NULL THEN NULL WHEN ds.stage = 'DEP' THEN 'deposit' ELSE 'final' END || ' invoice'
                       || CASE WHEN dup.n > 1 THEN 's ' ELSE ' ' END || dup.nums || ' on the same job reference ('
                       || to_char(dup.total, 'FM$999,999,990.00') || ')', ''),
         'A draft in Xero cannot be paid; it is more than a day old'
           || CASE WHEN dup.n IS NOT NULL THEN '; issued invoices for the same stage of the same job reference already reach its amount, '
                                                || 'so issuing it may bill that stage twice' ELSE '' END,
         (i.invoice_date::timestamp AT TIME ZONE 'Australia/Perth'), NULL::date, i.total, i.about,
         'Approved (issued), voided or deleted in Xero'
  FROM sales i
  -- the job reference's stem and the stage its suffix names
  CROSS JOIN LATERAL (SELECT upper(substring(coalesce(i.reference, '') FROM '^(SW[A-Za-z]{0,4}-[0-9]+)')) AS stem,
                             CASE WHEN upper(coalesce(i.reference, '')) ~ '-DEP[0-9]{0,3}(-[A-Z])?$' THEN 'DEP'
                                  WHEN upper(coalesce(i.reference, '')) ~ '-(FINBAL|FIN|BAL)[0-9]{0,3}(-[A-Z])?$' THEN 'FIN' END AS stage) ds
  LEFT JOIN LATERAL (
   SELECT count(*) AS n, sum(coalesce(o.total, 0)) AS total,
          string_agg(coalesce(o.invoice_number, 'unnumbered'), ', ' ORDER BY o.invoice_number COLLATE "C", o.id) AS nums
   FROM sales o
   WHERE ds.stem IS NOT NULL AND ds.stage IS NOT NULL
     AND o.job_id = i.job_id AND o.id <> i.id AND o.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')
     AND upper(substring(coalesce(o.reference, '') FROM '^(SW[A-Za-z]{0,4}-[0-9]+)')) = ds.stem
     AND CASE WHEN upper(coalesce(o.reference, '')) ~ '-DEP[0-9]{0,3}(-[A-Z])?$' THEN 'DEP'
              WHEN upper(coalesce(o.reference, '')) ~ '-(FINBAL|FIN|BAL)[0-9]{0,3}(-[A-Z])?$' THEN 'FIN' END = ds.stage
   HAVING count(*) > 0 AND sum(coalesce(o.total, 0)) >= coalesce(i.total, 0) - 1) dup ON true
  WHERE i.st = 'DRAFT' AND i.invoice_date IS NOT NULL
    AND extract(epoch FROM p_as_of - (i.invoice_date::timestamp AT TIME ZONE 'Australia/Perth')) > 86400
  UNION ALL
  -- R4 missed call not returned (reference rule)
  SELECT c.job_id, 'R4_missed_call', c.source_id, 'business_events', 'loop', 'us', 'customer',
         'Missed call from the customer ' || to_char(c.at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon HH24:MI')
           || '; no call, text or email to the customer since',
         'The call record shows it was not answered (' || coalesce(substring(c.words FROM 'Provider status: ([A-Za-z_-]+)'), 'missed') || ')',
         c.at, NULL::date, NULL::numeric, 'contact:missed-call', 'A call, text or email from us to the customer after it'
  FROM bm c
  WHERE c.direction = 'inbound' AND c.channel = 'call' AND c.is_job_contact IS TRUE AND c.bad_call
    AND NOT EXISTS (SELECT 1 FROM outs o WHERE o.job_id = c.job_id AND o.at > c.at)
  UNION ALL
  -- (story safety, sixth review) R4 for this customer's missed call placed on no job that the
  -- placement queue offers this job (offr queued: its candidates, their admin bucket, a holding
  -- job), from the job's lead window on, when no call, text or email went to them after it (on
  -- this job, on any other or on none) and they did not get through since (SWF-261506 and
  -- SWF-261509: the customer's call after ours rang out, pending placement between the two jobs)
  SELECT o.job_id, 'R4_missed_call', o.id::text, 'business_events', 'loop', 'us', 'customer',
         'Missed call from the customer ' || to_char(o.at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon HH24:MI')
           || ' (not placed on any job); no call, text or email to the customer since',
         'The call record shows it was not answered (' || coalesce(nullif(o.call_status, ''), 'missed') || ')',
         o.at, NULL::date, NULL::numeric, 'contact:missed-call', 'A call, text or email from us to the customer after it'
  FROM offr o JOIN j ON j.id = o.job_id
  WHERE o.placed IS NULL AND o.queued AND o.is_call AND o.channel = 'call' AND o.contact_id = j.ccontact
    AND o.call_status IN ('no-answer', 'ringing', 'busy', 'missed', 'voicemail', 'canceled', 'cancelled')
    AND o.at >= j.created_at - interval '30 days'
    AND NOT EXISTS (SELECT 1 FROM outs x WHERE x.job_id = o.job_id AND x.at > o.at)
    AND NOT EXISTS (SELECT 1 FROM public.business_events x
                    WHERE x.contact_id = j.ccontact AND x.direction = 'outbound' AND coalesce(x.recorded_at, x.occurred_at) <= p_as_of
                      AND coalesce(x.event_at, x.occurred_at) > o.at AND coalesce(x.event_at, x.occurred_at) <= p_as_of
                      AND (x.channel IN ('sms', 'email', 'call') OR x.event_type IN ('client.sms_out', 'client.email_out', 'client.call_logged', 'client.call_complete'))
                      AND coalesce(x.payload ->> 'sent_by_kind', '') <> 'workflow' AND public.context_internal_text_role(x) = 'other')
    AND NOT EXISTS (SELECT 1 FROM offr y WHERE y.job_id = o.job_id AND y.is_call AND y.at > o.at
                      AND (y.event_type = 'call.transcript_completed' OR y.call_status IN ('completed', 'answered')))
    AND NOT EXISTS (SELECT 1 FROM msg y WHERE y.job_id = o.job_id AND y.direction = 'inbound' AND y.call_answered AND y.at > o.at)
  UNION ALL
  -- R5 customer wrote last (reference rule; a candidate until a reader says a reply is owed)
  SELECT l.job_id, 'R5_customer_wrote_last', l.source_id, 'business_events', 'candidate', 'us', 'customer',
         'Customer ' || CASE WHEN l.channel = 'email' THEN 'emailed' ELSE 'texted' END || ' '
           || to_char(l.at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon HH24:MI') || ' and nothing went to the customer since: "'
           || left(l.words, 160) || '"',
         'The newest customer message is newer than our newest customer-facing message (automated texts not counted)',
         l.at, NULL::date, NULL::numeric, 'contact:customer-reply', 'A text, email or call from us to the customer after it'
  FROM (SELECT DISTINCT ON (i.job_id) i.* FROM ins i ORDER BY i.job_id, i.at DESC, i.source_id DESC) l
  WHERE NOT EXISTS (SELECT 1 FROM outs o WHERE o.job_id = l.job_id AND o.at > l.at)
    AND extract(epoch FROM p_as_of - l.at) > 86400
  UNION ALL
  -- R6 booking passed, status unmoved (reference rule)
  SELECT b.job_id, 'R6_booking_passed_status_unmoved', b.id::text, 'job_assignments', 'check', 'us', 'customer',
         'Newest booking ' || to_char(b.scheduled_date, 'Dy FMDD Mon YYYY') || ' has passed and the status is still ' || replace(jv.status, '_', ' '),
         'No visit outcome after the booking and the status did not move on',
         (b.scheduled_date::timestamp AT TIME ZONE 'Australia/Perth'), b.scheduled_date, NULL::numeric,
         'booking:' || b.scheduled_date::text, 'The status moves on or a visit outcome is recorded'
  FROM (SELECT DISTINCT ON (a.job_id) a.* FROM asg a
        WHERE a.scheduled_date IS NOT NULL AND lower(coalesce(a.status, 'none')) NOT IN ('cancelled', 'deleted')
          AND NOT a.mirror  -- an observer's mirror is not a crew visit
        ORDER BY a.job_id, a.scheduled_date DESC, a.created_at, a.id) b
  JOIN jv ON jv.id = b.job_id
  WHERE b.scheduled_date < jv.today AND jv.status IN ('scheduled', 'processing', 'accepted')
    AND NOT EXISTS (SELECT 1 FROM vo WHERE vo.job_id = b.job_id
                    AND (vo.visit_start AT TIME ZONE 'Australia/Perth')::date >= b.scheduled_date)
  UNION ALL
  -- R7 quote waiting (reference rule; a check once the job is accepted). A quote whose
  -- every email our system sent bounced or failed, and that the customer never viewed,
  -- was not received (the timeline's own rule, as of p_as_of): it waits on us to get it
  -- to them, not on the customer's answer. (Story safety, fourth review) When the customer
  -- was in touch after it in a way that does not close it (tch: an answered call, old-inbox
  -- mail, a message placed on no job, withheld mail), it may be answered: whose move is
  -- unclear (owner unknown) and the words name that newest contact; "no customer message
  -- since" is said only when there is none anywhere. (Sixth review) It is a loop only while
  -- the job is quoted (or earlier): once its status is past quoted (SWF-261111, invoiced,
  -- the customer's answered call after the quote placed on no job) it is a check, never a
  -- wait on the customer; and so is a quote this customer's later job of the same kind at the same site
  -- address may replace, once that job is accepted (SWF-26403 and SWF-26404, both halves
  -- accepted together as SWF-26498, built and paid). The customer's contact since may be on
  -- their other job (offr), named by its number.
  SELECT q.job_id, 'R7_quote_waiting', q.id::text, 'job_documents',
         CASE WHEN acc.accepted OR jv.status NOT IN ('quoted', 'lead', 'new', 'draft') OR lj.job_number IS NOT NULL THEN 'check' ELSE 'loop' END,
         CASE WHEN de.undelivered THEN 'us' WHEN h.at IS NOT NULL THEN 'unknown' ELSE 'customer' END, CASE WHEN de.undelivered THEN 'customer' WHEN h.at IS NOT NULL THEN 'unknown' ELSE 'us' END,
         'Quote ' || coalesce(q.quote_number, 'without a number') || coalesce(' v' || q.version, '') || ' sent '
           || to_char(q.sent_at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon YYYY') || ' ('
           || floor(extract(epoch FROM p_as_of - q.sent_at) / 86400) || ' days)'
           || CASE WHEN de.undelivered THEN ', but every email of it bounced or failed: not received; '
                                            || coalesce('the customer was in touch since: ' || h.words, 'no customer message since')
                   WHEN h.at IS NOT NULL THEN CASE WHEN q.viewed_at IS NOT NULL THEN ', viewed' ELSE ', not viewed' END
                                            || '; no answer recorded, but the customer was in touch since: ' || h.words
                   WHEN q.viewed_at IS NOT NULL THEN ', viewed; no answer and no customer message since'
                   ELSE ', not viewed; no answer and no customer message since' END
           || coalesce('; job ' || lj.job_number || ' for this customer at the same site address was accepted'
                       || coalesce(' ' || to_char(lj.acc_at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon YYYY'), '')
                       || ' and may replace this quote', ''),
         CASE WHEN de.undelivered THEN 'Every email of the newest sent quote bounced or failed and the customer never viewed it, so it was not received'
              WHEN h.at IS NOT NULL THEN 'Newest sent quote not accepted, declined or superseded, sent more than 7 days ago; the customer was in touch '
                                         || 'after it (no text or email of theirs on the job), so it may already be answered: whose move is unclear'
              ELSE 'Newest sent quote not accepted, declined or superseded, sent more than 7 days ago' END
           || CASE WHEN lj.job_number IS NOT NULL
                   THEN '; this customer''s later job of the same kind at the same site address is accepted, so this quote may be replaced by it: a check'
                   WHEN NOT acc.accepted AND jv.status NOT IN ('quoted', 'lead', 'new', 'draft')
                   THEN '; the job''s status (' || replace(jv.status, '_', ' ') || ') is past quoted, so the quote is a check, never a wait on the customer'
                   ELSE '' END,
         q.sent_at, NULL::date, NULL::numeric,
         'quote:' || lower(coalesce(nullif(btrim(q.quote_number), ''), 'doc-' || left(q.id::text, 8))),
         -- not received ends when an email of it goes out or the customer views it; the
         -- loop then waits on the customer and closes as any waiting quote does
         CASE WHEN de.undelivered THEN 'Not received until an email of it goes out or the customer views it, then it waits on the customer; '
                                       || 'closes on acceptance, decline, a newer version, or a customer message'
              ELSE 'Acceptance, decline, a newer version, or a customer message' END
  FROM (SELECT DISTINCT ON (d.job_id) d.* FROM qd d WHERE d.sent_at IS NOT NULL
        ORDER BY d.job_id, d.sent_at DESC, d.created_at, d.id) q
  JOIN acc ON acc.job_id = q.job_id
  JOIN jv ON jv.id = q.job_id
  -- (sixth review) this customer's later job of the same kind at the same site address,
  -- accepted (its acceptance, or a status past quoted) by p_as_of
  LEFT JOIN LATERAL (
   SELECT coalesce(o.job_number, 'without a number') AS job_number, CASE WHEN o.accepted_at <= p_as_of THEN o.accepted_at END AS acc_at
   FROM public.jobs o
   WHERE jv.ccontact IS NOT NULL AND o.ghl_contact_id = jv.ccontact AND o.id <> q.job_id AND o.type::text = jv.type
     AND o.created_at > q.sent_at AND o.created_at <= p_as_of
     AND (o.accepted_at <= p_as_of
          OR o.status::text IN ('accepted', 'partially_accepted', 'awaiting_deposit', 'deposit', 'approvals', 'order_materials', 'awaiting_supplier',
                                'schedule_install', 'scheduled', 'in_progress', 'processing', 'invoiced', 'final_payment', 'get_review', 'complete',
                                'completed', 'rectification'))
     AND (public.context_address_key(o.site_address) = public.context_address_key(jv.site_address)
          OR nullif(lower(regexp_replace(coalesce(o.site_address, ''), '[^a-zA-Z0-9]+', '', 'g')), '')
             = nullif(lower(regexp_replace(coalesce(jv.site_address, ''), '[^a-zA-Z0-9]+', '', 'g')), ''))
   ORDER BY o.created_at, o.id LIMIT 1) lj ON true
  CROSS JOIN LATERAL (SELECT (EXISTS (SELECT 1 FROM public.email_events ee WHERE ee.metadata ->> 'document_id' = q.id::text AND ee.created_at <= p_as_of)
       AND NOT EXISTS (SELECT 1 FROM public.email_events ee WHERE ee.metadata ->> 'document_id' = q.id::text
        AND lower(coalesce(ee.status, '')) IN ('sent', 'delivered', 'accepted') AND ee.sent_at IS NOT NULL AND ee.sent_at <= p_as_of)
       AND q.viewed_at IS NULL) AS undelivered) de
  -- the newest contact of the customer's after the quote that does not close it
  LEFT JOIN LATERAL (SELECT c.at, c.what || ' ' || to_char(c.at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon YYYY')
                                  || coalesce(' (' || c.note || ')', '') AS words
                     FROM tch c WHERE c.job_id = q.job_id AND c.at > q.sent_at
                     ORDER BY c.at DESC, c.what COLLATE "C", c.note COLLATE "C" LIMIT 1) h ON true
  WHERE q.accepted_at IS NULL AND q.declined_at IS NULL AND q.superseded_at IS NULL
    AND p_as_of - q.sent_at >= interval '8 days'
    AND NOT EXISTS (SELECT 1 FROM ins i WHERE i.job_id = q.job_id AND i.at > q.sent_at)
  UNION ALL
  -- R8 not yet invoiced after acceptance (reference rule; accepted also by a paid deposit
  -- invoice). When another record disagrees with the job value (a C2 check), the value
  -- is unconfirmed: the gap is never stated as fact and the loop carries no amount (the
  -- story then holds it as a check of the value, never a move: story safety, fourth review).
  SELECT jv.id, 'R8_not_yet_invoiced', jv.id::text, 'jobs', 'loop', 'us', 'customer',
         CASE WHEN jv.unconfirmed
              THEN 'Job value ' || to_char(jv.value, 'FM$999,999,990.00') || ' (' || jv.value_basis || ') is unconfirmed (check C2); issued invoices '
                   || to_char(coalesce(s.issued, 0), 'FM$999,999,990.00') || '; what is left to invoice is not known'
              ELSE 'Job value ' || to_char(jv.value, 'FM$999,999,990.00') || ' (' || jv.value_basis || '); issued invoices '
                   || to_char(coalesce(s.issued, 0), 'FM$999,999,990.00') || '; ' || to_char(jv.value - coalesce(s.issued, 0), 'FM$999,999,990.00')
                   || ' not yet invoiced' END,
         CASE WHEN jv.accepted_by = 'deposit'
              THEN 'A deposit invoice is paid, so the job is accepted, and issued customer invoices total less than the job value'
              ELSE 'The job is accepted and issued customer invoices total less than the job value' END
         || CASE WHEN jv.unconfirmed THEN '; another record disagrees with the job value, so the amount is unconfirmed' ELSE '' END,
         jv.acc_at, NULL::date,
         CASE WHEN jv.unconfirmed THEN NULL ELSE jv.value - coalesce(s.issued, 0) END, 'payment:final',
         'Issued invoices reach the job value, or the job value is corrected'
  FROM jv JOIN acc ON acc.job_id = jv.id
  LEFT JOIN LATERAL (SELECT sum(coalesce(i.total, 0)) AS issued FROM sales i
                     WHERE i.job_id = jv.id AND i.st NOT IN ('DRAFT', 'DELETED', 'VOIDED')) s ON true
  WHERE acc.accepted AND jv.value IS NOT NULL AND jv.value - coalesce(s.issued, 0) > 1
  UNION ALL
  -- C1 status lags the work: the newest sign that work is done while the status is an earlier stage
  SELECT w.job_id, 'C1_status_lags_work', w.sid, w.tbl, 'check', 'us', 'nobody',
         'Status is still ' || replace(jv.status, '_', ' ') || ' but ' || w.what, 'Records show the work done while the status lags',
         w.at, NULL::date, NULL::numeric, 'other:status-lags-work', 'The status moves on'
  FROM (SELECT DISTINCT ON (x.job_id) x.* FROM (
         SELECT je.job_id, je.id::text AS sid, 'job_events'::text AS tbl, je.created_at AS at,
                CASE je.event_type WHEN 'makesafe_report_sent_at_derived' THEN 'the make-safe report was sent '
                                   WHEN 'makesafe_pack_sent_at_derived' THEN 'the make-safe pack was sent '
                                   ELSE 'the builder portal report was marked done ' END
                || to_char(je.created_at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon YYYY') AS what
         FROM public.job_events je
         WHERE je.job_id = ANY (p_job_ids) AND je.created_at <= p_as_of
           AND je.event_type IN ('makesafe_report_sent_at_derived', 'makesafe_pack_sent_at_derived', 'makesafe_portal_report_done')
         UNION ALL
         SELECT a.job_id, a.id::text, 'job_assignments', coalesce(a.completed_at, (a.scheduled_date::timestamp AT TIME ZONE 'Australia/Perth')),
                CASE WHEN a.completed_at IS NOT NULL THEN 'the crew marked the ' || to_char(a.scheduled_date, 'Dy FMDD Mon YYYY') || ' booking complete'
                     ELSE 'the ' || to_char(a.scheduled_date, 'Dy FMDD Mon YYYY') || ' booking status says complete (who and when not recorded)' END
         FROM asg a WHERE NOT a.mirror AND (a.status = 'complete' OR a.completed_at IS NOT NULL)
         UNION ALL
         SELECT i.job_id, i.id::text, 'xero_invoices', coalesce(i.invoice_date::timestamp AT TIME ZONE 'Australia/Perth', i.created_at),
                'invoices reach the job value and are paid (' || coalesce(i.invoice_number, 'unnumbered') || ' paid)'
         FROM sales i JOIN jv ON jv.id = i.job_id
         WHERE i.st = 'PAID' AND jv.value IS NOT NULL
           AND (SELECT sum(coalesce(o.total, 0)) FROM sales o WHERE o.job_id = i.job_id AND o.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')) >= jv.value - 1
           AND NOT EXISTS (SELECT 1 FROM sales o WHERE o.job_id = i.job_id AND o.st IN ('AUTHORISED', 'SUBMITTED') AND coalesce(o.amount_due, 0) > 0)
       ) x ORDER BY x.job_id, x.at DESC, x.sid) w
  JOIN jv ON jv.id = w.job_id
  WHERE jv.status IN ('quoted', 'accepted', 'partially_accepted', 'awaiting_deposit', 'deposit', 'approvals', 'order_materials',
                      'awaiting_supplier', 'schedule_install', 'scheduled', 'processing')
  UNION ALL
  -- C2 value mismatch: a record disagrees with the job value by more than $1, one check
  -- per record (context_job_record_value): the accepted quote and invoices above the
  -- value as before; on an accepted job also an invoice line's own base, a deposit's
  -- percentage, the newest sent quote, a final invoice below the value, and a value
  -- from a quote the app has no record of sending. Each makes the job value
  -- unconfirmed (R8 says so).
  SELECT z.job_id, 'C2_value_mismatch', z.c ->> 'id', z.c ->> 'table', 'check', 'us', 'nobody', z.c ->> 'what',
         'Money lines may use the wrong figure; a person should confirm which is current',
         (z.c ->> 'at')::timestamptz, NULL::date, (z.c ->> 'amount')::numeric, 'other:job-value', 'The values agree within $1'
  FROM (SELECT DISTINCT ON (jv.id, c ->> 'table', c ->> 'id') jv.id AS job_id, c
        FROM jv CROSS JOIN LATERAL jsonb_array_elements(jv.checks) c
        ORDER BY jv.id, c ->> 'table', c ->> 'id', (c ->> 'kind')::integer) z
  UNION ALL
  -- C3 a paid event while Xero still shows the invoice owing (records win; the event closes nothing)
  SELECT p.job_id, 'C3_paid_event_not_in_xero', p.eid, 'business_events', 'check', 'us', 'customer',
         'A payment event was logged ' || to_char(p.at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon YYYY') || ' for '
           || coalesce(i.invoice_number, 'an invoice') || ' but Xero still shows ' || to_char(i.amount_due, 'FM$999,999,990.00') || ' owing',
         'Xero is the record; the event does not close the money', p.at, i.due_date, i.amount_due, i.about,
         'Xero shows the invoice paid, or the event is explained'
  FROM (SELECT DISTINCT ON (e.job_id, coalesce(e.payload->>'xero_invoice_id', e.payload->>'invoice_number'))
               e.job_id, e.id::text AS eid, coalesce(e.event_at, e.occurred_at) AS at,
               e.payload->>'xero_invoice_id' AS xid, e.payload->>'invoice_number' AS num
        FROM public.business_events e
        WHERE e.job_id = ANY (p_job_ids) AND coalesce(e.recorded_at, e.occurred_at) <= p_as_of
          AND e.event_type IN ('invoice.paid', 'payment.received', 'payment.reconciled')
        ORDER BY e.job_id, coalesce(e.payload->>'xero_invoice_id', e.payload->>'invoice_number'), coalesce(e.event_at, e.occurred_at) DESC) p
  JOIN sales i ON i.job_id = p.job_id AND (i.xero_invoice_id = p.xid OR (p.xid IS NULL AND i.invoice_number = p.num))
  WHERE i.st IN ('AUTHORISED', 'SUBMITTED') AND coalesce(i.amount_due, 0) > 0
  UNION ALL
  -- C4 attendance not recorded: a booking today or passed with no start or completion, and no later booking complete
  SELECT b.job_id, 'C4_booking_attendance_unrecorded', b.id::text, 'job_assignments', 'check', 'us', 'crew',
         b.n || CASE WHEN b.n = 1 THEN ' booking' ELSE ' bookings' END || ' on or before today with no start or completion recorded; newest '
           || to_char(b.scheduled_date, 'Dy FMDD Mon YYYY') || coalesce(' (' || nullif(btrim(b.crew_name), '') || ')', ''),
         'The crew did not mark it started or complete, so the record cannot say whether anyone attended',
         (b.scheduled_date::timestamp AT TIME ZONE 'Australia/Perth'), b.scheduled_date, NULL::numeric,
         'booking:' || b.scheduled_date::text, 'The crew marks it started or complete, or it is cancelled'
  FROM (SELECT DISTINCT ON (a.job_id) a.*, count(*) OVER (PARTITION BY a.job_id) AS n
        FROM asg a JOIN jv ON jv.id = a.job_id
        WHERE NOT a.mirror AND a.scheduled_date <= jv.today AND coalesce(a.status, 'scheduled') NOT IN ('complete', 'cancelled', 'in_progress')
          AND a.started_at IS NULL AND a.completed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM asg c WHERE c.job_id = a.job_id AND NOT c.mirror AND c.scheduled_date >= a.scheduled_date
                          AND (c.status = 'complete' OR c.completed_at IS NOT NULL))
        ORDER BY a.job_id, a.scheduled_date DESC, a.id) b
  UNION ALL
  -- (C5, a booking still tentative in crew planning, is retired: crew planning's
  -- confirmation is its own default, never the customer's word, so nothing reads it)
  -- C6 the customer wrote after a future booking was made and it has not changed since
  SELECT b.job_id, 'C6_booking_after_customer_word', c.source_id, c.source_table, 'check', 'us', 'customer',
         'Booked ' || b.dates || '; the customer wrote ' || to_char(c.at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon HH24:MI')
           || CASE WHEN c.placement = 'not_placed' THEN ' (an email not placed on any job)' ELSE '' END
           || ' after it was made and the booking has not changed since: "' || left(c.words, 160) || '"',
         'A person or the reader must judge whether the message objects to the date',
         c.at, b.first_date, NULL::numeric, 'booking:' || b.first_date::text,
         'The booking is changed or confirmed after that message, or our reply confirms the date'
  -- the booked days in date order, each once (never in the order of their weekday words)
  FROM (SELECT a.job_id, (SELECT string_agg(to_char(x.d, 'Dy FMDD Mon'), ', ' ORDER BY x.d)
                          FROM unnest(array_agg(DISTINCT a.scheduled_date)) AS x(d)) AS dates,
               max(coalesce(a.updated_at, a.created_at)) AS changed, min(a.scheduled_date) AS first_date
        FROM asg a JOIN jv ON jv.id = a.job_id
        WHERE NOT a.mirror AND a.scheduled_date >= jv.today AND coalesce(a.status, '') NOT IN ('cancelled', 'complete')
        GROUP BY a.job_id) b
  JOIN LATERAL (SELECT m.* FROM msg m
                WHERE m.job_id = b.job_id AND m.customer_side AND m.direction = 'inbound' AND m.channel IN ('sms', 'email')
                  AND m.at > b.changed AND (m.at AT TIME ZONE 'Australia/Perth')::date <= b.first_date
                ORDER BY m.at DESC, m.source_id DESC LIMIT 1) c ON true
  UNION ALL
  -- C7 CRM task still open
  SELECT t.job_id, 'C7_task_open', t.id::text, 'business_events', 'check', 'us', 'nobody',
         'CRM task still open: ' || coalesce(left(t.payload->>'title', 160), 'no title') || coalesce(', due ' || (t.payload->>'due_date'), ''),
         'Task created and no completed or deleted row since', coalesce(t.event_at, t.occurred_at), NULL::date, NULL::numeric,
         'other:task-' || left(t.id::text, 8), 'The task is completed or deleted in the CRM'
  FROM public.business_events t
  WHERE t.job_id = ANY (p_job_ids) AND t.event_type = 'ghl.task_created' AND coalesce(t.recorded_at, t.occurred_at) <= p_as_of
    AND NOT EXISTS (SELECT 1 FROM public.business_events x WHERE x.job_id = t.job_id
                    AND x.event_type IN ('ghl.task_completed', 'ghl.task_deleted')
                    AND x.payload->>'ghl_task_id' = t.payload->>'ghl_task_id' AND coalesce(x.recorded_at, x.occurred_at) <= p_as_of)
  UNION ALL
  -- C8 variation open
  SELECT v.job_id, 'C8_variation_open', v.id::text, 'job_variations', 'check',
         CASE WHEN v.status = 'sent' THEN 'customer' ELSE 'us' END, CASE WHEN v.status = 'sent' THEN 'us' ELSE 'customer' END,
         'Variation ' || coalesce(v.variation_number::text, '') || coalesce(' ' || to_char(v.amount, 'FM$999,999,990.00'), '')
           || ' is ' || coalesce(v.status, 'without a status') || coalesce(': ' || left(v.description, 120), ''),
         'Not accepted, declined or invoiced', coalesce(v.sent_at, v.created_at), NULL::date, v.amount,
         'variation:' || coalesce(v.variation_number::text, left(v.id::text, 8)), 'The variation is accepted, declined or invoiced'
  FROM public.job_variations v
  WHERE v.job_id = ANY (p_job_ids) AND v.created_at <= p_as_of
    AND coalesce(v.status, '') NOT IN ('accepted', 'declined', 'rejected', 'invoiced')
  UNION ALL
  -- C9 a visit outcome says a quote is owed and none was sent after the visit
  SELECT o.job_id, 'C9_visit_quote_owed', o.id::text, 'visit_outcomes', 'check', 'us', 'customer',
         'Visit ' || to_char(o.visit_start AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon YYYY') || ' recorded that a quote is owed; none sent since',
         'Visit outcome quote_owed', o.visit_start, NULL::date, NULL::numeric, 'quote:after-visit', 'A quote is sent after the visit'
  FROM vo o
  WHERE o.quote_owed AND o.outcome = 'happened'
    AND NOT EXISTS (SELECT 1 FROM public.visit_outcomes s WHERE s.supersedes = o.id)
    AND NOT EXISTS (SELECT 1 FROM qd WHERE qd.job_id = o.job_id AND qd.sent_at > o.visit_start)
  UNION ALL
  -- C10 the stage needs a visit and none is booked
  SELECT jv.id, 'C10_no_next_booking', jv.id::text, 'jobs', 'check', 'us', 'customer',
         'Status ' || replace(jv.status, '_', ' ') || ' and no visit is booked from today'
           || coalesce(' (last booking ' || to_char((SELECT max(a.scheduled_date) FROM asg a WHERE a.job_id = jv.id AND NOT a.mirror
                                                     AND coalesce(a.status, '') <> 'cancelled'), 'Dy FMDD Mon YYYY') || ')', ''),
         'The stage needs a visit and no booking is dated today or later', p_as_of, NULL::date, NULL::numeric,
         'booking:next', 'A booking dated today or later is made, or the status moves on'
  FROM jv
  WHERE jv.status IN ('scheduled', 'in_progress', 'rectification', 'schedule_install')
    AND NOT EXISTS (SELECT 1 FROM asg a WHERE a.job_id = jv.id AND NOT a.mirror AND a.scheduled_date >= jv.today
                    AND coalesce(a.status, '') <> 'cancelled')
  UNION ALL
  -- C11 the customer's newest legacy-inbox email has no customer-facing reply after it (a
  -- candidate like R5). Where it is kept: only in the old inbox, or (story safety,
  -- 20261006040000) brought back from it because its saved copy (by the record's copy keys,
  -- recorded by p_as_of) sits on another job or on no job, said so
  SELECT l.job_id, 'C11_customer_mail_unanswered', l.source_id, 'inbox_events', 'candidate', 'us', 'customer',
         'Customer emailed ' || to_char(l.at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon HH24:MI')
           || CASE WHEN cp.on_job IS NULL
                   THEN ' (stored only in the old inbox' || CASE WHEN l.placement = 'not_placed' THEN ', not placed on any job' ELSE '' END || ')'
                   ELSE ' (from the old inbox' || CASE WHEN l.placement = 'not_placed' THEN ', not placed on any job' ELSE '' END
                        || CASE WHEN cp.on_job THEN '; its saved copy is on another job)' ELSE '; its saved copy is on no job yet)' END END
           || ' and nothing went to the customer since: "' || left(l.words, 160) || '"',
         'The email has no saved copy on this job, so the R5 rule cannot see it',
         l.at, NULL::date, NULL::numeric, 'contact:customer-reply', 'A text, email or call from us to the customer after it'
  FROM (SELECT DISTINCT ON (m.job_id) m.* FROM msg m
        WHERE m.source_table = 'inbox_events' AND m.customer_side ORDER BY m.job_id, m.at DESC, m.source_id DESC) l
  -- its saved copies elsewhere (a copy on this job would have left the mail out): on_job is
  -- true when one sits on another job, false when they sit on no job, null when there is none
  CROSS JOIN LATERAL (
   SELECT bool_or(x.job_id IS NOT NULL) AS on_job FROM (
    SELECT c.job_id FROM public.business_events c
    WHERE c.source_table = 'inbox_events' AND c.source_id = l.source_id AND coalesce(c.recorded_at, c.occurred_at) <= p_as_of
    UNION ALL
    SELECT c.job_id FROM public.inbox_events i JOIN public.business_events c ON c.provider_message_id = 'graph:' || i.graph_message_id
    WHERE i.id = l.source_id::uuid AND i.graph_message_id IS NOT NULL AND coalesce(c.recorded_at, c.occurred_at) <= p_as_of
    UNION ALL
    SELECT c.job_id FROM public.business_events c
    WHERE c.payload @> jsonb_build_object('inbox_events_id', l.source_id) AND coalesce(c.recorded_at, c.occurred_at) <= p_as_of) x
   WHERE x.job_id IS DISTINCT FROM l.job_id) cp
  WHERE NOT EXISTS (SELECT 1 FROM outs o WHERE o.job_id = l.job_id AND o.at > l.at)
    AND extract(epoch FROM p_as_of - l.at) > 86400
 )
 SELECT lp.job_id, lp.rule, lp.rule || ':' || lp.sid AS loop_key, lp.shown_as, lp.owner, lp.counterparty,
        replace(replace(lp.what, chr(8212), ', '), chr(8211), '-') AS what, lp.why, lp.opened_at, lp.due AS due_date,
        round(lp.amount, 2) AS amount, lp.about AS about_key, lp.closes_when, lp.tbl AS source_table, lp.sid AS source_id,
        -- where the cited message sits: on_job, or not_placed (mail from the client's
        -- address the old inbox placed on no job; sixth review: a missed call placed on no
        -- job); null for a record row
        CASE WHEN lp.tbl = 'inbox_events'
             THEN coalesce((SELECT m.placement FROM msg m WHERE m.job_id = lp.job_id AND m.source_table = 'inbox_events'
                            AND m.source_id = lp.sid LIMIT 1), 'on_job')
             WHEN lp.tbl = 'business_events' AND lp.rule = 'R4_missed_call'
                  AND EXISTS (SELECT 1 FROM offr o WHERE o.job_id = lp.job_id AND o.id::text = lp.sid AND o.placed IS NULL) THEN 'not_placed'
             WHEN lp.tbl = 'business_events' THEN 'on_job' END AS placement
 FROM lp
 ORDER BY lp.job_id, lp.rule COLLATE "C", lp.opened_at, lp.sid COLLATE "C"
$fn$;
COMMENT ON FUNCTION public.context_job_record_loops(uuid[], timestamptz) IS
 'Job record (20261006011000), story fixes (20261006033000), story safety (20261006040000): (sixth review) R7 is a loop only while the job is quoted or earlier: once its status is past quoted, or this customer''s later job of the same kind at the same site address is accepted (it may replace the quote, named), it is a check; the customer''s contact since the quote also counts what they sent off the job: every row of their CRM contact placed on no job whatever its attribution status, and their rows on their other jobs (named "on job X"); R4 also fires for their missed call placed on no job that the placement queue offers this job (its candidates, their admin bucket, a holding job; placement not_placed), from the job''s lead window on, when no call, text or email went to them after it on any job or none and they did not get through since; R3 is a check, never our move, when the job''s issued invoices for the same stage of the same job reference (stem and DEP or FIN suffix) already reach the draft''s amount (named: it may duplicate them); a CRM text whose CRM time is no longer known is never the customer''s. Earlier: a paid deposit invoice counts as acceptance (R8, and R7 turns check); R7 on a quote the customer was in touch about since it was sent in a way that does not close it (an answered call of theirs on the job, their old-inbox mail, a message of theirs placed on no job yet, their mail withheld because they have another job) is owned by nobody known (owner and counterparty unknown: it may be answered) and names that newest contact, and "no customer message since" is said only when there is none anywhere (a CRM text of theirs placed on no job that was loaded later from the CRM''s cache is at the CRM''s own time, context_job_record_crm_time, and one the CRM dates more than 30 days before the job was created is never theirs, as the job''s own texts are read, so a text sent before the quote is never contact since it however late it was loaded); C2 is one check per record that disagrees with the job value (context_job_record_value: the accepted quote, invoices above the value, and on an accepted job an invoice line''s own base, also a line naming this job on an invoice placed elsewhere, a deposit''s percentage, the newest sent quote, a final invoice below the value, a value from a quote the app has no record of sending, an invoice placed on no job or on another job that names this job), and then R8 says the value is unconfirmed and carries no amount; R1, R2 and M1 are owed by whoever the invoice is addressed to (context_job_record_payer_role): the customer (the builder on builder work), else another party (owner third_party), named with its role; C11 on a mail brought back from the old inbox (its saved copy sits on another job or on no job, recorded by p_as_of) says where that copy sits, never "stored only in the old inbox". Earlier, story fixes: C6 names the booked days in date order, each once; R7 on a quote whose every email bounced or failed and the customer never viewed it reads not received and is ours (owner us), not the customer''s answer, and its closes_when says when not received ends (an email of it goes out or the customer views it) and then when the loop closes; text sorts and tiebreaks in C (byte) order. Earlier: record-closable loops per job. R1_overdue, R2_part_paid, R3_draft, R4_missed_call, R5_customer_wrote_last, R6_booking_passed_status_unmoved, R7_quote_waiting, R8_not_yet_invoiced are exactly the proof-set reference rules (tests.md T2, grade_ref.py record_loops); M1_money_due; checks C1 to C4 and C6 to C11 (a person''s look, never an obligation; C5, crew planning''s tentative booking, is retired and crew planning''s confirmation is never read). shown_as loop|candidate|check. loop_key = rule:source_id. about_key per the ledger vocabulary. placement says where a cited message sits (on_job, or not_placed: client mail the old inbox placed on no job, labelled in the words); null for a record row. Service role only.';

CREATE OR REPLACE FUNCTION public.context_job_record_money(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, party text, xero_contact_id text, invoiced numeric, paid numeric, credited numeric, owing numeric,
 overdue numeric, oldest_overdue_due date, drafts integer, draft_total numeric, invoices jsonb, job_value numeric,
 job_value_basis text, not_yet_invoiced numeric, supplier_bills jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH j AS (
  SELECT jb.id, CASE WHEN jb.accepted_at <= p_as_of THEN jb.accepted_at END AS accepted_at,
         CASE WHEN jsonb_typeof(jb.pricing_json->'totalIncGST') = 'number' THEN (jb.pricing_json->>'totalIncGST')::numeric END AS price_inc,
         jb.quoted_value, (p_as_of AT TIME ZONE 'Australia/Perth')::date AS today,
         jb.job_number, jb.type::text AS type, nullif(btrim(jb.xero_contact_id), '') AS jxc
  FROM public.jobs jb WHERE jb.id = ANY (p_job_ids)
 ),
 -- the job value, acceptance (the job row, an accepted quote or a paid deposit invoice)
 -- and whether another record disagrees with the value: context_job_record_value
 jv AS (
  SELECT j.*, v.value, v.value_basis AS basis, v.accepted, jsonb_array_length(v.checks) > 0 AS unconfirmed
  FROM j JOIN public.context_job_record_value(p_job_ids, p_as_of) v ON v.job_id = j.id
 ),
 inv AS (
  SELECT x.id, x.job_id, x.invoice_number, x.reference, x.contact_name, x.xero_contact_id, x.total, x.amount_due, x.amount_paid,
         x.invoice_date, x.due_date, x.fully_paid_on, x.raw_json, upper(coalesce(x.status, 'NONE')) AS st,
         upper(coalesce(x.invoice_type, 'ACCREC')) AS itype, x.line_items, x.job_contact_id
  FROM public.xero_invoices x
  WHERE x.job_id = ANY (p_job_ids) AND coalesce(x.created_at, x.synced_at, '-infinity'::timestamptz) <= p_as_of
    AND upper(coalesce(x.status, '')) NOT IN ('DELETED', 'VOIDED')
 ),
 sale AS (
  SELECT i.*, jv.today,
         coalesce(nullif(btrim(i.xero_contact_id), ''), 'name:' || lower(btrim(i.contact_name)), 'unknown') AS pkey,
         -- paid: Xero's own AmountPaid column (the sum of the raw Payments when the raw
         -- record is current); credited: the raw AmountCredited when the raw record is
         -- current, else what the columns leave (total - paid - due). The raw record can lag
         -- the columns (status PAID with an older AUTHORISED raw copy): then xero_detail_stale.
         coalesce(i.amount_paid, (SELECT sum(nullif(p->>'Amount', '')::numeric)
                                  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.raw_json->'Payments') = 'array'
                                                                 THEN i.raw_json->'Payments' ELSE '[]'::jsonb END) p), 0) AS paid_amt,
         CASE WHEN jsonb_typeof(i.raw_json->'AmountCredited') = 'number' AND upper(coalesce(i.raw_json->>'Status', '')) = i.st
              THEN (i.raw_json->>'AmountCredited')::numeric
              WHEN i.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')
              THEN greatest(coalesce(i.total, 0) - coalesce(i.amount_paid, 0) - coalesce(i.amount_due, 0), 0)
              ELSE 0 END AS credited_amt,
         (upper(coalesce(i.raw_json->>'Status', i.st)) <> i.st) AS raw_stale,
         jsonb_build_object(
          'id', i.id, 'number', i.invoice_number, 'reference', i.reference, 'status', i.st, 'total', i.total,
          -- who it is addressed to (story safety, 20261006040000): customer, builder, neighbour,
          -- strata, other_party or other_payer
          'payer_role', public.context_job_record_payer_role(i.job_id, jv.type, jv.jxc, i.xero_contact_id, i.job_contact_id),
          'paid', NULL, 'owing', CASE WHEN i.st IN ('AUTHORISED', 'SUBMITTED') THEN coalesce(i.amount_due, 0) ELSE 0 END,
          'invoice_date', i.invoice_date, 'due_date', i.due_date, 'fully_paid_on', i.fully_paid_on,
          'xero_detail_stale', upper(coalesce(i.raw_json->>'Status', i.st)) <> i.st,
          'overdue', i.st IN ('AUTHORISED', 'SUBMITTED') AND coalesce(i.amount_due, 0) > 0 AND i.due_date < jv.today,
          'days_overdue', CASE WHEN i.st IN ('AUTHORISED', 'SUBMITTED') AND coalesce(i.amount_due, 0) > 0 AND i.due_date < jv.today
                               THEN jv.today - i.due_date END,
          'payments', (SELECT coalesce(jsonb_agg(jsonb_build_object('date',
                              CASE WHEN p->>'Date' ~ '^/Date\(-?[0-9]+' THEN (to_timestamp(substring(p->>'Date' FROM '^/Date\((-?[0-9]+)')::numeric / 1000)
                                                                              AT TIME ZONE 'Australia/Perth')::date END,
                              'amount', nullif(p->>'Amount', '')::numeric)), '[]'::jsonb)
                       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.raw_json->'Payments') = 'array' THEN i.raw_json->'Payments' ELSE '[]'::jsonb END) p),
          'credits', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', c.k, 'number', c.e->>'CreditNoteNumber', 'date',
                              CASE WHEN c.e->>'Date' ~ '^/Date\(-?[0-9]+' THEN (to_timestamp(substring(c.e->>'Date' FROM '^/Date\((-?[0-9]+)')::numeric / 1000)
                                                                                AT TIME ZONE 'Australia/Perth')::date END,
                              'amount', nullif(c.e->>'AppliedAmount', '')::numeric)), '[]'::jsonb)
                      FROM (SELECT 'credit_note'::text AS k, e FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.raw_json->'CreditNotes') = 'array' THEN i.raw_json->'CreditNotes' ELSE '[]'::jsonb END) e
                            UNION ALL SELECT 'overpayment', e FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.raw_json->'Overpayments') = 'array' THEN i.raw_json->'Overpayments' ELSE '[]'::jsonb END) e
                            UNION ALL SELECT 'prepayment', e FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.raw_json->'Prepayments') = 'array' THEN i.raw_json->'Prepayments' ELSE '[]'::jsonb END) e) c)
         ) AS doc
  FROM inv i JOIN jv ON jv.id = i.job_id
  WHERE i.itype = 'ACCREC'
 ),
 issued AS (SELECT s.job_id, sum(coalesce(s.total, 0)) FILTER (WHERE s.st NOT IN ('DRAFT')) AS issued FROM sale s GROUP BY s.job_id),
 bills AS (
  SELECT i.job_id, jsonb_agg(jsonb_build_object('id', i.id, 'number', i.invoice_number, 'reference', i.reference,
           'supplier', i.contact_name, 'status', i.st, 'total', i.total, 'paid', coalesce(i.amount_paid, 0),
           'owing', CASE WHEN i.st IN ('AUTHORISED', 'SUBMITTED') THEN coalesce(i.amount_due, 0) ELSE 0 END,
           'invoice_date', i.invoice_date, 'due_date', i.due_date)
           -- a bill whose lines name other jobs is shared: shared, job_share (this job's lines), job_lines
           || public.context_job_record_bill_share(jv.job_number, i.line_items, i.raw_json ->> 'LineAmountTypes')
           ORDER BY i.invoice_date NULLS LAST, i.invoice_number COLLATE "C", i.id) AS bills
  FROM inv i JOIN jv ON jv.id = i.job_id WHERE i.itype = 'ACCPAY' GROUP BY i.job_id
 ),
 party AS (
  SELECT s.job_id, s.pkey, (array_agg(s.contact_name ORDER BY s.invoice_date DESC NULLS LAST, s.id))[1] AS party,
         (array_agg(nullif(btrim(s.xero_contact_id), '') ORDER BY s.invoice_date DESC NULLS LAST, s.id))[1] AS xcid,
         sum(coalesce(s.total, 0)) FILTER (WHERE s.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')) AS invoiced,
         sum(s.paid_amt) FILTER (WHERE s.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')) AS paid,
         sum(s.credited_amt) FILTER (WHERE s.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')) AS credited,
         sum(coalesce(s.amount_due, 0)) FILTER (WHERE s.st IN ('AUTHORISED', 'SUBMITTED')) AS owing,
         sum(coalesce(s.amount_due, 0)) FILTER (WHERE s.st IN ('AUTHORISED', 'SUBMITTED') AND s.due_date < s.today) AS overdue,
         min(s.due_date) FILTER (WHERE s.st IN ('AUTHORISED', 'SUBMITTED') AND coalesce(s.amount_due, 0) > 0 AND s.due_date < s.today) AS oldest,
         count(*) FILTER (WHERE s.st = 'DRAFT') AS drafts,
         sum(coalesce(s.total, 0)) FILTER (WHERE s.st = 'DRAFT') AS draft_total,
         jsonb_agg(s.doc || jsonb_build_object('paid', s.paid_amt, 'credited', s.credited_amt)
                   ORDER BY s.invoice_date NULLS LAST, s.invoice_number COLLATE "C", s.id) AS invoices
  FROM sale s GROUP BY s.job_id, s.pkey
 ),
 rows_ AS (
  SELECT p.job_id, p.party, p.xcid, coalesce(p.invoiced, 0) AS invoiced, coalesce(p.paid, 0) AS paid,
         coalesce(p.credited, 0) AS credited, coalesce(p.owing, 0) AS owing, coalesce(p.overdue, 0) AS overdue, p.oldest,
         p.drafts::integer AS drafts, coalesce(p.draft_total, 0) AS draft_total, p.invoices
  FROM party p
  UNION ALL
  SELECT jv.id, NULL, NULL, 0, 0, 0, 0, 0, NULL, 0, 0, '[]'::jsonb
  FROM jv WHERE NOT EXISTS (SELECT 1 FROM party p WHERE p.job_id = jv.id)
 )
 SELECT r.job_id, r.party, r.xcid AS xero_contact_id, round(r.invoiced, 2) AS invoiced, round(r.paid, 2) AS paid,
        round(r.credited, 2) AS credited, round(r.owing, 2) AS owing, round(r.overdue, 2) AS overdue,
        r.oldest AS oldest_overdue_due, r.drafts, round(r.draft_total, 2) AS draft_total, r.invoices,
        jv.value AS job_value, jv.basis || CASE WHEN jv.unconfirmed THEN ' (unconfirmed: another record disagrees, see check C2)' ELSE '' END AS job_value_basis,
        -- never stated while the job value is unconfirmed (a C2 check)
        CASE WHEN jv.accepted AND jv.value IS NOT NULL AND NOT jv.unconfirmed
             THEN round(greatest(jv.value - coalesce(iss.issued, 0), 0), 2) END AS not_yet_invoiced,
        coalesce(b.bills, '[]'::jsonb) AS supplier_bills
 FROM rows_ r JOIN jv ON jv.id = r.job_id
 LEFT JOIN issued iss ON iss.job_id = r.job_id
 LEFT JOIN bills b ON b.job_id = r.job_id
 ORDER BY r.job_id, r.owing DESC, r.party COLLATE "C", r.xcid COLLATE "C"
$fn$;
COMMENT ON FUNCTION public.context_job_record_money(uuid[], timestamptz) IS
 'Job record (20261006011000), story safety (20261006040000): acceptance includes a paid deposit invoice and the job value is read by context_job_record_value: while another record disagrees with it (a C2 check) not_yet_invoiced is null and job_value_basis says unconfirmed; each invoice carries payer_role (context_job_record_payer_role); each supplier bill carries shared and, when shared, job_share and job_lines (context_job_record_bill_share). Earlier: money per paying party (Xero ACCREC contact) per job: invoiced (issued), paid (Xero AmountPaid; payment dates from the raw Payments), credited (raw AmountCredited: credit notes, overpayments and prepayments applied; from the columns when the raw copy lags, flagged xero_detail_stale), owing, overdue, drafts, each invoice with payments and credits; plus one party-null row when there are no invoices. DELETED and VOIDED never count. ACCPAY bills are supplier_bills (money we owe). job_value is pricing_json.totalIncGST else jobs.quoted_value; not_yet_invoiced only after acceptance. Invoices are read as now. Service role only.';

CREATE OR REPLACE FUNCTION public.context_job_record_contact(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, last_customer_message jsonb, last_to_customer jsonb, last_internal jsonb, last_call_in jsonb,
 last_call_out jsonb, customer_messages integer, replies integer, median_reply_hours numeric, unanswered integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH msg AS (
  SELECT m.*, jsonb_build_object('at', m.at, 'channel', m.channel, 'direction', m.direction,
                                 -- a transcript holds both sides of a call, speakers unlabelled
                                 'text', CASE WHEN m.event_type = 'call.transcript_completed'
                                              THEN 'Call (speakers not labelled): ' || coalesce(m.words, '') ELSE m.words END,
                                 'table', m.source_table, 'id', m.source_id, 'automated', m.automated,
                                 'event_type', m.event_type,
                                 -- legacy mail from the client's address that no job holds is shown as such
                                 'placed_on', CASE WHEN m.placement = 'not_placed' THEN 'none' ELSE 'this_job' END)
              || CASE WHEN m.placement = 'not_placed' THEN jsonb_build_object('placement_note', 'not placed on any job')
                      ELSE '{}'::jsonb END AS doc,
         (m.channel = 'call' OR m.event_type IN ('client.call_logged', 'client.call_complete', 'call.transcript_completed')) AS is_call
  FROM public.context_job_record_messages(p_job_ids, p_as_of) m WHERE m.is_msg
 ),
 -- what the customer said: texts, emails (incl. legacy mail), answered calls and call transcripts
 lc AS (SELECT DISTINCT ON (m.job_id) m.job_id, m.doc FROM msg m
        WHERE m.customer_side AND m.direction = 'inbound' AND (m.channel IN ('sms', 'email') OR m.call_answered)
        ORDER BY m.job_id, m.at DESC, m.source_id DESC),
 -- what we told the customer: never automated
 lt AS (SELECT DISTINCT ON (m.job_id) m.job_id, m.at, m.doc FROM msg m
        WHERE m.customer_side AND m.direction = 'outbound' AND NOT m.automated
        ORDER BY m.job_id, m.at DESC, m.source_id DESC),
 la AS (SELECT DISTINCT ON (m.job_id) m.job_id, m.at, m.doc FROM msg m
        WHERE m.customer_side AND m.direction = 'outbound' AND m.automated
        ORDER BY m.job_id, m.at DESC, m.source_id DESC),
 li AS (SELECT DISTINCT ON (m.job_id) m.job_id, m.doc FROM msg m WHERE m.internal
        ORDER BY m.job_id, m.at DESC, m.source_id DESC),
 ci AS (SELECT DISTINCT ON (m.job_id) m.job_id, m.doc FROM msg m WHERE m.is_call AND m.direction = 'inbound' AND m.customer_side
        ORDER BY m.job_id, m.at DESC, m.source_id DESC),
 co AS (SELECT DISTINCT ON (m.job_id) m.job_id, m.doc FROM msg m WHERE m.is_call AND m.direction = 'outbound' AND m.customer_side
        ORDER BY m.job_id, m.at DESC, m.source_id DESC),
 -- one stream per job: customer texts and emails, and replies (anything we told the customer that
 -- was not automated, or an answered call either way); next_reply = the first reply strictly after
 stream AS (
  SELECT m.job_id, m.at, m.source_id, (m.customer_side AND m.direction = 'inbound' AND m.channel IN ('sms', 'email')) AS is_cust,
         ((m.customer_side AND m.direction = 'outbound' AND NOT m.automated)
          OR (m.customer_side AND m.call_answered AND NOT m.automated)) AS is_reply
  FROM msg m
 ),
 nr AS (
  SELECT s.job_id, s.at, s.source_id, s.is_cust,
         min(CASE WHEN s.is_reply THEN s.at END) OVER (PARTITION BY s.job_id ORDER BY s.at DESC, s.is_reply, s.source_id DESC
                                                      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS next_reply
  FROM stream s WHERE s.is_cust OR s.is_reply
 ),
 cm AS (  -- a run starts at a customer message with no earlier customer message, or one answered before it
  SELECT n.job_id, n.at, n.next_reply,
         (lag(n.at) OVER w IS NULL OR lag(n.next_reply) OVER w <= n.at) AS run_start
  FROM nr n WHERE n.is_cust
  WINDOW w AS (PARTITION BY n.job_id ORDER BY n.at, n.source_id)
 ),
 st AS (
  SELECT c.job_id, count(*)::integer AS customer_messages,
         (count(*) FILTER (WHERE c.run_start AND c.next_reply IS NOT NULL))::integer AS replies,
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM c.next_reply - c.at) / 3600)
                FILTER (WHERE c.run_start AND c.next_reply IS NOT NULL))::numeric, 1) AS median_reply_hours,
         (count(*) FILTER (WHERE c.next_reply IS NULL))::integer AS unanswered
  FROM cm c GROUP BY c.job_id
 )
 SELECT jb.id AS job_id, lc.doc AS last_customer_message,
        -- an automated send (a debt chase, a follow-up text) is attached as newer_automated;
        -- when nothing went from a person it is still there, marked only_automated (story
        -- safety, 20261006040000: NULL || jsonb dropped it)
        CASE WHEN lt.doc IS NOT NULL
             THEN lt.doc || CASE WHEN la.at > lt.at THEN jsonb_build_object('newer_automated', la.doc) ELSE '{}'::jsonb END
             WHEN la.doc IS NOT NULL THEN jsonb_build_object('newer_automated', la.doc, 'only_automated', true) END AS last_to_customer,
        li.doc AS last_internal, ci.doc AS last_call_in, co.doc AS last_call_out,
        coalesce(st.customer_messages, 0) AS customer_messages, coalesce(st.replies, 0) AS replies,
        st.median_reply_hours, coalesce(st.unanswered, 0) AS unanswered
 FROM public.jobs jb
 LEFT JOIN lc ON lc.job_id = jb.id LEFT JOIN lt ON lt.job_id = jb.id LEFT JOIN la ON la.job_id = jb.id
 LEFT JOIN li ON li.job_id = jb.id LEFT JOIN ci ON ci.job_id = jb.id LEFT JOIN co ON co.job_id = jb.id
 LEFT JOIN st ON st.job_id = jb.id
 WHERE jb.id = ANY (p_job_ids)
$fn$;
COMMENT ON FUNCTION public.context_job_record_contact(uuid[], timestamptz) IS
 'Job record (20261006011000), story safety (20261006040000): when only automated sends went to the customer, last_to_customer is {newer_automated: the newest, only_automated: true}, never null. Earlier: per job the last customer message, the last thing we told the customer (never automated; a newer automated send is attached as newer_automated), the last internal (crew or staff) message, the last calls each way, and reply statistics (customer texts and emails; a run of customer messages is answered by the first later message from us or answered call; automated texts never count). Each jsonb is {at, channel, direction, text (300 chars; a call transcript is prefixed "Call (speakers not labelled): "), table, id, automated, event_type, placed_on (this_job | none)}; legacy mail from the client''s address that no job holds has placed_on none and placement_note "not placed on any job". Service role only.';

-- 7. The story.
CREATE OR REPLACE FUNCTION public.context_job_story_facts(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 -- (story safety, sixth review) every record that the work is finished, as 'completion' reads
 -- them, and the latest time the work was opened again: a status change into rectification or
 -- a make-safe re-attend (with the first record since, if any), so the story holds the final
 -- invoice while reopened work is not finished again (SWP-26354: completion pack 22 Jul,
 -- invoiced 24 Jul, back in rectification 19 Aug, the last 25% not invoiced)
 WITH cmp AS (
  SELECT je.created_at AS at, 'job_events'::text AS t, je.id::text AS id, 'Completion pack generated'::text AS what
  FROM public.job_events je
  WHERE je.job_id = p_job_id AND je.event_type = 'completion_pack_generated' AND je.created_at <= p_as_of
  UNION ALL
  SELECT coalesce(e.event_at, e.occurred_at), 'business_events', e.id::text,
         CASE WHEN e.event_type = 'job.completed' THEN 'Job marked completed' ELSE 'Job completed and invoiced' END
  FROM public.business_events e
  WHERE e.job_id = p_job_id AND e.event_type IN ('job.completed', 'invoice.completed_and_invoiced')
    AND coalesce(e.recorded_at, e.occurred_at) <= p_as_of
  UNION ALL
  SELECT je.created_at, 'job_events', je.id::text,
         CASE WHEN je.event_type = 'makesafe_substatus_changed' THEN 'Make-safe stage set to complete'
              ELSE 'Make-safe pack recorded as sent (staff note)' END
  FROM public.job_events je JOIN public.jobs jb ON jb.id = je.job_id
  WHERE je.job_id = p_job_id AND je.created_at <= p_as_of AND jb.type::text IN ('makesafe', 'repair', 'insurance')
    AND ((je.event_type = 'makesafe_substatus_changed' AND je.detail_json ->> 'substatus' = 'complete')
         OR (je.event_type = 'note' AND coalesce(je.detail_json ->> 'text', '') ~ '^\s*MAKESAFE_PACK_SENT'))
  UNION ALL
  SELECT h.at, h.t, h.id, 'Status set to ' || replace(h.to_s, '_', ' ') || ' (the app''s status history)'
  FROM (SELECT je.created_at AS at, 'job_events'::text AS t, je.id::text AS id,
               coalesce(je.detail_json ->> 'new_status', je.detail_json ->> 'to', je.detail_json ->> 'status') AS to_s
        FROM public.job_events je
        WHERE je.job_id = p_job_id AND je.event_type IN ('status_changed', 'status_change') AND je.created_at <= p_as_of
        UNION ALL
        SELECT coalesce(e.event_at, e.occurred_at), 'business_events', e.id::text, e.payload -> 'changes' -> 'status' ->> 'to'
        FROM public.business_events e
        WHERE e.job_id = p_job_id AND e.event_type = 'job.status_changed' AND coalesce(e.recorded_at, e.occurred_at) <= p_as_of) h
  WHERE h.to_s IN ('complete', 'completed', 'get_review', 'final_payment', 'invoiced')
    AND NOT EXISTS (SELECT 1 FROM public.jobs jb WHERE jb.id = p_job_id AND jb.status::text = 'rectification')
    AND NOT EXISTS (SELECT 1 FROM public.job_events w
                    WHERE w.job_id = p_job_id AND w.event_type IN ('status_changed', 'status_change') AND w.created_at <= p_as_of
                      AND w.created_at > h.at
                      AND coalesce(w.detail_json ->> 'new_status', w.detail_json ->> 'to', w.detail_json ->> 'status')
                          IN ('scheduled', 'schedule_install', 'in_progress', 'processing', 'order_materials', 'awaiting_supplier'))
    AND NOT EXISTS (SELECT 1 FROM public.business_events w
                    WHERE w.job_id = p_job_id AND w.event_type = 'job.status_changed' AND coalesce(w.recorded_at, w.occurred_at) <= p_as_of
                      AND coalesce(w.event_at, w.occurred_at) > h.at
                      AND w.payload -> 'changes' -> 'status' ->> 'to'
                          IN ('scheduled', 'schedule_install', 'in_progress', 'processing', 'order_materials', 'awaiting_supplier'))
 ),
 reo AS (
  SELECT r.at, r.t, r.id, r.what FROM (
   SELECT x.created_at AS at, 'job_events'::text AS t, x.id::text AS id,
          CASE WHEN x.event_type = 'makesafe_reattend' THEN 'Make-safe re-attend' ELSE 'Status set to rectification' END AS what
   FROM public.job_events x
   WHERE x.job_id = p_job_id AND x.created_at <= p_as_of
     AND (x.event_type = 'makesafe_reattend'
          OR (x.event_type IN ('status_changed', 'status_change')
              AND coalesce(x.detail_json ->> 'new_status', x.detail_json ->> 'to', x.detail_json ->> 'status') = 'rectification'))
   UNION ALL
   SELECT coalesce(e.event_at, e.occurred_at), 'business_events', e.id::text, 'Status set to rectification'
   FROM public.business_events e
   WHERE e.job_id = p_job_id AND e.event_type = 'job.status_changed' AND coalesce(e.recorded_at, e.occurred_at) <= p_as_of
     AND e.payload -> 'changes' -> 'status' ->> 'to' = 'rectification') r
  ORDER BY r.at DESC, r.t COLLATE "C" DESC, r.id COLLATE "C" DESC LIMIT 1
 )
 SELECT jsonb_build_object(
  'bookings', coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'scheduled_date', a.scheduled_date, 'status', a.status,
                'assignment_type', a.assignment_type, 'crew_name', a.crew_name, 'created_at', a.created_at,
                'started_at', CASE WHEN a.started_at <= p_as_of THEN a.started_at END,
                'completed_at', CASE WHEN a.completed_at <= p_as_of THEN a.completed_at END) ORDER BY a.scheduled_date, a.id)
              FROM public.job_assignments a
              WHERE a.job_id = p_job_id AND a.created_at <= p_as_of AND NOT coalesce(a.is_ghost, false) AND coalesce(a.role, '') <> 'observer'),
             '[]'::jsonb),
  'quotes', coalesce((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'quote_number', d.quote_number, 'version', d.version,
                'sent_at', CASE WHEN d.sent_at <= p_as_of THEN d.sent_at END,
                'accepted_at', CASE WHEN d.accepted_at <= p_as_of THEN d.accepted_at END,
                'declined_at', CASE WHEN d.declined_at <= p_as_of THEN d.declined_at END,
                'superseded_at', CASE WHEN d.superseded_at <= p_as_of THEN d.superseded_at END) ORDER BY d.created_at, d.id)
              FROM public.job_documents d WHERE d.job_id = p_job_id AND d.type = 'quote' AND d.created_at <= p_as_of), '[]'::jsonb),
  -- the report pack sent to the builder: the release's derived sent events, or (story safety,
  -- fourth review) the pack-sent note staff wrote before those began (MAKESAFE_PACK_SENT), on
  -- builder work; after a make-safe re-attend only a send since it counts
  'report_sent_at', (SELECT min(je.created_at) FROM public.job_events je JOIN public.jobs jb ON jb.id = je.job_id
                     WHERE je.job_id = p_job_id AND je.created_at <= p_as_of
                       AND (je.event_type IN ('makesafe_report_sent_at_derived', 'makesafe_pack_sent_at_derived')
                            OR (je.event_type = 'note' AND jb.type::text IN ('makesafe', 'repair', 'insurance')
                                AND coalesce(je.detail_json ->> 'text', '') ~ '^\s*MAKESAFE_PACK_SENT'))
                       AND je.created_at > coalesce((SELECT max(r.created_at) FROM public.job_events r
                                                     WHERE r.job_id = p_job_id AND r.event_type = 'makesafe_reattend' AND r.created_at <= p_as_of),
                                                    '-infinity'::timestamptz)),
  -- story safety (20261006040000): the first record that the work is finished (a
  -- completion pack, the job marked completed, completed and invoiced), the job row's
  -- completed stamp, and on builder work the builder the make-safe details name. Fourth
  -- review: also, on builder work, the make-safe stage set to complete and the pack-sent
  -- note staff wrote; and a status change into a completion status in the app's history
  -- with no later change back into scheduled or install work (while the job is not in
  -- rectification now). After a make-safe re-attend only a record since it counts.
  'completion', (SELECT jsonb_build_object('at', z.at, 't', z.t, 'id', z.id, 'what', z.what) FROM cmp z
   WHERE z.at > coalesce((SELECT max(r.created_at) FROM public.job_events r
                          WHERE r.job_id = p_job_id AND r.event_type = 'makesafe_reattend' AND r.created_at <= p_as_of), '-infinity'::timestamptz)
   ORDER BY z.at, z.t COLLATE "C", z.id COLLATE "C" LIMIT 1),
  -- (sixth review) the latest time the work was opened again (a status change into
  -- rectification, or a make-safe re-attend) and the first record since that it is finished
  -- (completed_since; null while it is not): {at, t, id, what, completed_since}
  'reopened', (SELECT jsonb_build_object('at', reo.at, 't', reo.t, 'id', reo.id, 'what', reo.what,
                 'completed_since', (SELECT min(z.at) FROM cmp z WHERE z.at > reo.at)) FROM reo),
  'status_completed_at', (SELECT CASE WHEN jb.completed_at <= p_as_of THEN jb.completed_at END FROM public.jobs jb WHERE jb.id = p_job_id),
  'builder', (SELECT nullif(btrim(d.requesting_company_name), '') FROM public.makesafe_job_details d JOIN public.jobs jb ON jb.id = d.job_id
              WHERE d.job_id = p_job_id AND jb.type::text IN ('makesafe', 'repair', 'insurance')
              ORDER BY d.created_at DESC NULLS LAST LIMIT 1),
  'parties', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.client_name,
                'role', CASE WHEN coalesce(c.is_primary, false) OR c.contact_type = 'primary' THEN 'customer' ELSE coalesce(c.contact_type, 'party') END,
                'contact_ref', c.ghl_contact_id) ORDER BY c.created_at, c.id)
              FROM public.job_contacts c WHERE c.job_id = p_job_id AND c.removed_at IS NULL), '[]'::jsonb),
  'closing', coalesce((SELECT jsonb_agg(x) FROM (
     SELECT jsonb_build_object('closes_on', 'quote_sent', 'about_key', 'quote:' || lower(coalesce(nullif(btrim(d.quote_number), ''), 'doc-' || left(d.id::text, 8))),
            'at', d.sent_at, 't', 'job_documents', 'id', d.id, 'what', 'Quote ' || coalesce(d.quote_number, 'without a number') || ' sent') AS x
     FROM public.job_documents d WHERE d.job_id = p_job_id AND d.type = 'quote' AND d.sent_at <= p_as_of
     UNION ALL
     SELECT jsonb_build_object('closes_on', 'invoice_issued', 'about_key', 'invoice:' || lower(coalesce(nullif(btrim(x.invoice_number), ''), 'id-' || left(x.id::text, 8))),
            'at', coalesce(x.created_at, x.invoice_date::timestamp AT TIME ZONE 'Australia/Perth'), 't', 'xero_invoices', 'id', x.id,
            'what', 'Invoice ' || coalesce(x.invoice_number, 'without a number') || ' issued')
     FROM public.xero_invoices x
     WHERE x.job_id = p_job_id AND upper(coalesce(x.invoice_type, 'ACCREC')) = 'ACCREC'
       AND upper(coalesce(x.status, '')) IN ('AUTHORISED', 'SUBMITTED', 'PAID') AND coalesce(x.created_at, '-infinity'::timestamptz) <= p_as_of
     UNION ALL
     -- a payment closes only when the invoice is cleared: the payment that cleared it
     SELECT jsonb_build_object('closes_on', 'payment', 'about_key', 'invoice:' || lower(coalesce(nullif(btrim(x.invoice_number), ''), 'id-' || left(x.id::text, 8))),
            'at', pc.at, 't', 'xero_invoices', 'id', x.id,
            'what', 'Invoice ' || coalesce(x.invoice_number, 'without a number') || ' paid in full')
     FROM public.xero_invoices x
     CROSS JOIN LATERAL (
      SELECT coalesce(max(to_timestamp(substring(p->>'Date' FROM '^/Date\((-?[0-9]+)')::numeric / 1000)),
                      x.fully_paid_on::timestamp AT TIME ZONE 'Australia/Perth') AS at
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.raw_json->'Payments') = 'array' THEN x.raw_json->'Payments' ELSE '[]'::jsonb END) p
      WHERE p->>'Date' ~ '^/Date\(-?[0-9]+') pc
     WHERE x.job_id = p_job_id AND upper(coalesce(x.invoice_type, 'ACCREC')) = 'ACCREC' AND upper(coalesce(x.status, '')) = 'PAID'
       AND pc.at <= p_as_of
     UNION ALL
     -- a booking is made while it stands (not cancelled, deleted, draft, disputed or
     -- declined; crew planning's confirmation is never read), at its created time
     SELECT jsonb_build_object('closes_on', 'booking_made', 'about_key', 'booking:' || a.scheduled_date, 'at', a.created_at,
            't', 'job_assignments', 'id', a.id, 'what', 'Booking made for ' || to_char(a.scheduled_date, 'Dy FMDD Mon YYYY'))
     FROM public.job_assignments a
     WHERE a.job_id = p_job_id AND a.created_at <= p_as_of AND a.scheduled_date IS NOT NULL
       AND NOT coalesce(a.is_ghost, false) AND coalesce(a.role, '') <> 'observer'
       AND lower(coalesce(a.status, '')) NOT IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined')
     UNION ALL
     -- a visit is attendance: completed_at, else started_at, else a status-only
     -- completion at the end of the booked Perth day (now while that is ahead)
     SELECT jsonb_build_object('closes_on', 'visit', 'about_key', 'booking:' || a.scheduled_date,
            'at', v.at, 't', 'job_assignments', 'id', a.id,
            'what', CASE WHEN a.completed_at IS NOT NULL OR a.started_at IS NOT NULL
                         THEN 'Crew recorded the ' || to_char(a.scheduled_date, 'Dy FMDD Mon YYYY') || ' visit'
                         ELSE 'Booking status complete for ' || to_char(a.scheduled_date, 'Dy FMDD Mon YYYY') || ' (who and when not recorded)' END)
     FROM public.job_assignments a
     CROSS JOIN LATERAL (SELECT coalesce(a.completed_at, a.started_at,
       CASE WHEN lower(coalesce(a.status, '')) IN ('complete', 'completed') AND a.scheduled_date IS NOT NULL
            THEN least(((a.scheduled_date + 1)::timestamp AT TIME ZONE 'Australia/Perth') - interval '1 second', now()) END) AS at) v
     WHERE a.job_id = p_job_id AND v.at <= p_as_of
       AND NOT coalesce(a.is_ghost, false) AND coalesce(a.role, '') <> 'observer'
  ) z), '[]'::jsonb)
 )
$fn$;
COMMENT ON FUNCTION public.context_job_story_facts(uuid, timestamptz) IS
 'Job story (20261006014000), story safety (20261006040000): also completion (the first record that the work is finished: a completion pack, the job marked completed, or completed and invoiced; on builder work also the make-safe stage set to complete and the pack-sent note staff wrote (MAKESAFE_PACK_SENT); and a status change into a completion status in the app''s history with no later change back into scheduled or install work, while the job is not in rectification now; after a make-safe re-attend only a record since it counts; {at, t, id, what}), (sixth review) reopened (the latest time the work was opened again: a status change into rectification or a make-safe re-attend, {at, t, id, what, completed_since}: the first completion record since it, null while there is none), status_completed_at (the job row''s completed stamp) and builder (on make-safe, repair and insurance work, the builder the make-safe details name); report_sent_at also reads the pack-sent note on builder work, and after a re-attend only a send since it. Earlier: structured record facts for the story assembler: crew bookings (observer mirrors excluded), quote versions, make-safe report sent time, parties (job_contacts), and closing candidates (quote sent, invoice issued, payment, booking made, visit) keyed by the ledger about_key vocabulary. Service role only.';

CREATE OR REPLACE FUNCTION public.context_job_story_meta(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH jb0 AS (SELECT j.created_at, nullif(btrim(j.ghl_contact_id), '') AS contact, nullif(btrim(j.xero_contact_id), '') AS jxc,
                     j.type::text AS jtype FROM public.jobs j WHERE j.id = p_job_id),
 e AS (
  SELECT CASE WHEN x.event_type = 'call.transcript_completed' THEN 'transcripts'
              WHEN x.channel = 'sms' OR x.event_type IN ('client.reply', 'client.sms_in', 'client.sms_out') THEN 'texts'
              WHEN x.channel = 'email' OR x.event_type IN ('client.email_in', 'client.email_out', 'supplier.email_in', 'staff.email_internal') THEN 'emails'
              WHEN x.channel = 'call' OR x.event_type IN ('client.call_logged', 'client.call_complete') THEN 'calls'
              WHEN x.event_type IN ('note.added', 'ghl.internal_comment') OR x.channel = 'note' THEN 'notes'
              WHEN x.event_type = 'document.text_extracted' THEN 'documents' END AS lane,
         -- a CRM text loaded later is timed by the CRM's own time; one from before the job's
         -- lead window is not this job's history (story safety, 20261006040000); one whose CRM
         -- time is no longer known is time unknown (sixth review): counted, never a newest or
         -- oldest time
         coalesce(ct.crm_at, x.event_at, x.occurred_at) AS at,
         coalesce(ct.crm_at < (SELECT jb0.created_at FROM jb0) - interval '30 days', false) AS before_job,
         (x.source = 'ghl_sms_cache_backfill' AND ct.crm_at IS NULL) AS time_unknown
  FROM public.business_events x
  CROSS JOIN LATERAL (SELECT CASE WHEN x.source = 'ghl_sms_cache_backfill'
                                  THEN public.context_job_record_crm_time(x.source, x.contact_id,
                                         coalesce(nullif(btrim(x.payload ->> 'ghl_message_id'), ''), substring(x.provider_message_id FROM '^ghl:(.+)$')), x.job_id)
                             END AS crm_at) ct
  -- the rows the record shows (every row on the job), so "no texts" never sits beside texts;
  -- a row marked as a copy of another is not shown, so it is not counted (20261006031000)
  WHERE x.job_id = p_job_id AND coalesce(x.recorded_at, x.occurred_at) <= p_as_of
    AND x.metadata #>> '{duplicate_of}' IS NULL
 ),
 l AS (SELECT e.lane, count(*) AS n, max(e.at) FILTER (WHERE NOT e.before_job AND NOT e.time_unknown) AS newest,
              min(e.at) FILTER (WHERE NOT e.before_job AND NOT e.time_unknown) AS oldest FROM e WHERE e.lane IS NOT NULL GROUP BY e.lane),
 bj AS (SELECT count(*) AS n, max(e.at) AS newest FROM e WHERE e.before_job),
 tu AS (SELECT count(*) AS n FROM e WHERE e.time_unknown),
 lgm AS MATERIALIZED (SELECT m.id, m.graph_message_id, m.received_at, m.placement
                      FROM public.context_job_record_legacy_mail(ARRAY[p_job_id], p_as_of) m),
 lg AS (  -- legacy inbox mail the record layer reads counts as email
  SELECT count(*) AS n, max(m.received_at) AS newest, min(m.received_at) AS oldest FROM lgm m WHERE m.placement <> 'withheld'
 ),
 -- the mail the record shows from the old inbox (lgm, never withheld) that has a saved copy
 -- by the record's copy keys, recorded by p_as_of: the record keeps a mail only when no copy
 -- sits on this job, so that copy is on another job or on no job; named in not_known, so
 -- its count is the mail the story shows (story safety, 20261006040000)
 ce AS (
  SELECT count(*) AS n FROM lgm m
  WHERE m.placement <> 'withheld'
    AND (EXISTS (SELECT 1 FROM public.business_events c WHERE c.source_table = 'inbox_events' AND c.source_id = m.id::text
                 AND coalesce(c.recorded_at, c.occurred_at) <= p_as_of)
         OR EXISTS (SELECT 1 FROM public.business_events c WHERE m.graph_message_id IS NOT NULL AND c.provider_message_id = 'graph:' || m.graph_message_id
                    AND coalesce(c.recorded_at, c.occurred_at) <= p_as_of)
         OR EXISTS (SELECT 1 FROM public.business_events c WHERE c.payload @> jsonb_build_object('inbox_events_id', m.id::text)
                    AND coalesce(c.recorded_at, c.occurred_at) <= p_as_of))
 ),
 wh AS (  -- a repeat client's mail placed on no job: not this job's, said so
  SELECT count(*) AS n, max(m.received_at) AS newest FROM lgm m WHERE m.placement = 'withheld'
 ),
 -- this customer's messages not placed on any job yet that could be this job's (the placement
 -- queue's: counted) and (sixth review) every other row of their CRM contact placed on no job,
 -- whatever the ladder made of it (attribution status null or empty: no queue holds it, so it is
 -- never counted, but the newest each way is named)
 uo AS (
  SELECT u.id, u.job_id, u.contact_id, u.source, u.provider_message_id, u.payload, u.metadata, u.direction, u.channel, u.event_type,
         u.event_at, u.occurred_at, u.recorded_at, true AS queued,
         lower(coalesce(u.payload ->> 'call_status', substring(public.context_event_text(u) FROM 'Provider status: ([A-Za-z_-]+)'), '')) AS call_status,
         public.context_internal_text_role(u) AS irole
  FROM public.context_unplaced_for_job(p_job_id) u
  UNION ALL
  SELECT x.id, x.job_id, x.contact_id, x.source, x.provider_message_id, x.payload, x.metadata, x.direction, x.channel, x.event_type,
         x.event_at, x.occurred_at, x.recorded_at, false,
         lower(coalesce(x.payload ->> 'call_status', substring(public.context_event_text(x) FROM 'Provider status: ([A-Za-z_-]+)'), '')),
         public.context_internal_text_role(x)
  FROM public.business_events x
  WHERE x.contact_id = (SELECT jb0.contact FROM jb0) AND x.job_id IS NULL
    AND coalesce(x.attribution_status, '') NOT IN ('pending_luna', 'unplaced', 'admin_bucket', 'automated')
 ),
 un AS (
  SELECT count(*) FILTER (WHERE u.queued) AS n, max(ut.at) FILTER (WHERE u.queued AND NOT ut.before_job AND NOT ut.time_unknown) AS newest,
         -- (story safety, fourth review) as of p_as_of, the newest from the customer (a text or
         -- email, or a call answered or transcribed) and the newest we sent them that was not
         -- automated, so the line never says there is no customer message while one waits here
         max(ut.at) FILTER (
          WHERE NOT ut.before_job AND NOT ut.time_unknown AND u.direction = 'inbound' AND u.metadata #>> '{duplicate_of}' IS NULL
            AND coalesce(u.recorded_at, u.occurred_at) <= p_as_of AND ut.at <= p_as_of
            AND coalesce(u.metadata #>> '{party_roles,sender_role}', u.metadata #>> '{party_roles,counterpart_role}',
                         CASE WHEN u.event_type LIKE 'client.%' THEN 'customer' END) = 'customer'
            AND (u.channel IN ('sms', 'email')
                 OR ((u.channel = 'call' OR u.event_type IN ('client.call_logged', 'client.call_complete', 'call.transcript_completed'))
                     AND (u.event_type = 'call.transcript_completed' OR u.call_status IN ('completed', 'answered'))))) AS newest_in,
         max(ut.at) FILTER (
          WHERE NOT ut.before_job AND NOT ut.time_unknown AND u.direction = 'outbound' AND u.metadata #>> '{duplicate_of}' IS NULL
            AND coalesce(u.recorded_at, u.occurred_at) <= p_as_of AND ut.at <= p_as_of
            AND coalesce(u.metadata #>> '{party_roles,counterpart_role}', u.metadata #>> '{party_roles,recipient_role}',
                         CASE WHEN u.event_type LIKE 'client.%' THEN 'customer' END) = 'customer'
            AND (u.channel IN ('sms', 'email', 'call') OR u.event_type IN ('client.sms_out', 'client.email_out', 'client.call_logged', 'client.call_complete'))
            AND coalesce(u.payload ->> 'sent_by_kind', '') <> 'workflow' AND u.irole = 'other') AS newest_out
  FROM uo u
  -- a CRM text loaded later from the CRM's cache is at the CRM's own time, and one the CRM
  -- dates more than 30 days before the job was created is not this job's history (as the
  -- lanes read the job's own), nor one whose CRM time is no longer known (sixth review):
  -- counted, never the newest of either side
  CROSS JOIN LATERAL (SELECT CASE WHEN u.source = 'ghl_sms_cache_backfill'
                                  THEN public.context_job_record_crm_time(u.source, u.contact_id,
                                         coalesce(nullif(btrim(u.payload ->> 'ghl_message_id'), ''), substring(u.provider_message_id FROM '^ghl:(.+)$')), u.job_id)
                             END AS crm_at) ct
  CROSS JOIN LATERAL (SELECT coalesce(ct.crm_at, u.event_at, u.occurred_at) AS at,
                             coalesce(ct.crm_at < (SELECT jb0.created_at FROM jb0) - interval '30 days', false) AS before_job,
                             (u.source = 'ghl_sms_cache_backfill' AND ct.crm_at IS NULL) AS time_unknown) ut
 ),
 -- (sixth review) customer invoices placed on no job addressed to this job's own Xero contact
 -- (the job's, or one on its own invoices; never on builder work, nor a contact billed on
 -- builder work, whose invoices are the builder's), still owing, recorded by p_as_of and made
 -- no earlier than 30 days before the job: the story names each, so it never says "owing
 -- $0.00" over a debt of this job's client that sits on no job (bda6e1de's INV-0290)
 jx AS (
  SELECT DISTINCT z.x FROM (SELECT jb0.jxc AS x FROM jb0
                            UNION ALL
                            SELECT nullif(btrim(i.xero_contact_id), '') FROM public.xero_invoices i
                            WHERE i.job_id = p_job_id AND upper(coalesce(i.invoice_type, 'ACCREC')) = 'ACCREC'
                              AND upper(coalesce(i.status, '')) NOT IN ('DELETED', 'VOIDED')
                              AND coalesce(i.created_at, i.synced_at, '-infinity'::timestamptz) <= p_as_of) z
  WHERE z.x IS NOT NULL AND (SELECT jb0.jtype FROM jb0) NOT IN ('makesafe', 'repair', 'insurance')
    AND NOT EXISTS (SELECT 1 FROM public.xero_invoices b JOIN public.jobs bj ON bj.id = b.job_id
                    WHERE b.xero_contact_id = z.x AND bj.type::text IN ('makesafe', 'repair', 'insurance'))
 ),
 ui AS (
  SELECT i.id, i.invoice_number, i.contact_name, i.amount_due, i.due_date,
         CASE WHEN i.due_date < (p_as_of AT TIME ZONE 'Australia/Perth')::date
              THEN (p_as_of AT TIME ZONE 'Australia/Perth')::date - i.due_date END AS days_overdue
  FROM public.xero_invoices i
  WHERE i.job_id IS NULL AND i.xero_contact_id IN (SELECT jx.x FROM jx)
    AND upper(coalesce(i.invoice_type, 'ACCREC')) = 'ACCREC' AND upper(coalesce(i.status, '')) IN ('AUTHORISED', 'SUBMITTED')
    AND coalesce(i.amount_due, 0) > 0 AND coalesce(i.created_at, i.synced_at, '-infinity'::timestamptz) <= p_as_of
    AND coalesce(i.created_at, i.synced_at, '-infinity'::timestamptz) >= (SELECT jb0.created_at FROM jb0) - interval '30 days'
 ),
 jb AS (SELECT nullif(btrim(j.ghl_contact_id), '') IS NULL AS contact_missing FROM public.jobs j WHERE j.id = p_job_id)
 SELECT jsonb_build_object(
  'lanes', jsonb_build_object(
     'texts', coalesce((SELECT l.n FROM l WHERE l.lane = 'texts'), 0),
     'emails', coalesce((SELECT l.n FROM l WHERE l.lane = 'emails'), 0) + (SELECT lg.n FROM lg),
     'calls', coalesce((SELECT l.n FROM l WHERE l.lane = 'calls'), 0) + coalesce((SELECT l.n FROM l WHERE l.lane = 'transcripts'), 0),
     'transcripts', coalesce((SELECT l.n FROM l WHERE l.lane = 'transcripts'), 0),
     'notes', coalesce((SELECT l.n FROM l WHERE l.lane = 'notes'), 0),
     'documents', coalesce((SELECT l.n FROM l WHERE l.lane = 'documents'), 0)),
  'sources', coalesce((SELECT jsonb_object_agg(l.lane, l.newest) FROM l), '{}'::jsonb)
             || CASE WHEN (SELECT lg.n FROM lg) > 0 THEN jsonb_build_object('legacy_inbox', (SELECT lg.newest FROM lg)) ELSE '{}'::jsonb END,
  'history_start', (SELECT min(x) FROM (SELECT l.oldest AS x FROM l WHERE l.lane IN ('texts', 'emails', 'calls', 'transcripts')
                                       UNION ALL SELECT lg.oldest FROM lg) z),
  'evidence_rows', (SELECT coalesce(sum(l.n), 0) FROM l) + (SELECT lg.n FROM lg),
  'unplaced', (SELECT jsonb_build_object('count', un.n, 'newest_at', un.newest, 'newest_customer_at', un.newest_in,
                                         'newest_reply_at', un.newest_out) FROM un),
  'withheld_mail', (SELECT jsonb_build_object('count', wh.n, 'newest_at', wh.newest) FROM wh),
  'mail_copy_elsewhere', (SELECT jsonb_build_object('count', ce.n) FROM ce),
  'before_job_texts', (SELECT jsonb_build_object('count', bj.n, 'newest_at', bj.newest) FROM bj),
  'time_unknown_texts', (SELECT jsonb_build_object('count', tu.n) FROM tu),
  'unplaced_invoices', (SELECT jsonb_build_object('count', count(*), 'owing', coalesce(sum(ui.amount_due), 0),
                                 'items', coalesce(jsonb_agg(jsonb_build_object('id', ui.id, 'number', ui.invoice_number, 'party', ui.contact_name,
                                                   'owing', ui.amount_due, 'due_date', ui.due_date, 'days_overdue', ui.days_overdue)
                                                   ORDER BY ui.due_date NULLS LAST, ui.invoice_number COLLATE "C", ui.id), '[]'::jsonb))
                        FROM ui),
  'contact_missing', coalesce((SELECT jb.contact_missing FROM jb), false)
 )
$fn$;
COMMENT ON FUNCTION public.context_job_story_meta(uuid, timestamptz) IS
 'Job story (20261006014000), story safety (20261006040000): (sixth review) unplaced''s newest_customer_at and newest_reply_at also read every other row of this customer''s CRM contact placed on no job, whatever the ladder made of it (attribution status null or empty: never in the placement queue, so never in unplaced.count or newest_at); a CRM text whose CRM time is no longer known is time unknown: counted in time_unknown_texts {count} (on the job), never a lane''s or the unplaced newest or oldest time; unplaced_invoices {count, owing, items: [{id, number, party, owing, due_date, days_overdue}]}: the customer invoices placed on no job addressed to this job''s own Xero contact (the job''s, or one on its own invoices; never on builder work, nor a contact billed on builder work), still owing, recorded by p_as_of and made no earlier than 30 days before the job. Earlier: unplaced also gives newest_customer_at (the newest of this customer''s messages not placed on any job, as of p_as_of: a text or email, or a call answered or transcribed) and newest_reply_at (the newest we sent them there, never automated), so the story''s line never says there is no customer message while one waits unplaced; times a CRM text loaded later by the CRM''s own time (context_job_record_crm_time), on the job and placed on no job alike; history start, each lane''s newest and oldest and the unplaced newest_at, newest_customer_at and newest_reply_at leave out texts dated before the job''s lead window (still counted: on the job in before_job_texts {count, newest_at}, placed on no job in unplaced.count, the placement queue''s); mail_copy_elsewhere {count}: the legacy mail the record shows (context_job_record_legacy_mail, never withheld) that has a saved copy recorded by p_as_of, which then sits on another job or on no job (shown from the old inbox), so the count is the mail the story shows. Earlier: evidence lanes on the job (linked rows only; counts and newest time per lane, legacy inbox mail counted as email), history start (rows marked as a copy of another, metadata.duplicate_of, are not counted, 20261006031000), this customer''s unplaced messages (context_unplaced_for_job), the legacy mail withheld because the client has another job (withheld_mail: counted, never the job''s email), and whether the job has a CRM contact. Unplaced messages are read as now. How far the reader has read comes from the ledger read, never the fact pass. Service role only.';

CREATE OR REPLACE FUNCTION public.context_job_story_assemble(p_job jsonb, p_record jsonb, p_ledger jsonb, p_meta jsonb,
 p_as_of timestamptz, p_since timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql STABLE
AS $fn$
 WITH inp AS MATERIALIZED (
  SELECT p_job AS job, coalesce(p_record, '{}'::jsonb) AS rec, coalesce(p_ledger, '{}'::jsonb) AS led,
         coalesce(p_meta, '{}'::jsonb) AS meta, p_as_of AS as_of, (p_as_of AT TIME ZONE 'Australia/Perth')::date AS today,
         p_since AS since
 ),
 tl AS MATERIALIZED (
  SELECT t.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'timeline', '[]'::jsonb))
   AS t(at timestamptz, perth_date date, time_basis text, kind text, what text, amount numeric, party text, placement text,
        source_table text, source_id text, state text, made_at timestamptz)
 ),
 rl AS MATERIALIZED (
  SELECT l.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'loops', '[]'::jsonb))
   AS l(rule text, loop_key text, shown_as text, owner text, counterparty text, what text, why text, opened_at timestamptz,
        due_date date, amount numeric, about_key text, closes_when text, source_table text, source_id text, placement text)
 ),
 mo AS MATERIALIZED (
  SELECT m.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'money', '[]'::jsonb))
   AS m(party text, xero_contact_id text, invoiced numeric, paid numeric, credited numeric, owing numeric, overdue numeric,
        oldest_overdue_due date, drafts integer, draft_total numeric, invoices jsonb, job_value numeric, job_value_basis text,
        not_yet_invoiced numeric, supplier_bills jsonb)
 ),
 bk AS MATERIALIZED (  -- crew bookings (observer mirrors are not passed in)
  SELECT b.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'facts'->'bookings', '[]'::jsonb))
   AS b(id text, scheduled_date date, status text, assignment_type text, crew_name text, created_at timestamptz,
        started_at timestamptz, completed_at timestamptz)
 ),
 qd AS MATERIALIZED (
  SELECT q.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'facts'->'quotes', '[]'::jsonb))
   AS q(id text, quote_number text, version integer, sent_at timestamptz, accepted_at timestamptz, declined_at timestamptz,
        superseded_at timestamptz)
 ),
 cc AS MATERIALIZED (  -- records that may close a ledger item (closing evidence only)
  SELECT c.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'facts'->'closing', '[]'::jsonb))
   AS c(closes_on text, about_key text, at timestamptz, t text, id text, what text)
 ),
 li AS MATERIALIZED (  -- ledger items of the generation shown, with the citation re-check result
                       -- (what with em and en dashes replaced, as the store now writes it)
  SELECT i.* FROM inp, jsonb_to_recordset((SELECT coalesce(jsonb_agg(x || jsonb_build_object('what',
            btrim(replace(regexp_replace(x->>'what', '\s*' || chr(8212) || '\s*', ', ', 'g'), chr(8211), '-')))), '[]'::jsonb)
          FROM jsonb_array_elements(coalesce(inp.led->'items', '[]'::jsonb)) x))
   AS i(item_key text, item_type text, status text, from_role text, from_name text, to_role text, to_name text, what text,
        about_key text, modality text, phase text, due_date date, opened_at timestamptz, opened_by jsonb, closed_at timestamptz,
        closed_by jsonb, closes_on text, supersedes_key text, blocks text, needs_reply boolean, written_by text,
        person_locked boolean, cites_ok boolean, cited jsonb)
 ),
 vis AS MATERIALIZED (SELECT li.* FROM li WHERE coalesce(li.cites_ok, true)),
 led AS (  -- the generation shown (a JSON null generation is none), what its reader has not read yet,
           -- and the customer rows it has read (a candidate is judged only when its row is one)
  SELECT x.*,
         -- a finished reading is shown: live (promoted) or retired, or a shadow, which the
         -- story shows only when asked for it by id (the default view shows the live one),
         -- so a grade reads the line a promotion gives; a building or failed one never counts
         -- as read (story safety, 20261006040000, fourth review)
         (x.gen IS NOT NULL AND x.status IN ('live', 'retired', 'shadow')) AS live_read,
         -- and it has read every row on the job: none landed after it (an unknown count
         -- is not none). Only then may nothing open be an all-clear.
         (x.gen IS NOT NULL AND x.status IN ('live', 'retired', 'shadow')
          AND coalesce((inp.led->>'unread_rows')::integer = 0, false)) AS words_read,
         CASE WHEN x.gen IS NOT NULL THEN (inp.led->>'unread_rows')::integer END AS unread,
         CASE WHEN x.gen IS NOT NULL THEN coalesce(inp.led->'unread_ids', '[]'::jsonb) END AS unread_ids,
         CASE WHEN x.gen IS NOT NULL THEN coalesce(inp.led->'read_ids', '[]'::jsonb) END AS read_ids
  FROM inp, LATERAL (
   SELECT coalesce(nullif(inp.led->>'status', ''), 'none') AS status, nullif(inp.led->'generation', 'null'::jsonb) AS gen,
          (inp.led->'generation'->>'evidence_until')::timestamptz AS evidence_until,
          (SELECT count(*) FROM vis) AS items, (SELECT count(*) FROM li WHERE NOT coalesce(li.cites_ok, true)) AS hidden,
          (SELECT count(*) FROM li WHERE NOT coalesce(li.cites_ok, true) AND coalesce(li.person_locked, false)) AS hidden_locked) x
 ),
 -- money totals
 mt AS (
  SELECT coalesce(sum(mo.invoiced), 0) AS invoiced, coalesce(sum(mo.paid), 0) AS paid, coalesce(sum(mo.credited), 0) AS credited,
         coalesce(sum(mo.owing), 0) AS owing, coalesce(sum(mo.overdue), 0) AS overdue, min(mo.oldest_overdue_due) AS oldest_overdue,
         coalesce(sum(mo.drafts), 0) AS drafts, coalesce(sum(mo.draft_total), 0) AS draft_total,
         max(mo.job_value) AS job_value, max(mo.job_value_basis) AS job_value_basis, max(mo.not_yet_invoiced) AS nyi,
         count(*) FILTER (WHERE mo.party IS NOT NULL) AS parties,
         (SELECT m2.supplier_bills FROM mo m2 LIMIT 1) AS bills,
         -- the paying parties that owe now: with more than one, the first line names each
         count(*) FILTER (WHERE mo.party IS NOT NULL AND mo.owing > 0) AS parties_owing
  FROM mo
 ),
 -- every invoice owing now, by due date: the first line names each (up to three), and who
 -- owes it when that is not the customer (a neighbour or another payer: its payer role, or
 -- for a money row without one its R1, R2 or M1 loop's owner)
 oi AS (
  SELECT i ->> 'id' AS id, i ->> 'number' AS num, (i ->> 'owing')::numeric AS owing, (i ->> 'due_date')::date AS due,
         coalesce((i ->> 'overdue')::boolean, false) AS overdue, (i ->> 'days_overdue')::integer AS days, m.party,
         CASE WHEN i ->> 'payer_role' IN ('neighbour', 'strata', 'other_party', 'other_payer') THEN i ->> 'payer_role'
              WHEN i ->> 'payer_role' IS NULL
                   AND EXISTS (SELECT 1 FROM rl WHERE rl.source_table = 'xero_invoices' AND rl.source_id = i ->> 'id'
                                 AND rl.rule IN ('R1_overdue', 'R2_part_paid', 'M1_money_due') AND rl.owner = 'third_party')
              THEN 'third_party' END AS third,
         row_number() OVER (ORDER BY (i ->> 'due_date')::date NULLS LAST, i ->> 'number' COLLATE "C", i ->> 'id' COLLATE "C") AS o
  FROM mo m CROSS JOIN LATERAL jsonb_array_elements(coalesce(m.invoices, '[]'::jsonb)) i
  WHERE m.party IS NOT NULL AND jsonb_typeof(i -> 'owing') = 'number' AND (i ->> 'owing')::numeric > 0
 ),
 -- (sixth review) customer invoices placed on no job addressed to this job's own Xero contact,
 -- still owing (meta unplaced_invoices), and the words that name them in the first line and
 -- the money line
 uinv AS (
  SELECT i ->> 'id' AS id, i ->> 'number' AS num, (i ->> 'owing')::numeric AS owing, (i ->> 'due_date')::date AS due,
         (i ->> 'days_overdue')::integer AS days, x.o
  FROM inp, jsonb_array_elements(coalesce(inp.meta -> 'unplaced_invoices' -> 'items', '[]'::jsonb)) WITH ORDINALITY x(i, o)
  WHERE jsonb_typeof(i -> 'owing') = 'number' AND (i ->> 'owing')::numeric > 0
 ),
 uw AS (
  SELECT 'owing on ' || CASE WHEN count(*) = 1 THEN 'an invoice' ELSE 'invoices' END
         || ' placed on no job (addressed to this job''s Xero contact): '
         || string_agg(coalesce(u.num, 'an invoice without a number') || ' ' || to_char(u.owing, 'FM$999,999,990.00')
                       || CASE WHEN u.days IS NOT NULL AND u.due IS NOT NULL
                               THEN ' overdue since ' || public.context_job_story_day(u.due, inp.today) || ' (' || u.days || ' days)'
                               WHEN u.due IS NOT NULL THEN ' due ' || public.context_job_story_day(u.due, inp.today)
                               ELSE ', no due date in Xero' END, '; ' ORDER BY u.o) AS words
  FROM uinv u, inp
  GROUP BY inp.today
 ),
 -- a record disagrees with the job value (check C2): no amount left to invoice is stated as fact
 unconf AS (
  SELECT EXISTS (SELECT 1 FROM rl WHERE rl.rule = 'C2_value_mismatch') AS on_,
         EXISTS (SELECT 1 FROM rl WHERE rl.rule = 'R8_not_yet_invoiced' AND rl.amount IS NULL) AS r8
 ),
 -- evidence for the phase
 -- the newest standing crew booking up to today, and whether one is still ahead (a
 -- booking stands unless cancelled, deleted, draft, disputed or declined; crew
 -- planning's confirmation is never read)
 bkn AS (
  SELECT (SELECT to_jsonb(b) FROM bk b, inp WHERE b.scheduled_date <= inp.today
            AND lower(coalesce(b.status, '')) NOT IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined')
          ORDER BY b.scheduled_date DESC, b.id COLLATE "C" DESC LIMIT 1) AS nb,
         EXISTS (SELECT 1 FROM bk b, inp WHERE b.scheduled_date > inp.today
                   AND lower(coalesce(b.status, '')) NOT IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined')) AS ahead
 ),
 -- Work is done only on a completion status (complete, completed, get_review,
 -- final_payment, invoiced: from when the job entered it), a completion record (a
 -- completion pack, a job marked completed, completed and invoiced) or a make-safe
 -- report or pack sent (story safety, 20261006040000). A booking marked complete with
 -- none ahead is attendance, never finished work on its own.
 ev AS (
  SELECT
   -- the newest standing booking attended with none ahead: completed, else started, else
   -- (a status-only completion) the end of the booked Perth day, or now while that is ahead
   (SELECT CASE WHEN NOT bkn.ahead AND bkn.nb IS NOT NULL
                 AND (lower(coalesce(bkn.nb->>'status', '')) IN ('complete', 'completed') OR bkn.nb->>'completed_at' IS NOT NULL)
            THEN (SELECT max(coalesce(b.completed_at, b.started_at,
                                      least(((b.scheduled_date + 1)::timestamp AT TIME ZONE 'Australia/Perth') - interval '1 second', now()))) FROM bk b
                  WHERE lower(coalesce(b.status, '')) IN ('complete', 'completed') OR b.completed_at IS NOT NULL) END FROM bkn) AS attended_at,
   (SELECT bkn.ahead FROM bkn) AS bk_ahead,
   -- a passed booking nobody marked started or complete
   (SELECT (bkn.nb->>'scheduled_date')::date FROM bkn, inp
    WHERE bkn.nb IS NOT NULL AND (bkn.nb->>'scheduled_date')::date < inp.today
      AND lower(coalesce(bkn.nb->>'status', '')) NOT IN ('complete', 'completed', 'in_progress')
      AND bkn.nb->>'completed_at' IS NULL AND bkn.nb->>'started_at' IS NULL) AS unattended_on,
   -- the newest standing booking before today with no attendance, when no later booking
   -- up to today was attended: the first line names it whatever the phase
   (SELECT b.scheduled_date FROM bk b, inp
    WHERE b.scheduled_date < inp.today AND b.completed_at IS NULL AND b.started_at IS NULL
      AND lower(coalesce(b.status, '')) NOT IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined', 'complete', 'completed', 'in_progress')
      AND NOT EXISTS (SELECT 1 FROM bk c WHERE c.scheduled_date > b.scheduled_date AND c.scheduled_date <= inp.today
                      AND (lower(coalesce(c.status, '')) IN ('complete', 'completed', 'in_progress') OR c.completed_at IS NOT NULL OR c.started_at IS NOT NULL))
    ORDER BY b.scheduled_date DESC, b.id COLLATE "C" DESC LIMIT 1) AS passed_unrecorded,
   -- the newest booked day up to today that was attended (started, in progress or complete)
   (SELECT max(b.scheduled_date) FROM bk b, inp WHERE b.scheduled_date <= inp.today
      AND lower(coalesce(b.status, '')) NOT IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined')
      AND (lower(coalesce(b.status, '')) IN ('complete', 'completed', 'in_progress') OR b.completed_at IS NOT NULL OR b.started_at IS NOT NULL)) AS attended_day,
   (SELECT min(coalesce(b.completed_at, b.started_at, b.scheduled_date::timestamp AT TIME ZONE 'Australia/Perth')) FROM bk b
    WHERE b.status IN ('complete', 'in_progress') OR b.completed_at IS NOT NULL OR b.started_at IS NOT NULL) AS started_at,
   (inp.rec->'facts'->>'report_sent_at')::timestamptz AS report_sent_at,
   -- completion: the earliest of a completion record, the report sent, and the time the
   -- job entered a completion status (its completed stamp, else its newest status change)
   least((inp.rec->'facts'->'completion'->>'at')::timestamptz, (inp.rec->'facts'->>'report_sent_at')::timestamptz,
         CASE WHEN inp.job->>'status' IN ('complete', 'completed', 'get_review', 'final_payment', 'invoiced')
              THEN coalesce((inp.rec->'facts'->>'status_completed_at')::timestamptz,
                            (SELECT max(t.at) FROM tl t WHERE t.kind IN ('status', 'rectification') AND t.time_basis = 'observed')) END) AS completed_at,
   (SELECT to_jsonb(b) FROM bk b WHERE b.scheduled_date >= inp.today
      AND lower(coalesce(b.status, '')) NOT IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined', 'complete', 'completed')
    ORDER BY b.scheduled_date, b.id COLLATE "C" LIMIT 1) AS next_bk,
   (SELECT min(q.accepted_at) FROM qd q) AS accepted_at,
   (SELECT min(q.sent_at) FROM qd q) AS first_sent,
   (SELECT max(q.sent_at) FROM qd q) AS last_sent,
   (SELECT min(t.at) FROM tl t WHERE t.kind = 'site_visit') AS scoped_at,
   (SELECT max(t.at) FROM tl t WHERE t.kind IN ('status', 'rectification') AND t.time_basis = 'observed') AS status_at,
   -- the newest quote the customer declined, with no quote sent after it
   (SELECT to_jsonb(q) FROM qd q WHERE q.declined_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM qd s WHERE s.sent_at > q.declined_at)
    ORDER BY q.declined_at DESC, q.id COLLATE "C" DESC LIMIT 1) AS declined,
   inp.job->>'status' AS status, inp.job->>'type' AS type, inp.today
  FROM inp
 ),
 ph0 AS (
  SELECT ev.*,
   CASE ev.status
    WHEN 'quoted' THEN 'quote' WHEN 'accepted' THEN 'accepted' WHEN 'partially_accepted' THEN 'accepted'
    WHEN 'awaiting_deposit' THEN 'deposit' WHEN 'deposit' THEN 'deposit' WHEN 'approvals' THEN 'approvals'
    WHEN 'order_materials' THEN 'materials' WHEN 'awaiting_supplier' THEN 'materials' WHEN 'schedule_install' THEN 'scheduled'
    WHEN 'scheduled' THEN 'scheduled' WHEN 'in_progress' THEN 'install' WHEN 'invoiced' THEN 'invoice'
    WHEN 'final_payment' THEN 'payment' WHEN 'get_review' THEN 'complete' WHEN 'complete' THEN 'complete'
    WHEN 'completed' THEN 'complete' WHEN 'rectification' THEN 'rectification' WHEN 'lead' THEN 'enquiry' WHEN 'new' THEN 'enquiry'
    WHEN 'processing' THEN CASE WHEN ev.type = 'makesafe' THEN 'makesafe' ELSE 'other' END
    ELSE 'other' END AS status_phase,
   -- (sixth review) a job in rectification now has its work open again, whatever records
   -- say it was finished before: the final invoice is not due (SWP-26354)
   CASE WHEN ev.bk_ahead OR ev.status = 'rectification' THEN NULL ELSE ev.completed_at END AS work_done_at,
   (mt.owing > 0) AS owing, (coalesce(mt.nyi, 0) > 1) AS uninvoiced,
   -- R8 fired but the job value is unconfirmed: what is left to invoice is not known
   (SELECT unconf.on_ AND unconf.r8 FROM unconf) AS uninv_unconf,
   -- (sixth review) the work was opened again (a status change into rectification, or a
   -- make-safe re-attend) after it was recorded finished, and nothing records it finished
   -- since: the final invoice waits for that work (facts.reopened)
   (SELECT r FROM inp, LATERAL (SELECT inp.rec -> 'facts' -> 'reopened' AS r) x
    WHERE r IS NOT NULL AND jsonb_typeof(r) = 'object' AND (r ->> 'completed_since') IS NULL
      AND (r ->> 'at')::timestamptz > CASE WHEN ev.bk_ahead OR ev.status = 'rectification' THEN NULL ELSE ev.completed_at END) AS reopened
  FROM ev, mt
 ),
 ph AS (
  SELECT p.*,
   CASE
    WHEN p.status_phase = 'rectification' THEN 'rectification'
    WHEN p.started_at IS NOT NULL AND p.next_bk IS NOT NULL THEN 'install'
    WHEN p.unattended_on IS NOT NULL AND p.work_done_at IS NULL THEN 'install'
    WHEN p.work_done_at IS NOT NULL AND p.owing THEN 'payment'
    WHEN p.work_done_at IS NOT NULL AND (p.uninvoiced OR p.uninv_unconf) THEN 'invoice'
    WHEN p.work_done_at IS NOT NULL THEN 'complete'
    WHEN p.status_phase IN ('install', 'complete', 'invoice', 'payment') THEN p.status_phase
    WHEN p.type = 'makesafe' THEN 'makesafe'
    -- attended, but nothing records the work finished: still under way
    WHEN p.started_at IS NOT NULL THEN 'install'
    WHEN p.next_bk IS NOT NULL THEN 'scheduled'
    ELSE (SELECT x.ph FROM (VALUES
           (CASE WHEN p.accepted_at IS NOT NULL THEN 'accepted' WHEN p.first_sent IS NOT NULL THEN 'quote'
                 WHEN p.scoped_at IS NOT NULL THEN 'scope' ELSE 'enquiry' END), (p.status_phase)) x(ph)
          ORDER BY array_position(ARRAY['other','enquiry','scope','quote','accepted','deposit','approvals','materials','scheduled'], x.ph) DESC NULLS LAST
          LIMIT 1)
   END AS phase
  FROM ph0 p
 ),
 phs AS (
  SELECT ph.*,
   CASE
    WHEN ph.phase = 'install' THEN coalesce(ph.started_at, ph.unattended_on::timestamp AT TIME ZONE 'Australia/Perth')
    WHEN ph.phase IN ('payment', 'invoice', 'complete') AND ph.work_done_at IS NOT NULL THEN ph.work_done_at
    WHEN ph.phase = 'scheduled' AND ph.next_bk IS NOT NULL
     THEN CASE WHEN ph.status_phase = 'scheduled' THEN coalesce(ph.status_at, (ph.next_bk->>'created_at')::timestamptz)
               ELSE (ph.next_bk->>'created_at')::timestamptz END
    WHEN ph.phase = 'accepted' THEN coalesce(ph.accepted_at, ph.status_at)
    WHEN ph.phase = 'quote' THEN coalesce(ph.last_sent, ph.status_at)
    WHEN ph.phase = 'scope' THEN ph.scoped_at
    WHEN ph.phase = ph.status_phase THEN ph.status_at
   END AS phase_since_at
  FROM ph
 ),
 -- R5 / C11 candidates, and whether a visible open ledger item says a reply is owed
 cand AS (
  SELECT r.*, (SELECT v.item_key FROM vis v
               WHERE v.status = 'open' AND (coalesce(v.needs_reply, false) OR v.item_type = 'request')
                 AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v.cited, v.opened_by)) c
                             WHERE (c->>'id' = r.source_id)
                                OR (coalesce((c->>'customer')::boolean, false) AND (c->>'at')::timestamptz >= r.opened_at))
               ORDER BY v.opened_at, v.item_key COLLATE "C" LIMIT 1) AS promoted_by
  FROM rl r WHERE r.shown_as = 'candidate'
 ),
 -- record loops shown as loops, merged per object (about_key), with promoted candidates. (Sixth
 -- review) A quote waiting (R7) is never a loop once the work is done: it is a check (checks)
 rec AS (
  SELECT r.rule, r.loop_key, r.owner, r.counterparty, r.what, r.why, r.opened_at, r.due_date, r.amount, r.about_key, r.closes_when,
         r.source_table, r.source_id, NULL::text AS promoted_by
  FROM rl r WHERE r.shown_as = 'loop'
    AND NOT (r.rule = 'R7_quote_waiting' AND (SELECT ph0.work_done_at IS NOT NULL FROM ph0))
  UNION ALL
  SELECT c.rule, c.loop_key, c.owner, c.counterparty, c.what, c.why, c.opened_at, c.due_date, c.amount, c.about_key, c.closes_when,
         c.source_table, c.source_id, c.promoted_by
  FROM cand c WHERE c.promoted_by IS NOT NULL
 ),
 recg AS (
  SELECT r.about_key,
         (array_agg(r.loop_key ORDER BY array_position(ARRAY['R1_overdue','M1_money_due','R2_part_paid','R3_draft','R8_not_yet_invoiced',
                    'R4_missed_call','R5_customer_wrote_last','C11_customer_mail_unanswered','R7_quote_waiting'], r.rule) NULLS LAST, r.loop_key COLLATE "C"))[1] AS key,
         (array_agg(r.rule ORDER BY array_position(ARRAY['R1_overdue','M1_money_due','R2_part_paid','R3_draft','R8_not_yet_invoiced',
                    'R4_missed_call','R5_customer_wrote_last','C11_customer_mail_unanswered','R7_quote_waiting'], r.rule) NULLS LAST, r.loop_key COLLATE "C"))[1] AS rule,
         string_agg(DISTINCT r.rule COLLATE "C", '+' ORDER BY r.rule COLLATE "C") AS rules,
         (array_agg(r.owner ORDER BY array_position(ARRAY['R1_overdue','M1_money_due','R2_part_paid','R3_draft','R8_not_yet_invoiced'], r.rule) NULLS LAST, r.loop_key COLLATE "C"))[1] AS owner,
         (array_agg(r.counterparty ORDER BY array_position(ARRAY['R1_overdue','M1_money_due','R2_part_paid','R3_draft','R8_not_yet_invoiced'], r.rule) NULLS LAST, r.loop_key COLLATE "C"))[1] AS counterparty,
         (array_agg(r.what ORDER BY array_position(ARRAY['R1_overdue','M1_money_due','R2_part_paid','R3_draft','R8_not_yet_invoiced'], r.rule) NULLS LAST, r.loop_key COLLATE "C"))[1] AS what,
         string_agg(r.why, '; ' ORDER BY r.rule COLLATE "C", r.loop_key COLLATE "C") AS why,
         min(r.opened_at) AS since, min(r.due_date) AS due, max(r.amount) AS amount,
         (array_agg(r.closes_when ORDER BY r.rule COLLATE "C", r.loop_key COLLATE "C"))[1] AS closes_when,
         jsonb_agg(DISTINCT jsonb_build_object('t', r.source_table, 'id', r.source_id)) AS cites,
         array_agg(r.promoted_by) FILTER (WHERE r.promoted_by IS NOT NULL) AS promoted_by
  FROM rec r GROUP BY r.about_key
 ),
 -- open ledger items that are loops
 lop AS (
  SELECT v.* FROM vis v
  WHERE v.status = 'open'
    AND (v.item_type IN ('commitment', 'request', 'claim', 'issue', 'constraint', 'dependency')
         OR (v.item_type = 'agreement' AND v.modality IN ('requested', 'offered')))
 ),
 -- which ledger items attach to a record loop (same object, or the item that promoted a candidate)
 att AS (
  SELECT l.item_key, g.about_key AS loop_about
  FROM lop l JOIN recg g ON g.about_key = l.about_key OR l.item_key = ANY (coalesce(g.promoted_by, '{}'::text[]))
 ),
 lrole AS (
  SELECT l.*,
   CASE
    WHEN l.item_type = 'commitment' THEN l.from_role
    WHEN l.item_type = 'request' THEN coalesce(l.to_role, 'us')
    WHEN l.item_type = 'dependency' THEN CASE WHEN coalesce(l.to_role, 'third_party') IN ('us', 'crew') THEN 'third_party' ELSE l.to_role END
    WHEN l.item_type = 'agreement' THEN CASE WHEN l.from_role IN ('us', 'crew') THEN coalesce(l.to_role, 'customer') ELSE 'us' END
    ELSE 'us' END AS owner_role,
   CASE
    WHEN l.item_type = 'commitment' THEN l.from_name
    WHEN l.item_type = 'request' THEN l.to_name
    WHEN l.item_type = 'dependency' THEN l.to_name
    WHEN l.item_type = 'agreement' THEN CASE WHEN l.from_role IN ('us', 'crew') THEN l.to_name ELSE NULL END
   END AS owner_name,
   CASE
    WHEN l.item_type = 'commitment' THEN l.to_role
    WHEN l.item_type IN ('request', 'claim', 'issue', 'constraint') THEN l.from_role
    WHEN l.item_type = 'agreement' THEN CASE WHEN l.from_role IN ('us', 'crew') THEN 'us' ELSE l.from_role END
    ELSE 'us' END AS counter_role,
   (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(l.opened_by) c) AS cites,
   (SELECT c->>'excerpt' FROM jsonb_array_elements(l.opened_by) c LIMIT 1) AS excerpt,
   (SELECT jsonb_agg(jsonb_build_object('t', x.t, 'id', x.id, 'what', x.what) ORDER BY x.at, x.t COLLATE "C", x.id COLLATE "C")
    FROM cc x
    WHERE l.closes_on IN ('quote_sent', 'invoice_issued', 'payment', 'booking_made', 'visit') AND x.closes_on = l.closes_on
      AND x.at > l.opened_at
      -- exact object only: a slug (quote:rear-fence) never matches some other quote by prefix
      AND x.about_key = l.about_key) AS closing
  FROM lop l
 ),
 norm AS (  -- role words to the loop owner vocabulary
  SELECT r.*,
   CASE WHEN r.owner_role IN ('us', 'crew') THEN 'us' WHEN r.owner_role IN ('customer', 'insurer_builder') THEN 'customer'
        WHEN r.owner_role IN ('supplier', 'third_party') THEN 'third_party' ELSE 'unknown' END AS owner,
   CASE WHEN r.counter_role IN ('us', 'crew') THEN 'us' WHEN r.counter_role IN ('customer', 'insurer_builder') THEN 'customer'
        WHEN r.counter_role IN ('supplier', 'third_party') THEN 'third_party' ELSE 'unknown' END AS counterparty
  FROM lrole r
 ),
 loops0 AS (
  -- record loops (with attached ledger items)
  SELECT g.key, 'record'::text AS source, g.rules AS rule, g.owner, NULL::text AS owner_name, g.counterparty,
         g.what,
         concat_ws('; ', g.why, (SELECT string_agg(n.what || coalesce(' ("' || left(n.excerpt, 160) || '")', ''), '; ' ORDER BY n.opened_at, n.item_key COLLATE "C")
                                 FROM norm n JOIN att a ON a.item_key = n.item_key AND a.loop_about = g.about_key),
                   -- the balance falls due when the work is finished: until then it is never the next move
                   -- (sixth review) and while the work is open again: in rectification now, or
                   -- reopened (a status change into rectification, a make-safe re-attend) after it
                   -- was recorded finished, with no record it is finished since
                   CASE WHEN g.rule = 'R8_not_yet_invoiced' AND (SELECT ph0.work_done_at IS NULL AND ph0.status = 'rectification' FROM ph0)
                        THEN 'the job is in rectification, so the final invoice is not the next move until the work is finished again'
                        WHEN g.rule = 'R8_not_yet_invoiced' AND (SELECT ph0.work_done_at IS NULL FROM ph0)
                        THEN 'the final invoice falls due when the work is finished, so it is not the next move yet'
                        WHEN g.rule = 'R8_not_yet_invoiced' AND (SELECT ph0.reopened IS NOT NULL FROM ph0)
                        THEN (SELECT 'the work was opened again after it was recorded finished (' || lower(ph0.reopened ->> 'what') || ' '
                                     || public.context_job_story_day(((ph0.reopened ->> 'at')::timestamptz AT TIME ZONE 'Australia/Perth')::date, ph0.today)
                                     || ') and nothing records it finished since, so the final invoice is not the next move yet' FROM ph0)
                        -- (fourth review) with the job value unconfirmed (check C2, no amount) what is
                        -- left to invoice is not known, so it is a check of the value, never a move
                        WHEN g.rule = 'R8_not_yet_invoiced' AND g.amount IS NULL
                        THEN 'the job value is unconfirmed (check C2), so what is left to invoice is a person''s check, never the next move' END) AS why,
         g.since, coalesce(g.due, (SELECT min(n.due_date) FROM norm n JOIN att a ON a.item_key = n.item_key AND a.loop_about = g.about_key)) AS due,
         -- the record rule still fires, so the loop is open: closing evidence is shown on
         -- ledger items only. A final invoice before the work is done is not due yet; after
         -- it, with the job value unconfirmed (no amount), it is unconfirmed (story safety,
         -- fourth review): neither is ever the move, the first line's item or a loop due now.
         CASE WHEN g.rule = 'R8_not_yet_invoiced' AND (SELECT ph0.work_done_at IS NULL OR ph0.reopened IS NOT NULL FROM ph0) THEN 'not_due'
              WHEN g.rule = 'R8_not_yet_invoiced' AND g.amount IS NULL THEN 'unconfirmed' ELSE 'open' END AS status,
         g.closes_when,
         (SELECT max(n.blocks) FROM norm n JOIN att a ON a.item_key = n.item_key AND a.loop_about = g.about_key WHERE n.blocks <> 'none') AS blocks,
         NULL::jsonb AS closing_evidence,
         (SELECT jsonb_agg(d.c ORDER BY d.c ->> 't' COLLATE "C" NULLS FIRST, d.c ->> 'id' COLLATE "C" NULLS FIRST)
          FROM (SELECT DISTINCT c FROM jsonb_array_elements(g.cites || coalesce((SELECT jsonb_agg(c2) FROM norm n
                JOIN att a ON a.item_key = n.item_key AND a.loop_about = g.about_key, jsonb_array_elements(n.cites) c2), '[]'::jsonb)) c) d) AS cites,
         g.about_key, g.amount,
         (g.rule IN ('R4_missed_call', 'R5_customer_wrote_last', 'C11_customer_mail_unanswered')) AS customer_waiting,
         (g.rule IN ('R1_overdue', 'M1_money_due', 'R2_part_paid', 'R3_draft', 'R8_not_yet_invoiced')) AS money,
         (g.rule = 'R8_not_yet_invoiced' AND (SELECT ph0.work_done_at IS NULL OR ph0.reopened IS NOT NULL FROM ph0)) AS not_due,
         -- held: not the move now (not due yet, or unconfirmed)
         (g.rule = 'R8_not_yet_invoiced' AND ((SELECT ph0.work_done_at IS NULL OR ph0.reopened IS NOT NULL FROM ph0) OR g.amount IS NULL)) AS held
  FROM recg g
  UNION ALL
  -- ledger loops not attached to a record loop
  SELECT n.item_key, CASE WHEN n.written_by LIKE 'person:%' THEN 'person' ELSE 'ledger' END, n.item_type, n.owner, n.owner_name,
         n.counterparty, n.what, coalesce('"' || left(n.excerpt, 200) || '"', NULL), n.opened_at, n.due_date,
         CASE WHEN n.closing IS NOT NULL THEN 'closing_evidence' ELSE 'open' END,
         CASE n.closes_on WHEN 'reply' THEN 'A reply that answers it' WHEN 'call' THEN 'A call that deals with it'
              WHEN 'quote_sent' THEN 'The quote is sent' WHEN 'invoice_issued' THEN 'The invoice is issued'
              WHEN 'payment' THEN 'The payment is received' WHEN 'booking_made' THEN 'A booking is made'
              WHEN 'visit' THEN 'The visit happens' WHEN 'work_done' THEN 'The work is done' WHEN 'record' THEN 'A record shows it done'
              WHEN 'person' THEN 'A person closes it' ELSE 'Words or a record that show it done' END,
         nullif(n.blocks, 'none'), n.closing, coalesce(n.cites, '[]'::jsonb), n.about_key, NULL::numeric,
         (n.owner = 'us' AND n.counterparty = 'customer' AND (coalesce(n.needs_reply, false) OR n.item_type = 'request')),
         (n.blocks IN ('payment', 'deposit') OR n.about_key LIKE 'invoice:%' OR n.about_key LIKE 'payment:%'),
         false, false
  FROM norm n WHERE NOT EXISTS (SELECT 1 FROM att a WHERE a.item_key = n.item_key)
 ),
 loops AS (
  SELECT l.*, (inp.today - (l.since AT TIME ZONE 'Australia/Perth')::date) AS age_days,
         row_number() OVER (ORDER BY
           CASE WHEN l.held THEN 4 WHEN l.owner = 'us' AND l.customer_waiting THEN 0 WHEN l.money THEN 1 WHEN l.owner = 'us' THEN 2 ELSE 3 END,
           l.since NULLS LAST, l.key COLLATE "C") AS rank
  FROM loops0 l, inp
 ),
 -- unpromoted R5 / C11 candidates, and whether the reading shown has read the row
 -- (the row is in its read set: admitted to its evidence and landed by its evidence_until);
 -- only a finished reading judges a row (a building or failed one shown on request never
 -- does: story safety, fourth review)
 wr AS (
  SELECT c.*, (led.live_read AND coalesce(led.read_ids ? c.source_id, false)) AS read_by_reader
  FROM cand c, led WHERE c.promoted_by IS NULL
 ),
 -- the customer wrote last and nobody has read it yet: the now line and whose move say so
 -- the newest unread candidate, and where its message sits (mail the old inbox placed
 -- on no job is said to be so)
 wl AS (SELECT w.opened_at AS at, w.placement, w.what, w.source_id FROM wr w WHERE NOT w.read_by_reader
        ORDER BY w.opened_at DESC, w.source_id COLLATE "C" DESC LIMIT 1),
 -- checks: record checks (and, sixth review, a quote waiting once the work is done), plus
 -- candidates nobody promoted
 checks AS (
  SELECT r.rule, r.what, jsonb_build_array(jsonb_build_object('t', r.source_table, 'id', r.source_id)) AS cites, r.opened_at
  FROM rl r WHERE r.shown_as = 'check'
     OR (r.shown_as = 'loop' AND r.rule = 'R7_quote_waiting' AND (SELECT ph0.work_done_at IS NOT NULL FROM ph0))
  UNION ALL
  SELECT c.rule,
         CASE WHEN c.read_by_reader
              THEN 'Customer wrote last; the reader judged no reply is needed. ' || c.what
              -- (owner's ruling, 6 Oct 2026: "not yet checked by the reader", never "not read yet")
              ELSE 'Customer wrote last; not yet checked by the reader. ' || c.what END,
         jsonb_build_array(jsonb_build_object('t', c.source_table, 'id', c.source_id)), c.opened_at
  FROM wr c
 ),
 -- (sixth review) the customer's newest message is off the job (placed on no job yet, or their
 -- mail withheld because they have another job) and newer than every customer message on it:
 -- no reading has checked it (a reading reads only the job's own rows), so even one that has
 -- read every row on the job gives no all-clear over it (fixture P, SWF-261305)
 ofj AS (
  SELECT x.at, x.note FROM inp, LATERAL (VALUES
    ((inp.meta->'unplaced'->>'newest_customer_at')::timestamptz, ' (not placed on any job)', 1),
    ((inp.meta->'withheld_mail'->>'newest_at')::timestamptz, ' (an email not placed on any job; it may be about another of their jobs)', 2)
  ) x(at, note, o)
  WHERE x.at IS NOT NULL AND x.at > coalesce((inp.rec->'contact'->'last_customer_message'->>'at')::timestamptz, '-infinity'::timestamptz)
  ORDER BY x.at DESC, x.o LIMIT 1
 ),
 -- whose move: ours when we owe something due now; unclear while the customer wrote last
 -- unread; and until a live reading has read every row on the job, nothing open on
 -- record is never nobody's move (story safety, 20261006040000), nor while the customer's
 -- newest message is off the job (sixth review)
 wm AS (
  SELECT CASE
          WHEN EXISTS (SELECT 1 FROM loops l WHERE l.owner = 'us' AND NOT l.held) THEN 'us'
          WHEN EXISTS (SELECT 1 FROM wl) THEN 'unknown'
          -- (fourth review) a quote the customer was in touch about since it was sent, in a way
          -- that does not close it (R7, owner unknown): it may be answered, so whose move is
          -- unclear, whatever else the customer or another party owes
          WHEN EXISTS (SELECT 1 FROM loops l WHERE l.rule = 'R7_quote_waiting' AND l.owner = 'unknown') THEN 'unknown'
          WHEN EXISTS (SELECT 1 FROM loops l WHERE l.owner = 'customer' AND NOT l.held) THEN 'customer'
          WHEN EXISTS (SELECT 1 FROM loops l WHERE l.owner = 'third_party' AND NOT l.held) THEN 'third_party'
          WHEN EXISTS (SELECT 1 FROM loops l WHERE NOT l.held) THEN 'unknown'
          WHEN NOT (SELECT led.words_read FROM led) THEN 'unknown'
          WHEN EXISTS (SELECT 1 FROM ofj) THEN 'unknown'
          ELSE 'nobody' END AS whose
 ),
 -- the top loop is the first one due now (a final invoice before the work is finished, or
 -- one whose amount is unconfirmed, never is) of the party whose move it is, so the line
 -- never pairs one party's move with another's item (the customer's move with a
 -- neighbour's invoice, our move with another payer's); with whose move unclear, the item
 -- it is unclear on (owner unknown) first, else the first one due now
 top AS (SELECT l.* FROM loops l, wm WHERE NOT l.held
         ORDER BY CASE WHEN wm.whose IN ('us', 'customer', 'third_party') AND l.owner IS DISTINCT FROM wm.whose THEN 1 ELSE 0 END,
                  CASE WHEN wm.whose = 'unknown' AND l.owner = 'unknown' THEN 0 ELSE 1 END, l.rank
         LIMIT 1),
 -- day words: Perth dates like "Wed 7 Oct" (year added when it is not the current year)
 nx AS (
  SELECT phs.next_bk AS b,
         CASE WHEN phs.next_bk IS NULL THEN NULL
              ELSE to_char((phs.next_bk->>'scheduled_date')::date, 'Dy FMDD Mon')
                   || CASE WHEN extract(year FROM (phs.next_bk->>'scheduled_date')::date) <> extract(year FROM phs.today)
                           THEN ' ' || extract(year FROM (phs.next_bk->>'scheduled_date')::date) ELSE '' END END AS day
  FROM phs
 ),
 -- the contact facts the line names while whose move is unclear: the newest customer
 -- message, our last reply, and an automated text sent since (each null when none). Story
 -- safety, fourth review: the newest of the job's own, this customer's messages placed on
 -- no job yet (meta unplaced) and their mail withheld because they have another job
 -- (meta withheld_mail), naming where it sits, so the line never says there is no customer
 -- message, or names a stale one, while a newer one waits off the job
 cw AS (
  SELECT 'newest customer message ' || public.context_job_story_day((c.at AT TIME ZONE 'Australia/Perth')::date, phs.today) || c.note AS cm,
         'our last reply ' || public.context_job_story_day((r.at AT TIME ZONE 'Australia/Perth')::date, phs.today) || r.note AS rp,
         ' (an automated text went '
          || public.context_job_story_day(((inp.rec->'contact'->'last_to_customer'->'newer_automated'->>'at')::timestamptz AT TIME ZONE 'Australia/Perth')::date, phs.today)
          || ')' AS auto
  FROM inp CROSS JOIN phs
  LEFT JOIN LATERAL (
   SELECT x.at, x.note FROM (VALUES
     ((inp.rec->'contact'->'last_customer_message'->>'at')::timestamptz,
      CASE WHEN inp.rec->'contact'->'last_customer_message'->>'placed_on' = 'none' THEN ' (an email not placed on any job)' ELSE '' END, 1),
     ((inp.meta->'unplaced'->>'newest_customer_at')::timestamptz, ' (not placed on any job)', 2),
     ((inp.meta->'withheld_mail'->>'newest_at')::timestamptz, ' (an email not placed on any job; it may be about another of their jobs)', 3)
   ) x(at, note, o) WHERE x.at IS NOT NULL ORDER BY x.at DESC, x.o LIMIT 1) c ON true
  LEFT JOIN LATERAL (
   SELECT x.at, x.note FROM (VALUES
     ((inp.rec->'contact'->'last_to_customer'->>'at')::timestamptz, '', 1),
     ((inp.meta->'unplaced'->>'newest_reply_at')::timestamptz, ' (not placed on any job)', 2)
   ) x(at, note, o) WHERE x.at IS NOT NULL ORDER BY x.at DESC, x.o LIMIT 1) r ON true
 ),
 nowp AS (
  SELECT phs.phase, phs.phase_since_at,
   -- phase words say where the job is, never whose move it is (the move words do);
   -- invoicing and payment words follow the money, not the status. A make-safe finished
   -- by its report pack says so, with the day the pack went.
   CASE WHEN phs.phase IN ('complete', 'invoice', 'payment') AND phs.work_done_at IS NOT NULL
             AND phs.work_done_at = phs.report_sent_at
        THEN 'Report pack sent to the builder ' || public.context_job_story_day((phs.report_sent_at AT TIME ZONE 'Australia/Perth')::date, phs.today)
             || CASE phs.phase WHEN 'payment' THEN CASE WHEN phs.owing THEN ', payment owing' ELSE ', final payment stage' END
                               WHEN 'invoice' THEN CASE WHEN phs.uninvoiced THEN ', not fully invoiced'
                                                        WHEN phs.uninv_unconf THEN ', what is left to invoice is unconfirmed' ELSE ', invoiced' END
                               ELSE ', work complete' END
        ELSE
   CASE phs.phase
    WHEN 'enquiry' THEN 'New enquiry' WHEN 'scope' THEN 'Scoping' WHEN 'quote' THEN 'Quoted'
    WHEN 'accepted' THEN 'Accepted' WHEN 'deposit' THEN 'Deposit stage' WHEN 'approvals' THEN 'In approvals'
    WHEN 'materials' THEN 'Materials being ordered' WHEN 'scheduled' THEN 'Scheduled' WHEN 'install' THEN 'Install under way'
    WHEN 'complete' THEN 'Work complete'
    WHEN 'invoice' THEN CASE WHEN phs.uninvoiced AND phs.work_done_at IS NOT NULL THEN 'Work done, not fully invoiced'
                             WHEN phs.uninv_unconf AND phs.work_done_at IS NOT NULL THEN 'Work done, what is left to invoice is unconfirmed'
                             WHEN phs.uninvoiced THEN 'Not fully invoiced' ELSE 'Invoiced' END
    WHEN 'payment' THEN CASE WHEN phs.owing AND phs.work_done_at IS NOT NULL THEN 'Work done, payment owing'
                             WHEN phs.owing THEN 'Payment owing' ELSE 'Final payment stage' END
    WHEN 'rectification' THEN 'In rectification'
    WHEN 'makesafe' THEN 'Make-safe in progress' ELSE 'In progress' END
   || coalesce(' since ' || public.context_job_story_day((phs.phase_since_at AT TIME ZONE 'Australia/Perth')::date, phs.today), '')
   END AS phase_words,
   CASE WHEN nx.b IS NOT NULL THEN 'next visit ' || coalesce(replace(nx.b->>'assignment_type', '_', ' ') || ' ', '') || 'booked ' || nx.day END AS next_words,
   -- a passed booking with no attendance recorded is named whatever the phase; a booking
   -- marked complete while nothing records the job finished says so; on builder work the
   -- attended day is named
   CASE WHEN phs.phase = 'install' AND phs.unattended_on IS NOT NULL
        THEN 'attendance not recorded for ' || public.context_job_story_day(phs.unattended_on, phs.today)
        WHEN phs.passed_unrecorded IS NOT NULL
        THEN 'attendance not recorded for ' || public.context_job_story_day(phs.passed_unrecorded, phs.today)
        WHEN phs.phase = 'install' AND phs.work_done_at IS NULL AND phs.attended_at IS NOT NULL AND phs.attended_day IS NOT NULL
        THEN 'the ' || public.context_job_story_day(phs.attended_day, phs.today) || ' booking is marked complete; nothing records the job finished'
        WHEN phs.type IN ('makesafe', 'repair', 'insurance') AND phs.work_done_at IS NOT NULL AND phs.attended_day IS NOT NULL
        THEN 'attended ' || public.context_job_story_day(phs.attended_day, phs.today)
   END AS att_words,
   (SELECT CASE WHEN t.owner = 'us' THEN 'we owe: '
                WHEN t.owner = 'customer' AND t.money THEN 'the customer owes: '
                -- a quote waiting reads as waiting on the customer, never as money owed; while
                -- the customer wrote last unread it may already be answered
                WHEN t.owner = 'customer' THEN CASE WHEN EXISTS (SELECT 1 FROM wl) THEN 'open: ' ELSE 'waiting on the customer: ' END
                WHEN t.owner = 'third_party' AND t.money THEN 'another payer owes: '
                WHEN t.owner = 'third_party' THEN 'waiting on another party: ' ELSE 'open: ' END
           -- (fourth review) cut at a word, never mid-word, and long enough to name a contact
           || CASE WHEN length(w.w) <= 200 THEN w.w
                   ELSE rtrim(left(w.w, 197 - position(' ' IN reverse(left(w.w, 197)))), ' ,;:') || '...' END
    FROM top t, LATERAL (SELECT regexp_replace(t.what, '\s+', ' ', 'g') AS w) w) AS top_words,
   -- what is owed, each invoice by number and due date; who owes it ("owed by", never "from",
   -- which reads as a bill from them), with their role, whenever a neighbour or another payer
   -- owes it (whatever the move, so their invoice never reads as the customer's), and each
   -- payer when more than one owes; one invoice the top loop already names is left to it
   CASE WHEN mt.owing > 0 THEN 'owing ' || to_char(mt.owing, 'FM$999,999,990.00')
            || CASE WHEN mt.overdue > 0 THEN ' (' || to_char(mt.overdue, 'FM$999,999,990.00') || ' overdue)' ELSE '' END
            || CASE WHEN (SELECT count(*) FROM oi) = 1
                         AND EXISTS (SELECT 1 FROM top t, oi WHERE t.cites @> jsonb_build_array(jsonb_build_object('t', 'xero_invoices', 'id', oi.id)))
                    THEN ''
                    ELSE coalesce(': ' || (SELECT string_agg(coalesce(oi.num, 'an invoice without a number') || ' ' || to_char(oi.owing, 'FM$999,999,990.00')
                                                  || CASE WHEN oi.third IS NOT NULL
                                                          THEN ' owed by ' || coalesce(oi.party, 'an unnamed contact')
                                                               || CASE oi.third WHEN 'neighbour' THEN ' (a neighbour paying part of this job)'
                                                                                WHEN 'strata' THEN ' (the strata, paying part of this job)'
                                                                                WHEN 'other_party' THEN ' (another party on this job)'
                                                                                ELSE ' (another payer, not this job''s customer)' END
                                                          WHEN mt.parties_owing > 1 THEN ' owed by ' || coalesce(oi.party, 'an unnamed contact') ELSE '' END
                                                  || CASE WHEN oi.overdue AND oi.due IS NOT NULL
                                                          THEN ' overdue since ' || public.context_job_story_day(oi.due, phs.today) || coalesce(' (' || oi.days || ' days)', '')
                                                          WHEN oi.due IS NOT NULL THEN ' due ' || public.context_job_story_day(oi.due, phs.today)
                                                          ELSE ', no due date in Xero' END, '; ' ORDER BY oi.o)
                                           FROM oi WHERE oi.o <= 3)
                                  || CASE WHEN (SELECT count(*) FROM oi) > 3 THEN '; and ' || ((SELECT count(*) FROM oi) - 3) || ' more' ELSE '' END, '') END
   END AS owing_words,
   -- (sixth review) what this job's own Xero contact owes on an invoice placed on no job (meta
   -- unplaced_invoices), each by number and due date, so a debt the job never received is
   -- never hidden behind its own invoices showing nothing owing (bda6e1de's INV-0290)
   (SELECT uw.words FROM uw) AS elsewhere_words,
   CASE WHEN mt.drafts > 0 THEN mt.drafts || CASE WHEN mt.drafts = 1 THEN ' draft invoice' ELSE ' draft invoices' END || ' not issued' END AS draft_words,
   -- what is left to invoice is named only once the work is done, and only when the job
   -- value is confirmed
   CASE WHEN phs.work_done_at IS NOT NULL AND coalesce(mt.nyi, 0) > 1 THEN to_char(mt.nyi, 'FM$999,999,990.00') || ' not yet invoiced'
        WHEN phs.work_done_at IS NOT NULL AND phs.uninv_unconf THEN 'what is left to invoice is unconfirmed (check C2)' END AS nyi_words,
   CASE wm.whose WHEN 'us' THEN 'Our move' WHEN 'customer' THEN 'The customer''s move'
        WHEN 'third_party' THEN 'Waiting on another party'
        -- no live reading of every row: never an all-clear. The line says first that whose
        -- move is unclear, then what the records show: no record item open (or due yet), the
        -- messages not yet checked for promises or requests (a live reading that lags: how
        -- many newer rows it has not checked, every kind and ours included, so said), the
        -- newest customer message and our last reply; with neither on record it says so and
        -- claims nothing unchecked
        WHEN 'unknown' THEN CASE WHEN NOT led.words_read AND NOT EXISTS (SELECT 1 FROM loops l WHERE NOT l.held) AND NOT EXISTS (SELECT 1 FROM wl)
                                 THEN 'Whose move is unclear: no record item is ' || CASE WHEN EXISTS (SELECT 1 FROM loops l WHERE l.not_due) THEN 'due yet' ELSE 'open' END
                                      || CASE WHEN led.live_read AND coalesce(led.unread, 0) > 0
                                              THEN ', and ' || led.unread
                                                   || CASE WHEN led.unread = 1 THEN ' newer message, call, note or document (ours included) is'
                                                           ELSE ' newer messages, calls, notes or documents (ours included) are' END
                                                   || ' not yet checked for promises or requests; '
                                              WHEN cw.cm IS NULL AND cw.rp IS NULL THEN '; '
                                              ELSE ', and the messages are not yet checked for promises or requests; ' END
                                      || CASE WHEN cw.cm IS NULL AND cw.rp IS NULL
                                              THEN 'no customer message and no reply from us on record' || coalesce(cw.auto, '')
                                              ELSE coalesce(cw.cm, 'no customer message on record') || ', '
                                                   || coalesce(cw.rp, 'no reply from us on record' || coalesce(cw.auto, '')) END
                                 -- (sixth review) a reading that read every row on the job found
                                 -- nothing open, but the customer's newest message is off the job
                                 -- and was never its to read: named, where it sits, unchecked
                                 WHEN led.words_read AND NOT EXISTS (SELECT 1 FROM loops l WHERE NOT l.held) AND NOT EXISTS (SELECT 1 FROM wl)
                                      AND EXISTS (SELECT 1 FROM ofj)
                                 THEN 'Whose move is unclear: no record item is ' || CASE WHEN EXISTS (SELECT 1 FROM loops l WHERE l.not_due) THEN 'due yet' ELSE 'open' END
                                      || ' and the reader found nothing open in the job''s own messages, but the customer''s newest message, '
                                      || (SELECT public.context_job_story_day((o.at AT TIME ZONE 'Australia/Perth')::date, phs.today) || o.note FROM ofj o)
                                      || ', is off the job and not yet checked by the reader'
                                 ELSE 'Whose move is unclear' END
        ELSE CASE WHEN nx.b IS NOT NULL THEN 'Nothing open until the visit' ELSE 'Nothing open on record' END END AS move_words,
   (SELECT 'the customer wrote last on ' || public.context_job_story_day((wl.at AT TIME ZONE 'Australia/Perth')::date, phs.today)
           || CASE WHEN wl.placement = 'not_placed' THEN ' (an email not placed on any job)' ELSE '' END
           -- (owner's ruling, 6 Oct 2026: "not yet checked by the reader", never "not read yet",
           -- which reads as staff not having read it)
           || '; not yet checked by the reader'
           -- the words themselves, so a pause, a decline or a new request shows in the first line
           || coalesce(': "' || CASE WHEN length(x.w) > 90 THEN left(x.w, 87) || '...' ELSE x.w END || '"', '')
    FROM wl, LATERAL (SELECT nullif(btrim(substring(wl.what FROM ': "(.*)"$')), '') AS w) x) AS wrote_words,
   -- the customer wrote after a future booking was made (check C6), unread: their words
   (SELECT 'the customer wrote ' || public.context_job_story_day((c.opened_at AT TIME ZONE 'Australia/Perth')::date, phs.today)
           || ' after the booking was made: "' || CASE WHEN length(x.w) > 90 THEN left(x.w, 87) || '...' ELSE x.w END || '"'
    FROM rl c, LATERAL (SELECT nullif(btrim(substring(c.what FROM ': "(.*)"$')), '') AS w) x
    WHERE c.rule = 'C6_booking_after_customer_word' AND x.w IS NOT NULL
      AND NOT (led.live_read AND coalesce(led.read_ids ? c.source_id, false))
      AND c.source_id IS DISTINCT FROM (SELECT wl.source_id FROM wl)
    ORDER BY c.opened_at DESC, c.source_id COLLATE "C" DESC LIMIT 1) AS c6_words,
   -- a quote the customer declined, with no quote sent since
   CASE WHEN phs.declined IS NOT NULL
        THEN 'the customer declined quote ' || coalesce(phs.declined->>'quote_number', 'without a number')
             || coalesce(' v' || (phs.declined->>'version'), '') || ' on '
             || public.context_job_story_day(((phs.declined->>'declined_at')::timestamptz AT TIME ZONE 'Australia/Perth')::date, phs.today) END AS decline_words
  FROM phs, nx, mt, wm, led, inp, cw
 ),
 nowl AS (
  SELECT n.*, (SELECT string_agg(upper(left(x.s, 1)) || substr(x.s, 2), '. ' ORDER BY x.o) FROM (VALUES
           (1, n.phase_words || coalesce(': ' || n.next_words, '') || coalesce('; ' || n.att_words, '')),
           (2, nullif(concat_ws(', ', n.owing_words, n.elsewhere_words, n.draft_words, n.nyi_words), '')),
           (3, n.move_words || coalesce(', ' || n.top_words, '')),
           (4, n.decline_words),
           (5, n.wrote_words),
           (6, n.c6_words)) x(o, s) WHERE x.s IS NOT NULL) AS line0
  FROM nowp n
 ),
 nowline AS (
  -- (no em or en dash ever reaches the line, whatever words it quotes)
  SELECT n.*, CASE WHEN length(n.l0) <= 399 THEN n.l0 || CASE WHEN n.l0 ~ '[.!?"]$' THEN '' ELSE '.' END
                   ELSE left(n.l0, 396 - position(' ' IN reverse(left(n.l0, 396)))) || '...' END AS line
  FROM (SELECT n.*, replace(replace(n.line0, chr(8212), ', '), chr(8211), '-') AS l0 FROM nowl n) n
 ),
 blockers AS (  -- in loop rank order, then the drafts by loop key
  SELECT l.what, l.cites, l.rank AS o, l.key AS k FROM loops l WHERE l.blocks IS NOT NULL
  UNION ALL
  SELECT r.what, jsonb_build_array(jsonb_build_object('t', r.source_table, 'id', r.source_id)), NULL::bigint, r.loop_key
  -- (sixth review) a draft that may duplicate issued invoices of its stage (R3 shown as a
  -- check) blocks nothing: it is never our move
  FROM rl r WHERE r.rule = 'R3_draft' AND r.shown_as IS DISTINCT FROM 'check'
 ),
 -- not known
 nk AS (
  SELECT x.what, x.why, x.ord FROM inp, led, LATERAL (VALUES
   (1, CASE WHEN coalesce((inp.meta->'lanes'->>'texts')::int, 0) = 0 THEN 'No texts are on record for this job.' END,
       'Texts reach a job only through its CRM contact or a job reference.'),
   (2, CASE WHEN coalesce((inp.meta->'lanes'->>'emails')::int, 0) = 0 THEN 'No emails are on record for this job.' END,
       'Emails reach a job by thread, sender or job reference.'),
   (3, CASE WHEN coalesce((inp.meta->'lanes'->>'calls')::int, 0) = 0 THEN 'No calls are on record for this job.' END,
       'Only calls logged by the phone system are captured.'),
   (4, CASE WHEN coalesce((inp.meta->'lanes'->>'documents')::int, 0) = 0 THEN 'No documents have been read into evidence for this job.' END,
       'Only documents whose text was extracted are evidence.'),
   (5, CASE WHEN (inp.meta->>'history_start')::timestamptz > (inp.job->>'created_at')::timestamptz + interval '2 days'
            THEN 'Message history on record starts ' || to_char(((inp.meta->>'history_start')::timestamptz AT TIME ZONE 'Australia/Perth')::date, 'Dy FMDD Mon YYYY')
                 || ', after the job began ' || to_char(((inp.job->>'created_at')::timestamptz AT TIME ZONE 'Australia/Perth')::date, 'Dy FMDD Mon YYYY') || '.' END,
       'Earlier messages were not captured.'),
   (6, CASE WHEN led.gen IS NOT NULL AND coalesce(led.unread, 0) > 0
            THEN led.unread || CASE WHEN led.unread = 1 THEN ' newer message on this job has' ELSE ' newer messages on this job have' END
                 || ' not been read by the reader yet.' END,
       'The reader reads new evidence on its own schedule.'),
   (7, CASE WHEN coalesce((inp.meta->'unplaced'->>'count')::int, 0) > 0
            THEN (inp.meta->'unplaced'->>'count') || CASE WHEN (inp.meta->'unplaced'->>'count')::int = 1 THEN ' message' ELSE ' messages' END
                 || ' from this customer are not placed on any job yet.' END,
       'They may belong to this job; they wait in the placement queue.'),
   (7, CASE WHEN coalesce((inp.meta->'withheld_mail'->>'count')::int, 0) > 0
            THEN (inp.meta->'withheld_mail'->>'count') || CASE WHEN (inp.meta->'withheld_mail'->>'count')::int = 1
                 THEN ' email from this customer is not placed on any job; it may belong to another of their jobs.'
                 ELSE ' emails from this customer are not placed on any job; they may belong to another of their jobs.' END END,
       'This customer has more than one job, so mail the old inbox placed on no job is kept off each of them.'),
   (7, CASE WHEN coalesce((inp.meta->'mail_copy_elsewhere'->>'count')::int, 0) > 0
            THEN (inp.meta->'mail_copy_elsewhere'->>'count') || CASE WHEN (inp.meta->'mail_copy_elsewhere'->>'count')::int = 1
                 THEN ' email on this job is shown from the old inbox: its saved copy is on another job or on no job yet.'
                 ELSE ' emails on this job are shown from the old inbox: their saved copies are on another job or on no job yet.' END END,
       'The saved copy decides where an email belongs once a person moves it; until then the old inbox row stands in for it.'),
   (7, CASE WHEN coalesce((inp.meta->'time_unknown_texts'->>'count')::int, 0) > 0
            THEN (inp.meta->'time_unknown_texts'->>'count') || CASE WHEN (inp.meta->'time_unknown_texts'->>'count')::int = 1
                 THEN ' text on this job was loaded from the CRM''s cache and the CRM''s own time for it is no longer kept; it is not read as this customer''s words.'
                 ELSE ' texts on this job were loaded from the CRM''s cache and the CRM''s own time for them is no longer kept; they are not read as this customer''s words.' END END,
       'The cache keeps only each contact''s newest messages; a text that dropped out before its time was kept has only its load time, which may be weeks late.'),
   (7, CASE WHEN coalesce((inp.meta->'before_job_texts'->>'count')::int, 0) > 0
            THEN (inp.meta->'before_job_texts'->>'count') || CASE WHEN (inp.meta->'before_job_texts'->>'count')::int = 1
                 THEN ' text on this job is dated by the CRM more than 30 days before the job was created; it is not read as this customer''s words.'
                 ELSE ' texts on this job are dated by the CRM more than 30 days before the job was created; they are not read as this customer''s words.' END END,
       'The CRM contact may have been another person''s, or an earlier enquiry''s, at the time.'),
   (8, CASE WHEN EXISTS (SELECT 1 FROM rl r WHERE r.rule = 'C4_booking_attendance_unrecorded')
            THEN 'Attendance is not recorded for a booking that has passed.' END,
       'The crew did not mark it started or complete.'),
   (9, CASE WHEN led.status = 'none' THEN 'No reader has read this job''s messages yet, so promises, requests and agreements in the words are not shown.'
            WHEN led.status IN ('shadow', 'building') AND led.gen IS NULL THEN 'The reader''s ledger for this job is not live yet, so the words are not shown.' END,
       'The ledger is written by the reader and shown once live.'),
   (10, CASE WHEN led.hidden - led.hidden_locked > 0 THEN (led.hidden - led.hidden_locked)
             || CASE WHEN led.hidden - led.hidden_locked = 1 THEN ' reader item was' ELSE ' reader items were' END
             || ' hidden because messages it cited moved off this job; the story needs a rebuild.' END,
        'A ledger item is shown only while every message it cites is still on this job.'),
   (14, CASE WHEN led.hidden_locked > 0 THEN led.hidden_locked
             || CASE WHEN led.hidden_locked = 1 THEN ' staff correction cites a message' ELSE ' staff corrections cite messages' END
             || ' that moved off this job; a person needs to check '
             || CASE WHEN led.hidden_locked = 1 THEN 'it.' ELSE 'them.' END END,
        'A rebuild keeps staff corrections as they are, so only a person can fix this.'),
   (11, CASE WHEN coalesce((inp.meta->>'contact_missing')::boolean, false) THEN 'This job has no CRM contact, so texts and calls may not reach it.' END,
        'Texts and calls are placed by the CRM contact.'),
   (12, CASE WHEN led.status = 'shadow' AND led.gen IS NOT NULL THEN 'This story shows a shadow reading that is not live yet.'
             WHEN led.gen IS NOT NULL AND led.gen->>'status' IN ('failed', 'retired', 'building')
             THEN 'This story shows a ' || (led.gen->>'status') || ' reading, not the live one.' END,
        'A shadow generation is checked before it is promoted; a failed, retired or unfinished one is never shown by default.'),
   (13, 'Phone calls that were not recorded are not here.', 'Only calls the phone system logged are captured.')
  ) x(ord, what, why)
  WHERE x.what IS NOT NULL
 ),
 -- who
 who AS (
  SELECT DISTINCT ON (lower(w.name), w.role) w.name, w.role, w.contact_ref, w.cites, w.ord FROM (
   -- on builder work (make-safe, repair, insurance) the builder is the customer and the
   -- homeowner the insured (story safety, 20261006040000)
   SELECT inp.job->>'client_name' AS name, CASE WHEN inp.job->>'type' IN ('makesafe', 'repair', 'insurance') THEN 'insured' ELSE 'customer' END AS role,
          inp.job->>'ghl_contact_id' AS contact_ref, jsonb_build_array(jsonb_build_object('t', 'jobs', 'id', inp.job->>'id')) AS cites, 1 AS ord
   FROM inp WHERE nullif(btrim(inp.job->>'client_name'), '') IS NOT NULL
   UNION ALL
   SELECT m.party, CASE WHEN inp.job->>'type' IN ('makesafe', 'repair', 'insurance') THEN 'customer' ELSE 'payer' END, m.xero_contact_id,
          (SELECT jsonb_agg(jsonb_build_object('t', 'xero_invoices', 'id', i->>'id')) FROM jsonb_array_elements(m.invoices) i), 2
   FROM mo m, inp WHERE m.party IS NOT NULL  -- a payer has an issued invoice; drafts alone make nobody a payer
     AND (coalesce(m.invoiced, 0) > 0 OR coalesce(m.paid, 0) > 0 OR coalesce(m.credited, 0) > 0)
   UNION ALL
   -- the builder named on the make-safe details, before any invoice names them
   SELECT inp.rec->'facts'->>'builder', 'customer', NULL, jsonb_build_array(jsonb_build_object('t', 'jobs', 'id', inp.job->>'id')), 2
   FROM inp WHERE inp.job->>'type' IN ('makesafe', 'repair', 'insurance') AND nullif(btrim(inp.rec->'facts'->>'builder'), '') IS NOT NULL
   UNION ALL
   SELECT p->>'name', coalesce(p->>'role', 'party'), p->>'contact_ref', jsonb_build_array(jsonb_build_object('t', 'job_contacts', 'id', p->>'id')), 3
   FROM inp, jsonb_array_elements(coalesce(inp.rec->'facts'->'parties', '[]'::jsonb)) p WHERE nullif(btrim(p->>'name'), '') IS NOT NULL
   UNION ALL
   SELECT n.nm, n.rl, NULL, (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(n.ob) c), 4
   FROM (SELECT v.from_name AS nm, v.from_role AS rl, v.opened_by AS ob FROM vis v WHERE v.status NOT IN ('disputed', 'superseded', 'declined')
         UNION ALL SELECT v.to_name, v.to_role, v.opened_by FROM vis v WHERE v.status NOT IN ('disputed', 'superseded', 'declined')) n
   WHERE nullif(btrim(n.nm), '') IS NOT NULL
  ) w ORDER BY lower(w.name), w.role, w.ord, w.name COLLATE "C", w.contact_ref COLLATE "C", w.cites::text COLLATE "C"
 ),
 cm AS (
  SELECT
   (SELECT count(*) FROM vis v WHERE v.item_type = 'commitment' AND v.status = 'closed' AND (v.due_date IS NULL OR (v.closed_at AT TIME ZONE 'Australia/Perth')::date <= v.due_date)) AS kept,
   (SELECT count(*) FROM vis v WHERE v.item_type = 'commitment' AND v.status = 'closed' AND v.due_date IS NOT NULL AND (v.closed_at AT TIME ZONE 'Australia/Perth')::date > v.due_date) AS late,
   (SELECT count(*) FROM vis v, inp WHERE v.item_type = 'commitment' AND v.status = 'open' AND (v.due_date IS NULL OR v.due_date >= inp.today)) AS open_,
   (SELECT count(*) FROM vis v, inp WHERE v.item_type = 'commitment' AND v.status = 'open' AND v.due_date < inp.today) AS overdue
 ),
 tlout AS (
  SELECT t.*,
   CASE t.kind WHEN 'quote' THEN 'quote' WHEN 'invoice' THEN 'invoice' WHEN 'payment' THEN 'payment' WHEN 'credit' THEN 'payment'
        WHEN 'booking' THEN 'scheduled' WHEN 'attendance' THEN 'install' WHEN 'site_visit' THEN 'scope' WHEN 'first_contact' THEN 'enquiry'
        WHEN 'job_created' THEN 'enquiry' WHEN 'rectification' THEN 'rectification' WHEN 'makesafe' THEN 'makesafe' END AS phase
  FROM tl t WHERE t.kind <> 'booking_mirror'
 )
 SELECT jsonb_build_object(
  'version', 'job-story-v1',
  'job', (SELECT jsonb_build_object('id', inp.job->'id', 'job_number', inp.job->'job_number', 'type', inp.job->'type',
                 'status', inp.job->'status', 'client_name', inp.job->'client_name', 'site_suburb', inp.job->'site_suburb',
                 'created_at', inp.job->'created_at') FROM inp),
  'as_of', (SELECT inp.as_of FROM inp),
  'now', (SELECT jsonb_build_object(
            'line', n.line, 'phase', n.phase,
            'phase_since', (n.phase_since_at AT TIME ZONE 'Australia/Perth')::date,
            'whose_move', (SELECT wm.whose FROM wm),
            'next', CASE WHEN (SELECT nx.b FROM nx) IS NOT NULL
                         THEN (SELECT jsonb_build_object('what', 'Visit booked: ' || replace(coalesce(nx.b->>'assignment_type', 'visit'), '_', ' ')
                                                         || coalesce(' (' || nullif(btrim(nx.b->>'crew_name'), '') || ')', ''),
                                                         'when', nx.b->'scheduled_date', 'day', nx.day,
                                                         'cites', jsonb_build_array(jsonb_build_object('t', 'job_assignments', 'id', nx.b->>'id'))) FROM nx)
                         WHEN EXISTS (SELECT 1 FROM top)
                         THEN (SELECT jsonb_build_object('what', t.what, 'when', t.due, 'cites', t.cites) FROM top t) END,
            'blockers', coalesce((SELECT jsonb_agg(jsonb_build_object('what', b.what, 'cites', b.cites) ORDER BY b.o NULLS LAST, b.k COLLATE "C")
                                  FROM blockers b), '[]'::jsonb),
            'cites', coalesce((SELECT jsonb_agg(d.c ORDER BY d.c ->> 't' COLLATE "C" NULLS FIRST, d.c ->> 'id' COLLATE "C" NULLS FIRST)
                       FROM (SELECT DISTINCT z.c FROM (
                       SELECT c FROM top t, jsonb_array_elements(t.cites) c
                       UNION ALL SELECT jsonb_build_object('t', 'job_assignments', 'id', nx.b->>'id') FROM nx WHERE nx.b IS NOT NULL
                       UNION ALL SELECT jsonb_build_object('t', 'jobs', 'id', inp.job->>'id') FROM inp) z) d), '[]'::jsonb))
          FROM nowline n),
  'money', (SELECT jsonb_build_object(
             'line', CASE WHEN mt.invoiced = 0 AND mt.drafts = 0 THEN 'No invoices issued'
                          ELSE 'Invoiced ' || to_char(mt.invoiced, 'FM$999,999,990.00') || ', paid ' || to_char(mt.paid, 'FM$999,999,990.00')
                               || CASE WHEN mt.credited > 0 THEN ', credited ' || to_char(mt.credited, 'FM$999,999,990.00') ELSE '' END
                               || ', owing ' || to_char(mt.owing, 'FM$999,999,990.00') END
                     || CASE WHEN mt.overdue > 0 THEN ' (' || to_char(mt.overdue, 'FM$999,999,990.00') || ' overdue since '
                                                     || to_char(mt.oldest_overdue, 'Dy FMDD Mon') || ')' ELSE '' END
                     || CASE WHEN mt.drafts > 0 THEN '; ' || mt.drafts || ' draft ' || CASE WHEN mt.drafts = 1 THEN 'invoice' ELSE 'invoices' END
                                                     || ' of ' || to_char(mt.draft_total, 'FM$999,999,990.00') || ' not issued' ELSE '' END
                     || CASE WHEN coalesce(mt.nyi, 0) > 1 THEN '; ' || to_char(mt.nyi, 'FM$999,999,990.00') || ' of the job value not yet invoiced'
                             WHEN unconf.on_ AND unconf.r8 THEN '; the job value is unconfirmed (check C2), so what is left to invoice is not known'
                             ELSE '' END
                     || CASE WHEN mt.parties > 1 THEN '; ' || mt.parties || ' paying parties' ELSE '' END
                     -- (sixth review) never "owing $0.00" alone over a debt of this job's Xero
                     -- contact that sits on an invoice placed on no job
                     || coalesce('; ' || (SELECT uw.words FROM uw), '') || '.',
             'job_value', jsonb_build_object('amount', mt.job_value, 'basis', mt.job_value_basis),
             -- (sixth review) the invoices placed on no job addressed to this job's own Xero
             -- contact, still owing; never in owing above (they are not on this job)
             'placed_on_no_job', coalesce((SELECT jsonb_agg(jsonb_build_object('number', u.num, 'owing', u.owing, 'due_date', u.due,
                                   'days_overdue', u.days, 'cites', jsonb_build_array(jsonb_build_object('t', 'xero_invoices', 'id', u.id)))
                                   ORDER BY u.o) FROM uinv u), '[]'::jsonb),
             'parties', coalesce((SELECT jsonb_agg(jsonb_build_object('party', m.party, 'xero_contact_id', m.xero_contact_id,
                          'invoiced', m.invoiced, 'paid', m.paid, 'credited', m.credited, 'owing', m.owing, 'overdue', m.overdue,
                          'oldest_overdue_due', m.oldest_overdue_due, 'drafts', m.drafts, 'draft_total', m.draft_total,
                          'invoices', m.invoices) ORDER BY m.owing DESC, m.party COLLATE "C", m.xero_contact_id COLLATE "C")
                          FROM mo m WHERE m.party IS NOT NULL), '[]'::jsonb),
             'not_yet_invoiced', CASE WHEN coalesce(mt.nyi, 0) > 1
                                      THEN jsonb_build_object('amount', mt.nyi, 'basis', 'job value (' || coalesce(mt.job_value_basis, 'unknown')
                                                              || ') minus issued customer invoices',
                                                              'cites', jsonb_build_array(jsonb_build_object('t', 'jobs', 'id', inp.job->>'id')))
                                      WHEN unconf.on_ AND unconf.r8
                                      THEN jsonb_build_object('amount', NULL, 'unconfirmed', true,
                                                              'basis', 'unconfirmed: another record disagrees with the job value (check C2)',
                                                              'cites', jsonb_build_array(jsonb_build_object('t', 'jobs', 'id', inp.job->>'id'))) END,
             'supplier_bills', coalesce(mt.bills, '[]'::jsonb))
           FROM mt, inp, unconf),
  'loops', coalesce((SELECT jsonb_agg(jsonb_build_object('key', l.key, 'source', l.source, 'rule', l.rule, 'about_key', l.about_key,
             'owner', l.owner, 'owner_name', l.owner_name, 'counterparty', l.counterparty, 'what', l.what, 'why', l.why, 'since', l.since,
             'due', l.due, 'age_days', l.age_days, 'status', l.status, 'closes_when', l.closes_when, 'blocks', l.blocks,
             'closing_evidence', l.closing_evidence, 'cites', l.cites, 'rank', l.rank) ORDER BY l.rank) FROM loops l), '[]'::jsonb),
  'checks', coalesce((SELECT jsonb_agg(jsonb_build_object('rule', c.rule, 'what', c.what, 'cites', c.cites)
                              ORDER BY c.opened_at, c.rule COLLATE "C", c.cites::text COLLATE "C", c.what COLLATE "C")
                      FROM checks c), '[]'::jsonb),
  -- each line names its record and that record's state (and a booking when it was made),
  -- so nothing downstream reads them from the words
  'timeline', coalesce((SELECT jsonb_agg(jsonb_build_object('at', t.at, 'date', t.perth_date, 'kind', t.kind, 'what', t.what,
                         'amount', t.amount, 'phase', t.phase, 'source_table', t.source_table, 'source_id', t.source_id,
                         'state', t.state, 'made_at', t.made_at,
                         'cites', jsonb_build_array(jsonb_build_object('t', t.source_table, 'id', t.source_id)))
                         ORDER BY t.at, t.kind COLLATE "C", t.source_id COLLATE "C", t.what COLLATE "C") FROM tlout t), '[]'::jsonb),
  'phase_notes', coalesce((SELECT jsonb_agg(jsonb_build_object('phase', v.phase, 'what', v.what,
                   'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(v.opened_by) c))
                   ORDER BY v.opened_at, v.item_key COLLATE "C") FROM vis v WHERE v.item_type = 'phase_note'
                   AND v.status NOT IN ('disputed', 'superseded', 'declined')), '[]'::jsonb),
  'agreements', coalesce((SELECT jsonb_agg(jsonb_build_object('key', v.item_key, 'what', v.what, 'modality', v.modality, 'since', v.opened_at,
                  'status', v.status, 'supersedes', v.supersedes_key,
                  'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(v.opened_by) c))
                  ORDER BY v.opened_at, v.item_key COLLATE "C") FROM vis v WHERE v.item_type = 'agreement'), '[]'::jsonb),
  'events', coalesce((SELECT jsonb_agg(jsonb_build_object('key', v.item_key, 'what', v.what, 'at', v.opened_at,
              'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(v.opened_by) c))
              ORDER BY v.opened_at, v.item_key COLLATE "C") FROM vis v WHERE v.item_type = 'event'
              AND v.status NOT IN ('disputed', 'superseded', 'declined')), '[]'::jsonb),
  'who', coalesce((SELECT jsonb_agg(jsonb_build_object('name', w.name, 'role', w.role, 'contact_ref', w.contact_ref, 'cites', w.cites)
                   ORDER BY w.ord, w.name COLLATE "C", w.role COLLATE "C") FROM who w), '[]'::jsonb),
  'last_exchange', (SELECT jsonb_build_object('customer_said', inp.rec->'contact'->'last_customer_message',
                     'we_told_customer', inp.rec->'contact'->'last_to_customer', 'internal', inp.rec->'contact'->'last_internal') FROM inp),
  'handling', (SELECT jsonb_build_object('customer_messages', coalesce((inp.rec->'contact'->>'customer_messages')::int, 0),
                'replies', coalesce((inp.rec->'contact'->>'replies')::int, 0),
                'median_reply_hours', (inp.rec->'contact'->>'median_reply_hours')::numeric,
                'unanswered', coalesce((inp.rec->'contact'->>'unanswered')::int, 0),
                -- left empty (null) until a live reading has read the words: none could be counted
                'commitments', CASE WHEN led.live_read
                                    THEN jsonb_build_object('kept', cm.kept, 'late', cm.late, 'open', cm.open_, 'overdue', cm.overdue) END)
               FROM inp, cm, led),
  'not_known', coalesce((SELECT jsonb_agg(jsonb_build_object('what', k.what, 'why', k.why) ORDER BY k.ord, k.what COLLATE "C") FROM nk k), '[]'::jsonb),
  'changes', (SELECT CASE WHEN inp.since IS NULL THEN NULL ELSE coalesce((SELECT jsonb_agg(x.o ORDER BY x.at, x.o::text COLLATE "C") FROM (
               SELECT t.at, jsonb_build_object('at', t.at, 'kind', t.kind, 'what', t.what,
                      'cites', jsonb_build_array(jsonb_build_object('t', t.source_table, 'id', t.source_id))) AS o
               FROM tlout t WHERE t.at > inp.since AND t.at <= inp.as_of
               UNION ALL
               SELECT l.since, jsonb_build_object('at', l.since, 'kind', 'loop_opened', 'what', l.what, 'cites', l.cites)
               FROM loops l WHERE l.since > inp.since
               UNION ALL
               SELECT (x->>'at')::timestamptz, jsonb_build_object('at', x->'at', 'kind', 'ledger_' || coalesce(x->>'to_status', 'change'),
                      'what', coalesce(x->>'reason', 'Ledger item ' || coalesce(x->>'item_key', '') || ' moved to ' || coalesce(x->>'to_status', '?')),
                      'cites', coalesce(x->'evidence', '[]'::jsonb))
               FROM jsonb_array_elements(coalesce(inp.led->'transitions', '[]'::jsonb)) x WHERE (x->>'at')::timestamptz > inp.since
              ) x), '[]'::jsonb) END FROM inp),
  'meta', (SELECT jsonb_build_object(
             'ledger', jsonb_build_object('status', led.status, 'generation_id', led.gen->'id', 'evidence_until', led.gen->'evidence_until',
                         'reader', led.gen->'reader', 'items', led.items, 'hidden_items', led.hidden, 'unread_rows', led.unread,
                         'needs_rebuild', led.hidden - led.hidden_locked > 0,
                         'stale', led.hidden - led.hidden_locked > 0 OR coalesce(led.unread, 0) > 0),
             'sources', coalesce(inp.meta->'sources', '{}'::jsonb), 'evidence_rows', coalesce((inp.meta->>'evidence_rows')::int, 0),
             'built_at', now())
           FROM inp, led)
 )
$fn$;
COMMENT ON FUNCTION public.context_job_story_assemble(jsonb, jsonb, jsonb, jsonb, timestamptz, timestamptz) IS
 'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000): (sixth review) a job in rectification now has no work done (the final invoice is not due, said so), and the final invoice is not due either while work recorded finished was opened again since (facts.reopened: a status change into rectification or a make-safe re-attend, nothing recording it finished since); a quote waiting (R7) is a check once the work is done; a reading that has read every row on the job gives no all-clear while the customer''s newest message is off the job (meta unplaced newest_customer_at or withheld_mail newest_at newer than every customer message on the job): whose move is unknown and the line names that message, where it sits, and that the reader has not checked it; the first line and the money line name what this job''s own Xero contact owes on invoices placed on no job (meta unplaced_invoices; money.placed_on_no_job), never counting them in owing; not_known names texts whose CRM time is no longer kept. Earlier: until a finished reading shown (live or retired, or a shadow the story shows only when asked for it by id, so a grade reads the line a promotion gives; never a building or failed one) has read every row on the job (none unread), nothing open on record is never nobody''s move: whose_move unknown, the first line says "Whose move is unclear:" first, then that no record item is open (or due yet) and the messages are not yet checked for promises or requests (a reading that lags: how many newer messages, calls, notes or documents, ours included, it has not checked), with the newest customer message and our last reply, of the job''s own, this customer''s messages placed on no job yet and their withheld mail, naming where the newest sits (with neither anywhere it says so and claims nothing unchecked); with no finished reading handling.commitments is null, and only a finished reading judges a customer message; work is done only on a completion status, a completion record (facts.completion) or a report pack sent, never because the newest booking is complete; a final invoice (R8) before the work is done is not due (loop status not_due), and after it with the job value unconfirmed (C2, no amount) it is unconfirmed (status unconfirmed): either ranks last and is never the move or the first line''s item; a value another record disagrees with (C2) states no amount left to invoice; a quote the customer was in touch about since it was sent, in a way that does not close it (R7 owner unknown), makes whose move unclear and is the item the first line names; the first line''s item is cut at a word (200 characters); the customer''s unread words are "not yet checked by the reader"; the first line names each invoice owing with its due date, who owes it ("owed by") with their role whenever a neighbour or another payer owes it (whatever the move: its payer role, else its R1, R2 or M1 loop''s owner), and each payer when more than one owes, a passed booking with no attendance, a quote declined and the newest unread customer words (R5, C11, C6); the first line names the top loop of the party whose move it is, never another party''s (the customer''s move never names a neighbour''s invoice); a quote waiting reads as waiting on the customer; another party''s invoice reads as another payer owing; on builder work the builder is the customer and the homeowner the insured; not_known names mail shown from the old inbox and texts dated before the job. Earlier, story fixes: every text sort and tiebreak that reaches the output is in C (byte) order (who, money parties, loops and their rank, cites, checks, timeline, phase notes, agreements, events, not known, changes, blockers), so the story reads the same on every server whatever the input order. Earlier: the pure assembler of job-story-v1. Reads no table: job header, record parts (timeline, loops, money, contact, facts), ledger (generation, items with citation re-check result, transitions, its reader''s unread rows) and meta in; the cited story out. meta.ledger = {status, generation_id, evidence_until, reader, items, hidden_items, unread_rows, needs_rebuild, stale}. Inlinable (no SET). Service role only.';

CREATE OR REPLACE FUNCTION public.context_client_story(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH me AS (
  SELECT jb.id, nullif(btrim(jb.ghl_contact_id), '') AS contact, lower(nullif(btrim(jb.client_email), '')) AS email
  FROM public.jobs jb WHERE jb.id = p_job_id
 ),
 ident AS (
  SELECT me.*, CASE WHEN me.contact IS NOT NULL THEN 'ghl_contact_id' WHEN me.email IS NOT NULL THEN 'client_email' END AS basis FROM me
 ),
 cj AS (  -- the client's jobs, newest first; the first 20 get a full story
  SELECT jb.id, jb.job_number, jb.type, jb.status::text AS status, jb.created_at,
         jb.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost') AS live,
         row_number() OVER (ORDER BY jb.created_at DESC, jb.id) AS n
  FROM ident i JOIN public.jobs jb
    ON (i.basis = 'ghl_contact_id' AND nullif(btrim(jb.ghl_contact_id), '') = i.contact)
    OR (i.basis = 'client_email' AND lower(nullif(btrim(jb.client_email), '')) = i.email)
  WHERE jb.created_at <= p_as_of
 ),
 st AS (SELECT cj.id, public.context_job_story(cj.id, p_as_of) AS s FROM cj WHERE cj.n <= 20),
 mon AS (SELECT m.* FROM public.context_job_record_money((SELECT array_agg(cj.id) FROM cj), p_as_of) m),
 -- story safety (20261006040000), fourth review: each invoice owing on the client's jobs, and
 -- whether the client owes it: only an invoice addressed to them (payer role customer),
 -- never the builder's on builder work, a neighbour's or another payer's, which others owe
 mi AS (
  SELECT m.job_id, coalesce(i ->> 'payer_role' = 'customer', false) AS own, (i ->> 'owing')::numeric AS owing,
         CASE WHEN coalesce((i ->> 'overdue')::boolean, false) THEN (i ->> 'owing')::numeric ELSE 0 END AS overdue
  FROM mon m CROSS JOIN LATERAL jsonb_array_elements(coalesce(m.invoices, '[]'::jsonb)) i
  WHERE m.party IS NOT NULL AND jsonb_typeof(i -> 'owing') = 'number'
 ),
 -- story safety (20261006040000): the client's own Xero contacts (on their private jobs:
 -- the job's own contact, the primary party's, or a job's only paying contact when it has
 -- neither; never a neighbour's, never on builder work, where the contact is the builder).
 -- A job's only paying contact is the client's own only when every invoice to it on that job
 -- names it as the client (name compared case and spacing aside) and it is billed on no
 -- builder work (make-safe, repair or insurance): a builder or insurer billed for a
 -- homeowner's private job is never the homeowner, so the builder's other jobs never become
 -- the homeowner's debt
 cxc AS (
  SELECT DISTINCT z.x FROM (
   SELECT nullif(btrim(jb.xero_contact_id), '') AS x FROM cj JOIN public.jobs jb ON jb.id = cj.id
   WHERE jb.type::text NOT IN ('makesafe', 'repair', 'insurance')
   UNION ALL
   SELECT nullif(btrim(c.xero_contact_id), '') FROM cj JOIN public.jobs jb ON jb.id = cj.id JOIN public.job_contacts c ON c.job_id = cj.id
   WHERE jb.type::text NOT IN ('makesafe', 'repair', 'insurance') AND c.removed_at IS NULL
     AND (coalesce(c.is_primary, false) OR coalesce(c.contact_type, '') = 'primary')
   UNION ALL
   SELECT o.x FROM (
    SELECT min(nullif(btrim(i.xero_contact_id), '')) AS x, count(DISTINCT nullif(btrim(i.xero_contact_id), '')) AS n,
           bool_and(nullif(btrim(jb.client_name), '') IS NOT NULL
                    AND lower(btrim(regexp_replace(coalesce(i.contact_name, ''), '\s+', ' ', 'g')))
                        = lower(btrim(regexp_replace(jb.client_name, '\s+', ' ', 'g')))) AS named_client
    FROM cj JOIN public.jobs jb ON jb.id = cj.id
    JOIN public.xero_invoices i ON i.job_id = cj.id AND upper(coalesce(i.invoice_type, 'ACCREC')) = 'ACCREC'
     AND upper(coalesce(i.status, '')) IN ('AUTHORISED', 'SUBMITTED', 'PAID') AND coalesce(i.created_at, i.synced_at, '-infinity'::timestamptz) <= p_as_of
    WHERE jb.type::text NOT IN ('makesafe', 'repair', 'insurance') AND nullif(btrim(jb.xero_contact_id), '') IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.job_contacts c WHERE c.job_id = cj.id AND c.removed_at IS NULL)
    GROUP BY cj.id) o
   WHERE o.n = 1 AND coalesce(o.named_client, false)
     AND NOT EXISTS (SELECT 1 FROM public.xero_invoices b JOIN public.jobs bj ON bj.id = b.job_id
                     WHERE btrim(b.xero_contact_id) = o.x AND bj.type::text IN ('makesafe', 'repair', 'insurance'))
  ) z WHERE z.x IS NOT NULL
 ),
 -- what that Xero contact still owes on other clients' jobs (a payer on someone else's job,
 -- as a neighbour): the client's money includes it, each job named. Only invoices still
 -- owing (a paid one is no debt, so it names no job), and never on builder work, where every
 -- invoice is the builder's
 xo AS (
  SELECT i.job_id, jb.job_number, nullif(btrim(i.xero_contact_id), '') AS xero_contact_id, i.contact_name AS party,
         sum(coalesce(i.amount_due, 0)) AS owing,
         sum(CASE WHEN i.due_date < (p_as_of AT TIME ZONE 'Australia/Perth')::date THEN coalesce(i.amount_due, 0) ELSE 0 END) AS overdue,
         jsonb_agg(jsonb_build_object('t', 'xero_invoices', 'id', i.id) ORDER BY i.invoice_date NULLS LAST, i.id) AS cites
  FROM public.xero_invoices i JOIN public.jobs jb ON jb.id = i.job_id
  WHERE nullif(btrim(i.xero_contact_id), '') IN (SELECT cxc.x FROM cxc) AND NOT (i.job_id IN (SELECT cj.id FROM cj))
    AND jb.type::text NOT IN ('makesafe', 'repair', 'insurance')
    AND upper(coalesce(i.invoice_type, 'ACCREC')) = 'ACCREC' AND upper(coalesce(i.status, '')) IN ('AUTHORISED', 'SUBMITTED')
    AND coalesce(i.amount_due, 0) > 0
    AND coalesce(i.created_at, i.synced_at, '-infinity'::timestamptz) <= p_as_of
  GROUP BY i.job_id, jb.job_number, nullif(btrim(i.xero_contact_id), ''), i.contact_name
 ),
 -- (story safety, sixth review) and what that Xero contact still owes on invoices placed on no
 -- job (bda6e1de's INV-0290: the rest of its quote, billed to the client's own contact and never
 -- placed on the job): the client's debt all the same, in owing and overdue, listed in
 -- money.placed_on_no_job and named in not_known; never a contact billed on builder work
 xn AS (
  SELECT nullif(btrim(i.xero_contact_id), '') AS xero_contact_id, i.contact_name AS party,
         sum(coalesce(i.amount_due, 0)) AS owing,
         sum(CASE WHEN i.due_date < (p_as_of AT TIME ZONE 'Australia/Perth')::date THEN coalesce(i.amount_due, 0) ELSE 0 END) AS overdue,
         string_agg(coalesce(i.invoice_number, 'an invoice without a number'), ', ' ORDER BY i.invoice_number COLLATE "C", i.id) AS numbers,
         jsonb_agg(jsonb_build_object('t', 'xero_invoices', 'id', i.id) ORDER BY i.invoice_date NULLS LAST, i.id) AS cites
  FROM public.xero_invoices i
  WHERE i.job_id IS NULL AND i.xero_contact_id IN (SELECT cxc.x FROM cxc)
    AND upper(coalesce(i.invoice_type, 'ACCREC')) = 'ACCREC' AND upper(coalesce(i.status, '')) IN ('AUTHORISED', 'SUBMITTED')
    AND coalesce(i.amount_due, 0) > 0 AND coalesce(i.created_at, i.synced_at, '-infinity'::timestamptz) <= p_as_of
    AND NOT EXISTS (SELECT 1 FROM public.xero_invoices b JOIN public.jobs bj ON bj.id = b.job_id
                    WHERE b.xero_contact_id = i.xero_contact_id AND bj.type::text IN ('makesafe', 'repair', 'insurance'))
  GROUP BY nullif(btrim(i.xero_contact_id), ''), i.contact_name
 ),
 lp AS (
  SELECT cj.job_number, l AS loop FROM st JOIN cj ON cj.id = st.id, jsonb_array_elements(st.s->'loops') l
 ),
 li AS (  -- visible ledger items across the shown stories' live generations
  SELECT cj.job_number, i.*
  FROM cj JOIN public.context_ledger_generations g ON g.job_id = cj.id AND g.status = 'live'
  JOIN public.context_ledger_items i ON i.generation_id = g.id
  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(i.opened_by) c
                    LEFT JOIN public.business_events e
                      ON e.id = CASE WHEN c->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (c->>'id')::uuid END
                    WHERE c->>'table' = 'business_events'
                      AND (e.id IS NULL OR e.job_id IS DISTINCT FROM cj.id OR NOT public.context_linked_status(e.attribution_status)
                           OR e.metadata->>'retracted_at' IS NOT NULL))
 )
 SELECT jsonb_build_object(
  'version', 'client-story-v1',
  'as_of', p_as_of,
  'job_id', p_job_id,
  'identity', (SELECT jsonb_build_object('basis', i.basis, 'contact_ref', i.contact, 'email_known', i.email IS NOT NULL) FROM ident i),
  'jobs', coalesce((SELECT jsonb_agg(jsonb_build_object('job_id', cj.id, 'job_number', cj.job_number, 'type', cj.type, 'status', cj.status,
             'live', cj.live, 'created_at', cj.created_at, 'phase', st.s->'now'->'phase',
             'now', left(st.s->'now'->>'line', 200),
             -- (fourth review) what the client owes on the job, as money.owing counts it; what
             -- others owe on it (the builder on builder work, a neighbour, another payer) apart
             'owing', (SELECT coalesce(sum(x.owing), 0) FROM mi x WHERE x.job_id = cj.id AND x.own),
             'overdue', (SELECT coalesce(sum(x.overdue), 0) FROM mi x WHERE x.job_id = cj.id AND x.own),
             'owed_by_others', (SELECT coalesce(sum(x.owing), 0) FROM mi x WHERE x.job_id = cj.id AND NOT x.own),
             'cites', jsonb_build_array(jsonb_build_object('t', 'jobs', 'id', cj.id))) ORDER BY cj.created_at DESC, cj.id)
           FROM cj LEFT JOIN st ON st.id = cj.id), '[]'::jsonb),
  -- (fourth review) owing and overdue are what the client owes: the invoices addressed to them
  -- on their jobs, and what their own Xero contact owes as a payer on another client's job
  -- (sixth review: or on an invoice placed on no job); what others owe on their jobs is
  -- owed_by_others, never in the client's total
  'money', jsonb_build_object('owing', (SELECT coalesce(sum(x.owing), 0) FROM mi x WHERE x.own) + (SELECT coalesce(sum(x.owing), 0) FROM xo x)
                                       + (SELECT coalesce(sum(x.owing), 0) FROM xn x),
             'overdue', (SELECT coalesce(sum(x.overdue), 0) FROM mi x WHERE x.own) + (SELECT coalesce(sum(x.overdue), 0) FROM xo x)
                        + (SELECT coalesce(sum(x.overdue), 0) FROM xn x),
             'placed_on_no_job', coalesce((SELECT jsonb_agg(jsonb_build_object('party', x.party, 'xero_contact_id', x.xero_contact_id,
                                   'owing', x.owing, 'overdue', x.overdue, 'invoices', x.numbers, 'cites', x.cites)
                                   ORDER BY x.owing DESC, x.party COLLATE "C", x.xero_contact_id COLLATE "C") FROM xn x), '[]'::jsonb),
             'owed_by_others', jsonb_build_object('owing', (SELECT coalesce(sum(x.owing), 0) FROM mi x WHERE NOT x.own),
                                                  'overdue', (SELECT coalesce(sum(x.overdue), 0) FROM mi x WHERE NOT x.own)),
             'not_yet_invoiced', (SELECT coalesce(sum(x.nyi), 0) FROM (SELECT max(m.not_yet_invoiced) AS nyi FROM mon m GROUP BY m.job_id) x),
             'parties', coalesce((SELECT jsonb_agg(DISTINCT p.party COLLATE "C" ORDER BY p.party COLLATE "C")
                                  FROM (SELECT m.party FROM mon m WHERE m.party IS NOT NULL UNION ALL SELECT x.party FROM xo x WHERE x.party IS NOT NULL
                                        UNION ALL SELECT x.party FROM xn x WHERE x.party IS NOT NULL) p),
                                 '[]'::jsonb),
             -- each paying party on its own: a neighbour's debt is never the client's; the client's
             -- own Xero contact owing on someone else's job counts here, that job named
             'by_party', coalesce((SELECT jsonb_agg(jsonb_build_object('party', x.party, 'xero_contact_id', x.xero_contact_id,
                            'owing', x.owing, 'overdue', x.overdue, 'job_numbers', x.jobs)
                            ORDER BY x.owing DESC, x.party COLLATE "C", x.xero_contact_id COLLATE "C")
                          FROM (SELECT y.party, y.xero_contact_id, sum(y.owing) AS owing, sum(y.overdue) AS overdue,
                                       jsonb_agg(DISTINCT y.job_number COLLATE "C" ORDER BY y.job_number COLLATE "C") AS jobs
                                FROM (SELECT m.party, m.xero_contact_id, m.owing, m.overdue, cj.job_number FROM mon m JOIN cj ON cj.id = m.job_id
                                      WHERE m.party IS NOT NULL
                                      UNION ALL
                                      SELECT x.party, x.xero_contact_id, x.owing, x.overdue, x.job_number FROM xo x) y
                                GROUP BY y.party, y.xero_contact_id) x), '[]'::jsonb),
             'other_jobs', coalesce((SELECT jsonb_agg(jsonb_build_object('job_id', x.job_id, 'job_number', x.job_number, 'party', x.party,
                            'xero_contact_id', x.xero_contact_id, 'owing', x.owing, 'overdue', x.overdue, 'cites', x.cites)
                            ORDER BY x.job_number COLLATE "C", x.job_id) FROM xo x), '[]'::jsonb)),
  -- story safety (20261006040000): a loop not due yet (status not_due: a final invoice
  -- before the work is done; fourth review: or unconfirmed, a final invoice whose amount
  -- the job value cannot confirm) comes after every loop due now, whatever its rank on its job
  'open_loops', coalesce((SELECT jsonb_agg(x.o ORDER BY x.nd, x.r, x.s NULLS LAST, x.jn COLLATE "C", x.k COLLATE "C") FROM (
                   SELECT lp.loop || jsonb_build_object('job_number', lp.job_number) AS o,
                          coalesce(lp.loop->>'status' IN ('not_due', 'unconfirmed'), false) AS nd,
                          (lp.loop->>'rank')::int AS r, (lp.loop->>'since')::timestamptz AS s, lp.job_number AS jn, lp.loop->>'key' AS k FROM lp
                   ORDER BY coalesce(lp.loop->>'status' IN ('not_due', 'unconfirmed'), false), (lp.loop->>'rank')::int,
                            (lp.loop->>'since')::timestamptz NULLS LAST, lp.job_number COLLATE "C", (lp.loop->>'key') COLLATE "C" LIMIT 10) x), '[]'::jsonb),
  'past_issues', coalesce((SELECT jsonb_agg(jsonb_build_object('job_number', li.job_number, 'what', li.what, 'status', li.status,
                   'since', li.opened_at, 'closed_at', li.closed_at,
                   'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(li.opened_by) c))
                   ORDER BY li.opened_at, li.job_number COLLATE "C", li.item_key COLLATE "C") FROM li WHERE li.item_type = 'issue'), '[]'::jsonb),
  'preferences', coalesce((SELECT jsonb_agg(jsonb_build_object('job_number', li.job_number, 'type', li.item_type, 'what', li.what,
                   'about_key', li.about_key, 'status', li.status, 'since', li.opened_at,
                   'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(li.opened_by) c))
                   ORDER BY li.opened_at, li.job_number COLLATE "C", li.item_key COLLATE "C")
                 FROM li WHERE li.item_type IN ('agreement', 'constraint') AND (li.about_key LIKE 'preference:%' OR li.about_key LIKE 'access:%')
                   AND li.status IN ('open', 'info')), '[]'::jsonb),
  'other_parties', coalesce((SELECT jsonb_agg(jsonb_build_object('job_number', cj.job_number, 'name', c.client_name, 'role', c.contact_type,
                   'contact_ref', c.ghl_contact_id, 'cites', jsonb_build_array(jsonb_build_object('t', 'job_contacts', 'id', c.id)))
                   ORDER BY cj.created_at DESC, cj.id, c.created_at, c.id)
                 FROM cj JOIN public.job_contacts c ON c.job_id = cj.id
                 WHERE c.removed_at IS NULL AND NOT coalesce(c.is_primary, false) AND coalesce(c.contact_type, '') <> 'primary'), '[]'::jsonb),
  'not_known', coalesce((SELECT jsonb_agg(x.o ORDER BY x.ord) FROM (
                   SELECT 1 AS ord, jsonb_build_object('what', 'This job has no CRM contact and no client email, so the client''s other jobs cannot be found.',
                          'why', 'Clients are matched by CRM contact or exact email, never by name.') AS o
                   FROM ident i WHERE i.basis IS NULL
                   UNION ALL
                   SELECT 2, jsonb_build_object('what', (SELECT count(*) FROM cj WHERE cj.n > 20) || ' older jobs are listed without a full story.',
                          'why', 'At most 20 stories are assembled in one read.')
                   WHERE (SELECT count(*) FROM cj WHERE cj.n > 20) > 0
                   UNION ALL
                   SELECT 3, jsonb_build_object('what', 'Matched by client email only; jobs under a different email or contact are not included.',
                          'why', 'This job has no CRM contact.')
                   FROM ident i WHERE i.basis = 'client_email'
                   UNION ALL
                   -- (fourth review) owing is what the client owes: what others owe on their jobs
                   -- (the builder on builder work, a neighbour, another payer) is named apart
                   SELECT 5, jsonb_build_object('what', 'Owing and overdue count only what this client owes; others owe '
                          || to_char((SELECT sum(x.owing) FROM mi x WHERE NOT x.own), 'FM$999,999,990.00')
                          || ' on these jobs (a builder on builder work, a neighbour or another payer), in money.owed_by_others; money.by_party has each paying party on its own.',
                          'why', 'An invoice is owed by whoever it is addressed to.')
                   WHERE (SELECT coalesce(sum(x.owing), 0) FROM mi x WHERE NOT x.own) > 0
                   UNION ALL
                   SELECT 5, jsonb_build_object('what', 'Owing and overdue add up every invoice addressed to this client on these jobs; money.by_party has each paying party on its own.',
                          'why', 'Shared work can have more than one payer.')
                   WHERE (SELECT coalesce(sum(x.owing), 0) FROM mi x WHERE NOT x.own) = 0
                     AND (SELECT count(DISTINCT coalesce(m.xero_contact_id, m.party)) FROM mon m WHERE m.party IS NOT NULL) > 1
                   UNION ALL
                   SELECT 6, jsonb_build_object('what', 'Owing includes ' || to_char((SELECT sum(x.owing) FROM xo x), 'FM$999,999,990.00')
                          || ' this client owes as a payer on another client''s job ('
                          || (SELECT string_agg(DISTINCT x.job_number COLLATE "C", ', ' ORDER BY x.job_number COLLATE "C") FROM xo x) || ').',
                          'why', 'The same Xero contact pays on that job; money.other_jobs names it.')
                   WHERE (SELECT coalesce(sum(x.owing), 0) FROM xo x) > 0
                   UNION ALL
                   -- (sixth review) what their own Xero contact owes on invoices placed on no job
                   SELECT 6, jsonb_build_object('what', 'Owing includes ' || to_char((SELECT sum(x.owing) FROM xn x), 'FM$999,999,990.00')
                          || ' on invoices addressed to this client''s Xero contact that are placed on no job ('
                          || (SELECT string_agg(x.numbers, ', ' ORDER BY x.numbers COLLATE "C") FROM xn x) || ').',
                          'why', 'An invoice reaches a job only when it is placed on it; money.placed_on_no_job names it.')
                   WHERE (SELECT coalesce(sum(x.owing), 0) FROM xn x) > 0
                   UNION ALL
                   SELECT 4, jsonb_build_object('what', 'Past issues and preferences come only from jobs whose ledger is live.',
                          'why', 'The reader has not read every job yet.')
                   WHERE EXISTS (SELECT 1 FROM cj WHERE NOT EXISTS (SELECT 1 FROM public.context_ledger_generations g WHERE g.job_id = cj.id AND g.status = 'live'))
                  ) x), '[]'::jsonb)
 )
 WHERE EXISTS (SELECT 1 FROM me)
$fn$;
COMMENT ON FUNCTION public.context_client_story(uuid, timestamptz) IS
 'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000): (sixth review) money.owing and money.overdue also count what the client''s own Xero contact still owes on invoices placed on no job (never a contact billed on builder work), listed in money.placed_on_no_job {party, xero_contact_id, owing, overdue, invoices, cites} and named in not_known. Earlier: money.owing and money.overdue, and each job''s owing and overdue, are what the client owes: only the invoices on their jobs addressed to them (payer role customer, never the builder''s on builder work, a neighbour''s or another payer''s; those are money.owed_by_others {owing, overdue} and each job''s owed_by_others, named in not_known), plus their own Xero contact as a payer elsewhere; open loops list a loop not due yet (status not_due: a final invoice before the work is done, or unconfirmed: one whose amount the job value cannot confirm) after every loop due now; money also counts what the client''s own Xero contact (on their private jobs: the job''s contact, the primary party''s, or a job''s only paying contact when every invoice to it names it as the client and it is billed on no builder work; never a neighbour''s, never on builder work) still owes on other clients'' private jobs, as a payer there (only invoices still owing; never on builder work, where every invoice is the builder''s): in owing, overdue, parties and by_party, listed in money.other_jobs and named in not_known. Earlier, story fixes: parties, paying parties, job numbers, open loops (by rank, since as a time, job number, key), past issues, preferences and other parties sort in C (byte) order with full tiebreaks. Earlier: client-story-v1 for the client of one job: identity (CRM contact, else exact client email, never a name), every job of that client with phase, short now line and owing (full story for the newest 20), money across jobs (and by_party, each payer on its own), top 10 open loops, past issues and standing preferences or access constraints from live ledgers, other parties per job, and not_known. Service role only.';

-- 8. The ledger store's evidence and citation check: a mail is left out only for a copy on the same job.
-- When a mail this rule brings back joined a job's evidence: not before this migration's
-- first apply (the 972 rule left out a mail with a copy anywhere, so no reading before
-- then saw it), and not before its copies landed where they sit now (a copy that moved
-- off the job stood in for the mail there until then). So the reader's evidence and the
-- judge time such a mail at the latest of its own landing, this migration's first apply
-- and its copies' landings; a reading built before then never counts it as read.
-- (a) This migration's first apply time, written once (a re-apply keeps it, the rollback
-- drops it). Like context_cadence_policy's live_since, it is a literal in the body.
DO $since$
BEGIN
 IF to_regprocedure('public.context_ledger_mail_rule_since()') IS NULL THEN
  EXECUTE format($f$
CREATE FUNCTION public.context_ledger_mail_rule_since() RETURNS timestamptz
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $body$ SELECT %L::timestamptz $body$$f$, now());
 END IF;
END $since$;
COMMENT ON FUNCTION public.context_ledger_mail_rule_since() IS
 'Story safety (20261006040000): the instant this migration was first applied, a literal written once (a re-apply keeps it; never replaced, only dropped by the rollback). From then a legacy mail whose saved copy sits on another job or on no job is that job''s evidence, so such a mail joined a job''s evidence no earlier than this (context_ledger_mail_copies); a reading built before it never read the mail. Pure. Service role only.';

-- (b) Each legacy mail's saved copies, by where they sit, with the earliest instant the
-- mail can have joined a job's evidence on their account. The copy keys are the 972
-- evidence's four, each read by an index (never one payload-index look-up per mail: the
-- payload index answered each in 0.65 to 0.84 ms live, almost all finding nothing, which
-- made the judge's copy read 0.5 s at full rollout): the source pointer; the graph key; an
-- email from the mail's sender at the mail's instant, read by sender (each sender once, on
-- the inbound mail sender index business_events_party_mail_from, and the few internal
-- mail rows by type); and payload inbox_events_id with no source table, read at the mail's
-- own instant, where its one writer (monitor-inbox's legacy fallback) stamps it and where
-- the job conversation's copy check reads it (job_conversation_inbox_copy.ts). Measured
-- read-only on 6 Oct 2026 over all 13,862 legacy mails: the same copies, job for job, as
-- every email row and the payload index give (4,817 of 4,817); the 3 old-path copies sit
-- at their mails' instants.
CREATE OR REPLACE FUNCTION public.context_ledger_mail_copies(p_mail_ids uuid[])
RETURNS TABLE(mail_id uuid, copy_job_id uuid, joined_at timestamptz)
LANGUAGE sql STABLE
AS $fn$
 WITH m AS MATERIALIZED (
  SELECT i.id, i.received_at, i.graph_message_id, lower(btrim(i.from_email)) AS sender
  FROM public.inbox_events i WHERE i.id = ANY (p_mail_ids)
 ),
 -- each sender once, with its mails' instants and ids (an email at one of those instants
 -- finds its mails through array_positions, so no mail is matched row by row)
 s AS (
  SELECT m.sender, array_agg(m.received_at ORDER BY m.id) AS ats, array_agg(m.id ORDER BY m.id) AS ids
  FROM m WHERE m.sender IS NOT NULL AND m.received_at IS NOT NULL GROUP BY m.sender
 ),
 cp AS (
  -- the source pointer
  SELECT m.id AS mail_id, b.job_id, greatest(coalesce(b.context_captured_at, b.recorded_at, b.occurred_at), b.attributed_at) AS landed
  FROM m JOIN public.business_events b ON b.source_table = 'inbox_events' AND b.source_id = m.id::text
  UNION ALL
  -- the graph key
  SELECT m.id, b.job_id, greatest(coalesce(b.context_captured_at, b.recorded_at, b.occurred_at), b.attributed_at)
  FROM m JOIN public.business_events b ON m.graph_message_id IS NOT NULL AND b.provider_message_id = 'graph:' || m.graph_message_id
  UNION ALL
  -- an inbound email from the mail's sender at the mail's instant (read by sender on the
  -- inbound mail sender index, then the evidence's own sender words)
  SELECT s.ids[p.p], b.job_id, greatest(coalesce(b.context_captured_at, b.recorded_at, b.occurred_at), b.attributed_at)
  FROM s JOIN public.business_events b
    ON lower(btrim(coalesce(substring(b.payload ->> 'from', '<([^<>]*)>'), b.payload ->> 'from'))) = s.sender
   AND b.event_type IN ('supplier.email_in', 'client.email_in')
   AND coalesce(b.event_at, b.occurred_at) = ANY (s.ats)
  CROSS JOIN LATERAL unnest(array_positions(s.ats, coalesce(b.event_at, b.occurred_at))) AS p(p)
  WHERE b.channel = 'email' AND lower(btrim(coalesce(b.payload ->> 'from', b.payload ->> 'from_email'))) = s.sender
  UNION ALL
  -- an internal email (staff to staff) from the mail's sender at the mail's instant
  SELECT s.ids[p.p], b.job_id, greatest(coalesce(b.context_captured_at, b.recorded_at, b.occurred_at), b.attributed_at)
  FROM public.business_events b
  JOIN s ON lower(btrim(coalesce(b.payload ->> 'from', b.payload ->> 'from_email'))) = s.sender
   AND coalesce(b.event_at, b.occurred_at) = ANY (s.ats)
  CROSS JOIN LATERAL unnest(array_positions(s.ats, coalesce(b.event_at, b.occurred_at))) AS p(p)
  WHERE b.event_type = 'staff.email_internal' AND b.channel = 'email'
  UNION ALL
  -- payload inbox_events_id with no source table, at the mail's own instant
  SELECT m.id, b.job_id, greatest(coalesce(b.context_captured_at, b.recorded_at, b.occurred_at), b.attributed_at)
  FROM m JOIN public.business_events b ON b.occurred_at = m.received_at
  WHERE b.source_table IS NULL AND b.payload ->> 'inbox_events_id' = m.id::text
 )
 SELECT x.mail_id, x.job_id, greatest(public.context_ledger_mail_rule_since(), max(x.landed))
 FROM cp x
 GROUP BY x.mail_id, x.job_id
$fn$;
COMMENT ON FUNCTION public.context_ledger_mail_copies(uuid[]) IS
 'Story safety (20261006040000): for each given legacy mail (inbox_events id) with a business_events copy (the 972 evidence''s copy keys, each read by an index: the source pointer; the graph key; an email from the same sender at the same instant, an inbound one (client.email_in, supplier.email_in) read by sender on business_events_party_mail_from or an internal one (staff.email_internal); and payload inbox_events_id with no source table, read at the mail''s own instant, where monitor-inbox''s legacy fallback stamps it), one row per job its copies sit on (copy_job_id; null is no job) with joined_at: no earlier than context_ledger_mail_rule_since and the newest landing of those copies there (captured or recorded, and placed). A caller reading one job''s evidence takes the copies sitting elsewhere: the mail joined that job''s evidence no earlier than their joined_at (a copy on the job itself leaves the mail out of it). A mail with no copy has no row: it joined when it landed. A copy moved to no job is timed by its own landing, not the move (unplacing keeps no reliable time: attribution_checked_at also moves on every re-check); a reading made while it sat on the job read its words. Read by context_ledger_evidence_rows and context_ledger_judge. Plain SQL with no SET. Service role only.';

CREATE OR REPLACE FUNCTION public.context_ledger_evidence_rows(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, src_table text, src_id uuid, at timestamptz, landed_at timestamptz, channel text, kind text,
 direction text, sender_role text, recipient_role text, audience text, counterpart_role text, role_basis text,
 sender text, recipient text, ours boolean, automated boolean, subject text, body text, placed_on text, has_transcript boolean,
 call_customer boolean, copy_of uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH j AS (
  SELECT jb.id, lower(nullif(btrim(jb.client_email), '')) AS cmail, nullif(btrim(jb.client_name), '') AS cname, jb.created_at,
   -- the client has another job (the same CRM contact or client email)
   (EXISTS (SELECT 1 FROM public.jobs o WHERE o.ghl_contact_id = nullif(btrim(jb.ghl_contact_id), '') AND o.id <> jb.id)
    OR EXISTS (SELECT 1 FROM public.jobs o WHERE o.client_email IS NOT NULL
     AND lower(btrim(o.client_email)) = lower(nullif(btrim(jb.client_email), '')) AND o.id <> jb.id)) AS repeat_client
  FROM public.jobs jb WHERE jb.id = ANY(p_job_ids)
 ), be AS (
  SELECT e.job_id, 'business_events'::text AS src_table, e.id AS src_id,
   -- a CRM text loaded later from the CRM's cache is timed by the CRM's own time, as the
   -- story times it (story safety, 20261006040000); it landed when it was loaded
   coalesce(ct.crm_at, e.event_at, e.occurred_at) AS at,
   greatest(coalesce(e.context_captured_at, e.recorded_at, e.occurred_at), e.attributed_at) AS landed_at,
   coalesce(e.channel, CASE WHEN e.event_type LIKE '%email%' THEN 'email' WHEN e.event_type LIKE '%call%' THEN 'call'
    WHEN e.event_type LIKE 'note.%' THEN 'note' ELSE 'sms' END) AS channel,
   e.event_type AS kind, e.direction,
   e.metadata #>> '{party_roles,sender_role}' AS sender_role,
   e.metadata #>> '{party_roles,recipient_role}' AS recipient_role,
   coalesce(e.metadata #>> '{party_roles,audience}', e.metadata ->> 'audience') AS audience,
   e.metadata #>> '{party_roles,counterpart_role}' AS counterpart_role,
   e.metadata #>> '{party_roles,basis}' AS role_basis,
   CASE WHEN e.metadata #>> '{party_roles,sender_role}' = 'customer' AND e.metadata #>> '{party_roles,basis}' = 'job_customer' THEN j.cname
    ELSE coalesce((SELECT s.label FROM public.staff_ghl_users s
      WHERE s.ghl_user_id = coalesce(e.payload ->> 'sent_by_user', e.payload ->> 'by_user') LIMIT 1),
     nullif(btrim(coalesce(e.payload ->> 'from_name', e.payload ->> 'from', e.payload ->> 'from_email')), '')) END AS sender,
   CASE WHEN e.metadata #>> '{party_roles,recipient_role}' = 'customer' AND e.metadata #>> '{party_roles,basis}' = 'job_customer' THEN j.cname
    ELSE nullif(btrim(coalesce(e.payload ->> 'to_name', e.payload ->> 'to', e.payload ->> 'to_email')), '') END AS recipient,
   public.context_event_is_ours(e) AS ours,
   (coalesce(e.payload ->> 'sent_by_kind', '') = 'workflow' OR public.context_internal_text_role(e) <> 'other') AS automated,
   nullif(btrim(e.payload ->> 'subject'), '') AS subject,
   public.context_event_text(e) AS body,
   'this_job'::text AS placed_on,
   -- A call log (not a transcript) says whether its transcript is on the job: the
   -- transcript names the call's GHL message id in payload.ghl_call_id (and in its
   -- key ghltx:<id>); the call row's key is ghl:<id>.
   CASE WHEN e.event_type <> 'call.transcript_completed'
         AND (e.channel = 'call' OR e.event_type IN ('client.call_logged', 'client.call_complete'))
    THEN coalesce(e.provider_message_id LIKE 'ghl:%' AND EXISTS (SELECT 1 FROM public.business_events t
     WHERE t.job_id = e.job_id AND t.event_type = 'call.transcript_completed' AND public.context_linked_status(t.attribution_status)
      AND (t.payload ->> 'ghl_call_id' = substr(e.provider_message_id, 5)
       OR t.provider_message_id = 'ghltx:' || substr(e.provider_message_id, 5))), false) END AS has_transcript,
   -- A transcript says whether its call makes it the customer's words (the cite's rule).
   public.context_ledger_call_customer(e) AS call_customer,
   lower(nullif(btrim(coalesce(e.payload ->> 'from', e.payload ->> 'from_email')), '')) AS sender_key
  FROM j JOIN public.business_events e ON e.job_id = j.id
  CROSS JOIN LATERAL (SELECT CASE WHEN e.source = 'ghl_sms_cache_backfill'
                                  THEN public.context_job_record_crm_time(e.source, e.contact_id,
                                         coalesce(nullif(btrim(e.payload ->> 'ghl_message_id'), ''), substring(e.provider_message_id FROM '^ghl:(.+)$')), e.job_id)
                             END AS crm_at) ct
  WHERE public.context_ledger_row_admissible(e)
   AND coalesce(ct.crm_at, e.event_at, e.occurred_at) <= p_as_of
   AND greatest(coalesce(e.context_captured_at, e.recorded_at, e.occurred_at), e.attributed_at) <= p_as_of
   -- one the CRM dates more than 30 days before the job was created is from before the
   -- job's lead window: the CRM contact may have been another person's then, so it is not
   -- this job's evidence (the story never reads it as the customer's either); nor one whose
   -- CRM time is no longer known (sixth review: it may be from before the lead window, and
   -- its load time is not when it was sent)
   AND NOT coalesce(ct.crm_at < j.created_at - interval '30 days', false)
   AND NOT (e.source = 'ghl_sms_cache_backfill' AND ct.crm_at IS NULL)
 ), inbox_c AS (
  -- Legacy mail placed on the job, or from the client's own address and placed
  -- on no job. Mail the old matcher put on another job stays there: a repeat
  -- customer's mail about one job never enters every job of theirs. Unplaced
  -- mail is evidence only when the client has no other job (else it may be that
  -- job's), from 30 days before the job was created (the record layer's
  -- context_job_record_legacy_mail keeps the same rule).
  SELECT j.id AS job_id, i.id, i.received_at, i.processed_at, i.subject, i.body_preview, i.from_email, i.from_name,
   i.to_email, i.mailbox, i.graph_message_id, i.classification, j.cmail, j.cname, 'this_job'::text AS placed_on
  FROM j JOIN public.inbox_events i ON i.job_id = j.id
  UNION
  SELECT j.id, i.id, i.received_at, i.processed_at, i.subject, i.body_preview, i.from_email, i.from_name,
   i.to_email, i.mailbox, i.graph_message_id, i.classification, j.cmail, j.cname, 'none'::text
  FROM j JOIN public.inbox_events i ON j.cmail IS NOT NULL AND lower(btrim(i.from_email)) = j.cmail AND i.job_id IS NULL
  WHERE NOT j.repeat_client AND i.received_at >= j.created_at - interval '30 days'
 ), email_copy AS MATERIALIZED (
  -- An email row on the same job with the same sender at the same instant is the same mail.
  SELECT DISTINCT b.job_id, coalesce(b.event_at, b.occurred_at) AS at,
   lower(btrim(coalesce(b.payload ->> 'from', b.payload ->> 'from_email'))) AS sender
  FROM public.business_events b
  WHERE b.channel = 'email' AND b.job_id = ANY(p_job_ids) AND coalesce(b.event_at, b.occurred_at) IN (SELECT ic.received_at FROM inbox_c ic)
 ), copies AS MATERIALIZED (
  -- Each mail's saved copies by where they sit (context_ledger_mail_copies): a mail kept
  -- here although a copy sits on another job or on no job joined this job's evidence no
  -- earlier than their joined_at (story safety, 20261006040000).
  SELECT x.mail_id, x.copy_job_id, x.joined_at FROM public.context_ledger_mail_copies(ARRAY(SELECT DISTINCT ic.id FROM inbox_c ic)) x
 ), inbox AS (
  SELECT c.job_id, 'inbox_events'::text AS src_table, c.id AS src_id, c.received_at AS at,
   -- when it joined this job's evidence: when it landed, or, kept here only because its copy
   -- sits elsewhere, no earlier than that (a reading built before then never read it)
   greatest(coalesce(c.processed_at, c.received_at),
            (SELECT max(x.joined_at) FROM copies x WHERE x.mail_id = c.id AND x.copy_job_id IS DISTINCT FROM c.job_id)) AS landed_at,
   'email'::text AS channel, 'inbox.email_in'::text AS kind,
   'inbound'::text AS direction,
   CASE WHEN lower(btrim(c.from_email)) = c.cmail THEN 'customer'
    WHEN lower(coalesce(c.from_email, '')) ~ '@([a-z0-9-]+\.)*(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$' THEN 'staff' END AS sender_role,
   'staff'::text AS recipient_role,
   CASE WHEN lower(btrim(c.from_email)) = c.cmail THEN 'customer'
    WHEN lower(coalesce(c.from_email, '')) ~ '@([a-z0-9-]+\.)*(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$' THEN 'internal' END AS audience,
   CASE WHEN lower(btrim(c.from_email)) = c.cmail THEN 'customer' END AS counterpart_role,
   CASE WHEN lower(btrim(c.from_email)) = c.cmail THEN 'client_email' END AS role_basis,
   CASE WHEN lower(btrim(c.from_email)) = c.cmail THEN coalesce(c.cname, nullif(btrim(c.from_name), ''), c.from_email)
    ELSE coalesce(nullif(btrim(c.from_name), ''), c.from_email) END AS sender,
   coalesce(nullif(btrim(c.to_email), ''), c.mailbox) AS recipient,
   lower(coalesce(c.from_email, '')) ~ '@([a-z0-9-]+\.)*(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$' AS ours,
   false AS automated,
   nullif(btrim(c.subject), '') AS subject,
   coalesce(nullif(btrim(c.body_preview), ''), btrim(c.subject)) AS body,
   c.placed_on, NULL::boolean AS has_transcript, NULL::boolean AS call_customer,
   lower(nullif(btrim(c.from_email), '')) AS sender_key
  FROM inbox_c c
  WHERE c.received_at IS NOT NULL AND c.received_at <= p_as_of
   AND coalesce(c.processed_at, c.received_at) <= p_as_of
   AND coalesce(c.classification, '') NOT IN ('spam', 'newsletter')
   AND coalesce(c.subject, '') !~* '^(automatic reply|auto[- ]?reply|out of office)'
   AND btrim(coalesce(c.subject, '') || coalesce(c.body_preview, '')) <> ''
   -- A business_events copy on this job stands in for the mail (the reader reads the
   -- copy); a copy left unplaced or placed on another job leaves the mail here, so each
   -- email reaches this job's reader once (story safety, 20261006040000).
   AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table = 'inbox_events' AND b.source_id = c.id::text
    AND b.job_id = c.job_id)
   AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE c.graph_message_id IS NOT NULL AND b.provider_message_id = 'graph:' || c.graph_message_id
    AND b.job_id = c.job_id)
   -- An old-path copy names its inbox row only in the payload (containment, so
   -- the payload index answers it instead of a scan of every business_events row).
   AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table IS NULL
    AND b.payload @> jsonb_build_object('inbox_events_id', c.id::text) AND b.job_id = c.job_id)
   AND NOT EXISTS (SELECT 1 FROM email_copy m WHERE m.job_id = c.job_id AND m.at = c.received_at AND m.sender = lower(btrim(c.from_email)))
 ), allrows AS (
  SELECT * FROM be UNION ALL SELECT * FROM inbox
 ), keyed AS (
  SELECT a.*,
   lag(a.at) OVER w AS prev_at, lag(a.src_id) OVER w AS prev_id
  FROM allrows a
  WINDOW w AS (PARTITION BY a.job_id, a.channel, coalesce(a.direction, ''), coalesce(a.sender_key, ''),
   md5(lower(public.context_ledger_text_norm(a.body))) ORDER BY a.at, a.src_id)
 )
 SELECT k.job_id, k.src_table, k.src_id, k.at, k.landed_at, k.channel, k.kind, k.direction, k.sender_role, k.recipient_role,
  k.audience, k.counterpart_role, k.role_basis, k.sender, k.recipient, k.ours, k.automated, k.subject, k.body,
  k.placed_on, k.has_transcript, k.call_customer,
  CASE WHEN k.prev_at IS NOT NULL AND k.at - k.prev_at <= interval '120 seconds' THEN k.prev_id END AS copy_of
 FROM keyed k
 ORDER BY k.job_id, k.at, k.src_id
$$;
COMMENT ON FUNCTION public.context_ledger_evidence_rows(uuid[], timestamptz) IS
 'Context ledger store (20261006013000), story safety (20261006040000): a CRM text loaded later from the CRM''s cache (source ghl_sms_cache_backfill) is at the CRM''s own time (context_job_record_crm_time, as the story times it; landed_at stays its load), and one the CRM dates more than 30 days before the job was created (before its lead window) is left out: it is not this job''s evidence; (sixth review) so is one whose CRM time is no longer kept (its load time is not when it was sent). A legacy mail is left out only for a business_events copy on the same job (source pointer, graph key, payload inbox_events_id, or an email from the same sender at the same instant); a copy unplaced or on another job no longer hides it, so each email reaches the job''s reader once. Such a mail is in the evidence from its own landing, but its landed_at is when it joined the job''s evidence: no earlier than this rule''s first apply and its copies'' landing where they sit (context_ledger_mail_copies), so a reading built before then never counts it as read. Earlier: the admissible worded evidence of the given jobs as of an instant, oldest first: business_events rows passing context_ledger_row_admissible, plus legacy inbox_events mail placed on the job, or from the client''s address and placed on no job (placed_on this_job or none; mail placed on another job stays there; unplaced mail only when the client has no other job by CRM contact or client email, and from 30 days before the job was created), with no business_events copy (source pointer, graph key, payload inbox_events_id, or the same sender at the same instant), spam, newsletters and auto-replies left out. has_transcript on a call log: its transcript (payload.ghl_call_id or key ghltx:<id> naming the call''s ghl:<id>) is on the job. call_customer on a transcript: context_ledger_call_customer (its call''s customer stamp, the citation check''s rule). copy_of names the earlier row when this row is a copy (same channel, direction, sender address and words within 120 seconds); nothing is changed. Placement is read as it is now. Service role only.';

CREATE OR REPLACE FUNCTION public.context_ledger_cite(p_job_id uuid, p_cite jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_table text; v_id uuid; v_excerpt text; v_norm text; e public.business_events; v_text text; v_at timestamptz;
 v_cmail text; v_job uuid; v_found boolean; i record; v_ours boolean := false; v_customer boolean := false;
 v_call_note boolean := false; v_internal boolean := false; v_record boolean := false; v_worded boolean := false;
 v_subject text; v_body text; v_close_at timestamptz; v_automated boolean := false; v_made_at timestamptz; v_paid_at timestamptz;
 v_job_created timestamptz; v_repeat boolean; v_kind text; v_doc text; v_crm_at timestamptz;
BEGIN
 IF p_cite IS NULL OR jsonb_typeof(p_cite) <> 'object'
  OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_cite) k WHERE k NOT IN ('table', 'id', 'excerpt'))
  OR jsonb_typeof(p_cite -> 'table') IS DISTINCT FROM 'string' OR jsonb_typeof(p_cite -> 'id') IS DISTINCT FROM 'string'
  OR coalesce(jsonb_typeof(p_cite -> 'excerpt'), 'null') NOT IN ('string', 'null') THEN
  RETURN jsonb_build_object('ok', false, 'code', 'citation_shape', 'detail', 'a citation is {table, id, excerpt}');
 END IF;
 v_table := p_cite ->> 'table';
 IF v_table NOT IN ('business_events','inbox_events','job_documents','xero_invoices','job_assignments','job_events','email_events') THEN
  RETURN jsonb_build_object('ok', false, 'code', 'citation_table_not_allowed', 'detail', left(v_table, 40));
 END IF;
 IF (p_cite ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RETURN jsonb_build_object('ok', false, 'code', 'citation_shape', 'detail', 'id is not a uuid');
 END IF;
 v_id := (p_cite ->> 'id')::uuid;
 v_excerpt := p_cite ->> 'excerpt';
 v_norm := public.context_ledger_text_norm(v_excerpt);
 IF length(v_norm) > 400 THEN RETURN jsonb_build_object('ok', false, 'code', 'excerpt_too_long', 'detail', v_table || ':' || v_id); END IF;
 IF v_table = 'business_events' THEN
  SELECT * INTO e FROM public.business_events b WHERE b.id = v_id;
  IF e.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'citation_missing', 'detail', v_table || ':' || v_id); END IF;
  IF e.job_id IS DISTINCT FROM p_job_id THEN RETURN jsonb_build_object('ok', false, 'code', 'citation_off_job', 'detail', v_table || ':' || v_id); END IF;
  -- the same admission as the evidence: linked, not retracted, our own writer,
  -- worded, a message (never a status-only or record-kind row)
  IF NOT public.context_ledger_row_admissible(e) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'citation_not_admissible', 'detail', v_table || ':' || v_id);
  END IF;
  v_body := public.context_event_text(e);
  v_worded := btrim(v_body) <> '';
  v_subject := nullif(btrim(e.payload ->> 'subject'), '');
  v_text := concat_ws(' ', v_subject, v_body);
  v_at := coalesce(e.event_at, e.occurred_at);
  -- a CRM text loaded later from the CRM's cache is at the CRM's own time, as the evidence
  -- times it; one the CRM dates more than 30 days before the job was created is not this
  -- job's evidence (the evidence leaves it out), so it is not cited (story safety, 20261006040000),
  -- nor one whose CRM time is no longer known (sixth review: the evidence leaves it out too)
  IF e.source = 'ghl_sms_cache_backfill' THEN
   v_crm_at := public.context_job_record_crm_time(e.source, e.contact_id,
    coalesce(nullif(btrim(e.payload ->> 'ghl_message_id'), ''), substring(e.provider_message_id FROM '^ghl:(.+)$')), e.job_id);
   IF v_crm_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'citation_not_admissible',
     'detail', v_table || ':' || v_id || ' was loaded from the CRM''s cache and its CRM time is no longer kept');
   END IF;
   IF v_crm_at < (SELECT jb.created_at FROM public.jobs jb WHERE jb.id = p_job_id) - interval '30 days' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'citation_not_admissible',
     'detail', v_table || ':' || v_id || ' is dated by the CRM more than 30 days before the job was created');
   END IF;
   v_at := v_crm_at;
  END IF;
  IF e.event_type = 'call.transcript_completed' THEN
   -- A transcript holds both sides' words: it counts as the customer's only on
   -- its call's stamp (the job's customer was the other party on that call).
   v_customer := coalesce(public.context_ledger_call_customer(e), false);
  ELSE
   v_customer := (e.metadata #>> '{party_roles,sender_role}' = 'customer' AND e.metadata #>> '{party_roles,basis}' = 'job_customer')
    OR (NOT coalesce(e.metadata ? 'party_roles', false) AND e.event_type LIKE 'client.%' AND e.direction = 'inbound');
  END IF;
  v_automated := coalesce(e.payload ->> 'sent_by_kind', '') = 'workflow' OR public.context_internal_text_role(e) <> 'other';
  v_ours := public.context_event_is_ours(e);
  v_call_note := e.channel IN ('call', 'note') OR e.event_type IN ('call.transcript_completed', 'client.call_logged', 'note.added', 'ghl.internal_comment');
  v_internal := e.channel IN ('sms', 'email') AND (public.context_internal_text_role(e) <> 'other'
   OR coalesce(e.metadata #>> '{party_roles,audience}', e.metadata ->> 'audience') = 'internal');
 ELSIF v_table = 'inbox_events' THEN
  SELECT lower(nullif(btrim(jb.client_email), '')), jb.created_at, (EXISTS (SELECT 1 FROM public.jobs o WHERE o.ghl_contact_id = nullif(btrim(jb.ghl_contact_id), '') AND o.id <> jb.id)
    OR EXISTS (SELECT 1 FROM public.jobs o WHERE o.client_email IS NOT NULL
     AND lower(btrim(o.client_email)) = lower(nullif(btrim(jb.client_email), '')) AND o.id <> jb.id))
  INTO v_cmail, v_job_created, v_repeat FROM public.jobs jb WHERE jb.id = p_job_id;
  SELECT x.id, x.job_id, x.from_email, x.subject, x.body_preview, x.received_at, x.graph_message_id, x.classification INTO i
  FROM public.inbox_events x WHERE x.id = v_id;
  IF i.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'citation_missing', 'detail', v_table || ':' || v_id); END IF;
  IF NOT (i.job_id IS NOT DISTINCT FROM p_job_id OR (i.job_id IS NULL AND v_cmail IS NOT NULL AND lower(btrim(i.from_email)) = v_cmail)) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'citation_off_job', 'detail', v_table || ':' || v_id);
  END IF;
  -- Unplaced mail as the evidence admits it: never when the client has another
  -- job (it may be that job's), never from before 30 days ahead of the job.
  IF i.job_id IS NULL AND (coalesce(v_repeat, false) OR i.received_at < v_job_created - interval '30 days') THEN
   RETURN jsonb_build_object('ok', false, 'code', 'citation_not_admissible',
    'detail', v_table || ':' || v_id || ' is placed on no job and ' || CASE WHEN coalesce(v_repeat, false)
     THEN 'the client has another job' ELSE 'is older than 30 days before the job' END);
  END IF;
  -- Same admission as the evidence: a mail with a business_events copy is cited by its copy.
  IF i.received_at IS NULL OR coalesce(i.classification, '') IN ('spam', 'newsletter')
   OR coalesce(i.subject, '') ~* '^(automatic reply|auto[- ]?reply|out of office)'
   OR btrim(coalesce(i.subject, '') || coalesce(i.body_preview, '')) = ''
   -- (a copy counts only on this job, as the evidence reads it: story safety, 20261006040000)
   OR EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table = 'inbox_events' AND b.source_id = i.id::text AND b.job_id = p_job_id)
   OR EXISTS (SELECT 1 FROM public.business_events b WHERE i.graph_message_id IS NOT NULL AND b.provider_message_id = 'graph:' || i.graph_message_id
    AND b.job_id = p_job_id)
   OR EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table IS NULL
    AND b.payload @> jsonb_build_object('inbox_events_id', i.id::text) AND b.job_id = p_job_id)
   OR EXISTS (SELECT 1 FROM public.business_events b WHERE b.channel = 'email' AND coalesce(b.event_at, b.occurred_at) = i.received_at
    AND lower(btrim(coalesce(b.payload ->> 'from', b.payload ->> 'from_email'))) = lower(btrim(i.from_email)) AND b.job_id = p_job_id) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'citation_not_admissible', 'detail', v_table || ':' || v_id);
  END IF;
  v_subject := nullif(btrim(i.subject), ''); v_body := i.body_preview;
  v_text := concat_ws(' ', v_subject, v_body);
  v_worded := btrim(coalesce(v_text, '')) <> '';
  v_at := i.received_at;
  v_customer := v_cmail IS NOT NULL AND lower(btrim(i.from_email)) = v_cmail;
  v_ours := lower(coalesce(i.from_email, '')) ~ '@([a-z0-9-]+\.)*(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$';
 ELSE
  -- A record row: on this job; its time is when the record was made or sent.
  v_record := true; v_ours := true;
  -- v_close_at: when the record can close an item; null when it cannot (a
  -- document never sent, an invoice not issued, a booking nobody attended)
  IF v_table = 'job_documents' THEN
   SELECT d.job_id, coalesce(d.sent_at, d.created_at), d.sent_at, d.id::text, true INTO v_job, v_at, v_close_at, v_doc, v_found
   FROM public.job_documents d WHERE d.id = v_id;
  ELSIF v_table = 'xero_invoices' THEN
   -- paid_at: a payment item closes only on a PAID invoice, at its paid day (Perth
   -- midnight, as the timeline's paid line), never after now; an issued invoice
   -- not yet paid never closes a payment
   SELECT x.job_id, coalesce((x.invoice_date::timestamp AT TIME ZONE 'Australia/Perth'), x.created_at),
    CASE WHEN upper(coalesce(x.status, '')) IN ('AUTHORISED', 'SUBMITTED', 'PAID')
         THEN coalesce((x.invoice_date::timestamp AT TIME ZONE 'Australia/Perth'), x.created_at) END,
    CASE WHEN upper(coalesce(x.status, '')) = 'PAID' AND x.fully_paid_on IS NOT NULL
         THEN least((x.fully_paid_on::timestamp AT TIME ZONE 'Australia/Perth'), now()) END, true
   INTO v_job, v_at, v_close_at, v_paid_at, v_found FROM public.xero_invoices x WHERE x.id = v_id;
  ELSIF v_table = 'job_assignments' THEN
   -- a booking closes on attendance: completed_at, else started_at, else a
   -- status-only completion at the end of its booked Perth day, or at this
   -- write's now while that is still ahead (never a close in the future); it is made
   -- (booking_made) while it stands, at its created time. Crew planning's
   -- confirmation is never read; an observer's mirror is never a booking.
   SELECT a.job_id, a.created_at,
    CASE WHEN coalesce(a.is_ghost, false) OR coalesce(a.role, '') = 'observer' THEN NULL
         ELSE coalesce(a.completed_at, a.started_at,
          CASE WHEN lower(coalesce(a.status, '')) IN ('complete', 'completed') AND a.scheduled_date IS NOT NULL
               THEN least(((a.scheduled_date + 1)::timestamp AT TIME ZONE 'Australia/Perth') - interval '1 second', now()) END) END,
    CASE WHEN NOT (coalesce(a.is_ghost, false) OR coalesce(a.role, '') = 'observer')
          AND lower(coalesce(a.status, '')) NOT IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined') THEN a.created_at END,
    true INTO v_job, v_at, v_close_at, v_made_at, v_found
   FROM public.job_assignments a WHERE a.id = v_id;
  ELSIF v_table = 'job_events' THEN
   -- an app event closes only what it records (context_ledger_job_event_closes, by kind)
   SELECT je.job_id, je.created_at, je.created_at, je.event_type, nullif(btrim(je.detail_json ->> 'document_id'), ''), true
   INTO v_job, v_at, v_close_at, v_kind, v_doc, v_found
   FROM public.job_events je WHERE je.id = v_id;
  ELSE
   -- a system email closes only once it went out: sent, delivered or accepted with
   -- a sent time, timed then (a bounced, failed or queued email never closes)
   SELECT ee.job_id, coalesce(ee.sent_at, ee.created_at),
    CASE WHEN lower(coalesce(ee.status, '')) IN ('sent', 'delivered', 'accepted') THEN ee.sent_at END, ee.email_type, true
   INTO v_job, v_at, v_close_at, v_kind, v_found
   FROM public.email_events ee WHERE ee.id = v_id;
  END IF;
  IF NOT coalesce(v_found, false) THEN RETURN jsonb_build_object('ok', false, 'code', 'citation_missing', 'detail', v_table || ':' || v_id); END IF;
  -- A document our system emailed (a quote, an invoice) reached the customer only
  -- when one of its emails went out (sent, delivered or accepted, with a sent
  -- time). The document and its app event ("quote sent", written when the send
  -- was tried) close no earlier than the first such email, and never while every
  -- one bounced or failed. A document with no system email keeps its own time,
  -- and one the customer viewed, accepted or declined plainly reached them.
  IF v_doc IS NOT NULL AND v_close_at IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.email_events ee WHERE ee.metadata ->> 'document_id' = v_doc)
   AND NOT EXISTS (SELECT 1 FROM public.job_documents d WHERE d.id::text = v_doc
     AND (d.viewed_at IS NOT NULL OR d.accepted_at IS NOT NULL OR d.declined_at IS NOT NULL)) THEN
   v_close_at := greatest(v_close_at, (SELECT min(ee.sent_at) FROM public.email_events ee
    WHERE ee.metadata ->> 'document_id' = v_doc
     AND lower(coalesce(ee.status, '')) IN ('sent', 'delivered', 'accepted') AND ee.sent_at IS NOT NULL));
   IF NOT EXISTS (SELECT 1 FROM public.email_events ee WHERE ee.metadata ->> 'document_id' = v_doc
     AND lower(coalesce(ee.status, '')) IN ('sent', 'delivered', 'accepted') AND ee.sent_at IS NOT NULL) THEN
    v_close_at := NULL;
   END IF;
  END IF;
  IF v_job IS DISTINCT FROM p_job_id THEN RETURN jsonb_build_object('ok', false, 'code', 'citation_off_job', 'detail', v_table || ':' || v_id); END IF;
  IF v_at IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'citation_not_admissible', 'detail', v_table || ':' || v_id); END IF;
 END IF;
 IF NOT v_record THEN
  v_close_at := v_at;
  IF v_worded AND v_norm = '' THEN
   RETURN jsonb_build_object('ok', false, 'code', 'excerpt_required', 'detail', v_table || ':' || v_id);
  END IF;
  IF v_norm <> '' AND position(v_norm IN public.context_ledger_text_norm(v_text)) = 0 THEN
   RETURN jsonb_build_object('ok', false, 'code', 'excerpt_not_verbatim', 'detail', v_table || ':' || v_id);
  END IF;
  -- A quote is at least 12 characters or 3 words, unless it is the whole row
  -- (or its whole subject or body) because the row is shorter.
  IF v_norm <> '' AND length(v_norm) < 12 AND coalesce(array_length(regexp_split_to_array(v_norm, '\s+'), 1), 0) < 3
   AND v_norm IS DISTINCT FROM public.context_ledger_text_norm(v_text)
   AND v_norm IS DISTINCT FROM public.context_ledger_text_norm(v_body)
   AND v_norm IS DISTINCT FROM public.context_ledger_text_norm(v_subject) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'excerpt_too_short', 'detail', v_table || ':' || v_id);
  END IF;
 END IF;
 RETURN jsonb_build_object('ok', true, 'cite', jsonb_build_object('table', v_table, 'id', v_id::text, 'excerpt', v_excerpt),
  'at', v_at, 'close_at', v_close_at, 'made_at', v_made_at, 'paid_at', v_paid_at, 'kind', v_kind, 'customer_sender', v_customer, 'ours', v_ours, 'call_or_note', v_call_note,
  'internal_text', v_internal, 'record', v_record, 'worded', v_worded, 'automated', v_automated);
END $$;
COMMENT ON FUNCTION public.context_ledger_cite(uuid, jsonb) IS
 'Context ledger store (20261006013000), story safety (20261006040000): an inbox_events mail is refused for a business_events copy only when the copy is on this job (as the evidence reads it), so every mail citation accepted before is still accepted and a mail whose copy sits unplaced or on another job can now be cited. A CRM text loaded later from the CRM''s cache (source ghl_sms_cache_backfill) is at the CRM''s own time (context_job_record_crm_time, as the evidence times it), and one the CRM dates more than 30 days before the job was created is refused (citation_not_admissible), as the evidence leaves it out; (sixth review) so is one whose CRM time is no longer kept (neither in context_crm_message_times nor the cache). Earlier: checks one {table, id, excerpt} citation for a job: an allowed table; a business_events row on this job that is ledger evidence (context_ledger_row_admissible: linked, not retracted, written as service_role, worded, a message); a call transcript counts as the customer''s only when its call (ghl:<id>) is stamped with the job''s customer; an inbox_events mail placed on the job, or from the client''s address and placed on no job when the client has no other job and the mail is from 30 days before the job on, with no business_events copy; a record row (job_documents, xero_invoices, job_assignments, job_events, email_events) on this job. A worded evidence row needs an excerpt that, quotes straightened and whitespace collapsed, is in its subject and text, and is at least 12 characters or 3 words unless it is the whole row, subject or body. close_at: when the row can close an item (a worded row: its time; a document: sent_at; an invoice: only AUTHORISED, SUBMITTED or PAID, and a payment only PAID, at its paid day (paid_at); a booking: attendance, completed_at, else started_at, else a status-only completion at the end of its booked Perth day or, while that is ahead, now; a system email (email_events): only sent, delivered or accepted with a sent time, at sent_at; an app event (job_events): its time, closing only the matter it records (context_ledger_job_event_closes on kind); a document our system emailed (job_documents, or a job_events row naming its document_id): no earlier than its first email sent, delivered or accepted with a sent time, never while every one bounced or failed; a system email closes only its own matter (context_ledger_email_closes on kind); null when it cannot); kind: an app event''s event_type or a system email''s email_type; made_at: a standing booking''s created time (it closes a booking_made item; not standing = cancelled, deleted, draft, disputed, declined). Refusal codes citation_shape, citation_table_not_allowed, citation_missing, citation_off_job, citation_not_admissible, excerpt_required, excerpt_not_verbatim, excerpt_too_long, excerpt_too_short. Service role only.';

-- (c) The judge: its quick read (the legacy mail that could be evidence, before the full
-- read) times each mail as the full read does, so a job whose reading predates a mail
-- this rule brought back is read in full and found due; and a never-read job whose
-- admitted rows are all CRM texts loaded from the cache is read in full (the evidence
-- leaves out such a text from before the job's lead window). Everything else word for word.
CREATE OR REPLACE FUNCTION public.context_ledger_judge(p_job_ids uuid[])
RETURNS TABLE(job_id uuid, due boolean, kind text, reason text, priority integer, newest_evidence_at timestamptz,
 evidence_rows integer, generation_id uuid, blocked_reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH s AS (
  SELECT coalesce((SELECT st.mode FROM public.context_ledger_settings st WHERE st.id), 'off') AS mode,
   (SELECT st.reader FROM public.context_ledger_settings st WHERE st.id) AS reader,
   (SELECT st.job_ids FROM public.context_ledger_settings st WHERE st.id) AS job_ids,
   public.automation_lane_enabled('extraction') AS lane,
   public.context_ledger_backfill_open((SELECT st.backfill_from_hour FROM public.context_ledger_settings st WHERE st.id),
    (SELECT st.backfill_to_hour FROM public.context_ledger_settings st WHERE st.id), now()) AS window_open
 ), j AS (
  SELECT jb.id, jb.status::text NOT IN ('cancelled','draft','archived','complete','completed','lost') AS live_job,
   coalesce(jb.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1') AS schedulable
  FROM public.jobs jb WHERE jb.id = ANY(p_job_ids)
 ), cur AS (
  SELECT j.id AS job_id, public.context_ledger_current_generation(j.id) AS gid FROM j
 ), g AS (
  SELECT c.job_id, gen.id, gen.status, gen.reader, gen.evidence_until, gen.created_at, gen.checks
  FROM cur c JOIN public.context_ledger_generations gen ON gen.id = c.gid
 ), cbe AS (
  -- The read every judgement can afford: the admitted business_events rows
  -- exactly (count and newest landed time, no text compare, no copy grouping)...
  SELECT e.job_id, count(*)::integer AS n,
   max(greatest(coalesce(e.context_captured_at, e.recorded_at, e.occurred_at), e.attributed_at)) AS newest,
   -- (CRM texts loaded later from the CRM's cache: one from before the job's lead window
   -- is not its evidence, story safety, 20261006040000)
   (count(*) FILTER (WHERE e.source = 'ghl_sms_cache_backfill'))::integer AS bf
  FROM j JOIN public.business_events e ON e.job_id = j.id
  WHERE j.live_job AND public.context_ledger_row_admissible(e) AND coalesce(e.event_at, e.occurred_at) <= now()
   AND greatest(coalesce(e.context_captured_at, e.recorded_at, e.occurred_at), e.attributed_at) <= now()
  GROUP BY e.job_id
 ), ibx AS (
  -- ...and the legacy mail that could be evidence, before its copy checks (a superset)...
  SELECT j.id AS job_id, i.id, coalesce(i.processed_at, i.received_at) AS landed
  FROM j JOIN public.inbox_events i ON i.job_id = j.id WHERE j.live_job AND i.received_at <= now()
  UNION ALL
  SELECT j.id, i.id, coalesce(i.processed_at, i.received_at)
  FROM j JOIN public.jobs jb ON jb.id = j.id
  JOIN public.inbox_events i ON lower(btrim(i.from_email)) = lower(nullif(btrim(jb.client_email), '')) AND i.job_id IS NULL
  WHERE j.live_job AND i.received_at <= now() AND i.received_at >= jb.created_at - interval '30 days'
   AND NOT (EXISTS (SELECT 1 FROM public.jobs o WHERE o.ghl_contact_id = nullif(btrim(jb.ghl_contact_id), '') AND o.id <> jb.id)
   OR EXISTS (SELECT 1 FROM public.jobs o WHERE o.client_email IS NOT NULL
    AND lower(btrim(o.client_email)) = lower(nullif(btrim(jb.client_email), '')) AND o.id <> jb.id))
 ), cpy AS MATERIALIZED (
  -- ...on a job with a reading, each no earlier than it can have joined the job's evidence,
  -- as the full read times it: a mail whose saved copy sits on another job or on no job
  -- joined no earlier than that rule's first apply and the copy's own landing (story
  -- safety, 20261006040000). A never-read job's judgement does not turn on it.
  SELECT c.mail_id, c.copy_job_id, c.joined_at
  FROM public.context_ledger_mail_copies(ARRAY(SELECT DISTINCT x.id FROM ibx x WHERE x.job_id IN (SELECT g.job_id FROM g))) c
 ), cib AS (
  SELECT x.job_id, count(DISTINCT x.id)::integer AS n, max(greatest(x.landed, c.joined_at)) AS newest
  FROM ibx x LEFT JOIN cpy c ON c.mail_id = x.id AND c.copy_job_id IS DISTINCT FROM x.job_id
  WHERE x.landed <= now()
  GROUP BY x.job_id
 ), need AS (
  -- The full evidence read (text, copies) only where it can change the judgement:
  -- a reading whose newest possible evidence is past its evidence_until, or a
  -- never-read job whose only possible evidence is legacy mail, or whose admitted rows
  -- are all CRM texts loaded from the cache (the evidence leaves out one from before the
  -- job's lead window, so it may hold none: story safety, 20261006040000).
  SELECT j.id FROM j LEFT JOIN g ON g.job_id = j.id LEFT JOIN cbe ON cbe.job_id = j.id LEFT JOIN cib ON cib.job_id = j.id
  WHERE j.live_job AND CASE WHEN g.id IS NULL THEN (coalesce(cbe.n, 0) = 0 AND coalesce(cib.n, 0) > 0)
                                                   OR (coalesce(cbe.n, 0) > 0 AND cbe.n = cbe.bf)
                            ELSE g.evidence_until IS NULL OR greatest(cbe.newest, cib.newest) > g.evidence_until END
 ), er AS MATERIALIZED (
  SELECT r.job_id, r.src_id, r.at, r.landed_at, r.copy_of
  FROM public.context_ledger_evidence_rows(ARRAY(SELECT need.id FROM need), now()) r
 ), ev AS (
  -- Exact where read in full; elsewhere the cheap read gives the same judgement
  -- (newest only ever overstates, by legacy copies, and stays at or before the
  -- reading's evidence_until; a count above zero stays above zero).
  SELECT j.id AS job_id,
   CASE WHEN nd.id IS NOT NULL THEN (SELECT max(r.landed_at) FROM er r WHERE r.job_id = j.id)
        ELSE greatest(cbe.newest, cib.newest) END AS newest,
   CASE WHEN nd.id IS NOT NULL THEN (SELECT (count(*) FILTER (WHERE r.copy_of IS NULL))::integer FROM er r WHERE r.job_id = j.id)
        ELSE coalesce(cbe.n, 0) + coalesce(cib.n, 0) END AS n
  FROM j LEFT JOIN need nd ON nd.id = j.id LEFT JOIN cbe ON cbe.job_id = j.id LEFT JOIN cib ON cib.job_id = j.id
  WHERE j.live_job
 ), moved AS (
  -- An item of the current generation citing a business_events row that is
  -- gone, on another job, or no longer admissible. A person-locked item is
  -- left out: a rebuild carries it straight back, so it waits for a person
  -- (the story says so) instead of looping.
  SELECT DISTINCT i.job_id FROM g JOIN public.context_ledger_items i ON i.generation_id = g.id AND NOT i.person_locked
  CROSS JOIN LATERAL jsonb_array_elements(i.opened_by || coalesce(i.closed_by, '[]'::jsonb)) c(cite)
  LEFT JOIN public.business_events b ON c.cite ->> 'table' = 'business_events'
   AND b.id = CASE WHEN c.cite ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (c.cite ->> 'id')::uuid END
  WHERE c.cite ->> 'table' = 'business_events'
   AND (b.id IS NULL OR b.job_id IS DISTINCT FROM i.job_id OR NOT public.context_event_source_admissible(b))
 ), answered AS (
  -- A newer passing reading by the current reader already answers a rebuild of
  -- the live one (it waits for promotion); one that failed its checks answers
  -- it only while the job backs off.
  SELECT DISTINCT g.job_id FROM g CROSS JOIN s
  JOIN public.context_ledger_generations n ON n.job_id = g.job_id AND n.status = 'shadow' AND n.reader = s.reader
   AND n.created_at > g.created_at AND public.context_ledger_checks_pass(n.checks)
  WHERE g.status = 'live'
 ), fnew AS (
  -- Where the unread evidence starts (the earliest row that landed after the reading).
  SELECT DISTINCT ON (r.job_id) r.job_id, r.at, r.src_id
  FROM er r JOIN g ON g.job_id = r.job_id
  WHERE r.copy_of IS NULL AND g.evidence_until IS NOT NULL AND r.landed_at > g.evidence_until
  ORDER BY r.job_id, r.at, r.src_id
 ), late AS (
  -- How much already-read evidence follows it (an update packet carries all of it).
  SELECT f.job_id, f.at AS first_new_at,
   (count(*) FILTER (WHERE r.copy_of IS NULL AND r.landed_at <= g.evidence_until AND (r.at, r.src_id) > (f.at, f.src_id)))::integer AS read_after
  FROM fnew f JOIN g ON g.job_id = f.job_id JOIN er r ON r.job_id = f.job_id
  GROUP BY f.job_id, f.at
 ), fail AS (
  SELECT f.* FROM public.context_ledger_failures(ARRAY(SELECT j.id FROM j)) f
 ), busy AS (
  SELECT j.id AS job_id,
   EXISTS (SELECT 1 FROM public.context_ledger_generations bg JOIN public.context_extraction_runs br ON br.id = bg.run_id
    WHERE bg.job_id = j.id AND bg.status = 'building' AND br.status = 'running' AND br.lease_expires_at > now()) AS building_live,
   EXISTS (SELECT 1 FROM public.context_ledger_generations bg LEFT JOIN public.context_extraction_runs br ON br.id = bg.run_id
    WHERE bg.job_id = j.id AND bg.status = 'building'
     AND coalesce(br.lease_expires_at, br.finished_at, bg.updated_at) > now() - interval '2 hours'
     AND NOT (br.status = 'running' AND br.lease_expires_at > now())) AS building_lapsed_recent,
   EXISTS (SELECT 1 FROM public.context_extraction_runs r WHERE r.job_id = j.id AND r.phase = 'ledger'
    AND r.status = 'running' AND r.lease_expires_at > now()) AS run_live
  FROM j
 ), judged AS (
  SELECT j.id AS job_id, ev.newest, coalesce(ev.n, 0) AS n, g.id AS gid,
   CASE WHEN g.id IS NULL THEN 'never_read'
    WHEN g.status = 'shadow' AND NOT public.context_ledger_checks_pass(g.checks) THEN 'checks_failed'
    WHEN m.job_id IS NOT NULL AND a.job_id IS NULL THEN 'citation_moved'
    WHEN g.reader IS DISTINCT FROM s.reader AND a.job_id IS NULL THEN 'reader_changed'
    WHEN g.evidence_until IS NULL OR g.evidence_until < ev.newest THEN
     CASE WHEN lt.first_new_at < g.evidence_until - interval '14 days' OR lt.read_after > 150 THEN 'late_evidence'
      ELSE 'new_evidence' END END AS reason,
   CASE WHEN s.mode = 'off' THEN 'ledger_off' WHEN NOT s.lane THEN 'lane_off'
    WHEN s.job_ids IS NOT NULL AND NOT (j.id = ANY(s.job_ids)) THEN 'not_in_rollout' WHEN NOT j.live_job THEN 'not_live'
    WHEN NOT j.schedulable THEN 'holding_job' WHEN coalesce(ev.n, 0) = 0 THEN 'no_evidence'
    WHEN b.building_live OR b.run_live THEN 'busy'
    WHEN f.needs_person THEN 'needs_person'
    WHEN f.backoff_until > now() OR b.building_lapsed_recent THEN 'backoff' END AS blocked
  FROM j CROSS JOIN s LEFT JOIN ev ON ev.job_id = j.id LEFT JOIN g ON g.job_id = j.id
  LEFT JOIN moved m ON m.job_id = j.id LEFT JOIN answered a ON a.job_id = j.id LEFT JOIN late lt ON lt.job_id = j.id
  LEFT JOIN fail f ON f.job_id = j.id LEFT JOIN busy b ON b.job_id = j.id
 )
 SELECT d.job_id, d.blk IS NULL AND d.reason IS NOT NULL,
  CASE WHEN d.reason IS NULL THEN NULL WHEN d.reason = 'never_read' THEN 'backfill' WHEN d.reason = 'new_evidence' THEN 'update'
   ELSE 'rebuild' END,
  d.reason,
  CASE d.reason WHEN 'citation_moved' THEN 1 WHEN 'new_evidence' THEN 1 WHEN 'late_evidence' THEN 1 WHEN 'never_read' THEN 2
   WHEN 'reader_changed' THEN 3 WHEN 'checks_failed' THEN 3 END,
  d.newest, d.n, d.gid, d.blk
 FROM (  -- backfills and rebuilds wait for the backfill hours; an update is never held
  SELECT d0.*, coalesce(d0.blocked, CASE WHEN NOT s.window_open AND d0.reason IS NOT NULL AND d0.reason <> 'new_evidence'
                                         THEN 'outside_window' END) AS blk
  FROM judged d0 CROSS JOIN s) d
$$;
COMMENT ON FUNCTION public.context_ledger_judge(uuid[]) IS
 'Context ledger store (20261006013000), story safety (20261006040000): a legacy mail whose saved copy sits on another job or on no job counts from when it can have joined the job''s evidence (context_ledger_mail_copies: no earlier than that rule''s first apply and the copy''s own landing), in the quick read (for a job with a reading) as in the full one, so a reading built before then is never taken to have read it and the job is due; a never-read job''s quick read is as before, except that a never-read job whose admitted rows are all CRM texts loaded from the cache (source ghl_sms_cache_backfill) is read in full, since the evidence leaves out one dated before the job''s lead window and so may hold none (then it is no_evidence, never a backfill of nothing). Earlier: the one ledger due judgement per job (the full evidence read only for a job whose reading may have newer evidence or whose only possible evidence is legacy mail; elsewhere a count and newest landed time of the admitted rows decide the same; evidence_rows is then that count): kind backfill (never_read), update (new_evidence: the current generation''s evidence_until is older than the newest admissible evidence), or rebuild (checks_failed: the current reading is a shadow whose checks.passed is false; citation_moved: an item cites a business_events row now gone, off the job or not admissible; reader_changed; late_evidence: the earliest unread row is more than 14 days older than evidence_until, or more than 150 already-read rows follow it). A rebuild of the live reading for a moved citation or a changed reader is not due while a newer passing shadow by the current reader waits for promotion. Blocked: ledger_off, lane_off, not_in_rollout (settings.job_ids is set and does not list the job), not_live, holding_job, no_evidence, busy (a live building generation or a running ledger run), needs_person (three builds in a row failed their checks: context_ledger_failures), backoff (consecutive failed or check-failed runs: 2 hours, 8 hours, the next Perth day, then 7 days; or a building generation that lost its lease in the last 2 hours), outside_window (a backfill or rebuild outside the settings backfill hours; an update is never held). A person-locked item is never a moved citation (a rebuild would carry it back). Service role only.';

-- 9. Access: service role only (CREATE OR REPLACE keeps a replaced function's grants; said again).
REVOKE ALL ON FUNCTION public.context_job_record_legacy_mail(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_record_messages(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_record_timeline(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_record_loops(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_record_money(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_record_contact(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story_facts(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story_meta(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story_assemble(jsonb, jsonb, jsonb, jsonb, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_client_story(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_evidence_rows(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_cite(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_judge(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_mail_rule_since() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_mail_copies(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_record_crm_time(text, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_record_payer_role(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_record_bill_share(text, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_record_value(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story_day(date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_crm_message_times_keep() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_record_legacy_mail(uuid[], timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_record_messages(uuid[], timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_record_timeline(uuid[], timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_record_loops(uuid[], timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_record_money(uuid[], timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_record_contact(uuid[], timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story_facts(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story_meta(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story_assemble(jsonb, jsonb, jsonb, jsonb, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_client_story(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_evidence_rows(uuid[], timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_cite(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_judge(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_mail_rule_since() TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_mail_copies(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_record_crm_time(text, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_record_payer_role(uuid, text, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_record_bill_share(text, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_record_value(uuid[], timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story_day(date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_crm_message_times_keep() TO service_role;
