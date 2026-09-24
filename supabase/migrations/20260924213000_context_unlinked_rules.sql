-- P4: one set of placement rules for texts, email and calls, so a message
-- that can be proved to belong to a job lands on it and anything else is shown
-- as "not placed, could be one of these jobs" (adminbucket.md section 4 and
-- slice P4, with email.md finding 6 and its rows E5 to E21; INTEGRATION.md
-- Wave 3 row P4, settlements X16, X23 to X27, X36).
--
-- About 4,300 evidence rows sit in the admin bucket. Several causes are in the
-- ladder itself: it reads a sender's email from payload.email, but email
-- capture writes payload.from, so no email sender is ever matched to a
-- customer (email.md finding 6); a message naming two of our jobs is dropped;
-- "SWP 26195" typed with a space matches nothing; a supplier replying with only
-- its own order number is lost; a council letter naming a job's site is lost;
-- a message a few hours after a job finished finds no job; and every guessed
-- placement binds its email conversation to that job for good. This migration:
--
--   1. context_unlinked_rules_enabled(): feature flag context_unlinked_rules_v1.
--      Missing, unreadable or false reads as off. The flag row is created off.
--      No switch or flag is turned on here.
--   2. resolve_context_attribution(e, p_preview, p_rules_on): the one ladder.
--      With the rules off (today, and until the flag goes on) it runs P1a's
--      ladder unchanged (context_ladder_p1a, the live body moved verbatim, with
--      only its thread-binding write skipped in preview). With the rules on it
--      runs adminbucket.md section 4, in this order:
--        0. Writer check: a row whose metadata.written_as (recorded by the
--           insert trigger, item 6) is not service_role is never placed; any
--           job it claims is kept as a hint and it rests in the bucket with
--           reason unverified_writer (X16, X36). A row with no written_as
--           (filed before K1) is treated as today, stamped writer_unknown.
--        1. Custody: a job given by the writer with an allowed method is kept
--           (the writer's own method, read from source_job_binding on rows P1a
--           filed), except monitor-inbox's first-match binding: that text is scanned
--           again, and 2 to 5 of our jobs make it unplaced "names these jobs"
--           (rule multi_ref), more than 5 bucket it (multi_ref_many), exactly
--           one places it on that job.
--        2. Identity (computes, never places): the customer's email and phone
--           keys from context_event_identity (payload.email, customer_email,
--           from, from_email; customer_phone, phone on inbound rows; none for
--           outbound, supplier, council, platform or our own rows). With no
--           contact on the row, context_contact_for_key recovers exactly one
--           GHL contact; several leave it null with metadata.identity_conflict.
--           This is the finding 6 fix: payload.from is read.
--        3. References: context_job_ref_tokens over the subject and text (L1's
--           exact tokens plus "SWP 26195"). One job: direct, rule direct_ref,
--           match_method ladder_ref (not custody, so a later re-decision can
--           re-run it). 2 to 5: unplaced, rule multi_ref, no model call. More:
--           bucket multi_ref_many. A job-shaped token that matches no job is
--           listed in metadata.ref_not_found.
--        4. Thread: only a live binding (retired_at null). When the contact is
--           known, the bound job must be one of its candidates at the message
--           time. A retired binding sends the row to unplaced with both jobs.
--           GHL items never use a thread (P1a). Then, only with no customer
--           identity, supplier order numbers: each 6 to 8 digit subject token
--           (not a date, not phone-shaped) is looked up as
--           supplier_ref:<sender key>:<number>.
--        5. Contact rules (P1a's at-time candidates, lead window, 90-day guard,
--           line rule), from context_contact_job_timeline with the row's own
--           email and phone keys: contactless or other-contact jobs whose
--           client key matches the message join, even when the contact is
--           null. Placed by a recovered contact or a key: rule identity_email
--           or identity_phone. Aftercare (X26 as decided 24 Sep): with no
--           live job, the customer's jobs that became terminal before the
--           message (a job in status invoiced counts as finished at its
--           completion time) with an ACCREC invoice unpaid at that time, or
--           within the 60 days before it, go to review with those jobs as
--           candidates and the unpaid ones in metadata.aftercare_unpaid_job_ids.
--           They are never placed directly: X26's single_open shortcut would
--           place named row N17 (a new enquiry sent while the finished job's
--           last invoice was unpaid) on the finished job, and only the words
--           tell it from N7 (a final-payment question). A live job always
--           outranks an aftercare job. Rows loaded as backfill or relink never go to review
--           by the model: several candidates rest unplaced (X27).
--        6. Site address, only with no contact: the subject plus the first
--           1,500 characters. An exact address key (unit and letter suffix
--           kept, one street-type table, suburb not in the key; slash forms are
--           never exact) naming one job live at the message time (or finished
--           within 60 days) places it, content_ref rule site_address; 2 or 3
--           unplaced with them; more bucket. A loose match (suffix dropped,
--           type optional) is only ever unplaced with its candidates.
--        7. Bucket, with metadata.bucket_reason.
--      Bindings (X25): a thread is bound only by a direct or content_ref
--      placement, never by a guess (single_open, single_line, aftercare), and a
--      direct result never raises thread_conflict or moves another binding. A
--      supplier order number is bound only by a direct placement from a sender
--      with no customer identity, at most two numbers in the subject; a number
--      already bound to another job is retired (retired_at, reason conflict)
--      and later rows quoting only it rest unplaced with both jobs.
--      Always, rules on or off: a row left in the bucket carries
--      metadata.bucket_reason (B0's context_bucket_reason), metadata only.
--   3. resolve_context_attribution(e): the one-argument entry every caller
--      uses (insert trigger, bucket re-run, P1b's reconsideration). It calls
--      (2) with the flag's state and no preview.
--   4. context_contact_job_timeline(contact, at, phone_key, email_key) and
--      context_contact_jobs_at(contact, at, phone_key, email_key): P1a's
--      timeline and candidate set with the message's own keys and the
--      aftercare clause (X4, X26). P1a's two-argument versions are unchanged
--      and keep serving the Luna guard and P1b.
--   5. context_attribution_preview(event, rules_on): what the ladder would
--      decide for a stored row, rules forced on or off. Writes nothing (no row,
--      no binding); service_role only. The L6 validator runs it before the
--      flag goes on (gate G-P4-L6).
--   6. attribute_business_event (the BEFORE INSERT trigger): records
--      metadata.written_as before the ladder runs, as well as after, so the
--      writer check reads the request role and never a value the writer sent.
--   7. event_threads.retired_at, retired_reason, retired_conflict_job_id.
--
-- Status names are F1's; the rule is in metadata.placement_rule. Attribution
-- step: 1 references and custody (multi_ref included), 2 thread and supplier
-- order, 3 single_open (identity included), 4 single_line, 5
-- review, 6 site address and bucket. No existing row is written or rewritten
-- by this migration (rows move only when inserted or re-decided after the flag
-- goes on). No switch changes. Ids and codes only in metadata, no text.
--
-- Built on the LIVE production definitions, read from production 24 Sep 2026
-- (read-only):
--   resolve_context_attribution(business_events)   md5(prosrc) fe50f14f4ab28d4d6c9dbb70bc85e7df (P1a)
--   attribute_business_event()                     md5(prosrc) 7c1b8ffeeed8829288ee42c30e4314e5 (K1)
--   read, not replaced: context_contact_job_timeline(text,timestamptz) 2bc8e76f (P1a),
--   context_event_is_ghl 6bd40463 (P1a), context_event_text bd5870b9, context_request_role (K1),
--   context_event_identity cc484b96, context_contact_for_key 78eedc72, context_job_ref_tokens c8c7dac3,
--   context_ref_jobs f21ce8cf, context_address_mentions 24387675, context_event_sender_kind 8d0c9610,
--   context_bucket_text, context_bucket_reason (B0).
--   Both replaced objects: EXECUTE held by postgres and service_role only; the
--   one trigger on business_events is context_attribute_business_event, BEFORE
--   INSERT FOR EACH ROW.
--   event_threads(thread_key text PK, job_id uuid, bound_by text, bound_at timestamptz,
--   source_event_id uuid), 472 rows, none supplier_ref; xero_invoices invoice_date
--   date (none null on ACCREC), fully_paid_on date (24 PAID ACCREC rows have none:
--   read as not unpaid); feature_flags(id, flag_name unique, enabled, description,
--   updated_at), no context_unlinked_rules_v1 row; monitor-inbox sources
--   monitor-inbox, monitor_inbox, monitor-inbox-group. The ledger held only
--   20260924201000 after 20260924183000.
-- The guard refuses unless each replaced object is still that pre-image (or
-- already this migration's body, for a re-apply), each read object is present,
-- each new name is absent or already P4's (marked "P4:" in its comment), and
-- every column read has the type listed.
-- Rollback: supabase/rollbacks/20260924213000_context_unlinked_rules_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every problem at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  -- Replaced: live pre-image, or this migration's body.
  ('public.resolve_context_attribution(public.business_events)',ARRAY['fe50f14f4ab28d4d6c9dbb70bc85e7df','32365101d23dde1695707a0bddff640b']),
  ('public.attribute_business_event()',ARRAY['7c1b8ffeeed8829288ee42c30e4314e5','d0036a1bc36f4b2a779f4a8b192cd687']),
  -- Read, not replaced: must be the merged bodies these rules were written against.
  ('public.context_contact_job_timeline(text,timestamp with time zone)',ARRAY['2bc8e76f14fda242eb6e4d414e93fefa']),
  ('public.context_event_is_ghl(public.business_events)',ARRAY['6bd4046317c4530a67ae38b0d7052cf4']),
  ('public.context_event_text(public.business_events)',ARRAY['bd5870b90e0f912d6a6d5be4faea812e']),
  ('public.context_event_identity(public.business_events)',ARRAY['cc484b96d670d401a3457347884f5371']),
  ('public.context_contact_for_key(text,text)',ARRAY['78eedc7273576c02e8aa119924c6d5fd']),
  ('public.context_job_ref_tokens(text)',ARRAY['c8c7dac3f00d9aa620fb230dfd3a2791']),
  ('public.context_ref_jobs(text[])',ARRAY['f21ce8cf72292e016daf18d1ee5e9a8c']),
  ('public.context_address_mentions(text)',ARRAY['2438767564934b956319284c323e90f5']),
  ('public.context_event_sender_kind(public.business_events)',ARRAY['8d0c96101aa111dd540371953f4f12ad'])
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 FOR x IN SELECT * FROM (VALUES ('public.context_request_role()'),('public.context_bucket_text(public.business_events)'),
  ('public.context_bucket_reason(public.business_events)'),('public.context_email_key(text)'),('public.context_phone_key(text)'),
  ('public.context_address_key(text)'),('public.context_address_loose_keys(text)'),('public.automation_lane_enabled(text)'),
  ('public.context_contact_jobs_at(text,timestamp with time zone)')) AS f(sig) LOOP
  IF to_regprocedure(x.sig) IS NULL THEN problems:=problems||format('%s is missing',x.sig); END IF;
 END LOOP;
 -- New names: absent, or already P4's.
 FOR x IN SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(p.prosrc) AS h,
   coalesce(obj_description(p.oid,'pg_proc'),'') AS note
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND (p.proname IN ('context_unlinked_rules_enabled','context_ladder_p1a','context_supplier_order_tokens',
    'context_sender_key','context_job_unpaid_at','context_attribution_preview')
   OR (p.proname='resolve_context_attribution' AND pg_get_function_identity_arguments(p.oid)<>'e business_events')
   OR (p.proname IN ('context_contact_job_timeline','context_contact_jobs_at') AND pronargs<>2)) LOOP
  IF x.note NOT LIKE 'P4:%' THEN problems:=problems||format('%s(%s) already exists (md5 %s) and is not P4''s',x.proname,x.args,x.h); END IF;
 END LOOP;
 -- The insert trigger still routes every insert through attribute_business_event.
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.business_events'::regclass AND t.tgname='context_attribute_business_event'
   AND NOT t.tgisinternal AND t.tgfoid='public.attribute_business_event()'::regprocedure AND t.tgtype=7 AND t.tgenabled<>'D')
 THEN problems:=problems||'trigger context_attribute_business_event is not the one enabled BEFORE INSERT FOR EACH ROW trigger'::text; END IF;
 -- Columns read (types as read from production).
 FOR x IN SELECT * FROM (VALUES
  ('event_threads','thread_key','text'),('event_threads','job_id','uuid'),('event_threads','bound_by','text'),
  ('event_threads','source_event_id','uuid'),
  ('feature_flags','flag_name','text'),('feature_flags','enabled','boolean'),('feature_flags','description','text'),
  ('feature_flags','updated_at','timestamp with time zone'),
  ('xero_invoices','job_id','uuid'),('xero_invoices','invoice_type','text'),('xero_invoices','status','text'),
  ('xero_invoices','invoice_date','date'),('xero_invoices','fully_paid_on','date'),
  ('jobs','site_address','text'),('jobs','completed_at','timestamp with time zone'),('jobs','updated_at','timestamp with time zone'),
  ('jobs','created_at','timestamp with time zone'),('jobs','archived','boolean'),('jobs','status','text'),('jobs','metadata','jsonb'),
  ('jobs','client_phone','text'),('jobs','client_email','text'),('jobs','ghl_contact_id','text'),
  ('business_events','candidate_job_ids','uuid[]'),('business_events','thread_key','text'),('business_events','source','text'),
  ('business_events','match_method','text'),('business_events','metadata','jsonb'),('business_events','payload','jsonb')
 ) AS c(tbl,col,typ) LOOP
  live:=NULL;
  SELECT format_type(a.atttypid,a.atttypmod) INTO live FROM pg_attribute a
  WHERE a.attrelid=to_regclass('public.'||x.tbl) AND a.attname=x.col AND a.attnum>0 AND NOT a.attisdropped;
  IF live IS DISTINCT FROM x.typ THEN problems:=problems||format('%s.%s is %s, expected %s',x.tbl,x.col,coalesce(live,'<missing>'),x.typ); END IF;
 END LOOP;
 -- The added columns: absent, or already this migration's shape.
 FOR x IN SELECT * FROM (VALUES ('retired_at','timestamp with time zone'),('retired_reason','text'),('retired_conflict_job_id','uuid')) AS c(col,typ) LOOP
  live:=NULL;
  SELECT format_type(a.atttypid,a.atttypmod) INTO live FROM pg_attribute a
  WHERE a.attrelid='public.event_threads'::regclass AND a.attname=x.col AND a.attnum>0 AND NOT a.attisdropped;
  IF live IS NOT NULL AND live<>x.typ THEN problems:=problems||format('event_threads.%s is %s, expected %s',x.col,live,x.typ); END IF;
 END LOOP;
 -- The resting and content statuses must exist (F1).
 IF NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.business_events'::regclass
   AND c.conname='business_events_attribution_status_check' AND pg_get_constraintdef(c.oid) LIKE '%''unplaced''::text%'
   AND pg_get_constraintdef(c.oid) LIKE '%''content_ref''::text%')
 THEN problems:=problems||'business_events_attribution_status_check does not allow unplaced and content_ref (F1 not applied)'::text; END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_unlinked_rules_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 7 (first, the ladder reads them). Retired thread and supplier-order bindings.
ALTER TABLE public.event_threads ADD COLUMN IF NOT EXISTS retired_at timestamptz,
 ADD COLUMN IF NOT EXISTS retired_reason text,
 ADD COLUMN IF NOT EXISTS retired_conflict_job_id uuid;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.event_threads'::regclass AND conname='event_threads_retired_shape') THEN
  ALTER TABLE public.event_threads ADD CONSTRAINT event_threads_retired_shape CHECK (
   (retired_at IS NULL AND retired_reason IS NULL AND retired_conflict_job_id IS NULL)
   OR (retired_at IS NOT NULL AND retired_reason='conflict'));
 END IF;
END $$;
COMMENT ON COLUMN public.event_threads.retired_at IS
 'P4: set when a conflicting job reuses the same key; retired_conflict_job_id records the other job. A retired key is never re-bound; rows quoting it rest unplaced with both jobs. Reversible by clearing the three columns.';

-- 1. The flag. Fails closed: no table, no row, or an error is off.
CREATE OR REPLACE FUNCTION public.context_unlinked_rules_enabled() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE on_flag boolean;
BEGIN
 IF to_regclass('public.feature_flags') IS NULL THEN RETURN false; END IF;
 EXECUTE 'SELECT f.enabled FROM public.feature_flags f WHERE f.flag_name=$1 ORDER BY f.updated_at DESC NULLS LAST LIMIT 1'
  INTO on_flag USING 'context_unlinked_rules_v1';
 RETURN coalesce(on_flag,false);
EXCEPTION WHEN OTHERS THEN
 RETURN false;
END $$;
COMMENT ON FUNCTION public.context_unlinked_rules_enabled() IS
 'P4: feature_flags.context_unlinked_rules_v1. Missing, unreadable or false is off. Owned by the placement track (P4).';

INSERT INTO public.feature_flags(flag_name,enabled,description)
SELECT 'context_unlinked_rules_v1',false,
 'P4 placement rules (adminbucket.md section 4): identity from payload.from, several references unplaced, supplier order numbers, finished jobs to review, site address. Off until gate G-P4-L6.'
WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name='context_unlinked_rules_v1');

-- Pure helpers for the new steps.
-- Supplier order numbers in a subject: 6 to 8 digit tokens standing alone
-- (not part of SWP-26195, INV-1234 or a date written with slashes), never a
-- date (DDMMYY, YYYYMMDD, DDMMYYYY) or phone-shaped (starting 04, or 8 digits
-- starting 8 or 9). Sorted and distinct.
CREATE OR REPLACE FUNCTION public.context_supplier_order_tokens(p_subject text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
 SELECT coalesce(array_agg(DISTINCT w ORDER BY w),'{}') FROM regexp_split_to_table(coalesce(p_subject,''),'[^A-Za-z0-9/.-]+') w
 WHERE w ~ '^[0-9]{6,8}$'
  AND w !~ '^04'
  AND w !~ '^[89][0-9]{7}$'
  AND w !~ '^(0[1-9]|[12][0-9]|3[01])(0[1-9]|1[0-2])[0-9]{2}$'
  AND w !~ '^20[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])$'
  AND w !~ '^(0[1-9]|[12][0-9]|3[01])(0[1-9]|1[0-2])20[0-9]{2}$'
$$;
COMMENT ON FUNCTION public.context_supplier_order_tokens(text) IS
 'P4: supplier order numbers in a subject: standalone 6 to 8 digit tokens that are not a date or phone-shaped.';

-- The sender's key for supplier-order bindings: the sender's domain, or the
-- whole address on a free-mail domain; none for our own or platform senders.
CREATE OR REPLACE FUNCTION public.context_sender_key(e public.business_events) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN a IS NULL OR a !~ '^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$' OR public.context_event_sender_kind(e) IN ('ours','platform') THEN NULL
  WHEN split_part(a,'@',2) IN ('gmail.com','googlemail.com','hotmail.com','hotmail.com.au','outlook.com','outlook.com.au','live.com',
   'live.com.au','yahoo.com','yahoo.com.au','bigpond.com','bigpond.net.au','icloud.com','me.com','iinet.net.au','optusnet.com.au',
   'westnet.com.au','tpg.com.au','internode.on.net','aapt.net.au','msn.com','protonmail.com','proton.me') THEN a
  ELSE split_part(a,'@',2) END
 FROM (SELECT lower(btrim(coalesce(substring(r from '<([^<>]*)>'),r))) AS a
  FROM (SELECT nullif(btrim(coalesce(e.payload->>'from',e.payload->>'from_email',e.payload->>'sender','')),'') AS r) raw) k
$$;
COMMENT ON FUNCTION public.context_sender_key(public.business_events) IS
 'P4: sender key for supplier_ref bindings: the sender domain, or the whole address on a free-mail domain; null for our own and platform senders.';

-- An ACCREC invoice on the job was unpaid at p_at: issued on or before that
-- Perth date and not fully paid by then. PAID with no paid date, no issue
-- date, drafts and voided invoices never count (unknown is not unpaid).
CREATE OR REPLACE FUNCTION public.context_job_unpaid_at(p_job_id uuid,p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS (SELECT 1 FROM public.xero_invoices x
  WHERE x.job_id=p_job_id AND x.invoice_type='ACCREC' AND upper(coalesce(x.status,'')) IN ('AUTHORISED','SUBMITTED','PAID')
   AND x.invoice_date IS NOT NULL AND x.invoice_date<=(p_at AT TIME ZONE 'Australia/Perth')::date
   AND CASE WHEN x.fully_paid_on IS NOT NULL THEN x.fully_paid_on>(p_at AT TIME ZONE 'Australia/Perth')::date
    ELSE upper(x.status)<>'PAID' END)
$$;
COMMENT ON FUNCTION public.context_job_unpaid_at(uuid,timestamptz) IS
 'P4: true when an ACCREC invoice on the job was unpaid at p_at (issued on or before that Perth date, not fully paid by it). Unknown dates never count.';

-- 4. P1a's timeline with the message's own keys and the aftercare facts.
-- Members: the contact's own jobs (basis contact), contactless jobs matching
-- the contact's or the message's phone or email (contactless), and jobs of
-- another contact whose client phone or email is the message's own key
-- (key_other_contact). unpaid_at: a terminal job with an ACCREC invoice
-- unpaid at p_at. A job in status invoiced with a completion time is finished
-- at that time (its work is done; only money is outstanding), so aftercare
-- applies to it; P1a's two-argument timeline still reads it as live.
-- Everything else is P1a's rule. Private: read through
-- context_contact_jobs_at and the ladder.
CREATE OR REPLACE FUNCTION public.context_contact_job_timeline(p_contact_id text,p_at timestamptz,p_phone_key text,p_email_key text)
RETURNS TABLE(job_id uuid,job_number text,type text,status text,basis text,created_at timestamptz,
 terminal boolean,terminal_at timestamptz,terminal_time_source text,window_start timestamptz,candidate boolean,unpaid_at boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH own AS (
  SELECT j.id FROM public.jobs j WHERE p_contact_id IS NOT NULL AND j.ghl_contact_id=p_contact_id
  UNION
  SELECT m.job_id FROM public.contact_matches m WHERE p_contact_id IS NOT NULL AND m.job_id IS NOT NULL AND m.ghl_contact_id=p_contact_id
  UNION
  SELECT m.job_id FROM public.contact_matches m WHERE p_contact_id IS NOT NULL AND m.job_id IS NOT NULL AND m.xero_contact_id=p_contact_id
 ), raw_keys AS (
  SELECT j.client_phone AS phone, j.client_email AS email FROM public.jobs j JOIN own o ON o.id=j.id
  UNION ALL
  SELECT to_jsonb(m)->>'phone', to_jsonb(m)->>'email' FROM public.contact_matches m WHERE p_contact_id IS NOT NULL AND m.ghl_contact_id=p_contact_id
 ), keys AS (
  SELECT CASE WHEN length(d)>=8 AND d !~ '^(\d)\1*$' THEN right(d,9) END AS phone_key,
   CASE WHEN position('@' IN em)>1 THEN em END AS email_key
  FROM raw_keys r CROSS JOIN LATERAL (SELECT regexp_replace(coalesce(r.phone,''),'[^0-9]','','g') AS d,
   lower(btrim(coalesce(r.email,''))) AS em) k
  UNION ALL
  SELECT public.context_phone_key(p_phone_key), public.context_email_key(p_email_key)
 ), sib AS (
  SELECT j.id FROM public.jobs j
  WHERE nullif(btrim(j.ghl_contact_id),'') IS NULL AND NOT EXISTS (SELECT 1 FROM own o WHERE o.id=j.id)
   AND EXISTS (SELECT 1 FROM keys WHERE keys.phone_key IS NOT NULL OR keys.email_key IS NOT NULL)
   AND ((nullif(j.client_phone,'') IS NOT NULL
     AND right(regexp_replace(j.client_phone,'[^0-9]','','g'),9) IN (SELECT keys.phone_key FROM keys WHERE keys.phone_key IS NOT NULL))
    OR (nullif(j.client_email,'') IS NOT NULL
     AND lower(btrim(j.client_email)) IN (SELECT keys.email_key FROM keys WHERE keys.email_key IS NOT NULL)))
 ), other AS (
  SELECT j.id FROM public.jobs j
  WHERE nullif(btrim(j.ghl_contact_id),'') IS NOT NULL AND j.ghl_contact_id IS DISTINCT FROM p_contact_id
   AND NOT EXISTS (SELECT 1 FROM own o WHERE o.id=j.id)
   AND ((public.context_phone_key(p_phone_key) IS NOT NULL AND j.client_phone IS NOT NULL
     AND right(regexp_replace(j.client_phone,'[^0-9]','','g'),9)=public.context_phone_key(p_phone_key))
    OR (public.context_email_key(p_email_key) IS NOT NULL AND j.client_email IS NOT NULL
     AND lower(btrim(j.client_email))=public.context_email_key(p_email_key)))
 ), members AS (
  SELECT o.id, 'contact'::text AS basis FROM own o
  UNION ALL
  SELECT s.id, 'contactless'::text FROM sib s
  UNION ALL
  SELECT x.id, 'key_other_contact'::text FROM other x
 ), facts AS (
  SELECT j.id, j.job_number, j.type::text AS type, j.status::text AS status, mb.basis,
   coalesce(j.created_at,'-infinity'::timestamptz) AS created_at,
   (j.status::text IN ('cancelled','archived','lost','closed','complete','completed') OR coalesce(j.archived,false)
    OR (j.status::text='invoiced' AND j.completed_at IS NOT NULL)) AS terminal,
   j.completed_at, j.updated_at, ev.at AS status_event_at
  FROM members mb JOIN public.jobs j ON j.id=mb.id
  LEFT JOIN LATERAL (
   SELECT min(coalesce(be.event_at,be.occurred_at)) AS at FROM public.business_events be
   WHERE (j.status::text IN ('cancelled','archived','lost','closed','complete','completed') OR coalesce(j.archived,false))
    AND be.entity_type='job' AND be.entity_id=j.id::text AND be.event_type='job.status_changed'
    AND lower(be.payload->'changes'->'status'->>'to') IN ('cancelled','archived','lost','closed','complete','completed')
    AND coalesce(be.event_at,be.occurred_at) > coalesce((
     SELECT max(coalesce(nt.event_at,nt.occurred_at)) FROM public.business_events nt
     WHERE nt.entity_type='job' AND nt.entity_id=j.id::text AND nt.event_type='job.status_changed'
      AND lower(nt.payload->'changes'->'status'->>'to') NOT IN ('cancelled','archived','lost','closed','complete','completed')
    ),'-infinity'::timestamptz)
  ) ev ON true
  WHERE coalesce(j.metadata->>'do_not_schedule','') NOT IN ('true','1')
 ), timed AS (
  SELECT f.*,
   CASE WHEN NOT f.terminal THEN NULL
    ELSE coalesce(f.status_event_at,f.completed_at,f.updated_at,'-infinity'::timestamptz) END AS terminal_at,
   CASE WHEN NOT f.terminal THEN NULL WHEN f.status_event_at IS NOT NULL THEN 'status_event'
    WHEN f.completed_at IS NOT NULL THEN 'completed_at' WHEN f.updated_at IS NOT NULL THEN 'updated_at' ELSE 'unknown' END AS terminal_time_source
  FROM facts f
 ), windowed AS (
  SELECT t.*,
   greatest(t.created_at-interval '30 days',
    coalesce((SELECT max(p.terminal_at) FROM timed p WHERE p.id<>t.id AND p.terminal
     AND p.created_at<t.created_at AND p.terminal_at<=t.created_at),'-infinity'::timestamptz)) AS window_start
  FROM timed t
 ), placed AS (
  SELECT w.*,
   CASE WHEN w.created_at<=coalesce(p_at,now()) THEN NOT w.terminal OR w.terminal_at>coalesce(p_at,now())
    ELSE coalesce(p_at,now())>=w.window_start END AS raw_candidate
  FROM windowed w
 )
 SELECT p.id, p.job_number, p.type, p.status, p.basis, p.created_at, p.terminal, p.terminal_at, p.terminal_time_source, p.window_start,
  p.raw_candidate AND (p.status<>'draft' OR NOT EXISTS (SELECT 1 FROM placed live WHERE live.raw_candidate AND live.status<>'draft')),
  p.terminal AND p.terminal_at<=coalesce(p_at,now()) AND public.context_job_unpaid_at(p.id,coalesce(p_at,now()))
 FROM placed p
$$;
COMMENT ON FUNCTION public.context_contact_job_timeline(text,timestamptz,text,text) IS
 'P4: P1a''s job timeline for a contact, plus contactless and other-contact jobs whose client phone or email is the message''s own key (works with a null contact), and whether a finished job had an ACCREC invoice unpaid at p_at. Private; read context_contact_jobs_at.';

-- The candidate set with keys and the aftercare clause (X4, X26): the live
-- candidates at p_at (clause live); only when there is none, the contact's own
-- or contactless jobs that became terminal before p_at with an ACCREC invoice
-- unpaid then (aftercare_unpaid) and, without one, those that became terminal
-- in the 60 days before p_at (aftercare_window). Both are review candidates only.
CREATE OR REPLACE FUNCTION public.context_contact_jobs_at(p_contact_id text,p_at timestamptz,p_phone_key text,p_email_key text)
RETURNS TABLE(job_id uuid,job_number text,type text,status text,basis text,created_at timestamptz,terminal_at timestamptz,terminal_time_source text,clause text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH t AS (SELECT * FROM public.context_contact_job_timeline(p_contact_id,p_at,p_phone_key,p_email_key)),
 live AS (SELECT t.*, 'live'::text AS clause FROM t WHERE t.candidate),
 after AS (
  SELECT t.*, CASE WHEN t.unpaid_at THEN 'aftercare_unpaid' ELSE 'aftercare_window' END AS clause FROM t
  WHERE NOT EXISTS (SELECT 1 FROM live) AND t.basis<>'key_other_contact' AND t.terminal
   AND t.created_at<=coalesce(p_at,now()) AND t.terminal_at<=coalesce(p_at,now())
   AND (t.unpaid_at OR t.terminal_at>=coalesce(p_at,now())-interval '60 days'))
 SELECT x.job_id,x.job_number,x.type,x.status,x.basis,x.created_at,x.terminal_at,x.terminal_time_source,x.clause
 FROM (SELECT * FROM live UNION ALL SELECT * FROM after) x
 ORDER BY x.created_at,x.job_id
$$;
COMMENT ON FUNCTION public.context_contact_jobs_at(text,timestamptz,text,text) IS
 'P4: candidate jobs at p_at for a contact and the message''s own phone and email keys (clause live), or, when none is live, finished jobs with an ACCREC invoice unpaid at p_at (aftercare_unpaid) or finished in the 60 days before (aftercare_window); both review only.';

-- 2a. P1a's ladder, moved verbatim from resolve_context_attribution (live md5
-- fe50f14f...) with one change: in preview it writes no thread binding and
-- reads the existing one instead. Private: runs while the rules are off.
CREATE OR REPLACE FUNCTION public.context_ladder_p1a(e public.business_events,p_preview boolean) RETURNS public.business_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE words text; tokens text; ids uuid[]; candidate uuid; n int; line text; contact_ids text[]; prior_status text; source_method text;
 v_at timestamptz; is_ghl boolean; line_ids uuid[]; guard_ids uuid[]; contactless_ids uuid[]; used_updated_at boolean; rule text;
BEGIN
 prior_status:=e.attribution_status;
 source_method:=e.match_method;
 IF e.job_id IS NOT NULL AND source_method IN ('direct_job_id','direct_reference','manual') THEN
   e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('source_job_binding',jsonb_build_object('job_id',e.job_id,'match_method',source_method));
 ELSIF e.job_id IS NULL AND e.metadata->'source_job_binding'->>'match_method' IN ('direct_job_id','direct_reference','manual') THEN
   SELECT id INTO e.job_id FROM public.jobs WHERE id::text=e.metadata->'source_job_binding'->>'job_id';
   source_method:=e.metadata->'source_job_binding'->>'match_method';
 END IF;
 IF e.job_id IS NOT NULL AND coalesce(source_method,'none') NOT IN ('direct_job_id','direct_reference','manual') THEN
   e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('attribution_hint',jsonb_build_object('job_id',e.job_id,'match_method',source_method,'match_confidence',e.match_confidence));
   e.job_id:=NULL;
 END IF;
 e.attribution_checked_at:=clock_timestamp();
 words:=public.context_event_text(e);
 e.attribution_status:='admin_bucket'; e.attribution_step:=6;
 e.attribution_confidence:=NULL; e.attributed_at:=NULL;
 e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
 e.candidate_job_ids:=NULL;
 IF e.metadata ?| ARRAY['placement_rule','placement_contactless_job_ids','placement_guard_job_ids'] THEN
  e.metadata:=e.metadata-'placement_rule'-'placement_contactless_job_ids'-'placement_guard_job_ids';
 END IF;
 IF e.payload ? 'terminal_time_source' THEN e.payload:=e.payload-'terminal_time_source'; END IF;
 IF NOT public.automation_lane_enabled('attribution') THEN e.job_id:=NULL; RETURN e; END IF;
 IF to_jsonb(e)->>'channel' IN ('system','audit') THEN e.attribution_status:='automated'; RETURN e; END IF;
 IF btrim(words)='' THEN e.attribution_status:='empty'; RETURN e; END IF;
 IF prior_status='automated' OR e.payload->>'automated'='true' OR e.payload->>'auto_submitted' IN ('auto-generated','auto-replied')
 THEN e.attribution_status:='automated'; RETURN e; END IF;
 is_ghl:=public.context_event_is_ghl(e);
 SELECT id INTO candidate FROM public.jobs WHERE id=e.job_id;
 IF candidate IS NULL THEN
   tokens:=' '||upper(regexp_replace(words,'[^a-zA-Z0-9-]+',' ','g'))||' ';
   SELECT array_agg(DISTINCT refs.job_id) INTO ids FROM (
     SELECT j.id AS job_id FROM public.jobs j WHERE length(btrim(j.job_number))>=5
      AND strpos(tokens,' '||upper(j.job_number)||' ')>0
     UNION SELECT x.job_id FROM public.xero_invoices x WHERE x.job_id IS NOT NULL
      AND x.invoice_type='ACCREC' AND upper(x.invoice_number) LIKE 'INV-%' AND length(btrim(x.invoice_number))>=5
      AND strpos(tokens,' '||upper(x.invoice_number)||' ')>0
     UNION SELECT po.job_id FROM public.purchase_orders po WHERE po.job_id IS NOT NULL AND length(btrim(po.po_number))>=5
      AND strpos(tokens,' '||upper(po.po_number)||' ')>0
   ) refs JOIN public.jobs ref_job ON ref_job.id=refs.job_id
   WHERE coalesce(to_jsonb(ref_job)->'metadata'->>'do_not_schedule','') NOT IN ('true','1');
   IF cardinality(ids)=1 THEN candidate:=ids[1];
   ELSIF cardinality(ids)>1 THEN e.job_id:=NULL; RETURN e; END IF;
 END IF;
 IF candidate IS NOT NULL THEN e.attribution_status:='direct'; e.attribution_step:=1;
 ELSE
  IF NOT is_ghl THEN
   SELECT job_id INTO candidate FROM public.event_threads WHERE thread_key=e.thread_key;
  END IF;
  IF candidate IS NOT NULL THEN e.attribution_status:='thread'; e.attribution_step:=2;
  ELSE
   IF e.contact_id IS NULL THEN
    SELECT array_agg(DISTINCT j.ghl_contact_id) INTO contact_ids FROM public.jobs j
    WHERE j.ghl_contact_id IS NOT NULL AND (
      (nullif(e.payload->>'email','') IS NOT NULL AND lower(to_jsonb(j)->>'client_email')=lower(e.payload->>'email')) OR
      (length(regexp_replace(coalesce(e.payload->>'phone',''),'[^0-9]','','g'))>=8 AND
       right(regexp_replace(coalesce(to_jsonb(j)->>'client_phone',to_jsonb(j)->>'phone',''),'[^0-9]','','g'),9)=right(regexp_replace(e.payload->>'phone','[^0-9]','','g'),9)));
    IF cardinality(contact_ids)=1 THEN e.contact_id:=contact_ids[1]; END IF;
   END IF;
   v_at:=coalesce(e.event_at,e.occurred_at,clock_timestamp());
   line:=lower(coalesce(e.payload->>'line',e.payload->>'business_line',''));
   SELECT coalesce(array_agg(t.job_id ORDER BY t.created_at,t.job_id) FILTER (WHERE t.candidate),'{}'),
    coalesce(array_agg(t.job_id ORDER BY t.created_at,t.job_id) FILTER (WHERE t.candidate AND t.type=line AND line IN ('fencing','patio')),'{}'),
    coalesce(array_agg(t.job_id ORDER BY t.terminal_at DESC,t.job_id) FILTER (WHERE NOT t.candidate AND t.terminal
     AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '90 days'),'{}'),
    coalesce(array_agg(t.job_id ORDER BY t.job_id) FILTER (WHERE t.basis='contactless' AND (t.candidate OR (NOT t.candidate AND t.terminal
     AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '90 days'))),'{}'),
    coalesce(bool_or(t.terminal_time_source='updated_at' AND (t.candidate OR (NOT t.candidate AND t.terminal
     AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '90 days'))),false)
   INTO ids,line_ids,guard_ids,contactless_ids,used_updated_at
   FROM public.context_contact_job_timeline(e.contact_id,v_at) t;
   n:=cardinality(ids);
   IF n=1 AND cardinality(guard_ids)=0 THEN
    candidate:=ids[1]; e.attribution_status:='single_open'; e.attribution_step:=3; rule:='single_open';
   ELSIF n=1 THEN
    e.attribution_status:='pending_luna'; e.attribution_step:=5; rule:='review_recent_other_job';
    e.candidate_job_ids:=ids||guard_ids;
   ELSIF n>1 AND cardinality(line_ids)=1 THEN
    candidate:=line_ids[1]; e.attribution_status:='single_line'; e.attribution_step:=4; rule:='single_line';
   ELSIF n>1 THEN
    e.attribution_status:='pending_luna'; e.attribution_step:=5; rule:='review_several';
    e.candidate_job_ids:=ids;
   ELSE
    rule:=CASE WHEN e.contact_id IS NULL THEN 'no_contact' ELSE 'no_candidate_at_time' END;
   END IF;
   e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('placement_rule',rule);
   IF cardinality(contactless_ids)>0 THEN
    e.metadata:=e.metadata||jsonb_build_object('placement_contactless_job_ids',to_jsonb(contactless_ids));
   END IF;
   IF rule='review_recent_other_job' THEN
    e.metadata:=e.metadata||jsonb_build_object('placement_guard_job_ids',to_jsonb(guard_ids));
   END IF;
   IF used_updated_at THEN e.payload:=coalesce(e.payload,'{}'::jsonb)||jsonb_build_object('terminal_time_source','updated_at'); END IF;
  END IF;
 END IF;
 e.job_id:=candidate;
 IF candidate IS NOT NULL THEN
  IF nullif(e.thread_key,'') IS NOT NULL AND NOT is_ghl THEN
   IF NOT p_preview THEN
    INSERT INTO public.event_threads(thread_key,job_id,bound_by,source_event_id) VALUES(e.thread_key,candidate,'ladder',e.id) ON CONFLICT DO NOTHING;
   END IF;
   IF EXISTS (SELECT 1 FROM public.event_threads WHERE thread_key=e.thread_key AND job_id<>candidate) THEN
    e.job_id:=NULL; e.attribution_status:='admin_bucket'; e.attribution_step:=6;
    e.payload:=coalesce(e.payload,'{}')||jsonb_build_object('attribution_error','thread_conflict'); RETURN e;
   END IF;
  END IF;
  e.attribution_confidence:=1; e.attributed_at:=clock_timestamp();
  e.match_status:='matched'; e.match_method:=CASE WHEN e.attribution_status='direct' THEN 'direct_job_id' ELSE 'contact_id' END; e.match_confidence:=1;
 ELSE e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
 END IF;
 RETURN e;
EXCEPTION WHEN OTHERS THEN
 e.job_id:=NULL; e.attribution_status:='admin_bucket'; e.attribution_step:=6;
 e.attribution_confidence:=NULL; e.attributed_at:=NULL; e.candidate_job_ids:=NULL;
 e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
 e.payload:=coalesce(e.payload,'{}')||jsonb_build_object('attribution_error',SQLERRM);
 RETURN e;
END $$;
COMMENT ON FUNCTION public.context_ladder_p1a(public.business_events,boolean) IS
 'P4: P1a''s ladder (live body before P4), run while context_unlinked_rules_v1 is off; in preview it writes no thread binding. Private; call resolve_context_attribution.';

-- 2b. The ladder.
CREATE OR REPLACE FUNCTION public.resolve_context_attribution(e public.business_events,p_preview boolean,p_rules_on boolean)
RETURNS public.business_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 rules_on boolean; words text; subj text; prior_status text; source_method text; writer text;
 v_at timestamptz; is_ghl boolean; v_mode text; ek text; pk text; contact text; n_contacts int; by_key text;
 toks text[]; ref_ids uuid[]; found_toks text[]; unfound text[]; cand uuid; rule text; custody boolean:=false;
 b public.event_threads; sk text; order_toks text[]; tok text; live_ids uuid[]; retired_ids uuid[];
 ids uuid[]; line text; line_ids uuid[]; guard_ids uuid[]; contactless_ids uuid[]; other_ids uuid[]; used_updated_at boolean;
 unpaid_ids uuid[]; window_ids uuid[]; review_ids uuid[]; n int;
 site_text text; exact_keys text[]; loose_keys text[]; exact_ids uuid[]; loose_ids uuid[]; bindings jsonb:='[]'; conflicts jsonb:='[]';
 owned_keys constant text[]:=ARRAY['placement_rule','placement_contactless_job_ids','placement_guard_job_ids','placement_other_contact_job_ids',
  'bucket_reason','ref_not_found','ref_job_ids','identity_conflict','contact_recovered_by','writer_unknown','custody_rescan',
  'placement_site_keys','placement_retired_binding','placement_preview_bindings','supplier_ref_conflicts','aftercare_unpaid_job_ids'];
BEGIN
 rules_on:=coalesce(p_rules_on,public.context_unlinked_rules_enabled());
 p_preview:=coalesce(p_preview,false);
 IF e.metadata ?| owned_keys THEN e.metadata:=e.metadata-owned_keys; END IF;
 IF NOT rules_on THEN
  e:=public.context_ladder_p1a(e,p_preview);
 ELSE
  <<rules>>
  BEGIN
   prior_status:=e.attribution_status;
   source_method:=e.match_method;
   IF e.job_id IS NOT NULL THEN
    IF e.metadata->'source_job_binding'->>'job_id'=e.job_id::text
     AND e.metadata->'source_job_binding'->>'match_method' IN ('direct_job_id','direct_reference','manual') THEN
     source_method:=e.metadata->'source_job_binding'->>'match_method';
    ELSE
     e.metadata:=coalesce(e.metadata,'{}'::jsonb)-'source_job_binding';
     e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('attribution_hint',jsonb_build_object('job_id',e.job_id,'match_method',source_method,'match_confidence',e.match_confidence));
     e.job_id:=NULL;
     source_method:=NULL;
    END IF;
   ELSIF e.metadata->'source_job_binding'->>'match_method' IN ('direct_job_id','direct_reference','manual') THEN
    SELECT id INTO e.job_id FROM public.jobs WHERE id::text=e.metadata->'source_job_binding'->>'job_id';
    IF FOUND THEN source_method:=e.metadata->'source_job_binding'->>'match_method';
    ELSE e.metadata:=e.metadata-'source_job_binding'; source_method:=NULL;
    END IF;
   ELSE
    e.metadata:=coalesce(e.metadata,'{}'::jsonb)-'source_job_binding';
   END IF;
   e.attribution_checked_at:=clock_timestamp();
   words:=public.context_bucket_text(e);
   subj:=coalesce(nullif(btrim(e.payload->>'subject'),''),substring(public.context_event_text(e) from '^Subject: ([^\r\n]*)'));
   e.attribution_status:='admin_bucket'; e.attribution_step:=6;
   e.attribution_confidence:=NULL; e.attributed_at:=NULL;
   e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
   e.candidate_job_ids:=NULL;
   IF e.payload ? 'terminal_time_source' THEN e.payload:=e.payload-'terminal_time_source'; END IF;
   IF NOT public.automation_lane_enabled('attribution') THEN e.job_id:=NULL; EXIT rules; END IF;
   -- 0. Writer check (X16, X36).
   writer:=e.metadata->>'written_as';
   IF writer IS NULL THEN
    e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('writer_unknown',true);
   ELSIF writer<>'service_role' THEN
    IF e.job_id IS NOT NULL THEN
     e.metadata:=e.metadata||jsonb_build_object('attribution_hint',jsonb_build_object('job_id',e.job_id,'match_method',source_method,'match_confidence',e.match_confidence));
     e.job_id:=NULL;
    END IF;
    e.metadata:=e.metadata||jsonb_build_object('bucket_reason','unverified_writer','placement_rule','unverified_writer');
    EXIT rules;
   END IF;
   IF to_jsonb(e)->>'channel' IN ('system','audit') THEN e.attribution_status:='automated'; EXIT rules; END IF;
   IF btrim(words)='' THEN e.attribution_status:='empty'; e.job_id:=NULL; EXIT rules; END IF;
   IF prior_status='automated' OR e.payload->>'automated'='true' OR e.payload->>'auto_submitted' IN ('auto-generated','auto-replied')
   THEN e.attribution_status:='automated'; e.job_id:=NULL; EXIT rules; END IF;
   is_ghl:=public.context_event_is_ghl(e);
   v_at:=coalesce(e.event_at,e.occurred_at,clock_timestamp());
   v_mode:=coalesce(e.metadata->>'capture_mode','live');

   -- 2. Identity: computes the customer's keys and recovers exactly one contact.
   SELECT i.email_key,i.phone_key INTO ek,pk FROM public.context_event_identity(e) i;
   contact:=nullif(btrim(e.contact_id),'');
   IF contact IS NULL AND (ek IS NOT NULL OR pk IS NOT NULL) THEN
    SELECT c.contact_id,c.contacts INTO contact,n_contacts FROM public.context_contact_for_key(ek,pk) c;
    IF n_contacts=1 THEN
     by_key:=CASE WHEN ek IS NOT NULL AND (SELECT c.contacts FROM public.context_contact_for_key(ek,NULL) c)=1 THEN 'email' ELSE 'phone' END;
     e.contact_id:=contact;
     e.metadata:=e.metadata||jsonb_build_object('contact_recovered_by',by_key);
    ELSE
     contact:=NULL;
     IF n_contacts>1 THEN e.metadata:=e.metadata||jsonb_build_object('identity_conflict',n_contacts); END IF;
    END IF;
   END IF;

   -- References, used by custody's re-scan and by step 3.
   toks:=public.context_job_ref_tokens(words);
   IF cardinality(toks)>0 THEN
    SELECT array_agg(DISTINCT r.job_id ORDER BY r.job_id),array_agg(DISTINCT replace(r.token,'-','')) INTO ref_ids,found_toks FROM public.context_ref_jobs(toks) r;
    SELECT array_agg(t ORDER BY t) INTO unfound FROM unnest(toks) t
    WHERE t ~ '^SW[A-Z]{0,4}-?[0-9]{4,}' AND NOT (replace(t,'-','')=ANY(coalesce(found_toks,'{}')))
     AND NOT EXISTS (SELECT 1 FROM unnest(toks) t2 WHERE t2<>t AND replace(t2,'-','')=replace(t,'-','') AND replace(t2,'-','')=ANY(coalesce(found_toks,'{}')));
    IF cardinality(unfound)>0 THEN e.metadata:=e.metadata||jsonb_build_object('ref_not_found',to_jsonb(unfound)); END IF;
   END IF;

   -- 1. Custody. monitor-inbox's first-match binding is re-scanned (Review B1).
   IF e.job_id IS NOT NULL THEN
    custody:=true;
    IF source_method='direct_reference' AND e.source IN ('monitor-inbox','monitor-inbox-group','monitor_inbox') AND cardinality(ref_ids)>=1 THEN
     IF cardinality(ref_ids) BETWEEN 2 AND 5 THEN
      e.metadata:=e.metadata||jsonb_build_object('custody_rescan',jsonb_build_object('writer_job_id',e.job_id,'jobs',cardinality(ref_ids)),'placement_rule','multi_ref');
      e.job_id:=NULL; e.attribution_status:='unplaced'; e.attribution_step:=1; e.candidate_job_ids:=ref_ids;
      EXIT rules;
     ELSIF cardinality(ref_ids)>5 THEN
      e.metadata:=e.metadata||jsonb_build_object('custody_rescan',jsonb_build_object('writer_job_id',e.job_id,'jobs',cardinality(ref_ids)),
       'placement_rule','multi_ref_many','bucket_reason','multi_ref_many','ref_job_ids',to_jsonb(ref_ids));
      e.job_id:=NULL;
      EXIT rules;
     ELSIF ref_ids[1]<>e.job_id THEN
      e.metadata:=e.metadata||jsonb_build_object('custody_rescan',jsonb_build_object('writer_job_id',e.job_id,'jobs',1));
      e.job_id:=ref_ids[1]; custody:=false; rule:='direct_ref';
     END IF;
    END IF;
    cand:=e.job_id; e.attribution_status:='direct'; e.attribution_step:=1; rule:=coalesce(rule,'custody');
   END IF;

   -- 3. References.
   IF cand IS NULL THEN
    IF cardinality(ref_ids)=1 THEN
     cand:=ref_ids[1]; e.attribution_status:='direct'; e.attribution_step:=1; rule:='direct_ref';
    ELSIF cardinality(ref_ids) BETWEEN 2 AND 5 THEN
     e.attribution_status:='unplaced'; e.attribution_step:=1; e.candidate_job_ids:=ref_ids;
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','multi_ref');
     EXIT rules;
    ELSIF cardinality(ref_ids)>5 THEN
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','multi_ref_many','bucket_reason','multi_ref_many','ref_job_ids',to_jsonb(ref_ids));
     EXIT rules;
    END IF;
   END IF;

   -- Candidates of a known contact (with the message's keys), for the thread
   -- check and step 5.
   IF cand IS NULL THEN
    line:=lower(coalesce(e.payload->>'line',e.payload->>'business_line',''));
    SELECT coalesce(array_agg(t.job_id ORDER BY t.created_at,t.job_id) FILTER (WHERE t.candidate),'{}'),
     coalesce(array_agg(t.job_id ORDER BY t.created_at,t.job_id) FILTER (WHERE t.candidate AND t.type=line AND line IN ('fencing','patio')),'{}'),
     coalesce(array_agg(t.job_id ORDER BY t.terminal_at DESC,t.job_id) FILTER (WHERE NOT t.candidate AND t.terminal
      AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '90 days'),'{}'),
     coalesce(array_agg(t.job_id ORDER BY t.job_id) FILTER (WHERE t.basis='contactless' AND (t.candidate OR (NOT t.candidate AND t.terminal
      AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '90 days'))),'{}'),
     coalesce(array_agg(t.job_id ORDER BY t.job_id) FILTER (WHERE t.basis='key_other_contact' AND t.candidate),'{}'),
     coalesce(bool_or(t.terminal_time_source='updated_at' AND (t.candidate OR (NOT t.candidate AND t.terminal
      AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '90 days'))),false),
     -- Aftercare reads only the customer's own and contactless jobs, never
     -- another contact's job found by a shared phone or email.
     coalesce(array_agg(t.job_id ORDER BY t.terminal_at DESC,t.job_id) FILTER (WHERE t.basis<>'key_other_contact' AND t.terminal AND t.unpaid_at
      AND t.created_at<=v_at),'{}'),
     coalesce(array_agg(t.job_id ORDER BY t.terminal_at DESC,t.job_id) FILTER (WHERE t.basis<>'key_other_contact' AND t.terminal AND NOT t.unpaid_at
      AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '60 days'),'{}')
    INTO ids,line_ids,guard_ids,contactless_ids,other_ids,used_updated_at,unpaid_ids,window_ids
    FROM public.context_contact_job_timeline(contact,v_at,pk,ek) t;
   END IF;

   -- 4. Thread: a live binding; with a known contact, only one of its jobs.
   IF cand IS NULL AND NOT is_ghl AND nullif(e.thread_key,'') IS NOT NULL THEN
    SELECT * INTO b FROM public.event_threads WHERE thread_key=e.thread_key;
    IF FOUND AND b.retired_at IS NOT NULL THEN
     e.attribution_status:='unplaced'; e.attribution_step:=2;
     e.candidate_job_ids:=ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[b.job_id,b.retired_conflict_job_id]) x WHERE x IS NOT NULL ORDER BY x);
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','thread_retired','placement_retired_binding',e.thread_key);
     EXIT rules;
    ELSIF FOUND AND (contact IS NULL OR b.job_id=ANY(ids||unpaid_ids||window_ids)) THEN
     cand:=b.job_id; e.attribution_status:='thread'; e.attribution_step:=2; rule:='thread';
    END IF;
   END IF;

   -- Supplier order numbers, only with no customer identity.
   IF cand IS NULL AND contact IS NULL AND ek IS NULL AND pk IS NULL THEN
    sk:=public.context_sender_key(e);
    order_toks:=public.context_supplier_order_tokens(subj);
    IF sk IS NOT NULL AND cardinality(order_toks)>0 THEN
     SELECT coalesce(array_agg(DISTINCT t.job_id) FILTER (WHERE t.retired_at IS NULL),'{}'),
      coalesce(array_agg(DISTINCT x) FILTER (WHERE t.retired_at IS NOT NULL AND x IS NOT NULL),'{}')
     INTO live_ids,retired_ids
     FROM public.event_threads t LEFT JOIN LATERAL unnest(ARRAY[t.job_id,t.retired_conflict_job_id]) x ON true
     WHERE t.thread_key IN (SELECT 'supplier_ref:'||sk||':'||o FROM unnest(order_toks) o);
     IF cardinality(retired_ids)>0 THEN
      e.attribution_status:='unplaced'; e.attribution_step:=2;
      e.candidate_job_ids:=ARRAY(SELECT DISTINCT x FROM unnest(retired_ids||live_ids) x ORDER BY x);
      e.metadata:=e.metadata||jsonb_build_object('placement_rule','supplier_order_retired');
      EXIT rules;
     ELSIF cardinality(live_ids)=1 THEN
      cand:=live_ids[1]; e.attribution_status:='thread'; e.attribution_step:=2; rule:='supplier_order_ref';
     ELSIF cardinality(live_ids)>1 THEN
      e.attribution_status:='unplaced'; e.attribution_step:=2;
      e.candidate_job_ids:=ARRAY(SELECT x FROM unnest(live_ids) x ORDER BY x);
      e.metadata:=e.metadata||jsonb_build_object('placement_rule','supplier_order_several');
      EXIT rules;
     END IF;
    END IF;
   END IF;

   -- 5. Contact rules, with the message's keys and the aftercare clause.
   IF cand IS NULL THEN
    n:=cardinality(ids);
    review_ids:=NULL;
    IF n=1 AND cardinality(guard_ids)=0 THEN
     cand:=ids[1]; e.attribution_status:='single_open'; e.attribution_step:=3;
     rule:=CASE WHEN e.metadata ? 'contact_recovered_by' THEN 'identity_'||(e.metadata->>'contact_recovered_by')
      WHEN contact IS NULL AND ek IS NOT NULL THEN 'identity_email' WHEN contact IS NULL THEN 'identity_phone' ELSE 'single_open' END;
    ELSIF n=1 THEN
     rule:='review_recent_other_job'; review_ids:=ids||guard_ids;
     e.metadata:=e.metadata||jsonb_build_object('placement_guard_job_ids',to_jsonb(guard_ids));
    ELSIF n>1 AND cardinality(line_ids)=1 THEN
     cand:=line_ids[1]; e.attribution_status:='single_line'; e.attribution_step:=4; rule:='single_line';
    ELSIF n>1 THEN
     rule:='review_several'; review_ids:=ids;
    ELSIF cardinality(unpaid_ids)+cardinality(window_ids)>0 THEN
     -- Aftercare never places directly (decision on N7 and N17, 24 Sep): an
     -- unpaid invoice cannot tell a final-payment question from a new
     -- enquiry, only the words can, so the finished jobs go to review with the
     -- unpaid ones named.
     rule:='review_aftercare'; review_ids:=unpaid_ids||window_ids;
     IF cardinality(unpaid_ids)>0 THEN
      e.metadata:=e.metadata||jsonb_build_object('aftercare_unpaid_job_ids',to_jsonb(unpaid_ids));
     END IF;
    END IF;
    IF review_ids IS NOT NULL THEN
     -- Rows loaded as history or re-links never go to the model (X27).
     e.attribution_status:=CASE WHEN v_mode IN ('backfill','relink') THEN 'unplaced' ELSE 'pending_luna' END;
     e.attribution_step:=5; e.candidate_job_ids:=review_ids;
    END IF;
    IF rule IS NOT NULL THEN
     IF cardinality(contactless_ids)>0 THEN e.metadata:=e.metadata||jsonb_build_object('placement_contactless_job_ids',to_jsonb(contactless_ids)); END IF;
     IF cardinality(other_ids)>0 THEN e.metadata:=e.metadata||jsonb_build_object('placement_other_contact_job_ids',to_jsonb(other_ids)); END IF;
     IF used_updated_at THEN e.payload:=coalesce(e.payload,'{}'::jsonb)||jsonb_build_object('terminal_time_source','updated_at'); END IF;
    END IF;
    IF review_ids IS NOT NULL THEN
     e.metadata:=e.metadata||jsonb_build_object('placement_rule',rule);
     EXIT rules;
    END IF;
   END IF;

   -- 6. Site address, only with no contact (council, certifier, our own mail,
   -- a sender we cannot identify) and no identity conflict.
   IF cand IS NULL AND contact IS NULL AND NOT (e.metadata ? 'identity_conflict') THEN
    site_text:=coalesce(subj||E'\n','')||left(public.context_event_text(e),1500);
    SELECT array_agg(DISTINCT m.address_key) FILTER (WHERE m.address_key IS NOT NULL AND NOT m.slash_form),
     array_agg(DISTINCT lk) INTO exact_keys,loose_keys
    FROM public.context_address_mentions(site_text) m LEFT JOIN LATERAL unnest(m.loose_keys) lk ON true;
    IF cardinality(loose_keys)>0 THEN
     WITH near AS (
      SELECT j.id, public.context_address_key(j.site_address) AS k, public.context_address_loose_keys(j.site_address) AS lk
      FROM public.jobs j
      WHERE j.site_address IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(loose_keys) l WHERE strpos(lower(j.site_address),substring(l from ' (.*)$'))>0)
       AND coalesce(j.metadata->>'do_not_schedule','') NOT IN ('true','1')
       AND coalesce(j.created_at,'-infinity'::timestamptz)<=v_at
       AND (NOT (j.status::text IN ('cancelled','archived','lost','closed','complete','completed') OR coalesce(j.archived,false)
         OR (j.status::text='invoiced' AND j.completed_at IS NOT NULL))
        OR coalesce(j.completed_at,j.updated_at,'-infinity'::timestamptz)>=v_at-interval '60 days'))
     SELECT array_agg(DISTINCT n.id ORDER BY n.id) FILTER (WHERE n.k=ANY(coalesce(exact_keys,'{}'))),
      array_agg(DISTINCT n.id ORDER BY n.id) FILTER (WHERE n.lk && loose_keys)
     INTO exact_ids,loose_ids FROM near n;
     e.metadata:=e.metadata||jsonb_build_object('placement_site_keys',jsonb_build_object('exact',cardinality(exact_keys),'loose',cardinality(loose_keys)));
     IF cardinality(exact_ids)=1 THEN
      cand:=exact_ids[1]; e.attribution_status:='content_ref'; e.attribution_step:=6; rule:='site_address';
     ELSIF cardinality(exact_ids) BETWEEN 2 AND 3 THEN
      e.attribution_status:='unplaced'; e.attribution_step:=6; e.candidate_job_ids:=exact_ids;
      e.metadata:=e.metadata||jsonb_build_object('placement_rule','site_address_several');
      EXIT rules;
     ELSIF cardinality(exact_ids)>3 THEN
      e.metadata:=e.metadata||jsonb_build_object('placement_rule','site_address_many','bucket_reason','no_identity_site');
      EXIT rules;
     ELSIF cardinality(loose_ids) BETWEEN 1 AND 3 THEN
      e.attribution_status:='unplaced'; e.attribution_step:=6; e.candidate_job_ids:=loose_ids;
      e.metadata:=e.metadata||jsonb_build_object('placement_rule','site_address_loose');
      EXIT rules;
     ELSIF cardinality(loose_ids)>3 THEN
      e.metadata:=e.metadata||jsonb_build_object('placement_rule','site_address_many','bucket_reason','no_identity_site');
      EXIT rules;
     END IF;
    END IF;
   END IF;

   -- 7. Nothing proved a job.
   IF cand IS NULL THEN
    e.metadata:=e.metadata||jsonb_build_object('placement_rule',CASE WHEN contact IS NULL THEN 'no_contact' ELSE 'no_candidate_at_time' END);
    EXIT rules;
   END IF;

   -- Placed. Bindings from proven placements only (X25).
   e.job_id:=cand;
   IF e.attribution_status IN ('direct','content_ref') AND nullif(e.thread_key,'') IS NOT NULL AND NOT is_ghl THEN
    SELECT * INTO b FROM public.event_threads WHERE thread_key=e.thread_key;
    IF NOT FOUND THEN
     IF p_preview THEN bindings:=bindings||jsonb_build_array(jsonb_build_object('key',e.thread_key,'job_id',cand));
     ELSE INSERT INTO public.event_threads(thread_key,job_id,bound_by,source_event_id) VALUES(e.thread_key,cand,'ladder',e.id) ON CONFLICT DO NOTHING;
     END IF;
    ELSIF e.attribution_status='content_ref' AND b.retired_at IS NULL AND b.job_id<>cand THEN
     -- A content reference disagreeing with a live binding: neither is proof.
     IF NOT p_preview THEN
      UPDATE public.event_threads SET retired_at=clock_timestamp(),retired_reason='conflict',retired_conflict_job_id=cand
      WHERE thread_key=e.thread_key AND retired_at IS NULL;
     END IF;
     e.job_id:=NULL; e.attribution_status:='unplaced'; e.attribution_step:=6;
     e.candidate_job_ids:=ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[b.job_id,cand]) x ORDER BY x);
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','thread_retired','placement_retired_binding',e.thread_key);
     cand:=NULL;
     EXIT rules;
    END IF;
   END IF;
   IF e.attribution_status='direct' AND contact IS NULL AND ek IS NULL AND pk IS NULL THEN
    sk:=public.context_sender_key(e);
    order_toks:=public.context_supplier_order_tokens(subj);
    IF sk IS NOT NULL AND cardinality(order_toks) BETWEEN 1 AND 2 THEN
     FOREACH tok IN ARRAY order_toks LOOP
      SELECT * INTO b FROM public.event_threads WHERE thread_key='supplier_ref:'||sk||':'||tok;
      IF NOT FOUND THEN
       IF p_preview THEN
        bindings:=bindings||jsonb_build_array(jsonb_build_object('key','supplier_ref:'||sk||':'||tok,'job_id',cand));
       ELSE
        INSERT INTO public.event_threads(thread_key,job_id,bound_by,source_event_id) VALUES('supplier_ref:'||sk||':'||tok,cand,'ladder',e.id) ON CONFLICT DO NOTHING;
        SELECT * INTO b FROM public.event_threads WHERE thread_key='supplier_ref:'||sk||':'||tok;
       END IF;
      END IF;
      IF NOT p_preview AND FOUND AND b.retired_at IS NULL AND b.job_id<>cand THEN
       -- The same order number named for two jobs: retire it (Review M3).
       UPDATE public.event_threads SET retired_at=clock_timestamp(),retired_reason='conflict',retired_conflict_job_id=cand
       WHERE thread_key='supplier_ref:'||sk||':'||tok AND retired_at IS NULL;
       conflicts:=conflicts||to_jsonb('supplier_ref:'||sk||':'||tok);
      END IF;
     END LOOP;
    END IF;
   END IF;
   IF jsonb_array_length(conflicts)>0 THEN e.metadata:=e.metadata||jsonb_build_object('supplier_ref_conflicts',conflicts); END IF;
   IF p_preview AND jsonb_array_length(bindings)>0 THEN e.metadata:=e.metadata||jsonb_build_object('placement_preview_bindings',bindings); END IF;
   e.metadata:=e.metadata||jsonb_build_object('placement_rule',rule);
   e.attribution_confidence:=1; e.attributed_at:=clock_timestamp();
   e.match_status:='matched'; e.match_confidence:=1;
   e.match_method:=CASE WHEN custody THEN source_method WHEN rule='direct_ref' THEN 'ladder_ref'
    WHEN e.attribution_status='content_ref' THEN 'content_ref' ELSE 'contact_id' END;
  EXCEPTION WHEN OTHERS THEN
   e.job_id:=NULL; e.attribution_status:='admin_bucket'; e.attribution_step:=6;
   e.attribution_confidence:=NULL; e.attributed_at:=NULL; e.candidate_job_ids:=NULL;
   e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
   e.payload:=coalesce(e.payload,'{}')||jsonb_build_object('attribution_error',SQLERRM);
  END;
  IF e.job_id IS NULL AND e.attribution_status NOT IN ('direct','thread','single_open','single_line','luna','content_ref','party') THEN
   e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
   e.attribution_confidence:=NULL; e.attributed_at:=NULL;
  END IF;
 END IF;
 -- Always: why a bucket row is unlinked (metadata only, never a placement).
 IF e.attribution_status='admin_bucket' AND NOT (coalesce(e.metadata,'{}'::jsonb) ? 'bucket_reason') THEN
  e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('bucket_reason',public.context_bucket_reason(e));
 END IF;
 RETURN e;
END $$;
COMMENT ON FUNCTION public.resolve_context_attribution(public.business_events,boolean,boolean) IS
 'P4: the ladder. Rules off (flag context_unlinked_rules_v1 off): P1a''s ladder. Rules on: writer check, custody with monitor-inbox re-scan, identity (payload.from read), references (multi_ref unplaced), live thread and supplier order bindings, contact rules with keys and aftercare, exact or loose site address, bucket. Always stamps metadata.bucket_reason on a bucket row. p_preview writes nothing. p_rules_on null reads the flag.';

-- 3. The entry every caller uses.
CREATE OR REPLACE FUNCTION public.resolve_context_attribution(e public.business_events) RETURNS public.business_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 RETURN public.resolve_context_attribution(e,false,NULL);
END $$;
COMMENT ON FUNCTION public.resolve_context_attribution(public.business_events) IS
 'P4: the ladder entry (insert trigger, bucket re-run, reconsideration): resolve_context_attribution(e, no preview, the flag''s state).';

-- 5. What the ladder would decide for a stored row. Writes nothing.
CREATE OR REPLACE FUNCTION public.context_attribution_preview(p_event_id uuid,p_rules_on boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.business_events; r public.business_events; rules_on boolean;
BEGIN
 SELECT * INTO e FROM public.business_events WHERE id=p_event_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','event_id',p_event_id); END IF;
 rules_on:=coalesce(p_rules_on,public.context_unlinked_rules_enabled());
 r:=public.resolve_context_attribution(e,true,rules_on);
 RETURN jsonb_build_object('outcome','decided','event_id',e.id,'rules_on',rules_on,'flag_on',public.context_unlinked_rules_enabled(),
  'stored',jsonb_build_object('attribution_status',e.attribution_status,'attribution_step',e.attribution_step,'job_id',e.job_id,
   'job_number',(SELECT j.job_number FROM public.jobs j WHERE j.id=e.job_id),'placement_rule',e.metadata->>'placement_rule',
   'candidate_job_ids',to_jsonb(e.candidate_job_ids)),
  'decided',jsonb_build_object('attribution_status',r.attribution_status,'attribution_step',r.attribution_step,'job_id',r.job_id,
   'job_number',(SELECT j.job_number FROM public.jobs j WHERE j.id=r.job_id),'placement_rule',r.metadata->>'placement_rule',
   'bucket_reason',r.metadata->>'bucket_reason','match_method',r.match_method,'contact_id',r.contact_id,
   'contact_recovered_by',r.metadata->>'contact_recovered_by','identity_conflict',r.metadata->'identity_conflict',
   'candidate_job_ids',to_jsonb(r.candidate_job_ids),
   'candidate_job_numbers',(SELECT jsonb_agg(j.job_number ORDER BY j.job_number) FROM public.jobs j WHERE j.id=ANY(coalesce(r.candidate_job_ids,'{}'))),
   'ref_not_found',r.metadata->'ref_not_found','aftercare_unpaid_job_ids',r.metadata->'aftercare_unpaid_job_ids','custody_rescan',r.metadata->'custody_rescan','writer_unknown',r.metadata->'writer_unknown',
   'would_bind',coalesce(r.metadata->'placement_preview_bindings','[]'::jsonb),'supplier_ref_conflicts',r.metadata->'supplier_ref_conflicts',
   'attribution_error',r.payload->>'attribution_error'));
END $$;
COMMENT ON FUNCTION public.context_attribution_preview(uuid,boolean) IS
 'P4: what the ladder would decide for a stored business_events row, rules forced on (true) or off (false), or the flag''s state (null): status, step, job, rule, reason, candidates, bindings it would write. Writes nothing. Service role only.';

-- 6. The insert trigger: written_as recorded before the ladder (so the writer
-- check reads the request role) and again after (so nothing the writer sent
-- or the ladder did can change it).
CREATE OR REPLACE FUNCTION public.attribute_business_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE request_role text;
BEGIN
  IF NEW.context_captured_at IS NULL THEN
    NEW.context_captured_at := clock_timestamp();
  END IF;
  request_role:=public.context_request_role();
  NEW.metadata:=coalesce(NEW.metadata,'{}'::jsonb)-'source_job_binding';
  IF request_role='service_role' AND NEW.job_id IS NOT NULL AND NEW.match_method IN ('direct_job_id','direct_reference','manual') THEN
    NEW.metadata:=NEW.metadata||jsonb_build_object('source_job_binding',jsonb_build_object('job_id',NEW.job_id,'match_method',NEW.match_method));
  END IF;
  NEW.metadata := NEW.metadata || jsonb_build_object('written_as', request_role);
  NEW := public.resolve_context_attribution(NEW);
  NEW.metadata := coalesce(NEW.metadata, '{}'::jsonb) || jsonb_build_object('written_as', request_role);
  RETURN NEW;
END $$;

-- Grants: nothing reachable by the public key or a signed-in login. The
-- ladder's parts and the pure helpers are private; the preview and the keyed
-- candidate set are for the service role.
REVOKE ALL ON FUNCTION
 public.context_unlinked_rules_enabled(),
 public.context_supplier_order_tokens(text),
 public.context_sender_key(public.business_events),
 public.context_job_unpaid_at(uuid,timestamptz),
 public.context_contact_job_timeline(text,timestamptz,text,text),
 public.context_contact_jobs_at(text,timestamptz,text,text),
 public.context_ladder_p1a(public.business_events,boolean),
 public.resolve_context_attribution(public.business_events,boolean,boolean),
 public.resolve_context_attribution(public.business_events),
 public.context_attribution_preview(uuid,boolean),
 public.attribute_business_event()
FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION
 public.context_supplier_order_tokens(text),
 public.context_sender_key(public.business_events),
 public.context_job_unpaid_at(uuid,timestamptz),
 public.context_contact_job_timeline(text,timestamptz,text,text),
 public.context_ladder_p1a(public.business_events,boolean),
 public.resolve_context_attribution(public.business_events,boolean,boolean)
FROM service_role;
-- Restate the live ACL of the two replaced objects (postgres and service_role).
GRANT EXECUTE ON FUNCTION public.resolve_context_attribution(public.business_events),public.attribute_business_event() TO service_role;
GRANT EXECUTE ON FUNCTION
 public.context_unlinked_rules_enabled(),
 public.context_contact_jobs_at(text,timestamptz,text,text),
 public.context_attribution_preview(uuid,boolean)
TO service_role;
