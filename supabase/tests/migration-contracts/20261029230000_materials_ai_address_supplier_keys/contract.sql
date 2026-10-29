-- Contract for 20261029230000_materials_ai_address_supplier_keys.
--
-- Synthetic jobs, suppliers and bills; no customer data. Everything rolls back.
--
--   SWF-29101 site 14 Keystone Street     SWP-29102 site 8 Ridge Road
--   SWF-29103 site 5 Twin Court           SWF-29104 site 5 Twin Ct (the same exact address)
--   SWF-29105 site 22 Loose Bend (no type word, so no exact key)
--   SWF-29106 the supplier job            SWF-29107 holding job at 9 Holding Lane
--   SWF-29108 site 9 Holding Lane
--   SWF-29109 site 14 OConnor St          SWF-29110 site 14 O'Connor Street (the same B0 key)
--   SWF-29111 site 3 D'Arcy Road
--
-- Bills (no job number or PO unless said):
--   AK-LOOSE   "Deliver 14 Keystone" on SWF-29101: loose only, no key; held,
--              then placed only when the blind check agrees.
--   AK-ADDR    "Deliver to 14 Keystone St" on SWF-29101: placed on the address
--              alone, audit and event name site_address.
--   AK-LINE2   the address in line 2 only: the key says where.
--   AK-SPLIT   "Unit 14" in the reference, "Keystone Street posts" in a line:
--              places are read one at a time, so no key.
--   AK-UNTYPED "22 Loose Bend" on SWF-29105: no exact key exists, no key.
--   AK-TWIN    "5 Twin Court" on SWF-29103: SWF-29104 has the same exact
--              address, no key.
--   AK-OTHER   SWF-29101's address and SWP-29102's: no address key.
--   AK-HOLDAD  "9 Holding Lane" on SWF-29108: the holding job at the same
--              address is not a job, key.
--   AK-OTHJOB  SWF-29101's address and the number SWP-29102: rule 0, no key.
--   AK-OCON    "Deliver to 14 OConnor St" on SWF-29109: SWF-29110's raw site
--              address differs ("O'Connor Street") but its B0 key is the same,
--              so no key, and the bill is held (Codex R on 29c0bbd0: a raw
--              text narrowing must never drop a job whose key is equal).
--   AK-OCON2   the same the other way round, on SWF-29110.
--   AK-DARCY   SWF-29101's address and "3 Darcy Rd", which is SWF-29111's
--              B0 key though its raw address is "3 D'Arcy Road": no key.
--   AK-SUP     supplier C-AK-SUP, a person placed AK-SUPP1 on SWF-29106:
--              placed on the supplier alone, audit and event name same_supplier.
--   AK-RULE    supplier C-AK-RULE, a rule placed AK-RULEP (xero_ref_link): key.
--   AK-AIONLY  supplier C-AK-AI, only an AI placement on the job: no key.
--   AK-VOID    supplier C-AK-VOID, the person's bill is voided in Xero: no key.
--   AK-SELF    supplier C-AK-SELF, the only bill on the job is this bill: no key.
--   AK-TWO     supplier C-AK-TWO billed SWF-29106 and SWP-29102: no key.
--   AK-NONE    no clue: held; the blind check disagrees, left for a person.
--   AK-JOB, AK-PO  job number and PO clues, compared with 20261029093000's body.
--
-- Expected: an exact site address and the same supplier (person or rule,
-- live, not this bill, one job) are hard clues and name themselves; a loose
-- address, a shared address, another job's address, the AI's own placement, a
-- voided bill and this bill are not; with no clue the blind check governs;
-- the job_number and purchase_order clues, and everything 20261029093000
-- withholds, are its body's answers on every bill and job here; no phone,
-- email or amount reaches a key or its evidence.

\set ON_ERROR_STOP on

BEGIN;

-- 20261029093000's materials_ai_hard_keys, byte for byte, to compare against.
CREATE FUNCTION pg_temp.tp03_hard_keys(p_bill text, p_job_id uuid)
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

DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'pg_temp.tp03_hard_keys(text,uuid)'::regprocedure)
     IS DISTINCT FROM '2ef85da40004fb45adc42ea2488e8947' THEN
    RAISE EXCEPTION 'address and supplier keys: the comparison copy is not 20261029093000''s body';
  END IF;
END $$;

UPDATE public.materials_ai_settings
   SET enabled = true, confidence_bar = 0.900, second_check_sample = 0, second_check_over_ex = 100000, reread_after_days = 14
 WHERE id;

INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at,
                         client_name, client_phone, client_email, site_address, site_suburb) VALUES
  ('d7000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'SWF-29101', false, '{}', '{}', NULL,
   '2026-07-01T00:00:00Z', 'Ak Client One', '0400 555 101', 'ak.one@example.test', '14 Keystone Street', 'Keyville'),
  ('d7000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'accepted', 'patio', 'SWP-29102', false, '{}', '{}', NULL,
   '2026-07-01T00:00:00Z', 'Ak Client Two', '0400 555 102', 'ak.two@example.test', '8 Ridge Road', 'Keyton'),
  ('d7000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'SWF-29103', false, '{}', '{}', NULL,
   '2026-07-01T00:00:00Z', 'Ak Client Three', NULL, NULL, '5 Twin Court', 'Keyburn'),
  ('d7000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'SWF-29104', false, '{}', '{}', NULL,
   '2026-07-01T00:00:00Z', 'Ak Client Four', NULL, NULL, '5 Twin Ct', 'Keyburn'),
  ('d7000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'SWF-29105', false, '{}', '{}', NULL,
   '2026-07-01T00:00:00Z', 'Ak Client Five', NULL, NULL, '22 Loose Bend', 'Keyburn'),
  ('d7000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'SWF-29106', false, '{}', '{}', NULL,
   '2026-07-01T00:00:00Z', 'Ak Client Six', NULL, NULL, '30 Supplier Way', 'Keyburn'),
  ('d7000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'SWF-29107', false,
   '{"do_not_schedule": "true"}', '{}', NULL, '2026-07-01T00:00:00Z', 'Holding', NULL, NULL, '9 Holding Lane', 'Keyburn'),
  ('d7000000-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'SWF-29108', false, '{}', '{}', NULL,
   '2026-07-01T00:00:00Z', 'Ak Client Eight', NULL, NULL, '9 Holding Lane', 'Keyburn'),
  ('d7000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'SWF-29109', false, '{}', '{}', NULL,
   '2026-07-01T00:00:00Z', 'Ak Client Nine', NULL, NULL, '14 OConnor St', 'Keyburn'),
  ('d7000000-0000-4000-8000-000000000010', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'SWF-29110', false, '{}', '{}', NULL,
   '2026-07-01T00:00:00Z', 'Ak Client Ten', NULL, NULL, '14 O''Connor Street', 'Keyburn'),
  ('d7000000-0000-4000-8000-000000000011', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'SWF-29111', false, '{}', '{}', NULL,
   '2026-07-01T00:00:00Z', 'Ak Client Eleven', NULL, NULL, '3 D''Arcy Road', 'Keyburn');

INSERT INTO public.purchase_orders (id, po_number, job_id, xero_contact_id, supplier_name, subtotal, status) VALUES
  ('d7000000-0000-4000-8000-0000000000a1', 'PO-2910101', 'd7000000-0000-4000-8000-000000000001', 'C-AK-PO', 'Ak Steel', 345.67, 'sent');

INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, reference, line_items, raw_json, job_id)
SELECT '00000000-0000-0000-0000-000000000001', b.id, 'AKB-' || b.id, 'ACCPAY', b.status, b.supplier, b.amount, b.amount * 1.1, '2026-08-21', b.ref,
       b.lines::jsonb, '{"LineAmountTypes": "Exclusive"}', NULL
  FROM (VALUES
    ('AK-LOOSE', 'Ak Steel', 301.11, 'Deliver 14 Keystone, Keyville', '[{"Description": "Fence posts", "AccountCode": "310", "LineAmount": 301.11}]', 'AUTHORISED'),
    ('AK-ADDR', 'Ak Steel', 302.22, 'Deliver to 14 Keystone St, Keyville', '[{"Description": "Fence posts", "AccountCode": "310", "LineAmount": 302.22}]', 'AUTHORISED'),
    ('AK-LINE2', 'Ak Steel', 303.33, 'Order 77', '[{"Description": "Delivery", "AccountCode": "310", "LineAmount": 3.33}, {"Description": "Posts to 14 Keystone Street", "AccountCode": "310", "LineAmount": 300}]', 'AUTHORISED'),
    ('AK-SPLIT', 'Ak Steel', 304.44, 'Unit 14', '[{"Description": "Keystone Street posts", "AccountCode": "310", "LineAmount": 304.44}]', 'AUTHORISED'),
    ('AK-UNTYPED', 'Ak Steel', 305.55, 'Site 22 Loose Bend', '[{"Description": "Posts", "AccountCode": "310", "LineAmount": 305.55}]', 'AUTHORISED'),
    ('AK-TWIN', 'Ak Steel', 306.66, 'Site 5 Twin Court', '[{"Description": "Posts", "AccountCode": "310", "LineAmount": 306.66}]', 'AUTHORISED'),
    ('AK-OTHER', 'Ak Steel', 307.77, '14 Keystone St and 8 Ridge Rd', '[{"Description": "Posts", "AccountCode": "310", "LineAmount": 307.77}]', 'AUTHORISED'),
    ('AK-HOLDAD', 'Ak Steel', 308.88, 'Site 9 Holding Lane', '[{"Description": "Posts", "AccountCode": "310", "LineAmount": 308.88}]', 'AUTHORISED'),
    ('AK-OTHJOB', 'Ak Steel', 309.99, '14 Keystone St for SWP-29102', '[{"Description": "Posts", "AccountCode": "310", "LineAmount": 309.99}]', 'AUTHORISED'),
    ('AK-JOB', 'Ak Steel', 310.10, 'Order for SWF 29101', '[{"Description": "Posts", "AccountCode": "310", "LineAmount": 310.10}]', 'AUTHORISED'),
    ('AK-PO', 'Ak Steel', 311.11, 'PO2910101 delivered to 14 Keystone St', '[{"Description": "Posts", "AccountCode": "310", "LineAmount": 311.11}]', 'AUTHORISED'),
    ('AK-SUPP1', 'Ak Sup', 100.01, NULL, '[{"Description": "Gravel", "AccountCode": "310", "LineAmount": 100.01}]', 'AUTHORISED'),
    ('AK-SUP', 'Ak Sup', 312.12, NULL, '[{"Description": "Gravel", "AccountCode": "310", "LineAmount": 312.12}]', 'AUTHORISED'),
    ('AK-RULEP', 'Ak Rule', 100.02, NULL, '[{"Description": "Sand", "AccountCode": "310", "LineAmount": 100.02}]', 'AUTHORISED'),
    ('AK-RULE', 'Ak Rule', 313.13, NULL, '[{"Description": "Sand", "AccountCode": "310", "LineAmount": 313.13}]', 'AUTHORISED'),
    ('AK-AIP', 'Ak Ai', 100.03, NULL, '[{"Description": "Lime", "AccountCode": "310", "LineAmount": 100.03}]', 'AUTHORISED'),
    ('AK-AIONLY', 'Ak Ai', 314.14, NULL, '[{"Description": "Lime", "AccountCode": "310", "LineAmount": 314.14}]', 'AUTHORISED'),
    ('AK-VOIDP', 'Ak Void', 100.04, NULL, '[{"Description": "Clay", "AccountCode": "310", "LineAmount": 100.04}]', 'VOIDED'),
    ('AK-VOID', 'Ak Void', 315.15, NULL, '[{"Description": "Clay", "AccountCode": "310", "LineAmount": 315.15}]', 'AUTHORISED'),
    ('AK-SELF', 'Ak Self', 316.16, NULL, '[{"Description": "Mesh", "AccountCode": "310", "LineAmount": 316.16}]', 'AUTHORISED'),
    ('AK-TWOP1', 'Ak Two', 100.05, NULL, '[{"Description": "Wire", "AccountCode": "310", "LineAmount": 100.05}]', 'AUTHORISED'),
    ('AK-TWOP2', 'Ak Two', 100.06, NULL, '[{"Description": "Wire", "AccountCode": "310", "LineAmount": 100.06}]', 'AUTHORISED'),
    ('AK-TWO', 'Ak Two', 317.17, NULL, '[{"Description": "Wire", "AccountCode": "310", "LineAmount": 317.17}]', 'AUTHORISED'),
    ('AK-OCON', 'Ak Steel', 319.19, 'Deliver to 14 OConnor St', '[{"Description": "Posts", "AccountCode": "310", "LineAmount": 319.19}]', 'AUTHORISED'),
    ('AK-OCON2', 'Ak Steel', 320.20, 'Deliver to 14 O''Connor Street', '[{"Description": "Posts", "AccountCode": "310", "LineAmount": 320.20}]', 'AUTHORISED'),
    ('AK-DARCY', 'Ak Steel', 321.21, '14 Keystone St and 3 Darcy Rd', '[{"Description": "Posts", "AccountCode": "310", "LineAmount": 321.21}]', 'AUTHORISED'),
    ('AK-NONE', 'Ak Steel', 318.18, NULL, '[{"Description": "Screws", "AccountCode": "310", "LineAmount": 318.18}]', 'AUTHORISED')
  ) b(id, supplier, amount, ref, lines, status);

INSERT INTO public.materials_reconciliation_queue (xero_invoice_id, invoice_number, contact_name, xero_contact_id, sub_total, total, invoice_date, status)
SELECT x.xero_invoice_id, x.invoice_number, x.contact_name,
       -- One Xero contact per bill, except the supplier cases, which share theirs.
       CASE x.contact_name WHEN 'Ak Sup' THEN 'C-AK-SUP' WHEN 'Ak Rule' THEN 'C-AK-RULE' WHEN 'Ak Ai' THEN 'C-AK-AI'
                           WHEN 'Ak Void' THEN 'C-AK-VOID' WHEN 'Ak Self' THEN 'C-AK-SELF' WHEN 'Ak Two' THEN 'C-AK-TWO'
                           ELSE 'C-' || x.xero_invoice_id END,
       x.sub_total, x.total, x.invoice_date,
       CASE WHEN x.xero_invoice_id IN ('AK-SUPP1', 'AK-RULEP', 'AK-AIP', 'AK-VOIDP', 'AK-TWOP1', 'AK-TWOP2') THEN 'assigned' ELSE 'open' END
  FROM public.xero_invoices x WHERE x.xero_invoice_id LIKE 'AK-%';

INSERT INTO public.job_materials_facts (xero_invoice_id, invoice_number, xero_contact_id, job_id, job_number, lane, kind, amount_ex_gst, confidence, automation_source, fact_date) VALUES
  ('AK-SUPP1', 'AKB-AK-SUPP1', 'C-AK-SUP', 'd7000000-0000-4000-8000-000000000006', 'SWF-29106', 'materials', 'actual', 100.01, 'high_manual', 'manual_queue', '2026-08-01'),
  ('AK-RULEP', 'AKB-AK-RULEP', 'C-AK-RULE', 'd7000000-0000-4000-8000-000000000006', 'SWF-29106', 'materials', 'actual', 100.02, 'high', 'xero_ref_link', '2026-08-01'),
  ('AK-AIP', 'AKB-AK-AIP', 'C-AK-AI', 'd7000000-0000-4000-8000-000000000006', 'SWF-29106', 'materials', 'actual', 100.03, 'medium', 'agent_ai', '2026-08-01'),
  ('AK-VOIDP', 'AKB-AK-VOIDP', 'C-AK-VOID', 'd7000000-0000-4000-8000-000000000006', 'SWF-29106', 'materials', 'actual', 100.04, 'high_manual', 'manual_queue', '2026-08-01'),
  -- This bill's own row: it may not vouch for itself.
  ('AK-SELF', 'AKB-AK-SELF', 'C-AK-SELF', 'd7000000-0000-4000-8000-000000000006', 'SWF-29106', 'materials', 'actual', 316.16, 'high_manual', 'manual_queue', '2026-08-21'),
  ('AK-TWOP1', 'AKB-AK-TWOP1', 'C-AK-TWO', 'd7000000-0000-4000-8000-000000000006', 'SWF-29106', 'materials', 'actual', 100.05, 'high_manual', 'manual_queue', '2026-08-01'),
  ('AK-TWOP2', 'AKB-AK-TWOP2', 'C-AK-TWO', 'd7000000-0000-4000-8000-000000000002', 'SWP-29102', 'materials', 'actual', 100.06, 'high_manual', 'manual_queue', '2026-08-01');

DO $$
DECLARE
  j1 uuid := 'd7000000-0000-4000-8000-000000000001';
  j6 uuid := 'd7000000-0000-4000-8000-000000000006';
  c uuid;
  v jsonb;
  k jsonb;
  r record;
  pid uuid;
  w record;
  out_text text := '';
  bad text;
BEGIN
  -- 1. A loose address is never a key: held, placed only when the blind check agrees.
  k := public.materials_ai_hard_keys('AK-LOOSE', j1);
  IF k -> 'keys' <> '[]'::jsonb THEN RAISE EXCEPTION 'address and supplier keys: AK-LOOSE a loose address gave a key: %', k; END IF;
  IF k -> 'evidence' ->> 'withheld' IS DISTINCT FROM 'the site address is on the bill only loosely (reference)' THEN
    RAISE EXCEPTION 'address and supplier keys: AK-LOOSE withheld %', k;
  END IF;
  c := public.materials_ai_reserve_call('place', 'test-model', 12);
  IF c IS NULL THEN RAISE EXCEPTION 'reserve: no call'; END IF;
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"AK-LOOSE","decision":"job","job_number":"SWF-29101","confidence":0.95,"reason":"Delivered to the site.","evidence":["address"]}');
  IF v ->> 'outcome' <> 'held_for_check' OR v -> 'keys' <> '["ai_confidence"]'::jsonb THEN RAISE EXCEPTION 'AK-LOOSE apply: %', v; END IF;
  pid := (v ->> 'placement_id')::uuid;
  IF EXISTS (SELECT 1 FROM public.job_materials_facts WHERE xero_invoice_id = 'AK-LOOSE') THEN RAISE EXCEPTION 'AK-LOOSE placed while held'; END IF;
  v := public.materials_ai_record_second_check(pid, '{"decision":"job","job_number":"SWF-29101","confidence":0.9,"reason":"agree","model":"claude"}');
  IF v ->> 'outcome' <> 'placed' THEN RAISE EXCEPTION 'AK-LOOSE check: %', v; END IF;
  SELECT * INTO r FROM public.materials_ai_placements WHERE id = pid;
  IF r.agreed_keys <> ARRAY['ai_confidence', 'second_check'] THEN RAISE EXCEPTION 'AK-LOOSE keys %', r.agreed_keys; END IF;

  -- 2. An exact site address alone: placed, and the audit row and event name it.
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"AK-ADDR","decision":"job","job_number":"SWF-29101","confidence":0.95,"reason":"Delivered to the site.","evidence":["address"]}');
  IF v ->> 'outcome' <> 'placed' OR v -> 'keys' <> '["ai_confidence", "site_address"]'::jsonb THEN RAISE EXCEPTION 'AK-ADDR apply: %', v; END IF;
  SELECT * INTO r FROM public.materials_ai_placements WHERE id = (v ->> 'placement_id')::uuid;
  IF r.outcome <> 'placed' OR r.agreed_keys <> ARRAY['ai_confidence', 'site_address'] OR r.held_at IS NOT NULL
     OR r.key_evidence ->> 'site_address' IS DISTINCT FROM '14 keystone st in reference' THEN
    RAISE EXCEPTION 'AK-ADDR audit: % % %', r.outcome, r.agreed_keys, r.key_evidence;
  END IF;
  -- The key is the job picture's own site_key.
  IF (SELECT e ->> 'site_key' FROM jsonb_array_elements(public.context_job_picture(ARRAY[j1])) e) IS DISTINCT FROM '14 keystone st' THEN
    RAISE EXCEPTION 'AK-ADDR: the key is not the picture''s site_key';
  END IF;
  SELECT detail_json INTO k FROM public.job_events
   WHERE job_id = j1 AND event_type = 'materials_bill_assigned' AND detail_json ->> 'xero_invoice_id' = 'AK-ADDR';
  IF k -> 'keys' <> '["ai_confidence", "site_address"]'::jsonb OR k -> 'key_evidence' ->> 'site_address' IS NULL THEN
    RAISE EXCEPTION 'AK-ADDR event: %', k;
  END IF;
  IF (SELECT job_id FROM public.job_materials_facts WHERE xero_invoice_id = 'AK-ADDR') IS DISTINCT FROM j1 THEN RAISE EXCEPTION 'AK-ADDR fact'; END IF;

  -- 3. Where the address is, and the address cases that give no key.
  k := public.materials_ai_hard_keys('AK-LINE2', j1);
  IF k -> 'keys' <> '["site_address"]'::jsonb OR k -> 'evidence' ->> 'site_address' <> '14 keystone st in line 2' THEN RAISE EXCEPTION 'AK-LINE2: %', k; END IF;
  k := public.materials_ai_hard_keys('AK-SPLIT', j1);
  IF k -> 'keys' <> '[]'::jsonb THEN RAISE EXCEPTION 'AK-SPLIT: two places joined into one address: %', k; END IF;
  k := public.materials_ai_hard_keys('AK-UNTYPED', 'd7000000-0000-4000-8000-000000000005');
  IF k -> 'keys' <> '[]'::jsonb OR k -> 'evidence' ->> 'withheld' IS DISTINCT FROM 'the site address is on the bill only loosely (reference)' THEN
    RAISE EXCEPTION 'AK-UNTYPED: %', k;
  END IF;
  k := public.materials_ai_hard_keys('AK-TWIN', 'd7000000-0000-4000-8000-000000000003');
  IF k -> 'keys' <> '[]'::jsonb OR k -> 'evidence' ->> 'withheld' NOT LIKE '%also the site of SWF-29104%' THEN RAISE EXCEPTION 'AK-TWIN: %', k; END IF;
  k := public.materials_ai_hard_keys('AK-OTHER', j1);
  IF k -> 'keys' <> '[]'::jsonb OR k -> 'evidence' ->> 'withheld' NOT LIKE '%SWP-29102%' THEN RAISE EXCEPTION 'AK-OTHER: %', k; END IF;
  k := public.materials_ai_hard_keys('AK-HOLDAD', 'd7000000-0000-4000-8000-000000000008');
  IF k -> 'keys' <> '["site_address"]'::jsonb THEN RAISE EXCEPTION 'AK-HOLDAD: a holding job counted as a twin: %', k; END IF;
  k := public.materials_ai_hard_keys('AK-HOLDAD', 'd7000000-0000-4000-8000-000000000007');
  IF k -> 'keys' <> '[]'::jsonb THEN RAISE EXCEPTION 'AK-HOLDAD: a holding job got a key: %', k; END IF;
  k := public.materials_ai_hard_keys('AK-OTHJOB', j1);
  IF k -> 'keys' <> '[]'::jsonb OR k -> 'evidence' ->> 'withheld' <> 'the bill also names SWP-29102' THEN RAISE EXCEPTION 'AK-OTHJOB: %', k; END IF;
  -- The same B0 key behind different raw text: never dropped by a narrowing.
  IF public.context_address_key('14 OConnor St') IS DISTINCT FROM public.context_address_key('14 O''Connor Street')
     OR public.context_address_key('3 D''Arcy Road') IS DISTINCT FROM '3 darcy rd' THEN
    RAISE EXCEPTION 'address and supplier keys: witness keys %', public.context_address_key('14 O''Connor Street');
  END IF;
  k := public.materials_ai_hard_keys('AK-OCON', 'd7000000-0000-4000-8000-000000000009');
  IF k -> 'keys' <> '[]'::jsonb OR k -> 'evidence' ->> 'withheld' NOT LIKE '%also the site of SWF-29110%' THEN
    RAISE EXCEPTION 'address and supplier keys: AK-OCON a twin with the same B0 key was dropped: %', k;
  END IF;
  RAISE NOTICE 'witness %: %', 'AK-OCON', k;
  k := public.materials_ai_hard_keys('AK-OCON2', 'd7000000-0000-4000-8000-000000000010');
  IF k -> 'keys' <> '[]'::jsonb OR k -> 'evidence' ->> 'withheld' NOT LIKE '%also the site of SWF-29109%' THEN
    RAISE EXCEPTION 'address and supplier keys: AK-OCON2 a twin with the same B0 key was dropped: %', k;
  END IF;
  RAISE NOTICE 'witness %: %', 'AK-OCON2', k;
  k := public.materials_ai_hard_keys('AK-DARCY', j1);
  IF k -> 'keys' <> '[]'::jsonb OR k -> 'evidence' ->> 'withheld' NOT LIKE '%SWF-29111%' THEN
    RAISE EXCEPTION 'address and supplier keys: AK-DARCY another job''s address with the same B0 key was dropped: %', k;
  END IF;
  RAISE NOTICE 'witness %: %', 'AK-DARCY', k;
  -- Above the bar with no other clue, the witness is held for the blind check, not placed.
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"AK-OCON","decision":"job","job_number":"SWF-29109","confidence":0.97,"reason":"Delivered to the site.","evidence":["address"]}');
  IF v ->> 'outcome' <> 'held_for_check' OR v -> 'keys' <> '["ai_confidence"]'::jsonb
     OR EXISTS (SELECT 1 FROM public.job_materials_facts WHERE xero_invoice_id = 'AK-OCON') THEN
    RAISE EXCEPTION 'address and supplier keys: AK-OCON placed without the blind check: %', v;
  END IF;
  RAISE NOTICE 'witness %: %', 'AK-OCON apply at 0.97', v;
  -- Job number and PO keep their place before the address.
  k := public.materials_ai_hard_keys('AK-PO', j1);
  IF k -> 'keys' <> '["purchase_order", "site_address"]'::jsonb THEN RAISE EXCEPTION 'AK-PO: %', k; END IF;

  -- 4. The same supplier, placed by a person: placed, and named same_supplier.
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"AK-SUP","decision":"job","job_number":"SWF-29106","confidence":0.95,"reason":"Same gravel as before.","evidence":["supplier"]}');
  IF v ->> 'outcome' <> 'placed' OR v -> 'keys' <> '["ai_confidence", "same_supplier"]'::jsonb THEN RAISE EXCEPTION 'AK-SUP apply: %', v; END IF;
  SELECT * INTO r FROM public.materials_ai_placements WHERE id = (v ->> 'placement_id')::uuid;
  IF r.agreed_keys <> ARRAY['ai_confidence', 'same_supplier'] OR r.key_evidence ->> 'same_supplier' IS DISTINCT FROM 'AKB-AK-SUPP1 (manual_queue)'
     OR r.key_evidence ? 'supplier_history' THEN
    RAISE EXCEPTION 'AK-SUP audit: % %', r.agreed_keys, r.key_evidence;
  END IF;
  SELECT detail_json INTO k FROM public.job_events
   WHERE job_id = j6 AND event_type = 'materials_bill_assigned' AND detail_json ->> 'xero_invoice_id' = 'AK-SUP';
  IF k -> 'keys' <> '["ai_confidence", "same_supplier"]'::jsonb THEN RAISE EXCEPTION 'AK-SUP event: %', k; END IF;
  k := public.materials_ai_hard_keys('AK-RULE', j6);
  IF k -> 'keys' <> '["same_supplier"]'::jsonb OR k -> 'evidence' ->> 'same_supplier' <> 'AKB-AK-RULEP (xero_ref_link)' THEN RAISE EXCEPTION 'AK-RULE: %', k; END IF;
  -- The supplier's bill on this job vouches for this job only.
  IF public.materials_ai_hard_keys('AK-RULE', j1) -> 'keys' <> '[]'::jsonb THEN RAISE EXCEPTION 'AK-RULE on another job'; END IF;

  -- 5. No key from the AI's own placement, a voided bill, this bill, or a supplier on two jobs.
  k := public.materials_ai_hard_keys('AK-AIONLY', j6);
  IF k -> 'keys' <> '[]'::jsonb OR k -> 'evidence' ? 'same_supplier' THEN RAISE EXCEPTION 'AK-AIONLY: the AI vouched for itself: %', k; END IF;
  k := public.materials_ai_hard_keys('AK-VOID', j6);
  IF k -> 'keys' <> '[]'::jsonb THEN RAISE EXCEPTION 'AK-VOID: a voided bill vouched: %', k; END IF;
  k := public.materials_ai_hard_keys('AK-SELF', j6);
  IF k -> 'keys' <> '[]'::jsonb THEN RAISE EXCEPTION 'AK-SELF: the bill vouched for itself: %', k; END IF;
  k := public.materials_ai_hard_keys('AK-TWO', j6);
  IF k -> 'keys' <> '[]'::jsonb OR k -> 'evidence' ->> 'withheld' <> 'the supplier billed 2 live jobs within 180 days' THEN RAISE EXCEPTION 'AK-TWO: %', k; END IF;
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"AK-AIONLY","decision":"job","job_number":"SWF-29106","confidence":0.95,"reason":"Same lime as before.","evidence":["supplier"]}');
  IF v ->> 'outcome' <> 'held_for_check' THEN RAISE EXCEPTION 'AK-AIONLY apply: %', v; END IF;

  -- 6. No clue: the blind check still governs; a disagreeing check leaves it for a person.
  v := public.materials_ai_apply(c, 'test-model', '{"xero_invoice_id":"AK-NONE","decision":"job","job_number":"SWF-29101","confidence":0.97,"reason":"Screws near the job date.","evidence":["date"]}');
  IF v ->> 'outcome' <> 'held_for_check' OR v -> 'keys' <> '["ai_confidence"]'::jsonb THEN RAISE EXCEPTION 'AK-NONE apply: %', v; END IF;
  pid := (v ->> 'placement_id')::uuid;
  v := public.materials_ai_record_second_check(pid, '{"decision":"job","job_number":"SWP-29102","confidence":0.8,"reason":"For the patio.","model":"claude"}');
  SELECT * INTO r FROM public.materials_ai_placements WHERE id = pid;
  IF r.outcome <> 'left_for_person' OR r.second_check_status <> 'disagreed'
     OR EXISTS (SELECT 1 FROM public.job_materials_facts WHERE xero_invoice_id = 'AK-NONE') THEN
    RAISE EXCEPTION 'AK-NONE: % %', r.outcome, r.second_check_status;
  END IF;

  -- 7. job_number and purchase_order are 20261029093000's answers, and so is
  --    everything it withholds, on every bill and job here (the earlier
  --    supplier history is now the same_supplier key).
  FOR w IN SELECT x.xero_invoice_id AS bill, j.id AS job, j.job_number
             FROM public.xero_invoices x CROSS JOIN public.jobs j
            WHERE x.xero_invoice_id LIKE 'AK-%' AND j.id::text LIKE 'd7000000-%' LOOP
    k := public.materials_ai_hard_keys(w.bill, w.job);
    v := pg_temp.tp03_hard_keys(w.bill, w.job);
    IF (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements_text(k -> 'keys') e WHERE e NOT IN ('site_address', 'same_supplier'))
       IS DISTINCT FROM v -> 'keys'
       OR k -> 'evidence' -> 'job_number' IS DISTINCT FROM v -> 'evidence' -> 'job_number'
       OR k -> 'evidence' -> 'purchase_order' IS DISTINCT FROM v -> 'evidence' -> 'purchase_order'
       OR ((k -> 'keys') ? 'same_supplier') IS DISTINCT FROM (v -> 'evidence' ? 'supplier_history')
       OR (k -> 'evidence' ->> 'same_supplier') || ', not a key until TP-04' IS DISTINCT FROM v -> 'evidence' ->> 'supplier_history'
       OR (v -> 'evidence' ? 'withheld' AND strpos(COALESCE(k -> 'evidence' ->> 'withheld', ''), v -> 'evidence' ->> 'withheld') <> 1) THEN
      RAISE EXCEPTION 'address and supplier keys: % on % differs from 20261029093000: new % old %', w.bill, w.job_number, k, v;
    END IF;
    out_text := out_text || k::text;
  END LOOP;
  IF strpos(out_text, '"job_number"') = 0 OR strpos(out_text, '"purchase_order"') = 0 THEN
    RAISE EXCEPTION 'address and supplier keys: the comparison saw no job number or PO key';
  END IF;

  -- 8. No phone, email or amount in a key, its evidence, or an audit row's.
  out_text := out_text || COALESCE((SELECT string_agg(COALESCE(agreed_keys::text, '') || COALESCE(key_evidence::text, ''), ' ')
                                      FROM public.materials_ai_placements WHERE xero_invoice_id LIKE 'AK-%'), '')
                       || COALESCE((SELECT string_agg((detail_json -> 'key_evidence')::text, ' ') FROM public.job_events
                                     WHERE event_type = 'materials_bill_assigned' AND detail_json ->> 'xero_invoice_id' LIKE 'AK-%'), '');
  FOREACH bad IN ARRAY ARRAY['400555101', '400 555 101', '400555102', 'example.test', 'ak.one', '345.67', '301.11', '302.22',
    '303.33', '311.11', '312.12', '313.13', '100.01', '100.02', '316.16', '319.19', '320.20', '321.21', '$'] LOOP
    IF strpos(out_text, bad) > 0 THEN RAISE EXCEPTION 'address and supplier keys: leaks %', bad; END IF;
  END LOOP;
END $$;

-- 9. Service role only; read only; this migration's body and comment.
DO $$
DECLARE f text := 'public.materials_ai_hard_keys(text,uuid)';
BEGIN
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
     OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'address and supplier keys: grants';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = f::regprocedure) <> 's' THEN RAISE EXCEPTION 'address and supplier keys: must be STABLE'; END IF;
  IF coalesce(obj_description(f::regprocedure, 'pg_proc'), '') NOT LIKE 'AI bill two keys, address and supplier (20261029230000;%' THEN
    RAISE EXCEPTION 'address and supplier keys: comment';
  END IF;
END $$;

-- 10. A re-apply changes nothing.
\ir ../../../migrations/20261029230000_materials_ai_address_supplier_keys.sql
DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.materials_ai_hard_keys(text,uuid)'))
     IS DISTINCT FROM '5c842e65f177a9de4b42ccb4a3abd9f4'
     OR has_function_privilege('anon', 'public.materials_ai_hard_keys(text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'address and supplier keys: a re-apply moved something';
  END IF;
END $$;

-- 11. A later body is never overwritten or rolled back on its comment alone.
-- The drifted body keeps this migration's comment. A re-apply and the down
-- must both refuse it and leave it as it was.
SAVEPOINT drift_up;
CREATE OR REPLACE FUNCTION public.materials_ai_hard_keys(p_bill text, p_job_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $f$ SELECT jsonb_build_object('keys', '[]'::jsonb, 'evidence', '{}'::jsonb) $f$;
\set ON_ERROR_STOP off
\ir ../../../migrations/20261029230000_materials_ai_address_supplier_keys.sql
\set ON_ERROR_STOP on
\if :ERROR
ROLLBACK TO SAVEPOINT drift_up;
\else
DO $$ BEGIN RAISE EXCEPTION 'address and supplier keys: the up migration overwrote a drifted body whose comment was kept'; END $$;
\endif

SAVEPOINT drift_down;
CREATE OR REPLACE FUNCTION public.materials_ai_hard_keys(p_bill text, p_job_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $f$ SELECT jsonb_build_object('keys', '[]'::jsonb, 'evidence', '{}'::jsonb) $f$;
\set ON_ERROR_STOP off
\ir ../../../rollbacks/20261029230000_materials_ai_address_supplier_keys_down.sql
\set ON_ERROR_STOP on
\if :ERROR
ROLLBACK TO SAVEPOINT drift_down;
\else
DO $$ BEGIN RAISE EXCEPTION 'address and supplier keys: the down migration replaced a drifted body'; END $$;
\endif

DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.materials_ai_hard_keys(text,uuid)'))
     IS DISTINCT FROM '5c842e65f177a9de4b42ccb4a3abd9f4' THEN
    RAISE EXCEPTION 'address and supplier keys: a refused drift check left the function changed';
  END IF;
END $$;

ROLLBACK;
