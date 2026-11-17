-- Runs after P4-02.2 merges and the director has run the authorised close flow.
-- Concrete case: P4-02 T1, a sent quote closes an open quote_sent item.
-- Sources: 20250301000001_schema.sql (job_documents),
-- 20261006010000_context_ledger_model.sql (items, generations, transitions).
-- Inputs: job_number, item_id, document_id, expected_closed_at (ISO timestamptz).
-- Use a fixture with no later quote email: the document's sent_at is the close time.
WITH target AS (
  SELECT id FROM public.jobs
  WHERE job_number = :'job_number' AND job_number LIKE 'ZZTEST%'
), item AS (
  SELECT i.id, i.job_id, i.generation_id, i.status, i.closes_on, i.opened_at,
    i.closed_at, i.closed_by, i.person_locked, i.written_by
  FROM public.context_ledger_items i
  JOIN public.context_ledger_generations g ON g.id = i.generation_id
    AND g.job_id = i.job_id AND g.status = 'live'
  JOIN target j ON j.id = i.job_id
  WHERE i.id = :'item_id'::uuid AND (SELECT count(*) FROM target) = 1
), document AS (
  SELECT d.id, d.sent_at
  FROM public.job_documents d JOIN target j ON j.id = d.job_id
  WHERE d.id = :'document_id'::uuid AND d.type = 'quote'
    AND (SELECT count(*) FROM target) = 1
), transitions AS (
  SELECT count(*) FILTER (WHERE t.by = 'rule:record_close_v1') AS rule_transition_count,
    count(*) FILTER (WHERE t.by = 'rule:record_close_v1'
    AND t.from_status = 'open' AND t.to_status = 'closed'
    AND t.evidence @> jsonb_build_array(jsonb_build_object(
      'table', 'job_documents', 'id', :'document_id'))) AS record_close_count,
    (SELECT t2.by FROM public.context_ledger_transitions t2
      JOIN item i2 ON i2.id = t2.item_id AND i2.job_id = t2.job_id
        AND i2.generation_id = t2.generation_id
      ORDER BY t2.at DESC, t2.id DESC LIMIT 1) AS latest_by,
    (SELECT t2.to_status FROM public.context_ledger_transitions t2
      JOIN item i2 ON i2.id = t2.item_id AND i2.job_id = t2.job_id
        AND i2.generation_id = t2.generation_id
      ORDER BY t2.at DESC, t2.id DESC LIMIT 1) AS latest_status
  FROM public.context_ledger_transitions t JOIN item i ON i.id = t.item_id
    AND i.job_id = t.job_id AND i.generation_id = t.generation_id
)
SELECT CASE WHEN (SELECT count(*) FROM target) = 1 AND i.id IS NOT NULL
    AND i.status = 'closed' AND i.closes_on = 'quote_sent'
    AND NOT i.person_locked AND i.written_by NOT LIKE 'person:%'
    AND d.sent_at > i.opened_at AND i.closed_at = d.sent_at
    AND i.closed_at = :'expected_closed_at'::timestamptz
    AND i.closed_by @> jsonb_build_array(jsonb_build_object(
      'table', 'job_documents', 'id', :'document_id'))
    AND t.rule_transition_count = 1 AND t.record_close_count = 1
    AND t.latest_by = 'rule:record_close_v1'
    AND t.latest_status = 'closed'
  THEN 'PASS' ELSE 'FAIL' END AS result,
  (SELECT count(*) FROM target) AS matched_jobs, i.id AS item_id,
  i.status, i.closes_on, i.opened_at, i.closed_at, d.id AS document_id,
  d.sent_at AS record_sent_at, :'expected_closed_at'::timestamptz AS expected_closed_at,
  t.rule_transition_count, t.record_close_count, t.latest_by, t.latest_status
FROM transitions t LEFT JOIN item i ON true LEFT JOIN document d ON true;
