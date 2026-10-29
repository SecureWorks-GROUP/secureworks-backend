-- Down for 20261029230000_materials_ai_address_supplier_keys.sql.
--
-- materials_ai_hard_keys goes back to 20261029093000's body byte for byte
-- (job_number and purchase_order are the only keys again; the same supplier is
-- recorded as key_evidence.supplier_history only and the site address is not
-- read), with that migration's comments on the function, the agreed_keys and
-- key_evidence columns and the view. Nothing else changed, so nothing else
-- moves. Audit rows already written keep the keys they recorded
-- (site_address, same_supplier): both stay allowed by 20261029093000's keys
-- check, and a placement stays placed.
--
-- Refuses when a later migration has since replaced the function's body: roll
-- that one back first. 20261029093000's own body already live (a second run of
-- this rollback) changes nothing; so does an absent function (20261029093000
-- was rolled back first, and its down drops the function whatever its body).

DO $guard$
DECLARE live text;
BEGIN
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.materials_ai_hard_keys(text,uuid)');
  IF live IS NOT NULL AND live NOT IN ('876de05a1bf1ea9bf7fcb5bac3ef60b9', '2ef85da40004fb45adc42ea2488e8947') THEN
    RAISE EXCEPTION 'materials_ai_address_supplier_keys_down_preimage_mismatch: %; roll the later migration back first',
      format('%s md5 %s', 'public.materials_ai_hard_keys(text,uuid)', live);
  END IF;
  IF live IS NULL THEN
    RAISE NOTICE 'materials_ai_hard_keys is absent (20261029093000 was rolled back): nothing to restore';
  END IF;
END $guard$;

-- Only while the function exists: after 20261029093000's down there is
-- nothing to restore, and recreating the function would leave it orphaned.
-- The restored text sits in EXECUTE strings so the down runs as plain SQL.
DO $down$
BEGIN
  IF to_regprocedure('public.materials_ai_hard_keys(text,uuid)') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE $fn$CREATE OR REPLACE FUNCTION public.materials_ai_hard_keys(p_bill text, p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  -- The one job-number grammar (bill_prematch.ts jobNumbersIn): SW-prefixed
  -- forms only, so a bare number on a bill ("Qty 1234") is never a job number.
  c_job_re constant text := '(?<![A-Z0-9])SW(MS|[A-Z])(?:-([0-9]{4,6})|[[:blank:]]?-?[[:blank:]]?([0-9]{5,6}))(?![A-Z0-9])';
  -- A purchase order gives a key only once it was issued: never a quote
  -- request, a draft, or one with no status.
  c_issued constant text[] := ARRAY['approved', 'submitted', 'authorised', 'sent', 'confirmed', 'delivered', 'billed'];
  c_dead constant text[] := ARRAY['deleted', 'cancelled', 'canceled', 'voided', 'void'];
  -- A person's or a rule's placement; never the AI's own, checked or not.
  c_vouchers constant text[] := ARRAY['manual_queue', 'manual_split', 'xero_ref_link', 'po_deterministic', 'agent_prematch'];
  c_window_days constant integer := 180;
  v_job public.jobs%ROWTYPE;
  v_ref text;
  v_lines jsonb;
  v_date date;
  v_contact text;
  v_keys text[] := '{}';
  v_ev jsonb := '{}'::jsonb;
  v_withheld text[] := '{}';
  v_text text;
  v_potext text;
  v_words text;
  v_hit text;
  v_po text;
  v_num text;
  v_other text[];
  v_other_po text[];
  v_twins text[];
  v_sup_jobs integer;
BEGIN
  IF p_bill IS NULL OR p_job_id IS NULL THEN
    RETURN jsonb_build_object('keys', '[]'::jsonb, 'evidence', '{}'::jsonb);
  END IF;
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id;
  IF v_job.id IS NULL THEN
    RETURN jsonb_build_object('keys', '[]'::jsonb, 'evidence', '{}'::jsonb);
  END IF;
  -- A holding job (SWF-PDF-BUCKET) or a dead job is never a job a clue vouches for.
  IF lower(COALESCE(v_job.metadata ->> 'do_not_schedule', '')) = 'true' THEN
    RETURN jsonb_build_object('keys', '[]'::jsonb, 'evidence', jsonb_build_object('withheld', v_job.job_number || ' is a holding job'));
  END IF;
  IF lower(COALESCE(v_job.status, '')) IN ('cancelled', 'lost') THEN
    RETURN jsonb_build_object('keys', '[]'::jsonb, 'evidence', jsonb_build_object('withheld', v_job.job_number || ' is ' || lower(v_job.status)));
  END IF;
  v_num := upper(btrim(COALESCE(v_job.job_number, '')));
  SELECT x.reference, CASE WHEN jsonb_typeof(x.line_items) = 'array' THEN x.line_items ELSE '[]'::jsonb END, x.invoice_date
    INTO v_ref, v_lines, v_date
    FROM public.xero_invoices x
   WHERE x.xero_invoice_id = p_bill AND x.invoice_type = 'ACCPAY'
   ORDER BY (x.status IN ('AUTHORISED', 'PAID')) DESC
   LIMIT 1;
  v_lines := COALESCE(v_lines, '[]'::jsonb);
  v_text := concat_ws(E'\n', NULLIF(btrim(v_ref), ''),
                      (SELECT string_agg(li.value ->> 'Description', E'\n' ORDER BY li.n)
                         FROM jsonb_array_elements(v_lines) WITH ORDINALITY li(value, n)));
  v_text := COALESCE(v_text, '');
  -- Purchase orders are read with every job number taken out, so a digits-only
  -- PO "39002" is never found inside "SWP-39002".
  v_potext := regexp_replace(v_text, c_job_re, ' ', 'gi');
  v_words := ' ' || btrim(regexp_replace(lower(v_potext), '[^a-z0-9]+', ' ', 'g')) || ' ';

  -- 0. Nothing on the bill may point at another job (the rules lane's
  --    split_bill / job_disagrees): another job number in any SW form, or a
  --    purchase order (any status but dead) that is another job's or has no
  --    job, named on the bill or linked to it. Then no key at all.
  SELECT array_agg(DISTINCT t.num ORDER BY t.num) INTO v_other
    FROM (SELECT 'SW' || upper(m[1]) || '-' || COALESCE(m[2], m[3]) AS num
            FROM regexp_matches(v_text, c_job_re, 'gi') m) t
   WHERE t.num <> v_num;
  SELECT array_agg(DISTINCT t.label ORDER BY t.label) INTO v_other_po
    FROM (SELECT po.po_number || CASE WHEN po.job_id IS NULL THEN ' (no job)'
                                      ELSE ' (' || COALESCE(j.job_number, 'a job not on record') || ')' END AS label
            FROM public.purchase_orders po
            LEFT JOIN public.jobs j ON j.id = po.job_id
           WHERE po.job_id IS DISTINCT FROM v_job.id
             AND NOT (COALESCE(lower(po.status), '') = ANY (c_dead))
             AND ((po.xero_bill_id IS NOT NULL AND po.xero_bill_id = p_bill)
                  OR (length(btrim(COALESCE(po.po_number, ''))) >= 5 AND po.po_number ~ '[0-9]'
                      AND strpos(v_potext, substring(po.po_number from '([0-9]+)[^0-9]*$')) > 0
                      AND (v_words LIKE ('% ' || btrim(regexp_replace(lower(po.po_number), '[^a-z0-9]+', ' ', 'g')) || ' %')
                           OR (btrim(po.po_number) ~ '^[A-Za-z]+[[:space:]#:.-]*[0-9]+$'
                               AND v_potext ~* ('(^|[^A-Za-z0-9])' || substring(btrim(po.po_number) from '^([A-Za-z]+)')
                                                || '[[:space:]#:.-]{0,3}' || substring(btrim(po.po_number) from '([0-9]+)$')
                                                || '($|[^A-Za-z0-9])')))))) t;
  IF v_other IS NOT NULL OR v_other_po IS NOT NULL THEN
    RETURN jsonb_build_object('keys', '[]'::jsonb, 'evidence', jsonb_build_object('withheld',
      'the bill also names ' || concat_ws('; ', array_to_string(v_other, ', '), array_to_string(v_other_po, ', '))));
  END IF;

  -- 1. The job's number on the bill, in an SW form. A number another job
  --    shares the digits of (SWF-39001 and SWP-39001) gives no key.
  IF v_num ~ '^SW(MS|[A-Z])-[0-9]{4,6}$' THEN
    SELECT t.place INTO v_hit
      FROM (SELECT 'reference'::text AS place, v_ref AS body, 0 AS n
            UNION ALL
            SELECT 'line ' || li.n, li.value ->> 'Description', li.n::int
              FROM jsonb_array_elements(v_lines) WITH ORDINALITY li(value, n)) t
     WHERE t.body IS NOT NULL
       AND EXISTS (SELECT 1
                     FROM regexp_matches(t.body, c_job_re, 'gi') m
                    WHERE 'SW' || upper(m[1]) || '-' || COALESCE(m[2], m[3]) = v_num)
     ORDER BY t.n
     LIMIT 1;
    IF v_hit IS NOT NULL THEN
      SELECT array_agg(j.job_number ORDER BY j.job_number COLLATE "C") INTO v_twins
        FROM public.jobs j
       WHERE j.id <> v_job.id
         AND j.job_number LIKE ('%' || substring(v_num from '([0-9]+)$'))
         AND regexp_replace(j.job_number, '[^0-9]', '', 'g') = substring(v_num from '([0-9]+)$');
      IF v_twins IS NULL THEN
        v_keys := v_keys || 'job_number'::text;
        v_ev := v_ev || jsonb_build_object('job_number', v_job.job_number || ' in ' || v_hit);
      ELSE
        v_withheld := v_withheld || (v_job.job_number || ' shares its digits with ' || array_to_string(v_twins, ', '));
      END IF;
    END IF;
  END IF;

  -- 2. An issued purchase order of that job, named on the bill or matched to
  --    it by the rules, whose number no other job holds and which no other bill
  --    has been matched to. A PO number with no letter prefix ("39002") gives
  --    no key: any standalone number on a bill ("Item 39002 posts") would match
  --    it. It is recorded in withheld instead.
  v_hit := NULL;
  SELECT po.po_number,
         po.po_number || CASE WHEN EXISTS (SELECT 1 FROM public.job_materials_facts f
                                            WHERE f.xero_invoice_id = p_bill AND f.matched_po_id = po.id)
                              THEN ' (matched by the rules)' ELSE ' on the bill' END
    INTO v_po, v_hit
    FROM public.purchase_orders po
   WHERE po.job_id = v_job.id
     AND lower(po.status) = ANY (c_issued)
     AND (po.xero_bill_id IS NULL OR po.xero_bill_id = p_bill)
     AND NOT EXISTS (SELECT 1 FROM public.job_materials_facts f WHERE f.matched_po_id = po.id AND f.xero_invoice_id <> p_bill)
     AND NOT EXISTS (SELECT 1 FROM public.purchase_orders p2
                      WHERE p2.id <> po.id AND p2.job_id IS DISTINCT FROM v_job.id
                        AND NOT (COALESCE(lower(p2.status), '') = ANY (c_dead))
                        AND btrim(regexp_replace(lower(p2.po_number), '[^a-z0-9]+', ' ', 'g'))
                            = btrim(regexp_replace(lower(po.po_number), '[^a-z0-9]+', ' ', 'g')))
     AND (EXISTS (SELECT 1 FROM public.job_materials_facts f WHERE f.xero_invoice_id = p_bill AND f.matched_po_id = po.id)
          OR (length(btrim(COALESCE(po.po_number, ''))) >= 5 AND po.po_number ~ '[0-9]'
              AND (v_words LIKE ('% ' || btrim(regexp_replace(lower(po.po_number), '[^a-z0-9]+', ' ', 'g')) || ' %')
                   OR (btrim(po.po_number) ~ '^[A-Za-z]+[[:space:]#:.-]*[0-9]+$'
                       AND v_potext ~* ('(^|[^A-Za-z0-9])' || substring(btrim(po.po_number) from '^([A-Za-z]+)')
                                        || '[[:space:]#:.-]{0,3}' || substring(btrim(po.po_number) from '([0-9]+)$')
                                        || '($|[^A-Za-z0-9])')))))
   ORDER BY (btrim(po.po_number) !~ '^[A-Za-z]'), po.po_number COLLATE "C"
   LIMIT 1;
  IF v_hit IS NOT NULL AND btrim(v_po) ~ '^[A-Za-z]' THEN
    v_keys := v_keys || 'purchase_order'::text;
    v_ev := v_ev || jsonb_build_object('purchase_order', v_hit);
  ELSIF v_hit IS NOT NULL THEN
    v_withheld := v_withheld || ('PO ' || btrim(v_po) || ' is digits only');
  END IF;

  -- 3. The same supplier is a recorded clue, NOT a key, until TP-04 (owner's
  --    reviewer, 29 Oct 2026): one person placement would let the AI place
  --    every later bill of that supplier on that job, the job count sees only
  --    placed rows (never the supplier's open or filed bills for other jobs),
  --    and the AI already reads that supplier history, so it is not
  --    independent of the AI's own reasoning. When, within 180 days of the
  --    bill, the supplier billed exactly one live job, this one, and a person
  --    or a rule placed a live bill of theirs there, it is kept in
  --    key_evidence.supplier_history. The AI's own placements never count.
  SELECT q.xero_contact_id INTO v_contact FROM public.materials_reconciliation_queue q WHERE q.xero_invoice_id = p_bill;
  v_hit := NULL;
  IF NULLIF(btrim(COALESCE(v_contact, '')), '') IS NOT NULL AND v_date IS NOT NULL THEN
    SELECT count(DISTINCT f.job_id) INTO v_sup_jobs
      FROM public.job_materials_facts f
      JOIN public.jobs j ON j.id = f.job_id
     WHERE f.xero_contact_id = v_contact
       AND f.xero_invoice_id <> p_bill
       AND f.kind = 'actual'
       AND lower(COALESCE(j.metadata ->> 'do_not_schedule', '')) <> 'true'
       AND lower(COALESCE(j.status, '')) NOT IN ('cancelled', 'lost')
       AND (f.fact_date IS NULL OR f.fact_date BETWEEN v_date - c_window_days AND v_date + c_window_days);
    IF v_sup_jobs = 1 THEN
      SELECT COALESCE(f.invoice_number, f.xero_invoice_id) || ' (' || f.automation_source || ')' INTO v_hit
        FROM public.job_materials_facts f
       WHERE f.job_id = v_job.id
         AND f.xero_contact_id = v_contact
         AND f.xero_invoice_id <> p_bill
         AND f.kind = 'actual'
         AND f.automation_source = ANY (c_vouchers)
         AND f.fact_date BETWEEN v_date - c_window_days AND v_date + c_window_days
         AND EXISTS (SELECT 1 FROM public.xero_invoices x
                      WHERE x.xero_invoice_id = f.xero_invoice_id AND x.status IN ('AUTHORISED', 'PAID'))
       ORDER BY f.fact_date DESC, f.xero_invoice_id COLLATE "C"
       LIMIT 1;
    ELSIF v_sup_jobs > 1 THEN
      v_withheld := v_withheld || ('the supplier billed ' || v_sup_jobs || ' live jobs within ' || c_window_days || ' days');
    END IF;
    IF v_hit IS NOT NULL THEN
      v_ev := v_ev || jsonb_build_object('supplier_history', v_hit || ', not a key until TP-04');
    END IF;
  END IF;

  IF cardinality(v_withheld) > 0 THEN
    v_ev := v_ev || jsonb_build_object('withheld', array_to_string(v_withheld, '; '));
  END IF;
  RETURN jsonb_build_object('keys', to_jsonb(v_keys), 'evidence', v_ev);
END;
$$$fn$;
  EXECUTE $fn$COMMENT ON FUNCTION public.materials_ai_hard_keys(text, uuid) IS
  'AI bill two keys (20261029093000): the hard clues on one bill that agree with one job: {keys: [job_number, purchase_order], evidence: {key: what it saw, supplier_history: recorded only, withheld: why a key was not given}}. No key at all for a holding or dead job, or when the bill also names another job number or another job''s purchase order. job_number: SW forms only, never a number another job shares the digits of. purchase_order: an issued PO (approved .. billed; never quote_requested, draft or no status) of this job whose number starts with letters (a digits-only number is withheld), held by no other job, matched to no other bill. same_supplier is not a key until TP-04: a live person or rule placement of the same Xero contact on this job within 180 days, when that supplier billed no other live job in the window, is recorded as supplier_history only; AI placements never count. Read only. Used by materials_ai_apply and v_materials_ai_placed_without_key. Service role only.'$fn$;
  EXECUTE $fn$REVOKE ALL ON FUNCTION public.materials_ai_hard_keys(text, uuid) FROM PUBLIC, anon, authenticated$fn$;
  EXECUTE $fn$GRANT EXECUTE ON FUNCTION public.materials_ai_hard_keys(text, uuid) TO service_role$fn$;
  EXECUTE $fn$COMMENT ON COLUMN public.materials_ai_placements.agreed_keys IS
  'TP-03 (20261029093000): the keys that agreed on this decision. ai_confidence (the AI above the bar), then the hard clues that agreed with the chosen job (job_number, purchase_order; same_supplier, xero_project and site_address reserved for TP-04 / TP-09), then second_check when the blind second model agreed before the bill was placed. NULL on rows written before 20261029093000.'$fn$;
  EXECUTE $fn$COMMENT ON COLUMN public.materials_ai_placements.key_evidence IS
  'TP-03 (20261029093000): what each hard clue saw, by key (where the job number was written, which PO, and supplier_history: an earlier bill of the same supplier placed on the job by a person or a rule, recorded but not a key until TP-04), and withheld: why a clue gave no key (the bill also names another job, a holding job, digits another job shares, a digits-only PO number, a supplier on several jobs).'$fn$;
  EXECUTE $fn$COMMENT ON VIEW public.v_materials_ai_placed_without_key IS
  'AI bill two keys (20261029093000): bills the AI placed on a job that are still placed, with no hard clue agreeing with that job (job number or PO, read now with materials_ai_hard_keys; same supplier is not a key until TP-04) and no agreeing second check. They were placed live before TP-03 on the AI''s confidence alone; this migration does not move them. second_check_status shows whether a check is due, disagreed, or was never asked for. A person decides each (Undo in Bills to place). Read only, service role only.'$fn$;
END $down$;
