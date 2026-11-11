-- Earlier cases provide every other table this migration reads. scope_artifacts
-- is not in the registered stack, so a minimal copy of the columns this
-- migration reads is created here (the real table, 20260504090757, has these
-- with the same names, checks and append-only rule).
CREATE TABLE IF NOT EXISTS public.scope_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_revision_id uuid NOT NULL REFERENCES public.scope_revisions(id) ON DELETE RESTRICT,
  artifact_type text NOT NULL CHECK (artifact_type IN (
    'render_hero','render_front','render_side','render_site_plan',
    'render_riser','render_post_detail','render_profile','render_3d_scene',
    'quote_pdf','per_contact_pdf','work_order_pdf','material_order_pdf',
    'model_glb','drawing','render_gutter_detail','render_ridge_detail')),
  storage_path text NOT NULL,
  bucket_id text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  content_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
