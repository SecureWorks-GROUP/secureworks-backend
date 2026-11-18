-- Reconcile hidden documents: Xero's own lines and a credit's followed bills
-- (Follow-up 66, Carbon's finding (b), director 04:21). PLACEHOLDER version:
-- the keeper stamps the real one when the PR is marked ready.
--
-- reconcile_list_page and reconcile_list_counts (20261118195700) hide a
-- document with a line on a hidden account (people_account_codes) by reading
-- job_cost_lines only. A zero line on Xero's own record is never a cost line
-- (xero-sync cost_lines skips amount 0), so an item whose only hidden line is
-- such a line was still listed. The matcher and credit step already read
-- Xero's own lines before raising; an item raised before 20261118195700, when
-- 475 was not yet skipped, can still be open.
--
-- One new read-only helper, reconcile_item_xero_hidden(org, subject_table,
-- subject_id): true when Xero's own record of the item's document has a line on
-- a hidden account (a bill's xero_invoices.line_items, a credit note's
-- raw_json LineItems), or when a bill the credit's lines follow (by document
-- or by a followed line, a removed line excepted, the same reach as the
-- existing follow clause) has one. Both list functions add one clause,
-- AND NOT reconcile_item_xero_hidden(...), in every place they already hide;
-- nothing else in either body changes. Codes are compared trimmed, as the edge
-- reader does.
--
-- Hides only: no item is closed or written; no line, kind, lane, amount,
-- proposal or switch changes. A document with no line on a hidden account,
-- ours or Xero's, is listed and counted exactly as before. Indexed reads:
-- xero_invoices (org_id, xero_invoice_id) unique, xero_supplier_credit_notes
-- primary key, job_cost_lines_document_idx; one look-up per open item.
-- The helper carries no SET search_path (every name is schema-qualified) and is
-- called only by the two SECURITY DEFINER list functions; revoked from everyone.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $guard$
DECLARE f record;
BEGIN
  IF to_regclass('public.people_account_codes') IS NULL THEN
    RAISE EXCEPTION 'reconcile_hidden_xero_lines: people_account_codes (20261118195700) is missing';
  END IF;
  -- Pre-image: each list body is 20261118195700's (live), or this migration's own (re-apply).
  FOR f IN SELECT p.oid::regprocedure::text sig, md5(p.prosrc) body FROM pg_proc p
    WHERE p.oid IN (to_regprocedure('public.reconcile_list_page(uuid,text[],integer,jsonb)'),
                    to_regprocedure('public.reconcile_list_counts(uuid)'))
  LOOP
    IF (f.sig, f.body) NOT IN (
      ('reconcile_list_page(uuid,text[],integer,jsonb)', '21429cddb4dcbda92d5f36083fdf453a'),
      ('reconcile_list_page(uuid,text[],integer,jsonb)', '8ed89b415795afccc6125069d17fc8d4'),
      ('reconcile_list_counts(uuid)', '40f09ca674d5313c3500100114400280'),
      ('reconcile_list_counts(uuid)', 'f2f7862006108b3134140ee7fb1cf872')) THEN
      RAISE EXCEPTION 'reconcile_hidden_xero_lines: % body changed', f.sig;
    END IF;
  END LOOP;
  IF to_regprocedure('public.reconcile_list_page(uuid,text[],integer,jsonb)') IS NULL
     OR to_regprocedure('public.reconcile_list_counts(uuid)') IS NULL THEN
    RAISE EXCEPTION 'reconcile_hidden_xero_lines: reconcile_list (20261118195200) is missing';
  END IF;
  -- The helper is new: absent, or this migration's own body.
  IF to_regprocedure('public.reconcile_item_xero_hidden(uuid,text,text)') IS NOT NULL
     AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.reconcile_item_xero_hidden(uuid,text,text)'))
       IS DISTINCT FROM '8a3f20c59289e3692815728b2baeb1fa' THEN
    RAISE EXCEPTION 'reconcile_hidden_xero_lines: reconcile_item_xero_hidden(uuid,text,text) body changed';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.reconcile_item_xero_hidden(p_org uuid, p_subject_table text, p_subject_id text)
RETURNS boolean LANGUAGE sql STABLE AS $fn$
  WITH doc AS (
    SELECT split_part(p_subject_id, ':', 1) AS kind,
      substr(p_subject_id, strpos(p_subject_id, ':') + 1) AS id
    WHERE p_subject_table = 'cost_document'
  ), bills AS (
    SELECT d.id FROM doc d WHERE d.kind = 'xero_bill'
    UNION
    SELECT CASE WHEN c.follows_document_kind = 'xero_bill' THEN c.follows_document_id
      WHEN pl.document_kind = 'xero_bill' THEN pl.document_id END
    FROM doc d
    JOIN public.job_cost_lines c ON d.kind = 'xero_credit_note' AND c.org_id = p_org
      AND c.document_kind = 'xero_credit_note' AND c.document_id = d.id
    LEFT JOIN public.job_cost_lines pl ON pl.id = c.follows_line_id
    WHERE c.not_counted_reason IS DISTINCT FROM 'line_removed'
  )
  SELECT EXISTS (
      SELECT FROM bills b
      JOIN public.xero_invoices x ON x.org_id = p_org AND x.xero_invoice_id = b.id
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x.line_items) = 'array'
        THEN x.line_items ELSE '[]'::jsonb END) li
      WHERE btrim(li->>'AccountCode') IN (
        SELECT a.account_code FROM public.people_account_codes a WHERE a.hidden_from_reconcile))
    OR EXISTS (
      SELECT FROM doc d
      JOIN public.xero_supplier_credit_notes n ON d.kind = 'xero_credit_note'
        AND n.org_id = p_org AND n.xero_credit_note_id = d.id
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(n.raw_json->'LineItems') = 'array'
        THEN n.raw_json->'LineItems' ELSE '[]'::jsonb END) li
      WHERE btrim(li->>'AccountCode') IN (
        SELECT a.account_code FROM public.people_account_codes a WHERE a.hidden_from_reconcile))
$fn$;
REVOKE ALL ON FUNCTION public.reconcile_item_xero_hidden(uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.reconcile_item_xero_hidden(uuid,text,text) IS
  'Reconcile list: true when Xero''s own record of a cost document, or of a bill a credit''s lines follow, has a line on an account hidden from Reconcile (people_account_codes). Read only; called by reconcile_list_page and reconcile_list_counts.';

CREATE OR REPLACE FUNCTION public.reconcile_list_page(
  p_org uuid, p_kinds text[], p_limit integer, p_after jsonb DEFAULT NULL)
RETURNS TABLE (
  id uuid, kind text, subject_table text, subject_id text, job_ids uuid[],
  reason text, amount_ex numeric, document_date date, summary jsonb,
  suggestion jsonb, evidence jsonb, evidence_hash text, raised_at timestamptz,
  snooze_until timestamptz, snoozed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  WITH cur AS (
    SELECT p_after IS NOT NULL AS has,
      coalesce((p_after->>'snoozed')::boolean, false) AS s,
      (p_after->>'amount_ex')::numeric AS a,
      (p_after->>'raised_at')::timestamptz AS r,
      (p_after->>'id')::uuid AS i,
      least(greatest(coalesce(p_limit, 50), 1), 100) + 1 AS n
  ), awake AS (
    SELECT t.id, t.kind, t.subject_table, t.subject_id, t.job_ids, t.reason,
      t.amount_ex, t.document_date, t.summary, t.suggestion, t.evidence,
      t.evidence_hash, t.raised_at, t.snooze_until, false AS snoozed
    FROM public.reconcile_items t, cur
    WHERE t.org_id = p_org AND t.status = 'open' AND t.kind = ANY(p_kinds)
      AND t.reason <> 'installer_bill_outside_app'
      AND EXISTS (SELECT FROM public.people_account_codes h WHERE h.hidden_from_reconcile)
      AND NOT EXISTS (SELECT FROM public.job_cost_lines l
        WHERE t.subject_table = 'cost_document' AND l.org_id = t.org_id
          AND l.document_kind = split_part(t.subject_id, ':', 1)
          AND l.document_id = substr(t.subject_id, strpos(t.subject_id, ':') + 1)
          AND (l.kind = 'installer_bill' OR btrim(l.account_code) IN (SELECT a.account_code FROM public.people_account_codes a WHERE a.hidden_from_reconcile)))
      AND NOT EXISTS (SELECT FROM public.job_cost_lines c
        LEFT JOIN public.job_cost_lines pl ON pl.id = c.follows_line_id
        JOIN public.job_cost_lines p ON p.org_id = t.org_id AND p.document_kind = 'xero_bill' AND (p.kind = 'installer_bill' OR btrim(p.account_code) IN (SELECT a.account_code FROM public.people_account_codes a WHERE a.hidden_from_reconcile))
          AND p.document_id = CASE WHEN c.follows_document_kind = 'xero_bill' THEN c.follows_document_id
            WHEN pl.document_kind = 'xero_bill' THEN pl.document_id END
        WHERE t.subject_table = 'cost_document'
          AND split_part(t.subject_id, ':', 1) = 'xero_credit_note'
          AND c.org_id = t.org_id AND c.document_kind = 'xero_credit_note'
          AND c.document_id = substr(t.subject_id, strpos(t.subject_id, ':') + 1)
          AND c.not_counted_reason IS DISTINCT FROM 'line_removed')
      AND NOT public.reconcile_item_xero_hidden(t.org_id, t.subject_table, t.subject_id)
      AND (t.snooze_until IS NULL OR t.snooze_until <= now())
      AND NOT cur.s
      AND (NOT cur.has OR CASE WHEN cur.a IS NULL
        THEN t.amount_ex IS NULL AND (t.raised_at, t.id) > (cur.r, cur.i)
        ELSE t.amount_ex < cur.a OR t.amount_ex IS NULL
          OR (t.amount_ex = cur.a AND (t.raised_at, t.id) > (cur.r, cur.i)) END)
    ORDER BY t.amount_ex DESC NULLS LAST, t.raised_at, t.id
    LIMIT (SELECT n FROM cur)
  ), asleep AS (
    SELECT t.id, t.kind, t.subject_table, t.subject_id, t.job_ids, t.reason,
      t.amount_ex, t.document_date, t.summary, t.suggestion, t.evidence,
      t.evidence_hash, t.raised_at, t.snooze_until, true AS snoozed
    FROM public.reconcile_items t, cur
    WHERE t.org_id = p_org AND t.status = 'open' AND t.kind = ANY(p_kinds)
      AND t.reason <> 'installer_bill_outside_app'
      AND EXISTS (SELECT FROM public.people_account_codes h WHERE h.hidden_from_reconcile)
      AND NOT EXISTS (SELECT FROM public.job_cost_lines l
        WHERE t.subject_table = 'cost_document' AND l.org_id = t.org_id
          AND l.document_kind = split_part(t.subject_id, ':', 1)
          AND l.document_id = substr(t.subject_id, strpos(t.subject_id, ':') + 1)
          AND (l.kind = 'installer_bill' OR btrim(l.account_code) IN (SELECT a.account_code FROM public.people_account_codes a WHERE a.hidden_from_reconcile)))
      AND NOT EXISTS (SELECT FROM public.job_cost_lines c
        LEFT JOIN public.job_cost_lines pl ON pl.id = c.follows_line_id
        JOIN public.job_cost_lines p ON p.org_id = t.org_id AND p.document_kind = 'xero_bill' AND (p.kind = 'installer_bill' OR btrim(p.account_code) IN (SELECT a.account_code FROM public.people_account_codes a WHERE a.hidden_from_reconcile))
          AND p.document_id = CASE WHEN c.follows_document_kind = 'xero_bill' THEN c.follows_document_id
            WHEN pl.document_kind = 'xero_bill' THEN pl.document_id END
        WHERE t.subject_table = 'cost_document'
          AND split_part(t.subject_id, ':', 1) = 'xero_credit_note'
          AND c.org_id = t.org_id AND c.document_kind = 'xero_credit_note'
          AND c.document_id = substr(t.subject_id, strpos(t.subject_id, ':') + 1)
          AND c.not_counted_reason IS DISTINCT FROM 'line_removed')
      AND NOT public.reconcile_item_xero_hidden(t.org_id, t.subject_table, t.subject_id)
      AND t.snooze_until > now()
      AND (NOT cur.s OR CASE WHEN cur.a IS NULL
        THEN t.amount_ex IS NULL AND (t.raised_at, t.id) > (cur.r, cur.i)
        ELSE t.amount_ex < cur.a OR t.amount_ex IS NULL
          OR (t.amount_ex = cur.a AND (t.raised_at, t.id) > (cur.r, cur.i)) END)
    ORDER BY t.amount_ex DESC NULLS LAST, t.raised_at, t.id
    LIMIT (SELECT n FROM cur)
  )
  SELECT * FROM (SELECT * FROM awake UNION ALL SELECT * FROM asleep) x
  ORDER BY x.snoozed, x.amount_ex DESC NULLS LAST, x.raised_at, x.id
  LIMIT (SELECT n FROM cur)
$fn$;

COMMENT ON FUNCTION public.reconcile_list_page(uuid,text[],integer,jsonb) IS
  'Reconcile list (P2-03.6): one page of an org''s open items, not snoozed first; a document with a person''s labour line or a line on a hidden account (people_account_codes.hidden_from_reconcile), on our cost lines or on Xero''s own record, and a credit that follows one, left out; nothing listed while no account is hidden (fail closed). Read only.';

-- Open items per kind for one org: the same items left out as a page.
CREATE OR REPLACE FUNCTION public.reconcile_list_counts(p_org uuid)
RETURNS TABLE (kind text, open bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT t.kind, count(*) FROM public.reconcile_items t
  WHERE t.org_id = p_org AND t.status = 'open'
    AND t.reason <> 'installer_bill_outside_app'
    AND EXISTS (SELECT FROM public.people_account_codes h WHERE h.hidden_from_reconcile)
    AND NOT EXISTS (SELECT FROM public.job_cost_lines l
      WHERE t.subject_table = 'cost_document' AND l.org_id = t.org_id
        AND l.document_kind = split_part(t.subject_id, ':', 1)
        AND l.document_id = substr(t.subject_id, strpos(t.subject_id, ':') + 1)
        AND (l.kind = 'installer_bill' OR btrim(l.account_code) IN (SELECT a.account_code FROM public.people_account_codes a WHERE a.hidden_from_reconcile)))
    AND NOT EXISTS (SELECT FROM public.job_cost_lines c
      LEFT JOIN public.job_cost_lines pl ON pl.id = c.follows_line_id
      JOIN public.job_cost_lines p ON p.org_id = t.org_id AND p.document_kind = 'xero_bill' AND (p.kind = 'installer_bill' OR btrim(p.account_code) IN (SELECT a.account_code FROM public.people_account_codes a WHERE a.hidden_from_reconcile))
          AND p.document_id = CASE WHEN c.follows_document_kind = 'xero_bill' THEN c.follows_document_id
            WHEN pl.document_kind = 'xero_bill' THEN pl.document_id END
      WHERE t.subject_table = 'cost_document'
        AND split_part(t.subject_id, ':', 1) = 'xero_credit_note'
        AND c.org_id = t.org_id AND c.document_kind = 'xero_credit_note'
        AND c.document_id = substr(t.subject_id, strpos(t.subject_id, ':') + 1)
        AND c.not_counted_reason IS DISTINCT FROM 'line_removed')
    AND NOT public.reconcile_item_xero_hidden(t.org_id, t.subject_table, t.subject_id)
  GROUP BY t.kind ORDER BY t.kind COLLATE "C"
$fn$;

COMMENT ON FUNCTION public.reconcile_list_counts(uuid) IS
  'Reconcile list (P2-03.6): open items per kind for one org, with the same items left out as a page. Read only.';

REVOKE ALL ON FUNCTION public.reconcile_list_page(uuid,text[],integer,jsonb),
  public.reconcile_list_counts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_list_page(uuid,text[],integer,jsonb),
  public.reconcile_list_counts(uuid) TO service_role;
