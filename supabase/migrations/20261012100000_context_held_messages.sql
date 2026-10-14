-- Held messages (12 Oct 2026): a message placed on no job is read on every job it could belong to,
-- marked job not certain.
--
-- Why. Decision D10 of the context state board (12 Oct): "When a customer has several jobs, what
-- happens to a message that fits more than one? Today it is held on no job and no story reads it
-- ... Recommend: read it on every job it could belong to, marked 'from this customer, job not
-- certain'. Nothing is unread and nothing is filed wrongly." The placement ladder leaves such a
-- row unplaced (job_id null, attribution_status unplaced or pending_luna) and stores the jobs it
-- could be in candidate_job_ids. That is right and stays: putting it on one job would plant that
-- job's promise in the other job's story. The cost was that nothing downstream read it. The
-- reader's packet took only rows placed on the job (context_ledger_evidence_rows), and the story
-- counted them (meta.unplaced) without showing a word.
--
-- Read only on production (12 Oct 2026, about 10:00 Perth): 1,375 rows on no job; 1,359 carry at
-- least one candidate job (1,275 two or more, 84 one) and 16 none. Of the 1,359, 1,242 are worded
-- messages a reader can read (74 are make-safe reconcile rows, not messages; 43 are status-only).
-- They reach 306 distinct jobs in 3,141 message-and-job pairs; the most on one job is 83. The
-- candidate lookup is answered by the existing index business_events_candidate_job_ids (gin, on
-- candidate_job_ids), the one context_unplaced_for_job already reads.
--
-- What it does. No table, column, index, flag, setting or row is written, and no row is placed.
--  1. context_ledger_held_rows(jobs, as_of) (new): for each job, the rows on no job (unplaced or
--     pending_luna) whose candidate_job_ids contain it, admitted as evidence rows are apart from
--     placement: written as service_role, worded, a message kind, not status-only, timed, never
--     retracted, never a marked copy; a CRM text loaded later from the CRM's cache is at the
--     CRM's own time, and one dated more than 30 days before the job was created, or whose CRM
--     time is no longer kept, is left out (the evidence rows' own rule). Each row with the rule
--     that held it, how many jobs it could belong to, the other candidates' job numbers, and
--     whether it is this job's customer's (the row's CRM contact is the job's, or its sender
--     address the job's client email).
--  2. context_ledger_packet: one field added, held (still ledger-packet-v1): those rows for the
--     reader as context, marked job not certain. They are not evidence rows: not in evidence,
--     evidence_rows or evidence_until, so the judge, the unread count and the read budget are
--     untouched, a held row never makes a job due, and the citation check still refuses one
--     (citation_off_job), so no note can be written on a job from a message that may be another
--     job's.
--  3. context_job_story_held(job, as_of) (new) and context_job_story: the story carries
--     held_messages, the same rows newest first with the words each was held for, marked job not
--     certain. The key is there only when the job has any, so every other job's story is byte for
--     byte what it was, and never in the records-only read the reader's own prompt takes.
--
-- What it does not do. It does not let the reader write a note from a held message: the reader
-- (secureworks-jarvis, luna-job-ledger.ts) reads the packet field by field and drops a key it
-- does not know, so held reaches the model only once that reader reads and renders it, and the
-- citation check keeps refusing such a row whatever the reader does. Nor does it change the short
-- card (jarvis job-story-card.ts), which prints named story keys only.
--
-- Replaced bodies (each guarded on its live production md5): context_ledger_packet (20261007150000's),
--   context_job_story (20261011120000's). Added: context_ledger_held_rows, context_job_story_held.
-- Not changed: the placement ladder, context_unplaced_for_job, the evidence rows, the citation check,
--   the judge, due, claim, write, finish, the assembler, the story meta and every scorecard function.
--   Signatures, volatility, owners and grants stay; comments keep their slice name first.
-- Query shape: per job one bitmap read of business_events_candidate_job_ids (the job's id in
--   candidate_job_ids), then each held row's words; the other candidates' numbers by the jobs key.
-- Rollback: supabase/rollbacks/20261012100000_context_held_messages_down.sql (the two earlier bodies and comments word for
--   word; the two helpers dropped; no row touched).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[] := '{}'; live text; x record; f text; t text;
BEGIN
 -- The two replaced bodies: the ones production runs, or this migration's (re-apply).
 FOR x IN SELECT * FROM (VALUES
  ('public.context_ledger_packet(uuid,timestamptz,timestamptz)', ARRAY['423469bdff01ae4029c155f6c73c078d', 'b04863d6bd6f8ceaadb102532b8136a2']),
  ('public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)', ARRAY['909e3212b3d58c71d5b96f0db449d735', '72da3ec164693a91819016eace85e895'])
 ) AS v(sig, accepted) LOOP
  live := NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY(x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 -- Read, never replaced: these must exist with these signatures.
 FOREACH f IN ARRAY ARRAY['public.context_ledger_evidence_rows(uuid[],timestamptz)', 'public.context_ledger_siblings(uuid,timestamptz)',
  'public.context_ledger_row_elsewhere(uuid,text,uuid)', 'public.context_ledger_current_generation(uuid)',
  'public.context_ledger_party_keys(text[],text[],text[])', 'public.context_ledger_message_kind(public.business_events)',
  'public.context_ledger_cite(uuid,jsonb)', 'public.context_event_text(public.business_events)',
  'public.context_event_status_only(public.business_events)', 'public.context_event_is_ours(public.business_events)',
  'public.context_internal_text_role(public.business_events)', 'public.context_job_record_crm_time(text,text,text,uuid)',
  'public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)',
  'public.context_job_story_ledger(uuid,uuid,timestamptz)', 'public.context_job_story_meta(uuid,timestamptz)',
  'public.context_job_story_facts(uuid,timestamptz)', 'public.context_unplaced_for_job(uuid)'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 -- The columns the new reads take.
 FOREACH t IN ARRAY ARRAY['business_events.job_id', 'business_events.attribution_status', 'business_events.candidate_job_ids',
   'business_events.contact_id', 'business_events.metadata', 'business_events.payload', 'business_events.source',
   'business_events.provider_message_id', 'business_events.event_at', 'business_events.occurred_at',
   'business_events.recorded_at', 'business_events.context_captured_at', 'business_events.attributed_at',
   'business_events.channel', 'business_events.event_type', 'business_events.direction',
   'jobs.ghl_contact_id', 'jobs.client_email', 'jobs.client_name', 'jobs.job_number', 'jobs.created_at',
   'staff_ghl_users.ghl_user_id', 'staff_ghl_users.label'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || split_part(t, '.', 1))
    AND a.attname = split_part(t, '.', 2) AND NOT a.attisdropped) THEN
   problems := problems || format('public.%s missing', t);
  END IF;
 END LOOP;
 -- New objects: absent, or this migration's (comment marker).
 FOR x IN SELECT p.oid::regprocedure::text AS sig, coalesce(obj_description(p.oid, 'pg_proc'), '') AS c
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('context_ledger_held_rows', 'context_job_story_held') LOOP
  IF x.c NOT LIKE 'Held messages (20261012100000)%' THEN
   problems := problems || format('%s exists and is not this migration''s', x.sig);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_held_messages_preimage_mismatch: %; read the live definitions before replacing them',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The messages placed on no job that could be a job's: the ladder's own candidates, read as the
-- evidence rows are apart from placement. Nothing here places, counts or changes a row.
CREATE OR REPLACE FUNCTION public.context_ledger_held_rows(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, src_table text, src_id uuid, at timestamptz, landed_at timestamptz, channel text, kind text,
 direction text, sender_role text, recipient_role text, audience text, counterpart_role text, role_basis text,
 sender text, recipient text, ours boolean, automated boolean, subject text, body text,
 held_rule text, held_status text, candidate_jobs integer, other_jobs text[], same_contact boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH j AS (
  SELECT jb.id, nullif(btrim(jb.ghl_contact_id), '') AS contact, lower(nullif(btrim(jb.client_email), '')) AS cmail,
   nullif(btrim(jb.client_name), '') AS cname, jb.created_at
  FROM public.jobs jb WHERE jb.id = ANY(p_job_ids)
 ), h AS (
  SELECT j.id AS job_id, e.id AS src_id,
   -- a CRM text loaded later from the CRM's cache is timed by the CRM's own time, as the
   -- evidence rows time it; it landed when it was loaded
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
   -- this job's customer's: the row's CRM contact is the job's, or its sender address the job's client email
   sc.same_contact,
   CASE WHEN sc.same_contact AND e.metadata #>> '{party_roles,sender_role}' = 'customer' THEN j.cname
    ELSE coalesce((SELECT s.label FROM public.staff_ghl_users s
      WHERE s.ghl_user_id = coalesce(e.payload ->> 'sent_by_user', e.payload ->> 'by_user') LIMIT 1),
     nullif(btrim(coalesce(e.payload ->> 'from_name', e.payload ->> 'from', e.payload ->> 'from_email')), '')) END AS sender,
   CASE WHEN sc.same_contact AND e.metadata #>> '{party_roles,recipient_role}' = 'customer' THEN j.cname
    ELSE nullif(btrim(coalesce(e.payload ->> 'to_name', e.payload ->> 'to', e.payload ->> 'to_email')), '') END AS recipient,
   public.context_event_is_ours(e) AS ours,
   (coalesce(e.payload ->> 'sent_by_kind', '') = 'workflow' OR public.context_internal_text_role(e) <> 'other') AS automated,
   nullif(btrim(e.payload ->> 'subject'), '') AS subject,
   public.context_event_text(e) AS body,
   nullif(btrim(e.metadata ->> 'placement_rule'), '') AS held_rule,
   e.attribution_status AS held_status,
   cardinality(e.candidate_job_ids) AS candidate_jobs,
   ARRAY(SELECT o.job_number FROM public.jobs o
         WHERE o.id = ANY(e.candidate_job_ids) AND o.id <> j.id AND o.job_number IS NOT NULL
         ORDER BY o.job_number COLLATE "C") AS other_jobs
  FROM j JOIN public.business_events e ON e.candidate_job_ids @> ARRAY[j.id]
  CROSS JOIN LATERAL (SELECT CASE WHEN e.source = 'ghl_sms_cache_backfill'
                                  THEN public.context_job_record_crm_time(e.source, e.contact_id,
                                         coalesce(nullif(btrim(e.payload ->> 'ghl_message_id'), ''), substring(e.provider_message_id FROM '^ghl:(.+)$')), e.job_id)
                             END AS crm_at) ct
  CROSS JOIN LATERAL (SELECT coalesce((j.contact IS NOT NULL AND e.contact_id = j.contact)
                              OR (j.cmail IS NOT NULL AND lower(btrim(coalesce(substring(e.payload ->> 'from', '<([^<>]*)>'),
                                    e.payload ->> 'from', e.payload ->> 'from_email'))) = j.cmail), false) AS same_contact) sc
  -- on no job, and held by the ladder with this job among its candidates
  WHERE e.job_id IS NULL AND e.attribution_status IN ('pending_luna', 'unplaced')
   -- the evidence rows' admission apart from placement: our own writer, worded, a message,
   -- timed, never retracted, never a marked copy, never status-only
   AND coalesce(e.metadata ->> 'written_as', 'service_role') = 'service_role'
   AND btrim(public.context_event_text(e)) <> ''
   AND coalesce(e.event_at, e.occurred_at) IS NOT NULL
   AND e.metadata #>> '{retracted_at}' IS NULL
   AND (e.metadata #>> '{retracted}' IS NULL OR e.metadata #>> '{retracted}' <> 'true')
   AND e.metadata #>> '{duplicate_of}' IS NULL
   AND NOT public.context_event_status_only(e)
   AND public.context_ledger_message_kind(e)
   AND coalesce(ct.crm_at, e.event_at, e.occurred_at) <= p_as_of
   AND greatest(coalesce(e.context_captured_at, e.recorded_at, e.occurred_at), e.attributed_at) <= p_as_of
   -- the evidence rows' lead window rule for a CRM text loaded from the cache
   AND NOT coalesce(ct.crm_at < j.created_at - interval '30 days', false)
   AND NOT (e.source = 'ghl_sms_cache_backfill' AND ct.crm_at IS NULL)
 )
 SELECT h.job_id, 'business_events'::text, h.src_id, h.at, h.landed_at, h.channel, h.kind, h.direction, h.sender_role,
  h.recipient_role, h.audience, h.counterpart_role, h.role_basis, h.sender, h.recipient, h.ours, h.automated, h.subject, h.body,
  h.held_rule, h.held_status, h.candidate_jobs, h.other_jobs, h.same_contact
 FROM h
 ORDER BY h.job_id, h.at, h.src_id
$$;
COMMENT ON FUNCTION public.context_ledger_held_rows(uuid[], timestamptz) IS
 'Held messages (20261012100000): for each given job, the messages placed on no job that could be that job''s, as of an instant, oldest first: business_events rows with no job, attribution status unplaced or pending_luna, whose stored candidate_job_ids contain the job (the placement ladder''s own candidates; nearly always the customer has several jobs and the message fits more than one). Admitted as the evidence rows are apart from placement: written as service_role, worded, a message kind, not status-only, timed, never retracted, never a marked copy (metadata.duplicate_of); a CRM text loaded later from the CRM''s cache is at the CRM''s own time, and one dated more than 30 days before the job was created, or whose CRM time is no longer kept, is left out. The same row is returned once for each candidate job asked for. Each: the evidence rows'' fields (at, landed_at, channel, kind, direction, the stored role fields, sender, recipient, ours, automated, subject, body), held_rule (metadata.placement_rule, the rule that held it), held_status, candidate_jobs (how many jobs it could belong to), other_jobs (the other candidates'' job numbers, C order) and same_contact (the row''s CRM contact is the job''s, or its sender address the job''s client email: this job''s customer''s message). Nothing is placed, counted as the job''s or changed: these are never evidence rows, and context_ledger_cite still refuses one (citation_off_job). Read by context_ledger_packet (held) and context_job_story_held. Read by the index business_events_candidate_job_ids. Service role only.';

-- 2. The same rows for the story, newest first, each with the words it was held for.
CREATE OR REPLACE FUNCTION public.context_job_story_held(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
 WITH h AS (
  SELECT r.*, row_number() OVER (ORDER BY r.at DESC, r.src_id DESC) AS n
  FROM public.context_ledger_held_rows(ARRAY[p_job_id], p_as_of) r
 )
 SELECT CASE WHEN count(*) = 0 THEN NULL ELSE jsonb_build_object(
   'label', CASE WHEN bool_and(h.same_contact) THEN 'From this customer, job not certain'
                 ELSE 'May be about this job, job not certain' END,
   'certainty', 'job_not_certain',
   'count', count(*),
   'shown', count(*) FILTER (WHERE h.n <= 25),
   'newest_at', max(h.at), 'oldest_at', min(h.at),
   -- the newest the customer sent (not ours, not automated), so a waiting question is not missed
   'newest_customer_at', max(h.at) FILTER (WHERE h.same_contact AND h.direction = 'inbound' AND NOT h.ours AND NOT h.automated),
   'other_jobs', (SELECT coalesce(jsonb_agg(o.x ORDER BY o.x COLLATE "C"), '[]'::jsonb)
                  FROM (SELECT DISTINCT unnest(h2.other_jobs) AS x FROM h h2) o),
   'why', 'These messages are placed on no job, because each fits more than one job or its match was not certain. '
          || 'Each is shown on every job it could belong to. None is counted as this job''s message and no note cites one.',
   'items', jsonb_agg(jsonb_build_object(
      't', h.src_table, 'id', h.src_id, 'at', h.at, 'channel', h.channel, 'kind', h.kind, 'direction', h.direction,
      'from', h.sender, 'from_role', h.sender_role, 'ours', h.ours, 'automated', h.automated, 'subject', h.subject,
      'text', left(h.body, 400), 'cut', length(h.body) > 400,
      'job_certain', false,
      'label', CASE WHEN h.same_contact THEN 'from this customer, job not certain' ELSE 'may be about this job, job not certain' END,
      'from_this_customer', h.same_contact,
      'held_rule', h.held_rule,
      'held_because', CASE h.held_rule
        WHEN 'review_several' THEN 'the customer has several jobs'
        WHEN 'review_recent_other_job' THEN 'the customer has another recent job'
        WHEN 'review_aftercare' THEN 'it arrived after the job was finished'
        WHEN 'review_identity_conflict' THEN 'the contact details fit more than one person'
        WHEN 'site_address_several' THEN 'the address fits several jobs'
        WHEN 'site_address_loose' THEN 'the address match is not exact'
        WHEN 'multi_ref' THEN 'it names several jobs'
        ELSE 'the job is not certain' END,
      'candidate_jobs', h.candidate_jobs, 'other_jobs', to_jsonb(h.other_jobs))
      ORDER BY h.at DESC, h.src_id DESC) FILTER (WHERE h.n <= 25))
 END
 FROM h
$fn$;
COMMENT ON FUNCTION public.context_job_story_held(uuid, timestamptz) IS
 'Held messages (20261012100000): the story''s held_messages for one job as of an instant, or null when the job has none: {label, certainty job_not_certain, count, shown, newest_at, oldest_at, newest_customer_at, other_jobs, why, items} over context_ledger_held_rows (the messages placed on no job that could be this job''s). label: "From this customer, job not certain" when every one is this job''s customer''s (same_contact), else "May be about this job, job not certain". count: all of them; items: the newest 25, newest first, each {t, id, at, channel, kind, direction, from, from_role, ours, automated, subject, text (400 characters) and cut, job_certain false, label, from_this_customer, held_rule, held_because (the rule in words), candidate_jobs, other_jobs}; shown: how many items; newest_customer_at: the newest inbound one from this job''s customer that is not ours or automated; other_jobs: every other job number any of them could belong to, C order. Shown only: none is counted as the job''s message, cited by a note or placed. Read by context_job_story. Service role only.';

-- 3. The packet: held, the messages on no job that could be this job's (20261007150000's body otherwise).
CREATE OR REPLACE FUNCTION public.context_ledger_packet(p_job_id uuid, p_since timestamptz DEFAULT NULL, p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE jb record; v_job jsonb; v_parties jsonb; v_evidence jsonb; v_open jsonb; v_until timestamptz; v_rows integer;
 v_truncated integer; v_dups integer; v_as_of timestamptz; v_gen uuid; v_pe text[]; v_pp text[]; v_pc text[];
 v_held jsonb;
BEGIN
 v_as_of := coalesce(p_as_of, now());
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
   'closes_on', i.closes_on, 'opened_by', i.opened_by, 'person_locked', i.person_locked) ORDER BY i.opened_at, i.item_key COLLATE "C"), '[]'::jsonb)
 INTO v_open FROM public.context_ledger_items i
 WHERE v_gen IS NOT NULL AND i.generation_id = v_gen
  AND CASE WHEN p_since IS NOT NULL THEN i.status IN ('open', 'disputed', 'info') ELSE i.person_locked END;
 -- (held messages, 20261012100000) The messages placed on no job that could be this job's
 -- (context_ledger_held_rows: the ladder left them unplaced with this job among their candidates,
 -- nearly always because the customer has several jobs). They are context for the reader, marked
 -- job not certain: never evidence rows, never counted, never citable (the citation check still
 -- refuses them as off the job), and their placement is not read as this job's. A rebuild is given
 -- the newest 40; an update the newest 40 that landed after p_since and, when there is one, the 6
 -- newest it was given before, to read them by. Oldest first; text capped at 3,000 characters for
 -- a transcript or document text and 1,500 otherwise.
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
     'text', left(sel.body, CASE WHEN sel.kind IN ('call.transcript_completed', 'document.text_extracted') THEN 3000 ELSE 1500 END))
     ORDER BY sel.at, sel.src_id) FROM sel), '[]'::jsonb))
 INTO v_held;
 RETURN jsonb_build_object('version', 'ledger-packet-v1', 'job', v_job, 'parties', v_parties, 'evidence', v_evidence,
  'evidence_until', v_until, 'evidence_rows', v_rows, 'truncated_rows', v_truncated, 'duplicates_collapsed', v_dups,
  'since', p_since, 'as_of', v_as_of, 'open_items', v_open,
  -- (ledger reader fixes, 20261007150000) the same client's and the same work order's other jobs,
  -- with what was quoted and billed there
  'siblings', public.context_ledger_siblings(p_job_id, v_as_of),
  -- (held messages, 20261012100000) the messages on no job that could be this job's, job not certain
  'held', v_held);
END $$;
COMMENT ON FUNCTION public.context_ledger_packet(uuid, timestamptz, timestamptz) IS
 'Context ledger store (20261006013000), ledger reader fixes (20261007150000): (held messages, 20261012100000) still ledger-packet-v1, with one field added: held {certainty job_not_certain, total, new, not_shown, rows}: the messages placed on no job that could be this job''s (context_ledger_held_rows: unplaced or waiting on the placement review with this job among their stored candidates, nearly always because the customer has several jobs; worded, a message kind, never retracted, a copy or status-only), as of the packet''s as_of. Context only, marked job not certain: never evidence rows, never in evidence_rows or evidence_until, never citable (the citation check still refuses them, citation_off_job), and nothing about their placement is changed or read as this job''s. total: all of them; new: those that landed after since (all on a rebuild); rows, oldest first: a rebuild''s newest 40, or an update''s newest 40 new ones and, when there is one, the 6 newest given before (already_read true); each row as an evidence row (table, id, at, recorded_at, channel, kind, direction, the stored role fields, sender, recipient, ours, automated, subject) with placed_on none, certainty job_not_certain, from_this_customer (the row''s CRM contact is the job''s, or its sender address the job''s client email), held_rule (the placement rule that held it), candidate_jobs (how many jobs it could belong to), other_jobs (the other candidates'' job numbers, C order) and text (capped at 3,000 characters for a transcript or document text, 1,500 otherwise); not_shown: how many of total are not in rows. Earlier (ledger reader fixes) still ledger-packet-v1, with fields added: each transcript''s call_customer is true, false or the string unknown (neither its call row on this job nor its own stamp on the job''s contact decides), never a bare null; each evidence row carries elsewhere, the reason it is someone else''s (context_ledger_row_elsewhere: role_basis:<basis> when its own stamp names another job''s customer or party or a lead, call_not_customer when its call row''s on this job does, call_on_other_job, names_other_job:<number>) or null, never on the customer''s own words or a stamp naming our own people, a supplier, a builder, a council, a party on this job or nobody (second review, 8 Oct); only role_basis and call_not_customer carry an item that says a row is someone else''s (elsewhere_unsupported); and siblings (context_ledger_siblings as of the packet''s as_of): the same client''s and the same work order''s other jobs with their quotes sent and invoices issued, context only. Earlier: ledger-packet-v1, the reader''s whole view of a job except the record text: job, parties (the job client and a primary contact role customer, a neighbour role third_party labelled neighbour, others their contact_type or unknown; each with match_keys: emails, phones'' last 9 digits), evidence (context_ledger_evidence_rows without copies, oldest first, text capped at 6,000 characters for transcripts and document text and 3,000 otherwise; each row with already_read, placed_on and, on a call log, has_transcript, call_customer on transcripts), evidence_until (newest recorded time seen), evidence_rows, truncated_rows, duplicates_collapsed, open_items (each with phase, closes_on and opened_by as stored). With p_since: rows recorded after it, every already-read row after the earliest of them, and the six before it, and the current generation''s open, disputed and in-force items; without: the live generation''s person-locked items. The judge asks for a rebuild (late_evidence) instead when the earliest new row is more than 14 days older than evidence_until or more than 150 already-read rows follow it. Role fields are the stored party_roles stamp, never invented. Service role only.';

-- 4. The story read: held_messages when the job has any (20261011120000's body otherwise).
CREATE OR REPLACE FUNCTION public.context_job_story(p_job_id uuid, p_as_of timestamptz DEFAULT now(),
 p_generation_id uuid DEFAULT NULL, p_since timestamptz DEFAULT NULL, p_record_only boolean DEFAULT false)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 -- (held messages, 20261012100000) the story, and with it the messages placed on no job that could be
 -- this job's (context_job_story_held), marked job not certain: only when there are any, so a job
 -- with none reads exactly as before, and never in the records-only read
 SELECT st.story || CASE WHEN hm.held IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('held_messages', hm.held) END
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
$fn$;
COMMENT ON FUNCTION public.context_job_story(uuid, timestamptz, uuid, timestamptz, boolean) IS
 'Job story (20261006014000), lead cutoff (20261007010000): (story settled notes, 20261011120000) (held messages, 20261012100000) the story also carries held_messages (context_job_story_held as of p_as_of): the messages placed on no job that could be this job''s, nearly always because the customer has several jobs, each marked job not certain, newest first; the key is there only when the job has any (a job with none reads exactly as before) and never in the records-only read. They are shown, never counted as this job''s messages, never cited by a note, and their placement is not changed. Earlier (story settled notes) meta also carries call_transcripts: each call log on the job whose transcript is on the job by p_as_of (linked, landed by then; the transcript''s payload.ghl_call_id or key ghltx:<id> names the call''s ghl:<id>), call row id to transcript id, which the assembler reads to leave out an event written from the call log alone. Earlier (lead cutoff) the record part also carries lead (context_lead_monitored_jobs for the job as of p_as_of: monitored, state, quote_sent_at, customer_at, cutoff_at), which the assembler reads. Earlier: job-story-v1 for one job: now line, money, loops, checks, timeline, phase notes, agreements, events, who, last exchange, handling, not known, changes since p_since, meta. Record parts from the job record layer, the live ledger generation (or p_generation_id in any status), every line cited. p_record_only: the records alone (the ledger is not read: meta.ledger.status omitted, no not_known line about the reader, no ledger item, attachment or words anywhere), for the reader''s own prompt; RPC only, never a door parameter. NULL for an unknown job. Service role only.';

-- 5. Access: service role only (CREATE OR REPLACE keeps a replaced function's grants; said again).
REVOKE ALL ON FUNCTION public.context_ledger_held_rows(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story_held(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_packet(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story(uuid, timestamptz, uuid, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_held_rows(uuid[], timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story_held(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_packet(uuid, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story(uuid, timestamptz, uuid, timestamptz, boolean) TO service_role;
