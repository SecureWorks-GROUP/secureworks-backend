-- Rollback for 20261020140000_context_reconciliation_decisions.sql.
--
-- Removes the reconciliation decisions store, its placement links, the hold trigger on
-- business_events and the read functions. A recorded decision is a person's work and is kept
-- nowhere else, so this refuses while either table holds a row: export them first, or keep the
-- migration. business_events rows keep any metadata.recon_held stamp the hold wrote; it is
-- history and nothing reads it once this is gone. Re-running it is a no-op.

DO $$
DECLARE n bigint;
BEGIN
  IF to_regclass('public.context_reconciliation_decisions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.context_reconciliation_decisions' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'context_reconciliation_decisions holds % recorded decisions; refusing to drop them', n
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;
  IF to_regclass('public.context_placement_links') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.context_placement_links' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'context_placement_links holds % recorded links; refusing to drop them', n
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;
END $$;

DROP TRIGGER IF EXISTS context_aa_recon_hold_decided ON public.business_events;

DROP FUNCTION IF EXISTS public.context_recon_health(timestamptz);
DROP FUNCTION IF EXISTS public.context_job_view(uuid);
DROP FUNCTION IF EXISTS public.context_job_owed_lines(uuid[]);
DROP FUNCTION IF EXISTS public.context_recon_queue(timestamptz);
DROP FUNCTION IF EXISTS public.context_recon_queue_statuses();
DROP FUNCTION IF EXISTS public.context_recon_hold_decided();
DROP FUNCTION IF EXISTS public.context_event_jobs(uuid);
DROP FUNCTION IF EXISTS public.context_recon_placement(uuid);
DROP FUNCTION IF EXISTS public.context_recon_record_decision(uuid, text, text, uuid[], text, uuid, text);
DROP FUNCTION IF EXISTS public.context_recon_decision_state(uuid);
DROP FUNCTION IF EXISTS public.context_recon_evidence_hash(uuid);
DROP FUNCTION IF EXISTS public.context_recon_evidence_hash_of(text, text, timestamptz, text, jsonb);

DROP TABLE IF EXISTS public.context_placement_links;
DROP TABLE IF EXISTS public.context_reconciliation_decisions;

DROP FUNCTION IF EXISTS public.context_recon_evidence_keys();
DROP FUNCTION IF EXISTS public.context_recon_append_only();
