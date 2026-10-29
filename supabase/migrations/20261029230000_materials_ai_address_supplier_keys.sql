-- Two keys, the address and supplier clues (TP-03 with TP-04's job picture),
-- 29 Oct 2026. Plan: 08-path-to-trusted-profit §4A-2. Follows 20261029093000
-- (TP-03, #1201: job_number and purchase_order) and 20261029200000 (TP-04's
-- context_job_picture, #1211: site_key and suppliers_billed).
--
-- materials_ai_hard_keys(bill, job) gains two hard clues. Nothing else in the
-- two-keys path changes: materials_ai_apply, the hold for the blind second
-- check, the second check itself, the batch, the status and the view keep
-- 20261029093000's bodies; every one of them reads the keys from this
-- function. A bill above the bar with any hard clue is placed, and its audit
-- row (agreed_keys, key_evidence) and job event name the keys; with none it is
-- still held until the blind second check agrees.
--   site_address    the job's exact B0 address key (context_address_key of
--                   jobs.site_address, which is the picture's site_key) is the
--                   exact key of an address written in the bill's reference
--                   or a line (context_address_mentions, the one address
--                   rule; no second normaliser). A loose match never counts
--                   (AGENTS.md: a loose match never places a row): it is kept
--                   in key_evidence.withheld. No key when another live job has
--                   the same exact site address, or the bill also writes
--                   another live job's exact site address.
--   same_supplier   the name 20261029093000 reserved in agreed_keys. The
--                   bill's own Xero contact has a bill on this job that is
--                   live in Xero (AUTHORISED or PAID, never voided or
--                   deleted), placed by a person or a rule within 180 days,
--                   not this bill, and the supplier billed no other live job
--                   in that window. Until now this was recorded as
--                   key_evidence.supplier_history only; it is now the key's
--                   own evidence (key_evidence.same_supplier).
-- Self-reinforcement: a bill the AI reader placed (automation_source
-- agent_ai), whether or not a second check agreed, never vouches for a later
-- bill. Only person (manual_queue, manual_split) and rule (xero_ref_link,
-- po_deterministic, agent_prematch) placements count, as 20261029093000 had
-- it; the AI's own placements still count against the supplier when it billed
-- another live job.
-- Rule 0 (another job's number or purchase order on the bill gives no key at
-- all), the holding and dead job refusals, and the job_number and
-- purchase_order clues are byte for byte 20261029093000's.
--
-- The new key evidence carries a normalised address key, an invoice number and
-- a placement source; never a phone, an email or an amount.
--
-- The key name same_supplier replaces the recorded-only supplier_history:
-- -- output-key-guard: drop public.materials_ai_hard_keys supplier_history
--
-- Order: roll this migration back before 20261029093000's down (that down
-- drops materials_ai_hard_keys whatever its body). A re-apply of
-- 20261029093000 refuses while this body is live, because this body's comment
-- no longer starts with that migration's.
--
-- Columns were checked against the migrations in this repository, not the live
-- schema. The version was checked against this branch's supabase/migrations
-- only, not the live ledger.
--
-- Rollback: supabase/rollbacks/20261029230000_materials_ai_address_supplier_keys_down.sql

-- ─────────────────────────────────────────────────────────────
-- 0. Guard: read the live definitions before replacing them. Reports every
--    problem at once.
-- ─────────────────────────────────────────────────────────────
DO $guard$
DECLARE problems text[] := '{}'; live text; f text; t text;
BEGIN
 -- The replaced body: 20261029093000's, or this migration's (a re-apply).
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.materials_ai_hard_keys(text,uuid)');
 IF live IS NULL OR live NOT IN ('2ef85da40004fb45adc42ea2488e8947', '5c842e65f177a9de4b42ccb4a3abd9f4') THEN
  problems := problems || format('%s md5 %s', 'public.materials_ai_hard_keys(text,uuid)', coalesce(live, '<missing>'));
 END IF;
 -- Read, never replaced: the B0 address rule.
 FOREACH f IN ARRAY ARRAY['public.context_address_key(text)', 'public.context_address_loose_keys(text)',
   'public.context_address_mentions(text)'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['jobs.site_address', 'jobs.job_number', 'jobs.status', 'jobs.metadata',
   'job_materials_facts.xero_contact_id', 'job_materials_facts.automation_source', 'job_materials_facts.fact_date',
   'materials_reconciliation_queue.xero_contact_id', 'materials_ai_placements.agreed_keys'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || split_part(t, '.', 1))
    AND a.attname = split_part(t, '.', 2) AND NOT a.attisdropped) THEN
   problems := problems || format('public.%s missing', t);
  END IF;
 END LOOP;
 -- The key names this body writes are the ones 20261029093000 reserved.
 SELECT pg_get_constraintdef(c.oid) INTO live FROM pg_constraint c
  WHERE c.conrelid = to_regclass('public.materials_ai_placements') AND c.conname = 'materials_ai_placements_keys_chk';
 IF live IS NULL OR live NOT LIKE '%site_address%' OR live NOT LIKE '%same_supplier%' THEN
  problems := problems || format('materials_ai_placements keys check %s', coalesce(live, '<missing>'));
 END IF;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'materials_ai_address_supplier_keys_preimage_mismatch: %; read the live definitions before replacing them',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- ─────────────────────────────────────────────────────────────
-- 1. The hard clues for one bill and one job (read only)
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
  v_site text;
  v_places jsonb;
  v_exact text[];
  v_loose text[];
  v_addr_jobs text[];
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

  -- 3. The job's site address on the bill (20261029230000, TP-04's picture):
  --    the job's exact B0 address key (context_address_key of its site
  --    address, the picture's site_key) among the exact keys of the addresses
  --    written in the bill's reference or a line (context_address_mentions,
  --    read one place at a time so a line break never joins two addresses).
  --    Only an exact key is a key. A loose match (the street number and name
  --    without the type word, or a site address with no type word, which has
  --    no exact key) is recorded in withheld and never places a bill. No key
  --    either when another live job has the same exact site address, or the
  --    bill also writes another live job's exact site address.
  v_site := public.context_address_key(v_job.site_address);
  SELECT jsonb_agg(jsonb_build_object('place', t.place, 'exact', t.exact, 'loose', t.loose) ORDER BY t.n)
    INTO v_places
    FROM (SELECT p.place, p.n,
                 to_jsonb(ARRAY(SELECT DISTINCT m.address_key FROM public.context_address_mentions(p.body) m
                                 WHERE m.address_key IS NOT NULL ORDER BY 1)) AS exact,
                 to_jsonb(ARRAY(SELECT DISTINCT k FROM public.context_address_mentions(p.body) m, unnest(m.loose_keys) k
                                 ORDER BY 1)) AS loose
            FROM (SELECT 'reference'::text AS place, v_ref AS body, 0 AS n
                  UNION ALL
                  SELECT 'line ' || li.n, li.value ->> 'Description', li.n::int
                    FROM jsonb_array_elements(v_lines) WITH ORDINALITY li(value, n)) p
           WHERE NULLIF(btrim(p.body), '') IS NOT NULL) t;
  v_places := COALESCE(v_places, '[]'::jsonb);
  SELECT array_agg(DISTINCT e.k ORDER BY e.k) INTO v_exact
    FROM jsonb_array_elements(v_places) pl, jsonb_array_elements_text(pl.value -> 'exact') e(k);
  v_hit := NULL;
  IF v_site IS NOT NULL AND v_site = ANY (COALESCE(v_exact, '{}'::text[])) THEN
    SELECT pl.value ->> 'place' INTO v_hit
      FROM jsonb_array_elements(v_places) WITH ORDINALITY pl(value, n)
     WHERE (pl.value -> 'exact') ? v_site
     ORDER BY pl.n
     LIMIT 1;
    -- Every live job (a job number, not cancelled or lost, not a holding job:
    -- the picture's live set) other than this one whose exact site key the
    -- bill writes. The B0 key itself is compared over the whole live set;
    -- nothing narrows the read on the raw text first. B0 drops apostrophes
    -- and turns any other punctuation into a space before it keys an
    -- address ("14 O'Connor Street" and "14 OConnor St" share
    -- "14 oconnor st"; "1'4" keys as "14"), so no substring of the raw site
    -- address is provably kept by the key, and a raw-text prefilter can drop
    -- a job whose key is equal. There is no index on context_address_key
    -- either: it is revoked from the API roles and index upkeep runs as the
    -- writing role, so such an index would make every jobs write fail.
    SELECT array_agg(DISTINCT j.job_number COLLATE "C" ORDER BY j.job_number COLLATE "C") INTO v_addr_jobs
      FROM public.jobs j
     WHERE j.id <> v_job.id
       AND j.job_number IS NOT NULL
       AND lower(COALESCE(j.status, '')) NOT IN ('cancelled', 'lost')
       AND lower(COALESCE(j.metadata ->> 'do_not_schedule', '')) <> 'true'
       AND public.context_address_key(j.site_address) = ANY (v_exact);
    IF v_addr_jobs IS NULL THEN
      v_keys := v_keys || 'site_address'::text;
      v_ev := v_ev || jsonb_build_object('site_address', v_site || ' in ' || v_hit);
    ELSE
      v_withheld := v_withheld || ('the site address on the bill is also the site of ' || array_to_string(v_addr_jobs, ', ')
                                   || ' or the bill names its site too');
    END IF;
  ELSE
    v_loose := COALESCE(public.context_address_loose_keys(v_job.site_address), '{}'::text[]);
    SELECT pl.value ->> 'place' INTO v_hit
      FROM jsonb_array_elements(v_places) WITH ORDINALITY pl(value, n)
     WHERE (pl.value -> 'loose') ?| v_loose
     ORDER BY pl.n
     LIMIT 1;
    IF v_hit IS NOT NULL THEN
      v_withheld := v_withheld || ('the site address is on the bill only loosely (' || v_hit || ')');
    END IF;
  END IF;

  -- 4. The same supplier already billed to this job (20261029230000; the
  --    picture's suppliers_billed, read from its source with the rules the
  --    recorded clue already had). The bill's own Xero contact has a live bill
  --    on this job (AUTHORISED or PAID in Xero, so never a voided or deleted
  --    one) that a person or a rule placed within 180 days of this bill, never
  --    this bill itself and never one the AI placed (checked or not: the AI
  --    vouching for itself), and within those 180 days the supplier billed no
  --    other live job (every placed bill counts there, the AI's too).
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
      v_keys := v_keys || 'same_supplier'::text;
      v_ev := v_ev || jsonb_build_object('same_supplier', v_hit);
    END IF;
  END IF;

  IF cardinality(v_withheld) > 0 THEN
    v_ev := v_ev || jsonb_build_object('withheld', array_to_string(v_withheld, '; '));
  END IF;
  RETURN jsonb_build_object('keys', to_jsonb(v_keys), 'evidence', v_ev);
END;
$$;

COMMENT ON FUNCTION public.materials_ai_hard_keys(text, uuid) IS
  'AI bill two keys, address and supplier (20261029230000; from 20261029093000): the hard clues on one bill that agree with one job: {keys: [job_number, purchase_order, site_address, same_supplier], evidence: {key: what it saw, withheld: why a key was not given}}. No key at all for a holding or dead job, or when the bill also names another job number or another job''s purchase order. job_number and purchase_order as 20261029093000. site_address: the job''s exact B0 address key (context_address_key, the job picture''s site_key) written in the bill''s reference or a line; a loose match is withheld, never a key; no key when another live job has that address or the bill writes another live job''s address. same_supplier: the bill''s own Xero contact has a bill on this job live in Xero, placed by a person or a rule (never the AI) within 180 days, not this bill, and the supplier billed no other live job in the window. No phone, email or amount. Read only. Used by materials_ai_apply and v_materials_ai_placed_without_key. Service role only.';
REVOKE ALL ON FUNCTION public.materials_ai_hard_keys(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materials_ai_hard_keys(text, uuid) TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 2. Say so where 20261029093000 said these were not keys yet
-- ─────────────────────────────────────────────────────────────
COMMENT ON COLUMN public.materials_ai_placements.agreed_keys IS
  'TP-03 (20261029093000; site_address and same_supplier from 20261029230000): the keys that agreed on this decision. ai_confidence (the AI above the bar), then the hard clues that agreed with the chosen job (job_number, purchase_order, site_address, same_supplier; xero_project reserved for TP-09), then second_check when the blind second model agreed before the bill was placed. NULL on rows written before 20261029093000.';
COMMENT ON COLUMN public.materials_ai_placements.key_evidence IS
  'TP-03 (20261029093000; site_address and same_supplier from 20261029230000): what each hard clue saw, by key (where the job number was written, which PO, the exact site address key and where, the earlier person or rule placement of the same supplier), and withheld: why a clue gave no key (the bill also names another job, a holding job, digits another job shares, a digits-only PO number, a supplier on several jobs, a site address only loosely on the bill or shared with another job). Rows written between 20261029093000 and 20261029230000 may carry supplier_history, recorded only.';
COMMENT ON VIEW public.v_materials_ai_placed_without_key IS
  'AI bill two keys (20261029093000; keys widened by 20261029230000): bills the AI placed on a job that are still placed, with no hard clue agreeing with that job (job number, PO, exact site address or the same supplier, read now with materials_ai_hard_keys) and no agreeing second check. They were placed live before TP-03 on the AI''s confidence alone; this migration does not move them. second_check_status shows whether a check is due, disagreed, or was never asked for. A person decides each (Undo in Bills to place). Read only, service role only.';
