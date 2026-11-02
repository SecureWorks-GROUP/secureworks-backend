-- CTX-T24 correction scheduling and review visibility; activation remains OFF.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $$ DECLARE r record; h text; BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('context_ledger_judge(uuid[])','484fbb9ba08a6167b3fc5a7f78898ecd'),
 ('context_ledger_packet(uuid,timestamp with time zone,timestamp with time zone)','e2ccc5450117a4e36b30df104752d1cd'),
 ('context_ledger_finish(uuid,uuid,uuid,text,jsonb)','1695e52f99f56534a24166f6662ced35'),
 ('context_job_story_ledger(uuid,uuid,timestamp with time zone)','6ecf46dd34fb7d8280f126c88a5bad21'),
 ('context_job_story(uuid,timestamp with time zone,uuid,timestamp with time zone,boolean)','240b50d71c6d1cd6c4266e275366bc0e')) x(sig,h) LOOP
 SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid=to_regprocedure(r.sig);
 IF h IS DISTINCT FROM r.h THEN RAISE EXCEPTION 'placement_freshness_preimage_mismatch: % %',r.sig,h; END IF;
 END LOOP;
 IF public.context_ledger_person_placement_enabled() THEN RAISE EXCEPTION 'placement_freshness_preexisting_activation'; END IF;
IF to_regprocedure('public.context_ledger_placement_state(uuid)') IS NOT NULL OR to_regprocedure('public.context_ledger_placement_review(uuid,uuid,timestamptz)') IS NOT NULL OR to_regprocedure('public.context_job_story_placement_review(jsonb,uuid,uuid,timestamptz,boolean)') IS NOT NULL THEN RAISE EXCEPTION 'placement_freshness_helper_conflict'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.context_ledger_placement_state(p_job uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rows jsonb; latest_at timestamptz;
BEGIN
 IF NOT public.context_ledger_person_placement_enabled() THEN RETURN '{"enabled":false}'::jsonb; END IF;
 WITH related AS (
  SELECT d.subject_id AS id FROM public.context_reconciliation_decisions d
  JOIN public.business_events e ON e.id=d.subject_id WHERE d.subject_kind='event' AND e.job_id=p_job
  UNION SELECT l.event_id FROM public.context_placement_links l WHERE l.job_id=p_job
  UNION SELECT (c->>'id')::uuid FROM public.context_ledger_items i
   CROSS JOIN LATERAL jsonb_array_elements(i.opened_by||coalesce(i.closed_by,'[]'::jsonb)) c
   WHERE i.job_id=p_job AND c->>'table'='business_events'
    AND c->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND EXISTS(SELECT 1 FROM public.context_reconciliation_decisions d WHERE d.subject_kind='event' AND d.subject_id=(c->>'id')::uuid)
 ), current_state AS (
  SELECT r.id,d.id AS decision_id,d.action,extract(epoch FROM d.decided_at) AS decided_at_epoch,d.job_ids,d.evidence_hash,
   public.context_recon_evidence_hash(r.id) AS current_hash,
   e.job_id,e.contact_id,e.event_type,e.source,e.source_table,e.source_id,e.provider_message_id,
   e.attribution_status,e.attribution_confidence,extract(epoch FROM e.event_at) AS event_at_epoch,extract(epoch FROM e.occurred_at) AS occurred_at_epoch,extract(epoch FROM e.recorded_at) AS recorded_at_epoch,extract(epoch FROM e.context_captured_at) AS captured_at_epoch,extract(epoch FROM e.attributed_at) AS attributed_at_epoch,
   e.metadata->'party_roles' AS party_roles,e.metadata->'retracted_at' AS retracted_at,
   e.metadata->'retracted' AS retracted,e.metadata->'duplicate_of' AS duplicate_of,e.metadata->'written_as' AS written_as,
   public.context_event_source_admissible(e) AS source_admissible
  FROM related r LEFT JOIN public.business_events e ON e.id=r.id
  LEFT JOIN LATERAL(SELECT x.* FROM public.context_reconciliation_decisions x WHERE x.subject_kind='event' AND x.subject_id=r.id ORDER BY x.id DESC LIMIT 1)d ON true
 )
 SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id),to_timestamp(max(c.decided_at_epoch)) INTO rows,latest_at FROM current_state c;
 RETURN jsonb_build_object('enabled',true,'affected',rows IS NOT NULL,
  'signature',CASE WHEN rows IS NOT NULL THEN md5(jsonb_build_object('v',1,'rows',rows,'customer_contact',(SELECT ghl_contact_id FROM public.jobs WHERE id=p_job))::text) END,
  'latest_decision_at',latest_at);
END $$;
COMMENT ON FUNCTION public.context_ledger_placement_state(uuid) IS 'CTX-T24 placement snapshot: current hash-bound decisions and intrinsic source/identity state for original, current and previous recipient jobs. Includes retained citation references so a removed source still invalidates its old job. No money or closure authority. Service role only.';
REVOKE ALL ON FUNCTION public.context_ledger_placement_state(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_placement_state(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.context_ledger_placement_review(p_job uuid,p_generation uuid DEFAULT NULL,p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('item_key',i.item_key,'what',i.what,'status',i.status,'opened_by',i.opened_by,'person_locked',i.person_locked) ORDER BY i.opened_at,i.item_key COLLATE "C"),'[]'::jsonb)
 FROM public.context_ledger_items i
 WHERE public.context_ledger_person_placement_enabled()
 AND i.job_id=p_job AND i.generation_id=coalesce(p_generation,(SELECT g.id FROM public.context_ledger_generations g WHERE g.job_id=p_job AND g.status IN ('live','retired') AND g.promoted_at<=p_as_of ORDER BY g.promoted_at DESC,g.created_at DESC LIMIT 1))
 AND i.created_at<=p_as_of AND i.status IN ('open','disputed','info')
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(i.opened_by)c WHERE c->>'table' IN ('business_events','inbox_events')
   AND NOT coalesce((public.context_ledger_cite(p_job,c)->>'ok')::boolean,false)
   AND NOT (i.job_not_certain AND coalesce((public.context_ledger_held_cite(p_job,c)->>'ok')::boolean,false)))
$$;
COMMENT ON FUNCTION public.context_ledger_placement_review(uuid,uuid,timestamptz) IS 'CTX-T24: unresolved historical notes whose opening source no longer supports this job. A review list, never closure, transfer or newly asserted debt. Service role only.';
REVOKE ALL ON FUNCTION public.context_ledger_placement_review(uuid,uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_placement_review(uuid,uuid,timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.context_job_story_placement_review(p_story jsonb,p_job uuid,p_generation uuid,p_as_of timestamptz,p_record_only boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE items jsonb; notices jsonb;
BEGIN
 IF p_story IS NULL OR coalesce(p_record_only,false) OR NOT public.context_ledger_person_placement_enabled() THEN RETURN p_story; END IF;
 items:=public.context_ledger_placement_review(p_job,p_generation,p_as_of);
 IF jsonb_array_length(items)=0 THEN RETURN p_story; END IF;
 SELECT jsonb_agg(jsonb_build_object('what','Unresolved historical note needs review: '||(x->>'what'),
  'why','Its opening source no longer supports this job. Placement correction is not settlement; the original matter remains unresolved until reviewed.',
  'item_key',x->>'item_key','cites',x->'opened_by','certainty','source_placement_review') ORDER BY x->>'item_key') INTO notices FROM jsonb_array_elements(items)x;
 RETURN jsonb_set(p_story,'{not_known}',coalesce(p_story->'not_known','[]'::jsonb)||notices)
  ||jsonb_build_object('placement_review',jsonb_build_object('state','needs_review','items',items));
END $$;
COMMENT ON FUNCTION public.context_job_story_placement_review(jsonb,uuid,uuid,timestamptz,boolean) IS 'CTX-T24: exposes unresolved source-invalid historical obligations explicitly under What we do not know; never adds them as current debt or transfers/closes them. Record-only reader input remains ledger-free.';
REVOKE ALL ON FUNCTION public.context_job_story_placement_review(jsonb,uuid,uuid,timestamptz,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_story_placement_review(jsonb,uuid,uuid,timestamptz,boolean) TO service_role;

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
 ), placement AS MATERIALIZED (
 SELECT j.id AS job_id,public.context_ledger_placement_state(j.id) AS state FROM j
 ), cbe AS (
  -- The read every judgement can afford: the admitted business_events rows
  -- exactly (count and newest landed time, no text compare, no copy grouping)...
  SELECT e.job_id, count(*)::integer AS n,
   max(greatest(coalesce(e.context_captured_at, e.recorded_at, e.occurred_at), e.attributed_at)) AS newest,
   -- (CRM texts loaded later from the CRM's cache: one from before the job's lead window
   -- is not its evidence, story safety, 20261006040000)
   (count(*) FILTER (WHERE e.source = 'ghl_sms_cache_backfill'))::integer AS bf
  FROM j JOIN (SELECT raw.* FROM public.business_events raw JOIN placement px ON px.job_id=raw.job_id WHERE NOT coalesce((px.state->>'affected')::boolean,false) UNION ALL SELECT projected.* FROM public.context_ledger_reader_events(ARRAY(SELECT px.job_id FROM placement px WHERE coalesce((px.state->>'affected')::boolean,false))) projected) e ON e.job_id = j.id
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
   AND (EXISTS(SELECT 1 FROM placement px WHERE px.job_id=j.id AND coalesce((px.state->>'affected')::boolean,false)) OR CASE WHEN g.id IS NULL THEN (coalesce(cbe.n, 0) = 0 AND coalesce(cib.n, 0) > 0)
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
  WHERE CASE WHEN public.context_ledger_person_placement_enabled() THEN
 NOT coalesce((public.context_ledger_cite(i.job_id,c.cite)->>'ok')::boolean,false)
 AND NOT (i.job_not_certain AND coalesce((public.context_ledger_held_cite(i.job_id,c.cite)->>'ok')::boolean,false))
 ELSE (c.cite ->> 'table' = 'business_events'
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
                               AND x.job_id = i.job_id), false)) END
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
    WHEN coalesce((p.state->>'affected')::boolean,false) AND coalesce(g.checks#>>'{last_update,reader,placement_signature}',g.checks#>>'{reader,placement_signature}') IS DISTINCT FROM p.state->>'signature' THEN 'placement_changed'
    WHEN m.job_id IS NOT NULL AND a.job_id IS NULL THEN 'citation_moved'
    WHEN g.reader IS DISTINCT FROM s.reader AND a.job_id IS NULL THEN 'reader_changed'
    WHEN coalesce((SELECT ff.enabled FROM public.feature_flags ff
          WHERE ff.flag_name = 'context_ledger_financial_refresh_v1'), false)
      AND coalesce(g.checks #>> '{last_update,reader,financial_signature}',
                   g.checks #>> '{reader,financial_signature}')
          IS DISTINCT FROM public.context_ledger_record_signature(j.id)
      THEN 'financial_changed'
    WHEN g.evidence_until IS NULL OR g.evidence_until < ev.newest THEN
     CASE WHEN lt.first_new_at < g.evidence_until - interval '14 days' OR lt.read_after > 150 THEN 'late_evidence'
      ELSE 'new_evidence' END
    -- (rebuild request, 20261013153000) last, so a request never takes the place of a read the job
    -- is due anyway: a job never read, another rebuild or an update keeps its own reason and goes first
    WHEN q.job_id IS NOT NULL THEN 'rebuild_requested' END AS reason,
   CASE WHEN s.mode = 'off' THEN 'ledger_off' WHEN NOT s.lane THEN 'lane_off'
    WHEN s.job_ids IS NOT NULL AND NOT (j.id = ANY(s.job_ids)) THEN 'not_in_rollout' WHEN NOT j.live_job THEN 'not_live'
    WHEN NOT j.schedulable THEN 'holding_job' WHEN lo.job_id IS NOT NULL THEN 'lead_not_monitored'
    WHEN public.context_ledger_person_placement_enabled() AND jsonb_array_length(public.context_ledger_placement_review(j.id,g.id,now()))>0 THEN 'placement_obligation_review'
    WHEN coalesce(ev.n, 0) = 0 AND NOT (g.id IS NOT NULL AND coalesce((p.state->>'affected')::boolean,false) AND coalesce(g.checks#>>'{last_update,reader,placement_signature}',g.checks#>>'{reader,placement_signature}') IS DISTINCT FROM p.state->>'signature') THEN 'no_evidence'
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
  LEFT JOIN placement p ON p.job_id = j.id
 )
 SELECT d.job_id, d.blk IS NULL AND d.reason IS NOT NULL,
  CASE WHEN d.reason IS NULL THEN NULL WHEN d.reason = 'never_read' THEN 'backfill' WHEN d.reason = 'new_evidence' THEN 'update'
   ELSE 'rebuild' END,
  d.reason,
  CASE d.reason WHEN 'placement_changed' THEN 1 WHEN 'citation_moved' THEN 1 WHEN 'new_evidence' THEN 1 WHEN 'late_evidence' THEN 1 WHEN 'never_read' THEN 2
   WHEN 'financial_changed' THEN 1 WHEN 'reader_changed' THEN 3 WHEN 'checks_failed' THEN 3 WHEN 'rebuild_requested' THEN 3 END,
  d.newest, d.n, d.gid, d.blk
 FROM (  -- backfills and rebuilds wait for the backfill hours; an update is never held, (notes
         -- freshness, 20261009132000) nor held back by the backoff of failed reads for a row that
         -- landed after the last of them ended: the reading reads it at once
  SELECT d0.*, coalesce(CASE WHEN d0.blocked = 'backoff' AND d0.reason = 'new_evidence' AND d0.fresh THEN NULL ELSE d0.blocked END,
                        CASE WHEN NOT s.window_open AND d0.reason IS NOT NULL AND d0.reason <> 'new_evidence'
                             THEN 'outside_window' END) AS blk
  FROM judged d0 CROSS JOIN s) d
$function$;

CREATE OR REPLACE FUNCTION public.context_ledger_packet(p_job_id uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_as_of timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE jb record; v_job jsonb; v_parties jsonb; v_evidence jsonb; v_open jsonb; v_until timestamptz; v_rows integer;
 v_truncated integer; v_dups integer; v_as_of timestamptz; v_gen uuid; v_pe text[]; v_pp text[]; v_pc text[];
 v_held jsonb; v_on boolean; v_placement jsonb;
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
 v_placement:=public.context_ledger_placement_state(p_job_id);
 IF coalesce((v_placement->>'enabled')::boolean,false) THEN
  v_placement:=v_placement||jsonb_build_object('ready',coalesce((v_placement->>'latest_decision_at')::timestamptz<=v_as_of,true),
   'prior_signature',(SELECT coalesce(g.checks#>>'{last_update,reader,placement_signature}',g.checks#>>'{reader,placement_signature}') FROM public.context_ledger_generations g WHERE g.id=public.context_ledger_current_generation(p_job_id)));
 END IF;
 RETURN jsonb_build_object('version', 'ledger-packet-v1', 'job', v_job, 'parties', v_parties, 'evidence', v_evidence,
  'evidence_until', v_until, 'evidence_rows', v_rows, 'truncated_rows', v_truncated, 'duplicates_collapsed', v_dups,
  'since', p_since, 'as_of', v_as_of, 'open_items', v_open,
  -- (ledger reader fixes, 20261007150000) the same client's and the same work order's other jobs,
  -- with what was quoted and billed there
  'siblings', public.context_ledger_siblings(p_job_id, v_as_of),
  -- (held messages, 20261012100000) the messages on no job that could be this job's, job not certain
  'held', v_held) || CASE WHEN coalesce((v_placement->>'enabled')::boolean,false) THEN jsonb_build_object('placement',v_placement) ELSE '{}'::jsonb END;
END $function$;

CREATE OR REPLACE FUNCTION public.context_ledger_finish(p_run_id uuid, p_lease_token uuid, p_generation_id uuid, p_outcome text, p_meta jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r public.context_extraction_runs; g public.context_ledger_generations; m jsonb := coalesce(p_meta, '{}'::jsonb);
 v_until timestamptz; v_rows integer; v_chunks integer; v_calls integer; v_tokens integer; v_failure text; v_model text; v_sha text;
 v_acc integer; v_ref integer; v_items integer; v_rate numeric; v_pass boolean; v_store jsonb; v_promoted boolean := false;
 v_carried integer := 0; v_live uuid; v_mode text; v_build boolean; v_checks jsonb; v_proposed integer; v_local integer;
 v_den integer; v_all_rate numeric; v_released boolean; v_code text; v_locked integer;
 -- (thin rebuild, 20261012110000)
 v_pol jsonb; v_live_items integer; v_new_items integer; v_holds integer; v_held uuid; v_held_items integer; v_thin jsonb;
 v_swap uuid; v_placement jsonb;
BEGIN
 IF p_run_id IS NULL OR p_lease_token IS NULL OR p_generation_id IS NULL OR p_outcome IS NULL
  OR p_outcome NOT IN ('built', 'updated', 'failed') OR jsonb_typeof(m) <> 'object' THEN
  RAISE EXCEPTION 'context_ledger_finish_invalid';
 END IF;
 SELECT * INTO r FROM public.context_extraction_runs WHERE id = p_run_id FOR UPDATE;
 IF r.id IS NULL OR r.phase <> 'ledger' THEN RAISE EXCEPTION 'context_ledger_finish_invalid'; END IF;
 SELECT * INTO g FROM public.context_ledger_generations WHERE id = p_generation_id FOR UPDATE;
 IF g.id IS NULL OR g.job_id IS DISTINCT FROM r.job_id THEN RETURN jsonb_build_object('outcome', 'refused', 'reason', 'generation_mismatch'); END IF;
 -- A repeated finish after the first one closed the run: report, change nothing.
 IF r.status IN ('done', 'failed') AND r.lease_token = p_lease_token THEN
  RETURN jsonb_build_object('outcome', p_outcome, 'replayed', true, 'run_status', r.status, 'generation_status', g.status,
   'promoted', g.status = 'live');
 END IF;
 IF r.lease_token IS DISTINCT FROM p_lease_token OR r.status <> 'running' OR r.lease_expires_at IS NULL OR r.lease_expires_at <= now() THEN
  RETURN jsonb_build_object('outcome', 'lease_lost');
 END IF;
 v_build := g.status = 'building' AND g.run_id = p_run_id;
 IF NOT (v_build OR (g.id = public.context_ledger_current_generation(r.job_id)
   AND NOT EXISTS (SELECT 1 FROM public.context_ledger_generations b WHERE b.run_id = p_run_id)))
  OR (p_outcome = 'built' AND NOT v_build) OR (p_outcome = 'updated' AND v_build) THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'generation_mismatch');
 END IF;
 IF p_outcome <> 'failed' AND public.context_ledger_person_placement_enabled() THEN
  v_placement:=public.context_ledger_placement_state(r.job_id);
  IF coalesce((v_placement->>'affected')::boolean,false) THEN
   IF m#>>'{checks,placement_signature}' IS DISTINCT FROM v_placement->>'signature' THEN
    RETURN jsonb_build_object('outcome','refused','reason','placement_changed_during_read');
   END IF;
   IF (v_placement->>'latest_decision_at')::timestamptz > r.started_at THEN
    RETURN jsonb_build_object('outcome','refused','reason','placement_after_claim');
   END IF;
   IF p_outcome='updated' AND coalesce(g.checks#>>'{last_update,reader,placement_signature}',g.checks#>>'{reader,placement_signature}') IS DISTINCT FROM v_placement->>'signature' THEN
    RETURN jsonb_build_object('outcome','refused','reason','placement_rebuild_required');
   END IF;
  END IF;
 END IF;
 BEGIN
  v_until := (m ->> 'evidence_until')::timestamptz;
  v_rows := greatest(0, coalesce((m ->> 'evidence_rows')::integer, 0));
  v_chunks := greatest(0, coalesce((m ->> 'chunks')::integer, 0));
  v_calls := greatest(0, coalesce((m ->> 'calls')::integer, 0));
  v_tokens := greatest(0, coalesce((m ->> 'tokens_in')::integer, 0));
  -- The reader's own count of what it proposed and what it refused before the
  -- store saw it: the promotion verdict counts both sides' refusals.
  v_proposed := greatest(0, coalesce((m #>> '{checks,proposed}')::integer, 0));
  v_local := greatest(0, coalesce((m #>> '{checks,refused_local}')::integer, 0));
 EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'invalid_meta', 'detail', left(SQLERRM, 200));
 END;
 v_model := left(nullif(btrim(m ->> 'model'), ''), 80);
 v_sha := CASE WHEN m ->> 'prompt_sha256' ~ '^[0-9a-f]{64}$' THEN m ->> 'prompt_sha256' END;
 v_failure := left(coalesce(nullif(btrim(m ->> 'failure'), ''), 'failed'), 190);
 IF p_outcome <> 'failed' AND (v_until IS NULL OR v_until > now()) THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'invalid_meta', 'detail', 'evidence_until is required and not in the future');
 END IF;
 -- The reader cannot have read what landed after its claim: cap at the claim's instant.
 v_until := least(v_until, r.started_at);
 IF p_outcome = 'failed' THEN
  -- A stop is not a failure: the worker ran out of budget, was switched off,
  -- paused, rate limited, logged out or stopped. The run and a building
  -- generation are released and never count toward the backoff.
  v_released := v_failure IN ('ledger_budget', 'model_cap', 'ledger_off', 'lane_off', 'paused', 'rate_limited',
   'auth_required', 'worker_stopping');
  v_code := CASE WHEN v_released THEN 'released:' || v_failure ELSE v_failure END;
  IF v_build THEN
   UPDATE public.context_ledger_generations SET status = 'failed', failure = v_code, finished_at = now(), updated_at = now(),
    model = coalesce(v_model, model), chunks = v_chunks, calls = v_calls WHERE id = g.id;
  END IF;
  UPDATE public.context_extraction_runs SET status = 'failed', error = v_code, finished_at = now(), tokens_in = v_tokens,
   lease_expires_at = NULL WHERE id = r.id;
  RETURN jsonb_build_object('outcome', 'failed', 'released', v_released, 'generation_status', CASE WHEN v_build THEN 'failed' ELSE g.status END,
   'promoted', false);
 END IF;
 SELECT coalesce(sum(w.items_accepted), 0), coalesce(sum(w.items_refused), 0),
  coalesce(sum((SELECT count(*) FROM jsonb_array_elements(coalesce(w.result -> 'refused', '[]'::jsonb)) x
                WHERE x ->> 'code' = 'person_locked')), 0)
 INTO v_acc, v_ref, v_locked
 FROM public.context_ledger_writes w WHERE w.run_id = p_run_id AND w.generation_id = g.id;
 -- A matter a person already settled, proposed again, is refused to keep the
 -- person's word; it is not a reading fault, so it never counts against the verdict.
 v_ref := greatest(v_ref - v_locked, 0);
 SELECT count(*) INTO v_items FROM public.context_ledger_items i WHERE i.generation_id = g.id;
 v_rate := CASE WHEN v_acc + v_ref = 0 THEN 0 ELSE trim_scale(round(v_ref::numeric / (v_acc + v_ref), 4)) END;
 -- Refusals on both sides over everything proposed: the reader's local refusals
 -- plus the store's, over the larger of what the reader proposed and what the
 -- store saw.
 v_den := greatest(v_proposed, v_acc + v_ref, 1);
 v_all_rate := trim_scale(round((v_local + v_ref)::numeric / v_den, 4));
 -- The verdict, at most half refused (owner ruling 9 Oct 2026): a refusal only
 -- drops that item, and every item kept passed its own checks, so a reading is
 -- hidden only when more than half of what was proposed, or more than half of
 -- what the store saw, was refused (20261007160000).
 v_pass := (v_local + v_ref) <= 0.5 * v_den AND v_ref <= 0.5 * (v_acc + v_ref);
 IF p_outcome = 'updated' THEN
  IF g.evidence_until IS NOT NULL AND v_until < g.evidence_until THEN
   RETURN jsonb_build_object('outcome', 'refused', 'reason', 'evidence_until_backwards');
  END IF;
  -- The one verdict: the build passed and this update is clean.
  UPDATE public.context_ledger_generations SET evidence_until = v_until, chunks = chunks + v_chunks, calls = calls + v_calls,
   updated_at = now(), checks = checks || jsonb_build_object(
    'passed', coalesce((checks #>> '{store,pass}')::boolean, false) AND v_pass,
    'last_update', jsonb_build_object('run_id', r.id, 'at', now(), 'items_accepted', v_acc, 'items_refused', v_ref,
     'proposed', v_proposed, 'refused_local', v_local, 'refused_rate', v_rate, 'refusal_rate', v_all_rate,
     'refused_person_locked', v_locked, 'evidence_rows', v_rows, 'pass', v_pass, 'reader', m -> 'checks'))
  WHERE id = g.id RETURNING checks INTO v_checks;
  UPDATE public.context_extraction_runs SET status = 'done', finished_at = now(), events_in = v_rows, tokens_in = v_tokens,
   facts_new = v_acc, error = CASE WHEN v_pass THEN NULL ELSE 'checks_failed' END, lease_expires_at = NULL WHERE id = r.id;
  -- A shadow kept current while the lane was in shadow is promoted on its
  -- first update after the lane goes live, if the verdict holds
  -- (context_ledger_checks_pass reads checks.passed).
  SELECT st.mode INTO v_mode FROM public.context_ledger_settings st WHERE st.id;
  IF v_mode = 'live' AND g.status = 'shadow' AND public.context_ledger_checks_pass(v_checks) THEN
   PERFORM public.context_ledger_promote(g.id, 'rule:auto');
   v_promoted := true;
  END IF;
  RETURN jsonb_build_object('outcome', 'updated', 'generation_status', CASE WHEN v_promoted THEN 'live' ELSE g.status END,
   'promoted', v_promoted, 'items_accepted', v_acc, 'items_refused', v_ref, 'passed', (v_checks ->> 'passed')::boolean,
   'evidence_until', v_until);
 END IF;
 -- built: the verdict also needs at least one item unless there was no evidence.
 v_pass := v_pass AND (v_items >= 1 OR v_rows = 0);
 v_store := jsonb_build_object('items', v_items, 'items_accepted', v_acc, 'items_refused', v_ref, 'refused_rate', v_rate,
  'proposed', v_proposed, 'refused_local', v_local, 'refusal_rate', v_all_rate, 'refused_person_locked', v_locked,
  'evidence_rows', v_rows, 'pass', v_pass);
 UPDATE public.context_ledger_generations SET status = 'shadow', model = v_model, prompt_sha256 = v_sha, evidence_until = v_until,
  evidence_rows = v_rows, chunks = v_chunks, calls = v_calls, finished_at = now(), updated_at = now(),
  checks = jsonb_build_object('passed', v_pass, 'store', v_store, 'reader', coalesce(m -> 'checks', 'null'::jsonb))
 WHERE id = g.id RETURNING checks INTO v_checks;
 SELECT id INTO v_live FROM public.context_ledger_generations WHERE job_id = g.job_id AND status = 'live';
 IF v_live IS NOT NULL THEN v_carried := public.context_ledger_carry_forward(v_live, g.id); END IF;
 -- (thin rebuild, 20261012110000) A whole reading that would replace the live one and keeps far
 -- fewer notes than it is not put live on its own word: the same evidence has given 6, 16 and 33
 -- notes on three reads. Weighed only here (a build; an update adds to the reading it updates),
 -- only against a live reading, only when this reading passes its own checks, and counted after
 -- the carry-forward, as it would go live. Thin: the live reading has at least min_live_items notes
 -- and this one fewer than min_share of them (context_ledger_thin_rebuild_policy). A thin reading
 -- is held: it stays a shadow with checks.passed false (the one promotion verdict, so the go-live
 -- sweep and the judge leave it; store.pass keeps its own checks' answer) and its run ends
 -- checks_failed, so the job backs off and is read again. Once max_holds thin readings are held
 -- against the same live reading, the next thin one settles it: the fuller of it and the fullest
 -- held one goes live (a tie to the newer; outside live mode the newer, the only one the sweep
 -- takes). Nothing is deleted: the live reading is retired as on any promotion, and a reading
 -- passed over stays a shadow.
 IF v_live IS NOT NULL AND v_pass THEN
  v_pol := public.context_ledger_thin_rebuild_policy();
  SELECT st.mode INTO v_mode FROM public.context_ledger_settings st WHERE st.id;
  SELECT count(*) INTO v_live_items FROM public.context_ledger_items i WHERE i.generation_id = v_live;
  SELECT count(*) INTO v_new_items FROM public.context_ledger_items i WHERE i.generation_id = g.id;
  IF v_live_items >= (v_pol ->> 'min_live_items')::integer
   AND v_new_items < (v_pol ->> 'min_share')::numeric * v_live_items THEN
   -- the thin readings already held against this live reading, and the fullest of them
   SELECT count(*) INTO v_holds FROM public.context_ledger_generations h
   WHERE h.job_id = g.job_id AND h.status = 'shadow' AND h.id <> g.id AND h.checks #>> '{thin_rebuild,state}' = 'held'
    AND h.checks #>> '{thin_rebuild,live_generation_id}' = v_live::text;
   SELECT h.id, n.items INTO v_held, v_held_items FROM public.context_ledger_generations h
   CROSS JOIN LATERAL (SELECT count(*)::integer AS items FROM public.context_ledger_items i WHERE i.generation_id = h.id) n
   WHERE h.job_id = g.job_id AND h.status = 'shadow' AND h.id <> g.id AND h.checks #>> '{thin_rebuild,state}' = 'held'
    AND h.checks #>> '{thin_rebuild,live_generation_id}' = v_live::text
   ORDER BY n.items DESC, h.created_at DESC, h.id DESC LIMIT 1;
   v_thin := jsonb_build_object('items', v_new_items, 'live_items', v_live_items, 'live_generation_id', v_live,
    'min_share', v_pol -> 'min_share', 'min_live_items', v_pol -> 'min_live_items', 'max_holds', v_pol -> 'max_holds',
    'held_before', v_holds, 'at', now());
   IF v_holds < (v_pol ->> 'max_holds')::integer THEN
    v_thin := v_thin || jsonb_build_object('state', 'held', 'reason', 'thin_rebuild');
   ELSIF v_held IS NULL OR v_new_items >= v_held_items OR v_mode IS DISTINCT FROM 'live' THEN
    v_thin := v_thin || jsonb_build_object('state', 'confirmed', 'reason', 'thin_rebuild_confirmed')
     || CASE WHEN v_held IS NULL THEN '{}'::jsonb
         ELSE jsonb_build_object('held_generation_id', v_held, 'held_items', v_held_items) END;
   ELSE
    v_swap := v_held;
    v_thin := v_thin || jsonb_build_object('state', 'passed_over', 'reason', 'thin_rebuild_fuller_held',
     'held_generation_id', v_held, 'held_items', v_held_items);
   END IF;
   UPDATE public.context_ledger_generations SET updated_at = now(),
    checks = checks || jsonb_build_object('passed', v_thin ->> 'state' = 'confirmed', 'thin_rebuild', v_thin)
   WHERE id = g.id RETURNING checks INTO v_checks;
   IF v_swap IS NOT NULL THEN
    UPDATE public.context_ledger_generations SET updated_at = now(),
     checks = checks || jsonb_build_object('passed', true, 'thin_rebuild', (checks -> 'thin_rebuild')
      || jsonb_build_object('state', 'confirmed', 'reason', 'thin_rebuild_confirmed', 'confirmed_by', g.id,
       'confirmed_items', v_new_items, 'confirmed_at', now()))
    WHERE id = v_swap;
   END IF;
  END IF;
 END IF;
 -- A build that fails its checks counts toward the job's backoff; (thin rebuild, 20261012110000)
 -- so does a thin one that is held.
 UPDATE public.context_extraction_runs SET status = 'done', finished_at = now(), events_in = v_rows, tokens_in = v_tokens,
  facts_new = v_acc, error = CASE WHEN v_pass AND coalesce(v_thin ->> 'state', '') <> 'held' THEN NULL ELSE 'checks_failed' END,
  lease_expires_at = NULL WHERE id = r.id;
 SELECT st.mode INTO v_mode FROM public.context_ledger_settings st WHERE st.id;
 IF v_mode = 'live' AND public.context_ledger_checks_pass(v_checks) THEN
  PERFORM public.context_ledger_promote(g.id, 'rule:auto');
  v_promoted := true;
 END IF;
 -- (thin rebuild, 20261012110000) the fuller held reading goes live in this one's place
 IF v_swap IS NOT NULL THEN PERFORM public.context_ledger_promote(v_swap, 'rule:thin_rebuild'); END IF;
 RETURN jsonb_build_object('outcome', 'built', 'generation_status', CASE WHEN v_promoted THEN 'live' ELSE 'shadow' END,
  'promoted', v_promoted, 'carried', v_carried, 'passed', v_pass, 'checks', v_store, 'evidence_until', v_until)
  -- (thin rebuild, 20261012110000) only when the guard weighed in: the verdict as stored, and why
  || CASE WHEN v_thin IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('passed', public.context_ledger_checks_pass(v_checks), 'thin_rebuild', v_thin)
       || CASE WHEN v_swap IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('promoted_generation_id', v_swap) END END;
END $function$;

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
            'ok', CASE WHEN public.context_ledger_person_placement_enabled() AND c->>'table' IN ('business_events','inbox_events') THEN coalesce((public.context_ledger_cite(p_job_id,c)->>'ok')::boolean,false) OR hc.held ELSE CASE
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
                       END END,
            'customer', CASE WHEN public.context_ledger_person_placement_enabled() THEN coalesce((public.context_ledger_cite(p_job_id,c)->>'customer_sender')::boolean,false) ELSE (e.metadata->'party_roles'->>'sender_role' = 'customer') END)
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
 SELECT public.context_job_story_note_current_invoice(jsonb_build_object(
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
 ), (SELECT coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb)
       FROM public.context_job_record_money(ARRAY[p_job_id], p_as_of) m), p_as_of)
$function$;

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
 SELECT public.context_job_story_placement_review(public.context_job_story_held_marks(public.context_job_story_payment_terms(st.story), p_job_id, p_as_of) || CASE WHEN hm.held IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('held_messages', hm.held) END,p_job_id,p_generation_id,p_as_of,p_record_only)
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
        FROM public.context_ledger_reader_events(ARRAY[p_job_id]) e
        CROSS JOIN LATERAL (SELECT t.id FROM public.context_ledger_reader_events(ARRAY[p_job_id]) t
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

COMMENT ON FUNCTION public.context_ledger_judge(uuid[]) IS 'Context ledger store (20261006013000), story safety (20261006040000): (scoping pipeline, 20261009133000) (finished wake, 20261012093500) (rebuild request, 20261013153000) A rebuild an operator asked for: a job with a request on file that no reading has answered yet (context_ledger_rebuild_request_state: state pending; context_ledger_request_rebuild files one) is due kind rebuild, reason rebuild_requested, priority 3 with the reader-change rebuilds, and only when the judgement has no reason of its own for the job: a job never read, a failed-check, moved-citation, reader-change or late-evidence rebuild and a new-evidence update each keep their own reason and are read first. Every block holds it as it holds any rebuild (ledger_off, lane_off, not_in_rollout, not_live, holding_job, lead_not_monitored, no_evidence, busy, needs_person, backoff, outside_window). It is due once: a whole reading made after the request that passes its checks or went live answers it, whatever reason that reading was claimed for, and after three whole readings made after it that failed it is given up. With no request on file every job is judged exactly as before. Earlier (finished wake): The owner''s 12 Oct 2026 ruling: a finished job (cancelled, archived, complete, completed or lost) is live, and so due a read as any live job (never read: a backfill; a new message: an update), only while the lead rule calls it awake (context_lead_monitored_jobs state finished_awake: a real inbound message of its customer''s on the job inside 30 days, context_finished_wake_hours); a quiet one is blocked not_live, as every finished job was, and its notes stay. The rule is read once for every job asked about. Earlier (scoping pipeline): The lead rule is read once for unfinished jobs including drafts; a draft is live only while monitored from its own activity inside four weeks (six for patio), else blocked not_live. (notes freshness, 20261009132000) a row a reading has not read is the ledger''s one rule (context_ledger_row_unread: a row of the evidence that is not automated and landed after the reading''s evidence_until, copies left out; landing covers a row whose own time is earlier, such as a late call transcript, a late-captured email or a backfilled text). An update is never held by the backoff of failed reads for such a row that landed after the last failed read ended (a read that lost its building lease in the last 2 hours still holds the job; a backfill or rebuild backs off as before). A rebuild of a live reading (moved citation, changed reader) is answered only by the reading the go-live sweep would promote: the job''s newest shadow, newer than the live one, by the current reader, passing its checks, with no row it has not read; the sweep never promotes one with such a row and a shadow beside a live reading is never updated, so such a one answers nothing. Earlier (lead cutoff, 20261007010000) blocked lead_not_monitored: a live job that is a lead no longer followed up (context_lead_monitored_jobs as of now: still at quoted with no acceptance, Xero invoice or bill, booking or later status 28 days after the newer of its newest quote send and the customer''s newest text, email or call, wherever it is placed) is never due a read, so context_ledger_due never lists it and a claim answers not_due; its evidence is not read in full. It is due again the moment it progresses or the customer writes. Earlier (eighth review) citation_moved also takes an item whose citation the citation check refuses now, as the story''s ledger read re-checks it: a CRM text loaded from the cache whose CRM time is not kept or is more than 30 days before the job was created, and an old-inbox mail now placed on another job (or from the client''s address on no job while the client has another job, or from before the job''s lead window), not worded, spam, a newsletter or an auto-reply, or with a saved copy on this job or another live job (the judge''s live set); a mail''s copies time it from when one left a live job (context_ledger_mail_copies). Earlier: a legacy mail whose saved copy sits on another job or on no job counts from when it can have joined the job''s evidence (context_ledger_mail_copies: no earlier than that rule''s first apply and the copy''s own landing), in the quick read (for a job with a reading) as in the full one, so a reading built before then is never taken to have read it and the job is due; (seventh review) one whose copy sits on another live job is not this job''s evidence at all: the full read leaves it out, and the quick read, a superset, may only overstate by it and then reads the job in full; a never-read job''s quick read is as before, except that a never-read job whose admitted rows are all CRM texts loaded from the cache (source ghl_sms_cache_backfill) is read in full, since the evidence leaves out one dated before the job''s lead window and so may hold none (then it is no_evidence, never a backfill of nothing). Earlier: the one ledger due judgement per job (the full evidence read only for a job whose reading may have newer evidence or whose only possible evidence is legacy mail; elsewhere a count and newest landed time of the admitted rows decide the same; evidence_rows is then that count): kind backfill (never_read), update (new_evidence: the current generation''s evidence_until is older than the newest admissible evidence), or rebuild (checks_failed: the current reading is a shadow whose checks.passed is false; citation_moved: an item cites a business_events row now gone, off the job or not admissible; reader_changed; late_evidence: the earliest unread row is more than 14 days older than evidence_until, or more than 150 already-read rows follow it). A rebuild of the live reading for a moved citation or a changed reader is not due while a newer passing shadow by the current reader waits for promotion. Blocked: ledger_off, lane_off, not_in_rollout (settings.job_ids is set and does not list the job), not_live, holding_job, no_evidence, busy (a live building generation or a running ledger run), needs_person (three builds in a row failed their checks: context_ledger_failures), backoff (consecutive failed or check-failed runs: 2 hours, 8 hours, the next Perth day, then 7 days; or a building generation that lost its lease in the last 2 hours), outside_window (a backfill or rebuild outside the settings backfill hours; an update is never held). A person-locked item is never a moved citation (a rebuild would carry it back). Service role only. Held notes (20261015100000): a citation_moved rebuild is not raised for a not-certain item''s own opening citation of a message still held with the job among its candidates while the switch is on and no copy of it is placed (context_ledger_held_citable); once that message is placed on another job, or the switch is off, the item has moved, as any citation off the job. Held messages still never make a job due or move evidence_until. CTX-T24 placement freshness (20261030161813): canonical placement, preserved unresolved review, snapshot acknowledgement; activation separate.';

COMMENT ON FUNCTION public.context_ledger_packet(uuid,timestamp with time zone,timestamp with time zone) IS 'Context ledger store (20261006013000), ledger reader fixes (20261007150000): (held messages, 20261012100000) still ledger-packet-v1, with one field added: held {certainty job_not_certain, total, new, not_shown, rows}: the messages placed on no job that could be this job''s (context_ledger_held_rows: unplaced or waiting on the placement review with this job among their stored candidates, nearly always because the customer has several jobs; worded, a message kind, never retracted, a copy or status-only), as of the packet''s as_of. Context only, marked job not certain: never evidence rows, never in evidence_rows or evidence_until, never citable (the citation check still refuses them, citation_off_job), and nothing about their placement is changed or read as this job''s. total: all of them; new: those that landed after since (all on a rebuild); rows, oldest first: a rebuild''s newest 40, or an update''s newest 40 new ones and, when there is one, the 6 newest given before (already_read true); each row as an evidence row (table, id, at, recorded_at, channel, kind, direction, the stored role fields, sender, recipient, ours, automated, subject) with placed_on none, certainty job_not_certain, from_this_customer (the row''s CRM contact is the job''s, or its sender address the job''s client email), held_rule (the placement rule that held it), candidate_jobs (how many jobs it could belong to), other_jobs (the other candidates'' job numbers, C order) and text (capped at 3,000 characters for a transcript or document text, 1,500 otherwise); not_shown: how many of total are not in rows. Earlier (ledger reader fixes) still ledger-packet-v1, with fields added: each transcript''s call_customer is true, false or the string unknown (neither its call row on this job nor its own stamp on the job''s contact decides), never a bare null; each evidence row carries elsewhere, the reason it is someone else''s (context_ledger_row_elsewhere: role_basis:<basis> when its own stamp names another job''s customer or party or a lead, call_not_customer when its call row''s on this job does, call_on_other_job, names_other_job:<number>) or null, never on the customer''s own words or a stamp naming our own people, a supplier, a builder, a council, a party on this job or nobody (second review, 8 Oct); only role_basis and call_not_customer carry an item that says a row is someone else''s (elsewhere_unsupported); and siblings (context_ledger_siblings as of the packet''s as_of): the same client''s and the same work order''s other jobs with their quotes sent and invoices issued, context only. Earlier: ledger-packet-v1, the reader''s whole view of a job except the record text: job, parties (the job client and a primary contact role customer, a neighbour role third_party labelled neighbour, others their contact_type or unknown; each with match_keys: emails, phones'' last 9 digits), evidence (context_ledger_evidence_rows without copies, oldest first, text capped at 6,000 characters for transcripts and document text and 3,000 otherwise; each row with already_read, placed_on and, on a call log, has_transcript, call_customer on transcripts), evidence_until (newest recorded time seen), evidence_rows, truncated_rows, duplicates_collapsed, open_items (each with phase, closes_on and opened_by as stored). With p_since: rows recorded after it, every already-read row after the earliest of them, and the six before it, and the current generation''s open, disputed and in-force items; without: the live generation''s person-locked items. The judge asks for a rebuild (late_evidence) instead when the earliest new row is more than 14 days older than evidence_until or more than 150 already-read rows follow it. Role fields are the stored party_roles stamp, never invented. Service role only. Story card causes (20261014120000): held text uses the same 6000/3000 limits as placed evidence with an explicit cut flag. Held notes (20261015100000): an open item a held message still holds up carries job_certain false and certainty job_not_certain; while the switch is on, held carries citable job_not_certain and each held row citable (false when a copy is placed on a job or its call is on another job). Off: unchanged. CTX-T24 placement freshness (20261030161813): canonical placement, preserved unresolved review, snapshot acknowledgement; activation separate.';

COMMENT ON FUNCTION public.context_ledger_finish(uuid,uuid,uuid,text,jsonb) IS 'Context ledger store (20261006013000), ledger pass rule (20261007160000): closes a ledger run. (Thin rebuild guard, 20261012110000) A build that would replace a live reading, passes its own checks and, counted after the carry-forward, keeps fewer than min_share of the live reading''s notes while the live one has at least min_live_items (context_ledger_thin_rebuild_policy: half and 10) is held, not promoted: it stays a shadow with checks.passed false (store.pass keeps its own checks'' answer) and checks.thin_rebuild (state held, reason thin_rebuild, both counts, the live generation), the live reading stays live, and its run is done with error checks_failed, so the job backs off and is read again. Once max_holds (1) thin readings are held against the same live reading the next thin one settles it: the fuller of it and the fullest held one goes live (a tie to the newer; state confirmed on the one that goes live, passed_over on the other, which stays a shadow; outside live mode the newer one is confirmed and waits for the sweep). A build that is not thin, a first reading (no live one) and every update are as before. Nothing is deleted. The answer carries thin_rebuild and the stored verdict as passed only when the guard weighed in. evidence_until is capped at the claim''s instant (the run''s started_at) and returned. The verdict, at most half refused (owner ruling 9 Oct 2026), counts both sides'' refusals: (p_meta.checks.refused_local + store refusals) / greatest(p_meta.checks.proposed, store accepted + refused, 1) at most 50%, the store''s own refusals at most 50% of what it saw, and for a build at least one item unless there was no evidence (a refused item is dropped on its own; a reading is hidden only when more than half was refused); it is stored as checks.passed (a build: its verdict; an update: the build''s and this update''s), and a run whose verdict fails is done with error checks_failed (it counts toward the backoff). The failed shadow readings by luna-ledger:v2 stored under the earlier 20% rule were judged again by this one once (checks.repassed_by), apart from those the owner''s direct re-judge of 9 Oct 2026 had already passed. built: the run''s building generation becomes shadow with the reader''s meta (model, prompt_sha256, evidence_until, evidence_rows, chunks, calls, checks), the live generation''s person-locked items are carried forward, and with mode live and checks.passed it is promoted. updated: the current generation''s evidence_until moves forward (never back), and a shadow is promoted on its first update with checks.passed once mode is live. failed: a building generation fails with the reason; a live or shadow one is untouched. A stop (p_meta.failure ledger_budget, model_cap, ledger_off, lane_off, paused, rate_limited, auth_required or worker_stopping) is released, not failed: error and failure released:<code>, never counted toward the backoff. A repeated finish of a closed run reports and changes nothing. Service role only. CTX-T24 placement freshness (20261030161813): canonical placement, preserved unresolved review, snapshot acknowledgement; activation separate.';

COMMENT ON FUNCTION public.context_job_story_ledger(uuid,uuid,timestamp with time zone) IS 'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000): (notes freshness, 20261009132000) unread_rows and unread_ids read the ledger''s one rule (context_ledger_row_unread), as the judge, the due order and the go-live sweep do: a row of the store''s evidence that is not automated (a workflow text, a crew or staff template) and landed after the shown generation''s evidence_until, so an automated message alone never makes meta.ledger.stale true or puts the not-known line about newer messages on the card, and every other row the notes have not read does. Earlier (eighth review) each stored citation is re-checked by the citation check''s current rules (context_ledger_cite), so an item citing a row that is no longer this job''s evidence carries cites_ok false (the story hides it and asks for a rebuild; the judge raises citation_moved): a business_events row also needs, when it is a CRM text loaded from the cache (ghl_sms_cache_backfill), its CRM time kept and not more than 30 days before the job was created; an inbox_events mail must be placed on this job, or come from the client''s address on no job (the client with no other job, from 30 days before the job on), be worded, not spam, a newsletter or an auto-reply, with no saved copy on this job or on another live job (the judge''s live set: never archived, complete, completed, cancelled, lost, a draft or holding) by its source pointer, graph key or payload pointer, and no email on this job from its sender at its instant; and the check is never unknown (a cited row moved to no job, or with no attribution status, read as passing when the check came out null, is not this job''s evidence either, as the judge already said). Earlier, story fixes: items tie on opened_at by item_key in C (byte) order. Earlier: the ledger generation the story shows (the one live at p_as_of, or the one asked for in any status) with the items written by p_as_of, each at its status then, and the transitions by then; every business_events citation is re-checked (still on this job, linked, not retracted) and the item carries cites_ok. unread_rows: the store''s evidence (context_ledger_evidence_rows as of p_as_of, copies not counted) that landed after the shown generation''s evidence_until, so the story says how far its own reader has read; unread_ids: those rows and their copies by id; read_ids: the inbound evidence rows it has read (landed by its evidence_until), so a customer message is called judged only when the reader read it; all three null when no generation is shown. With no generation to show, status says building or shadow when one exists, else none. Service role only. Held notes (20261015100000): a not-certain item''s opening citation of a message still held for this job (context_ledger_held_citable as of p_as_of) is ok and carries held true; such an item carries job_certain false and certainty job_not_certain, and its what starts "Job not certain: ". When the message is later placed on this job the item reads as certain; placed on another job, the citation is not ok, the item is hidden and the judge asks for a rebuild, which drops it. No key changes for any other item. CTX-T24 placement freshness (20261030161813): canonical placement, preserved unresolved review, snapshot acknowledgement; activation separate.';

COMMENT ON FUNCTION public.context_job_story(uuid,timestamp with time zone,uuid,timestamp with time zone,boolean) IS 'Job story (20261006014000), lead cutoff (20261007010000): (story settled notes, 20261011120000) (held messages, 20261012100000) the story also carries held_messages (context_job_story_held as of p_as_of): the messages placed on no job that could be this job''s, nearly always because the customer has several jobs, each marked job not certain, newest first; the key is there only when the job has any (a job with none reads exactly as before) and never in the records-only read. They are shown, never counted as this job''s messages, never cited by a note, and their placement is not changed. Earlier (story settled notes) meta also carries call_transcripts: each call log on the job whose transcript is on the job by p_as_of (linked, landed by then; the transcript''s payload.ghl_call_id or key ghltx:<id> names the call''s ghl:<id>), call row id to transcript id, which the assembler reads to leave out an event written from the call log alone. Earlier (lead cutoff) the record part also carries lead (context_lead_monitored_jobs for the job as of p_as_of: monitored, state, quote_sent_at, customer_at, cutoff_at), which the assembler reads. Earlier: job-story-v1 for one job: now line, money, loops, checks, timeline, phase notes, agreements, events, who, last exchange, handling, not known, changes since p_since, meta. Record parts from the job record layer, the live ledger generation (or p_generation_id in any status), every line cited. p_record_only: the records alone (the ledger is not read: meta.ledger.status omitted, no not_known line about the reader, no ledger item, attachment or words anywhere), for the reader''s own prompt; RPC only, never a door parameter. NULL for an unknown job. Service role only. Story card causes (20261014120000): the known uninvoiced balance is explicitly held while R8 says not_due. Held notes (20261015100000): the story''s loops, agreements, events, settled and disputed entries for an item a held message still holds up carry job_certain false and certainty job_not_certain (context_job_story_held_marks); a story with none is unchanged. CTX-T24 placement freshness (20261030161813): canonical placement, preserved unresolved review, snapshot acknowledgement; activation separate.';
