-- Finished wake (12 Oct 2026): a finished job is read again while its customer writes.
--
-- The owner's ruling, 12 Oct 2026 (Marnin), decision D5 on the context system state board: "Should a
-- finished job be read again when its customer writes? Today an archived, complete or cancelled job
-- is never read ... Recommend: yes, while the job has a customer message from the last 30 days. It
-- catches SWF-261334 without re-reading 1,892 old jobs." Answered yes, 30 days.
--
-- Why. The ledger judge called every cancelled, archived, complete, completed or lost job not_live
-- before it looked at a message, and the due list never listed one, so no reader read a finished job
-- whatever its customer wrote. SWF-261334: the customer raised a defect, we asked to return and fix
-- it, the customer sent photos, and the job was archived the next day with no note of any of it.
--
-- The rule (context_lead_monitored_jobs, still the one rule):
--  * A finished job (status cancelled, archived, complete, completed or lost; never a holding job) is
--    awake while the instant is inside the wake window (context_finished_wake_hours, new: 720 hours,
--    30 days) after its customer's newest real inbound message on the job: state finished_awake,
--    customer_at that message and cutoff_at the window's end. Otherwise its row is what it always
--    was (not_quoted, both null), so nothing that reads a quiet finished job's row changes.
--  * A real inbound customer message is one the story reads as the customer's own on this job
--    (context_job_record_messages): a text, email or call from the customer's side, placed on the
--    job, or their old-inbox mail from the client's address on no job when they have no other job.
--    Never ours, staff's or crew's, another party's (a supplier, a builder, a neighbour), a workflow
--    text or one of our templates, a copy, a text from before the job's lead window or one whose CRM
--    time is not kept. Never a message on another job or in the placement queue: the reader of this
--    job reads only what is on it, so such a message cannot be what wakes it.
--  * With no ids the rule lists a finished job only while it is awake; with ids, every job asked for.
--  * monitored is unchanged for a finished job (true, as before): the rule's false is a lead no
--    longer followed up or a quiet draft, and the story says its lead words on it. Whether a reader
--    reads a finished job is its state. The story's now.monitored on a finished job is therefore
--    what it was.
--  * Thirty days after the customer's last message the job is quiet again; its notes stay.
--
-- Read only on production, 12 Oct 2026 (about 10:00 Perth), with this rule: 1,370 finished jobs (749
-- cancelled, 377 archived, 230 complete, 14 lost). 61 pass the cheap first cut; 11 are awake (9
-- archived, 2 complete, no cancelled or lost), SWF-261334 among them. 9 of the 11 have never been
-- read (a backfill each) and 2 hold a reading from before they were archived (an update). They
-- carry 250 evidence rows; at the last 14 days' 6.9 rows a call (546 backfills, 1.96 calls each on
-- average) that is about 40 reader calls once, against the day's 1,000 (46 used so far that day),
-- then one call when such a customer writes again. The state board's "25" counted finished jobs with
-- any message and no notes: 14 of those have no inbound customer message in 30 days (our own
-- outbound texts, a supplier's or an unknown sender's mail) and stay quiet, the 5 cancelled among
-- them. The holding job SWF-PDF-BUCKET (archived, do_not_schedule) is never woken.
--
-- Where it is used:
--  the ledger: context_ledger_judge reads the rule once for every job asked about, and a finished job
--   is a live job only while the rule calls it awake (else not_live, as before); context_ledger_due
--   also lists the finished jobs the rule calls awake, so one is due as any live job (never read: a
--   backfill, in the backfill hours; a new message: an update); context_ledger_claim asks the judge,
--   so it claims an awake finished job and answers not_due for a quiet one, with no change of its own;
--  the scorecard: context_scorecard and context_scorecard_jobs read the rule's live list, so
--   live_jobs and monitored_jobs now count the awake finished jobs (11 on 12 Oct 2026), and its rows
--   on the monitored jobs measure them too until they are read; leads_not_followed_up is unchanged.
--
-- Not changed: the story (the record loops and the assembler read the rule by id; a finished job's
-- monitored is what it was and no caller reads its state), the mail-copy rule and every other place
-- that treats a finished job as not live (an old-inbox mail's saved copy on a finished job does not
-- move the mail; the citation check and the reader's evidence read the same), the deep email,
-- history and CRM loads' own live lists (the deep email load takes only the rule's leads not followed
-- up), the packet, the write, the finish, placement, every signature, volatility, owner and grant.
-- Nothing is written: no row, flag, cron job, budget or setting changes.
--
-- Replaced bodies (guarded on their merged pre-image md5, or this migration's own for re-apply):
--  context_lead_monitored_jobs, context_ledger_judge and context_ledger_due (20261009133000).
-- Added: context_finished_wake_hours(), IMMUTABLE and inlinable, service role only.
-- Comment only: context_lead_monitored (the one-job form; its body, the set form's row, is unchanged).
-- Rollback: supabase/rollbacks/20261012093500_context_finished_wake_down.sql (the three earlier
--  bodies and comments word for word, the one-job form's comment, and the wake function dropped).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Guard. Each body replaced here must be the one production and main have before this migration
-- (md5 of prosrc, read 12 Oct 2026) or this migration's own; anything else is someone else's change
-- and is refused, never overwritten. The wake function must be absent or this migration's, and every
-- function and column the new bodies read must exist.
DO $guard$
DECLARE problems text[] := '{}'; x record; live text; f text; t text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_lead_monitored_jobs(uuid[],timestamptz)', ARRAY['4787286b92096a92be13171b72a5f291', 'ad173efa25e0adfd957971fb780eb74c']),
  ('public.context_ledger_judge(uuid[])', ARRAY['7f876b0454195b26515b5efca3d9ca13', '902eaf18e7fd84e05d0db5ffa6e67de1']),
  ('public.context_ledger_due(integer)', ARRAY['f6118bbea03f3cf1ad3a0956700a5bed', '15083363afc35bf335c81a78f2d5d13d'])
 ) v(sig, accepted) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY (x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 IF to_regprocedure('public.context_finished_wake_hours()') IS NOT NULL
    AND coalesce(obj_description(to_regprocedure('public.context_finished_wake_hours()'), 'pg_proc'), '') NOT LIKE 'Finished wake (20261012093500)%' THEN
  problems := problems || 'public.context_finished_wake_hours() exists and is not this migration''s'::text;
 END IF;
 FOREACH f IN ARRAY ARRAY['public.context_lead_monitored(uuid,timestamptz)', 'public.context_lead_window_hours(text)',
   'public.context_job_record_messages(uuid[],timestamptz)', 'public.context_ledger_claim(uuid,text,date)',
   'public.context_ledger_evidence_rows(uuid[],timestamptz)', 'public.automation_lane_enabled(text)'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['jobs.status', 'jobs.client_email', 'jobs.metadata', 'business_events.job_id', 'business_events.direction',
   'business_events.event_at', 'business_events.occurred_at', 'business_events.recorded_at', 'inbox_events.job_id',
   'inbox_events.from_email', 'inbox_events.received_at'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || split_part(t, '.', 1))
                 AND a.attname = split_part(t, '.', 2) AND NOT a.attisdropped) THEN
   problems := problems || format('public.%s missing', t);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_finished_wake_preimage_mismatch: %; read the live definitions before replacing them',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The wake window, once (context_finished_wake_hours): the hours a finished job stays read after
-- its customer's newest real inbound message. Plain SQL, no SET, so the rule inlines it.
CREATE OR REPLACE FUNCTION public.context_finished_wake_hours() RETURNS integer
LANGUAGE sql IMMUTABLE
AS $fn$
 SELECT 720
$fn$;
COMMENT ON FUNCTION public.context_finished_wake_hours() IS
 'Finished wake (20261012093500): the owner''s 12 Oct 2026 ruling, the one wake window of a finished job in hours: 720 (30 days). A finished job (cancelled, archived, complete, completed or lost) is read again while the instant is inside this window after its customer''s newest real inbound message on the job (context_lead_monitored_jobs state finished_awake). Read by the rule only; change it here, by migration, never in a caller. Inlinable (no SET). Service role only.';

-- 2. The rule: a finished job is awake while its customer writes (20261009133000's body otherwise).
CREATE OR REPLACE FUNCTION public.context_lead_monitored_jobs(p_job_ids uuid[] DEFAULT NULL, p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, job_number text, monitored boolean, state text, quote_sent_at timestamptz, customer_at timestamptz,
 cutoff_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH k AS (SELECT coalesce(p_as_of, now()) AS t),
 -- (finished wake, 20261012093500) the finished jobs (cancelled, archived, complete, completed or
 -- lost; never a holding job, which no reader reads) that could be awake at the instant: a cheap
 -- first cut, read by the job's own rows, of those with any inbound row or old-inbox mail timed or
 -- recorded inside the wake window and a day (a message timed inside the window was recorded no
 -- earlier, so none is missed). Only these are read in full below, so the rule never reads the
 -- messages of the finished jobs nobody has written to (1,370 finished jobs on 12 Oct 2026; 61 pass)
 fin0 AS (
  SELECT jb.id, lower(nullif(btrim(jb.client_email), '')) AS cmail FROM public.jobs jb
  WHERE jb.id = ANY (p_job_ids) AND jb.status::text IN ('cancelled', 'archived', 'complete', 'completed', 'lost')
    AND coalesce(jb.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1')
  UNION ALL
  SELECT jb.id, lower(nullif(btrim(jb.client_email), '')) FROM public.jobs jb
  WHERE p_job_ids IS NULL AND jb.status::text IN ('cancelled', 'archived', 'complete', 'completed', 'lost')
    AND coalesce(jb.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1')
 ),
 fin AS MATERIALIZED (
  SELECT f.id FROM fin0 f CROSS JOIN k
  WHERE EXISTS (SELECT 1 FROM public.business_events e
                WHERE e.job_id = f.id AND e.direction = 'inbound'
                  AND greatest(coalesce(e.event_at, e.occurred_at), coalesce(e.recorded_at, e.occurred_at))
                      > k.t - make_interval(hours => public.context_finished_wake_hours() + 24))
     OR EXISTS (SELECT 1 FROM public.inbox_events i
                WHERE i.job_id = f.id AND i.received_at > k.t - make_interval(hours => public.context_finished_wake_hours() + 24))
     OR EXISTS (SELECT 1 FROM public.inbox_events i
                WHERE f.cmail IS NOT NULL AND lower(btrim(i.from_email)) = f.cmail AND i.job_id IS NULL
                  AND i.received_at > k.t - make_interval(hours => public.context_finished_wake_hours() + 24))
 ),
 ids AS (  -- the jobs asked for (each once), else every live job; (scoping pipeline, 20261009133000) every
           -- draft is read too, and listed below only while the rule monitors it; (finished wake,
           -- 20261012093500) and the finished jobs that could be awake, listed below only while they are
  SELECT jb.id FROM public.jobs jb WHERE jb.id = ANY (p_job_ids)
  UNION ALL
  SELECT jb.id FROM public.jobs jb
  WHERE p_job_ids IS NULL AND jb.status::text NOT IN ('cancelled', 'archived', 'complete', 'completed', 'lost')
  UNION ALL
  SELECT fin.id FROM fin WHERE p_job_ids IS NULL
 ),
 j AS (
  SELECT jb.id, jb.job_number, jb.status::text AS status, k.t, jb.created_at,
         -- (scoping pipeline, 20261009133000) the job's window in hours: 6 weeks on a patio job, 4 on
         -- fencing and every other type (owner, 9 Oct 2026: context_lead_window_hours)
         public.context_lead_window_hours(jb.type::text) AS win_h,
         nullif(btrim(jb.ghl_contact_id), '') AS ccontact, lower(nullif(btrim(jb.client_email), '')) AS cmail,
         -- the newest quote send by the instant: a quote document's send, else the job row's quoted stamp
         coalesce((SELECT max(d.sent_at) FROM public.job_documents d WHERE d.job_id = jb.id AND d.type = 'quote' AND d.sent_at <= k.t),
                  CASE WHEN jb.quoted_at <= k.t THEN jb.quoted_at END) AS sent_at,
         -- progress by the instant: an accepted quote (the job row's acceptance, or a quote document's)...
         (coalesce(jb.accepted_at <= k.t, false)
          OR EXISTS (SELECT 1 FROM public.job_documents d WHERE d.job_id = jb.id AND d.type = 'quote' AND d.accepted_at <= k.t)) AS accepted,
         -- ...a Xero invoice or bill on the job that is not voided or deleted, whatever its type, as the
         -- count the ruling was made on reads it (ops/golive/01b): a customer invoice (a draft, a deposit
         -- paid or not)...
         EXISTS (SELECT 1 FROM public.xero_invoices x
                 WHERE x.job_id = jb.id AND upper(coalesce(x.invoice_type, 'ACCREC')) = 'ACCREC'
                   AND upper(coalesce(x.status, '')) NOT IN ('VOIDED', 'DELETED')
                   AND coalesce(x.created_at, x.synced_at, '-infinity'::timestamptz) <= k.t) AS invoiced,
         -- ...or a supplier's bill (money paid or owed for the job's work: SWF-26106's three paid bills)...
         EXISTS (SELECT 1 FROM public.xero_invoices x
                 WHERE x.job_id = jb.id AND upper(coalesce(x.invoice_type, 'ACCREC')) <> 'ACCREC'
                   AND upper(coalesce(x.status, '')) NOT IN ('VOIDED', 'DELETED')
                   AND coalesce(x.created_at, x.synced_at, '-infinity'::timestamptz) <= k.t) AS billed,
         -- ...or a crew booking that stands (never cancelled or deleted, never a ghost or observer copy)
         EXISTS (SELECT 1 FROM public.job_assignments a
                 WHERE a.job_id = jb.id AND a.created_at <= k.t AND lower(coalesce(a.status, 'none')) NOT IN ('cancelled', 'deleted')
                   AND NOT (coalesce(a.is_ghost, false) OR coalesce(a.role, '') = 'observer')) AS booked
  FROM ids JOIN public.jobs jb ON jb.id = ids.id CROSS JOIN k
 ),
 -- the rule's leads: still at quoted (a later status is progress), a quote sent, no progress; and
 -- whether the client's address is one of our own (our domains, or a person in public.users: mail
 -- from it is never the customer's, as the record layer reads mail; SWP-26634's client address is our
 -- own mailbox, which mails all day)
 lead AS (SELECT j.id, j.created_at, j.ccontact, j.cmail,
                 coalesce(j.cmail ~ '@([a-z0-9-]+\.)*(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$'
                          OR EXISTS (SELECT 1 FROM public.users u WHERE lower(btrim(u.email)) = j.cmail), false) AS own_mail
          FROM j
          WHERE j.status = 'quoted' AND j.sent_at IS NOT NULL AND NOT j.accepted AND NOT j.invoiced AND NOT j.billed AND NOT j.booked),
 -- the customer's inbound texts, emails and calls by the instant, wherever the story finds them (R7's
 -- contact since the quote and the first line's newest customer message read the same places), so the
 -- rule never stops following up a lead beside a newer message of theirs (SWF-26189's answered call
 -- in the placement queue two days before):
 cx AS (
  -- on the job, and their old-inbox mail from the client's address placed on no job, as the story
  -- reads them (context_job_record_messages: the customer's side only, never ours, a crew or staff
  -- text, another party's, a copy, a text from before the job's lead window or one whose CRM time is
  -- not kept). Read per lead with plain arguments, so the helper is inlined and only each lead's
  -- inbound rows are read: on 7 Oct 2026 the rule read one job at a time for all 863 live jobs took
  -- 1.8 s (13.5 s with the helper run whole behind a sub-select argument), and once for all of them 2 s
  SELECT m.job_id, m.at
  FROM lead l CROSS JOIN k CROSS JOIN LATERAL public.context_job_record_messages(ARRAY[l.id], k.t) m
  WHERE m.customer_side AND m.direction = 'inbound' AND m.channel IN ('sms', 'email', 'call')
    AND m.placement IN ('on_job', 'not_placed') AND m.at <= k.t
  UNION ALL
  -- their mail from the client's address in the old inbox, wherever the old matcher put it: on the job,
  -- on no job (withheld because they have another job, or not) or on another job; never an auto-reply,
  -- and none when the client's address is one of our own. Every mail the story names from there
  -- (context_job_record_legacy_mail) is among them; a saved copy elsewhere changes nothing here, as a
  -- copy is the customer's message too. Read by the old inbox's sender index
  SELECT l.id, i.received_at
  FROM lead l JOIN public.inbox_events i ON l.cmail IS NOT NULL AND NOT l.own_mail AND lower(btrim(i.from_email)) = l.cmail
  WHERE i.received_at <= (SELECT k.t FROM k) AND coalesce(i.subject, '') !~* '^(automatic reply|auto[- ]?reply|out of office)'
  UNION ALL
  -- their messages off the job, as R7 and the story's off-job facts read them: the placement queue's
  -- that could be this job's, their admin bucket's and those on a holding job (context_unplaced_for_job),
  -- and every other one of their CRM contact's, placed on no job whatever the ladder made of it or on
  -- another job of theirs; the customer's (sender or counterpart customer), not a copy, recorded by the
  -- instant, a CRM text loaded later from the cache at its CRM time (never one whose CRM time is not
  -- kept, nor one the CRM dates more than 30 days before the job was created)
  SELECT o.job_id, o.at
  FROM (
   SELECT l.id AS job_id, l.created_at AS job_created, u.event_type, u.channel, u.direction, u.source, u.contact_id, u.payload,
          u.provider_message_id, u.metadata, u.event_at, u.occurred_at, u.recorded_at
   FROM lead l CROSS JOIN LATERAL public.context_unplaced_for_job(l.id) u
   UNION ALL
   SELECT l.id, l.created_at, e.event_type, e.channel, e.direction, e.source, e.contact_id, e.payload, e.provider_message_id,
          e.metadata, e.event_at, e.occurred_at, e.recorded_at
   FROM lead l JOIN public.business_events e ON l.ccontact IS NOT NULL AND e.contact_id = l.ccontact AND e.job_id IS DISTINCT FROM l.id
   WHERE e.job_id IS NOT NULL OR coalesce(e.attribution_status, '') NOT IN ('pending_luna', 'unplaced', 'admin_bucket', 'automated')
  ) x
  CROSS JOIN LATERAL (SELECT CASE WHEN x.source = 'ghl_sms_cache_backfill'
                                  THEN public.context_job_record_crm_time(x.source, x.contact_id,
                                         coalesce(nullif(btrim(x.payload ->> 'ghl_message_id'), ''), substring(x.provider_message_id FROM '^ghl:(.+)$')), x.job_id)
                             END AS crm_at) ct
  CROSS JOIN LATERAL (SELECT x.job_id, coalesce(ct.crm_at, x.event_at, x.occurred_at) AS at) o
  WHERE x.direction = 'inbound' AND x.metadata #>> '{duplicate_of}' IS NULL
    AND (x.channel IN ('sms', 'email', 'call')
         OR x.event_type IN ('client.reply', 'client.sms_in', 'client.email_in', 'client.call_logged', 'client.call_complete', 'call.transcript_completed'))
    AND coalesce(x.metadata #>> '{party_roles,sender_role}', x.metadata #>> '{party_roles,counterpart_role}',
                 CASE WHEN x.event_type LIKE 'client.%' THEN 'customer' END) = 'customer'
    AND NOT (x.source = 'ghl_sms_cache_backfill' AND ct.crm_at IS NULL)
    AND NOT coalesce(ct.crm_at < x.job_created - interval '30 days', false)
    AND coalesce(x.recorded_at, x.occurred_at) <= (SELECT k.t FROM k) AND o.at <= (SELECT k.t FROM k)
  UNION ALL
  -- their email from the client's address with no CRM contact (a mail matched only by the address),
  -- placed on no job or on a job no reader reads (a bucket: archived, complete, completed, cancelled,
  -- lost, a draft, or holding), as R7 reads it; none when the client's address is one of our own;
  -- read by the inbound mail sender index
  SELECT l.id, coalesce(e.event_at, e.occurred_at)
  FROM lead l JOIN public.business_events e
    ON l.cmail IS NOT NULL AND NOT l.own_mail AND e.event_type IN ('supplier.email_in', 'client.email_in')
   AND lower(btrim(coalesce(substring(e.payload ->> 'from', '<([^<>]*)>'), e.payload ->> 'from'))) = l.cmail
  LEFT JOIN public.jobs oj ON oj.id = e.job_id
  WHERE e.contact_id IS NULL AND e.job_id IS DISTINCT FROM l.id AND e.metadata #>> '{duplicate_of}' IS NULL
    AND coalesce(e.recorded_at, e.occurred_at) <= (SELECT k.t FROM k) AND coalesce(e.event_at, e.occurred_at) <= (SELECT k.t FROM k)
    AND (e.job_id IS NULL OR oj.status::text IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
         OR coalesce(oj.metadata ->> 'do_not_schedule', '') IN ('true', '1'))
 ),
 cm AS (SELECT cx.job_id, max(cx.at) AS at FROM cx GROUP BY cx.job_id),
 -- (scoping pipeline, 20261009133000) a draft's newest real activity by the instant, on the draft
 -- itself only (never what sits on another job or on no job, so a customer's second booking draft
 -- is not kept up by the first one's messages, and a draft nobody touches is never monitored);
 -- read once per draft:
 da AS MATERIALIZED (
  SELECT d.id, greatest(
   -- a message placed on it: a text, email, call, call recording or staff note (the ledger's message
   -- kinds), never a marked copy or a retracted row (context_event_source_admissible), never
   -- status-only, a workflow text or one of our crew or staff templates (context_internal_text_role),
   -- never mail among our own people (who-to-whom audience internal: a canary job whose client is
   -- one of our mailboxes), never a document's extracted text; a CRM text loaded later from the
   -- cache at its CRM time, never one whose CRM time is not kept (context_job_record_crm_time)
   (SELECT max(coalesce(ct.crm_at, e.event_at, e.occurred_at))
    FROM public.business_events e
    CROSS JOIN LATERAL (SELECT CASE WHEN e.source = 'ghl_sms_cache_backfill'
                                    THEN public.context_job_record_crm_time(e.source, e.contact_id,
                                           coalesce(nullif(btrim(e.payload ->> 'ghl_message_id'), ''), substring(e.provider_message_id FROM '^ghl:(.+)$')), e.job_id)
                               END AS crm_at) ct
    WHERE e.job_id = d.id AND public.context_event_source_admissible(e) AND public.context_ledger_message_kind(e)
      AND NOT public.context_event_status_only(e) AND coalesce(e.channel, '') <> 'document' AND e.event_type <> 'document.text_extracted'
      AND coalesce(e.payload ->> 'sent_by_kind', '') <> 'workflow' AND public.context_internal_text_role(e) = 'other'
      AND coalesce(e.metadata #>> '{party_roles,audience}', e.metadata ->> 'audience', '') <> 'internal'
      AND NOT (e.source = 'ghl_sms_cache_backfill' AND ct.crm_at IS NULL)
      AND coalesce(e.recorded_at, e.occurred_at) <= d.t AND coalesce(ct.crm_at, e.event_at, e.occurred_at) <= d.t),
   -- the customer's old-inbox email placed on it: from the client's own address (never when that is
   -- one of our own: our domains, or a person in public.users), never spam, a newsletter or an
   -- auto-reply, with no saved copy (a copy, wherever it is placed, decides); the old matcher's other
   -- guesses (a council's or our own mail filed on a draft) are no activity of the draft's
   (SELECT max(i.received_at) FROM public.inbox_events i
    WHERE i.job_id = d.id AND d.cmail IS NOT NULL AND lower(btrim(i.from_email)) = d.cmail
      AND NOT coalesce(d.cmail ~ '@([a-z0-9-]+\.)*(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$'
                       OR EXISTS (SELECT 1 FROM public.users u WHERE lower(btrim(u.email)) = d.cmail), false)
      AND i.received_at <= d.t AND coalesce(i.classification, '') NOT IN ('spam', 'newsletter')
      AND coalesce(i.subject, '') !~* '^(automatic reply|auto[- ]?reply|out of office)'
      AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table = 'inbox_events' AND b.source_id = i.id::text)
      AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE i.graph_message_id IS NOT NULL AND b.provider_message_id = 'graph:' || i.graph_message_id)),
   -- a quote of it sent, viewed, accepted or declined
   (SELECT max(x.at) FROM public.job_documents q CROSS JOIN LATERAL (VALUES (q.sent_at), (q.viewed_at), (q.accepted_at), (q.declined_at)) x(at)
    WHERE q.job_id = d.id AND q.type = 'quote' AND x.at <= d.t),
   -- an app event on it (a scope saved in the scoping tool, a quote or work order made, a note, a
   -- photo or document, a status change, a booking, an invoice...), never a machine row: the job
   -- created, the CRM link or stage sync, the scoping tool's refused, repeated or identity-warned
   -- saves and its version bumps, or a clean-up (a dedupe, the hygiene sweep, an orphan draft restored)
   (SELECT max(x.created_at) FROM public.job_events x
    WHERE x.job_id = d.id AND x.created_at <= d.t
      AND x.event_type NOT IN ('job_created', 'ghl_linked', 'ghl_stage_synced', 'scope_save_rejected', 'scope_save_idempotent',
        'scope_save_identity_warning', 'scope_version_updated', 'deduped_orphan', 'archived_by_hygiene_sweep',
        'orphan_draft_archived_after_scope_restore', 'scope_restored_from_orphan_draft'))) AS at
  FROM j d WHERE d.status = 'draft'
 ),
 -- (finished wake, 20261012093500) the owner's 12 Oct 2026 ruling: a finished job is read again
 -- while its customer writes. The customer's newest real inbound message by the instant, as the
 -- story reads the job's own messages (context_job_record_messages: a text, email or call, the
 -- customer's side only; on the job, or their old-inbox mail from the client's address on no job
 -- when they have no other job; never ours, staff's or crew's, another party's (a supplier, a
 -- builder, a neighbour), a workflow text or one of our templates, a copy, a text from before the
 -- job's lead window or one whose CRM time is not kept). Never a message on another job or in the
 -- placement queue: the reader reads only what is on the job. Only a message timed inside the wake
 -- window is read. Read per candidate with plain arguments, so the helper is inlined, and bounded
 -- by the function's own argument (never a joined column), so the planner carries the window into
 -- the helper's old-inbox read: on 12 Oct 2026 the 61 candidates took 0.46 s this way and 6.5 s
 -- with the helper reading each client address's whole mail history
 fw AS MATERIALIZED (
  SELECT f.id, max(m.at) AS at
  FROM fin f CROSS JOIN LATERAL public.context_job_record_messages(ARRAY[f.id], coalesce(p_as_of, now())) m
  WHERE m.customer_side AND m.direction = 'inbound' AND m.channel IN ('sms', 'email', 'call')
    AND m.placement IN ('on_job', 'not_placed') AND NOT m.automated AND NOT m.internal
    AND m.at <= coalesce(p_as_of, now())
    AND m.at > coalesce(p_as_of, now()) - make_interval(hours => public.context_finished_wake_hours())
  GROUP BY f.id
 ),
 -- the window after the newer of the two (28 days; 42 on a patio job since 20261009133000), in hours,
 -- so no session time zone moves it; (scoping pipeline) a draft's window runs from the newer of its
 -- newest real activity and its creation, and a draft with no real activity has none
 r AS (
  SELECT j.*, CASE WHEN l.id IS NOT NULL THEN cm.at WHEN fw.id IS NOT NULL THEN fw.at END AS customer_at,
         CASE WHEN l.id IS NOT NULL THEN greatest(j.sent_at, cm.at) + make_interval(hours => j.win_h)
              WHEN da.at IS NOT NULL THEN greatest(da.at, j.created_at) + make_interval(hours => j.win_h)
              -- (finished wake, 20261012093500) a finished job is awake for the wake window (30 days)
              -- after its customer's newest real inbound message
              WHEN fw.id IS NOT NULL THEN fw.at + make_interval(hours => public.context_finished_wake_hours()) END AS cutoff_at,
         da.at AS active_at,
         j.status IN ('cancelled', 'archived', 'complete', 'completed', 'lost') AS finished
  FROM j LEFT JOIN lead l ON l.id = j.id LEFT JOIN cm ON cm.job_id = j.id LEFT JOIN da ON da.id = j.id
  LEFT JOIN fw ON fw.id = j.id
 )
 SELECT r.id, r.job_number,
        -- (scoping pipeline, 20261009133000) a draft is monitored only inside its window, never with no real activity
        -- (finished wake, 20261012093500) a finished job's monitored is what it always was (true: its
        -- cutoff is null or ahead; the rule's false is a lead no longer followed up or a quiet draft,
        -- on which the story says its lead words); whether a reader reads it is its state
        CASE WHEN r.status = 'draft' THEN coalesce(r.t < r.cutoff_at, false) ELSE NOT coalesce(r.t >= r.cutoff_at, false) END,
        CASE WHEN r.status = 'draft' THEN CASE WHEN r.active_at IS NULL THEN 'draft_no_activity'
                                               WHEN r.t >= r.cutoff_at THEN 'draft_quiet' ELSE 'draft_active' END
             -- (finished wake, 20261012093500) awake while the customer has a real inbound message
             -- inside the wake window; a quiet finished job's row is what it always was (not_quoted)
             WHEN r.finished AND coalesce(r.t < r.cutoff_at, false) THEN 'finished_awake'
             WHEN r.status IS DISTINCT FROM 'quoted' THEN 'not_quoted'
             WHEN r.sent_at IS NULL THEN 'quote_not_sent'
             WHEN r.accepted THEN 'accepted' WHEN r.invoiced THEN 'invoiced' WHEN r.billed THEN 'billed' WHEN r.booked THEN 'booked'
             WHEN r.t >= r.cutoff_at THEN 'not_followed_up'
             ELSE 'within_' || (r.win_h / 168)::text || '_weeks' END,
        r.sent_at, r.customer_at, r.cutoff_at
 FROM r
 -- (scoping pipeline, 20261009133000) with no ids, a draft is listed only while the rule monitors it
 -- (finished wake, 20261012093500) and a finished job only while it is awake
 WHERE p_job_ids IS NOT NULL OR (r.status IS DISTINCT FROM 'draft' AND NOT r.finished) OR coalesce(r.t < r.cutoff_at, false)
 ORDER BY r.id
$fn$;
COMMENT ON FUNCTION public.context_lead_monitored_jobs(uuid[], timestamptz) IS
 'Lead cutoff (20261007010000): (scoping pipeline, 20261009133000) (finished wake, 20261012093500) the owner''s 12 Oct 2026 ruling: a finished job (status cancelled, archived, complete, completed or lost; never a holding job, metadata.do_not_schedule) is read again while its customer writes. Its state is finished_awake while p_as_of is before cutoff_at, the wake window (context_finished_wake_hours: 720 hours, 30 days) after customer_at, the customer''s newest real inbound message on the job by p_as_of as the story reads the job''s own messages (context_job_record_messages: a text, email or call, the customer''s side only; on the job, or their old-inbox mail from the client''s address on no job when they have no other job; never ours, staff''s or crew''s, another party''s such as a supplier, a builder or a neighbour, a workflow text or one of our templates, a copy, a text from before the job''s lead window or one whose CRM time is not kept; never a message on another job or in the placement queue, which no reader of this job reads); else its row is what it always was (state not_quoted, customer_at and cutoff_at null; only a message timed inside the window is read, and only for a job with any inbound row or old-inbox mail timed or recorded inside the window and a day, the rule''s cheap first cut). With p_job_ids null a finished job is listed only while it is awake (a quiet one is not live, as every finished job was before); with ids, every job asked for. A finished job''s monitored is true as it always was (false stays a lead no longer followed up or a quiet draft, on which the story says its lead words): whether a reader reads a finished job is its state, which the ledger judge and the due list read. It is quiet again 30 days after the customer''s last message, and its notes stay. Earlier (scoping pipeline): the owner''s 9 Oct 2026 ruling: drafts are read, and each window is its job type''s (context_lead_window_hours: 6 weeks on a patio job, 4 weeks on fencing and every other type). A draft (status draft: scoping, and patio quoting, which stays at draft until accepted) is monitored only while p_as_of is before cutoff_at, its window after the newer of its newest real activity and its creation; one with no real activity is never monitored (junk and duplicate booking drafts). Real activity is what happened on the draft itself by p_as_of, never on another job or on no job: a message placed on it (a text, email, call, call recording or staff note; never a marked copy or a retracted row, status-only, a workflow text, one of our crew or staff templates, mail among our own people (who-to-whom audience internal) or a document''s extracted text; a CRM text loaded later from the cache at its CRM time, never one whose CRM time is not kept); the customer''s old-inbox email placed on it from the client''s own address (never one of our own addresses) with no saved copy (never spam, a newsletter or an auto-reply); a quote of it sent, viewed, accepted or declined; an app event (job_events) other than the machine rows (job_created, ghl_linked, ghl_stage_synced, scope_save_rejected, scope_save_idempotent, scope_save_identity_warning, scope_version_updated, deduped_orphan, archived_by_hygiene_sweep, orphan_draft_archived_after_scope_restore, scope_restored_from_orphan_draft): a scope saved in the scoping tool counts. A draft''s state is draft_active (monitored), draft_quiet (its window has run out) or draft_no_activity (cutoff_at null); quote_sent_at is its newest quote send and customer_at is null. With p_job_ids null every live job is listed, a draft only while the rule monitors it (a draft it does not is not live, as every draft was before); with ids, every job asked for. A lead at quoted keeps the rule below in its type''s window: state within_4_weeks, or within_6_weeks on a patio job, then not_followed_up 4 or 6 weeks after the newer of its newest quote send and the customer''s newest message. Earlier (lead cutoff): the owner''s 7 Oct 2026 ruling, the one lead rule. One row per job in p_job_ids that exists (each once), or per live job (status not cancelled, draft, archived, complete, completed or lost) when p_job_ids is null, as of p_as_of (null: now). monitored is false only for a lead no longer followed up: still at quoted (jobs.status), a quote sent by p_as_of (quote_sent_at: the newest job_documents type quote sent_at, else jobs.quoted_at), no progress by p_as_of (no accepted quote: the job row''s accepted_at or a quote document''s; no Xero invoice or bill on the job that is not voided or deleted, whatever its type, as the count the ruling was made on reads it: a customer invoice, or a supplier''s bill; no crew booking that stands, never a ghost or observer copy; no later status) and p_as_of at or past cutoff_at, 28 days (672 hours) after the newer of quote_sent_at and customer_at, the customer''s newest inbound text, email or call wherever the story finds it: on the job (context_job_record_messages: the customer''s side only; never ours, a crew or staff text, another party''s or a copy), their mail from the client''s address in the old inbox wherever the old matcher put it (on the job, on no job, withheld because they have another job or not, or on another job; never an auto-reply), their messages placed on no job (the placement queue''s that could be this job''s, their admin bucket''s, on a holding job, or any other of their CRM contact''s) or on another job of theirs, and their email from the client''s address with no CRM contact on no job or a job no reader reads; a CRM text loaded later from the cache at its CRM time, never one whose CRM time is not kept or that the CRM dates more than 30 days before the job was created; no mail by the client''s address when that address is one of our own (our domains, or a person in public.users). Every customer contact the story''s first line names is one it counts. It is monitored again the moment it progresses or the customer writes; a quote never sent starts no clock. state: not_quoted, quote_not_sent, accepted, invoiced (a customer invoice), billed (a supplier''s bill, no customer invoice), booked, within_4_weeks or not_followed_up. customer_at and cutoff_at are set for leads only (states within_4_weeks and not_followed_up). Ordered by job id. Read by the record loops (R7), the story read and the ledger judge; the scorecard reads it. SECURITY DEFINER with search_path public, pg_temp (the record layer''s crew and staff helper is not the service role''s to call). Service role only.';
-- The one-job form (context_lead_monitored, its body unchanged: the set form's row) says what it now
-- returns.
COMMENT ON FUNCTION public.context_lead_monitored(uuid, timestamptz) IS
 'Lead cutoff (20261007010000): (scoping pipeline, 20261009133000) the one lead rule (context_lead_monitored_jobs) for one job as of p_as_of (null: now): that job''s row (job_id, job_number, monitored, state, quote_sent_at, customer_at, cutoff_at), a draft''s too; monitored false for a lead still at quoted with no progress in its window (context_lead_window_hours: 6 weeks on a patio job, else 4) after the newer of its newest quote send and the customer''s newest text, email or call, and for a draft with no real activity inside its window (state draft_quiet or draft_no_activity); (finished wake, 20261012093500) for a finished job (cancelled, archived, complete, completed or lost) monitored is true as before and state says whether a reader reads it: finished_awake inside 30 days (context_finished_wake_hours) of the customer''s newest real inbound message on the job, else not_quoted as before; no row for a job that does not exist. A set of job_id and monitored, as the readers that detect the rule expect; a reader of many jobs calls context_lead_monitored_jobs once instead. SECURITY DEFINER with search_path public, pg_temp. Service role only. Earlier (lead cutoff): monitored false only for a lead still at quoted with no progress 28 days after the newer of its newest quote send and the customer''s newest text, email or call; a draft was never in the live set.';

-- 3. The judge: a finished job is a live job only while the rule calls it awake (20261009133000's
-- body otherwise).
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
 ), j0 AS (
  SELECT jb.id, jb.status::text AS status,
   jb.status::text NOT IN ('cancelled','archived','complete','completed','lost') AS open_job,
   coalesce(jb.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1') AS schedulable
  FROM public.jobs jb WHERE jb.id = ANY(p_job_ids)
 ), lr AS MATERIALIZED (
  -- (scoping pipeline, 20261009133000) the lead rule's row as of now, read once, for every job asked
  -- about, a draft among them (context_lead_monitored_jobs); (finished wake, 20261012093500) and a
  -- finished job, whose state says whether its customer has written inside the wake window
  SELECT m.job_id, m.monitored, m.state FROM public.context_lead_monitored_jobs(ARRAY(SELECT j0.id FROM j0), now()) m
 ), j AS (
  -- (scoping pipeline, 20261009133000) a draft is live only while the rule monitors it (real activity
  -- on it inside its window: 4 weeks, 6 on a patio job); one it does not is not_live, as every draft was.
  -- (Finished wake, 20261012093500) A finished job (cancelled, archived, complete, completed or lost)
  -- is live only while the rule calls it awake (state finished_awake: a real inbound message of its
  -- customer's on it inside 30 days); a quiet one is not_live, as every finished job was
  SELECT j0.id, (j0.open_job AND (j0.status <> 'draft' OR coalesce(lr.monitored, false)))
                OR (NOT j0.open_job AND coalesce(lr.state = 'finished_awake', false)) AS live_job, j0.schedulable
  FROM j0 LEFT JOIN lr ON lr.job_id = j0.id
 ), lo AS (
  -- (lead cutoff, 20261007010000) a live job that is a lead no longer followed up (still at quoted
  -- with no progress 28 days, 42 on a patio job since 20261009133000, after the newer of its newest
  -- quote send and the customer's newest text, email or call, wherever it is placed:
  -- context_lead_monitored_jobs, now) is not due a read, and its evidence is never read in full for
  -- the judgement
  SELECT lr.job_id FROM lr JOIN j ON j.id = lr.job_id WHERE j.live_job AND NOT lr.monitored
 ), cur AS (
  SELECT j.id AS job_id, public.context_ledger_current_generation(j.id) AS gid FROM j
 ), g AS (
  SELECT c.job_id, gen.id, gen.status, gen.reader, gen.evidence_until, gen.created_at, gen.checks
  FROM cur c JOIN public.context_ledger_generations gen ON gen.id = c.gid
 ), wait AS (
  -- (notes freshness, 20261009132000) the reading the go-live sweep would put live in place of a
  -- live one (context_ledger_promote_shadow's own choice): the job's newest shadow, newer than the
  -- live reading, by the current reader and passing its checks
  SELECT n.job_id, n.id, n.evidence_until
  FROM g CROSS JOIN s CROSS JOIN LATERAL (
   SELECT x.job_id, x.id, x.evidence_until, x.reader, x.checks, x.created_at FROM public.context_ledger_generations x
   WHERE x.job_id = g.job_id AND x.status = 'shadow' ORDER BY x.created_at DESC, x.id DESC LIMIT 1) n
  WHERE g.status = 'live' AND n.created_at > g.created_at AND n.reader = s.reader AND public.context_ledger_checks_pass(n.checks)
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
  -- job's lead window, so it may hold none: story safety, 20261006040000). (Notes freshness,
  -- 20261009132000) Also a job whose waiting shadow may not have read a row (the answer below).
  SELECT j.id FROM j LEFT JOIN g ON g.job_id = j.id LEFT JOIN cbe ON cbe.job_id = j.id LEFT JOIN cib ON cib.job_id = j.id
  LEFT JOIN wait w ON w.job_id = j.id
  WHERE j.live_job AND NOT EXISTS (SELECT 1 FROM lo WHERE lo.job_id = j.id)
   AND (CASE WHEN g.id IS NULL THEN (coalesce(cbe.n, 0) = 0 AND coalesce(cib.n, 0) > 0)
                                                    OR (coalesce(cbe.n, 0) > 0 AND cbe.n = cbe.bf)
                             ELSE g.evidence_until IS NULL OR greatest(cbe.newest, cib.newest) > g.evidence_until END
        OR (w.job_id IS NOT NULL AND (w.evidence_until IS NULL OR greatest(cbe.newest, cib.newest) > w.evidence_until)))
 ), er AS MATERIALIZED (
  SELECT r.job_id, r.src_id, r.at, r.landed_at, r.copy_of, r.automated
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
  -- it only while the job backs off. (Notes freshness, 20261009132000) Only the one the
  -- go-live sweep would promote (wait), and only while it has read every row by the one rule
  -- (context_ledger_row_unread): the sweep never promotes a reading with a row it has not read,
  -- and a shadow beside a live reading is never updated, so such a one would wait for ever.
  SELECT w.job_id FROM wait w
  WHERE NOT EXISTS (SELECT 1 FROM er r WHERE r.job_id = w.job_id AND r.copy_of IS NULL
                     AND public.context_ledger_row_unread(r.landed_at, r.automated, w.evidence_until))
 ), unr AS (
  -- (notes freshness, 20261009132000) the newest landing of a row the job's reading has not read
  -- by the one rule (not automated, landed after its evidence_until; copies left out). Read in
  -- full wherever a row can have landed after the reading, so a job not read in full has none.
  SELECT r.job_id, max(r.landed_at) AS newest
  FROM er r JOIN g ON g.job_id = r.job_id
  WHERE r.copy_of IS NULL AND public.context_ledger_row_unread(r.landed_at, r.automated, g.evidence_until)
  GROUP BY r.job_id
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
    WHEN f.backoff_until > now() OR b.building_lapsed_recent THEN 'backoff' END AS blocked,
   -- (notes freshness, 20261009132000) a row the reading has not read landed after the last failed
   -- read ended (a read that lost its building lease in the last 2 hours still holds the job)
   coalesce(u.newest > coalesce(f.last_failure_at, '-infinity'::timestamptz) AND NOT b.building_lapsed_recent, false) AS fresh
  FROM j CROSS JOIN s LEFT JOIN ev ON ev.job_id = j.id LEFT JOIN g ON g.job_id = j.id
  LEFT JOIN moved m ON m.job_id = j.id LEFT JOIN answered a ON a.job_id = j.id LEFT JOIN late lt ON lt.job_id = j.id
  LEFT JOIN fail f ON f.job_id = j.id LEFT JOIN busy b ON b.job_id = j.id LEFT JOIN lo ON lo.job_id = j.id
  LEFT JOIN unr u ON u.job_id = j.id
 )
 SELECT d.job_id, d.blk IS NULL AND d.reason IS NOT NULL,
  CASE WHEN d.reason IS NULL THEN NULL WHEN d.reason = 'never_read' THEN 'backfill' WHEN d.reason = 'new_evidence' THEN 'update'
   ELSE 'rebuild' END,
  d.reason,
  CASE d.reason WHEN 'citation_moved' THEN 1 WHEN 'new_evidence' THEN 1 WHEN 'late_evidence' THEN 1 WHEN 'never_read' THEN 2
   WHEN 'reader_changed' THEN 3 WHEN 'checks_failed' THEN 3 END,
  d.newest, d.n, d.gid, d.blk
 FROM (  -- backfills and rebuilds wait for the backfill hours; an update is never held, (notes
         -- freshness, 20261009132000) nor held back by the backoff of failed reads for a row that
         -- landed after the last of them ended: the reading reads it at once
  SELECT d0.*, coalesce(CASE WHEN d0.blocked = 'backoff' AND d0.reason = 'new_evidence' AND d0.fresh THEN NULL ELSE d0.blocked END,
                        CASE WHEN NOT s.window_open AND d0.reason IS NOT NULL AND d0.reason <> 'new_evidence'
                             THEN 'outside_window' END) AS blk
  FROM judged d0 CROSS JOIN s) d
$$;
COMMENT ON FUNCTION public.context_ledger_judge(uuid[]) IS
 'Context ledger store (20261006013000), story safety (20261006040000): (scoping pipeline, 20261009133000) (finished wake, 20261012093500) The owner''s 12 Oct 2026 ruling: a finished job (cancelled, archived, complete, completed or lost) is live, and so due a read as any live job (never read: a backfill; a new message: an update), only while the lead rule calls it awake (context_lead_monitored_jobs state finished_awake: a real inbound message of its customer''s on the job inside 30 days, context_finished_wake_hours); a quiet one is blocked not_live, as every finished job was, and its notes stay. The rule is read once for every job asked about. Earlier (scoping pipeline): The lead rule is read once for unfinished jobs including drafts; a draft is live only while monitored from its own activity inside four weeks (six for patio), else blocked not_live. (notes freshness, 20261009132000) a row a reading has not read is the ledger''s one rule (context_ledger_row_unread: a row of the evidence that is not automated and landed after the reading''s evidence_until, copies left out; landing covers a row whose own time is earlier, such as a late call transcript, a late-captured email or a backfilled text). An update is never held by the backoff of failed reads for such a row that landed after the last failed read ended (a read that lost its building lease in the last 2 hours still holds the job; a backfill or rebuild backs off as before). A rebuild of a live reading (moved citation, changed reader) is answered only by the reading the go-live sweep would promote: the job''s newest shadow, newer than the live one, by the current reader, passing its checks, with no row it has not read; the sweep never promotes one with such a row and a shadow beside a live reading is never updated, so such a one answers nothing. Earlier (lead cutoff, 20261007010000) blocked lead_not_monitored: a live job that is a lead no longer followed up (context_lead_monitored_jobs as of now: still at quoted with no acceptance, Xero invoice or bill, booking or later status 28 days after the newer of its newest quote send and the customer''s newest text, email or call, wherever it is placed) is never due a read, so context_ledger_due never lists it and a claim answers not_due; its evidence is not read in full. It is due again the moment it progresses or the customer writes. Earlier (eighth review) citation_moved also takes an item whose citation the citation check refuses now, as the story''s ledger read re-checks it: a CRM text loaded from the cache whose CRM time is not kept or is more than 30 days before the job was created, and an old-inbox mail now placed on another job (or from the client''s address on no job while the client has another job, or from before the job''s lead window), not worded, spam, a newsletter or an auto-reply, or with a saved copy on this job or another live job (the judge''s live set); a mail''s copies time it from when one left a live job (context_ledger_mail_copies). Earlier: a legacy mail whose saved copy sits on another job or on no job counts from when it can have joined the job''s evidence (context_ledger_mail_copies: no earlier than that rule''s first apply and the copy''s own landing), in the quick read (for a job with a reading) as in the full one, so a reading built before then is never taken to have read it and the job is due; (seventh review) one whose copy sits on another live job is not this job''s evidence at all: the full read leaves it out, and the quick read, a superset, may only overstate by it and then reads the job in full; a never-read job''s quick read is as before, except that a never-read job whose admitted rows are all CRM texts loaded from the cache (source ghl_sms_cache_backfill) is read in full, since the evidence leaves out one dated before the job''s lead window and so may hold none (then it is no_evidence, never a backfill of nothing). Earlier: the one ledger due judgement per job (the full evidence read only for a job whose reading may have newer evidence or whose only possible evidence is legacy mail; elsewhere a count and newest landed time of the admitted rows decide the same; evidence_rows is then that count): kind backfill (never_read), update (new_evidence: the current generation''s evidence_until is older than the newest admissible evidence), or rebuild (checks_failed: the current reading is a shadow whose checks.passed is false; citation_moved: an item cites a business_events row now gone, off the job or not admissible; reader_changed; late_evidence: the earliest unread row is more than 14 days older than evidence_until, or more than 150 already-read rows follow it). A rebuild of the live reading for a moved citation or a changed reader is not due while a newer passing shadow by the current reader waits for promotion. Blocked: ledger_off, lane_off, not_in_rollout (settings.job_ids is set and does not list the job), not_live, holding_job, no_evidence, busy (a live building generation or a running ledger run), needs_person (three builds in a row failed their checks: context_ledger_failures), backoff (consecutive failed or check-failed runs: 2 hours, 8 hours, the next Perth day, then 7 days; or a building generation that lost its lease in the last 2 hours), outside_window (a backfill or rebuild outside the settings backfill hours; an update is never held). A person-locked item is never a moved citation (a rebuild would carry it back). Service role only.';

-- 4. The due list: the finished jobs the rule calls awake are judged too (20261009133000's body
-- otherwise).
CREATE OR REPLACE FUNCTION public.context_ledger_due(p_limit integer DEFAULT 20)
RETURNS TABLE(job_id uuid, kind text, reason text, priority integer, newest_evidence_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH st AS (SELECT x.mode, x.job_ids FROM public.context_ledger_settings x WHERE x.id),
 d AS MATERIALIZED (
  SELECT jd.job_id, jd.kind, jd.reason, jd.priority, jd.newest_evidence_at, jd.generation_id
  FROM public.context_ledger_judge(ARRAY(
    -- only jobs the judgement could find due: live, the lane on, in the rollout list
    SELECT jb.id FROM public.jobs jb, st
    WHERE jb.status::text NOT IN ('cancelled','draft','archived','complete','completed','lost')
     AND st.mode <> 'off' AND public.automation_lane_enabled('extraction')
     AND (st.job_ids IS NULL OR jb.id = ANY(st.job_ids))
    UNION ALL
    -- (scoping pipeline, 20261009133000) drafts that the lead rule monitors from real activity on
    -- that draft inside its window; they enter the same judge and freshness ordering as live jobs
    SELECT m.job_id FROM public.context_lead_monitored_jobs(ARRAY(
      SELECT jb.id FROM public.jobs jb, st
      WHERE jb.status::text = 'draft' AND st.mode <> 'off' AND public.automation_lane_enabled('extraction')
       AND (st.job_ids IS NULL OR jb.id = ANY(st.job_ids))), now()) m
    WHERE m.monitored
    UNION ALL
    -- (finished wake, 20261012093500) finished jobs the lead rule calls awake (a real inbound message
    -- of the customer's on the job inside 30 days); they enter the same judge and freshness ordering
    SELECT m.job_id FROM public.context_lead_monitored_jobs(ARRAY(
      SELECT jb.id FROM public.jobs jb, st
      WHERE jb.status::text IN ('cancelled','archived','complete','completed','lost') AND st.mode <> 'off'
       AND public.automation_lane_enabled('extraction')
       AND (st.job_ids IS NULL OR jb.id = ANY(st.job_ids))), now()) m
    WHERE m.state = 'finished_awake')) jd
  WHERE jd.due
 ), w AS (
  -- (notes freshness, 20261009132000) since when each due job's reading has not read a row by the
  -- ledger's one rule (context_ledger_row_unread; copies left out): the earliest landing of one
  SELECT r.job_id, min(r.landed_at) AS since
  FROM public.context_ledger_evidence_rows(ARRAY(SELECT d.job_id FROM d WHERE d.generation_id IS NOT NULL), now()) r
  JOIN d ON d.job_id = r.job_id JOIN public.context_ledger_generations g ON g.id = d.generation_id
  WHERE r.copy_of IS NULL AND public.context_ledger_row_unread(r.landed_at, r.automated, g.evidence_until)
  GROUP BY r.job_id
 )
 SELECT d.job_id, d.kind, d.reason, d.priority, d.newest_evidence_at
 FROM d LEFT JOIN w ON w.job_id = d.job_id
 -- within a priority the updates first (cheap, never held by the backfill hours, and what keeps a
 -- reading current; a rebuild a reader skips once read that day never pushes them out of a capped
 -- page), each by the longest wait for a row it has not read, so a busy job's newest messages never
 -- keep an older one waiting; then the rest newest evidence first
 ORDER BY d.priority, d.kind IS DISTINCT FROM 'update', w.since NULLS LAST, d.newest_evidence_at DESC NULLS LAST, d.job_id
 LIMIT greatest(0, least(coalesce(p_limit, 20), 200))
$$;
COMMENT ON FUNCTION public.context_ledger_due(integer) IS
 'Context ledger store (20261006013000): (scoping pipeline, 20261009133000) (finished wake, 20261012093500) The finished jobs the lead rule calls awake (cancelled, archived, complete, completed or lost, with a real inbound message of the customer''s on the job inside 30 days: context_lead_monitored_jobs state finished_awake) enter the same due list and freshness order as other live jobs; a quiet finished job is never listed. Earlier (scoping pipeline): The drafts the lead rule monitors enter the same due list and freshness order as other live jobs. (notes freshness, 20261009132000) within a priority the updates come first, then the rest, and within each the job whose reading has waited longest for a row it has not read by the ledger''s one rule (context_ledger_row_unread: not automated, landed after its evidence_until; copies left out) comes first, by the earliest landing of one, so a busy job''s newest messages never keep an older one waiting and a rebuild a reader skips once read that day never pushes an update out of a capped page; then the rest newest evidence first. The priorities are the judge''s, unchanged. Earlier: live jobs due a ledger read now (context_ledger_judge), new evidence and moved citations first, then never-read jobs newest evidence first, then reader changes. At most 200. Empty while context_ledger_settings.mode is off or the extraction lane is off; only jobs on settings.job_ids when that rollout list is set. Service role only.';

-- 5. Access: service role only (CREATE OR REPLACE keeps a replaced function's grants; said again).
REVOKE ALL ON FUNCTION public.context_finished_wake_hours() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_lead_monitored_jobs(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_judge(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_due(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_finished_wake_hours() TO service_role;
GRANT EXECUTE ON FUNCTION public.context_lead_monitored_jobs(uuid[], timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_judge(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_due(integer) TO service_role;
