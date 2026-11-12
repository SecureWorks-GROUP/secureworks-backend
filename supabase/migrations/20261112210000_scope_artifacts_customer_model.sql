-- Customer 3D view, stage E1 (director's ruling 6, 12 Nov 2026).
--
-- The scoping tool saves the customer 3D page's model as a scope artifact
-- beside the sealed revision (artifact_type 'customer_model', content type
-- application/json). send-quote/model serves it to the customer by the quote
-- link's token. Two things refuse that save today:
--   1. scope_artifacts_artifact_type_check has no 'customer_model'.
--   2. the private scope-artifacts bucket allows no application/json.
--
-- This migration adds both. It is a strict superset: no value is removed, so
-- every existing row still passes, and no row is written. It refuses to run
-- over a check it does not recognise (another lane changed the list), so it
-- never drops a value someone else added. Re-running it changes nothing.
--
-- Apply this BEFORE the customer 3D page is switched on in the tool, and read
-- it back (query in the PR). Rollback: supabase/rollbacks/
-- 20261112210000_scope_artifacts_customer_model_down.sql.

BEGIN;

DO $$
DECLARE
  v_def text;
  v_before constant text := 'CHECK ((artifact_type = ANY (ARRAY[''render_hero''::text, ''render_front''::text, ''render_side''::text, ''render_site_plan''::text, ''render_riser''::text, ''render_post_detail''::text, ''render_profile''::text, ''render_3d_scene''::text, ''quote_pdf''::text, ''per_contact_pdf''::text, ''work_order_pdf''::text, ''material_order_pdf''::text, ''model_glb''::text, ''drawing''::text, ''render_gutter_detail''::text, ''render_ridge_detail''::text])))';
  v_after constant text := 'CHECK ((artifact_type = ANY (ARRAY[''render_hero''::text, ''render_front''::text, ''render_side''::text, ''render_site_plan''::text, ''render_riser''::text, ''render_post_detail''::text, ''render_profile''::text, ''render_3d_scene''::text, ''quote_pdf''::text, ''per_contact_pdf''::text, ''work_order_pdf''::text, ''material_order_pdf''::text, ''model_glb''::text, ''drawing''::text, ''render_gutter_detail''::text, ''render_ridge_detail''::text, ''customer_model''::text])))';
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.scope_artifacts'::regclass
     AND c.conname = 'scope_artifacts_artifact_type_check';

  IF v_def = v_after THEN
    RETURN; -- already applied
  END IF;
  IF v_def IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'scope_artifacts_artifact_type_check is not the expected 16-value list; refusing to replace it. Found: %', coalesce(v_def, '(missing)');
  END IF;

  ALTER TABLE public.scope_artifacts DROP CONSTRAINT scope_artifacts_artifact_type_check;
  ALTER TABLE public.scope_artifacts ADD CONSTRAINT scope_artifacts_artifact_type_check CHECK (
    artifact_type = ANY (ARRAY[
      'render_hero','render_front','render_side','render_site_plan',
      'render_riser','render_post_detail','render_profile','render_3d_scene',
      'quote_pdf','per_contact_pdf','work_order_pdf','material_order_pdf',
      'model_glb','drawing',
      'render_gutter_detail','render_ridge_detail',
      'customer_model'
    ]::text[])
  );
END
$$;

-- The bucket stays private; only the allowed content types widen.
UPDATE storage.buckets
   SET allowed_mime_types = array_append(allowed_mime_types, 'application/json')
 WHERE id = 'scope-artifacts'
   AND allowed_mime_types IS NOT NULL
   AND NOT ('application/json' = ANY (allowed_mime_types));

COMMIT;
