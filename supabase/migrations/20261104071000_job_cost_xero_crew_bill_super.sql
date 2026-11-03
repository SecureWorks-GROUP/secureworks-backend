-- (Job Profit, finish-line row A6, 3 Nov 2026) Rule 2 of 3: the company super a crew bill raised straight in
-- Xero states is carried on the jobs its lines name, in proportion as the bill states.
--
-- Found by verify/scripts/a6_live_costs.py (3 Nov 11:50Z): Aydan Belcher's 24 Oct bill (no crew-app record;
-- lines 195 SWP-261336, 195 SWP-261043, 225 SWF-261413, 225 SWP-26195) has a super line "Superannuation
-- Guarantee 12.00% of submitted total ... Worker withhold $50.40. Company contribution $50.40" at -50.40.
-- Job Profit carried the four lines (840.00) and no company super; on crew-app invoices it adds the employer
-- super the invoice states (trade_employer_super, super less the part withheld from pay, shared by amount).
-- Change, in v_job_cost_events only:
--   * a bill line that withholds the worker's super (description names superannuation or super guarantee, line
--     amount below zero) is never a cost: that money goes to the fund (job_cost_super_withheld_line);
--   * each placed line of a bill whose super line states a company contribution carries its share of it,
--     line amount x contribution / the bill's other lines (source bill_employer_super, lane of its line, behind
--     the same job_cost_employer_super_v1 switch as crew-app super).
-- Nothing is counted twice: crew-app mirror bills stay out (trade_mirror_bill, unchanged), so their super is only
-- ever the crew invoice's. The "no super before first deduction" rulings (job_cost_crew_super_rulings) are
-- unchanged: a bill that states no contribution carries none. Read 3 Nov: 112 live bills carry a super line;
-- 110 are crew-app mirror bills; of the other 2, Israel's 28 Aug bill states no contribution and is not carried
-- as a bill line; Aydan's is the one this changes.
--
-- Guard: v_job_cost_events must be the definition this was written against (md5 32c422a8d90aecf6924fc0a84d4569fe,
-- pg_get_viewdef(..., true)); after the change it must be cd749fcbe09bedde4a277f6da3ade6fd. Re-running it is a no-op (also
-- once a later migration of this set, 20261104070000 to 20261104072000, has changed the view).
-- Rollback: supabase/rollbacks/20261104071000_job_cost_xero_crew_bill_super_down.sql (embeds the exact earlier definition).
-- Rehearsed 3 Nov 2026 on production, rolled back (CIO helper, Claude): 4 jobs, +50.40 (Aydan Belcher 24 Oct):
-- SWP-261336 9,464.78 to 9,476.48, SWP-261043 +11.70, SWF-261413 4,700.67 to 4,714.17, SWP-26195 11,107.96 to
-- 11,121.46. Margins shown 354 to 354.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.job_cost_super_withheld_line(p_line jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  -- A crew bill's super line: the worker's share withheld from pay, paid to the fund (never a cost reduction).
  SELECT COALESCE(p_line ->> 'Description', '') ~* '(superannuation|super guarantee)'
     AND COALESCE(public.job_profit_num(p_line -> 'LineAmount'), 0) < 0
$function$;

CREATE OR REPLACE FUNCTION public.job_cost_super_company_contribution(p_line jsonb)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$
  -- The company contribution that super line states ("Company contribution $50.40"); NULL when it states none.
  SELECT CASE WHEN public.job_cost_super_withheld_line(p_line) THEN
    replace((regexp_match(p_line ->> 'Description', 'company contribution \$?([0-9][0-9,]*(\.[0-9]+)?)', 'i'))[1], ',', '')::numeric
  END
$function$;
REVOKE ALL ON FUNCTION public.job_cost_super_withheld_line(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_cost_super_company_contribution(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_cost_super_withheld_line(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_cost_super_company_contribution(jsonb) TO service_role;

DO $mig$
DECLARE
  v_def text;
  o1 text := $o1$                  WHERE x.invoice_type = 'ACCPAY'::text AND (x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text])) AND NOT (EXISTS ( SELECT 1
                           FROM trade_mirror_bill m$o1$;
  n1 text := $n1$                  WHERE x.invoice_type = 'ACCPAY'::text AND (x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text])) AND NOT job_cost_super_withheld_line(li.value) AND NOT (EXISTS ( SELECT 1
                           FROM trade_mirror_bill m$n1$;
  o2 text := $o2$        ), supplier AS (
$o2$;
  n2 text := $n2$        ), bill_super AS (
         SELECT x.xero_invoice_id,
            sum(job_cost_super_company_contribution(li.value)) AS company_super,
            sum(
                CASE
                    WHEN job_cost_super_withheld_line(li.value) THEN 0::numeric
                    WHEN (x.raw_json ->> 'LineAmountTypes'::text) = 'Inclusive'::text THEN COALESCE(job_profit_num(li.value -> 'LineAmount'::text), 0::numeric) - COALESCE(job_profit_num(li.value -> 'TaxAmount'::text), 0::numeric)
                    ELSE COALESCE(job_profit_num(li.value -> 'LineAmount'::text), 0::numeric)
                END) AS base_ex
           FROM xero_invoices x
             CROSS JOIN LATERAL jsonb_array_elements(x.line_items) li(value)
          WHERE x.invoice_type = 'ACCPAY'::text AND (x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text])) AND jsonb_typeof(x.line_items) = 'array'::text AND x.line_items::text ~* 'company contribution'::text
          GROUP BY x.xero_invoice_id
        ), supplier AS (
$n2$;
  o3 text := $o3$        ), fact_base AS (
$o3$;
  n3 text := $n3$        ), bill_employer_super AS (
         SELECT s.job_id,
            s.event_date,
            s.lane,
            'employer_super'::text AS lane_detail,
            s.party_kind,
            s.party_id,
            s.party,
            round(s.amount_ex * bs.company_super / bs.base_ex, 6) AS amount_ex,
                CASE
                    WHEN s.is_actual THEN 'bill_employer_super'::text
                    ELSE s.source
                END AS source,
            s.source_id || ':employer_super'::text AS source_id,
            s.document_id,
            s.document_number,
            s.document_status,
            false AS paid,
            NULL::date AS paid_on,
            s.confidence,
            s.is_actual,
            'Employer super on: '::text || COALESCE(s.description, ''::text) AS description,
            NULL::numeric AS hours,
            s.account_code,
            s.business_unit,
            s.match_method,
            s.incomplete_invoice
           FROM supplier s
             JOIN bill_super bs ON bs.xero_invoice_id = s.document_id
          WHERE bs.company_super > 0.005 AND bs.base_ex > 0::numeric AND s.amount_ex <> 0::numeric AND (EXISTS ( SELECT 1
                   FROM feature_flags ff
                  WHERE ff.flag_name = 'job_cost_employer_super_v1'::text AND ff.enabled))
        ), fact_base AS (
$n3$;
  o4 text := $o4$UNION ALL
 SELECT fact.job_id,
    fact.event_date,
$o4$;
  n4 text := $n4$UNION ALL
 SELECT bill_employer_super.job_id,
    bill_employer_super.event_date,
    bill_employer_super.lane,
    bill_employer_super.lane_detail,
    bill_employer_super.party_kind,
    bill_employer_super.party_id,
    bill_employer_super.party,
    bill_employer_super.amount_ex,
    bill_employer_super.source,
    bill_employer_super.source_id,
    bill_employer_super.document_id,
    bill_employer_super.document_number,
    bill_employer_super.document_status,
    bill_employer_super.paid,
    bill_employer_super.paid_on,
    bill_employer_super.confidence,
    bill_employer_super.is_actual,
    bill_employer_super.description,
    bill_employer_super.hours,
    bill_employer_super.account_code,
    bill_employer_super.business_unit,
    bill_employer_super.match_method,
    bill_employer_super.incomplete_invoice
   FROM bill_employer_super
UNION ALL
 SELECT fact.job_id,
    fact.event_date,
$n4$;
BEGIN
  v_def := pg_get_viewdef('public.v_job_cost_events'::regclass, true);
  IF md5(v_def) IN ('cd749fcbe09bedde4a277f6da3ade6fd', '366599ce55b0e0430d45ee9e6e04c315') THEN
    RAISE NOTICE 'v_job_cost_events already has 20261104071000 (or a later change of this set)';
    RETURN;
  END IF;
  IF md5(v_def) <> '32c422a8d90aecf6924fc0a84d4569fe' THEN
    RAISE EXCEPTION 'v_job_cost_events is not the definition this migration was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, o1, ''))) / length(o1) <> 1 THEN
    RAISE EXCEPTION 'v_job_cost_events: change 1 of 4 does not find its text exactly once';
  END IF;
  v_def := replace(v_def, o1, n1);
  IF (length(v_def) - length(replace(v_def, o2, ''))) / length(o2) <> 1 THEN
    RAISE EXCEPTION 'v_job_cost_events: change 2 of 4 does not find its text exactly once';
  END IF;
  v_def := replace(v_def, o2, n2);
  IF (length(v_def) - length(replace(v_def, o3, ''))) / length(o3) <> 1 THEN
    RAISE EXCEPTION 'v_job_cost_events: change 3 of 4 does not find its text exactly once';
  END IF;
  v_def := replace(v_def, o3, n3);
  IF (length(v_def) - length(replace(v_def, o4, ''))) / length(o4) <> 1 THEN
    RAISE EXCEPTION 'v_job_cost_events: change 4 of 4 does not find its text exactly once';
  END IF;
  v_def := replace(v_def, o4, n4);
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_cost_events AS ' || v_def;
  IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) <> 'cd749fcbe09bedde4a277f6da3ade6fd' THEN
    RAISE EXCEPTION 'v_job_cost_events after the change is not the rehearsed definition (md5 %)', md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true));
  END IF;
END
$mig$;
