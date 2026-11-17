-- P0-01.1 follow-up: page build cost and fair retry turns (cx-page-speed).
-- Definitions only: existing triggers, timers and business writers are untouched.
SET LOCAL lock_timeout='5s';
-- The switch is STABLE. A scalar subquery reads it once per statement rather
-- than once per projected message, without changing either flag branch.
DO $guard$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_record_messages(uuid[],timestamptz)'::regprocedure)
  NOT IN ('c2b73175d602d5add3cf19bceeaae7eb','4ab1e2a3ff35aa69576f80a06d7b42ba') THEN
  RAISE EXCEPTION 'job_page_speed_messages_preimage_mismatch';
 END IF;
END $guard$;
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
         CASE WHEN (SELECT public.context_ledger_person_placement_enabled())
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

-- A retry is new queue work, not proof that a page was built. Retire only the
-- visible pending marks and append one explicit retry at the back, atomically.
-- Business markers INSERT into the heap and share no updated row or advisory lock.
CREATE OR REPLACE FUNCTION public.job_page_yield(p_job_id uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $yield$
 WITH events AS (
  -- job_change_mark_events_job bounds dense queues to one job; the sparse
  -- job_change_mark_events_due partial index is also available.
  UPDATE public.job_change_mark_events SET page_pending=false
  WHERE job_id=p_job_id AND page_pending RETURNING 1
 ), base AS (
  -- job_change_marks_pkey bounds dense queues to one row; the sparse
  -- job_change_marks_base_due partial index is also available.
  UPDATE public.job_change_marks_base SET page_pending=false
  WHERE job_id=p_job_id AND page_pending RETURNING 1
 )
 INSERT INTO public.job_change_mark_events(job_id,source)
 SELECT p_job_id,'page_retry' WHERE EXISTS(SELECT 1 FROM events) OR EXISTS(SELECT 1 FROM base)
$yield$;
REVOKE ALL ON FUNCTION public.job_page_yield(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_page_yield(uuid) TO service_role;

-- Preserve main's record-close branch; refuse an unreviewed predecessor.
DO $guard$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_page_refresh(uuid)'::regprocedure)
  NOT IN ('9d307590b45a66132143fd5bbc241c93','7c10bf73a85170c37f9a88051cb5ce47') THEN
  RAISE EXCEPTION 'job_page_speed_refresh_preimage_mismatch';
 END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.job_page_refresh(p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
 v_t0 timestamptz; v_covers timestamptz; v_version bigint; v_card jsonb; v_text jsonb; v_page jsonb;
 v_ms integer; v_outcome text := 'built'; v_events bigint[]; v_error text; v_close jsonb; v_item jsonb; v_close_on boolean := false;
 /* build block */ BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = p_job_id) THEN
  RETURN jsonb_build_object('outcome','no_job');
 END IF;
 -- Only page builders use this nonblocking lock. Business writes never acquire it.
 IF NOT pg_try_advisory_xact_lock(20261118, hashtext(p_job_id::text)) THEN
  PERFORM public.job_page_yield(p_job_id);
  RETURN '{"outcome":"busy"}'::jsonb;
 END IF;
 v_t0 := clock_timestamp();
 /* build block */ BEGIN
 -- Off retains the existing page/response exactly. No candidate read or queue write.
 /* switch block */ BEGIN
  v_close_on := coalesce((SELECT enabled FROM public.feature_flags WHERE flag_name='context_record_close_v1'),false);
 EXCEPTION WHEN OTHERS THEN v_close_on := false; END;
 IF v_close_on THEN
  /* record block */ BEGIN
   v_close := public.context_ledger_close_on_records(p_job_id);
  EXCEPTION WHEN OTHERS THEN v_close := jsonb_build_object('error',left(SQLERRM,200)); END;
  IF v_close->>'wrote'='true' THEN
   FOR v_item IN SELECT value FROM jsonb_array_elements(coalesce(v_close->'ambiguous_items','[]')) LOOP
    /* reconcile block */ BEGIN
     PERFORM public.context_reconcile_raise('open_item_check',p_job_id,v_item->>'item_id',
      'An open note may already be settled: more than one record fits. Pick the record or leave it open.',v_item->'candidates');
    EXCEPTION WHEN OTHERS THEN NULL; END;
   END LOOP;
  END IF;
 END IF;
 -- Version and visible event identities share ONE snapshot. A later low-sequence
 -- commit cannot be acknowledged by a timestamp or a max(sequence) cutoff.
 SELECT m.last_marked_at,m.mark_version,
  ARRAY(SELECT e.mark_version FROM public.job_change_mark_events e WHERE e.job_id=p_job_id)
 INTO v_covers,v_version,v_events FROM public.job_change_marks m WHERE m.job_id=p_job_id;
  v_card := public.context_job_story(p_job_id);
  v_text := public.context_job_story_text_get(p_job_id, v_card, true);
  v_page := jsonb_build_object('version','job-page-v1','as_at',v_t0,'card',v_card,'story_text',v_text,
   'notes',NULL,'invoices',NULL,'bills',NULL,'matching',NULL,'profit',NULL,
   'summary',jsonb_build_object('phase',v_card #>> '{now,phase}', 'now_line',left(v_card #>> '{now,line}',200),
    'whose_move',v_card #> '{now,whose_move}',
    'open_items',CASE WHEN jsonb_typeof(v_card -> 'loops') = 'array' THEN jsonb_array_length(v_card -> 'loops') ELSE 0 END,
    'loops',CASE WHEN jsonb_typeof(v_card -> 'loops') = 'array' THEN v_card -> 'loops' ELSE '[]'::jsonb END));
  v_ms := (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::integer;
  -- Compare-and-save the observed version. An in-flight or later business commit leaves a
  -- newer version due, even if it lands immediately after this comparison. No mark-row CAS
  -- UPDATE: that would still lock business writes until the caller's transaction commits.
  INSERT INTO public.job_pages (job_id,page,card_hash,built_at,covers_marked_at,covers_mark_version,build_ms,page_version,status,error)
  SELECT p_job_id,v_page,v_text ->> 'card_hash',v_t0,v_covers,v_version,v_ms,public.job_page_version(),'ready',NULL
  WHERE (SELECT mark_version FROM public.job_change_marks WHERE job_id=p_job_id) IS NOT DISTINCT FROM v_version
  ON CONFLICT (job_id) DO UPDATE SET page=EXCLUDED.page,card_hash=EXCLUDED.card_hash,
   built_at=EXCLUDED.built_at,covers_marked_at=EXCLUDED.covers_marked_at,
   covers_mark_version=EXCLUDED.covers_mark_version,build_ms=EXCLUDED.build_ms,
   page_version=EXCLUDED.page_version,status=EXCLUDED.status,error=NULL;
  IF NOT FOUND THEN
   PERFORM public.job_page_yield(p_job_id);
   RETURN jsonb_build_object('outcome','changed','build_ms',v_ms);
  END IF;
 /* build block */ BEGIN
   IF v_text ->> 'status' = 'stale' THEN
    PERFORM public.context_job_story_request(p_job_id,'job-page-refresh','job_changed');
   END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  PERFORM public.job_page_ack(p_job_id,v_version,v_covers,v_events);
 EXCEPTION WHEN OTHERS OR query_canceled THEN
  v_outcome := 'failed';
  v_error := left(SQLSTATE || ' ' || SQLERRM,200);
  v_ms := (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::integer;
  -- A cancellation during the initial read also yields. This indexed retry runs
  -- after PostgreSQL has delivered the cancellation, before any build is retried.
  IF v_version IS NULL THEN
   SELECT m.last_marked_at,m.mark_version,
    ARRAY(SELECT e.mark_version FROM public.job_change_mark_events e WHERE e.job_id=p_job_id)
   INTO v_covers,v_version,v_events FROM public.job_change_marks m WHERE m.job_id=p_job_id;
  END IF;
  INSERT INTO public.job_pages (job_id,page,built_at,build_ms,status,error)
  VALUES (p_job_id,'{"version":"job-page-v1","failed":true}'::jsonb,v_t0,v_ms,'failed',v_error)
  ON CONFLICT (job_id) DO UPDATE SET status='failed',error=EXCLUDED.error,built_at=EXCLUDED.built_at,build_ms=EXCLUDED.build_ms;

  PERFORM public.job_page_ack(p_job_id,v_version,v_covers,v_events);
 END;
 RETURN jsonb_build_object('outcome',v_outcome,'build_ms',v_ms)
  || CASE WHEN v_close_on THEN jsonb_build_object('record_close',v_close-'ambiguous_items') ELSE '{}'::jsonb END;
END $fn$;
