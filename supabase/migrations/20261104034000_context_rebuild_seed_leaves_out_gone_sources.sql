-- (finish line C3, 3 Nov 2026) A notes rebuild is no longer refused for ever because a note it carries
-- cites a source that is gone.
--
-- context_ledger_rebuild_packet seeds the rebuild with the current reading's open, disputed and info
-- items, then checks every carried item's opening citations and raises
-- context_rebuild_prior_source_unresolved when one no longer resolves (context_ledger_cite and
-- context_ledger_held_cite both refuse it). That refusal is permanent while the source stays gone, so
-- the job fails every retry and its backoff grows to 7 days. Production, 3 Nov 2026 (Postgres log
-- 03:02:59-03:05:05Z, re-read 09:12Z, still refused):
--   SWF-261526, SWF-261608, SWP-261210, SWP-261382: notes citing job_assignments rows since deleted
--     (a booking moved), citation_missing;
--   SWP-26991: a claim citing an inbox_events mail no longer admissible on the job.
-- Each failed twice with no model call and sat in backoff (SWF-261608 on its third count, to 16:00Z).
--
-- Change: in the first seed, an item (not person-locked) whose opening source no longer resolves is
-- left out and named in checks.rebuild_seed.left_out (item_key, item_type, status, the cite code, the
-- source table). The reading then reads the job's whole history and writes again what still stands on
-- the evidence that remains. A person-locked item is carried as before. The check after the seed is
-- unchanged, so a retry over an existing seed still refuses a source that moved since that seed.
-- Everything else is byte for byte the live definition.
-- Guard: the live function must be the definition this was written against (md5 24a30037...).
-- Rollback: supabase/rollbacks/20261104034000_context_rebuild_seed_leaves_out_gone_sources_down.sql.
SET LOCAL lock_timeout = '5s';

DO $mig$
DECLARE
  v_def text;
  v_old0 text := $o$ packet jsonb; items jsonb; seed_count integer := 0;$o$;
  v_new0 text := $n$ packet jsonb; items jsonb; seed_count integer := 0; left_out jsonb := '[]'::jsonb; v_gone jsonb;$n$;
  v_old1 text := $o$   ORDER BY opened_at, item_key COLLATE "C" FOR SHARE LOOP
   INSERT INTO public.context_ledger_items$o$;
  v_new1 text := $n$   ORDER BY opened_at, item_key COLLATE "C" FOR SHARE LOOP
   -- (20261104034000) an item whose opening source no longer resolves (its booking row deleted, its mail
   -- moved off the job) is left out of the seed and named in rebuild_seed.left_out, not carried to refuse
   -- the rebuild below for ever. The whole-history reading writes it again from what remains. A person's
   -- own item is always carried.
   v_gone := NULL;
   IF NOT s.person_locked THEN
    FOR c IN SELECT value FROM jsonb_array_elements(s.opened_by) LOOP
     chk := public.context_ledger_cite(r.job_id, c);
     IF NOT coalesce((chk ->> 'ok')::boolean, false)
        AND NOT coalesce((public.context_ledger_held_cite(r.job_id, c) ->> 'ok')::boolean, false) THEN
      v_gone := jsonb_build_object('item_key', s.item_key, 'item_type', s.item_type, 'status', s.status,
       'code', chk ->> 'code', 'table', c ->> 'table');
      EXIT;
     END IF;
    END LOOP;
   END IF;
   IF v_gone IS NOT NULL THEN
    left_out := left_out || jsonb_build_array(v_gone);
    CONTINUE;
   END IF;
   INSERT INTO public.context_ledger_items$n$;
  v_old2 text := $o$   jsonb_build_object('source_generation_id',prior,'items',seed_count,'captured_at',now())), updated_at = now()$o$;
  v_new2 text := $n$   jsonb_build_object('source_generation_id',prior,'items',seed_count,'captured_at',now(),
    'left_out',left_out)), updated_at = now()$n$;
BEGIN
  SELECT pg_get_functiondef('public.context_ledger_rebuild_packet(uuid,uuid)'::regprocedure) INTO v_def;
  IF md5(v_def) = 'e92f16f62fc0c7517aed5df36fcbe316' THEN
    RAISE NOTICE 'context_ledger_rebuild_packet already carries 20261104034000';
    RETURN;
  END IF;
  IF md5(v_def) <> '24a300377b1e4f4c01f36fda9b2099c8' THEN
    RAISE EXCEPTION 'context_ledger_rebuild_packet is not the definition this migration was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old0, ''))) / length(v_old0) <> 1 THEN
    RAISE EXCEPTION 'context_ledger_rebuild_packet: change 1 does not match exactly once';
  END IF;
  v_def := replace(v_def, v_old0, v_new0);
  IF (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1) <> 1 THEN
    RAISE EXCEPTION 'context_ledger_rebuild_packet: change 2 does not match exactly once';
  END IF;
  v_def := replace(v_def, v_old1, v_new1);
  IF (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2) <> 1 THEN
    RAISE EXCEPTION 'context_ledger_rebuild_packet: change 3 does not match exactly once';
  END IF;
  v_def := replace(v_def, v_old2, v_new2);
  EXECUTE v_def;
  SELECT pg_get_functiondef('public.context_ledger_rebuild_packet(uuid,uuid)'::regprocedure) INTO v_def;
  IF md5(v_def) <> 'e92f16f62fc0c7517aed5df36fcbe316' THEN
    RAISE EXCEPTION 'context_ledger_rebuild_packet after the change is not the rehearsed definition (md5 %)', md5(v_def);
  END IF;
END
$mig$;

COMMENT ON FUNCTION public.context_ledger_rebuild_packet(uuid,uuid) IS
 'TP-16 (20261030150000), 20261104034000: leased rebuild preparation, preserving unresolved item identities and closure predicates before reading. Idempotent seed, same-generation packet, source-invalid refusal, no live note or settings edits. Additive/dormant until a separately accepted reader calls it. A seed is not verification or closure. A carried item whose opening source no longer resolves (cite and held cite both refuse it) is left out of the first seed and named in checks.rebuild_seed.left_out (item_key, item_type, status, code, table); a person-locked item is always carried. A retry over an existing seed still refuses a source that moved since.';
