-- 20260923233000_job_quote_values.sql
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
-- Value rule, fixed order of immutable send-time records, never the live price.
-- send-quote records the WHOLE job's price on every revision and quote.sent
-- row (send-quote/index.ts: /send takes pricing_json.totalIncGST, /send-runs
-- binds one revision to the first client run document), so a sealed total is
-- a document's value only when the document is the whole quote.
--
--   Run document (run_label set): that party's own share from the document's
--     own run snapshot, data_snapshot_json.run.totals.client_share_inc for the
--     client's document, neighbour_share_inc for a neighbour's (the rule
--     send-quote uses for run deposits), 'run_snapshot_share'.
--     A run document with no party is the client's document: send-runs writes
--     the neighbour's document with the neighbour's party id and the client's
--     with the primary party id OR NULL when the job has none (live: dossier
--     row 6, SWF-26818 REAR). No share in the snapshot -> null,
--     'share not recorded on this run quote'.
--   Per-party whole quote (run_label null, a party recorded, and another
--     party also sent a quote on the job; ghl-proxy prepare_neighbour_quotes,
--     live: row 15, SWF-26395): no per-party amount is recorded on it and its
--     sealed total is the whole job's, so value null,
--     'party share not recorded on this per-party quote'. That sealed total is
--     the job-level whole-quote total instead.
--   Whole quote (run_label null otherwise):
--     1. the sealed quote_revisions total bound to this document
--        (totals_snapshot_json.total_inc_gst, sent revisions only),
--        'quote_revision';
--     2. else the quote.sent row naming this document written by the
--        send-quote function, 'quote_sent_log_unverified' (business_events is
--        still public-insertable until the lockdown item, gate G-ANON).
--        send-quote writes source 'send-quote' on its legacy insert and
--        'send-quote/send' or 'send-quote/send-runs' through recordEvidence
--        (live rows all carry 'send-quote/send'); no other source counts. The
--        row is found by the job it names (entity_type 'job', entity_id = job
--        id, idx_events_entity) and the document id (payload GIN index), not
--        by business_events.job_id, which the attribution ladder clears on a
--        legacy insert;
--     3. else null, 'not recorded on the sent quote'.
--   Whole-job total, job level only, when the job's quotes are split by party:
--     the newest run send (its send-runs revision, else its send-runs
--     quote.sent row), else the newest per-party whole quote's sealed total
--     (same order as a whole quote). Null for a plain whole quote, whose own
--     value already is the whole job.
--
-- Money: a JSON number, or a plain decimal string; null, objects and
-- malformed text read as null, never as 0.
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
  WITH docs AS (
    SELECT d.id,
           d.job_contact_id,
           d.run_label,
           d.quote_revision_id,
           CASE
             WHEN d.job_contact_id IS NOT NULL THEN COALESCE(c.is_primary, false)
             WHEN d.run_label IS NOT NULL THEN true   -- the client's run document
           END AS party_is_owner,
           d.data_snapshot_json #> '{run,totals}' AS run_totals,
           d.sent_at,
           d.created_at
    FROM public.job_documents d
    LEFT JOIN public.job_contacts c ON c.id = d.job_contact_id
    WHERE d.job_id = p_job_id
      AND d.type = 'quote'
      AND d.sent_at IS NOT NULL
  ),
  shaped AS (
    SELECT d.*,
           (d.run_label IS NULL
            AND d.job_contact_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM docs o
                         WHERE o.job_contact_id IS NOT NULL
                           AND o.job_contact_id <> d.job_contact_id)) AS per_party
    FROM docs d
  ),
  sealed AS (
    -- The sealed send-time total of each whole-quote document (whole quote
    -- or per-party whole quote), as {v, s}; null when none is recorded.
    SELECT s.id,
           COALESCE(
             (SELECT jsonb_build_object('v', r.totals_snapshot_json -> 'total_inc_gst', 's', 'quote_revision')
                FROM public.quote_revisions r
               WHERE r.job_document_id = s.id
                 AND r.job_id = p_job_id
                 AND r.sent_at IS NOT NULL
                 AND r.released_via IS DISTINCT FROM 'send-quote/send-runs'
                 AND (jsonb_typeof(r.totals_snapshot_json -> 'total_inc_gst') = 'number'
                      OR (jsonb_typeof(r.totals_snapshot_json -> 'total_inc_gst') = 'string'
                          AND btrim(r.totals_snapshot_json ->> 'total_inc_gst') ~ '^-?[0-9]+(\.[0-9]+)?$'))
               ORDER BY (r.id = s.quote_revision_id) DESC, r.sent_at DESC, r.version DESC
               LIMIT 1),
             (SELECT jsonb_build_object('v', e.payload -> 'total_inc_gst', 's', 'quote_sent_log_unverified')
                FROM public.business_events e
               WHERE e.payload @> jsonb_build_object('document_id', s.id::text)
                 AND e.entity_type = 'job'
                 AND e.entity_id = p_job_id::text
                 AND e.event_type = 'quote.sent'
                 AND e.source IN ('send-quote', 'send-quote/send', 'send-quote/send-runs')
                 AND (jsonb_typeof(e.payload -> 'total_inc_gst') = 'number'
                      OR (jsonb_typeof(e.payload -> 'total_inc_gst') = 'string'
                          AND btrim(e.payload ->> 'total_inc_gst') ~ '^-?[0-9]+(\.[0-9]+)?$'))
               ORDER BY e.occurred_at DESC
               LIMIT 1)
           ) AS pick
    FROM shaped s
    WHERE s.run_label IS NULL
  ),
  valued AS (
    SELECT s.*,
           CASE
             WHEN s.run_label IS NOT NULL THEN jsonb_build_object(
               'v', s.run_totals -> (CASE WHEN s.party_is_owner THEN 'client_share_inc' ELSE 'neighbour_share_inc' END),
               's', 'run_snapshot_share')
             WHEN s.per_party THEN NULL
             ELSE (SELECT x.pick FROM sealed x WHERE x.id = s.id)
           END AS pick
    FROM shaped s
  ),
  run_send AS (
    SELECT COALESCE(
      (SELECT jsonb_build_object('v', r.totals_snapshot_json -> 'total_inc_gst', 's', 'quote_revision')
         FROM public.quote_revisions r
        WHERE r.job_id = p_job_id
          AND r.released_via = 'send-quote/send-runs'
          AND r.sent_at IS NOT NULL
          AND (jsonb_typeof(r.totals_snapshot_json -> 'total_inc_gst') = 'number'
               OR (jsonb_typeof(r.totals_snapshot_json -> 'total_inc_gst') = 'string'
                   AND btrim(r.totals_snapshot_json ->> 'total_inc_gst') ~ '^-?[0-9]+(\.[0-9]+)?$'))
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
               OR (jsonb_typeof(e.payload -> 'total_inc_gst') = 'string'
                   AND btrim(e.payload ->> 'total_inc_gst') ~ '^-?[0-9]+(\.[0-9]+)?$'))
        ORDER BY e.occurred_at DESC
        LIMIT 1),
      (SELECT x.pick
         FROM sealed x JOIN shaped s ON s.id = x.id
        WHERE s.per_party AND x.pick IS NOT NULL
        ORDER BY s.sent_at DESC, s.created_at DESC
        LIMIT 1)
    ) AS pick
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
           WHEN p.run_label IS NOT NULL THEN 'share not recorded on this run quote'
           WHEN p.per_party THEN 'party share not recorded on this per-party quote'
           ELSE 'not recorded on the sent quote'
         END AS value_source,
         w.amount AS whole_quote_total_inc,
         CASE WHEN w.amount IS NOT NULL THEN w.source END AS whole_quote_source
  FROM parsed p
  CROSS JOIN whole w
  ORDER BY p.sent_at DESC, p.created_at DESC, p.id
$$;

COMMENT ON FUNCTION public.job_quote_values(uuid) IS
  'D1: the one interpreter of a sent quote''s value. One row per sent quote document: run documents carry their party''s own run snapshot share (a run document with no party is the client''s); a per-party whole quote carries null (its sealed total is the whole job''s); a whole quote carries its sealed revision total, else send-quote''s quote.sent total (unverified), else null with the reason. Whole-job total only at job level when quotes are split by party. Read only; service_role only.';

REVOKE ALL ON FUNCTION public.job_quote_values(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.job_quote_values(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.job_quote_values(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.job_quote_values(uuid) TO service_role;
