-- P4-01.6: one door from Phase 4 onto the shared Reconcile list.
-- Creates functions and seeds four allow-list kinds only: no table, column,
-- constraint, trigger, schedule, switch change or operational row write.
--
-- Director ruling (18 Nov 2026, 11:34):
--   * context_reconcile_raise resolves the organisation from the subject row's
--     job and passes it in; no job and no ZZTEST fallback rule means a plain
--     reconcile_org_unknown refusal.
--   * Authorised exception: reconcile_item_raise gains an optional explicit
--     organisation argument, used only when reconcile_item_org cannot resolve
--     one, and verified to equal every given job's organisation. Existing
--     seven-argument callers stay unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Rule 15 / 21b pre-image and install guard: verify live's reconcile_item_org
-- and seven-argument reconcile_item_raise bodies (20261118073218), allow this
-- migration's own post-images so re-applying is a no-op, and refuse any other
-- body or unexpected signature.
DO $guard$
DECLARE
  v_org_md5 text;
  r record;
/* block */ BEGIN
  SELECT md5(p.prosrc) INTO v_org_md5
  FROM pg_catalog.pg_proc p
  WHERE p.oid = pg_catalog.to_regprocedure('public.reconcile_item_org(text,text,uuid[])');
  IF v_org_md5 IS DISTINCT FROM 'fa85b3c742dd44faf0d8f9fe1716597f' THEN
    RAISE EXCEPTION 'p4_01_6_preimage_mismatch: reconcile_item_org(text,text,uuid[]) (%)',
      coalesce(v_org_md5, 'missing');
  END IF;

  IF pg_catalog.to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'p4_01_6_preimage_mismatch: reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text) (missing)';
  END IF;

  FOR r IN
    SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS body
    FROM pg_catalog.pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('reconcile_item_raise', 'context_reconcile_raise', 'context_reconcile_withdraw')
  LOOP
    IF (r.sig, r.body) NOT IN (
      ('reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)', '24c912f38faed264b7bf1f42073778f6'),
      ('reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)', '4ebccf3ce90ef31bcb82051fae2dc24d'),
      ('reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text,uuid)', '3597c5262e1a4ece00de00b273a2bb3d'),
      ('context_reconcile_raise(text,uuid,text,text,jsonb,text)', '0423a53d38fcc747dc8190f9c1f82918'),
      ('context_reconcile_withdraw(text,text,text)', '175bdf4410e54c698b605b390b4a64da')
    ) THEN
      RAISE EXCEPTION 'p4_01_6_preimage_mismatch: % (%)', r.sig, r.body;
    END IF;
  END LOOP;
END $guard$;

-- Step 1: ensure Phase 4's four kinds exist on the allow-list when present.
DO $kinds$
/* block */ BEGIN
  IF pg_catalog.to_regclass('public.reconcile_item_kinds') IS NOT NULL THEN
    INSERT INTO public.reconcile_item_kinds (kind, tab, words, card) VALUES
      ('message_no_job', 'messages', 'Message on no job', 'generic'),
      ('open_item_check', 'other', 'Open item to check', 'generic'),
      ('agent_money_proposal', 'other', 'Money step proposed by an agent', 'generic'),
      ('ai_job_failed', 'other', 'An AI job failed', 'generic')
    ON CONFLICT (kind) DO NOTHING;
  END IF;
END $kinds$;

-- Authorised list-writer extension: optional explicit organisation ($8), used
-- only when reconcile_item_org raises reconcile_org_unknown on a real subject
-- relation, and checked against every job in p_job_ids via jobs_pkey.
-- Index use: reconcile_item_org's indexes, jobs_pkey for id = ANY(p_job_ids),
-- reconcile_items_one_open, and reconcile_decisions_subject_idx.
CREATE OR REPLACE FUNCTION public.reconcile_item_raise(
  text, text, text, uuid[], jsonb, jsonb, text, uuid)
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
  p_org_id ALIAS FOR $8;
  v_reason text;
  v_amount numeric(12,2);
  v_date date;
  v_summary jsonb;
  v_hash text;
  v_org uuid;
  v_jobs_found int;
  v_jobs_foreign int;
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
  /* date_block */ BEGIN
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
  -- p_org_id is used only when reconcile_item_org cannot resolve one, and must
  -- equal every given job's organisation.
  /* org_block */ BEGIN
    v_org := public.reconcile_item_org(p_subject_table, p_subject_id, p_job_ids);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'reconcile_org_unknown' AND p_org_id IS NOT NULL
       AND (p_subject_table = 'cost_document'
            OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                       WHERE c.oid = pg_catalog.to_regclass(pg_catalog.format('public.%I', p_subject_table))
                         AND c.relkind IN ('r', 'p'))) THEN
      v_org := p_org_id;
      IF coalesce(cardinality(p_job_ids), 0) > 0 THEN
        IF array_position(p_job_ids, NULL) IS NOT NULL THEN
          RAISE EXCEPTION 'reconcile_job_unknown' USING DETAIL = 'a job id is null';
        END IF;
        SELECT count(*), count(*) FILTER (WHERE j.org_id IS DISTINCT FROM v_org)
          INTO v_jobs_found, v_jobs_foreign
        FROM public.jobs j WHERE j.id = ANY(p_job_ids);
        IF v_jobs_found < (SELECT count(DISTINCT x) FROM unnest(p_job_ids) x) THEN
          RAISE EXCEPTION 'reconcile_job_unknown'
            USING DETAIL = format('%s of the jobs named for %s %s do not exist',
              (SELECT count(DISTINCT x) FROM unnest(p_job_ids) x) - v_jobs_found,
              p_subject_table, p_subject_id);
        END IF;
        IF v_jobs_foreign > 0 THEN
          RAISE EXCEPTION 'reconcile_org_ambiguous'
            USING DETAIL = format('a job named for %s %s is in another organisation',
                                  p_subject_table, p_subject_id);
        END IF;
      END IF;
    ELSE
      RAISE;
    END IF;
  END;

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

-- Seven-argument entry point: positional signature preserved for existing
-- callers and transaction-scoped test stand-ins; delegates with NULL p_org_id.
CREATE OR REPLACE FUNCTION public.reconcile_item_raise(
  text, text, text, uuid[], jsonb, jsonb, text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
/* block */ BEGIN
  RETURN public.reconcile_item_raise($1, $2, $3, $4, $5, $6, $7, NULL::uuid);
END $fn$;

COMMENT ON FUNCTION public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text) IS
  'P2-03.2: the only writer that inserts reconcile_items. One open item per kind and subject; NULL when a person already decided on the same evidence hash. Organisation from the subject alone (cost document lines or the subject row); every named job must exist in it; refuses rather than guesses.';
COMMENT ON FUNCTION public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text,uuid) IS
  'P2-03.2 / P4-01.6: reconcile_item_raise with an optional explicit organisation used only when reconcile_item_org cannot resolve one, verified against every given job.';

REVOKE ALL ON FUNCTION public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text),
  public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text),
  public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text,uuid)
  TO service_role;

-- Step 2: Phase 4's single door onto the Reconcile list.
-- Index use: business_events_pkey, context_ledger_items_pkey,
-- agent_action_proposals_pkey, context_ai_calls_pkey (parameter cast to the
-- primary key's type), and jobs_pkey for job_number and organisation lookups.
CREATE OR REPLACE FUNCTION public.context_reconcile_raise(
  p_kind text,
  p_job_id uuid,
  p_subject text,
  p_summary text,
  p_suggestions jsonb DEFAULT '[]'::jsonb,
  p_reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_subject_table text;
  v_default_reason text;
  v_records jsonb;
  v_evidence jsonb;
  v_suggestion jsonb;
  v_job_ids uuid[];
  v_subject_uuid uuid;
  v_subject_bigint bigint;
  v_subject_job_id uuid;
  v_candidate_job_ids uuid[];
  v_orgs uuid[];
  v_jobs_found int;
  v_jobs_null_org int;
  v_org uuid;
  v_id uuid;
/* block */ BEGIN
  CASE p_kind
    WHEN 'message_no_job' THEN
      v_subject_table := 'business_events';
      v_default_reason := 'ai_none_of_these';
    WHEN 'open_item_check' THEN
      v_subject_table := 'context_ledger_items';
      v_default_reason := 'more_than_one_record';
    WHEN 'agent_money_proposal' THEN
      v_subject_table := 'agent_action_proposals';
      v_default_reason := 'waiting_for_press';
    WHEN 'ai_job_failed' THEN
      v_subject_table := 'context_ai_calls';
      v_default_reason := 'ai_job_failed';
    ELSE
      RAISE EXCEPTION 'context_reconcile_raise_bad_kind';
  END CASE;

  IF nullif(btrim(coalesce(p_summary, '')), '') IS NULL THEN
    RAISE EXCEPTION 'context_reconcile_raise_summary_required';
  END IF;
  IF p_summary ~ '\$\s*\d' THEN
    RAISE EXCEPTION 'context_reconcile_raise_money';
  END IF;

  v_records := CASE
    WHEN p_suggestions IS NULL OR jsonb_typeof(p_suggestions) = 'null' THEN '[]'::jsonb
    ELSE p_suggestions
  END;
  IF jsonb_typeof(v_records) <> 'array' THEN
    RAISE EXCEPTION 'context_reconcile_raise_suggestions_invalid';
  END IF;

  v_job_ids := CASE WHEN p_job_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[p_job_id] END;
  v_evidence := jsonb_build_object(
    'reason', coalesce(nullif(btrim(p_reason), ''), v_default_reason),
    'summary', jsonb_build_object(
      'text', p_summary,
      'job_number', CASE WHEN p_job_id IS NOT NULL THEN (SELECT j.job_number FROM public.jobs j WHERE j.id = p_job_id) END,
      'records', v_records
    )
  );
  v_suggestion := CASE
    WHEN jsonb_array_length(v_records) > 0 THEN jsonb_build_object('candidates', v_records)
  END;

  IF pg_catalog.to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text,uuid)') IS NULL
     AND pg_catalog.to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)') IS NULL THEN
    RETURN NULL;
  END IF;

  IF pg_catalog.to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text,uuid)') IS NULL THEN
    EXECUTE 'SELECT public.reconcile_item_raise($1,$2,$3,$4,$5,$6,$7)'
      INTO v_id
      USING p_kind, v_subject_table, p_subject, v_job_ids, v_suggestion, v_evidence, 'phase4:context';
    RETURN v_id;
  END IF;

  -- Resolve the organisation from the subject row's job only; never guess.
  IF p_kind = 'ai_job_failed' THEN
    /* cast_bigint */ BEGIN
      v_subject_bigint := nullif(btrim(coalesce(p_subject, '')), '')::bigint;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      v_subject_bigint := NULL;
    END;
    IF v_subject_bigint IS NOT NULL
       AND pg_catalog.to_regclass('public.context_ai_calls') IS NOT NULL THEN
      SELECT t.job_id INTO v_subject_job_id
      FROM public.context_ai_calls t WHERE t.id = v_subject_bigint;
    END IF;
  ELSE
    /* cast_uuid */ BEGIN
      v_subject_uuid := nullif(btrim(coalesce(p_subject, '')), '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_subject_uuid := NULL;
    END;
    IF v_subject_uuid IS NOT NULL THEN
      IF p_kind = 'open_item_check'
         AND pg_catalog.to_regclass('public.context_ledger_items') IS NOT NULL THEN
        SELECT t.job_id INTO v_subject_job_id
        FROM public.context_ledger_items t WHERE t.id = v_subject_uuid;
      ELSIF p_kind = 'agent_money_proposal'
            AND pg_catalog.to_regclass('public.agent_action_proposals') IS NOT NULL THEN
        SELECT t.job_id INTO v_subject_job_id
        FROM public.agent_action_proposals t WHERE t.id = v_subject_uuid;
      ELSIF p_kind = 'message_no_job'
            AND pg_catalog.to_regclass('public.business_events') IS NOT NULL THEN
        SELECT t.job_id, t.candidate_job_ids
          INTO v_subject_job_id, v_candidate_job_ids
        FROM public.business_events t WHERE t.id = v_subject_uuid;
      END IF;
    END IF;
  END IF;

  IF v_subject_job_id IS NOT NULL THEN
    SELECT j.org_id INTO v_org FROM public.jobs j WHERE j.id = v_subject_job_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reconcile_job_unknown'
        USING DETAIL = format('subject %s %s job not found', v_subject_table, p_subject);
    END IF;
  ELSIF p_kind = 'message_no_job' AND coalesce(cardinality(v_candidate_job_ids), 0) > 0 THEN
    IF array_position(v_candidate_job_ids, NULL) IS NOT NULL THEN
      RAISE EXCEPTION 'reconcile_job_unknown'
        USING DETAIL = format('business_events %s has a null candidate job', p_subject);
    END IF;
    SELECT count(*),
           count(*) FILTER (WHERE j.org_id IS NULL),
           coalesce(array_agg(DISTINCT j.org_id) FILTER (WHERE j.org_id IS NOT NULL), '{}')
      INTO v_jobs_found, v_jobs_null_org, v_orgs
    FROM public.jobs j WHERE j.id = ANY(v_candidate_job_ids);
    IF v_jobs_found < (SELECT count(DISTINCT x) FROM unnest(v_candidate_job_ids) x) THEN
      RAISE EXCEPTION 'reconcile_job_unknown'
        USING DETAIL = format('candidate job missing for business_events %s', p_subject);
    END IF;
    IF v_jobs_null_org = 0 THEN
      IF cardinality(v_orgs) > 1 THEN
        RAISE EXCEPTION 'reconcile_org_ambiguous'
          USING DETAIL = format('business_events %s spans %s organisations', p_subject, cardinality(v_orgs));
      ELSIF cardinality(v_orgs) = 1 THEN
        v_org := v_orgs[1];
      END IF;
    END IF;
  END IF;

  EXECUTE 'SELECT public.reconcile_item_raise($1,$2,$3,$4,$5,$6,$7,$8)'
    INTO v_id
    USING p_kind, v_subject_table, p_subject, v_job_ids, v_suggestion, v_evidence, 'phase4:context', v_org;
  RETURN v_id;
END $fn$;

-- Step 3: Phase 4's withdraw door onto the Reconcile list.
CREATE OR REPLACE FUNCTION public.context_reconcile_withdraw(
  p_kind text,
  p_subject text,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_subject_table text;
  v_done boolean;
/* block */ BEGIN
  CASE p_kind
    WHEN 'message_no_job' THEN v_subject_table := 'business_events';
    WHEN 'open_item_check' THEN v_subject_table := 'context_ledger_items';
    WHEN 'agent_money_proposal' THEN v_subject_table := 'agent_action_proposals';
    WHEN 'ai_job_failed' THEN v_subject_table := 'context_ai_calls';
    ELSE RAISE EXCEPTION 'context_reconcile_raise_bad_kind';
  END CASE;

  IF pg_catalog.to_regprocedure('public.reconcile_item_withdraw(text,text,text,text)') IS NULL THEN
    RETURN false;
  END IF;

  EXECUTE 'SELECT public.reconcile_item_withdraw($1,$2,$3,$4)'
    INTO v_done
    USING p_kind, v_subject_table, p_subject, p_reason;
  RETURN coalesce(v_done, false);
END $fn$;

COMMENT ON FUNCTION public.context_reconcile_raise(text,uuid,text,text,jsonb,text) IS
  'P4-01.6: Phase 4 door onto reconcile_item_raise. Maps the four Phase 4 kinds to their subject tables and default reasons, blocks dollar amounts in summary text, resolves the organisation from the subject row''s job, and returns NULL when the Reconcile list is not yet installed.';
COMMENT ON FUNCTION public.context_reconcile_withdraw(text,text,text) IS
  'P4-01.6: Phase 4 door onto reconcile_item_withdraw. Maps the four Phase 4 kinds to their subject tables and returns false when the Reconcile list is not yet installed.';

REVOKE ALL ON FUNCTION public.context_reconcile_raise(text,uuid,text,text,jsonb,text),
  public.context_reconcile_withdraw(text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_reconcile_raise(text,uuid,text,text,jsonb,text),
  public.context_reconcile_withdraw(text,text,text)
  TO service_role;
