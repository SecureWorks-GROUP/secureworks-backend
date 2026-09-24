-- S-M1 fixtures: bring the shared tables to the live shapes read from
-- production on 24 Sep 2026 (read-only), so the migration's guard runs against
-- production's starting point. Earlier registered cases already created jobs,
-- job_contacts (id, job_id, is_primary, client_email, client_phone,
-- ghl_contact_id), job_documents, xero_invoices, business_events,
-- feature_flags and context_capture_runs; this adds only what they omit.

-- job_contacts: exactly the nineteen live columns, RLS already on with no
-- policy, and every table privilege held by anon and authenticated (live).
ALTER TABLE public.job_contacts
 ADD COLUMN IF NOT EXISTS contact_type text NOT NULL DEFAULT 'primary',
 ADD COLUMN IF NOT EXISTS client_name text,
 ADD COLUMN IF NOT EXISTS xero_contact_id text,
 ADD COLUMN IF NOT EXISTS quote_value_ex_gst numeric(12,2) DEFAULT 0,
 ADD COLUMN IF NOT EXISTS amount_invoiced numeric(12,2) DEFAULT 0,
 ADD COLUMN IF NOT EXISTS amount_paid numeric(12,2) DEFAULT 0,
 ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN IF NOT EXISTS share_percentage numeric(5,2) DEFAULT 50,
 ADD COLUMN IF NOT EXISTS contact_label text DEFAULT 'A',
 ADD COLUMN IF NOT EXISTS assigned_runs jsonb,
 ADD COLUMN IF NOT EXISTS status text DEFAULT 'active',
 ADD COLUMN IF NOT EXISTS site_address text;
-- Two fixture-only differences from live, both outside what the guard pins
-- (names and types): client_name is nullable (live NOT NULL) and contact_label
-- defaults to a unique value (live 'A'), because the earlier D1 contract
-- inserts parties with neither, and this migration creates the unique
-- (job_id, contact_label) index live already satisfies (0 duplicate groups).
ALTER TABLE public.job_contacts ALTER COLUMN contact_label SET DEFAULT ('fx-'||gen_random_uuid()::text);
ALTER TABLE public.job_contacts ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.job_contacts TO anon,authenticated,service_role;

ALTER TABLE public.jobs
 ADD COLUMN IF NOT EXISTS client_name text,
 ADD COLUMN IF NOT EXISTS client_phone text,
 ADD COLUMN IF NOT EXISTS client_email text,
 ADD COLUMN IF NOT EXISTS ghl_contact_id text,
 ADD COLUMN IF NOT EXISTS xero_contact_id text,
 ADD COLUMN IF NOT EXISTS site_address text,
 ADD COLUMN IF NOT EXISTS site_suburb text,
 ADD COLUMN IF NOT EXISTS archived boolean,
 ADD COLUMN IF NOT EXISTS completed_at timestamptz,
 ADD COLUMN IF NOT EXISTS pricing_json jsonb,
 ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- run_line_items and view run_summary as 20260324000001 defines them: owner
-- postgres, no security_invoker, SELECT held by anon and authenticated as
-- under Supabase defaults.
CREATE TABLE IF NOT EXISTS public.run_line_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
 job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
 run_label text NOT NULL,
 job_contact_id uuid REFERENCES public.job_contacts(id) ON DELETE SET NULL,
 description text NOT NULL,
 quantity numeric NOT NULL DEFAULT 1,
 unit text,
 unit_price_ex numeric(12,2) NOT NULL DEFAULT 0,
 line_total_ex numeric(12,2) NOT NULL DEFAULT 0,
 allocation text NOT NULL DEFAULT 'shared',
 split_pct numeric(5,2) NOT NULL DEFAULT 50,
 allocation_note text,
 client_amount_ex numeric(12,2) NOT NULL DEFAULT 0,
 neighbour_amount_ex numeric(12,2) NOT NULL DEFAULT 0,
 sort_order integer DEFAULT 0
);
CREATE OR REPLACE VIEW public.run_summary AS
SELECT rli.job_id,rli.run_label,rli.job_contact_id,jc.client_name AS neighbour_name,jc.site_address AS neighbour_address,
 j.job_number,j.client_name AS client_name,j.site_address AS client_address,COUNT(*) AS item_count,
 SUM(rli.line_total_ex) AS run_total_ex,SUM(rli.client_amount_ex) AS client_total_ex,SUM(rli.neighbour_amount_ex) AS neighbour_total_ex,
 ROUND(SUM(rli.line_total_ex)*1.1,2) AS run_total_inc,ROUND(SUM(rli.client_amount_ex)*1.1,2) AS client_total_inc,
 ROUND(SUM(rli.neighbour_amount_ex)*1.1,2) AS neighbour_total_inc
FROM public.run_line_items rli
JOIN public.jobs j ON j.id=rli.job_id
LEFT JOIN public.job_contacts jc ON jc.id=rli.job_contact_id
GROUP BY rli.job_id,rli.run_label,rli.job_contact_id,jc.client_name,jc.site_address,j.job_number,j.client_name,j.site_address;
ALTER VIEW public.run_summary OWNER TO postgres;
GRANT SELECT ON TABLE public.run_summary TO anon,authenticated,service_role;
GRANT SELECT ON TABLE public.run_line_items,public.jobs TO service_role;

ALTER TABLE public.xero_invoices
 ADD COLUMN IF NOT EXISTS job_contact_id uuid,
 ADD COLUMN IF NOT EXISTS xero_contact_id text,
 ADD COLUMN IF NOT EXISTS invoice_number text,
 ADD COLUMN IF NOT EXISTS reference text,
 ADD COLUMN IF NOT EXISTS invoice_date date,
 ADD COLUMN IF NOT EXISTS fully_paid_on date,
 ADD COLUMN IF NOT EXISTS line_items jsonb;

CREATE TABLE IF NOT EXISTS public.run_acceptances (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
 job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
 job_contact_id uuid NOT NULL REFERENCES public.job_contacts(id) ON DELETE CASCADE,
 run_label text NOT NULL,
 status text NOT NULL DEFAULT 'pending',
 accepted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);

-- Rows that exist BEFORE the migration, so the contract can prove it writes
-- none of them: sites S5, SWF-261105 (56 Galwey St, archived; stored as
-- S5-SWF-261105 because the B0 census contract inserts SWF-261105), with its owner
-- (label A) and its neighbour on the reusable fence key nb-1 (label B, GHL id
-- from the design's row). Synthetic names and phones.
INSERT INTO public.jobs(id,org_id,status,type,job_number,client_name,client_phone,client_email,ghl_contact_id,xero_contact_id,
 site_address,site_suburb,archived,created_at,updated_at)
VALUES('1694c4a9-4641-4e74-ba8b-78b2e54b8d1d','00000000-0000-0000-0000-000000000001','archived','fencing','S5-SWF-261105',
 'S5 Owner Party','0411 000 105','s5-owner@example.test','rWobjdrej9tYNYq24B0Q','59092363-0000-4000-8000-000000000105',
 '56 Galwey St','Leederville',true,'2026-05-01 02:00:00+00','2026-09-12 02:00:00+00');
INSERT INTO public.job_contacts(id,job_id,contact_type,client_name,client_phone,client_email,ghl_contact_id,xero_contact_id,contact_label,is_primary,status,
 created_at,updated_at)
VALUES
 ('5e5c0000-0000-4000-8000-00000000005a','1694c4a9-4641-4e74-ba8b-78b2e54b8d1d','primary','S5 Owner Party','0411 000 105','s5-owner@example.test',
  'rWobjdrej9tYNYq24B0Q','59092363-0000-4000-8000-000000000105','A',true,'active','2026-05-01 02:00:00+00','2026-05-01 02:00:00+00'),
 ('5e5c0000-0000-4000-8000-00000000005b','1694c4a9-4641-4e74-ba8b-78b2e54b8d1d','neighbour_b','S5 Neighbour Party','0411 000 205','s5-neighbour@example.test',
  'Uki8zBjuAJSP5Em19ZsK','5995ed74-0000-4000-8000-000000000105','B',false,'active','2026-05-02 02:00:00+00','2026-05-02 02:00:00+00');

INSERT INTO public.run_line_items(job_id,run_label,job_contact_id,description,line_total_ex,client_amount_ex,neighbour_amount_ex)
VALUES('1694c4a9-4641-4e74-ba8b-78b2e54b8d1d','REAR','5e5c0000-0000-4000-8000-00000000005b','Rear fence',2000,1000,1000);

-- Prove the fixtures leave exactly the pre-image the guard pins.
DO $$
DECLARE cols text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_parties_status()')) IS DISTINCT FROM '155104bfb08b8b3c2f98bdec089d4ee4'
 THEN RAISE EXCEPTION 's-m1 setup: context_parties_status() is not the F1 stub'; END IF;
 SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attname) INTO cols
 FROM pg_attribute a WHERE a.attrelid='public.job_contacts'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 IF cols IS DISTINCT FROM 'amount_invoiced:numeric(12,2),amount_paid:numeric(12,2),assigned_runs:jsonb,client_email:text,client_name:text,client_phone:text,contact_label:text,contact_type:text,created_at:timestamp with time zone,ghl_contact_id:text,id:uuid,is_primary:boolean,job_id:uuid,quote_value_ex_gst:numeric(12,2),share_percentage:numeric(5,2),site_address:text,status:text,updated_at:timestamp with time zone,xero_contact_id:text'
 THEN RAISE EXCEPTION 's-m1 setup: job_contacts is not the live shape: %',cols; END IF;
 IF EXISTS (SELECT 1 FROM pg_index WHERE indrelid='public.job_contacts'::regclass AND indisunique AND NOT indisprimary)
 THEN RAISE EXCEPTION 's-m1 setup: job_contacts has a unique index production lacks'; END IF;
 IF NOT has_table_privilege('anon','public.run_summary','SELECT') OR NOT has_table_privilege('authenticated','public.run_summary','SELECT')
 THEN RAISE EXCEPTION 's-m1 setup: run_summary should be readable by the public key as live'; END IF;
 IF NOT has_table_privilege('anon','public.job_contacts','TRUNCATE') THEN RAISE EXCEPTION 's-m1 setup: anon should hold TRUNCATE as live'; END IF;
 IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name='job_parties_v1') THEN RAISE EXCEPTION 's-m1 setup: job_parties_v1 row exists'; END IF;
END $$;
