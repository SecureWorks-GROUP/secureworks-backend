-- Contract for 20261029200000_context_job_picture.
--
-- Synthetic jobs, people and suppliers, no customer data. Everything rolls back.
--
--   TP-J1    fencing, scheduled. Two parties (one removed), a fence scope with
--            a base64 image, a checklist and a price key in the blob, one real
--            crew day and an earlier ghost watcher day.
--   TP-J2    patio, accepted. Patio scope with a price key, Materials by
--            supplier (two lines, one box), two purchase orders (one deleted),
--            its job work order, a Xero Project and two placed bills.
--   TP-ONE   do_not_schedule "1": a normal job (canonical rule).
--   TP-HOLD1 do_not_schedule "TRUE" and TP-HOLD2 "true": holding jobs.
--   TP-DEAD  cancelled.
--
-- Expected: the picture lists TP-J1, TP-J2 and TP-ONE only; every field the
-- schema holds is there; no phone, email, price, amount or scope blob leaves
-- the picture; the contact match answers yes or no only for keys asked; the
-- bill placer's candidates come from the picture with its eight old keys equal
-- to 20261028173000's body on the same data (every job in the stack).

\set ON_ERROR_STOP on

BEGIN;

-- 20261028173000's candidate body, byte for byte, to compare against.
CREATE FUNCTION pg_temp.old_candidates(p_from date, p_to date)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'job_id', j.id,
           'job_number', j.job_number,
           'type', j.type,
           'status', j.status,
           'client', left(j.client_name, 120),
           'site', left(concat_ws(', ', NULLIF(btrim(j.site_address), ''), NULLIF(btrim(j.site_suburb), '')), 200),
           'created', j.created_at::date,
           'scheduled', (SELECT min(a.scheduled_date) FROM public.job_assignments a
                          WHERE a.job_id = j.id AND COALESCE(a.status, '') <> 'cancelled'))) ORDER BY j.job_number), '[]'::jsonb)
    FROM public.jobs j
   WHERE j.job_number IS NOT NULL
     AND lower(COALESCE(j.status, '')) NOT IN ('cancelled', 'lost')
     AND lower(COALESCE(j.metadata ->> 'do_not_schedule', '')) <> 'true'
     -- Made before the bill (plus a week: a bill can arrive dated before the card)
     AND j.created_at < (COALESCE(p_to, current_date) + 7)
     -- and alive around it: made in the half year before it, or booked on site
     -- from two months before to four months after it, or still open today.
     -- updated_at is not used: any later touch moves it, so every finished job
     -- would read as alive and the list would hold the whole company.
     AND (j.created_at >= (COALESCE(p_from, current_date) - 180)
          OR EXISTS (SELECT 1 FROM public.job_assignments a
                      WHERE a.job_id = j.id AND COALESCE(a.status, '') <> 'cancelled'
                        AND a.scheduled_date BETWEEN (COALESCE(p_from, current_date) - 60) AND (COALESCE(p_to, current_date) + 120))
          OR lower(COALESCE(j.status, '')) NOT IN ('archived', 'complete', 'completed', 'invoiced', 'final_payment', 'get_review', 'draft'))
$$;

INSERT INTO public.users (id, org_id, name) VALUES
  ('c4000000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'Pic Crew Lead'),
  ('c4000000-0000-4000-8000-0000000000a2', '00000000-0000-0000-0000-000000000001', 'Pic Watcher');

INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, created_at,
                         client_name, client_phone, client_email, site_address, site_suburb, scope_json) VALUES
  ('c4000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', 'TP-J1', false, '{}', '{}',
   '2026-07-01T00:00:00Z', 'Pic Client One', '0400 111 222', 'one@example.test', '12 Sample Street', 'Testville',
   '{"job": {"runs": [{"length": 10.5, "price": 999.99}, {"totalLength": "4.5"}], "gates": [{"w": 1}, {"w": 2}],
             "colour": "Monument", "profile": "Neetascreen", "pricePerMetre": 987.65,
             "sitePlanImage": "data:image/png;base64,PICBLOBMARKERiVBORw0KGgo", "checklist": {"photo": "PICBLOBMARKER2"}},
     "pricing": {"total": 4321.09}}'),
  ('c4000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'accepted', 'patio', 'TP-J2', false, '{}', '{}',
   '2026-07-01T00:00:00Z', 'Pic Client Two', '0400 555 666', 'two@example.test', '7 Example Road', 'Sampleton',
   '{"config": {"length": 6, "projection": "4.2", "roofStyle": "Gable", "roofing": "Solarspan", "price": 12345.67,
                "colour": {"nested": "object is dropped"}}}'),
  ('c4000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'TP-ONE', false,
   '{"do_not_schedule": "1"}', '{}', '2026-07-01T00:00:00Z', NULL, NULL, NULL, NULL, NULL, '"not an object"'),
  ('c4000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'TP-HOLD1', false,
   '{"do_not_schedule": "TRUE"}', '{}', '2026-07-01T00:00:00Z', 'Holding', NULL, NULL, NULL, NULL, '{}'),
  ('c4000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'TP-HOLD2', false,
   '{"do_not_schedule": "true"}', '{}', '2026-07-01T00:00:00Z', 'Holding', NULL, NULL, NULL, NULL, '{}'),
  ('c4000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', 'cancelled', 'fencing', 'TP-DEAD', false,
   '{}', '{}', '2026-07-01T00:00:00Z', 'Dead', NULL, NULL, NULL, NULL, '{}');

-- An accepted patio job opens its job work order draft by trigger
-- (20261012130000); make sure TP-J2 has one either way.
INSERT INTO public.work_orders (org_id, job_id, wo_number, kind, status)
SELECT '00000000-0000-0000-0000-000000000001', 'c4000000-0000-4000-8000-000000000002', 'WO-PIC-2', 'job', 'draft'
 WHERE NOT EXISTS (SELECT 1 FROM public.work_orders WHERE job_id = 'c4000000-0000-4000-8000-000000000002' AND kind = 'job');

INSERT INTO public.job_contacts (job_id, client_name, client_phone, client_email, contact_label, status, removed_at) VALUES
  ('c4000000-0000-4000-8000-000000000001', 'Pic Neighbour Two', '0400-333-444', 'Neighbour@Example.test', 'B', 'active', NULL),
  ('c4000000-0000-4000-8000-000000000001', 'Pic Gone Three', '0400 777 888', 'gone@example.test', 'C', 'removed', '2026-07-05T00:00:00Z'),
  ('c4000000-0000-4000-8000-000000000001', 'pic client one', NULL, NULL, 'D', 'active', NULL);

INSERT INTO public.job_assignments (job_id, user_id, status, scheduled_date, scheduled_end, assignment_type, role, is_ghost) VALUES
  ('c4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-0000000000a1', 'scheduled', '2026-08-10', '2026-08-11', 'install', 'lead_installer', false),
  ('c4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-0000000000a2', 'scheduled', '2026-08-01', NULL, 'install', 'observer', true),
  ('c4000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-0000000000a1', 'cancelled', '2026-08-05', NULL, 'install', 'lead_installer', false);

INSERT INTO public.suppliers (id, name) VALUES ('c4000000-0000-4000-8000-0000000000b1', 'Pic Steel');
INSERT INTO public.job_material_suppliers (job_id, org_id, supplier_id, supplier_name, position, delivery_date, material_stage, is_main_supplier) VALUES
  ('c4000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'c4000000-0000-4000-8000-0000000000b1', 'Pic Steel', 1, '2026-08-20', 'order_confirmed', true);
INSERT INTO public.job_material_lines (id, org_id, job_id, supplier_id, description, quantity, unit, status, position) VALUES
  ('c4000000-0000-4000-8000-0000000000c1', '00000000-0000-0000-0000-000000000001', 'c4000000-0000-4000-8000-000000000002',
   'c4000000-0000-4000-8000-0000000000b1', 'Roof sheet 6.1m', 12, 'sheet', 'to_order', 1),
  ('c4000000-0000-4000-8000-0000000000c2', '00000000-0000-0000-0000-000000000001', 'c4000000-0000-4000-8000-000000000002',
   'c4000000-0000-4000-8000-0000000000b1', 'Post 90x90', 4, 'each', 'in_stock', 2);

INSERT INTO public.purchase_orders (org_id, job_id, po_number, supplier_name, status, subtotal, total, delivery_date, source, created_at) VALUES
  ('00000000-0000-0000-0000-000000000001', 'c4000000-0000-4000-8000-000000000002', 'PO-PIC-1', 'Pic Steel', 'authorised', 777.77, 855.55, '2026-08-19', 'dispatch', '2026-08-01T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'c4000000-0000-4000-8000-000000000002', 'PO-PIC-DEL', 'Pic Steel', 'deleted', 111.11, 122.22, NULL, NULL, '2026-08-02T00:00:00Z');

INSERT INTO public.xero_projects (job_id, project_name, status, total_invoiced, total_expenses) VALUES
  ('c4000000-0000-4000-8000-000000000002', 'TP-J2 7 Example Road', 'INPROGRESS', 6543.21, 2345.67);

INSERT INTO public.job_materials_facts (xero_invoice_id, job_id, job_number, contact_name, xero_contact_id, lane, kind, amount_ex_gst, confidence, automation_source, fact_date) VALUES
  ('PIC-B1', 'c4000000-0000-4000-8000-000000000002', 'TP-J2', 'Pic Steel', 'XC-PIC', 'materials', 'actual', 1500.01, 'high', 'xero_ref_link', '2026-08-15'),
  ('PIC-B2', 'c4000000-0000-4000-8000-000000000002', 'TP-J2', 'Pic Steel', 'XC-PIC', 'materials', 'actual', 250.02, 'high', 'agent_ai', '2026-08-18');

DO $$
DECLARE
  ids uuid[] := ARRAY['c4000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000002',
                      'c4000000-0000-4000-8000-000000000003', 'c4000000-0000-4000-8000-000000000004',
                      'c4000000-0000-4000-8000-000000000005', 'c4000000-0000-4000-8000-000000000006']::uuid[];
  pic jsonb;
  j1 jsonb;
  j2 jsonb;
  one jsonb;
  got text[];
  txt text;
  bad text;
  old_c jsonb;
  new_c jsonb;
  shared text[] := ARRAY['job_id', 'job_number', 'type', 'status', 'client', 'site', 'created', 'scheduled'];
  extra text[];
  w record;
BEGIN
  -- 1. Live set: the canonical holding rule ("TRUE" and "true" out, "1" in),
  --    cancelled out.
  pic := public.context_job_picture(ids);
  SELECT array_agg(e ->> 'job_number' ORDER BY e ->> 'job_number') INTO got FROM jsonb_array_elements(pic) e;
  IF got IS DISTINCT FROM ARRAY['TP-J1', 'TP-J2', 'TP-ONE'] THEN RAISE EXCEPTION 'job picture: live set %', got; END IF;
  IF jsonb_array_length(public.context_job_picture(NULL)) <> 0 OR jsonb_array_length(public.context_job_picture('{}')) <> 0 THEN
    RAISE EXCEPTION 'job picture: no ids must give an empty picture';
  END IF;

  -- 2. Nothing private or priced leaves it: no phone, email, price, amount or
  --    scope blob, in any job, with or without contact keys asked.
  txt := public.context_job_picture(ids, ARRAY['+61 400 111 222'], ARRAY['neighbour@example.test'])::text || pic::text;
  FOREACH bad IN ARRAY ARRAY['400111222', '400 111 222', '400333444', '0400-333-444', '400777888', 'one@example.test',
    'example.test', 'PICBLOBMARKER', 'base64', 'pricePerMetre', '987.65', '999.99', '4321.09', '12345.67', '777.77', '855.55',
    '6543.21', '2345.67', '1500.01', '250.02', '"scope_json"', '"price"', '"total"', '"subtotal"', '"amount', 'Pic Gone Three',
    'checklist', 'sitePlanImage', 'object is dropped'] LOOP
    IF strpos(txt, bad) > 0 THEN RAISE EXCEPTION 'job picture: leaks %', bad; END IF;
  END LOOP;

  -- 3. TP-J1: names, contact counts and matches, site keys, fence scope, crew.
  SELECT e INTO j1 FROM jsonb_array_elements(public.context_job_picture(ids, ARRAY['+61 400 111 222', '1234'], NULL)) e
   WHERE e ->> 'job_number' = 'TP-J1';
  IF j1 -> 'client_names' IS DISTINCT FROM '["Pic Client One", "Pic Neighbour Two"]'::jsonb THEN
    RAISE EXCEPTION 'job picture: TP-J1 names %', j1 -> 'client_names';
  END IF;
  IF j1 -> 'contacts' IS DISTINCT FROM '{"phones": 2, "emails": 2, "phone_match": true}'::jsonb THEN
    RAISE EXCEPTION 'job picture: TP-J1 contacts %', j1 -> 'contacts';
  END IF;
  IF j1 ->> 'site_key' IS DISTINCT FROM public.context_address_key('12 Sample Street')
     OR j1 ->> 'site_key' IS DISTINCT FROM '12 sample st'
     OR j1 -> 'site_loose_keys' IS DISTINCT FROM to_jsonb(public.context_address_loose_keys('12 Sample Street'))
     OR j1 ->> 'suburb' IS DISTINCT FROM 'Testville'
     OR j1 ->> 'site' IS DISTINCT FROM '12 Sample Street, Testville' THEN
    RAISE EXCEPTION 'job picture: TP-J1 site % % % %', j1 ->> 'site_key', j1 -> 'site_loose_keys', j1 ->> 'suburb', j1 ->> 'site';
  END IF;
  IF j1 -> 'scope' IS DISTINCT FROM '{"fence": {"metres": 15.00, "runs": 2, "gates": 2, "colour": "Monument", "profile": "Neetascreen"}}'::jsonb THEN
    RAISE EXCEPTION 'job picture: TP-J1 scope %', j1 -> 'scope';
  END IF;
  -- Real crew only (the ghost watcher row is not crew); scheduled keeps the
  -- bill reader's old rule (any assignment not cancelled).
  IF j1 -> 'crew' IS DISTINCT FROM '[{"day": "2026-08-10", "end": "2026-08-11", "type": "install", "crew": "Pic Crew Lead", "status": "scheduled"}]'::jsonb
     OR j1 -> 'on_site' IS DISTINCT FROM '{"first": "2026-08-10", "last": "2026-08-11"}'::jsonb
     OR j1 ->> 'scheduled' IS DISTINCT FROM '2026-08-01' THEN
    RAISE EXCEPTION 'job picture: TP-J1 crew % % %', j1 -> 'crew', j1 -> 'on_site', j1 ->> 'scheduled';
  END IF;
  IF j1 ? 'materials' OR j1 ? 'purchase_orders' OR j1 ? 'xero_projects' OR j1 ? 'suppliers_billed' OR j1 ? 'supplier_orders' THEN
    RAISE EXCEPTION 'job picture: TP-J1 has lists it should not: %', j1;
  END IF;
  -- An email asked of no job: a plain no, never a guess.
  SELECT e INTO j1 FROM jsonb_array_elements(public.context_job_picture(ids, NULL, ARRAY['Pic Neighbour <NEIGHBOUR@example.test>'])) e
   WHERE e ->> 'job_number' = 'TP-J1';
  IF j1 -> 'contacts' IS DISTINCT FROM '{"phones": 2, "emails": 2, "email_match": true}'::jsonb THEN
    RAISE EXCEPTION 'job picture: TP-J1 email match %', j1 -> 'contacts';
  END IF;

  -- 4. TP-J2: patio scope, materials, supplier box, POs, work order, Xero
  --    Project, suppliers billed.
  SELECT e INTO j2 FROM jsonb_array_elements(public.context_job_picture(ids, ARRAY['+61 400 111 222'], NULL)) e
   WHERE e ->> 'job_number' = 'TP-J2';
  IF j2 -> 'contacts' IS DISTINCT FROM '{"phones": 1, "emails": 1, "phone_match": false}'::jsonb THEN
    RAISE EXCEPTION 'job picture: TP-J2 contacts %', j2 -> 'contacts';
  END IF;
  IF j2 -> 'scope' IS DISTINCT FROM '{"patio": {"length": "6", "projection": "4.2", "roof_style": "Gable", "roofing": "Solarspan"}}'::jsonb THEN
    RAISE EXCEPTION 'job picture: TP-J2 scope %', j2 -> 'scope';
  END IF;
  IF j2 -> 'materials' IS DISTINCT FROM '[{"item": "Roof sheet 6.1m", "quantity": 12.000, "unit": "sheet", "status": "to_order", "supplier": "Pic Steel"},
                                          {"item": "Post 90x90", "quantity": 4.000, "unit": "each", "status": "in_stock", "supplier": "Pic Steel"}]'::jsonb THEN
    RAISE EXCEPTION 'job picture: TP-J2 materials %', j2 -> 'materials';
  END IF;
  IF j2 -> 'supplier_orders' IS DISTINCT FROM '[{"supplier": "Pic Steel", "stage": "order_confirmed", "delivery": "2026-08-20", "main": true}]'::jsonb THEN
    RAISE EXCEPTION 'job picture: TP-J2 supplier orders %', j2 -> 'supplier_orders';
  END IF;
  IF j2 -> 'purchase_orders' IS DISTINCT FROM '[{"po_number": "PO-PIC-1", "supplier": "Pic Steel", "status": "authorised", "delivery": "2026-08-19", "source": "dispatch"}]'::jsonb THEN
    RAISE EXCEPTION 'job picture: TP-J2 purchase orders %', j2 -> 'purchase_orders';
  END IF;
  SELECT wo_number, status INTO w FROM public.work_orders WHERE job_id = 'c4000000-0000-4000-8000-000000000002' AND kind = 'job';
  IF w.wo_number IS NULL OR j2 -> 'work_order' IS DISTINCT FROM jsonb_build_object('number', w.wo_number, 'status', w.status) THEN
    RAISE EXCEPTION 'job picture: TP-J2 work order % (table %)', j2 -> 'work_order', w;
  END IF;
  IF j2 -> 'xero_projects' IS DISTINCT FROM '[{"name": "TP-J2 7 Example Road", "status": "INPROGRESS", "own": true}]'::jsonb THEN
    RAISE EXCEPTION 'job picture: TP-J2 Xero Projects %', j2 -> 'xero_projects';
  END IF;
  IF j2 -> 'suppliers_billed' IS DISTINCT FROM '[{"supplier": "Pic Steel", "xero_contact_id": "XC-PIC", "bills": 2, "by_ai": 1, "last": "2026-08-18"}]'::jsonb THEN
    RAISE EXCEPTION 'job picture: TP-J2 suppliers billed %', j2 -> 'suppliers_billed';
  END IF;
  IF j2 ? 'crew' OR j2 ? 'on_site' OR j2 ? 'scheduled' THEN
    RAISE EXCEPTION 'job picture: TP-J2 cancelled crew counted: %', j2;
  END IF;

  -- 5. TP-ONE: a normal job flagged "1", with nothing but its core; a scope
  --    that is not an object gives no scope. (site is "" when the job has no
  --    address, as the bill reader always gave it.)
  SELECT e INTO one FROM jsonb_array_elements(pic) e WHERE e ->> 'job_number' = 'TP-ONE';
  IF one - 'job_id' IS DISTINCT FROM '{"job_number": "TP-ONE", "type": "fencing", "status": "quoted", "site": "", "created": "2026-07-01", "contacts": {"phones": 0, "emails": 0}}'::jsonb THEN
    RAISE EXCEPTION 'job picture: TP-ONE %', one;
  END IF;

  -- 6. The bill placer reads the picture: the same jobs in the same order,
  --    its eight old keys equal to 20261028173000's body on every job in the
  --    stack, and the picture's fields beside them.
  old_c := pg_temp.old_candidates('2026-08-21', '2026-08-23');
  new_c := public.materials_ai_candidate_jobs('2026-08-21', '2026-08-23');
  IF jsonb_array_length(old_c) < 4 THEN RAISE EXCEPTION 'job picture: parity fixture too small %', jsonb_array_length(old_c); END IF;
  IF (SELECT jsonb_agg((SELECT jsonb_object_agg(k.key, k.value) FROM jsonb_each(e) k WHERE k.key = ANY (shared)) ORDER BY ord)
        FROM jsonb_array_elements(new_c) WITH ORDINALITY t(e, ord)) IS DISTINCT FROM old_c THEN
    RAISE EXCEPTION 'job picture: candidate parity old % new %', old_c, new_c;
  END IF;
  SELECT array_agg(e ->> 'job_number' ORDER BY e ->> 'job_number') INTO got
    FROM jsonb_array_elements(new_c) e WHERE e ->> 'job_number' LIKE 'TP-%';
  IF got IS DISTINCT FROM ARRAY['TP-J1', 'TP-J2', 'TP-ONE'] THEN RAISE EXCEPTION 'job picture: candidates %', got; END IF;
  SELECT e INTO j2 FROM jsonb_array_elements(new_c) e WHERE e ->> 'job_number' = 'TP-J2';
  SELECT array_agg(k ORDER BY k) INTO extra FROM jsonb_object_keys(j2) k WHERE NOT k = ANY (shared);
  IF extra IS DISTINCT FROM ARRAY['client_names', 'contacts', 'materials', 'purchase_orders', 'scope', 'site_key', 'site_loose_keys',
                                  'suburb', 'supplier_orders', 'suppliers_billed', 'work_order', 'xero_projects'] THEN
    RAISE EXCEPTION 'job picture: candidate extra keys %', extra;
  END IF;
  IF strpos(new_c::text, '400111222') > 0 OR strpos(new_c::text, 'PICBLOBMARKER') > 0 OR strpos(new_c::text, '777.77') > 0 THEN
    RAISE EXCEPTION 'job picture: candidates leak';
  END IF;
  -- No contact keys are asked by the bill placer, so no match is claimed.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(new_c) e WHERE e -> 'contacts' ?| ARRAY['phone_match', 'email_match']) THEN
    RAISE EXCEPTION 'job picture: candidates claim a contact match';
  END IF;
END $$;

-- 7. Service role only; read only.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.context_job_picture(uuid[],text[],text[])', 'public.materials_ai_candidate_jobs(date,date)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'job picture: grants on %', f;
    END IF;
  END LOOP;
  IF NOT (SELECT prosecdef AND provolatile = 's' FROM pg_proc WHERE oid = 'public.context_job_picture(uuid[],text[],text[])'::regprocedure) THEN
    RAISE EXCEPTION 'job picture: must be STABLE SECURITY DEFINER';
  END IF;
END $$;

ROLLBACK;
