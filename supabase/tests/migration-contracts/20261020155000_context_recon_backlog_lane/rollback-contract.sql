-- After the down migration: the settings and live_from are gone, and the queue and health are the
-- 20261020140000 shape again (no lane).
\set ON_ERROR_STOP 1
DO $$
BEGIN
  IF to_regclass('public.context_recon_settings') IS NOT NULL OR to_regprocedure('public.context_recon_live_from()') IS NOT NULL THEN
    RAISE EXCEPTION 'recon lane rollback: lane objects remain';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.context_recon_queue(timestamptz)'::regprocedure
             AND 'lane' = ANY (proargnames)) THEN
    RAISE EXCEPTION 'recon lane rollback: queue still has a lane';
  END IF;
  IF public.context_recon_health('2026-01-01') ? 'queue_by_lane' THEN
    RAISE EXCEPTION 'recon lane rollback: health still counts lanes';
  END IF;
  PERFORM count(*) FROM public.context_recon_queue();
END $$;
