-- Undo 20261103150000_context_record_mail_copy_key_fast: put back the exact old definitions of
-- context_job_record_legacy_mail (md5 3517767afcd634cfa8e022aff0ed04e9) and
-- context_ledger_evidence_rows (md5 cdcd2bbfbd6b3d120abf5a8774cab247), embedded below as read from
-- production on 3 Nov 2026, and drop the index business_events_inbox_events_id_any_source.
-- Note: the old containment form made context_ledger_due take about 28 s on 3 Nov (the worker's limit
-- is 28 s), so the notes reader stops again.
DO $down$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
  WHERE p.oid = 'public.context_job_record_legacy_mail(uuid[],timestamp with time zone)'::regprocedure;
  IF md5(v_def) = '3517767afcd634cfa8e022aff0ed04e9' THEN
    RAISE NOTICE 'context_job_record_legacy_mail is already the old definition';
  ELSIF md5(v_def) <> '87e09520aecd31d4a8d9debde7d0aba4' THEN
    RAISE EXCEPTION 'context_job_record_legacy_mail is not the 20261103150000 definition (md5 %)', md5(v_def);
  ELSE
    EXECUTE $old_def$CREATE OR REPLACE FUNCTION public.context_job_record_legacy_mail(p_job_ids uuid[], p_as_of timestamp with time zone DEFAULT now())
 RETURNS TABLE(jid uuid, cmail text, id uuid, received_at timestamp with time zone, subject text, body_preview text, from_email text, graph_message_id text, on_job boolean, placement text)
 LANGUAGE sql
 STABLE
AS $function$
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
   -- a business_events copy stands in for the mail on the same job (recorded by p_as_of);
   -- (seventh review) one on another live job decides where the mail belongs, as the job
   -- conversation's rule R0 has it, so the mail leaves this job; only a copy left unplaced, or
   -- on a job no reader reads (a bucket: archived, SWF-PDF-BUCKET, or, eighth review, the judge's
   -- other jobs that are not live: complete, completed, cancelled, lost, a draft, or holding),
   -- leaves the mail on this job (story safety, 20261006040000)
   AND NOT EXISTS (SELECT 1 FROM public.business_events c
                   WHERE c.source_table = 'inbox_events' AND c.source_id = x.id::text AND coalesce(c.recorded_at, c.occurred_at) <= p_as_of
                     AND (c.job_id = x.jid OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = c.job_id AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                                      AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
   AND NOT EXISTS (SELECT 1 FROM public.business_events c
                   WHERE x.graph_message_id IS NOT NULL AND c.provider_message_id = 'graph:' || x.graph_message_id
                     AND coalesce(c.recorded_at, c.occurred_at) <= p_as_of
                     AND (c.job_id = x.jid OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = c.job_id AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                                      AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
   AND NOT EXISTS (SELECT 1 FROM public.business_events c
                   WHERE c.payload @> jsonb_build_object('inbox_events_id', x.id::text) AND coalesce(c.recorded_at, c.occurred_at) <= p_as_of
                     AND (c.job_id = x.jid OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = c.job_id AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                                      AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
   AND NOT EXISTS (SELECT 1 FROM public.business_events m
                   WHERE m.job_id = x.jid AND m.channel = 'email' AND coalesce(m.event_at, m.occurred_at) = x.received_at
                     AND coalesce(m.recorded_at, m.occurred_at) <= p_as_of)
 ORDER BY x.jid, x.received_at, x.on_job DESC, x.id
$function$
$old_def$;
    SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    WHERE p.oid = 'public.context_job_record_legacy_mail(uuid[],timestamp with time zone)'::regprocedure;
    IF md5(v_def) <> '3517767afcd634cfa8e022aff0ed04e9' THEN
      RAISE EXCEPTION 'context_job_record_legacy_mail after undo is not the old definition (md5 %)', md5(v_def);
    END IF;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
  WHERE p.oid = 'public.context_ledger_evidence_rows(uuid[],timestamp with time zone)'::regprocedure;
  IF md5(v_def) = 'cdcd2bbfbd6b3d120abf5a8774cab247' THEN
    RAISE NOTICE 'context_ledger_evidence_rows is already the old definition';
  ELSIF md5(v_def) <> '33e59b23c7fe914ee8208cecd96a6c57' THEN
    RAISE EXCEPTION 'context_ledger_evidence_rows is not the 20261103150000 definition (md5 %)', md5(v_def);
  ELSE
    EXECUTE $old_def$CREATE OR REPLACE FUNCTION public.context_ledger_evidence_rows(p_job_ids uuid[], p_as_of timestamp with time zone DEFAULT now())
 RETURNS TABLE(job_id uuid, src_table text, src_id uuid, at timestamp with time zone, landed_at timestamp with time zone, channel text, kind text, direction text, sender_role text, recipient_role text, audience text, counterpart_role text, role_basis text, sender text, recipient text, ours boolean, automated boolean, subject text, body text, placed_on text, has_transcript boolean, call_customer boolean, copy_of uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
   public.context_story_message_text(e) AS body,
   'this_job'::text AS placed_on,
   -- A call log (not a transcript) says whether its transcript is on the job: the
   -- transcript names the call's GHL message id in payload.ghl_call_id (and in its
   -- key ghltx:<id>); the call row's key is ghl:<id>.
   CASE WHEN e.event_type <> 'call.transcript_completed'
         AND (e.channel = 'call' OR e.event_type IN ('client.call_logged', 'client.call_complete'))
    THEN coalesce(e.provider_message_id LIKE 'ghl:%' AND EXISTS (SELECT 1 FROM public.context_ledger_reader_events(ARRAY[e.job_id]) t
     WHERE t.job_id = e.job_id AND t.event_type = 'call.transcript_completed' AND (CASE WHEN public.context_ledger_person_placement_enabled() THEN public.context_ledger_row_admissible(t) ELSE public.context_linked_status(t.attribution_status) END)
      AND (t.payload ->> 'ghl_call_id' = substr(e.provider_message_id, 5)
       OR t.provider_message_id = 'ghltx:' || substr(e.provider_message_id, 5))), false) END AS has_transcript,
   -- A transcript says whether its call makes it the customer's words (the cite's rule).
   public.context_ledger_call_customer(e,e.job_id) AS call_customer,
   lower(nullif(btrim(coalesce(e.payload ->> 'from', e.payload ->> 'from_email')), '')) AS sender_key
  FROM j JOIN public.context_ledger_reader_events(p_job_ids) e ON e.job_id = j.id
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
  SELECT DISTINCT j.id AS job_id, coalesce(b.event_at, b.occurred_at) AS at,
   lower(btrim(coalesce(b.payload ->> 'from', b.payload ->> 'from_email'))) AS sender
  FROM j JOIN public.business_events b ON public.context_ledger_mail_copy_blocks(b,j.id,false)
  WHERE b.channel = 'email' AND coalesce(b.event_at, b.occurred_at) IN (SELECT ic.received_at FROM inbox_c ic)
 ), copies AS MATERIALIZED (
  -- Each mail's saved copies by where they sit (context_ledger_mail_copies): a mail kept
  -- here although a copy sits on no job or on a job that is not live joined this job's
  -- evidence no earlier than their joined_at (story safety, 20261006040000; eighth review: nor
  -- before that copy left a live job).
  SELECT x.mail_id, x.copy_job_id, x.joined_at FROM public.context_ledger_mail_copies(ARRAY(SELECT DISTINCT ic.id FROM inbox_c ic)) x
 ), inbox AS (
  SELECT c.job_id, 'inbox_events'::text AS src_table, c.id AS src_id, c.received_at AS at,
   -- when it joined this job's evidence: when it landed, or, kept here only because its copy
   -- sits elsewhere (on no job, or on a job that is not live), no earlier than that (a
   -- reading built before then never read it)
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
   -- copy), and (seventh review) one on another live job decides where the mail belongs (the
   -- job conversation's rule R0: that job's reader reads it); a copy left unplaced or on a job
   -- that is not live (a bucket; eighth review: the judge's live set, so archived, complete,
   -- completed, cancelled, lost, a draft or holding, where no reader reads it) leaves the mail
   -- here, so each email reaches one job's reader once (story safety, 20261006040000).
   AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table = 'inbox_events' AND b.source_id = c.id::text
    AND public.context_ledger_mail_copy_blocks(b,c.job_id,true))
   AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE c.graph_message_id IS NOT NULL AND b.provider_message_id = 'graph:' || c.graph_message_id
    AND public.context_ledger_mail_copy_blocks(b,c.job_id,true))
   -- An old-path copy names its inbox row only in the payload (containment, so
   -- the payload index answers it instead of a scan of every business_events row).
   AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table IS NULL
    AND b.payload @> jsonb_build_object('inbox_events_id', c.id::text)
    AND public.context_ledger_mail_copy_blocks(b,c.job_id,true))
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
$function$
$old_def$;
    SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    WHERE p.oid = 'public.context_ledger_evidence_rows(uuid[],timestamp with time zone)'::regprocedure;
    IF md5(v_def) <> 'cdcd2bbfbd6b3d120abf5a8774cab247' THEN
      RAISE EXCEPTION 'context_ledger_evidence_rows after undo is not the old definition (md5 %)', md5(v_def);
    END IF;
  END IF;
END
$down$;
DROP INDEX IF EXISTS public.business_events_inbox_events_id_any_source;
