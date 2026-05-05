-- Scope-Memory-Saving Loop 1 — scope_revisions + scope_artifacts substrate
--
-- Status: APPLIED 2026-05-04 to project kevgrhcjxspbxgovpmfl
--   Supabase ledger: version=20260504090757 name=scope_revisions_and_artifacts
--   Filename: was authored as 20260504000001_scope_revisions_and_artifacts.sql
--     in supabase/migrations/_drafts/. After apply, promoted to
--     supabase/migrations/ on 2026-05-05 (Codex stop-time review #1) and
--     then renamed to 20260504090757_scope_revisions_and_artifacts.sql so
--     the filename prefix matches the Supabase ledger version exactly
--     (Codex stop-time review #2). Marnin's literal approval phrase
--     used the original draft name: "apply 20260504000001_scope_revisions_and_artifacts.sql"
--     — preserved verbatim here for the audit record.
--
-- Re-apply safety: this migration is idempotent. CREATE TABLE IF NOT EXISTS,
-- DROP TRIGGER IF EXISTS + CREATE TRIGGER, INSERT ... ON CONFLICT DO NOTHING
-- on the storage bucket. A `supabase db push` against a fresh branch that
-- replays the migration will no-op safely against the existing schema.
--
-- Roadmap : cio/operations/board/Scope-Memory-Saving/scope-freeze-end-to-end/roadmap.md (steps 1-3)
-- Strategy: strategy/scope-freeze-lifecycle-evidence.md (Loop 0 deliverable, §3-§4 SQL appendices)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why
-- ─────────────────────────────────────────────────────────────────────────────
-- Cap 0 V2 (shipped 2026-05-02 in soft-warn mode) seals each release packet at
-- quote send by VALUE-COPY of jobs.scope_json + pricing_json. There is still
-- no stable id we can cite from a work order, viewer URL, or T7 evidence
-- pointer back to "exactly the scope that produced this artefact." When
-- jobs.scope_json is later edited (revision bump, fix, neighbour add), the
-- packet's snapshot diverges from live job state with no re-entry path.
--
-- This migration introduces the architectural primitive that closes that gap:
--
--   * scope_revisions  — per-job append-of-frozen-snapshots table. Each row
--                        is an immutable canonical-text + sha256 copy of the
--                        scope+pricing at the moment "Sign Off & Freeze" was
--                        clicked. Linear lifecycle: draft -> frozen ->
--                        superseded. No frozen row may be edited.
--   * scope_artifacts  — append-only table of render PNGs, work-order PDFs,
--                        material-order PDFs, GLB exports, drawings — every
--                        binary that materialises a frozen revision. sha256
--                        is mandatory. No UPDATE, no DELETE.
--   * scope-artifacts  — new private Storage bucket holding the byte payloads
--                        for scope_artifacts rows. Service-role-only writes;
--                        reads via ops-api action that mints signed URLs.
--
-- Both tables carry a nullable spine_event_id backref so T7 (business_events)
-- can ground any answer in the exact frozen revision / artifact via the
-- existing source_table/source_id pointer pattern.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Core principles
-- ─────────────────────────────────────────────────────────────────────────────
--   * Additive only. No existing column, table, trigger, policy, or row is
--     modified. jobs.scope_json / pricing_json continue to be mutable working
--     drafts; the source-of-truth becomes the latest frozen scope_revisions
--     row per job.
--   * Controlled immutability mirrors the quote_revisions_controlled_immutable
--     pattern (20260430160000_create_quote_revisions.sql). Once
--     status='frozen', only supersession + spine_event_id columns may
--     transition NULL -> NOT NULL.
--   * Append-only on scope_artifacts. UPDATE and DELETE are refused by
--     trigger. Superseded revisions keep their artifact rows queryable; the
--     bytes in storage stay reachable as long as the row exists.
--   * Storage bucket private. No RLS policy attaches authenticated read
--     directly; reads go through a future ops-api action that checks role +
--     per-job RLS before signing a URL. Same pattern as release-manifests
--     (20260501140000) and the T7 evidence-bodies bucket draft
--     (20260502000006).
--   * No backfill. No INSERTs against either table. No historical 90-day
--     scope_json -> scope_revisions promotion. That decision belongs to
--     roadmap step 11 (Loop 7 audit) behind a separate Marnin gate.
--   * No row-level security policies are added on scope_revisions /
--     scope_artifacts in this migration. RLS is enabled (default-deny for
--     anon + authenticated). Service role writes from edge functions; any
--     dashboard read API minted later goes through ops-api.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Out of scope (later loops, do NOT add here)
-- ─────────────────────────────────────────────────────────────────────────────
--   * freezeScope / cloneScopeForEdit edge function helpers (roadmap step 4).
--   * ops-api 'freeze_scope' + 'clone_scope_for_edit' action wiring (step 4).
--   * Patio _workOrderViews + fence-designer profile-render persistence
--     (step 5).
--   * V2 release-packet citation of scope_revision_id (step 6).
--   * work_orders.scope_revision_id / quote_revision_id FKs (step 7).
--     Adding them belongs to a separate migration once the helpers land.
--   * Read-only viewer + scope.viewer.opened telemetry (step 8).
--   * 90-day legacy audit / backfill (step 11).
--   * Cap 0 V2 enforce-mode flip (out of this lane).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback (time-to-revert: <2s; bucket must be empty)
-- ─────────────────────────────────────────────────────────────────────────────
--   DROP TRIGGER IF EXISTS trg_scope_artifacts_no_update     ON public.scope_artifacts;
--   DROP TRIGGER IF EXISTS trg_scope_artifacts_no_delete     ON public.scope_artifacts;
--   DROP FUNCTION IF EXISTS public.scope_artifacts_append_only();
--   DROP TABLE IF EXISTS public.scope_artifacts;
--
--   DROP TRIGGER IF EXISTS trg_scope_revisions_controlled_immutable ON public.scope_revisions;
--   DROP TRIGGER IF EXISTS trg_scope_revisions_no_delete            ON public.scope_revisions;
--   DROP FUNCTION IF EXISTS public.scope_revisions_controlled_immutable();
--   DROP FUNCTION IF EXISTS public.scope_revisions_no_delete();
--   DROP TABLE IF EXISTS public.scope_revisions;
--
--   -- Bucket (must be empty):
--   DELETE FROM storage.buckets WHERE id = 'scope-artifacts';
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Downstream impact
-- ─────────────────────────────────────────────────────────────────────────────
--   * Cap 0 V2 release path: zero impact. send-quote/buildV2Augmentation does
--     not yet read scope_revisions; Loop 3 wires it. Existing 113 V2 tests
--     unchanged.
--   * ops-api: zero impact. The freeze_scope / clone_scope_for_edit actions
--     do not exist yet.
--   * ghl-proxy save_scope: zero impact. Continues writing jobs.scope_json
--     + jobs.pricing_json as the mutable working draft.
--   * patio-tool / fence-designer / securedash: zero impact. No reads or
--     writes against the new tables until Loop 2 wires the freeze button.
--   * T7 / business_events: zero impact. spine_event_id stays NULL on every
--     row inserted by this lane until the recordEvidence helper is taught
--     channel='scope' (already in T7 channel enum, see 20260502000001).

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. scope_revisions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.scope_revisions (
  id                                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                             uuid        NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  revision_number                    int         NOT NULL CHECK (revision_number >= 1),

  -- Which scoping tool produced this revision. Aligned with V2 ScopeBlock.kind
  -- (manifest_v2_types.ts: PatioScopeBlock | FenceScopeBlock | QuickQuoteScopeBlock |
  -- DeckingScopeBlock | GateScopeBlock | RepairScopeBlock). 'general' is the
  -- catch-all for anything not yet adapter-mapped; 'gate' / 'repair' are reserved
  -- for when future tools adopt frozen revisions.
  tool_kind                          text        NOT NULL CHECK (tool_kind IN (
    'patio','fencing','decking','quick_quote','gate','repair','general'
  )),

  -- Canonical-JSON form of the frozen scope (recursive deep-sort + UTF-8) and
  -- its sha256. Stored as text (not jsonb) because the canonical bytes ARE the
  -- contract: any non-byte-stable representation breaks hash verification.
  scope_canonical_text               text        NOT NULL,
  scope_hash                         text        NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),

  pricing_canonical_text             text        NOT NULL,
  pricing_hash                       text        NOT NULL CHECK (pricing_hash ~ '^[0-9a-f]{64}$'),

  -- Pinned per revision so the read-only viewer can always rebuild the scene.
  -- Patio today: 'three.js@r128'. Fence-designer: git sha or build id.
  renderer_version                   text        NOT NULL,
  -- e.g. 'PatioDesignerPro_V18' (existing patio-tool constant) or fence-designer
  -- build label. NEVER the live tool URL — the version must be sufficient to
  -- locate the pinned viewer build.
  tool_version                       text        NOT NULL,

  -- Optional indexable view of the scope_artifacts rows for this revision.
  -- Populated by the freeze helper after artifact uploads complete.
  -- Shape: [{artifact_type, storage_path, sha256, size_bytes}]
  model_manifest_json                jsonb       NULL,
  model_manifest_hash                text        NULL CHECK (
    model_manifest_hash IS NULL OR model_manifest_hash ~ '^[0-9a-f]{64}$'
  ),

  status                             text        NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft','frozen','superseded')
  ),
  frozen_at                          timestamptz NULL,
  frozen_by_user_id                  uuid        NULL,

  superseded_by_scope_revision_id    uuid        NULL REFERENCES public.scope_revisions(id) ON DELETE RESTRICT,
  superseded_at                      timestamptz NULL,

  -- T7 backref (mirrors 20260502000005_spine_backref.sql pattern). business_events.id
  -- of the scope.revision_frozen spine row. NULL until recordEvidence writes the
  -- spine row and the freeze helper UPDATEs this column once.
  spine_event_id                     uuid        NULL,

  created_at                         timestamptz NOT NULL DEFAULT now(),
  updated_at                         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (job_id, revision_number)
);

-- Fast lookup of "current frozen scope per job".
CREATE INDEX IF NOT EXISTS idx_scope_revisions_current_frozen
  ON public.scope_revisions (job_id) WHERE status = 'frozen';

-- Content-addressable lookup (de-dup, viewer cache, integrity audits).
CREATE INDEX IF NOT EXISTS idx_scope_revisions_scope_hash
  ON public.scope_revisions (scope_hash) WHERE status = 'frozen';

-- T7 backref index, mirrors 20260502000005 pattern.
CREATE INDEX IF NOT EXISTS idx_scope_revisions_spine
  ON public.scope_revisions (spine_event_id) WHERE spine_event_id IS NOT NULL;

-- Linear walks across a job's lifecycle (Loop 8 viewer + Loop 11 audit).
CREATE INDEX IF NOT EXISTS idx_scope_revisions_job_status_revnum
  ON public.scope_revisions (job_id, status, revision_number DESC);

-- RLS on (default-deny). Service role bypasses; no policies for anon /
-- authenticated. Reads route through ops-api actions in later loops.
ALTER TABLE public.scope_revisions ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1a. Controlled-immutability trigger (mirrors quote_revisions pattern).
-- ─────────────────────────────────────────────────────────────────────────────
-- Lifecycle rules:
--   draft  -> draft     : freely editable (working state before sign-off).
--   draft  -> frozen    : one-shot transition. frozen_at must be set.
--   frozen -> frozen    : permitted ONLY if no contract column changes; only
--                         the supersession/spine_event_id columns may
--                         transition NULL -> NOT NULL.
--   frozen -> superseded: permitted; supersession columns must be set.
--   superseded -> *     : refused. terminal state.
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 1b. No-delete trigger.
-- ─────────────────────────────────────────────────────────────────────────────
-- Even draft rows cannot be deleted. Cleanup of stale drafts is handled by the
-- clone-to-edit semantics (a fresh draft replaces an abandoned one) plus an
-- explicit Marnin-approved cleanup migration if it ever becomes necessary.
CREATE OR REPLACE FUNCTION public.scope_revisions_no_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'scope_revisions rows cannot be deleted; row %', OLD.id
    USING errcode = '23514';
END;
$$;

DROP TRIGGER IF EXISTS trg_scope_revisions_no_delete ON public.scope_revisions;
CREATE TRIGGER trg_scope_revisions_no_delete
  BEFORE DELETE ON public.scope_revisions
  FOR EACH ROW EXECUTE FUNCTION public.scope_revisions_no_delete();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. scope_artifacts (append-only)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.scope_artifacts (
  id                                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_revision_id                  uuid        NOT NULL REFERENCES public.scope_revisions(id) ON DELETE RESTRICT,

  artifact_type                      text        NOT NULL CHECK (artifact_type IN (
    -- Patio renders (existing _workOrderViews series).
    'render_hero','render_front','render_side','render_site_plan',
    'render_riser','render_post_detail',
    -- Fence-designer renders.
    'render_profile','render_3d_scene',
    -- Documents materialised at freeze / WO generation.
    'quote_pdf','per_contact_pdf','work_order_pdf','material_order_pdf',
    -- 3D model export (deferred; placeholder for forward compatibility).
    'model_glb',
    -- Misc engineered drawing or annotated image.
    'drawing'
  )),

  storage_path                       text        NOT NULL,
  bucket_id                          text        NOT NULL,
  sha256                             text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes                         bigint      NOT NULL CHECK (size_bytes >= 0),
  content_type                       text        NOT NULL,
  label                              text        NULL,

  -- T7 backref. business_events.id of the scope.artifact_uploaded spine row,
  -- when recordEvidence is taught channel='scope' for artifacts. NULL on
  -- insert; freeze helper UPDATEs once if the row is still in its insert
  -- transaction (append-only trigger refuses post-insert UPDATEs — see below).
  -- Therefore in practice the spine row is written FIRST, then this column
  -- is supplied at INSERT time. Keep nullable for backward compatibility
  -- with reverse order writes during canary.
  spine_event_id                     uuid        NULL,

  created_at                         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scope_artifacts_revision_type
  ON public.scope_artifacts (scope_revision_id, artifact_type);

CREATE INDEX IF NOT EXISTS idx_scope_artifacts_sha256
  ON public.scope_artifacts (sha256);

CREATE INDEX IF NOT EXISTS idx_scope_artifacts_spine
  ON public.scope_artifacts (spine_event_id) WHERE spine_event_id IS NOT NULL;

ALTER TABLE public.scope_artifacts ENABLE ROW LEVEL SECURITY;

-- Append-only: refuse all UPDATE and DELETE.
CREATE OR REPLACE FUNCTION public.scope_artifacts_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'scope_artifacts is append-only; row % cannot be %',
    COALESCE(OLD.id::text, NEW.id::text), TG_OP
    USING errcode = '23514';
END;
$$;

DROP TRIGGER IF EXISTS trg_scope_artifacts_no_update ON public.scope_artifacts;
CREATE TRIGGER trg_scope_artifacts_no_update
  BEFORE UPDATE ON public.scope_artifacts
  FOR EACH ROW EXECUTE FUNCTION public.scope_artifacts_append_only();

DROP TRIGGER IF EXISTS trg_scope_artifacts_no_delete ON public.scope_artifacts;
CREATE TRIGGER trg_scope_artifacts_no_delete
  BEFORE DELETE ON public.scope_artifacts
  FOR EACH ROW EXECUTE FUNCTION public.scope_artifacts_append_only();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Storage bucket: scope-artifacts (private, service-role only)
-- ─────────────────────────────────────────────────────────────────────────────
-- Mirrors release-manifests (20260501140000) and the T7 evidence-bodies
-- bucket draft (20260502000006): no RLS policy, default-deny for anon +
-- authenticated, service role bypasses. Reads via a future ops-api action
-- (e.g. get_scope_artifact(id) / get_scope_revision_for_viewer(id)) which
-- mints time-limited signed URLs after role + per-job RLS check.
--
-- file_size_limit + allowed_mime_types are intentionally permissive enough
-- to cover the documented artifact set without becoming a leak surface for
-- arbitrary uploads:
--   * PNG renders (patio _workOrderViews ~200-800KB each)
--   * Work-order / quote / material-order PDFs (typically <2MB)
--   * Future GLB exports (capped tightly at app layer; bucket allows up to 25MB)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'scope-artifacts',
  'scope-artifacts',
  false,                        -- PRIVATE — service-role only
  26214400,                     -- 25 MB hard cap per object
  ARRAY[
    'image/png',
    'image/jpeg',
    'application/pdf',
    'model/gltf-binary'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- No RLS policies on storage.objects for this bucket. Default-deny applies.

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Comments (canonical schema documentation)
-- ─────────────────────────────────────────────────────────────────────────────
COMMENT ON TABLE public.scope_revisions IS
  'Frozen-scope substrate: append-of-frozen-snapshots per job. Source-of-truth for any quote release packet, work order, or viewer artefact that must cite the exact scope+pricing at sign-off. Linear lifecycle draft -> frozen -> superseded; once frozen, contract columns are locked by trigger. See strategy/scope-freeze-lifecycle-evidence.md.';

COMMENT ON COLUMN public.scope_revisions.scope_canonical_text IS
  'Canonical-JSON form of frozen jobs.scope_json (recursive deep-sort + UTF-8). The bytes ARE the contract; sha256(scope_canonical_text) MUST equal scope_hash.';
COMMENT ON COLUMN public.scope_revisions.scope_hash IS
  'SHA-256 hex of scope_canonical_text. Lower-case 64-char hex. Mirrors quote_revisions.manifest_hash convention.';
COMMENT ON COLUMN public.scope_revisions.renderer_version IS
  'Pinned renderer version used to deterministically rebuild the 3D scene from scope_canonical_text. Patio today: three.js@r128.';
COMMENT ON COLUMN public.scope_revisions.tool_version IS
  'Pinned scoping tool build label (e.g. PatioDesignerPro_V18 for patio, fence-designer git sha or build id). Sufficient to locate the matching pinned viewer build.';
COMMENT ON COLUMN public.scope_revisions.model_manifest_json IS
  'Indexable view of scope_artifacts rows for this revision: [{artifact_type, storage_path, sha256, size_bytes}]. Populated by the freeze helper after artifact uploads complete.';
COMMENT ON COLUMN public.scope_revisions.status IS
  'draft | frozen | superseded. draft is freely mutable; frozen is locked by trigger except supersession + spine_event_id; superseded is terminal.';
COMMENT ON COLUMN public.scope_revisions.superseded_by_scope_revision_id IS
  'Linked-list pointer to the next revision. NULL while this revision is the latest frozen one. Set when a clone-then-freeze cycle promotes a higher revision_number.';
COMMENT ON COLUMN public.scope_revisions.spine_event_id IS
  'T7 backref: business_events.id of the scope.revision_frozen spine row produced via recordEvidence. Mirrors 20260502000005_spine_backref.sql pattern. NULL until the spine row is written.';

COMMENT ON TABLE public.scope_artifacts IS
  'Append-only registry of binary artefacts (renders, work-order PDFs, quote PDFs, material-order PDFs, GLB exports, drawings) materialised from a frozen scope_revisions row. Bytes live in the scope-artifacts Storage bucket; this row indexes them. UPDATE and DELETE refused by trigger.';
COMMENT ON COLUMN public.scope_artifacts.sha256 IS
  'Content hash, lower-case 64-char hex. Mandatory; no artefact may be inserted without one. Enables de-dup across revisions and integrity verification at viewer load.';
COMMENT ON COLUMN public.scope_artifacts.bucket_id IS
  'Storage bucket id. Default scope-artifacts. Recorded explicitly so future migrations may shard artefacts across buckets without rewriting old rows.';
COMMENT ON COLUMN public.scope_artifacts.spine_event_id IS
  'T7 backref: business_events.id of the scope.artifact_uploaded spine row. NULL until recordEvidence is taught channel=scope artifact events.';

COMMENT ON COLUMN storage.buckets.id IS
  'Supabase Storage buckets. scope-artifacts (added 2026-05-04 by migration scope_revisions_and_artifacts): private, service-role-only, holds frozen-scope render PNGs, work-order PDFs, quote PDFs, material-order PDFs, GLB exports. Indexed by public.scope_artifacts (sha256 mandatory).';

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Apply notes (for the operator at CP-3, NOT executed by this file)
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Preflight checks before apply:
--      - SELECT 1 FROM pg_extension WHERE extname IN ('pgcrypto');  -- gen_random_uuid
--      - confirm jobs.id exists (FK target).
--      - confirm storage.buckets is reachable on the target project.
-- 2. Apply via the approved Supabase path (Studio SQL editor + paste, OR
--    `supabase db push` against the linked project, OR
--    mcp__claude_ai_Supabase__apply_migration with name
--    'scope_revisions_and_artifacts'). The migration is fully transactional.
-- 3. Postflight verification (read-only, mirrors existing post-apply audit):
--      - SELECT to_regclass('public.scope_revisions');  -- expect 'scope_revisions'
--      - SELECT to_regclass('public.scope_artifacts');  -- expect 'scope_artifacts'
--      - SELECT bool_and(rowsecurity) FROM pg_tables
--          WHERE schemaname='public'
--            AND tablename IN ('scope_revisions','scope_artifacts');  -- expect true
--      - SELECT count(*) FROM pg_trigger
--          WHERE tgrelid IN ('public.scope_revisions'::regclass,
--                            'public.scope_artifacts'::regclass);     -- expect 4
--      - SELECT id, public, file_size_limit FROM storage.buckets WHERE id='scope-artifacts';
-- 4. Negative tests at canary (run from a service-role client in a synthetic job):
--      a. INSERT a draft scope_revision; UPDATE its scope_canonical_text -> expect success
--         (status is still draft).
--      b. UPDATE the row to status='frozen' WITHOUT frozen_at -> expect 23514 raise.
--      c. Set status='frozen' + frozen_at = now() -> expect success.
--      d. UPDATE scope_canonical_text on the frozen row -> expect 23514 raise.
--      e. DELETE the row -> expect 23514 raise.
--      f. INSERT a scope_artifacts row with bad sha256 (non-hex) -> expect 23514 raise.
--      g. UPDATE/DELETE the scope_artifacts row -> expect 23514 raise (append-only).
-- 5. No production write helpers are introduced by this migration. Any apply
--    can be reverted with the rollback block at the top of this file in <2s,
--    provided the scope-artifacts bucket is empty (it will be — no helper yet
--    writes objects).
