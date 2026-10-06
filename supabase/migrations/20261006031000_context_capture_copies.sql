-- Duplicate capture (gap map W9, 6 Oct 2026): a message is saved once, and a
-- copy that is already saved is marked and never read again.
--
-- Why: a read-only census of production on 6 Oct 2026 (the Opus S9 rule: same
-- live job, channel and direction, same words, times within 120 seconds, a
-- different row) found 334 copy rows out of 5,557 worded message rows, on 77
-- live jobs. Each copy is read by the model, can become its own fact, and
-- doubles a count in a job's story ("we followed up twice"). Read pair by
-- pair, 256 of them are the same message saved twice, by two writers or by
-- one writer twice:
--   * 187 old-path emails (monitor-inbox): one email sent to several of our
--     mailboxes is saved once per mailbox (same sender, subject and words);
--     fixed in monitor-inbox/index.ts and self_copy.ts, not here;
--   * 66 GHL texts saved by a key-less older writer (ghl-proxy before it keyed
--     its rows, ops-api backfill_ghl_conversations) and saved again by a keyed
--     writer under ghl:<id>; the GHL history load is the writer still doing
--     it (15 of the 37 copies recorded in the last 24 hours);
--   * 3 call transcripts of the same recording.
-- The other 78 match the S9 rule but are different messages (two photos sent
-- a minute apart, two missed calls, one alert texted to two crew members, two
-- separate deliveries to one mailbox, two staff notes); they are left alone.
--
-- What it does:
--  1. context_event_source_admissible(e): 20261002170000's rule plus one term:
--     a row marked as a copy (metadata.duplicate_of, the id of the row it
--     copies) is not admissible. Every reader that hands rows to the model goes
--     through this rule: context_unread_rows (and so the cadence, the pool and
--     context_extraction_events), context_catchup_eligible_rows and
--     context_catchup_pending_rows, and the ledger reader's
--     context_ledger_row_admissible (20261006013000). So a marked copy never
--     wakes a read, is never handed out and is never cited again. The
--     revision store (persist_luna_context_revision) and the current-facts
--     view are NOT changed: a fact that already cites a copy stays current,
--     because the copy is the same message as its original. Nothing that
--     points at a copy breaks, and no row moves.
--  2. context_ghl_message_copies(p_rows): for GHL message rows as
--     _shared/evidence/ghl_message.ts builds them (a JSON array), the row
--     another writer already saved for the same message, one per input row at
--     most: first a row with no ghl: key whose payload names the same GHL
--     message id (payload.ghl_message_id or payload.message_id), the oldest
--     first (copy_rule ghl_message_id); else a row with no ghl: key and no GHL
--     message id at all, for the same GHL contact, channel and direction, with
--     the same words, within 5 seconds (copy_rule same_words_and_time). A row
--     the builder describes in brackets (no words: a photo, a call log) never
--     matches by words. A row that carries a different GHL message id is a
--     different message and never matches. Read only.
--     A stored row counts only when it can stand in for the new one: it is
--     read as the new row would be (admissible by the rule in 1, captured,
--     written as service_role), has the same channel and has words when the
--     new row has words. A row on no job, in admin_bucket or with no status,
--     with no channel, retracted or itself marked as a copy is not a stand-in,
--     so the keyed row is saved and placed (6 Oct 2026, read only: 436 keyed
--     history rows are read today while their key-less twin is not, and about
--     1,800 key-less rows that name a GHL id are not read).
--  3. capture_ghl_history_event(p_row): M4's body (20260925031500) plus one
--     step before the writer: when no row holds this row's own key yet and
--     context_ghl_message_copies names a row another writer already saved,
--     nothing is written and the answer is outcome duplicate with
--     copy_of_other_writer true, the stored row's id, job_id,
--     attribution_status, copy_rule and stored_by (its source). A fault in
--     that check never stops the load: the row is written as before and the
--     answer carries copy_check_error.
--  4. The job record layer counts what the readers read: a marked copy is
--     left out of context_job_record_messages (20261006011000; and so the
--     timeline, loops and contact counts that read it) and of the evidence
--     lanes in context_job_story_meta (20261006014000). One email saved once
--     per mailbox no longer counts as three customer messages in the story.
--
-- Marking the copies already saved is not done here. It is the separate,
-- guarded script scripts/context-dedupe-copies.sql (read-only census, then a
-- dry run ending in ROLLBACK with an exact-count guard), with its undo
-- scripts/context-dedupe-copies-undo.sql.
--
-- No business_events row is written, no flag changes, nothing is granted to
-- anon or authenticated. Replaced functions:
-- public.context_event_source_admissible(public.business_events)
-- (20261002170000, md5 fefd29131583c8e2afef18eca885b4d7) and
-- public.capture_ghl_history_event(jsonb) (20260925031500, md5
-- 3e51278532e7c92a64b0cc9935ce2652),
-- public.context_job_record_messages(uuid[],timestamptz) (20261006011000, md5
-- 19affb4ac2c447f86b9842357d1cf6a0) and
-- public.context_job_story_meta(uuid,timestamptz) (20261006014000, md5
-- afdf3a143d44be8ca7b6253f52cebefa); each read live on production on 6 Oct
-- 2026. The guard refuses unless each is that body or already this
-- migration's (a re-apply).
-- Rollback: supabase/rollbacks/20261006031000_context_capture_copies_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_event_source_admissible(public.business_events)',ARRAY['fefd29131583c8e2afef18eca885b4d7','09efe91e52fd78c868a7a387bd10fff5']),
  ('public.capture_ghl_history_event(jsonb)',ARRAY['3e51278532e7c92a64b0cc9935ce2652','1411b79a4389048ba5de109fe6701e94']),
  ('public.context_job_record_messages(uuid[],timestamptz)',ARRAY['19affb4ac2c447f86b9842357d1cf6a0','805d8ae8acb9add8f6e3c4cc08813287']),
  ('public.context_job_story_meta(uuid,timestamptz)',ARRAY['afdf3a143d44be8ca7b6253f52cebefa','e7bdb045dc47859e1c03096724737c0d'])
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF to_regprocedure('public.context_event_text(public.business_events)') IS NULL THEN
  problems:=problems||'public.context_event_text(public.business_events) missing'::text;
 END IF;
 IF to_regprocedure('public.capture_business_event(jsonb)') IS NULL OR to_regprocedure('public.context_ghl_history_policy()') IS NULL THEN
  problems:=problems||'capture_business_event(jsonb) or context_ghl_history_policy() missing (apply 20260925031500 first)'::text;
 END IF;
 IF to_regprocedure('public.context_ghl_message_copies(jsonb)') IS NOT NULL
  AND coalesce(obj_description(to_regprocedure('public.context_ghl_message_copies(jsonb)'),'pg_proc'),'') NOT LIKE 'Capture copies:%' THEN
  problems:=problems||'public.context_ghl_message_copies(jsonb) exists and is not this migration''s'::text;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.business_events'::regclass AND a.attname='duplicate_of'
   AND a.attnum>0 AND NOT a.attisdropped)
 THEN problems:=problems||'business_events has a duplicate_of column; the admission rule reads metadata.duplicate_of only'::text; END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_capture_copies_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The one admission rule, plus: a row marked as a copy is not read.
-- Invoker SQL with no SET clause, so context_unread_rows stays inlinable.
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
   OR e.metadata OPERATOR(pg_catalog.#>>) '{retracted}'::pg_catalog.text[] OPERATOR(pg_catalog.<>) 'true')
  -- capture copies (20261006031000): a marked copy of another row is never read.
  AND e.metadata OPERATOR(pg_catalog.#>>) '{duplicate_of}'::pg_catalog.text[] IS NULL,
 false)
$$;
COMMENT ON FUNCTION public.context_event_source_admissible(public.business_events) IS
 'True when persist_luna_context_revision would accept this row as a source for its own job: linked status, payload.job_id absent or equal to job_id (exact text), a source time, an attribution confidence in [0,1], not retracted in metadata (20261002170000); and not marked as a copy of another row (metadata.duplicate_of, 20261006031000). The one admission rule the batch readers, the catch-up set and the ledger reader apply. The revision store and the current-facts view do not read duplicate_of, so a fact that cites a copy stays current. Service role only.';

-- 2. The row another writer already saved for the same GHL message.
CREATE OR REPLACE FUNCTION public.context_ghl_message_copies(p_rows jsonb)
RETURNS TABLE(provider_message_id text, id uuid, job_id uuid, attribution_status text, source text, copy_rule text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH r AS (
  SELECT x.r ->> 'provider_message_id' AS k,
   substring(x.r ->> 'provider_message_id' FROM '^ghl:(.+)$') AS gid,
   nullif(btrim(coalesce(x.r ->> 'contact_id', x.r #>> '{payload,ghl_contact_id}', '')), '') AS contact,
   x.r ->> 'channel' AS channel, x.r ->> 'direction' AS direction,
   CASE WHEN x.r ->> 'event_at' ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}' THEN (x.r ->> 'event_at')::timestamptz END AS at,
   btrim(public.context_event_text(jsonb_populate_record(NULL::public.business_events,
    jsonb_build_object('payload', x.r -> 'payload', 'body_preview', x.r -> 'body_preview')))) AS words,
   coalesce(x.r #>> '{payload,described_by_capture}', '') = 'true' AS described
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_rows) = 'array' THEN p_rows ELSE '[]'::jsonb END) x(r)
  WHERE jsonb_typeof(x.r) = 'object'
 )
 SELECT r.k, c.id, c.job_id, c.attribution_status, c.source, c.copy_rule
 FROM r CROSS JOIN LATERAL (
  SELECT s.id, s.job_id, s.attribution_status, s.source, s.copy_rule FROM (
   -- An older key-less row naming the same GHL message id.
   SELECT e.id, e.job_id, e.attribution_status, e.source, 'ghl_message_id'::text AS copy_rule,
    coalesce(e.event_at, e.occurred_at) AS t, 1 AS pref
   FROM public.business_events e
   WHERE r.gid IS NOT NULL
    AND (e.payload @> jsonb_build_object('ghl_message_id', r.gid) OR e.payload @> jsonb_build_object('message_id', r.gid))
    AND (e.provider_message_id IS NULL OR e.provider_message_id NOT LIKE 'ghl:%')
    -- It stands in only when the readers read it as they would the new row:
    -- the same channel, worded when the new row is, and read (below).
    AND e.channel = r.channel
    AND (r.words = '' OR btrim(public.context_event_text(e)) <> '')
    AND public.context_event_source_admissible(e) AND e.context_captured_at IS NOT NULL
    AND coalesce(e.metadata ->> 'written_as', 'service_role') = 'service_role'
   UNION ALL
   -- An older row with no GHL id at all: same contact, channel, direction and
   -- words, within 5 seconds. Never for a bracketed (word-less) row.
   SELECT e.id, e.job_id, e.attribution_status, e.source, 'same_words_and_time'::text,
    coalesce(e.event_at, e.occurred_at), 2
   FROM public.business_events e
   WHERE NOT r.described AND r.words <> '' AND r.contact IS NOT NULL AND r.at IS NOT NULL
    AND (e.contact_id = r.contact OR e.payload @> jsonb_build_object('ghl_contact_id', r.contact))
    AND e.channel = r.channel AND e.direction = r.direction
    AND coalesce(e.event_at, e.occurred_at) BETWEEN r.at - interval '5 seconds' AND r.at + interval '5 seconds'
    AND (e.provider_message_id IS NULL OR e.provider_message_id NOT LIKE 'ghl:%')
    AND coalesce(e.payload ->> 'ghl_message_id', e.payload ->> 'message_id', '') = ''
    AND btrim(public.context_event_text(e)) = r.words
    AND public.context_event_source_admissible(e) AND e.context_captured_at IS NOT NULL
    AND coalesce(e.metadata ->> 'written_as', 'service_role') = 'service_role'
  ) s
  ORDER BY s.pref, s.t, s.id
  LIMIT 1
 ) c
$$;
COMMENT ON FUNCTION public.context_ghl_message_copies(jsonb) IS
 'Capture copies: for GHL message rows as _shared/evidence/ghl_message.ts builds them (a JSON array), the row another writer already saved for the same message, at most one per input row (20261006031000): a row with no ghl: key whose payload names the same GHL message id (payload.ghl_message_id or message_id), oldest first, copy_rule ghl_message_id; else a row with no ghl: key and no GHL message id, same GHL contact, channel and direction, the same words, within 5 seconds, copy_rule same_words_and_time (never for a bracketed word-less row). A row with its own different GHL id is a different message and never matches. A stored row counts only when it can stand in for the new one: admissible (context_event_source_admissible), captured, written as service_role, the same channel, and worded when the new row is; otherwise the new row is saved. Read only. Service role only.';

-- 3. The history load's door: M4's checks, then the copy check, then the writer.
CREATE OR REPLACE FUNCTION public.capture_ghl_history_event(p_row jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pol jsonb:=public.context_ghl_history_policy(); c record; check_error text;
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
 -- capture copies (20261006031000): a message another writer already saved is
 -- not saved again. A row with its own key already saved goes to the writer,
 -- which answers duplicate as before.
 IF NOT EXISTS(SELECT 1 FROM public.business_events e WHERE e.provider_message_id=nullif(btrim(p_row->>'provider_message_id'),'')) THEN
  BEGIN
   SELECT * INTO c FROM public.context_ghl_message_copies(jsonb_build_array(p_row)) LIMIT 1;
   IF c.id IS NOT NULL THEN
    RETURN jsonb_build_object('outcome','duplicate','id',c.id,'job_id',c.job_id,'attribution_status',c.attribution_status,
     'upgraded',false,'copy_of_other_writer',true,'copy_rule',c.copy_rule,'stored_by',c.source);
   END IF;
  EXCEPTION WHEN OTHERS THEN
   check_error:=SQLSTATE;
  END;
 END IF;
 IF check_error IS NOT NULL THEN
  RETURN public.capture_business_event(p_row)||jsonb_build_object('copy_check_error',check_error);
 END IF;
 RETURN public.capture_business_event(p_row);
END $$;
COMMENT ON FUNCTION public.capture_ghl_history_event(jsonb) IS
 'M4: the GHL history load''s only writer. Accepts only a capture_mode backfill row from source ghl-history-load that names no job, only while the attribution lane is on, and saves it through capture_business_event; the placement-owned trigger places it. Writes no placement field. Returns the writer''s outcome. Since 20261006031000 a message another writer already saved (context_ghl_message_copies) is not saved again: outcome duplicate with copy_of_other_writer true, the stored row''s id, job_id, attribution_status, copy_rule and stored_by; a fault in that check writes the row as before and adds copy_check_error.';

-- 4. The job record layer counts what the readers read: a marked copy is not
-- a message of the job (20261006011000's body plus one condition).
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
 'Job record (20261006011000): message-shaped business_events on the jobs (recorded at or before p_as_of) with the who-to-whom labels of the proof-set reference (customer_side = grade_ref is_customer_counterpart), plus legacy inbox_events mail placed on the job, or from the client address and placed on no job (placement not_placed), with no business_events copy. Since 20261006031000 a row marked as a copy of another (metadata.duplicate_of) is left out, so the timeline, loops and contact counts never count one message twice. Inlinable helper (no SET, not SECURITY DEFINER) read by the job record functions. Service role only.';

-- 5. The story's evidence lanes count the rows the record shows
-- (20261006014000's body plus one condition).
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
  -- the rows the record shows (every row on the job), so "no texts" never sits beside texts;
  -- a row marked as a copy of another is not shown, so it is not counted (20261006031000)
  WHERE x.job_id = p_job_id AND coalesce(x.recorded_at, x.occurred_at) <= p_as_of
    AND x.metadata #>> '{duplicate_of}' IS NULL
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
 'Job story (20261006014000): evidence lanes on the job (linked rows only; counts and newest time per lane, legacy inbox mail counted as email), history start (rows marked as a copy of another, metadata.duplicate_of, are not counted, 20261006031000), this customer''s unplaced messages (context_unplaced_for_job), the legacy mail withheld because the client has another job (withheld_mail: counted, never the job''s email), and whether the job has a CRM contact. Unplaced messages are read as now. How far the reader has read comes from the ledger read, never the fact pass. Service role only.';

-- 6. Grants: service role only.
REVOKE ALL ON FUNCTION public.context_event_source_admissible(public.business_events),
 public.context_ghl_message_copies(jsonb),public.capture_ghl_history_event(jsonb),
 public.context_job_record_messages(uuid[],timestamptz),public.context_job_story_meta(uuid,timestamptz)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_event_source_admissible(public.business_events),
 public.context_ghl_message_copies(jsonb),public.capture_ghl_history_event(jsonb),
 public.context_job_record_messages(uuid[],timestamptz),public.context_job_story_meta(uuid,timestamptz)
TO service_role;
