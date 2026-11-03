-- (Job Profit, finish-line row A4, variable V8, 3 Nov 2026) A supplier or subcontractor bill line that names one
-- of our job numbers in its own text is carried on that job.
--
-- Found 3 Nov 2026 (V8, SWF-26177): Emeka Henry's bills 23 (12 Jun 2026) and 24 (23 Jun 2026) sit on the holding
-- job SWF-PDF-BUCKET. Bill 23 lines 4 to 6 (Fence installation 1,617.00; Retaining Wall 2,160.00; Labour Jean
-- -1,172.50) and bill 24 line 3 (120.00) name SWF-26177 in their own text: 2,724.50. v_job_cost_events moved a line
-- on a bill on no job or on the holding job to a job only on Bookkeeping's line evidence, and Bookkeeping's ledger
-- covers July to October, so these June lines reached no job. The same cause hits other jobs: see the rehearsal.
--
-- Change (v_job_cost_events bill_line and fact_base only; one label in cfo_bill_cost_outcomes_scoped):
-- 1. job_cost_bill_line_job_id(text): the job a line's own text names (SWF-26177, SWF26177, SWF 26177, SWF -26177,
--    SWMS-261321, SW1346), when the text names exactly one job number and exactly one job that is not the holding
--    job carries it; else NULL. A line naming two jobs, or a number no job carries, is not placed.
-- 2. Order for a line on a bill on no job or on the holding job: Bookkeeping's ledger first, then the line's own job
--    number, then the bill's own job. Any row in Bookkeeping's current ledger revision for that line (job, overhead,
--    not job cost or held) means its text is never read, so the ledger always wins: a later revision that places
--    the line elsewhere moves it there on the next read (the view stores nothing). A bill a person marked not job
--    related, split or placed (allocation rows) is read as before. match_method: bill_line_job_number.
-- 3. Installer (subcontractor labour, 306 or 301) lines: JP-12 (Marnin, 20 Oct 2026: a person confirms each
--    installer bill; automatic placement needs his explicit approval) still holds. Such a line lands on its job as
--    an installer bill waiting for a person (installer_bill_unconfirmed: not in actual cost, the job shows why and
--    gives no margin) unless the switch job_cost_installer_line_job_number_v1 is on, which counts it as confirmed
--    labour. The switch is created off. The crew-app guard of 20261102160000 applies: a line never moves to a job
--    where someone whose name is in the bill's contact has crew-app labour (the same work counted twice).
-- 4. Nothing counts twice: each line has one job; crew-app mirror bills (linked to a crew invoice, or '| SW - X'
--    text) stay out; an allocation row on a bill's own holding job no longer comes back when every line of that
--    bill has moved off it (fact_base). Xero Project totals stay a check figure, never cost (M4).
-- 5. cfo_bill_cost_outcomes_scoped: a bill counted through lines placed this way reads engine_reads_xero_lines.
--
-- Rehearsed 3 Nov 2026 on production in rolled-back transactions (CIO helper, Claude), live data 12:21Z, before
-- 778,077.27 total job cost (sum of v_job_profit.actual_cost_ex, 2,008 jobs; 19,052.25 of it on the holding job):
--   Switch off (as created): 778,111.81 (+34.54, one no-job line now on SWF-26058); without the holding job
--   759,025.02 to 763,417.74 (+4,392.72, five supplier lines on five jobs). 58 installer lines (25,025.59) move to
--   36 jobs as installer bills waiting for a person (9 of those jobs newly show it); SWF-26177's margin is withheld
--   (355 to 354 margins) until a person or Bookkeeping confirms its 2,724.50.
--   Switch on: 803,137.40 (+25,060.13); without the holding job 788,443.33 (+29,418.31); 41 jobs change; margins
--   355 to 360. SWF-26177 5,723.86 to 8,448.36, the figure its Xero lines give (V8).
--   Against Bookkeeping's July to October ledger (lines it places on a job that also name one job): supplier lines
--   147 of 147 agree; installer lines 1,080 of 1,092 agree; the 12 others are job-number typos on Emeka Henry's
--   bills that Bookkeeping placed by site address, and there the ledger wins.
--   The migration itself (exact file, guard, second run, rollback): see the pull request.
--
-- Guard: v_job_cost_events must be the 20261103224500 definition (md5 7f7837be26bf12f131bd86c84ab6ea55,
-- pg_get_viewdef(..., true)) and cfo_bill_cost_outcomes_scoped the live one (md5 e60aed71c96970715cc8df4b77925f0a,
-- pg_get_functiondef); a re-run on the changed definitions does nothing.
-- Rollback: supabase/rollbacks/20261104063000_job_cost_bill_line_job_number_down.sql

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE
  v_oid oid := to_regprocedure('public.job_cost_bill_line_job_id(text)')::oid;
BEGIN
  IF v_oid IS NOT NULL AND coalesce(obj_description(v_oid, 'pg_proc'), '') NOT LIKE '%A4 V8 20261104063000%' THEN
    RAISE EXCEPTION 'public.job_cost_bill_line_job_id(text) already exists and is not this migration''s; refusing';
  END IF;
  IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) NOT IN ('7f7837be26bf12f131bd86c84ab6ea55', '33d1c54d5a288fe496b5b863a1ec1d4c') THEN
    RAISE EXCEPTION 'v_job_cost_events is not the definition this migration was written against (md5 %)',
      md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true));
  END IF;
  IF md5(pg_get_functiondef('public.cfo_bill_cost_outcomes_scoped(uuid)'::regprocedure)) NOT IN ('e60aed71c96970715cc8df4b77925f0a', '05654c5a54724306a0fcc611c64cf09b') THEN
    RAISE EXCEPTION 'cfo_bill_cost_outcomes_scoped is not the definition this migration was written against (md5 %)',
      md5(pg_get_functiondef('public.cfo_bill_cost_outcomes_scoped(uuid)'::regprocedure));
  END IF;
END $guard$;

-- The job one bill line's own text names. Built-ins are named with pg_catalog. (no SET clause), like
-- dispatch_job_number_pattern (20261104010000).
CREATE OR REPLACE FUNCTION public.job_cost_bill_line_job_id(p_text text)
RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $fn$
  SELECT CASE WHEN pg_catalog.count(DISTINCT t.job_number) OPERATOR(pg_catalog.=) 1
               AND pg_catalog.count(DISTINCT j.id) OPERATOR(pg_catalog.=) 1
              THEN (pg_catalog.array_agg(j.id) FILTER (WHERE j.id IS NOT NULL))[1] END
  FROM (SELECT CASE WHEN m[1] IS NULL THEN 'SW' OPERATOR(pg_catalog.||) m[2]
                    ELSE 'SW' OPERATOR(pg_catalog.||) m[1] OPERATOR(pg_catalog.||) '-' OPERATOR(pg_catalog.||) m[2] END AS job_number
          FROM pg_catalog.regexp_matches(pg_catalog.upper(COALESCE(p_text, '')),
                                         '(?<![A-Z0-9])SW(MS|[A-Z])?[ \t]*[-=:]?[ \t]*([0-9]{4,6})(?![0-9])', 'g') AS m) t
  LEFT JOIN public.jobs j
    ON pg_catalog.upper(j.job_number) OPERATOR(pg_catalog.=) t.job_number
   AND pg_catalog.lower(COALESCE(j.metadata OPERATOR(pg_catalog.->>) 'do_not_schedule', '')) OPERATOR(pg_catalog.<>) 'true'
$fn$;
COMMENT ON FUNCTION public.job_cost_bill_line_job_id(text) IS
  'A4 V8 20261104063000: the job a supplier or subcontractor bill line''s own text names (SWF-26177, SWF26177, SWF 26177, SWF -26177, SWMS-261321, SW1346; never inside a longer word or number), when the text names exactly one job number and exactly one job that is not the holding job carries it; else NULL. Used by v_job_cost_events.bill_line.';
REVOKE ALL ON FUNCTION public.job_cost_bill_line_job_id(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_cost_bill_line_job_id(text) TO service_role;

-- JP-12 (installer bills are confirmed by a person) stays the rule until this switch is turned on.
INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT 'job_cost_installer_line_job_number_v1', false,
       'A4 V8 20261104063000: when on, an installer (subcontractor labour) bill line that names its job number in its own text, on a bill on no job or the holding job, counts on that job as confirmed labour. Off: it shows on that job as an installer bill waiting for a person (JP-12). Turn on only with Marnin''s explicit approval of automatic installer placement (JP-12).'
WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'job_cost_installer_line_job_number_v1');

DO $mig$
DECLARE
  v_def text;
  r1_old text := $o1$THEN ev.job_id
                            ELSE x.job_id
                        END AS job_id,$o1$;
  r1_new text := $n1$THEN ev.job_id
                            WHEN tj.job_id IS NOT NULL THEN tj.job_id
                            ELSE x.job_id
                        END AS job_id,$n1$;
  r2_old text := $o2$THEN 'bookkeeping_evidence'::text
                            ELSE 'xero_invoices.job_id'::text
                        END AS placed_by,$o2$;
  r2_new text := $n2$THEN 'bookkeeping_evidence'::text
                            WHEN tj.job_id IS NOT NULL THEN 'bill_line_job_number'::text
                            ELSE 'xero_invoices.job_id'::text
                        END AS placed_by,$n2$;
  r3_old text := $o3$LEFT JOIN bill_ev ev ON ev.xero_invoice_id = x.xero_invoice_id AND ev.xero_line_item_id = (li.value ->> 'LineItemID'::text)$o3$;
  r3_new text := $n3$LEFT JOIN bill_ev ev ON ev.xero_invoice_id = x.xero_invoice_id AND ev.xero_line_item_id = (li.value ->> 'LineItemID'::text)
                     LEFT JOIN LATERAL ( SELECT job_cost_bill_line_job_id(li.value ->> 'Description'::text) AS job_id
                          WHERE (x.job_id IS NULL OR hj.id IS NOT NULL) AND NOT (EXISTS ( SELECT 1
                                   FROM v_bookkeeping_line_evidence_current e
                                  WHERE e.xero_invoice_id = x.xero_invoice_id AND e.xero_line_item_id = (li.value ->> 'LineItemID'::text))) AND NOT (EXISTS ( SELECT 1
                                   FROM materials_reconciliation_queue q
                                  WHERE q.xero_invoice_id = x.xero_invoice_id AND q.status = 'not_job_related'::text))) tn ON true
                     LEFT JOIN LATERAL ( SELECT tn.job_id
                          WHERE tn.job_id IS NOT NULL AND (NOT job_cost_installer_bill(x.line_items) OR NOT (EXISTS ( SELECT 1
                                   FROM trade t_tn
                                  WHERE t_tn.job_id = tn.job_id AND t_tn.is_actual AND lower(COALESCE(x.contact_name, ''::text)) ~~ (('%'::text || lower(t_tn.party)) || '%'::text))))) tj ON true$n3$;
  r4_old text := $o4$WHEN bl.placed_by = 'bookkeeping_evidence'::text THEN 'confirmed'::text$o4$;
  r4_new text := $n4$WHEN bl.placed_by = 'bookkeeping_evidence'::text THEN 'confirmed'::text
                    WHEN bl.placed_by = 'bill_line_job_number'::text AND (EXISTS ( SELECT 1
                       FROM feature_flags ff
                      WHERE ff.flag_name = 'job_cost_installer_line_job_number_v1'::text AND ff.enabled)) THEN 'confirmed'::text$n4$;
  r5_old text := $o5$WHERE b.xero_invoice_id = f.xero_invoice_id AND b.job_id = f.job_id))$o5$;
  r5_new text := $n5$WHERE b.xero_invoice_id = f.xero_invoice_id AND (b.job_id = f.job_id OR b.placed_by <> 'xero_invoices.job_id'::text AND f.job_id = x.job_id)))$n5$;
BEGIN
  v_def := pg_get_viewdef('public.v_job_cost_events'::regclass, true);
  IF md5(v_def) = '33d1c54d5a288fe496b5b863a1ec1d4c' THEN
    RAISE NOTICE 'v_job_cost_events already carries a bill line on the job its own text names';
    RETURN;
  END IF;
  IF md5(v_def) <> '7f7837be26bf12f131bd86c84ab6ea55' THEN
    RAISE EXCEPTION 'v_job_cost_events is not the definition this migration was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, r1_old, ''))) / length(r1_old) <> 1 THEN RAISE EXCEPTION 'v_job_cost_events: anchor r1 (bill_line job_id) not found exactly once'; END IF;
  IF (length(v_def) - length(replace(v_def, r2_old, ''))) / length(r2_old) <> 1 THEN RAISE EXCEPTION 'v_job_cost_events: anchor r2 (bill_line placed_by) not found exactly once'; END IF;
  IF (length(v_def) - length(replace(v_def, r3_old, ''))) / length(r3_old) <> 1 THEN RAISE EXCEPTION 'v_job_cost_events: anchor r3 (bill_ev join) not found exactly once'; END IF;
  IF (length(v_def) - length(replace(v_def, r4_old, ''))) / length(r4_old) <> 1 THEN RAISE EXCEPTION 'v_job_cost_events: anchor r4 (installer confirmed by evidence) not found exactly once'; END IF;
  IF (length(v_def) - length(replace(v_def, r5_old, ''))) / length(r5_old) <> 1 THEN RAISE EXCEPTION 'v_job_cost_events: anchor r5 (allocation row beside bill_line) not found exactly once'; END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_cost_events AS ' || replace(replace(replace(replace(replace(v_def, r1_old, r1_new), r2_old, r2_new), r3_old, r3_new), r4_old, r4_new), r5_old, r5_new);
  IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) <> '33d1c54d5a288fe496b5b863a1ec1d4c' THEN
    RAISE EXCEPTION 'v_job_cost_events after the change is not the rehearsed definition (md5 %)', md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true));
  END IF;
END
$mig$;

DO $out$
DECLARE
  v_def text;
  r6_old text := $o6$bool_or(e.match_method IN ('xero_invoices.job_id', 'bookkeeping_evidence')) AS via_lines$o6$;
  r6_new text := $n6$bool_or(e.match_method IN ('xero_invoices.job_id', 'bookkeeping_evidence', 'bill_line_job_number')) AS via_lines$n6$;
BEGIN
  v_def := pg_get_functiondef('public.cfo_bill_cost_outcomes_scoped(uuid)'::regprocedure);
  IF md5(v_def) = '05654c5a54724306a0fcc611c64cf09b' THEN
    RAISE NOTICE 'cfo_bill_cost_outcomes_scoped already reads a line placed by its job number as a Xero line';
    RETURN;
  END IF;
  IF md5(v_def) <> 'e60aed71c96970715cc8df4b77925f0a' THEN
    RAISE EXCEPTION 'cfo_bill_cost_outcomes_scoped is not the definition this migration was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, r6_old, ''))) / length(r6_old) <> 1 THEN
    RAISE EXCEPTION 'cfo_bill_cost_outcomes_scoped: anchor r6 (via_lines) not found exactly once';
  END IF;
  EXECUTE replace(v_def, r6_old, r6_new);
  IF md5(pg_get_functiondef('public.cfo_bill_cost_outcomes_scoped(uuid)'::regprocedure)) <> '05654c5a54724306a0fcc611c64cf09b' THEN
    RAISE EXCEPTION 'cfo_bill_cost_outcomes_scoped after the change is not the rehearsed definition (md5 %)',
      md5(pg_get_functiondef('public.cfo_bill_cost_outcomes_scoped(uuid)'::regprocedure));
  END IF;
END
$out$;
