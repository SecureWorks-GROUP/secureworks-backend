-- P4-01.6 rollback: drop context_reconcile_raise, context_reconcile_withdraw,
-- and the eight-argument reconcile_item_raise overload, and restore P2-03.2's
-- seven-argument reconcile_item_raise body (20261118073218).
-- The four reconcile_item_kinds allow-list rows are intentionally left in place
-- because open reconcile_items rows may point at them.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DROP FUNCTION IF EXISTS public.context_reconcile_withdraw(text,text,text);
DROP FUNCTION IF EXISTS public.context_reconcile_raise(text,uuid,text,text,jsonb,text);

CREATE OR REPLACE FUNCTION public.reconcile_item_raise(
  text, text, text, uuid[], jsonb, jsonb, text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  p_kind ALIAS FOR $1;
  p_subject_table ALIAS FOR $2;
  p_subject_id ALIAS FOR $3;
  p_job_ids ALIAS FOR $4;
  p_suggestion ALIAS FOR $5;
  p_evidence ALIAS FOR $6;
  p_raised_by ALIAS FOR $7;
  v_reason text;
  v_amount numeric(12,2);
  v_date date;
  v_summary jsonb;
  v_hash text;
  v_org uuid;
  v_item public.reconcile_items%ROWTYPE;
  v_last public.reconcile_decisions%ROWTYPE;
  v_id uuid;
/* block */ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.reconcile_item_kinds k WHERE k.kind = p_kind) THEN
    RAISE EXCEPTION 'reconcile_kind_unknown' USING DETAIL = coalesce(p_kind, '(null)');
  END IF;
  IF nullif(btrim(coalesce(p_subject_table, '')), '') IS NULL
     OR nullif(btrim(coalesce(p_subject_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'reconcile_subject_required';
  END IF;
  IF nullif(btrim(coalesce(p_raised_by, '')), '') IS NULL THEN
    RAISE EXCEPTION 'reconcile_raised_by_required';
  END IF;

  IF p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object'
     OR jsonb_typeof(p_evidence -> 'reason') IS DISTINCT FROM 'string'
     OR btrim(p_evidence ->> 'reason') = '' THEN
    RAISE EXCEPTION 'reconcile_reason_required';
  END IF;
  v_reason := p_evidence ->> 'reason';

  IF coalesce(jsonb_typeof(p_evidence -> 'amount_ex'), 'null') NOT IN ('number', 'null') THEN
    RAISE EXCEPTION 'reconcile_evidence_invalid' USING DETAIL = 'amount_ex must be a number or null';
  END IF;
  v_amount := (p_evidence ->> 'amount_ex')::numeric(12,2);

  IF coalesce(jsonb_typeof(p_evidence -> 'document_date'), 'null') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'reconcile_evidence_invalid' USING DETAIL = 'document_date must be a date or null';
  END IF;
  /* block */ BEGIN
    v_date := (p_evidence ->> 'document_date')::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'reconcile_evidence_invalid' USING DETAIL = 'document_date must be a date or null';
  END;

  IF coalesce(jsonb_typeof(p_evidence -> 'summary'), 'null') NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'reconcile_evidence_invalid' USING DETAIL = 'summary must be an object';
  END IF;
  v_summary := coalesce(nullif(p_evidence -> 'summary', 'null'::jsonb), '{}'::jsonb);

  v_hash := md5(coalesce(p_evidence::text, '') || coalesce(p_suggestion::text, '')
                || coalesce(p_job_ids::text, ''));

  -- Organisation first: a refusal writes nothing, even to an open item.
  v_org := public.reconcile_item_org(p_subject_table, p_subject_id, p_job_ids);

  -- One raiser at a time per kind and subject, so two concurrent raises never
  -- race the partial unique index or the newest-decision read.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'reconcile_item_raise' || chr(31) || p_kind || chr(31) || p_subject_table
    || chr(31) || p_subject_id, 0));

  SELECT * INTO v_item FROM public.reconcile_items i
  WHERE i.kind = p_kind AND i.subject_table = p_subject_table
    AND i.subject_id = p_subject_id AND i.status = 'open'
  FOR UPDATE;

  IF FOUND THEN
    IF v_item.org_id <> v_org THEN
      RAISE EXCEPTION 'reconcile_org_ambiguous'
        USING DETAIL = 'open item belongs to another organisation';
    END IF;
    IF v_item.evidence_hash IS DISTINCT FROM v_hash THEN
      UPDATE public.reconcile_items SET
        job_ids = coalesce(p_job_ids, '{}'), reason = v_reason, amount_ex = v_amount,
        document_date = v_date, summary = v_summary, suggestion = p_suggestion,
        evidence = p_evidence, evidence_hash = v_hash
      WHERE id = v_item.id;
    END IF;
    RETURN v_item.id;
  END IF;

  SELECT * INTO v_last FROM public.reconcile_decisions d
  WHERE d.subject_kind = p_subject_table AND d.subject_id = p_subject_id
  ORDER BY d.decided_at DESC, d.id DESC
  LIMIT 1;
  IF FOUND AND v_last.org_id = v_org AND v_last."by" LIKE 'person:%'
     AND v_last.action NOT IN ('undo', 'leave') AND v_last.shown_hash = v_hash THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.reconcile_items(org_id, kind, subject_table, subject_id, job_ids,
    reason, amount_ex, document_date, summary, suggestion, evidence, evidence_hash, raised_by)
  VALUES (v_org, p_kind, p_subject_table, p_subject_id, coalesce(p_job_ids, '{}'),
    v_reason, v_amount, v_date, v_summary, p_suggestion, p_evidence, v_hash, p_raised_by)
  RETURNING id INTO v_id;
  RETURN v_id;
END $fn$;

DROP FUNCTION IF EXISTS public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text,uuid);

COMMENT ON FUNCTION public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text) IS
  'P2-03.2: the only writer that inserts reconcile_items. One open item per kind and subject; NULL when a person already decided on the same evidence hash. Organisation from the subject alone (cost document lines or the subject row); every named job must exist in it; refuses rather than guesses.';

REVOKE ALL ON FUNCTION public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)
  TO service_role;
