-- Context reconciliation from a job (CTX-N1, 20261020165000). Two read-only functions over the
-- decision store (20261020140000). Neither writes anything, neither decides anything, and both
-- read placement only through context_event_jobs.
--
-- context_job_mail(job, limit, roles): the email rows Context places on a job, certain or
-- candidate, each with how sure, by whom, why, and the other jobs the same row sits on. This is
-- the read a consumer such as Dispatch uses to show supplier mail it has no po_communications row
-- for (handoff contract section 4: a candidate row shows on every candidate job marked "may belong
-- to another job"; a split row shows certain on each of its jobs). Copies marked
-- metadata.duplicate_of are left out. p_roles filters on metadata.party_roles.counterpart_role
-- (null = every role); a row with no party_roles stamp has no role and so is left out of any
-- filtered read. p_limit is clamped to 1..501: ops-api asks for one row over its page (at most
-- 500) so it can say there is more instead of a cut list reading as complete.
--
-- context_recon_job_items(job): the queued rows that offer this job (its candidates, or the
-- ladder's job on a queued status), defects included, each with the evidence hash a decision must
-- echo, the cause and every job offered. Each offered job carries its type, suburb and status, and
-- why it is offered, as facts read off the row, never a guess: ladder_job (the ladder put the row
-- there), candidate (the ladder listed it as a possible job), customer_job (the row's contact is
-- the job's customer contact), job_number_in_message (the job number stands whole in the subject
-- or the first 2,000 characters of the body; a call row is never read for it). Never empty. This is the per-job door onto the queue: the daily list
-- ranks causes and leaves defect rows out, so a staff member who knows the job can still decide a
-- row the list never shows. Its pool is the queue's, narrowed to this job: rows with this job
-- as a candidate, every row on this job (the queue keeps a placed row while a decision on it is
-- escalated, unresolved or stale), and rows a decision linked here; the queue's own filter then
-- decides, except that copies marked duplicate_of are left out here (their original is listed). A call row carries no preview, so transcript words never reach this list. At most 201
-- rows (one over ops-api's page of 200, so it can say there is more). The cause rule is
-- context_recon_queue's, restated per row; the contract proves the two agree.

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
                       regexp_replace(left(coalesce(p.payload ->> 'body', ''), 2000), '\s+', ' ', 'g')), 240),
         p.provider_message_id, p.role, p.placement, p.by, p.reason,
         coalesce((SELECT jsonb_agg(jsonb_build_object('job_id', o.job_id, 'job_number', j.job_number,
                                                       'placement', o.placement)
                                    ORDER BY j.job_number COLLATE "C", o.job_id)
                   FROM public.context_event_jobs(p.id) o JOIN public.jobs j ON j.id = o.job_id
                   WHERE o.job_id <> p_job), '[]'::jsonb)
  FROM placed p
  WHERE p_roles IS NULL OR p.role = ANY (p_roles)
  ORDER BY p.occurred_at DESC, p.id DESC
  LIMIT least(greatest(coalesce(p_limit, 100), 1), 501)
$$;
COMMENT ON FUNCTION public.context_job_mail(uuid, int, text[]) IS
 'Context job reconciliation (20261020165000): email rows Context places on a job through context_event_jobs (certain or candidate; by person or ladder; reason), newest first, with the other jobs each row sits on. Leaves out copies marked duplicate_of. p_roles filters on party_roles.counterpart_role. Read only, service role only.';

CREATE OR REPLACE FUNCTION public.context_recon_job_items(p_job uuid)
RETURNS TABLE (event_id uuid, channel text, direction text, occurred_at timestamptz, from_address text,
               subject text, preview text, counterpart_role text, cause text, decision_state text,
               last_action text, shown_hash text, offered jsonb)
LANGUAGE sql STABLE AS $$
  WITH near AS (
    SELECT e.id FROM public.business_events e WHERE e.candidate_job_ids @> ARRAY[p_job]
    UNION SELECT e.id FROM public.business_events e WHERE e.job_id = p_job
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
         CASE WHEN q.channel IS DISTINCT FROM 'call' THEN
           left(coalesce(nullif(q.payload ->> 'body_preview', ''), nullif(q.payload ->> 'text', ''),
                         regexp_replace(left(coalesce(q.payload ->> 'body', ''), 2000), '\s+', ' ', 'g')), 240) END,
         q.metadata -> 'party_roles' ->> 'counterpart_role',
         CASE WHEN q.contact_id IS NULL THEN 'defect:no_identity'
              WHEN q.attribution_checked_at IS NULL THEN 'defect:backfill_never_asked'
              WHEN coalesce(cardinality(q.candidate_job_ids), 0) > 1 THEN 'ambiguity:several_candidates'
              WHEN coalesce(cardinality(q.candidate_job_ids), 0) = 1 THEN 'ambiguity:one_candidate'
              ELSE 'ambiguity:no_candidate' END,
         q.state, q.action,
         public.context_recon_evidence_hash_of(q.channel, q.direction, q.occurred_at, q.contact_id, q.payload),
         coalesce((SELECT jsonb_agg(jsonb_build_object('job_id', j.id, 'job_number', j.job_number,
                                                       'type', j.type, 'suburb', j.site_suburb, 'status', j.status,
                                                       'reasons', to_jsonb(array_remove(ARRAY[
                                                         CASE WHEN j.id = q.job_id THEN 'ladder_job' END,
                                                         CASE WHEN j.id = ANY (coalesce(q.candidate_job_ids, '{}'::uuid[]))
                                                              THEN 'candidate' END,
                                                         CASE WHEN q.contact_id IS NOT NULL AND j.ghl_contact_id = q.contact_id
                                                              THEN 'customer_job' END,
                                                         CASE WHEN j.job_number IS NOT NULL AND q.channel IS DISTINCT FROM 'call'
                                                               AND (coalesce(q.payload ->> 'subject', '') || ' '
                                                                    || left(coalesce(q.payload ->> 'body', q.payload ->> 'text', ''), 2000))
                                                                   ~* ('(^|[^A-Za-z0-9])' || j.job_number || '($|[^A-Za-z0-9])')
                                                              THEN 'job_number_in_message' END], NULL)))
                                    ORDER BY j.job_number COLLATE "C", j.id)
                   FROM public.jobs j
                   WHERE j.id = ANY (coalesce(q.candidate_job_ids, '{}'::uuid[])
                                     || CASE WHEN q.job_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[q.job_id] END)),
                  '[]'::jsonb)
  FROM q
  ORDER BY q.occurred_at DESC, q.id DESC
  LIMIT 201
$$;
COMMENT ON FUNCTION public.context_recon_job_items(uuid) IS
 'Context job reconciliation (20261020165000): the queued rows that offer a job, defects included, each with the evidence hash a decision echoes (context_recon_evidence_hash), the cause (context_recon_queue''s rule) and the jobs offered (candidates plus the ladder''s job, the set confirm accepts), each with type, suburb, status and its reasons. Newest first, at most 201 (ops-api pages 200). Call rows carry no preview. Read only, service role only.';

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
