-- Story settled notes contract: the story shows settled and disputed notes newest first, lists
-- agreements, events and phase notes newest first, leaves out a call-log event once its transcript
-- is on the job, says "Installed per messages" when the crew never marked a passed booking and the
-- notes report the finished work, and marks issues and claims opened on the customer's words. The
-- assembler is pure, so every case but the last is a fixture passed in; nothing is written outside
-- a rolled-back transaction. Fixed as-of instant: Sun 11 Oct 2026 12:00 Perth. Job numbers only.
BEGIN;
CREATE FUNCTION pg_temp.li(p_key text, p_type text, p_from text, p_to text, p_what text, p_about text, p_blocks text,
  p_opened timestamptz, p_status text DEFAULT 'open', p_phase text DEFAULT NULL, p_modality text DEFAULT NULL,
  p_closed timestamptz DEFAULT NULL, p_closed_by jsonb DEFAULT NULL, p_supersedes text DEFAULT NULL, p_opened_by jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $li$
 SELECT jsonb_build_object('item_key', p_key, 'item_type', p_type, 'status', p_status, 'from_role', p_from, 'to_role', p_to,
  'what', p_what, 'about_key', p_about, 'modality', p_modality, 'phase', p_phase, 'blocks', coalesce(p_blocks, 'none'),
  'opened_at', p_opened, 'closed_at', p_closed, 'closed_by', p_closed_by, 'supersedes_key', p_supersedes,
  'needs_reply', false, 'closes_on', 'reply', 'written_by', 'luna-ledger:v2', 'cites_ok', true,
  'opened_by', coalesce(p_opened_by, jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', 'ev-' || p_key,
                                                      'excerpt', 'words of ' || p_key, 'customer', p_from = 'customer', 'at', p_opened))))
$li$;
CREATE FUNCTION pg_temp.led(p_items jsonb, p_transitions jsonb DEFAULT '[]'::jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $l$
 SELECT jsonb_build_object('status', 'live', 'generation', jsonb_build_object('id', 'g1', 'status', 'live', 'evidence_until', '2026-10-11T02:33:00Z'),
                           'unread_rows', 0, 'unread_ids', '[]'::jsonb, 'read_ids', '[]'::jsonb, 'items', p_items, 'transitions', p_transitions)
$l$;
CREATE FUNCTION pg_temp.tr(p_key text, p_to text, p_at timestamptz, p_reason text, p_evidence text DEFAULT NULL) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $t$
 SELECT jsonb_build_object('item_key', p_key, 'to_status', p_to, 'at', p_at, 'reason', p_reason, 'by', 'model:luna-ledger:v2',
   'evidence', CASE WHEN p_evidence IS NULL THEN '[]'::jsonb
                    ELSE jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', p_evidence, 'excerpt', 'evidence')) END)
$t$;

DO $story$
DECLARE
 asof timestamptz := '2026-10-11T04:00:00Z';
 job jsonb := '{"id":"00000000-0000-4000-8000-000000261469","job_number":"SWF-261469","status":"in_progress","type":"fencing","created_at":"2026-09-22T00:00:00Z"}';
 -- three install bookings for Fri 9 Oct, none marked started or complete (SWF-261469's shape)
 rec jsonb := jsonb_build_object('facts', jsonb_build_object('bookings', jsonb_build_array(
   jsonb_build_object('id', 'bk-1', 'status', 'confirmed', 'scheduled_date', '2026-10-09', 'assignment_type', 'install', 'created_at', '2026-09-24T06:00:00Z'),
   jsonb_build_object('id', 'bk-2', 'status', 'scheduled', 'scheduled_date', '2026-10-09', 'assignment_type', 'install', 'created_at', '2026-10-04T04:00:00Z'))));
 calls jsonb := '{"call-fri":"tx-fri","call-sat":"tx-sat"}';
 items jsonb; trs jsonb; s jsonb; b jsonb; n int;
BEGIN
 items := jsonb_build_array(
   -- open loops: two defects the customer reports after the install day (blocks completion), one claim
   -- opened on her words and our installer's text, a request of ours
   pg_temp.li('i-loose', 'issue', 'customer', 'us', 'The customer reports the fence is loose in three sections.', 'defect:fence-loose', 'completion',
              '2026-10-09T08:00:00Z', 'open', 'rectification'),
   pg_temp.li('i-tops', 'issue', 'customer', 'us', 'The customer reports the post tops are uneven.', 'defect:post-tops', 'completion',
              '2026-10-09T09:00:00Z', 'open', 'install', NULL, NULL, NULL, NULL,
              -- her own stamp is absent on the opening row; the citation check says it is hers
              '[{"table":"business_events","id":"ev-tops"}]'::jsonb),
   pg_temp.li('c-footings', 'claim', 'customer', 'us', 'The customer says some posts had no concrete; our installer says 40 kg went in each.',
              'defect:post-footings', NULL, '2026-10-09T08:40:00Z', 'open', 'rectification', NULL, NULL, NULL, NULL,
              '[{"table":"business_events","id":"ev-her-text","customer":true},{"table":"business_events","id":"ev-installer","customer":false}]'::jsonb),
   pg_temp.li('r-super', 'request', 'customer', 'us', 'The customer asked for the supervisor''s name and email.', 'contact:supervisor', NULL,
              '2026-10-09T23:10:00Z'),
   -- settled: a booking agreement superseded by its correction, a visit commitment the customer
   -- cancelled (closed), our Sunday visit she declined; a closed request with a carry-forward only
   pg_temp.li('a-old', 'agreement', 'us', 'customer', 'Install agreed for Wed 30 Sep.', 'booking:install', NULL, '2026-09-24T03:31:00Z',
              'superseded', 'scheduled', 'agreed', '2026-09-25T10:01:00Z', '[{"table":"business_events","id":"ev-rebook"}]'::jsonb),
   pg_temp.li('a-new', 'agreement', 'us', 'customer', 'Install agreed for Fri 9 Oct, 7 to 10am, materials Thu 8 Oct.', 'booking:install', NULL,
              '2026-09-25T10:01:00Z', 'info', 'scheduled', 'agreed', NULL, NULL, 'a-old'),
   pg_temp.li('k-sat', 'commitment', 'us', 'customer', 'We committed to inspect the fence at about 7am Sat 10 Oct.', 'defect:fence-loose', NULL,
              '2026-10-09T08:51:00Z', 'closed', 'rectification', NULL, '2026-10-09T10:07:00Z', '[{"table":"business_events","id":"ev-cancel"}]'::jsonb),
   pg_temp.li('k-sun', 'commitment', 'us', 'customer', 'We said we would arrive in 25 minutes on Sun 11 Oct.', 'access:inspection-timing', NULL,
              '2026-10-11T01:48:00Z', 'declined', 'rectification'),
   pg_temp.li('r-quote', 'request', 'customer', 'us', 'The customer asked us to quote the fence.', 'quote:q-0797', 'quote',
              '2026-09-22T01:27:00Z', 'closed', 'enquiry', NULL, NULL, NULL),
   -- disputed: her email-only request against our later text
   pg_temp.li('n-email', 'constraint', 'customer', 'us', 'The customer asked that all contact be by email.', 'contact:communication', NULL,
              '2026-10-11T01:49:00Z', 'disputed', 'rectification'),
   -- events: from a call log alone (its transcript is on the job), from a no-answer call (no
   -- transcript), from a call log and a text, and the customer's complaint
   pg_temp.li('e-fri', 'event', 'us', 'customer', 'A 206-second call completed Fri 9 Oct; the log records no transcript.', 'contact:call', NULL,
              '2026-10-09T08:39:00Z', 'info', 'rectification', NULL, NULL, NULL, NULL, '[{"table":"business_events","id":"call-fri"}]'::jsonb),
   pg_temp.li('e-sat', 'event', 'us', 'customer', 'A 124-second call completed Sat 10 Oct; no transcript is recorded.', 'contact:call', NULL,
              '2026-10-09T23:04:00Z', 'info', 'rectification', NULL, NULL, NULL, NULL, '[{"table":"business_events","id":"call-sat"}]'::jsonb),
   pg_temp.li('e-sun', 'event', 'us', 'customer', 'We called on Sun 11 Oct and the customer did not answer.', 'contact:call', NULL,
              '2026-10-11T01:11:00Z', 'info', 'rectification', NULL, NULL, NULL, NULL, '[{"table":"business_events","id":"call-noanswer"}]'::jsonb),
   pg_temp.li('e-mixed', 'event', 'us', 'customer', 'We told the customer by text and by call that the supervisor was told.', 'contact:call', NULL,
              '2026-10-09T09:09:00Z', 'info', 'rectification', NULL, NULL, NULL, NULL,
              '[{"table":"business_events","id":"call-fri"},{"table":"business_events","id":"text-sup"}]'::jsonb),
   pg_temp.li('e-cp', 'event', 'customer', 'us', 'The customer reports a complaint lodged with Consumer Protection.', 'other:complaint', NULL,
              '2026-10-11T01:57:00Z', 'info', 'rectification'),
   pg_temp.li('p-old', 'phase_note', 'us', 'customer', 'The neighbour agreed and the customer pays the whole fence.', 'scope:shared-fence', NULL,
              '2026-09-22T01:00:00Z', 'info', 'scope'),
   pg_temp.li('p-new', 'phase_note', 'customer', 'us', 'The independent report is due Mon 12 Oct.', 'report:independent', NULL,
              '2026-10-11T01:30:00Z', 'info', 'rectification'));
 -- the cited set the citation check returns: the tops row is the customer's
 items := (SELECT jsonb_agg(CASE WHEN x->>'item_key' = 'i-tops'
                                 THEN x || '{"cited":[{"table":"business_events","id":"ev-tops","customer":true,"ok":true}]}'::jsonb ELSE x END)
           FROM jsonb_array_elements(items) x);
 trs := jsonb_build_array(
   pg_temp.tr('a-old', 'superseded', '2026-10-08T05:17:00Z', 'written', 'ev-rebook'),
   pg_temp.tr('k-sat', 'open', '2026-10-09T09:12:00Z', 'written'),
   pg_temp.tr('k-sat', 'closed', '2026-10-09T10:19:00Z', 'The customer cancelled the Saturday visit and arranged her own inspection.', 'ev-cancel'),
   pg_temp.tr('k-sun', 'declined', '2026-10-11T02:33:00Z', 'The customer declined the visit at short notice.', 'ev-decline'),
   pg_temp.tr('r-quote', 'closed', '2026-10-08T05:17:00Z', 'carried forward from generation 11111111-0000-4000-8000-000000000000', 'ev-q'),
   pg_temp.tr('n-email', 'open', '2026-10-11T02:33:00Z', 'written'),
   pg_temp.tr('n-email', 'disputed', '2026-10-11T02:36:00Z', 'We replied by text after the customer asked for email only.', 'ev-our-text'));
 s := public.context_job_story_assemble(job, rec, pg_temp.led(items, trs), jsonb_build_object('call_transcripts', calls), asof, NULL);
 b := public.context_job_story_assemble(job, rec, pg_temp.led(items, trs), NULL, asof, NULL);

 -- 1. settled: closed, declined and superseded, newest first, each with its status, when and what
 -- settled it; the carry-forward transition is no reason and gives no time
 IF (SELECT string_agg(x->>'key', ',' ORDER BY o) FROM jsonb_array_elements(s->'settled') WITH ORDINALITY y(x, o)) IS DISTINCT FROM 'k-sun,k-sat,a-old,r-quote'
    OR (SELECT x->>'status' FROM jsonb_array_elements(s->'settled') x WHERE x->>'key' = 'k-sun') IS DISTINCT FROM 'declined'
    OR (SELECT (x->>'closed_at')::timestamptz FROM jsonb_array_elements(s->'settled') x WHERE x->>'key' = 'k-sun') IS DISTINCT FROM '2026-10-11T02:33:00Z'::timestamptz
    OR (SELECT x->'closed_by' FROM jsonb_array_elements(s->'settled') x WHERE x->>'key' = 'k-sun') IS DISTINCT FROM '[{"t":"business_events","id":"ev-decline"}]'::jsonb
    OR (SELECT x->>'reason' FROM jsonb_array_elements(s->'settled') x WHERE x->>'key' = 'k-sat') IS DISTINCT FROM 'The customer cancelled the Saturday visit and arranged her own inspection.'
    OR (SELECT (x->>'closed_at')::timestamptz FROM jsonb_array_elements(s->'settled') x WHERE x->>'key' = 'k-sat') IS DISTINCT FROM '2026-10-09T10:07:00Z'::timestamptz
    OR (SELECT x->'closed_by' FROM jsonb_array_elements(s->'settled') x WHERE x->>'key' = 'k-sat') IS DISTINCT FROM '[{"t":"business_events","id":"ev-cancel"}]'::jsonb
    OR (SELECT x->>'replaced_by' FROM jsonb_array_elements(s->'settled') x WHERE x->>'key' = 'a-old') IS DISTINCT FROM 'a-new'
    OR (SELECT x->>'reason' FROM jsonb_array_elements(s->'settled') x WHERE x->>'key' = 'a-old') IS NOT NULL
    OR (SELECT x->>'reason' FROM jsonb_array_elements(s->'settled') x WHERE x->>'key' = 'r-quote') IS NOT NULL
    OR (SELECT x->'closed_at' FROM jsonb_array_elements(s->'settled') x WHERE x->>'key' = 'r-quote') IS DISTINCT FROM 'null'::jsonb
    OR (SELECT x->'closed_by' FROM jsonb_array_elements(s->'settled') x WHERE x->>'key' = 'r-quote') IS DISTINCT FROM '[]'::jsonb THEN
  RAISE EXCEPTION 'story settled notes contract: settled lists closed, declined and superseded notes newest first, with what settled them: %', s->'settled';
 END IF;
 -- disputed: newest first, with when, why and both sides' rows
 IF jsonb_array_length(s->'disputed') <> 1 OR s->'disputed'->0->>'key' IS DISTINCT FROM 'n-email'
    OR (s->'disputed'->0->>'disputed_at')::timestamptz IS DISTINCT FROM '2026-10-11T02:36:00Z'::timestamptz
    OR s->'disputed'->0->>'why' IS DISTINCT FROM 'We replied by text after the customer asked for email only.'
    OR s->'disputed'->0->'cites' IS DISTINCT FROM '[{"t":"business_events","id":"ev-n-email"},{"t":"business_events","id":"ev-our-text"}]'::jsonb THEN
  RAISE EXCEPTION 'story settled notes contract: disputed lists the disputed note with when, why and both sides: %', s->'disputed';
 END IF;

 -- 2. nothing closed or lost: the loops are the open ones only, as before, with the same rank,
 -- status and blocks (only customer_reported is added); whose move and next are unchanged
 IF (SELECT jsonb_agg(x - 'customer_reported' ORDER BY (x->>'rank')::int) FROM jsonb_array_elements(s->'loops') x)
      IS DISTINCT FROM (SELECT jsonb_agg(x - 'customer_reported' ORDER BY (x->>'rank')::int) FROM jsonb_array_elements(b->'loops') x)
    OR (SELECT string_agg(x->>'key', ',' ORDER BY x->>'key') FROM jsonb_array_elements(s->'loops') x) IS DISTINCT FROM 'c-footings,i-loose,i-tops,r-super'
    OR s->'now'->'next' IS DISTINCT FROM b->'now'->'next' OR s->'now'->'whose_move' IS DISTINCT FROM b->'now'->'whose_move'
    OR s->'now'->'blockers' IS DISTINCT FROM b->'now'->'blockers' THEN
  RAISE EXCEPTION 'story settled notes contract: every open loop is kept as it was: %', s->'loops';
 END IF;

 -- 3. customer_reported: an issue every opening row of which is the customer's (her own stamp, or the
 -- citation check's); never a claim one of whose rows is ours, never a request
 IF (SELECT string_agg(x->>'key', ',' ORDER BY x->>'key') FROM jsonb_array_elements(s->'loops') x WHERE (x->>'customer_reported')::boolean)
      IS DISTINCT FROM 'i-loose,i-tops'
    OR (SELECT count(*) FROM jsonb_array_elements(s->'loops') x WHERE jsonb_typeof(x->'customer_reported') <> 'boolean') <> 0 THEN
  RAISE EXCEPTION 'story settled notes contract: customer_reported only on issues and claims opened on the customer''s words: %', s->'loops';
 END IF;

 -- 4. agreements, events and phase notes newest first; the two call-log events are left out once
 -- their transcripts are on the job, the no-answer call and the mixed event stay; without the meta
 -- key every event stays
 IF (SELECT string_agg(x->>'key', ',' ORDER BY o) FROM jsonb_array_elements(s->'agreements') WITH ORDINALITY y(x, o)) IS DISTINCT FROM 'a-new,a-old'
    OR (SELECT string_agg(x->>'what', ' | ' ORDER BY o) FROM jsonb_array_elements(s->'phase_notes') WITH ORDINALITY y(x, o))
       IS DISTINCT FROM 'The independent report is due Mon 12 Oct. | The neighbour agreed and the customer pays the whole fence.'
    OR (SELECT string_agg(x->>'key', ',' ORDER BY o) FROM jsonb_array_elements(s->'events') WITH ORDINALITY y(x, o)) IS DISTINCT FROM 'e-cp,e-sun,e-mixed'
    OR (SELECT string_agg(x->>'key', ',' ORDER BY o) FROM jsonb_array_elements(b->'events') WITH ORDINALITY y(x, o)) IS DISTINCT FROM 'e-cp,e-sun,e-sat,e-mixed,e-fri'
    OR (s->'meta'->>'call_log_events_hidden')::int <> 2 OR (b->'meta'->>'call_log_events_hidden')::int <> 0
    OR (s->'meta'->>'calls_with_transcript')::int <> 2 THEN
  RAISE EXCEPTION 'story settled notes contract: newest first, and a call-log event leaves once its transcript is on the job: % %', s->'events', s->'meta';
 END IF;

 -- 5. installed per messages: the passed booking nobody marked, with completion-stage defects
 -- opened that day, reads installed per the messages, attendance not marked
 IF position('Installed per messages; attendance not marked for Fri 9 Oct. ' IN s->'now'->>'line') <> 1
    OR position('Install under way' IN s->'now'->>'line') > 0 OR s->'now'->>'phase' IS DISTINCT FROM 'install'
    OR NOT (s->'now'->>'installed_per_messages')::boolean THEN
  RAISE EXCEPTION 'story settled notes contract: SWF-261469 shape reads installed per messages: %', s->'now';
 END IF;
 -- on builder work it is attended, not installed
 s := public.context_job_story_assemble(job || '{"type":"makesafe","status":"processing","job_number":"SWMS-26782"}', rec, pg_temp.led(items, trs), NULL, asof, NULL);
 IF position('Attended per messages; attendance not marked for Fri 9 Oct. ' IN s->'now'->>'line') <> 1 THEN
  RAISE EXCEPTION 'story settled notes contract: a make-safe reads attended per messages: %', s->'now'->>'line';
 END IF;
 -- controls: with every completion-stage note opened before the booked day, or none open, the
 -- earlier words stand
 s := public.context_job_story_assemble(job, rec, pg_temp.led(jsonb_build_array(
        pg_temp.li('i-early', 'issue', 'customer', 'us', 'The customer asked about gaps under the old fence.', 'defect:gaps', 'completion',
                   '2026-10-05T02:00:00Z', 'open', 'rectification'),
        pg_temp.li('i-closed', 'issue', 'customer', 'us', 'The customer reported a loose panel, since fixed.', 'defect:panel', 'completion',
                   '2026-10-09T08:00:00Z', 'closed', 'rectification', NULL, '2026-10-10T01:00:00Z'))), NULL, asof, NULL);
 IF position('Install under way since Fri 9 Oct; attendance not recorded for Fri 9 Oct' IN s->'now'->>'line') <> 1
    OR (s->'now'->>'installed_per_messages')::boolean THEN
  RAISE EXCEPTION 'story settled notes contract: without an open completion-stage note opened since the booked day the words stand: %', s->'now'->>'line';
 END IF;
 -- an empty ledger still answers, with empty lists
 s := public.context_job_story_assemble(job, '{}'::jsonb, NULL, NULL, asof, NULL);
 IF s->'settled' IS DISTINCT FROM '[]'::jsonb OR s->'disputed' IS DISTINCT FROM '[]'::jsonb THEN
  RAISE EXCEPTION 'story settled notes contract: no ledger, empty lists: %', s;
 END IF;
END $story$;

-- Access, volatility and comment: the assembler stays pure (STABLE, no SET), the story read stays a
-- STABLE SECURITY DEFINER with its search_path; both service role only, comments keep their slices
DO $access$
DECLARE x record; p record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
   ('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)', false,
    'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000): (lead cutoff, 20261007010000) (scoping pipeline, 20261009133000) (story lead rank, 20261011100000) (story settled notes, 20261011120000) %'),
   ('public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)', true,
    'Job story (20261006014000), lead cutoff (20261007010000): (story settled notes, 20261011120000) %')) v(sig, definer, cmt) LOOP
  SELECT pr.prosecdef, pr.provolatile, pr.proconfig INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(x.sig);
  IF p.prosecdef IS DISTINCT FROM x.definer OR p.provolatile <> 's'
     OR (x.definer AND p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']) OR (NOT x.definer AND p.proconfig IS NOT NULL)
     OR has_function_privilege('anon', x.sig, 'EXECUTE') OR has_function_privilege('authenticated', x.sig, 'EXECUTE')
     OR NOT has_function_privilege('service_role', x.sig, 'EXECUTE')
     OR coalesce(obj_description(to_regprocedure(x.sig), 'pg_proc'), '') NOT LIKE x.cmt THEN
   RAISE EXCEPTION 'story settled notes contract: % flags, access or comment wrong', x.sig;
  END IF;
 END LOOP;
END $access$;
ROLLBACK;

-- The story read passes call_transcripts: a call log whose transcript is on the job by as_of counts;
-- one whose transcript landed later, one with none, and a transcript placed on another job do not.
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, ghl_contact_id, pricing_json, created_at, updated_at)
VALUES ('71000000-0000-4000-8000-000000261469', '00000000-0000-4000-8000-0000000000aa', 'SWF-981469', 'in_progress', 'fencing', 'Story SN', 'ct81469', '{}',
        '2026-09-22 00:00Z', '2026-09-22 00:00Z'),
       ('71000000-0000-4000-8000-000000261470', '00000000-0000-4000-8000-0000000000aa', 'SWF-981470', 'in_progress', 'fencing', 'Story SN Two', 'ct81470', '{}',
        '2026-09-22 00:00Z', '2026-09-22 00:00Z');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, provider_message_id, payload, metadata,
  occurred_at, recorded_at, event_at, context_captured_at, attribution_status, attribution_confidence)
VALUES
 -- a call and its transcript, landed before as_of
 ('71b00000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000261469', 'client.call_logged', 'ghl', 'call', 'outbound', 'ct81469', 'ghl:call-a',
  '{"body":"Provider status: completed. Duration: 206 seconds."}', '{}', '2026-10-09 08:30Z', '2026-10-09 08:30Z', '2026-10-09 08:30Z', '2026-10-09 08:31Z', 'direct', 1),
 ('71b00000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000261469', 'call.transcript_completed', 'ghl-call-transcript', 'call', 'outbound', 'ct81469',
  'ghltx:call-a', '{"ghl_call_id":"call-a","transcript":"words"}', '{}', '2026-10-09 08:30Z', '2026-10-09 08:40Z', '2026-10-09 08:30Z', '2026-10-09 08:40Z', 'direct', 1),
 -- a call whose transcript lands after as_of
 ('71b00000-0000-4000-8000-000000000003', '71000000-0000-4000-8000-000000261469', 'client.call_logged', 'ghl', 'call', 'outbound', 'ct81469', 'ghl:call-b',
  '{"body":"Provider status: completed."}', '{}', '2026-10-10 23:00Z', '2026-10-10 23:00Z', '2026-10-10 23:00Z', '2026-10-10 23:01Z', 'direct', 1),
 ('71b00000-0000-4000-8000-000000000004', '71000000-0000-4000-8000-000000261469', 'call.transcript_completed', 'ghl-call-transcript', 'call', 'outbound', 'ct81469',
  'ghltx:call-b', '{"ghl_call_id":"call-b","transcript":"later words"}', '{}', '2026-10-10 23:00Z', '2026-10-11 05:00Z', '2026-10-10 23:00Z', '2026-10-11 05:00Z', 'direct', 1),
 -- a no-answer call, no transcript
 ('71b00000-0000-4000-8000-000000000005', '71000000-0000-4000-8000-000000261469', 'client.call_logged', 'ghl', 'call', 'outbound', 'ct81469', 'ghl:call-c',
  '{"body":"Provider status: no-answer."}', '{}', '2026-10-11 01:11Z', '2026-10-11 01:11Z', '2026-10-11 01:11Z', '2026-10-11 01:12Z', 'direct', 1),
 -- a call whose transcript sits on another job
 ('71b00000-0000-4000-8000-000000000006', '71000000-0000-4000-8000-000000261469', 'client.call_logged', 'ghl', 'call', 'inbound', 'ct81469', 'ghl:call-d',
  '{"body":"Provider status: completed."}', '{}', '2026-10-10 02:00Z', '2026-10-10 02:00Z', '2026-10-10 02:00Z', '2026-10-10 02:01Z', 'direct', 1),
 ('71b00000-0000-4000-8000-000000000007', '71000000-0000-4000-8000-000000261470', 'call.transcript_completed', 'ghl-call-transcript', 'call', 'inbound', 'ct81470',
  'ghltx:call-d', '{"ghl_call_id":"call-d","transcript":"other words"}', '{}', '2026-10-10 02:00Z', '2026-10-10 02:10Z', '2026-10-10 02:00Z', '2026-10-10 02:10Z', 'direct', 1);
DO $read$
DECLARE s jsonb;
BEGIN
 s := public.context_job_story('71000000-0000-4000-8000-000000261469', '2026-10-11T04:00:00Z');
 IF (s->'meta'->>'calls_with_transcript')::int IS DISTINCT FROM 1 THEN
  RAISE EXCEPTION 'story settled notes contract: the story read passes only the call whose transcript is on the job by as_of: %', s->'meta';
 END IF;
 s := public.context_job_story('71000000-0000-4000-8000-000000261469', '2026-10-11T06:00:00Z');
 IF (s->'meta'->>'calls_with_transcript')::int IS DISTINCT FROM 2 THEN
  RAISE EXCEPTION 'story settled notes contract: a transcript that has landed by as_of counts: %', s->'meta';
 END IF;
END $read$;
ROLLBACK;

-- Re-applying the migration changes nothing (its guard accepts its own bodies).
BEGIN;
-- (card events, 20261021150000, replaced the record messages, the story meta and the assembler since:
-- its down goes first, inside this transaction only)
SELECT to_regprocedure('public.context_job_card_events(uuid[])') IS NOT NULL AS card_events_live \gset
\if :card_events_live
\ir ../../../rollbacks/20261021150000_context_job_card_events_down.sql
\endif
-- (held messages, 20261012100000, replaced the story read and the packet since: its down goes first,
-- so the bodies snapshotted and re-applied below are this migration's own)
SELECT to_regprocedure('public.context_ledger_held_rows(uuid[],timestamptz)') IS NOT NULL AS held_messages_live \gset
\if :held_messages_live
-- The later story-card read changes are reversed only inside this contract's transaction.
SELECT to_regprocedure('public.context_job_story_payment_terms(jsonb)') IS NOT NULL AS story_card_causes_live \gset
\if :story_card_causes_live
-- (held notes, 20261015100000) replaced the judge, the item check, the story's ledger read, the packet and
-- the story since: its down goes first, inside this transaction only.
SELECT to_regprocedure('public.context_ledger_held_cite(uuid,jsonb)') IS NOT NULL AS held_notes_live \gset
\if :held_notes_live
\ir ../../../rollbacks/20261015100000_context_held_notes_down.sql
\endif
\ir ../../../rollbacks/20261014120000_context_story_card_causes_down.sql
\endif
\ir ../../../rollbacks/20261012100000_context_held_messages_down.sql
\endif
CREATE TEMP TABLE story_settled_md5 AS
 SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c FROM pg_proc p
 WHERE p.oid IN (to_regprocedure('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)'),
                 to_regprocedure('public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)'));
\ir ../../../migrations/20261011120000_context_story_settled_notes.sql
DO $again$
BEGIN
 IF EXISTS (SELECT 1 FROM story_settled_md5 t JOIN pg_proc p ON p.oid = to_regprocedure(t.sig)
            WHERE md5(p.prosrc) IS DISTINCT FROM t.m OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM t.c)
    OR (SELECT count(*) FROM story_settled_md5) <> 2 THEN
  RAISE EXCEPTION 'story settled notes contract: re-applying changed a body or comment';
 END IF;
END $again$;
ROLLBACK;
