-- Rollback for 20261112210000_scope_artifacts_customer_model: takes
-- 'customer_model' and application/json back out, and only what that
-- migration added. It refuses, changing nothing, unless the database is
-- exactly as the migration left it:
--   1. no customer_model row exists (scope_artifacts is append-only, so a
--      saved model is never deleted to make the rollback pass);
--   2. scope_artifacts_artifact_type_check is exactly the 17-value list the
--      migration wrote (another lane's later value is never dropped);
--   3. the scope-artifacts bucket's allowed types are exactly the list the
--      migration left: the four it found plus application/json (JSON allowed
--      by anyone else, or any other change, is never taken out).

BEGIN;

DO $$
DECLARE
  v_def text;
  v_mimes text[];
  v_after constant text := 'CHECK ((artifact_type = ANY (ARRAY[''render_hero''::text, ''render_front''::text, ''render_side''::text, ''render_site_plan''::text, ''render_riser''::text, ''render_post_detail''::text, ''render_profile''::text, ''render_3d_scene''::text, ''quote_pdf''::text, ''per_contact_pdf''::text, ''work_order_pdf''::text, ''material_order_pdf''::text, ''model_glb''::text, ''drawing''::text, ''render_gutter_detail''::text, ''render_ridge_detail''::text, ''customer_model''::text])))';
  v_mimes_after constant text[] := ARRAY['image/png','image/jpeg','application/pdf','model/gltf-binary','application/json']::text[];
BEGIN
  IF EXISTS (SELECT 1 FROM public.scope_artifacts WHERE artifact_type = 'customer_model') THEN
    RAISE EXCEPTION 'customer_model artifacts exist; refusing to roll back';
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.scope_artifacts'::regclass
     AND c.conname = 'scope_artifacts_artifact_type_check';
  IF v_def IS DISTINCT FROM v_after THEN
    RAISE EXCEPTION 'scope_artifacts_artifact_type_check is not the list 20261112210000 left; refusing to roll back. Found: %', coalesce(v_def, '(missing)');
  END IF;

  SELECT b.allowed_mime_types INTO v_mimes
    FROM storage.buckets b
   WHERE b.id = 'scope-artifacts';
  IF v_mimes IS DISTINCT FROM v_mimes_after THEN
    RAISE EXCEPTION 'scope-artifacts allowed types are not the list 20261112210000 left; refusing to roll back. Found: %', coalesce(v_mimes::text, '(missing)');
  END IF;

  ALTER TABLE public.scope_artifacts DROP CONSTRAINT scope_artifacts_artifact_type_check;
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
     SET allowed_mime_types = ARRAY['image/png','image/jpeg','application/pdf','model/gltf-binary']::text[]
   WHERE id = 'scope-artifacts'
     AND allowed_mime_types = v_mimes_after;
END
$$;

COMMIT;
