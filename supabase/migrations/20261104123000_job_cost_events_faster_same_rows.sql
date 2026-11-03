-- (Context and Job Profit, finish-line row C3, 3 Nov 2026) One job's Job Profit read no longer costs the whole
-- company's, so the AI notes reader's record packet stops timing out. The same rows, read faster: no figure changes.
--
-- Found 3 Nov 16:09Z (CIO chat): every notes-reader read failed with 57014 (service_role statement_timeout 30 s) in
-- context_ledger_record_packet (worker: transient_db / ledger_story_unavailable). Measured on production, read only
-- (context-system verify/evidence/20261103-c3-reader-timeouts/perf): the packet reads v_job_cost_events whole twice
-- (context_job_story_credit_sig through v_supplier_credit_placement, and context_job_story_meta's bill check), and one
-- job's v_job_profit row reads it whole once, because a job filter cannot reach inside it; each read cost about 2.4 s
-- whatever the job. v_job_profit itself is not read by the packet while both purchase-order margin holds are off.
-- Most of that time was work repeated per bill line: each installer check rescanned the whole crew list (up to five
-- scans a line), each line rescanned the list of credited bills, each crew line rescanned the bill-line pairings, and
-- v_supplier_credit_allocations recomputed its credit shares and crew-bill test at every reference (about 2.7 ms a
-- row). Bills looked up by Xero id alone read the whole (org_id, xero_invoice_id) index.
-- Change (no row, amount, job, date or flag changes; proved below):
--   * index xero_invoices (xero_invoice_id).
--   * v_supplier_credit_allocations, 4 exact text changes: the two credit shares and the crew-bill test once per row
--     (a lateral OFFSET 0 step). The crew-bill test now runs on every row instead of only where the state reaches it;
--     it is a read with the same answer either way.
--   * v_job_cost_events, 20 exact text changes (listed in the DO block):
--       - trade_party: each job's actual crew party names once, as one keyed map, which the installer checks read.
--       - installer_bill: the bills with an installer line, once per bill, which the bill-line checks read.
--       - bill_credit_one: each bill's credit share joined once instead of a scan per line.
--       - trade_bill_bu: each crew line's business unit from one keyed map instead of a scan per line.
--       - sca: the supplier credit allocations read once (twice before).
--       - a line's text is read for a job number only when it holds "SW" (job_cost_bill_line_job_id's own pattern
--         starts with it, on the same upper()).
--       - a bill is tested for a credit share only when it lists credit notes, states an amount credited above zero, or
--         lists prepayments or overpayments (job_cost_credit_share's own branches); the share itself still decides.
--       - a placement's installer test skips the full check on a bill with no account 301 or 306 line (jsonpath, which
--         also matches a code written as a number).
-- Guards: each view must be the definition this was written against (pg_get_viewdef(..., true): v_job_cost_events md5
-- abdc05a69d139d79aebbb8a3cebfae03, 20261104090000 as applied; v_supplier_credit_allocations md5
-- 0000749040d6b72e63bf77a4318cf293), or already this migration's; afterwards each must be the rehearsed definition
-- (b48997c55913ce3c90e3a3c947533fd3, 9684232cbb1c45e7564ce168971d800e). Re-running it is a no-op. v_job_profit
-- (ac6290ae, 20261104110000) is not changed.
-- Rollback: supabase/rollbacks/20261104123000_job_cost_events_faster_same_rows_down.sql (embeds both exact earlier
-- definitions, then drops the index).
-- Rehearsed 3 Nov 2026 17:05 to 17:07Z on production in rolled-back transactions (CIO helper, Claude; repeatable read,
-- one snapshot before and after): v_job_profit 2,008 rows, 0 differ in any column; total job cost 778,402.17, invoiced
-- 2,105,963.68 and margins shown 354 before and after; v_job_cost_events 4,005 rows, v_supplier_credit_allocations 97,
-- v_supplier_credit_placement 99, 0 differ either way; grants unchanged; applied twice (the second a no-op), then the
-- rollback restored both earlier md5s and dropped the index. The migration itself took 76 to 96 ms.
-- Timing, 3 Nov 17:08 to 17:15Z, one session, sequential, 3 runs each, the notes worker live at 4 reads at once
-- (before = live; after = the same reads in a rolled-back transaction with this migration applied):
--   v_job_cost_events whole: 2.32 to 2.55 s, 5 runs -> 0.83 to 0.87 s, 3 runs
--   one job's v_job_profit row, every column (SWP-261550, SWF-261397): 2.64 to 2.78 s -> 1.13 to 1.24 s
--   context_ledger_record_packet, 5 live jobs waiting on the reader: 5.5 to 8.0 s -> 2.28 to 2.75 s on four; 3.36 to
--     3.42 s on SWP-26100, where 0.9 s is context_job_story_meta scanning business_events for old-inbox mail (not Job
--     Profit, unchanged here)
--   the staff app's one-job Job Profit read (ops-api job_profit: the row, cost and revenue events, dispatch orders and
--     bills, job_profit_line_evidence), same two jobs: 10.8 to 11.4 s -> 4.7 to 5.0 s

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Bills are looked up by their Xero id alone in many places (job_cost_credit_ex, placements, allocations); the only
-- index led with org_id, so each lookup read the whole index.
CREATE INDEX IF NOT EXISTS xero_invoices_xero_invoice_id_idx ON public.xero_invoices (xero_invoice_id);

DO $mig$
DECLARE
  s_def text;
  v_def text;
  -- 1. each allocation's two bill credit shares and its crew-bill test, once per row (the inlined steps repeated them at every reference)
  os01 text := $os01$            job_cost_credit_share(x.raw_json, x.total) AS bill_credit_share,
            job_cost_credit_share(x.raw_json - 'AmountCredited'::text, x.total) AS bill_list_share,$os01$;
  ns01 text := $ns01$            cs.bill_credit_share,
            cs.bill_list_share,
            cs.trade_mirror,$ns01$;
  -- 2. (computes 1)
  os02 text := $os02$             LEFT JOIN xero_invoices x ON x.org_id = a.org_id AND x.xero_invoice_id = a.xero_invoice_id AND x.invoice_type = 'ACCPAY'::text
$os02$;
  ns02 text := $ns02$             LEFT JOIN xero_invoices x ON x.org_id = a.org_id AND x.xero_invoice_id = a.xero_invoice_id AND x.invoice_type = 'ACCPAY'::text
             CROSS JOIN LATERAL ( SELECT job_cost_credit_share(x.raw_json, x.total) AS bill_credit_share,
                    job_cost_credit_share(x.raw_json - 'AmountCredited'::text, x.total) AS bill_list_share,
                    materials_ai_trade_mirror(a.xero_invoice_id, x.line_items) AS trade_mirror
                 OFFSET 0) cs
$ns02$;
  -- 3. (carries 1)
  os03 text := $os03$            a.bill_lists_note,
                CASE
                    WHEN NOT a.bill_in_copy THEN NULL::text$os03$;
  ns03 text := $ns03$            a.bill_lists_note,
            a.trade_mirror,
                CASE
                    WHEN NOT a.bill_in_copy THEN NULL::text$ns03$;
  -- 4. (reads 1)
  os04 text := $os04$                    WHEN materials_ai_trade_mirror(a.xero_invoice_id, a.bill_line_items) THEN 'crew_bill'::text$os04$;
  ns04 text := $ns04$                    WHEN a.trade_mirror THEN 'crew_bill'::text$ns04$;
  -- 1. trade_party: each job's actual crew party names, once, as one keyed map
  ov01 text := $ov01$        ), trade_employer_super AS ($ov01$;
  nv01 text := $nv01$        ), trade_party AS (
         SELECT jsonb_object_agg(p.job_id::text, p.parties) AS m
           FROM ( SELECT trade.job_id,
                    jsonb_agg(DISTINCT lower(trade.party)) AS parties
                   FROM trade
                  WHERE trade.is_actual
                  GROUP BY trade.job_id) p
        ), trade_employer_super AS ($nv01$;
  -- 2. installer_bill: the bills with an installer line (account 301 or 306), once per bill
  ov02 text := $ov02$        ), bill_line AS ($ov02$;
  nv02 text := $nv02$        ), bill_credit_one AS (
         SELECT DISTINCT ON (bill_credit.xero_invoice_id) bill_credit.xero_invoice_id,
            bill_credit.credit_share
           FROM bill_credit
          ORDER BY bill_credit.xero_invoice_id, bill_credit.credit_share DESC
        ), installer_bill AS (
         SELECT x.id
           FROM xero_invoices x
          WHERE x.invoice_type = 'ACCPAY'::text AND (x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text])) AND (x.line_items @? '$[*]?(@."AccountCode" == "306" || @."AccountCode" == "301" || @."AccountCode" == 306 || @."AccountCode" == 301)'::jsonpath AND job_cost_installer_bill(x.line_items))
        ), bill_line AS ($nv02$;
  -- 3. a bookkeeping part's installer check reads the installer set and the party map
  ov03 text := $ov03$WHEN NOT job_cost_installer_bill(x.line_items) OR NOT (EXISTS ( SELECT 1
                                   FROM trade t_sp
                                  WHERE t_sp.job_id = sp.job_id AND t_sp.is_actual AND lower(COALESCE(x.contact_name, ''::text)) ~~ (('%'::text || lower(t_sp.party)) || '%'::text))) THEN sp.job_id$ov03$;
  nv03 text := $nv03$WHEN NOT (x.id IN ( SELECT installer_bill.id FROM installer_bill)) OR NOT (EXISTS ( SELECT 1 FROM jsonb_array_elements_text(tp.m -> sp.job_id::text) tpp(party) WHERE lower(COALESCE(x.contact_name, ''::text)) ~~ (('%'::text || tpp.party) || '%'::text))) THEN sp.job_id$nv03$;
  -- 4. a bookkeeping line's installer check (job and placed_by) reads the installer set and the party map
  ov04 text := $ov04$ev.job_id IS NOT NULL AND (NOT job_cost_installer_bill(x.line_items) OR NOT (EXISTS ( SELECT 1
                               FROM trade t_ev
                              WHERE t_ev.job_id = ev.job_id AND t_ev.is_actual AND lower(COALESCE(x.contact_name, ''::text)) ~~ (('%'::text || lower(t_ev.party)) || '%'::text))))$ov04$;
  nv04 text := $nv04$ev.job_id IS NOT NULL AND (NOT (x.id IN ( SELECT installer_bill.id FROM installer_bill)) OR NOT (EXISTS ( SELECT 1 FROM jsonb_array_elements_text(tp.m -> ev.job_id::text) tpp(party) WHERE lower(COALESCE(x.contact_name, ''::text)) ~~ (('%'::text || tpp.party) || '%'::text))))$nv04$;
  -- 5. a job number in the line's text: installer set and party map
  ov05 text := $ov05$WHERE tn.job_id IS NOT NULL AND (NOT job_cost_installer_bill(x.line_items) OR NOT (EXISTS ( SELECT 1
                                   FROM trade t_tn
                                  WHERE t_tn.job_id = tn.job_id AND t_tn.is_actual AND lower(COALESCE(x.contact_name, ''::text)) ~~ (('%'::text || lower(t_tn.party)) || '%'::text))))) tj ON true$ov05$;
  nv05 text := $nv05$WHERE tn.job_id IS NOT NULL AND (NOT (x.id IN ( SELECT installer_bill.id FROM installer_bill)) OR NOT (EXISTS ( SELECT 1 FROM jsonb_array_elements_text(tp.m -> tn.job_id::text) tpp(party) WHERE lower(COALESCE(x.contact_name, ''::text)) ~~ (('%'::text || tpp.party) || '%'::text))))) tj ON true$nv05$;
  -- 6. a line's text is read for a job number only when it holds SW (job_cost_bill_line_job_id's pattern starts with it)
  ov06 text := $ov06$                     LEFT JOIN LATERAL ( SELECT job_cost_bill_line_job_id(li.value ->> 'Description'::text) AS job_id$ov06$;
  nv06 text := $nv06$                     LEFT JOIN LATERAL ( SELECT
                                CASE
                                    WHEN strpos(upper(COALESCE(li.value ->> 'Description'::text, ''::text)), 'SW'::text) > 0 THEN job_cost_bill_line_job_id(li.value ->> 'Description'::text)
                                    ELSE NULL::uuid
                                END AS job_id$nv06$;
  -- 7. the party map joins each bill line once
  ov07 text := $ov07$                        END) <= 0.005
                     LEFT JOIN LATERAL ( SELECT$ov07$;
  nv07 text := $nv07$                        END) <= 0.005
                     CROSS JOIN trade_party tp
                     LEFT JOIN LATERAL ( SELECT$nv07$;
  -- 8. a bill line's credit share by a hashed join, not a scan of every credited bill per line
  ov08 text := $ov08$                    COALESCE(( SELECT c.credit_share
                           FROM bill_credit c
                          WHERE c.xero_invoice_id = x.xero_invoice_id
                         LIMIT 1), 0::numeric) AS credit_share
                   FROM xero_invoices x
$ov08$;
  nv08 text := $nv08$                    COALESCE(bc.credit_share, 0::numeric) AS credit_share
                   FROM xero_invoices x
                     LEFT JOIN bill_credit_one bc ON bc.xero_invoice_id = x.xero_invoice_id
$nv08$;
  -- 9. installer state carries the bill's row id instead of its lines
  ov09 text := $ov09$                    x.fully_paid_on,
                    x.line_items,
                    li.n,$ov09$;
  nv09 text := $nv09$                    x.fully_paid_on,
                    x.id AS x_row_id,
                    li.n,$nv09$;
  -- 10. installer state reads the installer set
  ov10 text := $ov10$WHEN NOT job_cost_installer_bill(bl.line_items) THEN 'not_installer'::text$ov10$;
  nv10 text := $nv10$WHEN NOT (bl.x_row_id IN ( SELECT installer_bill.id FROM installer_bill)) THEN 'not_installer'::text$nv10$;
  -- 11. a placement's credit share by the same join
  ov11 text := $ov11$            COALESCE(( SELECT c.credit_share
                   FROM bill_credit c
                  WHERE c.xero_invoice_id = x.xero_invoice_id
                 LIMIT 1), 0::numeric) AS credit_share,$ov11$;
  nv11 text := $nv11$            COALESCE(bc.credit_share, 0::numeric) AS credit_share,$nv11$;
  -- 12. (the join for 11)
  ov12 text := $ov12$             LEFT JOIN xero_invoices x ON x.xero_invoice_id = f.xero_invoice_id AND x.invoice_type = 'ACCPAY'::text
$ov12$;
  nv12 text := $nv12$             LEFT JOIN xero_invoices x ON x.xero_invoice_id = f.xero_invoice_id AND x.invoice_type = 'ACCPAY'::text
             LEFT JOIN bill_credit_one bc ON bc.xero_invoice_id = x.xero_invoice_id
$nv12$;
  -- 13. a placement's installer test skips the full check on a bill with no 301 or 306 line
  ov13 text := $ov13$(f.lane = 'labour'::text OR job_cost_installer_bill(x.line_items))$ov13$;
  nv13 text := $nv13$(f.lane = 'labour'::text OR x.line_items @? '$[*]?(@."AccountCode" == "306" || @."AccountCode" == "301" || @."AccountCode" == 306 || @."AccountCode" == 301)'::jsonpath AND job_cost_installer_bill(x.line_items))$nv13$;
  -- 14. trade_bill_bu: each crew line's business unit as one keyed map (a nested scan per line before)
  ov14 text := $ov14$        ), trade AS ($ov14$;
  nv14 text := $nv14$        ), trade_bill_bu AS (
         SELECT jsonb_object_agg(trade_bill_line.line_id::text, trade_bill_line.business_unit) AS m
           FROM trade_bill_line
        ), trade AS ($nv14$;
  -- 15. (reads 14)
  ov15 text := $ov15$            tbl.business_unit,$ov15$;
  nv15 text := $nv15$            tbu.m ->> r.line_id::text AS business_unit,$nv15$;
  -- 16. (joins 14)
  ov16 text := $ov16$             LEFT JOIN trade_bill_line tbl ON tbl.line_id = r.line_id$ov16$;
  nv16 text := $nv16$             CROSS JOIN trade_bill_bu tbu$nv16$;
  -- 17. sca: the supplier credit allocations read once (twice before)
  ov17 text := $ov17$        ), ledger_cn_bill AS ($ov17$;
  nv17 text := $nv17$        ), sca AS MATERIALIZED (
         SELECT v_supplier_credit_allocations.org_id,
            v_supplier_credit_allocations.xero_credit_note_id,
            v_supplier_credit_allocations.credit_note_number,
            v_supplier_credit_allocations.allocation_n,
            v_supplier_credit_allocations.xero_invoice_id,
            v_supplier_credit_allocations.amount,
            v_supplier_credit_allocations.state,
            v_supplier_credit_allocations.bill_side,
            v_supplier_credit_allocations.counts_from_credit_note
           FROM v_supplier_credit_allocations
        ), ledger_cn_bill AS ($nv17$;
  -- 18. (reads 17)
  ov18 text := $ov18$           FROM v_supplier_credit_allocations a
             JOIN ledger_cn_note l$ov18$;
  nv18 text := $nv18$           FROM sca a
             JOIN ledger_cn_note l$nv18$;
  -- 19. (reads 17)
  ov19 text := $ov19$             JOIN v_supplier_credit_allocations a ON a.xero_invoice_id = s.document_id AND a.counts_from_credit_note$ov19$;
  nv19 text := $nv19$             JOIN sca a ON a.xero_invoice_id = s.document_id AND a.counts_from_credit_note$nv19$;
  -- 20. a bill can carry a credit share only if it lists credit notes, states an amount credited above zero, or lists prepayments or overpayments (job_cost_credit_share's own branches); one jsonpath pass, then the share decides
  ov20 text := $ov20$          WHERE x.invoice_type = 'ACCPAY'::text AND job_cost_credit_share(x.raw_json, x.total) > 0::numeric$ov20$;
  nv20 text := $nv20$          WHERE x.invoice_type = 'ACCPAY'::text AND x.total > 0::numeric AND x.raw_json @? '$?(@."CreditNotes".size() > 0 || @."AmountCredited" > 0 || @."Prepayments".size() > 0 || @."Overpayments".size() > 0)'::jsonpath AND job_cost_credit_share(x.raw_json, x.total) > 0::numeric$nv20$;
BEGIN
  s_def := pg_get_viewdef('public.v_supplier_credit_allocations'::regclass, true);
  IF md5(s_def) = '9684232cbb1c45e7564ce168971d800e' THEN
    RAISE NOTICE 'v_supplier_credit_allocations already has 20261104123000';
  ELSE
    IF md5(s_def) <> '0000749040d6b72e63bf77a4318cf293' THEN
      RAISE EXCEPTION 'v_supplier_credit_allocations is not the definition this migration was written against (md5 %)', md5(s_def);
    END IF;
    IF (length(s_def) - length(replace(s_def, os01, ''))) / length(os01) <> 1 THEN
      RAISE EXCEPTION 'v_supplier_credit_allocations: change 1 of 4 does not find its text exactly once';
    END IF;
    s_def := replace(s_def, os01, ns01);
    IF (length(s_def) - length(replace(s_def, os02, ''))) / length(os02) <> 1 THEN
      RAISE EXCEPTION 'v_supplier_credit_allocations: change 2 of 4 does not find its text exactly once';
    END IF;
    s_def := replace(s_def, os02, ns02);
    IF (length(s_def) - length(replace(s_def, os03, ''))) / length(os03) <> 1 THEN
      RAISE EXCEPTION 'v_supplier_credit_allocations: change 3 of 4 does not find its text exactly once';
    END IF;
    s_def := replace(s_def, os03, ns03);
    IF (length(s_def) - length(replace(s_def, os04, ''))) / length(os04) <> 1 THEN
      RAISE EXCEPTION 'v_supplier_credit_allocations: change 4 of 4 does not find its text exactly once';
    END IF;
    s_def := replace(s_def, os04, ns04);
    EXECUTE 'CREATE OR REPLACE VIEW public.v_supplier_credit_allocations AS ' || s_def;
    IF md5(pg_get_viewdef('public.v_supplier_credit_allocations'::regclass, true)) <> '9684232cbb1c45e7564ce168971d800e' THEN
      RAISE EXCEPTION 'v_supplier_credit_allocations after the change is not the rehearsed definition (md5 %)', md5(pg_get_viewdef('public.v_supplier_credit_allocations'::regclass, true));
    END IF;
  END IF;
  v_def := pg_get_viewdef('public.v_job_cost_events'::regclass, true);
  IF md5(v_def) = 'b48997c55913ce3c90e3a3c947533fd3' THEN
    RAISE NOTICE 'v_job_cost_events already has 20261104123000';
  ELSE
    IF md5(v_def) <> 'abdc05a69d139d79aebbb8a3cebfae03' THEN
      RAISE EXCEPTION 'v_job_cost_events is not the definition this migration was written against (md5 %)', md5(v_def);
    END IF;
    IF (length(v_def) - length(replace(v_def, ov01, ''))) / length(ov01) <> 1 THEN
      RAISE EXCEPTION 'v_job_cost_events: change 1 of 20 does not find its text exactly once';
    END IF;
    v_def := replace(v_def, ov01, nv01);
    IF (length(v_def) - length(replace(v_def, ov02, ''))) / length(ov02) <> 1 THEN
      RAISE EXCEPTION 'v_job_cost_events: change 2 of 20 does not find its text exactly once';
    END IF;
    v_def := replace(v_def, ov02, nv02);
    IF (length(v_def) - length(replace(v_def, ov03, ''))) / length(ov03) <> 1 THEN
      RAISE EXCEPTION 'v_job_cost_events: change 3 of 20 does not find its text exactly once';
    END IF;
    v_def := replace(v_def, ov03, nv03);
    IF (length(v_def) - length(replace(v_def, ov04, ''))) / length(ov04) <> 2 THEN
      RAISE EXCEPTION 'v_job_cost_events: change 4 of 20 does not find its text exactly 2 times';
    END IF;
    v_def := replace(v_def, ov04, nv04);
    IF (length(v_def) - length(replace(v_def, ov05, ''))) / length(ov05) <> 1 THEN
      RAISE EXCEPTION 'v_job_cost_events: change 5 of 20 does not find its text exactly once';
    END IF;
    v_def := replace(v_def, ov05, nv05);
    IF (length(v_def) - length(replace(v_def, ov06, ''))) / length(ov06) <> 1 THEN
      RAISE EXCEPTION 'v_job_cost_events: change 6 of 20 does not find its text exactly once';
    END IF;
    v_def := replace(v_def, ov06, nv06);
    IF (length(v_def) - length(replace(v_def, ov07, ''))) / length(ov07) <> 1 THEN
      RAISE EXCEPTION 'v_job_cost_events: change 7 of 20 does not find its text exactly once';
    END IF;
    v_def := replace(v_def, ov07, nv07);
    IF (length(v_def) - length(replace(v_def, ov08, ''))) / length(ov08) <> 1 THEN
      RAISE EXCEPTION 'v_job_cost_events: change 8 of 20 does not find its text exactly once';
    END IF;
    v_def := replace(v_def, ov08, nv08);
    IF (length(v_def) - length(replace(v_def, ov09, ''))) / length(ov09) <> 1 THEN
      RAISE EXCEPTION 'v_job_cost_events: change 9 of 20 does not find its text exactly once';
    END IF;
    v_def := replace(v_def, ov09, nv09);
    IF (length(v_def) - length(replace(v_def, ov10, ''))) / length(ov10) <> 1 THEN
      RAISE EXCEPTION 'v_job_cost_events: change 10 of 20 does not find its text exactly once';
    END IF;
    v_def := replace(v_def, ov10, nv10);
    IF (length(v_def) - length(replace(v_def, ov11, ''))) / length(ov11) <> 1 THEN
      RAISE EXCEPTION 'v_job_cost_events: change 11 of 20 does not find its text exactly once';
    END IF;
    v_def := replace(v_def, ov11, nv11);
    IF (length(v_def) - length(replace(v_def, ov12, ''))) / length(ov12) <> 1 THEN
      RAISE EXCEPTION 'v_job_cost_events: change 12 of 20 does not find its text exactly once';
    END IF;
    v_def := replace(v_def, ov12, nv12);
    IF (length(v_def) - length(replace(v_def, ov13, ''))) / length(ov13) <> 1 THEN
      RAISE EXCEPTION 'v_job_cost_events: change 13 of 20 does not find its text exactly once';
    END IF;
    v_def := replace(v_def, ov13, nv13);
    IF (length(v_def) - length(replace(v_def, ov14, ''))) / length(ov14) <> 1 THEN
      RAISE EXCEPTION 'v_job_cost_events: change 14 of 20 does not find its text exactly once';
    END IF;
    v_def := replace(v_def, ov14, nv14);
    IF (length(v_def) - length(replace(v_def, ov15, ''))) / length(ov15) <> 1 THEN
      RAISE EXCEPTION 'v_job_cost_events: change 15 of 20 does not find its text exactly once';
    END IF;
    v_def := replace(v_def, ov15, nv15);
    IF (length(v_def) - length(replace(v_def, ov16, ''))) / length(ov16) <> 1 THEN
      RAISE EXCEPTION 'v_job_cost_events: change 16 of 20 does not find its text exactly once';
    END IF;
    v_def := replace(v_def, ov16, nv16);
    IF (length(v_def) - length(replace(v_def, ov17, ''))) / length(ov17) <> 1 THEN
      RAISE EXCEPTION 'v_job_cost_events: change 17 of 20 does not find its text exactly once';
    END IF;
    v_def := replace(v_def, ov17, nv17);
    IF (length(v_def) - length(replace(v_def, ov18, ''))) / length(ov18) <> 1 THEN
      RAISE EXCEPTION 'v_job_cost_events: change 18 of 20 does not find its text exactly once';
    END IF;
    v_def := replace(v_def, ov18, nv18);
    IF (length(v_def) - length(replace(v_def, ov19, ''))) / length(ov19) <> 1 THEN
      RAISE EXCEPTION 'v_job_cost_events: change 19 of 20 does not find its text exactly once';
    END IF;
    v_def := replace(v_def, ov19, nv19);
    IF (length(v_def) - length(replace(v_def, ov20, ''))) / length(ov20) <> 1 THEN
      RAISE EXCEPTION 'v_job_cost_events: change 20 of 20 does not find its text exactly once';
    END IF;
    v_def := replace(v_def, ov20, nv20);
    EXECUTE 'CREATE OR REPLACE VIEW public.v_job_cost_events AS ' || v_def;
    IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) <> 'b48997c55913ce3c90e3a3c947533fd3' THEN
      RAISE EXCEPTION 'v_job_cost_events after the change is not the rehearsed definition (md5 %)', md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true));
    END IF;
  END IF;
END
$mig$;
