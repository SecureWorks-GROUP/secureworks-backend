-- S-M1: parties on one site, the schema and the writers (INTEGRATION.md
-- Wave 4, slice S-M1; sites.md sections 2, 3, 4 (helper), 8 and 12 M1;
-- INTEGRATION X4, X6, X19, X32).
--
-- A fencing job often has two to four payers: the customer who called us and
-- the neighbours on each side. job_contacts already holds one row per party,
-- but four code paths write it and two disagree: a party is found by its
-- letter, so a re-scope moves one person's GHL and Xero ids onto another
-- person, and quote send hard-deletes parties. The table has no RLS, grant or
-- revoke in any migration although it holds neighbours' names, phones and
-- emails. This migration lays the parts the later sites slices use, and
-- changes nothing any caller does today:
--
--   1. job_contacts columns: party_role, source_party_key (the fence tool's
--      stable neighbour id, 'primary' for the owner, 'staff:<uuid>' for a
--      staff-added payer; '#<n>' after a replacement), effective_from,
--      removed_at, last_link_checked_at, party_flags, and phone_last9
--      (generated from client_phone with built-in functions only, null for a
--      placeholder). contact_type is added only when the live table lacks it.
--      Unique (job_id, source_party_key). The unique (job_id, contact_label)
--      index is confirmed; it is created only when missing AND the letters are
--      already unique (duplicates are reported by the status block, never
--      fixed here). No existing row is written.
--   2. job_party_events: one receipt per writer call, site-link decision and
--      failed owner mirror. Ids and codes only, never names or phones.
--   3. job_site_links: "same site" links between legacy split jobs, proposed,
--      confirmed or rejected by a person through link_site_jobs.
--   4. Least privilege on all three tables: RLS on, no policies, REVOKE ALL
--      FROM PUBLIC, anon, authenticated. service_role keeps its job_contacts
--      access (ops-api, ghl-proxy and send-quote write it today); the two new
--      tables are SELECT-only for service_role, written only by the functions.
--   5. upsert_job_party(job, key, fields, actor, run): the one party writer.
--      Keyed on (job_id, source_party_key), never the letter. A letter is
--      assigned once on insert (next free A to Z) and never reused. Removal
--      is soft. A reused key never rewrites a person (review M1): when the
--      keyed party is anchored (a GHL or Xero id, a quote document, an
--      invoice or a run acceptance) and the incoming identity disagrees, the
--      stored party is retired and a new party '<key>#<n>' is inserted. The
--      owner party ('primary') follows jobs one way (review M2, X19): its
--      name, phone, email and ids are read from jobs, never from the caller;
--      a null never overwrites a set id (flag owner_id_divergence instead);
--      when both are set and differ, jobs wins and the old value goes in the
--      receipt. Shares come from portions (review S1). effective_from follows
--      sites.md section 2 rule 6. A legacy row with no key is adopted (the
--      owner row by is_primary; a neighbour row only by an equal phone or
--      email key), so the writer never duplicates a party that exists.
--   6. set_job_party_ids(party, ghl, xero, method, match_basis, actor): the
--      only way a neighbour party's contact ids change. It refuses to
--      overwrite a different id (receipt party_identity_conflict, flag
--      identity_conflict), refuses owner rows (owner_ids_follow_job), and
--      records linker checks (last_link_checked_at, ghl_contact_ambiguous).
--   7. After either writer sets a party's GHL id it asks the placement track
--      to reconsider that contact's messages from effective_from minus 30
--      days (X6) -- only while feature flag job_parties_v1 is on, because
--      party candidacy (slice P3, which also adds the 'party_linked' reason)
--      does not exist before it. The receipt records the outcome; with the
--      flag off it records flag_off, and sites M6's logged re-run covers
--      every party later.
--   8. jobs AFTER UPDATE OF client_name, client_phone, client_email,
--      ghl_contact_id, xero_contact_id: mirrors the job into its owner party
--      through the writer, only for a job whose owner party is already keyed
--      'primary'. No row carries that key until sites S-M2 or M3 writes it,
--      so on deploy the trigger does nothing. It never fails the job update:
--      a mirror failure is a receipt (owner_mirror_failed) and a warning.
--   9. context_contact_parties_at(contact, at): the party jobs of a GHL
--      contact as they stood at `at` (sites.md section 4, review B3), for the
--      placement track's P3. Matched by GHL id only. Not called by the ladder
--      in this slice.
--  10. context_job_event_parties(job): each message row of a job mapped to
--      its sending party (or ambiguous), plus mentions of other parties and
--      unmatched house numbers (sites.md section 4 P3, P4, P7; review S6,
--      S9), for the parties read (S-read, S-read2).
--  11. context_site_candidates(job): proposals for "same site" links (sites.md
--      section 2, review M11 item 8): the same exact address key
--      (context_address_key, B0), a job number named in this job's invoice
--      references or lines, or a shared GHL or Xero contact on the same street
--      and suburb within 4 house numbers. Proposals only; nobody is linked
--      without a person.
--  12. link_site_jobs(job, lead, kind, decision, actor, evidence): the one
--      writer of job_site_links (ops-api action link_site_jobs).
--  13. context_parties_status() replaces the F1 stub: counts for the CIO desk
--      and the party_linker_stale alarm.
--
-- No flag or switch changes; no feature_flags row is written (job_parties_v1
-- missing reads as off). No existing job_contacts, jobs, xero_invoices or
-- business_events row is written by the migration. The ladder, the
-- reconsideration and every current writer of job_contacts are unchanged;
-- their cutover is S-M2 and P3.
--
-- Built on the LIVE production definitions, read from production (read-only
-- transaction, rolled back) on 24 Sep 2026, PostgreSQL 17.6:
--   job_contacts: the nineteen columns pinned below (contact_type already
--     present, NOT NULL default 'primary'; no org_id, no notes); primary key
--     and the job_id foreign key only; index idx_job_contacts_job only (the
--     repository's unique (job_id, contact_label) index is NOT live, and the
--     census found 0 duplicate letter groups, so section 1 creates it); no
--     trigger; RLS already enabled with no policy; anon and authenticated hold
--     every table privilege. RLS stops their row reads and writes but not
--     TRUNCATE, which either key could run today (gate G-SITES-GRANTS):
--     section 4 revokes it with the rest.
--   census: 164 rows on 83 jobs (159 active, 5 removed), 79 primary, no job
--     with two active primaries, 4 jobs with none, 52 with a GHL id, 55 with
--     a Xero id, at most 5 parties on one job. No names were read.
--   readers: view run_summary (owner postgres); functions
--     context_contact_for_key and job_quote_values (both SECURITY DEFINER,
--     unaffected by RLS). Foreign keys into job_contacts: job_documents (no
--     action), run_line_items (set null), run_acceptances (cascade).
--   jobs: every column read here present (status and type text); triggers
--     context_job_created_reconsider, trg_auto_job_number,
--     trg_jobs_expected_costs_write_once, trg_jobs_ses_money_seal_v1,
--     trg_jobs_updated; no job_contacts_owner_mirror.
--   context_parties_status()        md5(prosrc) 155104bfb08b8b3c2f98bdec089d4ee4 (the F1 stub)
--   context_address_key(text)       md5(prosrc) 6c6ac4e46ba283d48d9f2637a6a4c1bd (B0)
--   context_job_ref_tokens(text)    md5(prosrc) c8c7dac3f00d9aa620fb230dfd3a2791 (B0)
--   context_event_text(business_events) md5(prosrc) bd5870b90e0f912d6a6d5be4faea812e
--   automation_lane_enabled(text)   md5(prosrc) 818a13be854748e2d272bdd648c88b59
--   xero_invoices: invoice_type (there is no type column), job_contact_id,
--     xero_contact_id, invoice_date, fully_paid_on, reference, line_items.
--   feature flag job_parties_v1: no row (reads as off). No new function or
--     table name exists. Ledger: nothing after 20260924210000.
-- The guard refuses unless each is still that pre-image or already this
-- migration's result (a re-apply). Anything else is a live change nobody
-- read, and replacing it would silently revert it.
--
-- Rollback: supabase/rollbacks/20260925040000_job_parties_foundation_down.sql
-- restores the F1 stub byte for byte, drops the trigger, the new functions
-- and, when they hold no row, the two new tables and the new columns. It
-- keeps RLS and the revokes on job_contacts: reopening the neighbours' names
-- and phones to the public key is not a rollback.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record; cols text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  -- Replaced: the F1 stub, or this migration's body.
  ('public.context_parties_status()',ARRAY['155104bfb08b8b3c2f98bdec089d4ee4','98ca15b42682e9210ac4e6fe8d74ccd3'],false),
  -- Read, not replaced: must be their merged bodies.
  ('public.context_address_key(text)',ARRAY['6c6ac4e46ba283d48d9f2637a6a4c1bd'],false),
  ('public.context_job_ref_tokens(text)',ARRAY['c8c7dac3f00d9aa620fb230dfd3a2791'],false),
  ('public.context_event_text(public.business_events)',ARRAY['bd5870b90e0f912d6a6d5be4faea812e'],false),
  ('public.automation_lane_enabled(text)',ARRAY['818a13be854748e2d272bdd648c88b59'],false),
  -- New: absent, or already this migration's body.
  ('public.job_party_flag_on()',ARRAY['65b443062e3189665c7527875510e0a1'],true),
  ('public.job_party_phone_key(text)',ARRAY['e5af2f3e7a4706de07ae167d43a04463'],true),
  ('public.job_party_email_key(text)',ARRAY['670df0b3697061286a48f63ecc261e70'],true),
  ('public.job_party_receipt(uuid,uuid,text,text,text,text,uuid,jsonb,jsonb,jsonb)',ARRAY['49c6aa92c24dd47585d8acdd8f78e12b'],true),
  ('public.job_party_reconsider(public.job_contacts,text)',ARRAY['5dd79285ad333d7221d82839a7c659ac'],true),
  ('public.upsert_job_party(uuid,text,jsonb,text,uuid)',ARRAY['5732f2e0c6f16675f52203c8fdb75322'],true),
  ('public.set_job_party_ids(uuid,text,text,text,text,text)',ARRAY['468ba14f0f8dce6ed92bd592ba48b801'],true),
  ('public.job_contacts_owner_mirror()',ARRAY['42e95ad1c5ecae48fc4f799ba0babf94'],true),
  ('public.context_contact_parties_at(text,timestamptz)',ARRAY['a78d5a40dfc528f9b47cc6e902216168'],true),
  ('public.context_job_event_parties(uuid)',ARRAY['1f6e013375788d1ad8129936f33b6dd2'],true),
  ('public.context_site_address(text)',ARRAY['e39b1844234efb0d0ca8206023761530'],true),
  ('public.context_site_candidates(uuid)',ARRAY['57ae7b5804383831ffb7a53ea08fab3c'],true),
  ('public.link_site_jobs(uuid,uuid,text,text,text,jsonb)',ARRAY['4181b749680808c81ac9bf92e1ce5fae'],true)
 ) AS t(sig,accepted,may_be_absent) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL AND x.may_be_absent THEN CONTINUE; END IF;
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 -- Any other object with a new name is a live change nobody read.
 FOR x IN SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('job_party_flag_on','job_party_phone_key','job_party_email_key','job_party_receipt',
   'job_party_reconsider','upsert_job_party','set_job_party_ids','job_contacts_owner_mirror','context_contact_parties_at',
   'context_job_event_parties','context_site_address','context_site_candidates','link_site_jobs','context_event_party')
  AND p.oid::regprocedure::text NOT IN ('job_party_flag_on()','job_party_phone_key(text)','job_party_email_key(text)',
   'job_party_receipt(uuid,uuid,text,text,text,text,uuid,jsonb,jsonb,jsonb)','job_party_reconsider(job_contacts,text)',
   'upsert_job_party(uuid,text,jsonb,text,uuid)','set_job_party_ids(uuid,text,text,text,text,text)','job_contacts_owner_mirror()',
   'context_contact_parties_at(text,timestamp with time zone)','context_job_event_parties(uuid)','context_site_address(text)',
   'context_site_candidates(uuid)','link_site_jobs(uuid,uuid,text,text,text,jsonb)') LOOP
  problems:=problems||format('unexpected function %s',x.sig);
 END LOOP;
 -- job_contacts: the live columns, before this migration's own.
 SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attname) INTO cols
 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.job_contacts') AND a.attnum>0 AND NOT a.attisdropped
  AND a.attname NOT IN ('party_role','source_party_key','effective_from','removed_at','last_link_checked_at','party_flags','phone_last9');
 IF cols IS DISTINCT FROM 'amount_invoiced:numeric(12,2),amount_paid:numeric(12,2),assigned_runs:jsonb,client_email:text,client_name:text,client_phone:text,contact_label:text,contact_type:text,created_at:timestamp with time zone,ghl_contact_id:text,id:uuid,is_primary:boolean,job_id:uuid,quote_value_ex_gst:numeric(12,2),share_percentage:numeric(5,2),site_address:text,status:text,updated_at:timestamp with time zone,xero_contact_id:text'
 THEN problems:=problems||format('job_contacts columns are %s',coalesce(cols,'<missing table>')); END IF;
 -- Columns the new functions read.
 FOR x IN SELECT * FROM (VALUES
  ('jobs','id','uuid'),('jobs','job_number','text'),('jobs','created_at','timestamp with time zone'),
  ('jobs','updated_at','timestamp with time zone'),('jobs','completed_at','timestamp with time zone'),('jobs','archived','boolean'),
  ('jobs','client_name','text'),('jobs','client_phone','text'),('jobs','client_email','text'),('jobs','ghl_contact_id','text'),
  ('jobs','xero_contact_id','text'),('jobs','site_address','text'),('jobs','site_suburb','text'),('jobs','metadata','jsonb'),
  ('jobs','status','text'),('jobs','type','text'),('jobs','pricing_json','jsonb'),
  ('xero_invoices','job_id','uuid'),('xero_invoices','job_contact_id','uuid'),('xero_invoices','xero_contact_id','text'),
  ('xero_invoices','invoice_type','text'),('xero_invoices','status','text'),
  ('xero_invoices','reference','text'),('xero_invoices','line_items','jsonb'),
  ('run_acceptances','job_contact_id','uuid'),('run_acceptances','created_at','timestamp with time zone'),
  ('job_documents','job_contact_id','uuid'),('job_documents','created_at','timestamp with time zone'),
  ('business_events','job_id','uuid'),('business_events','contact_id','text'),('business_events','event_at','timestamp with time zone'),
  ('business_events','occurred_at','timestamp with time zone'),('business_events','entity_type','text'),('business_events','entity_id','text'),
  ('business_events','event_type','text'),('business_events','payload','jsonb')
 ) AS c(tbl,col,typ) LOOP
  live:=NULL;
  SELECT format_type(a.atttypid,a.atttypmod) INTO live FROM pg_attribute a
  WHERE a.attrelid=to_regclass('public.'||x.tbl) AND a.attname=x.col AND a.attnum>0 AND NOT a.attisdropped;
  IF live IS DISTINCT FROM x.typ THEN problems:=problems||format('%s.%s is %s, expected %s',x.tbl,x.col,coalesce(live,'<missing>'),x.typ); END IF;
 END LOOP;
 -- Invoice dates: read as ::date, so a date or a timestamp both serve.
 FOR x IN SELECT * FROM (VALUES ('invoice_date'),('fully_paid_on')) AS c(col) LOOP
  live:=NULL;
  SELECT format_type(a.atttypid,a.atttypmod) INTO live FROM pg_attribute a
  WHERE a.attrelid=to_regclass('public.xero_invoices') AND a.attname=x.col AND a.attnum>0 AND NOT a.attisdropped;
  IF live IS NULL OR live NOT IN ('date','timestamp with time zone','timestamp without time zone')
  THEN problems:=problems||format('xero_invoices.%s is %s, expected a date or timestamp',x.col,coalesce(live,'<missing>')); END IF;
 END LOOP;
 -- The owner-mirror trigger: absent, or exactly this migration's.
 IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.jobs'::regclass AND NOT t.tgisinternal AND t.tgname='job_contacts_owner_mirror'
   AND t.tgfoid<>coalesce(to_regprocedure('public.job_contacts_owner_mirror()'),0::oid))
 THEN problems:=problems||'a jobs trigger named job_contacts_owner_mirror calls another function'::text; END IF;
 -- The two new tables: absent, or this migration's shape.
 IF to_regclass('public.job_party_events') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_attribute a
   WHERE a.attrelid=to_regclass('public.job_party_events') AND a.attname='change' AND NOT a.attisdropped)
 THEN problems:=problems||'job_party_events exists with another shape'::text; END IF;
 IF to_regclass('public.job_site_links') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_attribute a
   WHERE a.attrelid=to_regclass('public.job_site_links') AND a.attname='site_lead_job_id' AND NOT a.attisdropped)
 THEN problems:=problems||'job_site_links exists with another shape'::text; END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'job_parties_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. job_contacts columns. Nullable and additive: no existing row changes
-- except the generated phone_last9, which is computed from its own phone.
ALTER TABLE public.job_contacts
 ADD COLUMN IF NOT EXISTS party_role text,
 ADD COLUMN IF NOT EXISTS source_party_key text,
 ADD COLUMN IF NOT EXISTS effective_from timestamptz,
 ADD COLUMN IF NOT EXISTS removed_at timestamptz,
 ADD COLUMN IF NOT EXISTS last_link_checked_at timestamptz,
 ADD COLUMN IF NOT EXISTS party_flags text[] NOT NULL DEFAULT '{}'::text[],
 ADD COLUMN IF NOT EXISTS contact_type text;
-- Built-in functions only: a generated column's expression runs as the
-- writing role, so it must not depend on a revoked function (AGENTS.md
-- "Never index jobs on a revoked function"). Same rule as B0's
-- context_phone_key without the own-line list: fewer than 8 digits or one
-- repeated digit is a placeholder and yields null.
ALTER TABLE public.job_contacts ADD COLUMN IF NOT EXISTS phone_last9 text GENERATED ALWAYS AS (
 CASE WHEN length(regexp_replace(coalesce(client_phone,''),'[^0-9]','','g'))>=8
   AND regexp_replace(coalesce(client_phone,''),'[^0-9]','','g') !~ '^(\d)\1*$'
  THEN right(regexp_replace(client_phone,'[^0-9]','','g'),9) END) STORED;

ALTER TABLE public.job_contacts DROP CONSTRAINT IF EXISTS job_contacts_party_role_check;
ALTER TABLE public.job_contacts ADD CONSTRAINT job_contacts_party_role_check
 CHECK (party_role IS NULL OR party_role IN ('owner','neighbour','strata','strata_rep','builder','tenant','agent','other_payer'));
ALTER TABLE public.job_contacts DROP CONSTRAINT IF EXISTS job_contacts_source_party_key_check;
ALTER TABLE public.job_contacts ADD CONSTRAINT job_contacts_source_party_key_check
 CHECK (source_party_key IS NULL OR (source_party_key ~ '^(primary|[A-Za-z0-9:_.-]{1,80}(#[1-9][0-9]{0,3})?)$'
  AND (source_party_key='primary')=(source_party_key LIKE 'primary%')
  AND (source_party_key<>'primary' OR is_primary IS TRUE)));
ALTER TABLE public.job_contacts DROP CONSTRAINT IF EXISTS job_contacts_party_flags_check;
ALTER TABLE public.job_contacts ADD CONSTRAINT job_contacts_party_flags_check
 CHECK (party_flags <@ ARRAY['identity_conflict','ghl_contact_ambiguous','owner_id_divergence','shared_identity','placeholder_phone','ghl_link_failed']::text[]);
ALTER TABLE public.job_contacts DROP CONSTRAINT IF EXISTS job_contacts_removed_at_check;
ALTER TABLE public.job_contacts ADD CONSTRAINT job_contacts_removed_at_check
 CHECK (removed_at IS NULL OR status='removed');

CREATE UNIQUE INDEX IF NOT EXISTS job_contacts_job_source_party_key ON public.job_contacts(job_id,source_party_key)
 WHERE source_party_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS job_contacts_ghl_contact ON public.job_contacts(ghl_contact_id) WHERE ghl_contact_id IS NOT NULL;

-- The letter index: confirm it; create it only when missing and the letters
-- are already unique. Duplicates are counted by context_parties_status().
DO $letters$
DECLARE dup bigint;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid='public.job_contacts'::regclass AND i.indisunique AND i.indpred IS NULL
   AND i.indexprs IS NULL AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
    JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum)=ARRAY['job_id','contact_label']) THEN
  SELECT count(*) INTO dup FROM (SELECT 1 FROM public.job_contacts GROUP BY job_id,contact_label HAVING count(*)>1) d;
  IF dup=0 THEN
   CREATE UNIQUE INDEX idx_job_contacts_job_label ON public.job_contacts(job_id,contact_label);
  ELSE
   RAISE NOTICE 'job_contacts: % duplicate (job_id, contact_label) groups; the letter index was not created', dup;
  END IF;
 END IF;
END $letters$;

COMMENT ON COLUMN public.job_contacts.party_role IS
 'owner, neighbour, strata, strata_rep, builder, tenant, agent or other_payer. Written by upsert_job_party only (S-M1). Null on rows the writer has not touched.';
COMMENT ON COLUMN public.job_contacts.source_party_key IS
 'Stable party key within the job: the fence tool neighbour id (nb-1, nb-<epoch ms>), primary for the owner, staff:<uuid> for a staff-added payer, with #<n> after a replacement. Never the letter. Written by upsert_job_party only.';
COMMENT ON COLUMN public.job_contacts.effective_from IS
 'When the party joined the site (sites.md section 2 rule 6); never moved later once set. Messages from 30 days before it can be the party''s.';
COMMENT ON COLUMN public.job_contacts.removed_at IS 'When the party was soft-removed (status removed). Nothing is deleted.';
COMMENT ON COLUMN public.job_contacts.last_link_checked_at IS 'Last GHL contact search for this party by the party linker (S-M2).';
COMMENT ON COLUMN public.job_contacts.party_flags IS
 'Open data-quality flags: identity_conflict, ghl_contact_ambiguous, owner_id_divergence, shared_identity, placeholder_phone, ghl_link_failed. Counted by context_parties_status().';
COMMENT ON COLUMN public.job_contacts.phone_last9 IS 'Last 9 digits of client_phone; null for fewer than 8 digits or one repeated digit (a placeholder).';

-- 2. Receipts.
CREATE TABLE IF NOT EXISTS public.job_party_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
 job_contact_id uuid REFERENCES public.job_contacts(id) ON DELETE SET NULL,
 change text NOT NULL CHECK (change ~ '^[a-z][a-z0-9_]{2,62}$'),
 actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
 method text CHECK (method ~ '^[a-z][a-z0-9_.:-]{0,62}$'),
 match_basis text CHECK (match_basis ~ '^[a-z][a-z0-9_]{0,62}$'),
 run_id uuid,
 before jsonb CHECK (before IS NULL OR (jsonb_typeof(before)='object' AND octet_length(before::text)<=4096)),
 after jsonb CHECK (after IS NULL OR (jsonb_typeof(after)='object' AND octet_length(after::text)<=4096)),
 detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail)='object' AND octet_length(detail::text)<=4096)
);
CREATE INDEX IF NOT EXISTS job_party_events_job ON public.job_party_events(job_id,created_at DESC);
CREATE INDEX IF NOT EXISTS job_party_events_party ON public.job_party_events(job_contact_id,created_at DESC) WHERE job_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS job_party_events_change ON public.job_party_events(change,created_at DESC);
CREATE INDEX IF NOT EXISTS job_party_events_run ON public.job_party_events(run_id) WHERE run_id IS NOT NULL;
COMMENT ON TABLE public.job_party_events IS
 'One receipt per party writer call (upsert_job_party, set_job_party_ids), site-link decision (link_site_jobs) and failed owner mirror. Ids, codes and actor only, never names, phones or emails. Written only by those functions; service_role may read.';

-- 3. Same-site links between legacy split jobs. One row per linked job.
CREATE TABLE IF NOT EXISTS public.job_site_links (
 job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
 site_lead_job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
 link_kind text NOT NULL CHECK (link_kind IN ('split_party','option','stage','repeat')),
 status text NOT NULL CHECK (status IN ('proposed','confirmed','rejected')),
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=4096),
 proposed_by text,
 decided_by text,
 decided_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT job_site_links_not_self CHECK (job_id<>site_lead_job_id),
 CONSTRAINT job_site_links_decided CHECK ((status='proposed')=(decided_at IS NULL) AND (status='proposed' OR decided_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS job_site_links_lead ON public.job_site_links(site_lead_job_id);
CREATE INDEX IF NOT EXISTS job_site_links_proposed ON public.job_site_links(created_at) WHERE status='proposed';
COMMENT ON TABLE public.job_site_links IS
 'Legacy split sites: a job linked to the site''s lead job (split_party, option, stage or repeat), proposed, confirmed or rejected by a person. Written only by link_site_jobs; nothing is merged, moved or deleted.';

-- 4. Least privilege (sites review M7, INTEGRATION X32). service_role keeps
-- its job_contacts access: every writer today is an edge function.
ALTER TABLE public.job_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_party_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_site_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.job_contacts FROM PUBLIC,anon,authenticated;
REVOKE ALL ON TABLE public.job_party_events,public.job_site_links FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.job_party_events,public.job_site_links TO service_role;

-- 5. Private helpers.
-- Feature flag job_parties_v1. Fails closed: no table, no row or an error is off.
CREATE OR REPLACE FUNCTION public.job_party_flag_on() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v boolean;
BEGIN
 IF to_regclass('public.feature_flags') IS NULL THEN RETURN false; END IF;
 EXECUTE 'SELECT f.enabled FROM public.feature_flags f WHERE f.flag_name=$1 ORDER BY f.updated_at DESC NULLS LAST LIMIT 1' INTO v USING 'job_parties_v1';
 RETURN coalesce(v,false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

-- The same keys as the generated column and B0 (phone: last 9 digits, null for
-- a placeholder; email: lower-case trimmed, null when not an address).
CREATE OR REPLACE FUNCTION public.job_party_phone_key(p_phone text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN length(d)>=8 AND d !~ '^(\d)\1*$' THEN right(d,9) END
 FROM (SELECT regexp_replace(coalesce(p_phone,''),'[^0-9]','','g') AS d) k
$$;
CREATE OR REPLACE FUNCTION public.job_party_email_key(p_email text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN a ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN a END FROM (SELECT lower(btrim(coalesce(p_email,''))) AS a) k
$$;

-- One receipt row. Ids and codes only.
CREATE OR REPLACE FUNCTION public.job_party_receipt(p_job_id uuid,p_job_contact_id uuid,p_change text,p_actor text,p_method text,
 p_match_basis text,p_run_id uuid,p_before jsonb,p_after jsonb,p_detail jsonb) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 INSERT INTO public.job_party_events(job_id,job_contact_id,change,actor,method,match_basis,run_id,before,after,detail)
 VALUES(p_job_id,p_job_contact_id,p_change,left(p_actor,200),p_method,p_match_basis,p_run_id,p_before,p_after,coalesce(p_detail,'{}'::jsonb))
 RETURNING id
$$;

-- Ask the placement track to reconsider a newly linked party's messages
-- (X6). Only while job_parties_v1 is on; never fails the writer.
CREATE OR REPLACE FUNCTION public.job_party_reconsider(p_party public.job_contacts,p_ghl text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r jsonb;
BEGIN
 IF nullif(btrim(p_ghl),'') IS NULL THEN RETURN jsonb_build_object('outcome','no_contact'); END IF;
 IF NOT public.job_party_flag_on() THEN RETURN jsonb_build_object('outcome','flag_off'); END IF;
 BEGIN
  EXECUTE 'SELECT public.context_reconsider_contact($1,$2,$3,$4)' INTO r
   USING btrim(p_ghl),coalesce(p_party.effective_from,clock_timestamp())-interval '30 days','party_linked',p_party.job_id;
 EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('outcome','failed','code',SQLSTATE);
 END;
 RETURN jsonb_build_object('outcome',coalesce(r->>'outcome','done'))
  ||coalesce((SELECT jsonb_object_agg(k,r->k) FROM jsonb_object_keys(r) k WHERE k IN ('seen','placed','to_review','reopened','widened','unchanged','skipped_busy','truncated')),'{}'::jsonb);
END $$;

-- 6. The party writer.
-- p_fields keys (all optional; any other key refuses):
--   client_name, client_phone, client_email, site_address  identity and own address
--   ghl_contact_id, xero_contact_id  ids: set on insert; on an existing party
--                                    only filled when empty (a different id
--                                    is refused as an identity conflict)
--   party_role                       one of the eight roles
--   assigned_runs                    jsonb array of run labels
--   portion_inc_gst, portion_ex_gst, portions_total_inc_gst
--                                    shares come from portions (rule 5):
--                                    share = portion_inc / total; value =
--                                    portion_ex, else portion_inc / 1.1
--   status                           'active' or 'removed' (soft removal)
-- For the owner (key 'primary') the identity and id fields are refused
-- (owner_fields_follow_job): they are read from jobs.
-- Returns {outcome, job_contact_id, label, source_party_key, flags, ...}.
CREATE OR REPLACE FUNCTION public.upsert_job_party(p_job_id uuid,p_source_party_key text,p_fields jsonb,p_actor text,p_run_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 f jsonb:=coalesce(p_fields,'{}'::jsonb); k text:=btrim(p_source_party_key); actor text:=nullif(btrim(p_actor),'');
 j public.jobs; cur public.job_contacts; nw public.job_contacts; is_owner boolean;
 in_name text; in_phone text; in_email text; in_addr text; in_ghl text; in_xero text; in_role text;
 pk text; ek text; n int; cnt int; outcome text; detail jsonb:='{}'::jsonb; flags_raised text[]:='{}'; before jsonb; recon jsonb;
 portion_inc numeric; portion_ex numeric; total_inc numeric; share numeric; qv numeric; eff timestamptz; letter text; ms text;
 disagree boolean; anchored boolean; replaced uuid; set_ghl boolean:=false; conflicts jsonb:='[]'::jsonb; divergence jsonb:='[]'::jsonb;
 replaced_ids jsonb:='[]'::jsonb; id_field text; job_val text; row_val text;
BEGIN
 -- Contract checks.
 IF p_job_id IS NULL THEN RAISE EXCEPTION 'party_job_required'; END IF;
 IF actor IS NULL OR length(actor)>200 THEN RAISE EXCEPTION 'party_actor_required'; END IF;
 IF k IS NULL OR k !~ '^(primary|[A-Za-z0-9:_.-]{1,80})$' THEN RAISE EXCEPTION 'party_key_invalid'; END IF;
 IF jsonb_typeof(f)<>'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(f) x WHERE x NOT IN ('client_name','client_phone','client_email',
   'site_address','ghl_contact_id','xero_contact_id','party_role','assigned_runs','portion_inc_gst','portion_ex_gst','portions_total_inc_gst','status'))
 THEN RAISE EXCEPTION 'party_field_unknown'; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_each(f) e WHERE e.key IN ('client_name','client_phone','client_email','site_address','ghl_contact_id',
   'xero_contact_id','party_role','status') AND jsonb_typeof(e.value) NOT IN ('string','null'))
  OR EXISTS (SELECT 1 FROM jsonb_each(f) e WHERE e.key IN ('portion_inc_gst','portion_ex_gst','portions_total_inc_gst')
   AND (jsonb_typeof(e.value) NOT IN ('number','null') OR (jsonb_typeof(e.value)='number' AND (e.value)::text::numeric<0)))
  OR (f ? 'assigned_runs' AND jsonb_typeof(f->'assigned_runs') NOT IN ('array','null'))
 THEN RAISE EXCEPTION 'party_field_invalid'; END IF;
 IF f ? 'status' AND f->>'status' NOT IN ('active','removed') THEN RAISE EXCEPTION 'party_field_invalid'; END IF;
 in_role:=nullif(btrim(f->>'party_role'),'');
 IF in_role IS NOT NULL AND in_role NOT IN ('owner','neighbour','strata','strata_rep','builder','tenant','agent','other_payer') THEN RAISE EXCEPTION 'party_role_invalid'; END IF;
 is_owner:=(k='primary');
 IF is_owner AND (f ?| ARRAY['client_name','client_phone','client_email','ghl_contact_id','xero_contact_id']) THEN RAISE EXCEPTION 'owner_fields_follow_job'; END IF;
 IF is_owner AND in_role IS NOT NULL AND in_role<>'owner' THEN RAISE EXCEPTION 'party_role_invalid'; END IF;
 IF NOT is_owner AND in_role='owner' THEN RAISE EXCEPTION 'party_role_invalid'; END IF;

 SELECT * INTO j FROM public.jobs WHERE id=p_job_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'party_job_not_found'; END IF;
 -- One writer at a time per job: letters and replacements stay consistent.
 PERFORM pg_advisory_xact_lock(hashtextextended('job_party:'||p_job_id::text,0));

 IF is_owner THEN
  in_name:=nullif(btrim(j.client_name),''); in_phone:=nullif(btrim(j.client_phone),''); in_email:=nullif(btrim(j.client_email),'');
  in_ghl:=nullif(btrim(j.ghl_contact_id),''); in_xero:=nullif(btrim(j.xero_contact_id),'');
 ELSE
  in_name:=nullif(btrim(f->>'client_name'),''); in_phone:=nullif(btrim(f->>'client_phone'),''); in_email:=nullif(btrim(f->>'client_email'),'');
  in_ghl:=nullif(btrim(f->>'ghl_contact_id'),''); in_xero:=nullif(btrim(f->>'xero_contact_id'),'');
 END IF;
 in_addr:=nullif(btrim(f->>'site_address'),'');
 pk:=public.job_party_phone_key(in_phone); ek:=public.job_party_email_key(in_email);

 -- Shares from portions (rule 5).
 portion_inc:=(f->>'portion_inc_gst')::numeric; portion_ex:=(f->>'portion_ex_gst')::numeric; total_inc:=(f->>'portions_total_inc_gst')::numeric;
 IF portion_inc IS NOT NULL AND total_inc IS NOT NULL AND total_inc>0 THEN share:=round(100*portion_inc/total_inc,2); END IF;
 IF share IS NOT NULL AND share>100 THEN RAISE EXCEPTION 'party_portion_exceeds_total'; END IF;
 qv:=coalesce(portion_ex,round(portion_inc/1.1,2));

 -- The key's current holder: the key itself or its latest '#<n>' replacement.
 SELECT c.* INTO cur FROM public.job_contacts c
 WHERE c.job_id=p_job_id AND (c.source_party_key=k OR c.source_party_key ~ ('^'||regexp_replace(k,'([.\\+*?\[^\]$(){}=!<>|:-])','\\\1','g')||'#[0-9]+$'))
 ORDER BY coalesce(nullif(substring(c.source_party_key from '#([0-9]+)$'),'')::int,1) DESC LIMIT 1 FOR UPDATE;

 IF NOT FOUND THEN
  -- Adopt a legacy row with no key rather than duplicate a party that exists:
  -- the owner row by is_primary; a neighbour only by an equal phone or email key.
  SELECT count(*) INTO cnt FROM public.job_contacts c WHERE c.job_id=p_job_id AND c.source_party_key IS NULL
   AND ((is_owner AND c.is_primary IS TRUE)
    OR (NOT is_owner AND c.is_primary IS NOT TRUE AND ((pk IS NOT NULL AND c.phone_last9=pk) OR (ek IS NOT NULL AND public.job_party_email_key(c.client_email)=ek))));
  IF cnt>1 THEN RAISE EXCEPTION 'party_adopt_ambiguous'; END IF;
  IF cnt=1 THEN
   SELECT c.* INTO cur FROM public.job_contacts c WHERE c.job_id=p_job_id AND c.source_party_key IS NULL
    AND ((is_owner AND c.is_primary IS TRUE)
     OR (NOT is_owner AND c.is_primary IS NOT TRUE AND ((pk IS NOT NULL AND c.phone_last9=pk) OR (ek IS NOT NULL AND public.job_party_email_key(c.client_email)=ek))))
   FOR UPDATE;
   UPDATE public.job_contacts SET source_party_key=k WHERE id=cur.id RETURNING * INTO cur;
   detail:=detail||jsonb_build_object('adopted',true);
  END IF;
 END IF;

 IF cur.id IS NOT NULL AND NOT is_owner THEN
  -- Rule 3: a reused key never rewrites a person.
  disagree:=false;
  IF (pk IS NOT NULL AND cur.phone_last9 IS NOT NULL) OR (ek IS NOT NULL AND public.job_party_email_key(cur.client_email) IS NOT NULL) THEN
   disagree:=(pk IS NULL OR cur.phone_last9 IS NULL OR pk<>cur.phone_last9)
    AND (ek IS NULL OR public.job_party_email_key(cur.client_email) IS NULL OR ek<>public.job_party_email_key(cur.client_email));
  ELSIF in_name IS NOT NULL AND nullif(btrim(cur.client_name),'') IS NOT NULL THEN
   disagree:=NOT EXISTS (SELECT 1 FROM regexp_split_to_table(lower(in_name),'[^a-z0-9]+') a
    JOIN regexp_split_to_table(lower(cur.client_name),'[^a-z0-9]+') b ON a=b WHERE length(a)>=2);
  END IF;
  IF disagree THEN
   anchored:=nullif(btrim(cur.ghl_contact_id),'') IS NOT NULL OR nullif(btrim(cur.xero_contact_id),'') IS NOT NULL
    OR EXISTS (SELECT 1 FROM public.job_documents d WHERE d.job_contact_id=cur.id)
    OR EXISTS (SELECT 1 FROM public.xero_invoices x WHERE x.job_contact_id=cur.id)
    OR EXISTS (SELECT 1 FROM public.run_acceptances r WHERE r.job_contact_id=cur.id);
   IF anchored THEN
    UPDATE public.job_contacts SET status='removed',removed_at=coalesce(removed_at,clock_timestamp()),updated_at=now() WHERE id=cur.id;
    replaced:=cur.id;
    n:=coalesce(nullif(substring(cur.source_party_key from '#([0-9]+)$'),'')::int,1)+1;
    k:=k||'#'||n;
    cur:=NULL;
   END IF;
  END IF;
 END IF;

 IF cur.id IS NULL THEN
  -- Insert. The name is required by the table.
  IF in_name IS NULL THEN RAISE EXCEPTION 'party_name_required'; END IF;
  SELECT l INTO letter FROM (SELECT chr(64+g) AS l, g FROM generate_series(1,26) g) a
  WHERE NOT EXISTS (SELECT 1 FROM public.job_contacts c WHERE c.job_id=p_job_id AND c.contact_label=a.l) ORDER BY g LIMIT 1;
  IF letter IS NULL THEN RAISE EXCEPTION 'party_letters_exhausted'; END IF;
  -- Rule 6: effective_from.
  ms:=substring(split_part(k,'#',1) from '^nb-([0-9]{13})$');
  IF ms IS NOT NULL THEN eff:=to_timestamp(ms::numeric/1000);
  ELSE eff:=coalesce(j.created_at,clock_timestamp()); END IF;
  INSERT INTO public.job_contacts(job_id,contact_label,client_name,client_phone,client_email,site_address,ghl_contact_id,xero_contact_id,
   share_percentage,quote_value_ex_gst,assigned_runs,is_primary,status,contact_type,party_role,source_party_key,effective_from,party_flags)
  VALUES(p_job_id,letter,in_name,in_phone,in_email,in_addr,in_ghl,in_xero,
   coalesce(share,CASE WHEN is_owner THEN 100 ELSE 0 END),coalesce(qv,0),CASE WHEN jsonb_typeof(f->'assigned_runs')='array' THEN f->'assigned_runs' END,
   is_owner,CASE WHEN f->>'status'='removed' THEN 'removed' ELSE 'active' END,
   CASE WHEN is_owner THEN 'primary' ELSE 'neighbour_'||lower(letter) END,
   coalesce(in_role,CASE WHEN is_owner THEN 'owner' ELSE 'neighbour' END),k,eff,
   CASE WHEN in_phone IS NOT NULL AND pk IS NULL THEN ARRAY['placeholder_phone'] ELSE '{}'::text[] END)
  RETURNING * INTO nw;
  IF f->>'status'='removed' THEN UPDATE public.job_contacts SET removed_at=clock_timestamp() WHERE id=nw.id RETURNING * INTO nw; END IF;
  outcome:=CASE WHEN replaced IS NOT NULL THEN 'party_replaced' ELSE 'party_inserted' END;
  IF replaced IS NOT NULL THEN detail:=detail||jsonb_build_object('replaced_job_contact_id',replaced); END IF;
  set_ghl:=nw.ghl_contact_id IS NOT NULL;
  before:=NULL;
 ELSE
  before:=jsonb_build_object('status',cur.status,'label',cur.contact_label,'party_role',cur.party_role,'ghl_contact_id',cur.ghl_contact_id,
   'xero_contact_id',cur.xero_contact_id,'share_percentage',cur.share_percentage,'flags',to_jsonb(cur.party_flags));
  nw:=cur;
  IF in_name IS NOT NULL THEN nw.client_name:=in_name; END IF;
  IF is_owner THEN nw.client_phone:=in_phone; nw.client_email:=in_email;
  ELSE
   IF f ? 'client_phone' THEN nw.client_phone:=in_phone; END IF;
   IF f ? 'client_email' THEN nw.client_email:=in_email; END IF;
  END IF;
  IF f ? 'site_address' THEN nw.site_address:=in_addr; END IF;
  IF f ? 'assigned_runs' THEN nw.assigned_runs:=CASE WHEN jsonb_typeof(f->'assigned_runs')='array' THEN f->'assigned_runs' END; END IF;
  IF in_role IS NOT NULL THEN nw.party_role:=in_role; ELSIF nw.party_role IS NULL THEN nw.party_role:=CASE WHEN is_owner THEN 'owner' ELSE 'neighbour' END; END IF;
  IF share IS NOT NULL THEN nw.share_percentage:=share; END IF;
  IF qv IS NOT NULL THEN nw.quote_value_ex_gst:=qv; END IF;
  IF nw.effective_from IS NULL THEN
   ms:=substring(split_part(k,'#',1) from '^nb-([0-9]{13})$');
   nw.effective_from:=CASE WHEN ms IS NOT NULL THEN to_timestamp(ms::numeric/1000) ELSE least(
    (SELECT min(d.created_at) FROM public.job_documents d WHERE d.job_contact_id=cur.id),
    (SELECT min(x.invoice_date::date)::timestamptz FROM public.xero_invoices x WHERE x.job_contact_id=cur.id),
    (SELECT min(r.created_at) FROM public.run_acceptances r WHERE r.job_contact_id=cur.id),
    coalesce(j.created_at,clock_timestamp())) END;
  END IF;
  -- Ids.
  FOREACH id_field IN ARRAY ARRAY['ghl_contact_id','xero_contact_id'] LOOP
   job_val:=CASE id_field WHEN 'ghl_contact_id' THEN in_ghl ELSE in_xero END;
   row_val:=nullif(btrim(CASE id_field WHEN 'ghl_contact_id' THEN cur.ghl_contact_id ELSE cur.xero_contact_id END),'');
   IF is_owner THEN
    -- Rule 4: jobs wins; a null never overwrites a set id.
    IF job_val IS NULL AND row_val IS NOT NULL THEN divergence:=divergence||jsonb_build_array(id_field);
    ELSIF job_val IS NOT NULL AND job_val IS DISTINCT FROM row_val THEN
     IF row_val IS NOT NULL THEN replaced_ids:=replaced_ids||jsonb_build_object('field',id_field,'old',row_val); END IF;
     IF id_field='ghl_contact_id' THEN nw.ghl_contact_id:=job_val; set_ghl:=true; ELSE nw.xero_contact_id:=job_val; END IF;
    END IF;
   ELSIF f ? id_field AND job_val IS NOT NULL THEN
    IF row_val IS NULL THEN
     IF id_field='ghl_contact_id' THEN nw.ghl_contact_id:=job_val; set_ghl:=true; ELSE nw.xero_contact_id:=job_val; END IF;
    ELSIF row_val<>job_val THEN conflicts:=conflicts||jsonb_build_array(id_field);
    END IF;
   END IF;
  END LOOP;
  IF jsonb_array_length(conflicts)>0 THEN flags_raised:=flags_raised||'identity_conflict'::text; END IF;
  -- The owner_id_divergence flag is exactly "jobs has a null where the owner row has an id".
  IF is_owner THEN
   nw.party_flags:=array_remove(nw.party_flags,'owner_id_divergence');
   IF jsonb_array_length(divergence)>0 THEN nw.party_flags:=nw.party_flags||'owner_id_divergence'::text; flags_raised:=flags_raised||'owner_id_divergence'::text; END IF;
  END IF;
  nw.party_flags:=array_remove(nw.party_flags,'placeholder_phone');
  IF nw.client_phone IS NOT NULL AND public.job_party_phone_key(nw.client_phone) IS NULL THEN nw.party_flags:=nw.party_flags||'placeholder_phone'::text; END IF;
  IF 'identity_conflict'=ANY(flags_raised) AND NOT 'identity_conflict'=ANY(nw.party_flags) THEN nw.party_flags:=nw.party_flags||'identity_conflict'::text; END IF;
  SELECT coalesce(array_agg(DISTINCT x ORDER BY x),'{}') INTO nw.party_flags FROM unnest(nw.party_flags) x;
  -- Status.
  IF f->>'status'='removed' AND cur.status IS DISTINCT FROM 'removed' THEN nw.status:='removed'; nw.removed_at:=clock_timestamp(); outcome:='party_removed';
  ELSIF coalesce(f->>'status','active')='active' AND cur.status='removed' AND (f ? 'status' OR in_name IS NOT NULL OR pk IS NOT NULL OR ek IS NOT NULL) THEN
   nw.status:='active'; nw.removed_at:=NULL; outcome:='party_restored';
  END IF;
  IF (nw.client_name,nw.client_phone,nw.client_email,nw.site_address,nw.assigned_runs,nw.party_role,nw.share_percentage,nw.quote_value_ex_gst,
      nw.effective_from,nw.ghl_contact_id,nw.xero_contact_id,nw.party_flags,nw.status,nw.removed_at)
   IS NOT DISTINCT FROM (cur.client_name,cur.client_phone,cur.client_email,cur.site_address,cur.assigned_runs,cur.party_role,cur.share_percentage,
      cur.quote_value_ex_gst,cur.effective_from,cur.ghl_contact_id,cur.xero_contact_id,cur.party_flags,cur.status,cur.removed_at)
  THEN outcome:=coalesce(outcome,CASE WHEN detail ? 'adopted' THEN 'party_adopted' ELSE 'party_unchanged' END);
  ELSE
   UPDATE public.job_contacts SET client_name=nw.client_name,client_phone=nw.client_phone,client_email=nw.client_email,site_address=nw.site_address,
    assigned_runs=nw.assigned_runs,party_role=nw.party_role,share_percentage=nw.share_percentage,quote_value_ex_gst=nw.quote_value_ex_gst,
    effective_from=nw.effective_from,ghl_contact_id=nw.ghl_contact_id,xero_contact_id=nw.xero_contact_id,party_flags=nw.party_flags,
    status=nw.status,removed_at=nw.removed_at,updated_at=now()
   WHERE id=cur.id RETURNING * INTO nw;
   outcome:=coalesce(outcome,CASE WHEN detail ? 'adopted' THEN 'party_adopted' ELSE 'party_updated' END);
  END IF;
 END IF;

 IF jsonb_array_length(conflicts)>0 THEN detail:=detail||jsonb_build_object('identity_conflict',conflicts); END IF;
 IF jsonb_array_length(divergence)>0 THEN detail:=detail||jsonb_build_object('owner_id_divergence',divergence); END IF;
 IF jsonb_array_length(replaced_ids)>0 THEN detail:=detail||jsonb_build_object('replaced_ids',replaced_ids); END IF;
 IF share IS NOT NULL THEN detail:=detail||jsonb_build_object('share_from_portions',share); END IF;
 IF set_ghl THEN recon:=public.job_party_reconsider(nw,nw.ghl_contact_id); detail:=detail||jsonb_build_object('reconsider',recon); END IF;
 PERFORM public.job_party_receipt(p_job_id,nw.id,outcome,actor,CASE WHEN is_owner AND actor='jobs_trigger' THEN 'owner_mirror' ELSE 'upsert' END,
  NULL,p_run_id,before,
  jsonb_build_object('status',nw.status,'label',nw.contact_label,'party_role',nw.party_role,'source_party_key',nw.source_party_key,
   'ghl_contact_id',nw.ghl_contact_id,'xero_contact_id',nw.xero_contact_id,'share_percentage',nw.share_percentage,'flags',to_jsonb(nw.party_flags)),
  detail);
 RETURN jsonb_build_object('outcome',outcome,'job_contact_id',nw.id,'label',nw.contact_label,'source_party_key',nw.source_party_key,
  'status',nw.status,'flags',to_jsonb(nw.party_flags),'flags_raised',to_jsonb(flags_raised),'replaced_job_contact_id',replaced,'reconsider',recon);
END $$;
COMMENT ON FUNCTION public.upsert_job_party(uuid,text,jsonb,text,uuid) IS
 'The one party writer (sites.md section 2). Keyed on (job_id, source_party_key), never the letter; letters assigned once and never reused; soft removal; a reused key on an anchored party with a disagreeing identity retires it and inserts <key>#<n>; the owner (primary) mirrors jobs one way (null never over a set id: owner_id_divergence; jobs wins otherwise); shares from portions; one job_party_events receipt per call. Refusals: party_job_required, party_actor_required, party_key_invalid, party_field_unknown, party_field_invalid, party_role_invalid, owner_fields_follow_job, party_job_not_found, party_portion_exceeds_total, party_adopt_ambiguous, party_name_required, party_letters_exhausted.';

-- 7. The only way a neighbour party's contact ids change.
-- p_match_basis: phone, email, both, staff, accept, invoice, backfill; or, for
-- a linker check that links nothing: none, ambiguous, phone_differs,
-- email_differs (records last_link_checked_at and the matching flag).
CREATE OR REPLACE FUNCTION public.set_job_party_ids(p_job_contact_id uuid,p_ghl_contact_id text,p_xero_contact_id text,p_method text,
 p_match_basis text,p_actor text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 cur public.job_contacts; nw public.job_contacts; ghl text:=nullif(btrim(p_ghl_contact_id),''); xero text:=nullif(btrim(p_xero_contact_id),'');
 actor text:=coalesce(nullif(btrim(p_actor),''),'method:'||coalesce(p_method,'unknown')); m text:=nullif(btrim(p_method),'');
 conflicts jsonb:='[]'::jsonb; outcome text; recon jsonb; set_ghl boolean:=false; detail jsonb:='{}'::jsonb;
BEGIN
 IF p_job_contact_id IS NULL THEN RAISE EXCEPTION 'party_required'; END IF;
 IF m IS NULL OR m !~ '^[a-z][a-z0-9_.:-]{0,62}$' THEN RAISE EXCEPTION 'party_method_required'; END IF;
 IF p_match_basis IS NOT NULL AND p_match_basis NOT IN ('phone','email','both','staff','accept','invoice','backfill','none','ambiguous','phone_differs','email_differs')
 THEN RAISE EXCEPTION 'party_match_basis_invalid'; END IF;
 IF p_match_basis IN ('none','ambiguous','phone_differs','email_differs') AND (ghl IS NOT NULL OR xero IS NOT NULL) THEN RAISE EXCEPTION 'party_match_basis_invalid'; END IF;
 SELECT job_id INTO nw.job_id FROM public.job_contacts WHERE id=p_job_contact_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'party_not_found'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('job_party:'||nw.job_id::text,0));
 SELECT * INTO cur FROM public.job_contacts WHERE id=p_job_contact_id FOR UPDATE;
 IF cur.is_primary IS TRUE OR cur.source_party_key='primary' THEN RAISE EXCEPTION 'owner_ids_follow_job'; END IF;
 nw:=cur;
 IF ghl IS NOT NULL THEN
  IF nullif(btrim(cur.ghl_contact_id),'') IS NULL THEN nw.ghl_contact_id:=ghl; set_ghl:=true;
  ELSIF btrim(cur.ghl_contact_id)<>ghl THEN conflicts:=conflicts||jsonb_build_array('ghl_contact_id'); END IF;
 END IF;
 IF xero IS NOT NULL THEN
  IF nullif(btrim(cur.xero_contact_id),'') IS NULL THEN nw.xero_contact_id:=xero;
  ELSIF btrim(cur.xero_contact_id)<>xero THEN conflicts:=conflicts||jsonb_build_array('xero_contact_id'); END IF;
 END IF;
 IF m='linker' OR p_match_basis IN ('none','ambiguous','phone_differs','email_differs') THEN nw.last_link_checked_at:=clock_timestamp(); END IF;
 IF p_match_basis='ambiguous' THEN nw.party_flags:=nw.party_flags||'ghl_contact_ambiguous'::text; END IF;
 IF set_ghl THEN nw.party_flags:=array_remove(nw.party_flags,'ghl_contact_ambiguous'); END IF;
 IF jsonb_array_length(conflicts)>0 OR p_match_basis IN ('phone_differs','email_differs') THEN nw.party_flags:=nw.party_flags||'identity_conflict'::text; END IF;
 SELECT coalesce(array_agg(DISTINCT x ORDER BY x),'{}') INTO nw.party_flags FROM unnest(nw.party_flags) x;
 outcome:=CASE WHEN jsonb_array_length(conflicts)>0 THEN 'party_identity_conflict'
  WHEN p_match_basis IN ('phone_differs','email_differs') THEN 'party_identity_conflict'
  WHEN p_match_basis='ambiguous' THEN 'party_link_ambiguous'
  WHEN nw.ghl_contact_id IS DISTINCT FROM cur.ghl_contact_id OR nw.xero_contact_id IS DISTINCT FROM cur.xero_contact_id THEN 'party_ids_set'
  WHEN p_match_basis='none' THEN 'party_link_checked'
  ELSE 'party_ids_unchanged' END;
 IF (nw.ghl_contact_id,nw.xero_contact_id,nw.last_link_checked_at,nw.party_flags) IS DISTINCT FROM
    (cur.ghl_contact_id,cur.xero_contact_id,cur.last_link_checked_at,cur.party_flags) THEN
  UPDATE public.job_contacts SET ghl_contact_id=nw.ghl_contact_id,xero_contact_id=nw.xero_contact_id,last_link_checked_at=nw.last_link_checked_at,
   party_flags=nw.party_flags,updated_at=now() WHERE id=cur.id RETURNING * INTO nw;
 END IF;
 IF jsonb_array_length(conflicts)>0 THEN detail:=detail||jsonb_build_object('identity_conflict',conflicts); END IF;
 IF set_ghl THEN recon:=public.job_party_reconsider(nw,ghl); detail:=detail||jsonb_build_object('reconsider',recon); END IF;
 PERFORM public.job_party_receipt(cur.job_id,cur.id,outcome,actor,m,p_match_basis,NULL,
  jsonb_build_object('ghl_contact_id',cur.ghl_contact_id,'xero_contact_id',cur.xero_contact_id,'flags',to_jsonb(cur.party_flags)),
  jsonb_build_object('ghl_contact_id',nw.ghl_contact_id,'xero_contact_id',nw.xero_contact_id,'flags',to_jsonb(nw.party_flags)),detail);
 RETURN jsonb_build_object('outcome',outcome,'job_contact_id',cur.id,'ghl_contact_id',nw.ghl_contact_id,'xero_contact_id',nw.xero_contact_id,
  'flags',to_jsonb(nw.party_flags),'reconsider',recon);
END $$;
COMMENT ON FUNCTION public.set_job_party_ids(uuid,text,text,text,text,text) IS
 'The only way a neighbour party''s GHL or Xero id changes: fills an empty id, never overwrites a different one (party_identity_conflict receipt and identity_conflict flag), refuses owner rows (owner_ids_follow_job), records linker checks (none, ambiguous, phone_differs, email_differs). A newly set GHL id asks for reconsideration of that contact''s messages while job_parties_v1 is on. One receipt per call.';

-- 8. The owner mirror (X19): jobs owns the owner's contact; the owner party
-- follows it one way through the writer. Only for a job whose owner party is
-- already keyed primary. Never fails the job update.
CREATE OR REPLACE FUNCTION public.job_contacts_owner_mirror() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.job_contacts c WHERE c.job_id=NEW.id AND c.source_party_key='primary') THEN RETURN NULL; END IF;
 BEGIN
  PERFORM public.upsert_job_party(NEW.id,'primary','{}'::jsonb,'jobs_trigger',NULL);
 EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'job owner party mirror failed for job %: SQLSTATE %',NEW.id,SQLSTATE;
  PERFORM public.job_party_receipt(NEW.id,(SELECT c.id FROM public.job_contacts c WHERE c.job_id=NEW.id AND c.source_party_key='primary'),
   'owner_mirror_failed','jobs_trigger','owner_mirror',NULL,NULL,NULL,NULL,jsonb_build_object('code',SQLSTATE));
 END;
 RETURN NULL;
END $$;
COMMENT ON FUNCTION public.job_contacts_owner_mirror() IS
 'AFTER UPDATE of the owner contact columns on jobs: mirrors the job into its owner party (key primary) through upsert_job_party. Does nothing for a job with no primary-keyed party. A failure is a receipt (owner_mirror_failed) and a warning, never a failed job update.';
DROP TRIGGER IF EXISTS job_contacts_owner_mirror ON public.jobs;
CREATE TRIGGER job_contacts_owner_mirror AFTER UPDATE OF client_name,client_phone,client_email,ghl_contact_id,xero_contact_id ON public.jobs
 FOR EACH ROW WHEN (OLD.client_name IS DISTINCT FROM NEW.client_name OR OLD.client_phone IS DISTINCT FROM NEW.client_phone
  OR OLD.client_email IS DISTINCT FROM NEW.client_email OR OLD.ghl_contact_id IS DISTINCT FROM NEW.ghl_contact_id
  OR OLD.xero_contact_id IS DISTINCT FROM NEW.xero_contact_id)
 EXECUTE FUNCTION public.job_contacts_owner_mirror();

-- 9. Party jobs of a GHL contact at a moment (sites.md section 4, review B3).
-- clause: 'a' (created by then and not terminal before it, or inside the lead
-- window of a job created later), 'b_unpaid' (terminal before it, but the
-- party had an invoice there dated by then and not fully paid by then),
-- 'b_window' (terminal before it, and within 60 days after the later of the
-- terminal time and the party's last invoice dated by then). The party must
-- exist then: effective_from minus 30 days at or before it, not removed
-- before it (a removed row with no removed_at counts as removed at its
-- updated_at). A row with no effective_from yet uses the job's creation.
-- Terminal time follows context_contact_job_timeline (P1a): the job's own
-- job.status_changed evidence, then completed_at, then updated_at.
CREATE OR REPLACE FUNCTION public.context_contact_parties_at(p_contact_id text,p_at timestamptz)
RETURNS TABLE(job_id uuid,job_contact_id uuid,party_role text,label text,clause text,terminal_at timestamptz,terminal_time_source text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH at AS (SELECT coalesce(p_at,now()) AS t),
 p AS (
  SELECT c.id,c.job_id,coalesce(c.party_role,CASE WHEN c.is_primary THEN 'owner' ELSE 'neighbour' END) AS party_role,c.contact_label,
   nullif(btrim(c.xero_contact_id),'') AS xero,
   coalesce(c.effective_from,j.created_at,'-infinity'::timestamptz) AS eff,
   coalesce(c.removed_at,CASE WHEN c.status='removed' THEN coalesce(c.updated_at,'-infinity'::timestamptz) END) AS removed,
   coalesce(j.created_at,'-infinity'::timestamptz) AS created_at,
   (j.status::text IN ('cancelled','archived','lost','closed','complete','completed') OR coalesce(j.archived,false)) AS terminal,
   j.completed_at,j.updated_at
  FROM public.job_contacts c JOIN public.jobs j ON j.id=c.job_id
  WHERE nullif(btrim(p_contact_id),'') IS NOT NULL AND c.ghl_contact_id=btrim(p_contact_id)
   AND coalesce(j.metadata->>'do_not_schedule','') NOT IN ('true','1')
 ), live AS (
  SELECT p.* FROM p, at WHERE p.eff-interval '30 days'<=at.t AND (p.removed IS NULL OR p.removed>at.t)
 ), timed AS (
  SELECT l.*,
   CASE WHEN NOT l.terminal THEN NULL ELSE coalesce(ev.at,l.completed_at,l.updated_at,'-infinity'::timestamptz) END AS terminal_at,
   CASE WHEN NOT l.terminal THEN NULL WHEN ev.at IS NOT NULL THEN 'status_event' WHEN l.completed_at IS NOT NULL THEN 'completed_at'
    WHEN l.updated_at IS NOT NULL THEN 'updated_at' ELSE 'unknown' END AS terminal_time_source
  FROM live l
  LEFT JOIN LATERAL (
   SELECT min(coalesce(be.event_at,be.occurred_at)) AS at FROM public.business_events be
   WHERE l.terminal AND be.entity_type='job' AND be.entity_id=l.job_id::text AND be.event_type='job.status_changed'
    AND lower(be.payload->'changes'->'status'->>'to') IN ('cancelled','archived','lost','closed','complete','completed')
    AND coalesce(be.event_at,be.occurred_at) > coalesce((
     SELECT max(coalesce(nt.event_at,nt.occurred_at)) FROM public.business_events nt
     WHERE nt.entity_type='job' AND nt.entity_id=l.job_id::text AND nt.event_type='job.status_changed'
      AND lower(nt.payload->'changes'->'status'->>'to') NOT IN ('cancelled','archived','lost','closed','complete','completed')
    ),'-infinity'::timestamptz)
  ) ev ON true
 ), money AS (
  SELECT t.*,
   EXISTS (SELECT 1 FROM public.xero_invoices x, at WHERE x.job_id=t.job_id AND x.invoice_type='ACCREC'
    AND upper(coalesce(x.status,'')) NOT IN ('VOIDED','DELETED')
    AND (x.job_contact_id=t.id OR (t.xero IS NOT NULL AND x.xero_contact_id=t.xero))
    AND x.invoice_date::date<=(at.t AT TIME ZONE 'Australia/Perth')::date
    AND (x.fully_paid_on IS NULL OR x.fully_paid_on::date>(at.t AT TIME ZONE 'Australia/Perth')::date)) AS unpaid_at,
   (SELECT max(x.invoice_date::date) FROM public.xero_invoices x, at WHERE x.job_id=t.job_id AND x.invoice_type='ACCREC'
    AND upper(coalesce(x.status,'')) NOT IN ('VOIDED','DELETED')
    AND (x.job_contact_id=t.id OR (t.xero IS NOT NULL AND x.xero_contact_id=t.xero))
    AND x.invoice_date::date<=(at.t AT TIME ZONE 'Australia/Perth')::date) AS last_invoice_date
  FROM timed t
 )
 SELECT m.job_id,m.id,m.party_role,m.contact_label,
  CASE
   WHEN m.created_at<=at.t AND (NOT m.terminal OR m.terminal_at>at.t) THEN 'a'
   WHEN m.created_at>at.t AND m.created_at-interval '30 days'<=at.t THEN 'a'
   WHEN m.terminal AND m.terminal_at<=at.t AND m.unpaid_at THEN 'b_unpaid'
   WHEN m.terminal AND m.terminal_at<=at.t
    AND at.t<=greatest(m.terminal_at,coalesce((m.last_invoice_date::timestamp AT TIME ZONE 'Australia/Perth')+interval '1 day','-infinity'::timestamptz))+interval '60 days'
   THEN 'b_window' END,
  m.terminal_at,m.terminal_time_source
 FROM money m, at
 WHERE (m.created_at<=at.t AND (NOT m.terminal OR m.terminal_at>at.t))
  OR (m.created_at>at.t AND m.created_at-interval '30 days'<=at.t)
  OR (m.terminal AND m.terminal_at<=at.t AND (m.unpaid_at
   OR at.t<=greatest(m.terminal_at,coalesce((m.last_invoice_date::timestamp AT TIME ZONE 'Australia/Perth')+interval '1 day','-infinity'::timestamptz))+interval '60 days'))
 ORDER BY m.created_at,m.job_id,m.contact_label
$$;
COMMENT ON FUNCTION public.context_contact_parties_at(text,timestamptz) IS
 'Party jobs of a GHL contact (matched by ghl_contact_id only) as they stood at p_at, with the clause that makes each a candidate: a (live or inside a later job''s lead window), b_unpaid (finished, but the party owed on an invoice there), b_window (finished, within 60 days after the later of finishing and the party''s last invoice). For the placement track (P3); not called by the ladder in S-M1.';

-- 10. Each message row of a job and its party (review S6: one set-returning
-- call per job, not one call per row).
-- party_match: 'party' (one party of this job has the row's GHL contact),
-- 'ambiguous' (two or more do: same person twice or a shared contact; P7),
-- 'none'. mentions: other active parties the text names (full name, or first
-- name plus a word unique to that party: another name word or its house
-- number) or may name (first name alone): [{job_contact_id,label,certainty}].
-- mentions_unmatched: house numbers with a letter ("378a") whose number is the
-- site's or a party's but which match no party's address exactly (P4).
CREATE OR REPLACE FUNCTION public.context_job_event_parties(p_job_id uuid)
RETURNS TABLE(event_id uuid,contact_id text,job_contact_id uuid,party_label text,party_role text,party_match text,
 ambiguous_job_contact_ids uuid[],mentions jsonb,mentions_unmatched text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 e public.business_events; txt text; words text[]; senders uuid[]; mt jsonb; um text[]; pr record; fw text; hit boolean; u text;
 parties jsonb; designations text[]; bases text[]; tok text;
BEGIN
 -- Parties of the job with their name words, first name, unique tokens and house designation.
 WITH pc AS (
  SELECT c.id,c.contact_label,coalesce(c.party_role,CASE WHEN c.is_primary THEN 'owner' ELSE 'neighbour' END) AS role,c.status,
   nullif(btrim(c.ghl_contact_id),'') AS ghl,
   ARRAY(SELECT w FROM regexp_split_to_table(lower(coalesce(c.client_name,'')),'[^a-z0-9]+') WITH ORDINALITY s(w,o) WHERE length(w)>=2 ORDER BY o) AS nw,
   lower(substring(coalesce(c.site_address,'') from '^\s*(?:unit\s+)?([0-9]{1,5}[a-z]?(?:/[0-9]{1,5}[a-z]?)?)')) AS house
  FROM public.job_contacts c WHERE c.job_id=p_job_id
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',pc.id,'label',pc.contact_label,'role',pc.role,'status',pc.status,'ghl',pc.ghl,'nw',to_jsonb(pc.nw),
   'first',pc.nw[1],'house',pc.house,
   'unique',to_jsonb(ARRAY(SELECT w FROM unnest(pc.nw[2:]) w WHERE NOT EXISTS (SELECT 1 FROM pc o WHERE o.id<>pc.id AND w=ANY(o.nw)))
    ||CASE WHEN pc.house IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pc o WHERE o.id<>pc.id AND o.house=pc.house) THEN ARRAY[pc.house] ELSE '{}'::text[] END))
  ),'[]'::jsonb),
  coalesce(array_agg(DISTINCT pc.house) FILTER (WHERE pc.house IS NOT NULL),'{}')
 INTO parties,designations FROM pc;
 SELECT designations||coalesce(array_agg(lower(h)) FILTER (WHERE h IS NOT NULL),'{}') INTO designations
 FROM (SELECT substring(coalesce(j.site_address,'') from '^\s*(?:unit\s+)?([0-9]{1,5}[a-zA-Z]?(?:/[0-9]{1,5}[a-zA-Z]?)?)') AS h FROM public.jobs j WHERE j.id=p_job_id) s;
 SELECT coalesce(array_agg(DISTINCT b),'{}') INTO bases FROM unnest(designations) d, regexp_split_to_table(d,'/') p, LATERAL (SELECT substring(p from '^([0-9]+)') AS b) x WHERE b IS NOT NULL;

 FOR e IN SELECT b.* FROM public.business_events b WHERE b.job_id=p_job_id
  ORDER BY coalesce(b.event_at,b.occurred_at) DESC NULLS LAST,b.id LIMIT 2000 LOOP
  event_id:=e.id; contact_id:=e.contact_id;
  SELECT coalesce(array_agg((x->>'id')::uuid ORDER BY x->>'label'),'{}') INTO senders FROM jsonb_array_elements(parties) x
  WHERE e.contact_id IS NOT NULL AND x->>'ghl'=btrim(e.contact_id);
  IF cardinality(senders)=1 THEN
   job_contact_id:=senders[1]; party_match:='party'; ambiguous_job_contact_ids:=NULL;
   SELECT x->>'label',x->>'role' INTO party_label,party_role FROM jsonb_array_elements(parties) x WHERE (x->>'id')::uuid=senders[1];
  ELSIF cardinality(senders)>1 THEN
   job_contact_id:=NULL; party_label:=NULL; party_role:=NULL; party_match:='ambiguous'; ambiguous_job_contact_ids:=senders;
  ELSE
   job_contact_id:=NULL; party_label:=NULL; party_role:=NULL; party_match:='none'; ambiguous_job_contact_ids:=NULL;
  END IF;
  txt:=lower(coalesce(public.context_event_text(e),''));
  words:=ARRAY(SELECT w FROM regexp_split_to_table(txt,'[^a-z0-9/]+') w WHERE w<>'');
  mt:='[]'::jsonb; um:='{}';
  FOR pr IN SELECT x FROM jsonb_array_elements(parties) x WHERE x->>'status' IS DISTINCT FROM 'removed' AND NOT (x->>'id')::uuid=ANY(senders) LOOP
   fw:=pr.x->>'first';
   CONTINUE WHEN fw IS NULL;
   -- Full name: every name word, in order, as whole words.
   IF jsonb_array_length(pr.x->'nw')>=2 AND txt ~ ('(^|[^a-z0-9])'||(SELECT string_agg(w,'[^a-z0-9]+' ORDER BY o) FROM jsonb_array_elements_text(pr.x->'nw') WITH ORDINALITY s(w,o))||'($|[^a-z0-9])') THEN
    mt:=mt||jsonb_build_array(jsonb_build_object('job_contact_id',pr.x->>'id','label',pr.x->>'label','certainty','mentions'));
   ELSIF fw=ANY(words) THEN
    hit:=EXISTS (SELECT 1 FROM jsonb_array_elements_text(pr.x->'unique') t WHERE t=ANY(words));
    mt:=mt||jsonb_build_array(jsonb_build_object('job_contact_id',pr.x->>'id','label',pr.x->>'label','certainty',CASE WHEN hit THEN 'mentions' ELSE 'mentions_possible' END));
   END IF;
  END LOOP;
  FOREACH tok IN ARRAY words LOOP
   IF tok ~ '^[0-9]{1,5}[a-z]$' AND substring(tok from '^([0-9]+)')=ANY(bases) AND NOT tok=ANY(designations) AND NOT tok=ANY(um) THEN um:=um||tok; END IF;
  END LOOP;
  mentions:=mt; mentions_unmatched:=um;
  RETURN NEXT;
 END LOOP;
END $$;
COMMENT ON FUNCTION public.context_job_event_parties(uuid) IS
 'Each business_events row of a job (newest 2000) with its sending party by GHL contact (party, ambiguous or none), the other parties its text names (mentions) or may name (mentions_possible), and unmatched lettered house numbers. Derived at read time, never stored (sites D-S2). For the parties read (S-read).';

-- 11. Site proposals (sites.md section 2, review M11 item 8, X23).
-- The street part of a site address, parsed once through B0's exact key:
-- house number (the number after a unit slash), street (name and type).
CREATE OR REPLACE FUNCTION public.context_site_address(p_address text,OUT address_key text,OUT house integer,OUT street text)
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT k,
  CASE WHEN k IS NOT NULL THEN nullif(substring(split_part(split_part(k,' ',1),'/',CASE WHEN split_part(k,' ',1) LIKE '%/%' THEN 2 ELSE 1 END) from '^([0-9]{1,5})'),'')::int END,
  CASE WHEN k IS NOT NULL THEN nullif(substring(k from '^\S+\s+(.*)$'),'') END
 FROM (SELECT public.context_address_key(p_address) AS k) a
$$;

CREATE OR REPLACE FUNCTION public.context_site_candidates(p_job_id uuid)
RETURNS TABLE(job_id uuid,job_number text,basis text[],suggested_kind text,link_status text,evidence jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE me record; addr record; my_contacts text[]; tokens text[];
BEGIN
 SELECT j.id,j.job_number,j.site_address,lower(nullif(btrim(j.site_suburb),'')) AS suburb,j.created_at,
  nullif(btrim(j.ghl_contact_id),'') AS ghl,nullif(btrim(j.xero_contact_id),'') AS xero
 INTO me FROM public.jobs j WHERE j.id=p_job_id;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT * INTO addr FROM public.context_site_address(me.site_address);
 SELECT coalesce(array_agg(DISTINCT c),'{}') INTO my_contacts FROM (
  SELECT me.ghl UNION SELECT me.xero
  UNION SELECT nullif(btrim(c.ghl_contact_id),'') FROM public.job_contacts c WHERE c.job_id=p_job_id
  UNION SELECT nullif(btrim(c.xero_contact_id),'') FROM public.job_contacts c WHERE c.job_id=p_job_id) s(c) WHERE c IS NOT NULL;
 -- (b) job numbers named in this job's invoice references and lines.
 SELECT coalesce(array_agg(DISTINCT t),'{}') INTO tokens FROM public.xero_invoices x,
  unnest(public.context_job_ref_tokens(coalesce(x.reference,'')||' '||coalesce(x.line_items::text,''))) t
 WHERE x.job_id=p_job_id AND upper(coalesce(x.status,'')) NOT IN ('VOIDED','DELETED');
 RETURN QUERY
 WITH street_word AS (
  -- Cheap prefilter before the per-row parse: the longest street word.
  SELECT (SELECT w FROM regexp_split_to_table(coalesce(addr.street,''),' ') w ORDER BY length(w) DESC LIMIT 1) AS w
 ), near AS (
  SELECT j.id,j.job_number,j.created_at,lower(nullif(btrim(j.site_suburb),'')) AS suburb,sa.address_key,sa.house,sa.street,
   nullif(btrim(j.ghl_contact_id),'') AS ghl,nullif(btrim(j.xero_contact_id),'') AS xero
  FROM public.jobs j, street_word sw, LATERAL public.context_site_address(j.site_address) sa
  WHERE addr.address_key IS NOT NULL AND length(coalesce(sw.w,''))>=2 AND j.id<>p_job_id
   AND j.site_address ILIKE '%'||sw.w||'%' AND coalesce(j.metadata->>'do_not_schedule','') NOT IN ('true','1')
 ), same_addr AS (
  SELECT n.id,'same_address'::text AS b FROM near n
  WHERE n.address_key=addr.address_key AND NOT (n.suburb IS NOT NULL AND me.suburb IS NOT NULL AND n.suburb<>me.suburb)
 ), named AS (
  SELECT r.job_id AS id,'invoice_names_job'::text AS b FROM public.context_ref_jobs(tokens) r
  WHERE cardinality(tokens)>0 AND r.ref_kind='job_number' AND r.job_id<>p_job_id
 ), shared AS (
  SELECT n.id,'shared_contact_nearby'::text AS b FROM near n
  WHERE addr.house IS NOT NULL AND n.house IS NOT NULL AND n.address_key<>addr.address_key AND n.street=addr.street
   AND n.suburb IS NOT NULL AND n.suburb=me.suburb
   AND abs(n.house-addr.house)<=4
   AND (n.ghl=ANY(my_contacts) OR n.xero=ANY(my_contacts)
    OR EXISTS (SELECT 1 FROM public.job_contacts c WHERE c.job_id=n.id
     AND (nullif(btrim(c.ghl_contact_id),'')=ANY(my_contacts) OR nullif(btrim(c.xero_contact_id),'')=ANY(my_contacts))))
 ), allb AS (
  SELECT s.id,array_agg(DISTINCT s.b ORDER BY s.b) AS basis FROM (SELECT * FROM same_addr UNION ALL SELECT * FROM named UNION ALL SELECT * FROM shared) s GROUP BY s.id
 )
 SELECT a.id,j.job_number,a.basis,
  -- A suggestion for the person deciding, never a decision.
  CASE WHEN 'invoice_names_job'=ANY(a.basis) THEN 'split_party'
   WHEN nullif(btrim(j.ghl_contact_id),'') IS NOT NULL AND nullif(btrim(j.ghl_contact_id),'')=me.ghl
    AND abs(extract(epoch FROM coalesce(j.created_at,me.created_at)-coalesce(me.created_at,j.created_at)))>365*86400 THEN 'repeat'
   WHEN nullif(btrim(j.ghl_contact_id),'') IS NOT NULL AND nullif(btrim(j.ghl_contact_id),'')=me.ghl THEN 'stage'
   WHEN lower(nullif(btrim(j.client_name),''))=(SELECT lower(nullif(btrim(m.client_name),'')) FROM public.jobs m WHERE m.id=p_job_id) THEN 'stage'
   ELSE 'split_party' END,
  (SELECT l.status FROM public.job_site_links l WHERE (l.job_id=a.id AND l.site_lead_job_id=p_job_id) OR (l.job_id=p_job_id AND l.site_lead_job_id=a.id)
   ORDER BY l.updated_at DESC LIMIT 1),
  jsonb_build_object('address_key',addr.address_key,'other_address_key',(SELECT n.address_key FROM near n WHERE n.id=a.id))
 FROM allb a JOIN public.jobs j ON j.id=a.id
 ORDER BY j.created_at,j.job_number;
END $$;
COMMENT ON FUNCTION public.context_site_candidates(uuid) IS
 'Proposals for "same site" links: another job with the same exact address key (B0 context_address_key; suburb must not differ when both are known), a job number named in this job''s invoice references or lines, or a shared GHL or Xero contact on the same street and suburb within 4 house numbers. basis lists why; suggested_kind is a suggestion only; link_status is any existing job_site_links decision. Nothing is linked without a person (link_site_jobs).';

-- 12. The one writer of job_site_links.
-- p_decision: propose, confirm or reject. A job belongs to at most one site
-- lead; a lead is never itself linked to another lead; a confirmed link is
-- changed only by an explicit confirm or reject.
CREATE OR REPLACE FUNCTION public.link_site_jobs(p_job_id uuid,p_site_lead_job_id uuid,p_link_kind text,p_decision text,p_actor text,p_evidence jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cur public.job_site_links; nw public.job_site_links; actor text:=nullif(btrim(p_actor),''); outcome text;
BEGIN
 IF p_job_id IS NULL OR p_site_lead_job_id IS NULL THEN RAISE EXCEPTION 'site_link_jobs_required'; END IF;
 IF p_job_id=p_site_lead_job_id THEN RAISE EXCEPTION 'site_link_self'; END IF;
 IF p_link_kind IS NULL OR p_link_kind NOT IN ('split_party','option','stage','repeat') THEN RAISE EXCEPTION 'site_link_kind_invalid'; END IF;
 IF p_decision IS NULL OR p_decision NOT IN ('propose','confirm','reject') THEN RAISE EXCEPTION 'site_link_decision_invalid'; END IF;
 IF actor IS NULL OR length(actor)>200 THEN RAISE EXCEPTION 'site_link_actor_required'; END IF;
 IF p_evidence IS NOT NULL AND (jsonb_typeof(p_evidence)<>'object' OR octet_length(p_evidence::text)>4096) THEN RAISE EXCEPTION 'site_link_evidence_invalid'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id=p_job_id) OR NOT EXISTS (SELECT 1 FROM public.jobs WHERE id=p_site_lead_job_id) THEN RAISE EXCEPTION 'site_link_job_not_found'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('job_site_links',0));
 IF EXISTS (SELECT 1 FROM public.job_site_links l WHERE l.job_id=p_site_lead_job_id AND l.status<>'rejected') THEN RAISE EXCEPTION 'site_lead_is_linked'; END IF;
 IF p_decision<>'reject' AND EXISTS (SELECT 1 FROM public.job_site_links l WHERE l.site_lead_job_id=p_job_id AND l.status<>'rejected') THEN RAISE EXCEPTION 'job_is_site_lead'; END IF;
 SELECT * INTO cur FROM public.job_site_links WHERE job_id=p_job_id FOR UPDATE;
 IF FOUND AND cur.status='confirmed' AND p_decision='propose' THEN RAISE EXCEPTION 'site_link_already_confirmed'; END IF;
 IF FOUND AND cur.status<>'rejected' AND cur.site_lead_job_id<>p_site_lead_job_id AND p_decision<>'reject' THEN RAISE EXCEPTION 'site_link_other_lead'; END IF;
 IF p_decision='reject' AND FOUND AND cur.site_lead_job_id<>p_site_lead_job_id THEN RAISE EXCEPTION 'site_link_other_lead'; END IF;
 INSERT INTO public.job_site_links AS l(job_id,site_lead_job_id,link_kind,status,evidence,proposed_by,decided_by,decided_at)
 VALUES(p_job_id,p_site_lead_job_id,p_link_kind,CASE p_decision WHEN 'propose' THEN 'proposed' WHEN 'confirm' THEN 'confirmed' ELSE 'rejected' END,
  coalesce(p_evidence,'{}'::jsonb),CASE WHEN p_decision='propose' THEN actor END,
  CASE WHEN p_decision<>'propose' THEN actor END,CASE WHEN p_decision<>'propose' THEN clock_timestamp() END)
 ON CONFLICT (job_id) DO UPDATE SET site_lead_job_id=EXCLUDED.site_lead_job_id,link_kind=EXCLUDED.link_kind,status=EXCLUDED.status,
  evidence=CASE WHEN EXCLUDED.evidence='{}'::jsonb THEN l.evidence ELSE EXCLUDED.evidence END,
  proposed_by=coalesce(EXCLUDED.proposed_by,l.proposed_by),decided_by=EXCLUDED.decided_by,decided_at=EXCLUDED.decided_at,updated_at=clock_timestamp()
 RETURNING * INTO nw;
 outcome:='site_link_'||CASE p_decision WHEN 'propose' THEN 'proposed' WHEN 'confirm' THEN 'confirmed' ELSE 'rejected' END;
 PERFORM public.job_party_receipt(p_job_id,NULL,outcome,actor,'link_site_jobs',NULL,NULL,
  CASE WHEN cur.job_id IS NOT NULL THEN jsonb_build_object('site_lead_job_id',cur.site_lead_job_id,'link_kind',cur.link_kind,'status',cur.status) END,
  jsonb_build_object('site_lead_job_id',nw.site_lead_job_id,'link_kind',nw.link_kind,'status',nw.status),'{}'::jsonb);
 RETURN jsonb_build_object('outcome',outcome,'job_id',nw.job_id,'site_lead_job_id',nw.site_lead_job_id,'link_kind',nw.link_kind,'status',nw.status,
  'decided_by',nw.decided_by,'decided_at',nw.decided_at);
END $$;
COMMENT ON FUNCTION public.link_site_jobs(uuid,uuid,text,text,text,jsonb) IS
 'The one writer of job_site_links (ops-api action link_site_jobs): propose, confirm or reject a same-site link from a job to its site lead, with a job_party_events receipt. Refusals: site_link_jobs_required, site_link_self, site_link_kind_invalid, site_link_decision_invalid, site_link_actor_required, site_link_evidence_invalid, site_link_job_not_found, site_lead_is_linked, job_is_site_lead, site_link_already_confirmed, site_link_other_lead.';

-- 13. The parties status block (sites.md section 8), replacing the F1 stub.
CREATE OR REPLACE FUNCTION public.context_parties_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 now_time timestamptz:=now(); parties jsonb; invoices jsonb; links jsonb; receipts jsonb; linker jsonb; alarms jsonb:='[]'::jsonb;
 last_ok timestamptz; ever boolean; lane boolean;
BEGIN
 SELECT jsonb_build_object(
   'active',count(*) FILTER (WHERE c.status IS DISTINCT FROM 'removed'),
   'removed',count(*) FILTER (WHERE c.status='removed'),
   'keyed',count(*) FILTER (WHERE c.source_party_key IS NOT NULL),
   'no_ghl_contact',count(*) FILTER (WHERE c.status IS DISTINCT FROM 'removed' AND nullif(btrim(c.ghl_contact_id),'') IS NULL),
   'placeholder_phone',count(*) FILTER (WHERE c.status IS DISTINCT FROM 'removed' AND nullif(btrim(c.client_phone),'') IS NOT NULL AND c.phone_last9 IS NULL),
   'ghl_contact_ambiguous',count(*) FILTER (WHERE 'ghl_contact_ambiguous'=ANY(c.party_flags)),
   'identity_conflict',count(*) FILTER (WHERE 'identity_conflict'=ANY(c.party_flags)),
   'owner_id_divergence',count(*) FILTER (WHERE 'owner_id_divergence'=ANY(c.party_flags)),
   'shared_ghl_contact_parties',(SELECT count(*) FROM public.job_contacts s WHERE s.status IS DISTINCT FROM 'removed' AND nullif(btrim(s.ghl_contact_id),'') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.job_contacts o WHERE o.id<>s.id AND o.status IS DISTINCT FROM 'removed' AND btrim(o.ghl_contact_id)=btrim(s.ghl_contact_id))),
   'multi_party_jobs',(SELECT count(*) FROM (SELECT 1 FROM public.job_contacts m WHERE m.status IS DISTINCT FROM 'removed' GROUP BY m.job_id HAVING count(*)>=2) q),
   'duplicate_letter_groups',(SELECT count(*) FROM (SELECT 1 FROM public.job_contacts d GROUP BY d.job_id,d.contact_label HAVING count(*)>1) q))
 INTO parties FROM public.job_contacts c;
 -- Jobs whose pricing lists neighbours but that have no active non-owner party
 -- (review S3: a scope sync that never ran). Live fencing jobs only.
 parties:=parties||jsonb_build_object('pricing_neighbours_without_party_rows',(
  SELECT count(*) FROM public.jobs j
  WHERE j.type::text='fencing' AND NOT (j.status::text IN ('cancelled','archived','lost','closed','complete','completed') OR coalesce(j.archived,false))
   AND jsonb_typeof(j.pricing_json->'neighbour_splits')='array' AND jsonb_array_length(j.pricing_json->'neighbour_splits')>0
   AND NOT EXISTS (SELECT 1 FROM public.job_contacts c WHERE c.job_id=j.id AND c.is_primary IS NOT TRUE AND c.status IS DISTINCT FROM 'removed')));
 SELECT jsonb_build_object('multi_party_invoices_without_party',count(*)) INTO invoices
 FROM public.xero_invoices x
 WHERE x.invoice_type='ACCREC' AND upper(coalesce(x.status,'')) NOT IN ('VOIDED','DELETED') AND x.job_contact_id IS NULL AND x.job_id IN (
  SELECT m.job_id FROM public.job_contacts m WHERE m.status IS DISTINCT FROM 'removed' GROUP BY m.job_id HAVING count(*)>=2);
 SELECT jsonb_build_object('proposed',count(*) FILTER (WHERE l.status='proposed'),'confirmed',count(*) FILTER (WHERE l.status='confirmed'),
   'rejected',count(*) FILTER (WHERE l.status='rejected'),'oldest_proposed_at',min(l.created_at) FILTER (WHERE l.status='proposed'))
 INTO links FROM public.job_site_links l;
 SELECT coalesce(jsonb_object_agg(r.change,r.n),'{}'::jsonb) INTO receipts
 FROM (SELECT e.change,count(*) n FROM public.job_party_events e WHERE e.created_at>now_time-interval '7 days' GROUP BY e.change) r;
 -- The party linker sweep (S-M2) records runs as source party_linker.
 SELECT max(r.finished_at) FILTER (WHERE r.status='succeeded'),count(*)>0 INTO last_ok,ever FROM public.context_capture_runs r WHERE r.source='party_linker';
 lane:=public.automation_lane_enabled('capture');
 linker:=jsonb_build_object('built',ever,'last_succeeded_at',last_ok,
  'business_minutes_since',CASE WHEN last_ok IS NOT NULL THEN public.context_business_minutes(last_ok,now_time) END,'capture_lane',lane);
 IF ever AND lane AND public.context_in_business_hours(now_time)
  AND (last_ok IS NULL OR public.context_business_minutes(last_ok,now_time)>=45) THEN
  alarms:=alarms||jsonb_build_array(jsonb_build_object('key','party_linker_stale','severity','warning','since',last_ok,
   'what_to_do','The party linker has not finished a sweep for 45 business minutes. Check its pg_cron job and the ops-api link_unlinked_parties action; new neighbours are not being linked to their GHL contacts.'));
 END IF;
 RETURN jsonb_build_object('as_of',now_time,'flag',jsonb_build_object('name','job_parties_v1','enabled',public.job_party_flag_on()),
  'parties',parties,'invoices',invoices,'site_links',links,'receipts_7d',receipts,'linker',linker,
  'not_measured_here',jsonb_build_array('neighbour_in_text_only','invoices_linked_elsewhere','invoices_spanning_jobs'),
  'alarms',alarms);
END $$;
COMMENT ON FUNCTION public.context_parties_status() IS
 'Status block parties (sites.md section 8), owned by sites S-M1: party counts and flags, shared GHL contacts, duplicate letters, live fencing jobs whose pricing lists neighbours but that have no party rows, multi-party invoices with no party, site-link decisions, 7-day receipt counts, the party linker''s last run and the party_linker_stale alarm. Counts only, no names.';

-- 14. Grants: nothing reachable by the public key or a signed-in login.
-- Private helpers are not granted to anyone; the writers, the reads and the
-- status block are service_role only.
REVOKE ALL ON FUNCTION public.job_party_flag_on(),public.job_party_phone_key(text),public.job_party_email_key(text),
 public.job_party_receipt(uuid,uuid,text,text,text,text,uuid,jsonb,jsonb,jsonb),public.job_party_reconsider(public.job_contacts,text),
 public.upsert_job_party(uuid,text,jsonb,text,uuid),public.set_job_party_ids(uuid,text,text,text,text,text),public.job_contacts_owner_mirror(),
 public.context_contact_parties_at(text,timestamptz),public.context_job_event_parties(uuid),public.context_site_address(text),
 public.context_site_candidates(uuid),public.link_site_jobs(uuid,uuid,text,text,text,jsonb),public.context_parties_status()
 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.job_party_flag_on(),public.job_party_receipt(uuid,uuid,text,text,text,text,uuid,jsonb,jsonb,jsonb),
 public.job_party_reconsider(public.job_contacts,text),public.job_contacts_owner_mirror() FROM service_role;
GRANT EXECUTE ON FUNCTION public.job_party_phone_key(text),public.job_party_email_key(text),
 public.upsert_job_party(uuid,text,jsonb,text,uuid),public.set_job_party_ids(uuid,text,text,text,text,text),
 public.context_contact_parties_at(text,timestamptz),public.context_job_event_parties(uuid),public.context_site_address(text),
 public.context_site_candidates(uuid),public.link_site_jobs(uuid,uuid,text,text,text,jsonb),public.context_parties_status()
TO service_role;
