-- Rollback for 20261112210000_scope_artifacts_customer_model: takes
-- 'customer_model' and application/json back out, and only what that
-- migration added.
--
-- REQUIRED INPUT. Before applying the migration, the person applying it reads
-- the bucket's file-type list and keeps the answer:
--
--   SELECT allowed_mime_types::text AS kept_mime_types
--     FROM storage.buckets WHERE id = 'scope-artifacts';
--
-- To undo, paste that kept text exactly in place of KEPT_LIST_NOT_GIVEN below
-- (for example {image/png,image/jpeg,application/pdf,model/gltf-binary}; write
-- NULL if the answer was empty). The undo restores exactly that list. It never
-- works the list out from the current one.
--
-- It refuses, changing nothing, when:
--   1. no kept list was given, or it does not read as a list;
--   2. any customer_model row exists (scope_artifacts is append-only, so a
--      saved model is never deleted to make the rollback pass);
--   3. scope_artifacts_artifact_type_check is not exactly the 17-value list
--      the migration wrote (another lane's later value is never dropped);
--   4. the bucket's list is not exactly what the migration made of the kept
--      list (the kept list plus application/json at the end, or the kept list
--      unchanged when it already allowed JSON or was empty), so a change made
--      after the migration is never undone by mistake.

BEGIN;

DO $$
DECLARE
  v_kept_text constant text := 'KEPT_LIST_NOT_GIVEN';
  v_kept text[];
  v_left text[];
  v_now text[];
  v_def text;
  v_after constant text := 'CHECK ((artifact_type = ANY (ARRAY[''render_hero''::text, ''render_front''::text, ''render_side''::text, ''render_site_plan''::text, ''render_riser''::text, ''render_post_detail''::text, ''render_profile''::text, ''render_3d_scene''::text, ''quote_pdf''::text, ''per_contact_pdf''::text, ''work_order_pdf''::text, ''material_order_pdf''::text, ''model_glb''::text, ''drawing''::text, ''render_gutter_detail''::text, ''render_ridge_detail''::text, ''customer_model''::text])))';
BEGIN
  IF v_kept_text IS NULL OR btrim(v_kept_text) = '' OR v_kept_text = 'KEPT_LIST_NOT_GIVEN' THEN
    RAISE EXCEPTION 'no kept file-type list given (read before the migration was applied); refusing to roll back';
  END IF;
  IF upper(btrim(v_kept_text)) = 'NULL' THEN
    v_kept := NULL;
  ELSE
    BEGIN
      v_kept := v_kept_text::text[];
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'kept file-type list does not read as a list: %; refusing to roll back', v_kept_text;
    END;
  END IF;

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

  -- What the migration made of the kept list (its own UPDATE, line for line).
  v_left := CASE
    WHEN v_kept IS NULL OR 'application/json' = ANY (v_kept) THEN v_kept
    ELSE array_append(v_kept, 'application/json')
  END;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'scope-artifacts') THEN
    RAISE EXCEPTION 'scope-artifacts bucket missing; refusing to roll back';
  END IF;
  SELECT b.allowed_mime_types INTO v_now FROM storage.buckets b WHERE b.id = 'scope-artifacts';
  IF v_now IS DISTINCT FROM v_left THEN
    RAISE EXCEPTION 'scope-artifacts file types are not what 20261112210000 made of the kept list; refusing to roll back. Found: %, expected: %',
      coalesce(v_now::text, 'NULL'), coalesce(v_left::text, 'NULL');
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
     SET allowed_mime_types = v_kept
   WHERE id = 'scope-artifacts'
     AND allowed_mime_types IS NOT DISTINCT FROM v_left;
END
$$;

COMMIT;
