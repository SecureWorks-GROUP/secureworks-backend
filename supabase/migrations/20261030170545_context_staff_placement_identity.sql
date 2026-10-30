SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_record_messages(uuid[],timestamp with time zone)'::regprocedure) IS DISTINCT FROM 'f170d0c3f9d2703b57b52df7f7238e96' THEN RAISE EXCEPTION 'staff_placement_identity_preimage_mismatch'; END IF; IF public.context_ledger_person_placement_enabled() THEN RAISE EXCEPTION 'staff_placement_identity_preexisting_activation'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.context_job_record_messages(p_job_ids uuid[], p_as_of timestamp with time zone DEFAULT now())
 RETURNS TABLE(job_id uuid, source_table text, source_id text, at timestamp with time zone, event_type text, source text, channel text, direction text, words text, counterpart_role text, sender_role text, audience text, recipient_role text, is_job_contact boolean, from_is_client boolean, to_is_client boolean, sent_by_kind text, internal_role text, is_msg boolean, is_note boolean, customer_side boolean, internal boolean, automated boolean, bad_call boolean, call_answered boolean, placement text)
 LANGUAGE sql
 STABLE
AS $function$
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
         e.channel, e.direction, e.contact_id, e.payload,
         -- A person moving evidence does not make its sender the receiving customer.
         -- Use the reader's existing identity projection without changing source words,
         -- event times, source safeguards or the card's placement admission.
         CASE WHEN public.context_ledger_person_placement_enabled()
              THEN (public.context_ledger_event_on_job(e,j.id)).metadata
              ELSE e.metadata END AS metadata,
         regexp_replace(public.context_event_text(e), '\s+', ' ', 'g') AS txt,
         -- crew and staff alerts are texts we send; inbound rows are never one
         CASE WHEN e.direction = 'outbound' THEN public.context_internal_text_role(e) ELSE 'other' END AS irole,
         (e.channel IN ('sms', 'email', 'call')
          OR e.event_type IN ('client.sms_out', 'client.email_out', 'client.call_logged', 'client.call_complete',
                              'call.transcript_completed', 'client.reply', 'client.email_in', 'client.sms_in')) AS is_msg,
         (e.event_type IN ('note.added', 'ghl.internal_comment') OR e.channel = 'note') AS is_note
  -- card events (20261021150000): the rows a person's current decision puts on the job, and the
  -- job's own rows a person's current decision has not moved off it (context_job_card_events)
  FROM j JOIN public.context_job_card_events(p_job_ids) cev ON cev.job_id = j.id
  JOIN public.business_events e ON e.id = cev.event_id
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
         nullif(ev.payload->>'sent_by_kind', '') AS sbk,
         -- (story safety, seventh review) the party-roles basis, and the sender's address on an
         -- inbound email
         nullif(ev.metadata->'party_roles'->>'basis', '') AS pb,
         CASE WHEN ev.direction = 'inbound' AND ev.channel = 'email'
              THEN nullif(lower(btrim(coalesce(substring(ev.payload->>'from', '<([^<>]*)>'), ev.payload->>'from', ev.payload->>'from_email',
                                               ev.payload->>'sender'))), '') END AS from_addr
  FROM ev
 ),
 bel AS (
  SELECT l.jid, 'business_events'::text AS tbl, l.id::text AS sid, l.at, l.event_type, l.source, l.channel, l.direction,
         left(l.txt, 300) AS words, l.cp, l.sr, l.aud, l.rr, l.ijc, l.fic, l.tic, l.sbk, l.irole, l.is_msg, l.is_note,
         -- a text from before the job's lead window is never this customer's side: the CRM
         -- contact may have been another person's then (story safety, 20261006040000); nor one
         -- whose time is unknown (sixth review: it may be from before the lead window too).
         -- (Seventh review) Mail from one of our own addresses (our domains, or a person in
         -- public.users, staff or crew) is never the customer's, whatever its labels say; and a
         -- label naming the customer of another job (party roles basis any_job_customer: SWMS-26845,
         -- an internal action note from the owner's personal address, which is a client address
         -- on other jobs) says nothing of this job's customer, so this job's own contact and
         -- client email decide
         (NOT l.before_job AND NOT l.time_unknown AND (l.is_msg AND CASE WHEN l.rr IS NOT NULL THEN false
                            WHEN l.from_addr IS NOT NULL
                                 AND (l.from_addr ~ '@([a-z0-9-]+\.)*(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$'
                                      OR EXISTS (SELECT 1 FROM public.users u WHERE lower(btrim(u.email)) = l.from_addr)) THEN false
                            WHEN l.cp IS NOT NULL AND l.pb IS DISTINCT FROM 'any_job_customer' THEN l.cp = 'customer'
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
$function$;
COMMENT ON FUNCTION public.context_job_record_messages(uuid[],timestamp with time zone) IS 'Job record (20261006011000), story safety (20261006040000): card events (20261021150000): the business_events rows read are the job''s card events (context_job_card_events): a row a person''s current decision (confirm, correct or split, its evidence hash still matching) puts on the job is read on each job it names, and a row such a decision, or a current unrelated, moves off the job is not read on it; with no current decision every row placed on the job is read as before. Earlier, (seventh review) customer_side is never true for mail from one of our own addresses (our domains, or a person in public.users by email), whatever its labels say, and a party-roles label naming the customer of another job (basis any_job_customer) is no evidence of this job''s customer: this job''s CRM contact and client email decide. Earlier: a CRM text loaded later from the CRM''s cache (source ghl_sms_cache_backfill) is timed by the CRM''s own message time (context_job_record_crm_time), not the load time; one the CRM dates more than 30 days before the job was created is history from before the job''s lead window: placement before_job, never the customer''s side, so it is never the customer''s last word, first contact or a candidate; (sixth review) one whose CRM time is no longer known (neither kept nor in the cache) is placement time_unknown, its at the load time it carries, never the customer''s side either. Earlier: message-shaped business_events on the jobs (recorded at or before p_as_of) with the who-to-whom labels of the proof-set reference (customer_side = grade_ref is_customer_counterpart), plus legacy inbox_events mail placed on the job, or from the client address and placed on no job (placement not_placed), with no business_events copy. Since 20261006031000 a row marked as a copy of another (metadata.duplicate_of) is left out, so the timeline, loops and contact counts never count one message twice. Inlinable helper (no SET, not SECURITY DEFINER) read by the job record functions. Service role only. CTX-T24 staff placement identity (20261030170545): current person placement never implies destination customer identity; flag activation separate.';
