-- Context reconciliation from a job (CTX-N1, 20261020170000). Two read-only functions over the
-- decision store (20261020140000). Neither writes anything, neither decides anything, and both
-- read placement only through context_event_jobs.
--
-- context_job_mail(job, limit, roles): the email rows Context places on a job, certain or
-- candidate, each with how sure, by whom, why, and the other jobs the same row sits on. This is
-- the read a consumer such as Dispatch uses to show supplier mail it has no po_communications row
-- for (handoff contract section 4: a candidate row shows on every candidate job marked "may belong
-- to another job"; a split row shows certain on each of its jobs). Copies marked
-- metadata.duplicate_of are left out. p_roles filters on metadata.party_roles.counterpart_role
-- (null = every role).
--
-- context_recon_job_items(job): the queued rows that offer this job (its candidates, or the
-- ladder's job on a queued status), defects included, each with the evidence hash a decision must
-- echo, the cause and every job offered. This is the per-job door onto the queue: the daily list
-- ranks causes and leaves defect rows out, so a staff member who knows the job can still decide a
-- row the list never shows. The cause rule is context_recon_queue's, restated per row; the
-- contract proves the two agree.

CREATE OR REPLACE FUNCTION public.context_job_mail(p_job uuid, p_limit int DEFAULT 100, p_roles text[] DEFAULT NULL)
RETURNS TABLE (event_id uuid, occurred_at timestamptz, direction text, from_address text, subject text,
               preview text, provider_message_id text, counterpart_role text, placement text, by text,
               reason text, other_jobs jsonb)
LANGUAGE sql STABLE AS $$
  WITH near AS (
    SELECT e.id FROM public.business_events e WHERE e.job_id = p_job AND e.channel = 'email'
    UNION SELECT e.id FROM public.business_events e WHERE e.candidate_job_ids @> ARRAY[p_job] AND e.channel = 'email'
    UNION SELECT l.event_id FROM public.context_placement_links l WHERE l.job_id = p_job),
  placed AS (
    SELECT e.id, e.occurred_at, e.direction, e.payload, e.provider_message_id,
           e.metadata -> 'party_roles' ->> 'counterpart_role' AS role, ej.placement, ej.by, ej.reason
    FROM near n JOIN public.business_events e ON e.id = n.id AND e.channel = 'email'
    CROSS JOIN LATERAL public.context_event_jobs(e.id) ej
    WHERE ej.job_id = p_job AND NOT (coalesce(e.metadata, '{}'::jsonb) ? 'duplicate_of'))
  SELECT p.id, p.occurred_at, p.direction,
         CASE WHEN jsonb_typeof(p.payload -> 'from') = 'string' THEN p.payload ->> 'from' END,
         p.payload ->> 'subject',
         left(coalesce(nullif(p.payload ->> 'body_preview', ''),
                       regexp_replace(coalesce(p.payload ->> 'body', ''), '\s+', ' ', 'g')), 240),
         p.provider_message_id, p.role, p.placement, p.by, p.reason,
         coalesce((SELECT jsonb_agg(jsonb_build_object('job_id', o.job_id, 'job_number', j.job_number,
                                                       'placement', o.placement)
                                    ORDER BY j.job_number COLLATE "C", o.job_id)
                   FROM public.context_event_jobs(p.id) o JOIN public.jobs j ON j.id = o.job_id
                   WHERE o.job_id <> p_job), '[]'::jsonb)
  FROM placed p
  WHERE p_roles IS NULL OR p.role = ANY (p_roles)
  ORDER BY p.occurred_at DESC, p.id DESC
  LIMIT least(greatest(coalesce(p_limit, 100), 1), 500)
$$;
COMMENT ON FUNCTION public.context_job_mail(uuid, int, text[]) IS
 'Context job reconciliation (20261020170000): email rows Context places on a job through context_event_jobs (certain or candidate; by person or ladder; reason), newest first, with the other jobs each row sits on. Leaves out copies marked duplicate_of. p_roles filters on party_roles.counterpart_role. Read only, service role only.';

CREATE OR REPLACE FUNCTION public.context_recon_job_items(p_job uuid)
RETURNS TABLE (event_id uuid, channel text, direction text, occurred_at timestamptz, from_address text,
               subject text, preview text, counterpart_role text, cause text, decision_state text,
               last_action text, shown_hash text, offered jsonb)
LANGUAGE sql STABLE AS $$
  WITH near AS (
    SELECT e.id FROM public.business_events e WHERE e.candidate_job_ids @> ARRAY[p_job]
    UNION SELECT e.id FROM public.business_events e WHERE e.job_id = p_job
      AND (e.attribution_status = ANY (public.context_recon_queue_statuses()))
    UNION SELECT l.event_id FROM public.context_placement_links l WHERE l.job_id = p_job),
  q AS (
    SELECT e.*, s.state, s.action
    FROM near n JOIN public.business_events e ON e.id = n.id
    CROSS JOIN LATERAL public.context_recon_decision_state(e.id) s
    WHERE (e.attribution_status = ANY (public.context_recon_queue_statuses())
           OR (e.attribution_status IS NULL AND e.job_id IS NULL)
           OR s.decision_id IS NOT NULL)
      AND NOT (s.state = 'decided' AND s.action IN ('confirm','correct','split','unrelated'))
      AND NOT (coalesce(e.metadata, '{}'::jsonb) ? 'duplicate_of'))
  SELECT q.id, q.channel, q.direction, q.occurred_at,
         CASE WHEN jsonb_typeof(q.payload -> 'from') = 'string' THEN q.payload ->> 'from' END,
         q.payload ->> 'subject',
         left(coalesce(nullif(q.payload ->> 'body_preview', ''), nullif(q.payload ->> 'text', ''),
                       regexp_replace(coalesce(q.payload ->> 'body', ''), '\s+', ' ', 'g')), 240),
         q.metadata -> 'party_roles' ->> 'counterpart_role',
         CASE WHEN q.contact_id IS NULL THEN 'defect:no_identity'
              WHEN q.attribution_checked_at IS NULL THEN 'defect:backfill_never_asked'
              WHEN coalesce(cardinality(q.candidate_job_ids), 0) > 1 THEN 'ambiguity:several_candidates'
              WHEN coalesce(cardinality(q.candidate_job_ids), 0) = 1 THEN 'ambiguity:one_candidate'
              ELSE 'ambiguity:no_candidate' END,
         q.state, q.action,
         public.context_recon_evidence_hash_of(q.channel, q.direction, q.occurred_at, q.contact_id, q.payload),
         coalesce((SELECT jsonb_agg(jsonb_build_object('job_id', j.id, 'job_number', j.job_number)
                                    ORDER BY j.job_number COLLATE "C", j.id)
                   FROM public.jobs j
                   WHERE j.id = ANY (coalesce(q.candidate_job_ids, '{}'::uuid[])
                                     || CASE WHEN q.job_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[q.job_id] END)),
                  '[]'::jsonb)
  FROM q
  ORDER BY q.occurred_at DESC, q.id DESC
  LIMIT 200
$$;
COMMENT ON FUNCTION public.context_recon_job_items(uuid) IS
 'Context job reconciliation (20261020170000): the queued rows that offer a job, defects included, each with the evidence hash a decision echoes (context_recon_evidence_hash), the cause (context_recon_queue''s rule) and the jobs offered (candidates plus the ladder''s job, the set confirm accepts). Newest first, at most 200. Read only, service role only.';

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.context_job_mail(uuid,int,text[])',
    'public.context_recon_job_items(uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', f);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $$;
