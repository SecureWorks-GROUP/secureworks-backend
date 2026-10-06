-- Undo for scripts/context-party-roles-v3-backfill.sql (6 Oct 2026).
--
-- Puts back, on every row the backfill touched (metadata.party_roles_v3_backfill
-- = context_party_roles_v3_backfill_20261006), the party_roles stamp it carried
-- before (saved in metadata.party_roles_prior_v3), and removes the two backfill
-- keys. No other column or metadata key changes. A row the backfill did not
-- touch is left alone, including a row a writer re-stamped v3 on its own (an
-- update to one of the trigger's columns): it carries no saved stamp, so a v3
-- stamp alone never marks a row this undo can restore.
--
-- The live trigger would re-stamp party_roles on this very write, so it is
-- disabled for this transaction only (ALTER TABLE takes a short lock on
-- business_events: captures wait for the commit, none is lost) and enabled
-- again before the transaction ends. To put the v2 classifier back as well,
-- apply supabase/rollbacks/20261006034000_context_party_roles_health_down.sql
-- (that is separate; this file only restores the stamps).
--
-- How to run (production: a write only with the owner's go). As written it
-- ends in ROLLBACK: a dry run. First read the count:
--   BEGIN READ ONLY;
--   SELECT count(*) FROM public.business_events
--    WHERE metadata ->> 'party_roles_v3_backfill' = 'context_party_roles_v3_backfill_20261006';
--   ROLLBACK;
-- put it in expected_rows below, run this file, then (owner's go) change the
-- final ROLLBACK to COMMIT and run it once.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

CREATE TEMP TABLE pr3_undo_before ON COMMIT DROP AS
SELECT e.id, e.job_id, e.attribution_status, e.contact_id, e.direction, md5(e.payload::text) AS payload_md5, e.metadata
FROM public.business_events e
WHERE e.metadata ->> 'party_roles_v3_backfill' = 'context_party_roles_v3_backfill_20261006'
FOR UPDATE OF e;

DO $undo$
DECLARE
 -- The number of rows the backfill committed (608 if it ran as measured on 6 Oct 2026).
 expected_rows constant integer := 608;
 n integer; restored integer; moved integer; has_trigger boolean;
BEGIN
 SELECT count(*) INTO n FROM pr3_undo_before;
 IF n <> expected_rows THEN
  RAISE EXCEPTION 'party_roles_v3_backfill undo: % rows carry this run''s key, expected %; refusing', n, expected_rows;
 END IF;
 IF EXISTS (SELECT 1 FROM pr3_undo_before WHERE jsonb_typeof(metadata->'party_roles_prior_v3') IS DISTINCT FROM 'object') THEN
  RAISE EXCEPTION 'party_roles_v3_backfill undo: a touched row has no saved stamp; refusing';
 END IF;
 has_trigger:=EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.business_events'::regclass
  AND t.tgname='context_party_roles_business_event' AND NOT t.tgisinternal);
 IF has_trigger THEN EXECUTE 'ALTER TABLE public.business_events DISABLE TRIGGER context_party_roles_business_event'; END IF;
 UPDATE public.business_events e
 SET metadata=(e.metadata-'party_roles'-'party_roles_prior_v3'-'party_roles_v3_backfill')
  ||jsonb_build_object('party_roles',e.metadata->'party_roles_prior_v3')
 FROM pr3_undo_before b WHERE e.id=b.id;
 GET DIAGNOSTICS restored=ROW_COUNT;
 IF has_trigger THEN EXECUTE 'ALTER TABLE public.business_events ENABLE TRIGGER context_party_roles_business_event'; END IF;
 IF restored <> expected_rows THEN
  RAISE EXCEPTION 'party_roles_v3_backfill undo: restored % rows, expected %; refusing', restored, expected_rows;
 END IF;
 -- Every row carries its saved stamp again, and nothing else moved.
 SELECT count(*) INTO moved FROM public.business_events e JOIN pr3_undo_before b ON b.id=e.id
 WHERE e.metadata->'party_roles' IS DISTINCT FROM b.metadata->'party_roles_prior_v3'
  OR e.metadata ? 'party_roles_prior_v3' OR e.metadata ? 'party_roles_v3_backfill'
  OR (e.metadata-'party_roles') IS DISTINCT FROM (b.metadata-'party_roles'-'party_roles_prior_v3'-'party_roles_v3_backfill')
  OR e.job_id IS DISTINCT FROM b.job_id OR e.attribution_status IS DISTINCT FROM b.attribution_status
  OR e.contact_id IS DISTINCT FROM b.contact_id OR e.direction IS DISTINCT FROM b.direction
  OR md5(e.payload::text) IS DISTINCT FROM b.payload_md5;
 IF moved <> 0 THEN RAISE EXCEPTION 'party_roles_v3_backfill undo: % rows do not read as before the backfill; refusing', moved; END IF;
 IF has_trigger AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.business_events'::regclass
   AND t.tgname='context_party_roles_business_event' AND t.tgenabled<>'D') THEN
  RAISE EXCEPTION 'party_roles_v3_backfill undo: the party-role trigger is not enabled again; refusing';
 END IF;
END $undo$;
ROLLBACK;
