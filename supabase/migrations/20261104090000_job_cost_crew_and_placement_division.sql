-- (Job Profit, finish-line row A3, 3 Nov 2026) A crew line and a materials placement carry the division (Xero
-- Business Unit) of the Xero bill line they are paid on, as supplier bill lines already do.
--
-- Found by verify/scripts/a3_division_months.py (3 Nov 14:18Z read; A3 20 of 60 division-month figures equal
-- Xero): v_job_cost_events held business_unit NULL on crew-app lines (trade_line, and their employer super) and on
-- AI or staff placements (materials_fact, and their credits), so a division total took the job's own division
-- while Xero books the bill line where its tracking says. Causes, July to October, gross over the cells they
-- touch: crew_division 21,321.28, placement_division 16,492.36, job_without_division 3,371.16 (SWB-, SWM-, SW1xxx
-- jobs our job-number rule does not map). Examples: Fencing Warehouse 10092899 (SWF-261042, 2,358.14) and Fence
-- Makers I5537 (SWF-261359, 3,014.21) are tracked to SW - INSURANCE WORK in Xero and read as Make Safe here; Ryan's
-- SWB-26073 lines (SW-INV-R-260823-024 and others) are tracked to SW - BUILDS and read as no division here.
-- Change, in v_job_cost_events only (no amount, job, date or row changes; business_unit only):
--   * trade (crew-app line): the Business Unit of the line of its crew invoice's own Xero bill that carries it.
--     Lines pair inside that one bill: first on the same amount and the same job number (the text before " | "),
--     then on the same amount, each side in its own order (line created, Xero line number); a line pairs at most
--     once on each side, so no row is added or repeated. A crew line with no posted bill, or no line of the same
--     amount, keeps NULL (division from its job, as before). Its employer super follows the line.
--   * fact_base (AI or staff placement): the bill's one division, when every line of that bill with an amount
--     carries the same Business Unit (job_cost_document_business_unit); otherwise NULL, as before.
-- Functions added: job_cost_line_business_unit(jsonb), job_cost_document_business_unit(jsonb),
-- job_cost_crew_bill_line_job_number(text) (service role only).
--
-- Guard: v_job_cost_events must be the definition this was written against (md5 366599ce55b0e0430d45ee9e6e04c315,
-- pg_get_viewdef(..., true), 20261104072000 as applied); after the change it must be abdc05a69d139d79aebbb8a3cebfae03.
-- Re-running it is a no-op.
-- Rollback: supabase/rollbacks/20261104090000_job_cost_crew_and_placement_division_down.sql (embeds the exact
-- earlier definition).
-- Rehearsed 3 Nov 2026 on production in rolled-back transactions (CIO helper, Claude; read 14:44Z, evidence
-- context-system/verify/evidence/20261103-a3/ours-20261103T1418Z): total job cost 778,402.17 before and after (sum of
-- v_job_profit.actual_cost_ex, 2,008 jobs), invoiced 2,105,963.68 and margins shown 354 before and after; 2,558 crew,
-- placement and credit rows before and after, none added or dropped, no amount, job, date or counting change.
-- business_unit now set on 1,220 of 1,404 crew lines, 188 of 194 placements, 321 employer super rows and 8 placement
-- credits. A3: 20 of 60 to 21 of 60 (SW - INSURANCE WORK July cost now equals Xero); placement_division 16,492.36 to 0,
-- crew_division 21,321.28 to 2,870.48, job_without_division 3,371.16 to 1,524.80.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.job_cost_line_business_unit(p_line jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  -- The Business Unit (division) tracking option one Xero line carries; NULL when it carries none.
  SELECT t.value ->> 'Option'
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_line -> 'Tracking') = 'array' THEN p_line -> 'Tracking' ELSE '[]'::jsonb END) t(value)
   WHERE t.value ->> 'Name' = 'Business Unit'
   LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION public.job_cost_document_business_unit(p_lines jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  -- A Xero document's one division: the Business Unit every line with an amount carries (a worker super line left
  -- out). NULL when a line with an amount carries none, or the lines carry more than one.
  SELECT CASE WHEN count(*) > 0 AND count(b.bu) = count(*) AND count(DISTINCT b.bu) = 1 THEN min(b.bu) END
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_lines) = 'array' THEN p_lines ELSE '[]'::jsonb END) li(value)
    CROSS JOIN LATERAL (SELECT public.job_cost_line_business_unit(li.value) AS bu) b
   WHERE COALESCE(public.job_profit_num(li.value -> 'LineAmount'), 0) <> 0
     AND NOT public.job_cost_super_withheld_line(li.value)
$function$;

CREATE OR REPLACE FUNCTION public.job_cost_crew_bill_line_job_number(p_description text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  -- The job number a crew-app Xero bill line names before its " | " ("SWMS-261233 | SW - MAKESAFE ...", also
  -- after the crew member's name on a first line of its own); NULL when the text names none.
  SELECT upper((regexp_match(COALESCE(p_description, ''), '([A-Za-z]+-?[0-9][0-9A-Za-z]*) \|'))[1])
$function$;
REVOKE ALL ON FUNCTION public.job_cost_line_business_unit(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_cost_document_business_unit(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_cost_crew_bill_line_job_number(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_cost_line_business_unit(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_cost_document_business_unit(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_cost_crew_bill_line_job_number(text) TO service_role;

DO $mig$
DECLARE
  v_def text;
  o1 text := $o1$        ), trade AS (
         SELECT r.resolved_job_id AS job_id,
$o1$;
  n1 text := $n1$        ), trade_bill_xline AS (
         SELECT ti.id AS trade_invoice_id,
            li.n,
            round(
                CASE
                    WHEN (x.raw_json ->> 'LineAmountTypes'::text) = 'Inclusive'::text THEN COALESCE(job_profit_num(li.value -> 'LineAmount'::text), 0::numeric) - COALESCE(job_profit_num(li.value -> 'TaxAmount'::text), 0::numeric)
                    ELSE COALESCE(job_profit_num(li.value -> 'LineAmount'::text), 0::numeric)
                END, 2) AS amount_ex,
            job_cost_crew_bill_line_job_number(li.value ->> 'Description'::text) AS job_number,
            job_cost_line_business_unit(li.value) AS business_unit
           FROM trade_invoices ti
             JOIN xero_invoices x ON x.xero_invoice_id = ti.xero_bill_id AND x.invoice_type = 'ACCPAY'::text AND (x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text]))
             CROSS JOIN LATERAL jsonb_array_elements(
                CASE
                    WHEN jsonb_typeof(x.line_items) = 'array'::text THEN x.line_items
                    ELSE '[]'::jsonb
                END) WITH ORDINALITY li(value, n)
          WHERE NOT job_cost_super_withheld_line(li.value)
        ), trade_bill_tline AS (
         SELECT l.id AS line_id,
            l.trade_invoice_id,
            l.created_at,
            round(l.line_total_ex, 2) AS amount_ex,
            upper(NULLIF(btrim(l.job_number), ''::text)) AS job_number
           FROM trade_invoice_lines l
          WHERE (EXISTS ( SELECT 1
                   FROM trade_invoices ti
                  WHERE ti.id = l.trade_invoice_id AND ti.xero_bill_id IS NOT NULL))
        ), trade_bill_p1 AS (
         SELECT t.line_id,
            x.trade_invoice_id,
            x.n,
            x.business_unit
           FROM ( SELECT tl.line_id,
                    tl.trade_invoice_id,
                    tl.amount_ex,
                    tl.job_number,
                    row_number() OVER (PARTITION BY tl.trade_invoice_id, tl.amount_ex, tl.job_number ORDER BY tl.created_at, tl.line_id) AS k
                   FROM trade_bill_tline tl
                  WHERE tl.job_number IS NOT NULL) t
             JOIN ( SELECT xl.trade_invoice_id,
                    xl.n,
                    xl.amount_ex,
                    xl.job_number,
                    xl.business_unit,
                    row_number() OVER (PARTITION BY xl.trade_invoice_id, xl.amount_ex, xl.job_number ORDER BY xl.n) AS k
                   FROM trade_bill_xline xl
                  WHERE xl.job_number IS NOT NULL) x ON x.trade_invoice_id = t.trade_invoice_id AND x.amount_ex = t.amount_ex AND x.job_number = t.job_number AND x.k = t.k
        ), trade_bill_line AS (
         SELECT p1.line_id,
            p1.business_unit
           FROM trade_bill_p1 p1
        UNION ALL
         SELECT t.line_id,
            x.business_unit
           FROM ( SELECT tl.line_id,
                    tl.trade_invoice_id,
                    tl.amount_ex,
                    row_number() OVER (PARTITION BY tl.trade_invoice_id, tl.amount_ex ORDER BY tl.created_at, tl.line_id) AS k
                   FROM trade_bill_tline tl
                  WHERE NOT (EXISTS ( SELECT 1
                           FROM trade_bill_p1 p
                          WHERE p.line_id = tl.line_id))) t
             JOIN ( SELECT xl.trade_invoice_id,
                    xl.n,
                    xl.amount_ex,
                    xl.business_unit,
                    row_number() OVER (PARTITION BY xl.trade_invoice_id, xl.amount_ex ORDER BY xl.n) AS k
                   FROM trade_bill_xline xl
                  WHERE NOT (EXISTS ( SELECT 1
                           FROM trade_bill_p1 p
                          WHERE p.trade_invoice_id = xl.trade_invoice_id AND p.n = xl.n))) x ON x.trade_invoice_id = t.trade_invoice_id AND x.amount_ex = t.amount_ex AND x.k = t.k
        ), trade AS (
         SELECT r.resolved_job_id AS job_id,
$n1$;
  o2 text := $o2$            NULL::text AS account_code,
            NULL::text AS business_unit,
            r.match_method,
$o2$;
  n2 text := $n2$            NULL::text AS account_code,
            tbl.business_unit,
            r.match_method,
$n2$;
  o3 text := $o3$             LEFT JOIN users u ON u.id = r.user_id
             LEFT JOIN v_invoice_line_completeness c ON c.trade_invoice_id = r.trade_invoice_id
$o3$;
  n3 text := $n3$             LEFT JOIN users u ON u.id = r.user_id
             LEFT JOIN v_invoice_line_completeness c ON c.trade_invoice_id = r.trade_invoice_id
             LEFT JOIN trade_bill_line tbl ON tbl.line_id = r.line_id
$n3$;
  o4 text := $o4$            NULL::text AS account_code,
            NULL::text AS business_unit,
            COALESCE(f.automation_source, 'materials_fact'::text) AS match_method,
$o4$;
  n4 text := $n4$            NULL::text AS account_code,
            job_cost_document_business_unit(x.line_items) AS business_unit,
            COALESCE(f.automation_source, 'materials_fact'::text) AS match_method,
$n4$;
BEGIN
  v_def := pg_get_viewdef('public.v_job_cost_events'::regclass, true);
  IF md5(v_def) = 'abdc05a69d139d79aebbb8a3cebfae03' THEN
    RAISE NOTICE 'v_job_cost_events already has 20261104090000';
    RETURN;
  END IF;
  IF md5(v_def) <> '366599ce55b0e0430d45ee9e6e04c315' THEN
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
  IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) <> 'abdc05a69d139d79aebbb8a3cebfae03' THEN
    RAISE EXCEPTION 'v_job_cost_events after the change is not the rehearsed definition (md5 %)', md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true));
  END IF;
END
$mig$;
