-- Keep any prepared generations and their audit trail. Stop an adopted consumer
-- before rollback; no source notes, settings or live generation are rewritten.
DROP FUNCTION IF EXISTS public.context_ledger_rebuild_packet(uuid,uuid);
