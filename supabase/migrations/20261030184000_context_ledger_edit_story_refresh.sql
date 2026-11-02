-- TP-16: changes within the current ledger generation also make a story due.
-- Existing rewrite floor, failure backoff, cap, monitoring, deduplication and access remain.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $patch$ DECLARE f text; h text; BEGIN
 SELECT pg_get_functiondef(oid),md5(prosrc) INTO f,h FROM pg_proc WHERE oid=to_regprocedure('public.context_job_story_enqueue_changed(integer)');
 IF h='143a88acac3b0fd0e894f127eebed188' THEN RETURN; END IF;
 IF h IS DISTINCT FROM 'f4c040642a58cf9e5c281c76d94abecb' THEN RAISE EXCEPTION 'ledger_edit_story_preimage_mismatch'; END IF;
 EXECUTE replace(f,$before$OR date_trunc('milliseconds', lg.evidence_until) IS DISTINCT FROM date_trunc('milliseconds', t.evidence_until)$before$,$after$OR date_trunc('milliseconds', lg.evidence_until) IS DISTINCT FROM date_trunc('milliseconds', t.evidence_until)
         OR EXISTS (SELECT 1 FROM public.context_ledger_items li
                    WHERE li.job_id = t.job_id AND li.generation_id = lg.generation_id
                      AND greatest(li.created_at, li.updated_at) > t.checked_at)$after$);
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_enqueue_changed(integer)'::regprocedure) IS DISTINCT FROM '143a88acac3b0fd0e894f127eebed188' THEN RAISE EXCEPTION 'ledger_edit_story_postimage_mismatch'; END IF;
END $patch$;
