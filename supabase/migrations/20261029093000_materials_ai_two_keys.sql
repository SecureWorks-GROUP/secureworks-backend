-- Two keys before money is placed (TP-03, with the TP-21 second-check rule),
-- 29 Oct 2026. Plan: 08-path-to-trusted-profit §4A-2 and §6.
--
-- The AI bill reader (20261028173000) placed a bill on a job whenever the AI
-- was above the confidence bar. From this migration the database places a bill
-- on a job automatically only when the AI is above the bar AND at least one
-- hard clue agrees with the job the AI chose, and nothing on the bill points
-- at another job (the rules lane's rule: another job's number in any SW form,
-- or a purchase order that is another job's or has no job, named on the bill
-- or linked to it, and the bill gets no key at all; so does a holding job):
--   job_number      the job's number is written in the bill's reference or a
--                   line, in the canonical SW grammar only (SWF-26412,
--                   SWF 26412, SWF26412), and no other job shares its digits;
--   purchase_order  an issued purchase order on that job (approved through
--                   billed; a quote request, a draft or a PO with no status
--                   never gives a key, though another job's draft still
--                   disagrees) is named in the bill's reference or lines (the
--                   rules' PO forms: PO-1000123, PO1000123, PO 1000123,
--                   PO#1000123; read with the job numbers taken out, so a
--                   digits-only "39002" is never found in "SWP-39002"), or the
--                   rules matched the bill to it; its number is held by no
--                   other job and it is matched to no other bill;
--   (same_supplier  NOT a key until TP-04. A live bill of the same Xero
--                   contact placed on that job by a person or a rule, within
--                   180 days, when that supplier billed no other live job in
--                   the window, is recorded in key_evidence.supplier_history
--                   only. The name stays reserved in agreed_keys.)
-- A purchase order whose number has no letter prefix ("39002") gives no key:
-- any standalone number on a bill would match it.
-- Not yet: xero_project (no per-bill Xero Project tag is stored; TP-09 first
-- checks whether Xero lists bills per project) and site_address (left for the
-- shared job picture, TP-04). Both names are reserved in agreed_keys.
--
-- With no hard clue the bill is held, not placed: the audit row's outcome is
-- held_for_check, its second check is due, the bill stays open in Bills to
-- place and no cost row is written. The blind second check (Jarvis already
-- reads every due row) then decides it in materials_ai_record_second_check:
--   agrees    the database places the bill through materials_ai_apply's own
--             path and checks (every refusal is re-read, the bar is re-read):
--             the same audit row becomes placed, agreed_keys ai_confidence +
--             second_check. A bill whose amount or installer lines changed
--             since it was held is not the bill the check saw: the held row
--             is refused and keeps the amount held and checked, nothing is
--             placed, and a fresh answer holds it again as it is now;
--   disagrees (or answers unsure) the row becomes left_for_person with both
--             answers on it (the AI's decision, job and reason; the second
--             model's in second_check), and neither model reads that bill
--             again: a person decides it.
-- Every placement, filing and hold written from here names the keys that
-- agreed (agreed_keys) and what each hard clue saw (key_evidence); the job
-- event of a placement carries them too. Rows from before this migration keep
-- agreed_keys NULL ("before two keys").
--
-- Unchanged: the live outcomes placed, filed_not_job_related, left_for_person
-- and refused keep their meaning; filing a bill as not job related is not a
-- job placement and is not gated here (it records agreed_keys ai_confidence);
-- the AI never moves a bill a person placed; Undo is untouched; nothing writes
-- Xero. Every function keeps its signature and every output key (INT-18).
--
-- Bills the AI already placed live without a hard clue are NOT touched.
-- v_materials_ai_placed_without_key lists them (no hard clue now, no agreeing
-- second check) and materials_ai_placed_without_key_count() counts them, so a
-- person can decide.
--
-- Rollback: supabase/rollbacks/20261029093000_materials_ai_two_keys_down.sql

-- ─────────────────────────────────────────────────────────────
-- 0. Guard: read the live definitions before replacing them. Reports every
--    problem at once.
-- ─────────────────────────────────────────────────────────────
DO $guard$
DECLARE problems text[] := '{}'; x record; live text; t text; f text;
BEGIN
 -- The replaced bodies: 20261028173000's, or this migration's (a re-apply).
 FOR x IN SELECT * FROM (VALUES
  ('public.materials_ai_bill_batch(integer)', ARRAY['0307862b6c8dcb905048b2fa54004fe3', '8cc46936782ac304a450ff8b19e6607b']),
  ('public.materials_ai_apply(uuid,text,jsonb)', ARRAY['c5e9cf83e42c718ef2a0e02aa04859b7', '87a2272f379b9c41a72e232f872655b2']),
  ('public.materials_ai_second_check_due(integer)', ARRAY['79f05c206f49019b5c8362cef2f05004', '95c17ede87b0e897db0df4735915acf5']),
  ('public.materials_ai_record_second_check(uuid,jsonb)', ARRAY['fafe795a871710881f881d1863b64083', '7e5af5bb3c59ab8dc5c6012af32622d4']),
  ('public.materials_ai_status()', ARRAY['cbba1fe0ef404e5a6a363ba25175194b', '5e572ca27767186c91c353f086eb934c'])
 ) v(sig, accepted) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY (x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 -- Read, never replaced.
 FOREACH f IN ARRAY ARRAY['public.materials_ai_undo(uuid,text,text)', 'public.materials_ai_held_reason(text)',
   'public.materials_ai_trade_mirror(text,jsonb)', 'public.job_cost_installer_bill(jsonb)'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['materials_ai_placements.outcome', 'materials_ai_placements.second_check_status',
   'materials_ai_placements.decision', 'materials_ai_placements.job_id', 'materials_ai_placements.call_id',
   'materials_ai_placements.evidence', 'materials_ai_placements.undone_at', 'materials_ai_settings.confidence_bar',
   'materials_reconciliation_queue.xero_contact_id', 'materials_reconciliation_queue.status',
   'job_materials_facts.xero_contact_id', 'job_materials_facts.job_id', 'job_materials_facts.automation_source',
   'job_materials_facts.matched_po_id', 'job_materials_facts.kind', 'xero_invoices.reference', 'xero_invoices.line_items',
   'purchase_orders.po_number', 'purchase_orders.job_id', 'purchase_orders.status', 'purchase_orders.xero_bill_id',
   'jobs.job_number', 'jobs.metadata', 'jobs.status', 'xero_invoices.invoice_date'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || split_part(t, '.', 1))
    AND a.attname = split_part(t, '.', 2) AND NOT a.attisdropped) THEN
   problems := problems || format('public.%s missing', t);
  END IF;
 END LOOP;
 -- The outcome list is still 20261028173000's (or this migration's).
 SELECT pg_get_constraintdef(c.oid) INTO live FROM pg_constraint c
  WHERE c.conrelid = to_regclass('public.materials_ai_placements')
    AND c.conname IN ('materials_ai_placements_outcome_check', 'materials_ai_placements_outcome_chk');
 IF live IS NULL OR live NOT LIKE '%left_for_person%' THEN
  problems := problems || format('materials_ai_placements outcome check %s', coalesce(live, '<missing>'));
 END IF;
 FOREACH f IN ARRAY ARRAY['public.materials_ai_hard_keys(text,uuid)', 'public.materials_ai_placed_without_key_count()'] LOOP
  IF to_regprocedure(f) IS NOT NULL
     AND coalesce(obj_description(to_regprocedure(f), 'pg_proc'), '') NOT LIKE 'AI bill two keys (20261029093000)%' THEN
   problems := problems || format('%s exists and is not this migration''s', f);
  END IF;
 END LOOP;
 IF to_regclass('public.v_materials_ai_placed_without_key') IS NOT NULL
    AND coalesce(obj_description(to_regclass('public.v_materials_ai_placed_without_key'), 'pg_class'), '') NOT LIKE 'AI bill two keys (20261029093000)%' THEN
  problems := problems || 'public.v_materials_ai_placed_without_key exists and is not this migration''s'::text;
 END IF;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'materials_ai_two_keys_preimage_mismatch: %; read the live definitions before replacing them',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- ─────────────────────────────────────────────────────────────
-- 1. The audit row: held_for_check, the keys that agreed
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.materials_ai_placements
  ADD COLUMN IF NOT EXISTS agreed_keys text[],
  ADD COLUMN IF NOT EXISTS key_evidence jsonb,
  ADD COLUMN IF NOT EXISTS held_at timestamptz;
ALTER TABLE public.materials_ai_placements DROP CONSTRAINT IF EXISTS materials_ai_placements_outcome_check;
ALTER TABLE public.materials_ai_placements DROP CONSTRAINT IF EXISTS materials_ai_placements_outcome_chk;
ALTER TABLE public.materials_ai_placements ADD CONSTRAINT materials_ai_placements_outcome_chk
  CHECK (outcome IN ('placed', 'filed_not_job_related', 'left_for_person', 'refused', 'held_for_check'));
ALTER TABLE public.materials_ai_placements DROP CONSTRAINT IF EXISTS materials_ai_placements_keys_chk;
ALTER TABLE public.materials_ai_placements ADD CONSTRAINT materials_ai_placements_keys_chk
  CHECK (agreed_keys IS NULL OR agreed_keys <@ ARRAY['ai_confidence', 'job_number', 'purchase_order', 'xero_project',
                                                      'site_address', 'same_supplier', 'second_check']::text[]);
ALTER TABLE public.materials_ai_placements DROP CONSTRAINT IF EXISTS materials_ai_placements_held_chk;
ALTER TABLE public.materials_ai_placements ADD CONSTRAINT materials_ai_placements_held_chk
  CHECK (outcome <> 'held_for_check' OR (held_at IS NOT NULL AND decision = 'job' AND job_id IS NOT NULL AND undone_at IS NULL));
-- One bill waits for one check at a time.
CREATE UNIQUE INDEX IF NOT EXISTS materials_ai_placements_held_uidx
  ON public.materials_ai_placements (xero_invoice_id)
  WHERE outcome = 'held_for_check';
COMMENT ON COLUMN public.materials_ai_placements.agreed_keys IS
  'TP-03 (20261029093000): the keys that agreed on this decision. ai_confidence (the AI above the bar), then the hard clues that agreed with the chosen job (job_number, purchase_order; same_supplier, xero_project and site_address reserved for TP-04 / TP-09), then second_check when the blind second model agreed before the bill was placed. NULL on rows written before 20261029093000.';
COMMENT ON COLUMN public.materials_ai_placements.key_evidence IS
  'TP-03 (20261029093000): what each hard clue saw, by key (where the job number was written, which PO, and supplier_history: an earlier bill of the same supplier placed on the job by a person or a rule, recorded but not a key until TP-04), and withheld: why a clue gave no key (the bill also names another job, a holding job, digits another job shares, a digits-only PO number, a supplier on several jobs).';
COMMENT ON COLUMN public.materials_ai_placements.held_at IS
  'TP-03 (20261029093000): when the AI was above the bar with no hard clue and the bill was held for the blind second check instead of placed. Kept after the check decides it (placed, left_for_person or refused), so a row that was held first stays visible.';

-- ─────────────────────────────────────────────────────────────
-- 2. The hard clues for one bill and one job (read only)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.materials_ai_hard_keys(p_bill text, p_job_id uuid)
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
$$;
COMMENT ON FUNCTION public.materials_ai_hard_keys(text, uuid) IS
  'AI bill two keys (20261029093000): the hard clues on one bill that agree with one job: {keys: [job_number, purchase_order], evidence: {key: what it saw, supplier_history: recorded only, withheld: why a key was not given}}. No key at all for a holding or dead job, or when the bill also names another job number or another job''s purchase order. job_number: SW forms only, never a number another job shares the digits of. purchase_order: an issued PO (approved .. billed; never quote_requested, draft or no status) of this job whose number starts with letters (a digits-only number is withheld), held by no other job, matched to no other bill. same_supplier is not a key until TP-04: a live person or rule placement of the same Xero contact on this job within 180 days, when that supplier billed no other live job in the window, is recorded as supplier_history only; AI placements never count. Read only. Used by materials_ai_apply and v_materials_ai_placed_without_key. Service role only.';
REVOKE ALL ON FUNCTION public.materials_ai_hard_keys(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materials_ai_hard_keys(text, uuid) TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 3. The next bills to read (20261028173000's, plus: a bill waiting for its
--    second check, or one the two models disagreed on, is not read again)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.materials_ai_bill_batch(p_limit integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH s AS (SELECT * FROM public.materials_ai_settings WHERE id),
  open_rows AS (
    SELECT q.*, x.line_items, x.reference, x.status AS bill_status, x.due_date, x.raw_json ->> 'LineAmountTypes' AS amount_types,
           public.job_cost_installer_bill(x.line_items) AS installer
      FROM public.materials_reconciliation_queue q
      JOIN LATERAL (
        SELECT x.line_items, x.reference, x.status, x.due_date, x.raw_json
          FROM public.xero_invoices x
         WHERE x.xero_invoice_id = q.xero_invoice_id AND x.invoice_type = 'ACCPAY'
         ORDER BY (x.status IN ('AUTHORISED', 'PAID')) DESC
         LIMIT 1) x ON true
     WHERE q.status = 'open'
       AND NOT public.materials_ai_held_reason(q.suggestion_reason)
       AND q.sub_total IS NOT NULL AND q.sub_total > 0
       AND x.status IN ('AUTHORISED', 'PAID')
       AND NOT public.materials_ai_trade_mirror(q.xero_invoice_id, x.line_items)
       -- Undone once: never read by the AI again.
       AND NOT EXISTS (SELECT 1 FROM public.materials_ai_placements p
                        WHERE p.xero_invoice_id = q.xero_invoice_id AND p.undone_at IS NOT NULL)
       -- Read recently and left for a person (or refused): wait before reading again.
       AND NOT EXISTS (SELECT 1 FROM public.materials_ai_placements p, s
                        WHERE p.xero_invoice_id = q.xero_invoice_id
                          AND p.created_at > now() - make_interval(days => s.reread_after_days))
       -- TP-03: held for the second check, or the two models disagreed: not read again.
       AND NOT EXISTS (SELECT 1 FROM public.materials_ai_placements p
                        WHERE p.xero_invoice_id = q.xero_invoice_id
                          AND (p.outcome = 'held_for_check'
                               OR (p.held_at IS NOT NULL AND p.second_check_status = 'disagreed')))
       -- A person's row on the bill: never the AI's to touch.
       AND NOT EXISTS (SELECT 1 FROM public.job_materials_facts f
                        WHERE f.xero_invoice_id = q.xero_invoice_id
                          AND f.automation_source IN ('manual_queue', 'manual_split', 'agent_ai'))
     ORDER BY q.sub_total DESC, q.xero_invoice_id
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 6), 20))
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'xero_invoice_id', o.xero_invoice_id,
    'invoice_number', o.invoice_number,
    'supplier', o.contact_name,
    'xero_contact_id', o.xero_contact_id,
    'invoice_date', o.invoice_date,
    'due_date', o.due_date,
    'amount_ex', o.sub_total,
    'amount_inc', o.total,
    'reference', o.reference,
    'installer', o.installer,
    'waiting_reason', o.suggestion_reason,
    'lines', (SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                'description', left(li.value ->> 'Description', 400),
                'account', li.value ->> 'AccountCode',
                'quantity', li.value -> 'Quantity',
                'amount', li.value -> 'LineAmount',
                'tracking', (SELECT jsonb_agg(t.value ->> 'Option')
                               FROM jsonb_array_elements(CASE WHEN jsonb_typeof(li.value -> 'Tracking') = 'array' THEN li.value -> 'Tracking' ELSE '[]'::jsonb END) t)))
                ORDER BY li.n), '[]'::jsonb)
                FROM jsonb_array_elements(CASE WHEN jsonb_typeof(o.line_items) = 'array' THEN o.line_items ELSE '[]'::jsonb END)
                     WITH ORDINALITY li(value, n)),
    'machine_suggestion', CASE WHEN o.suggested_job_number IS NOT NULL THEN jsonb_build_object(
        'job_number', o.suggested_job_number, 'confidence', o.suggestion_confidence, 'reason', o.suggestion_reason) END,
    'rules_proposal', (SELECT jsonb_build_object('kind', p.proposal_kind, 'job_number', p.proposed_job_number,
                                                 'confidence', p.confidence, 'rule', p.rule, 'reason', left(p.reason, 600))
                         FROM public.materials_bill_proposals p
                        WHERE p.xero_invoice_id = o.xero_invoice_id AND p.outcome <> 'superseded'
                        ORDER BY p.updated_at DESC NULLS LAST LIMIT 1),
    'supplier_history', (SELECT COALESCE(jsonb_agg(h ORDER BY h ->> 'date' DESC), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('job_number', f.job_number, 'date', f.fact_date, 'amount_ex', f.amount_ex_gst,
                                  'invoice_number', f.invoice_number, 'placed_by', f.automation_source,
                                  'suburb', j.site_suburb) AS h
          FROM public.job_materials_facts f
          LEFT JOIN public.jobs j ON j.id = f.job_id
         WHERE f.xero_invoice_id <> o.xero_invoice_id
           AND ((o.xero_contact_id IS NOT NULL AND f.xero_contact_id = o.xero_contact_id)
                OR (o.xero_contact_id IS NULL AND lower(f.contact_name) = lower(o.contact_name)))
         ORDER BY f.fact_date DESC NULLS LAST
         LIMIT 15) hh),
    'supplier_not_job_related', (SELECT count(*) FROM public.materials_reconciliation_queue q2
                                  WHERE q2.status = 'not_job_related' AND q2.xero_invoice_id <> o.xero_invoice_id
                                    AND ((o.xero_contact_id IS NOT NULL AND q2.xero_contact_id = o.xero_contact_id)
                                         OR (o.xero_contact_id IS NULL AND lower(q2.contact_name) = lower(o.contact_name)))),
    'purchase_orders', (SELECT COALESCE(jsonb_agg(jsonb_build_object('po_number', po.po_number, 'job_number', pj.job_number,
                                         'status', po.status, 'subtotal', po.subtotal)), '[]'::jsonb)
                          FROM public.purchase_orders po
                          LEFT JOIN public.jobs pj ON pj.id = po.job_id
                         WHERE ((o.xero_contact_id IS NOT NULL AND po.xero_contact_id = o.xero_contact_id)
                                OR lower(COALESCE(po.supplier_name, '')) = lower(COALESCE(o.contact_name, '-')))
                           AND COALESCE(lower(po.status), '') NOT IN ('deleted', 'cancelled')),
    'emails', (SELECT COALESCE(jsonb_agg(e ORDER BY e ->> 'at' DESC), '[]'::jsonb) FROM (
        SELECT DISTINCT ON (be.id) jsonb_strip_nulls(jsonb_build_object(
                 'at', be.occurred_at, 'subject', left(be.payload ->> 'subject', 300),
                 'from', left(be.payload ->> 'from', 200),
                 'text', left(COALESCE(be.payload ->> 'body_preview', be.payload ->> 'safe_summary'), 1500),
                 'attachment', a.file_name,
                 'on_job', bj.job_number)) AS e
          FROM public.context_email_attachments a
          JOIN public.business_events be ON be.id = a.business_event_id
          LEFT JOIN public.jobs bj ON bj.id = be.job_id
         WHERE length(regexp_replace(COALESCE(o.invoice_number, ''), '[^A-Za-z0-9]', '', 'g')) >= 5
           AND regexp_replace(lower(COALESCE(a.file_name, '')), '[^a-z0-9]', '', 'g')
               LIKE '%' || regexp_replace(lower(o.invoice_number), '[^a-z0-9]', '', 'g') || '%'
         ORDER BY be.id
         LIMIT 4) ee)
  ) ORDER BY o.sub_total DESC, o.xero_invoice_id), '[]'::jsonb)
  FROM open_rows o
$$;
REVOKE ALL ON FUNCTION public.materials_ai_bill_batch(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materials_ai_bill_batch(integer) TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 4. Apply one decision (20261028173000's, plus the two keys)
--     p_decision: {xero_invoice_id, decision: job|not_job_related|unsure,
--                  job_id?, job_number?, confidence: 0..1, reason, evidence: [],
--                  held_placement_id?}
--     held_placement_id is honoured only for this bill's own held row whose
--     second check this database recorded as agreed (materials_ai_record_
--     second_check passes it); any other value is an error.
--     Returns {outcome, placement_id, refusal?, second_check?, keys?}.
--     outcome is placed, filed_not_job_related, left_for_person, refused,
--     held_for_check (TP-03: above the bar, no hard clue, waiting for the
--     blind second check) or off.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.materials_ai_apply(p_call uuid, p_model text, p_decision jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  s public.materials_ai_settings%ROWTYPE;
  q public.materials_reconciliation_queue%ROWTYPE;
  b record;
  v_job public.jobs%ROWTYPE;
  v_bill text := btrim(COALESCE(p_decision ->> 'xero_invoice_id', ''));
  v_kind text := COALESCE(p_decision ->> 'decision', '');
  v_conf numeric;
  v_reason text := left(btrim(COALESCE(p_decision ->> 'reason', '')), 2000);
  v_evidence jsonb := CASE WHEN jsonb_typeof(p_decision -> 'evidence') = 'array' THEN p_decision -> 'evidence' ELSE '[]'::jsonb END;
  v_model text := left(COALESCE(NULLIF(btrim(p_model), ''), 'unknown'), 100);
  v_actor text;
  v_installer boolean := false;
  v_refusal text;
  v_outcome text;
  v_machine text;
  v_po uuid;
  v_check text := 'not_needed';
  v_id uuid;
  v_job_id uuid;
  v_job_number text;
  v_held public.materials_ai_placements%ROWTYPE;
  v_held_id uuid;
  v_hard jsonb;
  v_keys text[] := ARRAY['ai_confidence']::text[];
  v_key_ev jsonb := '{}'::jsonb;
BEGIN
  IF v_bill = '' THEN RAISE EXCEPTION 'materials_ai_apply: xero_invoice_id required'; END IF;
  IF v_kind NOT IN ('job', 'not_job_related', 'unsure') THEN
    RAISE EXCEPTION 'materials_ai_apply: decision must be job, not_job_related or unsure';
  END IF;
  IF v_reason = '' THEN v_reason := 'No reason given.'; END IF;
  v_conf := CASE WHEN jsonb_typeof(p_decision -> 'confidence') = 'number'
                 THEN LEAST(GREATEST((p_decision ->> 'confidence')::numeric, 0), 1) END;
  v_actor := 'ai:' || v_model;

  SELECT * INTO s FROM public.materials_ai_settings WHERE id;
  IF NOT FOUND OR NOT s.enabled THEN
    RETURN jsonb_build_object('outcome', 'off');
  END IF;

  -- The same per-bill lock as the allocation rows' no-mix trigger and the split.
  PERFORM pg_advisory_xact_lock(hashtextextended('job_materials_facts:' || v_bill, 0));

  -- TP-03: the held row a recorded, agreeing second check releases.
  IF p_decision ? 'held_placement_id' THEN
    IF COALESCE(p_decision ->> 'held_placement_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      SELECT * INTO v_held FROM public.materials_ai_placements
       WHERE id = (p_decision ->> 'held_placement_id')::uuid FOR UPDATE;
    END IF;
    IF v_held.id IS NULL OR v_held.xero_invoice_id <> v_bill OR v_held.outcome <> 'held_for_check'
       OR v_held.second_check_status <> 'agreed' OR v_held.undone_at IS NOT NULL OR v_kind <> 'job' THEN
      RAISE EXCEPTION 'materials_ai_apply: held_placement_id is not this bill''s held placement with an agreeing second check';
    END IF;
    v_held_id := v_held.id;
  END IF;

  SELECT * INTO q FROM public.materials_reconciliation_queue WHERE xero_invoice_id = v_bill FOR UPDATE;
  SELECT x.status, x.sub_total, x.line_items, x.invoice_date INTO b
    FROM public.xero_invoices x
   WHERE x.xero_invoice_id = v_bill AND x.invoice_type = 'ACCPAY'
   ORDER BY (x.status IN ('AUTHORISED', 'PAID')) DESC
   LIMIT 1;
  IF FOUND THEN v_installer := public.job_cost_installer_bill(b.line_items); END IF;

  -- Refusals: the bill is no longer the AI's to decide.
  IF q.id IS NULL THEN v_refusal := 'not in Bills to place';
  ELSIF q.status <> 'open' THEN v_refusal := 'already ' || q.status;
  ELSIF public.materials_ai_held_reason(q.suggestion_reason) THEN v_refusal := 'held for a person (' || q.suggestion_reason || ')';
  ELSIF b.status IS NULL OR b.status NOT IN ('AUTHORISED', 'PAID') THEN v_refusal := 'not live in Xero';
  ELSIF b.sub_total IS NULL OR b.sub_total <= 0 THEN v_refusal := 'no known amount';
  ELSIF public.materials_ai_trade_mirror(v_bill, b.line_items) THEN v_refusal := 'a trade app invoice, counted through the trade app';
  ELSIF EXISTS (SELECT 1 FROM public.materials_ai_placements p WHERE p.xero_invoice_id = v_bill AND p.undone_at IS NOT NULL) THEN
    v_refusal := 'a person undid an AI placement on this bill';
  ELSIF EXISTS (SELECT 1 FROM public.materials_ai_placements p WHERE p.xero_invoice_id = v_bill
                  AND p.outcome IN ('placed', 'filed_not_job_related') AND p.undone_at IS NULL) THEN
    v_refusal := 'already decided by the AI';
  ELSIF EXISTS (SELECT 1 FROM public.materials_ai_placements p WHERE p.xero_invoice_id = v_bill
                  AND p.outcome = 'held_for_check' AND p.id IS DISTINCT FROM v_held_id) THEN
    v_refusal := 'waiting for the second check';
  ELSIF EXISTS (SELECT 1 FROM public.materials_ai_placements p WHERE p.xero_invoice_id = v_bill
                  AND p.held_at IS NOT NULL AND p.second_check_status = 'disagreed') THEN
    v_refusal := 'the second check disagreed: a person decides this bill';
  ELSIF EXISTS (SELECT 1 FROM public.job_materials_facts f WHERE f.xero_invoice_id = v_bill
                  AND f.automation_source IN ('manual_queue', 'manual_split', 'agent_ai')) THEN
    v_refusal := 'a person placed this bill';
  -- The second check agreed with the bill as it was held: one that changed
  -- since is not the bill it checked. The held row keeps what was held and
  -- checked; a fresh answer holds it again, as it is now.
  ELSIF v_held_id IS NOT NULL AND round(b.sub_total, 2) IS DISTINCT FROM v_held.amount_ex THEN
    v_refusal := 'the bill changed from ' || COALESCE(v_held.amount_ex::text, 'no amount') || ' to '
                 || round(b.sub_total, 2) || ' ex GST while it waited';
  ELSIF v_held_id IS NOT NULL AND v_installer IS DISTINCT FROM v_held.installer THEN
    v_refusal := 'the bill changed from ' || CASE WHEN v_held.installer THEN 'an installer bill to a materials bill'
                 ELSE 'a materials bill to an installer bill' END || ' while it waited';
  END IF;

  IF v_refusal IS NULL AND v_kind = 'job' THEN
    IF COALESCE(p_decision ->> 'job_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      SELECT * INTO v_job FROM public.jobs WHERE id = (p_decision ->> 'job_id')::uuid;
    ELSIF COALESCE(btrim(p_decision ->> 'job_number'), '') <> '' THEN
      SELECT * INTO v_job FROM public.jobs WHERE upper(job_number) = upper(btrim(p_decision ->> 'job_number'))
       ORDER BY created_at DESC LIMIT 1;
    END IF;
    IF v_job.id IS NULL THEN v_refusal := 'job not found';
    ELSIF lower(COALESCE(v_job.metadata ->> 'do_not_schedule', '')) = 'true' THEN v_refusal := 'a holding job';
    ELSIF lower(COALESCE(v_job.status, '')) IN ('cancelled', 'lost') THEN v_refusal := 'job is ' || v_job.status;
    ELSIF v_held_id IS NOT NULL AND v_job.id IS DISTINCT FROM v_held.job_id THEN v_refusal := 'not the held job';
    END IF;
    v_job_id := v_job.id;
    v_job_number := v_job.job_number;
  END IF;
  IF v_refusal IS NULL AND v_kind = 'job' THEN
    -- Another machine row on a materials bill means the rules already placed it:
    -- the queue row would not be open. Only an installer bill's machine row
    -- (installer_confirm) is the AI's to replace.
    SELECT f.automation_source, f.matched_po_id INTO v_machine, v_po FROM public.job_materials_facts f
     WHERE f.xero_invoice_id = v_bill LIMIT 1;
    IF v_machine IS NOT NULL AND NOT v_installer THEN
      v_refusal := 'already placed by ' || v_machine;
    END IF;
  END IF;

  IF v_refusal IS NOT NULL THEN
    IF v_held_id IS NOT NULL THEN
      -- The bill changed while it waited for the check: the held row closes as refused.
      UPDATE public.materials_ai_placements
         SET outcome = 'refused', refusal = left('after the second check agreed: ' || v_refusal, 300)
       WHERE id = v_held_id
      RETURNING id INTO v_id;
    ELSE
      INSERT INTO public.materials_ai_placements (call_id, xero_invoice_id, invoice_number, contact_name, amount_ex, installer,
        decision, job_id, job_number, confidence, bar, reason, evidence, model, outcome, refusal)
      VALUES (p_call, v_bill, q.invoice_number, q.contact_name, round(b.sub_total, 2), v_installer,
        v_kind, v_job_id, v_job_number, v_conf, s.confidence_bar, v_reason, v_evidence, v_model, 'refused', left(v_refusal, 300))
      RETURNING id INTO v_id;
    END IF;
    RETURN jsonb_build_object('outcome', 'refused', 'placement_id', v_id, 'refusal', v_refusal);
  END IF;

  -- Below the bar, or not sure: left for a person, with the AI's reason.
  IF v_kind = 'unsure' OR v_conf IS NULL OR v_conf < s.confidence_bar THEN
    IF v_held_id IS NOT NULL THEN
      -- The bar rose while the bill waited for the check.
      UPDATE public.materials_ai_placements
         SET outcome = 'left_for_person', bar = s.confidence_bar,
             refusal = left('the confidence bar rose to ' || s.confidence_bar || ' before the second check agreed', 300)
       WHERE id = v_held_id
      RETURNING id INTO v_id;
    ELSE
      INSERT INTO public.materials_ai_placements (call_id, xero_invoice_id, invoice_number, contact_name, amount_ex, installer,
        decision, job_id, job_number, confidence, bar, reason, evidence, model, outcome)
      VALUES (p_call, v_bill, q.invoice_number, q.contact_name, round(b.sub_total, 2), v_installer,
        v_kind, v_job_id, v_job_number, v_conf, s.confidence_bar, v_reason, v_evidence, v_model, 'left_for_person')
      RETURNING id INTO v_id;
    END IF;
    RETURN jsonb_build_object('outcome', 'left_for_person', 'placement_id', v_id);
  END IF;

  -- A different model checks the big ones, closed jobs and a sample, the same day.
  IF b.sub_total >= s.second_check_over_ex
     OR (v_kind = 'job' AND lower(COALESCE(v_job.status, '')) IN ('archived', 'complete', 'completed', 'invoiced', 'final_payment', 'get_review'))
     OR random() < s.second_check_sample THEN
    v_check := 'due';
  END IF;

  -- TP-03: two keys. The AI above the bar is one; a hard clue on the bill that
  -- agrees with the job is the other. With none, the blind second check must
  -- agree before the bill is placed.
  IF v_kind = 'job' THEN
    v_hard := public.materials_ai_hard_keys(v_bill, v_job.id);
    v_keys := v_keys || ARRAY(SELECT jsonb_array_elements_text(v_hard -> 'keys'));
    v_key_ev := COALESCE(v_hard -> 'evidence', '{}'::jsonb);
    IF v_held_id IS NOT NULL THEN
      v_keys := v_keys || 'second_check'::text;
      v_check := 'agreed';
    ELSIF cardinality(v_keys) = 1 THEN
      INSERT INTO public.materials_ai_placements (call_id, xero_invoice_id, invoice_number, contact_name, amount_ex, installer,
        decision, job_id, job_number, confidence, bar, reason, evidence, model, outcome, second_check_status,
        agreed_keys, key_evidence, held_at)
      VALUES (p_call, v_bill, q.invoice_number, q.contact_name, round(b.sub_total, 2), v_installer,
        v_kind, v_job_id, v_job_number, v_conf, s.confidence_bar, v_reason, v_evidence, v_model, 'held_for_check', 'due',
        v_keys, v_key_ev, now())
      RETURNING id INTO v_id;
      RETURN jsonb_build_object('outcome', 'held_for_check', 'placement_id', v_id, 'second_check', 'due', 'keys', to_jsonb(v_keys));
    END IF;
  END IF;

  IF v_kind = 'job' THEN
    -- An installer bill a rule placed (installer_confirm): the AI's row replaces it.
    IF v_machine IS NOT NULL THEN
      DELETE FROM public.job_materials_facts WHERE xero_invoice_id = v_bill;
    END IF;
    INSERT INTO public.job_materials_facts (
      org_id, xero_invoice_id, invoice_number, xero_contact_id, contact_name, job_id, job_number,
      lane, kind, amount_ex_gst, amount_inc_gst, confidence, automation_source, match_reason,
      fact_date, assigned_by, updated_at, matched_po_id)
    VALUES (
      q.org_id, q.xero_invoice_id, q.invoice_number, q.xero_contact_id, q.contact_name, v_job.id, v_job.job_number,
      CASE WHEN v_installer THEN 'labour' ELSE 'materials' END, 'actual', round(b.sub_total, 2), q.total,
      CASE WHEN v_conf >= 0.95 THEN 'high' ELSE 'medium' END, 'agent_ai',
      left('agent_ai: ' || v_reason, 500),
      COALESCE(q.invoice_date, b.invoice_date), v_actor, now(),
      CASE WHEN v_machine IS NOT NULL THEN v_po END);
    UPDATE public.materials_reconciliation_queue
       SET status = 'assigned', assigned_job_id = v_job.id, assigned_by = v_actor, assigned_at = now(), updated_at = now()
     WHERE id = q.id;
    v_outcome := 'placed';
  ELSE
    IF v_machine IS NOT NULL OR EXISTS (SELECT 1 FROM public.job_materials_facts f WHERE f.xero_invoice_id = v_bill) THEN
      -- Filing a bill a rule placed is a person's call.
      INSERT INTO public.materials_ai_placements (call_id, xero_invoice_id, invoice_number, contact_name, amount_ex, installer,
        decision, confidence, bar, reason, evidence, model, outcome, refusal)
      VALUES (p_call, v_bill, q.invoice_number, q.contact_name, round(b.sub_total, 2), v_installer,
        v_kind, v_conf, s.confidence_bar, v_reason, v_evidence, v_model, 'left_for_person', 'a rule placed it on a job')
      RETURNING id INTO v_id;
      RETURN jsonb_build_object('outcome', 'left_for_person', 'placement_id', v_id);
    END IF;
    UPDATE public.materials_reconciliation_queue
       SET status = 'not_job_related', assigned_job_id = NULL, assigned_by = v_actor, assigned_at = now(), updated_at = now()
     WHERE id = q.id;
    v_outcome := 'filed_not_job_related';
  END IF;

  IF v_held_id IS NOT NULL THEN
    -- The held row becomes the placement: one audit row from hold to place.
    UPDATE public.materials_ai_placements
       SET outcome = v_outcome, replaced_machine_source = v_machine, agreed_keys = v_keys, key_evidence = v_key_ev
     WHERE id = v_held_id
    RETURNING id INTO v_id;
  ELSE
    INSERT INTO public.materials_ai_placements (call_id, xero_invoice_id, invoice_number, contact_name, amount_ex, installer,
      decision, job_id, job_number, confidence, bar, reason, evidence, model, outcome, replaced_machine_source, second_check_status,
      agreed_keys, key_evidence)
    VALUES (p_call, v_bill, q.invoice_number, q.contact_name, round(b.sub_total, 2), v_installer,
      v_kind, v_job_id, v_job_number, v_conf, s.confidence_bar, v_reason, v_evidence, v_model, v_outcome, v_machine, v_check,
      v_keys, v_key_ev)
    RETURNING id INTO v_id;
  END IF;

  IF v_kind = 'job' THEN
    INSERT INTO public.job_events (job_id, event_type, detail_json)
    VALUES (v_job.id, 'materials_bill_assigned', jsonb_build_object(
      'source', 'agent_ai', 'action', 'ai-bill-reader', 'manual', false,
      'placement_id', v_id, 'model', v_model, 'confidence', v_conf, 'reason', left(v_reason, 600),
      'xero_invoice_id', v_bill, 'invoice_number', q.invoice_number, 'contact_name', q.contact_name,
      'amount_ex_gst', round(b.sub_total, 2), 'job_number', v_job.job_number, 'installer', v_installer,
      'replaced', v_machine, 'reversible', 'Undo in Bills to place (materials_ai_undo)',
      'keys', to_jsonb(v_keys), 'key_evidence', v_key_ev));
  END IF;

  RETURN jsonb_build_object('outcome', v_outcome, 'placement_id', v_id, 'second_check', v_check, 'keys', to_jsonb(v_keys));
END;
$$;
REVOKE ALL ON FUNCTION public.materials_ai_apply(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materials_ai_apply(uuid, text, jsonb) TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 5. Second-model check (20261028173000's; held bills are read first, and
--    the list is still blind: it never carries the first answer)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.materials_ai_second_check_due(p_limit integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'placement_id', p.id, 'xero_invoice_id', p.xero_invoice_id, 'invoice_number', p.invoice_number,
           'supplier', p.contact_name, 'amount_ex', p.amount_ex, 'installer', p.installer,
           'invoice_date', q.invoice_date, 'reference', x.reference,
           'lines', (SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                       'description', left(li.value ->> 'Description', 400), 'account', li.value ->> 'AccountCode',
                       'amount', li.value -> 'LineAmount'))), '[]'::jsonb)
                       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.line_items) = 'array' THEN x.line_items ELSE '[]'::jsonb END) li))
           ORDER BY p.held DESC, p.created_at), '[]'::jsonb)
    FROM (SELECT *, (outcome = 'held_for_check') AS held FROM public.materials_ai_placements
           WHERE second_check_status = 'due' AND undone_at IS NULL
           ORDER BY (outcome = 'held_for_check') DESC, created_at LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 6), 20))) p
    LEFT JOIN public.materials_reconciliation_queue q ON q.xero_invoice_id = p.xero_invoice_id
    LEFT JOIN LATERAL (SELECT x.reference, x.line_items FROM public.xero_invoices x
                        WHERE x.xero_invoice_id = p.xero_invoice_id AND x.invoice_type = 'ACCPAY'
                        ORDER BY (x.status IN ('AUTHORISED', 'PAID')) DESC LIMIT 1) x ON true
$$;
REVOKE ALL ON FUNCTION public.materials_ai_second_check_due(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materials_ai_second_check_due(integer) TO service_role;

-- p_result: {decision: job|not_job_related|unsure, job_number?, confidence, reason, model}
-- Agreement: same decision, and for a job the same job number. "unsure" is
-- not agreement. The day's disagreement share over at least 10 checks above
-- the setting raises the bar by 0.03 (never above 0.97), once a day.
-- TP-03: on a held row, agreement places the bill through materials_ai_apply
-- (every refusal and the bar re-read); disagreement leaves it for a person
-- with both answers. Returns {ok, agreed, bar_raised, outcome, held}.
CREATE OR REPLACE FUNCTION public.materials_ai_record_second_check(p_placement uuid, p_result jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  p public.materials_ai_placements%ROWTYPE;
  s public.materials_ai_settings%ROWTYPE;
  v_agree boolean;
  v_day date := (now() AT TIME ZONE 'Australia/Perth')::date;
  v_checked integer;
  v_disagreed integer;
  v_raised boolean := false;
  v_held boolean;
  v_outcome text;
BEGIN
  SELECT * INTO p FROM public.materials_ai_placements WHERE id = p_placement;
  IF NOT FOUND THEN RAISE EXCEPTION 'second_check: placement not found'; END IF;
  -- The bill's lock first, as Undo and apply take it, then the row.
  PERFORM pg_advisory_xact_lock(hashtextextended('job_materials_facts:' || p.xero_invoice_id, 0));
  SELECT * INTO p FROM public.materials_ai_placements WHERE id = p_placement FOR UPDATE;
  IF p.second_check_status <> 'due' THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'status', p.second_check_status, 'outcome', p.outcome);
  END IF;
  v_held := p.outcome = 'held_for_check';
  v_agree := COALESCE(p_result ->> 'decision', '') = p.decision
             AND (p.decision <> 'job' OR upper(btrim(COALESCE(p_result ->> 'job_number', ''))) = upper(COALESCE(p.job_number, '')));
  UPDATE public.materials_ai_placements
     SET second_check_status = CASE WHEN v_agree THEN 'agreed' ELSE 'disagreed' END,
         second_check = jsonb_build_object(
           'decision', p_result ->> 'decision', 'job_number', p_result ->> 'job_number',
           'confidence', p_result -> 'confidence', 'reason', left(p_result ->> 'reason', 2000),
           'model', left(p_result ->> 'model', 100)),
         second_check_at = now()
   WHERE id = p.id;

  SELECT count(*) FILTER (WHERE second_check_status IN ('agreed', 'disagreed')),
         count(*) FILTER (WHERE second_check_status = 'disagreed')
    INTO v_checked, v_disagreed
    FROM public.materials_ai_placements
   WHERE second_check_at IS NOT NULL AND (second_check_at AT TIME ZONE 'Australia/Perth')::date = v_day;
  SELECT * INTO s FROM public.materials_ai_settings WHERE id FOR UPDATE;
  IF v_checked >= 10 AND v_disagreed::numeric / v_checked > s.disagreement_raise_at AND s.confidence_bar < 0.97
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.bar_history) h
                      WHERE h ->> 'day' = v_day::text AND h ->> 'why' = 'disagreement') THEN
    UPDATE public.materials_ai_settings
       SET confidence_bar = LEAST(confidence_bar + 0.03, 0.97),
           bar_history = bar_history || jsonb_build_array(jsonb_build_object(
             'day', v_day, 'at', now(), 'why', 'disagreement', 'from', confidence_bar,
             'to', LEAST(confidence_bar + 0.03, 0.97), 'checked', v_checked, 'disagreed', v_disagreed)),
           updated_at = now(), updated_by = 'auto:second_check'
     WHERE id;
    v_raised := true;
  END IF;

  IF v_held THEN
    IF v_agree THEN
      PERFORM public.materials_ai_apply(p.call_id, p.model, jsonb_build_object(
        'xero_invoice_id', p.xero_invoice_id, 'decision', p.decision, 'job_id', p.job_id, 'job_number', p.job_number,
        'confidence', p.confidence, 'reason', p.reason, 'evidence', p.evidence, 'held_placement_id', p.id));
    END IF;
    -- Disagreed, unsure, or the reader was switched off: a person decides, with both answers.
    UPDATE public.materials_ai_placements
       SET outcome = 'left_for_person',
           refusal = CASE WHEN v_agree THEN 'the reader was off when the second check agreed' END
     WHERE id = p.id AND outcome = 'held_for_check';
  END IF;
  SELECT outcome INTO v_outcome FROM public.materials_ai_placements WHERE id = p.id;
  RETURN jsonb_build_object('ok', true, 'agreed', v_agree, 'bar_raised', v_raised, 'outcome', v_outcome, 'held', v_held);
END;
$$;
REVOKE ALL ON FUNCTION public.materials_ai_record_second_check(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materials_ai_record_second_check(uuid, jsonb) TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 6. Status (20261028173000's keys, plus the held bills and the keys)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.materials_ai_status()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH s AS (SELECT * FROM public.materials_ai_settings WHERE id),
  d AS (SELECT (now() AT TIME ZONE 'Australia/Perth')::date AS day),
  p AS (SELECT * FROM public.materials_ai_placements),
  latest AS (SELECT DISTINCT ON (xero_invoice_id) * FROM public.materials_ai_placements ORDER BY xero_invoice_id, created_at DESC)
  SELECT jsonb_build_object(
    'enabled', s.enabled,
    'confidence_bar', s.confidence_bar,
    'daily_call_cap', s.daily_call_cap,
    'calls_today', (SELECT count(*) FROM public.materials_ai_calls c, d WHERE c.run_date = d.day),
    'placed', (SELECT count(*) FROM p WHERE outcome = 'placed' AND undone_at IS NULL),
    'placed_ex', (SELECT COALESCE(sum(amount_ex), 0) FROM p WHERE outcome = 'placed' AND undone_at IS NULL),
    'placed_installer', (SELECT count(*) FROM p WHERE outcome = 'placed' AND undone_at IS NULL AND installer),
    'filed_not_job_related', (SELECT count(*) FROM p WHERE outcome = 'filed_not_job_related' AND undone_at IS NULL),
    'filed_ex', (SELECT COALESCE(sum(amount_ex), 0) FROM p WHERE outcome = 'filed_not_job_related' AND undone_at IS NULL),
    'undone', (SELECT count(*) FROM p WHERE undone_at IS NOT NULL),
    'left_for_person_open', (SELECT count(*) FROM latest l JOIN public.materials_reconciliation_queue q
                              ON q.xero_invoice_id = l.xero_invoice_id AND q.status = 'open'
                             WHERE l.outcome = 'left_for_person'),
    'second_check', jsonb_build_object(
      'due', (SELECT count(*) FROM p WHERE second_check_status = 'due' AND undone_at IS NULL),
      'agreed', (SELECT count(*) FROM p WHERE second_check_status = 'agreed'),
      'disagreed', (SELECT count(*) FROM p WHERE second_check_status = 'disagreed'),
      'held_due', (SELECT count(*) FROM p WHERE outcome = 'held_for_check')),
    'held_for_check', (SELECT count(*) FROM p WHERE outcome = 'held_for_check'),
    'held_for_check_ex', (SELECT COALESCE(sum(amount_ex), 0) FROM p WHERE outcome = 'held_for_check'),
    'held_then_placed', (SELECT count(*) FROM p WHERE held_at IS NOT NULL AND outcome = 'placed' AND undone_at IS NULL),
    'held_then_left_for_person', (SELECT count(*) FROM p WHERE held_at IS NOT NULL AND outcome = 'left_for_person'),
    'placed_before_two_keys', (SELECT count(*) FROM p WHERE outcome = 'placed' AND undone_at IS NULL AND agreed_keys IS NULL),
    'placed_keys', (SELECT COALESCE(jsonb_object_agg(k.key, k.n), '{}'::jsonb) FROM (
        SELECT key, count(*) AS n FROM p, unnest(p.agreed_keys) key
         WHERE p.outcome = 'placed' AND p.undone_at IS NULL GROUP BY key) k),
    'bills_to_place_open', (SELECT count(*) FROM public.materials_reconciliation_queue WHERE status = 'open'),
    'bills_to_place_open_ex', (SELECT COALESCE(sum(sub_total), 0) FROM public.materials_reconciliation_queue WHERE status = 'open'),
    'bar_history', s.bar_history)
  FROM s
$$;
REVOKE ALL ON FUNCTION public.materials_ai_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materials_ai_status() TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 7. Bills the AI placed live with one key only (read only; nothing moves)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_materials_ai_placed_without_key AS
SELECT p.id AS placement_id,
       p.xero_invoice_id,
       p.invoice_number,
       p.contact_name,
       p.amount_ex,
       p.installer,
       p.job_id,
       p.job_number,
       p.confidence,
       p.bar,
       p.model,
       p.reason,
       p.created_at,
       p.second_check_status,
       p.second_check,
       (p.agreed_keys IS NULL) AS placed_before_two_keys
  FROM public.materials_ai_placements p
 WHERE p.outcome = 'placed'
   AND p.undone_at IS NULL
   AND p.second_check_status <> 'agreed'
   AND NOT (COALESCE(p.agreed_keys, '{}'::text[]) && ARRAY['job_number', 'purchase_order', 'xero_project', 'site_address', 'second_check']::text[])
   AND jsonb_array_length(public.materials_ai_hard_keys(p.xero_invoice_id, p.job_id) -> 'keys') = 0;
COMMENT ON VIEW public.v_materials_ai_placed_without_key IS
  'AI bill two keys (20261029093000): bills the AI placed on a job that are still placed, with no hard clue agreeing with that job (job number or PO, read now with materials_ai_hard_keys; same supplier is not a key until TP-04) and no agreeing second check. They were placed live before TP-03 on the AI''s confidence alone; this migration does not move them. second_check_status shows whether a check is due, disagreed, or was never asked for. A person decides each (Undo in Bills to place). Read only, service role only.';
REVOKE ALL ON public.v_materials_ai_placed_without_key FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_materials_ai_placed_without_key TO service_role;

CREATE OR REPLACE FUNCTION public.materials_ai_placed_without_key_count()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'placed_without_key', count(*),
    'placed_without_key_ex', COALESCE(sum(amount_ex), 0),
    'check_due', count(*) FILTER (WHERE second_check_status = 'due'),
    'check_disagreed', count(*) FILTER (WHERE second_check_status = 'disagreed'),
    'check_disagreed_ex', COALESCE(sum(amount_ex) FILTER (WHERE second_check_status = 'disagreed'), 0),
    'never_checked', count(*) FILTER (WHERE second_check_status = 'not_needed'),
    'placed_before_two_keys', count(*) FILTER (WHERE placed_before_two_keys))
  FROM public.v_materials_ai_placed_without_key
$$;
COMMENT ON FUNCTION public.materials_ai_placed_without_key_count() IS
  'AI bill two keys (20261029093000): how many bills, and how many dollars ex GST, the AI placed live with no hard clue and no agreeing second check (v_materials_ai_placed_without_key), split by their second check. Read only. Service role only.';
REVOKE ALL ON FUNCTION public.materials_ai_placed_without_key_count() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materials_ai_placed_without_key_count() TO service_role;
