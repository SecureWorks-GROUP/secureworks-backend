-- ════════════════════════════════════════════════════════════
-- MAKE-SAFE EMAIL SYNC — atomic backfill commit (BLOCKER fix)
-- Mission: makesafe-live-truth-2026-06-14
-- ════════════════════════════════════════════════════════════
--
-- BLOCKER (Codex review): non-atomic floor/ceiling vs cursor write.
-- runBackfillFull previously wrote recon_inventory_floor / recon_inventory_ceiling
-- to sync_state, THEN committed the live cursor to mail_sync_cursors in a SEPARATE
-- statement. If the cursor write failed AFTER the floor/ceiling write, the system
-- was left with coverage bounds set (claiming ingestion coverage) but the wrong /
-- absent live cursor — a sync gap the verified gate could falsely pass.
--
-- FIX: commit the cursor AND the coverage bounds (+ a backfill_complete marker) in
-- ONE transaction via this SECURITY DEFINER function. The edge function calls it as
-- the FINAL step of the backfill, so on ANY failure NOTHING is set (all-or-nothing).
-- The verified gate additionally now REQUIRES backfill_complete = true (a floor
-- without a completed backfill must NOT verify), so even a partially-written prior
-- state cannot let recon_verified read true over un-ingested history.
--
-- Apply order: this migration runs AFTER 20260614000001 (which creates sync_state +
-- mail_sync_cursors) and 20260614000003 (which adds the recon_inventory_* columns),
-- so the ALTER TABLE below preserves apply order and the columns it references exist.
-- INERT: no cron, no data; the RPC only runs when the edge function calls it.

-- ── 1. backfill_complete marker columns on sync_state ────────────────────────
-- backfill_complete: false until a FULL historical backfill has run to completion
-- and atomically committed via commit_makesafe_backfill(). The verified gate now
-- requires this true (in addition to floor + ceiling): a coverage floor that exists
-- WITHOUT a completed backfill is treated as incomplete -> not verified.
ALTER TABLE public.sync_state
  ADD COLUMN IF NOT EXISTS backfill_complete     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS backfill_completed_at timestamptz;

COMMENT ON COLUMN public.sync_state.backfill_complete IS
  'Make-safe email sync: TRUE only after a full historical backfill committed
   atomically via commit_makesafe_backfill(). The verified gate requires this true
   alongside floor+ceiling — a floor without a completed backfill is NOT verified.';

-- ── 2. commit_makesafe_backfill — ONE-TRANSACTION atomic commit ──────────────
-- Upserts the live cursor (mail_sync_cursors.last_completed_max) AND the coverage
-- bounds + backfill_complete marker (sync_state) in a SINGLE function-body
-- transaction. A function body is one implicit transaction, so either BOTH writes
-- land or NEITHER does (an exception rolls the whole call back). This replaces the
-- two separate edge-function writes that could partially apply.
--
-- Floor: LEAST(existing, p_floor) — coverage only ever widens (never regresses).
-- Ceiling: GREATEST(existing, p_ceiling) — never regress an already-later ceiling.
-- p_cursor is the backfill START instant (text ISO) so the */5 poll's overlapping
-- window re-scans from (start - overlap) with no gap.
CREATE OR REPLACE FUNCTION public.commit_makesafe_backfill(
  p_mailbox  text,
  p_floor    timestamptz,
  p_ceiling  timestamptz,
  p_cursor   text
)
RETURNS jsonb AS $$
DECLARE
  v_overlap integer;
  v_now     timestamptz := now();
  v_floor   timestamptz;
  v_ceiling timestamptz;
BEGIN
  -- Preserve a configured per-mailbox overlap window if one exists (default 900s).
  SELECT overlap_seconds INTO v_overlap
    FROM public.mail_sync_cursors
   WHERE mailbox = p_mailbox;
  v_overlap := COALESCE(v_overlap, 900);

  -- Coverage only widens: floor = MIN(existing, new), ceiling = MAX(existing, new).
  SELECT
    LEAST(s.recon_inventory_floor, p_floor),
    GREATEST(s.recon_inventory_ceiling, p_ceiling)
    INTO v_floor, v_ceiling
    FROM public.sync_state s
   WHERE s.mailbox = p_mailbox;
  -- No prior row -> LEAST/GREATEST returned NULL; fall back to this run's values.
  v_floor   := COALESCE(v_floor, p_floor);
  v_ceiling := COALESCE(v_ceiling, p_ceiling);

  -- (a) coverage bounds + backfill_complete marker.
  INSERT INTO public.sync_state AS s (
    mailbox, recon_inventory_floor, recon_inventory_ceiling,
    backfill_complete, backfill_completed_at, updated_at
  )
  VALUES (
    p_mailbox, v_floor, v_ceiling, true, v_now, v_now
  )
  ON CONFLICT (mailbox) DO UPDATE SET
    -- The conflict-target alias `s` refers to the EXISTING row; widen-only.
    recon_inventory_floor   = LEAST(s.recon_inventory_floor, p_floor),
    recon_inventory_ceiling = GREATEST(s.recon_inventory_ceiling, p_ceiling),
    backfill_complete       = true,
    backfill_completed_at   = v_now,
    updated_at              = v_now;

  -- (b) live cursor — SAME transaction. If this errored after (a), the whole call
  -- rolls back, so coverage+marker are NOT left set without the cursor.
  INSERT INTO public.mail_sync_cursors AS c (
    mailbox, last_completed_max, overlap_seconds, last_full_resync_at, updated_at
  )
  VALUES (
    p_mailbox, p_cursor::timestamptz, v_overlap, v_now, v_now
  )
  ON CONFLICT (mailbox) DO UPDATE SET
    -- The conflict-target alias `c` refers to the EXISTING row.
    last_completed_max  = p_cursor::timestamptz,
    overlap_seconds     = COALESCE(c.overlap_seconds, v_overlap),
    last_full_resync_at = v_now,
    updated_at          = v_now;

  RETURN jsonb_build_object(
    'mailbox', p_mailbox,
    'recon_inventory_floor', v_floor,
    'recon_inventory_ceiling', v_ceiling,
    'committed_cursor', p_cursor,
    'backfill_complete', true,
    'backfill_completed_at', v_now
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   -- Pin search_path so a SECURITY DEFINER function cannot be hijacked by a
   -- caller-set search_path resolving public.* to attacker objects.
   SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.commit_makesafe_backfill(text, timestamptz, timestamptz, text) IS
  'Make-safe email sync: atomic FINAL backfill commit. In ONE transaction upserts
   mail_sync_cursors (live cursor) AND sync_state (floor=LEAST, ceiling=GREATEST,
   backfill_complete=true). All-or-nothing: a failure rolls both back, so a partial
   backfill never leaves coverage bounds set without the matching live cursor.';

-- ── 3. idempotency guard for per-post observation events ─────────────────────
-- MEDIUM (Codex review): a backfill re-run (or an overlapping-window re-poll) hits
-- the SAME post again. The per-post audit rows in email_events_raw (change_type
-- 'created' / 'excluded') previously used a plain INSERT, so a re-run APPENDED a
-- duplicate audit row each time, polluting the replay log and pipeline_items'
-- source_event_ids provenance. The edge function now dedupes (read-then-insert) on
-- (post_id, change_type); this PARTIAL unique index backs that at the DB level so two
-- concurrent re-runs cannot both insert a duplicate. It is SCOPED to the per-post
-- observation change types only — the D2 'inventory_scan' rows (post_id
-- '_D2_INVENTORY_SCAN') are a genuine append-per-run audit and are deliberately
-- EXCLUDED so the inventory scan log keeps appending one row per sweep.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_events_raw_post_change
  ON public.email_events_raw (post_id, change_type)
  WHERE change_type IN ('created', 'excluded');

-- ── 4. lock down the SECURITY DEFINER RPC: service_role only ──────────────────
DO $$
DECLARE fn text := 'public.commit_makesafe_backfill(text, timestamptz, timestamptz, text)';
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC;', fn);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon;', fn);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated;', fn);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role;', fn);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres;', fn);
END $$;
