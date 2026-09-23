-- Break: value a run document from the revision bound to it (the send-runs
-- whole-job total) instead of the party's own run snapshot share, the defect
-- the value rule exists to prevent (dossier Review 1). Everything else is the
-- migration body unchanged, so only the run-share assertion can fail.
CREATE OR REPLACE FUNCTION public.job_quote_values(p_job_id uuid)
RETURNS TABLE (
  document_id uuid,
  job_contact_id uuid,
  party_is_owner boolean,
  run_label text,
  value_inc_gst numeric,
  value_source text,
  whole_quote_total_inc numeric,
  whole_quote_source text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- A jsonb money value becomes numeric only when it is a JSON number or a
  -- plain decimal string; null, objects and malformed text read as null,
  -- never as 0 (the `parsed` and `whole` steps).
  WITH docs AS (
    SELECT d.id,
           d.job_contact_id,
           d.run_label,
           d.quote_revision_id,
           CASE WHEN d.job_contact_id IS NULL THEN NULL
                ELSE COALESCE(c.is_primary, false) END AS party_is_owner,
           d.data_snapshot_json #> '{run,totals}' AS run_totals,
           d.sent_at,
           d.created_at
    FROM public.job_documents d
    LEFT JOIN public.job_contacts c ON c.id = d.job_contact_id
    WHERE d.job_id = p_job_id
      AND d.type = 'quote'
      AND d.sent_at IS NOT NULL
  ),
  run_send AS (
    SELECT COALESCE(
      (SELECT jsonb_build_object('v', r.totals_snapshot_json -> 'total_inc_gst', 's', 'quote_revision')
         FROM public.quote_revisions r
        WHERE r.job_id = p_job_id
          AND r.released_via = 'send-quote/send-runs'
          AND r.sent_at IS NOT NULL
          AND (jsonb_typeof(r.totals_snapshot_json -> 'total_inc_gst') = 'number'
               OR (jsonb_typeof(r.totals_snapshot_json -> 'total_inc_gst') = 'string' AND btrim(r.totals_snapshot_json -> 'total_inc_gst' #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$'))
        ORDER BY r.sent_at DESC, r.version DESC
        LIMIT 1),
      (SELECT jsonb_build_object('v', e.payload -> 'total_inc_gst', 's', 'quote_sent_log_unverified')
         FROM public.business_events e
        WHERE e.entity_type = 'job'
          AND e.entity_id = p_job_id::text
          AND e.event_type = 'quote.sent'
          AND e.source IN ('send-quote', 'send-quote/send-runs')
          AND (e.source = 'send-quote/send-runs' OR e.metadata ->> 'handler' = 'send-quote/send-runs')
          AND (jsonb_typeof(e.payload -> 'total_inc_gst') = 'number'
               OR (jsonb_typeof(e.payload -> 'total_inc_gst') = 'string' AND btrim(e.payload -> 'total_inc_gst' #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$'))
        ORDER BY e.occurred_at DESC
        LIMIT 1)
    ) AS pick
  ),
  valued AS (
    SELECT d.id,
           d.job_contact_id,
           d.party_is_owner,
           d.run_label,
           d.sent_at,
           d.created_at,
           CASE
             WHEN d.run_label IS NOT NULL THEN
               CASE
                 WHEN d.job_contact_id IS NULL THEN NULL
                 ELSE (SELECT jsonb_build_object('v', r.totals_snapshot_json -> 'total_inc_gst', 's', 'run_snapshot_share')
                         FROM public.quote_revisions r
                        WHERE r.job_document_id = d.id AND r.sent_at IS NOT NULL
                        ORDER BY r.sent_at DESC LIMIT 1)
               END
             ELSE COALESCE(
               (SELECT jsonb_build_object('v', r.totals_snapshot_json -> 'total_inc_gst', 's', 'quote_revision')
                  FROM public.quote_revisions r
                 WHERE r.job_document_id = d.id
                   AND r.job_id = p_job_id
                   AND r.sent_at IS NOT NULL
                   AND r.released_via IS DISTINCT FROM 'send-quote/send-runs'
                   AND (jsonb_typeof(r.totals_snapshot_json -> 'total_inc_gst') = 'number'
               OR (jsonb_typeof(r.totals_snapshot_json -> 'total_inc_gst') = 'string' AND btrim(r.totals_snapshot_json -> 'total_inc_gst' #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$'))
                 ORDER BY (r.id = d.quote_revision_id) DESC, r.sent_at DESC, r.version DESC
                 LIMIT 1),
               (SELECT jsonb_build_object('v', e.payload -> 'total_inc_gst', 's', 'quote_sent_log_unverified')
                  FROM public.business_events e
                 WHERE e.payload @> jsonb_build_object('document_id', d.id::text)
                   AND e.entity_type = 'job'
                   AND e.entity_id = p_job_id::text
                   AND e.event_type = 'quote.sent'
                   AND e.source IN ('send-quote', 'send-quote/send', 'send-quote/send-runs')
                   AND (jsonb_typeof(e.payload -> 'total_inc_gst') = 'number'
               OR (jsonb_typeof(e.payload -> 'total_inc_gst') = 'string' AND btrim(e.payload -> 'total_inc_gst' #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$'))
                 ORDER BY e.occurred_at DESC
                 LIMIT 1)
             )
           END AS pick
    FROM docs d
  ),
  parsed AS (
    SELECT v.*,
           CASE jsonb_typeof(v.pick -> 'v')
             WHEN 'number' THEN (v.pick ->> 'v')::numeric
             WHEN 'string' THEN CASE WHEN btrim(v.pick ->> 'v') ~ '^-?[0-9]+(\.[0-9]+)?$'
                                     THEN btrim(v.pick ->> 'v')::numeric END
           END AS amount
    FROM valued v
  ),
  whole AS (
    SELECT CASE jsonb_typeof(rs.pick -> 'v')
             WHEN 'number' THEN (rs.pick ->> 'v')::numeric
             WHEN 'string' THEN CASE WHEN btrim(rs.pick ->> 'v') ~ '^-?[0-9]+(\.[0-9]+)?$'
                                     THEN btrim(rs.pick ->> 'v')::numeric END
           END AS amount,
           rs.pick ->> 's' AS source
    FROM run_send rs
  )
  SELECT p.id AS document_id,
         p.job_contact_id,
         p.party_is_owner,
         p.run_label,
         p.amount AS value_inc_gst,
         CASE
           WHEN p.amount IS NOT NULL THEN p.pick ->> 's'
           WHEN p.run_label IS NOT NULL AND p.job_contact_id IS NULL THEN 'party not recorded on this run quote'
           WHEN p.run_label IS NOT NULL THEN 'share not recorded on this run quote'
           ELSE 'not recorded on the sent quote'
         END AS value_source,
         w.amount AS whole_quote_total_inc,
         CASE WHEN w.amount IS NOT NULL THEN w.source END AS whole_quote_source
  FROM parsed p
  CROSS JOIN whole w
  ORDER BY p.sent_at DESC, p.created_at DESC, p.id
$$;

REVOKE ALL ON FUNCTION public.job_quote_values(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_quote_values(uuid) TO service_role;
