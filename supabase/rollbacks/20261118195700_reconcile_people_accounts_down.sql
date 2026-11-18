-- Rollback of 20261118195700_reconcile_people_accounts (PLACEHOLDER version): puts back
-- 20261118195400's bodies of reconcile_list_page and reconcile_list_counts,
-- byte for byte.
-- The table public.people_account_codes is LEFT in place, with its labour hold
-- (the CHECK and the people_account_codes_labour_exact trigger and function): it
-- holds the owner's answer, and the deployed edge code reads it (xero-sync's
-- cost lines, materials ingest, bill prematch, matcher and credit step, and
-- ops-api's manual landing lane; each stops, writing nothing, when it is
-- unreadable or empty). Roll back the edge code of this change first, then drop
-- the table by hand only if the owner agrees.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $guard$
DECLARE f record;
BEGIN
  IF to_regprocedure('public.reconcile_list_page(uuid,text[],integer,jsonb)') IS NULL
     OR to_regprocedure('public.reconcile_list_counts(uuid)') IS NULL THEN
    RAISE EXCEPTION 'reconcile_people_accounts down: reconcile_list (20261118195200) is missing';
  END IF;
  -- Pre-image: each body is this migration's, or already 20261118195400's (re-run).
  FOR f IN SELECT p.oid::regprocedure::text sig, md5(p.prosrc) body FROM pg_proc p
    WHERE p.oid IN ('public.reconcile_list_page(uuid,text[],integer,jsonb)'::regprocedure,
                    'public.reconcile_list_counts(uuid)'::regprocedure)
  LOOP
    IF (f.sig, f.body) NOT IN (
      ('reconcile_list_page(uuid,text[],integer,jsonb)', '8c9e154df84031b3ae8620953c67c841'),
      ('reconcile_list_page(uuid,text[],integer,jsonb)', '21429cddb4dcbda92d5f36083fdf453a'),
      ('reconcile_list_counts(uuid)', '377ee4c6d4f4d5ae66b070dc31748f44'),
      ('reconcile_list_counts(uuid)', '40f09ca674d5313c3500100114400280')) THEN
      RAISE EXCEPTION 'reconcile_people_accounts down: % body changed', f.sig;
    END IF;
  END LOOP;
END
$guard$;

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
      AND NOT EXISTS (SELECT FROM public.job_cost_lines l
        WHERE t.subject_table = 'cost_document' AND l.org_id = t.org_id
          AND l.document_kind = split_part(t.subject_id, ':', 1)
          AND l.document_id = substr(t.subject_id, strpos(t.subject_id, ':') + 1)
          AND l.kind = 'installer_bill')
      AND NOT EXISTS (SELECT FROM public.job_cost_lines c
        LEFT JOIN public.job_cost_lines pl ON pl.id = c.follows_line_id
        JOIN public.job_cost_lines p ON p.org_id = t.org_id AND p.document_kind = 'xero_bill' AND p.kind = 'installer_bill'
          AND p.document_id = CASE WHEN c.follows_document_kind = 'xero_bill' THEN c.follows_document_id
            WHEN pl.document_kind = 'xero_bill' THEN pl.document_id END
        WHERE t.subject_table = 'cost_document'
          AND split_part(t.subject_id, ':', 1) = 'xero_credit_note'
          AND c.org_id = t.org_id AND c.document_kind = 'xero_credit_note'
          AND c.document_id = substr(t.subject_id, strpos(t.subject_id, ':') + 1)
          AND c.not_counted_reason IS DISTINCT FROM 'line_removed')
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
      AND NOT EXISTS (SELECT FROM public.job_cost_lines l
        WHERE t.subject_table = 'cost_document' AND l.org_id = t.org_id
          AND l.document_kind = split_part(t.subject_id, ':', 1)
          AND l.document_id = substr(t.subject_id, strpos(t.subject_id, ':') + 1)
          AND l.kind = 'installer_bill')
      AND NOT EXISTS (SELECT FROM public.job_cost_lines c
        LEFT JOIN public.job_cost_lines pl ON pl.id = c.follows_line_id
        JOIN public.job_cost_lines p ON p.org_id = t.org_id AND p.document_kind = 'xero_bill' AND p.kind = 'installer_bill'
          AND p.document_id = CASE WHEN c.follows_document_kind = 'xero_bill' THEN c.follows_document_id
            WHEN pl.document_kind = 'xero_bill' THEN pl.document_id END
        WHERE t.subject_table = 'cost_document'
          AND split_part(t.subject_id, ':', 1) = 'xero_credit_note'
          AND c.org_id = t.org_id AND c.document_kind = 'xero_credit_note'
          AND c.document_id = substr(t.subject_id, strpos(t.subject_id, ':') + 1)
          AND c.not_counted_reason IS DISTINCT FROM 'line_removed')
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
  'Reconcile list (P2-03.6): one page of an org''s open items, not snoozed first; a document with a person''s labour line, and a credit that follows one, left out. Read only.';

-- Open items per kind for one org: the tab counts. Same WHERE as a page
-- without the kind and cursor filters, so a count never promises an item the
-- list withholds (labour billed outside the Trade App, a document with a
-- labour line, a credit that follows one).
CREATE OR REPLACE FUNCTION public.reconcile_list_counts(p_org uuid)
RETURNS TABLE (kind text, open bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT t.kind, count(*) FROM public.reconcile_items t
  WHERE t.org_id = p_org AND t.status = 'open'
    AND t.reason <> 'installer_bill_outside_app'
    AND NOT EXISTS (SELECT FROM public.job_cost_lines l
      WHERE t.subject_table = 'cost_document' AND l.org_id = t.org_id
        AND l.document_kind = split_part(t.subject_id, ':', 1)
        AND l.document_id = substr(t.subject_id, strpos(t.subject_id, ':') + 1)
        AND l.kind = 'installer_bill')
    AND NOT EXISTS (SELECT FROM public.job_cost_lines c
      LEFT JOIN public.job_cost_lines pl ON pl.id = c.follows_line_id
      JOIN public.job_cost_lines p ON p.org_id = t.org_id AND p.document_kind = 'xero_bill' AND p.kind = 'installer_bill'
          AND p.document_id = CASE WHEN c.follows_document_kind = 'xero_bill' THEN c.follows_document_id
            WHEN pl.document_kind = 'xero_bill' THEN pl.document_id END
      WHERE t.subject_table = 'cost_document'
        AND split_part(t.subject_id, ':', 1) = 'xero_credit_note'
        AND c.org_id = t.org_id AND c.document_kind = 'xero_credit_note'
        AND c.document_id = substr(t.subject_id, strpos(t.subject_id, ':') + 1)
        AND c.not_counted_reason IS DISTINCT FROM 'line_removed')
  GROUP BY t.kind ORDER BY t.kind COLLATE "C"
$fn$;

COMMENT ON FUNCTION public.reconcile_list_counts(uuid) IS
  'Reconcile list (P2-03.6): open items per kind for one org, with the same items left out as a page. Read only.';

REVOKE ALL ON FUNCTION public.reconcile_list_page(uuid,text[],integer,jsonb),
  public.reconcile_list_counts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_list_page(uuid,text[],integer,jsonb),
  public.reconcile_list_counts(uuid) TO service_role;
