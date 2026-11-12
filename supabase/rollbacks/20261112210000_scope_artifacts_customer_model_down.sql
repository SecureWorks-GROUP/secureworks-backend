-- Rollback for 20261112210000_scope_artifacts_customer_model: takes
-- 'customer_model' and application/json back out. Refuses while any
-- customer_model row exists (scope_artifacts is append-only, so a saved model
-- is never deleted to make the rollback pass).

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.scope_artifacts WHERE artifact_type = 'customer_model') THEN
    RAISE EXCEPTION 'customer_model artifacts exist; refusing to roll back';
  END IF;
END
$$;

ALTER TABLE public.scope_artifacts DROP CONSTRAINT IF EXISTS scope_artifacts_artifact_type_check;
ALTER TABLE public.scope_artifacts ADD CONSTRAINT scope_artifacts_artifact_type_check CHECK (
  artifact_type = ANY (ARRAY[
    'render_hero','render_front','render_side','render_site_plan',
    'render_riser','render_post_detail','render_profile','render_3d_scene',
    'quote_pdf','per_contact_pdf','work_order_pdf','material_order_pdf',
    'model_glb','drawing',
    'render_gutter_detail','render_ridge_detail'
  ]::text[])
);

UPDATE storage.buckets
   SET allowed_mime_types = array_remove(allowed_mime_types, 'application/json')
 WHERE id = 'scope-artifacts';

COMMIT;
