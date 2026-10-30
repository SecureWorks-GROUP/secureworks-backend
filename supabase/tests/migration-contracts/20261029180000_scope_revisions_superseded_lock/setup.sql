-- Prerequisites for 20261029180000_scope_revisions_superseded_lock (JP-24).
-- Only what the migration touches: scope_revisions with every column its
-- trigger reads, and the 20260504090757 guard it replaces. Idempotent, and
-- compatible with earlier setups (20261029123500 creates a narrower
-- scope_revisions; the columns it lacks are added here, nullable). The
-- 20260504090757 no-delete trigger is deliberately not installed: no contract
-- here needs it and an earlier case's delete proof expects the foreign key to
-- refuse first.

CREATE TABLE IF NOT EXISTS public.jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS type text,
  ADD COLUMN IF NOT EXISTS job_number text;

CREATE TABLE IF NOT EXISTS public.scope_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  revision_number int NOT NULL CHECK (revision_number >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','frozen','superseded')),
  UNIQUE (job_id, revision_number)
);
ALTER TABLE public.scope_revisions
  ADD COLUMN IF NOT EXISTS tool_kind text,
  ADD COLUMN IF NOT EXISTS scope_canonical_text text,
  ADD COLUMN IF NOT EXISTS scope_hash text,
  ADD COLUMN IF NOT EXISTS pricing_canonical_text text,
  ADD COLUMN IF NOT EXISTS pricing_hash text,
  ADD COLUMN IF NOT EXISTS renderer_version text,
  ADD COLUMN IF NOT EXISTS tool_version text,
  ADD COLUMN IF NOT EXISTS model_manifest_json jsonb,
  ADD COLUMN IF NOT EXISTS model_manifest_hash text,
  ADD COLUMN IF NOT EXISTS frozen_at timestamptz,
  ADD COLUMN IF NOT EXISTS frozen_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS superseded_by_scope_revision_id uuid REFERENCES public.scope_revisions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  ADD COLUMN IF NOT EXISTS spine_event_id uuid,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- The 20260504090757 guard, byte for byte, only when no guard exists yet.
DO $setup$
BEGIN
  IF to_regprocedure('public.scope_revisions_controlled_immutable()') IS NULL THEN
    EXECUTE $fn$
CREATE OR REPLACE FUNCTION public.scope_revisions_controlled_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Status transition rules first (cheapest checks).
  IF OLD.status = 'superseded' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'scope_revisions: superseded is terminal (row %)', OLD.id
      USING errcode = '23514';
  END IF;
  IF OLD.status = 'frozen' AND NEW.status NOT IN ('frozen','superseded') THEN
    RAISE EXCEPTION 'scope_revisions: frozen may only transition to superseded (row %)', OLD.id
      USING errcode = '23514';
  END IF;

  -- Once frozen, contract columns are locked. IS DISTINCT FROM is required so
  -- nullable columns compare correctly when NEW.x is NULL.
  IF OLD.status = 'frozen' THEN
    IF NEW.id                     IS DISTINCT FROM OLD.id
       OR NEW.job_id              IS DISTINCT FROM OLD.job_id
       OR NEW.revision_number     IS DISTINCT FROM OLD.revision_number
       OR NEW.tool_kind           IS DISTINCT FROM OLD.tool_kind
       OR NEW.scope_canonical_text   IS DISTINCT FROM OLD.scope_canonical_text
       OR NEW.scope_hash             IS DISTINCT FROM OLD.scope_hash
       OR NEW.pricing_canonical_text IS DISTINCT FROM OLD.pricing_canonical_text
       OR NEW.pricing_hash           IS DISTINCT FROM OLD.pricing_hash
       OR NEW.renderer_version    IS DISTINCT FROM OLD.renderer_version
       OR NEW.tool_version        IS DISTINCT FROM OLD.tool_version
       OR NEW.model_manifest_json IS DISTINCT FROM OLD.model_manifest_json
       OR NEW.model_manifest_hash IS DISTINCT FROM OLD.model_manifest_hash
       OR NEW.frozen_at           IS DISTINCT FROM OLD.frozen_at
       OR NEW.frozen_by_user_id   IS DISTINCT FROM OLD.frozen_by_user_id
       OR NEW.created_at          IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'scope_revisions: row % is frozen; only supersession + spine_event_id may change', OLD.id
        USING errcode = '23514';
    END IF;

    -- Supersession backref + spine_event_id: NULL -> NOT NULL only.
    IF OLD.superseded_by_scope_revision_id IS NOT NULL
       AND NEW.superseded_by_scope_revision_id IS DISTINCT FROM OLD.superseded_by_scope_revision_id THEN
      RAISE EXCEPTION 'scope_revisions: superseded_by_scope_revision_id may only transition NULL -> NOT NULL (row %)', OLD.id
        USING errcode = '23514';
    END IF;
    IF OLD.superseded_at IS NOT NULL
       AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
      RAISE EXCEPTION 'scope_revisions: superseded_at may only transition NULL -> NOT NULL (row %)', OLD.id
        USING errcode = '23514';
    END IF;
    IF OLD.spine_event_id IS NOT NULL
       AND NEW.spine_event_id IS DISTINCT FROM OLD.spine_event_id THEN
      RAISE EXCEPTION 'scope_revisions: spine_event_id may only transition NULL -> NOT NULL (row %)', OLD.id
        USING errcode = '23514';
    END IF;
  END IF;

  -- Sanity: a row cannot enter 'frozen' without frozen_at + sane hashes.
  IF (OLD.status IS DISTINCT FROM 'frozen') AND NEW.status = 'frozen' THEN
    IF NEW.frozen_at IS NULL THEN
      RAISE EXCEPTION 'scope_revisions: cannot transition to frozen without frozen_at (row %)', OLD.id
        USING errcode = '23514';
    END IF;
  END IF;

  -- Sanity: superseded transition requires the supersession columns set in
  -- the same UPDATE.
  IF (OLD.status = 'frozen') AND NEW.status = 'superseded' THEN
    IF NEW.superseded_by_scope_revision_id IS NULL OR NEW.superseded_at IS NULL THEN
      RAISE EXCEPTION 'scope_revisions: supersede requires superseded_by_scope_revision_id and superseded_at (row %)', OLD.id
        USING errcode = '23514';
    END IF;
  END IF;

  NEW.updated_at = now();
  RETURN NEW;
END;
$$
$fn$;
    EXECUTE 'CREATE TRIGGER trg_scope_revisions_controlled_immutable BEFORE UPDATE ON public.scope_revisions FOR EACH ROW EXECUTE FUNCTION public.scope_revisions_controlled_immutable()';
  END IF;
END $setup$;
