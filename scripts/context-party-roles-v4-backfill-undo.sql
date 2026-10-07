-- Undo for scripts/context-party-roles-v4-backfill.sql (7 Oct 2026).
--
-- Puts back, on every row the backfill touched (metadata.party_roles_v4_backfill
-- = context_party_roles_v4_backfill_20261007), the party_roles stamp it carried
-- before the backfill first touched it (saved in metadata.party_roles_prior_v4;
-- a row that had no stamp gets none), and removes the two backfill keys. No
-- other column or metadata key changes. A row the backfill did not touch is
-- left alone, including a row a writer re-stamped v4 on its own (an update to
-- one of the trigger's columns): it carries no saved stamp, so a v4 stamp
-- alone never marks a row this undo can restore. The keys of the earlier v2
-- backfill (party_roles_prior, party_roles_v2_backfill) are left as they are.
--
-- The live trigger would re-stamp party_roles on this very write, so it is
-- disabled for this transaction only (ALTER TABLE takes a short lock on
-- business_events: captures wait for the commit, none is lost) and enabled
-- again before the transaction ends. While v4 stays live, a writer's later
-- update to a restored row stamps it v4 again, as it does any row. To put
-- the v3 classifier back as well, apply
-- supabase/rollbacks/20261007060000_context_party_roles_v4_down.sql first
-- (that is separate; this file only restores the stamps).
--
-- How to run (production: a write only with the owner's go). As written it
-- ends in ROLLBACK: a dry run. First read the count:
--   BEGIN READ ONLY;
--   SELECT count(*) FROM public.business_events
--    WHERE metadata ->> 'party_roles_v4_backfill' = 'context_party_roles_v4_backfill_20261007';
--   ROLLBACK;
-- put it in expected_rows below (it is the sum of the batches the backfill
-- committed), run this file, then (owner's go) change the final ROLLBACK to
-- COMMIT and run it once.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

CREATE TEMP TABLE pr4_undo_before ON COMMIT DROP AS
SELECT e.id, e.job_id, e.attribution_status, e.contact_id, e.direction, e.channel, e.event_type, md5(e.payload::text) AS payload_md5, e.metadata
FROM public.business_events e
WHERE e.metadata ->> 'party_roles_v4_backfill' = 'context_party_roles_v4_backfill_20261007'
FOR UPDATE OF e;

DO $undo$
DECLARE
 -- The number of rows carrying this run's key (the read above). -1 refuses
 -- until it is filled in.
 expected_rows constant integer := -1;
 n integer; restored integer; moved integer; has_trigger boolean;
BEGIN
 SELECT count(*) INTO n FROM pr4_undo_before;
 IF n <> expected_rows THEN
  RAISE EXCEPTION 'party_roles_v4_backfill undo: % rows carry this run''s key, expected %; refusing', n, expected_rows;
 END IF;
 -- Every touched row saved its first stamp: an object, or JSON null for a
 -- row that had none.
 IF EXISTS (SELECT 1 FROM pr4_undo_before
   WHERE NOT (metadata ? 'party_roles_prior_v4') OR jsonb_typeof(metadata->'party_roles_prior_v4') NOT IN ('object','null')) THEN
  RAISE EXCEPTION 'party_roles_v4_backfill undo: a touched row has no saved stamp; refusing';
 END IF;
 has_trigger:=EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.business_events'::regclass
  AND t.tgname='context_party_roles_business_event' AND NOT t.tgisinternal);
 IF has_trigger THEN EXECUTE 'ALTER TABLE public.business_events DISABLE TRIGGER context_party_roles_business_event'; END IF;
 UPDATE public.business_events e
 SET metadata=(e.metadata-'party_roles'-'party_roles_prior_v4'-'party_roles_v4_backfill')
  ||CASE WHEN jsonb_typeof(e.metadata->'party_roles_prior_v4')='object'
    THEN jsonb_build_object('party_roles',e.metadata->'party_roles_prior_v4') ELSE '{}'::jsonb END
 FROM pr4_undo_before b WHERE e.id=b.id;
 GET DIAGNOSTICS restored=ROW_COUNT;
 IF has_trigger THEN EXECUTE 'ALTER TABLE public.business_events ENABLE TRIGGER context_party_roles_business_event'; END IF;
 IF restored <> expected_rows THEN
  RAISE EXCEPTION 'party_roles_v4_backfill undo: restored % rows, expected %; refusing', restored, expected_rows;
 END IF;
 -- Every row carries its saved stamp again (or none), and nothing else moved.
 SELECT count(*) INTO moved FROM public.business_events e JOIN pr4_undo_before b ON b.id=e.id
 WHERE e.metadata->'party_roles' IS DISTINCT FROM
   CASE WHEN jsonb_typeof(b.metadata->'party_roles_prior_v4')='object' THEN b.metadata->'party_roles_prior_v4' END
  OR e.metadata ? 'party_roles_prior_v4' OR e.metadata ? 'party_roles_v4_backfill'
  OR (e.metadata-'party_roles') IS DISTINCT FROM (b.metadata-'party_roles'-'party_roles_prior_v4'-'party_roles_v4_backfill')
  OR e.job_id IS DISTINCT FROM b.job_id OR e.attribution_status IS DISTINCT FROM b.attribution_status
  OR e.contact_id IS DISTINCT FROM b.contact_id OR e.direction IS DISTINCT FROM b.direction
  OR e.channel IS DISTINCT FROM b.channel OR e.event_type IS DISTINCT FROM b.event_type
  OR md5(e.payload::text) IS DISTINCT FROM b.payload_md5;
 IF moved <> 0 THEN RAISE EXCEPTION 'party_roles_v4_backfill undo: % rows do not read as before the backfill; refusing', moved; END IF;
 IF has_trigger AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.business_events'::regclass
   AND t.tgname='context_party_roles_business_event' AND t.tgenabled<>'D') THEN
  RAISE EXCEPTION 'party_roles_v4_backfill undo: the party-role trigger is not enabled again; refusing';
 END IF;
END $undo$;

-- What was put back, by version and basis (the count matches expected_rows).
SELECT coalesce(e.metadata->'party_roles'->>'version','(no stamp)') AS version, e.metadata->'party_roles'->>'basis' AS basis, count(*) AS rows
FROM public.business_events e JOIN pr4_undo_before b ON b.id=e.id
GROUP BY 1,2 ORDER BY coalesce(e.metadata->'party_roles'->>'version','(no stamp)') COLLATE "C", count(*) DESC,
 (e.metadata->'party_roles'->>'basis') COLLATE "C";
ROLLBACK;
