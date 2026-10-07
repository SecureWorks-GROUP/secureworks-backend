-- Ledger reader fixes (7 Oct 2026): the store gives the reader the customer's own calls, the
-- client's other jobs and the paid day, and refuses an item that puts a row on someone else on the
-- reader's word alone.
--
-- Why. The go-live grade of the 29 proof jobs (7 Oct, part A) found 6 unsafe lines. 4 of them
-- (SWP-26183, SWF-261486, SWP-261178, SWF-261305) have one cause: context_ledger_call_customer
-- returned null when a transcript's call stamp was not on the same job (a transcribe-call
-- transcript's ghl_call_id is <contact>:<instant> and names no call row; SWF-261305's call row sits
-- unplaced with basis any_job_customer, its client having a second job), and the citation check read
-- null as false, so both readers said the customer's own call belonged to someone else, another job
-- or a lead, and left the customer's words from_role unknown. Two more held jobs read a quote or an
-- invoice as missing because it was sent on the same client's other job (SWF-261501's quote on
-- SWF-261521) or billed on the same work order's other job (SWMS-261415's hire on SWMS-261014): the
-- packet showed no sibling job. And SWP-26373's upfront payment stayed the customer's open move
-- although its invoice was paid the day it was asked for: a payment closed at its paid day's Perth
-- midnight, before a request made later that day, so the store refused the close
-- (closing_before_opening).
--
-- What it does:
--  1. context_ledger_call_customer: a call row on the transcript's job still decides first (true on
--     its customer stamp, false without it). When none names the transcript, the transcript's own
--     who-to-whom stamp decides: counterpart customer on the job_customer basis, with the row's CRM
--     contact the job's own (jobs.ghl_contact_id), is the customer's call. Otherwise null, which the
--     packet gives the reader as "unknown". The citation check (customer_sender), the evidence rows
--     and the packet all read it here.
--  2. context_ledger_elsewhere_claim(what): whether an item's words say a row belongs to another
--     person, another job or a lead (labelled, marked, linked or filed as someone else's; a customer
--     of another job; another job or a lead; misfiled; belongs to, concerns or is about another job;
--     not from this job's customer). One case-insensitive pattern written so PostgreSQL (~*) and
--     JavaScript (new RegExp(pattern, 'i')) read it alike: the reader mirrors it.
--  3. context_ledger_row_elsewhere(job, table, id): whether a row's own placement or role basis says
--     it is someone else's, and why: role_basis:<basis> (its who-to-whom basis is set and is not
--     job_customer, no_match, no_contact or error), call_not_customer (a transcript whose call row on
--     this job is stamped otherwise), call_on_other_job (a transcript whose call row sits on another
--     job), sender_not_client (old-inbox mail from an address other than the job's client email),
--     names_other_job:<number> (its own words name another job's reference and none of this job's,
--     by the placement keys); else null. A record row never.
--  4. context_ledger_check_item refuses a model item whose words say a row belongs to another person,
--     job or lead unless one of its cited rows, opening or closing, is someone else's by (3): the new
--     refusal code elsewhere_unsupported. A person's own item is their word.
--  5. The packet (still ledger-packet-v1, fields only added): each transcript's call_customer is true,
--     false or "unknown", never a bare null; each evidence row carries elsewhere, (3)'s reason or
--     null; and siblings (context_ledger_siblings): the same client's other jobs (the same CRM contact,
--     or the same client email when it is not ours) and the same work order's other jobs
--     (context_ledger_work_order_key: the builder's work order in the make-safe reference without its
--     purchase order part, the same requesting company when both name one), never by name alone,
--     never a holding job, at most 8, each with its number, status, type, how it matched, its quotes
--     sent (up to 4: number, version, sent_at, total_inc_gst, accepted_at, declined_at) and its issued
--     customer invoices (up to 6: number, reference, status, invoice_date, total, amount_due, paid_on,
--     up to 6 lines), all as of the packet's as_of. A sibling's rows are context, never this job's
--     citations.
--  6. A payment item closes on a PAID invoice at the end of its paid Perth day, never after now
--     (context_ledger_paid_close_at), whatever the invoice's date, in an item (check_item) and in a
--     transition (write): a request made the day it was paid is closed by that payment; a paid day
--     before the request's day still never closes it.
--
-- Read only on production (7 Oct 2026, about 21:00 Perth; 472 current readings, all shadow):
--  - (1) 62 transcripts on 51 readings go from null to the customer's call; 1 transcript on 1
--    reading reads "unknown". 83 items on 37 readings cite such a transcript; 48 of them (27
--    readings) open on it with from_role unknown.
--  - (4) 30 items say a row belongs elsewhere: 8 stand on a cited row the rule accepts
--    (role_basis 4, names_other_job 2, call_on_other_job 1, sender_not_client 1); 22 items on 21
--    readings would be refused on a rebuild, the 4 unsafe lines among them.
--  - (5) 215 readings are on a job with a sibling (307 links); on 186 a sibling has a quote sent or
--    an invoice issued; 45 of those hold 85 open quote, invoice or payment items it may bear on.
--    Over the 499 rollout jobs the section is 281 bytes on average (596 with a sibling, at most
--    2,798; never more than 7 siblings) and its matching takes about 1 ms a job.
--  - (6) 67 open payment items on 45 readings; 5 on 3 readings have an invoice on the job paid the
--    Perth day the item opened (each refused before); 12 more one paid on a later day.
--
-- Replaced bodies (each guarded on its live production md5, the 20261006013000 bodies):
--   context_ledger_call_customer, context_ledger_check_item, context_ledger_write (one line),
--   context_ledger_packet. Added: context_ledger_elsewhere_claim, context_ledger_paid_close_at,
--   context_ledger_work_order_key, context_ledger_row_elsewhere, context_ledger_siblings.
-- Not changed: context_ledger_cite (its customer_sender reads (1)), the evidence rows, the judge,
--   due, claim, finish, the story, the record layer and every scorecard function. No row, flag or
--   setting is written. Signatures, volatility, owners and grants stay; comments keep their slice
--   name first.
-- Query shape: per transcript one more read of its job's CRM contact (by key); the packet reads per
--   evidence row that row by key, a transcript's call row by its unique provider key and the job
--   references its words name (context_ref_jobs, by indexed keys), the job's siblings by the jobs
--   indexes on ghl_contact_id and lower(btrim(client_email)) and the make-safe details, and each
--   sibling's quotes, quote revisions and invoices by job; the item check reads (3) only for an item
--   whose words make the claim.
-- Rollback: supabase/rollbacks/20261007150000_context_ledger_reader_fixes_down.sql (the four
--   20261006013000 bodies and comments word for word; the five helpers dropped; no row touched).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[] := '{}'; live text; x record; f text; t text;
BEGIN
 -- The four replaced bodies: the 20261006013000 bodies production runs, or this migration's (re-apply).
 FOR x IN SELECT * FROM (VALUES
  ('public.context_ledger_call_customer(public.business_events)', ARRAY['23f31463321396e3e5fde6329e32c60e', 'cd1cda0bb5bd1c5405001a1d6b670d5f']),
  ('public.context_ledger_check_item(uuid,jsonb,text,uuid,text)', ARRAY['52bd1db9fb4b75fedd6cbfc755e806b3', '76de45b9ee5c823593fb4b3fded873e3']),
  ('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)', ARRAY['7afbf2bbe6d5688219e743fda88b5eb2', '6da1007ff2a6331219f4d98f85749ca7']),
  ('public.context_ledger_packet(uuid,timestamptz,timestamptz)', ARRAY['86bed4277fb61ce4679e5cd476001555', '423469bdff01ae4029c155f6c73c078d'])
 ) AS v(sig, accepted) LOOP
  live := NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY(x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 -- Read, never replaced: these must exist with these signatures.
 FOREACH f IN ARRAY ARRAY['public.context_ledger_cite(uuid,jsonb)', 'public.context_ledger_evidence_rows(uuid[],timestamptz)',
  'public.context_ledger_current_generation(uuid)', 'public.context_ledger_party_keys(text[],text[],text[])',
  'public.context_ledger_row_admissible(public.business_events)', 'public.context_ledger_job_event_closes(text,text)',
  'public.context_ledger_email_closes(text,text)', 'public.context_supported_due_date(text,timestamptz)',
  'public.context_event_text(public.business_events)', 'public.context_email_key(text)',
  'public.context_job_ref_tokens(text)', 'public.context_ref_jobs(text[])', 'public.automation_lane_enabled(text)'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 -- The columns the new reads take.
 FOREACH t IN ARRAY ARRAY['business_events.contact_id', 'business_events.provider_message_id', 'business_events.metadata',
   'jobs.ghl_contact_id', 'jobs.client_email', 'jobs.metadata', 'jobs.job_number', 'jobs.status', 'jobs.type', 'jobs.created_at',
   'inbox_events.from_email', 'inbox_events.subject', 'inbox_events.body_preview',
   'makesafe_job_details.external_ref', 'makesafe_job_details.requesting_company_slug',
   'job_documents.quote_number', 'job_documents.version', 'job_documents.sent_at', 'job_documents.accepted_at',
   'job_documents.declined_at', 'quote_revisions.job_document_id', 'quote_revisions.version', 'quote_revisions.sent_at',
   'quote_revisions.totals_snapshot_json', 'xero_invoices.invoice_type', 'xero_invoices.invoice_number', 'xero_invoices.reference',
   'xero_invoices.status', 'xero_invoices.invoice_date', 'xero_invoices.total', 'xero_invoices.amount_due',
   'xero_invoices.fully_paid_on', 'xero_invoices.line_items', 'xero_invoices.created_at', 'xero_invoices.synced_at'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || split_part(t, '.', 1))
    AND a.attname = split_part(t, '.', 2) AND NOT a.attisdropped) THEN
   problems := problems || format('public.%s missing', t);
  END IF;
 END LOOP;
 -- New objects: absent, or this migration's (comment marker).
 FOR x IN SELECT p.oid::regprocedure::text AS sig, coalesce(obj_description(p.oid, 'pg_proc'), '') AS c
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('context_ledger_elsewhere_claim', 'context_ledger_paid_close_at', 'context_ledger_work_order_key',
    'context_ledger_row_elsewhere', 'context_ledger_siblings') LOOP
  IF x.c NOT LIKE 'Ledger reader fixes (20261007150000)%' THEN
   problems := problems || format('%s exists and is not this migration''s', x.sig);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_ledger_reader_fixes_preimage_mismatch: %; read the live definitions before replacing them',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. Whether an item's words say a row belongs to another person, another job or a lead. One
-- pattern, read case-insensitively, written with nothing PostgreSQL (~*) and JavaScript
-- (new RegExp(pattern, 'i')) read differently (no \m, \M, \y or \b; words are bounded by
-- (^|[^a-z0-9]) and ([^a-z0-9]|$)), so a reader can mirror it character for character.
CREATE OR REPLACE FUNCTION public.context_ledger_elsewhere_claim(p_what text) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT coalesce(p_what ~* '((^|[^a-z0-9])belong(s|ed|ing)?\s+(to|with)\s+((another|a\s+different|a\s+separate|the\s+wrong)|someone|somebody|that\s+(job|customer|client)|((the\s+)?(client|customer)[''’]?s\s+other|(their|his|her)\s+other))([^a-z0-9]|$))|((^|[^a-z0-9])(relates?|related|relating|concerns?|concerned|concerning|refers?|referring|(is|are|was|were|be|been|being)\s+(about|for|from)|comes?\s+from|came\s+from|meant\s+for|intended\s+for)\s+(to\s+)?((another|a\s+different|a\s+separate|the\s+wrong)|((the\s+)?(client|customer)[''’]?s\s+other|(their|his|her)\s+other))\s+(job|customer|client|contact|person|caller|lead|property|site)([^a-z0-9]|$))|((^|[^a-z0-9])(labell?ed|marked|linked|filed|stored|saved|logged|recorded|tagged|stamped|attributed|assigned|attached|placed|shown|listed)\s+(as\s+)?(coming\s+)?((from|to|on|against|under|with|for)\s+)?(a\s+customer\s+of\s+)?((another|a\s+different|a\s+separate|the\s+wrong)\s+(job|customer|client|contact|person|caller|lead|property|site)|(someone|somebody)\s+(other|else))([^a-z0-9]|$))|((^|[^a-z0-9])mis-?(filed|labell?ed|attributed|linked|addressed|directed)([^a-z0-9]|$))|((^|[^a-z0-9])(customer|client)\s+of\s+(another|a\s+different|the\s+wrong|an\s+other|other)\s+jobs?([^a-z0-9]|$))|((^|[^a-z0-9])(another|other)\s+job[''’]?s\s+(customer|client)([^a-z0-9]|$))|((^|[^a-z0-9])(another|other)\s+jobs?\s+or\s+(a\s+)?leads?([^a-z0-9]|$))|((^|[^a-z0-9])not\s+(from|to|with|by)\s+(this|the)\s+(job[''’]?s\s+)?(customer|client)([^a-z0-9''’]|$))|((^|[^a-z0-9])not\s+(this|the)\s+job[''’]?s\s+(customer|client)([^a-z0-9]|$))|((^|[^a-z0-9])(someone|somebody)\s+other\s+than\s+(this|the)\s+(job[''’]?s\s+)?(customer|client)([^a-z0-9]|$))', false)
$$;
COMMENT ON FUNCTION public.context_ledger_elsewhere_claim(text) IS
 'Ledger reader fixes (20261007150000): whether an item''s words say a row belongs to another person, another job or a lead: belongs to another job, someone, that job or the client''s other job; relates to, concerns, is about, is for or is from another (or a different, a separate, the wrong, the client''s other) job, customer, client, contact, person, caller, lead, property or site; labelled, marked, linked, filed, stored, saved, logged, recorded, tagged, stamped, attributed, assigned, attached, placed, shown or listed as from another job (or a customer of another job, someone other or else); misfiled, mislabelled, misattributed, mislinked, misaddressed, misdirected; a customer of another job; another job''s customer; another job or a lead; not from (to, with, by) this job''s customer; not this job''s customer; someone other than this customer. Case-insensitive; the pattern is written so PostgreSQL ~* and JavaScript new RegExp(pattern, ''i'') read it alike. context_ledger_check_item refuses such a model item (elsewhere_unsupported) unless a cited row is someone else''s by context_ledger_row_elsewhere. Service role only.';

-- 2. When a PAID invoice closes a payment item: at the end of its paid Perth day (the citation
-- check's paid_at is that day's Perth midnight, never after now), never after now. A paid record is a
-- day, so a request made on the day the invoice was paid is closed by it; a paid day before the
-- request's day still is not.
CREATE OR REPLACE FUNCTION public.context_ledger_paid_close_at(p_paid_at timestamptz) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT CASE WHEN p_paid_at IS NOT NULL
  THEN least((((p_paid_at AT TIME ZONE 'Australia/Perth')::date + 1)::timestamp AT TIME ZONE 'Australia/Perth') - interval '1 second', now()) END
$$;
COMMENT ON FUNCTION public.context_ledger_paid_close_at(timestamptz) IS
 'Ledger reader fixes (20261007150000): the instant a PAID invoice closes a payment item (closes_on payment), from the citation check''s paid_at (the paid day''s Perth midnight, never after now): the end of that Perth day (23:59:59), never after now; null when paid_at is null (not PAID, or no paid day). Read by context_ledger_check_item (closed_by) and context_ledger_write (a transition''s evidence), so a request made on the day its invoice was paid is closed by it, whatever the invoice''s date. Service role only.';

-- 3. A builder's work order, from a make-safe external reference: its letters and digits in upper
-- case without a trailing purchase order part, MLB's RR and MW scopes read as MLB (one scope, as
-- the instruction key ruling has it): MLB-12345PO-67890, MLB-12345PO-RET14 and MLB-RR-12345 are
-- all MLB12345; AJBR 70001 and AJBR-70001 are AJBR70001; PO20001 stays PO20001. At least 5
-- characters with a digit, else null. A grouping for the reader's context, never an identity:
-- it places, bills and keys nothing.
CREATE OR REPLACE FUNCTION public.context_ledger_work_order_key(p_ref text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT CASE WHEN k.v ~ '[0-9]' AND length(k.v) >= 5 THEN k.v END
 FROM (SELECT regexp_replace(upper(regexp_replace(regexp_replace(btrim(coalesce(p_ref, '')), '^MLB[-\s]*(RR|MW)[-\s]*', 'MLB-', 'i'),
              '([0-9])\s*-?\s*PO\s*[-#:]?\s*[A-Z0-9]+$', '\1', 'i')), '[^A-Z0-9]+', '', 'g') AS v) k
$$;
COMMENT ON FUNCTION public.context_ledger_work_order_key(text) IS
 'Ledger reader fixes (20261007150000): the work order a make-safe external reference (makesafe_job_details.external_ref) names: its letters and digits in upper case after a trailing purchase order part that follows a digit is taken off, with MLB''s RR and MW scopes read as MLB (MLB-12345PO-67890, MLB-12345PO-RET14 and MLB-RR-12345 are MLB12345; AJBR 70001 is AJBR70001; PO20001 stays PO20001); null unless at least 5 characters with a digit. A grouping for the reader''s context only, never an identity: it places, bills and keys nothing. Read by context_ledger_siblings. Service role only.';

-- 4. Whether a row's own placement or role basis says it is someone else's, and why. The one rule
-- the citation check's item rule (elsewhere_unsupported) and the packet's per-row elsewhere read.
CREATE OR REPLACE FUNCTION public.context_ledger_row_elsewhere(p_job_id uuid, p_table text, p_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e public.business_events; i record; v_cmail text; v_text text; v_basis text; v_call text; v_call_job uuid;
 v_other text; v_this boolean;
BEGIN
 IF p_job_id IS NULL OR p_id IS NULL THEN RETURN NULL; END IF;
 IF p_table = 'business_events' THEN
  SELECT * INTO e FROM public.business_events b WHERE b.id = p_id;
  IF e.id IS NULL OR e.job_id IS DISTINCT FROM p_job_id THEN RETURN NULL; END IF;
  -- its who-to-whom stamp names someone other than this job's customer: every basis but
  -- job_customer and the ones that know nobody (no_match, no_contact, error)
  v_basis := e.metadata #>> '{party_roles,basis}';
  IF v_basis IS NOT NULL AND v_basis NOT IN ('job_customer', 'no_match', 'no_contact', 'error') THEN
   RETURN 'role_basis:' || left(v_basis, 40);
  END IF;
  IF e.event_type = 'call.transcript_completed' THEN
   -- a transcript whose call row on this job is stamped with someone else
   IF public.context_ledger_call_customer(e) IS FALSE THEN RETURN 'call_not_customer'; END IF;
   -- a transcript whose call row is placed on another job (one row holds a provider key)
   v_call := coalesce(nullif(btrim(e.payload ->> 'ghl_call_id'), ''),
    CASE WHEN e.provider_message_id LIKE 'ghltx:%' THEN substr(e.provider_message_id, 7) END);
   IF v_call IS NOT NULL THEN
    SELECT c.job_id INTO v_call_job FROM public.business_events c
    WHERE c.provider_message_id = 'ghl:' || v_call AND c.event_type <> 'call.transcript_completed';
    IF v_call_job IS NOT NULL AND v_call_job <> p_job_id THEN RETURN 'call_on_other_job'; END IF;
   END IF;
  END IF;
  v_text := concat_ws(' ', e.payload ->> 'subject', public.context_event_text(e));
 ELSIF p_table = 'inbox_events' THEN
  SELECT x.from_email, x.subject, x.body_preview INTO i FROM public.inbox_events x WHERE x.id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- old-inbox mail from an address other than the job's client email
  SELECT lower(nullif(btrim(j.client_email), '')) INTO v_cmail FROM public.jobs j WHERE j.id = p_job_id;
  IF v_cmail IS NOT NULL AND nullif(btrim(i.from_email), '') IS NOT NULL AND lower(btrim(i.from_email)) <> v_cmail THEN
   RETURN 'sender_not_client';
  END IF;
  v_text := concat_ws(' ', i.subject, i.body_preview);
 ELSE
  RETURN NULL;  -- a record row is this job's own record
 END IF;
 -- its own words name another job's reference and none of this job's (the placement keys'
 -- references: job numbers, ACCREC invoice numbers, purchase order numbers; never a holding job)
 SELECT min(rj.job_number COLLATE "C") FILTER (WHERE r.job_id <> p_job_id), coalesce(bool_or(r.job_id = p_job_id), false)
 INTO v_other, v_this
 FROM public.context_ref_jobs(public.context_job_ref_tokens(v_text)) r JOIN public.jobs rj ON rj.id = r.job_id;
 IF v_other IS NOT NULL AND NOT v_this THEN RETURN 'names_other_job:' || left(v_other, 40); END IF;
 RETURN NULL;
END $$;
COMMENT ON FUNCTION public.context_ledger_row_elsewhere(uuid, text, uuid) IS
 'Ledger reader fixes (20261007150000): whether a row''s own placement or role basis says it is someone else''s (another person, another job or a lead), and why; null when nothing about the row says so (a record row, or a business_events row that is not this job''s, never). role_basis:<basis> (a business_events row whose party_roles basis is set and is not job_customer, no_match, no_contact or error: another job''s customer or party, a lead, a supplier, a builder, a council, our own people); call_not_customer (a call transcript whose call row on this job is stamped with someone other than the job''s customer: context_ledger_call_customer false); call_on_other_job (a call transcript whose call row, ghl:<id>, sits on another job); sender_not_client (old-inbox mail from an address other than the job''s client email, when it has one); names_other_job:<job number> (its own words name another job''s reference and none of this job''s, by the placement keys context_job_ref_tokens and context_ref_jobs, C order). Read by context_ledger_check_item (an item saying a row belongs to someone else stands only on such a row: elsewhere_unsupported) and the packet (each evidence row''s elsewhere). Service role only.';

-- 5. The same client's and the same work order's other jobs, for the reader: what was quoted and
-- billed there, so a quote sent or an invoice raised on the sibling never reads as missing here.
CREATE OR REPLACE FUNCTION public.context_ledger_siblings(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH jb AS (
  SELECT j.id, nullif(btrim(j.ghl_contact_id), '') AS contact,
   -- a client email that is ours (our domains, our lines) is no client's
   CASE WHEN public.context_email_key(j.client_email) IS NOT NULL THEN lower(btrim(j.client_email)) END AS email,
   (SELECT public.context_ledger_work_order_key(d.external_ref) FROM public.makesafe_job_details d WHERE d.job_id = j.id) AS wo,
   (SELECT nullif(btrim(d.requesting_company_slug), '') FROM public.makesafe_job_details d WHERE d.job_id = j.id) AS slug
  FROM public.jobs j WHERE j.id = p_job_id
 ), hit AS (  -- matched by CRM contact, client email or work order, never by name alone
  SELECT o.id, 'contact'::text AS how FROM jb JOIN public.jobs o ON o.ghl_contact_id = jb.contact
  WHERE jb.contact IS NOT NULL AND o.id <> jb.id
  UNION ALL
  SELECT o.id, 'email' FROM jb JOIN public.jobs o ON lower(btrim(o.client_email)) = jb.email
  WHERE jb.email IS NOT NULL AND o.id <> jb.id
  UNION ALL
  SELECT d.job_id, 'work_order' FROM jb JOIN public.makesafe_job_details d ON d.job_id <> jb.id
   AND public.context_ledger_work_order_key(d.external_ref) = jb.wo
   AND (jb.slug IS NULL OR nullif(btrim(d.requesting_company_slug), '') IS NULL OR nullif(btrim(d.requesting_company_slug), '') = jb.slug)
  WHERE jb.wo IS NOT NULL
 ), sib AS (
  SELECT o.id, o.job_number, o.status::text AS status, o.type::text AS type, o.created_at,
   array_agg(DISTINCT h.how COLLATE "C" ORDER BY h.how COLLATE "C") AS how, bool_or(h.how IN ('contact', 'email')) AS same_client
  FROM hit h JOIN public.jobs o ON o.id = h.id
  WHERE coalesce(o.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1') AND o.created_at <= p_as_of
  GROUP BY o.id, o.job_number, o.status, o.type, o.created_at
 ), ranked AS (  -- the same client's first, then the same work order's; newest first
  SELECT s.*, row_number() OVER (ORDER BY s.same_client DESC, s.created_at DESC, s.id) AS n FROM sib s
 )
 SELECT jsonb_build_object(
  'jobs', coalesce(jsonb_agg(jsonb_build_object('job_number', r.job_number, 'status', r.status, 'type', r.type,
    'matched_by', to_jsonb(r.how),
    -- its quotes sent by p_as_of, newest first: the amount is its quote revision's total
    'quotes_sent', (SELECT coalesce(jsonb_agg(jsonb_build_object('number', q.quote_number, 'version', q.version, 'sent_at', q.sent_at,
                      'total_inc_gst', q.total, 'accepted_at', q.accepted_at, 'declined_at', q.declined_at) ORDER BY q.sent_at DESC, q.id), '[]'::jsonb)
                    FROM (SELECT d.id, d.quote_number, d.version, d.sent_at,
                           CASE WHEN d.accepted_at <= p_as_of THEN d.accepted_at END AS accepted_at,
                           CASE WHEN d.declined_at <= p_as_of THEN d.declined_at END AS declined_at,
                           (SELECT CASE WHEN jsonb_typeof(qr.totals_snapshot_json -> 'total_inc_gst') = 'number' THEN qr.totals_snapshot_json -> 'total_inc_gst' END
                            FROM public.quote_revisions qr WHERE qr.job_document_id = d.id
                            ORDER BY qr.version DESC NULLS LAST, qr.sent_at DESC NULLS LAST, qr.id LIMIT 1) AS total
                          FROM public.job_documents d
                          WHERE d.job_id = r.id AND d.type ILIKE '%quote%' AND d.sent_at <= p_as_of
                          ORDER BY d.sent_at DESC, d.id LIMIT 4) q),
    -- its issued customer invoices made by p_as_of, newest first, each with its first lines
    'invoices', (SELECT coalesce(jsonb_agg(jsonb_build_object('number', v.invoice_number, 'reference', v.reference, 'status', v.st,
                   'invoice_date', v.invoice_date, 'total', v.total, 'amount_due', v.amount_due, 'paid_on', v.paid_on, 'lines', v.lines)
                   ORDER BY v.invoice_date DESC NULLS LAST, v.id), '[]'::jsonb)
                 FROM (SELECT x.id, x.invoice_number, x.reference, upper(x.status) AS st, x.invoice_date, x.total, x.amount_due,
                        CASE WHEN upper(x.status) = 'PAID' AND x.fully_paid_on <= (p_as_of AT TIME ZONE 'Australia/Perth')::date
                             THEN x.fully_paid_on END AS paid_on,
                        (SELECT coalesce(jsonb_agg(jsonb_build_object('what', left(btrim(l.li ->> 'Description'), 90),
                           'amount', CASE WHEN jsonb_typeof(l.li -> 'LineAmount') = 'number' THEN l.li -> 'LineAmount' END) ORDER BY l.o), '[]'::jsonb)
                         FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.line_items) = 'array' THEN x.line_items ELSE '[]'::jsonb END)
                          WITH ORDINALITY l(li, o)
                         WHERE l.o <= 6) AS lines
                       FROM public.xero_invoices x
                       WHERE x.job_id = r.id AND upper(coalesce(x.invoice_type, 'ACCREC')) = 'ACCREC'
                        AND upper(coalesce(x.status, '')) IN ('AUTHORISED', 'SUBMITTED', 'PAID')
                        AND coalesce(x.created_at, x.synced_at, '-infinity'::timestamptz) <= p_as_of
                       ORDER BY x.invoice_date DESC NULLS LAST, x.id LIMIT 6) v))
   ORDER BY r.n) FILTER (WHERE r.n <= 8), '[]'::jsonb),
  'more', count(*) FILTER (WHERE r.n > 8))
 FROM ranked r
$$;
COMMENT ON FUNCTION public.context_ledger_siblings(uuid, timestamptz) IS
 'Ledger reader fixes (20261007150000): the packet''s siblings section, {jobs, more}: the same client''s other jobs (the same CRM contact, or the same client email when it is not ours: context_email_key) and the same work order''s other jobs (context_ledger_work_order_key of makesafe_job_details.external_ref, the same requesting company when both name one), never by name alone, never a holding job (do_not_schedule), created by p_as_of; the same client''s first, then newest first, at most 8 (more: how many were left out). Each: job_number, status and type (as they are now), matched_by (contact, email, work_order; C order), quotes_sent (up to 4 sent by p_as_of, newest first: number, version, sent_at, total_inc_gst from its newest quote revision or null, accepted_at and declined_at by p_as_of) and invoices (up to 6 issued customer invoices made by p_as_of, AUTHORISED, SUBMITTED or PAID, newest first: number, reference, status and amount_due as Xero holds them now, invoice_date, total, paid_on when PAID by p_as_of''s Perth day, and up to 6 lines: what, at most 90 characters, and amount). Context for the reader only: a sibling''s rows are never this job''s citations. Service role only.';

-- 6. The customer's call: its call row on the job, else its own stamp on the job's contact.
CREATE OR REPLACE FUNCTION public.context_ledger_call_customer(e public.business_events) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN e.event_type OPERATOR(pg_catalog.=) 'call.transcript_completed' THEN
  coalesce(
  (SELECT pg_catalog.bool_or(coalesce(c.metadata OPERATOR(pg_catalog.#>>) '{party_roles,counterpart_role}' OPERATOR(pg_catalog.=) 'customer'
     AND c.metadata OPERATOR(pg_catalog.#>>) '{party_roles,basis}' OPERATOR(pg_catalog.=) 'job_customer', false))
   FROM public.business_events c
   WHERE c.job_id OPERATOR(pg_catalog.=) e.job_id
    AND c.event_type OPERATOR(pg_catalog.<>) 'call.transcript_completed'
    AND c.provider_message_id OPERATOR(pg_catalog.=) ('ghl:' OPERATOR(pg_catalog.||) coalesce(e.payload OPERATOR(pg_catalog.->>) 'ghl_call_id',
     CASE WHEN e.provider_message_id OPERATOR(pg_catalog.~~) 'ghltx:%' THEN pg_catalog.substr(e.provider_message_id, 7) END))),
  -- (ledger reader fixes, 20261007150000) no call row on this job names it (a transcribe-call
  -- transcript's ghl_call_id is <contact>:<instant>; a call row may sit unplaced or on another job):
  -- the transcript's own stamp decides, the job's customer only on the job_customer basis with the
  -- row's CRM contact the job's own; else null (unknown)
  CASE WHEN e.metadata OPERATOR(pg_catalog.#>>) '{party_roles,counterpart_role}' OPERATOR(pg_catalog.=) 'customer'
        AND e.metadata OPERATOR(pg_catalog.#>>) '{party_roles,basis}' OPERATOR(pg_catalog.=) 'job_customer'
        AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id OPERATOR(pg_catalog.=) e.job_id
                    AND e.contact_id OPERATOR(pg_catalog.=) nullif(pg_catalog.btrim(j.ghl_contact_id), ''))
       THEN true END) END
$$;
COMMENT ON FUNCTION public.context_ledger_call_customer(public.business_events) IS
 'Context ledger store (20261006013000), ledger reader fixes (20261007150000): when no call row on the transcript''s job names it (a transcribe-call transcript''s ghl_call_id is <contact>:<instant> and names no call row; a call row may sit unplaced, its basis any_job_customer, or on another job), the transcript''s own stamp decides: true when it is counterpart_role customer with basis job_customer and the row''s CRM contact is the job''s own (jobs.ghl_contact_id); else null, which the packet gives the reader as unknown. Earlier: whether a call transcript is the customer''s words, on its call''s stamp: true when the linked call row on the same job (ghl:<payload.ghl_call_id>, else ghl:<id> from the transcript''s own key ghltx:<id>) is stamped counterpart_role customer with basis job_customer, false when a linked call row exists without that stamp, null when none is linked or the row is not a transcript. Read by context_ledger_cite (customer_sender), the evidence rows, the packet (call_customer) and context_ledger_row_elsewhere. A plain helper (no SET, not a definer, not inlined: it has subqueries). Service role only.';

-- 7. The item check: the elsewhere rule and the paid day.
CREATE OR REPLACE FUNCTION public.context_ledger_check_item(p_job_id uuid, p_item jsonb, p_writer text, p_person uuid DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_type text; v_status text; v_from text; v_to text; v_what text; v_about text; v_due date; v_basis text;
 v_open jsonb := '[]'; v_close jsonb := '[]'; c jsonb; chk jsonb; n integer := 0; v_opened_at timestamptz; v_closed_at timestamptz;
 v_any_customer boolean := false; v_any_us boolean := false; v_any_external boolean := false; v_due_ok boolean := false;
 v_first_customer boolean; v_first_us boolean; v_close_at timestamptz;
 v_key text; v_first text; v_facts jsonb := '[]'; f jsonb; v_supported date;
 roles constant text[] := ARRAY['us','crew','customer','supplier','insurer_builder','third_party','unknown'];
BEGIN
 IF p_item IS NULL OR jsonb_typeof(p_item) <> 'object' THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'an item is a JSON object');
 END IF;
 IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_item) k WHERE k NOT IN ('ref','item_type','status','from_role','from_name','to_role',
   'to_name','what','about_key','modality','phase','due_date','due_basis','opened_by','closed_by','closes_on','supersedes_key',
   'supersedes_ref','blocks','needs_reply','also_concerns')) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'unknown field '
   || (SELECT min(k COLLATE "C") FROM jsonb_object_keys(p_item) k WHERE k NOT IN ('ref','item_type','status','from_role','from_name','to_role',
   'to_name','what','about_key','modality','phase','due_date','due_basis','opened_by','closed_by','closes_on','supersedes_key',
   'supersedes_ref','blocks','needs_reply','also_concerns')));
 END IF;
 IF EXISTS (SELECT 1 FROM jsonb_each(p_item) kv WHERE kv.key NOT IN ('opened_by','closed_by','needs_reply')
   AND jsonb_typeof(kv.value) NOT IN ('string','null')) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'text fields must be strings or null');
 END IF;
 v_type := p_item ->> 'item_type'; v_status := p_item ->> 'status'; v_from := p_item ->> 'from_role';
 v_to := nullif(p_item ->> 'to_role', '');
 -- the ledger's own words carry no em or en dashes (they reach outbound text)
 v_what := btrim(replace(regexp_replace(coalesce(p_item ->> 'what', ''), '\s*' || chr(8212) || '\s*', ', ', 'g'), chr(8211), '-'));
 v_about := nullif(btrim(p_item ->> 'about_key'), ''); v_basis := coalesce(nullif(p_item ->> 'due_basis', ''), 'none');
 IF p_writer = 'model' AND coalesce(length(btrim(p_item ->> 'ref')), 0) NOT BETWEEN 1 AND 60 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'ref is 1 to 60 characters');
 END IF;
 IF v_type IS NULL OR v_type NOT IN ('commitment','request','claim','issue','constraint','dependency','agreement','event','phase_note') THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'item_type');
 END IF;
 IF v_status IS NULL OR v_status NOT IN ('open','closed','declined','superseded','info')
  OR (v_type IN ('event','phase_note') AND v_status <> 'info')
  OR (v_type NOT IN ('event','phase_note','agreement') AND v_status = 'info')
  OR (p_writer = 'person' AND v_status NOT IN ('open','info')) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'status ' || coalesce(v_status, 'null') || ' for ' || v_type);
 END IF;
 IF v_from IS NULL OR NOT v_from = ANY(roles) OR (v_to IS NOT NULL AND NOT v_to = ANY(roles)) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'from_role or to_role');
 END IF;
 IF length(v_what) NOT BETWEEN 1 AND 600 OR length(coalesce(p_item ->> 'from_name', '')) > 120
  OR length(coalesce(p_item ->> 'to_name', '')) > 120 OR length(coalesce(p_item ->> 'also_concerns', '')) > 200 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'what 1 to 600, names up to 120, also_concerns up to 200');
 END IF;
 IF v_about IS NOT NULL AND v_about !~ '^(invoice|quote|booking|payment|variation|materials|scope|access|preference|defect|approval|contact|other):[a-z0-9]+(-[a-z0-9]+){0,4}$' THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'about_key ' || left(v_about, 60));
 END IF;
 IF v_about LIKE 'booking:%' AND v_about !~ '^booking:[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'booking about_key is booking:yyyy-mm-dd');
 END IF;
 IF (p_item ->> 'modality') IS NOT NULL AND (p_item ->> 'modality') NOT IN ('requested','offered','agreed','declined','reported','confirmed')
  OR (v_type = 'agreement' AND (p_item ->> 'modality') IS NULL) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'modality');
 END IF;
 IF (p_item ->> 'phase') IS NOT NULL AND (p_item ->> 'phase') NOT IN ('enquiry','scope','quote','accepted','deposit','approvals','materials',
   'scheduled','install','complete','invoice','payment','rectification','makesafe','other')
  OR (v_type = 'phase_note' AND (p_item ->> 'phase') IS NULL) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'phase');
 END IF;
 IF (p_item ->> 'closes_on') IS NOT NULL AND (p_item ->> 'closes_on') NOT IN ('reply','call','quote_sent','invoice_issued','payment',
   'booking_made','visit','work_done','record','person','none')
  OR (p_item ->> 'blocks') IS NOT NULL AND (p_item ->> 'blocks') NOT IN ('quote','acceptance','deposit','booking','install','completion','payment','none')
  OR coalesce(jsonb_typeof(p_item -> 'needs_reply'), 'null') NOT IN ('boolean','null')
  OR v_basis NOT IN ('stated','none')
  OR length(coalesce(p_item ->> 'supersedes_key', '')) > 200 OR length(coalesce(p_item ->> 'supersedes_ref', '')) > 60 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'closes_on, blocks, needs_reply, due_basis or supersedes');
 END IF;
 IF (p_item ->> 'due_date') IS NOT NULL THEN
  IF (p_item ->> 'due_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
   RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'due_date is yyyy-mm-dd');
  END IF;
  BEGIN v_due := (p_item ->> 'due_date')::date;
  EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'due_date is not a date'); END;
 END IF;
 IF v_basis = 'stated' AND v_due IS NULL THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'due_basis stated needs a due_date');
 END IF;
 IF coalesce(jsonb_typeof(p_item -> 'opened_by'), 'null') NOT IN ('array','null')
  OR coalesce(jsonb_typeof(p_item -> 'closed_by'), 'null') NOT IN ('array','null')
  OR jsonb_array_length(coalesce(nullif(p_item -> 'opened_by', 'null'::jsonb), '[]')) > 25
  OR jsonb_array_length(coalesce(nullif(p_item -> 'closed_by', 'null'::jsonb), '[]')) > 25 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'opened_by and closed_by are arrays of at most 25');
 END IF;
 IF p_writer = 'model' AND jsonb_array_length(coalesce(nullif(p_item -> 'opened_by', 'null'::jsonb), '[]')) = 0 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'opened_by needs at least one citation');
 END IF;
 -- Opening citations.
 FOR c IN SELECT x FROM jsonb_array_elements(coalesce(nullif(p_item -> 'opened_by', 'null'::jsonb), '[]')) x LOOP
  n := n + 1;
  chk := public.context_ledger_cite(p_job_id, c);
  IF NOT (chk ->> 'ok')::boolean THEN
   RETURN jsonb_build_object('ok', false, 'code', chk ->> 'code', 'detail', 'opened_by[' || n || '] ' || coalesce(chk ->> 'detail', ''));
  END IF;
  v_open := v_open || jsonb_build_array(chk -> 'cite');
  v_facts := v_facts || jsonb_build_array(chk);
  v_opened_at := least(v_opened_at, (chk ->> 'at')::timestamptz);
  IF n = 1 THEN  -- the speaker is whoever sent the first opening citation
   v_first_customer := (chk ->> 'customer_sender')::boolean;
   v_first_us := (chk ->> 'ours')::boolean OR (chk ->> 'call_or_note')::boolean OR (chk ->> 'record')::boolean;
  END IF;
  v_any_customer := v_any_customer OR (chk ->> 'customer_sender')::boolean;
  v_any_us := v_any_us OR (chk ->> 'ours')::boolean OR (chk ->> 'call_or_note')::boolean OR (chk ->> 'record')::boolean;
  v_any_external := v_any_external OR NOT (chk ->> 'internal_text')::boolean;
 END LOOP;
 -- A person's item with no citation cites the person and their note.
 IF jsonb_array_length(v_open) = 0 THEN
  v_open := jsonb_build_array(jsonb_build_object('table', 'person', 'id', p_person::text, 'excerpt', p_note));
  v_opened_at := now();
 END IF;
 n := 0;
 FOR c IN SELECT x FROM jsonb_array_elements(coalesce(nullif(p_item -> 'closed_by', 'null'::jsonb), '[]')) x LOOP
  n := n + 1;
  chk := public.context_ledger_cite(p_job_id, c);
  IF NOT (chk ->> 'ok')::boolean THEN
   RETURN jsonb_build_object('ok', false, 'code', chk ->> 'code', 'detail', 'closed_by[' || n || '] ' || coalesce(chk ->> 'detail', ''));
  END IF;
  -- Only an issued or sent record closes: no draft invoice, unsent document or
  -- unattended booking; never the opening row itself; a request strictly after it.
  v_close_at := CASE WHEN chk #>> '{cite,table}' = 'job_assignments' AND (p_item ->> 'closes_on') = 'booking_made'
                     THEN (chk ->> 'made_at')::timestamptz
                     WHEN chk #>> '{cite,table}' = 'xero_invoices' AND (p_item ->> 'closes_on') = 'payment'
                     -- (ledger reader fixes, 20261007150000) at the end of its paid Perth day, whatever
                     -- the invoice's date: a request made the day it was paid is closed by it
                     THEN public.context_ledger_paid_close_at((chk ->> 'paid_at')::timestamptz) ELSE (chk ->> 'close_at')::timestamptz END;
  IF chk #>> '{cite,table}' = 'job_events' AND NOT public.context_ledger_job_event_closes(chk ->> 'kind', p_item ->> 'closes_on') THEN
   v_close_at := NULL;
  END IF;
  IF chk #>> '{cite,table}' = 'email_events' AND NOT public.context_ledger_email_closes(chk ->> 'kind', p_item ->> 'closes_on') THEN
   v_close_at := NULL;
  END IF;
  IF v_close_at IS NULL THEN
   RETURN jsonb_build_object('ok', false, 'code', 'closing_not_issued', 'detail', 'closed_by[' || n || '] ' || (chk #>> '{cite,table}'));
  END IF;
  IF v_open @> jsonb_build_array(jsonb_build_object('table', chk #>> '{cite,table}', 'id', chk #>> '{cite,id}')) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'closing_is_opening', 'detail', 'closed_by[' || n || ']');
  END IF;
  IF v_close_at < v_opened_at OR (v_type = 'request' AND v_close_at <= v_opened_at) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'closing_before_opening', 'detail', 'closed_by[' || n || ']');
  END IF;
  v_close := v_close || jsonb_build_array(chk -> 'cite');
  v_closed_at := greatest(v_closed_at, v_close_at);
 END LOOP;
 IF v_status IN ('closed','declined') AND jsonb_array_length(v_close) = 0 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'closed_without_evidence', 'detail', v_status || ' needs closed_by');
 END IF;
 IF v_status IN ('open','info') AND jsonb_array_length(v_close) > 0 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'closed_by_on_open', 'detail', v_status || ' cannot carry closed_by');
 END IF;
 -- Who said it (the model only; a person's own item is their word).
 IF p_writer = 'model' THEN
  IF v_from = 'customer' AND NOT coalesce(v_first_customer, false) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'speaker_not_customer', 'detail', 'the first opening citation was not sent by this job''s customer');
  END IF;
  IF v_from = 'us' AND NOT coalesce(v_first_us, false) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'speaker_not_us', 'detail', 'the first opening citation is not ours, a call, a note or a record');
  END IF;
  IF v_to = 'customer' AND NOT v_any_external THEN
   RETURN jsonb_build_object('ok', false, 'code', 'internal_to_customer', 'detail', 'every opening citation is a crew or staff internal text');
  END IF;
  -- (ledger reader fixes, 20261007150000) An item that says a row belongs to another person, another
  -- job or a lead stands only on a cited row (opening or closing) whose own placement or role basis
  -- says it is someone else's (context_ledger_row_elsewhere): never on the reader's word alone, so
  -- the customer's own call is never put on someone else.
  IF public.context_ledger_elsewhere_claim(v_what)
   AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_open || v_close) x
                   WHERE public.context_ledger_row_elsewhere(p_job_id, x ->> 'table', (x ->> 'id')::uuid) IS NOT NULL) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'elsewhere_unsupported',
    'detail', 'what says a row belongs to another person, job or lead; no cited row''s placement or role basis says so');
  END IF;
 END IF;
 -- A due date only when an opening excerpt states it.
 IF v_due IS NOT NULL THEN
  FOR f IN SELECT x FROM jsonb_array_elements(v_facts) x LOOP
   IF NOT (f ->> 'record')::boolean AND NOT coalesce((f ->> 'automated')::boolean, false) AND coalesce(f #>> '{cite,excerpt}', '') <> '' THEN
    BEGIN
     v_supported := public.context_supported_due_date(f #>> '{cite,excerpt}', (f ->> 'at')::timestamptz);
    EXCEPTION WHEN OTHERS THEN v_supported := NULL;
    END;
    IF v_supported = v_due THEN v_due_ok := true; END IF;
   END IF;
  END LOOP;
  IF NOT v_due_ok OR v_basis <> 'stated' THEN
   RETURN jsonb_build_object('ok', false, 'code', 'due_date_unsupported', 'detail', 'no opening excerpt states ' || v_due);
  END IF;
 END IF;
 v_first := v_open -> 0 ->> 'id';
 v_key := v_type || ':' || coalesce(v_about, 'none') || ':' || left(md5(v_first || lower(v_what)), 12);
 RETURN jsonb_build_object('ok', true, 'item', jsonb_build_object('ref', p_item ->> 'ref', 'item_key', v_key, 'item_type', v_type,
  'status', v_status, 'from_role', v_from, 'from_name', nullif(btrim(p_item ->> 'from_name'), ''), 'to_role', v_to,
  'to_name', nullif(btrim(p_item ->> 'to_name'), ''), 'what', v_what, 'about_key', v_about, 'modality', p_item ->> 'modality',
  'phase', p_item ->> 'phase', 'due_date', v_due, 'due_basis', v_basis, 'opened_at', v_opened_at, 'opened_by', v_open,
  -- never a close time still to come (a record dated ahead closes at the check)
  'closed_at', CASE WHEN v_closed_at > now() THEN now() ELSE v_closed_at END, 'closed_by', CASE WHEN jsonb_array_length(v_close) > 0 THEN v_close END,
  'closes_on', p_item ->> 'closes_on', 'supersedes_key', nullif(btrim(p_item ->> 'supersedes_key'), ''),
  'supersedes_ref', nullif(btrim(p_item ->> 'supersedes_ref'), ''), 'blocks', p_item ->> 'blocks',
  'needs_reply', CASE WHEN jsonb_typeof(p_item -> 'needs_reply') = 'boolean' THEN (p_item ->> 'needs_reply')::boolean END, 'also_concerns', nullif(btrim(p_item ->> 'also_concerns'), '')));
END $$;
COMMENT ON FUNCTION public.context_ledger_check_item(uuid, jsonb, text, uuid, text) IS
 'Context ledger store (20261006013000), ledger reader fixes (20261007150000): a model item whose words say a row belongs to another person, another job or a lead (context_ledger_elsewhere_claim) is refused elsewhere_unsupported unless one of its cited rows, opening or closing, is someone else''s by its own placement or role basis (context_ledger_row_elsewhere); a person''s own item is their word. A PAID invoice closes a payment item (closes_on payment) at the end of its paid Perth day, never after now (context_ledger_paid_close_at), whatever the invoice''s date, so a request made the day it was paid is closed by it. Earlier: checks one ledger item for a job and returns the row to insert or {ok false, code, detail}. Shape (types, roles, about_key vocabulary, modality, phase, status per type), every citation (context_ledger_cite), closed or declined needs closed_by and nothing open carries it; a closing citation must be able to close (close_at: no draft invoice, unsent document or unattended booking: closing_not_issued), may not be an opening citation (closing_is_opening) and is at or after the opening, strictly after for a request (closing_before_opening); speaker rules for the model on the first opening citation (customer: the job''s customer sent it; us: ours, a call, a note or a record; nothing only internal texts is to the customer), a due date only when an opening excerpt states it and that message is not automated (context_supported_due_date); what has em and en dashes replaced. opened_at and closed_at come from the cited rows, never the input, and closed_at is never later than now. item_key = type:about:first 12 hex of md5(first opening citation id || lower(what)). Service role only.';

-- 8. The write: a transition's payment close at the end of the paid day (one line changed).
CREATE OR REPLACE FUNCTION public.context_ledger_write(p_run_id uuid, p_lease_token uuid, p_generation_id uuid,
 p_items jsonb, p_transitions jsonb, p_reader text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.context_extraction_runs; g public.context_ledger_generations; v_items jsonb := coalesce(p_items, '[]'::jsonb);
 v_trans jsonb := coalesce(p_transitions, '[]'::jsonb); v_hash text; v_prior jsonb; v_by text; it jsonb; chk jsonb;
 cands jsonb[] := '{}'; refused jsonb := '[]'::jsonb; accepted jsonb := '[]'::jsonb; t_refused jsonb := '[]'::jsonb;
 t_accepted integer := 0; k integer; m integer; v_changed boolean; v_cand jsonb; v_other jsonb; v_key text; v_found boolean;
 v_rep_at timestamptz; v_result jsonb; refs text[] := '{}'; keys text[] := '{}'; v_id uuid; tr jsonb; li public.context_ledger_items;
 v_ev jsonb; v_ev_at timestamptz; v_code text; v_detail text; c jsonb; n integer; v_ok boolean;
BEGIN
 IF p_run_id IS NULL OR p_lease_token IS NULL OR p_generation_id IS NULL
  OR jsonb_typeof(v_items) <> 'array' OR jsonb_typeof(v_trans) <> 'array'
  OR jsonb_array_length(v_items) > 200 OR jsonb_array_length(v_trans) > 200
  OR p_reader IS NULL OR p_reader !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$' THEN
  RAISE EXCEPTION 'context_ledger_write_invalid';
 END IF;
 v_by := 'model:' || p_reader;
 v_hash := encode(sha256(convert_to(jsonb_build_array(p_generation_id, v_items, v_trans, p_reader)::text, 'UTF8')), 'hex');
 SELECT * INTO r FROM public.context_extraction_runs WHERE id = p_run_id FOR UPDATE;
 IF r.id IS NULL OR r.phase <> 'ledger' THEN RAISE EXCEPTION 'context_ledger_write_invalid'; END IF;
 -- A repeated request in the same run gets its first answer back, unchanged.
 SELECT w.result INTO v_prior FROM public.context_ledger_writes w WHERE w.run_id = p_run_id AND w.request_sha256 = v_hash;
 IF v_prior IS NOT NULL THEN RETURN v_prior || jsonb_build_object('replayed', true); END IF;
 IF r.lease_token IS DISTINCT FROM p_lease_token OR r.status <> 'running' OR r.lease_expires_at IS NULL OR r.lease_expires_at <= now() THEN
  RETURN jsonb_build_object('outcome', 'lease_lost');
 END IF;
 IF NOT public.automation_lane_enabled('extraction')
  OR coalesce((SELECT st.mode FROM public.context_ledger_settings st WHERE st.id), 'off') = 'off' THEN
  RETURN jsonb_build_object('outcome', 'off');
 END IF;
 SELECT * INTO g FROM public.context_ledger_generations WHERE id = p_generation_id FOR UPDATE;
 IF g.id IS NULL OR g.job_id IS DISTINCT FROM r.job_id
  OR NOT ((g.status = 'building' AND g.run_id = p_run_id)
   OR (g.id = public.context_ledger_current_generation(r.job_id)
    AND NOT EXISTS (SELECT 1 FROM public.context_ledger_generations b WHERE b.run_id = p_run_id))) THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'generation_mismatch');
 END IF;
 IF g.reader <> p_reader THEN RETURN jsonb_build_object('outcome', 'refused', 'reason', 'reader_mismatch'); END IF;
 SELECT coalesce(array_agg(i.item_key), '{}') INTO keys FROM public.context_ledger_items i WHERE i.generation_id = g.id;

 -- Pass 1: each item on its own.
 FOR it IN SELECT x FROM jsonb_array_elements(v_items) x LOOP
  chk := public.context_ledger_check_item(r.job_id, it, 'model');
  IF NOT (chk ->> 'ok')::boolean THEN
   refused := refused || jsonb_build_array(jsonb_build_object('ref', it ->> 'ref', 'code', chk ->> 'code', 'detail', chk ->> 'detail'));
   CONTINUE;
  END IF;
  v_cand := chk -> 'item';
  -- A person's correction stands: the model may not write the same matter (same
  -- type, same first opening citation) again, in an update or a rebuild.
  IF EXISTS (SELECT 1 FROM public.context_ledger_items pl JOIN public.context_ledger_generations pg ON pg.id = pl.generation_id
             WHERE pl.job_id = g.job_id AND pl.person_locked AND (pl.generation_id = g.id OR pg.status = 'live')
               AND pl.item_type = v_cand ->> 'item_type'
               AND pl.opened_by -> 0 ->> 'table' = v_cand -> 'opened_by' -> 0 ->> 'table'
               AND pl.opened_by -> 0 ->> 'id' = v_cand -> 'opened_by' -> 0 ->> 'id') THEN
   refused := refused || jsonb_build_array(jsonb_build_object('ref', v_cand ->> 'ref', 'code', 'person_locked',
    'detail', 'a person corrected this matter'));
   CONTINUE;
  END IF;
  IF (v_cand ->> 'ref') = ANY(refs) THEN
   refused := refused || jsonb_build_array(jsonb_build_object('ref', v_cand ->> 'ref', 'code', 'duplicate_ref', 'detail', 'ref used twice in one write'));
   CONTINUE;
  END IF;
  refs := refs || (v_cand ->> 'ref');
  IF (v_cand ->> 'item_key') = ANY(keys) THEN
   refused := refused || jsonb_build_array(jsonb_build_object('ref', v_cand ->> 'ref', 'code', 'duplicate_item', 'detail', v_cand ->> 'item_key'));
   CONTINUE;
  END IF;
  keys := keys || (v_cand ->> 'item_key');
  cands := cands || v_cand;
 END LOOP;

 -- Pass 2: supersedes_ref names an item of this write.
 FOR k IN 1 .. coalesce(array_length(cands, 1), 0) LOOP
  IF cands[k] ->> 'supersedes_ref' IS NOT NULL THEN
   v_key := NULL;
   FOR m IN 1 .. array_length(cands, 1) LOOP
    IF m <> k AND cands[m] ->> 'ref' = cands[k] ->> 'supersedes_ref' THEN v_key := cands[m] ->> 'item_key'; END IF;
   END LOOP;
   IF v_key IS NULL OR (cands[k] ->> 'supersedes_key' IS NOT NULL AND cands[k] ->> 'supersedes_key' <> v_key) THEN
    cands[k] := cands[k] || jsonb_build_object('refused', 'supersedes_unresolved');
   ELSE
    cands[k] := cands[k] || jsonb_build_object('supersedes_key', v_key);
   END IF;
  END IF;
 END LOOP;
 -- Pass 3, to a fixed point: a supersedes_key names an existing or accepted
 -- item; a superseded item has an accepted or existing replacement.
 LOOP
  v_changed := false;
  FOR k IN 1 .. coalesce(array_length(cands, 1), 0) LOOP
   CONTINUE WHEN cands[k] ? 'refused';
   IF cands[k] ->> 'supersedes_key' IS NOT NULL THEN
    v_found := EXISTS (SELECT 1 FROM public.context_ledger_items i WHERE i.generation_id = g.id AND i.item_key = cands[k] ->> 'supersedes_key');
    FOR m IN 1 .. array_length(cands, 1) LOOP
     IF m <> k AND NOT cands[m] ? 'refused' AND cands[m] ->> 'item_key' = cands[k] ->> 'supersedes_key' THEN v_found := true; END IF;
    END LOOP;
    IF NOT v_found THEN cands[k] := cands[k] || jsonb_build_object('refused', 'supersedes_unresolved'); v_changed := true; CONTINUE; END IF;
   END IF;
   IF cands[k] ->> 'status' = 'superseded' THEN
    v_rep_at := NULL;
    SELECT min(i.opened_at) INTO v_rep_at FROM public.context_ledger_items i
    WHERE i.generation_id = g.id AND i.supersedes_key = cands[k] ->> 'item_key';
    FOR m IN 1 .. array_length(cands, 1) LOOP
     IF m <> k AND NOT cands[m] ? 'refused' AND cands[m] ->> 'supersedes_key' = cands[k] ->> 'item_key' THEN
      v_rep_at := least(v_rep_at, (cands[m] ->> 'opened_at')::timestamptz);
     END IF;
    END LOOP;
    IF v_rep_at IS NULL THEN
     cands[k] := cands[k] || jsonb_build_object('refused', 'superseded_without_replacement'); v_changed := true; CONTINUE;
    END IF;
    IF cands[k] ->> 'closed_at' IS NULL THEN
     IF v_rep_at < (cands[k] ->> 'opened_at')::timestamptz THEN
      cands[k] := cands[k] || jsonb_build_object('refused', 'closing_before_opening'); v_changed := true; CONTINUE;
     END IF;
     cands[k] := cands[k] || jsonb_build_object('closed_at', CASE WHEN v_rep_at > now() THEN now() ELSE v_rep_at END);
    END IF;
   END IF;
  END LOOP;
  EXIT WHEN NOT v_changed;
 END LOOP;

 -- Insert what stands, each item whole or not at all.
 FOR k IN 1 .. coalesce(array_length(cands, 1), 0) LOOP
  v_cand := cands[k];
  IF v_cand ? 'refused' THEN
   refused := refused || jsonb_build_array(jsonb_build_object('ref', v_cand ->> 'ref', 'code', v_cand ->> 'refused',
    'detail', coalesce(v_cand ->> 'supersedes_key', v_cand ->> 'supersedes_ref', v_cand ->> 'item_key')));
   CONTINUE;
  END IF;
  BEGIN
   INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, from_name, to_role, to_name,
    what, about_key, modality, phase, due_date, due_basis, opened_at, opened_by, closed_at, closed_by, closes_on, supersedes_key,
    blocks, needs_reply, also_concerns, written_by, person_locked)
   VALUES (g.id, g.job_id, v_cand ->> 'item_key', v_cand ->> 'item_type', v_cand ->> 'status', v_cand ->> 'from_role',
    v_cand ->> 'from_name', v_cand ->> 'to_role', v_cand ->> 'to_name', v_cand ->> 'what', v_cand ->> 'about_key',
    v_cand ->> 'modality', v_cand ->> 'phase', (v_cand ->> 'due_date')::date, v_cand ->> 'due_basis',
    (v_cand ->> 'opened_at')::timestamptz, v_cand -> 'opened_by', (v_cand ->> 'closed_at')::timestamptz,
    CASE WHEN jsonb_typeof(v_cand -> 'closed_by') = 'array' THEN v_cand -> 'closed_by' END, v_cand ->> 'closes_on',
    v_cand ->> 'supersedes_key', v_cand ->> 'blocks', (v_cand ->> 'needs_reply')::boolean, v_cand ->> 'also_concerns', v_by, false)
   RETURNING id INTO v_id;
   INSERT INTO public.context_ledger_transitions (item_id, generation_id, job_id, from_status, to_status, by, evidence, reason)
   VALUES (v_id, g.id, g.job_id, NULL, v_cand ->> 'status', v_by,
    CASE WHEN v_cand ->> 'status' IN ('closed','declined') THEN v_cand -> 'closed_by' ELSE v_cand -> 'opened_by' END, 'written');
   accepted := accepted || jsonb_build_array(jsonb_build_object('ref', v_cand ->> 'ref', 'item_key', v_cand ->> 'item_key'));
  EXCEPTION WHEN check_violation OR not_null_violation OR unique_violation OR invalid_text_representation THEN
   refused := refused || jsonb_build_array(jsonb_build_object('ref', v_cand ->> 'ref', 'code', 'invalid_shape', 'detail', left(SQLERRM, 200)));
  END;
 END LOOP;

 -- Transitions on items of this generation.
 FOR tr IN SELECT x FROM jsonb_array_elements(v_trans) x LOOP
  v_code := NULL; v_detail := NULL; v_ev := '[]'::jsonb; v_ev_at := NULL;
  IF jsonb_typeof(tr) <> 'object'
   OR EXISTS (SELECT 1 FROM jsonb_object_keys(tr) kk WHERE kk NOT IN ('item_key','to_status','evidence','reason'))
   OR jsonb_typeof(tr -> 'item_key') IS DISTINCT FROM 'string'
   OR coalesce(tr ->> 'to_status', '') NOT IN ('open','closed','declined','superseded','disputed')
   OR coalesce(jsonb_typeof(tr -> 'evidence'), 'null') NOT IN ('array','null')
   OR jsonb_array_length(coalesce(nullif(tr -> 'evidence', 'null'::jsonb), '[]')) > 25
   OR coalesce(jsonb_typeof(tr -> 'reason'), 'null') NOT IN ('string','null') OR length(coalesce(tr ->> 'reason', '')) > 600 THEN
   v_code := 'invalid_shape'; v_detail := 'a transition is {item_key, to_status, evidence, reason}';
  END IF;
  IF v_code IS NULL THEN
   SELECT * INTO li FROM public.context_ledger_items i WHERE i.generation_id = g.id AND i.item_key = tr ->> 'item_key' FOR UPDATE;
   IF li.id IS NULL THEN v_code := 'unknown_item';
   ELSIF li.person_locked THEN v_code := 'person_locked';
   ELSIF li.status = tr ->> 'to_status' THEN v_code := 'no_change';
   END IF;
  END IF;
  IF v_code IS NULL THEN
   n := 0;
   FOR c IN SELECT x FROM jsonb_array_elements(coalesce(nullif(tr -> 'evidence', 'null'::jsonb), '[]')) x LOOP
    n := n + 1;
    chk := public.context_ledger_cite(g.job_id, c);
    IF NOT (chk ->> 'ok')::boolean THEN v_code := chk ->> 'code'; v_detail := 'evidence[' || n || '] ' || coalesce(chk ->> 'detail', ''); EXIT; END IF;
    IF tr ->> 'to_status' IN ('closed', 'declined') THEN
     -- the same closing rules as an item's closed_by (a booking_made item closes on a made booking)
     IF chk #>> '{cite,table}' = 'job_assignments' AND li.closes_on = 'booking_made' THEN
      chk := chk || jsonb_build_object('close_at', chk -> 'made_at');
     END IF;
     IF chk #>> '{cite,table}' = 'xero_invoices' AND li.closes_on = 'payment' THEN
      -- (ledger reader fixes, 20261007150000) at the end of its paid Perth day, as an item's
      chk := chk || jsonb_build_object('close_at', public.context_ledger_paid_close_at((chk ->> 'paid_at')::timestamptz));
     END IF;
     IF chk #>> '{cite,table}' = 'job_events' AND NOT public.context_ledger_job_event_closes(chk ->> 'kind', li.closes_on) THEN
      chk := chk || jsonb_build_object('close_at', NULL::timestamptz);
     END IF;
     IF chk #>> '{cite,table}' = 'email_events' AND NOT public.context_ledger_email_closes(chk ->> 'kind', li.closes_on) THEN
      chk := chk || jsonb_build_object('close_at', NULL::timestamptz);
     END IF;
     IF chk ->> 'close_at' IS NULL THEN v_code := 'closing_not_issued'; v_detail := 'evidence[' || n || '] ' || (chk #>> '{cite,table}'); EXIT; END IF;
     IF li.opened_by @> jsonb_build_array(jsonb_build_object('table', chk #>> '{cite,table}', 'id', chk #>> '{cite,id}')) THEN
      v_code := 'closing_is_opening'; v_detail := 'evidence[' || n || ']'; EXIT;
     END IF;
     IF (chk ->> 'close_at')::timestamptz < li.opened_at OR (li.item_type = 'request' AND (chk ->> 'close_at')::timestamptz <= li.opened_at) THEN
      v_code := 'evidence_older_than_item'; v_detail := 'evidence[' || n || ']'; EXIT;
     END IF;
     v_ev_at := greatest(v_ev_at, (chk ->> 'close_at')::timestamptz);
    ELSE
     IF (chk ->> 'at')::timestamptz < li.opened_at THEN v_code := 'evidence_older_than_item'; v_detail := 'evidence[' || n || ']'; EXIT; END IF;
     v_ev_at := greatest(v_ev_at, (chk ->> 'at')::timestamptz);
    END IF;
    v_ev := v_ev || jsonb_build_array(chk -> 'cite');
   END LOOP;
  END IF;
  IF v_code IS NULL AND tr ->> 'to_status' <> 'superseded' AND jsonb_array_length(v_ev) = 0 THEN
   v_code := 'evidence_missing'; v_detail := tr ->> 'to_status' || ' needs evidence';
  END IF;
  IF v_code IS NULL AND tr ->> 'to_status' = 'superseded' THEN
   SELECT min(i.opened_at) INTO v_rep_at FROM public.context_ledger_items i WHERE i.generation_id = g.id AND i.supersedes_key = li.item_key;
   IF v_rep_at IS NULL THEN v_code := 'superseded_without_replacement';
   ELSIF coalesce(v_ev_at, v_rep_at) < li.opened_at THEN v_code := 'closing_before_opening';
   ELSE v_ev_at := coalesce(v_ev_at, v_rep_at);
   END IF;
  END IF;
  IF v_code IS NOT NULL THEN
   t_refused := t_refused || jsonb_build_array(jsonb_build_object('item_key', tr ->> 'item_key', 'code', v_code, 'detail', v_detail));
   CONTINUE;
  END IF;
  UPDATE public.context_ledger_items SET status = tr ->> 'to_status',
   closed_at = CASE WHEN tr ->> 'to_status' IN ('closed','declined','superseded') THEN CASE WHEN v_ev_at > now() THEN now() ELSE v_ev_at END END,
   closed_by = CASE WHEN tr ->> 'to_status' IN ('closed','declined','superseded') AND jsonb_array_length(v_ev) > 0 THEN v_ev END,
   updated_at = now()
  WHERE id = li.id;
  INSERT INTO public.context_ledger_transitions (item_id, generation_id, job_id, from_status, to_status, by, evidence, reason)
  VALUES (li.id, g.id, g.job_id, li.status, tr ->> 'to_status', v_by, CASE WHEN jsonb_array_length(v_ev) > 0 THEN v_ev END, tr ->> 'reason');
  t_accepted := t_accepted + 1;
 END LOOP;

 v_result := jsonb_build_object('outcome', 'written', 'generation_id', g.id, 'accepted', accepted, 'refused', refused,
  'transitions_accepted', t_accepted, 'transitions_refused', t_refused);
 INSERT INTO public.context_ledger_writes (run_id, generation_id, job_id, request_sha256, items_accepted, items_refused,
  transitions_accepted, transitions_refused, result)
 VALUES (p_run_id, g.id, g.job_id, v_hash, jsonb_array_length(accepted), jsonb_array_length(refused), t_accepted,
  jsonb_array_length(t_refused), v_result);
 UPDATE public.context_ledger_generations SET updated_at = now() WHERE id = g.id;
 RETURN v_result;
END $$;
COMMENT ON FUNCTION public.context_ledger_write(uuid, uuid, uuid, jsonb, jsonb, text) IS
 'Context ledger store (20261006013000), ledger reader fixes (20261007150000): a transition closing a payment item on a PAID invoice closes it at the end of the invoice''s paid Perth day, never after now (context_ledger_paid_close_at), as an item''s closed_by does; items pass the item check''s new elsewhere_unsupported rule. Earlier: writes a reader''s items and transitions into a generation under custody. The run must be a running ledger run holding its lease (else lease_lost), the lane on and the mode not off (else off), the generation this run''s building generation or, for an update run, the job''s current generation (else refused generation_mismatch), the reader the generation''s (reader_mismatch). Every item passes context_ledger_check_item, is not a person-corrected matter (person_locked: the same type and first opening citation as a person-locked item of this generation or the live one), a fresh ref and item_key (duplicate_ref, duplicate_item), resolvable supersedes (supersedes_unresolved, superseded_without_replacement); accepted items are inserted whole with a transition, refused ones reported with a code. Transitions refuse person_locked, unknown_item, no_change, evidence_missing (every status but superseded needs evidence), evidence_older_than_item, and for closed or declined closing_not_issued and closing_is_opening (the item''s closing rules), and any citation refusal. A repeated identical request in the same run returns its first answer (replayed true). written_by model:<reader>. Service role only.';

-- 9. The packet: call_customer never a bare null, each row's elsewhere, the siblings section.
CREATE OR REPLACE FUNCTION public.context_ledger_packet(p_job_id uuid, p_since timestamptz DEFAULT NULL, p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE jb record; v_job jsonb; v_parties jsonb; v_evidence jsonb; v_open jsonb; v_until timestamptz; v_rows integer;
 v_truncated integer; v_dups integer; v_as_of timestamptz; v_gen uuid; v_pe text[]; v_pp text[]; v_pc text[];
BEGIN
 v_as_of := coalesce(p_as_of, now());
 SELECT j.id, j.job_number, j.type::text AS type, j.status::text AS status, j.client_name, j.site_suburb, j.created_at,
  nullif(btrim(j.ghl_contact_id), '') AS ghl_contact_id, j.client_email, j.client_phone
 INTO jb FROM public.jobs j WHERE j.id = p_job_id;
 IF jb.id IS NULL THEN RAISE EXCEPTION 'context_ledger_packet_job_not_found'; END IF;
 v_job := jsonb_build_object('id', jb.id, 'job_number', jb.job_number, 'type', jb.type, 'status', jb.status,
  'client_name', jb.client_name, 'site_suburb', jb.site_suburb, 'created_at', jb.created_at,
  'customer_contact_ref', jb.ghl_contact_id);
 -- Parties: the job's own client, then every other party on job_contacts
 -- (the owner row that repeats the job's client is not listed twice; its
 -- contact details join the client's). Each carries match_keys, so the reader
 -- can tell whether our message reached that party (never printed).
 SELECT array_agg(c.client_email), array_agg(c.client_phone), array_agg(nullif(btrim(c.ghl_contact_id), ''))
 INTO v_pe, v_pp, v_pc
 FROM public.job_contacts c
 WHERE c.job_id = p_job_id AND c.removed_at IS NULL
  AND coalesce(c.is_primary, false) AND lower(coalesce(c.client_name, '')) = lower(coalesce(jb.client_name, ''));
 SELECT jsonb_build_array(jsonb_build_object('name', jb.client_name, 'role', 'customer', 'contact_ref', jb.ghl_contact_id, 'label', 'job_client',
   'match_keys', public.context_ledger_party_keys(ARRAY[jb.client_email] || v_pe, ARRAY[jb.client_phone] || v_pp,
    ARRAY[jb.ghl_contact_id] || v_pc)))
  -- A party's role: a neighbour (contact_type neighbour, neighbour_b and so on) is a
  -- third party, never the customer, labelled neighbour (and "pays a share" when
  -- its share or invoiced amount says so); the primary contact is the customer;
  -- any other keeps its contact_type, else unknown.
  || coalesce(jsonb_agg(jsonb_build_object('name', c.client_name,
   'role', CASE WHEN lower(coalesce(c.contact_type, '')) LIKE 'neighbour%' THEN 'third_party'
                WHEN coalesce(c.is_primary, false) OR lower(coalesce(c.contact_type, '')) = 'primary' THEN 'customer'
                ELSE coalesce(nullif(btrim(c.contact_type), ''), 'unknown') END,
   'contact_ref', coalesce(nullif(btrim(c.ghl_contact_id), ''), lower(nullif(btrim(c.client_email), ''))),
   'label', CASE WHEN lower(coalesce(c.contact_type, '')) LIKE 'neighbour%'
                 THEN 'neighbour' || CASE WHEN coalesce(c.share_percentage, 0) > 0 OR coalesce(c.amount_invoiced, 0) > 0
                                          THEN ', pays a share' ELSE '' END
                 ELSE coalesce(c.contact_label, c.contact_type) END,
   'match_keys', public.context_ledger_party_keys(ARRAY[c.client_email], ARRAY[c.client_phone], ARRAY[nullif(btrim(c.ghl_contact_id), '')]))
   ORDER BY c.is_primary DESC NULLS LAST, c.created_at, c.id), '[]'::jsonb)
 INTO v_parties
 FROM public.job_contacts c
 WHERE c.job_id = p_job_id AND c.removed_at IS NULL
  AND NOT (coalesce(c.is_primary, false) AND lower(coalesce(c.client_name, '')) = lower(coalesce(jb.client_name, '')));
 -- Evidence: copies left out. In update mode: the rows that landed after
 -- p_since; every already-read row after the earliest of them (so a late row,
 -- such as old mail placed on the job today, is read with what followed it);
 -- and the six rows before it. Each row says whether it was already read.
 WITH r AS (
  SELECT * FROM public.context_ledger_evidence_rows(ARRAY[p_job_id], v_as_of)
 ), u AS (
  SELECT * FROM r WHERE r.copy_of IS NULL
 ), firstnew AS (
  SELECT u.at, u.src_id FROM u WHERE p_since IS NOT NULL AND u.landed_at > p_since ORDER BY u.at, u.src_id LIMIT 1
 ), ctx AS (
  SELECT u.src_id FROM u, firstnew f
  WHERE (u.at, u.src_id) < (f.at, f.src_id) AND NOT (u.landed_at > p_since)
  ORDER BY u.at DESC, u.src_id DESC LIMIT 6
 ), sel AS (
  SELECT u.*, CASE WHEN u.kind IN ('call.transcript_completed', 'document.text_extracted') THEN 6000 ELSE 3000 END AS lim
  FROM u WHERE p_since IS NULL OR u.landed_at > p_since OR u.src_id IN (SELECT ctx.src_id FROM ctx)
   OR EXISTS (SELECT 1 FROM firstnew f WHERE (u.at, u.src_id) > (f.at, f.src_id))
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('table', sel.src_table, 'id', sel.src_id, 'at', sel.at, 'recorded_at', sel.landed_at,
   'channel', sel.channel, 'kind', sel.kind, 'direction', sel.direction, 'sender_role', sel.sender_role,
   'recipient_role', sel.recipient_role, 'audience', sel.audience, 'counterpart_role', sel.counterpart_role,
   'role_basis', sel.role_basis, 'sender', sel.sender, 'recipient', sel.recipient, 'ours', sel.ours, 'automated', sel.automated, 'subject', sel.subject,
   'already_read', p_since IS NOT NULL AND sel.landed_at <= p_since, 'placed_on', sel.placed_on, 'has_transcript', sel.has_transcript,
   -- (ledger reader fixes, 20261007150000) a transcript says whose call it is as true, false or
   -- "unknown" (neither its call row on this job nor its own stamp on the job's contact decides),
   -- never a bare null, which readers took for "not this job's customer"; and each row says whether
   -- its own placement or role basis makes it someone else's (the item check's rule), and why
   'call_customer', CASE WHEN sel.kind = 'call.transcript_completed' THEN coalesce(to_jsonb(sel.call_customer), '"unknown"'::jsonb)
                         ELSE to_jsonb(sel.call_customer) END,
   'elsewhere', public.context_ledger_row_elsewhere(p_job_id, sel.src_table, sel.src_id),
   'text', left(sel.body, sel.lim)) ORDER BY sel.at, sel.src_id), '[]'::jsonb),
  count(*)::integer, (count(*) FILTER (WHERE length(sel.body) > sel.lim))::integer,
  (SELECT max(r.landed_at) FROM r), (SELECT count(*) FILTER (WHERE r.copy_of IS NOT NULL) FROM r)::integer
 INTO v_evidence, v_rows, v_truncated, v_until, v_dups FROM sel;
 -- Items the reader must know: in update mode the current generation's open,
 -- disputed and in-force items; otherwise the live generation's person-locked
 -- items (a rebuild must not write them again).
 IF p_since IS NOT NULL THEN
  v_gen := public.context_ledger_current_generation(p_job_id);
 ELSE
  SELECT g.id INTO v_gen FROM public.context_ledger_generations g WHERE g.job_id = p_job_id AND g.status = 'live';
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('item_key', i.item_key, 'item_type', i.item_type, 'status', i.status, 'what', i.what,
   'about_key', i.about_key, 'phase', i.phase, 'from_role', i.from_role, 'to_role', i.to_role, 'opened_at', i.opened_at,
   'closes_on', i.closes_on, 'opened_by', i.opened_by, 'person_locked', i.person_locked) ORDER BY i.opened_at, i.item_key COLLATE "C"), '[]'::jsonb)
 INTO v_open FROM public.context_ledger_items i
 WHERE v_gen IS NOT NULL AND i.generation_id = v_gen
  AND CASE WHEN p_since IS NOT NULL THEN i.status IN ('open', 'disputed', 'info') ELSE i.person_locked END;
 RETURN jsonb_build_object('version', 'ledger-packet-v1', 'job', v_job, 'parties', v_parties, 'evidence', v_evidence,
  'evidence_until', v_until, 'evidence_rows', v_rows, 'truncated_rows', v_truncated, 'duplicates_collapsed', v_dups,
  'since', p_since, 'as_of', v_as_of, 'open_items', v_open,
  -- (ledger reader fixes, 20261007150000) the same client's and the same work order's other jobs,
  -- with what was quoted and billed there
  'siblings', public.context_ledger_siblings(p_job_id, v_as_of));
END $$;
COMMENT ON FUNCTION public.context_ledger_packet(uuid, timestamptz, timestamptz) IS
 'Context ledger store (20261006013000), ledger reader fixes (20261007150000): still ledger-packet-v1, with fields added: each transcript''s call_customer is true, false or the string unknown (neither its call row on this job nor its own stamp on the job''s contact decides), never a bare null; each evidence row carries elsewhere, the reason its own placement or role basis makes it someone else''s (context_ledger_row_elsewhere: role_basis:<basis>, call_not_customer, call_on_other_job, sender_not_client, names_other_job:<number>) or null, the rule the item check applies to an item that says a row belongs to another person, job or lead (elsewhere_unsupported); and siblings (context_ledger_siblings as of the packet''s as_of): the same client''s and the same work order''s other jobs with their quotes sent and invoices issued, context only. Earlier: ledger-packet-v1, the reader''s whole view of a job except the record text: job, parties (the job client and a primary contact role customer, a neighbour role third_party labelled neighbour, others their contact_type or unknown; each with match_keys: emails, phones'' last 9 digits), evidence (context_ledger_evidence_rows without copies, oldest first, text capped at 6,000 characters for transcripts and document text and 3,000 otherwise; each row with already_read, placed_on and, on a call log, has_transcript, call_customer on transcripts), evidence_until (newest recorded time seen), evidence_rows, truncated_rows, duplicates_collapsed, open_items (each with phase, closes_on and opened_by as stored). With p_since: rows recorded after it, every already-read row after the earliest of them, and the six before it, and the current generation''s open, disputed and in-force items; without: the live generation''s person-locked items. The judge asks for a rebuild (late_evidence) instead when the earliest new row is more than 14 days older than evidence_until or more than 150 already-read rows follow it. Role fields are the stored party_roles stamp, never invented. Service role only.';

-- 10. Access: service role only (CREATE OR REPLACE keeps a replaced function's grants; said again).
REVOKE ALL ON FUNCTION public.context_ledger_elsewhere_claim(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_paid_close_at(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_work_order_key(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_row_elsewhere(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_siblings(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_call_customer(public.business_events) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_check_item(uuid, jsonb, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_write(uuid, uuid, uuid, jsonb, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_packet(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_elsewhere_claim(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_paid_close_at(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_work_order_key(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_row_elsewhere(uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_siblings(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_call_customer(public.business_events) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_check_item(uuid, jsonb, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_write(uuid, uuid, uuid, jsonb, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_packet(uuid, timestamptz, timestamptz) TO service_role;
