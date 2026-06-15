-- ════════════════════════════════════════════════════════════
-- MAKE-SAFE EMAIL SYNC — event-sourced schema (Phase 1, Stage A)
-- Mission: makesafe-live-truth-2026-06-14
-- ════════════════════════════════════════════════════════════
--
-- This migration creates the 6-table event-sourced schema that turns the
-- make-safe board into a verified live source of truth, plus a classifier
-- exclusion audit table, a private Storage bucket for attachment bytes, and a
-- 90-day PII purge-or-tombstone function.
--
-- Migration order (per MISSION.md): this migration creates all tables + RLS +
-- bucket + purge function ONLY. It is INERT — no cron, no data, no edge
-- function. The cron + purge schedule lives in the companion migration
-- 20260614000002_makesafe_email_sync_cron.sql, which is the apply-LAST /
-- cron-enable step (after consent + owner approval).
--
-- IMPORTANT: email_events_raw is a NEW table. It is SEPARATE from and does NOT
-- replace the existing inbox_events table. This sync engine does NOT write to
-- inbox_events.
--
-- All tables are service-role-only (RLS enabled, deny-all to anon/authenticated;
-- explicit service_role policy + grant). The Storage bucket is PRIVATE.

-- ════════════════════════════════════════════════════════════
-- 1. mail_sync_cursors — overlapping watermark, one row per mailbox
-- ════════════════════════════════════════════════════════════
-- Committed atomically with the rows the run covers. The watermark covers
-- email-envelope capture only; attachment completeness is tracked separately
-- (see email_attachments.status + sync_state.mode).
CREATE TABLE IF NOT EXISTS public.mail_sync_cursors (
  mailbox            text PRIMARY KEY,
  -- last_completed_max: the max receivedDateTime fully drained + persisted.
  -- The next poll uses (last_completed_max - overlap) as a >= lower bound,
  -- NOT a strict greater-than, so threaded re-polls are never dropped.
  last_completed_max timestamptz,
  last_full_resync_at timestamptz,
  -- N5: overlap window is configurable per mailbox via this column (default 900s
  -- = 15 min). The integration-validation step sets the final value once the
  -- real max thread-reply latency is measured; 900 is the safe initial default.
  overlap_seconds    integer NOT NULL DEFAULT 900,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- ════════════════════════════════════════════════════════════
-- 2. email_events_raw — append-only NON-PII audit/replay log
-- ════════════════════════════════════════════════════════════
-- Stores metadata only: post id, timestamps, change type, content hash,
-- extracted ref. NEVER deleted, NEVER truncated, NEVER purged. Source of truth
-- for rebuilding pipeline_items. This is NOT inbox_events.
CREATE TABLE IF NOT EXISTS public.email_events_raw (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox         text NOT NULL,
  post_id         text NOT NULL,            -- Graph group post id (idempotency key)
  -- change_type: created | updated | excluded | attachment_seen
  change_type     text NOT NULL DEFAULT 'created',
  received_at     timestamptz,              -- post receivedDateTime
  -- content_sha256: hash of the body envelope (NON-PII; a fingerprint, not body)
  content_sha256  text,
  extracted_ref   text,                     -- normalised external ref (e.g. AJBR-67200)
  -- conversation_id / thread_id: traversal coordinates, non-PII
  conversation_id text,
  thread_id       text,
  -- exclusion audit (when change_type = 'excluded')
  exclusion_reason text,
  page_meta       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- page counts, traversal log
  observed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_events_raw_post ON public.email_events_raw(post_id);
CREATE INDEX IF NOT EXISTS idx_email_events_raw_mailbox ON public.email_events_raw(mailbox);
CREATE INDEX IF NOT EXISTS idx_email_events_raw_observed ON public.email_events_raw(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_events_raw_change ON public.email_events_raw(change_type);

-- ════════════════════════════════════════════════════════════
-- 3. emails — current PII projection. PRIMARY KEY on post_id.
-- ════════════════════════════════════════════════════════════
-- ON CONFLICT (post_id) DO UPDATE is the sole dedup path. NO nullable composite
-- key as a conflict target. The partial unique index on internet_message_id is
-- COMMENTED OUT and enabled only after live payload confirms the field is
-- present on group posts (integration-validation step).
CREATE TABLE IF NOT EXISTS public.emails (
  post_id              text PRIMARY KEY,   -- Graph group post id; stable idempotency key
  mailbox              text NOT NULL,
  internet_message_id  text,               -- presence on group posts UNCONFIRMED (see below)
  conversation_id      text,
  thread_id            text,
  from_email           text,
  from_name            text,
  to_recipients        text,
  subject              text,               -- PII
  body_preview         text,               -- PII
  body_content         text,               -- PII (full body)
  body_content_type    text,               -- 'html' | 'text'
  received_at          timestamptz,
  has_attachments      boolean NOT NULL DEFAULT false,
  content_sha256       text,
  -- tombstone bookkeeping for 90-day PII purge (see purge function below)
  pii_purged_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_emails_mailbox ON public.emails(mailbox);
CREATE INDEX IF NOT EXISTS idx_emails_received ON public.emails(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_conversation ON public.emails(conversation_id);
CREATE INDEX IF NOT EXISTS idx_emails_internet_msg ON public.emails(internet_message_id);

-- COMMENTED-OUT partial unique index on internet_message_id.
-- Enable ONLY AFTER the integration-validation step confirms internetMessageId
-- is reliably present + stable on group posts. Until then post_id is the SOLE
-- idempotency key. Do NOT uncomment before live confirmation.
-- CREATE UNIQUE INDEX IF NOT EXISTS uq_emails_internet_message_id
--   ON public.emails(internet_message_id)
--   WHERE internet_message_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════
-- 4. email_attachments — PII bytes live in private Storage, row tracks status
-- ════════════════════════════════════════════════════════════
-- Idempotency key is (email_id, graph_attachment_id) — a NON-NULL key that holds
-- even for pending/needs_review rows BEFORE bytes are fetched and sha256 is known.
-- B5 fix: the old UNIQUE(email_id, sha256) target failed for pending rows
-- (sha256 NULL -> every NULL is distinct, so the upsert conflict target never
-- fired and pending/needs_review rows duplicated on every poll). graph_attachment_id
-- is present on every Graph attachment shape (file/reference/item/inline) so it is
-- a stable, non-null per-attachment key. A SECONDARY unique on (email_id, sha256)
-- WHERE sha256 IS NOT NULL preserves byte-level dedup once bytes are hashed.
CREATE TABLE IF NOT EXISTS public.email_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id      text NOT NULL REFERENCES public.emails(post_id) ON DELETE CASCADE,
  graph_attachment_id text NOT NULL, -- Graph attachment id; non-null idempotency key
  name          text,
  content_type  text,
  size_bytes    bigint,
  sha256        text,              -- NULL until bytes fetched + hashed
  storage_path  text,              -- path in the private bucket; NULL until uploaded
  -- status: pending  -> known to exist, bytes not yet stored
  --         uploaded -> bytes validated (PDF magic) + stored
  --         failed   -> fetch/upload/validation failed; retry worker re-tries
  --         needs_review -> referenceAttachment/itemAttachment/inline; alerted
  --         purged   -> PII tombstoned by the 90-day retention job (bytes gone)
  status        text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'uploaded', 'failed', 'needs_review', 'purged')),
  attachment_kind text,            -- fileAttachment | referenceAttachment | itemAttachment | inline
  last_error    text,
  attempts      integer NOT NULL DEFAULT 0,
  pii_purged_at timestamptz,       -- tombstone marker for 90-day purge
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Primary idempotency key: non-null per-attachment id (holds pre-hash).
  UNIQUE (email_id, graph_attachment_id)
);
CREATE INDEX IF NOT EXISTS idx_email_attachments_email ON public.email_attachments(email_id);
CREATE INDEX IF NOT EXISTS idx_email_attachments_status ON public.email_attachments(status);
-- Secondary byte-level dedup, only once bytes are actually hashed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_attachments_email_sha
  ON public.email_attachments(email_id, sha256)
  WHERE sha256 IS NOT NULL;

-- ════════════════════════════════════════════════════════════
-- 5. pipeline_items — rebuildable projection. Skills read THIS, not the mailbox.
-- ════════════════════════════════════════════════════════════
-- Corruption is never data loss: reproject from email_events_raw + emails using
-- current extractor/matcher versions. source_event_ids[] records provenance.
CREATE TABLE IF NOT EXISTS public.pipeline_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ref is the natural projection key (normalised external ref). One pipeline
  -- item per ref per mailbox; rebuild is deterministic for a fixed fixture set.
  ref              text NOT NULL,
  mailbox          text NOT NULL,
  target_job       uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  -- sent_status mirrors pack_sent_status semantics: verified_sent | not_sent |
  -- needs_review (never silently "not sent").
  sent_status      text NOT NULL DEFAULT 'not_sent',
  attachment_refs  text[] NOT NULL DEFAULT '{}',   -- email_attachments.id list
  match_score      numeric,
  match_method     text,
  extractor_version text NOT NULL DEFAULT 'v1',
  matcher_version  text NOT NULL DEFAULT 'v1',
  source_event_ids uuid[] NOT NULL DEFAULT '{}',   -- email_events_raw.id provenance
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox, ref)
);
CREATE INDEX IF NOT EXISTS idx_pipeline_items_ref ON public.pipeline_items(ref);
CREATE INDEX IF NOT EXISTS idx_pipeline_items_job ON public.pipeline_items(target_job);
CREATE INDEX IF NOT EXISTS idx_pipeline_items_sent ON public.pipeline_items(sent_status);

-- ════════════════════════════════════════════════════════════
-- 6. sync_state — one row per mailbox; drives the DEGRADED banner
-- ════════════════════════════════════════════════════════════
-- mode = DEGRADED while ANY attachment is pending OR failed, OR while the last
-- sync errored. The sync is NOT "verified" until every attachment resolves.
CREATE TABLE IF NOT EXISTS public.sync_state (
  mailbox                 text PRIMARY KEY,
  last_successful_sync_at  timestamptz,
  last_attempt_at          timestamptz,
  last_error               text,
  -- mode: OK | DEGRADED | ERROR
  mode                     text NOT NULL DEFAULT 'OK'
    CHECK (mode IN ('OK', 'DEGRADED', 'ERROR')),
  pending_attachments      integer NOT NULL DEFAULT 0,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- ════════════════════════════════════════════════════════════
-- 7. email_classifier_exclusions — audit row per excluded post (never silent)
-- ════════════════════════════════════════════════════════════
-- MISSION.md allows this as a dedicated table OR a flagged row in
-- email_events_raw. We do BOTH: an excluded post writes a change_type='excluded'
-- row to email_events_raw AND a reviewable row here. Nothing is silently dropped.
-- B7 fix: raw sender addresses are PII and this table sits OUTSIDE the 90-day
-- purge, so it must never hold a raw address. We keep the sender DOMAIN (a coarse
-- non-PII review hint) plus a salted-free sha256 of the full address (so two
-- exclusions from the same sender are correlatable for review without exposing
-- the address). The raw localpart is never stored.
CREATE TABLE IF NOT EXISTS public.email_classifier_exclusions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id          text NOT NULL,
  mailbox          text,
  from_domain      text,           -- sender domain only (non-PII review hint)
  from_email_hash  text,           -- sha256 of full address (correlatable, non-PII)
  subject_hash     text,           -- hash, not the subject (keeps this table non-PII)
  exclusion_reason text NOT NULL,
  reviewed         boolean NOT NULL DEFAULT false,
  observed_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id)
);
CREATE INDEX IF NOT EXISTS idx_classifier_exclusions_reviewed
  ON public.email_classifier_exclusions(reviewed);

-- ════════════════════════════════════════════════════════════
-- RLS — service-role only on every table (deny-all to anon/authenticated)
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'mail_sync_cursors',
    'email_events_raw',
    'emails',
    'email_attachments',
    'pipeline_items',
    'sync_state',
    'email_classifier_exclusions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role;', t);
    -- Drop+recreate so the migration is idempotent on re-apply.
    EXECUTE format('DROP POLICY IF EXISTS service_role_all ON public.%I;', t);
    EXECUTE format(
      'CREATE POLICY service_role_all ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true);',
      t
    );
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════
-- Private Storage bucket for attachment bytes (PII; service-role only)
-- ════════════════════════════════════════════════════════════
-- Same posture as release-manifests: PRIVATE, no RLS policies on
-- storage.objects -> anon/authenticated default-deny, service_role bypasses.
-- Bytes NEVER reach model context; ops-api mints short-TTL signed URLs only.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'makesafe-emails',
  'makesafe-emails',
  false,                          -- PRIVATE — service-role only
  26214400,                       -- 25 MB cap (work-order PDFs are well under this)
  ARRAY['application/pdf']        -- only validated PDFs are stored here
)
ON CONFLICT (id) DO NOTHING;

-- ════════════════════════════════════════════════════════════
-- 90-day PII purge-or-tombstone function
-- ════════════════════════════════════════════════════════════
-- Tombstone (null the PII columns, keep the row skeleton) is PREFERRED over hard
-- delete so D1/D2 reconciliation audit continuity is retained. email_events_raw
-- is NON-PII and is NEVER touched here. Idempotent: already-tombstoned rows are
-- skipped via the pii_purged_at guard. Returns a per-run affected count.
CREATE OR REPLACE FUNCTION public.purge_makesafe_email_pii(retention_days integer DEFAULT 90)
RETURNS jsonb AS $$
DECLARE
  -- B6 fix: do NOT trust a caller-supplied arbitrary value. Clamp to a sane
  -- positive bound so a caller can never pass 0/negative (purge everything) or a
  -- huge value. Floor 30 days, ceiling 365 days; default 90.
  eff_days      integer := LEAST(GREATEST(COALESCE(retention_days, 90), 30), 365);
  cutoff        timestamptz := now() - make_interval(days => eff_days);
  emails_n      integer := 0;
  attach_n      integer := 0;
  storage_n     integer := 0;
BEGIN
  -- Tombstone email PII columns older than the cutoff. Keep post_id + envelope
  -- coordinates (mailbox, received_at, hashes) for D1/D2 audit continuity.
  UPDATE public.emails
     SET subject       = NULL,
         body_preview  = NULL,
         body_content  = NULL,
         from_email    = NULL,
         from_name     = NULL,
         to_recipients = NULL,
         pii_purged_at = now(),
         updated_at    = now()
   WHERE received_at < cutoff
     AND pii_purged_at IS NULL;
  GET DIAGNOSTICS emails_n = ROW_COUNT;

  -- Remove the stored bytes for attachments on tombstoned/aged emails, then
  -- tombstone the attachment row metadata. Storage objects are deleted by path.
  WITH aged AS (
    SELECT a.id, a.storage_path
      FROM public.email_attachments a
      JOIN public.emails e ON e.post_id = a.email_id
     WHERE e.received_at < cutoff
       AND a.pii_purged_at IS NULL
  ),
  del_storage AS (
    DELETE FROM storage.objects o
     USING aged
     WHERE o.bucket_id = 'makesafe-emails'
       AND o.name = aged.storage_path
    RETURNING 1
  )
  SELECT count(*) INTO storage_n FROM del_storage;

  -- M5 fix: null the PII metadata (name) AND set an explicit 'purged' status so
  -- signed-URL minting can exclude these rows. Previously status stayed 'uploaded'
  -- with storage_path nulled -> a stale 'uploaded' row whose object no longer
  -- exists, which the URL-mint path could still try to sign.
  UPDATE public.email_attachments a
     SET storage_path = NULL,
         name         = NULL,        -- PII (filename can leak client/address)
         content_type = NULL,
         last_error   = NULL,
         pii_purged_at = now(),
         status        = 'purged',
         updated_at    = now()
    FROM public.emails e
   WHERE e.post_id = a.email_id
     AND e.received_at < cutoff
     AND a.pii_purged_at IS NULL;
  GET DIAGNOSTICS attach_n = ROW_COUNT;

  RAISE NOTICE 'purge_makesafe_email_pii: cutoff=% (eff_days=%) emails=% attachments=% storage_objects=%',
    cutoff, eff_days, emails_n, attach_n, storage_n;

  RETURN jsonb_build_object(
    'cutoff', cutoff,
    'effective_retention_days', eff_days,
    'emails_tombstoned', emails_n,
    'attachments_tombstoned', attach_n,
    'storage_objects_deleted', storage_n
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   -- B6: pin search_path so a SECURITY DEFINER function cannot be hijacked by a
   -- caller-set search_path resolving public.* to attacker objects.
   SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.purge_makesafe_email_pii IS
  'Make-safe email-sync 90-day PII purge. Tombstones emails/email_attachments PII
   columns + deletes private-bucket bytes for rows older than retention_days
   (clamped 30..365). email_events_raw (non-PII) is never touched. Idempotent.';

-- ════════════════════════════════════════════════════════════
-- B2 — per-mailbox concurrency lock (pg session-level advisory lock via RPC)
-- ════════════════════════════════════════════════════════════
-- The */5 cron can overlap (a slow poll still running when the next fires). Two
-- runs racing on the same mailbox cursor read/drain/write corrupts the watermark.
-- The edge function calls try_lock_mailbox_sync(MAILBOX) at the top; if it returns
-- false, another run holds the lock and the function exits early-clean. The lock
-- is SESSION-scoped to the Postgres connection the RPC ran on; since PostgREST
-- pools connections, we pair it with unlock_mailbox_sync() in a finally block.
-- (Advisory locks auto-release when the backend connection closes, so a crashed
-- run never deadlocks the next cycle.)
CREATE OR REPLACE FUNCTION public.try_lock_mailbox_sync(p_mailbox text)
RETURNS boolean AS $$
BEGIN
  -- hashtext() maps the mailbox to a stable bigint lock key; the constant
  -- 0x4D53 ('MS') namespaces make-safe sync locks away from other advisory users.
  RETURN pg_try_advisory_lock(hashtext('makesafe_sync:' || p_mailbox));
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.unlock_mailbox_sync(p_mailbox text)
RETURNS boolean AS $$
BEGIN
  RETURN pg_advisory_unlock(hashtext('makesafe_sync:' || p_mailbox));
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.try_lock_mailbox_sync IS
  'B2: per-mailbox advisory lock for monitor-ses-makesafes. Returns false if a
   concurrent run already holds it (caller exits early).';

-- ════════════════════════════════════════════════════════════
-- B6 — lock down SECURITY DEFINER / lock RPCs: revoke from PUBLIC, grant only
-- to service_role (and postgres, the owner). No anon/authenticated execute.
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.purge_makesafe_email_pii(integer)',
    'public.try_lock_mailbox_sync(text)',
    'public.unlock_mailbox_sync(text)'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC;', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon;', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated;', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role;', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres;', fn);
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════
-- M4 — cron enablement gate (defined HERE in the base schema because the
-- Phase-1 cron migration 20260614000002 references it on apply)
-- ════════════════════════════════════════════════════════════
-- The cron migrations register schedules, but "apply-last" was previously only a
-- COMMENT, not a gate: a plain `db push` of all migrations would immediately start
-- live polling + Graph traversal. M4 FIX: every trigger function (Phase-1 poll +
-- purge, Phase-2 reconcile + canary) no-ops unless this single-row flag is
-- explicitly set true by an OWNER-gated step (Stage C). The flag defaults to FALSE,
-- so applying the cron migrations alone does NOT start automation.
--
-- Enabling automation is then ONE deliberate owner statement (NOT part of db push):
--   UPDATE public.makesafe_cron_settings SET cron_enabled = true, enabled_at = now();
CREATE TABLE IF NOT EXISTS public.makesafe_cron_settings (
  id           boolean PRIMARY KEY DEFAULT true CHECK (id),  -- single-row guard
  cron_enabled boolean NOT NULL DEFAULT false,
  enabled_at   timestamptz,
  enabled_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.makesafe_cron_settings (id, cron_enabled)
VALUES (true, false)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.makesafe_cron_settings ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.makesafe_cron_settings TO service_role;
DROP POLICY IF EXISTS service_role_all ON public.makesafe_cron_settings;
CREATE POLICY service_role_all ON public.makesafe_cron_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Helper the trigger functions call to decide whether to fire.
CREATE OR REPLACE FUNCTION public.makesafe_cron_enabled() RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT cron_enabled FROM public.makesafe_cron_settings WHERE id = true),
    false
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.makesafe_cron_enabled() FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.makesafe_cron_enabled() FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION public.makesafe_cron_enabled() FROM authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.makesafe_cron_enabled() TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.makesafe_cron_enabled() TO postgres';
END $$;

COMMENT ON TABLE public.makesafe_cron_settings IS
  'M4 cron enablement gate. Single-row flag; defaults FALSE. The Phase-1 poll/purge
   and Phase-2 reconcile/canary trigger functions no-op until an owner sets
   cron_enabled = true (Stage C). A plain db push therefore never starts live
   polling or Graph traversal.';

COMMENT ON TABLE public.email_events_raw IS
  'Make-safe email sync: append-only NON-PII audit/replay log. SEPARATE from
   inbox_events; this engine never writes inbox_events. Never purged.';
COMMENT ON TABLE public.emails IS
  'Make-safe email sync: current PII projection, PK on post_id (sole idempotency
   key until internetMessageId confirmed). Subject to 90-day PII tombstone.';
