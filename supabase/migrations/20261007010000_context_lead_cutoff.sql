-- Lead cutoff (7 Oct 2026): a lead with no progress is followed up for 4 weeks after the newer of
-- its newest quote send and the customer's newest message on the job, and then no longer, until it
-- progresses or the customer writes again.
--
-- The owner's ruling, 7 Oct 2026: leads with no progress stop being monitored 28 days after the
-- newer of the newest quote send and the customer's newest inbound message (364 drop out and 498
-- live jobs stay monitored, by the count the ruling was made on).
--
-- Why. On 7 Oct 2026 (read only on production, 13:07 Perth) 862 jobs were live and 452 of them
-- at quoted: 423 leads (a quote sent, no progress), 15 with no quote sent, 14 with progress (13 a
-- customer invoice, 1 an accepted quote). 366 of the leads had neither a quote send nor a text,
-- email or call of the customer's on the job in the 28 days before, so 366 drop out and 496 stay
-- monitored; 57 leads are inside their 4 weeks. (The owner's 364 and 498 were read earlier that
-- morning: SWF-261325 crossed the line at 08:18 Perth, SWF-261384 at 10:08 and SWF-261388 at
-- 11:00.) The story told each quote still waiting as the customer's move, and the ledger reader
-- would read each of them.
--
-- The rule, once: context_lead_monitored_jobs(job ids, as_of), one row per job (every live job when
-- the ids are null), and context_lead_monitored(job, as_of), its boolean. A job is monitored unless
-- it is a lead whose 28 days have run out: still at quoted (jobs.status), a quote sent by as_of (the
-- newest job_documents type quote sent_at, else jobs.quoted_at), no progress by as_of (no accepted
-- quote: the job row's accepted_at or a quote document's; no customer invoice that is not voided or
-- deleted; no crew booking that stands, never a ghost or observer copy; no later status), and as_of
-- at or past cutoff_at, 28 days (672 hours) after the newer of that quote send and the customer's
-- newest inbound text, email or call on the job (context_job_record_messages, as the story reads
-- them: the customer's side only, placed on the job, old-inbox mail on the job among them). It comes
-- back the moment it progresses or the customer writes on the job; a quote never sent starts no
-- clock. Nothing is written: no row, flag, cron job or setting changes.
--
-- Where it is used:
--  the story: R7 (quote waiting) on a lead no longer followed up ends "Lead not followed up since
--   <day>: 4 weeks after the last quote or message with no progress" (context_job_record_loops);
--   the story read passes the rule's row to the assembler as record lead (context_job_story); the
--   first line then says "Lead not followed up since <day>: 4 weeks after the last quote or message
--   with no progress" in place of whose move (with the item still open on it, unless that is the
--   quote waiting on the customer), never that it is the customer's move: whose_move
--   not_followed_up, now.monitored false, now.not_followed_up_since its day
--   (context_job_story_assemble);
--  the ledger: context_ledger_judge blocks such a lead (lead_not_monitored), so context_ledger_due
--   never lists it and a claim answers not_due; its evidence is not read in full for the judgement.
--
-- Not changed: the scorecard (context_scorecard, context_scorecard_jobs and the story scorecard
-- are untouched; the scorecard v2 reads this rule); placement; the retired fact reader; every other
-- story and ledger body, context_ledger_due among them (it lists only what the judge finds due).
-- Every signature, volatility, owner and grant stays, and each comment keeps its slice names first.
--
-- Replaced bodies (guarded on the md5 each has once 20261006040000 applies, read from a local
-- cluster on PR 978's head 293de0dd, or this migration's own: a re-apply is a no-op):
--  context_job_record_loops, context_job_story_assemble, context_ledger_judge (20261006040000);
--  context_job_story (20261006014000, as production has it).
-- Added: context_lead_monitored_jobs and context_lead_monitored (plain SQL with no SET; they read
--  the jobs, their quote documents, customer invoices and bookings by job, and the leads'
--  messages through context_job_record_messages). Service role only.
-- Rollback: supabase/rollbacks/20261007010000_context_lead_cutoff_down.sql (the four earlier
--  bodies word for word, and the two functions dropped).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Guard. Each body replaced here must be the one the stack has once 20261006040000 applies (md5
-- of prosrc) or this migration's own; anything else is someone else's change and is refused, never
-- overwritten. The rule's two functions must be absent or this migration's, and every function,
-- table and column the new bodies read must exist.
DO $guard$
DECLARE problems text[] := '{}'; x record; live text; f text; t text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_job_record_loops(uuid[],timestamptz)', ARRAY['21eef050dc79da65d01afc0d8325a38d', '20a71890d22417eef77dff240b42c07a']),
  ('public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)', ARRAY['8557a596bc5628f9823d398b54decdc3', '6ea32b33b81609c3c5838fd39cbfc129']),
  ('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)', ARRAY['7b65d10aac4a4f898c71861707346690', 'dfb75955f326b6d3d71de2212ecc7a06']),
  ('public.context_ledger_judge(uuid[])', ARRAY['112cce8cf65ef4086483ee069ee294a5', '469c25208e17970e0912a41f6ea655a4'])
 ) v(sig, accepted) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY (x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_lead_monitored_jobs(uuid[],timestamptz)', 'public.context_lead_monitored(uuid,timestamptz)'] LOOP
  IF to_regprocedure(f) IS NOT NULL AND coalesce(obj_description(to_regprocedure(f), 'pg_proc'), '') NOT LIKE 'Lead cutoff (20261007010000)%' THEN
   problems := problems || format('%s exists and is not this migration''s', f);
  END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_job_record_messages(uuid[],timestamptz)', 'public.context_job_story_day(date,date)',
   'public.context_job_record_timeline(uuid[],timestamptz)', 'public.context_job_record_money(uuid[],timestamptz)',
   'public.context_job_record_contact(uuid[],timestamptz)', 'public.context_job_story_facts(uuid,timestamptz)',
   'public.context_job_story_ledger(uuid,uuid,timestamptz)', 'public.context_job_story_meta(uuid,timestamptz)',
   'public.context_job_record_value(uuid[],timestamptz)', 'public.context_ledger_evidence_rows(uuid[],timestamptz)',
   'public.context_ledger_mail_copies(uuid[])', 'public.context_ledger_failures(uuid[])', 'public.context_ledger_due(integer)'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['jobs.status', 'jobs.quoted_at', 'jobs.accepted_at', 'jobs.job_number', 'job_documents.job_id',
   'job_documents.type', 'job_documents.sent_at', 'job_documents.accepted_at', 'xero_invoices.job_id', 'xero_invoices.invoice_type',
   'xero_invoices.status', 'xero_invoices.created_at', 'xero_invoices.synced_at', 'job_assignments.job_id', 'job_assignments.created_at',
   'job_assignments.status', 'job_assignments.is_ghost', 'job_assignments.role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || split_part(t, '.', 1))
                 AND a.attname = split_part(t, '.', 2) AND NOT a.attisdropped) THEN
   problems := problems || format('public.%s missing', t);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_lead_cutoff_preimage_mismatch: %; read the live definitions before replacing them',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The rule, once: one row per job asked for, or per live job when the ids are null. Plain SQL
-- with no SET; each job's quote documents, customer invoices and bookings are read by its job, and
-- only the leads' messages are read.
CREATE OR REPLACE FUNCTION public.context_lead_monitored_jobs(p_job_ids uuid[] DEFAULT NULL, p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, job_number text, monitored boolean, state text, quote_sent_at timestamptz, customer_at timestamptz,
 cutoff_at timestamptz)
LANGUAGE sql STABLE
AS $fn$
 WITH k AS (SELECT coalesce(p_as_of, now()) AS t),
 ids AS (  -- the jobs asked for (each once), else every live job
  SELECT jb.id FROM public.jobs jb WHERE jb.id = ANY (p_job_ids)
  UNION ALL
  SELECT jb.id FROM public.jobs jb
  WHERE p_job_ids IS NULL AND jb.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
 ),
 j AS (
  SELECT jb.id, jb.job_number, jb.status::text AS status, k.t,
         -- the newest quote send by the instant: a quote document's send, else the job row's quoted stamp
         coalesce((SELECT max(d.sent_at) FROM public.job_documents d WHERE d.job_id = jb.id AND d.type = 'quote' AND d.sent_at <= k.t),
                  CASE WHEN jb.quoted_at <= k.t THEN jb.quoted_at END) AS sent_at,
         -- progress by the instant: an accepted quote (the job row's acceptance, or a quote document's)...
         (coalesce(jb.accepted_at <= k.t, false)
          OR EXISTS (SELECT 1 FROM public.job_documents d WHERE d.job_id = jb.id AND d.type = 'quote' AND d.accepted_at <= k.t)) AS accepted,
         -- ...a customer invoice that is not voided or deleted (a draft, a deposit paid or not)...
         EXISTS (SELECT 1 FROM public.xero_invoices x
                 WHERE x.job_id = jb.id AND upper(coalesce(x.invoice_type, 'ACCREC')) = 'ACCREC'
                   AND upper(coalesce(x.status, '')) NOT IN ('VOIDED', 'DELETED')
                   AND coalesce(x.created_at, x.synced_at, '-infinity'::timestamptz) <= k.t) AS invoiced,
         -- ...or a crew booking that stands (never cancelled or deleted, never a ghost or observer copy)
         EXISTS (SELECT 1 FROM public.job_assignments a
                 WHERE a.job_id = jb.id AND a.created_at <= k.t AND lower(coalesce(a.status, 'none')) NOT IN ('cancelled', 'deleted')
                   AND NOT (coalesce(a.is_ghost, false) OR coalesce(a.role, '') = 'observer')) AS booked
  FROM ids JOIN public.jobs jb ON jb.id = ids.id CROSS JOIN k
 ),
 -- the rule's leads: still at quoted (a later status is progress), a quote sent, no progress
 lead AS (SELECT j.id FROM j WHERE j.status = 'quoted' AND j.sent_at IS NOT NULL AND NOT j.accepted AND NOT j.invoiced AND NOT j.booked),
 -- the customer's newest text, email or call on the job by the instant, as the story reads them
 -- (context_job_record_messages: the customer's side only, never ours, a crew or staff text,
 -- another party's, a copy, a text from before the job's lead window or one whose CRM time is not
 -- kept; old-inbox mail placed on the job among them). A message placed on no job or on another
 -- job is not on the job and never counts
 cm AS (
  SELECT m.job_id, max(m.at) AS at
  FROM public.context_job_record_messages(ARRAY(SELECT lead.id FROM lead), (SELECT k.t FROM k)) m
  WHERE m.customer_side AND m.direction = 'inbound' AND m.channel IN ('sms', 'email', 'call') AND m.placement = 'on_job'
    AND m.at <= (SELECT k.t FROM k)
  GROUP BY m.job_id
 ),
 -- 28 days after the newer of the two, in hours, so no session time zone moves it
 r AS (
  SELECT j.*, CASE WHEN l.id IS NOT NULL THEN cm.at END AS customer_at,
         CASE WHEN l.id IS NOT NULL THEN greatest(j.sent_at, cm.at) + interval '672 hours' END AS cutoff_at
  FROM j LEFT JOIN lead l ON l.id = j.id LEFT JOIN cm ON cm.job_id = j.id
 )
 SELECT r.id, r.job_number, NOT coalesce(r.t >= r.cutoff_at, false),
        CASE WHEN r.status IS DISTINCT FROM 'quoted' THEN 'not_quoted'
             WHEN r.sent_at IS NULL THEN 'quote_not_sent'
             WHEN r.accepted THEN 'accepted' WHEN r.invoiced THEN 'invoiced' WHEN r.booked THEN 'booked'
             WHEN r.t >= r.cutoff_at THEN 'not_followed_up'
             ELSE 'within_4_weeks' END,
        r.sent_at, r.customer_at, r.cutoff_at
 FROM r
 ORDER BY r.id
$fn$;
COMMENT ON FUNCTION public.context_lead_monitored_jobs(uuid[], timestamptz) IS
 'Lead cutoff (20261007010000): the owner''s 7 Oct 2026 ruling, the one lead rule. One row per job in p_job_ids that exists (each once), or per live job (status not cancelled, draft, archived, complete, completed or lost) when p_job_ids is null, as of p_as_of (null: now). monitored is false only for a lead no longer followed up: still at quoted (jobs.status), a quote sent by p_as_of (quote_sent_at: the newest job_documents type quote sent_at, else jobs.quoted_at), no progress by p_as_of (no accepted quote: the job row''s accepted_at or a quote document''s; no customer invoice that is not voided or deleted; no crew booking that stands, never a ghost or observer copy; no later status) and p_as_of at or past cutoff_at, 28 days (672 hours) after the newer of quote_sent_at and customer_at, the customer''s newest inbound text, email or call on the job (context_job_record_messages: the customer''s side, placed on the job, old-inbox mail on the job among them; never ours, a crew or staff text, another party''s, a copy, or a message placed on no job or on another job). It is monitored again the moment it progresses or the customer writes on the job; a quote never sent starts no clock. state: not_quoted, quote_not_sent, accepted, invoiced, booked, within_4_weeks or not_followed_up. customer_at and cutoff_at are set for leads only (states within_4_weeks and not_followed_up). Ordered by job id. Read by the record loops (R7), the story read and the ledger judge; the scorecard reads it. Plain SQL with no SET. Service role only.';

-- 2. The rule for one job: false only for a lead no longer followed up; null for a job that does
-- not exist.
CREATE OR REPLACE FUNCTION public.context_lead_monitored(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS boolean
LANGUAGE sql STABLE
AS $fn$
 SELECT m.monitored FROM public.context_lead_monitored_jobs(ARRAY[p_job_id], p_as_of) m
$fn$;
COMMENT ON FUNCTION public.context_lead_monitored(uuid, timestamptz) IS
 'Lead cutoff (20261007010000): whether the job is monitored as of p_as_of (null: now) by the one lead rule, context_lead_monitored_jobs: false only for a lead still at quoted with no progress 28 days after the newer of its newest quote send and the customer''s newest text, email or call on the job; true for every other job; null for a job that does not exist. Plain SQL with no SET. Service role only.';

-- 3. The record loops: R7 on a lead no longer followed up says so, last (20261006040000's body otherwise).
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
         (p_as_of AT TIME ZONE 'Australia/Perth')::date AS today,
         -- (eighth review) the client's address, and whether the client has another job (the same
         -- CRM contact or client email), as the old inbox's mail is read
         lower(nullif(btrim(jb.client_email), '')) AS cmail,
         (EXISTS (SELECT 1 FROM public.jobs o WHERE o.ghl_contact_id = nullif(btrim(jb.ghl_contact_id), '') AND o.id <> jb.id)
          OR EXISTS (SELECT 1 FROM public.jobs o WHERE o.client_email IS NOT NULL
                     AND lower(btrim(o.client_email)) = lower(nullif(btrim(jb.client_email), '')) AND o.id <> jb.id)) AS repeat_client
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
 -- (eighth review) their email by the client's address with no CRM contact (a mail matched only by
 -- the address: SWP-26115's reply in the admin bucket, SWP-26148's on SWF-PDF-BUCKET), placed on no
 -- job or on a job no reader reads (a bucket: archived, complete, completed, cancelled, lost, a draft,
 -- or holding), recorded by p_as_of and no copy of another; read as the old inbox's mail is: from 30
 -- days before the job was created, or whenever while the client has another job (it may be about
 -- that job, said so); never one placed on another live job (that job's reader reads it). Read by
 -- the inbound mail sender index (business_events_party_mail_from)
 cem AS (
  SELECT j.id AS job_id, coalesce(e.event_at, e.occurred_at) AS at,
         CASE WHEN e.job_id IS NULL THEN 'not placed on any job'
              ELSE 'on ' || CASE WHEN oj.status::text = 'archived' THEN 'archived job '
                                 WHEN coalesce(oj.metadata ->> 'do_not_schedule', '') IN ('true', '1') THEN 'holding job '
                                 WHEN oj.status::text IN ('complete', 'completed') THEN 'completed job '
                                 ELSE oj.status::text || ' job ' END || coalesce(oj.job_number, 'without a number') END
         || CASE WHEN j.repeat_client THEN '; it may be about another of their jobs' ELSE '' END AS note
  FROM j JOIN public.business_events e
    ON j.cmail IS NOT NULL AND e.event_type IN ('supplier.email_in', 'client.email_in')
   AND lower(btrim(coalesce(substring(e.payload ->> 'from', '<([^<>]*)>'), e.payload ->> 'from'))) = j.cmail
  LEFT JOIN public.jobs oj ON oj.id = e.job_id
  WHERE e.contact_id IS NULL AND e.job_id IS DISTINCT FROM j.id AND e.metadata #>> '{duplicate_of}' IS NULL
    AND coalesce(e.recorded_at, e.occurred_at) <= p_as_of AND coalesce(e.event_at, e.occurred_at) <= p_as_of
    AND (j.repeat_client OR coalesce(e.event_at, e.occurred_at) >= j.created_at - interval '30 days')
    AND (e.job_id IS NULL OR oj.status::text IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
         OR coalesce(oj.metadata ->> 'do_not_schedule', '') IN ('true', '1'))
 ),
 -- (story safety, fourth and sixth review) the customer in touch by any other way the record
 -- knows: an answered call of theirs on the job, their email from the old inbox (on the job,
 -- or from their address on no job), a text, email or answered call of theirs off this job
 -- (offr: placed on no job, named so, or on their other job, named by its number), or their
 -- mail withheld because they have another job. A text or email of theirs on the job closes
 -- R7 (ins); one of these after the quote leaves whose move unclear. A CRM text they sent
 -- before the quote is never contact since it, however late it was loaded. (Eighth review)
 -- Also their email by the client's address with no CRM contact (cem).
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
  UNION ALL
  SELECT c.job_id, c.at, 'an email', c.note FROM cem c
 ),
 -- (story safety, seventh review) what we sent this customer's CRM contact, on this job, on
 -- another or on none: a call, text or email, never automated (a workflow send, a crew or staff
 -- alert), recorded by p_as_of; a CRM text loaded later from the cache at its CRM time (one
 -- whose CRM time is no longer known never counts). Our reply wherever it was placed answers
 -- them: R4, R5 and C11 close on it (SWF-261525: our text 4 minutes after their missed call,
 -- placed on their other job; SWF-261457: our reply in a text placed on no job). Read per
 -- candidate, never in full (inlined into each NOT EXISTS)
 ox AS NOT MATERIALIZED (
  SELECT j.id AS job_id,
         CASE WHEN x.source = 'ghl_sms_cache_backfill'
              THEN public.context_job_record_crm_time(x.source, x.contact_id,
                     coalesce(nullif(btrim(x.payload ->> 'ghl_message_id'), ''), substring(x.provider_message_id FROM '^ghl:(.+)$')), x.job_id)
              ELSE coalesce(x.event_at, x.occurred_at) END AS at
  FROM j JOIN public.business_events x ON j.ccontact IS NOT NULL AND x.contact_id = j.ccontact
  WHERE x.direction = 'outbound' AND coalesce(x.recorded_at, x.occurred_at) <= p_as_of
    AND coalesce(x.event_at, x.occurred_at) <= p_as_of AND x.metadata #>> '{duplicate_of}' IS NULL
    AND (x.channel IN ('sms', 'email', 'call') OR x.event_type IN ('client.sms_out', 'client.email_out', 'client.call_logged', 'client.call_complete'))
    AND coalesce(x.payload ->> 'sent_by_kind', '') <> 'workflow' AND public.context_internal_text_role(x) = 'other'
 ),
 inv AS (
  SELECT x.id, x.job_id, x.invoice_number, x.reference, x.contact_name, x.xero_contact_id, x.xero_invoice_id, x.job_contact_id,
         x.total, x.amount_due, x.amount_paid, x.invoice_date, x.due_date, x.created_at,
         upper(coalesce(x.status, 'NONE')) AS st, upper(coalesce(x.invoice_type, 'ACCREC')) AS itype,
         'invoice:' || lower(coalesce(nullif(btrim(x.invoice_number), ''), 'id-' || left(x.id::text, 8))) AS about,
         -- who the invoice is addressed to: the customer (the builder on builder work), or a
         -- neighbour, strata, another party or another payer (context_job_record_payer_role)
         CASE WHEN upper(coalesce(x.invoice_type, 'ACCREC')) = 'ACCREC'
              THEN public.context_job_record_payer_role(x.job_id, j.type, j.jxc, x.xero_contact_id, x.job_contact_id) END AS payer_role,
         -- (seventh review) the payer it is addressed to (Xero contact, job_contacts party) and the
         -- share its job reference names: the stem (SWF-261423), the run its middle names (LHS,
         -- REAR), the payer letter (A-, B-, C-, or one after the stage), the stage its suffix
         -- names (DEP a deposit; FIN, BAL or FINBAL the final) and that stage's percentage
         nullif(btrim(x.xero_contact_id), '') AS payer_xc, rs.stem AS ref_stem, rs.run AS ref_run, rs.letter AS ref_letter,
         rs.stage AS ref_stage, rs.pct AS ref_pct
  FROM public.xero_invoices x JOIN j ON j.id = x.job_id
  CROSS JOIN LATERAL (
   SELECT substring(r.r FROM '^(SW[A-Z]{0,4}-[0-9]+)') AS stem,
          CASE WHEN r.r ~ '-DEP[0-9]{0,3}(-[A-Z])?$' THEN 'DEP' WHEN r.r ~ '-(FINBAL|FIN|BAL)[0-9]{0,3}(-[A-Z])?$' THEN 'FIN' END AS stage,
          nullif(substring(r.r FROM '-(?:FINBAL|FIN|BAL|DEP)([0-9]{0,3})(?:-[A-Z])?$'), '')::numeric AS pct,
          coalesce(substring(coalesce(r.mid, '') || '-' FROM '-([A-Z])-'), substring(r.r FROM '-(?:FINBAL|FIN|BAL|DEP)[0-9]{0,3}-([A-Z])$')) AS letter,
          nullif(btrim(regexp_replace(coalesce(r.mid, '') || '-', '-[A-Z]-', '-', 'g'), '- '), '') AS run
   FROM (SELECT z.r, substring(z.r FROM '^SW[A-Z]{0,4}-[0-9]+(.*)-(?:FINBAL|FIN|BAL|DEP)[0-9]{0,3}(?:-[A-Z])?$') AS mid
         FROM (SELECT upper(coalesce(x.reference, '')) AS r) z) r) rs
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
 -- (lead cutoff, 20261007010000) the one lead rule (context_lead_monitored_jobs): a lead still at
 -- quoted with no progress is no longer followed up 28 days after the newer of its newest quote
 -- send and the customer's newest text, email or call on the job
 ld AS (SELECT m.job_id, m.monitored, m.cutoff_at FROM public.context_lead_monitored_jobs(coalesce(p_job_ids, '{}'::uuid[]), p_as_of) m),
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
  -- R3 draft not issued (reference rule). (Story safety, sixth and seventh review) A draft is a
  -- check naming them, never our move, when the job's issued invoices already bill the same
  -- share of the same stage of the same job reference (its stem; the run its middle names, LHS,
  -- REAR; the stage its suffix names: DEP a deposit, FIN, BAL or FINBAL the final; and the
  -- stage's percentage) for the draft's own payer (the same Xero contact or job_contacts party),
  -- so issuing it may bill that share twice:
  --  its own share: invoices to its own payer with the same payer letter (A-, B-, C- or none)
  --   and the same percentage reach its amount (a draft of an invoice already issued);
  --  the whole stage in parts: the draft names no payer letter, and invoices of its stage at or
  --   below its percentage (one with no percentage counts only against a draft with none), one
  --   of them to its own payer, together reach its amount (SWF-261423: the full DEP50 draft
  --   beside the customer's DEP25 and the neighbour's B-DEP25; SWF-26545: the DEP50 draft beside
  --   two DEP50 halves).
  -- Never across payer letters or another payer's invoices alone (SWF-26380: the neighbour's
  -- B-DEP50 draft beside the customer's issued DEP50; the customer's FINBAL draft beside the
  -- neighbour's issued B-FINBAL), nor across percentages (a DEP25 progress claim after the
  -- DEP50 deposit, SWP-26354): each of those is a draft still ours to issue.
  SELECT i.job_id, 'R3_draft', i.id::text, 'xero_invoices', CASE WHEN dup.n IS NOT NULL THEN 'check' ELSE 'loop' END, 'us', 'customer',
         'Draft invoice ' || coalesce(i.invoice_number, 'without a number') || ' ' || to_char(i.total, 'FM$999,999,990.00') || ' to '
           || coalesce(i.contact_name, 'an unnamed contact') || ' not issued since ' || to_char(i.invoice_date, 'Dy FMDD Mon YYYY')
           || coalesce(' (' || (SELECT string_agg(coalesce(o.invoice_number, 'unnumbered') || ' ' || lower(o.st), ', '
                                                  ORDER BY o.invoice_number COLLATE "C", o.id)
                                FROM sales o WHERE o.job_id = i.job_id AND o.id <> i.id AND o.reference = i.reference)
                       || ' on the same reference)', '')
           || coalesce('; it may duplicate the issued ' || CASE WHEN dup.n IS NULL THEN NULL WHEN i.ref_stage = 'DEP' THEN 'deposit' ELSE 'final' END || ' invoice'
                       || CASE WHEN dup.n > 1 THEN 's ' ELSE ' ' END || dup.nums
                       || CASE WHEN dup.own THEN ' to the same payer' ELSE '' END || ' on the same job reference ('
                       || to_char(dup.total, 'FM$999,999,990.00') || ')'
                       || CASE WHEN dup.own THEN '' ELSE ', which together bill the whole ' || CASE WHEN i.ref_stage = 'DEP' THEN 'deposit' ELSE 'final' END END, ''),
         'A draft in Xero cannot be paid; it is more than a day old'
           || CASE WHEN dup.n IS NOT NULL THEN '; issued invoices for the same share of the same stage of the same job reference, its payer''s own '
                                                || 'or the whole stage in parts with its payer''s among them, already reach its amount, '
                                                || 'so issuing it may bill that share twice' ELSE '' END,
         (i.invoice_date::timestamp AT TIME ZONE 'Australia/Perth'), NULL::date, i.total, i.about,
         'Approved (issued), voided or deleted in Xero'
  FROM sales i
  -- its own share billed to its own payer
  LEFT JOIN LATERAL (
   SELECT count(*) AS n, sum(coalesce(o.total, 0)) AS total,
          string_agg(coalesce(o.invoice_number, 'unnumbered'), ', ' ORDER BY o.invoice_number COLLATE "C", o.id) AS nums
   FROM sales o
   WHERE i.ref_stem IS NOT NULL AND i.ref_stage IS NOT NULL
     AND o.job_id = i.job_id AND o.id <> i.id AND o.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')
     AND o.ref_stem = i.ref_stem AND o.ref_stage = i.ref_stage AND o.ref_run IS NOT DISTINCT FROM i.ref_run
     AND o.ref_letter IS NOT DISTINCT FROM i.ref_letter AND o.ref_pct IS NOT DISTINCT FROM i.ref_pct
     AND ((i.payer_xc IS NOT NULL AND o.payer_xc = i.payer_xc) OR (i.job_contact_id IS NOT NULL AND o.job_contact_id = i.job_contact_id))
   HAVING count(*) > 0 AND sum(coalesce(o.total, 0)) >= coalesce(i.total, 0) - 1) own ON true
  -- the whole stage billed in parts, its own payer's among them
  LEFT JOIN LATERAL (
   SELECT count(*) AS n, sum(coalesce(o.total, 0)) AS total,
          string_agg(coalesce(o.invoice_number, 'unnumbered'), ', ' ORDER BY o.invoice_number COLLATE "C", o.id) AS nums
   FROM sales o
   WHERE i.ref_stem IS NOT NULL AND i.ref_stage IS NOT NULL AND i.ref_letter IS NULL
     AND o.job_id = i.job_id AND o.id <> i.id AND o.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')
     AND o.ref_stem = i.ref_stem AND o.ref_stage = i.ref_stage AND o.ref_run IS NOT DISTINCT FROM i.ref_run
     AND CASE WHEN i.ref_pct IS NULL THEN o.ref_pct IS NULL ELSE o.ref_pct <= i.ref_pct END
   HAVING count(*) > 0 AND sum(coalesce(o.total, 0)) >= coalesce(i.total, 0) - 1
      AND bool_or((i.payer_xc IS NOT NULL AND o.payer_xc = i.payer_xc) OR (i.job_contact_id IS NOT NULL AND o.job_contact_id = i.job_contact_id))) whole ON true
  CROSS JOIN LATERAL (SELECT coalesce(own.n, whole.n) AS n, coalesce(own.total, whole.total) AS total,
                             coalesce(own.nums, whole.nums) AS nums, own.n IS NOT NULL AS own) dup
  WHERE i.st = 'DRAFT' AND i.invoice_date IS NOT NULL
    AND extract(epoch FROM p_as_of - (i.invoice_date::timestamp AT TIME ZONE 'Australia/Perth')) > 86400
  UNION ALL
  -- R4 missed call not returned (reference rule). (Story safety, seventh review) Never once we
  -- called, texted or emailed their CRM contact after it on any job or none (ox: SWF-261525, our
  -- text 4 minutes later placed on their other job), nor once they got through since by an
  -- answered call, on the job or off it (SWMS-261051 and SWP-26257: their answered call 14 minutes
  -- and 8 weeks later): the off-job branch's guards below. (Eighth review) Getting through is a
  -- call row of theirs whose own status says completed or answered, never a transcript alone: a
  -- voicemail is stored as its own transcript row a minute or two after the missed call
  -- (SWF-26091, 7 Sep), and asking for a call back is no answer
  SELECT c.job_id, 'R4_missed_call', c.source_id, 'business_events', 'loop', 'us', 'customer',
         'Missed call from the customer ' || to_char(c.at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon HH24:MI')
           || '; no call, text or email to the customer since',
         'The call record shows it was not answered (' || coalesce(substring(c.words FROM 'Provider status: ([A-Za-z_-]+)'), 'missed') || ')',
         c.at, NULL::date, NULL::numeric, 'contact:missed-call', 'A call, text or email from us to the customer after it'
  FROM bm c
  WHERE c.direction = 'inbound' AND c.channel = 'call' AND c.is_job_contact IS TRUE AND c.bad_call
    AND NOT EXISTS (SELECT 1 FROM outs o WHERE o.job_id = c.job_id AND o.at > c.at)
    AND NOT EXISTS (SELECT 1 FROM ox x WHERE x.job_id = c.job_id AND x.at > c.at)
    AND NOT EXISTS (SELECT 1 FROM offr y WHERE y.job_id = c.job_id AND y.is_call AND y.at > c.at
                      AND y.event_type IS DISTINCT FROM 'call.transcript_completed' AND y.call_status IN ('completed', 'answered'))
    AND NOT EXISTS (SELECT 1 FROM msg y WHERE y.job_id = c.job_id AND y.direction = 'inbound' AND y.call_answered
                      AND y.event_type IS DISTINCT FROM 'call.transcript_completed' AND y.at > c.at)
  UNION ALL
  -- (story safety, sixth review) R4 for this customer's missed call placed on no job that the
  -- placement queue offers this job (offr queued: its candidates, their admin bucket, a holding
  -- job), from the job's lead window on, when no call, text or email went to them after it (on
  -- this job, on any other or on none: ox) and they did not get through since (SWF-261506 and
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
    AND NOT EXISTS (SELECT 1 FROM ox x WHERE x.job_id = o.job_id AND x.at > o.at)
    AND NOT EXISTS (SELECT 1 FROM offr y WHERE y.job_id = o.job_id AND y.is_call AND y.at > o.at
                      AND y.event_type IS DISTINCT FROM 'call.transcript_completed' AND y.call_status IN ('completed', 'answered'))
    AND NOT EXISTS (SELECT 1 FROM msg y WHERE y.job_id = o.job_id AND y.direction = 'inbound' AND y.call_answered
                      AND y.event_type IS DISTINCT FROM 'call.transcript_completed' AND y.at > o.at)
  UNION ALL
  -- R5 customer wrote last (reference rule; a candidate until a reader says a reply is owed).
  -- (Story safety, seventh review) Our reply placed off the job closes it too (ox: a call, text or
  -- email to their CRM contact on any job or none; SWF-261457, our reply a minute later in a text
  -- placed on no job; SWF-26395, our texts pending placement)
  SELECT l.job_id, 'R5_customer_wrote_last', l.source_id, 'business_events', 'candidate', 'us', 'customer',
         'Customer ' || CASE WHEN l.channel = 'email' THEN 'emailed' ELSE 'texted' END || ' '
           || to_char(l.at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon HH24:MI') || ' and nothing went to the customer since: "'
           || left(l.words, 160) || '"',
         'The newest customer message is newer than our newest customer-facing message (automated texts not counted)',
         l.at, NULL::date, NULL::numeric, 'contact:customer-reply', 'A text, email or call from us to the customer after it'
  FROM (SELECT DISTINCT ON (i.job_id) i.* FROM ins i ORDER BY i.job_id, i.at DESC, i.source_id DESC) l
  WHERE NOT EXISTS (SELECT 1 FROM outs o WHERE o.job_id = l.job_id AND o.at > l.at)
    AND NOT EXISTS (SELECT 1 FROM ox x WHERE x.job_id = l.job_id AND x.at > l.at)
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
                       || ' and may replace this quote', '')
           -- (lead cutoff, 20261007010000) a lead no longer followed up says so, last
           || CASE WHEN ld.monitored = false
                   THEN '. Lead not followed up since ' || to_char(ld.cutoff_at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon YYYY')
                        || ': 4 weeks after the last quote or message with no progress' ELSE '' END,
         CASE WHEN de.undelivered THEN 'Every email of the newest sent quote bounced or failed and the customer never viewed it, so it was not received'
              WHEN h.at IS NOT NULL THEN 'Newest sent quote not accepted, declined or superseded, sent more than 7 days ago; the customer was in touch '
                                         || 'after it (no text or email of theirs on the job), so it may already be answered: whose move is unclear'
              ELSE 'Newest sent quote not accepted, declined or superseded, sent more than 7 days ago' END
           || CASE WHEN lj.job_number IS NOT NULL
                   THEN '; this customer''s later job of the same kind at the same site address is accepted, so this quote may be replaced by it: a check'
                   WHEN NOT acc.accepted AND jv.status NOT IN ('quoted', 'lead', 'new', 'draft')
                   THEN '; the job''s status (' || replace(jv.status, '_', ' ') || ') is past quoted, so the quote is a check, never a wait on the customer'
                   ELSE '' END
           || CASE WHEN ld.monitored = false
                   THEN '; the lead is no longer followed up: no acceptance, customer invoice, booking or later status in the 4 weeks after '
                        || 'the newer of its newest quote send and the customer''s newest text, email or call on the job (context_lead_monitored)'
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
  LEFT JOIN ld ON ld.job_id = q.job_id
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
  -- recorded by p_as_of) sits on no job, or (seventh review) on an archived or holding job (a
  -- bucket: a copy on a live job takes the mail off this job; eighth review: on any job that is
  -- not live, completed, cancelled, lost or a draft too), said so with that job's number.
  -- (Seventh review) Our reply placed off the job closes it too (ox), as it closes R5
  SELECT l.job_id, 'C11_customer_mail_unanswered', l.source_id, 'inbox_events', 'candidate', 'us', 'customer',
         'Customer emailed ' || to_char(l.at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon HH24:MI')
           || CASE WHEN cp.on_job IS NULL
                   THEN ' (stored only in the old inbox' || CASE WHEN l.placement = 'not_placed' THEN ', not placed on any job' ELSE '' END || ')'
                   ELSE ' (from the old inbox' || CASE WHEN l.placement = 'not_placed' THEN ', not placed on any job' ELSE '' END
                        || CASE WHEN cp.on_job THEN '; its saved copy is on ' || cp.bucket || ')' ELSE '; its saved copy is on no job yet)' END END
           || ' and nothing went to the customer since: "' || left(l.words, 160) || '"',
         'The email has no saved copy on this job, so the R5 rule cannot see it',
         l.at, NULL::date, NULL::numeric, 'contact:customer-reply', 'A text, email or call from us to the customer after it'
  FROM (SELECT DISTINCT ON (m.job_id) m.* FROM msg m
        WHERE m.source_table = 'inbox_events' AND m.customer_side ORDER BY m.job_id, m.at DESC, m.source_id DESC) l
  -- its saved copies elsewhere (a copy on this job or on a live job would have left the mail
  -- out): on_job is true when one sits on a job (one that is not live: eighth review, the judge's
  -- live set), false when they sit on no job, null when there is none; bucket names that job and
  -- why no reader reads it there (archived, holding, completed, cancelled, lost or draft)
  CROSS JOIN LATERAL (
   SELECT bool_or(x.job_id IS NOT NULL) AS on_job,
          min((CASE WHEN oj.status::text = 'archived' THEN 'archived job ' WHEN coalesce(oj.metadata ->> 'do_not_schedule', '') IN ('true', '1')
                    THEN 'holding job ' WHEN oj.status::text IN ('complete', 'completed') THEN 'completed job '
                    WHEN oj.status::text IN ('cancelled', 'lost', 'draft') THEN oj.status::text || ' job '
                    ELSE 'job ' END || coalesce(oj.job_number, 'without a number')) COLLATE "C") FILTER (WHERE x.job_id IS NOT NULL) AS bucket
   FROM (
    SELECT c.job_id FROM public.business_events c
    WHERE c.source_table = 'inbox_events' AND c.source_id = l.source_id AND coalesce(c.recorded_at, c.occurred_at) <= p_as_of
    UNION ALL
    SELECT c.job_id FROM public.inbox_events i JOIN public.business_events c ON c.provider_message_id = 'graph:' || i.graph_message_id
    WHERE i.id = l.source_id::uuid AND i.graph_message_id IS NOT NULL AND coalesce(c.recorded_at, c.occurred_at) <= p_as_of
    UNION ALL
    SELECT c.job_id FROM public.business_events c
    WHERE c.payload @> jsonb_build_object('inbox_events_id', l.source_id) AND coalesce(c.recorded_at, c.occurred_at) <= p_as_of) x
   LEFT JOIN public.jobs oj ON oj.id = x.job_id
   WHERE x.job_id IS DISTINCT FROM l.job_id) cp
  WHERE NOT EXISTS (SELECT 1 FROM outs o WHERE o.job_id = l.job_id AND o.at > l.at)
    AND NOT EXISTS (SELECT 1 FROM ox x WHERE x.job_id = l.job_id AND x.at > l.at)
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
 'Job record (20261006011000), story fixes (20261006033000), story safety (20261006040000): (lead cutoff, 20261007010000) R7 on a lead no longer followed up (context_lead_monitored_jobs: still at quoted with no acceptance, customer invoice, booking or later status 28 days after the newer of its newest quote send and the customer''s newest text, email or call on the job) ends "Lead not followed up since <day>: 4 weeks after the last quote or message with no progress", and its why says so; its owner is unchanged (the story''s first line never makes it the customer''s move). Earlier (eighth review) R4 takes getting through only from a call row of theirs whose own status says completed or answered, never a transcript alone (a voicemail is stored as its own transcript row); R7''s contact since the quote also counts their email by the client''s address with no CRM contact, placed on no job or on a job no reader reads (a bucket), from 30 days before the job or, while the client has another job, whenever (said so); C11 names the job that is not live (archived, holding, completed, cancelled, lost or draft) a brought-back mail''s copy sits on. Earlier (seventh review) R3 is a check only when the job''s issued invoices already bill the same share of the same stage of the same job reference (stem, run, stage and its percentage) for the draft''s own payer (the same Xero contact or job_contacts party): its own share (the same payer letter and percentage) reaching its amount, or, for a draft naming no payer letter, the whole stage in parts (invoices at or below its percentage) reaching it with its own payer''s among them; never across payer letters, on another payer''s invoices alone, or across percentages; R4 (on the job too), R5 and C11 close on a call, text or email we sent the customer''s CRM contact after it on any job or none (never automated; a CRM text at its CRM time), and R4 on the job also once they got through since by an answered call or a transcript, on or off the job; C11 names the archived or holding job a brought-back mail''s saved copy sits on. Earlier (sixth review) R7 is a loop only while the job is quoted or earlier: once its status is past quoted, or this customer''s later job of the same kind at the same site address is accepted (it may replace the quote, named), it is a check; the customer''s contact since the quote also counts what they sent off the job: every row of their CRM contact placed on no job whatever its attribution status, and their rows on their other jobs (named "on job X"); R4 also fires for their missed call placed on no job that the placement queue offers this job (its candidates, their admin bucket, a holding job; placement not_placed), from the job''s lead window on, when no call, text or email went to them after it on any job or none and they did not get through since; R3 is a check, never our move, when the job''s issued invoices for the same stage of the same job reference (stem and DEP or FIN suffix) already reach the draft''s amount (named: it may duplicate them); a CRM text whose CRM time is no longer known is never the customer''s. Earlier: a paid deposit invoice counts as acceptance (R8, and R7 turns check); R7 on a quote the customer was in touch about since it was sent in a way that does not close it (an answered call of theirs on the job, their old-inbox mail, a message of theirs placed on no job yet, their mail withheld because they have another job) is owned by nobody known (owner and counterparty unknown: it may be answered) and names that newest contact, and "no customer message since" is said only when there is none anywhere (a CRM text of theirs placed on no job that was loaded later from the CRM''s cache is at the CRM''s own time, context_job_record_crm_time, and one the CRM dates more than 30 days before the job was created is never theirs, as the job''s own texts are read, so a text sent before the quote is never contact since it however late it was loaded); C2 is one check per record that disagrees with the job value (context_job_record_value: the accepted quote, invoices above the value, and on an accepted job an invoice line''s own base, also a line naming this job on an invoice placed elsewhere, a deposit''s percentage, the newest sent quote, a final invoice below the value, a value from a quote the app has no record of sending, an invoice placed on no job or on another job that names this job), and then R8 says the value is unconfirmed and carries no amount; R1, R2 and M1 are owed by whoever the invoice is addressed to (context_job_record_payer_role): the customer (the builder on builder work), else another party (owner third_party), named with its role; C11 on a mail brought back from the old inbox (its saved copy sits on another job or on no job, recorded by p_as_of) says where that copy sits, never "stored only in the old inbox". Earlier, story fixes: C6 names the booked days in date order, each once; R7 on a quote whose every email bounced or failed and the customer never viewed it reads not received and is ours (owner us), not the customer''s answer, and its closes_when says when not received ends (an email of it goes out or the customer views it) and then when the loop closes; text sorts and tiebreaks in C (byte) order. Earlier: record-closable loops per job. R1_overdue, R2_part_paid, R3_draft, R4_missed_call, R5_customer_wrote_last, R6_booking_passed_status_unmoved, R7_quote_waiting, R8_not_yet_invoiced are exactly the proof-set reference rules (tests.md T2, grade_ref.py record_loops); M1_money_due; checks C1 to C4 and C6 to C11 (a person''s look, never an obligation; C5, crew planning''s tentative booking, is retired and crew planning''s confirmation is never read). shown_as loop|candidate|check. loop_key = rule:source_id. about_key per the ledger vocabulary. placement says where a cited message sits (on_job, or not_placed: client mail the old inbox placed on no job, labelled in the words); null for a record row. Service role only.';

-- 4. The story read: the record part carries the rule's row (20261006014000's body otherwise).
CREATE OR REPLACE FUNCTION public.context_job_story(p_job_id uuid, p_as_of timestamptz DEFAULT now(),
 p_generation_id uuid DEFAULT NULL, p_since timestamptz DEFAULT NULL, p_record_only boolean DEFAULT false)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 SELECT public.context_job_story_assemble(
  (SELECT jsonb_build_object('id', jb.id, 'job_number', jb.job_number, 'type', jb.type, 'status', jb.status,
          'client_name', jb.client_name, 'site_suburb', jb.site_suburb, 'created_at', jb.created_at,
          'ghl_contact_id', nullif(btrim(jb.ghl_contact_id), ''))
   FROM public.jobs jb WHERE jb.id = p_job_id),
  jsonb_build_object(
   'timeline', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.at, t.kind, t.source_id), '[]'::jsonb)
                FROM public.context_job_record_timeline(ARRAY[p_job_id], p_as_of) t),
   'loops', (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.rule, l.source_id), '[]'::jsonb)
             FROM public.context_job_record_loops(ARRAY[p_job_id], p_as_of) l),
   'money', (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.owing DESC, m.party), '[]'::jsonb)
             FROM public.context_job_record_money(ARRAY[p_job_id], p_as_of) m),
   'contact', (SELECT to_jsonb(c) FROM public.context_job_record_contact(ARRAY[p_job_id], p_as_of) c),
   'facts', public.context_job_story_facts(p_job_id, p_as_of),
   -- (lead cutoff, 20261007010000) the lead rule's answer for this job, which the assembler reads
   'lead', (SELECT to_jsonb(m) FROM public.context_lead_monitored_jobs(ARRAY[p_job_id], p_as_of) m)),
  -- record_only: the records alone, for the reader's own prompt; the ledger is
  -- not read, so no item, attachment or ledger word reaches the output.
  CASE WHEN coalesce(p_record_only, false) THEN jsonb_build_object('status', 'omitted', 'items', '[]'::jsonb, 'transitions', '[]'::jsonb)
       ELSE public.context_job_story_ledger(p_job_id, p_generation_id, p_as_of) END,
  public.context_job_story_meta(p_job_id, p_as_of),
  p_as_of, p_since)
 WHERE EXISTS (SELECT 1 FROM public.jobs jb WHERE jb.id = p_job_id)
$fn$;
COMMENT ON FUNCTION public.context_job_story(uuid, timestamptz, uuid, timestamptz, boolean) IS
 'Job story (20261006014000), lead cutoff (20261007010000): the record part also carries lead (context_lead_monitored_jobs for the job as of p_as_of: monitored, state, quote_sent_at, customer_at, cutoff_at), which the assembler reads. Earlier: job-story-v1 for one job: now line, money, loops, checks, timeline, phase notes, agreements, events, who, last exchange, handling, not known, changes since p_since, meta. Record parts from the job record layer, the live ledger generation (or p_generation_id in any status), every line cited. p_record_only: the records alone (the ledger is not read: meta.ledger.status omitted, no not_known line about the reader, no ledger item, attachment or words anywhere), for the reader''s own prompt; RPC only, never a door parameter. NULL for an unknown job. Service role only.';

-- 5. The assembler: a lead no longer followed up is never the customer's move (20261006040000's body otherwise).
CREATE OR REPLACE FUNCTION public.context_job_story_assemble(p_job jsonb, p_record jsonb, p_ledger jsonb, p_meta jsonb,
 p_as_of timestamptz, p_since timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql STABLE
AS $fn$
 WITH inp AS MATERIALIZED (
  SELECT x.*, CASE WHEN x.ins THEN 'the insured' WHEN x.bw THEN 'the job contact' ELSE 'the customer' END AS cust
  FROM (
  SELECT p_job AS job, coalesce(p_record, '{}'::jsonb) AS rec, coalesce(p_ledger, '{}'::jsonb) AS led,
         coalesce(p_meta, '{}'::jsonb) AS meta, p_as_of AS as_of, (p_as_of AT TIME ZONE 'Australia/Perth')::date AS today,
         p_since AS since,
         -- (eighth review) builder work: the builder is the customer
         coalesce(p_job ->> 'type' IN ('makesafe', 'repair', 'insurance'), false) AS bw,
         -- (ninth review) and the job's CRM contact (and client email) the insured's only when the
         -- make-safe details name the builder and the job's contact details sit on no other client's
         -- job (meta contact_shared.shared false): then the contact's messages are named the insured's
         -- and never change whose move on what the builder owes. A contact on another client's job is
         -- shared across clients, a builder's or an agent's (SWR-261488, SWMS-261065 and SWMS-261163:
         -- one builder-side contact on three clients' jobs), and with no builder named the client may
         -- be the customer (SWF-261111, SWF-261314: quoted to the client); either way, or when the
         -- meta does not say, the line calls its messages the job contact's and they may be about
         -- what the builder owes, so they hold the move as the customer's do
         (coalesce(p_job ->> 'type' IN ('makesafe', 'repair', 'insurance'), false)
          AND nullif(btrim(p_record -> 'facts' ->> 'builder'), '') IS NOT NULL
          AND coalesce((p_meta -> 'contact_shared' ->> 'shared')::boolean = false, false)) AS ins
  ) x
 ),
 -- (lead cutoff, 20261007010000) the lead rule's answer, passed in as record lead by the story
 -- read (context_lead_monitored_jobs): off when the job is a lead no longer followed up, still at
 -- quoted with no progress 28 days after the newer of its newest quote send and the customer's
 -- newest text, email or call on the job. With no lead passed in (a caller of the pure assembler)
 -- the job is followed up
 ld AS (
  SELECT CASE WHEN jsonb_typeof(inp.rec -> 'lead' -> 'monitored') = 'boolean' THEN NOT (inp.rec -> 'lead' ->> 'monitored')::boolean
              ELSE false END AS off,
         CASE WHEN jsonb_typeof(inp.rec -> 'lead' -> 'cutoff_at') = 'string' THEN (inp.rec -> 'lead' ->> 'cutoff_at')::timestamptz END AS cutoff_at
  FROM inp
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
         -- is not none). Only then may nothing open be an all-clear. (Eighth review) Nor while
         -- an item of its is hidden (a message it cites is no longer this job's evidence, or the
         -- citation check refuses it now): what it found is no longer whole until it is rebuilt
         -- (or, for a staff correction, a person checks it)
         (x.gen IS NOT NULL AND x.status IN ('live', 'retired', 'shadow')
          AND coalesce((inp.led->>'unread_rows')::integer = 0, false) AND x.hidden = 0) AS words_read,
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
 -- (eighth review) the drafts shown as R3 checks (issued invoices may already bill their share:
 -- never our move): the first line and the money line say so, never a plain draft to issue
 -- (SWF-26545: issuing the DEP50 draft bills the customer the other payer's paid half again)
 dd AS (
  SELECT count(*) AS n, coalesce(sum(CASE WHEN jsonb_typeof(i -> 'total') = 'number' THEN (i ->> 'total')::numeric END), 0) AS total
  FROM mo m CROSS JOIN LATERAL jsonb_array_elements(coalesce(m.invoices, '[]'::jsonb)) i
  WHERE m.party IS NOT NULL AND i ->> 'status' = 'DRAFT'
    AND EXISTS (SELECT 1 FROM rl WHERE rl.rule = 'R3_draft' AND rl.shown_as = 'check' AND rl.source_id = i ->> 'id')
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
   -- an accepted quote, else (seventh review) the job value's acceptance (the job row's, or a
   -- paid deposit invoice: facts.accepted), so a job its paid deposit accepted reads accepted
   -- since that payment, never a new enquiry (SWF-261372)
   coalesce((SELECT min(q.accepted_at) FROM qd q), (inp.rec->'facts'->'accepted'->>'at')::timestamptz) AS accepted_at,
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
    -- (seventh review) processing on other work is at least accepted once the job is accepted
    WHEN 'processing' THEN CASE WHEN ev.type = 'makesafe' THEN 'makesafe' WHEN ev.accepted_at IS NOT NULL THEN 'accepted' ELSE 'other' END
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
 -- read every row on the job gives no all-clear over it (fixture P, SWF-261305). (Eighth review)
 -- Also one on a job no reader reads (a bucket) or their email by address with no CRM contact
 -- (meta off_job unchecked_customer: SWP-26148's reply on SWF-PDF-BUCKET), where it sits named
 ofj AS (
  SELECT x.at, x.note FROM inp, LATERAL (VALUES
    ((inp.meta->'off_job'->>'unchecked_customer_at')::timestamptz,
     ' (' || coalesce(inp.meta->'off_job'->>'unchecked_customer_where', 'not placed on any job') || ')', 0),
    ((inp.meta->'unplaced'->>'newest_customer_at')::timestamptz, ' (not placed on any job)', 1),
    ((inp.meta->'withheld_mail'->>'newest_at')::timestamptz, ' (an email not placed on any job; it may be about another of their jobs)', 2)
  ) x(at, note, o)
  WHERE x.at IS NOT NULL AND x.at > coalesce((inp.rec->'contact'->'last_customer_message'->>'at')::timestamptz, '-infinity'::timestamptz)
  ORDER BY x.at DESC, x.o LIMIT 1
 ),
 -- (seventh review) and newer than the opening of the top loop the customer owes (the first due
 -- now): it may be about that item (SWF-26004: a complaint about the work in the admin bucket
 -- after the overdue invoice; SWF-261423: "I just paid it" in a call placed on no job), so whose
 -- move is unclear and the line names it. One from before that loop opened leaves its move
 -- standing (a quote whose off-job rows predate it still waits on the customer). (Eighth review)
 -- Only what its sender owes: the customer's own items, never a neighbour's or another payer's,
 -- and never on builder work while the sender (the CRM contact, the client email) is the insured
 -- and the builder owes (SWMS-261441: the insured's thank-you text never makes the builder's
 -- payment unclear); (ninth review) a contact shared across clients, or one the story cannot call
 -- the insured's, may be the builder's own, so its newer message holds the builder's move
 ofl AS (
  SELECT o.at, o.note FROM ofj o, inp
  WHERE NOT inp.ins
    AND o.at > (SELECT l.since FROM loops l WHERE l.owner = 'customer' AND NOT l.held ORDER BY l.rank LIMIT 1)
 ),
 -- (eighth review) the customer's newest message on the job (a text, an email, an answered call or
 -- a call recording: a voicemail among them; or their old-inbox email placed on no job) that no
 -- finished reading has read: it may hold a promise or request of ours (SWF-261481: staff agreed to
 -- cash on the day and a Wednesday install after the invoice; SWF-26091: the customer's voicemail
 -- about the rectification logged as a completed call; SWF-261053: a voicemail saying we promised
 -- to take the printed invoice to the other payer)
 ojc AS (
  SELECT (c ->> 'at')::timestamptz AS at, c ->> 'placed_on' AS placed_on,
         CASE WHEN c ->> 'placed_on' = 'none' THEN 'an email not placed on any job'
              WHEN c ->> 'channel' = 'sms' THEN 'a text' WHEN c ->> 'channel' = 'email' THEN 'an email'
              WHEN c ->> 'event_type' = 'call.transcript_completed' THEN 'a call recording'
              ELSE 'an answered call' END AS kind
  FROM inp, led, LATERAL (SELECT inp.rec -> 'contact' -> 'last_customer_message' AS c) x
  WHERE jsonb_typeof(x.c) = 'object' AND (x.c ->> 'at') IS NOT NULL
    AND NOT (led.live_read AND coalesce(led.read_ids ? (x.c ->> 'id'), false))
 ),
 -- ... and newer than the opening of the top loop the customer or another party owes on the job
 -- (an email placed on no job: what the customer owes, as off the job): whose move is unclear and
 -- the line names the message with our last reply, whatever we sent since. Never on builder work
 -- while the contact's messages are the insured's and the builder owes (ninth review: a contact
 -- shared across clients, or one not the insured's, holds the builder's move as the customer's do)
 ojl AS (
  SELECT o.at, o.kind FROM ojc o, inp
  WHERE NOT inp.ins
    AND o.at > (SELECT l.since FROM loops l WHERE NOT l.held
                  AND (l.owner = 'customer' OR (l.owner = 'third_party' AND o.placed_on IS DISTINCT FROM 'none'))
                ORDER BY l.rank LIMIT 1)
 ),
 -- whose move: ours when we owe something due now; unclear while the customer wrote last
 -- unread, or (seventh review) while their newest message is off the job and newer than what
 -- they owe, or (eighth review) while their newest message on the job is unread and newer than
 -- what they or another party owe; and until a live reading has read every row on the job (and
 -- none of its items is hidden), nothing open on record is never nobody's move (story safety,
 -- 20261006040000), nor while the customer's newest message is off the job (sixth review)
 wm0 AS (
  SELECT CASE
          WHEN EXISTS (SELECT 1 FROM loops l WHERE l.owner = 'us' AND NOT l.held) THEN 'us'
          WHEN EXISTS (SELECT 1 FROM wl) THEN 'unknown'
          WHEN EXISTS (SELECT 1 FROM ofl) THEN 'unknown'
          WHEN EXISTS (SELECT 1 FROM ojl) THEN 'unknown'
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
 -- (lead cutoff, 20261007010000) a lead no longer followed up is nobody's move to chase and never
 -- the customer's (the owner's ruling, 7 Oct 2026): not_followed_up, whatever is open on it
 wm AS (SELECT CASE WHEN ld.off THEN 'not_followed_up' ELSE wm0.whose END AS whose FROM wm0, ld),
 -- the top loop is the first one due now (a final invoice before the work is finished, or
 -- one whose amount is unconfirmed, never is) of the party whose move it is, so the line
 -- never pairs one party's move with another's item (the customer's move with a
 -- neighbour's invoice, our move with another payer's); with whose move unclear, the item
 -- it is unclear on (owner unknown) first, else the first one due now
 top AS (SELECT l.* FROM loops l, wm0 wm WHERE NOT l.held
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
 -- message, or names a stale one, while a newer one waits off the job. (Eighth review) Also
 -- theirs and ours on their other jobs ("on job X"), on a bucket or holding job, and their
 -- email by address with no CRM contact (meta off_job); on builder work the contact's messages
 -- are the insured's, and named so, only when the contact is the insured's (ninth review: else the
 -- job contact's, never a person it may not be: SWR-261488's builder-side contact)
 cw AS (
  SELECT CASE WHEN inp.ins THEN 'the insured''s newest message ' WHEN inp.bw THEN 'the job contact''s newest message '
              ELSE 'newest customer message ' END
          || public.context_job_story_day((c.at AT TIME ZONE 'Australia/Perth')::date, phs.today) || c.note AS cm,
         'our last reply ' || public.context_job_story_day((r.at AT TIME ZONE 'Australia/Perth')::date, phs.today) || r.note AS rp,
         ' (an automated text went '
          || public.context_job_story_day(((inp.rec->'contact'->'last_to_customer'->'newer_automated'->>'at')::timestamptz AT TIME ZONE 'Australia/Perth')::date, phs.today)
          || ')' AS auto
  FROM inp CROSS JOIN phs
  LEFT JOIN LATERAL (
   SELECT x.at, x.note FROM (VALUES
     ((inp.rec->'contact'->'last_customer_message'->>'at')::timestamptz,
      CASE WHEN inp.rec->'contact'->'last_customer_message'->>'placed_on' = 'none' THEN ' (an email not placed on any job)' ELSE '' END, 1),
     ((inp.meta->'off_job'->>'newest_customer_at')::timestamptz,
      ' (' || coalesce(inp.meta->'off_job'->>'newest_customer_where', 'not placed on any job') || ')', 0),
     ((inp.meta->'unplaced'->>'newest_customer_at')::timestamptz, ' (not placed on any job)', 2),
     ((inp.meta->'withheld_mail'->>'newest_at')::timestamptz, ' (an email not placed on any job; it may be about another of their jobs)', 3)
   ) x(at, note, o) WHERE x.at IS NOT NULL ORDER BY x.at DESC, x.o LIMIT 1) c ON true
  LEFT JOIN LATERAL (
   SELECT x.at, x.note FROM (VALUES
     ((inp.rec->'contact'->'last_to_customer'->>'at')::timestamptz, '', 1),
     ((inp.meta->'off_job'->>'newest_reply_at')::timestamptz,
      ' (' || coalesce(inp.meta->'off_job'->>'newest_reply_where', 'not placed on any job') || ')', 0),
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
   -- (eighth review) a draft shown as an R3 check may duplicate issued invoices: said so, never a
   -- plain draft to issue (SWF-26545, SWF-261423)
   CASE WHEN mt.drafts > 0 THEN mt.drafts || CASE WHEN mt.drafts = 1 THEN ' draft invoice' ELSE ' draft invoices' END || ' not issued'
             || CASE WHEN dd.n = 0 THEN ''
                     WHEN dd.n >= mt.drafts THEN CASE WHEN mt.drafts = 1 THEN ' (it may' ELSE ' (they may' END || ' duplicate issued invoices; check R3)'
                     ELSE ' (' || dd.n || ' of them may duplicate issued invoices; check R3)' END END AS draft_words,
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
                                              -- (eighth review) a reading of every row with an item hidden (a
                                              -- message it cites is no longer this job's evidence): what it
                                              -- found is no longer whole (not_known says whether a rebuild or
                                              -- a person puts it right)
                                              WHEN led.live_read AND led.hidden > 0
                                              THEN ', and ' || led.hidden || CASE WHEN led.hidden = 1 THEN ' reader item is' ELSE ' reader items are' END
                                                   || ' hidden (a message it cites is no longer this job''s evidence); '
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
                                      || ' and the reader found nothing open in the job''s own messages, but ' || inp.cust || '''s newest message, '
                                      || (SELECT public.context_job_story_day((o.at AT TIME ZONE 'Australia/Perth')::date, phs.today) || o.note FROM ofj o)
                                      || ', is off the job and not yet checked by the reader'
                                 ELSE 'Whose move is unclear' END
        ELSE CASE WHEN nx.b IS NOT NULL THEN 'Nothing open until the visit' ELSE 'Nothing open on record' END END AS move_words,
   (SELECT inp.cust || ' wrote last on ' || public.context_job_story_day((wl.at AT TIME ZONE 'Australia/Perth')::date, phs.today)
           || CASE WHEN wl.placement = 'not_placed' THEN ' (an email not placed on any job)' ELSE '' END
           -- (owner's ruling, 6 Oct 2026: "not yet checked by the reader", never "not read yet",
           -- which reads as staff not having read it)
           || '; not yet checked by the reader'
           -- the words themselves, so a pause, a decline or a new request shows in the first line
           || coalesce(': "' || CASE WHEN length(x.w) > 90 THEN left(x.w, 87) || '...' ELSE x.w END || '"', '')
           -- (eighth review) and their newer message off the job (ofj), where it sits, unchecked
           -- (SWP-261265: their text in the admin bucket 11 days after the one they wrote last on the job)
           || coalesce((SELECT '; ' || inp.cust || '''s newest message, ' || public.context_job_story_day((o.at AT TIME ZONE 'Australia/Perth')::date, phs.today)
                               || o.note || ', is off the job and not yet checked by the reader'
                        FROM ofj o WHERE o.at > wl.at), '')
    FROM wl, LATERAL (SELECT nullif(btrim(substring(wl.what FROM ': "(.*)"$')), '') AS w) x) AS wrote_words,
   -- (seventh review) the customer's newest message is off the job and newer than the item they
   -- owe (ofl), or (eighth review) their newest message on the job is unread and newer than what
   -- they or another party owe (ojl): the newer of the two named, where it sits (or what it is),
   -- unchecked, with our last reply (never beside a quote waiting whose own words already name the
   -- contact since it)
   (SELECT CASE WHEN o.off THEN inp.cust || '''s newest message, ' || public.context_job_story_day((o.at AT TIME ZONE 'Australia/Perth')::date, phs.today)
                                || o.note || ', is off the job and not yet checked by the reader'
                ELSE inp.cust || '''s newest message, ' || public.context_job_story_day((o.at AT TIME ZONE 'Australia/Perth')::date, phs.today)
                     || ' (' || o.note || '), is not yet checked by the reader' END
           || coalesce('; ' || cw.rp, '')
    FROM (SELECT f.at, f.note, true AS off FROM ofj f UNION ALL SELECT c.at, c.kind, false FROM ojc c) o
    WHERE (SELECT wm0.whose FROM wm0) = 'unknown' AND NOT EXISTS (SELECT 1 FROM wl) AND (EXISTS (SELECT 1 FROM ofl) OR EXISTS (SELECT 1 FROM ojl))
      AND NOT EXISTS (SELECT 1 FROM top t WHERE t.owner = 'unknown' AND position('R7_quote_waiting' IN t.rule) > 0)
    ORDER BY o.at DESC, o.off DESC LIMIT 1) AS off_words,
   -- the customer wrote after a future booking was made (check C6), unread: their words
   (SELECT inp.cust || ' wrote ' || public.context_job_story_day((c.opened_at AT TIME ZONE 'Australia/Perth')::date, phs.today)
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
             || public.context_job_story_day(((phs.declined->>'declined_at')::timestamptz AT TIME ZONE 'Australia/Perth')::date, phs.today) END AS decline_words,
   -- (lead cutoff, 20261007010000) a lead no longer followed up: said in place of whose move, with
   -- the item still open on it (cut at a word, as the move's item is), unless that is the quote
   -- waiting on the customer, which says the same in its own words
   CASE WHEN ld.off
        THEN 'Lead not followed up since '
             || coalesce(public.context_job_story_day((ld.cutoff_at AT TIME ZONE 'Australia/Perth')::date, phs.today), 'a day not known')
             || ': 4 weeks after the last quote or message with no progress'
             || coalesce((SELECT '; open: ' || CASE WHEN length(w.w) <= 200 THEN w.w
                                                 ELSE rtrim(left(w.w, 197 - position(' ' IN reverse(left(w.w, 197)))), ' ,;:') || '...' END
                          FROM top t, LATERAL (SELECT regexp_replace(regexp_replace(t.what, '\. Lead not followed up since [^:]*: 4 weeks after the last quote or message with no progress$', ''),
                                                                     '\s+', ' ', 'g') AS w) w
                          WHERE NOT (position('R7_quote_waiting' IN t.rule) > 0 AND t.owner = 'customer')), '') END AS lead_words
  FROM phs, nx, mt, wm, led, inp, cw, dd, ld
 ),
 nowl AS (
  SELECT n.*, (SELECT string_agg(upper(left(x.s, 1)) || substr(x.s, 2), '. ' ORDER BY x.o) FROM (VALUES
           (1, n.phase_words || coalesce(': ' || n.next_words, '') || coalesce('; ' || n.att_words, '')),
           (2, nullif(concat_ws(', ', n.owing_words, n.elsewhere_words, n.draft_words, n.nyi_words), '')),
           (3, coalesce(n.lead_words, n.move_words || coalesce(', ' || n.top_words, ''))),
           (4, n.decline_words),
           (5, coalesce(n.wrote_words, n.off_words)),
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
                 THEN ' email on this job is shown from the old inbox: its saved copy is on no job yet or on a job that is not live (archived, completed, cancelled, lost, a draft or holding).'
                 ELSE ' emails on this job are shown from the old inbox: their saved copies are on no job yet or on a job that is not live (archived, completed, cancelled, lost, a draft or holding).' END END,
       'A saved copy filed on a live job decides where an email belongs, and the email then leaves this job; until one is, the old inbox row stands in for it.'),
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
   -- (ninth review) on builder work, contact details shared with another client's job: why the
   -- line calls the contact's messages the job contact's, never the insured's
   (11, CASE WHEN inp.bw AND coalesce((inp.meta->'contact_shared'->>'shared')::boolean, false)
             THEN (SELECT 'This job''s ' || CASE WHEN cardinality(n.a) = 1 THEN n.a[1]
                                                 ELSE array_to_string(n.a[1:cardinality(n.a) - 1], ', ') || ' and ' || n.a[cardinality(n.a)] END
                          || CASE WHEN cardinality(n.a) > 1 THEN ' are' ELSE ' is' END
                          || ' also on ' || CASE WHEN coalesce((inp.meta->'contact_shared'->>'other_jobs')::int, 0) > 1
                                                 THEN (inp.meta->'contact_shared'->>'other_jobs') || ' jobs of other clients'
                                                 ELSE 'another client''s job' END
                          || ', so the messages the story names are not taken to be the insured''s: the first line calls them the job contact''s.'
                   FROM (SELECT array_agg(CASE b.v WHEN 'contact' THEN 'CRM contact' WHEN 'phone' THEN 'client phone' ELSE 'client email' END ORDER BY b.o) AS a
                         FROM jsonb_array_elements_text(coalesce(inp.meta->'contact_shared'->'by', '[]'::jsonb)) WITH ORDINALITY b(v, o)) n) END,
        'A contact shared across clients is likely a builder''s or an agent''s, not the homeowner''s.'),
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
   -- homeowner the insured (story safety, 20261006040000); (ninth review) a CRM contact shared
   -- with another client's job (meta contact_shared) is never given as the insured's own
   SELECT inp.job->>'client_name' AS name, CASE WHEN inp.job->>'type' IN ('makesafe', 'repair', 'insurance') THEN 'insured' ELSE 'customer' END AS role,
          CASE WHEN inp.bw AND coalesce((inp.meta->'contact_shared'->>'shared')::boolean, false) THEN NULL ELSE inp.job->>'ghl_contact_id' END AS contact_ref,
          jsonb_build_array(jsonb_build_object('t', 'jobs', 'id', inp.job->>'id')) AS cites, 1 AS ord
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
            -- (lead cutoff, 20261007010000) whether the job is followed up, and since when it is not
            'monitored', (SELECT NOT ld.off FROM ld),
            'not_followed_up_since', (SELECT CASE WHEN ld.off THEN (ld.cutoff_at AT TIME ZONE 'Australia/Perth')::date END FROM ld),
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
                                                     || ' of ' || to_char(mt.draft_total, 'FM$999,999,990.00') || ' not issued'
                                                     -- (eighth review) one shown as an R3 check may duplicate issued invoices
                                                     || CASE WHEN dd.n = 0 THEN ''
                                                             WHEN dd.n >= mt.drafts THEN CASE WHEN mt.drafts = 1 THEN ' (it may' ELSE ' (they may' END
                                                                                         || ' duplicate issued invoices; check R3)'
                                                             ELSE ' (' || dd.n || ' of them, ' || to_char(dd.total, 'FM$999,999,990.00')
                                                                  || ', may duplicate issued invoices; check R3)' END
                                                ELSE '' END
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
           FROM mt, inp, unconf, dd),
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
 'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000): (lead cutoff, 20261007010000) a lead no longer followed up (record lead, from context_lead_monitored_jobs: still at quoted with no progress 28 days after the newer of its newest quote send and the customer''s newest text, email or call on the job) is never the customer''s move: whose_move not_followed_up, and the first line says "Lead not followed up since <day>: 4 weeks after the last quote or message with no progress" in place of whose move, then the item still open on it unless that is the quote waiting on the customer (whose own words end the same); now.monitored and now.not_followed_up_since say so (true and null when the record carries no lead, as for any caller of the pure assembler). Earlier (ninth review) on builder work the job''s CRM contact and client email are the insured''s only when the make-safe details name the builder (facts.builder) and meta contact_shared says none of the job''s contact details (CRM contact, client phone, client email) sits on another client''s job; otherwise (a contact shared across clients, a builder''s or an agent''s, no builder named, or the meta silent) the line calls their messages the job contact''s ("the job contact''s newest message", "the job contact wrote last"), they hold the builder''s move as the customer''s messages do, who gives the insured no shared contact, and not_known says the contact details are on another client''s job. Earlier (eighth review) an off-job message changes the move only of what its sender owes: the customer''s own items on private work, never a neighbour''s or another payer''s, and never on builder work while the job''s CRM contact and client email are the insured''s (the line names them "the insured") and the builder owes; the customer''s newest message on the job (a text, an email, an answered call or a call recording) that no finished reading has read makes whose move unclear over the top item they or another party owe from before it, named with our last reply; a reading with an item hidden gives no all-clear and says how many are hidden; the contact facts also take meta off_job (their rows on their other jobs and on bucket jobs, their email by address with no CRM contact), where each sits named; a newer message off the job is named after the customer wrote last; a draft shown as an R3 check is said in the first line and the money line to maybe duplicate issued invoices. Earlier (seventh review) whose move is unclear while the customer''s newest message is off the job and newer than the opening of the top item they or another party owe, and the line names that message, where it sits and that the reader has not checked it, with our last reply (one older than that item leaves its move standing); the phase reads a job the job value calls accepted (facts.accepted: the job row''s acceptance, an accepted quote or a paid deposit invoice) as at least accepted, since then, and processing on work other than a make-safe as accepted once it is; not_known says the mail shown from the old inbox has its saved copy on no job or on an archived or holding job (a copy on a live job takes the mail off this job). Earlier (sixth review) a job in rectification now has no work done (the final invoice is not due, said so), and the final invoice is not due either while work recorded finished was opened again since (facts.reopened: a status change into rectification or a make-safe re-attend, nothing recording it finished since); a quote waiting (R7) is a check once the work is done; a reading that has read every row on the job gives no all-clear while the customer''s newest message is off the job (meta unplaced newest_customer_at or withheld_mail newest_at newer than every customer message on the job): whose move is unknown and the line names that message, where it sits, and that the reader has not checked it; the first line and the money line name what this job''s own Xero contact owes on invoices placed on no job (meta unplaced_invoices; money.placed_on_no_job), never counting them in owing; not_known names texts whose CRM time is no longer kept. Earlier: until a finished reading shown (live or retired, or a shadow the story shows only when asked for it by id, so a grade reads the line a promotion gives; never a building or failed one) has read every row on the job (none unread), nothing open on record is never nobody''s move: whose_move unknown, the first line says "Whose move is unclear:" first, then that no record item is open (or due yet) and the messages are not yet checked for promises or requests (a reading that lags: how many newer messages, calls, notes or documents, ours included, it has not checked), with the newest customer message and our last reply, of the job''s own, this customer''s messages placed on no job yet and their withheld mail, naming where the newest sits (with neither anywhere it says so and claims nothing unchecked); with no finished reading handling.commitments is null, and only a finished reading judges a customer message; work is done only on a completion status, a completion record (facts.completion) or a report pack sent, never because the newest booking is complete; a final invoice (R8) before the work is done is not due (loop status not_due), and after it with the job value unconfirmed (C2, no amount) it is unconfirmed (status unconfirmed): either ranks last and is never the move or the first line''s item; a value another record disagrees with (C2) states no amount left to invoice; a quote the customer was in touch about since it was sent, in a way that does not close it (R7 owner unknown), makes whose move unclear and is the item the first line names; the first line''s item is cut at a word (200 characters); the customer''s unread words are "not yet checked by the reader"; the first line names each invoice owing with its due date, who owes it ("owed by") with their role whenever a neighbour or another payer owes it (whatever the move: its payer role, else its R1, R2 or M1 loop''s owner), and each payer when more than one owes, a passed booking with no attendance, a quote declined and the newest unread customer words (R5, C11, C6); the first line names the top loop of the party whose move it is, never another party''s (the customer''s move never names a neighbour''s invoice); a quote waiting reads as waiting on the customer; another party''s invoice reads as another payer owing; on builder work the builder is the customer and the homeowner the insured; not_known names mail shown from the old inbox and texts dated before the job. Earlier, story fixes: every text sort and tiebreak that reaches the output is in C (byte) order (who, money parties, loops and their rank, cites, checks, timeline, phase notes, agreements, events, not known, changes, blockers), so the story reads the same on every server whatever the input order. Earlier: the pure assembler of job-story-v1. Reads no table: job header, record parts (timeline, loops, money, contact, facts), ledger (generation, items with citation re-check result, transitions, its reader''s unread rows) and meta in; the cited story out. meta.ledger = {status, generation_id, evidence_until, reader, items, hidden_items, unread_rows, needs_rebuild, stale}. Inlinable (no SET). Service role only.';

-- 6. The judge: a lead no longer followed up is not due a read (20261006040000's body otherwise).
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
 ), lo AS (
  -- (lead cutoff, 20261007010000) a live job that is a lead no longer followed up (still at quoted
  -- with no progress 28 days after the newer of its newest quote send and the customer's newest
  -- text, email or call on the job: context_lead_monitored_jobs, now) is not due a read, and its
  -- evidence is never read in full for the judgement
  SELECT m.job_id FROM public.context_lead_monitored_jobs(ARRAY(SELECT j.id FROM j WHERE j.live_job), now()) m WHERE NOT m.monitored
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
  WHERE j.live_job AND NOT EXISTS (SELECT 1 FROM lo WHERE lo.job_id = j.id)
   AND CASE WHEN g.id IS NULL THEN (coalesce(cbe.n, 0) = 0 AND coalesce(cib.n, 0) > 0)
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
  -- (the story says so) instead of looping. (Story safety, eighth review) Also a
  -- citation the citation check refuses now, as the story's ledger read re-checks
  -- it (context_job_story_ledger): a CRM text loaded from the cache whose CRM time
  -- is not kept or is more than 30 days before the job was created (a reading from
  -- before this migration may cite SWF-261419's June texts), and an old-inbox mail
  -- now placed on another job, or with a saved copy on this job or another live job
  -- (its copy filed there after the reading).
  SELECT DISTINCT i.job_id FROM g JOIN public.context_ledger_items i ON i.generation_id = g.id AND NOT i.person_locked
  JOIN public.jobs jb ON jb.id = i.job_id
  CROSS JOIN LATERAL jsonb_array_elements(i.opened_by || coalesce(i.closed_by, '[]'::jsonb)) c(cite)
  LEFT JOIN public.business_events b ON c.cite ->> 'table' = 'business_events'
   AND b.id = CASE WHEN c.cite ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (c.cite ->> 'id')::uuid END
  LEFT JOIN public.inbox_events m ON c.cite ->> 'table' = 'inbox_events'
   AND m.id = CASE WHEN c.cite ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (c.cite ->> 'id')::uuid END
  WHERE (c.cite ->> 'table' = 'business_events'
         AND (b.id IS NULL OR b.job_id IS DISTINCT FROM i.job_id OR NOT public.context_event_source_admissible(b)
              OR (b.source = 'ghl_sms_cache_backfill'
                  AND coalesce(public.context_job_record_crm_time(b.source, b.contact_id,
                                 coalesce(nullif(btrim(b.payload ->> 'ghl_message_id'), ''), substring(b.provider_message_id FROM '^ghl:(.+)$')), b.job_id)
                               < jb.created_at - interval '30 days', true))))
     OR (c.cite ->> 'table' = 'inbox_events'
         AND NOT coalesce(m.id IS NOT NULL AND m.received_at IS NOT NULL
              AND (m.job_id = i.job_id
                   OR (m.job_id IS NULL AND lower(nullif(btrim(jb.client_email), '')) IS NOT NULL
                       AND lower(btrim(m.from_email)) = lower(nullif(btrim(jb.client_email), ''))
                       AND m.received_at >= jb.created_at - interval '30 days'
                       AND NOT EXISTS (SELECT 1 FROM public.jobs o WHERE o.ghl_contact_id = nullif(btrim(jb.ghl_contact_id), '') AND o.id <> jb.id)
                       AND NOT EXISTS (SELECT 1 FROM public.jobs o WHERE o.client_email IS NOT NULL
                                       AND lower(btrim(o.client_email)) = lower(nullif(btrim(jb.client_email), '')) AND o.id <> jb.id)))
              AND coalesce(m.classification, '') NOT IN ('spam', 'newsletter')
              AND coalesce(m.subject, '') !~* '^(automatic reply|auto[- ]?reply|out of office)'
              AND btrim(coalesce(m.subject, '') || coalesce(m.body_preview, '')) <> ''
              AND NOT EXISTS (SELECT 1 FROM public.business_events x WHERE x.source_table = 'inbox_events' AND x.source_id = m.id::text
                               AND (x.job_id = i.job_id OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = x.job_id
                                    AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                    AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
              AND NOT EXISTS (SELECT 1 FROM public.business_events x WHERE m.graph_message_id IS NOT NULL AND x.provider_message_id = 'graph:' || m.graph_message_id
                               AND (x.job_id = i.job_id OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = x.job_id
                                    AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                    AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
              AND NOT EXISTS (SELECT 1 FROM public.business_events x WHERE x.source_table IS NULL
                               AND x.payload @> jsonb_build_object('inbox_events_id', m.id::text)
                               AND (x.job_id = i.job_id OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = x.job_id
                                    AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                    AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
              AND NOT EXISTS (SELECT 1 FROM public.business_events x WHERE x.channel = 'email' AND coalesce(x.event_at, x.occurred_at) = m.received_at
                               AND lower(btrim(coalesce(x.payload ->> 'from', x.payload ->> 'from_email'))) = lower(btrim(m.from_email))
                               AND x.job_id = i.job_id), false))
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
    WHEN NOT j.schedulable THEN 'holding_job' WHEN lo.job_id IS NOT NULL THEN 'lead_not_monitored'
    WHEN coalesce(ev.n, 0) = 0 THEN 'no_evidence'
    WHEN b.building_live OR b.run_live THEN 'busy'
    WHEN f.needs_person THEN 'needs_person'
    WHEN f.backoff_until > now() OR b.building_lapsed_recent THEN 'backoff' END AS blocked
  FROM j CROSS JOIN s LEFT JOIN ev ON ev.job_id = j.id LEFT JOIN g ON g.job_id = j.id
  LEFT JOIN moved m ON m.job_id = j.id LEFT JOIN answered a ON a.job_id = j.id LEFT JOIN late lt ON lt.job_id = j.id
  LEFT JOIN fail f ON f.job_id = j.id LEFT JOIN busy b ON b.job_id = j.id LEFT JOIN lo ON lo.job_id = j.id
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
 'Context ledger store (20261006013000), story safety (20261006040000): (lead cutoff, 20261007010000) blocked lead_not_monitored: a live job that is a lead no longer followed up (context_lead_monitored_jobs as of now: still at quoted with no acceptance, customer invoice, booking or later status 28 days after the newer of its newest quote send and the customer''s newest text, email or call on the job) is never due a read, so context_ledger_due never lists it and a claim answers not_due; its evidence is not read in full. It is due again the moment it progresses or the customer writes on the job. Earlier (eighth review) citation_moved also takes an item whose citation the citation check refuses now, as the story''s ledger read re-checks it: a CRM text loaded from the cache whose CRM time is not kept or is more than 30 days before the job was created, and an old-inbox mail now placed on another job (or from the client''s address on no job while the client has another job, or from before the job''s lead window), not worded, spam, a newsletter or an auto-reply, or with a saved copy on this job or another live job (the judge''s live set); a mail''s copies time it from when one left a live job (context_ledger_mail_copies). Earlier: a legacy mail whose saved copy sits on another job or on no job counts from when it can have joined the job''s evidence (context_ledger_mail_copies: no earlier than that rule''s first apply and the copy''s own landing), in the quick read (for a job with a reading) as in the full one, so a reading built before then is never taken to have read it and the job is due; (seventh review) one whose copy sits on another live job is not this job''s evidence at all: the full read leaves it out, and the quick read, a superset, may only overstate by it and then reads the job in full; a never-read job''s quick read is as before, except that a never-read job whose admitted rows are all CRM texts loaded from the cache (source ghl_sms_cache_backfill) is read in full, since the evidence leaves out one dated before the job''s lead window and so may hold none (then it is no_evidence, never a backfill of nothing). Earlier: the one ledger due judgement per job (the full evidence read only for a job whose reading may have newer evidence or whose only possible evidence is legacy mail; elsewhere a count and newest landed time of the admitted rows decide the same; evidence_rows is then that count): kind backfill (never_read), update (new_evidence: the current generation''s evidence_until is older than the newest admissible evidence), or rebuild (checks_failed: the current reading is a shadow whose checks.passed is false; citation_moved: an item cites a business_events row now gone, off the job or not admissible; reader_changed; late_evidence: the earliest unread row is more than 14 days older than evidence_until, or more than 150 already-read rows follow it). A rebuild of the live reading for a moved citation or a changed reader is not due while a newer passing shadow by the current reader waits for promotion. Blocked: ledger_off, lane_off, not_in_rollout (settings.job_ids is set and does not list the job), not_live, holding_job, no_evidence, busy (a live building generation or a running ledger run), needs_person (three builds in a row failed their checks: context_ledger_failures), backoff (consecutive failed or check-failed runs: 2 hours, 8 hours, the next Perth day, then 7 days; or a building generation that lost its lease in the last 2 hours), outside_window (a backfill or rebuild outside the settings backfill hours; an update is never held). A person-locked item is never a moved citation (a rebuild would carry it back). Service role only.';

-- 7. Access: service role only (CREATE OR REPLACE keeps a replaced function's grants; said again).
REVOKE ALL ON FUNCTION public.context_lead_monitored_jobs(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_lead_monitored(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_record_loops(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story(uuid, timestamptz, uuid, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story_assemble(jsonb, jsonb, jsonb, jsonb, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_judge(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_lead_monitored_jobs(uuid[], timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_lead_monitored(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_record_loops(uuid[], timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story(uuid, timestamptz, uuid, timestamptz, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story_assemble(jsonb, jsonb, jsonb, jsonb, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_judge(uuid[]) TO service_role;
