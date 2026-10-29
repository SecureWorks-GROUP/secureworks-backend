-- Customer 3D page (sales, 26 Oct 2026): one more artefact per frozen scope revision.
--
-- The patio scoping tool writes the customer's 3D model (geometry and colours only:
-- no prices, product names, part ids or customer details) as a small JSON file next
-- to the revision's renders in the private scope-artifacts bucket. send-quote's
-- `model` route serves it to the customer by the quote's own share_token, so no
-- second customer token is minted and nothing is public.
--
-- Additive only:
--   1. artifact_type 'customer_model' joins the scope_artifacts CHECK (same name).
--   2. 'application/json' joins the scope-artifacts bucket's allowed types.
--   3. feature_flags 'customer_3d_page_v1', OFF. Off, missing or unreadable: the
--      route answers not available and the quote page shows no 3D link.
-- Turning the flag on is the owner's word: it is a new customer-facing page.
-- Rollback: supabase/rollbacks/20261026051700_customer_3d_model_artifact_down.sql

BEGIN;

ALTER TABLE public.scope_artifacts
  DROP CONSTRAINT IF EXISTS scope_artifacts_artifact_type_check;

ALTER TABLE public.scope_artifacts
  ADD CONSTRAINT scope_artifacts_artifact_type_check CHECK (
    artifact_type = ANY (ARRAY[
      'render_hero',
      'render_front',
      'render_side',
      'render_site_plan',
      'render_riser',
      'render_post_detail',
      'render_profile',
      'render_3d_scene',
      'quote_pdf',
      'per_contact_pdf',
      'work_order_pdf',
      'material_order_pdf',
      'model_glb',
      'drawing',
      'render_gutter_detail',
      'render_ridge_detail',
      'customer_model'
    ]::text[])
  );

UPDATE storage.buckets
SET allowed_mime_types = array_append(allowed_mime_types, 'application/json')
WHERE id = 'scope-artifacts'
  AND NOT ('application/json' = ANY (allowed_mime_types));

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT
  'customer_3d_page_v1',
  false,
  'Customer 3D page: send-quote/model serves a frozen revision''s customer_model to the holder of that quote''s share_token, and the quote page links to it. Off until the owner says yes to a new customer page.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.feature_flags WHERE flag_name = 'customer_3d_page_v1'
);

COMMIT;
