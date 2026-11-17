-- P2-03.2: reconcile_item_raise and reconcile_item_withdraw, the only way onto
-- and off the shared Reconcile list (reconcile_items, P2-03.1).
-- Creates functions only: no trigger, schedule, switch or historical write.
--
-- Allowed p_raised_by values (callers in every phase use one of these):
--   matcher:v1, migration, context:daily_list, answer_sheet,
--   phase1:work_order_gate, phase1:group_claim, phase1:division_tag,
--   phase3:books, phase4:context.
-- Another phase may wrap reconcile_item_raise but must end in exactly this call.
--
-- Organisation (director ruling, Follow-up 34 item 8). An item's org_id is
-- never passed in and never guessed:
--   * subject_table 'cost_document' (subject_id '<document_kind>:<document_id>'):
--     the org_id of that document's job_cost_lines rows;
--   * any other subject_table that is a public table with an org_id column and a
--     single-column primary key: that row's own org_id ('jobs' is one of these);
--   * any other subject: the org_id of the jobs in p_job_ids.
-- The jobs in p_job_ids are always read as well. If no organisation is found,
-- or the subject and the jobs name more than one, the raise refuses
-- (reconcile_org_unknown / reconcile_org_ambiguous) and writes nothing.
SET LOCAL lock_timeout = '5s';

-- Returns the one organisation of a subject, or raises. Index use:
-- job_cost_lines_document_idx (document_kind, document_id); the subject table's
-- primary key (the parameter is cast to the key's type, never the column);
-- jobs_pkey for id = ANY(p_job_ids).
CREATE OR REPLACE FUNCTION public.reconcile_item_org(
  p_subject_table text, p_subject_id text, p_job_ids uuid[])
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_orgs uuid[] := '{}';
  v_subject_org uuid;
  v_rel regclass;
  v_key name;
  v_key_type text;
  v_found boolean;
  v_kind text;
  v_doc text;
  v_cut int;
/* block */ BEGIN
  IF p_subject_table = 'cost_document' THEN
    v_cut := position(':' IN coalesce(p_subject_id, ''));
    IF v_cut > 1 THEN
      v_kind := left(p_subject_id, v_cut - 1);
      v_doc := substr(p_subject_id, v_cut + 1);
      SELECT coalesce(array_agg(DISTINCT l.org_id), '{}') INTO v_orgs
      FROM public.job_cost_lines l
      WHERE l.document_kind = v_kind AND l.document_id = v_doc;
    END IF;
  ELSE
    v_rel := to_regclass(format('public.%I', p_subject_table));
    IF v_rel IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                   WHERE c.oid = v_rel AND c.relkind IN ('r', 'p'))
       AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                   WHERE a.attrelid = v_rel AND a.attname = 'org_id'
                     AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype) THEN
      SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod)
        INTO v_key, v_key_type
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE i.indrelid = v_rel AND i.indisprimary AND i.indnkeyatts = 1;
      IF v_key IS NULL THEN
        RAISE EXCEPTION 'reconcile_org_unknown'
          USING DETAIL = format('%s has no single-column primary key', p_subject_table);
      END IF;
      /* block */ BEGIN
        EXECUTE format('SELECT true, t.org_id FROM public.%I t WHERE t.%I = $1::%s',
                       p_subject_table, v_key, v_key_type)
          INTO v_found, v_subject_org USING p_subject_id;
      EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range
                  OR invalid_datetime_format OR datetime_field_overflow THEN
        v_found := NULL;
      END;
      IF v_found IS NULL THEN
        RAISE EXCEPTION 'reconcile_org_unknown'
          USING DETAIL = format('%s row %s not found', p_subject_table, p_subject_id);
      END IF;
      IF v_subject_org IS NOT NULL THEN
        v_orgs := ARRAY[v_subject_org];
      END IF;
    END IF;
  END IF;

  IF coalesce(cardinality(p_job_ids), 0) > 0 THEN
    SELECT coalesce(array_agg(DISTINCT o.org_id), '{}') INTO v_orgs
    FROM (
      SELECT unnest(v_orgs) AS org_id
      UNION
      SELECT j.org_id FROM public.jobs j
      WHERE j.id = ANY(p_job_ids) AND j.org_id IS NOT NULL
    ) o;
  END IF;

  IF cardinality(v_orgs) = 0 THEN
    RAISE EXCEPTION 'reconcile_org_unknown'
      USING DETAIL = format('no organisation for %s %s', p_subject_table, p_subject_id);
  ELSIF cardinality(v_orgs) > 1 THEN
    RAISE EXCEPTION 'reconcile_org_ambiguous'
      USING DETAIL = format('%s %s spans %s organisations',
                            p_subject_table, p_subject_id, cardinality(v_orgs));
  END IF;
  RETURN v_orgs[1];
END $fn$;

-- The one way onto the list. Index use: reconcile_items_one_open (kind,
-- subject_table, subject_id WHERE open); reconcile_decisions_subject_idx
-- (subject_kind, subject_id, decided_at DESC, id DESC) for the newest decision.
CREATE OR REPLACE FUNCTION public.reconcile_item_raise(
  p_kind text, p_subject_table text, p_subject_id text, p_job_ids uuid[],
  p_suggestion jsonb, p_evidence jsonb, p_raised_by text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
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

-- The one way off the list without a person. Index: reconcile_items_one_open.
CREATE OR REPLACE FUNCTION public.reconcile_item_withdraw(
  p_kind text, p_subject_table text, p_subject_id text, p_reason text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_count int;
/* block */ BEGIN
  IF nullif(btrim(coalesce(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'reconcile_reason_required';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'reconcile_item_raise' || chr(31) || coalesce(p_kind, '') || chr(31)
    || coalesce(p_subject_table, '') || chr(31) || coalesce(p_subject_id, ''), 0));
  UPDATE public.reconcile_items SET
    status = 'withdrawn', closed_at = now(),
    summary = summary || jsonb_build_object('withdrawn_reason', p_reason)
  WHERE kind = p_kind AND subject_table = p_subject_table
    AND subject_id = p_subject_id AND status = 'open';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END $fn$;

COMMENT ON FUNCTION public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text) IS
  'P2-03.2: the only writer that inserts reconcile_items. One open item per kind and subject; NULL when a person already decided on the same evidence hash. Organisation from the subject row or its jobs; refuses rather than guesses.';
COMMENT ON FUNCTION public.reconcile_item_withdraw(text,text,text,text) IS
  'P2-03.2: closes the open item of a kind and subject without a person; true when a row changed.';

REVOKE ALL ON FUNCTION public.reconcile_item_org(text,text,uuid[]),
  public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text),
  public.reconcile_item_withdraw(text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_item_org(text,text,uuid[]),
  public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text),
  public.reconcile_item_withdraw(text,text,text,text)
  TO service_role;
