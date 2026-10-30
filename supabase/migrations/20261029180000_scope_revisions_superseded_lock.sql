-- JP-24: a superseded scope_revisions row is as fixed as a frozen one.
--
-- HELD. This migration is prepared for review only. It changes the lifecycle
-- guard on a quote-provenance table, so it needs a second-model review, a read
-- of the live function body, and Marnin's merge (a merge to main applies it).
--
-- Why
-- ---
-- scope_revisions_controlled_immutable (20260504090757) locks a row's contract
-- columns only while OLD.status = 'frozen'. A probe on a disposable copy of
-- that migration (29 Oct 2026, secureworks-projects
-- context-system/verify/evidence/20261029-scope-revisions-superseded-probe)
-- showed four writes it lets through:
--   * a superseded row kept superseded can change scope_hash, pricing_hash,
--     the canonical texts and job_id;
--   * a draft row can be updated straight to superseded, never frozen and with
--     no supersession link;
--   * a row can be INSERTed already superseded (there is no INSERT guard).
-- So a superseded row is not yet proof of what was frozen, and JP-24's quote
-- link (20261029123500) stores null for one. This migration closes those
-- writes so that a later, separately reviewed change can let the link keep the
-- revision a quote was actually sent from after a refreeze.
--
-- What changes
-- ------------
-- 1. scope_revisions_controlled_immutable, replaced whole. Two edits to the
--    20260504090757 body, nothing else:
--    a. A row may become superseded only from frozen. Draft to superseded is
--       refused. (Superseded to superseded was already allowed and stays.)
--    b. The contract-column lock and the NULL -> NOT NULL rules for the
--       supersession columns and spine_event_id now apply when OLD.status is
--       'frozen' OR 'superseded'. The message names the row's status; for a
--       frozen row its text is unchanged.
-- 2. New BEFORE INSERT trigger: a row cannot be inserted as superseded.
--    INSERT as draft or frozen is unchanged: the freeze writer
--    (_shared/scope_freeze/scope_freeze.ts insertFreshFrozenRow) inserts
--    frozen rows directly, and cloneScopeForEdit inserts drafts.
--
-- Writers kept working (every scope_revisions write in supabase/functions):
--   * insertFreshFrozenRow   INSERT status 'frozen' with frozen_at   allowed
--   * cloneScopeForEdit      INSERT status 'draft'                   allowed
--   * promoteDraftToFrozen   UPDATE draft -> frozen, frozen_at set   allowed
--   * healFrozenInvariant    UPDATE frozen -> superseded with
--                            superseded_at + superseded_by set       allowed
-- No SQL function in the repo writes scope_revisions.
--
-- Not changed on purpose
-- ----------------------
--   * INSERT as frozen without frozen_at is still accepted. Refusing it would
--     break callers that insert frozen rows without that column (the JP-24
--     link contract does); it is a separate decision.
--   * A superseded row with a NULL supersession column (one made through a
--     hole above, before this migration) may still have that column filled
--     once, NULL -> NOT NULL, exactly as a frozen row may.
--   * Existing rows are not read, changed or re-checked. Whether any live row
--     was already edited through these holes is a read-only census for the
--     owner's database access, not part of this migration.
--
-- Pre-image guard: the live function body must be the 20260504090757 body
-- (md5 of prosrc e2bcfa102c4db84b414f334eb4f7dadf) or this migration's own
-- body (re-apply). Anything else means production carries a body this repo
-- has not seen, and the migration refuses rather than overwrite it.
--
-- Rollback: supabase/rollbacks/20261029180000_scope_revisions_superseded_lock_down.sql
-- restores the 20260504090757 body and drops the INSERT guard.

BEGIN;

DO $$
DECLARE
  live_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO live_md5
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'scope_revisions_controlled_immutable';
  IF live_md5 IS NULL THEN
    RAISE EXCEPTION 'scope_revisions_superseded_lock: public.scope_revisions_controlled_immutable() is missing';
  END IF;
  IF live_md5 NOT IN ('e2bcfa102c4db84b414f334eb4f7dadf', 'b5275b79eb979c9215db5b46315685f7') THEN
    RAISE EXCEPTION 'scope_revisions_superseded_lock: live scope_revisions_controlled_immutable body % is not the 20260504090757 body or this migration''s; read it before replacing it', live_md5;
  END IF;
END $$;

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
  -- Only a frozen row may become superseded (20261029180000).
  IF NEW.status = 'superseded' AND OLD.status NOT IN ('frozen','superseded') THEN
    RAISE EXCEPTION 'scope_revisions: only a frozen row may be superseded (row % is %)', OLD.id, OLD.status
      USING errcode = '23514';
  END IF;

  -- Once frozen or superseded, contract columns are locked (superseded since
  -- 20261029180000). IS DISTINCT FROM is required so nullable columns compare
  -- correctly when NEW.x is NULL.
  IF OLD.status IN ('frozen','superseded') THEN
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
      RAISE EXCEPTION 'scope_revisions: row % is %; only supersession + spine_event_id may change', OLD.id, OLD.status
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

-- A row reaches superseded only by being frozen first, then superseded.
CREATE OR REPLACE FUNCTION public.scope_revisions_insert_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'superseded' THEN
    RAISE EXCEPTION 'scope_revisions: a row cannot be inserted as superseded; freeze it, then supersede it (row %)', NEW.id
      USING errcode = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_scope_revisions_insert_lifecycle ON public.scope_revisions;
CREATE TRIGGER trg_scope_revisions_insert_lifecycle
  BEFORE INSERT ON public.scope_revisions
  FOR EACH ROW EXECUTE FUNCTION public.scope_revisions_insert_lifecycle();


COMMIT;
