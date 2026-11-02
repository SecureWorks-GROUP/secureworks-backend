SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_ledger(uuid,uuid,timestamptz)')) IS DISTINCT FROM '09d28c282caf22c873f5673d7dd8073f'
 AND (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_ledger(uuid,uuid,timestamptz)')) IS DISTINCT FROM '6ecf46dd34fb7d8280f126c88a5bad21' THEN
  RAISE EXCEPTION 'context_note_current_invoice_preimage_mismatch';
 END IF;
END $guard$;
-- TP-16: keep the immutable obligation and its citations while separating
-- historical note wording from the invoice record at the requested snapshot.
-- No note, payment, status, closure predicate or financial row is written.
CREATE OR REPLACE FUNCTION public.context_job_story_note_current_invoice(
 p_ledger jsonb, p_money jsonb, p_as_of timestamptz)
RETURNS jsonb LANGUAGE sql STABLE PARALLEL SAFE
AS $fn$
 WITH invoices AS MATERIALIZED (
  SELECT DISTINCT inv
  FROM jsonb_array_elements(coalesce(p_money, '[]'::jsonb)) m,
       jsonb_array_elements(coalesce(m->'invoices', '[]'::jsonb)) inv
 ), items AS (
  SELECT item, ordinal,
   item->>'about_key' AS about,
   -- A held or moved citation cannot use this job's money to imply placement.
   (item->>'status' IN ('open','disputed')
    AND coalesce(item->>'closes_on','') <> 'payment'
    AND item->>'about_key' ~* '^invoice:.+'
    AND coalesce(item->>'job_certain','true') <> 'false'
    AND coalesce(item->>'certainty','') <> 'job_not_certain'
    AND coalesce(item->>'cites_ok','true') <> 'false') AS eligible
  FROM jsonb_array_elements(coalesce(p_ledger->'items','[]'::jsonb)) WITH ORDINALITY x(item,ordinal)
 ), matched AS (
  SELECT items.*, matches.n, matches.inv,
   CASE WHEN item->>'invoice_projection'='current-invoice-v1'
        THEN item->>'source_what' ELSE item->>'what' END AS source_what
  FROM items CROSS JOIN LATERAL (
   SELECT count(*) AS n, (jsonb_agg(inv ORDER BY inv::text))->0 AS inv
   FROM invoices WHERE eligible AND (
    lower(about)='invoice:'||lower(inv->>'id')
    OR lower(about)='invoice:'||lower(inv->>'number'))
  ) matches
 ), projected AS (
  SELECT ordinal, CASE WHEN NOT coalesce(eligible,false) THEN item ELSE
   item || jsonb_build_object(
    'source_what',source_what, 'invoice_projection','current-invoice-v1',
    'current_invoice_evidence',jsonb_build_object(
     'as_of',p_as_of, 'resolution',CASE WHEN n=1 THEN 'matched' WHEN n=0 THEN 'missing' ELSE 'ambiguous' END,
     'source_table','xero_invoices', 'source_id',CASE WHEN n=1 THEN inv->>'id' END,
     'number',CASE WHEN n=1 THEN inv->>'number' END,
     'status',CASE WHEN n=1 THEN inv->>'status' END,
     'owing',CASE WHEN n=1 AND jsonb_typeof(inv->'owing')='number' THEN inv->'owing' END),
    'what', CASE WHEN n=1 THEN
      'Invoice record: ' || coalesce(nullif(inv->>'number',''),'number unknown') || ' ' ||
      coalesce(nullif(inv->>'status',''),'status unknown') || '; owing ' ||
      CASE WHEN jsonb_typeof(inv->'owing')='number'
        THEN to_char((inv->>'owing')::numeric,'FM$999,999,999,990.00') ELSE 'Unknown' END || '. '
     ELSE 'Invoice record: payment state Unknown (' || CASE WHEN n=0 THEN 'no exact match' ELSE 'ambiguous match' END || '). ' END ||
     CASE WHEN item->>'status'='disputed' THEN 'Note remains disputed. ' ELSE 'Matter remains unresolved. ' END ||
     'Preserved note (historical wording): ' || coalesce(source_what,'')) END AS item
  FROM matched
 )
 SELECT CASE WHEN p_ledger IS NULL THEN NULL ELSE
  p_ledger || jsonb_build_object('items',coalesce((SELECT jsonb_agg(item ORDER BY ordinal) FROM projected),'[]'::jsonb)) END
$fn$;
COMMENT ON FUNCTION public.context_job_story_note_current_invoice(jsonb,jsonb,timestamptz) IS
 'TP-16 current-invoice-v1: pure read projection of unresolved non-payment invoice matters. Exact same-job invoice ID/number only, ambiguous/missing/null amount stays Unknown. Original prose is retained as source_what and explicitly historical in what; item keys, citations, statuses, person locks and closure predicates remain. A paid invoice does not settle confirmation, dispute, refund or other separate matter. Held/invalid citations are untouched. Uses record money at the caller snapshot, not bank settlement or cost completeness.';
REVOKE ALL ON FUNCTION public.context_job_story_note_current_invoice(jsonb,jsonb,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_story_note_current_invoice(jsonb,jsonb,timestamptz) TO service_role;

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
