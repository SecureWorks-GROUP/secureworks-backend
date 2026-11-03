-- Down for 20261026051700_customer_3d_model_artifact.sql.
-- Refuses while any customer_model row exists: deleting artefact rows is not a rollback's call.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.scope_artifacts WHERE artifact_type = 'customer_model') THEN
    RAISE EXCEPTION 'customer_model artefacts exist; remove them deliberately before rolling back';
  END IF;
END $$;

ALTER TABLE public.scope_artifacts
  DROP CONSTRAINT IF EXISTS scope_artifacts_artifact_type_check;

ALTER TABLE public.scope_artifacts
  ADD CONSTRAINT scope_artifacts_artifact_type_check CHECK (
    artifact_type = ANY (ARRAY[
      'render_hero', 'render_front', 'render_side', 'render_site_plan',
      'render_riser', 'render_post_detail', 'render_profile', 'render_3d_scene',
      'quote_pdf', 'per_contact_pdf', 'work_order_pdf', 'material_order_pdf',
      'model_glb', 'drawing', 'render_gutter_detail', 'render_ridge_detail'
    ]::text[])
  );

UPDATE storage.buckets
SET allowed_mime_types = array_remove(allowed_mime_types, 'application/json')
WHERE id = 'scope-artifacts';

DELETE FROM public.feature_flags WHERE flag_name = 'customer_3d_page_v1' AND enabled = false;

COMMIT;
