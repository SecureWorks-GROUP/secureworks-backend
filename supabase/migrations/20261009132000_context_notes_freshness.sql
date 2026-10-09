-- Notes freshness (9 Oct 2026): the go-live sweep never switches a job's notes on while newer
-- messages sit unread, a reading with unread messages is read first, and the story card counts
-- what the notes have not read by the same one rule.
--
-- Why. The 9 Oct accuracy audit found readings switched on while newer calls and messages sat
-- unread. SWF-261459's reading had read the job to 09:16 Perth on 8 Oct; the customer's call at
-- 15:24 (its transcript landed at 15:46) was never read, the 9 Oct sweep (context_ledger_promote_shadow)
-- put the reading live at 08:56 the next morning, and its update was still waiting at 13:00: the due
-- list serves the newest evidence first, so busier jobs kept taking the turn. SWB-26073's reading
-- went live in the same sweep with 12 rows it had not read (a document read on 8 Oct and 11 emails
-- from July loaded later that day). SWP-261405's update failed its checks at 10:15 Perth on 9 Oct; a
-- call at 10:44 and its transcript landed after it and waited out the 2-hour backoff, so four of its
-- notes stayed open that the call had closed.
--
-- What it does:
--  1. context_ledger_row_unread(landed_at, automated, evidence_until): the one rule for a row a
--     reading has not read: a row of the store's evidence that is not automated (a workflow text, a
--     crew or staff template) and landed after the reading's evidence_until. Landing covers a row
--     whose own time is earlier (a late call transcript, a late-captured email, a backfilled text),
--     as the judge already reads new evidence. Callers leave copies out of their counts. Inlinable.
--  2. The go-live sweep (context_ledger_promote_shadow) never promotes a shadow with such a row:
--     skipped unread_rows, in the scan and again under the row locks. On a job with no live reading
--     that shadow is the job's current reading, so the judge asks for its update and finish promotes
--     it on that update once its checks pass (the store's existing path).
--  3. The judge (context_ledger_judge):
--     a. an update is not held by the backoff of failed reads for such a row that landed after the
--        last failed read ended (a read that lost its building lease still holds the job 2 hours);
--        backfills and rebuilds back off as before;
--     b. a rebuild of a live reading (moved citation, changed reader) is answered only by the reading
--        the sweep would promote: the job's newest shadow, newer than the live one, by the current
--        reader, passing, with no row it has not read. A shadow beside a live reading is never
--        updated, so one held back by (2) would otherwise hold the live reading's rebuild for ever.
--  4. The due list (context_ledger_due): within a priority the updates come first, and within each
--     group the job whose reading has waited longest for a row it has not read (the earliest landing
--     of one), then the rest newest evidence first. The priorities are the judge's, unchanged.
--     Updates first so a rebuild the worker skips once read that day never pushes them out of the
--     50-row page it asks for.
--  5. The story's ledger read (context_job_story_ledger): unread_rows and unread_ids read the rule (1),
--     so meta.ledger.unread_rows, meta.ledger.stale and the card's not-known line ("N newer messages
--     on this job have not been read by the reader yet.") count what the judge and the sweep count;
--     an automated message alone never makes the notes stale.
--
-- Not changed: context_ledger_finish (open PR #999 owns its pass line). Its auto-promote stays: a
-- build or an update reads every row that landed by its claim, so only a row that landed while it
-- ran can be unread when it finishes. It goes live and (3a, 4) has the job read again first. Holding
-- it back instead would leave the job with no notes, or with older notes that missed the same rows,
-- and a shadow held beside a live reading is never updated (the store updates the current reading,
-- the live one), so its rebuild would be asked for again and again. Also unchanged: the assembler
-- (the not-known line already exists), the evidence rows, the claim, the packet, promote, the
-- scorecard and every other function. No row, flag or setting is written; nothing is promoted or
-- demoted by this migration.
--
-- Read only on production (9 Oct 2026, 12:50 to 13:20 Perth):
--  - 448 live readings; 25 have rows they have not read by the rule (151 rows), 16 of them rows that
--    had landed before the 9 Oct sweeps put them live (SWF-261459 and SWB-26073 among them;
--    SWP-261405's two landed after its failed update).
--  - The new judge, run on all 865 live jobs, answers as the live one does on all but one:
--    SWF-261536, an update held by the backoff for a message that came after its failed read, is
--    due at once. (3b) changes no answer today.
--  - The due order (63 due): SWF-261459 moves from 19th to 3rd, behind two more updates that had
--    waited since 8 Oct 15:29 Perth; the extra read of the due jobs' evidence takes about 0.5 s on
--    top of the judgement's 5 s.
--  - A sweep now would put 6 shadows live and hold 14 for unread rows, each on a job with no live
--    reading (its current reading, so the judge asks for its update).
--
-- Replaced bodies (each guarded on its live production md5): context_ledger_judge (the 20261007010000
--   body), context_ledger_due and context_ledger_promote_shadow (the 20261006013000 bodies),
--   context_job_story_ledger (the 20261006040000 body). Added: context_ledger_row_unread. Signatures,
--   volatility, owners and grants stay; comments keep their slice names first.
-- Query shape: the rule is inlined (plain SQL on a row's columns). The judge reads each live reading's
--   newest shadow by job (one row) and reads a job's evidence in full also where that shadow may not
--   have read a row; the due list reads the due jobs' evidence once more; the sweep reads its
--   candidates' evidence once in the scan and once per job under the locks.
-- Rollback: supabase/rollbacks/20261009132000_context_notes_freshness_down.sql (the four bodies and
--   comments word for word; the rule dropped; no row touched).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[] := '{}'; live text; x record; f text; res text;
BEGIN
 -- The four replaced bodies: the ones production runs, or this migration's (re-apply).
 FOR x IN SELECT * FROM (VALUES
  ('public.context_ledger_judge(uuid[])', ARRAY['eb359d521397c8be161bfef6421a35c9', 'e0809f08f49e10d500464b2c57e60461']),
  ('public.context_ledger_due(integer)', ARRAY['b546910aafd7eed12660049e363cd587', '306bab3434fca5b6ced5f1d040f5cad1']),
  ('public.context_ledger_promote_shadow(text,uuid[],integer)', ARRAY['b79bea76d5ee2c72670ef7d950beaeb1', 'f3a73161410c6da869af7652235d43c5']),
  ('public.context_job_story_ledger(uuid,uuid,timestamptz)', ARRAY['273c0612f9778905c18e86878402898f', 'b27d9f6c0abdd7174f38b0ed5e1ac5f0'])
 ) AS v(sig, accepted) LOOP
  live := NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY(x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 -- Read, never replaced: these must exist with these signatures.
 FOREACH f IN ARRAY ARRAY['public.context_ledger_evidence_rows(uuid[],timestamptz)', 'public.context_ledger_current_generation(uuid)',
  'public.context_ledger_checks_pass(jsonb)', 'public.context_ledger_failures(uuid[])', 'public.context_ledger_promote(uuid,text)',
  'public.context_ledger_row_admissible(public.business_events)', 'public.context_ledger_mail_copies(uuid[])',
  'public.context_ledger_backfill_open(smallint,smallint,timestamptz)', 'public.context_lead_monitored_jobs(uuid[],timestamptz)',
  'public.context_event_source_admissible(public.business_events)', 'public.context_job_record_crm_time(text,text,text,uuid)',
  'public.context_linked_status(text)', 'public.automation_lane_enabled(text)'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 -- The rule reads two columns of the evidence: landed_at and automated.
 res := coalesce(pg_get_function_result(to_regprocedure('public.context_ledger_evidence_rows(uuid[],timestamptz)')), '');
 IF position('landed_at timestamp with time zone' IN res) = 0 OR position('automated boolean' IN res) = 0
    OR position('copy_of uuid' IN res) = 0 THEN
  problems := problems || 'context_ledger_evidence_rows no longer returns landed_at, automated and copy_of'::text;
 END IF;
 -- New object: absent, or this migration's (comment marker).
 FOR x IN SELECT p.oid::regprocedure::text AS sig, coalesce(obj_description(p.oid, 'pg_proc'), '') AS c
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'context_ledger_row_unread' LOOP
  IF x.c NOT LIKE 'Notes freshness (20261009132000)%' THEN
   problems := problems || format('%s exists and is not this migration''s', x.sig);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_notes_freshness_preimage_mismatch: %; read the live definitions before replacing them',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The one rule for a row a reading has not read: not automated, landed after the reading's
-- evidence_until (or the reading has none). Plain SQL on a row's own columns, no SET and not a definer,
-- so it is inlined wherever it is read; its one operator is schema-qualified.
CREATE OR REPLACE FUNCTION public.context_ledger_row_unread(p_landed_at timestamptz, p_automated boolean, p_until timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT NOT coalesce(p_automated, false) AND (p_until IS NULL OR p_landed_at OPERATOR(pg_catalog.>) p_until)
$$;
COMMENT ON FUNCTION public.context_ledger_row_unread(timestamptz, boolean, timestamptz) IS
 'Notes freshness (20261009132000): the ledger''s one rule for a row a reading has not read: a row of the store''s evidence (context_ledger_evidence_rows) that is not automated (its automated column: a workflow text, a crew or staff template) and landed (landed_at) after the reading''s evidence_until, or any such row when the reading has no evidence_until. Landing covers a row whose own time is earlier: a late call transcript, an email captured or placed late, a backfilled text. Callers leave copies (copy_of) out of their counts. Read by the judge (an update is never held by the backoff of failed reads for such a row that landed after the last of them; a waiting shadow answers a rebuild only with none), the due order (the longest wait first), the go-live sweep (never promotes a reading with one) and the story''s ledger read (unread_rows and unread_ids, so meta.ledger.stale and the not-known line). Inlinable: plain SQL, no SET, not a definer, operators schema-qualified. Service role only.';

-- 2. The judge: the 20261007010000 body (lead cutoff) with the waiting shadow, the unread rows by the
-- rule, the answer only by a shadow the sweep can promote, and no backoff for an update of a row that
-- landed after the last failed read (each marked "notes freshness").
CREATE OR REPLACE FUNCTION public.context_ledger_judge(p_job_ids uuid[])
RETURNS TABLE(job_id uuid, due boolean, kind text, reason text, priority integer, newest_evidence_at timestamptz,
 evidence_rows integer, generation_id uuid, blocked_reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH s AS (
  SELECT coalesce((SELECT st.mode FROM public.context_ledger_settings st WHERE st.id), 'off') AS mode,
   (SELECT st.reader FROM public.context_ledger_settings st WHERE st.id) AS reader,
   (SELECT st.job_ids FROM public.context_ledger_settings st WHERE st.id) AS job_ids,
   public.automation_lane_enabled('extraction') AS lane,
   public.context_ledger_backfill_open((SELECT st.backfill_from_hour FROM public.context_ledger_settings st WHERE st.id),
    (SELECT st.backfill_to_hour FROM public.context_ledger_settings st WHERE st.id), now()) AS window_open
 ), j AS (
  SELECT jb.id, jb.status::text NOT IN ('cancelled','draft','archived','complete','completed','lost') AS live_job,
   coalesce(jb.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1') AS schedulable
  FROM public.jobs jb WHERE jb.id = ANY(p_job_ids)
 ), lo AS (
  -- (lead cutoff, 20261007010000) a live job that is a lead no longer followed up (still at quoted
  -- with no progress 28 days after the newer of its newest quote send and the customer's newest
  -- text, email or call, wherever it is placed: context_lead_monitored_jobs, now) is not due a
  -- read, and its evidence is never read in full for the judgement
  SELECT m.job_id FROM public.context_lead_monitored_jobs(ARRAY(SELECT j.id FROM j WHERE j.live_job), now()) m WHERE NOT m.monitored
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
 ), judged AS (
  SELECT j.id AS job_id, ev.newest, coalesce(ev.n, 0) AS n, g.id AS gid,
   CASE WHEN g.id IS NULL THEN 'never_read'
    WHEN g.status = 'shadow' AND NOT public.context_ledger_checks_pass(g.checks) THEN 'checks_failed'
    WHEN m.job_id IS NOT NULL AND a.job_id IS NULL THEN 'citation_moved'
    WHEN g.reader IS DISTINCT FROM s.reader AND a.job_id IS NULL THEN 'reader_changed'
    WHEN g.evidence_until IS NULL OR g.evidence_until < ev.newest THEN
     CASE WHEN lt.first_new_at < g.evidence_until - interval '14 days' OR lt.read_after > 150 THEN 'late_evidence'
      ELSE 'new_evidence' END END AS reason,
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
 )
 SELECT d.job_id, d.blk IS NULL AND d.reason IS NOT NULL,
  CASE WHEN d.reason IS NULL THEN NULL WHEN d.reason = 'never_read' THEN 'backfill' WHEN d.reason = 'new_evidence' THEN 'update'
   ELSE 'rebuild' END,
  d.reason,
  CASE d.reason WHEN 'citation_moved' THEN 1 WHEN 'new_evidence' THEN 1 WHEN 'late_evidence' THEN 1 WHEN 'never_read' THEN 2
   WHEN 'reader_changed' THEN 3 WHEN 'checks_failed' THEN 3 END,
  d.newest, d.n, d.gid, d.blk
 FROM (  -- backfills and rebuilds wait for the backfill hours; an update is never held, (notes
         -- freshness, 20261009132000) nor held back by the backoff of failed reads for a row that
         -- landed after the last of them ended: the reading reads it at once
  SELECT d0.*, coalesce(CASE WHEN d0.blocked = 'backoff' AND d0.reason = 'new_evidence' AND d0.fresh THEN NULL ELSE d0.blocked END,
                        CASE WHEN NOT s.window_open AND d0.reason IS NOT NULL AND d0.reason <> 'new_evidence'
                             THEN 'outside_window' END) AS blk
  FROM judged d0 CROSS JOIN s) d
$$;
COMMENT ON FUNCTION public.context_ledger_judge(uuid[]) IS
 'Context ledger store (20261006013000), story safety (20261006040000): (notes freshness, 20261009132000) a row a reading has not read is the ledger''s one rule (context_ledger_row_unread: a row of the evidence that is not automated and landed after the reading''s evidence_until, copies left out; landing covers a row whose own time is earlier, such as a late call transcript, a late-captured email or a backfilled text). An update is never held by the backoff of failed reads for such a row that landed after the last failed read ended (a read that lost its building lease in the last 2 hours still holds the job; a backfill or rebuild backs off as before). A rebuild of a live reading (moved citation, changed reader) is answered only by the reading the go-live sweep would promote: the job''s newest shadow, newer than the live one, by the current reader, passing its checks, with no row it has not read; the sweep never promotes one with such a row and a shadow beside a live reading is never updated, so such a one answers nothing. Earlier (lead cutoff, 20261007010000) blocked lead_not_monitored: a live job that is a lead no longer followed up (context_lead_monitored_jobs as of now: still at quoted with no acceptance, Xero invoice or bill, booking or later status 28 days after the newer of its newest quote send and the customer''s newest text, email or call, wherever it is placed) is never due a read, so context_ledger_due never lists it and a claim answers not_due; its evidence is not read in full. It is due again the moment it progresses or the customer writes. Earlier (eighth review) citation_moved also takes an item whose citation the citation check refuses now, as the story''s ledger read re-checks it: a CRM text loaded from the cache whose CRM time is not kept or is more than 30 days before the job was created, and an old-inbox mail now placed on another job (or from the client''s address on no job while the client has another job, or from before the job''s lead window), not worded, spam, a newsletter or an auto-reply, or with a saved copy on this job or another live job (the judge''s live set); a mail''s copies time it from when one left a live job (context_ledger_mail_copies). Earlier: a legacy mail whose saved copy sits on another job or on no job counts from when it can have joined the job''s evidence (context_ledger_mail_copies: no earlier than that rule''s first apply and the copy''s own landing), in the quick read (for a job with a reading) as in the full one, so a reading built before then is never taken to have read it and the job is due; (seventh review) one whose copy sits on another live job is not this job''s evidence at all: the full read leaves it out, and the quick read, a superset, may only overstate by it and then reads the job in full; a never-read job''s quick read is as before, except that a never-read job whose admitted rows are all CRM texts loaded from the cache (source ghl_sms_cache_backfill) is read in full, since the evidence leaves out one dated before the job''s lead window and so may hold none (then it is no_evidence, never a backfill of nothing). Earlier: the one ledger due judgement per job (the full evidence read only for a job whose reading may have newer evidence or whose only possible evidence is legacy mail; elsewhere a count and newest landed time of the admitted rows decide the same; evidence_rows is then that count): kind backfill (never_read), update (new_evidence: the current generation''s evidence_until is older than the newest admissible evidence), or rebuild (checks_failed: the current reading is a shadow whose checks.passed is false; citation_moved: an item cites a business_events row now gone, off the job or not admissible; reader_changed; late_evidence: the earliest unread row is more than 14 days older than evidence_until, or more than 150 already-read rows follow it). A rebuild of the live reading for a moved citation or a changed reader is not due while a newer passing shadow by the current reader waits for promotion. Blocked: ledger_off, lane_off, not_in_rollout (settings.job_ids is set and does not list the job), not_live, holding_job, no_evidence, busy (a live building generation or a running ledger run), needs_person (three builds in a row failed their checks: context_ledger_failures), backoff (consecutive failed or check-failed runs: 2 hours, 8 hours, the next Perth day, then 7 days; or a building generation that lost its lease in the last 2 hours), outside_window (a backfill or rebuild outside the settings backfill hours; an update is never held). A person-locked item is never a moved citation (a rebuild would carry it back). Service role only.';

-- 3. The due list: the 20261006013000 body with the longest wait for an unread row first within a
-- priority (marked "notes freshness").
CREATE OR REPLACE FUNCTION public.context_ledger_due(p_limit integer DEFAULT 20)
RETURNS TABLE(job_id uuid, kind text, reason text, priority integer, newest_evidence_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH st AS (SELECT x.mode, x.job_ids FROM public.context_ledger_settings x WHERE x.id),
 d AS MATERIALIZED (
  SELECT jd.job_id, jd.kind, jd.reason, jd.priority, jd.newest_evidence_at, jd.generation_id
  FROM public.context_ledger_judge(ARRAY(
    -- only jobs the judgement could find due: live, the lane on, in the rollout list
    SELECT jb.id FROM public.jobs jb, st
    WHERE jb.status::text NOT IN ('cancelled','draft','archived','complete','completed','lost')
     AND st.mode <> 'off' AND public.automation_lane_enabled('extraction')
     AND (st.job_ids IS NULL OR jb.id = ANY(st.job_ids)))) jd
  WHERE jd.due
 ), w AS (
  -- (notes freshness, 20261009132000) since when each due job's reading has not read a row by the
  -- ledger's one rule (context_ledger_row_unread; copies left out): the earliest landing of one
  SELECT r.job_id, min(r.landed_at) AS since
  FROM public.context_ledger_evidence_rows(ARRAY(SELECT d.job_id FROM d WHERE d.generation_id IS NOT NULL), now()) r
  JOIN d ON d.job_id = r.job_id JOIN public.context_ledger_generations g ON g.id = d.generation_id
  WHERE r.copy_of IS NULL AND public.context_ledger_row_unread(r.landed_at, r.automated, g.evidence_until)
  GROUP BY r.job_id
 )
 SELECT d.job_id, d.kind, d.reason, d.priority, d.newest_evidence_at
 FROM d LEFT JOIN w ON w.job_id = d.job_id
 -- within a priority the updates first (cheap, never held by the backfill hours, and what keeps a
 -- reading current; a rebuild a reader skips once read that day never pushes them out of a capped
 -- page), each by the longest wait for a row it has not read, so a busy job's newest messages never
 -- keep an older one waiting; then the rest newest evidence first
 ORDER BY d.priority, d.kind IS DISTINCT FROM 'update', w.since NULLS LAST, d.newest_evidence_at DESC NULLS LAST, d.job_id
 LIMIT greatest(0, least(coalesce(p_limit, 20), 200))
$$;
COMMENT ON FUNCTION public.context_ledger_due(integer) IS
 'Context ledger store (20261006013000): (notes freshness, 20261009132000) within a priority the updates come first, then the rest, and within each the job whose reading has waited longest for a row it has not read by the ledger''s one rule (context_ledger_row_unread: not automated, landed after its evidence_until; copies left out) comes first, by the earliest landing of one, so a busy job''s newest messages never keep an older one waiting and a rebuild a reader skips once read that day never pushes an update out of a capped page; then the rest newest evidence first. The priorities are the judge''s, unchanged. Earlier: live jobs due a ledger read now (context_ledger_judge), new evidence and moved citations first, then never-read jobs newest evidence first, then reader changes. At most 200. Empty while context_ledger_settings.mode is off or the extraction lane is off; only jobs on settings.job_ids when that rollout list is set. Service role only.';

-- 4. The go-live sweep: the 20261006013000 body; a shadow with a row it has not read stays shadow,
-- judged in the scan and again under the row locks (marked "notes freshness").
CREATE OR REPLACE FUNCTION public.context_ledger_promote_shadow(p_by text, p_job_ids uuid[] DEFAULT NULL, p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_mode text; v_list uuid[]; v_limit integer := coalesce(p_limit, 200); x record; g public.context_ledger_generations;
 lv public.context_ledger_generations; v jsonb; v_reason text; promoted jsonb := '[]'::jsonb; skipped jsonb := '[]'::jsonb;
 v_eligible integer := 0; v_tried integer := 0;
BEGIN
 IF p_by IS NULL OR p_by !~ '^(person|rule):.{1,80}$'
  OR (p_by LIKE 'person:%' AND p_by !~ '^person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  OR v_limit NOT BETWEEN 1 AND 1000 OR cardinality(p_job_ids) > 1000 THEN
  RAISE EXCEPTION 'context_ledger_promote_shadow_invalid';
 END IF;
 IF p_by LIKE 'person:%' AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = substr(p_by, 8)::uuid
   AND lower(coalesce(u.role, '')) IN ('admin', 'owner', 'ops_manager')) THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'not_staff');
 END IF;
 SELECT st.mode, st.job_ids INTO v_mode, v_list FROM public.context_ledger_settings st WHERE st.id;
 IF v_mode IS DISTINCT FROM 'live' THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'not_live', 'mode', coalesce(v_mode, 'off'));
 END IF;
 FOR x IN
  WITH sh AS (  -- each job's newest shadow
   SELECT DISTINCT ON (s.job_id) s.id, s.job_id, s.checks, s.created_at, s.evidence_until
   FROM public.context_ledger_generations s
   WHERE s.status = 'shadow' AND (p_job_ids IS NULL OR s.job_id = ANY(p_job_ids))
   ORDER BY s.job_id, s.created_at DESC, s.id DESC
  ), c AS (
   SELECT sh.job_id, sh.id AS generation_id, sh.created_at, sh.evidence_until,
    CASE WHEN v_list IS NOT NULL AND NOT (sh.job_id = ANY(v_list)) THEN 'not_in_rollout'
         WHEN l.id IS NOT NULL AND l.created_at >= sh.created_at THEN 'older_than_live'
         WHEN NOT public.context_ledger_checks_pass(sh.checks) THEN 'checks_failed' END AS skip
   FROM sh LEFT JOIN public.context_ledger_generations l ON l.job_id = sh.job_id AND l.status = 'live'
  ), u AS (
   -- (notes freshness, 20261009132000) a candidate with a row it has not read by the ledger's one
   -- rule (context_ledger_row_unread; copies left out) stays shadow: its update reads it first
   SELECT DISTINCT r.job_id
   FROM public.context_ledger_evidence_rows(ARRAY(SELECT c.job_id FROM c WHERE c.skip IS NULL), now()) r
   JOIN c ON c.job_id = r.job_id
   WHERE r.copy_of IS NULL AND public.context_ledger_row_unread(r.landed_at, r.automated, c.evidence_until)
  )
  SELECT c.job_id, c.generation_id, c.created_at, coalesce(c.skip, CASE WHEN u.job_id IS NOT NULL THEN 'unread_rows' END) AS skip
  FROM c LEFT JOIN u ON u.job_id = c.job_id
  UNION ALL
  SELECT DISTINCT r.job_id, NULL::uuid, NULL::timestamptz, 'no_shadow'
  FROM unnest(p_job_ids) AS r(job_id)
  WHERE r.job_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.context_ledger_generations s WHERE s.job_id = r.job_id AND s.status = 'shadow')
  ORDER BY 4 NULLS FIRST, 3, 2, 1
 LOOP
  v_reason := x.skip;
  IF v_reason IS NULL THEN
   v_eligible := v_eligible + 1;
   IF v_tried >= v_limit THEN CONTINUE; END IF;
   v_tried := v_tried + 1;
   -- Judge again under the row locks finish and promote take, so a reading
   -- that changed since the scan is never promoted on a stale answer.
   SELECT * INTO g FROM public.context_ledger_generations WHERE id = x.generation_id FOR UPDATE;
   SELECT * INTO lv FROM public.context_ledger_generations WHERE job_id = x.job_id AND status = 'live' FOR UPDATE;
   v_reason := CASE WHEN g.status IS DISTINCT FROM 'shadow' THEN 'not_shadow'
                    WHEN lv.id IS NOT NULL AND lv.created_at >= g.created_at THEN 'older_than_live'
                    WHEN NOT public.context_ledger_checks_pass(g.checks) THEN 'checks_failed'
                    -- (notes freshness, 20261009132000) nor with a row landed since that it has not read
                    WHEN EXISTS (SELECT 1 FROM public.context_ledger_evidence_rows(ARRAY[x.job_id], now()) r
                                 WHERE r.copy_of IS NULL AND public.context_ledger_row_unread(r.landed_at, r.automated, g.evidence_until))
                     THEN 'unread_rows' END;
   IF v_reason IS NULL THEN
    v := public.context_ledger_promote(g.id, p_by);
    IF v ->> 'outcome' = 'promoted' AND NOT coalesce((v ->> 'already')::boolean, false) THEN
     promoted := promoted || jsonb_build_array(jsonb_build_object('job_id', x.job_id, 'generation_id', g.id,
      'retired_generation_id', v -> 'retired_generation_id', 'carried', coalesce((v ->> 'carried')::integer, 0)));
     CONTINUE;
    END IF;
    v_reason := coalesce(v ->> 'reason', 'not_shadow');
   END IF;
  END IF;
  skipped := skipped || jsonb_build_array(jsonb_build_object('job_id', x.job_id, 'generation_id', x.generation_id, 'reason', v_reason));
 END LOOP;
 RETURN jsonb_build_object('outcome', 'done', 'mode', v_mode, 'by', p_by, 'limit', v_limit,
  'promoted', jsonb_array_length(promoted), 'skipped', jsonb_array_length(skipped), 'remaining', v_eligible - v_tried,
  'skipped_reasons', coalesce((SELECT jsonb_object_agg(z.reason, z.n) FROM (SELECT k ->> 'reason' AS reason, count(*) AS n
    FROM jsonb_array_elements(skipped) k GROUP BY 1) z), '{}'::jsonb),
  'promoted_generations', promoted, 'skipped_generations', skipped);
END $$;
COMMENT ON FUNCTION public.context_ledger_promote_shadow(text, uuid[], integer) IS
 'Context ledger store (20261006013000): (notes freshness, 20261009132000) a shadow with a row it has not read by the ledger''s one rule (context_ledger_row_unread: a row of the evidence that is not automated and landed after its evidence_until; copies left out) is never promoted: skipped unread_rows, judged in the scan and again under the row locks. On a job with no live reading that shadow is the job''s current reading, so the judge asks for its update and finish promotes it on that update once its checks pass; beside a live reading it answers no rebuild of the live one (the judge). Earlier: bulk go-live. Only while context_ledger_settings.mode is live (else refused not_live). For each job with a shadow generation (all, or only p_job_ids), its newest shadow is promoted through context_ledger_promote when context_ledger_checks_pass (the rule finish uses) holds; skipped with a reason otherwise: checks_failed, older_than_live (the job''s live generation is as new or newer), not_in_rollout (settings.job_ids is set and does not list the job), no_shadow (a listed job with no shadow), not_shadow (changed under the scan). Each candidate is judged again under row locks. p_by is person:<user id> (an active staff user, else refused not_staff) or rule:<name>, 1 to 80 characters after the prefix. At most p_limit (1 to 1000) promotions per call; remaining counts the eligible rest. Returns counts, reasons and ids, never message text. Service role only.';

-- 5. The story's ledger read: the 20261006040000 body; what the shown reading has not read is the
-- rule's (marked "notes freshness").
CREATE OR REPLACE FUNCTION public.context_job_story_ledger(p_job_id uuid, p_generation_id uuid DEFAULT NULL, p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
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
                       END,
            'customer', (e.metadata->'party_roles'->>'sender_role' = 'customer')))
    FROM jsonb_array_elements(i.opened_by || CASE WHEN i.closed_at <= p_as_of THEN coalesce(i.closed_by, '[]'::jsonb) ELSE '[]'::jsonb END) c
    LEFT JOIN public.business_events e ON c->>'table' = 'business_events'
     AND e.id = CASE WHEN c->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (c->>'id')::uuid END
    LEFT JOIN LATERAL (SELECT CASE WHEN e.source = 'ghl_sms_cache_backfill'
                                   THEN public.context_job_record_crm_time(e.source, e.contact_id,
                                          coalesce(nullif(btrim(e.payload ->> 'ghl_message_id'), ''), substring(e.provider_message_id FROM '^ghl:(.+)$')), e.job_id)
                              END AS crm_at) ct ON true
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
              'from_role', it.from_role, 'from_name', it.from_name, 'to_role', it.to_role, 'to_name', it.to_name, 'what', it.what,
              'about_key', it.about_key, 'modality', it.modality, 'phase', it.phase, 'due_date', it.due_date, 'opened_at', it.opened_at,
              'opened_by', it.opened_by,
              'closed_at', CASE WHEN it.closed_at <= p_as_of AND it.status_then IN ('closed', 'declined', 'superseded') THEN it.closed_at END,
              'closed_by', CASE WHEN it.closed_at <= p_as_of AND it.status_then IN ('closed', 'declined', 'superseded') THEN it.closed_by END,
              'closes_on', it.closes_on,
              'supersedes_key', it.supersedes_key, 'blocks', it.blocks, 'needs_reply', it.needs_reply, 'written_by', it.written_by,
              'person_locked', it.person_locked, 'cited', it.cited,
              'cites_ok', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(it.cited, '[]'::jsonb)) c WHERE NOT (c->>'ok')::boolean))
              ORDER BY it.opened_at, it.item_key COLLATE "C") FROM it), '[]'::jsonb),
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
$fn$;
COMMENT ON FUNCTION public.context_job_story_ledger(uuid, uuid, timestamptz) IS
 'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000): (notes freshness, 20261009132000) unread_rows and unread_ids read the ledger''s one rule (context_ledger_row_unread), as the judge, the due order and the go-live sweep do: a row of the store''s evidence that is not automated (a workflow text, a crew or staff template) and landed after the shown generation''s evidence_until, so an automated message alone never makes meta.ledger.stale true or puts the not-known line about newer messages on the card, and every other row the notes have not read does. Earlier (eighth review) each stored citation is re-checked by the citation check''s current rules (context_ledger_cite), so an item citing a row that is no longer this job''s evidence carries cites_ok false (the story hides it and asks for a rebuild; the judge raises citation_moved): a business_events row also needs, when it is a CRM text loaded from the cache (ghl_sms_cache_backfill), its CRM time kept and not more than 30 days before the job was created; an inbox_events mail must be placed on this job, or come from the client''s address on no job (the client with no other job, from 30 days before the job on), be worded, not spam, a newsletter or an auto-reply, with no saved copy on this job or on another live job (the judge''s live set: never archived, complete, completed, cancelled, lost, a draft or holding) by its source pointer, graph key or payload pointer, and no email on this job from its sender at its instant; and the check is never unknown (a cited row moved to no job, or with no attribution status, read as passing when the check came out null, is not this job''s evidence either, as the judge already said). Earlier, story fixes: items tie on opened_at by item_key in C (byte) order. Earlier: the ledger generation the story shows (the one live at p_as_of, or the one asked for in any status) with the items written by p_as_of, each at its status then, and the transitions by then; every business_events citation is re-checked (still on this job, linked, not retracted) and the item carries cites_ok. unread_rows: the store''s evidence (context_ledger_evidence_rows as of p_as_of, copies not counted) that landed after the shown generation''s evidence_until, so the story says how far its own reader has read; unread_ids: those rows and their copies by id; read_ids: the inbound evidence rows it has read (landed by its evidence_until), so a customer message is called judged only when the reader read it; all three null when no generation is shown. With no generation to show, status says building or shadow when one exists, else none. Service role only.';

-- 6. Access: service role only (CREATE OR REPLACE keeps a replaced function's grants; said again).
REVOKE ALL ON FUNCTION public.context_ledger_row_unread(timestamptz, boolean, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_judge(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_due(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_ledger_promote_shadow(text, uuid[], integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story_ledger(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_row_unread(timestamptz, boolean, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_judge(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_due(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_ledger_promote_shadow(text, uuid[], integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story_ledger(uuid, uuid, timestamptz) TO service_role;
