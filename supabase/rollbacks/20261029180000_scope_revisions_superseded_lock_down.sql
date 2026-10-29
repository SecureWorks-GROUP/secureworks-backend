-- Down for 20261029180000_scope_revisions_superseded_lock (JP-24).
-- Restores the 20260504090757 body of scope_revisions_controlled_immutable
-- byte for byte (md5 of prosrc e2bcfa102c4db84b414f334eb4f7dadf) and drops the
-- INSERT guard. It reads, changes and deletes no row.

BEGIN;

DO $$
DECLARE
  live_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO live_md5
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'scope_revisions_controlled_immutable';
  IF live_md5 IS DISTINCT FROM 'b5275b79eb979c9215db5b46315685f7'
     AND live_md5 IS DISTINCT FROM 'e2bcfa102c4db84b414f334eb4f7dadf' THEN
    RAISE EXCEPTION 'scope_revisions_superseded_lock down: live body % is neither this migration''s nor the 20260504090757 body', live_md5;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_scope_revisions_insert_lifecycle ON public.scope_revisions;
DROP FUNCTION IF EXISTS public.scope_revisions_insert_lifecycle();

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
$$;

DROP TRIGGER IF EXISTS trg_scope_revisions_controlled_immutable ON public.scope_revisions;
CREATE TRIGGER trg_scope_revisions_controlled_immutable
  BEFORE UPDATE ON public.scope_revisions
  FOR EACH ROW EXECUTE FUNCTION public.scope_revisions_controlled_immutable();

COMMIT;
