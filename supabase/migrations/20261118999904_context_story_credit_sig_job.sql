-- Follow-up 58: a job-scoped supplier-credit signature for the story book.
-- Measured on live 18 Nov (one ZZTEST job, no credits): context_job_story_credit_sig took
-- 11.5 s of the book's 12 s, because it reads v_supplier_credit_placement, which works out
-- every credit note's placement for the whole company before keeping this job's rows.
--
-- This migration creates functions only. It replaces nothing: context_job_story_credit_sig
-- keeps its live body (md5 a5d0f9f74c14ab88cc502f2d2ad98f27) until the director runs
-- install_context_story_credit_sig_job(); remove_context_story_credit_sig_job() puts it back
-- in one statement. No table, index, trigger, timer or switch is created or changed.
--
--   context_job_story_credit_sig_main(uuid)  exact copy of today's body (same prosrc, same md5)
--   context_job_story_credit_sig_job(uuid)   same hash, from this job's rows only
--   context_job_story_credit_sig_fast(uuid)  source guard, then _job; any changed source or
--                                            failed read gets _main's answer
--   install_ / remove_context_story_credit_sig_job()  swap the live name to _fast and back
--
-- Why _job returns the same hash. Only the placement view's placed branch carries a job_id,
-- and the signature keeps only rows of this job, so the job's witness rows are exactly:
-- its supplier bill rows (v_job_cost_events, the view's own bill_row filter) on bills a
-- credit note is allocated to, joined to those bills' live allocations, summed per
-- allocation as the view sums them. Filtering a view's output by job or by bill never
-- changes another row's value, so those rows are the view's rows. The witness select is the
-- original's, word for word.
--
-- The gate. Before any cost read, _job asks whether any allocated bill can sit on this job
-- at all. v_job_cost_events (legacy body b48997c5...) gives a supplier or fact row a job_id
-- only from: the bill's own job (xero_invoices.job_id), a bookkeeping evidence line, a
-- bookkeeping evidence part, a job number in a bill line's description
-- (job_cost_bill_line_job_id), or a materials fact on the bill; the employer-super rows copy
-- their bill line's job. Each route is probed with the allocated bills as one array, on an
-- existing index. None hits: no placed row can exist, and the answer is NULL, as today.
-- _fast falls back to _main whenever the cost views, the placement view or the parts view
-- differ from the bodies this was written against, or the cost-lines cutover is ready.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Guard: the live body this was written against, or this migration already applied.
DO $guard$
/* block */ BEGIN
 IF to_regprocedure('public.context_job_story_credit_sig(uuid)') IS NULL THEN
  RAISE EXCEPTION 'credit_sig_job_missing_source';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_job_story_credit_sig(uuid)'::regprocedure)
    IS DISTINCT FROM 'a5d0f9f74c14ab88cc502f2d2ad98f27'
 AND (to_regprocedure('public.context_job_story_credit_sig_fast(uuid)') IS NULL
   OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.context_job_story_credit_sig(uuid)'::regprocedure)
      IS DISTINCT FROM (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.context_job_story_credit_sig_fast(uuid)'))) THEN
  RAISE EXCEPTION 'credit_sig_job_preimage_changed';
 END IF;
 IF to_regprocedure('public.context_job_story_credit_sig_main(uuid)') IS NOT NULL
 AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.context_job_story_credit_sig_main(uuid)'))
    IS DISTINCT FROM 'a5d0f9f74c14ab88cc502f2d2ad98f27' THEN
  RAISE EXCEPTION 'credit_sig_job_main_copy_changed';
 END IF;
END $guard$;

-- The old body under another name, derived from the live definition (never retyped).
DO $copy$
DECLARE d text;
/* block */ BEGIN
 IF to_regprocedure('public.context_job_story_credit_sig_main(uuid)') IS NOT NULL THEN RETURN; END IF;
 d := pg_get_functiondef('public.context_job_story_credit_sig(uuid)'::regprocedure);
 EXECUTE replace(d, 'public.context_job_story_credit_sig(', 'public.context_job_story_credit_sig_main(');
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_job_story_credit_sig_main(uuid)'::regprocedure)
    IS DISTINCT FROM 'a5d0f9f74c14ab88cc502f2d2ad98f27' THEN
  RAISE EXCEPTION 'credit_sig_job_main_copy_postimage';
 END IF;
END $copy$;
COMMENT ON FUNCTION public.context_job_story_credit_sig_main(uuid) IS
 'Follow-up 58 (20261118999904): the company-wide supplier-credit signature, byte for byte the body context_job_story_credit_sig had before install_context_story_credit_sig_job (TP-07/TP-16 20261031010000). Fallback for _fast and the body remove_context_story_credit_sig_job restores. Service role only.';

CREATE OR REPLACE FUNCTION public.context_job_story_credit_sig_job(p_job_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
 v_bills text[];
 v_sig text;
 v_missed boolean;
/* function block */ BEGIN
 -- Every bill a credit note is allocated to: the placement view's own bill_row filter.
 -- A small table (one row per allocation); its whole read is the bounded set.
 SELECT array_agg(DISTINCT a.xero_invoice_id) INTO v_bills
   FROM public.xero_supplier_credit_note_allocations a
  WHERE a.xero_invoice_id IS NOT NULL;
 IF v_bills IS NULL THEN RETURN NULL; END IF;

 -- Gate: the allocated bills that can sit on this job by any route the cost view uses.
 -- Each probe takes the bills as one array (a plain parameter, so it reaches inside the
 -- evidence view's DISTINCT ON): xero_invoices_xero_invoice_id_idx,
 -- job_materials_facts_invoice_job_uidx, bookkeeping_line_evidence_line_idx,
 -- bookkeeping_line_evidence_parts_line_idx; job numbers in bill lines through
 -- jobs_context_job_number_upper inside job_cost_bill_line_job_id.
 SELECT array_agg(b.id) INTO v_bills
   FROM unnest(v_bills) AS b(id)
  WHERE b.id IN (SELECT x.xero_invoice_id FROM public.xero_invoices x
                  WHERE x.xero_invoice_id = ANY (v_bills) AND x.job_id = p_job_id)
     OR b.id IN (SELECT f.xero_invoice_id FROM public.job_materials_facts f
                  WHERE f.xero_invoice_id = ANY (v_bills) AND f.job_id = p_job_id)
     OR b.id IN (SELECT e.xero_invoice_id FROM public.v_bookkeeping_line_evidence_current e
                  WHERE e.xero_invoice_id = ANY (v_bills) AND e.job_id = p_job_id)
     -- The parts view (guarded in _fast by its md5) keeps a subset of this table's rows,
     -- so probing the table is a superset.
     OR b.id IN (SELECT p.xero_invoice_id FROM public.bookkeeping_line_evidence_parts p
                  WHERE p.xero_invoice_id = ANY (v_bills) AND p.job_id = p_job_id)
     OR b.id IN (SELECT x.xero_invoice_id FROM public.xero_invoices x
                  CROSS JOIN LATERAL jsonb_array_elements(
                    CASE WHEN jsonb_typeof(x.line_items) = 'array' THEN x.line_items ELSE '[]'::jsonb END) li(value)
                  WHERE x.xero_invoice_id = ANY (v_bills)
                    AND strpos(upper(COALESCE(li.value ->> 'Description', '')), 'SW') > 0
                    AND public.job_cost_bill_line_job_id(li.value ->> 'Description') = p_job_id);
 IF v_bills IS NULL THEN RETURN NULL; END IF;

 -- Exact: the placement view's placed branch for this job. One read of this job's cost rows.
 WITH bill_row AS MATERIALIZED (
  SELECT e.document_id AS xero_invoice_id, e.job_id, e.amount_ex, e.is_actual
    FROM public.v_job_cost_events e
   WHERE e.job_id = p_job_id
     AND e.party_kind = 'supplier'
     AND e.match_method IS DISTINCT FROM 'xero_amount_credited'
     AND e.match_method IS DISTINCT FROM 'xero_credit_note'
     AND e.source IN ('supplier_bill', 'materials_fact', 'installer_bill_unconfirmed', 'installer_bill_not_job_related')
     AND e.job_id IS NOT NULL
     AND e.document_id IN (SELECT a.xero_invoice_id FROM public.xero_supplier_credit_note_allocations a)
 ),
 alloc AS MATERIALIZED (
  -- Its window is per (org, bill), so a bill filter keeps every value.
  SELECT a.*
    FROM public.v_supplier_credit_allocations a
   WHERE a.xero_invoice_id = ANY (v_bills)
     AND a.state = 'bill_live'
 ),
 part AS (
  SELECT a.org_id, a.xero_credit_note_id, a.allocation_n, r.job_id,
         sum(r.amount_ex) AS part_ex,
         bool_and(r.is_actual) AS part_is_actual,
         sum(public.job_cost_credit_note_part(r.amount_ex, a.amount, a.bill_total)) FILTER (WHERE r.amount_ex <> 0) AS credit_ex,
         sum(public.job_cost_credit_note_part(r.amount_ex, a.amount, a.bill_total)) FILTER (WHERE r.amount_ex <> 0 AND r.is_actual) AS actual_credit_ex
    FROM alloc a
    JOIN bill_row r ON r.xero_invoice_id = a.xero_invoice_id
   WHERE a.state = 'bill_live'
   GROUP BY a.org_id, a.xero_credit_note_id, a.allocation_n, r.job_id
 ),
 -- The view's placed select, column for column (names, order and types).
 p AS (
  SELECT j.org_id, j.xero_credit_note_id, j.credit_note_number, j.xero_contact_id, j.contact_name, j.credit_note_date,
         j.credit_note_status, j.allocation_n, j.allocation_id, j.xero_invoice_id, j.invoice_number, j.bill_status,
         j.allocation_date, j.amount::numeric AS amount, 'placed'::text AS state,
         p.job_id, p.part_ex AS bill_part_ex, p.credit_ex,
         p.part_is_actual, j.bill_side_applied,
         j.bill_side,
         CASE
           WHEN j.counts_from_credit_note THEN 'counted_from_credit_note'
           WHEN j.exceeds_bill THEN 'exceeds_bill'
           WHEN j.bill_side = 'counts_it' THEN 'counted_by_bill'
           ELSE 'bill_amount_credited'
         END::text AS job_profit,
         CASE WHEN j.counts_from_credit_note THEN COALESCE(p.actual_credit_ex, 0) END::numeric AS counted_ex,
         'allocation:'::text || j.allocation_n AS part_key
    FROM alloc j
    JOIN part p ON p.org_id = j.org_id AND p.xero_credit_note_id = j.xero_credit_note_id AND p.allocation_n = j.allocation_n
 )
 SELECT (SELECT md5(jsonb_agg(w.witness ORDER BY w.witness::text)::text)
           FROM (
            SELECT jsonb_build_array(to_jsonb(p), n.credit_note_type, n.reference,
              n.line_amount_types, n.currency_code, n.sub_total, n.total_tax, n.total,
              n.remaining_credit, n.fully_paid_on, n.allocations_returned,
              n.raw_json->'Payments') AS witness
            FROM p
            JOIN public.jobs j ON j.id=p.job_id AND j.org_id=p.org_id
            JOIN public.xero_supplier_credit_notes n
              ON n.org_id=p.org_id AND n.xero_credit_note_id=p.xero_credit_note_id
            WHERE p.job_id=p_job_id
           ) w),
        EXISTS (SELECT 1 FROM bill_row r WHERE NOT (r.xero_invoice_id = ANY (v_bills)))
   INTO v_sig, v_missed;
 -- A bill row the gate did not foresee means the route list is out of date: never guess.
 IF v_missed THEN RAISE EXCEPTION 'credit_sig_job_gate_missed_route'; END IF;
 RETURN v_sig;
END $fn$;
COMMENT ON FUNCTION public.context_job_story_credit_sig_job(uuid) IS
 'Follow-up 58 (20261118999904): the supplier-credit signature context_job_story_credit_sig_main gives, worked out from this job''s rows only. A gate probes the allocated bills against every route by which v_job_cost_events puts a supplier or fact row on a job (bill job, bookkeeping evidence line or part, job number in a bill line, materials fact); no hit returns NULL with no cost read. Otherwise one read of this job''s cost rows and those bills'' allocations, then the placement view''s placed select and the original witness. Raises credit_sig_job_gate_missed_route if a cost row sits on a bill the gate did not name. Read only. Service role only.';

CREATE OR REPLACE FUNCTION public.context_job_story_credit_sig_fast(p_job_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
/* function block */ BEGIN
 -- The gate's route list and the placed select were read from these bodies. feature_flags
 -- and the cutover singleton are read by their primary keys.
 IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) IS DISTINCT FROM 'c2e9632718dfa057703f1ee36b97322e'
 OR md5(pg_get_viewdef('public.v_job_cost_events_legacy'::regclass, true)) IS DISTINCT FROM 'b48997c55913ce3c90e3a3c947533fd3'
 OR md5(pg_get_viewdef('public.v_supplier_credit_placement'::regclass, true)) IS DISTINCT FROM 'e9754f7c63e856eb80f4f6c240039323'
 OR md5(pg_get_viewdef('public.v_bookkeeping_line_parts_current'::regclass, true)) IS DISTINCT FROM '8d1e063dbf8e08524c6c3b2d6023b9c3'
 OR (EXISTS (SELECT 1 FROM public.feature_flags f WHERE f.flag_name = 'job_cost_events_from_cost_lines_v1' AND f.enabled)
     AND EXISTS (SELECT 1 FROM public.job_cost_events_cutover c WHERE c.singleton AND c.completed_at IS NOT NULL)) THEN
  RETURN public.context_job_story_credit_sig_main(p_job_id);
 END IF;
 RETURN public.context_job_story_credit_sig_job(p_job_id);
EXCEPTION WHEN OTHERS THEN
 -- A changed source or a failed read gets exactly the company-wide answer (or its error).
 -- A cancel or statement timeout is not caught here.
 RETURN public.context_job_story_credit_sig_main(p_job_id);
END $fn$;
COMMENT ON FUNCTION public.context_job_story_credit_sig_fast(uuid) IS
 'Follow-up 58 (20261118999904): the body install_context_story_credit_sig_job puts under context_job_story_credit_sig. Uses context_job_story_credit_sig_job while v_job_cost_events, its legacy body, v_supplier_credit_placement and v_bookkeeping_line_parts_current are the definitions it was written against and the cost-lines cutover is not ready; otherwise, or on any error, context_job_story_credit_sig_main. Service role only.';

CREATE OR REPLACE FUNCTION public.install_context_story_credit_sig_job() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE d text;
/* function block */ BEGIN
 PERFORM set_config('lock_timeout', '5s', true);
 IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.context_job_story_credit_sig(uuid)'::regprocedure) =
    (SELECT prosrc FROM pg_proc WHERE oid = 'public.context_job_story_credit_sig_fast(uuid)'::regprocedure) THEN RETURN; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_job_story_credit_sig(uuid)'::regprocedure)
    IS DISTINCT FROM 'a5d0f9f74c14ab88cc502f2d2ad98f27' THEN
  RAISE EXCEPTION 'credit_sig_job_install_preimage_changed';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_job_story_credit_sig_main(uuid)'::regprocedure)
    IS DISTINCT FROM 'a5d0f9f74c14ab88cc502f2d2ad98f27' THEN
  RAISE EXCEPTION 'credit_sig_job_install_main_copy_changed';
 END IF;
 d := pg_get_functiondef('public.context_job_story_credit_sig_fast(uuid)'::regprocedure);
 EXECUTE replace(d, 'public.context_job_story_credit_sig_fast(', 'public.context_job_story_credit_sig(');
END $fn$;

CREATE OR REPLACE FUNCTION public.remove_context_story_credit_sig_job() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE d text;
/* function block */ BEGIN
 PERFORM set_config('lock_timeout', '5s', true);
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_job_story_credit_sig(uuid)'::regprocedure)
    = 'a5d0f9f74c14ab88cc502f2d2ad98f27' THEN RETURN; END IF;
 IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.context_job_story_credit_sig(uuid)'::regprocedure) IS DISTINCT FROM
    (SELECT prosrc FROM pg_proc WHERE oid = 'public.context_job_story_credit_sig_fast(uuid)'::regprocedure) THEN
  RAISE EXCEPTION 'credit_sig_job_remove_preimage_changed';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_job_story_credit_sig_main(uuid)'::regprocedure)
    IS DISTINCT FROM 'a5d0f9f74c14ab88cc502f2d2ad98f27' THEN
  RAISE EXCEPTION 'credit_sig_job_remove_main_copy_changed';
 END IF;
 d := pg_get_functiondef('public.context_job_story_credit_sig_main(uuid)'::regprocedure);
 EXECUTE replace(d, 'public.context_job_story_credit_sig_main(', 'public.context_job_story_credit_sig(');
END $fn$;
COMMENT ON FUNCTION public.install_context_story_credit_sig_job() IS
 'Follow-up 58 (20261118999904): puts context_job_story_credit_sig_fast''s body under context_job_story_credit_sig (money_sig and money_sig_stored call that name). Refuses unless the live body is 20261031010000''s (md5 a5d0f9f74c14ab88cc502f2d2ad98f27); a second run does nothing. Undo: remove_context_story_credit_sig_job().';
COMMENT ON FUNCTION public.remove_context_story_credit_sig_job() IS
 'Follow-up 58 (20261118999904): puts the 20261031010000 body back under context_job_story_credit_sig, from context_job_story_credit_sig_main. Refuses if the live body is neither that nor the installed one; a second run does nothing.';

REVOKE ALL ON FUNCTION public.context_job_story_credit_sig_main(uuid),
 public.context_job_story_credit_sig_job(uuid), public.context_job_story_credit_sig_fast(uuid),
 public.install_context_story_credit_sig_job(), public.remove_context_story_credit_sig_job()
 FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_story_credit_sig_main(uuid),
 public.context_job_story_credit_sig_job(uuid), public.context_job_story_credit_sig_fast(uuid),
 public.install_context_story_credit_sig_job(), public.remove_context_story_credit_sig_job()
 TO service_role;
