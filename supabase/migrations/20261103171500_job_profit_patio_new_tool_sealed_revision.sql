-- Job Profit (Scope Engine finish line B5, patio first, 3 Nov 2026): the patio expected cost reads the new patio
-- tool's sealed revisions, the way it already reads the old tool's.
--
-- Why: v_job_profit's patio source (frozen_scope_rev, 20261102180000, guarded by 20261102220000, switch
-- job_profit_patio_expected_from_frozen_scope ON) reads the cost figures in '_pricing_json' inside the frozen
-- revision's scope text. Only the old patio tool (PatioDesignerPro_V18) writes that: 125 of 125 of its frozen
-- revisions have it, 0 of 1 from the new tool (patio-scoper/2.0, SWP-26248 Rev 8). The new tool writes the same
-- figure names (labourCostEstimate, materialCostEstimate, commissionCostEstimate, totalCostEstimate) in the
-- revision's pricing text instead (scope-engine-v2 patio/scoper/src/jobsystem.ts pricingJson).
--
-- Change: when a frozen patio revision has no '_pricing_json', and it is a new-tool revision whose pricing is
-- final, its pricing text is read. Final means the Sales final revision contract, the same test the per-job patio
-- reader uses (ops-api job_profit_patio_expected.ts): scope and pricing both from patio-scoper and naming the same
-- frozen record, the scoper confirmed its outputs agree, pricing_complete true, revision.sealed true,
-- internal.costs_complete not false, nothing left in sell_to_confirm, and labour, materials and total cost all
-- known (never 0 for a cost nobody entered). Otherwise the revision gives no expected cost: unknown, never guessed.
-- Lanes from a new-tool revision:
--   labour     = labourCostEstimate
--   materials  = totalCostEstimate - labourCostEstimate (the materials plus the supplier surcharges and office
--                extras the tool counts in its total cost, so labour + materials is the revision's whole cost)
--   commission = commissionCostEstimate (blank while the staff commission policy is not set: the existing
--                'expected_cost_lane_missing' flag names it)
--
-- Unchanged: a revision that has '_pricing_json' (old tool, and the dogfood row) reads exactly as before; the
-- newest frozen patio revision per job is still the only one read, so a job never adds two revisions; frozen at
-- acceptance, an accepted quote revision and a sent quote revision still come first; fence jobs never reach this
-- source (tool_kind 'patio' only); the 2 Nov RATE_MISSING and $0-cost guards and the switch still apply.
-- Read 3 Nov 2026 (read-only): this changes no job's figures today. The one new-tool revision (SWP-26248 Rev 8)
-- is not priced (costs to confirm: 3 material rows with no cost, labour), so Job Profit keeps saying not known.
--
-- Guard: v_job_profit must be the definition this was written against (md5 7352d50d..., 20261103040000).
-- Rehearsed on a local PostgreSQL 17 rebuilt from production's catalog (the rebuilt view hashed 7352d50d...).
-- Rollback: supabase/rollbacks/20261103171500_job_profit_patio_new_tool_sealed_revision_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
-- The view's text carries a timestamp, which prints in the session's time zone; the md5 guard is taken in UTC.
SET LOCAL TimeZone = 'UTC';

DO $mig$
DECLARE
  v_def text;
  v_before constant text := '7352d50d91e713d1e7d5f8dd07e6667e';
  v_after constant text := '4ab42d7dda7e77b8e3dfc984833a5265';
  v_old constant text := $o$job_profit_safe_jsonb(s.scope_canonical_text) -> '_pricing_json'::text AS pj$o$;
  v_new constant text := $n$COALESCE(job_profit_safe_jsonb(s.scope_canonical_text) -> '_pricing_json'::text,
                        CASE
                            WHEN job_profit_safe_jsonb(s.scope_canonical_text) @> '{"tool": "patio-scoper", "revision": {"outputsAgree": true}}'::jsonb
                             AND job_profit_safe_jsonb(s.pricing_canonical_text) @> '{"tool": "patio-scoper", "pricing_complete": true, "revision": {"sealed": true}}'::jsonb
                             AND NOT job_profit_safe_jsonb(s.pricing_canonical_text) @> '{"internal": {"costs_complete": false}}'::jsonb
                             AND (job_profit_safe_jsonb(s.pricing_canonical_text) -> 'sell_to_confirm'::text) = '[]'::jsonb
                             AND jsonb_typeof(job_profit_safe_jsonb(s.scope_canonical_text) #> '{revision,n}'::text[]) = 'number'::text
                             AND COALESCE(job_profit_safe_jsonb(s.scope_canonical_text) #>> '{revision,frozenId}'::text[], ''::text) <> ''::text
                             AND (job_profit_safe_jsonb(s.scope_canonical_text) #>> '{revision,frozenId}'::text[]) = (job_profit_safe_jsonb(s.pricing_canonical_text) #>> '{revision,frozenId}'::text[])
                             AND job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'labourCostEstimate'::text) >= 0::numeric
                             AND job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'materialCostEstimate'::text) >= 0::numeric
                             AND job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'totalCostEstimate'::text) >= (job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'labourCostEstimate'::text) + job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'materialCostEstimate'::text))
                            THEN jsonb_build_object(
                                'labourCostEstimate'::text, job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'labourCostEstimate'::text),
                                'materialCostEstimate'::text, job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'totalCostEstimate'::text) - job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'labourCostEstimate'::text),
                                'commissionCostEstimate'::text, job_profit_safe_jsonb(s.pricing_canonical_text) -> 'commissionCostEstimate'::text)
                            ELSE NULL::jsonb
                        END) AS pj$n$;
BEGIN
  v_def := pg_get_viewdef('public.v_job_profit'::regclass, true);
  IF md5(v_def) = v_after THEN
    RAISE NOTICE 'v_job_profit already reads new-tool patio sealed revisions';
    RETURN;
  END IF;
  IF md5(v_def) <> v_before THEN
    RAISE EXCEPTION 'v_job_profit is not the definition this migration was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'v_job_profit: the frozen patio revision read is not there exactly once';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_profit AS ' || replace(v_def, v_old, v_new);
  IF md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> v_after THEN
    RAISE EXCEPTION 'v_job_profit after the change is not the rehearsed definition (md5 %)', md5(pg_get_viewdef('public.v_job_profit'::regclass, true));
  END IF;
END
$mig$;
