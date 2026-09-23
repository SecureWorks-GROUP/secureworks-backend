-- 20260923190000_job_quote_values.sql
--
-- Context build slice D1 (dossier design section 4, INTEGRATION X10).
--
-- job_quote_values(job) is the ONE interpreter of what a sent quote was worth.
-- The job read (ops-api job_commercial_read.ts readJobQuotes), the invoice read
-- and, later, the texts ladder's content-reference step (P2) and the sites
-- party read all take quote values from here, so no two readers can disagree.
--
-- One row per SENT quote document of the job (job_documents.type = 'quote'
-- and sent_at set), superseded and declined included; the reader decides what
-- is current. Columns:
--   document_id, job_contact_id, party_is_owner, run_label,
--   value_inc_gst, value_source,
--   whole_quote_total_inc, whole_quote_source   (same on every row; job level)
--
-- Value rule, fixed order of immutable send-time records, never the live price:
--   Run document (run_label set): that party's own share from the document's
--     own run snapshot, data_snapshot_json.run.totals.client_share_inc when the
--     party is the owner, neighbour_share_inc otherwise (the rule send-quote
--     uses for run deposits). value_source 'run_snapshot_share'. Never the
--     quote_revisions total or the quote.sent total: send-runs writes ONE
--     revision per send, bound to the first client run document, carrying the
--     whole job's total, and its quote.sent event does the same.
--     No party on the document -> null, 'party not recorded on this run quote'.
--     Party recorded but no share in the snapshot -> null,
--     'share not recorded on this run quote'.
--   Whole-quote document (run_label null):
--     1. the sealed quote_revisions total bound to this document
--        (totals_snapshot_json.total_inc_gst, sent revisions only),
--        'quote_revision';
--     2. else the quote.sent event naming this document written by the
--        send-quote function, 'quote_sent_log_unverified' (business_events is
--        still public-insertable until the lockdown item, gate G-ANON).
--        send-quote writes source 'send-quote' on its legacy insert and
--        'send-quote/send' or 'send-quote/send-runs' through recordEvidence;
--        no other source counts. The row is found by the job it names
--        (entity_type 'job', entity_id = job id, idx_events_entity) and the
--        document id (payload GIN index), not by business_events.job_id,
--        which the attribution ladder may clear on a legacy insert;
--     3. else null, 'not recorded on the sent quote'.
--   Whole-job total (only when a run send exists): the send-runs revision's
--     total ('quote_revision'), else the send-runs quote.sent event's total
--     ('quote_sent_log_unverified'). Returned on every row; never a document's
--     value.
--
-- Owner detection is job_contacts.is_primary until the sites track adds
-- party_role (sites S-M1 replaces this body then).
--
-- Read only: STABLE, SELECT-only. SECURITY DEFINER with a fixed search_path;
-- no PUBLIC, anon or authenticated execute; service_role only (ops-api).

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
                 ELSE jsonb_build_object(
                   'v', d.run_totals -> (CASE WHEN d.party_is_owner THEN 'client_share_inc' ELSE 'neighbour_share_inc' END),
                   's', 'run_snapshot_share')
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

COMMENT ON FUNCTION public.job_quote_values(uuid) IS
  'D1: the one interpreter of a sent quote''s value. One row per sent quote document: run documents carry the party''s own run snapshot share; whole-quote documents their sealed revision total, else the send-quote quote.sent total (unverified), else null with the reason. Whole-job total only at job level. Read only; service_role only.';

REVOKE ALL ON FUNCTION public.job_quote_values(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.job_quote_values(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.job_quote_values(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.job_quote_values(uuid) TO service_role;
