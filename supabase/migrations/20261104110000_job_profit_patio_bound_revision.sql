-- Job Profit (finish-line row A6, 3 Nov 2026): a patio job's expected cost comes from the sealed revision the customer
-- is billed on, and a sealed revision that states no labour is not an expected cost while labour is on the job.
--
-- Why: since 20261102180000 (switch job_profit_patio_expected_from_frozen_scope, on) v_job_profit takes a patio job's
-- expected cost from its newest sealed (frozen) scope revision whenever no freeze at acceptance or quote revision
-- applies. The A6 check of 3 Nov 2026 (verify/scripts/a6_live_costs.py, 20 live jobs) found that rule wrong on 4 live
-- patio jobs, read from production (read only):
--   SWP-261180  its one sealed revision ($3,446.00 ex GST, on both invoices) prices no labour; crew labour is on the
--               job. Job Profit showed $2,622.98 as if it were the whole expected cost.
--   SWP-261336  the newest sealed revision is $2,000.00 with no labour (sealed 26 minutes after a $25,041.18 one); the
--               customer's 10% and 50% invoices are on $23,150.40, which no revision states. Job Profit showed
--               $1,425.80.
--   SWP-261248  the newest revision ($12,300.89) is not what the customer is billed on: both invoices (one on 2 Nov)
--               are on revisions 1 and 2 ($14,499.76). Job Profit read revision 3 (then withheld it for its missing rate).
--   SWP-261203  two invoices are on revision 3 ($20,418.90) and the walling invoice on no revision; the newest,
--               revision 4 ($29,570.91), has rates missing for EPS Wall Panels 50mm and Fascia Brackets.
-- Across production: 127 jobs have a sealed patio revision; 41 have customer invoices stating a share of the price;
-- on 30 of those no invoice is on the newest revision's price.
--
-- Change:
--   * v_job_profit_share_invoices: authorised or paid customer invoices whose reference states a share of the price
--     (SWP-26100-DEP20, -MAT50, -FINBAL50, -PROG25, -BAL50, a party letter allowed; ops-api createDepositInvoice
--     writes DEP<percent>), with the share. An invoice is on a price when its amount ex GST is that share of it, to
--     5 cents (job_profit_share_on_price).
--   * v_job_profit_patio_scope_binding: the sealed patio revision each job is bound to, and why:
--       newest_sealed            no share invoice, or one is on the newest sealed revision's price (as before)
--       invoices_on_superseded   every share invoice is on one earlier sealed revision's price and at least one was
--                                issued on a day after the newest revision was sealed (Perth): that revision (the
--                                newest of several at that price)
--       invoices_on_no_revision  otherwise: no revision; the expected cost is withheld
--   * v_job_profit reads the bound revision's cost figures (job_profit_patio_revision_pricing, the expression it used
--     inline since 20261103171500, unchanged) through the same guards (switch, priced, no missing rate, no line sold
--     at $0 cost), and takes a revision that states no labour cost only while the job has no actual labour.
--   * job_profit_expected_cost_missing names the bound revision and, for patio jobs, two new reasons:
--       sealed_scope_not_invoiced  each share invoice and the price it is on, and the newest revision's price
--       sealed_scope_no_labour     the revision states no labour, and the labour on the job
--     A missing rate also names who holds the rate: the office (the patio tool's Settings, Rates, or the price list).
-- Unchanged: the order of sources (freeze at acceptance, accepted quote revision, sent quote revision, then the sealed
-- patio revision); fence and other jobs; actual cost, invoiced, collected and every flag's rule; v_job_profit's
-- columns, grants and job_profit(uuid). A job's margin can move only through the expected materials that its
-- materials_below_quote flag reads (named in the rehearsal below).
--
-- Guard: v_job_profit and job_profit_expected_cost_missing(uuid) must be the definitions this was written against
-- (md5 87cf36d1..., 0c37d911..., 20261104080000 as applied; unchanged by 20261104090000 and 20261104091000); the new
-- views and functions are absent or exactly these. Idempotent. Reads v_job_cost_events (labour lane) without pinning it.
-- Rollback: supabase/rollbacks/20261104110000_job_profit_patio_bound_revision_down.sql.
--
-- Rehearsed in production 3 Nov 2026 15:50Z (verify/evidence/20261103-a6-patio/rehearsal): this file's SQL, again,
-- its rollback, and again, in one transaction ended by RAISE EXCEPTION (nothing kept; a plain read after showed
-- v_job_profit md5 87cf36d1, the function md5 0c37d911 and none of the new objects). Of 2,008 job rows, actual cost
-- (778,402.17), invoiced (2,105,963.68) and the 354 margins shown did not move. 12 jobs' expected cost moved:
--   bound to the revision their invoices are on: SWP-261309 $1,391.00 to $7,652.77, SWP-261376 $10,048.93 to $10,070.19
--   withheld, labour not priced: SWP-261180 ($2,622.98), SWP-261183 ($576.82)
--   withheld, invoices on no usable revision: SWP-261336 ($1,425.80), SWP-261511, SWP-261617, SWP-26339, SWP-26344,
--   SWP-26640
--   withheld, the invoiced revision has a missing rate: SWP-261222, SWP-261349
-- Three of them lose materials_below_quote from completeness with margin still withheld for other reasons
-- (SWP-261180, SWP-261349, SWP-26344). 75 jobs' named document changed (wording, or a new reason). The rollback gave
-- back all 2,008 rows exactly. (This paragraph was added after the rehearsal; the SQL is the rehearsed SQL.)
--
-- job_profit_expected_cost_missing no longer builds the new patio tool's cost figures itself: it reads them from
-- job_profit_patio_revision_pricing, the one reader v_job_profit uses. Those were internal figures, never its output:
-- output-key-guard: drop public.job_profit_expected_cost_missing labourCostEstimate
-- output-key-guard: drop public.job_profit_expected_cost_missing materialCostEstimate
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
-- The view's text carries a timestamp, which prints in the session's time zone; the md5 guards are taken in UTC.
SET LOCAL TimeZone = 'UTC';

DO $guard$
DECLARE
  v_md5 text := md5(pg_get_viewdef('public.v_job_profit'::regclass, true));
  v_fn regprocedure := to_regprocedure('public.job_profit_expected_cost_missing(uuid)');
BEGIN
  IF v_md5 NOT IN ('87cf36d110e184372e1707a4ff9e942e', 'ac6290aedfe4477b40a6235a7e71d45e') THEN
    RAISE EXCEPTION 'v_job_profit is not the definition this migration was written against (md5 %)', v_md5;
  END IF;
  IF v_fn IS NULL OR md5(pg_get_functiondef(v_fn)) NOT IN ('0c37d911341d324b45d164c9955e64a5', '864346d89d03f2ddbcb87124aa618d3d') THEN
    RAISE EXCEPTION 'job_profit_expected_cost_missing(uuid) is not the definition this migration was written against (md5 %)',
      CASE WHEN v_fn IS NULL THEN 'none' ELSE md5(pg_get_functiondef(v_fn)) END;
  END IF;
  -- The new objects: absent, or exactly this migration's (to_regclass and to_regprocedure, never a ::regclass literal,
  -- which is resolved when the statement is planned and fails where the object does not exist yet).
  IF to_regprocedure('public.job_profit_patio_revision_pricing(text,text)') IS NOT NULL
     AND md5(pg_get_functiondef(to_regprocedure('public.job_profit_patio_revision_pricing(text,text)'))) <> 'f35df466e43db40c7e85f95e71fc1c2c' THEN
    RAISE EXCEPTION 'job_profit_patio_revision_pricing(text, text) exists and is not this migration''s definition';
  END IF;
  IF to_regprocedure('public.job_profit_share_on_price(numeric,numeric,numeric)') IS NOT NULL
     AND md5(pg_get_functiondef(to_regprocedure('public.job_profit_share_on_price(numeric,numeric,numeric)'))) <> '7621252e3ce395171db8e6b933914a49' THEN
    RAISE EXCEPTION 'job_profit_share_on_price(numeric, numeric, numeric) exists and is not this migration''s definition';
  END IF;
  IF to_regclass('public.v_job_profit_share_invoices') IS NOT NULL
     AND md5(pg_get_viewdef(to_regclass('public.v_job_profit_share_invoices'), true)) <> '59d7ebb941e5b95cdb09dd5c6a13c8f3' THEN
    RAISE EXCEPTION 'v_job_profit_share_invoices exists and is not this migration''s definition';
  END IF;
  IF to_regclass('public.v_job_profit_patio_scope_binding') IS NOT NULL
     AND md5(pg_get_viewdef(to_regclass('public.v_job_profit_patio_scope_binding'), true)) <> '2ed0785fc88c772372849ee978029c39' THEN
    RAISE EXCEPTION 'v_job_profit_patio_scope_binding exists and is not this migration''s definition';
  END IF;
END
$guard$;

-- 1. A sealed patio revision's cost figures, read once per revision (the expression v_job_profit used inline since
--    20261103171500, unchanged, plus the new tool's sell price ex GST so the revision can be set against invoices).
CREATE OR REPLACE FUNCTION public.job_profit_patio_revision_pricing(p_scope_text text, p_pricing_text text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  sc jsonb := job_profit_safe_jsonb(p_scope_text);
  pc jsonb := job_profit_safe_jsonb(p_pricing_text);
BEGIN
  -- The old patio tool keeps its pricing, sell price included, inside the scope record.
  IF sc -> '_pricing_json' IS NOT NULL THEN
    RETURN sc -> '_pricing_json';
  END IF;
  -- The new patio tool: only a final, sealed revision whose costs are all known (Sales final revision contract).
  IF sc @> '{"tool": "patio-scoper", "revision": {"outputsAgree": true}}'::jsonb
     AND pc @> '{"tool": "patio-scoper", "pricing_complete": true, "revision": {"sealed": true}}'::jsonb
     AND NOT pc @> '{"internal": {"costs_complete": false}}'::jsonb
     AND (pc -> 'sell_to_confirm') = '[]'::jsonb
     AND jsonb_typeof(sc #> '{revision,n}') = 'number'
     AND COALESCE(sc #>> '{revision,frozenId}', '') <> ''
     AND (sc #>> '{revision,frozenId}') = (pc #>> '{revision,frozenId}')
     AND job_profit_num(pc -> 'labourCostEstimate') >= 0
     AND job_profit_num(pc -> 'materialCostEstimate') >= 0
     AND job_profit_num(pc -> 'totalCostEstimate')
         >= job_profit_num(pc -> 'labourCostEstimate') + job_profit_num(pc -> 'materialCostEstimate') THEN
    RETURN jsonb_build_object(
      'labourCostEstimate', job_profit_num(pc -> 'labourCostEstimate'),
      'materialCostEstimate', job_profit_num(pc -> 'totalCostEstimate') - job_profit_num(pc -> 'labourCostEstimate'),
      'commissionCostEstimate', pc -> 'commissionCostEstimate',
      'totalExGST', job_profit_num(pc -> 'totalExGST'));
  END IF;
  RETURN NULL;
END
$fn$;
COMMENT ON FUNCTION public.job_profit_patio_revision_pricing(text, text) IS
  'A6 (3 Nov 2026): a sealed patio scope revision''s cost figures and sell price ex GST (old tool: _pricing_json; new tool: only a final sealed revision with every cost known), else null. Read only.';

-- 2. Is a share invoice on this price? Its amount ex GST is its stated share of the price, to 5 cents (the deposit
--    invoice rounds its inc GST amount to the cent, so its ex GST amount can differ from the exact share by a cent).
CREATE OR REPLACE FUNCTION public.job_profit_share_on_price(p_price_ex numeric, p_share_pct numeric, p_ex_gst numeric)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT abs(p_price_ex * p_share_pct / 100 - p_ex_gst) <= 0.05
$fn$;
COMMENT ON FUNCTION public.job_profit_share_on_price(numeric, numeric, numeric) IS
  'A6 (3 Nov 2026): true when an invoice of p_ex_gst ex GST is p_share_pct percent of p_price_ex, to 5 cents; null when a figure is unknown.';

-- 3. The customer invoices whose reference states a share of the job's price: SWP-26100-DEP20, SWP-261203-MAT50,
--    SWF-25030-A-DEP50, SWP-261180-FINBAL50 (the deposit invoice writes DEP<percent>, ops-api createDepositInvoice;
--    staff write MAT, PROG, BAL and FINBAL with a percent the same way). Authorised or paid only.
CREATE OR REPLACE VIEW public.v_job_profit_share_invoices AS
 SELECT s.job_id,
    s.xero_invoice_id,
    s.invoice_number,
    s.invoice_date,
    s.ex_gst,
    s.share_pct
   FROM ( SELECT x.job_id,
            x.xero_invoice_id,
            x.invoice_number,
            x.invoice_date,
            x.sub_total AS ex_gst,
            "substring"(upper(x.reference), '-(?:[A-Z]-)?(?:DEP|MAT|FINBAL|PROG|BAL)([0-9]{1,3}(?:[.][0-9]+)?)(?![0-9.])'::text)::numeric AS share_pct
           FROM xero_invoices x
          WHERE x.invoice_type = 'ACCREC'::text AND (x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text])) AND x.job_id IS NOT NULL AND x.sub_total IS NOT NULL) s
  WHERE s.share_pct > 0::numeric AND s.share_pct <= 100::numeric;
COMMENT ON VIEW public.v_job_profit_share_invoices IS
  'A6 (3 Nov 2026): authorised or paid customer invoices whose reference states a share of the job''s price (DEP20, MAT50, FINBAL50, PROG25, BAL50, with an optional party letter), with that share. Read only.';

-- 4. Which sealed patio revision a job's expected cost is bound to, and why.
--    newest_sealed            the newest sealed (frozen) revision: the job has no share invoice, or one is on its price
--    invoices_on_superseded   every share invoice is on one earlier sealed revision's price, and at least one was
--                             issued on a day after the newest revision was sealed: the customer is billed on that
--                             earlier revision (the newest of several at that price)
--    invoices_on_no_revision  the share invoices are on no sealed revision the job can be bound to: revision_id null
CREATE OR REPLACE VIEW public.v_job_profit_patio_scope_binding AS
 SELECT n.job_id,
    n.revision_id AS newest_revision_id,
    n.revision_number AS newest_revision_number,
    n.frozen_at AS newest_frozen_at,
    job_profit_num(n.pj -> 'totalExGST'::text) AS newest_price_ex,
    sh.share_invoices,
    sh.on_newest AS share_invoices_on_newest,
        CASE
            WHEN sh.share_invoices = 0 OR sh.on_newest > 0 THEN 'newest_sealed'::text
            WHEN o.revision_id IS NOT NULL THEN 'invoices_on_superseded'::text
            ELSE 'invoices_on_no_revision'::text
        END AS basis,
        CASE
            WHEN sh.share_invoices = 0 OR sh.on_newest > 0 THEN n.revision_id
            ELSE o.revision_id
        END AS revision_id,
        CASE
            WHEN sh.share_invoices = 0 OR sh.on_newest > 0 THEN n.revision_number
            ELSE o.revision_number
        END AS revision_number,
        CASE
            WHEN sh.share_invoices = 0 OR sh.on_newest > 0 THEN n.pj
            ELSE o.pj
        END AS pj
   FROM ( SELECT DISTINCT ON (s.job_id) s.job_id,
            s.id AS revision_id,
            s.revision_number,
            s.frozen_at,
            job_profit_patio_revision_pricing(s.scope_canonical_text, s.pricing_canonical_text) AS pj
           FROM scope_revisions s
          WHERE s.status = 'frozen'::text AND s.tool_kind = 'patio'::text
          ORDER BY s.job_id, s.revision_number DESC) n
     CROSS JOIN LATERAL ( SELECT count(*) AS share_invoices,
            count(*) FILTER (WHERE job_profit_share_on_price(job_profit_num(n.pj -> 'totalExGST'::text), i.share_pct, i.ex_gst)) AS on_newest
           FROM v_job_profit_share_invoices i
          WHERE i.job_id = n.job_id) sh
     LEFT JOIN LATERAL ( SELECT o1.revision_id,
            o1.revision_number,
            o1.pj
           FROM ( SELECT s.id AS revision_id,
                    s.revision_number,
                    job_profit_patio_revision_pricing(s.scope_canonical_text, s.pricing_canonical_text) AS pj
                   FROM scope_revisions s
                  WHERE s.job_id = n.job_id AND s.tool_kind = 'patio'::text AND (s.status = ANY (ARRAY['frozen'::text, 'superseded'::text])) AND s.id <> n.revision_id) o1
          WHERE sh.share_invoices > 0 AND sh.on_newest = 0 AND NOT (EXISTS ( SELECT 1
                   FROM v_job_profit_share_invoices i
                  WHERE i.job_id = n.job_id AND NOT COALESCE(job_profit_share_on_price(job_profit_num(o1.pj -> 'totalExGST'::text), i.share_pct, i.ex_gst), false))) AND (EXISTS ( SELECT 1
                   FROM v_job_profit_share_invoices i
                  WHERE i.job_id = n.job_id AND i.invoice_date > (n.frozen_at AT TIME ZONE 'Australia/Perth'::text)::date))
          ORDER BY o1.revision_number DESC
         LIMIT 1) o ON true;
COMMENT ON VIEW public.v_job_profit_patio_scope_binding IS
  'A6 (3 Nov 2026): for each job with a sealed patio scope revision, the revision its expected cost is bound to (revision_id, pj) and why (basis: newest_sealed, invoices_on_superseded, invoices_on_no_revision). Read only.';

-- Read only, for the server: never the browser roles.
DO $grants$
DECLARE
  r text;
BEGIN
  REVOKE ALL ON FUNCTION public.job_profit_patio_revision_pricing(text, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.job_profit_share_on_price(numeric, numeric, numeric) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON public.v_job_profit_share_invoices FROM %I', r);
      EXECUTE format('REVOKE ALL ON public.v_job_profit_patio_scope_binding FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.job_profit_patio_revision_pricing(text, text) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.job_profit_share_on_price(numeric, numeric, numeric) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON public.v_job_profit_share_invoices FROM service_role;
    REVOKE ALL ON public.v_job_profit_patio_scope_binding FROM service_role;
    GRANT SELECT ON public.v_job_profit_share_invoices TO service_role;
    GRANT SELECT ON public.v_job_profit_patio_scope_binding TO service_role;
    GRANT EXECUTE ON FUNCTION public.job_profit_patio_revision_pricing(text, text) TO service_role;
    GRANT EXECUTE ON FUNCTION public.job_profit_share_on_price(numeric, numeric, numeric) TO service_role;
  END IF;
END
$grants$;

-- 5. v_job_profit: the patio source reads the bound revision, and a revision that states no labour is not an
--    expected cost while labour is on the job. Nothing else in the view changes.
DO $mig$
DECLARE
  v_def text;
  v_before constant text := '87cf36d110e184372e1707a4ff9e942e';
  v_after constant text := 'ac6290aedfe4477b40a6235a7e71d45e';
  v_old_sub constant text := $o$( SELECT DISTINCT ON (s.job_id) s.job_id,
                    COALESCE(job_profit_safe_jsonb(s.scope_canonical_text) -> '_pricing_json'::text,
                        CASE
                            WHEN job_profit_safe_jsonb(s.scope_canonical_text) @> '{"tool": "patio-scoper", "revision": {"outputsAgree": true}}'::jsonb AND job_profit_safe_jsonb(s.pricing_canonical_text) @> '{"tool": "patio-scoper", "revision": {"sealed": true}, "pricing_complete": true}'::jsonb AND NOT job_profit_safe_jsonb(s.pricing_canonical_text) @> '{"internal": {"costs_complete": false}}'::jsonb AND (job_profit_safe_jsonb(s.pricing_canonical_text) -> 'sell_to_confirm'::text) = '[]'::jsonb AND jsonb_typeof(job_profit_safe_jsonb(s.scope_canonical_text) #> '{revision,n}'::text[]) = 'number'::text AND COALESCE(job_profit_safe_jsonb(s.scope_canonical_text) #>> '{revision,frozenId}'::text[], ''::text) <> ''::text AND (job_profit_safe_jsonb(s.scope_canonical_text) #>> '{revision,frozenId}'::text[]) = (job_profit_safe_jsonb(s.pricing_canonical_text) #>> '{revision,frozenId}'::text[]) AND job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'labourCostEstimate'::text) >= 0::numeric AND job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'materialCostEstimate'::text) >= 0::numeric AND job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'totalCostEstimate'::text) >= (job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'labourCostEstimate'::text) + job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'materialCostEstimate'::text)) THEN jsonb_build_object('labourCostEstimate'::text, job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'labourCostEstimate'::text), 'materialCostEstimate'::text, job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'totalCostEstimate'::text) - job_profit_num(job_profit_safe_jsonb(s.pricing_canonical_text) -> 'labourCostEstimate'::text), 'commissionCostEstimate'::text, job_profit_safe_jsonb(s.pricing_canonical_text) -> 'commissionCostEstimate'::text)
                            ELSE NULL::jsonb
                        END) AS pj
                   FROM scope_revisions s
                  WHERE s.status = 'frozen'::text AND s.tool_kind = 'patio'::text AND (EXISTS ( SELECT 1
                           FROM feature_flags ff
                          WHERE ff.flag_name = 'job_profit_patio_expected_from_frozen_scope'::text AND ff.enabled))
                  ORDER BY s.job_id, s.revision_number DESC) n$o$;
  v_new_sub constant text := $n$( SELECT b.job_id,
                    b.pj
                   FROM v_job_profit_patio_scope_binding b
                  WHERE b.revision_id IS NOT NULL AND (EXISTS ( SELECT 1
                           FROM feature_flags ff
                          WHERE ff.flag_name = 'job_profit_patio_expected_from_frozen_scope'::text AND ff.enabled))) n$n$;
  v_old_case constant text := $oc$WHEN fz.job_id IS NOT NULL THEN$oc$;
  v_new_case constant text := $nc$WHEN fz.job_id IS NOT NULL AND (COALESCE(job_profit_num(fz.pj -> 'labourCostEstimate'::text), 0::numeric) > 0::numeric OR COALESCE(cost.labour_ex, 0::numeric) <= 0::numeric) THEN$nc$;
BEGIN
  v_def := pg_get_viewdef('public.v_job_profit'::regclass, true);
  IF md5(v_def) = v_after THEN
    RAISE NOTICE 'v_job_profit already reads the bound sealed patio revision';
    RETURN;
  END IF;
  IF md5(v_def) <> v_before THEN
    RAISE EXCEPTION 'v_job_profit is not the definition this migration was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old_sub, ''))) / length(v_old_sub) <> 1 THEN
    RAISE EXCEPTION 'v_job_profit: the sealed patio revision read is not there exactly once';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old_case, ''))) / length(v_old_case) <> 4 THEN
    RAISE EXCEPTION 'v_job_profit: the four sealed patio lanes are not there exactly once each';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_profit AS ' || replace(replace(v_def, v_old_sub, v_new_sub), v_old_case, v_new_case);
  IF md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> v_after THEN
    RAISE EXCEPTION 'v_job_profit after the change is not the rehearsed definition (md5 %)', md5(pg_get_viewdef('public.v_job_profit'::regclass, true));
  END IF;
END
$mig$;

-- 6. The missing document names the bound revision, the invoices that do not fit, and labour that is not priced.
--    CREATE OR REPLACE keeps the function's grants (service_role only, 20261104080000).
CREATE OR REPLACE FUNCTION public.job_profit_expected_cost_missing(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  j record;
  b record;
  i record;
  v_doc record;
  v_pj jsonb;
  v_n text;
  v_bound text := '';
  v_list text;
  v_parts text[] := ARRAY[]::text[];
  v_on integer;
  v_price numeric;
  v_labour numeric;
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

  -- 1. A sealed patio scope revision is on the job but v_job_profit cannot read it: say exactly why. The revision is
  --    the one v_job_profit binds the job to (v_job_profit_patio_scope_binding).
  IF j.type = 'patio' THEN
    SELECT * INTO b FROM v_job_profit_patio_scope_binding x WHERE x.job_id = p_job_id;
    IF FOUND THEN
      IF NOT EXISTS (SELECT 1 FROM feature_flags ff
                      WHERE ff.flag_name = 'job_profit_patio_expected_from_frozen_scope' AND ff.enabled) THEN
        RETURN jsonb_build_object('code', 'sealed_scope_switch_off',
          'document', 'Sealed scope revision ' || b.newest_revision_number || ' is on the job, but Job Profit reads sealed patio revisions only while its switch is on',
          'holder', 'Marnin (the switch job_profit_patio_expected_from_frozen_scope is his)');
      END IF;
      -- The customer's invoices are on no sealed revision the job can be bound to: name each invoice and the price
      -- it is on, so whoever seals the revision the customer bought sees the price to seal it at.
      IF b.revision_id IS NULL THEN
        FOR i IN SELECT si.invoice_number, si.share_pct, si.ex_gst
                   FROM v_job_profit_share_invoices si
                  WHERE si.job_id = p_job_id
                  ORDER BY si.invoice_date, si.invoice_number LOOP
          SELECT s.revision_number, job_profit_num(job_profit_patio_revision_pricing(s.scope_canonical_text, s.pricing_canonical_text) -> 'totalExGST')
            INTO v_on, v_price
            FROM scope_revisions s
           WHERE s.job_id = p_job_id AND s.tool_kind = 'patio' AND s.status IN ('frozen', 'superseded')
             AND job_profit_share_on_price(job_profit_num(job_profit_patio_revision_pricing(s.scope_canonical_text, s.pricing_canonical_text) -> 'totalExGST'),
                                           i.share_pct, i.ex_gst)
           ORDER BY s.revision_number DESC
           LIMIT 1;
          IF FOUND THEN
            v_parts := v_parts || (i.invoice_number || ' (' || trim_scale(i.share_pct) || '%) is on revision ' || v_on
              || '''s price, $' || to_char(v_price, 'FM999,999,990.00'));
          ELSE
            v_parts := v_parts || (i.invoice_number || ' (' || trim_scale(i.share_pct) || '% of $'
              || to_char(round(i.ex_gst * 100 / i.share_pct, 2), 'FM999,999,990.00') || ') is on no sealed revision''s price');
          END IF;
        END LOOP;
        -- Rates missing in the newest revision are named too: the revision sealed for the customer needs them.
        SELECT string_agg(DISTINCT COALESCE(NULLIF(btrim(w.value ->> 'context'), ''), w.value ->> 'code'), '; ')
          INTO v_list
          FROM scope_revisions s
         CROSS JOIN LATERAL job_profit_patio_revision_pricing(s.scope_canonical_text, s.pricing_canonical_text) p(pj)
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.pj -> 'pricing_warnings') = 'array'
                                                      THEN p.pj -> 'pricing_warnings' ELSE '[]'::jsonb END) w(value)
         WHERE s.id = b.newest_revision_id AND (w.value ->> 'code') ILIKE '%RATE_MISSING%';
        RETURN jsonb_build_object('code', 'sealed_scope_not_invoiced',
          'document', 'The sealed scope revision the customer bought, at the price on their invoices (ex GST): '
            || array_to_string(v_parts, '; ') || '. The newest sealed revision, ' || b.newest_revision_number || ', is '
            || COALESCE('$' || to_char(b.newest_price_ex, 'FM999,999,990.00'), 'not priced')
            || COALESCE(' (a rate is missing for ' || v_list || ')', '')
            || CASE WHEN b.share_invoices_on_newest = 0 AND NOT EXISTS (
                      SELECT 1 FROM v_job_profit_share_invoices si
                       WHERE si.job_id = p_job_id
                         AND si.invoice_date > (b.newest_frozen_at AT TIME ZONE 'Australia/Perth')::date)
                    THEN ' and was sealed after those invoices, with none on its price yet' ELSE '' END,
          'holder', v_scoper || ': seal the revision the customer bought at the price on their invoices; work agreed after it is a variation with its cost'
            || CASE WHEN v_list IS NOT NULL THEN '. The office sets the missing rate (the patio tool''s Settings, Rates, or the price list in SecureSuite)' ELSE '' END);
      END IF;
      v_n := 'Sealed scope revision ' || b.revision_number;
      IF b.basis = 'invoices_on_superseded' THEN
        v_bound := ' (the revision the customer''s invoices are on, $' || to_char(job_profit_num(b.pj -> 'totalExGST'), 'FM999,999,990.00')
          || ' ex GST; the newest, revision ' || b.newest_revision_number || ', is not)';
      END IF;
      -- The same cost figures v_job_profit's frozen_scope_rev reads.
      v_pj := b.pj;
      IF GREATEST(COALESCE(job_profit_num(v_pj -> 'labourCostEstimate'), 0),
                  COALESCE(job_profit_num(v_pj -> 'materialCostEstimate'), 0)) <= 0 THEN
        RETURN jsonb_build_object('code', 'sealed_scope_not_priced',
          'document', v_n || ' with its final cost figures: it carries none (its pricing is not final or states no labour or materials cost)' || v_bound,
          'holder', v_scoper);
      END IF;
      SELECT string_agg(DISTINCT COALESCE(NULLIF(btrim(w.value ->> 'context'), ''), w.value ->> 'code'), '; ')
        INTO v_list
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_pj -> 'pricing_warnings') = 'array'
                                       THEN v_pj -> 'pricing_warnings' ELSE '[]'::jsonb END) w(value)
       WHERE (w.value ->> 'code') ILIKE '%RATE_MISSING%';
      IF v_list IS NOT NULL THEN
        RETURN jsonb_build_object('code', 'sealed_scope_rate_missing',
          'document', v_n || ' sealed again with every rate: a rate is missing for ' || v_list || v_bound,
          'holder', v_scoper || ', once the office has set the missing rate (the patio tool''s Settings, Rates, or the price list in SecureSuite); the line is priced at $0 cost until then');
      END IF;
      SELECT string_agg(DISTINCT btrim(li.value ->> 'description'), '; ')
        INTO v_list
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_pj -> 'line_items') = 'array'
                                       THEN v_pj -> 'line_items' ELSE '[]'::jsonb END) li(value)
       WHERE COALESCE(job_profit_num(li.value -> 'total_sell'), 0) > 0
         AND COALESCE(job_profit_num(li.value -> 'total_cost'), 0) <= 0;
      IF v_list IS NOT NULL THEN
        RETURN jsonb_build_object('code', 'sealed_scope_line_without_cost',
          'document', v_n || ' sealed again with a cost on every selling line: ' || v_list || ' sells with no cost' || v_bound,
          'holder', v_scoper);
      END IF;
      -- The revision states no labour cost while labour is on the job (v_job_profit's labour lane, the same events).
      IF COALESCE(job_profit_num(v_pj -> 'labourCostEstimate'), 0) <= 0 THEN
        SELECT sum(e.amount_ex) INTO v_labour
          FROM v_job_cost_events e
         WHERE e.job_id = p_job_id AND e.is_actual AND e.lane = 'labour';
        IF COALESCE(v_labour, 0) > 0 THEN
          RETURN jsonb_build_object('code', 'sealed_scope_no_labour',
            'document', v_n || ' sealed again with its labour: it states no labour cost, but $'
              || to_char(round(v_labour, 2), 'FM999,999,990.00') || ' of labour (ex GST) is on the job' || v_bound,
            'holder', v_scoper);
        END IF;
      END IF;
      RETURN jsonb_build_object('code', 'sealed_scope_not_priced',
        'document', v_n || ' with its final cost figures' || v_bound,
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

DO $post$
BEGIN
  IF md5(pg_get_functiondef(to_regprocedure('public.job_profit_expected_cost_missing(uuid)'))) <> '864346d89d03f2ddbcb87124aa618d3d' THEN
    RAISE EXCEPTION 'job_profit_expected_cost_missing(uuid) after the change is not the rehearsed definition (md5 %)',
      md5(pg_get_functiondef(to_regprocedure('public.job_profit_expected_cost_missing(uuid)')));
  END IF;
END
$post$;
COMMENT ON FUNCTION public.job_profit_expected_cost_missing(uuid) IS
  'A6 (3 Nov 2026, 20261104110000): for a job with no expected cost in v_job_profit, the document that would fix it and who holds it: {code, document, holder}. Patio jobs name the sealed revision the job is bound to, the customer invoices that are on no sealed revision''s price, missing rates and unpriced labour. Read only. Never a figure.';
