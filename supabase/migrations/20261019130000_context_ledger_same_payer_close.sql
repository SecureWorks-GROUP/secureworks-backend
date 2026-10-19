-- Same payer close (19 Oct 2026, context T16 fix 2): a closing record closes a ledger item only
-- when it is of a kind that closes the item's obligation class and its payer (or, for a person's
-- item, its author) is the item's obligated party. Behind feature_flags.context_ledger_same_payer_close_v1,
-- created off; missing or unreadable is off.
--
-- Why. Today any PAID ACCREC invoice on a job closes any payment item on it, whoever was billed,
-- so a neighbour's paid share closes the owner's payment item, an ACCPAY bill or a credit note can
-- close a customer's payment, a deposit closes a final, and "paid" said only in a text closes a
-- payment item. A shared builder work order, a sister job, a neighbour's share or a site sibling is
-- evidence to investigate, never enough to close another job's or another payer's obligation
-- (design: context-system/t16-fix2/design.md; fixtures: fixtures.md, 38 trap cases).
--
-- What it does (switch on). Every rule only adds a refusal on top of today's: it can lower or hold
-- the number of closes, never raise it. closing_before_opening, closing_is_opening,
-- closing_not_issued and citation_off_job are unchanged and still run first.
--  1. The item's obligation class (context_ledger_obligation_class): payment (closes_on payment,
--     or closes_on none/null with blocks payment or deposit), invoice (invoice_issued), person
--     (person), reply (reply, call), work (work_done, visit), other.
--  2. Its obligated party, stored once at open (context_ledger_obligated_party; new column
--     context_ledger_items.obligated_party, null meaning unknown, its basis in obligation_ref):
--     builder work (make-safe details name a builder) is this job's own obligation (builder_job);
--     an item opened by citing an invoice is that invoice's payer, and the item is bound to that
--     invoice and its kind (obligation_ref invoice_id, invoice_kind, from the Debt tab's one kind
--     reader, mirrored here as context_ledger_invoice_kind_of and pinned to it by
--     ops-api/invoice_kind_contract_rows_test.ts); a customer's message is the job party whose
--     CRM contact, email key or phone key matches its sender, else the owner (the live owner
--     marker: is_primary, party_role owner or source_party_key primary) only while no active
--     non-owner party exists, else unknown; our own note, a call or a record is every paying
--     party (all_payers) while a non-owner party is active, else the owner; a job with no active
--     party is the job's own client (job_client); a person's item is the author of its first
--     opening note (unknown with none).
--  3. The payer of an invoice (context_ledger_invoice_payer), in order: the builder when its
--     contact is one of the builder's own Xero contacts (context_ledger_builder_contacts, keyed on
--     makesafe_job_details.requesting_company_id, never matched by name); the party named by
--     job_contact_id; the one active party carrying its Xero contact (two: unknown, ambiguous);
--     the job's own Xero contact: the job client on builder work or with no active party, the
--     owner with exactly one active owner marked, else unknown; anything else unknown. A
--     payment_received or payment_recorded app event has its named invoice's payer, or none.
--  4. The verdict (context_ledger_obligation_closes, the one rule check_item and the write's
--     transitions both call): a payment item closes only on a PAID ACCREC invoice (amount due
--     zero, a paid day) of its obligated payer, not reached by another contact's overpayment or
--     prepayment or by a credit, of its bound invoice or kind when bound, and, unbound, only
--     while every issued ACCREC invoice of that payer on the job is PAID (all_payers: every paying
--     party covered by a cited invoice and fully paid). A message never closes a payment or an
--     invoice item (closing evidence only); a document, booking or system email never closes a
--     payment. An invoice item closes on an issued ACCREC invoice of its payer. A person's item
--     closes only on a later message by the same author. An invoice cite closes only a payment
--     or invoice item, or an item about an invoice or payment. Reply, work and other items are
--     unchanged (no payer rule).
--     Review r2: on builder work an invoice to the job's own Xero contact is unproven (the
--     contact is often the builder's), never certainly another payer; a record cited to close a
--     person's or an other item is evidence only (record_not_person, payer not certain); an item
--     opened by our own message with no named sender is owed by us (kind us) and closes only on a
--     later row of ours by its stamp, never on a customer's.
--     Review r3: a payment item naming one of the job's invoices (its number or Xero reference as
--     an exact token, never a substring) is bound to it and closes on that invoice being PAID,
--     whatever the payer's other invoices owe; so is an item about an invoice citing exactly one.
--     An unbound item failing only on an invoice it never cited stays open, payer not certain
--     (other_invoice_owed). An invoice cited on a reply, work or other item is evidence only, never
--     certain. A closing citation that does not close and is not certain evidence against no longer
--     vetoes one that closes. The customer an item is owed to answering it (released_by_obligee,
--     obligee_replied) is never a close and never certain.
--  5. A close the verdict refuses stays open. check_item turns a closed item into an open one
--     (obligation_ref.held_open, the refused closing citations as closing_evidence); a write's
--     closing transition is refused obligation_not_closed and the item's certainty is recorded.
--     certainty (new column): certain, payer_not_certain (the payer, the party or the money's
--     source cannot be proven), or settled_job_needs_person (a person's item on a job finished
--     and paid by the stored close-out outcome, job_closeout_state.outcome paid; never
--     re-derived). An unbound payment item whose known payer's own issued invoice is unpaid is
--     open and certain (invoice_unpaid, partially_paid).
--
-- The builder contact mapping. No company-to-Xero-contact mapping exists anywhere today
-- (makesafe_companies carries no Xero contact; debt_ws_settings.company_aliases only groups Xero
-- contacts with each other). context_ledger_builder_contacts is new and empty: until a person
-- fills it, every builder payment or invoice item stays open and payer_not_certain
-- (builder_contact_unmapped), whatever its invoice says.
--
-- What it does not do. Placement, the ladder, context_ledger_row_elsewhere, the work order key,
-- the money seal and xero_invoices.job_id, the item key, the unread rule, the story digest and
-- every reader are not changed; nothing reads a sibling's or another job's row. Off (missing,
-- unreadable or false): every replaced function answers byte for byte as before (the new keys
-- and columns are absent or null).
--
-- Replaced bodies (each guarded on its live production md5): context_ledger_cite,
--   context_ledger_check_item, context_ledger_write.
-- Added: context_ledger_same_payer_close_on, context_ledger_invoice_kind_of,
--   context_ledger_obligation_kind, context_ledger_obligation_class, context_ledger_invoice_payer,
--   context_ledger_invoice_facts, context_ledger_obligation_job_facts,
--   context_ledger_obligation_payer_match, context_ledger_obligated_party,
--   context_ledger_obligation_closes, table context_ledger_builder_contacts, columns
--   context_ledger_items.obligated_party, .obligation_ref, .certainty, feature flag
--   context_ledger_same_payer_close_v1 (off).
-- Query shape (switch on only): per checked item one read of the job, its make-safe details, its
--   parties (index on job_contacts.job_id), its invoices (index on xero_invoices.job_id) and its
--   close-out state; per cited invoice or payment event one more invoice read.
-- Rollback: supabase/rollbacks/20261019130000_context_ledger_same_payer_close_down.sql (the three
--   earlier bodies and comments word for word; helpers, table and columns dropped; flag row kept).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[] := '{}'; live text; x record; f text;
BEGIN
 -- The replaced bodies: the ones production runs, or this migration's (re-apply).
 FOR x IN SELECT * FROM (VALUES
  ('public.context_ledger_cite(uuid,jsonb)', ARRAY['44b8faee5207fa4a4604dbcb25cbfc12', 'cefd4fe399725489eeb3d67705e951c6']),
  ('public.context_ledger_check_item(uuid,jsonb,text,uuid,text)', ARRAY['af976e59b8e6f35612d6383042d6e38e', '606205ed695102cda92086510902ea9e']),
  ('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)', ARRAY['6da1007ff2a6331219f4d98f85749ca7', '88c75603e8483337fd146dd8392e72d5'])
 ) AS v(sig, accepted) LOOP
  live := NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY(x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 -- Read, never replaced.
 FOREACH f IN ARRAY ARRAY['public.context_ledger_held_cite(uuid,jsonb)', 'public.context_held_notes_on()',
  'public.context_ledger_paid_close_at(timestamptz)', 'public.context_ledger_job_event_closes(text,text)',
  'public.context_ledger_email_closes(text,text)', 'public.context_event_identity(public.business_events)',
  'public.context_email_key(text)', 'public.context_phone_key(text)', 'public.context_ledger_current_generation(uuid)'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_ledger_items', 'public.jobs', 'public.job_contacts', 'public.xero_invoices',
  'public.job_events', 'public.makesafe_job_details', 'public.makesafe_companies', 'public.job_closeout_state'] LOOP
  IF to_regclass(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 FOR x IN SELECT * FROM (VALUES ('job_contacts', 'is_primary'), ('job_contacts', 'party_role'), ('job_contacts', 'source_party_key'),
   ('job_contacts', 'removed_at'), ('job_contacts', 'status'), ('job_contacts', 'share_percentage'), ('job_contacts', 'xero_contact_id'),
   ('job_contacts', 'ghl_contact_id'), ('job_contacts', 'client_email'), ('job_contacts', 'client_phone'),
   ('xero_invoices', 'job_contact_id'), ('xero_invoices', 'xero_contact_id'), ('xero_invoices', 'xero_invoice_id'),
   ('xero_invoices', 'invoice_type'), ('xero_invoices', 'amount_due'), ('xero_invoices', 'amount_paid'), ('xero_invoices', 'total'),
   ('xero_invoices', 'fully_paid_on'), ('xero_invoices', 'raw_json'), ('xero_invoices', 'line_items'), ('xero_invoices', 'reference'),
   ('xero_invoices', 'invoice_number'),
   ('makesafe_job_details', 'requesting_company_id'), ('makesafe_job_details', 'requesting_company_slug'),
   ('job_closeout_state', 'outcome'), ('jobs', 'xero_contact_id')) v(t, c) LOOP
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = x.t AND ic.column_name = x.c) THEN
   problems := problems || format('public.%s.%s missing', x.t, x.c);
  END IF;
 END LOOP;
 -- New columns: absent, or this migration's types.
 FOR x IN SELECT ic.column_name AS c, ic.data_type AS t FROM information_schema.columns ic
  WHERE ic.table_schema = 'public' AND ic.table_name = 'context_ledger_items' AND ic.column_name IN ('obligated_party', 'obligation_ref', 'certainty') LOOP
  IF NOT ((x.c IN ('obligated_party', 'obligation_ref') AND x.t = 'jsonb') OR (x.c = 'certainty' AND x.t = 'text')) THEN
   problems := problems || format('context_ledger_items.%s exists as %s', x.c, x.t);
  END IF;
 END LOOP;
 IF to_regclass('public.context_ledger_builder_contacts') IS NOT NULL
  AND coalesce(obj_description(to_regclass('public.context_ledger_builder_contacts'), 'pg_class'), '') NOT LIKE 'Same payer close (20261019130000)%' THEN
  problems := problems || 'public.context_ledger_builder_contacts exists and is not this migration''s'::text;
 END IF;
 -- New functions: absent, or this migration's (comment marker).
 FOR x IN SELECT p.oid::regprocedure::text AS sig, coalesce(obj_description(p.oid, 'pg_proc'), '') AS c
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('context_ledger_same_payer_close_on', 'context_ledger_invoice_kind_of', 'context_ledger_obligation_kind',
    'context_ledger_obligation_class', 'context_ledger_invoice_payer', 'context_ledger_invoice_facts',
    'context_ledger_obligation_job_facts', 'context_ledger_obligation_payer_match', 'context_ledger_obligated_party',
    'context_ledger_obligation_closes') LOOP
  IF x.c NOT LIKE 'Same payer close (20261019130000)%' THEN
   problems := problems || format('%s exists and is not this migration''s', x.sig);
  END IF;
 END LOOP;
 -- The switch is created off: never already on before the first apply.
 IF to_regclass('public.feature_flags') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_ledger_same_payer_close_on()'))
  AND EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_ledger_same_payer_close_v1' AND enabled IS TRUE) THEN
  problems := problems || 'feature flag context_ledger_same_payer_close_v1 is already on before the first apply'::text;
 END IF;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_ledger_same_payer_close_preimage_mismatch: %; read the live definitions before replacing them',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The switch: feature_flags.context_ledger_same_payer_close_v1, created off; missing or unreadable is off.
DO $flag$
BEGIN
 IF to_regclass('public.feature_flags') IS NOT NULL THEN
  INSERT INTO public.feature_flags (flag_name, enabled, description)
  SELECT 'context_ledger_same_payer_close_v1', false,
   'Same payer close (20261019130000): while on, a closing record closes an AI ledger note only when it is of a kind that closes the note''s obligation and its payer (or, for a person''s note, its author) is the note''s obligated party: a neighbour''s, a sister job''s or another payer''s paid invoice, a credit note, a bill, another kind of invoice or "paid" said in words never closes a payment note. A refused close stays open, marked certain or payer not certain. It only ever closes fewer notes. Off: every check is as before. Owner''s word to turn on, after the shadow run (T16 fix 2, design section 6).'
  WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_ledger_same_payer_close_v1');
 END IF;
END $flag$;

CREATE OR REPLACE FUNCTION public.context_ledger_same_payer_close_on()
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE v boolean;
BEGIN
 SELECT bool_and(f.enabled) INTO v FROM public.feature_flags f WHERE f.flag_name = 'context_ledger_same_payer_close_v1';
 RETURN coalesce(v, false);
EXCEPTION WHEN undefined_table OR undefined_column OR insufficient_privilege THEN
 RETURN false;
END $fn$;
COMMENT ON FUNCTION public.context_ledger_same_payer_close_on() IS
 'Same payer close (20261019130000): whether feature_flags.context_ledger_same_payer_close_v1 is on; a missing row, a missing or unreadable table or column is off. Read once per citation, item check and closing transition. Service role only.';

-- 2. The stored columns and the builder contact mapping.
ALTER TABLE public.context_ledger_items ADD COLUMN IF NOT EXISTS obligated_party jsonb;
ALTER TABLE public.context_ledger_items ADD COLUMN IF NOT EXISTS obligation_ref jsonb;
ALTER TABLE public.context_ledger_items ADD COLUMN IF NOT EXISTS certainty text;
DO $chk$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_ledger_items'::regclass AND conname = 'context_ledger_items_certainty_check') THEN
  ALTER TABLE public.context_ledger_items ADD CONSTRAINT context_ledger_items_certainty_check
   CHECK (certainty IS NULL OR certainty IN ('certain', 'payer_not_certain', 'settled_job_needs_person'));
 END IF;
END $chk$;
COMMENT ON COLUMN public.context_ledger_items.obligated_party IS
 'Same payer close (20261019130000): who owes the item, stored at open while context_ledger_same_payer_close_v1 is on: {kind builder_job|party|job_client|all_payers|person|us, key, job_contact_id?, active?, builder?, basis}; null is unknown (the basis is obligation_ref.party_basis) or, with obligation_ref null too, never computed (written while the switch was off).';
COMMENT ON COLUMN public.context_ledger_items.obligation_ref IS
 'Same payer close (20261019130000): the item''s obligation: {class payment|invoice|person|reply|work|other, invoice_id?, invoice_kind?, bound_by? (named: the invoice its words name; opening_invoice: its opening invoice citation, with invoice_kind), named_invoices? (two or more named: unbound), party_basis, reason, held_open?, closing_evidence? (the closing citations a close was refused on)}.';
COMMENT ON COLUMN public.context_ledger_items.certainty IS
 'Same payer close (20261019130000): certain, payer_not_certain (the payer, the party or the money''s source cannot be proven) or settled_job_needs_person (a person''s item on a job finished and paid by the stored close-out outcome); null when never computed.';

CREATE TABLE IF NOT EXISTS public.context_ledger_builder_contacts (
 company_id uuid NOT NULL REFERENCES public.makesafe_companies(id) ON DELETE CASCADE,
 xero_contact_id text NOT NULL CHECK (btrim(xero_contact_id) <> '' AND xero_contact_id = btrim(xero_contact_id)),
 added_by text NOT NULL CHECK (btrim(added_by) <> ''),
 added_at timestamptz NOT NULL DEFAULT now(),
 note text CHECK (note IS NULL OR length(note) <= 300),
 PRIMARY KEY (company_id, xero_contact_id)
);
COMMENT ON TABLE public.context_ledger_builder_contacts IS
 'Same payer close (20261019130000): a builder company''s own Xero contacts (makesafe_companies.id, the company make-safe details name in requesting_company_id), filled by a person, never matched by name. A paid invoice on builder work closes a builder''s payment item only when its xero_contact_id is listed here for that builder. Empty when created: until a builder is listed, its payment and invoice items stay open, payer not certain. Service role only.';
ALTER TABLE public.context_ledger_builder_contacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_ledger_builder_contacts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.context_ledger_builder_contacts TO service_role;

-- 3. The invoice kind: a mirror of the Debt tab's one reader, invoiceKindOf
-- (supabase/functions/ops-api/debt_ws_rules.ts), pinned by one fixture table
-- (ops-api/invoice_kind_fixtures.ts) that this migration's contract and the TypeScript test share.
CREATE OR REPLACE FUNCTION public.context_ledger_invoice_kind_of(p_reference text, p_description text)
RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
 WITH seg AS (
  SELECT s.v, (row_number() OVER (ORDER BY s.o)) - 1 AS i
  FROM (SELECT regexp_replace(x.v, '^\s+|\s+$', '', 'g') AS v, x.o
        FROM regexp_split_to_table(upper(coalesce(p_reference, '')), '-') WITH ORDINALITY AS x(v, o)) s
  WHERE s.v <> ''
 ), e AS (
  SELECT coalesce(regexp_replace((regexp_split_to_array(
    (SELECT seg.v FROM seg WHERE NOT (seg.i > 0 AND seg.v ~ '^[A-Z]$') ORDER BY seg.i DESC LIMIT 1), '\s+'))[1],
    '[^A-Z0-9]', '', 'g'), '') AS ending,
   lower(regexp_replace(coalesce(p_description, ''), '^\s+|\s+$', '', 'g')) AS d
 )
 SELECT CASE
  WHEN e.ending = '' OR e.d = '' THEN jsonb_build_object('kind', NULL, 'stage', NULL)
  WHEN e.ending ~ '^(?:(?:FIN|FINBAL|BAL)[0-9]{0,3}|FINAL|PRIVATE)$' THEN
   CASE WHEN starts_with(e.d, 'balance') OR starts_with(e.d, 'remaining') OR starts_with(e.d, 'remainder')
        THEN jsonb_build_object('kind', 'final', 'stage', NULL) ELSE jsonb_build_object('kind', NULL, 'stage', NULL) END
  WHEN e.ending ~ '^DEP[0-9]{0,3}$' THEN
   CASE WHEN starts_with(e.d, 'deposit') THEN jsonb_build_object('kind', 'not_final', 'stage', 'deposit') ELSE jsonb_build_object('kind', NULL, 'stage', NULL) END
  WHEN e.ending ~ '^MAT[0-9]{0,3}$' THEN
   CASE WHEN starts_with(e.d, 'materials') THEN jsonb_build_object('kind', 'not_final', 'stage', 'materials') ELSE jsonb_build_object('kind', NULL, 'stage', NULL) END
  WHEN e.ending ~ '^PROG[0-9]{0,3}$' THEN
   CASE WHEN starts_with(e.d, 'progress') THEN jsonb_build_object('kind', 'not_final', 'stage', 'progress') ELSE jsonb_build_object('kind', NULL, 'stage', NULL) END
  WHEN e.ending = 'PLAN' THEN
   CASE WHEN starts_with(e.d, 'planning fee') THEN jsonb_build_object('kind', 'not_final', 'stage', 'planning fee') ELSE jsonb_build_object('kind', NULL, 'stage', NULL) END
  WHEN e.ending = 'VAR' THEN
   CASE WHEN starts_with(e.d, 'extra labour') THEN jsonb_build_object('kind', 'not_final', 'stage', 'extra labour') ELSE jsonb_build_object('kind', NULL, 'stage', NULL) END
  ELSE jsonb_build_object('kind', NULL, 'stage', NULL) END
 FROM e
$fn$;
COMMENT ON FUNCTION public.context_ledger_invoice_kind_of(text, text) IS
 'Same payer close (20261019130000): the SQL twin of the Debt tab''s invoiceKindOf (ops-api/debt_ws_rules.ts): the reference''s ending (upper case, split on "-", trimmed, a single letter after the first segment is the neighbour letter, the first word of the last other segment with everything but A-Z and 0-9 removed) and the first line''s description (trimmed, lower case) must agree: FIN, FINBAL, BAL (up to three digits), FINAL or PRIVATE with a description starting balance, remaining or remainder is final; DEP, MAT, PROG (up to three digits), PLAN, VAR with deposit, materials, progress, planning fee, extra labour is not_final with that stage; anything else {kind null, stage null}. One fixture table (ops-api/invoice_kind_fixtures.ts) proves both. Inlinable helper.';

CREATE OR REPLACE FUNCTION public.context_ledger_obligation_kind(p_reference text, p_description text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
 SELECT CASE WHEN k.v ->> 'kind' = 'final' THEN 'final'
             WHEN k.v ->> 'stage' = 'deposit' THEN 'deposit'
             WHEN k.v ->> 'stage' = 'extra labour' THEN 'variation'
             ELSE k.v ->> 'stage' END
 FROM (SELECT public.context_ledger_invoice_kind_of(p_reference, p_description) AS v) k
$fn$;
COMMENT ON FUNCTION public.context_ledger_obligation_kind(text, text) IS
 'Same payer close (20261019130000): an invoice''s obligation kind from context_ledger_invoice_kind_of: final, deposit, variation (the extra labour stage), the other stages by name (materials, progress, planning fee), null when the kind reader cannot tell. A payment item bound to a kind closes only on a paid invoice of that kind. Inlinable helper.';

CREATE OR REPLACE FUNCTION public.context_ledger_obligation_class(p_closes_on text, p_blocks text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
 SELECT CASE WHEN p_closes_on = 'payment' OR (coalesce(p_closes_on, 'none') = 'none' AND p_blocks IN ('payment', 'deposit')) THEN 'payment'
             WHEN p_closes_on = 'invoice_issued' THEN 'invoice'
             WHEN p_closes_on = 'person' THEN 'person'
             WHEN p_closes_on IN ('reply', 'call') THEN 'reply'
             WHEN p_closes_on IN ('work_done', 'visit') THEN 'work'
             ELSE 'other' END
$fn$;
COMMENT ON FUNCTION public.context_ledger_obligation_class(text, text) IS
 'Same payer close (20261019130000): an item''s obligation class: payment (closes_on payment, or none or null with blocks payment or deposit), invoice (invoice_issued), person (person), reply (reply, call), work (work_done, visit), other. Inlinable helper.';

-- 4. The payer of an invoice on a job.
CREATE OR REPLACE FUNCTION public.context_ledger_invoice_payer(p_job_id uuid, p_job_contact_id uuid, p_xero_contact_id text)
RETURNS jsonb
LANGUAGE sql STABLE
AS $fn$
 WITH b AS (
  SELECT md.requesting_company_id AS company_id FROM public.makesafe_job_details md
  WHERE md.job_id = p_job_id AND (md.requesting_company_id IS NOT NULL OR nullif(btrim(md.requesting_company_slug), '') IS NOT NULL)
 ), pa AS (
  SELECT p.id, (p.removed_at IS NULL AND coalesce(p.status, '') <> 'removed') AS active,
   (coalesce(p.is_primary, false) OR coalesce(p.party_role = 'owner', false) OR coalesce(p.source_party_key = 'primary', false)) AS owner,
   nullif(btrim(p.xero_contact_id), '') AS x
  FROM public.job_contacts p WHERE p.job_id = p_job_id
 ), c AS (
  SELECT nullif(btrim(p_xero_contact_id), '') AS x,
   (SELECT nullif(btrim(jb.xero_contact_id), '') FROM public.jobs jb WHERE jb.id = p_job_id) AS client_x
 )
 SELECT CASE
  WHEN EXISTS (SELECT 1 FROM b JOIN public.context_ledger_builder_contacts bc ON bc.company_id = b.company_id WHERE bc.xero_contact_id = c.x)
   THEN jsonb_build_object('kind', 'builder', 'basis', 'builder_contact')
  WHEN p_job_contact_id IS NOT NULL THEN
   CASE WHEN EXISTS (SELECT 1 FROM pa WHERE pa.id = p_job_contact_id)
        THEN jsonb_build_object('kind', 'party', 'id', p_job_contact_id, 'basis', 'job_contact_id')
        ELSE jsonb_build_object('kind', 'unknown', 'basis', 'job_contact_off_job') END
  WHEN c.x IS NULL THEN jsonb_build_object('kind', 'unknown', 'basis', CASE WHEN EXISTS (SELECT 1 FROM b) THEN 'builder_contact_unmapped' ELSE 'no_contact' END)
  WHEN (SELECT count(*) FROM pa WHERE pa.active AND pa.x = c.x) = 1
   THEN jsonb_build_object('kind', 'party', 'id', (SELECT pa.id FROM pa WHERE pa.active AND pa.x = c.x), 'basis', 'xero_contact')
  WHEN (SELECT count(*) FROM pa WHERE pa.active AND pa.x = c.x) > 1 THEN jsonb_build_object('kind', 'unknown', 'basis', 'ambiguous_contact')
  WHEN c.client_x = c.x THEN
   CASE WHEN EXISTS (SELECT 1 FROM b) OR NOT EXISTS (SELECT 1 FROM pa WHERE pa.active)
         THEN jsonb_build_object('kind', 'job_client', 'basis', 'job_contact')
        WHEN (SELECT count(*) FROM pa WHERE pa.active AND pa.owner) = 1
         THEN jsonb_build_object('kind', 'party', 'id', (SELECT pa.id FROM pa WHERE pa.active AND pa.owner), 'basis', 'job_contact_owner')
        ELSE jsonb_build_object('kind', 'unknown', 'basis', 'no_owner_marker') END
  WHEN EXISTS (SELECT 1 FROM b) THEN jsonb_build_object('kind', 'unknown', 'basis', 'builder_contact_unmapped')
  ELSE jsonb_build_object('kind', 'unknown', 'basis', 'contact_not_on_job') END
 FROM c
$fn$;
COMMENT ON FUNCTION public.context_ledger_invoice_payer(uuid, uuid, text) IS
 'Same payer close (20261019130000): who an invoice on a job bills, in order: the builder (kind builder) when its Xero contact is one of the job''s builder''s own contacts (context_ledger_builder_contacts for makesafe_job_details.requesting_company_id); the party named by job_contact_id (unknown when that party is not on the job); no Xero contact: unknown (builder_contact_unmapped on builder work, else no_contact); the one active party carrying the contact (two or more: unknown, ambiguous_contact); the job''s own Xero contact: job_client on builder work or with no active party, the owner when exactly one active party carries the owner marker (is_primary, party_role owner or source_party_key primary), else unknown (no_owner_marker); anything else unknown (builder_contact_unmapped on builder work, else contact_not_on_job). Never "assume the owner paid": a contact differing from the job''s, or none, is unknown. Service role only.';

CREATE OR REPLACE FUNCTION public.context_ledger_invoice_facts(x public.xero_invoices)
RETURNS jsonb
LANGUAGE sql STABLE
AS $fn$
 SELECT jsonb_build_object('id', x.id, 'type', a.t, 'status', a.s, 'accrec', a.t = 'ACCREC', 'credit_note', a.t LIKE '%CREDIT',
  'issued', a.s IN ('AUTHORISED', 'SUBMITTED', 'PAID'), 'voided', a.s IN ('VOIDED', 'DELETED'),
  'paid', p.paid, 'owed', o.owed, 'partial', o.owed AND coalesce(x.amount_paid, 0) > 0,
  'zero_balance', a.s IN ('AUTHORISED', 'SUBMITTED', 'PAID') AND NOT p.paid AND NOT o.owed,
  'credit', CASE WHEN jsonb_typeof(x.raw_json -> 'CreditNotes') = 'array' AND jsonb_array_length(x.raw_json -> 'CreditNotes') > 0 THEN true
                 WHEN (x.raw_json ->> 'AmountCredited') ~ '^[0-9]+(\.[0-9]+)?$' THEN (x.raw_json ->> 'AmountCredited')::numeric > 0
                 ELSE false END,
  'other_money', EXISTS (SELECT 1 FROM jsonb_array_elements(
     CASE WHEN jsonb_typeof(x.raw_json -> 'Overpayments') = 'array' THEN x.raw_json -> 'Overpayments' ELSE '[]'::jsonb END
     || CASE WHEN jsonb_typeof(x.raw_json -> 'Prepayments') = 'array' THEN x.raw_json -> 'Prepayments' ELSE '[]'::jsonb END) m
    WHERE nullif(btrim(coalesce(m #>> '{Contact,ContactID}', m ->> 'ContactID')), '') IS DISTINCT FROM nullif(btrim(x.xero_contact_id), '')),
  'kind', public.context_ledger_obligation_kind(x.reference, x.line_items -> 0 ->> 'Description'),
  'payer', public.context_ledger_invoice_payer(x.job_id, x.job_contact_id, x.xero_contact_id),
  'paid_at', CASE WHEN p.paid THEN least((x.fully_paid_on::timestamp AT TIME ZONE 'Australia/Perth'), now()) END,
  'amount_paid', x.amount_paid, 'amount_due', x.amount_due,
  'number', nullif(btrim(x.invoice_number), ''), 'reference', nullif(btrim(x.reference), ''))
 FROM (SELECT upper(coalesce(x.invoice_type, '')) AS t, upper(coalesce(x.status, '')) AS s) a,
  LATERAL (SELECT (a.s = 'PAID' AND x.fully_paid_on IS NOT NULL AND coalesce(x.amount_due, 0) <= 0) AS paid) p,
  LATERAL (SELECT (a.s IN ('AUTHORISED', 'SUBMITTED', 'PAID') AND NOT p.paid AND coalesce(x.amount_due, x.total, 1) > 0) AS owed) o
$fn$;
COMMENT ON FUNCTION public.context_ledger_invoice_facts(public.xero_invoices) IS
 'Same payer close (20261019130000): one invoice''s facts for the obligation verdict: type and status in upper case, accrec, credit_note (a credit type), issued (AUTHORISED, SUBMITTED, PAID), voided (VOIDED, DELETED), paid (PAID with a paid day and nothing due), owed (issued, not paid, an amount still due), partial (owed with something paid), zero_balance (issued, not paid, nothing due: a credit or a write-off, never a payment), credit (Xero credited it), other_money (an overpayment or prepayment allocated to it from another or no named Xero contact), kind (context_ledger_obligation_kind on the reference and the first line''s description), payer (context_ledger_invoice_payer), paid_at (its paid day''s Perth midnight, never after now), number and reference (the invoice number and Xero reference, read only to bind an item to the invoice it names). Service role only.';

CREATE OR REPLACE FUNCTION public.context_ledger_obligation_job_facts(p_job_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE
AS $fn$
 SELECT jsonb_build_object('job_id', jb.id,
  'builder', (SELECT jsonb_build_object('company_id', md.requesting_company_id,
     'mapped', EXISTS (SELECT 1 FROM public.context_ledger_builder_contacts bc WHERE bc.company_id = md.requesting_company_id))
    FROM public.makesafe_job_details md
    WHERE md.job_id = jb.id AND (md.requesting_company_id IS NOT NULL OR nullif(btrim(md.requesting_company_slug), '') IS NOT NULL)),
  'parties', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'key', p.source_party_key,
      'active', (p.removed_at IS NULL AND coalesce(p.status, '') <> 'removed'),
      'owner', (coalesce(p.is_primary, false) OR coalesce(p.party_role = 'owner', false) OR coalesce(p.source_party_key = 'primary', false)),
      'paying', (p.share_percentage IS NULL OR p.share_percentage > 0),
      'ghl', nullif(btrim(p.ghl_contact_id), ''), 'email_key', public.context_email_key(p.client_email),
      'phone_key', public.context_phone_key(p.client_phone)) ORDER BY p.created_at, p.id)
    FROM public.job_contacts p WHERE p.job_id = jb.id), '[]'::jsonb),
  'settled', EXISTS (SELECT 1 FROM public.job_closeout_state cs WHERE cs.job_id = jb.id AND cs.outcome = 'paid')
    AND coalesce(jb.status, '') IN ('complete', 'completed', 'get_review', 'archived'),
  'invoices', coalesce((SELECT jsonb_agg(public.context_ledger_invoice_facts(x) ORDER BY x.id)
    FROM public.xero_invoices x WHERE x.job_id = jb.id), '[]'::jsonb))
 FROM public.jobs jb WHERE jb.id = p_job_id
$fn$;
COMMENT ON FUNCTION public.context_ledger_obligation_job_facts(uuid) IS
 'Same payer close (20261019130000): what the obligation verdict knows of a job, read once per check: builder (make-safe details name a builder: its company and whether any of its own Xero contacts is listed), parties (job_contacts: active when not removed, owner by the live owner marker, paying unless its share is an explicit 0, CRM contact, email and phone keys), settled (the stored close-out outcome, job_closeout_state.outcome paid, on a job at complete, completed, get_review or archived; never re-derived) and every invoice on the job (context_ledger_invoice_facts). Never reads another job. Service role only.';

-- 5. The verdict.
CREATE OR REPLACE FUNCTION public.context_ledger_obligation_payer_match(p_payer jsonb, p_obligated jsonb, p_job jsonb)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $fn$
 SELECT CASE
  WHEN p_obligated IS NULL OR jsonb_typeof(p_obligated) <> 'object' OR p_payer IS NULL THEN 'unproven'
  WHEN p_payer ->> 'kind' = 'unknown' THEN 'unproven'
  WHEN p_obligated ->> 'kind' = 'builder_job' THEN
   CASE WHEN p_payer ->> 'kind' = 'builder' THEN 'match' WHEN p_payer ->> 'kind' = 'job_client' THEN 'unproven' ELSE 'other' END
  WHEN p_obligated ->> 'kind' = 'party' THEN
   CASE WHEN p_payer ->> 'kind' = 'party' AND p_payer ->> 'id' = p_obligated ->> 'job_contact_id' THEN 'match'
        WHEN p_payer ->> 'kind' IN ('party', 'builder') THEN 'other' ELSE 'unproven' END
  WHEN p_obligated ->> 'kind' = 'job_client' THEN
   CASE WHEN p_payer ->> 'kind' = 'job_client' THEN 'match' WHEN p_payer ->> 'kind' = 'builder' THEN 'other' ELSE 'unproven' END
  WHEN p_obligated ->> 'kind' = 'all_payers' THEN
   CASE WHEN p_payer ->> 'kind' = 'party' AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_job -> 'parties', '[]'::jsonb)) q
          WHERE q ->> 'id' = p_payer ->> 'id' AND (q ->> 'active')::boolean AND (q ->> 'paying')::boolean) THEN 'match'
        WHEN p_payer ->> 'kind' IN ('party', 'builder') THEN 'other' ELSE 'unproven' END
  ELSE 'other' END
$fn$;
COMMENT ON FUNCTION public.context_ledger_obligation_payer_match(jsonb, jsonb, jsonb) IS
 'Same payer close (20261019130000): whether an invoice''s payer (context_ledger_invoice_payer) is an item''s obligated party: match, other (certainly someone else: another party, the builder for a customer''s item, anyone but the builder for builder work) or unproven (an unknown payer or obligated party, the job client against a named party, or the job client against builder work: the job''s own contact may be the builder''s). all_payers matches any active paying party. Pure.';

CREATE OR REPLACE FUNCTION public.context_ledger_obligated_party(p_item jsonb, p_open_facts jsonb, p_job jsonb)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
AS $fn$
DECLARE v_class text; v_ref jsonb; f jsonb; v_first jsonb; v_inv jsonb; v_payer jsonb; v_of jsonb; v_ob jsonb;
 v_matches jsonb; v_active jsonb; v_basis text; v_author text; v_parties jsonb := coalesce(p_job -> 'parties', '[]'::jsonb);
 v_n_active integer; v_n_nonowner integer; v_owner jsonb; v_n_owner integer; v_outside boolean;
 v_text text; v_tail text; v_named jsonb;
BEGIN
 v_class := public.context_ledger_obligation_class(p_item ->> 'closes_on', p_item ->> 'blocks');
 v_ref := jsonb_build_object('class', v_class);
 IF v_class NOT IN ('payment', 'invoice', 'person') THEN
  RETURN jsonb_build_object('obligated_party', NULL, 'obligation_ref', v_ref);
 END IF;
 v_first := coalesce(p_open_facts -> 0, '{}'::jsonb);
 v_of := coalesce(v_first -> 'obligation_facts', '{}'::jsonb);
 IF v_class = 'person' THEN
  v_author := nullif(v_of ->> 'author', '');
  IF v_author IS NOT NULL AND (coalesce((v_first ->> 'ours')::boolean, false) OR coalesce((v_first ->> 'call_or_note')::boolean, false)
    OR coalesce((v_first ->> 'record')::boolean, false)) THEN
   RETURN jsonb_build_object('obligated_party', jsonb_build_object('kind', 'person', 'key', v_author, 'basis', 'opening_author'),
    'obligation_ref', v_ref || jsonb_build_object('party_basis', 'opening_author'));
  END IF;
  -- (review r2) our own message with no named sender: owed by us, closed by a later row of ours
  IF coalesce((v_first ->> 'ours')::boolean, false) AND NOT coalesce((v_first ->> 'record')::boolean, false) THEN
   RETURN jsonb_build_object('obligated_party', jsonb_build_object('kind', 'us', 'key', 'us', 'basis', 'opening_ours_unnamed'),
    'obligation_ref', v_ref || jsonb_build_object('party_basis', 'opening_ours_unnamed'));
  END IF;
  RETURN jsonb_build_object('obligated_party', NULL, 'obligation_ref', v_ref || jsonb_build_object('party_basis', 'no_author'));
 END IF;
 -- (review r3, M4) a payment item is bound to the one invoice of this job it names: its invoice number
 -- or Xero reference as a whole token (letters, digits and hyphens on neither side, so never a
 -- substring) of the item's words or an opening excerpt, or the about key's tail (invoice:... or
 -- payment:...) equal to it in key form. Two or more named: unbound.
 IF v_class = 'payment' THEN
  v_text := concat_ws(' ', p_item ->> 'what', (SELECT string_agg(x #>> '{cite,excerpt}', ' ')
   FROM jsonb_array_elements(coalesce(p_open_facts, '[]'::jsonb)) x));
  v_tail := substring(coalesce(p_item ->> 'about_key', '') FROM '^(?:invoice|payment):(.+)$');
  SELECT coalesce(jsonb_agg(q), '[]'::jsonb) INTO v_named FROM jsonb_array_elements(coalesce(p_job -> 'invoices', '[]'::jsonb)) q
  WHERE coalesce((q ->> 'accrec')::boolean, false) AND NOT coalesce((q ->> 'credit_note')::boolean, false) AND EXISTS (
   SELECT 1 FROM unnest(ARRAY[q ->> 'number', q ->> 'reference']) t(v)
   WHERE length(t.v) >= 4 AND t.v ~ '[0-9]'
    AND (coalesce(v_text, '') ~* ('(^|[^A-Za-z0-9-])' || regexp_replace(t.v, '([^A-Za-z0-9 ])', '\\\1', 'g') || '($|[^A-Za-z0-9-])')
     OR v_tail = btrim(regexp_replace(lower(t.v), '[^a-z0-9]+', '-', 'g'), '-')));
  IF jsonb_array_length(v_named) = 1 THEN
   v_ref := v_ref || jsonb_build_object('invoice_id', v_named -> 0 ->> 'id', 'bound_by', 'named');
   v_payer := v_named -> 0 -> 'payer';
  ELSIF jsonb_array_length(v_named) > 1 THEN
   v_ref := v_ref || jsonb_build_object('named_invoices', jsonb_array_length(v_named));
  END IF;
 END IF;
 -- An opening invoice citation binds the item to that invoice and its kind.
 FOR f IN SELECT x FROM jsonb_array_elements(coalesce(p_open_facts, '[]'::jsonb)) x LOOP
  EXIT WHEN v_ref ? 'invoice_id';
  IF f #>> '{cite,table}' = 'xero_invoices' THEN
   SELECT q INTO v_inv FROM jsonb_array_elements(coalesce(p_job -> 'invoices', '[]'::jsonb)) q WHERE q ->> 'id' = f #>> '{cite,id}' LIMIT 1;
   IF v_inv IS NOT NULL THEN
    v_ref := v_ref || jsonb_build_object('invoice_id', v_inv ->> 'id', 'invoice_kind', v_inv ->> 'kind', 'bound_by', 'opening_invoice');
    v_payer := v_inv -> 'payer';
    EXIT;
   END IF;
  END IF;
 END LOOP;
 SELECT count(*) FILTER (WHERE (q ->> 'active')::boolean), count(*) FILTER (WHERE (q ->> 'active')::boolean AND NOT (q ->> 'owner')::boolean),
  count(*) FILTER (WHERE (q ->> 'active')::boolean AND (q ->> 'owner')::boolean)
 INTO v_n_active, v_n_nonowner, v_n_owner FROM jsonb_array_elements(v_parties) q;
 IF v_n_owner = 1 THEN
  SELECT q INTO v_owner FROM jsonb_array_elements(v_parties) q WHERE (q ->> 'active')::boolean AND (q ->> 'owner')::boolean;
 END IF;
 IF jsonb_typeof(p_job -> 'builder') = 'object' THEN
  v_ob := jsonb_build_object('kind', 'builder_job', 'key', p_job ->> 'job_id', 'builder', p_job #> '{builder,company_id}', 'basis', 'builder_work');
 ELSIF v_payer IS NOT NULL THEN
  IF v_payer ->> 'kind' = 'party' THEN
   SELECT jsonb_build_object('kind', 'party', 'key', q ->> 'id', 'job_contact_id', q ->> 'id', 'active', (q ->> 'active')::boolean, 'basis', 'opening_invoice')
   INTO v_ob FROM jsonb_array_elements(v_parties) q WHERE q ->> 'id' = v_payer ->> 'id';
  ELSIF v_payer ->> 'kind' = 'job_client' THEN
   v_ob := jsonb_build_object('kind', 'job_client', 'key', p_job ->> 'job_id', 'basis', 'opening_invoice');
  ELSE
   v_basis := 'opening_invoice_' || coalesce(v_payer ->> 'basis', 'payer_unknown');
  END IF;
 ELSE
  v_outside := NOT (coalesce((v_first ->> 'ours')::boolean, false) OR coalesce((v_first ->> 'call_or_note')::boolean, false)
   OR coalesce((v_first ->> 'record')::boolean, false));
  IF v_outside THEN
   -- the sender's CRM contact, else email key, else phone key
   SELECT coalesce(jsonb_agg(q), '[]'::jsonb) INTO v_matches FROM jsonb_array_elements(v_parties) q
   WHERE v_of ->> 'ghl' IS NOT NULL AND q ->> 'ghl' = v_of ->> 'ghl';
   IF jsonb_array_length(v_matches) = 0 THEN
    SELECT coalesce(jsonb_agg(q), '[]'::jsonb) INTO v_matches FROM jsonb_array_elements(v_parties) q
    WHERE v_of ->> 'email_key' IS NOT NULL AND q ->> 'email_key' = v_of ->> 'email_key';
   END IF;
   IF jsonb_array_length(v_matches) = 0 THEN
    SELECT coalesce(jsonb_agg(q), '[]'::jsonb) INTO v_matches FROM jsonb_array_elements(v_parties) q
    WHERE v_of ->> 'phone_key' IS NOT NULL AND q ->> 'phone_key' = v_of ->> 'phone_key';
   END IF;
   SELECT coalesce(jsonb_agg(q), '[]'::jsonb) INTO v_active FROM jsonb_array_elements(v_matches) q WHERE (q ->> 'active')::boolean;
   IF jsonb_array_length(v_active) = 1 OR (jsonb_array_length(v_active) = 0 AND jsonb_array_length(v_matches) = 1) THEN
    f := CASE WHEN jsonb_array_length(v_active) = 1 THEN v_active -> 0 ELSE v_matches -> 0 END;
    v_ob := jsonb_build_object('kind', 'party', 'key', f ->> 'id', 'job_contact_id', f ->> 'id', 'active', (f ->> 'active')::boolean, 'basis', 'sender');
   ELSIF jsonb_array_length(v_matches) > 1 THEN
    v_basis := 'ambiguous_sender';
   ELSIF v_n_active = 0 THEN
    v_ob := jsonb_build_object('kind', 'job_client', 'key', p_job ->> 'job_id', 'basis', 'no_parties');
   ELSIF v_n_nonowner > 0 THEN
    v_basis := 'unmatched_sender';
   ELSIF v_owner IS NOT NULL THEN
    v_ob := jsonb_build_object('kind', 'party', 'key', v_owner ->> 'id', 'job_contact_id', v_owner ->> 'id', 'active', true, 'basis', 'owner_no_neighbour');
   ELSE
    v_basis := 'no_owner_marker';
   END IF;
  ELSE
   -- our own note, a call or a record: whoever pays on the job
   IF v_n_active = 0 THEN
    v_ob := jsonb_build_object('kind', 'job_client', 'key', p_job ->> 'job_id', 'basis', 'no_parties');
   ELSIF v_n_nonowner > 0 THEN
    v_ob := jsonb_build_object('kind', 'all_payers', 'key', p_job ->> 'job_id', 'basis', 'ours_several_parties');
   ELSIF v_owner IS NOT NULL THEN
    v_ob := jsonb_build_object('kind', 'party', 'key', v_owner ->> 'id', 'job_contact_id', v_owner ->> 'id', 'active', true, 'basis', 'owner_no_neighbour');
   ELSE
    v_basis := 'no_owner_marker';
   END IF;
  END IF;
 END IF;
 RETURN jsonb_build_object('obligated_party', v_ob,
  'obligation_ref', v_ref || jsonb_build_object('party_basis', coalesce(v_ob ->> 'basis', v_basis, 'payer_unknown')));
END $fn$;
COMMENT ON FUNCTION public.context_ledger_obligated_party(jsonb, jsonb, jsonb) IS
 'Same payer close (20261019130000): an item''s obligated party and obligation from its closes_on and blocks, its opening citations'' facts (the citation check''s, with obligation_facts) and the job''s facts (context_ledger_obligation_job_facts): {obligated_party, obligation_ref {class, invoice_id?, invoice_kind?, party_basis}}. Only payment, invoice and person items carry a party. Person: the first opening note''s, text''s or email''s author (ours, a call, a note or a record); our own message with no named sender: us (opening_ours_unnamed); else unknown (no_author). Builder work: builder_job, this job''s own obligation. A payment item naming exactly one of the job''s invoices (its number or Xero reference as a whole token of the item''s words or an opening excerpt, never a substring, or the about key''s tail in key form) is bound to it (obligation_ref.invoice_id, bound_by named) and that invoice names its payer (review r3, M4); else an opening invoice citation binds the item to that invoice and its kind and names its payer (bound_by opening_invoice). A message from outside: the party its sender matches (CRM contact, else email key, else phone key; an active match wins, a single retired one is kept), else the job client with no active party, unknown with an active non-owner party (unmatched_sender) or several matches (ambiguous_sender), else the one active owner, else unknown (no_owner_marker). Our own row, a call, a note or a record: the job client with no active party, every paying party (all_payers) with an active non-owner party, else the one active owner, else unknown. Pure.';

CREATE OR REPLACE FUNCTION public.context_ledger_obligation_closes(p_item jsonb, p_cite_facts jsonb)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
AS $fn$
DECLARE v_class text; v_ob jsonb := nullif(p_item -> 'obligated_party', 'null'::jsonb);
 v_ref jsonb := coalesce(nullif(p_item -> 'obligation_ref', 'null'::jsonb), '{}'::jsonb);
 v_job jsonb := coalesce(p_cite_facts -> 'job', '{}'::jsonb); v_cites jsonb := coalesce(p_cite_facts -> 'cites', '[]'::jsonb);
 v_invs jsonb; v_bound_id text; v_bound_kind text; f jsonb; v_inv jsonb; v_tbl text; v_of jsonb; v_m text; n integer := 0; n_ok integer := 0;
 v_closes boolean; v_neg boolean := false; v_unproven boolean := false; v_neg_reason text; v_unp_reason text;
 v_covered text[] := '{}'; v_reason text; v_ok boolean; v_cert boolean; q jsonb; v_own jsonb; v_any_owed boolean;
 v_any_partial boolean; v_any_issued boolean; v_any_voided boolean; v_any_zero boolean; v_last_paid timestamptz; v_party_short boolean := false;
 v_evidence jsonb := '[]'::jsonb; v_cited text[] := '{}'; v_ci text[]; v_tail text; v_cited_owed boolean := false; v_other jsonb := '[]'::jsonb;
BEGIN
 v_class := coalesce(v_ref ->> 'class', public.context_ledger_obligation_class(p_item ->> 'closes_on', p_item ->> 'blocks'));
 v_invs := coalesce(v_job -> 'invoices', '[]'::jsonb);
 v_bound_id := v_ref ->> 'invoice_id'; v_bound_kind := v_ref ->> 'invoice_kind';
 -- (review r3, M4) an unbound payment item about one invoice (about key invoice:..., or payment:<kind> with
 -- the one cited invoice of that kind) is bound to the one invoice it cites
 IF v_class = 'payment' AND v_bound_id IS NULL THEN
  SELECT array_agg(DISTINCT x #>> '{cite,id}') INTO v_ci FROM jsonb_array_elements(v_cites) x WHERE x #>> '{cite,table}' = 'xero_invoices';
  v_tail := substring(coalesce(p_item ->> 'about_key', '') FROM '^payment:(.*)$');
  IF cardinality(v_ci) = 1 THEN
   SELECT x INTO v_inv FROM jsonb_array_elements(v_invs) x WHERE x ->> 'id' = v_ci[1] LIMIT 1;
   IF v_inv IS NOT NULL AND (coalesce(p_item ->> 'about_key', '') LIKE 'invoice:%'
     OR (v_tail IS NOT NULL AND v_inv ->> 'kind' IS NOT NULL
         AND replace(CASE WHEN v_tail = 'balance' THEN 'final' ELSE v_tail END, '-', ' ') = v_inv ->> 'kind')) THEN
    v_bound_id := v_ci[1];
   END IF;
   v_inv := NULL;
  END IF;
 END IF;
 -- each closing citation on its own
 FOR f IN SELECT x FROM jsonb_array_elements(v_cites) x LOOP
  n := n + 1; v_tbl := f #>> '{cite,table}'; v_of := coalesce(f -> 'obligation_facts', '{}'::jsonb);
  v_ok := true; v_cert := false; v_reason := NULL; v_inv := NULL;
  IF v_tbl = 'xero_invoices' OR (v_tbl = 'job_events' AND v_class = 'payment') THEN
   SELECT x INTO v_inv FROM jsonb_array_elements(v_invs) x
   WHERE x ->> 'id' = CASE WHEN v_tbl = 'xero_invoices' THEN f #>> '{cite,id}' ELSE v_of ->> 'invoice_id' END LIMIT 1;
   IF v_inv IS NOT NULL THEN v_cited := v_cited || (v_inv ->> 'id'); END IF;
  END IF;
  IF v_class = 'payment' THEN
   IF v_tbl IN ('business_events', 'inbox_events') THEN v_ok := false; v_reason := 'claim_not_record';
   ELSIF v_tbl NOT IN ('xero_invoices', 'job_events') THEN v_ok := false; v_cert := true; v_reason := 'wrong_record_kind';
   ELSIF v_inv IS NULL THEN v_ok := false; v_reason := CASE WHEN v_tbl = 'job_events' THEN 'payer_unknown' ELSE 'invoice_not_read' END;
   ELSIF (v_inv ->> 'credit_note')::boolean THEN v_ok := false; v_reason := 'credit_note';
   ELSIF NOT (v_inv ->> 'accrec')::boolean THEN v_ok := false; v_cert := true; v_reason := 'not_customer_invoice';
   ELSIF (v_inv ->> 'voided')::boolean THEN v_ok := false; v_cert := true; v_reason := 'voided';
   ELSIF NOT (v_inv ->> 'paid')::boolean THEN v_ok := false; v_cert := (v_inv ->> 'owed')::boolean;
    v_reason := CASE WHEN (v_inv ->> 'partial')::boolean THEN 'partially_paid' WHEN (v_inv ->> 'owed')::boolean THEN 'invoice_unpaid' ELSE 'zero_balance' END;
   ELSIF (v_inv ->> 'credit')::boolean OR (v_inv ->> 'other_money')::boolean THEN v_ok := false; v_reason := 'other_money_allocated';
   ELSE
    -- (review r3, M4) the invoice the item is bound to is its own payer's obligation
    v_m := CASE WHEN v_bound_id IS NOT NULL AND v_inv ->> 'id' = v_bound_id THEN 'match'
                ELSE public.context_ledger_obligation_payer_match(v_inv -> 'payer', v_ob, v_job) END;
    IF v_m = 'other' THEN v_ok := false; v_cert := true; v_reason := 'other_payer';
    ELSIF v_m = 'unproven' THEN v_ok := false; v_reason := 'payer_' || coalesce(v_inv #>> '{payer,basis}', 'unknown');
    ELSIF v_bound_id IS NOT NULL AND NOT (v_inv ->> 'id' = v_bound_id OR (v_bound_kind IS NOT NULL AND v_inv ->> 'kind' = v_bound_kind)) THEN
     v_ok := false; v_cert := true; v_reason := 'other_obligation';
    ELSE
     v_covered := v_covered || coalesce(v_inv #>> '{payer,id}', v_inv #>> '{payer,kind}');
    END IF;
   END IF;
  ELSIF v_class = 'invoice' THEN
   IF v_tbl = 'xero_invoices' THEN
    IF v_inv IS NULL THEN v_ok := false; v_reason := 'invoice_not_read';
    ELSIF NOT (v_inv ->> 'accrec')::boolean THEN v_ok := false; v_cert := true; v_reason := 'not_customer_invoice';
    ELSE
     v_m := public.context_ledger_obligation_payer_match(v_inv -> 'payer', v_ob, v_job);
     IF v_m = 'other' THEN v_ok := false; v_cert := true; v_reason := 'other_payer';
     ELSIF v_m = 'unproven' THEN v_ok := false; v_reason := 'payer_' || coalesce(v_inv #>> '{payer,basis}', 'unknown');
     END IF;
    END IF;
   END IF;
  ELSIF v_class = 'person' THEN
   -- (review r2) a record never certainly answers a person: it is kept as evidence (record_not_person)
   -- (review r3, M7) the customer the item is owed to releasing or declining it never closes it and is
   -- never certain evidence that it is still owed
   IF v_ob IS NULL THEN v_ok := false; v_reason := CASE WHEN v_tbl IN ('business_events', 'inbox_events') THEN 'no_author' ELSE 'record_not_person' END;
   ELSIF v_ob ->> 'kind' = 'us' AND ((v_tbl IN ('business_events', 'inbox_events') AND coalesce((f ->> 'ours')::boolean, false))
     OR (v_tbl = 'job_events' AND nullif(v_of ->> 'author', '') IS NOT NULL)) THEN NULL;
   ELSIF v_ob ->> 'kind' <> 'us' AND v_tbl IN ('business_events', 'inbox_events', 'job_events') AND nullif(v_of ->> 'author', '') = v_ob ->> 'key' THEN NULL;
   ELSIF v_tbl IN ('business_events', 'inbox_events') AND coalesce((f ->> 'customer_sender')::boolean, false)
     AND coalesce(f #>> '{cite,excerpt}', '') ~* ('\m(no need|not needed|no longer (need|needed|required|necessary)|(don''t|do not|won''t|will not) need|'
      || '(don''t|do not) (worry|bother)|no worries|never ?mind|cancel|declin|no thanks|not required|not necessary|leave it|hold off|'
      || '(not|won''t be) go(ing)? ahead|all good|that''?s (ok|okay|fine)|that is (ok|okay|fine)|forget (it|about))') THEN
    v_ok := false; v_reason := 'released_by_obligee';
   ELSIF v_tbl IN ('business_events', 'inbox_events') AND coalesce((f ->> 'customer_sender')::boolean, false) THEN
    v_ok := false; v_cert := true; v_reason := 'other_person';
   ELSIF v_tbl IN ('business_events', 'inbox_events') THEN
    IF v_ob ->> 'kind' <> 'us' AND nullif(v_of ->> 'author', '') IS NOT NULL THEN v_ok := false; v_cert := true; v_reason := 'other_person';
    ELSE v_ok := false; v_reason := 'author_unknown';
    END IF;
   ELSIF v_ob ->> 'kind' <> 'us' AND v_tbl = 'job_events' AND nullif(v_of ->> 'author', '') IS NOT NULL THEN v_ok := false; v_cert := true; v_reason := 'other_person';
   ELSE v_ok := false; v_reason := 'record_not_person';
   END IF;
  ELSIF v_tbl = 'xero_invoices' AND NOT (v_class = 'other' AND coalesce(p_item ->> 'about_key', '') ~ '^(invoice|payment):') THEN
   -- (review r3, M5) an invoice cited on a reply, work or other item is evidence only, never a certain refusal
   v_ok := false; v_reason := CASE WHEN v_class = 'other' THEN 'record_not_person' ELSE 'wrong_obligation_class' END;
  END IF;
  -- (review r3, M6) a citation that does not close and is not certain evidence against is evidence only
  IF NOT v_ok AND NOT v_cert AND (v_reason = 'record_not_person' OR v_tbl NOT IN ('business_events', 'inbox_events')) THEN
   v_evidence := v_evidence || jsonb_build_array(f -> 'cite');
  END IF;
  IF v_ok THEN n_ok := n_ok + 1;
  ELSIF v_cert THEN v_neg := true; v_neg_reason := coalesce(v_neg_reason, v_reason);
  ELSE v_unproven := true; v_unp_reason := coalesce(v_unp_reason, v_reason); END IF;
 END LOOP;
 -- (review r3, M6) one closing citation that closes by the class rule closes, while none is certain evidence against
 v_closes := n_ok > 0 AND NOT v_neg;
 IF v_class = 'payment' AND v_ob IS NOT NULL AND v_ob ->> 'kind' = 'party' AND NOT coalesce((v_ob ->> 'active')::boolean, true) THEN
  -- the obligated party was retired: a later party (even under its letter) is never it
  RETURN CASE WHEN jsonb_array_length(v_evidence) > 0 THEN jsonb_build_object('evidence', v_evidence) ELSE '{}'::jsonb END || jsonb_build_object('closes', false, 'certainty', 'payer_not_certain', 'reason', 'obligated_party_retired');
 END IF;
 -- The obligated party's own invoices on this job; bound: its own invoice (and, bound by an opening
 -- invoice, that payer's invoices of its kind).
 IF v_class = 'payment' AND (v_ob IS NOT NULL OR v_bound_id IS NOT NULL) THEN
  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO v_own FROM jsonb_array_elements(v_invs) x
  WHERE (x ->> 'accrec')::boolean
   AND ((v_bound_id IS NOT NULL AND x ->> 'id' = v_bound_id)
    OR ((v_bound_id IS NULL OR (v_bound_kind IS NOT NULL AND x ->> 'kind' = v_bound_kind)) AND v_ob IS NOT NULL
     AND (public.context_ledger_obligation_payer_match(x -> 'payer', v_ob, v_job) = 'match'
      OR (v_ob ->> 'kind' = 'builder_job' AND x #>> '{payer,kind}' = 'unknown'
          AND x #>> '{payer,basis}' IN ('builder_contact_unmapped', 'no_contact'))
      OR (v_ob ->> 'kind' = 'builder_job' AND x #>> '{payer,kind}' = 'job_client'))));
  SELECT coalesce(bool_or((x ->> 'owed')::boolean), false), coalesce(bool_or((x ->> 'partial')::boolean), false),
   coalesce(bool_or((x ->> 'issued')::boolean AND NOT (x ->> 'voided')::boolean), false), coalesce(bool_or((x ->> 'voided')::boolean), false),
   coalesce(bool_or((x ->> 'zero_balance')::boolean), false), max((x ->> 'paid_at')::timestamptz),
   coalesce(bool_or(((x ->> 'owed')::boolean OR (x ->> 'zero_balance')::boolean) AND x ->> 'id' = ANY(v_cited)), false),
   coalesce(jsonb_agg(jsonb_build_object('table', 'xero_invoices', 'id', x ->> 'id') ORDER BY x ->> 'id')
     FILTER (WHERE ((x ->> 'owed')::boolean OR (x ->> 'zero_balance')::boolean) AND NOT x ->> 'id' = ANY(v_cited)), '[]'::jsonb)
  INTO v_any_owed, v_any_partial, v_any_issued, v_any_voided, v_any_zero, v_last_paid, v_cited_owed, v_other FROM jsonb_array_elements(v_own) x;
  IF v_ob ->> 'kind' = 'all_payers' AND v_bound_id IS NULL THEN
   -- every paying party covered by a cited paid invoice of its own, and none of its own owed
   FOR q IN SELECT x FROM jsonb_array_elements(coalesce(v_job -> 'parties', '[]'::jsonb)) x
     WHERE (x ->> 'active')::boolean AND (x ->> 'paying')::boolean LOOP
    IF NOT (q ->> 'id') = ANY(v_covered) OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_own) x
      WHERE x #>> '{payer,id}' = q ->> 'id' AND (x ->> 'issued')::boolean AND NOT (x ->> 'voided')::boolean) THEN
     v_party_short := true;
    END IF;
   END LOOP;
   IF v_party_short THEN v_closes := false; END IF;
  END IF;
  -- unbound: every issued invoice of the payer is paid; bound: its own invoice
  IF v_any_owed OR v_any_zero THEN v_closes := false; END IF;
 END IF;
 IF v_closes THEN
  RETURN CASE WHEN jsonb_array_length(v_evidence) > 0 THEN jsonb_build_object('evidence', v_evidence) ELSE '{}'::jsonb END || jsonb_build_object('closes', true, 'certainty', 'certain', 'reason', 'closes');
 END IF;
 -- Stays open: how certain.
 IF v_class = 'payment' THEN
  IF v_ob IS NULL AND v_bound_id IS NULL THEN
   RETURN CASE WHEN jsonb_array_length(v_evidence) > 0 THEN jsonb_build_object('evidence', v_evidence) ELSE '{}'::jsonb END || jsonb_build_object('closes', false, 'certainty', 'payer_not_certain', 'reason', coalesce(v_ref ->> 'party_basis', 'payer_unknown'));
  END IF;
  IF v_any_owed THEN
   -- (review r3, M4) unbound, a cited invoice closing it and owed only on invoices it never cited: another invoice is owed, not this one
   -- (every paying party's invoice is this obligation's own: all_payers stays certain)
   IF n_ok > 0 AND NOT v_neg AND v_bound_id IS NULL AND NOT v_cited_owed AND v_ob ->> 'kind' <> 'all_payers' THEN
    RETURN jsonb_build_object('evidence', v_evidence || v_other, 'closes', false, 'certainty', 'payer_not_certain', 'reason', 'other_invoice_owed');
   END IF;
   RETURN CASE WHEN jsonb_array_length(v_evidence) > 0 THEN jsonb_build_object('evidence', v_evidence) ELSE '{}'::jsonb END || jsonb_build_object('closes', false, 'certainty', 'certain', 'reason', CASE WHEN v_any_partial THEN 'partially_paid' ELSE 'invoice_unpaid' END);
  END IF;
  IF v_neg THEN RETURN CASE WHEN jsonb_array_length(v_evidence) > 0 THEN jsonb_build_object('evidence', v_evidence) ELSE '{}'::jsonb END || jsonb_build_object('closes', false, 'certainty', 'certain', 'reason', v_neg_reason); END IF;
  IF v_unproven AND n_ok = 0 THEN RETURN CASE WHEN jsonb_array_length(v_evidence) > 0 THEN jsonb_build_object('evidence', v_evidence) ELSE '{}'::jsonb END || jsonb_build_object('closes', false, 'certainty', 'payer_not_certain', 'reason', v_unp_reason); END IF;
  IF v_party_short THEN RETURN CASE WHEN jsonb_array_length(v_evidence) > 0 THEN jsonb_build_object('evidence', v_evidence) ELSE '{}'::jsonb END || jsonb_build_object('closes', false, 'certainty', 'payer_not_certain', 'reason', 'payer_not_covered'); END IF;
  IF NOT v_any_issued THEN
   RETURN CASE WHEN jsonb_array_length(v_evidence) > 0 THEN jsonb_build_object('evidence', v_evidence) ELSE '{}'::jsonb END || jsonb_build_object('closes', false, 'certainty', CASE WHEN v_any_voided THEN 'certain' ELSE 'payer_not_certain' END,
    'reason', CASE WHEN v_any_voided THEN 'voided_only' ELSE 'no_own_invoice' END);
  END IF;
  IF v_any_zero THEN RETURN jsonb_build_object('evidence', v_evidence || v_other) || jsonb_build_object('closes', false, 'certainty', 'payer_not_certain', 'reason', 'zero_balance'); END IF;
  RETURN CASE WHEN jsonb_array_length(v_evidence) > 0 THEN jsonb_build_object('evidence', v_evidence) ELSE '{}'::jsonb END || jsonb_build_object('closes', false, 'certainty', 'payer_not_certain',
   'reason', CASE WHEN v_last_paid IS NOT NULL AND (p_item ->> 'opened_at') IS NOT NULL AND v_last_paid < (p_item ->> 'opened_at')::timestamptz
                  THEN 'paid_before_raised' ELSE 'paid_not_cited' END);
 END IF;
 IF v_class = 'person' THEN
  IF v_neg THEN RETURN CASE WHEN jsonb_array_length(v_evidence) > 0 THEN jsonb_build_object('evidence', v_evidence) ELSE '{}'::jsonb END || jsonb_build_object('closes', false, 'certainty', 'certain', 'reason', v_neg_reason); END IF;
  IF coalesce((v_job ->> 'settled')::boolean, false) THEN
   RETURN CASE WHEN jsonb_array_length(v_evidence) > 0 THEN jsonb_build_object('evidence', v_evidence) ELSE '{}'::jsonb END || jsonb_build_object('closes', false, 'certainty', 'settled_job_needs_person', 'reason', 'job_finished_and_paid');
  END IF;
  IF v_ob IS NULL OR v_unproven THEN
   RETURN CASE WHEN jsonb_array_length(v_evidence) > 0 THEN jsonb_build_object('evidence', v_evidence) ELSE '{}'::jsonb END || jsonb_build_object('closes', false, 'certainty', 'payer_not_certain', 'reason', coalesce(v_unp_reason, v_ref ->> 'party_basis', 'no_author'));
  END IF;
  RETURN CASE WHEN jsonb_array_length(v_evidence) > 0 THEN jsonb_build_object('evidence', v_evidence) ELSE '{}'::jsonb END || jsonb_build_object('closes', false, 'certainty', 'certain', 'reason', CASE WHEN n = 0 THEN 'not_closed' ELSE v_neg_reason END);
 END IF;
 IF v_neg THEN RETURN CASE WHEN jsonb_array_length(v_evidence) > 0 THEN jsonb_build_object('evidence', v_evidence) ELSE '{}'::jsonb END || jsonb_build_object('closes', false, 'certainty', 'certain', 'reason', v_neg_reason); END IF;
 IF v_unproven THEN RETURN CASE WHEN jsonb_array_length(v_evidence) > 0 THEN jsonb_build_object('evidence', v_evidence) ELSE '{}'::jsonb END || jsonb_build_object('closes', false, 'certainty', 'payer_not_certain', 'reason', v_unp_reason); END IF;
 RETURN CASE WHEN jsonb_array_length(v_evidence) > 0 THEN jsonb_build_object('evidence', v_evidence) ELSE '{}'::jsonb END || jsonb_build_object('closes', false, 'certainty', 'certain', 'reason', 'not_closed');
END $fn$;
COMMENT ON FUNCTION public.context_ledger_obligation_closes(jsonb, jsonb) IS
 'Same payer close (20261019130000): the one closure rule, read by context_ledger_check_item (closed_by) and context_ledger_write (a closing transition): {closes, certainty, reason, evidence?} for an item (closes_on, blocks, about_key, opened_at, what, obligated_party, obligation_ref) and {job (context_ledger_obligation_job_facts), cites (the citation check''s facts for each closing citation, with obligation_facts)}. Runs only after the existing closing rules passed, so it can only refuse. It closes when at least one closing citation closes the item by its class rule and none is certain evidence against it (review r3, M6); a citation that neither closes nor is certain evidence against is kept as evidence. Payment: never a message (claim_not_record), a document, booking or system email (wrong_record_kind), a credit note (credit_note), a bill (not_customer_invoice), a voided invoice (voided), an unpaid or part paid one (invoice_unpaid, partially_paid), money from another contact or a credit (other_money_allocated), another payer''s invoice (other_payer), another invoice or kind than the one bound (other_obligation), an app event naming no invoice (payer_unknown). A bound item (the invoice it names, its opening invoice, or the one invoice cited by an item about an invoice: review r3, M4) closes on its own invoice being PAID, that invoice''s payer being its obligation; an unbound item closes only while none of the payer''s own issued invoices is owed or zeroed (all_payers: every paying party covered), and when the one owed is an invoice it never cited it stays open, payer not certain (other_invoice_owed), the owed invoices kept as evidence. Invoice: an invoice citation must be an ACCREC of the payer. Person: only a later message (or app event) by the opening author (other_person, author_unknown); an item opened by our own message with no named sender (us) only by a later row of ours by its stamp; the customer it is owed to releasing or declining it in words is never a close and never certain (released_by_obligee: review r3, M7), any other reply of the customer''s is other_person; a record is evidence only (record_not_person). An invoice cited on a reply, work or other item is evidence only, never certain (wrong_obligation_class, record_not_person: review r3, M5). On builder work the job''s own Xero contact (job_client) may be the builder''s: unproven, never other. When it does not close: certain when the payer''s own cited invoice is owed or a citation is certainly not the obligation, payer_not_certain when the payer, party or money''s source is unproven (no_own_invoice, zero_balance, paid_not_cited, paid_before_raised, obligated_party_retired, other_invoice_owed), settled_job_needs_person for a person''s item on a settled job. Pure.';

-- 6. The citation check: the obligation facts while the switch is on.
CREATE OR REPLACE FUNCTION public.context_ledger_cite(p_job_id uuid, p_cite jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_table text; v_id uuid; v_excerpt text; v_norm text; e public.business_events; v_text text; v_at timestamptz;
 v_cmail text; v_job uuid; v_found boolean; i record; v_ours boolean := false; v_customer boolean := false;
 v_call_note boolean := false; v_internal boolean := false; v_record boolean := false; v_worded boolean := false;
 v_subject text; v_body text; v_close_at timestamptz; v_automated boolean := false; v_made_at timestamptz; v_paid_at timestamptz;
 v_job_created timestamptz; v_repeat boolean; v_kind text; v_doc text; v_crm_at timestamptz;
 v_on boolean := public.context_ledger_same_payer_close_on(); v_of jsonb := '{}'::jsonb;
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
  v_body := public.context_story_message_text(e);
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
  -- (same payer close, 20261019130000) who sent it, for the item's obligated party
  IF v_on THEN
   SELECT jsonb_build_object('ghl', nullif(btrim(e.contact_id::text), ''), 'email_key', ident.email_key, 'phone_key', ident.phone_key,
    'author', CASE WHEN v_ours OR v_call_note THEN 'crm:' || nullif(lower(btrim(coalesce(e.payload ->> 'sent_by_user', e.payload ->> 'by_user'))), '') END)
   INTO v_of FROM public.context_event_identity(e) ident;
  END IF;
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
   -- (a copy counts on this job, and (seventh review) on another live job, which decides where
   -- the mail belongs, as the evidence reads it; never one unplaced or on a job that is not live,
   -- eighth review: the judge's live set: story safety, 20261006040000)
   OR EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table = 'inbox_events' AND b.source_id = i.id::text
    AND (b.job_id = p_job_id OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = b.job_id AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                        AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
   OR EXISTS (SELECT 1 FROM public.business_events b WHERE i.graph_message_id IS NOT NULL AND b.provider_message_id = 'graph:' || i.graph_message_id
    AND (b.job_id = p_job_id OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = b.job_id AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                        AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
   OR EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table IS NULL
    AND b.payload @> jsonb_build_object('inbox_events_id', i.id::text)
    AND (b.job_id = p_job_id OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = b.job_id AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                        AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
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
  IF v_on THEN
   v_of := jsonb_build_object('email_key', public.context_email_key(i.from_email),
    'author', CASE WHEN v_ours THEN 'mail:' || lower(btrim(i.from_email)) END);
  END IF;
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
   -- (same payer close, 20261019130000) whose invoice it is, its type and what is paid
   IF v_on THEN
    SELECT jsonb_build_object('invoice_id', x.id, 'invoice_type', upper(x.invoice_type), 'status', upper(x.status),
     'amount_paid', x.amount_paid, 'amount_due', x.amount_due, 'voided', upper(coalesce(x.status, '')) IN ('VOIDED', 'DELETED'),
     'job_contact_id', x.job_contact_id, 'xero_contact_id', x.xero_contact_id,
     'payer', public.context_ledger_invoice_payer(x.job_id, x.job_contact_id, x.xero_contact_id))
    INTO v_of FROM public.xero_invoices x WHERE x.id = v_id;
   END IF;
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
   -- (same payer close, 20261019130000) its author and the invoice on this job its payload names
   IF v_on THEN
    SELECT jsonb_build_object('author', CASE WHEN je.user_id IS NOT NULL THEN 'user:' || je.user_id::text END,
     'job_contact_id', nullif(btrim(je.detail_json ->> 'job_contact_id'), ''),
     'invoice_id', (SELECT x.id FROM public.xero_invoices x WHERE x.job_id = je.job_id
       AND (x.xero_invoice_id = nullif(btrim(coalesce(je.detail_json ->> 'xero_invoice_id', je.detail_json ->> 'invoice_id')), '')
        OR x.id::text = nullif(btrim(coalesce(je.detail_json ->> 'xero_invoice_id', je.detail_json ->> 'invoice_id')), ''))
       ORDER BY x.id LIMIT 1))
    INTO v_of FROM public.job_events je WHERE je.id = v_id;
   END IF;
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
  'internal_text', v_internal, 'record', v_record, 'worded', v_worded, 'automated', v_automated)
  -- (same payer close, 20261019130000) only while the switch is on
  || CASE WHEN v_on THEN jsonb_build_object('obligation_facts', coalesce(v_of, '{}'::jsonb)) ELSE '{}'::jsonb END;
END $function$;
COMMENT ON FUNCTION public.context_ledger_cite(uuid, jsonb) IS
 'Context ledger store (20261006013000), story safety (20261006040000): an inbox_events mail is refused for a business_events copy only when the copy is on this job or (seventh review) on another live job, which decides where the mail belongs (as the evidence reads it; eighth review: live is the judge''s live set, never archived, complete, completed, cancelled, lost, a draft or holding), so every mail citation accepted before is still accepted and a mail whose copy sits unplaced or on a job that is not live (a bucket) can now be cited. A CRM text loaded later from the CRM''s cache (source ghl_sms_cache_backfill) is at the CRM''s own time (context_job_record_crm_time, as the evidence times it), and one the CRM dates more than 30 days before the job was created is refused (citation_not_admissible), as the evidence leaves it out; (sixth review) so is one whose CRM time is no longer kept (neither in context_crm_message_times nor the cache). Earlier: checks one {table, id, excerpt} citation for a job: an allowed table; a business_events row on this job that is ledger evidence (context_ledger_row_admissible: linked, not retracted, written as service_role, worded, a message); a call transcript counts as the customer''s only when its call (ghl:<id>) is stamped with the job''s customer; an inbox_events mail placed on the job, or from the client''s address and placed on no job when the client has no other job and the mail is from 30 days before the job on, with no business_events copy; a record row (job_documents, xero_invoices, job_assignments, job_events, email_events) on this job. A worded evidence row needs an excerpt that, quotes straightened and whitespace collapsed, is in its subject and text, and is at least 12 characters or 3 words unless it is the whole row, subject or body. close_at: when the row can close an item (a worded row: its time; a document: sent_at; an invoice: only AUTHORISED, SUBMITTED or PAID, and a payment only PAID, at its paid day (paid_at); a booking: attendance, completed_at, else started_at, else a status-only completion at the end of its booked Perth day or, while that is ahead, now; a system email (email_events): only sent, delivered or accepted with a sent time, at sent_at; an app event (job_events): its time, closing only the matter it records (context_ledger_job_event_closes on kind); a document our system emailed (job_documents, or a job_events row naming its document_id): no earlier than its first email sent, delivered or accepted with a sent time, never while every one bounced or failed; a system email closes only its own matter (context_ledger_email_closes on kind); null when it cannot); kind: an app event''s event_type or a system email''s email_type; made_at: a standing booking''s created time (it closes a booking_made item; not standing = cancelled, deleted, draft, disputed, declined). Refusal codes citation_shape, citation_table_not_allowed, citation_missing, citation_off_job, citation_not_admissible, excerpt_required, excerpt_not_verbatim, excerpt_too_long, excerpt_too_short. Service role only. Story card causes (20261014120000): a placed admissible message may quote its labelled forwarded correspondence, the same text the evidence reader receives; no placement or close-time rule changes. Same payer close (20261019130000): while feature_flags.context_ledger_same_payer_close_v1 is on, an accepted citation also carries obligation_facts: a message''s sender keys (its CRM contact, email key and phone key) and, on our own row, a call or a note, its author (''crm:'' and the CRM user or our sender, ''mail:'' and our sender address for old-inbox mail); an invoice''s invoice_type, status, amount_paid, amount_due, voided, job_contact_id, xero_contact_id and payer (context_ledger_invoice_payer); an app event''s author (''user:'' and its user) and the invoice on this job its payload names (xero_invoice_id or invoice_id, matched to this job''s xero_invoices by Xero id), or none. Off: unchanged.';

-- 7. The item check: obligated party, and a close kept open when the rule refuses it.
CREATE OR REPLACE FUNCTION public.context_ledger_check_item(p_job_id uuid, p_item jsonb, p_writer text, p_person uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_type text; v_status text; v_from text; v_to text; v_what text; v_about text; v_due date; v_basis text;
 v_open jsonb := '[]'; v_close jsonb := '[]'; c jsonb; chk jsonb; n integer := 0; v_opened_at timestamptz; v_closed_at timestamptz;
 v_any_customer boolean := false; v_any_us boolean := false; v_any_external boolean := false; v_due_ok boolean := false;
 v_first_customer boolean; v_first_us boolean; v_close_at timestamptz;
 v_key text; v_first text; v_facts jsonb := '[]'; f jsonb; v_supported date;
 v_cfacts jsonb := '[]'; v_reason text; v_someone integer := 0;
 v_hchk jsonb; v_held boolean := false; v_held_first boolean := false;
 v_jobf jsonb; v_ob jsonb; v_verdict jsonb; v_oref jsonb; v_ext jsonb := '{}'::jsonb;
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
  -- (held notes, 20261015100000) a message placed on no job, held with this job among its
  -- candidates, may open or support an item here while the switch is on
  -- (context_ledger_held_cite); the item is then marked job not certain. Off, or not such a
  -- message: the citation check's own refusal stands, as before.
  IF NOT (chk ->> 'ok')::boolean AND chk ->> 'code' = 'citation_off_job' AND c ->> 'table' = 'business_events' THEN
   v_hchk := public.context_ledger_held_cite(p_job_id, c);
   IF coalesce(v_hchk ->> 'code', '') <> 'held_not_candidate' THEN chk := v_hchk; END IF;
  END IF;
  IF NOT (chk ->> 'ok')::boolean THEN
   RETURN jsonb_build_object('ok', false, 'code', chk ->> 'code', 'detail', 'opened_by[' || n || '] ' || coalesce(chk ->> 'detail', ''));
  END IF;
  IF coalesce((chk ->> 'held')::boolean, false) THEN
   v_held := true;
   IF n = 1 THEN v_held_first := true; END IF;
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
  v_cfacts := v_cfacts || jsonb_build_array(chk);
  v_closed_at := greatest(v_closed_at, v_close_at);
 END LOOP;
 IF v_status IN ('closed','declined') AND jsonb_array_length(v_close) = 0 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'closed_without_evidence', 'detail', v_status || ' needs closed_by');
 END IF;
 IF v_status IN ('open','info') AND jsonb_array_length(v_close) > 0 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'closed_by_on_open', 'detail', v_status || ' cannot carry closed_by');
 END IF;
 -- (held notes, 20261015100000) a held message (job not certain) opens or supports only an
 -- open item: what is owed. It never closes one (the closing citations above refuse it).
 IF v_held AND v_status <> 'open' THEN
  RETURN jsonb_build_object('ok', false, 'code', 'held_not_open',
   'detail', 'a message held on no job (job not certain) may open or support only an open item');
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
  -- (ledger reader fixes, 20261007150000) An item whose words say a row is someone else's (its
  -- sender, caller or counterpart another person than this job's customer, or a label saying so:
  -- context_ledger_elsewhere_claim) stands only when no cited row, opening or closing, is this job's
  -- customer's own words, every cited row that is not a record or our own text, email or note (a
  -- call transcript holds both sides' words, so it is never ours alone) is someone else's by its own
  -- stamp (context_ledger_row_elsewhere: role_basis or call_not_customer), and at least one is: never
  -- on the reader's word or an extra citation, so the customer's own call is never put on someone
  -- else; a placement reason (call_on_other_job, names_other_job) names no person. A claim that a
  -- row concerns or belongs to another job is the reader's placement judgement (second review, 8 Oct).
  IF public.context_ledger_elsewhere_claim(v_what) THEN
   FOR f IN SELECT x FROM jsonb_array_elements(v_facts || v_cfacts) x LOOP
    IF coalesce((f ->> 'customer_sender')::boolean, false) THEN
     RETURN jsonb_build_object('ok', false, 'code', 'elsewhere_unsupported', 'detail', 'what says a row is someone else''s; '
      || (f #>> '{cite,table}') || ':' || (f #>> '{cite,id}') || ' is this job''s customer''s own words');
    END IF;
    v_reason := public.context_ledger_row_elsewhere(p_job_id, f #>> '{cite,table}', (f #>> '{cite,id}')::uuid);
    IF starts_with(coalesce(v_reason, ''), 'role_basis:') OR v_reason = 'call_not_customer' THEN
     v_someone := v_someone + 1;
    ELSIF NOT (coalesce((f ->> 'record')::boolean, false)
      OR (coalesce((f ->> 'ours')::boolean, false) AND NOT EXISTS (SELECT 1 FROM public.business_events b
       WHERE f #>> '{cite,table}' = 'business_events' AND b.id = (f #>> '{cite,id}')::uuid AND b.event_type = 'call.transcript_completed'))) THEN
     RETURN jsonb_build_object('ok', false, 'code', 'elsewhere_unsupported', 'detail', 'what says a row is someone else''s; the stamp of '
      || (f #>> '{cite,table}') || ':' || (f #>> '{cite,id}') || ' names no one else');
    END IF;
   END LOOP;
   IF v_someone = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'elsewhere_unsupported',
     'detail', 'what says a row is someone else''s; no cited row''s own stamp names another job''s customer or party or a lead');
   END IF;
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
 -- (same payer close, 20261019130000) while the switch is on, a model's open or closed item gets its
 -- obligated party and obligation (context_ledger_obligated_party), and a close stands only when the
 -- one closure rule (context_ledger_obligation_closes) says the closing records are of a kind that
 -- closes this obligation and paid or written by its obligated party. A refused close stays open,
 -- its closing citations kept as closing_evidence. The rules above have all passed: this only refuses.
 IF p_writer = 'model' AND v_status IN ('open', 'closed') AND public.context_ledger_same_payer_close_on() THEN
  v_jobf := public.context_ledger_obligation_job_facts(p_job_id);
  v_ob := public.context_ledger_obligated_party(jsonb_build_object('closes_on', p_item ->> 'closes_on', 'blocks', p_item ->> 'blocks',
    'what', v_what, 'about_key', v_about), v_facts, v_jobf);
  v_verdict := public.context_ledger_obligation_closes(jsonb_build_object('item_type', v_type, 'closes_on', p_item ->> 'closes_on',
    'blocks', p_item ->> 'blocks', 'about_key', v_about, 'opened_at', v_opened_at, 'what', v_what, 'obligated_party', v_ob -> 'obligated_party',
    'obligation_ref', v_ob -> 'obligation_ref'),
   jsonb_build_object('job', v_jobf, 'cites', CASE WHEN v_status = 'closed' THEN v_cfacts ELSE '[]'::jsonb END));
  v_oref := coalesce(nullif(v_ob -> 'obligation_ref', 'null'::jsonb), '{}'::jsonb) || jsonb_build_object('reason', v_verdict ->> 'reason');
  IF v_status = 'closed' AND NOT coalesce((v_verdict ->> 'closes')::boolean, false) THEN
   v_oref := v_oref || jsonb_build_object('held_open', true, 'closing_evidence', v_close);
   v_status := 'open'; v_close := '[]'::jsonb; v_closed_at := NULL;
  END IF;
  v_ext := jsonb_build_object('obligated_party', v_ob -> 'obligated_party', 'obligation_ref', v_oref,
   'obligation_certainty', v_verdict ->> 'certainty');
 END IF;
 v_first := v_open -> 0 ->> 'id';
 -- (held notes, 20261015100000) an item first opened by a held message is keyed by that message
 -- alone, so one held message opens at most one item of a type and matter on a job, whatever its
 -- words (a second is refused duplicate_item); every other item is keyed as before
 v_key := v_type || ':' || coalesce(v_about, 'none') || ':'
  || left(md5(CASE WHEN v_held_first THEN 'held:' || v_first ELSE v_first || lower(v_what) END), 12);
 RETURN jsonb_build_object('ok', true, 'item', jsonb_build_object('ref', p_item ->> 'ref', 'item_key', v_key, 'item_type', v_type,
  'status', v_status, 'from_role', v_from, 'from_name', nullif(btrim(p_item ->> 'from_name'), ''), 'to_role', v_to,
  'to_name', nullif(btrim(p_item ->> 'to_name'), ''), 'what', v_what, 'about_key', v_about, 'modality', p_item ->> 'modality',
  'phase', p_item ->> 'phase', 'due_date', v_due, 'due_basis', v_basis, 'opened_at', v_opened_at, 'opened_by', v_open,
  -- never a close time still to come (a record dated ahead closes at the check)
  'closed_at', CASE WHEN v_closed_at > now() THEN now() ELSE v_closed_at END, 'closed_by', CASE WHEN jsonb_array_length(v_close) > 0 THEN v_close END,
  'closes_on', p_item ->> 'closes_on', 'supersedes_key', nullif(btrim(p_item ->> 'supersedes_key'), ''),
  'supersedes_ref', nullif(btrim(p_item ->> 'supersedes_ref'), ''), 'blocks', p_item ->> 'blocks',
  'needs_reply', CASE WHEN jsonb_typeof(p_item -> 'needs_reply') = 'boolean' THEN (p_item ->> 'needs_reply')::boolean END, 'also_concerns', nullif(btrim(p_item ->> 'also_concerns'), ''))
  -- (held notes) only on an item a held message opened or supports
  || CASE WHEN v_held THEN jsonb_build_object('job_certain', false, 'certainty', 'job_not_certain') ELSE '{}'::jsonb END
  -- (same payer close) only while the switch is on
  || v_ext);
END $function$;
COMMENT ON FUNCTION public.context_ledger_check_item(uuid, jsonb, text, uuid, text) IS
 'Context ledger store (20261006013000), ledger reader fixes (20261007150000): a model item whose words say a row is someone else''s (its sender, caller or counterpart another person than this job''s customer, or a label saying so: context_ledger_elsewhere_claim) is refused elsewhere_unsupported when a cited row, opening or closing, is this job''s customer''s own words (customer_sender), when a cited row that is not a record or our own text, email or note (a call transcript never counts as ours alone) is not someone else''s by its own stamp (context_ledger_row_elsewhere: role_basis or call_not_customer), or when none is; a claim that a row concerns or belongs to another job is the reader''s placement judgement and stands (second review, 8 Oct); a person''s own item is their word. A PAID invoice closes a payment item (closes_on payment) at the end of its paid Perth day, never after now (context_ledger_paid_close_at), whatever the invoice''s date, so a request made the day it was paid is closed by it. Earlier: checks one ledger item for a job and returns the row to insert or {ok false, code, detail}. Shape (types, roles, about_key vocabulary, modality, phase, status per type), every citation (context_ledger_cite), closed or declined needs closed_by and nothing open carries it; a closing citation must be able to close (close_at: no draft invoice, unsent document or unattended booking: closing_not_issued), may not be an opening citation (closing_is_opening) and is at or after the opening, strictly after for a request (closing_before_opening); speaker rules for the model on the first opening citation (customer: the job''s customer sent it; us: ours, a call, a note or a record; nothing only internal texts is to the customer), a due date only when an opening excerpt states it and that message is not automated (context_supported_due_date); what has em and en dashes replaced. opened_at and closed_at come from the cited rows, never the input, and closed_at is never later than now. item_key = type:about:first 12 hex of md5(first opening citation id || lower(what)). Service role only. Held notes (20261015100000): while feature_flags.context_held_notes_v1 is on, an opening citation the citation check refuses as off the job may instead be a message held on no job with this job among its candidates (context_ledger_held_cite); the item is then marked job not certain (job_certain false, certainty job_not_certain in the returned item; the store stamps context_ledger_items.job_not_certain), must be open (held_not_open otherwise), and, when the held message is its first opening citation, is keyed by that message alone (type:about:first 12 hex of md5(''held:'' || its id)), so one held message opens at most one item of a type and matter on a job (a second is refused duplicate_item by the write). A held message never closes an item. Off: every check is as before. Same payer close (20261019130000): while feature_flags.context_ledger_same_payer_close_v1 is on, a model''s open or closed item carries obligated_party, obligation_ref and obligation_certainty (context_ledger_obligated_party), and a closed item stands only when context_ledger_obligation_closes says its closing records close this obligation for its obligated party; otherwise it is returned open (closed_by and closed_at null) with obligation_ref.held_open and the refused citations as closing_evidence. Every earlier refusal still runs first, so a close is only ever kept open, never added. Off: unchanged.';

-- 8. The write: the new columns, and a closing transition through the same rule.
CREATE OR REPLACE FUNCTION public.context_ledger_write(p_run_id uuid, p_lease_token uuid, p_generation_id uuid, p_items jsonb, p_transitions jsonb, p_reader text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r public.context_extraction_runs; g public.context_ledger_generations; v_items jsonb := coalesce(p_items, '[]'::jsonb);
 v_trans jsonb := coalesce(p_transitions, '[]'::jsonb); v_hash text; v_prior jsonb; v_by text; it jsonb; chk jsonb;
 cands jsonb[] := '{}'; refused jsonb := '[]'::jsonb; accepted jsonb := '[]'::jsonb; t_refused jsonb := '[]'::jsonb;
 t_accepted integer := 0; k integer; m integer; v_changed boolean; v_cand jsonb; v_other jsonb; v_key text; v_found boolean;
 v_rep_at timestamptz; v_result jsonb; refs text[] := '{}'; keys text[] := '{}'; v_id uuid; tr jsonb; li public.context_ledger_items;
 v_ev jsonb; v_ev_at timestamptz; v_code text; v_detail text; c jsonb; n integer; v_ok boolean;
 v_cf jsonb; v_jobf jsonb; v_ob jsonb; v_verdict jsonb; v_ofacts jsonb; v_oext jsonb;
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
    blocks, needs_reply, also_concerns, written_by, person_locked, obligated_party, obligation_ref, certainty)
   VALUES (g.id, g.job_id, v_cand ->> 'item_key', v_cand ->> 'item_type', v_cand ->> 'status', v_cand ->> 'from_role',
    v_cand ->> 'from_name', v_cand ->> 'to_role', v_cand ->> 'to_name', v_cand ->> 'what', v_cand ->> 'about_key',
    v_cand ->> 'modality', v_cand ->> 'phase', (v_cand ->> 'due_date')::date, v_cand ->> 'due_basis',
    (v_cand ->> 'opened_at')::timestamptz, v_cand -> 'opened_by', (v_cand ->> 'closed_at')::timestamptz,
    CASE WHEN jsonb_typeof(v_cand -> 'closed_by') = 'array' THEN v_cand -> 'closed_by' END, v_cand ->> 'closes_on',
    v_cand ->> 'supersedes_key', v_cand ->> 'blocks', (v_cand ->> 'needs_reply')::boolean, v_cand ->> 'also_concerns', v_by, false,
    -- (same payer close, 20261019130000) null while the switch is off
    nullif(v_cand -> 'obligated_party', 'null'::jsonb), nullif(v_cand -> 'obligation_ref', 'null'::jsonb), v_cand ->> 'obligation_certainty')
   RETURNING id INTO v_id;
   INSERT INTO public.context_ledger_transitions (item_id, generation_id, job_id, from_status, to_status, by, evidence, reason)
   VALUES (v_id, g.id, g.job_id, NULL, v_cand ->> 'status', v_by,
    CASE WHEN v_cand ->> 'status' IN ('closed','declined') THEN v_cand -> 'closed_by' ELSE v_cand -> 'opened_by' END, 'written');
   accepted := accepted || jsonb_build_array(jsonb_build_object('ref', v_cand ->> 'ref', 'item_key', v_cand ->> 'item_key')
    -- (same payer close) a close the obligation rule kept open
    || CASE WHEN coalesce((v_cand #>> '{obligation_ref,held_open}')::boolean, false)
            THEN jsonb_build_object('held_open', v_cand #>> '{obligation_ref,reason}') ELSE '{}'::jsonb END);
  EXCEPTION WHEN check_violation OR not_null_violation OR unique_violation OR invalid_text_representation THEN
   refused := refused || jsonb_build_array(jsonb_build_object('ref', v_cand ->> 'ref', 'code', 'invalid_shape', 'detail', left(SQLERRM, 200)));
  END;
 END LOOP;

 -- Transitions on items of this generation.
 FOR tr IN SELECT x FROM jsonb_array_elements(v_trans) x LOOP
  v_code := NULL; v_detail := NULL; v_ev := '[]'::jsonb; v_ev_at := NULL; v_cf := '[]'::jsonb; v_oext := NULL;
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
    IF tr ->> 'to_status' = 'closed' THEN v_cf := v_cf || jsonb_build_array(chk); END IF;
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
  -- (same payer close, 20261019130000) while the switch is on, a closing transition on a model's item
  -- passes the same closure rule as an item's closed_by (context_ledger_obligation_closes); refused
  -- obligation_not_closed, the item stays as it is with its certainty and the closing evidence recorded.
  IF v_code IS NULL AND tr ->> 'to_status' = 'closed' AND li.written_by LIKE 'model:%' AND public.context_ledger_same_payer_close_on() THEN
   v_jobf := public.context_ledger_obligation_job_facts(g.job_id);
   IF li.obligation_ref IS NULL THEN
    v_ofacts := '[]'::jsonb;
    FOR c IN SELECT x FROM jsonb_array_elements(li.opened_by) x LOOP
     chk := public.context_ledger_cite(g.job_id, c);
     v_ofacts := v_ofacts || jsonb_build_array(CASE WHEN coalesce((chk ->> 'ok')::boolean, false) THEN chk ELSE jsonb_build_object('cite', c) END);
    END LOOP;
    v_ob := public.context_ledger_obligated_party(jsonb_build_object('closes_on', li.closes_on, 'blocks', li.blocks,
     'what', li.what, 'about_key', li.about_key), v_ofacts, v_jobf);
   ELSE
    v_ob := jsonb_build_object('obligated_party', li.obligated_party, 'obligation_ref', li.obligation_ref);
   END IF;
   v_verdict := public.context_ledger_obligation_closes(jsonb_build_object('item_type', li.item_type, 'closes_on', li.closes_on,
     'blocks', li.blocks, 'about_key', li.about_key, 'opened_at', li.opened_at, 'what', li.what, 'obligated_party', v_ob -> 'obligated_party',
     'obligation_ref', v_ob -> 'obligation_ref'), jsonb_build_object('job', v_jobf, 'cites', v_cf));
   v_oext := jsonb_build_object('obligated_party', v_ob -> 'obligated_party', 'certainty', v_verdict ->> 'certainty',
    'obligation_ref', ((coalesce(nullif(v_ob -> 'obligation_ref', 'null'::jsonb), '{}'::jsonb) - 'held_open') - 'closing_evidence')
     || jsonb_build_object('reason', v_verdict ->> 'reason'));
   IF NOT coalesce((v_verdict ->> 'closes')::boolean, false) THEN
    v_code := 'obligation_not_closed'; v_detail := v_verdict ->> 'reason';
    UPDATE public.context_ledger_items SET obligated_party = coalesce(obligated_party, nullif(v_oext -> 'obligated_party', 'null'::jsonb)),
     obligation_ref = (v_oext -> 'obligation_ref') || jsonb_build_object('held_open', true, 'closing_evidence', v_ev),
     certainty = v_oext ->> 'certainty', updated_at = now()
    WHERE id = li.id;
   END IF;
  END IF;
  IF v_code IS NOT NULL THEN
   t_refused := t_refused || jsonb_build_array(jsonb_build_object('item_key', tr ->> 'item_key', 'code', v_code, 'detail', v_detail));
   CONTINUE;
  END IF;
  UPDATE public.context_ledger_items SET status = tr ->> 'to_status',
   closed_at = CASE WHEN tr ->> 'to_status' IN ('closed','declined','superseded') THEN CASE WHEN v_ev_at > now() THEN now() ELSE v_ev_at END END,
   closed_by = CASE WHEN tr ->> 'to_status' IN ('closed','declined','superseded') AND jsonb_array_length(v_ev) > 0 THEN v_ev END,
   -- (same payer close) unchanged while the switch is off
   obligated_party = CASE WHEN v_oext IS NULL THEN obligated_party ELSE coalesce(obligated_party, nullif(v_oext -> 'obligated_party', 'null'::jsonb)) END,
   obligation_ref = CASE WHEN v_oext IS NULL THEN obligation_ref ELSE v_oext -> 'obligation_ref' END,
   certainty = CASE WHEN v_oext IS NULL THEN certainty ELSE v_oext ->> 'certainty' END,
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
END $function$;
COMMENT ON FUNCTION public.context_ledger_write(uuid, uuid, uuid, jsonb, jsonb, text) IS
 'Context ledger store (20261006013000), ledger reader fixes (20261007150000): a transition closing a payment item on a PAID invoice closes it at the end of the invoice''s paid Perth day, never after now (context_ledger_paid_close_at), as an item''s closed_by does; items pass the item check''s new elsewhere_unsupported rule. Earlier: writes a reader''s items and transitions into a generation under custody. The run must be a running ledger run holding its lease (else lease_lost), the lane on and the mode not off (else off), the generation this run''s building generation or, for an update run, the job''s current generation (else refused generation_mismatch), the reader the generation''s (reader_mismatch). Every item passes context_ledger_check_item, is not a person-corrected matter (person_locked: the same type and first opening citation as a person-locked item of this generation or the live one), a fresh ref and item_key (duplicate_ref, duplicate_item), resolvable supersedes (supersedes_unresolved, superseded_without_replacement); accepted items are inserted whole with a transition, refused ones reported with a code. Transitions refuse person_locked, unknown_item, no_change, evidence_missing (every status but superseded needs evidence), evidence_older_than_item, and for closed or declined closing_not_issued and closing_is_opening (the item''s closing rules), and any citation refusal. A repeated identical request in the same run returns its first answer (replayed true). written_by model:<reader>. Service role only. Same payer close (20261019130000): while feature_flags.context_ledger_same_payer_close_v1 is on, an item is stored with its obligated_party, obligation_ref and certainty from the item check (null while off), an accepted item the check kept open carries held_open (the reason) in accepted, and a closing transition on a model''s item passes context_ledger_obligation_closes (refused obligation_not_closed, the item keeping its status and recording its certainty and the closing evidence; a passing close records certainty certain). Off: unchanged.';

-- 9. Grants: service role only.
REVOKE ALL ON FUNCTION public.context_ledger_same_payer_close_on() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_same_payer_close_on() TO service_role;
REVOKE ALL ON FUNCTION public.context_ledger_invoice_kind_of(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_invoice_kind_of(text, text) TO service_role;
REVOKE ALL ON FUNCTION public.context_ledger_obligation_kind(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_obligation_kind(text, text) TO service_role;
REVOKE ALL ON FUNCTION public.context_ledger_obligation_class(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_obligation_class(text, text) TO service_role;
REVOKE ALL ON FUNCTION public.context_ledger_invoice_payer(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_invoice_payer(uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.context_ledger_invoice_facts(public.xero_invoices) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_invoice_facts(public.xero_invoices) TO service_role;
REVOKE ALL ON FUNCTION public.context_ledger_obligation_job_facts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_obligation_job_facts(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.context_ledger_obligation_payer_match(jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_obligation_payer_match(jsonb, jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.context_ledger_obligated_party(jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_obligated_party(jsonb, jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.context_ledger_obligation_closes(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_obligation_closes(jsonb, jsonb) TO service_role;
