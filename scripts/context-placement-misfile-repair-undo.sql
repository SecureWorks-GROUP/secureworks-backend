-- Undo for scripts/context-placement-misfile-repair.sql (7 Oct 2026).
--
-- Puts back, on every row the repair touched (metadata.placement_repaired.run =
-- context_placement_misfile_repair_20261007), every column and the whole
-- metadata object exactly as they were before it (saved in
-- metadata.placement_repaired.prior): the job (the placeholder again), the
-- contact, the attribution and match columns, the candidates and the metadata,
-- party roles included. No other column changes, and a row the repair did not
-- touch is left alone.
--
-- The party roles trigger would re-stamp party_roles on this very write, so it
-- is disabled for this transaction only (ALTER TABLE takes a short lock on
-- business_events: captures wait for the commit, none is lost) and enabled
-- again before the transaction ends, as in
-- scripts/context-party-roles-v3-backfill-undo.sql.
--
-- A row someone changed after the repair (a moved row no longer on the job the
-- repair wrote, placement_repaired.to_job_id; a review row placed or re-rested
-- since) is NOT restored over: the undo refuses and names the count, so a later
-- decision is never silently overwritten.
--
-- How to run (production: a write only with the owner's go). As written it
-- ends in ROLLBACK: a dry run. First read the count:
--   BEGIN READ ONLY;
--   SELECT count(*) FROM public.business_events
--    WHERE metadata->'placement_repaired'->>'run' = 'context_placement_misfile_repair_20261007';
--   ROLLBACK;
-- put it in expected_rows below, run this file, then (owner's go) change the
-- final ROLLBACK to COMMIT and run it once.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

CREATE TEMP TABLE mr_undo ON COMMIT DROP AS
SELECT e.id, e.job_id, e.attribution_status, md5(e.payload::text) AS payload_md5, e.metadata
FROM public.business_events e
WHERE e.metadata->'placement_repaired'->>'run' = 'context_placement_misfile_repair_20261007'
FOR UPDATE OF e;

DO $undo$
DECLARE
 -- The number of rows the repair committed (70 if it ran as measured on 7 Oct 2026).
 expected_rows constant integer := 70;
 n integer; restored integer; moved integer; has_trigger boolean;
BEGIN
 SELECT count(*) INTO n FROM mr_undo;
 IF n <> expected_rows THEN
  RAISE EXCEPTION 'placement_misfile_repair undo: % rows carry this run''s stamp, expected %; refusing', n, expected_rows;
 END IF;
 IF EXISTS (SELECT 1 FROM mr_undo u WHERE jsonb_typeof(u.metadata->'placement_repaired'->'prior'->'metadata') IS DISTINCT FROM 'object') THEN
  RAISE EXCEPTION 'placement_misfile_repair undo: a touched row has no saved prior; refusing';
 END IF;
 -- Changed since the repair: a moved row no longer on the job the repair wrote, or a review row placed since.
 SELECT count(*) INTO n FROM mr_undo u
 WHERE CASE u.metadata->'placement_repaired'->>'plan'
  WHEN 'move' THEN u.job_id IS NULL OR u.job_id IS DISTINCT FROM (u.metadata->'placement_repaired'->>'to_job_id')::uuid
  WHEN 'review' THEN u.job_id IS NOT NULL OR u.attribution_status IS DISTINCT FROM 'unplaced'
  ELSE true END;
 IF n <> 0 THEN
  RAISE EXCEPTION 'placement_misfile_repair undo: % rows were re-decided after the repair; refusing to overwrite them', n;
 END IF;
 has_trigger := EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.business_events'::regclass
  AND t.tgname = 'context_party_roles_business_event' AND NOT t.tgisinternal);
 IF has_trigger THEN EXECUTE 'ALTER TABLE public.business_events DISABLE TRIGGER context_party_roles_business_event'; END IF;
 UPDATE public.business_events e SET
  job_id = (u.metadata->'placement_repaired'->'prior'->>'job_id')::uuid,
  contact_id = u.metadata->'placement_repaired'->'prior'->>'contact_id',
  attribution_status = u.metadata->'placement_repaired'->'prior'->>'attribution_status',
  attribution_step = (u.metadata->'placement_repaired'->'prior'->>'attribution_step')::smallint,
  attribution_confidence = (u.metadata->'placement_repaired'->'prior'->>'attribution_confidence')::numeric,
  attributed_at = (u.metadata->'placement_repaired'->'prior'->>'attributed_at')::timestamptz,
  attribution_checked_at = (u.metadata->'placement_repaired'->'prior'->>'attribution_checked_at')::timestamptz,
  match_status = u.metadata->'placement_repaired'->'prior'->>'match_status',
  match_method = u.metadata->'placement_repaired'->'prior'->>'match_method',
  match_confidence = (u.metadata->'placement_repaired'->'prior'->>'match_confidence')::numeric,
  candidate_job_ids = CASE WHEN jsonb_typeof(u.metadata->'placement_repaired'->'prior'->'candidate_job_ids') = 'array'
   THEN ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(u.metadata->'placement_repaired'->'prior'->'candidate_job_ids') x) END,
  metadata = u.metadata->'placement_repaired'->'prior'->'metadata'
 FROM mr_undo u WHERE e.id = u.id;
 GET DIAGNOSTICS restored = ROW_COUNT;
 IF has_trigger THEN EXECUTE 'ALTER TABLE public.business_events ENABLE TRIGGER context_party_roles_business_event'; END IF;
 IF restored <> expected_rows THEN
  RAISE EXCEPTION 'placement_misfile_repair undo: restored % rows, expected %; refusing', restored, expected_rows;
 END IF;
 -- Every row reads as it did before the repair, and its payload never moved.
 SELECT count(*) INTO moved FROM public.business_events e JOIN mr_undo u ON u.id = e.id
 WHERE e.metadata IS DISTINCT FROM u.metadata->'placement_repaired'->'prior'->'metadata'
  OR e.job_id IS DISTINCT FROM (u.metadata->'placement_repaired'->'prior'->>'job_id')::uuid
  OR e.attribution_status IS DISTINCT FROM u.metadata->'placement_repaired'->'prior'->>'attribution_status'
  OR e.match_method IS DISTINCT FROM u.metadata->'placement_repaired'->'prior'->>'match_method'
  OR e.contact_id IS DISTINCT FROM u.metadata->'placement_repaired'->'prior'->>'contact_id'
  OR md5(e.payload::text) IS DISTINCT FROM u.payload_md5;
 IF moved <> 0 THEN RAISE EXCEPTION 'placement_misfile_repair undo: % rows do not read as before the repair; refusing', moved; END IF;
 IF has_trigger AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.business_events'::regclass
   AND t.tgname = 'context_party_roles_business_event' AND t.tgenabled <> 'D') THEN
  RAISE EXCEPTION 'placement_misfile_repair undo: the party-role trigger is not enabled again; refusing';
 END IF;
END $undo$;
SELECT count(*) AS known_misfiles_after_undo FROM public.context_payload_job_mismatch_rows();
ROLLBACK;
