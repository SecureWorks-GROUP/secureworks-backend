-- Rollback for 20261021150000_context_job_card_events.sql: puts back the story safety
-- (20261006040000) bodies and comments of context_job_record_messages and
-- context_job_story_meta and the story settled notes (20261011120000) body and comment of
-- context_job_story_assemble, word for word, and drops context_job_card_events and
-- context_job_card_decisions. Signatures, owners
-- and grants never changed. Refuses unless each live body is this migration's or already the
-- earlier one (a re-run is a no-op): a later change to one of them must be rolled back first.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $guard$
DECLARE problems text[] := '{}'; x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_job_record_messages(uuid[],timestamptz)', ARRAY['4be90ba0880f757464646a86bde76e1a', 'f170d0c3f9d2703b57b52df7f7238e96']),
  ('public.context_job_story_meta(uuid,timestamptz)', ARRAY['184af6a89d7bc188878c545400f64e68', '4d35f497386ea7f161a9ee081d8f1426']),
  ('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)', ARRAY['209d903df7a8732b4773dee0f0741593', 'f7ed0abf8d5de65b161dd6f01fad44f4'])
 ) v(sig, accepted) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY (x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_job_card_events(uuid[])');
 IF live IS NOT NULL AND live <> 'c62fceb1af8fd29f99e96baabba189c4' THEN
  problems := problems || format('public.context_job_card_events(uuid[]) md5 %s', live);
 END IF;
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_job_card_decisions(uuid)');
 IF live IS NOT NULL AND live <> '4de24d2dfa0952722e15bf96893cb468' THEN
  problems := problems || format('public.context_job_card_decisions(uuid) md5 %s', live);
 END IF;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_job_card_events_down_refused: %; a later change replaced these bodies, roll it back first',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- The story safety bodies (20261006040000), word for word.
CREATE OR REPLACE FUNCTION public.context_job_record_messages(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, source_table text, source_id text, at timestamptz, event_type text, source text,
 channel text, direction text, words text, counterpart_role text, sender_role text, audience text,
 recipient_role text, is_job_contact boolean, from_is_client boolean, to_is_client boolean, sent_by_kind text,
 internal_role text, is_msg boolean, is_note boolean, customer_side boolean, internal boolean, automated boolean,
 bad_call boolean, call_answered boolean, placement text)
LANGUAGE sql STABLE
AS $fn$
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
         e.channel, e.direction, e.contact_id, e.payload, e.metadata,
         regexp_replace(public.context_event_text(e), '\s+', ' ', 'g') AS txt,
         -- crew and staff alerts are texts we send; inbound rows are never one
         CASE WHEN e.direction = 'outbound' THEN public.context_internal_text_role(e) ELSE 'other' END AS irole,
         (e.channel IN ('sms', 'email', 'call')
          OR e.event_type IN ('client.sms_out', 'client.email_out', 'client.call_logged', 'client.call_complete',
                              'call.transcript_completed', 'client.reply', 'client.email_in', 'client.sms_in')) AS is_msg,
         (e.event_type IN ('note.added', 'ghl.internal_comment') OR e.channel = 'note') AS is_note
  FROM j JOIN public.business_events e ON e.job_id = j.id
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
$fn$;
COMMENT ON FUNCTION public.context_job_record_messages(uuid[], timestamptz) IS
 'Job record (20261006011000), story safety (20261006040000): (seventh review) customer_side is never true for mail from one of our own addresses (our domains, or a person in public.users by email), whatever its labels say, and a party-roles label naming the customer of another job (basis any_job_customer) is no evidence of this job''s customer: this job''s CRM contact and client email decide. Earlier: a CRM text loaded later from the CRM''s cache (source ghl_sms_cache_backfill) is timed by the CRM''s own message time (context_job_record_crm_time), not the load time; one the CRM dates more than 30 days before the job was created is history from before the job''s lead window: placement before_job, never the customer''s side, so it is never the customer''s last word, first contact or a candidate; (sixth review) one whose CRM time is no longer known (neither kept nor in the cache) is placement time_unknown, its at the load time it carries, never the customer''s side either. Earlier: message-shaped business_events on the jobs (recorded at or before p_as_of) with the who-to-whom labels of the proof-set reference (customer_side = grade_ref is_customer_counterpart), plus legacy inbox_events mail placed on the job, or from the client address and placed on no job (placement not_placed), with no business_events copy. Since 20261006031000 a row marked as a copy of another (metadata.duplicate_of) is left out, so the timeline, loops and contact counts never count one message twice. Inlinable helper (no SET, not SECURITY DEFINER) read by the job record functions. Service role only.';
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
  FROM public.business_events x
  CROSS JOIN LATERAL (SELECT CASE WHEN x.source = 'ghl_sms_cache_backfill'
                                  THEN public.context_job_record_crm_time(x.source, x.contact_id,
                                         coalesce(nullif(btrim(x.payload ->> 'ghl_message_id'), ''), substring(x.provider_message_id FROM '^ghl:(.+)$')), x.job_id)
                             END AS crm_at) ct
  -- the rows the record shows (every row on the job), so "no texts" never sits beside texts;
  -- a row marked as a copy of another is not shown, so it is not counted (20261006031000)
  WHERE x.job_id = p_job_id AND coalesce(x.recorded_at, x.occurred_at) <= p_as_of
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
 jb AS (SELECT nullif(btrim(j.ghl_contact_id), '') IS NULL AS contact_missing FROM public.jobs j WHERE j.id = p_job_id)
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
                      'other_jobs', (SELECT count(DISTINCT cs.id) FROM cs))
 )
$fn$;
COMMENT ON FUNCTION public.context_job_story_meta(uuid, timestamptz) IS
 'Job story (20261006014000), story safety (20261006040000): (ninth review) contact_shared {shared, by, other_jobs}: whether this job''s contact details sit on another client''s job: its CRM contact, its client phone or its client email (each by its placement key: context_phone_key, context_email_key) on a job whose client is someone else (no client name of the same words, at no site address the same by its key, its letters and digits or its street part before the first comma), by which (contact, email, phone) and on how many such jobs; such a contact is shared across clients (a builder''s or an agent''s), so the assembler never names its messages the insured''s. Earlier (eighth review) off_job {newest_customer_at, newest_customer_where, unchecked_customer_at, unchecked_customer_where, newest_reply_at, newest_reply_where}: this customer''s messages off this job outside the placement queue, from 30 days before the job was created: their CRM contact''s rows on another job (their other job, "on job X", or one no reader reads, a bucket: archived, complete, completed, cancelled, lost, a draft or holding, "on archived job X") and their email by the client''s address with no CRM contact placed on no job or on a bucket job (read as the old inbox''s mail is: from 30 days before the job, or whenever while the client has another job, then said to be maybe about another of their jobs), each timed as the job''s own rows are (a CRM text at its CRM time, never one whose time is unknown or before the lead window); unchecked_customer is the newest one not on a live job (no reader reads it); unplaced_invoices and its own contacts are the customer''s only: the job''s, its primary party''s, or one on its own invoices addressed to the customer (payer role customer), never a neighbour''s, the strata''s, another party''s or another payer''s, as the client story reads them; mail_copy_elsewhere counts a copy on any job that is not live (the judge''s live set). Earlier (sixth review) unplaced''s newest_customer_at and newest_reply_at also read every other row of this customer''s CRM contact placed on no job, whatever the ladder made of it (attribution status null or empty: never in the placement queue, so never in unplaced.count or newest_at); a CRM text whose CRM time is no longer known is time unknown: counted in time_unknown_texts {count} (on the job), never a lane''s or the unplaced newest or oldest time; unplaced_invoices {count, owing, items: [{id, number, party, owing, due_date, days_overdue}]}: the customer invoices placed on no job addressed to this job''s own Xero contact (the job''s, or one on its own invoices; never on builder work, nor a contact billed on builder work), still owing, recorded by p_as_of and made no earlier than 30 days before the job. Earlier: unplaced also gives newest_customer_at (the newest of this customer''s messages not placed on any job, as of p_as_of: a text or email, or a call answered or transcribed) and newest_reply_at (the newest we sent them there, never automated), so the story''s line never says there is no customer message while one waits unplaced; times a CRM text loaded later by the CRM''s own time (context_job_record_crm_time), on the job and placed on no job alike; history start, each lane''s newest and oldest and the unplaced newest_at, newest_customer_at and newest_reply_at leave out texts dated before the job''s lead window (still counted: on the job in before_job_texts {count, newest_at}, placed on no job in unplaced.count, the placement queue''s); mail_copy_elsewhere {count}: the legacy mail the record shows (context_job_record_legacy_mail, never withheld) that has a saved copy recorded by p_as_of, which then sits on no job or (seventh review) on an archived or holding job, never on a live one (shown from the old inbox), so the count is the mail the story shows. Earlier: evidence lanes on the job (linked rows only; counts and newest time per lane, legacy inbox mail counted as email), history start (rows marked as a copy of another, metadata.duplicate_of, are not counted, 20261006031000), this customer''s unplaced messages (context_unplaced_for_job), the legacy mail withheld because the client has another job (withheld_mail: counted, never the job''s email), and whether the job has a CRM contact. Unplaced messages are read as now. How far the reader has read comes from the ledger read, never the fact pass. Service role only.';

-- The story settled notes assembler (20261011120000), word for word.
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
 -- newest text, email or call, wherever it is placed (every customer contact this line names is
 -- one the rule counts). With no lead passed in (a caller of the pure assembler) the job is
 -- followed up. (Scoping pipeline, 20261009133000) A draft the rule does not monitor (state
 -- draft_quiet or draft_no_activity) is never off: its line is what it was, and only now.monitored
 -- says the rule does not monitor it. A lead's window is its job's own (context_lead_window_hours:
 -- 6 weeks on a patio job, else 4)
 ld AS (
  SELECT CASE WHEN jsonb_typeof(inp.rec -> 'lead' -> 'monitored') = 'boolean'
               AND coalesce(inp.rec -> 'lead' ->> 'state', '') NOT LIKE 'draft\_%'
              THEN NOT (inp.rec -> 'lead' ->> 'monitored')::boolean
              ELSE false END AS off,
         CASE WHEN jsonb_typeof(inp.rec -> 'lead' -> 'monitored') = 'boolean' THEN (inp.rec -> 'lead' ->> 'monitored')::boolean
              ELSE true END AS monitored,
         CASE WHEN jsonb_typeof(inp.rec -> 'lead' -> 'cutoff_at') = 'string' THEN (inp.rec -> 'lead' ->> 'cutoff_at')::timestamptz END AS cutoff_at,
         public.context_lead_window_hours(inp.job ->> 'type') AS win_h
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
 -- (story settled notes, 20261011120000) the newest ledger transition into each shown item's own
 -- status: when it closed, was declined, superseded or disputed, and the reader's reason. Only a
 -- move the reader judged counts: never the item's writing ("written": already in that status when
 -- written) or a rebuild copying it over ("carried forward from generation ..."), whose time is the
 -- write, not the event; a bare packet reference ("replaced by n6") is no reason (replaced_by names it)
 trn AS MATERIALIZED (
  SELECT DISTINCT ON (x ->> 'item_key' COLLATE "C") x ->> 'item_key' AS item_key, (x ->> 'at')::timestamptz AS at,
         CASE WHEN x ->> 'reason' ~ '^replaced by [a-z]*[0-9]+$' THEN NULL ELSE nullif(btrim(x ->> 'reason'), '') END AS reason,
         CASE WHEN jsonb_typeof(x -> 'evidence') = 'array' THEN x -> 'evidence' END AS evidence
  FROM inp CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(inp.led -> 'transitions') = 'array'
                                                        THEN inp.led -> 'transitions' ELSE '[]'::jsonb END) x
  JOIN vis v ON v.item_key = x ->> 'item_key' AND v.status = x ->> 'to_status'
  WHERE coalesce(x ->> 'reason', '') <> 'written' AND coalesce(x ->> 'reason', '') NOT LIKE 'carried forward from generation %'
  ORDER BY x ->> 'item_key' COLLATE "C", (x ->> 'at')::timestamptz DESC NULLS LAST, x ->> 'reason' COLLATE "C"
 ),
 -- (story settled notes) an issue or claim opened only on the customer's words: every row that
 -- opened it is the customer's (its own stamp, else the citation check's), so the story can say it
 -- is the customer's report, not yet checked, never work we owe as fact
 vcust AS (
  SELECT v.item_key FROM vis v
  WHERE v.item_type IN ('issue', 'claim') AND jsonb_typeof(v.opened_by) = 'array' AND jsonb_array_length(v.opened_by) > 0
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v.opened_by) o
                    WHERE NOT coalesce(CASE WHEN jsonb_typeof(o -> 'customer') = 'boolean' THEN (o ->> 'customer')::boolean END,
                                       (SELECT bool_or((c ->> 'customer')::boolean) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v.cited) = 'array'
                                                 THEN v.cited ELSE '[]'::jsonb END) c
                                        WHERE c ->> 'id' = o ->> 'id' AND jsonb_typeof(c -> 'customer') = 'boolean'),
                                       false))
 ),
 -- (story settled notes) an event the reader wrote from call logs alone (a call's provider status
 -- and duration, "no transcript is recorded"), once each call's transcript is on the job (meta
 -- call_transcripts, call row id to transcript id, from the story read): the transcript's own items
 -- say what was said, so the call-log event is not shown (SWF-261469: two "no transcript" events for
 -- calls whose transcripts landed minutes after the reader wrote them)
 evh AS (
  SELECT v.item_key FROM vis v, inp
  WHERE v.item_type = 'event' AND jsonb_typeof(inp.meta -> 'call_transcripts') = 'object'
    AND jsonb_typeof(v.opened_by) = 'array' AND jsonb_array_length(v.opened_by) > 0
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v.opened_by) c
                    WHERE c ->> 'table' IS DISTINCT FROM 'business_events' OR NOT coalesce(inp.meta -> 'call_transcripts' ? (c ->> 'id'), false))
 ),
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
         (g.rule = 'R8_not_yet_invoiced' AND ((SELECT ph0.work_done_at IS NULL OR ph0.reopened IS NOT NULL FROM ph0) OR g.amount IS NULL)) AS held,
         false AS customer_reported
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
         false, false,
         -- (story settled notes) opened only on the customer's words
         EXISTS (SELECT 1 FROM vcust vc WHERE vc.item_key = n.item_key)
  FROM norm n WHERE NOT EXISTS (SELECT 1 FROM att a WHERE a.item_key = n.item_key)
 ),
 -- (story lead rank, 20261011100000) which open loops may lead the line. Every loop stays in the
 -- list as it was (nothing is closed, hidden or written); only its rank and whether it may be the
 -- top item change. A held loop never leads, as before. Of the open loops on one object (about_key)
 -- only the newest may lead: an older ask the customer followed up on the same object never leads
 -- over the follow-up. And a loop that blocks an earlier stage than a newer open loop blocks (quote,
 -- acceptance, deposit, booking, install, completion, payment) never leads: a pre-install query
 -- never leads over a newer completion dispute (SWF-261469: a 5 Oct letterbox ask, blocking install,
 -- led the line over the 9 to 11 Oct workmanship complaint and the independent report awaited).
 -- The newest open loop of all can always lead, so some loop always may.
 lstage AS (
  SELECT l.*, array_position(ARRAY['quote','acceptance','deposit','booking','install','completion','payment'], l.blocks) AS stage
  FROM loops0 l
 ),
 lcan AS (
  SELECT l.*,
   (NOT l.held
    AND NOT EXISTS (SELECT 1 FROM lstage m
                    WHERE NOT m.held AND l.about_key IS NOT NULL AND m.about_key = l.about_key
                      AND (coalesce(m.since, '-infinity'::timestamptz) > coalesce(l.since, '-infinity'::timestamptz)
                           OR (coalesce(m.since, '-infinity'::timestamptz) = coalesce(l.since, '-infinity'::timestamptz)
                               AND m.key COLLATE "C" > l.key COLLATE "C")))
    AND NOT EXISTS (SELECT 1 FROM lstage m
                    WHERE NOT m.held AND l.stage IS NOT NULL AND m.stage > l.stage
                      AND coalesce(m.since, '-infinity'::timestamptz) > coalesce(l.since, '-infinity'::timestamptz))) AS may_lead,
   -- overtaken: a newer open loop blocks a later stage, so this one blocks nothing now (it stays a
   -- loop, open, with its own blocks, and leaves now.blockers only)
   EXISTS (SELECT 1 FROM lstage m
           WHERE NOT m.held AND l.stage IS NOT NULL AND m.stage > l.stage
             AND coalesce(m.since, '-infinity'::timestamptz) > coalesce(l.since, '-infinity'::timestamptz)) AS overtaken
  FROM lstage l
 ),
 loops AS (
  SELECT l.*, (inp.today - (l.since AT TIME ZONE 'Australia/Perth')::date) AS age_days,
         row_number() OVER (ORDER BY
           -- (story lead rank) the loops that may lead first, then the rest, then the held ones
           CASE WHEN l.held THEN 2 WHEN l.may_lead THEN 0 ELSE 1 END,
           CASE WHEN l.held THEN 4 WHEN l.owner = 'us' AND l.customer_waiting THEN 0 WHEN l.money THEN 1 WHEN l.owner = 'us' THEN 2 ELSE 3 END,
           l.since NULLS LAST, l.key COLLATE "C") AS rank
  FROM lcan l, inp
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
    -- (lead cutoff, 20261007010000) a lead no longer followed up: the rule counted every message of
    -- the customer's there is, so one newer than the start of its 4 weeks (6 on a patio job: scoping
    -- pipeline, 20261009133000) is not theirs (mail from one of our own addresses entered as the
    -- client's) and is never named as theirs
    AND NOT coalesce((SELECT ld.off FROM ld) AND x.at > (SELECT ld.cutoff_at - make_interval(hours => ld.win_h) FROM ld), false)
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
 -- it is unclear on (owner unknown) first, else the first one due now. (Story lead rank,
 -- 20261011100000) within the party whose move it is, a loop that may lead comes first; the party
 -- comes before it, so the line still never pairs one party's move with another's item (when every
 -- loop of that party is one that may not lead, its best-ranked loop is still the top)
 top AS (SELECT l.* FROM loops l, wm0 wm WHERE NOT l.held
         ORDER BY CASE WHEN wm.whose IN ('us', 'customer', 'third_party') AND l.owner IS DISTINCT FROM wm.whose THEN 1 ELSE 0 END,
                  CASE WHEN l.may_lead THEN 0 ELSE 1 END,
                  CASE WHEN wm.whose = 'unknown' AND l.owner = 'unknown' THEN 0 ELSE 1 END, l.rank
         LIMIT 1),
 -- (story lead rank, 20261011100000) the latest agreed position: the newest agreement the reader
 -- found agreed and still standing (open or info, never superseded, declined, disputed or closed),
 -- made in the 14 days up to now and after every open loop that may lead of the party whose move it
 -- is (of every party while whose move is unclear) opened: nothing that party owes is newer than
 -- what was agreed. The first line says it right after the phase and next is it (unless a visit is
 -- booked), so what was last agreed governs what happens next over older open items (SWF-261469:
 -- the 11 Oct agreement to inspect after the independent report over the 9 and 10 Oct defect
 -- reports). An agreement carries no date of its own, so an older one (a January install date on a
 -- job rebooked since) is never said as the latest position. The top item, whose move and every
 -- loop are unchanged.
 agl AS (
  SELECT v.item_key, v.what, v.opened_at, v.due_date,
         (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(v.opened_by) c) AS cites
  FROM vis v, inp, wm0 wm
  WHERE v.item_type = 'agreement' AND v.modality = 'agreed' AND v.status IN ('open', 'info')
    AND v.opened_at <= inp.as_of AND v.opened_at > inp.as_of - interval '14 days'
    AND EXISTS (SELECT 1 FROM top)
    AND NOT EXISTS (SELECT 1 FROM loops l
                    WHERE l.may_lead AND (wm.whose NOT IN ('us', 'customer', 'third_party') OR l.owner = wm.whose)
                      AND coalesce(l.since, '-infinity'::timestamptz) >= v.opened_at)
  ORDER BY v.opened_at DESC, v.item_key COLLATE "C" DESC LIMIT 1
 ),
 -- (story settled notes, 20261011120000) the job reads installed per the messages: the phase is
 -- install on a passed booking nobody marked started or complete (no attendance), and an open
 -- completion-stage note (it blocks completion, or its phase is complete or rectification) was
 -- opened on or after that booked day: the words say the work happened, the crew never marked it
 -- (SWF-261469: "Install under way; attendance not recorded" over eleven defect reports about the
 -- installed fence). The phase stays install; only its words change.
 ipm AS (
  SELECT EXISTS (SELECT 1 FROM phs, vis v
                 WHERE phs.phase = 'install' AND phs.unattended_on IS NOT NULL AND phs.started_at IS NULL
                   AND v.status = 'open' AND (v.blocks = 'completion' OR v.phase IN ('complete', 'rectification'))
                   AND v.opened_at >= (phs.unattended_on::timestamp AT TIME ZONE 'Australia/Perth')) AS on_
 ),
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
        -- (story settled notes) installed per the messages, the booked day named in the attendance words
        -- (on builder work, attended: a make-safe or repair is not an install)
        WHEN phs.phase = 'install' AND ipm.on_
        THEN CASE WHEN phs.type IN ('makesafe', 'repair', 'insurance') THEN 'Attended per messages' ELSE 'Installed per messages' END
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
   -- (story lead rank) the latest agreed position, cut at a word as the top item is
   (SELECT 'latest agreement ' || public.context_job_story_day((a.opened_at AT TIME ZONE 'Australia/Perth')::date, phs.today) || ': '
           || CASE WHEN length(w.w) <= 160 THEN w.w ELSE rtrim(left(w.w, 157 - position(' ' IN reverse(left(w.w, 157)))), ' ,;:') || '...' END
    FROM agl a, LATERAL (SELECT regexp_replace(rtrim(a.what, '. '), '\s+', ' ', 'g') AS w) w) AS agreed_words,
   CASE WHEN nx.b IS NOT NULL THEN 'next visit ' || coalesce(replace(nx.b->>'assignment_type', '_', ' ') || ' ', '') || 'booked ' || nx.day END AS next_words,
   -- a passed booking with no attendance recorded is named whatever the phase; a booking
   -- marked complete while nothing records the job finished says so; on builder work the
   -- attended day is named
   CASE WHEN phs.phase = 'install' AND phs.unattended_on IS NOT NULL
        THEN CASE WHEN ipm.on_ THEN 'attendance not marked for ' ELSE 'attendance not recorded for ' END
             || public.context_job_story_day(phs.unattended_on, phs.today)
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
             || ': ' || (ld.win_h / 168)::text || ' weeks after the last quote or message with no progress'
             || coalesce((SELECT '; open: ' || CASE WHEN length(w.w) <= 200 THEN w.w
                                                 ELSE rtrim(left(w.w, 197 - position(' ' IN reverse(left(w.w, 197)))), ' ,;:') || '...' END
                          FROM top t, LATERAL (SELECT regexp_replace(regexp_replace(t.what, '\. Lead not followed up since [^:]*: [0-9]+ weeks after the last quote or message with no progress$', ''),
                                                                     '\s+', ' ', 'g') AS w) w
                          WHERE NOT (position('R7_quote_waiting' IN t.rule) > 0 AND t.owner = 'customer')), '') END AS lead_words
  FROM phs, nx, mt, wm, led, inp, cw, dd, ld, ipm
 ),
 nowl AS (
  SELECT n.*, (SELECT string_agg(upper(left(x.s, 1)) || substr(x.s, 2), '. ' ORDER BY x.o) FROM (VALUES
           (1, n.phase_words || coalesce(': ' || n.next_words, '') || coalesce('; ' || n.att_words, '')),
           (2, n.agreed_words),
           (3, nullif(concat_ws(', ', n.owing_words, n.elsewhere_words, n.draft_words, n.nyi_words), '')),
           (4, coalesce(n.lead_words, n.move_words || coalesce(', ' || n.top_words, ''))),
           (5, n.decline_words),
           (6, coalesce(n.wrote_words, n.off_words)),
           (7, n.c6_words)) x(o, s) WHERE x.s IS NOT NULL) AS line0
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
    -- (story lead rank) a loop a newer open loop overtook (it blocks an earlier stage) blocks
    -- nothing now: it stays in the loops, open, with its blocks
    AND NOT l.overtaken
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
            -- (story settled notes) the phase is install and the messages say the work happened
            'installed_per_messages', (SELECT ipm.on_ FROM ipm),
            'whose_move', (SELECT wm.whose FROM wm),
            -- (lead cutoff, 20261007010000) whether the job is followed up, and since when it is not
            -- (scoping pipeline, 20261009133000) the rule's own answer, a draft's among them
            'monitored', (SELECT ld.monitored FROM ld),
            'not_followed_up_since', (SELECT CASE WHEN ld.off THEN (ld.cutoff_at AT TIME ZONE 'Australia/Perth')::date END FROM ld),
            'next', CASE WHEN (SELECT nx.b FROM nx) IS NOT NULL
                         THEN (SELECT jsonb_build_object('what', 'Visit booked: ' || replace(coalesce(nx.b->>'assignment_type', 'visit'), '_', ' ')
                                                         || coalesce(' (' || nullif(btrim(nx.b->>'crew_name'), '') || ')', ''),
                                                         'when', nx.b->'scheduled_date', 'day', nx.day,
                                                         'cites', jsonb_build_array(jsonb_build_object('t', 'job_assignments', 'id', nx.b->>'id'))) FROM nx)
                         -- (story lead rank) the latest agreed position, when made after the top item opened
                         WHEN EXISTS (SELECT 1 FROM agl)
                         THEN (SELECT jsonb_build_object('what', a.what, 'when', a.due_date, 'cites', coalesce(a.cites, '[]'::jsonb), 'kind', 'agreement')
                               FROM agl a)
                         WHEN EXISTS (SELECT 1 FROM top)
                         THEN (SELECT jsonb_build_object('what', t.what, 'when', t.due, 'cites', t.cites) FROM top t) END,
            'latest_agreement', (SELECT jsonb_build_object('key', a.item_key, 'what', a.what, 'since', a.opened_at, 'cites', coalesce(a.cites, '[]'::jsonb))
                                 FROM agl a),
            'blockers', coalesce((SELECT jsonb_agg(jsonb_build_object('what', b.what, 'cites', b.cites) ORDER BY b.o NULLS LAST, b.k COLLATE "C")
                                  FROM blockers b), '[]'::jsonb),
            'cites', coalesce((SELECT jsonb_agg(d.c ORDER BY d.c ->> 't' COLLATE "C" NULLS FIRST, d.c ->> 'id' COLLATE "C" NULLS FIRST)
                       FROM (SELECT DISTINCT z.c FROM (
                       SELECT c FROM top t, jsonb_array_elements(t.cites) c
                       UNION ALL SELECT c FROM agl a, jsonb_array_elements(coalesce(a.cites, '[]'::jsonb)) c
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
             'closing_evidence', l.closing_evidence, 'cites', l.cites, 'rank', l.rank,
             -- (story settled notes) an issue or claim opened only on the customer's words
             'customer_reported', l.customer_reported) ORDER BY l.rank) FROM loops l), '[]'::jsonb),
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
                   ORDER BY v.opened_at DESC, v.item_key COLLATE "C") FROM vis v WHERE v.item_type = 'phase_note'
                   AND v.status NOT IN ('disputed', 'superseded', 'declined')), '[]'::jsonb),
  'agreements', coalesce((SELECT jsonb_agg(jsonb_build_object('key', v.item_key, 'what', v.what, 'modality', v.modality, 'since', v.opened_at,
                  'status', v.status, 'supersedes', v.supersedes_key,
                  'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(v.opened_by) c))
                  ORDER BY v.opened_at DESC, v.item_key COLLATE "C") FROM vis v WHERE v.item_type = 'agreement'), '[]'::jsonb),
  'events', coalesce((SELECT jsonb_agg(jsonb_build_object('key', v.item_key, 'what', v.what, 'at', v.opened_at,
              'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(v.opened_by) c))
              ORDER BY v.opened_at DESC, v.item_key COLLATE "C") FROM vis v WHERE v.item_type = 'event'
              AND v.status NOT IN ('disputed', 'superseded', 'declined')
              AND NOT EXISTS (SELECT 1 FROM evh WHERE evh.item_key = v.item_key)), '[]'::jsonb),
  -- (story settled notes, 20261011120000) the notes the reader settled (closed, declined or
  -- superseded) and the ones it found disputed, newest first, each with its status, when and what
  -- settled it (the item's closing rows, else the transition's evidence; the reader's reason; the
  -- item that replaced it), so a cancelled visit, a corrected booking or our side of a dispute is
  -- never lost because nothing about it is open. Nothing is closed, opened or written here.
  'settled', coalesce((SELECT jsonb_agg(jsonb_build_object('key', v.item_key, 'type', v.item_type, 'what', v.what, 'about_key', v.about_key,
                'status', v.status, 'since', v.opened_at, 'closed_at', coalesce(v.closed_at, t.at),
                'closed_by', coalesce((SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id'))
                                       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v.closed_by) = 'array' AND jsonb_array_length(v.closed_by) > 0
                                                                      THEN v.closed_by ELSE coalesce(t.evidence, '[]'::jsonb) END) c), '[]'::jsonb),
                'reason', t.reason,
                'replaced_by', (SELECT s.item_key FROM vis s WHERE s.supersedes_key = v.item_key
                                ORDER BY s.opened_at DESC, s.item_key COLLATE "C" DESC LIMIT 1),
                'customer_reported', EXISTS (SELECT 1 FROM vcust vc WHERE vc.item_key = v.item_key),
                'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id'))
                          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v.opened_by) = 'array' THEN v.opened_by ELSE '[]'::jsonb END) c))
                ORDER BY coalesce(v.closed_at, t.at) DESC NULLS LAST, v.opened_at DESC, v.item_key COLLATE "C")
              FROM vis v LEFT JOIN trn t ON t.item_key = v.item_key
              WHERE v.status IN ('closed', 'declined', 'superseded')), '[]'::jsonb),
  'disputed', coalesce((SELECT jsonb_agg(jsonb_build_object('key', v.item_key, 'type', v.item_type, 'what', v.what, 'about_key', v.about_key,
                'status', v.status, 'since', v.opened_at, 'disputed_at', t.at, 'why', t.reason,
                'customer_reported', EXISTS (SELECT 1 FROM vcust vc WHERE vc.item_key = v.item_key),
                'cites', (SELECT jsonb_agg(d.c ORDER BY d.c ->> 't' COLLATE "C" NULLS FIRST, d.c ->> 'id' COLLATE "C" NULLS FIRST)
                          FROM (SELECT DISTINCT jsonb_build_object('t', c->>'table', 'id', c->>'id') AS c
                                FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v.opened_by) = 'array' THEN v.opened_by ELSE '[]'::jsonb END
                                                          || coalesce(t.evidence, '[]'::jsonb)) c) d))
                ORDER BY coalesce(t.at, v.opened_at) DESC, v.opened_at DESC, v.item_key COLLATE "C")
              FROM vis v LEFT JOIN trn t ON t.item_key = v.item_key
              WHERE v.status = 'disputed'), '[]'::jsonb),
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
             -- (story settled notes) call-log events not shown because each call's transcript is on the job
             'call_log_events_hidden', (SELECT count(*) FROM evh),
             -- (story settled notes) how many call logs on the job have their transcript on it (meta call_transcripts)
             'calls_with_transcript', (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(inp.meta -> 'call_transcripts') = 'object'
                                                                                 THEN inp.meta -> 'call_transcripts' ELSE '{}'::jsonb END)),
             'built_at', now())
           FROM inp, led)
 )
$fn$;
COMMENT ON FUNCTION public.context_job_story_assemble(jsonb, jsonb, jsonb, jsonb, timestamptz, timestamptz) IS
 'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000): (lead cutoff, 20261007010000) (scoping pipeline, 20261009133000) (story lead rank, 20261011100000) (story settled notes, 20261011120000) agreements, events and phase notes are newest first (items of one instant still by item key in C order); settled lists the notes the reader closed, declined or superseded and disputed the ones it found disputed, newest first, each with its status, when it settled or was disputed (the item''s closed_at, else the newest ledger transition the reader judged into that status: never its writing or a rebuild''s carry-forward), what settled it (closed_by: the item''s closing rows, else that transition''s evidence; reason: the reader''s; replaced_by: the item that supersedes it) or why it is disputed, and customer_reported; an event citing only call logs whose transcripts are on the job (meta call_transcripts, call row id to transcript id, from the story read) is not shown (meta.call_log_events_hidden counts them; meta.calls_with_transcript counts the pairs passed in); every loop carries customer_reported, true only on an issue or claim every opening row of which is the customer''s (its own stamp, else the citation check''s); and a job at install on a passed booking nobody marked, with an open completion-stage note (blocks completion, or phase complete or rectification) opened on or after that day, reads "Installed per messages; attendance not marked for <day>" ("Attended per messages" on builder work: a make-safe, repair or insurance job) (now.installed_per_messages true; the phase stays install). Nothing is closed, opened or written, and every loop stays. Earlier (story lead rank) the open loops that may lead the line rank first and the top item is one of them within the party whose move it is: a held loop never leads; of the open loops on one object (about_key) only the newest may lead; a loop that blocks an earlier stage (quote, acceptance, deposit, booking, install, completion, payment) than a newer open loop blocks never leads. Every loop stays in the list with its status (nothing is closed, hidden or written), whose move is unchanged, and the party still comes first, so when every loop of the party whose move it is may not lead, its best-ranked loop is still the top; a loop overtaken by a newer open loop at a later stage leaves now.blockers (it stays a loop, open, with its blocks); and the newest standing agreement (modality agreed, status open or info), made in the 14 days up to as_of and after every open loop that may lead of the party whose move it is (of every party while that is unclear), is the latest agreed position: the first line says it right after the phase ("Latest agreement <day>: ...", cut at a word at 160 characters), next is it unless a visit is booked (kind agreement), now.latest_agreement names it and now.cites carries its citations. Earlier (scoping pipeline) only a lead the rule calls not followed up (record lead state not_followed_up, or a lead row with no state, as before) is off: a draft the rule does not monitor (state draft_quiet or draft_no_activity) keeps its line, whose move and the off-job messages it names, and now.monitored is the rule''s own answer (false for such a draft, true when no lead is passed in); the lead words and the start of the window the off-job check uses are the job''s own window (context_lead_window_hours: "6 weeks" on a patio job, else "4 weeks"). Earlier (lead cutoff) a lead no longer followed up (record lead, from context_lead_monitored_jobs: still at quoted with no progress 28 days after the newer of its newest quote send and the customer''s newest text, email or call, wherever it is placed, so every customer contact the line names is one the rule counts) is never the customer''s move: whose_move not_followed_up, and the first line says "Lead not followed up since <day>: 4 weeks after the last quote or message with no progress" in place of whose move, then the item still open on it unless that is the quote waiting on the customer (whose own words end the same); on such a lead an off-job message newer than the start of its 4 weeks (meta off_job, unplaced, withheld_mail) is never named as the customer''s, since the rule counted every one of theirs (such a message is mail from one of our own addresses entered as the client''s); now.monitored and now.not_followed_up_since say so (true and null when the record carries no lead, as for any caller of the pure assembler). Earlier (ninth review) on builder work the job''s CRM contact and client email are the insured''s only when the make-safe details name the builder (facts.builder) and meta contact_shared says none of the job''s contact details (CRM contact, client phone, client email) sits on another client''s job; otherwise (a contact shared across clients, a builder''s or an agent''s, no builder named, or the meta silent) the line calls their messages the job contact''s ("the job contact''s newest message", "the job contact wrote last"), they hold the builder''s move as the customer''s messages do, who gives the insured no shared contact, and not_known says the contact details are on another client''s job. Earlier (eighth review) an off-job message changes the move only of what its sender owes: the customer''s own items on private work, never a neighbour''s or another payer''s, and never on builder work while the job''s CRM contact and client email are the insured''s (the line names them "the insured") and the builder owes; the customer''s newest message on the job (a text, an email, an answered call or a call recording) that no finished reading has read makes whose move unclear over the top item they or another party owe from before it, named with our last reply; a reading with an item hidden gives no all-clear and says how many are hidden; the contact facts also take meta off_job (their rows on their other jobs and on bucket jobs, their email by address with no CRM contact), where each sits named; a newer message off the job is named after the customer wrote last; a draft shown as an R3 check is said in the first line and the money line to maybe duplicate issued invoices. Earlier (seventh review) whose move is unclear while the customer''s newest message is off the job and newer than the opening of the top item they or another party owe, and the line names that message, where it sits and that the reader has not checked it, with our last reply (one older than that item leaves its move standing); the phase reads a job the job value calls accepted (facts.accepted: the job row''s acceptance, an accepted quote or a paid deposit invoice) as at least accepted, since then, and processing on work other than a make-safe as accepted once it is; not_known says the mail shown from the old inbox has its saved copy on no job or on an archived or holding job (a copy on a live job takes the mail off this job). Earlier (sixth review) a job in rectification now has no work done (the final invoice is not due, said so), and the final invoice is not due either while work recorded finished was opened again since (facts.reopened: a status change into rectification or a make-safe re-attend, nothing recording it finished since); a quote waiting (R7) is a check once the work is done; a reading that has read every row on the job gives no all-clear while the customer''s newest message is off the job (meta unplaced newest_customer_at or withheld_mail newest_at newer than every customer message on the job): whose move is unknown and the line names that message, where it sits, and that the reader has not checked it; the first line and the money line name what this job''s own Xero contact owes on invoices placed on no job (meta unplaced_invoices; money.placed_on_no_job), never counting them in owing; not_known names texts whose CRM time is no longer kept. Earlier: until a finished reading shown (live or retired, or a shadow the story shows only when asked for it by id, so a grade reads the line a promotion gives; never a building or failed one) has read every row on the job (none unread), nothing open on record is never nobody''s move: whose_move unknown, the first line says "Whose move is unclear:" first, then that no record item is open (or due yet) and the messages are not yet checked for promises or requests (a reading that lags: how many newer messages, calls, notes or documents, ours included, it has not checked), with the newest customer message and our last reply, of the job''s own, this customer''s messages placed on no job yet and their withheld mail, naming where the newest sits (with neither anywhere it says so and claims nothing unchecked); with no finished reading handling.commitments is null, and only a finished reading judges a customer message; work is done only on a completion status, a completion record (facts.completion) or a report pack sent, never because the newest booking is complete; a final invoice (R8) before the work is done is not due (loop status not_due), and after it with the job value unconfirmed (C2, no amount) it is unconfirmed (status unconfirmed): either ranks last and is never the move or the first line''s item; a value another record disagrees with (C2) states no amount left to invoice; a quote the customer was in touch about since it was sent, in a way that does not close it (R7 owner unknown), makes whose move unclear and is the item the first line names; the first line''s item is cut at a word (200 characters); the customer''s unread words are "not yet checked by the reader"; the first line names each invoice owing with its due date, who owes it ("owed by") with their role whenever a neighbour or another payer owes it (whatever the move: its payer role, else its R1, R2 or M1 loop''s owner), and each payer when more than one owes, a passed booking with no attendance, a quote declined and the newest unread customer words (R5, C11, C6); the first line names the top loop of the party whose move it is, never another party''s (the customer''s move never names a neighbour''s invoice); a quote waiting reads as waiting on the customer; another party''s invoice reads as another payer owing; on builder work the builder is the customer and the homeowner the insured; not_known names mail shown from the old inbox and texts dated before the job. Earlier, story fixes: every text sort and tiebreak that reaches the output is in C (byte) order (who, money parties, loops and their rank, cites, checks, timeline, phase notes, agreements, events, not known, changes, blockers), so the story reads the same on every server whatever the input order. Earlier: the pure assembler of job-story-v1. Reads no table: job header, record parts (timeline, loops, money, contact, facts), ledger (generation, items with citation re-check result, transitions, its reader''s unread rows) and meta in; the cited story out. meta.ledger = {status, generation_id, evidence_until, reader, items, hidden_items, unread_rows, needs_rebuild, stale}. Inlinable (no SET). Service role only.';
DROP FUNCTION IF EXISTS public.context_job_card_decisions(uuid);
DROP FUNCTION IF EXISTS public.context_job_card_events(uuid[]);
REVOKE ALL ON FUNCTION public.context_job_record_messages(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story_meta(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_record_messages(uuid[], timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story_meta(uuid, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.context_job_story_assemble(jsonb, jsonb, jsonb, jsonb, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_story_assemble(jsonb, jsonb, jsonb, jsonb, timestamptz, timestamptz) TO service_role;
