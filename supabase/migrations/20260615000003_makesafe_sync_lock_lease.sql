-- Make-safe live-truth: replace the per-mailbox concurrency lock with a row-based
-- LEASE (connection-independent), fixing a real leak.
--
-- BUG: try_lock_mailbox_sync used pg_try_advisory_lock (SESSION-level). The edge
-- function acquires it in one RPC and releases it in unlock_mailbox_sync in a finally
-- block — but PostgREST POOLS connections, so the unlock RPC usually runs on a
-- DIFFERENT session than the one holding the lock. pg_advisory_unlock only releases a
-- lock held by the CURRENT session, so it no-ops and the lock LEAKS on the original
-- pooled session until that connection recycles. Effect: most poll/backfill invokes
-- get {skipped:"locked"} and do no work — the */5 live poll would be unreliable and the
-- chunked backfill never converges. (The original migration's comment even flagged the
-- pooling risk; the finally-unlock mitigation is insufficient under transaction pooling.)
--
-- FIX: a lease column on sync_state claimed/released by plain row UPDATEs, which are
-- connection-independent. A TTL makes it self-healing if an invoke crashes. Same RPC
-- names + signatures, so the edge function is UNCHANGED (no redeploy needed).

ALTER TABLE public.sync_state
  ADD COLUMN IF NOT EXISTS sync_lock_until timestamptz;

-- Claim the lease IFF it is free or expired. Atomic via INSERT ... ON CONFLICT with a
-- predicate on the conflict row: concurrent callers serialise on the mailbox PK, and
-- only one observes ROW_COUNT > 0. TTL (600s) comfortably exceeds one invoke's wall
-- clock, so a legitimately-running invoke never loses its lease mid-run; a crashed
-- invoke's lease auto-expires.
CREATE OR REPLACE FUNCTION public.try_lock_mailbox_sync(p_mailbox text)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  affected integer;
BEGIN
  INSERT INTO public.sync_state (mailbox, sync_lock_until, updated_at)
  VALUES (p_mailbox, now() + interval '600 seconds', now())
  ON CONFLICT (mailbox) DO UPDATE
    SET sync_lock_until = excluded.sync_lock_until,
        updated_at = now()
    WHERE public.sync_state.sync_lock_until IS NULL
       OR public.sync_state.sync_lock_until < now();
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END;
$$;

-- Release the lease. A plain UPDATE — works regardless of which pooled connection runs
-- it (the whole point). Idempotent; safe if the lease already expired/was reclaimed.
CREATE OR REPLACE FUNCTION public.unlock_mailbox_sync(p_mailbox text)
RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.sync_state SET sync_lock_until = NULL, updated_at = now()
  WHERE mailbox = p_mailbox;
  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.try_lock_mailbox_sync IS
  'B2 (lease): claim the per-mailbox sync lease if free/expired (sync_state.sync_lock_until). Connection-independent; replaces the leaky session advisory lock. Returns false if another run holds an unexpired lease.';
COMMENT ON FUNCTION public.unlock_mailbox_sync IS
  'B2 (lease): release the per-mailbox sync lease (sync_state.sync_lock_until = NULL). Plain UPDATE so it works across PostgREST pooled connections.';
