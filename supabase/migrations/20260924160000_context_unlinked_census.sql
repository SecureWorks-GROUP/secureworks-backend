-- B0: measure the unlinked pile before fixing it (adminbucket.md, INTEGRATION
-- Wave 1b row B0, settlement X23).
--
-- About 4,300 evidence rows sit in the admin bucket and nothing reads them.
-- This migration adds, read-only:
--   1. The placement track's shared pure helpers, so texts, email and calls use
--      one rule set later (P4) and the money track uses the same token rule:
--        context_phone_key(text)        last 9 digits; null for fewer than 8
--                                       digits, one repeated digit, or one of
--                                       our five lines.
--        context_email_key(text)        lower-case trimmed address (a
--                                       "Name <a@b>" form reads a@b); null when
--                                       not an address or one of our domains.
--        context_street_type(text)      the one street-type table.
--        context_address_mentions(text) every street address in a text: exact
--                                       key (number with unit and letter suffix
--                                       kept, street name, canonical type;
--                                       suburb and state never in the key) and
--                                       loose keys (suffix dropped, type
--                                       dropped, each number of a slash form).
--                                       A mention with no type word has no
--                                       exact key: it can only ever match
--                                       loosely.
--        context_address_key(text),
--        context_address_loose_keys(text)  the first address of one string
--                                       (a job's site_address).
--        context_job_ref_tokens(text)   L1's exact whole tokens (upper-cased,
--                                       at least 5 characters, with a digit)
--                                       plus the space-joined extras
--                                       ("SWP 26195" -> SWP-26195 and
--                                       SWP26195). Lower case needs no extra:
--                                       tokens are upper-cased, as in L1.
--        context_ref_jobs(text[])       tokens to our jobs by L1's rule (job
--                                       numbers, ACCREC INV- numbers, PO
--                                       numbers, at least 5 characters, never
--                                       a holding job).
--        context_event_sender_kind(row) supplier, council, platform, ours or
--                                       other.
--        context_event_identity(row)    the customer's email and phone key,
--                                       from a closed list of payload fields;
--                                       none for outbound, supplier, council,
--                                       platform or our own rows.
--        context_contact_for_key(email_key, phone_key)  exactly one GHL
--                                       contact from jobs, contact_matches and
--                                       job_contacts rows that carry one;
--                                       several gives null and the count.
--      The TypeScript twin is supabase/functions/_shared/job_refs.ts; one
--      fixture table (_shared/job_refs_fixtures.ts) runs against both.
--   2. context_bucket_text(row), context_bucket_reason_detail(row) and
--      context_bucket_reason(row): why a row is unlinked, one closed reason.
--   3. context_unlinked_census(budget_ms, phase, cursor): counts by reason and
--      age band for bucket rows and for rows the ladder put on a holding job,
--      by source and event type, new and re-stamped in 24 hours, re-stamped
--      legacy rows by prior method, NULL-status rows with and without a job,
--      monitor-inbox custody rows that name two or more jobs, up to 5 ids per
--      reason. Resumable: each call reads for at most 7 seconds (the API role
--      stops statements at 8) and returns `next`; the ops-api door adds the
--      parts up.
--   4. context_unlinked_rows(...): one page of unlinked rows (keyset cursor),
--      each with its reason and what the job read would show.
--   5. Expression indexes on jobs: upper(job_number), the phone's last 9
--      digits and the lower-case email (built-in expressions only).
--
-- No placement change: resolve_context_attribution, the trigger, the re-run and
-- the Luna guard are untouched, and no row is written. Every function is
-- service_role only. No flag or switch changes.
--
-- The jobs indexes use built-in expressions only (see section 7): an index on
-- a function revoked from anon and authenticated breaks their jobs writes.
--
-- Pre-image, read from production 23 Sep 2026 (read-only): none of the B0
-- function names exists; every column in the guard has the type listed there
-- (job_contacts carries client_email, client_phone and ghl_contact_id, not
-- email and phone); version 20260924160000 is unused (the ledger's newest is
-- 20260924140000). The guard refuses a B0 name that exists without this
-- migration's "B0:" comment, and any column that has moved.
-- Sizes then: 4,336 bucket rows (952 with a contact), 1,163 ladder step-1 rows
-- on the holding job SWF-PDF-BUCKET, 610 monitor-inbox custody rows, 13,475
-- NULL-status rows (9,538 with no job). The API roles stop statements at 8 s.
-- Rollback: supabase/rollbacks/20260924160000_context_unlinked_census_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every problem at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS h
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('context_phone_key','context_email_key','context_street_type',
   'context_address_mentions','context_address_key','context_address_loose_keys','context_job_ref_tokens',
   'context_ref_jobs','context_event_sender_kind','context_event_identity','context_contact_for_key',
   'context_bucket_text','context_live_site_index','context_bucket_reason_detail','context_bucket_reason','context_census_reasons','context_unlinked_census',
   'context_unlinked_rows') LOOP
  -- A re-apply finds this migration's own objects, each marked in its comment.
  IF coalesce(obj_description(x.oid,'pg_proc'),'') NOT LIKE 'B0:%' THEN
   problems:=problems||format('%s(%s) already exists (md5 %s) and is not B0''s',x.proname,x.args,x.h);
  END IF;
 END LOOP;
 -- Columns read here (types as read from production).
 FOR x IN SELECT * FROM (VALUES
  ('jobs','job_number','text'),('jobs','status','text'),('jobs','archived','boolean'),('jobs','metadata','jsonb'),
  ('jobs','client_phone','text'),('jobs','client_email','text'),('jobs','ghl_contact_id','text'),('jobs','site_address','text'),
  ('contact_matches','ghl_contact_id','text'),('contact_matches','phone','text'),('contact_matches','email','text'),
  ('job_contacts','ghl_contact_id','text'),('job_contacts','client_phone','text'),('job_contacts','client_email','text'),
  ('xero_invoices','invoice_number','text'),('xero_invoices','invoice_type','text'),('xero_invoices','job_id','uuid'),
  ('purchase_orders','po_number','text'),('purchase_orders','job_id','uuid'),
  ('business_events','event_type','text'),('business_events','source','text'),('business_events','channel','text'),
  ('business_events','direction','text'),('business_events','payload','jsonb'),('business_events','metadata','jsonb'),
  ('business_events','contact_id','text'),('business_events','job_id','uuid'),('business_events','attribution_status','text'),
  ('business_events','attribution_checked_at','timestamp with time zone'),('business_events','context_captured_at','timestamp with time zone'),
  ('business_events','recorded_at','timestamp with time zone'),('business_events','candidate_job_ids','uuid[]'),
  ('business_events','match_method','text'),('business_events','event_at','timestamp with time zone'),
  ('business_events','occurred_at','timestamp with time zone'),('business_events','provider_message_id','text'),
  ('business_events','source_table','text'),('business_events','source_id','text'),('business_events','body_preview','text')
 ) AS c(tbl,col,typ) LOOP
  live:=NULL;
  SELECT format_type(a.atttypid,a.atttypmod) INTO live FROM pg_attribute a
  WHERE a.attrelid=to_regclass('public.'||x.tbl) AND a.attname=x.col AND a.attnum>0 AND NOT a.attisdropped;
  IF live IS DISTINCT FROM x.typ THEN problems:=problems||format('%s.%s is %s, expected %s',x.tbl,x.col,coalesce(live,'<missing>'),x.typ); END IF;
 END LOOP;
 -- Functions this migration reads and does not own.
 FOR x IN SELECT * FROM (VALUES ('public.context_event_text(public.business_events)'),
  ('public.context_event_is_ours(public.business_events)'),('public.context_contact_job_timeline(text,timestamp with time zone)')) AS f(sig) LOOP
  IF to_regprocedure(x.sig) IS NULL THEN problems:=problems||format('%s is missing',x.sig); END IF;
 END LOOP;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_unlinked_census_preimage_mismatch: %; read the live definitions first',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. Pure keys. IMMUTABLE and never raising, because jobs indexes are built on them.
CREATE OR REPLACE FUNCTION public.context_phone_key(p_phone text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN length(d)>=8 AND d !~ '^(\d)\1*$'
   AND right(d,9) NOT IN ('489267771','489267772','489267774','489267776','489267778')
  THEN right(d,9) END
 FROM (SELECT regexp_replace(coalesce(p_phone,''),'[^0-9]','','g') AS d) k
$$;
COMMENT ON FUNCTION public.context_phone_key(text) IS
 'B0: phone identity key, the last 9 digits. Null for fewer than 8 digits, one repeated digit, or our five lines. TS twin phoneKey in _shared/job_refs.ts.';

CREATE OR REPLACE FUNCTION public.context_email_key(p_email text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN a ~ '^[a-z0-9._%+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$'
   AND a !~ '@([a-z0-9-]+\.)*(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$'
  THEN a END
 FROM (SELECT lower(btrim(coalesce(substring(p_email from '<([^<>]*)>'),p_email,''))) AS a) k
$$;
COMMENT ON FUNCTION public.context_email_key(text) IS
 'B0: email identity key, lower-case trimmed; "Name <a@b>" reads a@b. Null when not an address or in one of our domains. TS twin emailKey.';

CREATE OR REPLACE FUNCTION public.context_street_type(p_word text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
 SELECT CASE lower(p_word)
  WHEN 'road' THEN 'rd' WHEN 'rd' THEN 'rd'
  WHEN 'street' THEN 'st' WHEN 'st' THEN 'st'
  WHEN 'avenue' THEN 'ave' WHEN 'ave' THEN 'ave' WHEN 'av' THEN 'ave'
  WHEN 'court' THEN 'ct' WHEN 'ct' THEN 'ct' WHEN 'crt' THEN 'ct'
  WHEN 'close' THEN 'cl' WHEN 'cl' THEN 'cl'
  WHEN 'way' THEN 'way' WHEN 'wy' THEN 'way'
  WHEN 'place' THEN 'pl' WHEN 'pl' THEN 'pl'
  WHEN 'crescent' THEN 'cres' WHEN 'cres' THEN 'cres' WHEN 'cr' THEN 'cres'
  WHEN 'drive' THEN 'dr' WHEN 'dr' THEN 'dr'
  WHEN 'turn' THEN 'tn' WHEN 'tn' THEN 'tn'
  WHEN 'terrace' THEN 'tce' WHEN 'tce' THEN 'tce'
  WHEN 'grove' THEN 'grv' WHEN 'grv' THEN 'grv'
  WHEN 'parade' THEN 'pde' WHEN 'pde' THEN 'pde'
  WHEN 'boulevard' THEN 'blvd' WHEN 'blvd' THEN 'blvd'
  WHEN 'loop' THEN 'lp' WHEN 'lp' THEN 'lp'
  WHEN 'highway' THEN 'hwy' WHEN 'hwy' THEN 'hwy'
  WHEN 'lane' THEN 'ln' WHEN 'ln' THEN 'ln'
  WHEN 'circuit' THEN 'cct' WHEN 'cct' THEN 'cct'
  WHEN 'gardens' THEN 'gdns' WHEN 'gdns' THEN 'gdns'
  WHEN 'esplanade' THEN 'esp' WHEN 'esp' THEN 'esp'
  WHEN 'square' THEN 'sq' WHEN 'sq' THEN 'sq'
  WHEN 'retreat' THEN 'rtt' WHEN 'rtt' THEN 'rtt'
  WHEN 'promenade' THEN 'prom' WHEN 'prom' THEN 'prom'
  WHEN 'parkway' THEN 'pkwy' WHEN 'pkwy' THEN 'pkwy'
  WHEN 'rise' THEN 'rise' WHEN 'mews' THEN 'mews'
 END
$$;
COMMENT ON FUNCTION public.context_street_type(text) IS
 'B0: the one street-type table (sites.md plus adminbucket.md types and common WA types); canonical short form, null when not a street type. TS twin streetType.';

-- Every address in a text, in order. Tokens: lower case, apostrophes removed,
-- "4 / 6" read as "4/6", commas kept as boundaries, everything else a space.
-- A number (1 to 5 digits, optional letter, optional "/number") followed by
-- 1 to 4 plain words; the first street-type word after at least one name word
-- ends a typed address. Untyped: the name is the first word (two when the
-- first is st, saint, mt, mount, port or lake). Street name at least 4 letters.
CREATE OR REPLACE FUNCTION public.context_address_mentions(p_text text)
RETURNS TABLE(address_key text, loose_keys text[], typed boolean, slash_form boolean)
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
DECLARE s text; toks text[]; n int; i int; j int; w text; m text[]; names text[]; typ text; nm text; num text; looses text[];
BEGIN
 s:=lower(coalesce(p_text,''));
 s:=regexp_replace(s,'[''`’]','','g');
 s:=regexp_replace(s,'\s*/\s*','/','g');
 s:=regexp_replace(s,',',' , ','g');
 s:=regexp_replace(s,'[^a-z0-9/,]+',' ','g');
 s:=btrim(s);
 IF s='' THEN RETURN; END IF;
 toks:=regexp_split_to_array(s,' +');
 n:=cardinality(toks);
 i:=1;
 WHILE i<=n LOOP
  m:=regexp_match(toks[i],'^([0-9]{1,5})([a-z]?)(?:/([0-9]{1,5})([a-z]?))?$');
  IF m IS NULL OR ltrim(m[1],'0')='' THEN i:=i+1; CONTINUE; END IF;
  names:='{}'; typ:=NULL; j:=i+1;
  WHILE j<=n AND cardinality(names)<4 LOOP
   w:=toks[j];
   EXIT WHEN w !~ '^[a-z]+$';
   IF cardinality(names)>=1 AND public.context_street_type(w) IS NOT NULL THEN
    typ:=public.context_street_type(w); j:=j+1; EXIT;
   END IF;
   names:=names||w; j:=j+1;
  END LOOP;
  IF cardinality(names)=0 THEN i:=i+1; CONTINUE; END IF;
  IF typ IS NOT NULL THEN nm:=array_to_string(names,' ');
  ELSIF names[1] IN ('st','saint','mt','mount','port','lake') AND cardinality(names)>=2 THEN nm:=names[1]||' '||names[2];
  ELSE nm:=names[1];
  END IF;
  IF length(replace(nm,' ',''))<4 THEN i:=i+1; CONTINUE; END IF;
  num:=ltrim(m[1],'0')||m[2];
  looses:=ARRAY[ltrim(m[1],'0')||' '||nm];
  IF m[3] IS NOT NULL THEN
   num:=num||'/'||ltrim(m[3],'0')||m[4];
   IF ltrim(m[3],'0')<>'' AND ltrim(m[3],'0')<>ltrim(m[1],'0') THEN looses:=looses||(ltrim(m[3],'0')||' '||nm); END IF;
  END IF;
  address_key:=CASE WHEN typ IS NOT NULL THEN num||' '||nm||' '||typ END;
  loose_keys:=looses; typed:=typ IS NOT NULL; slash_form:=m[3] IS NOT NULL;
  RETURN NEXT;
  i:=CASE WHEN typ IS NOT NULL THEN j ELSE i+1 END;
 END LOOP;
END $$;
COMMENT ON FUNCTION public.context_address_mentions(text) IS
 'B0: every street address in a text: exact key (unit and letter suffix kept, canonical type, no suburb; null when no type word), loose keys (suffix and type dropped, each number of a slash form), typed and slash flags. TS twin addressMentions.';

CREATE OR REPLACE FUNCTION public.context_address_key(p_address text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
 SELECT m.address_key FROM public.context_address_mentions(p_address) WITH ORDINALITY m(address_key,loose_keys,typed,slash_form,ord)
 WHERE m.typed ORDER BY m.ord LIMIT 1
$$;
COMMENT ON FUNCTION public.context_address_key(text) IS
 'B0: exact key of the first typed address in one string (a job site_address); null when none. TS twin addressKey.';

CREATE OR REPLACE FUNCTION public.context_address_loose_keys(p_address text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
 SELECT m.loose_keys FROM public.context_address_mentions(p_address) WITH ORDINALITY m(address_key,loose_keys,typed,slash_form,ord)
 ORDER BY m.typed DESC, m.ord LIMIT 1
$$;
COMMENT ON FUNCTION public.context_address_loose_keys(text) IS
 'B0: loose keys of the first typed address in one string, else of the first address; null when none. TS twin addressLooseKeys.';

-- 2. The one token rule (L1's exact whole tokens plus the space-joined extras).
CREATE OR REPLACE FUNCTION public.context_job_ref_tokens(p_text text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
 WITH s AS (SELECT btrim(upper(regexp_replace(coalesce(p_text,''),'[^a-zA-Z0-9-]+',' ','g'))) AS t),
 toks AS (
  SELECT w FROM s, regexp_split_to_table(s.t,' ') w
  UNION
  SELECT x.m[1]||'-'||x.m[2] FROM s, regexp_matches(s.t,'(?:^| )([A-Z]{2,4}) ([0-9]{4,})(?= |$)','g') AS x(m)
  UNION
  SELECT x.m[1]||x.m[2] FROM s, regexp_matches(s.t,'(?:^| )([A-Z]{2,4}) ([0-9]{4,})(?= |$)','g') AS x(m)
 )
 SELECT coalesce(array_agg(w ORDER BY w COLLATE "C"),'{}') FROM toks WHERE length(w)>=5 AND w ~ '[0-9]'
$$;
COMMENT ON FUNCTION public.context_job_ref_tokens(text) IS
 'B0: reference tokens of a text, sorted and distinct: L1''s whole tokens (upper case, at least 5 characters, containing a digit) plus "AB 1234" joined as AB-1234 and AB1234. TS twin jobRefTokens; one fixture table (_shared/job_refs_fixtures.ts).';

CREATE OR REPLACE FUNCTION public.context_ref_jobs(p_tokens text[])
RETURNS TABLE(token text, job_id uuid, ref_kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT r.token, r.job_id, r.ref_kind FROM (
  SELECT upper(j.job_number) AS token, j.id AS job_id, 'job_number'::text AS ref_kind FROM public.jobs j
  WHERE upper(j.job_number)=ANY(p_tokens) AND length(btrim(j.job_number))>=5
  UNION
  SELECT upper(x.invoice_number), x.job_id, 'accrec_invoice' FROM public.xero_invoices x
  WHERE EXISTS (SELECT 1 FROM unnest(p_tokens) t WHERE t LIKE 'INV-%')
   AND x.job_id IS NOT NULL AND x.invoice_type='ACCREC' AND upper(x.invoice_number) LIKE 'INV-%'
   AND length(btrim(x.invoice_number))>=5 AND upper(x.invoice_number)=ANY(p_tokens)
  UNION
  SELECT upper(po.po_number), po.job_id, 'purchase_order' FROM public.purchase_orders po
  WHERE po.job_id IS NOT NULL AND length(btrim(po.po_number))>=5 AND upper(po.po_number)=ANY(p_tokens)
 ) r JOIN public.jobs rj ON rj.id=r.job_id
 WHERE coalesce(rj.metadata->>'do_not_schedule','') NOT IN ('true','1')
$$;
COMMENT ON FUNCTION public.context_ref_jobs(text[]) IS
 'B0: reference tokens to our jobs by L1''s rule: job numbers, ACCREC INV- numbers and PO numbers of at least 5 characters, never a holding job.';

-- 3. Who sent a row, and the customer's identity keys.
CREATE OR REPLACE FUNCTION public.context_event_sender_kind(e public.business_events) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE
  WHEN e.event_type LIKE 'supplier.%' THEN 'supplier'
  WHEN d ~ '(^|\.)gov\.au$' THEN 'council'
  WHEN d ~ '(^|\.)(myob\.com|xero\.com|docusign\.net|docusign\.com|stripe\.com|paypal\.com|intuit\.com)$' THEN 'platform'
  WHEN public.context_event_is_ours(e) THEN 'ours'
  ELSE 'other' END
 FROM (SELECT lower(coalesce(substring(coalesce(e.payload->>'from',e.payload->>'from_email',e.payload->>'sender','') from '@([A-Za-z0-9.-]+)'),'')) AS d) k
$$;
COMMENT ON FUNCTION public.context_event_sender_kind(public.business_events) IS
 'B0: supplier (supplier.* event), council (a gov.au sender), platform (closed list of platform domains), ours (context_event_is_ours) or other.';

CREATE OR REPLACE FUNCTION public.context_event_identity(e public.business_events, OUT email_key text, OUT phone_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT
  CASE WHEN ok THEN coalesce(public.context_email_key(e.payload->>'email'),public.context_email_key(e.payload->>'customer_email'),
   CASE WHEN position('@' in coalesce(e.payload->>'from',''))>0 THEN public.context_email_key(e.payload->>'from') END,
   public.context_email_key(e.payload->>'from_email')) END,
  CASE WHEN ok THEN coalesce(public.context_phone_key(e.payload->>'customer_phone'),
   CASE WHEN e.direction='inbound' THEN public.context_phone_key(e.payload->>'phone') END) END
 FROM (SELECT coalesce(e.direction,'')<>'outbound' AND public.context_event_sender_kind(e)='other' AS ok) k
$$;
COMMENT ON FUNCTION public.context_event_identity(public.business_events) IS
 'B0: the customer email and phone keys of a row from a closed list (payload email, customer_email, from with an @, from_email; customer_phone, then phone on inbound rows). None for outbound, supplier, council, platform or our own rows. Computes; never places.';

CREATE OR REPLACE FUNCTION public.context_contact_for_key(p_email_key text, p_phone_key text, OUT contact_id text, OUT contacts integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH hits AS (
  SELECT j.ghl_contact_id AS c FROM public.jobs j
  WHERE p_email_key IS NOT NULL AND j.client_email IS NOT NULL AND lower(btrim(j.client_email))=p_email_key
   AND public.context_email_key(j.client_email)=p_email_key AND nullif(btrim(j.ghl_contact_id),'') IS NOT NULL
  UNION SELECT j.ghl_contact_id FROM public.jobs j
  WHERE p_phone_key IS NOT NULL AND j.client_phone IS NOT NULL AND right(regexp_replace(j.client_phone,'[^0-9]','','g'),9)=p_phone_key
   AND public.context_phone_key(j.client_phone)=p_phone_key AND nullif(btrim(j.ghl_contact_id),'') IS NOT NULL
  UNION SELECT m.ghl_contact_id FROM public.contact_matches m
  WHERE nullif(btrim(m.ghl_contact_id),'') IS NOT NULL AND (
   (p_email_key IS NOT NULL AND public.context_email_key(m.email)=p_email_key) OR
   (p_phone_key IS NOT NULL AND public.context_phone_key(m.phone)=p_phone_key))
  UNION SELECT jc.ghl_contact_id FROM public.job_contacts jc
  WHERE nullif(btrim(jc.ghl_contact_id),'') IS NOT NULL AND (
   (p_email_key IS NOT NULL AND public.context_email_key(jc.client_email)=p_email_key) OR
   (p_phone_key IS NOT NULL AND public.context_phone_key(jc.client_phone)=p_phone_key))
 )
 SELECT CASE WHEN count(DISTINCT c)=1 THEN min(c) END, count(DISTINCT c)::integer FROM hits
$$;
COMMENT ON FUNCTION public.context_contact_for_key(text,text) IS
 'B0: exactly one GHL contact for an email or phone key, from jobs with a contact, contact_matches, and job_contacts rows that already carry a GHL id; several gives null contact_id and the count (identity conflict).';

-- 4. Why a row is unlinked.
CREATE OR REPLACE FUNCTION public.context_bucket_text(e public.business_events) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN s IS NULL OR position(s in t)>0 THEN t ELSE s||E'\n'||t END
 FROM (SELECT nullif(btrim(e.payload->>'subject'),'') AS s, public.context_event_text(e) AS t) k
$$;
COMMENT ON FUNCTION public.context_bucket_text(public.business_events) IS
 'B0: the text the census reads: the stored subject (legacy email rows keep it only in payload.subject) followed by context_event_text.';

-- Live jobs by site address key: {"exact":{key:[job ids]},"loose":{key:[job ids]}}.
-- With p_loose_keys, only jobs whose site address carries one of those street
-- names (a cheap text filter); with null, every live job (the census builds
-- it once per run). Live: not terminal, not archived, not a holding job.
CREATE OR REPLACE FUNCTION public.context_live_site_index(p_loose_keys text[] DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH live AS (
  SELECT j.id, public.context_address_key(j.site_address) AS k, public.context_address_loose_keys(j.site_address) AS lk
  FROM public.jobs j
  WHERE j.site_address IS NOT NULL
   AND (p_loose_keys IS NULL OR EXISTS (SELECT 1 FROM unnest(p_loose_keys) l
    WHERE strpos(lower(j.site_address),substring(l from ' (.*)$'))>0))
   AND j.status::text NOT IN ('cancelled','archived','lost','closed','complete','completed') AND NOT coalesce(j.archived,false)
   AND coalesce(j.metadata->>'do_not_schedule','') NOT IN ('true','1'))
 SELECT jsonb_build_object(
  'exact',(SELECT coalesce(jsonb_object_agg(k,ids),'{}') FROM (SELECT k,jsonb_agg(id ORDER BY id) ids FROM live WHERE k IS NOT NULL GROUP BY k) e),
  'loose',(SELECT coalesce(jsonb_object_agg(lk1,ids),'{}') FROM (SELECT lk1,jsonb_agg(DISTINCT id) ids FROM live, unnest(lk) lk1 GROUP BY lk1) l))
$$;
COMMENT ON FUNCTION public.context_live_site_index(text[]) IS
 'B0: live jobs by exact and loose site address key, for the no-identity site step; null filter = every live job (built once per census run).';

-- Reasons, in this order (the first that applies): error, thread_conflict,
-- unverified_writer, restamped_legacy, hint_stripped, platform_sender,
-- multi_ref_many, multi_ref, single_ref, ref_not_found, identity_unread,
-- identity_conflict, contact_has_candidates, contact_no_jobs,
-- contact_only_finished, before_any_job, no_identity_site, supplier_no_ref,
-- own_party, no_identity. Details are ids, counts and flags only.
CREATE OR REPLACE FUNCTION public.context_bucket_reason_detail(e public.business_events, p_site_index jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d jsonb:='{}'; txt text; toks text[]; ref_ids uuid[]; unfound text[]; kind text; ek text; pk text;
 contact text; n_contacts int; at timestamptz; tl record; site_text text; exact_keys text[]; loose text[];
 exact_ids text[]; loose_ids text[]; site jsonb;
BEGIN
 IF e.payload ? 'attribution_error' THEN
  RETURN jsonb_build_object('reason',CASE WHEN e.payload->>'attribution_error'='thread_conflict' THEN 'thread_conflict' ELSE 'error' END);
 END IF;
 IF e.metadata ? 'written_as' AND e.metadata->>'written_as'<>'service_role' THEN
  RETURN jsonb_build_object('reason','unverified_writer');
 END IF;
 -- A hint is a job the ladder took off the row. On a row recorded before the
 -- ladder existed (20260911171000, read as 11 Sep 17:10 Perth) only a later
 -- re-run can have taken it: re-stamped legacy. After that, the ladder took it
 -- at insert because the writer gave no allowed method: hint stripped.
 -- (attribution_checked_at cannot tell them apart: every re-run re-checks
 -- every bucket row.)
 IF e.metadata ? 'attribution_hint' THEN
  d:=jsonb_build_object('hint_job_id',e.metadata->'attribution_hint'->>'job_id',
   'hint_method',coalesce(e.metadata->'attribution_hint'->>'match_method','none'));
  IF coalesce(e.recorded_at,e.context_captured_at,e.occurred_at)<'2026-09-11 09:10:00+00' THEN
   RETURN d||jsonb_build_object('reason','restamped_legacy');
  END IF;
  RETURN d||jsonb_build_object('reason','hint_stripped');
 END IF;
 kind:=public.context_event_sender_kind(e);
 d:=jsonb_build_object('sender_kind',kind);
 IF kind='platform' THEN RETURN d||jsonb_build_object('reason','platform_sender'); END IF;
 txt:=public.context_bucket_text(e);
 toks:=public.context_job_ref_tokens(txt);
 IF cardinality(toks)>0 THEN
  SELECT array_agg(DISTINCT r.job_id ORDER BY r.job_id) INTO ref_ids FROM public.context_ref_jobs(toks) r;
 END IF;
 IF cardinality(ref_ids)>5 THEN RETURN d||jsonb_build_object('reason','multi_ref_many','ref_job_ids',to_jsonb(ref_ids)); END IF;
 IF cardinality(ref_ids)>1 THEN RETURN d||jsonb_build_object('reason','multi_ref','ref_job_ids',to_jsonb(ref_ids)); END IF;
 IF cardinality(ref_ids)=1 THEN RETURN d||jsonb_build_object('reason','single_ref','ref_job_ids',to_jsonb(ref_ids)); END IF;
 SELECT array_agg(t ORDER BY t) INTO unfound FROM unnest(toks) t WHERE t ~ '^SW[A-Z]{0,4}-?[0-9]{4,}';
 IF cardinality(unfound)>0 THEN RETURN d||jsonb_build_object('reason','ref_not_found','ref_not_found',to_jsonb(unfound)); END IF;
 contact:=nullif(btrim(e.contact_id),'');
 IF contact IS NULL THEN
  SELECT i.email_key,i.phone_key INTO ek,pk FROM public.context_event_identity(e) i;
  IF ek IS NOT NULL OR pk IS NOT NULL THEN
   SELECT c.contact_id,c.contacts INTO contact,n_contacts FROM public.context_contact_for_key(ek,pk) c;
   d:=d||jsonb_build_object('identity',jsonb_build_object('email',ek IS NOT NULL,'phone',pk IS NOT NULL,'contacts',n_contacts));
   IF n_contacts>1 THEN RETURN d||jsonb_build_object('reason','identity_conflict'); END IF;
   IF n_contacts=1 THEN RETURN d||jsonb_build_object('reason','identity_unread'); END IF;
  END IF;
 ELSE
  at:=coalesce(e.event_at,e.occurred_at);
  SELECT count(*) FILTER (WHERE t.candidate) AS cand, count(*) AS total,
   count(*) FILTER (WHERE t.terminal AND t.terminal_at<=at) AS finished,
   count(*) FILTER (WHERE t.terminal AND t.terminal_at<=at AND t.terminal_at>=at-interval '60 days') AS recent
  INTO tl FROM public.context_contact_job_timeline(contact,at) t;
  d:=d||jsonb_build_object('contact_jobs',tl.total,'contact_candidates',tl.cand);
  IF tl.cand>0 THEN RETURN d||jsonb_build_object('reason','contact_has_candidates'); END IF;
  IF tl.total=0 THEN RETURN d||jsonb_build_object('reason','contact_no_jobs'); END IF;
  IF tl.finished>0 THEN RETURN d||jsonb_build_object('reason','contact_only_finished','aftercare_window',tl.recent>0); END IF;
  RETURN d||jsonb_build_object('reason','before_any_job');
 END IF;
 -- No customer identity: a site address (subject plus the first 1,500 characters).
 site_text:=coalesce(nullif(btrim(e.payload->>'subject'),'')||E'\n','')||left(public.context_event_text(e),1500);
 SELECT array_agg(DISTINCT m.address_key) FILTER (WHERE m.address_key IS NOT NULL),
  array_agg(DISTINCT lk) INTO exact_keys, loose
 FROM public.context_address_mentions(site_text) m LEFT JOIN LATERAL unnest(m.loose_keys) lk ON true;
 IF cardinality(loose)>0 THEN
  site:=coalesce(p_site_index,public.context_live_site_index(loose));
  SELECT array_agg(DISTINCT x ORDER BY x) INTO exact_ids
  FROM unnest(coalesce(exact_keys,'{}')) k, jsonb_array_elements_text(coalesce(site->'exact'->k,'[]')) x;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO loose_ids
  FROM unnest(loose) k, jsonb_array_elements_text(coalesce(site->'loose'->k,'[]')) x;
  IF cardinality(loose_ids)>0 THEN
   RETURN d||jsonb_build_object('reason','no_identity_site','site_exact_job_ids',coalesce(to_jsonb(exact_ids),'[]'::jsonb),
    'site_loose_job_ids',to_jsonb(loose_ids));
  END IF;
 END IF;
 IF kind='supplier' THEN RETURN d||jsonb_build_object('reason','supplier_no_ref'); END IF;
 IF kind='ours' THEN RETURN d||jsonb_build_object('reason','own_party'); END IF;
 RETURN d||jsonb_build_object('reason','no_identity');
END $$;
COMMENT ON FUNCTION public.context_bucket_reason_detail(public.business_events,jsonb) IS
 'B0: why a row is unlinked: one closed reason plus ids, counts and flags (never text). Read-only; the census and the rows read use it.';

CREATE OR REPLACE FUNCTION public.context_bucket_reason(e public.business_events) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT public.context_bucket_reason_detail(e,NULL)->>'reason'
$$;
COMMENT ON FUNCTION public.context_bucket_reason(public.business_events) IS
 'B0: the closed reason of context_bucket_reason_detail.';

-- Census parts: rows per reason with age bands and up to 5 sample ids (newest first).
CREATE OR REPLACE FUNCTION public.context_census_reasons(p_reasons text[], p_ages text[], p_ids uuid[]) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('reason',r.reason,'rows',r.n,'age',r.age,'sample_ids',r.samples) ORDER BY r.n DESC,r.reason),'[]')
 FROM (SELECT x.reason,count(*) n,
   jsonb_build_object('lt_1d',count(*) FILTER (WHERE x.age='lt_1d'),'d1_7',count(*) FILTER (WHERE x.age='d1_7'),
    'd7_30',count(*) FILTER (WHERE x.age='d7_30'),'d30_90',count(*) FILTER (WHERE x.age='d30_90'),'gt_90',count(*) FILTER (WHERE x.age='gt_90')) age,
   to_jsonb((array_agg(x.id ORDER BY x.ord))[1:5]) samples
  FROM unnest(p_reasons,p_ages,p_ids) WITH ORDINALITY x(reason,age,id,ord) GROUP BY x.reason) r
$$;
COMMENT ON FUNCTION public.context_census_reasons(text[],text[],uuid[]) IS
 'B0: census part helper: rows per reason, age bands and up to 5 sample ids.';

-- 5. The census, resumable. The API role stops any statement at 8 seconds, so
-- one call reads for at most p_budget_ms (default 6 s, at most 7 s) and returns
-- the counts for the rows it read plus `next` (a phase and keyset cursor); the
-- ops-api door calls again from `next` and adds the parts up. Phases, each
-- newest first:
--   admin_bucket       every bucket row, classified;
--   holding_job        rows the ladder's own step 1 put on a holding job (no
--                      writer binding), classified as if unlinked (the rows
--                      B-RUN step c re-decides);
--   custody_multi_ref  monitor-inbox custody rows whose text names two or more
--                      of our jobs (adminbucket Review B1).
-- The first call (no phase) also returns the whole-table sections: totals,
-- bucket rows by source and event type, 24-hour movement, and NULL-status rows
-- with and without a job (counted, not classified). Writes nothing.
CREATE OR REPLACE FUNCTION public.context_unlinked_census(p_budget_ms integer DEFAULT 6000, p_phase text DEFAULT NULL,
 p_cursor_at timestamptz DEFAULT NULL, p_cursor_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t0 timestamptz:=clock_timestamp(); deadline timestamptz; now_t timestamptz:=now(); budget int;
 e public.business_events; d jsonb; out jsonb:='{}'; site jsonb; next jsonb; age text;
 phases text[]:=ARRAY['admin_bucket','holding_job','custody_multi_ref']; first_phase int; i int;
 last_at timestamptz; last_id uuid; nref int; processed int:=0;
 b_reason text[]:='{}'; b_age text[]:='{}'; b_id uuid[]:='{}'; b_hint text[]:='{}';
 h_reason text[]:='{}'; h_age text[]:='{}'; h_id uuid[]:='{}';
 cust_checked int:=0; cust_ids uuid[]:='{}';
BEGIN
 IF p_phase IS NOT NULL AND NOT p_phase=ANY(phases) THEN
  RAISE EXCEPTION 'context_unlinked_census: unknown phase %',p_phase USING ERRCODE='22023';
 END IF;
 IF (p_cursor_at IS NULL)<>(p_cursor_id IS NULL) OR (p_phase IS NULL AND p_cursor_id IS NOT NULL) THEN
  RAISE EXCEPTION 'context_unlinked_census: a cursor needs its phase, at and id' USING ERRCODE='22023';
 END IF;
 budget:=greatest(1,least(coalesce(p_budget_ms,6000),7000));
 deadline:=t0+make_interval(secs=>budget/1000.0);
 IF p_phase IS NULL THEN
  out:=jsonb_build_object('generated_at',now_t,
   'totals',(SELECT jsonb_build_object(
     'admin_bucket',count(*) FILTER (WHERE b.attribution_status='admin_bucket'),
     'unplaced',count(*) FILTER (WHERE b.attribution_status='unplaced'),
     'null_status_no_job',count(*) FILTER (WHERE b.attribution_status IS NULL AND b.job_id IS NULL),
     'null_status_with_job',count(*) FILTER (WHERE b.attribution_status IS NULL AND b.job_id IS NOT NULL),
     'holding_job',count(*) FILTER (WHERE b.job_id IS NOT NULL AND coalesce(b.attribution_step,0)=1 AND NOT (b.metadata ? 'source_job_binding')
       AND b.job_id IN (SELECT j.id FROM public.jobs j WHERE coalesce(j.metadata->>'do_not_schedule','') IN ('true','1'))),
     'custody_monitor_inbox',count(*) FILTER (WHERE b.attribution_status='direct' AND b.source IN ('monitor-inbox','monitor-inbox-group','monitor_inbox')
       AND coalesce(b.metadata->'source_job_binding'->>'match_method',b.match_method)='direct_reference'))
    FROM public.business_events b),
   'bucket_by_source',(SELECT coalesce(jsonb_agg(jsonb_build_object('source',s.source,'event_type',s.event_type,'rows',s.n) ORDER BY s.n DESC,s.source,s.event_type),'[]')
    FROM (SELECT source,event_type,count(*) n FROM public.business_events WHERE attribution_status='admin_bucket' GROUP BY 1,2) s),
   'bucket_24h',(SELECT jsonb_build_object(
     'new',count(*) FILTER (WHERE coalesce(context_captured_at,recorded_at)>now_t-interval '24 hours'),
     'rechecked_by_rerun',count(*) FILTER (WHERE attribution_checked_at>now_t-interval '24 hours'
       AND coalesce(context_captured_at,recorded_at)<=now_t-interval '24 hours'))
    FROM public.business_events WHERE attribution_status='admin_bucket'),
   'null_status_no_job_by_source',(SELECT coalesce(jsonb_agg(jsonb_build_object('source',s.source,'event_type',s.event_type,'rows',s.n) ORDER BY s.n DESC,s.source,s.event_type),'[]')
    FROM (SELECT source,event_type,count(*) n FROM public.business_events WHERE attribution_status IS NULL AND job_id IS NULL
     GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20) s));
  first_phase:=1;
 ELSE
  first_phase:=array_position(phases,p_phase);
 END IF;
 site:=public.context_live_site_index(NULL);
 <<phase_loop>>
 FOR i IN first_phase..3 LOOP
  IF i=first_phase THEN last_at:=p_cursor_at; last_id:=p_cursor_id; ELSE last_at:=NULL; last_id:=NULL; END IF;
  FOR e IN SELECT b.* FROM public.business_events b
   WHERE CASE i
     WHEN 1 THEN b.attribution_status='admin_bucket'
     WHEN 2 THEN b.job_id IS NOT NULL AND coalesce(b.attribution_step,0)=1 AND NOT (b.metadata ? 'source_job_binding')
      AND b.job_id IN (SELECT j.id FROM public.jobs j WHERE coalesce(j.metadata->>'do_not_schedule','') IN ('true','1'))
     ELSE b.attribution_status='direct' AND b.source IN ('monitor-inbox','monitor-inbox-group','monitor_inbox')
      AND coalesce(b.metadata->'source_job_binding'->>'match_method',b.match_method)='direct_reference' END
    AND (last_id IS NULL OR (coalesce(b.event_at,b.occurred_at),b.id)<(last_at,last_id))
   ORDER BY coalesce(b.event_at,b.occurred_at) DESC, b.id DESC LOOP
   -- Every call reads at least one row, so a caller following next always ends.
   IF processed>0 AND clock_timestamp()>deadline THEN
    next:=jsonb_build_object('phase',phases[i],'cursor_at',last_at,'cursor_id',last_id);
    EXIT phase_loop;
   END IF;
   age:=CASE WHEN coalesce(e.event_at,e.occurred_at)>now_t-interval '1 day' THEN 'lt_1d'
    WHEN coalesce(e.event_at,e.occurred_at)>now_t-interval '7 days' THEN 'd1_7'
    WHEN coalesce(e.event_at,e.occurred_at)>now_t-interval '30 days' THEN 'd7_30'
    WHEN coalesce(e.event_at,e.occurred_at)>now_t-interval '90 days' THEN 'd30_90' ELSE 'gt_90' END;
   IF i=1 THEN
    d:=public.context_bucket_reason_detail(e,site);
    b_reason:=b_reason||(d->>'reason'); b_age:=b_age||age; b_id:=b_id||e.id; b_hint:=b_hint||(d->>'hint_method');
   ELSIF i=2 THEN
    d:=public.context_bucket_reason_detail(e,site);
    h_reason:=h_reason||(d->>'reason'); h_age:=h_age||age; h_id:=h_id||e.id;
   ELSE
    cust_checked:=cust_checked+1;
    SELECT count(DISTINCT r.job_id) INTO nref FROM public.context_ref_jobs(public.context_job_ref_tokens(public.context_bucket_text(e))) r;
    IF nref>1 THEN cust_ids:=cust_ids||e.id; END IF;
   END IF;
   last_at:=coalesce(e.event_at,e.occurred_at); last_id:=e.id; processed:=processed+1;
  END LOOP;
 END LOOP;
 RETURN out||jsonb_build_object(
  'complete',next IS NULL,'next',next,'budget_ms',budget,
  'elapsed_ms',round(extract(epoch FROM clock_timestamp()-t0)*1000),
  'admin_bucket',jsonb_build_object('classified',cardinality(b_id),
   'by_reason',public.context_census_reasons(b_reason,b_age,b_id),
   'restamped_legacy_by_prior_method',(SELECT coalesce(jsonb_object_agg(h.m,h.n),'{}')
    FROM (SELECT x.hint AS m,count(*) n FROM unnest(b_reason,b_hint) x(reason,hint) WHERE x.reason='restamped_legacy' GROUP BY 1) h)),
  'holding_job',jsonb_build_object('classified',cardinality(h_id),'by_reason',public.context_census_reasons(h_reason,h_age,h_id)),
  'custody_multi_ref',jsonb_build_object('checked',cust_checked,'rows',cardinality(cust_ids),'sample_ids',to_jsonb(cust_ids[1:5])));
END $$;
COMMENT ON FUNCTION public.context_unlinked_census(integer,text,timestamptz,uuid) IS
 'B0: resumable census of unlinked evidence (bucket rows, holding-job rows, monitor-inbox custody rows naming two or more jobs) by reason and age band, with whole-table totals on the first call. Each call reads for at most 7 s and returns next when there is more. Read-only, service_role only.';

-- 6. One page of unlinked rows, with what the job read shows for each.
-- Scopes: bucket (admin_bucket), null_status (no status, no job), unplaced,
-- holding_job (ladder step 1 on a holding job, no writer binding),
-- custody_multi_ref (monitor-inbox custody rows naming two or more jobs).
-- Each call reads for at most p_budget_ms (at most 7 s, under the API role's
-- 8-second statement limit) and returns next_cursor when there is more.
CREATE OR REPLACE FUNCTION public.context_unlinked_rows(p_scope text DEFAULT 'bucket', p_reason text DEFAULT NULL,
 p_source text DEFAULT NULL, p_since timestamptz DEFAULT NULL, p_cursor_at timestamptz DEFAULT NULL, p_cursor_id uuid DEFAULT NULL,
 p_limit integer DEFAULT 25, p_budget_ms integer DEFAULT 5000) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE deadline timestamptz; lim int; e public.business_events; d jsonb; rows jsonb:='[]'; scanned int:=0; last_at timestamptz; last_id uuid;
 complete boolean:=true; p jsonb; body text; named uuid[]; hint uuid; toks text[];
BEGIN
 IF coalesce(p_scope,'bucket') NOT IN ('bucket','null_status','unplaced','holding_job','custody_multi_ref') THEN
  RAISE EXCEPTION 'context_unlinked_rows: unknown scope %',p_scope USING ERRCODE='22023';
 END IF;
 IF (p_cursor_at IS NULL)<>(p_cursor_id IS NULL) THEN
  RAISE EXCEPTION 'context_unlinked_rows: cursor needs both at and id' USING ERRCODE='22023';
 END IF;
 lim:=greatest(1,least(coalesce(p_limit,25),100));
 deadline:=clock_timestamp()+make_interval(secs=>greatest(1,least(coalesce(p_budget_ms,5000),7000))/1000.0);
 FOR e IN SELECT * FROM public.business_events b
  WHERE CASE coalesce(p_scope,'bucket')
    WHEN 'bucket' THEN b.attribution_status='admin_bucket'
    WHEN 'null_status' THEN b.attribution_status IS NULL AND b.job_id IS NULL
    WHEN 'unplaced' THEN b.attribution_status='unplaced'
    WHEN 'holding_job' THEN b.job_id IS NOT NULL AND coalesce(b.attribution_step,0)=1 AND NOT (b.metadata ? 'source_job_binding')
     AND b.job_id IN (SELECT j.id FROM public.jobs j WHERE coalesce(j.metadata->>'do_not_schedule','') IN ('true','1'))
    ELSE b.attribution_status='direct' AND b.source IN ('monitor-inbox','monitor-inbox-group','monitor_inbox')
     AND coalesce(b.metadata->'source_job_binding'->>'match_method',b.match_method)='direct_reference' END
   AND (p_source IS NULL OR b.source=p_source)
   AND (p_since IS NULL OR coalesce(b.event_at,b.occurred_at)>=p_since)
   AND (p_cursor_at IS NULL OR (coalesce(b.event_at,b.occurred_at),b.id)<(p_cursor_at,p_cursor_id))
  ORDER BY coalesce(b.event_at,b.occurred_at) DESC, b.id DESC LOOP
  IF scanned>0 AND clock_timestamp()>deadline THEN complete:=false; EXIT; END IF;
  scanned:=scanned+1; last_at:=coalesce(e.event_at,e.occurred_at); last_id:=e.id;
  IF coalesce(p_scope,'bucket')='custody_multi_ref' THEN
   toks:=public.context_job_ref_tokens(public.context_bucket_text(e));
   SELECT array_agg(DISTINCT r.job_id ORDER BY r.job_id) INTO named FROM public.context_ref_jobs(toks) r;
   CONTINUE WHEN coalesce(cardinality(named),0)<2;
   d:=jsonb_build_object('reason','custody_multi_ref','ref_job_ids',to_jsonb(named));
  ELSIF coalesce(p_scope,'bucket')='unplaced' THEN
   d:=jsonb_build_object('reason','unplaced');
  ELSE
   d:=public.context_bucket_reason_detail(e);
  END IF;
  CONTINUE WHEN p_reason IS NOT NULL AND d->>'reason' IS DISTINCT FROM p_reason;
  p:=coalesce(e.payload,'{}');
  body:=coalesce(p->>'body',p->>'text',p->>'message',p->>'note_preview',p->>'note_text',p->>'body_preview','');
  hint:=CASE WHEN coalesce(e.metadata->'attribution_hint'->>'job_id',p->'attribution_hint'->>'job_id','') ~ '^[0-9a-fA-F-]{36}$'
   THEN coalesce(e.metadata->'attribution_hint'->>'job_id',p->'attribution_hint'->>'job_id')::uuid END;
  rows:=rows||jsonb_build_object(
   'id',e.id,'event_type',e.event_type,'source',e.source,'channel',e.channel,'direction',e.direction,
   'attribution_status',e.attribution_status,'event_at',e.event_at,'occurred_at',e.occurred_at,
   'captured_at',coalesce(e.context_captured_at,e.recorded_at),'contact_id',e.contact_id,
   'sender',coalesce(p->>'from',p->>'from_email',p->>'sender_name',p->>'added_by',p->>'phone'),
   'recipients',coalesce(p->'to',p->'to_email',p->'recipients'),
   'subject',p->>'subject','preview',left(body,500),
   'reason',d->>'reason','detail',d-'reason','placement_rule',e.metadata->>'placement_rule',
   'hint_job_number',(SELECT j.job_number FROM public.jobs j WHERE j.id=hint),
   'bound_job_number',(SELECT j.job_number FROM public.jobs j WHERE j.id=e.job_id),
   'candidate_job_numbers',(SELECT coalesce(jsonb_agg(j.job_number ORDER BY j.job_number),'[]') FROM public.jobs j WHERE j.id=ANY(e.candidate_job_ids)),
   'named_job_numbers',(SELECT coalesce(jsonb_agg(j.job_number ORDER BY j.job_number),'[]') FROM public.jobs j
     WHERE j.id IN (SELECT (x#>>'{}')::uuid FROM jsonb_array_elements(coalesce(d->'ref_job_ids',d->'site_loose_job_ids','[]')) x)));
  EXIT WHEN jsonb_array_length(rows)>=lim;
 END LOOP;
 RETURN jsonb_build_object('scope',coalesce(p_scope,'bucket'),'rows',rows,'scanned',scanned,'complete',complete,
  'next_cursor',CASE WHEN last_id IS NOT NULL AND (NOT complete OR jsonb_array_length(rows)>=lim)
   THEN jsonb_build_object('at',last_at,'id',last_id) END);
END $$;
COMMENT ON FUNCTION public.context_unlinked_rows(text,text,text,timestamptz,timestamptz,uuid,integer,integer) IS
 'B0: one page (at most 100) of unlinked rows, newest first with a keyset cursor, each with its reason, what the job read shows (sender, recipients, subject, 500-character preview) and the hint, bound, candidate and named job numbers. Read-only, service_role only.';

-- 7. Expression indexes on jobs, on built-in expressions only. An index on a
-- function revoked from anon and authenticated would make every insert or
-- update of jobs by those roles fail (index maintenance checks EXECUTE as the
-- writing role), so the key functions confirm after an index lookup instead.
CREATE INDEX IF NOT EXISTS jobs_context_job_number_upper ON public.jobs (upper(job_number));
CREATE INDEX IF NOT EXISTS jobs_context_phone_right9 ON public.jobs (right(regexp_replace(client_phone,'[^0-9]','','g'),9))
 WHERE client_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_context_email_lower ON public.jobs (lower(btrim(client_email)))
 WHERE client_email IS NOT NULL;

-- 8. Grants: service_role only; nothing reachable by the public key or a login.
REVOKE ALL ON FUNCTION
 public.context_phone_key(text), public.context_email_key(text), public.context_street_type(text),
 public.context_address_mentions(text), public.context_address_key(text), public.context_address_loose_keys(text),
 public.context_job_ref_tokens(text), public.context_ref_jobs(text[]),
 public.context_event_sender_kind(public.business_events), public.context_event_identity(public.business_events),
 public.context_contact_for_key(text,text), public.context_bucket_text(public.business_events),
 public.context_live_site_index(text[]), public.context_bucket_reason_detail(public.business_events,jsonb), public.context_bucket_reason(public.business_events),
 public.context_census_reasons(text[],text[],uuid[]), public.context_unlinked_census(integer,text,timestamptz,uuid),
 public.context_unlinked_rows(text,text,text,timestamptz,timestamptz,uuid,integer,integer)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
 public.context_phone_key(text), public.context_email_key(text), public.context_street_type(text),
 public.context_address_mentions(text), public.context_address_key(text), public.context_address_loose_keys(text),
 public.context_job_ref_tokens(text), public.context_ref_jobs(text[]),
 public.context_event_sender_kind(public.business_events), public.context_event_identity(public.business_events),
 public.context_contact_for_key(text,text), public.context_bucket_text(public.business_events),
 public.context_live_site_index(text[]), public.context_bucket_reason_detail(public.business_events,jsonb), public.context_bucket_reason(public.business_events),
 public.context_census_reasons(text[],text[],uuid[]), public.context_unlinked_census(integer,text,timestamptz,uuid),
 public.context_unlinked_rows(text,text,text,timestamptz,timestamptz,uuid,integer,integer)
TO service_role;
