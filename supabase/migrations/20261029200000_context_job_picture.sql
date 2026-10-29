-- One shared job picture for every placer (TP-04, slice 1), 29 Oct 2026.
-- Plan: 08-path-to-trusted-profit §4A-1; architecture assessment 28 Oct,
-- "two placers that don't share knowledge".
--
-- 1. context_job_picture(job_ids, phone_keys, email_keys): read only, SECURITY
--    DEFINER, service role only. For each of the given jobs that is live (a job
--    number, not cancelled or lost, not a holding job by the canonical rule
--    lower(metadata ->> 'do_not_schedule') = 'true'), one object:
--      job_number, type, status, created, client, site (as the bill reader
--        always showed them), scheduled (the bill reader's first booked day,
--        same rule as before, kept so its answer does not move)
--      client_names   the job's client and every active party's name
--      contacts       how many phones and emails the job and its parties
--                     carry, and, only when the caller passes keys, whether
--                     any of them matches (phone_match, email_match). No phone
--                     or email leaves this function (INT-01): a placer gets a
--                     yes or no, never the value.
--      site_key, site_loose_keys
--                     context_address_key / context_address_loose_keys of the
--                     job's site address: the one address rule (B0), never a
--                     second normaliser
--      scope          named scalar keys only, read out of scope_json
--                     (fence: metres, runs, gates, colour, profile, height;
--                     patio: length, width, projection, roof style, roofing,
--                     panels, colour, material, height). Never the blob, never
--                     a money key, never an array or object value
--      materials      the job's Materials by supplier lines (item, quantity,
--                     unit, status, supplier), no prices
--      supplier_orders
--                     the job's supplier boxes (supplier, stage, delivery
--                     date, main supplier)
--      purchase_orders
--                     the job's purchase orders that are not deleted or
--                     cancelled (number, supplier, status, delivery date,
--                     source), no amounts
--      crew, on_site  real crew bookings (not cancelled, not a ghost watcher
--                     row, not an observer): day, end day, type, crew name,
--                     status; and the first and last day on site
--      work_order     the job's job work order (number, status, approved day)
--      xero_projects  Xero Projects linked to the job (name, status, and
--                     whether its name carries the job's own number, Job
--                     Profit's rule), no amounts
--      suppliers_billed
--                     suppliers whose bills are already placed on the job
--                     (name, Xero contact, bills, by the AI reader, newest
--                     bill day), no amounts
--    Every list is capped (the numbers are below) and figure-free: no price,
--    cost, amount, margin or commission is in the picture.
--
-- 2. materials_ai_candidate_jobs(from, to) (the bill placer, 20261028173000)
--    now takes its jobs from the picture. It still chooses WHICH jobs (alive
--    around the bills' dates, its window unchanged); the picture decides which
--    of them are live and supplies each job's fields. Its eight keys (job_id,
--    job_number, type, status, client, site, created, scheduled) keep their
--    names and values; the picture's fields are added beside them. The jarvis
--    bill prompt prints only the eight today, so the prompt does not change
--    until jarvis reads the new fields (TP-04 slice 2).
--
-- Not here: the message placer (jarvis luna-attribution-candidates.ts and the
-- backend ladder), any write, any prompt change. Nothing writes Xero.
--
-- Columns were checked against the migrations in this repository, not the live
-- schema. job_assignments.is_ghost is live drift that no migration here adds
-- (AGENTS.md); the record layer (20261006011000) already reads it, and the
-- guard below refuses to apply without it.
--
-- Rollback: supabase/rollbacks/20261029200000_context_job_picture_down.sql

-- ─────────────────────────────────────────────────────────────
-- 0. Guard: read the live definitions before replacing them. Reports every
--    problem at once.
-- ─────────────────────────────────────────────────────────────
DO $guard$
DECLARE problems text[] := '{}'; x record; live text; t text; f text;
BEGIN
 -- The replaced body: 20261028173000's, or this migration's (a re-apply).
 FOR x IN SELECT * FROM (VALUES
  ('public.materials_ai_candidate_jobs(date,date)', ARRAY['191fff3225a1ac8c03f6e631cea025d2', 'f7b28babf31d9fb0e937e82e35745cf2'])
 ) v(sig, accepted) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY (x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 -- Read, never replaced.
 FOREACH f IN ARRAY ARRAY['public.context_phone_key(text)', 'public.context_email_key(text)',
   'public.context_address_key(text)', 'public.context_address_loose_keys(text)'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['jobs.id', 'jobs.job_number', 'jobs.type', 'jobs.status', 'jobs.client_name', 'jobs.client_phone',
   'jobs.client_email', 'jobs.site_address', 'jobs.site_suburb', 'jobs.metadata', 'jobs.scope_json', 'jobs.created_at',
   'job_contacts.job_id', 'job_contacts.client_name', 'job_contacts.client_phone', 'job_contacts.client_email',
   'job_contacts.contact_label', 'job_contacts.status', 'job_contacts.removed_at',
   'job_assignments.job_id', 'job_assignments.user_id', 'job_assignments.status', 'job_assignments.scheduled_date',
   'job_assignments.scheduled_end', 'job_assignments.assignment_type', 'job_assignments.crew_name', 'job_assignments.role',
   'job_assignments.is_ghost', 'users.id', 'users.name',
   'purchase_orders.job_id', 'purchase_orders.po_number', 'purchase_orders.supplier_name', 'purchase_orders.status',
   'purchase_orders.delivery_date', 'purchase_orders.confirmed_delivery_date', 'purchase_orders.source',
   'purchase_orders.created_at',
   'job_material_suppliers.job_id', 'job_material_suppliers.supplier_id', 'job_material_suppliers.supplier_name',
   'job_material_suppliers.position', 'job_material_suppliers.delivery_date', 'job_material_suppliers.material_stage',
   'job_material_suppliers.is_main_supplier',
   'job_material_lines.job_id', 'job_material_lines.supplier_id', 'job_material_lines.description',
   'job_material_lines.quantity', 'job_material_lines.unit', 'job_material_lines.status', 'job_material_lines.position',
   'work_orders.job_id', 'work_orders.kind', 'work_orders.wo_number', 'work_orders.status', 'work_orders.approved_at',
   'xero_projects.job_id', 'xero_projects.project_name', 'xero_projects.status',
   'job_materials_facts.job_id', 'job_materials_facts.xero_invoice_id', 'job_materials_facts.contact_name',
   'job_materials_facts.xero_contact_id', 'job_materials_facts.fact_date', 'job_materials_facts.automation_source'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || split_part(t, '.', 1))
    AND a.attname = split_part(t, '.', 2) AND NOT a.attisdropped) THEN
   problems := problems || format('public.%s missing', t);
  END IF;
 END LOOP;
 IF to_regprocedure('public.context_job_picture(uuid[],text[],text[])') IS NOT NULL
    AND coalesce(obj_description(to_regprocedure('public.context_job_picture(uuid[],text[],text[])'), 'pg_proc'), '')
        NOT LIKE 'Job picture (20261029200000)%' THEN
  problems := problems || 'public.context_job_picture(uuid[],text[],text[]) exists and is not this migration''s'::text;
 END IF;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_job_picture_preimage_mismatch: %; read the live definitions before replacing them',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- ─────────────────────────────────────────────────────────────
-- 1. The picture
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.context_job_picture(p_job_ids uuid[], p_phone_keys text[] DEFAULT NULL,
                                                     p_email_keys text[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- Caps per job: crew 12, materials 30, supplier orders 10, purchase orders
  -- 15, Xero Projects 3, suppliers billed 10, names 8. Text is cut short.
  WITH j AS (
    SELECT j.*
      FROM public.jobs j
     WHERE j.id = ANY (COALESCE(p_job_ids, '{}'::uuid[]))
       AND j.job_number IS NOT NULL
       AND lower(COALESCE(j.status, '')) NOT IN ('cancelled', 'lost')
       -- The canonical holding-job rule (Job Profit, the bill reader).
       AND lower(COALESCE(j.metadata ->> 'do_not_schedule', '')) <> 'true'
  ),
  ids AS (SELECT array_agg(j.id) AS a FROM j),
  pk AS (SELECT array_agg(DISTINCT k) AS a FROM unnest(COALESCE(p_phone_keys, '{}'::text[])) r,
           LATERAL public.context_phone_key(r) k WHERE k IS NOT NULL),
  ek AS (SELECT array_agg(DISTINCT k) AS a FROM unnest(COALESCE(p_email_keys, '{}'::text[])) r,
           LATERAL public.context_email_key(r) k WHERE k IS NOT NULL),
  party AS (
    SELECT c.job_id, c.client_name, c.client_phone, c.client_email, c.contact_label, c.created_at
      FROM public.job_contacts c, ids
     WHERE c.job_id = ANY (ids.a)
       AND c.removed_at IS NULL
       AND lower(COALESCE(c.status, 'active')) <> 'removed'
  ),
  contact_keys AS (
    SELECT s.job_id, public.context_phone_key(s.phone) AS phone_key, public.context_email_key(s.email) AS email_key
      FROM (SELECT j.id AS job_id, j.client_phone AS phone, j.client_email AS email FROM j
            UNION ALL
            SELECT p.job_id, p.client_phone, p.client_email FROM party p) s
  ),
  contacts AS (
    SELECT k.job_id,
           count(DISTINCT k.phone_key) AS phones,
           count(DISTINCT k.email_key) AS emails,
           bool_or(k.phone_key = ANY (pk.a)) AS phone_match,
           bool_or(k.email_key = ANY (ek.a)) AS email_match
      FROM contact_keys k, pk, ek
     GROUP BY k.job_id
  ),
  names AS (
    SELECT n.job_id, jsonb_agg(n.name ORDER BY n.ord, n.label, n.name) FILTER (WHERE n.rn <= 8) AS names
      FROM (SELECT d.*, row_number() OVER (PARTITION BY d.job_id ORDER BY d.ord, d.label, d.name) AS rn
              FROM (SELECT DISTINCT ON (s.job_id, lower(s.name)) s.job_id, s.name, s.ord, s.label
                      FROM (SELECT j.id AS job_id, left(btrim(j.client_name), 120) AS name, 0 AS ord, ''::text AS label FROM j
                            UNION ALL
                            SELECT p.job_id, left(btrim(p.client_name), 120), 1, COALESCE(p.contact_label, '') FROM party p) s
                     WHERE COALESCE(s.name, '') <> ''
                     ORDER BY s.job_id, lower(s.name), s.ord, s.label) d) n
     GROUP BY n.job_id
  ),
  -- Named scalar keys only. Reading a path detoasts the column once per job;
  -- nothing of the blob is returned.
  sc AS (
    SELECT j.id AS job_id,
           j.scope_json -> 'job' AS fj,
           j.scope_json -> 'config' AS pc
      FROM j
     WHERE jsonb_typeof(j.scope_json) = 'object'
  ),
  scope AS (
    SELECT sc.job_id, jsonb_strip_nulls(jsonb_build_object(
             'fence', NULLIF(jsonb_strip_nulls(jsonb_build_object(
               'metres', (SELECT NULLIF(round(sum(COALESCE(
                              CASE WHEN jsonb_typeof(r -> 'length') = 'number' THEN (r ->> 'length')::numeric
                                   WHEN (r ->> 'length') ~ '^[0-9]+(\.[0-9]+)?$' THEN (r ->> 'length')::numeric END,
                              CASE WHEN jsonb_typeof(r -> 'totalLength') = 'number' THEN (r ->> 'totalLength')::numeric
                                   WHEN (r ->> 'totalLength') ~ '^[0-9]+(\.[0-9]+)?$' THEN (r ->> 'totalLength')::numeric END,
                              CASE WHEN jsonb_typeof(r -> 'lengthM') = 'number' THEN (r ->> 'lengthM')::numeric
                                   WHEN (r ->> 'lengthM') ~ '^[0-9]+(\.[0-9]+)?$' THEN (r ->> 'lengthM')::numeric END)), 2), 0)
                            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(sc.fj -> 'runs') = 'array' THEN sc.fj -> 'runs' ELSE '[]'::jsonb END) r),
               'runs', CASE WHEN jsonb_typeof(sc.fj -> 'runs') = 'array' AND jsonb_array_length(sc.fj -> 'runs') > 0
                            THEN jsonb_array_length(sc.fj -> 'runs') END,
               'gates', CASE WHEN jsonb_typeof(sc.fj -> 'gates') = 'array' AND jsonb_array_length(sc.fj -> 'gates') > 0
                             THEN jsonb_array_length(sc.fj -> 'gates') END,
               'colour', CASE WHEN jsonb_typeof(sc.fj -> 'colour') IN ('string', 'number') THEN left(sc.fj ->> 'colour', 80) END,
               'profile', CASE WHEN jsonb_typeof(sc.fj -> 'profile') IN ('string', 'number') THEN left(sc.fj ->> 'profile', 80) END,
               'height', CASE WHEN jsonb_typeof(sc.fj -> 'height') IN ('string', 'number') THEN left(sc.fj ->> 'height', 40) END
             )), '{}'::jsonb),
             'patio', NULLIF(jsonb_strip_nulls((SELECT jsonb_object_agg(k.out_key, left(sc.pc ->> k.in_key, 80))
                                                  FROM (VALUES ('length', 'length'), ('width', 'width'), ('projection', 'projection'),
                                                               ('roofStyle', 'roof_style'), ('roofing', 'roofing'), ('panel_type', 'panel_type'),
                                                               ('sheetType', 'sheet_type'), ('panelType', 'panel_type_alt'),
                                                               ('sheetColour', 'sheet_colour'), ('colour', 'colour'), ('material', 'material'),
                                                               ('height', 'height')) k(in_key, out_key)
                                                 WHERE jsonb_typeof(sc.pc) = 'object'
                                                   AND jsonb_typeof(sc.pc -> k.in_key) IN ('string', 'number'))), '{}'::jsonb)
           )) AS scope
      FROM sc
  ),
  sup AS (
    SELECT s.job_id, s.supplier_id, s.supplier_name, s.position, s.delivery_date, s.material_stage, s.is_main_supplier
      FROM public.job_material_suppliers s, ids
     WHERE s.job_id = ANY (ids.a)
  ),
  supplier_orders AS (
    SELECT o.job_id, jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'supplier', left(o.supplier_name, 120), 'stage', o.material_stage, 'delivery', o.delivery_date,
             'main', CASE WHEN o.is_main_supplier THEN true END)) ORDER BY o.position, o.supplier_name) FILTER (WHERE o.rn <= 10) AS list
      FROM (SELECT sup.*, row_number() OVER (PARTITION BY sup.job_id ORDER BY sup.position, sup.supplier_name) AS rn FROM sup) o
     GROUP BY o.job_id
  ),
  materials AS (
    SELECT m.job_id, jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'item', left(m.description, 120), 'quantity', m.quantity, 'unit', left(m.unit, 20), 'status', m.status,
             'supplier', left(m.supplier_name, 120))) ORDER BY m.spos, m.position) FILTER (WHERE m.rn <= 30) AS list
      FROM (SELECT l.job_id, l.description, l.quantity, l.unit, l.status, l.position, s.supplier_name,
                   COALESCE(s.position, 2147483647) AS spos,
                   row_number() OVER (PARTITION BY l.job_id ORDER BY COALESCE(s.position, 2147483647), l.position) AS rn
              FROM public.job_material_lines l
              JOIN ids ON l.job_id = ANY (ids.a)
              LEFT JOIN sup s ON s.job_id = l.job_id AND s.supplier_id = l.supplier_id) m
     GROUP BY m.job_id
  ),
  pos AS (
    SELECT p.job_id, jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'po_number', p.po_number, 'supplier', left(p.supplier_name, 120), 'status', p.status,
             'delivery', COALESCE(p.confirmed_delivery_date, p.delivery_date), 'source', p.source))
             ORDER BY p.created_at, p.po_number) FILTER (WHERE p.rn <= 15) AS list
      FROM (SELECT po.*, row_number() OVER (PARTITION BY po.job_id ORDER BY po.created_at, po.po_number) AS rn
              FROM public.purchase_orders po, ids
             WHERE po.job_id = ANY (ids.a)
               AND COALESCE(lower(po.status), '') NOT IN ('deleted', 'cancelled', 'canceled', 'voided', 'void')) p
     GROUP BY p.job_id
  ),
  asg AS (
    SELECT a.job_id, a.scheduled_date, a.scheduled_end, a.assignment_type, a.status,
           COALESCE(NULLIF(btrim(u.name), ''), NULLIF(btrim(a.crew_name), '')) AS crew,
           (COALESCE(a.is_ghost, false) OR COALESCE(a.role, '') = 'observer') AS mirror
      FROM public.job_assignments a
      JOIN ids ON a.job_id = ANY (ids.a)
      LEFT JOIN public.users u ON u.id = a.user_id
     WHERE COALESCE(a.status, '') <> 'cancelled'
  ),
  crew AS (
    SELECT c.job_id,
           jsonb_agg(jsonb_strip_nulls(jsonb_build_object('day', c.scheduled_date, 'end', c.scheduled_end,
                     'type', c.assignment_type, 'crew', left(c.crew, 80), 'status', c.status))
                     ORDER BY c.scheduled_date NULLS LAST, c.crew) FILTER (WHERE c.rn <= 12) AS list,
           min(c.scheduled_date) AS first_day,
           max(COALESCE(c.scheduled_end, c.scheduled_date)) AS last_day
      FROM (SELECT asg.*, row_number() OVER (PARTITION BY asg.job_id ORDER BY asg.scheduled_date NULLS LAST, asg.crew) AS rn
              FROM asg WHERE NOT asg.mirror) c
     GROUP BY c.job_id
  ),
  -- The bill reader's own first booked day, unchanged: any assignment that is
  -- not cancelled, ghost rows included (20261028173000).
  booked AS (
    SELECT asg.job_id, min(asg.scheduled_date) AS first_day FROM asg GROUP BY asg.job_id
  ),
  wo AS (
    SELECT w.job_id, jsonb_strip_nulls(jsonb_build_object('number', w.wo_number, 'status', w.status,
             'approved', w.approved_at::date)) AS wo
      FROM public.work_orders w, ids
     WHERE w.job_id = ANY (ids.a) AND w.kind = 'job'
  ),
  xp AS (
    SELECT x.job_id, jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name', left(x.project_name, 120), 'status', x.status,
             'own', x.own)) ORDER BY x.own DESC, x.project_name) FILTER (WHERE x.rn <= 3) AS list
      FROM (SELECT p.job_id, p.project_name, p.status,
                   -- Job Profit's rule: a Xero Project is the job's own only when its name carries the job's number.
                   COALESCE(btrim(j.job_number) <> ''
                            AND upper(p.project_name) ~ (regexp_replace(upper(btrim(j.job_number)), '([^A-Z0-9])', '\\\1', 'g') || '(?![0-9])'),
                            false) AS own,
                   row_number() OVER (PARTITION BY p.job_id ORDER BY p.project_name) AS rn
              FROM public.xero_projects p
              JOIN j ON j.id = p.job_id) x
     GROUP BY x.job_id
  ),
  billed AS (
    SELECT b.job_id, jsonb_agg(jsonb_strip_nulls(jsonb_build_object('supplier', left(b.supplier, 120),
             'xero_contact_id', b.xero_contact_id, 'bills', b.bills, 'by_ai', NULLIF(b.by_ai, 0), 'last', b.last))
             ORDER BY b.last DESC NULLS LAST, b.supplier) FILTER (WHERE b.rn <= 10) AS list
      FROM (SELECT g.*, row_number() OVER (PARTITION BY g.job_id ORDER BY g.last DESC NULLS LAST, g.supplier) AS rn
              FROM (SELECT f.job_id, max(f.contact_name) AS supplier, max(f.xero_contact_id) AS xero_contact_id,
                           count(DISTINCT f.xero_invoice_id) AS bills,
                           count(DISTINCT f.xero_invoice_id) FILTER (WHERE f.automation_source = 'agent_ai') AS by_ai,
                           max(f.fact_date) AS last
                      FROM public.job_materials_facts f, ids
                     WHERE f.job_id = ANY (ids.a)
                     GROUP BY f.job_id, COALESCE(f.xero_contact_id, lower(btrim(f.contact_name)))) g) b
     GROUP BY b.job_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'job_id', j.id,
           'job_number', j.job_number,
           'type', j.type,
           'status', j.status,
           'client', left(j.client_name, 120),
           'site', left(concat_ws(', ', NULLIF(btrim(j.site_address), ''), NULLIF(btrim(j.site_suburb), '')), 200),
           'created', j.created_at::date,
           'scheduled', bk.first_day,
           'client_names', nm.names,
           'contacts', jsonb_build_object('phones', COALESCE(ct.phones, 0), 'emails', COALESCE(ct.emails, 0),
                                          'phone_match', CASE WHEN pk.a IS NOT NULL THEN COALESCE(ct.phone_match, false) END,
                                          'email_match', CASE WHEN ek.a IS NOT NULL THEN COALESCE(ct.email_match, false) END),
           'suburb', NULLIF(btrim(j.site_suburb), ''),
           'site_key', public.context_address_key(j.site_address),
           'site_loose_keys', to_jsonb(public.context_address_loose_keys(j.site_address)),
           'scope', NULLIF(s.scope, '{}'::jsonb),
           'materials', m.list,
           'supplier_orders', so.list,
           'purchase_orders', po.list,
           'crew', cr.list,
           'on_site', CASE WHEN cr.first_day IS NOT NULL THEN jsonb_build_object('first', cr.first_day, 'last', cr.last_day) END,
           'work_order', w.wo,
           'xero_projects', x.list,
           'suppliers_billed', b.list
         )) ORDER BY j.job_number, j.id), '[]'::jsonb)
    FROM j
    CROSS JOIN pk
    CROSS JOIN ek
    LEFT JOIN contacts ct ON ct.job_id = j.id
    LEFT JOIN names nm ON nm.job_id = j.id
    LEFT JOIN scope s ON s.job_id = j.id
    LEFT JOIN materials m ON m.job_id = j.id
    LEFT JOIN supplier_orders so ON so.job_id = j.id
    LEFT JOIN pos po ON po.job_id = j.id
    LEFT JOIN crew cr ON cr.job_id = j.id
    LEFT JOIN booked bk ON bk.job_id = j.id
    LEFT JOIN wo w ON w.job_id = j.id
    LEFT JOIN xp x ON x.job_id = j.id
    LEFT JOIN billed b ON b.job_id = j.id
$$;
COMMENT ON FUNCTION public.context_job_picture(uuid[], text[], text[]) IS
  'Job picture (20261029200000): TP-04, one figure-free object per given live job (a job number, not cancelled or lost, not a holding job by lower(metadata->>do_not_schedule) = true): number, type, status, client and party names, contact counts and, only for keys the caller passes, phone_match / email_match (no phone or email is returned, INT-01), the B0 site address keys, named scope keys (never the scope_json blob or a money key), Materials by supplier lines, supplier boxes, purchase orders, real crew bookings and days on site, the job work order, Xero Projects, and suppliers already billed. No amounts. Read only, service role only. Every placer reads its job fields from here.';
REVOKE ALL ON FUNCTION public.context_job_picture(uuid[], text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_picture(uuid[], text[], text[]) TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 2. The bill placer reads it
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.materials_ai_candidate_jobs(p_from date, p_to date)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  -- Which jobs: alive around the bills' dates (20261028173000's window,
  -- unchanged). Which of them are live, and every field: the job picture.
  WITH window_jobs AS (
    SELECT j.id
      FROM public.jobs j
     -- Made before the bill (plus a week: a bill can arrive dated before the card)
     WHERE j.created_at < (COALESCE(p_to, current_date) + 7)
       -- and alive around it: made in the half year before it, or booked on site
       -- from two months before to four months after it, or still open today.
       -- updated_at is not used: any later touch moves it, so every finished job
       -- would read as alive and the list would hold the whole company.
       AND (j.created_at >= (COALESCE(p_from, current_date) - 180)
            OR EXISTS (SELECT 1 FROM public.job_assignments a
                        WHERE a.job_id = j.id AND COALESCE(a.status, '') <> 'cancelled'
                          AND a.scheduled_date BETWEEN (COALESCE(p_from, current_date) - 60) AND (COALESCE(p_to, current_date) + 120))
            OR lower(COALESCE(j.status, '')) NOT IN ('archived', 'complete', 'completed', 'invoiced', 'final_payment', 'get_review', 'draft'))
  )
  SELECT COALESCE(jsonb_agg(p.e ORDER BY p.e ->> 'job_number'), '[]'::jsonb)
    FROM jsonb_array_elements(public.context_job_picture(ARRAY(SELECT w.id FROM window_jobs w))) p(e)
$$;
COMMENT ON FUNCTION public.materials_ai_candidate_jobs(date, date) IS
  'AI bill reader candidates (20261028173000; from 20261029200000 read from context_job_picture): the live jobs a bill dated in the window may belong to. Keys job_id, job_number, type, status, client, site, created, scheduled as before, plus the job picture''s fields. Service role only.';
REVOKE ALL ON FUNCTION public.materials_ai_candidate_jobs(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materials_ai_candidate_jobs(date, date) TO service_role;
