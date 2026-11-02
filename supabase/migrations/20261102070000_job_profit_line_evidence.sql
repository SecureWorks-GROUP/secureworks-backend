-- Job Profit reads Bookkeeping's line-by-line evidence ledger (R57; Road to
-- done P2, with TP-01, TP-13, CFO-01 to CFO-03), 2 Nov 2026.
--
-- Owner, 2 Nov 2026 (R57): every July to October Xero invoice and cost line is
-- allocated to a job or to overhead, with evidence; Bookkeeping makes the Xero
-- corrections and keeps the line-by-line evidence ledger; a job's profit is
-- "verified" only when every line on that job is evidenced, otherwise
-- "provisional" with what is missing.
--
-- What this adds (read side only; no money figure in v_job_profit changes):
-- 1. bookkeeping_evidence_revisions / bookkeeping_line_evidence: each
--    Bookkeeping evidence revision (schema bookkeeping-financial-evidence/1.0)
--    and its facts, one row per Xero line (InvoiceID + LineItemID). Written
--    only through bookkeeping_evidence_open / _add / _close (service role). A
--    revision is read only once closed with every sent fact loaded; a closed
--    revision supersedes the earlier ones of its stream (the revision name
--    without its -rN suffix).
-- 2. bookkeeping_evidence_classify(fact): rule r57-v1. A fact is an evidenced
--    allocation when it names exactly one known job (or says not_job_cost or
--    overhead), carries a source document hash, and Bookkeeping's own outcome
--    is not a "no document / no job" class. Bookkeeping may instead send
--    allocation and evidenced explicitly; those win.
-- 3. v_xero_lines: every authorised/submitted/paid Xero customer-invoice and
--    bill line, numbered as v_job_cost_events numbers bill lines, with its
--    division (tracking) and ex-GST amount.
-- 4. job_profit_line_evidence(job): every line that makes up the job's figure
--    (customer-invoice lines; Job Profit's actual cost rows) with its
--    evidence, plus evidenced lines Job Profit does not carry, and the job's
--    status: verified only when it has customer-invoice lines and every item
--    is evidenced to this job; otherwise provisional; no_lines when empty.
-- 5. job_profit_line_evidence_score(from, to): the R57 headline: lines and
--    value evidenced, by type and allocation, and jobs verified.
--
-- Unknown stays unknown: a line with no evidence is "no evidence", never
-- assumed right. Service role only.
-- Rollback: supabase/rollbacks/20261102070000_job_profit_line_evidence_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
BEGIN
  IF to_regclass('public.bookkeeping_evidence_revisions') IS NOT NULL
     OR to_regclass('public.bookkeeping_line_evidence') IS NOT NULL
     OR to_regclass('public.v_xero_lines') IS NOT NULL THEN
    RAISE EXCEPTION 'job_profit_line_evidence_already_exists';
  END IF;
  IF to_regclass('public.v_job_cost_events') IS NULL THEN
    RAISE EXCEPTION 'job_profit_line_evidence_needs_v_job_cost_events';
  END IF;
END $guard$;

CREATE TABLE public.bookkeeping_evidence_revisions (
  revision text PRIMARY KEY CHECK (revision ~ '^[A-Za-z0-9._-]+$'),
  stream text NOT NULL,
  revision_no integer,
  schema text NOT NULL,
  producer text,
  emitted_at timestamptz NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  supersedes text,
  facts_in_file integer NOT NULL CHECK (facts_in_file >= 0),
  facts_sent integer NOT NULL CHECK (facts_sent >= 0),
  rows_loaded integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'loading' CHECK (status IN ('loading', 'current', 'superseded')),
  rule_version text NOT NULL DEFAULT 'r57-v1',
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  loaded_by text
);
COMMENT ON TABLE public.bookkeeping_evidence_revisions IS
  'R57 (20261102070000): one row per Bookkeeping evidence revision (bookkeeping-financial-evidence/1.0). facts_in_file is the revision''s fact count; facts_sent the facts loaded from it (a loader may send only the facts that name a job or a non-job class). Read only when status is current. Written only by bookkeeping_evidence_open/_add/_close. Service role only.';

CREATE TABLE public.bookkeeping_line_evidence (
  revision text NOT NULL REFERENCES public.bookkeeping_evidence_revisions(revision) ON DELETE CASCADE,
  xero_invoice_id text NOT NULL,
  xero_line_item_id text NOT NULL,
  amount_ex_gst numeric,
  allocation text NOT NULL CHECK (allocation IN ('job', 'overhead', 'not_job_cost', 'unresolved')),
  job_number text,
  job_id uuid,
  evidenced boolean NOT NULL,
  basis text,
  outcome text,
  document_ref text,
  trade_invoice_line_id uuid,
  fact jsonb NOT NULL,
  PRIMARY KEY (revision, xero_invoice_id, xero_line_item_id)
);
CREATE INDEX bookkeeping_line_evidence_line_idx ON public.bookkeeping_line_evidence (xero_invoice_id, xero_line_item_id);
CREATE INDEX bookkeeping_line_evidence_job_idx ON public.bookkeeping_line_evidence (job_id) WHERE job_id IS NOT NULL;
COMMENT ON TABLE public.bookkeeping_line_evidence IS
  'R57 (20261102070000): one Bookkeeping fact per Xero line (InvoiceID + LineItemID) per revision, classified by bookkeeping_evidence_classify (rule r57-v1): allocation job/overhead/not_job_cost/unresolved, evidenced true only with a source document and a single known job (or a non-job class). fact keeps what was sent. Service role only.';

ALTER TABLE public.bookkeeping_evidence_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookkeeping_line_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bookkeeping_evidence_revisions, public.bookkeeping_line_evidence FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.bookkeeping_evidence_revisions, public.bookkeeping_line_evidence TO service_role;

-- Rule r57-v1. Long keys are Bookkeeping's own field names; one-letter keys are
-- the compact loader's (l line, b bill, a amount, j job number, c confidence,
-- o outcome, d document hash, k allocation, e evidenced, t trade line).
CREATE FUNCTION public.bookkeeping_evidence_classify(
  f jsonb,
  OUT allocation text, OUT job_number text, OUT job_id uuid, OUT evidenced boolean,
  OUT basis text, OUT outcome text, OUT document_ref text)
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $fn$
DECLARE
  n integer;
  v_jn text := nullif(btrim(coalesce(f ->> 'job_number', f ->> 'j', '')), '');
  v_alloc text := nullif(coalesce(f ->> 'allocation', f ->> 'k'), '');
  v_ev text := nullif(coalesce(f ->> 'evidenced', f ->> 'e'), '');
BEGIN
  job_number := v_jn;
  basis := nullif(coalesce(f ->> 'job_confidence', f ->> 'c', ''), '');
  outcome := nullif(coalesce(f ->> 'outcome', f ->> 'status', f ->> 'o', ''), '');
  document_ref := nullif(coalesce(f ->> 'd', f ->> 'pdf_sha256', f #>> '{documents,0,sha256}', ''), '');
  IF v_jn IS NOT NULL THEN
    SELECT count(*), (array_agg(jb.id))[1] INTO n, job_id
    FROM public.jobs jb WHERE upper(btrim(jb.job_number)) = upper(v_jn);
    IF n <> 1 THEN job_id := NULL; END IF;
  END IF;
  allocation := CASE
    WHEN v_alloc IN ('job', 'overhead', 'not_job_cost', 'unresolved') THEN v_alloc
    WHEN basis = 'not_job_cost_adjustment' THEN 'not_job_cost'
    WHEN job_id IS NOT NULL THEN 'job'
    ELSE 'unresolved'
  END;
  IF allocation = 'job' AND job_id IS NULL THEN allocation := 'unresolved'; END IF;
  evidenced := CASE
    WHEN allocation = 'unresolved' THEN false
    WHEN v_ev IN ('true', 'false') THEN v_ev::boolean
    WHEN document_ref IS NULL THEN false
    WHEN allocation IN ('not_job_cost', 'overhead') THEN true
    WHEN coalesce(basis, '') = 'unknown' THEN false
    WHEN coalesce(outcome, '') LIKE 'no\_%' THEN false
    WHEN coalesce(outcome, '') IN ('order_no_without_job', 'document_no_job_reference', 'several_jobs_same_address',
                                   'reference_not_a_known_job', 'original_invoice_no_valid_job') THEN false
    ELSE true
  END;
END $fn$;
COMMENT ON FUNCTION public.bookkeeping_evidence_classify(jsonb) IS
  'R57 rule r57-v1 (20261102070000): allocation and evidenced for one Bookkeeping fact. A job number must match exactly one job. Evidenced needs a document hash and an outcome that is not a no-document/no-job class; explicit allocation/evidenced fields from Bookkeeping win. Unresolved is never evidenced.';

CREATE FUNCTION public.bookkeeping_evidence_open(
  p_revision text, p_schema text, p_producer text, p_emitted_at timestamptz, p_sha256 text,
  p_supersedes text, p_facts_in_file integer, p_facts_sent integer, p_by text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE r public.bookkeeping_evidence_revisions;
BEGIN
  IF p_schema IS DISTINCT FROM 'bookkeeping-financial-evidence/1.0' THEN
    RAISE EXCEPTION 'evidence_schema_unsupported: %', p_schema;
  END IF;
  SELECT * INTO r FROM public.bookkeeping_evidence_revisions WHERE revision = p_revision FOR UPDATE;
  IF FOUND THEN
    IF r.sha256 <> p_sha256 THEN RAISE EXCEPTION 'evidence_revision_sha_mismatch: %', p_revision; END IF;
    IF r.status <> 'loading' THEN
      RETURN jsonb_build_object('revision', p_revision, 'status', r.status, 'already', true);
    END IF;
    DELETE FROM public.bookkeeping_line_evidence WHERE revision = p_revision;
    UPDATE public.bookkeeping_evidence_revisions
       SET rows_loaded = 0, facts_sent = p_facts_sent, facts_in_file = p_facts_in_file, opened_at = now(), loaded_by = p_by
     WHERE revision = p_revision;
    RETURN jsonb_build_object('revision', p_revision, 'status', 'loading', 'restarted', true);
  END IF;
  INSERT INTO public.bookkeeping_evidence_revisions
    (revision, stream, revision_no, schema, producer, emitted_at, sha256, supersedes, facts_in_file, facts_sent, loaded_by)
  VALUES (p_revision, regexp_replace(p_revision, '-r[0-9]+$', ''), substring(p_revision FROM '-r([0-9]+)$')::integer,
          p_schema, p_producer, p_emitted_at, p_sha256, p_supersedes, p_facts_in_file, p_facts_sent, p_by);
  RETURN jsonb_build_object('revision', p_revision, 'status', 'loading');
END $fn$;

CREATE FUNCTION public.bookkeeping_evidence_add(p_revision text, p_facts jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE st text; n integer;
BEGIN
  SELECT status INTO st FROM public.bookkeeping_evidence_revisions WHERE revision = p_revision FOR UPDATE;
  IF st IS NULL THEN RAISE EXCEPTION 'evidence_revision_unknown: %', p_revision; END IF;
  IF st <> 'loading' THEN RAISE EXCEPTION 'evidence_revision_not_loading: % is %', p_revision, st; END IF;
  IF jsonb_typeof(p_facts) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'evidence_facts_not_array'; END IF;
  INSERT INTO public.bookkeeping_line_evidence
    (revision, xero_invoice_id, xero_line_item_id, amount_ex_gst, allocation, job_number, job_id, evidenced,
     basis, outcome, document_ref, trade_invoice_line_id, fact)
  SELECT p_revision,
         coalesce(f.e ->> 'bill_id', f.e ->> 'b'),
         coalesce(f.e ->> 'line_item_id', f.e ->> 'l'),
         nullif(coalesce(f.e ->> 'amount_ex_gst', f.e ->> 'a'), '')::numeric,
         c.allocation, c.job_number, c.job_id, c.evidenced, c.basis, c.outcome, c.document_ref,
         nullif(coalesce(f.e ->> 'trade_invoice_line_id', f.e ->> 't'), '')::uuid,
         f.e
  FROM jsonb_array_elements(p_facts) AS f(e)
  CROSS JOIN LATERAL public.bookkeeping_evidence_classify(f.e) c
  WHERE coalesce(f.e ->> 'bill_id', f.e ->> 'b') IS NOT NULL
    AND coalesce(f.e ->> 'line_item_id', f.e ->> 'l') IS NOT NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE public.bookkeeping_evidence_revisions SET rows_loaded = rows_loaded + n WHERE revision = p_revision;
  RETURN n;
END $fn$;

CREATE FUNCTION public.bookkeeping_evidence_close(p_revision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE r public.bookkeeping_evidence_revisions; v_newer boolean;
BEGIN
  SELECT * INTO r FROM public.bookkeeping_evidence_revisions WHERE revision = p_revision FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'evidence_revision_unknown: %', p_revision; END IF;
  IF r.status <> 'loading' THEN
    RETURN jsonb_build_object('revision', r.revision, 'status', r.status, 'already', true);
  END IF;
  IF r.rows_loaded <> r.facts_sent THEN
    RAISE EXCEPTION 'evidence_revision_incomplete: % loaded of % sent', r.rows_loaded, r.facts_sent;
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.bookkeeping_evidence_revisions o
                  WHERE o.stream = r.stream AND o.status = 'current'
                    AND coalesce(o.revision_no, 0) > coalesce(r.revision_no, 0)) INTO v_newer;
  IF NOT v_newer THEN
    UPDATE public.bookkeeping_evidence_revisions SET status = 'superseded'
     WHERE stream = r.stream AND status = 'current' AND revision <> r.revision;
  END IF;
  UPDATE public.bookkeeping_evidence_revisions
     SET status = CASE WHEN v_newer THEN 'superseded' ELSE 'current' END, closed_at = now()
   WHERE revision = r.revision;
  RETURN (
    SELECT jsonb_build_object(
      'revision', r.revision, 'status', CASE WHEN v_newer THEN 'superseded' ELSE 'current' END,
      'rows', count(*),
      'evidenced', count(*) FILTER (WHERE e.evidenced),
      'evidenced_ex', coalesce(sum(e.amount_ex_gst) FILTER (WHERE e.evidenced), 0),
      'by_allocation', (SELECT jsonb_object_agg(a.allocation, jsonb_build_object('lines', a.n, 'ex', a.ex, 'evidenced', a.ev))
                          FROM (SELECT allocation, count(*) n, coalesce(sum(amount_ex_gst), 0) ex, count(*) FILTER (WHERE evidenced) ev
                                  FROM public.bookkeeping_line_evidence WHERE revision = r.revision GROUP BY allocation) a))
    FROM public.bookkeeping_line_evidence e WHERE e.revision = r.revision);
END $fn$;

REVOKE ALL ON FUNCTION public.bookkeeping_evidence_classify(jsonb),
  public.bookkeeping_evidence_open(text, text, text, timestamptz, text, text, integer, integer, text),
  public.bookkeeping_evidence_add(text, jsonb),
  public.bookkeeping_evidence_close(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bookkeeping_evidence_classify(jsonb),
  public.bookkeeping_evidence_open(text, text, text, timestamptz, text, text, integer, integer, text),
  public.bookkeeping_evidence_add(text, jsonb),
  public.bookkeeping_evidence_close(text) TO service_role;

-- The line Bookkeeping's current revisions say, one per Xero line (newest wins).
CREATE VIEW public.v_bookkeeping_line_evidence_current AS
SELECT DISTINCT ON (e.xero_invoice_id, e.xero_line_item_id)
  e.xero_invoice_id, e.xero_line_item_id, e.amount_ex_gst, e.allocation, e.job_number, e.job_id,
  e.evidenced, e.basis, e.outcome, e.document_ref, e.trade_invoice_line_id,
  e.revision, r.stream, r.emitted_at, r.sha256 AS revision_sha256
FROM public.bookkeeping_line_evidence e
JOIN public.bookkeeping_evidence_revisions r ON r.revision = e.revision
WHERE r.status = 'current'
ORDER BY e.xero_invoice_id, e.xero_line_item_id, r.emitted_at DESC, r.revision DESC;

-- Every authorised/submitted/paid Xero line, numbered as v_job_cost_events
-- numbers bill lines (xero_invoice_id || ':' || n over line_items).
CREATE VIEW public.v_xero_lines AS
SELECT
  x.xero_invoice_id,
  x.invoice_type,
  x.invoice_number,
  x.status,
  x.job_id AS invoice_job_id,
  x.invoice_date,
  x.contact_name,
  li.n,
  li.value ->> 'LineItemID' AS line_item_id,
  li.value ->> 'Description' AS description,
  li.value ->> 'AccountCode' AS account_code,
  (SELECT string_agg(t ->> 'Option', ', ')
     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(li.value -> 'Tracking') = 'array' THEN li.value -> 'Tracking' ELSE '[]'::jsonb END) t) AS division,
  round(coalesce((li.value ->> 'LineAmount')::numeric, 0)
        - CASE WHEN x.raw_json ->> 'LineAmountTypes' = 'Inclusive' THEN coalesce((li.value ->> 'TaxAmount')::numeric, 0) ELSE 0 END, 2) AS line_ex,
  x.xero_invoice_id || ':' || li.n AS cost_source_id
FROM public.xero_invoices x
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x.line_items) = 'array' THEN x.line_items ELSE '[]'::jsonb END)
  WITH ORDINALITY AS li(value, n)
WHERE x.invoice_type IN ('ACCREC', 'ACCPAY')
  AND x.status IN ('AUTHORISED', 'SUBMITTED', 'PAID');

REVOKE ALL ON public.v_bookkeeping_line_evidence_current, public.v_xero_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_bookkeeping_line_evidence_current, public.v_xero_lines TO service_role;
COMMENT ON VIEW public.v_bookkeeping_line_evidence_current IS
  'R57 (20261102070000): per Xero line, the fact from the newest current Bookkeeping revision. Service role only.';
COMMENT ON VIEW public.v_xero_lines IS
  'R57 (20261102070000): every AUTHORISED/SUBMITTED/PAID Xero ACCREC and ACCPAY line with its division (tracking options), ex-GST amount and the source id v_job_cost_events gives a bill line (xero_invoice_id:n). Service role only.';

-- Every item that makes up one job's figure, with its evidence.
CREATE FUNCTION public.job_profit_line_evidence(p_job_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
WITH ev AS (
  SELECT * FROM public.v_bookkeeping_line_evidence_current
),
cost AS (
  SELECT c.source, c.source_id, c.document_id, c.document_number, c.description, c.amount_ex, c.event_date, c.lane
  FROM public.v_job_cost_events c
  WHERE c.job_id = p_job_id AND c.is_actual
),
trade_bill AS (
  SELECT til.id::text AS line_id, ti.xero_bill_id
  FROM public.trade_invoice_lines til
  JOIN public.trade_invoices ti ON ti.id = til.trade_invoice_id
  WHERE til.id::text IN (SELECT split_part(source_id, ':', 1) FROM cost WHERE source IN ('trade_line', 'trade_employer_super'))
),
revenue AS (
  SELECT 'invoice_line'::text AS kind, l.cost_source_id AS ref, l.invoice_number AS document, l.description,
         l.division, l.line_ex AS amount_ex, l.invoice_date AS line_date, 'revenue'::text AS lane,
         e.allocation, e.job_id AS ev_job_id, e.job_number AS ev_job_number, e.evidenced, e.basis, e.document_ref, e.revision
  FROM public.v_xero_lines l
  LEFT JOIN ev e ON e.xero_invoice_id = l.xero_invoice_id AND e.xero_line_item_id = l.line_item_id
  WHERE l.invoice_type = 'ACCREC' AND l.invoice_job_id = p_job_id
),
direct AS (
  -- bill lines and trade lines matched to their own evidence row
  SELECT c.source AS kind, c.source_id AS ref, c.document_number AS document, c.description,
         xl.division, c.amount_ex, c.event_date AS line_date, c.lane,
         m.allocation, m.job_id AS ev_job_id, m.job_number AS ev_job_number, m.evidenced, m.basis, m.document_ref, m.revision
  FROM cost c
  LEFT JOIN public.v_xero_lines xl ON c.source = 'supplier_bill' AND xl.cost_source_id = c.source_id
  LEFT JOIN trade_bill tb ON c.source = 'trade_line' AND tb.line_id = c.source_id
  LEFT JOIN LATERAL (
    SELECT e.* FROM ev e
    WHERE (c.source = 'supplier_bill' AND e.xero_invoice_id = xl.xero_invoice_id AND e.xero_line_item_id = xl.line_item_id)
       OR (c.source = 'trade_line' AND (e.trade_invoice_line_id::text = c.source_id
           OR (e.xero_invoice_id = tb.xero_bill_id AND e.job_id = p_job_id AND abs(coalesce(e.amount_ex_gst, 0) - c.amount_ex) <= 0.01)))
    ORDER BY (e.job_id = p_job_id) DESC NULLS LAST
    LIMIT 1
  ) m ON true
  WHERE c.source IN ('supplier_bill', 'trade_line')
),
materials AS (
  -- an AI or person placement of a bill (or part of one) on the job: evidenced
  -- when the bill's lines evidenced to this job add up to it (within $1)
  SELECT c.source AS kind, c.source_id AS ref, c.document_number AS document, c.description,
         NULL::text AS division, c.amount_ex, c.event_date AS line_date, c.lane,
         CASE WHEN s.n > 0 THEN 'job' END AS allocation,
         CASE WHEN s.n > 0 THEN p_job_id END AS ev_job_id, NULL::text AS ev_job_number,
         coalesce(s.n > 0 AND abs(s.ex - c.amount_ex) <= 1.00, false) AS evidenced,
         CASE WHEN s.n > 0 THEN s.n || ' evidenced bill line(s), $' || round(s.ex, 2) END AS basis,
         NULL::text AS document_ref, s.revision
  FROM cost c
  LEFT JOIN LATERAL (
    SELECT count(*) AS n, sum(e.amount_ex_gst) AS ex, max(e.revision) AS revision
    FROM ev e WHERE e.xero_invoice_id = c.document_id AND e.job_id = p_job_id AND e.evidenced AND e.allocation = 'job'
  ) s ON true
  WHERE c.source = 'materials_fact'
),
derived AS (
  -- company super follows its crew line; a supplier credit follows its bill
  SELECT c.source AS kind, c.source_id AS ref, c.document_number AS document, c.description,
         NULL::text AS division, c.amount_ex, c.event_date AS line_date, c.lane,
         CASE WHEN ok.v THEN 'job' END AS allocation, CASE WHEN ok.v THEN p_job_id END AS ev_job_id,
         NULL::text AS ev_job_number, coalesce(ok.v, false) AS evidenced,
         CASE c.source WHEN 'trade_employer_super' THEN 'follows its crew line' ELSE 'follows its bill' END AS basis,
         NULL::text AS document_ref, NULL::text AS revision
  FROM cost c
  LEFT JOIN LATERAL (
    SELECT CASE
      WHEN c.source = 'trade_employer_super' THEN
        (SELECT bool_and(d.evidenced AND d.ev_job_id = p_job_id) FROM direct d WHERE d.kind = 'trade_line' AND d.ref = split_part(c.source_id, ':', 1))
      ELSE
        (SELECT bool_and(d.evidenced AND d.ev_job_id = p_job_id) FROM direct d WHERE d.kind = 'supplier_bill' AND split_part(d.ref, ':', 1) = c.document_id)
    END AS v
  ) ok ON true
  WHERE c.source NOT IN ('supplier_bill', 'trade_line', 'materials_fact')
),
not_carried AS (
  -- lines Bookkeeping evidences to this job that Job Profit does not carry
  SELECT 'not_in_job_profit'::text AS kind, l.cost_source_id AS ref, l.invoice_number AS document, l.description,
         l.division, l.line_ex AS amount_ex, l.invoice_date AS line_date,
         CASE WHEN l.invoice_type = 'ACCREC' THEN 'revenue' ELSE 'cost' END AS lane,
         e.allocation, e.job_id AS ev_job_id, e.job_number AS ev_job_number, e.evidenced, e.basis, e.document_ref, e.revision
  FROM ev e
  JOIN public.v_xero_lines l ON l.xero_invoice_id = e.xero_invoice_id AND l.line_item_id = e.xero_line_item_id
  WHERE e.job_id = p_job_id AND e.allocation = 'job' AND e.evidenced
    AND NOT (l.invoice_type = 'ACCREC' AND l.invoice_job_id IS NOT DISTINCT FROM p_job_id)
    AND NOT EXISTS (SELECT 1 FROM cost c WHERE c.source = 'supplier_bill' AND c.source_id = l.cost_source_id)
    AND NOT EXISTS (SELECT 1 FROM cost c WHERE c.source = 'materials_fact' AND c.document_id = l.xero_invoice_id)
    AND NOT EXISTS (SELECT 1 FROM cost c JOIN trade_bill tb ON tb.line_id = c.source_id
                     WHERE c.source = 'trade_line' AND tb.xero_bill_id = l.xero_invoice_id)
),
items AS (
  SELECT i.*,
    CASE
      WHEN i.kind = 'not_in_job_profit' THEN 'not_in_job_profit'
      WHEN i.evidenced AND i.allocation = 'job' AND i.ev_job_id = p_job_id THEN 'evidenced'
      WHEN i.evidenced AND (i.allocation <> 'job' OR i.ev_job_id IS DISTINCT FROM p_job_id) THEN 'evidence_says_elsewhere'
      ELSE 'no_evidence'
    END AS state
  FROM (SELECT * FROM revenue UNION ALL SELECT * FROM direct UNION ALL SELECT * FROM materials
        UNION ALL SELECT * FROM derived UNION ALL SELECT * FROM not_carried) i
),
tally AS (
  SELECT count(*) AS n,
         count(*) FILTER (WHERE state = 'evidenced') AS ok,
         count(*) FILTER (WHERE kind = 'invoice_line') AS rev_n,
         count(*) FILTER (WHERE kind = 'invoice_line' AND state = 'evidenced') AS rev_ok,
         count(*) FILTER (WHERE kind <> 'invoice_line' AND kind <> 'not_in_job_profit') AS cost_n,
         count(*) FILTER (WHERE kind <> 'invoice_line' AND kind <> 'not_in_job_profit' AND state = 'evidenced') AS cost_ok,
         count(*) FILTER (WHERE state = 'not_in_job_profit') AS not_carried,
         count(*) FILTER (WHERE state = 'evidence_says_elsewhere') AS elsewhere,
         coalesce(sum(amount_ex) FILTER (WHERE state = 'evidenced'), 0) AS ok_ex,
         coalesce(sum(amount_ex) FILTER (WHERE state <> 'evidenced'), 0) AS gap_ex
  FROM items
)
SELECT jsonb_build_object(
  'job_id', p_job_id,
  'rule', 'r57-v1',
  'status', CASE WHEN t.n = 0 THEN 'no_lines'
                 WHEN t.rev_n > 0 AND t.ok = t.n THEN 'verified'
                 ELSE 'provisional' END,
  'items', t.n, 'evidenced', t.ok,
  'invoice_lines', t.rev_n, 'invoice_lines_evidenced', t.rev_ok,
  'cost_items', t.cost_n, 'cost_items_evidenced', t.cost_ok,
  'evidence_says_elsewhere', t.elsewhere, 'not_in_job_profit', t.not_carried,
  'evidenced_ex', round(t.ok_ex, 2), 'not_evidenced_ex', round(t.gap_ex, 2),
  'why_not_verified', array_remove(ARRAY[
     CASE WHEN t.n = 0 THEN 'no invoice or cost lines' END,
     CASE WHEN t.rev_n = 0 AND t.n > 0 THEN 'no customer-invoice lines' END,
     CASE WHEN t.rev_n > t.rev_ok THEN (t.rev_n - t.rev_ok) || ' customer-invoice line(s) without evidence' END,
     CASE WHEN t.cost_n > t.cost_ok THEN (t.cost_n - t.cost_ok) || ' cost item(s) without evidence for this job' END,
     CASE WHEN t.not_carried > 0 THEN t.not_carried || ' evidenced line(s) Job Profit does not carry' END], NULL),
  'lines', coalesce((
     SELECT jsonb_agg(jsonb_build_object(
       'kind', i.kind, 'ref', i.ref, 'document', i.document, 'description', left(i.description, 160),
       'division', i.division, 'lane', i.lane, 'amount_ex', round(i.amount_ex, 2), 'date', i.line_date,
       'state', i.state, 'allocation', i.allocation, 'evidence_job_number', i.ev_job_number,
       'basis', i.basis, 'document_ref', left(i.document_ref, 16), 'revision', i.revision)
       ORDER BY (i.state = 'evidenced'), i.line_date, i.ref)
     FROM items i), '[]'::jsonb),
  'read_at', now())
FROM tally t;
$fn$;
COMMENT ON FUNCTION public.job_profit_line_evidence(uuid) IS
  'R57 (20261102070000): every item in one job''s figure (customer-invoice lines; actual cost rows of v_job_cost_events) with Bookkeeping''s current evidence, plus evidenced lines Job Profit does not carry. Status verified only when the job has customer-invoice lines and every item is evidenced to this job; provisional otherwise, with why_not_verified. Company super follows its crew line; a supplier credit follows its bill; a materials placement is evidenced when the bill''s lines evidenced to this job add up to it within $1. Service role only.';

-- The R57 headline.
CREATE FUNCTION public.job_profit_line_evidence_score(p_from date DEFAULT DATE '2026-07-01', p_to date DEFAULT DATE '2026-11-01')
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
WITH xl AS (
  SELECT l.*, e.allocation, e.evidenced, e.job_id AS ev_job_id
  FROM public.v_xero_lines l
  LEFT JOIN public.v_bookkeeping_line_evidence_current e
    ON e.xero_invoice_id = l.xero_invoice_id AND e.xero_line_item_id = l.line_item_id
  WHERE l.invoice_date >= p_from AND l.invoice_date < p_to
),
candidates AS MATERIALIZED (
  -- only a job whose every customer-invoice line in the window is evidenced can be verified;
  -- MATERIALIZED so the per-job check below is never pushed under the GROUP BY
  SELECT x.invoice_job_id AS job_id
  FROM xl x WHERE x.invoice_type = 'ACCREC' AND x.invoice_job_id IS NOT NULL
  GROUP BY x.invoice_job_id
  HAVING bool_and(coalesce(x.evidenced, false) AND x.allocation = 'job' AND x.ev_job_id = x.invoice_job_id)
)
SELECT jsonb_build_object(
  'rule', 'r57-v1',
  'from', p_from, 'to_before', p_to,
  'invoice_lines', (SELECT jsonb_build_object('lines', count(*), 'ex', round(coalesce(sum(line_ex), 0), 2),
                     'evidenced', count(*) FILTER (WHERE evidenced), 'evidenced_ex', round(coalesce(sum(line_ex) FILTER (WHERE evidenced), 0), 2))
                    FROM xl WHERE invoice_type = 'ACCREC'),
  'cost_lines', (SELECT jsonb_build_object('lines', count(*), 'ex', round(coalesce(sum(line_ex), 0), 2),
                  'evidenced', count(*) FILTER (WHERE evidenced), 'evidenced_ex', round(coalesce(sum(line_ex) FILTER (WHERE evidenced), 0), 2),
                  'to_job', count(*) FILTER (WHERE evidenced AND allocation = 'job'),
                  'to_overhead', count(*) FILTER (WHERE evidenced AND allocation = 'overhead'),
                  'not_job_cost', count(*) FILTER (WHERE evidenced AND allocation = 'not_job_cost'))
                 FROM xl WHERE invoice_type = 'ACCPAY'),
  'jobs_with_invoice_lines', (SELECT count(DISTINCT invoice_job_id) FROM xl WHERE invoice_type = 'ACCREC' AND invoice_job_id IS NOT NULL),
  'jobs_verified', (SELECT count(*) FROM candidates c WHERE public.job_profit_line_evidence(c.job_id) ->> 'status' = 'verified'),
  'revisions', coalesce((SELECT jsonb_agg(jsonb_build_object('revision', r.revision, 'sha256', r.sha256, 'facts_in_file', r.facts_in_file,
                          'facts_loaded', r.rows_loaded, 'closed_at', r.closed_at) ORDER BY r.revision)
                         FROM public.bookkeeping_evidence_revisions r WHERE r.status = 'current'), '[]'::jsonb),
  'read_at', now());
$fn$;
COMMENT ON FUNCTION public.job_profit_line_evidence_score(date, date) IS
  'R57 headline (20261102070000): Xero customer-invoice and bill lines dated in [from, to_before) and how many carry evidence in Bookkeeping''s current revisions (count and ex-GST value; cost lines by allocation), and jobs verified by job_profit_line_evidence. Service role only.';

REVOKE ALL ON FUNCTION public.job_profit_line_evidence(uuid), public.job_profit_line_evidence_score(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_line_evidence(uuid), public.job_profit_line_evidence_score(date, date) TO service_role;
