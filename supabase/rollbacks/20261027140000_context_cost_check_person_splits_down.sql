-- Rollback for 20261027140000_context_cost_check_person_splits.sql: puts back the card events
-- (20261021150000) body and comment of context_job_story_meta, word for word. Signature, owner
-- and grants never changed. Refuses unless the live body is this migration's or already the
-- earlier one (a re-run is a no-op): a later change to it must be rolled back first.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $guard$
DECLARE live text;
BEGIN
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_job_story_meta(uuid,timestamptz)');
 IF live IS NULL OR NOT live = ANY (ARRAY['b50bdd406db617a3361497c2c921a758', '8081ce3fad879ce86a321ed3bdc30e46']) THEN
  RAISE EXCEPTION 'context_cost_check_person_splits_down_refused: public.context_job_story_meta(uuid,timestamptz) md5 %; a later change replaced this body, roll it back first',
   coalesce(live, '<missing>');
 END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.context_job_story_meta(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH jb0 AS (SELECT j.created_at, nullif(btrim(j.ghl_contact_id), '') AS contact, nullif(btrim(j.xero_contact_id), '') AS jxc,
                     j.type::text AS jtype,
                     -- (eighth review) the client's address, and whether the client has another job
                     lower(nullif(btrim(j.client_email), '')) AS cmail,
                     (EXISTS (SELECT 1 FROM public.jobs o WHERE o.ghl_contact_id = nullif(btrim(j.ghl_contact_id), '') AND o.id <> j.id)
                      OR EXISTS (SELECT 1 FROM public.jobs o WHERE o.client_email IS NOT NULL
                                 AND lower(btrim(o.client_email)) = lower(nullif(btrim(j.client_email), '')) AND o.id <> j.id)) AS repeat_client,
                     -- (ninth review) the client phone and email as placement keys, and who and where the
                     -- client is (their name's words in C order, the site address's key, its letters and
                     -- digits, and its street part before the first comma), for contact_shared below
                     public.context_phone_key(j.client_phone) AS phone, public.context_email_key(j.client_email) AS email,
                     (SELECT string_agg(w, ' ' ORDER BY w COLLATE "C") FROM regexp_split_to_table(lower(coalesce(j.client_name, '')), '[^a-z]+') w
                      WHERE w <> '') AS nkey,
                     public.context_address_key(j.site_address) AS akey,
                     nullif(lower(regexp_replace(coalesce(j.site_address, ''), '[^a-zA-Z0-9]+', '', 'g')), '') AS atext,
                     nullif(lower(regexp_replace(split_part(coalesce(j.site_address, ''), ',', 1), '[^a-zA-Z0-9]+', '', 'g')), '') AS astreet
              FROM public.jobs j WHERE j.id = p_job_id),
 -- (ninth review) the jobs that share this job's contact details: its CRM contact, its client
 -- phone or its client email (both by their placement keys), read by the jobs index on each and
 -- confirmed by the key; and those of them that are another client's: no client name of the same
 -- words, at no site address the same (by its key, its letters and digits, or its street part).
 -- A contact on another client's job is shared across clients (a builder's or an agent's:
 -- SWR-261488, SWMS-261065 and SWMS-261163 have three clients at three sites and one CRM contact,
 -- linked by a builder-side phone), so it is never taken to be this job's insured's
 -- (contact_shared; the assembler names its messages the job contact's)
 cso AS (
  SELECT 'contact'::text AS by_, o.id, o.client_name, o.site_address FROM public.jobs o, jb0
  WHERE jb0.contact IS NOT NULL AND o.ghl_contact_id = jb0.contact AND o.id <> p_job_id
  UNION ALL
  SELECT 'phone', o.id, o.client_name, o.site_address FROM public.jobs o, jb0
  WHERE jb0.phone IS NOT NULL AND o.client_phone IS NOT NULL AND right(regexp_replace(o.client_phone, '[^0-9]', '', 'g'), 9) = jb0.phone
    AND public.context_phone_key(o.client_phone) = jb0.phone AND o.id <> p_job_id
  UNION ALL
  SELECT 'email', o.id, o.client_name, o.site_address FROM public.jobs o, jb0
  WHERE jb0.email IS NOT NULL AND o.client_email IS NOT NULL AND lower(btrim(o.client_email)) = jb0.email
    AND public.context_email_key(o.client_email) = jb0.email AND o.id <> p_job_id
 ),
 cs AS (
  SELECT x.by_, x.id FROM cso x, jb0
  WHERE NOT coalesce((SELECT string_agg(w, ' ' ORDER BY w COLLATE "C") FROM regexp_split_to_table(lower(coalesce(x.client_name, '')), '[^a-z]+') w
                      WHERE w <> '') = jb0.nkey, false)
    AND NOT coalesce(public.context_address_key(x.site_address) = jb0.akey, false)
    AND NOT coalesce(nullif(lower(regexp_replace(coalesce(x.site_address, ''), '[^a-zA-Z0-9]+', '', 'g')), '') = jb0.atext, false)
    AND NOT coalesce(nullif(lower(regexp_replace(split_part(coalesce(x.site_address, ''), ',', 1), '[^a-zA-Z0-9]+', '', 'g')), '') = jb0.astreet, false)
 ),
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
  -- card events (20261021150000): the rows the record shows are the job's card events, so a
  -- person's split or correct counts here as it shows there (context_job_card_events)
  FROM public.context_job_card_events(ARRAY[p_job_id]) cev JOIN public.business_events x ON x.id = cev.event_id
  CROSS JOIN LATERAL (SELECT CASE WHEN x.source = 'ghl_sms_cache_backfill'
                                  THEN public.context_job_record_crm_time(x.source, x.contact_id,
                                         coalesce(nullif(btrim(x.payload ->> 'ghl_message_id'), ''), substring(x.provider_message_id FROM '^ghl:(.+)$')), x.job_id)
                             END AS crm_at) ct
  -- the rows the record shows (every row on the job), so "no texts" never sits beside texts;
  -- a row marked as a copy of another is not shown, so it is not counted (20261006031000)
  WHERE coalesce(x.recorded_at, x.occurred_at) <= p_as_of
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
 -- sits on this job or (seventh review) on another live job, so that copy is on no job or on
 -- a job that is not live (eighth review: the judge's live set); named in not_known, so its
 -- count is the mail the story shows (story safety, 20261006040000)
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
 -- (eighth review) this customer's messages off this job that the placement queue does not hold,
 -- from the job's lead window on (30 days before it was created), each with where it sits, so the
 -- line never says there is no customer message or no reply while one sits there:
 --  their CRM contact's rows on another job: on their other job ("on job X"; that job's reader
 --  reads it while the job is live: SWF-261518's texts about this site on SWF-261517), or on a job
 --  no reader reads (a bucket: archived, complete, completed, cancelled, lost, a draft, or holding:
 --  "on archived job X");
 --  their email by the client's address with no CRM contact (a mail matched only by the address),
 --  placed on no job or on a bucket job, read as the old inbox's mail is (from 30 days before the
 --  job, or whenever while the client has another job: then it may be about another of their jobs):
 --  SWP-26148's reply on SWF-PDF-BUCKET, SWP-26115's in the admin bucket.
 -- Each timed as the job's own rows are (a CRM text at its CRM time; never one whose time is unknown
 -- or from before the lead window). Read by the CRM contact index and the inbound mail sender index.
 oo AS (
  SELECT x.id, x.job_id, x.contact_id, x.source, x.provider_message_id, x.payload, x.metadata, x.direction, x.channel, x.event_type,
         x.event_at, x.occurred_at, x.recorded_at, false AS by_address,
         (oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
          AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1')) AS live_job,
         'on ' || CASE WHEN oj.status::text = 'archived' THEN 'archived job ' WHEN coalesce(oj.metadata ->> 'do_not_schedule', '') IN ('true', '1') THEN 'holding job '
                       WHEN oj.status::text IN ('complete', 'completed') THEN 'completed job '
                       WHEN oj.status::text IN ('cancelled', 'lost', 'draft') THEN oj.status::text || ' job '
                       ELSE 'job ' END || coalesce(oj.job_number, 'without a number') AS where_,
         lower(coalesce(x.payload ->> 'call_status', substring(public.context_event_text(x) FROM 'Provider status: ([A-Za-z_-]+)'), '')) AS call_status,
         public.context_internal_text_role(x) AS irole
  FROM public.business_events x JOIN public.jobs oj ON oj.id = x.job_id
  WHERE x.contact_id = (SELECT jb0.contact FROM jb0) AND x.job_id <> p_job_id
    AND coalesce(x.event_at, x.occurred_at) >= (SELECT jb0.created_at FROM jb0) - interval '30 days'
  UNION ALL
  SELECT x.id, x.job_id, x.contact_id, x.source, x.provider_message_id, x.payload, x.metadata, x.direction, x.channel, x.event_type,
         x.event_at, x.occurred_at, x.recorded_at, true, false,
         CASE WHEN x.job_id IS NULL THEN 'not placed on any job'
              ELSE 'on ' || CASE WHEN oj.status::text = 'archived' THEN 'archived job ' WHEN coalesce(oj.metadata ->> 'do_not_schedule', '') IN ('true', '1') THEN 'holding job '
                                 WHEN oj.status::text IN ('complete', 'completed') THEN 'completed job '
                                 ELSE oj.status::text || ' job ' END || coalesce(oj.job_number, 'without a number') END
         || CASE WHEN (SELECT jb0.repeat_client FROM jb0) THEN '; it may be about another of their jobs' ELSE '' END,
         '', 'other'
  FROM public.business_events x LEFT JOIN public.jobs oj ON oj.id = x.job_id
  WHERE (SELECT jb0.cmail FROM jb0) IS NOT NULL AND x.event_type IN ('supplier.email_in', 'client.email_in')
    AND lower(btrim(coalesce(substring(x.payload ->> 'from', '<([^<>]*)>'), x.payload ->> 'from'))) = (SELECT jb0.cmail FROM jb0)
    AND x.contact_id IS NULL AND x.job_id IS DISTINCT FROM p_job_id
    AND (x.job_id IS NULL OR oj.status::text IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
         OR coalesce(oj.metadata ->> 'do_not_schedule', '') IN ('true', '1'))
    AND ((SELECT jb0.repeat_client FROM jb0) OR coalesce(x.event_at, x.occurred_at) >= (SELECT jb0.created_at FROM jb0) - interval '30 days')
 ),
 oc AS (
  SELECT o.*, ut.at, ut.before_job, ut.time_unknown
  FROM oo o
  CROSS JOIN LATERAL (SELECT CASE WHEN o.source = 'ghl_sms_cache_backfill'
                                  THEN public.context_job_record_crm_time(o.source, o.contact_id,
                                         coalesce(nullif(btrim(o.payload ->> 'ghl_message_id'), ''), substring(o.provider_message_id FROM '^ghl:(.+)$')), o.job_id)
                             END AS crm_at) ct
  CROSS JOIN LATERAL (SELECT coalesce(ct.crm_at, o.event_at, o.occurred_at) AS at,
                             coalesce(ct.crm_at < (SELECT jb0.created_at FROM jb0) - interval '30 days', false) AS before_job,
                             (o.source = 'ghl_sms_cache_backfill' AND ct.crm_at IS NULL) AS time_unknown) ut
  WHERE o.metadata #>> '{duplicate_of}' IS NULL AND coalesce(o.recorded_at, o.occurred_at) <= p_as_of
    AND NOT ut.before_job AND NOT ut.time_unknown AND ut.at <= p_as_of
 ),
 -- the customer's (a text or email, or a call answered or transcribed; the address's email is theirs)
 oci AS (
  SELECT c.at, c.where_, c.live_job FROM oc c
  WHERE c.direction = 'inbound'
    AND (c.by_address
         OR coalesce(c.metadata #>> '{party_roles,sender_role}', c.metadata #>> '{party_roles,counterpart_role}',
                     CASE WHEN c.event_type LIKE 'client.%' THEN 'customer' END) = 'customer')
    AND (c.channel IN ('sms', 'email')
         OR ((c.channel = 'call' OR c.event_type IN ('client.call_logged', 'client.call_complete', 'call.transcript_completed'))
             AND (c.event_type = 'call.transcript_completed' OR c.call_status IN ('completed', 'answered'))))
 ),
 -- what we sent them (never automated)
 oco AS (
  SELECT c.at, c.where_ FROM oc c
  WHERE c.direction = 'outbound' AND NOT c.by_address
    AND coalesce(c.metadata #>> '{party_roles,counterpart_role}', c.metadata #>> '{party_roles,recipient_role}',
                 CASE WHEN c.event_type LIKE 'client.%' THEN 'customer' END) = 'customer'
    AND (c.channel IN ('sms', 'email', 'call') OR c.event_type IN ('client.sms_out', 'client.email_out', 'client.call_logged', 'client.call_complete'))
    AND coalesce(c.payload ->> 'sent_by_kind', '') <> 'workflow' AND c.irole = 'other'
 ),
 -- (sixth review) customer invoices placed on no job addressed to this job's own Xero contact
 -- (eighth review: its customer's, as the client story reads it: the job's, its primary party's,
 -- or one on its own invoices addressed to the customer, payer role customer; never a neighbour's,
 -- the strata's, another party's or another payer's; never on builder work, nor a contact billed
 -- on builder work, whose invoices are the builder's), still owing, recorded by p_as_of and made
 -- no earlier than 30 days before the job: the story names each, so it never says "owing
 -- $0.00" over a debt of this job's client that sits on no job (bda6e1de's INV-0290)
 jx AS (
  SELECT DISTINCT z.x FROM (SELECT jb0.jxc AS x FROM jb0
                            UNION ALL
                            SELECT nullif(btrim(c.xero_contact_id), '') FROM public.job_contacts c
                            WHERE c.job_id = p_job_id AND c.removed_at IS NULL
                              AND (coalesce(c.is_primary, false) OR coalesce(c.contact_type, '') = 'primary')
                            UNION ALL
                            SELECT nullif(btrim(i.xero_contact_id), '') FROM public.xero_invoices i
                            WHERE i.job_id = p_job_id AND upper(coalesce(i.invoice_type, 'ACCREC')) = 'ACCREC'
                              AND upper(coalesce(i.status, '')) NOT IN ('DELETED', 'VOIDED')
                              AND coalesce(i.created_at, i.synced_at, '-infinity'::timestamptz) <= p_as_of
                              AND public.context_job_record_payer_role(i.job_id, (SELECT jb0.jtype FROM jb0), (SELECT jb0.jxc FROM jb0),
                                                                       i.xero_contact_id, i.job_contact_id) = 'customer') z
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
 jb AS (SELECT nullif(btrim(j.ghl_contact_id), '') IS NULL AS contact_missing FROM public.jobs j WHERE j.id = p_job_id),
 -- (card events, 20261021150000) the messages that wait in Matching for a person to say whether they
 -- are this job's (context_recon_job_items, read now: at most 201, so 200 and more), by channel
 mw AS (SELECT count(*) AS n, count(*) FILTER (WHERE w.channel = 'email') AS emails,
               count(*) FILTER (WHERE w.channel = 'sms') AS texts, count(*) FILTER (WHERE w.channel = 'call') AS calls
        FROM public.context_recon_job_items(p_job_id) w),
 -- (card events) the rows a person's current decision put on this job or took off it
 pp AS (SELECT * FROM public.context_job_card_decisions(p_job_id)),
 ppn AS (SELECT * FROM pp ORDER BY pp.decided_at DESC, pp.event_id LIMIT 20)
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
  -- (eighth review) the newest of this customer's messages off this job outside the placement
  -- queue (on their other job, on a bucket job, or their email by address with no CRM contact),
  -- the newest no reader reads (not on a live job), and the newest we sent them there, each with
  -- where it sits
  'off_job', (SELECT jsonb_build_object(
                'newest_customer_at', (SELECT c.at FROM oci c ORDER BY c.at DESC, c.where_ COLLATE "C" LIMIT 1),
                'newest_customer_where', (SELECT c.where_ FROM oci c ORDER BY c.at DESC, c.where_ COLLATE "C" LIMIT 1),
                'unchecked_customer_at', (SELECT c.at FROM oci c WHERE NOT c.live_job ORDER BY c.at DESC, c.where_ COLLATE "C" LIMIT 1),
                'unchecked_customer_where', (SELECT c.where_ FROM oci c WHERE NOT c.live_job ORDER BY c.at DESC, c.where_ COLLATE "C" LIMIT 1),
                'newest_reply_at', (SELECT c.at FROM oco c ORDER BY c.at DESC, c.where_ COLLATE "C" LIMIT 1),
                'newest_reply_where', (SELECT c.where_ FROM oco c ORDER BY c.at DESC, c.where_ COLLATE "C" LIMIT 1))),
  'mail_copy_elsewhere', (SELECT jsonb_build_object('count', ce.n) FROM ce),
  'before_job_texts', (SELECT jsonb_build_object('count', bj.n, 'newest_at', bj.newest) FROM bj),
  'time_unknown_texts', (SELECT jsonb_build_object('count', tu.n) FROM tu),
  'unplaced_invoices', (SELECT jsonb_build_object('count', count(*), 'owing', coalesce(sum(ui.amount_due), 0),
                                 'items', coalesce(jsonb_agg(jsonb_build_object('id', ui.id, 'number', ui.invoice_number, 'party', ui.contact_name,
                                                   'owing', ui.amount_due, 'due_date', ui.due_date, 'days_overdue', ui.days_overdue)
                                                   ORDER BY ui.due_date NULLS LAST, ui.invoice_number COLLATE "C", ui.id), '[]'::jsonb))
                        FROM ui),
  'contact_missing', coalesce((SELECT jb.contact_missing FROM jb), false),
  -- (ninth review) whether this job's contact details sit on another client's job: shared, by
  -- which ('contact', 'email', 'phone', in C order) and on how many such jobs
  'contact_shared', jsonb_build_object('shared', EXISTS (SELECT 1 FROM cs),
                      'by', (SELECT coalesce(jsonb_agg(b.by_ ORDER BY b.by_ COLLATE "C"), '[]'::jsonb) FROM (SELECT DISTINCT cs.by_ FROM cs) b),
                      'other_jobs', (SELECT count(DISTINCT cs.id) FROM cs)),
  -- (card events, 20261021150000) waiting: the messages Matching lists for this job now that no
  -- person has decided (a split, correct, confirm or unrelated takes one off); more: over 200
  'matching', (SELECT jsonb_build_object('waiting', least(mw.n, 200), 'more', mw.n > 200,
                 'emails', least(mw.emails, 200), 'texts', least(mw.texts, 200), 'calls', least(mw.calls, 200)) FROM mw),
  -- (card events) the rows on (or taken off) this card by a person's current decision: counts, how
  -- many of those on it a split also put on another job, and the newest 20 with who and when
  'person_placed', (SELECT jsonb_build_object(
                     'on', count(*) FILTER (WHERE pp.placement = 'on'),
                     'off', count(*) FILTER (WHERE pp.placement = 'off'),
                     'split', count(*) FILTER (WHERE pp.placement = 'on' AND pp.action = 'split'),
                     'more', count(*) > 20,
                     'items', (SELECT coalesce(jsonb_agg(jsonb_build_object('event_id', q.event_id, 'placement', q.placement,
                                 'action', q.action, 'decision_id', q.decision_id, 'decided_at', q.decided_at,
                                 'decided_by', q.decided_by, 'decided_by_name', q.decided_by_name,
                                 'other_job_numbers', to_jsonb(q.other_job_numbers),
                                 'evidence_hash', q.evidence_hash)
                                 ORDER BY q.decided_at DESC, q.event_id), '[]'::jsonb) FROM ppn q))
                    FROM pp),
  -- (card events, Finance's allocation contract of 21 Oct 2026) the supplier bills the job cost
  -- read (v_job_cost_events: actual supplier bill and materials fact rows, by the Xero bill id)
  -- counts as cost on this job, and those it also counts as cost on another job. One bill counted
  -- on two jobs is a defect, never a split: placing a message never moves cost, nothing here
  -- divides a bill, and this read writes nothing. Read as now, in one scan of the view.
  'cost_check', (WITH cd AS (
                   SELECT e.document_id, min(e.document_number COLLATE "C") AS num,
                          sum(e.amount_ex) FILTER (WHERE e.job_id = p_job_id) AS here_ex,
                          sum(e.amount_ex) FILTER (WHERE e.job_id <> p_job_id) AS elsewhere_ex,
                          array_agg(DISTINCT e.job_id) FILTER (WHERE e.job_id <> p_job_id) AS others
                     FROM public.v_job_cost_events e
                    WHERE e.is_actual AND e.source IN ('supplier_bill', 'materials_fact') AND e.document_id IS NOT NULL
                    GROUP BY e.document_id
                   HAVING bool_or(e.job_id = p_job_id))
                 SELECT jsonb_build_object('read_from', 'v_job_cost_events', 'bills', count(*),
                          'counted_elsewhere', count(*) FILTER (WHERE cd.others IS NOT NULL),
                          'items', coalesce(jsonb_agg(jsonb_build_object('document_id', cd.document_id, 'document_number', cd.num,
                                     'here_ex', cd.here_ex, 'elsewhere_ex', cd.elsewhere_ex,
                                     'other_job_numbers', (SELECT coalesce(jsonb_agg(coalesce(j.job_number, o.id::text)
                                                                   ORDER BY coalesce(j.job_number, o.id::text) COLLATE "C"), '[]'::jsonb)
                                                             FROM unnest(cd.others) o(id) LEFT JOIN public.jobs j ON j.id = o.id))
                                     ORDER BY cd.num COLLATE "C" NULLS LAST, cd.document_id COLLATE "C")
                                     FILTER (WHERE cd.others IS NOT NULL), '[]'::jsonb))
                   FROM cd)
 )
$fn$;
COMMENT ON FUNCTION public.context_job_story_meta(uuid, timestamptz) IS
 'Job story (20261006014000), story safety (20261006040000): card events (20261021150000): the lanes, history start, before_job_texts and time_unknown_texts count the job''s card events (context_job_card_events), the rows the record shows, so a person''s split, correct or unrelated counts here as it shows there; cost_check {read_from, bills, counted_elsewhere, items: [{document_id, document_number, here_ex, elsewhere_ex, other_job_numbers}]}: of the supplier bills the job cost read (v_job_cost_events, actual supplier bill and materials fact rows, read as now) counts as cost on this job, those it also counts on another job, a defect (Finance''s allocation contract: one bill is cost once, where Xero''s bill link puts it; placing a message never moves cost). Earlier, (ninth review) contact_shared {shared, by, other_jobs}: whether this job''s contact details sit on another client''s job: its CRM contact, its client phone or its client email (each by its placement key: context_phone_key, context_email_key) on a job whose client is someone else (no client name of the same words, at no site address the same by its key, its letters and digits or its street part before the first comma), by which (contact, email, phone) and on how many such jobs; such a contact is shared across clients (a builder''s or an agent''s), so the assembler never names its messages the insured''s. Earlier (eighth review) off_job {newest_customer_at, newest_customer_where, unchecked_customer_at, unchecked_customer_where, newest_reply_at, newest_reply_where}: this customer''s messages off this job outside the placement queue, from 30 days before the job was created: their CRM contact''s rows on another job (their other job, "on job X", or one no reader reads, a bucket: archived, complete, completed, cancelled, lost, a draft or holding, "on archived job X") and their email by the client''s address with no CRM contact placed on no job or on a bucket job (read as the old inbox''s mail is: from 30 days before the job, or whenever while the client has another job, then said to be maybe about another of their jobs), each timed as the job''s own rows are (a CRM text at its CRM time, never one whose time is unknown or before the lead window); unchecked_customer is the newest one not on a live job (no reader reads it); unplaced_invoices and its own contacts are the customer''s only: the job''s, its primary party''s, or one on its own invoices addressed to the customer (payer role customer), never a neighbour''s, the strata''s, another party''s or another payer''s, as the client story reads them; mail_copy_elsewhere counts a copy on any job that is not live (the judge''s live set). Earlier (sixth review) unplaced''s newest_customer_at and newest_reply_at also read every other row of this customer''s CRM contact placed on no job, whatever the ladder made of it (attribution status null or empty: never in the placement queue, so never in unplaced.count or newest_at); a CRM text whose CRM time is no longer known is time unknown: counted in time_unknown_texts {count} (on the job), never a lane''s or the unplaced newest or oldest time; unplaced_invoices {count, owing, items: [{id, number, party, owing, due_date, days_overdue}]}: the customer invoices placed on no job addressed to this job''s own Xero contact (the job''s, or one on its own invoices; never on builder work, nor a contact billed on builder work), still owing, recorded by p_as_of and made no earlier than 30 days before the job. Earlier: unplaced also gives newest_customer_at (the newest of this customer''s messages not placed on any job, as of p_as_of: a text or email, or a call answered or transcribed) and newest_reply_at (the newest we sent them there, never automated), so the story''s line never says there is no customer message while one waits unplaced; times a CRM text loaded later by the CRM''s own time (context_job_record_crm_time), on the job and placed on no job alike; history start, each lane''s newest and oldest and the unplaced newest_at, newest_customer_at and newest_reply_at leave out texts dated before the job''s lead window (still counted: on the job in before_job_texts {count, newest_at}, placed on no job in unplaced.count, the placement queue''s); mail_copy_elsewhere {count}: the legacy mail the record shows (context_job_record_legacy_mail, never withheld) that has a saved copy recorded by p_as_of, which then sits on no job or (seventh review) on an archived or holding job, never on a live one (shown from the old inbox), so the count is the mail the story shows. Earlier: evidence lanes on the job (linked rows only; counts and newest time per lane, legacy inbox mail counted as email), history start (rows marked as a copy of another, metadata.duplicate_of, are not counted, 20261006031000), this customer''s unplaced messages (context_unplaced_for_job), the legacy mail withheld because the client has another job (withheld_mail: counted, never the job''s email), and whether the job has a CRM contact. Unplaced messages are read as now. How far the reader has read comes from the ledger read, never the fact pass. Service role only.';

REVOKE ALL ON FUNCTION public.context_job_story_meta(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_story_meta(uuid, timestamptz) TO service_role;
