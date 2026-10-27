-- Down for 20261023214200_dispatch_v2_emails_draft_list_and_order_emails. Roll ops-api back first:
-- the dispatch_v2_* actions name every object below.
--
-- Draft-list lines (supplier_id empty) cannot live under the old NOT NULL rule, so they are deleted
-- before the rule comes back. Sent supplier order emails and photos are deleted with their tables;
-- the photo files stay in the private bucket dispatch-material-photos (storage rows are not dropped
-- by SQL here, so nothing a person uploaded is lost by accident). The bucket itself is left.
DROP INDEX IF EXISTS public.job_material_suppliers_one_main_idx;
ALTER TABLE public.job_material_suppliers DROP COLUMN IF EXISTS is_main_supplier;

DROP TABLE IF EXISTS public.dispatch_material_photos;

ALTER TABLE public.job_material_lines DROP COLUMN IF EXISTS dispatch_order_email_id;
ALTER TABLE public.job_material_lines DROP CONSTRAINT IF EXISTS job_material_lines_detail_length;
ALTER TABLE public.job_material_lines DROP CONSTRAINT IF EXISTS job_material_lines_profile_length;
ALTER TABLE public.job_material_lines DROP CONSTRAINT IF EXISTS job_material_lines_colour_length;
ALTER TABLE public.job_material_lines DROP COLUMN IF EXISTS detail;
ALTER TABLE public.job_material_lines DROP COLUMN IF EXISTS profile;
ALTER TABLE public.job_material_lines DROP COLUMN IF EXISTS colour;
DELETE FROM public.job_material_lines WHERE supplier_id IS NULL;
ALTER TABLE public.job_material_lines ALTER COLUMN supplier_id SET NOT NULL;
COMMENT ON COLUMN public.job_material_lines.supplier_id IS NULL;

DROP TABLE IF EXISTS public.dispatch_supplier_order_emails;
