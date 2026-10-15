-- Held notes (15 Oct 2026): a message held on no job may open a note on each job it could belong to,
-- marked job not certain. Behind feature_flags.context_held_notes_v1, created off.
--
-- Why. Decision D10 (14 Oct 2026), the owner: "we need a reliable way to fix that ... the cio needs to
-- fix that thing once and for all and the context system". A customer with several jobs sends a
-- message the placement ladder cannot pin to one job; it is held on no job (job_id null, attribution
-- unplaced or pending_luna) with the jobs it could belong to in candidate_job_ids. Since
-- 20261012100000 the reader sees such a message on every candidate job, but the citation check
-- refuses it (citation_off_job), so nothing it promises can ever become a note. On the six-job check
-- (SWF-261423, SWP-261267, SWP-261180, SWF-261463, SWP-261542, SWP-26634) 4 of the 5 owed items still
-- missing from the job page are promises that exist only in held calls and texts. The interim fix the
-- owner chose: such a message may open a note on each job it could belong to, marked "job not
-- certain". A note on one job too many is the cheaper error.
--
-- What it does (switch on):
--  1. context_ledger_held_cite(job, cite) (new): a business_events row on no job, held with this job
--     among its candidates and admitted as the packet's held rows are (context_ledger_held_rows), is
--     checked as the citation check checks a message (excerpt verbatim, long enough) and answered
--     with the same facts plus held true. Refused held_copy_placed when a copy of the same message is
--     placed on a job (the placed copy wins: cite it) or, for a call transcript, its call is placed
--     on another job. Anything else answers held_not_candidate, and the caller keeps the citation
--     check's own refusal.
--  2. context_ledger_check_item: an opening citation refused as off the job is tried as a held
--     message; one that passes marks the item job not certain. Such an item must be open (owed):
--     held_not_open otherwise; a held message never closes anything (closing citations and
--     transitions still use the unchanged citation check). An item a held message opens first is
--     keyed by that message alone, so the same held message opens at most one item of a type and
--     matter on one job (a second is refused duplicate_item by the unchanged write).
--  3. context_ledger_items.job_not_certain (new column, default false): stamped by a trigger on
--     insert and on a change of opened_by, while the switch is on, when an opening citation is a
--     business_events row on no job. The unchanged write and carry-forward need no change.
--  4. Readers: the packet's open_items, the story's ledger read (the job Overview's notes) and the
--     job story card mark an item job not certain (job_certain false, certainty job_not_certain)
--     only while one of its opening messages is still held for the job (context_ledger_held_citable),
--     and the story ledger read starts its words "Job not certain: ". The packet's held section says
--     which held rows may be cited (citable), only while the switch is on.
--  5. Later placement. When the held message is placed on this job, the note reads as certain (its
--     citation is now this job's own). When it is placed on another job, the note's citation is no
--     longer ok on this job: the story hides it at once and the judge raises citation_moved, so the
--     next read rebuilds the job without it. The not-certain note is DROPPED on the other jobs, never
--     closed: a close would claim the thing was done.
--
-- What it does not do. Held messages are still never evidence rows: they never make a job due,
-- never count as unread, never move evidence_until. Placement, the ladder, the evidence rows, the
-- citation check itself, the write, finish, carry-forward and the scorecard are not changed. Off
-- (missing, unreadable or false): every replaced function answers byte for byte as before, the
-- trigger stamps nothing, and no item cites a held message.
--
-- Replaced bodies (each guarded on its live production md5, read 15 Oct 2026): context_ledger_check_item,
--   context_ledger_judge, context_job_story_ledger, context_ledger_packet, context_job_story.
-- Added: context_held_notes_on, context_ledger_held_placed_copy, context_ledger_held_citable,
--   context_ledger_held_cite, context_ledger_item_held_now, context_job_story_held_marks,
--   context_ledger_items_held_stamp (trigger function), trigger context_ledger_items_held_stamp,
--   column context_ledger_items.job_not_certain, feature flag context_held_notes_v1 (off).
-- Query shape: only for a not-certain item or a held citation: one read of the job's held rows
--   (index business_events_candidate_job_ids), a placed-copy read by the message's CRM contact or
--   sender address and time, and a transcript's call by its unique provider key.
-- Rollback: supabase/rollbacks/20261015100000_context_held_notes_down.sql (the five earlier bodies
--   and comments word for word; the helpers, trigger and column dropped; the flag row kept).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[] := '{}'; live text; x record; f text;
BEGIN
 -- The replaced bodies: the ones production runs, or this migration's (re-apply).
 FOR x IN SELECT * FROM (VALUES
  ('public.context_ledger_check_item(uuid,jsonb,text,uuid,text)', ARRAY['06e3e1cae99a50ec56308b74e7a1b03d', 'af976e59b8e6f35612d6383042d6e38e']),
  ('public.context_ledger_judge(uuid[])', ARRAY['92367db74677cd38612394056aac07fa', '2483ad58fdea93abcb1ca5f4d87658ee']),
  ('public.context_job_story_ledger(uuid,uuid,timestamptz)', ARRAY['b27d9f6c0abdd7174f38b0ed5e1ac5f0', '09d28c282caf22c873f5673d7dd8073f']),
  ('public.context_ledger_packet(uuid,timestamptz,timestamptz)', ARRAY['93ddf3979e8c0c3625c425a3934f4838', 'e2ccc5450117a4e36b30df104752d1cd']),
  ('public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)', ARRAY['9ba28fe55db39844b2a9b83dc448eaad', '240b50d71c6d1cd6c4266e275366bc0e'])
 ) AS v(sig, accepted) LOOP
  live := NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY(x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 -- Read, never replaced.
 FOREACH f IN ARRAY ARRAY['public.context_ledger_cite(uuid,jsonb)', 'public.context_ledger_held_rows(uuid[],timestamptz)',
  'public.context_ledger_text_norm(text)', 'public.context_event_text(public.business_events)',
  'public.context_event_is_ours(public.business_events)', 'public.context_internal_text_role(public.business_events)',
  'public.context_job_story_payment_terms(jsonb)', 'public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 IF to_regclass('public.context_ledger_items') IS NULL THEN problems := problems || 'public.context_ledger_items missing'::text; END IF;
 -- New functions: absent, or this migration's (comment marker).
 FOR x IN SELECT p.oid::regprocedure::text AS sig, coalesce(obj_description(p.oid, 'pg_proc'), '') AS c
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('context_held_notes_on', 'context_ledger_held_placed_copy', 'context_ledger_held_citable',
    'context_ledger_held_cite', 'context_ledger_item_held_now', 'context_job_story_held_marks', 'context_ledger_items_held_stamp') LOOP
  IF x.c NOT LIKE 'Held notes (20261015100000)%' THEN
   problems := problems || format('%s exists and is not this migration''s', x.sig);
  END IF;
 END LOOP;
 -- The switch is created off: never already on before the first apply.
 IF to_regclass('public.feature_flags') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_held_notes_on()'))
  AND EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_held_notes_v1' AND enabled IS TRUE) THEN
  problems := problems || 'feature flag context_held_notes_v1 is already on before the first apply'::text;
 END IF;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_held_notes_preimage_mismatch: %; read the live definitions before replacing them',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The switch: feature_flags.context_held_notes_v1, created off; missing or unreadable is off.
DO $flag$
BEGIN
 IF to_regclass('public.feature_flags') IS NOT NULL THEN
  INSERT INTO public.feature_flags (flag_name, enabled, description)
  SELECT 'context_held_notes_v1', false,
   'Held notes (20261015100000): while on, a message placed on no job, held because the customer has several jobs (or the match was not certain), may open or support an open AI note on each job it could belong to, marked "job not certain" on the packet, the job card and the job Overview. A held message never closes a note, never makes a job due and never moves evidence_until; once it is placed on one job its notes on the other jobs are dropped at the next read. Off: no note cites a held message and every read is as before. Owner''s word to turn on (CTX-03, 15 Oct 2026: after the six check jobs are proven).'
  WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_held_notes_v1');
 END IF;
END $flag$;

CREATE OR REPLACE FUNCTION public.context_held_notes_on()
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE v boolean;
BEGIN
 SELECT bool_and(f.enabled) INTO v FROM public.feature_flags f WHERE f.flag_name = 'context_held_notes_v1';
 RETURN coalesce(v, false);
EXCEPTION WHEN undefined_table OR undefined_column OR insufficient_privilege THEN
 RETURN false;
END $fn$;
COMMENT ON FUNCTION public.context_held_notes_on() IS
 'Held notes (20261015100000): whether a held message may open or support a not-certain AI note (feature_flags.context_held_notes_v1; a missing row or table, or more than one row not all on, reads as off). Service role only.';

-- 2. Where a copy of a held message is placed. A placed copy always wins over the held message.
CREATE OR REPLACE FUNCTION public.context_ledger_held_placed_copy(p_id uuid)
RETURNS TABLE(copy_id uuid, copy_job_id uuid, how text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE e public.business_events; v_at timestamptz; v_words text; v_from text; v_call text;
BEGIN
 SELECT * INTO e FROM public.business_events b WHERE b.id = p_id;
 IF e.id IS NULL THEN RETURN; END IF;
 -- a call transcript belongs with its call: the call row (ghl:<id>) placed on a job
 v_call := nullif(btrim(e.payload ->> 'ghl_call_id'), '');
 IF e.event_type = 'call.transcript_completed' AND v_call IS NOT NULL THEN
  RETURN QUERY SELECT x.id, x.job_id, 'call'::text
   FROM public.business_events x JOIN public.jobs j ON j.id = x.job_id
   WHERE x.provider_message_id = 'ghl:' || v_call AND x.id <> e.id
     AND coalesce(j.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1')
   LIMIT 1;
  IF FOUND THEN RETURN; END IF;
 END IF;
 -- the same message stored twice: a marked copy either way (metadata.duplicate_of), or the same
 -- channel, direction and words from the same CRM contact (else sender address) within 120 seconds
 -- (the evidence rows' copy rule); placed on a job that is not a holding job
 v_at := coalesce(e.event_at, e.occurred_at);
 v_words := md5(lower(public.context_ledger_text_norm(public.context_event_text(e))));
 v_from := lower(btrim(coalesce(substring(e.payload ->> 'from' FROM '<([^<>]*)>'), e.payload ->> 'from')));
 IF e.contact_id IS NOT NULL THEN
  RETURN QUERY SELECT x.id, x.job_id, 'copy'::text
  FROM public.business_events x JOIN public.jobs j ON j.id = x.job_id
  WHERE x.contact_id = e.contact_id
    AND x.id <> e.id AND x.job_id IS NOT NULL
    AND coalesce(j.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1')
    AND (x.metadata ->> 'duplicate_of' = e.id::text OR e.metadata ->> 'duplicate_of' = x.id::text
         OR (x.channel IS NOT DISTINCT FROM e.channel AND x.direction IS NOT DISTINCT FROM e.direction
             AND coalesce(x.event_at, x.occurred_at) BETWEEN v_at - interval '120 seconds' AND v_at + interval '120 seconds'
             AND md5(lower(public.context_ledger_text_norm(public.context_event_text(x)))) = v_words))
  ORDER BY x.id
  LIMIT 1;
 ELSIF v_from IS NOT NULL THEN
  RETURN QUERY SELECT x.id, x.job_id, 'copy'::text
  FROM public.business_events x JOIN public.jobs j ON j.id = x.job_id
  WHERE lower(btrim(coalesce(substring(x.payload ->> 'from' FROM '<([^<>]*)>'), x.payload ->> 'from'))) = v_from
    AND x.id <> e.id AND x.job_id IS NOT NULL
    AND coalesce(j.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1')
    AND (x.metadata ->> 'duplicate_of' = e.id::text OR e.metadata ->> 'duplicate_of' = x.id::text
         OR (x.channel IS NOT DISTINCT FROM e.channel AND x.direction IS NOT DISTINCT FROM e.direction
             AND coalesce(x.event_at, x.occurred_at) BETWEEN v_at - interval '120 seconds' AND v_at + interval '120 seconds'
             AND md5(lower(public.context_ledger_text_norm(public.context_event_text(x)))) = v_words))
  ORDER BY x.id
  LIMIT 1;
 END IF;
END $fn$;
COMMENT ON FUNCTION public.context_ledger_held_placed_copy(uuid) IS
 'Held notes (20261015100000): where a copy of a held message is placed, if anywhere: for a call transcript, its call row (ghl:<payload.ghl_call_id>) on a job (how call); otherwise a row on a job that is a marked copy of it or it of that row (metadata.duplicate_of), or the same channel, direction and words (normalised) from the same CRM contact (else the same sender address) within 120 seconds, the evidence rows'' copy rule (how copy). Never a holding job (metadata.do_not_schedule). At most one row {copy_id, copy_job_id, how}. A placed copy always wins: the held message is then not cited (its call on this job is not a copy). Read by context_ledger_held_cite, context_ledger_held_citable and the packet. Service role only.';

-- 3. Whether a held message may stand behind a not-certain note on a job, as of an instant.
CREATE OR REPLACE FUNCTION public.context_ledger_held_citable(p_job_id uuid, p_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 SELECT public.context_held_notes_on()
  AND EXISTS (SELECT 1 FROM public.context_ledger_held_rows(ARRAY[p_job_id], coalesce(p_as_of, now())) h WHERE h.src_id = p_id)
  AND NOT EXISTS (SELECT 1 FROM public.context_ledger_held_placed_copy(p_id) pc WHERE pc.how = 'copy' OR pc.copy_job_id <> p_job_id)
$fn$;
COMMENT ON FUNCTION public.context_ledger_held_citable(uuid, uuid, timestamptz) IS
 'Held notes (20261015100000): true while the switch is on (context_held_notes_on), the message is one of the job''s held rows as of p_as_of (context_ledger_held_rows: on no job, unplaced or pending_luna, the job among its candidates, admitted as the held rows are) and no copy of it is placed on a job, nor, for a call transcript, its call on another job (context_ledger_held_placed_copy). Read by the judge, the story''s ledger read, the packet and the story''s marks. Service role only.';

-- 4. The citation check for a held message (an opening citation only).
CREATE OR REPLACE FUNCTION public.context_ledger_held_cite(p_job_id uuid, p_cite jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE v_id uuid; v_excerpt text; v_norm text; e public.business_events; h record; pc record; v_text text;
 v_customer boolean; v_internal boolean; v_call_note boolean; v_num text;
BEGIN
 IF NOT public.context_held_notes_on() OR p_cite IS NULL OR jsonb_typeof(p_cite) <> 'object'
  OR p_cite ->> 'table' IS DISTINCT FROM 'business_events'
  OR coalesce(p_cite ->> 'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RETURN jsonb_build_object('ok', false, 'code', 'held_not_candidate', 'detail', 'not a held message');
 END IF;
 v_id := (p_cite ->> 'id')::uuid;
 SELECT * INTO e FROM public.business_events b WHERE b.id = v_id;
 IF e.id IS NULL OR e.job_id IS NOT NULL THEN
  RETURN jsonb_build_object('ok', false, 'code', 'held_not_candidate', 'detail', 'not a held message');
 END IF;
 SELECT * INTO h FROM public.context_ledger_held_rows(ARRAY[p_job_id], now()) r WHERE r.src_id = v_id;
 IF h.src_id IS NULL THEN
  RETURN jsonb_build_object('ok', false, 'code', 'held_not_candidate', 'detail', 'not held with this job among its candidates');
 END IF;
 -- a placed copy always wins
 SELECT * INTO pc FROM public.context_ledger_held_placed_copy(v_id);
 IF pc.copy_id IS NOT NULL AND (pc.how = 'copy' OR pc.copy_job_id <> p_job_id) THEN
  SELECT j.job_number INTO v_num FROM public.jobs j WHERE j.id = pc.copy_job_id;
  RETURN jsonb_build_object('ok', false, 'code', 'held_copy_placed', 'detail', 'business_events:' || v_id || ' '
   || CASE WHEN pc.how = 'call' THEN 'is the transcript of a call placed on ' || coalesce(v_num, 'another job')
           WHEN pc.copy_job_id = p_job_id THEN 'has a copy on this job: cite business_events:' || pc.copy_id
           ELSE 'has a copy placed on ' || coalesce(v_num, 'another job') END);
 END IF;
 v_excerpt := p_cite ->> 'excerpt';
 v_norm := public.context_ledger_text_norm(v_excerpt);
 v_text := concat_ws(' ', h.subject, h.body);
 IF length(v_norm) > 400 THEN RETURN jsonb_build_object('ok', false, 'code', 'excerpt_too_long', 'detail', 'business_events:' || v_id); END IF;
 IF v_norm = '' THEN RETURN jsonb_build_object('ok', false, 'code', 'excerpt_required', 'detail', 'business_events:' || v_id); END IF;
 IF position(v_norm IN public.context_ledger_text_norm(v_text)) = 0 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'excerpt_not_verbatim', 'detail', 'business_events:' || v_id);
 END IF;
 IF length(v_norm) < 12 AND coalesce(array_length(regexp_split_to_array(v_norm, '\s+'), 1), 0) < 3
  AND v_norm IS DISTINCT FROM public.context_ledger_text_norm(v_text)
  AND v_norm IS DISTINCT FROM public.context_ledger_text_norm(h.body)
  AND v_norm IS DISTINCT FROM public.context_ledger_text_norm(h.subject) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'excerpt_too_short', 'detail', 'business_events:' || v_id);
 END IF;
 -- this job's customer's words: the row is this job's customer's (same_contact: its CRM contact the
 -- job's, or its sender the job's client email), and an inbound message not ours or automated, or a
 -- call transcript (the customer was the other party on the call)
 v_customer := coalesce(h.same_contact, false)
  AND (h.kind = 'call.transcript_completed' OR (h.direction = 'inbound' AND NOT coalesce(h.ours, false) AND NOT coalesce(h.automated, false)));
 v_call_note := e.channel IN ('call', 'note') OR e.event_type IN ('call.transcript_completed', 'client.call_logged', 'note.added', 'ghl.internal_comment');
 v_internal := e.channel IN ('sms', 'email') AND (public.context_internal_text_role(e) <> 'other'
  OR coalesce(e.metadata #>> '{party_roles,audience}', e.metadata ->> 'audience') = 'internal');
 RETURN jsonb_build_object('ok', true, 'cite', jsonb_build_object('table', 'business_events', 'id', v_id::text, 'excerpt', v_excerpt),
  'at', h.at, 'close_at', h.at, 'made_at', NULL, 'paid_at', NULL, 'kind', NULL, 'customer_sender', v_customer,
  'ours', coalesce(h.ours, false), 'call_or_note', v_call_note, 'internal_text', v_internal, 'record', false, 'worded', true,
  'automated', coalesce(h.automated, false),
  'held', true, 'certainty', 'job_not_certain', 'other_jobs', to_jsonb(h.other_jobs));
END $fn$;
COMMENT ON FUNCTION public.context_ledger_held_cite(uuid, jsonb) IS
 'Held notes (20261015100000): checks one {table, id, excerpt} opening citation of a message held on no job for a job. While the switch is on, a business_events row on no job that is one of the job''s held rows now (context_ledger_held_rows: unplaced or pending_luna, the job among its candidates, admitted as the held rows are) is checked as the citation check checks a message (an excerpt is required, at most 400 characters, verbatim in its subject and text, at least 12 characters or 3 words unless the whole row, subject or body) and answered with the citation check''s facts (at and close_at its time, customer_sender when it is this job''s customer''s inbound words or a call transcript with this job''s customer, ours, call_or_note, internal_text, automated, record false, worded true) plus held true, certainty job_not_certain and other_jobs. Refused held_copy_placed when a copy of it is placed on a job (on this job: cite that copy) or, for a transcript, its call is placed on another job (context_ledger_held_placed_copy). Anything else, and everything while the switch is off: held_not_candidate, and the caller keeps the citation check''s own refusal. Read by context_ledger_check_item for opening citations only. Service role only.';

-- 5. Whether an item's opening citations still include a message held for the job.
CREATE OR REPLACE FUNCTION public.context_ledger_item_held_now(p_job_id uuid, p_opened_by jsonb, p_as_of timestamptz DEFAULT now())
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 SELECT public.context_held_notes_on()
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_opened_by) = 'array' THEN p_opened_by ELSE '[]'::jsonb END) c
              JOIN public.business_events b ON c ->> 'table' = 'business_events'
               AND b.id = CASE WHEN c ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (c ->> 'id')::uuid END
              WHERE b.job_id IS NULL AND public.context_ledger_held_citable(p_job_id, b.id, p_as_of))
$fn$;
COMMENT ON FUNCTION public.context_ledger_item_held_now(uuid, jsonb, timestamptz) IS
 'Held notes (20261015100000): true while the switch is on and one of an item''s opening citations is a business_events row still on no job that may stand behind a not-certain note on the job as of p_as_of (context_ledger_held_citable). False once that message is placed (on this job the note reads as certain; on another, its citation is not ok and the note is dropped at the next read). Read by the packet and the story''s marks. Service role only.';

-- 6. The stored marker: context_ledger_items.job_not_certain, stamped by a trigger.
ALTER TABLE public.context_ledger_items ADD COLUMN IF NOT EXISTS job_not_certain boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.context_ledger_items.job_not_certain IS
 'Held notes (20261015100000): true when, as the item was written, one of its opening citations was a message placed on no job (held because the job was not certain) and the switch was on. Stamped only by trigger context_ledger_items_held_stamp. Readers show the item as job not certain only while that message is still held for the job (context_ledger_item_held_now).';

CREATE OR REPLACE FUNCTION public.context_ledger_items_held_stamp()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
BEGIN
 NEW.job_not_certain := public.context_held_notes_on()
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.opened_by) = 'array' THEN NEW.opened_by ELSE '[]'::jsonb END) c
              JOIN public.business_events b ON c ->> 'table' = 'business_events'
               AND b.id = CASE WHEN c ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (c ->> 'id')::uuid END
              WHERE b.job_id IS NULL);
 RETURN NEW;
END $fn$;
COMMENT ON FUNCTION public.context_ledger_items_held_stamp() IS
 'Held notes (20261015100000): the trigger function that stamps context_ledger_items.job_not_certain on insert and on a change of opened_by: true while the switch is on and an opening citation is a business_events row on no job (only a held message passes the item check so), else false. Service role only.';
DROP TRIGGER IF EXISTS context_ledger_items_held_stamp ON public.context_ledger_items;
CREATE TRIGGER context_ledger_items_held_stamp BEFORE INSERT OR UPDATE OF opened_by ON public.context_ledger_items
 FOR EACH ROW EXECUTE FUNCTION public.context_ledger_items_held_stamp();

-- 7. The story's marks: a not-certain item is marked wherever the card lists it.
CREATE OR REPLACE FUNCTION public.context_job_story_held_marks(p_story jsonb, p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE v_gen uuid; v_keys text[]; v_out jsonb; k text;
 v_mark constant jsonb := jsonb_build_object('job_certain', false, 'certainty', 'job_not_certain');
BEGIN
 IF p_story IS NULL OR jsonb_typeof(p_story) <> 'object' OR NOT public.context_held_notes_on() THEN RETURN p_story; END IF;
 v_gen := CASE WHEN p_story #>> '{meta,ledger,generation_id}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               THEN (p_story #>> '{meta,ledger,generation_id}')::uuid END;
 IF v_gen IS NULL THEN RETURN p_story; END IF;
 SELECT array_agg(i.item_key ORDER BY i.item_key COLLATE "C") INTO v_keys
 FROM public.context_ledger_items i
 WHERE i.generation_id = v_gen AND i.job_id = p_job_id AND i.job_not_certain AND i.created_at <= p_as_of
   AND public.context_ledger_item_held_now(p_job_id, i.opened_by, p_as_of);
 IF v_keys IS NULL THEN RETURN p_story; END IF;
 v_out := p_story;
 FOREACH k IN ARRAY ARRAY['loops', 'agreements', 'events', 'settled', 'disputed'] LOOP
  IF jsonb_typeof(v_out -> k) = 'array' THEN
   v_out := jsonb_set(v_out, ARRAY[k], (SELECT coalesce(jsonb_agg(CASE WHEN a.x ->> 'key' = ANY(v_keys) THEN a.x || v_mark ELSE a.x END ORDER BY a.o), '[]'::jsonb)
                                        FROM jsonb_array_elements(v_out -> k) WITH ORDINALITY a(x, o)));
  END IF;
 END LOOP;
 IF jsonb_typeof(v_out #> '{meta,ledger}') = 'object' THEN
  v_out := jsonb_set(v_out, '{meta,ledger}', (v_out #> '{meta,ledger}') || jsonb_build_object('job_not_certain_items', cardinality(v_keys)));
 END IF;
 RETURN v_out;
END $fn$;
COMMENT ON FUNCTION public.context_job_story_held_marks(jsonb, uuid, timestamptz) IS
 'Held notes (20261015100000): the story with every loops, agreements, events, settled and disputed entry whose key is an item of the shown generation (meta.ledger.generation_id) that a held message still holds up (context_ledger_items.job_not_certain and context_ledger_item_held_now as of p_as_of) given job_certain false and certainty job_not_certain, and meta.ledger.job_not_certain_items their count. With the switch off, no generation shown or no such item, the story unchanged. Read by context_job_story. Service role only.';

-- 8. context_ledger_check_item
CREATE OR REPLACE FUNCTION public.context_ledger_check_item(p_job_id uuid, p_item jsonb, p_writer text, p_person uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_type text; v_status text; v_from text; v_to text; v_what text; v_about text; v_due date; v_basis text;
 v_open jsonb := '[]'; v_close jsonb := '[]'; c jsonb; chk jsonb; n integer := 0; v_opened_at timestamptz; v_closed_at timestamptz;
 v_any_customer boolean := false; v_any_us boolean := false; v_any_external boolean := false; v_due_ok boolean := false;
 v_first_customer boolean; v_first_us boolean; v_close_at timestamptz;
 v_key text; v_first text; v_facts jsonb := '[]'; f jsonb; v_supported date;
 v_cfacts jsonb := '[]'; v_reason text; v_someone integer := 0;
 v_hchk jsonb; v_held boolean := false; v_held_first boolean := false;
 roles constant text[] := ARRAY['us','crew','customer','supplier','insurer_builder','third_party','unknown'];
BEGIN
 IF p_item IS NULL OR jsonb_typeof(p_item) <> 'object' THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'an item is a JSON object');
 END IF;
 IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_item) k WHERE k NOT IN ('ref','item_type','status','from_role','from_name','to_role',
   'to_name','what','about_key','modality','phase','due_date','due_basis','opened_by','closed_by','closes_on','supersedes_key',
   'supersedes_ref','blocks','needs_reply','also_concerns')) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'unknown field '
   || (SELECT min(k COLLATE "C") FROM jsonb_object_keys(p_item) k WHERE k NOT IN ('ref','item_type','status','from_role','from_name','to_role',
   'to_name','what','about_key','modality','phase','due_date','due_basis','opened_by','closed_by','closes_on','supersedes_key',
   'supersedes_ref','blocks','needs_reply','also_concerns')));
 END IF;
 IF EXISTS (SELECT 1 FROM jsonb_each(p_item) kv WHERE kv.key NOT IN ('opened_by','closed_by','needs_reply')
   AND jsonb_typeof(kv.value) NOT IN ('string','null')) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'text fields must be strings or null');
 END IF;
 v_type := p_item ->> 'item_type'; v_status := p_item ->> 'status'; v_from := p_item ->> 'from_role';
 v_to := nullif(p_item ->> 'to_role', '');
 -- the ledger's own words carry no em or en dashes (they reach outbound text)
 v_what := btrim(replace(regexp_replace(coalesce(p_item ->> 'what', ''), '\s*' || chr(8212) || '\s*', ', ', 'g'), chr(8211), '-'));
 v_about := nullif(btrim(p_item ->> 'about_key'), ''); v_basis := coalesce(nullif(p_item ->> 'due_basis', ''), 'none');
 IF p_writer = 'model' AND coalesce(length(btrim(p_item ->> 'ref')), 0) NOT BETWEEN 1 AND 60 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'ref is 1 to 60 characters');
 END IF;
 IF v_type IS NULL OR v_type NOT IN ('commitment','request','claim','issue','constraint','dependency','agreement','event','phase_note') THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'item_type');
 END IF;
 IF v_status IS NULL OR v_status NOT IN ('open','closed','declined','superseded','info')
  OR (v_type IN ('event','phase_note') AND v_status <> 'info')
  OR (v_type NOT IN ('event','phase_note','agreement') AND v_status = 'info')
  OR (p_writer = 'person' AND v_status NOT IN ('open','info')) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'status ' || coalesce(v_status, 'null') || ' for ' || v_type);
 END IF;
 IF v_from IS NULL OR NOT v_from = ANY(roles) OR (v_to IS NOT NULL AND NOT v_to = ANY(roles)) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'from_role or to_role');
 END IF;
 IF length(v_what) NOT BETWEEN 1 AND 600 OR length(coalesce(p_item ->> 'from_name', '')) > 120
  OR length(coalesce(p_item ->> 'to_name', '')) > 120 OR length(coalesce(p_item ->> 'also_concerns', '')) > 200 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'what 1 to 600, names up to 120, also_concerns up to 200');
 END IF;
 IF v_about IS NOT NULL AND v_about !~ '^(invoice|quote|booking|payment|variation|materials|scope|access|preference|defect|approval|contact|other):[a-z0-9]+(-[a-z0-9]+){0,4}$' THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'about_key ' || left(v_about, 60));
 END IF;
 IF v_about LIKE 'booking:%' AND v_about !~ '^booking:[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'booking about_key is booking:yyyy-mm-dd');
 END IF;
 IF (p_item ->> 'modality') IS NOT NULL AND (p_item ->> 'modality') NOT IN ('requested','offered','agreed','declined','reported','confirmed')
  OR (v_type = 'agreement' AND (p_item ->> 'modality') IS NULL) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'modality');
 END IF;
 IF (p_item ->> 'phase') IS NOT NULL AND (p_item ->> 'phase') NOT IN ('enquiry','scope','quote','accepted','deposit','approvals','materials',
   'scheduled','install','complete','invoice','payment','rectification','makesafe','other')
  OR (v_type = 'phase_note' AND (p_item ->> 'phase') IS NULL) THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'phase');
 END IF;
 IF (p_item ->> 'closes_on') IS NOT NULL AND (p_item ->> 'closes_on') NOT IN ('reply','call','quote_sent','invoice_issued','payment',
   'booking_made','visit','work_done','record','person','none')
  OR (p_item ->> 'blocks') IS NOT NULL AND (p_item ->> 'blocks') NOT IN ('quote','acceptance','deposit','booking','install','completion','payment','none')
  OR coalesce(jsonb_typeof(p_item -> 'needs_reply'), 'null') NOT IN ('boolean','null')
  OR v_basis NOT IN ('stated','none')
  OR length(coalesce(p_item ->> 'supersedes_key', '')) > 200 OR length(coalesce(p_item ->> 'supersedes_ref', '')) > 60 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'closes_on, blocks, needs_reply, due_basis or supersedes');
 END IF;
 IF (p_item ->> 'due_date') IS NOT NULL THEN
  IF (p_item ->> 'due_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
   RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'due_date is yyyy-mm-dd');
  END IF;
  BEGIN v_due := (p_item ->> 'due_date')::date;
  EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'due_date is not a date'); END;
 END IF;
 IF v_basis = 'stated' AND v_due IS NULL THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'due_basis stated needs a due_date');
 END IF;
 IF coalesce(jsonb_typeof(p_item -> 'opened_by'), 'null') NOT IN ('array','null')
  OR coalesce(jsonb_typeof(p_item -> 'closed_by'), 'null') NOT IN ('array','null')
  OR jsonb_array_length(coalesce(nullif(p_item -> 'opened_by', 'null'::jsonb), '[]')) > 25
  OR jsonb_array_length(coalesce(nullif(p_item -> 'closed_by', 'null'::jsonb), '[]')) > 25 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'opened_by and closed_by are arrays of at most 25');
 END IF;
 IF p_writer = 'model' AND jsonb_array_length(coalesce(nullif(p_item -> 'opened_by', 'null'::jsonb), '[]')) = 0 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'invalid_shape', 'detail', 'opened_by needs at least one citation');
 END IF;
 -- Opening citations.
 FOR c IN SELECT x FROM jsonb_array_elements(coalesce(nullif(p_item -> 'opened_by', 'null'::jsonb), '[]')) x LOOP
  n := n + 1;
  chk := public.context_ledger_cite(p_job_id, c);
  -- (held notes, 20261015100000) a message placed on no job, held with this job among its
  -- candidates, may open or support an item here while the switch is on
  -- (context_ledger_held_cite); the item is then marked job not certain. Off, or not such a
  -- message: the citation check's own refusal stands, as before.
  IF NOT (chk ->> 'ok')::boolean AND chk ->> 'code' = 'citation_off_job' AND c ->> 'table' = 'business_events' THEN
   v_hchk := public.context_ledger_held_cite(p_job_id, c);
   IF coalesce(v_hchk ->> 'code', '') <> 'held_not_candidate' THEN chk := v_hchk; END IF;
  END IF;
  IF NOT (chk ->> 'ok')::boolean THEN
   RETURN jsonb_build_object('ok', false, 'code', chk ->> 'code', 'detail', 'opened_by[' || n || '] ' || coalesce(chk ->> 'detail', ''));
  END IF;
  IF coalesce((chk ->> 'held')::boolean, false) THEN
   v_held := true;
   IF n = 1 THEN v_held_first := true; END IF;
  END IF;
  v_open := v_open || jsonb_build_array(chk -> 'cite');
  v_facts := v_facts || jsonb_build_array(chk);
  v_opened_at := least(v_opened_at, (chk ->> 'at')::timestamptz);
  IF n = 1 THEN  -- the speaker is whoever sent the first opening citation
   v_first_customer := (chk ->> 'customer_sender')::boolean;
   v_first_us := (chk ->> 'ours')::boolean OR (chk ->> 'call_or_note')::boolean OR (chk ->> 'record')::boolean;
  END IF;
  v_any_customer := v_any_customer OR (chk ->> 'customer_sender')::boolean;
  v_any_us := v_any_us OR (chk ->> 'ours')::boolean OR (chk ->> 'call_or_note')::boolean OR (chk ->> 'record')::boolean;
  v_any_external := v_any_external OR NOT (chk ->> 'internal_text')::boolean;
 END LOOP;
 -- A person's item with no citation cites the person and their note.
 IF jsonb_array_length(v_open) = 0 THEN
  v_open := jsonb_build_array(jsonb_build_object('table', 'person', 'id', p_person::text, 'excerpt', p_note));
  v_opened_at := now();
 END IF;
 n := 0;
 FOR c IN SELECT x FROM jsonb_array_elements(coalesce(nullif(p_item -> 'closed_by', 'null'::jsonb), '[]')) x LOOP
  n := n + 1;
  chk := public.context_ledger_cite(p_job_id, c);
  IF NOT (chk ->> 'ok')::boolean THEN
   RETURN jsonb_build_object('ok', false, 'code', chk ->> 'code', 'detail', 'closed_by[' || n || '] ' || coalesce(chk ->> 'detail', ''));
  END IF;
  -- Only an issued or sent record closes: no draft invoice, unsent document or
  -- unattended booking; never the opening row itself; a request strictly after it.
  v_close_at := CASE WHEN chk #>> '{cite,table}' = 'job_assignments' AND (p_item ->> 'closes_on') = 'booking_made'
                     THEN (chk ->> 'made_at')::timestamptz
                     WHEN chk #>> '{cite,table}' = 'xero_invoices' AND (p_item ->> 'closes_on') = 'payment'
                     -- (ledger reader fixes, 20261007150000) at the end of its paid Perth day, whatever
                     -- the invoice's date: a request made the day it was paid is closed by it
                     THEN public.context_ledger_paid_close_at((chk ->> 'paid_at')::timestamptz) ELSE (chk ->> 'close_at')::timestamptz END;
  IF chk #>> '{cite,table}' = 'job_events' AND NOT public.context_ledger_job_event_closes(chk ->> 'kind', p_item ->> 'closes_on') THEN
   v_close_at := NULL;
  END IF;
  IF chk #>> '{cite,table}' = 'email_events' AND NOT public.context_ledger_email_closes(chk ->> 'kind', p_item ->> 'closes_on') THEN
   v_close_at := NULL;
  END IF;
  IF v_close_at IS NULL THEN
   RETURN jsonb_build_object('ok', false, 'code', 'closing_not_issued', 'detail', 'closed_by[' || n || '] ' || (chk #>> '{cite,table}'));
  END IF;
  IF v_open @> jsonb_build_array(jsonb_build_object('table', chk #>> '{cite,table}', 'id', chk #>> '{cite,id}')) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'closing_is_opening', 'detail', 'closed_by[' || n || ']');
  END IF;
  IF v_close_at < v_opened_at OR (v_type = 'request' AND v_close_at <= v_opened_at) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'closing_before_opening', 'detail', 'closed_by[' || n || ']');
  END IF;
  v_close := v_close || jsonb_build_array(chk -> 'cite');
  v_cfacts := v_cfacts || jsonb_build_array(chk);
  v_closed_at := greatest(v_closed_at, v_close_at);
 END LOOP;
 IF v_status IN ('closed','declined') AND jsonb_array_length(v_close) = 0 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'closed_without_evidence', 'detail', v_status || ' needs closed_by');
 END IF;
 IF v_status IN ('open','info') AND jsonb_array_length(v_close) > 0 THEN
  RETURN jsonb_build_object('ok', false, 'code', 'closed_by_on_open', 'detail', v_status || ' cannot carry closed_by');
 END IF;
 -- (held notes, 20261015100000) a held message (job not certain) opens or supports only an
 -- open item: what is owed. It never closes one (the closing citations above refuse it).
 IF v_held AND v_status <> 'open' THEN
  RETURN jsonb_build_object('ok', false, 'code', 'held_not_open',
   'detail', 'a message held on no job (job not certain) may open or support only an open item');
 END IF;
 -- Who said it (the model only; a person's own item is their word).
 IF p_writer = 'model' THEN
  IF v_from = 'customer' AND NOT coalesce(v_first_customer, false) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'speaker_not_customer', 'detail', 'the first opening citation was not sent by this job''s customer');
  END IF;
  IF v_from = 'us' AND NOT coalesce(v_first_us, false) THEN
   RETURN jsonb_build_object('ok', false, 'code', 'speaker_not_us', 'detail', 'the first opening citation is not ours, a call, a note or a record');
  END IF;
  IF v_to = 'customer' AND NOT v_any_external THEN
   RETURN jsonb_build_object('ok', false, 'code', 'internal_to_customer', 'detail', 'every opening citation is a crew or staff internal text');
  END IF;
  -- (ledger reader fixes, 20261007150000) An item whose words say a row is someone else's (its
  -- sender, caller or counterpart another person than this job's customer, or a label saying so:
  -- context_ledger_elsewhere_claim) stands only when no cited row, opening or closing, is this job's
  -- customer's own words, every cited row that is not a record or our own text, email or note (a
  -- call transcript holds both sides' words, so it is never ours alone) is someone else's by its own
  -- stamp (context_ledger_row_elsewhere: role_basis or call_not_customer), and at least one is: never
  -- on the reader's word or an extra citation, so the customer's own call is never put on someone
  -- else; a placement reason (call_on_other_job, names_other_job) names no person. A claim that a
  -- row concerns or belongs to another job is the reader's placement judgement (second review, 8 Oct).
  IF public.context_ledger_elsewhere_claim(v_what) THEN
   FOR f IN SELECT x FROM jsonb_array_elements(v_facts || v_cfacts) x LOOP
    IF coalesce((f ->> 'customer_sender')::boolean, false) THEN
     RETURN jsonb_build_object('ok', false, 'code', 'elsewhere_unsupported', 'detail', 'what says a row is someone else''s; '
      || (f #>> '{cite,table}') || ':' || (f #>> '{cite,id}') || ' is this job''s customer''s own words');
    END IF;
    v_reason := public.context_ledger_row_elsewhere(p_job_id, f #>> '{cite,table}', (f #>> '{cite,id}')::uuid);
    IF starts_with(coalesce(v_reason, ''), 'role_basis:') OR v_reason = 'call_not_customer' THEN
     v_someone := v_someone + 1;
    ELSIF NOT (coalesce((f ->> 'record')::boolean, false)
      OR (coalesce((f ->> 'ours')::boolean, false) AND NOT EXISTS (SELECT 1 FROM public.business_events b
       WHERE f #>> '{cite,table}' = 'business_events' AND b.id = (f #>> '{cite,id}')::uuid AND b.event_type = 'call.transcript_completed'))) THEN
     RETURN jsonb_build_object('ok', false, 'code', 'elsewhere_unsupported', 'detail', 'what says a row is someone else''s; the stamp of '
      || (f #>> '{cite,table}') || ':' || (f #>> '{cite,id}') || ' names no one else');
    END IF;
   END LOOP;
   IF v_someone = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'elsewhere_unsupported',
     'detail', 'what says a row is someone else''s; no cited row''s own stamp names another job''s customer or party or a lead');
   END IF;
  END IF;
 END IF;
 -- A due date only when an opening excerpt states it.
 IF v_due IS NOT NULL THEN
  FOR f IN SELECT x FROM jsonb_array_elements(v_facts) x LOOP
   IF NOT (f ->> 'record')::boolean AND NOT coalesce((f ->> 'automated')::boolean, false) AND coalesce(f #>> '{cite,excerpt}', '') <> '' THEN
    BEGIN
     v_supported := public.context_supported_due_date(f #>> '{cite,excerpt}', (f ->> 'at')::timestamptz);
    EXCEPTION WHEN OTHERS THEN v_supported := NULL;
    END;
    IF v_supported = v_due THEN v_due_ok := true; END IF;
   END IF;
  END LOOP;
  IF NOT v_due_ok OR v_basis <> 'stated' THEN
   RETURN jsonb_build_object('ok', false, 'code', 'due_date_unsupported', 'detail', 'no opening excerpt states ' || v_due);
  END IF;
 END IF;
 v_first := v_open -> 0 ->> 'id';
 -- (held notes, 20261015100000) an item first opened by a held message is keyed by that message
 -- alone, so one held message opens at most one item of a type and matter on a job, whatever its
 -- words (a second is refused duplicate_item); every other item is keyed as before
 v_key := v_type || ':' || coalesce(v_about, 'none') || ':'
  || left(md5(CASE WHEN v_held_first THEN 'held:' || v_first ELSE v_first || lower(v_what) END), 12);
 RETURN jsonb_build_object('ok', true, 'item', jsonb_build_object('ref', p_item ->> 'ref', 'item_key', v_key, 'item_type', v_type,
  'status', v_status, 'from_role', v_from, 'from_name', nullif(btrim(p_item ->> 'from_name'), ''), 'to_role', v_to,
  'to_name', nullif(btrim(p_item ->> 'to_name'), ''), 'what', v_what, 'about_key', v_about, 'modality', p_item ->> 'modality',
  'phase', p_item ->> 'phase', 'due_date', v_due, 'due_basis', v_basis, 'opened_at', v_opened_at, 'opened_by', v_open,
  -- never a close time still to come (a record dated ahead closes at the check)
  'closed_at', CASE WHEN v_closed_at > now() THEN now() ELSE v_closed_at END, 'closed_by', CASE WHEN jsonb_array_length(v_close) > 0 THEN v_close END,
  'closes_on', p_item ->> 'closes_on', 'supersedes_key', nullif(btrim(p_item ->> 'supersedes_key'), ''),
  'supersedes_ref', nullif(btrim(p_item ->> 'supersedes_ref'), ''), 'blocks', p_item ->> 'blocks',
  'needs_reply', CASE WHEN jsonb_typeof(p_item -> 'needs_reply') = 'boolean' THEN (p_item ->> 'needs_reply')::boolean END, 'also_concerns', nullif(btrim(p_item ->> 'also_concerns'), ''))
  -- (held notes) only on an item a held message opened or supports
  || CASE WHEN v_held THEN jsonb_build_object('job_certain', false, 'certainty', 'job_not_certain') ELSE '{}'::jsonb END);
END $function$;
COMMENT ON FUNCTION public.context_ledger_check_item(uuid,jsonb,text,uuid,text) IS
 'Context ledger store (20261006013000), ledger reader fixes (20261007150000): a model item whose words say a row is someone else''s (its sender, caller or counterpart another person than this job''s customer, or a label saying so: context_ledger_elsewhere_claim) is refused elsewhere_unsupported when a cited row, opening or closing, is this job''s customer''s own words (customer_sender), when a cited row that is not a record or our own text, email or note (a call transcript never counts as ours alone) is not someone else''s by its own stamp (context_ledger_row_elsewhere: role_basis or call_not_customer), or when none is; a claim that a row concerns or belongs to another job is the reader''s placement judgement and stands (second review, 8 Oct); a person''s own item is their word. A PAID invoice closes a payment item (closes_on payment) at the end of its paid Perth day, never after now (context_ledger_paid_close_at), whatever the invoice''s date, so a request made the day it was paid is closed by it. Earlier: checks one ledger item for a job and returns the row to insert or {ok false, code, detail}. Shape (types, roles, about_key vocabulary, modality, phase, status per type), every citation (context_ledger_cite), closed or declined needs closed_by and nothing open carries it; a closing citation must be able to close (close_at: no draft invoice, unsent document or unattended booking: closing_not_issued), may not be an opening citation (closing_is_opening) and is at or after the opening, strictly after for a request (closing_before_opening); speaker rules for the model on the first opening citation (customer: the job''s customer sent it; us: ours, a call, a note or a record; nothing only internal texts is to the customer), a due date only when an opening excerpt states it and that message is not automated (context_supported_due_date); what has em and en dashes replaced. opened_at and closed_at come from the cited rows, never the input, and closed_at is never later than now. item_key = type:about:first 12 hex of md5(first opening citation id || lower(what)). Service role only. Held notes (20261015100000): while feature_flags.context_held_notes_v1 is on, an opening citation the citation check refuses as off the job may instead be a message held on no job with this job among its candidates (context_ledger_held_cite); the item is then marked job not certain (job_certain false, certainty job_not_certain in the returned item; the store stamps context_ledger_items.job_not_certain), must be open (held_not_open otherwise), and, when the held message is its first opening citation, is keyed by that message alone (type:about:first 12 hex of md5(''held:'' || its id)), so one held message opens at most one item of a type and matter on a job (a second is refused duplicate_item by the write). A held message never closes an item. Off: every check is as before.';

-- 9. context_ledger_judge
CREATE OR REPLACE FUNCTION public.context_ledger_judge(p_job_ids uuid[])
 RETURNS TABLE(job_id uuid, due boolean, kind text, reason text, priority integer, newest_evidence_at timestamp with time zone, evidence_rows integer, generation_id uuid, blocked_reason text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
         -- (held notes, 20261015100000) a not-certain item's own opening citation of a message still
         -- held with this job among its candidates, with the switch on and no placed copy, has not
         -- moved; once the message is placed on another job (or the switch is off) it has
         AND NOT CASE WHEN i.job_not_certain AND b.id IS NOT NULL AND b.job_id IS NULL
                      THEN i.opened_by @> jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', b.id::text))
                           AND coalesce(public.context_ledger_held_citable(i.job_id, b.id, now()), false)
                      ELSE false END
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
 ), rq AS (
  -- (rebuild request, 20261013153000) the jobs an operator asked to have read again whole, whose
  -- request no reading made since has answered (context_ledger_rebuild_request_state: pending).
  -- No request on file: no row, and every job is judged as it was
  SELECT DISTINCT q.job_id FROM public.context_ledger_rebuild_request_state(p_job_ids) q WHERE q.state = 'pending'
 ), judged AS (
  SELECT j.id AS job_id, ev.newest, coalesce(ev.n, 0) AS n, g.id AS gid,
   CASE WHEN g.id IS NULL THEN 'never_read'
    WHEN g.status = 'shadow' AND NOT public.context_ledger_checks_pass(g.checks) THEN 'checks_failed'
    WHEN m.job_id IS NOT NULL AND a.job_id IS NULL THEN 'citation_moved'
    WHEN g.reader IS DISTINCT FROM s.reader AND a.job_id IS NULL THEN 'reader_changed'
    WHEN g.evidence_until IS NULL OR g.evidence_until < ev.newest THEN
     CASE WHEN lt.first_new_at < g.evidence_until - interval '14 days' OR lt.read_after > 150 THEN 'late_evidence'
      ELSE 'new_evidence' END
    -- (rebuild request, 20261013153000) last, so a request never takes the place of a read the job
    -- is due anyway: a job never read, another rebuild or an update keeps its own reason and goes first
    WHEN q.job_id IS NOT NULL THEN 'rebuild_requested' END AS reason,
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
  LEFT JOIN rq q ON q.job_id = j.id
 )
 SELECT d.job_id, d.blk IS NULL AND d.reason IS NOT NULL,
  CASE WHEN d.reason IS NULL THEN NULL WHEN d.reason = 'never_read' THEN 'backfill' WHEN d.reason = 'new_evidence' THEN 'update'
   ELSE 'rebuild' END,
  d.reason,
  CASE d.reason WHEN 'citation_moved' THEN 1 WHEN 'new_evidence' THEN 1 WHEN 'late_evidence' THEN 1 WHEN 'never_read' THEN 2
   WHEN 'reader_changed' THEN 3 WHEN 'checks_failed' THEN 3 WHEN 'rebuild_requested' THEN 3 END,
  d.newest, d.n, d.gid, d.blk
 FROM (  -- backfills and rebuilds wait for the backfill hours; an update is never held, (notes
         -- freshness, 20261009132000) nor held back by the backoff of failed reads for a row that
         -- landed after the last of them ended: the reading reads it at once
  SELECT d0.*, coalesce(CASE WHEN d0.blocked = 'backoff' AND d0.reason = 'new_evidence' AND d0.fresh THEN NULL ELSE d0.blocked END,
                        CASE WHEN NOT s.window_open AND d0.reason IS NOT NULL AND d0.reason <> 'new_evidence'
                             THEN 'outside_window' END) AS blk
  FROM judged d0 CROSS JOIN s) d
$function$;
COMMENT ON FUNCTION public.context_ledger_judge(uuid[]) IS
 'Context ledger store (20261006013000), story safety (20261006040000): (scoping pipeline, 20261009133000) (finished wake, 20261012093500) (rebuild request, 20261013153000) A rebuild an operator asked for: a job with a request on file that no reading has answered yet (context_ledger_rebuild_request_state: state pending; context_ledger_request_rebuild files one) is due kind rebuild, reason rebuild_requested, priority 3 with the reader-change rebuilds, and only when the judgement has no reason of its own for the job: a job never read, a failed-check, moved-citation, reader-change or late-evidence rebuild and a new-evidence update each keep their own reason and are read first. Every block holds it as it holds any rebuild (ledger_off, lane_off, not_in_rollout, not_live, holding_job, lead_not_monitored, no_evidence, busy, needs_person, backoff, outside_window). It is due once: a whole reading made after the request that passes its checks or went live answers it, whatever reason that reading was claimed for, and after three whole readings made after it that failed it is given up. With no request on file every job is judged exactly as before. Earlier (finished wake): The owner''s 12 Oct 2026 ruling: a finished job (cancelled, archived, complete, completed or lost) is live, and so due a read as any live job (never read: a backfill; a new message: an update), only while the lead rule calls it awake (context_lead_monitored_jobs state finished_awake: a real inbound message of its customer''s on the job inside 30 days, context_finished_wake_hours); a quiet one is blocked not_live, as every finished job was, and its notes stay. The rule is read once for every job asked about. Earlier (scoping pipeline): The lead rule is read once for unfinished jobs including drafts; a draft is live only while monitored from its own activity inside four weeks (six for patio), else blocked not_live. (notes freshness, 20261009132000) a row a reading has not read is the ledger''s one rule (context_ledger_row_unread: a row of the evidence that is not automated and landed after the reading''s evidence_until, copies left out; landing covers a row whose own time is earlier, such as a late call transcript, a late-captured email or a backfilled text). An update is never held by the backoff of failed reads for such a row that landed after the last failed read ended (a read that lost its building lease in the last 2 hours still holds the job; a backfill or rebuild backs off as before). A rebuild of a live reading (moved citation, changed reader) is answered only by the reading the go-live sweep would promote: the job''s newest shadow, newer than the live one, by the current reader, passing its checks, with no row it has not read; the sweep never promotes one with such a row and a shadow beside a live reading is never updated, so such a one answers nothing. Earlier (lead cutoff, 20261007010000) blocked lead_not_monitored: a live job that is a lead no longer followed up (context_lead_monitored_jobs as of now: still at quoted with no acceptance, Xero invoice or bill, booking or later status 28 days after the newer of its newest quote send and the customer''s newest text, email or call, wherever it is placed) is never due a read, so context_ledger_due never lists it and a claim answers not_due; its evidence is not read in full. It is due again the moment it progresses or the customer writes. Earlier (eighth review) citation_moved also takes an item whose citation the citation check refuses now, as the story''s ledger read re-checks it: a CRM text loaded from the cache whose CRM time is not kept or is more than 30 days before the job was created, and an old-inbox mail now placed on another job (or from the client''s address on no job while the client has another job, or from before the job''s lead window), not worded, spam, a newsletter or an auto-reply, or with a saved copy on this job or another live job (the judge''s live set); a mail''s copies time it from when one left a live job (context_ledger_mail_copies). Earlier: a legacy mail whose saved copy sits on another job or on no job counts from when it can have joined the job''s evidence (context_ledger_mail_copies: no earlier than that rule''s first apply and the copy''s own landing), in the quick read (for a job with a reading) as in the full one, so a reading built before then is never taken to have read it and the job is due; (seventh review) one whose copy sits on another live job is not this job''s evidence at all: the full read leaves it out, and the quick read, a superset, may only overstate by it and then reads the job in full; a never-read job''s quick read is as before, except that a never-read job whose admitted rows are all CRM texts loaded from the cache (source ghl_sms_cache_backfill) is read in full, since the evidence leaves out one dated before the job''s lead window and so may hold none (then it is no_evidence, never a backfill of nothing). Earlier: the one ledger due judgement per job (the full evidence read only for a job whose reading may have newer evidence or whose only possible evidence is legacy mail; elsewhere a count and newest landed time of the admitted rows decide the same; evidence_rows is then that count): kind backfill (never_read), update (new_evidence: the current generation''s evidence_until is older than the newest admissible evidence), or rebuild (checks_failed: the current reading is a shadow whose checks.passed is false; citation_moved: an item cites a business_events row now gone, off the job or not admissible; reader_changed; late_evidence: the earliest unread row is more than 14 days older than evidence_until, or more than 150 already-read rows follow it). A rebuild of the live reading for a moved citation or a changed reader is not due while a newer passing shadow by the current reader waits for promotion. Blocked: ledger_off, lane_off, not_in_rollout (settings.job_ids is set and does not list the job), not_live, holding_job, no_evidence, busy (a live building generation or a running ledger run), needs_person (three builds in a row failed their checks: context_ledger_failures), backoff (consecutive failed or check-failed runs: 2 hours, 8 hours, the next Perth day, then 7 days; or a building generation that lost its lease in the last 2 hours), outside_window (a backfill or rebuild outside the settings backfill hours; an update is never held). A person-locked item is never a moved citation (a rebuild would carry it back). Service role only. Held notes (20261015100000): a citation_moved rebuild is not raised for a not-certain item''s own opening citation of a message still held with the job among its candidates while the switch is on and no copy of it is placed (context_ledger_held_citable); once that message is placed on another job, or the switch is off, the item has moved, as any citation off the job. Held messages still never make a job due or move evidence_until.';

-- 10. context_job_story_ledger
CREATE OR REPLACE FUNCTION public.context_job_story_ledger(p_job_id uuid, p_generation_id uuid DEFAULT NULL::uuid, p_as_of timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH g AS (  -- the generation asked for, else the one live at p_as_of (the newest promoted by then)
  SELECT x.* FROM public.context_ledger_generations x
  WHERE x.job_id = p_job_id
    AND CASE WHEN p_generation_id IS NOT NULL THEN x.id = p_generation_id
             ELSE x.status IN ('live', 'retired') AND x.promoted_at <= p_as_of END
  ORDER BY x.promoted_at DESC NULLS LAST, x.created_at DESC LIMIT 1
 ),
 other AS (  -- with no generation to show, say whether one is being built or waits in shadow
  SELECT x.status FROM public.context_ledger_generations x
  WHERE x.job_id = p_job_id AND x.status IN ('building', 'shadow') AND NOT EXISTS (SELECT 1 FROM g)
  ORDER BY x.created_at DESC LIMIT 1
 ),
 evr AS MATERIALIZED (  -- the store's own evidence against the shown generation's evidence_until:
                       -- read when it landed by then (nothing is read when no generation is shown);
                       -- (notes freshness, 20261009132000) unread by the ledger's one rule
  SELECT r.src_id, r.copy_of, r.direction, (g.evidence_until IS NOT NULL AND r.landed_at <= g.evidence_until) AS was_read,
         public.context_ledger_row_unread(r.landed_at, r.automated, g.evidence_until) AS unread
  FROM g CROSS JOIN LATERAL public.context_ledger_evidence_rows(ARRAY[g.job_id], p_as_of) r
 ),
 unread AS (  -- what the shown generation's reader has not read; copies are listed by id
              -- but not counted as new messages; (notes freshness) an automated row (a workflow
              -- text, a crew or staff template) never makes the notes stale
  SELECT e.src_id, e.copy_of FROM evr e WHERE e.unread
 ),
 it0 AS (  -- replay: items written by p_as_of, each with its status then
  SELECT i.*, coalesce((SELECT t.to_status FROM public.context_ledger_transitions t WHERE t.item_id = i.id AND t.at <= p_as_of
                         ORDER BY t.at DESC, t.id DESC LIMIT 1), i.status) AS status_then
  FROM public.context_ledger_items i JOIN g ON g.id = i.generation_id
  WHERE i.created_at <= p_as_of
 ),
 -- (eighth review) the job, its client's address, and whether the client has another job (the
 -- citation check's rule for mail placed on no job)
 jb AS (
  SELECT j.created_at, lower(nullif(btrim(j.client_email), '')) AS cmail,
         (EXISTS (SELECT 1 FROM public.jobs o WHERE o.ghl_contact_id = nullif(btrim(j.ghl_contact_id), '') AND o.id <> j.id)
          OR EXISTS (SELECT 1 FROM public.jobs o WHERE o.client_email IS NOT NULL
                     AND lower(btrim(o.client_email)) = lower(nullif(btrim(j.client_email), '')) AND o.id <> j.id)) AS repeat_client
  FROM public.jobs j WHERE j.id = p_job_id
 ),
 it AS (
  SELECT i.*,
   (SELECT jsonb_agg(jsonb_build_object('table', c->>'table', 'id', c->>'id', 'excerpt', c->>'excerpt',
            'at', coalesce(e.event_at, e.occurred_at),
            'ok', CASE
                       -- (eighth review) an old-inbox mail, as the citation check admits it now: placed
                       -- on this job, or from the client's address on no job (the client with no
                       -- other job, from 30 days before the job on), worded, no saved copy on this job
                       -- or on another live job, no email on this job from its sender at its instant
                       WHEN c->>'table' = 'inbox_events'
                       THEN coalesce(m.id IS NOT NULL AND m.received_at IS NOT NULL
                            AND (m.job_id = p_job_id
                                 OR (m.job_id IS NULL AND (SELECT jb.cmail FROM jb) IS NOT NULL AND lower(btrim(m.from_email)) = (SELECT jb.cmail FROM jb)
                                     AND NOT (SELECT jb.repeat_client FROM jb) AND m.received_at >= (SELECT jb.created_at FROM jb) - interval '30 days'))
                            AND coalesce(m.classification, '') NOT IN ('spam', 'newsletter')
                            AND coalesce(m.subject, '') !~* '^(automatic reply|auto[- ]?reply|out of office)'
                            AND btrim(coalesce(m.subject, '') || coalesce(m.body_preview, '')) <> ''
                            AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table = 'inbox_events' AND b.source_id = m.id::text
                                             AND (b.job_id = p_job_id OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = b.job_id
                                                  AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                                  AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
                            AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE m.graph_message_id IS NOT NULL AND b.provider_message_id = 'graph:' || m.graph_message_id
                                             AND (b.job_id = p_job_id OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = b.job_id
                                                  AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                                  AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
                            AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE b.source_table IS NULL
                                             AND b.payload @> jsonb_build_object('inbox_events_id', m.id::text)
                                             AND (b.job_id = p_job_id OR EXISTS (SELECT 1 FROM public.jobs oj WHERE oj.id = b.job_id
                                                  AND oj.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
                                                  AND coalesce(oj.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1'))))
                            AND NOT EXISTS (SELECT 1 FROM public.business_events b WHERE b.channel = 'email' AND coalesce(b.event_at, b.occurred_at) = m.received_at
                                             AND lower(btrim(coalesce(b.payload ->> 'from', b.payload ->> 'from_email'))) = lower(btrim(m.from_email))
                                             AND b.job_id = p_job_id), false)
                       WHEN c->>'table' <> 'business_events' THEN true
                       -- (eighth review) never unknown: a cited row moved to no job, or with no
                       -- status, is not this job's evidence either (the judge already says so)
                       ELSE coalesce(e.id IS NOT NULL AND e.job_id = p_job_id AND public.context_linked_status(e.attribution_status)
                            AND e.metadata->>'retracted_at' IS NULL AND coalesce(e.metadata->>'retracted', 'false') <> 'true'
                            -- (eighth review) a CRM text loaded from the cache: its CRM time kept, and
                            -- not more than 30 days before the job was created
                            AND NOT (coalesce(e.source, '') = 'ghl_sms_cache_backfill'
                                     AND coalesce(ct.crm_at < (SELECT jb.created_at FROM jb) - interval '30 days', true)), false)
                            -- (held notes, 20261015100000) or a not-certain item's own opening
                            -- citation of a message still held for this job (context_ledger_held_citable)
                            OR hc.held
                       END,
            'customer', (e.metadata->'party_roles'->>'sender_role' = 'customer'))
            || CASE WHEN hc.held THEN jsonb_build_object('held', true) ELSE '{}'::jsonb END)
    FROM jsonb_array_elements(i.opened_by || CASE WHEN i.closed_at <= p_as_of THEN coalesce(i.closed_by, '[]'::jsonb) ELSE '[]'::jsonb END) c
    LEFT JOIN public.business_events e ON c->>'table' = 'business_events'
     AND e.id = CASE WHEN c->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (c->>'id')::uuid END
    LEFT JOIN LATERAL (SELECT CASE WHEN e.source = 'ghl_sms_cache_backfill'
                                   THEN public.context_job_record_crm_time(e.source, e.contact_id,
                                          coalesce(nullif(btrim(e.payload ->> 'ghl_message_id'), ''), substring(e.provider_message_id FROM '^ghl:(.+)$')), e.job_id)
                              END AS crm_at) ct ON true
    -- (held notes) a held message the item was stored as opened by, still held for this job
    LEFT JOIN LATERAL (SELECT CASE WHEN i.job_not_certain AND e.id IS NOT NULL AND e.job_id IS NULL
                                    AND i.opened_by @> jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', e.id::text))
                                   THEN coalesce(public.context_ledger_held_citable(p_job_id, e.id, p_as_of), false)
                                   ELSE false END AS held) hc ON true
    LEFT JOIN public.inbox_events m ON c->>'table' = 'inbox_events'
     AND m.id = CASE WHEN c->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (c->>'id')::uuid END) AS cited
  FROM it0 i
 )
 SELECT jsonb_build_object(
  'status', coalesce((SELECT g.status FROM g), (SELECT other.status FROM other), 'none'),
  'generation', (SELECT jsonb_build_object('id', g.id, 'status', g.status, 'kind', g.kind, 'reader', g.reader, 'model', g.model,
                  'evidence_until', g.evidence_until, 'evidence_rows', g.evidence_rows, 'created_at', g.created_at,
                  'promoted_at', g.promoted_at) FROM g),
  'items', coalesce((SELECT jsonb_agg(jsonb_build_object('item_key', it.item_key, 'item_type', it.item_type, 'status', it.status_then,
              'from_role', it.from_role, 'from_name', it.from_name, 'to_role', it.to_role, 'to_name', it.to_name,
              -- (held notes) an item a held message still holds up says so in its own words
              'what', CASE WHEN it.held_now THEN 'Job not certain: ' || it.what ELSE it.what END,
              'about_key', it.about_key, 'modality', it.modality, 'phase', it.phase, 'due_date', it.due_date, 'opened_at', it.opened_at,
              'opened_by', it.opened_by,
              'closed_at', CASE WHEN it.closed_at <= p_as_of AND it.status_then IN ('closed', 'declined', 'superseded') THEN it.closed_at END,
              'closed_by', CASE WHEN it.closed_at <= p_as_of AND it.status_then IN ('closed', 'declined', 'superseded') THEN it.closed_by END,
              'closes_on', it.closes_on,
              'supersedes_key', it.supersedes_key, 'blocks', it.blocks, 'needs_reply', it.needs_reply, 'written_by', it.written_by,
              'person_locked', it.person_locked, 'cited', it.cited,
              'cites_ok', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(it.cited, '[]'::jsonb)) c WHERE NOT (c->>'ok')::boolean))
              -- (held notes, 20261015100000) only on an item a held message still holds up
              || CASE WHEN it.held_now THEN jsonb_build_object('job_certain', false, 'certainty', 'job_not_certain') ELSE '{}'::jsonb END
              ORDER BY it.opened_at, it.item_key COLLATE "C")
            FROM (SELECT it.*, EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(it.cited, '[]'::jsonb)) c
                                       WHERE coalesce((c->>'held')::boolean, false)) AS held_now FROM it) it), '[]'::jsonb),
  'transitions', coalesce((SELECT jsonb_agg(jsonb_build_object('item_key', i.item_key, 'from_status', t.from_status,
                   'to_status', t.to_status, 'at', t.at, 'by', t.by, 'reason', t.reason, 'evidence', t.evidence) ORDER BY t.at, t.id)
                 FROM public.context_ledger_transitions t JOIN public.context_ledger_items i ON i.id = t.item_id
                 JOIN g ON g.id = t.generation_id WHERE t.at <= p_as_of), '[]'::jsonb),
  'unread_rows', CASE WHEN EXISTS (SELECT 1 FROM g) THEN (SELECT count(*)::integer FROM unread u WHERE u.copy_of IS NULL) END,
  'unread_ids', CASE WHEN EXISTS (SELECT 1 FROM g) THEN coalesce((SELECT jsonb_agg(u.src_id::text ORDER BY u.src_id) FROM unread u), '[]'::jsonb) END,
  -- the inbound rows it has read: the story says the reader judged a customer message only for these
  'read_ids', CASE WHEN EXISTS (SELECT 1 FROM g) THEN coalesce((SELECT jsonb_agg(e.src_id::text ORDER BY e.src_id) FROM evr e
                    WHERE e.was_read AND e.direction = 'inbound'), '[]'::jsonb) END
 )
$function$;
COMMENT ON FUNCTION public.context_job_story_ledger(uuid,uuid,timestamptz) IS
 'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000): (notes freshness, 20261009132000) unread_rows and unread_ids read the ledger''s one rule (context_ledger_row_unread), as the judge, the due order and the go-live sweep do: a row of the store''s evidence that is not automated (a workflow text, a crew or staff template) and landed after the shown generation''s evidence_until, so an automated message alone never makes meta.ledger.stale true or puts the not-known line about newer messages on the card, and every other row the notes have not read does. Earlier (eighth review) each stored citation is re-checked by the citation check''s current rules (context_ledger_cite), so an item citing a row that is no longer this job''s evidence carries cites_ok false (the story hides it and asks for a rebuild; the judge raises citation_moved): a business_events row also needs, when it is a CRM text loaded from the cache (ghl_sms_cache_backfill), its CRM time kept and not more than 30 days before the job was created; an inbox_events mail must be placed on this job, or come from the client''s address on no job (the client with no other job, from 30 days before the job on), be worded, not spam, a newsletter or an auto-reply, with no saved copy on this job or on another live job (the judge''s live set: never archived, complete, completed, cancelled, lost, a draft or holding) by its source pointer, graph key or payload pointer, and no email on this job from its sender at its instant; and the check is never unknown (a cited row moved to no job, or with no attribution status, read as passing when the check came out null, is not this job''s evidence either, as the judge already said). Earlier, story fixes: items tie on opened_at by item_key in C (byte) order. Earlier: the ledger generation the story shows (the one live at p_as_of, or the one asked for in any status) with the items written by p_as_of, each at its status then, and the transitions by then; every business_events citation is re-checked (still on this job, linked, not retracted) and the item carries cites_ok. unread_rows: the store''s evidence (context_ledger_evidence_rows as of p_as_of, copies not counted) that landed after the shown generation''s evidence_until, so the story says how far its own reader has read; unread_ids: those rows and their copies by id; read_ids: the inbound evidence rows it has read (landed by its evidence_until), so a customer message is called judged only when the reader read it; all three null when no generation is shown. With no generation to show, status says building or shadow when one exists, else none. Service role only. Held notes (20261015100000): a not-certain item''s opening citation of a message still held for this job (context_ledger_held_citable as of p_as_of) is ok and carries held true; such an item carries job_certain false and certainty job_not_certain, and its what starts "Job not certain: ". When the message is later placed on this job the item reads as certain; placed on another job, the citation is not ok, the item is hidden and the judge asks for a rebuild, which drops it. No key changes for any other item.';

-- 11. context_ledger_packet
CREATE OR REPLACE FUNCTION public.context_ledger_packet(p_job_id uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_as_of timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE jb record; v_job jsonb; v_parties jsonb; v_evidence jsonb; v_open jsonb; v_until timestamptz; v_rows integer;
 v_truncated integer; v_dups integer; v_as_of timestamptz; v_gen uuid; v_pe text[]; v_pp text[]; v_pc text[];
 v_held jsonb; v_on boolean;
BEGIN
 v_as_of := coalesce(p_as_of, now());
 v_on := public.context_held_notes_on();
 SELECT j.id, j.job_number, j.type::text AS type, j.status::text AS status, j.client_name, j.site_suburb, j.created_at,
  nullif(btrim(j.ghl_contact_id), '') AS ghl_contact_id, j.client_email, j.client_phone
 INTO jb FROM public.jobs j WHERE j.id = p_job_id;
 IF jb.id IS NULL THEN RAISE EXCEPTION 'context_ledger_packet_job_not_found'; END IF;
 v_job := jsonb_build_object('id', jb.id, 'job_number', jb.job_number, 'type', jb.type, 'status', jb.status,
  'client_name', jb.client_name, 'site_suburb', jb.site_suburb, 'created_at', jb.created_at,
  'customer_contact_ref', jb.ghl_contact_id);
 -- Parties: the job's own client, then every other party on job_contacts
 -- (the owner row that repeats the job's client is not listed twice; its
 -- contact details join the client's). Each carries match_keys, so the reader
 -- can tell whether our message reached that party (never printed).
 SELECT array_agg(c.client_email), array_agg(c.client_phone), array_agg(nullif(btrim(c.ghl_contact_id), ''))
 INTO v_pe, v_pp, v_pc
 FROM public.job_contacts c
 WHERE c.job_id = p_job_id AND c.removed_at IS NULL
  AND coalesce(c.is_primary, false) AND lower(coalesce(c.client_name, '')) = lower(coalesce(jb.client_name, ''));
 SELECT jsonb_build_array(jsonb_build_object('name', jb.client_name, 'role', 'customer', 'contact_ref', jb.ghl_contact_id, 'label', 'job_client',
   'match_keys', public.context_ledger_party_keys(ARRAY[jb.client_email] || v_pe, ARRAY[jb.client_phone] || v_pp,
    ARRAY[jb.ghl_contact_id] || v_pc)))
  -- A party's role: a neighbour (contact_type neighbour, neighbour_b and so on) is a
  -- third party, never the customer, labelled neighbour (and "pays a share" when
  -- its share or invoiced amount says so); the primary contact is the customer;
  -- any other keeps its contact_type, else unknown.
  || coalesce(jsonb_agg(jsonb_build_object('name', c.client_name,
   'role', CASE WHEN lower(coalesce(c.contact_type, '')) LIKE 'neighbour%' THEN 'third_party'
                WHEN coalesce(c.is_primary, false) OR lower(coalesce(c.contact_type, '')) = 'primary' THEN 'customer'
                ELSE coalesce(nullif(btrim(c.contact_type), ''), 'unknown') END,
   'contact_ref', coalesce(nullif(btrim(c.ghl_contact_id), ''), lower(nullif(btrim(c.client_email), ''))),
   'label', CASE WHEN lower(coalesce(c.contact_type, '')) LIKE 'neighbour%'
                 THEN 'neighbour' || CASE WHEN coalesce(c.share_percentage, 0) > 0 OR coalesce(c.amount_invoiced, 0) > 0
                                          THEN ', pays a share' ELSE '' END
                 ELSE coalesce(c.contact_label, c.contact_type) END,
   'match_keys', public.context_ledger_party_keys(ARRAY[c.client_email], ARRAY[c.client_phone], ARRAY[nullif(btrim(c.ghl_contact_id), '')]))
   ORDER BY c.is_primary DESC NULLS LAST, c.created_at, c.id), '[]'::jsonb)
 INTO v_parties
 FROM public.job_contacts c
 WHERE c.job_id = p_job_id AND c.removed_at IS NULL
  AND NOT (coalesce(c.is_primary, false) AND lower(coalesce(c.client_name, '')) = lower(coalesce(jb.client_name, '')));
 -- Evidence: copies left out. In update mode: the rows that landed after
 -- p_since; every already-read row after the earliest of them (so a late row,
 -- such as old mail placed on the job today, is read with what followed it);
 -- and the six rows before it. Each row says whether it was already read.
 WITH r AS (
  SELECT * FROM public.context_ledger_evidence_rows(ARRAY[p_job_id], v_as_of)
 ), u AS (
  SELECT * FROM r WHERE r.copy_of IS NULL
 ), firstnew AS (
  SELECT u.at, u.src_id FROM u WHERE p_since IS NOT NULL AND u.landed_at > p_since ORDER BY u.at, u.src_id LIMIT 1
 ), ctx AS (
  SELECT u.src_id FROM u, firstnew f
  WHERE (u.at, u.src_id) < (f.at, f.src_id) AND NOT (u.landed_at > p_since)
  ORDER BY u.at DESC, u.src_id DESC LIMIT 6
 ), sel AS (
  SELECT u.*, CASE WHEN u.kind IN ('call.transcript_completed', 'document.text_extracted') THEN 6000 ELSE 3000 END AS lim
  FROM u WHERE p_since IS NULL OR u.landed_at > p_since OR u.src_id IN (SELECT ctx.src_id FROM ctx)
   OR EXISTS (SELECT 1 FROM firstnew f WHERE (u.at, u.src_id) > (f.at, f.src_id))
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('table', sel.src_table, 'id', sel.src_id, 'at', sel.at, 'recorded_at', sel.landed_at,
   'channel', sel.channel, 'kind', sel.kind, 'direction', sel.direction, 'sender_role', sel.sender_role,
   'recipient_role', sel.recipient_role, 'audience', sel.audience, 'counterpart_role', sel.counterpart_role,
   'role_basis', sel.role_basis, 'sender', sel.sender, 'recipient', sel.recipient, 'ours', sel.ours, 'automated', sel.automated, 'subject', sel.subject,
   'already_read', p_since IS NOT NULL AND sel.landed_at <= p_since, 'placed_on', sel.placed_on, 'has_transcript', sel.has_transcript,
   -- (ledger reader fixes, 20261007150000) a transcript says whose call it is as true, false or
   -- "unknown" (neither its call row on this job nor its own stamp on the job's contact decides),
   -- never a bare null, which readers took for "not this job's customer"; and each row says whether
   -- its own placement or role basis makes it someone else's (the item check's rule), and why
   'call_customer', CASE WHEN sel.kind = 'call.transcript_completed' THEN coalesce(to_jsonb(sel.call_customer), '"unknown"'::jsonb)
                         ELSE to_jsonb(sel.call_customer) END,
   'elsewhere', public.context_ledger_row_elsewhere(p_job_id, sel.src_table, sel.src_id),
   'text', left(sel.body, sel.lim)) ORDER BY sel.at, sel.src_id), '[]'::jsonb),
  count(*)::integer, (count(*) FILTER (WHERE length(sel.body) > sel.lim))::integer,
  (SELECT max(r.landed_at) FROM r), (SELECT count(*) FILTER (WHERE r.copy_of IS NOT NULL) FROM r)::integer
 INTO v_evidence, v_rows, v_truncated, v_until, v_dups FROM sel;
 -- Items the reader must know: in update mode the current generation's open,
 -- disputed and in-force items; otherwise the live generation's person-locked
 -- items (a rebuild must not write them again).
 IF p_since IS NOT NULL THEN
  v_gen := public.context_ledger_current_generation(p_job_id);
 ELSE
  SELECT g.id INTO v_gen FROM public.context_ledger_generations g WHERE g.job_id = p_job_id AND g.status = 'live';
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('item_key', i.item_key, 'item_type', i.item_type, 'status', i.status, 'what', i.what,
   'about_key', i.about_key, 'phase', i.phase, 'from_role', i.from_role, 'to_role', i.to_role, 'opened_at', i.opened_at,
   'closes_on', i.closes_on, 'opened_by', i.opened_by, 'person_locked', i.person_locked)
   -- (held notes, 20261015100000) an item a held message still holds up is marked job not certain
   || CASE WHEN i.job_not_certain AND public.context_ledger_item_held_now(p_job_id, i.opened_by, v_as_of)
           THEN jsonb_build_object('job_certain', false, 'certainty', 'job_not_certain') ELSE '{}'::jsonb END
   ORDER BY i.opened_at, i.item_key COLLATE "C"), '[]'::jsonb)
 INTO v_open FROM public.context_ledger_items i
 WHERE v_gen IS NOT NULL AND i.generation_id = v_gen
  AND CASE WHEN p_since IS NOT NULL THEN i.status IN ('open', 'disputed', 'info') ELSE i.person_locked END;
 -- (held messages, 20261012100000) The messages placed on no job that could be this job's
 -- (context_ledger_held_rows: the ladder left them unplaced with this job among their candidates,
 -- nearly always because the customer has several jobs). They are context for the reader, marked
 -- job not certain: never evidence rows, never counted, never citable (the citation check still
 -- refuses them as off the job), and their placement is not read as this job's. A rebuild is given
 -- the newest 40; an update the newest 40 that landed after p_since and, when there is one, the 6
 -- newest it was given before, to read them by. Oldest first; text capped at 6,000 characters for
 -- a transcript or document text and 3,000 otherwise, as for placed evidence; cuts are explicit.
 WITH h AS (
  SELECT * FROM public.context_ledger_held_rows(ARRAY[p_job_id], v_as_of)
 ), fresh AS (
  SELECT h.*, false AS already_read FROM h WHERE p_since IS NULL OR h.landed_at > p_since
  ORDER BY h.at DESC, h.src_id DESC LIMIT 40
 ), ctx AS (
  SELECT h.*, true AS already_read FROM h
  WHERE p_since IS NOT NULL AND NOT (h.landed_at > p_since) AND EXISTS (SELECT 1 FROM fresh)
  ORDER BY h.at DESC, h.src_id DESC LIMIT 6
 ), sel AS (
  SELECT * FROM fresh UNION ALL SELECT * FROM ctx
 )
 SELECT jsonb_build_object('certainty', 'job_not_certain',
  'total', (SELECT count(*) FROM h),
  'new', (SELECT count(*) FROM h WHERE p_since IS NULL OR h.landed_at > p_since),
  'not_shown', (SELECT count(*) FROM h) - (SELECT count(*) FROM sel),
  'rows', coalesce((SELECT jsonb_agg(jsonb_build_object('table', sel.src_table, 'id', sel.src_id, 'at', sel.at,
     'recorded_at', sel.landed_at, 'channel', sel.channel, 'kind', sel.kind, 'direction', sel.direction,
     'sender_role', sel.sender_role, 'recipient_role', sel.recipient_role, 'audience', sel.audience,
     'counterpart_role', sel.counterpart_role, 'role_basis', sel.role_basis, 'sender', sel.sender, 'recipient', sel.recipient,
     'ours', sel.ours, 'automated', sel.automated, 'subject', sel.subject, 'already_read', sel.already_read,
     'placed_on', 'none', 'certainty', 'job_not_certain', 'from_this_customer', sel.same_contact,
     'held_rule', sel.held_rule, 'candidate_jobs', sel.candidate_jobs, 'other_jobs', to_jsonb(sel.other_jobs),
     'text', left(sel.body, CASE WHEN sel.kind IN ('call.transcript_completed', 'document.text_extracted') THEN 6000 ELSE 3000 END),
     'cut', length(sel.body) > CASE WHEN sel.kind IN ('call.transcript_completed', 'document.text_extracted') THEN 6000 ELSE 3000 END)
     -- (held notes, 20261015100000) with the switch on, whether the reader may cite it to open or
     -- support an open item marked job not certain: never when a copy of it is placed on a job
     -- (cite that copy) or its call is on another job
     || CASE WHEN v_on THEN jsonb_build_object('citable', NOT EXISTS (SELECT 1 FROM public.context_ledger_held_placed_copy(sel.src_id) pc
                                                                    WHERE pc.how = 'copy' OR pc.copy_job_id <> p_job_id))
             ELSE '{}'::jsonb END
     ORDER BY sel.at, sel.src_id) FROM sel), '[]'::jsonb))
  -- (held notes) with the switch on, the section says its rows may be cited, marked job not certain
  || CASE WHEN v_on THEN jsonb_build_object('citable', 'job_not_certain') ELSE '{}'::jsonb END
 INTO v_held;
 RETURN jsonb_build_object('version', 'ledger-packet-v1', 'job', v_job, 'parties', v_parties, 'evidence', v_evidence,
  'evidence_until', v_until, 'evidence_rows', v_rows, 'truncated_rows', v_truncated, 'duplicates_collapsed', v_dups,
  'since', p_since, 'as_of', v_as_of, 'open_items', v_open,
  -- (ledger reader fixes, 20261007150000) the same client's and the same work order's other jobs,
  -- with what was quoted and billed there
  'siblings', public.context_ledger_siblings(p_job_id, v_as_of),
  -- (held messages, 20261012100000) the messages on no job that could be this job's, job not certain
  'held', v_held);
END $function$;
COMMENT ON FUNCTION public.context_ledger_packet(uuid,timestamptz,timestamptz) IS
 'Context ledger store (20261006013000), ledger reader fixes (20261007150000): (held messages, 20261012100000) still ledger-packet-v1, with one field added: held {certainty job_not_certain, total, new, not_shown, rows}: the messages placed on no job that could be this job''s (context_ledger_held_rows: unplaced or waiting on the placement review with this job among their stored candidates, nearly always because the customer has several jobs; worded, a message kind, never retracted, a copy or status-only), as of the packet''s as_of. Context only, marked job not certain: never evidence rows, never in evidence_rows or evidence_until, never citable (the citation check still refuses them, citation_off_job), and nothing about their placement is changed or read as this job''s. total: all of them; new: those that landed after since (all on a rebuild); rows, oldest first: a rebuild''s newest 40, or an update''s newest 40 new ones and, when there is one, the 6 newest given before (already_read true); each row as an evidence row (table, id, at, recorded_at, channel, kind, direction, the stored role fields, sender, recipient, ours, automated, subject) with placed_on none, certainty job_not_certain, from_this_customer (the row''s CRM contact is the job''s, or its sender address the job''s client email), held_rule (the placement rule that held it), candidate_jobs (how many jobs it could belong to), other_jobs (the other candidates'' job numbers, C order) and text (capped at 3,000 characters for a transcript or document text, 1,500 otherwise); not_shown: how many of total are not in rows. Earlier (ledger reader fixes) still ledger-packet-v1, with fields added: each transcript''s call_customer is true, false or the string unknown (neither its call row on this job nor its own stamp on the job''s contact decides), never a bare null; each evidence row carries elsewhere, the reason it is someone else''s (context_ledger_row_elsewhere: role_basis:<basis> when its own stamp names another job''s customer or party or a lead, call_not_customer when its call row''s on this job does, call_on_other_job, names_other_job:<number>) or null, never on the customer''s own words or a stamp naming our own people, a supplier, a builder, a council, a party on this job or nobody (second review, 8 Oct); only role_basis and call_not_customer carry an item that says a row is someone else''s (elsewhere_unsupported); and siblings (context_ledger_siblings as of the packet''s as_of): the same client''s and the same work order''s other jobs with their quotes sent and invoices issued, context only. Earlier: ledger-packet-v1, the reader''s whole view of a job except the record text: job, parties (the job client and a primary contact role customer, a neighbour role third_party labelled neighbour, others their contact_type or unknown; each with match_keys: emails, phones'' last 9 digits), evidence (context_ledger_evidence_rows without copies, oldest first, text capped at 6,000 characters for transcripts and document text and 3,000 otherwise; each row with already_read, placed_on and, on a call log, has_transcript, call_customer on transcripts), evidence_until (newest recorded time seen), evidence_rows, truncated_rows, duplicates_collapsed, open_items (each with phase, closes_on and opened_by as stored). With p_since: rows recorded after it, every already-read row after the earliest of them, and the six before it, and the current generation''s open, disputed and in-force items; without: the live generation''s person-locked items. The judge asks for a rebuild (late_evidence) instead when the earliest new row is more than 14 days older than evidence_until or more than 150 already-read rows follow it. Role fields are the stored party_roles stamp, never invented. Service role only. Story card causes (20261014120000): held text uses the same 6000/3000 limits as placed evidence with an explicit cut flag. Held notes (20261015100000): an open item a held message still holds up carries job_certain false and certainty job_not_certain; while the switch is on, held carries citable job_not_certain and each held row citable (false when a copy is placed on a job or its call is on another job). Off: unchanged.';

-- 12. context_job_story
CREATE OR REPLACE FUNCTION public.context_job_story(p_job_id uuid, p_as_of timestamp with time zone DEFAULT now(), p_generation_id uuid DEFAULT NULL::uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_record_only boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 -- (held messages, 20261012100000) the story, and with it the messages placed on no job that could be
 -- this job's (context_job_story_held), marked job not certain: only when there are any, so a job
 -- with none reads exactly as before, and never in the records-only read
 -- (held notes, 20261015100000) the items a held message still holds up are marked job not
 -- certain wherever the card lists them (context_job_story_held_marks); none: unchanged
 SELECT public.context_job_story_held_marks(public.context_job_story_payment_terms(st.story), p_job_id, p_as_of) || CASE WHEN hm.held IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('held_messages', hm.held) END
 FROM (SELECT public.context_job_story_assemble(
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
  -- (story settled notes, 20261011120000) and each call log on the job whose transcript is on the job
  -- by p_as_of, call row id to transcript id (the evidence rows' has_transcript pairing: the
  -- transcript's payload.ghl_call_id or key ghltx:<id> names the call's ghl:<id>), so the assembler
  -- can leave out an event the reader wrote from the call log alone
  public.context_job_story_meta(p_job_id, p_as_of)
   || jsonb_build_object('call_transcripts', (SELECT coalesce(jsonb_object_agg(e.id::text, t.id::text), '{}'::jsonb)
        FROM public.business_events e
        CROSS JOIN LATERAL (SELECT t.id FROM public.business_events t
                            WHERE t.job_id = e.job_id AND t.event_type = 'call.transcript_completed'
                              AND public.context_linked_status(t.attribution_status)
                              AND (t.payload ->> 'ghl_call_id' = substr(e.provider_message_id, 5)
                                   OR t.provider_message_id = 'ghltx:' || substr(e.provider_message_id, 5))
                              AND greatest(coalesce(t.context_captured_at, t.recorded_at, t.occurred_at), t.attributed_at) <= p_as_of
                            ORDER BY t.id LIMIT 1) t
        WHERE e.job_id = p_job_id AND e.event_type <> 'call.transcript_completed'
          AND (e.channel = 'call' OR e.event_type IN ('client.call_logged', 'client.call_complete'))
          AND e.provider_message_id LIKE 'ghl:%' AND public.context_linked_status(e.attribution_status))),
  p_as_of, p_since) AS story
 WHERE EXISTS (SELECT 1 FROM public.jobs jb WHERE jb.id = p_job_id)) st
 CROSS JOIN LATERAL (SELECT CASE WHEN coalesce(p_record_only, false) THEN NULL
                                 ELSE public.context_job_story_held(p_job_id, p_as_of) END AS held) hm
$function$;
COMMENT ON FUNCTION public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean) IS
 'Job story (20261006014000), lead cutoff (20261007010000): (story settled notes, 20261011120000) (held messages, 20261012100000) the story also carries held_messages (context_job_story_held as of p_as_of): the messages placed on no job that could be this job''s, nearly always because the customer has several jobs, each marked job not certain, newest first; the key is there only when the job has any (a job with none reads exactly as before) and never in the records-only read. They are shown, never counted as this job''s messages, never cited by a note, and their placement is not changed. Earlier (story settled notes) meta also carries call_transcripts: each call log on the job whose transcript is on the job by p_as_of (linked, landed by then; the transcript''s payload.ghl_call_id or key ghltx:<id> names the call''s ghl:<id>), call row id to transcript id, which the assembler reads to leave out an event written from the call log alone. Earlier (lead cutoff) the record part also carries lead (context_lead_monitored_jobs for the job as of p_as_of: monitored, state, quote_sent_at, customer_at, cutoff_at), which the assembler reads. Earlier: job-story-v1 for one job: now line, money, loops, checks, timeline, phase notes, agreements, events, who, last exchange, handling, not known, changes since p_since, meta. Record parts from the job record layer, the live ledger generation (or p_generation_id in any status), every line cited. p_record_only: the records alone (the ledger is not read: meta.ledger.status omitted, no not_known line about the reader, no ledger item, attachment or words anywhere), for the reader''s own prompt; RPC only, never a door parameter. NULL for an unknown job. Service role only. Story card causes (20261014120000): the known uninvoiced balance is explicitly held while R8 says not_due. Held notes (20261015100000): the story''s loops, agreements, events, settled and disputed entries for an item a held message still holds up carry job_certain false and certainty job_not_certain (context_job_story_held_marks); a story with none is unchanged.';

-- 13. Access: service role only (CREATE OR REPLACE keeps a replaced function's grants; said again).
REVOKE ALL ON FUNCTION public.context_held_notes_on() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_held_placed_copy(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_held_citable(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_held_cite(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_item_held_now(uuid, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story_held_marks(jsonb, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_items_held_stamp() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_check_item(uuid, jsonb, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_judge(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story_ledger(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_packet(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story(uuid, timestamptz, uuid, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_held_notes_on() TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_held_placed_copy(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_held_citable(uuid, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_held_cite(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_item_held_now(uuid, jsonb, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story_held_marks(jsonb, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_check_item(uuid, jsonb, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_judge(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story_ledger(uuid, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_packet(uuid, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story(uuid, timestamptz, uuid, timestamptz, boolean) TO service_role;
