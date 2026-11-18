-- People accounts (director rulings, 19 Nov 2026 03:07 and 03:36): one table
-- holds two separate facts about a Xero account code, so neither is kept in code.
-- PLACEHOLDER version: the keeper stamps the real one when the PR is marked ready.
--
-- 1. public.people_account_codes, one row per code, two flags:
--    labour                 the line is a person's labour: it decides a line's
--                           KIND (installer_bill) and the labour stops. 301 and
--                           306 only, exactly as the code held them before. Read
--                           by xero-sync's cost lines, materials ingest, bill
--                           prematch and the matcher's installer stop, and by
--                           ops-api's manual landing lane (_shared/people_accounts.ts).
--    hidden_from_reconcile  a document with any line on it is never proposed and
--                           never listed. 301, 306 and 475 (Admin, Internal
--                           Subcontractors: labour billed outside the Trade App
--                           on an account that is not labour, two bills live).
--                           Read ONLY by the matcher's and credit step's skip
--                           (before any write) and the two list functions below.
--    A labour account is always hidden (CHECK). 475 is hidden and NOT labour: its
--    kind and its Job Profit treatment are unchanged; it is only never proposed
--    and never listed. The owner's answer changes a row, not code. Seeded only
--    when this migration creates the table, so a re-apply never puts back a row
--    or flag the owner changed. RLS on with no policy, revoked from everyone but
--    SELECT to service_role; the list functions read it as their owner
--    (SECURITY DEFINER).
-- 2. reconcile_list_page and reconcile_list_counts (20261118195400): a
--    document with a line on a hidden account is left out exactly as a document
--    with a line of kind installer_bill is, and so is a credit that follows such
--    a bill. An open item already raised for such a document is hidden by the
--    same rule; no item is closed or written.
--
-- Not changed: job_cost_lines_bill_document (20261118195100, the database twin
-- of the cost-line writer) keeps 301 and 306 in its body until a later PR, so
-- the labour flag must not be changed before then. No figure moves: no line's
-- kind, lane or amount changes, and the Job Profit SQL is untouched.
-- No index: the set is a few rows; a document's lines are found through
-- job_cost_lines_document_idx as before. No switch, no data write beyond the
-- seed, no schedule. Same signatures, grants and comment prefix
-- (20261118195200 re-applies on that prefix).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $guard$
DECLARE f record;
BEGIN
  IF to_regprocedure('public.reconcile_list_page(uuid,text[],integer,jsonb)') IS NULL
     OR to_regprocedure('public.reconcile_list_counts(uuid)') IS NULL THEN
    RAISE EXCEPTION 'reconcile_people_accounts: reconcile_list (20261118195200) is missing';
  END IF;
  -- Pre-image: each body is 20261118195400's (live), or this migration's own (re-apply).
  FOR f IN SELECT p.oid::regprocedure::text sig, md5(p.prosrc) body FROM pg_proc p
    WHERE p.oid IN ('public.reconcile_list_page(uuid,text[],integer,jsonb)'::regprocedure,
                    'public.reconcile_list_counts(uuid)'::regprocedure)
  LOOP
    IF (f.sig, f.body) NOT IN (
      ('reconcile_list_page(uuid,text[],integer,jsonb)', '8c9e154df84031b3ae8620953c67c841'),
      ('reconcile_list_page(uuid,text[],integer,jsonb)', 'bbf31b21435de5495b193e5ca011fefd'),
      ('reconcile_list_counts(uuid)', '377ee4c6d4f4d5ae66b070dc31748f44'),
      ('reconcile_list_counts(uuid)', '74302b4ce77f0ca64780a95a77032a4a')) THEN
      RAISE EXCEPTION 'reconcile_people_accounts: % body changed', f.sig;
    END IF;
  END LOOP;
  -- A table of this name that is not this one refuses rather than being read as the set.
  IF to_regclass('public.people_account_codes') IS NOT NULL AND (
       SELECT array_agg(attname::text ORDER BY attname::text) FROM pg_attribute
       WHERE attrelid = to_regclass('public.people_account_codes') AND attnum > 0 AND NOT attisdropped)
     IS DISTINCT FROM ARRAY['account_code','added_at','hidden_from_reconcile','labour','note'] THEN
    RAISE EXCEPTION 'reconcile_people_accounts: people_account_codes is not this migration''s table';
  END IF;
END
$guard$;

DO $table$
BEGIN
  IF to_regclass('public.people_account_codes') IS NULL THEN
    CREATE TABLE public.people_account_codes (
      account_code text PRIMARY KEY
        CHECK (account_code = btrim(account_code) AND account_code <> ''),
      labour boolean NOT NULL,
      hidden_from_reconcile boolean NOT NULL,
      note text NOT NULL CHECK (btrim(note) <> ''),
      added_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT people_account_codes_labour_is_hidden CHECK (NOT labour OR hidden_from_reconcile)
    );
    -- Seeded only here, at creation: a re-apply never restores a removed row or flag.
    INSERT INTO public.people_account_codes (account_code, labour, hidden_from_reconcile, note) VALUES
      ('301', true, true, 'Installer labour'),
      ('306', true, true, 'Installer labour'),
      ('475', false, true, 'Admin (Internal Subcontractors): labour billed outside the Trade App, not a labour kind');
  END IF;
END
$table$;

ALTER TABLE public.people_account_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.people_account_codes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.people_account_codes TO service_role;
COMMENT ON TABLE public.people_account_codes IS
  'People accounts. labour: a line on the code is a person''s labour (its kind and the labour stops; 301 and 306). hidden_from_reconcile: a document with a line on the code is never proposed by the matcher or credit step and never listed on Reconcile. A labour code is always hidden. One row per code; the owner''s answer changes a row, not code.';

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
  'Reconcile list (P2-03.6): one page of an org''s open items, not snoozed first; a document with a person''s labour line or a line on a hidden account (people_account_codes.hidden_from_reconcile), and a credit that follows one, left out. Read only.';

-- Open items per kind for one org: the tab counts. Same WHERE as a page
-- without the kind and cursor filters, so a count never promises an item the
-- list withholds (labour billed outside the Trade App, a document with a
-- labour line or a line on a people account, a credit that follows one).
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
  GROUP BY t.kind ORDER BY t.kind COLLATE "C"
$fn$;

COMMENT ON FUNCTION public.reconcile_list_counts(uuid) IS
  'Reconcile list (P2-03.6): open items per kind for one org, with the same items left out as a page. Read only.';

REVOKE ALL ON FUNCTION public.reconcile_list_page(uuid,text[],integer,jsonb),
  public.reconcile_list_counts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_list_page(uuid,text[],integer,jsonb),
  public.reconcile_list_counts(uuid) TO service_role;
