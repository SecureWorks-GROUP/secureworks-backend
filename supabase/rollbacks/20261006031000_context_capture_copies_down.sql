-- Down migration for 20261006031000_context_capture_copies.
--
-- Restores context_event_source_admissible to 20261002170000's body,
-- capture_ghl_history_event to M4's (20260925031500),
-- context_job_record_messages to 20261006011000's and context_job_story_meta
-- to 20261006014000's, each md5 checked at the end, and drops
-- context_ghl_message_copies. After it, a row marked as a copy
-- (metadata.duplicate_of) is read and counted again like any other row, and
-- the GHL history load saves a message another writer already saved. No
-- business_events row is touched: undo the marking first with
-- scripts/context-dedupe-copies-undo.sql if the marks should go too. Refuses
-- when a replaced function is neither this migration's body nor the restored
-- one (a later migration owns it now: roll that back first).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_event_source_admissible(public.business_events)',ARRAY['09efe91e52fd78c868a7a387bd10fff5','fefd29131583c8e2afef18eca885b4d7']),
  ('public.capture_ghl_history_event(jsonb)',ARRAY['1411b79a4389048ba5de109fe6701e94','3e51278532e7c92a64b0cc9935ce2652']),
  ('public.context_job_record_messages(uuid[],timestamptz)',ARRAY['805d8ae8acb9add8f6e3c4cc08813287','19affb4ac2c447f86b9842357d1cf6a0']),
  ('public.context_job_story_meta(uuid,timestamptz)',ARRAY['e7bdb045dc47859e1c03096724737c0d','afdf3a143d44be8ca7b6253f52cebefa'])
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_capture_copies_rollback_mismatch: %; a later migration replaced these, roll it back first',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 20261002170000's admission rule.
CREATE OR REPLACE FUNCTION public.context_event_source_admissible(e public.business_events) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT coalesce(
  e.job_id IS NOT NULL
  AND e.attribution_status IS NOT NULL AND public.context_linked_status(e.attribution_status)
  AND (e.payload OPERATOR(pg_catalog.#>>) '{job_id}'::pg_catalog.text[] IS NULL
   OR e.payload OPERATOR(pg_catalog.#>>) '{job_id}'::pg_catalog.text[] OPERATOR(pg_catalog.=) e.job_id::pg_catalog.text)
  AND coalesce(e.event_at,e.occurred_at) IS NOT NULL
  AND e.attribution_confidence IS NOT NULL
  AND e.attribution_confidence OPERATOR(pg_catalog.>=) 0 AND e.attribution_confidence OPERATOR(pg_catalog.<=) 1
  AND e.metadata OPERATOR(pg_catalog.#>>) '{retracted_at}'::pg_catalog.text[] IS NULL
  AND (e.metadata OPERATOR(pg_catalog.#>>) '{retracted}'::pg_catalog.text[] IS NULL
   OR e.metadata OPERATOR(pg_catalog.#>>) '{retracted}'::pg_catalog.text[] OPERATOR(pg_catalog.<>) 'true'),
 false)
$$;
COMMENT ON FUNCTION public.context_event_source_admissible(public.business_events) IS
 'True when persist_luna_context_revision would accept this row as a source for its own job: linked status, payload.job_id absent or equal to job_id (exact text), a source time, an attribution confidence in [0,1], not retracted in metadata. The one admission rule both batch readers apply (20261002170000). Service role only.';

-- M4's history door (20260925031500).
CREATE OR REPLACE FUNCTION public.capture_ghl_history_event(p_row jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pol jsonb:=public.context_ghl_history_policy();
BEGIN
 IF p_row IS NULL OR jsonb_typeof(p_row)<>'object' THEN RETURN jsonb_build_object('outcome','error','code','capture_row_invalid'); END IF;
 IF jsonb_typeof(p_row->'metadata')<>'object' OR p_row->'metadata'->>'capture_mode' IS DISTINCT FROM 'backfill' THEN
  RETURN jsonb_build_object('outcome','error','code','history_row_not_backfill');
 END IF;
 IF p_row->>'source' IS DISTINCT FROM pol->>'event_source' THEN RETURN jsonb_build_object('outcome','error','code','history_row_source_invalid'); END IF;
 -- A history row never asserts a job: the ladder decides, and the writer's
 -- upgrade rule (a verified direct job id) can never fire from this door.
 IF nullif(p_row->>'job_id','') IS NOT NULL OR coalesce(nullif(p_row->>'match_method',''),'none')<>'none' THEN
  RETURN jsonb_build_object('outcome','error','code','history_row_job_refused');
 END IF;
 -- With the attribution lane off the ladder places nothing; history is loaded
 -- only while it is on, so every row is placed at its own time on insert.
 IF NOT public.automation_lane_enabled('attribution') THEN RETURN jsonb_build_object('outcome','error','code','attribution_disabled'); END IF;
 RETURN public.capture_business_event(p_row);
END $$;
COMMENT ON FUNCTION public.capture_ghl_history_event(jsonb) IS
 'M4: the GHL history load''s only writer. Accepts only a capture_mode backfill row from source ghl-history-load that names no job, only while the attribution lane is on, and saves it through capture_business_event; the placement-owned trigger places it. Writes no placement field. Returns the writer''s outcome.';

-- 20261006011000's record messages helper.
CREATE OR REPLACE FUNCTION public.context_job_record_messages(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, source_table text, source_id text, at timestamptz, event_type text, source text,
 channel text, direction text, words text, counterpart_role text, sender_role text, audience text,
 recipient_role text, is_job_contact boolean, from_is_client boolean, to_is_client boolean, sent_by_kind text,
 internal_role text, is_msg boolean, is_note boolean, customer_side boolean, internal boolean, automated boolean,
 bad_call boolean, call_answered boolean, placement text)
LANGUAGE sql STABLE
AS $fn$
 WITH j AS (
  SELECT jb.id, lower(nullif(btrim(jb.client_email), '')) AS cmail, nullif(btrim(jb.ghl_contact_id), '') AS ccontact
  FROM public.jobs jb WHERE jb.id = ANY (p_job_ids)
 ),
 ev AS (
  SELECT j.id AS jid, j.cmail, j.ccontact, e.id, coalesce(e.event_at, e.occurred_at) AS at, e.event_type, e.source,
         e.channel, e.direction, e.contact_id, e.payload, e.metadata,
         regexp_replace(public.context_event_text(e), '\s+', ' ', 'g') AS txt,
         -- crew and staff alerts are texts we send; inbound rows are never one
         CASE WHEN e.direction = 'outbound' THEN public.context_internal_text_role(e) ELSE 'other' END AS irole,
         (e.channel IN ('sms', 'email', 'call')
          OR e.event_type IN ('client.sms_out', 'client.email_out', 'client.call_logged', 'client.call_complete',
                              'call.transcript_completed', 'client.reply', 'client.email_in', 'client.sms_in')) AS is_msg,
         (e.event_type IN ('note.added', 'ghl.internal_comment') OR e.channel = 'note') AS is_note
  FROM j JOIN public.business_events e ON e.job_id = j.id
  WHERE coalesce(e.recorded_at, e.occurred_at) <= p_as_of
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
         nullif(ev.payload->>'sent_by_kind', '') AS sbk
  FROM ev
 ),
 bel AS (
  SELECT l.jid, 'business_events'::text AS tbl, l.id::text AS sid, l.at, l.event_type, l.source, l.channel, l.direction,
         left(l.txt, 300) AS words, l.cp, l.sr, l.aud, l.rr, l.ijc, l.fic, l.tic, l.sbk, l.irole, l.is_msg, l.is_note,
         (l.is_msg AND CASE WHEN l.rr IS NOT NULL THEN false
                            WHEN l.cp IS NOT NULL THEN l.cp = 'customer'
                            ELSE coalesce(l.ijc, false) OR coalesce(l.fic, false) OR coalesce(l.tic, false) END) AS cust,
         (l.rr IN ('crew', 'staff') OR l.aud = 'internal' OR l.irole <> 'other' OR l.cp IN ('crew', 'staff')
          OR (l.is_msg AND l.direction = 'internal')) AS internal,
         (l.sbk = 'workflow' OR l.irole <> 'other') AS automated,
         (l.direction = 'inbound' AND l.channel = 'call'
          AND l.txt ~* 'Provider status: (no-answer|ringing|busy|missed|voicemail|canceled|cancelled)') AS bad_call,
         ((l.channel = 'call' OR l.event_type IN ('client.call_logged', 'client.call_complete', 'call.transcript_completed'))
          AND (l.event_type = 'call.transcript_completed'
               OR lower(coalesce(l.payload->>'call_status', substring(l.txt FROM 'Provider status: ([A-Za-z_-]+)'), ''))
                  IN ('completed', 'answered'))) AS answered,
         'on_job'::text AS placement
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
 'Job record (20261006011000): message-shaped business_events on the jobs (recorded at or before p_as_of) with the who-to-whom labels of the proof-set reference (customer_side = grade_ref is_customer_counterpart), plus legacy inbox_events mail placed on the job, or from the client address and placed on no job (placement not_placed), with no business_events copy. Inlinable helper (no SET, not SECURITY DEFINER) read by the job record functions. Service role only.';

-- 20261006014000's story meta.
CREATE OR REPLACE FUNCTION public.context_job_story_meta(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH e AS (
  SELECT CASE WHEN x.event_type = 'call.transcript_completed' THEN 'transcripts'
              WHEN x.channel = 'sms' OR x.event_type IN ('client.reply', 'client.sms_in', 'client.sms_out') THEN 'texts'
              WHEN x.channel = 'email' OR x.event_type IN ('client.email_in', 'client.email_out', 'supplier.email_in', 'staff.email_internal') THEN 'emails'
              WHEN x.channel = 'call' OR x.event_type IN ('client.call_logged', 'client.call_complete') THEN 'calls'
              WHEN x.event_type IN ('note.added', 'ghl.internal_comment') OR x.channel = 'note' THEN 'notes'
              WHEN x.event_type = 'document.text_extracted' THEN 'documents' END AS lane,
         coalesce(x.event_at, x.occurred_at) AS at
  FROM public.business_events x
  -- the rows the record shows (every row on the job), so "no texts" never sits beside texts
  WHERE x.job_id = p_job_id AND coalesce(x.recorded_at, x.occurred_at) <= p_as_of
 ),
 l AS (SELECT e.lane, count(*) AS n, max(e.at) AS newest, min(e.at) AS oldest FROM e WHERE e.lane IS NOT NULL GROUP BY e.lane),
 lgm AS MATERIALIZED (SELECT m.received_at, m.placement FROM public.context_job_record_legacy_mail(ARRAY[p_job_id], p_as_of) m),
 lg AS (  -- legacy inbox mail the record layer reads counts as email
  SELECT count(*) AS n, max(m.received_at) AS newest, min(m.received_at) AS oldest FROM lgm m WHERE m.placement <> 'withheld'
 ),
 wh AS (  -- a repeat client's mail placed on no job: not this job's, said so
  SELECT count(*) AS n, max(m.received_at) AS newest FROM lgm m WHERE m.placement = 'withheld'
 ),
 un AS (  -- this customer's messages not placed on any job yet that could be this job's
  SELECT count(*) AS n, max(coalesce(u.event_at, u.occurred_at)) AS newest FROM public.context_unplaced_for_job(p_job_id) u
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
  'unplaced', (SELECT jsonb_build_object('count', un.n, 'newest_at', un.newest) FROM un),
  'withheld_mail', (SELECT jsonb_build_object('count', wh.n, 'newest_at', wh.newest) FROM wh),
  'contact_missing', coalesce((SELECT jb.contact_missing FROM jb), false)
 )
$fn$;
COMMENT ON FUNCTION public.context_job_story_meta(uuid, timestamptz) IS
 'Job story (20261006014000): evidence lanes on the job (linked rows only; counts and newest time per lane, legacy inbox mail counted as email), history start, this customer''s unplaced messages (context_unplaced_for_job), the legacy mail withheld because the client has another job (withheld_mail: counted, never the job''s email), and whether the job has a CRM contact. Unplaced messages are read as now. How far the reader has read comes from the ledger read, never the fact pass. Service role only.';

DROP FUNCTION IF EXISTS public.context_ghl_message_copies(jsonb);

REVOKE ALL ON FUNCTION public.context_event_source_admissible(public.business_events),public.capture_ghl_history_event(jsonb),
 public.context_job_record_messages(uuid[],timestamptz),public.context_job_story_meta(uuid,timestamptz)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_event_source_admissible(public.business_events),public.capture_ghl_history_event(jsonb),
 public.context_job_record_messages(uuid[],timestamptz),public.context_job_story_meta(uuid,timestamptz)
TO service_role;

DO $$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_event_source_admissible(public.business_events)','fefd29131583c8e2afef18eca885b4d7'),
  ('public.capture_ghl_history_event(jsonb)','3e51278532e7c92a64b0cc9935ce2652'),
  ('public.context_job_record_messages(uuid[],timestamptz)','19affb4ac2c447f86b9842357d1cf6a0'),
  ('public.context_job_story_meta(uuid,timestamptz)','afdf3a143d44be8ca7b6253f52cebefa')
 ) AS t(sig,want) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.want THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF to_regprocedure('public.context_ghl_message_copies(jsonb)') IS NOT NULL THEN problems:=problems||'context_ghl_message_copies(jsonb) still exists'::text; END IF;
 IF cardinality(problems)>0 THEN RAISE EXCEPTION 'context_capture_copies rollback: bodies not restored: %',array_to_string(problems,'; '); END IF;
END $$;
