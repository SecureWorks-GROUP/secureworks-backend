-- Contract for 20261104110000_job_profit_patio_bound_revision (finish-line row A6, patio jobs).
--
-- Synthetic jobs, no customer or staff data; shaped on the four live patio jobs the A6 check found wrong on 3 Nov 2026.
-- Every expected figure is worked out here by hand from the fixture documents, never read back from the view first.
-- Everything rolls back.
--   A6P-LAB      one sealed revision, no labour priced, on the customer's invoices; crew labour on the job
--                -> no expected cost; sealed_scope_no_labour names the labour on the job   (SWP-261180)
--   A6P-NOLAB    the same revision with no labour on the job -> frozen_scope_revision $2,622.98, as before
--   A6P-OLDER    invoices on revisions 1 and 2 ($14,499.76), one issued after newest revision 3 was sealed
--                -> bound to revision 2: $7,642.90                                        (SWP-261248, rates clean)
--   A6P-ORATE    the same, revision 2 with a missing rate -> sealed_scope_rate_missing on revision 2 (SWP-261248)
--   A6P-NONE     invoices on no sealed revision's price -> sealed_scope_not_invoiced          (SWP-261336)
--   A6P-WALL     two invoices on revision 3, a walling invoice on no revision, rates missing in revision 4
--                -> sealed_scope_not_invoiced, the missing rates and their holder named        (SWP-261203)
--   A6P-BEFORE   the deposit is on revision 2, revision 3 sealed after it with no invoice on its price
--                -> sealed_scope_not_invoiced, "sealed after those invoices"                 (SWP-26344)
--   A6P-NEWEST   the deposit on revision 1, the next invoice on newest revision 2 -> revision 2, as before
--   A6P-DEC      a share with a decimal (DEP6.5) on the newest revision, a voided invoice left out -> as before
\set ON_ERROR_STOP on

BEGIN;
SET LOCAL TimeZone = 'UTC';

INSERT INTO public.organisations (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'Synthetic org')
ON CONFLICT (id) DO NOTHING;
DELETE FROM public.feature_flags WHERE flag_name IN ('job_profit_patio_expected_from_frozen_scope', 'job_cost_employer_super_v1');
INSERT INTO public.feature_flags (flag_name, enabled) VALUES ('job_profit_patio_expected_from_frozen_scope', true);

CREATE FUNCTION pg_temp.job(p_n integer, p_number text) RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO public.jobs (id, org_id, status, type, job_number, metadata, pricing_json, created_at)
  VALUES (('a6110000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid, '00000000-0000-0000-0000-000000000001',
          'order_materials', 'patio', p_number, '{}', '{}', '2026-06-01T00:00:00Z')
  RETURNING id $$;
-- A sealed old-tool revision: its pricing inside the scope record, as PatioDesignerPro writes it.
CREATE FUNCTION pg_temp.rev(p_job uuid, p_n integer, p_frozen timestamptz, p_sell numeric, p_lab numeric, p_mat numeric,
                            p_com numeric, p_warn jsonb DEFAULT '[]'::jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_prev uuid;
BEGIN
  SELECT s.id INTO v_prev FROM public.scope_revisions s WHERE s.job_id = p_job AND s.status = 'frozen';
  INSERT INTO public.scope_revisions (id, job_id, revision_number, tool_kind, status, scope_hash, pricing_hash, scope_canonical_text, frozen_at)
  VALUES (v_id, p_job, p_n, 'patio', 'frozen', md5(v_id::text) || md5(p_n::text), md5(p_n::text) || md5(v_id::text),
          jsonb_build_object('_pricing_json', jsonb_build_object('totalExGST', p_sell, 'labourCostEstimate', p_lab,
            'materialCostEstimate', p_mat, 'commissionCostEstimate', p_com, 'totalCostEstimate', p_lab + p_mat + p_com,
            'pricing_warnings', p_warn,
            'line_items', jsonb_build_array(jsonb_build_object('description', 'Roof', 'total_sell', p_sell, 'total_cost', p_mat))))::text,
          p_frozen);
  IF v_prev IS NOT NULL THEN
    UPDATE public.scope_revisions SET status = 'superseded', superseded_at = p_frozen, superseded_by_scope_revision_id = v_id
     WHERE id = v_prev;
  END IF;
  RETURN v_id;
END $$;
CREATE FUNCTION pg_temp.inv(p_job uuid, p_number text, p_ref text, p_date date, p_ex numeric, p_status text DEFAULT 'AUTHORISED')
RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total,
                                    invoice_date, job_id, reference, raw_json, line_items)
  VALUES ('00000000-0000-0000-0000-000000000001', 'x-' || p_number, p_number, 'ACCREC', p_status, 'Synthetic customer', p_ex,
          round(p_ex * 1.1, 2), p_date, p_job, p_ref, '{}', '[]') $$;

DO $fixture$
DECLARE
  j uuid;
  crew uuid := 'a6110000-0000-4000-8000-0000000000c1';
  ti uuid := 'a6110000-0000-4000-8000-0000000000c2';
BEGIN
  -- A6P-LAB: SWP-261180's shape. One sealed revision priced at $3,446.00 ex GST with materials $2,500.00, commission
  -- $122.98 and no labour; both invoices are half of that price; a crew invoice puts $220.00 of labour on the job.
  j := pg_temp.job(1, 'A6P-LAB');
  PERFORM pg_temp.rev(j, 1, '2026-08-10T14:17:46Z', 3446, 0, 2500, 122.98);
  PERFORM pg_temp.inv(j, 'INV-A6P-11', 'A6P-LAB-DEP50', '2026-08-31', 1723);
  PERFORM pg_temp.inv(j, 'INV-A6P-12', 'A6P-LAB-FINBAL50', '2026-10-02', 1723, 'PAID');
  INSERT INTO public.users (id, org_id, name) VALUES (crew, '00000000-0000-0000-0000-000000000001', 'Synthetic A6P crew');
  -- The employer super switch is off in this fixture, so the labour on the job is the line itself, $220.00.
  INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, subtotal_ex, gst, total_inc, invoice_number,
                                     gst_on, super_rate, gross_earned, super_amount, net_pay)
  VALUES (ti, '00000000-0000-0000-0000-000000000001', crew, '2026-09-28', 'approved', 220, 0, 220, 'SW-INV-A6P-1',
          false, 0.12, 220, 26.40, 220);
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, job_number, line_type, description, total_hours, hourly_rate, line_total_ex, line_date, created_at)
  VALUES (ti, j, 'A6P-LAB', 'labour', 'Frame the patio', 5.5, 40, 220, '2026-09-30', '2026-10-02T01:00:00Z');

  -- A6P-NOLAB: the same revision and invoices, no labour on the job.
  j := pg_temp.job(2, 'A6P-NOLAB');
  PERFORM pg_temp.rev(j, 1, '2026-08-10T14:17:46Z', 3446, 0, 2500, 122.98);
  PERFORM pg_temp.inv(j, 'INV-A6P-21', 'A6P-NOLAB-DEP50', '2026-08-31', 1723);

  -- A6P-OLDER: SWP-261248's shape with clean rates. Revisions 1 and 2 at $14,499.76 (labour 2,160.00, materials
  -- 4,458.31, commission 1,024.59), revision 3 at $12,300.89 sealed 18 Aug 14:06Z (22:06 Perth); the deposit (20%,
  -- 25 Aug) and the materials invoice (50%, 2 Nov, a cent over the exact half) are on $14,499.76.
  j := pg_temp.job(3, 'A6P-OLDER');
  PERFORM pg_temp.rev(j, 1, '2026-08-18T13:41:44Z', 14499.76, 2160, 4458.31, 1024.59);
  PERFORM pg_temp.rev(j, 2, '2026-08-18T13:56:22Z', 14499.76, 2160, 4458.31, 1024.59);
  PERFORM pg_temp.rev(j, 3, '2026-08-18T14:06:05Z', 12300.89, 2160, 3844.95, 818.47);
  PERFORM pg_temp.inv(j, 'INV-A6P-31', 'A6P-OLDER-DEP20', '2026-08-25', 2899.95, 'PAID');
  PERFORM pg_temp.inv(j, 'INV-A6P-32', 'A6P-OLDER-MAT50', '2026-11-02', 7249.89);

  -- A6P-ORATE: the same, revision 2 (and 1 and 3) with Rafter Brackets (Galv) quoted at $0 for a missing rate.
  j := pg_temp.job(4, 'A6P-ORATE');
  PERFORM pg_temp.rev(j, 1, '2026-08-18T13:41:44Z', 14499.76, 2160, 4458.31, 1024.59, '[{"code": "RATE_MISSING", "context": "Rafter Brackets (Galv)"}]');
  PERFORM pg_temp.rev(j, 2, '2026-08-18T13:56:22Z', 14499.76, 2160, 4458.31, 1024.59, '[{"code": "RATE_MISSING", "context": "Rafter Brackets (Galv)"}, {"code": "ROW_RATE_MISSING", "context": "Rafter Brackets (Galv)"}]');
  PERFORM pg_temp.rev(j, 3, '2026-08-18T14:06:05Z', 12300.89, 2160, 3844.95, 818.47, '[{"code": "RATE_MISSING", "context": "Rafter Brackets (Galv)"}]');
  PERFORM pg_temp.inv(j, 'INV-A6P-41', 'A6P-ORATE-DEP20', '2026-08-25', 2899.95, 'PAID');
  PERFORM pg_temp.inv(j, 'INV-A6P-42', 'A6P-ORATE-MAT50', '2026-11-02', 7249.89);

  -- A6P-NONE: SWP-261336's shape. Revisions at $24,609.11 and $25,041.18, then $2,000.00 with no labour; the
  -- customer's 10% and 50% invoices put the price at $23,150.40 and $23,150.42, which no revision states.
  j := pg_temp.job(5, 'A6P-NONE');
  PERFORM pg_temp.rev(j, 1, '2026-08-28T09:40:26Z', 24609.11, 3960, 4523.97, 2096.27);
  PERFORM pg_temp.rev(j, 2, '2026-08-28T09:40:51Z', 25041.18, 4320, 4523.97, 2105.64);
  PERFORM pg_temp.rev(j, 3, '2026-08-28T10:06:53Z', 2000, 0, 1340, 85.80);
  PERFORM pg_temp.inv(j, 'INV-A6P-51', 'A6P-NONE-DEP10', '2026-09-04', 2315.04, 'PAID');
  PERFORM pg_temp.inv(j, 'INV-A6P-52', 'A6P-NONE-MAT50', '2026-10-30', 11575.21);

  -- A6P-WALL: SWP-261203's shape. Revision 3 at $20,418.90, revision 4 at $29,570.91 (walling added); the deposit and
  -- the materials invoice are on revision 3, the walling invoice is half of $8,971.34, on no revision.
  j := pg_temp.job(6, 'A6P-WALL');
  PERFORM pg_temp.rev(j, 3, '2026-08-14T02:07:31Z', 20418.90, 2160, 6473.69, 1532.08);
  PERFORM pg_temp.rev(j, 4, '2026-08-18T08:41:46Z', 29570.91, 3600, 8973.69, 2209.64,
                      '[{"code": "RATE_MISSING", "context": "Fascia Brackets"}, {"code": "RATE_MISSING", "context": "EPS Wall Panels 50mm (Surfmist both sides)"}, {"code": "ROW_RATE_MISSING", "context": "Fascia Brackets"}]');
  PERFORM pg_temp.inv(j, 'INV-A6P-61', 'A6P-WALL-DEP20', '2026-08-20', 4083.78, 'PAID');
  PERFORM pg_temp.inv(j, 'INV-A6P-62', 'A6P-WALL-MAT50', '2026-10-21', 10209.45, 'PAID');
  PERFORM pg_temp.inv(j, 'INV-A6P-63', 'A6P-WALL-WALL-MAT50', '2026-10-30', 4485.67);
  PERFORM pg_temp.inv(j, 'INV-A6P-64', 'A6P-WALL-WALL-MAT', '2026-10-30', 4485.67, 'VOIDED');

  -- A6P-BEFORE: SWP-26344's shape. The deposit (9 Jul) is on revision 2 ($6,232.90); revision 3 ($22,217.56) was
  -- sealed on 1 Oct, after it, and no invoice is on its price yet.
  j := pg_temp.job(7, 'A6P-BEFORE');
  PERFORM pg_temp.rev(j, 2, '2026-06-30T06:58:00Z', 6232.90, 2520, 1500, 300);
  PERFORM pg_temp.rev(j, 3, '2026-10-01T05:53:00Z', 22217.56, 4320, 7000, 1500);
  PERFORM pg_temp.inv(j, 'INV-A6P-71', 'A6P-BEFORE-DEP20', '2026-07-09', 1246.58, 'PAID');

  -- A6P-NEWEST: the deposit is on revision 1 ($10,000.00), the materials invoice on newest revision 2 ($12,000.00):
  -- the price changed and the customer is billed on the newest, so revision 2 stands (1,200 + 3,000 + 500).
  j := pg_temp.job(8, 'A6P-NEWEST');
  PERFORM pg_temp.rev(j, 1, '2026-07-01T00:00:00Z', 10000, 1000, 2500, 400);
  PERFORM pg_temp.rev(j, 2, '2026-07-20T00:00:00Z', 12000, 1200, 3000, 500);
  PERFORM pg_temp.inv(j, 'INV-A6P-81', 'A6P-NEWEST-DEP20', '2026-07-05', 2000, 'PAID');
  PERFORM pg_temp.inv(j, 'INV-A6P-82', 'A6P-NEWEST-MAT50', '2026-08-01', 6000);

  -- A6P-DEC: a 6.5% deposit on the only revision ($10,000.00); a voided invoice that matches nothing is left out.
  j := pg_temp.job(9, 'A6P-DEC');
  PERFORM pg_temp.rev(j, 1, '2026-07-01T00:00:00Z', 10000, 1000, 2000, 300);
  PERFORM pg_temp.inv(j, 'INV-A6P-91', 'A6P-DEC-DEP6.5', '2026-07-02', 650);
  PERFORM pg_temp.inv(j, 'INV-A6P-92', 'A6P-DEC-DEP20', '2026-07-02', 9999, 'VOIDED');
END
$fixture$;

-- The fixture's own facts, checked before the view is read.
DO $$
BEGIN
  IF COALESCE((SELECT sum(e.amount_ex) FROM public.v_job_cost_events e
                WHERE e.job_id = 'a6110000-0000-4000-8000-000000000001' AND e.is_actual AND e.lane = 'labour'), 0) <> 220 THEN
    RAISE EXCEPTION 'patio bound revision fixture: A6P-LAB does not carry $220.00 of actual labour (%)',
      (SELECT sum(e.amount_ex) FROM public.v_job_cost_events e WHERE e.job_id = 'a6110000-0000-4000-8000-000000000001' AND e.is_actual AND e.lane = 'labour');
  END IF;
  IF EXISTS (SELECT 1 FROM public.v_job_cost_events e
              WHERE e.job_id = 'a6110000-0000-4000-8000-000000000002' AND e.is_actual AND e.lane = 'labour') THEN
    RAISE EXCEPTION 'patio bound revision fixture: A6P-NOLAB carries labour';
  END IF;
END $$;

CREATE TEMP TABLE w_b ON COMMIT DROP AS
SELECT j.job_number, b.*
  FROM public.v_job_profit_patio_scope_binding b JOIN public.jobs j ON j.id = b.job_id
 WHERE b.job_id::text LIKE 'a6110000-0000-4000-8000-%';
CREATE TEMP TABLE w_jp ON COMMIT DROP AS
SELECT p.job_number, p.expected_source, p.expected_labour_ex, p.expected_materials_ex, p.expected_commission_ex,
       p.expected_cost_ex, p.expected_cost_missing
  FROM public.v_job_profit p
 WHERE p.job_id::text LIKE 'a6110000-0000-4000-8000-%';

DO $$
DECLARE
  r record;
  m jsonb;
  pb text := 'patio bound revision: ';
BEGIN
  IF (SELECT count(*) FROM w_jp) <> 9 OR (SELECT count(*) FROM w_b) <> 9 THEN
    RAISE EXCEPTION '%9 synthetic jobs expected, v_job_profit has % and the binding %', pb, (SELECT count(*) FROM w_jp), (SELECT count(*) FROM w_b);
  END IF;
  -- Named exactly when there is no expected cost, never beside one; no dash staff must not read.
  FOR r IN SELECT * FROM w_jp LOOP
    IF (r.expected_source IS NULL) <> (r.expected_cost_missing IS NOT NULL)
       OR (r.expected_cost_missing IS NOT NULL AND NOT (r.expected_cost_missing ?& ARRAY['code', 'document', 'holder']))
       OR r.expected_cost_missing::text ~ '[–—]' THEN
      RAISE EXCEPTION '% % has expected_source % and expected_cost_missing %', pb, r.job_number, r.expected_source, r.expected_cost_missing;
    END IF;
  END LOOP;

  -- A6P-LAB: no labour priced while $220.00 of labour is on the job: no expected cost, and the labour is named.
  SELECT * INTO r FROM w_jp WHERE job_number = 'A6P-LAB';
  IF r.expected_source IS NOT NULL OR r.expected_cost_missing ->> 'code' IS DISTINCT FROM 'sealed_scope_no_labour'
     OR r.expected_cost_missing ->> 'document' IS DISTINCT FROM
        'Sealed scope revision 1 sealed again with its labour: it states no labour cost, but $220.00 of labour (ex GST) is on the job'
     OR r.expected_cost_missing ->> 'holder' NOT LIKE 'The salesperson who scoped it%' THEN
    RAISE EXCEPTION '%A6P-LAB reads % % %', pb, r.expected_source, r.expected_cost_ex, r.expected_cost_missing;
  END IF;
  IF (SELECT basis FROM w_b WHERE job_number = 'A6P-LAB') <> 'newest_sealed' THEN
    RAISE EXCEPTION '%A6P-LAB is not bound to its newest revision', pb;
  END IF;

  -- A6P-NOLAB: the same revision with no labour on the job stands, as before: 0 + 2,500.00 + 122.98.
  SELECT * INTO r FROM w_jp WHERE job_number = 'A6P-NOLAB';
  IF r.expected_source IS DISTINCT FROM 'frozen_scope_revision' OR r.expected_cost_ex IS DISTINCT FROM 2622.98::numeric
     OR r.expected_labour_ex IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION '%A6P-NOLAB reads % %', pb, r.expected_source, r.expected_cost_ex;
  END IF;

  -- A6P-OLDER: bound to revision 2 (newest at the invoiced price): 2,160.00 + 4,458.31 + 1,024.59 = 7,642.90.
  SELECT * INTO r FROM w_b WHERE job_number = 'A6P-OLDER';
  IF r.basis <> 'invoices_on_superseded' OR r.revision_number <> 2 OR r.newest_revision_number <> 3
     OR r.share_invoices <> 2 OR r.share_invoices_on_newest <> 0 THEN
    RAISE EXCEPTION '%A6P-OLDER binding is % revision % (newest %, % invoices, % on newest)', pb, r.basis, r.revision_number,
      r.newest_revision_number, r.share_invoices, r.share_invoices_on_newest;
  END IF;
  SELECT * INTO r FROM w_jp WHERE job_number = 'A6P-OLDER';
  IF r.expected_source IS DISTINCT FROM 'frozen_scope_revision' OR r.expected_cost_ex IS DISTINCT FROM 7642.90::numeric
     OR r.expected_labour_ex IS DISTINCT FROM 2160::numeric OR r.expected_materials_ex IS DISTINCT FROM 4458.31::numeric
     OR r.expected_commission_ex IS DISTINCT FROM 1024.59::numeric THEN
    RAISE EXCEPTION '%A6P-OLDER reads % % % % %', pb, r.expected_source, r.expected_cost_ex, r.expected_labour_ex,
      r.expected_materials_ex, r.expected_commission_ex;
  END IF;

  -- A6P-ORATE: bound to revision 2, whose missing rate withholds it; the revision, the rate and its holder are named.
  SELECT * INTO r FROM w_jp WHERE job_number = 'A6P-ORATE';
  m := r.expected_cost_missing;
  IF r.expected_source IS NOT NULL OR m ->> 'code' IS DISTINCT FROM 'sealed_scope_rate_missing'
     OR m ->> 'document' IS DISTINCT FROM 'Sealed scope revision 2 sealed again with every rate: a rate is missing for Rafter Brackets (Galv) (the revision the customer''s invoices are on, $14,499.76 ex GST; the newest, revision 3, is not)'
     OR m ->> 'holder' NOT LIKE 'The salesperson who scoped it%'
     OR position('the office has set the missing rate' IN m ->> 'holder') = 0 THEN
    RAISE EXCEPTION '%A6P-ORATE reads % %', pb, r.expected_source, m;
  END IF;

  -- A6P-NONE: no sealed revision is at the price on the invoices: no expected cost, every invoice named.
  SELECT * INTO r FROM w_jp WHERE job_number = 'A6P-NONE';
  m := r.expected_cost_missing;
  IF r.expected_source IS NOT NULL OR m ->> 'code' IS DISTINCT FROM 'sealed_scope_not_invoiced'
     OR m ->> 'document' IS DISTINCT FROM 'The sealed scope revision the customer bought, at the price on their invoices (ex GST): INV-A6P-51 (10% of $23,150.40) is on no sealed revision''s price; INV-A6P-52 (50% of $23,150.42) is on no sealed revision''s price. The newest sealed revision, 3, is $2,000.00'
     OR m ->> 'holder' NOT LIKE 'The salesperson who scoped it%' THEN
    RAISE EXCEPTION '%A6P-NONE reads % %', pb, r.expected_source, m;
  END IF;
  IF (SELECT basis FROM w_b WHERE job_number = 'A6P-NONE') <> 'invoices_on_no_revision'
     OR (SELECT revision_id FROM w_b WHERE job_number = 'A6P-NONE') IS NOT NULL THEN
    RAISE EXCEPTION '%A6P-NONE is bound to a revision', pb;
  END IF;

  -- A6P-WALL: two invoices on revision 3, the walling invoice on none: not bound; the voided invoice is not named.
  SELECT * INTO r FROM w_jp WHERE job_number = 'A6P-WALL';
  m := r.expected_cost_missing;
  IF r.expected_source IS NOT NULL OR m ->> 'code' IS DISTINCT FROM 'sealed_scope_not_invoiced'
     OR m ->> 'document' IS DISTINCT FROM 'The sealed scope revision the customer bought, at the price on their invoices (ex GST): INV-A6P-61 (20%) is on revision 3''s price, $20,418.90; INV-A6P-62 (50%) is on revision 3''s price, $20,418.90; INV-A6P-63 (50% of $8,971.34) is on no sealed revision''s price. The newest sealed revision, 4, is $29,570.91 (a rate is missing for EPS Wall Panels 50mm (Surfmist both sides); Fascia Brackets)'
     OR position('The office sets the missing rate' IN m ->> 'holder') = 0 THEN
    RAISE EXCEPTION '%A6P-WALL reads % %', pb, r.expected_source, m;
  END IF;

  -- A6P-BEFORE: the invoice predates the newest revision: not bound, and said so.
  SELECT * INTO r FROM w_jp WHERE job_number = 'A6P-BEFORE';
  m := r.expected_cost_missing;
  IF r.expected_source IS NOT NULL OR m ->> 'code' IS DISTINCT FROM 'sealed_scope_not_invoiced'
     OR m ->> 'document' IS DISTINCT FROM 'The sealed scope revision the customer bought, at the price on their invoices (ex GST): INV-A6P-71 (20%) is on revision 2''s price, $6,232.90. The newest sealed revision, 3, is $22,217.56 and was sealed after those invoices, with none on its price yet' THEN
    RAISE EXCEPTION '%A6P-BEFORE reads % %', pb, r.expected_source, m;
  END IF;

  -- A6P-NEWEST: an invoice is on the newest revision, so it stands: 1,200 + 3,000 + 500.
  SELECT * INTO r FROM w_jp WHERE job_number = 'A6P-NEWEST';
  IF r.expected_source IS DISTINCT FROM 'frozen_scope_revision' OR r.expected_cost_ex IS DISTINCT FROM 4700::numeric
     OR (SELECT basis FROM w_b WHERE job_number = 'A6P-NEWEST') <> 'newest_sealed' THEN
    RAISE EXCEPTION '%A6P-NEWEST reads % %', pb, r.expected_source, r.expected_cost_ex;
  END IF;

  -- A6P-DEC: 6.5% of $10,000.00 is $650.00, on the revision; the voided invoice is not a share invoice.
  SELECT * INTO r FROM w_jp WHERE job_number = 'A6P-DEC';
  IF r.expected_source IS DISTINCT FROM 'frozen_scope_revision' OR r.expected_cost_ex IS DISTINCT FROM 3300::numeric
     OR (SELECT share_invoices FROM w_b WHERE job_number = 'A6P-DEC') <> 1
     OR (SELECT share_pct FROM public.v_job_profit_share_invoices WHERE invoice_number = 'INV-A6P-91') IS DISTINCT FROM 6.5::numeric THEN
    RAISE EXCEPTION '%A6P-DEC reads % %', pb, r.expected_source, r.expected_cost_ex;
  END IF;
END $$;

-- job_profit(uuid) returns the same row.
DO $$
BEGIN
  IF (SELECT p.expected_cost_ex FROM public.job_profit('a6110000-0000-4000-8000-000000000003') p) IS DISTINCT FROM 7642.90::numeric
     OR (SELECT p.expected_cost_missing ->> 'code' FROM public.job_profit('a6110000-0000-4000-8000-000000000001') p) IS DISTINCT FROM 'sealed_scope_no_labour' THEN
    RAISE EXCEPTION 'patio bound revision: job_profit(uuid) does not read the bound revision';
  END IF;
END $$;

-- The switch off: no sealed patio revision is read, and every one is named as unread for that reason.
UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'job_profit_patio_expected_from_frozen_scope';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.v_job_profit p WHERE p.job_id::text LIKE 'a6110000-0000-4000-8000-%'
              AND (p.expected_source IS NOT NULL OR p.expected_cost_missing ->> 'code' IS DISTINCT FROM 'sealed_scope_switch_off')) THEN
    RAISE EXCEPTION 'patio bound revision: with the switch off a sealed revision is still read or named otherwise';
  END IF;
END $$;

-- Read only for the service role; never for anon or authenticated.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
       AND (has_table_privilege(r, 'public.v_job_profit_share_invoices', 'SELECT')
            OR has_table_privilege(r, 'public.v_job_profit_patio_scope_binding', 'SELECT')
            OR has_function_privilege(r, 'public.job_profit_patio_revision_pricing(text,text)', 'EXECUTE')
            OR has_function_privilege(r, 'public.job_profit_share_on_price(numeric,numeric,numeric)', 'EXECUTE')) THEN
      RAISE EXCEPTION 'patio bound revision: % may read the new views or run the new functions', r;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
     AND NOT (has_table_privilege('service_role', 'public.v_job_profit_patio_scope_binding', 'SELECT')
              AND has_table_privilege('service_role', 'public.v_job_profit_share_invoices', 'SELECT')
              AND has_function_privilege('service_role', 'public.job_profit_expected_cost_missing(uuid)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'patio bound revision: service_role cannot read the new views';
  END IF;
END $$;

ROLLBACK;
