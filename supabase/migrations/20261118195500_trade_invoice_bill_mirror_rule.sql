-- Follow-up 66, mirror rule. One rule for "a trade invoice mirrors this
-- supplier bill", read by the 15-minute sync, the edge bills backfill and the
-- database twin. Before this, each held its own exact, case-sensitive,
-- org-filtered copy, and a trade invoice with no organisation read as "not a
-- mirror", so its bill was written as a cost line beside the trade lines.
--
-- trade_invoice_bill_mirror_verdicts(org, bill ids) answers one row per input
-- id, the id echoed exactly as given (callers then use an exact set):
--   mirror  a trade invoice of this organisation holds the bill id
--           (compared trimmed and case-insensitively);
--   stop    no trade invoice of this organisation holds it, but one with no
--           organisation does; or the organisation or the id is missing.
--           The caller writes nothing for that bill and counts it. A stop is
--           per bill: the rest of the page carries on;
--   none    nothing of this organisation or of none holds it (another
--           organisation's trade invoice is not ours).
-- A mirror and a stop are both skipped; they are counted apart.
--
-- The index makes each lookup an index probe. Building it locks writes to
-- trade_invoices for the build (thousands of rows; the 20261118023440 index
-- built the same way). Built-ins only (lower, btrim), so a write by any role
-- can maintain it.
--
-- The twin is replaced whole. Kept: every SET clause (search_path, the 5 s
-- lock_timeout its contract pins), every output key; added: mirrors_stopped.
-- Not changed: existing cost lines already written for a mirrored bill stay
-- (the census script counts them), the job close's draft-bill check
-- (20261115143000) and the two materials reads in xero-sync, which match any
-- organisation already.
--
-- The rollback goes with the application code: the sync and the edge backfill
-- call the verdict function.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Replace the twin only over a body we know: the live body from
-- 20261118195100 (md5 046d042bb6851f1b950f8372992c591e) or this migration's
-- own (f621ae0baea131618a8e94d842bd210e, a re-apply). Any other body, or no
-- twin at all, refuses before anything is written.
DO $guard$
DECLARE h text;
BEGIN
  SELECT md5(p.prosrc) INTO h FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.job_cost_lines_backfill_bills(uuid,date,date,integer,date,text)');
  IF h IS NULL OR h NOT IN ('046d042bb6851f1b950f8372992c591e', 'f621ae0baea131618a8e94d842bd210e') THEN
    RAISE EXCEPTION 'job_cost_lines_backfill_bills_body_changed';
  END IF;
END
$guard$;

CREATE INDEX IF NOT EXISTS trade_invoices_xero_bill_key_idx
  ON public.trade_invoices (lower(btrim(xero_bill_id)))
  WHERE xero_bill_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.trade_invoice_bill_mirror_verdicts(p_org_id uuid, p_bill_ids text[])
RETURNS TABLE (bill_id text, verdict text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT b.id,
    CASE
      WHEN p_org_id IS NULL OR nullif(btrim(b.id), '') IS NULL THEN 'stop'
      WHEN m.same_org THEN 'mirror'
      WHEN m.no_org THEN 'stop'
      ELSE 'none'
    END
  FROM unnest(p_bill_ids) WITH ORDINALITY AS b(id, n)
  LEFT JOIN LATERAL (
    -- trade_invoices_xero_bill_key_idx
    SELECT coalesce(bool_or(t.org_id = p_org_id), false) AS same_org,
           coalesce(bool_or(t.org_id IS NULL), false) AS no_org
      FROM public.trade_invoices t
     WHERE t.xero_bill_id IS NOT NULL
       AND lower(btrim(t.xero_bill_id)) = lower(btrim(b.id))
  ) m ON true
  ORDER BY b.n;
$$;
REVOKE ALL ON FUNCTION public.trade_invoice_bill_mirror_verdicts(uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trade_invoice_bill_mirror_verdicts(uuid, text[]) TO service_role;
COMMENT ON FUNCTION public.trade_invoice_bill_mirror_verdicts(uuid, text[]) IS
  'Follow-up 66: the one trade-invoice mirror rule for supplier bills. One row per input id, echoed as given: mirror (this organisation''s trade invoice holds it, trimmed and case-insensitive), stop (only a trade invoice with no organisation does, or the organisation or id is missing; write nothing, count it), none. Read by xero-sync (sync and bills backfill) and job_cost_lines_backfill_bills.';

CREATE OR REPLACE FUNCTION public.job_cost_lines_backfill_bills(
  p_org_id uuid, p_from date, p_to date, p_limit integer DEFAULT 200,
  p_before_date date DEFAULT NULL, p_before_id text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
-- A row-lock wait inside the writer (a sync writing the same bill) ends after
-- 5 s as lock_not_available, caught below as a clean busy stop.
SET lock_timeout = '5s'
AS $$
DECLARE
  super_on boolean; b record; doc jsonb; result jsonb;
  bills_read int := 0; mirrors int := 0; mirror_stops int := 0; documents int := 0; lines_written int := 0;
  docs_changed int := 0; busy boolean := false;
  next_date date := p_before_date; next_id text := p_before_id;
BEGIN
  IF p_org_id IS NULL OR p_from IS NULL OR p_to IS NULL OR p_from > p_to
     OR p_limit IS NULL OR p_limit < 1 OR p_limit > 200
     OR (p_before_date IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'bill_backfill_invalid_arguments: org, a from/to window, limit 1..200, and both cursor parts or neither';
  END IF;
  -- The edge action's two switches, read the same way. Nothing is turned on here.
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags
      WHERE flag_name = 'job_cost_lines_sync_v1' AND enabled) THEN
    RETURN jsonb_build_object('ran', false, 'reason', 'switch_off');
  END IF;
  super_on := EXISTS (SELECT 1 FROM public.feature_flags
    WHERE flag_name = 'job_cost_employer_super_v1' AND enabled);
  FOR b IN
    SELECT x.xero_invoice_id, x.invoice_date,
      (SELECT v.verdict FROM public.trade_invoice_bill_mirror_verdicts(p_org_id, ARRAY[x.xero_invoice_id]) v)
        AS mirror_verdict,
      jsonb_build_object('invoice_type', x.invoice_type, 'xero_invoice_id', x.xero_invoice_id,
        'status', x.status, 'invoice_number', x.invoice_number, 'invoice_date', x.invoice_date,
        'xero_contact_id', x.xero_contact_id, 'contact_name', x.contact_name,
        'fully_paid_on', x.fully_paid_on, 'line_items', x.line_items, 'sub_total', x.sub_total,
        'raw_json', jsonb_build_object('LineAmountTypes', x.raw_json->'LineAmountTypes')) AS bill
    FROM public.xero_invoices x
    WHERE x.org_id = p_org_id AND x.invoice_type = 'ACCPAY'
      AND x.invoice_date BETWEEN p_from AND p_to
      AND (p_before_date IS NULL OR (x.invoice_date, x.xero_invoice_id) < (p_before_date, p_before_id))
    ORDER BY x.invoice_date DESC, x.xero_invoice_id DESC
    LIMIT p_limit
  LOOP
    IF b.mirror_verdict = 'mirror' THEN
      mirrors := mirrors + 1;
    ELSIF b.mirror_verdict IS DISTINCT FROM 'none' THEN
      -- 'stop' (a trade invoice with no organisation holds this bill id) or no
      -- verdict at all: not written, never read as "not a mirror".
      mirror_stops := mirror_stops + 1;
    ELSE
      doc := public.job_cost_lines_bill_document(p_org_id, b.bill, super_on);
      BEGIN
        result := public.job_cost_lines_upsert_documents(jsonb_build_array(doc));
      EXCEPTION WHEN lock_not_available THEN
        -- The sync is writing this bill now: the writer's try-lock refused
        -- (cost_line_shadow_busy) or a row lock waited past lock_timeout. Stop
        -- here; the cursor stays before this bill so the next call starts with it.
        busy := true;
        EXIT;
      END;
      documents := documents + 1;
      lines_written := lines_written + coalesce((result->>'lines_written')::int, 0);
      docs_changed := docs_changed + coalesce(jsonb_array_length(result->'changed'), 0);
    END IF;
    bills_read := bills_read + 1;
    next_date := b.invoice_date; next_id := b.xero_invoice_id;
  END LOOP;
  RETURN jsonb_build_object('ran', true,
    'bills_read', bills_read, 'mirrors_skipped', mirrors, 'mirrors_stopped', mirror_stops, 'documents', documents,
    'lines_written', lines_written, 'documents_changed', docs_changed,
    'stopped', CASE WHEN busy THEN 'busy' END,
    -- done only on a short page that was not stopped. Otherwise call again with
    -- next_before (null next_before and done false means: from the window's top).
    'done', NOT busy AND bills_read < p_limit,
    'next_before', CASE WHEN NOT busy AND bills_read < p_limit THEN NULL
      WHEN next_date IS NULL THEN NULL
      ELSE jsonb_build_object('invoice_date', next_date, 'xero_invoice_id', next_id) END);
END;
$$;

REVOKE ALL ON FUNCTION public.job_cost_lines_backfill_bills(uuid, date, date, integer, date, text) FROM PUBLIC, anon, authenticated, service_role;
