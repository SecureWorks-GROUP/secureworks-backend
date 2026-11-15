-- Place the September-to-now bill list Marnin approved (group A of
-- job-costing/sep-reconcile/bills.csv: 42 single placements and one split, $14,307.39 ex GST of
-- the job's share). Each bill carries hard evidence (its job number, the site address, or the
-- supplier's order reference) and was checked against production on 16 Nov 2026: queue row
-- open, no materials fact, not a trade app mirror, amount unchanged.
--
-- This writes what Bills to place writes when a person presses Assign (ops-api
-- materials_recon_assign, assignReconRow in materials_recon.ts): one job_materials_facts row
-- (source manual_queue, confidence high_manual), the queue row flipped to assigned, and a
-- materials_bill_assigned job event. The split goes through the same database function the
-- Split button uses (allocate_bill_split). The person is Marnin, by his written yes.
--
-- A bill is skipped, never forced, when anything has moved since the list was made: the queue
-- row is gone or not open, a fact already exists, the amount differs, it became a trade app
-- mirror, it is not approved or paid in Xero, or the job is missing, cancelled, lost or a holding
-- job. Each skip is raised as a NOTICE with its reason, and nothing else is changed for it.
-- Installer bills (accounts 306 and 301) land in the labour lane, as assignReconRow does.
-- Rollback: 20261116003000_sep_reconcile_placements.rollback.sql removes exactly the rows this
-- writes (facts and events stamped with this migration's actor) and reopens their queue rows.

DO $placements$
DECLARE
  c_actor CONSTANT text := 'marnin (approved list, migration 20261116003000)';
  c_now CONSTANT timestamptz := now();
  r record;
  q public.materials_reconciliation_queue%ROWTYPE;
  j record;
  x record;
  v_lane text;
  v_fact_id uuid;
  v_skip text;
  v_placed int := 0;
  v_skipped int := 0;
  v_j1 uuid;
  v_j2 uuid;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
    ('49a7466e-f1ec-41ef-acaa-0af6471694e3', 'SWP-26320', 284.85, '1046473'),
    ('fe33b791-556b-4ee0-8f8f-6c4f61dca31a', 'SWP-26941', 58.67, '2445/01224765'),
    ('ed6b5449-284b-47f6-915f-0f5584710ed3', 'SWP-261160', 2379.71, 'INV10843'),
    ('a0ef6c13-a1e9-4c74-85cd-216d994c36ae', 'SWP-261043', 40.97, '2435/01335472'),
    ('d63052a0-bbb9-45ea-83ab-c29d943c13a0', 'SWP-261336', 40.57, '2443/00165537'),
    ('08ca3a19-2a23-4735-bcf8-2f1aac08e517', 'SWMS-261441', 543.1, 'W2SO0091876'),
    ('787f150b-17c6-463c-8400-e0071b897efc', 'SWMS-261516', 74.38, '2016/90058205'),
    ('9b3d2fb7-a598-43f2-9fdb-675b768fc9d0', 'SWP-261160', 235.12, '2435/01558058'),
    ('06dc37c6-7b6c-4822-b9e7-91ec1d7f9cb1', 'SWF-261240', 163.18, '2206/90345729'),
    ('971fee47-2e4c-4da0-b92d-3575fed1a448', 'SWP-26195', 115.5, '2435/01424059'),
    ('5c7f1080-03a9-4f69-843d-6e22a0791ac0', 'SWF-26545', 123.78, '2170/91023124'),
    ('4c60a83f-ae86-4eef-84ae-20b2c4cffbb2', 'SWF-26545', 41.8, '2170/00108105'),
    ('1be5e908-d147-4379-baeb-407f46964d36', 'SWR-261572', 128.18, '2435/90371024'),
    ('a01e9d1e-86b5-437b-acbd-90242f9e59f8', 'SWF-261397', 20.69, '2435/00194158'),
    ('5e367bbb-9dfc-4dfc-8ee6-8c1cdad2bd6d', 'SWR-261570', 831.25, '2442/90059445'),
    ('e16df0b6-4e6d-4621-b439-ecabf1c45c24', 'SWF-261308', 221.82, '2437/00599659'),
    ('bf80a934-7587-4971-8d17-5d7c41a096a7', 'SWF-26101', 62.89, '2443/01442847'),
    ('9551a2fa-2a3a-451d-b90e-ff9ba9b44ff0', 'SWR-261570', 150.67, '2442/90059464'),
    ('b3188613-df62-4f6e-8e2b-11de47fa98b5', 'SWF-261246', 65.67, '2010/01537975'),
    ('fa888bb7-b299-4ec0-9c8b-f2ba275a8442', 'SWF-261423', 23.1, '2010/01538945'),
    ('62c4de6d-8e9e-4380-8aa8-438145888534', 'SWP-261283', 429.21, '2016/01524656'),
    ('063b68a0-7778-4dcc-b930-ebcdd854a659', 'SWF-261500', 84.48, '2443/01393121'),
    ('aeb50c6a-5775-407f-bbf2-c32c32d30161', 'SWMS-261163', 17.19, '2707/90054688'),
    ('62a23214-27d4-4469-89af-6558fea1ab85', 'SWF-261359', 42.6, '2443/01250957'),
    ('f65365ac-a0d0-44fd-9b1a-30ca2eb9d0a3', 'SWF-261502', 39.4, '2435/01361846'),
    ('0a63229b-34d0-402f-a637-9e19361746b1', 'SWF-261359', 51.04, '2443/00115652'),
    ('95cdb1ea-3b70-4650-986c-d8c5f0d0b546', 'SWF-261359', 23.1, '2443/01450072'),
    ('0ead6ea7-9181-452a-8b37-470262f5f311', 'SWP-26344', 182.65, '202663392'),
    ('a7a530a5-51bb-4ba9-9c8f-8844f3e3a6dd', 'SWF-261387', 327.27, '1977'),
    ('c8d90b4a-62ad-4923-8731-f69dfb1cc277', 'SWF-261562', 343.32, '10095363'),
    ('3a94e05f-7b95-4859-9189-f303a5294561', 'SWF-261590', 1221.45, '13438'),
    ('20047a6a-a0f1-4f2a-b52b-69e80ee9f871', 'SWM-261607', 141.82, 'Inv 91801'),
    ('7e71613f-2d15-4eb8-80c0-57bea36588a2', 'SWP-261248', 166.05, '805048 SPP PTYRYZMOB'),
    ('2584c8ce-e1ac-4c38-bc67-491e8c23302c', 'SWP-261382', 445.44, '2883677'),
    ('64471af4-d037-49c7-8093-f6e3a2a3e8ed', 'SWP-261349', 182.65, '215561'),
    ('79cc00b0-219c-4319-89bd-051cbc090c22', 'SWP-261376', 120.00, 'Inv 9882'),
    ('73495f54-8f14-4eaf-97f0-97cedfa93c1f', 'SWF-261501', 2622.73, 'Inv 91485'),
    ('48dd66ca-5e55-4d52-bcfc-1997413b26e3', 'SWF-261372', 72.27, 'INV 91584'),
    ('7907cc63-3836-43d7-8322-468e3bc1f235', 'SWP-26183', 500.00, '202609'),
    ('285340a1-c2f0-4217-9b62-8d2e33354e9e', 'SWP-26102', 400.00, '26013'),
    ('41fa878f-2fd4-4f46-9de4-f1c90ed5bec7', 'SWP-26183', 581.82, '26012'),
    ('7ae313c9-86fd-4aa6-aab2-28749699f286', 'SWP-26031', 540.00, 'INV-8667')
    ) AS a(xero_invoice_id, job_number, amount_ex, invoice_number)
  LOOP
    v_skip := NULL;
    SELECT * INTO q FROM public.materials_reconciliation_queue
     WHERE xero_invoice_id = r.xero_invoice_id
     ORDER BY created_at
     LIMIT 1
     FOR UPDATE;
    IF NOT FOUND THEN
      v_skip := 'not in Bills to place';
    ELSIF q.status IS DISTINCT FROM 'open' THEN
      v_skip := 'queue row is ' || COALESCE(q.status, 'null');
    ELSIF q.sub_total IS NULL OR round(q.sub_total::numeric, 2) <> round(r.amount_ex::numeric, 2) THEN
      v_skip := 'amount is ' || COALESCE(q.sub_total::text, 'unknown') || ', the list says ' || r.amount_ex::text;
    ELSIF EXISTS (SELECT 1 FROM public.job_materials_facts f WHERE f.xero_invoice_id = r.xero_invoice_id) THEN
      v_skip := 'already has a materials fact';
    ELSIF EXISTS (SELECT 1 FROM public.trade_invoices t WHERE t.xero_bill_id = r.xero_invoice_id) THEN
      v_skip := 'is a trade app invoice, counted as labour';
    END IF;

    IF v_skip IS NULL THEN
      SELECT xi.status, xi.line_items INTO x
        FROM public.xero_invoices xi
       WHERE xi.xero_invoice_id = r.xero_invoice_id
       ORDER BY (xi.status IN ('AUTHORISED', 'PAID')) DESC
       LIMIT 1;
      IF NOT FOUND THEN
        v_skip := 'not in our copy of Xero';
      ELSIF x.status NOT IN ('AUTHORISED', 'PAID') THEN
        v_skip := 'is ' || x.status || ' in Xero';
      END IF;
    END IF;

    IF v_skip IS NULL THEN
      SELECT jb.id, jb.job_number, jb.status, jb.org_id, jb.metadata INTO j
        FROM public.jobs jb WHERE upper(jb.job_number) = upper(r.job_number);
      IF NOT FOUND THEN
        v_skip := 'job ' || r.job_number || ' not found';
      ELSIF lower(COALESCE(j.status, '')) IN ('cancelled', 'lost') THEN
        v_skip := 'job ' || j.job_number || ' is ' || j.status;
      ELSIF lower(COALESCE(j.metadata ->> 'do_not_schedule', '')) = 'true' THEN
        v_skip := 'job ' || j.job_number || ' is a holding job';
      END IF;
    END IF;

    IF v_skip IS NOT NULL THEN
      v_skipped := v_skipped + 1;
      RAISE NOTICE 'sep placements: skipped bill % (%) for %: %', r.invoice_number, r.xero_invoice_id, r.job_number, v_skip;
      CONTINUE;
    END IF;

    -- assignReconRow's lane rule: an installer account on any line with an amount makes it labour.
    v_lane := CASE WHEN EXISTS (
                SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.line_items) = 'array'
                                                        THEN x.line_items ELSE '[]'::jsonb END) li
                 WHERE COALESCE(NULLIF(li ->> 'LineAmount', '')::numeric, 0) <> 0
                   AND li ->> 'AccountCode' IN ('306', '301'))
              THEN 'labour' ELSE 'materials' END;

    INSERT INTO public.job_materials_facts (
      org_id, xero_invoice_id, invoice_number, xero_contact_id, contact_name, job_id, job_number,
      lane, kind, amount_ex_gst, amount_inc_gst, confidence, automation_source, matched_po_id,
      match_reason, fact_date, assigned_by, updated_at)
    VALUES (
      q.org_id, q.xero_invoice_id, q.invoice_number, q.xero_contact_id, q.contact_name, j.id, j.job_number,
      v_lane, 'actual', q.sub_total, q.total, 'high_manual', 'manual_queue', NULL,
      'manual_queue:assign-to-job ' || j.job_number, q.invoice_date, c_actor, c_now)
    RETURNING id INTO v_fact_id;

    UPDATE public.materials_reconciliation_queue
       SET status = 'assigned', assigned_job_id = j.id, assigned_by = c_actor, assigned_at = c_now, updated_at = c_now
     WHERE id = q.id AND status = 'open';

    INSERT INTO public.job_events (job_id, event_type, detail_json)
    VALUES (j.id, 'materials_bill_assigned', jsonb_build_object(
      'source', 'materials_recon_queue',
      'action', 'assign-to-job',
      'manual', true,
      'approved_list', 'sep-reconcile group A, migration 20261116003000',
      'xero_invoice_id', q.xero_invoice_id,
      'invoice_number', q.invoice_number,
      'contact_name', q.contact_name,
      'amount_ex_gst', q.sub_total,
      'job_number', j.job_number,
      'lane', v_lane,
      'assigned_by', c_actor,
      'assigned_at', c_now));
    v_placed := v_placed + 1;
  END LOOP;

  -- The one split: Nithin's commission bill 202608 names two jobs, one line each
  -- (SWP-26090 409.00 and SWP-26102 167.00, together the bill's 576.00). allocate_bill_split
  -- runs every guard of its own and refuses rather than forcing; a refusal is a skip here.
  SELECT id INTO v_j1 FROM public.jobs WHERE job_number = 'SWP-26090';
  SELECT id INTO v_j2 FROM public.jobs WHERE job_number = 'SWP-26102';
  BEGIN
    IF v_j1 IS NULL OR v_j2 IS NULL THEN
      RAISE EXCEPTION 'split_refused: SWP-26090 or SWP-26102 not found';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.materials_reconciliation_queue
                    WHERE xero_invoice_id = 'e4a5d66f-ce5f-4d80-970f-feb422f66119' AND status = 'open'
                      AND round(sub_total::numeric, 2) = 576.00) THEN
      RAISE EXCEPTION 'split_refused: bill 202608 is no longer open at 576.00';
    END IF;
    PERFORM public.allocate_bill_split(
      'e4a5d66f-ce5f-4d80-970f-feb422f66119',
      jsonb_build_array(
        jsonb_build_object('job_id', v_j1, 'amount_ex', 409.00, 'lane', 'labour'),
        jsonb_build_object('job_id', v_j2, 'amount_ex', 167.00, 'lane', 'labour')),
      0, NULL, c_actor);
    INSERT INTO public.job_events (job_id, event_type, detail_json)
    SELECT p.job_id, 'materials_bill_split', jsonb_build_object(
      'source', 'materials_recon_queue', 'action', 'split', 'manual', true,
      'approved_list', 'sep-reconcile group A, migration 20261116003000',
      'xero_invoice_id', 'e4a5d66f-ce5f-4d80-970f-feb422f66119',
      'amount_ex_gst', p.amount_ex, 'lane', 'labour', 'parts', 2, 'overhead_ex', 0,
      'assigned_by', c_actor)
      FROM (VALUES (v_j1, 409.00), (v_j2, 167.00)) AS p(job_id, amount_ex);
    v_placed := v_placed + 1;
  EXCEPTION WHEN raise_exception THEN
    v_skipped := v_skipped + 1;
    RAISE NOTICE 'sep placements: skipped bill 202608 split: %', SQLERRM;
  END;

  RAISE NOTICE 'sep placements: % bills placed, % skipped', v_placed, v_skipped;
END
$placements$;
