-- Job Profit (finish-line row A6, 3 Nov 2026): a job with no expected cost names the document that would fix it and
-- who holds it, instead of a bare "not known".
--
-- Why: v_job_profit takes a job's expected cost (labour + materials + commission, ex GST) only from a document that
-- states our cost: the freeze written at acceptance, the accepted or newest sent quote revision's cost record, or the
-- newest sealed patio scope revision (switch job_profit_patio_expected_from_frozen_scope). On 3 Nov 2026 (read only)
-- 381 of 433 live jobs had none of those: 311 make-safe, 25 repair, 36 patio, 5 fence, 3 miscellaneous, 1 insurance.
-- Job Profit showed them as a blank, so nobody could tell which document was missing or who should supply it.
-- Read for row A6 (12 of its 20 live jobs): every make-safe and repair job holds only documents that set what the
-- builder pays us (the builder's works order, the make-safe invoice basis priced on the builder's schedule of rates
-- and the make-safe materials rate card, which are sell prices), and no live make-safe or repair job has a job work
-- order with a labour allowance, a quote revision or a sealed scope. So no document in the business states a builder
-- job's expected cost today, and none is derived here: a sell price is never an expected cost, and a job's own bills
-- are never its expected cost.
--
-- Change:
--   * New function job_profit_expected_cost_missing(job_id) returns {code, document, holder} for a job, read only:
--       sealed_scope_switch_off        a sealed patio revision is on the job but the switch that reads it is off
--       sealed_scope_rate_missing      the newest sealed patio revision has a missing rate (the guard of 2 Nov)
--       sealed_scope_line_without_cost the newest sealed patio revision sells a line at no cost (the guard of 2 Nov)
--       sealed_scope_not_priced        the newest sealed patio revision has no final cost figures
--       no_current_sealed_scope        every sealed patio revision on the job is superseded
--       quote_without_cost_record      a quote was sent, but no quote revision with cost figures is stored for it
--       builder_job_no_costing         make-safe or insurance job, or a repair job from a builder (works order or
--                                      requesting company): the builder's documents are sell prices
--       no_contract                    a build (SWB) with no contract, quote or sealed scope
--       no_sealed_scope                a patio job with no quote and no sealed scope
--       no_quote                       a fence job with no sent quote
--       no_costing                     any other job with no quote or costed work order
--   * v_job_profit gains one last column, expected_cost_missing (jsonb): that answer when expected_source is null,
--     else null. Nothing else in the view changes: no expected cost, actual cost, profit, margin or flag moves.
--     The Job Profit page and the job API read the row with select *, so the column reaches them as it is.
-- Holders are named from the business's own records: Shaun approves job work orders (work_order_settings, captain
-- 6 Oct 2026); the job work order's labour as expected labour is Marnin's 21 Oct decision (Job Profit CALLS JP-19.8),
-- which no builder job carries yet and which v_job_profit does not read yet; the patio switch is Marnin's.
--
-- Guard: v_job_profit must be the definition this was written against (md5 44c5f76f..., 20261103171500 as applied).
-- The function is new; if one by this name exists it must be this exact definition.
-- Rehearsed in production 3 Nov 2026 14:00Z, this file byte for byte inside one transaction ended by RAISE EXCEPTION
-- (nothing kept; a plain read after showed md5 44c5f76f and no function): applied, applied again (no change), rolled
-- back (view, grants, comments and job_profit(uuid) exactly as before) and applied again. 0 of 2,008 job rows changed
-- any figure, flag or source; 1,517 jobs with no expected cost (381 live) each name a document, none beside a figure.
-- Rollback: supabase/rollbacks/20261104080000_job_profit_expected_cost_missing_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
-- The view's text carries a timestamp, which prints in the session's time zone; the md5 guard is taken in UTC.
SET LOCAL TimeZone = 'UTC';

DO $guard$
DECLARE
  v_md5 text := md5(pg_get_viewdef('public.v_job_profit'::regclass, true));
BEGIN
  IF v_md5 NOT IN ('44c5f76f8fe56c656faee0fc1286a89b', '87cf36d110e184372e1707a4ff9e942e') THEN
    RAISE EXCEPTION 'v_job_profit is not the definition this migration was written against (md5 %)', v_md5;
  END IF;
  -- to_regprocedure, never a ::regprocedure literal: the literal is resolved when the statement is planned, so it
  -- would fail on a database where the function does not exist yet.
  IF to_regprocedure('public.job_profit_expected_cost_missing(uuid)') IS NOT NULL THEN
    IF md5(pg_get_functiondef(to_regprocedure('public.job_profit_expected_cost_missing(uuid)'))) <> '0c37d911341d324b45d164c9955e64a5' THEN
      RAISE EXCEPTION 'job_profit_expected_cost_missing(uuid) exists and is not this migration''s definition (md5 %)',
        md5(pg_get_functiondef(to_regprocedure('public.job_profit_expected_cost_missing(uuid)')));
    END IF;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.job_profit_expected_cost_missing(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  j record;
  v_rev record;
  v_doc record;
  v_pj jsonb;
  v_n text;
  v_list text;
  v_on_job text[] := ARRAY[]::text[];
  v_payer text;
  v_scoper constant text := 'The salesperson who scoped it, in the patio tool (Scope Engine)';
BEGIN
  -- The builder's own name (makesafe_companies), else the name the intake wrote (sometimes only a short code).
  SELECT jb.id, jb.type, jb.job_number, jb.pricing_json,
         COALESCE(NULLIF(btrim(mc.name), ''), NULLIF(btrim(md.requesting_company_name), '')) AS payer
    INTO j
    FROM jobs jb
    LEFT JOIN makesafe_job_details md ON md.job_id = jb.id
    LEFT JOIN makesafe_companies mc ON mc.id = md.requesting_company_id
   WHERE jb.id = p_job_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- 1. A sealed patio scope revision is on the job but v_job_profit cannot read it: say exactly why.
  IF j.type = 'patio' THEN
    SELECT s.revision_number, s.scope_canonical_text, s.pricing_canonical_text
      INTO v_rev
      FROM scope_revisions s
     WHERE s.job_id = p_job_id AND s.status = 'frozen' AND s.tool_kind = 'patio'
     ORDER BY s.revision_number DESC
     LIMIT 1;
    IF FOUND THEN
      v_n := 'Sealed scope revision ' || v_rev.revision_number;
      IF NOT EXISTS (SELECT 1 FROM feature_flags ff
                      WHERE ff.flag_name = 'job_profit_patio_expected_from_frozen_scope' AND ff.enabled) THEN
        RETURN jsonb_build_object('code', 'sealed_scope_switch_off',
          'document', v_n || ' is on the job, but Job Profit reads sealed patio revisions only while its switch is on',
          'holder', 'Marnin (the switch job_profit_patio_expected_from_frozen_scope is his)');
      END IF;
      -- The same cost figures v_job_profit's frozen_scope_rev reads: the old tool's _pricing_json, else a new-tool
      -- revision whose pricing is final.
      v_pj := COALESCE(job_profit_safe_jsonb(v_rev.scope_canonical_text) -> '_pricing_json',
        CASE
          WHEN job_profit_safe_jsonb(v_rev.scope_canonical_text) @> '{"tool": "patio-scoper", "revision": {"outputsAgree": true}}'::jsonb
           AND job_profit_safe_jsonb(v_rev.pricing_canonical_text) @> '{"tool": "patio-scoper", "pricing_complete": true, "revision": {"sealed": true}}'::jsonb
           AND NOT job_profit_safe_jsonb(v_rev.pricing_canonical_text) @> '{"internal": {"costs_complete": false}}'::jsonb
           AND (job_profit_safe_jsonb(v_rev.pricing_canonical_text) -> 'sell_to_confirm') = '[]'::jsonb
           AND jsonb_typeof(job_profit_safe_jsonb(v_rev.scope_canonical_text) #> '{revision,n}') = 'number'
           AND COALESCE(job_profit_safe_jsonb(v_rev.scope_canonical_text) #>> '{revision,frozenId}', '') <> ''
           AND (job_profit_safe_jsonb(v_rev.scope_canonical_text) #>> '{revision,frozenId}')
               = (job_profit_safe_jsonb(v_rev.pricing_canonical_text) #>> '{revision,frozenId}')
           AND job_profit_num(job_profit_safe_jsonb(v_rev.pricing_canonical_text) -> 'labourCostEstimate') >= 0
           AND job_profit_num(job_profit_safe_jsonb(v_rev.pricing_canonical_text) -> 'materialCostEstimate') >= 0
           AND job_profit_num(job_profit_safe_jsonb(v_rev.pricing_canonical_text) -> 'totalCostEstimate')
               >= job_profit_num(job_profit_safe_jsonb(v_rev.pricing_canonical_text) -> 'labourCostEstimate')
                + job_profit_num(job_profit_safe_jsonb(v_rev.pricing_canonical_text) -> 'materialCostEstimate')
          THEN jsonb_build_object(
            'labourCostEstimate', job_profit_num(job_profit_safe_jsonb(v_rev.pricing_canonical_text) -> 'labourCostEstimate'),
            'materialCostEstimate', job_profit_num(job_profit_safe_jsonb(v_rev.pricing_canonical_text) -> 'totalCostEstimate')
              - job_profit_num(job_profit_safe_jsonb(v_rev.pricing_canonical_text) -> 'labourCostEstimate'))
        END);
      IF GREATEST(COALESCE(job_profit_num(v_pj -> 'labourCostEstimate'), 0),
                  COALESCE(job_profit_num(v_pj -> 'materialCostEstimate'), 0)) <= 0 THEN
        RETURN jsonb_build_object('code', 'sealed_scope_not_priced',
          'document', v_n || ' with its final cost figures: it carries none (its pricing is not final or states no labour or materials cost)',
          'holder', v_scoper);
      END IF;
      SELECT string_agg(DISTINCT COALESCE(NULLIF(btrim(w.value ->> 'context'), ''), w.value ->> 'code'), '; ')
        INTO v_list
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_pj -> 'pricing_warnings') = 'array'
                                       THEN v_pj -> 'pricing_warnings' ELSE '[]'::jsonb END) w(value)
       WHERE (w.value ->> 'code') ILIKE '%RATE_MISSING%';
      IF v_list IS NOT NULL THEN
        RETURN jsonb_build_object('code', 'sealed_scope_rate_missing',
          'document', v_n || ' sealed again with every rate: a rate is missing for ' || v_list,
          'holder', v_scoper);
      END IF;
      SELECT string_agg(DISTINCT btrim(li.value ->> 'description'), '; ')
        INTO v_list
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_pj -> 'line_items') = 'array'
                                       THEN v_pj -> 'line_items' ELSE '[]'::jsonb END) li(value)
       WHERE COALESCE(job_profit_num(li.value -> 'total_sell'), 0) > 0
         AND COALESCE(job_profit_num(li.value -> 'total_cost'), 0) <= 0;
      IF v_list IS NOT NULL THEN
        RETURN jsonb_build_object('code', 'sealed_scope_line_without_cost',
          'document', v_n || ' sealed again with a cost on every selling line: ' || v_list || ' sells with no cost',
          'holder', v_scoper);
      END IF;
      RETURN jsonb_build_object('code', 'sealed_scope_not_priced',
        'document', v_n || ' with its final cost figures',
        'holder', v_scoper);
    END IF;
    IF EXISTS (SELECT 1 FROM scope_revisions s
                WHERE s.job_id = p_job_id AND s.tool_kind = 'patio' AND s.status = 'superseded') THEN
      RETURN jsonb_build_object('code', 'no_current_sealed_scope',
        'document', 'A current sealed scope revision: every sealed revision on the job is superseded',
        'holder', v_scoper);
    END IF;
  END IF;

  -- 2. A quote went to the customer, but no quote revision with cost figures is stored for it.
  SELECT d.quote_number, d.version, d.sent_at
    INTO v_doc
    FROM job_documents d
   WHERE d.job_id = p_job_id AND d.type = 'quote' AND d.sent_at IS NOT NULL AND d.declined_at IS NULL
   ORDER BY d.sent_at DESC
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('code', 'quote_without_cost_record',
      'document', 'The cost record behind quote ' || COALESCE(NULLIF(btrim(v_doc.quote_number), ''), 'v' || v_doc.version)
        || ' sent ' || to_char(v_doc.sent_at AT TIME ZONE 'Australia/Perth', 'FMDD Mon YYYY')
        || ': the tool that sent it stored no cost figures, and the job''s live pricing is not a fixed document',
      'holder', 'The salesperson who quoted it (seal the quote the customer has in Scope Engine)');
  END IF;

  -- 3. Make-safe, repair and insurance work: the builder's documents set what the builder pays us, not our cost.
  IF EXISTS (SELECT 1 FROM job_documents d WHERE d.job_id = p_job_id AND d.type = 'work_order') THEN
    v_on_job := v_on_job || 'the builder''s works order'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM makesafe_docket_revisions r WHERE r.job_id = p_job_id) THEN
    v_on_job := v_on_job || 'the make-safe invoice basis (the builder''s schedule of rates)'::text;
  END IF;
  IF j.type IN ('makesafe', 'insurance')
     OR (j.type = 'repair' AND (cardinality(v_on_job) > 0 OR j.payer IS NOT NULL)) THEN
    v_payer := COALESCE(j.payer, 'the builder');
    RETURN jsonb_build_object('code', 'builder_job_no_costing',
      'document', 'Our cost estimate for this job (labour, materials and any commission). No costing document exists for builder jobs'
        || CASE WHEN cardinality(v_on_job) > 0
                THEN ': ' || array_to_string(v_on_job, ' and ') || ' on the job '
                     || CASE WHEN cardinality(v_on_job) = 1 THEN 'sets' ELSE 'set' END
                     || ' what ' || v_payer || ' pays us, not our cost'
                ELSE '' END,
      'holder', 'Marnin: no document carries a builder job''s expected cost today. His 21 Oct decision makes the job work order''s labour allowance (Shaun approves it) the expected labour, but no builder job has one yet and Job Profit does not read it yet. Materials have no document');
  END IF;

  -- 4. Nothing priced on the job at all.
  IF j.job_number ILIKE 'SWB-%' THEN
    RETURN jsonb_build_object('code', 'no_contract',
      'document', 'The signed building contract or an accepted quote, with its costing: none is on the job'
        || CASE WHEN j.pricing_json ->> 'source' = 'ghl' THEN ' (the job value came from the CRM, not a quote)' ELSE '' END,
      'holder', 'The builds lead who sold the job');
  END IF;
  IF j.type = 'patio' THEN
    RETURN jsonb_build_object('code', 'no_sealed_scope',
      'document', 'A sealed scope revision from the patio tool, or a sent quote with its cost record: none is on the job',
      'holder', 'The salesperson who priced it (Scope Engine patio tool)');
  END IF;
  IF j.type IN ('fencing', 'decking', 'combo') THEN
    RETURN jsonb_build_object('code', 'no_quote',
      'document', 'A quote sent from the fence tool, which keeps its cost record: none is on the job',
      'holder', 'The salesperson who priced it');
  END IF;
  RETURN jsonb_build_object('code', 'no_costing',
    'document', 'A quote or costed work order stating our expected cost: none is on the job',
    'holder', 'The office');
END
$fn$;

REVOKE ALL ON FUNCTION public.job_profit_expected_cost_missing(uuid) FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.job_profit_expected_cost_missing(uuid) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.job_profit_expected_cost_missing(uuid) FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.job_profit_expected_cost_missing(uuid) TO service_role';
  END IF;
END
$grants$;
COMMENT ON FUNCTION public.job_profit_expected_cost_missing(uuid) IS
  'A6 (3 Nov 2026): for a job with no expected cost in v_job_profit, the document that would fix it and who holds it: {code, document, holder}. Read only. Never a figure.';

DO $mig$
DECLARE
  v_def text;
  v_before constant text := '44c5f76f8fe56c656faee0fc1286a89b';
  v_after constant text := '87cf36d110e184372e1707a4ff9e942e';
  v_old constant text := E'    invoice_emailed_ex\n   FROM flagged f;';
  v_new constant text := E'    invoice_emailed_ex,\n        CASE\n            WHEN expected_source IS NULL THEN job_profit_expected_cost_missing(job_id)\n            ELSE NULL::jsonb\n        END AS expected_cost_missing\n   FROM flagged f;';
BEGIN
  v_def := pg_get_viewdef('public.v_job_profit'::regclass, true);
  IF md5(v_def) = v_after THEN
    RAISE NOTICE 'v_job_profit already names the missing expected-cost document';
    RETURN;
  END IF;
  IF md5(v_def) <> v_before THEN
    RAISE EXCEPTION 'v_job_profit is not the definition this migration was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'v_job_profit: the final select''s last column is not there exactly once';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_profit AS ' || replace(v_def, v_old, v_new);
  IF md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> v_after THEN
    RAISE EXCEPTION 'v_job_profit after the change is not the rehearsed definition (md5 %)', md5(pg_get_viewdef('public.v_job_profit'::regclass, true));
  END IF;
END
$mig$;

COMMENT ON COLUMN public.v_job_profit.expected_cost_missing IS
  'Null when expected_source is set. Otherwise the document that would fix this job''s expected cost and who holds it: {code, document, holder} from job_profit_expected_cost_missing(job_id). Never a figure: a sell price or the job''s own bills are never its expected cost.';
