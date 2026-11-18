-- P2-03.6 (Follow-up 66 lift): the page read behind ops-api reconcile_list.
-- PLACEHOLDER version: the keeper stamps the real one when the PR opens.
--
-- Adds one partial index on public.reconcile_items, two read-only functions
-- (a page and its per-kind counts) and the switch row reconcile_list_v1,
-- inserted off. No trigger, no schedule, no backfill, no other data write.
--
-- Lock on apply: CREATE INDEX holds a SHARE lock on public.reconcile_items
-- while it builds (reads go on, raises and decisions wait). The table holds
-- open and closed Reconcile items only, so the build is short; lock_timeout
-- makes a busy table fail the apply instead of queueing writers behind it.
--
-- Order of a page (the spec's order, indexable): items not snoozed first,
-- then snoozed; inside each, amount_ex DESC NULLS LAST, raised_at, id. Each
-- half is one ordered scan of reconcile_items_open_page_idx (org, open), so a
-- page reads at most limit + 1 rows per half. "Snoozed" is read at the
-- statement's now(), so an item whose snooze ends between two pages can be
-- seen twice or not at all on that walk; the screen reads the list again
-- after every decision.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $guard$
DECLARE v_def text; v_comment text; v_fn text;
BEGIN
  IF to_regclass('public.reconcile_items') IS NULL
     OR to_regclass('public.reconcile_item_kinds') IS NULL THEN
    RAISE EXCEPTION 'reconcile_list_page: reconcile tables (20261118060051) are missing';
  END IF;
  -- Pre-image: the index name is ours or free.
  SELECT pg_get_indexdef(to_regclass('public.reconcile_items_open_page_idx')) INTO v_def;
  IF v_def IS NOT NULL AND v_def <> 'CREATE INDEX reconcile_items_open_page_idx ON public.reconcile_items USING btree (org_id, amount_ex DESC NULLS LAST, raised_at, id) WHERE (status = ''open''::text)' THEN
    RAISE EXCEPTION 'reconcile_list_page: index reconcile_items_open_page_idx exists with another definition';
  END IF;
  -- Pre-image: each function is absent or this migration's own body.
  FOREACH v_fn IN ARRAY ARRAY['public.reconcile_list_page(uuid,text[],integer,jsonb)',
                              'public.reconcile_list_counts(uuid)'] LOOP
    IF to_regprocedure(v_fn) IS NOT NULL THEN
      SELECT obj_description(to_regprocedure(v_fn), 'pg_proc') INTO v_comment;
      IF coalesce(v_comment, '') NOT LIKE 'Reconcile list (P2-03.6)%' THEN
        RAISE EXCEPTION 'reconcile_list_page: % exists and is not this migration''s', v_fn;
      END IF;
    END IF;
  END LOOP;
END
$guard$;

CREATE INDEX IF NOT EXISTS reconcile_items_open_page_idx
  ON public.reconcile_items (org_id, amount_ex DESC NULLS LAST, raised_at, id)
  WHERE status = 'open';

COMMENT ON INDEX public.reconcile_items_open_page_idx IS
  'Reconcile list (P2-03.6): one org''s open items in page order; also the per-kind counts.';

-- One page of one org's open items of the given kinds. p_after is the
-- previous page's last row as {snoozed, amount_ex, raised_at, id}; null is
-- the first page. Returns at most least(greatest(p_limit,1),100) + 1 rows:
-- the extra row only says another page exists.
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
  'Reconcile list (P2-03.6): one page of an org''s open items, not snoozed first. Read only.';

-- Open items per kind for one org: the tab counts. Same WHERE as a page
-- without the kind and cursor filters.
CREATE OR REPLACE FUNCTION public.reconcile_list_counts(p_org uuid)
RETURNS TABLE (kind text, open bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT t.kind, count(*) FROM public.reconcile_items t
  WHERE t.org_id = p_org AND t.status = 'open'
  GROUP BY t.kind ORDER BY t.kind COLLATE "C"
$fn$;

COMMENT ON FUNCTION public.reconcile_list_counts(uuid) IS
  'Reconcile list (P2-03.6): open items per kind for one org. Read only.';

REVOKE ALL ON FUNCTION public.reconcile_list_page(uuid,text[],integer,jsonb),
  public.reconcile_list_counts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_list_page(uuid,text[],integer,jsonb),
  public.reconcile_list_counts(uuid) TO service_role;

INSERT INTO public.feature_flags(flag_name, enabled, description)
VALUES ('reconcile_list_v1', false,
  'ops-api reconcile_list (P2-03.6): staff read of the Reconcile cost list. Seeded off; off answers before any read.')
ON CONFLICT (flag_name) DO NOTHING;
